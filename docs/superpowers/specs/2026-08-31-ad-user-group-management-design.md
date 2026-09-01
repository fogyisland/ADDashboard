# AD 用户与组管理 — Design Spec

**Date:** 2026-08-31
**Status:** Draft (ruling-baked, implementation-ready)
**Scope:** Add AD user-management + group-management surfaces under the 运维 (operations) sidebar, driven by the center-staged + agent-pull architecture with full mock-first coverage.

---

## 1. Feature scope

### 1.1 User management (用户管理)

| Capability | Operator workflow | Backing AD cmdlet(s) | Edge cases |
|---|---|---|---|
| **Search users** | Pick a DC → enter sAMAccountName filter (wildcards) → click 查询 → paginated table | `Search-ADAccount -AccountDisabled <bool?> -UsersOnly` filtered by `-Filter {sAMAccountName -like '<filter>*'}` OR `Get-ADUser -Filter {sAMAccountName -like '<filter>*'} -Properties DisplayName,Enabled,LastLogonDate,Description` | (a) empty filter → still return top-N; (b) more than 200 hits → cap with `truncated: true` hint; (c) special chars in filter (e.g. `*`, `)`, `(`, `&`) → escape per AD filter DSL; (d) DC offline → 502 with `agent offline` |
| **Create user** | Click 新建 → modal: sAMAccountName (required), GivenName, Surname, DisplayName (auto-derived if blank), UPN, OU DN (optional, default `Users`), Password + Confirm + "User must change password at next logon" checkbox, Description | `New-ADUser -SamAccountName ... -Name ... -GivenName ... -Surname ... -UserPrincipalName ... -Path ... -AccountPassword (ConvertTo-SecureString ... -AsPlainText -Force) -ChangePasswordAtLogon:$true -Enabled:$true -Description ... -PassThru` | (a) duplicate sAMAccountName → 409 with clear error; (b) weak password → 400 with AD reason; (c) OU path invalid → 400; (d) result returns created object via `-PassThru \| Get-ADUser` for confirmation row |
| **Reset password** | Select user → 重置密码 → modal: new password + confirm + "must change at next logon" + "unlock account" checkbox | `Set-ADAccountPassword -Identity <sam> -Reset -NewPassword (ConvertTo-SecureString ... -AsPlainText -Force)` then `Set-ADUser -ChangePasswordAtLogon $bool` and optional `Unlock-ADAccount -Identity <sam>` | (a) user disabled → still allowed (operator may want to reset before enabling); (b) policy violation → 400 with reason; (c) bundled unlock is one transaction — partial failures roll back via the result.error code |
| **Enable account** | Select user → 启用 | `Enable-ADAccount -Identity <sam>` then `Set-ADUser -Enabled $true` | If already enabled → no-op success |
| **Disable account** | Select user → 禁用 → confirm modal (warning: may affect logon) | `Disable-ADAccount -Identity <sam>` then `Set-ADUser -Enabled $false` | Cannot disable built-in accounts; AD throws — surface reason in 400 |
| **Unlock account** | Select user → 解锁 | `Unlock-ADAccount -Identity <sam>` | No-op if already unlocked |
| **Edit attributes** | Select user → 编辑属性 → modal with: DisplayName, GivenName, Surname, UPN, Email, TelephoneNumber, Title, Department, Manager (DN or picker), Description | `Set-ADUser -Identity <sam> -Replace @{DisplayName=...; mail=...; telephoneNumber=...; title=...; department=...; manager=...}` and `-Description ...` | Manager is a DN reference; picker modal reuses user-search |
| **View group memberships** | Select user → 组成员 → modal: paginated list of groups + close | `Get-ADPrincipalGroupMembership -Identity <sam> \| Get-ADGroup -Property Description,GroupCategory,GroupScope` | None — read-only path |
| **Delete user** | Select user → 删除 → confirm modal (typed confirmation of sAMAccountName) | `Remove-ADUser -Identity <sam> -Confirm:$false` | Cannot delete protected accounts; AD throws → surface in 400. Built-in admins like Administrator are blocked at the UI layer too. |

### 1.2 Group management (组管理)

| Capability | Operator workflow | Backing AD cmdlet(s) | Edge cases |
|---|---|---|---|
| **Search groups** | Pick DC → Name filter → 查询 → paginated table | `Get-ADGroup -Filter {Name -like '<filter>*'} -Property Description,GroupCategory,GroupScope,Members` | Same truncation rule as users (cap 200); empty filter shows top-N |
| **Create group** | Click 新建 → modal: Name (required), SamAccountName (auto-derived if blank), DisplayName, GroupCategory (Security / Distribution), GroupScope (DomainLocal / Global / Universal), Description, OU DN (optional, default `Users`) | `New-ADGroup -Name ... -SamAccountName ... -GroupCategory ... -GroupScope ... -Path ... -Description ...` | (a) duplicate name → 409; (b) GroupScope+GroupCategory combo invalid for AD (e.g. Distribution+DomainLocal is allowed but Distribution+GlobalLocal not) → 400; (c) OU path invalid → 400 |
| **Set group properties** | Select group → 设置属性 → modal: DisplayName, Description, ManagedBy (DN/picker), Mail, Notes, GroupCategory, GroupScope, GroupType | `Set-ADGroup -Identity <gid> -Replace @{DisplayName=...; Description=...; managedBy=...; mail=...; info=...}` + `Set-ADGroup -Identity <gid> -GroupCategory ... -GroupScope ...` | Changing scope/category can have cascading effects (membership re-evaluation) — UI warning shown |
| **Add members** | Select group → 成员管理 → add modal: search-and-pick users (or paste DN list) | `Add-ADGroupMember -Identity <gid> -Members <sam1,sam2,...> -Confirm:$false` | Already a member → no-op success; cannot add built-in accounts in protected groups |
| **Remove members** | In 成员管理 modal: multi-select rows → click 移除 | `Remove-ADGroupMember -Identity <gid> -Members <sam1,...> -Confirm:$false` | No-op if not member |
| **Replace members** (advanced) | Same modal → "Replace all" button → after picking, current set is wiped then new set added in one PS1 invocation | `Set-ADGroup -Identity <gid> -Clear Members` then `Add-ADGroupMember ... -Members <new>` (or `Get-ADGroup \| Set-ADGroup -Add @{member=...}`) | This is destructive — UI requires explicit confirmation; emits a single audit row with the diff (added[], removed[]) |
| **Delete group** | Select group → 删除 → confirm modal (typed confirmation of Name) | `Remove-ADGroup -Identity <gid> -Confirm:$false` | If group is currently a member of another group (group-nesting) or has members → AD still allows delete but operator gets warning before submit |

### 1.3 Common UX

