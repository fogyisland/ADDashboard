// R65 followup — file-push backend tests.
//
// Covers the full lifecycle:
//   1. operator uploads a file (POST /api/admin/file-push)
//   2. agent polls and claims it (GET /api/agent/file-push?hostname=X)
//   3. agent downloads the bytes (GET /api/agent/file-push/:id/file)
//   4. agent acks delivery (POST /api/admin/file-push/:id/ack)
//
// Each step also asserts the matching audit row is emitted (push_file_uploaded
// / push_file_claimed / push_file_delivered / push_file_failed) so the
// operations log surfaces the full trail.
//
// The service uses an in-memory cache + filesystem persistence under
// process.env.ADDASHBOARD_FILE_PUSH_DIR. Each test isolates state by
// pointing the env at a tmp dir + calling the `_resetForTests` helper
// exposed by the service module.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import supertest from 'supertest';

import { signJwt } from '../src/auth/jwt.js';
import { _setDbForTest } from '../src/db/index.js';
import { buildMockDb } from './helpers/db-mock.js';

import { filePushRouter } from '../src/routes/file-push.js';
import { agentRouter } from '../src/routes/agent.js';
import {
  createTask, listTasks, getTask, getTaskFile,
  claimForAgent, ackTask, _resetForTests as resetService
} from '../src/services/file-push.js';
import { invalidateAgentTokenCache } from '../src/auth/agent-token.js';

// ── Test plumbing ────────────────────────────────────────────────────────

const SECRET = 'test-secret';
const AGENT_TOKEN = 'test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function adminToken(sub = 'u1') {
  return signJwt({ sub, role: 'admin', permissions: ['*'] }, SECRET, 60);
}

function freshTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'file-push-'));
  process.env.ADDASHBOARD_FILE_PUSH_DIR = dir;
  return dir;
}
function cleanTmpDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function sha256Of(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// buildAdminApp: builds the admin file-push router with a DB mock that
// also captures audit row writes for assertions.
function buildAdminApp(db = makeDb()) {
  const a = express();
  a.use(express.json({ limit: '12mb' }));
  return a.use(filePushRouter({
    logger: { info(){}, error(){}, warn(){}, debug(){} },
    db
  }));
}

// makeDb: produces a db mock whose execute() intercepts audit_logs inserts
// so tests can assert which audit rows fired (and with which userId/target).
function makeDb() {
  const auditRows = [];
  const db = buildMockDb().standard();
  const origExecute = db.execute;
  db.execute = async (sql, params = []) => {
    if (/INSERT\s+INTO\s+audit_logs/i.test(sql)) {
      auditRows.push({
        userId: params[0],
        action: params[1],
        target: params[2],
        payload: params[3]
      });
    }
    return origExecute(sql, params);
  };
  db.auditRows = auditRows;
  return db;
}

// buildAgentApp: wires the agentRouter with the agent-token bundle so the
// agentToken middleware accepts X-Agent-Token. Same mock-DB shape as the
// admin tests so the audit capture works for the push_file_claimed row.
function buildAgentApp(db = makeAgentDb()) {
  const a = express();
  a.use(express.json());
  return a.use(agentRouter({
    config: { jwtSecret: SECRET },
    logger: { info(){}, error(){}, warn(){}, debug(){} },
    mount: 'full'
  }));
}

function makeAgentDb() {
  // agentToken middleware reads agent_token_* rows from system_config.
  // Default mock returns the same AGENT_TOKEN so the test X-Agent-Token
  // header matches what the middleware considers "current".
  const auditRows = [];
  const db = buildMockDb([
    {
      match: /agent_token_(current|previous|rotated_at|previous_ttl_days)/i,
      rows: [{ config_key: 'agent_token_current', config_value: AGENT_TOKEN }]
    }
  ]).standard();
  const origExecute = db.execute;
  db.execute = async (sql, params = []) => {
    if (/INSERT\s+INTO\s+audit_logs/i.test(sql)) {
      auditRows.push({
        userId: params[0],
        action: params[1],
        target: params[2],
        payload: params[3]
      });
    }
    return origExecute(sql, params);
  };
  db.auditRows = auditRows;
  return db;
}

// ── Service-level tests ──────────────────────────────────────────────────

test('service: createTask round-trips with sha256, target list, and persistence', async () => {
  const dir = freshTmpDir();
  try {
    await resetService({ dir });
    const buffer = Buffer.from('hello operator world');
    const out = await createTask({
      filename: 'note.txt',
      buffer,
      targetType: 'dc',
      targets: ['hubadsrv1', 'ncadsrv1'],
      targetPath: 'C:\\shares',
      uploadedBy: 'u1'
    });
    assert.ok(out.taskId, 'taskId must be present');
    assert.equal(out.sizeBytes, buffer.length);
    assert.equal(out.sha256, sha256Of(buffer));
    assert.equal(out.targetCount, 2);

    const t = await getTask(out.taskId);
    assert.equal(t.filename, 'note.txt');
    assert.deepEqual(t.targets, ['hubadsrv1', 'ncadsrv1']);
    assert.equal(t.targetPath, 'C:\\shares');
    assert.equal(t.status, 'queued');
    assert.equal(t.uploadedBy, 'u1');
    assert.equal(t.targetStatus.length, 2);
    assert.equal(t.targetStatus[0].status, 'pending');
  } finally { cleanTmpDir(dir); }
});

test('service: listTasks returns newest-first across multiple creates', async () => {
  const dir = freshTmpDir();
  try {
    await resetService({ dir });
    const a = await createTask({
      filename: 'a.txt', buffer: Buffer.from('a'),
      targetType: 'dc', targets: ['dca'], targetPath: '/p', uploadedBy: 'u1'
    });
    // Ensure timestamp ordering is observable in CI:
    await new Promise(r => setTimeout(r, 5));
    const b = await createTask({
      filename: 'b.txt', buffer: Buffer.from('b'),
      targetType: 'dc', targets: ['dcb'], targetPath: '/p', uploadedBy: 'u1'
    });
    const all = await listTasks();
    assert.equal(all.length, 2);
    assert.equal(all[0].taskId, b.taskId, 'newest first');
    assert.equal(all[1].taskId, a.taskId);
  } finally { cleanTmpDir(dir); }
});

test('service: claimForAgent filters by hostname + transitions pending → claimed', async () => {
  const dir = freshTmpDir();
  try {
    await resetService({ dir });
    const t = await createTask({
      filename: 'h.bin', buffer: Buffer.from('content'),
      targetType: 'dc', targets: ['hubadsrv1'], targetPath: '/p', uploadedBy: 'u1'
    });
    // Wrong hostname → empty list
    const noneMatch = await claimForAgent('agent-wrong', 'ncadsrv2');
    assert.equal(noneMatch.length, 0);
    // Right hostname → 1 task
    const tasks = await claimForAgent('agent-hub-1', 'hubadsrv1');
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].taskId, t.taskId);
    assert.equal(tasks[0].status, 'claimed');
    // Target-level status was flipped to claimed
    const refetch = await getTask(t.taskId);
    assert.equal(refetch.targetStatus[0].status, 'claimed');
    assert.equal(refetch.targetStatus[0].claimedBy, 'agent-hub-1');
  } finally { cleanTmpDir(dir); }
});

test('service: ackTask ok=true flips target to delivered', async () => {
  const dir = freshTmpDir();
  try {
    await resetService({ dir });
    const t = await createTask({
      filename: 'ok.bin', buffer: Buffer.from('bytes'),
      targetType: 'server', targets: ['app01'], targetPath: '/opt', uploadedBy: 'u1'
    });
    await claimForAgent('agent-app01', 'app01');
    const result = await ackTask(t.taskId, 'app01', 'agent-app01', true, null);
    assert.equal(result.status, 'delivered');
    assert.equal(result.targetStatus[0].status, 'delivered');
    assert.ok(result.targetStatus[0].deliveredAt, 'deliveredAt must be set');
  } finally { cleanTmpDir(dir); }
});

