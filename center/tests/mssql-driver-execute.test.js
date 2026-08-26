// Unit tests for mssql driver `execute()` behavior — focused on the
// isInsert heuristic, the affectedRows contract, and the IF-block →
// request.batch() routing.
//
// These tests do not require a live SQL Server. We mock the `mssql`
// package at module-load time, drive the driver's execute() /
// transaction() surface, and assert what SQL the driver actually
// sends to the underlying mssql client (rewrite placeholders, SCOPE_IDENTITY
// batching, MERGE exclusion, IF-block routing to batch, etc.) plus what
// comes back in the return shape. Captures regressions for:
//   - Task 2 review CRITICAL 1: non-INSERT (UPDATE/DELETE/MERGE) execute()
//     must return affectedRows = the real count, not 0.
//   - Task 2 review IMPORTANT 3: MERGE must not be classified as an
//     INSERT (the SCOPE_IDENTITY probe would throw on tables without
//     IDENTITY such as ad_agent_port_status, ad_dcs, ad_agent_heartbeat,
//     system_config).
//   - 2026-08-15 wizard fix: `IF NOT EXISTS (...) CREATE INDEX ...` must
//     route through request.batch() — request.query() wraps in sp_executesql
//     which silently drops the IF guard, causing re-run failures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Build an in-memory mock of the `mssql` package, then dynamically
// import center/src/db/drivers/mssql.js after rewriting its `import sql from 'mssql'`
// to point at the mock. We do this by stubbing Node's module resolver
// via a cache entry on globalThis before importing the driver.
function makeMssqlMock() {
  const calls = [];
  const state = {
    // Per-test: {rowsAffected, recordset, recordsets, throwOnQuery}
    nextResult: null
  };

  class FakeRequest {
    constructor(parent) {
      this.parent = parent;
      this.inputs = [];
      this.multiple = false;
    }
    input(name, value) { this.inputs.push({ name, value }); }
    async query(sqlStr) {
      calls.push({
        method: 'query',
        sql: sqlStr,
        inputs: this.inputs.slice(),
        multiple: this.multiple
      });
      const r = state.nextResult;
      if (!r) throw new Error('FakeRequest.query: state.nextResult not set');
      if (r.throwOnQuery) {
        const err = new Error(r.throwOnQuery.message || 'driver error');
        if (r.throwOnQuery.number != null) err.number = r.throwOnQuery.number;
        if (r.throwOnQuery.code != null) err.code = r.throwOnQuery.code;
        throw err;
      }
      if (r.recordsets) {
        return { recordsets: r.recordsets, rowsAffected: r.rowsAffected };
      }
      return { recordset: r.recordset ?? [], rowsAffected: r.rowsAffected ?? [1] };
    }
    async batch(sqlStr) {
      calls.push({
        method: 'batch',
        sql: sqlStr,
        inputs: this.inputs.slice(),
        multiple: this.multiple
      });
      const r = state.nextBatch ?? state.nextResult;
      if (!r) throw new Error('FakeRequest.batch: state.nextBatch / state.nextResult not set');
      if (r.throwOnQuery) {
        const err = new Error(r.throwOnQuery.message || 'driver error');
        if (r.throwOnQuery.number != null) err.number = r.throwOnQuery.number;
        if (r.throwOnQuery.code != null) err.code = r.throwOnQuery.code;
        throw err;
      }
      // batch() returns recordsets[] (no single recordset). Fake one matching
      // shape so the driver's recordsets normalization path is exercised.
      const recordsets = r.recordsets ?? [[]];
      return { recordsets, rowsAffected: r.rowsAffected ?? [0] };
    }
  }

  class FakeTransaction {
    constructor(pool) { this.pool = pool; }
    async begin() { this._began = true; }
    async commit() { this._committed = true; }
    async rollback() { this._rolled = true; }
    request() { return new FakeRequest(this); }
  }

  class FakeConnectionPool {
    constructor() { this._connected = false; }
    async connect() { this._connected = true; }
    async close() { this._connected = false; }
    request() { return new FakeRequest(this); }
    transaction() { return new FakeTransaction(this); }
  }

  return {
    state,
    calls,
    mssql: {
      ConnectionPool: FakeConnectionPool,
      Transaction: FakeTransaction,
      Request: FakeRequest
    }
  };
}

