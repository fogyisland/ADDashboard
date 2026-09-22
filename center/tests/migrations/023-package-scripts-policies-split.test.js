// 023-package-scripts-policies-split.test.js — verifies the JS data
// migration helper for migration 023 (installed_packages →
// package_scripts + package_policies + DROP installed_packages).
//
// This is a JS-level data migration, not a raw SQL DDL; the SQL portion
// (CREATE TABLE package_scripts + package_policies) is in
// db/migrations/023-package-scripts-policies-split.sql. The migration
// service invokes this helper after the SQL applies successfully.
//
// Pattern mirrors installed-packages.test.js + migration-NNN.test.js:
//   - mock-DB with a recording `db.execute` — no live DB needed.
//   - Cover both happy path (2 rows migrate + DROP) and the policy
//     precedence rule (interval_override_sec wins over manifest.agent.intervalSec).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Capture every execute() call so assertions can assert against the SQL
// shape + bound params without driving a real DB. The fake returns
// `installed_packages` rows on the first SELECT and {} for everything
// else, so the helper runs end-to-end against a deterministic dataset.
//
// `fkReAddProbeRows` (DB H2/H3) controls the post-DROP probe that gates
// re-adding fk_msp_pkg → package_scripts(name). Default: empty (FK
// absent) so the ADD CONSTRAINT fires on the upgrade path — the common
// case after m023 dropped the V0 FK. Tests that exercise the
// "already-present" idempotent re-apply pass `[{ x: 1 }]`.
function makeFakeDb({ installedRows = defaultInstalledRows(), dropGuardRows = [], fkGuardRows = [], fkReAddProbeRows = [] } = {}) {
  const calls = [];
  let selectCount = 0;
  const fake = {
    dialect: 'mysql',
    execute: async (sql, params) => {
      // Capture the first 240 chars of the first line — long enough to
      // fit the single-line ADD CONSTRAINT FK declaration (~160 chars)
      // so regex assertions like /REFERENCES package_scripts\(name\)/
      // can match without truncation. Earlier 80-char cutoff was fine
      // for single-line DROP statements but truncated the ADD shape.
      calls.push({ sql: sql.trim().split('\n')[0].slice(0, 240), params: params ? [...params] : [] });
      const trimmed = sql.trim();
      if (trimmed.startsWith('SELECT name, version, type, manifest_json')) {
        selectCount++;
        // Only the first SELECT returns data — mimics the helper reading
        // installed_packages once at the top of the migration.
        if (selectCount === 1) return { rows: installedRows };
        return { rows: [] };
      }
      if (trimmed.startsWith('SELECT 1 AS x FROM sys.tables')) {
        return { rows: dropGuardRows };
      }
      // T14: MSSQL FK probe (sys.foreign_keys) — return rows when FK
      // is present so the FK DROP fires; empty rows to test the
      // skip-the-drop-FK re-apply path.
      if (trimmed.startsWith('SELECT 1 AS x FROM sys.foreign_keys')) {
        return { rows: fkGuardRows };
      }
      // DB H2/H3: MySQL FK re-add probe (information_schema).
      // Empty (default) → ADD CONSTRAINT fires; [{x:1}] → no-op re-apply.
      if (trimmed.startsWith('SELECT 1 AS x FROM information_schema.TABLE_CONSTRAINTS')) {
        return { rows: fkReAddProbeRows };
      }
      return { rows: [] };
    }
  };
  return { fake, calls };
}

function defaultInstalledRows() {
  return [
    { name: 'pkg-a', version: '1.0.0', type: 'gauge',
      manifest_json: '{"name":"pkg-a","version":"1.0.0","type":"gauge","agent":{"type":"ad","script":"collect.ps1","intervalSec":3600,"timeoutMs":30000}}',
      enabled: 1, params_json: null, interval_override_sec: null },
    { name: 'pkg-b', version: '1.0.0', type: 'status',
      manifest_json: '{"name":"pkg-b","version":"1.0.0","type":"status","agent":{"type":"non-ad","script":"collect.ps1","intervalSec":1800,"timeoutMs":60000}}',
      enabled: 0, params_json: '{"key":"val"}', interval_override_sec: 60 }
  ];
}

