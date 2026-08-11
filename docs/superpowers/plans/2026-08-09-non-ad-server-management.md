# Non-AD Server Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class support for Windows member servers (non-AD) to the dashboard: self-register on first agent boot, run the built-in `ad_os_baseline` v2 monitoring package per server, and deliver email alerts via SMTP when rule conditions fire.

**Architecture:** Extend the existing v2 plugin pipeline (manifest → installer → metricstore → DDL sandbox) with one new field (`agent.type`), eight new tables, two new async loops (`AlertEvaluationLoop`, `EmailDeliveryLoop`) modeled on `ProbeLoop`, two new HTTP routers (member servers + server groups), four new Vue pages, one built-in package shipped under `publish/center/data/packages/`, and an `agentType` switch in the agent runtime so one binary serves both DC and member-server roles. SMTP is configured in `system_config` with a plaintext password (per user decision; API responses mask it).

**Tech Stack:** Node.js (center) + MySQL 8 / MSSQL (dual-dialect SQL via existing `db/sql.js`), Vue 3 + Element Plus (frontend), PowerShell 5.1 + pwsh 7+ (agent + scripts), nodemailer (new dep — SMTP only).

**Spec:** `docs/superpowers/specs/2026-08-09-non-ad-server-management-design.md` (commit `ae8b388`).
**Companion spec:** `docs/superpowers/specs/2026-08-09-wpf-package-designer-design.md` (commit `17b6db3`, patched with `agent.type` enum + non-AD starter template).
**Execution mode:** Subagent-driven (each task gets a fresh implementer subagent + task reviewer).

## Global Constraints

These are non-negotiable requirements binding every task. Implementation MUST satisfy all of them.

1. **Dual-dialect SQL only.** Every new query must work on both MySQL 8 (`db/migrations/*.sql`) and MSSQL (`db/migrations/mssql/*.sql`). Use the existing `db.sql.<table>.<op>` convention; mirror each new block to both dialects.
2. **Pure DDL migrations.** No stored procs, no `DELIMITER`, no cross-schema references. Use `CREATE TABLE IF NOT EXISTS` (MySQL) / `IF OBJECT_ID('…','U') IS NULL` (MSSQL) idempotency patterns from migration 013.
3. **`publish/` mirror is verified.** Every new file under `center/` must have a mirror under `publish/center/` with identical content. `scripts/verify-mirror.ps1` is the gate; this plan updates the script with each new file pair.
4. **All admin routes use `requirePerm('admin:users')`** middleware. No new permissions.
5. **`ad_os_baseline` is read-only by name.** `installer.uninstallPackage` rejects with `PKG_BUILTIN` when `name === 'ad-os-baseline'`. Per-server unbind via `DELETE /api/admin/member-servers/:hostname/packages/ad-os-baseline` IS allowed; emits audit warning `disable_builtin_ad_os_baseline`.
6. **Member-server endpoints live in a separate `memberRouter`.** No cross-pollination with DC `agent` routes. The existing `POST /api/agent/heartbeat` is EXTENDED (not duplicated) to handle `agent_type: "non-ad"` payloads; both code paths write to `ad_agent_heartbeat`.
7. **SMTP password is plaintext in `system_config`.** API responses always return `"********"`. `PUT /api/admin/config` with empty / `"********"` preserves the existing value. `sys_config_audit` writes `已设置` for password changes — actual bytes never logged.
8. **Both new loops use the `createProbeLoop` factory shape**: returns `{start, stop, tick, isRunning}`, `setInterval` guarded by `inFlight`, `AbortSignal.timeout` for out-of-process calls. Started only in normal mode from `server.js` after `buildServerApps`; stopped in the shutdown handler alongside `probeLoop`.
9. **Tick interval floors.** `alert_eval_interval_seconds` has a 10-second floor to avoid runaway DB load.
10. **Transactionality.** The per-rule state write + `alert_events` insert + `alert_email_outbox` insert happen in a single transaction. Email delivery reads committed rows.
11. **Alert semantics are the simpler v1 model.** Rule-level `for_minutes` is authoritative; per-condition `for_minutes` fields in the rule tree are documentation only and ignored by the state machine.
12. **Built-in package seeding is idempotent.** On first normal-mode start, copy `publish/center/data/packages/ad_os_baseline/1.0.0/` into `data/packages/`. Skip if `manifest.json` already exists. Audit as `seed_builtin_ad_os_baseline`.
13. **Agent uses one binary, switch by `manifest.agent.type`.** `config.agentType` defaults to `'ad'`. Existing installs are unaffected. `install-agent.ps1 -AgentType non-ad` opts a host into member-server mode.
14. **`agent` non-AD runtime:** self-register once → `GET /api/admin/agent/packages-for-host?hostname=…` (filters by `agent.type === 'non-ad'`) → `POST /api/agent/packages/report` (existing v2 path).
15. **No silent regressions in existing DC path.** Every test for DCs and sites must still pass. The whole-branch review will run the full 528+ test suite.
16. **PowerShell 5.1 + pwsh 7+ dual compatibility.** All new scripts in `scripts/` (e.g. install-agent.ps1 patch, verify-mirror.ps1 update) must run under both. No pwsh-only syntax (no 3-arg `Join-Path`, etc.).
17. **Real-DB SQL tests pair every `db.sql.*` string.** Mock-DB unit tests are necessary but not sufficient; pair every new SQL block with a `tests/sql/<name>.test.js` test gated on `TEST_MYSQL_URL` per existing convention.
18. **Per-task commit cadence.** Each task ends with one git commit. The final task produces a green whole-branch review (opus dispatched by SDD controller).

---

## File Structure

```
center/
├── src/
│   ├── db/
│   │   └── sql.js                          # modify: 8 new sql blocks (4 tables x 2 dialects)
│   ├── services/
│   │   ├── alert-engine.js                 # create: AlertEvaluationLoop factory
│   │   ├── email.js                        # create: EmailDeliveryLoop + SmtpService + maskPwd helper
│   │   ├── agent-packages-for-host.js      # create: per-host package merge
│   │   ├── builtin-packages.js             # create: ad_os_baseline seeder
│   │   └── probe.js                        # read-only (reference for factory shape)
│   ├── routes/
│   │   ├── member-servers.js               # create: memberRouter
│   │   ├── admin.js                        # modify: add 5 group + bulk routes
│   │   └── agent.js                        # modify: extend heartbeat for non-ad
│   └── packages/
│       └── manifest.js                     # modify: add agent.type enum
├── server.js                               # modify: start/stop alert + email loops
├── package.json                            # modify: add nodemailer dep
└── tests/
    ├── member-servers-api.test.js          # create: 6 tests
    ├── server-groups-api.test.js           # create: 5 tests
    ├── alert-rules-api.test.js             # create: 4 tests
    ├── email-outbox-loop.test.js           # create: 3 tests
    └── migrations-014.test.js              # create: dual-dialect apply check

center/src/db/sql/
├── member-servers.js                       # create
├── server-groups.js                        # create
├── alert-rules.js                          # create
├── alert-events.js                         # create
└── alert-outbox.js                         # create

publish/center/                             # mirrors of the above (verify-mirror.ps1 enforced)

db/migrations/
├── 014-member-servers.sql                  # create
└── mssql/014-member-servers.sql            # create

publish/center/data/packages/ad_os_baseline/1.0.0/
├── manifest.json                           # create (v2, agent.type: non-ad)
├── collect.ps1                             # create
└── migrations/001_initial.sql              # create

agent/
├── agent.js                                # modify: agentType branch
└── tests/
    ├── agent-type.test.js                  # create
    └── self-register.test.js               # create

frontend/src/
├── api/admin.js                            # modify: ~8 new adminApi methods
├── router/index.js                         # modify: 4 new routes
├── layouts/AdminLayout.vue                 # modify: new menu group
└── views/admin/
    ├── MemberServersView.vue               # create
    ├── MemberServerDetailView.vue          # create
    ├── ServerGroupsView.vue                # create
    ├── RuleEditorDialog.vue                # create
    ├── EmailConfigCard.vue                 # create
    └── ConfigView.vue                      # modify: insert EmailConfigCard

scripts/
├── verify-mirror.ps1                       # modify: register ~12 new pairs
└── install-agent.ps1                       # modify: -AgentType parameter

frontend/tests/
├── member-servers-view.test.js             # create
├── rule-editor-dialog.test.js              # create
└── email-config-card.test.js               # create
```

---

## Task 1: SQL migration `014-member-servers.sql` (both dialects)

**Files:**
- Create: `db/migrations/014-member-servers.sql`
- Create: `db/migrations/mssql/014-member-servers.sql`
- Modify: `db/migrations/index.js` (register new migration)
- Mirror to `publish/db/migrations/014-member-servers.sql` and `publish/db/migrations/mssql/014-member-servers.sql`
- Create: `center/tests/migrations-014.test.js`

**Interfaces:** Idempotent DDL for the 8 new tables defined in spec §4.3-§4.6. No FKs that break dual-dialect; pure `CREATE TABLE` with conditional guards.

- [ ] **Step 1: Write the failing migration test**

`center/tests/migrations-014.test.js`:
```js
const { describe, test, expect, beforeAll } = require('@jest/globals');
const { applyMigrations } = require('../src/db/migrate');
const { getDb } = require('../src/db');

describe('migration 014 — member servers + alert engine tables', () => {
  beforeAll(async () => { await applyMigrations({ upTo: '014-member-servers' }); });
  test('all 8 tables exist after applying', async () => {
    const db = getDb();
    const expected = [
      'ad_member_servers', 'ad_server_groups', 'ad_server_group_members',
      'ad_member_server_packages', 'alert_rules', 'alert_rule_state',
      'alert_events', 'alert_email_outbox'
    ];
    for (const t of expected) {
      const rows = await db.query(`SHOW TABLES LIKE '${t}'`);
      expect(rows.length).toBe(1);
    }
  });
  test('migration is idempotent (re-running is no-op)', async () => {
    await expect(applyMigrations({ upTo: '014-member-servers' })).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npx jest center/tests/migrations-014.test.js`
Expected: FAIL — `applyMigrations` doesn't recognize `014`.

- [ ] **Step 3: Write the MySQL migration**

`db/migrations/014-member-servers.sql`:
```sql
-- 014-member-servers.sql
-- Adds: member servers, server groups, per-server package binds, alert engine tables.
-- Idempotent: safe to re-run on a partially migrated database.

CREATE TABLE IF NOT EXISTS ad_member_servers (
  hostname        VARCHAR(128)  NOT NULL,
  site_id         INT NULL,
  ip_address      VARCHAR(64)   NULL,
  os_version      VARCHAR(64)   NULL,
  agent_type      VARCHAR(16)   NOT NULL DEFAULT 'non-ad',
  enabled         TINYINT(1)    NOT NULL DEFAULT 1,
  last_seen_at    DATETIME      NULL,
  last_report_at  DATETIME      NULL,
  discovered_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  discovered_via  VARCHAR(32)   NOT NULL DEFAULT 'self-register',
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (hostname),
  CONSTRAINT fk_member_servers_site FOREIGN KEY (site_id) REFERENCES ad_sites(site_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ad_server_groups (
  group_id     INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  group_name   VARCHAR(128) NOT NULL,
  description  VARCHAR(256) NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_server_groups_name (group_name)
);

CREATE TABLE IF NOT EXISTS ad_server_group_members (
  group_id    INT NOT NULL,
  hostname    VARCHAR(128) NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_id, hostname),
  CONSTRAINT fk_sgm_group FOREIGN KEY (group_id) REFERENCES ad_server_groups(group_id) ON DELETE CASCADE,
  CONSTRAINT fk_sgm_host  FOREIGN KEY (hostname) REFERENCES ad_member_servers(hostname) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ad_member_server_packages (
  hostname      VARCHAR(128) NOT NULL,
  package_name  VARCHAR(128) NOT NULL,
  enabled       TINYINT(1)   NOT NULL DEFAULT 1,
  installed_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_run_at   DATETIME     NULL,
  PRIMARY KEY (hostname, package_name),
  CONSTRAINT fk_msp_host FOREIGN KEY (hostname) REFERENCES ad_member_servers(hostname) ON DELETE CASCADE,
  CONSTRAINT fk_msp_pkg  FOREIGN KEY (package_name) REFERENCES installed_packages(name) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS alert_rules (
  rule_id     INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  hostname    VARCHAR(128) NOT NULL,
  name        VARCHAR(256) NOT NULL,
  condition   TEXT NOT NULL,
  for_minutes INT NOT NULL DEFAULT 5,
  cooldown_minutes INT NOT NULL DEFAULT 30,
  recipients  TEXT NULL,
  enabled     TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_ar_host FOREIGN KEY (hostname) REFERENCES ad_member_servers(hostname) ON DELETE CASCADE,
  INDEX idx_ar_host_enabled (hostname, enabled)
);

CREATE TABLE IF NOT EXISTS alert_rule_state (
  rule_id            INT NOT NULL PRIMARY KEY,
  state              VARCHAR(16) NOT NULL DEFAULT 'normal',
  first_hit_at       DATETIME NULL,
  last_evaluated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_fired_at      DATETIME NULL,
  last_recovered_at  DATETIME NULL,
  suppressed_until   DATETIME NULL,
  CONSTRAINT fk_ars_rule FOREIGN KEY (rule_id) REFERENCES alert_rules(rule_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS alert_events (
  id          BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  rule_id     INT NOT NULL,
  hostname    VARCHAR(128) NOT NULL,
  event       VARCHAR(32) NOT NULL,
  detail      TEXT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ae_rule_created (rule_id, created_at),
  INDEX idx_ae_host_created (hostname, created_at)
);

CREATE TABLE IF NOT EXISTS alert_email_outbox (
  id              BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  alert_event_id  BIGINT NOT NULL,
  to_addrs        VARCHAR(1024) NOT NULL,
  cc_addrs        VARCHAR(1024) NULL,
  subject         VARCHAR(256) NOT NULL,
  body_text       TEXT NOT NULL,
  body_html       TEXT NULL,
  attempt_count   INT NOT NULL DEFAULT 0,
  next_attempt_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error      TEXT NULL,
  sent_at         DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_aoe_pending (sent_at, next_attempt_at),
  CONSTRAINT fk_aoe_event FOREIGN KEY (alert_event_id) REFERENCES alert_events(id) ON DELETE CASCADE
);
```