// Use Node's `module.register` alternative: load the driver file by
// reading its source and rewriting the `import sql from 'mssql'` line.
// Easier path: use a child cache by writing a temporary copy of the
// driver into a temp file with the import line swapped. Even simpler:
// import via data: URL with the swap baked in.
//
// Simplest of all: read the driver source, swap the import, and write
// to a temp file. We then dynamic-import that temp file.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

function loadDriverWithMock(mock) {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'mssql-test-'));
  const driverPath = path.join(__dirname, '..', 'src', 'db', 'drivers', 'mssql.js');
  const original = readFileSync(driverPath, 'utf8');
  // Replace `import sql from 'mssql';` with a dynamic load of the mock.
  // We attach the mock to a global so the rewritten driver can find it.
  globalThis.__MSSQL_MOCK__ = mock.mssql;
  const rewritten = original.replace(
    /^import\s+sql\s+from\s+['"]mssql['"];?$/m,
    "const sql = globalThis.__MSSQL_MOCK__;"
  );
  const tmpFile = path.join(tmpDir, 'mssql-driver-under-test.mjs');
  writeFileSync(tmpFile, rewritten);
  try {
    // Synchronous import via createRequire would not work for ESM.
    // Use eval'd module — but Node doesn't expose dynamic ESM sync.
    // Fall back: import and await.
    return import(pathToFileURL(tmpFile).href).then(mod => {
      rmSync(tmpDir, { recursive: true, force: true });
      return mod.createMssqlDriver;
    });
  } catch (e) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw e;
  }
}

test('isInsert: INSERT INTO classified as insert (SCOPE_IDENTITY probe appended)', async () => {
  const mock = makeMssqlMock();
  mock.state.nextResult = {
    recordsets: [[], [{ id: 42 }]],
    rowsAffected: [1, 1]
  };
  const createMssqlDriver = await loadDriverWithMock(mock);
  const drv = createMssqlDriver({ server: 'x', database: 'd', user: 'u', password: 'p' });
  const out = await drv.execute('INSERT INTO system_ports (port, label) VALUES (?, ?)', [135, 'RPC']);
  assert.equal(out.insertId, 42);
  assert.equal(out.affectedRows, 1);
  // Probe must be present in the SQL sent to the driver. ensureConnected()
  // issues a one-shot SET batch on first connect, so the user's INSERT is the
  // LAST call (not the first).
  const sent = mock.calls.at(-1).sql;
  assert.match(sent, /INSERT INTO system_ports/);
  assert.match(sent, /SCOPE_IDENTITY/);
});

test('isInsert: MERGE NOT classified as insert (no SCOPE_IDENTITY probe)', async () => {
  const mock = makeMssqlMock();
  // MERGE: no recordsets, just recordset + rowsAffected (single batch).
  mock.state.nextResult = { recordset: [], rowsAffected: [2] };
  const createMssqlDriver = await loadDriverWithMock(mock);
  const drv = createMssqlDriver({ server: 'x', database: 'd', user: 'u', password: 'p' });
  const out = await drv.execute(
    'MERGE INTO ad_agent_port_status AS t USING (SELECT @p1 AS agent_id, @p2 AS port) AS s ON t.agent_id = s.agent_id AND t.port = s.port WHEN MATCHED THEN UPDATE SET t.ok = s.ok WHEN NOT MATCHED THEN INSERT (agent_id, port) VALUES (s.agent_id, s.port)',
    ['a1', 135]
  );
  // No SCOPE_IDENTITY appended (would throw on IDENTITY-less tables).
  // ensureConnected() issues a one-shot SET batch on first connect, so the
  // user's MERGE is the LAST call (not the first).
  const sent = mock.calls.at(-1).sql;
  assert.equal(sent.includes('SCOPE_IDENTITY'), false, `MERGE must not append SCOPE_IDENTITY probe; got: ${sent}`);
  // MERGE on a no-IDENTITY table: insertId stays undefined.
  assert.equal(out.insertId, undefined);
});

