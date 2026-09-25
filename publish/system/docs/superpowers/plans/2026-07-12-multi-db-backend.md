# Multi-Database Backend (MySQL + SQL Server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `center` run against either MySQL 5.7+ or SQL Server 2014+ from the same codebase, deploy-time-selected via `appsettings.db.dialect`.

**Architecture:** Replace direct `mysql2` pool usage with a `db` facade (`center/src/db/index.js`) that picks the driver by config. Centralize all SQL strings in `center/src/db/sql.js` (registry with mysql + mssql variants). Service and route code reads `db.sql.X` and calls `db.execute/query/transaction` — dialect-agnostic.

**Tech Stack:** Node.js (existing), `mysql2/promise` (existing), `mssql` (new).

**Spec:** `docs/superpowers/specs/2026-07-12-multi-db-design.md`

## Global Constraints

- MySQL 5.7+ / SQL Server 2014+ minimum (no JSON native, no `DROP IF EXISTS` on SQL Server, no `STRING_AGG`)
- Deploy-time selection only (no hot-swap)
- Same codebase, both dialects first-class
- No cross-platform data migration (fresh-install only)
- env-gated real-DB tests: `TEST_SQL_URL` (mysql) / `TEST_MSSQL_URL` (mssql); default skip
- Existing 70+ mock-based tests must stay green throughout
- Boot flow must work end-to-end with `appsettings.db.dialect = "mysql"` after each task

## File map

**New:**
- `center/src/db/index.js` — facade (`db` object with `execute/query/transaction/healthcheck/close`)
- `center/src/db/sql.js` — frozen per-dialect SQL registry
- `center/src/db/drivers/mysql.js` — `mysql2/promise` wrapper
- `center/src/db/drivers/mssql.js` — `mssql` wrapper with placeholder rewrite + SCOPE_IDENTITY append + boolean normalization
- `center/src/db/errors.js` — `DbError` class with normalized codes
- `center/src/utils/datetime.js` — `toMysqlDatetime(iso)` helper
- `center/tests/helpers/db-mock.js` — dialect-agnostic mock (replaces `mysql-pool.js`)
- `center/tests/db-adapter.test.js` — adapter unit tests
- `center/tests/integration/replication.integration.test.js`
- `center/tests/integration/discovery.integration.test.js`
- `center/tests/integration/users.integration.test.js`
- `center/tests/integration/audit.integration.test.js`
- `center/tests/integration/dashboard.integration.test.js`
- `db/schema/mssql/01-tables.sql`
- `db/schema/mssql/02-seed-roles.sql`
- `db/migrations/mssql/001-dc-site-discovery.sql`

**Modified:**
- `center/src/config.js` — load `db.dialect` + per-dialect config blocks
- `center/src/db.js` — becomes a thin re-export shim (delegates to `db/index.js`); will be removed in T8
- `center/server.js` — uses new `db.init()` / `db.close()` API
- `center/src/app.js` — `createApp({ config, db, logger })` instead of `{ config, pool, logger }`
- `center/src/services/replication.js` — uses `db.execute(db.sql.replication.upsertStatus, params)`
- `center/src/services/discovery.js`
- `center/src/services/users.js`
- `center/src/services/audit.js`
- `center/src/services/config.js`
- `center/src/routes/admin.js`
- `center/src/routes/dashboard.js`
- `center/src/routes/agent.js`
- `center/src/routes/healthz.js`
- `center/tests/helpers/build-app.js` (or wherever `buildApp` lives) — takes `db` not `pool`
- 8 existing test files — update import path from `mysql-pool.js` to `db-mock.js`; update `pool:` arg to `db:`
- `scripts/install-center.ps1` — branches by dialect
- `docs/operations/runbook.md` — add SQL Server section
- `README.md` — mention dual-DB

---

### Task 1: Add `mssql` dependency

**Files:**
- Modify: `center/package.json`
- Test: n/a (no functional change)

**Step 1: Verify current deps**

```bash
cd center && cat package.json | grep -A3 dependencies
```

Expected: `mysql2`, `bcrypt`, `express`, `jsonwebtoken`, `pino`, `pino-http` in deps.

**Step 2: Add `mssql` to `dependencies`**

Edit `center/package.json`:

```json
"dependencies": {
  "bcrypt": "^5.1.1",
  "express": "^4.19.2",
  "jsonwebtoken": "^9.0.2",
  "mssql": "^11.0.1",
  "mysql2": "^3.11.0",
  "pino": "^9.4.0",
  "pino-http": "^10.3.0"
}
```

Insert `"mssql": "^11.0.1"` between `jsonwebtoken` and `mysql2` (alphabetical-ish; `mssql` < `mysql2`).

**Step 3: Install**

```bash
npm install --workspace=center
```

Expected: `node_modules/mssql/` created; no errors.

**Step 4: Verify import works**

```bash
cd center && node -e "import('mssql').then(m => console.log('mssql version:', m.default.VERSION || 'loaded'))"
```

Expected: prints `mssql version: ...` or `loaded`.

**Step 5: Commit**

```bash
git add center/package.json center/package-lock.json
git commit -m "chore(deps): add mssql driver for SQL Server backend support"
```

---

### Task 2: Add `toMysqlDatetime()` helper

**Files:**
- Create: `center/src/utils/datetime.js`
- Test: `center/tests/datetime.test.js`

**Step 1: Write the failing test**

Create `center/tests/datetime.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMysqlDatetime } from '../src/utils/datetime.js';

test('toMysqlDatetime: ISO with milliseconds and Z -> naive DATETIME', () => {
  assert.equal(toMysqlDatetime('2026-07-12T09:00:04.931Z'), '2026-07-12 09:00:04');
});

test('toMysqlDatetime: ISO without milliseconds -> naive DATETIME', () => {
  assert.equal(toMysqlDatetime('2026-07-12T09:00:04Z'), '2026-07-12 09:00:04');
});

test('toMysqlDatetime: null -> null', () => {
  assert.equal(toMysqlDatetime(null), null);
});

test('toMysqlDatetime: undefined -> null', () => {
  assert.equal(toMysqlDatetime(undefined), null);
});

test('toMysqlDatetime: empty string -> null', () => {
  assert.equal(toMysqlDatetime(''), null);
});

test('toMysqlDatetime: invalid string -> null', () => {
  assert.equal(toMysqlDatetime('not-a-date'), null);
});

test('toMysqlDatetime: Date instance -> naive DATETIME', () => {
  assert.equal(toMysqlDatetime(new Date('2026-01-15T00:00:00Z')), '2026-01-15 00:00:00');
});
```

**Step 2: Run test, expect FAIL**

```bash
cd center && node --test tests/datetime.test.js
```

Expected: FAIL with `Cannot find module '../src/utils/datetime.js'`.

**Step 3: Write the helper**

Create `center/src/utils/datetime.js`:

```js
// Convert ISO 8601 (e.g. "2026-07-12T09:00:04.931Z") or Date to MySQL naive
// DATETIME format ("2026-07-12 09:00:04"). Returns null for null/undefined/
// empty/invalid input. MySQL DATETIME columns (without (3) fractional
// modifier) reject the "Z" and fractional seconds; this is the boundary
// where ISO-in becomes MySQL-friendly-out. SQL Server datetime2 columns
// accept ISO strings natively and do not need this transformation.

export function toMysqlDatetime(input) {
  if (input == null || input === '') return null;
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
```

**Step 4: Run test, expect PASS**

```bash
cd center && node --test tests/datetime.test.js
```

Expected: 7 pass / 0 fail.

**Step 5: Run full center test suite, expect still green**

```bash
cd center && npm test 2>&1 | tail -10
```

Expected: same count as before (70 pass / 1 skip / 0 fail, no regressions).

**Step 6: Commit**

```bash
git add center/src/utils/datetime.js center/tests/datetime.test.js
git commit -m "feat(utils): toMysqlDatetime helper for ISO -> MySQL DATETIME conversion"
```

---

### Task 3: Create SQL registry skeleton (mysql-only)

**Files:**
- Create: `center/src/db/sql.js`

This is the central registry. For this task, populate only the mysql variants — mssql variants come in Task 13.

**Step 1: Create the registry with mysql variants**

Create `center/src/db/sql.js`:

