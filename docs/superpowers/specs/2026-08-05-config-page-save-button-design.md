# Config Page Save Button Design

> Goal: Make the `/admin/config` page's "保存" button safe to click — invalid values get caught at input time, dirty state is visible, the user is warned before navigation with unsaved changes, and risky-field edits require explicit confirmation. Phase 1 ships frontend-only; Phase 2 adds server-side audit trail with rollback.

## Context

The current implementation (`frontend/src/views/admin/ConfigView.vue`, 38 lines) is a thin shell:

```js
async function save() {
  saving.value = true; msg.value='';
  try { await adminApi.updateConfig(config.value); msg.value='已保存'; }
  catch(e){ msg.value = '保存失败'; }
  finally { saving.value = false; }
}
```

Concrete failures observed:
1. **No validation.** Setting `polling_interval_minutes = "abc"` or `center_public_port = 99999` is accepted by the frontend and either 500s on the backend or — worse — silently corrupts state.
2. **Save button always enabled.** No way to tell whether anything changed; clicking save with no edits does a full round-trip and writes a misleading audit row.
3. **Errors are swallowed.** `catch (e) { msg.value = '保存失败' }` discards the server's actual message. Users can't tell *which* field is wrong.
4. **No undo, no warning.** Editing `ad_agent_token` or `center_public_host` and clicking save instantly breaks every Agent's connection; refresh / close-tab silently loses unsaved edits.
5. **No audit trail.** Once a config change is made, there is no record of who changed what when, and no way to roll back a bad value.

Phase 1 fixes the first four in the browser only (no DB / no backend route changes). Phase 2 adds the audit table + rollback endpoints + UI to address (5).

## Architecture (Phased Delivery)

**Phase 1 — Frontend only.** No backend changes. Modifies the editor and adds two composables + two small components. Ship immediately, independently testable.

**Phase 2 — Backend audit + rollback.** Adds `sys_config_audit` table, wraps `POST /api/admin/config` in a transaction that also writes an audit row, adds `GET /api/admin/config/audit` and `POST /api/admin/config/rollback` routes, surfaces recent changes in the ConfigView footer with a [回滚] button per row.

Each phase is a separate PR with its own commit, review, and deploy. Phase 2 does not require Phase 1 (they are independent features), but Phase 2 builds on the validation groundwork Phase 1 lays.

## Phase 1 — Frontend

### File structure

| File | Change | Purpose |
|---|---|---|
| `frontend/src/views/admin/ConfigView.vue` | modify | Orchestrator — composes the form, dialog, and audit footer (Phase 2). Grows from ~38 lines to ~150. |
| `frontend/src/views/admin/ConfigFieldRow.vue` | new | Single row: `<code>` label + `<input>` + error message + description. Takes `value`, `error`, `description`, `type`, `rules` props. |
| `frontend/src/views/admin/ConfirmDialog.vue` | new | Generic modal with title / body / confirm button / cancel button. Returns a Promise. |
| `frontend/src/composables/useConfigValidation.js` | new | Per-field validation rules as a const map + `validate(config)` that returns `{ field: msg }` for all currently-invalid fields. |
| `frontend/src/composables/useDirtyState.js` | new | `dirty` ref, `snapshot` (last-saved deep clone), `markClean()`, `reset()` (rollback to snapshot), and a `beforeunload` listener registered on mount / cleaned up on unmount. |

### Validation rules

Each field has one entry in `useConfigValidation`'s rule map:

| Field | Type | Rule | Error message |
|---|---|---|---|
| `polling_interval_minutes` | int | 1 ≤ x ≤ 1440 | 采集周期必须在 1-1440 分钟之间 |
| `latency_threshold_minutes` | int | 1 ≤ x ≤ 10080 | 延迟阈值必须在 1-10080 分钟之间 |
| `heartbeat_interval_seconds` | int | 1 ≤ x ≤ 300 | 心跳间隔必须在 1-300 秒之间 |
| `history_enabled` | 0/1 | x ∈ {0, 1} | 只能填 0 或 1 |
| `ad_agent_token` | string | len ≥ 16 | Token 至少 16 字符 |
| `center_public_host` | string | non-empty AND valid hostname or IPv4 | 主机名不合法 |
| `center_public_port` | int | 1 ≤ x ≤ 65535 | 端口必须在 1-65535 之间 |

