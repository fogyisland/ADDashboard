// One-off live verify that the running center's heartbeat-report endpoint
// surfaces reportRequestedAt. Runs the same SQL the service runs.
import { init, getDb } from '../src/db/index.js';
import fs from 'node:fs/promises';

const cfg = JSON.parse(await fs.readFile('appsettings.json', 'utf8'));
await init(cfg);
const db = getDb();
const { rows } = await db.query(db.sql.heartbeat.agentsList);
console.log(JSON.stringify(rows.map(r => ({
  agent_id: r.agent_id,
  report_requested_at: r.report_requested_at,
  last_heartbeat_at: r.last_heartbeat_at,
  last_report_at: r.last_report_at
})), null, 2));
process.exit(0);