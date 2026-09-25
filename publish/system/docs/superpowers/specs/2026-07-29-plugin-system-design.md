# Plugin / Package System — Design Spec

**Date**: 2026-07-29
**Status**: Draft (pending user approval of written spec)
**Scope**: v2.0 — full vertical plugin system with hybrid metric types

## Goal

Extend the AD Replication Dashboard with a runtime-extensible package system so admins can author, install, and update monitoring packages (memory, CPU, disk, GPO, etc.) without changing center code. Packages are authored as ZIP or JSON artifacts, installed via admin UI, fetched from a static-file registry, and executed by agents as PowerShell scripts that report structured metrics back to the center.

## Scope

**In scope (full stack)**:
1. Four built-in metric types — gauge, counter, timeseries, status — each stored in a dedicated table.
2. Package format: ZIP (manifest + PS1 + optional resources) or JSON (single file with inline script).
3. Center-side: manifest validation, package install/upgrade/uninstall, registry client, metric store, REST API, admin UI.
4. Agent-side: package cache, scheduler, PS1 runner, report queue.
5. Frontend: package list / edit / registry views, metrics dashboard view, 4 metric tile components.
6. Registry: static file repo with `index.json` + packages; HTTPS only, sha256 verification.
7. Versioning: SemVer 2.0.0 with `agent.minVersion` / `center.minVersion` / `center.maxVersion` constraints.
8. Tests: unit + integration + e2e + Pester, dual dialect (MySQL 8+ / MSSQL 2014+).

**Out of scope (deferred)**:
- Cryptographic signatures / signing (trust model = "any package trusted" for v1)
- Custom Vue widgets (`widget.type` is `builtin` only; explicit `widget.vue` files are not loaded)
- Multi-registry (v1: one registry URL stored in `system_config`)
- Plugin dependency resolution (`dependencies[]` warned but not enforced)
- Time-series retention job (metric_timeseries appends forever in v1)
- Cross-package queries / cross-DC tie-in widgets
- Package marketplace UI / author tooling

## Architecture

Four components, three data flows:

```
┌─────────────────┐         ┌─────────────────┐
│  Registry repo  │ ←pull── │     Center      │
│  (static files) │  index  │  (Node.js)      │
│  index.json     │  +pkg   │                 │
│  *.zip          │         │  ┌──────────┐   │
└─────────────────┘         │  │packages/  │   │      ┌──────────────┐
                            │  │  <id>/    │   │ ←pull│    Agent     │
                            │  │  *.ps1    │   │  ─── │ (Node.js)    │
                            │  │  manifest │   │  run │ on each DC   │
                            │  └──────────┘   │  PS1 │              │
                            │                 │  ────► report JSON │
                            │  ┌──────────┐   │      │              │
                            │  │metric_*   │   │      └──────────────┘
                            │  │  tables   │   │
                            │  └──────────┘   │      ┌──────────────┐
                            │  ┌──────────┐   │ ←─── │  Frontend    │
                            │  │REST API   │   │ GET  │  (Vue 3)     │
                            │  └──────────┘   │      └──────────────┘
                            └─────────────────┘
```

**Data flows**:
1. **Admin → Center → Registry**: admin uploads/imports via `/admin/packages`; center polls registry URL (`system_config.package_registry_url`) for `index.json` to discover available updates.
2. **Agent → Center**: agent heartbeat includes `installed[]`; center returns manifest + script for each enabled package via `GET /api/agent/packages`; agent runs PS1, parses JSON, reports via `POST /api/agent/packages/report`.
3. **Frontend → Center**: dashboard widgets query `/api/dashboard/metrics/*` for aggregated data.

### New modules

**Center** (`center/src/packages/`):
- `manifest.js` — ajv schema validator for manifest.json
- `registry.js` — async fetch of registry index + package downloads with sha256
- `installer.js` — ZIP/JSON parser, install/upgrade/uninstall orchestration
- `metricstore.js` — unified upsert/query API for 4 metric tables
- `runner.js` — `/api/agent/packages*` router (read-only to agent)
- `router.js` — `/api/admin/packages*` router (CRUD)
- `compat.js` — SemVer gate checks (agent.minVersion, center.minVersion/maxVersion)

