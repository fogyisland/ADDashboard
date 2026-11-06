import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';

const REQUIRED = ['centerUrl', 'agentId', 'agentToken'];
const DEFAULTS = {
  logLevel: 'info',
  pollingIntervalMinutes: 1,
  // 2026-09-30 — OOM 缓解: 心跳从 5s 改为 60s (1 分钟).
  // 原来 5s × 34 agents = 6.8 req/s × 3 round-trips ≈ 36 req/s 打 DB pool=10
  // → queue 累积 → closure 持有 → V8 heap 4GB → FATAL OOM. 60s 后降到
  // ~1 req/s × 3 = 3 req/s,pool 完全不排队. centres/agent.js:522 和
  // :905 都读这个字段,改一处全 agent 同步生效。
  heartbeatIntervalSeconds: 60,
  discoveryIntervalHours: 1,
  // 2026-09-27 — green-package defaults. The MSI install path
  // (`C:\\addashboard\\Agent\\data`) is wrong for the green-package
  // layout at `C:\\agentInstall\\agent\\`. Resolved relative to the
  // CWD at launch (NSSM runs the service with CWD = install dir),
  // which is exactly where PackageManager creates its queue file
  // and package cache. appsettings.json still wins via shallow-merge.
  psDiscoveryScriptPath: 'C:\\agentInstall\\agent\\scripts\\collect-discovery.ps1',
  queueDbPath: 'C:\\agentInstall\\agent\\queue.db',
  agentDataDir: 'C:\\agentInstall\\agent\\data',
  powerShellPath: 'powershell.exe',
  psScriptPath: 'C:\\agentInstall\\agent\\scripts\\collect-replication.ps1',
  healthCheckIntervalMs: 600_000,
  // T16: agent type discriminator. 'ad' = DC-collector (legacy); 'non-ad'
  // = member-server heartbeat + self-register + per-host package fetch.
  // Default stays 'ad' so existing deployments keep working without a
  // config-file change.
  agentType: 'ad',
  // R158.0.1.9 (2026-10-20) — port-scanner 删除. 4 个 scan DEFAULTS
  // (centerHost / scanOnBoot / scanOnRuntimeFail / scanFailureThreshold)
  // 删, 不再有 fallback 给 appsettings.json. 操作员 directive '不需要
  // 扫描端口'. 0 必保留这些 key 给老 appsettings.json 兼容 — loadConfig
  // 的 shallow-merge ({ ...DEFAULTS, ...cfg }) 是单向覆盖, 老 appsettings
  // 里残留的 4 个 key 仍然在 cfg 对象里被 agent.js 读到 (但代码已不再用).
  // 1.0.9 ship 后操作员手工 edit appsettings.json 清掉这 4 行更干净.
  // 2026-08-21 UX redesign (auto-delivery): the agent's last-seen
  // agent_token_version. Sent on every heartbeat; the centre replies with
  // a newer agentToken when its own version has been bumped. Default 0 =
  // fresh-install (matches a server that has never rotated; if the server
  // HAS rotated and the agent is on version 0, the next heartbeat will
  // immediately deliver the live token). Persistent so the agent doesn't
  // re-request the same credential after a restart.
  agentTokenVersion: 0,
  // R158.48 (2026-10-06) — agent auto-update. The agent's last-applied
  // bundle version (mirrors agent.js:49 const VERSION at build time). The
  // centre reads its own boot-time cached version; if newer than this, the
  // heartbeat response carries upgradeAvailable=true and the agent pulls
  // GET /api/agent/upgrade. After atomic-apply, this field is bumped via
  // writeAppsettingsPatchAtomic (same pattern as agentTokenVersion) so a
  // process restart remembers the version we last applied. Default '0.0.0'
  // means "fresh install, force first upgrade" — after the first successful
  // upgrade the centre sees a matching version and stops nudging.
  installedAgentVersion: '0.0.0',
  // R158.50.7f (2026-10-07) — agent in-process dashboard config. Passed
  // straight to startDashboard() in agent.js boot (fire-and-forget, see
  // agent.js boot block), which binds the loopback HTTP server that renders
  // the local-only "采集计划 / 最近报表 / 日志" page. dashboardEnabled=false
  // leaves the page off but doesn't disable the agent; collectors, heartbeat,
  // and R158.48 auto-upgrade are unaffected.
  //
  // username + password mirror what Register-ADDashboardAgent.ps1:162-163
  // writes to a fresh appsettings.json (admin / base64('admin')). The agent
  // resolves the base64 password back to plainPassword before handing off
  // to startDashboard, because dashboard/server.js compares the form-typed
  // password against plainPassword, not against the base64 string.
  //
  // 0.1.1 used these via the in-process startDashboard() call; 0.1.2 lost
  // the call site during the R158.50.7e refactor and left the schema
  // orphaned. Re-adding the DEFAULTS so loadConfig's shallow merge
  // ({ ...DEFAULTS, ...cfg }) backfills them automatically — operators do
  // not have to edit appsettings.json manually on the next upgrade.
  username: 'admin',
  password: Buffer.from('admin').toString('base64'),
  port: 8080,
  dashboardEnabled: true
};

export function loadConfig(path) {
  const raw = readFileSync(path, 'utf8');
  // 2026-08-24 round-8: PowerShell 5.1 `Set-Content -Encoding UTF8` writes a
  // UTF-8 BOM (EF BB BF) into appsettings.json. JSON.parse rejects those
  // leading bytes with `SyntaxError: Unexpected token` and the agent
  // crashes on first call. Strip a leading BOM defensively — also covers
  // manual Notepad edits on Windows which save UTF-8-with-BOM by default.
  // We only strip the *leading* BOM so a stray embedded one (which would
  // itself be malformed JSON) is still surfaced as a parse error.
  const cfg = JSON.parse(raw.replace(/^\uFEFF/, ''));
  const missing = REQUIRED.filter(
    (k) => cfg[k] === undefined || cfg[k] === null || cfg[k] === ''
  );
  if (missing.length > 0) {
    throw new Error(`agent config missing required key(s): ${missing.join(', ')}`);
  }
  // 2026-09-24 R91.3 — reject centerUrl that doesn't look like an absolute
  // URL with a scheme. Real install on KDLFLOFADSRV2 had appsettings.json
  // with `"centerUrl": "Add-Content : 流不可读。"` after an operator-side
  // `Add-Content` failure redirected stderr into the JSON file. The
  // previous loadConfig accepted the string as-is and the agent crashed
  // 30 lines deeper inside `new URL(url)` in reporter.js:13 with a stack
  // trace that pointed at the wrong layer. Fail loudly at config-load
  // time so the operator sees "your config is corrupt" instead of "the
  // URL parser is broken".
  //
  // Acceptable shapes: anything matching RFC 3986 generic scheme syntax
  // (`scheme://authority/...`): `http://x`, `https://x`, `ws://x` (future
  // websocket probes), `tcp://x` (lab bench), even `file:///path` for local
  // dev. The constraint we actually need is "has a scheme" — anything
  // else is either a relative path, a bare hostname, or a stray error
  // string from a redirected PowerShell `Add-Content` failure.
  if (typeof cfg.centerUrl !== 'string' || !/^[a-z][a-z0-9+.-]*:\/\//i.test(cfg.centerUrl.trim())) {
    throw new Error(
      `agent config centerUrl is not a valid URL (missing scheme): ${JSON.stringify(cfg.centerUrl)}`
    );
  }
  return { ...DEFAULTS, ...cfg };
}
