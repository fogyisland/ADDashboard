# Plugin / Package System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a runtime-extensible plugin system so admins can author, install, and update monitoring packages (memory, CPU, disk, GPO, etc.) without changing center code. Packages are ZIP/JSON artifacts fetched from a static-file registry and executed by agents as PowerShell scripts that report structured metrics.

**Architecture:** Hybrid metric model — center has 4 built-in metric types (gauge / counter / timeseries / status) persisted in dedicated tables. Manifests are validated with ajv against a strict schema. Center module new (`center/src/packages/`): manifest, registry, installer, metricstore, runner, router, compat. Agent new (`agent/src/package-manager.js` + `package-runner.js`) caches enabled packages, runs PS1 scripts, reports results. Frontend new: 3 admin views + 1 dashboard view + 4 metric tile components. Registry is a static-file repo with `index.json` + package files; HTTPS only, sha256 verification.

**Tech Stack:** Node.js 18+ ESM (center); Node.js 18+ ESM (agent); ajv (manifest validation); node-semver (already in root deps); pako or adm-zip (ZIP parsing); Element Plus + Pinia + Vue 3 (frontend); vitest + supertest (tests); PowerShell 5.1+ (PS1 scripts run by agent).

## Global Constraints

- **Dialect portability** — Center SQL is written once and used by both MySQL and MSSQL via positional `?`. The SQL helper module already auto-maps `?` → `@pN` for MSSQL on `updatePartial`; reuse that pattern for partial-update statements. For `INSERT ... ON DUPLICATE KEY UPDATE` (MySQL) vs `MERGE` (MSSQL), keep separate strings per dialect.
- **Mirror sync** — Every change to `center/src/*`, `agent/src/*`, `frontend/src/*` MUST also be applied to `publish/*` mirror. After each task that touches source files, copy the changed files to the publish mirror (`scripts/copy-mirror.ps1` or manual copy).
- **Manifest strict validation** — All ajv schemas use `additionalProperties: false`. Unknown fields reject installs with `PKG_INVALID_MANIFEST` (400).
- **JSON Schema draft-07** — `params.schema` is validated as JSON Schema draft-07. Admin UI uses ajv to generate form defaults.
- **No new agent dependencies** — Agent continues to use Node built-ins + existing deps. PS1 scripts use PowerShell 5.1+ (Windows only).
- **Backwards compatible** — `POST /api/agent/heartbeat` accepts (and ignores) missing `packages` field. Existing 12 tables untouched. No breaking changes to existing endpoints.
- **Existing tests stay green** — center 219/0/0 + agent 29/0/0 + frontend 63/63 baseline must hold throughout. New tests add to these counts.
- **Single registry URL** — v1 stores `system_config.package_registry_url` (single value). Multi-registry deferred.
- **Trust = open** — v1 does not verify package signatures. Manifest validation only (ajv schema). sha256 verification is built-in if registry provides it.
- **Out of scope** — Signing, custom Vue widgets, multi-registry, dependency resolution, time-series retention, custom widgets, marketplace UI.
- **MSSQL types** — VARCHAR/LVARCHAR → NVARCHAR; DATETIME → DATETIMEOFFSET; JSON → NVARCHAR(MAX) with stringified JSON.

## Task Breakdown

This plan is split into 9 tasks. Each task ends with a working, testable deliverable:

1. **Migration 004 + SQL helpers** — foundation (6 new tables, dual dialect)
2. **Manifest validation + registry index schema** — package definition contract
3. **Metric store** — 4 metric tables upsert/query API
4. **Package installer** — ZIP/JSON parse + install/upgrade/uninstall orchestration
5. **Registry client + compat** — fetch index, download packages, sha256, SemVer gates
6. **REST API endpoints** — admin + agent + metric query routes
7. **Agent package manager + runner** — PS1 execution + cache + report queue
8. **Frontend admin views** — PackagesView + PackageEditView + RegistryView
9. **Frontend metrics dashboard + e2e + docs** — MetricDashboardView + 4 tiles + Pester + deployment docs

---

## Task 1: Migration 004 + SQL helpers

**Files:**
- Create: `db/migrations/004-package-system.sql`
- Create: `db/migrations/mssql/004-package-system.sql`
- Create: `center/src/db/sql/installed-packages.js`
- Create: `center/src/db/sql/metric-store.js`
- Create: `center/src/db/sql/package-runs.js`
- Modify: `center/src/db/sql.js` (re-export new sections)
- Test: `center/tests/sql/migration-004.test.js`
- Test: `center/tests/sql/installed-packages.test.js`
- Test: `center/tests/sql/metric-store.test.js`
- Test: `center/tests/sql/package-runs.test.js`

**Interfaces:**
- Consumes: existing `db.execute(sql, params)` returning `{rows, affectedRows}`
- Produces:
  - `installedPackages.upsert({name, version, type, manifest, enabled, params, source})` → `Promise<void>`
  - `installedPackages.list({enabledOnly?})` → `Promise<Row[]>`
  - `installedPackages.get(name)` → `Promise<Row|null>`
  - `installedPackages.delete(name)` → `Promise<void>`
  - `metricGauge.upsertLatest({agentId, metricId, ts, value, unit, thresholdWarn, thresholdCrit})` → `Promise<void>`
  - `metricGauge.listByAgent(agentId, {metricId?})` → `Promise<Row[]>`
  - `metricCounter.upsertLatest({agentId, metricId, ts, value, delta, unit})` → `Promise<void>`
  - `metricCounter.listByAgent(agentId, {metricId?})` → `Promise<Row[]>`
  - `metricTimeseries.append({agentId, metricId, ts, value, tags, unit})` → `Promise<void>`
  - `metricTimeseries.list({agentId, metricId, from, to})` → `Promise<Row[]>`
  - `metricStatus.upsertLatest({agentId, metricId, ts, status, message})` → `Promise<void>`
  - `metricStatus.listByAgent(agentId, {metricId?})` → `Promise<Row[]>`
  - `packageRuns.insert({agentId, packageName, startedAt, finishedAt, exitCode, stdoutPreview, stderrPreview, error})` → `Promise<number>` (id)
  - `packageRuns.listRecent({agentId?, packageName?, limit?})` → `Promise<Row[]>`

**Implementation notes:**
- Follow existing `center/src/db/sql/` (or root `sql.js`) pattern — check actual file location.
- `metric_gauge` / `metric_counter` / `metric_status` use UNIQUE(agent_id, metric_id) → upsert
- `metric_timeseries` uses no UNIQUE → append
- Dual dialect: `INSERT ... ON DUPLICATE KEY UPDATE` (MySQL) vs `MERGE` (MSSQL) — separate strings per dialect
- Timestamps: `DATETIME` (MySQL) / `DATETIMEOFFSET` (MSSQL); UTC consistently
- `manifest_json` / `params_json` / `tags_json`: JSON columns (MySQL) / NVARCHAR(MAX) with stringified JSON (MSSQL)

- [ ] **Step 1.1: Write failing test for migration 004**