Validation runs on every `input` event (immediate feedback, no blur wait). The save button is `:disabled` whenever `Object.keys(errors).length > 0`, so invalid fields prevent submission at the UI layer.

### Dirty state

`useDirtyState(initial)` returns:

```js
{
  dirty: Ref<boolean>,       // true iff current !== snapshot (deep equal)
  snapshot: Ref<object>,     // last successful save (deep clone)
  markClean(value): void,    // called after a successful save
  reset(): void,             // rollback current to snapshot
}
```

Behavior:
- Initial state: `snapshot = deepClone(initial)`, `dirty = false`
- On input: `dirty` recomputes (cheap because config has 7 keys)
- After successful save: `markClean(current)` → `snapshot = deepClone(current)`, `dirty` becomes false
- `reset()`: `current.value = deepClone(snapshot.value)`, errors re-run, `dirty` becomes false
- `beforeunload` listener (registered in `onMounted`, cleaned in `onBeforeUnmount`): when `dirty.value === true`, calls `e.preventDefault()` to trigger the browser's native "leave site?" prompt
- Save button: `:disabled="!dirty || saving || hasErrors"`
- Cancel button: `@click="reset"`, `:disabled="!dirty || saving"`

The "未保存" indicator is rendered as `<span v-if="dirty">⚠ 有未保存的修改</span>` between the table and the save button.

### Error display

Backend already returns structured JSON on 4xx (`{ fieldErrors: { key: msg }, error: msg }` — confirmed with user). Client flow on save failure:

1. If response body has `fieldErrors`: iterate keys, set per-row error via the `useConfigValidation` error map, highlight the corresponding `ConfigFieldRow`.
2. If response body has `error` (no `fieldErrors`): show top-level toast "保存失败: <msg>".
3. If response body is non-JSON or network error: show toast "保存失败，请重试".

The `catch (e)` block falls through to (3) for any unexpected exception.

### Confirmation

Risky fields: `ad_agent_token`, `center_public_host`, `center_public_port`.

Before sending the save request, check `Object.keys(diff(current, snapshot)).filter(k => RISKY_FIELDS.includes(k))`:

- Non-empty → show `ConfirmDialog` with title "以下字段会影响 Agent 连接" and a bullet list of changed risky fields.
- Cancel → abort save, no API call.
- Confirm → proceed with the existing save flow.
- Empty → skip the dialog entirely.

Non-risky field edits go straight to save.

### Component breakdown (Phase 1)

```
ConfigView.vue
├── <h2>系统配置</h2>
├── <table>
│   └── <ConfigFieldRow v-for="(v, k) in config" :key="k" ... />
├── <span v-if="dirty">⚠ 有未保存的修改</span>
├── <button @click="save" :disabled="!dirty || saving || hasErrors">保存</button>
├── <button @click="reset" :disabled="!dirty || saving">取消修改</button>
├── <ConfirmDialog v-if="showConfirm" ... />
└── (Phase 2 footer will live here)
```

### Testing strategy (Phase 1)

- **Vitest unit** for `useConfigValidation`: each rule's happy / boundary / failure cases (e.g., port=0, port=65536, port=1, port=65535). At least 14 cases (2 per field × 7 fields).
- **Vitest unit** for `useDirtyState`: dirty detection across edits, `reset()` restores snapshot, `markClean()` clears dirty, `beforeunload` listener registered and cleaned up.
- **Vitest component** for `ConfigFieldRow`: renders label / input / error, applies error styling.
- **Vitest component** for `ConfirmDialog`: shows / hides on prop change, emits confirm / cancel events.
- **Manual smoke** in browser: edit valid → save → toast "已保存" → edit invalid → button disabled → edit risky → dialog → cancel → no API call.

