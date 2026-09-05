// 2026-09-05 R81 — agent route tests for /api/agent/member-commands/*.
//
// Two endpoints:
//   GET  /api/agent/member-commands?hostname=X   (claim up to 5)
//   POST /api/agent/member-commands/:id/result   (terminal ack)
//
// Auth-gated by agentToken (NOT userAuth). Mirrors
// tests/routes/agent-ad-commands.test.js (R75) with hostname instead
// of targetDc.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import supertest from 'supertest';

import { _setDbForTest } from '../../src/db/index.js';
import { buildMockDb } from '../helpers/db-mock.js';
import { agentRouter } from '../../src/routes/agent.js';
import { invalidateAgentTokenCache } from '../../src/auth/agent-token.js';

const AGENT_TOKEN = 'test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function buildDb({ seededCommands = [] } = {}) {
  const auditRows = [];
  const store = {
    rows: seededCommands.map((r, i) => ({
      id: r.id ?? (100 + i),
      hostname: r.hostname,
      command_type: r.commandType ?? r.command_type ?? 'member_script',
      params_json: typeof r.params === 'string' ? r.params : JSON.stringify(r.params ?? {}),
      status: r.status ?? 'queued',
      operator_id: null,
      operator_username: null,
      result_json: null,
      error_message: null,
      duration_ms: null,
      created_at: r.createdAt ?? new Date().toISOString(),
      claimed_at: r.claimedAt ?? null,
      completed_at: r.completedAt ?? null
    }))
  };
  const db = buildMockDb([
    {
      match: /agent_token_(current|previous|rotated_at|previous_ttl_days)/i,
      rows: [{ config_key: 'agent_token_current', config_value: AGENT_TOKEN }]
    }
  ]).standard();

  const origExecute = db.execute;
  db.execute = async (sql, params = []) => {
    if (/INSERT\s+INTO\s+audit_logs/i.test(sql)) {
      const payloadStr = params[3];
      let parsed = null;
      if (typeof payloadStr === 'string') {
        try { parsed = JSON.parse(payloadStr); } catch { parsed = payloadStr; }
      } else if (payloadStr && typeof payloadStr === 'object') {
        parsed = payloadStr;
      }
      auditRows.push({
        userId: params[0],
        action: params[1],
        target: params[2],
        payload: parsed
      });
      return { rows: [], affectedRows: 1 };
    }
    if (/UPDATE\s+ad_member_commands\s+SET\s+status\s+=\s*'running'/i.test(sql)) {
      const hostname = params[params.length - 1];
      const ids = params.slice(0, -1).map(Number);
      for (const r of store.rows) {
        if (ids.includes(r.id) && r.hostname === hostname && r.status === 'queued') {
          r.status = 'running';
          r.claimed_at = new Date().toISOString();
        }
      }
      return { rows: [], affectedRows: 1 };
    }
    if (/UPDATE\s+ad_member_commands\s+SET\s+status\s*=\s*\?/i.test(sql)) {
      const [status, resultJson, errorMessage, durationMs, id] = params;
      const row = store.rows.find(r => r.id === Number(id));
      if (row) {
        row.status = status;
        row.result_json = resultJson;
        row.error_message = errorMessage;
        row.duration_ms = durationMs;
        row.completed_at = new Date().toISOString();
      }
      return { rows: [], affectedRows: row ? 1 : 0 };
    }
    return origExecute(sql, params);
  };

  const origQuery = db.query;
  db.query = async (sql, params = []) => {
    if (/SELECT\s+id\s+FROM\s+ad_member_commands/i.test(sql)) {
      const hostname = params[0];
      const limit = Number(params[1]);
      const rows = store.rows
        .filter(r => r.status === 'queued' && r.hostname === hostname)
        .slice(0, limit)
        .map(r => ({ id: r.id }));
      return { rows };
    }
    if (/^SELECT\s+id, hostname, command_type, params_json, status/i.test(sql)) {
      const ids = params.map(Number);
      const rows = store.rows
        .filter(r => ids.includes(r.id))
        .map(r => ({
          id: r.id,
          hostname: r.hostname,
          command_type: r.command_type,
          params_json: r.params_json,
          status: r.status,
          created_at: r.created_at,
          claimed_at: r.claimed_at
        }));
      return { rows };
    }
    if (/FROM\s+ad_member_commands\s+c\s+LEFT\s+JOIN\s+sys_users/i.test(sql)) {
      const id = Number(params[0]);
      const row = store.rows.find(r => r.id === id);
      return { rows: row ? [row] : [] };
    }
    return origQuery(sql, params);
  };

  db.auditRows = auditRows;
  db.store = store;
  return db;
}

function buildApp(db) {
  const a = express();
  a.use(express.json());
  return a.use(agentRouter({
    config: { jwtSecret: 'test-secret' },
    logger: { info(){}, error(){}, warn(){}, debug(){} },
    mount: 'full',
    db
  }));
}

// ── GET /api/agent/member-commands ─────────────────────────────────────

test('agent GET /api/agent/member-commands: 400 without hostname', async () => {
  invalidateAgentTokenCache();
  const db = buildDb();
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .get('/api/agent/member-commands')
    .set('X-Agent-Token', AGENT_TOKEN);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /hostname required/);
});

