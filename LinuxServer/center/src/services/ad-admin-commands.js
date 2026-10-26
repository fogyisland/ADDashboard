// 2026-08-31 R75 — AD user & group management command queue service.
//
// Center-staged + agent-pull: operator queues an AD command via
// POST /api/admin/ad-commands; row inserted into ad_admin_commands with
// status='queued'. The agent polls GET /api/agent/ad-commands; the
// service atomically flips up to `limit` queued rows for the agent's
// hostname from 'queued' to 'running' (two-step claimPick + claim so two
// agents polling simultaneously cannot claim the same row). The agent
// executes its PS1 and POSTs back via /api/agent/ad-commands/:id/result
// — the service flips the row to success / failed and writes the result
// blob. Rows persist after completion for audit history.
//
// sweepTimeouts() runs on a setInterval from server.js (Task 4) and
// flips 'running' rows whose claimed_at is older than the threshold to
// 'timeout'. Default 30s matches the agent's internal PS1 exec budget.
//
// Password fields are NEVER stored in result_json and NEVER forwarded
// in audit payloads. The service strips any password-shaped keys
// (password / newPassword / oldPassword) before persisting results,
// and the admin route redaction logic mirrors that on the audit-row
// side. See `redactPasswords` and the admin.js payload-shape comment.

import { getDb } from '../db/index.js';

// ── 17 enum command types from spec §2.2 ─────────────────────────────────
// R158.34 (2026-10-02) — added ad_account_quickfix: the 18th command type
// backing the new `ad_ad_account_quickfix` 1.0.0 package. Single command
// runs the full quickfix sequence on the agent (Unlock-ADAccount +
// Set-ADAccountPassword + Enable-ADAccount + Set-ADUser) so operators
// don't have to fire 4 separate commands. The agent PS1
// (data/packages/ad_ad_account_quickfix/1.0.0/collect.ps1) accepts the
// unified params shape (sam + optional newPassword/displayName/
// description/userAccountControl) and returns the per-step result blob.
// Distribution path matches the other 17: queue → ad_admin_commands
// → agent poll → ack → audit row.
const COMMAND_TYPES = Object.freeze(new Set([
  'user_search',
  'user_create',
  'user_password_reset',
  'user_enable',
  'user_disable',
  'user_unlock',
  'user_set_attributes',
  'user_set_manager',                  // R158.36 (2026-10-03)
  'user_delete',
  'user_list_groups',
  'group_search',
  'group_create',
  'group_set_attributes',
  'group_add_member',
  'group_remove_member',
  'group_set_members',
  'group_delete',
  'group_list_members',
  // R158.40 (2026-10-03) — ADUC 写动作补齐. 创建 OU / 移动任意对象 /
  // 删除任意对象. 包驱动 — `ou_` / `object_` prefix 走 agent 包路径
  // (`<agentDataDir>/cache/<pkgName>/<version>/collect.ps1`), 由 agent
  // dispatcher (src/dispatchers/ad-admin.js) 选包. 跟老 17 个 user_/group_
  // 命令同架构 (centre 队列 → agent PS1 → result 回包).
  //
  // R158.46 (2026-10-06) — 修正 R158.40 注释: 原注释说 "走 dispatcher
  //   (`ou_`/`object_` prefix → ad-admin-ous.ps1 / ad-admin-objects.ps1)"
  //   实际 agent dispatcher 的 PACKAGE_COMMAND_MAP 走的是
  //   ad_ad_ou_create / ad_ad_object_move / ad_ad_object_delete 这 3 个
  //   包, 不是 ad-admin-ous.ps1. 3 个 collect.ps1 在 data/packages/ 下
  //   物理存在, 但 builtin-packages.js BUILTIN_PACKAGES 列表漏注册 →
  //   seeder 不 push → agent 永远拉不到. R158.46 已在 BUILTIN_PACKAGES
  //   注册这 3 个包.
  //
  // R158.56c-d (2026-10-09) — ad_ad_object_delete 整体下线 (operator
  //   directive "这个包不在需要"). DB DELETE 完成. object_delete
  //   commandType validators 同步清 (下面 R158.40 object_delete 块).
  //   未来恢复: git history 复原 PS1/manifest/content.sha256 + 4 处
  //   反注释 + 此处 validators 块加回.
  //
  // 同时, R158.40 注释提到的 "ad-admin-ous.ps1 / ad-admin-objects.ps1"
  //   物理不存在 — `ad-admin-users.ps1` / `ad-admin-groups.ps1` 也是
  //   同类问题, R158.46 新建 2 个 PS1 (scripts/ 目录下) 承接 17 个
  //   user_/group_ 命令.
  'ou_create',
  'object_move',
  'object_delete',
  'ad_account_quickfix'
]));