- **DC picker** at the top of each view, populated from `/api/dashboard/topology` (existing endpoint).
- **Sticky DC selection** — once chosen, persists across modals on the same view (via Pinia store or component-local ref).
- **Command history drawer** on the right side, shows last 50 commands for the operator with status badges (queued / running / success / failed) and a "查看结果" expand that shows the JSON payload.
- **Toast on submit** — "命令已发送到 DC-X，命令 ID: #1234"
- **Loading state** — every modal submit triggers a 30-second timer; on timeout the UI shows "命令执行超时，正在查询状态..." and re-polls.

---

## 2. Architecture — center-staged + agent-pull

The existing pattern (R65 file-push) is reused: center queues a row, agent polls, agent executes PowerShell, agent POSTs the result back. This is the **exact same shape** as `push_file_uploaded` / `push_file_claimed` / `push_file_delivered` / `push_file_failed` — just with new command types and result shapes.

### 2.1 DB table

```sql
-- 024_create_ad_admin_commands.sql
-- R75 (today): AD user/group management command queue.

CREATE TABLE ad_admin_commands (
  id              BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,  -- MSSQL: INT IDENTITY
  command_type    VARCHAR(64)  NOT NULL,                            -- see §2.2
  target_dc       VARCHAR(128) NOT NULL,                            -- agent_id / DC hostname
  params_json     JSON         NOT NULL,                            -- MSSQL: NVARCHAR(MAX)
  status          VARCHAR(16)  NOT NULL DEFAULT 'queued',           -- queued|running|success|failed|timeout
  operator_id     BIGINT       NULL,                                -- sys_users.id (NULL allowed for system-queued)
  result_json     JSON         NULL,                                -- populated on terminal state
  error_message   NVARCHAR(2000) NULL,                              -- PowerShell stderr/exec error
  duration_ms     INT          NULL,                                -- set on terminal state
  created_at      DATETIME     NOT NULL,
  claimed_at      DATETIME     NULL,
  completed_at    DATETIME     NULL
);

CREATE INDEX ix_ad_admin_commands_target_status ON ad_admin_commands(target_dc, status);
CREATE INDEX ix_ad_admin_commands_status_created ON ad_admin_commands(status, created_at);
CREATE INDEX ix_ad_admin_commands_operator ON ad_admin_commands(operator_id, created_at);
```

**Ruling — table name:** new table `ad_admin_commands` rather than extending any existing one. Existing tables don't carry a generic command-queue shape; force-fitting breaks R66/R67 audit conventions.

**Ruling — command persistence:** rows persist after completion (status terminal) for audit history. A separate `WHERE status IN ('success','failed','timeout') AND completed_at < ?` retention policy is left for v2 (out of scope today).

### 2.2 Command types (string enum)

| command_type | params_json shape | result_json shape |
|---|---|---|
| `user_search` | `{ filter: string, limit?: number=200 }` | `{ users: [{sam, displayName, enabled, lastLogon, description}], truncated: bool, count: number }` |
| `user_create` | `{ sam, givenName?, surname?, displayName?, upn?, ouPath?, password, mustChangePassword: bool, description? }` | `{ sam, dn, created: true }` |
| `user_password_reset` | `{ sam, newPassword, mustChangePassword: bool, unlockAccount: bool }` | `{ sam, passwordReset: true, unlocked: bool }` |
| `user_enable` | `{ sam }` | `{ sam, enabled: true }` |
| `user_disable` | `{ sam }` | `{ sam, enabled: false }` |
| `user_unlock` | `{ sam }` | `{ sam, unlocked: true }` |
| `user_set_attributes` | `{ sam, attributes: {displayName?, mail?, telephoneNumber?, title?, department?, manager?, description?} }` | `{ sam, updatedFields: string[] }` |
| `user_delete` | `{ sam }` | `{ sam, deleted: true }` |
| `user_list_groups` | `{ sam }` | `{ sam, groups: [{name, dn, category, scope}] }` |
| `group_search` | `{ filter: string, limit?: number=200 }` | `{ groups: [{name, sam, category, scope, description, memberCount}], truncated: bool, count: number }` |
| `group_create` | `{ name, sam?, displayName?, category, scope, ouPath?, description?, mail? }` | `{ name, dn, created: true }` |
| `group_set_attributes` | `{ name, attributes: {displayName?, description?, managedBy?, mail?, info?, category?, scope?} }` | `{ name, updatedFields: string[] }` |
| `group_add_member` | `{ name, members: string[] }` | `{ name, added: string[], alreadyMembers: string[] }` |
| `group_remove_member` | `{ name, members: string[] }` | `{ name, removed: string[], notMembers: string[] }` |
| `group_set_members` | `{ name, members: string[] }` | `{ name, added: string[], removed: string[] }` |
| `group_delete` | `{ name }` | `{ name, deleted: true }` |
| `group_list_members` | `{ name, page?: number=1, size?: number=100 }` | `{ name, members: [{sam, dn}], total: number, page: number, size: number }` |

### 2.3 Agent poll endpoint

```
GET /api/agent/ad-commands?hostname=<dc>
  Headers: X-Agent-Token: <token>
  Response 200:
    {
      commands: [
        {
          id: 1234,
          commandType: 'user_create',
          params: { ... },
          createdAt: '2026-08-31T10:00:00Z'
        },
        ...
      ]
    }
```

Behavior: returns up to 5 queued commands for the given DC, flips each to `running` + sets `claimed_at`, returns the rows. (5-cap prevents one slow agent from monopolizing the queue; agent will poll again on next cycle for the rest.)

### 2.4 Agent ack endpoint

```
POST /api/agent/ad-commands/:id/result
  Headers: X-Agent-Token: <token>
  Body: {
    success: bool,
    data: object | null,        // result_json content
    error: string | null,       // human-readable error (PowerShell stderr)
    exitCode: number,
    durationMs: number
  }
  Response 200: { ok: true, commandId: 1234, status: 'success' | 'failed' }
  Response 404: { error: 'command not found or already completed' }
  Response 409: { error: 'command not claimed by this agent' } (defense-in-depth)
```

### 2.5 Center admin endpoints

```
POST /api/admin/ad-commands
  Body: {
    targetDc: string,
    commandType: string,
    params: object
  }
  Auth: userAuth + requirePerm('admin:users')
  Response 201: {
    id: 1234,
    commandType: 'user_create',
    targetDc: 'HUBADSRV1',
    status: 'queued',
    createdAt: '2026-08-31T10:00:00Z'
  }
  Errors: 400 (validation), 404 (DC not in topology), 503 (no agent online for that DC)

GET /api/admin/ad-commands?operatorId=<n>&status=<s>&page=<p>&size=<n>
  Auth: same
  Response 200: {
    total: number,
    rows: [{
      id, commandType, targetDc, status, operatorId,
      operatorUsername, createdAt, claimedAt, completedAt,
      durationMs, errorMessage
    }],
    page, size
  }

GET /api/admin/ad-commands/:id
  Auth: same
  Response 200: full row including params_json + result_json
  Response 404: not found
```

