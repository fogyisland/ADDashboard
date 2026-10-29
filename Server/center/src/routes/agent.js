import { Router } from 'express';
import { agentToken } from '../auth/agent-token.js';
import { upsertStatus, insertHistoryEntries } from '../services/replication.js';
import { getConfig, getAgentConfig } from '../services/config.js';
import { upsertDiscoveredDc } from '../services/discovery.js';
import { listPorts } from '../services/ports.js';
import { upsertPortStatuses } from '../services/port-status.js';
// 2026-08-28 round-45: getReplicationPortList import removed —
// /api/agent/partner-ports endpoint deleted (R35 port monitoring surface
// dropped). service/replication-port-config.js is also deleted in T8 —
// dashboard.js no longer imports it after T3 strips port fields.
import { getDb } from '../db/index.js';
import { toMysqlDatetime } from '../utils/datetime.js';
import { getAgentTokenState } from '../services/agent-token.js';
// 2026-10-01 R158.13 — parallel to getAgentTokenState above. Reads the
// two-row bundle from system_config (agent_settings + agent_settings_version)
// and returns { settings, version } for the heartbeat delivery path.
import { getAgentSettingsState } from '../services/client-settings.js';
import { writeAudit } from '../services/audit.js';
// R158.X.99-quota (2026-10-21) — 超额 agent 数据准入判定 (fail-open).
import { checkAgentAdmission } from '../services/license-quota-guard.js';
// 2026-09-27 R121 — surface /api/agent/packages* on the REPORT port (8082).
// DC agent's PackageManager hits `http://center:8082/api/agent/packages`
// (cachedPorts.reportPort, see agent.js:425 + R93.3), but the legacy
// registration only lived on webApp (8080) via packageRunner. Without
// mirroring the same handlers on reportApp, DC agents receive
// "Cannot GET /api/agent/packages" + 404 + agent log
// "package sync failed status=404". We import the SAME handler functions
// from runner.js (no SQL / bakeManifest / ETL duplication) and register
// them against /api/agent/packages* here, gated by mount='report' so the
// web mount (which goes through packageRunner) and the report mount
// (which goes through these imports) never collide — the auth middleware
// is the same agentMw instance, so S82 identity binding still applies on
// both ports.
import {
  listEnabledPackages,
  getPackageScript,
  postPackageReport,
  registerPackageRoutes
} from '../packages/runner.js';
// R158.48 (2026-10-06) — agent auto-update. GET /api/agent/upgrade + heartbeat
// envelope fields (upgradeAvailable, upgradeVersion). Module-level cache populated
// at server.js boot from src/services/agent-upgrade-source.js.
import { registerAgentUpgradeRoutes, computeUpgradeEnvelope } from './agent-upgrade.js';

// R154.5 — module-level so all three mounts (heartbeat 8081, web 8080,
// report 8082) can register against the SAME handler. Previously this
// lived inside `if (mount === 'heartbeat' || mount === 'full')` and the
// web/report mounts crashed at boot with "inboundPartnersHandler is not
// defined" because closure scope did not cross the if-block.
function makeInboundPartnersHandler({ logger }) {
  return async function inboundPartnersHandler(req, res) {
    try {
      const db = getDb();
      const agentId = req.headers['x-agent-id'] || req.body?.agentId || null;
      if (!agentId) return res.status(400).json({ error: 'missing agent id' });
      const sql = db.sql.replication.inboundPartnersByAgent(agentId);
      // S13 (2026-09-30) — wrap db.execute in Promise.race with a 5 s ceiling.
      // This handler accounts for ~695 of the 1537 'operation timed out'
      // errors in the 8-hour centre log. Even after mssql connectionTimeout
      // is trimmed to 5 s (S9) the request can still hang on the agentMw
      // middleware's _loadAgentTokenBundle query, which has no timeout at
      // all. Racing every DB call with a 5 s ceiling guarantees the handler
      // rejects within an agent heartbeat window (~5 s) so the closure
      // doesn't accumulate on the event loop. Heartbeat cadence is 5 s,
      // so a 5 s ceiling matches the agent's natural retry budget.
      //
      // S13.1 (2026-09-30) — clearTimeout on success. Without it, every
      // request creates a 5 s timer that fires even when the query resolves
      // in 50 ms — the timers pile up faster than they fire, leaking V8
      // timer-queue memory at ~36 timers/s (heartbeat fan-out). This was
      // the dominant OOM contributor once the SQL fix was in place: heap
      // was climbing from 482 MB to 4 GB in 1.6 min after restart, NOT
      // from DB round-trips (which now succeed in <100 ms) but from the
      // 5 s Promise.race timers we added as the cure.
      let timeoutHandle;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('inbound-partners acquire timeout')), 5_000);
      });
      try {
        const queryPromise = db.execute(sql, [agentId]);
        const { rows } = await Promise.race([queryPromise, timeoutPromise]);
        clearTimeout(timeoutHandle);
        // Deduplicate by source_dc — multiple naming_contexts per (src, dest)
        // pair (CN=Configuration, CN=Schema, DC=domain). The probe runs
        // once per peer DC.
        const seen = new Set();
        const peers = [];
        for (const r of rows) {
          if (seen.has(r.source_dc)) continue;
          seen.add(r.source_dc);
          peers.push({ peerDc: r.source_dc });
        }
        res.json({ peers });
      } catch (e) {
        clearTimeout(timeoutHandle);
        throw e;
      }
    } catch (e) {
      logger.error({ err: e }, 'agent inbound-partners fetch failed');
      res.status(500).json({ error: 'internal' });
    }
  };
}

// R158.15 (2026-10-01) -- warehouse mirror of makeInboundPartnersHandler.
// Reads from ad_dc_inbound_partners (R155.6 5-min centre refresh), NOT
// from ad_replication_status 30-min probe. Used by
// ad_replication_status_probe 1.0.0 collect.ps1 to fetch the partner
// list before enumerating per-NC probe rows. Same 3-mount singleton
// pattern as makeInboundPartnersHandler (R154.5 lesson).
// ad_dc_inbound_partners.peer_dc is the partner for this local DC.
// Dedupe by peer_dc (one partner in N naming_contexts -> 1 row).
function makeInboundPartnersWarehouseHandler({ logger }) {
  return async function inboundPartnersWarehouseHandler(req, res) {
    try {
      const db = getDb();
      const agentId = req.headers['x-agent-id'] || req.body?.agentId || null;
      if (!agentId) return res.status(400).json({ error: 'missing agent id' });
      // S13 (2026-09-30) -- wrap db.execute in Promise.race with 5s ceiling.
      // Same rationale as makeInboundPartnersHandler (avoids timer-queue
      // leak + heartbeat fan-out pile-up on the event loop).
      let timeoutHandle;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('inbound-partners-warehouse acquire timeout')), 5_000);
      });
      try {
        const sql = db.sql.replication.inboundPartnersWarehouseByAgent(agentId);
        const queryPromise = db.execute(sql, [agentId]);
        const { rows } = await Promise.race([queryPromise, timeoutPromise]);
        clearTimeout(timeoutHandle);
        const seen = new Set();
        const peers = [];
        for (const r of rows) {
          if (seen.has(r.peer_dc)) continue;
          seen.add(r.peer_dc);
          peers.push({ peerDc: r.peer_dc });
        }
        res.json({ peers });
      } catch (e) {
        clearTimeout(timeoutHandle);
        throw e;
      }
    } catch (e) {
      logger.error({ err: e }, 'agent inbound-partners-warehouse fetch failed');
      res.status(500).json({ error: 'internal' });
    }
  };
}

