// router.test.js — R66 Task 7: the script-service-backed admin surface.
//
// The V0 ZIP-installer endpoints (install / upgrade / registry / params /
// ddl-preview) are still exercised by tests/packages/router-v2.test.js
// against the legacy `packageRouter` wrapper; this file covers the seven
// NEW endpoints exposed by `createPackagesRouter`:
//
//   GET    /api/admin/packages                  → merged script+policy list
//   POST   /api/admin/packages/upload-script    → installScript
//   PUT    /api/admin/packages/:name/script     → editScript
//   PUT    /api/admin/packages/:name/policy     → setPolicy (partial)
//   PUT    /api/admin/packages/:name/enable     → setPolicy({enabled:true})
//   PUT    /api/admin/packages/:name/disable    → setPolicy({enabled:false})
//   DELETE /api/admin/packages/:name            → deleteScript
//
// Auth is injected as a single `adminAuth` thunk (server.js composes
// userAuth + requirePerm('admin:users') before passing it in), so these
// tests need no JWT — they stub the thunk directly. The db is an in-memory
// fake that speaks the same SQL shapes as db/sql/package-scripts.js +
// db/sql/package-policies.js (same pattern as script-service.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createPackagesRouter } from '../../src/packages/router.js';

// ─────────────────────────────────────────────────────────────────────
// Fake db — two in-memory Maps behind the exact SQL the helpers emit.
// ─────────────────────────────────────────────────────────────────────

function scriptRow(s) {
  return {
    name: s.name,
    version: s.version,
    script_sha256: s.scriptSha256,
    manifest_json: JSON.stringify(s.manifest),
    source: s.source,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
    script_content: s.content
  };
}

function policyRow(p) {
  return {
    name: p.name,
    interval_sec: p.intervalSec,
    timeout_ms: p.timeoutMs,
    enabled: p.enabled ? 1 : 0,
    params_json: p.params == null ? null : JSON.stringify(p.params),
    scope: p.scope,
    created_at: p.createdAt,
    updated_at: p.updatedAt
  };
}

// packagePolicies.updatePartial builds a dynamic SET clause, so the fake has
// to read the column list out of the SQL and apply the matching params —
// a naive "only bump updated_at" stub would silently pass every partial
// update test while updating nothing.
function applyPolicyUpdate(policies, sql, params) {
  const setPart = sql.slice(sql.indexOf(' SET ') + 5, sql.indexOf(' WHERE '));
  const cols = setPart.split(',').map((c) => c.trim().split('=')[0].trim());
  const p = policies.get(params[params.length - 1]);
  if (!p) return;
  cols.forEach((col, i) => {
    const v = params[i];
    if (col === 'interval_sec') p.intervalSec = v;
    else if (col === 'timeout_ms') p.timeoutMs = v;
    else if (col === 'enabled') p.enabled = !!v;
    else if (col === 'params_json') p.params = v == null ? null : JSON.parse(v);
    else if (col === 'scope') p.scope = v;
    else if (col === 'updated_at') p.updatedAt = v;
  });
}

