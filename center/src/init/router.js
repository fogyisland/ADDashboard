import express from 'express';
import { withOneShotFacade } from './db-tester.js';
import { getWizardFacade, closeWizardFacade } from './wizard-facade.js';
import { applyAll } from './schema-applier.js';
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
    getWizardFacade, closeWizardFacade, writeMarker
  };
  const r = express.Router();

  // Guard: 404 unless in init mode (avoids leaking wizard existence)
  r.use((req, res, next) => {
    if (!getNeedsInit()) return res.status(404).json({ error: 'not found' });
    next();
  });

  r.get('/status', (req, res) => {
    res.json({ needsInit: true });
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
      res.json(applied);
    } catch (e) {
      logger.error({ err: e.message }, 'init db apply failed');
      res.status(500).json({ error: e.message });
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