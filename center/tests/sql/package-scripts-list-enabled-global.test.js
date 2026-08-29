// package-scripts-list-enabled-global.test.js — verifies the T14
// JOIN helper `db.sql.packageScripts.listEnabledGlobal`. This helper
// replaces `db.sql.installedPackages.listEnabled` after migration 023
// drops the installed_packages table.
//
// Coverage:
//   1. SQL string shape: INNER JOIN package_policies + WHERE pp.enabled=1
//   2. Route hydration: the route bakes policy.interval_sec /
//      policy.timeout_ms into manifest.agent.* at read time
//   3. Dropped rows whose manifest fails to parse (defensive — matches
//      runner.js:hydrateJoinRow behavior)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { buildSql } from '../../src/db/sql.js';
import { _setDbForTest } from '../../src/db/index.js';
import { buildMockDb } from '../helpers/db-mock.js';
import { agentPackagesRouter } from '../../src/routes/agent-packages.js';

const AGENT_TOKEN = 'agent-token-1';
const AGENT_TOKEN_BUNDLE_REGEX = /agent_token_(current|previous|rotated_at|previous_ttl_days)/i;
const TOKEN_BUNDLE_SCRIPT = { match: AGENT_TOKEN_BUNDLE_REGEX, rows: [{ config_key: 'agent_token_current', config_value: AGENT_TOKEN }] };

function withTokenBundle(extraScripts = []) {
  return buildMockDb([TOKEN_BUNDLE_SCRIPT, ...extraScripts]).standard();
}

function buildApp() {
  const a = express();
  a.use(express.json());
  a.use(agentPackagesRouter({ config: { agentToken: AGENT_TOKEN } }));
  return a;
}

// ---- 1. SQL string shape ----

test('packageScripts.listEnabledGlobal (mysql): INNER JOIN package_policies + WHERE pp.enabled=1', () => {
  const sql = buildSql('mysql');
  assert.ok(sql.packageScripts.listEnabledGlobal, 'mysql helper must exist');
  assert.match(sql.packageScripts.listEnabledGlobal, /FROM\s+package_scripts\s+ps/i);
  assert.match(sql.packageScripts.listEnabledGlobal, /INNER\s+JOIN\s+package_policies\s+pp/i);
  assert.match(sql.packageScripts.listEnabledGlobal, /ON\s+ps\.name\s*=\s*pp\.name/i);
  assert.match(sql.packageScripts.listEnabledGlobal, /WHERE\s+pp\.enabled\s*=\s*1/i);
  assert.match(sql.packageScripts.listEnabledGlobal, /ORDER\s+BY\s+ps\.name/i);
  // No `?` placeholders — the helper takes no params (enabled=1 is hardcoded).
  assert.equal((sql.packageScripts.listEnabledGlobal.match(/\?/g) || []).length, 0);
});

test('packageScripts.listEnabledGlobal (mssql): INNER JOIN package_policies + WHERE pp.enabled=1', () => {
  const sql = buildSql('mssql');
  assert.ok(sql.packageScripts.listEnabledGlobal, 'mssql helper must exist');
  assert.match(sql.packageScripts.listEnabledGlobal, /FROM\s+package_scripts\s+ps/i);
  assert.match(sql.packageScripts.listEnabledGlobal, /INNER\s+JOIN\s+package_policies\s+pp/i);
  assert.match(sql.packageScripts.listEnabledGlobal, /ON\s+ps\.name\s*=\s*pp\.name/i);
  assert.match(sql.packageScripts.listEnabledGlobal, /WHERE\s+pp\.enabled\s*=\s*1/i);
  assert.match(sql.packageScripts.listEnabledGlobal, /ORDER\s+BY\s+ps\.name/i);
  assert.equal((sql.packageScripts.listEnabledGlobal.match(/\?/g) || []).length, 0);
});

// ---- 2. Route hydration: bakeManifest at read time ----

