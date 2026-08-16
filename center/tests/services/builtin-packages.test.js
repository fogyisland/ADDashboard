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
// These tests use a tmp dataDir so they don't pollute the real data/packages
// tree; they import the real bundled sourceDir (which already exists in the
// repo) so the test asserts the actual on-disk layout that ships.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { seedBuiltinPackages } from '../../src/services/builtin-packages.js';

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
    assert.strictEqual(auditCalls, 1, 'first run should write one audit');

    // Second run must NOT throw and must NOT write another audit (idempotent).
    await seedBuiltinPackages({ dataDir: tmp, sourceDir: SOURCE_DIR, writeAudit });
    assert.strictEqual(auditCalls, 1, 'second run should be no-op (idempotent)');

    // Files still exist after second run.
    assert.ok(fs.existsSync(path.join(tmp, 'ad_os_baseline', '1.0.0', 'manifest.json')));
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
    assert.strictEqual(auditPayloads.length, 1);
    assert.strictEqual(auditPayloads[0].action, 'seed_builtin_ad_os_baseline');
    assert.strictEqual(auditPayloads[0].target, 'packages');
    assert.strictEqual(auditPayloads[0].payload?.name, 'ad_os_baseline');
    assert.strictEqual(auditPayloads[0].payload?.version, '1.0.0');
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