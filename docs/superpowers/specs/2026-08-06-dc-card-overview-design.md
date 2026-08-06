# Per-DC Card Overview — Design

## Goal

Add a new top-level admin view "服务器总览" (Server Overview) that shows a
responsive card grid — one card per discovered DC — with 4 summary
counters per card: **AD users, groups, GPOs, and currently locked-out
users**, plus the existing replication partner count. The locked-users
card links to a (placeholder) lockout-troubleshooting page that will be
specified separately.

## Architecture

The agent already runs `collect-replication.ps1` every polling interval
(default 15 min) on each DC and POSTs a JSON snapshot to the center.
This design **extends that script** to emit 4 additional counters at the
top level of the payload, and **extends the existing
`ad_replication_status` table** with 4 nullable columns. One script, one
HTTP POST, one storage path, zero new dispatch machinery.

```
[Agent on each DC, every 15 min]
  collect-replication.ps1
    ├── (existing) replication topology → JSON
    └── (new)      4 counters (each try/catch-isolated):
                    usersCount    = (Get-ADUser   -Filter * -Server $dc).Count
                    groupsCount   = (Get-ADGroup  -Filter * -Server $dc).Count
                    gposCount     = (Get-GPO      -All          ).Count
                    lockedCount   = (Search-ADAccount -LockedOut -Server $dc).Count
    └── POST → /api/agent/replication (existing endpoint, payload extended)

[Center]
  ingest route → upsert into ad_replication_status (4 new nullable cols)
  new route    → GET /api/dcs/summary?siteId=X

[Frontend]
  ServersOverviewView.vue (route /servers-overview)
    → site filter dropdown (All / Site A / Site B)
    → responsive card grid (1-3 cols by viewport)
    → DcCard.vue per DC:
          hostname, site badge, replication partners count
          ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
          │ 用户 1,243│ │ 组   312 │ │ GPO    47│ │🔒 锁定 2  │
          └──────────┘ └──────────┘ └──────────┘ └──────────┘
          "锁定 2" link → /lockout-troubleshooting?dc=X (placeholder)
```

## Tech Stack

- **Agent:** Node.js, child_process.spawn → PowerShell 5.1 (existing)
- **Center:** Node.js + Express + mysql2/mssql (existing)
- **Frontend:** Vue 3 + script setup + Pinia + vue-router (existing)

## Global Constraints

- **Single storage path.** Counter data lives on the existing
  `ad_replication_status` table. No new agent-side collector, no new
  endpoint, no new scheduler.
- **Reuse existing dispatch.** Same 15-min cadence as replication. Same
  retry / error semantics in `runCollector`.
- **Per-counter fault isolation.** A failure in any of the 4 new
  counters must not poison the existing replication payload or the
  other counters. Each counter is wrapped in `try { ... } catch {
  $null }` on the agent side; `null` propagates to DB and to UI.
- **DB / API / backend / audit continue to use snake_case.** UI shows
  Chinese labels as the primary caption; raw keys (e.g.
  `users_count`) stay visible underneath for traceability (matches the
  pattern established in commit `e04cc40` for the system config page).
- **All existing tests stay green.** No regressions in agent / center /
  frontend suites.

## Components & files

### Agent

**Modify** `agent/scripts/collect-replication.ps1`
- After the existing replication topology block, emit 4 new top-level
  fields in the JSON payload:
  ```powershell
  $payload = [ordered]@{
    dc           = $ComputerName
    site         = ...
    partners     = @(...)      # existing
    usersCount   = $null
    groupsCount  = $null
    gposCount    = $null
    lockedCount  = $null
  }

  try { $payload.usersCount  = (Get-ADUser   -Filter * -Server $dc).Count } catch { ... }
  try { $payload.groupsCount = (Get-ADGroup  -Filter * -Server $dc).Count } catch { ... }
  try { $payload.gposCount   = (Get-GPO      -All              ).Count   } catch { ... }
  try { $payload.lockedCount = (Search-ADAccount -LockedOut -Server $dc).Count } catch { ... }
  ```
- Each catch writes the error message to stderr but does not fail the
  script — the replication payload stays valid.

**Extend** `agent/tests/collect-replication.test.js`
- Add test: "emits all 4 counters when AD cmdlets succeed"
- Add test: "emits null for a failed counter, succeeds for the others"
  (mock one cmdlet to throw, assert others populated)
- Add test: "preserves existing replication payload shape when counter
  block fails"

### Center

**Create** `db/migrations/007-dc-card-counters.sql` (mysql + mssql)
- `ALTER TABLE ad_replication_status ADD COLUMN users_count INT NULL,
   ADD COLUMN groups_count INT NULL, ADD COLUMN gpos_count INT NULL,
   ADD COLUMN locked_count INT NULL;`