## Phase 2 — Backend audit + rollback

### Schema

New table `sys_config_audit`:

```sql
CREATE TABLE sys_config_audit (
  id INT PRIMARY KEY AUTO_INCREMENT,
  config_key VARCHAR(64) NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_by INT,                 -- FK sys_users.id (NULL allowed for system actions)
  changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  change_type ENUM('UPDATE','ROLLBACK') NOT NULL DEFAULT 'UPDATE',
  INDEX idx_changed_at (changed_at DESC),
  INDEX idx_config_key (config_key)
);
```

Dialect variants in `center/src/db/sql.js` and the matching MSSQL migration script. `publish/migrations/` gets the same `migration_NNNN_sys_config_audit.sql`.

### Backend route changes

| Route | Change |
|---|---|
| `POST /api/admin/config` | Wrap existing UPSERT in a transaction. Before `COMMIT`, `INSERT` one row per changed key into `sys_config_audit`. Compute `old_value` by reading the prior row from `system_config`. Skip keys whose `old_value === new_value`. |
| `GET /api/admin/config/audit` | New. Returns last 20 audit rows joined with `sys_users.username` for display. |
| `POST /api/admin/config/rollback` | New. Body: `{ auditId }`. Reads the audit row, UPSERTs `system_config` back to `old_value`, writes a new audit row with `change_type='ROLLBACK'`, `new_value=auditRow.old_value`, `old_value=auditRow.new_value`. All inside one transaction. |

`auditLogs.write` (already in `sql.js:43-46`) is reused; no schema change there.

### Frontend audit UI

Below the existing config table, a collapsible "历史变更 (最近 20 条)" section showing:

| config_key | old_value → new_value | changed_by | changed_at | 操作 |
|---|---|---|---|---|
| `center_public_port` | `8080` → `8443` | `admin` | 2026-08-05 14:23 | [回滚] |

The [回滚] button is hidden for the rows that are themselves rollback entries (no double-rollback). Click → `ConfirmDialog` "确认回滚到旧值？" → `POST /api/admin/config/rollback` → toast "已回滚" → refresh both the config form and the audit list.

Audit UI lives inside `ConfigView.vue` after the save/cancel buttons. No new top-level route — admins already land on `/admin/config`.

### Testing strategy (Phase 2)

- **Backend integration** for `POST /api/admin/config`: when a value changes, an audit row is written; when the value is unchanged, no audit row.
- **Backend integration** for `POST /api/admin/config/rollback`: target key reverts; new audit row has `change_type='ROLLBACK'`.
- **Mirror to `publish/center/`**: SQL changes mirrored; route changes mirrored; migration script mirrored.
- **Manual**: edit a value, save, see audit row; click rollback, see value revert + second audit row.

## Risks & Open Questions

1. **Browser `beforeunload` quirk.** Modern browsers ignore `e.preventDefault()` and require `e.returnValue = ''` to actually prompt. Implementation will set both, with a fallback message string. If browsers ignore it entirely (some Chrome configurations), users still have the visible "⚠ 有未保存的修改" indicator and a Cancel button.
2. **ConfirmDialog promise semantics.** Vue 3's `<Teleport>` + `<Transition>` complicate async confirm flow. Implementation will use a single shared reactive `confirmState` (title, body, resolver) rather than per-call props, to keep the modal lifecycle simple.
3. **Phase 2 audit table size.** Without a retention policy the table grows unbounded. Phase 2 does not include auto-purge — a follow-up backlog item adds `DELETE FROM sys_config_audit WHERE changed_at < NOW() - INTERVAL 90 DAY` as a nightly job.
4. **MSSQL `change_type` ENUM.** MSSQL has no native ENUM; equivalent is `VARCHAR(16) WITH CHECK CONSTRAINT`. The migration script handles both dialects.
5. **No "discard" for partial rollback.** Phase 2 rollback reverts the *whole key* to the snapshot's old_value. Editing one field in the form and rolling back a different field from the audit list is allowed but not atomic across keys. Out of scope for this design.