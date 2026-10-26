// R158.100.C (2026-10-14) — SQL helpers for ad_notify_outbox table.
//   跟 R158.68 system-alert-outbox.js 1:1 平行, 8 列 INSERT shape.
//   ad_command_id 替 alert_id (FK 引用 ad_admin_commands.id, 0 DB-level FK).
//   投递 loop 走 email.js createEmailDeliveryLoop listPending UNION 3 表
//   (system_alert + report + ad_notify), capacity 1/3 each.

export const adNotifyOutbox = {
  mysql: {
    // enqueue: 1 个待发邮件
    // 8 参: ad_command_id / to_addrs / cc_addrs / subject / body_text / body_html / next_attempt_at / max_attempts
    enqueue: `INSERT INTO ad_notify_outbox
      (ad_command_id, to_addrs, cc_addrs, subject, body_text, body_html, next_attempt_at, max_attempts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,

    // 扫 pending (sent_at IS NULL AND next_attempt_at <= NOW AND attempt_count < max_attempts)
    // LIMIT 走参数绑定. 跟 R158.100-fix alert outbox 同 shape.
    listPending: `SELECT id, ad_command_id, to_addrs, cc_addrs, subject, body_text, body_html,
                         attempt_count, max_attempts, next_attempt_at, last_error, sent_at
                  FROM ad_notify_outbox
                  WHERE sent_at IS NULL
                    AND next_attempt_at <= UTC_TIMESTAMP(3)
                    AND attempt_count < max_attempts
                  ORDER BY next_attempt_at ASC, id ASC
                  LIMIT ?`,

    // markSent: [last_error_placeholder, id]
    markSent: `UPDATE ad_notify_outbox SET sent_at = UTC_TIMESTAMP(3), attempt_count = attempt_count + 1, last_error = ?
               WHERE id = ?`,

    // markFailed: [last_error, id]
    markFailed: `UPDATE ad_notify_outbox SET attempt_count = attempt_count + 1, last_error = ?
                 WHERE id = ?`,

    // markExhausted: [id] — 双层防御 (跟 R158.100-fix 同形)
    markExhausted: `UPDATE ad_notify_outbox SET next_attempt_at = '9999-12-31 23:59:59'
                    WHERE id = ?`,

    // scheduleRetry: [backoff_seconds, id]
    scheduleRetry: `UPDATE ad_notify_outbox SET next_attempt_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND)
                    WHERE id = ?`,

    // 跟 email-history.js purgeAlertOlderThan / purgeReportOlderThan 1:1 平行.
    // email-history-retention.js runChunkedDelete 跨 3 表 sweep. 1 占位: days.
    purgeAdNotifyOlderThan: (days) => `
      DELETE FROM ad_notify_outbox
      WHERE sent_at IS NOT NULL
        AND sent_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY)
      LIMIT 5000`
  },
  mssql: {
    enqueue: `INSERT INTO ad_notify_outbox
      (ad_command_id, to_addrs, cc_addrs, subject, body_text, body_html, next_attempt_at, max_attempts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,

    // mssql TOP n interpolation
    listPending: (limit) =>
      `SELECT TOP ${Number(limit) || 25} id, ad_command_id, to_addrs, cc_addrs, subject, body_text, body_html,
              attempt_count, max_attempts, next_attempt_at, last_error, sent_at
       FROM ad_notify_outbox
       WHERE sent_at IS NULL
         AND next_attempt_at <= SYSUTCDATETIME()
         AND attempt_count < max_attempts
       ORDER BY next_attempt_at ASC, id ASC`,

    markSent: `UPDATE ad_notify_outbox SET sent_at = SYSUTCDATETIME(), attempt_count = attempt_count + 1, last_error = ?
               WHERE id = ?`,

    markFailed: `UPDATE ad_notify_outbox SET attempt_count = attempt_count + 1, last_error = ?
                 WHERE id = ?`,

    markExhausted: `UPDATE ad_notify_outbox SET next_attempt_at = '9999-12-31 23:59:59'
                    WHERE id = ?`,

    scheduleRetry: `UPDATE ad_notify_outbox SET next_attempt_at = DATEADD(SECOND, ?, SYSUTCDATETIME())
                    WHERE id = ?`,

    // 跟 mysql 同 precedent. mssql DELETE TOP(N) 范式.
    purgeAdNotifyOlderThan: (days) => `
      DELETE TOP (5000) FROM ad_notify_outbox
      WHERE sent_at IS NOT NULL
        AND sent_at < DATEADD(DAY, -?, SYSUTCDATETIME())`
  }
};
