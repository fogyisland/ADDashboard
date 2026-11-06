import { getDb } from '../db/index.js';
import { toMysqlDatetime } from '../utils/datetime.js';

export async function upsertDiscoveredDc({ agentId, collectedAt, dc }) {
  const db = getDb();
  await db.execute(db.sql.discovery.upsertDc, [
    dc.name,
    dc.siteHint ?? null,
    dc.osVersion ?? null,
    toMysqlDatetime(dc.whenCreated),
    dc.isPdc ? 1 : 0,
    dc.isGc ? 1 : 0,
    dc.isRidMaster ? 1 : 0,
    dc.isSchemaMaster ? 1 : 0,
    dc.isDomainNamingMaster ? 1 : 0,
    dc.isInfrastructureMaster ? 1 : 0,
    toMysqlDatetime(collectedAt),
    agentId
  ]);
}