- MySQL: `ADD COLUMN users_count INT NULL AFTER last_failure`
- MSSQL: same shape (ADD COLUMN x INT NULL)
- Idempotent: NOT (mysql doesn't support `IF NOT EXISTS` on ADD COLUMN
  in 5.7, so guard via `INFORMATION_SCHEMA` lookup for MSSQL; for MySQL
  use `IF NOT EXISTS` workaround with `INFORMATION_SCHEMA.COLUMNS`).

**Modify** `center/src/db/sql.js`
- Extend `replicationStatus.upsert` (both dialects) to bind the 4 new
  params. Place them in the same order in both dialects.
- Add new query: `replicationStatus.latestPerDc(dialect)`:
  - MySQL: window function `ROW_NUMBER() OVER (PARTITION BY dc_host
    ORDER BY collected_at DESC)` joined back; returns 1 row per DC.
  - MSSQL: `OUTER APPLY (SELECT TOP 1 ... ORDER BY collected_at DESC)`
    same shape.

**Modify** `center/src/routes/agent.js`
- In the existing replication ingest route, read `usersCount`,
  `groupsCount`, `gposCount`, `lockedCount` from the payload and pass
  them as the trailing 4 params to `db.sql.replicationStatus.upsert`.
- If missing from the payload (older agent version), pass `null`.

**Create** `center/src/routes/dcs.js`
- `GET /api/dcs/summary?siteId=X` (mounted in `center/src/server.js`
  under existing `/api` prefix).
- Query joins:
  ```
  replication_status (latest per dc_host)
    LEFT JOIN ad_dcs    ON ad_dcs.hostname = replication_status.dc_host
    LEFT JOIN ad_sites  ON ad_sites.id      = ad_dcs.site_id
  WHERE (@siteId IS NULL OR ad_sites.id = @siteId)
  ```
- Response: `[{ dcHost, siteName, partnersCount, usersCount,
  groupsCount, gposCount, lockedCount, collectedAt, lastFailure }]`
- Mounted in server.js alongside other `/api/admin/dcs-catalog` routes
  with same `[userAuth, requirePerm('admin:users')]` middleware. (Read
  access for any admin — no separate "view cards" permission.)
- Audit: NOT audited (this is a read-only aggregate view).

**Create** `center/tests/dcs-summary.test.js` — 4 tests
- `200 returns empty array when DB has no replication_status rows`
- `200 returns one row per DC (latest per dc_host via window function)`
- `200 filters by siteId — DCs in other sites excluded`
- `200 surfaces null for failed counters (display as "—" in UI)`

**Extend** `center/tests/init/schema-applier.test.js` — 2 tests
- `splitSqlStatements parses migration 007 for both dialects`
- `applyAll mysql: migration 007 ALTER TABLE issues during pipeline`

### Frontend

**Create** `frontend/src/components/DcCard.vue` — props: `dc` object
- Renders: hostname (h3), site badge (small pill), replication partners
  count, then 4 stat tiles in a 2x2 grid inside the card.
- Each tile shows: Chinese label (primary, bold), the count (large),
  and the raw snake_case key as `<code class="raw-key">` underneath.
- Locked tile styling:
  - `lockedCount > 0` → red badge + the whole tile is clickable
  - `lockedCount === 0` → neutral gray, tile not clickable
  - `lockedCount === null` → muted "—" tile
- Locked tile click → `router.push('/lockout-troubleshooting?dc=' +
  dc.dcHost)`

**Create** `frontend/src/views/ServersOverviewView.vue`
- `<AppLayout>` shell
- Top bar: `<h2>服务器总览</h2>` + site filter `<select v-model>` with
  options loaded from `/api/sites` (existing endpoint)
- `<div v-if="loading" class="skeleton-grid">...</div>` — 6 skeleton
  cards while loading
- `<div v-else-if="error" class="error-banner">...</div>` — retry
  button
- `<div v-else class="card-grid">` — v-for over `cards`, render
  `<DcCard :dc="card" />`
- Cards animate with a 150ms fade on site-filter change (Vue
  `<TransitionGroup>`).

**Create** `frontend/src/views/LockoutPlaceholderView.vue`
- Simple page: `<h2>用户锁定排查</h2> <p>功能开发中 — 详见后续 spec</p>`
- Shows the `?dc=` query param if present (so the user knows the link
  from the card is wired up correctly).

**Create** `frontend/src/api/dcs.js` — `getDcSummary(siteId)` → GET
`/api/dcs/summary?siteId=${siteId}`. Returns array.

**Modify** `frontend/src/router.js` (or wherever routes live — same
  file as for `/admin/*`) — register:
  ```
  /servers-overview        → ServersOverviewView
  /lockout-troubleshooting → LockoutPlaceholderView
  ```

