// SQL helpers for the alert_rules + alert_rule_state tables (migration 014).
// Pattern matches center/src/db/sql.js's `sites` / `dcs` domain:
// dual-dialect SQL strings mounted into the registry so service code can
// read db.sql.alertRules.<query> and get back a plain string for the
// active dialect.
//
// alert_rules (PK = rule_id):
//   rule_id, hostname, name, `condition` (JSON), for_minutes,
//   cooldown_minutes, recipients (CSV/JSON), enabled, created_at, updated_at
//
// alert_rule_state (PK = rule_id, 1:1 with alert_rules):
//   state ('normal' | 'pending' | 'firing' | 'recovered'),
//   first_hit_at, last_evaluated_at, last_fired_at, last_recovered_at,
//   suppressed_until

export const alertRules = {
  mysql: {
    // ---- alert_rules ----
    create: `INSERT INTO alert_rules (hostname, name, \`condition\`, for_minutes, cooldown_minutes, recipients, enabled)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
    findById: `SELECT rule_id, hostname, name, \`condition\`, for_minutes, cooldown_minutes, recipients, enabled, created_at, updated_at
               FROM alert_rules WHERE rule_id = ?`,
    list: `SELECT rule_id, hostname, name, \`condition\`, for_minutes, cooldown_minutes, recipients, enabled, created_at, updated_at
           FROM alert_rules ORDER BY hostname, name`,
    listForHost: `SELECT rule_id, hostname, name, \`condition\`, for_minutes, cooldown_minutes, recipients, enabled, created_at, updated_at
                  FROM alert_rules WHERE hostname = ? ORDER BY name`,
    listEnabled: `SELECT rule_id, hostname, name, \`condition\`, for_minutes, cooldown_minutes, recipients, enabled, created_at, updated_at
                  FROM alert_rules WHERE enabled = 1 ORDER BY hostname, name`,
    listEnabledForHost: `SELECT rule_id, hostname, name, \`condition\`, for_minutes, cooldown_minutes, recipients, enabled, created_at, updated_at
                         FROM alert_rules WHERE hostname = ? AND enabled = 1 ORDER BY name`,
    listEnabledForHostWithState: `SELECT r.rule_id, r.hostname, r.name, r.\`condition\`, r.for_minutes, r.cooldown_minutes, r.recipients, r.enabled,
       s.state, s.first_hit_at, s.last_fired_at, s.suppressed_until
       FROM alert_rules r
       LEFT JOIN alert_rule_state s ON s.rule_id = r.rule_id
       WHERE r.hostname = ? AND r.enabled = 1`,
    listAllEnabled: `SELECT rule_id, hostname, name, \`condition\`, for_minutes, cooldown_minutes, recipients, enabled, created_at, updated_at
                     FROM alert_rules WHERE enabled = 1 ORDER BY hostname, rule_id`,
    update: `UPDATE alert_rules SET name = ?, \`condition\` = ?, for_minutes = ?, cooldown_minutes = ?, recipients = ?, enabled = ?
             WHERE rule_id = ?`,
    delete: `DELETE FROM alert_rules WHERE rule_id = ?`,

    // ---- alert_rule_state ----
    upsertState: `INSERT INTO alert_rule_state (rule_id, state, first_hit_at, last_evaluated_at, last_fired_at, last_recovered_at, suppressed_until)
                  VALUES (?, ?, ?, NOW(), ?, ?, ?)
                  ON DUPLICATE KEY UPDATE
                    state = VALUES(state),
                    first_hit_at = VALUES(first_hit_at),
                    last_evaluated_at = NOW(),
                    last_fired_at = VALUES(last_fired_at),
                    last_recovered_at = VALUES(last_recovered_at),
                    suppressed_until = VALUES(suppressed_until)`,
    getState: `SELECT rule_id, state, first_hit_at, last_evaluated_at, last_fired_at, last_recovered_at, suppressed_until
               FROM alert_rule_state WHERE rule_id = ?`,
    listStatesForEval: `SELECT s.rule_id, s.state, s.first_hit_at, s.last_evaluated_at, s.last_fired_at, s.last_recovered_at, s.suppressed_until,
                               r.hostname, r.name, r.\`condition\`, r.for_minutes, r.cooldown_minutes, r.recipients, r.enabled
                        FROM alert_rule_state s
                        INNER JOIN alert_rules r ON r.rule_id = s.rule_id
                        WHERE r.enabled = 1`,
    touchEvaluated: `UPDATE alert_rule_state SET last_evaluated_at = NOW() WHERE rule_id = ?`,
    clearSuppression: `UPDATE alert_rule_state SET suppressed_until = NULL WHERE rule_id = ?`
  },
  mssql: {
    // ---- alert_rules ----
    create: `INSERT INTO alert_rules (hostname, name, [condition], for_minutes, cooldown_minutes, recipients, enabled)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
    findById: `SELECT rule_id, hostname, name, [condition], for_minutes, cooldown_minutes, recipients, enabled, created_at, updated_at
               FROM alert_rules WHERE rule_id = ?`,
    list: `SELECT rule_id, hostname, name, [condition], for_minutes, cooldown_minutes, recipients, enabled, created_at, updated_at
           FROM alert_rules ORDER BY hostname, name`,
    listForHost: `SELECT rule_id, hostname, name, [condition], for_minutes, cooldown_minutes, recipients, enabled, created_at, updated_at
                  FROM alert_rules WHERE hostname = ? ORDER BY name`,
    listEnabled: `SELECT rule_id, hostname, name, [condition], for_minutes, cooldown_minutes, recipients, enabled, created_at, updated_at
                  FROM alert_rules WHERE enabled = 1 ORDER BY hostname, name`,
    listEnabledForHost: `SELECT rule_id, hostname, name, [condition], for_minutes, cooldown_minutes, recipients, enabled, created_at, updated_at
                         FROM alert_rules WHERE hostname = ? AND enabled = 1 ORDER BY name`,
    listEnabledForHostWithState: `SELECT r.rule_id, r.hostname, r.name, r.[condition], r.for_minutes, r.cooldown_minutes, r.recipients, r.enabled,
       s.state, s.first_hit_at, s.last_fired_at, s.suppressed_until
       FROM alert_rules r
       LEFT JOIN alert_rule_state s ON s.rule_id = r.rule_id
       WHERE r.hostname = ? AND r.enabled = 1`,
    listAllEnabled: `SELECT rule_id, hostname, name, [condition], for_minutes, cooldown_minutes, recipients, enabled, created_at, updated_at
                     FROM alert_rules WHERE enabled = 1 ORDER BY hostname, rule_id`,
    update: `UPDATE alert_rules SET name = ?, [condition] = ?, for_minutes = ?, cooldown_minutes = ?, recipients = ?, enabled = ?
             WHERE rule_id = ?`,
    delete: `DELETE FROM alert_rules WHERE rule_id = ?`,

    // ---- alert_rule_state ----
    upsertState: `MERGE INTO alert_rule_state AS t
                  USING (SELECT
                    ? AS rule_id, ? AS state, ? AS first_hit_at,
                    ? AS last_fired_at, ? AS last_recovered_at, ? AS suppressed_until
                  ) AS s
                  ON t.rule_id = s.rule_id
                  WHEN MATCHED THEN UPDATE SET
                    state = s.state,
                    first_hit_at = s.first_hit_at,
                    last_evaluated_at = SYSUTCDATETIME(),
                    last_fired_at = s.last_fired_at,
                    last_recovered_at = s.last_recovered_at,
                    suppressed_until = s.suppressed_until
                  WHEN NOT MATCHED THEN INSERT
                    (rule_id, state, first_hit_at, last_evaluated_at, last_fired_at, last_recovered_at, suppressed_until)
                    VALUES
                    (s.rule_id, s.state, s.first_hit_at, SYSUTCDATETIME(), s.last_fired_at, s.last_recovered_at, s.suppressed_until);`,
    getState: `SELECT rule_id, state, first_hit_at, last_evaluated_at, last_fired_at, last_recovered_at, suppressed_until
               FROM alert_rule_state WHERE rule_id = ?`,
    listStatesForEval: `SELECT s.rule_id, s.state, s.first_hit_at, s.last_evaluated_at, s.last_fired_at, s.last_recovered_at, s.suppressed_until,
                               r.hostname, r.name, r.[condition], r.for_minutes, r.cooldown_minutes, r.recipients, r.enabled
                        FROM alert_rule_state s
                        INNER JOIN alert_rules r ON r.rule_id = s.rule_id
                        WHERE r.enabled = 1`,
    touchEvaluated: `UPDATE alert_rule_state SET last_evaluated_at = SYSUTCDATETIME() WHERE rule_id = ?`,
    clearSuppression: `UPDATE alert_rule_state SET suppressed_until = NULL WHERE rule_id = ?`
  }
};