**Agent** (`agent/src/`):
- `package-manager.js` — cache management, center sync, scheduler integration
- `package-runner.js` — PS1 spawn with timeout, stdout JSON parsing, error mapping

**Frontend** (`frontend/src/views/admin/` + `frontend/src/components/metrics/`):
- `PackagesView.vue` — installed package list
- `PackageEditView.vue` — single package detail + parameter form
- `RegistryView.vue` — remote registry browser
- `MetricDashboardView.vue` — runtime metric view
- `metrics/GaugeTile.vue` / `CounterTile.vue` / `TimeseriesTile.vue` / `StatusTile.vue`

## Package format

### Distribution forms

**ZIP form** (recommended, multi-file):
```
my-package-1.0.0.zip
├── manifest.json         ← required
├── collect.ps1           ← required
├── icon.svg              ← optional
├── default-config.json   ← optional, default params values
└── widget.vue            ← optional (NOT loaded in v1; declared for forward compat)
```

**JSON form** (single file, minimal packages):
```json
{
  "manifest": { ... },
  "scripts": {
    "collect": "<base64 of PS1 content>"
  }
}
```

### Manifest schema

```json
{
  "name": "ad-memory-monitor",
  "version": "1.0.0",
  "type": "gauge",
  "description": "Monitors DC memory utilization",
  "author": "team@corp.local",
  "license": "MIT",
  "agent": {
    "minVersion": "1.1.0",
    "platforms": ["windows"],
    "runtime": "powershell",
    "script": "collect.ps1",
    "timeoutMs": 30000,
    "intervalSec": 60
  },
  "center": {
    "minVersion": "1.2.0",
    "maxVersion": "<2.0.0"
  },
  "metrics": [
    {
      "key": "mem_used_pct",
      "label": "Memory Used",
      "unit": "%",
      "thresholds": { "warn": 75, "crit": 90 }
    }
  ],
  "params": {
    "schema": {
      "type": "object",
      "properties": {
        "sampleIntervalSec": {
          "type": "integer",
          "default": 5,
          "minimum": 1,
          "maximum": 60
        }
      }
    },
    "required": []
  },
  "widget": {
    "type": "builtin",
    "component": "GaugeTile"
  },
  "dependencies": []
}
```

### Field constraints

| Field | Constraint |
|-------|-----------|
| `name` | `[a-z0-9-]+(\.[a-z0-9-]+)*` (reverse-DNS-style) |
| `version` | Strict SemVer 2.0.0 |
| `type` | Enum: `gauge` / `counter` / `timeseries` / `status` |
| `metrics[].key` | Package-unique; must not contain `.` or `:` (reserved for metric_id composition) |
| `agent.minVersion` | SemVer range; compared against agent's reported version |
| `center.minVersion` / `center.maxVersion` | SemVer range; compared against center's `package.json` version |
| `params.schema` | JSON Schema draft-07; admin UI generates form from this |
| `widget.type` | `builtin` only in v1 |
| `dependencies` | `[{name, versionRange}]`; **warned but not enforced** in v1 |

Manifests are validated with ajv using `additionalProperties: false`. Any unknown field or constraint violation rejects the install with `PKG_INVALID_MANIFEST` (400).

### Script contract

- Entry: `<script>` (no CLI args)
- Parameter passing: agent writes JSON `{"name": "<package.name>", "params": {...}}` to PS1 stdin (avoids shell escape pitfalls)
- Output: stdout **must end with a single JSON line** of shape:
  ```json
  {"metrics": {"mem_used_pct": 78.4}, "error": null}
  ```
- Exit code: 0 = success; non-zero = failure (stderr captured to `package_runs.stderr_preview`)
- Timeout: enforced by agent (`agent.timeoutMs`, default 30s); kill on expiry
- Platform: `windows` only in v1 (agent is Windows-only)

## Database schema

Migration `004-package-system.sql` adds 6 tables. Existing 12 tables unchanged.

### `installed_packages`