- [ ] **Step 4: Write the MSSQL mirror**

`db/migrations/mssql/014-member-servers.sql`:
```sql
-- 014-member-servers.sql (MSSQL)
IF OBJECT_ID('ad_member_servers','U') IS NULL
CREATE TABLE ad_member_servers (
  hostname        NVARCHAR(128) NOT NULL PRIMARY KEY,
  site_id         INT NULL FOREIGN KEY REFERENCES ad_sites(site_id) ON DELETE SET NULL,
  ip_address      NVARCHAR(64)  NULL,
  os_version      NVARCHAR(64)  NULL,
  agent_type      NVARCHAR(16)  NOT NULL CONSTRAINT df_member_servers_agent_type DEFAULT 'non-ad',
  enabled         BIT NOT NULL CONSTRAINT df_member_servers_enabled DEFAULT 1,
  last_seen_at    DATETIMEOFFSET NULL,
  last_report_at  DATETIMEOFFSET NULL,
  discovered_at   DATETIMEOFFSET NOT NULL CONSTRAINT df_member_servers_disc DEFAULT SYSDATETIMEOFFSET(),
  discovered_via  NVARCHAR(32)  NOT NULL CONSTRAINT df_member_servers_via DEFAULT 'self-register',
  created_at      DATETIMEOFFSET NOT NULL CONSTRAINT df_member_servers_created DEFAULT SYSDATETIMEOFFSET(),
  updated_at      DATETIMEOFFSET NOT NULL CONSTRAINT df_member_servers_updated DEFAULT SYSDATETIMEOFFSET()
);

IF OBJECT_ID('ad_server_groups','U') IS NULL
CREATE TABLE ad_server_groups (
  group_id     INT IDENTITY(1,1) PRIMARY KEY,
  group_name   NVARCHAR(128) NOT NULL UNIQUE,
  description  NVARCHAR(256) NULL,
  created_at   DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  updated_at   DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
);

IF OBJECT_ID('ad_server_group_members','U') IS NULL
CREATE TABLE ad_server_group_members (
  group_id    INT NOT NULL FOREIGN KEY REFERENCES ad_server_groups(group_id) ON DELETE CASCADE,
  hostname    NVARCHAR(128) NOT NULL FOREIGN KEY REFERENCES ad_member_servers(hostname) ON DELETE CASCADE,
  created_at  DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  PRIMARY KEY (group_id, hostname)
);

IF OBJECT_ID('ad_member_server_packages','U') IS NULL
CREATE TABLE ad_member_server_packages (
  hostname      NVARCHAR(128) NOT NULL FOREIGN KEY REFERENCES ad_member_servers(hostname) ON DELETE CASCADE,
  package_name  NVARCHAR(128) NOT NULL FOREIGN KEY REFERENCES installed_packages(name) ON DELETE CASCADE,
  enabled       BIT NOT NULL DEFAULT 1,
  installed_at  DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  last_run_at   DATETIMEOFFSET NULL,
  PRIMARY KEY (hostname, package_name)
);

IF OBJECT_ID('alert_rules','U') IS NULL
CREATE TABLE alert_rules (
  rule_id           INT IDENTITY(1,1) PRIMARY KEY,
  hostname          NVARCHAR(128) NOT NULL FOREIGN KEY REFERENCES ad_member_servers(hostname) ON DELETE CASCADE,
  name              NVARCHAR(256) NOT NULL,
  condition         NVARCHAR(MAX) NOT NULL,
  for_minutes       INT NOT NULL DEFAULT 5,
  cooldown_minutes  INT NOT NULL DEFAULT 30,
  recipients        NVARCHAR(MAX) NULL,
  enabled           BIT NOT NULL DEFAULT 1,
  created_at        DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  updated_at        DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
);
CREATE INDEX idx_ar_host_enabled ON alert_rules(hostname, enabled);

IF OBJECT_ID('alert_rule_state','U') IS NULL
CREATE TABLE alert_rule_state (
  rule_id            INT PRIMARY KEY FOREIGN KEY REFERENCES alert_rules(rule_id) ON DELETE CASCADE,
  state              NVARCHAR(16) NOT NULL DEFAULT 'normal',
  first_hit_at       DATETIMEOFFSET NULL,
  last_evaluated_at  DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  last_fired_at      DATETIMEOFFSET NULL,
  last_recovered_at  DATETIMEOFFSET NULL,
  suppressed_until   DATETIMEOFFSET NULL
);

IF OBJECT_ID('alert_events','U') IS NULL
CREATE TABLE alert_events (
  id          BIGINT IDENTITY(1,1) PRIMARY KEY,
  rule_id     INT NOT NULL,
  hostname    NVARCHAR(128) NOT NULL,
  event       NVARCHAR(32) NOT NULL,
  detail      NVARCHAR(MAX) NULL,
  created_at  DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
);
CREATE INDEX idx_ae_rule_created ON alert_events(rule_id, created_at);
CREATE INDEX idx_ae_host_created ON alert_events(hostname, created_at);

IF OBJECT_ID('alert_email_outbox','U') IS NULL
CREATE TABLE alert_email_outbox (
  id              BIGINT IDENTITY(1,1) PRIMARY KEY,
  alert_event_id  BIGINT NOT NULL FOREIGN KEY REFERENCES alert_events(id) ON DELETE CASCADE,
  to_addrs        NVARCHAR(1024) NOT NULL,
  cc_addrs        NVARCHAR(1024) NULL,
  subject         NVARCHAR(256) NOT NULL,
  body_text       NVARCHAR(MAX) NOT NULL,
  body_html       NVARCHAR(MAX) NULL,
  attempt_count   INT NOT NULL DEFAULT 0,
  next_attempt_at DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  last_error      NVARCHAR(MAX) NULL,
  sent_at         DATETIMEOFFSET NULL,
  created_at      DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
);
CREATE INDEX idx_aoe_pending ON alert_email_outbox(sent_at, next_attempt_at);
```

- [ ] **Step 5: Register the migration**

In `db/migrations/index.js`, append the new entry:
```js
{ id: '014-member-servers', file: '014-member-servers.sql', mssql: 'mssql/014-member-servers.sql' }
```

