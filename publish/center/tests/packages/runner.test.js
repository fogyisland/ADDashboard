// runner.test.js — covers center/src/packages/runner.js (agent endpoints)
// against the mock db. Each test mounts the runner on a fresh Express
// app with the REAL agentToken middleware wired inside the router. Tests
// must send the matching `X-Agent-Token` header; the 401 regression test
// confirms no agent can hit the endpoints without the token.
//
// Endpoints:
//   GET  /api/agent/packages
//   GET  /api/agent/packages/:name/script
//   POST /api/agent/packages/report

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { default as supertest } from 'supertest';
import { buildMockDb } from '../helpers/db-mock.js';
import { packageRunner } from '../../src/packages/runner.js';

const AGENT_ID = 'agent-1';
const TEST_TOKEN = 'test-agent-token';

function buildApp(db, opts = {}) {
  const app = express();
  app.use(express.json());
  app.use(packageRunner({
    db,
    getLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    config: { agentToken: opts.agentToken ?? TEST_TOKEN }
  }));
  return app;
}

function authHeader() {
  return { 'X-Agent-Token': TEST_TOKEN, 'X-Agent-Id': AGENT_ID };
}

// Pre-stage an enabled package with a real script on disk so the
// runner's readFileSync() can find it.
function seedEnabledPackage(name, version, manifest) {
  const cacheDir = path.join(process.cwd(), 'data', 'packages', name, version);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(cacheDir, 'collect.ps1'), 'Write-Output "{\"metrics\":{\"m1\":42}}"');
}

describe('agent /api/agent/packages', () => {
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

  before(() => {
    seedEnabledPackage(fixtureName, '1.0.0', fixtureManifest);
  });

  after(() => {
    fs.rmSync(path.join(process.cwd(), 'data', 'packages', fixtureName), {
      recursive: true,
      force: true
    });
  });

  test('GET /packages returns enabled packages with manifest + base64 script', async () => {
    const db = buildMockDb([
      {
        // installedPackages.list(enabledOnly=true) — built SQL is `SELECT * FROM installed_packages WHERE enabled = 1 ORDER BY name`
        match: /FROM\s+installed_packages\s+WHERE\s+enabled\s*=\s*1/i,
        rows: [{
          name: fixtureName,
          version: '1.0.0',
          type: 'gauge',
          manifest_json: JSON.stringify(fixtureManifest),
          enabled: 1,
          params_json: null
        }]
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
    assert.deepEqual(p.manifest, fixtureManifest);
    // base64 of "Write-Output ..." should round-trip
    const decoded = Buffer.from(p.script, 'base64').toString('utf8');
    assert.match(decoded, /Write-Output/);
  });

  test('GET /packages/:name/script returns script for enabled pkg', async () => {
    const db = buildMockDb([
      {
        match: /FROM\s+installed_packages\s+WHERE\s+name\s*=\s*\?/i,
        rows: [{
          name: fixtureName,
          version: '1.0.0',
          type: 'gauge',
          manifest_json: JSON.stringify(fixtureManifest),
          enabled: 1,
          params_json: null
        }]
      }
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
    const db = buildMockDb([
      {
        match: /FROM\s+installed_packages\s+WHERE\s+name\s*=\s*\?/i,
        rows: [{
          name: fixtureName,
          version: '1.0.0',
          type: 'gauge',
          manifest_json: JSON.stringify(fixtureManifest),
          enabled: 0,
          params_json: null
        }]
      }
    ]).standard();
    const app = buildApp(db);
    const r = await supertest(app).get(`/api/agent/packages/${fixtureName}/script`).set(authHeader());
    assert.equal(r.status, 404);
  });

  test('POST /packages/report ingests metrics and records runs', async () => {
    // The mock db returns `{ rows: [...], affectedRows: 1 }` for any
    // unmatched query, so the runner's package_runs INSERT +
    // metric_gauge UPSERT fall through to the default shape. We use a
    // recording pool to assert the runner actually issued those writes.
    const records = [];
    const db = buildMockDb([
      {
        match: /FROM\s+installed_packages\s+WHERE\s+name\s*=\s*\?/i,
        rows: [{
          name: fixtureName,
          version: '1.0.0',
          type: 'gauge',
          manifest_json: JSON.stringify(fixtureManifest),
          enabled: 1,
          params_json: null
        }]
      }
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

    // The runner should have called:
    //   - installedPackages.get → SELECT from installed_packages
    //   - packageRuns.insert    → INSERT INTO package_runs
    //   - metricGauge.upsertLatest → INSERT INTO metric_gauge
    // Verify the metric_gauge upsert fired with the right metric_id.
    const gaugeUpsert = records.find(
      (c) => /INSERT INTO\s+metric_gauge/i.test(c.sql)
    );
    assert.ok(gaugeUpsert, 'expected metric_gauge INSERT to fire');
    // params: [agent_id, metric_id, ts, value, unit, threshold_warn, threshold_crit]
    assert.equal(gaugeUpsert.params[0], AGENT_ID);
    assert.equal(gaugeUpsert.params[1], `${fixtureName}.m1`);
    assert.equal(gaugeUpsert.params[3], 80);

    // And the package_runs INSERT should have fired with exitCode=0.
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
    const db = buildMockDb([
      {
        match: /FROM\s+installed_packages\s+WHERE\s+name\s*=\s*\?/i,
        rows: [{
          name: fixtureName,
          version: '1.0.0',
          type: 'gauge',
          manifest_json: JSON.stringify(fixtureManifest),
          enabled: 1,
          params_json: null
        }]
      }
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
    const db = buildMockDb([]).standard();
    const app = buildApp(db);
    const r = await supertest(app)
      .post('/api/agent/packages/report')
      .set(authHeader())
      .send({ runs: 'not-an-array' });
    assert.equal(r.status, 400);
  });

  test('POST /packages/report skips + records error for unknown package', async () => {
    const db = buildMockDb([
      // installedPackages.get returns [] for the unknown name → error path.
      {
        match: /FROM\s+installed_packages\s+WHERE\s+name\s*=\s*\?/i,
        rows: []
      }
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
    const db = buildMockDb([]).standard();
    const app = buildApp(db);
    const r = await supertest(app).get('/api/agent/packages');
    assert.equal(r.status, 401);
  });

  // ---- AUTH WIRING (regression: real agentToken must gate endpoints) ----

  describe('AUTH WIRING', () => {
    test('POST /packages/report: 401 without X-Agent-Token header', async () => {
      const db = buildMockDb([]).standard();
      const app = buildApp(db);
      const r = await supertest(app)
        .post('/api/agent/packages/report')
        .set('X-Agent-Id', AGENT_ID)
        .send({ runs: [] });
      assert.equal(r.status, 401);
    });

    test('GET /packages/:name/script: 401 with wrong agent token', async () => {
      const db = buildMockDb([]).standard();
      const app = buildApp(db);
      const r = await supertest(app)
        .get(`/api/agent/packages/${fixtureName}/script`)
        .set('X-Agent-Token', 'wrong-token');
      assert.equal(r.status, 401);
    });
  });
});