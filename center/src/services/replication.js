// Replication UPSERT service. Reads SQL from db.sql registry and executes
// via db facade, so the same code works against MySQL or SQL Server.

import { getDb } from '../db/index.js';
import { toMysqlDatetime } from '../utils/datetime.js';

function rowParams(row) {
  // The 4 counter fields are populated only for the __dc_summary__ self-loop
  // entry emitted by collect-replication.ps1; all other entries pass NULL.
  const isSummary = row.naming_context === '__dc_summary__';
  // partnerPortStatus on the wire (agent → centre) is already a JSON string
  // emitted by collect-replication.ps1's ConvertTo-Json -Compress + toCamelEntry
  // forwarding it verbatim. Other in-process callers (tests, services that
  // build the JS object directly) pass an object. Bind whatever is given as
  // a string to the JSON/NVARCHAR(MAX) column — JSON.stringify an already-
  // stringified payload would produce escaped JSON-in-JSON, forcing every
  // downstream consumer to call JSON.parse twice. null when omitted so
  // older callers / pre-feature rows stay valid.
  let partnerPortStatusJson = null;
  if (row.partnerPortStatus != null) {
    partnerPortStatusJson = typeof row.partnerPortStatus === 'string'
      ? row.partnerPortStatus
      : JSON.stringify(row.partnerPortStatus);
  }
  return [
    toMysqlDatetime(row.collectedAt),
    row.agentId,
    row.sourceDc,
    row.destDc,
    row.sourceSite ?? null,
    row.destSite ?? null,
    row.namingContext,
    toMysqlDatetime(row.lastSuccessTime),
    toMysqlDatetime(row.lastAttemptTime),
    row.statusCode,
    row.errorMessage ?? null,
    isSummary ? (row.usersCount ?? null)  : null,
    isSummary ? (row.groupsCount ?? null) : null,
    isSummary ? (row.gposCount ?? null)   : null,
    isSummary ? (row.lockedCount ?? null) : null,
    partnerPortStatusJson
  ];
}

function historyParams(row) {
  return [
    toMysqlDatetime(row.collectedAt),
    row.agentId,
    row.sourceDc,
    row.destDc,
    row.namingContext,
    toMysqlDatetime(row.lastSuccessTime),
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