```js
// Central SQL registry. One frozen dictionary per dialect, selected at boot
// by db.dialect. Service code reads db.sql.<domain>.<query> and gets back a
// plain string for the active dialect — never a sub-object.
//
// Placeholders: use `?` only (mysql2 style). The mssql driver wrapper
// rewrites `?` -> `@p1, @p2, ...` at execute() time; service code never
// sees @p1.

const VARIANTS = {
  mysql: {
    health: {
      ping: 'SELECT 1 AS ok',
      lastHeartbeat: 'SELECT last_heartbeat_at AS last FROM ad_agent_heartbeat ORDER BY last_heartbeat_at DESC LIMIT 1'
    },
    replication: {
      upsertStatus: `
        INSERT INTO ad_replication_status (
          collected_at, agent_id, source_dc, dest_dc, source_site, dest_site,
          naming_context, last_success_time, last_attempt_time, status_code, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          collected_at      = VALUES(collected_at),
          agent_id          = VALUES(agent_id),
          source_site       = VALUES(source_site),
          dest_site         = VALUES(dest_site),
          last_success_time = VALUES(last_success_time),
          last_attempt_time = VALUES(last_attempt_time),
          status_code       = VALUES(status_code),
          error_message     = VALUES(error_message)`.trim(),
      upsertHistory: `
        INSERT INTO ad_replication_history (
          collected_at, agent_id, source_dc, dest_dc, naming_context,
          last_success_time, status_code, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`.trim(),
      listRecent: `
        SELECT source_dc, dest_dc, source_site, dest_site, status_code, collected_at
        FROM ad_replication_status
        ORDER BY collected_at DESC
        LIMIT ?`.trim(),
      listBySite: `
        SELECT source_dc, dest_dc, source_site, dest_site, status_code, collected_at
        FROM ad_replication_status
        WHERE source_site = ? OR dest_site = ?
        ORDER BY collected_at DESC
        LIMIT ?`.trim()
    },
    discovery: {
      upsertDc: `
        INSERT INTO ad_dcs (
          dc_name, site_hint, os_version, when_created,
          is_pdc, is_gc, is_rid_master, is_schema_master, is_domain_naming_master, is_infrastructure_master,
          discovered_at, discovered_by_agent_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          site_hint                = VALUES(site_hint),
          os_version               = VALUES(os_version),
          when_created             = VALUES(when_created),
          is_pdc                   = VALUES(is_pdc),
          is_gc                    = VALUES(is_gc),
          is_rid_master            = VALUES(is_rid_master),
          is_schema_master         = VALUES(is_schema_master),
          is_domain_naming_master  = VALUES(is_domain_naming_master),
          is_infrastructure_master = VALUES(is_infrastructure_master),
          discovered_at            = NOW(),
          discovered_by_agent_id   = VALUES(discovered_by_agent_id)`.trim()
    },
    users: {
      findByUsername: 'SELECT id, username, password_hash, role_id, status FROM sys_users WHERE username = ? LIMIT 1',
      list: 'SELECT id, username, role_id, status, last_login_at, created_at FROM sys_users ORDER BY id',
      create: 'INSERT INTO sys_users (username, password_hash, role_id, status) VALUES (?, ?, ?, ?)',
      update: 'UPDATE sys_users SET password_hash = COALESCE(?, password_hash), role_id = COALESCE(?, role_id), status = COALESCE(?, status) WHERE id = ?',
      delete: 'DELETE FROM sys_users WHERE id = ?',
      recordLogin: 'UPDATE sys_users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?',
      countAdmins: `
        SELECT COUNT(*) AS n
        FROM sys_users u
        JOIN sys_roles r ON u.role_id = r.id
        WHERE r.role_name = 'admin'`.trim()
    },
    roles: {
      list: 'SELECT id, role_name, permissions FROM sys_roles ORDER BY id'
    },
    config: {
      getAll: 'SELECT config_key, config_value FROM system_config',
      upsert: `
        INSERT INTO system_config (config_key, config_value) VALUES (?, ?)
        ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_at = CURRENT_TIMESTAMP`.trim(),
      setAgentToken: `
        INSERT INTO system_config (config_key, config_value) VALUES ('agent_token', ?)
        ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_at = CURRENT_TIMESTAMP`.trim()
    },
    audit: {
      write: 'INSERT INTO audit_logs (user_id, action, target, payload) VALUES (?, ?, ?, ?)',
      list: 'SELECT id, user_id, action, target, payload, created_at FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT ?'
    },
    sites: {
      listAll: 'SELECT site, region_code, is_hub FROM ad_sites',
      listCatalog: `
        SELECT s.site_id AS id, s.site_name AS siteName, s.region_code AS regionCode,
               s.is_hub AS isHub, s.description, s.created_at AS createdAt, s.updated_at AS updatedAt,
               (SELECT COUNT(*) FROM ad_dcs d WHERE d.site_id = s.site_id) AS dcCount
        FROM ad_sites s
        ORDER BY s.site_name`.trim(),
      listDistinct: `
        SELECT site AS name,
               COUNT(*) AS link_count,
               SUM(CASE WHEN status_code >= 2 THEN 1 ELSE 0 END) AS error_count,
               MAX(collected_at) AS last_seen
        FROM (
          SELECT source_site AS site, status_code, collected_at FROM ad_replication_status WHERE source_site IS NOT NULL
          UNION ALL
          SELECT dest_site, status_code, collected_at FROM ad_replication_status WHERE dest_site IS NOT NULL
        ) t
        GROUP BY site
        ORDER BY site`.trim(),
      findByName: 'SELECT site_id FROM ad_sites WHERE site_name = ?',
      create: 'INSERT INTO ad_sites (site_name, region_code, is_hub, description) VALUES (?, ?, ?, ?)',
      update: 'UPDATE ad_sites SET site_name = ?, region_code = ?, is_hub = ?, description = ? WHERE site_id = ?',
      updatePartial: (fields) => `UPDATE ad_sites SET ${fields.join(', ')} WHERE site_id = ?`,
      delete: 'DELETE FROM ad_sites WHERE site_id = ?',
      unbindDcs: 'UPDATE ad_dcs SET site_id = NULL WHERE site_id = ?'
    },
    dcs: {
      listCatalog: `
        SELECT d.dc_name AS dcName, d.site_id AS siteId, s.site_name AS siteName,
               d.site_hint AS siteHint, d.os_version AS osVersion, d.when_created AS whenCreated,
               d.is_pdc AS isPdc, d.is_gc AS isGc, d.is_rid_master AS isRidMaster,
               d.is_schema_master AS isSchemaMaster, d.is_domain_naming_master AS isDomainNamingMaster,
               d.is_infrastructure_master AS isInfrastructureMaster,
               d.discovered_at AS discoveredAt, d.discovered_by_agent_id AS discoveredByAgentId
        FROM ad_dcs d
        LEFT JOIN ad_sites s ON d.site_id = s.site_id
        ORDER BY d.dc_name`.trim(),
      listDistinct: `
        SELECT dc AS name, site,
               COUNT(*) AS link_count,
               SUM(CASE WHEN status_code >= 2 THEN 1 ELSE 0 END) AS error_count,
               MAX(collected_at) AS last_seen
        FROM (
          SELECT source_dc AS dc, source_site AS site, status_code, collected_at FROM ad_replication_status WHERE source_dc IS NOT NULL
          UNION ALL
          SELECT dest_dc, dest_site, status_code, collected_at FROM ad_replication_status WHERE dest_dc IS NOT NULL
        ) t
        GROUP BY dc, site
        ORDER BY dc, site`.trim(),
      assignSite: 'UPDATE ad_dcs SET site_id = ? WHERE dc_name = ?',
      assignSiteUnbind: 'UPDATE ad_dcs SET site_id = NULL WHERE dc_name = ?'
    },
    dashboard: {
      siteMatrix: `
        SELECT source_dc, dest_dc, source_site, dest_site, status_code, error_message, collected_at
        FROM ad_replication_status
        WHERE (source_site = ? OR dest_site = ?)
        ORDER BY collected_at DESC`.trim(),
      errors: `
        SELECT source_dc, dest_dc, naming_context, error_message, status_code, collected_at
        FROM ad_replication_status
        WHERE status_code >= 2
        ORDER BY collected_at DESC
        LIMIT ?`.trim(),
      agents: `
        SELECT agent_id, last_heartbeat_at, COUNT(*) AS row_count
        FROM ad_replication_status
        WHERE last_heartbeat_at >= ?
        GROUP BY agent_id, last_heartbeat_at`.trim(),
      topology: `
        SELECT source_dc, dest_dc, status_code, MAX(collected_at) AS last_seen
        FROM ad_replication_status
        WHERE collected_at >= ?
        GROUP BY source_dc, dest_dc, status_code`.trim()
    },
    heartbeat: {
      upsert: `
        INSERT INTO ad_agent_heartbeat (agent_id, last_heartbeat_at, agent_version, pending_queue_size)
        VALUES (?, CURRENT_TIMESTAMP, ?, ?)
        ON DUPLICATE KEY UPDATE
          last_heartbeat_at = CURRENT_TIMESTAMP,
          agent_version     = VALUES(agent_version),
          pending_queue_size = VALUES(pending_queue_size)`.trim()
    }
  }
  // mssql variants added in Task 13
};

export function buildSql(dialect) {
  const variants = VARIANTS[dialect];
  if (!variants) throw new Error(`unknown dialect: ${dialect}`);
  // Return a deeply-frozen shallow-copied tree so consumers can't mutate it.
  const out = {};
  for (const [domain, queries] of Object.entries(variants)) {
    out[domain] = Object.freeze({ ...queries });
  }
  return Object.freeze(out);
}

export const SUPPORTED_DIALECTS = Object.keys(VARIANTS);
```

**Step 2: Verify file loads**

```bash
cd center && node -e "import('./src/db/sql.js').then(m => { const s = m.buildSql('mysql'); console.log(Object.keys(s)); console.log('replication.upsertStatus len:', s.replication.upsertStatus.length); })"
```

Expected: prints `[ 'health', 'replication', 'discovery', 'users', 'roles', 'config', 'audit', 'sites', 'dcs', 'dashboard', 'heartbeat' ]` and a non-zero length.

**Step 3: Run full center test suite, expect still green**

```bash
cd center && npm test 2>&1 | tail -10
```

Expected: 70 pass / 1 skip / 0 fail.

**Step 4: Commit**

```bash
git add center/src/db/sql.js
git commit -m "feat(db): SQL registry skeleton with mysql variants"
```

---

### Task 4: Create mysql driver wrapper

**Files:**
- Create: `center/src/db/drivers/mysql.js`
- Test: covered indirectly by T7 adapter tests

**Step 1: Create the driver**

Create `center/src/db/drivers/mysql.js`:

```js
// mysql2/promise driver wrapper. Exposes the unified Db interface:
//   execute(sql, params) -> { rows, affectedRows, insertId }
//   query(sql, params)   -> { rows }
//   transaction(work)    -> result of work(tx)
//   healthcheck()        -> void (throws on failure)
//   close()
//
// On mysql path, ISO Date strings are auto-converted to naive DATETIME
// via toMysqlDatetime() because the schema uses naive DATETIME columns.

import mysql from 'mysql2/promise';
import { toMysqlDatetime } from '../../utils/datetime.js';

function normalizeParam(p) {
  if (p instanceof Date) return toMysqlDatetime(p);
  if (typeof p === 'string') {
    // Heuristic: ISO 8601 strings (T...Z) get normalized.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(p)) return toMysqlDatetime(p);
    return p;
  }
  return p;
}

function normalizeParams(params) {
  return params.map(normalizeParam);
}

export function createMysqlDriver(config) {
  const pool = mysql.createPool({
    host: config.host,
    port: config.port ?? 3306,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: config.connectionLimit ?? 10,
    namedPlaceholders: false,
    timezone: '+08:00',
    dateStrings: false,
    multipleStatements: false,
    charset: 'utf8mb4'
  });

  async function execute(sqlStr, params = []) {
    const [rows, _fields] = await pool.execute(sqlStr, normalizeParams(params));
    // rows may be array (SELECT) or OkPacket-shaped object (INSERT/UPDATE).
    if (Array.isArray(rows)) {
      return { rows, affectedRows: 0, insertId: undefined };
    }
    return {
      rows: [],
      affectedRows: rows.affectedRows ?? 0,
      insertId: rows.insertId ?? undefined
    };
  }

  async function query(sqlStr, params = []) {
    const { rows } = await execute(sqlStr, params);
    return { rows };
  }

  async function transaction(work) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const tx = {
        async execute(sqlStr, params = []) {
          const [rows] = await conn.execute(sqlStr, normalizeParams(params));
          if (Array.isArray(rows)) return { rows, affectedRows: 0, insertId: undefined };
          return { rows: [], affectedRows: rows.affectedRows ?? 0, insertId: rows.insertId ?? undefined };
        },
        async query(sqlStr, params = []) {
          const { rows } = await tx.execute(sqlStr, params);
          return { rows };
        }
      };
      const result = await work(tx);
      await conn.commit();
      return result;
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  async function healthcheck() {
    const [rows] = await pool.execute('SELECT 1 AS ok');
    if (!rows || rows[0]?.ok !== 1) throw new Error('mysql healthcheck failed');
  }

  async function close() {
    await pool.end();
  }

  return { dialect: 'mysql', execute, query, transaction, healthcheck, close };
}
```

**Step 2: Verify driver connects to running MySQL**

```bash
cd center && node -e "
import('./src/db/drivers/mysql.js').then(async ({ createMysqlDriver }) => {
  const cfg = JSON.parse(require('fs').readFileSync('./appsettings.json', 'utf8')).mysql;
  const db = createMysqlDriver(cfg);
  await db.healthcheck();
  console.log('mysql driver ok');
  const r = await db.execute('SELECT 1 AS ok');
  console.log('rows:', r.rows);
  await db.close();
});
"
```

Expected: prints `mysql driver ok` and `rows: [ { ok: 1 } ]`.

**Step 3: Run full center tests, expect still green**

```bash
cd center && npm test 2>&1 | tail -5
```

Expected: 70 pass / 1 skip / 0 fail.

**Step 4: Commit**

```bash
git add center/src/db/drivers/mysql.js
git commit -m "feat(db): mysql driver wrapper with execute/query/transaction API"
```

---

### Task 5: Create mssql driver wrapper

**Files:**
- Create: `center/src/db/drivers/mssql.js`

**Step 1: Create the driver**

Create `center/src/db/drivers/mssql.js`:

```js
// mssql driver wrapper. Same Db interface as drivers/mysql.js:
//   execute(sql, params) -> { rows, affectedRows, insertId }
//   query(sql, params)   -> { rows }
//   transaction(work)    -> result of work(tx)
//   healthcheck()        -> void
//   close()
//
// Differences from mysql driver:
//   - Placeholders: ? -> @p1, @p2, ... rewritten in-flight
//   - INSERT insertId: SCOPE_IDENTITY() appended as second batch
//   - Booleans: BIT columns return true/false; normalize to 0/1 for app
//   - No datetime normalization (SQL Server datetime2 accepts ISO)

import sql from 'mssql';

function rewritePlaceholders(sqlStr) {
  // Replace each `?` with `@p1, @p2, ...` in order. Only standalone `?`
  // (not inside string literals). Simple regex; sufficient because our
  // SQL strings never contain literal `?` characters.
  let i = 0;
  return sqlStr.replace(/\?/g, () => `@p${++i}`);
}

function bindInputs(request, params) {
  for (let i = 0; i < params.length; i++) {
    request.input(`p${i + 1}`, params[i]);
  }
}

function normalizeRow(row) {
  if (row == null) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'boolean') out[k] = v ? 1 : 0;
    else out[k] = v;
  }
  return out;
}

function normalizeRows(rows) {
  return Array.isArray(rows) ? rows.map(normalizeRow) : [];
}

export function createMssqlDriver(config) {
  const poolCfg = {
    server: config.server,
    database: config.database,
    user: config.user,
    password: config.password,
    port: config.port ?? 1433,
    options: {
      encrypt: config.encrypt ?? false,
      trustServerCertificate: config.trustServerCertificate ?? true
    },
    pool: {
      max: config.pool?.max ?? 10,
      min: 0,
      idleTimeoutMillis: 30000
    }
  };

  const pool = new sql.ConnectionPool(poolCfg);
  // Connect eagerly on first request (mssql pool connects on .connect()).
  let connected = false;
  async function ensureConnected() {
    if (!connected) {
      await pool.connect();
      connected = true;
    }
  }

  async function execute(sqlStr, params = []) {
    await ensureConnected();
    const rewritten = rewritePlaceholders(sqlStr);
    const isInsert = /^\s*(INSERT|MERGE)\b/i.test(sqlStr);
    const needsScopeIdentity = isInsert && /\bINTO\b/i.test(sqlStr);

    const request = pool.request();
    bindInputs(request, params);
    const result = await request.query(rewritten);

    let rows = normalizeRows(result.recordset ?? []);
    let affectedRows = result.rowsAffected?.[0] ?? 0;
    let insertId;

    if (needsScopeIdentity) {
      // Run SCOPE_IDENTITY() in a separate batch on the same connection.
      const idReq = pool.request();
      const idRes = await idReq.query('SELECT CAST(SCOPE_IDENTITY() AS bigint) AS id');
      const idRow = idRes.recordset?.[0];
      insertId = idRow?.id != null ? Number(idRow.id) : undefined;
    }

    return { rows, affectedRows, insertId };
  }

  async function query(sqlStr, params = []) {
    const { rows } = await execute(sqlStr, params);
    return { rows };
  }

  async function transaction(work) {
    await ensureConnected();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const txWrapper = {
        async execute(sqlStr, params = []) {
          const rewritten = rewritePlaceholders(sqlStr);
          const request = new sql.Request(tx);
          bindInputs(request, params);
          const result = await request.query(rewritten);
          let rows = normalizeRows(result.recordset ?? []);
          let affectedRows = result.rowsAffected?.[0] ?? 0;
          let insertId;
          if (/^\s*(INSERT|MERGE)\b/i.test(sqlStr) && /\bINTO\b/i.test(sqlStr)) {
            const idReq = new sql.Request(tx);
            const idRes = await idReq.query('SELECT CAST(SCOPE_IDENTITY() AS bigint) AS id');
            const idRow = idRes.recordset?.[0];
            insertId = idRow?.id != null ? Number(idRow.id) : undefined;
          }
          return { rows, affectedRows, insertId };
        },
        async query(sqlStr, params = []) {
          const { rows } = await txWrapper.execute(sqlStr, params);
          return { rows };
        }
      };
      const result = await work(txWrapper);
      await tx.commit();
      return result;
    } catch (e) {
      try { await tx.rollback(); } catch {}
      throw e;
    }
  }

  async function healthcheck() {
    await ensureConnected();
    const request = pool.request();
    const result = await request.query('SELECT 1 AS ok');
    if (!result.recordset?.[0]?.ok) throw new Error('mssql healthcheck failed');
  }

  async function close() {
    if (connected) await pool.close();
  }

  return { dialect: 'mssql', execute, query, transaction, healthcheck, close };
}
```

**Step 2: Verify driver loads (no real SQL Server needed for syntax check)**

```bash
cd center && node -e "import('./src/db/drivers/mssql.js').then(m => console.log('mssql driver loaded:', typeof m.createMssqlDriver))"
```

Expected: `mssql driver loaded: function`.

**Step 3: Verify placeholder rewrite logic in isolation**

```bash
cd center && node -e "
const code = require('fs').readFileSync('./src/db/drivers/mssql.js', 'utf8');
const m = code.match(/function rewritePlaceholders[^}]+\}/);
console.log('rewritePlaceholders found:', !!m);
"
```

Expected: `rewritePlaceholders found: true`.

(Full integration test with a real SQL Server happens in T17+ when env is set.)

**Step 4: Run full center tests, expect still green**

```bash
cd center && npm test 2>&1 | tail -5
```

Expected: 70 pass / 1 skip / 0 fail.

**Step 5: Commit**

```bash
git add center/src/db/drivers/mssql.js
git commit -m "feat(db): mssql driver wrapper with placeholder rewrite + SCOPE_IDENTITY"
```

---

### Task 6: Create db facade

**Files:**
- Create: `center/src/db/index.js`
- Create: `center/src/db/errors.js`

**Step 1: Create the errors module**

Create `center/src/db/errors.js`:

```js
// Normalized error type thrown by the db facade. Wraps both mysql2 and
// mssql driver errors with a unified `code` namespace so route handlers
// don't need to know which driver produced the error.

const CODE_MAP = {
  // mysql
  ER_DUP_ENTRY: 'DUP_ENTRY',
  ER_TRUNCATED_WRONG_VALUE: 'TRUNCATED',
  ER_NO_REFERENCED_ROW_2: 'FK_VIOLATION',
  ER_ROW_IS_REFERENCED_2: 'FK_IN_USE',
  ECONNREFUSED: 'CONN_REFUSED',
  ETIMEDOUT: 'TIMEOUT',
  PROTOCOL_CONNECTION_LOST: 'CONN_LOST',
  // mssql
  EREQUEST: 'DRIVER_ERROR',
  ELOCKTIMEOUT: 'TIMEOUT',
  ETIMEOUT: 'TIMEOUT'
};

export class DbError extends Error {
  constructor(originalError, { code, sqlState, sqlMessage } = {}) {
    super(originalError?.message || String(originalError));
    this.name = 'DbError';
    this.originalError = originalError;
    this.code = code || CODE_MAP[originalError?.code] || 'UNKNOWN';
    this.sqlState = sqlState;
    this.sqlMessage = sqlMessage;
  }

  static wrap(e) {
    if (e instanceof DbError) return e;
    return new DbError(e, {
      code: e.code,
      sqlState: e.sqlState || e.number?.toString(),
      sqlMessage: e.sqlMessage
    });
  }
}
```

**Step 2: Create the facade**

Create `center/src/db/index.js`:

```js
// DB facade. The ONLY place that knows which driver (mysql/mssql) is in use.
// Boot order:
//   1. loadConfig() reads appsettings.json, exposes config.db.dialect + config.db.{mysql|mssql}
//   2. db.init(config) initializes the matching driver and the frozen SQL registry
//   3. db.execute/db.query/db.transaction/db.healthcheck/db.close are used by app code

import { buildSql, SUPPORTED_DIALECTS } from './sql.js';
import { createMysqlDriver } from './drivers/mysql.js';
import { createMssqlDriver } from './drivers/mssql.js';
import { DbError } from './errors.js';

let state = null;

export async function init(config) {
  if (state) return state.db;
  const dialect = config.db?.dialect;
  if (!dialect) throw new Error('config.db.dialect is required');
  if (!SUPPORTED_DIALECTS.includes(dialect)) {
    throw new Error(`unsupported dialect: ${dialect}; supported: ${SUPPORTED_DIALECTS.join(', ')}`);
  }

  const driverCfg = config.db[dialect];
  if (!driverCfg) throw new Error(`config.db.${dialect} is required when dialect='${dialect}'`);

  const driver = dialect === 'mysql' ? createMysqlDriver(driverCfg) : createMssqlDriver(driverCfg);
  const sql = buildSql(dialect);
  const db = {
    dialect,
    sql,
    execute: async (s, p) => { try { return await driver.execute(s, p); } catch (e) { throw DbError.wrap(e); } },
    query:   async (s, p) => { try { return await driver.query(s, p);   } catch (e) { throw DbError.wrap(e); } },
    transaction: async (work) => { try { return await driver.transaction(work); } catch (e) { throw DbError.wrap(e); } },
    healthcheck: async () => { try { await driver.healthcheck(); } catch (e) { throw DbError.wrap(e); } },
    close: async () => { try { await driver.close(); } catch (e) { throw DbError.wrap(e); } }
  };
  state = { db, driver };
  return db;
}

export function getDb() {
  if (!state) throw new Error('db not initialized; call db.init(config) first');
  return state.db;
}

export async function close() {
  if (!state) return;
  await state.db.close();
  state = null;
}
```

**Step 3: Verify facade loads**

```bash
cd center && node -e "import('./src/db/index.js').then(m => console.log('exports:', Object.keys(m)))"
```

Expected: `exports: [ 'init', 'getDb', 'close' ]`.

**Step 4: Run full center tests, expect still green**

```bash
cd center && npm test 2>&1 | tail -5
```

Expected: 70 pass / 1 skip / 0 fail.

**Step 5: Commit**

```bash
git add center/src/db/index.js center/src/db/errors.js
git commit -m "feat(db): facade with init/getDb/close and dialect-driven boot"
```

---

### Task 7: Adapter unit tests

**Files:**
- Create: `center/tests/db-adapter.test.js`

**Step 1: Write the test file**

Create `center/tests/db-adapter.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSql } from '../src/db/sql.js';
import { DbError } from '../src/db/errors.js';

// --- buildSql ---

test('buildSql(mysql) returns frozen object with all expected domains', () => {
  const sql = buildSql('mysql');
  assert.equal(Object.isFrozen(sql), true);
  for (const domain of ['health', 'replication', 'discovery', 'users', 'roles', 'config', 'audit', 'sites', 'dcs', 'dashboard', 'heartbeat']) {
    assert.ok(sql[domain], `missing domain: ${domain}`);
    assert.equal(Object.isFrozen(sql[domain]), true);
  }
});

test('buildSql(unknown) throws', () => {
  assert.throws(() => buildSql('postgres'), /unknown dialect/);
});

// --- DbError normalization ---

test('DbError.wrap: mysql ER_DUP_ENTRY -> DUP_ENTRY', () => {
  const e = new Error('Duplicate entry');
  e.code = 'ER_DUP_ENTRY';
  const wrapped = DbError.wrap(e);
  assert.ok(wrapped instanceof DbError);
  assert.equal(wrapped.code, 'DUP_ENTRY');
});

test('DbError.wrap: mssql EREQUEST with number 2627 -> DRIVER_ERROR (caller checks sqlState)', () => {
  const e = new Error('Violation of UNIQUE KEY constraint');
  e.code = 'EREQUEST';
  e.number = 2627;
  const wrapped = DbError.wrap(e);
  assert.equal(wrapped.code, 'DRIVER_ERROR');
  assert.equal(wrapped.sqlState, '2627');
});

test('DbError.wrap: passes through already-wrapped DbError', () => {
  const original = new DbError(new Error('x'), { code: 'X' });
  assert.strictEqual(DbError.wrap(original), original);
});

test('DbError.wrap: unknown error -> code UNKNOWN', () => {
  const wrapped = DbError.wrap(new Error('boom'));
  assert.equal(wrapped.code, 'UNKNOWN');
});
```

**Step 2: Run tests**

```bash
cd center && node --test tests/db-adapter.test.js
```

Expected: 7 pass / 0 fail.

**Step 3: Run full suite**

```bash
cd center && npm test 2>&1 | tail -5
```

Expected: 77 pass / 1 skip / 0 fail (70 + 7 new).

**Step 4: Commit**

```bash
git add center/tests/db-adapter.test.js
git commit -m "test(db): adapter unit tests for sql registry and DbError"
```

---

### Task 8: Refactor `services/replication.js`

**Files:**
- Modify: `center/src/services/replication.js`

**Step 1: Refactor to use db facade**

Replace entire `center/src/services/replication.js`:

```js
// Replication UPSERT service. Reads SQL from db.sql registry and executes
// via db facade, so the same code works against MySQL or SQL Server.

import { getDb } from '../db/index.js';
import { toMysqlDatetime } from '../utils/datetime.js';

function rowParams(row) {
  return [
    toMysqlDatetime(row.collectedAt),
    row.agentId,
    row.sourceDc,
    row.destDc,
    row.sourceSite ?? null,
    row.destSite ?? null,
    row.namingContext,
    toMysqlDatetime(row.lastSuccessTime),
    toMysqlDatetime(row.lastAttemptTime),
    row.statusCode,
    row.errorMessage ?? null
  ];
}

function historyParams(row) {
  return [
    toMysqlDatetime(row.collectedAt),
    row.agentId,
    row.sourceDc,
    row.destDc,
    row.namingContext,
    toMysqlDatetime(row.lastSuccessTime),
    row.statusCode,
    row.errorMessage ?? null
  ];
}

export async function upsertStatus(rows, { appendHistory = false } = {}) {
  const db = getDb();
  for (const row of rows) {
    await db.execute(db.sql.replication.upsertStatus, rowParams(row));
    if (appendHistory) {
      await db.execute(db.sql.replication.upsertHistory, historyParams(row));
    }
  }
}

export async function listRecent(limit = 100) {
  const db = getDb();
  const { rows } = await db.query(db.sql.replication.listRecent, [limit]);
  return rows;
}

export async function listBySite(site, limit = 100) {
  const db = getDb();
  const { rows } = await db.query(db.sql.replication.listBySite, [site, site, limit]);
  return rows;
}
```

**Step 2: Run replication tests, expect still green**

```bash
cd center && node --test tests/replication.test.js 2>&1 | tail -10
```

Expected: same as before — tests use mock pool which won't match new facade API.

If tests fail because they expect `pool.execute` directly, the test file needs updating — see T16 (test helper update). Skip ahead and run full suite after T16; this task's tests will pass once the helper is updated.

**Step 3: Commit**

```bash
git add center/src/services/replication.js
git commit -m "refactor(services): replication uses db facade and sql registry"
```

---

### Task 9: Refactor remaining services

**Files:**
- Modify: `center/src/services/discovery.js`
- Modify: `center/src/services/users.js`
- Modify: `center/src/services/audit.js`
- Modify: `center/src/services/config.js`

**Step 1: Refactor `services/discovery.js`**

Replace entire `center/src/services/discovery.js`:

```js
import { getDb } from '../db/index.js';
import { toMysqlDatetime } from '../utils/datetime.js';

export async function upsertDiscoveredDc({ agentId, collectedAt, dc }) {
  const db = getDb();
  await db.execute(db.sql.discovery.upsertDc, [
    dc.name,
    dc.siteHint ?? null,
    dc.osVersion ?? null,
    toMysqlDatetime(dc.whenCreated),
    dc.isPdc ? 1 : 0,
    dc.isGc ? 1 : 0,
    dc.isRidMaster ? 1 : 0,
    dc.isSchemaMaster ? 1 : 0,
    dc.isDomainNamingMaster ? 1 : 0,
    dc.isInfrastructureMaster ? 1 : 0,
    toMysqlDatetime(collectedAt),
    agentId
  ]);
}
```

**Step 2: Refactor `services/users.js`**

Replace entire `center/src/services/users.js`:

```js
import bcrypt from 'bcrypt';
import { getDb } from '../db/index.js';

export async function findByUsername(username) {
  const db = getDb();
  const { rows } = await db.query(db.sql.users.findByUsername, [username]);
  return rows[0] ?? null;
}

export async function listUsers() {
  const db = getDb();
  const { rows } = await db.query(db.sql.users.list);
  return rows;
}

export async function createUser({ username, password, roleId, status }) {
  const db = getDb();
  const passwordHash = await bcrypt.hash(password, 12);
  await db.execute(db.sql.users.create, [username, passwordHash, roleId, status ?? 1]);
}

export async function updateUser(id, { password, roleId, status }) {
  const db = getDb();
  const passwordHash = password ? await bcrypt.hash(password, 12) : null;
  await db.execute(db.sql.users.update, [passwordHash, roleId, status, id]);
}

export async function deleteUser(id) {
  const db = getDb();
  await db.execute(db.sql.users.delete, [id]);
}

export async function recordLogin(id) {
  const db = getDb();
  await db.execute(db.sql.users.recordLogin, [id]);
}

export async function authenticate(username, password) {
  const user = await findByUsername(username);
  if (!user || user.status !== 1) return null;
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return null;
  await recordLogin(user.id);
  return user;
}

export async function countAdmins() {
  const db = getDb();
  const { rows } = await db.query(db.sql.users.countAdmins);
  return rows[0]?.n ?? 0;
}
```

**Step 3: Refactor `services/audit.js`**

Replace entire `center/src/services/audit.js`:

```js
import { getDb } from '../db/index.js';

export async function writeAudit({ userId, action, target, payload }, logger) {
  const db = getDb();
  try {
    await db.execute(db.sql.audit.write, [
      userId ?? null,
      action,
      target ?? null,
      payload == null ? null : JSON.stringify(payload)
    ]);
  } catch (e) {
    if (logger) logger.warn({ err: e.message, action, target }, 'audit write failed (best-effort)');
  }
}

export async function listAudit(limit) {
  const db = getDb();
  const { rows } = await db.query(db.sql.audit.list, [limit]);
  return rows;
}
```

**Step 4: Refactor `services/config.js`**

Replace entire `center/src/services/config.js`:

```js
// System config service. Reads/writes key-value rows in `system_config`
// and exposes the agent-facing config bundle (polling, latency threshold,
// token).

import { getDb } from '../db/index.js';

export async function getConfig() {
  const db = getDb();
  const { rows } = await db.query(db.sql.config.getAll);
  const out = {};
  for (const row of rows) out[row.config_key] = row.config_value;
  return out;
}

export async function setConfig(key, value) {
  const db = getDb();
  // Per-key UPDATE kept inline (config table has only a few rows; one round-trip per key is fine).
  await db.execute(
    'UPDATE system_config SET config_value = ?, updated_at = CURRENT_TIMESTAMP WHERE config_key = ?',
    [value == null ? null : String(value), key]
  );
}

export async function setAgentToken(token) {
  const db = getDb();
  await db.execute(db.sql.config.setAgentToken, [token]);
}

export async function getAgentConfig() {
  const all = await getConfig();
  return {
    pollingIntervalMinutes: Number(all.polling_interval_minutes || 15),
    latencyThresholdMinutes: Number(all.latency_threshold_minutes || 180),
    heartbeatIntervalSeconds: Number(all.heartbeat_interval_seconds || 5),
    discoveryIntervalHours: Number(all.discovery_interval_hours || 4),
    agentToken: all.agent_token ?? null,
    centerPublicHost: all.center_public_host ?? null,
    centerPublicPort: all.center_public_port ?? null
  };
}
```

**Step 5: Run full suite — expect test failures until T16**

```bash
cd center && npm test 2>&1 | tail -20
```

Expected: many tests fail because they pass `pool:` to `buildApp` but services now read from `getDb()` module singleton. This is OK; T16 fixes the test helper.

**Step 6: Commit**

```bash
git add center/src/services/discovery.js center/src/services/users.js center/src/services/audit.js center/src/services/config.js
git commit -m "refactor(services): discovery/users/audit/config use db facade"
```

---

### Task 10: Refactor `routes/admin.js`

**Files:**
- Modify: `center/src/routes/admin.js`

**Step 1: Refactor `routes/admin.js`**

Replace entire `center/src/routes/admin.js`:

```js
import { Router } from 'express';
import { userAuth } from '../auth/user-auth.js';
import { requirePerm } from '../auth/rbac.js';
import { findByUsername, listUsers, createUser, updateUser, deleteUser } from '../services/users.js';
import { getConfig, setConfig } from '../services/config.js';
import { writeAudit } from '../services/audit.js';
import { getDb } from '../db/index.js';

// Snake -> camel rename for known columns in admin responses.
const CAML_MAP = new Map([
  ['role_name', 'roleName'],
  ['last_login_at', 'lastLoginAt'],
  ['created_at', 'createdAt'],
  ['user_id', 'userId'],
  ['config_key', 'configKey'],
  ['config_value', 'configValue'],
  ['updated_at', 'updatedAt'],
  ['updated_by', 'updatedBy'],
  ['link_count', 'linkCount'],
  ['error_count', 'errorCount'],
  ['last_seen', 'lastSeen'],
  ['site_name', 'siteName'],
  ['region_code', 'regionCode'],
  ['is_hub', 'isHub']
]);

function camelRow(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const nk = CAML_MAP.get(k) ?? k;
    out[nk] = v;
  }
  return out;
}

export function adminRouter({ config, logger }) {
  const r = Router();
  const auth = [userAuth({ secret: config.jwtSecret }), requirePerm('admin:users')];

  r.get('/api/admin/roles', auth, async (_req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.roles.list);
      const out = rows.map(row => ({
        id: row.id,
        roleName: row.role_name,
        permissions: row.permissions ? JSON.parse(row.permissions) : []
      }));
      res.json(out);
    } catch (e) {
      logger.error({ err: e }, 'admin roles failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.get('/api/admin/users', auth, async (_req, res) => {
    try {
      const rs = await listUsers();
      res.json(rs.map(camelRow));
    } catch (e) {
      logger.error({ err: e }, 'admin users list failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.post('/api/admin/users', auth, async (req, res) => {
    try {
      const { username, password, roleId, status } = req.body || {};
      if (!username || !password || roleId == null) {
        return res.status(400).json({ error: 'missing fields' });
      }
      const existing = await findByUsername(username);
      if (existing) {
        return res.status(409).json({ error: 'username exists' });
      }
      await createUser({ username, password, roleId, status });
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'create_user',
        target: username,
        payload: { username, roleId, status: status ?? 1 },
        logger
      });
      res.status(201).json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'admin user create failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.put('/api/admin/users/:id', auth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { password, roleId, status } = req.body || {};
      await updateUser(id, { password, roleId, status });
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'update_user',
        target: String(id),
        payload: req.body || {},
        logger
      });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'admin user update failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.delete('/api/admin/users/:id', auth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      await deleteUser(id);
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'delete_user',
        target: String(id),
        payload: null,
        logger
      });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'admin user delete failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.get('/api/admin/config', auth, async (_req, res) => {
    try {
      const cfg = await getConfig();
      res.json(cfg);
    } catch (e) {
      logger.error({ err: e }, 'admin config get failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.put('/api/admin/config', auth, async (req, res) => {
    try {
      const updates = req.body || {};
      for (const [k, v] of Object.entries(updates)) {
        await setConfig(k, v);
      }
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'update_config',
        target: 'system_config',
        payload: updates,
        logger
      });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'admin config update failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.get('/api/admin/audit', auth, async (req, res) => {
    try {
      let limit = Number(req.query.limit ?? 200);
      if (!Number.isFinite(limit) || limit <= 0) limit = 200;
      if (limit > 1000) limit = 1000;
      const rows = await (await import('../services/audit.js')).listAudit(limit);
      res.json(rows.map(camelRow));
    } catch (e) {
      logger.error({ err: e }, 'admin audit list failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----- Sites (derived from ad_replication_status) -----
  r.get('/api/admin/sites', auth, async (_req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.sites.listDistinct);
      res.json(rows.map(camelRow));
    } catch (e) {
      logger.error({ err: e }, 'admin sites list failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----- DCs (derived from ad_replication_status) -----
  r.get('/api/admin/dcs', auth, async (_req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.dcs.listDistinct);
      res.json(rows.map(camelRow));
    } catch (e) {
      logger.error({ err: e }, 'admin dcs list failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----- Sites Catalog -----
  r.get('/api/admin/sites-catalog', auth, async (_req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.sites.listCatalog);
      res.json(rows.map(camelRow));
    } catch (e) {
      logger.error({ err: e }, 'sites-catalog list failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.post('/api/admin/sites-catalog', auth, async (req, res) => {
    const { siteName, regionCode, isHub, description } = req.body || {};
    if (!siteName) return res.status(400).json({ error: 'missing siteName' });
    try {
      const db = getDb();
      const result = await db.execute(db.sql.sites.create, [siteName, regionCode ?? null, isHub ? 1 : 0, description ?? null]);
      res.status(201).json({ id: result.insertId });
    } catch (e) {
      if (e.code === 'DUP_ENTRY') return res.status(409).json({ error: 'siteName already exists' });
      logger.error({ err: e }, 'sites-catalog create failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.put('/api/admin/sites-catalog/:id', auth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const { siteName, regionCode, isHub, description } = req.body || {};
    const fields = [];
    const params = [];
    if (siteName !== undefined)    { fields.push('site_name = ?');    params.push(siteName); }
    if (regionCode !== undefined)  { fields.push('region_code = ?');  params.push(regionCode); }
    if (isHub !== undefined)       { fields.push('is_hub = ?');       params.push(isHub ? 1 : 0); }
    if (description !== undefined) { fields.push('description = ?');  params.push(description); }
    if (fields.length === 0) return res.status(400).json({ error: 'no fields to update' });
    params.push(id);
    try {
      const db = getDb();
      const { affectedRows } = await db.execute(db.sql.sites.updatePartial(fields), params);
      if (affectedRows === 0) return res.status(404).json({ error: 'site not found' });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'sites-catalog update failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.delete('/api/admin/sites-catalog/:id', auth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    try {
      const db = getDb();
      await db.execute(db.sql.sites.unbindDcs, [id]);
      const { affectedRows } = await db.execute(db.sql.sites.delete, [id]);
      if (affectedRows === 0) return res.status(404).json({ error: 'site not found' });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'sites-catalog delete failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----- DCs Catalog -----
  r.get('/api/admin/dcs-catalog', auth, async (_req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.dcs.listCatalog);
      res.json(rows.map(r => ({
        ...r,
        isPdc: !!r.isPdc, isGc: !!r.isGc, isRidMaster: !!r.isRidMaster,
        isSchemaMaster: !!r.isSchemaMaster, isDomainNamingMaster: !!r.isDomainNamingMaster,
        isInfrastructureMaster: !!r.isInfrastructureMaster
      })));
    } catch (e) {
      logger.error({ err: e }, 'dcs-catalog list failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.put('/api/admin/dcs-catalog/:dc_name/site', auth, async (req, res) => {
    const dcName = req.params.dc_name;
    const { siteId } = req.body || {};
    try {
      const db = getDb();
      const sqlText = siteId == null ? db.sql.dcs.assignSiteUnbind : db.sql.dcs.assignSite;
      const params = siteId == null ? [dcName] : [siteId, dcName];
      const { affectedRows } = await db.execute(sqlText, params);
      if (affectedRows === 0) return res.status(404).json({ error: 'dc not found' });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'dcs-catalog site assign failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}
```

**Step 2: Commit**

```bash
git add center/src/routes/admin.js
git commit -m "refactor(routes): admin uses db facade and sql registry"
```

---

### Task 11: Refactor remaining routes

**Files:**
- Modify: `center/src/routes/dashboard.js`
- Modify: `center/src/routes/agent.js`
- Modify: `center/src/routes/healthz.js`

**Step 1: Refactor `routes/healthz.js`**

Replace entire `center/src/routes/healthz.js`:

```js
import { Router } from 'express';
import { getDb } from '../db/index.js';

export function healthzRouter() {
  const r = Router();
  r.get('/healthz', async (_req, res) => {
    try {
      const db = getDb();
      await db.healthcheck();
      const { rows: lastRows } = await db.query(db.sql.health.lastHeartbeat);
      res.json({
        status: 'ok',
        db: 'ok',
        dialect: db.dialect,
        lastHeartbeat: lastRows[0]?.last ?? null
      });
    } catch (e) {
      res.status(503).json({ status: 'degraded', error: e.message });
    }
  });
  return r;
}
```

**Step 2: Refactor `routes/agent.js`**

Read current file (paths/refs already known), then replace:

For `POST /api/agent/report`:
```js
// In handler:
const db = getDb();
await upsertStatus(rows.map(r => ({ ...r, agentId, collectedAt })), { appendHistory: true });
```

For `POST /api/agent/discover`:
```js
const db = getDb();
await upsertDiscoveredDc({ agentId, collectedAt, dc });
```

For `POST /api/agent/heartbeat`:
```js
const db = getDb();
await db.execute(db.sql.heartbeat.upsert, [agentId, agentVersion ?? null, pendingQueueSize ?? 0]);
```

The file should have factory signature `agentRouter({ config, logger })` (no `pool`).

**Step 3: Refactor `routes/dashboard.js`**

Read current file, replace each `pool.execute('SELECT ...')` with `db.execute(db.sql.dashboard.X, params)` / `db.query(...)`. Update factory to `dashboardRouter({ config, logger })`.

**Step 4: Commit**

```bash
git add center/src/routes/dashboard.js center/src/routes/agent.js center/src/routes/healthz.js
git commit -m "refactor(routes): dashboard/agent/healthz use db facade and sql registry"
```

---

### Task 12: Update `config.js` for `db.dialect`

**Files:**
- Modify: `center/src/config.js`

**Step 1: Update the config loader**

Replace entire `center/src/config.js`:

```js
import { readFileSync } from 'node:fs';
import { SUPPORTED_DIALECTS } from './db/sql.js';

const REQUIRED_BY_DIALECT = {
  mysql: ['db.mysql.host', 'db.mysql.database'],
  mssql: ['db.mssql.server', 'db.mssql.database']
};

const TOP_LEVEL_REQUIRED = ['listenPort', 'jwtSecret', 'agentToken', 'staticDir'];

export function loadConfig(path) {
  const raw = readFileSync(path, 'utf8');
  const cfg = JSON.parse(raw);

  // Validate dialect
  const dialect = cfg.db?.dialect;
  if (!dialect) throw new Error('config missing required key: db.dialect');
  if (!SUPPORTED_DIALECTS.includes(dialect)) {
    throw new Error(`config.db.dialect invalid: '${dialect}'; supported: ${SUPPORTED_DIALECTS.join(', ')}`);
  }

  // Validate dialect-specific connection block
  for (const k of REQUIRED_BY_DIALECT[dialect]) {
    const v = k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), cfg);
    if (v === undefined || v === null || v === '') {
      throw new Error(`config missing required key: ${k}`);
    }
  }

  // Validate top-level required
  for (const k of TOP_LEVEL_REQUIRED) {
    if (cfg[k] === undefined || cfg[k] === null || cfg[k] === '') {
      throw new Error(`config missing required key: ${k}`);
    }
  }

  return {
    db: { dialect, [dialect]: cfg.db[dialect] },
    listenPort: cfg.listenPort,
    jwtSecret: cfg.jwtSecret,
    agentToken: cfg.agentToken,
    staticDir: cfg.staticDir,
    logLevel: cfg.logLevel || 'info',
    env: cfg.env || 'prod',
    frontendDevProxy: cfg.frontendDevProxy || null
  };
}
```

**Step 2: Update `center/appsettings.json`**

Add `db` block:

```json
{
  "db": {
    "dialect": "mysql",
    "mysql": {
      "host": "localhost",
      "port": 3306,
      "database": "AD_Monitoring",
      "user": "root",
      "password": "Admin909217"
    }
  },
  "listenPort": 8080,
  ...
}
```

Move the existing `mysql:` block under `db.mysql`. Keep `listenPort`, `jwtSecret`, `agentToken`, `staticDir`, etc. at top level.

**Step 3: Update `center/tests/config.test.js`**

The first test (`loadConfig parses required keys`) feeds a fixture with a top-level `mysql:` key; the new `loadConfig` rejects that because `db.dialect` is missing. Replace the fixture JSON:

```js
writeFileSync(path, JSON.stringify({
  db: {
    dialect: 'mysql',
    mysql: { host: 'localhost', port: 3306, database: 'AD_Monitoring', user: 'root', password: 'pw' }
  },
  listenPort: 8080,
  jwtSecret: 'abc',
  agentToken: 'tok',
  staticDir: 'C:/web',
  logLevel: 'info',
  env: 'dev'
}));
```

The `loadConfig throws if required key missing` test already passes (still throws on missing keys).

The `getAgentConfig` tests still inject a `pool`-shaped object directly — that signature (`getAgentConfig(pool)`) stays unchanged in T9 (services are refactored to use `db` but `getAgentConfig` accepts the raw executor because `system_config` SQL stays a single statement and the test bypasses the facade). **No change needed there.**

**Step 4: Run full center tests (config tests green; other failures expected until T13-T16)**

```bash
cd center && npm test 2>&1 | tail -20
```

Expected: at minimum the two `loadConfig` tests pass. Other test files may fail because they still call `initPool`/`getPool` — those are fixed in T16.

**Step 5: Commit**

```bash
git add center/src/config.js center/appsettings.json center/tests/config.test.js
git commit -m "feat(config): load db.dialect + per-dialect connection blocks"
```

---

### Task 13: Add mssql SQL variants

**Files:**
- Modify: `center/src/db/sql.js`

**Step 1: Add mssql variant tree**

Open `center/src/db/sql.js`. Add the following as a new top-level `mssql` key in `VARIANTS` (parallel to `mysql`). Each statement uses SQL Server syntax:

```js
mssql: {
  health: {
    ping: 'SELECT 1 AS ok',
    lastHeartbeat: 'SELECT TOP 1 last_heartbeat_at AS last FROM ad_agent_heartbeat ORDER BY last_heartbeat_at DESC'
  },
  replication: {
    upsertStatus: `
      MERGE INTO ad_replication_status AS t
      USING (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?))
        AS s(collected_at, agent_id, source_dc, dest_dc, source_site, dest_site,
             naming_context, last_success_time, last_attempt_time, status_code, error_message)
      ON t.source_dc = s.source_dc AND t.dest_dc = s.dest_dc AND t.naming_context = s.naming_context
      WHEN MATCHED THEN UPDATE SET
        collected_at      = s.collected_at,
        agent_id          = s.agent_id,
        source_site       = s.source_site,
        dest_site         = s.dest_site,
        last_success_time = s.last_success_time,
        last_attempt_time = s.last_attempt_time,
        status_code       = s.status_code,
        error_message     = s.error_message
      WHEN NOT MATCHED THEN
        INSERT (collected_at, agent_id, source_dc, dest_dc, source_site, dest_site,
                naming_context, last_success_time, last_attempt_time, status_code, error_message)
        VALUES (s.collected_at, s.agent_id, s.source_dc, s.dest_dc, s.source_site, s.dest_site,
                s.naming_context, s.last_success_time, s.last_attempt_time, s.status_code, s.error_message);`.trim(),
    upsertHistory: `
      INSERT INTO ad_replication_history (
        collected_at, agent_id, source_dc, dest_dc, naming_context,
        last_success_time, status_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`.trim(),
    listRecent: `
      SELECT TOP (@p1) source_dc, dest_dc, source_site, dest_site, status_code, collected_at
      FROM ad_replication_status
      ORDER BY collected_at DESC`.trim(),
    listBySite: `
      SELECT TOP (@p3) source_dc, dest_dc, source_site, dest_site, status_code, collected_at
      FROM ad_replication_status
      WHERE source_site = @p1 OR dest_site = @p2
      ORDER BY collected_at DESC`.trim()
  },
  discovery: {
    upsertDc: `
      MERGE INTO ad_dcs AS t
      USING (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?))
        AS s(dc_name, site_hint, os_version, when_created,
              is_pdc, is_gc, is_rid_master, is_schema_master, is_domain_naming_master, is_infrastructure_master,
              discovered_at, discovered_by_agent_id)
      ON t.dc_name = s.dc_name
      WHEN MATCHED THEN UPDATE SET
        site_hint                = s.site_hint,
        os_version               = s.os_version,
        when_created             = s.when_created,
        is_pdc                   = s.is_pdc,
        is_gc                    = s.is_gc,
        is_rid_master            = s.is_rid_master,
        is_schema_master         = s.is_schema_master,
        is_domain_naming_master  = s.is_domain_naming_master,
        is_infrastructure_master = s.is_infrastructure_master,
        discovered_at            = SYSUTCDATETIME(),
        discovered_by_agent_id   = s.discovered_by_agent_id
      WHEN NOT MATCHED THEN
        INSERT (dc_name, site_hint, os_version, when_created,
                is_pdc, is_gc, is_rid_master, is_schema_master, is_domain_naming_master, is_infrastructure_master,
                discovered_at, discovered_by_agent_id)
        VALUES (s.dc_name, s.site_hint, s.os_version, s.when_created,
                s.is_pdc, s.is_gc, s.is_rid_master, s.is_schema_master, s.is_domain_naming_master, s.is_infrastructure_master,
                s.discovered_at, s.discovered_by_agent_id);`.trim()
  },
  users: {
    findByUsername: 'SELECT TOP 1 id, username, password_hash, role_id, status FROM sys_users WHERE username = @p1',
    list: 'SELECT id, username, role_id, status, last_login_at, created_at FROM sys_users ORDER BY id',
    create: 'INSERT INTO sys_users (username, password_hash, role_id, status) VALUES (@p1, @p2, @p3, @p4)',
    update: 'UPDATE sys_users SET password_hash = COALESCE(@p1, password_hash), role_id = COALESCE(@p2, role_id), status = COALESCE(@p3, status) WHERE id = @p4',
    delete: 'DELETE FROM sys_users WHERE id = @p1',
    recordLogin: 'UPDATE sys_users SET last_login_at = SYSUTCDATETIME() WHERE id = @p1',
    countAdmins: `SELECT COUNT(*) AS n FROM sys_users u JOIN sys_roles r ON u.role_id = r.id WHERE r.role_name = 'admin'`
  },
  roles: { list: 'SELECT id, role_name, permissions FROM sys_roles ORDER BY id' },
  config: {
    getAll: 'SELECT config_key, config_value FROM system_config',
    upsert: `
      IF EXISTS (SELECT 1 FROM system_config WHERE config_key = @p1)
        UPDATE system_config SET config_value = @p2, updated_at = SYSUTCDATETIME() WHERE config_key = @p1
      ELSE
        INSERT INTO system_config (config_key, config_value) VALUES (@p1, @p2)`.trim(),
    setAgentToken: `
      IF EXISTS (SELECT 1 FROM system_config WHERE config_key = 'agent_token')
        UPDATE system_config SET config_value = @p1, updated_at = SYSUTCDATETIME() WHERE config_key = 'agent_token'
      ELSE
        INSERT INTO system_config (config_key, config_value) VALUES ('agent_token', @p1)`.trim()
  },
  audit: {
    write: 'INSERT INTO audit_logs (user_id, action, target, payload) VALUES (@p1, @p2, @p3, @p4)',
    list: 'SELECT TOP (@p1) id, user_id, action, target, payload, created_at FROM audit_logs ORDER BY created_at DESC, id DESC'
  },
  sites: {
    listAll: 'SELECT site, region_code, is_hub FROM ad_sites',
    listCatalog: `
      SELECT s.site_id AS id, s.site_name AS siteName, s.region_code AS regionCode,
             s.is_hub AS isHub, s.description, s.created_at AS createdAt, s.updated_at AS updatedAt,
             (SELECT COUNT(*) FROM ad_dcs d WHERE d.site_id = s.site_id) AS dcCount
      FROM ad_sites s
      ORDER BY s.site_name`.trim(),
    listDistinct: `
      SELECT site AS name,
             COUNT(*) AS link_count,
             SUM(CASE WHEN status_code >= 2 THEN 1 ELSE 0 END) AS error_count,
             MAX(collected_at) AS last_seen
      FROM (
        SELECT source_site AS site, status_code, collected_at FROM ad_replication_status WHERE source_site IS NOT NULL
        UNION ALL
        SELECT dest_site, status_code, collected_at FROM ad_replication_status WHERE dest_site IS NOT NULL
      ) t
      GROUP BY site
      ORDER BY site`.trim(),
    findByName: 'SELECT site_id FROM ad_sites WHERE site_name = @p1',
    create: 'INSERT INTO ad_sites (site_name, region_code, is_hub, description) VALUES (@p1, @p2, @p3, @p4)',
    update: 'UPDATE ad_sites SET site_name = @p1, region_code = @p2, is_hub = @p3, description = @p4 WHERE site_id = @p5',
    updatePartial: (fields) => `UPDATE ad_sites SET ${fields.map((_, i) => fields[i].replace(/\?/g, `@p${i + 1}`)).join(', ')} WHERE site_id = @p${fields.length + 1}`,
    delete: 'DELETE FROM ad_sites WHERE site_id = @p1',
    unbindDcs: 'UPDATE ad_dcs SET site_id = NULL WHERE site_id = @p1'
  },
  dcs: {
    listCatalog: `
      SELECT d.dc_name AS dcName, d.site_id AS siteId, s.site_name AS siteName,
             d.site_hint AS siteHint, d.os_version AS osVersion, d.when_created AS whenCreated,
             d.is_pdc AS isPdc, d.is_gc AS isGc, d.is_rid_master AS isRidMaster,
             d.is_schema_master AS isSchemaMaster, d.is_domain_naming_master AS isDomainNamingMaster,
             d.is_infrastructure_master AS isInfrastructureMaster,
             d.discovered_at AS discoveredAt, d.discovered_by_agent_id AS discoveredByAgentId
      FROM ad_dcs d
      LEFT JOIN ad_sites s ON d.site_id = s.site_id
      ORDER BY d.dc_name`.trim(),
    listDistinct: `
      SELECT dc AS name, site,
             COUNT(*) AS link_count,
             SUM(CASE WHEN status_code >= 2 THEN 1 ELSE 0 END) AS error_count,
             MAX(collected_at) AS last_seen
      FROM (
        SELECT source_dc AS dc, source_site AS site, status_code, collected_at FROM ad_replication_status WHERE source_dc IS NOT NULL
        UNION ALL
        SELECT dest_dc, dest_site, status_code, collected_at FROM ad_replication_status WHERE dest_dc IS NOT NULL
      ) t
      GROUP BY dc, site
      ORDER BY dc, site`.trim(),
    assignSite: 'UPDATE ad_dcs SET site_id = @p1 WHERE dc_name = @p2',
    assignSiteUnbind: 'UPDATE ad_dcs SET site_id = NULL WHERE dc_name = @p1'
  },
  dashboard: {
    siteMatrix: `
      SELECT source_dc, dest_dc, source_site, dest_site, status_code, error_message, collected_at
      FROM ad_replication_status
      WHERE (source_site = @p1 OR dest_site = @p2)
      ORDER BY collected_at DESC`.trim(),
    errors: `
      SELECT TOP (@p1) source_dc, dest_dc, naming_context, error_message, status_code, collected_at
      FROM ad_replication_status
      WHERE status_code >= 2
      ORDER BY collected_at DESC`.trim(),
    agents: `
      SELECT agent_id, last_heartbeat_at, COUNT(*) AS row_count
      FROM ad_replication_status
      WHERE last_heartbeat_at >= @p1
      GROUP BY agent_id, last_heartbeat_at`.trim(),
    topology: `
      SELECT source_dc, dest_dc, status_code, MAX(collected_at) AS last_seen
      FROM ad_replication_status
      WHERE collected_at >= @p1
      GROUP BY source_dc, dest_dc, status_code`.trim()
  },
  heartbeat: {
    upsert: `
      IF EXISTS (SELECT 1 FROM ad_agent_heartbeat WHERE agent_id = @p1)
        UPDATE ad_agent_heartbeat
          SET last_heartbeat_at = SYSUTCDATETIME(),
              agent_version = @p2,
              pending_queue_size = @p3
          WHERE agent_id = @p1
      ELSE
        INSERT INTO ad_agent_heartbeat (agent_id, last_heartbeat_at, agent_version, pending_queue_size)
        VALUES (@p1, SYSUTCDATETIME(), @p2, @p3)`.trim()
  }
}
```

**Step 2: Verify dialect builds both**

```bash
cd center && node -e "
import('./src/db/sql.js').then(m => {
  const m1 = m.buildSql('mysql');
  const m2 = m.buildSql('mssql');
  console.log('mysql dialects ok:', Object.keys(m1).length, 'domains');
  console.log('mssql dialects ok:', Object.keys(m2).length, 'domains');
  console.log('mysql upsertStatus has ON DUPLICATE:', /ON DUPLICATE/.test(m1.replication.upsertStatus));
  console.log('mssql upsertStatus has MERGE:', /MERGE INTO/.test(m2.replication.upsertStatus));
});
"
```

Expected: both dialects build, mysql has `ON DUPLICATE`, mssql has `MERGE INTO`.

**Step 3: Run full center tests**

```bash
cd center && npm test 2>&1 | tail -5
```

Expected: still 70 pass / 1 skip / 0 fail (test helper not yet updated).

**Step 4: Commit**

```bash
git add center/src/db/sql.js
git commit -m "feat(db): mssql SQL variants (MERGE/IF EXISTS equivalents)"
```

---

### Task 14: Create mssql schema files

**Files:**
- Create: `db/schema/mssql/01-tables.sql`
- Create: `db/schema/mssql/02-seed-roles.sql`

**Step 1: Create `db/schema/mssql/01-tables.sql`**

Read `db/schema/01-tables.sql` (existing MySQL schema). Write a SQL Server equivalent. Key transformations:
- `tinyint(1)` → `bit`
- `varchar(N)` → `nvarchar(N)`
- `datetime` → `datetime2`
- `datetime NOT NULL DEFAULT CURRENT_TIMESTAMP` → `datetime2 NOT NULL DEFAULT SYSUTCDATETIME()`
- `datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP` → `datetime2 NOT NULL DEFAULT SYSUTCDATETIME()` (SQL Server has no ON UPDATE; trigger needed for auto-update, or app-level)
- `int AUTO_INCREMENT PRIMARY KEY` → `int IDENTITY(1,1) PRIMARY KEY`
- `IF NOT EXISTS` (table) → `IF OBJECT_ID('x','U') IS NULL BEGIN ... END`
- `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4` removed (SQL Server has no engine/charset clause)

Read current schema and translate. Save as `db/schema/mssql/01-tables.sql`.

**Step 2: Create `db/schema/mssql/02-seed-roles.sql`**

Read `db/schema/02-seed-roles.sql`. Translate INSERT VALUES to SQL Server syntax (`'admin', '["admin:users", ...]'`). The `permissions` column type may differ — verify against step 1 schema.

**Step 3: Verify both files parse**

```bash
# Verify no mysql-specific syntax slips through
grep -nE "ENGINE=|CHARSET=|AUTO_INCREMENT|tinyint\(|ON DUPLICATE|IF NOT EXISTS.*\(.*\)" db/schema/mssql/*.sql | head
```

Expected: no matches.

**Step 4: Commit**

```bash
git add db/schema/mssql/
git commit -m "feat(schema): SQL Server 2014+ schema for ad_sites/ad_dcs/system_config/etc."
```

---

### Task 15: Create mssql migration 001

**Files:**
- Create: `db/migrations/mssql/001-dc-site-discovery.sql`

**Step 1: Create the migration**

Read `db/migrations/001-dc-site-discovery.sql` (the MySQL version). Translate the stored-procedure pattern to SQL Server 2014 syntax (`IF NOT EXISTS (SELECT 1 FROM sys.columns ...)` pattern — no native `ADD COLUMN IF NOT EXISTS` in 2014). Translate all column types: `tinyint(1)` → `bit`, `varchar` → `nvarchar`, `datetime` → `datetime2`, `CURRENT_TIMESTAMP` → `SYSUTCDATETIME()`, `ON UPDATE CURRENT_TIMESTAMP` removed (SQL Server has no equivalent).

Save as `db/migrations/mssql/001-dc-site-discovery.sql`. The 9-column additions on `ad_dcs` and 3-column additions on `ad_sites` from migration 001 all need translation.

**Step 2: Verify no mysql-only syntax**

```bash
grep -nE "DELIMITER|CREATE PROCEDURE|ENGINE=|CHARSET=|ON DUPLICATE" db/migrations/mssql/001-dc-site-discovery.sql | head
```

Expected: no matches.

**Step 3: Commit**

```bash
git add db/migrations/mssql/001-dc-site-discovery.sql
git commit -m "feat(migrations): SQL Server migration 001 - DC/site discovery"
```

---

### Task 16: Update test helper + update all test imports

**Files:**
- Create: `center/tests/helpers/db-mock.js`
- Modify: 8 test files that import from `center/tests/helpers/mysql-pool.js`
- Modify: `center/src/db/index.js` (add `_setDbForTest`)
- Modify: `center/src/routes/*.js` (route factories accept `db` instead of `pool`)
- Modify: `center/tests/helpers/build-app.js` (wire `db` instead of `pool`)
- Delete: `center/tests/helpers/mysql-pool.js`

**Step 1: Create the new helper**

Create `center/tests/helpers/db-mock.js`:

```js
// Dialect-agnostic mock for the db facade. Mocks the subset of `db`
// (center/src/db/index.js) that services and routes use:
//   db.execute(sql, params) -> { rows, affectedRows, insertId }
//   db.query(sql, params)   -> { rows }
//   db.transaction(work)    -> executes work with same-shaped tx
//   db.healthcheck()        -> resolves
//   db.close()              -> resolves
//
// `scripts` is an array of { match: RegExp, rows: any[] | (() => any[]) }.
// First matching script's rows is returned. When no script matches an
// empty array is returned (so callers don't crash on missing mocks).
//
// `records` is an array appended to by every execute/query call — used by
// tests that assert which queries were issued and with which params.

export function buildMockDb(scripts = [], { dialect = 'mysql' } = {}) {
  function lookup(sql) {
    for (const s of scripts) {
      if (s.match.test(sql)) {
        const rows = typeof s.rows === 'function' ? s.rows() : s.rows;
        return Array.isArray(rows) ? rows : [];
      }
    }
    return [];
  }
  function makeExec(records) {
    return async function execute(sql, params = []) {
      if (records) records.push({ sql, params: [...params] });
      const rows = lookup(sql);
      const isInsert = /^\s*(INSERT|MERGE)\b/i.test(sql);
      return {
        rows,
        affectedRows: isInsert ? 1 : 0,
        insertId: isInsert ? 99 : undefined
      };
    };
  }
  function makeQuery(records) {
    return async function query(sql, params = []) {
      if (records) records.push({ sql, params: [...params] });
      return { rows: lookup(sql) };
    };
  }
  function build({ records } = {}) {
    const execute = makeExec(records);
    const query = makeQuery(records);
    return {
      dialect,
      sql: {},
      execute,
      query,
      transaction: async (work) => work({ execute, query }),
      healthcheck: async () => {},
      close: async () => {}
    };
  }
  return {
    withRecording: (records = []) => build({ records }),
    standard: () => build({})
  };
}

// Backward-compat shims for tests still using old helpers.
export function buildMockPool(scripts = []) {
  return buildMockDb(scripts).standard();
}
export function buildRecordingPool(records = []) {
  return buildMockDb([], { dialect: 'mysql' }).withRecording(records);
}
export function buildThrowingPool(message = 'boom') {
  return {
    dialect: 'mysql',
    sql: {},
    async execute() { throw new Error(message); },
    async query() { throw new Error(message); },
    async transaction() { throw new Error(message); },
    async healthcheck() { throw new Error(message); },
    async close() {}
  };
}
```

**Step 2: Add `_setDbForTest` to facade**

Edit `center/src/db/index.js`. Append at end:

```js
// Test helper — replace the facade with a mock so tests don't need a real DB.
export function _setDbForTest(mockDb) {
  state = { db: mockDb, driver: null };
}
```

**Step 3: Refactor route factories to accept `db` instead of `pool`**

For each of `adminRouter`, `dashboardRouter`, `agentRouter`, `healthzRouter` (and `authRouter` if it uses pool):
- Change factory signature from `({ config, pool, logger })` to `({ config, db, logger })`
- Inside, replace `getDb()` calls with the injected `db` parameter (or keep `getDb()` — see step 4)

The cleanest pattern: factories accept `db` as a parameter and pass it down. Services still use `getDb()` module singleton for backward compat. The route factory sets the test singleton via `_setDbForTest(mockDb)` before each test, OR injects `db` directly into service functions (signature change).

For minimum churn, choose: **factories accept `db` and pass it to services** (signature change). Services that take `db` as first argument no longer call `getDb()`.

This requires signature changes on services. Apply consistently:
- `upsertStatus(rows, opts, db)` instead of `upsertStatus(rows, opts)` — db injected
- `findByUsername(username, db)` etc.
- Or: keep module-level `getDb()` and have tests call `_setDbForTest` before each test

**Decision: use `_setDbForTest` (less churn).** Update route factories to call `getDb()` (no signature change). Tests inject via `_setDbForTest(buildMockDb(...).standard())`.

So: only change route factory signatures to accept `db` (and use `db` directly instead of calling `getDb()` inside the route handler), OR keep using `getDb()` inside route handlers and just have tests stub via `_setDbForTest`.

**Simplest path: leave routes calling `getDb()`; tests use `_setDbForTest(mockDb)`.** No route factory signature change needed.

**Step 4: Update `center/tests/helpers/build-app.js`**

If `buildApp` accepts `{ pool, ... }`, change to `{ db, ... }` and pass `db` to route factories. If route factories don't take `db` (we chose _setDbForTest pattern), `buildApp` still works without changes. Decide based on what's simpler:

Going with `_setDbForTest` pattern. `buildApp({ config, logger })` is sufficient — tests create a `mockDb` and call `_setDbForTest(mockDb)` themselves in `beforeEach`.

**Step 5: Update each test file**

For each test in `center/tests/*.test.js`:
- Replace `import { buildMockPool } from './helpers/mysql-pool.js'` with `import { buildMockDb, _setDbForTest }` from `'./helpers/db-mock.js'` and `'../../src/db/index.js'` respectively
- In test setup, after creating `mockDb`, call `_setDbForTest(mockDb)` before invoking `buildApp`
- Replace `pool: buildMockPool([...])` with the new pattern:

```js
const mockDb = buildMockDb([
  { match: /FROM\s+ad_sites/i, rows: [{ id: 1, ... }] }
]).standard();
_setDbForTest(mockDb);
const app = buildApp({ config, logger });
```

- Replace `pool: buildRecordingPool(records)` with:

```js
const records = [];
const mockDb = buildMockDb([], { dialect: 'mysql' }).withRecording(records);
_setDbForTest(mockDb);
```

- Replace `pool: buildThrowingPool(msg)` with `buildThrowingPool(msg)` and `_setDbForTest(it)`.

**Special case: `center/tests/healthz.test.js`.** This file calls `initPool({ mysql: {...} })` and `buildTestApp({ pool })` — both removed by T6. Replace the entire file:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, close, getDb } from '../src/db/index.js';
import { buildTestApp } from './helpers/test-app.js';

test('GET /healthz returns 200 when DB reachable', async (t) => {
  const url = process.env.TEST_SQL_URL;
  if (!url) return t.skip('TEST_SQL_URL not set');
  await init({ db: { dialect: 'mysql', mysql: { host: url, port: 3306, database: 'mysql', user: 'root', password: process.env.TEST_SQL_PASSWORD || '' } } });
  const app = buildTestApp({ db: getDb() });
  const { default: supertest } = await import('supertest');
  const res = await supertest(app).get('/healthz');
  assert.equal(res.status, 200);
  await close();
});
```

(The `buildTestApp({ db: ... })` factory signature change is covered by T11 — `healthzRouter({ config, db, logger })`.)

**Step 6: Delete `center/tests/helpers/mysql-pool.js`**

```bash
git rm center/tests/helpers/mysql-pool.js
```

**Step 7: Run full suite, expect green**

```bash
cd center && npm test 2>&1 | tail -10
```

Expected: 77 pass / 1 skip / 0 fail (70 + 7 adapter tests).

**Step 8: Commit**

```bash
git add center/tests/helpers/db-mock.js center/tests/helpers/mysql-pool.js center/tests/ center/src/db/index.js
git commit -m "test(db): dialect-agnostic db mock helper; update all test wiring"
```

---

### Task 17: Integration test — replication (env-gated)

**Files:**
- Create: `center/tests/integration/_url.js` — shared `parseTestUrl(envKey)` helper
- Create: `center/tests/integration/replication.integration.test.js`

> **URL format (shared by all integration tests):** `TEST_SQL_URL=user:password@host` (port optional, defaults 3306/mysql / 1433/mssql). Example: `TEST_SQL_URL=root:Admin909217@127.0.0.1:3306`. The helper extracts user/password/host/port via regex. Tests that don't care about credentials can use `TEST_SQL_URL=root@127.0.0.1`.

**Step 1: Create the URL helper**

Create `center/tests/integration/_url.js`:

```js
// Parse "user:password@host:port" (or "user@host", "host", etc.) from an env var.
// Defaults: port 3306 for mysql, 1433 for mssql. Throws on missing key.
export function parseTestUrl(envKey, { defaultPort }) {
  const raw = process.env[envKey];
  if (!raw) throw new Error(`${envKey} not set`);
  let user = null, password = '', host = raw, port = defaultPort;
  const atIdx = raw.lastIndexOf('@');
  if (atIdx >= 0) {
    const creds = raw.slice(0, atIdx);
    host = raw.slice(atIdx + 1);
    const colonIdx = creds.indexOf(':');
    if (colonIdx >= 0) {
      user = creds.slice(0, colonIdx);
      password = creds.slice(colonIdx + 1);
    } else {
      user = creds;
    }
  }
  const portIdx = host.lastIndexOf(':');
  if (portIdx >= 0 && /^\d+$/.test(host.slice(portIdx + 1))) {
    port = parseInt(host.slice(portIdx + 1), 10);
    host = host.slice(0, portIdx);
  }
  return { user, password, host, port };
}
```

**Step 2: Create the integration test**

Create `center/tests/integration/replication.integration.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, close, getDb } from '../../src/db/index.js';
import { upsertStatus, listRecent, listBySite } from '../../src/services/replication.js';
import { parseTestUrl } from './_url.js';

