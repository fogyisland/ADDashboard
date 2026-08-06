# Lockout Troubleshooting — Design

## Goal

Replace the existing `/lockout-troubleshooting` placeholder with a real
diagnostic view that lets an admin answer three questions when a user
reports being locked out:

1. **Which DC first locked the user?** (the "source" — earlier than AD
   replication propagation to other DCs)
2. **Who/what is making the bad authentication attempts?** (the
   workstation, service account, or app causing the lockout)
3. **What is the full timeline across the domain?** (so the admin can
   confirm replication has propagated, and identify any DC that's out of
   sync)

Drill-down navigation supports searching by **locked user**, by **DC**,
or by **caller computer**, with all three filters composable in a single
view.

## Architecture

The agent already runs `collect-replication.ps1` every 15 minutes on
each DC and POSTs a single JSON snapshot to the center. This design
**extends that script** to also read Security event log ID 4740 (user
account locked out) from the last 15 minutes, and **extends the center
ingest** to persist those events into a new `ad_lockout_events` table
with server-side deduplication via UNIQUE(dc_name, event_record_id).

A new center endpoint `GET /api/lockout-events/search` accepts three
optional filter dimensions (targetUser / dc / caller) plus a time window
and returns matching events sorted by `occurred_at ASC`.

The frontend replaces `LockoutPlaceholderView` with a single
`LockoutTroubleshootingView` that hosts a multi-filter form, a result
timeline, and click-to-drill-down badges (clicking a DC or caller badge
adds that filter to the URL and re-fetches — no separate pages).

```
[Agent on each DC, every 15 min]
  collect-replication.ps1
    ├── (existing) replication topology → JSON
    ├── (existing) __dc_summary__ counters
    └── (new)      Get-LockoutEvents block:
                    Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4740; StartTime=(Get-Date).AddMinutes(-15)}
                    → [{ eventRecordId, occurredAt, targetUserName,
                         subjectUserName, subjectDomain, callerComputerName }, ...]
    └── POST → /api/agent/replication (existing endpoint, payload extended)

[Center]
  ingest route → INSERT IGNORE into ad_lockout_events
                   (UNIQUE(dc_name, event_record_id) for dedup)
  new route    → GET /api/lockout-events/search
                   ?targetUser=X &dc=DC01 &caller=WS01 &sinceHours=24

[Frontend]
  LockoutTroubleshootingView (route /lockout-troubleshooting)
    → multi-filter form (targetUser / dc / caller / sinceHours)
    → result timeline (each row: time, DC badge, target, subject, caller)
    → earliest row highlighted as "源头" (only when filter is targetUser-only)
    → DC / caller badges click → adds filter to URL + re-fetches (drill-down)
```

## Tech Stack

- **Agent:** Node.js, child_process.spawn → PowerShell 5.1 (existing)
- **Center:** Node.js + Express + mysql2/mssql (existing)
- **Frontend:** Vue 3 + script setup + Pinia + vue-router (existing)

## Global Constraints

- **Single storage path extension.** Lockout event data lives in a new
  `ad_lockout_events` table on the existing center. No new agent-side
  collector, no new scheduler, no new dispatch machinery — the existing
  15-min cycle POSTs both replication topology and lockout events in
  one JSON payload.
- **Agent statelessness.** The agent reads only the last 15 minutes of
  events each cycle (the lookback window equals the polling interval —
  if the polling interval changes, the lookback must change with it,
  defined as the same `pollingIntervalMinutes` config value). Server-side
  UNIQUE(dc_name, event_record_id) guarantees idempotency — agent
  restarts, clock drift, or duplicate windows cannot cause duplicate rows.
- **Per-block fault isolation (agent).** A failure in
  `Get-LockoutEvents` must not poison the replication payload. The new
  block is wrapped in `try { ... } catch { $null }` matching the pattern
  established for the existing 4 card counters.
