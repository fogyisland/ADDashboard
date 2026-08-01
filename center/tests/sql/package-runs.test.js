// package-runs.test.js — covers the packageRuns helper module against
// a mock db. Two queries: insert (with new-id return) and listRecent
// (with filter and LIMIT).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSql } from '../../src/db/sql.js';
import { packageRuns, packageRunsSql } from '../../src/db/sql/package-runs.js';

function makeMockDb({ dialect = 'mysql' } = {}) {
  const calls = [];
  const scripts = [];
  function lookup(sql) {
    for (const s of scripts) {
      if (s.match.test(sql)) {
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
      calls.push({ sql, params: [...params] });
      return lookup(sql);
    },
    async query(sql, params = []) {
      calls.push({ sql, params: [...params] });
      return { rows: lookup(sql).rows };
    },
    async transaction(work) {
      return work({
        execute: async (sql, params = []) => {
          calls.push({ sql, params: [...params] });
          return lookup(sql);
        },
        query: async (sql, params = []) => {
          calls.push({ sql, params: [...params] });
          return { rows: lookup(sql).rows };
        }
      });
    },
    _calls: calls,
    _addScript(match, result) { scripts.push({ match, result }); }
  };
}

// ---- SQL registry shape ----

test('packageRunsSql: insert mysql has 8 placeholders', () => {
  assert.match(packageRunsSql.insert.mysql, /INSERT INTO package_runs/);
  assert.strictEqual((packageRunsSql.insert.mysql.match(/\?/g) || []).length, 8);
});

test('packageRunsSql: insert mssql has 8 placeholders (no SELECT SCOPE_IDENTITY — driver appends it)', () => {
  assert.match(packageRunsSql.insert.mssql, /INSERT INTO package_runs/);
  assert.strictEqual((packageRunsSql.insert.mssql.match(/\?/g) || []).length, 8);
  // Defensive: the mssql driver wrapper auto-appends SELECT SCOPE_IDENTITY(),
  // so the SQL constant must NOT include it (would produce a duplicate batch).
  assert.doesNotMatch(packageRunsSql.insert.mssql, /SCOPE_IDENTITY/i);
});

// ---- insert ----

test('packageRuns.insert: returns insertId and passes 8 params', async () => {
  const db = makeMockDb();
  db._addScript(/INSERT\s+INTO\s+package_runs/i, { rows: [], affectedRows: 1, insertId: 42 });
  const startedAt = new Date('2026-01-01T00:00:00Z');
  const finishedAt = new Date('2026-01-01T00:00:05Z');
  const id = await packageRuns.insert(db, {
    agentId: 'a1',
    packageName: 'cpu-monitor',
    startedAt,
    finishedAt,
    exitCode: 0,
    stdoutPreview: 'ok',
    stderrPreview: null,
    error: null
  });
  assert.equal(id, 42);
  assert.match(db._calls[0].sql, /INSERT INTO package_runs/);
  const p = db._calls[0].params;
  assert.equal(p.length, 8);
  assert.equal(p[0], 'a1');
  assert.equal(p[1], 'cpu-monitor');
  assert.equal(p[2], startedAt);
  assert.equal(p[3], finishedAt);
  assert.equal(p[4], 0);
  assert.equal(p[5], 'ok');
  assert.equal(p[6], null);
  assert.equal(p[7], null);
});

test('packageRuns.insert: missing optional fields stay null', async () => {
  const db = makeMockDb();
  db._addScript(/INSERT\s+INTO\s+package_runs/i, { rows: [], affectedRows: 1, insertId: 7 });
  await packageRuns.insert(db, {
    agentId: 'a1',
    packageName: 'p1',
    startedAt: new Date()
  });
  const p = db._calls[0].params;
  assert.equal(p[3], null); // finishedAt
  assert.equal(p[4], null); // exitCode
  assert.equal(p[5], null); // stdoutPreview
  assert.equal(p[6], null); // stderrPreview
  assert.equal(p[7], null); // error
});

test('packageRuns.insert: returns undefined when no insertId present', async () => {
  const db = makeMockDb();
  db._addScript(/INSERT\s+INTO\s+package_runs/i, { rows: [], affectedRows: 1 });
  const id = await packageRuns.insert(db, {
    agentId: 'a1',
    packageName: 'p1',
    startedAt: new Date()
  });
  assert.equal(id, undefined);
});

test('packageRuns.insert: mssql uses the same INSERT shape', async () => {
  const db = makeMockDb({ dialect: 'mssql' });
  db._addScript(/INSERT\s+INTO\s+package_runs/i, { rows: [], affectedRows: 1, insertId: 99 });
  const id = await packageRuns.insert(db, {
    agentId: 'a1',
    packageName: 'p1',
    startedAt: new Date()
  });
  assert.equal(id, 99);
  assert.equal(db._calls[0].params.length, 8);
});

// ---- listRecent ----

test('packageRuns.listRecent: no filters — LIMIT defaults to 20 (mysql)', async () => {
  const db = makeMockDb();
  db._addScript(/FROM package_runs\s+ORDER BY started_at DESC/i, {
    rows: [{ id: 1, agent_id: 'a1', package_name: 'p1' }],
    affectedRows: 0
  });
  const rows = await packageRuns.listRecent(db);
  assert.equal(rows.length, 1);
  assert.match(db._calls[0].sql, /ORDER BY started_at DESC LIMIT 20/);
});

test('packageRuns.listRecent: no filters — TOP defaults to 20 (mssql)', async () => {
  const db = makeMockDb({ dialect: 'mssql' });
  db._addScript(/FROM package_runs\s+ORDER BY started_at DESC/i, {
    rows: [{ id: 1, agent_id: 'a1', package_name: 'p1' }],
    affectedRows: 0
  });
  const rows = await packageRuns.listRecent(db);
  assert.equal(rows.length, 1);
  assert.match(db._calls[0].sql, /SELECT TOP 20 \* FROM package_runs\s+ORDER BY started_at DESC/);
});

test('packageRuns.listRecent: filters by agentId and packageName', async () => {
  const db = makeMockDb();
  db._addScript(/FROM package_runs WHERE/i, {
    rows: [{ id: 1, agent_id: 'a1', package_name: 'p1' }],
    affectedRows: 0
  });
  await packageRuns.listRecent(db, { agentId: 'a1', packageName: 'p1' });
  const call = db._calls[0];
  assert.match(call.sql, /WHERE agent_id = \? AND package_name = \?/);
  assert.deepEqual(call.params, ['a1', 'p1']);
});

test('packageRuns.listRecent: limit overrides the default', async () => {
  const db = makeMockDb();
  db._addScript(/FROM package_runs\s+ORDER BY started_at DESC/i, { rows: [], affectedRows: 0 });
  await packageRuns.listRecent(db, { limit: 5 });
  assert.match(db._calls[0].sql, /LIMIT 5/);
});

test('packageRuns.listRecent: limit is integer-coerced (rejects floats/strings)', async () => {
  const db = makeMockDb();
  db._addScript(/FROM package_runs\s+ORDER BY started_at DESC/i, { rows: [], affectedRows: 0 });
  await packageRuns.listRecent(db, { limit: '7' });
  assert.match(db._calls[0].sql, /LIMIT 7/);
});

test('packageRuns.listRecent: limit is clamped to max 1000', async () => {
  const db = makeMockDb();
  db._addScript(/FROM package_runs\s+ORDER BY started_at DESC/i, { rows: [], affectedRows: 0 });
  await packageRuns.listRecent(db, { limit: 99999 });
  assert.match(db._calls[0].sql, /LIMIT 1000/);
});
