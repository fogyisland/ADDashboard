// 2026-08-31 R75 — AD admin commands service tests.
//
// Covers the full service surface (queueCommand / claimForAgent /
// completeCommand / sweepTimeouts / getCommand / listCommands) plus
// the per-type params validators + password-redaction helper.
//
// The service uses getDb() at call time (not at module load), so we
// install a mock db via _setDbForTest() before each scenario and
// restore the previous one in a finally block. Each scenario wires
// its own SQL-to-rows map via buildMockDb scripts + the `onQuery` hook
// for assertions like "INSERT was called with these params".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _setDbForTest, getDb } from '../../src/db/index.js';
import { buildSql } from '../../src/db/sql.js';
import { buildMockDb } from '../helpers/db-mock.js';
import {
  queueCommand, claimForAgent, completeCommand, sweepTimeouts,
  getCommand, listCommands, _testInternals
} from '../../src/services/ad-admin-commands.js';

// ── Test plumbing ────────────────────────────────────────────────────────

// A tiny in-memory store representing the ad_admin_commands table. Each
// row carries the same shape as the SQL helper returns, so the service
// can read back what it wrote without surprises. Used by `buildDbFor`
// to wire execute/query mocks that match on the SQL string.
function makeStore() {
  let nextId = 1;
  return {
    rows: [], // ordered by id ascending
    nextId: () => nextId++,
    insert({ commandType, targetDc, params, operatorId = null }) {
      const id = nextId++;
      const row = {
        id,
        command_type: commandType,
        target_dc: targetDc,
        params_json: typeof params === 'string' ? params : JSON.stringify(params),
        status: 'queued',
        operator_id: operatorId,
        operator_username: null,
        result_json: null,
        error_message: null,
        duration_ms: null,
        created_at: new Date().toISOString(),
        claimed_at: null,
        completed_at: null
      };
      this.rows.push(row);
      return row;
    },
    byId(id) {
      return this.rows.find(r => r.id === Number(id));
    }
  };
}

