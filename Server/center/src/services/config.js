// System config service. Reads/writes key-value rows in `system_config`
// and exposes the agent-facing config bundle (polling, latency threshold,
// token).

import { getDb } from '../db/index.js';
import { encryptBindPassword, deriveSecretKey } from './ad-directory-sync.js';

// Sentinel returned to UI callers when the SMTP password is present. The UI
// sends this back on PUT to mean "keep the existing value" (matches the
// putConfig contract below).
export const SMTP_PASSWORD_MASK = '********';

// R158.35 — AD LDAP bind password sentinel. Same contract as SMTP. The UI
// shows "已配置" when the row is non-empty + non-sentinel; the operator
// types a new password to rotate. We never round-trip the cleartext to
// the browser.
export const AD_BIND_PASSWORD_MASK = '********';

// Mask smtp_password on read. Only masks a real (non-empty) value so the UI
// can tell the difference between "no password set" (empty/undefined) and
// "password set but hidden" (the sentinel).
export function maskSmtpPasswordForRead(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  if (cfg.smtp_password && cfg.smtp_password !== SMTP_PASSWORD_MASK) {
    return { ...cfg, smtp_password: SMTP_PASSWORD_MASK };
  }
  return cfg;
}

// R158.35 — mask ad_bind_password on read. Same UX contract as
// smtp_password: real value (ciphertext) becomes the sentinel so the UI
// can't echo it back accidentally.
export function maskAdBindPasswordForRead(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  if (cfg.ad_bind_password && cfg.ad_bind_password !== AD_BIND_PASSWORD_MASK) {
    return { ...cfg, ad_bind_password: AD_BIND_PASSWORD_MASK };
  }
  return cfg;
}

// R158.35 — mask ad_ldap_url to drop any user:pass@ host segment. We don't
// currently embed creds in the URL (the bind is header-param), but a
// future config UI might let operators paste a full URL — strip the creds
// before echoing back so we don't accidentally leak them through a debug
// endpoint.
export function maskAdLdapUrlForRead(url) {
  if (!url || typeof url !== 'string') return '';
  return url.replace(/\/\/[^@/]*@/, '//');
}

export async function getConfig() {
  const db = getDb();
  const { rows } = await db.query(db.sql.config.getAll);
  const out = {};
  for (const row of rows) out[row.config_key] = row.config_value;
  return maskAdBindPasswordForRead(maskSmtpPasswordForRead(out));
}

export async function getConfigMap() {
  const db = getDb();
  const { rows } = await db.query(db.sql.config.getAll);
  const out = {};
  for (const row of rows) out[row.config_key] = row.config_value;
  return out;
}

// Returns the subset of system_config rows whose key is in `keys`. Always
// masks smtp_password for callers that don't pass through getConfig()
// (e.g. the test-mail route, which needs the real password to call
// email.send() — but the mask contract is documented; this helper enforces
// it for callers that don't need the real value). Callers that DO need the
// real password should read system_config directly.
//
// With no keys argument, returns the full table filtered through the same
// mask. SQL pushes the WHERE clause when keys are supplied so we don't
// round-trip rows that won't be used; the no-arg shape still scans the full
// table (callers that want everything use getConfig() instead).
export async function getConfigAll(keys = []) {
  const db = getDb();
  let rows;
  if (keys.length > 0) {
    const placeholders = keys.map(() => '?').join(',');
    ({ rows } = await db.query(
      `SELECT config_key, config_value FROM system_config WHERE config_key IN (${placeholders})`,
      keys
    ));
  } else {
    ({ rows } = await db.query(db.sql.config.getAll));
  }
  const out = {};
  for (const row of rows) out[row.config_key] = row.config_value;
  return maskAdBindPasswordForRead(maskSmtpPasswordForRead(out));
}

export async function setConfig(key, value) {
  const db = getDb();
  // R158.45.34 (2026-10-06) — dialect-aware updated_at:
  //   MySQL = UTC_TIMESTAMP(), MSSQL = SYSUTCDATETIME(). 之前写死 MySQL 语法,
  //   mssql 部署下报 "'UTC_TIMESTAMP' is not a recognized built-in function name"
  //   → 整个 setConfig 入口失效. 修: 走 db.dialect 分发, 不破坏 mysql 路径.
  const isMssql = db.dialect === 'mssql';
  const tsExpr = isMssql ? 'SYSUTCDATETIME()' : 'UTC_TIMESTAMP()';
  await db.execute(
    `UPDATE system_config SET config_value = ?, updated_at = ${tsExpr} WHERE config_key = ?`,
    [value == null ? null : String(value), key]
  );
}

