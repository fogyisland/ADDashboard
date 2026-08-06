# Lockout Troubleshooting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `/lockout-troubleshooting` placeholder with a real diagnostic view that answers "which DC first locked user X", "who is making the bad attempts", and "what is the full timeline" — by collecting Windows Security event 4740 from every DC every 15 minutes and presenting a unified search across three composable filters (locked user / DC / caller computer).

**Architecture:** Extend `collect-replication.ps1` with a `Get-LockoutEvents` block that reads the last 15 minutes of 4740 events from the local Security log and adds them as a top-level `LockoutEvents` field on the snapshot JSON. The existing Node.js agent wrapper carries `LockoutEvents` through as a sibling to `data` (replication entries). The existing `/api/agent/report` center route is extended to also persist `lockoutEvents` into a new `ad_lockout_events` table (UNIQUE(dc_name, event_record_id) for server-side dedup). A new `GET /api/lockout-events/search` route accepts three optional filters + a time window. Frontend replaces `LockoutPlaceholderView` with `LockoutTroubleshootingView` that hosts a multi-filter form, a result timeline with "isSource" highlight on the first row when only targetUser is set, and click-to-drill-down badges.

**Tech Stack:** Vue 3 + script setup + Pinia + vue-router (frontend), Node.js + Express + mysql2/mssql + supertest (center), Node.js + PowerShell 5.1 (agent).

## Global Constraints

- **Single storage path extension.** Lockout event data lives in a new `ad_lockout_events` table on the existing center. No new agent-side collector, no new scheduler, no new dispatch machinery — the existing 15-min cycle POSTs both replication topology and lockout events in one JSON payload.
- **Agent statelessness.** The agent reads only the last 15 minutes of events each cycle (the lookback window equals the polling interval — if the polling interval changes, the lookback must change with it, defined as the same `pollingIntervalMinutes` config value). Server-side UNIQUE(dc_name, event_record_id) guarantees idempotency — agent restarts, clock drift, or duplicate windows cannot cause duplicate rows.
- **Per-block fault isolation (agent).** A failure in `Get-LockoutEvents` must not poison the replication payload. The new block is wrapped in `try { ... } catch { $null }` matching the pattern established for the existing 4 card counters in `Get-DcCounters`.
- **DB / API / backend / audit continue to use snake_case.** UI shows Chinese labels as primary caption, raw keys underneath (same pattern as commit `e04cc40` for system config and commit `6b990b9` for DcCard).
- **Drill-down via query string, not nested routes.** All three filter dimensions compose in a single URL. Clicking a DC badge sets `?dc=...` and re-fetches — no `/lockout-troubleshooting/dc/...` route.
- **"源头" highlight only when the search is unambiguously about a single user.** When only `targetUser` is set, the earliest row in the result set is the source DC (before replication propagation). When `dc` or `caller` is also set, "source" semantics no longer apply, so no row gets the highlight.
- **Read-only view.** No unlock action. Admins run `Unlock-ADAccount` manually after diagnosing.
- **All existing tests stay green.** No regressions in agent / center / frontend suites. The `frontend/tests/lockout-placeholder.test.js` (Task 8 of dc-card-overview) is deleted in Task 8 of this plan — the placeholder view is gone.
- **PowerShell scripts must remain PS 5.1 + pwsh 7+ dual-compatible** (no pwsh-only syntax).
- **publish/ mirror every changed source file per project convention.** Rebuild frontend dist + publish.zip in the final task.

---

## File map

### Agent (1 modified, 1 extended test)
- Modify `agent/scripts/collect-replication.ps1` — add `Get-LockoutEvents` + append `LockoutEvents` field to snapshot
- Extend `agent/tests/collect-replication.test.js` — 4 new structural tests for `Get-LockoutEvents` block

### Center (1 migration pair, 1 modified sql.js, 1 modified route, 1 new route, 2 new test files)
- Create `db/migrations/008-lockout-events.sql` (mysql)
- Create `db/migrations/mssql/008-lockout-events.sql` (mssql)
- Modify `center/src/db/sql.js` — add `lockout: { upsertEvent, search }` for both dialects
- Modify `center/src/routes/agent.js` — extend `/api/agent/report` to also persist `lockoutEvents`
- Create `center/src/routes/lockout.js` — `GET /api/lockout-events/search`
- Modify `center/server.js` — mount `lockoutRouter`
- Modify `center/tests/init/schema-applier.test.js` — 2 tests for migration 008
- Create `center/tests/lockout-search.test.js` — 6 tests for search API
- Modify `center/tests/agent-ingest.test.js` (or extend existing) — 1 test for lockoutEvents persistence

### Frontend (1 new view, 1 new api, 1 modified router, 1 deleted test)
- Create `frontend/src/api/lockout.js` — `searchLockoutEvents({ targetUser, dc, caller, sinceHours })`
- Replace `frontend/src/views/LockoutPlaceholderView.vue` → `frontend/src/views/LockoutTroubleshootingView.vue`
- Modify `frontend/src/router.js` — swap component import
- Create `frontend/tests/lockout-troubleshooting.test.js` — 4 tests
- Delete `frontend/tests/lockout-placeholder.test.js` — placeholder gone

### Publish mirror (Task 9)
- All modified source files mirrored under `publish/`
- `frontend/dist/` rebuilt and copied to `publish/dist/`
- `publish/publish.zip` regenerated

---

## Task 1: Migration 008 — create ad_lockout_events table

**Files:**
- Create: `db/migrations/008-lockout-events.sql` (mysql, 1 statement)
- Create: `db/migrations/mssql/008-lockout-events.sql` (mssql, 2 statements)
- Modify: `center/tests/init/schema-applier.test.js:178` — append 2 tests at end

**Interfaces:**
- Produces: new table `ad_lockout_events` with columns:
  - `id BIGINT AUTO_INCREMENT PRIMARY KEY`
  - `occurred_at DATETIME NOT NULL` (event TimeGenerated)
  - `collected_at DATETIME NOT NULL` (when center received it)
  - `agent_id VARCHAR(64) NOT NULL`
  - `dc_name VARCHAR(128) NOT NULL`
  - `event_record_id BIGINT NOT NULL` (Windows EventRecordID)
  - `target_user_name VARCHAR(256) NOT NULL`
  - `subject_user_name VARCHAR(256) NULL`
  - `subject_domain VARCHAR(256) NULL`
  - `caller_computer_name VARCHAR(256) NULL`
  - `UNIQUE KEY uq_lockout_dc_record (dc_name, event_record_id)`
  - `KEY ix_lockout_target_time (target_user_name, occurred_at)`
  - `KEY ix_lockout_caller_time (caller_computer_name, occurred_at)`
  - `KEY ix_lockout_dc_time (dc_name, occurred_at)`
  - `KEY ix_lockout_occurred (occurred_at)`

- [ ] **Step 1: Create MySQL migration file**

Create `db/migrations/008-lockout-events.sql`:

