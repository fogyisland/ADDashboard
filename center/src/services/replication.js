// Replication UPSERT service. Reads SQL from db.sql registry and executes
// via db facade, so the same code works against MySQL or SQL Server.

import { getDb } from '../db/index.js';
import { toMysqlDatetime } from '../utils/datetime.js';

// Coerce a value to either null or string. The tedious MSSQL driver validates
// parameters at the protocol layer (tedious/lib/data-types/nvarchar.js:121-128):
// null/undefined pass; anything else must be typeof 'string', else throws
// "Invalid string." (production hit this on KDLWXOFADSRV1 reports — see
// debuglog/ADDashboardCenter-stderr.log — every report was rejected because
// p5/p6 received a non-null non-string value).
//
// Why does this happen? The route layer (`routes/agent.js:206`) calls
// upsertStatus with `data.map(row => ({...row, agentId, collectedAt}))`
// straight from the agent's JSON payload. When collect-replication.ps1's
// $Site lookup fails (KDLWXOFADSRV1 hit: AD module loaded but site query
// errored), `$snapshot.Site` defaults to $null and `ConvertTo-Json` emits
// `"SourceSite": null`. That round-trips to JS null correctly. BUT if any
// non-string non-null sneaks through (PowerShell emitting an empty PSCustomObject,
// a JSON number 0, etc.), `?? null` lets it through. Defensive String coercion
// at the boundary catches the leak before the driver rejects it.
function asNullableString(v) {
  if (v == null) return null;
  return typeof v === 'string' ? v : String(v);
}

function rowParams(row) {
  // The 4 counter fields are populated only for the __dc_summary__ self-loop
  // entry emitted by collect-replication.ps1; all other entries pass NULL.
  // 2026-08-27 round-25 fix: read row.namingContext (camelCase) — the route
  // layer at routes/agent.js forwards the agent payload straight from
  // reporter.toCamelEntry, which produces camelCase keys. The previous
  // snake_case read (`row.naming_context`) was always undefined, so
  // isSummary was always false and the 4 counters were silently bound as
  // NULL on every __dc_summary__ row. That left Server Overview showing
  // — / 0 / — / — for every DC that reported through this path.
  // 2026-08-28 round-45: drop partnerPortStatus binding (R35 port monitoring
  // surface removed). The column remains inert in ad_replication_status —
  // schema untouched, app-layer binding/reads deleted.
  const isSummary = row.namingContext === '__dc_summary__';
  return [
    toMysqlDatetime(row.collectedAt),
    row.agentId,
    row.sourceDc,
    row.destDc,
    asNullableString(row.sourceSite ?? null),
    asNullableString(row.destSite ?? null),
    row.namingContext,
    toMysqlDatetime(row.lastSuccessTime),
    toMysqlDatetime(row.lastAttemptTime),
    row.statusCode,
    row.errorMessage ?? null,
    isSummary ? (row.usersCount ?? null)  : null,
    isSummary ? (row.groupsCount ?? null) : null,
    isSummary ? (row.gposCount ?? null)   : null,
    isSummary ? (row.lockedCount ?? null) : null
  ];
}

function historyParams(row) {
  // 2026-08-27 round-42 (复制日志监控): history table now carries
  // last_attempt_time, attempt_duration_ms, objects_transferred. Agents
  // that pre-date round-42 will send null/undefined for these — coerce
  // to null so the INSERT shape stays consistent. Real agents populate
  // them from Get-ADReplicationPartnerMetadata._ResultHistory (see
  // agent/scripts/collect-replication.ps1::BuildReplicationHistoryRows).
  //
  // Mock agents emit history rows with a synthetic `__history__:<hash>`
  // naming_context so the route can fork them off into the history-only
  // ingestion path. Strip the prefix here so the stored naming_context
  // matches the link's NC — that's what the dashboard's
  // historyByPair lookup joins on (see routes/dashboard.js replication-log
  // endpoint). Real agents (round-42 follow-up) emit the link's real NC
  // directly; the prefix-strip is a no-op for them.
  let namingContext = row.namingContext;
  if (typeof namingContext === 'string' && namingContext.startsWith('__history__:')) {
    // The mock encodes a hash after the prefix; the real NC is in the
    // sourceDc/destDc context but isn't recoverable from the hash alone.
    // Mock callers must therefore also pass `_realNamingContext` on the
    // row (see mock-snapshot.mjs buildReplicationHistoryEntries for the
    // exact convention).
    namingContext = row._realNamingContext ?? null;
  }
  return [
    toMysqlDatetime(row.collectedAt),
    row.agentId,
    row.sourceDc,
    row.destDc,
    namingContext,
    toMysqlDatetime(row.lastSuccessTime),
    toMysqlDatetime(row.lastAttemptTime ?? row.lastSuccessTime),
    row.attemptDurationMs ?? null,
    row.objectsTransferred ?? null,
    row.statusCode,
    row.errorMessage ?? null
  ];
}

export async function upsertStatus(rows, { appendHistory = false } = {}) {
  const db = getDb();
  for (const row of rows) {
    await db.execute(db.sql.replication.upsertStatus, rowParams(row));
    if (appendHistory) {
      await db.execute(db.sql.replication.upsertHistory, historyParams(row));
    }
  }
}

// 2026-08-27 round-42 (复制日志监控): history-only ingestion path. Mock
// + real agents that emit per-attempt history rows with a synthetic
// `__history__:%` naming_context can land them straight in
// `ad_replication_history` without polluting `ad_replication_status` (a
// back-dated history row in ad_replication_status would overwrite the
// link's latest-per-pair row and silently break the matrix view).
//
// history_entries must carry: sourceDc, destDc, namingContext (the
// synthetic __history__ key), lastAttemptTime, statusCode, errorMessage,
// and optionally attemptDurationMs/objectsTransferred/lastSuccessTime.
// See historyParams() for the exact bind shape.
export async function insertHistoryEntries(historyEntries) {
  if (!Array.isArray(historyEntries) || historyEntries.length === 0) return 0;
  const db = getDb();
  for (const row of historyEntries) {
    await db.execute(db.sql.replication.upsertHistory, historyParams(row));
  }
  return historyEntries.length;
}

export async function listRecent(limit = 100) {
  const db = getDb();
  const { rows } = await db.query(db.sql.replication.listRecent, [limit]);
  return rows;
}

export async function listBySite(site, limit = 100) {
  const db = getDb();
  const { rows } = await db.query(db.sql.replication.listBySite, [site, site, limit]);
  return rows;
}