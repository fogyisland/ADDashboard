import { getDb } from '../db/index.js';
import { isValidPort } from './ports.js';

// Upsert per-port probe results for a single agent. Called from the heartbeat
// route. Rows in `portRows` whose port is invalid OR absent from system_ports
// are silently rejected (defense against admin-removed ports lingering on
// agents). Rejection count is returned to the caller for logging.
export async function upsertPortStatuses(agentId, portRows, { validPortsSet }) {
  if (!Array.isArray(portRows)) return { accepted: 0, rejected: 0 };
  const db = getDb();
  let accepted = 0;
  let rejected = 0;
  await db.transaction(async () => {
    for (const row of portRows) {
      if (!row || typeof row !== 'object') { rejected++; continue; }
      const port = Number(row.port);
      if (!isValidPort(port) || !validPortsSet.has(port)) { rejected++; continue; }
      const ok = row.ok === true ? 1 : 0;
      const latencyMs = row.latencyMs == null ? null : Number(row.latencyMs);
      if (latencyMs != null && (!Number.isFinite(latencyMs) || latencyMs < 0)) {
        rejected++;
        continue;
      }
      await db.execute(db.sql.portStatus.upsertOne, [
        agentId, port, ok, latencyMs, new Date()
      ]);
      accepted++;
    }
  });
  return { accepted, rejected };
}

export async function listPortStatusesForAgents(agentIds) {
  if (!Array.isArray(agentIds) || agentIds.length === 0) return [];
  const db = getDb();
  const placeholders = agentIds.map(() => '?').join(', ');
  const { rows } = await db.query(db.sql.portStatus.listForAgents(placeholders), agentIds);
  return rows;
}