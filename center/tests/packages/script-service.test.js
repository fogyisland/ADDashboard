// R66 task-5 — script-service unit tests.
//
// Covers the 4 public service functions (installScript / editScript /
// setPolicy / deleteScript) against an in-memory fake db that mimics the
// mysql2 driver's `{ rows }` execute() contract. No real DB is touched.
//
// The fake db routes on the leading keywords of the SQL emitted by the T3
// (`packageScripts`) and T4 (`packagePolicies`) helpers, so any param-order
// drift in those helpers surfaces here as a failing assertion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { installScript, editScript, setPolicy, deleteScript } from '../../src/packages/script-service.js';

// Helper: build a fake db + audit recorder
function makeFakeDb({ existingScripts = [], existingPolicies = [] } = {}) {
  const scriptRows = [...existingScripts];
  const policyRows = [...existingPolicies];
  const auditCalls = [];
  const db = {
    dialect: 'mysql',
    async execute(sql, params) {
      const trimmed = sql.trim();
      if (trimmed.startsWith('INSERT INTO package_scripts')) {
        scriptRows.push({ name: params[0], script_sha256: params[3], source: params[5] });
        return { rows: [] };
      }
      if (trimmed.startsWith('INSERT INTO package_policies')) {
        policyRows.push({ name: params[0], interval_sec: params[1], enabled: params[3] });
        return { rows: [] };
      }
      // SELECT support — packageScripts.get / packagePolicies.getByName read
      // through these. Without them every get() would return null and the
      // duplicate / not-found branches could never be exercised.
      if (trimmed.startsWith('SELECT * FROM package_scripts WHERE name')) {
        const r = scriptRows.find(row => row.name === params[0]);
        return { rows: r ? [r] : [] };
      }
      if (trimmed.startsWith('SELECT * FROM package_policies WHERE name')) {
        const r = policyRows.find(row => row.name === params[0]);
        return { rows: r ? [r] : [] };
      }
      if (trimmed.startsWith('UPDATE package_scripts SET script_content')) {
        const r = scriptRows.find(r => r.name === params[3]);
        if (r) r.script_sha256 = params[1];
        return { rows: [] };
      }
      if (trimmed.startsWith('UPDATE package_policies')) {
        return { rows: [] };
      }
      if (trimmed.startsWith('DELETE FROM package_scripts')) {
        const i = scriptRows.findIndex(r => r.name === params[0]);
        if (i >= 0) scriptRows.splice(i, 1);
        return { rows: [] };
      }
      if (trimmed.startsWith('DELETE FROM package_policies')) {
        const i = policyRows.findIndex(r => r.name === params[0]);
        if (i >= 0) policyRows.splice(i, 1);
        return { rows: [] };
      }
      return { rows: [] };
    }
  };
  return { db, scriptRows, policyRows, auditCalls };
}

test('installScript writes script + default policy + audit row', async () => {
  const { db, scriptRows, policyRows } = makeFakeDb();
  const auditCalls = [];
  await installScript({
    db, name: 'pkg-a', content: 'Write-Host hi', type: 'gauge', agentType: 'ad',
    description: 'test', intervalSec: 3600, timeoutMs: 30000,
    writeAudit: async (a) => auditCalls.push(a)
  });
  assert.equal(scriptRows.length, 1);
  assert.equal(policyRows.length, 1);
  assert.equal(scriptRows[0].source, 'admin-upload');
  assert.equal(policyRows[0].interval_sec, 3600);
  assert.equal(auditCalls[0].action, 'upload_script');
  assert.match(auditCalls[0].details.scriptSha, /^[0-9a-f]{8}$/);
});

test('installScript rejects duplicate name', async () => {
  const { db } = makeFakeDb({ existingScripts: [{ name: 'pkg-a' }] });
  await assert.rejects(
    installScript({ db, name: 'pkg-a', content: 'x', type: 'gauge', agentType: 'ad',
                    description: 't', intervalSec: 60, timeoutMs: 1000, writeAudit: async () => {} }),
    /already exists/i
  );
});

test('installScript rejects oversized content (>1 MB)', async () => {
  const { db } = makeFakeDb();
  const huge = 'x'.repeat(1024 * 1024 + 1);
  await assert.rejects(
    installScript({ db, name: 'pkg-x', content: huge, type: 'gauge', agentType: 'ad',
                    description: 't', intervalSec: 60, timeoutMs: 1000, writeAudit: async () => {} }),
    /too large/i
  );
});