// R158.X.99.28.b (2026-10-19) — Tx-scoped setConfig 批写. 走 db.transaction 包裹,
// 1 KV 写失败 → 整批 rollback, 0 必 DB 半写状态. 1:1 平行 `putConfigWithin`
// (line 130-132 既有) 范式 (复用同 db.transaction 入口 + tx.execute 路径).
//   修 F3 CRITICAL finding: 原 system-settings-v2.js L594-596 `setConfig` 2 KV
//   顺序写, 第 1 次 OK + 第 2 次失败 = DB 半写 (mcp_ip_whitelist 写了但
//   mcp_ip_whitelist_enabled 0 写, middleware cache invalidate 后 IP check
//   行为不一致). 改调此 helper, 1-click 修.
//
//   注: 不写 sys_config_audit 留痕 (走 setConfig audit 范式在调用方
//   writeAudit 后做, 跟 R158.45.34 1:1 平行).
//
//   R158.X.99.28.c (2026-10-22) — 改用 db.sql.config.upsert 而非裸 UPDATE.
//     真因 (操作员报「启用白名单 + 填 IP 保存, 重开页面 0 保存」): mcp_ip_whitelist
//     / mcp_ip_whitelist_enabled 这两个 KV **在 system_config 表里从来不存在**
//     (没有 seed 默认值), 而本helper 原来只发 UPDATE —— 匹配不到行时**静默 0 行
//     受影响, 0 报错**, `written` 又是自增计数器 (与实际影响行数无关) → 返回
//     {written:2} 看着像成功. 路由接着 writeAudit + res.json({ok:true}), 前端
//     显示"已保存", 刷新后 GET 读回来还是空.
//     audit_logs 里 2026-10-19 与 2026-10-22 各有一次 mcp_ip_whitelist
//     update_config 记录 (count:1, enabled:true) 但 DB 无对应行 = 同样静默失败.
//
//     修: 走 upsert (mysql ON DUPLICATE KEY UPDATE / mssql MERGE ... WHEN NOT
//     MATCHED THEN INSERT), 语义与 putConfigInTx (line 250) 对齐 —— 行不存在
//     则插入, 存在则更新. 首次保存也生效.
//     **lesson 163**: "写 KV" 不等于 "更新 KV". UPDATE-only helper 用在
//     没有 seed 的 key 上 = 静默 0 写; 而 written++ 这种自增计数会掩盖影响行数,
//     让 0 写看起来像成功. 要么用 upsert, 要么检查 affectedRows.
export async function setConfigBundle(patch) {
  const db = getDb();
  if (!patch || typeof patch !== 'object') return { written: 0 };
  const entries = Object.entries(patch);
  if (entries.length === 0) return { written: 0 };
  let written = 0;
  await db.transaction(async (tx) => {
    for (const [k, v] of entries) {
      await tx.execute(db.sql.config.upsert, [k, v == null ? null : String(v)]);
      written++;
    }
  });
  return { written };
}

// Applies a patch (object of key→value) to system_config, preserving the
// existing smtp_password when the patch value is empty or the masked
// sentinel. Audit rows are written inside the same transaction so the
// config-audit list always reflects what changed. Returns {auditCount}.
//
// Matches the contract used by PUT /api/admin/config (see admin.js): the UI
// sends the masked sentinel back on re-saves so we don't overwrite a real
// password with '********' on a partial-form re-save.
//
// `userId` is the caller's user id (or null). It's recorded as changed_by on
// every audit row inside the same transaction so the audit list reflects who
// made each change.
export async function putConfig(patch, userId = null) {
  const db = getDb();
  const auditRows = await db.transaction(async (tx) => putConfigInTx(tx, patch, userId));
  return { auditCount: auditRows.length };
}

// Tx-scoped putConfig — exposed for callers that need to add work inside the
// same transaction (e.g. PUT /api/admin/config bumps the listenPort pending
// version hash atomically with the row update). Returns the audit rows.
export async function putConfigWithin(tx, patch, userId = null) {
  return putConfigInTx(tx, patch, userId);
}

