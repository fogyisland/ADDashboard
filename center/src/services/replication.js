// Replication UPSERT service.
// MERGE into ad_replication_status keyed on (source_dc, dest_dc, naming_context).
// Optionally append to ad_replication_history using the same Request so inputs
// stay bound for both queries.

const MERGE_SQL = `
MERGE INTO ad_replication_status AS tgt
USING (SELECT
  @collectedAt      AS collected_at,
  @agentId          AS agent_id,
  @sourceDc         AS source_dc,
  @destDc           AS dest_dc,
  @sourceSite       AS source_site,
  @destSite         AS dest_site,
  @namingContext    AS naming_context,
  @lastSuccessTime  AS last_success_time,
  @lastAttemptTime  AS last_attempt_time,
  @statusCode       AS status_code,
  @errorMessage     AS error_message
) AS src
ON (tgt.source_dc = src.source_dc AND tgt.dest_dc = src.dest_dc AND tgt.naming_context = src.naming_context)
WHEN MATCHED THEN UPDATE SET
  collected_at      = src.collected_at,
  agent_id          = src.agent_id,
  source_site       = src.source_site,
  dest_site         = src.dest_site,
  last_success_time = src.last_success_time,
  last_attempt_time = src.last_attempt_time,
  status_code       = src.status_code,
  error_message     = src.error_message
WHEN NOT MATCHED THEN INSERT (
  collected_at, agent_id, source_dc, dest_dc, source_site, dest_site,
  naming_context, last_success_time, last_attempt_time, status_code, error_message
) VALUES (
  src.collected_at, src.agent_id, src.source_dc, src.dest_dc, src.source_site, src.dest_site,
  src.naming_context, src.last_success_time, src.last_attempt_time, src.status_code, src.error_message
);
`.trim();

const HISTORY_SQL = `
INSERT INTO ad_replication_history (
  collected_at, agent_id, source_dc, dest_dc, naming_context,
  last_success_time, status_code, error_message
) VALUES (
  @collectedAt, @agentId, @sourceDc, @destDc, @namingContext,
  @lastSuccessTime, @statusCode, @errorMessage
);
`.trim();

function bindRow(req, row) {
  req.input('collectedAt', row.collectedAt);
  req.input('agentId', row.agentId);
  req.input('sourceDc', row.sourceDc);
  req.input('destDc', row.destDc);
  req.input('sourceSite', row.sourceSite ?? null);
  req.input('destSite', row.destSite ?? null);
  req.input('namingContext', row.namingContext);
  req.input('lastSuccessTime', row.lastSuccessTime ?? null);
  req.input('lastAttemptTime', row.lastAttemptTime ?? null);
  req.input('statusCode', row.statusCode);
  req.input('errorMessage', row.errorMessage ?? null);
  return req;
}

export async function upsertStatus(pool, rows, { appendHistory = false } = {}) {
  for (const row of rows) {
    const req = bindRow(pool.request(), row);
    await req.query(MERGE_SQL);
    if (appendHistory) {
      // Reuse the same request — mssql's input() doesn't consume the inputs;
      // they remain bound across multiple query() calls on the same Request.
      await req.query(HISTORY_SQL);
    }
  }
}