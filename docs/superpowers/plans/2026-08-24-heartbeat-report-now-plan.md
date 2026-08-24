# Heartbeat "Report Now" Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-KKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-agent "回报" button to the heartbeat monitor view; clicking it causes the agent to immediately run its full data-report cycle instead of waiting for its next scheduled tick. Persists across agent offline windows; idempotent on rapid clicks; fully backward-compatible with agents older than round-12.

**Architecture:** Reuse the existing `POST /api/agent/heartbeat` response body as a one-bit command channel. A new DB column `ad_agent_heartbeat.report_requested_at` is set when an admin clicks 回报; the next heartbeat response carries `reportRequested: <bool>`; the agent's `send()` callback invokes `scheduler._tick()` when the flag is true and arms a one-shot `report_requested_at: null` clear in the next POST body. No new long-lived push channel (WebSocket / SSE) is opened.

**Tech Stack:** Node.js center (Express, mysql2/mssql, supertest + node:test); PowerShell 5.1 agent (no new dependencies); Vue 3 frontend (Vitest). MySQL + MSSQL dual-dialect SQL. Existing `WriteAudit` + `audit-classifier` taxonomy. Existing `scheduler._tick()` exposed in `agent/src/scheduler.js:58` for direct invocation.

**Spec:** `docs/superpowers/specs/2026-08-24-heartbeat-report-now-design.md`

## Global Constraints

- **snake_case SQL columns**: All new column names use snake_case (`report_requested_at`); JS keys follow the same.
- **MSSQL no native JSON / uses sys.columns for column-existence**: migration `018` queries `sys.columns` before `ALTER TABLE` (matches the round-11 pattern at `db/migrations/mssql/016-replication-partner-port-status.sql`).
- **MySQL driver normalizes**: `mysql2/promise` returns DATETIME as JS `Date`; we never call `.toISOString()` on the raw value before passing back to driver for re-bind.
- **publish/system/ mirror must be lockstep**: every change to `center/src/db/sql.js`, `db/migrations/*`, `center/web/src/**` must also land in `publish/system/center/src/db/sql.js`, `publish/system/db/migrations/*`, `publish/system/center/web/dist/**` (built).
- **Audit log taxonomy lives in source**: any new audit action must be added to all three frozen Maps in `center/src/services/audit-classifier.js` (CATEGORY/SEVERITY/LABEL) AND a test that asserts classification must exist (matches `tests/routes/agent-token-rotate.test.js` pattern).
- **PowerShell 5.1 compatible**: agent-side JS code is Node-side only this round; no new PowerShell scripts. The agent's existing PowerShell callers (`collect-replication.ps1`) are untouched.
- **Migrations must be additive** for `ad_agent_heartbeat` (no column drop, no rename); update BOTH MySQL `db/migrations/` AND MSSQL `db/migrations/mssql/` AND `publish/system/db/migrations/{,mssql/}` in lockstep.
- **Auth gate**: new admin endpoint MUST use `requireAuth + requirePerm('admin:users')` (matches existing `heartbeat-report.js:15`).
- **Backward compatibility**: agents older than round-12 must NOT be broken. They ignore `reportRequested` in response (no-op); they don't send `report_requested_at` in body (center UPSERT must preserve the column when body field is absent). Operator can re-click if needed.
- **Idempotent UPSERT for the new column**: `heartbeat.requestReport` must be safe to call N times in 1 second — second click only refreshes the timestamp, never errors.

---

## Task 1 — DB migration: `ad_agent_heartbeat.report_requested_at`

**Files:**
- Create: `db/migrations/018-report-requested.sql` (MySQL)
- Create: `db/migrations/mssql/018-report-requested.sql` (MSSQL)
- Create: `publish/system/db/migrations/018-report-requested.sql` (mirror MySQL)
- Create: `publish/system/db/migrations/mssql/018-report-requested.sql` (mirror MSSQL)

**Interfaces:**
- Produces: column `ad_agent_heartbeat.report_requested_at` (DATETIME NULL MySQL, DATETIME2 NULL MSSQL); defaults to NULL; no constraints.

- [ ] **Step 1: Write MySQL migration `db/migrations/018-report-requested.sql`**

```sql
-- 2026-08-24 round-12: heartbeat "report now" feature.
-- Center sets this column when admin clicks 回报 on the heartbeat monitor;
-- agent picks it up on its next heartbeat response (carried as the
-- reportRequested boolean field). Agent clears the column by sending
-- report_requested_at: NULL in a subsequent heartbeat POST body.
ALTER TABLE ad_agent_heartbeat
  ADD COLUMN report_requested_at DATETIME NULL AFTER agent_token_version;
```

- [ ] **Step 2: Write MSSQL migration `db/migrations/mssql/018-report-requested.sql`**

```sql
-- 2026-08-24 round-12: heartbeat "report now" feature.
-- Mirror of db/migrations/018-report-requested.sql for MSSQL. MSSQL has
-- no ALTER TABLE IF NOT EXISTS for columns; query sys.columns first so
-- this migration is idempotent on re-run (matches the round-11 pattern
-- at db/migrations/mssql/016-replication-partner-port-status.sql).
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('ad_agent_heartbeat')
    AND name = 'report_requested_at'
)
BEGIN
  ALTER TABLE ad_agent_heartbeat
    ADD report_requested_at DATETIME2 NULL;
END
```

- [ ] **Step 3: Mirror to `publish/system/db/migrations/`**

```bash
cp db/migrations/018-report-requested.sql publish/system/db/migrations/018-report-requested.sql
cp db/migrations/mssql/018-report-requested.sql publish/system/db/migrations/mssql/018-report-requested.sql
```

- [ ] **Step 4: Verify by inspecting the diff**

Run:
```bash
diff -q db/migrations/018-report-requested.sql publish/system/db/migrations/018-report-requested.sql
diff -q db/migrations/mssql/018-report-requested.sql publish/system/db/migrations/mssql/018-report-requested.sql
```

Expected: no output (files identical).

- [ ] **Step 5: Commit**

```bash
git add db/migrations/018-report-requested.sql db/migrations/mssql/018-report-requested.sql publish/system/db/migrations/018-report-requested.sql publish/system/db/migrations/mssql/018-report-requested.sql
git commit -m "feat(db): round-12 — add ad_agent_heartbeat.report_requested_at"
```

---

## Task 2 — SQL helpers: `requestReport` + extend `upsert` + extend list queries

**Files:**
- Modify: `center/src/db/sql.js:118-167` (heartbeat block) and `center/src/db/sql.js:469-494` (MSSQL heartbeat block)
- Modify: `publish/system/center/src/db/sql.js` (mirror)
- Test: `center/tests/sql/heartbeat-report.test.js` (extend)
- Test: `center/tests/sql/mssql-heartbeat-report.test.js` if present; otherwise same file with dialect gating

**Interfaces:**
- Produces: `db.sql.heartbeat.requestReport(agentId, requestedAtIso): string` — UPSERT that inserts a row if missing, otherwise sets `report_requested_at = ?`. Returns row(s) with `report_requested_at` so caller can detect `alreadyPending` (existing non-null value before this call).
- Modifies: `db.sql.heartbeat.upsert` — INSERT/UPDATE column list adds `report_requested_at`. UPSERT uses `COALESCE(?, report_requested_at)` in MySQL and `ISNULL(@p, report_requested_at)` in MSSQL so passing `null` preserves the column; passing a value updates it.
- Modifies: `db.sql.heartbeat.agentsList`, `db.sql.heartbeat.dcsList` — SELECT adds `h.report_requested_at` (alias preserved).

- [ ] **Step 1: Write failing SQL real-DB test for `requestReport`**

In `center/tests/sql/heartbeat-report.test.js`, add (before the closing of the file):