function buildDbFor(store) {
  const sql = buildSql('mysql');
  return {
    dialect: 'mysql',
    sql,
    // execute: handle INSERT / UPDATE for our SQL helpers. Other SQLs
    // (e.g. probes, lookups) are no-ops here — we never invoke them
    // from the service tests in this file.
    async execute(sqlStr, params = []) {
      if (/INSERT\s+INTO\s+ad_admin_commands/i.test(sqlStr)) {
        const row = store.insert({
          commandType: params[0],
          targetDc: params[1],
          params: params[2],
          operatorId: params[3]
        });
        return { rows: [], affectedRows: 1, insertId: row.id };
      }
      if (/UPDATE\s+ad_admin_commands\s+SET\s+status\s+=\s+'running'/i.test(sqlStr)) {
        // claim UPDATE: params = [...ids, targetDc]. Flip each id that
        // matches targetDc and is still 'queued'.
        const targetDc = params[params.length - 1];
        const ids = params.slice(0, -1).map(Number);
        let affected = 0;
        for (const r of store.rows) {
          if (ids.includes(r.id) && r.target_dc === targetDc && r.status === 'queued') {
            r.status = 'running';
            r.claimed_at = new Date().toISOString();
            affected++;
          }
        }
        return { rows: [], affectedRows: affected };
      }
      if (/UPDATE\s+ad_admin_commands\s+SET\s+status\s+=\s+\?/i.test(sqlStr)) {
        // complete UPDATE: params = [status, resultJson, errorMessage, durationMs, id]
        const [status, resultJson, errorMessage, durationMs, id] = params;
        const row = store.byId(id);
        if (row) {
          row.status = status;
          row.result_json = resultJson;
          row.error_message = errorMessage;
          row.duration_ms = durationMs;
          row.completed_at = new Date().toISOString();
        }
        return { rows: [], affectedRows: row ? 1 : 0 };
      }
      if (/UPDATE\s+ad_admin_commands\s+SET\s+status\s+=\s+'timeout'/i.test(sqlStr)) {
        // sweepTimeouts UPDATE: params = [timeoutSeconds]
        let affected = 0;
        const thresholdMs = Number(params[0]) * 1000;
        const now = Date.now();
        for (const r of store.rows) {
          if (r.status !== 'running' || !r.claimed_at) continue;
          const ageMs = now - new Date(r.claimed_at).getTime();
          if (ageMs > thresholdMs) {
            r.status = 'timeout';
            r.error_message = 'command exceeded timeout threshold';
            r.completed_at = new Date().toISOString();
            affected++;
          }
        }
        return { rows: [], affectedRows: affected };
      }
      // Other UPDATEs are no-ops in this test scaffold.
      return { rows: [], affectedRows: 0 };
    },
    async query(sqlStr, params = []) {
      // claimPick: SELECT id FROM ... WHERE status='queued' AND target_dc=? ORDER BY ... LIMIT ?
      if (/SELECT\s+id\s+FROM\s+ad_admin_commands/i.test(sqlStr)) {
        const targetDc = params[0];
        const limit = Number(params[1]);
        const rows = store.rows
          .filter(r => r.status === 'queued' && r.target_dc === targetDc)
          .slice(0, limit)
          .map(r => ({ id: r.id }));
        return { rows };
      }
      if (/^SELECT\s+id, command_type, target_dc, params_json, status,\s+created_at, claimed_at\s+FROM\s+ad_admin_commands/i.test(sqlStr)) {
        // loadByIds: params = [id1, id2, ...]
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
      if (/FROM\s+ad_admin_commands\s+c\s+LEFT\s+JOIN\s+sys_users/i.test(sqlStr)) {
        // getById or listBy*. The SELECT shape varies but they all start
        // with the same JOIN; we dispatch by the WHERE clause.
        const idMatch = sqlStr.match(/WHERE\s+c\.id\s*=\s*\?/i);
        const opMatch = sqlStr.match(/WHERE\s+c\.operator_id\s*=\s*\?/i);
        const statusMatch = sqlStr.match(/WHERE\s+c\.status\s*=\s*\?/i);
        const allRows = store.rows;
        let filtered;
        if (idMatch) {
          const id = Number(params[0]); // single id
          filtered = allRows.filter(r => r.id === id);
        } else if (opMatch) {
          // mysql: WHERE-bound param is at params[0] for mysql, but mssql
          // has TOP (?) first so operator_id bound param is at params[1].
          // For test purposes we just look for a numeric id anywhere in
          // the params.
          const opId = params.find(p => Number.isFinite(Number(p)) && Number(p) > 0);
          filtered = allRows.filter(r => r.operator_id === Number(opId));
        } else if (statusMatch) {
          // status string is at params[0] for mysql, params[1] for mssql.
          const statusParam = params.find(p => typeof p === 'string');
          filtered = allRows.filter(r => r.status === statusParam);
        } else {
          filtered = allRows;
        }
        // listAll / listBy* apply LIMIT + OFFSET (mysql style). For
        // mysql the params are [size, offset] for listAll, or
        // [status/operatorId, size, offset] for filtered lists; the
        // mock just slices to safeSize + offset which works for both
        // dialects because the last 2 numeric params are always size +
        // offset (we ignore the WHERE-bound value here since filtering
        // is already done above).
        if (/LIMIT\s+\?\s+OFFSET\s+\?/i.test(sqlStr)) {
          const size = Number(params[params.length - 2]);
          const offset = Number(params[params.length - 1]);
          if (Number.isFinite(size) && Number.isFinite(offset)) {
            filtered = filtered.slice(offset, offset + size);
          }
        } else if (/SELECT\s+TOP\s+\(\?\)/i.test(sqlStr)) {
          // MSSQL style: TOP is FIRST bound param, OFFSET is last.
          const size = Number(params[0]);
          const offset = Number(params[params.length - 1]);
          if (Number.isFinite(size) && Number.isFinite(offset)) {
            filtered = filtered.slice(offset, offset + size);
          }
        }
        const shape = (r) => ({
          id: r.id,
          command_type: r.command_type,
          target_dc: r.target_dc,
          params_json: r.params_json,
          result_json: r.result_json,
          status: r.status,
          operator_id: r.operator_id,
          operator_username: r.operator_username,
          created_at: r.created_at,
          claimed_at: r.claimed_at,
          completed_at: r.completed_at,
          duration_ms: r.duration_ms,
          error_message: r.error_message
        });
        return { rows: filtered.map(shape) };
      }
      if (/SELECT\s+COUNT\(\*\)/i.test(sqlStr)) {
        let total;
        if (/WHERE\s+operator_id\s*=\s*\?/i.test(sqlStr)) total = store.rows.filter(r => r.operator_id === Number(params[0])).length;
        else if (/WHERE\s+status\s*=\s*\?/i.test(sqlStr)) total = store.rows.filter(r => r.status === params[0]).length;
        else total = store.rows.length;
        return { rows: [{ total }] };
      }
      return { rows: [] };
    },
    async transaction(work) { return work({ execute: this.execute, query: this.query, sql }); },
    async healthcheck() {},
    async close() {}
  };
}

// Save/restore the global db binding between tests so a failure in one
// test doesn't poison the next.
function withDb(db, fn) {
  let prev = null;
  try { prev = getDb(); } catch { /* never initialized — that's fine */ }
  _setDbForTest(db);
  return Promise.resolve().then(fn).finally(() => {
    if (prev) _setDbForTest(prev);
    else _setDbForTest(null);
  });
}

// ── queueCommand ─────────────────────────────────────────────────────────

test('queueCommand: happy path inserts a row + returns queued status', async () => {
  await withDb(buildDbFor(makeStore()), async () => {
    const row = await queueCommand({
      targetDc: 'HUBADSRV1',
      commandType: 'user_search',
      params: { filter: 'admin' },
      operatorId: 7
    });
    assert.equal(row.status, 'queued');
    assert.equal(row.command_type, 'user_search');
    assert.equal(row.target_dc, 'HUBADSRV1');
    assert.equal(row.operator_id, 7);
    assert.ok(row.id > 0, 'id must be returned from insertId');
  });
});

test('queueCommand: 400 when targetDc missing', async () => {
  await withDb(buildDbFor(makeStore()), async () => {
    await assert.rejects(
      () => queueCommand({ targetDc: '', commandType: 'user_search', params: {} }),
      (e) => e.httpStatus === 400 && /targetDc/.test(e.message)
    );
  });
});

test('queueCommand: 400 on unknown command_type', async () => {
  await withDb(buildDbFor(makeStore()), async () => {
    await assert.rejects(
      () => queueCommand({ targetDc: 'X', commandType: 'not_a_command', params: {} }),
      (e) => e.httpStatus === 400 && /unknown command_type/.test(e.message)
    );
  });
});

test('queueCommand: 400 on invalid params (user_create missing password)', async () => {
  await withDb(buildDbFor(makeStore()), async () => {
    await assert.rejects(
      () => queueCommand({ targetDc: 'X', commandType: 'user_create', params: { sam: 'jdoe' } }),
      (e) => e.httpStatus === 400 && /password/.test(e.message)
    );
  });
});

test('queueCommand: 400 on invalid params (user_password_reset missing newPassword)', async () => {
  await withDb(buildDbFor(makeStore()), async () => {
    await assert.rejects(
      () => queueCommand({ targetDc: 'X', commandType: 'user_password_reset', params: { sam: 'jdoe' } }),
      (e) => e.httpStatus === 400 && /newPassword/.test(e.message)
    );
  });
});

// ── claimForAgent ────────────────────────────────────────────────────────

test('claimForAgent: returns up to limit queued commands for the dc', async () => {
  const store = makeStore();
  store.insert({ commandType: 'user_search', targetDc: 'DC1', params: { filter: 'a' } });
  store.insert({ commandType: 'user_search', targetDc: 'DC1', params: { filter: 'b' } });
  store.insert({ commandType: 'user_search', targetDc: 'DC2', params: { filter: 'c' } });
  await withDb(buildDbFor(store), async () => {
    const claimed = await claimForAgent('DC1', 5);
    assert.equal(claimed.length, 2);
    for (const c of claimed) {
      assert.equal(c.status, 'running');
      assert.equal(c.target_dc, 'DC1');
      assert.ok(c.claimed_at);
    }
  });
});

test('claimForAgent: respects limit cap', async () => {
  const store = makeStore();
  for (let i = 0; i < 8; i++) {
    store.insert({ commandType: 'user_search', targetDc: 'DC1', params: { filter: `u${i}` } });
  }
  await withDb(buildDbFor(store), async () => {
    const claimed = await claimForAgent('DC1', 3);
    assert.equal(claimed.length, 3);
  });
});

test('claimForAgent: empty list when no queued commands', async () => {
  await withDb(buildDbFor(makeStore()), async () => {
    const claimed = await claimForAgent('DC1', 5);
    assert.deepEqual(claimed, []);
  });
});

test('claimForAgent: returns commands oldest-first', async () => {
  const store = makeStore();
  const a = store.insert({ commandType: 'user_search', targetDc: 'DC1', params: { filter: 'first' } });
  // Insert two more; store assigns ids in order. The list should come back
  // ordered by created_at ASC. Sleep 5ms to make ordering observable.
  await new Promise(r => setTimeout(r, 5));
  const b = store.insert({ commandType: 'user_search', targetDc: 'DC1', params: { filter: 'second' } });
  await new Promise(r => setTimeout(r, 5));
  const c = store.insert({ commandType: 'user_search', targetDc: 'DC1', params: { filter: 'third' } });
  await withDb(buildDbFor(store), async () => {
    const claimed = await claimForAgent('DC1', 5);
    assert.deepEqual(claimed.map(r => r.id), [a.id, b.id, c.id]);
  });
});

// ── completeCommand ──────────────────────────────────────────────────────

test('completeCommand: success=true flips status to success + persists result', async () => {
  const store = makeStore();
  const row = store.insert({ commandType: 'user_search', targetDc: 'DC1', params: { filter: 'a' } });
  // Manually flip to running so completeCommand sees the right pre-state.
  row.status = 'running';
  row.claimed_at = new Date().toISOString();
  await withDb(buildDbFor(store), async () => {
    const updated = await completeCommand(row.id, {
      success: true,
      data: { users: [{ sam: 'admin' }], count: 1 },
      error: null,
      exitCode: 0,
      durationMs: 1234
    });
    assert.equal(updated.status, 'success');
    assert.deepEqual(updated.result_json, { users: [{ sam: 'admin' }], count: 1 });
    assert.equal(updated.duration_ms, 1234);
    assert.ok(updated.completed_at);
  });
});

test('completeCommand: success=false flips status to failed + persists error', async () => {
  const store = makeStore();
  const row = store.insert({ commandType: 'user_search', targetDc: 'DC1', params: { filter: 'a' } });
  row.status = 'running';
  row.claimed_at = new Date().toISOString();
  await withDb(buildDbFor(store), async () => {
    const updated = await completeCommand(row.id, {
      success: false,
      data: null,
      error: 'AD module not available',
      exitCode: 1,
      durationMs: 42
    });
    assert.equal(updated.status, 'failed');
    assert.equal(updated.error_message, 'AD module not available');
  });
});

test('completeCommand: idempotent on already-terminal row (returns existing)', async () => {
  const store = makeStore();
  const row = store.insert({ commandType: 'user_search', targetDc: 'DC1', params: { filter: 'a' } });
  row.status = 'success';
  row.result_json = JSON.stringify({ users: [] });
  await withDb(buildDbFor(store), async () => {
    const updated = await completeCommand(row.id, { success: false, error: 'should not apply' });
    assert.equal(updated.status, 'success');
  });
});

test('completeCommand: 404 when command does not exist', async () => {
  await withDb(buildDbFor(makeStore()), async () => {
    await assert.rejects(
      () => completeCommand(999, { success: true, data: null }),
      (e) => e.httpStatus === 404
    );
  });
});

test('completeCommand: 409 when command not in running state', async () => {
  const store = makeStore();
  const row = store.insert({ commandType: 'user_search', targetDc: 'DC1', params: { filter: 'a' } });
  // still 'queued' — agent shouldn't be ack'ing
  await withDb(buildDbFor(store), async () => {
    await assert.rejects(
      () => completeCommand(row.id, { success: true, data: null }),
      (e) => e.httpStatus === 409 && /running/.test(e.message)
    );
  });
});

test('completeCommand: strips password fields from result_json', async () => {
  const store = makeStore();
  const row = store.insert({ commandType: 'user_create', targetDc: 'DC1', params: { sam: 'jdoe', password: 'P@ssw0rd!' } });
  row.status = 'running';
  row.claimed_at = new Date().toISOString();
  await withDb(buildDbFor(store), async () => {
    // Agent accidentally included the password in its data blob. The
    // service MUST strip it before persisting (spec §3.4 ruling #8).
    await completeCommand(row.id, {
      success: true,
      data: { sam: 'jdoe', password: 'P@ssw0rd!', created: true },
      exitCode: 0,
      durationMs: 1
    });
    const refetched = store.byId(row.id);
    assert.equal(refetched.result_json.includes('P@ssw0rd!'), false,
      'cleartext password must NOT be in result_json');
  });
});

// ── sweepTimeouts ────────────────────────────────────────────────────────

test('sweepTimeouts: marks running rows older than threshold as timeout', async () => {
  const store = makeStore();
  const row = store.insert({ commandType: 'user_search', targetDc: 'DC1', params: { filter: 'a' } });
  row.status = 'running';
  row.claimed_at = new Date(Date.now() - 60_000).toISOString(); // 60s ago
  await withDb(buildDbFor(store), async () => {
    await sweepTimeouts({ timeoutMs: 30_000 });
    const refetched = store.byId(row.id);
    assert.equal(refetched.status, 'timeout');
    assert.equal(refetched.error_message, 'command exceeded timeout threshold');
    assert.ok(refetched.completed_at);
  });
});

test('sweepTimeouts: passes through rows younger than threshold', async () => {
  const store = makeStore();
  const row = store.insert({ commandType: 'user_search', targetDc: 'DC1', params: { filter: 'a' } });
  row.status = 'running';
  row.claimed_at = new Date(Date.now() - 5_000).toISOString(); // 5s ago
  await withDb(buildDbFor(store), async () => {
    await sweepTimeouts({ timeoutMs: 30_000 });
    const refetched = store.byId(row.id);
    assert.equal(refetched.status, 'running');
  });
});

test('sweepTimeouts: passes through already-terminal rows', async () => {
  const store = makeStore();
  const row = store.insert({ commandType: 'user_search', targetDc: 'DC1', params: { filter: 'a' } });
  row.status = 'success';
  row.completed_at = new Date(Date.now() - 120_000).toISOString();
  await withDb(buildDbFor(store), async () => {
    await sweepTimeouts({ timeoutMs: 30_000 });
    const refetched = store.byId(row.id);
    assert.equal(refetched.status, 'success', 'terminal rows must not be touched');
  });
});

// ── getCommand / listCommands ─────────────────────────────────────────────

test('getCommand: returns parsed params_json + result_json', async () => {
  const store = makeStore();
  const row = store.insert({ commandType: 'user_search', targetDc: 'DC1', params: { filter: 'admin' } });
  row.status = 'success';
  row.result_json = JSON.stringify({ users: [], count: 0 });
  await withDb(buildDbFor(store), async () => {
    const fetched = await getCommand(row.id);
    assert.ok(fetched);
    assert.deepEqual(fetched.params_json, { filter: 'admin' });
    assert.deepEqual(fetched.result_json, { users: [], count: 0 });
  });
});

test('getCommand: returns null for unknown id', async () => {
  await withDb(buildDbFor(makeStore()), async () => {
    const fetched = await getCommand(999);
    assert.equal(fetched, null);
  });
});

test('listCommands: paginates + returns total', async () => {
  const store = makeStore();
  for (let i = 0; i < 5; i++) {
    store.insert({ commandType: 'user_search', targetDc: 'DC1', params: { filter: `u${i}` } });
  }
  await withDb(buildDbFor(store), async () => {
    const out = await listCommands({ page: 1, size: 2 });
    assert.equal(out.total, 5);
    assert.equal(out.size, 2);
    assert.equal(out.rows.length, 2);
  });
});

test('listCommands: filters by operatorId', async () => {
  const store = makeStore();
  store.insert({ commandType: 'user_search', targetDc: 'DC1', params: {}, operatorId: 1 });
  store.insert({ commandType: 'user_search', targetDc: 'DC1', params: {}, operatorId: 1 });
  store.insert({ commandType: 'user_search', targetDc: 'DC1', params: {}, operatorId: 2 });
  await withDb(buildDbFor(store), async () => {
    const out = await listCommands({ operatorId: 1 });
    assert.equal(out.total, 2);
  });
});

test('listCommands: filters by status', async () => {
  const store = makeStore();
  const a = store.insert({ commandType: 'user_search', targetDc: 'DC1', params: {} });
  a.status = 'success';
  const b = store.insert({ commandType: 'user_search', targetDc: 'DC1', params: {} });
  b.status = 'queued';
  await withDb(buildDbFor(store), async () => {
    const out = await listCommands({ status: 'success' });
    assert.equal(out.total, 1);
    assert.equal(out.rows[0].status, 'success');
  });
});

// ── _testInternals (redaction + validators) ───────────────────────────────

test('redactPasswords: strips password-shaped keys from result data', () => {
  const r = _testInternals.redactPasswords;
  assert.deepEqual(
    r({ sam: 'jdoe', password: 'P', newPassword: 'Q', oldPassword: 'O' }),
    { sam: 'jdoe' }
  );
  // Recurses into nested objects + arrays
  assert.deepEqual(
    r({ users: [{ sam: 'a', password: 'X' }] }),
    { users: [{ sam: 'a' }] }
  );
  // Pass-through for non-objects
  assert.equal(r(null), null);
  assert.equal(r('plain'), 'plain');
  assert.equal(r(42), 42);
});

test('COMMAND_TYPES: 17 entries covering spec §2.2', () => {
  assert.equal(_testInternals.COMMAND_TYPES.size, 17);
  assert.ok(_testInternals.COMMAND_TYPES.has('user_search'));
  assert.ok(_testInternals.COMMAND_TYPES.has('group_delete'));
});