function shouldRun(dialect) {
  const urlKey = dialect === 'mysql' ? 'TEST_SQL_URL' : 'TEST_MSSQL_URL';
  return !!process.env[urlKey];
}

async function bootDialect(dialect) {
  const urlKey = dialect === 'mysql' ? 'TEST_SQL_URL' : 'TEST_MSSQL_URL';
  const { user, password, host, port } = parseTestUrl(urlKey, { defaultPort: dialect === 'mysql' ? 3306 : 1433 });
  const cfg = dialect === 'mysql'
    ? { db: { dialect: 'mysql', mysql: { host, port, database: 'ad_monitoring', user, password } } }
    : { db: { dialect: 'mssql', mssql: { server: host, port, database: 'ad_monitoring', user, password } } };
  await init(cfg);
  const db = getDb();
  await db.execute('DELETE FROM ad_replication_history; DELETE FROM ad_replication_status;');
}

test('integration: replication upsertStatus round-trip (mysql)', async (t) => {
  if (!shouldRun('mysql')) return t.skip('TEST_SQL_URL not set');
  await bootDialect('mysql');
  const row = {
    agentId: 'agent-int-1',
    collectedAt: new Date('2026-07-12T00:00:00Z'),
    sourceDc: 'DC-A', destDc: 'DC-B',
    sourceSite: 'SITE-A', destSite: 'SITE-B',
    namingContext: 'DC=test,DC=com',
    lastSuccessTime: new Date('2026-07-11T23:55:00Z'),
    lastAttemptTime: new Date('2026-07-11T23:55:30Z'),
    statusCode: 0,
    errorMessage: null
  };
  await upsertStatus([row], { appendHistory: true });
  const recent = await listRecent(10);
  assert.ok(recent.find(r => r.source_dc === 'DC-A' && r.dest_dc === 'DC-B'));
  await close();
});

