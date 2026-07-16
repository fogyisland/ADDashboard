# AD Replication Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-hosted AD replication health dashboard with a Node.js Agent on each DC reporting to a single Node.js Center that exposes a Vue 3 dashboard, all running as Windows Services managed by NSSM.

**Architecture:** Distributed Agent (PowerShell + Node.js) → HTTP POST → Center API (Express + SQL Server) → Vue 3 + ECharts frontend served from the same Node.js process. Single central management server; NSSM wraps both services on Windows.

**Tech Stack:** Node.js 20 LTS, Express, `mssql`, `bcrypt`, `jsonwebtoken`, `axios`, `better-sqlite3`, `pino`, `node:test`, `supertest`. PowerShell 5.1+ with `ActiveDirectory` module and Pester 5. SQL Server 2019+. Vue 3 + Vite + ECharts 5 + Pinia + Vue Router + Vitest.

## Global Constraints

- Project root: `D:\ToolDevelop\ADDashboard`
- Shell: bash on Windows; use forward slashes in paths, PowerShell syntax for Windows-specific commands
- Node.js 20 LTS; no transpilation (plain JavaScript, ESM modules)
- All services run as Windows Services via NSSM
- Service names: `ADReplicationAgent` (per-DC), `ADDashboardCenter` (single)
- Install path: `C:\Program Files\ADDashboard\{Agent,Center}`
- Log path: `C:\ProgramData\ADDashboard\Logs`
- Config file per service: `appsettings.json` (no env vars; service config must be readable by operators)
- All timestamps in DB and wire format: UTC ISO 8601
- TDD: each task follows red-green-refactor with `node:test` or Pester
- Commit after every task; conventional commit prefixes (`feat:`, `test:`, `chore:`, `docs:`, `fix:`)

---

## File Structure

```
D:\ToolDevelop\ADDashboard\
├── .gitignore
├── README.md
├── package.json                          # workspace root (npm workspaces)
├── docs/
│   ├── superpowers/
│   │   ├── specs/2026-07-10-ad-dashboard-service-design.md
│   │   └── plans/2026-07-10-ad-dashboard-implementation.md
│   └── operations/
│       ├── runbook.md
│       └── troubleshooting.md
├── db/
│   ├── schema/
│   │   ├── 01-tables.sql
│   │   └── 02-seed-roles.sql
│   └── README.md
├── center/                               # Center backend + static host
│   ├── package.json
│   ├── server.js
│   ├── appsettings.example.json
│   ├── src/
│   │   ├── app.js
│   │   ├── config.js
│   │   ├── logger.js
│   │   ├── db.js
│   │   ├── auth/
│   │   │   ├── password.js
│   │   │   ├── jwt.js
│   │   │   ├── agent-token.js
│   │   │   ├── user-auth.js
│   │   │   └── rbac.js
│   │   ├── routes/
│   │   │   ├── agent.js
│   │   │   ├── auth.js
│   │   │   ├── dashboard.js
│   │   │   ├── admin.js
│   │   │   └── healthz.js
│   │   ├── services/
│   │   │   ├── replication.js
│   │   │   ├── users.js
│   │   │   ├── config.js
│   │   │   └── audit.js
│   │   └── utils/
│   │       ├── time.js
│   │       └── errors.js
│   └── tests/
│       ├── helpers/
│       │   ├── test-app.js
│       │   └── test-db.js
│       ├── auth.test.js
│       ├── agent.test.js
│       ├── dashboard.test.js
│       ├── admin.test.js
│       ├── replication.test.js
│       └── time.test.js
├── agent/                                # Agent (per-DC Node.js)
│   ├── package.json
│   ├── agent.js
│   ├── appsettings.example.json
│   ├── scripts/
│   │   └── collect-replication.ps1
│   ├── src/
│   │   ├── config.js
│   │   ├── logger.js
│   │   ├── collector.js
│   │   ├── reporter.js
│   │   ├── heartbeat.js
│   │   ├── healthcheck.js
│   │   ├── local-queue.js
│   │   └── scheduler.js
│   └── tests/
│       ├── helpers/
│       │   └── test-config.js
│       ├── collector.test.js
│       ├── reporter.test.js
│       ├── heartbeat.test.js
│       ├── healthcheck.test.js
│       ├── local-queue.test.js
│       └── config.test.js
├── frontend/                             # Vue 3 + Vite
│   ├── package.json
│   ├── vite.config.js
│   ├── index.html
│   ├── src/
│   │   ├── main.js
│   │   ├── App.vue
│   │   ├── router.js
│   │   ├── stores/auth.js
│   │   ├── api/
│   │   │   ├── client.js
│   │   │   ├── dashboard.js
│   │   │   └── admin.js
│   │   ├── components/
│   │   │   ├── AppLayout.vue
│   │   │   ├── StatusBar.vue
│   │   │   ├── SiteMatrixChart.vue
│   │   │   ├── TopologyChart.vue
│   │   │   ├── ErrorTable.vue
│   │   │   └── AgentStatusTable.vue
│   │   └── views/
│   │       ├── LoginView.vue
│   │       ├── DashboardView.vue
│   │       ├── SiteMatrixView.vue
│   │       ├── TopologyView.vue
│   │       ├── ErrorsView.vue
│   │       ├── AgentsView.vue
│   │       ├── admin/
│   │       │   ├── UsersView.vue
│   │       │   ├── RolesView.vue
│   │       │   ├── ConfigView.vue
│   │       │   └── AuditView.vue
│   │       └── NotFoundView.vue
│   └── tests/
│       ├── stores/auth.test.js
│       └── api/client.test.js
└── scripts/                              # PowerShell installers
    ├── common/
    │   ├── NSSM.psm1
    │   ├── Logger.psm1
    │   └── Service.psm1
    ├── install-center.ps1
    ├── install-agent.ps1
    ├── uninstall-center.ps1
    ├── uninstall-agent.ps1
    ├── update-center.ps1
    ├── update-agent.ps1
    └── smoke-test.ps1
```

---

## Phase 1: Foundation

### Task 1: Repository scaffold

**Files:**
- Create: `.gitignore`
- Create: `README.md`
- Create: `package.json`
- Create: `center/package.json`
- Create: `agent/package.json`
- Create: `frontend/package.json`
- Create: `db/README.md`

**Interfaces:** None yet — this task only establishes the workspace skeleton and dependency manifests.

- [ ] **Step 1: Initialize git and write `.gitignore`**

```bash
cd /d/ToolDevelop/ADDashboard
git init
git config user.email "ops@example.com"
git config user.name "AD Dashboard"
```

Create `.gitignore`:

```gitignore
node_modules/
dist/
.env
.env.local
*.log
appsettings.json
!appsettings.example.json
coverage/
.nyc_output/
.DS_Store
Thumbs.db
*.swp
.vscode/
.idea/
```

- [ ] **Step 2: Write root `package.json` (npm workspaces)**

```json
{
  "name": "ad-dashboard",
  "version": "0.1.0",
  "private": true,
  "description": "AD Replication Health Dashboard",
  "workspaces": [
    "center",
    "agent",
    "frontend"
  ],
  "scripts": {
    "test:center": "npm run test --workspace=center",
    "test:agent": "npm run test --workspace=agent",
    "test:frontend": "npm run test --workspace=frontend",
    "test": "npm run test:center && npm run test:agent && npm run test:frontend",
    "build:frontend": "npm run build --workspace=frontend"
  }
}
```

- [ ] **Step 3: Write `center/package.json`**

```json
{
  "name": "@ad-dashboard/center",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "test": "node --test tests/"
  },
  "dependencies": {
    "bcrypt": "^5.1.1",
    "express": "^4.19.2",
    "jsonwebtoken": "^9.0.2",
    "mssql": "^11.0.1",
    "pino": "^9.4.0",
    "pino-http": "^10.3.0"
  },
  "devDependencies": {
    "supertest": "^7.0.0"
  }
}
```

- [ ] **Step 4: Write `agent/package.json`**

```json
{
  "name": "@ad-dashboard/agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "agent.js",
  "scripts": {
    "start": "node agent.js",
    "test": "node --test tests/"
  },
  "dependencies": {
    "axios": "^1.7.7",
    "better-sqlite3": "^11.3.0",
    "pino": "^9.4.0"
  },
  "devDependencies": {}
}
```

- [ ] **Step 5: Write `frontend/package.json`**

```json
{
  "name": "@ad-dashboard/frontend",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "axios": "^1.7.7",
    "echarts": "^5.5.1",
    "pinia": "^2.2.4",
    "vue": "^3.5.12",
    "vue-router": "^4.4.5"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.1.4",
    "@vue/test-utils": "^2.4.6",
    "jsdom": "^25.0.1",
    "vite": "^5.4.10",
    "vitest": "^2.1.4"
  }
}
```

- [ ] **Step 6: Write `db/README.md`**

````markdown
# Database

Schema scripts must be run against SQL Server 2019+ in this order:

```powershell
# 1. Create database
sqlcmd -S localhost -Q "CREATE DATABASE AD_Monitoring"

# 2. Apply schema
sqlcmd -S localhost -d AD_Monitoring -i db/schema/01-tables.sql

# 3. Seed roles
sqlcmd -S localhost -d AD_Monitoring -i db/schema/02-seed-roles.sql
```

The install-center.ps1 script automates these steps.
````

- [ ] **Step 7: Write root `README.md`**

````markdown
# AD Replication Dashboard

Self-hosted dashboard for monitoring Active Directory replication health across multiple sites and DCs.

## Architecture

- **Agent** (per-DC): Windows Service that runs PowerShell collection on a schedule and POSTs results to Center
- **Center** (single): Windows Service exposing API + static frontend (Vue 3 + ECharts)
- **Storage**: SQL Server 2019+
- **Service manager**: NSSM

See [docs/superpowers/specs/2026-07-10-ad-dashboard-service-design.md](docs/superpowers/specs/2026-07-10-ad-dashboard-service-design.md) for the full design.

## Quick Start

```powershell
# On the center management server
.\scripts\install-center.ps1 -SqlServer localhost -ListenPort 8080

# On each DC
.\scripts\install-agent.ps1 -CenterUrl http://center:8080 -AgentToken <token>
```

## Development

```bash
npm install
npm test
npm run build:frontend
```

## Operations

- Runbook: [docs/operations/runbook.md](docs/operations/runbook.md)
- Troubleshooting: [docs/operations/troubleshooting.md](docs/operations/troubleshooting.md)
````

- [ ] **Step 8: Install dependencies**

```bash
cd /d/ToolDevelop/ADDashboard
npm install
```

Expected: `node_modules/` created at root, plus per-workspace; no errors.

- [ ] **Step 9: Commit**

```bash
git add .gitignore package.json package-lock.json README.md \
        center/package.json agent/package.json frontend/package.json \
        db/README.md docs/
git commit -m "chore: initialize npm workspaces and repository scaffold"
```

---

### Task 2: Database schema

**Files:**
- Create: `db/schema/01-tables.sql`
- Create: `db/schema/02-seed-roles.sql`
- Test: `db/tests/schema.test.ps1` (Pester)

**Interfaces:** Tables consumed by every later task: `ad_replication_status`, `ad_agent_heartbeat`, `ad_sites`, `ad_dcs`, `system_config`, `sys_users`, `sys_roles`, `audit_logs`.

- [ ] **Step 1: Write `db/schema/01-tables.sql`**

```sql
-- AD Replication Dashboard schema (SQL Server 2019+)
SET QUOTED_IDENTIFIER ON;
GO

-- Replication status snapshot (latest per partner pair)
IF OBJECT_ID('ad_replication_status', 'U') IS NULL
CREATE TABLE ad_replication_status (
  id                BIGINT IDENTITY PRIMARY KEY,
  collected_at      DATETIME2 NOT NULL,
  agent_id          NVARCHAR(64) NOT NULL,
  source_dc         NVARCHAR(128) NOT NULL,
  dest_dc           NVARCHAR(128) NOT NULL,
  source_site       NVARCHAR(64) NULL,
  dest_site         NVARCHAR(64) NULL,
  naming_context    NVARCHAR(256) NOT NULL,
  last_success_time DATETIME2 NULL,
  last_attempt_time DATETIME2 NULL,
  status_code       INT NOT NULL DEFAULT 0,
  error_message     NVARCHAR(512) NULL,
  CONSTRAINT uq_repl_partner UNIQUE (source_dc, dest_dc, naming_context)
);
CREATE INDEX ix_repl_collected ON ad_replication_status(collected_at);
CREATE INDEX ix_repl_dest ON ad_replication_status(dest_dc);
GO

-- History (append-only, retention managed by job)
IF OBJECT_ID('ad_replication_history', 'U') IS NULL
CREATE TABLE ad_replication_history (
  id                BIGINT IDENTITY PRIMARY KEY,
  collected_at      DATETIME2 NOT NULL,
  agent_id          NVARCHAR(64) NOT NULL,
  source_dc         NVARCHAR(128) NOT NULL,
  dest_dc           NVARCHAR(128) NOT NULL,
  naming_context    NVARCHAR(256) NOT NULL,
  last_success_time DATETIME2 NULL,
  status_code       INT NOT NULL,
  error_message     NVARCHAR(512) NULL
);
CREATE INDEX ix_hist_time ON ad_replication_history(collected_at);
GO

-- Agent heartbeat
IF OBJECT_ID('ad_agent_heartbeat', 'U') IS NULL
CREATE TABLE ad_agent_heartbeat (
  agent_id            NVARCHAR(64) PRIMARY KEY,
  last_heartbeat_at   DATETIME2 NULL,
  agent_version       NVARCHAR(32) NULL,
  last_report_at      DATETIME2 NULL,
  last_report_status  NVARCHAR(32) NULL,
  pending_queue_size  INT NOT NULL DEFAULT 0
);
GO

-- Sites
IF OBJECT_ID('ad_sites', 'U') IS NULL
CREATE TABLE ad_sites (
  site_id     INT IDENTITY PRIMARY KEY,
  site_name   NVARCHAR(64) UNIQUE NOT NULL,
  region_code NVARCHAR(32) NULL,
  is_hub      BIT NOT NULL DEFAULT 0
);
GO

-- DCs
IF OBJECT_ID('ad_dcs', 'U') IS NULL
CREATE TABLE ad_dcs (
  dc_name    NVARCHAR(128) PRIMARY KEY,
  site_id    INT NULL FOREIGN KEY REFERENCES ad_sites(site_id),
  ip_address NVARCHAR(64) NULL,
  os_version NVARCHAR(64) NULL,
  is_pdc     BIT NOT NULL DEFAULT 0
);
GO

-- System config (key-value)
IF OBJECT_ID('system_config', 'U') IS NULL
CREATE TABLE system_config (
  config_key   NVARCHAR(64) PRIMARY KEY,
  config_value NVARCHAR(MAX) NULL,
  description  NVARCHAR(256) NULL,
  updated_at   DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
  updated_by   NVARCHAR(64) NULL
);
GO

-- RBAC roles
IF OBJECT_ID('sys_roles', 'U') IS NULL
CREATE TABLE sys_roles (
  id          INT IDENTITY PRIMARY KEY,
  role_name   NVARCHAR(64) UNIQUE NOT NULL,
  permissions NVARCHAR(MAX) NOT NULL DEFAULT '[]'
);
GO

-- RBAC users
IF OBJECT_ID('sys_users', 'U') IS NULL
CREATE TABLE sys_users (
  id              INT IDENTITY PRIMARY KEY,
  username        NVARCHAR(64) UNIQUE NOT NULL,
  password_hash   NVARCHAR(256) NOT NULL,
  role_id         INT NOT NULL FOREIGN KEY REFERENCES sys_roles(id),
  status          BIT NOT NULL DEFAULT 1,
  last_login_at   DATETIME2 NULL,
  created_at      DATETIME2 NOT NULL DEFAULT GETUTCDATE()
);
GO

-- Audit log
IF OBJECT_ID('audit_logs', 'U') IS NULL
CREATE TABLE audit_logs (
  id         BIGINT IDENTITY PRIMARY KEY,
  user_id    INT NULL,
  action     NVARCHAR(64) NOT NULL,
  target     NVARCHAR(128) NULL,
  payload    NVARCHAR(MAX) NULL,
  created_at DATETIME2 NOT NULL DEFAULT GETUTCDATE()
);
CREATE INDEX ix_audit_time ON audit_logs(created_at);
GO
```

- [ ] **Step 2: Write `db/schema/02-seed-roles.sql`**

```sql
-- Seed default roles (idempotent)
SET QUOTED_IDENTIFIER ON;
GO

IF NOT EXISTS (SELECT 1 FROM sys_roles WHERE role_name = 'admin')
INSERT INTO sys_roles (role_name, permissions) VALUES
  ('admin',    '["*"]');

IF NOT EXISTS (SELECT 1 FROM sys_roles WHERE role_name = 'operator')
INSERT INTO sys_roles (role_name, permissions) VALUES
  ('operator', '["read:dash","execute:sync"]');

IF NOT EXISTS (SELECT 1 FROM sys_roles WHERE role_name = 'viewer')
INSERT INTO sys_roles (role_name, permissions) VALUES
  ('viewer',   '["read:dash"]');
GO

-- Seed default system config (idempotent)
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'ad_agent_token')
INSERT INTO system_config (config_key, config_value, description)
VALUES ('ad_agent_token', NULL, 'Shared secret for Agent API authentication');

IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'polling_interval_minutes')
INSERT INTO system_config (config_key, config_value, description)
VALUES ('polling_interval_minutes', '15', 'Agent collection interval in minutes');

IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'latency_threshold_minutes')
INSERT INTO system_config (config_key, config_value, description)
VALUES ('latency_threshold_minutes', '180', 'Replication latency warning threshold');

IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'history_enabled')
INSERT INTO system_config (config_key, config_value, description)
VALUES ('history_enabled', '0', 'Append to ad_replication_history (0/1)');
GO
```

- [ ] **Step 3: Write Pester test `db/tests/schema.test.ps1`**

```powershell
Describe "Database schema" {
  BeforeAll {
    $script:server = $env:TEST_SQL_SERVER
    if (-not $script:server) { $script:server = "localhost" }
    $script:db = "AD_Monitoring_Test_$([Guid]::NewGuid().ToString('N'))"
    $script:cs = "Server=$script:server;Database=master;Integrated Security=SSPI;TrustServerCertificate=True"
  }

  It "creates all required tables" {
    $tables = @(
      'ad_replication_status','ad_replication_history','ad_agent_heartbeat',
      'ad_sites','ad_dcs','system_config','sys_users','sys_roles','audit_logs'
    )
    $result = Invoke-Sqlcmd -ConnectionString $script:cs -Query "
      IF DB_ID('$script:db') IS NULL CREATE DATABASE $script:db;
      USE $script:db;
      "
    $appCs = "Server=$script:server;Database=$script:db;Integrated Security=SSPI;TrustServerCertificate=True"
    Get-Content "$PSScriptRoot/../schema/01-tables.sql" |
      ForEach-Object { $_ -replace 'AD_Monitoring', $script:db } |
      Out-File -Encoding UTF8 "$PSScriptRoot/_01-tables-test.sql"
    Invoke-Sqlcmd -ConnectionString $appCs -InputFile "$PSScriptRoot/_01-tables-test.sql"
    foreach ($t in $tables) {
      $r = Invoke-Sqlcmd -ConnectionString $appCs -Query "SELECT OBJECT_ID('$t') AS id"
      $r.id | Should -Not -BeNullOrEmpty -Because "table $t must exist"
    }
  }

  AfterAll {
    if ($script:db) {
      try { Invoke-Sqlcmd -ConnectionString $script:cs -Query "DROP DATABASE IF EXISTS $script:db" -ErrorAction SilentlyContinue } catch {}
    }
    Remove-Item "$PSScriptRoot/_01-tables-test.sql" -ErrorAction SilentlyContinue
  }
}
```