```sql
CREATE TABLE installed_packages (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(128) NOT NULL,
  version         VARCHAR(32) NOT NULL,
  type            VARCHAR(16) NOT NULL,            -- gauge/counter/timeseries/status
  manifest_json   JSON NOT NULL,                   -- full manifest snapshot
  enabled         TINYINT NOT NULL DEFAULT 0,
  params_json     JSON NULL,
  installed_at    DATETIME NOT NULL,
  updated_at      DATETIME NOT NULL,
  source          VARCHAR(255) NOT NULL,           -- 'local' or 'registry:<url>'
  UNIQUE KEY uq_pkg_name (name),
  KEY ix_pkg_enabled (enabled)
);
```

### `metric_gauge` (current value + thresholds)

```sql
CREATE TABLE metric_gauge (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  agent_id        VARCHAR(64) NOT NULL,
  metric_id       VARCHAR(192) NOT NULL,           -- <package.name>.<metric.key>
  ts              DATETIME NOT NULL,
  value           DOUBLE NOT NULL,
  unit            VARCHAR(16) NULL,
  threshold_warn  DOUBLE NULL,
  threshold_crit  DOUBLE NULL,
  UNIQUE KEY uq_gauge_agent_metric (agent_id, metric_id),
  KEY ix_gauge_metric_ts (metric_id, ts DESC)
);
```

### `metric_counter` (cumulative)

```sql
CREATE TABLE metric_counter (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  agent_id        VARCHAR(64) NOT NULL,
  metric_id       VARCHAR(192) NOT NULL,
  ts              DATETIME NOT NULL,
  value           BIGINT NOT NULL,
  delta           BIGINT NOT NULL DEFAULT 0,
  unit            VARCHAR(16) NULL,
  UNIQUE KEY uq_counter_agent_metric (agent_id, metric_id),
  KEY ix_counter_metric_ts (metric_id, ts DESC)
);
```

### `metric_timeseries` (multi-tag historical)

```sql
CREATE TABLE metric_timeseries (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  agent_id        VARCHAR(64) NOT NULL,
  metric_id       VARCHAR(192) NOT NULL,
  ts              DATETIME NOT NULL,
  value           DOUBLE NOT NULL,
  tags_json       JSON NULL,
  unit            VARCHAR(16) NULL,
  KEY ix_ts_agent_metric_ts (agent_id, metric_id, ts DESC)
);
```

### `metric_status` (discrete state)

```sql
CREATE TABLE metric_status (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  agent_id        VARCHAR(64) NOT NULL,
  metric_id       VARCHAR(192) NOT NULL,
  ts              DATETIME NOT NULL,
  status          VARCHAR(64) NOT NULL,
  message         VARCHAR(512) NULL,
  UNIQUE KEY uq_status_agent_metric (agent_id, metric_id),
  KEY ix_status_metric_ts (metric_id, ts DESC)
);
```

### `package_runs` (audit)

```sql
CREATE TABLE package_runs (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  agent_id        VARCHAR(64) NOT NULL,
  package_name    VARCHAR(128) NOT NULL,
  started_at      DATETIME NOT NULL,
  finished_at     DATETIME NULL,
  exit_code       INT NULL,
  stdout_preview  VARCHAR(2048) NULL,
  stderr_preview  VARCHAR(2048) NULL,
  error           VARCHAR(512) NULL,
  KEY ix_run_agent_pkg (agent_id, package_name, started_at DESC)
);
```

### Conventions

- Charset: MySQL `utf8mb4_unicode_ci`; MSSQL `NVARCHAR` + `DATETIMEOFFSET`
- Timestamps UTC; application layer renders local time
- `metric_id` = `<package.name>.<metric.key>` (single dot — do not allow `.` in user keys)
- `metric_gauge` / `metric_counter` / `metric_status`: upsert (latest wins) via `INSERT ... ON DUPLICATE KEY UPDATE` (MySQL) / `MERGE` (MSSQL)
- `metric_timeseries`: append (history preserved)
- New SQL helpers in `center/src/db/sql.js`: `installedPackages.*`, `metricGauge.*`, `metricCounter.*`, `metricTimeseries.*`, `metricStatus.*`, `packageRuns.*`

### Dual dialect

Both `db/migrations/004-package-system.sql` (MySQL) and `db/migrations/mssql/004-package-system.sql` (MSSQL) shipped together. Schema-applier tested on both — see Section 9.

## API surface