// Core putConfig logic. Strips masked/empty smtp_password (preserve-existing
// contract), redacts the password on the audit row so cleartext never lands
// in sys_config_audit, and pushes the change-detection through the same tx
// the caller opened.
async function putConfigInTx(tx, patch, userId) {
  const updates = { ...patch };
  // Strip masked/empty smtp_password — the caller didn't intend to change it.
  if ('smtp_password' in updates) {
    if (!updates.smtp_password || updates.smtp_password === SMTP_PASSWORD_MASK) {
      delete updates.smtp_password;
    }
  }
  // R158.35 — same contract for ad_bind_password. Sentinel or empty → keep
  // existing. Non-sentinel → encrypt before the row UPDATE so the
  // system_config table only ever holds ciphertext (AES-256-GCM, see
  // services/ad-directory-sync.js encryptBindPassword).
  if ('ad_bind_password' in updates) {
    if (!updates.ad_bind_password || updates.ad_bind_password === AD_BIND_PASSWORD_MASK) {
      delete updates.ad_bind_password;
    } else {
      try {
        // Read jwt_secret_current from the same snapshot so the
        // encryption key matches what resolveBindPassword will use at
        // tick time. Falls back to '' if absent — encryption will throw
        // and we surface the error to the caller (cleartext never lands
        // in the DB).
        const { rows: secRows } = await tx.query(
          `SELECT config_value FROM system_config WHERE config_key = 'jwt_secret_current'`
        );
        const jwtSecret = secRows[0]?.config_value || '';
        const secretKey = deriveSecretKey(process.env, jwtSecret);
        updates.ad_bind_password = encryptBindPassword(updates.ad_bind_password, secretKey);
      } catch (e) {
        throw Object.assign(
          new Error(`ad_bind_password encryption failed: ${e.message}`),
          { httpStatus: 500 }
        );
      }
    }
  }
  // Redact smtp_password from any audit row we write — the audit log stores
  // cleartext old_value/new_value by design, and T12 introduces the SMTP
  // password as a config value, so we must scrub it here to avoid persisting
  // credentials to sys_config_audit. The system_config row itself is updated
  // with the real value (the UI submitted it on purpose); only the audit
  // trail gets masked.
  const REDACTED = SMTP_PASSWORD_MASK;
  const AD_REDACTED = AD_BIND_PASSWORD_MASK;
  const auditRows = [];
  if (Object.keys(updates).length === 0) return auditRows;

  const db = getDb();
  const before = {};
  const { rows } = await tx.query(db.sql.config.getAll);
  for (const row of rows) before[row.config_key] = row.config_value;
  // #167 I1 Option B: reject legacy ad_agent_token writes. After I3
  // (dual-key agent-token rotation), the runtime source of truth is
  // `agent_token_current`, NOT the legacy `ad_agent_token` row that
  // ConfigView used to edit. Allowing PUT /api/admin/config to write
  // `ad_agent_token` was a dead-UI surface — operators saw their edit
  // succeed but the runtime auth never saw the new value. Operators
  // must now rotate via /api/admin/agent-token/rotate instead.
  //
  // The check fires only when the submitted value DIFFERS from the
  // current row — same-value writes (the UI sends back the entire
  // `current` object, including legacy rows it now displays as
  // read-only) are a no-op and don't need to trip the rejection. A
  // value-different write to a blocked key is what indicates an
  // operator actually tried to change it.
  const AGENT_TOKEN_BLOCKED_KEYS = ['ad_agent_token'];
  for (const k of AGENT_TOKEN_BLOCKED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(updates, k)) continue;
    const oldVal = before[k];
    const newVal = updates[k];
    if (String(oldVal ?? null) === String(newVal ?? null)) continue;
    throw Object.assign(
      new Error(
        `config key '${k}' is managed by /api/admin/agent-token/rotate ` +
        `(I3 dual-key rotation); legacy ConfigView UI is deprecated. ` +
        `Use curl -X POST <center>/api/admin/agent-token/rotate.`
      ),
      { httpStatus: 400, blockedKey: k }
    );
  }
  for (const [k, v] of Object.entries(updates)) {
    await tx.execute(
      db.sql.config.upsert,
      [k, v == null ? null : String(v)]
    );
    const oldVal = before[k] ?? null;
    const newVal = v == null ? null : String(v);
    if (String(oldVal) !== String(newVal)) {
      const auditOld = k === 'smtp_password' ? REDACTED
                     : k === 'ad_bind_password' ? AD_REDACTED
                     : oldVal;
      const auditNew = k === 'smtp_password' ? REDACTED
                     : k === 'ad_bind_password' ? AD_REDACTED
                     : newVal;
      await tx.execute(db.sql.config.audit.write, [k, auditOld, auditNew, userId, 'UPDATE']);
      auditRows.push({ key: k, old: auditOld, new: auditNew });
    }
  }
  return auditRows;
}