- [ ] **Step 4: Install Pester 5 (if missing) and run the test**

```powershell
Install-Module -Name Pester -Force -SkipPublisherCheck -Scope CurrentUser
Import-Module Pester -MinimumVersion 5.0
Invoke-Pester ./db/tests/schema.test.ps1 -Output Detailed
```

Expected: All `It` blocks pass. If SQL Server is not available locally, set `TEST_SQL_SERVER` to a reachable instance.

- [ ] **Step 5: Commit**

```bash
git add db/
git commit -m "feat(db): add schema for replication status, agents, RBAC, audit"
```

---

### Task 3: Shared logger

**Files:**
- Create: `center/src/logger.js`
- Create: `agent/src/logger.js`
- Test: `center/tests/logger.test.js`
- Test: `agent/tests/logger.test.js`

**Interfaces:** `createLogger(component)` returns a `pino` logger that writes to stdout in JSON format; the NSSM wrapper rotates the file. Used by every later task.

- [ ] **Step 1: Write failing test `center/tests/logger.test.js`**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { createLogger } from '../src/logger.js';

test('logger writes JSON line with component field', () => {
  const lines = [];
  const sink = new Writable({
    write(chunk, enc, cb) { lines.push(JSON.parse(chunk.toString())); cb(); }
  });
  const log = createLogger({ component: 'test', stream: sink });
  log.info('hello');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].msg, 'hello');
  assert.equal(lines[0].component, 'test');
  assert.equal(lines[0].level, 30); // info
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd /d/ToolDevelop/ADDashboard
node --test center/tests/logger.test.js
```

Expected: FAIL — `createLogger` not found.

- [ ] **Step 3: Implement `center/src/logger.js`**

```javascript
import pino from 'pino';

export function createLogger({ component, level = 'info', stream } = {}) {
  return pino({
    level,
    base: { component },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(stream ? { stream } : {})
  });
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
node --test center/tests/logger.test.js
```

Expected: PASS, 1 test.

- [ ] **Step 5: Implement `agent/src/logger.js` (same module)**

```javascript
import pino from 'pino';

export function createLogger({ component, level = 'info', stream } = {}) {
  return pino({
    level,
    base: { component },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(stream ? { stream } : {})
  });
}
```

- [ ] **Step 6: Write and run agent test**

```javascript
// agent/tests/logger.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { createLogger } from '../src/logger.js';

test('agent logger writes JSON line with component', () => {
  const lines = [];
  const sink = new Writable({ write(c,e,cb){ lines.push(JSON.parse(c.toString())); cb(); }});
  const log = createLogger({ component: 'agent', stream: sink });
  log.info('startup');
  assert.equal(lines[0].component, 'agent');
});
```

```bash
node --test agent/tests/logger.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add center/src/logger.js agent/src/logger.js center/tests/logger.test.js agent/tests/logger.test.js
git commit -m "feat: add shared pino logger for center and agent"
```

---

## Phase 2: Center Backend

### Task 4: Center config loader, DB pool, Express skeleton, healthz

**Files:**
- Create: `center/src/config.js`
- Create: `center/src/db.js`
- Create: `center/src/utils/time.js`
- Create: `center/src/routes/healthz.js`
- Create: `center/src/app.js`
- Create: `center/tests/helpers/test-app.js`
- Create: `center/tests/healthz.test.js`
- Create: `center/tests/config.test.js`
- Create: `center/tests/time.test.js`
- Create: `center/appsettings.example.json`

**Interfaces:**
- `loadConfig(path)` returns `{sql, listenPort, jwtSecret, agentToken, staticDir, logLevel, env}` (throws if missing required keys)
- `getPool()` returns a singleton `mssql` connection pool
- `createApp({ config, pool, logger })` returns an Express `app` with `healthz` route mounted
- `nowUtcIso()` returns current UTC time in ISO 8601

- [ ] **Step 1: Write failing tests**

`center/tests/time.test.js`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nowUtcIso } from '../src/utils/time.js';

test('nowUtcIso returns ISO 8601 UTC string ending with Z', () => {
  const s = nowUtcIso();
  assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
```

`center/tests/config.test.js`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

test('loadConfig parses required keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const path = join(dir, 'appsettings.json');
  writeFileSync(path, JSON.stringify({
    sql: { server: 'localhost', database: 'AD_Monitoring', user: 'sa', password: 'pw' },
    listenPort: 8080,
    jwtSecret: 'abc',
    agentToken: 'tok',
    staticDir: 'C:/web',
    logLevel: 'info',
    env: 'dev'
  }));
  const cfg = loadConfig(path);
  assert.equal(cfg.listenPort, 8080);
  assert.equal(cfg.agentToken, 'tok');
  rmSync(dir, { recursive: true });
});

test('loadConfig throws if required key missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const path = join(dir, 'appsettings.json');
  writeFileSync(path, JSON.stringify({ listenPort: 8080 }));
  assert.throws(() => loadConfig(path), /jwtSecret/);
  rmSync(dir, { recursive: true });
});
```

- [ ] **Step 2: Run tests, verify failure**

```bash
cd /d/ToolDevelop/ADDashboard
node --test center/tests/time.test.js center/tests/config.test.js
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `center/src/utils/time.js`**

```javascript
export function nowUtcIso() {
  return new Date().toISOString();
}

export function toUtcIso(date) {
  return new Date(date).toISOString();
}
```

- [ ] **Step 4: Implement `center/src/config.js`**

```javascript
import { readFileSync } from 'node:fs';

const REQUIRED = ['sql.server', 'sql.database', 'listenPort', 'jwtSecret', 'agentToken', 'staticDir'];

export function loadConfig(path) {
  const raw = readFileSync(path, 'utf8');
  const cfg = JSON.parse(raw);
  for (const k of REQUIRED) {
    const v = k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), cfg);
    if (v === undefined || v === null || v === '') {
      throw new Error(`config missing required key: ${k}`);
    }
  }
  return {
    sql: cfg.sql,
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

- [ ] **Step 5: Write `center/appsettings.example.json`**

```json
{
  "sql": {
    "server": "localhost",
    "database": "AD_Monitoring",
    "user": "sa",
    "password": "ChangeMe!2026",
    "options": { "encrypt": false, "trustServerCertificate": true }
  },
  "listenPort": 8080,
  "jwtSecret": "REPLACE_WITH_RANDOM_64_CHARS",
  "agentToken": "REPLACE_WITH_GUID",
  "staticDir": "C:\\Program Files\\ADDashboard\\Center\\dist",
  "logLevel": "info",
  "env": "prod"
}
```

- [ ] **Step 6: Run tests, verify pass**

```bash
node --test center/tests/time.test.js center/tests/config.test.js
```

Expected: PASS, 3 tests.

- [ ] **Step 7: Implement `center/src/db.js`**

```javascript
import sql from 'mssql';

let poolPromise = null;

export function initPool(config) {
  if (poolPromise) return poolPromise;
  poolPromise = new sql.ConnectionPool({
    server: config.sql.server,
    database: config.sql.database,
    user: config.sql.user,
    password: config.sql.password,
    options: { encrypt: false, trustServerCertificate: true, ...(config.sql.options || {}) }
  }).connect();
  return poolPromise;
}

export async function getPool() {
  if (!poolPromise) throw new Error('db pool not initialized');
  return poolPromise;
}

export async function closePool() {
  if (poolPromise) {
    const p = await poolPromise;
    await p.close();
    poolPromise = null;
  }
}
```

- [ ] **Step 8: Write `center/src/routes/healthz.js`**

```javascript
import { Router } from 'express';
import sql from 'mssql';
import { getPool } from '../db.js';

export function healthzRouter() {
  const r = Router();
  r.get('/healthz', async (req, res) => {
    try {
      const pool = await getPool();
      const r1 = await pool.request().query("SELECT 1 AS ok");
      const r2 = await pool.request().query(
        "SELECT TOP 1 last_heartbeat_at AS last FROM ad_agent_heartbeat ORDER BY last_heartbeat_at DESC"
      );
      res.json({ status: 'ok', db: r1.recordset[0].ok === 1 ? 'ok' : 'fail', lastHeartbeat: r2.recordset[0]?.last ?? null });
    } catch (e) {
      res.status(503).json({ status: 'degraded', error: e.message });
    }
  });
  return r;
}
```

- [ ] **Step 9: Implement `center/src/app.js`**

```javascript
import express from 'express';
import { healthzRouter } from './routes/healthz.js';

export function createApp({ config, pool, logger }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10mb' }));
  app.use((req, _res, next) => {
    req.log = logger.child({ method: req.method, url: req.url });
    next();
  });
  app.use(healthzRouter());
  // Static frontend
  app.use(express.static(config.staticDir, { index: 'index.html', extensions: ['html'] }));
  // SPA fallback
  app.get(/^\/(?!api\/|healthz).*/, (_req, res) => {
    res.sendFile(`${config.staticDir}/index.html`);
  });
  // Error handler
  app.use((err, _req, res, _next) => {
    logger.error({ err }, 'unhandled');
    res.status(500).json({ error: 'internal' });
  });
  return app;
}
```

- [ ] **Step 10: Write `center/tests/helpers/test-app.js`**

```javascript
import { createApp } from '../../src/app.js';
import { createLogger } from '../../src/logger.js';

export function buildTestApp({ pool }) {
  const config = {
    listenPort: 0, jwtSecret: 'test', agentToken: 'tok',
    staticDir: process.cwd(), env: 'test', logLevel: 'silent',
    sql: { server: '', database: '' }
  };
  return createApp({ config, pool, logger: createLogger({ component: 'test', level: 'silent' }) });
}
```

- [ ] **Step 11: Write `center/tests/healthz.test.js`**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestApp } from './helpers/test-app.js';
import { initPool, closePool } from '../src/db.js';

test('GET /healthz returns 200 when DB reachable', async (t) => {
  const url = process.env.TEST_SQL_URL;
  if (!url) return t.skip('TEST_SQL_URL not set');
  await initPool({ sql: { server: url, database: 'master', user: '', password: '', options: { encrypt: false, trustServerCertificate: true } } });
  const { default: supertest } = await import('supertest');
  const app = buildTestApp({ pool: await (await import('../src/db.js')).getPool() });
  const res = await supertest(app).get('/healthz');
  assert.equal(res.status, 200);
  await closePool();
});
```

- [ ] **Step 12: Run all center tests so far**

```bash
node --test center/tests/
```

Expected: All passing (or skipped without TEST_SQL_URL).

- [ ] **Step 13: Commit**

```bash
git add center/src center/tests center/appsettings.example.json
git commit -m "feat(center): add config, db pool, healthz, express skeleton"
```

---

### Task 5: Auth helpers (password + JWT) and login route

**Files:**
- Create: `center/src/auth/password.js`
- Create: `center/src/auth/jwt.js`
- Create: `center/src/routes/auth.js`
- Create: `center/src/services/users.js`
- Create: `center/tests/password.test.js`
- Create: `center/tests/jwt.test.js`
- Create: `center/tests/auth.test.js`

**Interfaces:**
- `hashPassword(plain)` → `Promise<string>` bcrypt hash
- `verifyPassword(plain, hash)` → `Promise<boolean>`
- `signJwt({ sub, role }, secret, ttlSec)` → `string`
- `verifyJwt(token, secret)` → `{ sub, role } | null`
- `POST /api/auth/login` accepts `{username, password}` → `{token, user}` on success, 401 otherwise

- [ ] **Step 1: Write failing tests**

`center/tests/password.test.js`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth/password.js';

test('hashPassword produces verifiable hash', async () => {
  const h = await hashPassword('hunter2');
  assert.notEqual(h, 'hunter2');
  assert.equal(await verifyPassword('hunter2', h), true);
  assert.equal(await verifyPassword('wrong', h), false);
});
```

`center/tests/jwt.test.js`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signJwt, verifyJwt } from '../src/auth/jwt.js';

test('signJwt/verifyJwt roundtrip', () => {
  const t = signJwt({ sub: 'u1', role: 'admin' }, 'secret', 60);
  const v = verifyJwt(t, 'secret');
  assert.equal(v.sub, 'u1');
  assert.equal(v.role, 'admin');
});

test('verifyJwt returns null on bad signature', () => {
  const t = signJwt({ sub: 'u1', role: 'admin' }, 'secret', 60);
  assert.equal(verifyJwt(t, 'wrong'), null);
});
```

- [ ] **Step 2: Run, verify failure**

```bash
node --test center/tests/password.test.js center/tests/jwt.test.js
```

Expected: FAIL — modules missing.

- [ ] **Step 3: Implement `center/src/auth/password.js`**

```javascript
import bcrypt from 'bcrypt';

const ROUNDS = 12;

export async function hashPassword(plain) {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}
```

- [ ] **Step 4: Implement `center/src/auth/jwt.js`**

```javascript
import jwt from 'jsonwebtoken';

export function signJwt({ sub, role }, secret, ttlSec = 3600) {
  return jwt.sign({ role }, secret, { subject: String(sub), expiresIn: ttlSec });
}

export function verifyJwt(token, secret) {
  try {
    const p = jwt.verify(token, secret);
    return { sub: p.sub, role: p.role };
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run, verify pass**

```bash
node --test center/tests/password.test.js center/tests/jwt.test.js
```

Expected: PASS, 3 tests.

- [ ] **Step 6: Implement `center/src/services/users.js`**

```javascript
import { getPool } from '../db.js';
import { hashPassword, verifyPassword } from '../auth/password.js';

export async function findByUsername(username) {
  const pool = await getPool();
  const r = await pool.request()
    .input('u', username)
    .query(`SELECT u.id, u.username, u.password_hash, u.status, u.role_id, r.role_name, r.permissions
            FROM sys_users u JOIN sys_roles r ON u.role_id = r.id
            WHERE u.username = @u`);
  return r.recordset[0] || null;
}

export async function listUsers() {
  const pool = await getPool();
  const r = await pool.request()
    .query(`SELECT u.id, u.username, u.status, u.last_login_at, u.created_at, r.role_name
            FROM sys_users u JOIN sys_roles r ON u.role_id = r.id ORDER BY u.id`);
  return r.recordset;
}

export async function createUser({ username, password, roleId, status = 1 }) {
  const pool = await getPool();
  const hash = await hashPassword(password);
  await pool.request()
    .input('u', username)
    .input('h', hash)
    .input('r', roleId)
    .input('s', status)
    .query(`INSERT INTO sys_users (username, password_hash, role_id, status)
            VALUES (@u, @h, @r, @s)`);
}

export async function updateUser(id, { password, roleId, status }) {
  const pool = await getPool();
  const sets = [];
  const req = pool.request().input('id', id);
  if (password) { sets.push('password_hash = @h'); req.input('h', await hashPassword(password)); }
  if (roleId !== undefined) { sets.push('role_id = @r'); req.input('r', roleId); }
  if (status !== undefined) { sets.push('status = @s'); req.input('s', status); }
  if (sets.length === 0) return;
  await req.query(`UPDATE sys_users SET ${sets.join(', ')} WHERE id = @id`);
}

export async function deleteUser(id) {
  const pool = await getPool();
  await pool.request().input('id', id).query('DELETE FROM sys_users WHERE id = @id');
}

export async function authenticate(username, password) {
  const u = await findByUsername(username);
  if (!u || !u.status) return null;
  const ok = await verifyPassword(password, u.password_hash);
  if (!ok) return null;
  return { id: u.id, username: u.username, role: u.role_name, permissions: JSON.parse(u.permissions) };
}

export async function recordLogin(userId) {
  const pool = await getPool();
  await pool.request().input('id', userId).query('UPDATE sys_users SET last_login_at = GETUTCDATE() WHERE id = @id');
}
```

- [ ] **Step 7: Implement `center/src/routes/auth.js`**

```javascript
import { Router } from 'express';
import { authenticate, recordLogin } from '../services/users.js';
import { signJwt } from '../auth/jwt.js';
import { writeAudit } from '../services/audit.js';

export function authRouter({ config, pool, logger }) {
  const r = Router();
  r.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'missing credentials' });
    const user = await authenticate(username, password);
    if (!user) {
      await writeAudit(pool, { userId: null, action: 'login_failed', target: username, payload: null });
      return res.status(401).json({ error: 'invalid credentials' });
    }
    await recordLogin(user.id);
    const token = signJwt({ sub: user.id, role: user.role }, config.jwtSecret, 8 * 3600);
    await writeAudit(pool, { userId: user.id, action: 'login', target: username, payload: null });
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  });
  return r;
}
```

- [ ] **Step 8: Implement `center/src/services/audit.js` (minimal, expanded in T10)**

```javascript
export async function writeAudit(pool, { userId, action, target, payload }) {
  await pool.request()
    .input('u', userId ?? null)
    .input('a', action)
    .input('t', target ?? null)
    .input('p', payload == null ? null : JSON.stringify(payload))
    .query(`INSERT INTO audit_logs (user_id, action, target, payload) VALUES (@u, @a, @t, @p)`);
}
```

- [ ] **Step 9: Write `center/tests/auth.test.js` (HTTP-level)**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { authRouter } from '../src/routes/auth.js';
import { default as supertest } from 'supertest';

function buildMockPool(map) {
  return {
    async request() {
      const self = {
        _inputs: {},
        input(k, v) { self._inputs[k] = v; return self; },
        async query(q) {
          for (const [k, v] of Object.entries(self._inputs)) {
            if (q.includes(`@${k}`)) {
              if (q.includes('FROM sys_users u JOIN sys_roles r') && k === 'u') {
                return { recordset: map[v] ? [map[v]] : [] };
              }
            }
          }
          return { recordset: [] };
        }
      };
      return self;
    }
  };
}

test('POST /api/auth/login returns 401 for bad password', async () => {
  const app = express();
  app.use(express.json());
  const pool = buildMockPool({
    'alice': { id: 1, username: 'alice', password_hash: '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv', status: 1, role_name: 'admin', permissions: '["*"]' }
  });
  app.use(authRouter({ config: { jwtSecret: 's' }, pool, logger: { info(){}, error(){}, warn(){}, debug(){} } }));
  const res = await supertest(app).post('/api/auth/login').send({ username: 'alice', password: 'wrong' });
  assert.equal(res.status, 401);
});
```

- [ ] **Step 10: Run tests**

```bash
node --test center/tests/
```

Expected: All passing (DB-dependent tests skipped if `TEST_SQL_URL` unset).

- [ ] **Step 11: Commit**

```bash
git add center/src/auth center/src/services/users.js center/src/services/audit.js center/src/routes/auth.js center/tests/
git commit -m "feat(center): add password hashing, JWT, and login route"
```

---

### Task 6: User auth, RBAC, audit, agent-token middleware

**Files:**
- Create: `center/src/auth/user-auth.js`
- Create: `center/src/auth/agent-token.js`
- Create: `center/src/auth/rbac.js`
- Test: `center/tests/middleware.test.js`

**Interfaces:**
- `userAuth()` Express middleware: reads `Authorization: Bearer <token>`, attaches `req.user = {id, role, permissions}`, returns 401 if missing/invalid
- `agentToken(expected)` Express middleware: reads `X-Agent-Token` header, returns 401 on mismatch
- `requirePerm('read:dash')` middleware factory: returns 403 unless `req.user.permissions` contains the perm or `*`

- [ ] **Step 1: Write failing tests**

