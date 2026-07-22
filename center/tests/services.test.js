// Unit tests for center/src/services/ports.js and
// center/src/services/port-status.js — the modules touched by the
// Task 2 review fix commit.
//
// Pins the regression behavior for:
//   - ports.deletePort / ports.updatePort return affectedRows>0 when
//     the underlying driver returns a real count (was always 404 before
//     the mssql affectedRows fix because affectedRows was 0 for non-INSERT).
//   - ports.createPort translates MSSQL UNIQUE violations (error.number
//     2627 / 2601) into a 409 with the same shape as MySQL DUP_ENTRY.
//   - port-status.upsertPortStatuses runs every per-row execute through
//     the transaction's `tx` handle (was using the pool facade before
//     the tx-scope fix, which committed an empty transaction and ran the
//     loop without atomicity).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _setDbForTest } from '../src/db/index.js';
import {
  isValidPort,
  listPorts,
  createPort,
  updatePort,
  deletePort,
  getPortStatusesForAgent
} from '../src/services/ports.js';
import {
  upsertPortStatuses,
  listPortStatusesForAgents
} from '../src/services/port-status.js';
import { buildSql } from '../src/db/sql.js';

// Minimal mock that records every execute / query / transaction call and
// lets each test shape per-SQL-script responses.
function makeMockDb({ dialect = 'mysql' } = {}) {
  const calls = [];
  let txCalls = 0;
  const scripts = []; // [{ match, result }]
  function lookup(sql) {
    for (const s of scripts) {
      if (s.match.test(sql)) {
        // Allow `result` to be either a static value or a function
        // (thunk) for throw-on-call semantics. The thunk is called on
        // every matching call so error state can be fresh each time.
        if (typeof s.result === 'function') return s.result();
        return s.result;
      }
    }
    return { rows: [], affectedRows: 0, insertId: undefined };
  }
  return {
    dialect,
    sql: buildSql(dialect),
    async execute(sql, params = []) {
      calls.push({ ctx: 'pool', sql, params: [...params] });
      return lookup(sql);
    },
    async query(sql, params = []) {
      calls.push({ ctx: 'pool', sql, params: [...params] });
      return { rows: lookup(sql).rows };
    },
    async transaction(work) {
      txCalls++;
      const txWrapper = {
        async execute(sql, params = []) {
          calls.push({ ctx: 'tx', sql, params: [...params] });
          return lookup(sql);
        },
        async query(sql, params = []) {
          calls.push({ ctx: 'tx', sql, params: [...params] });
          return { rows: lookup(sql).rows };
        }
      };
      return await work(txWrapper);
    },
    _calls: calls,
    _txCalls: () => txCalls,
    _addScript(match, result) { scripts.push({ match, result }); }
  };
}

// ----- isValidPort -----

test('isValidPort: accepts integers in [1, 65535]', () => {
  assert.equal(isValidPort(1), true);
  assert.equal(isValidPort(80), true);
  assert.equal(isValidPort(65535), true);
});

test('isValidPort: rejects 0, 65536, negatives, floats, strings, NaN', () => {
  assert.equal(isValidPort(0), false);
  assert.equal(isValidPort(65536), false);
  assert.equal(isValidPort(-1), false);
  assert.equal(isValidPort(80.5), false);
  assert.equal(isValidPort('80'), false);
  assert.equal(isValidPort(NaN), false);
  assert.equal(isValidPort(Infinity), false);
  assert.equal(isValidPort(null), false);
  assert.equal(isValidPort(undefined), false);
});

// ----- listPorts -----

test('listPorts: returns rows from db.sql.ports.list', async () => {
  const db = makeMockDb();
  db._addScript(/FROM\s+system_ports/i, { rows: [{ id: 1, port: 135, label: 'RPC', sortOrder: 0 }], affectedRows: 0 });
  _setDbForTest(db);
  const rows = await listPorts();
  assert.deepEqual(rows, [{ id: 1, port: 135, label: 'RPC', sortOrder: 0 }]);
});

// ----- createPort -----

test('createPort: 400 on invalid port', async () => {
  const db = makeMockDb();
  _setDbForTest(db);
  await assert.rejects(
    () => createPort({ port: 0, label: 'x' }),
    (e) => e.httpStatus === 400 && /invalid port/.test(e.message)
  );
});

test('createPort: 400 on empty label', async () => {
  const db = makeMockDb();
  _setDbForTest(db);
  await assert.rejects(
    () => createPort({ port: 135, label: '  ' }),
    (e) => e.httpStatus === 400 && /label required/.test(e.message)
  );
});

