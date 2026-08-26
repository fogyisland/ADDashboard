// One-off cleanup of stale mock-agent rows that confuse the heartbeat UI.
// Stale = no heartbeat write in the last 30 minutes AND agent_id matches the
// mock-* naming pattern (don't touch real DESKTOP-* / production rows).
//
// Run: node scripts/cleanup-stale-mocks.js
//
// 2026-08-26 round-19 follow-up: mock agent IDs use MOCK-<NAME> prefix to
// avoid collision with REAL production DCs sharing the same hostname. The
// MOCK-% catch-all is kept for legacy rows from earlier sessions, and the
// eight current mock names are listed explicitly so a hung daemon that
// stopped mid-cycle doesn't leak rows. Each site now has 2 DC variants
// ("<site>adsrv1" and "<site>adsrv2") to exercise the multi-DC-per-site
// dashboard view.
import { init, getDb } from '../src/db/index.js';
import fs from 'node:fs/promises';

const cfg = JSON.parse(await fs.readFile('appsettings.json', 'utf8'));
await init(cfg);
const db = getDb();

const MOCK_AGENT_IDS = [
  'MOCK-NCADSRV1', 'MOCK-NCADSRV2',
  'MOCK-FZADSRV1', 'MOCK-FZADSRV2',
  'MOCK-XMADSRV1', 'MOCK-XMADSRV2',
  'MOCK-HUBADSRV1', 'MOCK-HUBADSRV2'
];
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