```javascript
test('db.sql.heartbeat.requestReport sets the column on existing row', async (t) => {
  const conn = await openTestConnection(t);
  if (!conn) return;

  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `__t_hb_req_${suffix}`;
  try {
    // Seed an agent row WITHOUT report_requested_at populated (NULL default).
    await conn.execute(
      `INSERT INTO ad_agent_heartbeat
         (agent_id, last_heartbeat_at, agent_version, last_report_at,
          last_report_status, pending_queue_size)
       VALUES (?, CURRENT_TIMESTAMP, 'v', NULL, NULL, 0)`,
      [agentId]
    );

    const ts = '2026-08-24T10:00:00.000Z';
    const sql = sqlRegistry.requestReport(agentId, ts);
    await conn.query(sql, [agentId, new Date(ts)]);

    const [rows] = await conn.execute(
      'SELECT report_requested_at FROM ad_agent_heartbeat WHERE agent_id = ?',
      [agentId]
    );
    assert.equal(rows.length, 1);
    assert.ok(rows[0].report_requested_at instanceof Date);
    assert.equal(rows[0].report_requested_at.toISOString(), ts);
  } finally {
    await conn.execute('DELETE FROM ad_agent_heartbeat WHERE agent_id = ?', [agentId]).catch(() => {});
    await conn.end();
  }
});

test('db.sql.heartbeat.upsert preserves report_requested_at when body field is absent', async (t) => {
  const conn = await openTestConnection(t);
  if (!conn) return;

  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `__t_hb_preserve_${suffix}`;
  const originalTs = new Date('2026-08-24T10:00:00Z');
  try {
    await conn.execute(
      `INSERT INTO ad_agent_heartbeat
         (agent_id, last_heartbeat_at, agent_version, last_report_at,
          last_report_status, pending_queue_size, report_requested_at)
       VALUES (?, CURRENT_TIMESTAMP, 'v', NULL, NULL, 0, ?)`,
      [agentId, originalTs]
    );

    // Send a heartbeat upsert WITHOUT report_requested_at field.
    // The upsert must NOT clear the column.
    const upsertSql = sqlRegistry.upsert;
    const params = [
      agentId,                            // INSERT agent_id
      new Date(),                         // INSERT/UPDATE last_heartbeat_at
      'v2',                               // INSERT/UPDATE agent_version
      null,                               // last_report_at (nullable)
      null,                               // last_report_status (nullable)
      0,                                  // pending_queue_size
      null,                               // agent_token_version
      null,                               // report_requested_at (NULL = preserve)
      agentId,                            // UPDATE WHERE agent_id
      new Date(),                         // UPDATE last_heartbeat_at
      'v2',                               // UPDATE agent_version
      null,                               // UPDATE last_report_at
      null,                               // UPDATE last_report_status
      0,                                  // UPDATE pending_queue_size
      null                                // UPDATE agent_token_version
    ];
    await conn.query(upsertSql, params);

    const [rows] = await conn.execute(
      'SELECT report_requested_at FROM ad_agent_heartbeat WHERE agent_id = ?',
      [agentId]
    );
    assert.equal(rows.length, 1);
    assert.ok(rows[0].report_requested_at instanceof Date);
    assert.equal(rows[0].report_requested_at.toISOString(), originalTs.toISOString());
  } finally {
    await conn.execute('DELETE FROM ad_agent_heartbeat WHERE agent_id = ?', [agentId]).catch(() => {});
    await conn.end();
  }
});
```