**Ruling — DC availability check at queue time:** route queries `ad_agent_heartbeat WHERE agent_id = ? AND last_heartbeat_at >= UTC_TIMESTAMP() - INTERVAL 5 MINUTE`. If no row → 503 `{ error: 'no agent currently online for DC-X; last heartbeat YYYY-MM-DDTHH:MM:SSZ' }`. This prevents commands piling up for dead agents.

---

## 3. Backend

### 3.1 Service module

`center/src/services/ad-admin-commands.js` — new file. Public surface:

```js
// Queue a new command. Returns the inserted row.
async function queueCommand({ targetDc, commandType, params, operatorId }) -> Promise<CommandRow>

// Pull pending commands for an agent. Atomic UPDATE…SET status='running', claimed_at=NOW()
// so two agents polling simultaneously cannot claim the same row.
async function claimForAgent(targetDc, limit = 5) -> Promise<CommandRow[]>

// Terminal-state ack. Caller passes the agent's reported (success, data, error, exitCode, durationMs).
// Idempotent on already-completed commands (returns the existing row).
async function completeCommand(id, { success, data, error, exitCode, durationMs }) -> Promise<CommandRow>

// Center-internal helper: timeout sweeper. Marks 'running' commands older than the timeout
// threshold as 'timeout' with error_message = 'command exceeded timeout threshold of Ns'.
// Called by a setInterval in server.js (every 10s). Mock and prod share this path.
async function sweepTimeouts({ timeoutMs = 30000, now = new Date() }) -> Promise<number>

// Read APIs for the admin UI.
async function getCommand(id) -> Promise<CommandRow | null>
async function listCommands({ operatorId, status, page = 1, size = 50 }) -> Promise<{ total, rows }>
```

**Validation rules:**
- `targetDc` required, must match an entry in `ad_dcs.dc_name`.
- `commandType` must be one of the 17 enum values from §2.2; unknown → throw `httpErr(400, 'unknown command_type')`.
- `params` schema is validated per command type (the service holds a small per-type validator map). On validation failure → `httpErr(400, 'invalid params: <field>')`.
- The MySQL JSON column is bound via `JSON.stringify(params)`; the service reads it back via `JSON.parse` on read.

**`sweepTimeouts` lifecycle integration:**
- `server.js` schedules `setInterval(() => sweepTimeouts({ timeoutMs: 30000 }).catch(logErr), 10_000)` once on boot.
- Threshold: 30 s (matches default timeout the agent uses internally to bound PS1 exec).

**Ruling — timeout:** 30 seconds default, hard-coded in this spec, exposed as `AD_ADMIN_COMMAND_TIMEOUT_MS` env var for tests.

### 3.2 Audit classifier entries

`center/src/services/audit-classifier.js` — add the following to all three Maps:

| action | category | severity | label (zh-CN) | target string |
|---|---|---|---|---|
| `ad_user_search` | ops | low | AD 用户搜索 | `dc:<targetDc>` |
| `ad_user_create` | changes | medium | AD 创建用户 | `<sam>` |
| `ad_user_password_reset` | security | high | AD 重置用户密码 | `<sam>` |
| `ad_user_enable` | changes | medium | AD 启用用户 | `<sam>` |
| `ad_user_disable` | security | high | AD 禁用用户 | `<sam>` |
| `ad_user_unlock` | changes | medium | AD 解锁用户 | `<sam>` |
| `ad_user_set_attributes` | changes | medium | AD 修改用户属性 | `<sam>` |
| `ad_user_delete` | security | high | AD 删除用户 | `<sam>` |
| `ad_user_list_groups` | ops | low | AD 查看用户组成员 | `<sam>` |
| `ad_group_search` | ops | low | AD 组搜索 | `dc:<targetDc>` |
| `ad_group_create` | changes | medium | AD 创建组 | `<name>` |
| `ad_group_set_attributes` | changes | medium | AD 修改组属性 | `<name>` |
| `ad_group_add_member` | changes | medium | AD 向组添加成员 | `<name>` |
| `ad_group_remove_member` | changes | medium | AD 从组移除成员 | `<name>` |
| `ad_group_set_members` | security | high | AD 替换组成员 | `<name>` |
| `ad_group_delete` | security | high | AD 删除组 | `<name>` |
| `ad_group_list_members` | ops | low | AD 查看组成员 | `<name>` |

`password_reset`, `disable`, `delete`, `set_members`, `group_delete` are `security`/`high` because they are the operator's "destructive" surface (R66 pattern: `delete_script` is `changes/medium`, but user-impact operations on real AD accounts warrant one step higher).

### 3.3 Routes

`center/src/routes/admin.js` — append (do NOT break existing handlers):

```js
import {
  queueCommand, listCommands, getCommand
} from '../services/ad-admin-commands.js';

// POST queue — operator-facing
r.post('/api/admin/ad-commands', auth, async (req, res) => {
  const { targetDc, commandType, params } = req.body || {};
  // validation + DC-online check via service; on success, writeAudit('ad_<x>')
  // for the user-facing action name (e.g. ad_user_create), with payload
  // { commandId, targetDc, commandType, paramsSummary } — never the
  // plaintext password. password params are REDACTED in the audit payload:
  // { hasPassword: true, passwordLength: params.password?.length ?? 0 }.
});

// GET list — for history drawer
r.get('/api/admin/ad-commands', auth, async (req, res) => {
  // filters + paging
});

// GET single
r.get('/api/admin/ad-commands/:id', auth, async (req, res) => {
  // returns full row incl params_json + result_json
});
```

`center/src/routes/agent.js` — extend the existing `agentRouter({ mount })` factory. The two new endpoints (`GET /api/agent/ad-commands`, `POST /api/agent/ad-commands/:id/result`) follow the exact pattern of the existing `r.get('/api/agent/file-push', ...)` and `r.post('/api/admin/file-push/:id/ack', ...)`. Both live under `if (mount === 'web' || mount === 'report' || mount === 'full')` — never on `heartbeat` port (the heartbeat port is the cheap small-payload path; admin commands can be heavy).

