// R158.29 — per-agent 24h CPU+memory time-series SQL for
// /api/os-baseline/timeseries endpoint.
//
// Returns raw rows (agent_id, ts, cpu_pct, memory_pct) over a sliding
// window so the route can bucket-aggregate in JS (5-min floor) and
// emit wire shape `{ seriesByAgent: { [agentId]: { cpu, memory } } }`
// for the OsBaselineView dual-line chart.
//
// Storage: `pkg_ad_os_baseline.metrics` (R147 1.0.3 — 13-column table;
// cadence 60s/agent from manifest, retention unbounded — no sweep
// because R158.19's package_runs_retention_days explicitly excludes
// metricstore v2 tables).
//
// Parameter substitution contract (mirrors R158.7 hub-resources):
//   - agentIds is bound via `?` placeholders (safe, no injection)
//   - sinceMinutes is interpolated as a sanitised integer (since the
//     MSSQL DATEADD first arg can't be bound in some drivers; hub-
//     resources set the precedent at sql.js:1496-1501)
//
// Idempotent: same SQL shape already proven on the dashboard route,
// no FK / DDL changes.
export const osBaselineTimeseries = {
  mysql: ({ agentIds, sinceMinutes }) => `
    SELECT agent_id, ts, cpu_pct, memory_pct
    FROM \`pkg_ad_os_baseline\`.metrics
    WHERE agent_id IN (${agentIds.map(() => '?').join(',')})
      AND ts >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${Number(sinceMinutes)} MINUTE)
    ORDER BY ts ASC`,
  mssql: ({ agentIds, sinceMinutes }) => `
    SELECT agent_id, ts, cpu_pct, memory_pct
    FROM [pkg_ad_os_baseline].[metrics]
    WHERE agent_id IN (${agentIds.map(() => '?').join(',')})
      AND ts >= DATEADD(MINUTE, -${Number(sinceMinutes)}, SYSUTCDATETIME())
    ORDER BY ts ASC`
};