// Build a temp dataDir with collect.ps1 for the two packages so the
// helper exercises the real disk-read path.
function makeFakeDataDir() {
  const dataDir = mkdtempSync(join(tmpdir(), 'r66-023-'));
  for (const { name, version, body } of [
    { name: 'pkg-a', version: '1.0.0', body: 'Write-Host hi' },
    { name: 'pkg-b', version: '1.0.0', body: 'Write-Host bye' }
  ]) {
    const dir = join(dataDir, name, version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'collect.ps1'), body);
  }
  return { dataDir, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
}

// Helper to dynamically import — mirrors the recommended TDD pattern of
// importing the module under test inside the test so node:test isolates
// failures cleanly.
async function importHelper() {
  return import('../../../db/migrations/023-package-scripts-policies-split.js');
}

test('migrates each installed_packages row to package_scripts + package_policies, drops old', async () => {
  const { fake, calls } = makeFakeDb();
  const { dataDir, cleanup } = makeFakeDataDir();
  try {
    const { migrateInstalledPackagesToTwoTable } = await importHelper();
    const result = await migrateInstalledPackagesToTwoTable({ db: fake, dataDir });

    assert.equal(result.migrated, 2, 'two rows migrated');

    const insertScriptCalls = calls.filter(c => c.sql.startsWith('INSERT INTO package_scripts'));
    const insertPolicyCalls = calls.filter(c => c.sql.startsWith('INSERT INTO package_policies'));
    const dropCalls = calls.filter(c => c.sql.startsWith('DROP TABLE') || c.sql.startsWith('DROP TABLE IF EXISTS'));
    assert.equal(insertScriptCalls.length, 2, 'two scripts written');
    assert.equal(insertPolicyCalls.length, 2, 'two policies written');
    assert.equal(dropCalls.length, 1, 'installed_packages dropped once');

    // T14: FK fk_msp_pkg must be dropped exactly once, BEFORE the DROP TABLE.
    const fkDropCalls = calls.filter(c =>
      c.sql.startsWith('ALTER TABLE ad_member_server_packages DROP FOREIGN KEY') ||
      c.sql.startsWith('ALTER TABLE ad_member_server_packages DROP CONSTRAINT'));
    assert.equal(fkDropCalls.length, 1, 'FK fk_msp_pkg dropped exactly once');
    const fkIdx = calls.findIndex(c =>
      c.sql.startsWith('ALTER TABLE ad_member_server_packages DROP FOREIGN KEY') ||
      c.sql.startsWith('ALTER TABLE ad_member_server_packages DROP CONSTRAINT'));
    const dropIdx = calls.findIndex(c => c.sql.startsWith('DROP TABLE'));
    assert.ok(fkIdx >= 0 && dropIdx >= 0, 'both FK drop and TABLE drop present');
    assert.ok(fkIdx < dropIdx, 'FK drop must run before TABLE drop');

    // DB H2/H3: fk_msp_pkg is re-added with the V1 FK shape AFTER the
    // DROP TABLE — upgrade path converges on the fresh-install schema.
    // Default `fkReAddProbeRows = []` (FK absent) → ADD CONSTRAINT fires.
    const fkAddCalls = calls.filter(c =>
      c.sql.startsWith('ALTER TABLE ad_member_server_packages ADD CONSTRAINT'));
    assert.equal(fkAddCalls.length, 1, 'fk_msp_pkg re-added exactly once');
    const fkAddIdx = calls.findIndex(c =>
      c.sql.startsWith('ALTER TABLE ad_member_server_packages ADD CONSTRAINT'));
    assert.ok(fkAddIdx > dropIdx, 'ADD CONSTRAINT must run after DROP TABLE installed_packages');
    assert.match(fkAddCalls[0].sql, /REFERENCES package_scripts\(name\)/, 're-added FK targets package_scripts');
    assert.match(fkAddCalls[0].sql, /ON DELETE CASCADE/, 're-added FK preserves ON DELETE CASCADE');
    // MySQL FK re-add probe was issued exactly once.
    const fkProbeCalls = calls.filter(c =>
      c.sql.startsWith('SELECT 1 AS x FROM information_schema.TABLE_CONSTRAINTS'));
    assert.equal(fkProbeCalls.length, 1, 'FK re-add probe queried once');
  } finally {
    cleanup();
  }
});

