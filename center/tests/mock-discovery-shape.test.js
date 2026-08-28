// mock-discovery-shape.test.js — 2026-08-28 round-57 (R57-B)
//
// Round-57 audit surfaced a gap: the mock discovery payload (mock-multi-agent.mjs
// dc() + mock-heartbeat-daemon.mjs buildDiscovery()) only emitted
// {name, hostname, ipAddress, osVersion, siteHint, isPdc, roles[]}. The
// backend's discovery.js upsertDc binds 12 params — the remaining 5
// FSMO bools were silently defaulted to 0/false because `undefined ? 1 : 0`
// is always 0. The roles[] array was logged but never consumed.
//
// Real agents (collect-discovery.ps1 Get-LocalDcSnapshot) emit the full
// 6-bool shape (IsPdc / IsGc / IsRidMaster / IsSchemaMaster /
// IsDomainNamingMaster / IsInfrastructureMaster). This test pins the
// mock's shape to match.
//
// These are static unit tests — no live center needed. They import the
// `dc` and `defaultScenario` symbols exported by mock-multi-agent.mjs and
// the `buildDiscovery` symbol exported by mock-heartbeat-daemon.mjs and
// verify the wire shape directly.
//
// Pre-flight: the modules previously auto-invoked their main() on import.
// R57-B added an `isDirectRun` guard so import is safe for testing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dc, defaultScenario } from '../mock-multi-agent.mjs';
import { buildDiscovery } from '../mock-heartbeat-daemon.mjs';

// ----- shared expectations -----

// The 12-param MySQL upsertDc binding order (center/src/db/sql.js:31).
// Every field the backend reads must be present (or resolvable to null)
// on the mock payload. If the mock drops one of these, the backend
// binds `undefined`, which mysql2 translates to NULL — silently
// zero-ing the field, exactly the bug R57 is fixing.
const BACKEND_READ_FIELDS = [
  'name', 'siteHint', 'osVersion', 'whenCreated',
  'isPdc', 'isGc', 'isRidMaster', 'isSchemaMaster',
  'isDomainNamingMaster', 'isInfrastructureMaster'
];
const SIX_FSMO_BOOLS = [
  'isPdc', 'isGc', 'isRidMaster', 'isSchemaMaster',
  'isDomainNamingMaster', 'isInfrastructureMaster'
];

// ----- dc() (mock-multi-agent.mjs) -----

test('R57-B dc(): every field the backend upsertDc binds is present (no undefined gaps)', () => {
  // Even with no opts, every backend-read field must be a real boolean
  // (defaults to false) so the backend's `dc.isPdc ? 1 : 0` binding
  // gets a real boolean — not undefined → undefined → SQL bind error.
  const out = dc('TEST-DC1');
  for (const key of BACKEND_READ_FIELDS) {
    assert.ok(key in out, `dc() output missing field "${key}"`);
  }
  for (const key of SIX_FSMO_BOOLS) {
    assert.strictEqual(typeof out[key], 'boolean', `dc().${key} must be boolean, got ${typeof out[key]}`);
    assert.strictEqual(out[key], false, `dc().${key} must default to false`);
  }
});

test('R57-B dc(): drops hostname/ipAddress — ad_dcs has no such columns', () => {
  const out = dc('TEST-DC1');
  assert.strictEqual(out.hostname, undefined, 'hostname must NOT be emitted (DB has no column)');
  assert.strictEqual(out.ipAddress, undefined, 'ipAddress must NOT be emitted (DB has no column)');
});

test('R57-B dc(): roles[] length matches 1 baseline + sum of true FSMO bools', () => {
  // DomainController is always present (1 baseline entry). Every
  // true bool pushes exactly one additional role entry.
  const out = dc('TEST-DC1', {
    isPdc: true,
    isGc: true,
    isRidMaster: true,
    isSchemaMaster: true,
    isDomainNamingMaster: true,
    isInfrastructureMaster: true
  });
  assert.strictEqual(out.roles.length, 7); // 1 baseline + 6 FSMOs
  assert.ok(out.roles.includes('DomainController'));
  assert.ok(out.roles.includes('PDCEmulator'));
  assert.ok(out.roles.includes('GC'));
  assert.ok(out.roles.includes('RIDMaster'));
  assert.ok(out.roles.includes('SchemaMaster'));
  assert.ok(out.roles.includes('DomainNamingMaster'));
  assert.ok(out.roles.includes('InfrastructureMaster'));
});

test('R57-B dc(): roles[] collapses to baseline when all FSMOs are false', () => {
  const out = dc('TEST-DC1');
  assert.deepStrictEqual(out.roles, ['DomainController']);
});

test('R57-B dc(): name + siteHint + osVersion carry through verbatim', () => {
  const out = dc('TEST-DC1', { siteHint: 'SITE-X', osVersion: 'Win2022' });
  assert.strictEqual(out.name, 'TEST-DC1');
  assert.strictEqual(out.siteHint, 'SITE-X');
  assert.strictEqual(out.osVersion, 'Win2022');
});

test('R57-B dc(): siteHint defaults to "MOCK-SITE" when omitted', () => {
  const out = dc('TEST-DC1');
  assert.strictEqual(out.siteHint, 'MOCK-SITE');
});

// ----- buildDiscovery() (mock-heartbeat-daemon.mjs) -----

test('R57-B buildDiscovery(): same 6-bool FSMO shape as dc()', () => {
  const out = buildDiscovery('TEST-DC2');
  for (const key of BACKEND_READ_FIELDS) {
    assert.ok(key in out, `buildDiscovery() output missing field "${key}"`);
  }
  for (const key of SIX_FSMO_BOOLS) {
    assert.strictEqual(typeof out[key], 'boolean', `buildDiscovery().${key} must be boolean`);
  }
  assert.strictEqual(out.hostname, undefined);
  assert.strictEqual(out.ipAddress, undefined);
});

