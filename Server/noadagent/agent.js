// R158.75 (2026-10-11) 鈥?NoAD-only agent bundle. All AD imports removed
// (runAdRuntime() was deleted; this agent is the member-server / non-AD
// runtime only). Re-import only what's still wired up below.
import { loadConfig } from './src/config.js';
import { createLogger } from './src/logger.js';
import { postReport, postHeartbeat, fetchConfig, signedRequestJson, _refreshLogLevel } from './src/reporter.js';
import { startHeartbeat } from './src/heartbeat.js';
import { getOsInfo } from './src/os-info.js';
import { discoverCenterPort } from './src/port-scanner.js';
import { writeCenterUrlAtomic } from './src/appsettings-writer.js';
import { applyAgentTokenDelivery } from './src/agent-token-delivery.js';
// 2026-10-01 R158.13 鈥?parallel to applyAgentTokenDelivery above. Used
// at all three heartbeat call sites to consume the centre's
// settingsPatch / clientSettingsVersion envelope.
import { applySettingsDelivery } from './src/settings-delivery.js';
// R158.48 (2026-10-06) 鈥?agent auto-update consumer. Mirror of
// applySettingsDelivery above: reads the centre's heartbeat envelope
// {upgradeAvailable, upgradeVersion}, fetches GET /api/agent/upgrade,
// stages / sha256-verifies / atomic-renames every file, persists
// installedAgentVersion via writeAppsettingsPatchAtomic, then SIGTERMs
// itself so NSSM relaunches with the new bundle. See
// agent/src/upgrade-delivery.js for the full flow.
import { applyUpgradeDelivery } from './src/upgrade-delivery.js';
import { fetchUpgrade as _fetchUpgrade } from './src/reporter.js';
import { makeSendCallback, makePayload } from './src/heartbeat-callbacks.js';
// 2026-09-04 R78: file-push drainer wired into the heartbeat loop.
// (R158.75 鈥?drainAdCommands / dispatchAdCommand removed; member-commands
// drainer below is the only PowerShell-style work puller.)
import { drainFilePush } from './src/file-push-drainer.js';
// 2026-09-05 R81 鈥?member-server PowerShell drainer joins the heartbeat pool.
import { drainMemberCommands } from './src/member-commands-drainer.js';
import { dispatchMemberCommand } from './src/dispatchers/member-commands.js';
import {
  applyPackageList,
  clearAllTimers,
  // R158.72.x.12 B' (2026-10-17) — triggerOnce wire 真实现 (NoAD 端).
  //   fireOnceFor 跟 AD 端 package-manager.js runOne(pkg, {onceOnly})
  //   1:1 平行 — 1 click 1 跑 0 启 setInterval.
  fireOnceFor,
  // peekLocalTaskNames 是非破坏性视图 (跟 startTimerFor 持 localTasks
  //   Map 1:1 平行), agent.js:runTriggersNow 用它查已知 pkg 列表
  //   (NoAD 端 0 持 full pkg manifest, 跟 AD 1:1 平行 fetch 走 wire).
  peekLocalTaskNames
} from './src/non-ad-scheduler.js';
// R158.50.7f (2026-10-07) 鈥?in-process dashboard. dashboard/server.js
// exports startDashboard({ config, installRoot, agentDir, logger,
// bindAddress }) and only binds an HTTP listener when that function is
// called 鈥?importing the module is side-effect free, so this import does
// not change agent boot behaviour. The actual startDashboard() call lives
// further down, in the boot block.
//
// IMPORTANT path: agent.js lives at <installRoot>/agent/agent.js and
// dashboard/server.js lives at <installRoot>/dashboard/server.js (the
// two are siblings under the install root 鈥?see D:\agentInstall\README-
// green-install.md "File structure" diagram and dashboard/README.md
// design 搂5). The import is therefore `../dashboard/server.js`, NOT
// `./dashboard/server.js` 鈥?the first attempt at this round went with
// `./` and ERR_MODULE_NOT_FOUND at boot (no agent/dashboard/ subdir
// exists in the green-install layout).
import { startDashboard } from '../dashboard/server.js';
import { fileURLToPath } from 'node:url';
import { dirname, join as joinPath, resolve as resolvePath, sep as pathSep } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
// 2026-10-21 (security) — 中心下发的 pkg.scriptPath 会直接进
// spawn(powershell -File <path>)（见 src/package-runner.js:51）。必须把它
// 锁死在 <agentDataDir>\packages 之内，否则中心可让 NOAD agent 以 SYSTEM
// 权限执行任意文件。与 AD agent 共用同一套守卫。
import { isSafeSegment, safeJoin } from './src/lib/path-safety.js';