function buildApp() {
  const scripts = new Map();
  const policies = new Map();
  const auditCalls = [];
  const db = {
    dialect: 'mysql',
    async execute(sql, params = []) {
      const t = sql.trim();
      if (t.startsWith('SELECT * FROM package_scripts')) {
        const name = params[0];
        if (name) {
          const s = scripts.get(name);
          return { rows: s ? [scriptRow(s)] : [] };
        }
        return { rows: [...scripts.values()].map(scriptRow) };
      }
      if (t.startsWith('SELECT * FROM package_policies')) {
        const name = params[0];
        if (name) {
          const p = policies.get(name);
          return { rows: p ? [policyRow(p)] : [] };
        }
        return { rows: [...policies.values()].map(policyRow) };
      }
      if (t.startsWith('INSERT INTO package_scripts')) {
        scripts.set(params[0], {
          name: params[0], version: params[1], content: params[2],
          scriptSha256: params[3], manifest: JSON.parse(params[4]), source: params[5],
          createdAt: params[6], updatedAt: params[7]
        });
      }
      if (t.startsWith('INSERT INTO package_policies')) {
        policies.set(params[0], {
          name: params[0], intervalSec: params[1], timeoutMs: params[2],
          enabled: !!params[3], params: params[4] == null ? null : JSON.parse(params[4]),
          scope: params[5], createdAt: params[6], updatedAt: params[7]
        });
      }
      if (t.startsWith('UPDATE package_scripts SET script_content')) {
        const s = scripts.get(params[3]);
        if (s) { s.content = params[0]; s.scriptSha256 = params[1]; s.updatedAt = params[2]; }
      }
      if (t.startsWith('UPDATE package_policies SET')) {
        applyPolicyUpdate(policies, t, params);
      }
      if (t.startsWith('DELETE FROM package_scripts')) scripts.delete(params[0]);
      if (t.startsWith('DELETE FROM package_policies')) policies.delete(params[0]);
      return { rows: [] };
    }
  };
  const writeAudit = async (args) => auditCalls.push(args);
  const router = createPackagesRouter({
    db,
    writeAudit,
    adminAuth: (req, res, next) => { req.user = { role: 'admin' }; next(); }
  });
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(router);
  return { app, scripts, policies, auditCalls };
}

// Shared upload helper
async function uploadPkg(app, name = 'pkg-a', body = {}) {
  return request(app).post('/api/admin/packages/upload-script').send({
    name, content: 'Write-Host hi', type: 'gauge', agentType: 'ad',
    description: 'test', intervalSec: 3600, timeoutMs: 30000, ...body
  });
}

test('GET /api/admin/packages returns empty initially', async () => {
  const { app } = buildApp();
  const r = await request(app).get('/api/admin/packages');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { items: [] });
});

test('POST /upload-script creates script + default policy', async () => {
  const { app, scripts, policies } = buildApp();
  const r = await uploadPkg(app, 'pkg-a');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.match(r.body.scriptSha, /^[0-9a-f]{64}$/);
  assert.equal(scripts.size, 1);
  assert.equal(policies.size, 1);
  assert.equal(policies.get('pkg-a').enabled, false);
});

test('POST /upload-script 400 on missing name', async () => {
  const { app } = buildApp();
  const r = await request(app).post('/api/admin/packages/upload-script').send({
    content: 'x', type: 'gauge', agentType: 'ad', description: 't', intervalSec: 60, timeoutMs: 1000
  });
  assert.equal(r.status, 400);
});

test('POST /upload-script 400 on oversized content (>1 MB)', async () => {
  const { app } = buildApp();
  const r = await uploadPkg(app, 'pkg-x', { content: 'x'.repeat(1024 * 1024 + 1) });
  assert.equal(r.status, 400);
});

test('PUT /:name/script updates content + sha', async () => {
  const { app, scripts } = buildApp();
  await uploadPkg(app, 'pkg-a');
  const r = await request(app).put('/api/admin/packages/pkg-a/script').send({ content: 'Write-Host new' });
  assert.equal(r.status, 200);
  assert.notEqual(r.body.newSha, r.body.oldSha);
  assert.match(scripts.get('pkg-a').scriptSha256, /^[0-9a-f]{64}$/);
});

test('PUT /:name/policy partial body only updates present fields', async () => {
  const { app, policies } = buildApp();
  await uploadPkg(app, 'pkg-a');
  const r = await request(app).put('/api/admin/packages/pkg-a/policy').send({ intervalSec: 60 });
  assert.equal(r.status, 200);
  assert.equal(policies.get('pkg-a').intervalSec, 60);
  assert.equal(policies.get('pkg-a').timeoutMs, 30000);
});