test('agent GET /api/agent/member-commands: 401 without agent token', async () => {
  invalidateAgentTokenCache();
  const db = buildDb();
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .get('/api/agent/member-commands?hostname=H1');
  assert.equal(r.status, 401);
});

test('agent GET /api/agent/member-commands: returns queued commands for the hostname + flips to running', async () => {
  invalidateAgentTokenCache();
  const db = buildDb({
    seededCommands: [
      { id: 1, hostname: 'H1', params: { script: 'Get-Date' } },
      { id: 2, hostname: 'H1', params: { script: 'whoami' } },
      { id: 3, hostname: 'H2', params: { script: 'hostname' } }
    ]
  });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .get('/api/agent/member-commands?hostname=H1')
    .set('X-Agent-Token', AGENT_TOKEN);
  assert.equal(r.status, 200);
  assert.equal(r.body.commands.length, 2);
  for (const c of r.body.commands) {
    assert.equal(c.status, 'running');
    assert.equal(c.hostname, 'H1');
    assert.ok(c.claimedAt);
    // params is a parsed object (not a JSON string), so the JS dispatcher
    // can read c.params.script directly.
    assert.ok(typeof c.params.script === 'string');
  }
  // H2's command untouched.
  const h2Row = db.store.rows.find(r => r.id === 3);
  assert.equal(h2Row.status, 'queued');
});

test('agent GET /api/agent/member-commands: empty list when no queued commands', async () => {
  invalidateAgentTokenCache();
  const db = buildDb();
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .get('/api/agent/member-commands?hostname=H1')
    .set('X-Agent-Token', AGENT_TOKEN);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.commands, []);
});

test('agent GET /api/agent/member-commands: emits ad_member_command_claimed audit per claim', async () => {
  invalidateAgentTokenCache();
  const db = buildDb({
    seededCommands: [
      { id: 1, hostname: 'H1', params: { script: 'Get-Date' } }
    ]
  });
  _setDbForTest(db);
  await supertest(buildApp(db))
    .get('/api/agent/member-commands?hostname=H1')
    .set('X-Agent-Token', AGENT_TOKEN);
  const claimed = db.auditRows.find(x => x.action === 'ad_member_command_claimed');
  assert.ok(claimed, 'ad_member_command_claimed audit row must be present');
  assert.equal(claimed.target, 'host:H1');
  assert.equal(claimed.payload.commandId, 1);
  assert.equal(claimed.payload.commandType, 'member_script');
  assert.equal(claimed.payload.hostname, 'H1');
});

// ── POST /api/agent/member-commands/:id/result ──────────────────────────

test('agent POST /api/agent/member-commands/:id/result: success flips to success + emits audit', async () => {
  invalidateAgentTokenCache();
  const db = buildDb({
    seededCommands: [
      { id: 10, hostname: 'H1', status: 'running', params: { script: 'Get-Date' } }
    ]
  });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/agent/member-commands/10/result')
    .set('X-Agent-Token', AGENT_TOKEN)
    .send({
      success: true,
      data: { stdout: 'Sun Jan 1', stderr: '', exitCode: 0 },
      exitCode: 0,
      durationMs: 500
    });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'success');
  const audit = db.auditRows.find(x => x.action === 'ad_member_command_succeeded');
  assert.ok(audit);
  assert.equal(audit.payload.commandId, 10);
  assert.equal(audit.payload.exitCode, 0);
  assert.equal(audit.payload.durationMs, 500);
  assert.equal(audit.payload.hostname, 'H1');
});

test('agent POST /api/agent/member-commands/:id/result: failure flips to failed + emits audit', async () => {
  invalidateAgentTokenCache();
  const db = buildDb({
    seededCommands: [
      { id: 11, hostname: 'H1', status: 'running', params: { script: 'bad-cmd' } }
    ]
  });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/agent/member-commands/11/result')
    .set('X-Agent-Token', AGENT_TOKEN)
    .send({ success: false, error: 'CommandNotFoundException', exitCode: 1, durationMs: 100 });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'failed');
  const audit = db.auditRows.find(x => x.action === 'ad_member_command_failed');
  assert.ok(audit);
  assert.equal(audit.payload.errorMessage, 'CommandNotFoundException');
});

test('agent POST /api/agent/member-commands/:id/result: 404 when command does not exist', async () => {
  invalidateAgentTokenCache();
  const db = buildDb();
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/agent/member-commands/999/result')
    .set('X-Agent-Token', AGENT_TOKEN)
    .send({ success: true });
  assert.equal(r.status, 404);
});

test('agent POST /api/agent/member-commands/:id/result: 409 when command not running', async () => {
  invalidateAgentTokenCache();
  const db = buildDb({
    seededCommands: [
      { id: 12, hostname: 'H1', status: 'queued', params: { script: 'echo hi' } }
    ]
  });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/agent/member-commands/12/result')
    .set('X-Agent-Token', AGENT_TOKEN)
    .send({ success: true });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /running/);
});

test('agent POST /api/agent/member-commands/:id/result: 400 for invalid id', async () => {
  invalidateAgentTokenCache();
  const db = buildDb();
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/agent/member-commands/abc/result')
    .set('X-Agent-Token', AGENT_TOKEN)
    .send({ success: true });
  assert.equal(r.status, 400);
});