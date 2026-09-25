# Audit Log Redesign — Tabs by Category

> **For agentic workers:** This is the spec for a UI redesign of `/admin/audit`. Implementation moves into a separate plan after user approval of this spec.

## Context

Today `frontend/src/views/admin/AuditView.vue` is a flat 5-column table dumped straight from `GET /api/admin/audit?limit=200`. Density problems, no filters, JSON payload crammed into `<td>`, no severity, all event classes look identical.

Ops users have asked for: change tracking ("who changed what"), security review ("login failures, deletions, bulk changes"), ops diagnostics (config / agent / migration events), and SIEM handoff (export to JSON / CSV).

Today emitted actions (grepped from `center/src/`): `login`, `login_failed`, `create_user`, `update_user`, `delete_user`, `update_config`, `bulk_import_sites`, `bulk_assign_dc_sites`, `apply_migration`, `reset_failed_migration` — 10 distinct actions. Labels `reset_password` / `rollback_config` in current `AuditView.vue` are dead code (no emit found).

## Goals

1. Make events scannable by **category tab**: 🔒 Security · 📝 Changes · ⚙ Ops.
2. Add **severity coloring** (red / yellow / blue) so high-risk rows pop on every tab.
3. Click a row → side **drawer** with structured payload tree + full user info + copy raw.
4. **Filter** inside each tab: time range · user · action subset · severity subset.
5. **Paginate** at 100/page with prev/next/page numbers; counts per tab.
6. **Export** current tab's filtered result as JSON or CSV (server-side, current filters respected).
7. Move **action / target label maps** to backend (eliminate `actionLabels` / `targetLabels` dead code in view).

## Non-Goals

- Cross-category investigation UI ("all events around 14:22 admin did X"). Tab model is single-focus; cross-category work happens via raw SQL or via per-tab drill-down combined with time-window + user filter. (Possible follow-up: a "all categories" view that strips the tab bar.)
- Long-term archival / retention config. Existing schema has no TTL.
- Real-time tail / SSE. Audit log is on-demand refresh.
- Audit log for `sys_config_audit` (the config-change log table) — that lives in `/admin/config` and is a different table.

## Action → Category (Hardcoded Map)

| Category | Actions |
|---|---|
| 🔒 Security | `login_failed`, `delete_user` |
| 📝 Changes | `create_user`, `update_user`, `update_config`, `bulk_import_sites`, `bulk_assign_dc_sites`, `apply_migration`, `reset_failed_migration` |
| ⚙ Ops | `login` |

Why this split: security = "can hurt if it didn't happen by you". Changes = "the system state was modified". Ops = "the system reported state about itself". The boundaries are coarse on purpose — fine-grained classification lives in `severity` instead.

## Severity (Derived From Action)

| Severity | Actions | UI |
|---|---|---|
| High | `login_failed`, `delete_user` | red left border + 🔴 chip |
| Medium | `update_user`, `update_config`, `bulk_import_sites`, `bulk_assign_dc_sites`, `apply_migration`, `reset_failed_migration` | yellow left border + 🟡 chip |
| Low | `login`, `create_user` | blue left border + 🔵 chip |

`create_user` is Low despite being a Changes event — adding a user is a routine first-time admin action. (Override hooks exist if this assumption breaks: see Risks.)

The category and severity tables live in `center/src/services/audit-classifier.js` — a single small module with two frozen maps. **No DB table for classification.** Adding a new action requires a code change (one file) and a unit test. This is by design — classification is policy, and policy belongs in source, not in admin-editable config.

## Backend

### DB Migrations

**`db/migrations/010-audit-logs-json.sql`** + **`db/migrations/mssql/010-audit-logs-json.sql`**

Change `audit_logs.payload` from `TEXT` to native JSON:

- MySQL: `MODIFY COLUMN payload JSON NULL`
- MSSQL: `ALTER COLUMN payload NVARCHAR(MAX)` + `ALTER TABLE audit_logs ADD CONSTRAINT ck_payload_json CHECK (payload IS NULL OR ISJSON(payload) = 1)`

Both guarded by `IF NOT EXISTS` / existence checks so reruns are no-ops.

Add a verify marker at top of each migration file so `bootstrapMigrations` (verify-marker fix from 2026-08-06) understands the artifact was created. Two markers each:
- `verify: table audit_logs`
- (no second marker — column type change is a metadata change, not a column add)