// ── Per-type params validators ───────────────────────────────────────────
// Each validator returns either:
//   { ok: true, normalized }
//   { ok: false, error: 'invalid params: <field>' }
// Spec §3.1: validation throws httpErr(400, 'invalid params: <field>').
//
// The normalizer returns the canonical params shape (parsed numbers,
// trimmed strings, default-filled optional fields). This is the object
// the service JSON.stringify's into params_json.

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function validators() {
  return {
    user_search: (p) => {
      const out = { filter: '', limit: 200 };
      if (p == null || typeof p !== 'object') return { ok: false, error: 'params object required' };
      if (p.filter != null && typeof p.filter !== 'string') return { ok: false, error: 'invalid params: filter' };
      out.filter = String(p.filter || '').trim();
      if (p.limit != null) {
        const n = Number(p.limit);
        if (!Number.isFinite(n) || n < 1 || n > 1000) return { ok: false, error: 'invalid params: limit' };
        out.limit = Math.floor(n);
      }
      return { ok: true, normalized: out };
    },
    user_create: (p) => {
      if (p == null || typeof p !== 'object') return { ok: false, error: 'params object required' };
      if (!isNonEmptyString(p.sam)) return { ok: false, error: 'invalid params: sam' };
      if (!isNonEmptyString(p.password)) return { ok: false, error: 'invalid params: password' };
      const out = {
        sam: p.sam.trim(),
        password: p.password,
        mustChangePassword: p.mustChangePassword === true,
        givenName: typeof p.givenName === 'string' ? p.givenName : null,
        surname: typeof p.surname === 'string' ? p.surname : null,
        displayName: typeof p.displayName === 'string' ? p.displayName : null,
        upn: typeof p.upn === 'string' ? p.upn : null,
        ouPath: typeof p.ouPath === 'string' ? p.ouPath : null,
        description: typeof p.description === 'string' ? p.description : null
      };
      return { ok: true, normalized: out };
    },
    user_password_reset: (p) => {
      if (p == null || typeof p !== 'object') return { ok: false, error: 'params object required' };
      if (!isNonEmptyString(p.sam)) return { ok: false, error: 'invalid params: sam' };
      if (!isNonEmptyString(p.newPassword)) return { ok: false, error: 'invalid params: newPassword' };
      return {
        ok: true,
        normalized: {
          sam: p.sam.trim(),
          newPassword: p.newPassword,
          mustChangePassword: p.mustChangePassword === true,
          unlockAccount: p.unlockAccount !== false
        }
      };
    },
    user_enable: (p) => p && isNonEmptyString(p.sam)
      ? { ok: true, normalized: { sam: p.sam.trim() } }
      : { ok: false, error: 'invalid params: sam' },
    user_disable: (p) => p && isNonEmptyString(p.sam)
      ? { ok: true, normalized: { sam: p.sam.trim() } }
      : { ok: false, error: 'invalid params: sam' },
    user_unlock: (p) => p && isNonEmptyString(p.sam)
      ? { ok: true, normalized: { sam: p.sam.trim() } }
      : { ok: false, error: 'invalid params: sam' },
    user_set_attributes: (p) => {
      if (p == null || typeof p !== 'object') return { ok: false, error: 'params object required' };
      if (!isNonEmptyString(p.sam)) return { ok: false, error: 'invalid params: sam' };
      if (p.attributes == null || typeof p.attributes !== 'object') return { ok: false, error: 'invalid params: attributes' };
      return {
        ok: true,
        normalized: { sam: p.sam.trim(), attributes: p.attributes }
      };
    },
    // R158.36 (2026-10-03) — user_set_manager. Sets or clears the manager
    // attribute on a user. Empty / null / undefined managerSam clears it.
    // Pass managerDistinguishedName to skip the LDAP lookup when caller
    // already has the DN (e.g. from a picker).
    user_set_manager: (p) => {
      if (p == null || typeof p !== 'object') return { ok: false, error: 'params object required' };
      if (!isNonEmptyString(p.sam)) return { ok: false, error: 'invalid params: sam' };
      const out = { sam: p.sam.trim(), managerSam: '' };
      if (p.managerSam != null && p.managerSam !== '') {
        if (typeof p.managerSam !== 'string') return { ok: false, error: 'invalid params: managerSam' };
        out.managerSam = p.managerSam.trim();
      }
      if (p.managerDistinguishedName != null && typeof p.managerDistinguishedName === 'string') {
        out.managerDistinguishedName = p.managerDistinguishedName.trim() || undefined;
      }
      return { ok: true, normalized: out };
    },
    // R158.34 (2026-10-02) — ad_account_quickfix validator. Single command
    // that runs Unlock-ADAccount + Set-ADAccountPassword + Enable-ADAccount
    // + Set-ADUser in one agent-side pass. Only `sam` is required; the
    // other fields are optional (omit = don't touch that aspect). The
    // `description` field explicitly accepts an empty string to clear the
    // attribute — callers that want to "leave description alone" should
    // simply omit the key entirely.
    ad_account_quickfix: (p) => {
      if (p == null || typeof p !== 'object') return { ok: false, error: 'params object required' };
      if (!isNonEmptyString(p.sam)) return { ok: false, error: 'invalid params: sam' };
      const out = { sam: p.sam.trim() };
      if (p.newPassword != null) {
        if (typeof p.newPassword !== 'string' || p.newPassword.length === 0) {
          return { ok: false, error: 'invalid params: newPassword' };
        }
        out.newPassword = p.newPassword;
      }
      if (p.displayName != null) {
        if (typeof p.displayName !== 'string') return { ok: false, error: 'invalid params: displayName' };
        out.displayName = p.displayName;
      }
      if (p.description !== undefined) {
        if (typeof p.description !== 'string') return { ok: false, error: 'invalid params: description' };
        out.description = p.description;
      }
      if (p.userAccountControl != null) {
        const n = Number(p.userAccountControl);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 4294967295) {
          return { ok: false, error: 'invalid params: userAccountControl' };
        }
        out.userAccountControl = String(n);
      }
      return { ok: true, normalized: out };
    },
    user_delete: (p) => p && isNonEmptyString(p.sam)
      ? { ok: true, normalized: { sam: p.sam.trim() } }
      : { ok: false, error: 'invalid params: sam' },
    user_list_groups: (p) => p && isNonEmptyString(p.sam)
      ? { ok: true, normalized: { sam: p.sam.trim() } }
      : { ok: false, error: 'invalid params: sam' },
    group_search: (p) => {
      const out = { filter: '', limit: 200 };
      if (p == null || typeof p !== 'object') return { ok: false, error: 'params object required' };
      if (p.filter != null && typeof p.filter !== 'string') return { ok: false, error: 'invalid params: filter' };
      out.filter = String(p.filter || '').trim();
      if (p.limit != null) {
        const n = Number(p.limit);
        if (!Number.isFinite(n) || n < 1 || n > 1000) return { ok: false, error: 'invalid params: limit' };
        out.limit = Math.floor(n);
      }
      return { ok: true, normalized: out };
    },
    group_create: (p) => {
      if (p == null || typeof p !== 'object') return { ok: false, error: 'params object required' };
      if (!isNonEmptyString(p.name)) return { ok: false, error: 'invalid params: name' };
      if (!isNonEmptyString(p.category)) return { ok: false, error: 'invalid params: category' };
      if (!isNonEmptyString(p.scope)) return { ok: false, error: 'invalid params: scope' };
      return {
        ok: true,
        normalized: {
          name: p.name.trim(),
          sam: typeof p.sam === 'string' ? p.sam : null,
          displayName: typeof p.displayName === 'string' ? p.displayName : null,
          category: p.category,
          scope: p.scope,
          ouPath: typeof p.ouPath === 'string' ? p.ouPath : null,
          description: typeof p.description === 'string' ? p.description : null,
          mail: typeof p.mail === 'string' ? p.mail : null
        }
      };
    },
    group_set_attributes: (p) => {
      if (p == null || typeof p !== 'object') return { ok: false, error: 'params object required' };
      if (!isNonEmptyString(p.name)) return { ok: false, error: 'invalid params: name' };
      if (p.attributes == null || typeof p.attributes !== 'object') return { ok: false, error: 'invalid params: attributes' };
      return {
        ok: true,
        normalized: { name: p.name.trim(), attributes: p.attributes }
      };
    },
    group_add_member: (p) => {
      if (p == null || typeof p !== 'object') return { ok: false, error: 'params object required' };
      if (!isNonEmptyString(p.name)) return { ok: false, error: 'invalid params: name' };
      if (!Array.isArray(p.members) || p.members.length === 0) return { ok: false, error: 'invalid params: members' };
      return { ok: true, normalized: { name: p.name.trim(), members: p.members.map(String) } };
    },
    group_remove_member: (p) => {
      if (p == null || typeof p !== 'object') return { ok: false, error: 'params object required' };
      if (!isNonEmptyString(p.name)) return { ok: false, error: 'invalid params: name' };
      if (!Array.isArray(p.members) || p.members.length === 0) return { ok: false, error: 'invalid params: members' };
      return { ok: true, normalized: { name: p.name.trim(), members: p.members.map(String) } };
    },
    group_set_members: (p) => {
      if (p == null || typeof p !== 'object') return { ok: false, error: 'params object required' };
      if (!isNonEmptyString(p.name)) return { ok: false, error: 'invalid params: name' };
      if (!Array.isArray(p.members)) return { ok: false, error: 'invalid params: members' };
      return { ok: true, normalized: { name: p.name.trim(), members: p.members.map(String) } };
    },
    group_delete: (p) => p && isNonEmptyString(p.name)
      ? { ok: true, normalized: { name: p.name.trim() } }
      : { ok: false, error: 'invalid params: name' },
    group_list_members: (p) => {
      if (p == null || typeof p !== 'object') return { ok: false, error: 'params object required' };
      if (!isNonEmptyString(p.name)) return { ok: false, error: 'invalid params: name' };
      const out = { name: p.name.trim(), page: 1, size: 100 };
      if (p.page != null) {
        const n = Number(p.page);
        if (!Number.isFinite(n) || n < 1) return { ok: false, error: 'invalid params: page' };
        out.page = Math.floor(n);
      }
      if (p.size != null) {
        const n = Number(p.size);
        if (!Number.isFinite(n) || n < 1 || n > 1000) return { ok: false, error: 'invalid params: size' };
        out.size = Math.floor(n);
      }
      return { ok: true, normalized: out };
    },
    // R158.40 (2026-10-03) — 创建 OU (走包 `ad_ad_ou_create/1.0.0/collect.ps1`,
  //   agent dispatcher PACKAGE_COMMAND_MAP 注册).
  // R158.46 (2026-10-06) — builtin-packages.js BUILTIN_PACKAGES 注册该包.
    ou_create: (p) => {
      if (p == null || typeof p !== 'object') return { ok: false, error: 'params object required' };
      if (!isNonEmptyString(p.parentDn)) return { ok: false, error: 'invalid params: parentDn' };
      if (!isNonEmptyString(p.name)) return { ok: false, error: 'invalid params: name' };
      return {
        ok: true,
        normalized: {
          parentDn: p.parentDn.trim(),
          name: p.name.trim(),
          description: typeof p.description === 'string' ? p.description : null
        }
      };
    },
    // R158.40 — 移动任意对象 (user / group / ou / gpo 等) 到新 parent DN.
    //   走包 `ad_ad_object_move/1.0.0/collect.ps1` (agent dispatcher
    //   PACKAGE_COMMAND_MAP 注册).
    // R158.46 (2026-10-06) — builtin-packages.js BUILTIN_PACKAGES 注册.
    object_move: (p) => {
      if (p == null || typeof p !== 'object') return { ok: false, error: 'params object required' };
      if (!isNonEmptyString(p.targetDn)) return { ok: false, error: 'invalid params: targetDn' };
      if (!isNonEmptyString(p.newParentDn)) return { ok: false, error: 'invalid params: newParentDn' };
      return {
        ok: true,
        normalized: {
          targetDn: p.targetDn.trim(),
          newParentDn: p.newParentDn.trim()
        }
      };
    },
    // R158.40 — 删除任意对象 (走空 OU 才能删 user/group; OU 非空时 front-end 拦截).
    //   走包 `ad_ad_object_delete/1.0.0/collect.ps1` (agent dispatcher
    //   PACKAGE_COMMAND_MAP 注册).
    // R158.46 (2026-10-06) — builtin-packages.js BUILTIN_PACKAGES 注册.
    // R158.56c-d (2026-10-09) — 整体下线. operator directive "ad_ad_object_delete
    //   这个包不在需要, 从中心数据库删除". validators 块同步清, 防止
    //   DailyOpsView "删除" 按钮复活. 未来恢复: builtin-packages.js
    //   BUILTIN_PACKAGES 取消注释 + 此处 validators 块加回 + admin.js
    //   whitelist if 删 + ad-admin.js PACKAGE_COMMAND_MAP 加回 + 复原
    //   PS1/manifest/content.sha256.
    // object_delete: (p) => { ... }  -- R158.56c-d removed
  };
}

