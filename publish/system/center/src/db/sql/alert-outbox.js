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
                  WHERE sent_at IS NULL AND next_attempt_at <= UTC_TIMESTAMP()
                  ORDER BY next_attempt_at ASC, id ASC
                  LIMIT ?`,
    // Param order is [last_error_placeholder, id] — last_error is set to NULL
    // on success so the caller passes [null, rowId]. The leading placeholder
    // keeps params[1] bound to the row id (matches unit-test expectations).
    markSent: `UPDATE alert_email_outbox SET sent_at = UTC_TIMESTAMP(), attempt_count = attempt_count + 1, last_error = ?
               WHERE id = ?`,
    // Param order is [last_error, id]. attempt_count is bumped inline;
    // scheduleRetry SQL below sets next_attempt_at separately so the loop
    // can vary the backoff without needing a third param here.
    markFailed: `UPDATE alert_email_outbox SET attempt_count = attempt_count + 1, last_error = ?
                 WHERE id = ?`,
    // Sets only next_attempt_at (the loop computes the backoff seconds and
    // passes them in). Used after markFailed to apply exponential backoff.
    scheduleRetry: `UPDATE alert_email_outbox SET next_attempt_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND)
                    WHERE id = ?`,
    deleteByEvent: `DELETE FROM alert_email_outbox WHERE alert_event_id = ?`
  },
  mssql: {
    enqueue: `INSERT INTO alert_email_outbox
      (alert_event_id, to_addrs, cc_addrs, subject, body_text, body_html, next_attempt_at)
      VALUES (?, CAST(? AS VARCHAR(1024)), CAST(? AS VARCHAR(1024)), CAST(? AS VARCHAR(256)), ?, ?, ?)`,
    findById: `SELECT id, alert_event_id, to_addrs, cc_addrs, subject, body_text, body_html,
                      attempt_count, next_attempt_at, last_error, sent_at, created_at
               FROM alert_email_outbox WHERE id = ?`,
    listPending: (limit) =>
      `SELECT TOP ${Number(limit)} id, alert_event_id, to_addrs, cc_addrs, subject, body_text, body_html,
              attempt_count, next_attempt_at, last_error, sent_at, created_at
       FROM alert_email_outbox
       WHERE sent_at IS NULL AND next_attempt_at <= SYSUTCDATETIME()
       ORDER BY next_attempt_at ASC, id ASC`,
    markSent: `UPDATE alert_email_outbox SET sent_at = SYSUTCDATETIME(), attempt_count = attempt_count + 1, last_error = ?
               WHERE id = ?`,
    markFailed: `UPDATE alert_email_outbox SET attempt_count = attempt_count + 1, last_error = ?
                 WHERE id = ?`,
    scheduleRetry: `UPDATE alert_email_outbox SET next_attempt_at = DATEADD(SECOND, ?, SYSUTCDATETIME())
                    WHERE id = ?`,
    deleteByEvent: `DELETE FROM alert_email_outbox WHERE alert_event_id = ?`
  }
};
