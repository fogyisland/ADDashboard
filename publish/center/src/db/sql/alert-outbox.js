// SQL helpers for the alert_email_outbox table (migration 014).
// Pattern matches center/src/db/sql.js's `sites` / `dcs` domain:
// dual-dialect SQL strings mounted into the registry so service code can
// read db.sql.alertOutbox.<query> and get back a plain string for the
// active dialect.
//
// alert_email_outbox (PK = id BIGINT IDENTITY):
//   id, alert_event_id, to_addrs, cc_addrs, subject, body_text, body_html,
//   attempt_count, next_attempt_at, last_error, sent_at, created_at
//
// Index: idx_aoe_pending on (sent_at, next_attempt_at) — the delivery
// loop scans pending rows with WHERE sent_at IS NULL.

export const alertOutbox = {
  mysql: {
    enqueue: `INSERT INTO alert_email_outbox
      (alert_event_id, to_addrs, cc_addrs, subject, body_text, body_html, next_attempt_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    findById: `SELECT id, alert_event_id, to_addrs, cc_addrs, subject, body_text, body_html,
                      attempt_count, next_attempt_at, last_error, sent_at, created_at
               FROM alert_email_outbox WHERE id = ?`,
    listPending: `SELECT id, alert_event_id, to_addrs, cc_addrs, subject, body_text, body_html,
                         attempt_count, next_attempt_at, last_error, sent_at, created_at
                  FROM alert_email_outbox
                  WHERE sent_at IS NULL AND next_attempt_at <= NOW()
                  ORDER BY next_attempt_at ASC, id ASC
                  LIMIT ?`,
    markSent: `UPDATE alert_email_outbox SET sent_at = NOW(), attempt_count = attempt_count + 1, last_error = NULL
               WHERE id = ?`,
    markFailed: `UPDATE alert_email_outbox
                 SET attempt_count = attempt_count + 1,
                     last_error = ?,
                     next_attempt_at = DATE_ADD(NOW(), INTERVAL ? MINUTE)
                 WHERE id = ?`,
    deleteByEvent: `DELETE FROM alert_email_outbox WHERE alert_event_id = ?`
  },
  mssql: {
    enqueue: `INSERT INTO alert_email_outbox
      (alert_event_id, to_addrs, cc_addrs, subject, body_text, body_html, next_attempt_at)
      VALUES (?, ?, ?, ?, ?, ?, ?); SELECT SCOPE_IDENTITY() AS id`,
    findById: `SELECT id, alert_event_id, to_addrs, cc_addrs, subject, body_text, body_html,
                      attempt_count, next_attempt_at, last_error, sent_at, created_at
               FROM alert_email_outbox WHERE id = ?`,
    listPending: (limit) =>
      `SELECT TOP ${Number(limit)} id, alert_event_id, to_addrs, cc_addrs, subject, body_text, body_html,
              attempt_count, next_attempt_at, last_error, sent_at, created_at
       FROM alert_email_outbox
       WHERE sent_at IS NULL AND next_attempt_at <= SYSUTCDATETIME()
       ORDER BY next_attempt_at ASC, id ASC`,
    markSent: `UPDATE alert_email_outbox SET sent_at = SYSUTCDATETIME(), attempt_count = attempt_count + 1, last_error = NULL
               WHERE id = ?`,
    markFailed: `UPDATE alert_email_outbox
                 SET attempt_count = attempt_count + 1,
                     last_error = ?,
                     next_attempt_at = DATEADD(MINUTE, ?, SYSUTCDATETIME())
                 WHERE id = ?`,
    deleteByEvent: `DELETE FROM alert_email_outbox WHERE alert_event_id = ?`
  }
};