- [ ] **Step 6: Mirror to publish/**

```bash
cp db/migrations/014-member-servers.sql            publish/db/migrations/
cp db/migrations/mssql/014-member-servers.sql     publish/db/migrations/mssql/
```

- [ ] **Step 7: Run, expect pass**

Run: `npx jest center/tests/migrations-014.test.js`
Expected: 2 tests pass on real MySQL; skipped on mock-DB mode.

- [ ] **Step 8: Commit**

```bash
git add db/migrations/ db/migrations/index.js publish/db/migrations/ center/tests/migrations-014.test.js
git commit -m "feat(non-ad): migration 014 — member servers + alert engine tables"
```

## Task 2: `db.sql.*` blocks for the 8 new tables

**Files:**
- Create: `center/src/db/sql/member-servers.js`
- Create: `center/src/db/sql/server-groups.js`
- Create: `center/src/db/sql/alert-rules.js`
- Create: `center/src/db/sql/alert-events.js`
- Create: `center/src/db/sql/alert-outbox.js`
- Modify: `center/src/db/sql.js` (mount the 5 modules, both dialects)
- Mirror to `publish/center/src/db/sql/` and `publish/center/src/db/sql.js`
- Create: `center/src/db/sql/member-servers.test.js` (mock + real-DB gated)
- Create: `center/src/db/sql/server-groups.test.js`
- Create: `center/src/db/sql/alert-rules.test.js`
- Create: `center/src/db/sql/alert-events.test.js`
- Create: `center/src/db/sql/alert-outbox.test.js`

**Interfaces:** Each module exports `{mysql, mssql}` blocks of named SQL strings. Used by services. Per existing convention, see `db.sql.sites`, `db.sql.dcs`.

- [ ] **Step 1: Write the failing tests**

`center/src/db/sql/member-servers.test.js`:
```js
const { describe, test, expect } = require('@jest/globals');
const sql = require('./member-servers');

describe('db.sql.member-servers', () => {
  test('upsert is present in both dialects', () => {
    expect(sql.mysql.upsert).toMatch(/INSERT INTO ad_member_servers/i);
    expect(sql.mssql.upsert).toMatch(/MERGE INTO ad_member_servers/i);
  });
  test('findByHostname uses PK lookup', () => {
    expect(sql.mysql.findByHostname).toMatch(/WHERE hostname\s*=\s*\?/i);
    expect(sql.mssql.findByHostname).toMatch(/WHERE hostname\s*=\s*\?/i);
  });
});
```

(`server-groups`, `alert-rules`, `alert-events`, `alert-outbox` analogous.)

- [ ] **Step 2: Run, expect compile errors**

Run: `npx jest center/src/db/sql/`
Expected: `Cannot find module`.

- [ ] **Step 3: Implement `member-servers.js`**

```js
module.exports = {
  mysql: {
    upsert: `INSERT INTO ad_member_servers
              (hostname, site_id, ip_address, os_version, agent_type, enabled, discovered_via)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON DUPLICATE KEY UPDATE
                site_id = VALUES(site_id),
                ip_address = VALUES(ip_address),
                os_version = VALUES(os_version),
                updated_at = NOW()`,
    findByHostname: `SELECT * FROM ad_member_servers WHERE hostname = ?`,
    list: `SELECT ms.*, s.site_name
           FROM ad_member_servers ms
           LEFT JOIN ad_sites s ON ms.site_id = s.site_id
           ORDER BY ms.hostname`,
    delete: `DELETE FROM ad_member_servers WHERE hostname = ?`,
    touchLastSeen: `UPDATE ad_member_servers SET last_seen_at = NOW() WHERE hostname = ?`,
    touchLastReport: `UPDATE ad_member_servers SET last_report_at = NOW() WHERE hostname = ?`
  },
  mssql: {
    upsert: `MERGE INTO ad_member_servers AS t
             USING (SELECT ? AS hostname, ? AS site_id, ? AS ip_address,
                          ? AS os_version, ? AS agent_type, ? AS enabled, ? AS discovered_via) AS s
             ON t.hostname = s.hostname
             WHEN MATCHED THEN UPDATE SET
                site_id = s.site_id, ip_address = s.ip_address,
                os_version = s.os_version, updated_at = SYSDATETIMEOFFSET()
             WHEN NOT MATCHED THEN INSERT
                (hostname, site_id, ip_address, os_version, agent_type, enabled, discovered_via)
                VALUES (s.hostname, s.site_id, s.ip_address, s.os_version, s.agent_type, s.enabled, s.discovered_via);`,
    findByHostname: `SELECT * FROM ad_member_servers WHERE hostname = @hostname`,
    list: `SELECT ms.*, s.site_name
           FROM ad_member_servers ms
           LEFT JOIN ad_sites s ON ms.site_id = s.site_id
           ORDER BY ms.hostname`,
    delete: `DELETE FROM ad_member_servers WHERE hostname = @hostname`,
    touchLastSeen: `UPDATE ad_member_servers SET last_seen_at = SYSDATETIMEOFFSET() WHERE hostname = @hostname`,
    touchLastReport: `UPDATE ad_member_servers SET last_report_at = SYSDATETIMEOFFSET() WHERE hostname = @hostname`
  }
};
```

(`server-groups.js`, `alert-rules.js`, `alert-events.js`, `alert-outbox.js` follow the same dual-dialect pattern with `INSERT ... ON DUPLICATE KEY` (MySQL) / `MERGE` (MSSQL) for upserts; `WHERE id = @id` for MSSQL parameters.)

- [ ] **Step 4: Mount in `db/sql.js`**

Append under both `mysql` and `mssql` blocks:
```js
memberServers: require('./sql/member-servers')[dialect],
serverGroups:  require('./sql/server-groups')[dialect],
alertRules:    require('./sql/alert-rules')[dialect],
alertEvents:   require('./sql/alert-events')[dialect],
alertOutbox:   require('./sql/alert-outbox')[dialect]
```

- [ ] **Step 5: Mirror to publish/**

```bash
cp center/src/db/sql/{member-servers,server-groups,alert-rules,alert-events,alert-outbox}.js publish/center/src/db/sql/
cp center/src/db/sql.js publish/center/src/db/sql.js
```

- [ ] **Step 6: Run, expect pass**

Run: `npx jest center/src/db/sql/`
Expected: 10+ tests pass.

- [ ] **Step 7: Real-DB SQL tests**

Per Global Constraint #17, write `tests/sql/<table>.test.js` files that hit a real MySQL DB when `TEST_MYSQL_URL` is set. Each does a round-trip: insert → findByX → update → delete. Skip when env var absent.

Example skeleton (one of the five):
```js
const { describe, test, expect, beforeAll, afterAll } = require('@jest/globals');
const { getDb } = require('../../src/db');
const sql = require('../../src/db/sql');

const TEST_URL = process.env.TEST_MYSQL_URL;
const d = TEST_URL ? describe : describe.skip;
d('real-db: alert_rules', () => {
  test('insert + findByHostname round-trip', async () => {
    const db = getDb();
    await db.query(sql.mysql.memberServers.upsert, ['SRV-TEST', null, null, null, 'non-ad', 1, 'self-register']);
    await db.query(`INSERT INTO alert_rules (hostname, name, condition) VALUES (?, ?, ?)`,
      ['SRV-TEST', 'cpu', JSON.stringify({op:'GT', metric:'cpu_pct', value:90})]);
    const rows = await db.query(`SELECT * FROM alert_rules WHERE hostname = ?`, ['SRV-TEST']);
    expect(rows.length).toBe(1);
  });
});
```

- [ ] **Step 8: Commit**

```bash
git add center/src/db/sql/ publish/center/src/db/sql/ tests/sql/
git commit -m "feat(non-ad): db.sql blocks for member-servers/groups/alert tables"
```

## Task 3: `manifest.agent.type` enum patch (center + registry schema)

**Files:**
- Modify: `center/src/packages/manifest.js`
- Modify: `center/src/packages/registry-index.schema.json`
- Mirror both to `publish/center/src/packages/`
- Create: `center/tests/manifest-agent-type.test.js`

**Interfaces:** Adds `agent.type` enum to JSON schema. Used by installer + runtime to filter packages by type.

- [ ] **Step 1: Write the failing test**

```js
const { describe, test, expect } = require('@jest/globals');
const Ajv = require('ajv');
const manifestSchema = require('../src/packages/manifest');

describe('manifest.agent.type', () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(manifestSchema);
  test('agent.type = "ad" is accepted', () => {
    const m = { name: 'x', version: '1.0.0', type: 'gauge',
      agent: { type: 'ad', minVersion: '0.1.0', script: 'collect.ps1', intervalSec: 60 } };
    expect(validate(m)).toBe(true);
  });
  test('agent.type = "non-ad" is accepted', () => {
    const m = { name: 'x', version: '1.0.0', type: 'gauge',
      agent: { type: 'non-ad', minVersion: '0.1.0', script: 'collect.ps1', intervalSec: 60 } };
    expect(validate(m)).toBe(true);
  });
  test('agent.type = "weird" is rejected', () => {
    const m = { name: 'x', version: '1.0.0', type: 'gauge',
      agent: { type: 'weird', minVersion: '0.1.0', script: 'collect.ps1', intervalSec: 60 } };
    expect(validate(m)).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npx jest center/tests/manifest-agent-type.test.js`
Expected: the `non-ad` case fails validation.

- [ ] **Step 3: Patch the schema**

In `center/src/packages/manifest.js`, inside the `agent` schema, add:
```js
type: { enum: ['ad', 'non-ad'] }
```

Same patch in `registry-index.schema.json`.

- [ ] **Step 4: Mirror**

```bash
cp center/src/packages/manifest.js publish/center/src/packages/manifest.js
cp center/src/packages/registry-index.schema.json publish/center/src/packages/registry-index.schema.json
```

- [ ] **Step 5: Run, expect pass**

Run: `npx jest center/tests/manifest-agent-type.test.js`
Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add center/src/packages/ publish/center/src/packages/ center/tests/manifest-agent-type.test.js
git commit -m "feat(non-ad): manifest.agent.type enum (ad | non-ad)"
```

## Task 4: Built-in `ad_os_baseline` package + seeder

**Files:**
- Create: `publish/center/data/packages/ad_os_baseline/1.0.0/manifest.json`
- Create: `publish/center/data/packages/ad_os_baseline/1.0.0/collect.ps1`
- Create: `publish/center/data/packages/ad_os_baseline/1.0.0/migrations/001_initial.sql`
- Create: `publish/center/data/packages/ad_os_baseline/1.0.0/content.sha256`
- Create: `center/src/services/builtin-packages.js`
- Create: `center/tests/builtin-packages.test.js`
- Modify: `center/server.js` (call seeder on first normal-mode start)

**Interfaces:** `seedBuiltinPackages()` is idempotent. Skips if `data/packages/ad_os_baseline/1.0.0/manifest.json` already exists. Emits audit `seed_builtin_ad_os_baseline` on success.

- [ ] **Step 1: Write the failing test**

```js
const { describe, test, expect, beforeEach, afterEach } = require('@jest/globals');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { seedBuiltinPackages } = require('../src/services/builtin-packages');

describe('seedBuiltinPackages', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true }); });
  test('creates ad_os_baseline directory on first run', async () => {
    await seedBuiltinPackages({ dataDir: tmp, sourceDir: path.join(__dirname, '..', '..', 'publish', 'center', 'data', 'packages') });
    expect(fs.existsSync(path.join(tmp, 'ad_os_baseline', '1.0.0', 'manifest.json'))).toBe(true);
  });
  test('is idempotent (second run is no-op)', async () => {
    await seedBuiltinPackages({ dataDir: tmp, sourceDir: '...' });
    await expect(seedBuiltinPackages({ dataDir: tmp, sourceDir: '...' })).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run, expect compile error**

Run: `npx jest center/tests/builtin-packages.test.js`
Expected: module not found.

- [ ] **Step 3: Write the manifest.json**

```json
{
  "name": "ad-os-baseline",
  "version": "1.0.0",
  "type": "gauge",
  "description": "Windows member server baseline metrics (CPU, memory, disks, services, event log).",
  "agent": {
    "type": "non-ad",
    "minVersion": "0.1.0",
    "platforms": ["windows"],
    "runtime": "powershell",
    "script": "collect.ps1",
    "timeoutMs": 20000,
    "intervalSec": 60
  },
  "database": {
    "schemaName": "pkg_ad_os_baseline",
    "migrations": ["migrations/001_initial.sql"],
    "metricTable": "metrics",
    "metricSchema": {
      "agent_id":   { "type": "varchar(64)", "nullable": false },
      "ts":         { "type": "datetime",    "nullable": false },
      "cpu_pct":    { "type": "double" },
      "memory_pct": { "type": "double" },
      "disk_free":  { "type": "json" },
      "disk_total": { "type": "json" },
      "services":   { "type": "json" },
      "events":     { "type": "json" }
    }
  }
}
```

- [ ] **Step 4: Write `collect.ps1`**

```powershell
# collect.ps1 — ad_os_baseline v1
# Captures CPU, memory, disk, services, event log snapshot.
# Emits: {"metrics": {...}} per v2 contract.
$ErrorActionPreference = 'SilentlyContinue'

$cpuSample = (Get-Counter '\Processor(_Total)\% Processor Time').CounterSamples.CookedValue
$os        = Get-CimInstance Win32_OperatingSystem
$memPct    = [math]::Round((($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize) * 100, 2)

$disks = foreach ($d in Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3') {
  @{ letter = $d.DeviceID; free_bytes = $d.FreeSpace; total_bytes = $d.Size }
}
$diskFree = ($disks | ForEach-Object { @{ $_.letter = $_.free_bytes } } | ConvertTo-Json -Compress)
$diskTotal = ($disks | ForEach-Object { @{ $_.letter = $_.total_bytes } } | ConvertTo-Json -Compress)

$svcAllow = 'Spooler','WinRM','W32Time','DNS','LanmanServer','LanmanWorkstation','Wecsvc'
$svcMap = @{}
foreach ($n in $svcAllow) { try { $svcMap[$n] = (Get-Service -Name $n -ErrorAction SilentlyContinue).Status.ToString() } catch {} }

$events = Get-WinEvent -FilterHashtable @{LogName='System','Application'; StartTime=(Get-Date).AddMinutes(-5); Level=2,3} -MaxEvents 20 -ErrorAction SilentlyContinue |
  Select-Object LogName, Id, LevelDisplayName, Message |
  ForEach-Object { @{ log = $_.LogName; id = $_.Id; level = $_.LevelDisplayName; msg = ($_.Message -replace "`r`n"," ") -replace '\s+',' ' } }

$payload = @{
  metrics = @{
    cpu_pct    = [double]$cpuSample
    memory_pct = [double]$memPct
    disk_free  = ($diskFree  -as [string]) ?? '{}'
    disk_total = ($diskTotal -as [string]) ?? '{}'
    services   = (ConvertTo-Json $svcMap -Compress)
    events     = (ConvertTo-Json @($events) -Compress)
  }
}
$payload | ConvertTo-Json -Compress -Depth 8
```

- [ ] **Step 5: Write the migration**

`migrations/001_initial.sql`:
```sql
CREATE TABLE metrics (
  agent_id   VARCHAR(64)  NOT NULL,
  ts         DATETIME     NOT NULL,
  cpu_pct    DOUBLE NULL,
  memory_pct DOUBLE NULL,
  disk_free  JSON NULL,
  disk_total JSON NULL,
  services   JSON NULL,
  events     JSON NULL
);
```

- [ ] **Step 6: Generate `content.sha256`**

```bash
cd publish/center/data/packages/ad_os_baseline/1.0.0
# generate sha256 of every file concatenated in sorted order, write to content.sha256
find . -type f ! -name content.sha256 | sort | xargs sha256sum > content.sha256
```

- [ ] **Step 7: Implement the seeder**

`center/src/services/builtin-packages.js`:
```js
const fs = require('fs');
const path = require('path');

const BUILTINS = ['ad_os_baseline'];

async function seedBuiltinPackages({ dataDir, sourceDir, writeAudit }) {
  for (const name of BUILTINS) {
    const target = path.join(dataDir, name, '1.0.0');
    fs.mkdirSync(target, { recursive: true });
    if (fs.existsSync(path.join(target, 'manifest.json'))) continue;  // idempotent
    const src = path.join(sourceDir, name, '1.0.0');
    copyDirSync(src, target);
    if (writeAudit) await writeAudit({ action: 'seed_builtin_' + name.replace(/[^a-z0-9_]/gi,'_'), target: 'packages', payload: { name, version: '1.0.0' } });
  }
}

function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

module.exports = { seedBuiltinPackages };
```

- [ ] **Step 8: Wire into `server.js`**

After `buildServerApps`:
```js
const { seedBuiltinPackages } = require('./src/services/builtin-packages');
await seedBuiltinPackages({ dataDir: path.join(DATA_DIR, 'packages'), sourceDir: path.join(__dirname, 'publish', 'center', 'data', 'packages'), writeAudit });
```

(Actual call site mirrors existing audit-write pattern in `server.js`.)

- [ ] **Step 9: Mirror `server.js` and the test**

```bash
cp center/server.js publish/center/server.js
cp center/src/services/builtin-packages.js publish/center/src/services/builtin-packages.js
cp center/tests/builtin-packages.test.js publish/center/tests/builtin-packages.test.js 2>/dev/null || true
```

- [ ] **Step 10: Run, expect pass**

Run: `npx jest center/tests/builtin-packages.test.js`
Expected: 2 tests pass.

- [ ] **Step 11: Commit**

```bash
git add publish/center/data/packages/ad_os_baseline/ center/src/services/builtin-packages.js center/server.js center/tests/builtin-packages.test.js
git commit -m "feat(non-ad): built-in ad_os_baseline package + idempotent seeder"
```

## Task 5: `installer.uninstallPackage` rejects `PKG_BUILTIN`

**Files:**
- Modify: `center/src/services/installer.js`
- Modify: `center/tests/installer.test.js` (add 1 test)
- Mirror `installer.js` to publish/center/src/services/installer.js

**Interfaces:** When `name === 'ad-os-baseline'`, the global uninstall returns `{ok: false, code: 'PKG_BUILTIN'}` and does not drop the row in `installed_packages`. Per-server unbind via the `DELETE /api/admin/member-servers/:hostname/packages/ad-os-baseline` route (Task 7) is a separate code path and remains allowed.

- [ ] **Step 1: Add the failing test**

```js
test('uninstallPackage rejects ad-os-baseline with PKG_BUILTIN', async () => {
  const r = await installer.uninstallPackage({ name: 'ad-os-baseline' });
  expect(r.ok).toBe(false);
  expect(r.code).toBe('PKG_BUILTIN');
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npx jest center/tests/installer.test.js --filter PKG_BUILTIN`
Expected: `uninstallPackage` actually deletes (current behavior).

- [ ] **Step 3: Patch `installer.js`**

At the top of `uninstallPackage`:
```js
const BUILTIN = new Set(['ad-os-baseline']);
if (BUILTIN.has(name)) return { ok: false, code: 'PKG_BUILTIN', message: `${name} is a built-in package and cannot be uninstalled` };
```

- [ ] **Step 4: Mirror**

```bash
cp center/src/services/installer.js publish/center/src/services/installer.js
```

- [ ] **Step 5: Run, expect pass**

Run: `npx jest center/tests/installer.test.js --filter PKG_BUILTIN`
Expected: 1 test pass.

- [ ] **Step 6: Commit**

```bash
git add center/src/services/installer.js center/tests/installer.test.js publish/center/src/services/installer.js
git commit -m "feat(non-ad): installer rejects ad-os-baseline uninstall with PKG_BUILTIN"
```

## Task 6: `memberRouter` — member-server CRUD + per-server package bind + self-register + heartbeat extension

**Files:**
- Create: `center/src/routes/member-servers.js`
- Create: `center/tests/member-servers-api.test.js`
- Modify: `center/src/routes/agent.js` (extend heartbeat)
- Modify: `center/server.js` (mount memberRouter)
- Mirror all three to publish/center/

**Interfaces:**
- `GET  /api/admin/member-servers` — list.
- `GET  /api/admin/member-servers/:hostname` — detail.
- `POST /api/admin/member-servers` — manual entry.
- `PUT  /api/admin/member-servers/:hostname` — edit site / enabled / ip / os.
- `DELETE /api/admin/member-servers/:hostname` — drop (cascades group_members + ms_packages + alert_rules).
- `GET  /api/admin/member-servers/:hostname/packages` — list `ad_member_server_packages`.
- `PUT  /api/admin/member-servers/:hostname/packages/:package_name` body `{enabled}`.
- `DELETE /api/admin/member-servers/:hostname/packages/:package_name` — drop row; allows `ad-os-baseline` (audit `disable_builtin_ad_os_baseline`).
- `POST /api/admin/member-servers/self-register` (agent_token) — upsert with `discovered_via='self-register'`.
- `GET  /api/admin/agent/packages-for-host?hostname=…` (agent_token) — see Task 8.

All admin routes use `[userAuth, requirePerm('admin:users')]`.

- [ ] **Step 1: Write the failing integration tests**

`center/tests/member-servers-api.test.js` (6 tests):
```js
const { describe, test, expect, beforeAll } = require('@jest/globals');
const request = require('supertest');
const { buildServerApps } = require('../server');

describe('member-servers API', () => {
  let app;
  beforeAll(async () => { app = await buildServerApps({ mode: 'test' }); });
  test('POST /api/admin/member-servers creates row', async () => {
    const r = await request(app).post('/api/admin/member-servers')
      .set('Authorization', 'Bearer ' + TEST_TOKEN)
      .send({ hostname: 'SRV-A', siteId: null, ipAddress: '10.0.0.1', osVersion: 'Windows Server 2022' });
    expect(r.status).toBe(200);
  });
  test('GET /api/admin/member-servers lists rows', async () => {
    const r = await request(app).get('/api/admin/member-servers').set('Authorization', 'Bearer ' + TEST_TOKEN);
    expect(Array.isArray(r.body.items)).toBe(true);
  });
  test('POST /api/admin/member-servers/self-register is idempotent', async () => {
    const body = { hostname: 'SRV-A', agent_version: '0.1.0', os_version: '...', ip_address: '10.0.0.1' };
    const r1 = await request(app).post('/api/admin/member-servers/self-register').send(body);
    expect(r1.status).toBe(200);
    const r2 = await request(app).post('/api/admin/member-servers/self-register').send(body);
    expect(r2.status).toBe(200);
  });
  test('PUT per-server package enable toggles', async () => {
    const r = await request(app).put('/api/admin/member-servers/SRV-A/packages/ad-os-baseline')
      .set('Authorization', 'Bearer ' + TEST_TOKEN).send({ enabled: true });
    expect(r.status).toBe(200);
  });
  test('DELETE per-server package for built-in is allowed + audited', async () => {
    const r = await request(app).delete('/api/admin/member-servers/SRV-A/packages/ad-os-baseline')
      .set('Authorization', 'Bearer ' + TEST_TOKEN);
    expect(r.status).toBe(200);
  });
  test('DELETE without auth returns 401', async () => {
    const r = await request(app).delete('/api/admin/member-servers/SRV-A/packages/ad-os-baseline');
    expect(r.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run, expect compile error**

Run: `npx jest center/tests/member-servers-api.test.js`
Expected: route not found.

- [ ] **Step 3: Implement `member-servers.js`**

```js
const express = require('express');
const router = express.Router();
const { db, writeAudit } = require('../db');
const sql = require('../db/sql');
const { userAuth, requirePerm } = require('../middleware/auth');
const { maskPassword } = require('../services/email');

// admin: list / detail / create / edit / delete
router.get('/admin/member-servers', userAuth, requirePerm('admin:users'), async (req, res) => {
  res.json({ items: await db.query(sql.mysql.memberServers.list) });
});
router.get('/admin/member-servers/:hostname', userAuth, requirePerm('admin:users'), async (req, res) => {
  const rows = await db.query(sql.mysql.memberServers.findByHostname, [req.params.hostname]);
  if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  res.json(rows[0]);
});
router.post('/admin/member-servers', userAuth, requirePerm('admin:users'), async (req, res) => {
  const { hostname, siteId = null, ipAddress = null, osVersion = null, enabled = 1 } = req.body;
  await db.query(sql.mysql.memberServers.upsert, [hostname, siteId, ipAddress, osVersion, 'non-ad', enabled ? 1 : 0, 'admin']);
  await writeAudit({ userId: req.user.id, action: 'create_member_server', target: hostname, payload: req.body });
  res.json({ ok: true });
});
router.put('/admin/member-servers/:hostname', userAuth, requirePerm('admin:users'), async (req, res) => {
  // partial update; uses dynamic SET
  const fields = ['site_id','ip_address','os_version','enabled'];
  const set = fields.filter(f => req.body[mapField(f)] !== undefined).map(f => `${f} = ?`).join(', ');
  const params = fields.filter(f => req.body[mapField(f)] !== undefined).map(f => req.body[mapField(f)]);
  await db.query(`UPDATE ad_member_servers SET ${set} WHERE hostname = ?`, [...params, req.params.hostname]);
  res.json({ ok: true });
});
router.delete('/admin/member-servers/:hostname', userAuth, requirePerm('admin:users'), async (req, res) => {
  await db.query(sql.mysql.memberServers.delete, [req.params.hostname]);
  res.json({ ok: true });
});

// per-server package bind
router.get('/admin/member-servers/:hostname/packages', userAuth, requirePerm('admin:users'), async (req, res) => {
  const rows = await db.query(`SELECT * FROM ad_member_server_packages WHERE hostname = ?`, [req.params.hostname]);
  res.json({ items: rows });
});
router.put('/admin/member-servers/:hostname/packages/:package_name', userAuth, requirePerm('admin:users'), async (req, res) => {
  const { enabled } = req.body;
  await db.query(`UPDATE ad_member_server_packages SET enabled = ? WHERE hostname = ? AND package_name = ?`,
    [enabled ? 1 : 0, req.params.hostname, req.params.package_name]);
  res.json({ ok: true });
});
router.delete('/admin/member-servers/:hostname/packages/:package_name', userAuth, requirePerm('admin:users'), async (req, res) => {
  if (req.params.package_name === 'ad-os-baseline') {
    await writeAudit({ userId: req.user.id, action: 'disable_builtin_ad_os_baseline', target: req.params.hostname, payload: { package: 'ad-os-baseline' } });
  }
  await db.query(`DELETE FROM ad_member_server_packages WHERE hostname = ? AND package_name = ?`,
    [req.params.hostname, req.params.package_name]);
  res.json({ ok: true });
});

// agent self-register
router.post('/admin/member-servers/self-register', async (req, res) => {
  const { hostname, agent_version, os_version, ip_address } = req.body;
  if (!hostname) return res.status(400).json({ error: { code: 'BAD_REQUEST' } });
  await db.query(sql.mysql.memberServers.upsert,
    [hostname, null, ip_address, os_version, 'non-ad', 1, 'self-register']);
  res.json({ ok: true });
});

module.exports = router;
```

(For MSSQL, the dynamic `UPDATE` uses named parameters; helper `mapField` translates `siteId → site_id` etc.)

- [ ] **Step 4: Extend `agent.js` heartbeat**

In `center/src/routes/agent.js`, in the existing `POST /api/agent/heartbeat` handler, after writing the `ad_agent_heartbeat` row:
```js
if (payload.agent_type === 'non-ad' && payload.hostname) {
  await db.query(sql.mysql.memberServers.touchLastSeen, [payload.hostname]);
}
```

(Plus MSSQL equivalent.)

- [ ] **Step 5: Mount the router in `server.js`**

```js
const memberRouter = require('./src/routes/member-servers');
app.use('/api', memberRouter);
```

- [ ] **Step 6: Mirror**

```bash
cp center/src/routes/member-servers.js publish/center/src/routes/member-servers.js
cp center/src/routes/agent.js          publish/center/src/routes/agent.js
cp center/server.js                    publish/center/server.js
```

- [ ] **Step 7: Run, expect pass**

Run: `npx jest center/tests/member-servers-api.test.js`
Expected: 6 tests pass.

- [ ] **Step 8: Commit**

```bash
git add center/src/routes/ center/server.js center/tests/ publish/center/
git commit -m "feat(non-ad): memberRouter CRUD + per-server package bind + heartbeat ext"
```

## Task 7: Server groups + bulk install/uninstall routes

**Files:**
- Modify: `center/src/routes/admin.js` (add 5 routes)
- Create: `center/tests/server-groups-api.test.js`
- Mirror `admin.js`

**Interfaces:**
- `GET    /api/admin/server-groups` — list with `member_count`.
- `POST   /api/admin/server-groups` — create; 409 on duplicate.
- `PUT    /api/admin/server-groups/:group_id` — rename / describe.
- `DELETE /api/admin/server-groups/:group_id` — drop.
- `GET    /api/admin/server-groups/:group_id/members` — hostnames.
- `PUT    /api/admin/server-groups/:group_id/members` — replace (idempotent).
- `POST   /api/admin/server-groups/:group_id/packages/install` body `{package_name, confirmDropSchema:false}`.
- `POST   /api/admin/server-groups/:group_id/packages/:package_name/uninstall` — `DELETE` row.
- `POST   /api/admin/server-groups/:group_id/packages/:package_name/enable` / `disable`.

- [ ] **Step 1: Write the failing tests**

`center/tests/server-groups-api.test.js` (5 tests):
```js
test('POST /api/admin/server-groups creates group', async () => {
  const r = await request(app).post('/api/admin/server-groups')
    .set('Authorization', 'Bearer ' + TEST_TOKEN).send({ group_name: 'g1' });
  expect(r.status).toBe(200);
});
test('PUT /api/admin/server-groups/:id/members replaces', async () => {
  const r = await request(app).put('/api/admin/server-groups/1/members')
    .set('Authorization', 'Bearer ' + TEST_TOKEN).send({ hostnames: ['SRV-A','SRV-B'] });
  expect(r.status).toBe(200);
});
test('POST /api/admin/server-groups/:id/packages/install enqueues per-host rows', async () => {
  const r = await request(app).post('/api/admin/server-groups/1/packages/install')
    .set('Authorization', 'Bearer ' + TEST_TOKEN).send({ package_name: 'ad-os-baseline', confirmDropSchema: false });
  expect(r.status).toBe(200);
});
test('404 on missing group', async () => {
  const r = await request(app).delete('/api/admin/server-groups/99999')
    .set('Authorization', 'Bearer ' + TEST_TOKEN);
  expect(r.status).toBe(404);
});
test('401 without auth', async () => {
  const r = await request(app).get('/api/admin/server-groups');
  expect(r.status).toBe(401);
});
```

- [ ] **Step 2: Run, expect 404 / route not found**

Run: `npx jest center/tests/server-groups-api.test.js`
Expected: 404s.

- [ ] **Step 3: Add the routes**

Append the 9 handlers to `center/src/routes/admin.js`, each guarded by `[userAuth, requirePerm('admin:users')]`. Use `db.query` with the SQL strings from Task 2.

For `packages/install`, iterate `members` and `INSERT IGNORE` (or `MERGE` for MSSQL) into `ad_member_server_packages`. For `packages/:name/uninstall`, `DELETE FROM ad_member_server_packages WHERE group_id = ? AND package_name = ?` (joined via `ad_server_group_members`).

- [ ] **Step 4: Mirror**

```bash
cp center/src/routes/admin.js publish/center/src/routes/admin.js
```

- [ ] **Step 5: Run, expect pass**

Run: `npx jest center/tests/server-groups-api.test.js`
Expected: 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add center/src/routes/admin.js center/tests/server-groups-api.test.js publish/center/src/routes/admin.js
git commit -m "feat(non-ad): server-groups CRUD + bulk install/uninstall routes"
```

## Task 8: `agent-packages-for-host` service + endpoint

**Files:**
- Create: `center/src/services/agent-packages-for-host.js`
- Create: `center/src/routes/agent-packages.js` (the `/api/admin/agent/packages-for-host` endpoint lives here)
- Modify: `center/server.js` (mount the route)
- Create: `center/tests/agent-packages-for-host.test.js`
- Mirror all three to publish/center/

**Interfaces:** `getPackagesForHost({hostname}) → PackageManifest[]` merges global `installed_packages` (already filtered to `agent.platforms`) with `ad_member_server_packages` rows for the hostname, and applies an additional filter: drop any package whose `manifest.agent.type !== this agent's type` (the type is implied: if a row is in `ad_member_server_packages` it must be `non-ad`; if it's only in `installed_packages` it must be `ad`).

- [ ] **Step 1: Write the failing test**

```js
const { describe, test, expect } = require('@jest/globals');
const { mergePackagesForHost } = require('../src/services/agent-packages-for-host');

describe('agent-packages-for-host', () => {
  test('returns ad packages when host has no member_server_packages rows', () => {
    const r = mergePackagesForHost({
      installedGlobal: [{ name: 'x', agent: { type: 'ad' }, platforms: ['windows'] }],
      memberServerPackages: []
    });
    expect(r).toHaveLength(1);
  });
  test('returns non-ad packages when host has member_server_packages row', () => {
    const r = mergePackagesForHost({
      installedGlobal: [{ name: 'ad-os-baseline', agent: { type: 'non-ad' }, platforms: ['windows'] }],
      memberServerPackages: [{ package_name: 'ad-os-baseline', enabled: 1 }]
    });
    expect(r).toHaveLength(1);
  });
  test('drops disabled rows', () => {
    const r = mergePackagesForHost({
      installedGlobal: [{ name: 'ad-os-baseline', agent: { type: 'non-ad' }, platforms: ['windows'] }],
      memberServerPackages: [{ package_name: 'ad-os-baseline', enabled: 0 }]
    });
    expect(r).toHaveLength(0);
  });
  test('drops ad packages from member-server context (type mismatch)', () => {
    const r = mergePackagesForHost({
      installedGlobal: [{ name: 'dc-foo', agent: { type: 'ad' }, platforms: ['windows'] }],
      memberServerPackages: [{ package_name: 'dc-foo', enabled: 1 }]
    });
    expect(r).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Implement**

`center/src/services/agent-packages-for-host.js`:
```js
function mergePackagesForHost({ installedGlobal, memberServerPackages }) {
  const byName = new Map();
  // member-server rows take precedence; their packages must be non-ad
  for (const row of memberServerPackages || []) {
    if (!row.enabled) continue;
    byName.set(row.package_name, { source: 'member', enabled: row.enabled });
  }
  // global packages are always ad
  for (const p of installedGlobal || []) {
    if (byName.has(p.name)) continue;            // member wins
    byName.set(p.name, { source: 'global', manifest: p });
  }
  const out = [];
  for (const [name, meta] of byName) {
    if (meta.source === 'member') {
      const m = (installedGlobal || []).find(p => p.name === name);
      if (!m) continue;
      if (m.agent.type !== 'non-ad') continue;   // type mismatch guard
      out.push(m);
    } else {
      out.push(meta.manifest);
    }
  }
  return out;
}

module.exports = { mergePackagesForHost };
```

Endpoint `center/src/routes/agent-packages.js`:
```js
const router = require('express').Router();
const { db } = require('../db');
const { mergePackagesForHost } = require('../services/agent-packages-for-host');

router.get('/admin/agent/packages-for-host', async (req, res) => {
  const { hostname } = req.query;
  if (!hostname) return res.status(400).json({ error: { code: 'BAD_REQUEST' } });
  const installed = await db.query(`SELECT * FROM installed_packages WHERE enabled = 1`);
  const ms = await db.query(`SELECT * FROM ad_member_server_packages WHERE hostname = ?`, [hostname]);
  const merged = mergePackagesForHost({ installedGlobal: installed, memberServerPackages: ms });
  res.json({ items: merged });
});

module.exports = router;
```

- [ ] **Step 3: Mount + mirror**

```js
// server.js
const agentPackagesRouter = require('./src/routes/agent-packages');
app.use('/api', agentPackagesRouter);
```

```bash
cp center/src/services/agent-packages-for-host.js publish/center/src/services/
cp center/src/routes/agent-packages.js          publish/center/src/routes/
cp center/server.js                              publish/center/server.js
```

- [ ] **Step 4: Run, expect pass**

Run: `npx jest center/tests/agent-packages-for-host.test.js`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add center/src/services/agent-packages-for-host.js center/src/routes/agent-packages.js center/server.js center/tests/ publish/center/
git commit -m "feat(non-ad): per-host package merge + /api/admin/agent/packages-for-host"
```

## Task 9: `EmailService` (SMTP + retry + password masking)

**Files:**
- Create: `center/src/services/email.js`
- Create: `center/tests/email.test.js`
- Mirror `email.js` to publish/center/src/services/email.js

**Interfaces:**
- `EmailService.send({to, cc, subject, body_text, body_html}) → {ok, error?}`
- `EmailService.maskPassword(systemConfig)` — returns a copy of config with `smtp_password: '********'` if set.
- Backoff calculator: `nextAttemptDelay(attempt_count) → seconds` — `initial * 2^(attempt_count - 1)`, capped at 3600.

- [ ] **Step 1: Add nodemailer**

Run: `npm install --save nodemailer@^6.9.0` (in `center/`)
Expected: dependency added.

- [ ] **Step 2: Write the failing tests**

`center/tests/email.test.js`:
```js
const { describe, test, expect, jest } = require('@jest/globals');

describe('email service', () => {
  test('maskPassword replaces existing password with ********', () => {
    const masked = maskPassword({ smtp_host: 's', smtp_password: 'secret' });
    expect(masked.smtp_password).toBe('********');
  });
  test('maskPassword leaves empty password empty', () => {
    const masked = maskPassword({ smtp_host: 's', smtp_password: '' });
    expect(masked.smtp_password).toBe('');
  });
  test('nextAttemptDelay doubles', () => {
    expect(nextAttemptDelay(1, 30)).toBe(30);
    expect(nextAttemptDelay(2, 30)).toBe(60);
    expect(nextAttemptDelay(3, 30)).toBe(120);
  });
  test('nextAttemptDelay caps at 3600', () => {
    expect(nextAttemptDelay(20, 30)).toBe(3600);
  });
  test('send calls nodemailer with the right transport', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'x' });
    jest.mock('nodemailer', () => ({ createTransport: () => ({ sendMail }) }));
    const { send } = require('../src/services/email');
    const r = await send({
      smtp: { host: 'h', port: 25, secure: false, user: '', password: '' },
      from: 'a', to: 'b', subject: 's', text: 't'
    }, { sendMail });
    expect(r.ok).toBe(true);
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'b', subject: 's' }));
  });
});
```

- [ ] **Step 3: Implement**

`center/src/services/email.js`:
```js
const nodemailer = require('nodemailer');

function maskPassword(cfg) {
  const c = { ...cfg };
  if (c.smtp_password) c.smtp_password = '********';
  return c;
}

function nextAttemptDelay(attemptCount, initialSeconds) {
  return Math.min(3600, initialSeconds * Math.pow(2, attemptCount - 1));
}

async function buildTransport(smtp) {
  return nodemailer.createTransport({
    host: smtp.host, port: smtp.port, secure: !!smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined
  });
}

async function send({ smtp, from, to, cc, subject, text, html }, deps = {}) {
  try {
    const tx = deps.transport ?? await buildTransport(smtp);
    const sendMail = deps.sendMail ?? tx.sendMail.bind(tx);
    await sendMail({ from, to, cc, subject, text, html });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { maskPassword, nextAttemptDelay, send };
```

- [ ] **Step 4: Mirror**

```bash
cp center/src/services/email.js publish/center/src/services/email.js
cp center/package.json publish/center/package.json
```

- [ ] **Step 5: Run, expect pass**

Run: `npx jest center/tests/email.test.js`
Expected: 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add center/src/services/email.js center/package.json center/tests/email.test.js publish/center/src/services/email.js publish/center/package.json
git commit -m "feat(non-ad): EmailService SMTP + password mask + exponential backoff"
```

## Task 10: `AlertEngine` — recursive condition evaluation

**Files:**
- Create: `center/src/services/alert-engine.js`
- Create: `center/tests/alert-engine.test.js`
- Mirror `alert-engine.js`

**Interfaces:**
- `evaluateCondition(condition, metrics) → {hit: boolean, observedValues: {metric: value}}`
- `transitionState(currentState, hit, now, rule) → newState`
- Pure functions; no DB.

- [ ] **Step 1: Write the failing tests**

`center/tests/alert-engine.test.js`:
```js
const { describe, test, expect } = require('@jest/globals');
const { evaluateCondition, transitionState } = require('../src/services/alert-engine');

describe('evaluateCondition', () => {
  test('simple GT leaf', () => {
    const r = evaluateCondition({ op: 'GT', metric: 'cpu_pct', value: 90 }, { cpu_pct: 95 });
    expect(r.hit).toBe(true);
  });
  test('OR with two leaves', () => {
    const c = { op: 'OR', children: [
      { op: 'GT', metric: 'cpu_pct', value: 90 },
      { op: 'GT', metric: 'memory_pct', value: 85 }
    ]};
    expect(evaluateCondition(c, { cpu_pct: 50, memory_pct: 90 }).hit).toBe(true);
    expect(evaluateCondition(c, { cpu_pct: 50, memory_pct: 50 }).hit).toBe(false);
  });
  test('AND with two leaves', () => {
    const c = { op: 'AND', children: [
      { op: 'GT', metric: 'cpu_pct', value: 90 },
      { op: 'GT', metric: 'memory_pct', value: 85 }
    ]};
    expect(evaluateCondition(c, { cpu_pct: 95, memory_pct: 90 }).hit).toBe(true);
    expect(evaluateCondition(c, { cpu_pct: 95, memory_pct: 50 }).hit).toBe(false);
  });
  test('nested OR(AND, leaf)', () => {
    const c = { op: 'OR', children: [
      { op: 'AND', children: [
        { op: 'LT', metric: 'disk_free:D', value: 1000 },
        { op: 'LT', metric: 'disk_free:E', value: 500 }
      ]},
      { op: 'GT', metric: 'cpu_pct', value: 95 }
    ]};
    expect(evaluateCondition(c, { cpu_pct: 50, disk_free: { D: 500, E: 200 } }).hit).toBe(true);
    expect(evaluateCondition(c, { cpu_pct: 99, disk_free: { D: 5000, E: 5000 } }).hit).toBe(true);
  });
  test('heartbeat_stale synthetic metric', () => {
    const r = evaluateCondition({ op: 'GT', metric: 'heartbeat_stale', value: 5 }, { heartbeat_stale: 10 });
    expect(r.hit).toBe(true);
  });
  test('unknown metric → hit=false', () => {
    expect(evaluateCondition({ op: 'GT', metric: 'unknown', value: 1 }, {}).hit).toBe(false);
  });
});

describe('transitionState', () => {
  const rule = { for_minutes: 5, cooldown_minutes: 30 };
  const now = new Date('2026-01-01T00:00:00Z');
  test('normal + hit → pending', () => {
    expect(transitionState({ state: 'normal' }, true, now, rule).state).toBe('pending');
  });
  test('pending + hit and elapsed >= for_minutes → firing', () => {
    const s = transitionState({ state: 'pending', first_hit_at: new Date(now.getTime() - 6 * 60_000) }, true, now, rule);
    expect(s.state).toBe('firing');
  });
  test('firing + no-hit and elapsed >= for_minutes → normal + last_recovered_at', () => {
    const s = transitionState({ state: 'firing', last_fired_at: new Date(now.getTime() - 6 * 60_000) }, false, now, rule);
    expect(s.state).toBe('normal');
    expect(s.last_recovered_at).toBeDefined();
  });
  test('firing + cooldown active → no-op (state stays firing)', () => {
    const s = transitionState({ state: 'firing', suppressed_until: new Date(now.getTime() + 60_000), last_fired_at: new Date(now.getTime() - 1 * 60_000) }, true, now, rule);
    expect(s.state).toBe('firing');
  });
});
```

- [ ] **Step 2: Run, expect compile error**

Run: `npx jest center/tests/alert-engine.test.js`
Expected: module not found.

- [ ] **Step 3: Implement**

```js
function readMetric(metrics, name) {
  if (name === 'heartbeat_stale') return metrics.heartbeat_stale;
  if (name.startsWith('disk_free:')) return metrics.disk_free?.[name.split(':')[1]];
  if (name.startsWith('service_state:')) return metrics.services?.[name.split(':')[1]];
  if (name.startsWith('event_log:')) return (metrics.events || []).filter(e => e.log === name.split(':')[1]);
  return metrics[name];
}

function evalLeaf(leaf, metrics) {
  const v = readMetric(metrics, leaf.metric);
  if (v === undefined || v === null) return { hit: false, observedValue: null };
  let hit = false;
  switch (leaf.op) {
    case 'GT': hit = v > leaf.value; break;
    case 'LT': hit = v < leaf.value; break;
    case 'EQ': hit = v === leaf.value; break;
    case 'NEQ': hit = v !== leaf.value; break;
    default: hit = false;
  }
  return { hit, observedValue: v };
}

function evaluateCondition(node, metrics) {
  if (!node) return { hit: false, observedValues: {} };
  if (node.op === 'AND' || node.op === 'OR') {
    const childResults = node.children.map(c => evaluateCondition(c, metrics));
    const hit = node.op === 'AND' ? childResults.every(r => r.hit) : childResults.some(r => r.hit);
    return { hit, observedValues: Object.assign({}, ...childResults.map(r => r.observedValues)) };
  }
  const r = evalLeaf(node, metrics);
  return { hit: r.hit, observedValues: { [node.metric]: r.observedValue } };
}

function transitionState(s, hit, now, rule) {
  const elapsedMin = (n, t) => t ? Math.floor((n.getTime() - new Date(t).getTime()) / 60000) : 0;
  if (s.state === 'normal' && hit) return { ...s, state: 'pending', first_hit_at: now };
  if (s.state === 'pending') {
    if (!hit) return { state: 'normal', first_hit_at: null, last_evaluated_at: now };
    if (elapsedMin(now, s.first_hit_at) >= rule.for_minutes) return { ...s, state: 'firing', last_fired_at: now };
    return { ...s, last_evaluated_at: now };
  }
  if (s.state === 'firing') {
    if (s.suppressed_until && new Date(s.suppressed_until) > now) return { ...s, last_evaluated_at: now };  // cooldown
    if (!hit && elapsedMin(now, s.last_fired_at) >= rule.for_minutes) {
      return { ...s, state: 'normal', last_recovered_at: now, suppressed_until: null, first_hit_at: null };
    }
    return { ...s, last_evaluated_at: now };
  }
  return { ...s, last_evaluated_at: now };
}

module.exports = { evaluateCondition, transitionState };
```

- [ ] **Step 4: Mirror**

```bash
cp center/src/services/alert-engine.js publish/center/src/services/alert-engine.js
```

- [ ] **Step 5: Run, expect pass**

Run: `npx jest center/tests/alert-engine.test.js`
Expected: 10 tests pass.

- [ ] **Step 6: Commit**

```bash
git add center/src/services/alert-engine.js center/tests/alert-engine.test.js publish/center/src/services/alert-engine.js
git commit -m "feat(non-ad): AlertEngine condition evaluator + state transitions"
```

## Task 11: `AlertEvaluationLoop` + `EmailDeliveryLoop` (loops + service mount)

**Files:**
- Modify: `center/src/services/alert-engine.js` (add `createAlertEvaluationLoop` factory)
- Modify: `center/src/services/email.js` (add `createEmailDeliveryLoop` factory)
- Modify: `center/server.js` (start/stop both loops)
- Create: `center/tests/alert-evaluation-loop.test.js`
- Create: `center/tests/email-outbox-loop.test.js`
- Mirror all modified files

**Interfaces:** Both loops match `createProbeLoop` factory shape. Alert loop ticks every `alert_eval_interval_seconds` (floor 10s); reads per-host metrics, evaluates rules, writes state + events + outbox in a transaction. Email loop reads outbox rows where `sent_at IS NULL AND next_attempt_at <= NOW()`, sends via `EmailService.send`, increments `attempt_count`, applies backoff.

- [ ] **Step 1: Write the failing loop tests**

`center/tests/alert-evaluation-loop.test.js` (4 tests):
```js
test('tick fires a rule that has been pending past for_minutes', async () => {
  // seed: ad_member_servers row, alert_rule, alert_rule_state (pending, first_hit_at = 6min ago)
  // stub: latest metrics = cpu_pct 95
  // run one tick
  // assert: alert_events has 1 firing row; alert_email_outbox has 1 row
});
test('recovery fires email when firing has been no-hit for for_minutes', async () => {
  // seed: firing, last_fired_at = 10min ago
  // stub: metrics = cpu_pct 50
  // tick → state normal, alert_events recovered row, outbox recovery email
});
test('cooldown suppresses re-fire', async () => {
  // seed: firing, suppressed_until = 60min future
  // tick → no new outbox row
});
test('disabled rule is skipped', async () => { /* ... */ });
```

`center/tests/email-outbox-loop.test.js` (3 tests):
```js
test('tick sends a pending outbox row and stamps sent_at', async () => {
  // seed: outbox row with smtp mock
});
test('failed send increments attempt_count + sets next_attempt_at', async () => {
  // mock nodemailer to throw; verify backoff
});
test('skips rows with sent_at set', async () => { /* ... */ });
```

- [ ] **Step 2: Implement `createAlertEvaluationLoop`**

Add to `center/src/services/alert-engine.js`:
```js
const { evaluateCondition, transitionState } = require('./alert-engine-core');
const { db, writeAudit } = require('../db');
const sql = require('../db/sql');

