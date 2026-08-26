// metricstore-local-port-check.test.js — unit tests for the ad_local_port_check
// v2 package's metric shape, exercising metricstore.ingestRunV2 with a mocked
// db.execute. The package's collect.ps1 emits five port_<N> columns holding
// JSON shapes { reachable, latencyMs, error }; these tests verify that:
//   1. All five port_<N> columns round-trip with the expected SQL shape.
//   2. Different reachability combinations (all reachable, all unreachable,
//      mixed) bind correctly into the INSERT params.
//   3. PKG_METRIC_KEY_UNKNOWN fires when a key is emitted that isn't in the
//      declared metricSchema (defense against typo'd PS1 output).
//   4. The server clock (ts) is stamped by the center, not from PS1 stdout.
//
// Mocked db.execute pattern matches tests/packages/metricstore.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metricstore } from '../../src/packages/metricstore.js';

const PORTS = [135, 445, 50001, 50002, 50003];
const PORT_KEYS = PORTS.map(p => `port_${p}`);

const MANIFEST = {
  name: 'ad-local-port-check',
  version: '1.0.0',
  type: 'gauge',
  description: 'Probe local-machine ports [135, 445, 50001, 50002, 50003] for self-health check.',
  agent: {
    type: 'ad',
    minVersion: '0.1.0',
    platforms: ['windows'],
    runtime: 'powershell',
    script: 'collect.ps1',
    timeoutMs: 30000,
    intervalSec: 300
  },
  database: {
    schemaName: 'pkg_ad_local_port_check',
    migrations: ['migrations/001_initial.sql'],
    metricTable: 'metrics',
    metricSchema: {
      agent_id:   { type: 'varchar(64)', nullable: false },
      ts:         { type: 'datetime',    nullable: false },
      port_135:   { type: 'json' },
      port_445:   { type: 'json' },
      port_50001: { type: 'json' },
      port_50002: { type: 'json' },
      port_50003: { type: 'json' }
    }
  }
};

// reachable shape used by collect.ps1 on a successful probe.
function reachable(latencyMs = 25) {
  return { reachable: true, latencyMs, error: null };
}

// unreachable shape used on timeout or other failure.
function unreachable(errorMsg = 'timeout') {
  return { reachable: false, latencyMs: null, error: errorMsg };
}

// Mocked db.execute that records every call and returns a successful INSERT.
function makeMockDb() {
  const calls = [];
  return {
    dialect: 'mysql',
    async execute(sql, params = []) {
      calls.push({ sql, params: [...params] });
      return { rows: [], affectedRows: 1 };
    },
    _calls: calls
  };
}

// Build a metrics object with all five port_<N> columns populated from a
// caller-supplied factory.
function buildAllPorts(portFactory) {
  const m = { agent_id: 'host-001' };
  for (const k of PORT_KEYS) m[k] = portFactory(k);
  return m;
}

test('local-port-check: all ports reachable round-trips a single INSERT into pkg_ad_local_port_check.metrics', async () => {
  const db = makeMockDb();
  const metrics = buildAllPorts(() => reachable(15));

  await metricstore.ingestRun(db, {
    agentId: 'host-001',
    packageName: 'ad-local-port-check',
    manifest: MANIFEST,
    runs: [{ metrics, error: null }]
  });

  // Exactly one INSERT was issued against the package schema.
  const inserts = db._calls.filter(c => /INSERT\s+INTO/i.test(c.sql));
  assert.strictEqual(inserts.length, 1, 'expected one INSERT');
  assert.match(inserts[0].sql, /`pkg_ad_local_port_check`\.`metrics`/);
  // Column list (commas with optional spaces).
  assert.match(inserts[0].sql, /\(agent_id,\s*ts,\s*port_135,\s*port_445,\s*port_50001,\s*port_50002,\s*port_50003\)/);

  // First two params are agentId (from caller) and ts (server clock).
  const [agentId, ts, ...rest] = inserts[0].params;
  assert.strictEqual(agentId, 'host-001');
  assert.ok(ts instanceof Date, 'ts param must be a Date stamped by the center, not the script');
  // The remaining five params are the JSON shapes, in manifest column order.
  assert.strictEqual(rest.length, 5);
  for (const v of rest) {
    assert.deepStrictEqual(v, { reachable: true, latencyMs: 15, error: null });
  }
});

