// SQL helpers for the per-package metric table `pkg_ad_os_baseline.metrics`
// (created by the built-in ad_os_baseline package — see manifest at
// publish/center/data/packages/ad_os_baseline/1.0.0/manifest.json).
//
// The AlertEvaluationLoop reads the latest metrics row per member-server
// on each tick. The schemaName is schema-qualified via backticks
// (MySQL) / brackets (MSSQL); the table name needs no quoting because
// it's a fixed literal coming from the package manifest (validated by
// T3 ajv).
//
// Columns (from manifest.database.metricSchema):
//   agent_id, ts, cpu_pct, memory_pct, disk_free (JSON), disk_total
//   (JSON), services (JSON), events (JSON)
//
// getLatest returns one row: the most recent snapshot for the given
// agent_id. The loop's per-tick payload is small enough that LIMIT 1
// is fine; ordering by ts DESC means the freshest row wins even when
// multiple agents share the schema.

export const alertMetrics = {
  mysql: {
    getLatest: `SELECT agent_id, ts, cpu_pct, memory_pct, disk_free, disk_total, services, events
                FROM \`pkg_ad_os_baseline\`.metrics
                WHERE agent_id = ?
                ORDER BY ts DESC, id DESC
                LIMIT 1`
  },
  mssql: {
    getLatest: `SELECT TOP 1 agent_id, ts, cpu_pct, memory_pct, disk_free, disk_total, services, events
                FROM [pkg_ad_os_baseline].[metrics]
                WHERE agent_id = ?
                ORDER BY ts DESC, id DESC`
  }
};
