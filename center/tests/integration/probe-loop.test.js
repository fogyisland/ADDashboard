// probe-loop.test.js — verifies createProbeLoop's public API works end-to-end
// against in-process HTTP servers and a real MySQL probe_state table.
//
// Gated on TEST_MYSQL_URL per project convention (see
// feedback_real_db_sql_tests.md). When the env var is not set the test is
// skipped so the suite stays green on dev machines without a live DB.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProbeLoop } from '../../src/services/probe.js';
import { init, close, getDb } from '../../src/db/index.js';
import { writeAudit } from '../../src/services/audit.js';
import { parseTestUrl } from './_url.js';

test('integration: probe loop writes probe_state after 3 ticks against real local servers', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  // Spin up 3 tiny HTTP servers that always return 200 /healthz.
  const servers = [];
  const ports = [];
  for (let i = 0; i < 3; i++) {
    const s = http.createServer((req, res) => {
      if (req.url === '/healthz') { res.writeHead(200, {'Content-Type':'application/json'}); res.end('{"status":"ok"}'); }
      else { res.writeHead(404); res.end(); }
    });
    await new Promise(r => s.listen(0, r));
    servers.push(s);
    ports.push(s.address().port);
  }

  // Boot a real MySQL driver against the test DB. parseTestUrl throws if
  // TEST_MYSQL_URL is unset, but the test is gated on that env var above so
  // it's safe to throw here.
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'addashboard', user, password } },
    listenPort: 8080,
    jwtSecret: 'x',
    agentToken: 'x',
    staticDir: './dist',
    logLevel: 'silent',
    env: 'test'
  });
  const db = getDb();

  // Snapshot probe_state rows we're about to touch so we can restore them in
  // finally — the seed rows for web/heartbeat/report are owned by migration
  // 012 and other tests assume the post-seed baseline.
  const { rows: before } = await db.query(db.sql.probeState.getAll);
  const baseline = new Map(before.map(r => [r.port_role, {
    status: r.status,
    latency_ms: r.latency_ms,
    last_probe_at: r.last_probe_at,
    last_up_at: r.last_up_at,
    consecutive_failures: r.consecutive_failures
  }]));

  const probe = createProbeLoop({
    db,
    ports: { web: ports[0], heartbeat: ports[1], report: ports[2] },
    logger: { child: () => ({ info(){}, warn(){}, error(){} }) },
    writeAudit
  });
  probe.start();
  try {
    // Wait long enough for ≥3 ticks (1Hz interval). Give a generous buffer
    // so CI under load doesn't flake the timing assertion.
    await new Promise(r => setTimeout(r, 3500));
    await probe.stop();

    const { rows } = await db.query(db.sql.probeState.getAll);
    assert.strictEqual(rows.length, 3, `expected 3 probe_state rows, got ${rows.length}`);
    for (const row of rows) {
      assert.strictEqual(row.status, 'healthy', `${row.port_role} should be healthy`);
      assert.ok(row.last_probe_at, `${row.port_role} last_probe_at must be set`);
    }
  } finally {
    // Restore baseline rows so we don't pollute the seed for other tests.
    try {
      for (const [role, snap] of baseline) {
        await db.execute(db.sql.probeState.upsertRow(
          role, snap.status, snap.latency_ms,
          snap.last_probe_at, snap.last_up_at,
          Number(snap.consecutive_failures) || 0
        ));
      }
    } catch {}
    for (const s of servers) s.close();
    try { await close(); } catch {}
  }
});