test('service: ackTask ok=false flips target to failed with errorMessage', async () => {
  const dir = freshTmpDir();
  try {
    await resetService({ dir });
    const t = await createTask({
      filename: 'fail.bin', buffer: Buffer.from('bytes'),
      targetType: 'server', targets: ['app02'], targetPath: '/opt', uploadedBy: 'u1'
    });
    await claimForAgent('agent-app02', 'app02');
    const result = await ackTask(t.taskId, 'app02', 'agent-app02', false, 'permission denied');
    assert.equal(result.status, 'failed');
    assert.equal(result.targetStatus[0].status, 'failed');
    assert.equal(result.targetStatus[0].errorMessage, 'permission denied');
  } finally { cleanTmpDir(dir); }
});

test('service: getTaskFile returns the original buffer verbatim', async () => {
  const dir = freshTmpDir();
  try {
    await resetService({ dir });
    const payload = Buffer.from('round-trip-bytes-\u00ff\u0100\u4e2d\u6587');
    const t = await createTask({
      filename: 'rt.bin', buffer: payload,
      targetType: 'dc', targets: ['dca'], targetPath: '/p', uploadedBy: 'u1'
    });
    const out = await getTaskFile(t.taskId);
    assert.ok(Buffer.isBuffer(out));
    assert.equal(out.length, payload.length);
    assert.equal(out.toString('hex'), payload.toString('hex'));
  } finally { cleanTmpDir(dir); }
});

// ── Admin route tests (HTTP + audit emission) ────────────────────────────

test('admin POST /api/admin/file-push: returns 201 with taskId, sha256, targetCount', async () => {
  const dir = freshTmpDir();
  try {
    await resetService({ dir });
    _setDbForTest(makeDb());
    const buf = Buffer.from('hello world');
    const r = await supertest(buildAdminApp())
      .post('/api/admin/file-push')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        filename: 'note.txt',
        contentB64: buf.toString('base64'),
        targetType: 'dc',
        targets: ['hubadsrv1', 'ncadsrv1'],
        targetPath: 'C:\\shares'
      });
    assert.equal(r.status, 201);
    assert.ok(r.body.taskId, 'taskId present');
    assert.equal(r.body.sizeBytes, buf.length);
    assert.equal(r.body.targetCount, 2);
    assert.equal(r.body.sha256, sha256Of(buf));
  } finally { cleanTmpDir(dir); }
});

test('admin POST /api/admin/file-push: emits push_file_uploaded audit row', async () => {
  const dir = freshTmpDir();
  try {
    await resetService({ dir });
    const db = makeDb();
    _setDbForTest(db);
    const buf = Buffer.from('audit-row-test');
    const r = await supertest(buildAdminApp(db))
      .post('/api/admin/file-push')
      .set('Authorization', `Bearer ${adminToken('u-audit')}`)
      .send({
        filename: 'audit.txt',
        contentB64: buf.toString('base64'),
        targetType: 'dc',
        targets: ['dc01'],
        targetPath: '/p'
      });
    assert.equal(r.status, 201);
    const uploaded = db.auditRows.find(x => x.action === 'push_file_uploaded');
    assert.ok(uploaded, 'push_file_uploaded audit row must be present');
    assert.equal(uploaded.userId, 'u-audit');
    assert.equal(uploaded.target, r.body.taskId);
  } finally { cleanTmpDir(dir); }
});