test('local-port-check: ALL ports unreachable still round-trips with error=null path covered', async () => {
  const db = makeMockDb();
  const metrics = buildAllPorts(() => unreachable('timeout'));

  await metricstore.ingestRun(db, {
    agentId: 'host-001',
    packageName: 'ad-local-port-check',
    manifest: MANIFEST,
    runs: [{ metrics, error: null }]
  });

  const inserts = db._calls.filter(c => /INSERT\s+INTO/i.test(c.sql));
  assert.strictEqual(inserts.length, 1);
  const [agentId, ts, ...rest] = inserts[0].params;
  assert.strictEqual(agentId, 'host-001');
  assert.ok(ts instanceof Date);
  assert.strictEqual(rest.length, 5);
  for (const v of rest) {
    assert.strictEqual(v.reachable, false);
    assert.strictEqual(v.latencyMs, null);
    assert.strictEqual(v.error, 'timeout');
  }
});

test('local-port-check: mixed reachability (some reachable, some timeout, some error message) round-trips distinct shapes', async () => {
  const db = makeMockDb();
  // Each port gets a different shape so the INSERT binds a heterogeneous set.
  const metrics = {
    agent_id: 'host-001',
    port_135: reachable(20),
    port_445: reachable(35),
    port_50001: unreachable('timeout'),
    port_50002: unreachable('No connection could be made because the target machine actively refused it 127.0.0.1:50002'),
    port_50003: reachable(120)
  };

  await metricstore.ingestRun(db, {
    agentId: 'host-001',
    packageName: 'ad-local-port-check',
    manifest: MANIFEST,
    runs: [{ metrics, error: null }]
  });

  const inserts = db._calls.filter(c => /INSERT\s+INTO/i.test(c.sql));
  assert.strictEqual(inserts.length, 1);
  const [agentId, ts, p135, p445, p50001, p50002, p50003] = inserts[0].params;
  assert.strictEqual(agentId, 'host-001');
  assert.ok(ts instanceof Date);
  assert.deepStrictEqual(p135, { reachable: true, latencyMs: 20, error: null });
  assert.deepStrictEqual(p445, { reachable: true, latencyMs: 35, error: null });
  assert.deepStrictEqual(p50001, { reachable: false, latencyMs: null, error: 'timeout' });
  assert.deepStrictEqual(p50002, { reachable: false, latencyMs: null, error: 'No connection could be made because the target machine actively refused it 127.0.0.1:50002' });
  assert.deepStrictEqual(p50003, { reachable: true, latencyMs: 120, error: null });
});

test('local-port-check: unknown top-level key triggers PKG_METRIC_KEY_UNKNOWN', async () => {
  // The contract is: PS1 emits exactly the declared columns at the top level.
  // Any extra top-level key (typo, leftover debug field) must be rejected.
  // Note: nested object structure inside a declared column (e.g. extra
  // `debug` field inside port_135's JSON shape) is NOT validated by
  // metricstore — the JSON is bound as-is. The check is strictly on top-level
  // keys.
  const db = makeMockDb();
  const metrics = {
    ...buildAllPorts(() => reachable(10)),
    rogue_field: 'leaked'
  };

  await assert.rejects(
    () => metricstore.ingestRun(db, {
      agentId: 'host-001',
      packageName: 'ad-local-port-check',
      manifest: MANIFEST,
      runs: [{ metrics, error: null }]
    }),
    (err) => err.code === 'PKG_METRIC_KEY_UNKNOWN' && err.message.includes('rogue_field')
  );
});