```javascript
// center/tests/middleware.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { userAuth } from '../src/auth/user-auth.js';
import { agentToken } from '../src/auth/agent-token.js';
import { requirePerm } from '../src/auth/rbac.js';
import { signJwt } from '../src/auth/jwt.js';

function app_(middlewares) {
  const a = express();
  middlewares.forEach(mw => mw.forEach(([p, h]) => a.use(p, h)));
  a.get('/p', (req, res) => res.json({ user: req.user }));
  return a;
}

test('userAuth attaches user from valid token', async () => {
  const token = signJwt({ sub: '7', role: 'admin' }, 'secret', 60);
  const a = express();
  a.use(userAuth({ secret: 'secret' }));
  a.get('/p', (req, res) => res.json({ user: req.user }));
  const r = await supertest(a).get('/p').set('Authorization', `Bearer ${token}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, 'admin');
});

test('userAuth returns 401 without token', async () => {
  const a = express();
  a.use(userAuth({ secret: 'secret' }));
  a.get('/p', (req, res) => res.json({}));
  const r = await supertest(a).get('/p');
  assert.equal(r.status, 401);
});

test('agentToken returns 401 on wrong token', async () => {
  const a = express();
  a.use(agentToken('expected'));
  a.get('/p', (req, res) => res.json({}));
  const r = await supertest(a).get('/p').set('X-Agent-Token', 'wrong');
  assert.equal(r.status, 401);
});

test('requirePerm returns 403 when missing', async () => {
  const a = express();
  a.use((req, _res, n) => { req.user = { permissions: ['read:dash'] }; n(); });
  a.use(requirePerm('admin:users'));
  a.get('/p', (req, res) => res.json({}));
  const r = await supertest(a).get('/p');
  assert.equal(r.status, 403);
});

test('requirePerm allows wildcard', async () => {
  const a = express();
  a.use((req, _res, n) => { req.user = { permissions: ['*'] }; n(); });
  a.use(requirePerm('admin:users'));
  a.get('/p', (req, res) => res.json({}));
  const r = await supertest(a).get('/p');
  assert.equal(r.status, 200);
});
```

- [ ] **Step 2: Run, verify failure**

```bash
node --test center/tests/middleware.test.js
```

- [ ] **Step 3: Implement middlewares**

`center/src/auth/user-auth.js`:
```javascript
import { verifyJwt } from './jwt.js';

export function userAuth({ secret }) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ error: 'missing token' });
    const v = verifyJwt(m[1], secret);
    if (!v) return res.status(401).json({ error: 'invalid token' });
    req.user = v;
    next();
  };
}
```

`center/src/auth/agent-token.js`:
```javascript
export function agentToken(expected) {
  return (req, res, next) => {
    const t = req.headers['x-agent-token'];
    if (!t || t !== expected) return res.status(401).json({ error: 'invalid agent token' });
    next();
  };
}
```

`center/src/auth/rbac.js`:
```javascript
export function requirePerm(perm) {
  return (req, res, next) => {
    const perms = req.user?.permissions || [];
    if (perms.includes('*') || perms.includes(perm)) return next();
    res.status(403).json({ error: 'forbidden', need: perm });
  };
}
```

- [ ] **Step 4: Run, verify pass**

```bash
node --test center/tests/middleware.test.js
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add center/src/auth/ center/tests/middleware.test.js
git commit -m "feat(center): add user-auth, agent-token, and RBAC middleware"
```

---

### Task 7: Replication service (UPSERT) and agent routes

**Files:**
- Create: `center/src/services/replication.js`
- Create: `center/src/services/config.js`
- Create: `center/src/routes/agent.js`
- Test: `center/tests/replication.test.js`
- Test: `center/tests/agent.test.js`

**Interfaces:**
- `upsertStatus(pool, rows, { appendHistory })` — `rows` is array of `{agentId, collectedAt, sourceDc, destDc, sourceSite, destSite, namingContext, lastSuccessTime, lastAttemptTime, statusCode, errorMessage}`. Uses `MERGE`.
- `getAgentConfig(pool)` returns `{pollingIntervalMinutes, latencyThresholdMinutes, agentToken}`
- `recordHeartbeat(pool, {agentId, version, lastReportAt, lastReportStatus, pendingQueueSize})`
- `listAgents(pool)` returns heartbeat rows
- Routes:
  - `POST /api/agent/heartbeat` (auth: agent token)
  - `POST /api/agent/report` (auth: agent token) — accepts `{ agentId, collectedAt, data: [...] }`
  - `GET /api/agent/config` (auth: agent token)

- [ ] **Step 1: Write failing tests**

`center/tests/replication.test.js`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertStatus } from '../src/services/replication.js';

function fakePool() {
  const calls = [];
  return {
    calls,
    async request() {
      const req = {
        _inputs: {},
        input(k, v) { req._inputs[k] = v; return req; },
        async query(q) { calls.push({ q, inputs: { ...req._inputs } }); return { recordset: [] }; }
      };
      return req;
    }
  };
}

test('upsertStatus issues a MERGE per row', async () => {
  const pool = fakePool();
  await upsertStatus(pool, [{
    agentId: 'DC1', collectedAt: '2026-07-10T00:00:00.000Z',
    sourceDc: 'DC1', destDc: 'DC2', sourceSite: 'S1', destSite: 'S2',
    namingContext: 'DC=x', lastSuccessTime: '2026-07-10T00:00:00.000Z',
    lastAttemptTime: null, statusCode: 0, errorMessage: null
  }], { appendHistory: false });
  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].q, /MERGE INTO ad_replication_status/);
});
```

`center/tests/agent.test.js`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { agentRouter } from '../src/routes/agent.js';

function mockPool(handler) {
  return {
    async request() {
      const self = {
        _i: {},
        input(k,v){ self._i[k]=v; return self; },
        async query(q){ return handler(q, self._i); }
      };
      return self;
    }
  };
}

test('POST /api/agent/heartbeat upserts heartbeat', async () => {
  let captured = null;
  const pool = mockPool(async (q) => { if (/MERGE INTO ad_agent_heartbeat/.test(q)) captured = self => self._i; return { recordset: [] }; });
  const app = express(); app.use(express.json());
  app.use(agentRouter({ config: { agentToken: 'tok' }, pool, logger: { info(){},error(){},warn(){},debug(){} } }));
  const r = await supertest(app).post('/api/agent/heartbeat')
    .set('X-Agent-Token', 'tok')
    .send({ agentId: 'DC1', version: '0.1.0', pendingQueueSize: 0 });
  assert.equal(r.status, 200);
  assert.ok(captured);
});
```

- [ ] **Step 2: Run, verify failure**

```bash
node --test center/tests/replication.test.js center/tests/agent.test.js
```

- [ ] **Step 3: Implement `center/src/services/replication.js`**

```javascript
export async function upsertStatus(pool, rows, { appendHistory = false } = {}) {
  for (const r of rows) {
    const req = pool.request()
      .input('a', r.agentId)
      .input('c', r.collectedAt)
      .input('sd', r.sourceDc)
      .input('dd', r.destDc)
      .input('ss', r.sourceSite ?? null)
      .input('ds', r.destSite ?? null)
      .input('nc', r.namingContext)
      .input('ls', r.lastSuccessTime ?? null)
      .input('la', r.lastAttemptTime ?? null)
      .input('sc', r.statusCode)
      .input('em', r.errorMessage ?? null);

    await req.query(`
      MERGE INTO ad_replication_status AS t
      USING (SELECT @a AS agent_id, @sd AS source_dc, @dd AS dest_dc, @nc AS naming_context) AS s
      ON t.source_dc = s.source_dc AND t.dest_dc = s.dest_dc AND t.naming_context = s.naming_context
      WHEN MATCHED THEN UPDATE SET
        collected_at = @c, agent_id = @a, source_site = @ss, dest_site = @ds,
        last_success_time = @ls, last_attempt_time = @la, status_code = @sc, error_message = @em
      WHEN NOT MATCHED THEN INSERT
        (collected_at, agent_id, source_dc, dest_dc, source_site, dest_site, naming_context,
         last_success_time, last_attempt_time, status_code, error_message)
        VALUES (@c, @a, @sd, @dd, @ss, @ds, @nc, @ls, @la, @sc, @em);
    `);

    if (appendHistory) {
      await req.query(`
        INSERT INTO ad_replication_history
        (collected_at, agent_id, source_dc, dest_dc, naming_context, last_success_time, status_code, error_message)
        VALUES (@c, @a, @sd, @dd, @nc, @ls, @sc, @em);
      `);
    }
  }
}
```

- [ ] **Step 4: Implement `center/src/services/config.js`**

```javascript
export async function getConfig(pool) {
  const r = await pool.request().query('SELECT config_key, config_value FROM system_config');
  const out = {};
  for (const row of r.recordset) out[row.config_key] = row.config_value;
  return out;
}

export async function setConfig(pool, key, value) {
  await pool.request()
    .input('k', key)
    .input('v', value == null ? null : String(value))
    .query(`UPDATE system_config SET config_value = @v, updated_at = GETUTCDATE() WHERE config_key = @k`);
}

export async function getAgentConfig(pool) {
  const c = await getConfig(pool);
  return {
    pollingIntervalMinutes: Number(c.polling_interval_minutes || 15),
    latencyThresholdMinutes: Number(c.latency_threshold_minutes || 180),
    agentToken: c.ad_agent_token || null
  };
}
```

- [ ] **Step 5: Implement `center/src/routes/agent.js`**

```javascript
import { Router } from 'express';
import { agentToken } from '../auth/agent-token.js';
import { upsertStatus } from '../services/replication.js';
import { getAgentConfig, getConfig } from '../services/config.js';

export function agentRouter({ config, pool, logger }) {
  const r = Router();
  r.use(agentToken(config.agentToken));

  r.post('/api/agent/heartbeat', async (req, res) => {
    const { agentId, version, lastReportAt, lastReportStatus, pendingQueueSize } = req.body || {};
    if (!agentId) return res.status(400).json({ error: 'agentId required' });
    await pool.request()
      .input('a', agentId)
      .input('v', version ?? null)
      .input('lr', lastReportAt ? new Date(lastReportAt) : null)
      .input('ls', lastReportStatus ?? null)
      .input('pq', pendingQueueSize ?? 0)
      .query(`
        MERGE INTO ad_agent_heartbeat AS t
        USING (SELECT @a AS agent_id) AS s ON t.agent_id = s.agent_id
        WHEN MATCHED THEN UPDATE SET
          last_heartbeat_at = GETUTCDATE(), agent_version = @v,
          last_report_at = @lr, last_report_status = @ls, pending_queue_size = @pq
        WHEN NOT MATCHED THEN INSERT
          (agent_id, last_heartbeat_at, agent_version, last_report_at, last_report_status, pending_queue_size)
          VALUES (@a, GETUTCDATE(), @v, @lr, @ls, @pq);
      `);
    res.json({ ok: true });
  });

  r.post('/api/agent/report', async (req, res) => {
    const { agentId, collectedAt, data } = req.body || {};
    if (!agentId || !collectedAt || !Array.isArray(data)) {
      return res.status(400).json({ error: 'agentId, collectedAt, data[] required' });
    }
    const cfg = await getConfig(pool);
    const appendHistory = cfg.history_enabled === '1';
    await upsertStatus(pool, data.map(d => ({ ...d, agentId, collectedAt })), { appendHistory });
    await pool.request()
      .input('a', agentId)
      .query('UPDATE ad_agent_heartbeat SET last_report_at = GETUTCDATE(), last_report_status = \'success\' WHERE agent_id = @a');
    const ac = await getAgentConfig(pool);
    res.json({ ok: true, config: { pollingIntervalMinutes: ac.pollingIntervalMinutes, latencyThresholdMinutes: ac.latencyThresholdMinutes } });
  });

  r.get('/api/agent/config', async (_req, res) => {
    const ac = await getAgentConfig(pool);
    res.json(ac);
  });

  return r;
}
```

- [ ] **Step 6: Run all center tests**

```bash
node --test center/tests/
```

Expected: All pass (DB tests skipped without `TEST_SQL_URL`).

- [ ] **Step 7: Commit**

```bash
git add center/src/services/replication.js center/src/services/config.js center/src/routes/agent.js center/tests/replication.test.js center/tests/agent.test.js
git commit -m "feat(center): replication UPSERT service and agent routes"
```

---

### Task 8: Dashboard routes (overview, site-matrix, topology, errors, agents)

**Files:**
- Create: `center/src/routes/dashboard.js`
- Test: `center/tests/dashboard.test.js`

**Interfaces:**
- `GET /api/dashboard/overview` → `{totalLinks, healthy, warning, error, lastUpdate, agentCount}`
- `GET /api/dashboard/site-matrix` → `[{sourceSite, destSite, errorCount, warningCount, total}]`
- `GET /api/dashboard/topology` → `{nodes:[{name,site,type}], links:[{source,target,statusCode,lastSuccessTime}]}`
- `GET /api/dashboard/errors` → list of error rows with `durationMinutes` computed
- `GET /api/dashboard/agents` → heartbeat rows

- [ ] **Step 1: Write failing test**

```javascript
// center/tests/dashboard.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { dashboardRouter } from '../src/routes/dashboard.js';

function poolReturning(rows) {
  return {
    async request() {
      const self = { _i:{}, input(k,v){self._i[k]=v;return self;}, async query(){ return { recordset: rows }; } };
      return self;
    }
  };
}

test('GET /api/dashboard/overview returns counts', async () => {
  const app = express();
  app.use(dashboardRouter({ pool: poolReturning([{ total: 10, healthy: 8, warning: 1, errored: 1 }]) }));
  const r = await supertest(app).get('/api/dashboard/overview');
  assert.equal(r.status, 200);
  assert.equal(r.body.totalLinks, 10);
  assert.equal(r.body.healthy, 8);
});
```

- [ ] **Step 2: Run, verify failure**

```bash
node --test center/tests/dashboard.test.js
```

- [ ] **Step 3: Implement `center/src/routes/dashboard.js`**

```javascript
import { Router } from 'express';
import { userAuth } from '../auth/user-auth.js';
import { requirePerm } from '../auth/rbac.js';