function createAlertEvaluationLoop({ getIntervalSeconds, getSystemConfig }) {
  let timer = null;
  let inFlight = false;
  let running = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const intervalSec = Math.max(10, await getIntervalSeconds());
      const hosts = await db.query(`SELECT hostname FROM ad_member_servers WHERE enabled = 1`);
      for (const h of hosts) await evaluateOneHost(h.hostname, intervalSec);
    } catch (err) {
      console.error('[alert-eval] tick failed:', err);
    } finally { inFlight = false; }
  };
  const evaluateOneHost = async (hostname, intervalSec) => {
    const rules = await db.query(
      `SELECT r.rule_id, r.hostname, r.condition, r.for_minutes, r.cooldown_minutes, r.recipients, r.enabled,
              s.state, s.first_hit_at, s.last_fired_at, s.suppressed_until
       FROM alert_rules r LEFT JOIN alert_rule_state s ON s.rule_id = r.rule_id
       WHERE r.hostname = ? AND r.enabled = 1`, [hostname]);
    if (rules.length === 0) return;
    const metrics = await db.query(
      `SELECT TOP 1 cpu_pct, memory_pct, disk_free, services, events FROM pkg_ad_os_baseline.metrics WHERE agent_id = ? ORDER BY ts DESC`,
      [hostname]);
    const lastSeen = await db.query(`SELECT last_seen_at FROM ad_member_servers WHERE hostname = ?`, [hostname]);
    const ctx = { ...(metrics[0] || {}), heartbeat_stale: lastSeen[0]?.last_seen_at ? Math.floor((Date.now() - new Date(lastSeen[0].last_seen_at).getTime()) / 60000) : null };
    for (const rule of rules) {
      const cond = JSON.parse(rule.condition);
      const { hit } = evaluateCondition(cond, ctx);
      const prevState = { state: rule.state || 'normal', first_hit_at: rule.first_hit_at, last_fired_at: rule.last_fired_at, suppressed_until: rule.suppressed_until };
      const next = transitionState(prevState, hit, new Date(), { for_minutes: rule.for_minutes, cooldown_minutes: rule.cooldown_minutes });
      await db.tx(async (tx) => {
        await tx.query(`MERGE INTO alert_rule_state AS t USING (SELECT ? AS rule_id) AS s ON t.rule_id = s.rule_id
          WHEN MATCHED THEN UPDATE SET state=?, first_hit_at=?, last_evaluated_at=SYSDATETIMEOFFSET(), last_fired_at=?, suppressed_until=?
          WHEN NOT MATCHED THEN INSERT (rule_id, state, first_hit_at, last_evaluated_at, last_fired_at, suppressed_until) VALUES (?, ?, ?, SYSDATETIMEOFFSET(), ?, ?);`,
          [rule.rule_id, next.state, next.first_hit_at, next.last_fired_at, next.suppressed_until,
           rule.rule_id, next.state, next.first_hit_at, next.last_fired_at, next.suppressed_until]);
        if (prevState.state !== 'firing' && next.state === 'firing') {
          const evt = await tx.query(`INSERT INTO alert_events (rule_id, hostname, event, detail) OUTPUT INSERTED.id VALUES (?, ?, 'firing', ?);`,
            [rule.rule_id, hostname, JSON.stringify({ condition: cond, metrics: ctx })]);
          const sysCfg = await getSystemConfig(['alert_default_to','alert_default_cc','smtp_from']);
          const recipients = JSON.parse(rule.recipients || 'null') || { to: sysCfg.alert_default_to, cc: sysCfg.alert_default_cc };
          await tx.query(`INSERT INTO alert_email_outbox (alert_event_id, to_addrs, cc_addrs, subject, body_text) VALUES (?, ?, ?, ?, ?);`,
            [evt[0].id, recipients.to || '', recipients.cc || null, `[ALERT] ${rule.hostname} — ${rule.rule_id}`, `Condition fired for ${rule.hostname}.\n\n` + JSON.stringify({ condition: cond, metrics: ctx }, null, 2)]);
        }
        if (prevState.state === 'firing' && next.state === 'normal') {
          const evt = await tx.query(`INSERT INTO alert_events (rule_id, hostname, event, detail) OUTPUT INSERTED.id VALUES (?, ?, 'recovered', ?);`,
            [rule.rule_id, hostname, JSON.stringify({ condition: cond, recovered_at: next.last_recovered_at })]);
          const sysCfg = await getSystemConfig(['alert_default_to','alert_default_cc','smtp_from']);
          const recipients = JSON.parse(rule.recipients || 'null') || { to: sysCfg.alert_default_to, cc: sysCfg.alert_default_cc };
          await tx.query(`INSERT INTO alert_email_outbox (alert_event_id, to_addrs, cc_addrs, subject, body_text) VALUES (?, ?, ?, ?, ?);`,
            [evt[0].id, recipients.to || '', recipients.cc || null, `[RECOVERED] ${rule.hostname} — ${rule.rule_id}`, `Condition cleared for ${rule.hostname}.`]);
        }
      });
    }
  };
  return {
    start() { if (running) return; running = true; timer = setInterval(tick, Math.max(10, 1000 * (intervalSec || 60))); },
    stop() { running = false; if (timer) clearInterval(timer); },
    tick, isRunning: () => running
  };
}