- [ ] **Step 2: Run the new tests; expect failures (column doesn't exist yet)**

Run:
```bash
cd center && node --test tests/sql/heartbeat-report.test.js 2>&1 | tail -20
```

Expected: SKIP (TEST_MYSQL_URL not set) — confirms tests are gated correctly. If you have TEST_MYSQL_URL set, expect the first INSERT to fail with "Unknown column 'report_requested_at'" because the migration hasn't been applied to the test DB.

- [ ] **Step 3: Modify `center/src/db/sql.js` MySQL heartbeat block**

In the MySQL heartbeat section (around line 128-167), add `report_requested_at` to `upsert`'s INSERT and UPDATE, add `report_requested_at` to `agentsList` and `dcsList` SELECT, and add a new `requestReport` template.

The exact `upsert` change (read the file first to confirm current shape; the field order in the spec is `agent_token_version` then `report_requested_at`):

```javascript
// In mysql block heartbeat.upsert:
heartbeat: {
  // ...existing fields...
  upsert: `INSERT INTO ad_agent_heartbeat
              (agent_id, last_heartbeat_at, agent_version, last_report_at,
               last_report_status, pending_queue_size, agent_token_version,
               report_requested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
              last_heartbeat_at = VALUES(last_heartbeat_at),
              agent_version     = VALUES(agent_version),
              last_report_at    = VALUES(last_report_at),
              last_report_status = VALUES(last_report_status),
              pending_queue_size = VALUES(pending_queue_size),
              agent_token_version = VALUES(agent_token_version),
              report_requested_at = COALESCE(VALUES(report_requested_at), report_requested_at)`,
  // ... existing fields ...
  agentsList: `SELECT h.agent_id, h.agent_version, h.last_heartbeat_at, h.last_report_at, h.last_report_status, h.pending_queue_size, h.report_requested_at
             FROM ad_agent_heartbeat h
             WHERE h.agent_id <> '__healthcheck__'
             ORDER BY h.agent_id`,
  dcsList: `SELECT h.agent_id, h.agent_version, h.last_heartbeat_at, h.last_report_at, h.last_report_status, h.pending_queue_size,
                 h.report_requested_at,
                 d.dc_name, d.ip_address, d.os_version, d.is_pdc,
                 s.site_name, s.region_code
          FROM ad_agent_heartbeat h
          LEFT JOIN ad_dcs d ON d.dc_name = h.agent_id
          LEFT JOIN ad_sites s ON s.site_id = d.site_id
          WHERE h.agent_id <> '__healthcheck__'
          ORDER BY h.agent_id`,
  requestReport: (agentId, requestedAtIso) => `INSERT INTO ad_agent_heartbeat
              (agent_id, last_heartbeat_at, report_requested_at)
           VALUES (?, CURRENT_TIMESTAMP, ?)
           ON DUPLICATE KEY UPDATE
              report_requested_at = VALUES(report_requested_at)`,
  // ...
}
```

- [ ] **Step 4: Mirror the MySQL changes to the MSSQL block (around line 469-494)**

MSSQL uses MERGE instead of INSERT ... ON DUPLICATE KEY UPDATE. The MSSQL `upsert` should add `report_requested_at` to the INSERT column list and use `ISNULL(@p, report_requested_at)` (or a `CASE` expression) in the UPDATE branch. Read the existing MSSQL heartbeat block first to see the exact MERGE shape, then add:

```javascript
// MSSQL heartbeat.upsert:
upsert: `MERGE ad_agent_heartbeat AS t
         USING (SELECT
                  @p_agent_id          AS agent_id,
                  @p_last_heartbeat_at AS last_heartbeat_at,
                  @p_agent_version     AS agent_version,
                  @p_last_report_at    AS last_report_at,
                  @p_last_report_status AS last_report_status,
                  @p_pending_queue_size AS pending_queue_size,
                  @p_agent_token_version AS agent_token_version,
                  @p_report_requested_at AS report_requested_at
                ) AS s ON t.agent_id = s.agent_id
         WHEN NOT MATCHED THEN
           INSERT (agent_id, last_heartbeat_at, agent_version, last_report_at,
                   last_report_status, pending_queue_size, agent_token_version,
                   report_requested_at)
           VALUES (s.agent_id, s.last_heartbeat_at, s.agent_version, s.last_report_at,
                   s.last_report_status, s.pending_queue_size, s.agent_token_version,
                   s.report_requested_at)
         WHEN MATCHED THEN
           UPDATE SET
             last_heartbeat_at  = s.last_heartbeat_at,
             agent_version      = s.agent_version,
             last_report_at     = s.last_report_at,
             last_report_status = s.last_report_status,
             pending_queue_size = s.pending_queue_size,
             agent_token_version = s.agent_token_version,
             report_requested_at = ISNULL(s.report_requested_at, t.report_requested_at);`,
// MSSQL heartbeat.requestReport:
requestReport: (agentId, requestedAtIso) =>
  `MERGE ad_agent_heartbeat AS t
   USING (SELECT @p_agent_id AS agent_id, @p_requested_at AS report_requested_at) AS s
     ON t.agent_id = s.agent_id
   WHEN NOT MATCHED THEN
     INSERT (agent_id, last_heartbeat_at, report_requested_at)
     VALUES (s.agent_id, CURRENT_TIMESTAMP, s.report_requested_at)
   WHEN MATCHED THEN
     UPDATE SET report_requested_at = s.report_requested_at;`,
// MSSQL heartbeat.agentsList and dcsList: add report_requested_at to SELECT.
```

- [ ] **Step 5: Mirror `center/src/db/sql.js` to `publish/system/center/src/db/sql.js`**

```bash
cp center/src/db/sql.js publish/system/center/src/db/sql.js
diff -q center/src/db/sql.js publish/system/center/src/db/sql.js
```

Expected: no output.

- [ ] **Step 6: Re-run the SQL tests**

Run:
```bash
cd center && node --test tests/sql/heartbeat-report.test.js 2>&1 | tail -20
```

Expected: 4 portable checks pass + the 4 real-DB tests skipped (or pass if TEST_MYSQL_URL is set).

- [ ] **Step 7: Run the full backend suite for regression check**

Run:
```bash
cd center && npm test 2>&1 | tail -10
```

Expected: 1147 tests, 1079 pass, 68 skipped, 0 fail (numbers may grow as new tests land in later tasks; the existing tests must not regress).

- [ ] **Step 8: Commit**

```bash
git add center/src/db/sql.js publish/system/center/src/db/sql.js center/tests/sql/heartbeat-report.test.js
git commit -m "feat(center): round-12 — SQL helpers for report_requested_at"
```

---

## Task 3 — Backend service: `requestReport(agentId, requesterUserId)`

**Files:**
- Modify: `center/src/services/heartbeat-report.js`
- Test: `center/tests/services/heartbeat-report.test.js` (new file or extend existing — note: there's no existing service test for this file; create the test file)

**Interfaces:**
- Produces: `async function requestReport(agentId, db = null): Promise<{ agentId, requestedAt, alreadyPending }>` — sets `report_requested_at` via `db.sql.heartbeat.requestReport` SQL; returns `alreadyPending: true` if a non-null `report_requested_at` was already present before this call.
- Throws `AgentNotFoundError` when `agentId` does not match any row in `ad_agent_heartbeat`. The service detects this by querying `SELECT 1 FROM ad_agent_heartbeat WHERE agent_id = ?` first; if zero rows, throw. (The `requestReport` SQL is an UPSERT so we cannot detect "row didn't exist" from its output alone.)
- Follows the existing positional `db = null` fallback-to-`getDb()` pattern (see `listAgents`, `listDcs`, `getLatestReportDetail` in the same file).

- [ ] **Step 1: Write failing service test**

Create `center/tests/services/heartbeat-report-request-report.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { heartbeatReportService } from '../../src/services/heartbeat-report.js';
import { heartbeatReportRouter } from '../../src/routes/heartbeat-report.js';
import { buildMockDb } from '../helpers/db-mock.js';
import { signJwt } from '../../src/auth/jwt.js';

const SECRET = 'test-secret';

function adminToken() {
  return signJwt({ sub: 'admin-1', role: 'admin', permissions: ['*'] }, SECRET, 60);
}

test('requestReport sets report_requested_at on existing agent', async () => {
  const records = [];
  const db = buildMockDb([
    { match: /SELECT\s+1\s+FROM\s+ad_agent_heartbeat\s+WHERE\s+agent_id\s*=\s*\?/i,
      rows: [{ '1': 1 }] },
    { match: /SELECT\s+report_requested_at\s+FROM\s+ad_agent_heartbeat\s+WHERE\s+agent_id\s*=\s*\?/i,
      rows: [{ report_requested_at: null }] },
    { match: /INSERT\s+INTO\s+ad_agent_heartbeat/i,
      rows: [],
      onQuery: (sql, params) => records.push({ sql, params }) }
  ]).standard();

  const out = await heartbeatReportService.requestReport('KDLWXOFADSRV1', db);
  assert.equal(out.agentId, 'KDLWXOFADSRV1');
  assert.ok(out.requestedAt instanceof Date);
  assert.equal(out.alreadyPending, false);
  // requestReport SQL takes (agentId, requestedAt)
  assert.ok(records.length >= 1);
  assert.equal(records[0].params[0], 'KDLWXOFADSRV1');
  assert.ok(records[0].params[1] instanceof Date);
});

test('requestReport returns alreadyPending=true when flag is already set', async () => {
  const db = buildMockDb([
    { match: /SELECT\s+1\s+FROM\s+ad_agent_heartbeat\s+WHERE\s+agent_id\s*=\s*\?/i,
      rows: [{ '1': 1 }] },
    { match: /SELECT\s+report_requested_at\s+FROM\s+ad_agent_heartbeat\s+WHERE\s+agent_id\s*=\s*\?/i,
      rows: [{ report_requested_at: new Date('2026-08-24T09:00:00Z') }] },
    { match: /INSERT\s+INTO\s+ad_agent_heartbeat/i, rows: [] }
  ]).standard();

  const out = await heartbeatReportService.requestReport('KDLWXOFADSRV1', db);
  assert.equal(out.alreadyPending, true);
});

test('requestReport throws AgentNotFoundError when agent is not registered', async () => {
  const db = buildMockDb([{
    match: /SELECT\s+1\s+FROM\s+ad_agent_heartbeat\s+WHERE\s+agent_id\s*=\s*\?/i,
    rows: []
  }]).standard();

  await assert.rejects(
    heartbeatReportService.requestReport('unknown-agent', db),
    (err) => err.code === 'AGENT_NOT_FOUND'
  );
});
```

- [ ] **Step 2: Run tests; expect failure (service function doesn't exist)**

Run:
```bash
cd center && node --test tests/services/heartbeat-report-request-report.test.js 2>&1 | tail -15
```

Expected: `TypeError: heartbeatReportService.requestReport is not a function`.

- [ ] **Step 3: Implement `requestReport` service**

In `center/src/services/heartbeat-report.js`, add `AgentNotFoundError` as a named export and add `requestReport` as a method on the existing `heartbeatReportService` object (matching the file's existing style of method-on-object exports):

```javascript
export class AgentNotFoundError extends Error {
  constructor(agentId) {
    super(`agent not found: ${agentId}`);
    this.code = 'AGENT_NOT_FOUND';
    this.agentId = agentId;
  }
}

// Add to the heartbeatReportService object literal:
async requestReport(agentId, db = null) {
  const conn = db ?? getDb();
  // First: confirm the agent exists. We can't trust the UPSERT's INSERT
  // branch to detect this — it would silently create a row.
  const exists = await conn.execute(
    'SELECT 1 FROM ad_agent_heartbeat WHERE agent_id = ? LIMIT 1',
    [agentId]
  );
  const existsRows = exists?.rows ?? exists?.[0] ?? [];
  if (existsRows.length === 0) {
    throw new AgentNotFoundError(agentId);
  }

  // Detect alreadyPending BEFORE writing.
  const current = await conn.execute(
    'SELECT report_requested_at FROM ad_agent_heartbeat WHERE agent_id = ? LIMIT 1',
    [agentId]
  );
  const currentRows = current?.rows ?? current?.[0] ?? [];
  const alreadyPending = currentRows.length > 0 &&
    currentRows[0].report_requested_at !== null &&
    currentRows[0].report_requested_at !== undefined;

  const requestedAt = new Date();
  const sql = conn.sql.heartbeat.requestReport(agentId, requestedAt.toISOString());
  await conn.execute(sql, [agentId, requestedAt]);

  return { agentId, requestedAt, alreadyPending };
}
```

- [ ] **Step 4: Re-run service tests; expect pass**

Run:
```bash
cd center && node --test tests/services/heartbeat-report-request-report.test.js 2>&1 | tail -10
```

Expected: 2 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add center/src/services/heartbeat-report.js center/tests/services/heartbeat-report-request-report.test.js
git commit -m "feat(center): round-12 — requestReport service"
```

---

## Task 4 — Audit classifier: `request_agent_report` action

**Files:**
- Modify: `center/src/services/audit-classifier.js` (3 frozen Maps: CATEGORY, SEVERITY, LABEL)

**Interfaces:**
- Produces: `classifyAction('request_agent_report')` returns `{ label: '请求 Agent 立即回报', category: 'changes', severity: 'low' }`.

- [ ] **Step 1: Write failing test for classifier mapping**

In `center/tests/services/audit-classifier.test.js` (or create it if missing — check first), add:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAction } from '../../src/services/audit-classifier.js';

test('classifyAction: request_agent_report is classified as changes/low/请求 Agent 立即回报', () => {
  const c = classifyAction('request_agent_report');
  assert.equal(c.category, 'changes');
  assert.equal(c.severity, 'low');
  assert.equal(c.label, '请求 Agent 立即回报');
});
```

- [ ] **Step 2: Run test; expect failure**

Run:
```bash
cd center && node --test tests/services/audit-classifier.test.js 2>&1 | tail -10
```

Expected: `AssertionError: expected 'ops' to be 'changes'` (default category).

- [ ] **Step 3: Add `request_agent_report` to all three frozen Maps in `audit-classifier.js`**

In `center/src/services/audit-classifier.js`:
- Append `['request_agent_report', 'changes']` to `ACTION_CATEGORY` (line 5-72).
- Append `['request_agent_report', 'low']` to `ACTION_SEVERITY` (line 74-139).
- Append `['request_agent_report', '请求 Agent 立即回报']` to `ACTION_LABEL` (line 141-201).

Place each after the existing `['revoke_user_tokens', ...]` entries (the last entries before closing) so the maps stay grouped logically.

- [ ] **Step 4: Re-run classifier test; expect pass**

Run:
```bash
cd center && node --test tests/services/audit-classifier.test.js 2>&1 | tail -10
```

Expected: pass.

- [ ] **Step 5: Run full backend suite (no regression in any other audit-using test)**

Run:
```bash
cd center && npm test 2>&1 | tail -10
```

Expected: no regression.

- [ ] **Step 6: Commit**

```bash
git add center/src/services/audit-classifier.js center/tests/services/audit-classifier.test.js
git commit -m "feat(center): round-12 — audit classifier entry for request_agent_report"
```

---

## Task 5 — Backend route: `POST /api/admin/agents/:agentId/request-report`

**Files:**
- Modify: `center/src/routes/heartbeat-report.js` (add the new endpoint to the existing router)
- Test: `center/tests/routes/heartbeat-report-request-report.test.js` (new file)

**Interfaces:**
- Produces: `POST /api/admin/agents/:agentId/request-report` — auth = `requireAuth + requirePerm('admin:users')`. Calls `heartbeatReportService.requestReport(agentId, { db })`. Writes audit log `request_agent_report` with `targetType: 'agent'`, `targetId: agentId`, `details: { requestedAt, alreadyPending }`. Returns 200 `{ ok, agentId, requestedAt, alreadyPending }`. 404 `{ error: 'agent_not_found' }` when `AgentNotFoundError` thrown. 500 on other errors.

- [ ] **Step 1: Write failing route test**

Create `center/tests/routes/heartbeat-report-request-report.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { heartbeatReportRouter } from '../../src/routes/heartbeat-report.js';
import { signJwt } from '../../src/auth/jwt.js';
import { buildMockDb } from '../helpers/db-mock.js';

const SECRET = 'test-secret';

function adminToken() {
  return signJwt({ sub: 'admin-1', role: 'admin', permissions: ['*'] }, SECRET, 60);
}

function operatorToken() {
  return signJwt({ sub: 'op-1', role: 'operator', permissions: ['dashboard:view'] }, SECRET, 60);
}

function buildApp(db) {
  const a = express();
  a.use(express.json());
  const config = { jwtSecret: SECRET };
  const logger = { info(){}, error(){}, warn(){}, debug(){} };
  const requireAuth = (req, res, next) => {
    // Skip auth for tests that don't set Authorization header — they expect 401.
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ error: 'unauthorized' });
    try {
      const token = auth.replace(/^Bearer\s+/, '');
      const jwt = require('jsonwebtoken');
      req.user = jwt.verify(token, SECRET);
      next();
    } catch (e) {
      res.status(401).json({ error: 'unauthorized' });
    }
  };
  const requirePerm = (perm) => (req, res, next) => {
    const perms = req.user?.permissions ?? [];
    if (!perms.includes('*') && !perms.includes(perm)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
  a.use(heartbeatReportRouter({ requireAuth, requirePerm, config, logger, db }));
  return a;
}

test('POST request-report returns 200 for admin', async () => {
  const records = [];
  const db = buildMockDb([
    { match: /SELECT\s+1\s+FROM\s+ad_agent_heartbeat\s+WHERE\s+agent_id\s*=\s*\?/i,
      rows: [{ '1': 1 }] },
    { match: /SELECT\s+report_requested_at\s+FROM\s+ad_agent_heartbeat\s+WHERE\s+agent_id\s*=\s*\?/i,
      rows: [{ report_requested_at: null }] },
    { match: /INSERT\s+INTO\s+ad_agent_heartbeat/i, rows: [] }
  ]).withRecording(records);

  const r = await supertest(buildApp(db))
    .post('/api/admin/agents/KDLWXOFADSRV1/request-report')
    .set('Authorization', `Bearer ${adminToken()}`);

  assert.equal(r.status, 200);
  assert.equal(r.body.agentId, 'KDLWXOFADSRV1');
  assert.ok(r.body.requestedAt);
  assert.equal(r.body.alreadyPending, false);
  // Audit row was written
  const audits = records.filter(x => /audit/i.test(x.sql));
  assert.ok(audits.length >= 1, 'audit row expected');
});

test('POST request-report returns 403 for operator', async () => {
  const db = buildMockDb([]).standard();
  const r = await supertest(buildApp(db))
    .post('/api/admin/agents/KDLWXOFADSRV1/request-report')
    .set('Authorization', `Bearer ${operatorToken()}`);
  assert.equal(r.status, 403);
});

test('POST request-report returns 401 without auth', async () => {
  const db = buildMockDb([]).standard();
  const r = await supertest(buildApp(db))
    .post('/api/admin/agents/KDLWXOFADSRV1/request-report');
  assert.equal(r.status, 401);
});

test('POST request-report returns 404 for unknown agent', async () => {
  const db = buildMockDb([
    { match: /SELECT\s+1\s+FROM\s+ad_agent_heartbeat\s+WHERE\s+agent_id\s*=\s*\?/i,
      rows: [] }
  ]).standard();
  const r = await supertest(buildApp(db))
    .post('/api/admin/agents/unknown-agent/request-report')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'agent_not_found');
});
```

- [ ] **Step 2: Run tests; expect failures (route doesn't exist)**

Run:
```bash
cd center && node --test tests/routes/heartbeat-report-request-report.test.js 2>&1 | tail -15
```

Expected: 404 from supertest (no such route).

- [ ] **Step 3: Add the route to `center/src/routes/heartbeat-report.js`**

Append after the existing `r.get('/api/admin/heartbeat-report/agents/:agentId/report-detail', ...)` block (around line 51-59). The existing factory signature is `{ requireAuth, requirePerm }` — no `db` needed because the service handles it via `getDb()`. Add the `writeAudit` import:

```javascript
import { writeAudit } from '../services/audit.js';
```

Then inside the factory, after the existing routes:

```javascript
r.post('/api/admin/agents/:agentId/request-report', ...auth, async (req, res) => {
  try {
    const { agentId } = req.params;
    const out = await heartbeatReportService.requestReport(agentId);
    await writeAudit({
      action: 'request_agent_report',
      target: `agent:${agentId}`,
      payload: { requestedAt: out.requestedAt.toISOString(), alreadyPending: out.alreadyPending },
      userId: req.user?.sub ?? null
    }, req.log);
    res.json({
      ok: true,
      agentId,
      requestedAt: out.requestedAt.toISOString(),
      alreadyPending: out.alreadyPending
    });
  } catch (e) {
    if (e.code === 'AGENT_NOT_FOUND') {
      return res.status(404).json({ error: 'agent_not_found' });
    }
    req.log?.error?.({ err: e.message }, 'request-report failed');
    res.status(500).json({ error: 'internal' });
  }
});
```

Note: `writeAudit` signature is `({ userId, action, target, payload }, logger, tx = null)` — uses `target` as a string (not targetType/targetId/details), uses `payload` for the details. The `target` for `request_agent_report` is the string `"agent:<agentId>"`. The audit-classifier's `TARGET_LABEL` map does not need an entry for `agent` — that map is for the audit log filter UI; any unlisted target string falls back to the raw target name in the filter dropdown.

- [ ] **Step 4: Re-run route tests; expect pass**

Run:
```bash
cd center && node --test tests/routes/heartbeat-report-request-report.test.js 2>&1 | tail -10
```

Expected: 4 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add center/src/routes/heartbeat-report.js center/tests/routes/heartbeat-report-request-report.test.js
git commit -m "feat(center): round-12 — POST /api/admin/agents/:id/request-report"
```

---

## Task 6 — Center heartbeat handler: response carries `reportRequested` + UPSERT honors clear

**Files:**
- Modify: `center/src/routes/agent.js` (heartbeat POST handler)
- Test: `center/tests/agent.test.js` (extend the existing heartbeat POST tests — `center/tests/agent.test.js` covers `POST /api/agent/heartbeat` already)

**Interfaces:**
- Produces: response body adds `reportRequested: boolean` — `true` when the row's `report_requested_at` is non-NULL.
- Produces: UPSERT honors `req.body.report_requested_at`:
  - Field absent → preserve existing column (existing agents unaffected).
  - Field present and `null` → clear the column.
  - Field present and a Date string → set to that timestamp.
- The handler reads `report_requested_at` AFTER the upsert (so it reflects the post-write state) — wait, no: it should read BEFORE the upsert (because we want to know if there was a pending request for THIS agent). Read the current `agent.js` code at the heartbeat handler to confirm where the read happens. Likely flow:
  1. UPSERT the heartbeat row (with `report_requested_at` from body, possibly null to clear).
  2. SELECT the row to read current `report_requested_at` AND `agent_token_version`.
  3. Compute `reportRequested = !!row.report_requested_at`.
  4. Attach to response.

- [ ] **Step 1: Write failing tests for response and UPSERT**

In `center/tests/agent.test.js`, add tests after the existing heartbeat tests:

```javascript
test('POST /api/agent/heartbeat: response carries reportRequested: true when flag is set', async () => {
  const records = [];
  const app = buildApp({
    agentTokenValue: 'tok',
    records,
    extraScripts: [
      // First the UPSERT (INSERT ... ON DUPLICATE KEY UPDATE)
      { match: /INSERT\s+INTO\s+ad_agent_heartbeat/i, rows: [] },
      // Then the read-back SELECT that fetches the row's current state.
      // The route queries report_requested_at after the upsert; mock its
      // SELECT to return a non-null timestamp so the response includes
      // reportRequested: true.
      { match: /SELECT.*FROM\s+ad_agent_heartbeat\s+WHERE\s+agent_id\s*=\s*\?/is,
        rows: [{
          agent_id: 'agent-1',
          agent_token_version: 0,
          report_requested_at: new Date('2026-08-24T10:00:00Z')
        }] }
    ]
  });

  const r = await supertest(app)
    .post('/api/agent/heartbeat')
    .set('X-Agent-Token', 'tok')
    .send({ agentId: 'agent-1', agentVersion: '1.0.0', pendingQueueSize: 0 });

  assert.equal(r.status, 200);
  assert.equal(r.body.reportRequested, true);
});

test('POST /api/agent/heartbeat: response carries reportRequested: false when flag is null', async () => {
  const app = buildApp({
    agentTokenValue: 'tok',
    extraScripts: [
      { match: /INSERT\s+INTO\s+ad_agent_heartbeat/i, rows: [] },
      { match: /SELECT.*FROM\s+ad_agent_heartbeat\s+WHERE\s+agent_id\s*=\s*\?/is,
        rows: [{
          agent_id: 'agent-1',
          agent_token_version: 0,
          report_requested_at: null
        }] }
    ]
  });

  const r = await supertest(app)
    .post('/api/agent/heartbeat')
    .set('X-Agent-Token', 'tok')
    .send({ agentId: 'agent-1', agentVersion: '1.0.0', pendingQueueSize: 0 });

  assert.equal(r.status, 200);
  assert.equal(r.body.reportRequested, false);
});
```

Read the existing `agent.test.js` to confirm the read-back SELECT regex (the route's exact SQL — it may be a SELECT on multiple columns that includes `report_requested_at`). Adjust the regex above to match the real SELECT shape before running.

- [ ] **Step 2: Run tests; expect failure (response doesn't have reportRequested)**

Run:
```bash
cd center && node --test tests/agent.test.js 2>&1 | tail -10
```

Expected: `AssertionError: undefined !== true` (or similar — the new tests reference `reportRequested` which the handler doesn't yet return).

- [ ] **Step 3: Modify `center/src/routes/agent.js` heartbeat handler**

Read the current handler around line 34-120. Add `report_requested_at` to the body parsing, pass it to the UPSERT params, and add `reportRequested: !!row.report_requested_at` to the response. Specifically:

```javascript
// After parsing req.body fields, add:
const reportRequestedAt = (req.body.report_requested_at === null)
  ? null
  : (req.body.report_requested_at ? new Date(req.body.report_requested_at) : undefined);
// undefined = preserve (don't bind to UPSERT), null = clear, Date = set.

// Find the existing UPSERT params array — add reportRequestedAt as the new
// last positional param. The UPSERT SQL from Task 2 has 8 INSERT params and
// the same 8 mapped to UPDATE; bind them in order.

// After the SELECT that reads the row back, compute:
const reportRequested = row?.report_requested_at != null;

// In the res.json payload (around line 106 / line 120):
res.json({
  ok: true,
  accepted: ...,
  rejected: ...,
  ...(agentTokenDelivery || {}),
  reportRequested
});
```

- [ ] **Step 4: Re-run agent.test.js; expect pass**

Run:
```bash
cd center && node --test tests/agent.test.js 2>&1 | tail -10
```

Expected: all pass (existing + new).

- [ ] **Step 5: Commit**

```bash
git add center/src/routes/agent.js center/tests/agent.test.js
git commit -m "feat(center): round-12 — heartbeat response carries reportRequested flag"
```

---

## Task 7 — Agent heartbeat consumer: read `reportRequested`, call `_tick()`, arm clear

**Files:**
- Modify: `agent/agent.js` (startHeartbeat callback around line 204-234)
- Modify: `agent/src/reporter.js` (postHeartbeat — forward `report_requested_at` field)
- Test: `agent/tests/heartbeat-report-now.test.js` (new file)

**Interfaces:**
- Produces: `agent/agent.js` exposes the existing `scheduler` to its `startHeartbeat.send` callback via closure. After `applyAgentTokenDelivery`, inspect `r.data.reportRequested`; if true, `await scheduler._tick()` and arm `pendingReportRequestClear = true`. On the next `payload()` call, include `report_requested_at: null` if `pendingReportRequestClear` is set; reset to false.
- Produces: `agent/src/reporter.js` `postHeartbeat` already forwards the full `payload` as the request body — no change needed unless the field is being filtered. Verify by reading lines 91-98.

- [ ] **Step 1: Write failing agent test**

Create `agent/tests/heartbeat-report-now.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

// Mock the heavy agent deps; we test only the heartbeat send callback.
// Read agent/agent.js to understand the exact shape of startHeartbeat args.
// Pattern: import the startHeartbeat logic indirectly by re-creating the
// callback closure pattern from agent/agent.js:204-234 OR test through
// the public HTTP boundary with a stub reporter.

import http from 'node:http';

// Set up a local stub center that returns reportRequested: true.
let lastHeartbeatBody = null;
const stubCenter = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    lastHeartbeatBody = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      accepted: 0,
      rejected: 0,
      reportRequested: true
    }));
  });
});

