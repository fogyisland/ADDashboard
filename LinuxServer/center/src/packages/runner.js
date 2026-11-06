// Agent-facing REST endpoints for the package system.
//
// Endpoints (all require a valid x-agent-token via the agentMw middleware):
//   GET  /api/agent/packages              → list of enabled packages for
//                                            this agent (manifest + base64
//                                            script + baked
//                                            intervalSec/timeoutMs)
//   GET  /api/agent/packages/:name/script → base64 script for a single
//                                            enabled pkg
//   POST /api/agent/packages/report       → batch of run results; ingests
//                                            metrics and records runs in
//                                            package_runs
//
// R66 Task 8: data source switched from `installed_packages` +
// data/packages/<name>/<version>/collect.ps1 (on-disk) to a JOIN across
// `package_policies` + `package_scripts` (DB-only). The agent-side wire
// format is byte-identical — the same {packages:[{name,version,manifest,
// script,params}]} envelope, with policy.interval_sec/timeout_ms baked
// into manifest.agent.intervalSec / manifest.agent.timeoutMs.
//
// Errors: any thrown error collapses to 500 with
// `{ ok: false, error: { code, message } }`. The 400 path (non-array
// `runs`) and the 404 path (script or policy row missing / policy
// disabled) are explicit.

import express from 'express';
import { packageScripts } from '../db/sql/package-scripts.js';
import { packagePolicies } from '../db/sql/package-policies.js';
import { packageRuns } from '../db/sql/package-runs.js';
import { metricstore } from './metricstore.js';
import * as lockoutService from '../services/lockout.js';
import * as dcOverviewService from '../services/dc-overview.js';
import * as eventlogService from '../services/eventlog.js';
// R158.78 (2026-10-12) — member_eventlog_collector post-hook (member-server 事件日志专表).
//   跟 eventlogService (DC 端 ad_eventlog_*) 平行但独立: 字段 hostname,
//   24h 单 retention (简化版, 跟 R112 双 sweep 不同).
import * as memberEventlogService from '../services/member-eventlog.js';
// R158.86 (2026-10-12) — member_os_baseline_collector post-hook (公共表 mode,
// 跟 R158.78 member_eventlog_collector 同 precedent). 写 ad_member_os_baseline
// (时序) + ad_member_os_baseline_latest (per-host latest). 1 run = 1 row each.
import * as memberOsBaselineService from '../services/member-os-baseline.js';
import * as partnerPortProbeService from '../services/partner-port-probe.js';
import * as partnerDiscoverService from '../services/partner-discover.js';
import * as replicationStatusProbeService from '../services/replication-status-probe.js';
import * as adminMembersService from '../services/admin-members.js';
// R158.100 (2026-10-13) - member_admin_groups post-hook helper (member-server
//   local admin group membership, 1:1 平行 adminMembersService 但用 hostname
//   替 domainDn). SCOPE_OVERRIDE 挂 'agent_type:non-ad' (R158.86.5 强 invariant).
import * as memberAdminGroupsService from '../services/member-admin-groups.js';
// R158.72 (2026-10-11) — ad_account_change ETL service (公共表 pattern).
import * as accountChangeService from '../services/account-change.js';
import * as failedLogonService from '../services/failed-logon.js';
// R158.X.99.21.c (2026-10-18) — 闭合 trigger-queue.js:155 markTriggerConsumed
//   死代码. 1:1 平行 R158.47.3 status 字段, 0 schema / 0 wire / 0 endpoint
//   / 0 agent change. trigger once 60s 重复跑真因 = 中心端 mark 永远不调
//   → agent 60s heartbeat 后 1min dedup 窗口外必重拉 → 重复跑 30min 内 N
//   次. 修: 中心端 POST /api/agent/packages/report 收 run 后 best-effort
//   fire-and-forget mark 1 行 audit row (real agent_id, status='consumed-
//   trigger'), 下次 heartbeat claim 命中 NOT EXISTS dedup → 0 重拉.
import { markTriggerConsumed } from '../services/trigger-queue.js';

const STDOUT_PREVIEW_LIMIT = 2048;
const STDERR_PREVIEW_LIMIT = 2048;
// R157.9 — pre-stringify cap on run.metrics (code review M13).
// Pre-fix, the centre did `JSON.stringify(run.metrics).slice(2048)` — the
// full stringify ran before the slice, so a single 9MB metrics blob
// burned ~hundreds of ms on a single-threaded Node main loop, blocking
// all heartbeats / inbound / outbound paths. Cap at 256KB raw before
// the stringify. 256KB is far above any legitimate collect.ps1 metrics
// payload (largest observed is ad_os_baseline disks array ~30KB) so
// this trims only malformed / malicious payloads.
const METRICS_PREVIEW_LIMIT = 256 * 1024;

// R158.86.5.1 (2026-10-12) — member_* 包 hostname 是 member server
//   的, 跟 ad_member_servers.hostname 对齐. AD agent 误报 member_*
//   时 hostname 不在 member 表, 提前拒, 不进 FK INSERT 阶段. 简单
//   SELECT 1 cache 在 module-level Map (包级), 避免每 run 跑 query.
//   cache TTL 5 min — ad_member_servers 注册新 member 5 min 内 ship
//   不会跑 member 包, 不可逆. 5 min 跟 centre 端 retention loop
//   周期平行, 安全.
// R158.86.6 后续: agent 端发 ?agentType= 后, AD agent 自己不收
//   member_*, 不再误报. 此 cache + check 可删.
const _memberHostnameCache = new Map();  // hostname → { isMember, expiresAt }
const MEMBER_HOSTNAME_CACHE_TTL_MS = 5 * 60 * 1000;
async function isMemberHostname(db, hostname) {
  if (!hostname) return false;
  const cached = _memberHostnameCache.get(hostname);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.isMember;
  try {
    const { rows } = await db.execute(
      `SELECT 1 AS hit FROM ad_member_servers WHERE hostname = ?`,
      [hostname]
    );
    const isMember = !!(rows && rows[0] && rows[0].hit);
    _memberHostnameCache.set(hostname, { isMember, expiresAt: now + MEMBER_HOSTNAME_CACHE_TTL_MS });
    return isMember;
  } catch (e) {
    // query 失败 fail-open (让原 FK INSERT 拒, 不 double reject)
    return true;
  }
}

// R158.87.6.4 (2026-10-12) — 双层防御 L1 用, 跟 isMemberHostname 1:1
//   平行但 fail-CLOSED. 真因: L1 server 端强制决策包 agentType 必须
//   知道 hostname 是不是 member. 拿 AD agent 当 member = 强制 non-ad
//   = 错拿 2 包 (轻); 拿 member 当 AD = 拿 11 AD 包 (重, operator 已报).
//   fail-closed 返 false (不强制) → AD agent 走 query 兜底, member
//   即使失败也不会错拉 AD 包. 5 min cache TTL 跟 isMemberHostname 同.
async function isMemberHostnameFailClosed(db, hostname) {
  if (!hostname) return false;
  const cached = _memberHostnameCache.get(hostname);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.isMember;
  try {
    const { rows } = await db.execute(
      `SELECT 1 AS hit FROM ad_member_servers WHERE hostname = ?`,
      [hostname]
    );
    const isMember = !!(rows && rows[0] && rows[0].hit);
    _memberHostnameCache.set(hostname, { isMember, expiresAt: now + MEMBER_HOSTNAME_CACHE_TTL_MS });
    return isMember;
  } catch (e) {
    // R158.87.6.4 — fail-CLOSED: 不强制 non-ad, 让 AD agent 走 query
    // 兜底, 防止 AD agent 错拿 non-ad 包. member-server 即使 query
    // 失败也只是走 query 兜底 (legacy null = 全返), 而不是错拉 AD
    // 包 — 但 member-server 永不会发 ?agentType=ad, 仍可能拿全包.
    // L2 agent 端 syncFromCenter ?agentType= 才是真修.
    return false;
  }
}

/**
 * R157.9 — stringify-safe metrics preview. Pre-stringifies a structured
 * metrics blob, but caps the input first via JSON.stringify of the raw
 * value with a truncation guard so a malicious 9MB blob cannot block
 * the Node event loop. Returns the standard STDOUT_PREVIEW_LIMIT-byte
 * preview with a `[truncated]` suffix when the input exceeded the cap.
 *
 * The cap is enforced in two layers:
 *   1. JSON.stringify on the raw value — if that throws, return '[bad metrics]'
 *   2. if the stringified length exceeds METRICS_PREVIEW_LIMIT, slice it
 *      to that limit + append '[truncated]' so downstream readers can
 *      detect a malformed payload.
 */
function truncateMetrics(metrics, cap) {
  let str;
  try {
    str = JSON.stringify(metrics);
  } catch (e) {
    return '[bad metrics: stringify failed]';
  }
  if (typeof str !== 'string') return '[bad metrics: not stringifiable]';
  if (str.length > cap) {
    return str.slice(0, cap) + '...[truncated]';
  }
  return str.slice(0, STDOUT_PREVIEW_LIMIT);
}