// Seed the SMTP-related defaults into system_config on first boot. Idempotent
// — when a row already exists (operator has touched it), the existing value
// is preserved. Each default only writes if the row is absent.
export async function seedSmtpDefaultsIfMissing(logger) {
  const db = getDb();
  const defaults = {
    smtp_host: '',
    smtp_port: '25',
    smtp_secure: 'false',
    smtp_user: '',
    smtp_password: '',
    smtp_from: '',
    alert_default_to: '',
    alert_default_cc: '',
    alert_eval_interval_seconds: '60',
    alert_email_max_attempts: '5',
    alert_email_initial_backoff_seconds: '30',
    // R158.16 (2026-10-01) — 邮件功能总开关. 默认 '0' (关闭). 关闭时:
    //   (a) system-alert-engine detector 跳过 system_alert_outbox.enqueue
    //       (system_alerts 表行仍写, 审计/UI 不受影响)
    //   (b) email.js tick() 顶部直接 return, 不 listPending, 不 SMTP
    // 双层防御: enqueue 路径省 DB 写, delivery 路径防御未来 enqueue 路径
    // 绕过开关 (例如测试 / 手动 INSERT). '1' = 启用, '0' = 禁用.
    // R158.68 — alert-engine 改 system-alert-engine; alert_email_outbox
    // 拆 system_alert_outbox + report_email_outbox.
    email_enabled: '0',
    // I4: audit retention policy. Default 90 days. Set to 0 to disable
    // (purgeOldAuditLogs treats <= 0 as "retention disabled" — see
    // services/audit.js). Read by createAuditRetentionLoop on every tick
    // so operators can change it without restarting the center.
    audit_retention_days: '90',
    // R158.46.30 (2026-10-06) — ad_management audit retention policy.
    // Operator directive 2026-10-06 "管理记录默认保留30天，但是支持在系统设置中修改，
    // 多一个字段AD管理日志保存时间". Default 30 days. 0 = disable.
    // Read by createAdMgmtAuditRetentionLoop on every tick (1h cadence) so
    // operators can tune via UI without restarting center. Scope = audit_logs
    //
    // R158.107 (2026-10-16) — 升级为中心端统一的 retention single source of
    //   truth. 8 个 retention service (audit / package_runs / email_history /
    //   report / ad_account_change / eventlog / member_eventlog /
    //   member_os_baseline / failed_logon) 全部改读此 key. file-push 保持
    //   独立 file_push_retention_days (任务数据 + 5min cadence + claim TTL
    //   双参数, 跟日志数据语义不同). 操作员 directive "后续所有数据保留周期
    //   都统一". R158.19 package_runs_retention_days 已 ship 撤回 (ConfigView
    //   删字段, R158.107 ship 时一次性 DELETE migration 移除 system_config
    //   4 旧 key rows: package_runs_retention_days / email_history_retention_days
    //   / report_retention_days / ad_account_change_retention_days).
    ad_mgmt_retention_days: '30',
    // Client + agent access domain. Empty means "use server IP" — the
    // GET /api/admin/config response carries serverIp (from utils/network.js
    // getPrimaryIPv4()) so ConfigView can render the resolved URL. Operators
    // set this when they want a friendly hostname (e.g. dashboard.corp.com)
    // instead of the server's raw IP. Affects both client app access AND
    // the agent centerUrl row in ConfigView.
    access_domain: ''
  };
  const { rows } = await db.query(db.sql.config.getAll);
  const existing = new Set(rows.map(r => r.config_key));
  let seeded = 0;
  for (const [k, v] of Object.entries(defaults)) {
    if (existing.has(k)) continue;
    await db.execute(db.sql.config.upsert, [k, v]);
    seeded++;
  }
  if (seeded > 0) {
    logger?.info?.({ seeded, keys: Object.keys(defaults) }, 'seeded SMTP defaults into system_config');
  }
  return { seeded, keys: Object.keys(defaults) };
}