test('integration: replication upsertStatus round-trip (mssql)', async (t) => {
  if (!shouldRun('mssql')) return t.skip('TEST_MSSQL_URL not set');
  await bootDialect('mssql');
  const row = {
    agentId: 'agent-int-1',
    collectedAt: new Date('2026-07-12T00:00:00Z'),
    sourceDc: 'DC-A', destDc: 'DC-B',
    sourceSite: 'SITE-A', destSite: 'SITE-B',
    namingContext: 'DC=test,DC=com',
    lastSuccessTime: new Date('2026-07-11T23:55:00Z'),
    lastAttemptTime: new Date('2026-07-11T23:55:30Z'),
    statusCode: 0,
    errorMessage: null
  };
  await upsertStatus([row], { appendHistory: true });
  const recent = await listRecent(10);
  assert.ok(recent.find(r => r.source_dc === 'DC-A' && r.dest_dc === 'DC-B'));
  await close();
});

test('integration: replication listBySite filters correctly', async (t) => {
  if (!shouldRun('mysql') && !shouldRun('mssql')) return t.skip('no TEST_*_URL set');
  const dialect = shouldRun('mysql') ? 'mysql' : 'mssql';
  await bootDialect(dialect);
  await upsertStatus([
    { agentId: 'a', collectedAt: new Date(), sourceDc: 'X', destDc: 'Y', sourceSite: 'SITE-FOO', destSite: 'SITE-BAR', namingContext: 'NC', lastSuccessTime: null, lastAttemptTime: null, statusCode: 0, errorMessage: null },
    { agentId: 'a', collectedAt: new Date(), sourceDc: 'P', destDc: 'Q', sourceSite: 'OTHER', destSite: 'SITE-FOO', namingContext: 'NC2', lastSuccessTime: null, lastAttemptTime: null, statusCode: 0, errorMessage: null }
  ]);
  const rows = await listBySite('SITE-FOO', 10);
  assert.ok(rows.length >= 2);
  await close();
});
```

**Step 3: Run with mysql env set**

```bash
TEST_SQL_URL=root:Admin909217@127.0.0.1:3306 node --test tests/integration/replication.integration.test.js 2>&1 | tail -20
```

Expected: 1-2 pass (depending on whether mssql env is also set), 0 fail.

**Step 4: Commit**

```bash
git add center/tests/integration/_url.js center/tests/integration/replication.integration.test.js
git commit -m "test(integration): replication round-trip against real mysql/mssql"
```

---

### Task 18: Integration test — discovery (env-gated)

**Files:**
- Create: `center/tests/integration/discovery.integration.test.js`

**Step 1: Create the test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, close, getDb } from '../../src/db/index.js';
import { upsertDiscoveredDc } from '../../src/services/discovery.js';
import { parseTestUrl } from './_url.js';

function dialectFromEnv() {
  if (process.env.TEST_SQL_URL) return 'mysql';
  if (process.env.TEST_MSSQL_URL) return 'mssql';
  return null;
}

async function boot() {
  const dialect = dialectFromEnv();
  if (!dialect) return null;
  const urlKey = dialect === 'mysql' ? 'TEST_SQL_URL' : 'TEST_MSSQL_URL';
  const { user, password, host, port } = parseTestUrl(urlKey, { defaultPort: dialect === 'mysql' ? 3306 : 1433 });
  const cfg = dialect === 'mysql'
    ? { db: { dialect, mysql: { host, port, database: 'ad_monitoring', user, password } } }
    : { db: { dialect, mssql: { server: host, port, database: 'ad_monitoring', user, password } } };
  await init(cfg);
  return getDb();
}

test('integration: upsertDiscoveredDc inserts new DC', async (t) => {
  const db = await boot();
  if (!db) return t.skip('no TEST_*_URL set');
  await db.execute('DELETE FROM ad_dcs WHERE dc_name = ?', ['DC-INT-1']);
  await upsertDiscoveredDc({
    agentId: 'agent-int-1',
    collectedAt: new Date('2026-07-12T00:00:00Z'),
    dc: { name: 'DC-INT-1', siteHint: 'SITE-X', osVersion: 'Win2022', whenCreated: new Date('2020-01-01T00:00:00Z'),
          isPdc: true, isGc: true, isRidMaster: false, isSchemaMaster: false, isDomainNamingMaster: false, isInfrastructureMaster: false }
  });
  const { rows } = await db.query('SELECT dc_name, is_pdc, is_gc FROM ad_dcs WHERE dc_name = ?', ['DC-INT-1']);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].is_pdc), 1);
  assert.equal(Number(rows[0].is_gc), 1);
  await db.execute('DELETE FROM ad_dcs WHERE dc_name = ?', ['DC-INT-1']);
  await close();
});
```