await new Promise((resolve) => stubCenter.listen(0, resolve));
const port = stubCenter.address().port;

test('heartbeat send: reportRequested=true triggers scheduler._tick()', async () => {
  let tickCalled = 0;
  const fakeScheduler = { _tick: async () => { tickCalled++; } };

  // Import or recreate the send callback from agent.js.
  // The cleanest approach is to factor the callback out of agent.js into a
  // tiny helper module (e.g., agent/src/heartbeat-send.js) and unit-test
  // it here. Acceptable to inline a copy of the callback logic for the test.
  const sentPayloads = [];
  const send = makeSendCallback({
    postHeartbeat: async () => ({ ok: true, data: { reportRequested: true } }),
    applyAgentTokenDelivery: async () => {},
    scheduler: fakeScheduler,
    logger: { info(){}, warn(){}, error(){}, debug(){} }
  });

  await send({ agentId: 'agent-1', pendingQueueSize: 0 });

  assert.equal(tickCalled, 1);
});

test('heartbeat send: reportRequested=false does NOT call scheduler._tick()', async () => {
  let tickCalled = 0;
  const fakeScheduler = { _tick: async () => { tickCalled++; } };

  const send = makeSendCallback({
    postHeartbeat: async () => ({ ok: true, data: { reportRequested: false } }),
    applyAgentTokenDelivery: async () => {},
    scheduler: fakeScheduler,
    logger: { info(){}, warn(){}, error(){}, debug(){} }
  });

  await send({ agentId: 'agent-1', pendingQueueSize: 0 });

  assert.equal(tickCalled, 0);
});

