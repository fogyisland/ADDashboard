// Tests for the `mergePackagesForHost` service (Task 8 of the non-AD
// server management plan) and the
// `GET /api/admin/agent/packages-for-host` endpoint that surfaces it to
// the non-AD agent on heartbeat.
//
// Service-level tests cover the 4 documented merge cases from the brief:
//   1. host with no member_server_packages rows → global (=ad) packages
//   2. host with member_server_packages row → that package surfaces
//   3. disabled member row → dropped
//   4. ad-typed manifest in member-server context → dropped (type mismatch)
//
// Endpoint tests cover: auth, 400 on missing hostname, happy path.
//
// Pattern follows center/tests/member-servers-api.test.js: node:test +
// node:assert/strict, build a small express app, mock db via
// buildMockDb / buildRecordingPool helpers. No Jest.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { mergePackagesForHost } from '../src/services/agent-packages-for-host.js';
import { agentPackagesRouter } from '../src/routes/agent-packages.js';
import { _setDbForTest } from '../src/db/index.js';
import { buildMockDb, buildRecordingPool } from './helpers/db-mock.js';

const AGENT_TOKEN = 'agent-token-1';

// I3 (Task 5): the agentToken middleware reads the bundle from db. Inject a
// script that matches `getAgentTokenBundle` and returns AGENT_TOKEN as current.
const AGENT_TOKEN_BUNDLE_REGEX = /agent_token_(current|previous|rotated_at|previous_ttl_days)/i;
const TOKEN_BUNDLE_SCRIPT = { match: AGENT_TOKEN_BUNDLE_REGEX, rows: [{ config_key: 'agent_token_current', config_value: AGENT_TOKEN }] };

function buildApp() {
  const a = express();
  a.use(express.json());
  // agentPackagesRouter is a factory that wires the agent-token middleware
  // internally — match the project pattern (memberRouter, packageRunner).
  a.use(agentPackagesRouter({ config: { agentToken: AGENT_TOKEN } }));
  return a;
}

// Helper for tests: build a db with the agent-token bundle script pre-seeded
// plus the caller-supplied extra scripts.
function withTokenBundle(extraScripts = []) {
  return buildMockDb([TOKEN_BUNDLE_SCRIPT, ...extraScripts]).standard();
}

// ---------------------------------------------------------------------------
// 1. mergePackagesForHost — service-level unit tests
// ---------------------------------------------------------------------------
describe('mergePackagesForHost', () => {
  test('returns ad packages when host has no member_server_packages rows', () => {
    const r = mergePackagesForHost({
      installedGlobal: [{ name: 'x', agent: { type: 'ad' }, platforms: ['windows'] }],
      memberServerPackages: []
    });
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'x');
  });

  test('returns non-ad packages when host has member_server_packages row', () => {
    const r = mergePackagesForHost({
      installedGlobal: [{ name: 'ad-os-baseline', agent: { type: 'non-ad' }, platforms: ['windows'] }],
      memberServerPackages: [{ package_name: 'ad-os-baseline', enabled: 1 }]
    });
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'ad-os-baseline');
  });

  test('drops disabled rows', () => {
    const r = mergePackagesForHost({
      installedGlobal: [{ name: 'ad-os-baseline', agent: { type: 'non-ad' }, platforms: ['windows'] }],
      memberServerPackages: [{ package_name: 'ad-os-baseline', enabled: 0 }]
    });
    assert.equal(r.length, 0);
  });

  test('drops ad packages from member-server context (type mismatch)', () => {
    const r = mergePackagesForHost({
      installedGlobal: [{ name: 'dc-foo', agent: { type: 'ad' }, platforms: ['windows'] }],
      memberServerPackages: [{ package_name: 'dc-foo', enabled: 1 }]
    });
    assert.equal(r.length, 0);
  });

  // Defensive coverage pinned by the spec — exercises edge cases that
  // weren't in the brief's 4 but the brief's merge logic must still
  // handle without throwing.
  test('returns empty array when both inputs are empty/missing', () => {
    assert.deepEqual(mergePackagesForHost({}), []);
    assert.deepEqual(mergePackagesForHost({ installedGlobal: [], memberServerPackages: [] }), []);
  });

  test('member bind to a non-installed package is dropped (no global manifest → not surfaced)', () => {
    // member-server_packages references a package that has no row in
    // installed_packages (e.g. uninstalled). merge must not surface it,
    // because the agent has no script to run.
    const r = mergePackagesForHost({
      installedGlobal: [],
      memberServerPackages: [{ package_name: 'orphan', enabled: 1 }]
    });
    assert.equal(r.length, 0);
  });

  test('member bind wins over global even when global is also referenced', () => {
    // Both installed_packages and ad_member_server_packages reference the
    // same name. The member row "owns" — but since the global manifest
    // is non-ad (the only legal type for member-server binds), the
    // non-ad type survives and the package is returned.
    const r = mergePackagesForHost({
      installedGlobal: [{ name: 'os-baseline', agent: { type: 'non-ad' }, platforms: ['windows'] }],
      memberServerPackages: [{ package_name: 'os-baseline', enabled: 1 }]
    });
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'os-baseline');
    assert.equal(r[0].agent.type, 'non-ad');
  });
});

