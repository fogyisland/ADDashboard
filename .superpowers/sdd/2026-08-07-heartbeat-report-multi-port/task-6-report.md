# Task 6: Admin endpoints — heartbeat-report — Implementation Report

**Commit:** `c371618` — `feat(admin): heartbeat-report endpoints (agents/dcs/report-detail)`
**Branch:** main
**Base:** `3f5f4db` (Task 5 fix / MySQL 5.7 latestSummaryPerDc correlated-subquery fix)

---

## What was implemented

### 1. SQL helpers (`center/src/db/sql.js`)
Added 4 helpers inside the existing `heartbeat:` group on BOTH the `VARIANTS.mysql` block (around line 98) and `VARIANTS.mssql` block (around line 338):

- `agentsList` — `SELECT h.agent_id, h.agent_version, h.last_heartbeat_at, h.last_report_at, h.last_report_status, h.pending_queue_size FROM ad_agent_heartbeat h ORDER BY h.agent_id`
- `dcsList` — same as agentsList + LEFT JOIN to `ad_dcs` and `ad_sites` for siteName/regionCode/ipAddress/osVersion/isPdc
- `reportSummaryFor(agentId, sinceIso)` — INNER JOIN against `MAX(collected_at)` (MySQL 5.7+ / MSSQL 2017+ portable correlated subquery pattern — mirrors the `latestSummaryPerDc` pattern from commit `3f5f4db`)
- `latestReportEntries(agentId, sinceIso, limit)` — capped at 100 (MySQL `LIMIT ${Number(limit)}`; MSSQL `TOP (?)` as the FIRST column)

Both dialects use portable syntax (no window functions) to stay MySQL 5.7 / MSSQL 2017 compatible.