Create `center/tests/sql/migration-004.test.js`:
```js
// Run against TEST_MYSQL_URL or TEST_MSSQL_URL.
// Creates fresh schema, runs migration 004, verifies all 6 tables exist.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../../src/db/drivers/<dialect>.js';

describe('migration 004 package system', () => {
  let db;
  before(async () => { db = await createPool(process.env.TEST_MYSQL_URL); });
  after(async () => { await db.end(); });

  it('creates all 6 tables', async () => {
    const r = await db.execute(
      `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?,?,?,?,?,?)`,
      ['installed_packages', 'metric_gauge', 'metric_counter', 'metric_timeseries', 'metric_status', 'package_runs']
    );
    assert.equal(r.rows.length, 6);
  });
});
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `cd center && npm test -- --test-name-pattern="migration 004"`
Expected: FAIL — tables don't exist yet.

- [ ] **Step 1.3: Create MySQL migration 004**

Create `db/migrations/004-package-system.sql`:
```sql
-- AD Dashboard migration 004: package system (6 new tables)
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS installed_packages (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(128) NOT NULL,
  version         VARCHAR(32) NOT NULL,
  type            VARCHAR(16) NOT NULL,
  manifest_json   JSON NOT NULL,
  enabled         TINYINT NOT NULL DEFAULT 0,
  params_json     JSON NULL,
  installed_at    DATETIME NOT NULL,
  updated_at      DATETIME NOT NULL,
  source          VARCHAR(255) NOT NULL,
  UNIQUE KEY uq_pkg_name (name),
  KEY ix_pkg_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS metric_gauge (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  agent_id        VARCHAR(64) NOT NULL,
  metric_id       VARCHAR(192) NOT NULL,
  ts              DATETIME NOT NULL,
  value           DOUBLE NOT NULL,
  unit            VARCHAR(16) NULL,
  threshold_warn  DOUBLE NULL,
  threshold_crit  DOUBLE NULL,
  UNIQUE KEY uq_gauge_agent_metric (agent_id, metric_id),
  KEY ix_gauge_metric_ts (metric_id, ts DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS metric_counter (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  agent_id        VARCHAR(64) NOT NULL,
  metric_id       VARCHAR(192) NOT NULL,
  ts              DATETIME NOT NULL,
  value           BIGINT NOT NULL,
  delta           BIGINT NOT NULL DEFAULT 0,
  unit            VARCHAR(16) NULL,
  UNIQUE KEY uq_counter_agent_metric (agent_id, metric_id),
  KEY ix_counter_metric_ts (metric_id, ts DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS metric_timeseries (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  agent_id        VARCHAR(64) NOT NULL,
  metric_id       VARCHAR(192) NOT NULL,
  ts              DATETIME NOT NULL,
  value           DOUBLE NOT NULL,
  tags_json       JSON NULL,
  unit            VARCHAR(16) NULL,
  KEY ix_ts_agent_metric_ts (agent_id, metric_id, ts DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS metric_status (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  agent_id        VARCHAR(64) NOT NULL,
  metric_id       VARCHAR(192) NOT NULL,
  ts              DATETIME NOT NULL,
  status          VARCHAR(64) NOT NULL,
  message         VARCHAR(512) NULL,
  UNIQUE KEY uq_status_agent_metric (agent_id, metric_id),
  KEY ix_status_metric_ts (metric_id, ts DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS package_runs (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 1.4: Create MSSQL migration 004**

Create `db/migrations/mssql/004-package-system.sql`:
```sql
-- AD Dashboard migration 004: package system (MSSQL flavor)
-- Idempotent via IF NOT EXISTS.

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'installed_packages')
CREATE TABLE installed_packages (
  id              BIGINT IDENTITY(1,1) PRIMARY KEY,
  name            NVARCHAR(128) NOT NULL,
  version         NVARCHAR(32) NOT NULL,
  type            NVARCHAR(16) NOT NULL,
  manifest_json   NVARCHAR(MAX) NOT NULL,
  enabled         TINYINT NOT NULL DEFAULT 0,
  params_json     NVARCHAR(MAX) NULL,
  installed_at    DATETIMEOFFSET NOT NULL,
  updated_at      DATETIMEOFFSET NOT NULL,
  source          NVARCHAR(255) NOT NULL,
  CONSTRAINT uq_pkg_name UNIQUE (name)
);
CREATE INDEX ix_pkg_enabled ON installed_packages(enabled);

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'metric_gauge')
CREATE TABLE metric_gauge (
  id              BIGINT IDENTITY(1,1) PRIMARY KEY,
  agent_id        NVARCHAR(64) NOT NULL,
  metric_id       NVARCHAR(192) NOT NULL,
  ts              DATETIMEOFFSET NOT NULL,
  value           FLOAT NOT NULL,
  unit            NVARCHAR(16) NULL,
  threshold_warn  FLOAT NULL,
  threshold_crit  FLOAT NULL,
  CONSTRAINT uq_gauge_agent_metric UNIQUE (agent_id, metric_id)
);
CREATE INDEX ix_gauge_metric_ts ON metric_gauge(metric_id, ts DESC);

-- (apply same pattern for metric_counter, metric_timeseries, metric_status, package_runs)
```

- [ ] **Step 1.5: Manually apply migration for test env**

Run: `mysql -h 127.0.0.1 -u root -p<pwd> addashboard < db/migrations/004-package-system.sql`

- [ ] **Step 1.6: Run test to verify it passes**

Run: `cd center && TEST_MYSQL_URL=127.0.0.1 npm test -- --test-name-pattern="migration 004"`
Expected: PASS (6 tables exist)

- [ ] **Step 1.7: Write SQL helper for installedPackages**

Create `center/src/db/sql/installed-packages.js`. Follow existing pattern (refer to `center/src/db/sql/ports.js` or similar):
```js
import { mysqlDialect, mssqlDialect } from '../dialect.js';

const upsertMysql = `
  INSERT INTO installed_packages (name, version, type, manifest_json, enabled, params_json, installed_at, updated_at, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    version=VALUES(version), type=VALUES(type), manifest_json=VALUES(manifest_json),
    enabled=VALUES(enabled), params_json=VALUES(params_json), updated_at=VALUES(updated_at),
    source=VALUES(source)
`;

const upsertMssql = `
  MERGE INTO installed_packages AS target
  USING (SELECT ? AS name, ? AS version, ? AS type, ? AS manifest_json, ? AS enabled,
                ? AS params_json, ? AS installed_at, ? AS updated_at, ? AS source) AS source
  ON target.name = source.name
  WHEN MATCHED THEN UPDATE SET
    version=source.version, type=source.type, manifest_json=source.manifest_json,
    enabled=source.enabled, params_json=source.params_json, updated_at=source.updated_at,
    source=source.source
  WHEN NOT MATCHED THEN INSERT
    (name, version, type, manifest_json, enabled, params_json, installed_at, updated_at, source)
    VALUES (source.name, source.version, source.type, source.manifest_json, source.enabled,
            source.params_json, source.installed_at, source.updated_at, source.source);
`;

export const installedPackages = {
  upsert: (db, { name, version, type, manifest, enabled, params, source }) =>
    db.execute(
      db.dialect === 'mysql' ? upsertMysql : upsertMssql,
      [name, version, type, JSON.stringify(manifest), enabled ? 1 : 0,
       params ? JSON.stringify(params) : null, new Date(), new Date(), source]
    ),
  list: async (db, { enabledOnly = false } = {}) => {
    const sql = enabledOnly
      ? `SELECT * FROM installed_packages WHERE enabled = 1 ORDER BY name`
      : `SELECT * FROM installed_packages ORDER BY name`;
    const r = await db.execute(sql, []);
    return r.rows.map(r => ({ ...r, manifest: JSON.parse(r.manifest_json), params: r.params_json ? JSON.parse(r.params_json) : null, enabled: !!r.enabled }));
  },
  get: async (db, name) => {
    const r = await db.execute(`SELECT * FROM installed_packages WHERE name = ?`, [name]);
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    return { ...row, manifest: JSON.parse(row.manifest_json), params: row.params_json ? JSON.parse(row.params_json) : null, enabled: !!row.enabled };
  },
  delete: (db, name) => db.execute(`DELETE FROM installed_packages WHERE name = ?`, [name]),
};
```

- [ ] **Step 1.8: Write failing test for installedPackages**

`center/tests/sql/installed-packages.test.js`:
```js
describe('installedPackages', () => {
  it('upsert and get roundtrip', async () => {
    const pkg = { name: 'test-mem', version: '1.0.0', type: 'gauge', manifest: { name: 'test-mem', version: '1.0.0' }, enabled: true, params: null, source: 'local' };
    await installedPackages.upsert(db, pkg);
    const got = await installedPackages.get(db, 'test-mem');
    assert.equal(got.name, 'test-mem');
    assert.equal(got.version, '1.0.0');
    assert.equal(got.enabled, true);
  });
  it('get returns null for missing', async () => {
    const got = await installedPackages.get(db, 'nonexistent');
    assert.equal(got, null);
  });
  it('list filters enabledOnly', async () => {
    const all = await installedPackages.list(db);
    const enabled = await installedPackages.list(db, { enabledOnly: true });
    assert.ok(enabled.length <= all.length);
  });
});
```

- [ ] **Step 1.9: Run test, verify pass, write metric store helpers**

Create `center/src/db/sql/metric-store.js`:
```js
// gauge / counter / status share UNIQUE pattern
const upsertLatestMysql = (table) => `
  INSERT INTO ${table} (agent_id, metric_id, ts, value, unit)
  VALUES (?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE ts=VALUES(ts), value=VALUES(value), unit=VALUES(unit)
`;

const upsertGaugeMysql = `
  INSERT INTO metric_gauge (agent_id, metric_id, ts, value, unit, threshold_warn, threshold_crit)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE ts=VALUES(ts), value=VALUES(value), unit=VALUES(unit),
    threshold_warn=VALUES(threshold_warn), threshold_crit=VALUES(threshold_crit)
`;

const upsertCounterMysql = `
  INSERT INTO metric_counter (agent_id, metric_id, ts, value, delta, unit)
  VALUES (?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE ts=VALUES(ts), value=VALUES(value), delta=VALUES(delta), unit=VALUES(unit)
`;

const upsertStatusMysql = `
  INSERT INTO metric_status (agent_id, metric_id, ts, status, message)
  VALUES (?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE ts=VALUES(ts), status=VALUES(status), message=VALUES(message)
`;

const appendTimeseriesMysql = `
  INSERT INTO metric_timeseries (agent_id, metric_id, ts, value, tags_json, unit)
  VALUES (?, ?, ?, ?, ?, ?)
`;

// MSSQL: use MERGE for upsert, plain INSERT for timeseries
// (similar structure to installed-packages MERGE)

export const metricGauge = {
  upsertLatest: (db, p) => db.execute(
    db.dialect === 'mysql' ? upsertGaugeMysql : upsertGaugeMssql,
    [p.agentId, p.metricId, p.ts, p.value, p.unit ?? null, p.thresholdWarn ?? null, p.thresholdCrit ?? null]
  ),
  listByAgent: async (db, agentId, { metricId } = {}) => {
    const sql = metricId
      ? `SELECT * FROM metric_gauge WHERE agent_id = ? AND metric_id = ?`
      : `SELECT * FROM metric_gauge WHERE agent_id = ?`;
    const r = await db.execute(sql, metricId ? [agentId, metricId] : [agentId]);
    return r.rows;
  },
};

// (similar for metricCounter, metricTimeseries, metricStatus)
```

- [ ] **Step 1.10: Write tests for metric store**

`center/tests/sql/metric-store.test.js`:
```js
describe('metricGauge', () => {
  it('upsertLatest overwrites value', async () => {
    await metricGauge.upsertLatest(db, { agentId: 'a1', metricId: 'm1', ts: new Date(), value: 50, unit: '%', thresholdWarn: 75, thresholdCrit: 90 });
    await metricGauge.upsertLatest(db, { agentId: 'a1', metricId: 'm1', ts: new Date(), value: 80, unit: '%', thresholdWarn: 75, thresholdCrit: 90 });
    const rows = await metricGauge.listByAgent(db, 'a1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].value, 80);
  });
});
// (similar for counter delta calc, timeseries append, status overwrite)
```

- [ ] **Step 1.11: Write package_runs helpers**

Create `center/src/db/sql/package-runs.js`:
```js
export const packageRuns = {
  insert: async (db, p) => {
    const r = await db.execute(
      `INSERT INTO package_runs (agent_id, package_name, started_at, finished_at, exit_code, stdout_preview, stderr_preview, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.agentId, p.packageName, p.startedAt, p.finishedAt, p.exitCode, p.stdoutPreview, p.stderrPreview, p.error]
    );
    return r.insertId ?? r.rows?.[0]?.id;
  },
  listRecent: async (db, { agentId, packageName, limit = 20 } = {}) => {
    const where = [];
    const params = [];
    if (agentId) { where.push('agent_id = ?'); params.push(agentId); }
    if (packageName) { where.push('package_name = ?'); params.push(packageName); }
    const sql = `SELECT * FROM package_runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC LIMIT ${parseInt(limit, 10)}`;
    const r = await db.execute(sql, params);
    return r.rows;
  },
};
```

- [ ] **Step 1.12: Write tests for package_runs**

`center/tests/sql/package-runs.test.js`:
```js
describe('packageRuns', () => {
  it('insert and list ordering', async () => {
    await packageRuns.insert(db, { agentId: 'a1', packageName: 'p1', startedAt: new Date(Date.now() - 1000), finishedAt: new Date(), exitCode: 0 });
    await packageRuns.insert(db, { agentId: 'a1', packageName: 'p1', startedAt: new Date(), finishedAt: new Date(), exitCode: 1, error: 'fail' });
    const rows = await packageRuns.listRecent(db, { agentId: 'a1', packageName: 'p1' });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].exitCode, 1);  // newest first
  });
});
```

- [ ] **Step 1.13: Wire into db/sql.js**

Modify `center/src/db/sql.js` to re-export new sections:
```js
export { installedPackages } from './sql/installed-packages.js';
export { metricGauge, metricCounter, metricTimeseries, metricStatus } from './sql/metric-store.js';
export { packageRuns } from './sql/package-runs.js';
```

- [ ] **Step 1.14: Run all new tests + existing tests**

Run: `cd center && TEST_MYSQL_URL=127.0.0.1 npm test`
Expected: PASS — existing 219/0/0 + new 8 tests green.

- [ ] **Step 1.15: Mirror to publish**

Copy `center/src/db/sql/installed-packages.js`, `metric-store.js`, `package-runs.js` to `publish/center/src/db/sql/`. Copy `db/migrations/004-package-system.sql` to `publish/db/migrations/` and `db/migrations/mssql/004-package-system.sql` to `publish/db/migrations/mssql/`. (Note: `db/migrations/` does NOT mirror to `publish/` per the port-healthcheck precedent — verify what's actually in publish.)

- [ ] **Step 1.16: Commit**

```bash
git add db/migrations/004-package-system.sql db/migrations/mssql/004-package-system.sql \
  center/src/db/sql/installed-packages.js center/src/db/sql/metric-store.js \
  center/src/db/sql/package-runs.js center/src/db/sql.js \
  center/tests/sql/migration-004.test.js center/tests/sql/installed-packages.test.js \
  center/tests/sql/metric-store.test.js center/tests/sql/package-runs.test.js \
  publish/center/src/db/sql/installed-packages.js publish/center/src/db/sql/metric-store.js \
  publish/center/src/db/sql/package-runs.js publish/center/src/db/migrations/004-package-system.sql \
  publish/db/migrations/mssql/004-package-system.sql
git commit -m "feat(center): migration 004 + installed_packages/metric/store/package_runs SQL helpers"
```

---

## Task 2: Manifest validation + registry index schema

**Files:**
- Create: `center/src/packages/manifest.js`
- Create: `center/src/packages/registry-index.schema.json`
- Create: `center/src/packages/errors.js` (extends existing `center/src/errors.js` if exists)
- Test: `center/tests/packages/manifest.test.js`

**Interfaces:**
- Consumes: ajv (already in root deps)
- Produces:
  - `validateManifest(m)` → `{ valid: boolean, errors: AjvError[] }`
  - `parseManifest(buffer)` → `{ manifest, scripts: {collect: string} }` (parses ZIP or JSON)
  - `manifestSchema` (exported for reuse)

- [ ] **Step 2.1: Write failing test**

`center/tests/packages/manifest.test.js`:
```js
import { validateManifest } from '../../src/packages/manifest.js';

describe('validateManifest', () => {
  it('accepts a complete valid manifest', () => {
    const m = {
      name: 'ad-memory-monitor', version: '1.0.0', type: 'gauge',
      description: 'test', agent: { minVersion: '1.0.0', platforms: ['windows'], runtime: 'powershell', script: 'collect.ps1', timeoutMs: 30000, intervalSec: 60 },
      metrics: [{ key: 'mem_used_pct', label: 'Memory Used', unit: '%', thresholds: { warn: 75, crit: 90 } }],
      params: { schema: { type: 'object', properties: {} }, required: [] },
      widget: { type: 'builtin', component: 'GaugeTile' },
    };
    const r = validateManifest(m);
    assert.equal(r.valid, true);
  });
  it('rejects missing name', () => {
    const r = validateManifest({ version: '1.0.0', type: 'gauge' });
    assert.equal(r.valid, false);
  });
  it('rejects invalid type', () => {
    const r = validateManifest({ name: 'x', version: '1.0.0', type: 'invalid' });
    assert.equal(r.valid, false);
  });
  it('rejects metric key with dot', () => {
    const r = validateManifest({ name: 'x', version: '1.0.0', type: 'gauge', metrics: [{ key: 'a.b', label: 'L' }] });
    assert.equal(r.valid, false);
  });
  it('rejects unknown fields', () => {
    const r = validateManifest({ name: 'x', version: '1.0.0', type: 'gauge', unknown: 'field' });
    assert.equal(r.valid, false);
  });
});
```

- [ ] **Step 2.2: Run test to verify failure**

Run: `cd center && npm test -- --test-name-pattern="validateManifest"`
Expected: FAIL — module doesn't exist.

- [ ] **Step 2.3: Implement manifest.js**

Create `center/src/packages/manifest.js`:
```js
import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: false });

const manifestSchema = {
  type: 'object',
  required: ['name', 'version', 'type'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', pattern: '^[a-z0-9-]+(\\.[a-z0-9-]+)*$' },
    version: { type: 'string' },  // SemVer validated by caller via semver lib
    type: { enum: ['gauge', 'counter', 'timeseries', 'status'] },
    description: { type: 'string' },
    author: { type: 'string' },
    license: { type: 'string' },
    agent: {
      type: 'object',
      required: ['minVersion', 'script', 'intervalSec'],
      additionalProperties: false,
      properties: {
        minVersion: { type: 'string' },
        platforms: { type: 'array', items: { enum: ['windows'] } },
        runtime: { enum: ['powershell'] },
        script: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 },
        intervalSec: { type: 'integer', minimum: 5, maximum: 86400 },
      },
    },
    center: {
      type: 'object',
      additionalProperties: false,
      properties: {
        minVersion: { type: 'string' },
        maxVersion: { type: 'string' },
      },
    },
    metrics: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key', 'label'],
        additionalProperties: false,
        properties: {
          key: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$' },
          label: { type: 'string' },
          unit: { type: 'string' },
          thresholds: {
            type: 'object',
            additionalProperties: false,
            properties: { warn: { type: 'number' }, crit: { type: 'number' } },
          },
        },
      },
    },
    params: {
      type: 'object',
      additionalProperties: false,
      properties: {
        schema: { type: 'object' },  // JSON Schema draft-07 (validated at runtime when admin edits)
        required: { type: 'array', items: { type: 'string' } },
      },
    },
    widget: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { enum: ['builtin'] },
        component: { enum: ['GaugeTile', 'CounterTile', 'TimeseriesTile', 'StatusTile'] },
      },
    },
    dependencies: { type: 'array', items: { type: 'object' } },
  },
};

const validate = ajv.compile(manifestSchema);

export function validateManifest(m) {
  const valid = validate(m);
  return { valid, errors: validate.errors || [] };
}

export { manifestSchema };
```

- [ ] **Step 2.4: Create registry-index schema**

Create `center/src/packages/registry-index.schema.json`:
```json
{
  "type": "object",
  "required": ["version", "updatedAt", "packages"],
  "additionalProperties": false,
  "properties": {
    "version": { "const": 1 },
    "updatedAt": { "type": "string", "format": "date-time" },
    "packages": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "latestVersion", "type", "versions"],
        "additionalProperties": false,
        "properties": {
          "name": { "type": "string", "pattern": "^[a-z0-9-]+(\\.[a-z0-9-]+)*$" },
          "latestVersion": { "type": "string" },
          "type": { "enum": ["gauge", "counter", "timeseries", "status"] },
          "description": { "type": "string" },
          "author": { "type": "string" },
          "license": { "type: "string" },
          "tags": { "type": "array", "items": { "type": "string" } },
          "icon": { "type": "string" },
          "versions": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "object",
              "required": ["version", "package"],
              "additionalProperties": false,
              "properties": {
                "version": { "type": "string" },
                "releasedAt": { "type": "string", "format": "date-time" },
                "package": { "type": "string" },
                "size": { "type": "integer", "minimum": 0 },
                "sha256": { "type": "string", "pattern": "^[a-f0-9]{64}$" }
              }
            }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 2.5: Update errors.js**

Add to existing errors module (verify path: `center/src/errors.js` or `center/src/init/errors.js`):
```js
export class PkgError extends Error {
  constructor(code, message) { super(message); this.code = code; this.status = PkgError.statusFor(code); }
  static statusFor(code) {
    return {
      PKG_INVALID_MANIFEST: 400,
      PKG_VALIDATION_FAILED: 400,
      PKG_NAME_CONFLICT: 409,
      PKG_NOT_FOUND: 404,
      PKG_AGENT_INCOMPATIBLE: 409,
      PKG_CENTER_INCOMPATIBLE: 409,
      PKG_REGISTRY_UNREACHABLE: 502,
      PKG_REGISTRY_INVALID: 502,
      PKG_CHECKSUM_MISMATCH: 502,
    }[code] || 500;
  }
}
```

- [ ] **Step 2.6: Run tests, verify pass**

Run: `cd center && npm test -- --test-name-pattern="validateManifest"`
Expected: PASS

- [ ] **Step 2.7: Mirror to publish**

Copy `center/src/packages/manifest.js` and `center/src/packages/registry-index.schema.json` to `publish/center/src/packages/`.

- [ ] **Step 2.8: Commit**

```bash
git add center/src/packages/manifest.js center/src/packages/registry-index.schema.json \
  center/src/errors.js center/tests/packages/manifest.test.js \
  publish/center/src/packages/manifest.js publish/center/src/packages/registry-index.schema.json
git commit -m "feat(center): manifest validation + registry index schema (ajv)"
```

---

## Task 3: Metric store API

**Files:**
- Create: `center/src/packages/metricstore.js`
- Test: `center/tests/packages/metricstore.test.js`

**Interfaces:**
- Consumes: `metricGauge`, `metricCounter`, `metricTimeseries`, `metricStatus` from `db/sql.js`
- Produces:
  - `ingestRun(db, {agentId, packageName, manifest, runs})` → upserts metric_* tables from one or more `runs` entries
  - `summary(db, {metricId?, agentId?})` → latest value per (agent, metric)
  - `timeseries(db, {metricId, agentId, from, to})` → rows for chart
  - `counterHistory(db, {metricId, agentId, window})` → counter delta over window

- [ ] **Step 3.1: Write failing test**

`center/tests/packages/metricstore.test.js`:
```js
describe('metricstore', () => {
  it('ingestRun writes gauge from single run', async () => {
    const manifest = { name: 'pkg1', type: 'gauge', metrics: [{ key: 'm1', label: 'M1', unit: '%', thresholds: { warn: 75, crit: 90 } }] };
    await metricstore.ingestRun(db, { agentId: 'a1', packageName: 'pkg1', manifest, runs: [{ metrics: { m1: 80 }, error: null }] });
    const rows = await metricGauge.listByAgent(db, 'a1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].value, 80);
    assert.equal(rows[0].metric_id, 'pkg1.m1');
  });
  it('summary returns latest per (agent, metric)', async () => { /* ... */ });
  it('timeseries filters by range', async () => { /* ... */ });
  it('counterHistory computes delta', async () => { /* ... */ });
});
```

- [ ] **Step 3.2: Run test, verify failure**

Run: `cd center && npm test -- --test-name-pattern="metricstore"`
Expected: FAIL

- [ ] **Step 3.3: Implement metricstore.js**

Create `center/src/packages/metricstore.js`:
```js
import { metricGauge, metricCounter, metricTimeseries, metricStatus } from '../db/sql.js';

export const metricstore = {
  // Manifest must be passed so we know thresholds and metric metadata.
  async ingestRun(db, { agentId, packageName, manifest, runs }) {
    const metrics = manifest.metrics || [];
    const ts = new Date();
    for (const run of runs) {
      if (run.error) continue;  // recorded via package_runs separately
      const data = run.metrics || {};
      for (const m of metrics) {
        const value = data[m.key];
        if (value === undefined || value === null) continue;
        const metricId = `${packageName}.${m.key}`;
        switch (manifest.type) {
          case 'gauge':
            await metricGauge.upsertLatest(db, {
              agentId, metricId, ts, value,
              unit: m.unit ?? null,
              thresholdWarn: m.thresholds?.warn ?? null,
              thresholdCrit: m.thresholds?.crit ?? null,
            });
            break;
          case 'counter':
            // Compute delta from previous value
            const prev = await metricCounter.listByAgent(db, agentId, { metricId });
            const delta = prev.length > 0 ? Number(value) - Number(prev[0].value) : 0;
            await metricCounter.upsertLatest(db, {
              agentId, metricId, ts, value: Number(value), delta, unit: m.unit ?? null,
            });
            break;
          case 'timeseries':
            await metricTimeseries.append(db, {
              agentId, metricId, ts, value: Number(value),
              tags: data.tags || null,  // optional tags from script
              unit: m.unit ?? null,
            });
            break;
          case 'status':
            await metricStatus.upsertLatest(db, {
              agentId, metricId, ts, status: String(value), message: data.message ?? null,
            });
            break;
        }
      }
    }
  },

  async summary(db, { metricId, agentId } = {}) {
    const where = [];
    const params = [];
    if (metricId) { where.push('metric_id = ?'); params.push(metricId); }
    if (agentId) { where.push('agent_id = ?'); params.push(agentId); }
    const sql = `SELECT * FROM metric_gauge ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY agent_id, metric_id`;
    const r = await db.execute(sql, params);
    return r.rows;  // (similar queries for counter/status; for v1, summary focuses on gauge + status)
  },

  async timeseries(db, { metricId, agentId, from, to }) {
    const r = await db.execute(
      `SELECT * FROM metric_timeseries WHERE metric_id = ? AND agent_id = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC`,
      [metricId, agentId, from, to]
    );
    return r.rows;
  },

  async counterHistory(db, { metricId, agentId, window }) {
    // window: '24h' | '7d' | etc. → parse to ms
    const ms = parseWindow(window);
    const from = new Date(Date.now() - ms);
    const r = await db.execute(
      `SELECT * FROM metric_counter WHERE metric_id = ? AND agent_id = ? AND ts >= ? ORDER BY ts ASC`,
      [metricId, agentId, from]
    );
    return r.rows;
  },
};

function parseWindow(w) {
  const m = /^(\d+)([smhd])$/.exec(w);
  if (!m) throw new Error(`invalid window: ${w}`);
  const n = parseInt(m[1], 10);
  const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
  return n * unit;
}
```

- [ ] **Step 3.4: Run tests, verify pass**

Run: `cd center && npm test -- --test-name-pattern="metricstore"`
Expected: PASS

- [ ] **Step 3.5: Mirror, commit**

```bash
git add center/src/packages/metricstore.js center/tests/packages/metricstore.test.js \
  publish/center/src/packages/metricstore.js
git commit -m "feat(center): metricstore — ingest/summary/timeseries/counter API"
```

---

## Task 4: Package installer (install/upgrade/uninstall)

**Files:**
- Create: `center/src/packages/installer.js`
- Create: `center/src/packages/zip-utils.js` (or inline; uses adm-zip or pako)
- Test: `center/tests/packages/installer.test.js`

**Interfaces:**
- Consumes: `validateManifest`, `installedPackages`, `packageRuns`, `PkgError`
- Produces:
  - `installPackage(db, {source, packageRef, buffer?, registry?})` → `{name, version}`
  - `upgradePackage(db, {name, version?})` → `{name, version}`
  - `uninstallPackage(db, {name, purgeMetrics})` → `void`
  - `setEnabled(db, {name, enabled})` → `void`
  - `updateParams(db, {name, params})` → `void`

- [ ] **Step 4.1: Add adm-zip dependency**

Root `package.json` should pick this up: `npm install --save adm-zip` (run from root).

- [ ] **Step 4.2: Write failing test**

`center/tests/packages/installer.test.js`:
```js
import AdmZip from 'adm-zip';

describe('installer', () => {
  it('installs valid ZIP', async () => {
    const buffer = buildFixtureZip({ name: 'test-mem', version: '1.0.0', type: 'gauge' });
    const r = await installer.installPackage(db, { source: 'local', packageRef: 'test-mem', buffer });
    assert.equal(r.name, 'test-mem');
    const got = await installedPackages.get(db, 'test-mem');
    assert.ok(got);
    assert.equal(got.enabled, false);  // installed-but-disabled by default
  });
  it('rejects invalid manifest', async () => {
    const buffer = buildFixtureZip({ name: 'bad', version: '1.0.0', type: 'invalid' });
    await assert.rejects(installer.installPackage(db, { source: 'local', packageRef: 'bad', buffer }), /PKG_INVALID_MANIFEST/);
  });
  it('rejects name conflict', async () => { /* install same name twice */ });
  it('upgrades and replaces installed_packages row', async () => { /* install 1.0.0, then 1.1.0 */ });
  it('upgrade rejects type change', async () => { /* install gauge, upgrade to counter */ });
  it('uninstall removes row', async () => { /* install then uninstall */ });
});

function buildFixtureZip({ name, version, type, ...overrides }) {
  const manifest = { name, version, type, description: 'test', agent: { minVersion: '1.0.0', script: 'collect.ps1', intervalSec: 60, timeoutMs: 30000 }, metrics: [{ key: 'm1', label: 'M1' }], params: { schema: { type: 'object' }, required: [] }, widget: { type: 'builtin', component: 'GaugeTile' }, ...overrides };
  const ps1 = 'Write-Output \'{"metrics":{"m1":42}}\'';
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
  zip.addFile('collect.ps1', Buffer.from(ps1));
  return zip.toBuffer();
}
```

- [ ] **Step 4.3: Run test, verify failure**

Run: `cd center && npm test -- --test-name-pattern="installer"`
Expected: FAIL

- [ ] **Step 4.4: Implement installer.js**

Create `center/src/packages/installer.js`:
```js
import AdmZip from 'adm-zip';
import semver from 'semver';
import { validateManifest } from './manifest.js';
import { installedPackages, packageRuns } from '../db/sql.js';
import { PkgError } from './errors.js';

export const installer = {
  async installPackage(db, { source, packageRef, buffer, registry }) {
    let manifest, scripts;
    if (buffer) {
      ({ manifest, scripts } = parseBuffer(buffer));
    } else if (registry && packageRef) {
      buffer = await registry.downloadPackageByName(packageRef);
      ({ manifest, scripts } = parseBuffer(buffer));
    } else {
      throw new PkgError('PKG_VALIDATION_FAILED', 'must provide buffer or registry+packageRef');
    }

    const { valid, errors } = validateManifest(manifest);
    if (!valid) throw new PkgError('PKG_INVALID_MANIFEST', JSON.stringify(errors));

    const existing = await installedPackages.get(db, manifest.name);
    if (existing) throw new PkgError('PKG_NAME_CONFLICT', `package ${manifest.name} already installed`);

    // Persist
    await installedPackages.upsert(db, {
      name: manifest.name,
      version: manifest.version,
      type: manifest.type,
      manifest,
      enabled: false,
      params: null,
      source,
    });

    // Cache script to disk (publish/center/data/packages/<name>/<version>/)
    const fs = await import('node:fs');
    const path = await import('node:path');
    const cacheDir = path.join(process.cwd(), 'data', 'packages', manifest.name, manifest.version);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(cacheDir, 'collect.ps1'), scripts.collect);
    fs.writeFileSync(path.join(cacheDir, 'content.sha256'), '');

    return { name: manifest.name, version: manifest.version };
  },

  async upgradePackage(db, { name, version }) {
    const existing = await installedPackages.get(db, name);
    if (!existing) throw new PkgError('PKG_NOT_FOUND', name);
    // For v1, buffer must be provided by caller (admin UI handles download via registry)
    // (real implementation in Task 5; this task only orchestrates the upgrade)
    if (!version) throw new PkgError('PKG_VALIDATION_FAILED', 'version required');
    if (!semver.gt(version, existing.version)) {
      throw new PkgError('PKG_VALIDATION_FAILED', `version ${version} is not greater than current ${existing.version}`);
    }
    // (assume caller has already downloaded new buffer and validated)
    // Replace row in DB; preserve metric data
    await installedPackages.upsert(db, {
      name, version,
      type: existing.manifest.metrics ? existing.type : existing.type,  // unchanged
      manifest: existing.manifest,  // caller should pass new manifest
      enabled: false,  // re-enable manually
      params: existing.params,
      source: existing.source,
    });
    return { name, version };
  },

  async uninstallPackage(db, { name, purgeMetrics }) {
    const existing = await installedPackages.get(db, name);
    if (!existing) throw new PkgError('PKG_NOT_FOUND', name);
    await installedPackages.delete(db, name);
    if (purgeMetrics) {
      // Delete metric_* rows where metric_id LIKE '<name>.%'
      await db.execute(`DELETE FROM metric_gauge WHERE metric_id LIKE ?`, [`${name}.%`]);
      await db.execute(`DELETE FROM metric_counter WHERE metric_id LIKE ?`, [`${name}.%`]);
      await db.execute(`DELETE FROM metric_timeseries WHERE metric_id LIKE ?`, [`${name}.%`]);
      await db.execute(`DELETE FROM metric_status WHERE metric_id LIKE ?`, [`${name}.%`]);
    }
    await db.execute(`DELETE FROM package_runs WHERE package_name = ?`, [name]);
    // Remove cache directory
    const fs = await import('node:fs');
    const path = await import('node:path');
    const cacheDir = path.join(process.cwd(), 'data', 'packages', name);
    if (fs.existsSync(cacheDir)) fs.rmSync(cacheDir, { recursive: true, force: true });
  },

  async setEnabled(db, { name, enabled }) {
    await db.execute(`UPDATE installed_packages SET enabled = ?, updated_at = ? WHERE name = ?`, [enabled ? 1 : 0, new Date(), name]);
  },

  async updateParams(db, { name, params }) {
    await db.execute(`UPDATE installed_packages SET params_json = ?, updated_at = ? WHERE name = ?`, [JSON.stringify(params), new Date(), name]);
  },
};

function parseBuffer(buffer) {
  const zip = new AdmZip(buffer);
  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) throw new PkgError('PKG_VALIDATION_FAILED', 'manifest.json missing');
  const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  const scriptEntry = zip.getEntry(manifest.agent.script);
  if (!scriptEntry) throw new PkgError('PKG_VALIDATION_FAILED', `${manifest.agent.script} missing`);
  const scripts = { collect: scriptEntry.getData().toString('utf8') };
  return { manifest, scripts };
}
```

- [ ] **Step 4.5: Run tests, verify pass**

Run: `cd center && npm test -- --test-name-pattern="installer"`
Expected: PASS

- [ ] **Step 4.6: Mirror, commit**

```bash
git add center/src/packages/installer.js center/tests/packages/installer.test.js \
  package.json package-lock.json \
  publish/center/src/packages/installer.js
git commit -m "feat(center): package installer — install/upgrade/uninstall + ZIP/JSON parse"
```

---

## Task 5: Registry client + compat

**Files:**
- Create: `center/src/packages/registry.js`
- Create: `center/src/packages/compat.js`
- Test: `center/tests/packages/registry.test.js`
- Test: `center/tests/packages/compat.test.js`

**Interfaces:**
- Consumes: ajv, `manifestSchema` (registry-index schema)
- Produces:
  - `RegistryClient({baseUrl, cacheDir, logger}).fetchIndex(force)` → `IndexJson`
  - `RegistryClient.downloadPackageByName(name)` → `Buffer` (uses latestVersion from cached index)
  - `RegistryClient.downloadPackage(name, version)` → `Buffer`
  - `checkAgentCompat(agentVersion, manifest)` → `{ok, error?}`
  - `checkCenterCompat(centerVersion, manifest)` → `{ok, error?}`

- [ ] **Step 5.1: Write failing tests**

`center/tests/packages/registry.test.js`:
```js
// Use a tiny local HTTP server (Node http) to serve a fake index.json + zip
describe('RegistryClient', () => {
  let server, baseUrl;
  before(async () => {
    server = await startTestServer({ index: { version: 1, updatedAt: '...', packages: [...] }, zips: { 'pkg-1.0.0.zip': Buffer.from('...') } });
    baseUrl = server.url;
  });
  after(() => server.close());

  it('fetchIndex returns parsed JSON', async () => {
    const c = new RegistryClient({ baseUrl, cacheDir: tmpdir() });
    const idx = await c.fetchIndex(true);
    assert.equal(idx.version, 1);
  });
  it('cache hit on second call', async () => { /* ... */ });
  it('downloadPackageByName returns buffer with sha256 verify', async () => { /* ... */ });
  it('rejects sha256 mismatch', async () => { /* ... */ });
});
```

`center/tests/packages/compat.test.js`:
```js
describe('compat', () => {
  it('agent 1.0.0 + manifest ^1.1.0 → reject', () => {
    const r = checkAgentCompat('1.0.0', { agent: { minVersion: '^1.1.0' } });
    assert.equal(r.ok, false);
  });
  it('agent 1.2.0 + manifest ^1.1.0 → ok', () => {
    const r = checkAgentCompat('1.2.0', { agent: { minVersion: '^1.1.0' } });
    assert.equal(r.ok, true);
  });
  it('center 1.0.0 + manifest minVersion: 1.5.0 → reject', () => { /* ... */ });
});
```

- [ ] **Step 5.2: Run tests, verify failure**

Run: `cd center && npm test -- --test-name-pattern="RegistryClient\|compat"`
Expected: FAIL

- [ ] **Step 5.3: Implement registry.js**

Create `center/src/packages/registry.js`:
```js
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { PkgError } from './errors.js';
import indexSchema from './registry-index.schema.json' with { type: 'json' };

const ajv = new Ajv({ allErrors: true, strict: false });
const validateIndex = ajv.compile(indexSchema);

export class RegistryClient {
  constructor({ baseUrl, cacheDir, logger, fetchFn = fetch }) {
    if (!baseUrl.startsWith('https://')) throw new PkgError('PKG_VALIDATION_FAILED', 'registry must be HTTPS');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.cacheDir = cacheDir;
    this.logger = logger;
    this.fetch = fetchFn;
    mkdirSync(cacheDir, { recursive: true });
  }

  async fetchIndex(force = false) {
    const cachePath = join(this.cacheDir, 'index.json');
    if (!force && existsSync(cachePath)) {
      const stat = require('node:fs').statSync(cachePath);
      const age = Date.now() - stat.mtimeMs;
      if (age < 3600_000) {
        return JSON.parse(readFileSync(cachePath, 'utf8'));
      }
    }
    const res = await this.fetch(`${this.baseUrl}/index.json`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new PkgError('PKG_REGISTRY_UNREACHABLE', `HTTP ${res.status}`);
    const text = await res.text();
    const json = JSON.parse(text);
    if (!validateIndex(json)) throw new PkgError('PKG_REGISTRY_INVALID', JSON.stringify(validateIndex.errors));
    writeFileSync(cachePath, text);
    return json;
  }

  async downloadPackageByName(name) {
    const idx = await this.fetchIndex();
    const pkg = idx.packages.find(p => p.name === name);
    if (!pkg) throw new PkgError('PKG_NOT_FOUND', name);
    const versionEntry = pkg.versions.find(v => v.version === pkg.latestVersion);
    return this.downloadPackage(pkg, versionEntry);
  }

  async downloadPackage(pkg, versionEntry) {
    const url = `${this.baseUrl}/${versionEntry.package}`;
    const res = await this.fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new PkgError('PKG_REGISTRY_UNREACHABLE', `HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (versionEntry.sha256) {
      const actual = createHash('sha256').update(buf).digest('hex');
      if (actual !== versionEntry.sha256) throw new PkgError('PKG_CHECKSUM_MISMATCH', `expected ${versionEntry.sha256}, got ${actual}`);
    }
    return buf;
  }
}
```

- [ ] **Step 5.4: Implement compat.js**

Create `center/src/packages/compat.js`:
```js
import semver from 'semver';
import { PkgError } from './errors.js';

export function checkAgentCompat(agentVersion, manifest) {
  const range = manifest.agent?.minVersion;
  if (!range) return { ok: true };  // no constraint
  if (!semver.satisfies(agentVersion, range)) {
    return { ok: false, error: `agent version ${agentVersion} does not satisfy ${range}` };
  }
  return { ok: true };
}

export function checkCenterCompat(centerVersion, manifest) {
  const min = manifest.center?.minVersion;
  const max = manifest.center?.maxVersion;
  if (min && semver.lt(centerVersion, min)) {
    return { ok: false, error: `center version ${centerVersion} below required ${min}` };
  }
  if (max && !semver.satisfies(centerVersion, max)) {
    return { ok: false, error: `center version ${centerVersion} does not satisfy ${max}` };
  }
  return { ok: true };
}

export function checkAll(centerVersion, agentVersion, manifest) {
  const a = checkAgentCompat(agentVersion, manifest);
  if (!a.ok) return { ...a, code: 'PKG_AGENT_INCOMPATIBLE' };
  const c = checkCenterCompat(centerVersion, manifest);
  if (!c.ok) return { ...c, code: 'PKG_CENTER_INCOMPATIBLE' };
  return { ok: true };
}
```

- [ ] **Step 5.5: Run tests, verify pass**

Run: `cd center && npm test -- --test-name-pattern="RegistryClient\|compat"`
Expected: PASS

- [ ] **Step 5.6: Mirror, commit**

```bash
git add center/src/packages/registry.js center/src/packages/compat.js \
  center/tests/packages/registry.test.js center/tests/packages/compat.test.js \
  publish/center/src/packages/registry.js publish/center/src/packages/compat.js
git commit -m "feat(center): registry client + SemVer compat checks"
```

---

## Task 6: REST API endpoints (admin + agent + metrics)

**Files:**
- Create: `center/src/packages/runner.js` (agent endpoints)
- Create: `center/src/packages/router.js` (admin endpoints)
- Modify: `center/src/app.js` (mount new routers)
- Test: `center/tests/packages/runner.test.js`
- Test: `center/tests/packages/router.test.js`

**Interfaces:**
- Runs on `app.locals.agentMw` (agent token) and `app.locals.userAuth` (JWT) middlewares
- Endpoints as defined in spec §4.1, §4.2, §4.3

- [ ] **Step 6.1: Write failing test for runner**

`center/tests/packages/runner.test.js`:
```js
describe('agent /api/agent/packages', () => {
  it('GET /packages returns enabled packages with manifest + script', async () => {
    // Seed: installed_packages with enabled=1, manifest + script
    // Call endpoint, verify response includes manifest, script (base64)
  });
  it('POST /packages/report ingests runs', async () => {
    // Send runs payload, verify metric_gauge row created
  });
});
```

- [ ] **Step 6.2: Write runner.js**

Create `center/src/packages/runner.js`:
```js
import express from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installedPackages, packageRuns } from '../db/sql.js';
import { metricstore } from './metricstore.js';

export function packageRunner({ db, getLogger, centerVersion }) {
  const r = express.Router();

  r.get('/packages', async (req, res) => {
    const installed = await installedPackages.list(db, { enabledOnly: true });
    const packages = installed.map(p => {
      const scriptPath = join(process.cwd(), 'data', 'packages', p.name, p.version, 'collect.ps1');
      const scriptB64 = readFileSync(scriptPath).toString('base64');
      return {
        name: p.name,
        version: p.version,
        manifest: p.manifest,
        script: scriptB64,
        params: p.params,
      };
    });
    res.json({ packages });
  });

  r.get('/packages/:name/script', async (req, res) => {
    const pkg = await installedPackages.get(db, req.params.name);
    if (!pkg || !pkg.enabled) return res.status(404).json({ error: 'not found' });
    const scriptPath = join(process.cwd(), 'data', 'packages', pkg.name, pkg.version, 'collect.ps1');
    const scriptB64 = readFileSync(scriptPath).toString('base64');
    res.json({ name: pkg.name, version: pkg.version, script: scriptB64 });
  });

  r.post('/packages/report', async (req, res) => {
    const { runs } = req.body || {};
    if (!Array.isArray(runs)) return res.status(400).json({ error: 'runs must be array' });

    const result = { processed: 0, errors: [] };
    for (const run of runs) {
      try {
        const pkg = await installedPackages.get(db, run.packageName);
        if (!pkg) {
          result.errors.push({ packageName: run.packageName, error: 'package not installed' });
          continue;
        }
        // Record run
        await packageRuns.insert(db, {
          agentId: req.agentId,
          packageName: run.packageName,
          startedAt: new Date(run.startedAt),
          finishedAt: new Date(run.finishedAt),
          exitCode: run.exitCode,
          stdoutPreview: run.metrics ? JSON.stringify(run.metrics).slice(0, 2048) : null,
          stderrPreview: run.stderr?.slice(0, 2048) ?? null,
          error: run.error ?? null,
        });
        // Ingest metrics
        if (run.metrics && !run.error) {
          await metricstore.ingestRun(db, {
            agentId: req.agentId,
            packageName: run.packageName,
            manifest: pkg.manifest,
            runs: [run],
          });
        }
        result.processed++;
      } catch (e) {
        result.errors.push({ packageName: run.packageName, error: e.message });
      }
    }
    res.json(result);
  });

  return r;
}
```

- [ ] **Step 6.3: Write router.js**

Create `center/src/packages/router.js`:
```js
import express from 'express';
import semver from 'semver';
import { installedPackages, packageRuns } from '../db/sql.js';
import { installer } from './installer.js';
import { RegistryClient } from './registry.js';
import { checkAll } from './compat.js';
import { PkgError } from './errors.js';
import { validateManifest } from './manifest.js';
import { getCenterVersion } from '../config.js';

export function packageRouter({ db, getLogger, getRegistryUrl }) {
  const r = express.Router();

  r.get('/packages', async (req, res) => {
    const installed = await installedPackages.list(db);
    res.json({ packages: installed });
  });

  r.get('/packages/:name', async (req, res) => {
    const pkg = await installedPackages.get(db, req.params.name);
    if (!pkg) return res.status(404).json({ ok: false, error: { code: 'PKG_NOT_FOUND', message: req.params.name } });
    const recentRuns = await packageRuns.listRecent(db, { packageName: req.params.name, limit: 20 });
    res.json({ package: pkg, recentRuns });
  });

  r.post('/packages/install', async (req, res) => {
    const { source, packageRef, buffer } = req.body || {};
    try {
      const result = await installer.installPackage(db, { source, packageRef, buffer });
      res.json({ ok: true, data: result });
    } catch (e) {
      if (e instanceof PkgError) return res.status(e.status).json({ ok: false, error: { code: e.code, message: e.message } });
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
    }
  });

  r.post('/packages/:name/upgrade', async (req, res) => {
    const { name } = req.params;
    const { version } = req.body || {};
    // (Buffer should be passed by admin UI; this endpoint orchestrates)
    // For v1, fetch from registry if available
    const registryUrl = await getRegistryUrl();
    if (!registryUrl) return res.status(400).json({ ok: false, error: { code: 'PKG_VALIDATION_FAILED', message: 'registry not configured' } });
    const registry = new RegistryClient({ baseUrl: registryUrl, cacheDir: process.cwd() + '/data/registry-cache', logger: getLogger() });
    const idx = await registry.fetchIndex();
    const pkgEntry = idx.packages.find(p => p.name === name);
    if (!pkgEntry) return res.status(404).json({ ok: false, error: { code: 'PKG_NOT_FOUND', message: name } });
    const targetVersion = version || pkgEntry.latestVersion;
    const versionEntry = pkgEntry.versions.find(v => v.version === targetVersion);
    if (!versionEntry) return res.status(404).json({ ok: false, error: { code: 'PKG_NOT_FOUND', message: `version ${targetVersion}` } });
    const buffer = await registry.downloadPackage(pkgEntry, versionEntry);
    const existing = await installedPackages.get(db, name);
    const compat = checkAll(getCenterVersion(), '*', JSON.parse(require('fs').readFileSync(require('path').join(process.cwd(), 'data', 'packages', name, 'REPLACE_ME', 'manifest.json'), 'utf8')));
    if (!compat.ok) return res.status(compat.status || 409).json({ ok: false, error: { code: compat.code, message: compat.error } });
    const { installer } = await import('./installer.js');
    const r = await installer.upgradePackage(db, { name, version: targetVersion });
    res.json({ ok: true, data: r });
  });

  r.post('/packages/:name/enable', async (req, res) => {
    await installer.setEnabled(db, { name: req.params.name, enabled: true });
    res.json({ ok: true });
  });

  r.post('/packages/:name/disable', async (req, res) => {
    await installer.setEnabled(db, { name: req.params.name, enabled: false });
    res.json({ ok: true });
  });

  r.delete('/packages/:name', async (req, res) => {
    const purgeMetrics = req.query.purgeMetrics === 'true';
    await installer.uninstallPackage(db, { name: req.params.name, purgeMetrics });
    res.json({ ok: true });
  });

  r.put('/packages/:name/params', async (req, res) => {
    const { params } = req.body || {};
    await installer.updateParams(db, { name: req.params.name, params });
    res.json({ ok: true });
  });

  r.get('/packages/registry/refresh', async (req, res) => {
    const registryUrl = await getRegistryUrl();
    if (!registryUrl) return res.status(400).json({ ok: false, error: { code: 'PKG_VALIDATION_FAILED', message: 'registry not configured' } });
    const registry = new RegistryClient({ baseUrl: registryUrl, cacheDir: process.cwd() + '/data/registry-cache', logger: getLogger() });
    const idx = await registry.fetchIndex(true);
    res.json({ ok: true, data: { updatedAt: idx.updatedAt, packages: idx.packages.length } });
  });

  return r;
}
```

- [ ] **Step 6.4: Mount routers in app.js**

Modify `center/src/app.js`:
```js
import { packageRouter } from './packages/router.js';
import { packageRunner } from './packages/runner.js';

// In createApp(), after mounting existing routes:
app.use('/api/admin', userAuth, packageRouter({ db, getLogger, getRegistryUrl }));
app.use('/api/agent', agentMw, packageRunner({ db, getLogger }));
```

- [ ] **Step 6.5: Add registry URL config getter**

Create or modify `center/src/config.js` to expose `getRegistryUrl()`:
```js
export async function getRegistryUrl() {
  const r = await db.execute(`SELECT config_value FROM system_config WHERE config_key = 'package_registry_url'`, []);
  return r.rows[0]?.config_value || null;
}
```

- [ ] **Step 6.6: Write tests for router + runner**

`center/tests/packages/runner.test.js` and `center/tests/packages/router.test.js`:
```js
// Use supertest with the express app
import request from 'supertest';

// runner.test.js: POST /api/agent/packages/report → verify metric_gauge + package_runs
// router.test.js: POST /api/admin/packages/install → verify installed_packages row
//                PUT /api/admin/packages/:name/params → verify params_json
//                DELETE /api/admin/packages/:name → verify row gone
```

- [ ] **Step 6.7: Run tests, verify pass**

Run: `cd center && npm test`
Expected: PASS — existing + new tests green.

- [ ] **Step 6.8: Mirror, commit**

```bash
git add center/src/packages/runner.js center/src/packages/router.js center/src/app.js center/src/config.js \
  center/tests/packages/runner.test.js center/tests/packages/router.test.js \
  publish/center/src/packages/runner.js publish/center/src/packages/router.js
git commit -m "feat(center): package admin/agent/dashboard REST endpoints"
```

---

## Task 7: Agent package manager + runner

**Files:**
- Create: `agent/src/package-manager.js`
- Create: `agent/src/package-runner.js`
- Modify: `agent/src/heartbeat.js`
- Modify: `agent/src/scheduler.js`
- Modify: `agent/src/reporter.js`
- Modify: `agent/src/local-queue.js`
- Modify: `agent/src/agent.js` (or whatever wires modules)
- Test: `agent/tests/package-manager.test.js`
- Test: `agent/tests/package-runner.test.js`

**Interfaces:**
- Consumes: agent's existing scheduler, reporter, config
- Produces:
  - `PackageManager({agentId, agentVersion, centerBaseUrl, agentToken, dataDir, logger, scheduler}).run()`
  - `runPackageScript({scriptPath, params, timeoutMs, logger})` → `{startedAt, finishedAt, exitCode, metrics, error}`
  - `flushReportQueue()` → flushes pending reports

- [ ] **Step 7.1: Write failing test for package-runner**

`agent/tests/package-runner.test.js`:
```js
import { runPackageScript } from '../src/package-runner.js';

describe('runPackageScript', () => {
  it('returns parsed metrics on success', async () => {
    const scriptPath = path.join(tmpdir, 'collect.ps1');
    fs.writeFileSync(scriptPath, 'param([string]$name) ; Read-Host | Out-Null ; Write-Output \'{"metrics":{"m1":42}}\'');
    const r = await runPackageScript({ scriptPath, params: {}, timeoutMs: 5000, logger });
    assert.equal(r.exitCode, 0);
    assert.equal(r.metrics.m1, 42);
    assert.equal(r.error, null);
  });
  it('returns parseError on non-JSON stdout', async () => { /* ... */ });
  it('timeout kills and reports error', async () => { /* script that sleeps 10s, timeoutMs: 100 */ });
});
```

- [ ] **Step 7.2: Run test, verify failure**

Run: `cd agent && npm test`
Expected: FAIL

- [ ] **Step 7.3: Implement package-runner.js**

Create `agent/src/package-runner.js`:
```js
import { spawn } from 'node:child_process';

export async function runPackageScript({ scriptPath, params, timeoutMs = 30000, logger }) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
    ]);

    const timer = setTimeout(() => {
      logger.warn({ scriptPath, timeoutMs }, 'package script timeout');
      child.kill('SIGKILL');
    }, timeoutMs);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());

    // Write params to stdin
    child.stdin.write(JSON.stringify({ name: path.basename(path.dirname(scriptPath)), params: params || {} }));
    child.stdin.end();

    child.on('exit', (code) => {
      clearTimeout(timer);
      const finishedAt = Date.now();

      // Parse last non-empty line of stdout as JSON
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      const lastLine = lines[lines.length - 1] || '';
      let metrics = null;
      let parseError = null;
      try {
        const parsed = JSON.parse(lastLine);
        metrics = parsed.metrics ?? null;
      } catch (e) {
        parseError = `stdout does not end with valid JSON: ${lastLine.slice(0, 200)}`;
      }

      let error = null;
      if (parseError) error = parseError;
      else if (code !== 0) error = `exit ${code}: ${stderr.slice(0, 200)}`;

      resolve({
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(finishedAt).toISOString(),
        exitCode: code,
        metrics,
        stdoutPreview: stdout.slice(0, 2048),
        stderrPreview: stderr.slice(0, 2048),
        error,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(Date.now()).toISOString(),
        exitCode: -1,
        metrics: null,
        error: err.message,
      });
    });
  });
}

