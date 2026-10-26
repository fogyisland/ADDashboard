// center/src/routes/email-history.js
// R158.69 (2026-10-10) — 邮件历史 admin endpoint. UNION ALL 查 system_alert_outbox
// + report_email_outbox 两张物理表 (operator 决策 "不建新表"). 默认 30 天.
//
//   GET /api/admin/email-history?days=30&kind=all&limit=200
//     days   : 1..180 (cap 180 天)
//     kind   : 'all' | 'alert' | 'report'
//     limit  : 1..500 (cap 500)
//
// 鉴权: [userAuth, requirePerm('admin:config')], 跟 reports.js 同 posture.
// 不改 system-alerts.js / reports.js (operator "用到端点新建" 指令).

import express from 'express';

export function createEmailHistoryRouter({ db, requireAuth, requirePerm }) {
  const router = express.Router();
  const guard = [requireAuth, requirePerm('admin:config')];

  // GET /api/admin/email-history?days=30&kind=all&limit=200
  router.get('/api/admin/email-history', guard, async (req, res) => {
    // Input validation. Cap days at 180 (6 month), limit at 500 (UI 简单表用).
    // kind whitelist = 'all' / 'alert' / 'report'. bad input falls back to default.
    const days = Math.max(1, Math.min(180, Number(req.query.days) || 30));
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
    const kind = (req.query.kind === 'alert' || req.query.kind === 'report') ? req.query.kind : 'all';

    try {
      // db.sql.emailHistory 在 buildSql(dialect) 已经按 dialect 选定, 直接拿
      // helper (跟 system-alerts.js:51 db.sql.systemAlerts.listFiring 同模式,
      // R158.42 design). 不再 helperSet[db.dialect] 二层分发 (那是错实现,
      // buildSql 注入时就已经是 .mysql 或 .mssql, 再分发会让 helperSet.mssql
      // undefined → "Cannot read properties of undefined").
      const helperSet = db.sql.emailHistory;
      if (!helperSet) {
        res.status(500).json({ error: 'email-history helper missing for current dialect' });
        return;
      }
      const sql = helperSet.listSent(days, limit);
      const params = db.dialect === 'mssql' ? [days, days, limit] : [days, days, limit];
      const result = await db.execute(sql, params);
      // mysql: result.rows. mssql (driver wrapper): result.rows (recordset).
      const rawRows = result?.rows ?? result?.recordset ?? [];

      // 客户端 kind 过滤: 服务端 UNION ALL 已返两类, 这里 filter 出 UI 要的.
      // source = 'alert' / 'report' (SQL helper 填).
      const filtered = kind === 'all' ? rawRows : rawRows.filter((r) => r.source === kind);

      res.json({
        rows: filtered,
        count: filtered.length,
        days,
        kind,
        limit,
      });
    } catch (err) {
      res.status(500).json({ error: 'email-history query failed', detail: err.message });
    }
  });

  // R158.100.A (2026-10-14) — 单行详情 endpoint (EmailConfigView drawer 用).
  //   GET /api/admin/email-history/:source/:id
  //     source ∈ {'alert', 'report'} (whitelisted, 防 SQL injection 拼路径)
  //     id     正整数
  //   返回 { row: { ...all_fields..., source } } (200) / 400 / 404 / 500.
  //   鉴权跟 list 同 (requireAuth + admin:config).
  //   单行查 1 张表 (alert → system_alert_outbox, report → report_email_outbox),
  //   不走 UNION (操作员决策, 1 helper 1 表最直接).
  //   alert 表无 created_at 列 (schema verify 确认), report 表有; 不对称处理.
  router.get('/api/admin/email-history/:source/:id', guard, async (req, res) => {
    const source = req.params.source;
    if (source !== 'alert' && source !== 'report') {
      res.status(400).json({ error: 'invalid source (must be alert|report)' });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'invalid id (must be positive integer)' });
      return;
    }

    try {
      const helperSet = db.sql.emailHistory;
      if (!helperSet) {
        res.status(500).json({ error: 'email-history helper missing for current dialect' });
        return;
      }
      const sql = source === 'alert' ? helperSet.detailAlertById : helperSet.detailReportById;
      const result = await db.execute(sql, [id]);
      const rawRows = result?.rows ?? result?.recordset ?? [];
      if (rawRows.length === 0) {
        res.status(404).json({ error: 'row not found', source, id });
        return;
      }
      // source 在后端注入, 前端不可信
      res.json({ row: { ...rawRows[0], source } });
    } catch (err) {
      res.status(500).json({ error: 'email-history detail query failed', detail: err.message });
    }
  });

  return router;
}