test('R57-B buildDiscovery(): siteHint + name carry through verbatim', () => {
  const out = buildDiscovery('TEST-DC2', { siteHint: 'SITE-Y', isPdc: true });
  assert.strictEqual(out.name, 'TEST-DC2');
  assert.strictEqual(out.siteHint, 'SITE-Y');
  assert.strictEqual(out.isPdc, true);
  assert.ok(out.roles.includes('PDCEmulator'));
});

// ----- defaultScenario() scenarios (mock-multi-agent.mjs) -----

test('R57-B defaultScenario(): every scenario emits a discovery.dc payload matching the backend shape', () => {
  const scenarios = defaultScenario();
  assert.ok(scenarios.length >= 4, `defaultScenario should produce ≥4 scenarios, got ${scenarios.length}`);
  for (const sc of scenarios) {
    assert.ok(sc.discovery, `scenario ${sc.agentId} missing discovery block`);
    assert.ok(sc.discovery.dc, `scenario ${sc.agentId} missing discovery.dc`);
    const payload = sc.discovery.dc;
    for (const key of BACKEND_READ_FIELDS) {
      assert.ok(key in payload, `scenario ${sc.agentId} dc payload missing "${key}"`);
    }
    assert.strictEqual(payload.hostname, undefined, `scenario ${sc.agentId} dc must NOT have hostname`);
    assert.strictEqual(payload.ipAddress, undefined, `scenario ${sc.agentId} dc must NOT have ipAddress`);
    // Roles[] must contain DomainController baseline.
    assert.ok(Array.isArray(payload.roles), `scenario ${sc.agentId} dc.roles must be array`);
    assert.ok(payload.roles.includes('DomainController'), `scenario ${sc.agentId} dc.roles missing DomainController`);
  }
});

test('R57-B defaultScenario(): HUB1 holds the canonical forest-level FSMO cluster', () => {
  const scenarios = defaultScenario();
  const hub1 = scenarios.find((s) => s.agentId === 'MOCK-HUBADSRV1');
  assert.ok(hub1, 'HUB1 scenario missing');
  const dc = hub1.discovery.dc;
  assert.strictEqual(dc.isRidMaster, true, 'HUB1 must hold RID Master');
  assert.strictEqual(dc.isInfrastructureMaster, true, 'HUB1 must hold Infrastructure Master');
  assert.strictEqual(dc.isSchemaMaster, true, 'HUB1 must hold Schema Master');
  assert.strictEqual(dc.isDomainNamingMaster, true, 'HUB1 must hold Domain Naming Master');
  assert.strictEqual(dc.isPdc, false, 'HUB1 must NOT be PDC (PDC is at NC1)');
  assert.strictEqual(dc.isGc, true, 'HUB1 is universal GC');
});

test('R57-B defaultScenario(): NC1 holds PDC Emulator + GC', () => {
  const scenarios = defaultScenario();
  const nc1 = scenarios.find((s) => s.agentId === 'MOCK-NCADSRV1');
  assert.ok(nc1, 'NC1 scenario missing');
  const dc = nc1.discovery.dc;
  assert.strictEqual(dc.isPdc, true, 'NC1 must hold PDC Emulator');
  assert.strictEqual(dc.isGc, true, 'NC1 must be GC');
  assert.strictEqual(dc.isRidMaster, false, 'NC1 must NOT hold RID Master (it lives at HUB1)');
});

test('R57-B defaultScenario(): spoke non-PDCs (NC2/FZ1/FZ2/XM1/XM2) are GC-only', () => {
  const scenarios = defaultScenario();
  const spokeNonPdcs = ['MOCK-NCADSRV2', 'MOCK-FZADSRV1', 'MOCK-FZADSRV2', 'MOCK-XMADSRV1', 'MOCK-XMADSRV2'];
  for (const id of spokeNonPdcs) {
    const sc = scenarios.find((s) => s.agentId === id);
    assert.ok(sc, `${id} scenario missing`);
    const dc = sc.discovery.dc;
    assert.strictEqual(dc.isPdc, false, `${id} must NOT be PDC`);
    assert.strictEqual(dc.isGc, true, `${id} must be GC`);
    assert.strictEqual(dc.isRidMaster, false, `${id} must NOT hold RID Master`);
    assert.strictEqual(dc.isSchemaMaster, false, `${id} must NOT hold Schema Master`);
    assert.strictEqual(dc.isDomainNamingMaster, false, `${id} must NOT hold Domain Naming Master`);
    assert.strictEqual(dc.isInfrastructureMaster, false, `${id} must NOT hold Infrastructure Master`);
  }
});

test('R57-B defaultScenario(): HUB2 (backup hub) is GC-only', () => {
  const scenarios = defaultScenario();
  const hub2 = scenarios.find((s) => s.agentId === 'MOCK-HUBADSRV2');
  assert.ok(hub2, 'HUB2 scenario missing');
  const dc = hub2.discovery.dc;
  assert.strictEqual(dc.isPdc, false, 'HUB2 must NOT be PDC');
  assert.strictEqual(dc.isGc, true, 'HUB2 must be GC');
  for (const k of ['isRidMaster', 'isSchemaMaster', 'isDomainNamingMaster', 'isInfrastructureMaster']) {
    assert.strictEqual(dc[k], false, `HUB2 must NOT hold ${k}`);
  }
});