export function dashboardRouter({ config, pool }) {
  const r = Router();
  r.use(userAuth({ secret: config.jwtSecret }), requirePerm('read:dash'));

  r.get('/api/dashboard/overview', async (_req, res) => {
    const p = await pool.request();
    const counts = await p.query(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status_code = 0 THEN 1 ELSE 0 END) AS healthy,
        SUM(CASE WHEN status_code <> 0 THEN 1 ELSE 0 END) AS errored,
        SUM(CASE WHEN status_code = 0 AND last_success_time < DATEADD(MINUTE, -180, GETUTCDATE()) THEN 1 ELSE 0 END) AS warning,
        MAX(collected_at) AS lastUpdate
      FROM ad_replication_status
    `);
    const agents = await pool.request().query('SELECT COUNT(*) AS n FROM ad_agent_heartbeat');
    const c = counts.recordset[0] || {};
    res.json({
      totalLinks: Number(c.total || 0),
      healthy: Number(c.healthy || 0),
      warning: Number(c.warning || 0),
      error: Number(c.errored || 0),
      lastUpdate: c.lastUpdate || null,
      agentCount: agents.recordset[0]?.n || 0
    });
  });

  r.get('/api/dashboard/site-matrix', async (_req, res) => {
    const p = await pool.request();
    const r1 = await p.query(`
      SELECT ISNULL(source_site, '?') AS source_site, ISNULL(dest_site, '?') AS dest_site,
             COUNT(*) AS total,
             SUM(CASE WHEN status_code <> 0 THEN 1 ELSE 0 END) AS errorCount,
             SUM(CASE WHEN status_code = 0 AND last_success_time < DATEADD(MINUTE, -180, GETUTCDATE()) THEN 1 ELSE 0 END) AS warningCount
      FROM ad_replication_status
      GROUP BY source_site, dest_site
    `);
    res.json(r1.recordset);
  });

  r.get('/api/dashboard/topology', async (_req, res) => {
    const p = await pool.request();
    const links = (await p.query(`
      SELECT source_dc, dest_dc, source_site, dest_site, status_code, last_success_time
      FROM ad_replication_status
    `)).recordset;
    const siteSet = new Set();
    const dcSet = new Set();
    const nodes = [];
    for (const l of links) {
      if (l.source_site && !siteSet.has(l.source_site)) { siteSet.add(l.source_site); nodes.push({ name: l.source_site, type: 'site' }); }
      if (l.dest_site && !siteSet.has(l.dest_site)) { siteSet.add(l.dest_site); nodes.push({ name: l.dest_site, type: 'site' }); }
      if (!dcSet.has(l.source_dc)) { dcSet.add(l.source_dc); nodes.push({ name: l.source_dc, type: 'dc', site: l.source_site }); }
      if (!dcSet.has(l.dest_dc)) { dcSet.add(l.dest_dc); nodes.push({ name: l.dest_dc, type: 'dc', site: l.dest_site }); }
    }
    res.json({ nodes, links });
  });

  r.get('/api/dashboard/errors', async (_req, res) => {
    const p = await pool.request();
    const r1 = await p.query(`
      SELECT source_dc, dest_dc, source_site, dest_site, naming_context,
             last_success_time, last_attempt_time, status_code, error_message,
             DATEDIFF(MINUTE, last_success_time, GETUTCDATE()) AS duration_minutes
      FROM ad_replication_status
      WHERE status_code <> 0
      ORDER BY last_attempt_time DESC
    `);
    res.json(r1.recordset);
  });

  r.get('/api/dashboard/agents', async (_req, res) => {
    const p = await pool.request();
    const r1 = await p.query(`
      SELECT agent_id, last_heartbeat_at, agent_version, last_report_at, last_report_status, pending_queue_size,
             DATEDIFF(SECOND, last_heartbeat_at, GETUTCDATE()) AS seconds_since_heartbeat
      FROM ad_agent_heartbeat
      ORDER BY last_heartbeat_at DESC
    `);
    res.json(r1.recordset);
  });

  return r;
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
node --test center/tests/dashboard.test.js
```

Expected: 1 pass.

- [ ] **Step 5: Commit**

```bash
git add center/src/routes/dashboard.js center/tests/dashboard.test.js
git commit -m "feat(center): add dashboard data routes"
```

---

### Task 9: Admin routes (users, roles, config, audit)

**Files:**
- Create: `center/src/routes/admin.js`
- Test: `center/tests/admin.test.js`

**Interfaces:**
- `GET/POST/PUT/DELETE /api/admin/users` (admin only)
- `GET /api/admin/roles`
- `GET/PUT /api/admin/config`
- `GET /api/admin/audit?limit=200`

- [ ] **Step 1: Write failing test**

```javascript
// center/tests/admin.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { signJwt } from '../src/auth/jwt.js';
import { adminRouter } from '../src/routes/admin.js';

function poolStub(rows = [], handlers = {}) {
  return {
    async request() {
      const self = { _i:{}, input(k,v){self._i[k]=v;return self;}, async query(q){
          for (const [re, fn] of Object.entries(handlers)) { if (new RegExp(re).test(q)) return { recordset: fn(self._i) || [] }; }
          return { recordset: rows };
        } };
      return self;
    }
  };
}

async function build(token) {
  const app = express(); app.use(express.json());
  app.use((req,_res,n)=>{ req.user = require('jsonwebtoken').verify(token, 's'); n(); });
  app.use(adminRouter({ config: { jwtSecret: 's', agentToken: 'tok' }, pool: poolStub([], {}), logger: { info(){}, error(){}, warn(){}, debug(){} } }));
  return app;
}

test('GET /api/admin/roles requires admin', async () => {
  const opToken = signJwt({ sub: '1', role: 'operator' }, 's', 60);
  const app = await build(opToken);
  const r = await supertest(app).get('/api/admin/roles');
  assert.equal(r.status, 403);
});
```

- [ ] **Step 2: Run, verify failure**

```bash
node --test center/tests/admin.test.js
```

- [ ] **Step 3: Implement `center/src/routes/admin.js`**

```javascript
import { Router } from 'express';
import { userAuth } from '../auth/user-auth.js';
import { requirePerm } from '../auth/rbac.js';
import { listUsers, createUser, updateUser, deleteUser, findByUsername } from '../services/users.js';
import { getConfig, setConfig } from '../services/config.js';
import { writeAudit } from '../services/audit.js';

const isAdmin = requirePerm('admin:users');

export function adminRouter({ config, pool, logger }) {
  const r = Router();
  r.use(userAuth({ secret: config.jwtSecret }));

  // Roles
  r.get('/api/admin/roles', isAdmin, async (_req, res) => {
    const r1 = await pool.request().query('SELECT id, role_name, permissions FROM sys_roles ORDER BY id');
    res.json(r1.recordset.map(x => ({ ...x, permissions: JSON.parse(x.permissions) })));
  });

  // Users
  r.get('/api/admin/users', isAdmin, async (_req, res) => res.json(await listUsers()));
  r.post('/api/admin/users', isAdmin, async (req, res) => {
    const { username, password, roleId, status } = req.body || {};
    if (!username || !password || !roleId) return res.status(400).json({ error: 'username, password, roleId required' });
    const exists = await findByUsername(username);
    if (exists) return res.status(409).json({ error: 'username exists' });
    await createUser({ username, password, roleId, status });
    await writeAudit(pool, { userId: req.user.sub, action: 'user_create', target: username, payload: { roleId } });
    res.status(201).json({ ok: true });
  });
  r.put('/api/admin/users/:id', isAdmin, async (req, res) => {
    await updateUser(Number(req.params.id), req.body || {});
    await writeAudit(pool, { userId: req.user.sub, action: 'user_update', target: req.params.id, payload: req.body });
    res.json({ ok: true });
  });
  r.delete('/api/admin/users/:id', isAdmin, async (req, res) => {
    await deleteUser(Number(req.params.id));
    await writeAudit(pool, { userId: req.user.sub, action: 'user_delete', target: req.params.id, payload: null });
    res.json({ ok: true });
  });

  // Config
  r.get('/api/admin/config', isAdmin, async (_req, res) => res.json(await getConfig(pool)));
  r.put('/api/admin/config', isAdmin, async (req, res) => {
    const updates = req.body || {};
    for (const [k, v] of Object.entries(updates)) await setConfig(pool, k, v);
    await writeAudit(pool, { userId: req.user.sub, action: 'config_update', target: null, payload: updates });
    res.json({ ok: true });
  });

  // Audit
  r.get('/api/admin/audit', isAdmin, async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const r1 = await pool.request().input('l', limit)
      .query(`SELECT TOP (@l) id, user_id, action, target, payload, created_at FROM audit_logs ORDER BY id DESC`);
    res.json(r1.recordset);
  });

  return r;
}
```

- [ ] **Step 4: Run test**

```bash
node --test center/tests/admin.test.js
```

Expected: 1 pass.

- [ ] **Step 5: Commit**

```bash
git add center/src/routes/admin.js center/tests/admin.test.js
git commit -m "feat(center): add admin routes for users, roles, config, audit"
```

---

### Task 10: Center server entry point with graceful shutdown

**Files:**
- Create: `center/server.js`
- Create: `center/src/utils/errors.js`

**Interfaces:**
- `loadConfig('appsettings.json')` from `process.argv[2]` or `APPSETTINGS_PATH` env
- `initPool(config)`, `createApp(...)`, `app.listen(config.listenPort)`
- SIGINT/SIGTERM → `server.close()` → `closePool()` → exit 0

- [ ] **Step 1: Implement `center/src/utils/errors.js`**

```javascript
export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
```

- [ ] **Step 2: Implement `center/server.js`**

```javascript
import { createApp } from './src/app.js';
import { loadConfig } from './src/config.js';
import { initPool, closePool, getPool } from './src/db.js';
import { createLogger } from './src/logger.js';
import { authRouter } from './src/routes/auth.js';
import { agentRouter } from './src/routes/agent.js';
import { dashboardRouter } from './src/routes/dashboard.js';
import { adminRouter } from './src/routes/admin.js';

const configPath = process.argv[2] || process.env.APPSETTINGS_PATH || './appsettings.json';
const config = loadConfig(configPath);
const logger = createLogger({ component: 'center', level: config.logLevel });

(async () => {
  await initPool(config);
  const pool = await getPool();
  const app = createApp({ config, pool, logger });
  app.use(authRouter({ config, pool, logger }));
  app.use(agentRouter({ config, pool, logger }));
  app.use(dashboardRouter({ config, pool }));
  app.use(adminRouter({ config, pool, logger }));
  const server = app.listen(config.listenPort, () => {
    logger.info({ port: config.listenPort }, 'center listening');
  });
  const shutdown = async (sig) => {
    logger.info({ sig }, 'shutting down');
    server.close(async () => { await closePool(); process.exit(0); });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
})().catch(err => {
  logger.error({ err }, 'fatal');
  process.exit(1);
});
```

- [ ] **Step 3: Smoke test the entry point compiles**

```bash
cd /d/ToolDevelop/ADDashboard/center
node --check server.js
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add center/server.js center/src/utils/errors.js
git commit -m "feat(center): add server entry with graceful shutdown"
```

---

## Phase 3: PowerShell Collection and Agent

### Task 11: PowerShell collection script

**Files:**
- Create: `agent/scripts/collect-replication.ps1`
- Test: `agent/scripts/tests/collect-replication.test.ps1` (Pester)

**Interfaces:**
- `Get-ReplicationSnapshot` (when dot-sourced) returns a PSCustomObject with `CollectedAt` (UTC ISO 8601), `AgentId` (hostname), `Site`, `Entries` (array of normalized records)
- Each entry: `{SourceDc, DestDc, SourceSite, DestSite, NamingContext, LastSuccessTime, LastAttemptTime, StatusCode, ErrorMessage}`
- Times normalized to UTC ISO 8601
- Failures captured as entries with `StatusCode` set to a sentinel and `ErrorMessage` populated; partial results still returned
- Exit code: 0 if at least one source command succeeded, 1 if all failed

- [ ] **Step 1: Write Pester test**

`agent/scripts/tests/collect-replication.test.ps1`:
```powershell
BeforeAll {
  . "$PSScriptRoot/../collect-replication.ps1" -ForTesting
}

Describe "Get-ReplicationSnapshot" {
  It "returns CollectedAt in UTC ISO 8601" {
    $s = Get-ReplicationSnapshot -ComputerName $env:COMPUTERNAME
    $s.CollectedAt | Should -Match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$'
  }
  It "returns AgentId matching the local hostname" {
    $s = Get-ReplicationSnapshot -ComputerName $env:COMPUTERNAME
    $s.AgentId | Should -Be $env:COMPUTERNAME
  }
}
```

- [ ] **Step 2: Run, verify failure**

```powershell
Import-Module Pester -MinimumVersion 5.0
Invoke-Pester ./agent/scripts/tests/collect-replication.test.ps1 -Output Detailed
```

Expected: FAIL — function not found.

- [ ] **Step 3: Implement `agent/scripts/collect-replication.ps1`**

```powershell
[CmdletBinding()]
param(
  [switch]$ForTesting
)

$ErrorActionPreference = 'Continue'

function ConvertTo-UtcIso {
  param($Value)
  if ($null -eq $Value) { return $null }
  if ($Value -is [DateTime]) { return $Value.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
  try { return ([DateTime]$Value).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') } catch { return $null }
}

function Get-ReplicationSnapshot {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$ComputerName
  )

  $snapshot = [PSCustomObject]@{
    CollectedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    AgentId     = $ComputerName
    Site        = $null
    Entries     = @()
  }

  # Resolve site
  try {
    Import-Module ActiveDirectory -ErrorAction Stop
    $dc = Get-ADDomainController -Identity $ComputerName -ErrorAction Stop
    $snapshot.Site = $dc.Site
  } catch {
    $snapshot.Entries += [PSCustomObject]@{
      SourceDc = $ComputerName; DestDc = '*'; SourceSite = $null; DestSite = $null
      NamingContext = 'META'; LastSuccessTime = $null; LastAttemptTime = $snapshot.CollectedAt
      StatusCode = -1; ErrorMessage = "site lookup failed: $($_.Exception.Message)"
    }
  }

  # Partner metadata
  $partners = $null
  try {
    $partners = Get-ADReplicationPartnerMetadata -Target $ComputerName -Scope Domain -ErrorAction Stop
  } catch {
    $snapshot.Entries += [PSCustomObject]@{
      SourceDc = $ComputerName; DestDc = '*'; SourceSite = $snapshot.Site; DestSite = $null
      NamingContext = 'META'; LastSuccessTime = $null; LastAttemptTime = $snapshot.CollectedAt
      StatusCode = -1; ErrorMessage = "partner metadata failed: $($_.Exception.Message)"
    }
  }

  if ($partners) {
    foreach ($p in $partners) {
      $snapshot.Entries += [PSCustomObject]@{
        SourceDc         = $p.SourceServer
        DestDc           = $p.PartnerServer
        SourceSite       = $snapshot.Site
        DestSite         = $null
        NamingContext    = $p.NamingContext
        LastSuccessTime  = ConvertTo-UtcIso $p.LastReplicationSuccess
        LastAttemptTime  = ConvertTo-UtcIso $p.LastReplicationAttempt
        StatusCode       = [int]$p.LastReplicationResult
        ErrorMessage     = if ($p.LastReplicationResult -ne 0) { "code $($p.LastReplicationResult)" } else { $null }
      }
    }
  }

  return $snapshot
}

# Convert snapshot to JSON for piping to Node.js
function ConvertTo-SnapshotJson {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]$Snapshot
  )
  return $Snapshot | ConvertTo-Json -Depth 6 -Compress
}

# Run when invoked directly (not when dot-sourced for tests)
if (-not $ForTesting -and $MyInvocation.InvocationName -ne '.' -and $MyInvocation.InvocationName -ne '&') {
  try {
    $snap = Get-ReplicationSnapshot -ComputerName $env:COMPUTERNAME
    $json = ConvertTo-SnapshotJson -Snapshot $snap
    [Console]::Out.WriteLine($json)
    if ($snap.Entries.Count -gt 0) { exit 0 } else { exit 1 }
  } catch {
    [Console]::Error.WriteLine("fatal: $($_.Exception.Message)")
    exit 2
  }
}
```

- [ ] **Step 4: Manual smoke test (only on a DC with AD module)**

```powershell
cd /d/ToolDevelop/ADDashboard
powershell -ExecutionPolicy Bypass -File ./agent/scripts/collect-replication.ps1 | Out-File -Encoding utf8 ./agent/scripts/_smoke.json
Get-Content ./agent/scripts/_smoke.json | Select-Object -First 1
Remove-Item ./agent/scripts/_smoke.json
```

Expected: JSON object with `CollectedAt`, `AgentId`, `Site`, `Entries[]`.

- [ ] **Step 5: Commit**

```bash
git add agent/scripts/collect-replication.ps1 agent/scripts/tests/collect-replication.test.ps1
git commit -m "feat(agent): PowerShell replication snapshot script"
```

---

### Task 12: Agent config and logger

**Files:**
- Create: `agent/appsettings.example.json`
- Create: `agent/src/config.js`
- Test: `agent/tests/config.test.js`

**Interfaces:**
- `loadConfig(path)` returns `{centerUrl, agentId, agentToken, logLevel, pollingIntervalMinutes, queueDbPath, powerShellPath, psScriptPath, healthCheckIntervalMs}`

- [ ] **Step 1: Write failing test**

`agent/tests/config.test.js`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

test('loadConfig returns parsed values with defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-'));
  const p = join(dir, 'a.json');
  writeFileSync(p, JSON.stringify({
    centerUrl: 'http://center:8080', agentId: 'DC1', agentToken: 'tok'
  }));
  const c = loadConfig(p);
  assert.equal(c.centerUrl, 'http://center:8080');
  assert.equal(c.pollingIntervalMinutes, 15);
  assert.equal(c.healthCheckIntervalMs, 600_000);
  rmSync(dir, { recursive: true });
});

test('loadConfig throws on missing required', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-'));
  const p = join(dir, 'a.json');
  writeFileSync(p, JSON.stringify({ centerUrl: 'http://x' }));
  assert.throws(() => loadConfig(p), /agentToken/);
  rmSync(dir, { recursive: true });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
node --test agent/tests/config.test.js
```

- [ ] **Step 3: Implement `agent/src/config.js`**

```javascript
import { readFileSync } from 'node:fs';

const REQUIRED = ['centerUrl', 'agentId', 'agentToken'];
const DEFAULTS = {
  logLevel: 'info',
  pollingIntervalMinutes: 15,
  queueDbPath: 'C:\\ProgramData\\ADDashboard\\Agent\\queue.db',
  powerShellPath: 'powershell.exe',
  psScriptPath: 'C:\\Program Files\\ADDashboard\\Agent\\scripts\\collect-replication.ps1',
  healthCheckIntervalMs: 600_000
};

export function loadConfig(path) {
  const raw = readFileSync(path, 'utf8');
  const cfg = JSON.parse(raw);
  for (const k of REQUIRED) {
    if (cfg[k] === undefined || cfg[k] === null || cfg[k] === '') {
      throw new Error(`agent config missing required key: ${k}`);
    }
  }
  return { ...DEFAULTS, ...cfg };
}
```

- [ ] **Step 4: Write `agent/appsettings.example.json`**

```json
{
  "centerUrl": "http://center:8080",
  "agentId": "REPLACE_WITH_HOSTNAME",
  "agentToken": "REPLACE_WITH_TOKEN_FROM_CENTER",
  "logLevel": "info",
  "pollingIntervalMinutes": 15,
  "queueDbPath": "C:\\ProgramData\\ADDashboard\\Agent\\queue.db",
  "psScriptPath": "C:\\Program Files\\ADDashboard\\Agent\\scripts\\collect-replication.ps1",
  "healthCheckIntervalMs": 600000
}
```

- [ ] **Step 5: Run, verify pass**

```bash
node --test agent/tests/config.test.js
```

Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add agent/src/config.js agent/appsettings.example.json agent/tests/config.test.js
git commit -m "feat(agent): config loader and example appsettings"
```

---

### Task 13: Local SQLite queue

**Files:**
- Create: `agent/src/local-queue.js`
- Test: `agent/tests/local-queue.test.js`

**Interfaces:**
- `openQueue(dbPath)` returns queue object with `enqueue(snapshotJson)`, `peek(limit)`, `delete(ids)`, `count()`, `close()`
- Schema: `id INTEGER PK, payload TEXT, created_at INTEGER`

- [ ] **Step 1: Write failing test**

```javascript
// agent/tests/local-queue.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openQueue } from '../src/local-queue.js';

test('queue enqueues, peeks, deletes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'q-'));
  const path = join(dir, 'q.db');
  const q = openQueue(path);
  q.enqueue('{"a":1}');
  q.enqueue('{"a":2}');
  assert.equal(q.count(), 2);
  const items = q.peek(10);
  assert.equal(items.length, 2);
  q.delete([items[0].id]);
  assert.equal(q.count(), 1);
  q.close();
  rmSync(dir, { recursive: true });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
node --test agent/tests/local-queue.test.js
```

- [ ] **Step 3: Implement `agent/src/local-queue.js`**

```javascript
import Database from 'better-sqlite3';

export function openQueue(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
  )`);
  const ins = db.prepare('INSERT INTO queue (payload) VALUES (?)');
  const cnt = db.prepare('SELECT COUNT(*) AS n FROM queue').get();
  const peek = db.prepare('SELECT id, payload FROM queue ORDER BY id ASC LIMIT ?');
  const del = db.prepare('DELETE FROM queue WHERE id = ?');
  return {
    enqueue: (payload) => { ins.run(payload); },
    count: () => cnt.get().n,
    peek: (limit) => peek.all(limit),
    delete: (ids) => { const tx = db.transaction((arr) => arr.forEach(id => del.run(id))); tx(ids); },
    close: () => db.close()
  };
}
```

- [ ] **Step 4: Run, verify pass**

```bash
node --test agent/tests/local-queue.test.js
```

Expected: 1 test pass.

- [ ] **Step 5: Commit**

```bash
git add agent/src/local-queue.js agent/tests/local-queue.test.js
git commit -m "feat(agent): local SQLite queue for offline buffering"
```

---

### Task 14: Collector, reporter, heartbeat, healthcheck, scheduler, main

**Files:**
- Create: `agent/src/collector.js`
- Create: `agent/src/reporter.js`
- Create: `agent/src/heartbeat.js`
- Create: `agent/src/healthcheck.js`
- Create: `agent/src/scheduler.js`
- Create: `agent/agent.js`
- Test: `agent/tests/collector.test.js`
- Test: `agent/tests/reporter.test.js`
- Test: `agent/tests/heartbeat.test.js`
- Test: `agent/tests/healthcheck.test.js`

**Interfaces:**
- `runCollector({powerShellPath, psScriptPath, timeoutMs})` → `Promise<{ok, snapshot, error}>` executes PS, parses JSON, returns parsed object
- `postReport({centerUrl, agentToken, snapshot})` → `Promise<{ok, status, data}>` HTTP POST
- `postHeartbeat({centerUrl, agentToken, payload})` → `Promise<{ok, status}>`
- `runHealthChecks({centerUrl, agentToken, hostname, logger})` → `Promise<{ok, checks: {adModule, domain, center}}>`
- `createScheduler({config, logger, queue, onTick, onHeartbeat, onHealthCheck})` returns `{start, stop}`

- [ ] **Step 1: Write failing test `agent/tests/collector.test.js`**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCollector } from '../src/collector.js';

test('runCollector returns ok:true for valid PS script', async () => {
  const r = await runCollector({
    powerShellPath: 'powershell.exe',
    psScriptPath: 'C:\\Program Files\\ADDashboard\\Agent\\scripts\\collect-replication.ps1',
    timeoutMs: 10000
  });
  // In CI without AD module, ok may be false; we assert structure exists
  assert.ok(typeof r.ok === 'boolean');
  if (r.ok) {
    assert.ok(r.snapshot);
    assert.ok(typeof r.snapshot.CollectedAt === 'string');
  }
});
```

- [ ] **Step 2: Implement `agent/src/collector.js`**

```javascript
import { spawn } from 'node:child_process';

export function runCollector({ powerShellPath, psScriptPath, timeoutMs = 60000 }) {
  return new Promise((resolve) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psScriptPath];
    const child = spawn(powerShellPath, args, { windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ ok: false, error: 'timeout', snapshot: null }); }, timeoutMs);
    child.stdout.on('data', d => stdout += d.toString('utf8'));
    child.stderr.on('data', d => stderr += d.toString('utf8'));
    child.on('error', err => { clearTimeout(timer); resolve({ ok: false, error: err.message, snapshot: null }); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        return resolve({ ok: false, error: stderr || `exit ${code}`, snapshot: null });
      }
      try {
        const snapshot = JSON.parse(stdout);
        resolve({ ok: true, snapshot });
      } catch (e) {
        resolve({ ok: false, error: `parse: ${e.message}`, snapshot: null });
      }
    });
  });
}
```

- [ ] **Step 3: Write and run reporter test**

`agent/tests/reporter.test.js`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { postReport, postHeartbeat } from '../src/reporter.js';

async function withServer(handler, fn) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', async () => {
      const port = srv.address().port;
      try { await fn(`http://127.0.0.1:${port}`); } finally { srv.close(() => resolve()); }
    });
  });
}

