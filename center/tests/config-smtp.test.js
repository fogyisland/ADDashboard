// Unit tests for Task 12 — SMTP config mask-on-read + preserve-empty-on-write
// + test-mail route + seedSmtpDefaultsIfMissing.
//
// Pins the regression behavior:
//   - getConfigAll(['smtp_host','smtp_password']) returns the password masked
//     as '********' so it never leaks through GET /api/admin/config.
//   - getConfigAll(['smtp_host']) returns a row not in keys (no overlap) —
//     i.e. the SQL WHERE filters server-side, not in JS.
//   - putConfig with smtp_password='' or smtp_password='********' preserves
//     the existing value (no-op write, no audit row).
//   - putConfig with a real smtp_password updates the row.
//   - putConfig with a MIXED patch updates other keys but strips the masked
//     password (M-5 — proves the strip is key-scoped).
//   - putConfig records userId on every audit row (I-2 — caller-supplied).
//   - putConfig redacts smtp_password on the audit row even when the
//     system_config UPDATE carries cleartext (I-3).
//   - PUT /api/admin/config uses putConfig and redacts smtp_password from
//     the writeAudit payload (C-1 + I-3).
//   - seedSmtpDefaultsIfMissing writes the documented defaults to rows that
//     are absent, and is idempotent on rows that already exist.
//   - POST /api/admin/config/email/test calls email.send() with a fake
//     transport (via _deps.createTransport) and the real password reaches
//     nodemailer (I-5).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { adminRouter } from '../src/routes/admin.js';
import { signJwt } from '../src/auth/jwt.js';
import { _setDbForTest } from '../src/db/index.js';
import { buildMockDb } from './helpers/db-mock.js';

const SECRET = 'test-secret';
function adminToken(extra = {}) { return signJwt({ sub: 'u42', role: 'admin', permissions: ['*'], ...extra }, SECRET, 60); }
function buildApp(opts = {}) {
  const a = express(); a.use(express.json());
  // Test seam: a fake nodemailer transport wired via app.locals. The test-mail
  // route reads it and forwards to email.send() via the existing _deps
  // argument on email.send (see center/src/services/email.js:42). The fake
  // records whatever auth values email.send forwarded so tests can assert
  // the real smtp_password reached the SMTP layer (not the masked sentinel).
  a.locals.__smtpTestDeps = opts.deps;
  return a.use(adminRouter({ config: { jwtSecret: SECRET }, logger: { info(){}, error(){}, warn(){}, debug(){} } }));
}

// ----- getConfigAll -----

test('getConfigAll masks smtp_password as ********', async () => {
  const { getConfigAll } = await import('../src/services/config.js');
  const db = buildMockDb([
    {
      match: /FROM\s+system_config/i,
      rows: [
        { config_key: 'smtp_host', config_value: 'smtp.example.com' },
        { config_key: 'smtp_password', config_value: 'plain-secret' }
      ]
    }
  ]).standard();
  _setDbForTest(db);
  const cfg = await getConfigAll(['smtp_host', 'smtp_password']);
  assert.equal(cfg.smtp_host, 'smtp.example.com');
  assert.equal(cfg.smtp_password, '********');
});

test('getConfigAll returns undefined for absent password (no mask when key missing)', async () => {
  const { getConfigAll } = await import('../src/services/config.js');
  const db = buildMockDb([
    {
      match: /FROM\s+system_config/i,
      rows: [
        { config_key: 'smtp_host', config_value: 'smtp.example.com' }
      ]
    }
  ]).standard();
  _setDbForTest(db);
  const cfg = await getConfigAll(['smtp_host', 'smtp_password']);
  // Empty/absent password is not masked (mask only triggers on a real value)
  assert.equal(cfg.smtp_password, undefined);
});

test('getConfigAll uses SQL WHERE to filter server-side (M-2)', async () => {
  const { getConfigAll } = await import('../src/services/config.js');
  const db = buildMockDb([
    {
      // The SQL must contain an IN (...) clause — the prior implementation
      // fetched every row and filtered in JS, which is what M-2 flagged.
      match: /FROM\s+system_config\s+WHERE\s+config_key\s+IN/i,
      rows: [
        { config_key: 'smtp_host', config_value: 'smtp.example.com' }
      ]
    },
    // Catch any full-table scan to prove we did NOT fall back to the
    // js-filter path.
    {
      match: /^SELECT config_key, config_value FROM system_config$/i,
      rows: []
    }
  ]).standard();
  _setDbForTest(db);
  const cfg = await getConfigAll(['smtp_host']);
  assert.equal(cfg.smtp_host, 'smtp.example.com');
  assert.equal(cfg.smtp_port, undefined);
});

// ----- putConfig -----

