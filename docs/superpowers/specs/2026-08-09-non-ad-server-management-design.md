# Non-AD Server Management Design

> **Status:** Brainstorming complete (12 alert decisions included), pending spec review.
> **Date:** 2026-08-09
> **Companion spec:** `docs/superpowers/specs/2026-08-09-wpf-package-designer-design.md` (will receive `agent.type` patch in a separate commit)
> **Reuses:** `2026-08-09-self-contained-monitoring-package-design` (v2 package format), `2026-08-09-port-config` (port + probe patterns).

## 1. Goal

Extend AD Replication Dashboard to also manage **Windows member servers** that live in the same AD domain but are **not domain controllers** ("非活动目录服务器"). Provide:

- Inventory (auto-discovered and admin-managed)
- Server groups with bulk install / uninstall of monitoring packages
- Per-server health baseline via a **built-in v2 self-contained package** `ad_os_baseline`
- Per-server email alerting with nested AND/OR threshold conditions
- A unified **single agent binary** whose runtime behavior is driven by `manifest.agent.type` so AD and non-AD servers share the same installation / update / lifecycle pipeline

The single binary is the WPF spec's `agent.type` switch plus this spec's non-AD half. Two specs, two plans, but one agent.

## 2. Motivation

- Today the dashboard only knows DCs (`ad_dcs`). Windows member servers that host file shares, line-of-business apps, certificates, etc. are invisible.
- Customer feedback (one quote): "另外增加一个菜单，非活动目录服务器，作为非活动目录服务器来进行管理，同时Agent 也非常不同的两类"
- Two ad-hoc facts that shaped the design:
  1. **Single exe + manifest-driven runtime** is the only way to keep install / update / NSSM service registration the same on both classes. Two binaries double the maintenance cost.
  2. **Center-side rule evaluation** is the only safe way to handle SMTP credentials and avoid every agent needing its own mail config.

## 3. Scope

In scope:

- New menu: `成员服务器` (parallel to the existing DC-facing menu — the DC menu is renamed to `AD 域控` for clarity).
- Independent tables: `ad_member_servers`, `ad_server_groups`, `ad_server_group_members`, `ad_member_server_packages`, `alert_rules`, `alert_rule_state`, `alert_events`, `alert_email_outbox`.
- `manifest.agent.type` enum `"ad" | "non-ad"` — patched into existing manifest schema, registry index schema, and the WPF package designer form.
- Built-in v2 self-contained package `ad_os_baseline` (shipped in `data/packages/ad_os_baseline/<version>/`) — collects CPU%, memory%, per-disk free space, selected Windows service state, and recent Event Log rows.
- Agent runtime switch: when `agent.type === "non-ad"`, the agent runs the member-server discovery loop (auto-register) and skips DC discovery / replication reporting.
- Per-server email alerting: rules per member server, conditions support nested AND/OR, durable state machine (`normal → pending → firing → normal`), cooldown, recovery email, SMTP via `system_config`.
- Admin CRUD: list / create / edit / delete member servers; assign to site; assign to group; bulk assign sites; full package install / upgrade / uninstall via the existing `installed_packages` path.
- NSSM-based service install with `-AgentType non-ad` flag and a per-host config (already supported by the current `scripts/install-agent.ps1` shape).

Out of scope (this spec, this plan):