```sql
-- 008-lockout-events.sql
-- Lockout troubleshooting feature: persist Windows Security event 4740
-- (user account locked out) from every DC. Server-side dedup on
-- (dc_name, event_record_id) means the 15-min lookback can re-read the
-- same window without creating duplicates. The agent emits only the last
-- 15 minutes; the table grows ~10k events/year per DC at typical rates.
CREATE TABLE IF NOT EXISTS ad_lockout_events (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  occurred_at           DATETIME NOT NULL,
  collected_at          DATETIME NOT NULL,
  agent_id              VARCHAR(64)  NOT NULL,
  dc_name               VARCHAR(128) NOT NULL,
  event_record_id       BIGINT       NOT NULL,
  target_user_name      VARCHAR(256) NOT NULL,
  subject_user_name     VARCHAR(256) NULL,
  subject_domain        VARCHAR(256) NULL,
  caller_computer_name  VARCHAR(256) NULL,
  UNIQUE KEY uq_lockout_dc_record (dc_name, event_record_id),
  KEY ix_lockout_target_time (target_user_name, occurred_at),
  KEY ix_lockout_caller_time  (caller_computer_name, occurred_at),
  KEY ix_lockout_dc_time      (dc_name, occurred_at),
  KEY ix_lockout_occurred     (occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 2: Create MSSQL migration file (IF OBJECT_ID guard pattern)**

Create `db/migrations/mssql/008-lockout-events.sql`:

```sql
-- 008-lockout-events.sql (MSSQL)
-- MSSQL doesn't support CREATE TABLE IF NOT EXISTS — use the project's
-- established IF OBJECT_ID guard pattern (same as db/schema/mssql/01-tables.sql).
IF OBJECT_ID('ad_lockout_events', 'U') IS NULL
BEGIN
  CREATE TABLE ad_lockout_events (
    id                    BIGINT IDENTITY(1,1) PRIMARY KEY,
    occurred_at           DATETIME2 NOT NULL,
    collected_at          DATETIME2 NOT NULL,
    agent_id              VARCHAR(64)  NOT NULL,
    dc_name               VARCHAR(128) NOT NULL,
    event_record_id       BIGINT       NOT NULL,
    target_user_name      VARCHAR(256) NOT NULL,
    subject_user_name     VARCHAR(256) NULL,
    subject_domain        VARCHAR(256) NULL,
    caller_computer_name  VARCHAR(256) NULL,
    CONSTRAINT uq_lockout_dc_record UNIQUE (dc_name, event_record_id)
  );
  CREATE INDEX ix_lockout_target_time ON ad_lockout_events (target_user_name, occurred_at);
  CREATE INDEX ix_lockout_caller_time  ON ad_lockout_events (caller_computer_name, occurred_at);
  CREATE INDEX ix_lockout_dc_time      ON ad_lockout_events (dc_name, occurred_at);
  CREATE INDEX ix_lockout_occurred     ON ad_lockout_events (occurred_at);
END;
```

- [ ] **Step 3: Write failing tests in schema-applier.test.js**

Append to `center/tests/init/schema-applier.test.js` (after the migration 007 tests):

```js
test('splitSqlStatements parses migration 008 mysql (1 CREATE TABLE)', () => {
  const sql = readFileSync(join(__dirname, '../../../db/migrations/008-lockout-events.sql'), 'utf8');
  const stmts = splitSqlStatements(sql);
  // MySQL: 1 CREATE TABLE statement
  assert.strictEqual(stmts.length, 1, `expected 1 statement, got ${stmts.length}: ${JSON.stringify(stmts)}`);
  assert.match(stmts[0], /CREATE TABLE IF NOT EXISTS ad_lockout_events/i);
  assert.match(stmts[0], /uq_lockout_dc_record/i);
  assert.match(stmts[0], /event_record_id\s+BIGINT/i);
  assert.match(stmts[0], /target_user_name/);
});

test('splitSqlStatements parses migration 008 mssql (1 guarded CREATE TABLE block)', () => {
  const sql = readFileSync(join(__dirname, '../../../db/migrations/mssql/008-lockout-events.sql'), 'utf8');
  const stmts = splitSqlStatements(sql);
  // MSSQL: IF OBJECT_ID guard wraps CREATE TABLE + CREATE INDEX statements
  // into 1 logical block. The parser keeps IF/BEGIN/END as a single statement.
  assert.strictEqual(stmts.length, 1, `expected 1 statement, got ${stmts.length}: ${JSON.stringify(stmts)}`);
  assert.match(stmts[0], /IF OBJECT_ID\('ad_lockout_events', 'U'\)/i);
  assert.match(stmts[0], /CREATE TABLE ad_lockout_events/i);
  assert.match(stmts[0], /event_record_id\s+BIGINT/i);
  // Verify the unique constraint and at least one index are inside the block
  assert.match(stmts[0], /uq_lockout_dc_record/i);
  assert.match(stmts[0], /CREATE INDEX ix_lockout_occurred/i);
});
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `cd center && npm test -- tests/init/schema-applier.test.js`
Expected: All tests pass including the 2 new ones (no failures, no regressions).

- [ ] **Step 5: Commit**

```bash
git add db/migrations/008-lockout-events.sql db/migrations/mssql/008-lockout-events.sql center/tests/init/schema-applier.test.js
git commit -m "feat(migration): 008 — create ad_lockout_events table"
```

---

## Task 2: Agent PS script — emit LockoutEvents field

**Files:**
- Modify: `agent/scripts/collect-replication.ps1` — add `Get-LockoutEvents` function + emit `LockoutEvents` field on snapshot
- Extend: `agent/tests/collect-replication.test.js` — 4 new structural tests

