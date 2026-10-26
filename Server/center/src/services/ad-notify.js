// R158.100.C (2026-10-14) — AD 操作通知 service.
//   当 6 类 AD 操作 (user_create / group_create / ou_create / user_password_reset /
//   user_enable / user_disable) completeCommand / sweepTimeouts 触发时, 读
//   system_config 5 key (enabled / to / cc / subject_template / body_template),
//   渲染模板 (13 占位符), 写 ad_notify_outbox 表. 5min cadence emailLoop
//   (createEmailDeliveryLoop UNION 3 表) 自动投递.
//
// 6 critical (R158.100.C):
//   1. password cleartext 持久化风险: 2 类 AD 操作 (user_create / user_password_reset)
//      涉密码. 模板渲染前, service 层 hardcode redacted — 模板不引用 password
//      也能拿 0 cleartext. params.password / newPassword 永远不进占位符 dict.
//   2. system_config key 加在 seed*DefaultsIfMissing 函数, 不是 SQL migration
//      (R158.51 baseline freeze). 但 新建物理表 ad_notify_outbox 走 scripts/
//      手动跑, 跟 R158.100 / R158.78 / R158.79 等所有 R 系列新表 1:1 平行.
//   3. fire-and-forget 不能抛: enqueueAdNotify 任何 throw (db 失败 / config 缺失
//      / template 渲染失败) 必 catch + log, 永不让 completeCommand 整体 500.
//      模式跟 sweepTimeouts audit write 1:1 平行 (ad-admin-commands.js:608-611).
//   4. 不节流: system-alert-engine NOTIFY_THROTTLE_MINUTES=30 是内置告警用,
//      跟 AD 操作通知语义不同. AD 操作罕见, 30min 节流 = 操作员等 30min 知道
//      密码重置完了. ad_notify 通道每 command 必发.
//   5. R158.51 baseline freeze + scripts/ 路径: ad_notify_outbox 走 scripts/
//      手动跑 (R158.100.A / R158.100.B / R158.78 等 precedent 1:1 平行).
//      跟 db/migrations/ auto-migration 0 关系 (项目当前 0 走 auto).
//   6. emailLoop UNION 3 表扩展 1 表 (system_alert + report + ad_notify),
//      capacity 1/3 each. _outboxTable tag 决定 markSent/markFailed 走哪表.

import { getDb } from '../db/index.js';
import { getConfig } from './config.js';

// ── 6 kind 中文 label (UI 跟 service 同源, 改 1 处双生效) ────────────────
const KIND_LABEL = {
  user_create: '创建用户',
  user_password_reset: '重置密码',
  user_enable: '启用用户',
  user_disable: '禁用用户',
  group_create: '创建组',
  ou_create: '创建 OU'
};

const STATUS_LABEL = {
  success: '成功',
  failed: '失败',
  timeout: '超时'
};

