// Replication UPSERT service. Reads SQL from db.sql registry and executes
// via db facade, so the same code works against MySQL or SQL Server.

import { getDb } from '../db/index.js';
import { toMysqlDatetime } from '../utils/datetime.js';

function rowParams(row) {
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
    row.errorMessage ?? null
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