**Modify** `frontend/src/components/AppSidebar.vue` (or equivalent
  navigation shell) — add nav item:
  ```
  服务器总览  →  /servers-overview
  ```
  placed after "状态总览" or wherever the dashboard nav lives today.

**Create** `frontend/tests/dc-card.test.js` — 3 tests
- Renders all 4 stat tiles + replication partners count
- Locked tile with count > 0 renders as a clickable router-link
- Locked tile with `null` count renders "—" and is not clickable

**Create** `frontend/tests/servers-overview.test.js` — 3 tests
- Renders skeleton on initial load
- Renders cards after data loads
- Site filter change re-fetches with new siteId

**Create** `frontend/tests/lockout-placeholder.test.js` — 1 test
- Renders "功能开发中" placeholder text + the dc query param

### Publish mirror

- Mirror all modified/new source files under `publish/`
- Rebuild `frontend/dist/` and copy to `publish/dist/`
- Regenerate `publish/publish.zip` via `scripts/build-publish-zip.ps1`

## Data shape

### JSON payload extension (agent → center, top-level keys)
```json
{
  "dc": "DC01",
  "site": "SiteA",
  "partners": [
    { "name": "DC02", "partition": "...", "lastSuccess": "..." }
  ],
  "usersCount":   1243,
  "groupsCount":  312,
  "gposCount":     47,
  "lockedCount":    2
}
```

### API response (center → frontend)
```json
[
  {
    "dcHost":        "DC01",
    "siteName":      "SiteA",
    "partnersCount":  3,
    "usersCount":    1243,
    "groupsCount":   312,
    "gposCount":      47,
    "lockedCount":      2,
    "collectedAt":   "2026-08-06T10:15:00.000Z",
    "lastFailure":   null
  }
]
```

## Error handling

- **Per-counter failure (agent):** `try { ... } catch { $null }` per
  counter. Replication payload stays valid. Stderr logs the error.
- **Counter field missing from payload (older agent):** center route
  binds `null` for that param. DB stores `NULL`. UI shows "—".
- **Endpoint failure (frontend):** top-of-page banner with retry
  button. Cards don't render.
- **Empty replication_status table:** backend returns `[]`. Frontend
  shows "暂无 DC 数据 — 等待 Agent 首次上报" placeholder.
- **DC missing site assignment:** shown under "All sites" only, with a
  small warning icon on the card; excluded from specific-site filters.

## Testing strategy

| Layer | File | New tests |
|-------|------|-----------|
| Agent | `tests/collect-replication.test.js` (extend) | 3 (counters emit, fail-isolation, shape-preserve) |
| Center migration | `tests/init/schema-applier.test.js` (extend) | 2 (parse + applyAll smoke) |
| Center API | `tests/dcs-summary.test.js` (new) | 4 |
| Frontend component | `tests/dc-card.test.js` (new) | 3 |
| Frontend view | `tests/servers-overview.test.js` (new) | 3 |
| Frontend placeholder | `tests/lockout-placeholder.test.js` (new) | 1 |

Total new tests: **16**. Existing: agent 40, center 385, frontend 162.
Target after: agent 43+, center 391+, frontend 169+.

## Out of scope (explicit YAGNI)

- Live refresh / push from server (cards refresh on page mount + site
  filter change only)
- Sortable cards, search box, virtual scroll (typical ≤50 DCs)
- Per-counter drill-down (e.g. "show me the 2 locked users from this
  card") — that's the lockout-troubleshooting spec
- Historical trending of counters (latest row only on this view;
  `ad_replication_status` already keeps history)
- Per-site permission scoping (all admins see all sites)
- DC addition / editing / status changes from this view (those live on
  existing `DcsCatalogView` / `ActiveDcsView`)

## Risks

1. **`Get-ADUser -Filter *` is slow on huge forests** (10k+ objects
   can take 5-10s). Mitigated: the 15-min cadence absorbs this; if it
   causes polling timeouts in production, we can move counters to a
   longer-cadence separate script later (Approach B from brainstorming).
2. **MSSQL `ADD COLUMN` is not idempotent in old versions.** Guarded
   via `INFORMATION_SCHEMA.COLUMNS` lookup before the ALTER (same
   pattern used in earlier migrations).
3. **Card UI is snake_case + Chinese labels — could feel inconsistent
   with the rest of the app.** Mitigated: same pattern as system config
   (commit `e04cc40`); can revert if users object.
4. **Window function / OUTER APPLY may be unfamiliar to readers.** Add
   inline SQL comments explaining the "latest per group" idiom.

## Lockout troubleshooting (separate spec — NOT in this one)

The locked-users tile on each card links to `/lockout-troubleshooting`,
which this spec only stubs with a placeholder page. The real feature —
collecting Security event log 4740 from each agent, persisting
`user_lockout_events` table, building a search/history UI — will be
brainstormed in its own session.