// ---------------------------------------------------------------------------
// 2. GET /api/admin/agent/packages-for-host — endpoint integration
// ---------------------------------------------------------------------------
describe('GET /api/admin/agent/packages-for-host', () => {
  test('401 without agent token', async () => {
    _setDbForTest(withTokenBundle());
    const r = await supertest(buildApp())
      .get('/api/admin/agent/packages-for-host?hostname=SRV-A');
    assert.equal(r.status, 401);
  });

  test('401 with wrong agent token', async () => {
    _setDbForTest(withTokenBundle());
    const r = await supertest(buildApp())
      .get('/api/admin/agent/packages-for-host?hostname=SRV-A')
      .set('X-Agent-Token', 'WRONG');
    assert.equal(r.status, 401);
  });

  test('400 when hostname query param missing', async () => {
    _setDbForTest(withTokenBundle());
    const r = await supertest(buildApp())
      .get('/api/admin/agent/packages-for-host')
      .set('X-Agent-Token', AGENT_TOKEN);
    assert.equal(r.status, 400);
  });

  test('200 returns merged items array (global-only host)', async () => {
    // installed_packages → 1 enabled row of ad type; member_server_packages
    // → empty. Expect the 1 global manifest back.
    _setDbForTest(withTokenBundle([
      { match: /FROM\s+installed_packages/i, rows: [
        { name: 'x', version: '1.0.0', type: 'timeseries', manifest_json: JSON.stringify({ name: 'x', agent: { type: 'ad' }, platforms: ['windows'] }), enabled: 1 }
      ] },
      { match: /FROM\s+ad_member_server_packages/i, rows: [] }
    ]));

    const r = await supertest(buildApp())
      .get('/api/admin/agent/packages-for-host?hostname=SRV-A')
      .set('X-Agent-Token', AGENT_TOKEN);

    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.items));
    assert.equal(r.body.items.length, 1);
    assert.equal(r.body.items[0].name, 'x');
  });

  test('200 returns merged items array (member bind present, non-ad type)', async () => {
    _setDbForTest(withTokenBundle([
      { match: /FROM\s+installed_packages/i, rows: [
        { name: 'ad-os-baseline', version: '1.0.0', type: 'status', manifest_json: JSON.stringify({ name: 'ad-os-baseline', agent: { type: 'non-ad' }, platforms: ['windows'] }), enabled: 1 }
      ] },
      { match: /FROM\s+ad_member_server_packages/i, rows: [
        { hostname: 'SRV-A', package_name: 'ad-os-baseline', enabled: 1 }
      ] }
    ]));

    const r = await supertest(buildApp())
      .get('/api/admin/agent/packages-for-host?hostname=SRV-A')
      .set('X-Agent-Token', AGENT_TOKEN);

    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 1);
    assert.equal(r.body.items[0].name, 'ad-os-baseline');
    assert.equal(r.body.items[0].agent.type, 'non-ad');
  });

  test('200 with disabled member row → package is excluded (per-host opt-out blocks global)', async () => {
    _setDbForTest(withTokenBundle([
      { match: /FROM\s+installed_packages/i, rows: [
        { name: 'ad-os-baseline', version: '1.0.0', type: 'status', manifest_json: JSON.stringify({ name: 'ad-os-baseline', agent: { type: 'non-ad' }, platforms: ['windows'] }), enabled: 1 }
      ] },
      { match: /FROM\s+ad_member_server_packages/i, rows: [
        { hostname: 'SRV-A', package_name: 'ad-os-baseline', enabled: 0 }
      ] }
    ]));

    const r = await supertest(buildApp())
      .get('/api/admin/agent/packages-for-host?hostname=SRV-A')
      .set('X-Agent-Token', AGENT_TOKEN);

    assert.equal(r.status, 200);
    // Per-host disable is "this host opts out" — the global row is
    // blocked for this host, so the items array is empty.
    assert.equal(r.body.items.length, 0);
  });

  test('issues 2 queries: installed_packages SELECT + ad_member_server_packages SELECT, with hostname bound', async () => {
    const records = [];
    const db = buildMockDb([TOKEN_BUNDLE_SCRIPT]).withRecording(records);
    _setDbForTest(db);
    await supertest(buildApp())
      .get('/api/admin/agent/packages-for-host?hostname=SRV-A')
      .set('X-Agent-Token', AGENT_TOKEN);

    const installedQ = records.find(r => /FROM\s+installed_packages/i.test(r.sql));
    assert.ok(installedQ, 'installed_packages SELECT should be issued');
    const memberQ = records.find(r => /FROM\s+ad_member_server_packages/i.test(r.sql));
    assert.ok(memberQ, 'ad_member_server_packages SELECT should be issued');
    // hostname bound to the member-server query
    assert.deepEqual(memberQ.params, ['SRV-A']);
  });
});