test('local-port-check: typo in a port column name (port_136 instead of port_135) triggers PKG_METRIC_KEY_UNKNOWN', async () => {
  // The brief mandates snake_case column names; a typo must NOT silently
  // round-trip as an empty value. Reject the typo and surface the diff.
  const db = makeMockDb();
  const metrics = {
    agent_id: 'host-001',
    port_136: reachable(10),  // typo: should be port_135
    port_445: reachable(10),
    port_50001: reachable(10),
    port_50002: reachable(10),
    port_50003: reachable(10)
  };

  await assert.rejects(
    () => metricstore.ingestRun(db, {
      agentId: 'host-001',
      packageName: 'ad-local-port-check',
      manifest: MANIFEST,
      runs: [{ metrics, error: null }]
    }),
    (err) => err.code === 'PKG_METRIC_KEY_UNKNOWN' && err.message.includes('port_136')
  );
});

test('local-port-check: error=null path is allowed (reachable probe with error explicitly null)', async () => {
  // The brief specifies error=<string|null>; a successful probe must set
  // error=null (not omit the key). Verify metricstore accepts the explicit
  // null value alongside reachable=true and a numeric latencyMs.
  const db = makeMockDb();
  const metrics = buildAllPorts(() => ({ reachable: true, latencyMs: 7, error: null }));

  await metricstore.ingestRun(db, {
    agentId: 'host-001',
    packageName: 'ad-local-port-check',
    manifest: MANIFEST,
    runs: [{ metrics, error: null }]
  });

  const inserts = db._calls.filter(c => /INSERT\s+INTO/i.test(c.sql));
  assert.strictEqual(inserts.length, 1);
  for (const v of inserts[0].params.slice(2)) {
    assert.strictEqual(v.error, null);
    assert.strictEqual(v.reachable, true);
    assert.strictEqual(typeof v.latencyMs, 'number');
  }
});

test('local-port-check: ts is stamped by the center, not taken from PS1 stdout', async () => {
  const db = makeMockDb();
  // Even if PS1 were to (incorrectly) emit a ts field, metricstore ignores it
  // because ts is reserved and always prepended. Verify by including ts in
  // the emitted metrics: it must not trigger PKG_METRIC_KEY_UNKNOWN because
  // ts is in the metricSchema, and it must NOT be bound to the INSERT param.
  const before = Date.now();
  const metrics = {
    ...buildAllPorts(() => reachable(5)),
    ts: '2099-12-31T23:59:59Z'  // bogus value the script might leak
  };
  const after = Date.now();

  await metricstore.ingestRun(db, {
    agentId: 'host-001',
    packageName: 'ad-local-port-check',
    manifest: MANIFEST,
    runs: [{ metrics, error: null }]
  });

  const inserts = db._calls.filter(c => /INSERT\s+INTO/i.test(c.sql));
  assert.strictEqual(inserts.length, 1);
  const ts = inserts[0].params[1];
  assert.ok(ts instanceof Date);
  // ts must be a fresh Date stamp from the ingest path, not the bogus value.
  assert.notStrictEqual(ts.getTime(), new Date('2099-12-31T23:59:59Z').getTime());
  assert.ok(ts.getTime() >= before && ts.getTime() <= after, 'ts must fall within the call window');
});

test('local-port-check: errored runs are skipped (no INSERT issued)', async () => {
  const db = makeMockDb();
  const metrics = buildAllPorts(() => reachable(15));

  await metricstore.ingestRun(db, {
    agentId: 'host-001',
    packageName: 'ad-local-port-check',
    manifest: MANIFEST,
    runs: [{ metrics, error: 'powershell crashed' }]
  });

  const inserts = db._calls.filter(c => /INSERT\s+INTO/i.test(c.sql));
  assert.strictEqual(inserts.length, 0, 'errored run must not INSERT');
});