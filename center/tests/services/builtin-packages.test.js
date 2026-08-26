// Tests for Task 4 — `seedBuiltinPackages()` service in
// center/src/services/builtin-packages.js.
//
// On first normal-mode start, the seeder copies the bundled built-in
// package directory (publish/system/center/data/packages/<name>/<version>/) into
// the runtime data dir (data/packages/<name>/<version>/) so the agent
// runner can read it. The seeder is idempotent: subsequent runs detect
// the manifest.json and skip copy + audit write.
//
// Source dir layout under test:
//   publish/system/center/data/packages/ad_os_baseline/1.0.0/
//     manifest.json
//     collect.ps1
//     migrations/001_initial.sql
//     content.sha256
//
// Task 6 added two more built-ins to BUILTIN_PACKAGES so they seed in the
// same first-start pass. Their source layout omits content.sha256 and adds
// an MSSQL migration sibling:
//   publish/system/center/data/packages/ad_domain_consistency/1.0.0/
//   publish/system/center/data/packages/ad_local_port_check/1.0.0/
//     manifest.json
//     collect.ps1
//     migrations/001_initial.sql
//     migrations/mssql/001_initial.sql
//
// These tests use a tmp dataDir so they don't pollute the real data/packages
// tree; they import the real bundled sourceDir (which already exists in the
// repo) so the test asserts the actual on-disk layout that ships.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { seedBuiltinPackages, BUILTIN_PACKAGES } from '../../src/services/builtin-packages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = path.join(__dirname, '..', '..', '..', 'publish', 'system', 'center', 'data', 'packages');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-pkg-'));
}