// R158.61 (2026-10-10) — Daily / weekly email report defaults. Seeded
// alongside seedSmtpDefaultsIfMissing on first boot. Idempotent: when a
// row already exists the operator's value is preserved. Report emails
// piggyback on the SMTP transport configured by seedSmtpDefaultsIfMissing
// — this helper only sets the scheduler / recipient knobs.
//
// 9 keys:
//   report_daily_enabled        0|1     default 0 (off; operator must turn on)
//   report_daily_cron           cron    default "0 9 * * *" (09:00 CST daily)
//   report_daily_to             csv     default '' (falls back to alert_default_to)
//   report_daily_cc             csv     default ''
//   report_weekly_enabled       0|1     default 0
//   report_weekly_cron          cron    default "0 9 * * MON" (Mon 09:00 CST)
//   report_weekly_to            csv     default '' (falls back to alert_default_to)
//   report_weekly_cc            csv     default ''
//   report_loop_interval_seconds  int   default 300 (5min)
//   report_retention_days       int     default 30 (0 disables)
export async function seedReportsDefaultsIfMissing(logger) {
  const db = getDb();
  const defaults = {
    report_daily_enabled: '0',
    report_daily_cron: '0 9 * * *',
    report_daily_to: '',
    report_daily_cc: '',
    report_weekly_enabled: '0',
    report_weekly_cron: '0 9 * * MON',
    report_weekly_to: '',
    report_weekly_cc: '',
    report_loop_interval_seconds: '300',
    report_retention_days: '30'
  };
  const { rows } = await db.query(db.sql.config.getAll);
  const existing = new Set(rows.map(r => r.config_key));
  let seeded = 0;
  for (const [k, v] of Object.entries(defaults)) {
    if (existing.has(k)) continue;
    await db.execute(db.sql.config.upsert, [k, v]);
    seeded++;
  }
  if (seeded > 0) {
    logger?.info?.({ seeded, keys: Object.keys(defaults) }, 'seeded report defaults into system_config');
  }
  return { seeded, keys: Object.keys(defaults) };
}

// R158.100.C (2026-10-14) — AD 操作通知 (success/fail/timeout) defaults
//   into system_config. 5 key (1 套共享 6 kind 模板, 跟 R158.100.A 7 lesson
//   跟 R158.100.B 7 lesson 1:1 平行; 操作员决策 "1 套共享 5 key", 6 kind
//   共享 1 套模板 + 1 套收件人). 占位符 {{kind_label}} {{sam}} {{target}}
//   {{result}} {{result_label}} {{error}} {{operator}} {{time}} {{target_dc}}
//   {{task_id}} {{duration_ms}} {{has_password}} {{password_length}} (13 个).
//   模板不引用 password, 引用也空 (service 层 redact). emailEnabled 防御:
//   ad_notify_enabled='0' 关闭时, ad-notify.js enqueueAdNotify 直接 return,
//   0 INSERT. retention 跟 alert / report 1:1 平行走 email_history_retention_days
//   (30d), 不新增 retention config.
export async function seedAdNotifyDefaultsIfMissing(logger) {
  const db = getDb();
  const defaults = {
    ad_notify_enabled: '0',
    ad_notify_to: '',
    ad_notify_cc: '',
    ad_notify_subject_template: '[AD 操作通知] {{result_label}} — {{sam}}{{target}} — {{target_dc}}',
    ad_notify_body_template:
      '操作员 {{operator}} 在 {{time}} 于 {{target_dc}} 执行 AD 操作 {{kind_label}}\n' +
      '目标: {{sam}}{{target}}\n' +
      '结果: {{result_label}}\n' +
      'Task ID: {{task_id}}\n' +
      '耗时: {{duration_ms}}ms\n' +
      '错误: {{error}}'
  };
  const { rows } = await db.query(db.sql.config.getAll);
  const existing = new Set(rows.map(r => r.config_key));
  let seeded = 0;
  for (const [k, v] of Object.entries(defaults)) {
    if (existing.has(k)) continue;
    await db.execute(db.sql.config.upsert, [k, v]);
    seeded++;
  }
  if (seeded > 0) {
    logger?.info?.({ seeded, keys: Object.keys(defaults) }, 'seeded AD notify defaults into system_config');
  }
  return { seeded, keys: Object.keys(defaults) };
}