```js
// Inside agentRouter(...)
if (mount === 'web' || mount === 'report' || mount === 'full') {
  r.get('/api/agent/ad-commands', agentMw, async (req, res) => {
    const hostname = String(req.query.hostname || '').trim();
    if (!hostname) return res.status(400).json({ error: 'hostname required' });
    const { claimForAgent } = await import('../services/ad-admin-commands.js');
    const commands = await claimForAgent(hostname, 5);
    // Mirror file-push: emit 'ad_command_claimed' audit row per FIRST claim
    // for each command (audit-classifier entry below).
    for (const c of commands) {
      await writeAudit({
        action: 'ad_command_claimed',
        target: `dc:${hostname}`,
        payload: { commandId: c.id, commandType: c.command_type, hostname },
        logger
      });
    }
    res.json({ commands: commands.map(agentView) });
  });

  r.post('/api/agent/ad-commands/:id/result', agentMw, async (req, res) => {
    const id = Number(req.params.id);
    const { success, data, error, exitCode, durationMs } = req.body || {};
    try {
      const { completeCommand } = await import('../services/ad-admin-commands.js');
      const row = await completeCommand(id, { success, data, error, exitCode, durationMs });
      await writeAudit({
        action: success ? 'ad_command_succeeded' : 'ad_command_failed',
        target: `cmd:${id}`,
        payload: { commandId: id, commandType: row.command_type, targetDc: row.target_dc, exitCode, durationMs, errorMessage: error ?? null },
        logger
      });
      res.json({ ok: true, commandId: id, status: row.status });
    } catch (e) {
      if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.message });
      logger.error({ err: e }, 'ad-commands ack failed');
      res.status(500).json({ error: 'internal' });
    }
  });
}
```

**Additional audit-classifier entries** (the agent-side events):

| action | category | severity | label | target |
|---|---|---|---|---|
| `ad_command_claimed` | changes | low | AD 命令认领 | `cmd:<id>` |
| `ad_command_succeeded` | changes | low | AD 命令成功 | `cmd:<id>` |
| `ad_command_failed` | changes | medium | AD 命令失败 | `cmd:<id>` |
| `ad_command_timeout` | changes | medium | AD 命令超时 | `cmd:<id>` |

### 3.4 SQL helpers

`center/src/db/sql.js` — add a new top-level key in both `mysql` and `mssql` branches:

```js
// In VARIANTS.mysql.adAdminCommands:
{
  insert: `INSERT INTO ad_admin_commands (command_type, target_dc, params_json, status, operator_id, created_at)
           VALUES (?, ?, ?, 'queued', ?, UTC_TIMESTAMP())`,
  claim: `UPDATE ad_admin_commands
              SET status = 'running', claimed_at = UTC_TIMESTAMP()
            WHERE id IN (?)
              AND status = 'queued'
              AND target_dc = ?`,
  claimPick: `SELECT id FROM ad_admin_commands
                WHERE status = 'queued' AND target_dc = ?
                ORDER BY created_at ASC, id ASC
                LIMIT ?`,
  loadByIds: `SELECT id, command_type, target_dc, params_json, status, created_at, claimed_at
                FROM ad_admin_commands
               WHERE id IN (?)`,
  complete: `UPDATE ad_admin_commands
                SET status = ?, result_json = ?, error_message = ?, duration_ms = ?, completed_at = UTC_TIMESTAMP()
              WHERE id = ?`,
  listByOperator: `SELECT c.id, c.command_type, c.target_dc, c.status, c.operator_id,
                          u.username AS operator_username, c.created_at, c.claimed_at, c.completed_at,
                          c.duration_ms, c.error_message
                     FROM ad_admin_commands c
                     LEFT JOIN sys_users u ON u.id = c.operator_id
                    WHERE c.operator_id = ?
                    ORDER BY c.created_at DESC, c.id DESC
                    LIMIT ? OFFSET ?`,
  listAll: `... ORDER BY c.created_at DESC LIMIT ? OFFSET ?`, // same shape, no operator_id WHERE
  listByStatus: `... WHERE c.status = ? ORDER BY c.created_at DESC LIMIT ? OFFSET ?`,
  getById: `SELECT c.id, c.command_type, c.target_dc, c.params_json, c.result_json,
                    c.status, c.operator_id, u.username AS operator_username,
                    c.created_at, c.claimed_at, c.completed_at, c.duration_ms, c.error_message
               FROM ad_admin_commands c
               LEFT JOIN sys_users u ON u.id = c.operator_id
              WHERE c.id = ?`,
  sweepTimeouts: `UPDATE ad_admin_commands
                     SET status = 'timeout', error_message = 'command exceeded timeout threshold',
                         completed_at = UTC_TIMESTAMP()
                   WHERE status = 'running'
                     AND claimed_at < UTC_TIMESTAMP() - INTERVAL ? SECOND`,
  countAll: `SELECT COUNT(*) AS total FROM ad_admin_commands`,
  countByOperator: `SELECT COUNT(*) AS total FROM ad_admin_commands WHERE operator_id = ?`,
  countByStatus: `SELECT COUNT(*) AS total FROM ad_admin_commands WHERE status = ?`
}
```

The MSSQL branch uses the same SQL with two adjustments: (a) `JSON` type replaced by `NVARCHAR(MAX)` plus the `JSON.stringify`/`JSON.parse` wrap at the service layer (already done by the file-push service — copy that pattern), and (b) the multi-row `IN (?)` claim path uses a temp-table approach matching the existing `serverGroups.listMembers` pattern.

### 3.5 Server wiring

`center/src/server.js` — at the bottom of the existing factory, add:

```js
// R75: sweep AD admin command timeouts every 10 seconds. 30s default matches
// the agent's internal exec timeout (see services/ad-admin-commands.js).
const _adAdminSweepMs = Number(process.env.AD_ADMIN_COMMAND_TIMEOUT_MS) || 30000;
const _adAdminSweepIntervalMs = 10_000;
setInterval(async () => {
  try {
    const { sweepTimeouts } = await import('./services/ad-admin-commands.js');
    const n = await sweepTimeouts({ timeoutMs: _adAdminSweepMs });
    if (n > 0) logger.info({ event: 'ad_admin_commands.sweep', swept: n }, 'ad admin commands swept to timeout');
  } catch (e) {
    logger.warn({ err: e.message }, 'ad admin commands sweep failed (best-effort)');
  }
}, _adAdminSweepIntervalMs).unref();
```

---

## 4. Frontend

### 4.1 Router + sidebar

`center/web/src/router.js` — append two routes:

```js
{ path: '/admin/ad-users',    name: 'admin-ad-users',    component: () => import('./views/admin/UserManagementView.vue'),    meta: { title: 'AD 用户管理', requiresAuth: true, permission: 'admin:users' } },
{ path: '/admin/ad-groups',   name: 'admin-ad-groups',   component: () => import('./views/admin/GroupManagementView.vue'),   meta: { title: 'AD 组管理',   requiresAuth: true, permission: 'admin:users' } }
```

`center/web/src/components/AdminLayout.vue` — add a new group titled `运维` with the two nav-links. The 运维 group sits between 权限和账户 and 运维日志 (logical reading order: account → AD operations → log review).