module.exports = { createAlertEvaluationLoop, evaluateCondition, transitionState };
```

(Implementation follows spec §9.2: per-host loop, single transaction for state + event + outbox insert.)

- [ ] **Step 3: Implement `createEmailDeliveryLoop`**

Add to `center/src/services/email.js`:
```js
function createEmailDeliveryLoop({ getIntervalSeconds, getSystemConfig }) {
  let timer = null; let inFlight = false; let running = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const rows = await db.query(
        process.env.DB_DIALECT === 'mysql'
          ? `SELECT * FROM alert_email_outbox WHERE sent_at IS NULL AND next_attempt_at <= NOW() ORDER BY id LIMIT 25 FOR UPDATE SKIP LOCKED`
          : `SELECT TOP 25 * FROM alert_email_outbox WHERE sent_at IS NULL AND next_attempt_at <= GETDATE() ORDER BY id`
      );
      for (const row of rows) await tryDeliver(row);
    } finally { inFlight = false; }
  };
  const tryDeliver = async (row) => {
    try {
      const smtp = await getSystemConfig(['smtp_host','smtp_port','smtp_secure','smtp_user','smtp_password','smtp_from']);
      const r = await send({ smtp, from: smtp.smtp_from, to: row.to_addrs, cc: row.cc_addrs, subject: row.subject, text: row.body_text, html: row.body_html });
      if (r.ok) await db.query(`UPDATE alert_email_outbox SET sent_at = NOW(), last_error = NULL WHERE id = ?`, [row.id]);
      else await scheduleRetry(row);
    } catch (err) { await scheduleRetry(row, err.message); }
  };
  const scheduleRetry = async (row, err) => {
    const max = await getSystemConfig(['alert_email_max_attempts']);
    if (row.attempt_count + 1 >= max) {
      await db.query(`UPDATE alert_email_outbox SET attempt_count = attempt_count + 1, last_error = ? WHERE id = ?`, [err ?? 'unknown', row.id]);
      await db.query(`INSERT INTO alert_events (rule_id, hostname, event, detail) VALUES (?, ?, 'cooldown_skipped', ?)`, [0, '', JSON.stringify({ outbox_id: row.id, error: err })]);
      return;
    }
    const delay = nextAttemptDelay(row.attempt_count + 1, 30);
    await db.query(`UPDATE alert_email_outbox SET attempt_count = attempt_count + 1, next_attempt_at = DATE_ADD(NOW(), INTERVAL ? SECOND), last_error = ? WHERE id = ?`, [delay, err ?? 'unknown', row.id]);
  };
  return { start() { if (running) return; running = true; timer = setInterval(tick, 60000); }, stop() { running = false; if (timer) clearInterval(timer); }, tick, isRunning: () => running };
}
```

- [ ] **Step 4: Mount in `server.js`**

After `probeLoop`:
```js
const { createAlertEvaluationLoop } = require('./src/services/alert-engine');
const { createEmailDeliveryLoop } = require('./src/services/email');