// R158.35 (2026-10-03) — AD LDAP sync defaults into system_config.
// Idempotent — when a row already exists the existing value is preserved.
// `ad_ldap_url` empty → sync disabled (the directory-sync-loop tick() and
// the POST /api/admin/directory-sync route both check this and short-circuit).
// `ad_sync_interval_minutes` default 60 (1h) matches the operator's mental
// model of "AD inventory doesn't change by the second".
// R158.46.1 (2026-10-06) — operator 改同步周期单位 小时→分钟. 旧 key
// `ad_sync_interval_hours` 由 migrateIntervalHoursToMinutes (本文件下方) 在
// boot 时一次性迁移, 这里只 seed 新 key 默认值.
export async function seedLdapDefaultsIfMissing(logger) {
  const db = getDb();
  const defaults = {
    ad_ldap_url: '',
    ad_bind_dn: '',
    ad_bind_password: '',
    ad_base_dn: '',
    ad_sync_interval_minutes: '60'
  };
  const { rows } = await db.query(db.sql.config.getAll);
  const existing = new Set(rows.map(r => r.config_key));
  let seeded = 0;
  for (const [k, v] of Object.entries(defaults)) {
    if (existing.has(k)) continue;
    await db.execute(db.sql.config.upsert, [k, v]);
    seeded++;
  }
  if (seeded > 0) {
    logger?.info?.({ seeded, keys: Object.keys(defaults) }, 'seeded LDAP defaults into system_config');
  }
  return { seeded, keys: Object.keys(defaults) };
}

// R158.AdminEmail (2026-10-15) — 管理员邮件通知收件人 KV.
//   操作员 directive 2026-10-15 "在系统配置中写入管理员邮件地址" + "暂时只针对
//   系统申请和激活操作发送邮件". 新建独立 config_key `admin_email` (跟 alert_default_to
//   / smtp_from / report_daily_to / ad_notify_to 同 precedent, 1:1 平行).
//   业务触发点 2 处: export-request 生成 license 申请单后 + activate license
//   成功后 (在 routes/system-settings-v2.js 末尾 fire-and-forget 调
//   enqueueLicenseNotify, 收件人 = getConfig('admin_email')).
//
//   默认值 = '' 空字符串 (T-5 决策, 跟 R158.69 SMTP config smtp_host/smtp_user
//   默认空 1:1 平行). 操作员首次进 "管理员邮件" tab 看到 "管理员邮件为空, license
//   通知将不会发送" 横幅, 显式填邮箱后生效. 0 触碰既有 4 个 seed 函数.
//
//   audit 留痕: 操作员后续 PUT /admin-email 端点调 setConfig + writeAudit
//   (跟其它 system_config key 1:1 平行), 这里 seed 阶段不写 audit (boot-time
//   写 50+ audit row 没意义). 1:1 平行 seedSmtpDefaultsIfMissing 范式 (line 242).
export async function seedAdminEmailDefaultIfMissing(logger) {
  const db = getDb();
  const defaults = {
    // R158.AdminEmail — 单值邮箱字符串. 操作员填写生效后, license 申请 / 激活
    // 自动发邮件到这里. 跟 alert_default_to (csv 允许多收件人) 不同, 这里
    // 业务语义是 "系统管理员本人" 单值.
    admin_email: ''
  };
  const { rows } = await db.query(db.sql.config.getAll);
  const existing = new Set(rows.map(r => r.config_key));
  let seeded = 0;
  for (const [k, v] of Object.entries(defaults)) {
    if (existing.has(k)) continue;
    await db.execute(db.sql.config.upsert, [k, v]);
    seeded++;
  }
  if (seeded > 0) {
    logger?.info?.({ seeded, keys: Object.keys(defaults) }, 'seeded admin email default into system_config');
  }
  return { seeded, keys: Object.keys(defaults) };
}
// 在 server.js seedLdapDefaultsIfMissing 之后调用一次. 非致命 (try/catch).
//
// R158.46.2 (2026-10-06) — H1 fix (CWE-367 TOCTOU): 整段 read → check →
// write 包进 db.transaction, tx 内 SELECT 拿 shared lock, 阻止双进程并发
// 读到同一老行后重复 UPDATE. 同时改为 DELETE 老行 + INSERT 新行 替代 PK
// 列 UPDATE, 复用 tx.sql.config.upsert (已是 dialect-aware INSERT-or-UPDATE
// factory, mysql ON DUPLICATE KEY UPDATE / mssql MERGE USING), 不写新 SQL.
// log 移到 tx 外, commit 失败时不误导操作员.
export async function migrateIntervalHoursToMinutes(logger) {
  const db = getDb();
  try {
    let result = { migrated: 0, droppedLegacy: 0 };
    await db.transaction(async (tx) => {
      // 1) 读老行 (tx 内, shared lock 防止并发 boot 双读到)
      const oldSel = `SELECT config_value FROM system_config WHERE config_key = ?`;
      const { rows: oldRows } = await tx.query(oldSel, ['ad_sync_interval_hours']);
      const oldRow = oldRows[0];
      if (!oldRow) {
        // 无老行, 啥都不做 (但要在 tx 内, 否则空 transaction 体会有歧义)
        return;
      }
      // 2) 检查新 key 是否已存在
      const { rows: newRows } = await tx.query(oldSel, ['ad_sync_interval_minutes']);
      if (newRows[0]) {
        // 新 key 已存在 (operator 已手改过), 只删老行
        await tx.execute(
          `DELETE FROM system_config WHERE config_key = ?`,
          ['ad_sync_interval_hours']
        );
        result.droppedLegacy = 1;
        return;
      }
      // 3) 老行 → 新行: 先 DELETE 老行, 再 INSERT 新行 (复用 tx.sql.config.upsert
      //    的 INSERT-or-UPDATE 语义, 但因为我们刚 DELETE 完, 它只会走 INSERT 路径)
      const oldVal = Number(oldRow.config_value);
      const newVal = Number.isFinite(oldVal) && oldVal > 0 ? Math.round(oldVal * 60) : 60;
      await tx.execute(
        `DELETE FROM system_config WHERE config_key = ?`,
        ['ad_sync_interval_hours']
      );
      await tx.execute(tx.sql.config.upsert, ['ad_sync_interval_minutes', String(newVal)]);
      result = { migrated: 1, oldVal, newVal, droppedLegacy: 1 };
    });
    // 4) tx 外 log (commit 成功后打印, 不误导操作员)
    if (result.migrated) {
      logger?.info?.({
        component: 'config-migration',
        fromHours: result.oldVal, toMinutes: result.newVal
      }, 'migrated ad_sync_interval_hours → ad_sync_interval_minutes');
    } else if (result.droppedLegacy) {
      logger?.info?.({ component: 'config-migration' },
        'ad_sync_interval_minutes already exists; dropped legacy row only');
    } else {
      logger?.info?.({ component: 'config-migration' },
        'no legacy ad_sync_interval_hours row; skip');
    }
    return result;
  } catch (e) {
    logger?.warn?.({ component: 'config-migration', err: e?.message },
      'interval hours→minutes migration failed; non-fatal');
    return { migrated: 0, droppedLegacy: 0, error: e.message };
  }
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
    heartbeatIntervalSeconds: Number(all.heartbeat_interval_seconds || 30),
    discoveryIntervalHours: Number(all.discovery_interval_hours || 4),
    agentToken: all.agent_token ?? null,
    heartbeatPort: Number(all.heartbeat_port) || 8081,
    reportPort: Number(all.report_port) || 8082,
    heartbeatStaleSeconds: Number(all.heartbeat_stale_seconds) || 15
  };
}

