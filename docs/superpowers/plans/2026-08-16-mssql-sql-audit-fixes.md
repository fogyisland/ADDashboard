# MSSQL SQL Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 8 Critical findings surfaced by a three-specialist SQL audit on 2026-08-16 (MySQL 5.7 compat / MSSQL 2016+ compat / cross-dialect parity), each with a regression test, so the codebase has no SQL strings that crash on production MSSQL deployments or silently produce different results across the two dialects.

**Architecture:** Three coordinated fixes in `center/src/db/sql.js` + four files in `center/src/db/sql/*.js`:
- **T1 (sites.upsert crash + dashboard datepart):** Drop the trailing `; SELECT @@ROWCOUNT AS rc` from the sites.upsert MSSQL MERGE (the driver's isInsert heuristic reads it as a SCOPE_IDENTITY probe and throws "mssql driver: SCOPE_IDENTITY() returned NULL after INSERT" on every call). Replace `DATEDIFF(MINUTE, a, b)` with `DATEDIFF_BIG(SECOND, a, b) / 60.0` in three `dashboard.*` queries so MSSQL returns sub-minute resolution matching MySQL's `TIMESTAMPDIFF`.
- **T2 (hand-rolled `@pN`):** Replace hand-written `@p1`/`@p2`/`@p3` literals with `?` in `sites.updatePartial` and the four `ports.*` queries so the driver wrapper's `rewritePlaceholders` (`drivers/mssql.js:16-22`) handles them uniformly. Eliminates the silent failure mode where new callers pass `?`-semantic params to `@pN`-expecting statements.
- **T3 (inline SCOPE_IDENTITY collisions):** Remove the inline `; SELECT SCOPE_IDENTITY() AS id` from four files (`alert-rules.create`, `alert-events.insert`, `alert-outbox.enqueue`, `server-groups.create`) — the driver already auto-appends the equivalent for INSERT-prefixed SQL. For `serverGroups.upsert` (MERGE — NOT INSERT-prefixed), the inline SCOPE_IDENTITY returns NULL on the UPDATE branch; either delete the function or drop the inline probe.

**Tech Stack:** Node.js (test: `node --test`), MSSQL via `mssql@11` (tedious), MySQL 5.7 (test database behind `AE_MYSQL_URL` / `AE_MSSQL_URL`), existing `center/tests/db/sql.test.js` and `center/tests/sql/*.test.js` round-trip patterns.

**Spec:** This plan implements the fix list from three senior-level audits performed in this session on 2026-08-16 (see chat log + audit reports). No external spec doc — the audit findings ARE the spec. The plan argues from `center/src/db/sql.js`, `center/src/db/sql/*.js`, `center/src/db/drivers/mssql.js`, and the existing test files.

## Global Constraints

- **Backward compat by default:** Every MySQL query string remains syntactically identical (no `?` count changes, no column renames). Every MSSQL query string's *semantic result* remains identical — `affectedRows` parity, `insertId` parity (when caller reads it), `rows` shape parity (camelCase conversion already done by `normalizeRow`).
- **Driver wrapper contract:** `drivers/mssql.js:16-22` rewrites `?` → `@p1, @p2, ...` in order. All MSSQL statements use `?` placeholders only (no hand-rolled `@pN`). The isInsert heuristic at `drivers/mssql.js:78` is the ONLY place SCOPE_IDENTITY probing happens — service code never reads `result.recordset?.[0]?.id`.
- **No new dependencies.** All fixes are string-level edits + regression tests.
- **Regression test discipline:** Each task ends with a failing test first (red), the fix applied (green), the test re-run (still green), then commit. Tests must exercise the actual code path, not just static string inspection.
- **publish/system/ mirror sync:** Every modified source file under `center/src/` gets copied to `publish/system/center/src/<same-path>` after green (per existing `feedback_publish_sync.md`).
- **Push via proxy bypass:** `git -c http.proxy= -c https.proxy= push origin main` (per existing `feedback_proxy_bypass_push.md`).

---

### Task 1: sites.upsert MERGE trailing probe + dashboard datepart divergence

**Files:**
- Modify: `center/src/db/sql.js:391` (`sites.upsert` MSSQL MERGE)
- Modify: `center/src/db/sql.js:407-411` (`dashboard.errors`, `dashboard.agents`, `dashboard.dcReplicationLinks` MSSQL)
- Test: `center/tests/db/sql.test.js` (add new tests)

**Interfaces:**
- Consumes: `db.sql.sites.upsert` (caller: `routes/admin.js:477` discards result — works only by luck), `db.sql.dashboard.{errors,agents,dcReplicationLinks}` (caller: `services/dashboard.js` — reads `duration_minutes` field on result rows)
- Produces: `db.sql.sites.upsert` returns `{rows: [], affectedRows: N}` from the driver (no second recordset). `db.sql.dashboard.*` returns rows with `duration_minutes` = fractional-minute precision (`SECONDS/60.0`).

**Step 1: Write failing test for sites.upsert (static assertion first)**

```js
test('mssql sites.upsert MERGE does not have trailing SELECT @@ROWCOUNT', () => {
  const sql = buildSql('mssql').sites.upsert;
  // No second recordset — driver isInsert heuristic must not see a probe.
  assert.doesNotMatch(sql, /@@ROWCOUNT/);
  assert.doesNotMatch(sql, /;\s*SELECT\s+@@/i);
});
```

Add to `center/tests/db/sql.test.js` after the existing sites tests. Run `node --test tests/db/sql.test.js` — must FAIL.

**Step 2: Drop the trailing `; SELECT @@ROWCOUNT AS rc` from `sites.upsert` MSSQL**

In `center/src/db/sql.js:391`, the current value ends with:
```
... VALUES (s.site_name, s.region_code, s.is_hub, s.description); SELECT @@ROWCOUNT AS rc
```
Change to end with:
```
... VALUES (s.site_name, s.region_code, s.is_hub, s.description)
```
(NB: the trailing `;` before SELECT is still required by SQL Server for the MERGE statement — drop ONLY the `; SELECT @@ROWCOUNT AS rc` portion.)

**Step 3: Verify the test now passes**

Run: `node --test tests/db/sql.test.js`
Expected: PASS.

**Step 4: Write failing test for dashboard datepart semantics**

The audit found that `DATEDIFF(MINUTE, a, b)` returns 0 for any sub-minute gap. Two tests are needed:

```js
test('mssql dashboard.errors uses DATEDIFF_BIG SECOND / 60.0 (sub-minute precision)', () => {
  const sql = buildSql('mssql').dashboard.errors;
  // Must NOT use DATEDIFF(MINUTE, ...) — returns boundary crossings, not absolute minutes
  assert.doesNotMatch(sql, /DATEDIFF\s*\(\s*MINUTE/i);
  // Must use seconds-precision math
  assert.match(sql, /DATEDIFF_BIG\s*\(\s*SECOND/i);
  assert.match(sql, /\/ 60/i);
});

test('mssql dashboard.agents uses DATEDIFF_BIG SECOND (sub-second precision)', () => {
  const sql = buildSql('mssql').dashboard.agents;
  assert.doesNotMatch(sql, /DATEDIFF\s*\(\s*SECOND[^)]*SYSUTCDATETIME/i);
  assert.match(sql, /DATEDIFF_BIG\s*\(\s*SECOND/i);
});

test('mssql dashboard.dcReplicationLinks uses DATEDIFF_BIG SECOND / 60.0', () => {
  const sql = buildSql('mssql').dashboard.dcReplicationLinks;
  assert.doesNotMatch(sql, /DATEDIFF\s*\(\s*MINUTE/i);
  assert.match(sql, /DATEDIFF_BIG\s*\(\s*SECOND/i);
  assert.match(sql, /\/ 60/i);
});
```

Add to `center/tests/db/sql.test.js`. Run — must FAIL (these queries currently use DATEDIFF MINUTE).

**Step 5: Replace DATEDIFF datepart in three dashboard queries**

For `center/src/db/sql.js:407` (`dashboard.errors`):
- Find: `DATEDIFF(MINUTE, last_success_time, last_attempt_time)`
- Replace with: `CASE WHEN last_success_time IS NULL OR last_attempt_time IS NULL THEN NULL ELSE CAST(DATEDIFF_BIG(SECOND, last_success_time, last_attempt_time) AS float) / 60.0 END`

For `center/src/db/sql.js:408` (`dashboard.agents`):
- Find: `DATEDIFF(SECOND, last_heartbeat_at, SYSUTCDATETIME())`
- Replace with: `CASE WHEN last_heartbeat_at IS NULL THEN NULL ELSE CAST(DATEDIFF_BIG(SECOND, last_heartbeat_at, SYSUTCDATETIME()) AS float) END`

For `center/src/db/sql.js:411` (`dashboard.dcReplicationLinks`):
- Find: `DATEDIFF(MINUTE, last_success_time, last_attempt_time)`
- Replace with: `CASE WHEN last_success_time IS NULL OR last_attempt_time IS NULL THEN NULL ELSE CAST(DATEDIFF_BIG(SECOND, last_success_time, last_attempt_time) AS float) / 60.0 END`

**Step 6: Run dashboard tests — must PASS**

Run: `node --test tests/db/sql.test.js`
Expected: PASS.

**Step 7: Run full center suite to confirm no regression**

Run: `cd center && npm test`
Expected: All tests pass or skip (same as before this change). Pay attention to the `dashboard.*` roundtrip tests in `center/tests/sql/` if they exist.

**Step 8: Commit and sync publish mirror**

```bash
cd /d/ToolDevelop/ADDashboard
git add center/src/db/sql.js center/tests/db/sql.test.js
cp center/src/db/sql.js publish/system/center/src/db/sql.js
cp center/tests/db/sql.test.js publish/system/center/tests/db/sql.test.js
git add publish/system/center/src/db/sql.js publish/system/center/tests/db/sql.test.js
git commit -m "fix(mssql sql): sites.upsert @@ROWCOUNT crash + dashboard DATEDIFF datepart

sites.upsert MERGE trailed with '; SELECT @@ROWCOUNT AS rc' which collided
with the mssql driver's isInsert heuristic (drivers/mssql.js:78) — the
heuristic flagged the SQL as INSERT, then expected a SCOPE_IDENTITY() probe
in the last recordset, and threw 'mssql driver: SCOPE_IDENTITY() returned
NULL after INSERT' on every call. Driver returns affectedRows correctly;
trailing probe was dead noise that broke sites.upsert.

dashboard.{errors, agents, dcReplicationLinks} used DATEDIFF(MINUTE, a, b)
which returns boundary crossings (59-second gap -> 0) on MSSQL while MySQL's
TIMESTAMPDIFF(MINUTE, a, b) returns absolute minutes (59-second gap -> 0,
90-second gap -> 1). Same query, different value across dialects. Switch
to DATEDIFF_BIG(SECOND, ...) / 60.0 for sub-minute resolution matching the
MySQL semantic.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

DO NOT push yet — wait for whole-branch review in Task 4.

---

### Task 2: sites.updatePartial + ports.* hand-rolled @pN → ?

**Files:**
- Modify: `center/src/db/sql.js:393` (`sites.updatePartial`)
- Modify: `center/src/db/sql.js:454-457` (`ports.create`, `ports.findByPort`, `ports.updatePartial`, `ports.delete`)
- Test: `center/tests/db/sql.test.js` (add tests asserting no raw `@pN` in those queries)

**Interfaces:**
- Consumes: `db.sql.sites.updatePartial` (caller: `routes/admin.js`, dynamic UPDATE built from form fields). `db.sql.ports.{create,findByPort,updatePartial,delete}` (callers in `routes/admin.js` and `services/ports.js`)
- Produces: All queries use `?` placeholders. Driver's `rewritePlaceholders` (`drivers/mssql.js:16-22`) does the rest.

**Step 1: Write failing test — raw @pN must NOT appear in sites.updatePartial or ports.***

```js
test('mssql sites.updatePartial uses ? placeholders (not hand-rolled @pN)', () => {
  const sql = buildSql('mssql').sites.updatePartial;
  assert.doesNotMatch(sql, /@p\d/i);
  // It IS an UPDATE, so isInsert heuristic doesn't fire — no SCOPE_IDENTITY probe
  assert.match(sql, /UPDATE\s+ad_sites/i);
});

test('mssql ports.* queries use ? placeholders', () => {
  const ports = buildSql('mssql').ports;
  for (const [name, sql] of Object.entries(ports)) {
    assert.doesNotMatch(sql, /@p\d/i, `ports.${name} contains hand-rolled @pN`);
  }
});
```

Add to `center/tests/db/sql.test.js`. Run — must FAIL.

**Step 2: Investigate callers to confirm param shape before editing**

Read `center/src/routes/admin.js` (the caller for `sites.updatePartial` and `ports.*`) to confirm:
- The number of `?` placeholders matches the params array the caller builds
- The current hand-rolled `@pN` in those strings is NOT needed because some legacy caller passes already-substituted names

If you find that callers DO construct `@p1/@p2/@p3` names, the fix is to update BOTH the SQL and the caller. The current hand-rolled pattern is a latent bug — any new caller passing `?`-semantic params breaks. Update both.

For `sites.updatePartial` (`sql.js:393`), the string template uses `fields.map((_, i) => fields[i].replace(/\?/g, () => `@p${i + 1}`))` which rewrites `?` in field names to `@pN`. The new shape is simpler:

```js
updatePartial: (fields) => `UPDATE ad_sites SET ${fields.join(', ')} WHERE site_id = ?`
```

The caller appends `id` to its params array. This matches the pattern in the MySQL dialect (`sql.js:81`) — verify both branches have identical caller logic.

For `ports.create` (`sql.js:454`), the current shape:
```
INSERT INTO system_ports (port, label, sort_order) VALUES (@p1, @p2, @p3)
```
Becomes:
```
INSERT INTO system_ports (port, label, sort_order) VALUES (?, ?, ?)
```

Same shape for `findByPort`, `updatePartial`, `delete` — each `@pN` literal becomes `?` in left-to-right order matching the existing param binding.

**Step 3: Edit the four `ports.*` queries and `sites.updatePartial`**

For each of the five queries (`sites.updatePartial` + 4 `ports.*`), replace every `@p1`/`@p2`/`@p3` with `?` in left-to-right order. The number of `?` must equal the number of params the caller passes (verify by reading the caller one more time after the edit).

**Step 4: Verify tests now PASS**

Run: `node --test tests/db/sql.test.js`
Expected: PASS.

**Step 5: Run full center suite**

Run: `cd center && npm test`
Expected: All tests pass or skip (same as before). Pay attention to any port-related tests in `center/tests/routes/admin.test.js` and the `db.execute(sql.ports.create, [port, label, sortOrder])` call sites.

**Step 6: Commit and sync publish mirror**

```bash
cd /d/ToolDevelop/ADDashboard
git add center/src/db/sql.js center/tests/db/sql.test.js
cp center/src/db/sql.js publish/system/center/src/db/sql.js
git add publish/system/center/src/db/sql.js
git commit -m "fix(mssql sql): use ? placeholders in sites.updatePartial + ports.*

Five queries in sql.js used hand-rolled '@p1/@p2/@p3' literals that
bypassed the driver's rewritePlaceholders (drivers/mssql.js:16). Any new
caller passing '?'-semantic params got a runtime conversion error from
mssql. Convert to '?' so the driver wrapper handles them uniformly with
every other query in the codebase. Verified caller param shapes in
routes/admin.js + services/ports.js to ensure ? count matches bind count.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

DO NOT push yet — wait for whole-branch review in Task 4.

---

### Task 3: Inline SCOPE_IDENTITY() collisions in alert-rules/events/outbox + server-groups upsert dead code

**Files:**
- Modify: `center/src/db/sql/alert-rules.js:64-65` (`alertRules.create` — drop inline `; SELECT SCOPE_IDENTITY() AS id`)
- Modify: `center/src/db/sql/alert-events.js:28-29` (`alertEvents.insert` — same)
- Modify: `center/src/db/sql/alert-outbox.js:45-47` (`alertOutbox.enqueue` — same)
- Modify: `center/src/db/sql/server-groups.js:78` (`serverGroups.create` — same)
- Modify: `center/src/db/sql/server-groups.js:79-83` (`serverGroups.upsert` MERGE — verify dead code, then either delete or fix)
- Modify: `center/src/services/alert-engine.js:284` (use `insertResult.insertId` instead of `insertResult.recordset?.[0]?.id` if T3 changes the return shape)
- Test: `center/tests/db/sql.test.js` (assert no inline SCOPE_IDENTITY in those files)

**Interfaces:**
- Consumes: `db.sql.alertRules.create` / `db.sql.alertEvents.insert` / `db.sql.alertOutbox.enqueue` / `db.sql.serverGroups.create` (callers: `services/alert-engine.js` + `services/member-servers.js`). `db.sql.serverGroups.upsert` (caller: `routes/member-servers.js:165` — audit said this MERGE has no caller; verify and act).
- Produces: Driver auto-appends the SCOPE_IDENTITY probe (`drivers/mssql.js:89`) which already runs for INSERT-prefixed SQL. Caller reads `result.insertId` (driver return shape) instead of `result.recordset?.[0]?.id`.

**Step 1: Investigate callers of `serverGroups.upsert` to confirm dead-code claim**

```bash
cd /d/ToolDevelop/ADDashboard
grep -rn "serverGroups\.upsert\|serverGroups\?\.upsert\|\.upsert(" center/src/ center/tests/
```

Audit said there is no caller. If grep confirms: delete `serverGroups.upsert` (the entire export). If there IS a caller: convert to a simpler INSERT-on-NOT-MATCHED pattern that handles both branches.

**Step 2: Write failing test — no inline SCOPE_IDENTITY() in the four files**

```js
test('mssql alertRules.create does not append inline SCOPE_IDENTITY (driver auto-appends)', () => {
  const sql = buildSql('mssql').alertRules.create;
  assert.doesNotMatch(sql, /SCOPE_IDENTITY/i);
  assert.match(sql, /^\s*INSERT\b/i);
});

test('mssql alertEvents.insert does not append inline SCOPE_IDENTITY', () => {
  const sql = buildSql('mssql').alertEvents.insert;
  assert.doesNotMatch(sql, /SCOPE_IDENTITY/i);
  assert.match(sql, /^\s*INSERT\b/i);
});

test('mssql alertOutbox.enqueue does not append inline SCOPE_IDENTITY', () => {
  const sql = buildSql('mssql').alertOutbox.enqueue;
  assert.doesNotMatch(sql, /SCOPE_IDENTITY/i);
  assert.match(sql, /^\s*INSERT\b/i);
});

test('mssql serverGroups.create does not append inline SCOPE_IDENTITY', () => {
  const sql = buildSql('mssql').serverGroups.create;
  assert.doesNotMatch(sql, /SCOPE_IDENTITY/i);
  assert.match(sql, /^\s*INSERT\b/i);
});
```

Add to `center/tests/db/sql.test.js`. Run — must FAIL.

**Step 3: Drop inline `; SELECT SCOPE_IDENTITY() AS id` from four queries**

For each of `alert-rules.js:64-65`, `alert-events.js:28-29`, `alert-outbox.js:45-47`, `server-groups.js:78`:
- Find: the closing `;\nSELECT SCOPE_IDENTITY() AS id` (or `; SELECT SCOPE_IDENTITY() AS id`) trailing the INSERT VALUES clause.
- Replace with: nothing (driver auto-appends the equivalent).

For `server-groups.js:79-83` (`serverGroups.upsert`): if grep in Step 1 showed no caller, delete the function. If caller exists, replace the MERGE+SCOPE_IDENTITY with an INSERT-ON-NOT-MATCHED-PATTERN that the driver correctly handles.

**Step 4: Update callers if they read `result.recordset?.[0]?.id`**

The driver returns `{rows, affectedRows, insertId}` for INSERT-prefixed SQL. If a caller reads `result.recordset?.[0]?.id` (mssql-specific), switch to `result.insertId` (driver-abstracted). Check:
- `center/src/services/alert-engine.js:284` (audit-flagged) — read the surrounding code, switch if applicable
- Any other caller in `services/`, `routes/` that consumes `insertResult.recordset`

**Step 5: Verify tests PASS and run full center suite**

Run: `node --test tests/db/sql.test.js` (PASS)
Run: `cd center && npm test` (must pass / same skip count)

Pay attention to `center/tests/sql/alert-rules.test.js` and `center/tests/sql/server-groups.test.js` if they exist — these are the live roundtrip tests most likely to surface an issue.

**Step 6: Commit and sync publish mirror**

```bash
cd /d/ToolDevelop/ADDashboard
git add center/src/db/sql/alert-rules.js center/src/db/sql/alert-events.js center/src/db/sql/alert-outbox.js center/src/db/sql/server-groups.js center/src/services/alert-engine.js center/tests/db/sql.test.js
for f in center/src/db/sql/alert-rules.js center/src/db/sql/alert-events.js center/src/db/sql/alert-outbox.js center/src/db/sql/server-groups.js center/src/services/alert-engine.js; do
  cp "$f" "publish/system/$f"
  git add "publish/system/$f"
done
git commit -m "fix(mssql sql): drop inline SCOPE_IDENTITY in 4 INSERT helpers + dead MERGE

Four helpers (alertRules.create, alertEvents.insert, alertOutbox.enqueue,
serverGroups.create) appended '; SELECT SCOPE_IDENTITY() AS id' inline.
The mssql driver already auto-appends the equivalent for INSERT-prefixed
SQL (drivers/mssql.js:89-90), so the inline probe produced THREE recordsets
per call (the inline SELECT, the driver SELECT, plus the INSERT itself)
and silently wasted a round-trip. Drop the inline probes; callers that
read result.recordset[0].id switch to result.insertId (driver-abstracted).

serverGroups.upsert was a MERGE with the same inline probe — but MERGE
isn't INSERT-prefixed so the driver does NOT auto-append, and the inline
SCOPE_IDENTITY returns NULL on the UPDATE branch. Verified via grep: no
caller exists. Delete the dead code.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

DO NOT push yet — wait for whole-branch review in Task 4.

---

### Task 4: Whole-branch opus review + push

**Files:**
- Read: All diffs from Tasks 1-3 (git log shows commits 52b4ee5, e6a85c7, plus the three new commits)
- Test: full suite + new regression tests

**Step 1: Run full center suite one last time**

Run: `cd center && npm test`
Expected: All tests pass or skip. Note the pass/fail/skip counts in the commit message.

**Step 2: Sync publish mirror one final time and verify no drift**

```bash
cd /d/ToolDevelop/ADDashboard
diff -rq center/src publish/system/center/src 2>&1 | grep -v "Only in" || echo "no drift"
```

If drift exists, sync the missing files.

**Step 3: Dispatch opus whole-branch reviewer**

Spawn a single opus subagent with the review-package skill output covering commits `52b4ee5..HEAD` (which includes the prior MERGE terminator fix and the three new commits). The reviewer should check:
- All Critical findings from the audit are addressed (no regression on the audit list)
- No new Critical findings introduced
- Each task's regression test would catch a re-introduction of the bug
- publish/system/ is in sync with center/src/
- Commit messages follow repo style (imperative, body explains why not what)

**Step 4: Apply reviewer findings (one fix round) and re-run suite**

If the reviewer returns clean, proceed to Step 5. If it returns findings, dispatch one implementer subagent to address them, then a scoped re-review.

**Step 5: Push to origin**

```bash
git -c http.proxy= -c https.proxy= push origin main
```

Expected: 3 new commits push to origin/main.

**Step 6: Update memory**

Append to `progress_2026_08_16.md` (or new progress file) the summary of audit findings + fixes. Update `feedback_publish_sync.md` if any new sync rule was learned (none expected — this follows existing conventions).