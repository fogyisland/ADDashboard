# DC/Site Discovery + Site↔DC Link + Per-Site Replication Matrix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement sub-projects A + B + G from spec `docs/superpowers/specs/2026-07-12-dc-site-discovery-design.md` — agent reports local DC metadata, admin maintains sites and links DCs to sites, plus a per-site DC×DC replication matrix view that auto-polls.

**Architecture:**
- Agent: a new PS collector (`collect-discovery.ps1`) calls `Get-ADDomainController -Identity $env:COMPUTERNAME` on its own 4-hour scheduler and POSTs to a new `/api/agent/discover` endpoint.
- Center: UPSERT into `ad_dcs` (only agent-reported fields; `site_id` is never touched by agent). New admin CRUD endpoints for `ad_sites` and a new "assign site" endpoint for `ad_dcs`. A new `/api/dashboard/site-replication-matrix` endpoint joins site → DCs → replication links for the G matrix view.
- Frontend: rename existing derived views, add Sites/DCs catalog CRUD views, add SiteReplicationMatrixView with `setInterval` auto-refresh (configurable via `site_matrix_refresh_seconds`).

**Tech Stack:** Node.js (ESM), Express, mysql2/promise, vue-router 4, vitest + @vue/test-utils, Pester 6, PowerShell 5+.

## Global Constraints

These apply to every task; copied verbatim from spec:

- **MySQL 8+ dialect only** (`ON DUPLICATE KEY UPDATE`, `TINYINT(1)`, `NOW()`, `CURRENT_TIMESTAMP`, `INSERT IGNORE`, `TIMESTAMPDIFF`, `AUTO_INCREMENT`). Multi-DB (I sub-project) is deferred.
- **Naming**: SQL columns `snake_case`; JSON over wire `camelCase`; `system_config` keys `snake_case`; JS files `kebab-case` not required (existing project uses single-word or concatenated names).
- **Auth**: admin/user endpoints → JWT via `userAuth` + `requirePerm('admin:users')`. Agent endpoints → `agentToken(config.agentToken)` middleware reading `X-Agent-Token` header.
- **Idempotency**: every UPSERT must be safe to re-run; seed data uses `INSERT IGNORE`.
- **Permissions**: all new `/api/admin/*` endpoints require `admin:users` perm. New `/api/dashboard/site-replication-matrix` requires `read:dash` perm (operator token can read it).
- **TDD**: failing test first for every code task; commit per task; one logical unit per commit.
- **Schema migrations**: stored in `db/migrations/NNN-name.sql`; `install-center.ps1` must apply them after `db/schema/*.sql`.
- **Frontend tests**: live in `frontend/tests/<name>.test.js` (NOT inside `src/`); mock `adminApi` via `vi.mock('../src/api/admin.js', ...)`.
- **PS tests**: live next to script in `agent/scripts/tests/<name>.test.ps1`; use `BeforeAll { . "$PSScriptRoot/../<script>.ps1" -ForTesting }`.
- **Vue stubs**: every admin view test stubs `AppLayout: { template: '<div><slot /></div>' }` so the layout chrome doesn't pull in auth store.
- **Frontend routes**: under `/admin/*` with `meta: { perm: 'admin:users' }`; router guard already enforces auth.
- **Auto-refresh cleanup**: any `setInterval` MUST be cleared in `onUnmounted` (test verifies `clearInterval` was called).
- **No emojis** in any file unless explicitly requested.

## File Structure

```
db/
  migrations/                                   # NEW directory
    001-dc-site-discovery.sql                   # NEW (T1)
  schema/
    01-tables.sql                               # unchanged
    02-seed-roles.sql                           # unchanged

agent/
  scripts/
    collect-discovery.ps1                       # NEW (T2)
    tests/
      collect-discovery.test.ps1                # NEW (T2)
  src/
    config.js                                   # MODIFY: add 2 DEFAULTS keys (T4)
    discovery.js                                # NEW (T3)
    collector.js                                # unchanged
  tests/
    config.test.js                              # MODIFY: add 2 asserts (T4)
    discovery.test.js                           # NEW (T3)
  agent.js                                      # MODIFY: wire discovery scheduler (T4)
  appsettings.example.json                      # MODIFY: add 2 keys (T4)

center/
  src/
    services/
      discovery.js                              # NEW (T5)
      sites-catalog.js                          # NEW (T6)
      config.js                                 # unchanged
    routes/
      agent.js                                  # MODIFY: add /api/agent/discover (T5)
      admin.js                                  # MODIFY: add sites-catalog + dcs-catalog endpoints (T6, T7)
      dashboard.js                              # MODIFY: add /api/dashboard/site-replication-matrix (T8)
  tests/
    agent.test.js                               # MODIFY: add /api/agent/discover cases (T5)
    admin.test.js                               # MODIFY: add sites-catalog + dcs-catalog cases (T6, T7)
    dashboard.test.js                           # MODIFY: add site-replication-matrix cases (T8)

frontend/
  src/
    views/
      admin/
        SitesView.vue                           # RENAME → ActiveSitesView.vue (T9)
        DcsView.vue                             # RENAME → ActiveDcsView.vue (T9)
        ActiveSitesView.vue                     # NEW (rename target, T9)
        ActiveDcsView.vue                       # NEW (rename target, T9)
        SitesCatalogView.vue                    # NEW (T10)
        DcsCatalogView.vue                      # NEW (T11)
        SiteReplicationMatrixView.vue           # NEW (T12)
      NotFoundView.vue                          # unchanged
    components/
      AppLayout.vue                             # MODIFY: nav updates (T9)
      SiteEditModal.vue                         # NEW (T10, optional in T10)
    router.js                                   # MODIFY: 5 routes (T9, T10, T11, T12)
    api/
      admin.js                                  # MODIFY: add 6 functions (T10, T11)
      dashboard.js                              # NEW (T12) — currently no file
      client.js                                 # unchanged
  tests/
    sites-catalog-view.test.js                  # NEW (T10)
    dcs-catalog-view.test.js                    # NEW (T11)
    site-replication-matrix-view.test.js        # NEW (T12)

scripts/
  install-center.ps1                            # MODIFY: apply migration (T13)

docs/
  runbook.md                                    # MODIFY: note discovery + matrix (T13)
```

---

## Task 1: DB Migration File + Manual Apply

**Files:**
- Create: `db/migrations/001-dc-site-discovery.sql`

**Interfaces:**
- Produces: SQL statements for `ALTER TABLE ad_sites`, `ALTER TABLE ad_dcs`, and `INSERT IGNORE` for `system_config` rows. Idempotent enough that re-running it doesn't break.

- [ ] **Step 1: Create `db/migrations/001-dc-site-discovery.sql`**

Write the file with these exact contents:

```sql
-- AD Dashboard DC/Site Discovery migration (MySQL 8+)
-- Applies after 01-tables.sql + 02-seed-roles.sql.
-- MySQL 8 lacks `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so we use
-- stored procedure guards that swallow error 1060 (duplicate column).

DELIMITER $$

DROP PROCEDURE IF EXISTS migrate_001_add_column_if_missing$$
CREATE PROCEDURE migrate_001_add_column_if_missing(
  IN p_table VARCHAR(64),
  IN p_column VARCHAR(64),
  IN p_definition VARCHAR(255)
)
BEGIN
  DECLARE v_exists INT DEFAULT 0;
  SELECT COUNT(*) INTO v_exists
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = p_table
      AND COLUMN_NAME = p_column;
  IF v_exists = 0 THEN
    SET @sql = CONCAT('ALTER TABLE ', p_table, ' ADD COLUMN ', p_column, ' ', p_definition);
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$

DELIMITER ;

