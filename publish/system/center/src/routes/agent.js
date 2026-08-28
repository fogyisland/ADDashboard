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

export function agentRouter({ config, logger, mount = 'full' }) {
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

    r.post('/api/agent/heartbeat', agentMw, async (req, res) => {
      const { agentId, agentVersion, pendingQueueSize, lastReportAt, lastReportStatus, ports, agentType, hostname, agent_token_version, report_requested_at } = req.body || {};
      if (!agentId) return res.status(400).json({ error: 'missing agentId' });
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
        reportRequestedAt: report_requested_at ?? null
      }, 'agent heartbeat received');
      // 2026-08-21 UX redesign (auto-delivery): the heartbeat is now the
      // carrier for the agent's last-seen agent_token_version. Default 0
      // for pre-feature agents (their version matches the server's
      // initial version, so no delivery happens until a rotation bumps
      // the server side).
      const reportedTokenVersion = Number(agent_token_version) || 0;
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
            toMysqlDatetime(lastReportAt),
            lastReportStatus ?? null,
            pendingQueueSize ?? 0,
            reportedTokenVersion,
            reportRequestedAt
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

        // Optional port-status ingest (back-compat: pre-feature agents omit `ports`).
        if (ports !== undefined && ports !== null) {
          if (!Array.isArray(ports)) {
            return res.status(400).json({ error: 'ports must be an array' });
          }
          const portRows = await listPorts();
          const validPortsSet = new Set(portRows.map(p => p.port));
          const { accepted, rejected } = await upsertPortStatuses(agentId, ports, { validPortsSet });

          // Non-AD extension (Task 6 of the non-AD plan): when a non-AD
          // agent (agentType='non-ad') sends a heartbeat with hostname,
          // bump last_seen_at on ad_member_servers so the admin "last
          // seen" panel stays current. Additive — DC agents keep their
          // existing path untouched. Both code paths still write to
          // ad_agent_heartbeat (the upsert above). Wrapped in try/catch
          // so a missing ad_member_servers row (agent hasn't self-
          // registered yet) does NOT fail the heartbeat — self-register
          // will create the row on next call. Best-effort, runs before
          // the early return so non-AD port-status agents still get
          // their last_seen_at bumped.
          if (agentType === 'non-ad' && hostname) {
            try {
              await db.execute(db.sql.memberServers.touchLastSeen, [hostname]);
            } catch (e) {
              logger.warn({ err: e.message, hostname }, 'non-ad touchLastSeen failed (best-effort)');
            }
          }

          // Spread the delivery object last so callers can read both
          // port-acceptance counters and the auto-delivery payload in
          // one response. agentTokenDelivery is null when no delivery
          // is needed — callers should check via 'agentToken' in result.
          // round-12 T6: reportRequested boolean so the agent's heartbeat
          // callback can decide whether to fire scheduler._tick().
          return res.json({ ok: true, accepted, rejected, reportRequested, ...(agentTokenDelivery || {}) });
        }

        // No ports payload — same non-AD touchLastSeen extension for the
        // legacy heartbeat shape. Independent try/catch so it can't
        // poison the response.
        if (agentType === 'non-ad' && hostname) {
          try {
            await db.execute(db.sql.memberServers.touchLastSeen, [hostname]);
          } catch (e) {
            logger.warn({ err: e.message, hostname }, 'non-ad touchLastSeen failed (best-effort)');
          }
        }

        res.json({ ok: true, reportRequested, ...(agentTokenDelivery || {}) });
      } catch (e) {
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
        await upsertStatus(statusRows, { appendHistory: historyEnabled });
        if (historyEnabled && historyRows.length > 0) {
          await insertHistoryEntries(historyRows);
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

    r.get('/api/agent/config', async (_req, res) => {
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
  }

  return r;
}