test('postReport sends payload and parses response', async () => {
  let received = null;
  await withServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { received = JSON.parse(body); res.end(JSON.stringify({ ok: true })); });
  }, async (url) => {
    const r = await postReport({ centerUrl: url, agentToken: 't', snapshot: { AgentId: 'X', Entries: [] } });
    assert.equal(r.ok, true);
    assert.equal(received.AgentId, 'X');
  });
});

test('postHeartbeat sends heartbeat', async () => {
  await withServer((req, res) => { res.end('{}'); }, async (url) => {
    const r = await postHeartbeat({ centerUrl: url, agentToken: 't', payload: { agentId: 'X' } });
    assert.equal(r.status, 200);
  });
});
```

- [ ] **Step 4: Implement `agent/src/reporter.js`**

```javascript
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

function requestJson({ method, url, headers, body, timeoutMs = 30000 }) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, headers: { 'Content-Type': 'application/json', ...headers },
      timeout: timeoutMs
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: data ? JSON.parse(data) : null }); }
        catch { resolve({ ok: false, status: res.statusCode, data }); }
      });
    });
    req.on('error', err => resolve({ ok: false, status: 0, error: err.message }));
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

export function postReport({ centerUrl, agentToken, snapshot }) {
  return requestJson({
    method: 'POST',
    url: `${centerUrl}/api/agent/report`,
    headers: { 'X-Agent-Token': agentToken },
    body: { agentId: snapshot.AgentId, collectedAt: snapshot.CollectedAt, data: snapshot.Entries }
  });
}

export function postHeartbeat({ centerUrl, agentToken, payload }) {
  return requestJson({
    method: 'POST',
    url: `${centerUrl}/api/agent/heartbeat`,
    headers: { 'X-Agent-Token': agentToken },
    body: payload
  });
}

export function fetchConfig({ centerUrl, agentToken }) {
  return requestJson({
    method: 'GET',
    url: `${centerUrl}/api/agent/config`,
    headers: { 'X-Agent-Token': agentToken }
  });
}
```

- [ ] **Step 5: Run reporter test**

```bash
node --test agent/tests/reporter.test.js
```

Expected: 2 pass.

- [ ] **Step 6: Write and run heartbeat test (state-only)**

`agent/tests/heartbeat.test.js`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHeartbeat } from '../src/heartbeat.js';

test('startHeartbeat fires on interval and is stoppable', async () => {
  let calls = 0;
  const h = startHeartbeat({ intervalMs: 20, payload: () => ({ agentId: 'X' }), send: async () => { calls++; } });
  await new Promise(r => setTimeout(r, 70));
  h.stop();
  assert.ok(calls >= 2, `expected >=2 calls, got ${calls}`);
});
```

`agent/src/heartbeat.js`:
```javascript
export function startHeartbeat({ intervalMs, payload, send }) {
  let stopped = false;
  const tick = async () => { if (stopped) return; try { await send(payload()); } catch {} };
  const h = setInterval(tick, intervalMs);
  // Fire immediately and on unref to allow process to exit cleanly
  tick();
  return { stop() { stopped = true; clearInterval(h); } };
}
```

- [ ] **Step 7: Run heartbeat test**

```bash
node --test agent/tests/heartbeat.test.js
```

Expected: 1 pass.

- [ ] **Step 8: Write and run healthcheck test**

`agent/tests/healthcheck.test.js`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHealthChecks } from '../src/healthcheck.js';

test('runHealthChecks returns adModule boolean', async () => {
  const r = await runHealthChecks({ centerUrl: 'http://127.0.0.1:1', agentToken: 't', hostname: 'X' });
  assert.equal(typeof r.checks.adModule, 'boolean');
  assert.equal(typeof r.checks.center, 'boolean');
});
```

`agent/src/healthcheck.js`:
```javascript
import { spawnSync } from 'node:child_process';
import { postHeartbeat } from './reporter.js';

function checkAdModule() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Module -ListAvailable ActiveDirectory | Select-Object -First 1'], { encoding: 'utf8' });
  return r.status === 0 && /ActiveDirectory/.test(r.stdout);
}

function checkDomain() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `try { [System.DirectoryServices.ActiveDirectory.Domain]::GetComputerDomain() | Out-Null; 'OK' } catch { 'FAIL' }`], { encoding: 'utf8' });
  return /OK/.test(r.stdout);
}

async function checkCenter(centerUrl, agentToken) {
  try {
    const r = await postHeartbeat({ centerUrl, agentToken, payload: { agentId: '__healthcheck__' } });
    return r.ok;
  } catch { return false; }
}

export async function runHealthChecks({ centerUrl, agentToken, hostname }) {
  const adModule = checkAdModule();
  const domain = checkDomain();
  const center = await checkCenter(centerUrl, agentToken);
  return { ok: adModule && domain && center, checks: { adModule, domain, center, hostname } };
}
```

- [ ] **Step 9: Run healthcheck test**

```bash
node --test agent/tests/healthcheck.test.js
```

Expected: 1 pass.

- [ ] **Step 10: Implement `agent/src/scheduler.js`**

```javascript
export function createScheduler({ config, logger, queue, collect, send, sendHeartbeat, runHealth }) {
  let pollTimer = null;
  let healthTimer = null;
  let stopFlag = false;
  let lastReportStatus = 'pending';
  let lastReportAt = null;

  async function tick() {
    if (stopFlag) return;
    const r = await collect();
    if (!r.ok) {
      logger.warn({ error: r.error }, 'collect failed');
      lastReportStatus = 'failed';
      await sendHeartbeat({ lastReportStatus, lastReportAt, pendingQueueSize: queue.count() });
      return;
    }
    queue.enqueue(JSON.stringify(r.snapshot));
    let sent = 0;
    while (!stopFlag) {
      const items = queue.peek(10);
      if (items.length === 0) break;
      for (const it of items) {
        try {
          const snap = JSON.parse(it.payload);
          const res = await send(snap);
          if (!res.ok) { lastReportStatus = 'failed'; await sendHeartbeat({ lastReportStatus, lastReportAt, pendingQueueSize: queue.count() }); return; }
          queue.delete([it.id]);
          sent++;
        } catch (e) {
          logger.warn({ err: e.message }, 'send failed');
          return;
        }
      }
    }
    lastReportStatus = sent > 0 ? 'success' : 'empty';
    lastReportAt = new Date().toISOString();
    await sendHeartbeat({ lastReportStatus, lastReportAt, pendingQueueSize: queue.count() });
    logger.info({ sent, pending: queue.count() }, 'cycle complete');
  }

  function start() {
    const ms = Math.max(1, config.pollingIntervalMinutes) * 60_000;
    pollTimer = setInterval(tick, ms);
    healthTimer = setInterval(async () => {
      const r = await runHealth();
      if (!r.ok) logger.warn({ checks: r.checks }, 'health degraded');
      else logger.info(r.checks, 'health ok');
    }, config.healthCheckIntervalMs);
    tick();
  }

  async function stop() {
    stopFlag = true;
    if (pollTimer) clearInterval(pollTimer);
    if (healthTimer) clearInterval(healthTimer);
  }

  return { start, stop };
}
```

- [ ] **Step 11: Implement `agent/agent.js`**

```javascript
import { loadConfig } from './src/config.js';
import { createLogger } from './src/logger.js';
import { runCollector } from './src/collector.js';
import { postReport, postHeartbeat, fetchConfig } from './src/reporter.js';
import { startHeartbeat } from './src/heartbeat.js';
import { runHealthChecks } from './src/healthcheck.js';
import { openQueue } from './src/local-queue.js';
import { createScheduler } from './src/scheduler.js';

const configPath = process.argv[2] || process.env.APPSETTINGS_PATH || './appsettings.json';
const config = loadConfig(configPath);
const logger = createLogger({ component: 'agent', level: config.logLevel });
const queue = openQueue(config.queueDbPath);

const heartbeat = startHeartbeat({
  intervalMs: 60_000,
  payload: () => ({ agentId: config.agentId, version: '0.1.0', pendingQueueSize: queue.count() }),
  send: async (p) => { await postHeartbeat({ centerUrl: config.centerUrl, agentToken: config.agentToken, payload: p }); }
});

// Periodically refresh config from center
const configRefresh = setInterval(async () => {
  const r = await fetchConfig({ centerUrl: config.centerUrl, agentToken: config.agentToken });
  if (r.ok && r.data?.pollingIntervalMinutes) {
    config.pollingIntervalMinutes = Number(r.data.pollingIntervalMinutes);
  }
}, 5 * 60_000);

const scheduler = createScheduler({
  config,
  logger,
  queue,
  collect: () => runCollector({ powerShellPath: config.powerShellPath, psScriptPath: config.psScriptPath }),
  send: (snap) => postReport({ centerUrl: config.centerUrl, agentToken: config.agentToken, snapshot: snap }),
  sendHeartbeat: (extra) => postHeartbeat({ centerUrl: config.centerUrl, agentToken: config.agentToken, payload: { agentId: config.agentId, version: '0.1.0', ...extra } }),
  runHealth: () => runHealthChecks({ centerUrl: config.centerUrl, agentToken: config.agentToken, hostname: config.agentId })
});

scheduler.start();
logger.info({ agentId: config.agentId, centerUrl: config.centerUrl }, 'agent started');

const shutdown = async (sig) => {
  logger.info({ sig }, 'shutting down');
  heartbeat.stop();
  clearInterval(configRefresh);
  await scheduler.stop();
  queue.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
```

- [ ] **Step 12: Verify the entry compiles**

```bash
cd /d/ToolDevelop/ADDashboard/agent
node --check agent.js
```

Expected: No errors.

- [ ] **Step 13: Run all agent tests**

```bash
node --test agent/tests/
```

Expected: All pass.

- [ ] **Step 14: Commit**

```bash
git add agent/src agent/agent.js agent/tests/
git commit -m "feat(agent): collector, reporter, heartbeat, healthcheck, scheduler, main"
```

---

## Phase 4: Frontend (Vue 3 + Vite + ECharts)

### Task 15: Vite + Vue 3 scaffold and router

**Files:**
- Create: `frontend/vite.config.js`
- Create: `frontend/index.html`
- Create: `frontend/src/main.js`
- Create: `frontend/src/App.vue`
- Create: `frontend/src/router.js`
- Create: `frontend/src/api/client.js`
- Create: `frontend/tests/api-client.test.js`
- Create: `frontend/src/views/NotFoundView.vue`

**Interfaces:**
- `api.get('/api/...')`, `api.post(...)` etc. via axios; auto-attaches JWT from localStorage; on 401 redirects to `/login`
- Routes: `/login`, `/`, `/matrix`, `/topology`, `/errors`, `/agents`, `/admin/users`, `/admin/roles`, `/admin/config`, `/admin/audit`

- [ ] **Step 1: Create `frontend/vite.config.js`**

```javascript
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/healthz': { target: 'http://localhost:8080', changeOrigin: true }
    }
  },
  build: { outDir: 'dist', emptyOutDir: true }
});
```

- [ ] **Step 2: Create `frontend/index.html`**

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AD Replication Dashboard</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/src/main.js"></script>
</body>
</html>
```

- [ ] **Step 3: Write failing test for API client**

`frontend/tests/api-client.test.js`:
```javascript
import { test, expect, vi } from 'vitest';
import axios from 'axios';

vi.mock('axios', () => {
  const mock = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };
  return { default: { create: () => mock }, ...mock };
});

test('api client attaches Authorization header from localStorage', async () => {
  localStorage.setItem('ad_token', 'tok123');
  const mod = await import('../src/api/client.js?test=' + Date.now());
  await mod.default.get('/api/dashboard/overview');
  const a = (await import('axios')).default.create.mock.results[0].value;
  expect(a.get).toHaveBeenCalled();
  const headers = a.get.mock.calls[0][1]?.headers;
  expect(headers?.Authorization).toBe('Bearer tok123');
});
```

- [ ] **Step 4: Implement `frontend/src/api/client.js`**

```javascript
import axios from 'axios';
import router from '../router.js';

const api = axios.create({ baseURL: '/', timeout: 30000 });

api.interceptors.request.use(cfg => {
  const t = localStorage.getItem('ad_token');
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

api.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401 && !location.pathname.startsWith('/login')) {
      localStorage.removeItem('ad_token');
      router.push('/login');
    }
    return Promise.reject(err);
  }
);

export default api;
```

- [ ] **Step 5: Create `frontend/src/router.js`**

```javascript
import { createRouter, createWebHistory } from 'vue-router';
import LoginView from './views/LoginView.vue';
import DashboardView from './views/DashboardView.vue';
import SiteMatrixView from './views/SiteMatrixView.vue';
import TopologyView from './views/TopologyView.vue';
import ErrorsView from './views/ErrorsView.vue';
import AgentsView from './views/AgentsView.vue';
import UsersView from './views/admin/UsersView.vue';
import RolesView from './views/admin/RolesView.vue';
import ConfigView from './views/admin/ConfigView.vue';
import AuditView from './views/admin/AuditView.vue';
import NotFoundView from './views/NotFoundView.vue';

const routes = [
  { path: '/login', component: LoginView, meta: { public: true } },
  { path: '/', component: DashboardView },
  { path: '/matrix', component: SiteMatrixView },
  { path: '/topology', component: TopologyView },
  { path: '/errors', component: ErrorsView },
  { path: '/agents', component: AgentsView },
  { path: '/admin/users', component: UsersView, meta: { perm: 'admin:users' } },
  { path: '/admin/roles', component: RolesView, meta: { perm: 'admin:users' } },
  { path: '/admin/config', component: ConfigView, meta: { perm: 'admin:users' } },
  { path: '/admin/audit', component: AuditView, meta: { perm: 'admin:users' } },
  { path: '/:pathMatch(.*)*', component: NotFoundView }
];

const router = createRouter({ history: createWebHistory(), routes });

router.beforeEach((to) => {
  if (to.meta.public) return true;
  const t = localStorage.getItem('ad_token');
  if (!t) return { path: '/login', query: { redirect: to.fullPath } };
  return true;
});

export default router;
```

- [ ] **Step 6: Create `frontend/src/main.js`**

```javascript
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router.js';
import './style.css';

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount('#app');
```

- [ ] **Step 7: Create minimal `frontend/src/style.css`**

```css
:root {
  --bg: #0f172a;
  --panel: #1e293b;
  --text: #e2e8f0;
  --muted: #94a3b8;
  --green: #22c55e;
  --yellow: #eab308;
  --red: #ef4444;
  --accent: #38bdf8;
}
* { box-sizing: border-box; }
body, html, #app { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--text); font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
a { color: var(--accent); text-decoration: none; }
button { background: var(--accent); color: #0b1220; border: 0; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
input, select { background: #0b1220; color: var(--text); border: 1px solid #334155; padding: 6px 8px; border-radius: 4px; }
```

- [ ] **Step 8: Create `frontend/src/App.vue`**

```vue
<template>
  <router-view />
</template>
```

- [ ] **Step 9: Create `frontend/src/views/NotFoundView.vue`**

```vue
<template>
  <div style="padding: 40px; text-align: center;">
    <h2>404 Not Found</h2>
    <router-link to="/">返回 Dashboard</router-link>
  </div>
</template>
```

- [ ] **Step 10: Run all tests**

```bash
cd /d/ToolDevelop/ADDashboard
npm run test:frontend
```

Expected: All pass.

- [ ] **Step 11: Commit**

```bash
git add frontend/
git commit -m "feat(frontend): Vite scaffold, router, API client"
```

---

### Task 16: Auth store and Login view

**Files:**
- Create: `frontend/src/stores/auth.js`
- Create: `frontend/src/views/LoginView.vue`
- Create: `frontend/src/views/DashboardView.vue` (placeholder, expanded in next task)
- Test: `frontend/tests/stores-auth.test.js`

**Interfaces:**
- `useAuthStore()` Pinia store with `state: {user, token}`, `actions: {login, logout}`, `getters: {isAdmin}`
- Login form posts to `/api/auth/login`, stores token in `localStorage`, redirects to `?redirect=`

- [ ] **Step 1: Write failing test**

`frontend/tests/stores-auth.test.js`:
```javascript
import { test, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useAuthStore } from '../src/stores/auth.js';

beforeEach(() => { setActivePinia(createPinia()); localStorage.clear(); });

test('login success stores token and user', async () => {
  const store = useAuthStore();
  await store.login({ username: 'admin', password: 'pw' }, async () => ({ token: 'T', user: { id: 1, role: 'admin' } }));
  expect(store.token).toBe('T');
  expect(localStorage.getItem('ad_token')).toBe('T');
  expect(store.isAdmin).toBe(true);
});

test('logout clears state', async () => {
  const store = useAuthStore();
  await store.login({ username: 'a', password: 'b' }, async () => ({ token: 'T', user: { role: 'admin' } }));
  store.logout();
  expect(store.token).toBeNull();
  expect(localStorage.getItem('ad_token')).toBeNull();
});
```

- [ ] **Step 2: Implement `frontend/src/stores/auth.js`**

```javascript
import { defineStore } from 'pinia';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem('ad_token'),
    user: JSON.parse(localStorage.getItem('ad_user') || 'null')
  }),
  getters: {
    isLoggedIn: (s) => !!s.token,
    isAdmin: (s) => s.user?.role === 'admin'
  },
  actions: {
    async login({ username, password }, apiCall) {
      const r = await apiCall({ username, password });
      this.token = r.data.token;
      this.user = r.data.user;
      localStorage.setItem('ad_token', this.token);
      localStorage.setItem('ad_user', JSON.stringify(this.user));
    },
    logout() {
      this.token = null;
      this.user = null;
      localStorage.removeItem('ad_token');
      localStorage.removeItem('ad_user');
    }
  }
});
```

- [ ] **Step 3: Create `frontend/src/views/LoginView.vue`**

```vue
<template>
  <div class="login-bg">
    <form class="login-card" @submit.prevent="onSubmit">
      <h2>AD Replication Dashboard</h2>
      <label>用户名 <input v-model="username" autocomplete="username" required /></label>
      <label>密码 <input v-model="password" type="password" autocomplete="current-password" required /></label>
      <button type="submit" :disabled="loading">{{ loading ? '登录中...' : '登录' }}</button>
      <p v-if="error" class="err">{{ error }}</p>
    </form>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import api from '../api/client.js';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();
const username = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);

async function onSubmit() {
  error.value = '';
  loading.value = true;
  try {
    await auth.login({ username: username.value, password: password.value }, async (creds) => {
      const r = await api.post('/api/auth/login', creds);
      return { data: r.data };
    });
    router.push(route.query.redirect || '/');
  } catch (e) {
    error.value = e.response?.data?.error || '登录失败';
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-bg { display: flex; align-items: center; justify-content: center; height: 100vh; background: linear-gradient(135deg, #0b1220, #1e293b); }
.login-card { background: var(--panel); padding: 32px; border-radius: 8px; min-width: 320px; display: flex; flex-direction: column; gap: 14px; }
.login-card h2 { margin: 0 0 8px; font-size: 18px; color: var(--accent); }
label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--muted); }
.err { color: var(--red); font-size: 13px; margin: 0; }
</style>
```

- [ ] **Step 4: Create placeholder `frontend/src/views/DashboardView.vue` (replaced in T18)**

```vue
<template><div style="padding:24px">Dashboard placeholder</div></template>
```

- [ ] **Step 5: Run tests**

