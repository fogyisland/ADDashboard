import express from 'express';
import { withOneShotFacade } from './db-tester.js';
import { getWizardFacade, closeWizardFacade } from './wizard-facade.js';
import { applyAll, backfillMigrations } from './schema-applier.js';
import { createAdmin, AdminConflictError } from './admin-creator.js';
import { writeConfig } from './config-writer.js';
import { writeMarker } from './marker.js';

// Canonicalize conn params so equivalent params (different key order) produce
// stable JSON.stringify output. This ensures getWizardFacade's key-order-sensitive
// paramsEqual check recognises them as matching and reuses the existing facade
// instead of rebuilding it.
function canonicalize(p) {
  if (!p || typeof p !== 'object') return p;
  return Object.fromEntries(Object.entries(p).sort(([a], [b]) => a.localeCompare(b)));
}

export function initRouter({ logger, configPath, installPath, getNeedsInit, _deps = null }) {
  const deps = _deps ?? {
    withOneShotFacade, applyAll, createAdmin, writeConfig,
    getWizardFacade, closeWizardFacade, writeMarker,
    backfillMigrations
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

  r.post('/db/test', async (req, res) => {
    const { dialect, ...connParams } = req.body || {};
    if (!dialect || !['mysql', 'mssql'].includes(dialect)) {
      return res.status(400).json({ error: 'dialect must be "mysql" or "mssql"' });
    }
    try {
      const params = canonicalize(connParams);
      const result = await deps.withOneShotFacade(dialect, params, async (db) => {
        return await db.execute('SELECT 1 AS ok', []);
      });
      res.json({ ok: true, dialect });
    } catch (e) {
      logger.warn({ err: e.message, dialect }, 'init db test failed');
      res.json({ ok: false, error: e.message });
    }
  });

  r.post('/db/apply', async (req, res) => {
    const { dialect, connParams, createDatabase } = req.body || {};
    if (!dialect || !['mysql', 'mssql'].includes(dialect)) {
      return res.status(400).json({ error: 'dialect must be "mysql" or "mssql"' });
    }
    try {
      const params = canonicalize(connParams);
      const db = await deps.getWizardFacade(dialect, params);
      const applied = await deps.applyAll(dialect, db, { createDatabase: !!createDatabase, databaseName: params.database });
      // applyAll just ran every file in db/migrations (including 009, which
      // creates schema_migrations). Record them all as applied so the admin
      // Schema Migrations page doesn't show a fresh install as fully pending.
      // Must run after applyAll — the table does not exist before it.
      await deps.backfillMigrations(dialect, db);
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

  r.post('/admin/create', async (req, res) => {
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

  r.post('/finalize', async (req, res) => {
    const { dialect, connParams, listenPort, agentToken, jwtSecret, logLevel, env, staticDir } = req.body || {};
    try {
      const params = canonicalize(connParams);
      deps.writeConfig({
        path: configPath,
        dialect,
        connParams: params,
        listenPort: listenPort || 8080,
        agentToken: agentToken || '',
        jwtSecret: jwtSecret || '',
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