Existing data: text payloads survive `ALTER` (MySQL auto-casts to JSON; MSSQL `NVARCHAR(MAX)` accepts existing strings; the new CHECK constraint rejects rows that aren't JSON, but every row currently in the DB was written via `JSON.stringify(payload)` which is valid JSON, so the CHECK passes).

**`db/migrations/011-audit-logs-indexes.sql`** + MSSQL counterpart

Add two indexes so tab / user / time queries stay fast as the table grows:

- `KEY ix_audit_action_time (action, created_at)` — for the tab-category filter (action IN list) + ordering.
- `KEY ix_audit_user_time (user_id, created_at)` — for per-user drill-downs.

Both created with `IF NOT EXISTS` (MySQL — note: requires MySQL 8.0.29+, so we instead use the migration-001 dynamic-SQL procedure pattern that works on 5.7+) / existence-check pattern (MSSQL).

### API Changes

**`GET /api/admin/audit`** — extends current route.

Query params (all optional):
- `category`: `security` | `changes` | `ops` (server expands to action list)
- `action`: comma-separated list (further narrows within category)
- `severity`: comma-separated `high|medium|low`
- `userId`: integer
- `from`, `to`: ISO timestamps
- `page`: 1-based, default 1
- `size`: default 100, max 100

Response:
```json
{
  "rows": [
    {
      "id": 12834,
      "createdAt": "2026-08-06T13:48:21.000Z",
      "userId": 1,
      "username": "admin",
      "action": "update_config",
      "actionLabel": "修改系统配置",
      "category": "changes",
      "severity": "medium",
      "target": "metrics_retention_days",
      "targetLabel": "系统配置",
      "payload": { "key": "metrics_retention_days", "old": 30, "new": 90 }
    }
  ],
  "total": 1247,
  "page": 1,
  "size": 100,
  "filtered": 247
}
```

- `actionLabel`, `category`, `severity`, `targetLabel` are server-computed (one JOIN-shaped CASE chain).
- `payload` is returned as a JSON object directly. The service layer parses on the way out.
- `total` = count of full matched set; `filtered` = after-category-filter count before pagination. Frontend uses `filtered` for pagination pages.

**`GET /api/admin/audit/export?format=json|csv&...same filters...`**

- Same filter handling as list.
- Streams `application/json` or `text/csv; charset=utf-8`.
- Filename: `audit-{category|all}-{YYYYMMDD-HHmmss}.{json|csv}`
- CSV columns: `时间 (UTC+8), 用户名, 动作, 目标, 严重性, 类别, payload(json)`
- Cap at 50,000 rows per export (return 413 if exceeded; client shows "use filters to narrow"). YAGNI: no streaming pagination, no chunked export.

### SQL Helpers (Replaces Existing `audit.list`)

In `center/src/db/sql.js` under both dialects:
- `audit.list({category, actions, userId, from, to, severity, offset, limit})` — parameterized dynamic WHERE clause, no string interpolation.
- `audit.count({...})` — same WHERE without ORDER/LIMIT.
- `audit.badge(category)` — `SELECT COUNT(*) WHERE action IN (?,...)` for the tab badge.

Severity is computed server-side from action via CASE; no separate column.

Payload write path (`db.execute`) takes a `JSON.stringify`-ed string for INSERT, but the `audit.list` returns parsed JSON. Service layer (`services/audit.js`) parses on read; if `payload` is `null` or not valid JSON, returns `null` and logs warn once. Existing writes already use `JSON.stringify`.

## Frontend

### Component Breakdown

**`frontend/src/views/admin/AuditView.vue`** — rewritten as tab-driven shell.

Layout (top to bottom):
1. Title row: "审计日志" · total badge per tab (3 spans, one per tab) · `[导出 JSON]` `[导出 CSV]`
2. Tab bar: 🔒 Security (N) · 📝 Changes (M) · ⚙ Ops (K) — click switches active tab and refetches with `category`
3. Filter strip (per tab): time range (presets 1h/24h/7d/30d + custom) · user dropdown · action multi-select chips · severity multi-select chips
4. Table (compact): 时间 · 用户 · 动作 · 目标 · 严重性 (5 columns)
5. Pagination: prev · pages · next · "第 1-100 / 共 247"
6. Drawer (right slide-in, 40% width): event detail — username + role + raw id · full payload as a collapsible JSON tree · `payload_raw` textbox with copy button

State held in component: `activeCategory`, `filters`, `page`, `selectedEvent` (for drawer), `rows`, `total`, `filtered`.

The 4 filter inputs (time range, user, action, severity) all live at the top of the tab pane. Changing any filter resets `page` to 1.

### API Surface

In `frontend/src/api/admin.js`:
```js
adminApi.getAudit({ category, page, size, userId, actions, severities, from, to })
adminApi.getAuditBadge(category)
adminApi.exportAudit(format, filters)  // returns blob, triggers download
```

### Router — No Change

`/admin/audit` already routes to `AuditView.vue`. No router changes.

### Tests (Frontend)

In `frontend/tests/audit-view.test.js` — rewritten:

1. Renders 3 tabs with badge counts from `getAuditBadge` mock.
2. Tab click switches active tab and triggers a `getAudit` refetch with that category.
3. Filter change (time preset / user / action chip / severity chip) sends correct query and resets to page=1.
4. Row click opens drawer with row's payload rendered as JSON tree.
5. Pagination prev/next/page-number clicks send `page` param correctly.
6. Export JSON / Export CSV button calls `exportAudit` with current filter state and downloads a Blob.
7. Empty tab (zero rows in that category) shows an empty-state message, not a broken table.

### Tests (Backend)

In `center/tests/audit-list.test.js` (new):

1. **list: returns paginated rows, joined username, parsed payload** — fixtures + 100 rows seeded.
2. **list: filter by category expands to action IN-list** — confirm SQL emitted has correct IN-list.
3. **list: filter by userId / from / to narrows correctly** — 4 boundary cases.
4. **list: severity filter is computed server-side from action** — confirms no client-side mapping.
5. **list: page beyond range returns empty rows with correct total**.
6. **list: payload is parsed JSON, not raw string** — confirms service returns parsed objects.
7. **list: invalid category returns 400**.
8. **export: JSON and CSV stream from same filter as list** — assertion on count + first-line header.

In `center/tests/audit-migration.test.js` (new, integration-test shape since it needs a real DB to alter column type):

1. **migration 010: payload column becomes JSON type, existing rows survive**.
2. **migration 010: rerun is no-op** (idempotent).
3. **migration 011: indexes exist after run**.

Per project convention: write in `node:test` + `node:assert/strict`, use the `TEST_MYSQL_URL` / `TEST_MSSQL_URL` guards (skip if not set).

## Data Flow

```
[Admin clicks /admin/audit]
  → AuditView mounts → fetches 3× getAuditBadge(category=security|changes|ops) in parallel
  → fetches getAudit({category: 'security', page: 1, size: 100})

[Filter change / pagination]
  → triggers getAudit with combined query
  → server builds parameterized WHERE clause (no string interpolation)
  → service.audit-list parses payload JSON before returning

[Row click]
  → opens drawer, fetches no extra data (full row already in hand)
  → JSON tree = recursive Component that handles objects / arrays / primitives

[Export click]
  → blob download via adminApi.exportAudit(format, currentFilterState)
  → filename includes UTC timestamp for forensic naming
```

## Error Handling

| Failure | Surface |
|---|---|
| Backend `GET /api/admin/audit` 5xx | toast "审计日志加载失败" + retry button |
| Export > 50k rows | 413 → toast "请先用过滤器缩小范围" |
| Export 5xx | toast + retry |
| Invalid `category` query | backend 400 → toast "类别参数错误" |
| DB read ECONNRESET | retry once, then surface toast (handled by `db.query` already) |
| Drawer with non-JSON payload (older rows) | drawer shows a `<pre>` of raw text and a "（payload 解析失败，已显示原始文本）" note |

## Rollout / Verification

1. **Migrations first, on a copy of prod**: dump+restore + run migrations + confirm existing rows readable.
2. **Backend tests**: `cd center && npm test` — expect 444/455 pass + 11 skipped → 460-ish after new tests, 0 fail.
3. **Frontend tests**: `cd frontend && npx vitest run` — expect 153/160 pass → 159 pass after new AuditView tests.
4. **Manual smoke test** with `npm start`:
   - Login admin → /admin/audit
   - 3 tabs visible with badges
   - Tab click switches visible rows
   - Filter "严重性=高" + 时间 "24h" → only red-border rows in 24h
   - Row click → drawer opens with payload tree
   - Export JSON → file downloads, contents match on-screen rows
   - Select 50k+ rows → export blocked with toast
5. **Cross-dialect**: deploy on MySQL and MSSQL test beds; verify migrations + new list SQL work in both.
6. **No publish mirror review needed** — center/ source files mirror via `cp` at the end of execution.
7. **No zip regen** — runtime-only bundle ships new dist on next build via `npm start`.

## Critical Files

- **Modify**: `center/src/db/sql.js` — `audit.*` block in mysql (lines 51-52) + mssql (lines around audit). Add `audit.list`/`audit.count`/`audit.badge`.
- **Modify**: `center/src/services/audit.js` — extend `writeAudit` (already JSON-safe), add `listAudit(opts)` + `getAuditBadge(category)`.
- **Modify**: `center/src/routes/admin.js` — replace lines 214-227 (existing `/api/admin/audit` get). Add `/api/admin/audit/export`.
- **Create**: `center/src/services/audit-classifier.js` — frozen maps: `ACTION_CATEGORY`, `ACTION_SEVERITY`, `ACTION_LABEL`, `TARGET_LABEL`.
- **Create**: `db/migrations/010-audit-logs-json.sql` + `db/migrations/mssql/010-audit-logs-json.sql`.
- **Create**: `db/migrations/011-audit-logs-indexes.sql` + `db/migrations/mssql/011-audit-logs-indexes.sql`.
- **Modify**: `frontend/src/views/admin/AuditView.vue` — full rewrite.
- **Modify**: `frontend/src/api/admin.js` — extend `getAudit`, add `getAuditBadge`, add `exportAudit`.
- **Modify**: `publish/center/src/db/sql.js`, `publish/center/src/services/audit.js`, `publish/center/src/routes/admin.js`, `publish/center/src/services/audit-classifier.js` — mirrors.
- **Modify**: `publish/frontend/src/views/admin/AuditView.vue`, `publish/frontend/src/api/admin.js` — mirrors.
- **Create**: `center/tests/audit-list.test.js` + `publish/center/tests/audit-list.test.js`.
- **Create**: `center/tests/audit-migration.test.js` + `publish/center/tests/audit-migration.test.js`.
- **Modify**: `frontend/tests/audit-view.test.js` + `publish/frontend/tests/audit-view.test.js` — full rewrite of test cases.

## Risks & Mitigations

1. **JSON CHECK constraint rejects non-JSON rows after migration**. Mitigation: the migration runs `ISJSON(payload) = 1` CHECK only AFTER it scans for any non-JSON-existing rows; if any exist, abort migration with a clear error. (`UPDATE audit_logs SET payload = NULL WHERE ISJSON(payload) = 0`) before adding the CHECK. Tests verify this.
2. **Action list drift**. Adding a new writeAudit call without adding it to the classifier map means new events are misclassified. Mitigation: a unit test enumerates every `writeAudit(...)` call site (grep + parse) and asserts each action appears in `ACTION_CATEGORY`. Runs in CI.
3. **`create_user` may need Medium severity later**. Easy to change in one map.
4. **Export streaming bypasses the 50k cap via curl**. Mitigation: server enforces cap before streaming; 413 always.
5. **JSONB / native JSON not queryable for `payload.key = 'foo'` patterns yet**. YAGNI — out of scope for this redesign; can be revisited if anyone needs payload-key filtering.
6. **Audit log growth not pruned**. Existing behavior preserved (no TTL). Possible follow-up.

## Out of Scope

- Audit log TTL / archival.
- Real-time tail / SSE.
- Cross-category view (revisit later).
- Notifying on severity=high rows.
- Per-action permission gating (e.g., auditor role).

## Open Questions (None)

This spec has no open questions. Confirming the design before moving to implementation plan.

## Follow-Ups (Post-Merge, Not In This Plan)

- Confirm `create_user` Low severity holds after 1 week of observing bulk-imports events.
- Decide whether `login` should stay in Ops tab or move elsewhere (currently 占比 small).
- Possibly add `audit.action_definitions` DB table to allow ops to relabel actions without code changes — gated on user feedback.