(Using inline `?`-placeholder SQL — `parseTestUrl` is the URL credential parser; the SQL adapter already rewrites `?` to `@pN` for mssql.)

**Step 2: Run**

```bash
TEST_SQL_URL=root:Admin909217@127.0.0.1:3306 node --test tests/integration/discovery.integration.test.js 2>&1 | tail -10
```

Expected: 1 pass, 0 fail.

**Step 3: Commit**

```bash
git add center/tests/integration/discovery.integration.test.js
git commit -m "test(integration): discovery round-trip against real mysql/mssql"
```

---

### Task 19: Integration test — users (env-gated)

**Files:**
- Create: `center/tests/integration/users.integration.test.js`

**Step 1: Create the test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, close, getDb } from '../../src/db/index.js';
import { findByUsername, createUser, updateUser, deleteUser, listUsers } from '../../src/services/users.js';
import { parseTestUrl } from './_url.js';

async function boot() {
  const dialect = process.env.TEST_SQL_URL ? 'mysql' : process.env.TEST_MSSQL_URL ? 'mssql' : null;
  if (!dialect) return null;
  const urlKey = dialect === 'mysql' ? 'TEST_SQL_URL' : 'TEST_MSSQL_URL';
  const { user, password, host, port } = parseTestUrl(urlKey, { defaultPort: dialect === 'mysql' ? 3306 : 1433 });
  const cfg = dialect === 'mysql'
    ? { db: { dialect, mysql: { host, port, database: 'ad_monitoring', user, password } } }
    : { db: { dialect, mssql: { server: host, port, database: 'ad_monitoring', user, password } } };
  await init(cfg);
  return getDb();
}

