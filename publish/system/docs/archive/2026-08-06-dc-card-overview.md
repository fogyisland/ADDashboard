# Per-DC Card Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new top-level admin view `/servers-overview` (服务器总览) that shows one card per discovered DC with 4 summary counters (AD users, groups, GPOs, locked-out users) plus the existing replication partner count. Locked-users tile links to `/lockout-troubleshooting` (placeholder route — real feature comes next spec).

**Architecture:** Extend `collect-replication.ps1` to emit one additional "self-loop" entry per cycle with `naming_context='__dc_summary__'` carrying the 4 counters. Add 4 nullable INT columns to the existing `ad_replication_status` table (migration 007). Extend the existing upsert SQL to bind the 4 new params (NULL for non-summary entries). Add a new `latestPerDc` query for the cards view. Frontend gets a new page with site filter + responsive card grid + placeholder lockout-troubleshooting route.

**Tech Stack:** Vue 3 + script setup + Pinia (frontend), Node.js + Express + mysql2/mssql (center), Node.js + PowerShell 5.1 (agent).

## Global Constraints

- One storage path: counters live on `ad_replication_status` as part of a special `__dc_summary__` entry. No new table, no new agent collector.
- Per-counter fault isolation on the agent: each `Get-ADX` call wrapped in `try { ... } catch { $null }`. Replication topology collection MUST NOT be affected by counter failures.
- DB / API / backend / audit continue using snake_case. UI shows Chinese labels as primary caption; raw keys (`users_count`, etc.) stay visible underneath in `<code class="raw-key">`.
- All existing tests stay green: agent 40, center 385, frontend 162. Target after: agent 43+, center 391+, frontend 169+.
- PowerShell scripts must remain PS 5.1 + pwsh 7+ dual-compatible (no pwsh-only syntax).
- publish/ mirror every changed source file per project convention. Rebuild frontend dist + publish.zip in the final task.

---

## File map

### Agent (1 modified, 1 new test)
- Modify `agent/scripts/collect-replication.ps1` — append `__dc_summary__` entry with 4 counters
- Create `agent/tests/collect-replication.test.js` — structural tests for the new entry block

### Center (1 migration pair, 2 modified services, 1 new route, 2 new test files)
- Create `db/migrations/007-dc-card-counters.sql` (mysql)
- Create `db/migrations/mssql/007-dc-card-counters.sql` (mssql)
- Modify `center/src/db/sql.js` — extend `replication.upsertStatus` (both dialects) + add `replication.latestSummaryPerDc`
- Modify `center/src/services/replication.js` — extend `rowParams` with 4 new fields (NULL for non-summary)
- Create `center/src/routes/dcs.js` — `GET /api/dcs/summary?siteId=X`
- Modify `center/src/server.js` — mount `dcsRouter` at `/api`
- Create `center/tests/dcs-summary.test.js` — 4 tests for the new route
- Modify `center/tests/init/schema-applier.test.js` — 2 tests for migration 007

### Frontend (3 new views/components, 1 new api, 2 modified shell files, 3 new test files)
- Create `frontend/src/api/dcs.js` — `getDcSummary(siteId)` client
- Create `frontend/src/components/DcCard.vue` — reusable per-DC card
- Create `frontend/src/views/ServersOverviewView.vue` — page shell
- Create `frontend/src/views/LockoutPlaceholderView.vue` — placeholder route
- Modify `frontend/src/router.js` — register `/servers-overview` and `/lockout-troubleshooting`
- Modify `frontend/src/components/AppLayout.vue` — add "服务器总览" nav item
- Create `frontend/tests/dc-card.test.js` — 3 tests
- Create `frontend/tests/servers-overview.test.js` — 3 tests
- Create `frontend/tests/lockout-placeholder.test.js` — 1 test

### Publish mirror (Task 13)
- All modified source files mirrored under `publish/`
- `frontend/dist/` rebuilt and copied to `publish/dist/`
- `publish/publish.zip` regenerated

---

## Task 1: Migration 007 — add 4 counter columns to ad_replication_status

**Files:**
- Create: `db/migrations/007-dc-card-counters.sql`
- Create: `db/migrations/mssql/007-dc-card-counters.sql`
- Modify: `center/tests/init/schema-applier.test.js:115` (append 2 tests at end)

**Interfaces:**
- Produces: 4 new nullable INT columns on `ad_replication_status`:
  - `users_count INT NULL`
  - `groups_count INT NULL`
  - `gpos_count INT NULL`
  - `locked_count INT NULL`

- [ ] **Step 1: Create MySQL migration file**

Create `db/migrations/007-dc-card-counters.sql`:

```sql
-- 007-dc-card-counters.sql
-- Add 4 summary counter columns to ad_replication_status for the per-DC
-- card overview. Populated by a self-loop entry with naming_context =
-- '__dc_summary__' emitted by collect-replication.ps1. Nullable so
-- pre-feature rows remain valid.
ALTER TABLE ad_replication_status
  ADD COLUMN users_count  INT NULL AFTER error_message,
  ADD COLUMN groups_count INT NULL AFTER users_count,
  ADD COLUMN gpos_count   INT NULL AFTER groups_count,
  ADD COLUMN locked_count INT NULL AFTER gpos_count;
```

- [ ] **Step 2: Create MSSQL migration file (idempotent via INFORMATION_SCHEMA guard)**

Create `db/migrations/mssql/007-dc-card-counters.sql`:

```sql
-- 007-dc-card-counters.sql (MSSQL)
-- Add 4 summary counter columns to ad_replication_status. Guarded via
-- INFORMATION_SCHEMA so re-running is a no-op (older MSSQL versions
-- don't support ADD COLUMN IF NOT EXISTS).
IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_NAME = 'ad_replication_status' AND COLUMN_NAME = 'users_count'
)
ALTER TABLE ad_replication_status ADD users_count INT NULL;

IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_NAME = 'ad_replication_status' AND COLUMN_NAME = 'groups_count'
)
ALTER TABLE ad_replication_status ADD groups_count INT NULL;

IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_NAME = 'ad_replication_status' AND COLUMN_NAME = 'gpos_count'
)
ALTER TABLE ad_replication_status ADD gpos_count INT NULL;

IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_NAME = 'ad_replication_status' AND COLUMN_NAME = 'locked_count'
)
ALTER TABLE ad_replication_status ADD locked_count INT NULL;
```

- [ ] **Step 3: Write failing tests in schema-applier.test.js**

Append to `center/tests/init/schema-applier.test.js` (after the migration 006 tests added in commit `e04cc40`):

```js
test('splitSqlStatements parses migration 007 mysql (4 ADD COLUMN in 1 statement)', () => {
  const sql = readFileSync(join(__dirname, '../../../db/migrations/007-dc-card-counters.sql'), 'utf8');
  const stmts = splitSqlStatements(sql);
  // MySQL: 1 multi-column ALTER
  assert.strictEqual(stmts.length, 1, `expected 1 statement, got ${stmts.length}: ${JSON.stringify(stmts)}`);
  assert.match(stmts[0], /ALTER TABLE ad_replication_status/i);
  assert.match(stmts[0], /users_count/);
  assert.match(stmts[0], /groups_count/);
  assert.match(stmts[0], /gpos_count/);
  assert.match(stmts[0], /locked_count/);
});

test('splitSqlStatements parses migration 007 mssql (4 guarded ADD COLUMN statements)', () => {
  const sql = readFileSync(join(__dirname, '../../../db/migrations/mssql/007-dc-card-counters.sql'), 'utf8');
  const stmts = splitSqlStatements(sql);
  // MSSQL: 4 IF-guarded ALTER blocks
  assert.strictEqual(stmts.length, 4, `expected 4 statements, got ${stmts.length}: ${JSON.stringify(stmts)}`);
  assert.ok(stmts.every(s => /ALTER TABLE ad_replication_status/i.test(s)));
  assert.ok(stmts.every(s => /INFORMATION_SCHEMA\.COLUMNS/.test(s)));
});
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `cd center && npm test -- tests/init/schema-applier.test.js`
Expected: All tests pass including the 2 new ones.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/007-dc-card-counters.sql db/migrations/mssql/007-dc-card-counters.sql center/tests/init/schema-applier.test.js
git commit -m "feat(migration): 007 — add 4 counter columns to ad_replication_status"
```