All paths under `/api/`. JWT for admin endpoints; agentToken for agent endpoints.

### Admin (`/api/admin/packages/*`)

| Method | Path | Body / Response |
|--------|------|-----------------|
| GET | `/api/admin/packages` | List installed |
| GET | `/api/admin/packages/:name` | Single package detail |
| POST | `/api/admin/packages/install` | `{ source: 'local' \| 'registry:<url>', packageRef: '<name>' \| <base64-zip> \| <zip-url> }` |
| POST | `/api/admin/packages/:name/upgrade` | `{ version?: '1.2.0' }` (omit for latest) |
| POST | `/api/admin/packages/:name/enable` | — |
| POST | `/api/admin/packages/:name/disable` | — |
| DELETE | `/api/admin/packages/:name?purgeMetrics=true` | Uninstall; optional metric cleanup |
| PUT | `/api/admin/packages/:name/params` | `{ params: {...} }` (validated against schema) |
| GET | `/api/admin/packages/registry/refresh` | Force-pull registry `index.json` |

Response envelope: `{ ok: true, data: ... }` or `{ ok: false, error: { code, message } }`.

### Agent (`/api/agent/packages/*`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/agent/packages` | List enabled packages with manifest + script content (base64) |
| GET | `/api/agent/packages/:name/script` | On-demand single-script fetch |
| POST | `/api/agent/packages/report` | `{ runs: [{ packageName, startedAt, finishedAt, exitCode, metrics, error }] }` |

### Metric query (`/api/dashboard/metrics/*`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/dashboard/metrics/summary` | Per-package × per-DC × per-metric latest, with threshold evaluation |
| GET | `/api/dashboard/metrics/timeseries?metricId=...&agentId=...&from=...&to=...` | Time-series values |
| GET | `/api/dashboard/metrics/counter-history?metricId=...&agentId=...&window=24h` | Counter delta over window |

Existing `/api/dashboard/overview` and `/api/dashboard/agents` unchanged. New metrics are presented as a separate `/dashboard/metrics` tab.

### Heartbeat extension (backward compatible)

`POST /api/agent/heartbeat` body gains an optional `packages` field:

```json
{
  "agentId": "...",
  "ts": "...",
  "agentVersion": "1.1.0",
  "replication": [...],
  "ports": [...],
  "packages": {
    "installed": ["ad-memory-monitor"],
    "pending": [],
    "lastReportAt": "..."
  }
}
```

Center treats unknown fields as no-op (forward compatible with future additions).

### Error codes

| Code | HTTP | Meaning |
|------|------|---------|
| `PKG_INVALID_MANIFEST` | 400 | Manifest fails ajv validation |
| `PKG_VALIDATION_FAILED` | 400 | ZIP/JSON content integrity check failed |
| `PKG_NAME_CONFLICT` | 409 | Same `name` already installed |
| `PKG_NOT_FOUND` | 404 | Unknown package name |
| `PKG_AGENT_INCOMPATIBLE` | 409 | Agent version < manifest.agent.minVersion |
| `PKG_CENTER_INCOMPATIBLE` | 409 | Center version outside [minVersion, maxVersion] |
| `PKG_REGISTRY_UNREACHABLE` | 502 | Registry fetch failed |
| `PKG_REGISTRY_INVALID` | 502 | `index.json` fails schema |
| `PKG_CHECKSUM_MISMATCH` | 502 | Downloaded bytes don't match sha256 |

## Agent integration

### `package-manager.js` (new module)

```js
export class PackageManager {
  constructor({ agentId, agentVersion, centerBaseUrl, agentToken, dataDir, logger, scheduler });
  async loadLocalCache();              // read data/packages/*.json
  async syncFromCenter();             // GET /api/agent/packages, diff, download
  async runOne(pkg);                  // schedule -> package-runner.runPackageScript
  enqueueReport(run);                 // in-memory queue
  async flushReports();               // POST /api/agent/packages/report
}
```

**Lifecycle**:
```
agent boot
  → PackageManager.loadLocalCache()
  → PackageManager.syncFromCenter()       // 1× at boot, then every 5 min
  → scheduler.add(package.intervalSec, runOne)
  → runOne -> spawn PS1 -> parse JSON -> enqueueReport
  → flushReports every 5s or on report queue size > 10
  → on flush failure: persist to data/report-queue.json (ring buffer, 1000 cap)
  → next flush: load + retry
```