test('admin POST /api/admin/file-push: 400 on missing fields', async () => {
  const dir = freshTmpDir();
  try {
    await resetService({ dir });
    _setDbForTest(makeDb());
    const cases = [
      { filename: 'a' },                                                                                  // no contentB64
      { contentB64: Buffer.from('x').toString('base64') },                                                // no filename
      { filename: 'a', contentB64: Buffer.from('x').toString('base64'), targetType: 'dc' },               // no targets
      { filename: 'a', contentB64: Buffer.from('x').toString('base64'), targetType: 'dc', targets: ['x'] },// no targetPath
      { filename: 'a', contentB64: Buffer.from('x').toString('base64'), targetType: 'WRONG', targets: ['x'], targetPath: '/p' }
    ];
    for (const body of cases) {
      const r = await supertest(buildAdminApp())
        .post('/api/admin/file-push')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send(body);
      assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    }
  } finally { cleanTmpDir(dir); }
});

test('admin POST /api/admin/file-push: 400 when sha256 mismatches decoded bytes', async () => {
  const dir = freshTmpDir();
  try {
    await resetService({ dir });
    _setDbForTest(makeDb());
    const buf = Buffer.from('hello');
    const real = sha256Of(buf);
    const wrong = '0'.repeat(64);
    assert.notEqual(real, wrong);
    const r = await supertest(buildAdminApp())
      .post('/api/admin/file-push')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        filename: 'mismatch.txt',
        contentB64: buf.toString('base64'),
        sha256: wrong,
        targetType: 'dc',
        targets: ['dc01'],
        targetPath: '/p'
      });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /sha256 mismatch/i);
  } finally { cleanTmpDir(dir); }
});

test('admin POST /api/admin/file-push: 401 without admin token', async () => {
  const dir = freshTmpDir();
  try {
    await resetService({ dir });
    _setDbForTest(makeDb());
    const r = await supertest(buildAdminApp())
      .post('/api/admin/file-push')
      .send({
        filename: 'a.txt',
        contentB64: Buffer.from('x').toString('base64'),
        targetType: 'dc',
        targets: ['x'],
        targetPath: '/p'
      });
    assert.equal(r.status, 401);
  } finally { cleanTmpDir(dir); }
});

test('admin GET /api/admin/file-push: lists tasks newest-first', async () => {
  const dir = freshTmpDir();
  try {
    await resetService({ dir });
    _setDbForTest(makeDb());
    const app = buildAdminApp();
    await supertest(app).post('/api/admin/file-push')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ filename: 'a', contentB64: Buffer.from('a').toString('base64'),
              targetType: 'dc', targets: ['da'], targetPath: '/p' });
    await new Promise(r => setTimeout(r, 5));
    await supertest(app).post('/api/admin/file-push')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ filename: 'b', contentB64: Buffer.from('b').toString('base64'),
              targetType: 'dc', targets: ['db'], targetPath: '/p' });
    const list = await supertest(app).get('/api/admin/file-push')
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body));
    assert.equal(list.body.length, 2);
    assert.equal(list.body[0].filename, 'b', 'newest first');
    assert.equal(list.body[1].filename, 'a');
  } finally { cleanTmpDir(dir); }
});

test('admin POST /:id/ack: ok=true emits push_file_delivered', async () => {
  const dir = freshTmpDir();
  try {
    await resetService({ dir });
    const db = makeDb();
    _setDbForTest(db);
    const app = buildAdminApp(db);
    const uploaded = await supertest(app).post('/api/admin/file-push')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ filename: 'd.bin', contentB64: Buffer.from('d').toString('base64'),
              targetType: 'dc', targets: ['dc-d'], targetPath: '/p' });
    assert.equal(uploaded.status, 201);
    const taskId = uploaded.body.taskId;
    const ack = await supertest(app).post(`/api/admin/file-push/${taskId}/ack`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ hostname: 'dc-d', agentId: 'a-d', ok: true });
    assert.equal(ack.status, 200);
    assert.equal(ack.body.status, 'delivered');
    const delivered = db.auditRows.find(x => x.action === 'push_file_delivered');
    assert.ok(delivered, 'push_file_delivered audit row must be present');
    assert.equal(delivered.target, taskId);
  } finally { cleanTmpDir(dir); }
});

