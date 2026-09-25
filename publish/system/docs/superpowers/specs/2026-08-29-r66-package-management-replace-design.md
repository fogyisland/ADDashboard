# R66 — Package Management Replace Design (scripts + policies)

> Operator directive 2026-08-29: "将包管理改成 上传脚本,然后执行策略,修改脚本设置执行周期等等。agent 端将根据执行的策略拉取这些脚本,然后依据拉取的配置执行,或者禁用 或者删除 等等操作".

**Status:** approved 2026-08-29 (scope: B 替换 + 独立策略表 + 不做 agent hash 校验 + 内置包宽松编辑 + mock 完整同步 + docs/superpowers/specs/ 默认路径) · round-66 of the dashboard iteration sequence

## Goal

Replace the "package = packaged ZIP with embedded manifest" model with a two-table split where the operator uploads raw PS1 scripts and configures their execution policy independently from the admin UI. The agent protocol stays unchanged so no agent restart is required for existing in-field agents to keep working after center restart.

## Why

Today `installed_packages` is a single row holding a manifest blob + on-disk `collect.ps1` + (operator-overridable) interval + (read-only) embedded timeout. Three operator pain points:

1. **Script body is immutable without re-upload.** To fix a typo in `collect.ps1`, the operator must repackage the whole ZIP and bump the semver. The agent sees two parallel `<name>/<version>` directories and the old script keeps running on in-flight hosts.
2. **Timeout is locked inside the manifest.** `manifest.agent.timeoutMs` is set at upload time and cannot be edited from the UI. Operators who want to relax the timeout for a specific package have no knob.
3. **The "policy" concept is smeared across the ZIP.** Interval, timeout, enabled, params, agent-type all live in different places (manifest JSON / `installed_packages.interval_override_sec` / `enabled` flag / `params_json`). Configuring execution is a 4-click scavenger hunt.

## Architecture

Three layers cleanly separated:

```
  ┌──────────────────────────────────────────────────────────────┐
  │  Layer 1 — WHAT (script identity + content)                   │
  │  package_scripts(name PK, version, script_content LONGTEXT,  │
  │                  script_sha256, manifest_json, source, ...)    │
  │  ← one row per script name (overwrite on edit; no history)    │
  └──────────────────────────────────────────────────────────────┘
                              ↓ FK name
  ┌──────────────────────────────────────────────────────────────┐
  │  Layer 2 — HOW/WHEN (execution policy)                       │
  │  package_policies(name FK, interval_sec, timeout_ms, enabled, │
  │                   params_json, scope, ...)                   │
  │  ← one row per script name (V1 1:1; V2 expands via scope)     │
  └──────────────────────────────────────────────────────────────┘
                              ↓ JOIN
  ┌──────────────────────────────────────────────────────────────┐
  │  Layer 3 — RUNTIME (agent-facing shape)                       │
  │  /api/agent/packages → { name, version, manifest,            │
  │                            script (base64), params }         │
  │  ← SAME shape as today; built by joining L1 + L2 at request   │
  └──────────────────────────────────────────────────────────────┘
```

**Agent protocol unchanged.** Existing `PackageManager.syncFromCenter()` continues to receive `{ name, version, manifest, script (base64), params }`, writes the script to `data/packages/<name>/<version>/collect.ps1`, and reschedules from `manifest.agent.intervalSec`. The center pre-bakes `intervalSec` and `timeoutMs` into the manifest response so the agent sees the same shape regardless of which table the values actually live in.