### `package-runner.js` (new module)

```js
export async function runPackageScript({ scriptPath, params, timeoutMs, logger }) {
  // spawn powershell.exe -NoProfile -ExecutionPolicy Bypass -File <scriptPath>
  // write JSON.stringify({ name, params }) to stdin
  // collect stdout / stderr
  // on timeout: child.kill('SIGKILL')
  // parse last line of stdout as JSON; on failure, capture parseError
  // return { startedAt, finishedAt, exitCode, metrics, error }
}
```

### Cache directory

```
D:\addashboard\Agent\data\packages\
├── ad-memory-monitor\
│   ├── 1.0.0\
│   │   ├── manifest.json
│   │   ├── collect.ps1
│   │   └── content.sha256
│   └── current → 1.0.0\    (symlink, or current.json pointer)
```

Only enabled packages are cached. Disabled packages deleted on next sync.

### Failure modes

| Scenario | Agent behavior |
|----------|---------------|
| PS1 exits 0, invalid JSON | Report `runs[].error = parseError`, continue |
| PS1 exits non-zero | Report `error = 'exit N: <stderr-truncated>'`, continue |
| PS1 timeout | Kill + report `error = 'timeout after Xms'` |
| Center unreachable | Use cached manifest; queue reports locally |
| Center returns 401/403 | Stop package runner, mark fatal in heartbeat |
| Version drift (local != center) | Heartbeat `pending` flag → next sync forces re-pull |

### Existing agent module changes

| File | Change |
|------|--------|
| `agent/src/heartbeat.js` | Add `packages: { installed, pending, lastReportAt }` (unknown fields ignored by center) |
| `agent/src/config.js` | Surface `enabledPackages` from center sync |
| `agent/src/scheduler.js` | Add tasks at path `data/packages/<name>/<version>/collect.ps1` |
| `agent/src/local-queue.js` | Wrap `report-queue.json` persistence |
| `agent/src/reporter.js` | Expose `reportPackageRuns(runs)` |

## Frontend integration

### Routes

```
/admin/packages                   → PackagesView.vue
/admin/packages/:name             → PackageEditView.vue
/admin/packages/registry          → RegistryView.vue
/dashboard/metrics                → MetricDashboardView.vue
```

### `PackagesView.vue`

Table: name | version | type | enabled | source | installed_at | actions.

Top toolbar:
- `[+ 上传本地包]` — file picker accepts `.zip` / `.json`
- `[从 Registry 导入]` — link to `/admin/packages/registry`
- `[刷新 Registry]` — triggers `GET /api/admin/packages/registry/refresh`

Row actions: view · upgrade · enable/disable · uninstall.

Status badges:
- enabled=true → green "运行中"
- enabled=false → gray "已停用"
- upgrade available → yellow "待升级"

### `PackageEditView.vue`

Three sections:
1. Header card: metadata (read-only)
2. Manifest details (collapsible JSON)
3. **Parameter form** (dynamic, generated from `params.schema`)
   - Use `vue-json-schema-form` or hand-rolled for `integer`/`string`/`boolean`/`object`
   - Pre-fill from `schema.default`
   - Inline validation
   - `[保存]` → `PUT /api/admin/packages/:name/params`

Sidebar: recent runs (last 20 from `package_runs`), link to live data view.

### `RegistryView.vue`

Header: current registry URL (read-only from `system_config.package_registry_url`) + `[刷新]`.

Body: table of registry packages **not yet installed**. Each row: name | latest version | description | author | size · `[安装]` button → version picker → `POST /api/admin/packages/install`.

Empty state: shows link to `/admin/system-config` to configure registry URL.

### `MetricDashboardView.vue`

Left sidebar: package list (per row: name, type chip, enabled state) → click selects.

Right panel: package title + description + status badge → grid of metric tiles (one per metric, dispatched by `metric.type` to its component).

Top filters: `[DC: all ▼]` `[Time: last 1h ▼]`.

Cross-DC toggle: when on, same metric across agents renders as multi-line chart (ECharts legend).