test('seedBuiltinPackages: creates ad_os_baseline directory on first run', async () => {
  const tmp = makeTmpDir();
  try {
    await seedBuiltinPackages({ dataDir: tmp, sourceDir: SOURCE_DIR });
    const manifestPath = path.join(tmp, 'ad_os_baseline', '1.0.0', 'manifest.json');
    assert.ok(fs.existsSync(manifestPath), `manifest.json should exist at ${manifestPath}`);
    const collectPath = path.join(tmp, 'ad_os_baseline', '1.0.0', 'collect.ps1');
    assert.ok(fs.existsSync(collectPath), 'collect.ps1 should exist');
    const migPath = path.join(tmp, 'ad_os_baseline', '1.0.0', 'migrations', '001_initial.sql');
    assert.ok(fs.existsSync(migPath), 'migrations/001_initial.sql should exist');
    const shaPath = path.join(tmp, 'ad_os_baseline', '1.0.0', 'content.sha256');
    assert.ok(fs.existsSync(shaPath), 'content.sha256 should exist');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('seedBuiltinPackages: is idempotent — second run is no-op (no audit write)', async () => {
  const tmp = makeTmpDir();
  try {
    let auditCalls = 0;
    const writeAudit = async () => { auditCalls++; };
    await seedBuiltinPackages({ dataDir: tmp, sourceDir: SOURCE_DIR, writeAudit });
    assert.strictEqual(auditCalls, BUILTIN_PACKAGES.length,
      'first run should write one audit per built-in package');

    // Second run must NOT throw and must NOT write another audit (idempotent).
    await seedBuiltinPackages({ dataDir: tmp, sourceDir: SOURCE_DIR, writeAudit });
    assert.strictEqual(auditCalls, BUILTIN_PACKAGES.length, 'second run should be no-op (idempotent)');

    // Files still exist after second run — for every built-in, not just the first.
    for (const pkg of BUILTIN_PACKAGES) {
      assert.ok(
        fs.existsSync(path.join(tmp, pkg.name, pkg.version, 'manifest.json')),
        `${pkg.name} manifest.json should survive the second run`
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('seedBuiltinPackages: emits seed_builtin_ad_os_baseline audit on success', async () => {
  const tmp = makeTmpDir();
  try {
    const auditPayloads = [];
    const writeAudit = async (entry) => { auditPayloads.push(entry); };
    await seedBuiltinPackages({ dataDir: tmp, sourceDir: SOURCE_DIR, writeAudit });
    const entry = auditPayloads.find((e) => e.action === 'seed_builtin_ad_os_baseline');
    assert.ok(entry, 'seed_builtin_ad_os_baseline audit should be emitted');
    assert.strictEqual(entry.target, 'packages');
    assert.strictEqual(entry.payload?.name, 'ad_os_baseline');
    assert.strictEqual(entry.payload?.version, '1.0.0');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('seedBuiltinPackages: works without writeAudit (optional dep)', async () => {
  const tmp = makeTmpDir();
  try {
    await seedBuiltinPackages({ dataDir: tmp, sourceDir: SOURCE_DIR });
    assert.ok(fs.existsSync(path.join(tmp, 'ad_os_baseline', '1.0.0', 'manifest.json')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- Task 6: the two new built-ins auto-seed alongside ad_os_baseline ---

test('BUILTIN_PACKAGES: registers all three built-ins at 1.0.0', () => {
  assert.deepStrictEqual(BUILTIN_PACKAGES, [
    { name: 'ad_os_baseline', version: '1.0.0' },
    { name: 'ad_domain_consistency', version: '1.0.0' },
    { name: 'ad_local_port_check', version: '1.0.0' }
  ]);
});

test('BUILTIN_PACKAGES: every registered entry has a real source dir with a matching manifest', () => {
  // Guards against a registration whose source dir was never mirrored — the
  // seeder throws a hard error at startup in that case, so catch it here.
  // Note the naming convention: the on-disk directory + BUILTIN_PACKAGES key
  // are snake_case, while manifest.name is the hyphenated package id.
  for (const pkg of BUILTIN_PACKAGES) {
    const manifestPath = path.join(SOURCE_DIR, pkg.name, pkg.version, 'manifest.json');
    assert.ok(fs.existsSync(manifestPath), `source manifest missing for ${pkg.name}: ${manifestPath}`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.strictEqual(manifest.name.replace(/-/g, '_'), pkg.name,
      `manifest.name "${manifest.name}" should map to dir "${pkg.name}"`);
    assert.strictEqual(manifest.version, pkg.version, `manifest.version mismatch for ${pkg.name}`);
  }
});

for (const name of ['ad_domain_consistency', 'ad_local_port_check']) {
  test(`seedBuiltinPackages: seeds ${name} with manifest + collect.ps1 + migrations`, async () => {
    const tmp = makeTmpDir();
    try {
      await seedBuiltinPackages({ dataDir: tmp, sourceDir: SOURCE_DIR });
      const base = path.join(tmp, name, '1.0.0');
      assert.ok(fs.existsSync(path.join(base, 'manifest.json')), 'manifest.json should exist');
      assert.ok(fs.existsSync(path.join(base, 'collect.ps1')), 'collect.ps1 should exist');
      assert.ok(
        fs.existsSync(path.join(base, 'migrations', '001_initial.sql')),
        'migrations/001_initial.sql should exist'
      );
      // Nested subdirectory must be copied recursively, not flattened/skipped.
      assert.ok(
        fs.existsSync(path.join(base, 'migrations', 'mssql', '001_initial.sql')),
        'migrations/mssql/001_initial.sql should exist'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test(`seedBuiltinPackages: emits seed_builtin_${name} audit on success`, async () => {
    const tmp = makeTmpDir();
    try {
      const auditPayloads = [];
      const writeAudit = async (entry) => { auditPayloads.push(entry); };
      await seedBuiltinPackages({ dataDir: tmp, sourceDir: SOURCE_DIR, writeAudit });
      const entry = auditPayloads.find((e) => e.action === `seed_builtin_${name}`);
      assert.ok(entry, `seed_builtin_${name} audit should be emitted`);
      assert.strictEqual(entry.target, 'packages');
      assert.strictEqual(entry.payload?.name, name);
      assert.strictEqual(entry.payload?.version, '1.0.0');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test('seedBuiltinPackages: a single pass seeds all three built-ins (production first-start flow)', async () => {
  const tmp = makeTmpDir();
  try {
    const actions = [];
    const writeAudit = async (entry) => { actions.push(entry.action); };
    await seedBuiltinPackages({ dataDir: tmp, sourceDir: SOURCE_DIR, writeAudit });

    for (const pkg of BUILTIN_PACKAGES) {
      assert.ok(
        fs.existsSync(path.join(tmp, pkg.name, pkg.version, 'manifest.json')),
        `${pkg.name} should be seeded in the same pass`
      );
      assert.ok(
        fs.existsSync(path.join(tmp, pkg.name, pkg.version, 'collect.ps1')),
        `${pkg.name}/collect.ps1 should be seeded in the same pass`
      );
    }

    assert.deepStrictEqual(actions, [
      'seed_builtin_ad_os_baseline',
      'seed_builtin_ad_domain_consistency',
      'seed_builtin_ad_local_port_check'
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('seedBuiltinPackages: partial state re-seeds only the missing built-ins', async () => {
  const tmp = makeTmpDir();
  try {
    // First pass seeds everything.
    await seedBuiltinPackages({ dataDir: tmp, sourceDir: SOURCE_DIR });

    // Operator deletes one package to force a targeted re-seed.
    fs.rmSync(path.join(tmp, 'ad_local_port_check'), { recursive: true, force: true });

    const actions = [];
    const writeAudit = async (entry) => { actions.push(entry.action); };
    await seedBuiltinPackages({ dataDir: tmp, sourceDir: SOURCE_DIR, writeAudit });

    assert.deepStrictEqual(actions, ['seed_builtin_ad_local_port_check'],
      'only the deleted package should be re-seeded');
    assert.ok(fs.existsSync(path.join(tmp, 'ad_local_port_check', '1.0.0', 'manifest.json')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- Round-12 runAllNow count:0 fix: seedBuiltinPackages must also register
// each built-in in the installed_packages DB table so the agent's
// /api/agent/packages endpoint serves them. Pre-fix installs seeded files
// but never wrote the DB row → agent saw [] → runAllNow logged count:0. ---

// Build a mock db that captures every INSERT INTO installed_packages call.
// We don't exercise the real driver — we only assert that seedBuiltinPackages
// passes the right (name, version, type, manifest, enabled, params, source)
// tuple to the upsert helper, and that it does so once per built-in.
function makeMockDb() {
  const upserts = [];
  const mock = {
    dialect: 'mysql',
    async execute(sql, params) {
      if (typeof sql === 'string' && sql.includes('INSERT INTO installed_packages')) {
        upserts.push({ sql, params });
      }
      return { rows: [] };
    }
  };
  return { mock, upserts };
}

test('seedBuiltinPackages: upserts installed_packages row for every built-in when db is provided', async () => {
  const tmp = makeTmpDir();
  try {
    const { mock, upserts } = makeMockDb();
    await seedBuiltinPackages({
      dataDir: tmp,
      sourceDir: SOURCE_DIR,
      db: mock
    });

    assert.strictEqual(upserts.length, BUILTIN_PACKAGES.length,
      `expected one upsert per built-in (${BUILTIN_PACKAGES.length}), got ${upserts.length}`);

    const upsertedNames = upserts.map(u => u.params[0]).sort();
    const expectedNames = BUILTIN_PACKAGES.map(p => p.name).sort();
    assert.deepStrictEqual(upsertedNames, expectedNames,
      'every built-in should appear in the upsert list');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('seedBuiltinPackages: upserted row carries correct (name, version, type, enabled, source) shape', async () => {
  const tmp = makeTmpDir();
  try {
    const { mock, upserts } = makeMockDb();
    await seedBuiltinPackages({
      dataDir: tmp,
      sourceDir: SOURCE_DIR,
      db: mock
    });

    // Find the row for ad_os_baseline — its manifest has type=gauge and a
    // known intervalSec; use it as the shape anchor.
    const baseline = upserts.find(u => u.params[0] === 'ad_os_baseline');
    assert.ok(baseline, 'ad_os_baseline should be upserted');

    // Params order per UPSERT_MYSQL: name, version, type, manifest_json,
    // enabled, params_json, installed_at, updated_at, source.
    assert.strictEqual(baseline.params[0], 'ad_os_baseline');
    assert.strictEqual(baseline.params[1], '1.0.0');
    assert.strictEqual(baseline.params[2], 'gauge', 'type should come from manifest.type');
    const manifest = JSON.parse(baseline.params[3]);
    assert.strictEqual(manifest.name, 'ad-os-baseline', 'manifest_json should round-trip');
    assert.strictEqual(manifest.version, '1.0.0');
    assert.strictEqual(baseline.params[4], 1, 'enabled should be 1 (built-ins auto-enable)');
    assert.strictEqual(baseline.params[5], null, 'params_json should be null for built-ins');
    assert.strictEqual(baseline.params[8], 'builtin-seed', 'source should mark the upsert provenance');
    // installed_at / updated_at (params[6,7]) are Date objects — just verify
    // they're recent (within the last minute) to confirm they're stamped now.
    const installedAt = new Date(baseline.params[6]).getTime();
    const updatedAt = new Date(baseline.params[7]).getTime();
    const now = Date.now();
    assert.ok(Math.abs(now - installedAt) < 60_000, 'installed_at should be ~now');
    assert.ok(Math.abs(now - updatedAt) < 60_000, 'updated_at should be ~now');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('seedBuiltinPackages: idempotent restart upserts all 3 again (recovers DB-empty installs)', async () => {
  // The bug we're fixing: pre-fix installs left files on disk but no
  // installed_packages row. On first restart after this fix ships, the
  // seeder must upsert every built-in even though the files were copied
  // in a previous run. The upsert is idempotent at the DB layer (INSERT
  // ... ON DUPLICATE KEY UPDATE), so a second pass is safe.
  const tmp = makeTmpDir();
  try {
    const { mock, upserts } = makeMockDb();

    // First run: files copy + DB upsert.
    await seedBuiltinPackages({ dataDir: tmp, sourceDir: SOURCE_DIR, db: mock });
    assert.strictEqual(upserts.length, BUILTIN_PACKAGES.length);

    // Second run: file copy skipped (manifest.json exists), but DB upsert
    // still runs for every built-in. Simulates the recovery case where
    // files were seeded by an old binary that didn't touch the DB.
    await seedBuiltinPackages({ dataDir: tmp, sourceDir: SOURCE_DIR, db: mock });
    assert.strictEqual(upserts.length, BUILTIN_PACKAGES.length * 2,
      'DB upsert must run on every restart to recover installs where files were seeded without a DB row');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('seedBuiltinPackages: without db, no upsert is attempted (no DB import path)', async () => {
  // Backward compatibility: existing callers (and the partial-state test
  // above) that don't pass db must not be forced to mock one. The seeder
  // must keep working with no DB by skipping the upsert entirely.
  const tmp = makeTmpDir();
  try {
    // No db — must not throw, must not even attempt to import installedPackages.
    await seedBuiltinPackages({ dataDir: tmp, sourceDir: SOURCE_DIR });
    assert.ok(fs.existsSync(path.join(tmp, 'ad_os_baseline', '1.0.0', 'manifest.json')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('seedBuiltinPackages: DB upsert failures bubble (no silent skip — caller logs warn)', async () => {
  // If the DB upsert throws, the whole seed must throw too — server.js
  // wraps this in try/catch and logs warn. Silently swallowing would
  // leave the bug unfixed on the next restart and the operator with no
  // signal that something is wrong.
  const tmp = makeTmpDir();
  try {
    const mockDb = {
      dialect: 'mysql',
      async execute() {
        throw new Error('simulated DB outage');
      }
    };
    await assert.rejects(
      () => seedBuiltinPackages({ dataDir: tmp, sourceDir: SOURCE_DIR, db: mockDb }),
      /simulated DB outage/
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});