const alertLoop = createAlertEvaluationLoop({ getIntervalSeconds: async () => Number(await getConfig('alert_eval_interval_seconds', 60)) });
const emailLoop = createEmailDeliveryLoop({ getIntervalSeconds: async () => Number(await getConfig('alert_eval_interval_seconds', 60)) });
if (config.mode === 'normal') { alertLoop.start(); emailLoop.start(); }
// shutdown
process.on('SIGTERM', async () => { alertLoop.stop(); emailLoop.stop(); probeLoop.stop(); });
```

- [ ] **Step 5: Mirror**

```bash
cp center/src/services/alert-engine.js publish/center/src/services/alert-engine.js
cp center/src/services/email.js        publish/center/src/services/email.js
cp center/server.js                    publish/center/server.js
```

- [ ] **Step 6: Run, expect pass**

Run: `npx jest center/tests/alert-evaluation-loop.test.js center/tests/email-outbox-loop.test.js`
Expected: 7 tests pass.

- [ ] **Step 7: Commit**

```bash
git add center/src/services/alert-engine.js center/src/services/email.js center/server.js center/tests/ publish/center/
git commit -m "feat(non-ad): AlertEvaluationLoop + EmailDeliveryLoop + server mount"
```

## Task 12: `system_config` SMTP seed + `ConfigView` email card + test-mail route

**Files:**
- Modify: `center/src/db/seed.js` (seed SMTP defaults)
- Modify: `center/src/routes/admin.js` (`POST /api/admin/config/email/test`)
- Modify: `center/src/services/config.js` (mask password on read; preserve empty on write)
- Create: `center/tests/config-smtp.test.js`
- Mirror all modified files

- [ ] **Step 1: Write the failing test**

```js
test('config read masks smtp_password', async () => {
  await db.query(`INSERT INTO system_config (config_key, config_value) VALUES ('smtp_password', 'plain')`);
  const cfg = await getConfigAll(['smtp_host','smtp_password']);
  expect(cfg.smtp_password).toBe('********');
});
test('PUT with empty smtp_password preserves existing', async () => {
  await putConfig({ smtp_password: '' });
  const v = await db.query(`SELECT config_value FROM system_config WHERE config_key = 'smtp_password'`)[0].config_value;
  expect(v).toBe('plain');
});
test('PUT with ******** preserves existing', async () => { /* ... */ });
test('PUT with real value updates', async () => { /* ... */ });
test('POST /api/admin/config/email/test sends a one-off', async () => { /* ... */ });
```

- [ ] **Step 2: Run, expect fail**

Run: `npx jest center/tests/config-smtp.test.js`
Expected: password echoed in clear.

- [ ] **Step 3: Patch `getConfigAll` / `putConfig`**

```js
function maskSmtp(cfg) {
  if (cfg.smtp_password && cfg.smtp_password !== '********') cfg = { ...cfg, smtp_password: '********' };
  return cfg;
}
async function putConfig(patch) {
  if ('smtp_password' in patch && (!patch.smtp_password || patch.smtp_password === '********')) delete patch.smtp_password;
  // ... existing apply logic
}
```

- [ ] **Step 4: Add seed in `db/seed.js`**

```js
const SMTP_DEFAULTS = [
  ['smtp_host', ''], ['smtp_port', '25'], ['smtp_secure', 'false'],
  ['smtp_user', ''], ['smtp_password', ''], ['smtp_from', ''],
  ['alert_default_to', ''], ['alert_default_cc', ''],
  ['alert_eval_interval_seconds', '60'],
  ['alert_email_max_attempts', '5'],
  ['alert_email_initial_backoff_seconds', '30']
];
// use existing `seedIfMissing(key, value)` helper
```

- [ ] **Step 5: Add the email-test route**

```js
router.post('/admin/config/email/test', userAuth, requirePerm('admin:users'), async (req, res) => {
  const cfg = await getConfigAll(['smtp_host','smtp_port','smtp_secure','smtp_user','smtp_password','smtp_from']);
  const r = await email.send({ smtp: cfg, from: cfg.smtp_from, to: req.body.to, subject: 'AD Dashboard test', text: 'Test email.' });
  res.status(r.ok ? 200 : 500).json({ ok: r.ok, error: r.error });
});
```

- [ ] **Step 6: Mirror**

```bash
cp center/src/db/seed.js             publish/center/src/db/seed.js
cp center/src/services/config.js     publish/center/src/services/config.js
cp center/src/routes/admin.js        publish/center/src/routes/admin.js
```

- [ ] **Step 7: Run, expect pass**

Run: `npx jest center/tests/config-smtp.test.js`
Expected: 5 tests pass.

- [ ] **Step 8: Commit**

```bash
git add center/src/db/seed.js center/src/services/config.js center/src/routes/admin.js center/tests/ publish/center/
git commit -m "feat(non-ad): SMTP config seed + mask-on-read + email-test route"
```

## Task 13: Frontend — `MemberServersView`, `MemberServerDetailView`, `ServerGroupsView`

**Files:**
- Create: `frontend/src/api/admin.js` modifications (`adminApi.listMemberServers`, `getMemberServer`, `createMemberServer`, `editMemberServer`, `deleteMemberServer`, `listMemberServerPackages`, `setMemberServerPackageEnabled`, `removeMemberServerPackage`, `listServerGroups`, `createServerGroup`, `editServerGroup`, `deleteServerGroup`, `listServerGroupMembers`, `replaceServerGroupMembers`, `bulkInstallForGroup`, `bulkUninstallForGroup`).
- Create: `frontend/src/views/admin/MemberServersView.vue`
- Create: `frontend/src/views/admin/MemberServerDetailView.vue`
- Create: `frontend/src/views/admin/ServerGroupsView.vue`
- Create: `frontend/tests/member-servers-view.test.js`
- Modify: `frontend/src/router/index.js`
- Modify: `frontend/src/layouts/AdminLayout.vue` (new menu group)

- [ ] **Step 1: Add API methods**

Append ~14 methods to `frontend/src/api/admin.js` mapping to the routes in Tasks 6 and 7.

- [ ] **Step 2: Build `MemberServersView.vue`**

Columns mirror spec §6.2: hostname, site_name, ip_address, os_version, enabled switch, last_seen_at, last_report_at, actions. Reuse `BulkImportDialog` with columns `{hostname, siteName, ipAddress, osVersion}`. Submit calls `adminApi.bulkImportMemberServers` (new bulk endpoint or reuse single-row create in a loop — pick loop for v1).

- [ ] **Step 3: Build `MemberServerDetailView.vue`**

Top-down layout per spec §6.3. Loads packages + alerts (next task) + baseline metrics.

- [ ] **Step 4: Build `ServerGroupsView.vue`**

List with `member_count`, CRUD dialogs, "Members" tab.

- [ ] **Step 5: Wire routes**

```js
{ path: '/admin/member-servers', component: MemberServersView, meta: { perm: 'admin:users' } },
{ path: '/admin/member-servers/:hostname', component: MemberServerDetailView, meta: { perm: 'admin:users' } },
{ path: '/admin/server-groups', component: ServerGroupsView, meta: { perm: 'admin:users' } },
{ path: '/admin/server-groups/:group_id', component: ServerGroupsView, meta: { perm: 'admin:users' } }
```

- [ ] **Step 6: Update AdminLayout menu**

Add group `服务器管理` with two items (above existing `AD 域控`).

- [ ] **Step 7: Write frontend tests**

```js
test('MemberServersView renders table from list API', async () => { /* mock adminApi.listMemberServers → table rows render */ });
test('BulkImportDialog opens and submits member rows', async () => { /* ... */ });
```

- [ ] **Step 8: Run, expect pass**

Run: `cd frontend && npx vitest run frontend/tests/member-servers-view.test.js`
Expected: 2+ tests pass.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/ frontend/tests/
git commit -m "feat(non-ad): frontend MemberServersView / DetailView / ServerGroupsView"
```