test('affectedRows: UPDATE returns real rowsAffected (regression for deletePort/updatePort 404 bug)', async () => {
  const mock = makeMssqlMock();
  mock.state.nextResult = { recordset: [], rowsAffected: [1] };
  const createMssqlDriver = await loadDriverWithMock(mock);
  const drv = createMssqlDriver({ server: 'x', database: 'd', user: 'u', password: 'p' });
  const out = await drv.execute('UPDATE system_ports SET label = @p1 WHERE id = @p2', ['New', 3]);
  assert.equal(out.affectedRows, 1, 'UPDATE that affected 1 row must report affectedRows=1');
  assert.equal(out.insertId, undefined);
});

test('affectedRows: UPDATE affecting 0 rows reports 0 (preserves 404 detection)', async () => {
  const mock = makeMssqlMock();
  mock.state.nextResult = { recordset: [], rowsAffected: [0] };
  const createMssqlDriver = await loadDriverWithMock(mock);
  const drv = createMssqlDriver({ server: 'x', database: 'd', user: 'u', password: 'p' });
  const out = await drv.execute('UPDATE system_ports SET label = @p1 WHERE id = @p2', ['X', 999]);
  assert.equal(out.affectedRows, 0);
});

test('affectedRows: DELETE returns real rowsAffected (regression for deletePort 404 bug)', async () => {
  const mock = makeMssqlMock();
  mock.state.nextResult = { recordset: [], rowsAffected: [1] };
  const createMssqlDriver = await loadDriverWithMock(mock);
  const drv = createMssqlDriver({ server: 'x', database: 'd', user: 'u', password: 'p' });
  const out = await drv.execute('DELETE FROM system_ports WHERE id = @p1', [5]);
  assert.equal(out.affectedRows, 1);
});

test('affectedRows: MERGE returns real rowsAffected (regression for upsertPortStatuses)', async () => {
  const mock = makeMssqlMock();
  mock.state.nextResult = { recordset: [], rowsAffected: [1] };
  const createMssqlDriver = await loadDriverWithMock(mock);
  const drv = createMssqlDriver({ server: 'x', database: 'd', user: 'u', password: 'p' });
  const out = await drv.execute(
    'MERGE INTO ad_agent_port_status AS t USING (SELECT @p1 AS agent_id, @p2 AS port, @p3 AS ok, @p4 AS latency_ms, @p5 AS last_checked_at) AS s ON t.agent_id = s.agent_id AND t.port = s.port WHEN MATCHED THEN UPDATE SET t.ok = s.ok WHEN NOT MATCHED THEN INSERT (agent_id, port, ok, latency_ms, last_checked_at) VALUES (s.agent_id, s.port, s.ok, s.latency_ms, s.last_checked_at)',
    ['a1', 135, 1, 2, new Date()]
  );
  assert.equal(out.affectedRows, 1, 'MERGE that touched 1 row must report affectedRows=1');
});

test('tx.execute: MERGE inside transaction reports affectedRows=1', async () => {
  const mock = makeMssqlMock();
  mock.state.nextResult = { recordset: [], rowsAffected: [1] };
  const createMssqlDriver = await loadDriverWithMock(mock);
  const drv = createMssqlDriver({ server: 'x', database: 'd', user: 'u', password: 'p' });
  let txAffected = -1;
  await drv.transaction(async (tx) => {
    const out = await tx.execute('MERGE INTO ad_agent_port_status AS t USING (SELECT @p1 AS agent_id) AS s ON t.agent_id = s.agent_id WHEN NOT MATCHED THEN INSERT (agent_id) VALUES (s.agent_id)', ['a1']);
    txAffected = out.affectedRows;
  });
  assert.equal(txAffected, 1);
});