const VALIDATORS = validators();

// ── R158.46b task_id generator ───────────────────────────────────────────
// operator 偏好 "服务器名+年月日时分秒毫秒" 风格 ID, 在 queue 时刻生成. 例:
//   KDLOFADSRV2-20261006142305123
//
// targetDc 是 queueCommand 入参 — **来自前端 daily-ops 顶部 picker 选中的 DC**
// (R158.45.34 picker 严格顺序选到 DC 才显示; dcHostname 走 v-if), **不是固定的
// KDLOFADSRV1**. operator 切 picker 到 KDLOFADSRV2 时, 所有触发的 AD 写动作
// 的 task_id 前缀都跟着是 KDLOFADSRV2-..., 而不是 KDLOFADSRV1-....
//
// **关键: task_id 里的 DC = 实际执行命令的 agent 所在机器** (R158.46b operator
// "他执行也在那台机器上"). 也就是 picker KDLOFADSRV2 → targetDc KDLOFADSRV2
// → 拼进 task_id → 该 agent 用 hostname=KDLOFADSRV2 poll 拉到这条命令 →
// 在 KDLOFADSRV2 上跑 PS1 → task_id 前缀正好是 "执行机". 三者完全一致,
// 排错时 task_id 一眼能定位 "哪台机器跑的". 不要拆 taskIdDc 跟 executionDc
// 两个字段 (诱惑: "taskId 给人看, executionDc 内部用" — 拆了反而易漂).
//
// 跨 DC 唯一 (TIMESTAMP + DC 名前缀) + 自带触发时刻. 4 个 lifecycle audit row
// 同步把 taskId 塞进 payload (admin.js _auditAdCommand + agent.js 3 处 audit).
// 取 server UTC 时间戳 (不是本地时间, 避免跨时区 server 部署漂移), 不是
// SYSUTCDATETIME() — 因为 timestamp 要给 operator 直接看, service 显式传值.
function _formatTaskTimestamp(d) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    pad(d.getUTCMilliseconds(), 3)
  );
}
function _buildTaskId(targetDc) {
  // 大写归一, 但保留 server hostname 自身的大小写 (server 常混大小写, 避免去重
  // 失败). DC 名去前后空格, 内部连字符保留.
  const safeDc = String(targetDc || '').trim();
  return `${safeDc}-${_formatTaskTimestamp(new Date())}`;
}