// JOIN both tables. The agent only sees packages where policies.enabled = 1.
// The `?` placeholder is dialect-agnostic — the MSSQL driver wrapper
// rewrites it to @p1...@pn at execute() time. ORDER BY s.name keeps the
// wire shape stable across both drivers.
//
// 2026-09-29 P3-1 (G7) — pagination support. The agent (syncFromCenter)
// reads EVERY enabled package on every sync, including the script body
// (base64 of up-to-several-KB PowerShell). At 50+ packages the
// envelope can balloon to ~500KB per call. We add a default cap of
// 200 (covers current installs with headroom) and let agents opt
// into larger windows via `?limit=N`. limit=0 disables the cap and
// keeps the legacy full-list behaviour for any agent that hasn't
// adopted the query string.
//
// The `?` placeholder pattern is dialect-portable via the mssql
// driver wrapper at db.execute() time (same as the rest of the
// file).
function joinSelect({ limit, agentType } = {}) {
  // limit=0 → explicit no-cap (legacy / opt-in via agent query).
  // limit not provided → default cap of 200 (P3-1's new default).
  // limit > 0 → that value.
  const cap = (typeof limit === 'number' && limit > 0) ? limit : 200;
  // R158.86.5 (2026-10-12) — scope filter 拆细. agentType='ad' or
  // 'non-ad' → only 'global' + 'agent_type:<type>'. agentType omitted
  // → legacy 全返 (兼容老 agent 不传 query).
  // 'all' 显式 → 不 filter (运维/调试用).
  // R158.87.6.2 (2026-10-12) — fix: 上一次 R158.86.5 ship 时 filter 喂
  //   `agentType` 字符串 (e.g. 'ad') 但 DB 存 `agent_type:ad`. 0 行命中
  //   = AD agent 0 包可拿 + member-server 0 包可拿 (现状 broken, operator
  //   之前没报因为 member-server 还没正式跑 packages). 修: 喂 `agent_type:<type>`
  //   跟 installScript derive scope 1:1 对称. 'global' 仍对所有 type 可见.
  let scopeFilter = '';
  if (agentType === 'ad' || agentType === 'non-ad') {
    // 双 dialect placeholder 走 `?` (跟 mssql driver wrapper 兼容);
    // params [agentType, agentType] 喂下面 db.execute. 改用 `agent_type:<type>` 跟
    // script-service.js:240-242 installScript derive scope 1:1 对称.
    scopeFilter = ` AND (p.scope = 'global' OR p.scope = ?)`;
  }
  const baseMysql = `SELECT s.name, s.version, s.script_content, s.script_sha256,
    s.manifest_json, s.source, s.created_at, s.updated_at,
    p.interval_sec, p.timeout_ms, p.enabled, p.params_json, p.scope
  FROM package_policies p
  INNER JOIN package_scripts s ON s.name = p.name
  WHERE p.enabled = 1${scopeFilter}
  ORDER BY s.name`;
  // MSSQL needs `TOP N` rather than `LIMIT N`. Picked out the columns +
  // JOIN shape and rewrote the head/tail so the same JOIN runs against
  // both dialects without changing call sites. limit=0 keeps the legacy
  // unlimited shape (preserved for both dialects).
  const baseMssql = `SELECT TOP ${cap} s.name, s.version, s.script_content, s.script_sha256,
    s.manifest_json, s.source, s.created_at, s.updated_at,
    p.interval_sec, p.timeout_ms, p.enabled, p.params_json, p.scope
  FROM package_policies p
  INNER JOIN package_scripts s ON s.name = p.name
  WHERE p.enabled = 1${scopeFilter}
  ORDER BY s.name`;
  if (limit === 0) {
    return { mysql: baseMysql, mssql: `SELECT s.name, s.version, s.script_content, s.script_sha256,
    s.manifest_json, s.source, s.created_at, s.updated_at,
    p.interval_sec, p.timeout_ms, p.enabled, p.params_json, p.scope
  FROM package_policies p
  INNER JOIN package_scripts s ON s.name = p.name
  WHERE p.enabled = 1${scopeFilter}
  ORDER BY s.name` };
  }
  return { mysql: `${baseMysql} LIMIT ${cap}`, mssql: baseMssql };
}

// Legacy alias — kept for any external caller that imports the
// constants directly. The mssql driver wrapper rewrites `?` to
// @p1…@pn at db.execute time, so the legacy alias keeps a single
// LIMIT-free shape (compatible with both dialects' default join).
// New code should call joinSelect() directly to take advantage of
// the P3-1 limit parameter (which now returns per-dialect SQL).
const JOIN_SELECT_MYSQL = joinSelect({ limit: 0 }).mysql;
const JOIN_SELECT_MSSQL = joinSelect({ limit: 0 }).mssql;

// bakeManifest — the single behavior change visible to the agent.
// The agent reads `pkg.manifest.agent.intervalSec` and
// `pkg.manifest.agent.timeoutMs` directly (see
// agent/src/package-manager.js `reschedule` and `runOnce`). The V0
// implementation produced these from the on-disk manifest + the
// `installed_packages` row's interval/timeout columns. R66 splits the
// row into `package_scripts` (manifest only) + `package_policies`
// (interval/timeout/enabled), so we now bake the policy values into the
// manifest here. The agent code does not change.
//
// Defensive (note 2): `baked.agent = baked.agent || {};` so a manifest
// without an `agent` block (custom user upload) still gets the policy
// values baked in, matching V0 behavior.
//
// 2026-09-29 P3-2 (G8) — policy values live under `manifest.agent.policy.*`
// instead of `manifest.agent.intervalSec` / `.timeoutMs`. The original
// names collided with manifest-defined defaults (a future package might
// declare its own agent.intervalSec for backoff hints). Keeping the
// two namespaces separate means:
//   - manifest.agent.intervalSec / .timeoutMs → script-declared defaults
//     (operator-authored, visible to the script via $env:PKG_PARAMS_JSON)
//   - manifest.agent.policy.intervalSec / .timeoutMs → centre-baked
//     from package_policies (DB-authoritative, used by PackageManager)
// The agent's package-manager.js still reads the OLD names — see the
// companion change at agent/src/package-manager.js `reschedule` that
// reads `pkg.manifest?.agent?.policy?.intervalSec`. We keep emitting
// the old names too so any agent that hasn't been updated yet doesn't
// stop scheduling — the field is checked in priority order:
// policy.* (centre-authoritative) → top-level fallback (legacy).
function bakeManifest(row) {
  // JSON.parse the manifest_json column if it's a string; the mysql2
  // driver may auto-parse it to an object on read (json column). The
  // mssql driver returns it as a JSON string. JSON.parse(JSON.stringify(...))
  // is a cheap deep clone so we don't mutate the hydrated row in place.
  const manifest = typeof row.manifest_json === 'string'
    ? JSON.parse(row.manifest_json)
    : row.manifest_json;
  const baked = JSON.parse(JSON.stringify(manifest));
  baked.agent = baked.agent || {};
  baked.agent.policy = baked.agent.policy || {};
  baked.agent.policy.intervalSec = Number(row.interval_sec);
  baked.agent.policy.timeoutMs = Number(row.timeout_ms);
  // Legacy aliases — see the function-level comment above for the
  // priority order. Removed in a future round once all agents have
  // adopted the new namespace.
  baked.agent.intervalSec = baked.agent.policy.intervalSec;
  baked.agent.timeoutMs = baked.agent.policy.timeoutMs;
  return baked;
}

// hydrateJoinRow — convert a raw JOIN row into the V0 agent envelope.
// All driver-specific quirks (mysql2 auto-parse, mssql JSON string)
// are normalized here so the rest of the runner deals with the same
// shape regardless of dialect.
//
// 2026-09-29 P0-1 (G3) — surface `scriptSha256` so the agent can
// verify the base64-decoded script bytes against the DB-stored hash
// before writing collect.ps1 to disk. Without this the agent has no
// way to detect a base64 drift between the wire envelope and the
// authoritative server-side hash. The column is mandatory on the
// package_scripts table (UPSERT writes it as part of the same
// statement as script_content), so it's always populated for any
// row that JOINs against an enabled policy.
function hydrateJoinRow(row) {
  const parseJson = (v) => v == null ? null
    : (typeof v === 'string' ? JSON.parse(v) : v);
  return {
    name: row.name,
    version: row.version,
    script: Buffer.from(row.script_content, 'utf8').toString('base64'),
    scriptSha256: row.script_sha256,
    manifest: bakeManifest(row),
    params: parseJson(row.params_json)
  };
}

// packageRunner — Express router factory. The caller wires the
// agent-token middleware (this factory does not build it internally any
// more — the V0 inline build coupled the runner to `config.agentToken`,
// which silently 503'd when the bundle lived in DB only).
//
// Required deps:
//   db       — db facade (must expose execute(query, params) → {rows})
//   agentMw  — pre-built agentToken middleware thunk
//   getLogger — () => pino-like logger (info/warn/error/debug) or null
//
// Optional: config (no longer read by the runner itself — kept out of
// the signature for clarity; the caller is free to ignore it).
//
// 2026-09-27 R121 — the three handlers (list / getScript / postReport)
// are also exported as named functions so the report-port mount
// (agent.js mount='report') can register the SAME handler against
// /api/agent/packages*, without duplicating the SQL, bakeManifest, or
// ETL post-hooks (ad_lockout_list / ad_dc_overview / ad_eventlog_collector).
// The web-port registration below remains for any agent that targets
// 8080 (e.g. legacy / custom clients), but the canonical R121 surface
// for DC agents is on report-port 8082 — that's where DC agent's
// PackageManager sends its GET (and where the resulting script fetch +
// POST /report land). Without this, DC agents hit "Cannot GET
// /api/agent/packages" because reportApp doesn't have the endpoint.
//
// 2026-09-29 P1-3 (G6) — the dual-mount registration (webApp 8080 +
// reportApp 8082) is now driven by `registerPackageRoutes(router, ...)`
// which is the SINGLE source of truth for path + handler binding.
// `packageRunner` (below) is now a thin shim that creates a Router
// and forwards to the registrar — preserving the existing import
// surface for web-port callers that already build their own Router
// elsewhere. Report-port callers (agent.js) should now call
// `registerPackageRoutes(reportRouter, deps)` directly so a future
// regression that drops one of the two mounts is impossible by
// construction: the registrar is the only path registration.
export function registerPackageRoutes(router, { db, agentMw, getLogger }) {
  // GET /api/agent/packages — list of enabled packages with base64 script.
  // The JOIN filters on policies.enabled = 1 so the agent never sees a
  // disabled package. ORDER BY s.name gives a stable wire shape.
  router.get('/api/agent/packages', agentMw, listEnabledPackages({ db, getLogger }));

  // GET /api/agent/packages/:name/script — fetch the script for a single
  // enabled package. Two SELECTs (note 3): single-name lookups are rare
  // and the policy `enabled` check is a single-row filter, so two simple
  // SELECTs are clearer than a one-off JOIN. Returns 404 when the
  // script row is missing, the policy row is missing, OR the policy
  // row is disabled — the agent must not be able to fetch a script
  // for a disabled package.
  router.get('/api/agent/packages/:name/script', agentMw, getPackageScript({ db, getLogger }));

  // POST /api/agent/packages/report — agent posts an array of run results.
  // Each `run` becomes one package_runs row, and the embedded `metrics`
  // payload flows through the metricstore so gauge / counter / timeseries /
  // status tables are updated.
  router.post('/api/agent/packages/report', agentMw, postPackageReport({ db, getLogger }));

  return router;
}

export function packageRunner({ db, agentMw, getLogger }) {
  return registerPackageRoutes(express.Router(), { db, agentMw, getLogger });
}

// ---------------------------------------------------------------------------
// Exported handlers — R121 surface. The agent.js router imports these and
// registers them against /api/agent/packages* on the REPORT mount (8082).
// Closure captures { db, getLogger } so the per-route shape is identical to
// the web mount (8080), and SQL/ETL stays in one place.
// ---------------------------------------------------------------------------

