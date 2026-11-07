import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { withOneShotFacade } from './db-tester.js';
import { getWizardFacade, closeWizardFacade } from './wizard-facade.js';
import { applyAll, backfillMigrations, resolveRepoRoot } from './schema-applier.js';
import { createMigrationsService } from '../services/migrations.js';
import { createAdmin, AdminConflictError } from './admin-creator.js';
import { writeConfig } from './config-writer.js';
import { writeMarker } from './marker.js';
import { INSTALLER_TOKEN_HEADER, clearInstallerToken } from './installer-token.js';

// Canonicalize conn params so equivalent params (different key order) produce
// stable JSON.stringify output. This ensures getWizardFacade's key-order-sensitive
// paramsEqual check recognises them as matching and reuses the existing facade
// instead of rebuilding it.
function canonicalize(p) {
  if (!p || typeof p !== 'object') return p;
  return Object.fromEntries(Object.entries(p).sort(([a], [b]) => a.localeCompare(b)));
}

// R161.30 (2026-11-07) — S1 修复: 常量时间比较。长度不同直接 false 是可接受
// 的 (长度本身不泄密 —— 令牌是定长 96 字符 hex)。
function installerTokenMatches(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function initRouter({ logger, configPath, installPath, getNeedsInit, installerToken, _deps = null }) {
  const deps = _deps ?? {
    withOneShotFacade, applyAll, createAdmin, writeConfig,
    getWizardFacade, closeWizardFacade, writeMarker,
    backfillMigrations, createMigrationsService, resolveRepoRoot
  };
  const r = express.Router();

  // Status endpoint is intentionally mounted BEFORE the init-mode guard so the
  // frontend router's `beforeEach` can probe init state without producing a
  // 404 noise on every page load. In init mode returns {needsInit: true},
  // in normal mode returns {needsInit: false}. Other init endpoints below stay
  // guarded — only /status is always reachable.
  r.get('/status', (req, res) => {
    res.json({ needsInit: !!getNeedsInit() });
  });

  // Guard: 404 unless in init mode (avoids leaking wizard existence)
  r.use((req, res, next) => {
    if (!getNeedsInit()) return res.status(404).json({ error: 'not found' });
    next();
  });

  // R161.30 (2026-11-07) — S1 修复: 向导写操作认证。
  // init 模式的四个写端点 (db/test / db/apply / admin/create / finalize) 在
  // 此前完全无认证 —— 内网任何人都能抢先 finalize 接管部署, 或借 /db/test
  // 做 SSRF 探测。现在统一要求 x-installer-token 头 (常量时间比较)。
  // 令牌由中心启动时生成并落在 <installPath>/.installer-token (0600),
  // 只有能读到服务安装目录的人 (即真正的操作员) 拿得到。
  // /status 仍故意公开: 前端 initState gate 依赖它, 且只回一个布尔值。
  const requireInstallerToken = (req, res, next) => {
    if (!installerToken) {
      // 防御: token 未注入 (理论上 init 模式必然注入) ⇒ fail-closed。
      logger.error('init wizard: no installer token configured — refusing all wizard writes');
      return res.status(503).json({ error: 'installer token not configured' });
    }
    const supplied = req.headers[INSTALLER_TOKEN_HEADER];
    if (!installerTokenMatches(supplied, installerToken)) {
      logger.warn({
        ip: req.ip,
        hasHeader: supplied !== undefined
      }, 'init wizard: missing/invalid installer token — request rejected');
      return res.status(401).json({ error: 'installer token required (see .installer-token on the server host)' });
    }
    // 返回 next() 的 promise: 主 handler 是 async, 不 return 的话调用方
    // (express 忽略返回值无碍, 但直连调用的测试) 拿不到完成时机。
    return next();
  };

  r.post('/db/test', requireInstallerToken, async (req, res) => {
    const { dialect, ...connParams } = req.body || {};
    if (!dialect || !['mysql', 'mssql'].includes(dialect)) {
      return res.status(400).json({ error: 'dialect must be "mysql" or "mssql"' });
    }
    try {
      const params = canonicalize(connParams);
      const result = await deps.withOneShotFacade(dialect, params, async (db) => {
        // ★ R161.6 (2026-10-26) — MySQL 侧测的是**服务器连通性**, 不是
        //   "能不能选中那个还没建的库"。
        //   旧实现直接在绑定目标库的连接上 SELECT 1 ⇒ 全新安装时握手阶段就
        //   ER_BAD_DB_ERROR (1049) ⇒ 第 1 步永远"连接失败" ⇒ 操作员被卡住,
        //   **根本走不到第 3 步的"创建数据库"阶段** —— 那个阶段形同虚设。
        //   现在: server 级连接探活 + 查库是否存在, 两件事都答清楚。
        //   MSSQL 侧没有 server 级连接能力 (库由 installer 预建), 保持原样。
        if (dialect === 'mysql' && typeof db.probeServer === 'function') {
          await db.probeServer();
          const databaseExists = typeof db.databaseExists === 'function'
            ? await db.databaseExists(params.database)
            : null;
          return { server: true, databaseExists };
        }
        await db.execute('SELECT 1 AS ok', []);
        return { server: true, databaseExists: true };
      });
      res.json({ ok: true, dialect, ...result });
    } catch (e) {
      // R161.30 (2026-11-07) — S1 修复: 不再原样回显驱动错误。原文可能包含
      //   内部 host / 端口 / 驱动版本指纹 (SSRF 探测可借此确认目标可达性)。
      //   完整原文留在服务端日志; 客户端只拿到"连接失败"这一结论。
      //   (db/apply 保持详细回显 —— apply 已被 token 保护, 且操作员排障
      //   需要看到 precedingErrors 链。)
      logger.warn({ err: e.message, code: e.code, dialect }, 'init db test failed');
      res.json({ ok: false, error: '连接失败 — 请检查主机/端口/用户名/密码 (详情见服务端 init 日志)' });
    }
  });

  r.post('/db/apply', requireInstallerToken, async (req, res) => {
    const { dialect, connParams, createDatabase } = req.body || {};
    if (!dialect || !['mysql', 'mssql'].includes(dialect)) {
      return res.status(400).json({ error: 'dialect must be "mysql" or "mssql"' });
    }
    try {
      const params = canonicalize(connParams);
      const db = await deps.getWizardFacade(dialect, params);
      // R161.5 (2026-10-26) — 传 logger 进去: applyAll 撞出的幂等冲突
      //   (列/索引/表已存在) 会被跳过并记录, 每条一条 warn 日志, 不静默。
      //   同时 applyAll 内部对**同一库**的并发调用做了 single-flight 互斥,
      //   后来者复用先到者的结果 —— 这正是本次 init 500 (ER_DUP_FIELDNAME)
      //   的根因防线。
      const applied = await deps.applyAll(dialect, db, {
        createDatabase: !!createDatabase,
        databaseName: params.database,
        logger
      });
      if (Array.isArray(applied.conflicts) && applied.conflicts.length > 0) {
        logger.warn({
          count: applied.conflicts.length,
          codes: [...new Set(applied.conflicts.map(c => c.code || c.number))]
        }, 'init db apply 跳过了若干幂等冲突 (目标对象已存在)');
      }
      // R158.51 (2026-10-08) — baseline freeze. applyAll now runs the
      // single 1.0.0-baseline.sql (which absorbs all 001-056 DDL + R66 data
      // migration seed). The old 3-stage path
      // (db/schema/{01-tables,02-seed-roles}.sql + db/migrations/*) is
      // gone. backfillMigrations records the baseline + sidecar rows in
      // schema_migrations so a fresh install doesn't show 1.0.0 as pending.
      // The init wizard has no audit user / data dir at this stage, so
      // both callbacks are null — the JS helper's writeAudit guard
      // short-circuits cleanly.
      const backfill = await deps.backfillMigrations(dialect, db, {
        getDataDir: null,
        writeAudit: null,
        logger
      });
      // R161.17 (2026-10-27) — **登记账本 ≠ 迁移真的跑过**。
      //   backfillMigrations 只在 verify 探针通过时才把迁移登记成 'applied';
      //   探针不过 (比如 1.0.2 的备份表在新库里还不存在) ⇒ 它**不登记** ⇒
      //   这条迁移就是待办。此时必须把它真的跑掉, 否则 init 向导"建库成功"
      //   之后交出去的是一棵**残库**。
      //   ★ 现场 (R161.17 的实测): 全新安装出来的库与源库的唯一差异就是
      //     audit_logs_utc_baseline_backup 这张表 —— 因为 backfill 把
      //     1.0.2 无条件登记成 applied 而**从不执行**, 随后的 upgrade()
      //     又因为"已 applied"把它跳过 ⇒ 这张表永远建不出来 ⇒
      //     services/audit-utc-baseline.js 的自愈回填在缺表时直接放弃 ⇒
      //     R161.16 的审计时间修复在**全新安装的部署上从来没生效过**。
      //   修法: 向导把待补的迁移真的跑掉 (用的是迁移引擎本身, 不另写一套)。
      const pending = (backfill && Array.isArray(backfill.skipped)) ? backfill.skipped : [];
      if (pending.length > 0) {
        logger.warn({
          pending: pending.map((p) => ({ file: p.file, version: p.version, missing: p.missing }))
        }, 'backfill 跳过了若干迁移 (verify 探针未通过) — 立即用迁移引擎补跑');
      }
      const repoRoot = deps.resolveRepoRoot({});
      const migrations = deps.createMigrationsService({
        db,
        logger,
        getRepoRoot: () => repoRoot,
        writeAudit: null,
        getDataDir: null
      });
      const upgrade = await migrations.upgrade({ appliedBy: 'init-wizard' });
      if (!upgrade.ok) {
        const detail = upgrade.migrations.failed
          .map((f) => `${f.version}: ${f.errorMessage}`)
          .join('; ');
        throw new Error(`编号迁移执行失败 — ${detail || '未知错误'}`);
      }
      if (upgrade.migrations.applied.length > 0) {
        logger.info(
          { applied: upgrade.migrations.applied.map((m) => m.version) },
          'init 向导补跑了待办的编号迁移'
        );
      }
      applied.migrations = upgrade.migrations.applied;
      applied.pendingMigrations = pending;
      res.json(applied);
    } catch (e) {
      // MSSQL wraps the actionable error in `precedingErrors[]` — the top-level
      // `e.message` is often just "Could not create constraint or index. See
      // previous errors." which is useless on its own. Surface the chain so the
      // operator can see the actual constraint/line that failed.
      const preceding = Array.isArray(e.precedingErrors)
        ? e.precedingErrors.map(pe => pe?.message).filter(Boolean)
        : [];
      logger.error({
        err: e.message,
        code: e.code,
        lineNumber: e.lineNumber,
        precedingErrors: preceding
      }, 'init db apply failed');
      const detail = preceding.length ? `${e.message}\n  ${preceding.join('\n  ')}` : e.message;
      res.status(500).json({ error: detail, code: e.code, lineNumber: e.lineNumber, precedingErrors: preceding });
    }
  });

  r.post('/admin/create', requireInstallerToken, async (req, res) => {
    const { dialect, connParams, username, password } = req.body || {};
    if (!dialect || !username || !password) {
      return res.status(400).json({ error: 'dialect, username, password required' });
    }
    try {
      const params = canonicalize(connParams);
      const db = await deps.getWizardFacade(dialect, params);
      const r = await deps.createAdmin(db, { username, password });
      res.json(r);
    } catch (e) {
      if (e instanceof AdminConflictError || e.code === 'ADMIN_EXISTS') {
        return res.status(409).json({ error: 'admin user already exists' });
      }
      logger.error({ err: e.message }, 'init admin create failed');
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/finalize', requireInstallerToken, async (req, res) => {
    const { dialect, connParams, listenPort, agentToken, jwtSecret, logLevel, env, staticDir } = req.body || {};
    try {
      // C6 fix: refuse to write appsettings.json with empty jwtSecret /
      // agentToken. An empty jwtSecret effectively means JWTs are signed with
      // '' — anyone could forge tokens. An empty agentToken means the agent
      // middleware accepts any value (since `req.headers['x-agent-token']`
      // would always equal the empty-string fallback). If the operator
      // skipped these fields in the wizard, generate a fresh 48-byte
      // hex secret so the install is secure by default. Operators who
      // really want to override can paste a longer value into the field;
      // the frontend already enforces min length 32 (login form) but the
      // init wizard had no such guard.
      const MIN_SECRET_LEN = 32;
      function ensureSecret(value, label) {
        if (typeof value === 'string' && value.length >= MIN_SECRET_LEN) return value;
        // Generate fresh 48-byte hex (96 chars). crypto.randomBytes is
        // available in Node ≥ 14.17; project's Node floor is 20+.
        const generated = randomBytes(48).toString('hex');
        logger.warn({ label, length: generated.length }, 'init finalize: secret missing/empty — generated fresh secret (bootstrap-only; runtime reads from system_config)');
        return generated;
      }
      const params = canonicalize(connParams);
      const finalJwtSecret = ensureSecret(jwtSecret, 'jwtSecret');
      const finalAgentToken = ensureSecret(agentToken, 'agentToken');
      // C8 fix: validate listenPort before writing appsettings.json so the
      // service can't be locked out by a bad port. Allow operator to enter
      // their custom value, reject obviously invalid ones (non-integer,
      // negative, reserved priv-port range below 1024 unless explicitly
      // opted in via ALLOW_PRIVILEGED_PORTS — which we don't expose yet).
      const finalListenPort = Number(listenPort);
      if (!Number.isInteger(finalListenPort) || finalListenPort < 1024 || finalListenPort > 65535) {
        return res.status(400).json({
          error: `listenPort must be an integer in 1024..65535; got ${JSON.stringify(listenPort)}`
        });
      }
      deps.writeConfig({
        path: configPath,
        dialect,
        connParams: params,
        listenPort: finalListenPort,
        agentToken: finalAgentToken,
        jwtSecret: finalJwtSecret,
        logLevel: logLevel || 'info',
        env: env || 'prod',
        staticDir: staticDir || './dist'
      });
      // Persist init-complete marker so the wizard stays locked even if
      // appsettings.json is later deleted. File + registry both written.
      try {
        await deps.writeMarker(installPath);
      } catch (e) {
        logger.error({ err: e.message }, 'init marker write failed (non-fatal)');
      }
      try {
        await deps.closeWizardFacade();
      } catch (e) {
        logger.error({ err: e.message }, 'init wizard facade close failed');
      }
      // R161.30 — 向导已被 marker 锁死, installer token 留着没有意义, 清掉。
      // 失败不致命 (marker 才是主防线), 落日志即可。
      try {
        clearInstallerToken(installPath);
      } catch (e) {
        logger.warn({ err: e.message }, 'init installer token cleanup failed (non-fatal)');
      }
      res.json({ ok: true, path: configPath });
      // Exit so NSSM AppExit=Default Restart picks up the new appsettings.json
      // on next launch. setImmediate defers the exit to the "check" phase so
      // res.json can flush the response body before the process dies.
      setImmediate(() => process.exit(0));
    } catch (e) {
      logger.error({ err: e.message }, 'init finalize failed');
      res.status(500).json({ error: e.message });
    }
  });

  return r;
}