// ── httpErr helper (matches file-push convention) ────────────────────────
function httpErr(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

// ── Password redaction ───────────────────────────────────────────────────
// Spec §3.4 ruling #8 + §3.3 admin route note: passwords are NEVER
// stored in result_json. Strip before persisting.
const PASSWORD_KEYS = new Set(['password', 'newPassword', 'oldPassword']);

function redactPasswords(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(redactPasswords);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (PASSWORD_KEYS.has(k)) continue;
      out[k] = redactPasswords(v);
    }
    return out;
  }
  return value;
}

// ── Public surface ──────────────────────────────────────────────────────

/**
 * Queue a new AD admin command. Inserts a row with status='queued'.
 * @returns the inserted row (without params_json / result_json noise)
 */
export async function queueCommand({ targetDc, commandType, params, operatorId }) {
  if (!targetDc || typeof targetDc !== 'string') {
    throw httpErr(400, 'targetDc required');
  }
  if (!commandType || typeof commandType !== 'string') {
    throw httpErr(400, 'commandType required');
  }
  if (!COMMAND_TYPES.has(commandType)) {
    throw httpErr(400, `unknown command_type: ${commandType}`);
  }
  const validator = VALIDATORS[commandType];
  if (!validator) throw httpErr(400, `unknown command_type: ${commandType}`);
  const v = validator(params);
  if (!v.ok) throw httpErr(400, v.error);

  const db = getDb();
  const paramsJson = JSON.stringify(v.normalized);
  // R158.46b — 在 queue 时刻生成 task_id (<DC>-<UTC YYYYMMDDHHMMSSmmm>).
  // 4 个 lifecycle audit row payload.taskId 同步使用 (admin.js _auditAdCommand
  // + agent.js 4 个 audit writeAudit). 极小概率 (<DC, ms>) 冲突走 DB UNIQUE
  // index 兜底 (R75 串行入队 + 操作员手动触发, 实际并发 < 0.01%).
  const taskId = _buildTaskId(targetDc);
  const exec = await db.execute(db.sql.adAdminCommands.insert, [
    commandType,
    targetDc.trim(),
    paramsJson,
    operatorId ?? null,
    taskId
  ]);
  // insertId is the LAST_INSERT_ID() from the mysql driver wrapper, or the
  // SCOPE_IDENTITY() probe batch the mssql wrapper appends (mssql.js line
  // 125-127). Both dialects populate insertId on INSERT INTO a table with
  // an AUTO_INCREMENT / IDENTITY primary key.
  const insertId = exec.insertId ?? exec.rows?.[0]?.id;
  return {
    id: insertId,
    command_type: commandType,
    target_dc: targetDc.trim(),
    status: 'queued',
    operator_id: operatorId ?? null,
    created_at: new Date().toISOString(),
    task_id: taskId
  };
}

/**
 * Pull queued commands for an agent. Two-step claim:
 *   1) SELECT up to `limit` queued ids for this dc (oldest first)
 *   2) UPDATE those ids SET status='running', claimed_at=NOW() WHERE status='queued'
 * If step 2 flips zero rows (e.g. another agent claimed them first between
 * step 1 and step 2), the read side already returned the ids but the row is
 * now 'running' elsewhere — we re-SELECT by id and filter out anything that
 * did NOT flip. This makes the claim atomic relative to concurrent pollers.
 */
