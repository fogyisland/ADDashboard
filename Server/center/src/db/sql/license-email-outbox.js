// R158.AdminEmail (2026-10-15) — SQL helpers for license_email_outbox table.
//   跟 R158.100.C ad-notify-outbox.js 1:1 平行, 8 列 INSERT shape.
//   license_id 替 ad_command_id (引用 ad_system_registration.id, 0 DB-level FK).
//   投递 loop 走 email.js createEmailDeliveryLoop listPending UNION 4 表
//   (system_alert + report + ad_notify + license), capacity 1/4 each.
//   跟 3 张既有 outbox 表 DDL 1:1 平行: id, <ref_id>, to_addrs, cc_addrs,
//   subject, body_text, body_html, status (omitted, 用 sent_at IS NULL 表达),
//   attempt_count, max_attempts, last_error, next_attempt_at, created_at, sent_at.
//
// 跟 ad_notify_outbox 唯一差异: ref_id 列名 = license_id (语义清晰, 跟
// ad_system_registration.id 1:1). 列存值 = license_activated 时是
// ad_system_registration.id, license_request 时是 NULL (申请单无 license row).

export const licenseEmailOutbox = {
  mysql: {
    // enqueue: 1 个待发邮件
    // 8 参: license_id / to_addrs / cc_addrs / subject / body_text / body_html / next_attempt_at / max_attempts
    enqueue: `INSERT INTO license_email_outbox
      (license_id, to_addrs, cc_addrs, subject, body_text, body_html, next_attempt_at, max_attempts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,

    // 扫 pending (sent_at IS NULL AND next_attempt_at <= NOW AND attempt_count < max_attempts)
    // LIMIT 走参数绑定. 跟 ad-notify-outbox.js 同 shape (R158.100.C + R158.100-fix precedent).
    listPending: `SELECT id, license_id, to_addrs, cc_addrs, subject, body_text, body_html,
                         attempt_count, max_attempts, next_attempt_at, last_error, sent_at
                  FROM license_email_outbox
                  WHERE sent_at IS NULL
                    AND next_attempt_at <= UTC_TIMESTAMP(3)
                    AND attempt_count < max_attempts
                  ORDER BY next_attempt_at ASC, id ASC
                  LIMIT ?`,

    // markSent: [last_error_placeholder, id]
    markSent: `UPDATE license_email_outbox SET sent_at = UTC_TIMESTAMP(3), attempt_count = attempt_count + 1, last_error = ?
               WHERE id = ?`,

    // markFailed: [last_error, id]
    markFailed: `UPDATE license_email_outbox SET attempt_count = attempt_count + 1, last_error = ?
                 WHERE id = ?`,

    // markExhausted: [id] — 双层防御 (跟 R158.100-fix + R158.100.C ad-notify-outbox 同形)
    markExhausted: `UPDATE license_email_outbox SET next_attempt_at = '9999-12-31 23:59:59'
                    WHERE id = ?`,

    // scheduleRetry: [backoff_seconds, id]
    scheduleRetry: `UPDATE license_email_outbox SET next_attempt_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND)
                    WHERE id = ?`,

    // 跟 ad-notify-outbox.js purgeAdNotifyOlderThan 1:1 平行. 待 email-history-retention
    // sweep 扩 4 表时调用. 本轮 ship 不触发 (R158.69 现有 sweep 仅 alert + report,
    // ad_notify 跟 license 都 0 sweep; 下轮 ship 时 R158.License-activation 0 必扩).
    purgeLicenseEmailOlderThan: (days) => `
      DELETE FROM license_email_outbox
      WHERE sent_at IS NOT NULL
        AND sent_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY)
      LIMIT 5000`
  },
  mssql: {
    enqueue: `INSERT INTO license_email_outbox
      (license_id, to_addrs, cc_addrs, subject, body_text, body_html, next_attempt_at, max_attempts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,

    // mssql TOP n interpolation (跟 ad-notify-outbox.js 1:1 平行)
    listPending: (limit) =>
      `SELECT TOP ${Number(limit) || 25} id, license_id, to_addrs, cc_addrs, subject, body_text, body_html,
              attempt_count, max_attempts, next_attempt_at, last_error, sent_at
       FROM license_email_outbox
       WHERE sent_at IS NULL
         AND next_attempt_at <= SYSUTCDATETIME()
         AND attempt_count < max_attempts
       ORDER BY next_attempt_at ASC, id ASC`,

    markSent: `UPDATE license_email_outbox SET sent_at = SYSUTCDATETIME(), attempt_count = attempt_count + 1, last_error = ?
               WHERE id = ?`,

    markFailed: `UPDATE license_email_outbox SET attempt_count = attempt_count + 1, last_error = ?
                 WHERE id = ?`,

    markExhausted: `UPDATE license_email_outbox SET next_attempt_at = '9999-12-31 23:59:59'
                    WHERE id = ?`,

    scheduleRetry: `UPDATE license_email_outbox SET next_attempt_at = DATEADD(SECOND, ?, SYSUTCDATETIME())
                    WHERE id = ?`,

    // 跟 mysql 同 precedent. mssql DELETE TOP(N) 范式.
    purgeLicenseEmailOlderThan: (days) => `
      DELETE TOP (5000) FROM license_email_outbox
      WHERE sent_at IS NOT NULL
        AND sent_at < DATEADD(DAY, -?, SYSUTCDATETIME())`
  }
};

// R158.License-expiry (2026-10-15) — catch-up dedup helper. 查 license_email_outbox
//   在 [windowStartUtc, windowEndUtc) 窗内同 kind (expiring_soon / expired) 已有发件数.
//   n>0 = 已发过 1 次, catch-up 应 skip 避免重启放大.
//   跟 R158.100.B+3 countByKindInWindow 1:1 平行, 但用 subject LIKE 匹配 kind
//   (license_email_outbox 0 kind 列, 跟 daily_reports.kind 不同). 跟前 6 helper
//   1:1 平行 2 dialect, 3 参: subjectPrefix, windowStartUtc, windowEndUtc.
//
//   R158.100-fix 教训: Boolean('false')=true; 这里 0 用 Boolean, 走 Number(rows[0]?.n ?? 0).
//   跟 daily_reports countByKindInWindow 1:1 兼容 mssql single-row (mssql npm 多行+N 参 rewrite 100% fail).
export const licenseExpiryDedup = {
  mysql: {
    countBySubjectInWindow: `SELECT COUNT(*) AS n FROM license_email_outbox
                             WHERE subject LIKE ?
                               AND created_at >= ?
                               AND created_at < ?`
  },
  mssql: {
    countBySubjectInWindow: `SELECT COUNT(*) AS n FROM license_email_outbox
                             WHERE subject LIKE CAST(? AS NVARCHAR(256))
                               AND created_at >= ?
                               AND created_at < ?`
  }
};