- **DB / API / backend / audit continue to use snake_case.** UI shows
  Chinese labels as primary caption, raw keys underneath (same pattern
  as commit `e04cc40` for system config and commit `6b990b9` for DcCard).
- **Drill-down via query string, not nested routes.** All three filter
  dimensions compose in a single URL. Clicking a DC badge sets
  `?dc=...` and re-fetches — no `/lockout-troubleshooting/dc/...`
  route.
- **"源头" highlight only when the search is unambiguously about a
  single user.** When only `targetUser` is set, the earliest row in
  the result set is the source DC (before replication propagation).
  When `dc` or `caller` is also set, "source" semantics no longer
  apply, so no row gets the highlight.
- **Read-only view.** No unlock action. Admins run `Unlock-ADAccount`
  manually after diagnosing.
- **All existing tests stay green.** No regressions in agent / center /
  frontend suites.

## Components & files

### Agent

**Modify** `agent/scripts/collect-replication.ps1`
- Add a `Get-LockoutEvents` function:
  ```powershell
  function Get-LockoutEvents {
    [CmdletBinding()]
    param([string]$ComputerName)

    $events = @()
    try {
      $start = (Get-Date).AddMinutes(-15)
      $raw = Get-WinEvent -FilterHashtable @{
        LogName = 'Security'; Id = 4740; StartTime = $start
      } -ErrorAction Stop
      foreach ($e in $raw) {
        $xml = [xml]$e.ToXml()
        $ed = $xml.Event.EventData
        $events += [PSCustomObject]@{
          EventRecordId       = [int64]$e.RecordId
          OccurredAt          = (ConvertTo-UtcIso -Value $e.TimeCreated)
          TargetUserName      = [string]$ed.Data[0].'#text'
          SubjectUserName     = [string]$ed.Data[1].'#text'
          SubjectDomain       = [string]$ed.Data[2].'#text'
          CallerComputerName  = [string]$ed.Data[3].'#text'
        }
      }
    } catch {
      [Console]::Error.WriteLine("lockoutEvents failed: $($_.Exception.Message)")
    }
    return ,$events   # comma operator preserves array even when empty
  }
  ```
  Note: `Get-WinEvent -FilterHashtable` does not accept `-ComputerName`
  on PS 5.1 (it requires `-ComputerName` only for non-Hashhtable form).
  The agent runs locally on each DC, so `-ComputerName` is unnecessary.
  If remote collection is needed later, switch to
  `Get-WinEvent -ComputerName $ComputerName -FilterHashtable @{...}` on
  pwsh 7+ only.