test('interval_override_sec wins over manifest.agent.intervalSec for the pkg-b row', async () => {
  const { fake, calls } = makeFakeDb();
  const { dataDir, cleanup } = makeFakeDataDir();
  try {
    const { migrateInstalledPackagesToTwoTable } = await importHelper();
    await migrateInstalledPackagesToTwoTable({ db: fake, dataDir });

    // Find the INSERT INTO package_policies for pkg-b and assert
    // interval_sec (param[1]) is 60 (interval_override_sec), not 1800
    // (manifest.agent.intervalSec).
    const policyInserts = calls.filter(c => c.sql.startsWith('INSERT INTO package_policies'));
    const pkgBPolicy = policyInserts.find(c => c.params[0] === 'pkg-b');
    assert.ok(pkgBPolicy, 'pkg-b policy INSERT not found');
    assert.equal(pkgBPolicy.params[1], 60, 'pkg-b interval must come from interval_override_sec=60');
    // timeoutMs comes from manifest.agent.timeoutMs (60000), not from
    // interval_override_sec.
    assert.equal(pkgBPolicy.params[2], 60000, 'pkg-b timeout must come from manifest.agent.timeoutMs');
  } finally {
    cleanup();
  }
});

test('manifest_json written to package_scripts strips agent.intervalSec + agent.timeoutMs', async () => {
  const { fake, calls } = makeFakeDb();
  const { dataDir, cleanup } = makeFakeDataDir();
  try {
    const { migrateInstalledPackagesToTwoTable } = await importHelper();
    await migrateInstalledPackagesToTwoTable({ db: fake, dataDir });

    const scriptInserts = calls.filter(c => c.sql.startsWith('INSERT INTO package_scripts'));
    const pkgAScript = scriptInserts.find(c => c.params[0] === 'pkg-a');
    assert.ok(pkgAScript, 'pkg-a script INSERT not found');
    const written = JSON.parse(pkgAScript.params[4]);
    assert.equal(written.agent.intervalSec, undefined, 'intervalSec must be stripped from manifest.agent');
    assert.equal(written.agent.timeoutMs, undefined, 'timeoutMs must be stripped from manifest.agent');
    assert.equal(written.agent.type, 'ad', 'agent.type preserved');
    assert.equal(written.agent.script, 'collect.ps1', 'agent.script preserved');
  } finally {
    cleanup();
  }
});

test('enabled BIT coerced to 0/1 from MySQL tinyint', async () => {
  const { fake, calls } = makeFakeDb();
  const { dataDir, cleanup } = makeFakeDataDir();
  try {
    const { migrateInstalledPackagesToTwoTable } = await importHelper();
    await migrateInstalledPackagesToTwoTable({ db: fake, dataDir });

    const policyInserts = calls.filter(c => c.sql.startsWith('INSERT INTO package_policies'));
    const pkgA = policyInserts.find(c => c.params[0] === 'pkg-a');
    const pkgB = policyInserts.find(c => c.params[0] === 'pkg-b');
    assert.equal(pkgA.params[3], 1, 'pkg-a enabled=1 preserved');
    assert.equal(pkgB.params[3], 0, 'pkg-b enabled=0 preserved');
  } finally {
    cleanup();
  }
});