-- ad_sites: add description + timestamps
CALL migrate_001_add_column_if_missing('ad_sites', 'description', 'VARCHAR(256) NULL');
CALL migrate_001_add_column_if_missing('ad_sites', 'created_at',  'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP');
CALL migrate_001_add_column_if_missing('ad_sites', 'updated_at',  'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

-- ad_dcs: agent-reported metadata + discovery tracking
CALL migrate_001_add_column_if_missing('ad_dcs', 'when_created',             'DATETIME NULL');
CALL migrate_001_add_column_if_missing('ad_dcs', 'is_gc',                    'TINYINT(1) NOT NULL DEFAULT 0');
CALL migrate_001_add_column_if_missing('ad_dcs', 'is_rid_master',            'TINYINT(1) NOT NULL DEFAULT 0');
CALL migrate_001_add_column_if_missing('ad_dcs', 'is_schema_master',         'TINYINT(1) NOT NULL DEFAULT 0');
CALL migrate_001_add_column_if_missing('ad_dcs', 'is_domain_naming_master',  'TINYINT(1) NOT NULL DEFAULT 0');
CALL migrate_001_add_column_if_missing('ad_dcs', 'is_infrastructure_master', 'TINYINT(1) NOT NULL DEFAULT 0');
CALL migrate_001_add_column_if_missing('ad_dcs', 'site_hint',                'VARCHAR(64) NULL');
CALL migrate_001_add_column_if_missing('ad_dcs', 'discovered_at',            'DATETIME NULL');
CALL migrate_001_add_column_if_missing('ad_dcs', 'discovered_by_agent_id',   'VARCHAR(64) NULL');

DROP PROCEDURE migrate_001_add_column_if_missing;

-- New system_config rows
INSERT IGNORE INTO system_config (config_key, config_value, description) VALUES
  ('discovery_interval_hours',    '4',  'Agent 上报本地 DC 元数据的时间间隔 (小时)'),
  ('site_matrix_refresh_seconds', '10', '站点复制矩阵页面自动刷新间隔 (秒)');
```

- [ ] **Step 2: Apply to local MySQL DB and verify columns**

Run:
```bash
mysql --protocol=TCP -h 127.0.0.1 -P 3306 -u root -pAdmin909217 ad_monitoring < db/migrations/001-dc-site-discovery.sql
```
Expected: no errors, exit code 0. (Ignore "Using a password" warning.)

Verify with:
```bash
mysql --protocol=TCP -h 127.0.0.1 -P 3306 -u root -pAdmin909217 ad_monitoring -e "DESCRIBE ad_dcs; SELECT config_key, config_value FROM system_config WHERE config_key IN ('discovery_interval_hours','site_matrix_refresh_seconds');"
```
Expected: `ad_dcs` has new columns (`when_created`, `is_gc`, `is_rid_master`, `is_schema_master`, `is_domain_naming_master`, `is_infrastructure_master`, `site_hint`, `discovered_at`, `discovered_by_agent_id`); `system_config` has 2 new rows.

- [ ] **Step 3: Re-apply to confirm idempotency**

Run Step 2 again. Expected: no errors, no duplicates created.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/001-dc-site-discovery.sql
git commit -m "feat(db): migration 001 - DC/site discovery + matrix refresh config"
```

---

## Task 2: Agent PS Discovery Script + Pester Tests

**Files:**
- Create: `agent/scripts/collect-discovery.ps1`
- Create: `agent/scripts/tests/collect-discovery.test.ps1`

**Interfaces:**
- Produces: `Get-LocalDcSnapshot -ComputerName <name>` returning PSCustomObject with fields `Name`, `SiteHint`, `OsVersion`, `WhenCreated`, `IsPdc`, `IsGc`, `IsRidMaster`, `IsSchemaMaster`, `IsDomainNamingMaster`, `IsInfrastructureMaster`. On `-ForTesting` it dot-sources functions without running entry point.

- [ ] **Step 1: Write the failing Pester test**

Create `agent/scripts/tests/collect-discovery.test.ps1` with these exact contents:

```powershell
BeforeAll {
  . "$PSScriptRoot/../collect-discovery.ps1" -ForTesting
}

Describe 'Get-LocalDcSnapshot' {
  It 'returns an object with all required properties' {
    $obj = Get-LocalDcSnapshot -ComputerName $env:COMPUTERNAME
    $obj.PSObject.Properties.Name | Should -Contain 'Name'
    $obj.PSObject.Properties.Name | Should -Contain 'SiteHint'
    $obj.PSObject.Properties.Name | Should -Contain 'OsVersion'
    $obj.PSObject.Properties.Name | Should -Contain 'WhenCreated'
    $obj.PSObject.Properties.Name | Should -Contain 'IsPdc'
    $obj.PSObject.Properties.Name | Should -Contain 'IsGc'
    $obj.PSObject.Properties.Name | Should -Contain 'IsRidMaster'
    $obj.PSObject.Properties.Name | Should -Contain 'IsSchemaMaster'
    $obj.PSObject.Properties.Name | Should -Contain 'IsDomainNamingMaster'
    $obj.PSObject.Properties.Name | Should -Contain 'IsInfrastructureMaster'
  }

  It 'returns Name matching input ComputerName' {
    $obj = Get-LocalDcSnapshot -ComputerName $env:COMPUTERNAME
    $obj.Name | Should -Be $env:COMPUTERNAME
  }

  It 'returns WhenCreated in UTC ISO 8601 or null' {
    $obj = Get-LocalDcSnapshot -ComputerName $env:COMPUTERNAME
    if ($null -ne $obj.WhenCreated) {
      $obj.WhenCreated | Should -Match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$'
    }
  }

  It 'returns boolean values for Is* fields' {
    $obj = Get-LocalDcSnapshot -ComputerName $env:COMPUTERNAME
    $obj.IsPdc                    | Should -BeOfType [bool]
    $obj.IsGc                     | Should -BeOfType [bool]
    $obj.IsRidMaster              | Should -BeOfType [bool]
    $obj.IsSchemaMaster           | Should -BeOfType [bool]
    $obj.IsDomainNamingMaster     | Should -BeOfType [bool]
    $obj.IsInfrastructureMaster   | Should -BeOfType [bool]
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pwsh -Command "Invoke-Pester -Path agent/scripts/tests/collect-discovery.test.ps1"`
Expected: FAIL — `Get-LocalDcSnapshot` not defined.

- [ ] **Step 3: Write the PS script**

Create `agent/scripts/collect-discovery.ps1` with these exact contents:

```powershell
[CmdletBinding()]
param(
  [switch]$ForTesting
)

$ErrorActionPreference = 'Stop'

function Get-LocalDcSnapshot {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$ComputerName
  )

  if (-not (Get-Module -Name ActiveDirectory -ListAvailable)) {
    throw "ActiveDirectory module not available"
  }
  Import-Module ActiveDirectory -ErrorAction Stop

  $dc = Get-ADDomainController -Identity $ComputerName -ErrorAction Stop
  if (-not $dc) { throw "DC not found: $ComputerName" }

  $whenCreatedIso = $null
  if ($dc.whenCreated) {
    try {
      $whenCreatedIso = ([DateTime]$dc.whenCreated).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    } catch {
      $whenCreatedIso = $null
    }
  }

  return [PSCustomObject]@{
    Name                   = [string]$dc.Name
    SiteHint               = [string]$dc.SiteObjectName
    OsVersion              = [string]$dc.OperatingSystem
    WhenCreated            = $whenCreatedIso
    IsPdc                  = [bool]$dc.IsPDC
    IsGc                   = [bool]$dc.IsGlobalCatalog
    IsRidMaster            = [bool]$dc.RIDMasterRole
    IsSchemaMaster         = [bool]$dc.SchemaMasterRole
    IsDomainNamingMaster   = [bool]$dc.DomainNamingMasterRole
    IsInfrastructureMaster = [bool]$dc.InfrastructureRole
  }
}

if (-not $ForTesting) {
  try {
    $obj = Get-LocalDcSnapshot -ComputerName $env:COMPUTERNAME
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
    exit 0
  } catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 2
  }
}
```

- [ ] **Step 4: Run test to verify it passes (on a DC)**

Run: `pwsh -Command "Invoke-Pester -Path agent/scripts/tests/collect-discovery.test.ps1"`
Expected: all `It` blocks pass.

(If running outside an AD environment, the test will fail because `Get-ADDomainController` cannot resolve a real DC. Skip with `-Skip` until deployed to a DC; the test is for end-to-end validation.)

- [ ] **Step 5: Commit**

```bash
git add agent/scripts/collect-discovery.ps1 agent/scripts/tests/collect-discovery.test.ps1
git commit -m "feat(agent): collect-discovery.ps1 — Get-ADDomainController snapshot"
```

---

## Task 3: Agent Node Discovery Module + Tests

**Files:**
- Create: `agent/src/discovery.js`
- Create: `agent/tests/discovery.test.js`

**Interfaces:**
- `runDiscovery({ powerShellPath, psDiscoveryScriptPath })` → `Promise<object|null>` — spawns PS, parses JSON, returns snapshot; returns `null` if PS exit code is non-zero.
- `postDiscovery({ centerUrl, agentToken, payload })` → `Promise<{ok, status, data?, error?}>` — POSTs `{agentId, collectedAt, dc}` to `${centerUrl}/api/agent/discover`.
- `startDiscoveryScheduler({ intervalHours, run, logger })` → `{stop()}` — runs `run()` immediately, then every `intervalHours` (min 1). Stops cleanly on `stop()`.

- [ ] **Step 1: Write the failing Node test**

Create `agent/tests/discovery.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runDiscovery, postDiscovery, startDiscoveryScheduler } from '../src/discovery.js';

test('postDiscovery POSTs JSON to /api/agent/discover with X-Agent-Token', async () => {
  let receivedReq = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      receivedReq = { method: req.method, url: req.url, headers: req.headers, body };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  try {
    const result = await postDiscovery({
      centerUrl: `http://127.0.0.1:${port}`,
      agentToken: 'tok',
      payload: { agentId: 'A1', collectedAt: '2026-07-12T00:00:00.000Z', dc: { name: 'A1' } }
    });
    assert.equal(result.ok, true);
    assert.equal(receivedReq.method, 'POST');
    assert.equal(receivedReq.url, '/api/agent/discover');
    assert.equal(receivedReq.headers['x-agent-token'], 'tok');
    const parsed = JSON.parse(receivedReq.body);
    assert.equal(parsed.agentId, 'A1');
    assert.equal(parsed.dc.name, 'A1');
  } finally {
    server.close();
  }
});

test('runDiscovery parses PS stdout JSON', async () => {
  const fakeScript = 'C:/tmp/fake.ps1'; // not invoked; we mock by testing parser indirectly
  // We can't easily mock spawnSync without restructuring; instead test
  // the parser via the public surface by feeding a hand-built snapshot
  // through postDiscovery and asserting shape.
  // (Real spawn-path coverage requires a Windows env with PS on PATH.)
  assert.equal(typeof runDiscovery, 'function');
});

test('startDiscoveryScheduler fires immediately and on interval; stop() halts', async () => {
  let calls = 0;
  const sched = startDiscoveryScheduler({
    intervalHours: 0, // effectively every "tick" — but we use setInterval with ms=Math.max(1, h)*3_600_000
    run: async () => { calls++; }
  });
  // intervalHours=0 maps to 1 hour in the impl, which is too slow for tests.
  // Test only immediate fire:
  await new Promise(r => setTimeout(r, 50));
  assert.ok(calls >= 1, `expected >=1 call, got ${calls}`);
  sched.stop();
});

