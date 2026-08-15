// Admin endpoints for orphan_schemas — list + manual drop. Mounted at
// /api/admin/orphan-schemas. Same auth pattern as packageRouter:
// per-route [userAuth, requirePerm('admin:packages')].
//
// GET    /api/admin/orphan-schemas          → { schemas: [...] }
// DELETE /api/admin/orphan-schemas/:name    → drops schema + deletes row → { ok: true }
//
// All PkgError instances are mapped to HTTP responses via `status`; other
// errors fall back to 500. The :name parameter is regex-checked against the
// canonical `pkg_<name>` shape to keep DROP DATABASE/SCHEMA safe from URL
// injection (regex is the same one the installer enforces — single source
// of truth).

import express from 'express';
import { orphanSchemas } from '../db/sql/orphan-schemas.js';
import { dropSchema } from './ddl-apply.js';
import { PkgError } from './errors.js';
import { userAuth } from '../auth/user-auth.js';
import { requirePerm } from '../auth/rbac.js';

export function orphanRouter({ db, config }) {
  const r = express.Router();
  const auth = [userAuth({ secret: config.jwtSecret }), requirePerm('admin:packages')];

  r.get('/api/admin/orphan-schemas', auth, async (_req, res) => {
    try {
      const rows = await orphanSchemas.list(db);
      res.json({ schemas: rows });
    } catch (e) {
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
    }
  });

  r.delete('/api/admin/orphan-schemas/:name', auth, async (req, res) => {
    try {
      const name = req.params.name;
      if (!/^pkg_[a-z0-9_]+$/.test(name)) {
        return res.status(400).json({
          ok: false,
          error: { code: 'PKG_DDL_FORBIDDEN', message: `bad schemaName: ${name}` }
        });
      }
      try {
        await dropSchema(db, name, db.dialect);
      } catch (e) {
        // dropSchema already swallows "doesn't exist" so this catch fires
        // only on real SQL driver errors (permissions, syntax). Surface as
        // PKG_DDL_INVALID_SQL so the admin can see what failed.
        throw new PkgError('PKG_DDL_INVALID_SQL', e.message);
      }
      await orphanSchemas.delete(db, name);
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof PkgError) {
        return res.status(e.status || 400).json({
          ok: false,
          error: { code: e.code, message: e.message }
        });
      }
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
    }
  });

  return r;
}