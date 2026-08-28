import { Router } from 'express';
import { getDb } from '../db/index.js';
import { writeAudit as defaultWriteAudit } from '../services/audit.js';
import { createMigrationsService as defaultCreateService } from '../services/migrations.js';

export function schemaMigrationsRouter({ requireAuth, requirePerm, logger, getRepoRoot, _deps = null }) {
  const deps = _deps ?? {
    createMigrationsService: defaultCreateService,
    writeAudit: defaultWriteAudit
  };

  // Helper: only call getDb() when using the real default service. Tests inject
  // a mock via _deps.createMigrationsService that doesn't need a DB, and
  // getDb() throws when no DB is initialized.
  function getService() {
    if (deps.createMigrationsService === defaultCreateService) {
      const db = getDb();
      return defaultCreateService({ db, logger, getRepoRoot });
    }
    return deps.createMigrationsService({ logger, getRepoRoot });
  }

  const r = Router();
  const auth = [requireAuth, requirePerm('admin:users')];

  r.get('/api/admin/migrations', ...auth, async (req, res) => {
    try {
      const service = getService();
      const dialect = deps.createMigrationsService === defaultCreateService ? getDb().dialect : null;
      const rows = await service.listMigrations(dialect);
      res.json(rows);
    } catch (e) {
      logger.error({ err: e.message }, 'list migrations failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.post('/api/admin/migrations/:version/apply', ...auth, async (req, res) => {
    try {
      const service = getService();
      const appliedBy = (req.body && req.body.appliedBy) || req.user?.username || req.user?.sub || 'unknown';
      const result = await service.applyMigration(req.params.version, { appliedBy });
      await deps.writeAudit({
        userId: req.user?.sub ?? null,
        action: 'apply_migration',
        target: 'schema_migrations',
        payload: { version: result.version, status: result.status, executionMs: result.executionMs }
      }, logger);
      res.json(result);
    } catch (e) {
      const status = e.status || 500;
      logger.error({ err: e.message, status }, 'apply migration failed');
      res.status(status).json({ error: e.message });
    }
  });

  r.post('/api/admin/migrations/:version/dry-run', ...auth, async (req, res) => {
    try {
      const service = getService();
      const result = await service.dryRunMigration(req.params.version);
      res.json(result);
    } catch (e) {
      const status = e.status || 500;
      logger.error({ err: e.message, status }, 'dry-run migration failed');
      res.status(status).json({ error: e.message });
    }
  });

  r.post('/api/admin/migrations/:version/reset', ...auth, async (req, res) => {
    try {
      const service = getService();
      const result = await service.resetFailedMigration(req.params.version);
      await deps.writeAudit({
        userId: req.user?.sub ?? null,
        action: 'reset_failed_migration',
        target: 'schema_migrations',
        payload: { version: req.params.version, deleted: result.deleted }
      }, logger);
      res.json(result);
    } catch (e) {
      const status = e.status || 500;
      logger.error({ err: e.message, status }, 'reset migration failed');
      res.status(status).json({ error: e.message });
    }
  });

  // 2026-08-28 round-55: refresh SHA-256 checksum without re-running SQL.
  // Operator clicks [刷新校验和] in the SchemaMigrationsView when a row
  // shows ⚠️ "File edited after apply" — meaning the file was modified
  // post-apply (verify-marker comments, dialect-compat rewrite, etc.)
  // but the schema in DB is verified working. Only `checksum` column
  // updates; everything else preserved. See migrations.refreshChecksum.
  r.post('/api/admin/migrations/:version/refresh-checksum', ...auth, async (req, res) => {
    try {
      const service = getService();
      const result = await service.refreshChecksum(req.params.version);
      await deps.writeAudit({
        userId: req.user?.sub ?? null,
        action: 'refresh_checksum',
        target: 'schema_migrations',
        payload: { version: result.version, checksum: result.checksum.slice(0, 8) + '…' }
      }, logger);
      res.json(result);
    } catch (e) {
      const status = e.status || 500;
      logger.error({ err: e.message, status }, 'refresh checksum failed');
      res.status(status).json({ error: e.message });
    }
  });

  r.post('/api/admin/migrations/:version/mark-applied', ...auth, async (req, res) => {
    try {
      const service = getService();
      const appliedBy = (req.body && req.body.appliedBy) || req.user?.username || req.user?.sub || 'unknown';
      const result = await service.markApplied(req.params.version, { appliedBy });
      await deps.writeAudit({
        userId: req.user?.sub ?? null,
        action: 'mark_applied',
        target: 'schema_migrations',
        payload: { version: result.version, status: result.status }
      }, logger);
      res.json(result);
    } catch (e) {
      const status = e.status || 500;
      logger.error({ err: e.message, status }, 'mark applied failed');
      res.status(status).json({ error: e.message });
    }
  });

  r.post('/api/admin/migrations/baseline', ...auth, async (req, res) => {
    try {
      const service = getService();
      const { version } = req.body || {};
      if (!version) {
        return res.status(400).json({ error: 'version required' });
      }
      const appliedBy = req.body.appliedBy || req.user?.username || req.user?.sub || 'unknown';
      const result = await service.baseline(version, { appliedBy });
      await deps.writeAudit({
        userId: req.user?.sub ?? null,
        action: 'baseline',
        target: 'schema_migrations',
        payload: { version, count: result.versions.length, skipped: result.skipped.length }
      }, logger);
      res.json(result);
    } catch (e) {
      const status = e.status || 500;
      logger.error({ err: e.message, status }, 'baseline failed');
      res.status(status).json({ error: e.message });
    }
  });

  r.post('/api/admin/migrations/apply-up-to', ...auth, async (req, res) => {
    try {
      const service = getService();
      const { version } = req.body || {};
      if (!version) {
        return res.status(400).json({ error: 'version required' });
      }
      const appliedBy = req.body.appliedBy || req.user?.username || req.user?.sub || 'unknown';
      const result = await service.applyUpTo(version, { appliedBy });
      await deps.writeAudit({
        userId: req.user?.sub ?? null,
        action: 'apply_up_to',
        target: 'schema_migrations',
        payload: { version, applied: result.applied.length, failed: result.failed.length }
      }, logger);
      res.json(result);
    } catch (e) {
      const status = e.status || 500;
      logger.error({ err: e.message, status }, 'apply-up-to failed');
      res.status(status).json({ error: e.message });
    }
  });

  r.post('/api/admin/migrations/upgrade', ...auth, async (req, res) => {
    try {
      const service = getService();
      const appliedBy = (req.body && req.body.appliedBy) || req.user?.username || req.user?.sub || 'unknown';
      const result = await service.upgrade({ appliedBy });
      await deps.writeAudit({
        userId: req.user?.sub ?? null,
        action: 'upgrade_db',
        target: 'schema_migrations',
        payload: { applied: result.migrations.applied.length, failed: result.migrations.failed.length, seed: result.seed.reason }
      }, logger);
      res.json(result);
    } catch (e) {
      const status = e.status || 500;
      logger.error({ err: e.message, status }, 'upgrade failed');
      res.status(status).json({ error: e.message });
    }
  });

  return r;
}