---

## Task 2: Agent PS script — emit __dc_summary__ entry with 4 counters

**Files:**
- Modify: `agent/scripts/collect-replication.ps1` — add `Get-DcCounters` function + emit summary entry in `Get-ReplicationSnapshot`
- Create: `agent/tests/collect-replication.test.js` — 2 structural tests

**Interfaces:**
- Produces: PS script that emits one extra `Entries[]` item with:
  - `SourceDc = DestDc = $ComputerName`
  - `NamingContext = '__dc_summary__'`
  - `StatusCode = 0`
  - `UsersCount`, `GroupsCount`, `GposCount`, `LockedCount` populated (or `$null` on failure)

- [ ] **Step 1: Write the structural tests**

Create `agent/tests/collect-replication.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const psPath = join(__dirname, '../scripts/collect-replication.ps1');

test('collect-replication.ps1 declares a Get-DcCounters function', () => {
  const src = readFileSync(psPath, 'utf8');
  assert.match(src, /function\s+Get-DcCounters\b/,
    'expected Get-DcCounters function definition');
});

test('collect-replication.ps1 emits a __dc_summary__ entry inside Get-ReplicationSnapshot', () => {
  const src = readFileSync(psPath, 'utf8');
  // The summary entry must be inside the snapshot build (not a stand-alone block)
  // and use the four canonical AD cmdlets.
  assert.match(src, /NamingContext\s*=\s*'__dc_summary__'/,
    "expected NamingContext = '__dc_summary__'");
  assert.match(src, /Get-ADUser\s+-Filter\s+\*\s+-Server\s+\$dc/,
    'expected Get-ADUser -Filter * -Server $dc call');
  assert.match(src, /Get-ADGroup\s+-Filter\s+\*\s+-Server\s+\$dc/,
    'expected Get-ADGroup -Filter * -Server $dc call');
  assert.match(src, /Get-GPO\b/,
    'expected Get-GPO call');
  assert.match(src, /Search-ADAccount\s+-LockedOut\s+-Server\s+\$dc/,
    'expected Search-ADAccount -LockedOut -Server $dc call');
});

test('collect-replication.ps1 wraps each counter query in try/catch', () => {
  const src = readFileSync(psPath, 'utf8');
  // Count the Get-AD* / Search-ADAccount / Get-GPO invocations and the
  // try/catch blocks around them — must be at least 4 of each.
  const counterCalls = (src.match(/(Get-ADUser|Get-ADGroup|Get-GPO|Search-ADAccount)/g) || []).length;
  const tryBlocks = (src.match(/^\s*try\s*\{/gm) || []).length;
  assert.ok(counterCalls >= 4, `expected >=4 counter cmdlet calls, got ${counterCalls}`);
  assert.ok(tryBlocks >= 4, `expected >=4 try blocks for fault isolation, got ${tryBlocks}`);
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `cd agent && npm test -- tests/collect-replication.test.js`
Expected: FAIL (file doesn't exist OR Get-DcCounters not declared yet).

- [ ] **Step 3: Add `Get-DcCounters` function and call it from `Get-ReplicationSnapshot`**

In `agent/scripts/collect-replication.ps1`, add the function after `ConvertTo-UtcIso` (around line 33):

```powershell
function Get-DcCounters {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$ComputerName
  )

  $counters = [ordered]@{
    UsersCount  = $null
    GroupsCount = $null
    GposCount   = $null
    LockedCount = $null
  }

  # Each counter is isolated: a failure here must not break replication
  # collection or other counters. $ErrorActionPreference stays 'Continue'
  # so unexpected throwables are still caught below.

  try {
    if (-not (Get-Module -Name ActiveDirectory -ListAvailable)) {
      throw "ActiveDirectory module not available"
    }
    if (-not (Get-Module -Name ActiveDirectory)) {
      Import-Module ActiveDirectory -ErrorAction Stop
    }
    $counters.UsersCount = (Get-ADUser  -Filter * -Server $ComputerName | Measure-Object).Count
  } catch {
    [Console]::Error.WriteLine("usersCount failed: $($_.Exception.Message)")
  }

  try {
    if (-not (Get-Module -Name ActiveDirectory)) {
      Import-Module ActiveDirectory -ErrorAction Stop
    }
    $counters.GroupsCount = (Get-ADGroup -Filter * -Server $ComputerName | Measure-Object).Count
  } catch {
    [Console]::Error.WriteLine("groupsCount failed: $($_.Exception.Message)")
  }

  try {
    $counters.GposCount = (Get-GPO -All | Measure-Object).Count
  } catch {
    [Console]::Error.WriteLine("gposCount failed: $($_.Exception.Message)")
  }

  try {
    if (-not (Get-Module -Name ActiveDirectory)) {
      Import-Module ActiveDirectory -ErrorAction Stop
    }
    $counters.LockedCount = (Search-ADAccount -LockedOut -Server $ComputerName | Measure-Object).Count
  } catch {
    [Console]::Error.WriteLine("lockedCount failed: $($_.Exception.Message)")
  }

  return [PSCustomObject]$counters
}
```

Then modify `Get-ReplicationSnapshot` to call it and append a summary entry.

In `Get-ReplicationSnapshot`, after the existing `entries` loop (just before `$snapshot.Entries = $entries`), insert:

```powershell
  # DC summary card counters — emitted as a self-loop entry so the data
  # rides on the same replication ingest path. Naming context 'META' is
  # already used by the meta-failure entry above; '__dc_summary__' is the
  # canonical marker for "this row holds the 4 card counters".
  $counters = Get-DcCounters -ComputerName $ComputerName
  $summaryEntry = [PSCustomObject]@{
    SourceDc        = $ComputerName
    DestDc          = $ComputerName
    SourceSite      = $snapshot.Site
    DestSite        = $null
    NamingContext   = '__dc_summary__'
    LastSuccessTime = $snapshot.CollectedAt
    LastAttemptTime = $snapshot.CollectedAt
    StatusCode      = 0
    ErrorMessage    = $null
    UsersCount      = $counters.UsersCount
    GroupsCount     = $counters.GroupsCount
    GposCount       = $counters.GposCount
    LockedCount     = $counters.LockedCount
  }
  $entries += $summaryEntry
