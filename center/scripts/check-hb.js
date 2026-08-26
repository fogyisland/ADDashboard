// One-off heartbeat timestamp diagnostic.
// Run: node scripts/check-hb.js
import { init, getDb } from '../src/db/index.js';
import fs from 'node:fs/promises';

const cfg = JSON.parse(await fs.readFile('appsettings.json', 'utf8'));
await init(cfg);
const db = getDb();

const rows = await db.query(`
  SELECT agent_id, last_heartbeat_at, UTC_TIMESTAMP() AS now_utc,
         NOW() AS now_local,
         TIMESTAMPDIFF(SECOND, last_heartbeat_at, UTC_TIMESTAMP()) AS gap_sec
  FROM ad_agent_heartbeat
  ORDER BY last_heartbeat_at DESC LIMIT 10
`);
console.log(JSON.stringify(rows, null, 2));
process.exit(0);