test('heartbeat payload: after successful _tick, next payload carries report_requested_at: null', async () => {
  let pendingReportRequestClear = false;

  // First: trigger _tick via send.
  const send = makeSendCallback({
    postHeartbeat: async () => ({ ok: true, data: { reportRequested: true } }),
    applyAgentTokenDelivery: async () => {},
    scheduler: { _tick: async () => {} },
    logger: { info(){}, warn(){}, error(){}, debug(){} },
    getPendingClear: () => pendingReportRequestClear,
    setPendingClear: (v) => { pendingReportRequestClear = v; }
  });
  await send({ agentId: 'agent-1' });

  // Now: build a payload; expect report_requested_at: null and clear flag reset.
  const payload = makePayload({ getPendingClear: () => pendingReportRequestClear, setPendingClear: (v) => { pendingReportRequestClear = v; } })({ agentId: 'agent-1', pendingQueueSize: 0 });
  assert.equal(payload.report_requested_at, null);
  assert.equal(pendingReportRequestClear, false);
});
```

If you keep the callback inline in `agent.js`, define `makeSendCallback` and `makePayload` as small re-exports from a new file `agent/src/heartbeat-callbacks.js` and unit-test them. This keeps the agent code testable without spinning up the full agent runtime.

- [ ] **Step 2: Run tests; expect failure**

Run:
```bash
cd agent && node --test tests/heartbeat-report-now.test.js 2>&1 | tail -10
```

Expected: import error or assertion failure.

- [ ] **Step 3: Implement `agent/src/heartbeat-callbacks.js`**

Create `agent/src/heartbeat-callbacks.js`:

```javascript
// 2026-08-24 round-12: heartbeat send/payload callbacks that consume the
// center's reportRequested flag and arm a one-shot clear on the next
// heartbeat. Factored out of agent.js so they can be unit-tested in
// isolation without spinning up the full agent runtime.

