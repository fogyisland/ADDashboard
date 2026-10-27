import express from 'express';
import { createApp, errorMiddleware } from './src/app.js';
import { loadConfigOrNull, defaultConfig, getRegistryUrl, seedListenPortIfMissing, getListenPort, sha256Hex } from './src/config.js';
import { healthzRouter } from './src/routes/healthz.js';
import { init, close, getDb } from './src/db/index.js';
import { createLogger, createRotatedLogger, withModuleLogger, createMultiRotatedLogger } from './src/logger.js';
import { startServers, closeAll } from './src/multi-port.js';
import { authRouter } from './src/routes/auth.js';
import { agentRouter } from './src/routes/agent.js';
import { dashboardRouter } from './src/routes/dashboard.js';
import { adminRouter } from './src/routes/admin.js';
import { filePushRouter } from './src/routes/file-push.js';
import { dcsRouter } from './src/routes/dcs.js';
import { lockoutRouter } from './src/routes/lockout.js';
import { failedLogonRouter } from './src/routes/failed-logon.js';
import { schemaMigrationsRouter } from './src/routes/schema-migrations.js';
import { heartbeatReportRouter } from './src/routes/heartbeat-report.js';
import { systemRouter } from './src/routes/system.js';
import { systemSettingsRouter } from './src/routes/system-settings.js';
// R158.88.B (2026-10-13) — agent upgrade rollout orchestration router.
//   7 端点 + tickRolloutScheduler 5min cadence. 0 改 fleet 端.
import { rolloutRouter, tickRolloutScheduler } from './src/routes/rollout.js';
// R158.X (2026-10-15) — 账户变更明细 sub-tab (AccountChangeDetailView) 3 endpoint.
//   平行 failedLogonRouter / eventlogRouter (userAuth ONLY, no requirePerm).
import { accountChangeRouter } from './src/routes/account-change.js';
// R158.110 (2026-10-16) — 报表中心 admin-only API (/api/report-center/*,
//   3 endpoint: lockout-top / failed-logon-top / account-change-daily).
//   0 改 3 老 endpoint, 0 改 agent, 0 改 schema. 跟 R158.61 reports / R158.68
//   system-alerts / R158.100.B email-queue 1:1 平行 admin perm gate.
import { reportCenterRouter } from './src/routes/report-center.js';
// R158.88.B (2026-10-13) — getAgentUpgradeSourceSnapshot for rollout scheduler
//   to read boot-time cached source version (跟 R158.48 agent-upgrade.js:56
//   reader 1:1 平行). 0 改 agent 端.
import { getAgentUpgradeSourceSnapshot } from './src/routes/agent-upgrade.js';
// R112 — public no-auth eventlog router. EventlogView is reachable before
// login (operator directive "在没有登录页面也会显示出这个界面效果"), so this
// is mounted alongside /api/init (no auth deps passed to the factory).
import { eventlogRouter } from './src/routes/eventlog.js';
// R116 — OS Baseline 前台舰队视图. Operator directive (2026-09-26):
// "我们不需要在admin后台看到，直接在前台就可以看到" — same auth
// contract as the R112 eventlog router (userAuth ONLY, no requirePerm).
// Reads only — writes happen via the agent-side collect.ps1 + centre
// metricstore.ingestRunV2 path.
import { osBaselineRouter } from './src/routes/os-baseline.js';
// R158.77 (2026-10-11) — public read-only surface for the non-AD
// member-server fleet. Powers /memberServer/* sub-tabs (首页 / OS
// 基线 / Agent 列表 / 应用端口 / 包). Same auth contract as
// osBaselineRouter + eventlogRouter (R112): userAuth ONLY, no
// requirePerm — operator wants this on the regular user side, NOT
// admin. See routes/member-servers-public.js for inner contract.
import { memberServersPublicRouter } from './src/routes/member-servers-public.js';
import { createProbeLoop } from './src/services/probe.js';
// R158.68 (2026-10-10) — 系统内置告警 (替代 R158.62/63/67 createAlertEvaluationLoop).
// 5 detector 共享 system_alerts 表, 邮件走 system_alert_outbox.
import { createSystemAlertLoop } from './src/services/system-alert-engine.js';
import { createEmailDeliveryLoop } from './src/services/email.js';
import { createAuditRetentionLoop } from './src/services/audit.js';
import { createEventlogRetentionLoop } from './src/services/eventlog.js';
// R158.78 (2026-10-12) — ad_member_eventlog_* 24h retention loop (member-server
//   事件日志专表). 跟 R112 4h/24h 双 sweep 不同, 简化单 24h (member fleet
//   规模小, 一刀切). 跟 createEventlogRetentionLoop 平行 (start/stop/tick).
import { createMemberEventlogRetentionLoop } from './src/services/member-eventlog.js';
// R158.86 (2026-10-12) — ad_member_os_baseline* 7d retention sweep. 跟
//   memberEventlog 平行: start/stop/tick, 6h cadence (member 流量小, 不需要
//   1h cadence; 跟 member_eventlog 1h 不同, 因为 OS baseline 7d × 5 metric 每
//   分钟一采, 1h cadence DELETE 数据量更大). retentionDays 走 service 内部
//   默认 7d (v1 简化, 未来要可配再走 system_config.ad_member_os_baseline_retention_days).
import { createMemberOsBaselineRetentionLoop } from './src/services/member-os-baseline.js';
import { createFailedLogonRetentionLoop } from './src/services/failed-logon.js';
// R158.61 (2026-10-10) — daily / weekly email report scheduler + retention.
// Reads report_daily_cron / report_weekly_cron / *_enabled / report_retention_days
// from system_config on every tick. 5min scheduler cadence (clamped to
// 10s floor), 24h retention cadence. Mounted in normal-mode only.
import { createReportLoop } from './src/services/report-scheduler.js';
import { createReportRetentionLoop } from './src/services/report-retention.js';
// R158.License-expiry (2026-10-15) — 5min cadence license 状态切换 cron.
//   跟 createReportLoop 1:1 平行 shape. 0 触碰 report / email / 其他 scheduler.
import { createLicenseExpiryLoop } from './src/services/license-expiry-scheduler.js';
// R158.69 (2026-10-10) — EmailConfigView 新页签 "邮件历史" retention loop.
// 跟 report-retention 同 factory, 跨 system_alert_outbox + report_email_outbox 两表.
import { createEmailHistoryRetentionLoop } from './src/services/email-history-retention.js';
// R158.72 (2026-10-11) — ad_account_change 公共表 retention sweep (24h cadence).
import { createAdAccountChangeRetentionLoop } from './src/services/ad-account-change-retention.js';
// R158.69.9 (2026-10-11) — file-push stale claim auto-fail + 7d retention.
// 5min cadence (短, 不让 stale claim 累积), 单 detector 走 sweepStaleClaims
// + purgeOldTasks 两阶段. R158.51 baseline freeze + R158.68.1 inline
// ALTER 模式 — 0 schema migration, system_config lazy INSERT on first tick.
import { createFilePushRetentionLoop } from './src/services/file-push-retention.js';
// R158.19 (2026-10-01) — package_runs retention sweep. Reads
// package_runs_retention_days from system_config on each tick so operators
// can tune retention without restarting. Hard-coded 1h cadence (mirrors
// auditRetentionLoop + eventlogRetentionLoop). Wired AFTER eventlogRetention
// because eventlog tables are added by migration 026, while package_runs is
// from migration 023 — both must be live, both are.
import { createPackageRunsRetentionLoop } from './src/services/package-runs-retention.js';
import { createAdMgmtAuditRetentionLoop } from './src/services/ad-mgmt-audit-retention.js';
// R158.48 (2026-10-06) — agent auto-update. Reads <repoRoot>/agent/build-manifest.json
// + walks agent.js + src/**/*.js at boot, caches as JSON bundle for GET /api/agent/upgrade.
import { getAgentUpgradeSource } from './src/services/agent-upgrade-source.js';
import { setAgentUpgradeSource } from './src/routes/agent-upgrade.js';
import { createDirectorySyncLoop } from './src/services/directory-sync-loop.js';
// R155.6 — operator directive "另外我们新建一个脚本,定期更新 inbound_partner
// 和outbound_partner". Periodic refresh of ad_dc_inbound_partners +
// ad_dc_outbound_partners warehouse tables from ad_replication_status.
// 5-min cadence, immediate first run on boot, swallows per-row errors
// so a single bad row doesn't fail the whole cycle. Mirrors the
// createEventlogRetentionLoop (R148) pattern for cadence + lifecycle.
import { startDcPartnersRefresh } from './src/services/dc-partners-refresh.js';
// R158.72.x.5 (2026-10-16) — R159 dead code 激活. startCentreCron = R158.159
//   retired 后中心端 cron 通用 scheduler (R158.69.3 0 改 agent binary).
//   DEFAULT_SCHEDULES 现在含 ad_partner_inbound_discover (R157.4) +
//   ad_account_change (R158.72.x.5 24h cadence + Jitter 0~30min per-DC).
import { startCentreCron, stopCentreCron, DEFAULT_SCHEDULES } from './src/services/cron-scheduler.js';
import { startSchedulers as startR114Schedulers, stopSchedulers as stopR114Schedulers } from './src/init/scheduler-bootstrap.js';
// R158.89 (2026-10-13) — member-port-probe scheduler. 跟 R114 DC port-probe
//   scheduler 1:1 平行 shape (ad-hoc factory 不抽 init/scheduler-bootstrap,
//   跟 R158.88 tickRolloutScheduler 1:1 平行).
import { startMemberPortProbeScheduler } from './src/services/member-server-port-probe.js';
import { initRouter } from './src/init/router.js';
import { createPackagesRouter } from './src/packages/router.js';
import { orphanRouter } from './src/packages/orphan-router.js';
import { packageRunner } from './src/packages/runner.js';
import { memberRouter } from './src/routes/member-servers.js';
import { agentPackagesRouter } from './src/routes/agent-packages.js';
import { agentToken } from './src/auth/agent-token.js';
import { checkNeedsInit } from './src/init/needs-init.js';
import { closeWizardFacade } from './src/init/wizard-facade.js';
import { hasMarker, writeMarker, installPathFromConfigPath } from './src/init/marker.js';
import { userAuth } from './src/auth/user-auth.js';
// R158.102 (2026-10-14) — MCP (Model Context Protocol) Streamable HTTP server
//   + admin endpoints for mcp_api_token rotation lifecycle. Mounted on web
//   app (port 8080). 0 改 userAuth / agentToken, 0 改 60+ 既有端点.
//   8 read-only tools 1:1 wrap 既有 services (R158.86.6 #5 lesson 第 16 次).
import { mcpToken } from './src/auth/mcp-token.js';
import { mcpRouter } from './src/routes/mcp.js';
import { adminMcpRouter } from './src/routes/admin-mcp.js';
import { seedMcpTokenIfMissing } from './src/services/mcp-token.js';
// R158.113 (2026-10-17) — MCP write tools (6 AD write actions). 1:1 平行
//   /mcp 范式: path-scope mount '/mcp-write', mcpWriteToken middleware
//   早于 mcpWriteRouter apply, adminMcpWriteRouter 走 /api/admin 4 endpoint
//   跟 adminMcpRouter 1:1 平行. 0 me 端 (操作员 directive "个人账户默认不能申请写入").
import { mcpWriteToken } from './src/auth/mcp-write-token.js';
import { mcpWriteRouter } from './src/routes/mcp-write.js';
import { adminMcpWriteRouter } from './src/routes/admin-mcp-write.js';
import { seedMcpWriteTokenIfMissing } from './src/services/mcp-write-token.js';
// R158.104 (2026-10-14) — self-service /api/me/* routers (Profile /
// change-password / logout-all + MCP token 申请). 1:1 平行
// adminMcpRouter shape (factory + requireAuth inject), 但 0 requirePerm
// (跟 R112 eventlog / R116 os-baseline 1:1 平行 precedent). 操作员
// 决策 "所有登录 user 都可见".
import { createMeRouter } from './src/routes/me.js';
import { createMeMcpRouter } from './src/routes/me-mcp.js';
import { requirePerm } from './src/auth/rbac.js';
import { getConfig as getSystemConfig, getConfigMap, seedSmtpDefaultsIfMissing, seedLdapDefaultsIfMissing, seedReportsDefaultsIfMissing } from './src/services/config.js';
import { writeAudit } from './src/services/audit.js';
import { seedBuiltinPackages } from './src/services/builtin-packages.js';
import { backfillRootDomains } from './src/services/ad-forest-registry.js';
// R158.61 (2026-10-10) — daily / weekly email report admin endpoints
// (run / history / preview). Same auth posture as admin.js (userAuth +
// admin:config perm), applied inside the router.
import { createReportsRouter } from './src/routes/reports.js';
// R158.68 (2026-10-10) — 系统内置告警 admin API (替代 R158.62/67 createAlertInboxRouter).
import { createSystemAlertsRouter } from './src/routes/system-alerts.js';
// R158.69 (2026-10-10) — 邮件历史 admin API (EmailConfigView 新 tab). 单 endpoint
// GET /api/admin/email-history. 跟 system-alerts.js / reports.js 完全隔离
// (operator "用到端点新建" 指令), 不动老 routes.
import { createEmailHistoryRouter } from './src/routes/email-history.js';
// R158.X.99.34.d (2026-10-19) — in-app notification list endpoint.
//   操作员 directive "操作员登录 dashboard 后,在 dashboard 内部推送/显示告警
//   消息给管理员". 独立 router file 1:1 平行 createEmailHistoryRouter (同 factory
//   shape, 同 guard). 0 改 routes/system-alerts.js (10 端点 preserved). 端点
//   GET /api/admin/system-alerts/since 走 listSince SQL helper (mysql + mssql 双
//   dialect), 客户端 watermark polling 派生 3 类 state-transition 推 in-app toast.
import { createSystemInappNotificationsRouter } from './src/routes/system-inapp-notifications.js';
// R158.100.B (2026-10-14) — 邮件队列 admin API (EmailConfigView 7th tab).
// 跟 email-history 1:1 平行 (同 factory shape, 同 guard). 3 endpoint
// (GET list / POST retry / DELETE by id). 不动 email-history / 0 改 service
// / 0 改 schema. UNION ALL 跨 2 表, retry 不重置 att, 硬删走 markExhausted
// 双层防御 (R158.100-fix ship 时已就位).
import { createEmailQueueRouter } from './src/routes/email-queue.js';
// R158.100.C (2026-10-14) — AD 操作通知 admin API (EmailConfigView 3rd tab).
//   1 endpoint POST /api/admin/ad-notify/preview. 跟 email-queue 1:1 平行
//   (同 factory shape, 同 guard). 0 改 email-queue / 0 改 service / 0 改
//   emailLoop UNION 3 表 (system_alert + report + ad_notify).
import { createAdNotifyRouter } from './src/routes/ad-notify.js';
// R158.87 (2026-10-12) — system-settings 域 admin API: feature flags + license.
// 平行 ship 跟 systemSettingsRouter (R114 runtime settings) 完全隔离,
// 路径前缀 /api/admin/system-settings-v2/* 区分. 7 endpoint (admin:config +
// userAuth-only 各 5/2). 0 perm 新建 (沿用 admin:config).
import { createSystemSettingsV2Router } from './src/routes/system-settings-v2.js';