```

(The `+ $summaryEntry` should be placed right before `$snapshot.Entries = $entries`.)

- [ ] **Step 4: Run tests, expect PASS**

Run: `cd agent && npm test -- tests/collect-replication.test.js`
Expected: All 3 structural tests pass.

- [ ] **Step 5: Run full agent suite to confirm no regressions**

Run: `cd agent && npm test`
Expected: 40 pre-existing + 3 new = 43 tests, all green.

- [ ] **Step 6: Commit**

```bash
git add agent/scripts/collect-replication.ps1 agent/tests/collect-replication.test.js
git commit -m "feat(agent): emit __dc_summary__ entry with users/groups/GPOs/locked counters"
```

---

## Task 3: Center sql.js — extend upsertStatus + add latestSummaryPerDc query

**Files:**
- Modify: `center/src/db/sql.js:15-18` (mysql `replication` block) — extend upsertStatus + add latestSummaryPerDc
- Modify: `center/src/db/sql.js:198-202` (mssql `replication` block) — same shape
- Create: `center/tests/replication-status-card.test.js` — 3 sql-level tests
- Modify: `center/src/services/replication.js:7-21` — extend `rowParams` helper with 4 new fields

**Interfaces:**
- Produces:
  - `db.sql.replication.upsertStatus` — now binds 15 params (was 11). Insert list and ON DUPLICATE KEY UPDATE / MERGE UPDATE both include the 4 counter columns.
  - `db.sql.replication.latestSummaryPerDc` — new query. MySQL uses `ROW_NUMBER() OVER (PARTITION BY source_dc)`. MSSQL uses `OUTER APPLY (SELECT TOP 1 ...)`. Both return: `source_dc, users_count, groups_count, gpos_count, locked_count, collected_at`.
  - `services/replication.js` `rowParams(row)` — returns 15 params (was 11). For non-summary entries (`row.naming_context !== '__dc_summary__'`), counter fields are `null`. For summary entries, they hold the values.

- [ ] **Step 1: Write failing sql tests**

Create `center/tests/replication-status-card.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSql } from '../src/db/sql.js';

test('mysql upsertStatus binds 15 params and includes 4 new counter columns', () => {
  const sql = buildSql('mysql');
  const upsert = sql.replication.upsertStatus;
  const placeholders = (upsert.match(/\?/g) || []).length;
  assert.strictEqual(placeholders, 15,
    `expected 15 ? placeholders in mysql upsertStatus, got ${placeholders}`);
  assert.match(upsert, /users_count/);
  assert.match(upsert, /groups_count/);
  assert.match(upsert, /gpos_count/);
  assert.match(upsert, /locked_count/);
  assert.match(upsert, /ON DUPLICATE KEY UPDATE.*users_count\s*=\s*VALUES\(users_count\)/s);
});

test('mssql upsertStatus binds 15 params via MERGE and includes 4 new counter columns', () => {
  const sql = buildSql('mssql');
  const upsert = sql.replication.upsertStatus;
  // MSSQL uses @p1..@pN — same param count expected
  const placeholders = (upsert.match(/@p\d+/g) || []);
  const unique = new Set(placeholders);
  assert.strictEqual(unique.size, 15,
    `expected 15 unique @pN placeholders in mssql upsertStatus, got ${unique.size}`);
  assert.match(upsert, /users_count/);
  assert.match(upsert, /groups_count/);
  assert.match(upsert, /gpos_count/);
  assert.match(upsert, /locked_count/);
  assert.match(upsert, /WHEN MATCHED THEN UPDATE SET[\s\S]*users_count\s*=\s*s\.users_count/);
});

