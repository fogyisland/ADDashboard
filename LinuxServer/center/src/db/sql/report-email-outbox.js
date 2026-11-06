// SQL helpers for the report_email_outbox table (R158.68).
// R158.61 报表邮件 (kind='report') 从 alert_email_outbox 拆出, 物理独立.
// 跟 system_alert_outbox 几乎同 shape, 但:
//   - FK 用 report_id (→ daily_reports.id), 不是 alert_id
//   - kind 列 = 'daily' / 'weekly' (区分 2 种报表, 不再是 alert/report 二分)
//   - 8 参 enqueue (跟 alertOutbox R158.62 同 shape, R158.68 改写向新表)
//
// services/reports.js 改点: db.sql.alertOutbox.enqueue → db.sql.reportEmailOutbox.enqueue
//   params: [null/report_id, to, cc, subject, text, html, nextAttempt, 'daily'/'weekly']

export const reportEmailOutbox = {
  mysql: {
    enqueue: `INSERT INTO report_email_outbox
      (report_id, to_addrs, cc_addrs, subject, body_text, body_html, next_attempt_at, kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,

    // R158.100-fix (2026-10-14) — 加 attempt_count < max_attempts 过滤 (见 system-alert-outbox.js 同注释).
    //   这个 fix 是 R158.69 50 个 pending 报告邮件 outbox 的核心修:
    //   1. 老 15 行 (id 7,10~15,22,28,29,34,35,36) 走 SSL "wrong version number"
    //      错误历史 + scheduleRetry exhausted path 不动 next_attempt_at, 让
    //      attempt_count 涨到 2700+, 永远排 listPending 前面.
    //   2. 新 37 行 (id 38+) 因老行卡 LIMIT 25 永远排不上, 累积到 10/14.
    //   3. 加 attempt_count < max_attempts 过滤后, 老 15 行直接跳过, 解放 LIMIT.
    //      新 37 行能进 listPending, 等下次 deliver.
    listPending: `SELECT id, report_id, to_addrs, cc_addrs, subject, body_text, body_html,
                         attempt_count, max_attempts, next_attempt_at, last_error, sent_at, kind
                  FROM report_email_outbox
                  WHERE sent_at IS NULL
                    AND next_attempt_at <= UTC_TIMESTAMP(3)
                    AND attempt_count < max_attempts
                  ORDER BY next_attempt_at ASC, id ASC
                  LIMIT ?`,

    markSent: `UPDATE report_email_outbox SET sent_at = UTC_TIMESTAMP(3), attempt_count = attempt_count + 1, last_error = ?
               WHERE id = ?`,

    markFailed: `UPDATE report_email_outbox SET attempt_count = attempt_count + 1, last_error = ?
                 WHERE id = ?`,

    // R158.100-fix (2026-10-14) — markExhausted 双层防御 (见 system-alert-outbox.js 同注释).
    markExhausted: `UPDATE report_email_outbox SET next_attempt_at = '9999-12-31 23:59:59'
                    WHERE id = ?`,

    scheduleRetry: `UPDATE report_email_outbox SET next_attempt_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND)
                    WHERE id = ?`,

    // R158.61 reports.js finish update 用: UPDATE daily_reports SET outbox_id=?, status=?, last_error=?, html_size=? WHERE id=?
    // 该 SQL 走 db.sql.reportRun.finish (R158.61 已 ship, R158.68 不动)
  },
  mssql: {
    enqueue: `INSERT INTO report_email_outbox
      (report_id, to_addrs, cc_addrs, subject, body_text, body_html, next_attempt_at, kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,

    // R158.100-fix (2026-10-14) — 加 attempt_count < max_attempts 过滤 (见 mysql 同注释).
    listPending: (limit) =>
      `SELECT TOP ${Number(limit) || 25} id, report_id, to_addrs, cc_addrs, subject, body_text, body_html,
              attempt_count, max_attempts, next_attempt_at, last_error, sent_at, kind
       FROM report_email_outbox
       WHERE sent_at IS NULL
         AND next_attempt_at <= SYSUTCDATETIME()
         AND attempt_count < max_attempts
       ORDER BY next_attempt_at ASC, id ASC`,

    markSent: `UPDATE report_email_outbox SET sent_at = SYSUTCDATETIME(), attempt_count = attempt_count + 1, last_error = ?
               WHERE id = ?`,

    markFailed: `UPDATE report_email_outbox SET attempt_count = attempt_count + 1, last_error = ?
                 WHERE id = ?`,

    // R158.100-fix (2026-10-14) — markExhausted 双层防御 (见 mysql 同注释).
    markExhausted: `UPDATE report_email_outbox SET next_attempt_at = '9999-12-31 23:59:59'
                    WHERE id = ?`,

    scheduleRetry: `UPDATE report_email_outbox SET next_attempt_at = DATEADD(SECOND, ?, SYSUTCDATETIME())
                    WHERE id = ?`
  }
};
