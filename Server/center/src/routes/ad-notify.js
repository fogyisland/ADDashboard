// R158.100.C (2026-10-14) — AD 操作通知 admin endpoint.
//   单 endpoint (跟 email-history 1:1 平行):
//   POST /api/admin/ad-notify/preview
//     拿当前 cfg + 13 占位符 (用 sample mock values 替) → 渲染 subject +
//     body_text → 返 { subject, body_text, body_html } 供 EmailConfigView
//     "预览通知" 按钮用. operator 0 必真发邮件, 仅在 UI 弹个 modal 看渲染结果.
//   鉴权: [userAuth, requirePerm('admin:config')] 跟 email-history / reports
//   1:1. 0 改 email-history / reports / system-alerts 既有的 route.

import express from 'express';
import { getConfig } from '../services/config.js';

export function createAdNotifyRouter({ db: _db, requireAuth, requirePerm }) {
  const router = express.Router();
  const guard = [requireAuth, requirePerm('admin:config')];

  // 6 kind 共享 1 套 (operator decision). 预览时 mock 1 个 user_create
  // 成功 + 1 个 user_password_reset 失败作为 sample, 跟 daily preview 1:1.
  router.post('/api/admin/ad-notify/preview', guard, async (_req, res) => {
    try {
      const cfg = await getConfig();
      // 12 占位符 mock values (跟 ad-notify.js placeholders 字典 1:1).
      // 13 个里 password_length 也包含, 但 password 永不进 placeholders
      // (service 层 redact). preview 这里给 mock "12" 让 operator 看到
      // 模板里 {{password_length}} 渲染成 "12".
      const placeholders = {
        kind_label: '创建用户',
        sam: 'sample.smith',
        target: '',
        result: 'success',
        result_label: '成功',
        error: '',
        operator: 'admin',
        time: new Date().toISOString(),
        target_dc: 'KDLOFADSRV1',
        task_id: 'KDLOFADSRV1-20261014153000000',
        duration_ms: '1234',
        has_password: '是',
        password_length: '12'
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
      const render = (tpl) => tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => {
        const v = placeholders[k];
        return v == null ? '' : String(v);
      });
      const subject = render(subjectTpl);
      const bodyText = render(bodyTpl);
      const bodyHtml = `<pre style="font-family: monospace; font-size: 12px;">${bodyText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`;
      res.json({ subject, body_text: bodyText, body_html: bodyHtml });
    } catch (err) {
      res.status(500).json({ error: 'preview failed', detail: err.message });
    }
  });

  return router;
}