test('INSERT INTO with no IDENTITY column still appends SCOPE_IDENTITY probe (probe failure is OK)', async () => {
  // Round-14 fix: previously this threw unconditionally when SCOPE_IDENTITY()
  // returned NULL (target table has no IDENTITY column, e.g.
  // ad_agent_port_status). Distinguish:
  //   - affectedRows > 0 + id NULL → INSERT succeeded, no auto-id available.
  //     Return undefined insertId. Tables without IDENTITY (schema_migrations,
  //     ad_agent_port_status) now work.
  //   - affectedRows == 0 + id NULL → INSERT failed entirely. Still throw
  //     so the failure surfaces.
  // Pins the "INSERT succeeded with no IDENTITY" branch — ddl-apply.js
  // relies on this for the schema_migrations row INSERT.
  const mock = makeMssqlMock();
  mock.state.nextResult = {
    recordsets: [[], [{ id: null }]],  // SCOPE_IDENTITY returns NULL
    rowsAffected: [1, 1]                // INSERT itself affected 1 row
  };
  const createMssqlDriver = await loadDriverWithMock(mock);
  const drv = createMssqlDriver({ server: 'x', database: 'd', user: 'u', password: 'p' });
  const out = await drv.execute('INSERT INTO ad_agent_port_status (agent_id, port) VALUES (?, ?)', ['a1', 135]);
  assert.equal(out.affectedRows, 1);
  assert.equal(out.insertId, undefined);
});

test('INSERT INTO with no IDENTITY column AND affectedRows=0 still throws (real failure)', async () => {
  // Round-14 companion: if the INSERT itself fails (affectedRows=0) AND
  // SCOPE_IDENTITY is NULL (no IDENTITY column), the driver still throws —
  // surfaces the failure instead of silently returning undefined insertId.
  const mock = makeMssqlMock();
  mock.state.nextResult = {
    recordsets: [[], [{ id: null }]],
    rowsAffected: [0, 1]                // INSERT itself affected 0 rows
  };
  const createMssqlDriver = await loadDriverWithMock(mock);
  const drv = createMssqlDriver({ server: 'x', database: 'd', user: 'u', password: 'p' });
  await assert.rejects(
    () => drv.execute('INSERT INTO ad_agent_port_status (agent_id, port) VALUES (?, ?)', ['a1', 135]),
    /SCOPE_IDENTITY.*returned NULL/
  );
});

test('IF NOT EXISTS (...) CREATE INDEX routes through request.batch() (NOT request.query())', async () => {
  // Regression for wizard failure: `request.query()` wraps every SQL string in
  // sp_executesql, which silently drops IF guards. DDL like
  // `IF NOT EXISTS (...) CREATE INDEX ...` must therefore go through
  // `request.batch()` so the IF guard is honored — otherwise re-applying the
  // migration hits "index already exists" instead of skipping. This test pins
  // the routing decision: prefix with `IF` → batch; otherwise → query.
  const mock = makeMssqlMock();
  mock.state.nextResult = { recordsets: [[]], rowsAffected: [0] };
  const createMssqlDriver = await loadDriverWithMock(mock);
  const drv = createMssqlDriver({ server: 'x', database: 'd', user: 'u', password: 'p' });
  // Exact shape from db/migrations/mssql/005-sys-config-audit.sql
  const ifSql = `IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_changed_at' AND object_id = OBJECT_ID('sys_config_audit'))
CREATE INDEX idx_changed_at ON sys_config_audit (changed_at DESC)`;
  const out = await drv.execute(ifSql, []);
  assert.equal(out.affectedRows, 0);
  assert.equal(out.insertId, undefined);
  // The IF-prefixed statement MUST have hit .batch(), not .query().
  // ensureConnected() issues a one-shot SET batch on first connect, so total
  // calls = 2 (SET + user SQL). Filter out the SET call when asserting on
  // the user SQL's method.
  assert.equal(mock.calls.length, 2, `expected exactly 2 driver calls (SET + user SQL), got ${mock.calls.length}`);
  const userCall = mock.calls.find(c => c.sql.includes('CREATE INDEX'));
  assert.ok(userCall, 'expected the IF/CREATE INDEX statement to appear in mock.calls');
  assert.equal(userCall.method, 'batch',
    `IF-prefixed DDL must use request.batch(); got ${userCall.method}. ` +
    `request.query() wraps in sp_executesql which drops the IF guard.`);
  // SQL sent is unchanged (no SCOPE_IDENTITY append for non-INSERT).
  assert.equal(userCall.sql, ifSql);
});