export async function claimForAgent(targetDc, limit = 5) {
  if (!targetDc || typeof targetDc !== 'string') {
    throw httpErr(400, 'targetDc required');
  }
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 5));
  // 2026-09-25 R93.4 — on MSSQL the claimPick SQL builder is a function
  // (see db/sql.js:adAdminCommands.claimPick) because MSSQL TOP rejects
  // parameter binding; on MySQL it's a plain string with `LIMIT ?`. The
  // helper below inlines the integer on MSSQL or passes it through as a
  // bound param on MySQL. safeLimit is clamped to [1, 100] and is always
  // an integer by this point; the explicit Number() cast is
  // belt-and-suspenders against any future caller passing a stringly
  // typed limit.
  const claimPickSql = resolveClaimPickSql(db, safeLimit);
  const { rows: idRows } = await db.query(
    claimPickSql,
    db.dialect === 'mssql' ? [targetDc] : [targetDc, safeLimit]
  );
  if (!idRows || idRows.length === 0) return [];
  const ids = idRows.map(r => Number(r.id)).filter(Number.isFinite);
  if (ids.length === 0) return [];
  // claim uses (idCount) => ... to expand IN-list placeholders. Caller binds
  // [id1, id2, ..., idN, targetDc] in that order.
  const claimSql = db.sql.adAdminCommands.claim(ids.length);
  const claimParams = [...ids, targetDc];
  await db.execute(claimSql, claimParams);
  // loadByIds returns the full row set including the freshly-updated
  // claimed_at / status. Strip result_json (not needed on the agent side).
  const loadSql = db.sql.adAdminCommands.loadByIds(ids.length);
  const { rows } = await db.query(loadSql, ids);
  if (!rows) return [];
  return rows.map(stripResultJson).map(parseParamsJson);
}

/**
 * Terminal-state ack from the agent. Flips status to success / failed.
 * Idempotent on already-terminal rows (returns the existing row unchanged
 * if status is already success/failed/timeout).
 */
export async function completeCommand(id, { success, data, error, exitCode, durationMs } = {}) {
  const numId = Number(id);
  if (!Number.isFinite(numId) || numId <= 0) throw httpErr(400, 'invalid command id');
  const db = getDb();
  // Read first so we can enforce idempotency on already-terminal rows.
  const existing = await getCommand(numId);
  if (!existing) throw httpErr(404, 'command not found');
  if (existing.status === 'success' || existing.status === 'failed' || existing.status === 'timeout') {
    return existing;
  }
  if (existing.status !== 'running') {
    // Not claimed yet — the agent's ack is invalid. 409 covers the spec
    // §2.4 'command not claimed by this agent' defense-in-depth path.
    throw httpErr(409, `command not in running state (status=${existing.status})`);
  }
  const newStatus = success ? 'success' : 'failed';
  // Spec §3.4 ruling #8: strip any password-shaped fields from result_json
  // before persisting. The agent should never have included them (the PS1
  // dispatchers are not expected to echo passwords), but defense-in-depth.
  const safeData = data == null ? null : redactPasswords(data);
  const resultJson = safeData == null ? null : JSON.stringify(safeData);
  const errorMessage = typeof error === 'string' ? error.slice(0, 2000) : null;
  const durMs = Number.isFinite(Number(durationMs)) ? Math.max(0, Math.floor(Number(durationMs))) : null;
  await db.execute(db.sql.adAdminCommands.complete, [
    newStatus,
    resultJson,
    errorMessage,
    durMs,
    numId
  ]);
  // R158.100.C (2026-10-14) — fire-and-forget 通知 enqueue. ad-notify.js
  //   内部 try/catch + log, 永不抛, 不影响 return getCommand 路径. pattern
  //   跟 sweepTimeouts audit write (line 608-611) 1:1 平行.
  try {
    const { enqueueAdNotify } = await import('./ad-notify.js');
    await enqueueAdNotify({
      commandId: numId,
      commandType: existing.command_type,
      targetDc: existing.target_dc,
      target: null,  // service 内 extractTargetFields 从 params 自己抽
      status: newStatus,  // 'success' | 'failed'
      operatorId: existing.operator_id,
      taskId: existing.task_id,
      durationMs: durMs,
      errorMessage,
      params: existing.params_json || {}
    });
  } catch (notifyErr) {
    console.error('[ad-admin-commands] ad notify enqueue threw:', notifyErr?.message, { commandId: numId });
  }
  return getCommand(numId);
}

/**
 * Sweep 'running' commands older than `timeoutMs` to 'timeout'. Called
 * by the server.js setInterval every 10s.
 *
 * R158.47.1 (2026-10-06) — operator directive "日常管理操作执行过程
 *   激活、执行、完成成功还是错误是否会回写日志". audit 回写链路 4/5
 *   完整 (claim/succeeded/failed 都有 audit row), timeout 路径只改
 *   lifecycle 表不写 audit_logs. 修复: sweep 前 SELECT 出超时行
 *   (id / task_id / command_type / target_dc), UPDATE 后逐行写
 *   `ad_command_timeout` audit row, 跟其它 4 lifecycle audit
 *   payload shape 对齐 (commandId/taskId/commandType/targetDc/
 *   errorMessage). SELECT+UPDATE 非原子但风险低: 同一行连续 2 次 sweep
 *   只会写 1 个 audit (sweepTimeouts SQL 的 WHERE status='running'
 *   第二次已不命中), idempotency 由 lifecycle 表的 status 转换守住.
 */