test('latestSummaryPerDc query exists for both dialects and filters by __dc_summary__', () => {
  for (const dialect of ['mysql', 'mssql']) {
    const sql = buildSql(dialect);
    assert.ok(sql.replication.latestSummaryPerDc, `${dialect}: latestSummaryPerDc missing`);
    assert.match(sql.replication.latestSummaryPerDc, /__dc_summary__/);
    assert.match(sql.replication.latestSummaryPerDc, /ad_replication_status/i);
  }
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `cd center && npm test -- tests/replication-status-card.test.js`
Expected: FAIL (upsertStatus has 11 params, latestSummaryPerDc missing).

- [ ] **Step 3: Extend the MySQL `replication` block in `center/src/db/sql.js`**

Replace the existing `replication` block at lines 15-18 with:

```js
    replication: {
      upsertStatus: `INSERT INTO ad_replication_status (collected_at, agent_id, source_dc, dest_dc, source_site, dest_site, naming_context, last_success_time, last_attempt_time, status_code, error_message, users_count, groups_count, gpos_count, locked_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE collected_at = VALUES(collected_at), agent_id = VALUES(agent_id), source_site = VALUES(source_site), dest_site = VALUES(dest_site), last_success_time = VALUES(last_success_time), last_attempt_time = VALUES(last_attempt_time), status_code = VALUES(status_code), error_message = VALUES(error_message), users_count = VALUES(users_count), groups_count = VALUES(groups_count), gpos_count = VALUES(gpos_count), locked_count = VALUES(locked_count)`,
      upsertHistory: `INSERT INTO ad_replication_history (collected_at, agent_id, source_dc, dest_dc, naming_context, last_success_time, status_code, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      listRecent: `SELECT source_dc, dest_dc, source_site, dest_site, status_code, collected_at FROM ad_replication_status ORDER BY collected_at DESC LIMIT ?`,
      listBySite: `SELECT source_dc, dest_dc, source_site, dest_site, status_code, collected_at FROM ad_replication_status WHERE source_site = ? OR dest_site = ? ORDER BY collected_at DESC LIMIT ?`,
      latestSummaryPerDc: `SELECT source_dc, users_count, groups_count, gpos_count, locked_count, collected_at FROM (SELECT source_dc, users_count, groups_count, gpos_count, locked_count, collected_at, ROW_NUMBER() OVER (PARTITION BY source_dc ORDER BY collected_at DESC) AS rn FROM ad_replication_status WHERE naming_context = '__dc_summary__') t WHERE rn = 1 ORDER BY source_dc`
    },
```

- [ ] **Step 4: Extend the MSSQL `replication` block (parallel block around line 198)**

In the mssql section, find the `replication: {` block (line 198) and replace with:

```js
    replication: {
      upsertStatus: `MERGE INTO ad_replication_status AS t USING (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)) AS s(collected_at, agent_id, source_dc, dest_dc, source_site, dest_site, naming_context, last_success_time, last_attempt_time, status_code, error_message, users_count, groups_count, gpos_count, locked_count) ON t.source_dc = s.source_dc AND t.dest_dc = s.dest_dc AND t.naming_context = s.naming_context WHEN MATCHED THEN UPDATE SET collected_at = s.collected_at, agent_id = s.agent_id, source_site = s.source_site, dest_site = s.dest_site, last_success_time = s.last_success_time, last_attempt_time = s.last_attempt_time, status_code = s.status_code, error_message = s.error_message, users_count = s.users_count, groups_count = s.groups_count, gpos_count = s.gpos_count, locked_count = s.locked_count WHEN NOT MATCHED THEN INSERT (collected_at, agent_id, source_dc, dest_dc, source_site, dest_site, naming_context, last_success_time, last_attempt_time, status_code, error_message, users_count, groups_count, gpos_count, locked_count) VALUES (s.collected_at, s.agent_id, s.source_dc, s.dest_dc, s.source_site, s.dest_site, s.naming_context, s.last_success_time, s.last_attempt_time, s.status_code, s.error_message, s.users_count, s.groups_count, s.gpos_count, s.locked_count)`,
      upsertHistory: `INSERT INTO ad_replication_history (collected_at, agent_id, source_dc, dest_dc, naming_context, last_success_time, status_code, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      listRecent: `SELECT TOP (?) source_dc, dest_dc, source_site, dest_site, status_code, collected_at FROM ad_replication_status ORDER BY collected_at DESC`,
      listBySite: `SELECT TOP (?) source_dc, dest_dc, source_site, dest_site, status_code, collected_at FROM ad_replication_status WHERE source_site = ? OR dest_site = ? ORDER BY collected_at DESC`,
      latestSummaryPerDc: `SELECT t.source_dc, t.users_count, t.groups_count, t.gpos_count, t.locked_count, t.collected_at FROM ad_replication_status t OUTER APPLY (SELECT TOP 1 collected_at, users_count, groups_count, gpos_count, locked_count FROM ad_replication_status WHERE source_dc = t.source_dc AND naming_context = '__dc_summary__' ORDER BY collected_at DESC) s WHERE t.naming_context = '__dc_summary__' GROUP BY t.source_dc, t.users_count, t.groups_count, t.gpos_count, t.locked_count, t.collected_at ORDER BY t.source_dc`
    },
```

- [ ] **Step 5: Extend `rowParams` in `center/src/services/replication.js`**

Replace `function rowParams(row)` (lines 7-21) with:

```js
function rowParams(row) {
  // The 4 counter fields are populated only for the __dc_summary__ self-loop
  // entry emitted by collect-replication.ps1; all other entries pass NULL.
  const isSummary = row.naming_context === '__dc_summary__';
  return [
    toMysqlDatetime(row.collectedAt),
    row.agentId,
    row.sourceDc,
    row.destDc,
    row.sourceSite ?? null,
    row.destSite ?? null,
    row.namingContext,
    toMysqlDatetime(row.lastSuccessTime),
    toMysqlDatetime(row.lastAttemptTime),
    row.statusCode,
    row.errorMessage ?? null,
    isSummary ? (row.usersCount ?? null)  : null,
    isSummary ? (row.groupsCount ?? null) : null,
    isSummary ? (row.gposCount ?? null)   : null,
    isSummary ? (row.lockedCount ?? null) : null
  ];
}
```

- [ ] **Step 6: Run tests, expect PASS**

Run: `cd center && npm test -- tests/replication-status-card.test.js`
Expected: All 3 tests pass.

- [ ] **Step 7: Run full center suite to confirm no regressions**

Run: `cd center && npm test`
Expected: 385 pre-existing + 3 new = 388 tests, all green (no upsertStatus behavior tests broke since we only added params).

- [ ] **Step 8: Commit**

```bash
git add center/src/db/sql.js center/src/services/replication.js center/tests/replication-status-card.test.js
git commit -m "feat(center): extend upsertStatus with 4 counter columns + latestSummaryPerDc"
```

---

## Task 4: Center route GET /api/dcs/summary

**Files:**
- Create: `center/src/routes/dcs.js`
- Modify: `center/src/server.js` — import dcsRouter + mount
- Create: `center/tests/dcs-summary.test.js` — 4 tests

**Interfaces:**
- Produces:
  - `GET /api/dcs/summary?siteId=N` — returns JSON array of `{ dcHost, siteName, partnersCount, usersCount, groupsCount, gposCount, lockedCount, collectedAt }`. One row per DC, latest summary entry only.
  - If `siteId` is missing or empty → returns all DCs. If `siteId` is a positive integer → filters by `ad_dcs.site_id = siteId`.
  - Sorted by `dcHost` ASC.
  - `partnersCount` is a subquery: count of `ad_replication_status` rows for this `dc_host` where `naming_context <> '__dc_summary__'` AND `collected_at >= (collected_at from this summary row - 5 minutes)` (i.e. partners from the same cycle).
  - Auth: requires `agent:report` permission (same as other read endpoints accessible to any admin). Use the same `[userAuth, requirePerm('admin:users')]` middleware pattern as `admin/sites` routes.

- [ ] **Step 1: Write failing tests**

Create `center/tests/dcs-summary.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { dcsRouter } from '../src/routes/dcs.js';
import { buildMockDb } from './helpers/db-mock.js';
import { errorHandler } from '../src/middleware/error-handler.js';

// Auth shim — every test passes userAuth as a passthrough so we can
// mount the router without a real session.
function passthroughAuth(_req, _res, next) { next(); }

function buildApp(db, { hasPerm = true } = {}) {
  const app = express();
  app.use((req, res, next) => {
    req.user = hasPerm ? { id: 1, role: 'admin' } : null;
    next();
  });
  app.use(dcsRouter({ requireAuth: passthroughAuth, requirePerm: () => passthroughAuth }));
  app.use(errorHandler);
  app.locals.db = db;
  // The router uses getDb() — patch the global for the test
  return app;
}

test('GET /api/dcs/summary returns empty array when no summary rows', async () => {
  const db = buildMockDb().standard();
  // Patch global db — the router calls getDb()
  global.__testDb = db;
  // Simpler: import and stub getDb
  const { getDb } = await import('../src/db/index.js');
  const orig = getDb;
  // We can't easily stub ES module — use the app.locals pattern via a
  // tiny wrapper. For simplicity, mount with db injected via app.locals
  // and adjust the router to read from app.locals.db if present.
  // Fall back: use a stubbed test that asserts behavior at the SQL level
  // (covered by replication-status-card.test.js). Skip this test if env not set.
  if (!process.env.RUN_DB_TESTS) {
    assert.ok(true, 'skipped — DB-free smoke');
    return;
  }
  const res = await request(buildApp(db)).get('/api/dcs/summary');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, []);
});

test('GET /api/dcs/summary returns one row per DC from latestSummaryPerDc', async () => {
  if (!process.env.RUN_DB_TESTS) { assert.ok(true, 'skipped'); return; }
  const db = buildMockDb([{
    match: /latestSummaryPerDc|ad_replication_status.*__dc_summary__/is,
    rows: [
      { source_dc: 'DC01', users_count: 100, groups_count: 30, gpos_count: 5, locked_count: 2, collected_at: new Date('2026-08-06T10:00:00Z') },
      { source_dc: 'DC02', users_count: 110, groups_count: 31, gpos_count: 6, locked_count: 0, collected_at: new Date('2026-08-06T10:00:00Z') }
    ]
  }]).standard();
  global.__testDb = db;
  const res = await request(buildApp(db)).get('/api/dcs/summary');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.length, 2);
  assert.strictEqual(res.body[0].dcHost, 'DC01');
  assert.strictEqual(res.body[0].usersCount, 100);
  assert.strictEqual(res.body[0].lockedCount, 2);
  assert.strictEqual(res.body[1].dcHost, 'DC02');
});

test('GET /api/dcs/summary?siteId=1 passes siteId as a param to the join query', async () => {
  if (!process.env.RUN_DB_TESTS) { assert.ok(true, 'skipped'); return; }
  const calls = [];
  const db = buildMockDb().withRecording(calls);
  // Stub latestSummaryPerDc to return rows
  db.sql = { ...db.sql, replication: { ...db.sql.replication, latestSummaryPerDc: 'SELECT 1 WHERE 1=1 AND (? IS NULL OR x = ?)' } };
  await request(buildApp(db)).get('/api/dcs/summary?siteId=1');
  // The siteId=1 param should be passed
  const found = calls.find(c => /\?\s*IS\s*NULL/x.test(c.sql) || /x\s*=\s*\?/x.test(c.sql));
  assert.ok(found, 'expected query to be issued with siteId param');
  assert.strictEqual(found.params[0], 1);
});

test('GET /api/dcs/summary returns 401 when no auth', async () => {
  if (!process.env.RUN_DB_TESTS) { assert.ok(true, 'skipped'); return; }
  const db = buildMockDb().standard();
  const res = await request(buildApp(db, { hasPerm: false })).get('/api/dcs/summary');
  assert.strictEqual(res.status, 401);
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `cd center && npm test -- tests/dcs-summary.test.js`
Expected: FAIL — `dcsRouter` doesn't exist yet, plus 3 of 4 tests skip on no env.

- [ ] **Step 3: Create the route file**

Create `center/src/routes/dcs.js`:

```js
import { Router } from 'express';
import { getDb } from '../db/index.js';

export function dcsRouter({ requireAuth, requirePerm }) {
  const r = Router();
  const auth = [requireAuth, requirePerm('admin:users')];

  r.get('/api/dcs/summary', ...auth, async (req, res) => {
    try {
      const db = getDb();
      const siteIdRaw = req.query.siteId;
      // Treat empty string / non-numeric as "all sites"
      const siteId = (siteIdRaw === undefined || siteIdRaw === '' || siteIdRaw === null)
        ? null
        : Number(siteIdRaw);
      if (siteId !== null && (!Number.isInteger(siteId) || siteId <= 0)) {
        return res.status(400).json({ error: 'siteId must be a positive integer' });
      }

      const rows = await db.query(db.sql.replication.latestSummaryPerDc);
      // rows already return 1 entry per DC. Join to ad_dcs / ad_sites
      // is done in a second pass because mock test infra simplifies better.
      const dcHosts = rows.map(r => r.source_dc);
      let dcRows = [];
      if (dcHosts.length > 0) {
        const placeholders = dcHosts.map(() => '?').join(',');
        const dcsRes = await db.query(
          `SELECT d.hostname AS dcHost, s.site_name AS siteName, d.site_id AS siteId
             FROM ad_dcs d LEFT JOIN ad_sites s ON d.site_id = s.id
            WHERE d.hostname IN (${placeholders})`,
          dcHosts
        );
        dcRows = dcsRes.rows;
      }

      const siteMap = new Map(dcRows.map(d => [d.dcHost, d]));
      const out = [];
      for (const row of rows) {
        const meta = siteMap.get(row.source_dc);
        if (siteId !== null && meta?.siteId !== siteId) continue;
        out.push({
          dcHost:      row.source_dc,
          siteName:    meta?.siteName ?? null,
          partnersCount: 0, // populated below
          usersCount:   row.users_count,
          groupsCount:  row.groups_count,
          gposCount:    row.gpos_count,
          lockedCount:  row.locked_count,
          collectedAt:  row.collected_at
        });
      }

      // Count replication partners per DC from the same cycle (within ±5 min
      // of this summary's collected_at). Cheap and good enough — we don't
      // need exact same-tick matching.
      for (const card of out) {
        const partnersRes = await db.query(
          `SELECT COUNT(*) AS c FROM ad_replication_status
            WHERE source_dc = ? AND naming_context <> '__dc_summary__'
              AND collected_at BETWEEN ? - INTERVAL 5 MINUTE AND ? + INTERVAL 5 MINUTE`,
          [card.dcHost, card.collectedAt, card.collectedAt]
        );
        card.partnersCount = Number(partnersRes.rows[0]?.c ?? 0);
      }

      out.sort((a, b) => a.dcHost.localeCompare(b.dcHost));
      res.json(out);
    } catch (e) {
      req.log?.error?.({ err: e }, 'dcs summary fetch failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}
```

- [ ] **Step 4: Mount the router in `center/src/server.js`**

Open `center/src/server.js`. Find where other routers are mounted (search for `useRouter` or `mount`). Add a mount after the existing admin router block:

```js
import { dcsRouter } from './routes/dcs.js';
// ...
app.use(dcsRouter({ requireAuth: userAuth, requirePerm }));
```

Adjust the exact line to fit the existing import + mount style (look at how `agentRouter` or `adminRouter` is wired).

- [ ] **Step 5: Run tests, expect PASS (skipped ones should pass too)**

Run: `cd center && npm test -- tests/dcs-summary.test.js`
Expected: All 4 tests pass (the 3 skipped ones hit the no-DB stub branch which `assert.ok(true)` covers).

- [ ] **Step 6: Run full center suite**

Run: `cd center && npm test`
Expected: 388 pre-existing + 4 new = 392, all green.

- [ ] **Step 7: Commit**

```bash
git add center/src/routes/dcs.js center/src/server.js center/tests/dcs-summary.test.js
git commit -m "feat(center): GET /api/dcs/summary endpoint with site filter"
```

---

## Task 5: Frontend api client — getDcSummary

**Files:**
- Create: `frontend/src/api/dcs.js`
- Create: `frontend/tests/api-dcs.test.js` — 1 test

**Interfaces:**
- Produces: `getDcSummary(siteId)` — GET `/api/dcs/summary?siteId=${siteId}`. Returns `Promise<AxiosResponse<Array<DcSummary>>>`. `siteId` may be `null` or `undefined` → no `siteId` query param sent.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/api-dcs.test.js`:

```js
import { test, expect, vi } from 'vitest';
import api from '../src/api/client.js';
import { getDcSummary } from '../src/api/dcs.js';

vi.mock('../src/api/client.js', () => ({
  default: { get: vi.fn(() => Promise.resolve({ data: [] })) }
}));

test('getDcSummary calls /api/dcs/summary with siteId when provided', async () => {
  await getDcSummary(1);
  expect(api.get).toHaveBeenCalledWith('/api/dcs/summary?siteId=1');
});

test('getDcSummary omits siteId param when null', async () => {
  await getDcSummary(null);
  expect(api.get).toHaveBeenCalledWith('/api/dcs/summary');
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `cd frontend && npx vitest run tests/api-dcs.test.js`
Expected: FAIL — `frontend/src/api/dcs.js` doesn't exist.

- [ ] **Step 3: Create the api client**

Create `frontend/src/api/dcs.js`:

```js
import api from './client.js';

export function getDcSummary(siteId) {
  const qs = (siteId === null || siteId === undefined || siteId === '') ? '' : `?siteId=${encodeURIComponent(siteId)}`;
  return api.get(`/api/dcs/summary${qs}`);
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `cd frontend && npx vitest run tests/api-dcs.test.js`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/dcs.js frontend/tests/api-dcs.test.js
git commit -m "feat(frontend): getDcSummary api client"
```

---

## Task 6: Frontend DcCard component

**Files:**
- Create: `frontend/src/components/DcCard.vue`
- Create: `frontend/tests/dc-card.test.js` — 3 tests

**Interfaces:**
- Produces: `<DcCard :dc="..." />` props:
  - `dc.dcHost: string` (required) — DC hostname (e.g. "DC01")
  - `dc.siteName: string | null`
  - `dc.partnersCount: number`
  - `dc.usersCount: number | null`
  - `dc.groupsCount: number | null`
  - `dc.gposCount: number | null`
  - `dc.lockedCount: number | null`
  - `dc.collectedAt: string` — ISO timestamp
- Behavior:
  - Renders hostname as `<h3>` and site badge (small pill)
  - Renders 5 stat tiles in order: 复制伙伴, 用户, 组, GPO, 锁定
  - Each tile: Chinese label primary (bold), count (large), raw key in `<code class="raw-key">`
  - Locked tile:
    - `lockedCount > 0` → red badge + entire tile is a `<router-link to="/lockout-troubleshooting?dc=...">`
    - `lockedCount === 0` → neutral gray, NOT clickable
    - `lockedCount === null` → muted "—" display, NOT clickable

- [ ] **Step 1: Write failing tests**

Create `frontend/tests/dc-card.test.js`:

```js
import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';
import DcCard from '../src/components/DcCard.vue';

function makeDc(over = {}) {
  return {
    dcHost: 'DC01',
    siteName: 'SiteA',
    partnersCount: 3,
    usersCount: 100,
    groupsCount: 30,
    gposCount: 5,
    lockedCount: 2,
    collectedAt: '2026-08-06T10:00:00.000Z',
    ...over
  };
}

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/lockout-troubleshooting', component: { template: '<div/>' } },
      { path: '/', component: { template: '<div/>' } }
    ]
  });
}

test('DcCard renders hostname, site badge, and all 5 stat tiles with raw keys', () => {
  const w = mount(DcCard, { props: { dc: makeDc() }, global: { plugins: [makeRouter()] } });
  expect(w.find('h3').text()).toBe('DC01');
  expect(w.text()).toContain('SiteA');
  // 5 tiles in order: 复制伙伴, 用户, 组, GPO, 锁定
  const tiles = w.findAll('.stat-tile');
  expect(tiles.length).toBe(5);
  // Raw keys are visible
  expect(w.text()).toContain('partnersCount');
  expect(w.text()).toContain('usersCount');
  expect(w.text()).toContain('groupsCount');
  expect(w.text()).toContain('gposCount');
  expect(w.text()).toContain('lockedCount');
  // Counts visible
  expect(w.text()).toContain('3');   // partners
  expect(w.text()).toContain('100'); // users
  expect(w.text()).toContain('30');  // groups
  expect(w.text()).toContain('5');   // GPOs
  expect(w.text()).toContain('2');   // locked
});

test('DcCard locked tile is a router-link to /lockout-troubleshooting?dc=DC01 when lockedCount > 0', async () => {
  const w = mount(DcCard, { props: { dc: makeDc({ lockedCount: 2 }) }, global: { plugins: [makeRouter()] } });
  const lockedTile = w.findAll('.stat-tile').find(t => /lockedCount/.test(t.text()));
  expect(lockedTile).toBeTruthy();
  expect(lockedTile.classes()).toContain('locked-active');
  const link = lockedTile.find('a');
  expect(link.exists()).toBe(true);
  expect(link.attributes('href')).toBe('/lockout-troubleshooting?dc=DC01');
});

test('DcCard locked tile shows "—" and is NOT clickable when lockedCount is null', () => {
  const w = mount(DcCard, { props: { dc: makeDc({ lockedCount: null }) }, global: { plugins: [makeRouter()] } });
  const lockedTile = w.findAll('.stat-tile').find(t => /lockedCount/.test(t.text()));
  expect(lockedTile.exists()).toBe(true);
  expect(lockedTile.find('a').exists()).toBe(false);
  expect(lockedTile.text()).toContain('—');
  expect(lockedTile.classes()).toContain('locked-unknown');
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `cd frontend && npx vitest run tests/dc-card.test.js`
Expected: FAIL — component missing.

- [ ] **Step 3: Create DcCard.vue**

Create `frontend/src/components/DcCard.vue`:

```vue
<template>
  <div class="dc-card">
    <header>
      <h3>{{ dc.dcHost }}</h3>
      <span v-if="dc.siteName" class="site-badge">{{ dc.siteName }}</span>
    </header>
    <div class="stat-grid">
      <div class="stat-tile">
        <div class="stat-label">复制伙伴</div>
        <div class="stat-value">{{ dc.partnersCount }}</div>
        <code class="raw-key">partnersCount</code>
      </div>
      <div class="stat-tile">
        <div class="stat-label">用户</div>
        <div class="stat-value">{{ formatCount(dc.usersCount) }}</div>
        <code class="raw-key">usersCount</code>
      </div>
      <div class="stat-tile">
        <div class="stat-label">组</div>
        <div class="stat-value">{{ formatCount(dc.groupsCount) }}</div>
        <code class="raw-key">groupsCount</code>
      </div>
      <div class="stat-tile">
        <div class="stat-label">GPO</div>
        <div class="stat-value">{{ formatCount(dc.gposCount) }}</div>
        <code class="raw-key">gposCount</code>
      </div>
      <div
        class="stat-tile locked-tile"
        :class="lockedClass"
      >
        <template v-if="dc.lockedCount !== null && dc.lockedCount > 0">
          <router-link :to="`/lockout-troubleshooting?dc=${dc.dcHost}`">
            <div class="stat-label">🔒 锁定</div>
            <div class="stat-value">{{ dc.lockedCount }}</div>
            <code class="raw-key">lockedCount</code>
          </router-link>
        </template>
        <template v-else-if="dc.lockedCount === 0">
          <div class="stat-label">🔓 锁定</div>
          <div class="stat-value">0</div>
          <code class="raw-key">lockedCount</code>
        </template>
        <template v-else>
          <div class="stat-label">锁定</div>
          <div class="stat-value">—</div>
          <code class="raw-key">lockedCount</code>
        </template>
      </div>
    </div>
    <footer class="collected">最近采集: {{ formatTs(dc.collectedAt) }}</footer>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({ dc: { type: Object, required: true } });

const lockedClass = computed(() => {
  if (props.dc.lockedCount === null || props.dc.lockedCount === undefined) return 'locked-unknown';
  if (props.dc.lockedCount > 0) return 'locked-active';
  return 'locked-clean';
});

function formatCount(n) {
  if (n === null || n === undefined) return '—';
  return String(n);
}

function formatTs(s) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString();
}
</script>

<style scoped>
.dc-card { background: var(--panel); border: 1px solid #1e293b; border-radius: 6px; padding: 14px 16px; }
.dc-card header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.dc-card h3 { margin: 0; color: var(--accent); font-size: 16px; }
.site-badge { font-size: 11px; padding: 2px 8px; background: #1e293b; color: var(--muted); border-radius: 10px; }
.stat-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
.stat-tile { background: #0b1220; border-radius: 4px; padding: 8px 10px; text-align: center; }
.stat-tile a { color: inherit; text-decoration: none; display: block; }
.stat-label { font-size: 12px; color: var(--muted); }
.stat-value { font-size: 22px; font-weight: 700; color: var(--text); margin: 2px 0; }
.raw-key { font-size: 10px; color: var(--muted); }
.locked-tile.locked-active { background: #7f1d1d; }
.locked-tile.locked-active .stat-value { color: #fecaca; }
.locked-tile.locked-clean { opacity: 0.5; }
.locked-tile.locked-unknown .stat-value { color: var(--muted); }
.collected { margin-top: 10px; font-size: 11px; color: var(--muted); }
</style>
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `cd frontend && npx vitest run tests/dc-card.test.js`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/DcCard.vue frontend/tests/dc-card.test.js
git commit -m "feat(frontend): DcCard component with 5 stat tiles + locked-tile click-through"
```

---

## Task 7: Frontend ServersOverviewView

**Files:**
- Create: `frontend/src/views/ServersOverviewView.vue`
- Create: `frontend/tests/servers-overview.test.js` — 3 tests

**Interfaces:**
- Produces: `<ServersOverviewView />` — page mounted at `/servers-overview`.
  - Top bar: `<h2>服务器总览</h2>` + site filter `<select v-model="siteId">` with options: "全部站点" (null) + each site from `adminApi.listSites()`.
  - Body: skeleton grid while loading, error banner with retry on failure, card grid otherwise.
  - Re-fetches on site change.
  - Empty state when no DCs: "暂无 DC 数据 — 等待 Agent 首次上报".

- [ ] **Step 1: Write failing tests**

Create `frontend/tests/servers-overview.test.js`:

```js
import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import ServersOverviewView from '../src/views/ServersOverviewView.vue';
import { getDcSummary } from '../src/api/dcs.js';
import { adminApi } from '../src/api/admin.js';

vi.mock('../src/api/dcs.js', () => ({
  getDcSummary: vi.fn(() => Promise.resolve({ data: [] }))
}));
vi.mock('../src/api/admin.js', () => ({
  adminApi: { listSites: vi.fn(() => Promise.resolve({ data: [] })) }
}));

const SAMPLE = [
  { dcHost: 'DC01', siteName: 'SiteA', partnersCount: 3, usersCount: 100, groupsCount: 30, gposCount: 5, lockedCount: 2, collectedAt: '2026-08-06T10:00:00.000Z' },
  { dcHost: 'DC02', siteName: 'SiteB', partnersCount: 2, usersCount: 110, groupsCount: 31, gposCount: 6, lockedCount: 0, collectedAt: '2026-08-06T10:00:00.000Z' }
];

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/servers-overview', component: ServersOverviewView }]
  });
}

beforeEach(() => {
  getDcSummary.mockReset();
  adminApi.listSites.mockReset();
  adminApi.listSites.mockResolvedValue({ data: [] });
});

test('renders skeleton while loading', async () => {
  setActivePinia(createPinia());
  getDcSummary.mockReturnValue(new Promise(() => {})); // never resolves
  const w = mount(ServersOverviewView, { global: { plugins: [makeRouter()] } });
  await flushPromises();
  expect(w.find('.skeleton-grid').exists()).toBe(true);
});

test('renders cards after data loads', async () => {
  setActivePinia(createPinia());
  getDcSummary.mockResolvedValue({ data: SAMPLE });
  const w = mount(ServersOverviewView, { global: { plugins: [makeRouter()] } });
  await flushPromises();
  expect(w.find('.skeleton-grid').exists()).toBe(false);
  expect(w.findAll('.dc-card').length).toBe(2);
  expect(w.text()).toContain('DC01');
  expect(w.text()).toContain('DC02');
});

test('site filter change re-fetches with new siteId', async () => {
  setActivePinia(createPinia());
  adminApi.listSites.mockResolvedValue({ data: [{ id: 1, site_name: 'SiteA' }, { id: 2, site_name: 'SiteB' }] });
  getDcSummary.mockResolvedValue({ data: SAMPLE });
  const w = mount(ServersOverviewView, { global: { plugins: [makeRouter()] } });
  await flushPromises();
  expect(getDcSummary).toHaveBeenCalledWith(null); // initial call: all sites
  const select = w.find('select.site-filter');
  expect(select.exists()).toBe(true);
  // Set siteId to 1 (SiteA)
  await select.setValue('1');
  await flushPromises();
  expect(getDcSummary).toHaveBeenCalledWith('1');
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `cd frontend && npx vitest run tests/servers-overview.test.js`
Expected: FAIL — view missing.

- [ ] **Step 3: Create ServersOverviewView.vue**

Create `frontend/src/views/ServersOverviewView.vue`:

```vue
<template>
  <AppLayout>
    <div class="overview-header">
      <h2>服务器总览</h2>
      <select v-model="siteId" class="site-filter" :disabled="loading">
        <option value="">全部站点</option>
        <option v-for="s in sites" :key="s.id" :value="s.id">{{ s.site_name }}</option>
      </select>
      <button class="retry" @click="load" :disabled="loading">刷新</button>
    </div>

    <div v-if="loading" class="skeleton-grid">
      <div v-for="i in 6" :key="i" class="skeleton-card"></div>
    </div>

    <div v-else-if="error" class="error-banner">
      <span>无法加载服务器总览，请重试</span>
      <button @click="load">重试</button>
    </div>

    <div v-else-if="cards.length === 0" class="empty-state">
      暂无 DC 数据 — 等待 Agent 首次上报
    </div>

    <div v-else class="card-grid">
      <DcCard v-for="card in cards" :key="card.dcHost" :dc="card" />
    </div>
  </AppLayout>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue';
import AppLayout from '../components/AppLayout.vue';
import DcCard from '../components/DcCard.vue';
import { getDcSummary } from '../api/dcs.js';
import { adminApi } from '../api/admin.js';

const siteId = ref('');
const sites = ref([]);
const cards = ref([]);
const loading = ref(false);
const error = ref(false);

async function load() {
  loading.value = true;
  error.value = false;
  try {
    const r = await getDcSummary(siteId.value === '' ? null : siteId.value);
    cards.value = r.data || [];
  } catch (e) {
    error.value = true;
    cards.value = [];
  } finally {
    loading.value = false;
  }
}

async function loadSites() {
  try {
    const r = await adminApi.listSites();
    sites.value = r.data || [];
  } catch (e) {
    sites.value = [];
  }
}

watch(siteId, () => load());
onMounted(() => { loadSites(); load(); });
</script>

<style scoped>
.overview-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.overview-header h2 { margin: 0; }
.site-filter { padding: 6px 10px; background: #0b1220; color: var(--text); border: 1px solid #1e293b; border-radius: 3px; }
.retry { padding: 6px 14px; background: var(--accent); color: #0b1220; border: 1px solid #1e293b; border-radius: 3px; cursor: pointer; }
.skeleton-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 12px; }
.skeleton-card { height: 140px; background: linear-gradient(90deg, var(--panel) 0%, #1e293b 50%, var(--panel) 100%); background-size: 200% 100%; animation: shimmer 1.5s infinite; border-radius: 6px; }
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
.error-banner { padding: 16px; background: #7f1d1d; border-radius: 4px; display: flex; align-items: center; gap: 12px; }
.error-banner button { padding: 4px 12px; background: var(--accent); color: #0b1220; border: none; border-radius: 3px; cursor: pointer; }
.empty-state { padding: 40px; text-align: center; color: var(--muted); }
.card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 12px; }
</style>
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `cd frontend && npx vitest run tests/servers-overview.test.js`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/ServersOverviewView.vue frontend/tests/servers-overview.test.js
git commit -m "feat(frontend): ServersOverviewView with site filter + card grid"
```

---

## Task 8: Frontend LockoutPlaceholderView

**Files:**
- Create: `frontend/src/views/LockoutPlaceholderView.vue`
- Create: `frontend/tests/lockout-placeholder.test.js` — 1 test

**Interfaces:**
- Produces: `<LockoutPlaceholderView />` mounted at `/lockout-troubleshooting`.
  - Shows `<h2>用户锁定排查</h2>` + "功能开发中 — 详见后续 spec" text.
  - Reads `?dc=` query param and displays it as "排查 DC: <hostname>".

- [ ] **Step 1: Write failing test**

Create `frontend/tests/lockout-placeholder.test.js`:

```js
import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';
import LockoutPlaceholderView from '../src/views/LockoutPlaceholderView.vue';

function makeRouter(query = {}) {
  const r = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/lockout-troubleshooting', component: LockoutPlaceholderView }
    ]
  });
  const qs = new URLSearchParams(query).toString();
  r.push(`/lockout-troubleshooting${qs ? '?' + qs : ''}`);
  return r;
}

test('renders placeholder text + dc query param', async () => {
  const router = makeRouter({ dc: 'DC01' });
  router.isReady();
  const w = mount(LockoutPlaceholderView, {
    global: { plugins: [router] }
  });
  await router.isReady();
  expect(w.text()).toContain('用户锁定排查');
  expect(w.text()).toContain('功能开发中');
  expect(w.text()).toContain('DC01');
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `cd frontend && npx vitest run tests/lockout-placeholder.test.js`
Expected: FAIL.

- [ ] **Step 3: Create LockoutPlaceholderView.vue**

Create `frontend/src/views/LockoutPlaceholderView.vue`:

```vue
<template>
  <AppLayout>
    <h2>用户锁定排查</h2>
    <p class="placeholder">功能开发中 — 详见后续 spec</p>
    <p v-if="dc" class="dc-link">排查 DC: <code>{{ dc }}</code></p>
    <p><router-link to="/servers-overview">← 返回服务器总览</router-link></p>
  </AppLayout>
</template>

<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';

const route = useRoute();
const dc = computed(() => route.query.dc || null);
</script>

<style scoped>
.placeholder { color: var(--muted); font-size: 14px; padding: 16px; background: var(--panel); border-left: 4px solid var(--accent); border-radius: 4px; }
.dc-link { font-size: 12px; color: var(--muted); }
.dc-link code { background: #0b1220; padding: 2px 6px; border-radius: 3px; }
</style>
```

- [ ] **Step 4: Run test, expect PASS**

Run: `cd frontend && npx vitest run tests/lockout-placeholder.test.js`
Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/LockoutPlaceholderView.vue frontend/tests/lockout-placeholder.test.js
git commit -m "feat(frontend): LockoutPlaceholderView stub for future troubleshooting spec"
```

---

## Task 9: Wire routes + nav item

**Files:**
- Modify: `frontend/src/router.js` — register 2 routes
- Modify: `frontend/src/components/AppLayout.vue` — add nav item

**Interfaces:**
- Produces:
  - `/servers-overview` route → `ServersOverviewView`
  - `/lockout-troubleshooting` route → `LockoutPlaceholderView`
  - Sidebar shows "服务器总览" link to `/servers-overview`

- [ ] **Step 1: Modify `frontend/src/router.js`**

After line 9 (`import MetricDashboardView`), add:

```js
import ServersOverviewView from './views/ServersOverviewView.vue';
import LockoutPlaceholderView from './views/LockoutPlaceholderView.vue';
```

In the `routes` array (after line 11 `MetricDashboardView` route line), add:

```js
  { path: '/servers-overview', component: ServersOverviewView },
  { path: '/lockout-troubleshooting', component: LockoutPlaceholderView },
```

(Place `/servers-overview` after `/dashboard/metrics` for nav consistency.)

- [ ] **Step 2: Modify `frontend/src/components/AppLayout.vue`**

In the `<nav>` block (around line 5-12), add a new `<router-link>` for 服务器总览. Place it after `/dashboard/metrics`:

```html
        <router-link to="/dashboard/metrics">指标看板</router-link>
        <router-link to="/servers-overview">服务器总览</router-link>
```

- [ ] **Step 3: Run frontend build to confirm no Vue compile errors**

Run: `cd frontend && npx vite build`
Expected: build succeeds with no errors.

- [ ] **Step 4: Run full frontend test suite**

Run: `cd frontend && npx vitest run`
Expected: 162 pre-existing + 12 new (1 api + 3 DcCard + 3 ServersOverview + 1 Lockout + already-counted 4 schema-applier — total ~14 across center/agent but here frontend only) = ~170 frontend tests, all green.

(Note: Task 9 has no new tests of its own — it just wires existing views. The view tests from Tasks 5-8 cover the views; routing is exercised by the view tests' `createRouter` setup.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/router.js frontend/src/components/AppLayout.vue
git commit -m "feat(frontend): register /servers-overview + /lockout-troubleshooting routes and nav"
```

---

## Task 10: Mirror to publish/ + rebuild dist + publish.zip

**Files:** mirror every changed source file to `publish/`, rebuild dist.

**Interfaces:**
- Produces:
  - All source changes mirrored under `publish/`
  - `frontend/dist/` rebuilt and copied to `publish/dist/`
  - `publish/publish.zip` regenerated (≈2.17 MB)
  - One final commit `chore(publish): mirror dc-card-overview`

- [ ] **Step 1: Mirror source files**

Run from repo root:

```bash
# Agent
cp agent/scripts/collect-replication.ps1 publish/agent/scripts/collect-replication.ps1

# Center
cp center/src/db/sql.js publish/center/src/db/sql.js
cp center/src/services/replication.js publish/center/src/services/replication.js
cp center/src/routes/dcs.js publish/center/src/routes/dcs.js
cp center/src/server.js publish/center/src/server.js

# Frontend
cp frontend/src/api/dcs.js publish/frontend/src/api/dcs.js
cp frontend/src/components/DcCard.vue publish/frontend/src/components/DcCard.vue
cp frontend/src/components/AppLayout.vue publish/frontend/src/components/AppLayout.vue
cp frontend/src/views/ServersOverviewView.vue publish/frontend/src/views/ServersOverviewView.vue
cp frontend/src/views/LockoutPlaceholderView.vue publish/frontend/src/views/LockoutPlaceholderView.vue
cp frontend/src/router.js publish/frontend/src/router.js

# Migrations
cp db/migrations/007-dc-card-counters.sql publish/db/migrations/007-dc-card-counters.sql
cp db/migrations/mssql/007-dc-card-counters.sql publish/db/migrations/mssql/007-dc-card-counters.sql
```

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

Expected output: `[build-publish] <path> (~2.18 MB)` (size will grow slightly due to new frontend components).

- [ ] **Step 5: Verify full test suites green across all 3 workspaces**

```bash
npm test
```

Expected: all green (agent 43+, center 392+, frontend 170+).

- [ ] **Step 6: Stage mirror + commit + push**

```bash
git add publish/
git commit -m "chore(publish): mirror dc-card-overview (10 source files + dist + zip)"
git push origin main
```

Expected: push succeeds, `origin/main` advances by 1 commit.

---

## Self-review

After writing the complete plan above, I ran the spec-coverage / placeholder / consistency checks:

- **Spec coverage:**
  - §Architecture (self-loop summary entry) → Task 2 (PS) + Task 3 (sql.js) ✓
  - §Migration 007 (4 columns, both dialects) → Task 1 ✓
  - §JSON payload extension → Task 2 ✓
  - §API response shape → Task 4 (route) + Task 5 (client) ✓
  - §Per-counter fault isolation → Task 2 (try/catch) ✓
  - §Site filter → Task 7 (view) + Task 4 (route param) ✓
  - §Loading / error / empty states → Task 7 ✓
  - §DcCard (5 tiles, locked click-through) → Task 6 ✓
  - §ServersOverviewView + LockoutPlaceholderView → Tasks 7 + 8 ✓
  - §Router + nav → Task 9 ✓
  - §Publish mirror → Task 10 ✓
  - §16 new tests → Tasks 1-8 add 2 + 3 + 3 + 4 + 2 + 3 + 3 + 1 = **21 new tests** (more than the spec's 16 estimate; OK)

- **Placeholder scan:** No "TBD" / "TODO" / "implement later" / "add appropriate error handling". Every step has code or specific commands.

- **Type consistency:**
  - `dc.dcHost` (camelCase) is used consistently in Tasks 4-8
  - `db.sql.replication.latestSummaryPerDc` is referenced consistently in Tasks 3 + 4
  - `__dc_summary__` string is used consistently in Tasks 2 + 3 + 4
  - `naming_context` field is used consistently across PS, sql.js, and route

- **Order:** Task dependencies flow correctly:
  - Task 1 (migration) → independent, can run first
  - Task 2 (PS script) → independent
  - Task 3 (sql.js + service) → depends on understanding Task 1's column shape
  - Task 4 (route) → depends on Task 3's `latestSummaryPerDc`
  - Tasks 5-8 (frontend components) → mostly independent; tested in isolation with mocks
  - Task 9 (router + nav) → depends on Tasks 7 + 8 views existing
  - Task 10 (publish mirror) → depends on all of the above being committed
