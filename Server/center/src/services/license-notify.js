// R158.AdminEmail (2026-10-15) — License 通知 service.
//   操作员 directive 2026-10-15 "暂时只针对系统申请和激活操作发送邮件".
//   收件人 = system_config.admin_email (新 KV, 走 getConfig 入口).
//   业务触发点 2 处 (调用方在 routes/system-settings-v2.js):
//     (a) exportLicenseRequest 末尾 (生成 license 申请单后)
//     (b) activateLicense 末尾 (激活 license 成功后)
//
// 跟 R158.100.C enqueueAdNotify (ad-notify.js) 1:1 平行:
//   1. read system_config.admin_email → 空字符串早返 + writeAudit skip log
//   2. read admin_email + 渲染 subject/body 模板
//   3. INSERT license_email_outbox (走 db.sql.licenseEmailOutbox.enqueue)
//   4. emailLoop 5min cadence 自动投递 (走 createEmailDeliveryLoop UNION 4 表)
//   5. 任何 throw → catch + log, 永不让 caller (export-request / activate) 整体 500
//
// 跟 enqueueAdNotify 关键差异:
//   - 收件人: admin_email (单值, 跟 ad_notify_to csv 允许多收件人不同)
//   - 不节流: 操作员 directive 没说要节流, 申请 / 激活罕见, 0 节流
//   - 0 依赖 agent: license 流程是中心端逻辑, 0 触碰 agent / R158.69 / R158.88
//   - deactivation 不发: T-4 决策, deactivate 端点 0 调本函数

import { getDb } from '../db/index.js';
import { getConfig } from './config.js';
import { writeAudit } from './audit.js';

// ── 6 kind 中文 label (跟 service 同源, 改 1 处双生效) ─────────────────
// R158.LA (2026-10-15) — 加 2 新 kind:
//   license_request_created — 5 段 base32 申请单生成 (跟 ADSPK license_request 同 label 但分 kind)
//   license_activated_base32 — 5 段 base32 license 激活 (跟 ADSPK license_activated 分 kind, 邮件正文带 request_id)
//
// R158.License-expiry (2026-10-15) — 加 2 新 kind (expiry scheduler 触发, fire-and-forget):
//   license_expiring_soon — active → expiring_soon 切换时 1 封 (30 天内到期预警)
//   license_expired       — * → expired 切换时 1 封 (已到期通知)
//   跟 4 既有 kind 1:1 平行 shape, 0 触碰既有 audit action 映射.
const KIND_LABEL = {
  license_request: 'License 申请单已生成',
  license_activated: 'License 已激活',
  license_request_created: '5 段 base32 License 申请单已生成',
  license_activated_base32: '5 段 base32 License 已激活',
  license_expiring_soon: 'License 即将到期',
  license_expired: 'License 已到期'
};

// ── 模板渲染 (跟 enqueueAdNotify 1:1 平行, 简单字符串模板) ─────────────
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