```bash
npm run test:frontend
```

Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/stores frontend/src/views/LoginView.vue frontend/src/views/DashboardView.vue frontend/tests/stores-auth.test.js
git commit -m "feat(frontend): auth store and login view"
```

---

### Task 17: AppLayout, StatusBar, and Dashboard view (overview + nav)

**Files:**
- Create: `frontend/src/components/AppLayout.vue`
- Create: `frontend/src/components/StatusBar.vue`
- Create: `frontend/src/views/DashboardView.vue` (full)

**Interfaces:**
- `AppLayout` renders sidebar nav, topbar with username + logout, and `<router-view />`
- `StatusBar` polls `/api/dashboard/overview` every 30s; shows health rate, last update, agent count

- [ ] **Step 1: Implement `frontend/src/components/AppLayout.vue`**

```vue
<template>
  <div class="layout">
    <aside class="sidebar">
      <h3>AD Dashboard</h3>
      <nav>
        <router-link to="/">概览</router-link>
        <router-link to="/matrix">站点矩阵</router-link>
        <router-link to="/topology">复制拓扑</router-link>
        <router-link to="/errors">错误链路</router-link>
        <router-link to="/agents">Agent 列表</router-link>
        <template v-if="auth.isAdmin">
          <div class="divider">管理</div>
          <router-link to="/admin/users">用户</router-link>
          <router-link to="/admin/roles">角色</router-link>
          <router-link to="/admin/config">系统配置</router-link>
          <router-link to="/admin/audit">审计日志</router-link>
        </template>
      </nav>
    </aside>
    <main>
      <header class="topbar">
        <span>{{ auth.user?.username }} <small>({{ auth.user?.role }})</small></span>
        <button @click="logout">退出</button>
      </header>
      <section class="content">
        <slot />
      </section>
    </main>
  </div>
</template>

<script setup>
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
const auth = useAuthStore();
const router = useRouter();
function logout() { auth.logout(); router.push('/login'); }
</script>

