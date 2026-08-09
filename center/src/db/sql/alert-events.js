// SQL helpers for the alert_events table (migration 014).
// Pattern matches center/src/db/sql.js's `sites` / `dcs` domain:
// dual-dialect SQL strings mounted into the registry so service code can
// read db.sql.alertEvents.<query> and get back a plain string for the
// active dialect.
//
// alert_events (PK = id BIGINT IDENTITY):
//   id, rule_id, hostname, event ('fired' | 'recovered' | 'suppressed'),
//   detail (TEXT), created_at

export const alertEvents = {
  mysql: {
    insert: `INSERT INTO alert_events (rule_id, hostname, event, detail)
             VALUES (?, ?, ?, ?)`,
    findById: `SELECT id, rule_id, hostname, event, detail, created_at
               FROM alert_events WHERE id = ?`,
    listByRule: `SELECT id, rule_id, hostname, event, detail, created_at
                 FROM alert_events WHERE rule_id = ?
                 ORDER BY created_at DESC, id DESC`,
    listByHostname: `SELECT id, rule_id, hostname, event, detail, created_at
                     FROM alert_events WHERE hostname = ?
                     ORDER BY created_at DESC, id DESC`,
    listRecent: `SELECT id, rule_id, hostname, event, detail, created_at
                 FROM alert_events ORDER BY created_at DESC, id DESC LIMIT ?`,
    deleteByRule: `DELETE FROM alert_events WHERE rule_id = ?`
  },
  mssql: {
    insert: `INSERT INTO alert_events (rule_id, hostname, event, detail)
             VALUES (?, ?, ?, ?); SELECT SCOPE_IDENTITY() AS id`,
    findById: `SELECT id, rule_id, hostname, event, detail, created_at
               FROM alert_events WHERE id = ?`,
    listByRule: `SELECT id, rule_id, hostname, event, detail, created_at
                 FROM alert_events WHERE rule_id = ?
                 ORDER BY created_at DESC, id DESC`,
    listByHostname: `SELECT id, rule_id, hostname, event, detail, created_at
                     FROM alert_events WHERE hostname = ?
                     ORDER BY created_at DESC, id DESC`,
    listRecent: (limit) => `SELECT TOP ${Number(limit)} id, rule_id, hostname, event, detail, created_at
                            FROM alert_events ORDER BY created_at DESC, id DESC`,
    deleteByRule: `DELETE FROM alert_events WHERE rule_id = ?`
  }
};