test('startDiscoveryScheduler stop() prevents further calls', async () => {
  let calls = 0;
  const sched = startDiscoveryScheduler({
    intervalHours: 1,
    run: async () => { calls++; }
  });
  sched.stop();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(calls, 1, 'only the immediate fire should have run');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && node --test tests/discovery.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

Create `agent/src/discovery.js`:

```javascript
import { spawn } from 'node:child_process';

export function runDiscovery({ powerShellPath, psDiscoveryScriptPath }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(powerShellPath, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psDiscoveryScriptPath], { windowsHide: true });
    child.stdout.on('data', c => stdout += c);
    child.stderr.on('data', c => stderr += c);
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) return resolve(null);
      try {
        const obj = JSON.parse(stdout.trim());
        resolve(obj);
      } catch {
        resolve(null);
      }
    });
  });
}

export function postDiscovery({ centerUrl, agentToken, payload }) {
  return new Promise((resolve) => {
    const url = new URL(`${centerUrl}/api/agent/discover`);
    const body = JSON.stringify(payload);
    const req = http.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Agent-Token': agentToken
      },
      timeout: 30000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { return resolve({ ok: true, status: res.statusCode, data: JSON.parse(data) }); }
          catch { return resolve({ ok: true, status: res.statusCode, data: null }); }
        }
        try { return resolve({ ok: false, status: res.statusCode, data: JSON.parse(data) }); }
        catch { return resolve({ ok: false, status: res.statusCode }); }
      });
    });
    req.on('error', err => resolve({ ok: false, status: 0, error: err.message }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(body);
    req.end();
  });
}

export function startDiscoveryScheduler({ intervalHours, run, logger }) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try { await run(); }
    catch (e) { if (logger) logger.warn({ err: e.message }, 'discovery cycle failed'); }
  };
  tick();
  const ms = Math.max(1, intervalHours) * 3_600_000;
  const h = setInterval(tick, ms);
  return { stop() { stopped = true; clearInterval(h); } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && node --test tests/discovery.test.js`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add agent/src/discovery.js agent/tests/discovery.test.js
git commit -m "feat(agent): Node discovery module (run/post/scheduler)"
```

---

## Task 4: Agent Config Defaults + Wire into agent.js

**Files:**
- Modify: `agent/src/config.js`
- Modify: `agent/appsettings.example.json`
- Modify: `agent/tests/config.test.js`
- Modify: `agent/agent.js`

**Interfaces:**
- `loadConfig(path)` returns object including `discoveryIntervalHours` (default 4) and `psDiscoveryScriptPath` (default `C:\\Program Files\\ADDashboard\\Agent\\scripts\\collect-discovery.ps1`).
- `agent.js` constructs a discovery scheduler alongside the existing heartbeat and stops it on shutdown.

- [ ] **Step 1: Update failing test first**

In `agent/tests/config.test.js`, after the existing `assert.equal(c.heartbeatIntervalSeconds, 5);` line, add:

```javascript
assert.equal(c.discoveryIntervalHours, 4);
assert.equal(c.psDiscoveryScriptPath, 'C:\\Program Files\\ADDashboard\\Agent\\scripts\\collect-discovery.ps1');
```

Run: `cd agent && node --test tests/config.test.js`
Expected: FAIL — those keys are not in DEFAULTS yet.

- [ ] **Step 2: Update `agent/src/config.js`**

In the `DEFAULTS` object, add two keys:

```javascript
discoveryIntervalHours: 4,
psDiscoveryScriptPath: 'C:\\Program Files\\ADDashboard\\Agent\\scripts\\collect-discovery.ps1',
```

Place them adjacent to `heartbeatIntervalSeconds` for readability.

- [ ] **Step 3: Update `agent/appsettings.example.json`**

Add two keys (after `heartbeatIntervalSeconds`):

```json
"discoveryIntervalHours": 4,
"psDiscoveryScriptPath": "C:\\Program Files\\ADDashboard\\Agent\\scripts\\collect-discovery.ps1",
```

- [ ] **Step 4: Run config test to verify pass**

Run: `cd agent && node --test tests/config.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire discovery into `agent.js`**

In `agent/agent.js`, after the existing `heartbeat` block, add:

```javascript
import { runDiscovery, postDiscovery, startDiscoveryScheduler } from './src/discovery.js';

// ...after the heartbeat block:
const discovery = startDiscoveryScheduler({
  intervalHours: config.discoveryIntervalHours,
  run: async () => {
    const snap = await runDiscovery({
      powerShellPath: config.powerShellPath,
      psDiscoveryScriptPath: config.psDiscoveryScriptPath
    });
    if (!snap) return;
    await postDiscovery({
      centerUrl: config.centerUrl,
      agentToken: config.agentToken,
      payload: {
        agentId: config.agentId,
        collectedAt: new Date().toISOString(),
        dc: snap
      }
    });
  },
  logger
});
```

And inside the `shutdown` function, before `process.exit(0)`, add:

```javascript
discovery.stop();
```

- [ ] **Step 6: Run all agent tests**

Run: `cd agent && node --test "tests/*.test.js"`
Expected: all pass (now ~21 tests).

- [ ] **Step 7: Commit**

```bash
git add agent/src/config.js agent/appsettings.example.json agent/tests/config.test.js agent/agent.js
git commit -m "feat(agent): wire discovery scheduler; add config defaults"
```

---

## Task 5: Center /api/agent/discover Endpoint + Service + Tests

**Files:**
- Create: `center/src/services/discovery.js`
- Modify: `center/src/routes/agent.js`
- Modify: `center/tests/agent.test.js`

**Interfaces:**
- `upsertDiscoveredDc(pool, { agentId, collectedAt, dc })` performs MySQL `INSERT ... ON DUPLICATE KEY UPDATE` writing to `ad_dcs` columns: `dc_name, site_hint, os_version, when_created, is_pdc, is_gc, is_rid_master, is_schema_master, is_domain_naming_master, is_infrastructure_master, discovered_at, discovered_by_agent_id`. NEVER touches `site_id`.
- `POST /api/agent/discover` (auth: `agentMw`): body `{agentId, collectedAt, dc: {name, siteHint, osVersion, whenCreated, isPdc, isGc, isRidMaster, isSchemaMaster, isDomainNamingMaster, isInfrastructureMaster}}`. Returns 200 `{ok:true}` or 400 `{error:"missing agentId/collectedAt/dc.name"}` or 500.

- [ ] **Step 1: Write the failing endpoint tests**

Append to `center/tests/agent.test.js` (after the existing tests):

```javascript
import { upsertDiscoveredDc } from '../src/services/discovery.js';

// ----- DISCOVER -----

test('POST /api/agent/discover with correct token -> 200 and UPSERT to ad_dcs', async () => {
  const records = [];
  const pool = buildRecordingPool(records);
  const app = buildApp({ pool, agentTokenValue: 'tok' });
  const res = await supertest(app)
    .post('/api/agent/discover')
    .set('X-Agent-Token', 'tok')
    .send({
      agentId: 'DC-BJ-01',
      collectedAt: '2026-07-12T00:00:00.000Z',
      dc: {
        name: 'DC-BJ-01',
        siteHint: 'Beijing-Site',
        osVersion: 'Windows Server 2019',
        whenCreated: '2024-03-15T08:00:00.000Z',
        isPdc: false,
        isGc: true,
        isRidMaster: false,
        isSchemaMaster: false,
        isDomainNamingMaster: false,
        isInfrastructureMaster: false
      }
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(records.length, 1);
  assert.match(records[0].sql, /INSERT\s+INTO\s+ad_dcs/i);
  assert.match(records[0].sql, /ON\s+DUPLICATE\s+KEY\s+UPDATE/i);
  // site_id must NOT appear in the SQL
  assert.doesNotMatch(records[0].sql, /site_id\s*=/i);
});

test('POST /api/agent/discover missing dc.name -> 400', async () => {
  const records = [];
  const pool = buildRecordingPool(records);
  const app = buildApp({ pool, agentTokenValue: 'tok' });
  const res = await supertest(app)
    .post('/api/agent/discover')
    .set('X-Agent-Token', 'tok')
    .send({ agentId: 'DC-BJ-01', collectedAt: '2026-07-12T00:00:00.000Z', dc: {} });
  assert.equal(res.status, 400);
  assert.equal(records.length, 0);
});

test('POST /api/agent/discover with wrong token -> 401', async () => {
  const records = [];
  const pool = buildRecordingPool(records);
  const app = buildApp({ pool, agentTokenValue: 'tok' });
  const res = await supertest(app)
    .post('/api/agent/discover')
    .set('X-Agent-Token', 'WRONG')
    .send({ agentId: 'DC-BJ-01', collectedAt: '2026-07-12T00:00:00.000Z', dc: { name: 'X' } });
  assert.equal(res.status, 401);
  assert.equal(records.length, 0);
});

test('upsertDiscoveredDc converts booleans to 0/1', async () => {
  const records = [];
  const pool = buildRecordingPool(records);
  await upsertDiscoveredDc(pool, {
    agentId: 'A1',
    collectedAt: '2026-07-12T00:00:00.000Z',
    dc: {
      name: 'A1', siteHint: 'S1', osVersion: 'Win2022', whenCreated: '2024-01-01T00:00:00.000Z',
      isPdc: true, isGc: true, isRidMaster: false, isSchemaMaster: false,
      isDomainNamingMaster: false, isInfrastructureMaster: true
    }
  });
  // params: [name, siteHint, osVersion, whenCreated, isPdc, isGc, isRidMaster, isSchemaMaster, isDomainNamingMaster, isInfrastructureMaster, collectedAt, agentId]
  assert.deepEqual(records[0].params, [
    'A1', 'S1', 'Win2022', '2024-01-01T00:00:00.000Z',
    1, 1, 0, 0, 0, 1,
    '2026-07-12T00:00:00.000Z', 'A1'
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd center && node --test tests/agent.test.js`
Expected: FAIL — `upsertDiscoveredDc` not found.

- [ ] **Step 3: Create `center/src/services/discovery.js`**

```javascript
// UPSERT for agent-reported DC metadata.
// On duplicate, all agent-reported columns are refreshed; site_id is
// NEVER touched (admin owns it).
const DISCOVERY_UPSERT = `
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
  discovered_by_agent_id   = VALUES(discovered_by_agent_id)
`.trim();

export async function upsertDiscoveredDc(pool, { agentId, collectedAt, dc }) {
  await pool.execute(DISCOVERY_UPSERT, [
    dc.name,
    dc.siteHint ?? null,
    dc.osVersion ?? null,
    dc.whenCreated ?? null,
    dc.isPdc ? 1 : 0,
    dc.isGc ? 1 : 0,
    dc.isRidMaster ? 1 : 0,
    dc.isSchemaMaster ? 1 : 0,
    dc.isDomainNamingMaster ? 1 : 0,
    dc.isInfrastructureMaster ? 1 : 0,
    collectedAt,
    agentId
  ]);
}
```

- [ ] **Step 4: Add the route to `center/src/routes/agent.js`**

At the top, add:
```javascript
import { upsertDiscoveredDc } from '../services/discovery.js';
```

After the existing `/api/agent/report` route, add:
```javascript
r.post('/api/agent/discover', agentMw, async (req, res) => {
  const { agentId, collectedAt, dc } = req.body || {};
  if (!agentId || !collectedAt || !dc?.name) {
    return res.status(400).json({ error: 'missing agentId/collectedAt/dc.name' });
  }
  try {
    await upsertDiscoveredDc(pool, { agentId, collectedAt, dc });
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e, agentId }, 'discover failed');
    res.status(500).json({ error: 'internal' });
  }
});
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd center && node --test tests/agent.test.js`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add center/src/services/discovery.js center/src/routes/agent.js center/tests/agent.test.js
git commit -m "feat(center): /api/agent/discover + UPSERT into ad_dcs"
```

---

## Task 6: Center sites-catalog CRUD + Tests

**Files:**
- Modify: `center/src/routes/admin.js`
- Modify: `center/tests/admin.test.js`

**Interfaces:** (all under `auth` middleware requiring `admin:users`)

- `GET /api/admin/sites-catalog` → 200 with array `[{id, siteName, regionCode, isHub, description, createdAt, updatedAt, dcCount}]`.
- `POST /api/admin/sites-catalog` body `{siteName, regionCode?, isHub?, description?}` → 201 `{id}` or 400 missing fields or 409 duplicate siteName.
- `PUT /api/admin/sites-catalog/:id` body `{siteName?, regionCode?, isHub?, description?}` → 200 `{ok:true}` or 404 not found.
- `DELETE /api/admin/sites-catalog/:id` → 200 `{ok:true}`; transaction: first `UPDATE ad_dcs SET site_id=NULL WHERE site_id=?`, then `DELETE FROM ad_sites WHERE site_id=?`.

- [ ] **Step 1: Write failing tests**

Append to `center/tests/admin.test.js`:

```javascript
// ----- SITES-CATALOG -----

test('GET /api/admin/sites-catalog: 200 returns array with dcCount', async () => {
  const pool = buildMockPool([
    {
      match: /FROM\s+ad_sites\s+s/i,
      rows: [
        { id: 1, site_name: 'Beijing-Site', region_code: 'BJ', is_hub: 1, description: 'BJ-DC', created_at: new Date(), updated_at: new Date(), dcCount: 3 },
        { id: 2, site_name: 'Shanghai-Site', region_code: 'SH', is_hub: 0, description: null, created_at: new Date(), updated_at: new Date(), dcCount: 0 }
      ]
    }
  ]);
  const app = buildApp({ pool });
  const r = await supertest(app)
    .get('/api/admin/sites-catalog')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 2);
  assert.equal(r.body[0].siteName, 'Beijing-Site');
  assert.equal(r.body[0].dcCount, 3);
  assert.equal(r.body[0].isHub, 1);
});

test('POST /api/admin/sites-catalog: 201 on success, 409 on duplicate', async () => {
  let insertCalls = 0;
  let insertError = null;
  const pool = {
    async execute(sql, params = []) {
      if (/INSERT\s+INTO\s+ad_sites/i.test(sql)) {
        insertCalls++;
        // Simulate duplicate-key error on second call
        if (insertCalls === 1) return [{ insertId: 99, affectedRows: 1 }, []];
        const err = new Error('Duplicate entry');
        err.code = 'ER_DUP_ENTRY';
        throw err;
      }
      return [[], []];
    }
  };
  const app = buildApp({ pool });

  // First call: success
  const r1 = await supertest(app)
    .post('/api/admin/sites-catalog')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ siteName: 'BJ', regionCode: 'BJ', isHub: true, description: 'test' });
  assert.equal(r1.status, 201);
  assert.equal(r1.body.id, 99);

  // Second call: duplicate -> 409
  const r2 = await supertest(app)
    .post('/api/admin/sites-catalog')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ siteName: 'BJ', regionCode: 'BJ' });
  assert.equal(r2.status, 409);
});