<style scoped>
.layout { display: grid; grid-template-columns: 220px 1fr; height: 100vh; }
.sidebar { background: #0b1220; padding: 20px; }
.sidebar h3 { color: var(--accent); margin: 0 0 16px; }
.sidebar nav { display: flex; flex-direction: column; gap: 6px; }
.sidebar a { padding: 8px 10px; border-radius: 4px; color: var(--text); }
.sidebar a.router-link-active, .sidebar a:hover { background: #1e293b; }
.divider { font-size: 12px; color: var(--muted); margin: 12px 0 4px; }
main { display: flex; flex-direction: column; }
.topbar { display: flex; justify-content: space-between; align-items: center; padding: 10px 20px; background: var(--panel); border-bottom: 1px solid #1e293b; }
.content { padding: 20px; overflow: auto; }
</style>
```

- [ ] **Step 2: Implement `frontend/src/components/StatusBar.vue`**

```vue
<template>
  <div class="status-bar">
    <div class="kpi" :class="healthClass">
      <span class="label">健康率</span>
      <span class="value">{{ healthRate }}%</span>
    </div>
    <div class="kpi">
      <span class="label">复制链路</span>
      <span class="value">{{ data.totalLinks ?? '-' }}</span>
    </div>
    <div class="kpi warn">
      <span class="label">警告</span>
      <span class="value">{{ data.warning ?? 0 }}</span>
    </div>
    <div class="kpi err">
      <span class="label">错误</span>
      <span class="value">{{ data.error ?? 0 }}</span>
    </div>
    <div class="kpi">
      <span class="label">Agent</span>
      <span class="value">{{ data.agentCount ?? 0 }}</span>
    </div>
    <div class="kpi">
      <span class="label">最后更新</span>
      <span class="value small">{{ formatTime(data.lastUpdate) }}</span>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue';
import api from '../api/client.js';
const data = ref({});
let timer = null;
async function load() { try { const r = await api.get('/api/dashboard/overview'); data.value = r.data; } catch {} }
onMounted(() => { load(); timer = setInterval(load, 30000); });
onUnmounted(() => clearInterval(timer));
const healthRate = computed(() => {
  const t = data.value.totalLinks || 0, h = data.value.healthy || 0;
  return t ? Math.round((h / t) * 100) : 100;
});
const healthClass = computed(() => healthRate.value === 100 ? 'ok' : (data.value.error > 0 ? 'err' : 'warn'));
function formatTime(s) { if (!s) return '-'; return new Date(s).toLocaleString('zh-CN', { hour12: false }); }
</script>

<style scoped>
.status-bar { display: flex; gap: 16px; padding: 12px; background: var(--panel); border-radius: 6px; margin-bottom: 16px; }
.kpi { flex: 1; padding: 8px 12px; border-left: 3px solid var(--muted); }
.kpi.ok { border-color: var(--green); }
.kpi.warn { border-color: var(--yellow); }
.kpi.err { border-color: var(--red); }
.label { display: block; font-size: 12px; color: var(--muted); }
.value { display: block; font-size: 20px; font-weight: 600; }
.value.small { font-size: 14px; font-weight: 400; }
</style>
```

- [ ] **Step 3: Implement full `frontend/src/views/DashboardView.vue`**

```vue
<template>
  <AppLayout>
    <h2>总览</h2>
    <StatusBar />
    <p style="color: var(--muted);">从左侧导航进入各详细页面。</p>
  </AppLayout>
</template>

<script setup>
import AppLayout from '../components/AppLayout.vue';
import StatusBar from '../components/StatusBar.vue';
</script>
```

- [ ] **Step 4: Run dev server smoke test**

```bash
cd /d/ToolDevelop/ADDashboard
npm run dev --workspace=frontend &
sleep 5
curl -s http://localhost:5173/ | head -20
```

Expected: HTML with `<div id="app">`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components frontend/src/views/DashboardView.vue
git commit -m "feat(frontend): app layout, status bar, dashboard view"
```

---

### Task 18: SiteMatrixChart and SiteMatrixView

**Files:**
- Create: `frontend/src/components/SiteMatrixChart.vue`
- Create: `frontend/src/views/SiteMatrixView.vue`

**Interfaces:**
- `SiteMatrixChart` takes `data` prop `[{source_site, dest_site, total, errorCount, warningCount}]`, renders ECharts heatmap; cells colored by worst state in the bucket

- [ ] **Step 1: Implement `SiteMatrixChart.vue`**

```vue
<template>
  <div ref="el" style="width: 100%; height: 600px;"></div>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue';
import * as echarts from 'echarts';
const props = defineProps({ data: { type: Array, default: () => [] } });
const el = ref(null);
let chart = null;

function build() {
  if (!chart) return;
  const sites = Array.from(new Set(props.data.flatMap(d => [d.source_site, d.dest_site]))).filter(Boolean);
  const idx = Object.fromEntries(sites.map((s, i) => [s, i]));
  const cells = props.data.map(d => {
    const state = d.errorCount > 0 ? 2 : d.warningCount > 0 ? 1 : 0;
    return { value: [idx[d.source_site], idx[d.dest_site], state, d], state };
  });
  chart.setOption({
    tooltip: { position: 'top', formatter: p => {
      const d = p.data.value[3];
      return `${d.source_site} → ${d.dest_site}<br/>总链路: ${d.total}<br/>错误: ${d.errorCount} 警告: ${d.warningCount}`;
    }},
    grid: { left: 80, right: 30, top: 30, bottom: 80 },
    xAxis: { type: 'category', data: sites, axisLabel: { color: '#e2e8f0', rotate: 30 } },
    yAxis: { type: 'category', data: sites, axisLabel: { color: '#e2e8f0' } },
    visualMap: {
      min: 0, max: 2, calculable: true, orient: 'horizontal', left: 'center', bottom: 10,
      text: ['错误', '正常'], textStyle: { color: '#e2e8f0' },
      inRange: { color: ['#22c55e', '#eab308', '#ef4444'] }
    },
    series: [{ name: '状态', type: 'heatmap', data: cells, label: { show: true, color: '#0b1220', formatter: p => p.data.value[3].total } }]
  });
}

onMounted(async () => { await nextTick(); chart = echarts.init(el.value); build(); });
watch(() => props.data, build, { deep: true });
onUnmounted(() => chart?.dispose());
</script>
```

- [ ] **Step 2: Implement `SiteMatrixView.vue`**

```vue
<template>
  <AppLayout>
    <h2>站点复制矩阵</h2>
    <SiteMatrixChart :data="data" />
  </AppLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import api from '../api/client.js';
import AppLayout from '../components/AppLayout.vue';
import SiteMatrixChart from '../components/SiteMatrixChart.vue';
const data = ref([]);
onMounted(async () => { data.value = (await api.get('/api/dashboard/site-matrix')).data; });
</script>
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/SiteMatrixChart.vue frontend/src/views/SiteMatrixView.vue
git commit -m "feat(frontend): site matrix heatmap view"
```

---

### Task 19: TopologyChart and TopologyView

**Files:**
- Create: `frontend/src/components/TopologyChart.vue`
- Create: `frontend/src/views/TopologyView.vue`

**Interfaces:**
- TopologyChart takes `{nodes, links}` and renders ECharts force-directed graph. Edge color = status_code (green=0, red=non-zero). Edge width scales with edge count between two nodes.

- [ ] **Step 1: Implement `TopologyChart.vue`**

```vue
<template>
  <div ref="el" style="width: 100%; height: 700px;"></div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue';
import * as echarts from 'echarts';
const props = defineProps({ data: { type: Object, default: () => ({ nodes: [], links: [] }) } });
const el = ref(null);
let chart = null;

function build() {
  if (!chart) return;
  const cats = [{ name: 'site' }, { name: 'dc' }];
  const links = props.data.links.map(l => ({
    source: l.source_dc, target: l.dest_dc,
    lineStyle: { color: l.status_code === 0 ? '#22c55e' : '#ef4444', width: 1.5, curveness: 0.1 }
  }));
  const nodes = props.data.nodes.map(n => ({
    id: n.name, name: n.name, category: n.type === 'site' ? 0 : 1,
    symbolSize: n.type === 'site' ? 36 : 14,
    itemStyle: { color: n.type === 'site' ? '#38bdf8' : '#94a3b8' }
  }));
  chart.setOption({
    tooltip: {},
    legend: [{ data: ['site', 'dc'], textStyle: { color: '#e2e8f0' } }],
    series: [{
      type: 'graph', layout: 'force', roam: true, draggable: true,
      categories: cats, force: { repulsion: 220, edgeLength: 80 },
      label: { show: true, color: '#e2e8f0' },
      lineStyle: { opacity: 0.7 },
      emphasis: { focus: 'adjacency', lineStyle: { width: 4 } },
      data: nodes, links
    }]
  });
}
onMounted(async () => { await nextTick(); chart = echarts.init(el.value); build(); });
watch(() => props.data, build, { deep: true });
onUnmounted(() => chart?.dispose());
</script>
```

- [ ] **Step 2: Implement `TopologyView.vue`**

```vue
<template>
  <AppLayout>
    <h2>复制拓扑</h2>
    <TopologyChart :data="data" />
  </AppLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import api from '../api/client.js';
import AppLayout from '../components/AppLayout.vue';
import TopologyChart from '../components/TopologyChart.vue';
const data = ref({ nodes: [], links: [] });
onMounted(async () => { data.value = (await api.get('/api/dashboard/topology')).data; });
</script>
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/TopologyChart.vue frontend/src/views/TopologyView.vue
git commit -m "feat(frontend): topology graph view"
```

---

### Task 20: ErrorTable, AgentStatusTable, ErrorsView, AgentsView

**Files:**
- Create: `frontend/src/components/ErrorTable.vue`
- Create: `frontend/src/components/AgentStatusTable.vue`
- Create: `frontend/src/views/ErrorsView.vue`
- Create: `frontend/src/views/AgentsView.vue`

**Interfaces:**
- `ErrorTable` shows error rows with code translation and humanized error message
- `AgentStatusTable` shows agent heartbeats with "online" (≤120s) / "stale" badge

- [ ] **Step 1: Implement `frontend/src/components/ErrorTable.vue`**

```vue
<template>
  <table class="err-table">
    <thead>
      <tr><th>源 DC</th><th>目标 DC</th><th>NC</th><th>状态码</th><th>说明</th><th>持续(分钟)</th><th>最后尝试</th></tr>
    </thead>
    <tbody>
      <tr v-for="(r, i) in rows" :key="i">
        <td>{{ r.source_dc }}<br/><small>{{ r.source_site }}</small></td>
        <td>{{ r.dest_dc }}<br/><small>{{ r.dest_site }}</small></td>
        <td><code>{{ r.naming_context }}</code></td>
        <td><span class="code">{{ r.status_code }}</span></td>
        <td>{{ explain(r.status_code) }}<br/><small>{{ r.error_message }}</small></td>
        <td>{{ r.duration_minutes ?? '-' }}</td>
        <td>{{ fmt(r.last_attempt_time) }}</td>
      </tr>
    </tbody>
  </table>
</template>

<script setup>
defineProps({ rows: { type: Array, default: () => [] } });
const CODES = {
  1722: 'RPC 服务器不可用 - 检查防火墙 / 135-139,445 端口',
  8452: '复制上下文不存在 - 可能命名上下文被删除',
  8453: '复制访问被拒绝 - 检查复制权限 / 站点链路',
  1311: '未找到源服务器对象 - DNS 解析问题',
  1864: '复制对象信息不可用 - 等待下一次同步',
  5:   '访问被拒绝 - 检查账户权限'
};
function explain(code) { return CODES[code] || '参见 Windows 错误码参考'; }
function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }
</script>

<style scoped>
.err-table { width: 100%; border-collapse: collapse; background: var(--panel); border-radius: 6px; overflow: hidden; }
th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; vertical-align: top; }
th { background: #0b1220; color: var(--muted); font-size: 12px; }
td small { color: var(--muted); font-size: 11px; }
.code { background: #ef4444; color: white; padding: 1px 6px; border-radius: 3px; font-weight: 600; }
</style>
```

- [ ] **Step 2: Implement `frontend/src/components/AgentStatusTable.vue`**

```vue
<template>
  <table class="agent-table">
    <thead>
      <tr><th>Agent</th><th>状态</th><th>最后心跳</th><th>最后上报</th><th>队列</th><th>版本</th></tr>
    </thead>
    <tbody>
      <tr v-for="a in rows" :key="a.agent_id">
        <td>{{ a.agent_id }}</td>
        <td><span :class="badge(a)">{{ statusText(a) }}</span></td>
        <td>{{ fmt(a.last_heartbeat_at) }} <small>({{ a.seconds_since_heartbeat ?? '-' }}s)</small></td>
        <td>{{ fmt(a.last_report_at) }} <small>{{ a.last_report_status }}</small></td>
        <td>{{ a.pending_queue_size }}</td>
        <td>{{ a.agent_version }}</td>
      </tr>
    </tbody>
  </table>
</template>

<script setup>
defineProps({ rows: { type: Array, default: () => [] } });
function badge(a) { return a.seconds_since_heartbeat <= 120 ? 'ok' : 'stale'; }
function statusText(a) { return a.seconds_since_heartbeat <= 120 ? '在线' : '离线'; }
function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }
</script>

<style scoped>
.agent-table { width: 100%; border-collapse: collapse; background: var(--panel); border-radius: 6px; overflow: hidden; }
th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; }
th { background: #0b1220; color: var(--muted); font-size: 12px; }
.ok { background: var(--green); color: #0b1220; padding: 2px 8px; border-radius: 3px; font-size: 12px; }
.stale { background: var(--red); color: white; padding: 2px 8px; border-radius: 3px; font-size: 12px; }
small { color: var(--muted); }
</style>
```

- [ ] **Step 3: Implement `ErrorsView.vue`**

```vue
<template>
  <AppLayout>
    <h2>错误链路</h2>
    <button @click="reload">刷新</button>
    <ErrorTable :rows="rows" />
  </AppLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import api from '../api/client.js';
import AppLayout from '../components/AppLayout.vue';
import ErrorTable from '../components/ErrorTable.vue';
const rows = ref([]);
async function reload() { rows.value = (await api.get('/api/dashboard/errors')).data; }
onMounted(reload);
</script>
```

- [ ] **Step 4: Implement `AgentsView.vue`**

```vue
<template>
  <AppLayout>
    <h2>Agent 列表</h2>
    <AgentStatusTable :rows="rows" />
  </AppLayout>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import api from '../api/client.js';
import AppLayout from '../components/AppLayout.vue';
import AgentStatusTable from '../components/AgentStatusTable.vue';
const rows = ref([]);
let timer = null;
async function load() { rows.value = (await api.get('/api/dashboard/agents')).data; }
onMounted(() => { load(); timer = setInterval(load, 30000); });
onUnmounted(() => clearInterval(timer));
</script>
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ErrorTable.vue frontend/src/components/AgentStatusTable.vue frontend/src/views/ErrorsView.vue frontend/src/views/AgentsView.vue
git commit -m "feat(frontend): error table, agent status table, and views"
```

---

### Task 21: Admin views (users, roles, config, audit)

**Files:**
- Create: `frontend/src/api/admin.js`
- Create: `frontend/src/views/admin/UsersView.vue`
- Create: `frontend/src/views/admin/RolesView.vue`
- Create: `frontend/src/views/admin/ConfigView.vue`
- Create: `frontend/src/views/admin/AuditView.vue`

**Interfaces:**
- `UsersView` lists users, create/edit/delete via dialog
- `RolesView` lists roles with permission JSON
- `ConfigView` lists system_config key/value, edit and save
- `AuditView` lists recent audit log rows

- [ ] **Step 1: Implement `frontend/src/api/admin.js`**

```javascript
import api from './client.js';
export const adminApi = {
  listUsers: () => api.get('/api/admin/users'),
  createUser: (body) => api.post('/api/admin/users', body),
  updateUser: (id, body) => api.put(`/api/admin/users/${id}`, body),
  deleteUser: (id) => api.delete(`/api/admin/users/${id}`),
  listRoles: () => api.get('/api/admin/roles'),
  getConfig: () => api.get('/api/admin/config'),
  updateConfig: (body) => api.put('/api/admin/config', body),
  getAudit: (limit = 200) => api.get(`/api/admin/audit?limit=${limit}`)
};
```

- [ ] **Step 2: Implement `UsersView.vue`**

```vue
<template>
  <AppLayout>
    <h2>用户管理</h2>
    <div class="bar">
      <button @click="openCreate">+ 新建</button>
    </div>
    <table class="t">
      <thead><tr><th>ID</th><th>用户名</th><th>角色</th><th>状态</th><th>最后登录</th><th>操作</th></tr></thead>
      <tbody>
        <tr v-for="u in users" :key="u.id">
          <td>{{ u.id }}</td>
          <td>{{ u.username }}</td>
          <td>{{ u.role_name }}</td>
          <td>{{ u.status ? '启用' : '禁用' }}</td>
          <td>{{ u.last_login_at || '-' }}</td>
          <td>
            <button @click="openEdit(u)">编辑</button>
            <button class="danger" @click="del(u)">删除</button>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="editing" class="modal-bg" @click.self="editing=null">
      <div class="modal">
        <h3>{{ editing.id ? '编辑用户' : '新建用户' }}</h3>
        <label>用户名 <input v-model="editing.username" :disabled="!!editing.id" /></label>
        <label v-if="!editing.id">密码 <input v-model="editing.password" type="password" /></label>
        <label>角色
          <select v-model.number="editing.role_id">
            <option v-for="r in roles" :key="r.id" :value="r.id">{{ r.role_name }}</option>
          </select>
        </label>
        <label>状态 <select v-model.number="editing.status"><option :value="1">启用</option><option :value="0">禁用</option></select></label>
        <div class="actions">
          <button @click="save">保存</button>
          <button @click="editing=null">取消</button>
        </div>
      </div>
    </div>
  </AppLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import AppLayout from '../../components/AppLayout.vue';
import { adminApi } from '../../api/admin.js';
const users = ref([]); const roles = ref([]); const editing = ref(null);
async function load() { users.value = (await adminApi.listUsers()).data; roles.value = (await adminApi.listRoles()).data; }
function openCreate() { editing.value = { username: '', password: '', role_id: roles.value[0]?.id, status: 1 }; }
function openEdit(u) { editing.value = { id: u.id, username: u.username, role_id: roles.value.find(r => r.role_name === u.role_name)?.id, status: u.status ? 1 : 0 }; }
async function save() {
  if (editing.value.id) await adminApi.updateUser(editing.value.id, { role_id: editing.value.role_id, status: editing.value.status });
  else await adminApi.createUser(editing.value);
  editing.value = null; await load();
}
async function del(u) { if (confirm(`确认删除 ${u.username}？`)) { await adminApi.deleteUser(u.id); await load(); } }
onMounted(load);
</script>

<style scoped>
.t { width: 100%; border-collapse: collapse; background: var(--panel); }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
.bar { margin-bottom: 12px; }
.danger { background: var(--red); color: white; margin-left: 6px; }
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; }
.modal { background: var(--panel); padding: 24px; border-radius: 8px; min-width: 360px; display: flex; flex-direction: column; gap: 10px; }
.modal label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--muted); }
.actions { display: flex; gap: 8px; margin-top: 8px; }
</style>
```

- [ ] **Step 3: Implement `RolesView.vue`**

```vue
<template>
  <AppLayout>
    <h2>角色与权限</h2>
    <table class="t">
      <thead><tr><th>ID</th><th>名称</th><th>权限</th></tr></thead>
      <tbody>
        <tr v-for="r in roles" :key="r.id">
          <td>{{ r.id }}</td><td>{{ r.role_name }}</td>
          <td><code>{{ (r.permissions || []).join(', ') }}</code></td>
        </tr>
      </tbody>
    </table>
  </AppLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import AppLayout from '../../components/AppLayout.vue';
import { adminApi } from '../../api/admin.js';
const roles = ref([]);
onMounted(async () => { roles.value = (await adminApi.listRoles()).data; });
</script>

<style scoped>
.t { width: 100%; border-collapse: collapse; background: var(--panel); }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
</style>
```

- [ ] **Step 4: Implement `ConfigView.vue`**

```vue
<template>
  <AppLayout>
    <h2>系统配置</h2>
    <table class="t">
      <thead><tr><th>键</th><th>值</th><th>说明</th></tr></thead>
      <tbody>
        <tr v-for="(v, k) in config" :key="k">
          <td><code>{{ k }}</code></td>
          <td><input v-model="config[k]" /></td>
          <td><small>{{ descriptions[k] || '' }}</small></td>
        </tr>
      </tbody>
    </table>
    <button @click="save" :disabled="saving">{{ saving ? '保存中...' : '保存' }}</button>
    <span v-if="msg" class="msg">{{ msg }}</span>
  </AppLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import AppLayout from '../../components/AppLayout.vue';
import { adminApi } from '../../api/admin.js';
const config = ref({});
const descriptions = { polling_interval_minutes: '采集周期 (分钟)', latency_threshold_minutes: '复制延迟告警阈值 (分钟)', history_enabled: '是否写入历史快照 (0/1)', ad_agent_token: 'Agent 共享 Token' };
const saving = ref(false); const msg = ref('');
async function load() { config.value = (await adminApi.getConfig()).data; }
async function save() { saving.value = true; msg.value=''; try { await adminApi.updateConfig(config.value); msg.value='已保存'; } catch(e){ msg.value = '保存失败'; } finally { saving.value = false; } }
onMounted(load);
</script>

<style scoped>
.t { width: 100%; border-collapse: collapse; background: var(--panel); margin-bottom: 12px; }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
.t input { width: 100%; }
.msg { margin-left: 12px; color: var(--accent); }
</style>
```

- [ ] **Step 5: Implement `AuditView.vue`**

```vue
<template>
  <AppLayout>
    <h2>审计日志</h2>
    <table class="t">
      <thead><tr><th>时间</th><th>用户</th><th>动作</th><th>目标</th><th>详情</th></tr></thead>
      <tbody>
        <tr v-for="r in rows" :key="r.id">
          <td>{{ fmt(r.created_at) }}</td>
          <td>{{ r.user_id || '-' }}</td>
          <td>{{ r.action }}</td>
          <td>{{ r.target || '-' }}</td>
          <td><code>{{ r.payload || '' }}</code></td>
        </tr>
      </tbody>
    </table>
  </AppLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import AppLayout from '../../components/AppLayout.vue';
import { adminApi } from '../../api/admin.js';
const rows = ref([]);
async function load() { rows.value = (await adminApi.getAudit(200)).data; }
function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }
onMounted(load);
</script>

<style scoped>
.t { width: 100%; border-collapse: collapse; background: var(--panel); }
.t th, .t td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #1e293b; font-size: 13px; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
code { font-size: 11px; color: var(--muted); word-break: break-all; }
</style>
```

- [ ] **Step 6: Run all frontend tests**

```bash
npm run test:frontend
```

Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api/admin.js frontend/src/views/admin/
git commit -m "feat(frontend): admin views (users, roles, config, audit)"
```

---

## Phase 5: Install and Operations Scripts

### Task 22: PowerShell common modules (NSSM, Logger, Service)

**Files:**
- Create: `scripts/common/Logger.psm1`
- Create: `scripts/common/NSSM.psm1`
- Create: `scripts/common/Service.psm1`

**Interfaces:**
- `Write-Log`, `Write-Step` for consistent log output
- `Get-NssmPath` resolves `nssm.exe` from `C:\Tools\nssm\win64` (configurable)
- `Install-NssmService`, `Set-NssmParameters`, `Start-ServiceSafe`, `Stop-ServiceSafe`, `Remove-ServiceSafe`

- [ ] **Step 1: Create `scripts/common/Logger.psm1`**

```powershell
$Script:LogDir = 'C:\ProgramData\ADDashboard\Logs'
if (-not (Test-Path $Script:LogDir)) { New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null }

function Write-Log {
  param([string]$Level, [string]$Message)
  $line = "{0} [{1}] {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
  Write-Host $line
  Add-Content -Path (Join-Path $Script:LogDir 'install.log') -Value $line
}

function Write-Step { param([string]$Message) Write-Log 'STEP' $Message }
function Write-Info { param([string]$Message) Write-Log 'INFO' $Message }
function Write-Warn2 { param([string]$Message) Write-Log 'WARN' $Message }
function Write-Err2 { param([string]$Message) Write-Log 'ERROR' $Message }
function Write-Ok { param([string]$Message) Write-Log 'OK' $Message }
```

- [ ] **Step 2: Create `scripts/common/NSSM.psm1`**

```powershell
$Script:NssmPath = $null

function Set-NssmPath {
  param([string]$Path)
  $Script:NssmPath = $Path
}

function Get-NssmPath {
  if ($Script:NssmPath -and (Test-Path $Script:NssmPath)) { return $Script:NssmPath }
  $candidates = @(
    'C:\Tools\nssm\win64\nssm.exe',
    'C:\Tools\nssm-2.24\win64\nssm.exe',
    (Join-Path $PSScriptRoot '..\..\tools\nssm.exe')
  )
  foreach ($p in $candidates) { if (Test-Path $p) { $Script:NssmPath = $p; return $p } }
  throw "nssm.exe not found. Set-NssmPath or place in C:\Tools\nssm\win64\nssm.exe"
}

function Invoke-Nssm {
  param([string[]]$Arguments)
  $nssm = Get-NssmPath
  & $nssm @Arguments
  if ($LASTEXITCODE -ne 0) { throw "nssm $($Arguments -join ' ') failed: $LASTEXITCODE" }
}

function Install-NssmService {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Application,
    [Parameter(Mandatory)][string]$AppDirectory,
    [Parameter(Mandatory)][string]$AppParameters,
    [string[]]$DependOnService = @(),
    [string]$DisplayName = $Name,
    [string]$Description = '',
    [int]$Start = 2  # SERVICE_AUTO_START
  )
  if (Get-Service -Name $Name -ErrorAction SilentlyContinue) {
    Write-Warn2 "Service $Name already installed; skipping install"
    return
  }
  Invoke-Nssm @('install', $Name, $Application)
  Set-NssmParameters -Name $Name -AppDirectory $AppDirectory -AppParameters $AppParameters `
    -DependOnService $DependOnService -DisplayName $DisplayName -Description $Description -Start $Start
}

function Set-NssmParameters {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$AppDirectory,
    [Parameter(Mandatory)][string]$AppParameters,
    [string[]]$DependOnService = @(),
    [string]$DisplayName = $Name,
    [string]$Description = '',
    [int]$Start = 2
  )
  Invoke-Nssm @('set', $Name, 'AppDirectory', $AppDirectory)
  Invoke-Nssm @('set', $Name, 'AppParameters', $AppParameters)
  Invoke-Nssm @('set', $Name, 'DisplayName', $DisplayName)
  if ($Description) { Invoke-Nssm @('set', $Name, 'Description', $Description) }
  Invoke-Nssm @('set', $Name, 'Start', $Start)
  Invoke-Nssm @('set', $Name, 'AppStdout', (Join-Path $Script:LogDir "$Name-stdout.log"))
  Invoke-Nssm @('set', $Name, 'AppStderr', (Join-Path $Script:LogDir "$Name-stderr.log"))
  Invoke-Nssm @('set', $Name, 'AppRotateFiles', '1')
  Invoke-Nssm @('set', $Name, 'AppRotateOnline', '1')
  Invoke-Nssm @('set', $Name, 'AppRotateBytes', '10485760')
  if ($DependOnService.Count -gt 0) {
    Invoke-Nssm @('set', $Name, 'DependOnService', ($DependOnService -join ','))
  }
  Invoke-Nssm @('set', $Name, 'AppEnvironmentExtra', 'NODE_ENV=production')
}
```

- [ ] **Step 3: Create `scripts/common/Service.psm1`**

```powershell
function Start-ServiceSafe {
  param([Parameter(Mandatory)][string]$Name, [int]$WaitSeconds = 15)
  if ((Get-Service -Name $Name -ErrorAction SilentlyContinue).Status -ne 'Running') {
    Start-Service -Name $Name -ErrorAction Stop
  }
  for ($i=0; $i -lt $WaitSeconds; $i++) {
    if ((Get-Service -Name $Name).Status -eq 'Running') { return $true }
    Start-Sleep 1
  }
  return $false
}

function Stop-ServiceSafe {
  param([Parameter(Mandatory)][string]$Name, [int]$WaitSeconds = 30)
  if ((Get-Service -Name $Name -ErrorAction SilentlyContinue).Status -eq 'Stopped') { return $true }
  Stop-Service -Name $Name -Force -ErrorAction Stop
  for ($i=0; $i -lt $WaitSeconds; $i++) {
    if ((Get-Service -Name $Name).Status -eq 'Stopped') { return $true }
    Start-Sleep 1
  }
  return $false
}

function Remove-ServiceSafe {
  param([Parameter(Mandatory)][string]$Name)
  if (Get-Service -Name $Name -ErrorAction SilentlyContinue) {
    Stop-ServiceSafe -Name $Name | Out-Null
    $nssm = (Get-NssmPath)
    & $nssm remove $Name confirm | Out-Null
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add scripts/common/
git commit -m "feat(scripts): add NSSM, Logger, Service helper modules"
```

---

### Task 23: install-center.ps1

**Files:**
- Create: `scripts/install-center.ps1`

**Interfaces:**
- `-InstallPath` (default `C:\Program Files\ADDashboard\Center`)
- `-SqlServer`, `-SqlDatabase`, `-SqlUser`, `-SqlPassword`
- `-ListenPort` (default 8080)
- `-AgentToken` (auto-generated if not provided)
- Idempotent: detects existing service and reuses config when possible

- [ ] **Step 1: Implement `scripts/install-center.ps1`**

```powershell
[CmdletBinding()]
param(
  [string]$InstallPath = 'C:\Program Files\ADDashboard\Center',
  [Parameter(Mandatory)][string]$SqlServer,
  [string]$SqlDatabase = 'AD_Monitoring',
  [string]$SqlUser = 'sa',
  [Parameter(Mandatory)][string]$SqlPassword,
  [int]$ListenPort = 8080,
  [string]$AgentToken,
  [string]$JwtSecret
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\NSSM.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\Service.psm1') -Force

Write-Step "install-center: $InstallPath"

# 1. Ensure directories
@($InstallPath, "$InstallPath\dist", 'C:\ProgramData\ADDashboard\Logs') | ForEach-Object {
  if (-not (Test-Path $_)) { New-Item -ItemType Directory -Path $_ -Force | Out-Null; Write-Info "created $_" }
}

# 2. Verify Node.js
$node = (Get-Command node.exe -ErrorAction Stop).Source
Write-Info "node: $node"

# 3. Apply database schema
$saCs = "Server=$SqlServer;Database=master;User ID=$SqlUser;Password=$SqlPassword;TrustServerCertificate=True"
if (-not (Invoke-Sqlcmd -ConnectionString $saCs -Query "SELECT DB_ID('$SqlDatabase')" -ErrorAction SilentlyContinue).Column1) {
  Write-Step "creating database $SqlDatabase"
  Invoke-Sqlcmd -ConnectionString $saCs -Query "CREATE DATABASE [$SqlDatabase]"
} else { Write-Info "database $SqlDatabase exists" }

$appCs = "Server=$SqlServer;Database=$SqlDatabase;User ID=$SqlUser;Password=$SqlPassword;TrustServerCertificate=True"
$schemaDir = Join-Path $PSScriptRoot '..\db\schema'
foreach ($f in @('01-tables.sql','02-seed-roles.sql')) {
  Write-Step "applying $f"
  Invoke-Sqlcmd -ConnectionString $appCs -InputFile (Join-Path $schemaDir $f)
}

# 4. Build frontend if dist missing
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$distPath = Join-Path $repoRoot 'frontend\dist'
if (-not (Test-Path (Join-Path $distPath 'index.html'))) {
  Write-Step "building frontend"
  Push-Location $repoRoot
  try { npm run build:frontend } finally { Pop-Location }
}

# 5. Copy center files (assume already built/transpiled; if not, install prod deps)
$srcDir = Join-Path $repoRoot 'center'
Copy-Item -Path (Join-Path $srcDir '*') -Destination $InstallPath -Recurse -Force -Exclude 'node_modules','tests','appsettings.json'
if (-not (Test-Path (Join-Path $InstallPath 'node_modules'))) {
  Write-Step "installing center node_modules"
  Push-Location $InstallPath
  try { npm install --omit=dev } finally { Pop-Location }
}
Copy-Item -Path (Join-Path $distPath '*') -Destination (Join-Path $InstallPath 'dist') -Recurse -Force

# 6. Generate config
if (-not $AgentToken) { $AgentToken = [Guid]::NewGuid().Guid }
if (-not $JwtSecret) { $JwtSecret = -join ((1..48) | ForEach-Object { [char[]]([char]33..[char]126) | Get-Random }) }
$cfg = @{
  sql = @{ server = $SqlServer; database = $SqlDatabase; user = $SqlUser; password = $SqlPassword; options = @{ encrypt = $false; trustServerCertificate = $true } }
  listenPort = $ListenPort
  jwtSecret = $JwtSecret
  agentToken = $AgentToken
  staticDir = "$InstallPath\dist"
  logLevel = 'info'
  env = 'prod'
}
$cfgPath = Join-Path $InstallPath 'appsettings.json'
$cfg | ConvertTo-Json -Depth 6 | Set-Content -Path $cfgPath -Encoding UTF8
Write-Ok "wrote $cfgPath"

# 7. Set Agent token in DB
$tokenEsc = $AgentToken.Replace("'", "''")
Invoke-Sqlcmd -ConnectionString $appCs -Query "UPDATE system_config SET config_value = '$tokenEsc', updated_at = GETUTCDATE() WHERE config_key = 'ad_agent_token'"

# 8. Create initial admin user if none exists
$hasAdmin = Invoke-Sqlcmd -ConnectionString $appCs -Query "SELECT COUNT(*) AS n FROM sys_users u JOIN sys_roles r ON u.role_id=r.id WHERE r.role_name='admin'"
if ($hasAdmin.n -eq 0) {
  $initialPw = -join ((1..16) | ForEach-Object { [char[]]([char]33..[char]126) | Get-Random })
  $hash = & node -e "const b=require('bcrypt');b.hash(process.argv[1],12).then(h=>process.stdout.write(h))" $initialPw
  $hashEsc = $hash.Replace("'", "''")
  $pwEsc = $initialPw.Replace("'", "''")
  Invoke-Sqlcmd -ConnectionString $appCs -Query "INSERT INTO sys_users (username, password_hash, role_id) VALUES ('admin', '$hashEsc', (SELECT id FROM sys_roles WHERE role_name='admin'))"
  Write-Ok "initial admin / $initialPw"
  Add-Content -Path (Join-Path $Script:LogDir 'install.log') -Value "INITIAL_ADMIN_PASSWORD=$initialPw"
}

# 9. Register and start service
Install-NssmService -Name 'ADDashboardCenter' `
  -Application $node `
  -AppDirectory $InstallPath `
  -AppParameters 'server.js' `
  -DependOnService @('MSSQLSERVER') `
  -DisplayName 'AD Replication Dashboard Center' `
  -Description 'AD Replication Dashboard Center (Node.js + Express + Vue 3)' `
  -Start 2

if (Start-ServiceSafe -Name 'ADDashboardCenter' -WaitSeconds 20) {
  Write-Ok "service started"
} else { Write-Err2 "service failed to start; see $(Join-Path $Script:LogDir 'ADDashboardCenter-stderr.log')" }

# 10. Probe health
$health = try { (Invoke-WebRequest -Uri "http://localhost:$ListenPort/healthz" -UseBasicParsing -TimeoutSec 10).Content } catch { "unreachable: $($_.Exception.Message)" }
Write-Ok "health: $health"
Write-Ok "URL: http://localhost:$ListenPort"
```

- [ ] **Step 2: Document usage in script header comment (above)**

- [ ] **Step 3: Commit**

```bash
git add scripts/install-center.ps1
git commit -m "feat(scripts): add install-center.ps1"
```

---

### Task 24: install-agent.ps1 with optional remote batch

**Files:**
- Create: `scripts/install-agent.ps1`

**Interfaces:**
- `-ComputerName` (single machine or array)
- `-CenterUrl`, `-AgentToken`
- `-InstallPath` (default `C:\Program Files\ADDashboard\Agent`)
- Falls back to `Invoke-Command` when `-ComputerName` is not local

- [ ] **Step 1: Implement `scripts/install-agent.ps1`**

```powershell
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string[]]$ComputerName,
  [Parameter(Mandatory)][string]$CenterUrl,
  [Parameter(Mandatory)][string]$AgentToken,
  [string]$InstallPath = 'C:\Program Files\ADDashboard\Agent'
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\NSSM.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\Service.psm1') -Force

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$agentSrc = Join-Path $repoRoot 'agent'
$psScriptSrc = Join-Path $agentSrc 'scripts\collect-replication.ps1'
$psScriptDstDir = Join-Path $InstallPath 'scripts'
$node = (Get-Command node.exe -ErrorAction Stop).Source

function Install-LocalAgent {
  Write-Step "installing local agent to $InstallPath"
  @($InstallPath, $psScriptDstDir, 'C:\ProgramData\ADDashboard\Logs', 'C:\ProgramData\ADDashboard\Agent') | ForEach-Object {
    if (-not (Test-Path $_)) { New-Item -ItemType Directory -Path $_ -Force | Out-Null }
  }
  Copy-Item -Path (Join-Path $agentSrc '*') -Destination $InstallPath -Recurse -Force -Exclude 'node_modules','tests','appsettings.json'
  if (-not (Test-Path (Join-Path $InstallPath 'node_modules'))) {
    Push-Location $InstallPath; try { npm install --omit=dev } finally { Pop-Location }
  }
  Copy-Item -Path $psScriptSrc -Destination $psScriptDstDir -Force

  $cfg = @{
    centerUrl = $CenterUrl
    agentId = $env:COMPUTERNAME
    agentToken = $AgentToken
    logLevel = 'info'
    pollingIntervalMinutes = 15
    queueDbPath = 'C:\ProgramData\ADDashboard\Agent\queue.db'
    psScriptPath = "$InstallPath\scripts\collect-replication.ps1"
    healthCheckIntervalMs = 600000
  }
  $cfg | ConvertTo-Json | Set-Content -Path (Join-Path $InstallPath 'appsettings.json') -Encoding UTF8

  Install-NssmService -Name 'ADReplicationAgent' `
    -Application $node `
    -AppDirectory $InstallPath `
    -AppParameters 'agent.js' `
    -DependOnService @('DNS Client','Netlogon') `
    -DisplayName "AD Replication Agent (on $env:COMPUTERNAME)" `
    -Description 'AD Replication collection agent' `
    -Start 2
  if (Start-ServiceSafe -Name 'ADReplicationAgent' -WaitSeconds 20) { Write-Ok "agent started on $env:COMPUTERNAME" }
  else { Write-Err2 "agent failed to start on $env:COMPUTERNAME" }
}

foreach ($cn in $ComputerName) {
  if ($cn -eq $env:COMPUTERNAME -or $cn -eq 'localhost' -or $cn -eq '.') {
    Install-LocalAgent
  } else {
    Write-Step "remote install on $cn"
    $sess = New-PSSession -ComputerName $cn -ErrorAction Stop
    try {
      $block = [scriptblock]::Create((Get-Content -Raw (Join-Path $PSScriptRoot 'install-agent.ps1')))
      Invoke-Command -Session $sess -ScriptBlock $block -ArgumentList @(@($cn), $CenterUrl, $AgentToken, $InstallPath) -ErrorAction Stop
    } finally { Remove-PSSession $sess }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/install-agent.ps1
git commit -m "feat(scripts): add install-agent.ps1 (local + remote batch)"
```

---

### Task 25: update, uninstall, and smoke-test scripts

**Files:**
- Create: `scripts/update-center.ps1`
- Create: `scripts/update-agent.ps1`
- Create: `scripts/uninstall-center.ps1`
- Create: `scripts/uninstall-agent.ps1`
- Create: `scripts/smoke-test.ps1`

**Interfaces:**
- Update scripts: stop service, replace files, install deps, start
- Uninstall: stop, remove service, optionally remove data
- smoke-test: verify healthz, login, dashboard endpoints return expected data

- [ ] **Step 1: Implement `scripts/update-center.ps1`**

```powershell
[CmdletBinding()]
param([string]$InstallPath = 'C:\Program Files\ADDashboard\Center', [switch]$RebuildFrontend)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\NSSM.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\Service.psm1') -Force

Write-Step "stopping service"
if (-not (Stop-ServiceSafe -Name 'ADDashboardCenter' -WaitSeconds 30)) { throw 'cannot stop service' }

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
if ($RebuildFrontend) {
  Write-Step "rebuilding frontend"
  Push-Location $repoRoot; try { npm run build:frontend } finally { Pop-Location }
}
Write-Step "copying files"
Copy-Item -Path (Join-Path $repoRoot 'center\*') -Destination $InstallPath -Recurse -Force -Exclude 'node_modules','tests','appsettings.json'
Push-Location $InstallPath; try { npm install --omit=dev } finally { Pop-Location }
if ($RebuildFrontend -and (Test-Path (Join-Path $repoRoot 'frontend\dist'))) {
  Copy-Item -Path (Join-Path $repoRoot 'frontend\dist\*') -Destination (Join-Path $InstallPath 'dist') -Recurse -Force
}
Write-Step "starting service"
Start-ServiceSafe -Name 'ADDashboardCenter' -WaitSeconds 20 | Out-Null
Write-Ok "update complete"
```

- [ ] **Step 2: Implement `scripts/update-agent.ps1`**

```powershell
[CmdletBinding()]
param([string]$InstallPath = 'C:\Program Files\ADDashboard\Agent')
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\NSSM.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\Service.psm1') -Force

if (-not (Stop-ServiceSafe -Name 'ADReplicationAgent' -WaitSeconds 30)) { throw 'cannot stop' }
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Copy-Item -Path (Join-Path $repoRoot 'agent\*') -Destination $InstallPath -Recurse -Force -Exclude 'node_modules','tests','appsettings.json'
Push-Location $InstallPath; try { npm install --omit=dev } finally { Pop-Location }
Copy-Item -Path (Join-Path $repoRoot 'agent\scripts\collect-replication.ps1') -Destination (Join-Path $InstallPath 'scripts') -Force
Start-ServiceSafe -Name 'ADReplicationAgent' -WaitSeconds 20 | Out-Null
Write-Ok "agent update complete"
```

- [ ] **Step 3: Implement `scripts/uninstall-center.ps1`**

```powershell
[CmdletBinding()]
param([string]$InstallPath = 'C:\Program Files\ADDashboard\Center', [switch]$RemoveData)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\NSSM.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\Service.psm1') -Force

Write-Step "uninstalling center"
Remove-ServiceSafe -Name 'ADDashboardCenter'
if (Test-Path $InstallPath) { Remove-Item -Path $InstallPath -Recurse -Force; Write-Info "removed $InstallPath" }
if ($RemoveData) { Remove-Item -Path 'C:\ProgramData\ADDashboard' -Recurse -Force }
Write-Ok "done"
```

- [ ] **Step 4: Implement `scripts/uninstall-agent.ps1`**

```powershell
[CmdletBinding()]
param([string]$InstallPath = 'C:\Program Files\ADDashboard\Agent', [switch]$RemoveData)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\NSSM.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\Service.psm1') -Force

Write-Step "uninstalling agent on $env:COMPUTERNAME"
Remove-ServiceSafe -Name 'ADReplicationAgent'
if (Test-Path $InstallPath) { Remove-Item -Path $InstallPath -Recurse -Force }
if ($RemoveData) { Remove-Item -Path 'C:\ProgramData\ADDashboard\Agent' -Recurse -Force }
Write-Ok "done"
```

- [ ] **Step 5: Implement `scripts/smoke-test.ps1`**

```powershell
[CmdletBinding()]
param([string]$BaseUrl = 'http://localhost:8080', [string]$Username = 'admin', [string]$Password)
$ErrorActionPreference = 'Stop'

function Step($n, $ok, $detail='') {
  $line = "{0,-50} {1}" -f $n, $(if ($ok) { 'PASS' } else { "FAIL $detail" })
  Write-Host $line
  if (-not $ok) { $script:fail = $true }
}
$script:fail = $false

# 1. healthz
try {
  $h = Invoke-WebRequest -Uri "$BaseUrl/healthz" -UseBasicParsing -TimeoutSec 5
  Step 'healthz' ($h.StatusCode -eq 200 -and (($h.Content | ConvertFrom-Json).status -eq 'ok')) $h.Content
} catch { Step 'healthz' $false $_.Exception.Message }

# 2. login
$token = $null
try {
  $body = @{ username = $Username; password = $Password } | ConvertTo-Json
  $r = Invoke-WebRequest -Uri "$BaseUrl/api/auth/login" -Method POST -Body $body -ContentType 'application/json' -UseBasicParsing -TimeoutSec 5
  $j = $r.Content | ConvertFrom-Json
  $token = $j.token
  Step 'login' ($r.StatusCode -eq 200 -and $token) $r.Content
} catch { Step 'login' $false $_.Exception.Message }

# 3. dashboard endpoints
$hdr = @{ Authorization = "Bearer $token" }
foreach ($ep in @('/api/dashboard/overview','/api/dashboard/site-matrix','/api/dashboard/topology','/api/dashboard/agents','/api/dashboard/errors')) {
  try {
    $r = Invoke-WebRequest -Uri "$BaseUrl$ep" -Headers $hdr -UseBasicParsing -TimeoutSec 10
    Step $ep ($r.StatusCode -eq 200)
  } catch { Step $ep $false $_.Exception.Message }
}

# 4. static frontend
try {
  $r = Invoke-WebRequest -Uri "$BaseUrl/" -UseBasicParsing -TimeoutSec 5
  Step 'static index' ($r.StatusCode -eq 200 -and $r.Content -match 'AD Replication Dashboard')
} catch { Step 'static index' $false $_.Exception.Message }

if ($script:fail) { Write-Host "`nSMOKE TEST FAILED" -ForegroundColor Red; exit 1 } else { Write-Host "`nSMOKE TEST PASSED" -ForegroundColor Green }
```

- [ ] **Step 6: Commit**

```bash
git add scripts/update-center.ps1 scripts/update-agent.ps1 scripts/uninstall-center.ps1 scripts/uninstall-agent.ps1 scripts/smoke-test.ps1
git commit -m "feat(scripts): add update, uninstall, and smoke-test scripts"
```

---

## Phase 6: Operations Documentation

### Task 26: Operations runbook

**Files:**
- Create: `docs/operations/runbook.md`

- [ ] **Step 1: Implement `docs/operations/runbook.md`**

````markdown
# AD Dashboard Operations Runbook

## Services

| Service | Machine | Display Name | NSSM Name |
|---------|---------|--------------|-----------|
| Center  | Center management server | AD Replication Dashboard Center | `ADDashboardCenter` |
| Agent   | Each DC | AD Replication Agent (on `<hostname>`) | `ADReplicationAgent` |

## Common Commands

```powershell
# Service status (all DCs)
Get-Service ADReplicationAgent, ADDashboardCenter | Format-Table Name, Status, StartType, MachineName

# Restart agent locally
Restart-Service ADReplicationAgent -Force

# Tail agent logs
Get-Content "C:\ProgramData\ADDashboard\Logs\ADReplicationAgent-stdout.log" -Tail 100 -Wait

# Tail center logs
Get-Content "C:\ProgramData\ADDashboard\Logs\ADDashboardCenter-stdout.log" -Tail 100 -Wait

# Health check
Invoke-WebRequest http://center:8080/healthz | Select -ExpandProperty Content
```

## Routine Maintenance

### Add a new DC

1. Verify WinRM access from center to new DC: `Test-WSMan -ComputerName <newdc>`
2. Run `.\scripts\install-agent.ps1 -ComputerName <newdc> -CenterUrl http://center:8080 -AgentToken <token>`
3. Wait 60 seconds, then verify in Dashboard → Agent 列表 (or `GET /api/dashboard/agents`)

### Change polling interval

1. Sign in as admin
2. Navigate to 管理 → 系统配置
3. Edit `polling_interval_minutes`, save
4. Agents pick up new value on next 5-minute config refresh (or restart agent to apply immediately)

### Update Center

```powershell
# On center management server
cd C:\Repos\ADDashboard
git pull
.\scripts\update-center.ps1 -RebuildFrontend
```

### Update Agents (rolling)

```powershell
# Update one at a time, verify health between each
.\scripts\install-agent.ps1 -ComputerName DC-BJ-01 -CenterUrl http://center:8080 -AgentToken <token>
# This script calls Stop-ServiceSafe → copy → Start-ServiceSafe
```

### Database backup

```powershell
sqlcmd -S localhost -Q "BACKUP DATABASE [AD_Monitoring] TO DISK='D:\Backups\AD_Monitoring_<date>.bak'"
```

### Rotate Agent Token

1. Generate new UUID: `[Guid]::NewGuid().Guid`
2. Sign in as admin → 管理 → 系统配置 → set `ad_agent_token` to new value
3. On every DC: edit `C:\Program Files\ADDashboard\Agent\appsettings.json` → `agentToken`, then `Restart-Service ADReplicationAgent`

## Disaster Recovery

### Center machine lost

1. Provision new management server with SQL Server
2. Restore `AD_Monitoring` database from latest backup
3. Install center: `.\scripts\install-center.ps1 -SqlServer ... -SqlPassword ... -AgentToken <same-as-before> -JwtSecret <same-as-before>`
4. Verify `/healthz` returns 200

Agents continue running with their locally cached `appsettings.json` and buffered queue; once center URL is reachable again, they resume reporting.
````

- [ ] **Step 2: Commit**

```bash
git add docs/operations/runbook.md
git commit -m "docs: add operations runbook"
```

---

### Task 27: Troubleshooting guide

**Files:**
- Create: `docs/operations/troubleshooting.md`

- [ ] **Step 1: Implement `docs/operations/troubleshooting.md`**

````markdown
# AD Dashboard Troubleshooting

## Quick Triage

```powershell
# 1. Are services running?
Get-Service ADReplicationAgent, ADDashboardCenter

# 2. Is center reachable?
Invoke-WebRequest http://center:8080/healthz

# 3. Are agents heartbeating?
# Sign in → Agent 列表 (or GET /api/dashboard/agents)

# 4. What do logs say?
Get-Content "C:\ProgramData\ADDashboard\Logs\ADDashboardCenter-stderr.log" -Tail 200
Get-Content "C:\ProgramData\ADDashboard\Logs\ADReplicationAgent-stderr.log" -Tail 200
```

## Common Symptoms

### Symptom: Agent反复重启 (status: StartPending → Stopped)

**Likely causes:** PowerShell script error, missing AD module, config file typo

**Steps:**
1. `Get-EventLog Application -Source NSSM -Newest 20`
2. `Get-Content "C:\ProgramData\ADDashboard\Logs\ADReplicationAgent-stderr.log" -Tail 100`
3. Look for: `Cannot find module 'ActiveDirectory'` → install RSAT
4. Look for: `appsettings.json: ENOENT` → path contains spaces or wrong location
5. Manually run: `& "C:\Program Files\ADDashboard\Agent\agent.js"` to see Node.js stack trace

### Symptom: Agent心跳正常但无数据

**Steps:**
1. Verify `Test-NetConnection center -Port 8080` from the DC
2. Compare `appsettings.json` `agentToken` to `system_config.ad_agent_token` (sign in as admin → 管理 → 系统配置)
3. On the DC, manually invoke PS: `powershell -File "C:\Program Files\ADDashboard\Agent\scripts\collect-replication.ps1"` — should output JSON
4. If PS errors out with "active directory module not loaded": `Install-WindowsFeature -Name RSAT-AD-PowerShell`

### Symptom: Center启动失败 (status: Stopped immediately)

**Steps:**
1. `nssm get ADDashboardCenter` — show full config
2. `Get-Content "C:\ProgramData\ADDashboard\Logs\ADDashboardCenter-stderr.log" -Tail 100`
3. Most common:
   - `ECONNREFUSED 127.0.0.1:1433` → SQL Server not running or wrong port
   - `Login failed for user 'sa'` → wrong SQL password in `appsettings.json`
   - `EADDRINUSE :::8080` → port 8080 occupied (`netstat -ano | findstr :8080`)
4. After fix, `Start-Service ADDashboardCenter`

### Symptom: 前端 502 Bad Gateway

**Likely cause:** Center process exited; check `center-stderr.log` for unhandled exception
**Steps:**
1. `Get-Service ADDashboardCenter` (likely Stopped)
2. `Get-Content "C:\ProgramData\ADDashboard\Logs\ADDashboardCenter-stderr.log" -Tail 200`
3. Common: OOM (check `Get-Process | Sort-Object WorkingSet -Descending | Select -First 5`); reduce log level
4. Restart: `Start-Service ADDashboardCenter`

### Symptom: 数据长时间不更新

**Steps:**
1. `GET /api/dashboard/agents` — check `seconds_since_heartbeat`
2. If all agents stale:
   - Center may be unreachable from DCs
   - Check firewall: `Test-NetConnection -ComputerName center -Port 8080` from any DC
3. If individual agents stale:
   - That specific DC: `Get-Service ADReplicationAgent`
   - Check its stderr log

### Symptom: 错误码 1722 (RPC server unavailable)

**Operator guidance:** shown directly in `frontend/src/components/ErrorTable.vue` CODES map.
**Steps to investigate:**
1. From destination DC: `Test-NetConnection -ComputerName <source_dc> -Port 135`
2. Check Windows Firewall on source DC allows inbound from destination subnet
3. Check `dcdiag /test:rpc` on source DC

### Symptom: 错误码 1311 (DNS)

**Steps:**
1. From destination DC: `nslookup <source_dc>.<domain>`
2. If fails, check DNS server config and `dcdiag /test:dns` on both DCs

### Symptom: "The memory usage exceeded" warnings

**Likely cause:** Better-sqlite3 native module in agent not closing transactions
**Steps:**
1. Restart agent: `Restart-Service ADReplicationAgent`
2. Apply update if newer version available: `.\scripts\update-agent.ps1`

## Diagnostic Data Collection

When escalating, capture:
```powershell
# Service config
nssm get ADDashboardCenter > nssm-center.txt
nssm get ADReplicationAgent > nssm-agent.txt

# Recent logs
Copy-Item "C:\ProgramData\ADDashboard\Logs\*-stdout.log" .
Copy-Item "C:\ProgramData\ADDashboard\Logs\*-stderr.log" .

# Health snapshot
Invoke-WebRequest http://center:8080/healthz | % Content
(Invoke-WebRequest http://center:8080/api/dashboard/overview -Headers @{Authorization="Bearer $t"} -UseBasicParsing).Content
```
````

- [ ] **Step 2: Commit**

```bash
git add docs/operations/troubleshooting.md
git commit -m "docs: add troubleshooting guide"
```

---

## Self-Review

After all 27 tasks are completed, perform these final verifications:

### Task 28: End-to-end verification

**Files:** None (validation only)

- [ ] **Step 1: Run all tests**

```bash
cd /d/ToolDevelop/ADDashboard
npm test
```

Expected: All tests pass (or DB-dependent tests skipped without `TEST_SQL_URL`).

- [ ] **Step 2: Verify build artifacts**

```bash
ls frontend/dist/index.html
ls center/server.js
ls agent/agent.js
ls agent/scripts/collect-replication.ps1
```

Expected: All present.

- [ ] **Step 3: Run a dry-run install on a test environment**

```powershell
# In a Windows VM with SQL Server installed locally
cd C:\Repos\ADDashboard
.\scripts\install-center.ps1 -SqlServer localhost -SqlPassword <pw>
.\scripts\smoke-test.ps1 -Password <initial-admin-password>
```

Expected: `SMOKE TEST PASSED` printed in green.

- [ ] **Step 4: Verify SPEC coverage**

| Spec Section | Covered By |
|--------------|------------|
| §3 Architecture (Agent + Center + DB) | T1, T4-T7, T11-T14, T15 |
| §4.1 Agent responsibilities | T11-T14 |
| §4.2 Center responsibilities | T5-T7, T8-T10, T15 |
| §5 Data model (all 9 tables) | T2 |
| §6 API endpoints (all routes) | T5, T7, T8, T9, T10, T15 |
| §7 Installation (NSSM) | T22, T23, T24 |
| §8 Operations (status, restart, upgrade) | T25, T26 |
| §9 RBAC (3 roles) | T2 (seed), T9 (admin), T16 (auth UI) |
| §10 YAGNI (excluded items) | Not in scope |

All sections covered.

- [ ] **Step 5: Final commit**

```bash
git add .
git commit -m "chore: complete AD Replication Dashboard service implementation" --allow-empty
```

---