export function makeSendCallback({ postHeartbeat, applyAgentTokenDelivery, scheduler, logger, getPendingClear, setPendingClear }) {
  return async function send(payload) {
    const r = await postHeartbeat(payload);
    await applyAgentTokenDelivery({ result: r, payload, logger });

    if (r && r.data && r.data.reportRequested === true) {
      try {
        await scheduler._tick();
        // Only clear on success — failed tick keeps the flag set, retry on next heartbeat.
        setPendingClear(true);
      } catch (e) {
        logger.warn({ err: e.message }, 'scheduler._tick() after reportRequested failed; flag stays set');
      }
    }
  };
}

export function makePayload({ getPendingClear, setPendingClear }) {
  return function payload(basePayload) {
    const p = { ...basePayload };
    if (getPendingClear()) {
      p.report_requested_at = null;
      setPendingClear(false);
    }
    return p;
  };
}
```

- [ ] **Step 4: Wire into `agent/agent.js`**

In `agent/agent.js` around line 204-234, replace the inline `payload`/`send` definitions with the new helpers. The pattern:

```javascript
import { makeSendCallback, makePayload } from './heartbeat-callbacks.js';

// ... existing setup of scheduler ...
const scheduler = createScheduler({...});

let pendingReportRequestClear = false;
const getPendingClear = () => pendingReportRequestClear;
const setPendingClear = (v) => { pendingReportRequestClear = v; };

const send = makeSendCallback({
  postHeartbeat: (payload) => postHeartbeat({...}),   // wrap to inject config
  applyAgentTokenDelivery: ({ result }) => applyAgentTokenDelivery({ result, config, configPath, logger }),
  scheduler,
  logger,
  getPendingClear,
  setPendingClear
});

const buildPayload = makePayload({ getPendingClear, setPendingClear });

