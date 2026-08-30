// Admin-facing REST endpoints for the package system.
//
// R66 T13 — V0 ZIP wrapper retired. Only the script-service-backed V1
// surface remains. The legacy `packageRouter` factory (installer.install /
// upgrade / setEnabled / uninstall / updateParams / setIntervalOverride)
// lived in this file from T7 through T12 to keep the V0 client path
// working while the seeder and runner migrated. T13 deletes it along
// with packages/installer.js + db/sql/installed-packages.js (the V0
// row shape it wrote to).
//
// ── V1 endpoints (createPackagesRouter, perm admin:users via adminAuth) ──
//   GET    /api/admin/packages                  → merged script+policy list
//   GET    /api/admin/packages/:name/script     → getScript (R67-T1)
//   POST   /api/admin/packages/upload-script    → installScript
//   PUT    /api/admin/packages/:name/script     → editScript
//   PUT    /api/admin/packages/:name/policy     → setPolicy (partial body)
//   PUT    /api/admin/packages/:name/enable     → setPolicy({enabled:true})
//   PUT    /api/admin/packages/:name/disable    → setPolicy({enabled:false})
//   DELETE /api/admin/packages/:name            → deleteScript
//
// All PkgError instances thrown by the script-service are mapped to HTTP
// responses via the `statusFor` helper; everything else falls back to 500
// with `{ error: 'internal' }`.

import express from 'express';
import Ajv from 'ajv';
import { packageScripts } from '../db/sql/package-scripts.js';
import { packagePolicies } from '../db/sql/package-policies.js';
import { installScript, editScript, setPolicy, deleteScript, getScript } from './script-service.js';
import { PkgError } from './errors.js';

// ─────────────────────────────────────────────────────────────────────
// R66 (V1) — script-service backed admin surface.
// ─────────────────────────────────────────────────────────────────────

// 1 MB ceiling matches script-service.MAX_SCRIPT_BYTES. Enforcing it here
// too means an oversized upload is rejected as a 400 body-validation error
// before any DB round-trip (the service's own SCRIPT_TOO_LARGE → 413 stays
// as the defence-in-depth backstop for non-HTTP callers such as the seeder).
const MAX_SCRIPT_BYTES = 1024 * 1024;

const UPLOAD_SCHEMA = {
  type: 'object',
  required: ['name', 'content', 'type', 'agentType', 'description', 'intervalSec', 'timeoutMs'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 3, maxLength: 128, pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]*$' },
    content: { type: 'string', minLength: 1, maxLength: MAX_SCRIPT_BYTES },
    type: { enum: ['gauge', 'counter', 'status', 'timeseries'] },
    agentType: { enum: ['ad', 'non-ad'] },
    description: { type: 'string', maxLength: 1024 },
    intervalSec: { type: 'integer', minimum: 5, maximum: 86400 },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 }
  }
};

const SCRIPT_EDIT_SCHEMA = {
  type: 'object',
  required: ['content'],
  additionalProperties: false,
  properties: { content: { type: 'string', minLength: 1, maxLength: MAX_SCRIPT_BYTES } }
};

// minProperties:1 rejects `{}` — an empty policy PUT is a caller bug, not a
// no-op (script-service throws EMPTY_POLICY for the same reason).
const POLICY_UPDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    intervalSec: { type: 'integer', minimum: 5, maximum: 86400 },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 },
    enabled: { type: 'boolean' },
    params: { type: ['object', 'null'] },
    scope: { enum: ['global', 'agent_type:ad', 'agent_type:non-ad'] }
  }
};

const ajv = new Ajv({ allErrors: true });

function badRequest(res, msg, errors) {
  return res.status(400).json({ error: msg, details: errors });
}

function serverError(res, e, log) {
  if (log) log.error({ err: e }, 'packages route failed');
  return res.status(500).json({ error: 'internal' });
}

// PkgError → HTTP. `e.status` is set by PkgError.statusFor() (see
// errors.js): validation codes → 400, PACKAGE_NOT_FOUND → 404,
// PACKAGE_EXISTS → 409, SCRIPT_TOO_LARGE → 413. Anything without a mapping
// falls back to 500 and is logged.
function pkgError(res, e, log) {
  if (!(e instanceof PkgError)) return serverError(res, e, log);
  const status = e.status || 400;
  if (status >= 500) return serverError(res, e, log);
  return res.status(status).json({ error: e.message, code: e.code });
}

