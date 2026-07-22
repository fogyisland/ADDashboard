// Unit tests for mssql driver `execute()` behavior — focused on the
// isInsert heuristic and the affectedRows contract.
//
// These tests do not require a live SQL Server. We mock the `mssql`
// package at module-load time, drive the driver's execute() /
// transaction() surface, and assert what SQL the driver actually
// sends to the underlying mssql client (rewrite placeholders, SCOPE_IDENTITY
// batching, MERGE exclusion, etc.) plus what comes back in the return
// shape. Captures regressions for:
//   - Task 2 review CRITICAL 1: non-INSERT (UPDATE/DELETE/MERGE) execute()
//     must return affectedRows = the real count, not 0.
//   - Task 2 review IMPORTANT 3: MERGE must not be classified as an
//     INSERT (the SCOPE_IDENTITY probe would throw on tables without
//     IDENTITY such as ad_agent_port_status, ad_dcs, ad_agent_heartbeat,
//     system_config).

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
  // Probe must be present in the SQL sent to the driver.
  const sent = mock.calls[0].sql;
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
  const sent = mock.calls[0].sql;
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
  // The brief notes: SCOPE_IDENTITY() on a table without IDENTITY returns NULL
  // and the driver throws. This is the EXISTING behavior for INSERT INTO
  // ad_agent_port_status (no IDENTITY). The test pins that the regex still
  // appends the probe — the FIX is to NOT classify MERGE as insert, not to
  // change INSERT behavior. If someone later wants INSERT INTO
  // ad_agent_port_status to be supported, that's a separate concern.
  const mock = makeMssqlMock();
  mock.state.nextResult = {
    recordsets: [[], [{ id: null }]],  // SCOPE_IDENTITY returns NULL
    rowsAffected: [1, 1]
  };
  const createMssqlDriver = await loadDriverWithMock(mock);
  const drv = createMssqlDriver({ server: 'x', database: 'd', user: 'u', password: 'p' });
  await assert.rejects(
    () => drv.execute('INSERT INTO ad_agent_port_status (agent_id, port) VALUES (?, ?)', ['a1', 135]),
    /SCOPE_IDENTITY.*returned NULL/
  );
});