test('CREATE TABLE (no IF) still uses request.query() — control-flow routing is opt-in', async () => {
  // Counter-test: regular DDL without IF guard must NOT be routed to batch().
  // batch() doesn't use sp_executesql → no plan reuse. We want query() (sp_executesql
  // with plan reuse) for the hot path and only switch to batch() when IF blocks
  // demand it.
  const mock = makeMssqlMock();
  mock.state.nextResult = { recordset: [], rowsAffected: [0] };
  const createMssqlDriver = await loadDriverWithMock(mock);
  const drv = createMssqlDriver({ server: 'x', database: 'd', user: 'u', password: 'p' });
  await drv.execute('CREATE TABLE foo (id INT PRIMARY KEY)', []);
  // ensureConnected() issues a one-shot SET batch on first connect, so total
  // calls = 2 (SET + user SQL).
  assert.equal(mock.calls.length, 2);
  const userCall = mock.calls.find(c => c.sql.includes('CREATE TABLE'));
  assert.equal(userCall.method, 'query',
    `non-IF DDL must stay on request.query(); got ${userCall.method}`);
});

test('IF EXISTS (...) ALTER TABLE inside transaction routes through request.batch()', async () => {
  // Same routing rule inside db.transaction(): IF-prefixed DDL must use batch.
  const mock = makeMssqlMock();
  mock.state.nextResult = { recordsets: [[]], rowsAffected: [0] };
  const createMssqlDriver = await loadDriverWithMock(mock);
  const drv = createMssqlDriver({ server: 'x', database: 'd', user: 'u', password: 'p' });
  let observedMethod = null;
  await drv.transaction(async (tx) => {
    const ifSql = `IF EXISTS (SELECT * FROM sysobjects WHERE name='foo' AND xtype='U')
ALTER TABLE foo ADD bar INT`;
    await tx.execute(ifSql, []);
    // ensureConnected() issues a one-shot SET batch before the tx starts, so
    // find the user's IF/ALTER call (not the SET batch).
    const userCall = mock.calls.find(c => c.sql.includes('ALTER TABLE'));
    observedMethod = userCall?.method;
  });
  assert.equal(observedMethod, 'batch',
    `IF-prefixed DDL inside tx must use request.batch(); got ${observedMethod}`);
});

test('leading-whitespace IF still routes to batch() (regex is `^\\s*IF\\b`)', async () => {
  // splitSqlStatements strips most whitespace but the leading `\n` may remain
  // depending on parser path. The driver must tolerate it.
  const mock = makeMssqlMock();
  mock.state.nextResult = { recordsets: [[]], rowsAffected: [0] };
  const createMssqlDriver = await loadDriverWithMock(mock);
  const drv = createMssqlDriver({ server: 'x', database: 'd', user: 'u', password: 'p' });
  const ifSql = `\n  IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE name='x')\nCREATE TABLE x (id INT)`;
  await drv.execute(ifSql, []);
  // ensureConnected() issues a one-shot SET batch first; find the user's
  // CREATE TABLE call instead of asserting on calls[0].
  const userCall = mock.calls.find(c => c.sql.includes('CREATE TABLE'));
  assert.equal(userCall.method, 'batch',
    `leading-whitespace IF must still route to batch(); got ${userCall.method}`);
});
