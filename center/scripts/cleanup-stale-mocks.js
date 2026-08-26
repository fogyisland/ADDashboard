// One-off cleanup of stale mock-agent rows that confuse the heartbeat UI.
// Stale = no heartbeat write in the last 30 minutes AND agent_id matches the
// mock-* naming pattern (don't touch real DESKTOP-* / production rows).
//
// Run: node scripts/cleanup-stale-mocks.js
//
// 2026-08-26 round-19: mock agent IDs switched from generic MOCK-DC-* to the
// operator's real DC names (ncadserv1 / fzadsrv1 / hubadsrv1 / xmadsrv1) so
// the dashboard view mirrors production. The MOCK-% catch-all is kept for
// legacy rows from earlier sessions, and the four real-name rows are added
// as an explicit list so the script also catches a hung mock daemon that
// stopped mid-cycle. Without the explicit list, the LIKE filter would NOT
// match ncadserv1 and a hung daemon would leak rows until manual cleanup.
import { init, getDb } from '../src/db/index.js';
import fs from 'node:fs/promises';

const cfg = JSON.parse(await fs.readFile('appsettings.json', 'utf8'));
await init(cfg);
const db = getDb();

const MOCK_AGENT_IDS = ['ncadserv1', 'fzadsrv1', 'hubadsrv1', 'xmadsrv1'];
const MOCK_PLACEHOLDERS = MOCK_AGENT_IDS.map(() => '?').join(', ');

// First, show what we're about to touch.
// "Stale" = no live mock is sending heartbeats for this id, AND the row is
// either ahead of UTC clock (impossible) or older than 30min. Real DESKTOP-*
// / production rows are NEVER matched (LIKE 'MOCK-%' OR explicit IN-list
// of known mock IDs only).
const candidates = await db.query(`
  SELECT agent_id, last_heartbeat_at, TIMESTAMPDIFF(SECOND, last_heartbeat_at, UTC_TIMESTAMP()) AS gap_sec
  FROM ad_agent_heartbeat
  WHERE (agent_id LIKE 'MOCK-%' OR agent_id IN (${MOCK_PLACEHOLDERS}))
    AND (
      last_heartbeat_at > UTC_TIMESTAMP() + INTERVAL 1 MINUTE  -- impossible: in the future
      OR last_heartbeat_at < UTC_TIMESTAMP() - INTERVAL 30 MINUTE  -- abandoned > 30min ago
    )
  ORDER BY last_heartbeat_at DESC
`, MOCK_AGENT_IDS);
const rows = candidates.rows ?? candidates;
console.log('stale mock rows to delete:');
console.log(JSON.stringify(rows, null, 2));

if (rows.length === 0) {
  console.log('nothing to clean up');
  process.exit(0);
}

const result = await db.execute(`
  DELETE FROM ad_agent_heartbeat
  WHERE (agent_id LIKE 'MOCK-%' OR agent_id IN (${MOCK_PLACEHOLDERS}))
    AND (
      last_heartbeat_at > UTC_TIMESTAMP() + INTERVAL 1 MINUTE
      OR last_heartbeat_at < UTC_TIMESTAMP() - INTERVAL 30 MINUTE
    )
`, MOCK_AGENT_IDS);
console.log(`deleted ${result.affectedRows} row(s)`);
process.exit(0);