// R155.4 — outbound mirror of makeInboundPartnersHandler. Source_dc =
// self anchor returns the peer DCs that THIS agent is supposed to
// TCP-probe OUT to. ad_dc_probe_outbound 1.0.0 collect.ps1 hits this
// endpoint before iterating its TcpClient probe. Same 30-min freshness
// window + synthetic-row exclusions as the inbound sibling — the
// __partner_ports__:% exclusion is the echo-loop guard (without it,
// this endpoint would feed the agent its own previous-cycle probe
// rows as new peers and the probe would recurse outward).
// Deduplicates by dest_dc (multiple naming_contexts per pair).
// 3-mount singleton pattern mirrors R154.5 — declared at module level
// so all three mounts (heartbeat 8081, web 8080, report 8082) can
// register against the SAME handler.
function makeOutboundPartnersHandler({ logger }) {
  return async function outboundPartnersHandler(req, res) {
    try {
      const db = getDb();
      const agentId = req.headers['x-agent-id'] || req.body?.agentId || null;
      if (!agentId) return res.status(400).json({ error: 'missing agent id' });
      const sql = db.sql.replication.outboundPartnersByAgent(agentId);
      // S13 (2026-09-30) — wrap db.execute in Promise.race with 5 s ceiling.
      // This handler accounts for ~708 of the 1537 'operation timed out'
      // errors in the 8-hour centre log. Same rationale as
      // makeInboundPartnersHandler above — racing with a 5 s ceiling
      // ensures rejection within an agent heartbeat window so the closure
      // doesn't pile up on the event loop.
      //
      // S13.1 (2026-09-30) — clearTimeout on success. Same as the inbound
      // sibling — without it the timer-queue leaks V8 memory at ~36/s
      // (heartbeat fan-out) and the heap climbs from 482 MB to 4 GB in
      // ~1.6 min. clearTimeout on both success and error paths frees the
      // pending timer once Promise.race resolves.
      let timeoutHandle;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('outbound-partners acquire timeout')), 5_000);
      });
      try {
        const queryPromise = db.execute(sql, [agentId]);
        const { rows } = await Promise.race([queryPromise, timeoutPromise]);
        clearTimeout(timeoutHandle);
        const seen = new Set();
        const peers = [];
        for (const r of rows) {
          if (seen.has(r.dest_dc)) continue;
          seen.add(r.dest_dc);
          peers.push({ peerDc: r.dest_dc });
        }
        res.json({ peers });
      } catch (e) {
        clearTimeout(timeoutHandle);
        throw e;
      }
    } catch (e) {
      logger.error({ err: e }, 'agent outbound-partners fetch failed');
      res.status(500).json({ error: 'internal' });
    }
  };
}