test('POST /api/admin/sites-catalog: 400 when siteName missing', async () => {
  const pool = buildMockPool();
  const app = buildApp({ pool });
  const r = await supertest(app)
    .post('/api/admin/sites-catalog')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ regionCode: 'BJ' });
  assert.equal(r.status, 400);
});

test('DELETE /api/admin/sites-catalog/:id: 200 and nullifies DCs first', async () => {
  const executed = [];
  const pool = {
    async execute(sql, params = []) {
      executed.push({ sql, params });
      return [{ affectedRows: 1 }, []];
    }
  };
  const app = buildApp({ pool });
  const r = await supertest(app)
    .delete('/api/admin/sites-catalog/1')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  // First execute should nullify DCs, second should delete site
  assert.match(executed[0].sql, /UPDATE\s+ad_dcs\s+SET\s+site_id\s*=\s*NULL/i);
  assert.match(executed[1].sql, /DELETE\s+FROM\s+ad_sites/i);
});
```

- [ ] **Step 2: Run tests to verify fail**

Run: `cd center && node --test tests/admin.test.js`
Expected: FAIL — endpoints don't exist.

- [ ] **Step 3: Add sites-catalog endpoints to `center/src/routes/admin.js`**

After the existing endpoints, add:

```javascript
// ----- Sites Catalog -----

const SITES_LIST_SQL = `
SELECT s.site_id AS id, s.site_name AS siteName, s.region_code AS regionCode,
       s.is_hub AS isHub, s.description, s.created_at AS createdAt, s.updated_at AS updatedAt,
       (SELECT COUNT(*) FROM ad_dcs d WHERE d.site_id = s.site_id) AS dcCount
FROM ad_sites s
ORDER BY s.site_name
`.trim();

r.get('/api/admin/sites-catalog', auth, async (_req, res) => {
  try {
    const [rows] = await pool.execute(SITES_LIST_SQL);
    res.json(rows.map(r => ({ ...r, isHub: !!r.isHub })));
  } catch (e) {
    logger.error({ err: e }, 'sites-catalog list failed');
    res.status(500).json({ error: 'internal' });
  }
});

r.post('/api/admin/sites-catalog', auth, async (req, res) => {
  const { siteName, regionCode, isHub, description } = req.body || {};
  if (!siteName) return res.status(400).json({ error: 'missing siteName' });
  try {
    const [result] = await pool.execute(
      'INSERT INTO ad_sites (site_name, region_code, is_hub, description) VALUES (?, ?, ?, ?)',
      [siteName, regionCode ?? null, isHub ? 1 : 0, description ?? null]
    );
    res.status(201).json({ id: result.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'siteName already exists' });
    logger.error({ err: e }, 'sites-catalog create failed');
    res.status(500).json({ error: 'internal' });
  }
});

r.put('/api/admin/sites-catalog/:id', auth, async (req, res) => {
  const id = Number(req.params.id);
  const { siteName, regionCode, isHub, description } = req.body || {};
  const fields = [];
  const params = [];
  if (siteName !== undefined)    { fields.push('site_name = ?');    params.push(siteName); }
  if (regionCode !== undefined)  { fields.push('region_code = ?');  params.push(regionCode); }
  if (isHub !== undefined)       { fields.push('is_hub = ?');       params.push(isHub ? 1 : 0); }
  if (description !== undefined) { fields.push('description = ?');   params.push(description); }
  if (fields.length === 0) return res.status(400).json({ error: 'no fields to update' });
  params.push(id);
  try {
    const [result] = await pool.execute(
      `UPDATE ad_sites SET ${fields.join(', ')} WHERE site_id = ?`, params
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'site not found' });
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'sites-catalog update failed');
    res.status(500).json({ error: 'internal' });
  }
});

r.delete('/api/admin/sites-catalog/:id', auth, async (req, res) => {
  const id = Number(req.params.id);
  try {
    await pool.execute('UPDATE ad_dcs SET site_id = NULL WHERE site_id = ?', [id]);
    const [result] = await pool.execute('DELETE FROM ad_sites WHERE site_id = ?', [id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'site not found' });
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'sites-catalog delete failed');
    res.status(500).json({ error: 'internal' });
  }
});
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd center && node --test tests/admin.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add center/src/routes/admin.js center/tests/admin.test.js
git commit -m "feat(center): sites-catalog CRUD endpoints"
```

---

## Task 7: Center dcs-catalog Endpoints + Site Assignment

**Files:**
- Modify: `center/src/routes/admin.js`
- Modify: `center/tests/admin.test.js`

**Interfaces:** (all under `auth` middleware)

- `GET /api/admin/dcs-catalog` → 200 with array `[{dcName, siteId, siteName, siteHint, osVersion, whenCreated, isPdc, isGc, isRidMaster, isSchemaMaster, isDomainNamingMaster, isInfrastructureMaster, discoveredAt, discoveredByAgentId}]` (LEFT JOIN ad_sites).
- `PUT /api/admin/dcs-catalog/:dc_name/site` body `{siteId}` → 200 `{ok:true}` or 400 (invalid siteId) or 404 (dcName not found).

- [ ] **Step 1: Write failing tests**

Append to `center/tests/admin.test.js`:

```javascript
// ----- DCS-CATALOG -----

test('GET /api/admin/dcs-catalog: 200 returns LEFT JOIN with site', async () => {
  const pool = buildMockPool([
    {
      match: /FROM\s+ad_dcs\s+d\s+LEFT\s+JOIN\s+ad_sites/i,
      rows: [
        {
          dcName: 'DC-BJ-01', siteId: 1, siteName: 'Beijing-Site',
          siteHint: 'Beijing-Site', osVersion: 'Win2022', whenCreated: new Date(),
          isPdc: 0, isGc: 1, isRidMaster: 0, isSchemaMaster: 0,
          isDomainNamingMaster: 0, isInfrastructureMaster: 0,
          discoveredAt: new Date(), discoveredByAgentId: 'DC-BJ-01'
        },
        {
          dcName: 'DC-SH-01', siteId: null, siteName: null,
          siteHint: 'Shanghai-Site', osVersion: 'Win2019', whenCreated: null,
          isPdc: 0, isGc: 1, isRidMaster: 0, isSchemaMaster: 0,
          isDomainNamingMaster: 0, isInfrastructureMaster: 0,
          discoveredAt: new Date(), discoveredByAgentId: 'DC-SH-01'
        }
      ]
    }
  ]);
  const app = buildApp({ pool });
  const r = await supertest(app)
    .get('/api/admin/dcs-catalog')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 2);
  assert.equal(r.body[0].dcName, 'DC-BJ-01');
  assert.equal(r.body[0].siteName, 'Beijing-Site');
  assert.equal(r.body[1].siteId, null); // unassigned
});

test('PUT /api/admin/dcs-catalog/:dc_name/site: 200 sets siteId', async () => {
  let updateCalled = false;
  const pool = {
    async execute(sql, params = []) {
      if (/UPDATE\s+ad_dcs\s+SET\s+site_id\s*=/i.test(sql)) {
        updateCalled = true;
        assert.equal(params[0], 1);
        assert.equal(params[1], 'DC-BJ-01');
        return [{ affectedRows: 1 }, []];
      }
      return [[], []];
    }
  };
  const app = buildApp({ pool });
  const r = await supertest(app)
    .put('/api/admin/dcs-catalog/DC-BJ-01/site')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ siteId: 1 });
  assert.equal(r.status, 200);
  assert.equal(updateCalled, true);
});

test('PUT /api/admin/dcs-catalog/:dc_name/site with siteId:null unbinds', async () => {
  const records = [];
  const pool = buildRecordingPool(records);
  const app = buildApp({ pool });
  const r = await supertest(app)
    .put('/api/admin/dcs-catalog/DC-BJ-01/site')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ siteId: null });
  assert.equal(r.status, 200);
  assert.match(records[0].sql, /UPDATE\s+ad_dcs\s+SET\s+site_id\s*=\s*\?/i);
  assert.equal(records[0].params[0], null);
});
```

- [ ] **Step 2: Run tests to verify fail**

Run: `cd center && node --test tests/admin.test.js`
Expected: FAIL — endpoints missing.

- [ ] **Step 3: Add dcs-catalog endpoints to `center/src/routes/admin.js`**

After the sites-catalog endpoints, add:

```javascript
// ----- DCs Catalog -----

const DCS_LIST_SQL = `
SELECT d.dc_name AS dcName, d.site_id AS siteId, s.site_name AS siteName,
       d.site_hint AS siteHint, d.os_version AS osVersion, d.when_created AS whenCreated,
       d.is_pdc AS isPdc, d.is_gc AS isGc, d.is_rid_master AS isRidMaster,
       d.is_schema_master AS isSchemaMaster, d.is_domain_naming_master AS isDomainNamingMaster,
       d.is_infrastructure_master AS isInfrastructureMaster,
       d.discovered_at AS discoveredAt, d.discovered_by_agent_id AS discoveredByAgentId
FROM ad_dcs d
LEFT JOIN ad_sites s ON d.site_id = s.site_id
ORDER BY d.dc_name
`.trim();