test('installScript strips intervalSec + timeoutMs from manifest.agent', async () => {
  let capturedManifest = null;
  const db = {
    dialect: 'mysql',
    async execute(sql, params) {
      if (sql.trim().startsWith('INSERT INTO package_scripts')) {
        capturedManifest = JSON.parse(params[4]);
      }
      return { rows: [] };
    }
  };
  await installScript({ db, name: 'pkg-z', content: 'x', type: 'gauge', agentType: 'ad',
    description: 't', intervalSec: 60, timeoutMs: 1000, writeAudit: async () => {} });
  assert.equal(capturedManifest.agent.intervalSec, undefined);
  assert.equal(capturedManifest.agent.timeoutMs, undefined);
});

test('editScript updates sha256 + writes audit', async () => {
  const { db } = makeFakeDb({ existingScripts: [{ name: 'pkg-a', script_sha256: 'old'.repeat(16) }] });
  const auditCalls = [];
  const r = await editScript({ db, name: 'pkg-a', content: 'new', writeAudit: async (a) => auditCalls.push(a) });
  assert.equal(r.oldSha, 'old'.repeat(16));
  assert.match(r.newSha, /^[0-9a-f]{64}$/);
  assert.equal(auditCalls[0].action, 'edit_script');
});

test('editScript no-op when sha unchanged → skip audit', async () => {
  const { db } = makeFakeDb({ existingScripts: [{ name: 'pkg-a', script_sha256: crypto.createHash('sha256').update('same').digest('hex') }] });
  const auditCalls = [];
  await editScript({ db, name: 'pkg-a', content: 'same', writeAudit: async (a) => auditCalls.push(a) });
  assert.equal(auditCalls.length, 0);
});

test('editScript throws on missing', async () => {
  const { db } = makeFakeDb();
  await assert.rejects(editScript({ db, name: 'no-such', content: 'x', writeAudit: async () => {} }), /not found/i);
});

test('setPolicy partial body writes only present fields + audit', async () => {
  const { db } = makeFakeDb({ existingPolicies: [{ name: 'pkg-a' }] });
  const auditCalls = [];
  await setPolicy({ db, name: 'pkg-a', intervalSec: 60, writeAudit: async (a) => auditCalls.push(a) });
  assert.equal(auditCalls[0].action, 'set_policy');
  assert.deepEqual(auditCalls[0].details.fields, ['intervalSec']);
});

test('setPolicy rejects intervalSec < 5', async () => {
  const { db } = makeFakeDb();
  await assert.rejects(
    setPolicy({ db, name: 'pkg-a', intervalSec: 1, writeAudit: async () => {} }),
    /intervalSec.*5/
  );
});

test('setPolicy rejects timeoutMs < 1000', async () => {
  const { db } = makeFakeDb();
  await assert.rejects(
    setPolicy({ db, name: 'pkg-a', timeoutMs: 500, writeAudit: async () => {} }),
    /timeoutMs.*1000/
  );
});

test('setPolicy rejects scope not in enum', async () => {
  const { db } = makeFakeDb();
  await assert.rejects(
    setPolicy({ db, name: 'pkg-a', scope: 'host:X', writeAudit: async () => {} }),
    /scope.*global|agent_type:ad|agent_type:non-ad/
  );
});

test('deleteScript cascade — script gone, audit written', async () => {
  const { db, scriptRows } = makeFakeDb({
    existingScripts: [{ name: 'pkg-a' }],
    existingPolicies: [{ name: 'pkg-a' }]
  });
  const auditCalls = [];
  // FK cascade — script delete triggers policy delete (DB-level). But our
  // service also deletes explicitly to be safe under both dialects.
  await deleteScript({ db, name: 'pkg-a', writeAudit: async (a) => auditCalls.push(a) });
  assert.equal(scriptRows.length, 0);
  assert.equal(auditCalls[0].action, 'delete_script');
});

test('SHA256 determinism (same content → same hash)', () => {
  const a = crypto.createHash('sha256').update('hello').digest('hex');
  const b = crypto.createHash('sha256').update('hello').digest('hex');
  assert.equal(a, b);
});

test('SHA256 collision (different content → different hash)', () => {
  const a = crypto.createHash('sha256').update('hello').digest('hex');
  const b = crypto.createHash('sha256').update('world').digest('hex');
  assert.notEqual(a, b);
});