test('admin POST /:id/ack: ok=false emits push_file_failed', async () => {
  const dir = freshTmpDir();
  try {
    await resetService({ dir });
    const db = makeDb();
    _setDbForTest(db);
    const app = buildAdminApp(db);
    const uploaded = await supertest(app).post('/api/admin/file-push')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ filename: 'f.bin', contentB64: Buffer.from('f').toString('base64'),
              targetType: 'dc', targets: ['dc-f'], targetPath: '/p' });
    const taskId = uploaded.body.taskId;
    const ack = await supertest(app).post(`/api/admin/file-push/${taskId}/ack`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ hostname: 'dc-f', agentId: 'a-f', ok: false, errorMessage: 'EACCES' });
    assert.equal(ack.status, 200);
    assert.equal(ack.body.status, 'failed');
    assert.equal(ack.body.targetStatus[0].errorMessage, 'EACCES');
    const failed = db.auditRows.find(x => x.action === 'push_file_failed');
    assert.ok(failed, 'push_file_failed audit row must be present');
    assert.equal(failed.target, taskId);
  } finally { cleanTmpDir(dir); }
});

test('admin POST /:id/ack: 404 when hostname not in task targets', async () => {
  const dir = freshTmpDir();
  try {
    await resetService({ dir });
    _setDbForTest(makeDb());
    const app = buildAdminApp();
    const uploaded = await supertest(app).post('/api/admin/file-push')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ filename: 'x.bin', contentB64: Buffer.from('x').toString('base64'),
              targetType: 'dc', targets: ['dc-x'], targetPath: '/p' });
    const ack = await supertest(app).post(`/api/admin/file-push/${uploaded.body.taskId}/ack`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ hostname: 'someone-else', agentId: 'a-x', ok: true });
    assert.equal(ack.status, 404);
  } finally { cleanTmpDir(dir); }
});

test('admin GET /:id/file: returns binary + X-File-Sha256 header', async () => {
  const dir = freshTmpDir();
  try {
    await resetService({ dir });
    _setDbForTest(makeDb());
    const app = buildAdminApp();
    const buf = Buffer.from('binary-content-\u00ff');
    const uploaded = await supertest(app).post('/api/admin/file-push')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ filename: 'bin.bin',
              contentB64: buf.toString('base64'),
              targetType: 'dc', targets: ['dc-b'], targetPath: '/p' });
    const got = await supertest(app).get(`/api/admin/file-push/${uploaded.body.taskId}/file`)
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(got.status, 200);
    assert.equal(got.headers['x-file-sha256'], uploaded.body.sha256);
    assert.equal(got.headers['content-disposition'], 'attachment; filename="bin.bin"');
    assert.equal(got.body.length, buf.length);
    assert.equal(Buffer.from(got.body).toString('hex'), buf.toString('hex'));
  } finally { cleanTmpDir(dir); }
});

// ── Agent route tests ────────────────────────────────────────────────────

test('agent GET /api/agent/file-push: returns only tasks targeting this hostname', async () => {
  const dir = freshTmpDir();
  try {
    await resetService({ dir });
    _setDbForTest(makeAgentDb());
    // Seed two tasks: one for hubadsrv1, one for ncadsrv1
    await createTask({ filename: 'for-hub.txt', buffer: Buffer.from('h'),
      targetType: 'dc', targets: ['hubadsrv1'], targetPath: '/p', uploadedBy: 'u1' });
    await createTask({ filename: 'for-nc.txt', buffer: Buffer.from('n'),
      targetType: 'dc', targets: ['ncadsrv1'], targetPath: '/p', uploadedBy: 'u1' });

    const r = await supertest(buildAgentApp())
      .get('/api/agent/file-push?hostname=hubadsrv1&agentId=hub-1')
      .set('X-Agent-Token', AGENT_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.tasks.length, 1);
    assert.equal(r.body.tasks[0].filename, 'for-hub.txt');
    // Agent view shape omits targetStatus (admin-only field)
    assert.equal(r.body.tasks[0].targetStatus, undefined);
  } finally { cleanTmpDir(dir); }
});