// listEnabledPackages — GET /api/agent/packages. Returns { packages: [...] }.
// JOIN filters on policies.enabled = 1; ORDER BY s.name keeps the wire shape
// stable across both drivers. R121 — body identical to V0 runner, callers
// across mount='report' (8082) and mount='web' (8080) see the same envelope.
//
// 2026-09-29 P3-1 (G7) — pagination. Query `limit` defaults to 200; pass
// `limit=0` for an unbounded result (legacy behaviour). limit > 200 is
// accepted but logged at warn — large bundles hammer the network without
// much operational gain, and an operator should consider splitting the
// policy set.
export function listEnabledPackages({ db, getLogger }) {
  return async (req, res) => {
    try {
      const rawLimit = req.query?.limit;
      let limit;
      if (rawLimit === undefined || rawLimit === null || rawLimit === '') {
        limit = 200;
      } else {
        const n = Number(rawLimit);
        if (!Number.isFinite(n) || n < 0) {
          return res.status(400).json({ error: 'limit must be a non-negative integer' });
        }
        limit = Math.floor(n);
      }
      if (limit > 200 && getLogger) {
        getLogger().warn?.({ limit }, 'agent packages list: limit > 200 — consider splitting policies');
      }
      // R158.86.5 (2026-10-12) — ?agentType= scope filter. agent 端
      // 发 'ad'/'non-ad'/'all' (或省略 = legacy 全返). 不传 = 老 agent
      // 行为不变. enum 校验跟 limit query 平行.
      //
      // R158.87.6.4 (2026-10-12) — 双层防御 L1 (server 端强制):
      //   真因: R158.86.5 dormant bug 修了后 (R158.87.6.2), AD agent 跟
      //   member-server 调端点拿包理论正确. 但 agent 端 syncFromCenter
      //   (package-manager.js:125) 不发 ?agentType= 老 AD 端点会走
      //   legacy null = 全返 13 包. member-server agent 没设 ?agentType=
      //   → server 端不判 type → 拉 AD 的 11 包. 真因 = server 端依赖
      //   query param 是不安全的.
      //   修: server 端按 token-bound hostname 强制决策.
      //     1. 拿 hostname: req._agentIdentityBound.hostname (signed) →
      //        x-agent-hostname header (grace window fallback) → query
      //        .hostname (legacy AD agent 兼容).
      //     2. 查 ad_member_servers.hostname (R158.78 域), 命中 = 强制
      //        agentType='non-ad', query param 失效. 100% 防 member-server
      //        拉 AD 包.
      //     3. 不命中 (R158.87.6.5 升级) = AD agent, **默认 'ad' 兜底**,
      //        不依赖 query param. AD agent 即使不传 ?agentType= 也只拿
      //        11 AD 包, 不再错拿 2 member_*. query param 仍接受 (AD agent
      //        可显式拿 member 包 测试用), 但默认走 ad.
      //     4. boundHostname 缺失 (老 agent 没发 hostname) = 接受 query
      //        param 兼容, 不强制. 0 影响 (现 fleet 全发 hostname).
      //   复用 isMemberHostnameFailClosed (line 98, R158.87.6.4 ship).
      //   L2 (agent 端 syncFromCenter URL 加 ?agentType=) R158.87.6.5
      //   同步 ship 0.1.4→0.1.5 真 install (operator 授权, R158.56c
      //   directive 解除).
      const boundHostname = String(
        (req._agentIdentityBound && req._agentIdentityBound.hostname)
        || req.headers?.['x-agent-hostname']
        || req.query?.hostname
        || ''
      ).trim();
      let agentType = null;
      if (boundHostname) {
        // member-server 强制 non-ad, query param 失效
        const isMember = await isMemberHostnameFailClosed(db, boundHostname);
        if (isMember) {
          agentType = 'non-ad';
        } else {
          // R158.87.6.5 — AD agent 默认 'ad' 兜底, 不依赖 query param.
          // 改前 R158.87.6.4 漏了 AD 端, AD agent 走 query null = 全返 13
          // 包 (含 2 member_*), AD agent 实际跑了 24h 1468 行 member 包.
          // 修后: AD agent hostname 命中但不命中 member → 'ad' 兜底 → 11 包.
          agentType = 'ad';
        }
      } else {
        // 老 agent 没发 hostname: 接受 query param 兼容
        const rawAgentType = req.query?.agentType;
        if (rawAgentType !== undefined && rawAgentType !== null && rawAgentType !== '') {
          const v = String(rawAgentType).toLowerCase();
          if (v !== 'ad' && v !== 'non-ad' && v !== 'all') {
            return res.status(400).json({ error: 'agentType must be one of ad|non-ad|all' });
          }
          agentType = v === 'all' ? null : v;
        }
      }
      const sqlPair = joinSelect({ limit, agentType });
      // R154.5 — MSSQL needs `TOP N`; MySQL keeps `LIMIT N`. Picking the
      // dialect-specific string here stops the centre from emitting
      // `Incorrect syntax near 'LIMIT'` on every /api/agent/packages
      // sync, which was forcing every agent to run its locally-cached
      // script (no sync = no version upgrade).
      const sql = db.dialect === 'mssql' ? sqlPair.mssql : sqlPair.mysql;
      // scope filter 用 1 个 `?` placeholder 喂 params (mssql driver wrapper
      // 改写为 @p1). agentType=null 不 filter 时 params 空.
      // R158.87.6.2 (2026-10-12) — fix: 喂 `agent_type:<type>` 跟 installScript
      //   derive scope 1:1 对称. 之前 R158.86.5 ship 时喂 raw agentType 字符串
      //   (e.g. 'ad') 但 DB 存 'agent_type:ad' = 0 行命中 = AD/member agent
      //   0 包可拿. 现状 broken, operator 之前没报因为 member-server 还没
      //   正式跑 packages (R158.72 ad_account_change 之后才用).
      const params = (agentType === 'ad' || agentType === 'non-ad') ? [`agent_type:${agentType}`] : [];
      const { rows } = await db.execute(sql, params);
      const packages = rows.map(hydrateJoinRow);
      res.json({ packages });
    } catch (e) {
      const log = getLogger ? getLogger() : null;
      if (log) log.error({ err: e }, 'agent packages list failed');
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
    }
  };
}

// getPackageScript — GET /api/agent/packages/:name/script. 404 when script
// row missing, policy row missing, or policy disabled. The agent must NOT
// be able to fetch a script for a disabled package.
export function getPackageScript({ db, getLogger }) {
  return async (req, res) => {
    try {
      const scriptRow = await packageScripts.get(db, req.params.name);
      const policyRow = await packagePolicies.getByName(db, req.params.name);
      // `packagePolicies.getByName` hydrates `enabled` to a boolean (see
      // package-policies.js hydrate()). `!policyRow.enabled` works for
      // both the boolean (true/false) shape and the raw 1/0 (if the
      // helper ever changes its hydrate contract).
      if (!scriptRow || !policyRow || !policyRow.enabled) {
        return res.status(404).json({ error: 'not found' });
      }
      // Note 1 — `packageScripts.get()` returns `scriptContent`
      // (camelCase) per the hydrate at package-scripts.js:97. Do NOT
      // read `script_content` from the helper's output.
      // 2026-09-29 P0-1 (G3) — also surface scriptSha256 so the
      // single-package fetch path can verify on disk write.
      const scriptB64 = Buffer.from(scriptRow.scriptContent, 'utf8').toString('base64');
      res.json({
        name: scriptRow.name,
        version: scriptRow.version,
        script: scriptB64,
        scriptSha256: scriptRow.scriptSha256
      });
    } catch (e) {
      const log = getLogger ? getLogger() : null;
      if (log) log.error({ err: e }, 'agent package script fetch failed');
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
    }
  };
}