// Build the three independent Express apps that server.js will run:
//   - webApp:        admin UI, auth, dashboard, init routes (existing scope)
//   - heartbeatApp:  POST /api/agent/heartbeat (light, frequent)
//   - reportApp:     POST /api/agent/report + /discover + GET /config (heavy, sparse)
//
// heartbeat/report are isolated so they can run on separate ports (firewall
// rules, dedicated nginx upstreams). The contract is consumed by Tests 1–3
// (the `mount` parameter on agentRouter gates which routes each app exposes)
// and by the runtime IIFE below which feeds the three apps to startServers.
export function buildServerApps({ config, db, logger, needsInit, systemConfig = {}, moduleLoggers = {}, featureLoggers = {} }) {
  // systemConfig shape: { heartbeat_port, report_port, heartbeat_stale_seconds }
  // — same key naming as the system_config table (Task 1). When the table is
  // unreachable (init mode / db not yet bootstrapped) the caller passes an
  // empty object and we fall back to the documented defaults (8081, 8082).
  const heartbeatPort = Number(systemConfig.heartbeat_port) || 8081;
  const reportPort    = Number(systemConfig.report_port)    || 8082;

  // Web app: createApp gives us healthz + static + SPA fallback + JSON body
  // parsing + the req.log middleware. Routes are mounted below in the IIFE
  // because they need init-mode vs normal-mode branching and auth deps that
  // are only valid after the DB is up.
  const webApp = createApp({ config, db, logger, needsInit });

  // heartbeatApp — small payloads, tight body limit. Only the heartbeat
  // subset of agentRouter is mounted (the `mount` gate from Task 3).
  const heartbeatApp = express();
  heartbeatApp.disable('x-powered-by');
  heartbeatApp.use(express.json({ limit: '256kb' }));
  // /healthz must be reachable on all three apps (web/heartbeat/report) so
  // an external monitor (k8s liveness probe, LB health check) can hit any
  // of the three ports and get the same DB-aware status. healthz is an
  // unauthenticated GET, so order doesn't matter — mount before
  // agentRouter so it's first-match.
  heartbeatApp.use(healthzRouter({ logger }));
  // agentRouter factory calls getDb() eagerly to construct the agentToken
  // middleware. In init mode db is null → throw → bubbles up to the IIFE
  // .catch → process.exit → NSSM restart loop. heartbeatApp isn't listened
  // in init mode anyway (see the `if (needsInit)` branch in the IIFE), so
  // just skip the agentRouter mount there.
  if (!needsInit) {
    // R119 — bind every heartbeat request's req.log to the heartbeat module
    // logger. withModuleLogger rebinds req.log so pino-http + downstream
    // handlers write to logs/APP/heartbeat.log instead of the global log.
    // See src/logger.js for the rebind semantics (pino-http reads req.log
    // at response-finish; a .child() would also work but a direct rebind
    // keeps the call-site contract uniform).
    heartbeatApp.use(withModuleLogger(moduleLoggers.heartbeat, { component: 'heartbeat' }));
    heartbeatApp.use(agentRouter({ config, logger, mount: 'heartbeat' }));
    // S3 (2026-09-30) — error middleware was previously webApp-only.
    // A throw on a heartbeat route returned an empty body (Express
    // default), causing agents to enter a retry loop. See
    // dashboard-code-review-2026-09-30.md S3.
    heartbeatApp.use(errorMiddleware({ logger }));
  }

  // reportApp — replication snapshots can be 10MB+ (12+ rows × long error
  // strings). Only the report subset of agentRouter is mounted.
  const reportApp = express();
  reportApp.disable('x-powered-by');
  reportApp.use(express.json({ limit: '10mb' }));
  reportApp.use(healthzRouter({ logger }));
  if (!needsInit) {
    // R119 — bind every report (v2 package runs) request's req.log to the
    // agent module logger. /api/agent/packages/report is the bulk-payload
    // path; isolates logs/APP/agent.log from heartbeat floods so an
    // operator tailing the bulk-payload stream isn't drowned by 60s
    // heartbeats.
    reportApp.use(withModuleLogger(moduleLoggers.agent, { component: 'agent' }));
    reportApp.use(agentRouter({ config, logger, mount: 'report' }));
    // S3 (2026-09-30) — mirror the heartbeat app error middleware mount
    // so a throw on /api/agent/packages/report returns a proper 500
    // JSON envelope instead of an empty body that hangs the agent.
    reportApp.use(errorMiddleware({ logger }));
  }

  return {
    webApp,
    heartbeatApp,
    reportApp,
    ports: {
      web: config.listenPort,
      heartbeat: heartbeatPort,
      report: reportPort
    }
  };
}

const configPath = process.argv[2] || process.env.APPSETTINGS_PATH || './appsettings.json';
const installPath = installPathFromConfigPath(configPath);

// Fatal-trap registration MUST happen synchronously at module load so that
// tests that mock `process.on` (see init-mode-survival.test.js) see the
// uncaughtException / unhandledRejection listeners immediately on import.
// The bootstrap below installs the rotated logger into these traps via
// setFatalLogger — until that happens, the traps use the sync stderr
// fallback (same destination the previous module-top-level logger used).
// Without this split, the tests' `await import('...')` would race the
// bootstrap's `await createRotatedLogger(...)` and the listeners would
// appear missing.
const fatalState = { logger: null };
function setFatalLogger(logger) { fatalState.logger = logger; }
process.on('uncaughtException', (err, origin) => {
  const log = fatalState.logger || createLogger({ component: 'center', level: 'info' });
  if (err && err.message && err.message.startsWith('db not initialized')) {
    log.warn({ err: err.message, origin }, 'init-mode uncaughtException (kept alive)');
    return;
  }
  log.fatal({ err: err && err.message, stack: err && err.stack, origin }, 'uncaughtException');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const log = fatalState.logger || createLogger({ component: 'center', level: 'info' });
  const err = reason instanceof Error ? reason : new Error(String(reason));
  if (err.message && err.message.startsWith('db not initialized')) {
    log.warn({ err: err.message }, 'init-mode unhandledRejection (kept alive)');
    return;
  }
  log.fatal({ err: err.message, stack: err.stack }, 'unhandledRejection');
  process.exit(1);
});

// Main-entry guard. When this module is `import`ed (e.g. by tests calling
// `buildServerApps`) we must NOT fire the runtime IIFE — that would try to
// read appsettings, open a DB, and bind a real port inside the test process
// (with predictably bad consequences). Only run the bootstrap when invoked
// directly via `node server.js [configPath]`. We compare pathToFileURL of
// process.argv[1] against import.meta.url — works on both Windows
// (drive-letter case) and POSIX, and is robust to symlinks.
import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

// ESM has no __dirname — derive it from this file's URL so we can locate
// sibling directories (publish/ in particular, for the built-in package
// seed). Used by the seedBuiltinPackages call below.
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = dirname(__dirname);

// Locate the built-in package source from either the source-tree view
// (cwd=center, __dirname=repo/center) or the bundled publish view
// (cwd=publish, __dirname=publish/system/center). The bundled view puts
// the package source alongside the script; the source view walks up to
// the repo root then descends into publish/system/. Both layouts are
// tried so the same server.js works whether launched via `npm start`
// (cwd=repo-root), `cd center && node server.js` (cwd=center), or from
// the bundled publish/system/center/server.js.
const builtinSourceCandidates = [
  join(repoRoot, 'publish', 'system', 'center', 'data', 'packages'),
  join(__dirname, 'data', 'packages')
];
const resolveBuiltinSourceDir = () => {
  const found = builtinSourceCandidates.find(d => existsSync(d));
  if (!found) throw new Error(`seedBuiltinPackages: source not found in any candidate: ${builtinSourceCandidates.join(', ')}`);
  return found;
};