test('putConfig with empty smtp_password preserves existing value (no-op write)', async () => {
  const { putConfig } = await import('../src/services/config.js');
  // Pre-existing row reads back the existing value; the SELECT before-write
  // returns the plain password; after putConfig with '' the SELECT should
  // still return the plain password.
  const records = [];
  const db = buildMockDb([
    { match: /FROM\s+system_config/i, rows: [
      { config_key: 'smtp_password', config_value: 'plain-secret' }
    ] },
    { match: /(INSERT\s+INTO\s+system_config|MERGE\s+INTO\s+system_config)/i, capture: true, onExecute: (sql, params) => records.push({ sql, params }) },
    { match: /INSERT\s+INTO\s+sys_config_audit/i, capture: true, onExecute: (sql, params) => records.push({ sql, params }) }
  ]).withRecording(records);
  _setDbForTest(db);
  await putConfig({ smtp_password: '' });
  // No upsert should have been issued for the smtp_password key because
  // empty-string means "preserve existing".
  const smtpUpdate = records.find(r =>
    /(INSERT\s+INTO\s+system_config|MERGE\s+INTO\s+system_config)/i.test(r.sql) && r.params[0] === 'smtp_password'
  );
  assert.equal(smtpUpdate, undefined, 'empty smtp_password must not UPDATE the row');
});

test('putConfig with ******** preserves existing value (no-op write)', async () => {
  const { putConfig } = await import('../src/services/config.js');
  const records = [];
  const db = buildMockDb([
    { match: /FROM\s+system_config/i, rows: [
      { config_key: 'smtp_password', config_value: 'plain-secret' }
    ] },
    { match: /(INSERT\s+INTO\s+system_config|MERGE\s+INTO\s+system_config)/i, capture: true, onExecute: (sql, params) => records.push({ sql, params }) }
  ]).withRecording(records);
  _setDbForTest(db);
  await putConfig({ smtp_password: '********' });
  const smtpUpdate = records.find(r =>
    /(INSERT\s+INTO\s+system_config|MERGE\s+INTO\s+system_config)/i.test(r.sql) && r.params[0] === 'smtp_password'
  );
  assert.equal(smtpUpdate, undefined, 'masked sentinel must not UPDATE the row');
});

test('putConfig with real smtp_password value updates the row', async () => {
  const { putConfig } = await import('../src/services/config.js');
  const records = [];
  const db = buildMockDb([
    { match: /FROM\s+system_config/i, rows: [
      { config_key: 'smtp_password', config_value: 'old' }
    ] },
    { match: /(INSERT\s+INTO\s+system_config|MERGE\s+INTO\s+system_config)/i, capture: true, onExecute: (sql, params) => records.push({ sql, params }) },
    { match: /INSERT\s+INTO\s+sys_config_audit/i, capture: true, onExecute: (sql, params) => records.push({ sql, params }) }
  ]).withRecording(records);
  _setDbForTest(db);
  await putConfig({ smtp_password: 'new-secret' });
  const smtpUpdate = records.find(r =>
    /(INSERT\s+INTO\s+system_config|MERGE\s+INTO\s+system_config)/i.test(r.sql) && r.params[0] === 'smtp_password'
  );
  assert.ok(smtpUpdate, 'real smtp_password must UPDATE the row');
  assert.equal(smtpUpdate.params[1], 'new-secret');
});

test('putConfig with mixed patch — strip is key-scoped (M-5)', async () => {
  // The two preserve tests above are vacuous because putConfig short-circuits
  // before any SQL. This test sends a MIXED patch (masked password + a real
  // host change) so we can prove: the password is NOT updated, but the host
  // IS — i.e. the strip is key-scoped, not a blanket no-op.
  const { putConfig } = await import('../src/services/config.js');
  const records = [];
  const db = buildMockDb([
    { match: /FROM\s+system_config/i, rows: [
      { config_key: 'smtp_password', config_value: 'plain-secret' },
      { config_key: 'smtp_host', config_value: 'old-host.example.com' }
    ] },
    { match: /(INSERT\s+INTO\s+system_config|MERGE\s+INTO\s+system_config)/i, capture: true, onExecute: (sql, params) => records.push({ sql, params }) },
    { match: /INSERT\s+INTO\s+sys_config_audit/i, capture: true, onExecute: (sql, params) => records.push({ sql, params }) }
  ]).withRecording(records);
  _setDbForTest(db);
  await putConfig({ smtp_password: '********', smtp_host: 'new-host.example.com' });
  const smtpPwUpdate = records.find(r =>
    /(INSERT\s+INTO\s+system_config|MERGE\s+INTO\s+system_config)/i.test(r.sql) && r.params[0] === 'smtp_password'
  );
  const smtpHostUpdate = records.find(r =>
    /(INSERT\s+INTO\s+system_config|MERGE\s+INTO\s+system_config)/i.test(r.sql) && r.params[0] === 'smtp_host'
  );
  assert.equal(smtpPwUpdate, undefined, 'masked smtp_password must NOT be written');
  assert.ok(smtpHostUpdate, 'smtp_host must be written');
  assert.equal(smtpHostUpdate.params[1], 'new-host.example.com');
});