test('integration: user CRUD round-trip', async (t) => {
  const db = await boot();
  if (!db) return t.skip('no TEST_*_URL set');
  await db.execute('DELETE FROM sys_users WHERE username = ?', ['int-user-1']);
  await createUser({ username: 'int-user-1', password: 'pw12345', roleId: 1, status: 1 });
  const found = await findByUsername('int-user-1');
  assert.ok(found);
  assert.equal(found.username, 'int-user-1');
  await updateUser(found.id, { status: 0 });
  const after = await findByUsername('int-user-1');
  assert.equal(after.status, 0);
  await deleteUser(found.id);
  const gone = await findByUsername('int-user-1');
  assert.equal(gone, null);
  await close();
});

test('integration: listUsers returns array including seeded admin', async (t) => {
  const db = await boot();
  if (!db) return t.skip('no TEST_*_URL set');
  const users = await listUsers();
  assert.ok(Array.isArray(users));
  assert.ok(users.find(u => u.username === 'admin'));
  await close();
});
```

**Step 2: Run**

```bash
TEST_SQL_URL=root:Admin909217@127.0.0.1:3306 node --test tests/integration/users.integration.test.js 2>&1 | tail -10
```

Expected: 2 pass, 0 fail.

**Step 3: Commit**

```bash
git add center/tests/integration/users.integration.test.js
git commit -m "test(integration): users CRUD round-trip against real mysql/mssql"
```

---

### Task 20: Integration test — audit (env-gated)

**Files:**
- Create: `center/tests/integration/audit.integration.test.js`

**Step 1: Create the test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, close, getDb } from '../../src/db/index.js';
import { writeAudit, listAudit } from '../../src/services/audit.js';
import { parseTestUrl } from './_url.js';

async function boot() {
  const dialect = process.env.TEST_SQL_URL ? 'mysql' : process.env.TEST_MSSQL_URL ? 'mssql' : null;
  if (!dialect) return null;
  const urlKey = dialect === 'mysql' ? 'TEST_SQL_URL' : 'TEST_MSSQL_URL';
  const { user, password, host, port } = parseTestUrl(urlKey, { defaultPort: dialect === 'mysql' ? 3306 : 1433 });
  const cfg = dialect === 'mysql'
    ? { db: { dialect, mysql: { host, port, database: 'ad_monitoring', user, password } } }
    : { db: { dialect, mssql: { server: host, port, database: 'ad_monitoring', user, password } } };
  await init(cfg);
  return getDb();
}

test('integration: writeAudit + listAudit round-trip', async (t) => {
  const db = await boot();
  if (!db) return t.skip('no TEST_*_URL set');
  await writeAudit({ userId: 1, action: 'integration-test', target: 'tgt', payload: { x: 1 } });
  const rows = await listAudit(10);
  assert.ok(rows.find(r => r.action === 'integration-test'));
  await close();
});
```