test('missing on-disk collect.ps1 falls back to placeholder (does not throw)', async () => {
  // Empty dataDir — no on-disk files. The helper must still migrate
  // by writing a placeholder script with a # missing comment.
  const dataDir = mkdtempSync(join(tmpdir(), 'r66-023-missing-'));
  try {
    const { fake, calls } = makeFakeDb();
    const { migrateInstalledPackagesToTwoTable } = await importHelper();
    const r = await migrateInstalledPackagesToTwoTable({ db: fake, dataDir });
    assert.equal(r.migrated, 2, 'migrates both rows even without on-disk scripts');
    const scriptInserts = calls.filter(c => c.sql.startsWith('INSERT INTO package_scripts'));
    assert.equal(scriptInserts.length, 2);
    // placeholder script body contains the re-upload hint
    assert.match(scriptInserts[0].params[2], /collect\.ps1 missing for/);
    assert.match(scriptInserts[0].params[2], /re-upload required/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('empty installed_packages returns { migrated: 0 } without DROP', async () => {
  const { fake, calls } = makeFakeDb({ installedRows: [] });
  const dataDir = mkdtempSync(join(tmpdir(), 'r66-023-empty-'));
  try {
    const { migrateInstalledPackagesToTwoTable } = await importHelper();
    const r = await migrateInstalledPackagesToTwoTable({ db: fake, dataDir });
    assert.equal(r.migrated, 0);
    // No INSERTs and no DROP — helper short-circuits on empty input.
    const inserts = calls.filter(c => c.sql.startsWith('INSERT INTO'));
    const drops = calls.filter(c => c.sql.startsWith('DROP TABLE'));
    assert.equal(inserts.length, 0);
    assert.equal(drops.length, 0);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('writeAudit called once with bulk_migrate action + migrated count', async () => {
  const { fake, calls: _ } = makeFakeDb();
  const { dataDir, cleanup } = makeFakeDataDir();
  try {
    const { migrateInstalledPackagesToTwoTable } = await importHelper();
    const auditCalls = [];
    await migrateInstalledPackagesToTwoTable({
      db: fake,
      dataDir,
      writeAudit: async (args) => auditCalls.push(args)
    });
    assert.equal(auditCalls.length, 1, 'exactly one audit row');
    assert.equal(auditCalls[0].action, 'bulk_migrate');
    assert.equal(auditCalls[0].details.count, 2);
    assert.equal(auditCalls[0].details.source, 'installed_packages');
    assert.match(auditCalls[0].details.destination, /package_scripts\+package_policies/);
  } finally {
    cleanup();
  }
});

test('MSSQL dialect uses sys.tables guard before DROP', async () => {
  // For MSSQL we expect the helper to probe sys.tables first (and skip
  // the DROP when installed_packages is already gone). Simulate the
  // "already gone" case.
  const calls = [];
  let selectCount = 0;
  let fkProbeCount = 0;
  const fake = {
    dialect: 'mssql',
    execute: async (sql, params) => {
      calls.push({ sql: sql.trim().split('\n')[0].slice(0, 240), params: params ? [...params] : [] });
      if (sql.trim().startsWith('SELECT name, version, type, manifest_json')) {
        selectCount++;
        if (selectCount === 1) return { rows: defaultInstalledRows() };
        return { rows: [] };
      }
      if (sql.trim().startsWith('SELECT 1 AS x FROM sys.tables')) {
        // Simulate "installed_packages already gone"
        return { rows: [] };
      }
      // MSSQL FK probe — called twice: once before the DROP, once before
      // the re-add. First call returns "present" (DROP fires); second
      // call returns "absent" (re-add fires). The fake is stateful.
      if (sql.trim().startsWith('SELECT 1 AS x FROM sys.foreign_keys')) {
        fkProbeCount++;
        if (fkProbeCount === 1) return { rows: [{ x: 1 }] };
        return { rows: [] };
      }
      return { rows: [] };
    }
  };
  const { dataDir, cleanup } = makeFakeDataDir();
  try {
    const { migrateInstalledPackagesToTwoTable } = await importHelper();
    await migrateInstalledPackagesToTwoTable({ db: fake, dataDir });
    const guardCalls = calls.filter(c => c.sql.startsWith('SELECT 1 AS x FROM sys.tables'));
    assert.equal(guardCalls.length, 1, 'sys.tables guard queried once');
    const drops = calls.filter(c => c.sql.startsWith('DROP TABLE'));
    assert.equal(drops.length, 0, 'no DROP issued when sys.tables says installed_packages is gone');
    // T14: MSSQL FK probe + DROP CONSTRAINT fired
    const fkProbeCalls = calls.filter(c => c.sql.startsWith('SELECT 1 AS x FROM sys.foreign_keys'));
    assert.equal(fkProbeCalls.length, 2, 'sys.foreign_keys guard queried twice (drop probe + re-add probe)');
    const fkDropCalls = calls.filter(c => c.sql.startsWith('ALTER TABLE ad_member_server_packages DROP CONSTRAINT'));
    assert.equal(fkDropCalls.length, 1, 'FK fk_msp_pkg dropped once via DROP CONSTRAINT');
    // DB H2/H3: re-add probe saw "absent" → ADD CONSTRAINT fires.
    const fkAddCalls = calls.filter(c =>
      c.sql.startsWith('ALTER TABLE ad_member_server_packages ADD CONSTRAINT'));
    assert.equal(fkAddCalls.length, 1, 'fk_msp_pkg re-added with ADD CONSTRAINT');
  } finally {
    cleanup();
  }
});

test('T14: MSSQL re-apply with FK already gone skips the FK DROP', async () => {
  // Re-running migration 023 on a DB where the FK is already gone (e.g.
  // previous run + manual DROP CONSTRAINT) must be a safe no-op for the
  // FK drop — no error from a missing FK.
  const calls = [];
  let selectCount = 0;
  const fake = {
    dialect: 'mssql',
    execute: async (sql, params) => {
      calls.push({ sql: sql.trim().split('\n')[0].slice(0, 240), params: params ? [...params] : [] });
      if (sql.trim().startsWith('SELECT name, version, type, manifest_json')) {
        selectCount++;
        if (selectCount === 1) return { rows: defaultInstalledRows() };
        return { rows: [] };
      }
      if (sql.trim().startsWith('SELECT 1 AS x FROM sys.tables')) {
        return { rows: [{ x: 1 }] };
      }
      if (sql.trim().startsWith('SELECT 1 AS x FROM sys.foreign_keys')) {
        // Simulate "FK already gone" — both the DROP probe and the
        // RE-ADD probe see "absent".
        return { rows: [] };
      }
      return { rows: [] };
    }
  };
  const { dataDir, cleanup } = makeFakeDataDir();
  try {
    const { migrateInstalledPackagesToTwoTable } = await importHelper();
    await migrateInstalledPackagesToTwoTable({ db: fake, dataDir });
    const fkProbeCalls = calls.filter(c => c.sql.startsWith('SELECT 1 AS x FROM sys.foreign_keys'));
    assert.equal(fkProbeCalls.length, 2, 'sys.foreign_keys guard queried twice (drop probe + re-add probe)');
    const fkDropCalls = calls.filter(c =>
      c.sql.startsWith('ALTER TABLE ad_member_server_packages DROP FOREIGN KEY') ||
      c.sql.startsWith('ALTER TABLE ad_member_server_packages DROP CONSTRAINT'));
    assert.equal(fkDropCalls.length, 0, 'no FK DROP issued when sys.foreign_keys says FK is gone');
    // DROP TABLE still fires
    const dropCalls = calls.filter(c => c.sql.startsWith('DROP TABLE'));
    assert.equal(dropCalls.length, 1, 'DROP TABLE installed_packages fired');
    // DB H2/H3: re-add probe saw "absent" → ADD CONSTRAINT fires.
    const fkAddCalls = calls.filter(c =>
      c.sql.startsWith('ALTER TABLE ad_member_server_packages ADD CONSTRAINT'));
    assert.equal(fkAddCalls.length, 1, 'fk_msp_pkg re-added with ADD CONSTRAINT');
  } finally {
    cleanup();
  }
});

test('T14: empty installed_packages short-circuits before FK drop + DROP TABLE', async () => {
  // The early-return path (`if (rows.length === 0) return { migrated: 0 }`)
  // must skip the FK drop AND the DROP TABLE — there's no FK to drop and
  // no installed_packages to drop on a clean V1 schema.
  const { fake, calls } = makeFakeDb({ installedRows: [] });
  const dataDir = mkdtempSync(join(tmpdir(), 'r66-023-t14-empty-'));
  try {
    const { migrateInstalledPackagesToTwoTable } = await importHelper();
    const r = await migrateInstalledPackagesToTwoTable({ db: fake, dataDir });
    assert.equal(r.migrated, 0);
    const fkDropCalls = calls.filter(c =>
      c.sql.startsWith('ALTER TABLE ad_member_server_packages DROP FOREIGN KEY') ||
      c.sql.startsWith('ALTER TABLE ad_member_server_packages DROP CONSTRAINT'));
    assert.equal(fkDropCalls.length, 0, 'no FK drop on empty installed_packages');
    const drops = calls.filter(c => c.sql.startsWith('DROP TABLE'));
    assert.equal(drops.length, 0, 'no DROP TABLE on empty installed_packages');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// DB H2/H3 — the four contracts that the upgrade-path FK re-add must honor.

test('H2/H3: MySQL upgrade path re-adds fk_msp_pkg → package_scripts(name) ON DELETE CASCADE', async () => {
  // The upgrade path's defining moment: 2 rows in installed_packages, FK
  // probe sees "absent" after the drop, ADD CONSTRAINT fires pointing at
  // package_scripts with ON DELETE CASCADE — exactly what fresh installs
  // get from 01-tables.sql:350.
  const { fake, calls } = makeFakeDb();
  const { dataDir, cleanup } = makeFakeDataDir();
  try {
    const { migrateInstalledPackagesToTwoTable } = await importHelper();
    const r = await migrateInstalledPackagesToTwoTable({ db: fake, dataDir });
    assert.equal(r.migrated, 2);
    // Order: DROP installed_packages → probe → ADD CONSTRAINT (because
    // default probe returns "absent"). Verify by index ordering.
    const dropIdx = calls.findIndex(c => c.sql.startsWith('DROP TABLE'));
    const probeIdx = calls.findIndex(c =>
      c.sql.startsWith('SELECT 1 AS x FROM information_schema.TABLE_CONSTRAINTS'));
    const addIdx = calls.findIndex(c =>
      c.sql.startsWith('ALTER TABLE ad_member_server_packages ADD CONSTRAINT'));
    assert.ok(dropIdx >= 0, 'DROP TABLE present');
    assert.ok(probeIdx > dropIdx, 'FK re-add probe runs AFTER DROP TABLE');
    assert.ok(addIdx > probeIdx, 'ADD CONSTRAINT runs AFTER the probe');
    // FK shape must match the fresh-install declaration exactly.
    const addCall = calls[addIdx];
    assert.match(addCall.sql, /FOREIGN KEY \(package_name\)/);
    assert.match(addCall.sql, /REFERENCES package_scripts\(name\)/);
    assert.match(addCall.sql, /ON DELETE CASCADE/);
    assert.match(addCall.sql, /CONSTRAINT fk_msp_pkg/);
  } finally {
    cleanup();
  }
});

test('H2/H3: MySQL re-add is idempotent — second run with FK already present skips ADD CONSTRAINT', async () => {
  // A re-run on a DB that already has fk_msp_pkg (e.g. previous run +
  // upgrade cycle) must NOT issue a duplicate ADD CONSTRAINT — the
  // information_schema probe sees the FK already exists and short-circuits.
  const { fake, calls } = makeFakeDb({ fkReAddProbeRows: [{ x: 1 }] });
  const { dataDir, cleanup } = makeFakeDataDir();
  try {
    const { migrateInstalledPackagesToTwoTable } = await importHelper();
    const r = await migrateInstalledPackagesToTwoTable({ db: fake, dataDir });
    assert.equal(r.migrated, 2, 'migration still completes normally');
    const fkAddCalls = calls.filter(c =>
      c.sql.startsWith('ALTER TABLE ad_member_server_packages ADD CONSTRAINT'));
    assert.equal(fkAddCalls.length, 0, 'no ADD CONSTRAINT issued when probe sees FK already present');
    // Probe was still issued (cheap idempotency check).
    const fkProbeCalls = calls.filter(c =>
      c.sql.startsWith('SELECT 1 AS x FROM information_schema.TABLE_CONSTRAINTS'));
    assert.equal(fkProbeCalls.length, 1, 'FK re-add probe queried once even on no-op path');
  } finally {
    cleanup();
  }
});

test('H2/H3: MSSQL upgrade path re-adds fk_msp_pkg → package_scripts(name)', async () => {
  // MSSQL probe uses sys.foreign_keys; the fake must answer both the
  // DROP probe (return "present" so the DROP fires) and the RE-ADD probe
  // (return "absent" so ADD CONSTRAINT fires).
  const calls = [];
  let selectCount = 0;
  let fkProbeCount = 0;
  const fake = {
    dialect: 'mssql',
    execute: async (sql, params) => {
      calls.push({ sql: sql.trim().split('\n')[0].slice(0, 240), params: params ? [...params] : [] });
      if (sql.trim().startsWith('SELECT name, version, type, manifest_json')) {
        selectCount++;
        if (selectCount === 1) return { rows: defaultInstalledRows() };
        return { rows: [] };
      }
      if (sql.trim().startsWith('SELECT 1 AS x FROM sys.tables')) {
        // installed_packages present → DROP fires
        return { rows: [{ x: 1 }] };
      }
      if (sql.trim().startsWith('SELECT 1 AS x FROM sys.foreign_keys')) {
        fkProbeCount++;
        if (fkProbeCount === 1) return { rows: [{ x: 1 }] }; // DROP probe: present
        return { rows: [] }; // RE-ADD probe: absent
      }
      return { rows: [] };
    }
  };
  const { dataDir, cleanup } = makeFakeDataDir();
  try {
    const { migrateInstalledPackagesToTwoTable } = await importHelper();
    const r = await migrateInstalledPackagesToTwoTable({ db: fake, dataDir });
    assert.equal(r.migrated, 2);
    // Both FK probes issued.
    const fkProbeCalls = calls.filter(c => c.sql.startsWith('SELECT 1 AS x FROM sys.foreign_keys'));
    assert.equal(fkProbeCalls.length, 2, 'sys.foreign_keys guard queried twice (drop probe + re-add probe)');
    // FK drop fired once.
    const fkDropCalls = calls.filter(c => c.sql.startsWith('ALTER TABLE ad_member_server_packages DROP CONSTRAINT'));
    assert.equal(fkDropCalls.length, 1, 'FK dropped once via DROP CONSTRAINT');
    // FK re-add fired once with V1 shape.
    const fkAddCalls = calls.filter(c =>
      c.sql.startsWith('ALTER TABLE ad_member_server_packages ADD CONSTRAINT'));
    assert.equal(fkAddCalls.length, 1, 'FK re-added once via ADD CONSTRAINT');
    assert.match(fkAddCalls[0].sql, /REFERENCES package_scripts\(name\)/);
    assert.match(fkAddCalls[0].sql, /ON DELETE CASCADE/);
  } finally {
    cleanup();
  }
});

test('H2/H3: fresh-install short-circuit — empty installed_packages skips the FK re-add entirely', async () => {
  // On a fresh install, 01-tables.sql already declares fk_msp_pkg. The
  // helper's early-return on `migrated === 0` must skip the FK re-add —
  // no probe, no ADD CONSTRAINT — so 01-tables.sql remains the single
  // source of truth for the FK on a clean DB.
  const { fake, calls } = makeFakeDb({ installedRows: [] });
  const dataDir = mkdtempSync(join(tmpdir(), 'r66-023-h23-fresh-'));
  try {
    const { migrateInstalledPackagesToTwoTable } = await importHelper();
    const r = await migrateInstalledPackagesToTwoTable({ db: fake, dataDir });
    assert.equal(r.migrated, 0);
    // No FK re-add probe issued on the early-return path.
    const fkProbeCalls = calls.filter(c =>
      c.sql.startsWith('SELECT 1 AS x FROM information_schema.TABLE_CONSTRAINTS') ||
      c.sql.startsWith('SELECT 1 AS x FROM sys.foreign_keys'));
    assert.equal(fkProbeCalls.length, 0, 'no FK re-add probe on empty installed_packages');
    // No ADD CONSTRAINT issued on the early-return path.
    const fkAddCalls = calls.filter(c =>
      c.sql.startsWith('ALTER TABLE ad_member_server_packages ADD CONSTRAINT'));
    assert.equal(fkAddCalls.length, 0, 'no ADD CONSTRAINT on empty installed_packages');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