### Metric tile components

`frontend/src/components/metrics/`:

| Component | Props | Behavior |
|-----------|-------|----------|
| `GaugeTile.vue` | `{ metric, currentValue, thresholdWarn, thresholdCrit, series }` | Big number; color = green / yellow / red / gray based on thresholds |
| `CounterTile.vue` | `{ metric, currentValue, delta, unit, history }` | Current value + delta arrow + mini sparkline |
| `TimeseriesTile.vue` | `{ metric, data: [{ts, value, agentId}] }` | ECharts line chart |
| `StatusTile.vue` | `{ metric, status, message, ts }` | Status badge (OK/WARN/CRIT/UNKNOWN) + description |

Use existing `useChart` composable — do not duplicate ECharts setup.

### `AppLayout.vue`

- Admin section: add `/admin/packages` and `/admin/packages/registry` links
- Main section: add `/dashboard/metrics` link

### Pinia store

`frontend/src/stores/packages.js`:

```js
export const usePackagesStore = defineStore('packages', {
  state: () => ({
    installed: [],
    registryCache: { url: null, index: [], fetchedAt: null },
    loading: false,
  }),
  actions: {
    fetchInstalled(), install({ source, packageRef }),
    enable(name), disable(name), uninstall(name),
    refreshRegistry(), updateParams(name, params),
  },
});
```

### Mirror

All new Vue files mirrored into `publish/frontend/src/views/admin/` + `publish/frontend/src/components/metrics/` + `publish/frontend/src/stores/packages.js`. Existing `scripts/verify-mirror.ps1` extended.

## Registry protocol

### Repository layout

```
addashboard-packages/                ← registry repo
├── index.json                       ← required
├── ad-memory-monitor/
│   ├── 1.0.0.zip
│   ├── 1.1.0.zip
│   └── 1.1.0.zip.sha256
├── ad-cpu-monitor/1.0.0.zip
└── ad-gpo-counter.json              ← single-file JSON form
```

### `index.json` schema

```json
{
  "$schema": "https://addashboard.local/schemas/registry-index-v1.json",
  "version": 1,
  "updatedAt": "2026-07-29T10:00:00Z",
  "packages": [
    {
      "name": "ad-memory-monitor",
      "latestVersion": "1.1.0",
      "type": "gauge",
      "description": "Monitors DC memory utilization",
      "author": "team@corp.local",
      "license": "MIT",
      "tags": ["ad", "performance"],
      "icon": "ad-memory-monitor/icon.svg",
      "versions": [
        {
          "version": "1.0.0",
          "releasedAt": "2026-06-01T00:00:00Z",
          "package": "ad-memory-monitor/1.0.0.zip",
          "size": 12345,
          "sha256": "abc123..."
        }
      ]
    }
  ]
}
```

Center validates `index.json` with ajv using `additionalProperties: false` (schema in `center/src/packages/registry-index.schema.json`).

### Center client

```js
class RegistryClient {
  fetchIndex(force = false)      // 1-hour cache; force=true bypass
  downloadToBuffer(pkgEntry)     // sha256 verify if provided
}
```

Timeouts: 10s for index, 60s for package. Cache stored at `center/data/registry-cache/`.

### Constraints

- HTTPS only (HTTP registry URLs rejected)
- CORS not required (center fetches server-side)
- Single registry URL stored in `system_config.package_registry_url`
- Asset URL (`packages[].versions[].package`) relative to `index.json` base

### Failure modes

- `fetchIndex` fails → keep stale cache; warn; UI shows last-known data
- `downloadPackage` fails → `PKG_REGISTRY_UNREACHABLE`; user-facing error
- `sha256` mismatch → `PKG_CHECKSUM_MISMATCH`; refuse install

## Versioning & compatibility

### SemVer 2.0.0

Use `node-semver` (already in root dependencies). Supported range syntax: `1.2.3`, `^1.2.3`, `~1.2.3`, `>=1.0.0`, `<2.0.0`, `1.0.0 || 2.0.0`, `*`.

### Manifest gates