test('createPort: 409 on MySQL DUP_ENTRY (DUP_ENTRY code)', async () => {
  const db = makeMockDb();
  db._addScript(/INSERT\s+INTO\s+system_ports/i, () => { throw Object.assign(new Error('Duplicate entry'), { code: 'DUP_ENTRY' }); });
  _setDbForTest(db);
  await assert.rejects(
    () => createPort({ port: 135, label: 'RPC' }),
    (e) => e.httpStatus === 409 && /port already exists/.test(e.message)
  );
});

test('createPort: 409 on MSSQL UNIQUE violation (error.number 2627)', async () => {
  const db = makeMockDb();
  db._addScript(/INSERT\s+INTO\s+system_ports/i, () => {
    const err = new Error('Violation of UNIQUE KEY constraint \'uk_system_ports_port\'');
    err.number = 2627;
    throw err;
  });
  _setDbForTest(db);
  await assert.rejects(
    () => createPort({ port: 135, label: 'RPC' }),
    (e) => e.httpStatus === 409 && /port already exists/.test(e.message)
  );
});

test('createPort: 409 on MSSQL UNIQUE violation (error.number 2601)', async () => {
  const db = makeMockDb();
  db._addScript(/INSERT\s+INTO\s+system_ports/i, () => {
    const err = new Error('Cannot insert duplicate key row in object \'dbo.system_ports\'');
    err.number = 2601;
    throw err;
  });
  _setDbForTest(db);
  await assert.rejects(
    () => createPort({ port: 135, label: 'RPC' }),
    (e) => e.httpStatus === 409 && /port already exists/.test(e.message)
  );
});

test('createPort: returns insertId on success', async () => {
  const db = makeMockDb();
  db._addScript(/INSERT\s+INTO\s+system_ports/i, { rows: [], affectedRows: 1, insertId: 42 });
  _setDbForTest(db);
  const out = await createPort({ port: 135, label: 'RPC' });
  assert.deepEqual(out, { id: 42 });
});

test('createPort: 500 surface for unrelated driver errors', async () => {
  const db = makeMockDb();
  db._addScript(/INSERT\s+INTO\s+system_ports/i, () => { throw new Error('connection lost'); });
  _setDbForTest(db);
  await assert.rejects(
    () => createPort({ port: 135, label: 'RPC' }),
    (e) => e.message === 'connection lost' && e.httpStatus === undefined
  );
});

// ----- updatePort -----

test('updatePort: returns true when driver reports affectedRows=1 (regression: was always false on MSSQL)', async () => {
  const db = makeMockDb();
  db._addScript(/UPDATE\s+system_ports/i, { rows: [], affectedRows: 1, insertId: undefined });
  _setDbForTest(db);
  const ok = await updatePort(3, { label: 'New' });
  assert.equal(ok, true);
});

test('updatePort: returns false when driver reports affectedRows=0 (preserves 404 detection)', async () => {
  const db = makeMockDb();
  db._addScript(/UPDATE\s+system_ports/i, { rows: [], affectedRows: 0, insertId: undefined });
  _setDbForTest(db);
  const ok = await updatePort(999, { label: 'New' });
  assert.equal(ok, false);
});

test('updatePort: 400 on empty body', async () => {
  const db = makeMockDb();
  _setDbForTest(db);
  await assert.rejects(
    () => updatePort(3, {}),
    (e) => e.httpStatus === 400 && /no fields to update/.test(e.message)
  );
});

test('updatePort: 400 on invalid port in body', async () => {
  const db = makeMockDb();
  _setDbForTest(db);
  await assert.rejects(
    () => updatePort(3, { port: 99999 }),
    (e) => e.httpStatus === 400 && /invalid port/.test(e.message)
  );
});

// ----- deletePort -----

test('deletePort: returns true when driver reports affectedRows=1 (regression: was always false on MSSQL)', async () => {
  const db = makeMockDb();
  db._addScript(/DELETE\s+FROM\s+system_ports/i, { rows: [], affectedRows: 1, insertId: undefined });
  _setDbForTest(db);
  const ok = await deletePort(5);
  assert.equal(ok, true);
});

test('deletePort: returns false when driver reports affectedRows=0 (preserves 404 detection)', async () => {
  const db = makeMockDb();
  db._addScript(/DELETE\s+FROM\s+system_ports/i, { rows: [], affectedRows: 0, insertId: undefined });
  _setDbForTest(db);
  const ok = await deletePort(999);
  assert.equal(ok, false);
});

// ----- getPortStatusesForAgent -----