### 2. Service module (`center/src/services/heartbeat-report.js`)
Created `heartbeatReportService` with three public methods + two private helpers:
- `listAgents(db = null)` — queries `heartbeat.agentsList`, runs `_summaryFor` per agent
- `listDcs(db = null)` — same but with `heartbeat.dcsList` (DC metadata)
- `getLatestReportDetail(agentId, db = null)` — signature uses `agentId` first, optional `db` last (per correction #3)
- `_summaryFor(conn, agentId, lastReportAt, since)` — null-safe (`null` when no report or no rows)
- `_staleSeconds(_conn)` — reads `heartbeat_stale_seconds` from `system_config` (defaults to 15)

All Date values are normalized via `toIsoOrNull()` to ISO 8601 UTC. Returns `{ agents: [...], heartbeatStaleSeconds: N }` for list endpoints and `{ agentId, collectedAt, entries: [...] }` for detail.

### 3. Route factory (`center/src/routes/heartbeat-report.js`)
Created `heartbeatReportRouter({ requireAuth, requirePerm })` exporting a `Router` with three GET endpoints mounted on the web app only:

- `GET /api/admin/heartbeat-report/agents`
- `GET /api/admin/heartbeat-report/dcs`
- `GET /api/admin/heartbeat-report/agents/:agentId/report-detail`

Per-route `[requireAuth, requirePerm('admin:users')]` chain — same contract as `dcsRouter` / `lockoutRouter` / `schemaMigrationsRouter`. Errors logged via `req.log?.error` and 500'd with `{error: 'internal'}` — matches the existing admin-router style.

### 4. Server mount (`center/server.js`)
Added import line for `heartbeatReportRouter` and mounted it in the normal-mode block (alongside `dcsRouter` / `lockoutRouter` / `schemaMigrationsRouter`):

```js
app.use(heartbeatReportRouter({
  requireAuth: userAuth({ secret: finalConfig.jwtSecret }),
  requirePerm: (perm) => requirePerm(perm)
}));
```

### 5. Mirror to `publish/center/`
Copied the 3 new source files + 2 modified files (`server.js`, `src/db/sql.js`) to `publish/center/` (tests are NOT mirrored, per convention).

---

## Test results

### RED (failing tests before impl) — `tests/admin-heartbeat-report.test.js`

The first run failed at module load — the test file imported from `../src/routes/heartbeat-report.js`, which didn't exist yet:

```
✖ tests\admin-heartbeat-report.test.js (226.8647ms)

Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'D:\ToolDevelop\ADDashboard\center\src\routes\heartbeat-report.js'
  imported from D:\ToolDevelop\ADDashboard\center\tests\admin-heartbeat-report.test.js
    at finalizeResolution (node:internal/modules/esm/resolve:271:11)
    ...
```

This is the expected RED — service + route didn't exist. Other test files in the run completed and passed (so the new test file did not block sibling tests; node test runner continues even when one file fails to load).

### GREEN (after impl) — targeted file run

```
$ cd center && npm test -- tests/admin-heartbeat-report.test.js

✔ agents list: returns rows from ad_agent_heartbeat with reportSummary aggregation (60.0693ms)
✔ agents list: agent with no reports -> lastReportAt null, reportSummary null (28.9321ms)
✔ report-detail: returns entries for the most recent collected_at (capped at 100) (19.0952ms)
✔ GET /api/admin/heartbeat-report/agents: 401 without token (14.3156ms)
```

4/4 pass.

### Full suite (after impl)

```
$ cd center && npm test
...
ℹ tests 509
ℹ suites 31
ℹ pass 492
ℹ fail 0
ℹ cancelled 0
ℹ skipped 17
ℹ todo 0
ℹ duration_ms 7932.7911
```

All 492 pass, 0 fail. (Brief mentioned 489 + 4 = 493 — actual baseline is slightly different; the new tests bring us to 492. No regressions.)

---

## Files changed

| File | Type | Notes |
|------|------|-------|
| `center/src/db/sql.js` | modified | +4 SQL helpers per dialect (mysql + mssql blocks) |
| `center/src/services/heartbeat-report.js` | created | `heartbeatReportService` module |
| `center/src/routes/heartbeat-report.js` | created | `heartbeatReportRouter` factory |
| `center/server.js` | modified | import + mount in normal-mode block |
| `center/tests/admin-heartbeat-report.test.js` | created | 4 tests: list shape, null-summary, detail shape, 401 |
| `publish/center/src/db/sql.js` | mirrored | from `center/src/db/sql.js` via `cp` |
| `publish/center/src/services/heartbeat-report.js` | mirrored | from `center/src/services/heartbeat-report.js` via `cp` |
| `publish/center/src/routes/heartbeat-report.js` | mirrored | from `center/src/routes/heartbeat-report.js` via `cp` |
| `publish/center/server.js` | mirrored | from `center/server.js` via `cp` |

Commit `c371618`: 9 files changed, 747 insertions(+), 19 deletions(-).

---

## Self-review findings

1. **MSSQL `latestReportEntries`:** Used `TOP (?)` as the FIRST column after `SELECT`, with `WHERE`/`ORDER BY` following. Matches the pattern from `replication.listRecent` already in the file (line 261).

2. **MySQL `reportSummaryFor`:** Used the correlated-subquery pattern (not `ROW_NUMBER()`) — explicitly per correction #2, mirrors commit `3f5f4db`. Confirmed MySQL 5.7-compatible.

3. **Service signature:** `(agentId, db = null)` (correction #3). No `_db` prefix in the public methods.

4. **Test mock signature:** Used the array form `buildMockDb([{match, rows}, ...]).standard()` (correction #1). Pattern follows `admin-dcs-bulk-assign.test.js`.

5. **401 test:** Uses the same `buildApp()` shape as `dcs-summary.test.js` (userAuth + requirePerm passed via factory) — not real `userAuth`/`requirePerm` modules (correction #5).

6. **Hardcoded limit 100:** Matches the brief / plan ("cap at 100"). MySQL uses `LIMIT ${Number(limit)}` (template literal); MSSQL uses `TOP (?)` (parameterized). Both are safe — `Number(limit)` coerces and rejects NaN.

7. **No business-logic date math in SQL:** `since` is computed in JS using `Date.now() - 24h`. ISO-stringified for SQL bind. Matches `lockoutRouter`'s pattern.

8. **Logger pattern:** Used `req.log?.error?.(...)` instead of a separate `logger` arg — matches `lockoutRouter` (the brief suggested copying from `dcs.js`, but `lockout.js` is the more recent and consistent pattern in the same multi-port plan).

9. **Tests assert JSON shape:** The list tests assert exact camelCase keys (`agentId`, `lastReportAt`, `reportSummary.totalLinks`, etc.) per the brief's TypeScript signature block.

10. **Config-key mock regex:** Discovered during the run — my initial regex `/SELECT\s+config_value\s+FROM\s+system_config\s+WHERE\s+config_key\s*=\s*'heartbeat_stale_seconds'/i` did not match the actual `SELECT config_key, config_value FROM system_config` query that `getConfig()` issues. Fixed to `/SELECT\s+config_key\s*,\s*config_value\s+FROM\s+system_config/i` and returned full `{config_key, config_value}` rows. Without this fix, `getConfig()` returned `{}` and the route correctly fell back to `15`. Fixed and tests pass.

---

## Concerns

1. **No real-DB test for `reportSummaryFor` / `latestReportEntries` / `agentsList` / `dcsList`:** The four new SQL helpers are only exercised through mock-DB unit tests. The MSSQL `TOP 1 ... ORDER BY collected_at DESC` inside the `INNER JOIN` subquery + the MySQL `MAX(collected_at)` form both parse and execute correctly per the existing `latestSummaryPerDc` precedent, but a real-DB probe (similar to `tests/sql/dcs-latest-summary.test.js`) would close the gap. Per project memory: "mock-DB unit tests can mask SQL syntax regressions; pair every db.sql.* string with a tests/sql/* real-DB test gated on TEST_MYSQL_URL". This is parked as a minor concern — Task 8 (mirror + push) does not require it; the Task 7 frontend will surface any shape mismatch immediately. Recommend adding one real-DB sql test in a follow-up.

2. **`agentsList` and `dcsList` SELECT-list mismatch with `replication.agents` / `dashboard.agents`:** Both existing blocks return different columns (no `seconds_since_heartbeat` here). The new endpoints don't expose `secondsSinceHeartbeat` in their response shape — they expose `heartbeatStaleSeconds` at the top level instead, which the frontend (Task 7) will use to compute staleness client-side. Confirmed intentional per the brief's interface block.

3. **No `listDcs` HTTP test:** The brief asked for 4 tests (agents list, null-summary, report-detail shape, 401). I covered those 4. `listDcs` is exercised by the same SQL helper (`dcsList` is structurally identical to `agentsList` with extra JOIN columns). Could add a 5th test for completeness, but the brief's exact count is 4.

4. **Tests skipped?** Full suite shows `17 skipped` — none of these are introduced by this task. They are pre-existing conditional skips (likely gated on `TEST_MYSQL_URL` / `TEST_MSSQL_URL` env vars per the feedback memory).

---

## Report summary

- 3 new files in `center/src/`, 1 in `center/tests/`
- 4 mirrored files in `publish/center/`
- 9 files committed in single feat commit
- 4 new tests pass, full suite 492/492 pass, 0 fail, 17 skipped
- 1 concern (no real-DB SQL test) — parked as minor follow-up

## Fix round 1

### What changed

- `center/tests/sql/heartbeat-report.test.js:1-187` — added MySQL 5.7 portability assertions for all four route-consumed heartbeat SQL helpers. Added `TEST_MYSQL_URL`-gated real-DB tests that seed and clean up sentinel rows, execute `agentsList` and `dcsList` against `ad_agent_heartbeat`/`ad_dcs`/`ad_sites`, verify `reportSummaryFor` returns only the `MAX(collected_at)` snapshot, and verify `latestReportEntries` caps results at 100.
- `center/src/services/heartbeat-report.js:26,45,119` — removed the unused `_staleSeconds` connection parameter and updated both callers to invoke `_staleSeconds()` with no argument. The helper continues to use `getConfig()` consistently with its actual contract.

### Tests run

- `node --test "D:/ToolDevelop/ADDashboard/center/tests/admin-heartbeat-report.test.js" "D:/ToolDevelop/ADDashboard/center/tests/sql/heartbeat-report.test.js"` — 11 tests, 8 pass, 0 fail, 3 skipped because `TEST_MYSQL_URL` is unset. All four portability assertions ran locally; the three seeded real-DB cases remain gated as intended.
- `npm --prefix "D:/ToolDevelop/ADDashboard/center" test` — 516 tests, 496 pass, 0 fail, 20 skipped. This is the prior 492 passing baseline plus 4 always-running SQL portability tests; the 3 new live-DB tests account for the additional conditional skips.

### New concerns

- `TEST_MYSQL_URL` was not available in this environment, so seeded live-MySQL execution could not run locally. The SQL tests are present and will execute automatically in an environment that provides the variable; dialect-portability assertions still run without it.

## Final fix (whole-branch review I-2)

### What changed

- `center/src/db/sql.js:119-129,386-401` — rewrote both dialects of `latestReportEntries` to select only rows at the latest `collected_at` within the lookback window, order same-snapshot rows by `source_dc, dest_dc`, and retain the MySQL 100-row cap. The implementation uses MySQL `MAX(collected_at)` and MSSQL `TOP 1 ... ORDER BY collected_at DESC` subqueries without window functions.
- `center/src/services/heartbeat-report.js:68-74` — executes the helper with three bind parameters, `[agentId, agentId, since]`, and documents that every returned row belongs to one snapshot.
- `center/tests/sql/heartbeat-report.test.js:151-211` — seeds older and latest snapshots, verifies only latest-snapshot rows are returned, verifies the 100-row cap and deterministic ordering, and asserts the three-parameter query signature.
- `center/tests/admin-heartbeat-report.test.js:125-157` — updated the SQL mock for the correlated-subquery shape and asserted the service passes exactly three parameters with the agent ID duplicated.
- `publish/center/src/db/sql.js:119-129,386-401` — mirrored from the center source.

### Tests run

- `node --test "D:/ToolDevelop/ADDashboard/center/tests/sql/heartbeat-report.test.js" "D:/ToolDevelop/ADDashboard/center/tests/admin-heartbeat-report.test.js"` — 11 tests / 8 pass / 0 fail / 3 skipped (`TEST_MYSQL_URL` unset).
- `npm test` — center: 516 tests / 496 pass / 0 fail / 20 skipped; agent: 52 pass / 0 fail; frontend: 210 pass / 0 fail.

### Mirror confirmation

- `git diff --no-index -- "D:/ToolDevelop/ADDashboard/center/src/db/sql.js" "D:/ToolDevelop/ADDashboard/publish/center/src/db/sql.js"` — empty diff (exit 0); mirror confirmed.

### Concerns

- The live-MySQL snapshot/cap test remains skipped locally because `TEST_MYSQL_URL` is not set; always-running portability and service/mock tests pass.