| Field | Checked by | Failure |
|-------|-----------|---------|
| `agent.minVersion` | Center at install + agent at startup | `PKG_AGENT_INCOMPATIBLE` (409) |
| `center.minVersion` | Center at install | `PKG_CENTER_INCOMPATIBLE` (409) |
| `center.maxVersion` | Center at install | `PKG_CENTER_INCOMPATIBLE` (409) |
| `dependencies[].versionRange` | Center at install (warn only) | Banner in admin UI; `package_runs.error` field |

### Upgrade flow

Center compares `installed_packages.version` against `registryIndex.packages[].latestVersion` on each refresh (1h cache or button):

```js
const updates = installed.map(local => {
  const remote = registryIndex.packages.find(p => p.name === local.name);
  if (!remote) return null;
  if (semver.gt(remote.latestVersion, local.version)) {
    return { name: local.name, from: local.version, to: remote.latestVersion, ... };
  }
  return null;
}).filter(Boolean);
```

Admin UI shows "available updates" badge → one-click upgrade per package.

**Upgrade transaction**:
1. Download new package ZIP
2. Validate manifest
3. Disable old version (set `enabled = 0`)
4. Replace `installed_packages` row (same name, new version)
5. Notify agent (next sync → re-pull)
6. **Preserve metric data** (default); if `manifest.metrics[].key` was removed, old data is hidden by UI; if `type` changed, **reject upgrade** with instruction to manually uninstall.

### Uninstall

`DELETE /api/admin/packages/:name`:
- Delete `installed_packages` row
- Delete `package_runs`
- Preserve metric data by default; `?purgeMetrics=true` deletes metric rows too
- Agent next sync removes local cache

### Hard failures

| Scenario | Code | HTTP |
|----------|------|------|
| agent version < manifest.agent.minVersion | `PKG_AGENT_INCOMPATIBLE` | 409 |
| center version outside [minVersion, maxVersion] | `PKG_CENTER_INCOMPATIBLE` | 409 |
| sha256 mismatch | `PKG_CHECKSUM_MISMATCH` | 502 |
| index.json schema failure | `PKG_REGISTRY_INVALID` | 502 |

## Testing

### Layout

```
center/tests/
├── packages/
│   ├── manifest.test.js           ← ajv manifest validation
│   ├── registry.test.js           ← fetch index + sha256 + cache
│   ├── installer.test.js          ← ZIP/JSON install/upgrade/uninstall
│   ├── metricstore.test.js        ← 4 tables upsert/query
│   ├── runner.test.js             ← /api/agent/packages
│   ├── router.test.js             ← /api/admin/packages/*
│   └── compatibility.test.js      ← SemVer gates + upgrade conflicts
├── sql/
│   └── migration-004.test.js      ← dual dialect
└── e2e/
    └── plugin-system.test.js      ← full install → agent → report → dashboard

agent/tests/
├── package-manager.test.js        ← sync + cache + offline
└── package-runner.test.js         ← PS1 spawn + timeout + JSON parse

frontend/tests/
├── packages-view.test.js          ← list + actions
├── package-edit-view.test.js      ← parameter form
└── metric-tiles.test.js           ← 4 components + thresholds
```

### Critical test cases

**Manifest** (`manifest.test.js`):
- Valid manifest → accept
- Missing `name` / `version` / `type` → reject
- `type` not in enum → reject
- `version` not SemVer → reject
- `metrics[].key` contains `.` or `:` → reject
- `params.schema` not valid JSON Schema → reject
- Unknown fields → reject (additionalProperties: false)

**Installer** (`installer.test.js`):
- Valid ZIP install → table written
- Valid JSON install → table written
- Reinstall same name → `PKG_NAME_CONFLICT` 409
- Manifest invalid → `PKG_INVALID_MANIFEST` 400
- ZIP corrupt → `PKG_VALIDATION_FAILED` 400
- Upgrade preserves data; type-change conflict → reject
- Uninstall removes rows; metric data optional

**Metricstore** (`metricstore.test.js`):
- gauge: same (agent, metric) upsert → overwrite
- counter: upsert + correct delta calculation
- timeseries: append
- status: overwrite
- Cross-dialect (mysql + mssql) returns same shape
- SQL injection: `metric.key` contains `'; DROP TABLE` → safe (reject at validation)

