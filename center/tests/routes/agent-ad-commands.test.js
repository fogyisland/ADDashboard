// 2026-08-31 R75 — agent route tests for /api/agent/ad-commands/*.
//
// Two endpoints:
//   GET  /api/agent/ad-commands?hostname=X        (claim up to 5)
//   POST /api/agent/ad-commands/:id/result        (terminal ack)
//
// Auth-gated by agentToken (NOT userAuth). Tests sign with the standard
// AGENT_TOKEN so the agent-token middleware accepts X-Agent-Token.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import supertest from 'supertest';

import { _setDbForTest } from '../../src/db/index.js';
import { buildMockDb } from '../helpers/db-mock.js';
import { agentRouter } from '../../src/routes/agent.js';
import { invalidateAgentTokenCache } from '../../src/auth/agent-token.js';

// ── Test plumbing ────────────────────────────────────────────────────────

const AGENT_TOKEN = 'test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function buildDb({ seededCommands = [] } = {}) {
  const auditRows = [];
  const store = {
    // in-memory mirror of ad_admin_commands. Each row mirrors the SQL
    // helper column shape so the route can read back what it wrote.
    rows: seededCommands.map((r, i) => ({
      id: r.id ?? (100 + i),
      command_type: r.commandType ?? r.command_type,
      target_dc: r.targetDc ?? r.target_dc,
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
    if (/UPDATE\s+ad_admin_commands\s+SET\s+status\s+=\s+'running'/i.test(sql)) {
      // claim UPDATE: ids + targetDc.
      const targetDc = params[params.length - 1];
      const ids = params.slice(0, -1).map(Number);
      for (const r of store.rows) {
        if (ids.includes(r.id) && r.target_dc === targetDc && r.status === 'queued') {
          r.status = 'running';
          r.claimed_at = new Date().toISOString();
        }
      }
      return { rows: [], affectedRows: 1 };
    }
    if (/UPDATE\s+ad_admin_commands\s+SET\s+status\s+=\s+\?/i.test(sql)) {
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
    if (/SELECT\s+id\s+FROM\s+ad_admin_commands/i.test(sql)) {
      // claimPick: params = [targetDc, limit]
      const targetDc = params[0];
      const limit = Number(params[1]);
      const rows = store.rows
        .filter(r => r.status === 'queued' && r.target_dc === targetDc)
        .slice(0, limit)
        .map(r => ({ id: r.id }));
      return { rows };
    }
    if (/^SELECT\s+id, command_type, target_dc, params_json, status/i.test(sql)) {
      // loadByIds
      const ids = params.map(Number);
      const rows = store.rows
        .filter(r => ids.includes(r.id))
        .map(r => ({
          id: r.id,
          command_type: r.command_type,
          target_dc: r.target_dc,
          params_json: r.params_json,
          status: r.status,
          created_at: r.created_at,
          claimed_at: r.claimed_at
        }));
      return { rows };
    }
    if (/FROM\s+ad_admin_commands\s+c\s+LEFT\s+JOIN\s+sys_users/i.test(sql)) {
      // getById
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

// ── GET /api/agent/ad-commands ───────────────────────────────────────────

test('agent GET /api/agent/ad-commands: 400 without hostname', async () => {
  invalidateAgentTokenCache();
  const db = buildDb();
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .get('/api/agent/ad-commands')
    .set('X-Agent-Token', AGENT_TOKEN);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /hostname required/);
});

test('agent GET /api/agent/ad-commands: 401 without agent token', async () => {
  invalidateAgentTokenCache();
  const db = buildDb();
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .get('/api/agent/ad-commands?hostname=DC1');
  assert.equal(r.status, 401);
});

test('agent GET /api/agent/ad-commands: returns queued commands for the dc + flips to running', async () => {
  invalidateAgentTokenCache();
  const db = buildDb({
    seededCommands: [
      { id: 1, commandType: 'user_search', targetDc: 'DC1', params: { filter: 'a' } },
      { id: 2, commandType: 'user_search', targetDc: 'DC1', params: { filter: 'b' } },
      { id: 3, commandType: 'user_search', targetDc: 'DC2', params: { filter: 'c' } }
    ]
  });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .get('/api/agent/ad-commands?hostname=DC1')
    .set('X-Agent-Token', AGENT_TOKEN);
  assert.equal(r.status, 200);
  assert.equal(r.body.commands.length, 2);
  for (const c of r.body.commands) {
    assert.equal(c.status, 'running');
    assert.equal(c.targetDc, 'DC1');
    assert.ok(c.claimedAt);
  }
  // DC2's command was untouched.
  const dc2Row = db.store.rows.find(r => r.id === 3);
  assert.equal(dc2Row.status, 'queued');
});

test('agent GET /api/agent/ad-commands: empty list when no queued commands', async () => {
  invalidateAgentTokenCache();
  const db = buildDb();
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .get('/api/agent/ad-commands?hostname=DC1')
    .set('X-Agent-Token', AGENT_TOKEN);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.commands, []);
});

test('agent GET /api/agent/ad-commands: emits ad_command_claimed audit row per claim', async () => {
  invalidateAgentTokenCache();
  const db = buildDb({
    seededCommands: [
      { id: 1, commandType: 'user_search', targetDc: 'DC1', params: { filter: 'a' } }
    ]
  });
  _setDbForTest(db);
  await supertest(buildApp(db))
    .get('/api/agent/ad-commands?hostname=DC1')
    .set('X-Agent-Token', AGENT_TOKEN);
  const claimed = db.auditRows.find(x => x.action === 'ad_command_claimed');
  assert.ok(claimed, 'ad_command_claimed audit row must be present');
  assert.equal(claimed.target, 'dc:DC1');
  assert.equal(claimed.payload.commandId, 1);
  assert.equal(claimed.payload.commandType, 'user_search');
});

// ── POST /api/agent/ad-commands/:id/result ───────────────────────────────

test('agent POST /api/agent/ad-commands/:id/result: success=true flips to success + emits audit', async () => {
  invalidateAgentTokenCache();
  const db = buildDb({
    seededCommands: [
      { id: 10, commandType: 'user_search', targetDc: 'DC1', status: 'running', params: { filter: 'a' } }
    ]
  });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/agent/ad-commands/10/result')
    .set('X-Agent-Token', AGENT_TOKEN)
    .send({ success: true, data: { users: [] }, error: null, exitCode: 0, durationMs: 100 });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'success');
  const succeeded = db.auditRows.find(x => x.action === 'ad_command_succeeded');
  assert.ok(succeeded);
  assert.equal(succeeded.target, 'cmd:10');
});

test('agent POST /api/agent/ad-commands/:id/result: success=false flips to failed + emits audit', async () => {
  invalidateAgentTokenCache();
  const db = buildDb({
    seededCommands: [
      { id: 11, commandType: 'user_search', targetDc: 'DC1', status: 'running', params: {} }
    ]
  });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/agent/ad-commands/11/result')
    .set('X-Agent-Token', AGENT_TOKEN)
    .send({ success: false, data: null, error: 'PS1 crashed', exitCode: 1, durationMs: 50 });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'failed');
  const failed = db.auditRows.find(x => x.action === 'ad_command_failed');
  assert.ok(failed);
  assert.equal(failed.payload.errorMessage, 'PS1 crashed');
});

test('agent POST /api/agent/ad-commands/:id/result: 404 when command not found', async () => {
  invalidateAgentTokenCache();
  const db = buildDb();
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/agent/ad-commands/999/result')
    .set('X-Agent-Token', AGENT_TOKEN)
    .send({ success: true, data: null });
  assert.equal(r.status, 404);
});

test('agent POST /api/agent/ad-commands/:id/result: 409 when command not in running state', async () => {
  invalidateAgentTokenCache();
  const db = buildDb({
    seededCommands: [
      { id: 12, commandType: 'user_search', targetDc: 'DC1', status: 'queued', params: {} }
    ]
  });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/agent/ad-commands/12/result')
    .set('X-Agent-Token', AGENT_TOKEN)
    .send({ success: true, data: null });
  assert.equal(r.status, 409);
});

test('agent POST /api/agent/ad-commands/:id/result: 401 without agent token', async () => {
  invalidateAgentTokenCache();
  const db = buildDb({
    seededCommands: [
      { id: 13, commandType: 'user_search', targetDc: 'DC1', status: 'running', params: {} }
    ]
  });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/agent/ad-commands/13/result')
    .send({ success: true, data: null });
  assert.equal(r.status, 401);
});