**Interfaces:**
- Produces: PS script that:
  - Declares `Get-LockoutEvents` function with `[CmdletBinding()] param([string]$ComputerName)` (param is unused inside the function body — kept for symmetry with `Get-DcCounters`; PS 5.1's `Get-WinEvent -FilterHashtable` form does not accept `-ComputerName`, and the agent runs locally on each DC).
  - Calls `Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4740; StartTime=(Get-Date).AddMinutes(-15)}` to read the last 15 minutes.
  - Wraps the whole block in `try { ... } catch { ... }` so a Security-log read failure returns `$null`/`@()` and the rest of the snapshot is unaffected.
  - Returns an array of PSCustomObjects with: `EventRecordId` (int64), `OccurredAt` (ISO string via `ConvertTo-UtcIso`), `TargetUserName`, `SubjectUserName`, `SubjectDomain`, `CallerComputerName` (all strings).
  - In `Get-ReplicationSnapshot`, before `$snapshot.Entries = $entries`, populates `$snapshot | Add-Member -NotePropertyName LockoutEvents -NotePropertyValue (Get-LockoutEvents -ComputerName $ComputerName)`.

- [ ] **Step 1: Write the 4 new structural tests**

Append to `agent/tests/collect-replication.test.js`:

```js
test('collect-replication.ps1 declares a Get-LockoutEvents function', () => {
  const src = readFileSync(psPath, 'utf8');
  assert.match(src, /function\s+Get-LockoutEvents\b/,
    'expected Get-LockoutEvents function definition');
});

test('Get-LockoutEvents uses Get-WinEvent -FilterHashtable Security Id=4740 with 15-min StartTime', () => {
  const src = readFileSync(psPath, 'utf8');
  // Must use FilterHashtable form (not -ComputerName form, which PS 5.1
  // Get-WinEvent rejects for -FilterHashtable).
  assert.match(src, /Get-WinEvent\s+-FilterHashtable\s+@\{/,
    'expected Get-WinEvent -FilterHashtable @{...}');
  assert.match(src, /LogName\s*=\s*'Security'/);
  assert.match(src, /Id\s*=\s*4740/);
  // The lookback window equals the polling interval (15 min default).
  // The literal AddMinutes(-15) is the canonical expression — if the
  // config moves, this expression must move with it.
  assert.match(src, /StartTime\s*=\s*\(Get-Date\)\.AddMinutes\(-15\)/,
    'expected StartTime = (Get-Date).AddMinutes(-15) — the lookback MUST match the polling interval');
});

test('Get-LockoutEvents block is wrapped in try/catch (per-block fault isolation)', () => {
  const src = readFileSync(psPath, 'utf8');
  // Find the Get-LockoutEvents function body and confirm it has a try/catch
  const fnMatch = src.match(/function\s+Get-LockoutEvents[\s\S]+?\n\}/);
  assert.ok(fnMatch, 'expected to find the Get-LockoutEvents function body');
  const body = fnMatch[0];
  assert.match(body, /\btry\s*\{/, 'expected a try block inside Get-LockoutEvents');
  assert.match(body, /\}\s*catch\s*\{/, 'expected a catch block');
  // The catch handler must write to stderr (matches Get-DcCounters pattern)
  assert.match(body, /\[Console\]::Error\.WriteLine/);
});

test('Get-ReplicationSnapshot adds a LockoutEvents NoteProperty before returning', () => {
  const src = readFileSync(psPath, 'utf8');
  // Inside Get-ReplicationSnapshot, must use Add-Member to attach LockoutEvents.
  assert.match(src, /Add-Member\s+-NotePropertyName\s+LockoutEvents/,
    'expected $snapshot | Add-Member -NotePropertyName LockoutEvents ...');
  assert.match(src, /LockoutEvents\s*=\s*\(?Get-LockoutEvents/,
    'expected LockoutEvents to be assigned from Get-LockoutEvents call');
});

test('each lockout event carries EventRecordId, OccurredAt, and the 4 user/computer fields', () => {
  const src = readFileSync(psPath, 'utf8');
  // Inside Get-LockoutEvents, the PSCustomObject hash must include all 6 fields.
  assert.match(src, /EventRecordId\s*=/);
  assert.match(src, /OccurredAt\s*=/);
  assert.match(src, /TargetUserName\s*=/);
  assert.match(src, /SubjectUserName\s*=/);
  assert.match(src, /SubjectDomain\s*=/);
  assert.match(src, /CallerComputerName\s*=/);
});
```

(That's 5 new tests — spec said 4, but the existing tests don't cover this surface area. Counting them as 5 keeps the total at 17 — acceptable over-delivery.)

- [ ] **Step 2: Run tests, expect FAIL**

Run: `cd agent && npm test -- tests/collect-replication.test.js`
Expected: FAIL on the 5 new tests (function missing, FilterHashtable missing, Add-Member missing).

- [ ] **Step 3: Add the `Get-LockoutEvents` function**

In `agent/scripts/collect-replication.ps1`, insert after the `Get-DcCounters` function (after line 89):

```powershell
function Get-LockoutEvents {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$ComputerName
  )

  # ComputerName is accepted for symmetry with Get-DcCounters but is
  # intentionally unused inside the function body: PS 5.1's
  # Get-WinEvent -FilterHashtable form does not accept -ComputerName
  # (only the non-Hashtable form does). The agent runs locally on each
  # DC, so reading the local Security log is sufficient. If remote
  # collection is added later, switch to
  # Get-WinEvent -ComputerName $ComputerName -FilterHashtable @{...}
  # on pwsh 7+ only.
  $events = @()
  try {
    $start = (Get-Date).AddMinutes(-15)
    $raw = Get-WinEvent -FilterHashtable @{
      LogName   = 'Security'
      Id        = 4740
      StartTime = $start
    } -ErrorAction Stop
    foreach ($e in $raw) {
      $xml = [xml]$e.ToXml()
      $ed  = $xml.Event.EventData
      $events += [PSCustomObject]@{
        EventRecordId      = [int64]$e.RecordId
        OccurredAt         = (ConvertTo-UtcIso -Value $e.TimeCreated)
        TargetUserName     = [string]$ed.Data[0].'#text'
        SubjectUserName    = [string]$ed.Data[1].'#text'
        SubjectDomain      = [string]$ed.Data[2].'#text'
        CallerComputerName = [string]$ed.Data[3].'#text'
      }
    }
  } catch {
    [Console]::Error.WriteLine("lockoutEvents failed: $($_.Exception.Message)")
  }
  # The comma operator forces PowerShell to emit the array even when empty
  # — without it, an empty $events collapses to $null on return.
  return ,$events
}
```

- [ ] **Step 4: Attach `LockoutEvents` to the snapshot in `Get-ReplicationSnapshot`**

In `Get-ReplicationSnapshot`, just before `$snapshot.Entries = $entries` (around line 197), insert:

```powershell
  # Lockout troubleshooting — append the last 15 min of Security event 4740
  # (user account locked out) from the local Security log. Travels as a
  # top-level snapshot field (not as an Entry, because these aren't
  # replication rows). The center's UNIQUE(dc_name, event_record_id) gives
  # us idempotent ingest — the agent is stateless across cycles.
  $snapshot | Add-Member -NotePropertyName LockoutEvents `
                        -NotePropertyValue (Get-LockoutEvents -ComputerName $ComputerName)
```

(Place this between the `$entries += $summaryEntry` line and `$snapshot.Entries = $entries`.)

- [ ] **Step 5: Run tests, expect PASS**

Run: `cd agent && npm test -- tests/collect-replication.test.js`
Expected: All 8 tests pass (3 original + 5 new).

- [ ] **Step 6: Run full agent suite to confirm no regressions**

Run: `cd agent && npm test`
Expected: 43 pre-existing + 5 new = 48 tests, all green.

- [ ] **Step 7: Commit**

```bash
git add agent/scripts/collect-replication.ps1 agent/tests/collect-replication.test.js
git commit -m "feat(agent): emit LockoutEvents field with last 15-min of Security 4740 events"
```

---

## Task 3: Center sql.js — add lockout.upsertEvent + lockout.search

**Files:**
- Modify: `center/src/db/sql.js` — add `lockout` block to both VARIANTS.mysql and VARIANTS.mssql

**Interfaces:**
- Produces:
  - `db.sql.lockout.upsertEvent` — binds 9 params. Inserts `(occurred_at, collected_at, agent_id, dc_name, event_record_id, target_user_name, subject_user_name, subject_domain, caller_computer_name)` and silently no-ops on UNIQUE collision (server-side dedup).
  - `db.sql.lockout.search` — binds 7 params: `(sinceTs, targetUser, targetUser, dc, dc, caller, caller)`. Returns rows of `(occurred_at, dc_name, target_user_name, subject_user_name, subject_domain, caller_computer_name)` filtered by `occurred_at >= sinceTs` and any of the 3 optional filter clauses (each clause is `? = '' OR col = ?` — when the placeholder is `''` (empty string), the filter is bypassed). Ordered by `occurred_at ASC`. LIMIT 500.

- [ ] **Step 1: Add MySQL `lockout` block**

In `center/src/db/sql.js`, inside `VARIANTS.mysql`, just before the closing `}` (after the `packageRuns` block at line 193), add:

```js
    lockout: {
      upsertEvent: `INSERT INTO ad_lockout_events
        (occurred_at, collected_at, agent_id, dc_name, event_record_id,
         target_user_name, subject_user_name, subject_domain, caller_computer_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE collected_at = VALUES(collected_at)`,
      search: `SELECT occurred_at, dc_name, target_user_name, subject_user_name,
                      subject_domain, caller_computer_name
                 FROM ad_lockout_events
                WHERE occurred_at >= ?
                  AND (? = '' OR target_user_name = ?)
                  AND (? = '' OR dc_name = ?)
                  AND (? = '' OR caller_computer_name = ?)
                ORDER BY occurred_at ASC
                LIMIT 500`
    }
```

- [ ] **Step 2: Add MSSQL `lockout` block**

In `center/src/db/sql.js`, inside `VARIANTS.mssql`, just before the closing `}` (after the `packageRuns` block at line 397), add:

```js
    lockout: {
      upsertEvent: `MERGE INTO ad_lockout_events AS t
        USING (SELECT
          ? AS occurred_at, ? AS collected_at, ? AS agent_id, ? AS dc_name, ? AS event_record_id,
          ? AS target_user_name, ? AS subject_user_name, ? AS subject_domain, ? AS caller_computer_name
        ) AS s
        ON t.dc_name = s.dc_name AND t.event_record_id = s.event_record_id
        WHEN MATCHED THEN UPDATE SET collected_at = s.collected_at
        WHEN NOT MATCHED THEN INSERT
          (occurred_at, collected_at, agent_id, dc_name, event_record_id,
           target_user_name, subject_user_name, subject_domain, caller_computer_name)
          VALUES
          (s.occurred_at, s.collected_at, s.agent_id, s.dc_name, s.event_record_id,
           s.target_user_name, s.subject_user_name, s.subject_domain, s.caller_computer_name)`,
      search: `SELECT TOP 500 occurred_at, dc_name, target_user_name, subject_user_name,
                      subject_domain, caller_computer_name
                 FROM ad_lockout_events
                WHERE occurred_at >= ?
                  AND (? = '' OR target_user_name = ?)
                  AND (? = '' OR dc_name = ?)
                  AND (? = '' OR caller_computer_name = ?)
                ORDER BY occurred_at ASC`
    }