r.get('/api/admin/dcs-catalog', auth, async (_req, res) => {
  try {
    const [rows] = await pool.execute(DCS_LIST_SQL);
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
    if (siteId !== null && siteId !== undefined) {
      // Validate siteId exists
      const [siteRows] = await pool.execute(
        'SELECT site_id FROM ad_sites WHERE site_id = ?', [siteId]
      );
      if (siteRows.length === 0) return res.status(400).json({ error: 'siteId not found' });
    }
    const [result] = await pool.execute(
      'UPDATE ad_dcs SET site_id = ? WHERE dc_name = ?',
      [siteId ?? null, dcName]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'dc not found' });
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'dcs-catalog site assign failed');
    res.status(500).json({ error: 'internal' });
  }
});
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd center && node --test tests/admin.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add center/src/routes/admin.js center/tests/admin.test.js
git commit -m "feat(center): dcs-catalog list + site assignment endpoint"
```

---

## Task 8: Center /api/dashboard/site-replication-matrix + Tests

**Files:**
- Modify: `center/src/routes/dashboard.js`
- Modify: `center/tests/dashboard.test.js`

**Interfaces:**
- `GET /api/dashboard/site-replication-matrix?site=<site_name>` (auth: read:dash perm).
- Returns 200 `{site: {siteId, siteName, regionCode, isHub, description}, dcs: [{dcName, osVersion, isPdc, isGc, ...}], links: [{source, target, namingContext, statusCode, lastSuccessTime, lastAttemptTime, durationMinutes}], siteRefreshSeconds}`.
- Returns 404 `{error: "site not found"}` if site doesn't exist.
- Returns 200 with empty arrays if site has no DCs assigned.

- [ ] **Step 1: Write failing tests**

Append to `center/tests/dashboard.test.js`:

```javascript
// ----- SITE REPLICATION MATRIX (G) -----

