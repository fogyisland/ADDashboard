// runner.test.js — R66 Task 8: covers center/src/packages/runner.js
// (agent endpoints) against the mock db. The runner now JOINs
// `package_policies` + `package_scripts` instead of reading from
// `installed_packages` and the on-disk collect.ps1 file. The agent-facing
// wire format is byte-identical: the list endpoint emits the same envelope
// `{packages: [{name, version, manifest, script, params}]}` with
// `manifest.agent.intervalSec` / `manifest.agent.timeoutMs` baked in from
// the policy row. This file is mock-DB-only (no live MySQL/MSSQL).
//
// Endpoints:
//   GET  /api/agent/packages
//   GET  /api/agent/packages/:name/script
//   POST /api/agent/packages/report

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { buildMockDb } from '../helpers/db-mock.js';
import { packageRunner } from '../../src/packages/runner.js';
import { agentToken } from '../../src/auth/agent-token.js';

const AGENT_ID = 'agent-1';
const TEST_TOKEN = 'test-agent-token';

// R66 / I3 (Task 5): agentToken middleware reads the bundle from the db
// facade at request time. Inject a script that matches the bundle SELECT
// so the middleware sees agent_token_current = TEST_TOKEN and accepts
// the X-Agent-Token header instead of 503'ing.
const TOKEN_BUNDLE_REGEX = /agent_token_(current|previous|rotated_at|previous_ttl_days)/i;
const TOKEN_BUNDLE_SCRIPT = { match: TOKEN_BUNDLE_REGEX, rows: [{ config_key: 'agent_token_current', config_value: TEST_TOKEN }] };

// Wrap the test's scripts with the bundle script prepended so the
// middleware finds the token. Tests that don't need additional scripts
// can call `withTokenBundle()`.
function withTokenBundle(scripts = []) {
  return buildMockDb([TOKEN_BUNDLE_SCRIPT, ...scripts]);
}

// R66 Task 8 — runner signature changed to `{ db, agentMw, getLogger }`.
// Tests build the real `agentToken` middleware (so the 401-regression
// tests still gate the same way: token comes from TOKEN_BUNDLE_SCRIPT).
// `getLogger` returns a no-op so log.info() etc. don't crash the test.
function buildApp(db) {
  const app = express();
  app.use(express.json());
  const agentMw = agentToken({ db, logger: null });
  app.use(packageRunner({
    db,
    agentMw,
    getLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} })
  }));
  return app;
}

function authHeader() {
  return { 'X-Agent-Token': TEST_TOKEN, 'X-Agent-Id': AGENT_ID };
}

// JOIN row shape — produced by `db.execute(JOIN_SELECT_MYSQL, [])`. The
// JOIN writes package_scripts columns first (aliased s), then
// package_policies columns (aliased p); the mock just spreads both into
// one row. The runner's `hydrateJoinRow` reads them by snake_case key.
function joinedRow({ name, version, script_content, manifest_json, interval_sec, timeout_ms, enabled = 1, params_json = null }) {
  return {
    // package_scripts columns
    name,
    version,
    script_content,
    script_sha256: 'a'.repeat(64),
    manifest_json,
    source: 'builtin-seed',
    created_at: new Date(),
    updated_at: new Date(),
    // package_policies columns
    interval_sec,
    timeout_ms,
    enabled,
    params_json,
    scope: 'global'
  };
}

// Script-only row (package_scripts) — used by GET /:name/script and
// POST /report, both of which call `packageScripts.get(db, name)`.
function scriptOnlyRow({ name, version, script_content, manifest_json }) {
  return {
    name,
    version,
    script_content,
    script_sha256: 'a'.repeat(64),
    manifest_json,
    source: 'builtin-seed',
    created_at: new Date(),
    updated_at: new Date()
  };
}

// Policy-only row (package_policies) — used by GET /:name/script which
// calls `packagePolicies.getByName(db, name)`. Hydrate coerces
// `enabled` to boolean, but the mock returns the raw row, so we pass
// 1/0 here and trust `!policyRow.enabled` to work either way.
function policyOnlyRow({ name, interval_sec, timeout_ms, enabled = 1, params_json = null }) {
  return {
    name,
    interval_sec,
    timeout_ms,
    enabled,
    params_json,
    scope: 'global',
    created_at: new Date(),
    updated_at: new Date()
  };
}