export function agentRouter({ config, logger, mount = 'full' }) {
  const inboundPartnersHandler = makeInboundPartnersHandler({ logger });
  // R155.4 — outbound-partners singleton (mirror of inbound singleton
  // above). Same 3-mount scope; the handler is registered against the
  // heartbeat (8081), web (8080) and report (8082) mounts below.
  const outboundPartnersHandler = makeOutboundPartnersHandler({ logger });
  // R158.15 — inbound-partners-warehouse singleton (mirror of
  // inbound-partners above). Same 3-mount scope.
  const inboundPartnersWarehouseHandler = makeInboundPartnersWarehouseHandler({ logger });
  const r = Router();
  // I3: agentToken now resolves the bundle at request time via the db
  // facade (so a rotate+commit takes effect on the very next request).
  // Passing the old `config.agentToken` string would silently 503 every
  // request — Task 1 introduced this signature and Task 5 propagates it
  // to every caller. The handler body uses `getDb()` lazily so this
  // middleware is wired once at mount time. `logger` is threaded in so a
  // previous-token match emits the spec §5 warn.
  const agentMw = agentToken({ db: getDb(), logger });

  if (mount === 'heartbeat' || mount === 'full') {
    r.get('/api/agent/ports', agentMw, async (_req, res) => {
      try {
        const rows = await listPorts();
        res.json(rows);
      } catch (e) {
        logger.error({ err: e }, 'agent ports fetch failed');
        res.status(500).json({ error: 'internal' });
      }
    });

    // 2026-08-28 round-46: partner-ports endpoint restored (was deleted in
    // round-45). Real agent + mock now read the configured port list from
    // /api/agent/partner-ports and probe each replication partner over
    // TCP, emitting __partner_ports__:% rows with JSON partner_port_status.
    // The 复制日志监控 view surfaces this alongside inbound replication
    // history per the R46 directive ("监控入站信息,同时监控设定端口健康").
    r.get('/api/agent/partner-ports', agentMw, async (_req, res) => {
      try {
        const rows = await listPorts();
        res.json({ ports: rows });
      } catch (e) {
        logger.error({ err: e }, 'agent partner-ports fetch failed');
        res.status(500).json({ error: 'internal' });
      }
    });

    // 2026-09-29 R151.2 — inbound-partners endpoint. Replaces R125's
    // /api/agent/replication-partners (which was OUTBOUND: source_dc = self)
    // with the INBOUND mirror (dest_dc = self). This is the centre-computed
    // partner list that the new ad_partner_ports_probe 1.0.3 collect.ps1
    // reads before doing its TcpClient probe. The agent no longer shells
    // out to Get-ADReplicationPartnerMetadata (that cmdlet's default
    // -Scope Server only sees local-site links and returns 0 rows on
    // 28/34 of our agents — see R151 root-cause analysis).
    //
    // The endpoint takes the agent's own identifier in X-Agent-Id (same
    // header convention as the deleted endpoint) and returns the list of
    // peer DCs that have replicated TO this agent in the last 30 minutes,
    // deduplicated by source_dc. The agent then TCP-probes each peer's
    // AD/Replication/Kerberos ports and emits __partner_ports__:% rows
    // with JSON partner_port_status — which is what
    // /api/dashboard/partner-port-health/all surfaces in the UI.
    //
    // R154.5 (port-mismatch fix) — also mounted on 'web' (8080) + 'report'
    // (8082). The DC agent bundle passes its appsettings centerUrl (default
    // 8080 = web port) to PackageManager, so spoke agents whose appsettings
    // points at 8080 hit a 404 today. Mirroring the handler onto web+report
    // means the agent can call any of the three ports and still get the
    // same peer list — no agent bundle rebuild required.
    r.get('/api/agent/inbound-partners', agentMw, inboundPartnersHandler);

    // R155.4 — outbound mirror of the inbound-partners endpoint.
    // ad_dc_probe_outbound 1.0.0 collect.ps1 calls this on its
    // /api/agent/<mount>/outbound-partners URL to fetch the peer list
    // it should probe OUT to. Mounted on heartbeat (8081) because
    // that's the high-frequency probe control port, and the inbound
    // sibling is also there. See the R154.5 root-cause comment above
    // for why all three mounts are needed.
    r.get('/api/agent/outbound-partners', agentMw, outboundPartnersHandler);

    // R158.15 — inbound-partners-warehouse mirror. Used by
    // ad_replication_status_probe 1.0.0 collect.ps1 to fetch the
    // partner list from ad_dc_inbound_partners (R155.6 5-min refresh).
    // Same R154.5 port-mismatch rationale as inbound-partners.
    r.get('/api/agent/inbound-partners-warehouse', agentMw, inboundPartnersWarehouseHandler);

    r.post('/api/agent/heartbeat', agentMw, async (req, res) => {
      // R158.88.C (2026-10-13) — destructure health_score (12th col, INT NULL).
      //   0 改 agent 端, 等 fleet 升 0.1.7+ 才报. pre-R158.88.C agent
      //   bind undefined → NULL → ISNULL/COALESCE preserve 老 row.
      const { agentId, agentVersion, pendingQueueSize, lastReportAt, lastReportStatus, ports, agentType, hostname, agent_token_version, report_requested_at, client_settings_version, heartbeat_interval_seconds, last_upgrade_event, health_score } = req.body || {};
      if (!agentId) return res.status(400).json({ error: 'missing agentId' });
      // 2026-10-02 R158.28 — per-agent heartbeat tiering. The agent now reports
      // its own actual heartbeat interval (1-3600s) so the centre can compute
      // the admin monitor's status bands relative to that interval. NULL when
      // absent so pre-R158.28 agents still parse cleanly — the service falls
      // back to system_config.heartbeat_interval_seconds when the column is
      // NULL. Clamp + range-check mirrors the agent-side validateSettingsPatch
      // guard at services/client-settings.js:76 (1-3600); values outside that
      // range are coerced to NULL so a misconfigured agent can't poison the
      // admin view.
      //
      // Note: declared BEFORE the entry log so the log line below can read it
      // without hitting a TDZ ReferenceError (R158.28 first deploy had this
      // bound after logger.info and crashed every heartbeat handler).
      const reportedHeartbeatIntervalSeconds = (() => {
        const raw = heartbeat_interval_seconds;
        if (raw == null) return null;
        const n = Number(raw);
        if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
        if (n < 1 || n > 3600) return null;
        return n;
      })();
      // 2026-08-25 round-12 observability: log every agent request on entry
      // with the data shape the operator needs to verify validity. The
      // `source` field is stamped by the agent (see agent/src/reporter.js
      // postHeartbeat) so the log line shows which collector emitted the
      // heartbeat — old agents that don't stamp source are logged as
      // 'unknown' for backward compat.
      logger.info({
        event: 'agent.heartbeat',
        source: req.body?.source ?? 'unknown',
        agentId,
        agentVersion,
        agentType: agentType ?? 'ad',
        hostname,
        portsCount: Array.isArray(ports) ? ports.length : 0,
        pendingQueueSize,
        lastReportStatus,
        agentTokenVersion: Number(agent_token_version) || 0,
        clientSettingsVersion: Number(client_settings_version) || 0,
        heartbeatIntervalSeconds: reportedHeartbeatIntervalSeconds,
        reportRequestedAt: report_requested_at ?? null
      }, 'agent heartbeat received');
      // 2026-08-21 UX redesign (auto-delivery): the heartbeat is now the
      // carrier for the agent's last-seen agent_token_version. Default 0
      // for pre-feature agents (their version matches the server's
      // initial version, so no delivery happens until a rotation bumps
      // the server side).
      const reportedTokenVersion = Number(agent_token_version) || 0;
      // 2026-10-01 R158.13 — parallel to reportedTokenVersion above.
      // Default 0 for pre-R158.13 agents (their version matches the
      // server's initial version, so no delivery happens until a bump
      // occurs). Persisted to ad_agent_heartbeat.client_settings_version
      // for the admin push counter (see clientSettingsList).
      const reportedClientSettingsVersion = Number(client_settings_version) || 0;
      // round-12 T6 + T-fix: 3-way semantic for report_requested_at.
      //   undefined → older agent / absent field → preserve via UPSERT (COALESCE keeps column)
      //   null      → round-12 agent cleared the flag → call clearReportRequest UPDATE
      //   string    → round-12 agent providing a new value → UPSERT sets the column
      // T6 originally collapsed undefined and null to the same `null` value
      // and routed both through the UPSERT, but COALESCE / ISNULL in the
      // upsert SQL guarantees `null` preserves the column — so the
      // "explicit clear" semantic was silently broken. T-fix splits the
      // value into two sentinels: `undefined` keeps the preserve path, an
      // explicit `null` triggers `clearReportRequest` so the column is
      // actually wiped. Older agents (which never send the field) are
      // unaffected — they still get the preserve path.
      const reportRequestedAtRaw = report_requested_at;
      const reportRequestedAtIsExplicitNull = reportRequestedAtRaw === null;
      const reportRequestedAt = (reportRequestedAtIsExplicitNull || reportRequestedAtRaw === undefined)
        ? null
        : new Date(reportRequestedAtRaw);
      try {
        const db = getDb();

        // R158.87.7 (2026-10-12) — 拆 AD vs non-ad 双分支.
        //   member-server (agentType='non-ad' && hostname) 整段绕开
        //   ad_agent_heartbeat 路径 (coldStart detection /
        //   readLastHeartbeatAt / clearReportRequest / upsert /
        //   requestReport / hasAnyReplicationRows / readReportRequestedAt),
        //   直接走 ad_member_heartbeat.memberUpsert + ad_member_servers.touchLastSeen.
        //   跟 R158.78 ad_member_eventlog_* + R158.79 memberUpsert 1:1 对齐.
        //   noad agent 不跑 package, 不需 reportRequested / packagesChangedAt
        //   / cold-start auto-trigger, response 字段 hard-code 默认值,
        //   noad agent 0.1.5 端无视 (已 ship).
        //   ⚠️ 整段 gate 而非只跳 line 418 upsert: 因为 cold-start auto-trigger
        //   (line ~472-485) requestReport 走 MERGE/INSERT-ON-DUPLICATE,
        //   member-server 0 行时 INSERT 空行 → 污染 100% 还原.
        //   clearReportRequest / readLastHeartbeatAt / readReportRequestedAt
        //   都 AD agent 专用 (走 agentId 不是 hostname), member-server
        //   走了 0 意义 (no-op) 但留着会 fire 整段 → 0 必要.
        //   跟 R158.86.6 enumerate lesson 1:1 修正: write 路径源头修复
        //   (member-server 0 写 ad_agent_heartbeat), 跟 R158.87.6 + 6.1
        //   NOT IN subquery 预防性 ship 100% 兼容 (subquery 变 100% 死
        //   代码但 0 改保留, R158.86.5 预防性 ship lesson).
        if (agentType === 'non-ad' && hostname) {
          try {
            await db.execute(db.sql.memberServers.touchLastSeen, [hostname]);
          } catch (e) {
            logger.warn({ err: e.message, hostname }, 'non-ad touchLastSeen failed (best-effort)');
          }
          try {
            await db.execute(db.sql.heartbeat.memberUpsert, [
              hostname,
              agentId,
              agentVersion ?? null,
              toMysqlDatetime(new Date().toISOString()),
              lastReportAt ? toMysqlDatetime(lastReportAt) : null,
              lastReportStatus ?? null,
              pendingQueueSize ?? 0,
              reportedHeartbeatIntervalSeconds,
              reportRequestedAt,
              reportedClientSettingsVersion,
              reportedTokenVersion,
              last_upgrade_event ?? null,
              'non-ad'
            ]);
          } catch (e) {
            logger.warn({ err: e.message, hostname }, 'non-ad member-heartbeat upsert failed (best-effort)');
          }
          // R161.22 (2026-10-29) — 第三个参数 'non-ad' 是这次 P0 的修复点。
          //   之前这里不传血统, 中心端一律拿 AD 源的版本号去比 ⇒ 成员代理
          //   每次心跳都被告知「有 0.1.9 (AD 包) 可升」⇒ 它拉 GET
          //   /api/agent/upgrade 拿到的也是 AD 包 ⇒ applyUpgradeDelivery
          //   把它原子覆盖到成员服务器自己的目录 ⇒ 成员服务器变成 DC 代理。
          //   现在成员代理只跟 noad 源比, 拿的是 noad 包。
          const upgradeEnv = computeUpgradeEnvelope(agentVersion, null, 'non-ad');
          // R158.100 (2026-10-14) — TDZ fix: agentTokenDelivery / agentSettingsDelivery
          // are `let` declared at lines 562 / 580+ (post this early return).
          // Spreading them here in the non-ad / member-server early-return
          // branch throws ReferenceError ("Cannot access 'agentTokenDelivery'
          // before initialization") and 500s every member heartbeat. The AD
          // branch (line 691) is unaffected — its `let` declarations run
          // first. Symptom: 34 DC + 1 member all show `last_report_at=NULL`,
          // `pending_queue_size=0` (heartbeat 200 but response body never
          // reaches agent because centre throws before res.json). The DB
          // 3-row `__cron__` pending_trigger set by trigger-now 7+ min ago
          // is never claimed because the claim path lives inside the same
          // throw-500 handler. We strip the two TDZ spreads here — member
          // agents don't need centre-issued agentToken rotation (their
          // service installer wired a static token in appsettings.json at
          // R158.94) and centre-issued settings delivery for non-ad is
          // handled by their own per-host settings delivery scheduler
          // (R158.13). 0 change to AD heartbeat path (line 691 spread
          // untouched). R158.86.6 #5 wire-shape invariant: AD 34 DC heartbeat
          // response payload is byte-identical before / after this ship.
          return res.json({
            ok: true, accepted: 0, rejected: 0,
            reportRequested: false, packagesChangedAt: null, packagesTriggers: [],
            upgradeAvailable: upgradeEnv.upgradeAvailable,
            upgradeVersion: upgradeEnv.upgradeVersion
          });
        }

        // 2026-08-25 cold-start detection: if the existing row's
        // last_heartbeat_at is more than COLD_START_THRESHOLD_S old, treat
        // this heartbeat as a fresh agent process and wipe any stale
        // `report_requested_at` so the restarted agent doesn't immediately
        // re-trigger scheduler._tick() on a request the previous process
        // already consumed (or that no longer applies). The clear runs
        // BEFORE the upsert, so the upsert's COALESCE-preserve path sees
        // a NULL column and leaves it NULL. Best-effort — a failure here
        // must NOT 500 the heartbeat.
        //
        // 2026-08-28 round-58: cold-start detection now also fires when
        // the heartbeat row is MISSING (the agent was deleted via the
        // admin heartbeat-table 删除 button and the agent process is
        // still alive heartbeating). The flag is propagated past the
        // upsert so the post-upsert block can decide whether to
        // auto-trigger a fresh report-now request — see the
        // `cold-start auto-trigger` block below.
        const COLD_START_THRESHOLD_S = 5 * 60;
        let coldStart = false;
        try {
          const cs = await db.execute(db.sql.heartbeat.readLastHeartbeatAt, [agentId]);
          const lastHb = cs.rows?.[0]?.last_heartbeat_at ?? cs?.[0]?.[0]?.last_heartbeat_at;
          if (lastHb) {
            const ageMs = Date.now() - new Date(lastHb).getTime();
            if (Number.isFinite(ageMs) && ageMs > COLD_START_THRESHOLD_S * 1000) {
              coldStart = true;
            }
          } else {
            // 2026-08-28 round-58: no existing row — treat as cold start so
            // the post-upsert trigger can refill ad_replication_status.
            // Without this branch, an agent that was deleted and is still
            // alive would heartbeat back into the list but its report
            // table would stay empty until the natural report cycle.
            coldStart = true;
          }
          if (coldStart) {
            await db.execute(db.sql.heartbeat.clearReportRequest(agentId), [agentId]);
          }
        } catch (e) {
          logger.warn({ err: e.message, agentId }, 'cold-start detection failed (best-effort)');
        }

        // 3-way SQL routing:
        //   null      → clearReportRequest (direct UPDATE … SET … = NULL)
        //   undefined / value → upsert (COALESCE preserves undefined→null, sets a value)
        if (reportRequestedAtIsExplicitNull) {
          await db.execute(db.sql.heartbeat.clearReportRequest(agentId), [agentId]);
        } else {
          await db.execute(db.sql.heartbeat.upsert, [
            agentId,
            agentVersion ?? null,
            // R158.52 — defend against legacy agents that omit lastReportAt
            // (or send an unparseable value). `toMysqlDatetime(null)` would
            // historically emit '1970-01-01 00:00:00' which is misleading;
            // explicitly skip the conversion when the value is missing.
            lastReportAt ? toMysqlDatetime(lastReportAt) : null,
            lastReportStatus ?? null,
            pendingQueueSize ?? 0,
            reportedTokenVersion,
            reportRequestedAt,
            reportedClientSettingsVersion,
            reportedHeartbeatIntervalSeconds,
            // R158.48 — agent auto-update status. Pre-R158.48 agents don't
            // forward this field → bind undefined → NULL → COALESCE preserves
            // existing row. Post-R158.48 agents that just upgraded emit this
            // exactly once (one-shot) on the FIRST heartbeat post-restart.
            last_upgrade_event ?? null,
            // R158.88.C (2026-10-13) — health_score INT NULL. Pre-R158.88.C
            //   agents 0 报 → bind undefined → NULL → ISNULL/COALESCE
            //   preserve 老 row. Post-R158.88.C fleet (0.1.7+ 升) 才报
            //   0-100. 0 改 agent 端 = 0 fleet 0 自动升 (R158.69.3
            //   lesson 3 永远适用).
            health_score ?? null
          ]);
        }

        // 2026-08-28 round-58: cold-start auto-trigger. When an agent is
        // "freshly resurrected" (admin deleted the heartbeat row via the
        // heartbeat table 删除 button, or the agent process restarted
        // after a long downtime), the heartbeat row refills via the
        // upsert above but ad_replication_status stays empty until the
        // natural report cycle runs (15min+ — package default for
        // collect-replication). Operators watching the 报告表 see the
        // row reappear with no data for many minutes, which is exactly
        // the R58 complaint: "report 表 要等 agent 主动下一次报告才能
        // 回填 (几分钟后)".
        //
        // To fix: when cold-start was detected (row missing OR >5min gap)
        // AND ad_replication_status has zero rows for this agent, set
        // report_requested_at = NOW() so the agent's NEXT heartbeat
        // (~1min later) ships a fresh report and the table refills
        // within 1-2 minutes instead of 15+. Best-effort — a failure
        // here must NOT 500 the heartbeat.
        //
        // Existing heartbeat rows with historical report data are NOT
        // re-triggered: the natural report cycle is doing its job, and
        // a spurious extra report would waste bandwidth.
        if (coldStart) {
          try {
            const cnt = await db.execute(db.sql.heartbeat.hasAnyReplicationRows(agentId), [agentId]);
            const rows = Number(cnt.rows?.[0]?.cnt ?? cnt?.[0]?.[0]?.cnt ?? 0);
            if (rows === 0) {
              const now = new Date();
              // The upsert above guarantees the heartbeat row exists now,
              // so requestReport's MERGE/INSERT-ON-DUPLICATE takes the
              // UPDATE path and only touches report_requested_at (it does
              // NOT reset last_heartbeat_at — that was set by the upsert
              // above and reflects the agent's actual last heartbeat).
              await db.execute(
                db.sql.heartbeat.requestReport(agentId, now.toISOString()),
                [agentId, now]
              );
              logger.info({
                event: 'agent.cold_start_trigger',
                agentId,
                reason: lastHb ? 'gap>5min+empty-report' : 'row-missing+empty-report'
              }, 'auto-triggered report-now on cold start');
            }
          } catch (e) {
            logger.warn({ err: e.message, agentId }, 'cold-start auto-report-now trigger failed (best-effort)');
          }
        }

        // Auto-delivery: if the server's current version is newer than
        // what the agent reported, attach the new token to the response
        // so the agent can persist it (appsettings.json) and start using
        // it on the very next heartbeat. Read AFTER the upsert so the
        // delivery reflects whatever the latest state is — concurrent
        // rotates during the request are absorbed into the response.
        //
        // Fail-soft: getAgentTokenState errors here must not 500 the
        // heartbeat; the agent's primary purpose is reporting, not
        // receiving credentials. Log and continue with no delivery.
        let agentTokenDelivery = null;
        try {
          const s = await getAgentTokenState(db);
          if (s.current && s.version > reportedTokenVersion) {
            agentTokenDelivery = { agentToken: s.current, agentTokenVersion: s.version };
          }
        } catch (e) {
          logger.warn({ err: e.message, agentId }, 'agent token state read failed; no delivery');
        }

        // 2026-10-01 R158.13 — parallel to agentTokenDelivery above.
        // If the centre's current version is newer than what the agent
        // reported, attach the new settings patch so the agent can persist
        // it (appsettings.json) and (for heartbeatIntervalSeconds) hot-
        // restart the heartbeat setInterval via the new
        // applySettingsDelivery consumer. Read AFTER the upsert so the
        // delivery reflects whatever the latest state is — concurrent
        // bumps during the request are absorbed into the response.
        //
        // Same fail-soft contract as agentTokenDelivery: errors here must
        // NOT 500 the heartbeat. Empty settings object skips delivery so
        // a freshly-seeded v1 with empty patch doesn't ship a useless
        // payload (the agent's validatePatch would reject it anyway, but
        // skipping here saves the round-trip).
        let agentSettingsDelivery = null;
        try {
          const s = await getAgentSettingsState(db);
          if (
            s.version > reportedClientSettingsVersion &&
            s.settings &&
            Object.keys(s.settings).length > 0
          ) {
            agentSettingsDelivery = {
              agentSettings: s.settings,
              clientSettingsVersion: s.version
            };
          }
        } catch (e) {
          logger.warn({ err: e.message, agentId }, 'agent settings state read failed; no delivery');
        }

        // round-12 T6: read back report_requested_at to attach
        // reportRequested: boolean to the response. This is what the agent
        // (T7) watches for — when true, its heartbeat callback calls
        // scheduler._tick(). Fail-soft: if the read fails we report false
        // rather than 500ing the heartbeat.
        let reportRequested = false;
        try {
          const rb = await db.execute(
            db.sql.heartbeat.readReportRequestedAt,
            [agentId]
          );
          const row = rb.rows?.[0];
          reportRequested = !!(row && row.report_requested_at);
        } catch (e) {
          logger.warn({ err: e.message, agentId }, 'report_requested_at read-back failed; defaulting to false');
        }

        // 2026-09-29 P1-1 (G1) — package-change watermark. Read
        // MAX(updated_at) over package_scripts + package_policies so any
        // script edit OR policy flip (enable/disable / interval / timeout /
        // params) bumps the watermark. The agent compares this against its
        // last-seen value and triggers an immediate syncFromCenter when the
        // centre is newer. Falls back to null (no change ever) on DB error
        // so the heartbeat never 500s on watermark read — agents keep their
        // 5-min periodic timer as a baseline.
        let packagesChangedAt = null;
        try {
          const { packageScripts } = await import('../db/sql/package-scripts.js');
          packagesChangedAt = await packageScripts.latestChangeAt(db);
        } catch (e) {
          logger.warn({ err: e.message, agentId }, 'packages watermark read failed (best-effort)');
        }

        // R158 (2026-09-30) — pending-trigger piggyback. cron-scheduler
        // writes a `pending_trigger` row to package_runs every 5 min
        // (and on manual /api/admin/packages/:name/trigger-now). The
        // agent's heartbeat is the cheapest way to surface those
        // triggers (≤ 60s latency, no new endpoint). Same best-effort
        // pattern as packagesChangedAt — a DB hiccup here must NOT 500
        // the heartbeat. If the queue is empty (most heartbeats) we
        // ship [] rather than omit the field so the agent's parser
        // doesn't have to special-case missing-vs-empty.
        let packagesTriggers = [];
        try {
          const { claimPendingTriggers } = await import('../services/trigger-queue.js');
          packagesTriggers = await claimPendingTriggers({ agentId, limit: 5, db });
        } catch (e) {
          logger.warn({ err: e.message, agentId }, 'trigger queue read failed (best-effort)');
        }

        // Optional port-status ingest (back-compat: pre-feature agents omit `ports`).
        if (ports !== undefined && ports !== null) {
          if (!Array.isArray(ports)) {
            return res.status(400).json({ error: 'ports must be an array' });
          }
          const portRows = await listPorts();
          const validPortsSet = new Set(portRows.map(p => p.port));
          const { accepted, rejected } = await upsertPortStatuses(agentId, ports, { validPortsSet });

          // R158.87.7 (2026-10-12) — non-ad member-server heartbeat 早
          //   return gate (line ~373) 拦了, 这里 `if (agentType === 'non-ad'
          //   && hostname)` 永远 false → 死代码删除. 保留行 664-696 注释
          //   太长 0 信息价值, 删了精简. touchLastSeen + memberUpsert
          //   都在早 return 块里 (line ~373-416) 跑.

          // Spread the delivery object last so callers can read both
          // port-acceptance counters and the auto-delivery payload in
          // one response. agentTokenDelivery is null when no delivery
          // is needed — callers should check via 'agentToken' in result.
          // round-12 T6: reportRequested boolean so the agent's heartbeat
          // callback can decide whether to fire scheduler._tick().
          // R158.48 (2026-10-06) — agent auto-update envelope (upgradeAvailable +
          // upgradeVersion). Agent sees upgradeAvailable=true → GETs
          // /api/agent/upgrade → applies bundle → SIGTERM self-restart. Pre-feature
          // agents ignore these fields — backwards-compatible (no version bump required).
          const upgradeEnv = computeUpgradeEnvelope(agentVersion);
          // R158.69.3 (2026-10-10) — diagnostic log for fleet auto-upgrade dead-lock.
          // 4 fleet 0.1.4 都是 operator 手动拷 (last_upgrade_event=null 铁证), 中心
          // 推送从来没成功过. 加这一行看 envelope 真在每次 heartbeat 发出.
          logger.info?.({
            event: 'agent.upgrade.envelope.sent',
            agentId, reportedVersion: agentVersion,
            targetVersion: upgradeEnv.upgradeVersion,
            upgradeAvailable: upgradeEnv.upgradeAvailable
          }, 'agent upgrade envelope dispatched');
          return res.json({
            ok: true, accepted, rejected,
            reportRequested, packagesChangedAt, packagesTriggers,
            ...(agentTokenDelivery || {}),
            ...(agentSettingsDelivery || {}),
            upgradeAvailable: upgradeEnv.upgradeAvailable,
            upgradeVersion: upgradeEnv.upgradeVersion
          });
        }

        // R158.87.7 (2026-10-12) — legacy no-ports 非 AD 分支 + 重复
        //   upgradeEnv2 计算 + 重复 res.json 删了. 非 AD 早 return gate
        //   (line ~373) 拦住, 下面代码 AD agent 才走 (ports payload
        //   0 跟 legacy 路径 0 命中, 删了精简).
      } catch (e) {
        // R158.56d (2026-10-09) — heartbeat fail-soft for pre-R158.48 agents.
        // 33 DC 跑 0.1.2 bundle, agent.js:418 只绑 10 参 (缺 last_upgrade_event
        // p10). MSSQL tedious `validate string` strict 抛 EPARAM "Invalid string"
        // → catch 走 500 → NSSM SIGTERM 25s 后强杀 → "心跳不 30s". Now degrade to
        // 200 ack with `degraded` flag, 33 DC 立即恢复 30s 间隔心跳. 跟 operator
        // directive "不要自己去升级" 一致: 不动 0.1.2 bundle, 不推 0.1.3 fleet,
        // 中心端兼容老 bundle. 待 R158.56e (operator 手动 ship 0.1.4) 之后 revert.
        // EPARAM 也覆盖 R155 retry 同款识别, 复用 e.originalError.code 链.
        const isParamValidation = e?.originalError?.code === 'EPARAM'
          || /parameter 'p\d+'/.test(e?.message || '');
        if (isParamValidation) {
          logger.warn({ err: e.message, agentId, isParamValidation },
            'heartbeat param validation; degraded ack (R158.56d)');
          return res.json({ ok: true, degraded: 'param-validation' });
        }
        logger.error({ err: e, agentId }, 'heartbeat failed');
        res.status(500).json({ error: 'internal' });
      }
    });
  }

  if (mount === 'report' || mount === 'full') {
    r.post('/api/agent/report', agentMw, async (req, res) => {
      const { agentId, collectedAt, data } = req.body || {};
      if (!agentId || !collectedAt || !Array.isArray(data)) {
        return res.status(400).json({ error: 'missing agentId, collectedAt, or data[]' });
      }
      // 2026-08-25 round-12 observability: log every report with the data
      // shape the operator needs to validate. source='collect-replication'
      // is stamped by agent/src/reporter.js postReport so the log line
      // shows which PS script produced the entries; old agents fall back to
      // 'unknown'. summaryEntries count lets the operator spot the Bug Z/W
      // class of silent drops at a glance (e.g. count=0 when the PS1 emits
      // them is a smoking gun).
      // 2026-08-28 round-45: partnerPortEntries counter removed (R35 port
      // monitoring surface dropped — no agent emits __partner_ports__:% rows
      // anymore).
      logger.info({
        event: 'agent.report',
        source: req.body?.source ?? 'unknown',
        agentId,
        collectedAt,
        entries: data.length,
        summaryEntries: data.filter(r => r?.namingContext === '__dc_summary__' || r?.naming_context === '__dc_summary__').length
      }, 'agent report received');
      try {
        const db = getDb();
        const cfg = await getConfig();
        // Accept both '1' and 'true' (case-insensitive) — matches the
        // convention in init/marker.js:118 (ADDASHBOARD_* env vars) and
        // avoids the silent-drop class where a UI / CLI sets the flag to
        // '1' and the route never fires insertHistoryEntries. The route
        // used to be strict-string; R58.1 widened it after a live-verify
        // catch where ad_replication_history stayed empty.
        const historyEnabled = (() => {
          const v = String(cfg.history_enabled ?? 'false').toLowerCase();
          return v === 'true' || v === '1' || v === 'yes';
        })();
        // 2026-08-27 round-42 (复制日志监控): split data[] into
        // status-rows (default) + history-rows (naming_context starts with
        // '__history__:'). Status rows go through upsertStatus (so they
        // land in ad_replication_status). History rows go through the
        // dedicated insertHistoryEntries path (so they land ONLY in
        // ad_replication_history — never in ad_replication_status, which
        // would otherwise be corrupted by back-dated attempt timestamps
        // and silently break the latest-per-pair matrix query).
        const annotated = data.map(row => ({ ...row, agentId, collectedAt }));
        const statusRows = [];
        const historyRows = [];
        for (const r of annotated) {
          const nc = r.namingContext ?? r.naming_context ?? '';
          if (typeof nc === 'string' && nc.startsWith('__history__:')) {
            historyRows.push(r);
          } else {
            statusRows.push(r);
          }
        }

        // R158.X.99-quota (2026-10-21) — 节点配额准入判定. 超额 agent 的数据
        //   **服务端不接收** (操作员 directive: 第 N+1 台起丢弃), 但**响应照常返回**
        //   —— agent 侧不报错、不重连、页面仍显示在线. 理由: 让超额成为可见的
        //   "数据缺失" 而不是"采集故障", 排查成本低得多. 告警走 logger + License 页.
        //   fail-open: 查不到配额一律放行 (误拒合法节点数据是破坏性故障).
        const admission = await checkAgentAdmission(db, logger, agentId);
        if (!admission.allow) {
          logger.warn({
            event: 'agent.report.quota_exceeded',
            agentId,
            seq: admission.seq,
            allowed: admission.allowed,
            over_by: admission.over_by,
            dropped_entries: data.length
          }, 'agent report DROPPED — over license node quota');
        } else {
          await upsertStatus(statusRows, { appendHistory: historyEnabled, logger });
          if (historyEnabled && historyRows.length > 0) {
            await insertHistoryEntries(historyRows);
          }
        }

        // 2026-08-26 round-18: lockout event ingest removed from this
        // path. The agent no longer carries LockoutEvents on the
        // replication snapshot; lockout data ships via the
        // ad_lockout_list package on a 15-minute cadence (POST
        // /api/agent/packages/report → metricstore v2 → pkg_ad_lockout_list.metrics).

        const { pollingIntervalMinutes, latencyThresholdMinutes, heartbeatIntervalSeconds } = await getAgentConfig();
        res.json({ ok: true, config: { pollingIntervalMinutes, latencyThresholdMinutes, heartbeatIntervalSeconds } });
      } catch (e) {
        logger.error({ err: e, agentId }, 'report failed');
        res.status(500).json({ error: 'internal' });
      }
    });

    r.post('/api/agent/discover', agentMw, async (req, res) => {
      const { agentId, collectedAt, dc } = req.body || {};
      if (!agentId || !collectedAt || !dc?.name) {
        return res.status(400).json({ error: 'missing agentId/collectedAt/dc.name' });
      }
      // 2026-08-25 round-12 observability: log every discover request so
      // the operator can verify whether collect-discovery.ps1 is firing
      // and what shape (dc.name, dc.site, dc.rolesCount) it's emitting.
      // source='collect-discovery' is stamped by agent/src/discovery.js.
      logger.info({
        event: 'agent.discover',
        source: req.body?.source ?? 'unknown',
        agentId,
        collectedAt,
        dcName: dc.name,
        dcSite: dc.site ?? null,
        rolesCount: Array.isArray(dc.roles) ? dc.roles.length : 0
      }, 'agent discover received');
      try {
        await upsertDiscoveredDc({ agentId, collectedAt, dc });
        res.json({ ok: true });
      } catch (e) {
        logger.error({ err: e, agentId }, 'discover failed');
        res.status(500).json({ error: 'internal' });
      }
    });

    r.get('/api/agent/config', agentMw, async (_req, res) => {
      try {
        const full = await getAgentConfig();
        res.json(full);
      } catch (e) {
        logger.error({ err: e }, 'agent config fetch failed');
        res.status(500).json({ error: 'internal' });
      }
    });

    // 2026-08-28 round-45: /api/agent/partner-ports endpoint removed —
    // R35 port monitoring surface deleted. Real agent no longer probes
    // partner TCP ports (see collect-replication.ps1). Operator-side
    // /api/admin/replication-port-config routes stay (separate UI backed
    // by services/ports.js — explicitly preserved per round-45 plan).

    // 2026-09-27 R121 — surface /api/agent/packages* on the report port
    // (8082). DC agent's PackageManager (cachedPorts.reportPort = 8082)
    // hits /api/agent/packages here; without this mirror the request
    // returns 404 and the agent logs "package sync failed status=404".
    // The same handler functions live in packageRunner on webApp (8080)
    // for legacy / non-package clients; here we register them against
    // the agentMw-gated paths so DC agents see the same envelope
    // ({packages:[{name,version,script(base64),manifest,params}]}).
    //
    // Why `agentMw` here and not a fresh `agentToken(...)`: agentMw is
    // already wired above (line 26) with S82 identity binding. Re-using
    // the same instance keeps HMAC verification consistent across the
    // three ports — the agent signs once with its (hostname, agentId,
    // body) triple and any of the three accepts it.
    //
    // NOTE: the canonical R121 surface is on 8082 (this block); the
    // webApp (8080) registration in packageRunner remains for any agent
    // that still targets web (legacy / custom clients / manual pulls).
    // Both registrations are intentional — they're not duplicates, they
    // expose the same handler against different mounts. The handlers
    // themselves come from runner.js so SQL / bakeManifest / ETL post-
    // hooks (R107.1 / R110.A / R112) all stay in one place.
    // 2026-09-29 P1-3 (G6) — the dual-mount registration (webApp 8080 +
    // reportApp 8082) is now driven by `registerPackageRoutes(router,
    // deps)`, the SINGLE source of truth for path + handler binding.
    // The webApp mount in packageRunner still works the same way
    // (internally calls registerPackageRoutes on a fresh Router), so
    // both ports see identical handlers against the SAME underlying
    // agentMw instance. Future regressions that drop one mount are
    // impossible by construction: if anyone hand-wires `r.get(...
    // /api/agent/packages, ...)` again the linter has to scream
    // because the registrar IS the only path registration.
    const reportDeps = { db: getDb(), agentMw, getLogger: () => logger };
    registerPackageRoutes(r, reportDeps);
  }

  // 2026-08-30 R65 followup — file-push poll endpoint. Agents call this
  // on their normal report cadence (or in a dedicated long-poll loop)
  // to find tasks targeted at their hostname. Mounted on both 'web'
  // and 'report' so agents on either port can poll — heartbeat port
  // (8081) is intentionally excluded because that path is for
  // high-frequency small payloads and shouldn't carry multi-MB file
  // push responses.
  if (mount === 'web' || mount === 'report' || mount === 'full') {
    // R154.5 (port-mismatch fix) — surface /api/agent/inbound-partners on
    // web (8080) + report (8082) too. The agent bundle passes its appsettings
    // centerUrl to PackageManager and that defaults to the web port (8080),
    // so spoke agents calling /api/agent/inbound-partners from collect.ps1
    // were hitting 404 and falling back to peers=[] in the catch block.
    // Re-using the same handler as the heartbeat mount keeps the wire shape
    // identical across ports.
    r.get('/api/agent/inbound-partners', agentMw, inboundPartnersHandler);

    // R155.4 — outbound-partners mirror on web (8080) + report (8082).
    // Same R154.5 port-mismatch rationale as inbound-partners: agent
    // bundles pass appsettings centerUrl (default 8080 web) to
    // PackageManager so the new ad_dc_probe_outbound collect.ps1
    // will hit 8080 unless this mount exists.
    r.get('/api/agent/outbound-partners', agentMw, outboundPartnersHandler);

    // R158.15 — inbound-partners-warehouse mirror on web (8080) +
    // report (8082). Same R154.5 port-mismatch rationale.
    r.get('/api/agent/inbound-partners-warehouse', agentMw, inboundPartnersWarehouseHandler);

    r.get('/api/agent/file-push', agentMw, async (req, res) => {
      // 2026-10-21 (security) — 签名绑定身份优先, query 仅在未签名时兜底。
      // 与 /api/agent/ad-commands + /api/agent/member-commands 同构: 无条件用
      // req.query.hostname 会让持有任一 agent token 的人领走发给别的机器的任务 ——
      // services/file-push.js:313 按传入的 hostname 匹配 targets, 且 :323 会把
      // 别的机器的 pending 目标标记 claimedBy=自己(不只是窃取, 还污染状态)。
      // req._agentIdentityBound 仅在签名校验通过时设置(auth/agent-token.js:194),
      // 所以"未绑定"等价于"未签名", 老 agent 仍走 query 不破坏部署。
      const hostname = String(
        (req._agentIdentityBound && req._agentIdentityBound.hostname)
        || req.query.hostname || ''
      ).trim();
      const agentId  = String(req.query.agentId  || req.body?.agentId || '').trim();
      if (!hostname) return res.status(400).json({ error: 'hostname required' });
      try {
        const { claimForAgent } = await import('../services/file-push.js');
        // R158.69.9 (2026-10-11) — claimForAgent 抛 (mostly flushIndex ENOENT
        // race / Windows MoveFileEx) 不能返 500 — 那让 agent drainer 看到
        // 500 永远不重试. 503 + retry hint 让 agent 在下一次 heartbeat
        // 自然重试 (默认 30s). 不破坏 in-memory state, accept transient.
        // mutex 修后 race 99% 不会发生, 但 disk full / permission 等仍可能
        // 让 flushIndex 抛 — 这层防御覆盖所有 transient 错.
        let tasks;
        try {
          tasks = await claimForAgent(agentId || 'unknown', hostname);
        } catch (claimErr) {
          logger.warn({
            err: claimErr?.message, hostname, agentId, code: claimErr?.code
          }, 'agent file-push claim transient failure; agent will retry next heartbeat');
          return res.status(503).json({ error: 'claim transient', retry: true });
        }
        // 'claimed' audit row per poll that finds a new task. We only
        // emit on the FIRST claim — re-polls don't re-audit, so an
        // operator scanning the audit log doesn't see 200 copies of
        // "push_file_claimed" per task.
        for (const t of tasks) {
          await writeAudit({
            action: 'push_file_claimed',
            target: t.taskId,
            payload: { taskId: t.taskId, hostname, agentId, filename: t.filename, targetType: t.targetType },
            logger
          });
        }
        res.json({ tasks });
      } catch (e) {
        if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.message });
        logger.error({ err: e }, 'agent file-push poll failed');
        res.status(500).json({ error: 'internal' });
      }
    });

    // Agent-side file download (matches the admin /file endpoint but
    // gated by agentToken instead of userAuth). Same path used by the
    // admin route — the agent's token grants them read access to any
    // task whose `targets` includes their hostname (enforced upstream
    // in claimForAgent).
    r.get('/api/agent/file-push/:id/file', agentMw, async (req, res) => {
      // 2026-10-21 (security) — 同上, 签名绑定身份优先。
      // 这个端点本身已有真实目标校验(下方 matchedTarget, 不中返 403), 所以不是
      // 跨机泄露; 但绑定签名身份后, 已签名 agent 只能取真正发给它的任务,
      // 不再依赖 query 自称身份。与领取端点保持一致的取值口径。
      const hostname = String(
        (req._agentIdentityBound && req._agentIdentityBound.hostname)
        || req.query.hostname || ''
      ).trim();
      if (!hostname) return res.status(400).json({ error: 'hostname required' });
      try {
        const { getTask, getTaskFile } = await import('../services/file-push.js');
        const t = await getTask(req.params.id);
        // R158.69.10 (2026-10-11) — case-insensitive target match.
        // R158.61+5 修了 claimForAgent + ackTask 用 .toLowerCase() 比较
        // (Windows os.hostname() 返 mixed case 如 KDLBJOFADSrv1, AD canonical
        // uppercase KDLBJOFADSRV1), 但 download 端点漏修 — agent 拿到 task,
        // download /api/agent/file-push/:id/file?hostname=KDLBJOFADSrv1 永远
        // 403 'hostname not a target', agent 永远不写盘, ack 报 download fail,
        // 永远 stuck claimed. 修法跟 R158.61+5 同 idiom.
        const hostnameLower = hostname.toLowerCase();
        const matchedTarget = t.targets.find(x => String(x).toLowerCase() === hostnameLower);
        if (!matchedTarget) {
          return res.status(403).json({ error: 'hostname not a target of this task' });
        }
        const buf = await getTaskFile(req.params.id);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${t.filename}"`);
        res.setHeader('X-File-Sha256', t.sha256);
        res.send(buf);
      } catch (e) {
        if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.message });
        logger.error({ err: e }, 'agent file-push download failed');
        res.status(500).json({ error: 'internal' });
      }
    });

    // 2026-09-22 R78.1 — agent-side file-push ack. After the agent has
    // written the file to disk (or hit a write error), it POSTs the
    // outcome here so the center flips the per-target status to
    // 'delivered' / 'failed' and emits the matching audit row. Closes
    // the long-standing gap where the center's only ack surface was
    // the admin-authed /api/admin/file-push/:id/ack (the agent doesn't
    // hold an ADMIN_TOKEN). Body shape mirrors the admin ack so the
    // service-layer ackTask() is reused without changes.
    //
    //   POST /api/agent/file-push/:id/ack
    //   body: { hostname, agentId, ok, errorMessage? }
    //   200 — { task } on success; target status flipped
    //   400 — missing hostname/agentId
    //   403 — hostname not a target of this task (defense-in-depth;
    //         mirrors the GET /file guard on the same task)
    //   404 — task id unknown
    r.post('/api/agent/file-push/:id/ack', agentMw, async (req, res) => {
      const body = req.body || {};
      const hostname = String(body.hostname || '').trim();
      const agentId = String(body.agentId || '').trim();
      const ok = body.ok === true || body.ok === 'true';
      const errorMessage = typeof body.errorMessage === 'string' ? body.errorMessage : null;
      if (!hostname) return res.status(400).json({ error: 'hostname required' });
      if (!agentId) return res.status(400).json({ error: 'agentId required' });
      try {
        const { ackTask, getTask } = await import('../services/file-push.js');
        // R158.69.10 (2026-10-11) — case-insensitive target match (跟
        // GET /file 端点同修). R158.61+5 修了 service-layer ackTask 用
        // .toLowerCase() 比较, 但 route handler 这层防御性 case-sensitive
        // .includes() 漏修 — agent mixed case 'KDLBJOFADSrv1' vs target
        // uppercase 'KDLBJOFADSRV1' → 永远 403, ack 不到, task 永远 stuck.
        const t = await getTask(req.params.id);
        const hostnameLower = hostname.toLowerCase();
        const matchedTarget = t.targets.find(x => String(x).toLowerCase() === hostnameLower);
        if (!matchedTarget) {
          return res.status(403).json({ error: 'hostname not a target of this task' });
        }
        const updated = await ackTask(req.params.id, hostname, agentId, ok, errorMessage);
        // operator_id is null: this is an agent action, not an operator one.
        // Mirrors the ad-commands ack pattern at /api/agent/ad-commands/:id/result.
        await writeAudit({
          action: ok ? 'push_file_delivered' : 'push_file_failed',
          target: req.params.id,
          payload: {
            taskId: req.params.id,
            hostname,
            agentId,
            errorMessage,
            taskStatus: updated.status,
            source: 'agent'
          },
          logger
        });
        res.json(updated);
      } catch (e) {
        if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.message });
        logger.error({ err: e, taskId: req.params.id, hostname }, 'agent file-push ack failed');
        res.status(500).json({ error: 'internal' });
      }
    });

    // 2026-08-31 R75 — AD user & group management command queue.
    // Agents poll this endpoint on their normal cadence to find queued
    // commands targeting their hostname. Two-step claim is handled by
    // services/ad-admin-commands.js claimForAgent (atomic via UPDATE
    // … WHERE status='queued'). Per spec §3.3 each successful claim emits
    // one 'ad_command_claimed' audit row (matches the per-file pattern
    // already used by /api/agent/file-push).
    r.get('/api/agent/ad-commands', agentMw, async (req, res) => {
      // 2026-10-21 (security) — 身份来源改为"签名绑定优先, query 仅兜底"。
      // 改动前无条件用 req.query.hostname, 而 token 是全局单份(agent-token.js:142-145
      // bundle.current/previous) 且 query 参数不参与签名 → 持有 fleet 里任意一台
      // agent token 的人, 可改 ?hostname= 领走发给别的机器的命令, 其中
      // ad-admin-commands.js:117/139 是明文 password / newPassword。
      // 对齐同一仓库 packages/runner.js:438-443 的既有正确范式(那里甚至有注释
      // 明写"server 端依赖 query param 是不安全的")。
      // _agentIdentityBound 由 auth/agent-token.js:194 仅在签名校验通过时设置,
      // 所以"未绑定"精确等价于"未签名/被拒" —— 老 agent 仍走 query 不破坏部署,
      // 而签名过的 agent 无法再用 query 冒充别的机器。
      const hostname = String(
        (req._agentIdentityBound && req._agentIdentityBound.hostname)
        || req.query.hostname || ''
      ).trim();
      if (!hostname) return res.status(400).json({ error: 'hostname required' });
      try {
        const { claimForAgent } = await import('../services/ad-admin-commands.js');
        const claimed = await claimForAgent(hostname, 5);
        // Mirror file-push: one ad_command_claimed audit row per claim.
        // operator_id is null (this is an agent action, not an operator one).
        for (const c of claimed) {
          await writeAudit({
            action: 'ad_command_claimed',
            target: `dc:${hostname}`,
            payload: {
              commandId: c.id,
              // R158.46b — task_id 来自中心入队时刻生成的 "<DC>-<UTC YYYYMMDDHHMMSSmmm>",
              // 跟 succeeded/failed/timeout 4 个 lifecycle row 用同一 ID, 方便 operator 在
              // /admin/ad-management-log 顶部 lifecycle panel 一眼对到.
              taskId: c.task_id ?? null,
              commandType: c.command_type,
              hostname
            },
            logger
          });
        }
        // Agent view: strip params_json from JSON-stringified text into a
        // real object the agent's JS dispatcher can read directly. The
        // service has already parsed it on the way out of claimForAgent.
        res.json({
          commands: claimed.map(c => ({
            id: c.id,
            commandType: c.command_type,
            targetDc: c.target_dc,
            params: c.params_json,
            status: c.status,
            createdAt: c.created_at,
            claimedAt: c.claimed_at
          }))
        });
      } catch (e) {
        if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.message });
        // R93.2 — log full error (pino serializes Error.message + Error.stack
        // by default). Previously `err: e` got `err.message` only because
        // the surrounding logger config didn't have a custom serializer;
        // the stack was invisible when claimForAgent threw from a DB
        // deadlock or driver init race. Surfacing the stack in NSSM
        // stderr makes root-cause visible without code changes inside
        // the services themselves.
        logger.error({
          err: { message: e.message, stack: e.stack, code: e.code },
          hostname,
          endpoint: 'ad-commands'
        }, 'agent ad-commands poll failed');
        res.status(500).json({ error: 'internal' });
      }
    });

    // Agent-side ack: terminal-state report after PS1 dispatch.
    // Body: { success, data, error, exitCode, durationMs }.
    // Response: 200 with the new status, 404 if the command never
    // existed / was already terminal before this claim, 409 if the
    // command was claimed by someone else (defense-in-depth).
    r.post('/api/agent/ad-commands/:id/result', agentMw, async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
      const { success, data, error, exitCode, durationMs } = req.body || {};
      try {
        const { completeCommand, getCommand } = await import('../services/ad-admin-commands.js');
        const before = await getCommand(id);
        if (!before) return res.status(404).json({ error: 'command not found' });
        const row = await completeCommand(id, { success, data, error, exitCode, durationMs });
        await writeAudit({
          action: success ? 'ad_command_succeeded' : 'ad_command_failed',
          target: `cmd:${id}`,
          payload: {
            commandId: id,
            // R158.46b — task_id 来自 queue 时刻 (跟 claimed 同源), 4 lifecycle row 同 ID.
            taskId: row.task_id ?? null,
            commandType: row.command_type,
            targetDc: row.target_dc,
            exitCode: Number.isFinite(Number(exitCode)) ? Number(exitCode) : null,
            durationMs: Number.isFinite(Number(durationMs)) ? Number(durationMs) : null,
            errorMessage: error ?? null
          },
          logger
        });
        res.json({ ok: true, commandId: id, status: row.status });
      } catch (e) {
        if (e.httpStatus) {
          // completeCommand throws 404 for "not found" + 409 for "not in
          // running state" (the spec §2.4 'command not claimed by this
          // agent' defense-in-depth path). Map both to the right status.
          return res.status(e.httpStatus).json({ error: e.message });
        }
        logger.error({ err: e, id }, 'ad-commands ack failed');
        res.status(500).json({ error: 'internal' });
      }
    });

    // 2026-09-05 R81 — member-server PowerShell command queue agent
    // surface. Mirrors the /api/agent/ad-commands pair above but targets
    // arbitrary member-server hostnames (the agent is identified by its
    // hostname in the heartbeat table — same primary key). Two-step
    // atomic claim lives in services/member-commands.js claimForAgent.
    //
    // Each successful claim emits one 'ad_member_command_claimed' audit
    // row (matches the per-row pattern already used by ad-commands +
    // file-push). Ack writes 'ad_member_command_succeeded' /
    // '_failed' depending on success. The 30s timeout sweeper writes
    // 'ad_member_command_timed_out' (server.js T4).
    r.get('/api/agent/member-commands', agentMw, async (req, res) => {
      // 2026-10-21 (security) — 同 /api/agent/ad-commands: 签名绑定身份优先,
      // query 仅在未签名时兜底。member-commands 的 params.script 是自由格式
      // PowerShell 全文(member-commands.js:153/180), 跨机领取等价于任意代码执行。
      const hostname = String(
        (req._agentIdentityBound && req._agentIdentityBound.hostname)
        || req.query.hostname || ''
      ).trim();
      if (!hostname) return res.status(400).json({ error: 'hostname required' });
      try {
        const { claimForAgent } = await import('../services/member-commands.js');
        const claimedRaw = await claimForAgent(hostname, 5);
        // R158.52 — claimForAgent is documented to return an Array, but a
        // future shape change or an edge-case driver returning a single
        // object would throw `claimed.map is not a function` and 500 the
        // entire route. Normalise defensively.
        const claimed = Array.isArray(claimedRaw) ? claimedRaw : (claimedRaw ? [claimedRaw] : []);
        for (const c of claimed) {
          await writeAudit({
            action: 'ad_member_command_claimed',
            target: `host:${hostname}`,
            payload: {
              commandId: c.id,
              commandType: c.command_type,
              hostname,
              params: c.params_json
            },
            logger
          });
        }
        // Agent view: strip params_json into a real object the JS
        // dispatcher can read (same shape as the ad-commands response).
        res.json({
          commands: claimed.map(c => ({
            id: c.id,
            hostname: c.hostname,
            commandType: c.command_type,
            params: c.params_json,
            status: c.status,
            createdAt: c.created_at,
            claimedAt: c.claimed_at
          }))
        });
      } catch (e) {
        if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.message });
        // R93.2 — see ad-commands catch above for the rationale (full
        // error payload incl. stack so DB-driver / deadlock causes show
        // up in NSSM stderr instead of disappearing into a 500).
        logger.error({
          err: { message: e.message, stack: e.stack, code: e.code },
          hostname,
          endpoint: 'member-commands'
        }, 'agent member-commands poll failed');
        res.status(500).json({ error: 'internal' });
      }
    });

    // Agent-side ack: terminal-state report after PS1 dispatch.
    // Body: { success, data, error, exitCode, durationMs } — same shape
    // as ad-commands ack so the dispatcher logic is shared.
    r.post('/api/agent/member-commands/:id/result', agentMw, async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
      const { success, data, error, exitCode, durationMs } = req.body || {};
      try {
        const { completeCommand, getCommand } = await import('../services/member-commands.js');
        const before = await getCommand(id);
        if (!before) return res.status(404).json({ error: 'command not found' });
        const row = await completeCommand(id, { success, data, error, exitCode, durationMs });
        await writeAudit({
          action: success ? 'ad_member_command_succeeded' : 'ad_member_command_failed',
          target: `cmd:${id}`,
          payload: {
            commandId: id,
            commandType: row.command_type,
            hostname: row.hostname,
            exitCode: Number.isFinite(Number(exitCode)) ? Number(exitCode) : null,
            durationMs: Number.isFinite(Number(durationMs)) ? Number(durationMs) : null,
            errorMessage: error ?? null
          },
          logger
        });
        res.json({ ok: true, commandId: id, status: row.status });
      } catch (e) {
        if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.message });
        logger.error({ err: e, id }, 'member-commands ack failed');
        res.status(500).json({ error: 'internal' });
      }
    });
  }

  // Web mount: stable bootstrap endpoint for agents. Lives on the web port
  // (default 8080) so agents can fetch their connection config without
  // needing to know any port number besides the one in `centerUrl`. Same
  // payload shape as /api/agent/config on the report port (compat) — the
  // only difference is the URL an agent hits. Auth is X-Agent-Token, same
  // as the rest of agentRouter.
  //
  // Without this, an agent whose `centerUrl` pointed at the heartbeat port
  // (8081) could never reach /api/agent/config (which only lives on report
  // port 8082 / web port 8080) — fetchConfig returned 404, cachedPorts
  // stayed null, and operator-driven port changes had no effect.
  if (mount === 'web' || mount === 'full') {
    r.get('/config.json', agentMw, async (_req, res) => {
      try {
        const full = await getAgentConfig();
        res.json(full);
      } catch (e) {
        logger.error({ err: e }, 'agent config bootstrap fetch failed');
        res.status(500).json({ error: 'internal' });
      }
    });
    // R158.48 (2026-10-06) — agent auto-update. GET /api/agent/upgrade returns
    // the JSON bundle {version, files: [{path, sha256, base64}]} sourced from
    // <repoRoot>/agent. Mounted on web (8080) to match /api/agent/packages
    // shape. Auth: same agentMw (HMAC + 60s restart-grace). Cache: module-level
    // in src/routes/agent-upgrade.js, populated at server.js boot.
    registerAgentUpgradeRoutes(r, { agentMw, logger });
  }

  return r;
}