export async function sweepTimeouts({ timeoutMs = 30000, now: _now, logger = null } = {}) {
  const db = getDb();
  const timeoutSeconds = Math.max(1, Math.ceil(Number(timeoutMs) / 1000));
  // 1) 先 SELECT 出超时行的 id + 上下文 (避免 UPDATE 后拿不到 task_id)
  //    MySQL / MSSQL 都用 ? 绑 INTERVAL SECOND, 跨 dialect 一致.
  // R158.100.C (2026-10-14) — SELECT 增 operator_id + params_json, 给
  //   sweepTimeout fire-and-forget 通知 enqueue (ad-notify.js) 用.
  const selectSql = db.dialect === 'mssql'
    ? `SELECT id, task_id, command_type, target_dc, operator_id, params_json
         FROM ad_admin_commands
         WHERE status = CAST('running' AS NVARCHAR(16))
           AND claimed_at < DATEADD(SECOND, -?, CAST(SYSUTCDATETIME() AS DATETIME2))`
    : `SELECT id, task_id, command_type, target_dc, operator_id, params_json
         FROM ad_admin_commands
         WHERE status = 'running'
           AND claimed_at < UTC_TIMESTAMP() - INTERVAL ? SECOND`;
  let victims = [];
  try {
    const { rows } = await db.query(selectSql, [timeoutSeconds]);
    victims = Array.isArray(rows) ? rows : [];
  } catch (e) {
    // SELECT 失败非致命: 继续 UPDATE, audit 跳过 (lifecycle 表本身已更新)
    logger?.warn?.({ err: e?.message }, 'ad_admin_commands sweepTimeouts SELECT failed; audit skip');
  }
  // 2) UPDATE 生命周期表
  await db.execute(db.sql.adAdminCommands.sweepTimeouts, [timeoutSeconds]);
  // 3) 每行写 audit row (R158.47.1 补全 timeout audit gap)
  // R158.47.2 (2026-10-06) — H2 fix (CWE-778 audit completeness):
  //   - writeAudit → writeAuditRequired: 失败时 throw 而不是 warn-silent
  //   - auditFailures === victims.length 时 logger.error 升级, 触发告警
  //   - 单 victim 失败仍是 logger.warn (R107.1 best-effort, partial failure
  //     不阻断其它 row audit)
  if (victims.length > 0) {
    const audit = await import('./audit.js');
    let auditFailures = 0;
    for (const v of victims) {
      try {
        // writeAuditRequired({userId, action, target, payload}, logger) — logger
        // 是第二参数 (audit.js:101 签名), 不是 payload 字段.
        await audit.writeAuditRequired({
          userId: null,                          // sweeper 无人操作员
          action: 'ad_command_timeout',
          target: `cmd:${v.id}`,
          payload: {
            commandId: v.id,
            taskId: v.task_id ?? null,            // R158.46b 同源 task_id
            commandType: v.command_type,
            targetDc: v.target_dc,
            errorMessage: 'command exceeded timeout threshold',
            timeoutMs: Number(timeoutMs) || null
          }
        }, logger);
      } catch (e) {
        auditFailures++;
        logger?.warn?.({ err: e?.message, commandId: v?.id },
          'ad_command_timeout audit write failed (best-effort counted)');
      }
      // R158.100.C (2026-10-14) — fire-and-forget 通知 enqueue (timeout 路径).
      //   ad-notify.js 内部 try/catch + log, 永不抛, 不影响 audit loop 主流程.
      //   跟 completeCommand line 540-555 enqueue 1:1 平行, status='timeout'.
      try {
        const { enqueueAdNotify } = await import('./ad-notify.js');
        let parsedParams = {};
        try { parsedParams = v.params_json ? JSON.parse(v.params_json) : {}; } catch { /* keep {} */ }
        await enqueueAdNotify({
          commandId: v.id,
          commandType: v.command_type,
          targetDc: v.target_dc,
          target: null,
          status: 'timeout',
          operatorId: v.operator_id,
          taskId: v.task_id,
          durationMs: null,
          errorMessage: 'command exceeded timeout threshold',
          params: parsedParams
        });
      } catch (notifyErr) {
        logger?.warn?.({ err: notifyErr?.message, commandId: v?.id },
          'sweepTimeouts: ad notify enqueue threw (best-effort)');
      }
    }
    if (auditFailures === victims.length) {
      // R158.47.2 — H2 fix: 全部 audit 失败时 logger.error 升级, 操作员/告警
      // 能立即看到 audit_logs 表可能被锁/满/migration-broken.
      logger?.error?.({ swept: victims.length, auditFailures, timeoutMs },
        'sweepTimeouts: ALL audit writes failed — investigate audit_logs table integrity');
    } else if (auditFailures > 0) {
      logger?.warn?.({ swept: victims.length, auditFailures, timeoutMs },
        'sweepTimeouts: partial audit failures');
    }
    logger?.info?.({ swept: victims.length, auditFailures, timeoutMs },
      'ad admin commands sweep complete with audit');
  }
  return victims.length; // R158.47.1 — 现在能返确切数了 (之前的 0 是 SQL UPDATE 无返回)
}

/**
 * R158.46.4 (2026-10-06) — boot-time 一次性 backfill.
 *
 * 修 2 个功能 gap:
 *   (a) `ad_admin_commands.task_id IS NULL` 老行 (R158.46b 之前入队的 command,
 *       MSSQL 部署下 task_id 列 R158.46.3 才加, 这些行的 task_id 为 NULL):
 *       复用 `_buildTaskId(targetDc)` 跟 queue 时刻同 helper 生成 task_id, 跨 dialect 0 风险.
 *
 *   (b) `audit_logs.action = 'ad_command_timeout'` 历史缺失 row (R158.46.1 之前
 *       sweepTimeouts 不写 audit, 这些 timeout command 在 lifecycle panel 看不见):
 *       补写 audit, payload shape 跟 sweepTimeouts R158.47.1 同.
 *
 * 全部包 `db.transaction` (R158.46.2 H1 fix 防 TOCTOU 双进程并发), UPDATE/INSERT
 * 走 `tx.sql` 复用现有 dialect-aware factory, audit 走 `writeAuditRequired` 在 tx 内
 * (R158.47.2 H2 fix 保证 audit 完整性, 失败 throw 让 tx 回滚).
 *
 * Idempotency:
 *   - task_id UPDATE 加 `WHERE task_id IS NULL` 守门, 二跑命中 0 行
 *   - audit row 用 NOT EXISTS 查重 (dialect-aware JSON_VALUE/JSON_EXTRACT), 二跑 0 行
 *
 * 跨 dialect 时间戳生成 — **不在 SQL 层** (避免 culture 漂移), JS 层用
 * `_buildTaskId(targetDc)` 替换 `new Date()` → `new Date(row.created_at)`. JS Date
 * 直接 parse MSSQL DATETIME2 UTC 跟 MySQL DATETIME UTC (driver timezone='Z' 解析)
 * 都 OK, 跟 queue 时刻用同一 helper 保证格式 100% 一致.
 *
 * 复用 utility:
 *   - `_buildTaskId(targetDc)` + `_formatTaskTimestamp(d)` (line 362-379)
 *   - `db.transaction(async (tx) => { ... })` (db/drivers/{mysql,mssql}.js)
 *   - `tx.execute(tx.sql.X)` — 复用 `tx.sql.adAdminCommands.updateTaskId` + `tx.sql.audit.write`
 *     (sql.js mysql:1392 / msssql:3244 adAdminCommands 块; audit.write sql.js mysql:346 / msssql:2238)
 *   - `writeAuditRequired({...}, logger, tx)` (audit.js:101)
 *
 * @param {object} options
 * @param {object} [options.logger]
 * @returns {Promise<{taskIdBackfilled: number, auditBackfilled: number, auditFailures: number}>}
 */
