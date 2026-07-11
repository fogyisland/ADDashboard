// Replication UPSERT service for MySQL.
// ON DUPLICATE KEY UPDATE keyed on (source_dc, dest_dc, naming_context)
// unique index declared in 01-tables.sql. Optionally appends to
// ad_replication_history using the same row payload.

const UPSERT_SQL = `
INSERT INTO ad_replication_status (
  collected_at, agent_id, source_dc, dest_dc, source_site, dest_site,
  naming_context, last_success_time, last_attempt_time, status_code, error_message
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
  collected_at      = VALUES(collected_at),
  agent_id          = VALUES(agent_id),
  source_site       = VALUES(source_site),
  dest_site         = VALUES(dest_site),
  last_success_time = VALUES(last_success_time),
  last_attempt_time = VALUES(last_attempt_time),
  status_code       = VALUES(status_code),
  error_message     = VALUES(error_message)
`.trim();

const HISTORY_SQL = `
INSERT INTO ad_replication_history (
  collected_at, agent_id, source_dc, dest_dc, naming_context,
  last_success_time, status_code, error_message
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`.trim();

function rowParams(row) {
  return [
    row.collectedAt,
    row.agentId,
    row.sourceDc,
    row.destDc,
    row.sourceSite ?? null,
    row.destSite ?? null,
    row.namingContext,
    row.lastSuccessTime ?? null,
    row.lastAttemptTime ?? null,
    row.statusCode,
    row.errorMessage ?? null
  ];
}

function historyParams(row) {
  return [
    row.collectedAt,
    row.agentId,
    row.sourceDc,
    row.destDc,
    row.namingContext,
    row.lastSuccessTime ?? null,
    row.statusCode,
    row.errorMessage ?? null
  ];
}

export async function upsertStatus(pool, rows, { appendHistory = false } = {}) {
  for (const row of rows) {
    await pool.execute(UPSERT_SQL, rowParams(row));
    if (appendHistory) {
      await pool.execute(HISTORY_SQL, historyParams(row));
    }
  }
}