if (invokedDirectly) {
await ((async () => {
  // Create the rotated-file logger FIRST — every subsequent log line
  // (bootstrap progress, runtime diagnostics, fatal traps) lands in
  // <installPath>/logs/center.log via pino-roll's daily rotation. Sync
  // SonicBoom writes preserve the "fatal line survives process.exit()"
  // guarantee the previous stderr logger had. See src/logger.js for the
  // full rationale; NSSM AppStderr must be cleared by the installer so
  // pino-roll is the sole writer of this file (see install-center.ps1).
  const logFile = process.env.ADDASHBOARD_LOG_FILE
      || join(installPath, 'logs', 'center.log');
  const logger = await createRotatedLogger({
    component: 'center',
    level: 'info',
    file: logFile
  });

  // Hand the rotated logger to the fatal-trap handlers that were registered
  // synchronously at module load (above). Until this point the traps used
  // a sync stderr fallback — the file-open side effect of createRotatedLogger
  // must not run during import (tests import buildServerApps from this
  // module and need zero file-open side effects). The handlers keep the
  // same behavior either way (sync destination + process.exit), so this
  // handoff is invisible to the rest of the system.
  setFatalLogger(logger);

  // R119 — per-module/per-route server-side log directory (logs/APP/).
  // Three module loggers, each writing to <installPath>/logs/APP/<name>.log
  // via pino-roll daily rotation. The middleware (withModuleLogger) rebinds
  // req.log on each mount point so handlers + pino-http emit into the
  // module-specific file. See src/logger.js for the full rationale and the
  // "APP/ isolates each route so operator can tail -f one endpoint without
  // grep'ing past 60s of heartbeats" invariant.
  const moduleLoggers = await createMultiRotatedLogger({
    modules: [
      { name: 'agent', component: 'agent' },
      { name: 'heartbeat', component: 'heartbeat' },
      { name: 'init', component: 'init' },
      { name: 'web', component: 'web' }
    ],
    baseDir: installPath
  });

  // R149 — per-business-feature log directory (logs/FEATURE/). 6 顶级
  // 业务模块各自一个文件 + 日轮转:
  //   os_baseline / lockout / eventlog / partner_port / replication /
  //   heartbeat. heartbeat 复用 R119 既有 moduleLogger（同一个 logger 实例
  //   写入 logs/APP/heartbeat.log），其它 5 个新模块写入 logs/FEATURE/<name>.log。
  // 这样 operator 排查"OS Baseline / Lockout / Eventlog"这类按面板事件
  // 时不必混入 60s 心跳；按传输层 (R119) / 按业务面板 (R149) 两套切片互
  // 不重复。withModuleLogger 与 R119 用法完全相同，仅 subDir 不同。
  const featureLoggers = await createMultiRotatedLogger({
    subDir: 'FEATURE',
    modules: [
      { name: 'os_baseline',  component: 'os_baseline' },
      { name: 'lockout',      component: 'lockout' },
      { name: 'eventlog',     component: 'eventlog' },
      { name: 'partner_port', component: 'partner_port' },
      { name: 'replication',  component: 'replication' },
      { name: 'failed_logon', component: 'failed_logon' },
      // R158.77 (2026-10-11) — non-AD member-server fleet endpoints.
      // routes/member-servers-public.js wraps the /api/dashboard/member-*
      // family so admin/operator can grep FEATURE/member_servers.log
      // separately from os-baseline / eventlog.
      { name: 'member_servers', component: 'member_servers' }
      // heartbeat 复用 R119 moduleLogger（同一实例）— 不在此处重写，
      // 避免双写双份日志。
    ],
    baseDir: installPath
  });

  // R119.B / R119.B.UPGRADE — boot version anchor. Read build-manifest.json
  // (committed source of truth — see R119 spec §3) and emit one structured
  // line at boot. The line is the first-line defence against R118.4-style
  // "binary serving stale R66-pre V0 mount chain" incidents: any operator
  // who runs `grep R119 logs/center.log` and sees nothing knows the binary
  // predates R119. features is the comma-separated tag list so operators
  // can verify exact R-round support without scraping git log.
  let buildManifest = null;
  try {
    const manifestPath = join(repoRoot, 'build-manifest.json');
    const raw = await readFile(manifestPath, 'utf8');
    buildManifest = JSON.parse(raw);
  } catch (err) {
    logger.warn({ err: err.message }, 'build-manifest.json unreadable; boot fingerprint degraded');
  }
  const packageJson = (() => {
    try { return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')); }
    catch { return null; }
  })();
  // Hoist `db` to a `let` declared BEFORE the fingerprint so the dialect
  // field can read db?.dialect without hitting a TDZ ReferenceError. The
  // later init/config branch reassigns `db` after the bootstrap completes;
  // this declaration only exists to give the fingerprint line a stable
  // binding. Without the hoist the line `dialect: db?.dialect ?? null` was
  // tripping ESM static-binding rules (`Cannot access 'db' before
  // initialization`), and NSSM was restarting 8080 in a tight loop.
  // See R119.B.UPGRADE Task 12 hotfix for the post-ship regression.
  let db = null;

// R158.X.116.p.3 (2026-10-23) — 取 rounds 里真正的「最新轮次」id。
//
// 背景: 原来的 `rounds.slice(-1)[0]?.id` 取数组**物理最后一项**, 隐含
// 「数组按 ship 顺序严格升序」这个从未成立的假设 —— 实际 rounds 是乱序的
// (R119 在最前、R66 在最后), 所以那行一直返回 "R66", 比当时实际进度落后
// 50+ 轮, 且 0 报错。字段有值但值是错的, 比 null 更危险: 操作员会以为
// 中心端还在 R66。
//
// ⚠ 实现上刻意**不用正则**: 本项目 id 有 5 种格式并存 ——
//    R119 / R118.4 / R114.A / R110.A.1 / R158.X.116.p.3
// 第一版用 /^R(\d+)(?:[.\-_](\d+))?…/ 只对 R119 / R118.4 有效, 碰到
// 'X' 分隔符就整段丢失 (实测 R158.X.116 只捕获到 "158"), 于是 R158.X.99.36
// 和 R158.X.116 退回比较物理序 —— 又一次「看起来有排序、实际没排序」。
// 改为按分隔符切段 + 逐段比较, 与格式无关。
//
// 比较规则: 逐段比; 数字段按数值比, 字母段按字母序比; 一方段数用尽而
// 另一方还有 → 段数多者更大 (R93.1 > R93)。无法解析的 id 排在最后。
function compareRoundIds(a, b) {
  // ⚠ 第一段必须先剥掉 'R' 前缀, 否则 'R119' / 'R66' 都判为非纯数字而走
  //   字母比较 —— 字典序下 '1' < '6', 会得出 R66 > R119 的荒谬结果
  //   (第一版就栽在这, 实测 R119 < R66)。
  const strip = (s) => String(s || '').replace(/^[Rr]/, '');
  const sa = strip(a).split(/[.\-_+]/);
  const sb = strip(b).split(/[.\-_+]/);
  const n = Math.max(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    const x = sa[i];
    const y = sb[i];
    if (x === undefined) return -1;      // a 段数更少
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d) return d < 0 ? -1 : 1;
    } else if (nx !== ny) {
      return nx ? 1 : -1;               // 数字段 > 字母段 (R110.A < R110.1)
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function latestRoundId(rounds) {
  if (!Array.isArray(rounds) || !rounds.length) return null;
  let best = null;
  for (const r of rounds) {
    const id = r?.id;
    if (!id || !/^R/i.test(String(id))) continue;
    if (best === null || compareRoundIds(id, best) > 0) best = id;
  }
  return best;
}

  // R158.48 (2026-10-06) — agent auto-update. Read <repoRoot>/agent/build-manifest.json
  // + tree walk agent.js + src/**/*.js at boot, bind result into the upgrade
  // router's module-level cache. The route then ships it to /api/agent/upgrade.
  // Refresh: boot-only. Operator must `nssm restart center` to pick up new agent code.
  let agentUpgradeSource = null;
  try {
    const agentRoot = join(repoRoot, 'agent');
    agentUpgradeSource = await getAgentUpgradeSource(agentRoot, logger);
    setAgentUpgradeSource(agentUpgradeSource, logger);
  } catch (err) {
    logger.warn({ err: err.message }, 'agent upgrade source load threw; non-fatal');
    setAgentUpgradeSource(null, logger);
  }

  logger.info({
    bootFingerprint: true,
    centerVersion: buildManifest?.version ?? packageJson?.version ?? 'unknown',
    centerBuildTime: buildManifest?.buildTime ?? null,
    centerGitCommit: buildManifest?.gitCommit ?? null,
    centerRounds: buildManifest?.rounds?.length ?? 0,
    // R158.X.116.p.3 — 原为 `rounds.slice(-1)[0]?.id`, 取的是数组**物理最后
    //   一项**, 隐含「数组按 ship 顺序严格升序」这个从未成立的假设。实际
    //   rounds 是乱序的 (R119 在最前、R66 在最后), 于是这行一直返回
    //   "R66" —— 比当时实际进度落后 50+ 轮, 且 0 报错。这正是注释
    //   (:425) 里担心的「操作员 grep R119 看日志什么都不知道」的同型问题:
    //   字段有值, 但值是错的, 比 null 更危险。
    //   改为按 R 编号数值取最大, 不依赖数组物理顺序。
    centerLatestRound: latestRoundId(buildManifest?.rounds),
    centerFeatures: buildManifest?.features ?? null,
    installPath,
    nodeVersion: process.version,
    pid: process.pid,
    dialect: db?.dialect ?? null,
    listenPort: await getListenPort().catch(() => null),
    // R158.48 — agent upgrade fingerprint fields (mirror of center build-manifest shape).
    // Reads from the local var (set above) instead of the router module's closure to
    // avoid a circular import dance; setAgentUpgradeSource already emitted its own line.
    agentVersion: agentUpgradeSource?.version ?? 'unavailable',
    agentUpgradeFileCount: agentUpgradeSource?.fileCount ?? 0,
    agentUpgradeReady: !!(agentUpgradeSource?.available)
  }, 'center boot fingerprint');

  // Init-complete marker (file + registry) hard-locks the wizard off once
  // /finalize has run. Checked first so an attacker who deletes appsettings.json
  // cannot re-trigger the wizard without also clearing the marker.
  const markerLocked = await hasMarker(installPath);

  let config = loadConfigOrNull(configPath);
  // `db` was hoisted to the top of the bootstrap IIFE so the boot
  // fingerprint line can read db?.dialect without a TDZ ReferenceError.
  // We reassign it after db.init() returns successfully further below.
  if (config) {
    // Marker only locks the wizard off; DB still needs to initialize for
    // normal-mode routes to work. If init fails, only fall through to init
    // mode when the wizard is NOT locked (otherwise we'd let an operator
    // recover a broken DB by re-running init, which the marker forbids).
    try {
      // DB H4 (2026-09-22): thread getDataDir + writeAudit through to
      // db.init() so the bootstrap backfill (which runs inside db.init)
      // can invoke a .js migration helper like R66's
      // 023-package-scripts-policies-split.js with the right args.
      // Both are optional — pre-009 deployments hit the upgrade path
      // (real data migration), fresh installs hit the safe no-op path.
      await init(config, {
        repoRoot,
        getDataDir: () => join(repoRoot, 'data', 'packages'),
        writeAudit
      });
      db = getDb();
    } catch (err) {
      logger.warn({ err: err.message }, 'db init failed');
      if (markerLocked) {
        logger.error('db init failed and wizard is locked by marker — refusing to start. To recover: restore db connectivity (preferred) OR clear the marker + appsettings.json to re-run the wizard.');
        process.exit(2);
      }
      logger.warn('falling back to init mode');
      config = null;
      db = null;
    }
  }
  if (markerLocked) logger.info('init marker present; wizard locked out');
  // Refuse to start in normal mode if marker says init is done but config is
  // missing — that's an inconsistent state that would let /api/auth/* crash
  // with "db not initialized". Operator must clear the marker (and restore or
  // rebuild appsettings.json) before the service can run.
  if (markerLocked && !config) {
    logger.error('init marker present but config missing — refusing to start. To recover: restore appsettings.json (preferred) OR clear the ADDASHBOARD_INITIALIZED key in .env + registry value AND delete appsettings.json to re-run the wizard.');
    process.exit(2);
  }
  const needsInit = markerLocked ? false : await checkNeedsInit(db);

  // Auto-apply pending DB migrations on every normal-mode startup. Runs
  // BEFORE buildServerApps so routes that reference newly-added columns
  // (e.g. ad_agent_heartbeat.report_requested_at from migration 018) see
  // the schema they expect. Idempotent — already-applied migrations are
  // skipped in one cheap SELECT. Wrap in try/catch so a failed migration
  // never blocks the server from serving (the failed row is recorded in
  // schema_migrations with status='failed' and surfaces via the admin
  // migrations UI for operator inspection).
  //
  // This is the safety net that makes start.ps1's "Restart-Service"
  // fallback work: when the API endpoint isn't available (first deploy of
  // /api/system/update, or rollback), the new code still applies its own
  // pending migrations on the next startup instead of crashing.
  if (!needsInit && db) {
    try {
      const { createMigrationsService } = await import('./src/services/migrations.js');
      const migrationService = createMigrationsService({
        db, logger,
        getRepoRoot: () => repoRoot,
        writeAudit, // 2026-08-29 R66 — bulk_migrate audit row on data-migration JS sidecar
        getDataDir: () => join(repoRoot, 'data', 'packages') // matches seedBuiltinPackages dataDir convention
      });
      const migrationResult = await migrationService.upgrade({ appliedBy: 'startup' });
      // R158.51 baseline freeze 后 upgrade() 的返回 shape 是
      // { ok, migrations:{applied,failed}, message } —— seed 字段已随
      // db.schema_seed.checksum 一起删除 (migrations.js:384 注释明写)。
      // 这里曾读 migrationResult.seed.ran, 每次启动都抛 TypeError 被下面的
      // catch 吞成 warn —— 即 baseline 真的应用了 1 个也永远不会记日志。
      // 改判 ok + applied.length, 跟 migrations 的实际契约一致。
      if (!migrationResult.ok || migrationResult.migrations.applied.length > 0) {
        logger.info({
          applied: migrationResult.migrations.applied.length,
          failed: migrationResult.migrations.failed.length,
          message: migrationResult.message
        }, 'startup auto-migration');
      }
    } catch (e) {
      logger.warn({ err: e.message }, 'startup auto-migration failed; continuing with current schema');
    }
  }
  // R158.X.115 (2026-10-20) — ad_dcs discovery UPSERT 的退役标记保护。
  //
  //   2026-10-23: 原来的启动期运行时改写整块删掉了。
  //   它做的是 dc.upsertDc = applyDcUpsertGuard(dc.upsertDc, 'mysql') ——
  //   而 buildSql() 对每个 domain 都 Object.freeze, ESM 严格模式下这行
  //   必然抛 "Cannot assign to read only property 'upsertDc'", 被本块自己的
  //   catch 吞成一条 warn。**保护从来没有生效过。** 只要退役 DC 的 agent
  //   还在跑 collect-discovery.ps1, 全量覆盖 UPSERT 就会把退役标记冲掉。
  //
  //   现在 guard 由 buildSql() 在构造期、freeze 之前施加 (纯函数, 见
  //   src/db/sql.js), 保护是 SQL 树的一部分, 不依赖启动顺序, 也就不需要
  //   这里再确认一次 —— 没有可确认的运行时状态了。
  //
  //   注: 生命周期列 (decommissioned_at / monitoring_paused_at) 本身的 DDL
  //   已在 2026-10-22 收进 db/migrations/{mysql,mssql}/1.0.0-baseline.sql 的
  //   标准模板 (新建库由 CREATE TABLE 建全, 存量库由守卫 ALTER 兜底)。
  const finalConfig = config ?? defaultConfig();

  // Read multi-port settings from system_config (only in normal mode — the
  // table doesn't exist yet during init). Fall back to {} so the helper
  // resolves the 8081/8082 defaults documented in the spec.
  let systemConfig = {};
  if (!needsInit) {
    try {
      systemConfig = await getSystemConfig();
    } catch (err) {
      logger.warn({ err: err.message }, 'system_config read failed; using port defaults');
    }
  }

  // Seed listenPort into system_config on first boot, then write the
  // started_version hash so the UI's restart badge can compare pending vs
  // started. Done BEFORE buildServerApps so the value is on disk by the
  // time anything that depends on it (probe service in Task 3) reads it.
  // Idempotent: re-running writes the same hash, no audit row, no side-effects.
  if (!needsInit && db) {
    try {
      await seedListenPortIfMissing(logger);
      const listenPort = await getListenPort();
      const startedVersion = sha256Hex(`${new Date().toISOString()}:${listenPort}`);
      await db.execute(
        db.sql.config.upsert,
        ['center_listen_port_started_version', startedVersion]
      );
      logger.info({ listenPort, startedVersion }, 'center listenPort bound');
    } catch (err) {
      logger.warn({ err: err.message }, 'listenPort seed/version write failed; continuing with appsettings.json value');
    }
    // Seed SMTP + alert-engine defaults (Task 12). Idempotent — only writes
    // rows that are absent. Done in the same normal-mode gate as the
    // listenPort seed so the rows exist before the alert/email loops boot.
    try {
      await seedSmtpDefaultsIfMissing(logger);
    } catch (err) {
      logger.warn({ err: err.message }, 'SMTP defaults seed failed; alerts may be misconfigured');
    }
    // R158.35 (2026-10-03) — seed AD LDAP sync defaults. Five rows
    // (ad_ldap_url / ad_bind_dn / ad_bind_password / ad_base_dn /
    // ad_sync_interval_minutes). Empty url/bind password = sync disabled
    // (loop tick short-circuits, manual trigger returns 500).
    // R158.46.1 (2026-10-06) — 改单位 小时→分钟, 旧 key 由 migration 迁.
    try {
      await seedLdapDefaultsIfMissing(logger);
    } catch (err) {
      logger.warn({ err: err.message }, 'LDAP defaults seed failed; directory sync may be misconfigured');
    }
    // R158.61 (2026-10-10) — seed daily / weekly email report defaults.
    // 10 rows: report_{daily,weekly}_{enabled,cron,to,cc} +
    // report_loop_interval_seconds + report_retention_days. Empty to/cc
    // falls back to alert_default_to in reports.js enqueueReport.
    try {
      await seedReportsDefaultsIfMissing(logger);
    } catch (err) {
      logger.warn({ err: err.message }, 'report defaults seed failed; scheduler may be misconfigured');
    }
    // R158.100.C (2026-10-14) — seed AD 操作通知 defaults. 5 key
    // (ad_notify_enabled/to/cc/subject_template/body_template). 0 ALTER
    // 既有 system_config 行 (operator 已 touch 的值保留). 跟 seedReports
    // 1:1 平行, 0 强制覆盖 operator 已有配置.
    try {
      const { seedAdNotifyDefaultsIfMissing } = await import('./src/services/config.js');
      await seedAdNotifyDefaultsIfMissing(logger);
    } catch (err) {
      logger.warn({ err: err.message }, 'ad notify defaults seed failed; notifications will not enqueue');
    }
    // R158.AdminEmail (2026-10-15) — 管理员邮件通知收件人 KV (admin_email).
    //   操作员 directive 2026-10-15 "在系统配置中写入管理员邮件地址".
    //   新建独立 config_key, 跟 4 个既有 seed 函数 1:1 平行, 默认空字符串
    //   (T-5 决策, 跟 R158.69 SMTP config smtp_host/smtp_user 默认空 1:1).
    //   收件人供 export-request / activate 2 端点 fire-and-forget 调
    //   enqueueLicenseNotify 使用. 0 强制覆盖 operator 已有配置.
    try {
      const { seedAdminEmailDefaultIfMissing } = await import('./src/services/config.js');
      await seedAdminEmailDefaultIfMissing(logger);
    } catch (err) {
      logger.warn({ err: err.message }, 'admin email default seed failed; license notifications will not enqueue');
    }
    // R158.46.1 — boot-time 一次性迁移 老 key ad_sync_interval_hours
    //   → 新 key ad_sync_interval_minutes (× 60). 已迁过 skip, 非致命.
    try {
      const { migrateIntervalHoursToMinutes } = await import('./src/services/config.js');
      await migrateIntervalHoursToMinutes(logger);
    } catch (err) {
      logger.warn({ err: err.message }, 'interval-hours migration failed; non-fatal');
    }
    // R158.46.4 (2026-10-06) — boot-time 一次性 backfill:
    //   (a) NULL task_id 老行 → 复用 _buildTaskId(targetDc) 跟 queue 时刻同 helper
    //   (b) audit_logs 缺失 ad_command_timeout row → 补写 (R158.46.1 之前 sweep 漏)
    // 跟 R158.46.1 / R158.38.4 同模式: 已迁过 skip, 非致命, log.
    try {
      const { backfillAdAdminCommandData } = await import('./src/services/ad-admin-commands.js');
      const r = await backfillAdAdminCommandData({ logger });
      if (r.taskIdBackfilled > 0 || r.auditBackfilled > 0) {
        logger.info({ component: 'ad-admin-backfill', ...r }, 'R158.46.4 backfill done');
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'R158.46.4 ad-admin backfill failed; non-fatal');
    }
    // R158.56.1 (2026-10-08) — 修复 sql.js adAdminCommands.getById 漏
    //   SELECT c.task_id → completeCommand → agent.js /result handler 写入
    //   audit row 时 payload.taskId=null 的历史 audit row.
    // SQL fix (sql.js:1687/3804 加 c.task_id SELECT) 让新写入正常. 已存的
    //   audit row immutable, 需要 boot-time 一次性 backfill 修历史:
    //   JOIN ad_admin_commands c ON JSON_VALUE(a.payload,'$.commandId') = c.id
    //   UPDATE payload.taskId = c.task_id WHERE taskId IS NULL AND c.task_id
    //   IS NOT NULL.
    try {
      const { backfillAuditTaskId } = await import('./src/services/ad-admin-commands-audit-backfill.js');
      const r = await backfillAuditTaskId({ logger });
      if (r.updated > 0) {
        logger.info({ component: 'ad-admin-audit-taskid-backfill', ...r }, 'R158.56.1 backfill done');
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'R158.56.1 audit taskId backfill failed; non-fatal');
    }
    // R161.16 (2026-10-27) — audit_logs 时间戳基准的单一真源 + 旧基准行回填。
    //   缺陷面: MySQL 基线 audit_logs.created_at 是
    //     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ⇒ DEFAULT 取**会话时区**
    //     的墙钟。R161.10 之前中心端没钉会话时区, 于是"钉之前"写下的那些行
    //     存的是服务器本地墙钟 (本机 CST +480 分钟), 而前端统一把 naive
    //     DATETIME 当 UTC 解读 ⇒ /admin/audit 的「变更」「安全」两个 tab
    //     整体晚 8 小时。
    //   本次做两件事:
    //     1) 向前: sql.js 的 audit.write 改成显式写 UTC_TIMESTAMP() /
    //        SYSUTCDATETIME(), 新写入的行不再依赖会话时区 (根因修复)。
    //     2) 向后: 从 audit_logs 自己的 payload 里反推每行的写入基准, 找出
    //        旧基准行的分界, 落进 system_config 的单一真源, 并按真源把旧
    //        基准行平移成真 UTC (前像先落 audit_logs_utc_baseline_backup,
    //        可逆、可审计)。
    //   判定不出来时**只 warn 一行数据都不改** —— 宁可让老行晚 8 小时显示,
    //   也不能把本来对的行改错。
    try {
      const { ensureAuditUtcBaseline } = await import('./src/services/audit-utc-baseline.js');
      const r = await ensureAuditUtcBaseline({ logger });
      if (r && r.status !== 'skipped' && r.status !== 'no_db') {
        logger.info({ component: 'audit-utc-baseline', ...r }, 'R161.16 audit UTC baseline');
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'R161.16 audit UTC baseline failed; non-fatal');
    }
    // R158.38.4 (2026-10-03) — backfill root domains for forests created
    // before this round. createForest now auto-inserts a role='root' row, but
    // pre-R158.38.4 forests have none. Run once at startup; idempotent.
    try {
      await backfillRootDomains({ logger });
    } catch (err) {
      logger.warn({ err: err.message }, 'backfill root domains failed');
    }
    // I3: seed agent-token bundle from appsettings.json on first boot.
    // After this point, runtime reads from system_config.agent_token_current;
    // appsettings.json is bootstrap-only. Idempotent (no-op if row exists) and
    // also auto-expires any stale agent_token_previous past TTL (spec §1.4).
    // Wrapped in try/catch to mirror the other seed calls in this gate — a
    // transient DB error here must not crash the bootstrap; the middleware
    // will surface a 503 on the first agent request if the row is missing.
    try {
      const { seedAgentTokenIfMissing } = await import('./src/services/agent-token.js');
      await seedAgentTokenIfMissing(db, finalConfig.agentToken, logger);
    } catch (err) {
      logger.warn({ err: err.message }, 'agent token seed failed; agents will fail auth until DB row is populated');
    }
    // R158.License-config (2026-10-15) — boot-time lazy 写 appsettings.json.signature
    //   + installedAt. 走 patchConfigAtomic (init/config-writer.js tmp+rename),
    //   失败不致命 (warn log). 在 normal-mode 第一次启动执行, init-mode 跳过
    //   (wizard 期间不污染 config). Idempotent: 已存在值不覆盖 (R158.License-config
    //   lesson #3).
    try {
      const { ensureSignatureAndInstalledAt } = await import('./src/services/license-validator.js');
      ensureSignatureAndInstalledAt(configPath, logger);
    } catch (err) {
      logger.warn({ err: err.message }, 'ensureSignatureAndInstalledAt failed; non-fatal');
    }
    // R158.102 (2026-10-14) — seed mcp_api_token bundle from system_config
    //   on first boot. 0 从 appsettings.json 读 (跟 userAuth / agentToken
    //   1:1 平行 — system_config 才是 runtime source of truth). 第一次
    //   boot 必 log "operator must run reveal" warn, 跟 jwt_secret seed
    //   1:1 平行. Idempotent no-op if row already present.
    try {
      await seedMcpTokenIfMissing(db, logger);
    } catch (err) {
      logger.warn({ err: err.message }, 'mcp token seed failed; /mcp will 503 until DB row is populated');
    }
    // R158.113 (2026-10-17) — seed mcp write token (跟 seedMcpTokenIfMissing 1:1 平行).
    //   第一次 boot 必 log "operator must run reveal" warn, 跟 mcp_token seed 1:1 平行.
    //   Idempotent no-op if row already present. 0 改老 8 read tool 跟老 4 mcp_token lifecycle.
    try {
      await seedMcpWriteTokenIfMissing(db, logger);
    } catch (err) {
      logger.warn({ err: err.message }, 'mcp write token seed failed; /mcp-write will 503 until DB row is populated');
    }
    // I9: seed jwt-secret bundle from appsettings.json on first boot.
    // After this point, runtime reads from system_config.jwt_secret_current;
    // appsettings.json is bootstrap-only. Idempotent (no-op if row exists) and
    // also auto-expires any stale jwt_secret_previous past TTL (default 30d).
    // Same try/catch pattern as agent-token above: a transient DB error here
    // must not crash bootstrap; userAuth will surface a clear failure on the
    // first login attempt if the row is missing.
    try {
      const { seedJwtSecretIfMissing } = await import('./src/services/jwt-secret.js');
      await seedJwtSecretIfMissing(db, finalConfig.jwtSecret, logger);
    } catch (err) {
      logger.warn({ err: err.message }, 'jwt secret seed failed; logins will fail until DB row is populated');
    }
  }

  // Seed built-in packages (e.g. ad_os_baseline) into data/packages/<name>/<version>/
  // on first normal-mode start. Runs after listenPort seed (same normal-mode
  // gate `!needsInit && db`) and BEFORE buildServerApps so the agent package
  // runner can read the cached collect.ps1 from the same path it uses for
  // downloaded packages. Idempotent: skips file copy if <dataDir>/<name>/<version>/manifest.json
  // already exists, but re-runs the installed_packages DB upsert on every
  // normal-mode restart — that's the round-12 fix for runAllNow count:0
  // (the upsert recovers installs where files were seeded pre-DB-registration
  // and the agent therefore saw zero packages).
  // Source is bundled at publish/center/data/packages/ — that mirror is
  // maintained by the mirror script (publish/build) so this seeder stays
  // consistent with what gets shipped in publish.zip.
  if (!needsInit && db) {
    try {
      await seedBuiltinPackages({
        dataDir: process.cwd() + '/data/packages',
        sourceDir: resolveBuiltinSourceDir(),
        writeAudit,
        db,
        // R161.5 (2026-10-26) — 把 pino logger 传进去. seeder 内部的
        // per-package 失败必须落文件日志, 否则 operator 在 center 日志里
        // 看不到"哪个包没 seed 上、为什么" (stdout 是空的).
        logger
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'built-in package seed failed; non-AD package runner will skip until next restart');
    }
  }

  const apps = buildServerApps({ config: finalConfig, db, logger, needsInit, systemConfig, moduleLoggers, featureLoggers });

  // Declared at module scope so the normal-mode bootstrap below can assign
  // it and the normal-mode shutdown handler can stop it. The init-mode
  // branch never starts a probe loop (no DB) and so leaves this as null.
  let probeLoop = null;
  // R114 — centre-side port-probe scheduler (separate from the 1 Hz self
  // probe loop above). Container returned by startR114Schedulers(); the
  // shutdown handler iterates it via stopR114Schedulers().
  let r114Schedulers = null;
  // R158.72.x.5 (2026-10-16) — centre-cron handle (R159 dead code 激活).
  //   挂 module-level ref 跟 R158.86.6 drainer 1:1 平行, shutdown 时
  //   调 stopCentreCron() 必能停 (跟 r114Schedulers / memberPortProbeScheduler
  //   同 pattern).
  let centreCronHandle = null;
  // R158.89 (2026-10-13) — member-port-probe scheduler. 跟 R114 DC
  //   port-probe 1:1 平行 shape: 周期 cadence + boot offset 8s + inFlight
  //   guard + .unref() 不挡 process exit. R158.86.6 enumerate 5 维度
  //   lesson #6 闭合: R158.84 "按需 probe" 接口只 enumerate 接口层, 0
  //   enumerate scheduler 层, 0 周期性 probe + 写表. 本 scheduler
  //   15min cadence, 跟 user 报 "/memberServer/ports 15min 一次" 期望 1:1 平行.
  let memberPortProbeScheduler = null;

  const app = apps.webApp;
  // initRouter is mounted in BOTH modes. The /status endpoint is intentionally
  // reachable in normal mode so the frontend router's `beforeEach` can probe
  // init state without 404 noise. Other init routes stay guarded by the
  // router's internal getNeedsInit() check (only /status is always exposed).
  // R119 — bind every /api/init/* request's req.log to the init module
  // logger. Wizard + finalize traffic is high-volume during first-deploy
  // and audit-sensitive (init logs ship to ops review); isolating
  // logs/APP/init.log means the wizard's chatter never appears in
  // /healthz scrapes or heartbeat log streams.
  app.use('/api/init', withModuleLogger(moduleLoggers.init, { component: 'init' }), initRouter({ logger, configPath, installPath, getNeedsInit: () => needsInit }));
  if (needsInit) {
    logger.info('init mode: serving /api/init/* and /init');
  } else {
    app.use(authRouter({ config: finalConfig, logger, db: getDb() }));
    // System update endpoint (no auth, localhost-only — see system.js for the
    // contract). Mounted before all the admin routers so an operator can
    // trigger an update from the host without needing credentials. The route
    // applies pending DB migrations and schedules process.exit(0) so NSSM
    // picks up the new code on the next launch.
    app.use(systemRouter({
      logger,
      getRepoRoot: () => repoRoot
    }));
    // Bootstrap endpoint for agents (web mount — /config.json only). Lets an
    // agent learn heartbeat/report ports + intervals from the web port
    // without needing to know any other port number up front. The dedicated
    // heartbeatApp / reportApp carry the bulk of agent traffic; web just
    // exposes the bootstrap config the agent reads on startup and on
    // periodic config-refresh ticks.
    // R119 — webApp agent subset (bootstrap config.json + file-push +
    // agent-package-pulls) writes to logs/APP/agent.log. The dedicated
    // heartbeatApp + reportApp already wrap agentRouter with the agent
    // module logger above; the web mount is the third leg of the same
    // /api/agent/* surface.
    app.use(withModuleLogger(moduleLoggers.agent, { component: 'agent' }));
    app.use(agentRouter({ config: finalConfig, logger, mount: 'web' }));
    // R158.102 (2026-10-14) — MCP Streamable HTTP endpoint at POST/GET/DELETE
    //   /mcp + no-auth /mcp/healthz. Mounted BEFORE dashboardRouter (跟
    //   healthz / systemRouter 1:1 平行 — 必在 /api/* 命名空间前). 8 个
    //   read-only tool 1:1 wrap 既有 services. /mcp/healthz 永远 no-auth.
    //   mcpToken middleware 早于 express.json() 应用需要, 但 JSON body
    //   parsing 已被前序 app.use(express.json()) 接管, 0 必新加 parser.
    // R158.103 (2026-10-14) — mcpToken path-scope 到 /mcp, 不再 app 级.
    //   操作员 directive "MCP 服务器采用旁挂模式, 他的 Token 是基于不同的
    //   用户生成. 也就是说 MCP 是走第三个接口, 不走现有的环境接口" → mcpToken
    //   中间件必须只拦 /mcp/* path, 不污染 user auth 链路 (admin / dashboard /
    //   system-settings-v2 / 等).
    //   /mcp/healthz 仍在 mcpToken 内部 line 53-58 short-circuit (公开),
    //   而非用中间件 short-circuit — 后者让 express middleware chain 仍走
    //   后续 path-prefix mcpToken, R158.103 raw 验证 fail.
    app.use('/mcp', mcpToken({ db: getDb(), logger }));
    app.use('/mcp', mcpRouter({ logger, db: getDb() }));
    // R158.113 (2026-10-17) — /mcp-write mount, path-scope (跟 /mcp 1:1 平行 R158.103 锁).
    //   /mcp-write/healthz 公开短路 (跟 /mcp/healthz 1:1 平行), 其它必带
    //   `Authorization: Bearer mcpw_<token>`. 6 write tool 跟 3 on-demand 包 1:1 复用
    //   (ad_ad_users_write / ad_ad_groups_write / ad_ad_account_quickfix, 0 改 agent 二进制 R158.69.3).
    app.use('/mcp-write', mcpWriteToken({ db: getDb(), logger }));
    // R158.113 (2026-10-17) — 跟 admin.js:1854 1:1 平行范式, mcpWriteRouter 内
    //   懒加载 adAdminCommands service (避免 server.js 顶层 import cycle, 跟
    //   admin.js 既有 queueCommand 懒加载 1:1 平行).
    app.use('/mcp-write', mcpWriteRouter({ logger, db: getDb() }));
    // R149 — wrap dashboardRouter with the replication feature logger so all
    // dashboard-router handlers (which mostly serve replication-topology +
    // site-replication-matrix + replication-errors views) write to
    // logs/FEATURE/replication.log. partner_port sub-routes still come through
    // here because they share the router, but their log lines correctly carry
    // the {component:'replication'} binding — the partner_port FEATURE file
    // is reserved for the standalone partner-port-health probe loop's writes
    // (added in a follow-up). Today this is a single combined stream; the
    // partner-port sub-tree gets its own dedicated logger once R149 v2 ships
    // (split by req.path inside dashboardRouter).
    app.use(withModuleLogger(featureLoggers.replication, { component: 'replication' }));
    app.use(dashboardRouter({ config: finalConfig, logger, db: getDb() }));
    app.use(adminRouter({ config: finalConfig, logger, db: getDb() }));
    // R158.102 (2026-10-14) — MCP token admin endpoints (rotate / commit /
    //   state / reveal). 跟 agent-token 1:1 平行: per-route [userAuth,
    //   requirePerm('admin:config')], factory 注入 { db, requireAuth,
    //   requirePerm } 让 test 可 mock.
    app.use(adminMcpRouter({
      db: getDb(),
      requireAuth: userAuth({ db: getDb(), logger }),
      requirePerm: (perm) => requirePerm(perm)
    }));
    // R158.113 (2026-10-17) — admin /api/admin/mcp-write-token/* 4 endpoint
    //   (rotate / commit / state / reveal). 跟 adminMcpRouter 1:1 平行. 0 me
    //   端镜像 (操作员 directive "个人账户默认不能申请写入").
    app.use(adminMcpWriteRouter({
      db: getDb(),
      requireAuth: userAuth({ db: getDb(), logger }),
      requirePerm: (perm) => requirePerm(perm)
    }));
    // R158.104 (2026-10-14) — self-service 路由 (Profile / 改密码 /
    //   logout-all). requireAuth only, 0 requirePerm (跟 eventlog /
    //   os-baseline 1:1 平行). mount 紧跟 adminMcpRouter (避免
    //   R158.103 教训复现 — 必 0 干扰 mcpToken 中间件 chain). 路径
    //   走 /api/me/*, 跟 /mcp/* / /api/admin/* 完全隔离.
    app.use(createMeRouter({
      db: getDb(),
      requireAuth: userAuth({ db: getDb(), logger })
    }));
    // R158.104 — me-side MCP token 路由 (state / reveal / rotate).
    //   1:1 平行 adminMcpRouter shape, 但 0 commit 端点 (commit 保留 admin 端
    //   only, 普通 user 强制 commit = 跨 user AI Agent 立即失效, 跨用户影响
    //   → 0 暴露).
    //
    // F1 (2026-10-20) — requirePerm 现在注入了。reveal + rotate 加
    //   admin:config 门 (跟 adminMcpRouter:36 对齐): mcp_api_token_current
    //   是全局单值不是 per-user, 之前任何登录用户 GET /api/me/mcp-token/reveal
    //   都能读到全系统 AI Agent 在用的 bearer 凭据。state 端点保持
    //   requireAuth-only (只返 boolean + version, 0 泄密).
    app.use(createMeMcpRouter({
      db: getDb(),
      requireAuth: userAuth({ db: getDb(), logger }),
      requirePerm: (perm) => requirePerm(perm)
    }));
    // R158.61 (2026-10-10) — daily / weekly email report admin endpoints
    // (POST /api/admin/reports/run, GET /history, GET /preview). The
    // router internally wires [userAuth, requirePerm('admin:config')] per
    // route (see src/routes/reports.js). Mounted AFTER adminRouter so the
    // /api/admin/* namespace is unambiguous; reports paths don't collide
    // with any existing admin endpoint.
    app.use(createReportsRouter({
      db: getDb(),
      requireAuth: userAuth({ db: getDb(), logger }),
      requirePerm: (perm) => requirePerm(perm)
    }));
    // R158.68 (2026-10-10) — 系统内置告警 admin API (list / recent / kpi /
    // config / ack). 替代 R158.62/67 createAlertInboxRouter (全删). Same
    // auth contract as createReportsRouter (userAuth + admin:users perm).
    app.use(createSystemAlertsRouter({
      db: getDb(),
      requireAuth: userAuth({ db: getDb(), logger }),
      requirePerm: (perm) => requirePerm(perm)
    }));
    // R158.X.99.34.d (2026-10-19) — in-app notification list endpoint.
    //   跟 createSystemAlertsRouter 1:1 平行 (同 db / 同 userAuth / 同 admin:users
    //   perm). 独立 router file mount, 0 改老 routes/system-alerts.js.
    app.use(createSystemInappNotificationsRouter({
      db: getDb(),
      requireAuth: userAuth({ db: getDb(), logger }),
      requirePerm: (perm) => requirePerm(perm)
    }));
    // R158.69 (2026-10-10) — 邮件历史 admin API (EmailConfigView 新 tab).
    // 单 endpoint, UNION ALL 查 system_alert_outbox + report_email_outbox.
    // Auth contract 跟 reports.js / system-alerts.js 同 posture.
    app.use(createEmailHistoryRouter({
      db: getDb(),
      // R161.11 (2026-10-26) — 把 pino logger 传进去。邮件历史/队列两个端点
      //   此前 catch 只回 500 不落日志, NSSM 又丢弃 stderr ⇒ 页面 500 而服务端
      //   零线索。现在每次失败都有 error 级日志 (Logs/center.<date>.<n>.log)。
      logger,
      requireAuth: userAuth({ db: getDb(), logger }),
      requirePerm: (perm) => requirePerm(perm)
    }));
    // R158.100.B (2026-10-14) — 邮件队列 admin API (EmailConfigView 7th tab).
    // 跟 history 1:1 平行, 3 endpoint (list / retry / delete). Auth contract 同.
    app.use(createEmailQueueRouter({
      db: getDb(),
      // R161.11 (2026-10-26) — 同 email-history: logger 传进去, 失败必落 pino。
      logger,
      requireAuth: userAuth({ db: getDb(), logger }),
      requirePerm: (perm) => requirePerm(perm)
    }));
    // R158.100.C (2026-10-14) — AD 操作通知 admin API (EmailConfigView 3rd tab).
    //   1 endpoint preview. 跟 email-queue 1:1 平行 (同 factory, 同 guard).
    app.use(createAdNotifyRouter({
      db: getDb(),
      requireAuth: userAuth({ db: getDb(), logger }),
      requirePerm: (perm) => requirePerm(perm)
    }));
    // R114 — admin runtime-configurable settings (currently just
    // r114_probe_interval_ms). Auth contract matches admin.js
    // (userAuth + admin:config perm). Same factory shape as adminRouter:
    // takes { config, logger, db }; db captured in closure because
    // userAuth middleware doesn't expose db on req.
    app.use(systemSettingsRouter({ config: finalConfig, logger, db: getDb() }));
    // R158.87 (2026-10-12) — feature flags + license admin API. 跟 R114
    // systemSettingsRouter 平行 ship, 不改老 routes. Auth contract 跟 reports.js
    // / system-alerts.js 同 posture: per-route userAuth + admin:config perm.
    app.use(createSystemSettingsV2Router({
      db: getDb(),
      requireAuth: userAuth({ db: getDb(), logger }),
      requirePerm: (perm) => requirePerm(perm),
      logger
    }));
    // R158.88.B (2026-10-13) — agent upgrade rollout orchestration router.
    //   7 端点 (POST/GET/GET/POST pause/resume/abort/rollback) + scheduler.
    //   跟 R114 systemSettingsRouter 1:1 平行: per-route userAuth +
    //   admin:config perm, path-scoped, catch-all 404. 0 改 fleet 端, 0 改
    //   R158.48 fleet 端 upgrade-delivery.js (R158.69.3 lesson 3 永远适用).
    app.use(rolloutRouter({ config: finalConfig, logger, db: getDb() }));
    // 2026-08-30 R65 followup — file push (upload → agent pull → ack).
    // Lives on the web app because operators interact with it from the
    // admin UI; agents pull from /api/agent/file-push which lives in
    // agentRouter mounted above (web mount also exposes it). Both
    // surface the same JSON envelope + audit trail.
    app.use(filePushRouter({ logger, db: getDb() }));
    // DC summary endpoint (Task 4). Mirrors the adminRouter's per-route
    // [userAuth, requirePerm('admin:users')] middleware — the router
    // factory accepts the same auth deps so the per-route chain is
    // identical to other admin read endpoints.
    app.use(dcsRouter({
      requireAuth: userAuth({ db: getDb(), logger }),
      requirePerm: (perm) => requirePerm(perm)
    }));
    // Lockout troubleshooting — multi-filter search across ad_lockout_events.
    // Same auth contract as dcsRouter: per-route [userAuth, requirePerm('admin:users')].
    // R149 — wrap with lockout feature logger so /api/lockout-events/* writes
    // land in logs/FEATURE/lockout.log instead of the global APP/web.log.
    app.use(withModuleLogger(featureLoggers.lockout, { component: 'lockout' }));
    app.use(lockoutRouter({
      requireAuth: userAuth({ db: getDb(), logger }),
      requirePerm: (perm) => requirePerm(perm)
    }));
    // R112 — eventlog (DC 基本情况). Operator directive (2026-09-26):
    // "其实也是需要登录到普通用户界面，普通用户界面可以看到DC基本情况，
    // 后台可以进行管理而已". So this is auth-required BUT does NOT
    // gate on `admin:users` perm — any authenticated user can see DC
    // basic state. Auth contract: userAuth ONLY (no requirePerm). Reads
    // only — writes happen via the runner post-hook + ad_eventlog_collector
    // package + the hourly retention loop.
    // R149 — wrap with eventlog feature logger.
    app.use(withModuleLogger(featureLoggers.eventlog, { component: 'eventlog' }));
    app.use(eventlogRouter({
      requireAuth: userAuth({ db: getDb(), logger })
    }));
    // R158.50 (2026-10-06) — failed-logon 24h/7d line chart dashboard.
    // Same auth contract as eventlog / lockout-accounts recent / os-baseline
    // (userAuth ONLY, no requirePerm — operator dashboard pages visible
    // to all logged-in users). 3 endpoints: timeseries / recent / search.
    app.use(withModuleLogger(featureLoggers.failed_logon, { component: 'failed_logon' }));
    app.use(failedLogonRouter({
      requireAuth: userAuth({ db: getDb(), logger })
    }));
    // R158.X (2026-10-15) — 账户变更明细 sub-tab (AccountChangeDetailView) 的
    //   3 个 endpoint (summary / detail / events). 平行 failedLogonRouter /
    //   eventlogRouter (userAuth ONLY, no requirePerm, 任何登录用户可读). 不
    //   挂 feature logger — 跟 R158.50 failed-logon 一样没独占 module logger,
    //   走默认 root logger. 0 改 ad_account_change / ad_eventlog_events schema.
    app.use(accountChangeRouter({
      requireAuth: userAuth({ db: getDb(), logger })
    }));
    // R158.110 (2026-10-16) — 报表中心 admin API. 跟 createReportsRouter /
    //   createSystemAlertsRouter / createEmailHistoryRouter 1:1 平行
    //   (userAuth + admin:users perm). 0 改 3 老 endpoint, 0 改老 caller.
    app.use(reportCenterRouter({
      db: getDb(),
      logger,
      requireAuth: userAuth({ db: getDb(), logger }),
      requirePerm: (perm) => requirePerm(perm)
    }));
    // R116 — OS Baseline fleet view (前台). Reads only. userAuth-only
    // closure (no requirePerm) — operator wants this on the regular
    // user side, NOT admin. See routes/os-baseline.js for the inner
    // contract and the 5-layer wire (collect.ps1 → metricstore.ingest
    // → pkg_ad_os_baseline.metrics → listLatestPerAgent → this route).
    // R149 — wrap with os_baseline feature logger.
    app.use(withModuleLogger(featureLoggers.os_baseline, { component: 'os_baseline' }));
    app.use(osBaselineRouter({
      requireAuth: userAuth({ db: getDb(), logger })
    }));
    // R158.77 (2026-10-11) — public read-only surface for the non-AD
    // member-server fleet. Same auth contract as osBaselineRouter above.
    app.use(withModuleLogger(featureLoggers.member_servers, { component: 'member_servers' }));
    app.use(memberServersPublicRouter({
      requireAuth: userAuth({ db: getDb(), logger })
    }));
    // Schema migrations admin (list/apply/dry-run/reset). Same auth contract
    // as dcsRouter and lockoutRouter: per-route [userAuth, requirePerm('admin:users')].
    app.use(schemaMigrationsRouter({
      requireAuth: userAuth({ db: getDb(), logger }),
      requirePerm: (perm) => requirePerm(perm),
      logger,
      getRepoRoot: () => repoRoot
    }));
    // Heartbeat/Report admin aggregator (Task 6). Read-only per-agent view
    // joining ad_agent_heartbeat with the latest ad_replication_status
    // snapshot. Same auth contract as the other admin read endpoints above.
    // R149 — wrap with the R119 heartbeat module logger (logs/APP/heartbeat.log).
    // This is the same pino instance used for the heartbeatApp transports, so
    // operator tailing heartbeat traffic gets both transport-layer + admin-
    // aggregator lines in one file. Reuses the existing module logger instead
    // of duplicating into logs/FEATURE/heartbeat.log to avoid double-writing.
    app.use(withModuleLogger(moduleLoggers.heartbeat, { component: 'heartbeat' }));
    app.use(heartbeatReportRouter({
      requireAuth: userAuth({ db: getDb(), logger }),
      requirePerm: (perm) => requirePerm(perm)
    }));
    // Package system routes (Task 6). Both routers apply their own
    // per-route auth (userAuth+requirePerm for admin, agentToken for
    // agent) — Express does not propagate per-route middleware from a
    // sibling Router, so we wire the auth inside each package router
    // factory and pass the config through.
    const pkgDb = getDb();
    // R66 Task 13 — V0 ZIP wrapper is gone (packages/installer.js +
    // installed-packages.js SQL helper were dropped). Only the script-
    // service-backed V1 router remains. writeAudit is now passed through
    // directly because script-service emits the real audit.js shape
    // ({action, target, payload}) — closes the T7 adapter TODO.
    //
    // `adminAuth` is ONE composed thunk (R7-2): the router applies it once
    // via r.use() instead of accepting an array of middlewares. Permission
    // is admin:users — the standard admin perm used by dcsRouter /
    // lockoutRouter / schemaMigrationsRouter (only the `admin` role holds
    // it, via the '*' grant, so this is not a widening).
    app.use(createPackagesRouter({
      db: pkgDb,
      writeAudit: ({ userId, action, target, payload }, tx) => writeAudit({ userId, action, target, payload }, logger, tx),
      adminAuth: (req, res, next) =>
        userAuth({ db: getDb(), logger })(req, res, () =>
          requirePerm('admin:users')(req, res, next)
        ),
      getLogger: () => logger
    }));
    app.use(orphanRouter({
      db: pkgDb,
      config: finalConfig,
      logger
    }));
    app.use(packageRunner({
      db: pkgDb,
      // R66 Task 8 — build the agentToken middleware outside the runner
      // so the test harness can inject its own (the V0 runner did this
      // internally and read config.agentToken, which silently 503'd
      // because the bundle lives in DB only). The runner now expects a
      // pre-built middleware thunk.
      agentMw: agentToken({ db: pkgDb, logger }),
      getLogger: () => logger
    }));
    // Member-server admin routes (Task 6): non-AD inventory CRUD, per-host
    // package bind, and the agent-token self-register endpoint. Lives in a
    // dedicated memberRouter per the no-cross-pollination rule with DC
    // agent routes. Mounted on webApp only — heartbeat/report apps stay
    // focused on DC traffic.
    app.use(memberRouter({
      config: finalConfig,
      logger,
      db: getDb()
    }));
    // Agent-facing per-host package list (Task 8: spec §4.3 / global
    // constraint #14). Sits on the web app so non-AD agents hitting
    // /api/admin/agent/packages-for-host?hostname=... on heartbeat get the
    // merged view of global installed_packages + per-host
    // ad_member_server_packages. Backed by agentToken (NOT userAuth) — the
    // agent has no JWT, only the agent_token from appsettings.json.
    app.use(agentPackagesRouter({
      config: finalConfig,
      logger
    }));
  }

  if (needsInit) {
    // Init mode: the wizard owns the web port. heartbeat/report servers are
    // NOT started — the spec explicitly says agents shouldn't be talking to
    // a half-bootstrapped center, and there's no DB yet to ingest into.
    //
    // EADDRINUSE on the web port must NOT silently exit rc=1 (the .listen
    // callback fires async, and without an `error` listener the event
    // surfaces as uncaughtException → process.exit(1) with no stderr —
    // operator sees nothing useful in start.bat console). The promise form
    // mirrors multi-port.js (server.js:528+) so error messages from a busy
    // port land on the rotated logger instead of being swallowed.
    //
    // R89: the original commit edf0bbe patched only the publish/ mirror;
    // sync-source-mirror then overwrote it back from the source tree and
    // the fix vanished. R90 closes the loop by patching the source too —
    // both halves must agree or the next sync reverts the fix.
    const server = await new Promise((resolve, reject) => {
      const srv = apps.webApp.listen(finalConfig.listenPort, () => {
        logger.info({ port: finalConfig.listenPort, needsInit }, 'center listening (init mode)');
        resolve(srv);
      });
      srv.once('error', (err) => {
        logger.fatal({ err: err.message, code: err.code, port: finalConfig.listenPort },
          'init-mode web listen failed (port busy or permission denied)');
        reject(err);
      });
    });
    const shutdown = async (sig) => {
      logger.info({ sig }, 'shutting down');
      server.close(async () => {
        try { await closeWizardFacade(); } catch {}
        try { await close(); } catch {}
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10000).unref();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } else {
    // Normal mode: three concurrent servers. startServers dedupes by port
    // (the spec says overlapping ports collapse to one server, first wins),
    // so a misconfigured triple-with-same-port falls back to single-server
    // behavior without throwing — matches the documented contract.
    const servers = await startServers({
      logger,
      roleAppPortList: [
        { role: 'web',       app: apps.webApp,       port: apps.ports.web },
        { role: 'heartbeat', app: apps.heartbeatApp, port: apps.ports.heartbeat },
        { role: 'report',    app: apps.reportApp,    port: apps.ports.report }
      ]
    });
    // Start the 1 Hz self-probe loop now that all three ports are listening.
    // probe_state is owned by migration 012 (Task 1); the loop will surface
    // a clear error and halt if the table is missing.
    probeLoop = createProbeLoop({
      db: getDb(),
      ports: apps.ports,
      logger,
      writeAudit
    });
    probeLoop.start();

    // AlertEvaluationLoop + EmailDeliveryLoop (Task 11). Both follow the
    // createProbeLoop factory shape (Global Constraint #8): start() schedules
    // a setInterval with an inFlight guard; tick() runs one evaluation pass;
    // stop() clears the interval and waits for the in-flight tick so
    // shutdown can't strand a half-written transaction. Both are mounted
    // AFTER probeLoop because they depend on system_alerts + system_alert_outbox
    // tables (migration 1.0.6) being live — probeLoop has no such dependency.
    // The 10-second floor (Global Constraint #9) is enforced inside the
    // factory's tick() so the cadence clamp survives caller misconfiguration.
    // R158.68 — 替代 R158.62 createAlertEvaluationLoop. 5 detector 共享
    // system_alerts 表, 邮件节流 30min 同 kind+scope_ref.
    const alertLoop = createSystemAlertLoop({
      db: getDb(),
      getIntervalSeconds: async () => {
        const v = await getSystemConfig();
        return Number(v.system_alert_eval_interval_seconds) || 60;
      },
      getSystemConfig,
      logger
    });
    const emailLoop = createEmailDeliveryLoop({
      db: getDb(),
      // R161.11 (2026-10-26) — 投递链路的失败必须落 pino (此前只有 console.error,
      //   而 NSSM AppStderr='' 把 stderr 丢掉了 ⇒ 邮件没发出去但日志零痕迹)。
      logger,
      getIntervalSeconds: async () => {
        const v = await getSystemConfig();
        return Number(v.alert_eval_interval_seconds) || 60;
      },
      // Pass getConfigMap (unmasked) so the loop can hand the real
      // smtp_password to nodemailer when authenticating. getSystemConfig is
      // masked on read; using it here would silently authenticate with
      // '********' once the test-mail route bypass is unified with the
      // canonical system_config reader (see T12 fix1 I-4).
      getSystemConfig: getConfigMap
    });
    alertLoop.start();
    emailLoop.start();
    // R158.61 (2026-10-10) — daily / weekly email report scheduler. Reads
    // report_daily_cron / report_weekly_cron / *_enabled from system_config
    // and enqueues a report when the CST minute matches. Default cadence
    // 5min (clamped to 10s floor). 0 = disabled per kind via the *_enabled
    // row; the loop itself always runs so an operator can re-enable without
    // restarting the center. Wired AFTER emailLoop because the scheduler
    // enqueues into the shared alert_email_outbox that emailLoop drains.
    const reportLoop = createReportLoop({
      db: getDb(),
      getIntervalSeconds: async () => {
        const v = await getSystemConfig();
        return Number(v.report_loop_interval_seconds) || 300;
      },
      getSystemConfig,
      logger
    });
    reportLoop.start();
    // R158.License-expiry (2026-10-15) — 5min cadence cron 检测 license 状态切换
    //   + 入队 license_expiring_soon / license_expired 邮件. 跟 reportLoop 1:1
    //   平行 boot shape. 严禁嵌 use 间 (R158.X lesson), 跟 reportLoop 同一段平级.
    //   0 触碰 emailLoop / reportLoop / 其他 scheduler. first-tick-immediately
    //   (R158.87.4) + DB-level dedup via license_email_outbox (R158.100.B+3 lesson 1:1).
    const licenseExpiryLoop = createLicenseExpiryLoop({ db: getDb(), logger });
    licenseExpiryLoop.start();
    // AuditRetentionLoop (Task #166 / I4). Reads audit_retention_days from
    // system_config on each tick so operators can change retention policy
    // without restarting. Hard-coded 1-hour cadence — coarse-grained
    // background job, no per-tick interval knob. Wired AFTER emailLoop
    // because purgeOldAuditLogs depends on audit_logs (migration 013+) being
    // live; same dependency class as the alert/email loops.
    const auditRetentionLoop = createAuditRetentionLoop({
      getSystemConfig,
      logger
    });
    auditRetentionLoop.start();
    // R158.61 (2026-10-10) — daily / weekly report history retention sweep.
    // Reads report_retention_days from system_config (default 30, 0 disables).
    // Hard-coded 24h cadence — the table is append-only, daily is enough
    // to keep the 30-day window fresh. Wired AFTER auditRetentionLoop so
    // all retention loops are grouped; share the same factory shape.
    const reportRetentionLoop = createReportRetentionLoop({
      db: getDb(),
      getIntervalSeconds: async () => 24 * 3600,    // 24h cadence, hard-coded
      getSystemConfig,
      logger
    });
    reportRetentionLoop.start();
    // R158.69 (2026-10-10) — 邮件历史 retention sweep (跨 system_alert_outbox
    // + report_email_outbox). 跟 report-retention 同 factory, 24h cadence,
    // email_history_retention_days 默认 30 (lazy insert on first tick).
    const emailHistoryRetentionLoop = createEmailHistoryRetentionLoop({
      db: getDb(),
      getIntervalSeconds: async () => 24 * 3600,    // 24h cadence, hard-coded
      getSystemConfig,
      logger
    });
    emailHistoryRetentionLoop.start();
    // R158.72 (2026-10-11) — ad_account_change retention. 24h cadence,
    //   hard-coded (跟 report-retention / email-history-retention 同 shape).
    //   Wired AFTER emailHistoryRetentionLoop 因为同样是 24h cadence
    //   retention loop; 顺序保持所有 retention loops group 在一起. 读
    //   `ad_account_change_retention_days` from system_config (default 30,
    //   lazy-insert on first tick, 跟 email-history-retention 同 idiom).
    const adAccountChangeRetentionLoop = createAdAccountChangeRetentionLoop({
      db: getDb(),
      getSystemConfig,
      logger
    });
    adAccountChangeRetentionLoop.start();
    // R158.69.9 (2026-10-11) — file-push stale claim auto-fail + retention.
    //   5min cadence (跟 ad_account_change 24h 不同 — stale claim 越久越难
    //   recover, agent 可能已下线/升级/死). Wired AFTER adAccountChangeRetentionLoop
    //   因为同样是 retention loop, group 在一起.
    const filePushRetentionLoop = createFilePushRetentionLoop({
      db: getDb(),
      getSystemConfig,
      logger
    });
    filePushRetentionLoop.start();
    // R112 — 24h retention sweep for the public ad_eventlog_* tables. Hard-
    // coded 1h cadence (mirrors auditRetentionLoop). Wired AFTER auditRetention
    // because eventlog tables are added by migration 026, while audit retention
    // depends on audit_logs (migration 013+) — both must be live, both are.
    // R158.107 (2026-10-16) — 改读 ad_mgmt_retention_days (8 service 统一单点).
    const eventlogRetentionLoop = createEventlogRetentionLoop({
      db: getDb(),
      getSystemConfig,
      logger
    });
    eventlogRetentionLoop.start();
    // R158.78 (2026-10-12) — ad_member_eventlog_* 24h single-sweep retention.
    //   紧跟 R112 eventlogRetentionLoop 后面 (平行设计, 简化单 sweep 跟
    //   eventlogRetentionLoop 双 sweep 是设计选择 — member fleet 规模小).
    // R158.107 (2026-10-16) — 改读 ad_mgmt_retention_days (8 service 统一单点).
    const memberEventlogRetentionLoop = createMemberEventlogRetentionLoop({
      db: getDb(),
      getSystemConfig,
      logger
    });
    memberEventlogRetentionLoop.start();
    // R158.86 (2026-10-12) — ad_member_os_baseline* 7d retention sweep.
    //   紧跟 memberEventlogRetentionLoop (平行, 都是 member-server 专表 retention).
    // R158.107 (2026-10-16) — 改读 ad_mgmt_retention_days (8 service 统一单点).
    const memberOsBaselineRetentionLoop = createMemberOsBaselineRetentionLoop({
      db: getDb(),
      getSystemConfig,
      logger
    });
    memberOsBaselineRetentionLoop.start();
    // R158.19 (2026-10-01) — package_runs retention sweep. Hard-coded 1h
    // cadence; reads package_runs_retention_days from system_config on each
    // tick (default 10 days, 0 disables). Wired AFTER eventlogRetentionLoop
    // because both loops share the same Global Constraint #8 cadence +
    // inFlight-guard pattern; grouping them keeps the boot sequence readable.
    const packageRunsRetentionLoop = createPackageRunsRetentionLoop({
      getSystemConfig,
      logger
    });
    packageRunsRetentionLoop.start();
    // R158.46.30 (2026-10-06) — ad_management audit retention sweep.
    // Reads ad_mgmt_retention_days from system_config on each tick (default
    // 30 days per operator directive 2026-10-06 "管理记录默认保留30天").
    // 0 disables. Wired AFTER packageRunsRetentionLoop because all three
    // retention loops share the same 1h cadence + inFlight-guard shape.
    const adMgmtAuditRetentionLoop = createAdMgmtAuditRetentionLoop({
      getSystemConfig,
      logger
    });
    adMgmtAuditRetentionLoop.start();
    // R158.50 (2026-10-06) — failed-logon retention sweep. Hard-coded
    // 168h (7d) so /failed-logon-2h 7d endpoint always has data; covers
    // the 24h endpoint trivially. 1h cadence mirrors the other retention
    // loops. Wired AFTER adMgmtAuditRetentionLoop because all four
    // retention loops share the same 1h cadence + inFlight-guard shape.
    // R158.107 (2026-10-16) — 改读 ad_mgmt_retention_days (8 service 统一单点).
    const failedLogonRetentionLoop = createFailedLogonRetentionLoop({
      db: getDb(),
      getSystemConfig,
      logger
    });
    failedLogonRetentionLoop.start();
    // R158.35 (2026-10-03) — directory sync loop. Reads
    // ad_sync_interval_minutes from system_config on every tick so
    // operators can tune cadence without a restart. Empty ad_ldap_url →
    // loop tick short-circuits (sync disabled). PDC emulator selected via
    // `ORDER BY is_pdc DESC, dc_name LIMIT 1` (single DC at a time —
    // see services/directory-sync-loop.js for the rationale).
    // R158.46.1 (2026-10-06) — 同步周期单位 小时→分钟.
    const directorySyncLoop = createDirectorySyncLoop({
      getSystemConfig,
      logger
    });
    directorySyncLoop.start();
    // R155.6 — ad_dc_inbound_partners + ad_dc_outbound_partners
    // warehouse refresh. Every 5 min (matches R148 eventlog retention
    // cadence): SELECT latest-per-pair from ad_replication_status in
    // 30-min freshness window + UPSERT each row into both warehouse
    // tables (inbound = dest side, outbound = source side). Excludes
    // synthetic-row naming_contexts (__partner_ports__:%, __dc_summary__,
    // META) to keep the warehouse noise-free. First cycle runs
    // immediately so the warehouse is populated before any UI request
    // that might want to query it. Database contract: migrations 035
    // (mysql + mssql) creates both tables.
    const dcPartnersRefreshLoop = startDcPartnersRefresh({
      db: getDb(),
      logger
    });
    // R158.72.x.5 (2026-10-16) — R159 dead code 激活. 中心端 cron 通用 scheduler
    //   接管: DEFAULT_SCHEDULES = [ad_partner_inbound_discover (R157.4 5min,
    //   原 R159 retired), ad_account_change (R158.72.x.5 24h cadence at
    //   02:00 + Jitter 0~30min per-DC, Get-WinEvent Security 1.0.2)].
    //   fireTriggers 内 assert package_policies.interval_sec=0 (R158.60.10
    //   schedule-suppression signal, agent 端 package-manager.js:316-319
    //   已 ship 兼容) — 0 enforce 则 R158.72.x.3 "3 路独立触发" 复现 0 风险.
    //   0 改 agent binary (R158.69.3 铁律), 0 改 5 老包 (ad_admin_members /
    //   ad_lockout_list / ad_partner_inbound_discover / failed_logon_collector /
    //   ad_os_baseline).
    centreCronHandle = startCentreCron({
      db: getDb(),
      logger,
      schedules: DEFAULT_SCHEDULES
    });
    // R114 — centre-side port-probe scheduler. Reads the (dc × port)
    // catalogue every cycle and probes each (dc, port) from THIS centre
    // server (not loopback). Cadence defaults to 60_000 ms with a system-
    // settings override (r114_probe_interval_ms, range [5000, 3_600_000]).
    // Table ad_remote_port_probe (migration 028) is its only DB contract.
    r114Schedulers = startR114Schedulers({
      db: getDb(),
      log: logger
    }).schedulers;
    // R158.89 — member-port-probe scheduler. 跟 R114 port-probe 1:1 平行
    //   (centre 端 net.Socket 周期 probe + 写 ad_member_server_ports 3 列).
    //   15min cadence 跟 user 报 "/memberServer/ports 15min 一次" 期望 1:1 平行.
    //   0 改 fleet 端 (跟 R158.88 0 fleet 改 1:1 平行).
    memberPortProbeScheduler = startMemberPortProbeScheduler({
      db: getDb(),
      log: logger
    });
    // Bootstrap watchdog: 30 s after startup, if no probe write has landed
    // (all rows still stale or uninitialized), emit a one-shot audit warning
    // so the operator can see in the audit log that the loop is wedged. The
    // .unref() prevents this timer from keeping the process alive during
    // shutdown.
    setTimeout(() => {
      getDb().query(getDb().sql.probeState.getAll).then(({ rows }) => {
        const allStale = rows.every(r => {
          if (!r.last_probe_at) return true;
          return (Date.now() - new Date(r.last_probe_at).getTime()) > 30000;
        });
        if (allStale) {
          writeAudit({
            action: 'probe_loop_watchdog',
            target: 'probe_state',
            payload: { warning: 'no probe write in 30s after startup' }
          }).catch(() => {});
          logger.error('probe loop watchdog: no probe write in 30s');
        }
      }).catch(() => {});
    }, 30000).unref();
    // R75 (2026-08-31): sweep AD admin command timeouts every 10 seconds.
    // 30 s default matches the agent's internal PS1 exec budget
    // (services/ad-admin-commands.js sweepTimeouts). Env var
    // AD_ADMIN_COMMAND_TIMEOUT_MS lets tests tighten the window. .unref()
    // so the timer doesn't block process exit during graceful shutdown.
    const _adAdminSweepMs = Number(process.env.AD_ADMIN_COMMAND_TIMEOUT_MS) || 30000;
    const _adAdminSweepIntervalMs = 10_000;
    setInterval(async () => {
      try {
        const { sweepTimeouts } = await import('./src/services/ad-admin-commands.js');
        // R158.47.1 (2026-10-06) — pass logger so sweepTimeouts can emit
        // `ad_command_timeout` audit rows (closes the audit gap where
        // timeout lifecycle rows had no audit_logs counterpart).
        const swept = await sweepTimeouts({ timeoutMs: _adAdminSweepMs, logger });
        if (swept > 0) {
          logger.info({ swept, timeoutMs: _adAdminSweepMs }, 'ad admin commands swept to timeout');
        }
      } catch (e) {
        logger.warn({ err: e.message }, 'ad admin commands sweep failed (best-effort)');
      }
    }, _adAdminSweepIntervalMs).unref();
    // R81 (2026-09-05): sweep member-server PowerShell command timeouts every
    // 10 seconds. Same setInterval pattern as the R75 ad-admin sweeper above.
    // Env var MEMBER_COMMAND_TIMEOUT_MS lets tests tighten the window.
    // .unref() so the timer doesn't block process exit during graceful
    // shutdown.
    const _memberCmdSweepMs = Number(process.env.MEMBER_COMMAND_TIMEOUT_MS) || 30000;
    const _memberCmdSweepIntervalMs = 10_000;
    setInterval(async () => {
      try {
        const { sweepTimeouts } = await import('./src/services/member-commands.js');
        await sweepTimeouts({ timeoutMs: _memberCmdSweepMs });
      } catch (e) {
        logger.warn({ err: e.message }, 'member commands sweep failed (best-effort)');
      }
    }, _memberCmdSweepIntervalMs).unref();
    // R158.88.B (2026-10-13) — rollout scheduler tick. 5min cadence (off
    //   :00/:30 health-check, 跟 R158.87.2 cron 5min race condition lesson
    //   1:1 平行). canary → full 自动晋升: active 状态 rollout 如果
    //   target_version 跟 _agentUpgradeSource version 一致, 跟 activated_at
    //   距今 > 30min, 升 full. R158.69.3 lesson 3 永远适用: 0 fleet 改.
    //   Boot-time 偏移 7s 避免整点 5min 群撞 (跟 R158.87.3 daily cron 2:00
    //   改法 1:1 平行).
    const _rolloutTickIntervalMs = 5 * 60 * 1000;
    setTimeout(() => {
      const _rolloutTick = async () => {
        try {
          const r = await tickRolloutScheduler({
            db: getDb(),
            logger,
            getAgentUpgradeSource: getAgentUpgradeSourceSnapshot
          });
          if (r.advanced > 0) {
            logger.info({ event: 'rollout.scheduler.tick', checked: r.checked, advanced: r.advanced }, 'rollout scheduler advanced canary to full');
          }
        } catch (e) {
          logger.warn({ err: e.message }, 'rollout scheduler tick failed (best-effort)');
        }
      };
      _rolloutTick().catch(() => {});
      setInterval(_rolloutTick, _rolloutTickIntervalMs).unref();
    }, 7_000).unref();
    const shutdown = async (sig) => {
      logger.info({ sig }, 'shutting down');
      try { await probeLoop.stop(); } catch (e) { logger.warn({ err: e.message }, 'probe stop failed'); }
      try { await alertLoop.stop(); } catch (e) { logger.warn({ err: e.message }, 'alert loop stop failed'); }
      try { await emailLoop.stop(); } catch (e) { logger.warn({ err: e.message }, 'email loop stop failed'); }
      // R158.61 (2026-10-10) — report scheduler stop. Mirrors the alert /
      // email loop shutdown shape (running flag, await inFlight drain).
      try { await reportLoop.stop(); } catch (e) { logger.warn({ err: e.message }, 'report loop stop failed'); }
      try { await auditRetentionLoop.stop(); } catch (e) { logger.warn({ err: e.message }, 'audit retention loop stop failed'); }
      // R158.61 (2026-10-10) — report retention stop. 24h cadence, last
      // because retention is the lowest-priority background sweep.
      try { await reportRetentionLoop.stop(); } catch (e) { logger.warn({ err: e.message }, 'report retention loop stop failed'); }
      // R158.69 (2026-10-10) — email-history retention stop, 紧跟 reportRetentionLoop.
      try { await emailHistoryRetentionLoop.stop(); } catch (e) { logger.warn({ err: e.message }, 'email-history retention loop stop failed'); }
      // R158.72 (2026-10-11) — ad_account_change retention stop, 紧跟 emailHistoryRetentionLoop.
      try { await adAccountChangeRetentionLoop.stop(); } catch (e) { logger.warn({ err: e.message }, 'ad-account-change retention loop stop failed'); }
      // R158.69.9 — file-push retention stop, 紧跟 adAccountChangeRetentionLoop.
      try { await filePushRetentionLoop.stop(); } catch (e) { logger.warn({ err: e.message }, 'file-push retention loop stop failed'); }
      try { await eventlogRetentionLoop.stop(); } catch (e) { logger.warn({ err: e.message }, 'eventlog retention loop stop failed'); }
      // R158.78 (2026-10-12) — member-eventlog retention stop, 紧跟 eventlogRetentionLoop.
      try { await memberEventlogRetentionLoop.stop(); } catch (e) { logger.warn({ err: e.message }, 'member-eventlog retention loop stop failed'); }
      // R158.86 (2026-10-12) — member-os-baseline retention stop, 紧跟 memberEventlogRetentionLoop.
      try { await memberOsBaselineRetentionLoop.stop(); } catch (e) { logger.warn({ err: e.message }, 'member-os-baseline retention loop stop failed'); }
      try { await packageRunsRetentionLoop.stop(); } catch (e) { logger.warn({ err: e.message }, 'package_runs retention loop stop failed'); }
      // R158.50 — failed-logon retention sweep. Same shutdown shape as
      // eventlog / packageRuns / adMgmt retention loops.
      try { await failedLogonRetentionLoop.stop(); } catch (e) { logger.warn({ err: e.message }, 'failed-logon retention loop stop failed'); }
      // R158.35 — stop the directory sync loop. shutdown await so an
      // in-flight LDAP sync doesn't get stranded mid-bind.
      try { await directorySyncLoop.stop(); } catch (e) { logger.warn({ err: e.message }, 'directory sync loop stop failed'); }
      // R155.6 — stop the dc-partners refresh loop. stop() is sync
      // (clearTimeout) but the function is awaitable to keep the
      // shutdown sequence uniform.
      try { await dcPartnersRefreshLoop.stop(); } catch (e) { logger.warn({ err: e.message }, 'dc-partners refresh loop stop failed'); }
      // R159 — partnerDiscoverCronLoop retired; no .stop() to call.
      // R114 — stop the centre-side port-probe scheduler. Wrapped so a
      // failure here can't strand the closeAll() below (port-probe holds
      // a setInterval; clearInterval is sync but we honour the awaitable
      // contract the scheduler exposes).
      await stopR114Schedulers({ schedulers: r114Schedulers, log: logger });
      // R158.89 — stop member-port-probe scheduler. 跟 R114 stopR114Schedulers
      //   1:1 平行 pattern (best-effort, 不挡 closeAll). setInterval sync
      //   clearInterval + setTimeout clearTimeout 双向, inFlight guard 防止
      //   tick 跑到一半.
      if (memberPortProbeScheduler) {
        try { await memberPortProbeScheduler.stop(); } catch (e) { logger.warn({ err: e.message }, 'member-port-probe scheduler stop failed'); }
      }
      // R158.72.x.5 (2026-10-16) — stop centre-cron scheduler. 跟 R114 /
      //   memberPortProbeScheduler 1:1 平行 pattern (best-effort, 不挡 closeAll).
      //   0 改 5 老包, 0 改 agent binary (R158.69.3 铁律).
      try { stopCentreCron(); } catch (e) { logger.warn({ err: e.message }, 'centre-cron stop failed'); }
      await closeAll(servers, logger);
      try { await closeWizardFacade(); } catch {}
      try { await close(); } catch {}
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }
})().catch(err => {
  // Bootstrap itself rejected — fall back to a sync stderr logger so the
  // crash trace is at least on fd 2 (which the install script's stderr
  // capture will route somewhere — see install-center.ps1's stderr
  // handling). The rotated logger isn't available here because the
  // failure may have happened during its construction.
  const fallback = createLogger({ component: 'center', level: 'info' });
  fallback.fatal({ err: err.message, stack: err.stack }, 'bootstrap failed before logger ready');
  process.exit(1);
}));
} // end if (invokedDirectly)