const heartbeat = startHeartbeat({
  intervalMs: Math.max(1, config.heartbeatIntervalSeconds) * 1000,
  payload: () => {
    const base = {
      agentId: config.agentId,
      agentVersion: VERSION,
      pendingQueueSize: queue.count(),
      agent_token_version: Number(config.agentTokenVersion) || 0
    };
    if (Array.isArray(latestPortResults) && latestPortResults.length > 0) {
      base.ports = latestPortResults.map(x => ({ port: x.port, ok: x.ok, latencyMs: x.latencyMs }));
    }
    base.packages = {
      installed: packageManager.listLocal(),
      pending: packageManager.reportBatch.length + packageManager.queue.length
    };
    return buildPayload(base);
  },
  send
});
```

- [ ] **Step 5: Re-run agent tests; expect pass**

Run:
```bash
cd agent && node --test tests/heartbeat-report-now.test.js 2>&1 | tail -10
```

Expected: all pass.

- [ ] **Step 6: Run full agent suite for regression**

Run:
```bash
cd agent && node --test tests/ 2>&1 | tail -10
```

Expected: 134 + new tests pass.

- [ ] **Step 7: Commit**

```bash
git add agent/agent.js agent/src/heartbeat-callbacks.js agent/tests/heartbeat-report-now.test.js
git commit -m "feat(agent): round-12 — heartbeat consumes reportRequested, arms one-shot clear"
```

---

## Task 8 — Frontend: API client + heartbeat table button + tooltip

**Files:**
- Modify: `center/web/src/api/heartbeatReport.js` (add `requestReport(agentId)`)
- Modify: `center/web/src/views/admin/HeartbeatReportMonitorView.vue` (add 操作 column + button + tooltip)
- Modify: `center/web/src/views/admin/HeartbeatReportMonitorView.spec.js` (extend — find or create)
- Build: `center/web` (run `npm run build:web` to update `publish/system/center/web/dist/`)

**Interfaces:**
- Produces: `heartbeatReport.requestReport(agentId): Promise<{ ok, agentId, requestedAt, alreadyPending }>` — POST `/api/admin/agents/${agentId}/request-report`.
- Produces: `HeartbeatReportMonitorView.vue` heartbeat table renders a new "操作" column (rightmost). For each agent row:
  - Button label: "回报" (enabled), "已请求回报" (disabled when `reportRequestedAt && age < 24h`), "回报(待清理)" (enabled when `reportRequestedAt && age >= 24h`).
  - Disabled when `stale` (existing offline detection) — tooltip "agent 离线;无法回报".
  - Disabled when `pending` (already requested) — tooltip "已请求回报 {since-ago};等待 agent 下一次心跳".
  - Click → confirm modal "立即向 {agentId} 触发数据回报?" → on confirm, call `requestReport(agentId)` → on success toast "已请求 {agentId} 回报" → on 404 toast "{agentId} 不存在,请先安装 agent".
  - Loading state during POST: label "请求中…", disabled.

- [ ] **Step 1: Write failing frontend test**

In `center/web/src/views/admin/HeartbeatReportMonitorView.spec.js` (create if missing), add:

```javascript
import { mount } from '@vue/test-utils';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import HeartbeatReportMonitorView from './HeartbeatReportMonitorView.vue';

vi.mock('@/api/heartbeatReport', () => ({
  listAgents: vi.fn().mockResolvedValue({
    staleThresholdSeconds: 15,
    agents: [
      { agentId: 'agent-online', lastHeartbeatAt: new Date().toISOString(), reportRequestedAt: null, lastReportStatus: null },
      { agentId: 'agent-pending', lastHeartbeatAt: new Date().toISOString(), reportRequestedAt: new Date().toISOString(), lastReportStatus: null },
      { agentId: 'agent-offline', lastHeartbeatAt: new Date(Date.now() - 60000).toISOString(), reportRequestedAt: null, lastReportStatus: null }
    ]
  }),
  listDcs: vi.fn().mockResolvedValue({ rows: [] }),
  requestReport: vi.fn().mockResolvedValue({ ok: true, agentId: 'agent-online', requestedAt: new Date().toISOString(), alreadyPending: false })
}));

describe('HeartbeatReportMonitorView', () => {
  it('renders 回报 button for each agent', async () => {
    const w = mount(HeartbeatReportMonitorView, { global: { stubs: ['router-link', 'router-view'] } });
    await new Promise(r => setTimeout(r, 50));
    const buttons = w.findAll('button[data-test="request-report"]');
    expect(buttons.length).toBe(3);
  });

  it('disables button when reportRequestedAt is set', async () => {
    const w = mount(HeartbeatReportMonitorView, { global: { stubs: ['router-link', 'router-view'] } });
    await new Promise(r => setTimeout(r, 50));
    const pendingBtn = w.findAll('[data-agent="agent-pending"] button[data-test="request-report"]')[0];
    expect(pendingBtn.attributes('disabled')).toBeDefined();
    expect(pendingBtn.text()).toContain('已请求回报');
  });

  it('disables button when agent is offline (stale)', async () => {
    const w = mount(HeartbeatReportMonitorView, { global: { stubs: ['router-link', 'router-view'] } });
    await new Promise(r => setTimeout(r, 50));
    const offlineBtn = w.findAll('[data-agent="agent-offline"] button[data-test="request-report"]')[0];
    expect(offlineBtn.attributes('disabled')).toBeDefined();
  });

  it('clicking enabled button calls requestReport API', async () => {
    const w = mount(HeartbeatReportMonitorView, { global: { stubs: ['router-link', 'router-view'] } });
    await new Promise(r => setTimeout(r, 50));
    const btn = w.findAll('[data-agent="agent-online"] button[data-test="request-report"]')[0];
    await btn.trigger('click');
    // Confirm modal flow — read HeartbeatReportMonitorView.vue to know the
    // exact selector for the confirm button.
    const confirmBtn = w.find('[data-test="confirm-request-report"]');
    if (confirmBtn.exists()) await confirmBtn.trigger('click');
    const { requestReport } = await import('@/api/heartbeatReport');
    expect(requestReport).toHaveBeenCalledWith('agent-online');
  });
});
```

- [ ] **Step 2: Run frontend tests; expect failure**

Run:
```bash
cd center/web && npx vitest run src/views/admin/HeartbeatReportMonitorView.spec.js 2>&1 | tail -15
```

Expected: failures (button doesn't exist).

- [ ] **Step 3: Add `requestReport` API client in `center/web/src/api/heartbeatReport.js`**

```javascript
import request from '@/utils/request';

export async function listAgents() {
  const r = await request.get('/api/admin/heartbeat-report/agents');
  return r.data;
}

export async function listDcs() {
  const r = await request.get('/api/admin/heartbeat-report/dcs');
  return r.data;
}