**Compat** (`compatibility.test.js`):
- Agent 1.0.0 + package `^1.1.0` → reject
- Agent 1.1.0 + package `^1.1.0` → accept
- Center 1.0.0 + package `minVersion: 1.5.0` → reject
- sha256 mismatch → 502
- Upgrade gauge → counter → reject

**Agent runner** (`package-runner.test.js`):
- PS1 exit 0 + valid JSON → report metrics
- PS1 exit 0 + non-JSON stdout → `error: parseError`
- PS1 exit 1 → `error: exit 1` + stderr truncated
- PS1 timeout → kill + `error: timeout after Xms`
- PS1 missing → `error: spawn ENOENT`
- Large params via stdin JSON.stringify

**Frontend tiles** (`metric-tiles.test.js`):
- Gauge value < warn → green
- Gauge value between warn & crit → yellow
- Gauge value > crit → red
- Gauge value null → gray "—"
- Counter delta > 0 → ↑ arrow
- Timeseries empty → "暂无数据"
- Status status = OK → green badge

### E2E (`plugin-system.test.js`)

1. Boot center (admin exists)
2. Build fixture ZIP for `ad-memory-monitor` 1.0.0
3. `POST /api/admin/packages/install` with base64
4. Verify `installed_packages` row
5. Boot mock agent
6. Agent `GET /api/agent/packages` → manifest + script
7. Mock PS1 returns `{"metrics": {"mem_used_pct": 78.4}}`
8. Agent `POST /api/agent/packages/report`
9. Verify `metric_gauge` has 1 row
10. `GET /api/dashboard/metrics/summary` → includes metric
11. `POST /api/admin/packages/ad-memory-monitor/disable`
12. Agent next sync → cache removed
13. `DELETE /api/admin/packages/ad-memory-monitor`
14. Verify data removed

### Dual dialect requirement

```bash
TEST_MYSQL_URL=127.0.0.1 npm test --workspace=center
TEST_MSSQL_URL=myserver npm test --workspace=center
```

Integration tests skip gracefully when neither env var is set.

### Pester

`tests/pester/plugin-system.Tests.ps1`:
- Install fixture package, run once, verify center event log
- Verify NSSM service captures `package_runner` log entries

### Coverage targets

| Module | line coverage |
|--------|---------------|
| `manifest.js` | 90% |
| `installer.js` | 85% |
| `metricstore.js` | 90% (dual dialect) |
| `runner.js` / `router.js` | 80% |
| `package-manager.js` (agent) | 75% |
| `package-runner.js` (agent) | 85% |

Overall coverage must not regress from baseline (center 219/0/0 in pre-package-system state).

### Mirror verification

Extend `scripts/verify-mirror.ps1` to diff `center/src/packages/` vs `publish/center/src/packages/` (and equivalent for agent and frontend). New files must be mirrored.

## Open questions / backlog (deferred)

- Cryptographic signing of packages (Ed25519, key fingerprint allow-list)
- Custom Vue widgets loading from `widget.vue` (security review needed)
- Multi-registry support (corporate + community)
- Strict dependency resolution
- Time-series retention job (drop rows older than N days)
- `package_runs` retention (currently unbounded)
- Cross-package widget composition (e.g., one widget pulls metrics from multiple packages)
- Author tooling (CLI for `new-package`, `validate`, `publish`)
- Marketplace UI / registry host agnostic deployment
- Per-agent overrides (some packages enabled only on subset of DCs)

## Migration / rollout

- New installations: `init` wizard applies migration 004 (alongside existing schema + seed) automatically on first boot
- Existing installations: `004-package-system.sql` must be applied manually via CLI (MySQL: `mysql < 004-package-system.sql`; MSSQL: `sqlcmd -i 004-package-system.sql`); documented in `docs/operations/deployment.md` upgrade section
- Migration 004 contents are pure `CREATE TABLE IF NOT EXISTS` — no stored procedures or `DELIMITER` directives, so schema-applier (used by `/init` wizard) handles it cleanly
- Existing 12 tables untouched
- No breaking changes to existing endpoints
- Feature flag: `system_config.plugin_system_enabled` (default 1; set to 0 to hide admin UI + skip agent sync)
- Rollout: ship behind flag for one release, then enable by default