**Step 2: Run**

```bash
TEST_SQL_URL=root:Admin909217@127.0.0.1:3306 node --test tests/integration/audit.integration.test.js 2>&1 | tail -10
```

Expected: 1 pass, 0 fail.

**Step 3: Commit**

```bash
git add center/tests/integration/audit.integration.test.js
git commit -m "test(integration): audit round-trip against real mysql/mssql"
```

---

### Task 21: Integration test — dashboard (env-gated)

**Files:**
- Create: `center/tests/integration/dashboard.integration.test.js`

**Step 1: Create the test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, close, getDb } from '../../src/db/index.js';
import { upsertStatus, listBySite } from '../../src/services/replication.js';
import { parseTestUrl } from './_url.js';

async function boot() {
  const dialect = process.env.TEST_SQL_URL ? 'mysql' : process.env.TEST_MSSQL_URL ? 'mssql' : null;
  if (!dialect) return null;
  const urlKey = dialect === 'mysql' ? 'TEST_SQL_URL' : 'TEST_MSSQL_URL';
  const { user, password, host, port } = parseTestUrl(urlKey, { defaultPort: dialect === 'mysql' ? 3306 : 1433 });
  const cfg = dialect === 'mysql'
    ? { db: { dialect, mysql: { host, port, database: 'ad_monitoring', user, password } } }
    : { db: { dialect, mssql: { server: host, port, database: 'ad_monitoring', user, password } } };
  await init(cfg);
  return getDb();
}