```js
// Append to the `groups` array in AdminLayout.vue:
{ icon: '🔧', title: '运维', items: [
  { label: 'AD 用户管理', path: '/admin/ad-users' },
  { label: 'AD 组管理',   path: '/admin/ad-groups' }
]}
```

This brings the sidebar count to 6+1 = 7 groups, 21 nav-links (matching R53 visual hierarchy).

### 4.2 API client

`center/web/src/api/ad-admin.js` — new file:

```js
import { api } from './client.js';

export const adAdminApi = {
  // DC picker (reuse /api/dashboard/topology)
  listDcs: () => api.get('/api/dashboard/topology'),

  // Queue a command
  queueCommand: ({ targetDc, commandType, params }) =>
    api.post('/api/admin/ad-commands', { targetDc, commandType, params }),

  // History
  listCommands: (params = {}) =>
    api.get('/api/admin/ad-commands', { params }),
  getCommand: (id) => api.get(`/api/admin/ad-commands/${id}`),

  // Polling for command status (used by modals + history drawer)
  // pollingIntervalMs: 2000 default; stops when status is terminal
};
```

### 4.3 UserManagementView.vue

Layout (top to bottom):
1. **Toolbar row** — DC picker (Select element), search box (sAMAccountName filter), 查询 button, 新建 button.
2. **Results table** with columns:
   - 用户名 (sAMAccountName)
   - 显示名称 (DisplayName)
   - 启用状态 (Enabled — green check / red x badge)
   - 上次登录 (LastLogonDate — locale string, "—" if never)
   - 描述 (Description — truncated with ellipsis)
   - 操作 (重置密码 / 启用 / 禁用 / 编辑属性 / 组成员 / 解锁 / 删除 — context-aware: enable shown if disabled, disable shown if enabled, unlock shown only if locked)
3. **Pagination** — simple page + size controls (size fixed at 50 from server; UI sends page=1..N).
4. **AdCommandHistoryDrawer** — fixed right sidebar, toggleable, shows last 50 commands with status pills and expand-to-see-result.

Modals (separate components, lazy-imported):
- `UserCreateModal.vue` — fields: sam (required), givenName, surname, displayName (auto-derived: `${givenName} ${surname}` if blank), upn (default `<sam>@<domain>`, where `<domain>` comes from topology), ouPath (text), password + confirm (with show/hide toggle), mustChangePasswordAtLogon (checkbox, default true), description. Submit calls `adAdminApi.queueCommand({ targetDc, commandType: 'user_create', params })`.
- `UserPasswordResetModal.vue` — fields: new password + confirm + mustChangePasswordAtLogon + unlockAccount (default true). Submit → `user_password_reset`.
- `UserAttributesModal.vue` — fields: DisplayName, GivenName, Surname, UPN, Email, TelephoneNumber, Title, Department, Manager (text input + "选择..." button that opens a nested user-search modal), Description. Submit → `user_set_attributes`.
- `GroupMembershipsModal.vue` — read-only list (uses `user_list_groups` command).
- `UserDeleteConfirmModal.vue` — confirmation requiring typed sAMAccountName match.

### 4.4 GroupManagementView.vue

Layout (mirror of UserManagementView):
1. **Toolbar** — DC picker, search box (Name filter), 查询, 新建.
2. **Results table**:
   - 组名 (Name)
   - 类别 (GroupCategory badge — Security / Distribution)
   - 范围 (GroupScope badge — DomainLocal / Global / Universal)
   - 描述 (Description — truncated)
   - 成员数 (memberCount)
   - 操作 (设置属性 / 管理成员 / 删除)
3. **Pagination**
4. **History drawer** (shared component)

Modals:
- `GroupCreateModal.vue` — name, sam (auto), displayName, groupCategory (radio), groupScope (radio), description, ouPath, mail.
- `GroupPropertiesModal.vue` — DisplayName, Description, ManagedBy (picker), Mail, Notes (info field), GroupCategory, GroupScope. Submit → `group_set_attributes`.
- `GroupMembersModal.vue` — split-pane UI: left side shows current members (paginated, 100/page) with multi-select; right side shows "add" pane with a search box calling `user_search` (paginated, 50/page). Buttons: 添加选中, 移除选中, 全部替换 (with extra confirm). Final action: `group_add_member` / `group_remove_member` / `group_set_members`.

### 4.5 AdCommandHistoryDrawer.vue

- Fixed right sidebar (380px wide), toggle button in toolbar.
- Auto-refreshes every 5 seconds when at least one command has status `queued` or `running`.
- Each row: 目标 DC / 命令类型 / 状态 pill / 时间 / expand caret.
- Expanded: full result_json (syntax-highlighted JSON), params_json (with `***REDACTED***` for password fields), duration, error.

### 4.6 Polling pattern (shared composable)

`center/web/src/composables/useCommandPolling.js` — new:

```js
// Polls /api/admin/ad-commands/:id every 2s until status is terminal,
// then resolves. Used by every modal submit handler.
export function useCommandPolling() {
  const status = ref('queued');
  const result = ref(null);
  const error = ref(null);
  const poll = async (id) => { /* ... */ };
  return { status, result, error, poll };
}
```

**Ruling — frontend polling:** 5 seconds while at least one command is pending; otherwise idle. (Aligned with existing R12 heartbeat-report drawer polling.)

### 4.7 Modal UX rules