// ── 主入口: enqueueLicenseNotify ──────────────────────────────────────
// 必 fire-and-forget 调 (call site 用 `void enqueueLicenseNotify(...)` 0 await).
// 失败永不让 export-request / activate 端点 500.
//
// params:
//   kind: 'license_request' | 'license_activated'
//   payload: { ... } 业务参数 (license_id / company / mac / months / maxNodes
//             / expires_at / hash_prefix / requestText / instanceId 等)
export async function enqueueLicenseNotify({ kind, payload }) {
  try {
    if (!kind || !KIND_LABEL[kind]) {
      console.error('[license-notify] unknown kind:', kind);
      return;
    }

    const db = getDb();
    const cfg = await getConfig();

    // L1 防御: admin_email 空 → 整个函数 skip, 0 INSERT.
    // 跟 enqueueAdNotify (ad_notify_to 空 skip) 1:1 平行.
    // 不写 sys_config_audit (操作员没改 config, 只是 skip), 仅 console.error
    // 留 trace, 跟 R158.69 alert 节流 skip 行为 1:1 平行.
    const to = String(cfg?.admin_email || '').trim();
    if (!to) {
      console.error('[license-notify] skipped: admin_email not configured', { kind, hasPayload: !!payload });
      return;
    }

    // 渲染 subject + body
    const placeholders = {
      kind_label: KIND_LABEL[kind],
      company: payload?.company || '',
      mac: payload?.mac || '',
      months: payload?.months != null ? String(payload.months) : '',
      max_nodes: payload?.maxNodes != null ? String(payload.maxNodes) : '',
      installed_at: payload?.installedAt || payload?.installed_at || '',
      signature: payload?.signature || '',
      instance_id: payload?.instanceId || payload?.instance_id || '',
      license_id: payload?.licenseId || payload?.license_id || '',
      expires_at: payload?.expiresAt || payload?.expires_at || '',
      hash_prefix: payload?.hashPrefix || payload?.hash_prefix || '',
      request_id: payload?.requestId || payload?.request_id || '',
      request_text: payload?.requestText || payload?.request_text || '',
      time: new Date().toISOString()
    };

    const subject = renderTemplate(
      `[AD Center] ${KIND_LABEL[kind]} — instance_id={{instance_id}}`,
      placeholders
    );

    // body_text: license_request 包含 requestText (申请单 JSON); license_activated
    // 包含 6 字段摘要. 操作员复制发邮件完整, 不漏字段.
    // R158.LA — license_activated_base32 多 1 行 Request ID, 方便操作员关联
    //   申请单 + 激活事件; license_request_created 跟 license_request 共用 body
    //   (同 JSON 申请单, 跟 R158.LA plan D10 1:1 平行).
    //
    // R158.License-expiry (2026-10-15) — 加 2 分支:
    //   license_expiring_soon — 30 天内到期预警, 提示操作员尽快申请续期
    //   license_expired       — 已到期通知, 提示操作员立即申请续期 (系统会限制 admin 登录)
    //   2 模板共用 5 占位符 (days_remaining / expires_at / instance_id / license_id / time),
    //   跟前 4 kind 共用 placeholders dict, 0 改既有渲染管线.
    let bodyText;
    if (kind === 'license_expiring_soon') {
      bodyText =
        `系统检测到 License 即将到期, 请尽快申请续期\n` +
        `\n` +
        `剩余天数: {{days_remaining}} 天\n` +
        `到期时间: {{expires_at}}\n` +
        `实例 ID: {{instance_id}}\n` +
        `License ID: {{license_id}}\n` +
        `检测时间: {{time}}\n` +
        `\n` +
        `本邮件由 AD Center 5min cadence cron 自动发送 (R158.License-expiry).\n` +
        `请进入系统设置 → License → 申请 / 录入激活 tab 完成续期.\n` +
        `\n` +
        `本邮件由 AD Center 系统自动发送, 无需回复.`;
    } else if (kind === 'license_expired') {
      bodyText =
        `系统检测到 License 已到期, 请立即申请续期\n` +
        `\n` +
        `已过天数: {{days_remaining}} 天 (负数表示已过期)\n` +
        `到期时间: {{expires_at}}\n` +
        `实例 ID: {{instance_id}}\n` +
        `License ID: {{license_id}}\n` +
        `检测时间: {{time}}\n` +
        `\n` +
        `注意: 系统将在到期后限制管理员登录, 但已激活功能保持正常.\n` +
        `本邮件由 AD Center 5min cadence cron 自动发送 (R158.License-expiry).\n` +
        `请进入系统设置 → License → 申请 / 录入激活 tab 完成续期.\n` +
        `\n` +
        `本邮件由 AD Center 系统自动发送, 无需回复.`;
    } else if (kind === 'license_request' || kind === 'license_request_created') {
      bodyText =
        `操作员在 {{time}} 于本中心触发了 License 申请单生成\n` +
        `\n` +
        `公司名称: {{company}}\n` +
        `Mac 地址: {{mac}}\n` +
        // R158.X.99.30 (2026-10-19) — 周期单位月→年 (操作员 directive D1+D2)
        `申请使用时间: {{months}} 年\n` +
        `节点数: {{max_nodes}}\n` +
        `安装时间: {{installed_at}}\n` +
        `Signature: {{signature}}\n` +
        `实例 ID: {{instance_id}}\n` +
        `Request ID: {{request_id}}\n` +
        `\n` +
        `--- 完整申请单 JSON ---\n` +
        `{{request_text}}\n` +
        `\n` +
        `本邮件由 AD Center 系统自动发送, 无需回复.`;
    } else if (kind === 'license_activated_base32') {
      bodyText =
        `操作员在 {{time}} 于本中心激活了 5 段 base32 License\n` +
        `\n` +
        `License ID: {{license_id}}\n` +
        `Hash prefix: {{hash_prefix}}\n` +
        `Request ID: {{request_id}}\n` +
        `到期时间: {{expires_at}}\n` +
        `实例 ID: {{instance_id}}\n` +
        `\n` +
        `本邮件由 AD Center 系统自动发送, 无需回复.`;
    } else {
      // license_activated
      bodyText =
        `操作员在 {{time}} 于本中心激活了 License\n` +
        `\n` +
        `License ID: {{license_id}}\n` +
        `Hash prefix: {{hash_prefix}}\n` +
        `到期时间: {{expires_at}}\n` +
        `实例 ID: {{instance_id}}\n` +
        `\n` +
        `本邮件由 AD Center 系统自动发送, 无需回复.`;
    }
    bodyText = renderTemplate(bodyText, placeholders);
    const bodyHtml = `<pre style="font-family: monospace; font-size: 12px;">${escapeHtml(bodyText)}</pre>`;

    // next_attempt_at = now (5min cadence emailLoop 下一拍就发). max_attempts
    // 跟 alert / report / ad_notify 1:1 平行 (5 attempts, 30s initial backoff × 2n).
    const nextAttempt = new Date();

    // license_id: license_request 时为 null (申请单无 license row),
    //             license_activated 时为新激活行 id,
    //             license_expiring_soon / license_expired 时为当前 active row id.
    let licenseId = null;
    if (kind === 'license_activated' || kind === 'license_activated_base32') {
      licenseId = Number(placeholders.license_id) || null;
    } else if (kind === 'license_expiring_soon' || kind === 'license_expired') {
      // R158.License-expiry — scheduler 透传 license_id (当前 active row id).
      licenseId = Number(payload?.licenseId || payload?.license_id || 0) || null;
    }

    await db.execute(db.sql.licenseEmailOutbox.enqueue, [
      licenseId,
      to,
      null,  // cc_addrs: 本轮 0 接 cc, 下轮 R158.License-activation 视情况
      subject,
      bodyText,
      bodyHtml,
      nextAttempt,
      5
    ]);

    // 写 audit (跟 R158.100.C enqueueAdNotify 不写 audit 略不同 — license
    // 通知业务关键, 走 audit trail 便于操作员查 "谁触发了 license 邮件").
    // kind 不同 = 不同 audit 类目, 跟 R158.100.C 'ad_notify' 垂直切分 (L5).
    try {
      // R158.LA (2026-10-15) — 加 2 新 kind audit action: license_notify_request_created /
      //   license_notify_activated_base32. 跟 audit-classifier 不强制注册 (本函数
      //   写 audit 用 4 action 总集合, 缺的走默认 'ops'/'low', 0 必填).
      //   4 kind 全部显式映射, 跟原有 2 1:1 平行.
      //
      // R158.License-expiry (2026-10-15) — 加 2 新 kind audit action:
      //   license_notify_expiring_soon / license_notify_expired. 跟前 4 1:1 平行.
      const auditAction = kind === 'license_request' ? 'license_notify_request'
                       : kind === 'license_request_created' ? 'license_notify_request_created'
                       : kind === 'license_activated_base32' ? 'license_notify_activated_base32'
                       : kind === 'license_expiring_soon' ? 'license_notify_expiring_soon'
                       : kind === 'license_expired' ? 'license_notify_expired'
                       : 'license_notify_activated';
      await writeAudit({
        userId: null,  // 系统自动触发, 0 user
        action: auditAction,
        target: 'license_email_outbox',
        payload: {
          kind,
          to,
          license_id: licenseId,
          // payload cap 防 16KB (R158.X Plan L-10 lesson, 本函数最大 payload
          // 是 license_request 时的 requestText, JSON.stringify < 4KB OK)
          summary: {
            company: placeholders.company,
            mac: placeholders.mac,
            months: placeholders.months,
            max_nodes: placeholders.max_nodes
          }
        }
      }, null /* logger 走 writeAudit 内部 */);
    } catch (auditErr) {
      // best-effort: audit 失败不阻塞 enqueue 主流程
      console.error('[license-notify] audit write failed:', auditErr?.message);
    }
  } catch (e) {
    // L1 防御: throw 永不让 caller (export-request / activate) 整体 500.
    // 跟 enqueueAdNotify ad-notify.js:165 1:1 平行.
    console.error('[license-notify] enqueue failed:', e?.message, { kind, hasPayload: !!payload });
  }
}