test('getPortStatusesForAgent: returns rows from listForAgent', async () => {
  const db = makeMockDb();
  db._addScript(/INNER\s+JOIN\s+ad_agent_port_status/i, {
    rows: [{ port: 135, label: 'RPC', ok: 1, latencyMs: 2, lastCheckedAt: new Date() }],
    affectedRows: 0
  });
  _setDbForTest(db);
  const rows = await getPortStatusesForAgent('a1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].port, 135);
});

// ----- upsertPortStatuses -----

test('upsertPortStatuses: routes every per-row execute through the transaction tx (regression: was using pool facade)', async () => {
  const db = makeMockDb();
  db._addScript(/MERGE\s+INTO\s+ad_agent_port_status/i, { rows: [], affectedRows: 1, insertId: undefined });
  db._addScript(/INSERT\s+INTO\s+ad_agent_port_status/i, { rows: [], affectedRows: 1, insertId: undefined });
  _setDbForTest(db);
  const validPortsSet = new Set([135, 389, 636]);
  const out = await upsertPortStatuses('a1', [
    { port: 135, ok: true, latencyMs: 2 },
    { port: 389, ok: false, latencyMs: 5 }
  ], { validPortsSet });
  assert.deepEqual(out, { accepted: 2, rejected: 0 });
  // Every per-row execute must have gone through `tx`, not the pool facade.
  const upsertCalls = db._calls.filter(c => /MERGE\s+INTO\s+ad_agent_port_status|INSERT\s+INTO\s+ad_agent_port_status/i.test(c.sql));
  assert.equal(upsertCalls.length, 2);
  for (const c of upsertCalls) {
    assert.equal(c.ctx, 'tx', `upsert must run inside transaction (ctx=tx), got ctx=${c.ctx} for ${c.sql}`);
  }
  // Transaction must have been opened exactly once.
  assert.equal(db._txCalls(), 1);
});

test('upsertPortStatuses: rejects rows whose port is not in validPortsSet', async () => {
  const db = makeMockDb();
  _setDbForTest(db);
  const validPortsSet = new Set([135]);
  const out = await upsertPortStatuses('a1', [
    { port: 135, ok: true, latencyMs: 1 },
    { port: 99999, ok: true, latencyMs: 1 },     // invalid port
    { port: 389, ok: true, latencyMs: 1 }        // valid port but not in set
  ], { validPortsSet });
  assert.deepEqual(out, { accepted: 1, rejected: 2 });
  assert.equal(db._txCalls(), 1, 'still wraps the loop in one transaction');
  // Only the one accepted row should have been issued.
  const upsertCalls = db._calls.filter(c => /MERGE|INSERT\s+INTO\s+ad_agent_port_status/i.test(c.sql));
  assert.equal(upsertCalls.length, 1);
});

test('upsertPortStatuses: rejects rows with non-finite or negative latencyMs', async () => {
  const db = makeMockDb();
  _setDbForTest(db);
  const validPortsSet = new Set([135]);
  const out = await upsertPortStatuses('a1', [
    { port: 135, ok: true, latencyMs: -1 },
    { port: 135, ok: true, latencyMs: 'abc' },
    { port: 135, ok: true, latencyMs: 2 }
  ], { validPortsSet });
  assert.deepEqual(out, { accepted: 1, rejected: 2 });
});

test('upsertPortStatuses: returns {accepted:0,rejected:0} for non-array input', async () => {
  const db = makeMockDb();
  _setDbForTest(db);
  const out = await upsertPortStatuses('a1', null, { validPortsSet: new Set() });
  assert.deepEqual(out, { accepted: 0, rejected: 0 });
  assert.equal(db._txCalls(), 0, 'no transaction opened for non-array input');
});

// ----- listPortStatusesForAgents -----

test('listPortStatusesForAgents: returns [] for empty/non-array input', async () => {
  const db = makeMockDb();
  _setDbForTest(db);
  const a = await listPortStatusesForAgents([]);
  const b = await listPortStatusesForAgents(null);
  assert.deepEqual(a, []);
  assert.deepEqual(b, []);
});

test('listPortStatusesForAgents: builds placeholders and runs query with all ids', async () => {
  const db = makeMockDb();
  db._addScript(/FROM\s+ad_agent_port_status/i, {
    rows: [{ agentId: 'a1', port: 135, ok: 1, latencyMs: 2, lastCheckedAt: new Date() }],
    affectedRows: 0
  });
  _setDbForTest(db);
  const rows = await listPortStatusesForAgents(['a1', 'a2']);
  assert.equal(rows.length, 1);
  // Only one placeholders-using call (the listForAgents query).
  const listCalls = db._calls.filter(c => /FROM\s+ad_agent_port_status/i.test(c.sql));
  assert.equal(listCalls.length, 1);
  assert.match(listCalls[0].sql, /agent_id IN \(\?, \?\)/);
  assert.deepEqual(listCalls[0].params, ['a1', 'a2']);
});