**No `installed_packages` table.** Dropped. `interval_override_sec` (R19 column) is gone; its semantics move to `package_policies.interval_sec` directly (which is already the runtime value after R19's override merge on non-AD hosts).

**Built-in packages stay.** `seedBuiltinPackages` keeps running on every center startup, but it now uses the new `script-service.installScript(...)` and `script-service.setPolicy(...)` helpers. After seeding, the operator can edit the script body or policy via the UI just like uploaded scripts (operator chose "宽松" — no read-only flag for built-ins).

### Why two tables, not one wider table

- **Cleaner ownership:** policy fields change far more often than script fields. Separating avoids rewriting the (potentially large) `script_content` on every interval tweak.
- **Forward-compatible with V2:** the `scope` column is the hook for future per-host/group/site overrides. Adding a second `package_policies` row with `scope='host:NAMEDC01'` does not require touching the script body.
- **Cheaper queries:** listing "what should run" is one row per script from `package_policies`; reading script bytes is a separate fetch keyed by name.
- **Audit clarity:** `writeAudit` rows for `upload_script` / `edit_script` / `set_policy` / `delete_script` map 1:1 to which table changed.

## Data Model

### `package_scripts`

```sql
CREATE TABLE package_scripts (
  id              BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,  -- MSSQL: INT IDENTITY
  name            VARCHAR(128) NOT NULL,
  version         VARCHAR(32)  NOT NULL,
  script_content  LONGTEXT     NOT NULL,                             -- MSSQL: NVARCHAR(MAX)
  script_sha256   CHAR(64)     NOT NULL,                             -- hex sha256 of script_content bytes
  manifest_json   JSON         NOT NULL,                             -- MSSQL: NVARCHAR(MAX)
  source          VARCHAR(255) NOT NULL,                             -- 'builtin-seed' / 'admin-upload' / etc
  created_at      DATETIME     NOT NULL,
  updated_at      DATETIME     NOT NULL,
  CONSTRAINT uq_package_scripts_name UNIQUE (name)
);

CREATE INDEX ix_package_scripts_updated_at ON package_scripts(updated_at);
```

`manifest_json` shape:
```jsonc
{
  "name": "ad-domain-consistency",
  "version": "1.0.0",
  "type": "gauge",                                  // 'gauge' | 'counter' | 'status' | 'timeseries'
  "agent": {
    "type": "ad",                                   // 'ad' | 'non-ad'
    "script": "collect.ps1"                         // entry name (always 'collect.ps1' for V1)
  },
  "description": "Collects users / groups / gpos from DC and emits consistency rows",
  "schemaVersion": 1
  // NOTE: intervalSec and timeoutMs are NOT stored here in V1 — they live in package_policies
}
```

### `package_policies`

```sql
CREATE TABLE package_policies (
  id              BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(128) NOT NULL,
  interval_sec    INT          NOT NULL,
  timeout_ms      INT          NOT NULL,
  enabled         TINYINT(1)   NOT NULL DEFAULT 1,                   -- MSSQL: BIT
  params_json     JSON         NULL,                                 -- MSSQL: NVARCHAR(MAX)
  scope           VARCHAR(64)  NOT NULL DEFAULT 'global',            -- 'global' | 'agent_type:ad' | 'agent_type:non-ad' (V2 adds host:/site:/group:)
  created_at      DATETIME     NOT NULL,
  updated_at      DATETIME     NOT NULL,
  CONSTRAINT fk_package_policies_name FOREIGN KEY (name) REFERENCES package_scripts(name) ON DELETE CASCADE,
  CONSTRAINT uq_package_policies_name UNIQUE (name)
);
```

### `installed_packages` — DROP

`DROP TABLE installed_packages` after the data migration below. The R19 `interval_override_sec` column is gone — its semantics are absorbed into `package_policies.interval_sec`.

### Migration 023 — `db/migrations/023-package-scripts-policies-split.sql`

Both MySQL and MSSQL variants in their respective directories.

```sql
-- 1. CREATE new tables
CREATE TABLE package_scripts (...);
CREATE TABLE package_policies (...);

-- 2. Migrate existing rows from installed_packages
--    For each row in installed_packages:
--      a. Read the on-disk data/packages/<name>/<version>/collect.ps1 (script content)
--         — fallback: re-synthesize from manifest_json.agent.script placeholder if missing
--      b. Compute script_sha256 (hex)
--      c. INSERT INTO package_scripts (..., script_content, script_sha256, manifest_json)
--         manifest_json has agent.intervalSec + agent.timeoutMs stripped out
--      d. INSERT INTO package_policies (..., interval_sec, timeout_ms, enabled, params_json, scope)
--         — interval_sec = installed_packages.interval_override_sec ?? manifest.agent.intervalSec
--         — timeout_ms   = manifest.agent.timeoutMs ?? 30000
--         — enabled      = installed_packages.enabled
--         — params_json  = installed_packages.params_json
--         — scope        = 'global' (V1: no per-host data in installed_packages)

-- 3. DROP old table
DROP TABLE installed_packages;
```

The migration is split-executed:
- Statements 1 (CREATE) and 3 (DROP) run as plain SQL via the existing `splitSqlStatements` + `request.batch` pattern (no DELIMITER, no stored procs — R50 fix).
- Statement 2 (data migration) runs as a JS-level helper inside `migration-applier.js` that reads each row, calls the new `script-service` to write both tables, and writes a single audit row per script for `bulk_migrate`.

The migration must be **idempotent on re-run**: if `package_scripts` already exists, skip steps 1-2; if `installed_packages` is gone, skip step 3. MSSQL wraps the conditional checks in `IF NOT EXISTS` + `IF OBJECT_ID(...) IS NOT NULL` (R49 fix).

## Endpoints

### Admin (center-internal, all under `requireAuth + requirePerm('admin:users')` unless noted)

| Method | Path | Body | Returns | Notes |
|---|---|---|---|---|
| `GET` | `/api/admin/packages` | – | `{ items: [{ name, version, type, agentType, enabled, intervalSec, timeoutMs, params, scope, source, scriptSha256, manifest, updatedAt }] }` | JOINs both tables |
| `POST` | `/api/admin/packages/upload-script` | `{ name, content, type, agentType?, description?, intervalSec?, timeoutMs? }` | `{ ok: true, name, scriptSha256, version }` | NEW raw-PS1 upload; sha256 + manifest synthesized; default policy created (enabled=false) |
| `PUT` | `/api/admin/packages/:name/script` | `{ content }` | `{ ok: true, name, oldSha, newSha, updatedAt }` | NEW in-place script edit; sha256 + updated_at updated |
| `PUT` | `/api/admin/packages/:name/policy` | `{ intervalSec?, timeoutMs?, enabled?, params?, scope? }` | `{ ok: true, name, updatedAt }` | NEW unified policy edit; partial body — only present fields update |
| `PUT` | `/api/admin/packages/:name/enable` | – | `{ ok: true, name, enabled: true }` | KEPT, delegates to PUT /policy enabled=true |
| `PUT` | `/api/admin/packages/:name/disable` | – | `{ ok: true, name, enabled: false }` | KEPT, same |
| `DELETE` | `/api/admin/packages/:name` | – | `{ ok: true, name, deleted: { script: true, policy: true } }` | CASCADE deletes both rows |
| ~~`PUT`~~ | ~~`/api/admin/packages/:name/interval`~~ | – | – | **REMOVED** — fold into PUT /policy.intervalSec |
| ~~`PUT`~~ | ~~`/api/admin/packages/:name/params`~~ | – | – | **REMOVED** — fold into PUT /policy.params |

### Agent (existing endpoints, shape preserved)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/agent/packages` | Returns `{ items: [{ name, version, manifest, script (b64), params, intervalSec, timeoutMs }] }` for enabled policies. intervalSec/timeoutMs are also baked into `manifest.agent.intervalSec` / `manifest.agent.timeoutMs` so agent code is unchanged. |
| `POST` | `/api/agent/packages/:name/script` | Single-script fetch; same shape |
| `POST` | `/api/agent/packages/report` | Unchanged |

### Audit classifier additions (`center/src/services/audit-classifier.js`)

```js
PACKAGE_AUDIT_TYPES = {
  ...existing,
  upload_script:    { tag: 'package', summary: ({ name, sha }) => `上传脚本 ${name} (sha ${sha.slice(0,8)})` },
  edit_script:      { tag: 'package', summary: ({ name, oldSha, newSha }) => `编辑脚本 ${name} ${oldSha.slice(0,8)}→${newSha.slice(0,8)}` },
  set_policy:       { tag: 'package', summary: ({ name, fields }) => `设置策略 ${name} (${Object.keys(fields).join(',')})` },
  delete_script:    { tag: 'package', summary: ({ name }) => `删除脚本 ${name}` },
  bulk_migrate:     { tag: 'package', summary: ({ count }) => `从 installed_packages 迁移 ${count} 个脚本` }
}
```

## Frontend

### `PackagesView.vue` — rewrite

```
┌─ 包管理 ─────────────────────────────────────────────────────────────┐
│  [+ 上传脚本]                          [↻ 刷新]    [搜索框]         │
│  ─────────────────────────────────────────────────────────────────   │
│  名称             版本  类型  启用  间隔(s) 超时(ms) 来源    最后修改    操作 │
│  ─────────────────────────────────────────────────────────────────   │
│  ad-domain-       1.0.0 gauge ●    3600   30000   内置    2小时前   [脚本][策略][禁用][删除] │
│    consistency                                                       │
│  ad-os-baseline   1.0.0 gauge ●    1800   30000   内置    1天前     [脚本][策略][禁用][删除] │
│  custom-repl-     1.2.0 stat  ○    60     10000   上传    5分钟前   [脚本][策略][启用][删除] │
│    check                                                             │
│  ─────────────────────────────────────────────────────────────────   │
│  空状态: 暂无脚本。点 + 上传脚本 添加。                                │
└────────────────────────────────────────────────────────────────────┘
```

#### Upload modal

```
┌─ 上传脚本 ─────────────────────────────────────┐
│  名称:   [_____________________]              │
│  类型:   ( ) gauge  ( ) counter  ( ) status   │
│  Agent:  ( ) AD    ( ) 非AD                   │
│  描述:   [_____________________]              │
│  执行间隔 (秒): [_____]                       │
│  执行超时 (毫秒): [_____]                     │
│  ┌────────────────────────────────────────┐   │
│  │ # collect.ps1 内容                    │   │
│  │                                        │   │
│  │ [textarea, monospace, 20 rows]         │   │
│  │                                        │   │
│  └────────────────────────────────────────┘   │
│  [取消]                              [提交]   │
└────────────────────────────────────────────────┘
```

#### Edit script modal

```
┌─ 编辑脚本: custom-repl-check ──────────────────┐
│  当前 sha256: a1b2c3d4e5f6...                  │
│  [取消] [恢复到内置默认]              [保存]   │
│  ┌────────────────────────────────────────┐   │
│  │ [textarea with current collect.ps1]    │   │
│  │                                        │   │
│  └────────────────────────────────────────┘   │
└────────────────────────────────────────────────┘
```

#### Edit policy modal

```
┌─ 编辑策略: custom-repl-check ──────────────────┐
│  执行间隔 (秒):     [3600]                      │
│  执行超时 (毫秒):   [30000]                     │
│  启用:             [✓]                         │
│  作用域:           ( ) global                  │
│                   ( ) agent_type:ad            │
│                   ( ) agent_type:non-ad        │
│  参数 (JSON):                                     │
│  ┌────────────────────────────────────────┐   │
│  │ { "key": "value" }                     │   │
│  └────────────────────────────────────────┘   │
│  [取消]                              [保存]   │
└────────────────────────────────────────────────┘
```

## Mock sync

`center/mock-snapshot.mjs` gains two helpers:

```js
buildMockScriptEntry({ name, type, agentType, content, description, source })
buildMockPolicyEntry({ name, intervalSec, timeoutMs, enabled, params, scope })
```

`mock-heartbeat-daemon.mjs` and `mock-multi-agent.mjs` replace their `installed_packages` upsert paths with two-table inserts (scripts first to satisfy the FK, then policy). Existing 5 built-in mock scripts (`ad-domain-consistency`, `ad-os-baseline`, `ad-local-port-check`, etc.) migrate to the new shape unchanged.

Dashboard tests that assert mock data shape update to read from `package_scripts` + `package_policies` instead of `installed_packages`.

## Testing strategy

### Backend (Vitest / `node:test`)

- `tests/packages/script-service.test.js` (NEW, ~15 tests):
  - `installScript` happy path (computes sha256, synthesizes manifest, inserts both rows)
  - `installScript` duplicate name → conflict error
  - `editScript` happy path (sha256 changes, updated_at advances)
  - `editScript` same content → sha256 unchanged (no-op?)
  - `setPolicy` partial body (only present fields update)
  - `setPolicy` invalid intervalSec (e.g. < 5) → validation error
  - `setPolicy` invalid timeoutMs (e.g. < 1000) → validation error
  - `setPolicy` invalid scope (not in enum) → validation error
  - `deleteScript` cascade (both rows gone)
  - `deleteScript` missing → not-found
  - `writeAudit` called with correct args on each operation
  - SHA256 determinism (same content → same hash)
  - SHA256 collision (different content → different hash)
  - Manifest schema validation (intervalSec/timeoutMs NOT in manifest.agent)
  - Default policy values (interval=3600, timeout=30000, enabled=false, scope=global)
- `tests/packages/router.test.js` (REWRITE, ~20 tests):
  - `GET /api/admin/packages` — JOIN returns expected shape
  - `POST /upload-script` — happy + bad-input (missing name, oversized content)
  - `PUT /:name/script` — happy + missing + sha mismatch (returned sha matches actual)
  - `PUT /:name/policy` — partial body + validation + cascade
  - `PUT /:name/enable` / `disable` — delegates correctly
  - `DELETE /:name` — cascade
  - `POST /api/agent/packages` — JOIN produces same shape as R6 (regression test)
  - Auth: each new endpoint enforces `admin:users`
- `tests/dashboard.test.js` — update `installed_packages` → `package_scripts × package_policies` assertions (~10 line touch, no new tests)

### Frontend (Vitest)

- `web/tests/packages-view.test.js` (REWRITE, ~18 tests):
  - Renders all 5 builtin scripts + 0 uploaded initially
  - `+ 上传脚本` opens modal
  - Modal submit → calls uploadScript API with correct body
  - Modal validation: missing name, oversized content (>1 MB)
  - Row 启用-禁用 button toggles and calls API
  - Row 删除 button confirms then calls API
  - 编辑脚本 button opens modal with current content
  - 编辑脚本 modal save calls PUT /:name/script with new content
  - 编辑策略 modal save calls PUT /:name/policy with form fields
  - 表格 sort by 名称/最后修改
  - 空状态: shows when no scripts
  - audit-classifier 标签 in audit log page picks up new entries

### Mock

- `tests/mock-snapshot.test.js` — `buildMockScriptEntry` + `buildMockPolicyEntry` unit tests (~6 new tests), drop `installed_packages` mocks
- `tests/mock-heartbeat-daemon.test.js` — assert 2-table inserts + 5 builtin scripts still emitted
- `tests/mock-multi-agent.test.js` — same

### Live verify (operator manual restart)

1. Apply migration 023 on dev MySQL — assert all 5 builtin rows migrated, `installed_packages` is gone
2. `curl /api/agent/packages` from mock agent — assert same shape as before R66
3. Mock heartbeat daemon emits one cycle → assert all 5 scripts in `package_scripts` + 5 in `package_policies`
4. Restart mock daemon with one script's policy disabled → assert mock agent skips that script
5. Admin UI: upload new PS1 → confirm script row created with sha256, default policy
6. Admin UI: edit script content → confirm sha256 changed, audit log shows `edit_script`
7. Admin UI: edit policy interval 3600 → 60 → confirm mock agent reschedules within 5 min
8. Admin UI: disable + delete → confirm both rows gone, audit log shows `delete_script`

## Rollout

1. Migration 023 ships in `db/migrations/` — auto-applied on next center startup. Idempotent on re-run.
2. Agent binary unchanged — existing in-field agents see byte-identical responses from `/api/agent/packages` (center pre-bakes interval/timeout into manifest). **No agent restart required.**
3. Operator restart 8080 NSSM (standing directive) to load new backend code.
4. Frontend dist rebuilt via `npm run build:web` — operator restarts center process to serve new dist.
5. Mirror sync (`installer/verify-mirror.ps1`) — every modified file copied to `publish/system/...`.
6. Memory note in `progress_2026_08_29_r66.md` capturing operator directive + design decisions + commit hash.
7. Live smoke: confirm 5 builtin scripts still emit metrics post-restart; admin can upload a new PS1 and see it picked up.

## Out of scope (V2 — do NOT implement now)

- ❌ **agent-side SHA256 verification** — operator explicitly declined (`agent 继续 silent overwrite`). If center is compromised, agent runs whatever center sends. V2 revisit if threat model changes.
- ❌ **script version history** — editing a script overwrites `script_content`; old content is gone. V2 add `package_script_versions(id, name, version, content, sha, created_at)` for rollback.
- ❌ **`scope: 'host:X' / 'site:Y' / 'group:Z'`** — V1 scope is `global | agent_type:ad | agent_type:non-ad` only. V2 adds host/site/group scoping, requires per-host policy resolution logic.
- ❌ **script signing** — no Authenticode or PS1 signature verification on agent or center. V2 if compliance requires.
- ❌ **built-in vs uploaded distinction in UI** — operator chose "宽松". V1 doesn't show "内置" badge; built-ins are just another row. V2 revisit if operators start accidentally clobbering built-ins.
- ❌ **dry-run / preview** — no "preview script before save" mode. V2 if needed.
- ❌ **diff view** — no side-by-side diff for script edits. V2.
- ❌ **versioning of policies** — `set_policy` is in-place. V2 if operator wants to A/B test policies.

## Files touched (~20)

### Backend

| File | Action | Notes |
|---|---|---|
| `db/migrations/023-package-scripts-policies-split.sql` | NEW | MySQL |
| `db/migrations/mssql/023-package-scripts-policies-split.sql` | NEW | MSSQL |
| `center/src/db/sql/package-scripts.js` | NEW | UPSERT / list / get / delete |
| `center/src/db/sql/package-policies.js` | NEW | UPSERT / list / getByName / delete (cascade via FK) |
| `center/src/packages/script-service.js` | NEW | installScript / editScript / setPolicy / deleteScript + audit |
| `center/src/packages/router.js` | REWRITE | New endpoints; remove interval/params PUTs |
| `center/src/packages/runner.js` | UPDATE | JOIN two tables for /api/agent/packages |
| `center/src/services/builtin-packages.js` | UPDATE | Use script-service instead of installer.js |
| `center/src/services/audit-classifier.js` | UPDATE | Add 5 audit types |
| `center/src/services/installer.js` | DELETE | Replaced by script-service |
| `center/migrations-applier.js` (or equivalent) | UPDATE | Migration 023 wiring |

### Frontend

| File | Action | Notes |
|---|---|---|
| `center/web/src/views/admin/PackagesView.vue` | REWRITE | New upload modal + edit-script modal + edit-policy modal |
| `center/web/src/stores/packages.js` | UPDATE | New API methods: uploadScript / editScript / setPolicy / deleteScript |

### Mock

| File | Action | Notes |
|---|---|---|
| `center/mock-snapshot.mjs` | UPDATE | Add buildMockScriptEntry / buildMockPolicyEntry |
| `center/mock-heartbeat-daemon.mjs` | UPDATE | Two-table inserts |
| `center/mock-multi-agent.mjs` | UPDATE | Two-table inserts |

### Tests

| File | Action | Notes |
|---|---|---|
| `center/tests/packages/script-service.test.js` | NEW | ~15 unit tests |
| `center/tests/packages/router.test.js` | REWRITE | ~20 endpoint tests |
| `center/tests/dashboard.test.js` | UPDATE | Two-table JOIN assertions |
| `center/web/tests/packages-view.test.js` | REWRITE | ~18 view tests |
| `center/tests/mock-snapshot.test.js` | UPDATE | New helpers tested |
| `center/tests/mock-heartbeat-daemon.test.js` | UPDATE | Two-table assertions |
| `center/tests/mock-multi-agent.test.js` | UPDATE | Two-table assertions |

### Mirror + memory

| File | Action | Notes |
|---|---|---|
| `publish/system/...` (mirrors of all above) | UPDATE | verify-mirror.ps1 sync |
| `progress_2026_08_29_r66.md` | NEW | Memory note for this round |
| `MEMORY.md` | UPDATE | R66 index entry |

## Risk notes

1. **Migration 023 on existing data.** The 5 built-in packages have small collect.ps1 bodies (1-3 KB each) so the script_content migration is fast. But the migration runs in JS (not raw SQL) because it needs to read each row + write two rows + write audit. Center startup time will spike by ~500ms during migration — acceptable.

2. **Script content size.** `LONGTEXT` holds up to 4 GB. V1 limit input to 1 MB (PackagesView modal validation + service-layer guard) to prevent runaway uploads. Operator can bump if needed.

3. **Concurrent edit.** Two admins editing the same script simultaneously → last-write-wins on `script_content` (no optimistic locking V1). Audit log shows both writes; operator can diff via external tooling. V2 add `If-Match` header.

4. **`bulk_migrate` audit row.** The migration writes one audit row per script (5 rows for built-ins) plus one `bulk_migrate` summary. This is intentional — keeps the audit story complete across the migration boundary.

5. **Built-in package re-seed.** `seedBuiltinPackages` runs on every center startup. After R66, if operator edited `ad-domain-consistency`'s collect.ps1, the next startup will OVERWRITE the edit (because `installScript` is called unconditionally for each built-in). **This is the "宽松" choice working as expected** — but it's a foot-gun. V2 add a `builtin_locked` flag in the manifest to skip re-seed if the operator has edited it.

6. **Mock agent protocol regression.** The whole point of "agent protocol unchanged" is verified by the live smoke step 2. If `/api/agent/packages` shape drifts, real agents in the field break. Mitigation: `tests/packages/router.test.js` includes explicit shape-regression tests against the V1 (`R6`) snapshot.

7. **No rollback path after DROP.** `installed_packages` is gone after migration. If something goes wrong post-rollout, the rollback is to (a) restore from MySQL dump (b) re-deploy V65 code (which would skip migration 023 on re-apply — but `installed_packages` is gone so V65 code will crash). Mitigation: take a MySQL dump BEFORE applying migration 023 in production.

## Related

- [[project_ad_dashboard]] — overall project context
- R19 — `interval_override_sec` column (now absorbed into `package_policies.interval_sec`)
- R49 — ops-console visual language (reuse for new modals)
- R50 — splitSqlStatements migration pattern (required for migration 023)
- R53 — AdminLayout sidebar nav (R66 keeps `包管理` in 监控与诊断 group)
- R57 — mock-vs-real-agent gap audit (R66 keeps this gap closed at the policy layer)