test('route bakes policy.interval_sec + policy.timeout_ms into manifest.agent.*', async () => {
  // Mock the JOIN helper to return 2 rows with manifest_json (string —
  // MSSQL shape) + the policy columns (interval_sec / timeout_ms).
  // Route should parse manifest_json, deep-clone, bake intervalSec/
  // timeoutMs into agent block, and surface via /api/admin/agent/
  // packages-for-host.
  _setDbForTest(withTokenBundle([
    { match: /FROM\s+package_scripts\s+ps\s+INNER\s+JOIN\s+package_policies\s+pp/i, rows: [
      {
        name: 'ad-os-baseline',
        version: '1.0.0',
        script_sha256: 'sha256:abcd',
        manifest_json: JSON.stringify({ name: 'ad-os-baseline', agent: { type: 'ad' }, platforms: ['windows'] }),
        interval_sec: 900,
        timeout_ms: 45000,
        enabled: 1,
        params_json: null,
        source: 'seed',
        created_at: '2026-08-29 00:00:00',
        updated_at: '2026-08-29 00:00:00'
      },
      {
        name: 'ad-replication-summary',
        version: '1.0.0',
        script_sha256: 'sha256:efgh',
        manifest_json: JSON.stringify({ name: 'ad-replication-summary', agent: { type: 'ad' }, platforms: ['windows'] }),
        interval_sec: 60,
        timeout_ms: 15000,
        enabled: 1,
        params_json: null,
        source: 'seed',
        created_at: '2026-08-29 00:00:00',
        updated_at: '2026-08-29 00:00:00'
      }
    ] },
    { match: /FROM\s+ad_member_server_packages/i, rows: [] }
  ]));

  const r = await supertest(buildApp())
    .get('/api/admin/agent/packages-for-host?hostname=SRV-A')
    .set('X-Agent-Token', AGENT_TOKEN);

  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 2);

  const baseline = r.body.items.find(i => i.name === 'ad-os-baseline');
  assert.ok(baseline, 'ad-os-baseline must be in items');
  assert.equal(baseline.agent.intervalSec, 900, 'intervalSec baked from policy.interval_sec');
  assert.equal(baseline.agent.timeoutMs, 45000, 'timeoutMs baked from policy.timeout_ms');

  const summary = r.body.items.find(i => i.name === 'ad-replication-summary');
  assert.ok(summary, 'ad-replication-summary must be in items');
  assert.equal(summary.agent.intervalSec, 60);
  assert.equal(summary.agent.timeoutMs, 15000);
});

test('route drops rows whose manifest fails to parse (defensive)', async () => {
  // 1 good row + 1 with manifest_json=null + 1 with manifest_json='{invalid json'
  // → only the good row surfaces in items.
  _setDbForTest(withTokenBundle([
    { match: /FROM\s+package_scripts\s+ps\s+INNER\s+JOIN\s+package_policies\s+pp/i, rows: [
      {
        name: 'good', version: '1.0.0', script_sha256: 'sha',
        manifest_json: JSON.stringify({ name: 'good', agent: { type: 'ad' }, platforms: ['windows'] }),
        interval_sec: 60, timeout_ms: 30000, enabled: 1, params_json: null,
        source: 'seed', created_at: '', updated_at: ''
      },
      {
        name: 'bad-null', version: '1.0.0', script_sha256: 'sha',
        manifest_json: null,
        interval_sec: 60, timeout_ms: 30000, enabled: 1, params_json: null,
        source: 'seed', created_at: '', updated_at: ''
      },
      {
        name: 'bad-json', version: '1.0.0', script_sha256: 'sha',
        manifest_json: '{not valid json',
        interval_sec: 60, timeout_ms: 30000, enabled: 1, params_json: null,
        source: 'seed', created_at: '', updated_at: ''
      }
    ] },
    { match: /FROM\s+ad_member_server_packages/i, rows: [] }
  ]));

  const r = await supertest(buildApp())
    .get('/api/admin/agent/packages-for-host?hostname=SRV-A')
    .set('X-Agent-Token', AGENT_TOKEN);

  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 1, 'only the parseable row surfaces');
  assert.equal(r.body.items[0].name, 'good');
});