export async function requestReport(agentId) {
  const r = await request.post(`/api/admin/agents/${encodeURIComponent(agentId)}/request-report`);
  return r.data;
}
```

(Adjust the import path of `request` to match existing patterns — read the file first.)

- [ ] **Step 4: Modify `HeartbeatReportMonitorView.vue`**

Read the file (center/web/src/views/admin/HeartbeatReportMonitorView.vue lines 38-48 for the heartbeat table row). Add:

1. An `<th>操作</th>` column header.
2. For each row, a `<td>` containing the button:
   ```vue
   <td>
     <button
       :data-test="'request-report'"
       :data-agent="row.agentId"
       :disabled="isReportButtonDisabled(row)"
       :title="getReportButtonTooltip(row)"
       @click="onRequestReport(row)"
     >
       {{ getReportButtonLabel(row) }}
     </button>
   </td>
   ```
3. In `<script setup>`, add:
   - `function isStale(row): boolean` — uses existing stale logic from the file.
   - `function isReportPending(row): boolean` — `!!row.reportRequestedAt && age < 24h`.
   - `function isReportStale(row): boolean` — `!!row.reportRequestedAt && age >= 24h`.
   - `function getReportButtonLabel(row): string` — '已请求回报' if pending, '回报(待清理)' if stale, else '回报'.
   - `function getReportButtonTooltip(row): string` — see spec.
   - `function isReportButtonDisabled(row): boolean` — `isStale(row) || isReportPending(row)`.
   - `async function onRequestReport(row)` — show confirm modal (use existing modal component if any), then `await requestReport(row.agentId)`, then toast.

4. Confirm modal: if the existing view already has a modal pattern, reuse it. If not, use a minimal inline confirm (`window.confirm` is acceptable for v1).

- [ ] **Step 5: Re-run frontend tests; expect pass**

Run:
```bash
cd center/web && npx vitest run src/views/admin/HeartbeatReportMonitorView.spec.js 2>&1 | tail -10
```

Expected: all pass.

- [ ] **Step 6: Run full web test suite for regression**

Run:
```bash
cd center/web && npx vitest run 2>&1 | tail -10
```

Expected: no regression.

- [ ] **Step 7: Build the frontend**

Run:
```bash
cd center && npm run build:web 2>&1 | tail -10
```

Expected: build succeeds; `center/web/dist/` updated.

- [ ] **Step 8: Mirror dist to `publish/system/center/web/dist/`**

```bash
cp -r center/web/dist/* publish/system/center/web/dist/
```

(Note: if there's an existing mirror script — check `scripts/sync-dist.ps1` or similar — prefer that. Confirm `publish/system/center/web/dist/` mirrors `center/web/dist/` byte-for-byte.)

- [ ] **Step 9: Commit**

```bash
git add center/web/src/api/heartbeatReport.js center/web/src/views/admin/HeartbeatReportMonitorView.vue center/web/src/views/admin/HeartbeatReportMonitorView.spec.js center/web/dist publish/system/center/web/dist
git commit -m "feat(web): round-12 — heartbeat table 回报 button + tooltip"
```

---

## Task 9 — Whole-branch verification

**Files:** none modified; verification only.

- [ ] **Step 1: Run full backend test suite**

```bash
cd center && npm test 2>&1 | tail -10
```

Expected: all tests pass (1079 + new tests, 68 skipped, 0 fail).

- [ ] **Step 2: Run full agent test suite**

```bash
cd agent && node --test tests/ 2>&1 | tail -10
```

Expected: 134 + new tests pass.

- [ ] **Step 3: Run frontend tests**

```bash
cd center/web && npx vitest run 2>&1 | tail -10
```

Expected: all pass.

- [ ] **Step 4: Run mirror diff assert**

```bash
diff -q center/src/db/sql.js publish/system/center/src/db/sql.js
diff -rq center/web/dist publish/system/center/web/dist
```

Expected: no output.

- [ ] **Step 5: Restart center and verify the new endpoint manually**

```bash
# Stop dev center
# (Follow the restart pattern: TCP probe → Stop-Process → npm start bg → curl /healthz)
# After restart:
curl -X POST http://localhost:PORT/api/admin/agents/KDLWXOFADSRV1/request-report \
  -H "Authorization: Bearer ${ADMIN_JWT}" \
  -H "Content-Type: application/json"
```

Expected: 200 with `{ ok: true, agentId, requestedAt, alreadyPending }`.

- [ ] **Step 6: Update progress memory**

Append to `C:\Users\徐鹏\.claude\projects\D--ToolDevelop-ADDashboard\memory\progress_2026_08_24.md` (or create new file `progress_2026_08_24_round12.md`):

```markdown
## Round-12 — heartbeat "report now" button

### 触发
- 用户要求:心跳视图每行右侧加"回报"按钮;agent 端在心跳期间查看是否有回报要求,有则立即执行

### 设计
- 复用现有 `POST /api/agent/heartbeat` 响应体作为命令通道(单 bit `reportRequested`),不开新长连接
- 新列 `ad_agent_heartbeat.report_requested_at` (MySQL + MSSQL 双 migration 018)
- 新 endpoint `POST /api/admin/agents/:agentId/request-report` (admin:users)
- agent `send` 回调读 flag → 调 `scheduler._tick()`;成功后下一次心跳 body 携带 `report_requested_at: null` 清 flag
- UI 仅心跳表加按钮;离线禁用;已请求禁用 + tooltip 显示等待时长;24h 阈值兜底
- audit log `request_agent_report` (changes/low)
- 向后兼容:旧 agent 不读响应里的 `reportRequested`(flag 持续,operator 重试);新 agent UPSERT 用 COALESCE/ISNULL 保护列不被旧 body 误清

### 实现
- 9 task (db → sql → service → audit → route → heartbeat handler → agent consumer → frontend → verify)
- backend tests: 新增 service + route + heartbeat handler tests;sql real-DB 新增 requestReport / upsert preserve tests
- agent tests: 新增 heartbeat-report-now.test.js (回调单元测试,拆出 heartbeat-callbacks.js)
- frontend tests: HeartbeatReportMonitorView 新 button + tooltip + 4 个 case

### 新教训
- "中心 → agent 命令" 最便宜的做法 = 复用现有心跳响应体,不用 WebSocket/SSE;agent 端 read response body 这一行代码扩展性远超开新通道
- `COALESCE(?, column)` / `ISNULL(@p, column)` 是"参数缺省则保留"的标准 SQL idiom;UPSERT 接收可选清 flag 字段用它
- 新 endpoint 的 service 拆出来后,单元测试用 `buildMockDb` mock 三段 SQL(SELECT 1 检测存在 / SELECT 检测已 pending / INSERT)即可,不需要真实数据库
```

- [ ] **Step 7: Commit memory**

```bash
# Memory file may be outside the repo (under ~/.claude/projects/...). Update it directly without committing if so.
```

- [ ] **Step 8: Push to origin/main**

```bash
git push origin main
```

Expected: 10 commits land on origin/main (round-12 + 9 task commits; possibly fewer if tasks are combined).

---

## Verification

After all 9 tasks:
1. `npm test` in `center/` is green; new tests added for service + route + heartbeat handler + SQL helpers.
2. `node --test` in `agent/` is green; new tests for heartbeat-report-now callback.
3. `npx vitest run` in `center/web/` is green; new tests for the button + tooltip.
4. Manual verify: click 回报 on a real agent → see "已请求回报" → wait ≤ heartbeatIntervalSeconds → see button return to "回报".
5. `publish/system/` mirror is in sync with `center/`.

## Critical Files

- `center/src/routes/heartbeat-report.js` — add the new POST endpoint
- `center/src/routes/agent.js` — heartbeat POST handler carries `reportRequested`
- `center/src/db/sql.js` — `heartbeat.requestReport`, extended `upsert`, list queries
- `center/src/services/heartbeat-report.js` — `requestReport()` service
- `agent/agent.js` — wire `reportRequested` into the heartbeat send callback
- `agent/src/heartbeat-callbacks.js` — new module housing the send/payload callbacks (testable)
- `center/web/src/views/admin/HeartbeatReportMonitorView.vue` — button + tooltip

## Risks

1. **scheduler._tick() concurrent with scheduled tick**: both share the same `queue` instance in `agent/src/scheduler.js`; an in-flight scheduled tick holds the queue lock briefly, an operator-triggered `_tick` waits via the same queue mechanism. No data corruption possible.
2. **Agent restart between click and clear**: `pendingReportRequestClear` is in-memory; on restart, it's lost. The DB column still has the flag → agent picks it up again on next heartbeat → runs `_tick` → re-arms clear. Self-healing.
3. **Agent version skew**: older agent ignores `reportRequested` → flag persists. UI 24h threshold re-enables button. Operator upgrade closes the gap.
4. **Hot-update via `start.ps1`**: when operator pushes a code update, the new heartbeat-callbacks.js ships with the bundle. No restart needed for the new code path to take effect on agents (they re-import on start). Older agents keep ignoring `reportRequested` until they restart into the new bundle.
5. **Build size**: `center/web/dist/` gains ~2KB (button + tooltip strings). Negligible.