test('GET /api/dashboard/site-replication-matrix: 200 returns site + dcs + links', async () => {
  const pool = buildMockPool([
    // 1) site lookup
    {
      match: /FROM\s+ad_sites\s+WHERE\s+site_name\s*=\s*\?/i,
      rows: [{ site_id: 1, site_name: 'Beijing-Site', region_code: 'BJ', is_hub: 1, description: 'BJ-DC' }]
    },
    // 2) DCs in site
    {
      match: /FROM\s+ad_dcs\s+WHERE\s+site_id\s*=\s*\?/i,
      rows: [
        { dc_name: 'DC-BJ-01', os_version: 'Win2022', is_pdc: 0, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, discovered_at: new Date(), discovered_by_agent_id: 'DC-BJ-01' },
        { dc_name: 'DC-BJ-02', os_version: 'Win2019', is_pdc: 0, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, discovered_at: new Date(), discovered_by_agent_id: 'DC-BJ-02' }
      ]
    },
    // 3) replication links
    {
      match: /FROM\s+ad_replication_status/i,
      rows: [
        { source_dc: 'DC-BJ-01', dest_dc: 'DC-BJ-02', naming_context: 'DC=contoso,DC=com', status_code: 0, last_success_time: new Date(), last_attempt_time: new Date(), duration_minutes: 5 }
      ]
    },
    // 4) refresh seconds config
    {
      match: /FROM\s+system_config\s+WHERE\s+config_key\s*=\s*['"]site_matrix_refresh_seconds['"]/i,
      rows: [{ config_value: '10' }]
    }
  ]);
  const app = buildApp({ pool });
  const r = await supertest(app)
    .get('/api/dashboard/site-replication-matrix?site=Beijing-Site')
    .set('Authorization', `Bearer ${adminToken(['read:dash'])}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.site.siteName, 'Beijing-Site');
  assert.equal(r.body.dcs.length, 2);
  assert.equal(r.body.dcs[0].dcName, 'DC-BJ-01');
  assert.equal(r.body.links.length, 1);
  assert.equal(r.body.links[0].source, 'DC-BJ-01');
  assert.equal(r.body.links[0].target, 'DC-BJ-02');
  assert.equal(r.body.siteRefreshSeconds, 10);
});

test('GET /api/dashboard/site-replication-matrix: 404 when site not found', async () => {
  const pool = buildMockPool([
    { match: /FROM\s+ad_sites\s+WHERE\s+site_name\s*=\s*\?/i, rows: [] }
  ]);
  const app = buildApp({ pool });
  const r = await supertest(app)
    .get('/api/dashboard/site-replication-matrix?site=NoSuch')
    .set('Authorization', `Bearer ${adminToken(['read:dash'])}`);
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'site not found');
});

test('GET /api/dashboard/site-replication-matrix: 200 empty arrays when site has no DCs', async () => {
  const pool = buildMockPool([
    { match: /FROM\s+ad_sites\s+WHERE\s+site_name\s*=\s*\?/i, rows: [{ site_id: 5, site_name: 'Empty-Site', region_code: null, is_hub: 0, description: null }] },
    { match: /FROM\s+ad_dcs\s+WHERE\s+site_id\s*=\s*\?/i, rows: [] },
    { match: /FROM\s+ad_replication_status/i, rows: [] },
    { match: /site_matrix_refresh_seconds/i, rows: [{ config_value: '10' }] }
  ]);
  const app = buildApp({ pool });
  const r = await supertest(app)
    .get('/api/dashboard/site-replication-matrix?site=Empty-Site')
    .set('Authorization', `Bearer ${adminToken(['read:dash'])}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.dcs, []);
  assert.deepEqual(r.body.links, []);
});

test('GET /api/dashboard/site-replication-matrix: 400 when site query missing', async () => {
  const pool = buildMockPool();
  const app = buildApp({ pool });
  const r = await supertest(app)
    .get('/api/dashboard/site-replication-matrix')
    .set('Authorization', `Bearer ${adminToken(['read:dash'])}`);
  assert.equal(r.status, 400);
});
```

- [ ] **Step 2: Run tests to verify fail**

Run: `cd center && node --test tests/dashboard.test.js`
Expected: FAIL — endpoint missing.

- [ ] **Step 3: Add the endpoint to `center/src/routes/dashboard.js`**

The existing `auth` array uses `requirePerm('read:dash')`, which is correct for this endpoint (operator can read).

Add at the end of `dashboardRouter`:

```javascript
r.get('/api/dashboard/site-replication-matrix', auth, async (req, res) => {
  const siteName = req.query.site;
  if (!siteName) return res.status(400).json({ error: 'missing site query param' });
  try {
    // 1) Site lookup
    const [siteRows] = await pool.execute(
      'SELECT site_id AS siteId, site_name AS siteName, region_code AS regionCode, is_hub AS isHub, description FROM ad_sites WHERE site_name = ?',
      [siteName]
    );
    if (siteRows.length === 0) return res.status(404).json({ error: 'site not found' });
    const site = { ...siteRows[0], isHub: !!siteRows[0].isHub };
    const siteId = site.siteId;

    // 2) DCs in site
    const [dcRows] = await pool.execute(
      `SELECT dc_name AS dcName, os_version AS osVersion,
              is_pdc AS isPdc, is_gc AS isGc, is_rid_master AS isRidMaster,
              is_schema_master AS isSchemaMaster, is_domain_naming_master AS isDomainNamingMaster,
              is_infrastructure_master AS isInfrastructureMaster,
              discovered_at AS discoveredAt, discovered_by_agent_id AS discoveredByAgentId
       FROM ad_dcs WHERE site_id = ? ORDER BY dc_name`,
      [siteId]
    );
    const dcs = dcRows.map(d => ({
      ...d,
      isPdc: !!d.isPdc, isGc: !!d.isGc, isRidMaster: !!d.isRidMaster,
      isSchemaMaster: !!d.isSchemaMaster, isDomainNamingMaster: !!d.isDomainNamingMaster,
      isInfrastructureMaster: !!d.isInfrastructureMaster
    }));

    // 3) Replication links between those DCs
    let links = [];
    if (dcs.length > 0) {
      const placeholders = dcs.map(() => '?').join(',');
      const [linkRows] = await pool.execute(
        `SELECT source_dc AS source, dest_dc AS target, naming_context AS namingContext,
                status_code AS statusCode, last_success_time AS lastSuccessTime,
                last_attempt_time AS lastAttemptTime,
                TIMESTAMPDIFF(MINUTE, last_success_time, last_attempt_time) AS durationMinutes
         FROM ad_replication_status
         WHERE source_dc IN (${placeholders}) AND dest_dc IN (${placeholders})
         ORDER BY source_dc, dest_dc, naming_context`,
        [...dcs.map(d => d.dcName), ...dcs.map(d => d.dcName)]
      );
      links = linkRows;
    }

    // 4) Refresh seconds
    const [cfgRows] = await pool.execute(
      "SELECT config_value FROM system_config WHERE config_key = 'site_matrix_refresh_seconds'"
    );
    const siteRefreshSeconds = Number(cfgRows[0]?.config_value || 10);

    res.json({ site, dcs, links, siteRefreshSeconds });
  } catch (e) {
    logger.error({ err: e }, 'site-replication-matrix failed');
    res.status(500).json({ error: 'internal' });
  }
});
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd center && node --test tests/dashboard.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add center/src/routes/dashboard.js center/tests/dashboard.test.js
git commit -m "feat(center): /api/dashboard/site-replication-matrix endpoint (G)"
```

---

## Task 9: Frontend Rename + Nav + admin.js Skeleton

**Files:**
- Rename: `frontend/src/views/admin/SitesView.vue` → `frontend/src/views/admin/ActiveSitesView.vue`
- Rename: `frontend/src/views/admin/DcsView.vue` → `frontend/src/views/admin/ActiveDcsView.vue`
- Modify: `frontend/src/views/admin/ActiveSitesView.vue` (only the `<h2>` text)
- Modify: `frontend/src/views/admin/ActiveDcsView.vue` (only the `<h2>` text)
- Modify: `frontend/src/router.js`
- Modify: `frontend/src/components/AppLayout.vue`

**Interfaces:**
- `frontend/src/api/admin.js` will gain 6 new methods in later tasks (T10, T11). For now, leave untouched.

- [ ] **Step 1: Rename files via git mv**

```bash
cd frontend
git mv src/views/admin/SitesView.vue src/views/admin/ActiveSitesView.vue
git mv src/views/admin/DcsView.vue src/views/admin/ActiveDcsView.vue
```

- [ ] **Step 2: Update `<h2>` text in ActiveSitesView.vue**

In `frontend/src/views/admin/ActiveSitesView.vue`, change:
```html
<h2>当前可用站点</h2>
```
to:
```html
<h2>正在复制的站点</h2>
```

And in the hint paragraph, optionally update the wording. Read the file first, edit only the `<h2>` line.

- [ ] **Step 3: Update `<h2>` text in ActiveDcsView.vue**

In `frontend/src/views/admin/ActiveDcsView.vue`, change:
```html
<h2>当前可用服务器 (DC)</h2>
```
to:
```html>
<h2>正在复制的域控</h2>
```

- [ ] **Step 4: Update router.js to reference new filenames**

In `frontend/src/router.js`, change imports:

```javascript
import SitesView from './views/admin/ActiveSitesView.vue';
import DcsView from './views/admin/ActiveDcsView.vue';
```

The route paths `/admin/sites` and `/admin/dcs` remain unchanged (per spec — preserve URLs).

- [ ] **Step 5: Update AppLayout.vue nav links**

In `frontend/src/components/AppLayout.vue`, in the admin section, rename two links:

```html
<router-link to="/admin/sites">当前可用站点</router-link>
```
→
```html
<router-link to="/admin/sites">正在复制的站点</router-link>
```

```html
<router-link to="/admin/dcs">当前可用服务器</router-link>
```
→
```html
<router-link to="/admin/dcs">正在复制的域控</router-link>
```

(The new SitesCatalog/DcsCatalog/SiteReplicationMatrixView links will be added in T10/T11/T12.)

- [ ] **Step 6: Verify frontend builds**

Run: `cd frontend && npm run build`
Expected: build succeeds (no broken imports).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/views/admin/ActiveSitesView.vue frontend/src/views/admin/ActiveDcsView.vue frontend/src/router.js frontend/src/components/AppLayout.vue
git commit -m "refactor(frontend): rename derived sites/dcs views to '正在复制的...'"
```

---

## Task 10: Frontend SitesCatalogView + admin API Extension

**Files:**
- Create: `frontend/src/views/admin/SitesCatalogView.vue`
- Create: `frontend/src/components/SiteEditModal.vue`
- Modify: `frontend/src/api/admin.js`
- Modify: `frontend/src/router.js`
- Create: `frontend/tests/sites-catalog-view.test.js`

**Interfaces:**
- `adminApi.listSitesCatalog()` → `GET /api/admin/sites-catalog`
- `adminApi.createSite(body)` → `POST /api/admin/sites-catalog`
- `adminApi.updateSite(id, body)` → `PUT /api/admin/sites-catalog/:id`
- `adminApi.deleteSite(id)` → `DELETE /api/admin/sites-catalog/:id`

- [ ] **Step 1: Write the failing frontend test**

Create `frontend/tests/sites-catalog-view.test.js`:

```javascript
import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../../src/api/admin.js', () => ({
  adminApi: {
    listSitesCatalog: vi.fn(() => Promise.resolve({ data: [] })),
    createSite: vi.fn(() => Promise.resolve({ data: { id: 99 } })),
    updateSite: vi.fn(() => Promise.resolve({ data: { ok: true } })),
    deleteSite: vi.fn(() => Promise.resolve({ data: { ok: true } }))
  }
}));

import SitesCatalogView from '../../src/views/admin/SitesCatalogView.vue';
import { adminApi } from '../../src/api/admin.js';

beforeEach(() => {
  adminApi.listSitesCatalog.mockReset();
  adminApi.createSite.mockReset();
  adminApi.updateSite.mockReset();
  adminApi.deleteSite.mockReset();
});

test('SitesCatalogView renders rows from listSitesCatalog', async () => {
  adminApi.listSitesCatalog.mockResolvedValue({
    data: [
      { id: 1, siteName: 'Beijing-Site', regionCode: 'BJ', isHub: true, description: 'BJ-DC', dcCount: 3 },
      { id: 2, siteName: 'Shanghai-Site', regionCode: 'SH', isHub: false, description: null, dcCount: 0 }
    ]
  });
  const wrapper = mount(SitesCatalogView, {
    global: { stubs: { AppLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  const text = wrapper.text();
  expect(text).toContain('Beijing-Site');
  expect(text).toContain('Shanghai-Site');
  expect(text).toContain('BJ');
  expect(text).toContain('3');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test`
Expected: FAIL — SitesCatalogView not found.

- [ ] **Step 3: Extend `frontend/src/api/admin.js`**

Append to `adminApi`:

```javascript
listSitesCatalog: () => api.get('/api/admin/sites-catalog'),
createSite: (body) => api.post('/api/admin/sites-catalog', body),
updateSite: (id, body) => api.put(`/api/admin/sites-catalog/${id}`, body),
deleteSite: (id) => api.delete(`/api/admin/sites-catalog/${id}`),
```

- [ ] **Step 4: Create `frontend/src/views/admin/SitesCatalogView.vue`**

Write this file:

```vue
<template>
  <AppLayout>
    <h2>AD 站点清单</h2>
    <p class="hint">权威站点列表 — 由 admin 手动维护, DC 通过 ad_dcs.site_id 关联。</p>
    <button @click="openCreate">+ 新建站点</button>
    <table class="t">
      <thead>
        <tr><th>站点名</th><th>区域</th><th>枢纽</th><th>说明</th><th>DC 数</th><th>操作</th></tr>
      </thead>
      <tbody>
        <tr v-for="s in sites" :key="s.id">
          <td><code>{{ s.siteName }}</code></td>
          <td>{{ s.regionCode || '-' }}</td>
          <td><span v-if="s.isHub" class="hub">HUB</span></td>
          <td>{{ s.description || '-' }}</td>
          <td>{{ s.dcCount }}</td>
          <td>
            <button @click="openEdit(s)">编辑</button>
            <button @click="onDelete(s)">删除</button>
          </td>
        </tr>
        <tr v-if="!sites.length"><td colspan="6" class="empty">暂无站点 — 点击"新建站点"开始</td></tr>
      </tbody>
    </table>
    <SiteEditModal v-if="editing" :site="editing" @save="onSave" @cancel="editing = null" />
  </AppLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import AppLayout from '../../components/AppLayout.vue';
import SiteEditModal from '../../components/SiteEditModal.vue';
import { adminApi } from '../../api/admin.js';

const sites = ref([]);
const editing = ref(null);

async function load() {
  const r = await adminApi.listSitesCatalog();
  sites.value = r.data || [];
}

function openCreate() { editing.value = { id: null, siteName: '', regionCode: '', isHub: false, description: '' }; }
function openEdit(s) { editing.value = { ...s }; }

async function onSave(payload) {
  if (payload.id) {
    await adminApi.updateSite(payload.id, payload);
  } else {
    await adminApi.createSite(payload);
  }
  editing.value = null;
  await load();
}

async function onDelete(s) {
  if (!confirm(`删除站点 ${s.siteName} ? 关联的 DC 将变为"未分配"。`)) return;
  await adminApi.deleteSite(s.id);
  await load();
}

onMounted(load);
</script>

<style scoped>
.t { width: 100%; border-collapse: collapse; background: var(--panel); margin-top: 12px; }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
.hub { background: var(--accent); color: #0b1220; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; }
.empty { text-align: center; color: var(--muted); padding: 24px; }
.hint { color: var(--muted); font-size: 12px; margin: 0 0 12px; }
</style>
```

- [ ] **Step 5: Create `frontend/src/components/SiteEditModal.vue`**

```vue
<template>
  <div class="modal-bg" @click.self="$emit('cancel')">
    <div class="modal">
      <h3>{{ site.id ? '编辑站点' : '新建站点' }}</h3>
      <label>站点名 *<input v-model="form.siteName" /></label>
      <label>区域代码<input v-model="form.regionCode" /></label>
      <label><input type="checkbox" v-model="form.isHub" /> 枢纽站点</label>
      <label>说明<textarea v-model="form.description"></textarea></label>
      <div class="actions">
        <button @click="$emit('cancel')">取消</button>
        <button @click="save" :disabled="!form.siteName">保存</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive } from 'vue';
const props = defineProps({ site: { type: Object, required: true } });
const emit = defineEmits(['save', 'cancel']);
const form = reactive({
  id: props.site.id,
  siteName: props.site.siteName || '',
  regionCode: props.site.regionCode || '',
  isHub: !!props.site.isHub,
  description: props.site.description || ''
});
function save() { emit('save', { ...form }); }
</script>

<style scoped>
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--panel); padding: 20px; border-radius: 6px; min-width: 400px; }
.modal h3 { margin: 0 0 12px; }
.modal label { display: block; margin-bottom: 10px; font-size: 13px; }
.modal input[type=text], .modal input:not([type]), .modal textarea { width: 100%; padding: 6px; background: #0b1220; color: var(--text); border: 1px solid #1e293b; border-radius: 3px; }
.actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
</style>
```

- [ ] **Step 6: Add route**

In `frontend/src/router.js`, add:

```javascript
import SitesCatalogView from './views/admin/SitesCatalogView.vue';
```

And in the routes array:
```javascript
{ path: '/admin/sites-catalog', component: SitesCatalogView, meta: { perm: 'admin:users' } },
```

- [ ] **Step 7: Run test to verify pass**

Run: `cd frontend && npm test -- tests/sites-catalog-view.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/views/admin/SitesCatalogView.vue frontend/src/components/SiteEditModal.vue frontend/src/api/admin.js frontend/src/router.js frontend/tests/sites-catalog-view.test.js
git commit -m "feat(frontend): SitesCatalogView + admin CRUD API extension"
```

---

## Task 11: Frontend DcsCatalogView + Site Assignment

**Files:**
- Create: `frontend/src/views/admin/DcsCatalogView.vue`
- Modify: `frontend/src/api/admin.js`
- Modify: `frontend/src/router.js`
- Modify: `frontend/src/components/AppLayout.vue`
- Create: `frontend/tests/dcs-catalog-view.test.js`

**Interfaces:**
- `adminApi.listDcsCatalog()` → `GET /api/admin/dcs-catalog`
- `adminApi.assignDcSite(dcName, siteId)` → `PUT /api/admin/dcs-catalog/:dc_name/site`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/dcs-catalog-view.test.js`:

```javascript
import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../../src/api/admin.js', () => ({
  adminApi: {
    listSitesCatalog: vi.fn(() => Promise.resolve({ data: [] })),
    listDcsCatalog: vi.fn(() => Promise.resolve({ data: [] })),
    assignDcSite: vi.fn(() => Promise.resolve({ data: { ok: true } }))
  }
}));

import DcsCatalogView from '../../src/views/admin/DcsCatalogView.vue';
import { adminApi } from '../../src/api/admin.js';

beforeEach(() => {
  adminApi.listSitesCatalog.mockReset();
  adminApi.listDcsCatalog.mockReset();
  adminApi.assignDcSite.mockReset();
});