export async function backfillAdAdminCommandData({ logger = null } = {}) {
  const db = getDb();
  if (!db) {
    logger?.warn?.({ component: 'ad-admin-backfill' }, 'no db handle; skip');
    return { taskIdBackfilled: 0, auditBackfilled: 0, auditFailures: 0 };
  }
  const isMssql = db.dialect === 'mssql';

  // ── (a) task_id NULL 老行 backfill ─────────────────────────────────────
  // 跨 dialect SQL 一致 (ad_admin_commands 列定义两边一样, IS NULL 通用).
  const victimsSql = `SELECT id, target_dc, created_at
                       FROM ad_admin_commands
                      WHERE task_id IS NULL
                      ORDER BY id ASC`;
  const updateTaskIdSql = `UPDATE ad_admin_commands
                              SET task_id = ?
                            WHERE id = ? AND task_id IS NULL`;

  let taskIdBackfilled = 0;
  let taskIdVictims = [];
  try {
    taskIdVictims = await db.transaction(async (tx) => {
      const { rows } = await tx.query(victimsSql, []);
      const list = Array.isArray(rows) ? rows : [];
      for (const v of list) {
        // 复用 _buildTaskId helper, 用 row.created_at 替换 new Date() —
        // JS Date 直接 parse MSSQL DATETIME2 UTC / MySQL DATETIME UTC (driver 已按 UTC 处理),
        // 跟 queue 时刻用同一 helper 保证格式 100% 一致.
        const safeDc = String(v.target_dc || '').trim();
        const createdDate = v.created_at instanceof Date
          ? v.created_at
          : new Date(v.created_at);
        const ts = _formatTaskTimestamp(createdDate);
        const taskId = `${safeDc}-${ts}`;
        await tx.execute(updateTaskIdSql, [taskId, v.id]);
        taskIdBackfilled++;
      }
      return list;
    });
  } catch (e) {
    // R158.46.1 风格 — boot-time 非致命, log + 继续, 下次 boot 再尝试
    logger?.warn?.({ component: 'ad-admin-backfill', err: e?.message },
      'task_id backfill failed; non-fatal');
  }

  // ── (b) audit_logs ad_command_timeout 缺失 row backfill ────────────────
  // 跨 dialect LEFT JOIN 查重: NOT EXISTS audit row WHERE commandId == c.id
  // MSSQL: JSON_VALUE(a.payload, '$.commandId') = c.id
  // MySQL: JSON_EXTRACT(a.payload, '$.commandId') = c.id
  // 列 c.status = 'timeout' 守门 — 只补 R158.46.1 之前 sweepTimeouts 漏写的
  // timeout row; 已成功的 (R158.47.1 之后) 不动.
  const auditVictimsSql = isMssql
    ? `SELECT c.id, c.task_id, c.command_type, c.target_dc, c.claimed_at, c.completed_at
         FROM ad_admin_commands c
        WHERE c.status = CAST('timeout' AS NVARCHAR(16))
          AND NOT EXISTS (
            SELECT 1 FROM audit_logs a
             WHERE a.action = 'ad_command_timeout'
               AND JSON_VALUE(a.payload, '$.commandId') = c.id
          )
        ORDER BY c.id ASC`
    : `SELECT c.id, c.task_id, c.command_type, c.target_dc, c.claimed_at, c.completed_at
         FROM ad_admin_commands c
        WHERE c.status = 'timeout'
          AND NOT EXISTS (
            SELECT 1 FROM audit_logs a
             WHERE a.action = 'ad_command_timeout'
               AND JSON_EXTRACT(a.payload, '$.commandId') = c.id
          )
        ORDER BY c.id ASC`;

  let auditBackfilled = 0;
  let auditFailures = 0;
  try {
    await db.transaction(async (tx) => {
      const { rows } = await tx.query(auditVictimsSql, []);
      const list = Array.isArray(rows) ? rows : [];
      // lazy import — 跟 sweepTimeouts (line 586) 同款
      const { writeAuditRequired } = await import('./audit.js');
      for (const v of list) {
        try {
          // 跟 sweepTimeouts R158.47.1 audit payload shape 对齐 (ad-admin-commands.js:596-603)
          // backfilled:true 让操作员能区分这是 boot-time 补写的历史 audit (跟未来 sweep 写的不同).
          await writeAuditRequired({
            userId: null,
            action: 'ad_command_timeout',
            target: `cmd:${v.id}`,
            payload: {
              commandId: v.id,
              taskId: v.task_id ?? null,
              commandType: v.command_type,
              targetDc: v.target_dc,
              errorMessage: 'command exceeded timeout threshold',
              timeoutMs: null,                          // 历史 sweep 不传 timeoutMs
              backfilled: true                           // R158.46.4 标记, 区别于 sweep 写的
            }
          }, logger, tx);
          auditBackfilled++;
        } catch (e) {
          auditFailures++;
          logger?.warn?.({ err: e?.message, commandId: v?.id },
            'backfill ad_command_timeout audit write failed (counted)');
        }
      }
    });
  } catch (e) {
    logger?.warn?.({ component: 'ad-admin-backfill', err: e?.message },
      'audit backfill failed; non-fatal');
  }

  if (taskIdBackfilled > 0 || auditBackfilled > 0 || auditFailures > 0) {
    logger?.info?.({
      component: 'ad-admin-backfill',
      taskIdBackfilled,
      auditBackfilled,
      auditFailures
    }, 'R158.46.4 backfill done');
  }

  return { taskIdBackfilled, auditBackfilled, auditFailures };
}