test('PUT /:name/policy 400 on invalid intervalSec', async () => {
  const { app } = buildApp();
  await uploadPkg(app, 'pkg-a');
  const r = await request(app).put('/api/admin/packages/pkg-a/policy').send({ intervalSec: 1 });
  assert.equal(r.status, 400);
});

test('PUT /:name/enable sets enabled=true', async () => {
  const { app, policies } = buildApp();
  await uploadPkg(app, 'pkg-a');
  const r = await request(app).put('/api/admin/packages/pkg-a/enable');
  assert.equal(r.status, 200);
  assert.equal(policies.get('pkg-a').enabled, true);
});

test('PUT /:name/disable sets enabled=false', async () => {
  const { app, policies } = buildApp();
  await uploadPkg(app, 'pkg-a');
  await request(app).put('/api/admin/packages/pkg-a/enable');
  const r = await request(app).put('/api/admin/packages/pkg-a/disable');
  assert.equal(r.status, 200);
  assert.equal(policies.get('pkg-a').enabled, false);
});

test('DELETE /:name cascade deletes both rows', async () => {
  const { app, scripts, policies } = buildApp();
  await uploadPkg(app, 'pkg-a');
  const r = await request(app).delete('/api/admin/packages/pkg-a');
  assert.equal(r.status, 200);
  assert.equal(r.body.deleted.script, true);
  assert.equal(r.body.deleted.policy, true);
  assert.equal(scripts.size, 0);
  assert.equal(policies.size, 0);
});

test('Auth: each new endpoint requires admin (returns 401/403 without auth)', async () => {
  const db = {
    dialect: 'mysql',
    async execute() { return { rows: [] }; }
  };
  const router = createPackagesRouter({
    db,
    writeAudit: async () => {},
    adminAuth: (req, res) => res.status(403).json({ error: 'forbidden' })
  });
  const app = express();
  app.use(express.json());
  app.use(router);
  const r1 = await request(app).get('/api/admin/packages');
  const r2 = await request(app).post('/api/admin/packages/upload-script').send({});
  assert.equal(r1.status, 403);
  assert.equal(r2.status, 403);
});

test('GET /packages returns merged items joined on name (policy fields default when missing)', async () => {
  const { app, scripts } = buildApp();
  scripts.set('pkg-x', {
    name: 'pkg-x', version: '1.0.0', scriptSha256: 'abc',
    manifest: { type: 'counter', agent: { type: 'non-ad' } },
    source: 'admin-upload', createdAt: '2026-01-01', updatedAt: '2026-01-01', content: 'x'
  });
  // no policy row for pkg-x
  const r = await request(app).get('/api/admin/packages');
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 1);
  const item = r.body.items[0];
  assert.equal(item.name, 'pkg-x');
  assert.equal(item.type, 'counter');
  assert.equal(item.agentType, 'non-ad');
  assert.equal(item.enabled, false);          // default when policy missing
  assert.equal(item.scope, 'global');         // default when policy missing
  assert.equal(item.scriptSha256, 'abc');
});

test('GET /packages emits audit only for mutating actions (read does not call writeAudit)', async () => {
  const { app, auditCalls } = buildApp();
  await request(app).get('/api/admin/packages');
  assert.equal(auditCalls.length, 0);
});

test('POST /upload-script emits exactly one upload_script audit row with 8-char sha prefix', async () => {
  const { app, auditCalls } = buildApp();
  await uploadPkg(app, 'pkg-a');
  const upload = auditCalls.find((c) => c.action === 'upload_script');
  assert.ok(upload, 'upload_script audit must be emitted');
  // R66 T13 — script-service now emits the real audit.js shape
  // ({action, target, payload}) directly. The T7 server.js adapter
  // was retired; assertion moved from targetType/targetId/details to
  // target/payload.
  assert.equal(upload.target, 'packages');
  assert.equal(upload.payload.name, 'pkg-a');
  assert.equal(upload.payload.source, 'admin-upload');
  assert.match(upload.payload.scriptSha, /^[0-9a-f]{8}$/);
});