## Task 14: Frontend — `RuleEditorDialog` + alerts tab + baseline metrics

**Files:**
- Create: `frontend/src/views/admin/RuleEditorDialog.vue`
- Create: `frontend/tests/rule-editor-dialog.test.js`
- Modify: `frontend/src/views/admin/MemberServerDetailView.vue` (add rule list + RuleEditorDialog trigger)

- [ ] **Step 1: Build `RuleEditorDialog.vue`**

Form-first nested editor (spec §6.4):
- Top `任一/所有` segmented control (`v-model="rootOp"`).
- Children list with `+ 条件` / `+ 子组` buttons. Each condition row: metric dropdown, operator dropdown, value input. Each group: nested `任一/所有` + children + buttons.
- Footer: rule-level `for_minutes`, `cooldown_minutes`, `收件人覆盖` (collapsible), `保存` / `取消`.
- Save: builds `{op: rootOp, children: [...]}` JSON; calls `adminApi.upsertAlertRule({hostname, name, condition: json, for_minutes, cooldown_minutes, recipients})`.

- [ ] **Step 2: Extend `MemberServerDetailView`**

Add a `告警规则` section listing rules + `+ 新建规则` button opening `RuleEditorDialog`. Add an `活动告警 / 历史` tabs section querying `GET /api/admin/member-servers/:hostname/alerts` (new endpoint, see Step 3). Add a `基线指标` tile grid reading `GET /api/admin/member-servers/:hostname/baseline` (new endpoint, see Step 3).