```

- [ ] **Step 3: Verify the file parses by running an existing sql test**

Run: `cd center && npm test -- tests/replication-status-card.test.js`
Expected: PASS (no regression — the existing replication tests don't depend on lockout).

(No new sql-level tests in this task — the lockout SQL is exercised by Task 5's route tests through `_setDbForTest(buildMockDb(...))` pattern. The schema-applier tests in Task 1 verify the migrations parse; the SQL behavior is verified end-to-end via supertest in Task 5.)

- [ ] **Step 4: Run full center suite to confirm no regressions**

Run: `cd center && npm test`
Expected: 387 pre-existing tests, all green (no new tests added yet).

- [ ] **Step 5: Commit**

```bash
git add center/src/db/sql.js
git commit -m "feat(center): add lockout.upsertEvent + lockout.search SQL for both dialects"
```

---

## Task 4: Center ingest route — persist lockoutEvents payload

**Files:**
- Modify: `center/src/routes/agent.js` — extend `/api/agent/report` handler to also persist `lockoutEvents`
- Create: `center/tests/lockout-ingest.test.js` — 1 test for the ingest path

**Interfaces:**
- Produces: `/api/agent/report` accepts an optional `lockoutEvents` field (array) alongside the existing `data` field. For each event, calls `db.sql.lockout.upsertEvent` with `(occurredAt, collectedAt, agentId, dcName, eventRecordId, targetUserName, subjectUserName, subjectDomain, callerComputerName)`. Wrap each call in try/catch so a per-event failure logs a warning but doesn't fail the whole ingest.

- [ ] **Step 1: Write failing test**

Create `center/tests/lockout-ingest.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import supertest from 'supertest';
import { agentRouter } from '../src/routes/agent.js';
import { _setDbForTest } from '../src/db/index.js';
import { buildMockDb } from './helpers/db-mock.js';
import { signJwt } from '../src/auth/jwt.js';

const SECRET = 'test-secret';
function agentToken() { return signJwt({ sub: 'a1', role: 'agent' }, SECRET, 60); }

function buildApp() {
  const a = express();
  a.use(express.json());
  return a.use(agentRouter({
    config: { agentToken: 'test-token', jwtSecret: SECRET },
    logger: { info() {}, warn() {}, error() {}, debug() {} }
  }));
}