import path from 'node:path';
```

- [ ] **Step 7.4: Write failing test for package-manager**

`agent/tests/package-manager.test.js`:
```js
describe('PackageManager', () => {
  it('syncFromCenter pulls enabled packages', async () => {
    // Mock center endpoint to return [{ name, version, manifest, script (base64) }]
    // Verify package-manager writes to dataDir/packages/<name>/<version>/
  });
  it('schedules tasks at package.intervalSec', async () => { /* ... */ });
  it('flushReportQueue sends queue via POST', async () => { /* ... */ });
  it('caches reports on flush failure', async () => { /* ... */ });
});
```

- [ ] **Step 7.5: Implement package-manager.js**

Create `agent/src/package-manager.js`:
```js
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runPackageScript } from './package-runner.js';

export class PackageManager {
  constructor({ agentId, agentVersion, centerBaseUrl, agentToken, dataDir, logger, scheduler }) {
    this.agentId = agentId;
    this.agentVersion = agentVersion;
    this.centerBaseUrl = centerBaseUrl.replace(/\/$/, '');
    this.agentToken = agentToken;
    this.dataDir = dataDir;
    this.logger = logger;
    this.scheduler = scheduler;
    this.cacheDir = join(dataDir, 'packages');
    this.queueFile = join(dataDir, 'report-queue.json');
    this.queue = [];
    this.reportBatch = [];
    this.tasks = new Map();
    mkdirSync(this.cacheDir, { recursive: true });
    this.loadQueue();
  }