export function createPackagesRouter({ db, writeAudit, adminAuth, getLogger }) {
  const r = express.Router();
  const log = getLogger ? getLogger() : null;

  // Single auth gate for every route below. `adminAuth` is ONE Express
  // thunk — server.js composes userAuth + requirePerm('admin:users') into
  // it before calling this factory (R66 T7 / R7-2 ruling), so the router
  // stays free of auth-module imports.
  r.use('/api/admin/packages', adminAuth);

  // GET /api/admin/packages — server-side join of package_scripts (content
  // identity) and package_policies (operator-tunable execution knobs).
  // Scripts drive the list; a missing policy row degrades to safe defaults
  // (disabled / global scope) rather than dropping the package.
  r.get('/api/admin/packages', async (_req, res) => {
    try {
      const scripts = await packageScripts.list(db);
      const policies = await packagePolicies.list(db);
      const policyByName = new Map(policies.map((p) => [p.name, p]));
      const items = scripts.map((s) => {
        const p = policyByName.get(s.name) || {};
        return {
          name: s.name,
          version: s.version,
          type: s.manifest?.type || 'gauge',
          agentType: s.manifest?.agent?.type || 'ad',
          enabled: !!p.enabled,
          intervalSec: p.intervalSec ?? null,
          timeoutMs: p.timeoutMs ?? null,
          params: p.params ?? null,
          scope: p.scope ?? 'global',
          source: s.source,
          scriptSha256: s.scriptSha256,
          manifest: s.manifest,
          updatedAt: s.updatedAt
        };
      });
      res.json({ items });
    } catch (e) {
      serverError(res, e, log);
    }
  });

  // GET /api/admin/packages/:name/script — return the raw script body
  // for view-mode (R67-T1). Returns 200 with JSON envelope
  // { name, version, scriptContent, scriptSha256, source, updatedAt } so
  // the frontend can render it in a read-only textarea. 404 if the
  // package doesn't exist. Every successful call emits a `view_script`
  // audit entry — the script body is admin-only, so reads are
  // tracked with the same audit footprint as the 4 write actions.
  r.get('/api/admin/packages/:name/script', async (req, res) => {
    try {
      const result = await getScript({ db, writeAudit, name: req.params.name });
      res.json(result);
    } catch (e) {
      pkgError(res, e, log);
    }
  });

  // POST /api/admin/packages/upload-script — create script row + default
  // (disabled) policy row. `source` is pinned server-side so a client can't
  // masquerade an upload as a builtin.
  r.post('/api/admin/packages/upload-script', async (req, res) => {
    try {
      const valid = ajv.validate(UPLOAD_SCHEMA, req.body || {});
      if (!valid) return badRequest(res, 'invalid body', ajv.errors);
      const result = await installScript({ db, writeAudit, ...req.body, source: 'admin-upload' });
      res.json({ ok: true, ...result });
    } catch (e) {
      pkgError(res, e, log);
    }
  });

  // PUT /api/admin/packages/:name/script — replace the script body. The
  // service returns noOp:true when the sha is unchanged (no audit noise).
  r.put('/api/admin/packages/:name/script', async (req, res) => {
    try {
      const valid = ajv.validate(SCRIPT_EDIT_SCHEMA, req.body || {});
      if (!valid) return badRequest(res, 'invalid body', ajv.errors);
      const result = await editScript({ db, writeAudit, name: req.params.name, content: req.body.content });
      res.json({ ok: true, ...result });
    } catch (e) {
      pkgError(res, e, log);
    }
  });

  // PUT /api/admin/packages/:name/policy — partial update; only the keys
  // present in the body are written (script-service skips `undefined`).
  r.put('/api/admin/packages/:name/policy', async (req, res) => {
    try {
      const valid = ajv.validate(POLICY_UPDATE_SCHEMA, req.body || {});
      if (!valid) return badRequest(res, 'invalid body', ajv.errors);
      const result = await setPolicy({ db, writeAudit, name: req.params.name, ...req.body });
      res.json({ ok: true, ...result });
    } catch (e) {
      pkgError(res, e, log);
    }
  });

  // PUT /api/admin/packages/:name/enable — sugar over the policy PUT so the
  // UI toggle doesn't have to compose a body.
  r.put('/api/admin/packages/:name/enable', async (req, res) => {
    try {
      const result = await setPolicy({ db, writeAudit, name: req.params.name, enabled: true });
      res.json({ ok: true, ...result, name: req.params.name, enabled: true });
    } catch (e) {
      pkgError(res, e, log);
    }
  });

  // PUT /api/admin/packages/:name/disable
  r.put('/api/admin/packages/:name/disable', async (req, res) => {
    try {
      const result = await setPolicy({ db, writeAudit, name: req.params.name, enabled: false });
      res.json({ ok: true, ...result, name: req.params.name, enabled: false });
    } catch (e) {
      pkgError(res, e, log);
    }
  });

  // DELETE /api/admin/packages/:name — removes BOTH rows (the service does
  // the policy delete explicitly rather than relying on FK cascade).
  r.delete('/api/admin/packages/:name', async (req, res) => {
    try {
      const result = await deleteScript({ db, writeAudit, name: req.params.name });
      res.json({ ok: true, ...result });
    } catch (e) {
      pkgError(res, e, log);
    }
  });

  return r;
}