// 若 center 下发了绝对 scriptPath(兼容既有 manifest), 确认它落在 root 之内,
// 返回归一化绝对路径; 否则返回 null。
//
// safeJoin 要求所有段都是安全的单段, 而 scriptPath 可能是
// "C:\...\packages\foo\1.0.0\collect.ps1" 这样的完整绝对路径 —— 它本身
// 由中心给出、不是我们拼的, 所以这里换一套判定: resolve 后做前缀包含。
// 末尾分隔符必需, 否则 "C:\...\packages-evil" 这类同前缀目录会被误判。
function resolveIfInside(root, candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return null;
  const rootAbs = resolvePath(root);
  const full = resolvePath(candidate);
  if (full !== rootAbs && !full.startsWith(rootAbs + pathSep)) return null;
  return full;
}

// Default appsettings.json lives next to this script so the agent works
// regardless of cwd. argv[2] and APPSETTINGS_PATH still win when provided.
const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = joinPath(__dirname, 'appsettings.json');

// R158.50.7e (2026-10-07) 鈥?read VERSION from version.inf (operator
// directive: agent.js must NOT hardcode the version; it must read the
// single source of truth at <agentInstallDir>/version.inf). The
// prior literal `'0.1.1'` at agent.js:58 meant every heartbeat payload
// reported agentVersion='0.1.1' even when build-manifest.json shipped
// 0.1.2. Centre computeUpgradeEnvelope (center/src/routes/agent-upgrade.js:70)
// compares the literal to its installedAgentVersion, so 0.1.1
// heartbeats always saw upgradeAvailable=true but the call site in
// R158.48 below never reached applyUpgradeDelivery because the
// agentInstallDir parameter was dropped. version.inf layout (see
// D:\agentInstall\version.inf, header line 5):
//   [components]
//     version       = 0.1.2   <- the version we want
//     agent         = 0.1.2
//     dashboard     = 0.1.2
// We read the [components].version key. Falls back to build-manifest.json
// (R119 convention) when version.inf is missing (legacy dev-tree layout
// where agent.js sits at <repo>/agent/agent.js with no install root).
// Final fallback: 'unknown' 鈥?operator must investigate.
//
// IMPORTANT: this block MUST come AFTER `const __dirname = ...` above.
// The original draft placed it before __dirname (line 58), causing
// `ReferenceError: Cannot access '__dirname' before initialization`
// (ESM TDZ) at boot 鈥?agent crashed before loadConfig ever ran.
//
// Agent install root is the parent of the agent/ subdir that contains
// this script. E.g. for C:\agentInstall\agent\agent.js, install root
// = C:\agentInstall. We try to read version.inf from there first.
const agentInstallRoot = joinPath(__dirname, '..');