describe('agent /api/agent/packages (R66 JOIN shape)', () => {
  const fixtureName = 'test-mem-runner';
  const fixtureManifest = {
    name: fixtureName,
    version: '1.0.0',
    type: 'gauge',
    description: 'fixture',
    agent: { minVersion: '1.0.0', script: 'collect.ps1', intervalSec: 60, timeoutMs: 30000 },
    metrics: [{ key: 'm1', label: 'M1', unit: '%', thresholds: { warn: 75, crit: 90 } }],
    params: { schema: { type: 'object' }, required: [] },
    widget: { type: 'builtin', component: 'GaugeTile' }
  };

  test('GET /packages returns enabled packages with manifest + base64 script + baked intervalSec/timeoutMs', async () => {
    const db = withTokenBundle([
      {
        // Runner fires a single JOIN against package_scripts +
        // package_policies. Our JOIN writes `FROM package_policies p
        // INNER JOIN package_scripts s ...` so package_policies
        // appears before package_scripts in the SQL — the original
        // brief's regex `/package_scripts[\s\S]+package_policies/i`
        // requires the opposite order. Use an alternation pattern that
        // matches either order (note 5: "works for both orders").
        match: /package_scripts[\s\S]+package_policies|package_policies[\s\S]+package_scripts/i,
        rows: [joinedRow({
          name: fixtureName, version: '1.0.0',
          script_content: 'Write-Output "{\"metrics\":{\"m1\":42}}"',
          manifest_json: JSON.stringify(fixtureManifest),
          interval_sec: 3600,
          timeout_ms: 30000
        })]
      }
    ]).standard();
    const app = buildApp(db);
    const r = await supertest(app).get('/api/agent/packages').set(authHeader());
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.packages));
    assert.equal(r.body.packages.length, 1);
    const p = r.body.packages[0];
    assert.equal(p.name, fixtureName);
    assert.equal(p.version, '1.0.0');
    // Byte-identical manifest shape — every manifest field preserved.
    assert.equal(p.manifest.name, fixtureName);
    assert.equal(p.manifest.type, 'gauge');
    assert.deepEqual(p.manifest.metrics, fixtureManifest.metrics);
    // Bake: policy.interval_sec/timeout_ms land at manifest.agent.*
    assert.equal(p.manifest.agent.intervalSec, 3600);
    assert.equal(p.manifest.agent.timeoutMs, 30000);
    // If the manifest already had intervalSec/timeoutMs in agent block,
    // the policy values must REPLACE them (loader is canonical).
    assert.notEqual(p.manifest.agent.intervalSec, 60); // original fixture value
    // base64 round-trip — script_content encoded as UTF-8 then base64
    const decoded = Buffer.from(p.script, 'base64').toString('utf8');
    assert.match(decoded, /Write-Output/);
    // params column is null when the policy row has params_json=null
    assert.equal(p.params, null);
  });

  test('GET /packages with no enabled rows returns empty array', async () => {
    const db = withTokenBundle([
      { match: /package_scripts[\s\S]+package_policies|package_policies[\s\S]+package_scripts/i, rows: [] }
    ]).standard();
    const app = buildApp(db);
    const r = await supertest(app).get('/api/agent/packages').set(authHeader());
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { packages: [] });
  });

  test('GET /packages/:name/script returns base64 script for enabled pkg', async () => {
    // Per-script endpoint uses TWO SELECTs (note 3) — match each.
    const db = withTokenBundle([
      { match: /FROM\s+package_scripts\s+WHERE\s+name\s*=\s*\?/i,
        rows: [scriptOnlyRow({ name: fixtureName, version: '1.0.0',
          script_content: 'Write-Output "{\"metrics\":{\"m1\":42}}"',
          manifest_json: JSON.stringify(fixtureManifest) })] },
      { match: /FROM\s+package_policies\s+WHERE\s+name\s*=\s*\?/i,
        rows: [policyOnlyRow({ name: fixtureName, interval_sec: 3600, timeout_ms: 30000, enabled: 1 })] }
    ]).standard();
    const app = buildApp(db);
    const r = await supertest(app).get(`/api/agent/packages/${fixtureName}/script`).set(authHeader());
    assert.equal(r.status, 200);
    assert.equal(r.body.name, fixtureName);
    assert.equal(r.body.version, '1.0.0');
    const decoded = Buffer.from(r.body.script, 'base64').toString('utf8');
    assert.match(decoded, /Write-Output/);
  });

  test('GET /packages/:name/script returns 404 when disabled', async () => {
    const db = withTokenBundle([
      { match: /FROM\s+package_scripts\s+WHERE\s+name\s*=\s*\?/i,
        rows: [scriptOnlyRow({ name: fixtureName, version: '1.0.0',
          script_content: 'Write-Output x',
          manifest_json: JSON.stringify(fixtureManifest) })] },
      { match: /FROM\s+package_policies\s+WHERE\s+name\s*=\s*\?/i,
        rows: [policyOnlyRow({ name: fixtureName, interval_sec: 3600, timeout_ms: 30000, enabled: 0 })] }
    ]).standard();
    const app = buildApp(db);
    const r = await supertest(app).get(`/api/agent/packages/${fixtureName}/script`).set(authHeader());
    assert.equal(r.status, 404);
  });

  test('GET /packages/:name/script returns 404 when policy row missing', async () => {
    const db = withTokenBundle([
      { match: /FROM\s+package_scripts\s+WHERE\s+name\s*=\s*\?/i,
        rows: [scriptOnlyRow({ name: fixtureName, version: '1.0.0',
          script_content: 'Write-Output x',
          manifest_json: JSON.stringify(fixtureManifest) })] },
      { match: /FROM\s+package_policies\s+WHERE\s+name\s*=\s*\?/i,
        rows: [] }
    ]).standard();
    const app = buildApp(db);
    const r = await supertest(app).get(`/api/agent/packages/${fixtureName}/script`).set(authHeader());
    assert.equal(r.status, 404);
  });

  test('POST /packages/report ingests metrics and records runs', async () => {
    // The mock db returns the default `{rows:[], affectedRows:1}` shape
    // for unmatched INSERT/UPSERT statements. The runner fires:
    //   - packageScripts.get → SELECT FROM package_scripts WHERE name=?
    //   - packageRuns.insert → INSERT INTO package_runs
    //   - metric_gauge.upsertLatest → INSERT INTO metric_gauge
    // We use a recording pool to assert the runner actually issued those
    // writes (note 9 — recording works for the unchanged INSERT SQL).
    const records = [];
    const db = withTokenBundle([
      { match: /FROM\s+package_scripts\s+WHERE\s+name\s*=\s*\?/i,
        rows: [scriptOnlyRow({ name: fixtureName, version: '1.0.0',
          script_content: 'Write-Output "{\"metrics\":{\"m1\":42}}"',
          manifest_json: JSON.stringify(fixtureManifest) })] }
    ]).withRecording(records);
    const app = buildApp(db);

    const startedAt = '2026-07-30T12:00:00.000Z';
    const finishedAt = '2026-07-30T12:00:01.000Z';
    const r = await supertest(app)
      .post('/api/agent/packages/report')
      .set(authHeader())
      .send({
        runs: [
          {
            packageName: fixtureName,
            startedAt,
            finishedAt,
            exitCode: 0,
            metrics: { m1: 80 }
          }
        ]
      });
    assert.equal(r.status, 200);
    assert.equal(r.body.processed, 1);
    assert.equal(r.body.errors.length, 0);

    // metric_gauge UPSERT fired with the right metric_id.
    const gaugeUpsert = records.find(
      (c) => /INSERT INTO\s+metric_gauge/i.test(c.sql)
    );
    assert.ok(gaugeUpsert, 'expected metric_gauge INSERT to fire');
    assert.equal(gaugeUpsert.params[0], AGENT_ID);
    assert.equal(gaugeUpsert.params[1], `${fixtureName}.m1`);
    assert.equal(gaugeUpsert.params[3], 80);

    // package_runs INSERT fired with exitCode=0.
    const runInsert = records.find(
      (c) => /INSERT INTO\s+package_runs/i.test(c.sql)
    );
    assert.ok(runInsert, 'expected package_runs INSERT to fire');
    assert.equal(runInsert.params[0], AGENT_ID);
    assert.equal(runInsert.params[1], fixtureName);
    assert.equal(runInsert.params[4], 0); // exitCode
  });

  test('POST /packages/report records the run even when error is set', async () => {
    const records = [];
    const db = withTokenBundle([
      { match: /FROM\s+package_scripts\s+WHERE\s+name\s*=\s*\?/i,
        rows: [scriptOnlyRow({ name: fixtureName, version: '1.0.0',
          script_content: 'Write-Output "{\"metrics\":{\"m1\":42}}"',
          manifest_json: JSON.stringify(fixtureManifest) })] }
    ]).withRecording(records);
    const app = buildApp(db);

    const r = await supertest(app)
      .post('/api/agent/packages/report')
      .set(authHeader())
      .send({
        runs: [
          {
            packageName: fixtureName,
            startedAt: '2026-07-30T12:00:00.000Z',
            finishedAt: '2026-07-30T12:00:01.000Z',
            exitCode: 2,
            error: 'script crashed',
            stderr: 'kaboom'
          }
        ]
      });
    assert.equal(r.status, 200);
    assert.equal(r.body.processed, 1);
    // No metric_gauge upsert should fire (no metrics payload when error).
    const gaugeUpsert = records.find((c) => /INSERT INTO\s+metric_gauge/i.test(c.sql));
    assert.equal(gaugeUpsert, undefined, 'expected no metric_gauge insert on error');
    // But the package_runs insert should still fire.
    const runInsert = records.find((c) => /INSERT INTO\s+package_runs/i.test(c.sql));
    assert.ok(runInsert, 'expected package_runs INSERT to fire even on error');
    assert.equal(runInsert.params[4], 2); // exitCode
  });

  test('POST /packages/report rejects non-array runs', async () => {
    const db = withTokenBundle().standard();
    const app = buildApp(db);
    const r = await supertest(app)
      .post('/api/agent/packages/report')
      .set(authHeader())
      .send({ runs: 'not-an-array' });
    assert.equal(r.status, 400);
  });

  test('POST /packages/report skips + records error for unknown package', async () => {
    const db = withTokenBundle([
      // packageScripts.get returns [] for the unknown name → error path.
      { match: /FROM\s+package_scripts\s+WHERE\s+name\s*=\s*\?/i, rows: [] }
    ]).standard();
    const app = buildApp(db);
    const r = await supertest(app)
      .post('/api/agent/packages/report')
      .set(authHeader())
      .send({
        runs: [
          {
            packageName: 'nope',
            startedAt: '2026-07-30T12:00:00.000Z',
            finishedAt: '2026-07-30T12:00:01.000Z',
            exitCode: 0
          }
        ]
      });
    assert.equal(r.status, 200);
    assert.equal(r.body.processed, 0);
    assert.equal(r.body.errors.length, 1);
    assert.equal(r.body.errors[0].packageName, 'nope');
    assert.match(r.body.errors[0].error, /not installed/);
  });

  test('GET /packages without agent token -> 401', async () => {
    const db = withTokenBundle().standard();
    const app = buildApp(db);
    const r = await supertest(app).get('/api/agent/packages');
    assert.equal(r.status, 401);
  });

  // ---- AUTH WIRING (regression: real agentToken must gate endpoints) ----

  describe('AUTH WIRING', () => {
    test('POST /packages/report: 401 without X-Agent-Token header', async () => {
      const db = withTokenBundle().standard();
      const app = buildApp(db);
      const r = await supertest(app)
        .post('/api/agent/packages/report')
        .set('X-Agent-Id', AGENT_ID)
        .send({ runs: [] });
      assert.equal(r.status, 401);
    });

    test('GET /packages/:name/script: 401 with wrong agent token', async () => {
      const db = withTokenBundle().standard();
      const app = buildApp(db);
      const r = await supertest(app)
        .get(`/api/agent/packages/${fixtureName}/script`)
        .set('X-Agent-Token', 'wrong-token');
      assert.equal(r.status, 401);
    });
  });
});