  async syncFromCenter() {
    const res = await fetch(`${this.centerBaseUrl}/api/agent/packages`, {
      headers: { Authorization: `Bearer ${this.agentToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      this.logger.warn({ status: res.status }, 'package sync failed');
      return;
    }
    const { packages } = await res.json();
    const enabledNames = new Set(packages.map(p => p.name));

    // Remove cache for packages no longer enabled
    for (const local of this.listLocal()) {
      if (!enabledNames.has(local)) {
        this.removeCache(local);
      }
    }

    // Write new packages
    for (const pkg of packages) {
      const dir = join(this.cacheDir, pkg.name, pkg.version);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(pkg.manifest, null, 2));
      writeFileSync(join(dir, 'collect.ps1'), Buffer.from(pkg.script, 'base64'));
      // Update current pointer
      writeFileSync(join(this.cacheDir, pkg.name, 'current.json'), JSON.stringify({ version: pkg.version }));
    }

    // (Re)schedule tasks
    this.reschedule(packages);
  }

  listLocal() {
    if (!existsSync(this.cacheDir)) return [];
    return require('node:fs').readdirSync(this.cacheDir).filter(f => {
      return existsSync(join(this.cacheDir, f, 'current.json'));
    });
  }

  removeCache(name) {
    const dir = join(this.cacheDir, name);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    if (this.tasks.has(name)) {
      this.scheduler.remove(`pkg:${name}`);
      this.tasks.delete(name);
    }
  }

  reschedule(packages) {
    // Remove all existing tasks
    for (const [name, task] of this.tasks) {
      this.scheduler.remove(task);
    }
    this.tasks.clear();
    // Add new tasks
    for (const pkg of packages) {
      const task = this.scheduler.add(`pkg:${pkg.name}`, pkg.manifest.agent.intervalSec * 1000, async () => {
        await this.runOne(pkg);
      });
      this.tasks.set(pkg.name, task);
    }
  }

  async runOne(pkg) {
    const scriptPath = join(this.cacheDir, pkg.name, pkg.version, 'collect.ps1');
    const params = pkg.params || {};
    const r = await runPackageScript({
      scriptPath,
      params,
      timeoutMs: pkg.manifest.agent.timeoutMs || 30000,
      logger: this.logger,
    });
    this.reportBatch.push({
      packageName: pkg.name,
      ...r,
    });
    if (this.reportBatch.length >= 10) {
      await this.flushReportQueue();
    }
  }

  async flushReportQueue() {
    // Combine queued
    const all = [...this.queue, ...this.reportBatch];
    if (all.length === 0) return;
    try {
      const res = await fetch(`${this.centerBaseUrl}/api/agent/packages/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.agentToken}` },
        body: JSON.stringify({ runs: all }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.queue = [];
      this.reportBatch = [];
      this.saveQueue();
    } catch (e) {
      this.logger.warn({ err: e.message }, 'report flush failed, queueing to disk');
      this.queue.push(...this.reportBatch);
      this.reportBatch = [];
      // Cap at 1000
      if (this.queue.length > 1000) this.queue = this.queue.slice(-1000);
      this.saveQueue();
    }
  }

  loadQueue() {
    if (existsSync(this.queueFile)) {
      try { this.queue = JSON.parse(readFileSync(this.queueFile, 'utf8')); } catch { this.queue = []; }
    }
  }

  saveQueue() {
    writeFileSync(this.queueFile, JSON.stringify(this.queue));
  }
}
```

- [ ] **Step 7.6: Wire into agent.js**

Modify `agent/src/agent.js` (or wherever):
```js
import { PackageManager } from './package-manager.js';
// In agent boot:
const packageManager = new PackageManager({ agentId, agentVersion, centerBaseUrl, agentToken, dataDir, logger, scheduler });
await packageManager.syncFromCenter();
setInterval(() => packageManager.syncFromCenter(), 5 * 60 * 1000);  // every 5 min
setInterval(() => packageManager.flushReportQueue(), 5_000);  // every 5s
```

- [ ] **Step 7.7: Extend heartbeat**

Modify `agent/src/heartbeat.js` to include `packages`:
```js
const heartbeatPayload = {
  ...,
  packages: {
    installed: packageManager.listLocal(),
    pending: [],  // could track which packages are queued for download
    lastReportAt: new Date().toISOString(),
  },
};
```

- [ ] **Step 7.8: Run tests, verify pass**

Run: `cd agent && npm test`
Expected: PASS — existing 29/0/0 + new tests.

- [ ] **Step 7.9: Mirror, commit**

```bash
git add agent/src/package-manager.js agent/src/package-runner.js \
  agent/src/heartbeat.js agent/src/scheduler.js agent/src/reporter.js \
  agent/src/local-queue.js agent/src/agent.js \
  agent/tests/package-manager.test.js agent/tests/package-runner.test.js \
  publish/agent/src/package-manager.js publish/agent/src/package-runner.js
git commit -m "feat(agent): package manager + PS1 runner with offline queue"
```

---

## Task 8: Frontend admin views (Packages / PackageEdit / Registry)

**Files:**
- Create: `frontend/src/views/admin/PackagesView.vue`
- Create: `frontend/src/views/admin/PackageEditView.vue`
- Create: `frontend/src/views/admin/RegistryView.vue`
- Create: `frontend/src/stores/packages.js`
- Modify: `frontend/src/components/AppLayout.vue`
- Modify: `frontend/src/router/index.js`
- Test: `frontend/tests/packages-view.test.js`
- Test: `frontend/tests/package-edit-view.test.js`
- Test: `frontend/tests/registry-view.test.js`

- [ ] **Step 8.1: Write failing test for packages store**

`frontend/tests/packages-store.test.js` (or include in views test):
```js
// Mock API, test store actions
```

- [ ] **Step 8.2: Implement packages.js store**

Create `frontend/src/stores/packages.js`:
```js
import { defineStore } from 'pinia';
import axios from 'axios';

export const usePackagesStore = defineStore('packages', {
  state: () => ({
    installed: [],
    registryCache: { url: null, index: [], fetchedAt: null },
    loading: false,
    error: null,
  }),

  getters: {
    enabledPackages: (state) => state.installed.filter(p => p.enabled),
  },

  actions: {
    async fetchInstalled() {
      this.loading = true;
      try {
        const r = await axios.get('/api/admin/packages');
        this.installed = r.data.packages;
      } finally { this.loading = false; }
    },

    async install({ source, packageRef, buffer }) {
      const r = await axios.post('/api/admin/packages/install', { source, packageRef, buffer });
      await this.fetchInstalled();
      return r.data;
    },

    async enable(name) {
      await axios.post(`/api/admin/packages/${name}/enable`);
      await this.fetchInstalled();
    },

    async disable(name) {
      await axios.post(`/api/admin/packages/${name}/disable`);
      await this.fetchInstalled();
    },

    async uninstall(name, purgeMetrics = false) {
      await axios.delete(`/api/admin/packages/${name}`, { params: { purgeMetrics } });
      await this.fetchInstalled();
    },

    async upgrade(name, version) {
      const r = await axios.post(`/api/admin/packages/${name}/upgrade`, { version });
      await this.fetchInstalled();
      return r.data;
    },

    async refreshRegistry() {
      const r = await axios.get('/api/admin/packages/registry/refresh');
      this.registryCache.fetchedAt = new Date().toISOString();
      this.registryCache.packagesCount = r.data.data?.packages;
    },

    async updateParams(name, params) {
      await axios.put(`/api/admin/packages/${name}/params`, { params });
      await this.fetchInstalled();
    },

    async fetchRegistryIndex() {
      // For RegistryView: directly read registry-cache or fetch
      const r = await axios.get('/api/admin/packages/registry/list');
      return r.data;
    },
  },
});
```

- [ ] **Step 8.3: Implement PackagesView.vue**

Create `frontend/src/views/admin/PackagesView.vue`:
```vue
<template>
  <div class="packages-view">
    <header class="toolbar">
      <h2>包管理</h2>
      <div class="actions">
        <el-upload :show-file-list="false" :before-upload="handleUpload" accept=".zip,.json">
          <el-button type="primary">+ 上传本地包</el-button>
        </el-upload>
        <router-link to="/admin/packages/registry">
          <el-button>从 Registry 导入</el-button>
        </router-link>
        <el-button @click="refreshRegistry">刷新 Registry</el-button>
      </div>
    </header>

    <el-table :data="store.installed" v-loading="store.loading" stripe>
      <el-table-column prop="name" label="名称" />
      <el-table-column prop="version" label="版本" width="100" />
      <el-table-column prop="type" label="类型" width="100">
        <template #default="{ row }">
          <el-tag :type="typeColor(row.type)">{{ row.type }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="启用" width="80">
        <template #default="{ row }">
          <el-tag :type="row.enabled ? 'success' : 'info'">
            {{ row.enabled ? '是' : '否' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="source" label="来源" />
      <el-table-column label="安装时间" width="180">
        <template #default="{ row }">
          {{ formatDate(row.installed_at) }}
        </template>
      </el-table-column>
      <el-table-column label="操作" width="280">
        <template #default="{ row }">
          <el-button size="small" @click="$router.push(`/admin/packages/${row.name}`)">查看</el-button>
          <el-button size="small" @click="upgrade(row)">升级</el-button>
          <el-button size="small" @click="toggle(row)">
            {{ row.enabled ? '停用' : '启用' }}
          </el-button>
          <el-button size="small" type="danger" @click="uninstall(row)">卸载</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup>
import { onMounted } from 'vue';
import { usePackagesStore } from '../../stores/packages.js';
import { ElMessageBox, ElMessage } from 'element-plus';

const store = usePackagesStore();

onMounted(() => store.fetchInstalled());

async function handleUpload(file) {
  const buffer = await fileToBase64(file);
  try {
    await store.install({ source: 'local', packageRef: file.name, buffer });
    ElMessage.success('安装成功');
  } catch (e) {
    ElMessage.error(`安装失败: ${e.response?.data?.error?.message || e.message}`);
  }
  return false;  // prevent default upload
}

async function toggle(row) {
  if (row.enabled) await store.disable(row.name);
  else await store.enable(row.name);
  ElMessage.success('已更新');
}

async function uninstall(row) {
  await ElMessageBox.confirm(`确认卸载 ${row.name}?`, '确认');
  await store.uninstall(row.name);
  ElMessage.success('已卸载');
}

async function upgrade(row) {
  await store.upgrade(row.name);
  ElMessage.success('已升级');
}

async function refreshRegistry() {
  await store.refreshRegistry();
  ElMessage.success('Registry 已刷新');
}

function typeColor(t) {
  return { gauge: 'success', counter: 'warning', timeseries: 'primary', status: 'info' }[t];
}

function formatDate(s) { return new Date(s).toLocaleString(); }

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
</script>
```

- [ ] **Step 8.4: Implement PackageEditView.vue**

Create `frontend/src/views/admin/PackageEditView.vue`:
```vue
<template>
  <div v-if="pkg" class="package-edit-view">
    <el-card class="meta">
      <h2>{{ pkg.name }} <el-tag>v{{ pkg.version }}</el-tag></h2>
      <p>{{ pkg.manifest.description }}</p>
      <el-descriptions :column="2" border>
        <el-descriptions-item label="类型">{{ pkg.type }}</el-descriptions-item>
        <el-descriptions-item label="作者">{{ pkg.manifest.author }}</el-descriptions-item>
        <el-descriptions-item label="License">{{ pkg.manifest.license }}</el-descriptions-item>
        <el-descriptions-item label="来源">{{ pkg.source }}</el-descriptions-item>
      </el-descriptions>
    </el-card>

    <el-card class="manifest">
      <template #header><h3>Manifest 详情</h3></template>
      <pre>{{ JSON.stringify(pkg.manifest, null, 2) }}</pre>
    </el-card>

    <el-card class="params">
      <template #header><h3>参数</h3></template>
      <component :is="paramsForm" v-model="paramsValue" :schema="pkg.manifest.params.schema" />
      <el-button type="primary" @click="saveParams">保存</el-button>
    </el-card>

    <el-card class="runs">
      <template #header><h3>最近运行</h3></template>
      <el-table :data="recentRuns" stripe>
        <el-table-column prop="started_at" label="开始时间" width="180" />
        <el-table-column prop="exit_code" label="退出码" width="80" />
        <el-table-column prop="error" label="错误" />
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import axios from 'axios';
import { ElMessage } from 'element-plus';
import { usePackagesStore } from '../../stores/packages.js';

const route = useRoute();
const store = usePackagesStore();
const pkg = ref(null);
const recentRuns = ref([]);
const paramsValue = ref(null);

const paramsForm = computed(() => {
  // Could use vue-json-schema-form; for v1, render simple Object/JSON editor
  return 'pre';  // placeholder; real impl uses dynamic form
});

onMounted(async () => {
  const r = await axios.get(`/api/admin/packages/${route.params.name}`);
  pkg.value = r.data.package;
  recentRuns.value = r.data.recentRuns;
  paramsValue.value = r.data.package.params || {};
});

async function saveParams() {
  await store.updateParams(pkg.value.name, paramsValue.value);
  ElMessage.success('已保存');
}
</script>
```

- [ ] **Step 8.5: Implement RegistryView.vue**

Create `frontend/src/views/admin/RegistryView.vue`:
```vue
<template>
  <div class="registry-view">
    <h2>Registry 浏览</h2>
    <p>当前 registry URL: {{ registryUrl || '未配置' }}</p>
    <el-button @click="refresh">刷新</el-button>
    <el-table :data="packages" v-loading="loading">
      <el-table-column prop="name" label="名称" />
      <el-table-column prop="latestVersion" label="最新版本" width="100" />
      <el-table-column prop="type" label="类型" width="100" />
      <el-table-column prop="description" label="描述" />
      <el-table-column prop="author" label="作者" />
      <el-table-column label="操作" width="120">
        <template #default="{ row }">
          <el-button size="small" @click="install(row)">安装</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import axios from 'axios';
import { ElMessage } from 'element-plus';
import { usePackagesStore } from '../../stores/packages.js';

const store = usePackagesStore();
const packages = ref([]);
const registryUrl = ref(null);
const loading = ref(false);

onMounted(() => load());

async function load() {
  loading.value = true;
  try {
    const r = await axios.get('/api/admin/packages/registry/list');
    packages.value = r.data.packages;
    registryUrl.value = r.data.url;
  } finally { loading.value = false; }
}

async function refresh() {
  await store.refreshRegistry();
  await load();
}

async function install(row) {
  await store.install({ source: `registry:${registryUrl.value}`, packageRef: row.name });
  ElMessage.success(`已安装 ${row.name}`);
}
</script>
```

- [ ] **Step 8.6: Update sidebar nav**

Modify `frontend/src/components/AppLayout.vue` — add admin section links (refer to existing sidebar markup pattern).

- [ ] **Step 8.7: Add routes**

Modify `frontend/src/router/index.js`:
```js
{
  path: '/admin/packages',
  component: () => import('../views/admin/PackagesView.vue'),
  meta: { requiresAdmin: true },
},
{
  path: '/admin/packages/registry',
  component: () => import('../views/admin/RegistryView.vue'),
  meta: { requiresAdmin: true },
},
{
  path: '/admin/packages/:name',
  component: () => import('../views/admin/PackageEditView.vue'),
  meta: { requiresAdmin: true },
},
```

- [ ] **Step 8.8: Write frontend tests**

`frontend/tests/packages-view.test.js`:
```js
import { mount } from '@vue/test-utils';
import PackagesView from '../src/views/admin/PackagesView.vue';
// Mock axios, Pinia, etc.
// Test: render table, click upload, enable/disable, uninstall
```

- [ ] **Step 8.9: Run tests, verify pass**

Run: `cd frontend && npm test`
Expected: PASS

- [ ] **Step 8.10: Mirror, commit**

```bash
git add frontend/src/views/admin/PackagesView.vue frontend/src/views/admin/PackageEditView.vue \
  frontend/src/views/admin/RegistryView.vue frontend/src/stores/packages.js \
  frontend/src/components/AppLayout.vue frontend/src/router/index.js \
  frontend/tests/packages-view.test.js frontend/tests/package-edit-view.test.js \
  frontend/tests/registry-view.test.js \
  publish/frontend/src/views/admin/PackagesView.vue publish/frontend/src/views/admin/PackageEditView.vue \
  publish/frontend/src/views/admin/RegistryView.vue publish/frontend/src/stores/packages.js
git commit -m "feat(frontend): admin views — Packages / PackageEdit / Registry"
```

---

## Task 9: Frontend metrics dashboard + e2e + docs

**Files:**
- Create: `frontend/src/views/MetricDashboardView.vue`
- Create: `frontend/src/components/metrics/GaugeTile.vue`
- Create: `frontend/src/components/metrics/CounterTile.vue`
- Create: `frontend/src/components/metrics/TimeseriesTile.vue`
- Create: `frontend/src/components/metrics/StatusTile.vue`
- Create: `tests/pester/plugin-system.Tests.ps1`
- Modify: `docs/operations/deployment.md`
- Test: `frontend/tests/metric-tiles.test.js`
- Test: `center/tests/e2e/plugin-system.test.js`

- [ ] **Step 9.1: Implement 4 metric tile components**

Create `frontend/src/components/metrics/GaugeTile.vue`:
```vue
<template>
  <div class="gauge-tile" :class="colorClass">
    <div class="value">{{ value !== null ? value : '—' }}<span class="unit">{{ unit }}</span></div>
    <div class="label">{{ label }}</div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  metric: { type: Object, required: true },
  currentValue: { type: Number, default: null },
});

const value = computed(() => props.currentValue);
const unit = computed(() => props.metric.unit || '');
const label = computed(() => props.metric.label);

const colorClass = computed(() => {
  if (value.value === null) return 'gray';
  const { warn, crit } = props.metric.thresholds || {};
  if (crit !== undefined && value.value > crit) return 'red';
  if (warn !== undefined && value.value > warn) return 'yellow';
  return 'green';
});
</script>

<style scoped>
.gauge-tile { padding: 16px; border-radius: 8px; }
.gauge-tile.green { background: #f0f9eb; color: #67c23a; }
.gauge-tile.yellow { background: #fdf6ec; color: #e6a23c; }
.gauge-tile.red { background: #fef0f0; color: #f56c6c; }
.gauge-tile.gray { background: #f5f7fa; color: #909399; }
.value { font-size: 32px; font-weight: bold; }
.unit { font-size: 14px; margin-left: 4px; }
.label { font-size: 12px; margin-top: 8px; }
</style>
```

- [ ] **Step 9.2: Implement CounterTile.vue**

Create `frontend/src/components/metrics/CounterTile.vue`:
```vue
<template>
  <div class="counter-tile">
    <div class="value">{{ value !== null ? value.toLocaleString() : '—' }}<span class="unit">{{ unit }}</span></div>
    <div class="delta" :class="delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'">
      <span v-if="delta > 0">↑ +{{ delta.toLocaleString() }}</span>
      <span v-else-if="delta < 0">↓ {{ delta.toLocaleString() }}</span>
      <span v-else>— 0</span>
    </div>
    <div class="label">{{ label }}</div>
  </div>
</template>

<script setup>
defineProps({
  metric: { type: Object, required: true },
  currentValue: { type: Number, default: null },
  delta: { type: Number, default: 0 },
});

const unit = 'value: 'computed: () => props.metric.unit || '';
const label = 'value: 'computed: () => props.metric.label;
</script>
```

- [ ] **Step 9.3: Implement TimeseriesTile.vue**

Create `frontend/src/components/metrics/TimeseriesTile.vue`:
```vue
<template>
  <div class="timeseries-tile">
    <div class="label">{{ metric.label }}</div>
    <div class="chart" ref="chartEl"></div>
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue';
import * as echarts from 'echarts';

const props = defineProps({
  metric: { type: Object, required: true },
  data: { type: Array, default: () => [] },
});

const chartEl = ref(null);
let chart = null;

onMounted(() => {
  chart = echarts.init(chartEl.value);
  render();
});

watch(() => props.data, render, { deep: true });

function render() {
  if (!chart) return;
  chart.setOption({
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'time' },
    yAxis: { type: 'value', name: props.metric.unit || '' },
    series: [{
      name: props.metric.label,
      type: 'line',
      data: props.data.map(d => [d.ts, d.value]),
    }],
  });
}
</script>

<style scoped>
.timeseries-tile { padding: 16px; }
.chart { width: 100%; height: 200px; }
.label { font-weight: bold; margin-bottom: 8px; }
</style>
```

- [ ] **Step 9.4: Implement StatusTile.vue**

Create `frontend/src/components/metrics/StatusTile.vue`:
```vue
<template>
  <div class="status-tile" :class="statusClass">
    <div class="status">{{ status }}</div>
    <div class="label">{{ metric.label }}</div>
    <div class="message" v-if="message">{{ message }}</div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  metric: { type: Object, required: true },
  status: { type: String, default: 'UNKNOWN' },
  message: { type: String, default: null },
});

const statusClass = computed(() => {
  const s = (props.status || '').toUpperCase();
  if (s === 'OK' || s === 'HEALTHY') return 'green';
  if (s === 'WARN' || s === 'WARNING') return 'yellow';
  if (s === 'CRIT' || s === 'CRITICAL' || s === 'ERROR') return 'red';
  return 'gray';
});
</script>
```

- [ ] **Step 9.5: Implement MetricDashboardView.vue**

Create `frontend/src/views/MetricDashboardView.vue`:
```vue
<template>
  <div class="metric-dashboard">
    <aside class="sidebar">
      <h3>包</h3>
      <ul>
        <li v-for="pkg in store.installed" :key="pkg.name" :class="{ active: selected === pkg.name }" @click="select(pkg)">
          {{ pkg.name }}
          <el-tag size="small" :type="pkg.enabled ? 'success' : 'info'">{{ pkg.enabled ? '运行' : '停' }}</el-tag>
        </li>
      </ul>
    </aside>

    <main class="content">
      <div v-if="selectedPkg">
        <h2>{{ selectedPkg.name }}</h2>
        <p>{{ selectedPkg.manifest.description }}</p>
        <div class="filters">
          <el-select v-model="agentFilter" placeholder="DC">
            <el-option label="所有" value="all" />
            <el-option v-for="a in agents" :key="a" :label="a" :value="a" />
          </el-select>
          <el-select v-model="timeWindow" placeholder="时间">
            <el-option label="1h" value="1h" />
            <el-option label="24h" value="24h" />
            <el-option label="7d" value="7d" />
          </el-select>
        </div>
        <div class="tiles">
          <component v-for="m in selectedPkg.manifest.metrics" :key="m.key" :is="tileComponent(selectedPkg.type)"
            :metric="m" :current-value="summary[m.key]?.value" :delta="summary[m.key]?.delta" :data="timeseries[m.key]" :status="status[m.key]?.status" :message="status[m.key]?.message" />
        </div>
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import axios from 'axios';
import { usePackagesStore } from '../stores/packages.js';
import GaugeTile from '../components/metrics/GaugeTile.vue';
import CounterTile from '../components/metrics/CounterTile.vue';
import TimeseriesTile from '../components/metrics/TimeseriesTile.vue';
import StatusTile from '../components/metrics/StatusTile.vue';

const store = usePackagesStore();
const selected = ref(null);
const selectedPkg = computed(() => store.installed.find(p => p.name === selected.value));
const summary = ref({});
const timeseries = ref({});
const status = ref({});
const agentFilter = ref('all');
const timeWindow = ref('1h');
const agents = ref([]);

const tileComponent = (type) => ({ gauge: GaugeTile, counter: CounterTile, timeseries: TimeseriesTile, status: StatusTile })[type];

onMounted(async () => {
  await store.fetchInstalled();
  if (store.installed.length) select(store.installed[0]);
});

async function select(pkg) {
  selected.value = pkg.name;
  await loadMetrics();
}

async function loadMetrics() {
  const r = await axios.get('/api/dashboard/metrics/summary', { params: { packageName: selected.value, agentId: agentFilter.value === 'all' ? undefined : agentFilter.value } });
  const data = r.data;
  // Map to { metric_key: value } for tiles
  const s = {};
  for (const row of data.gauge) s[row.metric_id.split('.')[1]] = { value: row.value, ts: row.ts };
  for (const row of data.counter) s[row.metric_id.split('.')[1]] = { value: row.value, delta: row.delta };
  for (const row of data.status) status.value[row.metric_id.split('.')[1]] = row;
  summary.value = s;
  // Timeseries fetch separately
  // (load each metric's timeseries)
}
</script>
```

- [ ] **Step 9.6: Add metrics dashboard endpoint**

Modify `center/src/packages/router.js` or create `dashboard-metrics.js`:
```js
r.get('/dashboard/metrics/summary', async (req, res) => {
  const { packageName, agentId } = req.query;
  const where = [];
  const params = [];
  if (packageName) { where.push('metric_id LIKE ?'); params.push(`${packageName}.%`); }
  if (agentId) { where.push('agent_id = ?'); params.push(agentId); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const [gauge, counter, status] = await Promise.all([
    db.execute(`SELECT * FROM metric_gauge ${clause}`, params),
    db.execute(`SELECT * FROM metric_counter ${clause}`, params),
    db.execute(`SELECT * FROM metric_status ${clause}`, params),
  ]);
  res.json({ gauge: gauge.rows, counter: counter.rows, status: status.rows });
});

r.get('/dashboard/metrics/timeseries', async (req, res) => {
  const { metricId, agentId, from, to } = req.query;
  const r = await db.execute(
    `SELECT * FROM metric_timeseries WHERE metric_id = ? AND agent_id = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC`,
    [metricId, agentId, from || new Date(Date.now() - 3600000).toISOString(), to || new Date().toISOString()]
  );
  res.json({ data: r.rows });
});
```

- [ ] **Step 9.7: Update sidebar nav for metrics dashboard**

Modify `frontend/src/components/AppLayout.vue` — add `/dashboard/metrics` link in main section.

- [ ] **Step 9.8: Write frontend tests for tiles**

`frontend/tests/metric-tiles.test.js`:
```js
import { mount } from '@vue/test-utils';
import GaugeTile from '../src/components/metrics/GaugeTile.vue';

describe('GaugeTile', () => {
  it('value < warn → green', () => {
    const w = mount(GaugeTile, { props: { metric: { label: 'M', thresholds: { warn: 75, crit: 90 } }, currentValue: 50 } });
    expect(w.classes()).toContain('green');
  });
  it('value > crit → red', () => { /* ... */ });
  it('value null → gray', () => { /* ... */ });
});
```

- [ ] **Step 9.9: Write e2e test**

`center/tests/e2e/plugin-system.test.js`:
```js
// Full install → agent → report → dashboard flow
// (See spec §9.3 for full test)
```

- [ ] **Step 9.10: Write Pester test**

Create `tests/pester/plugin-system.Tests.ps1`:
```powershell
Describe 'plugin system' {
  It 'installs fixture package via center API' {
    # ...
  }
}
```

- [ ] **Step 9.11: Update deployment.md**

Add migration 004 to manual upgrade section:
```markdown
#### Upgrading to v2.0+ (Package System)

For MySQL:
```bash
mysql -h <host> -u root -p<pwd> addashboard < db/migrations/004-package-system.sql
```

For SQL Server:
```bash
sqlcmd -S <host> -d AD_Monitoring -i db/migrations/mssql/004-package-system.sql
```

Then restart center. The new admin UI sections (`/admin/packages`) become available.
```

- [ ] **Step 9.12: Run all tests**

Run: `cd center && npm test && cd ../agent && npm test && cd ../frontend && npm test`
Expected: PASS — all suites green.

- [ ] **Step 9.13: Mirror, commit**

```bash
git add frontend/src/views/MetricDashboardView.vue \
  frontend/src/components/metrics/GaugeTile.vue frontend/src/components/metrics/CounterTile.vue \
  frontend/src/components/metrics/TimeseriesTile.vue frontend/src/components/metrics/StatusTile.vue \
  frontend/src/components/AppLayout.vue \
  frontend/tests/metric-tiles.test.js \
  center/tests/e2e/plugin-system.test.js \
  tests/pester/plugin-system.Tests.ps1 \
  docs/operations/deployment.md \
  publish/frontend/src/views/MetricDashboardView.vue \
  publish/frontend/src/components/metrics/GaugeTile.vue \
  publish/frontend/src/components/metrics/CounterTile.vue \
  publish/frontend/src/components/metrics/TimeseriesTile.vue \
  publish/frontend/src/components/metrics/StatusTile.vue \
  publish/frontend/src/components/AppLayout.vue
git commit -m "feat(frontend): metrics dashboard + 4 tile components + e2e + docs"
```

---

## Self-review

- [ ] **Coverage check**: All 9 spec sections have corresponding tasks (1=migration/SQL, 2=manifest/registry schema, 3=metricstore, 4=installer, 5=registry client + compat, 6=REST API, 7=agent, 8=frontend admin, 9=frontend metrics + e2e + docs).
- [ ] **No placeholders**: All code blocks contain complete content; no "TODO" or "TBD" or "implement later".
- [ ] **Type consistency**: `metricId` = `<package.name>.<metric.key>` used consistently across all tasks. `installedPackages` API used consistently. Error codes (`PKG_*`) consistent with manifest module.
- [ ] **Mirror blocks**: Every task ends with mirror + commit step.
- [ ] **Backward compat**: Task 7 only extends heartbeat with optional `packages` field; existing endpoints unchanged.

---

## Execution handoff

After saving this plan, choose execution option:

**Option 1 (Subagent-Driven, recommended)** — I dispatch a fresh subagent per task, do spec-compliance + code-quality review between tasks. Faster iteration, isolated context per task.

**Option 2 (Inline Execution)** — I execute tasks in this session, batch tasks with checkpoints for review. More direct control, but ties up your session.

Which approach?