- Every modal that submits a command shows an "执行中" overlay with a spinner + the command ID + a "取消" button (which doesn't actually cancel the command server-side, just closes the modal — the command continues and the result will appear in the history drawer).
- Submitting with `targetDc` not chosen → disable the submit button (with tooltip "请先选择目标 DC").
- Form validation errors display inline; submit-block until resolved.

---

## 5. Mock-first

### 5.1 Mock AD data store

`center/mock-ad-admin.mjs` — new module. Exports:

```js
// Per-DC in-memory AD store. Same shape as a real DC's Active Directory
// module would return. Keyed by dcName → { users: Map<sam, UserObj>, groups: Map<name, GroupObj> }
// where UserObj and GroupObj have the schema fields needed by each command.
//
// The store is initialized from MOCK_AD_DATA env var (JSON), falling back to
// a built-in seed dataset (3 users + 2 groups per DC).
export const adStore = new Map(); // dcName → { users, groups }

// Public surface (each function simulates the corresponding AD cmdlet):
export function mockAdUserSearch(dcName, { filter, limit }) { ... }
export function mockAdUserCreate(dcName, params) { ... }
export function mockAdUserPasswordReset(dcName, params) { ... }
export function mockAdUserEnable(dcName, sam) { ... }
export function mockAdUserDisable(dcName, sam) { ... }
export function mockAdUserUnlock(dcName, sam) { ... }
export function mockAdUserSetAttributes(dcName, sam, attrs) { ... }
export function mockAdUserDelete(dcName, sam) { ... }
export function mockAdUserListGroups(dcName, sam) { ... }

export function mockAdGroupSearch(dcName, { filter, limit }) { ... }
export function mockAdGroupCreate(dcName, params) { ... }
export function mockAdGroupSetAttributes(dcName, name, attrs) { ... }
export function mockAdGroupAddMember(dcName, name, members) { ... }
export function mockAdGroupRemoveMember(dcName, name, members) { ... }
export function mockAdGroupSetMembers(dcName, name, members) { ... }
export function mockAdGroupDelete(dcName, name) { ... }
export function mockAdGroupListMembers(dcName, name, { page, size }) { ... }
```

**Built-in seed dataset** (deterministic, hashable from agentId like `mock-snapshot.mjs::buildDcCounters`):

```js
const SEED_USERS = [
  { sam: 'admin',      givenName: 'Alice', surname: 'Admin',     displayName: 'Alice Admin',     enabled: true,  description: 'Domain Administrator' },
  { sam: 'jdoe',       givenName: 'John',  surname: 'Doe',       displayName: 'John Doe',        enabled: true,  description: 'Sales Engineer' },
  { sam: 'asmith',     givenName: 'Alice', surname: 'Smith',     displayName: 'Alice Smith',     enabled: false, description: 'Disabled — on leave' },
  { sam: 'servicebot', givenName: 'Svc',  surname: 'Bot',       displayName: 'Service Account', enabled: true,  description: 'Scheduled tasks runner' }
];
const SEED_GROUPS = [
  { name: 'Domain Admins',     sam: 'Domain Admins',     category: 'Security',     scope: 'Global',      description: 'Tier-0 administrators', members: ['admin'] },
  { name: 'Sales Team',        sam: 'Sales Team',        category: 'Security',     scope: 'Universal',   description: 'Sales department users', members: ['jdoe'] },
  { name: 'All Staff DL',      sam: 'All Staff DL',      category: 'Distribution', scope: 'Universal',   description: 'Company-wide distro',   members: [] }
];
```

### 5.2 Mock agent integration

`center/mock-multi-agent.mjs` — extend to call `mockAdStore` on each command poll cycle. After the existing heartbeat + discovery + replication calls, add:

```js
// NEW (R75): poll /api/agent/ad-commands and dispatch each command through
// the mock AD store. The agent's natural cadence is heartbeat-driven, but
// for responsive UX, this runs every iteration of the scenario loop.
async function processAdCommands(agentId) {
  const res = await fetch(`${REPORT_URL}/api/agent/ad-commands?hostname=${agentId}`, {
    headers: { 'X-Agent-Token': AGENT_TOKEN }
  });
  if (!res.ok) return 0;
  const { commands } = await res.json();
  for (const cmd of commands) {
    const result = await dispatchMockAdCommand(agentId, cmd);
    await fetch(`${REPORT_URL}/api/agent/ad-commands/${cmd.id}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Token': AGENT_TOKEN },
      body: JSON.stringify(result)
    });
  }
  return commands.length;
}
```

`center/mock-heartbeat-daemon.mjs` — same extension at the daemon-tick level: each daemon cycle (default every 30s) drains the queue for each registered mock agent.

### 5.3 Mock unit tests

`center/tests/mock-ad-admin.test.js` — new. Tests every `mockAd*` function for:
- happy path (user_search returns the right users, user_create inserts into the map, etc.)
- error cases (duplicate sam → throws "already exists", unknown user on delete → throws, etc.)
- isolation between DCs (mutating DC-A's user list does not affect DC-B's)

### 5.4 Mock e2e

`center/mock-ad-admin-e2e.mjs` — new. Boots the mock daemon + mock-multi-agent. For each of the 17 command types:
1. POSTs the admin queue endpoint with a synthetic command.
2. Polls the admin GET endpoint until status is terminal.
3. Asserts the mock store mutated as expected.
4. Asserts the audit row was written.

This exercises the full path (admin route → DB queue → agent poll → mock dispatch → agent ack → DB update → admin read) and proves every command type works end-to-end before any real-agent work starts.

---

## 6. Real agent (deferred — stubs)

Per standing operator directive "代码一定要紧贴实际的agent 发现问题立即修改agent 代码" — the real agent's PowerShell scripts get filled in once the mock exercises the full path. For the spec, the cmdlet mapping table is:

| command_type | PS1 cmdlet(s) (real-agent surface) | Stub file |
|---|---|---|
| `user_search` | `Get-ADUser -Filter {sAMAccountName -like '<filter>*'} -Properties DisplayName,Enabled,LastLogonDate,Description` | `agent/scripts/ad-admin-users.ps1` |
| `user_create` | `New-ADUser` + `Set-ADAccountPassword` | same |
| `user_password_reset` | `Set-ADAccountPassword -Reset` + `Set-ADUser -ChangePasswordAtLogon` + optional `Unlock-ADAccount` | same |
| `user_enable` | `Enable-ADAccount` | same |
| `user_disable` | `Disable-ADAccount` | same |
| `user_unlock` | `Unlock-ADAccount` | same |
| `user_set_attributes` | `Set-ADUser -Replace @{...}` | same |
| `user_delete` | `Remove-ADUser -Confirm:$false` | same |
| `user_list_groups` | `Get-ADPrincipalGroupMembership \| Get-ADGroup` | same |
| `group_search` | `Get-ADGroup -Filter {Name -like '<filter>*'} -Property Description,GroupCategory,GroupScope,Members` | `agent/scripts/ad-admin-groups.ps1` |
| `group_create` | `New-ADGroup` | same |
| `group_set_attributes` | `Set-ADGroup -Replace @{...}` + `Set-ADGroup -GroupCategory/-GroupScope` | same |
| `group_add_member` | `Add-ADGroupMember -Members` | same |
| `group_remove_member` | `Remove-ADGroupMember -Members` | same |
| `group_set_members` | `Set-ADGroup -Clear Members` then `Add-ADGroupMember -Members` | same |
| `group_delete` | `Remove-ADGroup -Confirm:$false` | same |
| `group_list_members` | `Get-ADGroupMember -Recursive` (paged) | same |

Stub files at `agent/scripts/ad-admin-users.ps1` and `agent/scripts/ad-admin-groups.ps1` contain the cmdlet invocations wrapped in a switch on `$commandType`, returning JSON via `ConvertTo-Json -Depth 5 -Compress` to stdout. Real-agent agent.js dispatcher routes commands to the correct script by command_type prefix (`user_*` → users.ps1, `group_*` → groups.ps1).

The JavaScript dispatcher (in `agent/src/`) picks the script based on command_type prefix, writes `params.json` to a temp file, invokes `powershell.exe -ExecutionPolicy Bypass -File <script>.ps1 -CommandType <type> -ParamsPath <path>`, captures stdout/stderr/exit code, and POSTs the result.

---

## 7. Tests + Verification

### 7.1 Backend unit tests

`center/tests/services/ad-admin-commands.test.js` — new. Uses the same in-memory mock-db pattern as `audit-classifier.test.js` (already in `tests/db/`). Covers:

- `queueCommand` — happy path; rejects unknown command_type; rejects invalid params per type; rejects unknown targetDc.
- `claimForAgent` — only returns commands for the matching dc; atomic claim semantics (two callers cannot claim the same row); respects limit; returns nothing when no queued commands.
- `completeCommand` — flips status to success/failed/timeout; idempotent on already-terminal commands; populates result_json + error_message + duration_ms; emits audit row.
- `sweepTimeouts` — marks `running` rows older than threshold as `timeout`; does NOT touch already-terminal rows; emits audit row.
- `listCommands` / `getCommand` — filter by operator/status/pagination.

`center/tests/routes/admin-ad-commands.test.js` — new. Uses supertest + in-memory db. Covers every endpoint's auth + happy + 4xx + 5xx paths.

`center/tests/routes/agent-ad-commands.test.js` — new. Same pattern. Tests both poll + ack endpoints.

### 7.2 Frontend tests

`center/web/tests/user-management-view.test.js` — new. Mount the view with a stubbed API; verify DC picker renders, search submits correctly, modal opens on row click, modal submit posts the right payload, history drawer polls correctly.

`center/web/tests/group-management-view.test.js` — new. Mirror of the above for groups.

### 7.3 Mock e2e

`center/mock-ad-admin-e2e.mjs` — see §5.4. Must exit 0 with all 17 command types green.

### 7.4 Acceptance

- All backend tests pass (`npm test` in `center/`).
- All frontend tests pass (`npm test` in `center/web/`).
- `node mock-ad-admin-e2e.mjs` exits 0.
- Live verify on 8080 (the operator's standing default port): POST a `user_search` command to `http://localhost:8080/api/admin/ad-commands`, GET its status via the list endpoint, see status flip from `queued` → `running` → `success` within ~3s of mock-daemon tick.