test('putConfig with real smtp_password redacts audit row (I-3)', async () => {
  // The system_config UPDATE carries the real cleartext password (UI
  // submitted it on purpose); the audit row MUST mask it so cleartext
  // never lands in sys_config_audit.
  const { putConfig } = await import('../src/services/config.js');
  const auditWrites = [];
  const db = buildMockDb([
    { match: /FROM\s+system_config/i, rows: [
      { config_key: 'smtp_password', config_value: 'old-secret' }
    ] },
    { match: /(INSERT\s+INTO\s+system_config|MERGE\s+INTO\s+system_config)/i, rows: [] },
    { match: /INSERT\s+INTO\s+sys_config_audit/i, capture: true, onExecute: (sql, params) => auditWrites.push({ sql, params }) }
  ]).standard();
  _setDbForTest(db);
  await putConfig({ smtp_password: 'new-secret' });
  const smtpAudit = auditWrites.find(r => r.params[0] === 'smtp_password');
  assert.ok(smtpAudit, 'audit row must be written for smtp_password');
  assert.equal(smtpAudit.params[1], '********', 'old_value must be masked');
  assert.equal(smtpAudit.params[2], '********', 'new_value must be masked');
});

test('putConfig records caller userId on every audit row (I-2)', async () => {
  const { putConfig } = await import('../src/services/config.js');
  const auditWrites = [];
  const db = buildMockDb([
    { match: /FROM\s+system_config/i, rows: [
      { config_key: 'smtp_host', config_value: 'old.example.com' }
    ] },
    { match: /(INSERT\s+INTO\s+system_config|MERGE\s+INTO\s+system_config)/i, rows: [] },
    { match: /INSERT\s+INTO\s+sys_config_audit/i, capture: true, onExecute: (sql, params) => auditWrites.push({ sql, params }) }
  ]).standard();
  _setDbForTest(db);
  await putConfig({ smtp_host: 'new.example.com' }, 42);
  const hostAudit = auditWrites.find(r => r.params[0] === 'smtp_host');
  assert.ok(hostAudit);
  assert.equal(hostAudit.params[3], 42, 'changed_by must be caller-supplied userId');
});

// ----- PUT /api/admin/config (C-1) -----

