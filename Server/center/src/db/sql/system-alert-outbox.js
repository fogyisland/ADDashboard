// SQL helpers for the system_alert_outbox table (R158.68).
// 内置告警邮件队列, 跟 report_email_outbox 物理隔离.
// 跟 R158.62 alertOutbox 同 shape (to_addrs/cc_addrs/subject/body_text/body_html/
// attempt_count/next_attempt_at/last_error/sent_at), 但 R158.68 简化为只接
// 单一 kind (内置告警), 不再有 kind 列, FK 用 alert_id 而不是 alert_event_id.

export const systemAlertOutbox = {
  mysql: {
    // enqueue: 1 个待发邮件
    // 8 参: alert_id / to_addrs / cc_addrs / subject / body_text / body_html / next_attempt_at / max_attempts
    enqueue: `INSERT INTO system_alert_outbox
      (alert_id, to_addrs, cc_addrs, subject, body_text, body_html, next_attempt_at, max_attempts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,

    // 扫 pending (sent_at IS NULL AND next_attempt_at <= NOW). 跟 R158.62 同 shape.
    // LIMIT 走参数绑定.
    // R158.100-fix (2026-10-14) — 加 attempt_count < max_attempts 过滤.
    //   原因: scheduleRetry exhausted path (backoffSeconds=0) 只调 markFailed
    //   不动 next_attempt_at, 老 exhausted 行 next_attempt_at 仍是过去值,
    //   listPending 会无限次选到 → attempt_count 涨到 2700+ (Bug B).
    //   现在让 listPending 直接跳过, 跟 scheduleRetry 设计意图 (exhausted
    //   不再重试) 1:1.
    listPending: `SELECT id, alert_id, to_addrs, cc_addrs, subject, body_text, body_html,
                         attempt_count, max_attempts, next_attempt_at, last_error, sent_at
                  FROM system_alert_outbox
                  WHERE sent_at IS NULL
                    AND next_attempt_at <= UTC_TIMESTAMP(3)
                    AND attempt_count < max_attempts
                  ORDER BY next_attempt_at ASC, id ASC
                  LIMIT ?`,

    // markSent: [last_error_placeholder, id] — 跟 R158.62 alertOutbox 同约定
    markSent: `UPDATE system_alert_outbox SET sent_at = UTC_TIMESTAMP(3), attempt_count = attempt_count + 1, last_error = ?
               WHERE id = ?`,

    // markFailed: [last_error, id]
    markFailed: `UPDATE system_alert_outbox SET attempt_count = attempt_count + 1, last_error = ?
                 WHERE id = ?`,

    // R158.100-fix (2026-10-14) — markExhausted: 终止重试防御.
    //   attempt_count 推到 max_attempts 时调用, 把 next_attempt_at 设到 9999
    //   (远超 SYSUTCDATETIME), 即使 listPending 未来漏加 attempt_count 过滤,
    //   这条行也不会被误选 (双层防御, 跟 listPending 过滤冗余).
    //   [id] 单参.
    markExhausted: `UPDATE system_alert_outbox SET next_attempt_at = '9999-12-31 23:59:59'
                    WHERE id = ?`,

    // scheduleRetry: [backoff_seconds, id]
    scheduleRetry: `UPDATE system_alert_outbox SET next_attempt_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND)
                    WHERE id = ?`,

    // 找某条 alert 的 outbox (ack 拒重发)
    findByAlert: `SELECT id, sent_at, attempt_count, last_error
                  FROM system_alert_outbox
                  WHERE alert_id = ?`,

    // 重置 (R158.67 范式, 保留给未来 resend 端点)
    resetForRetry: `UPDATE system_alert_outbox
                    SET attempt_count = 0, last_error = NULL, next_attempt_at = UTC_TIMESTAMP(3)
                    WHERE id = ?`,

    // 找某 alert 的最近 outbox (UI 显示)
    // R161.19 (2026-10-28) — MySQL 侧**不能**用 `SELECT TOP 1`:
    //   TOP 是 T-SQL 语法, MySQL 报 1064 ER_PARSE_ERROR ⇒ 该接口 100% 500。
    //   MySQL 的等价写法是 ORDER BY ... LIMIT 1 (LIMIT 在 ORDER BY 之后)。
    //   MSSQL 侧保持 `SELECT TOP 1` (见下方 mssql 段), 两边语义等价:
    //   都取"按 id 倒序第一条"。
    findLatestByAlert: `SELECT id, sent_at, attempt_count, last_error
                        FROM system_alert_outbox
                        WHERE alert_id = ?
                        ORDER BY id DESC
                        LIMIT 1`
  },
  mssql: {
    enqueue: `INSERT INTO system_alert_outbox
      (alert_id, to_addrs, cc_addrs, subject, body_text, body_html, next_attempt_at, max_attempts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,

    // mssql TOP n interpolation
    // R158.100-fix (2026-10-14) — 加 attempt_count < max_attempts 过滤 (见 mysql 同注释).
    listPending: (limit) =>
      `SELECT TOP ${Number(limit) || 25} id, alert_id, to_addrs, cc_addrs, subject, body_text, body_html,
              attempt_count, max_attempts, next_attempt_at, last_error, sent_at
       FROM system_alert_outbox
       WHERE sent_at IS NULL
         AND next_attempt_at <= SYSUTCDATETIME()
         AND attempt_count < max_attempts
       ORDER BY next_attempt_at ASC, id ASC`,

    markSent: `UPDATE system_alert_outbox SET sent_at = SYSUTCDATETIME(), attempt_count = attempt_count + 1, last_error = ?
               WHERE id = ?`,

    markFailed: `UPDATE system_alert_outbox SET attempt_count = attempt_count + 1, last_error = ?
                 WHERE id = ?`,

    // R158.100-fix (2026-10-14) — markExhausted 双层防御 (见 mysql 同注释).
    markExhausted: `UPDATE system_alert_outbox SET next_attempt_at = '9999-12-31 23:59:59'
                    WHERE id = ?`,

    scheduleRetry: `UPDATE system_alert_outbox SET next_attempt_at = DATEADD(SECOND, ?, SYSUTCDATETIME())
                    WHERE id = ?`,

    findByAlert: `SELECT id, sent_at, attempt_count, last_error
                  FROM system_alert_outbox
                  WHERE alert_id = ?`,

    resetForRetry: `UPDATE system_alert_outbox
                    SET attempt_count = 0, last_error = NULL, next_attempt_at = SYSUTCDATETIME()
                    WHERE id = ?`,

    findLatestByAlert: `SELECT TOP 1 id, sent_at, attempt_count, last_error
                        FROM system_alert_outbox
                        WHERE alert_id = ?
                        ORDER BY id DESC`
  }
};