test('POST /api/agent/report persists lockoutEvents via db.sql.lockout.upsertEvent', async () => {
  const records = [];
  const db = buildMockDb().withRecording(records);
  // Pre-populate the data route so it doesn't blow up — replication data
  // can be empty array, but we still need the route to recognize it.
  _setDbForTest(db);

  const res = await supertest(buildApp())
    .post('/api/agent/report')
    .set('Authorization', `Bearer ${agentToken()}`)
    .send({
      agentId: 'DC01',
      collectedAt: '2026-08-06T10:00:00.000Z',
      data: [],
      lockoutEvents: [
        {
          eventRecordId: 12345678,
          occurredAt: '2026-08-06T09:45:00.000Z',
          targetUserName: 'alice',
          subjectUserName: 'DC01$',
          subjectDomain: 'CORP',
          callerComputerName: 'WS-DEV-42'
        },
        {
          eventRecordId: 12345679,
          occurredAt: '2026-08-06T09:50:00.000Z',
          targetUserName: 'alice',
          subjectUserName: 'DC01$',
          subjectDomain: 'CORP',
          callerComputerName: 'WS-DEV-42'
        }
      ]
    });

  assert.equal(res.status, 200);

  // Find the upsertEvent calls
  const upsertCalls = records.filter((r) => r.sql === db.sql.lockout.upsertEvent);
  assert.equal(upsertCalls.length, 2, `expected 2 upsertEvent calls, got ${upsertCalls.length}`);

  // First event: 9 params in the order [occurredAt, collectedAt, agentId, dcName,
  // eventRecordId, targetUserName, subjectUserName, subjectDomain, callerComputerName]
  const p0 = upsertCalls[0].params;
  assert.equal(p0.length, 9, `expected 9 params, got ${p0.length}`);
  assert.equal(p0[0], '2026-08-06T09:45:00.000Z');  // occurredAt
  assert.equal(p0[1], '2026-08-06T10:00:00.000Z');  // collectedAt (from payload.collectedAt)
  assert.equal(p0[2], 'DC01');                       // agentId
  assert.equal(p0[3], 'DC01');                       // dcName — falls back to agentId when not in payload
  assert.equal(p0[4], 12345678);                     // eventRecordId
  assert.equal(p0[5], 'alice');                      // targetUserName
  assert.equal(p0[6], 'DC01$');                      // subjectUserName
  assert.equal(p0[7], 'CORP');                       // subjectDomain
  assert.equal(p0[8], 'WS-DEV-42');                  // callerComputerName
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `cd center && npm test -- tests/lockout-ingest.test.js`
Expected: FAIL — lockoutEvents is silently ignored, so 0 upsertEvent calls.

- [ ] **Step 3: Extend the `/api/agent/report` handler in `center/src/routes/agent.js`**

In `center/src/routes/agent.js`, modify the existing `/api/agent/report` handler (lines 56-75). After the `await upsertStatus(...)` call and before the `await getAgentConfig()` call, add the lockoutEvents persistence:

```js
  // Lockout troubleshooting — persist Security event 4740 records from the
  // last 15 minutes on each DC. Server-side UNIQUE(dc_name, event_record_id)
  // gives us idempotent ingest; per-event failures are logged but don't fail
  // the whole snapshot.
  const lockoutEvents = Array.isArray(req.body?.lockoutEvents) ? req.body.lockoutEvents : [];
  if (lockoutEvents.length > 0) {
    const db = getDb();
    const dbc = toMysqlDatetime(collectedAt);
    const dcName = String(agentId);
    for (const ev of lockoutEvents) {
      try {
        await db.execute(db.sql.lockout.upsertEvent, [
          toMysqlDatetime(ev.occurredAt),
          dbc,
          String(agentId),
          dcName,
          Number(ev.eventRecordId),
          String(ev.targetUserName ?? ''),
          ev.subjectUserName != null ? String(ev.subjectUserName) : null,
          ev.subjectDomain != null ? String(ev.subjectDomain) : null,
          ev.callerComputerName != null ? String(ev.callerComputerName) : null
        ]);
      } catch (e) {
        req.log?.warn?.({ err: e.message, agentId, eventRecordId: ev.eventRecordId }, 'lockout event persist failed');
      }
    }
  }
```

(Insert immediately after the `await upsertStatus(...)` call; before the `const { pollingIntervalMinutes, ... }` destructure.)

- [ ] **Step 4: Run test, expect PASS**

Run: `cd center && npm test -- tests/lockout-ingest.test.js`
Expected: 1 test passes.

- [ ] **Step 5: Run full center suite to confirm no regressions**

Run: `cd center && npm test`
Expected: 387 pre-existing + 1 new = 388 tests, all green.

- [ ] **Step 6: Commit**

```bash
git add center/src/routes/agent.js center/tests/lockout-ingest.test.js
git commit -m "feat(center): persist lockoutEvents in /api/agent/report ingest"
```

---

## Task 5: Center lockout search route

**Files:**
- Create: `center/src/routes/lockout.js` — `GET /api/lockout-events/search`
- Modify: `center/server.js` — mount `lockoutRouter` next to `dcsRouter`
- Create: `center/tests/lockout-search.test.js` — 6 tests

**Interfaces:**
- Produces:
  - `GET /api/lockout-events/search?targetUser=X&dc=DC01&caller=WS01&sinceHours=24`
  - Validation:
    - At least one of `targetUser` / `dc` / `caller` must be non-empty → otherwise 400
    - `sinceHours` must be an integer in `[1, 168]` (1 hour to 7 days) → otherwise 400
  - Computes `sinceTs = NOW() - INTERVAL ? HOUR` (or the MSSQL equivalent `DATEADD(HOUR, -?, SYSUTCDATETIME())`)
  - Calls `db.sql.lockout.search` with 7 params: `[sinceTs, targetUser, targetUser, dc, dc, caller, caller]`. Empty-string params bypass their respective filter clauses.
  - Returns array of `{ occurredAt, dcName, targetUserName, subjectUserName, subjectDomain, callerComputerName, isSource }`. The `isSource` flag is computed in JS (not SQL): true only when (a) `targetUser` is set and (caller and dc are empty), and (b) this is the first row in the result. All other rows: `isSource: false`.
  - Auth: requires `admin:users` permission. Use the same `[userAuth, requirePerm('admin:users')]` middleware pattern as `dcsRouter`.

- [ ] **Step 1: Write failing tests**

Create `center/tests/lockout-search.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import supertest from 'supertest';
import { lockoutRouter } from '../src/routes/lockout.js';
import { userAuth } from '../src/auth/user-auth.js';
import { requirePerm } from '../src/auth/rbac.js';
import { signJwt } from '../src/auth/jwt.js';
import { _setDbForTest } from '../src/db/index.js';
import { buildMockDb } from './helpers/db-mock.js';

const SECRET = 'test-secret';
function adminToken() { return signJwt({ sub: 'u1', role: 'admin', permissions: ['*'] }, SECRET, 60); }

function buildApp() {
  const a = express();
  a.use(express.json());
  return a.use(
    lockoutRouter({
      requireAuth: userAuth({ secret: SECRET }),
      requirePerm
    })
  );
}

function pad(n) { return String(n).padStart(2, '0'); }
function isoAt(baseIso, addMinutes) {
  const d = new Date(baseIso);
  d.setUTCMinutes(d.getUTCMinutes() + addMinutes);
  return d.toISOString();
}

test('GET /api/lockout-events/search with targetUser returns rows sorted by occurred_at ASC and isSource on first row', async () => {
  const baseTime = '2026-08-06T10:00:00.000Z';
  const rows = [
    { occurred_at: isoAt(baseTime, 0),  dc_name: 'DC01', target_user_name: 'alice', subject_user_name: 'DC01$', subject_domain: 'CORP', caller_computer_name: 'WS-DEV-42' },
    { occurred_at: isoAt(baseTime, 10), dc_name: 'DC02', target_user_name: 'alice', subject_user_name: 'DC02$', subject_domain: 'CORP', caller_computer_name: 'WS-DEV-42' }
  ];
  _setDbForTest(buildMockDb([
    { match: /FROM\s+ad_lockout_events/is, rows }
  ]).standard());

  const res = await supertest(buildApp())
    .get('/api/lockout-events/search?targetUser=alice&sinceHours=24')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  // First row gets isSource=true (only targetUser set)
  assert.equal(res.body[0].isSource, true);
  assert.equal(res.body[0].dcName, 'DC01');
  assert.equal(res.body[0].targetUserName, 'alice');
  assert.equal(res.body[0].callerComputerName, 'WS-DEV-42');
  assert.equal(res.body[0].occurredAt, isoAt(baseTime, 0));
  // Second row isSource=false
  assert.equal(res.body[1].isSource, false);
  assert.equal(res.body[1].dcName, 'DC02');
});

test('GET /api/lockout-events/search with dc filter returns only matching dc rows and no isSource', async () => {
  const rows = [
    { occurred_at: '2026-08-06T10:00:00.000Z', dc_name: 'DC01', target_user_name: 'alice', subject_user_name: 'DC01$', subject_domain: 'CORP', caller_computer_name: 'WS-01' }
  ];
  _setDbForTest(buildMockDb([
    { match: /FROM\s+ad_lockout_events/is, rows }
  ]).standard());

  const res = await supertest(buildApp())
    .get('/api/lockout-events/search?targetUser=alice&dc=DC01&sinceHours=24')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  // dc is set → no row gets isSource (ambiguous which is earliest across DCs)
  assert.equal(res.body[0].isSource, false);
});

test('GET /api/lockout-events/search with caller filter returns only matching caller rows', async () => {
  const rows = [
    { occurred_at: '2026-08-06T10:00:00.000Z', dc_name: 'DC01', target_user_name: 'alice', subject_user_name: 'DC01$', subject_domain: 'CORP', caller_computer_name: 'WS-BAD' },
    { occurred_at: '2026-08-06T10:05:00.000Z', dc_name: 'DC02', target_user_name: 'alice', subject_user_name: 'DC02$', subject_domain: 'CORP', caller_computer_name: 'WS-OK' }
  ];
  _setDbForTest(buildMockDb([
    { match: /FROM\s+ad_lockout_events/is, rows }
  ]).standard());

  const res = await supertest(buildApp())
    .get('/api/lockout-events/search?targetUser=alice&caller=WS-BAD&sinceHours=24')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].callerComputerName, 'WS-BAD');
});

test('GET /api/lockout-events/search with all three filters returns intersection', async () => {
  const rows = [
    { occurred_at: '2026-08-06T10:00:00.000Z', dc_name: 'DC01', target_user_name: 'alice', subject_user_name: 'DC01$', subject_domain: 'CORP', caller_computer_name: 'WS-01' }
  ];
  _setDbForTest(buildMockDb([
    { match: /FROM\s+ad_lockout_events/is, rows }
  ]).standard());

  const res = await supertest(buildApp())
    .get('/api/lockout-events/search?targetUser=alice&dc=DC01&caller=WS-01&sinceHours=24')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].dcName, 'DC01');
  assert.equal(res.body[0].callerComputerName, 'WS-01');
});

test('GET /api/lockout-events/search with no filter dimension returns 400', async () => {
  _setDbForTest(buildMockDb().standard());
  const res = await supertest(buildApp())
    .get('/api/lockout-events/search?sinceHours=24')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /targetUser|dc|caller/i);
});

test('GET /api/lockout-events/search with sinceHours=999 returns 400', async () => {
  _setDbForTest(buildMockDb().standard());
  const res = await supertest(buildApp())
    .get('/api/lockout-events/search?targetUser=alice&sinceHours=999')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /sinceHours/i);
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `cd center && npm test -- tests/lockout-search.test.js`
Expected: FAIL — `lockoutRouter` doesn't exist yet.

- [ ] **Step 3: Create the route file**

Create `center/src/routes/lockout.js`:

```js
import { Router } from 'express';
import { getDb } from '../db/index.js';
import { toMysqlDatetime } from '../utils/datetime.js';

const MIN_SINCE_HOURS = 1;
const MAX_SINCE_HOURS = 168; // 7 days

export function lockoutRouter({ requireAuth, requirePerm }) {
  const r = Router();
  const auth = [requireAuth, requirePerm('admin:users')];

  r.get('/api/lockout-events/search', ...auth, async (req, res) => {
    try {
      const targetUser = String(req.query.targetUser ?? '').trim();
      const dc         = String(req.query.dc ?? '').trim();
      const caller     = String(req.query.caller ?? '').trim();
      const sinceHoursRaw = req.query.sinceHours;

      if (!targetUser && !dc && !caller) {
        return res.status(400).json({ error: 'at least one of targetUser/dc/caller is required' });
      }
      const sinceHours = Number(sinceHoursRaw);
      if (!Number.isInteger(sinceHours) || sinceHours < MIN_SINCE_HOURS || sinceHours > MAX_SINCE_HOURS) {
        return res.status(400).json({
          error: `sinceHours must be an integer in [${MIN_SINCE_HOURS}, ${MAX_SINCE_HOURS}]`
        });
      }

      const db = getDb();
      // Compute the since-timestamp in JS (using the same helper the rest of
      // the app uses for DATETIME columns). Pass it as the first bind param.
      const since = new Date(Date.now() - sinceHours * 3600_000);
      const sinceTs = toMysqlDatetime(since);

      const dbRes = await db.query(db.sql.lockout.search, [
        sinceTs,
        targetUser, targetUser,
        dc,         dc,
        caller,     caller
      ]);

      // isSource is computed in JS, not SQL: it's true only when (a) the
      // query was unambiguously about a single user (no dc, no caller
      // filters), and (b) this is the first row in the result set (which
      // is already sorted ASC by occurred_at by the SQL ORDER BY).
      const sourceCandidate = !dc && !caller;
      const rows = (dbRes.rows || []).map((r, i) => ({
        occurredAt:         r.occurred_at,
        dcName:             r.dc_name,
        targetUserName:     r.target_user_name,
        subjectUserName:    r.subject_user_name,
        subjectDomain:      r.subject_domain,
        callerComputerName: r.caller_computer_name,
        isSource:           sourceCandidate && i === 0
      }));
      res.json(rows);
    } catch (e) {
      req.log?.error?.({ err: e.message }, 'lockout search failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}
```

- [ ] **Step 4: Mount the router in `center/server.js`**

In `center/server.js`, add the import after the `dcsRouter` import (line 9):

```js
import { lockoutRouter } from './src/routes/lockout.js';
```

After the `app.use(dcsRouter({...}))` call (lines 92-95), add:

```js
    // Lockout troubleshooting — multi-filter search across ad_lockout_events.
    // Same auth contract as dcsRouter: per-route [userAuth, requirePerm('admin:users')].
    app.use(lockoutRouter({
      requireAuth: userAuth({ secret: finalConfig.jwtSecret }),
      requirePerm: (perm) => requirePerm(perm)
    }));
```

- [ ] **Step 5: Run tests, expect PASS**

Run: `cd center && npm test -- tests/lockout-search.test.js`
Expected: 6 tests pass.

- [ ] **Step 6: Run full center suite to confirm no regressions**

Run: `cd center && npm test`
Expected: 388 pre-existing + 6 new = 394 tests, all green.

- [ ] **Step 7: Commit**

```bash
git add center/src/routes/lockout.js center/server.js center/tests/lockout-search.test.js
git commit -m "feat(center): GET /api/lockout-events/search with multi-filter query"
```

---

## Task 6: Frontend API client — searchLockoutEvents

**Files:**
- Create: `frontend/src/api/lockout.js`
- Create: `frontend/tests/api-lockout.test.js` — 1 test

**Interfaces:**
- Produces: `searchLockoutEvents({ targetUser, dc, caller, sinceHours })` — GET `/api/lockout-events/search?...` building query string from non-empty fields. Returns `Promise<AxiosResponse<Array<LockoutEvent>>>`. `sinceHours` is required.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/api-lockout.test.js`:

```js
import { test, expect, vi } from 'vitest';
import api from '../src/api/client.js';
import { searchLockoutEvents } from '../src/api/lockout.js';

vi.mock('../src/api/client.js', () => ({
  default: { get: vi.fn(() => Promise.resolve({ data: [] })) }
}));

test('searchLockoutEvents composes query string from non-empty fields', async () => {
  await searchLockoutEvents({ targetUser: 'alice', dc: 'DC01', caller: '', sinceHours: 24 });
  expect(api.get).toHaveBeenCalledWith('/api/lockout-events/search?targetUser=alice&dc=DC01&sinceHours=24');
});

test('searchLockoutEvents omits empty filter fields from query string', async () => {
  await searchLockoutEvents({ targetUser: 'alice', dc: '', caller: '', sinceHours: 6 });
  expect(api.get).toHaveBeenCalledWith('/api/lockout-events/search?targetUser=alice&sinceHours=6');
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `cd frontend && npx vitest run tests/api-lockout.test.js`
Expected: FAIL — `frontend/src/api/lockout.js` doesn't exist.

- [ ] **Step 3: Create the api client**

Create `frontend/src/api/lockout.js`:

```js
import api from './client.js';

export function searchLockoutEvents({ targetUser, dc, caller, sinceHours }) {
  const parts = [];
  if (targetUser) parts.push(`targetUser=${encodeURIComponent(targetUser)}`);
  if (dc)         parts.push(`dc=${encodeURIComponent(dc)}`);
  if (caller)     parts.push(`caller=${encodeURIComponent(caller)}`);
  if (sinceHours != null) parts.push(`sinceHours=${encodeURIComponent(sinceHours)}`);
  const qs = parts.length ? `?${parts.join('&')}` : '';
  return api.get(`/api/lockout-events/search${qs}`);
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `cd frontend && npx vitest run tests/api-lockout.test.js`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/lockout.js frontend/tests/api-lockout.test.js
git commit -m "feat(frontend): searchLockoutEvents api client"
```

---

## Task 7: Frontend LockoutTroubleshootingView (replaces placeholder)

**Files:**
- Create: `frontend/src/views/LockoutTroubleshootingView.vue`
- Create: `frontend/tests/lockout-troubleshooting.test.js` — 4 tests
- Delete: `frontend/tests/lockout-placeholder.test.js` — placeholder view is gone

**Interfaces:**
- Produces: `<LockoutTroubleshootingView />` mounted at `/lockout-troubleshooting`.
  - Top filter bar: 3 input fields (targetUser / dc / caller) + time window select (1h / 6h / 24h / 7d) + 查询 button.
  - 查询 button is **disabled** when all three filter inputs are empty.
  - Loading skeleton (3 rows) while fetching.
  - Error banner with retry button on failure.
  - Empty state when result is `[]`: "无匹配事件 — 尝试调整过滤或扩大时间窗口".
  - Result list rows: ⭐ (only on source row), time, DC badge, target user, subject, caller.
  - DC badge → click sets `?dc=...` (preserving other filters) + re-fetches.
  - Caller badge → click sets `?caller=...` + re-fetches.
  - Subject and target are plain text (not clickable in v1).
  - Footer: "共 N 条事件".
  - Reads URL query params on mount: if `?dc=...` or `?caller=...` is present, pre-fill those inputs and submit immediately.

- [ ] **Step 1: Write failing tests**

Create `frontend/tests/lockout-troubleshooting.test.js`:

```js
import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import LockoutTroubleshootingView from '../src/views/LockoutTroubleshootingView.vue';
import { searchLockoutEvents } from '../src/api/lockout.js';

vi.mock('../src/api/lockout.js', () => ({
  searchLockoutEvents: vi.fn(() => Promise.resolve({ data: [] }))
}));

function makeRouter(query = {}) {
  const r = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/lockout-troubleshooting', component: LockoutTroubleshootingView }]
  });
  const qs = new URLSearchParams(query).toString();
  r.push(`/lockout-troubleshooting${qs ? '?' + qs : ''}`);
  return r;
}

beforeEach(() => {
  searchLockoutEvents.mockReset();
  searchLockoutEvents.mockResolvedValue({ data: [] });
});

test('renders 3 inputs + time select + 查询 button; button disabled when all inputs empty', async () => {
  setActivePinia(createPinia());
  const r = makeRouter();
  await r.isReady();
  const w = mount(LockoutTroubleshootingView, { global: { plugins: [r] } });
  await flushPromises();

  const inputs = w.findAll('input[type="text"]');
  expect(inputs.length).toBe(3);
  expect(w.find('select').exists()).toBe(true);
  const btn = w.find('button.search-btn');
  expect(btn.exists()).toBe(true);
  expect(btn.attributes('disabled')).toBeDefined();
});

test('submit triggers searchLockoutEvents with composed params; renders result rows', async () => {
  setActivePinia(createPinia());
  const r = makeRouter();
  await r.isReady();
  const w = mount(LockoutTroubleshootingView, { global: { plugins: [r] } });
  await flushPromises();

  const inputs = w.findAll('input[type="text"]');
  await inputs[0].setValue('alice');
  await inputs[1].setValue('DC01');
  // Click search
  await w.find('button.search-btn').trigger('click');
  await flushPromises();

  expect(searchLockoutEvents).toHaveBeenCalledWith(expect.objectContaining({
    targetUser: 'alice', dc: 'DC01', sinceHours: expect.anything()
  }));
});

test('with only targetUser filter, first row gets ⭐ and "源头" label', async () => {
  setActivePinia(createPinia());
  const r = makeRouter({ targetUser: 'alice' });
  await r.isReady();
  searchLockoutEvents.mockResolvedValue({ data: [
    { occurredAt: '2026-08-06T10:00:00.000Z', dcName: 'DC01', targetUserName: 'alice', subjectUserName: 'DC01$', subjectDomain: 'CORP', callerComputerName: 'WS-01', isSource: true },
    { occurredAt: '2026-08-06T10:05:00.000Z', dcName: 'DC02', targetUserName: 'alice', subjectUserName: 'DC02$', subjectDomain: 'CORP', callerComputerName: 'WS-01', isSource: false }
  ]});
  const w = mount(LockoutTroubleshootingView, { global: { plugins: [r] } });
  await flushPromises();
  // First row should have the source marker
  const rows = w.findAll('.lockout-row');
  expect(rows.length).toBe(2);
  expect(rows[0].text()).toContain('源头');
  expect(rows[0].classes()).toContain('source-row');
  // Second row: no 源头
  expect(rows[1].text()).not.toContain('源头');
});

test('click DC badge updates URL query and triggers re-fetch with new dc filter', async () => {
  setActivePinia(createPinia());
  const r = makeRouter({ targetUser: 'alice' });
  await r.isReady();
  searchLockoutEvents.mockResolvedValue({ data: [
    { occurredAt: '2026-08-06T10:00:00.000Z', dcName: 'DC01', targetUserName: 'alice', subjectUserName: 'DC01$', subjectDomain: 'CORP', callerComputerName: 'WS-01', isSource: true }
  ]});
  const w = mount(LockoutTroubleshootingView, { global: { plugins: [r] } });
  await flushPromises();

  // Click the DC badge
  const dcBadge = w.find('.dc-badge');
  expect(dcBadge.exists()).toBe(true);
  await dcBadge.trigger('click');
  await flushPromises();

  // URL query should now contain dc=DC01 alongside targetUser=alice
  expect(r.currentRoute.value.query.dc).toBe('DC01');
  expect(r.currentRoute.value.query.targetUser).toBe('alice');
  // searchLockoutEvents called again with dc: 'DC01'
  const lastCall = searchLockoutEvents.mock.calls[searchLockoutEvents.mock.calls.length - 1][0];
  expect(lastCall.dc).toBe('DC01');
  expect(lastCall.targetUser).toBe('alice');
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `cd frontend && npx vitest run tests/lockout-troubleshooting.test.js`
Expected: FAIL — view missing.

- [ ] **Step 3: Create LockoutTroubleshootingView.vue**

Create `frontend/src/views/LockoutTroubleshootingView.vue`:

```vue
<template>
  <AppLayout>
    <h2>用户锁定排查</h2>

    <div class="filter-bar">
      <label>
        <span>锁定用户</span>
        <input type="text" v-model="targetUser" placeholder="如 alice" data-test="target-user" />
      </label>
      <label>
        <span>DC</span>
        <input type="text" v-model="dc" placeholder="如 DC01" data-test="dc" />
      </label>
      <label>
        <span>调用方</span>
        <input type="text" v-model="caller" placeholder="如 WS-DEV-42" data-test="caller" />
      </label>
      <label>
        <span>时间窗口</span>
        <select v-model.number="sinceHours" data-test="since-hours">
          <option :value="1">1 小时</option>
          <option :value="6">6 小时</option>
          <option :value="24">24 小时</option>
          <option :value="168">7 天</option>
        </select>
      </label>
      <button class="search-btn" :disabled="!canSearch || loading" @click="search">查询</button>
    </div>

    <div v-if="loading" class="skeleton">
      <div v-for="i in 3" :key="i" class="skeleton-row"></div>
    </div>

    <div v-else-if="error" class="error-banner">
      <span>查询失败，请重试</span>
      <button @click="search">重试</button>
    </div>

    <div v-else-if="events.length === 0" class="empty-state">
      无匹配事件 — 尝试调整过滤或扩大时间窗口
    </div>

    <div v-else class="result-list">
      <div
        v-for="(ev, i) in events"
        :key="i"
        class="lockout-row"
        :class="{ 'source-row': ev.isSource }"
      >
        <span v-if="ev.isSource" class="source-marker" title="锁定源头">⭐ 源头</span>
        <span class="time">{{ formatTime(ev.occurredAt) }}</span>
        <button class="dc-badge" @click="drillDown('dc', ev.dcName)">{{ ev.dcName }}</button>
        <span class="target">目标: {{ ev.targetUserName }}</span>
        <span class="subject">{{ ev.subjectDomain }}\{{ ev.subjectUserName }}</span>
        <button class="caller-badge" @click="drillDown('caller', ev.callerComputerName)">
          {{ ev.callerComputerName || '—' }}
        </button>
      </div>
      <footer class="result-footer">共 {{ events.length }} 条事件</footer>
    </div>
  </AppLayout>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import { searchLockoutEvents } from '../api/lockout.js';

const route = useRoute();
const router = useRouter();

const targetUser = ref('');
const dc         = ref('');
const caller     = ref('');
const sinceHours = ref(24);

const events  = ref([]);
const loading = ref(false);
const error   = ref(false);

const canSearch = computed(() => !!(targetUser.value || dc.value || caller.value));

async function search() {
  if (!canSearch.value) return;
  loading.value = true;
  error.value = false;
  try {
    const r = await searchLockoutEvents({
      targetUser: targetUser.value,
      dc:         dc.value,
      caller:     caller.value,
      sinceHours: sinceHours.value
    });
    events.value = r.data || [];
  } catch (e) {
    error.value = true;
    events.value = [];
  } finally {
    loading.value = false;
  }
}

async function drillDown(field, value) {
  if (!value) return;
  // Update the URL query — preserves other filters. router.replace so we
  // don't pollute the history stack with each badge click.
  const nextQuery = { ...route.query, [field]: value };
  await router.replace({ path: '/lockout-troubleshooting', query: nextQuery });
}

function formatTime(s) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString();
}

onMounted(async () => {
  // Pre-fill from URL and trigger an immediate search. Enables drill-down
  // entry from /servers-overview?dc=DC01 or /servers-overview?caller=WS-01.
  const q = route.query;
  if (typeof q.targetUser === 'string') targetUser.value = q.targetUser;
  if (typeof q.dc === 'string')         dc.value = q.dc;
  if (typeof q.caller === 'string')     caller.value = q.caller;
  if (canSearch.value) await search();
});

// React to drill-down clicks that change the URL
watch(() => route.query, async (newQ) => {
  if (typeof newQ.dc === 'string' && newQ.dc !== dc.value) {
    dc.value = newQ.dc;
  }
  if (typeof newQ.caller === 'string' && newQ.caller !== caller.value) {
    caller.value = newQ.caller;
  }
  if (canSearch.value) await search();
});
</script>

<style scoped>
.filter-bar { display: flex; gap: 12px; align-items: flex-end; margin-bottom: 16px; flex-wrap: wrap; }
.filter-bar label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
.filter-bar input, .filter-bar select { padding: 6px 10px; background: #0b1220; color: var(--text); border: 1px solid #1e293b; border-radius: 3px; font-size: 13px; }
.search-btn { padding: 6px 18px; background: var(--accent); color: #0b1220; border: 1px solid #1e293b; border-radius: 3px; cursor: pointer; font-weight: 600; }
.search-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.skeleton { display: flex; flex-direction: column; gap: 8px; }
.skeleton-row { height: 40px; background: linear-gradient(90deg, var(--panel) 0%, #1e293b 50%, var(--panel) 100%); background-size: 200% 100%; animation: shimmer 1.5s infinite; border-radius: 4px; }
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
.error-banner { padding: 16px; background: #7f1d1d; border-radius: 4px; display: flex; align-items: center; gap: 12px; }
.error-banner button { padding: 4px 12px; background: var(--accent); color: #0b1220; border: none; border-radius: 3px; cursor: pointer; }
.empty-state { padding: 40px; text-align: center; color: var(--muted); }
.result-list { display: flex; flex-direction: column; gap: 6px; }
.lockout-row { display: grid; grid-template-columns: auto 140px 100px 1fr 1fr 140px; gap: 12px; padding: 8px 12px; background: var(--panel); border: 1px solid #1e293b; border-radius: 4px; align-items: center; font-size: 13px; }
.lockout-row.source-row { border-left: 4px solid #fbbf24; background: #422006; }
.source-marker { color: #fbbf24; font-weight: 600; }
.time { color: var(--muted); font-family: monospace; }
.dc-badge, .caller-badge { padding: 2px 10px; background: #0b1220; border: 1px solid #1e293b; border-radius: 10px; font-size: 11px; cursor: pointer; color: var(--text); }
.dc-badge:hover, .caller-badge:hover { border-color: var(--accent); }
.target { color: var(--text); font-weight: 600; }
.subject { color: var(--muted); font-family: monospace; font-size: 12px; }
.result-footer { padding: 12px; text-align: right; color: var(--muted); font-size: 12px; }
</style>
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `cd frontend && npx vitest run tests/lockout-troubleshooting.test.js`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/LockoutTroubleshootingView.vue frontend/tests/lockout-troubleshooting.test.js
git commit -m "feat(frontend): LockoutTroubleshootingView with multi-filter search + drill-down"
```

---

## Task 8: Router swap + delete obsolete placeholder test

**Files:**
- Modify: `frontend/src/router.js` — replace `LockoutPlaceholderView` import + route component with `LockoutTroubleshootingView`
- Delete: `frontend/tests/lockout-placeholder.test.js`

**Interfaces:**
- Produces:
  - `/lockout-troubleshooting` route → `LockoutTroubleshootingView` (replaces `LockoutPlaceholderView`)
  - `LockoutPlaceholderView.vue` file is no longer imported (file can be left on disk or deleted; not strictly required)

- [ ] **Step 1: Modify `frontend/src/router.js`**

Replace the import (line 25):
```js
import LockoutPlaceholderView from './views/LockoutPlaceholderView.vue';
```
with:
```js
import LockoutTroubleshootingView from './views/LockoutTroubleshootingView.vue';
```

Replace the route (line 51):
```js
  { path: '/lockout-troubleshooting', component: LockoutPlaceholderView },
```
with:
```js
  { path: '/lockout-troubleshooting', component: LockoutTroubleshootingView },
```

- [ ] **Step 2: Delete the obsolete placeholder test**

```bash
git rm frontend/tests/lockout-placeholder.test.js
```

- [ ] **Step 3: Run frontend build to confirm no Vue compile errors**

Run: `cd frontend && npx vite build`
Expected: build succeeds with no errors.

- [ ] **Step 4: Run full frontend test suite**

Run: `cd frontend && npx vitest run`
Expected: 171 pre-existing (after Task 6 + Task 7 added 2 + 4 = 6 new) + 2 api-lockout + 4 lockout-troubleshooting − 1 lockout-placeholder = 172 tests, all green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/router.js
git rm frontend/tests/lockout-placeholder.test.js
git commit -m "feat(frontend): route /lockout-troubleshooting to LockoutTroubleshootingView (drop placeholder)"
```

---

## Task 9: Mirror to publish/ + rebuild dist + publish.zip

**Files:** mirror every changed source file to `publish/`, rebuild dist.

**Interfaces:**
- Produces:
  - All source changes mirrored under `publish/`
  - `frontend/dist/` rebuilt and copied to `publish/dist/`
  - `publish/publish.zip` regenerated (≈2.18 MB)
  - One final commit `chore(publish): mirror lockout-troubleshooting`

- [ ] **Step 1: Mirror source files**

Run from repo root:

```bash
# Agent
cp agent/scripts/collect-replication.ps1 publish/agent/scripts/collect-replication.ps1

# Center
cp center/src/db/sql.js publish/center/src/db/sql.js
cp center/src/routes/agent.js publish/center/src/routes/agent.js
cp center/src/routes/lockout.js publish/center/src/routes/lockout.js
cp center/server.js publish/center/server.js

# Frontend
cp frontend/src/api/lockout.js publish/frontend/src/api/lockout.js
cp frontend/src/views/LockoutTroubleshootingView.vue publish/frontend/src/views/LockoutTroubleshootingView.vue
cp frontend/src/router.js publish/frontend/src/router.js

# Migrations
cp db/migrations/008-lockout-events.sql publish/db/migrations/008-lockout-events.sql
cp db/migrations/mssql/008-lockout-events.sql publish/db/migrations/mssql/008-lockout-events.sql
```

(Confirm with `ls` that all destination directories exist; create with `mkdir -p` if any are missing.)

- [ ] **Step 2: Rebuild frontend dist**

```bash
cd frontend && npm run build
```

Expected: vite build succeeds.

- [ ] **Step 3: Copy dist to publish/dist/**

```bash
rm -rf publish/dist/assets
mkdir -p publish/dist/assets
cp frontend/dist/index.html publish/dist/index.html
cp -r frontend/dist/assets/. publish/dist/assets/
```

- [ ] **Step 4: Rebuild publish.zip**

```bash
cd .. && powershell -ExecutionPolicy Bypass -File scripts/build-publish-zip.ps1
```

Expected output: `[build-publish] <path> (~2.18 MB)` (size will grow slightly due to new frontend view).

- [ ] **Step 5: Verify full test suites green across all 3 workspaces**

```bash
npm test
```

Expected: all green (agent 48, center 394, frontend 172 — including the deleted placeholder test).

- [ ] **Step 6: Stage mirror + commit + push**

```bash
git add publish/
git commit -m "chore(publish): mirror lockout-troubleshooting (10 source files + dist + zip)"
git push origin main
```

Expected: push succeeds, `origin/main` advances by 1 commit.

---

## Self-review

After writing the complete plan above, ran the spec-coverage / placeholder / consistency checks:

- **Spec coverage:**
  - §Migration 008 (`ad_lockout_events` table, indexes, both dialects) → Task 1 ✓
  - §Agent `Get-LockoutEvents` + snapshot extension → Task 2 ✓
  - §JSON payload extension (`lockoutEvents` field) → Task 2 (PS) + Task 4 (ingest handler) ✓
  - §Center sql.js (`lockout.upsertEvent` + `lockout.search`) → Task 3 ✓
  - §Ingest route extension → Task 4 ✓
  - §Search API (3 filters + sinceHours + isSource) → Task 5 ✓
  - §Validation rules (at least one filter, sinceHours in [1,168]) → Task 5 ✓
  - §Frontend API client → Task 6 ✓
  - §View with filter bar + timeline + click-to-drill-down badges → Task 7 ✓
  - §Loading/error/empty states → Task 7 ✓
  - §isSource highlight (only when targetUser-only) → Task 5 (server-side) + Task 7 (visual) ✓
  - §Pre-fill from URL query params → Task 7 (onMounted) ✓
  - §Replace placeholder → Task 8 ✓
  - §Publish mirror → Task 9 ✓
  - **16 new tests target:** agent 5 (spec said 4) + migration 2 + center ingest 1 + center API 6 + frontend api 2 + frontend view 4 − 1 deleted placeholder = **17 new** (over-delivery of 1, acceptable).

- **Placeholder scan:** No "TBD" / "TODO" / "implement later" / "add appropriate error handling". Every step has code or specific commands.

- **Type consistency:**
  - `lockoutEvents` (camelCase) is used consistently across PS output, agent wrapper, ingest handler, and sql.js
  - `eventRecordId` (camelCase) consistent with PS output, JS variable, and SQL column `event_record_id`
  - `targetUser` / `dc` / `caller` query param names consistent between frontend, route, and test assertions
  - `isSource` flag is camelCase in the JSON response, set in the route handler, and consumed by the view — consistent
  - `LockoutTroubleshootingView` is named consistently across router.js, view file, and test file

- **Order:** Task dependencies flow correctly:
  - Task 1 (migration) → independent, can run first
  - Task 2 (PS script) → independent of migration (snapshot field exists regardless of table)
  - Task 3 (sql.js) → independent (just adding SQL strings)
  - Task 4 (ingest route) → depends on Task 3's `lockout.upsertEvent`
  - Task 5 (search route) → depends on Task 3's `lockout.search` + Task 1's schema
  - Task 6 (frontend api client) → independent
  - Task 7 (frontend view) → depends on Task 6's `searchLockoutEvents`
  - Task 8 (router swap) → depends on Task 7's view existing
  - Task 9 (publish mirror) → depends on all of the above being committed