test('PUT /api/admin/config uses putConfig and redacts smtp_password from writeAudit payload', async () => {
  // Wire-up test for C-1: the live PUT route MUST go through putConfig so
  // the smtp_password strip applies. Without the wiring, an operator who
  // types a real password, then edits another field and re-saves, would
  // silently clobber the password with '********'. This test seeds a real
  // password, sends a PUT that omits smtp_password (UI didn't touch it),
  // and asserts: the putConfig transaction was called and the writeAudit
  // payload (audit_logs row) doesn't carry smtp_password in cleartext.
  const auditLogs = [];
  const sysConfigAudits = [];
  const db = buildMockDb([
    { match: /FROM\s+system_config/i, rows: [
      { config_key: 'smtp_password', config_value: 'real-plain-secret' },
      { config_key: 'smtp_host', config_value: 'old.example.com' }
    ] },
    { match: /(INSERT\s+INTO\s+system_config|MERGE\s+INTO\s+system_config)/i, rows: [] },
    { match: /INSERT\s+INTO\s+sys_config_audit/i, capture: true, onExecute: (sql, params) => sysConfigAudits.push({ sql, params }) },
    { match: /INSERT\s+INTO\s+audit_logs/i, capture: true, onExecute: (sql, params) => auditLogs.push({ sql, params }) }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .put('/api/admin/config')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ smtp_host: 'new.example.com' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  // C-1 wire-up proof: the sys_config_audit row for smtp_host must have
  // been written by putConfig inside the route's transaction. Without the
  // wiring (i.e. if the route still used the old inline UPDATE loop), no
  // audit row would land here because the inline loop wouldn't be called.
  const hostAudit = sysConfigAudits.find(r => r.params[0] === 'smtp_host');
  assert.ok(hostAudit, 'putConfig must write a sys_config_audit row for smtp_host');
  assert.equal(hostAudit.params[1], 'old.example.com');
  assert.equal(hostAudit.params[2], 'new.example.com');
  // The writeAudit row's payload column must NOT contain smtp_password in
  // cleartext — the route strips the key from the request body before
  // building the audit payload.
  const updateRow = auditLogs.find(r => r.params[1] === 'update_config');
  assert.ok(updateRow, 'update_config audit row must be written');
  const payload = JSON.parse(updateRow.params[3]);
  assert.equal(payload.smtp_password, undefined, 'smtp_password must not appear in audit payload');
});

// ----- seedSmtpDefaultsIfMissing -----

test('seedSmtpDefaultsIfMissing: writes all 12 default rows when system_config is empty', async () => {
  const { seedSmtpDefaultsIfMissing } = await import('../src/services/config.js');
  const records = [];
  const db = buildMockDb([
    { match: /FROM\s+system_config/i, rows: [] }
  ]).withRecording(records);
  _setDbForTest(db);
  const r = await seedSmtpDefaultsIfMissing({ info() {} });
  assert.equal(r.seeded, 12);
  // Every default key should appear in an INSERT|MERGE upsert.
  const upserts = records.filter(r =>
    /INSERT\s+INTO\s+system_config|MERGE\s+INTO\s+system_config/i.test(r.sql)
  );
  assert.equal(upserts.length, 12);
});

test('seedSmtpDefaultsIfMissing: idempotent — skips rows that already exist', async () => {
  const { seedSmtpDefaultsIfMissing } = await import('../src/services/config.js');
  const records = [];
  // Pre-populate 3 of the 12 defaults so only 9 upserts should fire.
  const db = buildMockDb([
    { match: /FROM\s+system_config/i, rows: [
      { config_key: 'smtp_host', config_value: 'smtp.example.com' },
      { config_key: 'smtp_port', config_value: '587' },
      { config_key: 'smtp_from', config_value: 'noreply@example.com' }
    ] }
  ]).withRecording(records);
  _setDbForTest(db);
  const r = await seedSmtpDefaultsIfMissing({ info() {} });
  assert.equal(r.seeded, 9);
  const upserts = records.filter(r =>
    /INSERT\s+INTO\s+system_config|MERGE\s+INTO\s+system_config/i.test(r.sql)
  );
  assert.equal(upserts.length, 9);
});

// ----- POST /api/admin/config/email/test (I-5 + M-6) -----

test('POST /api/admin/config/email/test forwards real smtp_password to createTransport (I-5)', async () => {
  // The test seam via app.locals.__smtpTestDeps is read by the route and
  // passed as the second arg to email.send(). email.send destructures
  // _deps.createTransport and calls it with the SMTP options — including
  // auth.pass. By stubbing createTransport we can assert the route
  // forwarded the real password (NOT the masked sentinel).
  let capturedAuth = null;
  const fakeTransport = {
    sendMail: async () => ({ messageId: 'fake' })
  };
  const fakeDeps = {
    createTransport: (opts) => {
      capturedAuth = opts.auth;
      return fakeTransport;
    }
  };
  const db = buildMockDb([
    {
      match: /FROM\s+system_config/i,
      rows: [
        { config_key: 'smtp_host', config_value: 'smtp.example.com' },
        { config_key: 'smtp_port', config_value: '587' },
        { config_key: 'smtp_secure', config_value: 'false' },
        { config_key: 'smtp_user', config_value: 'user@example.com' },
        { config_key: 'smtp_password', config_value: 'plain-secret' },
        { config_key: 'smtp_from', config_value: 'noreply@example.com' }
      ]
    }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp({ deps: fakeDeps }))
    .post('/api/admin/config/email/test')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ to: 'someone@example.com' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  // The auth block handed to nodemailer must carry the real password —
  // NOT the masked sentinel, NOT undefined.
  assert.ok(capturedAuth, 'createTransport must be called with an auth block');
  assert.equal(capturedAuth.user, 'user@example.com');
  assert.equal(capturedAuth.pass, 'plain-secret', 'auth.pass must be the real password, not masked');
});

test('POST /api/admin/config/email/test omits auth when smtp_user is empty', async () => {
  let capturedAuth = undefined;
  const fakeTransport = { sendMail: async () => ({}) };
  const fakeDeps = {
    createTransport: (opts) => { capturedAuth = opts.auth; return fakeTransport; }
  };
  const db = buildMockDb([
    {
      match: /FROM\s+system_config/i,
      rows: [
        { config_key: 'smtp_host', config_value: 'smtp.example.com' },
        { config_key: 'smtp_port', config_value: '25' },
        { config_key: 'smtp_secure', config_value: 'false' },
        { config_key: 'smtp_user', config_value: '' },
        { config_key: 'smtp_password', config_value: '' },
        { config_key: 'smtp_from', config_value: 'noreply@example.com' }
      ]
    }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp({ deps: fakeDeps }))
    .post('/api/admin/config/email/test')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ to: 'someone@example.com' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(capturedAuth, undefined, 'no auth block when smtp_user is empty');
});

test('POST /api/admin/config/email/test rejects missing `to`', async () => {
  const db = buildMockDb([
    {
      match: /FROM\s+system_config/i,
      rows: [{ config_key: 'smtp_host', config_value: 'smtp.example.com' }]
    }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .post('/api/admin/config/email/test')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({});
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'to is required');
});