// ── 模板渲染 helpers ─────────────────────────────────────────────────────
// R158.100.C lesson 6: renderTemplate 用正则 `\{\{(\w+)\}\}` 不匹配时原样输出
// `{{sam` 等字串, 邮件可读但有错位. 不是错误, 是 best-effort 渲染.
function renderTemplate(tpl, vars) {
  if (!tpl) return '';
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (m, k) => {
    const v = vars[k];
    return v == null ? '' : String(v);
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── 抽 target (sam / name) 跟 params 形态 ────────────────────────────────
// params 形态跨 6 kind 不一致: user_create 有 sam, group_create / ou_create 有
// name. 这里抽 2 个独立字段 sam + target 跟 template 占位符 1:1.
function extractTargetFields(commandType, params) {
  const sam = params?.sam || params?.userName || '';
  const target = params?.name || params?.groupName || params?.ouName || '';
  return { sam, target };
}

// ── password redaction (L1 防线, 跟 ad-admin-commands.js:396 同 precedent) ──
// R158.100.C lesson 1: outbox.body_text 永久持久化 (retention 30d), redact 漏洞
// = cleartext 在 DB 留存 30d. 这里 service 层 hardcode 计算 has_password /
// password_length 占位符, password 字段永远不写进 placeholders dict.
function computePasswordMeta(params) {
  const pwd = params?.password || params?.newPassword;
  if (!pwd) return { hasPassword: false, passwordLength: null };
  return { hasPassword: true, passwordLength: String(pwd).length };
}

// ── 解析 operator 显示名 (best-effort, 失败不抛) ──────────────────────────
async function resolveOperatorName(operatorId) {
  if (operatorId == null) return '';
  try {
    const db = getDb();
    const sql = db.dialect === 'mssql'
      ? 'SELECT TOP 1 display_name, username FROM users WHERE id = ?'
      : 'SELECT display_name, username FROM users WHERE id = ? LIMIT 1';
    const { rows } = await db.query(sql, [Number(operatorId)]);
    const r = Array.isArray(rows) ? rows[0] : null;
    return r?.display_name || r?.username || String(operatorId);
  } catch {
    return String(operatorId);
  }
}

// ── 主入口: enqueueAdNotify ──────────────────────────────────────────────
// 必 fire-and-forget 调 (call site catch + log). 失败永不让 completeCommand 500.
export async function enqueueAdNotify({
  commandId, commandType, targetDc, target, status,
  operatorId, taskId, durationMs, errorMessage, params
}) {
  try {
    const db = getDb();
    const cfg = await getConfig();
    // L1 防御: enabled=0 / to 空 → 整个函数 skip, 0 INSERT.
    if (String(cfg?.ad_notify_enabled ?? '0') !== '1') return;
    const to = String(cfg?.ad_notify_to || '').trim();
    if (!to) {
      // ad_notify 启用但 to 字段空 — skip (跟 system_alert engine precedent 1:1)
      return;
    }

    // 13 占位符 (跟 plan 表格 1:1). password 永远不写进 dict (L1 redact).
    const { sam, target: targetName } = extractTargetFields(commandType, params || {});
    const { hasPassword, passwordLength } = computePasswordMeta(params || {});
    const operatorName = await resolveOperatorName(operatorId);
    const placeholders = {
      kind_label: KIND_LABEL[commandType] || commandType || 'AD 操作',
      sam,
      target: targetName,
      result: status || '',
      result_label: STATUS_LABEL[status] || status || '',
      error: errorMessage || '',
      operator: operatorName,
      time: new Date().toISOString(),
      target_dc: targetDc || '',
      task_id: taskId || '',
      duration_ms: durationMs != null ? String(durationMs) : '',
      has_password: hasPassword ? '是' : '',
      password_length: passwordLength != null ? String(passwordLength) : ''
    };
    const subjectTpl = String(cfg?.ad_notify_subject_template || '[AD 操作通知] {{result_label}} — {{sam}}{{target}} — {{target_dc}}');
    const bodyTpl = String(cfg?.ad_notify_body_template ||
      '操作员 {{operator}} 在 {{time}} 于 {{target_dc}} 执行 AD 操作 {{kind_label}}\n' +
      '目标: {{sam}}{{target}}\n' +
      '结果: {{result_label}}\n' +
      'Task ID: {{task_id}}\n' +
      '耗时: {{duration_ms}}ms\n' +
      '错误: {{error}}'
    );
    const subject = renderTemplate(subjectTpl, placeholders);
    const bodyText = renderTemplate(bodyTpl, placeholders);
    const bodyHtml = `<pre style="font-family: monospace; font-size: 12px;">${escapeHtml(bodyText)}</pre>`;

    // next_attempt_at = now (5min cadence emailLoop 下一拍就发). max_attempts
    // 跟 alert / report 1:1 平行 (5 attempts, 30s initial backoff × 2n).
    const nextAttempt = new Date();
    await db.execute(db.sql.adNotifyOutbox.enqueue, [
      commandId ?? null,
      to,
      cfg?.ad_notify_cc || null,
      subject,
      bodyText,
      bodyHtml,
      nextAttempt,
      5
    ]);
  } catch (e) {
    // L1 防御: throw 永不让 caller (completeCommand / sweepTimeouts) 整体 500.
    // lifecycle 已 UPDATE, 通知是 best-effort 补充. log + swallow.
    // 跟 system-alert-engine.js:352 console.error 形态 1:1 平行.
    console.error('[ad-notify] enqueue failed:', e?.message, { commandId, status });
  }
}