---

## 8. Risks / Decisions

| # | Risk / Decision | Ruling |
|---|---|---|
| 1 | DC picker UX — list all DCs or restrict to online agents? | List all DCs (operator may want to pre-stage a command for an offline DC and have it execute when the agent comes back). Display a "上次心跳 5 分钟前" hint per option; gray-out DCs offline >24h. |
| 2 | Command timeout default | **30 seconds** (matches agent's internal PS1 exec budget). Configurable via `AD_ADMIN_COMMAND_TIMEOUT_MS` env var for tests. |
| 3 | Result size cap | **200 users / 200 groups per search response**. Server caps and returns `truncated: true, count: 200` when the underlying AD result set would exceed the cap. UI shows "结果已截断，请缩小过滤范围". |
| 4 | Multi-DC consistency | v1 scope is single-DC only. Each command runs ONLY on the chosen DC. If user exists on DC-A but not DC-B, the search returns only DC-A's view. Documented in the UI: "命令将在 DC-X 上执行（仅此 DC）". |
| 5 | Group membership scale | For `group_list_members`: paginated, 100/page server-side cap, total count returned for UI pagination control. UI virtualizes the list (vue-virtual-scroller or manual scroll-window). v2 may move to "diff" instead of full list. |
| 6 | Audit log volume | No rate limit in v1. Each admin command emits 2 audit rows: one user-facing (e.g. `ad_user_create`) and one system-side (`ad_command_succeeded`/`_failed`). Operators can already filter audit-log by category; the new actions live under `changes` and `security` categories. |
| 7 | DC selection | Operator picks ONE DC from the dropdown. The command runs ONLY on that DC. UI banner reads "命令将在 DC-X 上执行". Cross-DC operations (e.g. "find user across all DCs") are out of scope for v1. |
| 8 | Password redaction | Passwords are NEVER returned by the server in any GET response (after queue+claim, the agent holds them in memory only for the duration of execution). Audit rows for password-reset / create log `{ hasPassword: true, passwordLength: N }` — never the cleartext. The `result_json` row is also stripped of any password field before storage. |
| 9 | Built-in protected accounts | The UI blocks operations on `Administrator`, `Guest`, `krbtgt`, `Domain Admins` group, `Enterprise Admins` group, `Schema Admins` group, `Administrators` group. The mock enforces the same; the real agent will get AD-side errors for these too. |
| 10 | DC offline at queue time | Route queries `ad_agent_heartbeat WHERE agent_id = ? AND last_heartbeat_at >= UTC_TIMESTAMP() - INTERVAL 5 MINUTE`. If no row → 503 with the last-seen timestamp. Operator can override with `?force=true` (audited separately with severity `high`) to queue anyway. |

---

## 9. File structure

```
center/
  src/
    db/sql.js                                    (MODIFY — add adAdminCommands.{mysql,mssql})
    services/
      ad-admin-commands.js                       (NEW)
    routes/
      admin.js                                   (MODIFY — add /api/admin/ad-commands routes)
      agent.js                                   (MODIFY — add /api/agent/ad-commands routes)
    audit-classifier.js                          (MODIFY — add ad_user_*, ad_group_*, ad_command_* entries)
    server.js                                    (MODIFY — add sweepTimeouts setInterval)
    app.js                                       (no change)
  db/
    migrations/
      024_create_ad_admin_commands.sql           (NEW — both MySQL + MSSQL branches)
  tests/
    services/ad-admin-commands.test.js           (NEW)
    routes/admin-ad-commands.test.js             (NEW)
    routes/agent-ad-commands.test.js             (NEW)
  mock-ad-admin.mjs                              (NEW — mock AD store + dispatchers)
  mock-snapshot.mjs                              (no change — AD store is independent of replication snapshot)
  mock-heartbeat-daemon.mjs                      (MODIFY — drain ad-commands each tick)
  mock-multi-agent.mjs                           (MODIFY — drain ad-commands each iteration)
  mock-ad-admin-e2e.mjs                          (NEW)

center/web/src/
  api/ad-admin.js                                (NEW — api client)
  views/admin/
    UserManagementView.vue                       (NEW)
    GroupManagementView.vue                      (NEW)
    AdCommandHistoryDrawer.vue                   (NEW)
  components/admin/
    UserCreateModal.vue                          (NEW)
    UserPasswordResetModal.vue                   (NEW)
    UserAttributesModal.vue                      (NEW)
    UserGroupMembershipsModal.vue                (NEW)
    UserDeleteConfirmModal.vue                   (NEW)
    GroupCreateModal.vue                         (NEW)
    GroupPropertiesModal.vue                     (NEW)
    GroupMembersModal.vue                        (NEW)
    GroupDeleteConfirmModal.vue                  (NEW)
    UserPickerMini.vue                           (NEW — used inside UserAttributesModal + GroupPropertiesModal for managedBy/manager)
  composables/
    useCommandPolling.js                         (NEW)
  router.js                                      (MODIFY — 2 routes)
  components/AdminLayout.vue                     (MODIFY — new 运维 group with 2 nav-links)
  tests/
    user-management-view.test.js                 (NEW)
    group-management-view.test.js                (NEW)

agent/scripts/
  ad-admin-users.ps1                             (NEW — stub; user_* cmdlets)
  ad-admin-groups.ps1                            (NEW — stub; group_* cmdlets)
  src/dispatchers/ad-admin.js                    (NEW — switch on command_type → call PS1 → return result)

publish/system/...                                (mirror all of the above per R66 publish pattern)
```

---

## 10. Open Questions (RULINGS — do not ask operator)

- **DB table name:** `ad_admin_commands` (new). Ruled.
- **User search cmdlet:** `Get-ADUser -Filter {sAMAccountName -like '<filter>*'} -Properties ...`. Ruled (uses Properties projection so we get Enabled/LastLogonDate/Description in one call).
- **Commands persist after completion?** YES — preserve for audit history. Ruled.
- **Command result format:** `{ success: bool, data: object | null, error: string | null, exitCode: number, durationMs: number }`. Ruled.
- **Frontend polling:** every 5s while any command is pending, idle otherwise. Ruled.
- **Default command timeout:** 30 seconds (env-overridable). Ruled.
- **Default search result limit:** 200 users / 200 groups. Ruled.
- **Sidebar group placement:** new 6th-style group titled `运维` with the 2 nav-links. Ruled.
- **Group create scope/category validation:** reject illegal combos (Distribution+UniversalLocal isn't a thing, etc.) with a 400. Ruled.
- **Mock-built-in user seed:** always 4 users + 3 groups per DC; deterministic across daemon restarts via SHA-256 of dcName. Ruled.

---

## 11. Phase Plan (implementation tasks)

Each task is independently deliverable + testable, ordered so each builds on the prior.

| # | Task | Description | Files |
|---|---|---|---|
| **T1** | DB schema migration | Create `024_create_ad_admin_commands.sql` with both MySQL + MSSQL branches; wire into `migrations.js` discovery. | `center/db/migrations/024_create_ad_admin_commands.sql` (NEW); `center/src/services/migrations.js` (MODIFY if needed) |
| **T2** | SQL helpers | Add `adAdminCommands.{insert, claim, claimPick, loadByIds, complete, listByOperator, listAll, listByStatus, getById, sweepTimeouts, count*}` for both dialects. | `center/src/db/sql.js` (MODIFY) |
| **T3** | Service module | Implement `queueCommand`, `claimForAgent`, `completeCommand`, `sweepTimeouts`, `getCommand`, `listCommands` with validation map + per-type params validators. | `center/src/services/ad-admin-commands.js` (NEW) |
| **T4** | Server wiring | Add `sweepTimeouts` setInterval in `server.js`. Add env var docs in README. | `center/src/server.js` (MODIFY); `README.md` (MODIFY — env var table) |
| **T5** | Audit classifier entries | Add all 21 entries (`ad_user_*` × 9, `ad_group_*` × 8, `ad_command_*` × 4) to ACTION_CATEGORY/SEVERITY/LABEL + TARGET_LABEL. | `center/src/services/audit-classifier.js` (MODIFY) |
| **T6** | Admin route + agent route | Add 3 admin endpoints (`POST /api/admin/ad-commands`, `GET ...`, `GET .../:id`) and 2 agent endpoints (`GET /api/agent/ad-commands`, `POST .../:id/result`). | `center/src/routes/admin.js` (MODIFY); `center/src/routes/agent.js` (MODIFY) |
| **T7** | Backend tests | Unit tests for service + routes. Uses in-memory mock-db pattern. | `center/tests/services/ad-admin-commands.test.js` (NEW); `center/tests/routes/admin-ad-commands.test.js` (NEW); `center/tests/routes/agent-ad-commands.test.js` (NEW) |
| **T8** | Mock AD store + dispatchers | New `mock-ad-admin.mjs` with all 17 dispatchers + seed dataset. Mock unit tests. | `center/mock-ad-admin.mjs` (NEW); `center/tests/mock-ad-admin.test.js` (NEW) |
| **T9** | Mock agent + daemon integration | Wire mock-multi-agent + mock-heartbeat-daemon to drain `/api/agent/ad-commands` on each tick and POST results back. | `center/mock-multi-agent.mjs` (MODIFY); `center/mock-heartbeat-daemon.mjs` (MODIFY) |
| **T10** | Mock e2e | New `mock-ad-admin-e2e.mjs` exercises every command type end-to-end against live center. | `center/mock-ad-admin-e2e.mjs` (NEW) |
| **T11** | Frontend views + modals | UserManagementView, GroupManagementView, AdCommandHistoryDrawer + all 10 modal components + UserPickerMini + useCommandPolling composable + router + sidebar + API client. | `center/web/src/views/admin/{User,Group}ManagementView.vue` (NEW); `center/web/src/views/admin/AdCommandHistoryDrawer.vue` (NEW); `center/web/src/components/admin/*Modal.vue` × 10 (NEW); `center/web/src/components/admin/UserPickerMini.vue` (NEW); `center/web/src/composables/useCommandPolling.js` (NEW); `center/web/src/api/ad-admin.js` (NEW); `center/web/src/router.js` (MODIFY); `center/web/src/components/AdminLayout.vue` (MODIFY) |
| **T12** | Real agent PS1 stubs | `agent/scripts/ad-admin-users.ps1` + `ad-admin-groups.ps1` + `agent/src/dispatchers/ad-admin.js` switch on command_type. | agent/scripts/ad-admin-users.ps1 (NEW); agent/scripts/ad-admin-groups.ps1 (NEW); agent/src/dispatchers/ad-admin.js (NEW) |
| **T13** | Frontend tests + live verify | Tests for the 2 views + the history drawer. Live-verify on 8080 (POST → GET cycle). | `center/web/tests/{user,group}-management-view.test.js` (NEW); live-verify script (manual + recorded) |

**Suggested commit boundaries:**
- After T1+T2: schema-only commit (no behavior change)
- After T3+T4+T5+T6: backend service+routes commit (testable via curl + admin tests)
- After T7: backend-test commit
- After T8+T9+T10: mock e2e commit
- After T11: frontend commit
- After T12: real-agent commit
- After T13: verify + final commit

**Total estimated effort:** T1-T7 (backend, ~2 days), T8-T10 (mock, ~1 day), T11-T12 (frontend + real-agent, ~2 days).