- [ ] **Step 3: Backend endpoints for alerts + baseline**

Add to `memberRouter`:
```js
router.get('/admin/member-servers/:hostname/alerts', userAuth, requirePerm('admin:users'), async (req, res) => {
  const rows = await db.query(`SELECT * FROM alert_events WHERE hostname = ? ORDER BY created_at DESC LIMIT 200`, [req.params.hostname]);
  res.json({ items: rows });
});
router.get('/admin/member-servers/:hostname/baseline', userAuth, requirePerm('admin:users'), async (req, res) => {
  const rows = await db.query(
    `SELECT * FROM pkg_ad_os_baseline.metrics WHERE agent_id = ? ORDER BY ts DESC LIMIT 1`,
    [req.params.hostname]);
  res.json({ latest: rows[0] || null });
});
```

(For MSSQL, use TOP 1 + ORDER BY ts DESC.)

- [ ] **Step 4: Tests**

```js
test('RuleEditorDialog renders rootOp and saves payload', async () => { /* ... */ });
test('adds + removes nested groups', async () => { /* ... */ });
```

- [ ] **Step 5: Run, expect pass**

Run: `cd frontend && npx vitest run frontend/tests/rule-editor-dialog.test.js`
Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/views/admin/RuleEditorDialog.vue frontend/src/views/admin/MemberServerDetailView.vue frontend/src/api/admin.js frontend/tests/rule-editor-dialog.test.js
git commit -m "feat(non-ad): RuleEditorDialog + alerts/baseline tabs in detail view"
```

## Task 15: Frontend — `EmailConfigCard` + integrate into `ConfigView`

**Files:**
- Create: `frontend/src/views/admin/EmailConfigCard.vue`
- Create: `frontend/tests/email-config-card.test.js`
- Modify: `frontend/src/views/admin/ConfigView.vue`

- [ ] **Step 1: Build `EmailConfigCard.vue`**

Card per spec §10:
- Text inputs: smtp_host, smtp_port, smtp_user, smtp_from, alert_default_to, alert_default_cc.
- Checkbox: smtp_secure.
- Password input: smtp_password — placeholder `********` when set, empty to clear.
- 高级 disclosure: eval interval, max attempts, initial backoff.
- `发送测试邮件` button — opens dialog asking for `to`, calls `adminApi.sendTestEmail({to})`, displays SMTP error verbatim.

- [ ] **Step 2: Mount in `ConfigView.vue`**

Insert `<EmailConfigCard />` above the existing port / token card. Pass the same `cfg` prop. The card emits `update` events that the parent `ConfigView` already handles.

- [ ] **Step 3: API method**

Add `adminApi.sendTestEmail({to})` → `POST /api/admin/config/email/test`.

- [ ] **Step 4: Test**

```js
test('EmailConfigCard masks smtp_password with ********', async () => { /* ... */ });
test('sending with empty password preserves server value', async () => { /* ... */ });
```

- [ ] **Step 5: Run, expect pass**

Run: `cd frontend && npx vitest run frontend/tests/email-config-card.test.js`
Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/views/admin/EmailConfigCard.vue frontend/src/views/admin/ConfigView.vue frontend/src/api/admin.js frontend/tests/email-config-card.test.js
git commit -m "feat(non-ad): EmailConfigCard + ConfigView integration"
```

## Task 16: Agent — `agentType` switch + non-AD runtime + install-agent.ps1 patch

**Files:**
- Modify: `agent/agent.js` (add `agentType` branch)
- Create: `agent/tests/agent-type.test.js`
- Create: `agent/tests/self-register.test.js`
- Modify: `scripts/install-agent.ps1` (add `-AgentType` parameter)
- Mirror `agent.js` to `publish/agent/agent.js`

- [ ] **Step 1: Write the failing tests**

```js
test('ad agent skips /api/admin/member-servers/self-register', async () => { /* ... */ });
test('non-ad agent calls /api/admin/member-servers/self-register on boot', async () => { /* ... */ });
test('non-ad agent filters packages by agent.type === non-ad', async () => { /* ... */ });
```

- [ ] **Step 2: Patch `agent/agent.js`**

At the top of the boot sequence:
```js
const AGENT_TYPE = config.agentType || 'ad';
if (AGENT_TYPE === 'non-ad') {
  await runNonAdRuntime();
} else {
  await runAdRuntime();    // existing DC flow, unchanged
}
```

`runNonAdRuntime`:
```js
async function runNonAdRuntime() {
  // 1. self-register once
  await httpPost('/api/admin/member-servers/self-register', {
    hostname: config.hostname,
    agent_version: VERSION,
    os_version: osInfo.version,
    ip_address: osInfo.ip
  });
  // 2. start package timer that polls /api/admin/agent/packages-for-host
  startPackageTimer({
    fetch: () => httpGet(`/api/admin/agent/packages-for-host?hostname=${encodeURIComponent(config.hostname)}`),
    filter: (pkg) => pkg.agent?.type === 'non-ad' && (pkg.agent.platforms || []).includes('windows'),
    onReport: reportPackage
  });
  // 3. heartbeat loop (existing endpoint, with agent_type: 'non-ad')
  startHeartbeat({ intervalSec: 5, payload: { agent_type: 'non-ad', hostname: config.hostname } });
}
```

- [ ] **Step 3: Patch `install-agent.ps1`**

Add parameter at the top:
```powershell
[CmdletBinding()]
param(
    [string]$AgentType = 'ad',
    # ... existing params
)
```

Persist `agentType` to `agent-config.json`:
```powershell
$cfg | ConvertTo-Json | Set-Content -Path (Join-Path $InstallDir 'agent-config.json') -Encoding UTF8
```

Use it when constructing the NSSM service arguments:
```powershell
if ($AgentType -eq 'non-ad') { $displayName = 'AD Dashboard Agent (Member)' } else { $displayName = 'AD Dashboard Agent (DC)' }
& nssm set $ServiceName DisplayName $displayName
```

(PowerShell 5.1-compatible — uses `if/else`, not `??` or ternary.)

- [ ] **Step 4: Mirror agent**

```bash
cp agent/agent.js publish/agent/agent.js
```

- [ ] **Step 5: Run, expect pass**

Run: `cd agent && npx jest tests/agent-type.test.js tests/self-register.test.js`
Expected: 3+ tests pass.

- [ ] **Step 6: Commit**

```bash
git add agent/agent.js agent/tests/ scripts/install-agent.ps1 publish/agent/agent.js
git commit -m "feat(non-ad): agent agentType switch + install-agent.ps1 -AgentType param"
```

## Task 17: Mirror registration + verification script update + final manual smoke test

**Files:**
- Modify: `scripts/verify-mirror.ps1` (add ~12 new pairs)
- Create: `docs/smoke-2026-08-09-non-ad.md` (smoke test report)

**Interfaces:** The mirror script must list every new file under `center/` with a paired `publish/center/` mirror. The whole-branch review runs this script and rejects on drift.

- [ ] **Step 1: Update `verify-mirror.ps1`**

Append to the existing pairs array:
```powershell
@(
  @{ source = 'center/src/services/alert-engine.js';              mirror = 'publish/center/src/services/alert-engine.js' }
  @{ source = 'center/src/services/email.js';                     mirror = 'publish/center/src/services/email.js' }
  @{ source = 'center/src/services/agent-packages-for-host.js';   mirror = 'publish/center/src/services/agent-packages-for-host.js' }
  @{ source = 'center/src/services/builtin-packages.js';          mirror = 'publish/center/src/services/builtin-packages.js' }
  @{ source = 'center/src/routes/member-servers.js';              mirror = 'publish/center/src/routes/member-servers.js' }
  @{ source = 'center/src/routes/agent-packages.js';              mirror = 'publish/center/src/routes/agent-packages.js' }
  @{ source = 'center/src/db/sql/member-servers.js';              mirror = 'publish/center/src/db/sql/member-servers.js' }
  @{ source = 'center/src/db/sql/server-groups.js';               mirror = 'publish/center/src/db/sql/server-groups.js' }
  @{ source = 'center/src/db/sql/alert-rules.js';                 mirror = 'publish/center/src/db/sql/alert-rules.js' }
  @{ source = 'center/src/db/sql/alert-events.js';                mirror = 'publish/center/src/db/sql/alert-events.js' }
  @{ source = 'center/src/db/sql/alert-outbox.js';                mirror = 'publish/center/src/db/sql/alert-outbox.js' }
  @{ source = 'db/migrations/014-member-servers.sql';             mirror = 'publish/db/migrations/014-member-servers.sql' }
  @{ source = 'db/migrations/mssql/014-member-servers.sql';      mirror = 'publish/db/migrations/mssql/014-member-servers.sql' }
  @{ source = 'agent/agent.js';                                   mirror = 'publish/agent/agent.js' }
)
```

(Patch in place via Edit, not rewrite — see existing structure.)

- [ ] **Step 2: Run the mirror script**

Run: `pwsh scripts/verify-mirror.ps1`
Expected: 0 drift. (All files already mirrored by per-task commits; this step verifies nothing was missed.)

- [ ] **Step 3: Manual smoke test**

Document the following scenarios in `docs/smoke-2026-08-09-non-ad.md`:

1. **Init**: Fresh center install → migration 014 applies → 8 tables present → SMTP defaults seeded.
2. **Built-in seed**: First normal-mode start → `data/packages/ad_os_baseline/1.0.0/manifest.json` exists → audit `seed_builtin_ad_os_baseline` row.
3. **Self-register**: Run `install-agent.ps1 -AgentType non-ad` on a member server → restart service → `ad_member_servers.hostname` row with `discovered_via='self-register'`, `last_seen_at` updated by heartbeat.
4. **Package pull**: Agent polls `/api/admin/agent/packages-for-host?hostname=…` → returns `ad-os-baseline` once enabled in admin → agent runs `collect.ps1` → metrics appear in `pkg_ad_os_baseline.metrics`.
5. **Disable built-in**: Try `POST /api/admin/packages/install` with `ad-os-baseline` for global install (works), then `installer.uninstallPackage({name:'ad-os-baseline'})` → returns `PKG_BUILTIN`. Per-server `DELETE /api/admin/member-servers/.../packages/ad-os-baseline` → returns 200 + audit `disable_builtin_ad_os_baseline`.
6. **Alert rule create + fire**: Create a rule on a test member server with `cpu_pct > 50 for 1 minute` (override for_minutes for the test) → after 2 minutes, `alert_rule_state.state='firing'`, `alert_events.firing` row, `alert_email_outbox` row.
7. **Email send**: Configure SMTP (real test mailbox or local mailhog) → `EmailDeliveryLoop` drains the outbox → `sent_at` set → email received with condition snapshot in body.
8. **Recovery**: Wait for rule not to match for `for_minutes` → `last_recovered_at` set → recovery email sent.
9. **Frontend**: Login admin → `/admin/member-servers` shows row → `/admin/member-servers/SRV-A` shows packages + alerts tabs → rule editor save → reload → rule persists.
10. **Cooldown**: Force a second firing while `cooldown_minutes` active → no second outbox row.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-mirror.ps1 docs/smoke-2026-08-09-non-ad.md
git commit -m "chore(non-ad): verify-mirror.ps1 + smoke test report"
```

- [ ] **Step 5: Final test gate**

Run: `npm test --workspace=center && cd frontend && npx vitest run && cd ../agent && npx jest`
Expected:
- `center`: ≥ 555 tests pass (existing 528 + ~27 new across tasks 1, 2, 4-12).
- `frontend`: ≥ 226 tests pass (existing 219 + ~7 new).
- `agent`: ≥ 55 tests pass (existing 52 + ~3 new).

- [ ] **Step 6: Plan-closing tag**

```bash
git log --oneline -30
git tag non-ad-plan-v1
```

The whole-branch review subagent (opus) runs after this task, dispatched by the SDD controller.