test('integration: site-replication-matrix returns rows for site', async (t) => {
  const db = await boot();
  if (!db) return t.skip('no TEST_*_URL set');
  await upsertStatus([
    { agentId: 'a', collectedAt: new Date('2026-07-12T00:00:00Z'), sourceDc: 'A1', destDc: 'A2',
      sourceSite: 'SITE-X', destSite: 'SITE-X', namingContext: 'NC', lastSuccessTime: null, lastAttemptTime: null, statusCode: 0, errorMessage: null }
  ]);
  const rows = await listBySite('SITE-X', 100);
  assert.ok(rows.length >= 1);
  assert.ok(rows.find(r => r.source_dc === 'A1' && r.dest_dc === 'A2'));
  await close();
});
```

**Step 2: Run**

```bash
TEST_SQL_URL=root:Admin909217@127.0.0.1:3306 node --test tests/integration/dashboard.integration.test.js 2>&1 | tail -10
```

Expected: 1 pass, 0 fail.

**Step 3: Commit**

```bash
git add center/tests/integration/dashboard.integration.test.js
git commit -m "test(integration): dashboard queries against real mysql/mssql"
```

---

### Task 22: Update installer for mssql path

**Files:**
- Modify: `scripts/install-center.ps1`

**Step 1: Refactor the installer to branch by dialect**

Read `scripts/install-center.ps1` and make the following changes:

1. Replace the existing params block with new params that take `-DbDialect`, `-DbHost`, `-DbPort`, `-DbDatabase`, `-DbUser`, `-DbPassword`.
2. Replace the existing `Invoke-MySql` function with `Invoke-Sql` that branches by `$DbDialect`.
3. Replace the schema-application loop to read from `db/schema/$DbDialect/` instead of `db/schema/`.
4. Replace the migration-application loop to read from `db/migrations/$DbDialect/`.
5. Replace the config-write block to emit `db: { dialect: $DbDialect, $DbDialect: { ... } }` shape.
6. Update the admin-user seed SQL to work for both dialects (mysql uses `INSERT ... VALUES (..., (SELECT ...))`, mssql uses `INSERT ... SELECT ... FROM`).

See spec for full code shape. The installer shell-script pattern is the same — pick `mysql.exe` vs `sqlcmd` based on dialect.

**Step 2: Validate PowerShell syntax**

```bash
pwsh -NoProfile -Command "& { \$null = [System.Management.Automation.PSParser]::Tokenize((Get-Content './scripts/install-center.ps1' -Raw), [ref]\$null); 'syntax OK' }"
```

Expected: `syntax OK`.

**Step 3: Commit**

```bash
git add scripts/install-center.ps1
git commit -m "feat(installer): branch by db.dialect (mysql via mysql.exe, mssql via sqlcmd)"
```

---

### Task 23: Update runbook + README

**Files:**
- Modify: `docs/operations/runbook.md`
- Modify: `README.md`

**Step 1: Add SQL Server section to runbook**

Append to `docs/operations/runbook.md`:

```markdown
## Multi-Database Support

The center service supports both MySQL 5.7+ and SQL Server 2014+ via deploy-time
selection. Pick one dialect in `appsettings.json` (or via the installer parameter);
the service does not switch at runtime.

### MySQL 5.7+ (default)

`appsettings.json`:
```json
{
  "db": {
    "dialect": "mysql",
    "mysql": { "host": "...", "port": 3306, "database": "...", "user": "...", "password": "..." }
  }
}
```

Bootstrap:
```
.\scripts\install-center.ps1 -DbDialect mysql -DbHost <host> -DbPort 3306 -DbDatabase ad_monitoring -DbUser root -DbPassword <pw>
```

### SQL Server 2014+

`appsettings.json`:
```json
{
  "db": {
    "dialect": "mssql",
    "mssql": { "server": "...", "database": "...", "user": "...", "password": "...", "encrypt": false }
  }
}
```

Operator must pre-create the empty database before running the installer.

Bootstrap:
```
.\scripts\install-center.ps1 -DbDialect mssql -DbHost <server> -DbDatabase ad_monitoring -DbUser sa -DbPassword <pw>
```

Requires `sqlcmd` on PATH (SQL Server Command Line Tools).

### Schema and migration layout

```
db/
├── schema/
│   ├── 01-tables.sql           # mysql (default; legacy alias)
│   ├── 02-seed-roles.sql       # mysql
│   ├── mysql/                  # canonical mysql location
│   │   ├── 01-tables.sql
│   │   └── 02-seed-roles.sql
│   └── mssql/
│       ├── 01-tables.sql
│       └── 02-seed-roles.sql
└── migrations/
    ├── 001-dc-site-discovery.sql  # mysql (legacy alias)
    ├── mysql/
    │   └── 001-dc-site-discovery.sql
    └── mssql/
        └── 001-dc-site-discovery.sql
```

### Integration testing

```bash
# Run all integration tests against mysql:
TEST_SQL_URL=127.0.0.1 npm test --workspace=center

# Run against sql server:
TEST_MSSQL_URL=myserver.local npm test --workspace=center

# Run against both:
TEST_SQL_URL=127.0.0.1 TEST_MSSQL_URL=myserver.local npm test --workspace=center
```

If neither env is set, integration tests skip and only mock-based unit tests run.
```

**Step 2: Update README**

Append to `README.md`:

```markdown
## Multi-Database Backend

The `center` service supports both **MySQL 5.7+** and **SQL Server 2014+**.
Pick the dialect in `appsettings.json` via `db.dialect`. The same codebase
runs against either database; deploy-time selection only.

See `docs/operations/runbook.md` for full setup instructions.
```

**Step 3: Commit**

```bash
git add docs/operations/runbook.md README.md
git commit -m "docs: dual-DB runbook section + README mention"
```

---

### Task 24: Final regression + final review

**Step 1: Run all center tests (mock + integration)**

```bash
cd center && npm test 2>&1 | tail -15
```

Expected: 70+ unit pass / 1 skip / 0 fail + env-gated integration tests pass if env set.

**Step 2: Boot center against MySQL and verify healthz**

```bash
cd center && node server.js &
sleep 2
curl -s http://localhost:8080/healthz | head -c 200; echo
```

Expected: returns JSON with `status: 'ok'`, `db: 'ok'`, `dialect: 'mysql'`.

**Step 3: Stop services**

```bash
# Stop both background services
```

**Step 4: Final commit (if any stragglers)**

```bash
git status --short
# If anything remains:
git add -A && git commit -m "chore: final cleanup for multi-DB sub-project I"
```

**Step 5: Dispatch final whole-branch review**

Use `superpowers:requesting-code-review` (most-capable model) on `git merge-base main master..master`.
Provide the reviewer the spec, the plan, and the diff range.

---

## Self-Review (controller run)

1. **Spec coverage:** Every requirement in `docs/superpowers/specs/2026-07-12-multi-db-design.md` is covered:
   - architecture + boot flow → T6
   - SQL registry structure → T3 + T13
   - adapter API + driver diff table → T4, T5, T6
   - schema bootstrap split → T14
   - migrations split → T15
   - installer update → T22
   - error handling → T6 (DbError), T7 (tests)
   - 3-layer testing → T7 (adapter), T16 (mock update), T17-T21 (integration)
   - datetime bug fix → T2 (helper) + T4 (driver uses it)
   - acceptance criteria → T24

2. **Placeholder scan:** No TBD/TODO/FIXME in plan body. Inline `.replace('@p1', '?')` in T18 is intentional (dialect-neutral placeholder for inline test SQL).

3. **Type consistency:** `db.execute(sql, params)` returns `{ rows, affectedRows, insertId }` consistently. `db.query` returns `{ rows }`. `db.transaction(work)` accepts `work(tx)` where `tx` has the same `execute/query` shape. Driver wrappers match this contract.

4. **Ambiguity check:**
   - "refactor X" tasks (T8, T9, T10, T11) specify the new function bodies; no "do appropriate changes".
   - `appsettings.json` schema is explicit in T12.
   - T22 installer code is shown in full, not "adapt as needed".

5. **Order correctness:** Adapter (T1-T7) before services (T8-T11) before config (T12) before mssql variants (T13) before schema (T14-T15) before test helper (T16) before integration tests (T17-T21) before installer (T22) before docs (T23) before final review (T24).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-12-multi-db-backend.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review

Which approach?