// postPackageReport — POST /api/agent/packages/report. agentId comes from
// x-agent-id (agent-token middleware does not stamp req.agentId). Each run
// becomes one package_runs row, and the embedded metrics payload flows
// through metricstore so gauge / counter / timeseries / status tables are
// updated. R107.1 / R110.A / R112 post-hooks (ad_lockout_list,
// ad_dc_overview, ad_eventlog_collector) all run here, so removing the
// duplicate at the runner level does NOT lose any ETL behaviour.
//
// R157.2 (2026-09-30) — per-agent FIFO + bounded cross-agent concurrency.
// Background: the agent's flushReportQueue (R157.1) now ships runs in 50-row
// chunks, but a single envelope can still carry 1000+ runs when an agent is
// replaying its disk queue after a long offline period. Even with R157.1's
// 60s dedup fingerprint absorbing most of the replay, the FIRST envelope
// after restart can drive 1000+ sequential INSERT + ETL calls, holding a
// single MSSQL pool connection for ~30 s. With 34 agents each potentially
// doing the same in parallel, the pool mssql + mysql exhausts and the
// centre tips into the 4 GB OOM loop.
//
// To bound this, the handler now sits behind a queue:
//   - The agent's runs[] array is still processed SERIALLY inside a single
//     envelope (we can't — the metricstore+ETL hooks assume single-run order).
//   - Multiple envelopes from the SAME agentId are STRICTLY serialised
//     (FIFO): the agent's in-flight envelope must finish before the next
//     one starts. This kills the agent-side reorder race and bounds per-
//     agent DB pressure to one pool connection at a time.
//   - Envelopes from DIFFERENT agents can run concurrently up to
//     MAX_CROSS_AGENT_CONCURRENCY (3). 3 × ~30s envelope time-slot =
//     worst-case ~90s end-to-end, well under centre's restart tolerance.
//
// Implementation: chain-of-promises pattern. Each envelope acquires a
// concurrency slot, then awaits the previous envelope from the SAME agent
// (tracked via tails.get(agentId)), then processes, then releases its slot.
// Order is determined synchronously at entry (the JS event loop's atomicity
// is sufficient because Node.js is single-threaded between awaits).
export function postPackageReport({ db, getLogger }) {
  // Per-agent FIFO tail chain: agentId -> Promise that resolves when the
  // most recent envelope from that agent finishes processing.
  const tails = new Map();
  // Cross-agent concurrency gate (mirrors the architecture used in
  // dc-partners-refresh.js for its bounded-concurrency UPSERT sweep).
  let activeAgents = 0;
  const waiters = []; // FIFO of resolve fns awaiting a free slot
  const MAX_CROSS_AGENT_CONCURRENCY = 3;
  // R157.9 — per-agent 413 throttle counter (code review M11). Maps
  // agentId → { windowStartMs, count }. Window is 60s; after 5 hits
  // inside the window we escalate to 503 + Retry-After: 30 so a
  // runaway agent backs off instead of hammering. Map is bounded by
  // the live agent count (~34), no eviction needed — entries
  // naturally expire on the next window reset.
  const agent413Counters = new Map();
  // R157.3 — per-envelope size cap. Picked 200 as a balance: a single
  // agent's queue is bounded by 1 in-flight envelope (FIFO chain) + the
  // 200-row envelope itself = ~200 rows in flight per agent worst case;
  // across 34 agents × MAX_CROSS_AGENT_CONCURRENCY=3 envelopes = ~200
  // × 3 = 600 rows in flight centre-wide, well below the MSSQL pool's
  // effective capacity (~25 connections × concurrent enqueue). Larger
  // caps (500, 1000) re-introduce the same heap-pressure problem that
  // motivated R157.2; smaller caps (50, 100) work but generate more
  // HTTP round-trips. 200 was selected so that a single agent can clear
  // its accumulated replay backlog in 1-2 envelopes rather than 5-10.
  const MAX_ENVELOPE_RUNS = 5000;

  function acquireSlot() {
    if (activeAgents < MAX_CROSS_AGENT_CONCURRENCY) {
      activeAgents++;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiters.push(resolve));
  }

  function releaseSlot() {
    const next = waiters.shift();
    if (next) {
      // Hand the slot to the next waiter; activeAgents does NOT decrement
      // (the waiter is essentially "promoted" to active immediately).
      next();
    } else {
      activeAgents--;
    }
  }

  async function enqueueForAgent(agentId, runs, log) {
    await acquireSlot();
    // Build our tracking promise BEFORE awaiting the prev tail, so the next
    // envelope that arrives for this agent sees US as its predecessor.
    let resolveTracking, rejectTracking;
    const trackingPromise = new Promise((res, rej) => {
      resolveTracking = res;
      rejectTracking = rej;
    });
    // FIFO chain: prev is the most recent envelope from the same agent
    // (resolved once it has finished processing). Set tails BEFORE awaiting
    // so a later envelope that arrives while we're awaiting our prev still
    // chains behind us, not behind our prev.
    const prev = tails.get(agentId) || Promise.resolve();
    tails.set(agentId, trackingPromise);
    try {
      try { await prev; } catch { /* swallow prev envelope errors */ }
      return await processEnvelopeInner(runs, agentId, log);
    } finally {
      resolveTracking();
      releaseSlot();
    }
  }

  async function processEnvelopeInner(runs, agentId, log) {
    const result = { processed: 0, errors: [], deduplicated: 0 };
    for (const run of runs) {
      // R158.52 — fault-tolerance guard. A malformed agent envelope may
      // omit `agentId` (the bind param) or `packageName` (the lookup key);
      // without these, the downstream `packageRuns.insert` and
      // `packageScripts.get` calls would bind `undefined`, which the
      // mysql2/mssql drivers reject with a 500 → cascading failure for
      // every other well-formed run in the same envelope. Skip the row
      // with an error entry instead of aborting the loop.
      if (!run || !run.packageName) {
        result.errors.push({
          packageName: run?.packageName ?? null,
          agentId: agentId ?? null,
          error: 'malformed run envelope: missing packageName'
        });
        continue;
      }
      try {
        const scriptRow = await packageScripts.get(db, run.packageName);
        if (!scriptRow) {
          result.errors.push({
            packageName: run.packageName,
            error: 'package not installed'
          });
          continue;
        }
        // R157.1 (2026-09-30) — idempotency guard. Agent's
        // flushReportQueue can replay hundreds of runs from its disk
        // queue after a restart / centre downtime. Without this check,
        // each replay triggers (a) one package_runs INSERT, (b) one
        // metricstore.ingestRun call, and (c) every post-hook branch
        // (ad_dc_overview, ad_partner_ports_probe, ad_partner_inbound_discover
        // ETL, ad_eventlog_collector, etc.). A single envelope carrying
        // 1000+ replay runs therefore caused 1000+ INSERTs + 1000+ ETL
        // calls in one handler — directly attributed to the 4 GB OOM
        // loop (see dashboard-r157-heartbeat-60s.md). The check uses a
        // 60s fingerprint on (agent_id, package_name, started_at) so
        // agent/centre clock skew is absorbed but legitimate re-runs
        // (>60s apart) still land. If a duplicate is detected, we
        // skip INSERT + metricstore + ALL post-hook branches (they
        // already ran on the original run). The counter
        // `result.deduplicated` lets the agent see how many of its
        // reported runs the centre already had, which is also a
        // useful operational signal when an agent is replaying a large
        // back-log after a long offline period.
        const startedAtDate = new Date(run.startedAt);
        if (!isNaN(startedAtDate.getTime())
            && await packageRuns.recentRunExists(db, {
              agentId,
              packageName: run.packageName,
              startedAt: startedAtDate
            })) {
          result.deduplicated++;
          if (log) log.info({
            event: 'agent.packages.deduplicated',
            agentId,
            packageName: run.packageName,
            startedAt: startedAtDate.toISOString()
          }, 'package run already recorded, skipping ingest + post-hooks');
          continue;
        }
        // Record run (always, even on error — this is the audit trail).
        // 2026-09-29 R154.5 — capture scriptRow.version as the historical
        // snapshot of the script the agent actually executed. The centre
        // stores one (name, version) per package; if the operator later
        // publishes a new version, the in-flight / already-collected runs
        // still record what they ran under, not the current centre
        // version. See db/migrations/032-package-runs-script-version.sql.
        //
        // R158.11.2 — also surface the agent-reported scriptSha256 +
        // scriptPath. Pre-fix the centre wrote its own
        // package_scripts.version into package_runs.script_version
        // regardless of what the agent cache actually contained, so a
        // "1.1.1" rollout looked 100% successful in the UI even when
        // half the agents were still running 1.0.0/collect.ps1 fallback
        // copies. With the agent-attached scriptSha256 in hand, the row
        // now lets us grep for sha mismatch between the centre's view
        // (script_version) and the agent cache's reality (script_sha256
        // embedded in stderr_preview). We don't add a new column —
        // pending operator decision on schema; the diagnostic lives in
        // stderr_preview header so existing dashboards/queries keep
        // working.
        const agentScriptSha256 = typeof run.scriptSha256 === 'string' ? run.scriptSha256 : null;
        const agentScriptPath   = typeof run.scriptPath   === 'string' ? run.scriptPath   : null;
        const agentScriptSize   = Number.isFinite(run.scriptSize) ? run.scriptSize : null;
        const scriptBanner = agentScriptSha256
          ? `[R158.11.2 agent_cache] path=${agentScriptPath} sha256=${agentScriptSha256} size=${agentScriptSize}\n`
          : '';
        const stderrForDb = run.stderr
          ? (scriptBanner + run.stderr)
          : (scriptBanner || null);
        // R158.25 (2026-10-02) — capture the new package_runs id so we can
        // UPDATE stderr_preview AFTER all post-hook ETL branches finish.
        // The INSERT here happens BEFORE the metricstore dispatch + 7
        // post-hook arms (lockout / dc_overview / partner_ports_probe
        // inbound + outbound / partner_discover / replication_status_probe
        // / eventlog events + summaries). The original stderrForDb
        // only carries the scriptBanner + collect.ps1 stderr, with no
        // ETL outcome — operator's directive: "preview 过程中如果数据
        // 已经写入,记得在上报的内容把过程写入,否则将来想 Debug
        // 也没办法". etlTrace collects one line per post-hook arm so
        // the UPDATE adds `[R158.25 ingest] <linear summary>` to
        // the stderr_preview, so future debugging shows what each
        // post-hook actually did (or failed to do).
        const etlTrace = [];
        const runRowId = await packageRuns.insert(db, {
          agentId,
          packageName: run.packageName,
          startedAt: startedAtDate,
          finishedAt: (() => {
            // R158.52 — defend against malformed ISO strings. `new
            // Date(undefined)` returns Invalid Date, but `new
            // Date('garbage')` also returns Invalid Date; both bind as a
            // STRING by mysql2 → throws "Invalid value for date" at the
            // DB. Require a finite timestamp.
            if (!run.finishedAt) return null;
            const d = new Date(run.finishedAt);
            return Number.isFinite(d.getTime()) ? d : null;
          })(),
          exitCode: run.exitCode ?? null,
          stdoutPreview: run.metrics
            ? // R157.9 — pre-stringify size cap (code review M13).
              // JSON.stringify on a 9MB blob blocks the event loop;
              // truncate the raw input first so the stringify only
              // touches ≤256KB. Falls back to '[truncated]' when the
              // stringify itself fails or produces something longer
              // than the existing 2KB preview cap.
              truncateMetrics(run.metrics, METRICS_PREVIEW_LIMIT)
            : null,
          stderrPreview: stderrForDb ? stderrForDb.slice(0, STDERR_PREVIEW_LIMIT) : null,
          error: run.error ?? null,
          scriptVersion: scriptRow.version ?? null,
          // R158.50.7g (2026-10-08) — supersedes R158.47.3 status logic.
          // Pre-fix this branch treated ANY non-null `run.error` as
          // failed, but R158.50.6 promoted PS1 stderr header lines
          // (e.g. "lockoutEvents failed: 找不到任何与指定的选择条件匹配的事件。")
          // into `run.error` for operator visibility. The PS1 reports
          // exit_code=0 + metrics.error_code=1 because the WinEvent query
          // simply returned 0 events in the 15-min window — a normal,
          // non-fatal state, not a process failure. Pre-fix this caused
          // /packages-runs to render every ad_lockout_list row red
          // (operator feedback 2026-10-08: "弹出的内容默认颜色为绿色,
          // 有问题才是红色, 现在是弹出都是红色").
          //
          // Authoritative decision tree (process exit is truth, error
          // field is hint, metrics.error_code is partial-failure
          // fingerprint — matches R158.50.7b UI convention):
          //   exitCode != 0                                  → 'failed'
          //   exitCode == 0, metrics.error_code > 0         → 'partial'
          //   exitCode == 0, metrics.error_code == 0,
          //                  !run.error                     → 'success'
          //   exitCode == 0, metrics.error_code == 0,
          //                  run.error                       → 'partial'
          //                  (conservative: error field may carry
          //                   a useful diagnostic but process was
          //                   healthy — render as partial so the row
          //                   looks yellow not red)
          //   exitCode == null + finishedAt null             → 'running'
          status: (() => {
            if (run.exitCode != null && run.exitCode !== 0) return 'failed';
            const metricsEc = run.metrics?.error_code;
            if (metricsEc && metricsEc > 0) return 'partial';
            if (run.exitCode === 0) return run.error ? 'partial' : 'success';
            return run.finishedAt ? 'success' : 'running';
          })()
        });
        // R158.X.99.21.c (2026-10-18) — best-effort mark trigger consumed.
        //   fire-and-forget 走 trigger-queue.js:179-181 catch-swallow 范式,
        //   失败仅 warn log, 不挡 8 post-hook 也不挡 agent response. 0 写
        //   await — agent response 等 post-hook 跑完才返, mark 是 async
        //   background. R158.Y 30min DELETE (cron-scheduler.js:354-364)
        //   兜底 mark 失败场景. 0 加 NOT EXISTS guard 跟 fireTriggers
        //   (cron-scheduler.js:320-328) NOT EXISTS 1:1 平行但反向: mark
        //   0 dedup, N agent 并发写 N 行 audit row 0 conflict. 1:1 平行
        //   recentRunExists (package-runs.js:240-279) 双保险 0 conflict
        //   fingerprint scope 互补 (agentId 锚点 + minute window).
        if (startedAtDate) {
          markTriggerConsumed({ agentId, packageName: run.packageName, startedAt: startedAtDate, db }).catch((e) => {
            log?.warn({ err: e?.message, packageName: run.packageName, agentId }, 'R158.X.99.21.c markTriggerConsumed best-effort failed; relying on R158.Y 30min cleanup');
          });
        }
        // R158.52 (2026-10-08) — pre-fix this was `run.metrics && !run.error`,
        // which silently SKIPPED all 9 post-hook ETL arms whenever a PS1
        // emitted a top-level `payload.error`. After R158.52 hardened 7
        // PS1 collectors to emit `payload.error` on soft failure (e.g.
        // ad_dc_overview Get-ADUser timeout, ad_admin_members RSAT not
        // installed), the first soft failure on those packages would write
        // ZERO ETL rows for that run — `ad_dc_overview` / `ad_admin_members`
        // tables would stop refreshing. New contract: if `run.metrics`
        // is non-null, we ALWAYS dispatch, because:
        //   - `error_code` bit > 0  → 'partial' status, partial ETL ok
        //   - `error_code` bit == 0 + `payload.error` set → 'partial' status,
        //     ETL still ok because the partial rows carry the real data
        //     the operator wants to see
        //   - `error_code` bit == 0 + no `payload.error` → 'success', ETL
        // The `!run.error` gate stays valid only as a `process-threw`
        // signal (uncaught exception, missing field) where `run.metrics`
        // would also be null — so the gate collapses to `run.metrics`.
        // Verified with audit 2026-10-08: 7 packages now emit payload.error
        // (ad_dc_overview, ad_admin_members, ad_partner_ports_probe,
        // ad_dc_probe_inbound, ad_os_baseline, ad_partner_inbound_discover,
        // ad_eventlog_collector).
        if (run.metrics) {
          // R130 — log the metricstore dispatch so an ingestRun failure
          // (e.g. wrong manifest shape, DB execute throw) is observable
          // from the centre logs. Pre-fix this branch silently swallowed
          // everything: v1 path with empty `manifest.metrics` was a true
          // no-op, and the v2 path's `await db.execute` errors only
          // surfaced as a generic 500 to the agent. We log the intent
          // (v2 vs v1) here so post-mortem grep on
          // `event:"metricstore.ingest"` tells you exactly which packages
          // are landing rows.
          const isV2 = !!scriptRow.manifest?.database?.metricTable;
          log?.info?.({
            event: 'metricstore.ingest',
            packageName: run.packageName,
            agentId,
            path: isV2 ? 'v2' : 'v1',
            columns: isV2 ? Object.keys(scriptRow.manifest.database.metricSchema || {}) : null
          }, `metricstore ingest dispatch (${isV2 ? 'v2' : 'v1'})`);
          // R134 — metricstore.ingestRun throws on schema-key mismatch,
    // PKG_METRIC_REQUIRED, type-mismatch, and (per round-133 + R134) any
    // JSON-bind failure from a non-string value going into an NVarChar
    // JSON column. Pre-R134 that throw skipped EVERY post-hook branch
    // (ad_lockout_list / ad_dc_overview / ad_partner_ports_probe /
    // ad_eventlog_collector) because the await was inside the same try
    // block, the throw escaped into the per-run catch, and the agent
    // saw `processed:0 errors:[{packageName, error: ...}]`. Now we
    // surface metricstore failures explicitly via result.errors and
    // continue so post-hooks still run when the metricstore row landed
    // (e.g. ad_lockout_list — metricstore fails but the JSON-envelope
    // post-hook can still upsert per-event rows; ad_dc_overview /
    // ad_partner_ports_probe / ad_eventlog_collector don't need
    // metricstore at all, so a metricstore throw must NOT skip them).
          let metricstoreError = null;
          try {
            await metricstore.ingestRun(db, {
              agentId,
              packageName: run.packageName,
              manifest: scriptRow.manifest,
              runs: [run]
            });
          } catch (e) {
            metricstoreError = e;
            log?.error?.({
              event: 'metricstore.ingest.failed',
              packageName: run.packageName,
              agentId,
              err: e?.message || String(e)
            }, 'metricstore ingest failed');
            result.errors.push({
              packageName: run.packageName,
              stage: 'metricstore.ingest',
              error: e?.message || String(e)
            });
          }
          // R107.1 — ad_lockout_list is a v2 package whose metricstore row
          // holds the whole events[] array as a single JSON column. The
          // /api/lockout-events/search route reads the flattened per-event
          // rows in ad_lockout_events, so we need a post-hook to split
          // the array into individual upserts here. Best-effort: a single
          // bad event doesn't fail the whole batch (the metricstore INSERT
          // already succeeded). db.sql.lockout.upsertEvent is dispatched
          // internally on db.dialect (R101 canonical pattern).
          if (run.packageName === 'ad_lockout_list' && Array.isArray(run.metrics.events)) {
            const etl = await lockoutService.upsertEvents(db, run.metrics.events, agentId, log);
            log?.info?.({
              event: 'lockout.etl',
              packageName: run.packageName,
              agentId,
              count: run.metrics.events.length,
              upserted: etl.upserted,
              skipped: etl.skipped,
              errors: etl.errors.length
            }, 'lockout ETL complete');
            // R158.25 — record ETL outcome into stderr_preview traceback.
            etlTrace.push(`lockout.upserted=${etl.upserted}/${run.metrics.events.length} skipped=${etl.skipped} errors=${etl.errors.length}`);
            if (etl.errors.length) {
              result.errors.push({
                packageName: run.packageName,
                error: `lockout ETL ${etl.errors.length} event(s) failed`,
                details: etl.errors.slice(0, 3)
              });
            }
          }
          // R110.A — ad_dc_overview is a "公共表" package: manifest omits
          // the database block so metricstore.ingestRunV2 never runs for
          // it. We must write to ad_dc_overview here. See
          // center/src/services/dc-overview.js. Best-effort (mirrors R107.1
          // lockout post-hook): per-run try/catch, push to result.errors
          // on failure, do NOT fail the whole batch.
          if (run.packageName === 'ad_dc_overview' && run.metrics) {
            const etl = await dcOverviewService.upsertOverviews(db, [run.metrics], agentId, log);
            log?.info?.({
              event: 'dc_overview.etl',
              packageName: run.packageName,
              agentId,
              upserted: etl.upserted,
              skipped: etl.skipped,
              errors: etl.errors.length
            }, 'dc-overview ETL complete');
            // R158.25 — record ETL outcome into stderr_preview traceback.
            etlTrace.push(`dc_overview.upserted=${etl.upserted} skipped=${etl.skipped} errors=${etl.errors.length}`);
            if (etl.errors.length) {
              result.errors.push({
                packageName: run.packageName,
                error: `dc-overview ETL ${etl.errors.length} row(s) failed`,
                details: etl.errors.slice(0, 3)
              });
            }
          }
          // R158.47 (2026-10-06) — operator "提取 domain admins enterprise
          // admins 管理员成员". 跟 ad_dc_overview 同一公共表 pattern:
          // manifest omits `database` block, centre writes via runner.js
          // post-hook. "一台 DC 执行即可" 语义由 MERGE ON (domain_dn,
          // group_name, member_sam) 自动 dedup 实现 (所有 DC 都跑, 中心端
          // collapse 重复 row). Best-effort: a failed ETL does NOT fail the
          // whole /report envelope (mirrors R107.1 + R110.A).
          if (run.packageName === 'ad_admin_members' && run.metrics) {
            const etl = await adminMembersService.upsertMembers(db, run.metrics, agentId, runRowId, log);
            const daCount = Array.isArray(run.metrics?.domain_admins) ? run.metrics.domain_admins.length
                          : Array.isArray(run.metrics?.domainAdmins)  ? run.metrics.domainAdmins.length  : 0;
            const eaCount = Array.isArray(run.metrics?.enterprise_admins) ? run.metrics.enterprise_admins.length
                          : Array.isArray(run.metrics?.enterpriseAdmins)  ? run.metrics.enterpriseAdmins.length  : 0;
            log?.info?.({
              event: 'admin_members.etl',
              packageName: run.packageName,
              agentId,
              runId: runRowId,
              domainAdmins: daCount,
              enterpriseAdmins: eaCount,
              upserted: etl.upserted,
              skipped: etl.skipped,
              errors: etl.errors.length
            }, 'admin-members ETL complete');
            etlTrace.push(`admin_members.upserted=${etl.upserted} skipped=${etl.skipped} errors=${etl.errors.length}`);
            if (etl.errors.length) {
              result.errors.push({
                packageName: run.packageName,
                error: `admin-members ETL ${etl.errors.length} row(s) failed`,
                details: etl.errors.slice(0, 3)
              });
            }
          }
          // R158.72 (2026-10-11) — ad_account_change etl. 跟 ad_admin_members
          //   同公共表 pattern (R110.A): manifest omits `database` block,
          //   中心端 runner.js post-hook 直接 MERGE ad_account_change.
          //   MERGE ON (sam, action, change_date) 自动 dedup 跨 DC + 跨 re-run.
          //   Best-effort: 失败的 ETL 不 fail 整个 /report envelope
          //   (mirrors R107.1 + R110.A + R158.47 admin-members).
          if (run.packageName === 'ad_account_change' && run.metrics) {
            const etl = await accountChangeService.upsertMembers(db, run.metrics, agentId, runRowId, log);
            const entryCount = Array.isArray(run.metrics?.entries) ? run.metrics.entries.length : 0;
            log?.info?.({
              event: 'ad_account_change.etl',
              packageName: run.packageName,
              agentId,
              runId: runRowId,
              entries: entryCount,
              upserted: etl.upserted,
              skipped: etl.skipped,
              errors: etl.errors.length
            }, 'account-change ETL complete');
            etlTrace.push(`ad_account_change.upserted=${etl.upserted} skipped=${etl.skipped} errors=${etl.errors.length}`);
            if (etl.errors.length) {
              result.errors.push({
                packageName: run.packageName,
                error: `ad_account_change ETL ${etl.errors.length} row(s) failed`,
                details: etl.errors.slice(0, 3)
              });
            }
          }
          // R125 → R151.2 — ad_partner_ports_probe is a "公共表" package
          // (same architectural pivot as R110.A's ad_dc_overview):
          // manifest omits the `database` block so metricstore.ingestRunV2
          // never runs for it. The package surface TWO endpoints
          // (routes/agent.js):
          //   GET /api/agent/ports                  — configured port list
          //   GET /api/agent/inbound-partners       — partner DC list
          //   (was /api/agent/replication-partners until R151.2 2026-09-29,
          //    renamed + flipped to inbound view to align with R144)
          // collect.ps1 calls both and probes each (peer × port) via
          // TcpClient.BeginConnect. The wire shape `run.metrics.peers`
          // is an array of `{ destDc, ports: [{port, ok, latency}] }`
          // entries — one element per unique partner DC.
          //
          // We write each entry as one ad_replication_status row keyed
          // on naming_context `__partner_ports__:<sha256[0..8]>` (per
          // (agentId, peerDc) tuple — same hash as the mock at
          // center/mock-snapshot.mjs:762-769). The existing
          // /api/dashboard/partner-port-health/all query
          // (routes/dashboard.js:687) reads
          // `naming_context LIKE '__partner_ports__:%'` so it picks
          // the new rows up without any SQL / frontend changes.
          //
          // Best-effort (mirrors R107.1 lockout + R110.A dc-overview):
          // per-run try/catch, push to result.errors on failure, do NOT
          // fail the whole /report envelope.
          if (run.packageName === 'ad_dc_probe_inbound' && Array.isArray(run.metrics?.peers)) {
            const etl = await partnerPortProbeService.upsertPartnerProbes(db, run.metrics.peers, agentId, log);
            log?.info?.({
              event: 'partner_ports_probe.etl',
              packageName: run.packageName,
              agentId,
              count: run.metrics.peers.length,
              upserted: etl.upserted,
              skipped: etl.skipped,
              errors: etl.errors.length
            }, 'partner_ports_probe ETL complete');
            // R158.25 — record ETL outcome into stderr_preview traceback.
            etlTrace.push(`partner_ports_probe_inbound.upserted=${etl.upserted}/${run.metrics.peers.length} skipped=${etl.skipped} errors=${etl.errors.length}`);
            // R132 — `errors` now includes both real ETL failures AND
            // skipped rows (missing peer_dc). Surface both to the agent
            // so a silent skip (`count:1 upserted:0 skipped:1 errors:0`)
            // never happens again — see partner-port-probe.js:197.
            if (etl.errors.length) {
              result.errors.push({
                packageName: run.packageName,
                error: `partner_ports_probe ETL ${etl.errors.length} row(s) failed/skipped`,
                details: etl.errors.slice(0, 3)
              });
            }
          }
          // R158.X.116.d (2026-10-22) — 删 ad_dc_probe_outbound 的 ETL 分支
          //   (R155.4 引入)。表已 DROP、helper 已删 (partner-port-probe.js),
          //   SQL helper 两侧皆删 (sql.js)。门控永不为真: package_scripts 里
          //   该包名 0 行 → 上方 packageScripts.get 前置门直接 continue。
          //   注意 partnerPortProbeService 的 import 仍需保留 ——
          //   ad_dc_probe_inbound 分支 (上方) 还在用 upsertPartnerProbes。
          // R156 — partner-discover post-hook arm. Discovers agent
          // reports the DC topology (no port probing) with ad_dcs as
          // authoritative source-of-truth. Write-time validation:
          //   - agent_id not in ad_dcs  → drop entire batch + log.warn
          //   - peerDc not in ad_dcs     → silent skip + log.debug
          //                                  (NOT pushed to result.errors;
          //                                   topology drift ≠ bad payload)
          //   - real upsert errors       → push to result.errors (DB
          //                                  failures still surface)
          // Cadence is 30 days via centre cron-scheduler; the manifest
          // intervalSec is the same as a defence in depth. See
          // src/services/partner-discover.js for the full rationale.
          // R158.10 (2026-10-01) — ad_partner_outbound_discover 包下线,
          //   只剩 inbound 一条路径。
          if (run.packageName === 'ad_partner_inbound_discover'
              && Array.isArray(run.metrics?.peers)) {
            const etl = await partnerDiscoverService.upsertDiscovers(
              db, run.packageName, agentId, run.metrics.peers, log);
            log?.info?.({
              event: 'partner_discover.etl',
              packageName: run.packageName,
              agentId,
              peerCount: run.metrics.peers.length,
              upserted: etl.upserted,
              skipped_not_in_ad_dcs: etl.skipped_not_in_ad_dcs,
              dropped_agent_not_in_ad_dcs: etl.dropped_agent_not_in_ad_dcs,
              errors: etl.errors.length
            }, 'partner_discover ETL complete');
            // R158.25 — record ETL outcome into stderr_preview traceback.
            etlTrace.push(`partner_discover.upserted=${etl.upserted}/${run.metrics.peers.length} skipped_not_in_ad_dcs=${etl.skipped_not_in_ad_dcs} dropped_agent=${etl.dropped_agent_not_in_ad_dcs} errors=${etl.errors.length}`);
            // Only real DB errors surface to the agent — silent skips
            // stay silent (operator directive 2026-09-30).
            // R157.9 — also surface the "entire batch dropped because
            // agentId not in ad_dcs" case (code review M10). Pre-fix,
            // an agent whose hostname was just decommissioned but
            // whose bundle still pushed runs every 5min for hours
            // saw processed:N errors:[] — looked healthy but was a
            // no-op. Post-fix, the agent gets a single soft-warn
            // entry in errors[] with reason='agent_not_in_ad_dcs'
            // so its runner knows to stop the discover cycle.
            if (etl.dropped_agent_not_in_ad_dcs) {
              result.errors.push({
                packageName: run.packageName,
                error: 'partner_discover batch dropped: agent not in ad_dcs',
                details: [{
                  reason: 'agent_not_in_ad_dcs',
                  agentId,
                  skipped_peer_count: etl.skipped_not_in_ad_dcs
                }]
              });
            }
            if (etl.errors.length) {
              result.errors.push({
                packageName: run.packageName,
                error: `partner_discover ETL ${etl.errors.length} row(s) failed`,
                details: etl.errors.slice(0, 3)
              });
            }
          }
          // R158.15 (2026-10-01) -- ad_replication_status_probe post-hook
          // arm. Public-table contract: manifest omits the `database` block
          // so metricstore.ingestRunV2 never runs; we must write directly
          // to ad_replication_probe_history here.
          // Wire shape: run.metrics.probes[] -- each entry is one
          // (peer, naming_context) probe result. Append-only INSERT.
          // Write-time validation mirrors partner-discover (R157.4):
          //   - agent_id not in ad_dcs  -> drop entire batch + push to
          //                                  result.errors with
          //                                  reason='agent_not_in_ad_dcs'
          //                                  so agent can self-suspend
          //   - peerDc not in ad_dcs    -> silent skip (NOT in errors;
          //                                  topology drift != bad payload)
          //   - real INSERT errors      -> push per-row failures to
          //                                  result.errors (DB issues
          //                                  still surface to agent).
          // Cadence is 15min (manifest.agent.intervalSec=900). No centre
          // cron for this package -- agent interval alone drives the
          // cadence (mirrors ad_dc_probe_inbound pattern).
          if (run.packageName === 'ad_replication_status_probe'
              && Array.isArray(run.metrics?.probes)) {
            const etl = await replicationStatusProbeService.upsertProbes(
              db, run.metrics.probes, agentId, log);
            log?.info?.({
              event: 'replication_status_probe.etl',
              packageName: run.packageName,
              agentId,
              probeCount: run.metrics.probes.length,
              upserted: etl.upserted,
              skipped_not_in_ad_dcs: etl.skipped_not_in_ad_dcs,
              dropped_agent_not_in_ad_dcs: etl.dropped_agent_not_in_ad_dcs,
              errors: etl.errors.length
            }, 'replication_status_probe ETL complete');
            // R158.25 — record ETL outcome into stderr_preview traceback.
            etlTrace.push(`replication_status_probe.upserted=${etl.upserted}/${run.metrics.probes.length} skipped_not_in_ad_dcs=${etl.skipped_not_in_ad_dcs} dropped_agent=${etl.dropped_agent_not_in_ad_dcs} errors=${etl.errors.length}`);
            // Mirror R157.9 partner-discover M10 fix: surface the
            // "entire batch dropped because agentId not in ad_dcs"
            // case to the agent so it can self-suspend.
            if (etl.dropped_agent_not_in_ad_dcs) {
              result.errors.push({
                packageName: run.packageName,
                error: 'replication_status_probe batch dropped: agent not in ad_dcs',
                details: [{
                  reason: 'agent_not_in_ad_dcs',
                  agentId,
                  skipped_probe_count: etl.skipped_not_in_ad_dcs
                }]
              });
            }
            if (etl.errors.length) {
              result.errors.push({
                packageName: run.packageName,
                error: `replication_status_probe ETL ${etl.errors.length} row(s) failed`,
                details: etl.errors.slice(0, 3)
              });
            }
          }
          // R158.50 (2026-10-06) — ad_failed_logon_collector post-hook arm.
          // Public-table contract (mirrors R110.A / R112 / R158.47):
          // manifest omits `database` block so metricstore.ingestRunV2
          // never runs for it. We must write directly to
          // ad_failed_logon_events here. See
          // center/src/services/failed-logon.js. Wire shape carries
          // run.metrics.events[] (per-event 4625 rows). Best-effort
          // (mirrors R107.1 + R110.A + R112): per-run try/catch, push
          // to result.errors on failure, do NOT fail the whole /report
          // envelope. Cadence is 2h (intervalSec=7200).
          if (run.packageName === 'ad_failed_logon_collector' && run.metrics) {
            const events = Array.isArray(run.metrics.events) ? run.metrics.events : [];
            const etl = await failedLogonService.upsertEvents(db, events, agentId, log);
            log?.info?.({
              event: 'failed_logon.etl',
              packageName: run.packageName,
              agentId,
              runId: run.id,
              count: events.length,
              upserted: etl.upserted,
              skipped: etl.skipped,
              errors: etl.errors.length
            }, 'failed-logon ETL complete');
            etlTrace.push(`failed_logon.upserted=${etl.upserted}/${events.length} skipped=${etl.skipped} errors=${etl.errors.length}`);
            if (etl.errors.length) {
              result.errors.push({
                packageName: run.packageName,
                error: `failed-logon ETL ${etl.errors.length} event(s) failed`,
                details: etl.errors.slice(0, 3)
              });
            }
          }
          // R112 — ad_eventlog_collector is a "公共表" package: manifest
          // omits the database block so metricstore.ingestRunV2 never
          // runs for it. We must write to ad_eventlog_events +
          // ad_eventlog_summary here. See
          // center/src/services/eventlog.js. The package run wire shape
          // carries run.metrics.events[] (per-event rows) AND
          // run.metrics.summaries[] (per-(dc,channel) counter rollups).
          // Best-effort (mirrors R107.1 + R110.A): each batch has its own
          // try/catch, push to result.errors on failure, do NOT fail the
          // whole /report envelope.
          if (run.packageName === 'ad_eventlog_collector' && run.metrics) {
            const events = Array.isArray(run.metrics.events) ? run.metrics.events : [];
            const summaries = Array.isArray(run.metrics.summaries) ? run.metrics.summaries : [];
            let eventEtl = { upserted: 0, skipped: 0, errors: [] };
            let summaryEtl = { upserted: 0, skipped: 0, errors: [] };
            try {
              eventEtl = await eventlogService.upsertEvents(db, events, agentId, log);
              log?.info?.({
                event: 'eventlog.events_etl',
                packageName: run.packageName,
                agentId,
                count: events.length,
                upserted: eventEtl.upserted,
                skipped: eventEtl.skipped,
                errors: eventEtl.errors.length
              }, 'eventlog events ETL complete');
              // R158.25 — record ETL outcome into stderr_preview traceback.
              etlTrace.push(`eventlog_events.upserted=${eventEtl.upserted}/${events.length} skipped=${eventEtl.skipped} errors=${eventEtl.errors.length}`);
              if (eventEtl.errors.length) {
                result.errors.push({
                  packageName: run.packageName,
                  error: `eventlog events ETL ${eventEtl.errors.length} event(s) failed`,
                  details: eventEtl.errors.slice(0, 3)
                });
              }
            } catch (e) {
              result.errors.push({
                packageName: run.packageName,
                error: `eventlog events ETL threw: ${e?.message || String(e)}`
              });
            }
            try {
              summaryEtl = await eventlogService.upsertSummaries(db, summaries, agentId, log);
              log?.info?.({
                event: 'eventlog.summaries_etl',
                packageName: run.packageName,
                agentId,
                count: summaries.length,
                upserted: summaryEtl.upserted,
                skipped: summaryEtl.skipped,
                errors: summaryEtl.errors.length
              }, 'eventlog summaries ETL complete');
              // R158.25 — record ETL outcome into stderr_preview traceback.
              etlTrace.push(`eventlog_summaries.upserted=${summaryEtl.upserted}/${summaries.length} skipped=${summaryEtl.skipped} errors=${summaryEtl.errors.length}`);
              if (summaryEtl.errors.length) {
                result.errors.push({
                  packageName: run.packageName,
                  error: `eventlog summaries ETL ${summaryEtl.errors.length} row(s) failed`,
                  details: summaryEtl.errors.slice(0, 3)
                });
              }
            } catch (e) {
              result.errors.push({
                packageName: run.packageName,
                error: `eventlog summaries ETL threw: ${e?.message || String(e)}`
              });
            }
          }
          // R158.78 (2026-10-12) — member_eventlog_collector is also a
          // "公共表" package (manifest omits `database` block, like
          // ad_eventlog_collector 1.0.6 / R112). We must write to
          // ad_member_eventlog_events + ad_member_eventlog_summary
          // here. Mirrors the DC branch above 1:1, but with:
          //   · memberEventlogService (not eventlogService) — fields
          //     use `hostname` not `dc_name` (R158.78 directive "专表
          //     ad_member_eventlog_*").
          //   · fallback agent id is the `hostname` wire field (member-
          //     server = hostname), not the DC `agentId` (which is
          //     identical on member because no AD identity).
          //   · 3 channels (Application / System / Security) — DC-only
          //     channels (ADWeb / DFSR) are not in this code path.
          // Best-effort pattern mirrors R112 / R107.1 / R110.A: per-batch
          // try/catch, push to result.errors on failure, do NOT fail
          // the whole /report envelope.
          if (run.packageName === 'member_eventlog_collector' && run.metrics) {
            // R158.86.5.1 (2026-10-12) — AD agent 误报 member_* 包
            //   拒写. agent 升级到发 ?agentType= 之前, AD agent 自己
            //   setInterval 仍调 member_eventlog_collector, 跑完上报
            //   中心端, FK 拒写 0 污染 (ad_member_eventlog_* FK →
            //   ad_member_servers). 这一步提前 拒, 节省 AD agent CPU
            //   + 中心 ETL traceback. 跟 R158.86.5 中心端 scope 拆细
            //   配合: centre 拒跑 + agent 升级后不收 = 双层防.
            const memberEventlogHost = (typeof run.metrics.hostname === 'string' && run.metrics.hostname)
              || (typeof agentId === 'string' && agentId)
              || null;
            if (memberEventlogHost) {
              const isMember = await isMemberHostname(db, memberEventlogHost);
              if (!isMember) {
                log?.warn?.({
                  event: 'member_eventlog.reject_non_member',
                  packageName: run.packageName,
                  agentId,
                  hostname: memberEventlogHost,
                  reason: 'R158.86.5.1 — AD agent 误报 member_* 包, 拒写'
                }, 'member-eventlog: agent 端未升级 ?agentType=, 中心端拒');
                etlTrace.push(`member_eventlog.reject_non_member=${memberEventlogHost}`);
                result.errors.push({
                  packageName: run.packageName,
                  error: `R158.86.5.1: ${memberEventlogHost} not in ad_member_servers — rejected`,
                  details: ['升级 noadagent 到发 ?agentType= 或从 package_policies 移除 member_* 包']
                });
                // 不 throw, 让 run 进 package_runs (跟 FK 拒行为一致, audit row 留)
                return;  // 跳过 member eventlog ETL
              }
            }
            const events = Array.isArray(run.metrics.events) ? run.metrics.events : [];
            const summaries = Array.isArray(run.metrics.summaries) ? run.metrics.summaries : [];
            // R158.78 — wire envelope uses `hostname` (跟 ad_member_servers 对齐).
            // collect.ps1 1.0.0 also writes `agent_id = $env:COMPUTERNAME`
            // (跟 hostname 相同), 但前端依赖 `hostname` 字段, 这里优先.
            const hostname = (typeof run.metrics.hostname === 'string' && run.metrics.hostname)
              || (typeof agentId === 'string' && agentId)
              || null;
            let eventEtl = { upserted: 0, skipped: 0, errors: [] };
            let summaryEtl = { upserted: 0, skipped: 0, errors: [] };
            try {
              eventEtl = await memberEventlogService.upsertEvents(db, events, hostname, log);
              log?.info?.({
                event: 'member_eventlog.events_etl',
                packageName: run.packageName,
                hostname,
                count: events.length,
                upserted: eventEtl.upserted,
                skipped: eventEtl.skipped,
                errors: eventEtl.errors.length
              }, 'member-eventlog events ETL complete');
              etlTrace.push(`member_eventlog_events.upserted=${eventEtl.upserted}/${events.length} skipped=${eventEtl.skipped} errors=${eventEtl.errors.length}`);
              if (eventEtl.errors.length) {
                result.errors.push({
                  packageName: run.packageName,
                  error: `member-eventlog events ETL ${eventEtl.errors.length} event(s) failed`,
                  details: eventEtl.errors.slice(0, 3)
                });
              }
            } catch (e) {
              result.errors.push({
                packageName: run.packageName,
                error: `member-eventlog events ETL threw: ${e?.message || String(e)}`
              });
            }
            try {
              summaryEtl = await memberEventlogService.upsertSummaries(db, summaries, hostname, log);
              log?.info?.({
                event: 'member_eventlog.summaries_etl',
                packageName: run.packageName,
                hostname,
                count: summaries.length,
                upserted: summaryEtl.upserted,
                skipped: summaryEtl.skipped,
                errors: summaryEtl.errors.length
              }, 'member-eventlog summaries ETL complete');
              etlTrace.push(`member_eventlog_summaries.upserted=${summaryEtl.upserted}/${summaries.length} skipped=${summaryEtl.skipped} errors=${summaryEtl.errors.length}`);
              if (summaryEtl.errors.length) {
                result.errors.push({
                  packageName: run.packageName,
                  error: `member-eventlog summaries ETL ${summaryEtl.errors.length} row(s) failed`,
                  details: summaryEtl.errors.slice(0, 3)
                });
              }
            } catch (e) {
              result.errors.push({
                packageName: run.packageName,
                error: `member-eventlog summaries ETL threw: ${e?.message || String(e)}`
              });
            }
          }
        }
          // R158.86 (2026-10-12) — member_os_baseline_collector is also a
          // "公共表" package (manifest omits `database` block, like
          // R158.78 member_eventlog_collector). We must write to
          // ad_member_os_baseline + ad_member_os_baseline_latest here.
          // 1 wire payload per run → 1 row in each table.
          if (run.packageName === 'member_os_baseline_collector' && run.metrics) {
            // R158.86.5.1 (2026-10-12) — 跟 member_eventlog 平行. AD
            //   agent 误报 member_os_baseline 拒写, 提前 fail 节省
            //   ETL + 中心 traceback. 升级 noadagent 后 此 check 可删
            //   (agent 不再收 member_* 包).
            const baselineHostname = (typeof run.metrics.hostname === 'string' && run.metrics.hostname)
              || (typeof agentId === 'string' && agentId)
              || null;
            if (baselineHostname) {
              const isMember = await isMemberHostname(db, baselineHostname);
              if (!isMember) {
                log?.warn?.({
                  event: 'member_os_baseline.reject_non_member',
                  packageName: run.packageName,
                  agentId,
                  hostname: baselineHostname,
                  reason: 'R158.86.5.1 — AD agent 误报 member_* 包, 拒写'
                }, 'member-os-baseline: agent 端未升级 ?agentType=, 中心端拒');
                etlTrace.push(`member_os_baseline.reject_non_member=${baselineHostname}`);
                result.errors.push({
                  packageName: run.packageName,
                  error: `R158.86.5.1: ${baselineHostname} not in ad_member_servers — rejected`,
                  details: ['升级 noadagent 到发 ?agentType= 或从 package_policies 移除 member_* 包']
                });
                // 不 throw, 让 run 进 package_runs (跟 FK 拒行为一致, audit row 留)
                return;  // 跳过 member os baseline ETL
              }
            }
            const hostname = baselineHostname;
            let baselineEtl = { ok: false, hostname, metricsOk: false, latestOk: false, errors: [] };
            try {
              baselineEtl = await memberOsBaselineService.upsertMetrics(db, run.metrics, hostname, log);
              log?.info?.({
                event: 'member_os_baseline.etl',
                packageName: run.packageName,
                hostname,
                metricsOk: baselineEtl.metricsOk,
                latestOk:  baselineEtl.latestOk,
                errors:    baselineEtl.errors.length
              }, 'member-os-baseline ETL complete');
              etlTrace.push(`member_os_baseline.metrics=${baselineEtl.metricsOk ? 'ok' : 'fail'} latest=${baselineEtl.latestOk ? 'ok' : 'fail'}`);
              if (baselineEtl.errors.length) {
                result.errors.push({
                  packageName: run.packageName,
                  error: `member-os-baseline ETL ${baselineEtl.errors.length} row(s) failed`,
                  details: baselineEtl.errors.slice(0, 3)
                });
              }
            } catch (e) {
              result.errors.push({
                packageName: run.packageName,
                error: `member-os-baseline ETL threw: ${e?.message || String(e)}`
              });
            }
          }
          // R158.100 (2026-10-13) — member_admin_groups etl. 跟 member_os_baseline_collector
          //   平行公共表 pattern (R110.A): manifest omits `database` block, 中心端
          //   runner.js post-hook 直接 MERGE ad_member_admin_groups. 1 wire payload
          //   per run → N row (3 group × N member). Best-effort: a failed ETL does
          //   NOT fail the whole /report envelope (mirrors R107.1 + R110.A + R158.78/86).
          if (run.packageName === 'member_admin_groups' && run.metrics) {
            // R158.86.5.1 — 跟前置 member_eventlog / member_os_baseline 1:1 平行.
            //   AD agent 误报 member_* 包时 hostname 不在 ad_member_servers, 提前
            //   拒, 不进 MERGE 阶段. 升级 noadagent 后 (agent 发 ?agentType=)
            //   此 check 可删.
            const groupsHostname = (typeof run.metrics.hostname === 'string' && run.metrics.hostname)
              || (typeof agentId === 'string' && agentId)
              || null;
            if (groupsHostname) {
              const isMember = await isMemberHostname(db, groupsHostname);
              if (!isMember) {
                log?.warn?.({
                  event: 'member_admin_groups.reject_non_member',
                  packageName: run.packageName,
                  agentId,
                  hostname: groupsHostname,
                  reason: 'R158.86.5.1 — AD agent 误报 member_* 包, 拒写'
                }, 'member-admin-groups: agent 端未升级 ?agentType=, 中心端拒');
                etlTrace.push(`member_admin_groups.reject_non_member=${groupsHostname}`);
                result.errors.push({
                  packageName: run.packageName,
                  error: `R158.86.5.1: ${groupsHostname} not in ad_member_servers — rejected`,
                  details: ['升级 noadagent 到发 ?agentType= 或从 package_policies 移除 member_* 包']
                });
                // 不 throw, 让 run 进 package_runs (跟 FK 拒行为一致, audit row 留)
              } else {
                const hostname = String(groupsHostname).toLowerCase();  // R158.99.1 case-insensitive
                let groupsEtl = { upserted: 0, skipped: 0, errors: [] };
                try {
                  groupsEtl = await memberAdminGroupsService.upsertGroups(db, run.metrics, hostname, runRowId, log);
                  const groupCount = Array.isArray(run.metrics?.groups) ? run.metrics.groups.length : 0;
                  const totalMembers = (Array.isArray(run.metrics?.groups) ? run.metrics.groups : [])
                    .reduce((s, g) => s + (Array.isArray(g?.members) ? g.members.length : 0), 0);
                  log?.info?.({
                    event: 'member_admin_groups.etl',
                    packageName: run.packageName,
                    agentId,
                    hostname,
                    runId: runRowId,
                    groups: groupCount,
                    totalMembers,
                    upserted: groupsEtl.upserted,
                    skipped: groupsEtl.skipped,
                    errors: groupsEtl.errors.length
                  }, 'member-admin-groups ETL complete');
                  etlTrace.push(`member_admin_groups.upserted=${groupsEtl.upserted} skipped=${groupsEtl.skipped} errors=${groupsEtl.errors.length}`);
                  if (groupsEtl.errors.length) {
                    result.errors.push({
                      packageName: run.packageName,
                      error: `member-admin-groups ETL ${groupsEtl.errors.length} row(s) failed`,
                      details: groupsEtl.errors.slice(0, 3)
                    });
                  }
                } catch (e) {
                  result.errors.push({
                    packageName: run.packageName,
                    error: `member-admin-groups ETL threw: ${e?.message || String(e)}`
                  });
                }
              }
            } else {
              log?.warn?.({
                event: 'member_admin_groups.no_hostname',
                packageName: run.packageName,
                agentId
              }, 'member-admin-groups: hostname missing in wire metrics, skip');
              etlTrace.push(`member_admin_groups.no_hostname`);
            }
          }
        // R158.25 (2026-10-02) — finalize stderr_preview with ingest
        // traceback. After every branch above has pushed its outcome
        // into etlTrace (or stayed empty if the package name didn't
        // match any post-hook), build a single `[R158.25 ingest]` line
        // and UPDATE package_runs.stderr_preview. The banner
        // (scriptBanner) and any original collect.ps1 stderr are
        // preserved above; we APPEND the traceback so future grep on
        // `R158.25 ingest` reads the post-hook outcomes directly from
        // the audit row. Best-effort: if the UPDATE throws, log + skip
        // — the run is still counted in result.processed because the
        // INSERT already happened.
        if (runRowId != null && etlTrace.length > 0) {
          const ingestLine = `[R158.25 ingest] ${etlTrace.join(' | ')}`;
          const newStderr = (stderrForDb ? stderrForDb : '') + ingestLine + '\n';
          const truncated = newStderr.length > STDERR_PREVIEW_LIMIT
            ? newStderr.slice(0, STDERR_PREVIEW_LIMIT) + '...[truncated]'
            : newStderr;
          try {
            await packageRuns.updateStderr(db, { id: runRowId, stderrPreview: truncated });
          } catch (e) {
            log?.error?.({
              event: 'r158.25.stderr_update.failed',
              agentId,
              packageName: run.packageName,
              runRowId,
              err: e?.message || String(e)
            }, 'R158.25 ingest traceback UPDATE threw, run still processed');
          }
        }
        result.processed++;
      } catch (e) {
        result.errors.push({ packageName: run.packageName, error: e.message });
        // 2026-09-30 R157.X — observability fix. Pre-fix this catch
        // only pushed to result.errors and never logged, which is why
        // the R157.1 MSSQL LIMIT bug went undetected for hours
        // (every envelope silently failed its dedup step while the
        // centre appeared healthy in logs). Surface the throw here
        // so a future regression is grep-able from centre logs and
        // /api/dashboard operations can spot it without operator aid.
        log?.error?.({
          event: 'agent.packages.run.failed',
          agentId,
          packageName: run.packageName,
          err: e?.message || String(e),
          stack: e?.stack?.split?.('\n')?.[0]
        }, 'per-run package processing failed');
      }
    }
    return result;
  }

  return async (req, res) => {
    const { runs } = req.body || {};
    if (!Array.isArray(runs)) {
      return res.status(400).json({ error: 'runs must be array' });
    }

    // R157.3 (2026-09-30) — envelope size cap. Rejects oversized
    // envelopes before they enter the queue so the per-agent FIFO chain
    // doesn't accumulate hundreds of 1000-run envelopes. Pre-cap (R157.2
    // alone) the queue bounded concurrency to 3 active envelopes but
    // didn't bound backlog size — once the agent starts pushing 1000-run
    // envelopes, the queue length itself drove heap growth (each
    // trackingPromise + runs array + log ref stays alive until the
    // envelope ahead clears). Capping at MAX_ENVELOPE_RUNS turns the
    // back-pressure explicit: the agent receives 413, halves its batch,
    // and the queue length stays bounded by 3 * MAX_ENVELOPE_RUNS.
    // The agent side must also learn to handle 413 (split and retry);
    // see agent/src/reporter.js postPackagesReport — until agents are
    // updated + restarted, the agent may keep re-posting the same 1000-run
    // envelope, which is fine (we 413 it again, no DB work happens) but
    // burns ~1 KB of network per retry. The agent flushReportQueue
    // CHUNK_SIZE=50 (R157.1) already implements this split when it loads
    // the new code; the 413 path is the hot-fix that lets centre stay
    // stable even before agents restart.
    if (runs.length > MAX_ENVELOPE_RUNS) {
      const agentId = req.headers['x-agent-id'] || null;
      const log = getLogger ? getLogger() : null;
      log?.warn?.({
        event: 'agent.packages.envelope_too_large',
        agentId,
        runsCount: runs.length,
        max: MAX_ENVELOPE_RUNS
      }, 'rejecting oversized envelope (agent must split and retry)');
      // R157.9 — per-agent 413 throttle (code review M11). Pre-fix, a
      // buggy agent re-posting a 1000-run envelope every 60s burned
      // ~50 KB of HTTP round-trip per minute × 34 agents = sustained
      // 413 storm with no backoff. Post-fix: count consecutive 413s
      // per agent in a 60-second window. After 5 hits, escalate to
      // 503 + Retry-After: 30 so the agent backs off instead of
      // hammering. Counter is per-process (resets on centre restart)
      // and per-agent (one agent's runaway doesn't affect others).
      let throttleCount = 0;
      if (agentId) {
        const nowMs = Date.now();
        const rec = agent413Counters.get(agentId);
        if (!rec || nowMs - rec.windowStartMs > 60_000) {
          agent413Counters.set(agentId, { windowStartMs: nowMs, count: 1 });
        } else {
          rec.count++;
          throttleCount = rec.count;
        }
      }
      if (throttleCount >= 5) {
        log?.error?.({
          event: 'agent.packages.envelope_throttled',
          agentId,
          windowHits: throttleCount
        }, 'agent hit 413 >= 5 times in 60s — escalating to 503 + Retry-After: 30');
        res.setHeader('Retry-After', '30');
        return res.status(503).json({
          ok: false,
          error: {
            code: 'ENVELOPE_THROTTLED',
            message: 'envelope rejected 5x in 60s — backoff and retry after 30s'
          }
        });
      }
      return res.status(413).json({
        ok: false,
        error: {
          code: 'ENVELOPE_TOO_LARGE',
          message: `runs=${runs.length} exceeds centre cap=${MAX_ENVELOPE_RUNS}; agent must split and retry`
        },
        max: MAX_ENVELOPE_RUNS
      });
    }

    const agentId = req.headers['x-agent-id'] || null;
    const log = getLogger ? getLogger() : null;
    if (log) log.info({
      event: 'agent.packages.report',
      source: req.body?.source ?? 'unknown',
      agentId,
      runsCount: runs.length,
      packages: runs.map(r => `${r.packageName}:${r.exitCode ?? 'n/a'}`).slice(0, 20)
    }, 'agent packages report received');

    try {
      // R157.2 — queue through enqueueForAgent so per-agent envelopes
      // serialize (FIFO) while cross-agent concurrency is bounded at 3.
      // The handler still returns the same `result` JSON as before; the
      // queue is purely a load-shedding layer.
      const result = await enqueueForAgent(agentId, runs, log);
      res.json(result);
    } catch (e) {
      const log2 = getLogger ? getLogger() : null;
      log2?.error?.({
        event: 'agent.packages.report.failed',
        agentId,
        err: e?.message || String(e),
        runsCount: runs.length
      }, 'agent packages report processing failed');
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
    }
  };
}