test('agent GET /api/agent/file-push: 400 without hostname', async () => {
  const dir = freshTmpDir();
  try {
    await resetService({ dir });
    _setDbForTest(makeAgentDb());
    const r = await supertest(buildAgentApp())
      .get('/api/agent/file-push')
      .set('X-Agent-Token', AGENT_TOKEN);
    assert.equal(r.status, 400);
  } finally { cleanTmpDir(dir); }
});

test('agent GET /api/agent/file-push: emits push_file_claimed audit row', async () => {
  const dir = freshTmpDir();
  try {
    await resetService({ dir });
    const db = makeAgentDb();
    _setDbForTest(db);
    await createTask({ filename: 'a.bin', buffer: Buffer.from('a'),
      targetType: 'dc', targets: ['dc-a'], targetPath: '/p', uploadedBy: 'u1' });

    const r = await supertest(buildAgentApp(db))
      .get('/api/agent/file-push?hostname=dc-a&agentId=a-1')
      .set('X-Agent-Token', AGENT_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.tasks.length, 1);
    const claimed = db.auditRows.find(x => x.action === 'push_file_claimed');
    assert.ok(claimed, 'push_file_claimed audit row must be present');
    assert.equal(claimed.target, r.body.tasks[0].taskId);
  } finally { cleanTmpDir(dir); }
});

test('agent GET /api/agent/file-push/:id/file: 403 when hostname not a target', async () => {
  const dir = freshTmpDir();
  try {
    await resetService({ dir });
    _setDbForTest(makeAgentDb());
    const t = await createTask({ filename: 'priv.bin', buffer: Buffer.from('private'),
      targetType: 'dc', targets: ['dc-only'], targetPath: '/p', uploadedBy: 'u1' });
    const r = await supertest(buildAgentApp())
      .get(`/api/agent/file-push/${t.taskId}/file?hostname=some-other-dc`)
      .set('X-Agent-Token', AGENT_TOKEN);
    assert.equal(r.status, 403);
  } finally { cleanTmpDir(dir); }
});

test('agent GET /api/agent/file-push/:id/file: returns bytes when hostname matches', async () => {
  const dir = freshTmpDir();
  try {
    await resetService({ dir });
    _setDbForTest(makeAgentDb());
    const buf = Buffer.from('agent-download-bytes');
    const t = await createTask({ filename: 'a.bin', buffer: buf,
      targetType: 'dc', targets: ['dc-ok'], targetPath: '/p', uploadedBy: 'u1' });
    const r = await supertest(buildAgentApp())
      .get(`/api/agent/file-push/${t.taskId}/file?hostname=dc-ok`)
      .set('X-Agent-Token', AGENT_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-file-sha256'], t.sha256);
    assert.equal(Buffer.from(r.body).toString('hex'), buf.toString('hex'));
  } finally { cleanTmpDir(dir); }
});

// ── Classifier coverage (sibling-SDD audit pattern) ──────────────────────

test('classifier: R65 file-push actions resolve to non-default categories', async () => {
  const { classifyAction } = await import('../src/services/audit-classifier.js');
  const cases = [
    { action: 'push_file_uploaded'  },
    { action: 'push_file_claimed'   },
    { action: 'push_file_delivered' },
    { action: 'push_file_failed'    }
  ];
  for (const c of cases) {
    const r = classifyAction(c.action);
    assert.equal(r.category, 'changes', `${c.action} → changes`);
    assert.ok(r.severity, `${c.action} must have a severity`);
    assert.ok(r.label,    `${c.action} must have a label`);
    assert.notEqual(r.label, c.action, `${c.action} must have a Chinese label, not the raw action`);
  }
});