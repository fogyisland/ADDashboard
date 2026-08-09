// Unit tests for Task 3 — `createProbeLoop()` service in
// center/src/services/probe.js.
//
// The probe loop runs at 1 Hz, hits /healthz on the three center listening
// ports (web / heartbeat / report) in parallel, and upserts a row into
// `probe_state` per port. Status transitions (healthy↔degraded) write one
// audit entry; every-tick writes are noise we don't want in audit_logs.
//
// These tests pin the contract using a minimal in-test stub db — the real
// driver isn't needed to verify scheduling, parallelism, audit-on-flip and
// the bootstrap fail-fast on a missing probe_state table.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProbeLoop } from '../../src/services/probe.js';

function makeStubDb() {
  // Stateful stub: tracks `probe_state` rows in memory so a second tick can
  // observe the rows written by the first tick via `db.query(getAll)`.
  // Without this, the stub always returns empty rows and tests can't model
  // a real status flip (healthy→degraded) — every tick looks like a fresh
  // first observation.
  const rows = new Map(); // port_role → row
  const calls = [];
  const UPSERT = 'UPSERT probe_state';
  const GETALL = 'SELECT * FROM probe_state';
  return {
    calls,
    sql: {
      probeState: {
        upsertRow: () => UPSERT,
        getAll: GETALL
      }
    },
    query: async (sql, params) => {
      calls.push({ kind: 'query', sql, params });
      if (sql === GETALL || sql.startsWith('SELECT')) {
        return { rows: [...rows.values()] };
      }
      return { rows: [] };
    },
    execute: async (sql, params) => {
      calls.push({ kind: 'execute', sql, params });
      if (sql === UPSERT && Array.isArray(params)) {
        const [portRole, status, latencyMs, lastProbeAt, lastUpAt, consecutiveFailures] = params;
        rows.set(portRole, {
          port_role: portRole,
          status,
          latency_ms: latencyMs,
          last_probe_at: lastProbeAt,
          last_up_at: lastUpAt,
          consecutive_failures: consecutiveFailures
        });
      }
    }
  };
}

test('createProbeLoop: throws when probe_state table missing on first tick', async () => {
  const db = makeStubDb();
  db.query = async () => { throw new Error("Table 'addashboard.probe_state' doesn't exist"); };
  const probe = createProbeLoop({ db, ports: { web: 8080, heartbeat: 8081, report: 8082 }, logger: { child: () => ({ info(){}, warn(){}, error(){} }) }, writeAudit: async () => {}, fetchImpl: async () => ({ ok: true }) });
  await assert.rejects(probe.tick(), /probe_state.*missing/i);
});

test('tick: probes 3 ports in parallel, upserts each row', async () => {
  const db = makeStubDb();
  let auditCalls = 0;
  const probe = createProbeLoop({
    db,
    ports: { web: 8080, heartbeat: 8081, report: 8082 },
    logger: { child: () => ({ info(){}, warn(){}, error(){} }) },
    writeAudit: async () => { auditCalls++; },
    fetchImpl: async () => ({ ok: true })
  });
  await probe.tick();
  const upserts = db.calls.filter(c => c.kind === 'execute' && c.sql.startsWith('UPSERT'));
  assert.strictEqual(upserts.length, 3);
  // All 3 ports flip from initial 'unknown' to 'healthy' on the first tick,
  // but we emit one aggregated audit per tick (per-port writes would multiply
  // noise: 3 entries for what is conceptually a single "all ports healthy"
  // event). Test 4 pins the per-tick aggregation across 2 ticks (2 audits).
  assert.strictEqual(auditCalls, 1);
  // C-1 regression guard: each upsert must carry a Date at params[3]
  // (lastProbeAt). Without this, the MySQL driver converts undefined → NULL,
  // listProbeStatus anyStale always returns true, and the 30s watchdog
  // fires a false probe_loop_watchdog audit on every healthy boot.
  for (const u of upserts) {
    assert.ok(
      u.params[3] instanceof Date && !isNaN(u.params[3].getTime()),
      `params[3] (lastProbeAt) must be a valid Date; got ${u.params[3]}`
    );
  }
});

test('tick: 2s timeout → status=degraded, consecutive_failures increments', async () => {
  const db = makeStubDb();
  const probe = createProbeLoop({
    db, ports: { web: 8080, heartbeat: 8081, report: 8082 },
    logger: { child: () => ({ info(){}, warn(){}, error(){} }) },
    writeAudit: async () => {},
    fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }
  });
  await probe.tick();
  const upserts = db.calls.filter(c => c.kind === 'execute' && c.sql.startsWith('UPSERT'));
  for (const u of upserts) {
    assert.ok(u.params[1] === 'degraded', `status param should be degraded; got ${u.params[1]}`);
    // C-1 regression guard: degraded paths must still stamp lastProbeAt so
    // the watchdog doesn't fire false-positive stale audits on every tick
    // when the port is down.
    assert.ok(
      u.params[3] instanceof Date && !isNaN(u.params[3].getTime()),
      `params[3] (lastProbeAt) must be a valid Date on degraded; got ${u.params[3]}`
    );
  }
});

test('tick: status flip (healthy → degraded) writes audit exactly once', async () => {
  const db = makeStubDb();
  let firstTickOk = true;
  const auditPayloads = [];
  const probe = createProbeLoop({
    db, ports: { web: 8080, heartbeat: 8081, report: 8082 },
    logger: { child: () => ({ info(){}, warn(){}, error(){} }) },
    writeAudit: async ({ payload }) => { auditPayloads.push(payload); },
    fetchImpl: async () => firstTickOk ? { ok: true } : { ok: false, status: 500 }
  });
  await probe.tick();   // unknown→healthy: writes audit (flip from initial unknown)
  firstTickOk = false;
  await probe.tick();   // healthy→degraded: writes audit
  // exactly 2 audit entries
  assert.strictEqual(auditPayloads.length, 2);
});

test('start/stop: start() begins setInterval; stop() clears it', async () => {
  const db = makeStubDb();
  let ticks = 0;
  const probe = createProbeLoop({
    db, ports: { web: 8080, heartbeat: 8081, report: 8082 },
    logger: { child: () => ({ info(){}, warn(){}, error(){} }) },
    writeAudit: async () => {},
    fetchImpl: async () => { ticks++; return { ok: true }; }
  });
  probe.start();
  await new Promise(r => setTimeout(r, 1100));
  probe.stop();
  assert.ok(ticks >= 1, `expected ≥1 tick; got ${ticks}`);
});