- Linux / macOS agents. (Existing agent is Windows-only via NSSM; platform enum stays `["windows"]`.)
- Server configuration / change management (we collect, we don't remediate).
- Auto-remediation scripts.
- Distributed / multi-tenant alert routing.
- v1 → v2 package migration for built-in packages (only `ad_os_baseline` ships as v2).
- WPF package designer side changes other than `agent.type` enum + one starter template.

## 4. Architecture & Data Model

### 4.1 High-level flow

```
   ┌──────────────────┐   manifest.agent.type = non-ad
   │  ad_os_baseline  │ ─────────────────────────────────┐
   │  (built-in v2)   │   collect.ps1 on the member host │
   └──────────────────┘                                   │
            │ stdout JSON (per v2 contract)               │
            ▼                                             │
   ┌──────────────────┐    /api/agent/packages/report     │
   │ Non-AD Agent exe │ ─────────────────────────────────▶
   │ (one binary,     │                                   │
   │  switches by     │    /api/agent/discover (non-ad)   │
   │  manifest.type)  │ ─────────────────────────────────▶
   └──────────────────┘                                   │
                                                          ▼
            ┌────────────────────────────────────────────────────────┐
            │  Center                                                │
            │  1. metricstore.ingestRun → pkg_ad_os_baseline.metrics │
            │  2. heartbeat / last_seen_at → ad_member_servers        │
            │  3. AlertEvaluationLoop reads (1) + (2) + alert_rules   │
            │  4. EmailDeliveryLoop drains alert_email_outbox via     │
            │     SMTP (nodemailer, configured in system_config)      │
            └────────────────────────────────────────────────────────┘
```

### 4.2 `manifest.agent.type`

- Patched into `center/src/packages/manifest.js`:
  ```jsonc
  agent: {
    type: 'object',
    required: ['minVersion', 'script', 'intervalSec'],
    additionalProperties: false,
    properties: {
      type: { enum: ['ad', 'non-ad'] },          // NEW
      minVersion: { type: 'string' },
      platforms: { items: { enum: ['windows'] } },
      runtime:   { enum: ['powershell'] },
      script:    { type: 'string' },
      timeoutMs: { integer, minimum: 1000, maximum: 600000 },
      intervalSec: { integer, minimum: 5, maximum: 86400 }
    }
  }
  ```
- Same patch in `center/src/packages/registry-index.schema.json`.
- `type: "ad"` is the historical default for DC packages; the WPF form pre-selects it. `type: "non-ad"` is required for any non-DC package (e.g. `ad_os_baseline`).
- Installer / runner / metricstore need **no** changes — they already key on `manifest.database.metricTable`. The agent reads `agent.type` to pick the right runtime loop.

### 4.3 `ad_member_servers`

| Column            | MySQL type             | MSSQL type              | Notes |
|-------------------|------------------------|-------------------------|-------|
| hostname          | VARCHAR(128) PK        | NVARCHAR(128) PK        | Same value as agent's `agentId` |
| site_id           | INT NULL FK → ad_sites | INT NULL FK → ad_sites  | |
| ip_address        | VARCHAR(64) NULL       | NVARCHAR(64) NULL       | Last-known agent-reported IP |
| os_version        | VARCHAR(64) NULL       | NVARCHAR(64) NULL       | e.g. "Windows Server 2019 (10.0.17763)" |
| agent_type        | VARCHAR(16) NOT NULL   | NVARCHAR(16) NOT NULL   | Always `"non-ad"` for this table |
| enabled           | TINYINT(1) NOT NULL    | BIT NOT NULL            | Admin toggle (independent of installed_packages) |
| last_seen_at      | DATETIME NULL          | DATETIMEOFFSET NULL     | Updated by heartbeat |
| last_report_at    | DATETIME NULL          | DATETIMEOFFSET NULL     | Updated when ad_os_baseline reports |
| discovered_at     | DATETIME NOT NULL      | DATETIMEOFFSET NOT NULL | Auto-register first contact |
| discovered_via    | VARCHAR(32) NOT NULL   | NVARCHAR(32) NOT NULL   | `"self-register"` first; later `"admin"` |
| created_at        | DATETIME NOT NULL      | DATETIMEOFFSET NOT NULL | |
| updated_at        | DATETIME NOT NULL      | DATETIMEOFFSET NOT NULL | |

Constraints:
- `FK ad_member_servers_site → ad_sites(site_id) ON DELETE SET NULL`.
- `agent_type` is constant `"non-ad"` (future-proof if a different runtime is added).
- Discovery payload is verified against `ad_member_servers.hostname`; first contact upserts with `discovered_via='self-register'`.

### 4.4 `ad_server_groups` & `ad_server_group_members`

| Table | Columns | Notes |
|-------|---------|-------|
| `ad_server_groups` | `group_id INT IDENTITY(1,1) PK`, `group_name VARCHAR(128) UNIQUE NOT NULL`, `description VARCHAR(256) NULL`, `created_at`, `updated_at` | Group of member servers. |
| `ad_server_group_members` | `group_id INT FK`, `hostname VARCHAR(128) FK → ad_member_servers.hostname`, `created_at`, **PK (group_id, hostname)** | Many-to-many. |

A server may belong to any number of groups. Groups are the unit for bulk package install / uninstall and (future) bulk rule edit. This spec does not add per-group rule inheritance; rules stay per server, but the bulk install / uninstall operations target a group.

### 4.5 `ad_member_server_packages`

Tracks **which packages are enabled for which member server**, independent of the global `installed_packages`. This is needed because the global registry marks a package as installed globally, but not every member server should run every package.

| Column | Type | Notes |
|--------|------|-------|
| hostname | VARCHAR(128) FK → ad_member_servers.hostname | PK part 1 |
| package_name | VARCHAR(128) FK → installed_packages.name | PK part 2 |
| enabled | TINYINT(1) NOT NULL | Default 1 on insert |
| installed_at | DATETIME NOT NULL | |
| last_run_at | DATETIME NULL | Updated by metricstore when metrics arrive |

API surface (per-server):
- `GET  /api/admin/member-servers/:hostname/packages` — list.
- `PUT  /api/admin/member-servers/:hostname/packages/:package_name` body `{enabled}` — toggle.
- `DELETE /api/admin/member-servers/:hostname/packages/:package_name` — drop the row.

Each row determines whether the agent picks up the package on its next 5-minute `GET /api/agent/packages` sync. `enabled = 0` rows are returned to the agent as "not enabled" and dropped from its package timer list.

### 4.6 `alert_rules`, `alert_rule_state`, `alert_events`, `alert_email_outbox`

These four tables are owned by the alert engine; they live in the **main** schema, not in a per-package schema. The `manifest` of an alert rule is a JSON blob of a tree.

```jsonc
// alert_rules row (one row per server rule)
{
  "rule_id": 17,
  "hostname": "SRV-FILE-01",
  "name": "高 CPU 或 (内存+磁盘)",
  "condition": {                    // recursive AND/OR tree
    "op": "OR",
    "children": [
      { "op": "GT", "metric": "cpu_pct", "value": 90, "for_minutes": 5 },
      { "op": "GT", "metric": "memory_pct", "value": 85 },
      { "op": "AND", "children": [
          { "op": "LT", "metric": "disk_free:D",  "value": 10737418240 },
          { "op": "LT", "metric": "disk_free:E",  "value":  5368709120 }
      ]}
    ]
  },
  "for_minutes": 5,                // applies to the whole rule's threshold
  "cooldown_minutes": 30,          // re-fire cooldown after firing
  "recipients": { "to": "ops@contoso.com", "cc": null },   // null → inherit from system_config
  "enabled": 1,
  "created_at": "...",
  "updated_at": "..."
}
```

`alert_rule_state` is the **per-rule state machine** (one row per rule, per server):

| Column | Type | Notes |
|--------|------|-------|
| rule_id | INT PK FK → alert_rules | |
| state | VARCHAR(16) NOT NULL | `normal` / `pending` / `firing` |
| first_hit_at | DATETIME NULL | When the condition first became true in the current run |
| last_evaluated_at | DATETIME NOT NULL | Heartbeat from the loop |
| last_fired_at | DATETIME NULL | Set when the email is queued |
| last_recovered_at | DATETIME NULL | Set when the recovery email is queued |
| suppressed_until | DATETIME NULL | Cooldown gate |

`alert_events` is the **append-only audit log** of state transitions and emails queued, mirroring `audit_logs` shape for ergonomics:

| Column | Type |
|--------|------|
| id | BIGINT IDENTITY PK |
| rule_id | INT NOT NULL |
| hostname | VARCHAR(128) NOT NULL |
| event | VARCHAR(32) NOT NULL — `pending`, `firing`, `cooldown_skipped`, `recovered`, `manual_resolved` |
| detail | TEXT NULL (JSON-encoded condition snapshot + values) |
| created_at | DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP |
| index | (rule_id, created_at), (hostname, created_at) |

`alert_email_outbox` is the **mail delivery queue**:

| Column | Type |
|--------|------|
| id | BIGINT IDENTITY PK |
| alert_event_id | BIGINT FK → alert_events.id |
| to_addrs | VARCHAR(1024) NOT NULL (comma-joined) |
| cc_addrs | VARCHAR(1024) NULL |
| subject | VARCHAR(256) NOT NULL |
| body_text | TEXT NOT NULL |
| body_html | TEXT NULL |
| attempt_count | INT NOT NULL DEFAULT 0 |
| next_attempt_at | DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP |
| last_error | TEXT NULL |
| sent_at | DATETIME NULL |
| created_at | DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP |

Index `(sent_at, next_attempt_at)` for the delivery loop.

### 4.7 Schema migration: `014-member-servers.sql`

New dual-dialect migrations (MySQL + MSSQL) adding the eight tables above. DDL stays within the existing `CREATE TABLE IF NOT EXISTS` / `IF OBJECT_ID('…','U') IS NULL` patterns. Pure DDL — no stored procedures, no `DELIMITER`, no cross-schema references. Mirrored to `publish/db/migrations/014-*.sql` and `publish/db/migrations/mssql/014-*.sql`, registered in `scripts/verify-mirror.ps1`.

### 4.8 `system_config` SMTP keys

The following rows are added to `system_config` (no schema change, just data seeded on install):

| config_key | default | description |
|------------|---------|-------------|
| `smtp_host` | (empty) | SMTP server hostname |
| `smtp_port` | `25` | SMTP port (typically 25, 465, 587) |
| `smtp_secure` | `false` | `true` for TLS on connect (port 465) |
| `smtp_user` | (empty) | Optional auth user |
| `smtp_password` | (empty) | Plaintext per user decision; see §11 risks |
| `smtp_from` | (empty) | Default From address |
| `alert_default_to` | (empty) | Default To (comma-joined) for inherited rules |
| `alert_default_cc` | (empty) | Default CC for inherited rules |
| `alert_eval_interval_seconds` | `60` | AlertEvaluationLoop tick |
| `alert_email_max_attempts` | `5` | Max retries per outbox row |
| `alert_email_initial_backoff_seconds` | `30` | First retry delay; doubles per attempt |

API behavior (per user decision): the admin `/api/admin/config` endpoint returns `smtp_password` as `"********"` and never echoes the plaintext. `PUT /api/admin/config` accepts the field; if the submitted value is empty or `"********"`, the existing value is preserved (so the UI's `password` field can be left blank to mean "don't change"). `sys_config_audit` records `old_value: '已设置'` / `new_value: '已设置'` for password changes — the actual bytes are never written to the audit table.

## 5. Server Groups & Bulk Operations

### 5.1 Group CRUD

- `GET /api/admin/server-groups` — list with `member_count`.
- `POST /api/admin/server-groups` — body `{group_name, description}`; 409 on duplicate `group_name`.
- `PUT /api/admin/server-groups/:group_id` — rename / re-describe.
- `DELETE /api/admin/server-groups/:group_id` — drops group + members (FK `ON DELETE CASCADE`).
- `GET /api/admin/server-groups/:group_id/members` — hostnames in the group.
- `PUT /api/admin/server-groups/:group_id/members` — body `{hostnames: [...]}`; idempotent replace.

All routes use the existing `admin:users` permission. Audit actions: `create_server_group`, `update_server_group`, `delete_server_group`, `replace_server_group_members`.

### 5.2 Bulk install / uninstall via group

- `POST /api/admin/server-groups/:group_id/packages/install` — body `{package_name, confirmDropSchema: false}`. Enqueues an `ad_member_server_packages` row per enabled member of the group. Uses the existing per-package install flow to fetch + cache the package; the row in `ad_member_server_packages` is what makes the agent pick it up.
- `POST /api/admin/server-groups/:group_id/packages/:package_name/uninstall` — sets `enabled = 0` and purges the row.
- `POST /api/admin/server-groups/:group_id/packages/:package_name/enable` / `disable` — toggle without dropping the row.
- All four endpoints audit `bulk_install_package_via_group` / `bulk_uninstall_package_via_group` with `{group_id, package_name, hostname_count}`.

Per-server enable / disable mirrors this for individual hosts:

- `PUT /api/admin/member-servers/:hostname/packages/:package_name` body `{enabled}`.
- `DELETE /api/admin/member-servers/:hostname/packages/:package_name` — drops the row.

## 6. Admin UI: 成员服务器

### 6.1 Menu & layout

- `AdminLayout.vue` gains a new group `服务器管理` with two items: `成员服务器` and `服务器组`. The existing DC menu is renamed from its current label to `AD 域控` (label-only change).
- Route paths:
  - `/admin/member-servers` — list (parallel to `SitesCatalogView`).
  - `/admin/member-servers/:hostname` — detail (parallel to `DcsCatalogView`).
  - `/admin/server-groups` — list of groups.
  - `/admin/server-groups/:group_id` — group detail.
- All four routes use `meta: { perm: 'admin:users' }` (no new permission).

### 6.2 MemberServersView (list)

Table columns: `hostname`, `site_name`, `ip_address`, `os_version`, `enabled`, `last_seen_at`, `last_report_at`, `actions (详情/编辑/删除)`.

Top-right actions: `+ 新建服务器` (manual entry, hostname + site + IP), `批量导入` (reuse `BulkImportDialog` — same column set as DC bulk assign), `刷新`.

Filter bar: `仅离线` (last_seen_at older than threshold), `仅未分配站点`, `按 site 下拉筛选`.

### 6.3 MemberServerDetailView

Layout (top → bottom):
1. **Header** — hostname, site, IP, OS, agent_type badge, enabled switch, last_seen, last_report.
2. **已启用包** — list of `ad_member_server_packages` rows with per-row enable / disable / upgrade / uninstall buttons. Add Package button at top.
3. **告警规则** — rule list (per-server) with `+ 新建规则`. Each rule opens a `RuleEditorDialog`.
4. **活动告警 / 历史** — list of `alert_events` rows in two tabs.
5. **基线指标** — recharts / ECharts tile grid showing last known cpu_pct / memory_pct / per-disk free (read from `pkg_ad_os_baseline.metrics`, latest per hostname).

### 6.4 RuleEditorDialog

Form-first nested editor (per `RuleBuilder` choice A):

- Top: `任一 / 所有` segmented control.
- Body: vertical list of children. Each child is one of:
  - `条件` — `metric` dropdown (drives available options: `cpu_pct`, `memory_pct`, `disk_free:<letter>`, `service_state:<name>`, `event_log:<log>`, plus special: `heartbeat_stale`) + operator dropdown + value + per-condition `for_minutes`.
  - `子组` — recursive `任一/所有` block.
- Each child has a drag handle (uses `vue-draggable-next` — already used elsewhere) and a `删除` button.
- `+ 条件` / `+ 子组` buttons at the bottom of every block.
- Footer: rule-level `for_minutes` (default 5), `cooldown_minutes` (default 30), `收件人覆盖` (collapsible, empty = inherit), `保存` / `取消`.

Available metrics shown in dropdown depend on `ad_os_baseline` `metricSchema` keys plus the synthetic `heartbeat_stale` (resolves to `now - last_seen_at`). Future packages can extend by writing additional metric keys into the v2 metric table.

## 7. Built-in `ad_os_baseline` package

### 7.1 What it ships

Shipped at install under `data/packages/ad_os_baseline/1.0.0/`:

```
ad_os_baseline/
├── 1.0.0/
│   ├── manifest.json
│   ├── collect.ps1
│   └── migrations/
│       └── 001_initial.sql
```

The `center` install scripts pre-create this directory on first run (idempotent: skip if `manifest.json` already exists). The package is **not** in the global `installed_packages` by default — it is enabled per-server via `ad_member_server_packages` (see §4.5). This avoids forcing every DC to allocate a `pkg_ad_os_baseline` schema.

### 7.2 `manifest.json` shape

```jsonc
{
  "name": "ad-os-baseline",
  "version": "1.0.0",
  "type": "gauge",
  "description": "Windows member server baseline metrics (CPU, memory, disks, services, event log).",
  "agent": {
    "type": "non-ad",                            // ← NEW
    "minVersion": "0.1.0",
    "platforms": ["windows"],
    "runtime":   "powershell",
    "script":    "collect.ps1",
    "timeoutMs": 20000,
    "intervalSec": 60
  },
  "database": {
    "schemaName":   "pkg_ad_os_baseline",
    "migrations":   ["migrations/001_initial.sql"],
    "metricTable":  "metrics",
    "metricSchema": {
      "agent_id":     { "type": "varchar(64)",  "nullable": false },
      "ts":           { "type": "datetime",     "nullable": false },
      "cpu_pct":      { "type": "double" },
      "memory_pct":   { "type": "double" },
      "disk_free":    { "type": "json" },        // { D: bytes, E: bytes, ... }
      "disk_total":   { "type": "json" },
      "services":     { "type": "json" },        // { Spooler: "Running", ... }
      "events":       { "type": "json" }         // last N events in window
    }
  }
}
```

`migrations/001_initial.sql` creates `metrics` with the matching columns. The package is v2, so it goes through the existing DDL sandbox (the migration is hand-curated and trivially passes — pure `CREATE TABLE` against `pkg_ad_os_baseline.metrics`).

### 7.3 `collect.ps1` behavior

- Captures CPU% via `Get-Counter '\Processor(_Total)\% Processor Time'`.
- Captures memory% from `Win32_OperatingSystem` (`FreePhysicalMemory / TotalVisibleMemorySize`).
- Lists fixed disks via `Get-CimInstance Win32_LogicalDisk` and emits `{free_bytes, total_bytes}` per drive letter in `disk_free` / `disk_total`.
- Captures service state for a hard-coded allowlist (`Spooler`, `WinRM`, `W32Time`, `DNS`, `LanmanServer`, `LanmanWorkstation`, `Wecsvc`) so the JSON is bounded.
- Captures up to 20 Event Log rows from `System` and `Application` in the last 5 minutes (level ≥ Warning).
- Emits `{"metrics": {...}}` per the v2 contract. Center fills in `agent_id` and `ts` server-side (existing metricstore behavior).

### 7.4 Built-in protection

`ad_os_baseline` is **read-only by name**: `installer.uninstallPackage` rejects with `PKG_BUILTIN` if `name === 'ad-os-baseline'` and the host is non-AD. The existing global uninstall that drops the package from `installed_packages` is unaffected — only the per-server unbind via `DELETE /api/admin/member-servers/:hostname/packages/ad-os-baseline` is allowed, and even that emits an audit warning `disable_builtin_ad_os_baseline` for traceability.

## 8. Agent Runtime & Per-Server Package Pull

### 8.1 Runtime switch (single exe, manifest-driven)

In `agent/agent.js`, add an early branch on `config.agentType ?? 'ad'`:

- `ad` — existing flow unchanged: discovery → replication report → heartbeat. v2 packages that declare `agent.type === 'ad'` are accepted; others are rejected.
- `non-ad` — runs:
  1. Member-server self-register: `POST /api/admin/member-servers/self-register` (new) once on first boot.
  2. `GET /api/admin/agent/packages-for-host?hostname=...&agent_token=...` (new) returns the union of `installed_packages` (globally) and `ad_member_server_packages` rows for this host.
  3. The existing `PackageManager` already filters by `agent.platforms`; add a second filter requiring `agent.type === 'non-ad'` (or `'ad'`, matching this agent's type).
  4. `POST /api/agent/packages/report` reuses the v2 path.

The non-AD agent never calls `/api/agent/discover` with a `dc.name` payload — that route's body validator (center/src/routes/agent.js:110) requires `dc.name` and is DC-only; the new self-register endpoint lives in a separate `memberRouter` (see §8.2) so the two agent classes cannot accidentally cross-register.

### 8.2 New / extended member-server endpoints (center)

- `POST /api/admin/member-servers/self-register` — body `{hostname, agent_version, os_version, ip_address}`. Upserts into `ad_member_servers` with `discovered_via='self-register'`. Auth via the same `agent_token`. This is a **member-router** endpoint, not a per-package path; the agent calls it once on boot.
- `GET /api/admin/agent/packages-for-host` — query `?hostname=` returns the merged per-host package list. Auth: `agent_token`.
- `POST /api/agent/heartbeat` is **extended**, not duplicated. When the agent's payload includes `agent_type: "non-ad"` and a `hostname` that exists in `ad_member_servers`, the existing handler at `center/src/routes/agent.js:25-54` additionally upserts `ad_member_servers.last_seen_at = NOW()`. The existing `ad_agent_heartbeat` row continues to be written in both code paths, so DC and member-server heartbeats share a single endpoint.

### 8.3 Install-agent.ps1

Existing `scripts/install-agent.ps1` already supports NSSM install. The patch adds:

- `-AgentType` parameter with values `ad` (default) and `non-ad`.
- Writes `agentType` into the agent config JSON.
- Service display name reflects the type: `AD Dashboard Agent (DC)` vs `AD Dashboard Agent (Member)`.

Both modes use the same `agent.exe`; the type decides which routes are exercised.

### 8.4 PS1 contract — independent

`collect.ps1` (and the rest of the v2 package contract) is the **only** agent-side contract. The non-AD agent does **not** introduce a new PowerShell contract. The existing stdout-JSON shape per `metricSchema` is enough for `ad_os_baseline` and any future non-AD package. This was a user decision: "独立 PS1 契约" was confirmed as meaning "we do not regress the v2 contract", not "add a new contract". Implementation: no change to `manifest.js` regarding the `runtime: 'powershell'` and the stdout-JSON contract.

## 9. Alert Engine

### 9.1 `AlertEvaluationLoop` lifecycle

- Same factory shape as `createProbeLoop` in `center/src/services/probe.js` (returns `{start, stop, tick, isRunning}`, `setInterval` guarded by `inFlight`, `AbortSignal.timeout` for any out-of-process calls).
- Started only in normal mode from `center/server.js` after `buildServerApps`; stopped in the shutdown handler alongside `probeLoop`.
- Tick interval read from `system_config.alert_eval_interval_seconds` (default 60). A defensive floor of 10 seconds is enforced to avoid runaway DB load.

### 9.2 Per-server evaluation

For each `ad_member_servers` row where `enabled = 1`:

1. Read `alert_rules` for the hostname.
2. For each enabled rule, read the latest `pkg_ad_os_baseline.metrics` row (by `ts DESC LIMIT 1`) plus `last_seen_at` from `ad_member_servers`.
3. Evaluate the rule's `condition` tree (recursive: leaf = comparison op, branch = `AND`/`OR` over children). Each leaf returns `{hit: boolean, observedValue}`. Children are combined with the boolean operator — `AND` requires every leaf to hit, `OR` requires any one.
4. **Rule-level `for_minutes` is authoritative in v1** (per §9.4): a rule is considered "hit" when its combined boolean is true on a given tick. The state machine uses the rule-level `for_minutes` only.
5. State transitions:
   - `normal` + rule hit → `pending` (record `first_hit_at`).
   - `pending` + still hit after `first_hit_at + for_minutes` → `firing`. Insert `alert_events(firing)`, insert `alert_email_outbox` row (one per firing transition), write audit.
   - `firing` + cooldown active → no-op. (Suppressed: do not queue another email. Update `last_evaluated_at` only.)
   - `firing` + rule not hit for `for_minutes` consecutive ticks → `normal` (record `last_recovered_at`, insert `alert_events(recovered)`, insert recovery email into outbox).
6. `pending` + rule no longer hit → back to `normal` (drop `first_hit_at`).

The per-rule state write and the `alert_events` insert happen in a single transaction so a center crash mid-evaluation cannot leave the state machine in an inconsistent position. The outbox insert is in the same transaction (the delivery loop reads committed rows).

### 9.3 `EmailDeliveryLoop`

- Same factory shape, `setInterval(alert_eval_interval_seconds)` (configurable; typically the same 60s tick).
- `SELECT … FROM alert_email_outbox WHERE sent_at IS NULL AND next_attempt_at <= NOW() ORDER BY id LIMIT 25 FOR UPDATE SKIP LOCKED` (MySQL 8) or `WITH (UPDLOCK, READPAST)` (MSSQL).
- For each row: build `nodemailer` transport from `system_config.smtp_*`, render subject + body (plain text + simple HTML), send, on success: `UPDATE … SET sent_at = NOW()`. On failure: increment `attempt_count`; if `< alert_email_max_attempts`, set `next_attempt_at = NOW() + backoff(attempt_count)`; else mark `last_error` and emit a `cooldown_skipped` event.
- Backoff: `alert_email_initial_backoff_seconds * 2^(attempt_count - 1)`, capped at 1 hour.

### 9.4 Rule semantics details

- **Metrics as a "synthetic" dimension**: `heartbeat_stale` is treated as a metric where `observedValue = now - last_seen_at` (minutes). Useful for offline rules.
- **Event log rules**: a rule with `metric: 'event_log:System'` exposes `(level_min, event_id)` filters at the leaf level (the rule form gets a `Event 级别` dropdown and optional `事件 ID` input). The `for_minutes` here counts *consecutive ticks* in which the condition matches, to avoid flapping on a single high-volume log source.
- **Service rules**: `metric: 'service_state:Spooler'` with operator `EQ` and value `Running` (or `Stopped`). A service missing from the snapshot is treated as `unknown` and **does not** fire (avoids waking operators when the agent can't enumerate the service list).
- **Disk rules**: `metric: 'disk_free:D'` is in bytes; the UI shows MB/GB. A leaf with `operator: LT` and `value: 10737418240` means "less than 10 GB free".
- **Per-condition `for_minutes` vs rule-level `for_minutes`**: per-condition overrides rule-level for that leaf; the rule-level value is the default. The state machine uses the **max** of all per-leaf `for_minutes` satisfied values when computing the trigger delay. (Simpler alternative would be: rule-level is authoritative; per-condition `for_minutes` is purely for documentation. We pick the simpler one — see §11 open question.)

For v1 we pick the **simpler** interpretation: rule-level `for_minutes` is authoritative; the per-condition field is for documentation only. The UI shows per-condition `for_minutes` as a future-looking hint.

### 9.5 Permissions

Alert routes are under `admin:users` (no new permission). The reasoning: a member-server admin who can enable/disable the server should also be able to silence its alerts; per-user alert views are not in scope.

## 10. SMTP / Email Configuration UI

- `ConfigView.vue` gains a new card **SMTP / 邮件告警** (rendered above the existing port / token card).
- Fields: `smtp_host`, `smtp_port`, `smtp_secure` (checkbox), `smtp_user`, `smtp_password` (always rendered as a placeholder `********` when set; empty to clear), `smtp_from`, `alert_default_to`, `alert_default_cc`. Plus the eval interval and retry knobs (under a `高级` disclosure).
- A `发送测试邮件` button calls `POST /api/admin/config/email/test` with body `{to: "..."}`. Backend sends a one-off using current SMTP config (no rule, no audit event tagged as alert). The response surfaces the SMTP error verbatim (with a generic message to non-admins — kept simple: full error for admin role).
- Audit: every config change writes a `sys_config_audit` row; password changes are recorded as `已设置` (never the actual bytes).

## 11. Risks & Open Questions

1. **SMTP password stored plaintext in `system_config`.** Per user decision we accept this; the masking in API responses + audit-row abstraction reduces but does not eliminate the risk. Mitigation: a future plan can move secrets behind a server-side envelope-encrypted table; until then, the assumption is that the database is the security boundary.
2. **Built-in package delivery.** `ad_os_baseline` lives in `data/packages/` but the existing `installer.installPackage` expects packages in the registry or uploaded. The plan must add a seeding step on `init` / first normal-mode start that copies the shipped `ad_os_baseline/1.0.0/` into `data/packages/`. The shipped zip is committed to `publish/center/data/packages/ad_os_baseline/1.0.0/`.
3. **Agent type detection without breaking existing installs.** Default for `config.agentType` is `ad`. Existing deployed agents are not affected; new installs opt into `non-ad` via `install-agent.ps1 -AgentType non-ad`. No migration is required for `installed_agents`-style fields (we don't have a `agents` table yet).
4. **Per-condition `for_minutes` semantics.** v1 ships the simpler "rule-level authoritative" model. Per-condition fields are reserved for a future spec.
5. **Service allowlist in `ad_os_baseline` is hard-coded.** Future enhancement: read it from a per-server `params` block. Not in scope.
6. **Heartbeat vs report freshness for `heartbeat_stale`.** Two columns (`last_seen_at` from heartbeat, `last_report_at` from `ad_os_baseline`) are exposed. The synthetic metric uses `last_seen_at`; an explicit per-server `offline_threshold_minutes` setting is not added in v1.
7. **Email delivery retries on the same tick.** The delivery loop processes up to 25 rows per tick. Under sustained SMTP outage, the queue grows. Mitigated by `alert_email_max_attempts = 5` and a 1-hour cap on backoff, which is a soft bound of ~5 hours of retry per email. Acceptable for a 24×7 monitoring tool.

## 12. Testing Strategy

New test groups (all green required for the whole-branch review to pass):

### 12.1 Center unit tests

- `db/sql/member-servers.test.js` — upsert / findByHostname / list / delete (mock-db; +2 real-DB gated).
- `db/sql/server-groups.test.js` — CRUD + member replace.
- `db/sql/alert-rules.test.js` — CRUD + state upsert.
- `services/alert-engine.test.js` — recursive condition evaluation: AND/OR trees, per-leaf `for_minutes`, state transitions (normal → pending → firing → normal), recovery email emitted, cooldown suppresses re-fire.
- `services/email.test.js` — `nodemailer` mocked; verifies subject / recipients / body / retry counter / `last_error` capture. Verifies password-masking helper.
- `services/agent-packages-for-host.test.js` — merges `installed_packages` with `ad_member_server_packages`, drops `agent.type !== 'non-ad'` rows.

### 12.2 Center integration tests (real DB)

- `tests/member-servers-api.test.js` — 6 tests (create, edit, delete, list, self-register, audit).
- `tests/server-groups-api.test.js` — 5 tests.
- `tests/alert-rules-api.test.js` — 4 tests (CRUD + evaluate + fire).
- `tests/email-outbox-loop.test.js` — 3 tests (queue + send + retry).
- `tests/migrations-014.test.js` — verifies `014-member-servers.sql` applies cleanly on both dialects (idempotency + `IF OBJECT_ID` / `CREATE TABLE IF NOT EXISTS`).

### 12.3 Frontend tests

- `member-servers-view.test.js` — table render + bulk import.
- `rule-editor-dialog.test.js` — nested AND/OR add/remove, validation, save payload shape.
- `email-config-card.test.js` — password masking behavior, send test mail.

### 12.4 Agent tests (new branch `non-ad`)

- `agent/tests/agent-type.test.js` — verifies the switch honors `agent.type` from `manifest` and rejects cross-type.
- `agent/tests/self-register.test.js` — first-boot POST to `/api/admin/member-servers/self-register` is idempotent.

### 12.5 Whole-branch review checks (opus)

- `verify-mirror.ps1` is updated with the **new** source files this plan introduces. **New pairs** (count is an estimate — final list is captured at implementation time): ~10 new backend files (`center/src/services/alert-engine.js`, `center/src/services/email.js`, `center/src/services/agent-packages-for-host.js`, `center/src/routes/member-servers.js`, `center/src/db/sql/member-servers.js`, `center/src/db/sql/server-groups.js`, `center/src/db/sql/alert-rules.js`, `center/src/db/sql/alert-events.js`, `center/src/db/sql/alert-outbox.js`, plus a small `member-servers-init.js` seeder if separated from `server.js`), 1 SQL migration pair (`db/migrations/014-member-servers.sql` + `db/migrations/mssql/014-member-servers.sql`), 1 built-in package pair (`publish/center/data/packages/ad_os_baseline/1.0.0/{manifest.json, collect.ps1, migrations/001_initial.sql}` plus the `publish/center/src/services/builtin-packages.js` seeder), 4 new frontend files (`MemberServersView.vue`, `ServerGroupsView.vue`, `RuleEditorDialog.vue`, `EmailConfigCard.vue`), and 1 updated `frontend/src/api/admin.js`. Files already in the mirror list (e.g. `center/src/packages/manifest.js`, `center/src/db/sql.js`, `center/server.js`, `center/src/routes/agent.js`, `center/src/routes/admin.js`) are **patched in place** — they do not need new pairs.
- WPF `Resources/manifest-schema.json` drift test still passes (it now includes `agent.type`).
- `ad_os_baseline` zip SHA-256 in `publish/center/data/packages/ad_os_baseline/1.0.0/content.sha256` matches a clean rebuild.
- `npm run build:frontend` succeeds with the new `RuleEditorDialog` lazy chunk.

## 13. Companion: WPF Spec Patch

The WPF spec at `docs/superpowers/specs/2026-08-09-wpf-package-designer-design.md` (commit 5b75f1b) receives the following additions in a separate commit:

1. `Resources/manifest-schema.json` (embedded as `manifest-schema.json` per the WPF spec §"manifest.json — JSON Schema"): add `agent.type` enum `["ad", "non-ad"]` (default `"ad"`).
2. `PackageManifest.cs`: add `AgentType` property.
3. `ManifestFormView.xaml`: add `Agent Type` dropdown next to the existing `Platforms` / `Runtime` rows.
4. Templates: add `Non-AD starter template` (`ad-os-baseline-lite` — minimal `metricSchema` for `cpu_pct` and `memory_pct`, `agent.type: "non-ad"`, `collect.ps1` with a `Get-Counter` snippet). This is a WPF-template stub for **authoring** non-AD packages; the production built-in package shipped by center is `ad-os-baseline` (see §7).
5. §"Global Constraints" / "Risks": no change.
6. §"Testing": add 1-2 tests verifying the dropdown round-trips with the embedded schema.

The WPF patch is intentionally **minimal** — it is not a WPF redesign. The non-AD functionality lives in the new spec.

## 14. Migration / Rollout

1. Apply `014-member-servers.sql` on existing centers (init wizard auto-applies it like 013). All 8 new tables are pure additions; no data migration.
2. New permission `admin:users` is unchanged; new menus inherit it.
3. Built-in package seeding: on first normal-mode start, copy `publish/center/data/packages/ad_os_baseline/1.0.0/` into `data/packages/ad_os_baseline/1.0.0/`. Idempotent. Logged as `seed_builtin_ad_os_baseline` audit.
4. Agent rollout: customers opt in per host by re-running `install-agent.ps1 -AgentType non-ad`. No center-side agent registry is required.

## 15. Out of Scope (parked for future plans)

- Per-group rule inheritance (rules stay per server).
- Linux / macOS agents.
- SMS / Teams / Slack alerting channels.
- Auto-remediation / runbook integration.
- v1 → v2 migration of any built-in package (only `ad_os_baseline` is v2; if a v1 package ever needs to ship as built-in, a separate plan handles it).
- Per-condition `for_minutes` authoritative semantics.
- Distributed alert routing / multi-tenant.