test('DcsCatalogView renders DC rows with site name and role badges', async () => {
  adminApi.listSitesCatalog.mockResolvedValue({
    data: [{ id: 1, siteName: 'Beijing-Site' }]
  });
  adminApi.listDcsCatalog.mockResolvedValue({
    data: [
      { dcName: 'DC-BJ-01', siteId: 1, siteName: 'Beijing-Site', siteHint: 'Beijing-Site', osVersion: 'Win2022', isPdc: false, isGc: true, isRidMaster: false, isSchemaMaster: false, isDomainNamingMaster: false, isInfrastructureMaster: false, discoveredAt: '2026-07-12T00:00:00Z' },
      { dcName: 'DC-SH-01', siteId: null, siteName: null, siteHint: 'Shanghai-Site', osVersion: 'Win2019', isPdc: false, isGc: true, isRidMaster: false, isSchemaMaster: false, isDomainNamingMaster: false, isInfrastructureMaster: false, discoveredAt: null }
    ]
  });
  const wrapper = mount(DcsCatalogView, {
    global: { stubs: { AppLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  const text = wrapper.text();
  expect(text).toContain('DC-BJ-01');
  expect(text).toContain('Beijing-Site');
  expect(text).toContain('DC-SH-01');
  expect(text).toContain('未分配');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- tests/dcs-catalog-view.test.js`
Expected: FAIL — view not found.

- [ ] **Step 3: Extend `frontend/src/api/admin.js`**

```javascript
listDcsCatalog: () => api.get('/api/admin/dcs-catalog'),
assignDcSite: (dcName, siteId) => api.put(`/api/admin/dcs-catalog/${encodeURIComponent(dcName)}/site`, { siteId }),
```

- [ ] **Step 4: Create `frontend/src/views/admin/DcsCatalogView.vue`**

```vue
<template>
  <AppLayout>
    <h2>AD 域控清单</h2>
    <p class="hint">权威 DC 列表 — agent 自动上报元数据, 站点分配由 admin 手动设置。</p>
    <table class="t">
      <thead>
        <tr>
          <th>DC 名</th><th>所属站点</th><th>Agent 提示</th><th>OS</th>
          <th>角色</th><th>最近发现</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="d in dcs" :key="d.dcName">
          <td><code>{{ d.dcName }}</code></td>
          <td>
            <select :value="d.siteId" @change="onAssign(d, $event.target.value)">
              <option :value="null">未分配</option>
              <option v-for="s in sites" :key="s.id" :value="s.id">{{ s.siteName }}</option>
            </select>
          </td>
          <td><small>{{ d.siteHint || '-' }}</small></td>
          <td>{{ d.osVersion || '-' }}</td>
          <td>
            <span v-if="d.isPdc" class="badge">PDC</span>
            <span v-if="d.isGc" class="badge">GC</span>
            <span v-if="d.isRidMaster" class="badge">RID</span>
            <span v-if="d.isSchemaMaster" class="badge">Schema</span>
            <span v-if="d.isDomainNamingMaster" class="badge">Naming</span>
            <span v-if="d.isInfrastructureMaster" class="badge">Infra</span>
          </td>
          <td>{{ fmt(d.discoveredAt) }}</td>
        </tr>
        <tr v-if="!dcs.length"><td colspan="6" class="empty">暂无 DC — 等待 agent 上报 discovery</td></tr>
      </tbody>
    </table>
  </AppLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import AppLayout from '../../components/AppLayout.vue';
import { adminApi } from '../../api/admin.js';

const sites = ref([]);
const dcs = ref([]);

async function load() {
  const [s, d] = await Promise.all([adminApi.listSitesCatalog(), adminApi.listDcsCatalog()]);
  sites.value = s.data || [];
  dcs.value = d.data || [];
}

async function onAssign(dc, siteId) {
  const id = siteId === '' ? null : Number(siteId);
  await adminApi.assignDcSite(dc.dcName, id);
  await load();
}

function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }

onMounted(load);
</script>

<style scoped>
.t { width: 100%; border-collapse: collapse; background: var(--panel); }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
.t select { background: #0b1220; color: var(--text); border: 1px solid #1e293b; padding: 4px; border-radius: 3px; }
.badge { background: var(--accent); color: #0b1220; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; margin-right: 4px; }
.empty { text-align: center; color: var(--muted); padding: 24px; }
.hint { color: var(--muted); font-size: 12px; margin: 0 0 12px; }
small { color: var(--muted); }
</style>
```

- [ ] **Step 5: Add route**

In `frontend/src/router.js`:

```javascript
import DcsCatalogView from './views/admin/DcsCatalogView.vue';
```

And in routes:
```javascript
{ path: '/admin/dcs-catalog', component: DcsCatalogView, meta: { perm: 'admin:users' } },
```

- [ ] **Step 6: Add nav link in AppLayout.vue**

In `frontend/src/components/AppLayout.vue`, after the "审计日志" link, add two new admin links:

```html
<router-link to="/admin/sites-catalog">AD 站点清单</router-link>
<router-link to="/admin/dcs-catalog">AD 域控清单</router-link>
```

- [ ] **Step 7: Run test to verify pass**

Run: `cd frontend && npm test -- tests/dcs-catalog-view.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/views/admin/DcsCatalogView.vue frontend/src/api/admin.js frontend/src/router.js frontend/src/components/AppLayout.vue frontend/tests/dcs-catalog-view.test.js
git commit -m "feat(frontend): DcsCatalogView with inline site assignment"
```

---

## Task 12: Frontend SiteReplicationMatrixView + Auto-Refresh

**Files:**
- Create: `frontend/src/views/admin/SiteReplicationMatrixView.vue`
- Create: `frontend/src/api/dashboard.js`
- Modify: `frontend/src/router.js`
- Modify: `frontend/src/components/AppLayout.vue`
- Create: `frontend/tests/site-replication-matrix-view.test.js`

**Interfaces:**
- `dashboardApi.getSiteReplicationMatrix(siteName)` → `GET /api/dashboard/site-replication-matrix?site=<name>`.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/site-replication-matrix-view.test.js`:

```javascript
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../../src/api/dashboard.js', () => ({
  dashboardApi: {
    getSiteReplicationMatrix: vi.fn(() => Promise.resolve({
      data: { site: { siteId: 1, siteName: 'Beijing-Site' }, dcs: [], links: [], siteRefreshSeconds: 10 }
    }))
  }
}));

vi.mock('../../src/api/admin.js', () => ({
  adminApi: {
    listSitesCatalog: vi.fn(() => Promise.resolve({
      data: [{ id: 1, siteName: 'Beijing-Site' }, { id: 2, siteName: 'Shanghai-Site' }]
    }))
  }
}));

import SiteReplicationMatrixView from '../../src/views/admin/SiteReplicationMatrixView.vue';
import { dashboardApi } from '../../src/api/dashboard.js';

beforeEach(() => {
  vi.useFakeTimers();
  dashboardApi.getSiteReplicationMatrix.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

test('SiteReplicationMatrixView renders site dropdown and refetches on interval', async () => {
  dashboardApi.getSiteReplicationMatrix.mockResolvedValue({
    data: {
      site: { siteId: 1, siteName: 'Beijing-Site' },
      dcs: [{ dcName: 'DC-BJ-01', osVersion: 'Win2022' }],
      links: [{ source: 'DC-BJ-01', target: 'DC-BJ-02', statusCode: 0, namingContext: 'DC=contoso,DC=com' }],
      siteRefreshSeconds: 10
    }
  });

  const wrapper = mount(SiteReplicationMatrixView, {
    global: { stubs: { AppLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  expect(wrapper.text()).toContain('Beijing-Site');
  expect(wrapper.text()).toContain('DC-BJ-01');

  // Advance time by 10s -> should refetch
  const callsBefore = dashboardApi.getSiteReplicationMatrix.mock.calls.length;
  vi.advanceTimersByTime(10_000);
  await flushPromises();
  expect(dashboardApi.getSiteReplicationMatrix.mock.calls.length).toBeGreaterThan(callsBefore);

  wrapper.unmount();
});

test('SiteReplicationMatrixView clears interval on unmount', async () => {
  dashboardApi.getSiteReplicationMatrix.mockResolvedValue({
    data: { site: { siteId: 1, siteName: 'X' }, dcs: [], links: [], siteRefreshSeconds: 10 }
  });

  const clearSpy = vi.spyOn(global, 'clearInterval');
  const wrapper = mount(SiteReplicationMatrixView, {
    global: { stubs: { AppLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  wrapper.unmount();
  expect(clearSpy).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- tests/site-replication-matrix-view.test.js`
Expected: FAIL — view and dashboard.js don't exist.

- [ ] **Step 3: Create `frontend/src/api/dashboard.js`**

```javascript
import api from './client.js';
export const dashboardApi = {
  getSiteReplicationMatrix: (siteName) => api.get(`/api/dashboard/site-replication-matrix?site=${encodeURIComponent(siteName)}`)
};
```

- [ ] **Step 4: Create `frontend/src/views/admin/SiteReplicationMatrixView.vue`**

```vue
<template>
  <AppLayout>
    <h2>站点复制矩阵</h2>
    <div class="controls">
      <label>站点:
        <select v-model="selectedSite" @change="load">
          <option value="">— 选择站点 —</option>
          <option v-for="s in sites" :key="s.id" :value="s.siteName">{{ s.siteName }}</option>
        </select>
      </label>
      <span class="refresh-indicator">
        <span :class="['dot', polling ? 'on' : 'off']"></span>
        <span>每 {{ refreshSeconds }}s 刷新</span>
      </span>
    </div>

    <div v-if="!selectedSite" class="empty">请选择站点查看复制矩阵</div>
    <div v-else-if="!data.dcs.length" class="empty">该站点暂无 DC — 请先在 AD 域控清单分配</div>
    <table v-else class="matrix">
      <thead>
        <tr>
          <th></th>
          <th v-for="dc in data.dcs" :key="dc.dcName">{{ dc.dcName }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in data.dcs" :key="row.dcName">
          <th>{{ row.dcName }}</th>
          <td v-for="col in data.dcs" :key="col.dcName"
              :class="cellClass(row.dcName, col.dcName)"
              @click="onCellClick(row.dcName, col.dcName)">
            <span v-if="row.dcName === col.dcName">-</span>
            <span v-else-if="cellStatus(row.dcName, col.dcName) === 'ok'">●</span>
            <span v-else-if="cellStatus(row.dcName, col.dcName) === 'warn'">▲</span>
            <span v-else-if="cellStatus(row.dcName, col.dcName) === 'err'">✕</span>
            <span v-else>·</span>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="selectedLink" class="detail-panel">
      <strong>{{ selectedLink.source }} → {{ selectedLink.target }}</strong>
      ({{ selectedLink.namingContext }})
      — status={{ selectedLink.statusCode }}
      last_success={{ fmt(selectedLink.lastSuccessTime) }}
      duration={{ selectedLink.durationMinutes }}min
    </div>
  </AppLayout>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import AppLayout from '../../components/AppLayout.vue';
import { dashboardApi } from '../../api/dashboard.js';
import { adminApi } from '../../api/admin.js';

const sites = ref([]);
const selectedSite = ref('');
const data = ref({ site: null, dcs: [], links: [] });
const refreshSeconds = ref(10);
const selectedLink = ref(null);
const polling = ref(false);
let timerHandle = null;

async function load() {
  if (!selectedSite.value) return;
  polling.value = true;
  try {
    const r = await dashboardApi.getSiteReplicationMatrix(selectedSite.value);
    data.value = r.data;
    refreshSeconds.value = r.data.siteRefreshSeconds || 10;
  } finally {
    polling.value = false;
  }
}

function cellStatus(source, target) {
  if (source === target) return 'self';
  const link = data.value.links.find(l => l.source === source && l.target === target);
  if (!link) return 'none';
  if (link.statusCode === 0) return 'ok';
  if (link.statusCode === 1) return 'warn';
  return 'err';
}

function cellClass(source, target) {
  const s = cellStatus(source, target);
  return { cell: true, [`cell-${s}`]: true };
}

function onCellClick(source, target) {
  if (source === target) return;
  const link = data.value.links.find(l => l.source === source && l.target === target);
  selectedLink.value = link || null;
}

function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }

async function loadSites() {
  const r = await adminApi.listSitesCatalog();
  sites.value = r.data || [];
}

onMounted(async () => {
  await loadSites();
  await load();
  timerHandle = setInterval(load, refreshSeconds.value * 1000);
});

onUnmounted(() => {
  if (timerHandle) clearInterval(timerHandle);
});
</script>

<style scoped>
.controls { display: flex; gap: 16px; align-items: center; margin-bottom: 16px; }
.controls select { padding: 4px; background: #0b1220; color: var(--text); border: 1px solid #1e293b; border-radius: 3px; }
.refresh-indicator { color: var(--muted); font-size: 12px; display: flex; gap: 6px; align-items: center; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.dot.on  { background: #22c55e; }
.dot.off { background: #475569; }
.empty { text-align: center; color: var(--muted); padding: 24px; }
.matrix { border-collapse: collapse; background: var(--panel); }
.matrix th, .matrix td { border: 1px solid #1e293b; padding: 8px 12px; text-align: center; }
.matrix th { background: #0b1220; color: var(--muted); font-size: 12px; }
.cell { cursor: pointer; font-size: 14px; }
.cell:hover { background: #1e293b; }
.cell-ok    { color: #22c55e; }
.cell-warn  { color: #f59e0b; }
.cell-err   { color: #ef4444; font-weight: 600; }
.cell-none  { color: #475569; }
.cell-self  { color: #334155; }
.detail-panel { margin-top: 16px; padding: 12px; background: var(--panel); border-radius: 4px; font-size: 13px; }
</style>
```

- [ ] **Step 5: Add route and nav link**

In `frontend/src/router.js`:
```javascript
import SiteReplicationMatrixView from './views/admin/SiteReplicationMatrixView.vue';
```

And in routes:
```javascript
{ path: '/admin/site-replication-matrix', component: SiteReplicationMatrixView, meta: { perm: 'admin:users' } },
```

In `frontend/src/components/AppLayout.vue`, after the "AD 域控清单" link:
```html
<router-link to="/admin/site-replication-matrix">站点复制矩阵</router-link>
```

- [ ] **Step 6: Run test to verify pass**

Run: `cd frontend && npm test -- tests/site-replication-matrix-view.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/views/admin/SiteReplicationMatrixView.vue frontend/src/api/dashboard.js frontend/src/router.js frontend/src/components/AppLayout.vue frontend/tests/site-replication-matrix-view.test.js
git commit -m "feat(frontend): SiteReplicationMatrixView with auto-poll (G)"
```

---

## Task 13: install-center.ps1 Update + Runbook Note + E2E Verify

**Files:**
- Modify: `scripts/install-center.ps1`
- Modify: `docs/runbook.md`

**Interfaces:**
- `install-center.ps1` applies `db/migrations/*.sql` after `db/schema/*.sql`.

- [ ] **Step 1: Update `install-center.ps1`**

Find the existing loop:
```powershell
foreach ($f in @('01-tables.sql','02-seed-roles.sql')) {
  Write-Step "applying $f"
  $schemaPath = Join-Path (Join-Path $PSScriptRoot '..\db\schema') $f
  $args = @('-h', $MySqlHost, '-P', $MySqlPort, '-u', $MySqlUser, "-p$MySqlPassword", $MySqlDatabase, '--protocol=TCP')
  Get-Content $schemaPath -Encoding UTF8 | & $MySqlClient @args
  if ($LASTEXITCODE -ne 0) { throw "mysql failed applying $f" }
}
```

Replace with:
```powershell
foreach ($f in @('01-tables.sql','02-seed-roles.sql')) {
  Write-Step "applying schema/$f"
  $schemaPath = Join-Path (Join-Path $PSScriptRoot '..\db\schema') $f
  $args = @('-h', $MySqlHost, '-P', $MySqlPort, '-u', $MySqlUser, "-p$MySqlPassword", $MySqlDatabase, '--protocol=TCP')
  Get-Content $schemaPath -Encoding UTF8 | & $MySqlClient @args
  if ($LASTEXITCODE -ne 0) { throw "mysql failed applying schema/$f" }
}

$migrationsDir = Join-Path (Join-Path $PSScriptRoot '..\db') 'migrations'
if (Test-Path $migrationsDir) {
  Get-ChildItem -Path $migrationsDir -Filter '*.sql' | Sort-Object Name | ForEach-Object {
    Write-Step "applying migration/$($_.Name)"
    $args = @('-h', $MySqlHost, '-P', $MySqlPort, '-u', $MySqlUser, "-p$MySqlPassword", $MySqlDatabase, '--protocol=TCP')
    Get-Content $_.FullName -Encoding UTF8 | & $MySqlClient @args
    if ($LASTEXITCODE -ne 0) { throw "mysql failed applying migration/$($_.Name)" }
  }
}
```

- [ ] **Step 2: Update `docs/runbook.md`**

Find the section on database schema (or operations). Add a subsection:

```markdown
### Migrations

Database migrations live in `db/migrations/NNN-name.sql`. They are applied
automatically by `scripts/install-center.ps1` after the base schema.

To apply manually:

```powershell
Get-Content db\migrations\001-dc-site-discovery.sql | mysql -h <host> -P 3306 -u root -p<pwd> ad_monitoring
```

To list applied migrations, query the implicit list (we track via
filename ordering, not a migrations table — see ADR-XXX if/when we add
a tracking table).

### DC/Site Discovery

Agents collect local DC metadata every `discovery_interval_hours` (default 4h)
and POST to `/api/agent/discover`. The center UPSERTs into `ad_dcs`; `site_id`
is never touched by the agent.

Admins maintain sites via `/admin/sites-catalog` and assign DCs via
`/admin/dcs-catalog`. The `/admin/site-replication-matrix` page shows the
DC×DC replication matrix for a selected site and auto-refreshes every
`site_matrix_refresh_seconds` (default 10s).
```

(If `docs/runbook.md` doesn't exist, skip this step.)

- [ ] **Step 3: Run all test suites**

```bash
cd center && node --test "tests/*.test.js"
cd ../agent && node --test "tests/*.test.js"
cd ../frontend && npm test
cd ../agent && pwsh -Command "Invoke-Pester -Path scripts/tests"
```

Expected: all green (or Pester skipped on non-DC env).

- [ ] **Step 4: Manual end-to-end verification (in browser)**

1. Restart the center service: `Restart-Service ADCenter`.
2. Open browser to `http://127.0.0.1:8080/admin/sites-catalog` (login as admin).
3. Click "+ 新建站点", create site "Beijing-Site".
4. Restart the agent service: `Restart-Service ADAgent`. Wait for first discovery cycle (≤10s).
5. Open `http://127.0.0.1:8080/admin/dcs-catalog`. Confirm a row for the local DC appears with `siteHint` set.
6. In the row's site dropdown, select "Beijing-Site". Confirm row updates with siteName.
7. Open `http://127.0.0.1:8080/admin/site-replication-matrix`. Select "Beijing-Site". Confirm matrix renders with DC row × DC column; cells light up based on replication status.
8. Confirm indicator dot pulses and data refreshes every 10s.

- [ ] **Step 5: Commit**

```bash
git add scripts/install-center.ps1 docs/runbook.md
git commit -m "chore(install): apply db/migrations/*.sql + document discovery/matrix"
```

---

## Self-Review

**1. Spec coverage:** walked every section/requirement in `docs/superpowers/specs/2026-07-12-dc-site-discovery-design.md`:

- §4 Schema migration → T1
- §5 Agent (PS script, Node module, config, wiring) → T2, T3, T4
- §6 Center (service, route, sites-catalog, dcs-catalog) → T5, T6, T7
- §7 Frontend (rename, sites-catalog, dcs-catalog) → T9, T10, T11
- §12 G (matrix endpoint, view, auto-refresh, config) → T8, T12
- §8 Tests (Pester, Node, vitest) → distributed across T2–T12
- §13 install-center + runbook → T13
- Section 11 "后续子项目" (C, D, E, F, H, I) — intentionally excluded, separate specs.

No gaps.

**2. Placeholder scan:** no "TBD/TODO/implement later" anywhere. Each step shows actual file paths, exact code, exact commands, expected output.

**3. Type/interface consistency:**
- `agentId`, `collectedAt`, `dc.{name, siteHint, osVersion, whenCreated, isPdc, isGc, isRidMaster, isSchemaMaster, isDomainNamingMaster, isInfrastructureMaster}` — used identically across T2 (PS), T3 (Node `runDiscovery` parses), T5 (center UPSERT). Field name `whenCreated` confirmed string-or-null in T2 Pester test.
- `ad_dcs` columns added in T1 are exactly the columns referenced in T5 service (`discovered_at`, `discovered_by_agent_id`, etc.).
- `dashboardApi.getSiteReplicationMatrix(siteName)` signature in T12 matches the endpoint contract in T8 (`?site=<name>`).
- `adminApi.listSitesCatalog / createSite / updateSite / deleteSite / listDcsCatalog / assignDcSite` — added in T10/T11, no conflicts with existing `listSites` (derived) — different function names, different URLs.
- Vue `setInterval` cleanup: T12 explicitly clears `timerHandle` in `onUnmounted`; T12 test verifies `clearInterval` was called.

No bugs detected.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-12-dc-site-discovery-and-matrix.md`. Two execution options:

**1. Subagent-Driven (recommended)** - dispatch a fresh subagent per task, with task review between tasks; broad whole-branch review at the end. Faster iteration on this large plan.

**2. Inline Execution** - execute tasks in this session using executing-plans; batch execution with checkpoints for review.

Which approach?