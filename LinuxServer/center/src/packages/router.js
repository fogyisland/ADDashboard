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
//   GET    /api/admin/packages/:name            → getPackageDetail (R111)
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
import { installScript, editScript, setPolicy, deleteScript, getScript, getPackageDetail } from './script-service.js';
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
// R158.72.x.13 (2026-10-17) — +cronExpr 字段 (跟 R158.60.10 intervalSec
//   1:1 平行 必改 schema). 5-field cron 字符串 (e.g. '0 2 * * *') 或 null.
//   0 改 R158.86.6 #5 1 view 1 endpoint 1:1 (复用既 PUT policy 端点, 0
//   引新 endpoint). 0 改 R158.60.10 intervalSec schema (5..86400 必保留
//   on-demand 0 兼容, 1:1 平行). maxLength 64 跟 package_policies.cron_expr
//   VARCHAR(64) 1:1 平行.
const POLICY_UPDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    intervalSec: { type: 'integer', minimum: 5, maximum: 86400 },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 },
    enabled: { type: 'boolean' },
    params: { type: ['object', 'null'] },
    scope: { enum: ['global', 'agent_type:ad', 'agent_type:non-ad'] },
    cronExpr: { type: ['string', 'null'], maxLength: 64 }
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
          // R158.72.x.13 (2026-10-17) — 返 cronExpr 字段. NULL = 走
          //   R158.72.x.11 self-interval anchor 范式, '0 2 * * *' = 走
          //   中心端 cron fire. 跟 R158.60.10 intervalSec 1:1 平行
          //   透传 0 改.
          cronExpr: p.cronExpr ?? null,
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

  // R152 — GET /api/admin/packages/:name/history
  // Returns the full publish history for a single package, newest first.
  // Powers the fold-out version list in PackagesView.vue. Each row is
  // one publish event; the row whose (version, script_sha256) matches
  // the current package_scripts row gets a "current" flag on the
  // frontend. If the package has never been published (i.e. no history
  // rows yet — pre-R152 installs), we synthesize a single entry from
  // the current package_scripts row so the UI can still render
  // something for older packages.
  r.get('/api/admin/packages/:name/history', async (req, res) => {
    try {
      const name = req.params.name;
      // Validate name to keep URL injection paths out of the SQL.
      if (!/^[a-z0-9][a-z0-9_-]{2,127}$/i.test(name)) {
        return res.status(400).json({ error: 'invalid package name' });
      }

      const historyRows = await db.query(
        db.sql.packageScriptsHistory.listByName[db.dialect],
        [name]
      );
      const items = (historyRows.rows || []).map((r) => ({
        version: r.version,
        scriptSha256: r.script_sha256,
        manifest: typeof r.manifest_json === 'string'
          ? JSON.parse(r.manifest_json)
          : r.manifest_json,
        source: r.source,
        publishedAt: r.published_at
      }));

      // Synthesize a current-version entry if no history exists yet
      // (legacy installs predating R152). Best-effort — a failure to
      // read package_scripts here doesn't fail the whole endpoint.
      let synthesized = false;
      if (items.length === 0) {
        try {
          const cur = await packageScripts.get(db, name);
          if (cur) {
            items.push({
              version: cur.version,
              scriptSha256: cur.scriptSha256,
              manifest: cur.manifest,
              source: cur.source,
              publishedAt: cur.updatedAt
            });
            synthesized = true;
          }
        } catch (_) { /* fall through with empty items */ }
      }

      res.json({ name, items, synthesized });
    } catch (e) {
      serverError(res, e, log);
    }
  });

  // GET /api/admin/packages/:name — composite detail page for the
  // admin Edit modal. Returns { package, recentRuns } so the frontend
  // can render the policy form + run history in one round-trip instead
  // of N parallel requests. Closes the R66-T13 V0→V1 regression where
  // the legacy detail endpoint was retired but no V1 replacement was
  // added. PackageEditView.vue:144-149 calls this and destructures
  // r.data.package / r.data.recentRuns — without this route every
  // package detail page errors with a 404 load failure.
  //
  // 404 path: getPackageDetail throws PACKAGE_NOT_FOUND when no script
  // row exists for the name (matches getScript's contract).
  r.get('/api/admin/packages/:name', async (req, res) => {
    try {
      const result = await getPackageDetail({ db, name: req.params.name });
      res.json(result);
    } catch (e) {
      pkgError(res, e, log);
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

  // R158.X.99.26 (2026-10-18) — POST /api/admin/packages/:name/trigger-once
  //   rename from /trigger-now (R158 2026-09-30 ship). 操作员 directive 锁
  //   "写 triggerOnce 不要写 triggerNow". 函数 rename `triggerNow` →
  //   `triggerOnce`, 端点 URL 同步 rename. 真因 = R158.X.99.23 ship 的
  //   cronExpr='0 0 31 2 *' 永不命中 → fireTriggers shouldFire 永 false →
  //   fired.push 永不执行 → fired:[] 视觉"未执行" (实际 row 是别处 cron 写的,
  //   跟 triggerNow 无关). 真闭合 = triggerOnce inline INSERT 14 列
  //   1:1 平行 fireTriggers:332-340, 0 走 shouldFire 旁路. lesson 36 锁
  //   "1-click 路径必 ship" 1:1 平行 R158.X.99.18.c aac 1-click 范式.
  //
  // Operator-driven manual trigger. Body schema:
  //   { actor?: string, targetDcs?: string[] }   — actor recorded in audit;
  //   targetDcs (R158.X.99.20) filters the trigger to a DC subset (NULL = all
  //   enabled agents). 0 引新 endpoint (1 view 1 endpoint 1:1 lesson 36 锁);
  //   only rename the existing one + function.
  r.post('/api/admin/packages/:name/trigger-once', async (req, res) => {
    try {
      const name = req.params.name;
      const { triggerOnce } = await import('../services/cron-scheduler.js');
      const triggeredAt = new Date();
      // R158.X.99.20 — targetDcs (DC hostname 数组) → 透传 triggerOnce.
      // NULL/undefined/[] = 向后兼容 "全 enabled DC 触发" (老行为 1:1).
      const targetDcs = (req.body && Array.isArray(req.body.targetDcs))
        ? req.body.targetDcs.filter((s) => typeof s === 'string' && s.length > 0)
        : null;
      const actor = req.user?.id || (req.body && req.body.actor) || 'unknown';
      const result = await triggerOnce(name, { db, actor, targetDcs });
      await writeAudit({
        action: 'package_trigger_once',
        target: name,
        actor,
        triggeredAt: triggeredAt.toISOString(),
        ok: result.ok,
        fired: result.fired,
        targetDcs,
        agentIds: targetDcs  // 向后兼容老字段名 (R158 时代叫 agentIds, advisory)
      });
      res.json({
        ok: result.ok,
        name,
        triggeredAt: triggeredAt.toISOString(),
        fired: result.fired,
        targetDcs,
        // R158.X.99.26 — 新增 field 告知前端 dedup 跳过 vs 真 fire
        deduplicated: !result.fired && !result.error,
        error: result.error || null
      });
    } catch (e) {
      // Unknown package name → throw new Error('unknown package: ...').
      // Map to 404 so the UI shows a sensible "package not found"
      // instead of "internal". Anything else falls through to
      // serverError.
      if (e && /unknown package/i.test(e.message || '')) {
        return res.status(404).json({ error: e.message, code: 'PACKAGE_NOT_FOUND' });
      }
      pkgError(res, e, log);
    }
  });

  return r;
}