/**
 * Single row read by id. Returns null if not found.
 */
export async function getCommand(id) {
  const numId = Number(id);
  if (!Number.isFinite(numId) || numId <= 0) return null;
  const db = getDb();
  const { rows } = await db.query(db.sql.adAdminCommands.getById, [numId]);
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  return {
    ...row,
    params_json: tryParseJson(row.params_json),
    result_json: tryParseJson(row.result_json)
  };
}

/**
 * Paginated list with optional operatorId / status filters. Returns
 * { total, rows, page, size }.
 */
export async function listCommands({ operatorId, status, page = 1, size = 50 } = {}) {
  const safePage = Math.max(1, Math.floor(Number(page) || 1));
  const safeSize = Math.max(1, Math.min(500, Math.floor(Number(size) || 50)));
  const offset = (safePage - 1) * safeSize;
  const db = getDb();

  let listSql;
  let listParams;
  let countSql;
  let countParams;
  // 2026-09-25 R93.4 — MSSQL's `TOP` clause does not accept parameter
  // binding (only an integer literal). The SQL builders are function-form
  // on MSSQL (limit is interpolated) and plain string with `LIMIT ?
  // OFFSET ?` on MySQL. Service layer dispatches:
  //   mssql → call listBy* as a function with safeSize, bind [WHERE params, offset]
  //   mysql → use the plain string, bind [WHERE params, safeSize, offset]
  const isMssql = db.dialect === 'mssql';
  // R158.56.2 (2026-10-08) — MSSQL 用 OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
  // (R158.56.2 改 R93.4 TOP+OFFSET 因为 MSSQL 10741 禁止). OFFSET 在前, FETCH 在后.
  // MSSQL 分支必须 bind [WHERE params, offset, safeSize]; MySQL 分支 bind
  // [WHERE params, safeSize, offset] (LIMIT 在前, OFFSET 在后).
  if (operatorId != null && status != null) {
    // Combined filter: status + operatorId. Service runs status filter
    // then post-filters by operatorId (operatorId rarely combines with
    // status in real UI traffic).
    listSql = isMssql ? db.sql.adAdminCommands.listByStatus(safeSize) : db.sql.adAdminCommands.listByStatus;
    listParams = isMssql ? [status, offset, safeSize] : [status, safeSize, offset];
    countSql = db.sql.adAdminCommands.countByStatus;
    countParams = [status];
  } else if (operatorId != null) {
    listSql = isMssql ? db.sql.adAdminCommands.listByOperator(safeSize) : db.sql.adAdminCommands.listByOperator;
    listParams = isMssql ? [operatorId, offset, safeSize] : [operatorId, safeSize, offset];
    countSql = db.sql.adAdminCommands.countByOperator;
    countParams = [operatorId];
  } else if (status != null) {
    listSql = isMssql ? db.sql.adAdminCommands.listByStatus(safeSize) : db.sql.adAdminCommands.listByStatus;
    listParams = isMssql ? [status, offset, safeSize] : [status, safeSize, offset];
    countSql = db.sql.adAdminCommands.countByStatus;
    countParams = [status];
  } else {
    listSql = isMssql ? db.sql.adAdminCommands.listAll(safeSize) : db.sql.adAdminCommands.listAll;
    listParams = isMssql ? [offset, safeSize] : [safeSize, offset];
    countSql = db.sql.adAdminCommands.countAll;
    countParams = [];
  }

  const [{ rows: countRows }, { rows }] = await Promise.all([
    db.query(countSql, countParams),
    db.query(listSql, listParams)
  ]);
  const total = Number(countRows?.[0]?.total ?? 0);
  return { total, rows: (rows || []).map(r => ({ ...r, params_json: undefined, result_json: undefined })), page: safePage, size: safeSize };
}

// ── Internal helpers ─────────────────────────────────────────────────────

function stripResultJson(row) {
  if (!row) return row;
  const { result_json, ...rest } = row;
  return rest;
}

function tryParseJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

function parseParamsJson(row) {
  if (!row) return row;
  return { ...row, params_json: tryParseJson(row.params_json) };
}

// 2026-09-25 R93.4 — MSSQL's `TOP` clause cannot be parameter-bound (only
// an integer literal). MySQL's `LIMIT` accepts integer params. The
// per-dialect claimPick builders reflect that, so the call site has to
// pick the right shape: function-call to inline the integer on MSSQL,
// plain string with a bound param on MySQL. Keeps the per-dialect SQL
// registry simple (one builder per dialect, no dialect sniffing inside
// the registry) while the service layer carries the dispatch.
function resolveClaimPickSql(db, safeLimit) {
  if (db.dialect === 'mssql') {
    return db.sql.adAdminCommands.claimPick(Number(safeLimit));
  }
  return db.sql.adAdminCommands.claimPick;
}

// ── Test helpers ─────────────────────────────────────────────────────────
// Exposed so the test harness can reset the in-memory state between runs
// without leaking state across test files. NOT exported via the router.

export const _testInternals = Object.freeze({
  COMMAND_TYPES,
  redactPasswords,
  validators: VALIDATORS,
  httpErr
});