- Append to `$snapshot.Entries` after the `__dc_summary__` entry:
  ```powershell
  $lockoutEvents = Get-LockoutEvents -ComputerName $ComputerName
  # Carry lockoutEvents as a top-level snapshot field (not as an Entry,
  # because lockout events aren't replication rows).
  $snapshot | Add-Member -NotePropertyName LockoutEvents `
                        -NotePropertyValue $lockoutEvents
  ```

- Extend `ConvertTo-SnapshotJson` to include `LockoutEvents` if present.

**Modify** `agent/tests/collect-replication.test.js`
- 4 new tests:
  1. `Get-LockoutEvents function exists`
  2. `Get-ReplicationSnapshot output contains LockoutEvents field`
  3. `each lockout event carries eventRecordId, occurredAt, targetUserName, subjectUserName, subjectDomain, callerComputerName`
  4. `Get-WinEvent failure leaves LockoutEvents as [] but other snapshot fields intact`

### Center

**Create** `db/migrations/008-lockout-events.sql` (mysql + mssql)
- `CREATE TABLE IF NOT EXISTS ad_lockout_events (...)` with the columns
  and indexes listed in the Data shape section below.
- MySQL: 1 statement (`CREATE TABLE IF NOT EXISTS ad_lockout_events (...)`).
- MSSQL: 2 statements (MSSQL does not support `CREATE TABLE IF NOT EXISTS`
  — use the project's established `IF OBJECT_ID('ad_lockout_events', 'U') IS NULL`
  guard pattern from earlier migrations, then the `CREATE TABLE`).
- Both dialects idempotent: re-running migration 008 is a no-op.

**Modify** `center/src/db/sql.js`
- New registry block:
  ```
  lockout: {
    upsertEvent: `INSERT INTO ad_lockout_events
                   (occurred_at, collected_at, agent_id, dc_name, event_record_id,
                    target_user_name, subject_user_name, subject_domain, caller_computer_name)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON DUPLICATE KEY UPDATE collected_at = VALUES(collected_at)`,
    search:      `SELECT occurred_at, dc_name, target_user_name, subject_user_name,
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
  MSSQL variants:
  - `upsertEvent`: MERGE on `(dc_name, event_record_id)` key.
  - `search`: same logic, `IF ? = '' OR col = ?` form.

**Modify** `center/src/routes/agent.js`
- In the existing replication ingest handler, after the topology
  entries are processed, also iterate `payload.lockoutEvents || []`
  and call `db.sql.lockout.upsertEvent` per event. Wrap in
  `try { ... } catch { req.log?.warn?.(...) }` so a lockout-write
  failure doesn't fail the whole ingest.

**Create** `center/src/routes/lockout.js`
- `GET /api/lockout-events/search` with the validation rules below.
- Auth: `[userAuth, requirePerm('admin:users')]`.
- Response: array sorted by `occurred_at ASC`.
- The `isSource` flag is computed in JS (not SQL): when query has only
  `targetUser` set (no dc, no caller), the first row in the result gets
  `isSource: true`; all others get `isSource: false`.

**Modify** `center/src/server.js`
- Mount `lockoutRouter` alongside `dcsRouter` in the same `else` branch
  (matches pattern from dc-card-overview).

**Create** `center/tests/lockout-search.test.js` — 6 tests
1. `GET /api/lockout-events/search with targetUser returns rows sorted by occurred_at ASC`
2. `GET ... with dc filter returns only matching dc rows`
3. `GET ... with caller filter returns only matching caller rows`
4. `GET ... with all three filters returns intersection`
5. `GET ... with no filter dimension returns 400`
6. `GET ... with sinceHours=999 returns 400`

**Extend** `center/tests/init/schema-applier.test.js` — 2 tests
1. `splitSqlStatements parses migration 008 mysql`
2. `splitSqlStatements parses migration 008 mssql`

### Frontend

**Replace** `frontend/src/views/LockoutPlaceholderView.vue` →
`frontend/src/views/LockoutTroubleshootingView.vue`
- Top filter bar: 3 input fields (targetUser / dc / caller) + time
  window select (1h / 6h / 24h / 7d) + 查询 button.
- Query button is **disabled** when all three filter inputs are empty
  (matches backend 400 contract).
- Loading skeleton (3 rows) while fetching.
- Error banner with retry button on failure.
- Empty state when result is `[]`: "无匹配事件 — 尝试调整过滤或扩大时间窗口".
- Result list:
  - Each row: ⭐ (only on source row), time, DC badge, target user,
    subject, caller.
  - DC badge → click sets `?dc=...` (preserving other filters) +
    re-fetches.
  - Caller badge → click sets `?caller=...` + re-fetches.
  - Subject and target are plain text (not clickable in v1).
- Footer: "共 N 条事件".
- Reads URL query params on mount: if `?dc=...` or `?caller=...` is
  present, pre-fill those inputs and submit immediately. (Enables
  drill-down from the card view's locked-tile link.)

**Create** `frontend/src/api/lockout.js`
- `searchLockoutEvents({ targetUser, dc, caller, sinceHours })`
  → GET `/api/lockout-events/search?...` building query string from
  non-empty fields.

**Create** `frontend/tests/lockout-troubleshooting.test.js` — 4 tests
1. Renders 3 input fields + time select + 查询 button; button
   disabled when all inputs empty.
2. Submit triggers searchLockoutEvents with composed params; renders
   result rows.
3. With only `targetUser` filter, first row gets ⭐ and "源头" label.
4. Click DC badge updates URL query and triggers re-fetch with new
   `dc` filter.

(No router change needed — `/lockout-troubleshooting` already routes
to this view from Task 9 of dc-card-overview; we just replace the
component.)

### Publish mirror

- Mirror all modified/new source files under `publish/`
- Rebuild `frontend/dist/` and copy to `publish/dist/`
- Regenerate `publish/publish.zip` via `scripts/build-publish-zip.ps1`

## Data shape

### New table `ad_lockout_events`

```sql
CREATE TABLE IF NOT EXISTS ad_lockout_events (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  occurred_at           DATETIME NOT NULL,      -- event TimeGenerated
  collected_at          DATETIME NOT NULL,      -- when center received it
  agent_id              VARCHAR(64)  NOT NULL,
  dc_name               VARCHAR(128) NOT NULL,
  event_record_id       BIGINT       NOT NULL,  -- Windows EventRecordID
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

### JSON payload extension (agent → center)

```json
{
  "dc": "DC01",
  "site": "SiteA",
  "partners": [...],
  "usersCount": 1243,
  "groupsCount": 312,
  "gposCount": 47,
  "lockedCount": 2,
  "lockoutEvents": [
    {
      "eventRecordId":      12345678,
      "occurredAt":         "2026-08-06T14:32:11.000Z",
      "targetUserName":     "alice",
      "subjectUserName":    "DC01$",
      "subjectDomain":      "CORP",
      "callerComputerName": "WS-DEV-42"
    }
  ]
}
```

### API response (center → frontend)

```
GET /api/lockout-events/search?targetUser=alice&sinceHours=24
```

```json
[
  {
    "occurredAt":         "2026-08-06T14:32:11.000Z",
    "dcName":             "DC01",
    "targetUserName":     "alice",
    "subjectUserName":    "DC01$",
    "subjectDomain":      "CORP",
    "callerComputerName": "WS-DEV-42",
    "isSource":           true
  },
  { "...": "...", "isSource": false }
]
```

`isSource` is true **only** on the first row when the query was
made with only `targetUser` (no `dc` / `caller` filters). Otherwise all
rows have `isSource: false`.

### Validation

- At least one of `targetUser` / `dc` / `caller` must be non-empty.
- `sinceHours` must be an integer in `[1, 168]` (1 hour to 7 days).
- 400 with `{error: "..."}` on violation.
- 401 on missing/invalid token.

## Error handling

- **Get-LockoutEvents fails (agent):** block wrapped in try/catch, returns
  `[]`. Replication payload stays valid. Stderr logs the error message.
  `lockoutEvents` field will be `[]` in the snapshot JSON.
- **Get-WinEvent returns no events:** `$events` stays `[]`. Snapshot still
  valid.
- **Per-event INSERT fails (center):** logged as warning, ingest continues.
  Next cycle will retry the same event (UNIQUE constraint catches true
  duplicates, but a transient failure on a fresh event will succeed on
  next try).
- **Search API no filter dimension:** 400.
- **Search API sinceHours out of range:** 400.
- **Frontend network failure:** error banner with retry button.
- **Empty result set:** "无匹配事件 — 尝试调整过滤或扩大时间窗口"
  message instead of a blank list.

## Testing strategy

| Layer | File | New tests |
|-------|------|-----------|
| Agent | `tests/collect-replication.test.js` (extend) | 4 |
| Center migration | `tests/init/schema-applier.test.js` (extend) | 2 |
| Center API | `tests/lockout-search.test.js` (new) | 6 |
| Frontend | `tests/lockout-troubleshooting.test.js` (new) | 4 |

**Total new tests: 16.**

Existing baselines after dc-card-overview: agent 43, center 387,
frontend 171.

Target after: agent 47, center 395 (incl. 2 migration), frontend 175.

### Key cross-task contracts to verify in tests

1. **Snapshot field name:** agent emits `lockoutEvents` (camelCase,
   consistent with `usersCount` / `lockedCount` from dc-card-overview).
2. **EventRecordId type:** BIGINT (not INT) — Windows event log IDs can
   exceed 2^31 on long-running DCs.
3. **isSource computation:** strictly tied to query shape, not row
   content. Frontend test for ⭐ must seed multiple rows and verify the
   ⭐ goes on row[0] when only `targetUser` is set, and on no row when
   `dc` or `caller` is also set.
4. **DC badge click:** preserves other filters in URL — not "navigate
   to a new page".

## Out of scope (explicit YAGNI)

- **Active unlock action.** No "Unlock this user" button. Admins run
  `Unlock-ADAccount` manually.
- **Event ID 4625 (failed logon attempts).** 4740 fires only on the lock
  boundary; 4625 fires for every bad password and balloons storage.
  Re-evaluate if ops need "what attempts led to this lockout" detail.
- **Automatic retention cleanup.** Keep all events indefinitely.
  Storage is manageable (a few MB / DC / year at typical rates). Add
  retention policy only if it becomes a real problem.
- **Real-time push (WMI event subscription / ETW).** Stick with the
  existing 15-min polling cadence.
- **Active alerting** ("X users locked in the last hour"). The existing
  `lockedCount` tile on the per-DC cards already surfaces current
  locked-user counts; per-domain alerting is a separate feature.
- **Per-user statistics** ("alice has been locked 14 times this
  month"). Timeline already shows count.
- **Caller → user mapping** ("WS-DEV-42 has been attacking user X, Y,
  Z"). Caller-only filter exists; multi-target aggregation does not.

## Risks

1. **Get-WinEvent can be slow on a busy DC with millions of Security
   events.** Mitigation: the `-StartTime` filter limits the window, and
   Id=4740 narrows further. Empirically <1s per DC in typical domains.
2. **EventRecordID is per-log, not global.** Two DCs may have the same
   RecordID for unrelated events — UNIQUE(dc_name, event_record_id)
   correctly scopes dedup per-DC.
3. **`targetUserName` in event log includes the domain suffix sometimes**
   (e.g. `CORP\alice` vs `alice`). Backend stores the raw value; UI
   search is exact-match. If users complain, add a normalization step
   in the agent script (`$targetUserName -replace '^.*\\', ''`). Not
   added in v1 to keep behavior explicit.
4. **The agent's `-FilterHashtable` form does not accept `-ComputerName`
   on PS 5.1.** Mitigation: agent runs locally on each DC, so
   `-ComputerName` is not needed. Documented in the script comment.
5. **Card view's locked-tile link (`?dc=...`) currently goes to
   placeholder; replacing the component preserves the URL contract.**
   Verify in dc-card-overview Task 6/9 tests still pass.
6. **Migration 008 grows the center DB.** A busy domain accumulates
   ~10k events/year per DC. At 50 DCs = 500k rows/year. Comfortable for
   InnoDB; monitor if domain grows much beyond 100 DCs.

## Compatibility with dc-card-overview

- The existing dc-card-overview feature ships `lockedCount` per DC as
  a counter. This spec adds **per-event** lockout detail. They are
  complementary — `lockedCount` answers "how many users are currently
  locked on this DC" (Search-ADAccount); this spec answers "who got
  locked recently and where" (Security event 4740).
- The card view's `/lockout-troubleshooting?dc=DC01` link will now
  pre-fill the new view with `dc=DC01` and immediately fetch events
  on that DC — a useful drill-down entry. Verify the existing
  `lockout-placeholder.test.js` is removed (the placeholder view is
  gone) and replaced by `lockout-troubleshooting.test.js`.