function readVersionFromInf(infPath) {
  try {
    const raw = readFileSync(infPath, 'utf8');
    // .inf files are ASCII-only (per version.inf header comment); a
    // simple line scan is enough 鈥?no need for a full ini parser.
    // Pattern: `version       = 0.1.2` (variable whitespace around `=`).
    // We match `[components]` first then the `version =` line; that
    // distinguishes the package version from `[components] agent = ...`
    // or `[components] dashboard = ...` keys (which would also match
    // a naive scan).
    let inComponents = false;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (/^\[\s*\w+\s*\]$/.test(trimmed)) {
        inComponents = /^\[\s*components\s*\]$/i.test(trimmed);
        continue;
      }
      if (!inComponents) continue;
      const m = /^version\s*=\s*(\S+)/i.exec(trimmed);
      if (m) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

const _versionInfPath = joinPath(agentInstallRoot, 'version.inf');
const _manifestPath = joinPath(__dirname, 'build-manifest.json');
const VERSION =
  readVersionFromInf(_versionInfPath) ||
  (existsSync(_manifestPath)
    ? (() => { try { return JSON.parse(readFileSync(_manifestPath, 'utf8')).version; } catch { return null; } })()
    : null) ||
  'unknown';

const configPath = process.argv[2] || process.env.APPSETTINGS_PATH || defaultConfigPath;
const config = loadConfig(configPath);
const logger = createLogger({ component: 'agent', level: config.logLevel });
// R93 鈥?reporter.js boots with a default `info` level (it imports pino
// before loadConfig runs). Hand it the operator's appsettings.json
// logLevel so flipping to `debug` actually surfaces HTTP breadcrumbs.
_refreshLogLevel(config.logLevel);

// 2026-09-24 R91.2 鈥?hoist osInfo to module top level so the early
// boot paths (port scanner + recovery at agent.js:102 / 236 / 285) can
// read osInfo.hostname without hitting a temporal-dead-zone ReferenceError.
// Previously osInfo was declared `const` inside runNonAdRuntime; the
// recovery paths reached for it earlier and crashed. Real install on
// KDLFLOFADSRV2 (2026-09-24) surfaced the bug via "ReferenceError:
// osInfo is not defined" at refreshPortList.
const osInfo = getOsInfo();

// ============================================================================
// 2026-08-15 port-scanning bootstrap (spec 搂1.2, 搂1.3):
// When fetchConfig(/config.json) fails (operator changed web port but
// appsettings.json still points at the old one), scan for the new port and
// rewrite appsettings.json. Used by the non-AD runtime (was previously
// shared with the AD runtime — AD runtime deleted in R158.75).
//
// trigger: 'boot' for first attempt at startup; 'runtime' for the
// configRefresh interval (only after `scanFailureThreshold` consecutive
// failures). Each runtime owns its own consecutive-failure counter.
function deriveScanHost(config) {
  if (typeof config.centerHost === 'string' && config.centerHost.trim()) {
    return config.centerHost.trim();
  }
  try { return new URL(config.centerUrl).hostname; }
  catch { return 'localhost'; }
}

function replacePortInUrl(url, newPort) {
  const trimmed = String(url).replace(/\/+$/, '');
  return trimmed.replace(/:\d+$/, '') + ':' + Number(newPort);
}

// Spec 搂4 row 204: single-flight guard so two concurrent triggers
// (e.g. boot + first configRefresh tick) don't race on the same
// appsettings.json + .tmp file. Second caller awaits the first.
let inFlightRecovery = null;

async function tryRecoverCenterPort({ config, configPath, logger, trigger }) {
  if (inFlightRecovery) return inFlightRecovery;
  inFlightRecovery = (async () => {
    try {
      return await _tryRecoverCenterPortImpl({ config, configPath, logger, trigger });
    } finally {
      inFlightRecovery = null;
    }
  })();
  return inFlightRecovery;
}

async function _tryRecoverCenterPortImpl({ config, configPath, logger, trigger }) {
  const r = await fetchConfig({ centerUrl: config.centerUrl, agentToken: config.agentToken });
  if (r.ok) return { ok: true, recovered: false };

  // fetchConfig failed. Decide whether to scan based on trigger + config flags.
  const enabled = trigger === 'boot' ? config.scanOnBoot : config.scanOnRuntimeFail;
  if (!enabled) {
    logger.warn({ trigger, centerUrl: config.centerUrl }, 'fetchConfig failed; scan disabled by config');
    return { ok: false, recovered: false };
  }

  const host = deriveScanHost(config);
  // 2026-09-22 S82 鈥?stamp (hostname, agentId) into the probe signature
  // so the centre accepts the GET after the 60s restart-grace window.
  const scan = await discoverCenterPort({
    host, agentToken: config.agentToken,
    hostname: config.hostname || osInfo.hostname,
    agentId: config.agentId,
    logger
  });
  if (!scan) {
    logger.error({ trigger, host, centerUrl: config.centerUrl }, 'port scan missed; agent will retry on next tick');
    return { ok: false, recovered: false };
  }

  const oldUrl = config.centerUrl;
  const newUrl = replacePortInUrl(oldUrl, scan.port);
  const w = writeCenterUrlAtomic({ path: configPath, newUrl });
  if (w.ok) {
    logger.info({ trigger, oldUrl, newUrl, port: scan.port, source: scan.source }, 'appsettings.json rewritten to discovered port');
  } else {
    // In-memory swap regardless 鈥?this run uses the discovered port. Next
    // restart will re-scan if appsettings.json is still stale.
    logger.error({ trigger, oldUrl, newUrl, error: w.error }, 'appsettings.json rewrite failed; using new port in-memory only');
  }
  config.centerUrl = newUrl;

  // Retry once with the new port. Whatever the outcome, report recovered=true
  // so the caller can reset its failure counter.
  const retry = await fetchConfig({ centerUrl: config.centerUrl, agentToken: config.agentToken });
  if (!retry.ok) {
    logger.error({ trigger, newUrl }, 'fetchConfig still failing after scan recovery');
  }
  return { ok: retry.ok, recovered: true };
}

// 2026-08-21 UX redesign (auto-delivery): the centre replies to every
// heartbeat with { agentToken, agentTokenVersion } when its own current
// version is newer than what the agent reported. The helper that handles
// version-compare + atomic write + in-memory swap lives in
// src/agent-token-delivery.js so unit tests can exercise it directly.

// R158.75 (2026-10-11) — agent-type discriminator removed. This bundle is
// the non-AD runtime only; `runAdRuntime()` was deleted entirely (see
// REFACTOR_NOTES.md). The `config.agentType` key is preserved as a
// forward-compat metadata field (config.js still defaults to 'non-ad'),
// but is no longer consulted here.

// R158.50.7f (2026-10-07) 鈥?fire-and-forget in-process dashboard.
//
// startDashboard() must NOT block agent boot:
//   - The agent's primary duty is heartbeat + self-register; a failing
//     dashboard (port conflict, EADDRINUSE, file-read permission, etc.)
//     must not stall the boot 鈥?the operator's monitoring chain depends
//     on heartbeat arriving within seconds.
//   - runNonAdRuntime() is long-lived (it never resolves; its work lives
//     on setInterval / setImmediate handles). dashboard startup has to
//     happen BEFORE the runtime call, not after.
//   - dashboardEnabled=false skips the call entirely 鈥?operators who only
//     want the agent can leave the page off without losing heartbeat.
//
// Password flow: appsettings.json stores the base64 form (Register-ADDashboardAgent.ps1:163
// writes 'YWRtaW4=' for the default admin/admin pair). dashboard/server.js
// compares the form-typed password against plainPassword (utf8), not the
// base64 string, so we resolve here before handing off.
if (config.dashboardEnabled) {
  startDashboard({
    config: {
      username: config.username,
      plainPassword: Buffer.from(String(config.password || ''), 'base64').toString('utf8'),
      port: config.port,
      centerUrl: config.centerUrl,
      agentId: config.agentId
    },
    installRoot: agentInstallRoot,   // = __dirname/.., line 92 above
    agentDir: __dirname,              // = line 61 above
    logger,
    bindAddress: '127.0.0.1'          // loopback only 鈥?dashboard/README.md design 搂5
  }).then((handle) => {
    logger.info(
      { component: 'agent', port: handle.port, url: `http://127.0.0.1:${handle.port}/` },
      `dashboard listening on http://127.0.0.1:${handle.port}/ (user=${config.username}, install=${agentInstallRoot})`
    );
  }).catch((e) => {
    logger.warn(
      { component: 'agent', err: e.message, port: config.port },
      `dashboard failed to start (port=${config.port}): ${e.message}`
    );
  });
}

// Shared boot infrastructure 鈥?only one runtime remains in this bundle.
// runNonAdRuntime is long-lived (its work lives on setInterval /
// setImmediate handles and never resolves), so this await is the boot's
// terminal statement; SIGINT/SIGTERM handlers inside the runtime are the
// only way out.
await runNonAdRuntime({ config, logger });

// ============================================================================
// R158.75 (2026-10-11) — only one runtime remains in this bundle.
// Originally T16 split agent types into runAdRuntime (DC collector) +
// runNonAdRuntime (member server); the former is deleted entirely so the
// AD type discriminator no longer branches. runNonAdRuntime is the sole
// boot path. See REFACTOR_NOTES.md for the deletion list.
// ============================================================================
async function runNonAdRuntime({ config, logger }) {
  // 2026-09-24 R91.2 鈥?osInfo is now module-level (hoisted from here to
  // agent.js top). The previous shadowing const inside this function put
  // the variable in TDZ for any code path that ran before this line.

  // 1. Self-register once on boot. The endpoint is idempotent (upsert
  //    discovered_via='self-register'), so it's safe to retry on transient
  //    failures. Fire-and-forget with a logger breadcrumb so a center
  //    outage at boot doesn't block the heartbeat from coming up.
  async function selfRegister() {
    // 2026-09-24 R91.4 鈥?used to call `requestJson` with only the
    // X-Agent-Token header. self-register hits the agentMw-protected
    // /api/admin/member-servers/self-register endpoint, which goes
    // through agent-token.js S82 identity binding; without the signature
    // header the request 401s after the 60s grace window. Switched to
    // signedRequestJson with the same triple used by the other agent
    // 鈫?center POSTs (heartbeat/report) 鈥?keeps the HMAC contract
    // uniform across every endpoint that talks to the centre.
    const r = await signedRequestJson({
      method: 'POST',
      url: `${config.centerUrl}/api/admin/member-servers/self-register`,
      agentToken: config.agentToken,
      hostname: config.hostname || osInfo.hostname,
      agentId: config.agentId,
      body: {
        hostname: config.hostname || osInfo.hostname,
        agentVersion: VERSION,
        osVersion: osInfo.version,
        ipAddress: osInfo.ip
      },
      timeoutMs: 30_000
    });
    if (!r.ok) {
      logger.warn({ status: r.status, error: r.error, hostname: osInfo.hostname }, 'self-register failed (best-effort)');
    } else {
      logger.info({ hostname: osInfo.hostname }, 'self-register ok');
    }
  }
  // Fire on boot, do not await (the brief shows a non-blocking start so
  // the agent comes up even if the center is briefly unreachable).
  selfRegister();

  // 2. Per-host package fetcher. We do NOT use the legacy
  //    PackageManager's /api/agent/packages endpoint because that route
  //    only returns globally-enabled packages; for non-AD we need the
  //    per-host merged list (server-group bindings + globally enabled)
  //    and the in-agent filter that selects only non-ad / windows
  //    packages. The shape returned by /api/admin/agent/packages-for-host
  //    is { items: Manifest[] }; we feed each filtered manifest into a
  //    lightweight one-shot runner, NOT PackageManager (which would
  //    re-derive intervals / disk cache from a different endpoint).
  let cachedPorts = { heartbeatPort: null, reportPort: null };
  let consecutivePortFailures = 0;

  async function refreshAgentPorts() {
    const r = await fetchConfig({ centerUrl: config.centerUrl, agentToken: config.agentToken });
    if (r.ok && r.data) {
      cachedPorts.heartbeatPort = Number(r.data.heartbeatPort) || null;
      cachedPorts.reportPort    = Number(r.data.reportPort)    || null;
      return true;
    }
    return false;
  }

  async function refreshAgentPortsWithRecovery(trigger) {
    const ok = await refreshAgentPorts();
    if (ok) { consecutivePortFailures = 0; return; }
    consecutivePortFailures++;
    const enabled = trigger === 'boot' ? config.scanOnBoot : config.scanOnRuntimeFail;
    if (!enabled) {
      logger.warn({ trigger, centerUrl: config.centerUrl }, 'fetchConfig failed; scan disabled by config');
      return;
    }
    // At boot: scan on first failure (spec 搂1.2 鈥?agent must self-heal on
    // startup when appsettings.json is stale). At runtime: only after
    // scanFailureThreshold consecutive failures (spec 搂1.3).
    if (trigger === 'runtime' && consecutivePortFailures < config.scanFailureThreshold) {
      logger.warn({ trigger, consecutivePortFailures, threshold: config.scanFailureThreshold }, 'config fetch failed; will retry on next tick');
      return;
    }
    const rec = await tryRecoverCenterPort({ config, configPath, logger, trigger });
    if (rec.recovered) consecutivePortFailures = 0;
  }

  await refreshAgentPortsWithRecovery('boot');

  // Local cache of which packages are currently scheduled. The center is
  // the source of truth; on every poll we diff against the previously-
  // scheduled set and (re)start / stop timers accordingly. The map + the
  // timer-scheduling functions live in src/non-ad-scheduler.js so unit
  // tests can import the SAME functions the runtime uses 鈥?no re-statement,
  // no drift 鈥?and assert handle stability across polls (regression test
  // for the timer-starvation bug where unconditional clearInterval on every
  // 5-minute poll reset the countdown for any package whose intervalSec was
  // >= 300, so it never fired).
  // R158.72.x.12 B' (2026-10-17) — pending-trigger fan-out (NoAD 端,
  //   1:1 平行 AD PackageManager.runTriggersNow). wire t.triggerOnce
  //   =true → fire-once path: 调 runPackage 跑 1 次 + fireOnceFor 清
  //   对应 timer (跟 R158.60.10 on-demand skip + removeCache
  //   line 308-312 范式 1:1 平行). triggerOnce=false (默认) 走老路径
  //   = 单纯 fire-and-forget 跑 (跟 cron 兜底 1:1 平行, 0 启 setInterval
  //   因为 runPackage 自己就不启).
  function runTriggersNow(packagesTriggers) {
    const list = Array.isArray(packagesTriggers) ? packagesTriggers : [];
    if (list.length === 0) return { count: 0 };
    const known = new Map();
    // 0 持 pkg.version 严格, NoAD 的 wire 字段跟 AD 略有不同 (只持
    //   scriptPath + agent.intervalSec + agent.timeoutMs). 已知
    //   状态从 localTasks 拿 (走 peekLocalTaskNames 非破坏性视图 —
    //   跟 startTimerFor 持的 {timer, intervalSec} 1:1 平行) — 这是
    //   NoAD 跟 AD 的关键差异: AD localTasks 持 full pkg ref, NoAD
    //   localTasks 只持 timer ref. 所以 NoAD 端 fireOnceFor 接受 name
    //   即可, 跟 AD 持 pkg.name 1:1 平行.
    for (const name of peekLocalTaskNames()) known.set(name, { name });
    let triggered = 0, skipped = 0;
    for (const t of list) {
      const name = t && (t.packageName || t.name);
      if (!name) continue;
      // NoAD 端 runPackage 自身做路径校验 (safeJoin / resolveIfInside),
      //   0 必从 center 拿 full manifest. fireOnceFor 走 localTasks
      //   Map 找 timer; 没 timer 的情况是 R158.60.10 intervalSec<=0
      //   skip (走 noop reason).
      if (t.triggerOnce === true) {
        const result = fireOnceFor(name);
        logger.info({
          event: 'non-ad.runTriggersNow.triggerOnce',
          name,
          action: result.action,
          reason: result.reason
        }, 'triggerOnce: NoAD 端 fire-once 清理');
      }
      // 必跑 1 次 (跟 AD 1:1 平行 runTriggersNow → runOne). NoAD
      //   端必 wire 已知 pkg, 否则 runPackage 自己 skip-and-log.
      if (known.has(name)) {
        runPackage(known.get(name));
        triggered++;
      } else {
        skipped++;
        logger.debug({ name }, 'non-ad runTriggersNow: package not in localTasks (no scheduled timer + not in known set)');
      }
    }
    logger.info({
      event: 'non-ad.runTriggersNow',
      count: list.length,
      triggered,
      skipped
    }, 'non-ad trigger fan-out complete');
    return { count: triggered + skipped, triggered, skipped };
  }

  function runPackage(pkg) {
    // v1 contract: /api/admin/agent/packages-for-host returns parsed
    // manifests WITHOUT a top-level scriptPath 鈥?the agent is expected to
    // derive it from a local cache directory once package materialization
    // is wired. v1 has no materialization path, so we skip-and-log when
    // scriptPath is missing rather than crashing spawn() with undefined.
    //
    // 2026-10-21 (security + 按操作员确认的契约"中心下发包, 本地执行"):
    //   路径不再由中心给绝对路径, 而是本地按 name/version 派生 ——
    //     <agentDataDir>\packages\<name>\<version>\collect.ps1
    //   name/version 必须通过 isSafeSegment (禁 .. / 分隔符 / 冒号),
    //   派生结果再由 safeJoin 确认落在包目录内。
    //
    //   为什么改: 改动前 pkg.scriptPath 是中心 manifest 的任意字段, 原样进
    //   spawn(powershell -File <path>) (package-runner.js:51, 零校验)。
    //   中心只要在 manifest_json 里填一个绝对路径, 就能让每台 NOAD agent
    //   以 SYSTEM 权限执行任意文件 —— 与 run-member-script 的
    //   Invoke-Expression 串成完整链。当前 DB 里 14 个包均无该字段
    //   (走下面的 skip 分支), 但那是"没人填"而非"填了也不生效"。
    const packagesRoot = joinPath(config.agentDataDir || '', 'packages');

    // 1) 中心若显式给了 scriptPath, 先确认它落在包目录内 (兼容既有 manifest)。
    let scriptPath = null;
    if (pkg.scriptPath) {
      try {
        // 归一化后必须仍在 packagesRoot 之下 —— resolveIfInside 定义在文件头,
        // 逻辑与 safeJoin 相同但允许绝对路径输入。
        const resolved = resolveIfInside(packagesRoot, pkg.scriptPath);
        if (!resolved) throw new Error(`scriptPath escapes package root: ${pkg.scriptPath}`);
        scriptPath = resolved;
      } catch (err) {
        logger.warn({ name: pkg?.name, scriptPath: pkg.scriptPath, error: err.message },
          'non-ad package rejected: unsafe scriptPath');
        return;
      }
    } else if (isSafeSegment(pkg?.name) && isSafeSegment(pkg?.version)) {
      // 2) 常规路径: 本地按 name/version 派生。
      try {
        scriptPath = safeJoin(packagesRoot, pkg.name, pkg.version, 'collect.ps1');
      } catch (err) {
        logger.warn({ name: pkg?.name, version: pkg?.version, error: err.message },
          'non-ad package rejected: unsafe name/version');
        return;
      }
    } else {
      logger.debug({ name: pkg?.name, version: pkg?.version },
        'non-ad package: no usable scriptPath and name/version unusable, skipping');
      return;
    }

    // Fire-and-forget; errors logged inside runPackageScript.
    import('./src/package-runner.js').then(({ runPackageScript }) => {
      runPackageScript({
        scriptPath,
        params: pkg.params || {},
        timeoutMs: pkg.agent?.timeoutMs || 30_000,
        logger,
        powerShellPath: config.powerShellPath
      }).then((result) => {
        // Best-effort report POST; failures are dropped (no on-disk
        // queue for non-AD in v1 鈥?packages are heartbeat-lightweight
        // metrics, not critical replication data).
        //
        // 2026-09-24 R91.4 鈥?packages/report is behind agentMw + S82,
        // so stamp the (hostname, agentId, body) signature like the rest
        // of the centre-facing POSTs.
        return signedRequestJson({
          method: 'POST',
          url: `${config.centerUrl}/api/admin/agent/packages/report`,
          agentToken: config.agentToken,
          hostname: config.hostname || osInfo.hostname,
          agentId: config.agentId,
          body: {
            runs: [{
              packageName: pkg.name,
              hostname: config.hostname || osInfo.hostname,
              ...result
            }]
          },
          timeoutMs: 30_000
        });
      }).catch((e) => {
        logger.warn({ err: e.message, name: pkg.name }, 'non-ad package run failed');
      });
    }).catch((e) => {
      logger.warn({ err: e.message, name: pkg.name }, 'non-ad package runner import failed');
    });
  }

  async function pollPackages() {
    const hostname = config.hostname || osInfo.hostname;
    // 2026-09-24 R91.4 鈥?packages-for-host is behind agentMw + S82.
    // Without X-Agent-Signature it 401s after the 60s grace window,
    // so non-AD agents stop receiving their package manifest and
    // never run anything. Switched to signedRequestJson so the GET
    // (no body) gets the proper empty-body signature.
    const r = await signedRequestJson({
      method: 'GET',
      url: `${config.centerUrl}/api/admin/agent/packages-for-host?hostname=${encodeURIComponent(hostname)}`,
      agentToken: config.agentToken,
      hostname,
      agentId: config.agentId,
      timeoutMs: 30_000
    });
    if (!r.ok) {
      logger.warn({ status: r.status, error: r.error }, 'non-ad packages-for-host poll failed');
      return;
    }
    const items = Array.isArray(r.data?.items) ? r.data.items : [];
    applyPackageList(items, runPackage);
  }

  // Initial poll + periodic refresh (every 5 minutes, same cadence as the
  // AD runtime's configRefresh). The first poll may race with the
  // self-register fire-and-forget above; that's fine 鈥?center tolerates
  // a package poll from an unknown hostname (returns empty list).
  pollPackages();
  const packagesRefresh = setInterval(() => {
    pollPackages().catch((e) => logger.warn({ err: e.message }, 'non-ad packages poll crashed'));
  }, 5 * 60_000);

  // 3. Heartbeat loop. Same /api/agent/heartbeat endpoint as the AD flow,
  //    but with agentType: 'non-ad' and the host's hostname so the
  //    center can route into the member-servers touchLastSeen path
  //    (Task 6 of the non-AD plan).
  //
  // 2026-10-01 R158.13 鈥?assign into the module-scope `let heartbeat`
  // slot (line 429) so non-AD heartbeat can be restart()'d when a
  // settingsPatch envelope arrives. Mirror of the AD-runtime patch above.
  // R158.86.6 (2026-10-12) — file-push drainer wiring. 3 HTTP helpers
  // injected into drainFilePush, all backed by signedRequestJson so the
  // centre's identity middleware (HMAC + 4-身份 header) accepts every
  // request. httpGetBinary is a thin Buffer-collecting GET because
  // signedRequestJson hard-codes Content-Type: application/json which
  // would corrupt the octet-stream download bytes.
  const httpGetJson = ({ url, headers, timeoutMs }) =>
    signedRequestJson({
      method: 'GET', url, headers, body: null,
      timeoutMs: timeoutMs || 30_000,
      agentToken: config.agentToken,
      hostname: config.hostname || osInfo.hostname,
      agentId: config.agentId || osInfo.hostname
    });
  const httpPostJson = ({ url, headers, body, timeoutMs }) =>
    signedRequestJson({
      method: 'POST', url, headers, body,
      timeoutMs: timeoutMs || 15_000,
      agentToken: config.agentToken,
      hostname: config.hostname || osInfo.hostname,
      agentId: config.agentId || osInfo.hostname
    });
  // Binary GET — download endpoint returns application/octet-stream with
  // X-File-Sha256 header (see routes/agent.js:985-988). We capture the
  // header so drainFilePush can compare the wire sha256 against the task
  // record (file-push-drainer.js:25).
  const httpGetBinary = ({ url, headers, timeoutMs }) => new Promise((resolve) => {
    let u;
    try { u = new URL(url); }
    catch (e) { return resolve({ ok: false, status: 0, error: `bad url: ${e.message}` }); }
    const lib = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = lib({
      method: 'GET', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: { ...headers }, timeout: timeoutMs || 60_000
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          buffer: Buffer.concat(chunks),
          headerSha256: res.headers['x-file-sha256'] || null
        });
      });
    });
    req.on('error', err => resolve({ ok: false, status: 0, error: err.message, buffer: null }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
  const drainerHostname = config.hostname || osInfo.hostname;
  const drainerAgentId  = config.agentId || osInfo.hostname;

  heartbeat = startHeartbeat({
    intervalMs: Math.max(1, config.heartbeatIntervalSeconds) * 1000,
    payload: () => ({
      agentId: drainerAgentId,
      agentVersion: VERSION,
      hostname: drainerHostname,
      agentType: 'non-ad',
      pendingQueueSize: 0,
      // 2026-08-21 UX redesign: same contract as AD runtime — see
      // applyAgentTokenDelivery for the response-side handling.
      agent_token_version: Number(config.agentTokenVersion) || 0
    }),
    // R158.86.6 (2026-10-12) — switch from inline arrow to makeSendCallback.
    // The inline arrow bypassed the drainers pool (heartbeat-callbacks.js:108-119
    // allSettled saw drainFilePush=undefined and short-circuited), so file-push
    // tasks accumulated as 'queued' forever. The 4 inline awaits are moved
    // verbatim into the postHeartbeat wrapper below — do NOT drop any of them
    // (applySettingsDelivery / applyUpgradeDelivery are still load-bearing for
    // settingsPatch + agent auto-update on the non-AD path).
    send: makeSendCallback({
      // 1:1 verbatim move of the previous inline arrow body. Closes over
      // cachedPorts (heartbeat port) and the surrounding config / logger
      // / heartbeatRef / boundFetchUpgrade — same closure shape as before.
      postHeartbeat: async (p) => {
        const r = await postHeartbeat({
          centerUrl: config.centerUrl,
          agentToken: config.agentToken,
          port: cachedPorts.heartbeatPort,
          // R93.2 — explicit hostname + agentId; payload already has them
          // but passing them explicitly matches the AD-runtime path and
          // protects against payload-shape regressions.
          hostname: drainerHostname,
          agentId: drainerAgentId,
          payload: p
        });
        await applyAgentTokenDelivery({ result: r, config, configPath, logger });
        // 2026-10-01 R158.13 — non-AD path also consumes settingsPatch.
        await applySettingsDelivery({ result: r, config, configPath, logger, heartbeat: heartbeatRef.current });
        // R158.48 (2026-10-06) — agent auto-update (non-AD path).
        await applyUpgradeDelivery({ result: r, agentInstallDir: __dirname, config, configPath, logger, fetchUpgrade: boundFetchUpgrade });
        return r;
      },
      applyAgentTokenDelivery,
      scheduler,
      logger,
      getPendingClear,
      setPendingClear,
      // drainFilePush wired here — closes over the 3 http helpers above.
      // drainMemberCommands stays null in R158.86.6: its dispatcher
      // (dispatchMemberCommand) needs additional wiring that's out of
      // scope for this ship; it remains a no-op until a follow-up.
      drainFilePush: () => drainFilePush({
        hostname: drainerHostname,
        agentId: drainerAgentId,
        token: config.agentToken,
        centerUrl: config.centerUrl,
        httpGetJson, httpGetBinary, httpPostJson,
        logger
      }),
      drainMemberCommands: null,
      // R158.72.x.12 B' (2026-10-17) — pending-trigger wire 真实现
      //   (NoAD 端). 之前 R158 ship 时 makeSendCallback 已留 slot
      //   (heartbeat-callbacks.js:84, 116-118), 但 agent.js 一直没把
      //   runTriggeredPackages 实现传给 callback, 所以 NoAD 端
      //   packagesTriggers 一直走 Promise.resolve() noop. 本 ship 闭合
      //   这个 gap. 走 runPackage (fire-and-forget 1 跑 0 启 setInterval)
      //   + fireOnceFor (clearInterval 已 schedule 的 timer, 跟 AD
      //   package-manager.js runOne 末尾的 onceOnly 清理 1:1 平行).
      //   0 改 makeSendCallback 内部 (slot 已就位).
      runTriggeredPackages: (packagesTriggers) => runTriggersNow(packagesTriggers)
    })
  });

  // 4. Periodically refresh the cached heartbeat-port override + retry
  //    self-register every 30 minutes (in case the agent started
  //    before center or before DNS).
  const configRefresh = setInterval(async () => {
    await refreshAgentPortsWithRecovery('runtime');
    selfRegister();
  }, 30 * 60_000);

  logger.info({ hostname: osInfo.hostname, centerUrl: config.centerUrl, agentType: 'non-ad' }, 'non-ad agent started');

  const shutdown = async (sig) => {
    logger.info({ sig }, 'non-ad agent shutting down');
    heartbeat.stop();
    clearAllTimers();
    clearInterval(packagesRefresh);
    clearInterval(configRefresh);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}