// Returns `{ listenPort: <bool> }` indicating whether the running center's
// bound web port is out of sync with what the operator saved via the UI.
//
// Two system_config rows drive the answer:
//   - center_listen_port_started_version: written by the bootstrap IIFE in
//     server.js immediately before buildServerApps, hashed from
//     `nowIso + ':' + listenPort`. Reflects the port currently bound.
//   - center_listen_port_pending_version: written by the PUT /api/admin/config
//     route inside the same transaction as the listenPort UPDATE; reflects
//     the value the operator just saved.
//
// When the operator saves a new listenPort, pending and started diverge.
// The ConfigView (Task 6) uses this to render a "重启生效" badge. We only
// report true when BOTH rows are present and differ — fresh installs (no
// pending save) and uncommitted changes return false so the badge stays
// quiet.
export async function restartRequired() {
  const db = getDb();
  const { rows } = await db.query(
    `SELECT config_key, config_value FROM system_config
     WHERE config_key IN ('center_listen_port_pending_version', 'center_listen_port_started_version')`
  );
  const map = Object.fromEntries(rows.map(r => [r.config_key, r.config_value]));
  const pending = map.center_listen_port_pending_version ?? null;
  const started = map.center_listen_port_started_version ?? null;
  return {
    listenPort: pending != null && started != null && pending !== started
  };
}