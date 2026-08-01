// installer.test.js — covers center/src/packages/installer.js against a
// mock db. No live DB; each execute/query is recorded and can be shaped
// per-SQL via _addScript(match, result).
//
// Six scenarios from the brief:
//   1. installs valid ZIP
//   2. rejects invalid manifest
//   3. rejects name conflict
//   4. upgrade replaces installed_packages row
//   5. upgrade rejects type change (manifest.type mismatch)
//   6. uninstall removes row

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { buildSql } from '../../src/db/sql.js';
import { installer } from '../../src/packages/installer.js';

function makeMockDb({ dialect = 'mysql' } = {}) {
  const calls = [];
  const scripts = [];
  function lookup(sql) {
    for (const s of scripts) {
      if (s.match.test(sql)) {
        if (typeof s.result === 'function') return s.result();
        return s.result;
      }
    }
    return { rows: [], affectedRows: 1, insertId: undefined };
  }
  const db = {
    dialect,
    sql: buildSql(dialect),
    async execute(sql, params = []) {
      calls.push({ sql, params: [...params] });
      return lookup(sql);
    },
    async query(sql, params = []) {
      calls.push({ sql, params: [...params] });
      return { rows: lookup(sql).rows };
    },
    async transaction(work) {
      return work({
        execute: async (sql, params = []) => {
          calls.push({ sql, params: [...params] });
          return lookup(sql);
        },
        query: async (sql, params = []) => {
          calls.push({ sql, params: [...params] });
          return { rows: lookup(sql).rows };
        }
      });
    },
    _calls: calls,
    _addScript(match, result) { scripts.push({ match, result }); }
  };
  return db;
}

function buildFixtureZip({ name, version, type, ...overrides }) {
  const manifest = {
    name,
    version,
    type,
    description: 'test',
    agent: {
      minVersion: '1.0.0',
      script: 'collect.ps1',
      intervalSec: 60,
      timeoutMs: 30000
    },
    metrics: [{ key: 'm1', label: 'M1' }],
    params: { schema: { type: 'object' }, required: [] },
    widget: { type: 'builtin', component: 'GaugeTile' },
    ...overrides
  };
  const ps1 = 'Write-Output \'{"metrics":{"m1":42}}\'';
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
  zip.addFile('collect.ps1', Buffer.from(ps1));
  return zip.toBuffer();
}

function findCall(calls, predicate) {
  return calls.find(predicate);
}

describe('installer.installPackage', () => {
  afterEach(() => {
    // Clean up cache directories written by installPackage so test
    // artifacts don't leak between runs.
    fs.rmSync(path.join(process.cwd(), 'data', 'packages', 'test-mem'), {
      recursive: true,
      force: true
    });
  });

  test('installs valid ZIP', async () => {
    const db = makeMockDb();
    // The installer first checks if the package already exists; the GET
    // should return no rows for a fresh install.
    db._addScript(/FROM installed_packages WHERE name = \?/i, { rows: [] });
    const buffer = buildFixtureZip({ name: 'test-mem', version: '1.0.0', type: 'gauge' });
    const r = await installer.installPackage(db, {
      source: 'local',
      packageRef: 'test-mem',
      buffer
    });
    assert.equal(r.name, 'test-mem');
    assert.equal(r.version, '1.0.0');

    // Verify a row was upserted with enabled=false (installed-but-disabled).
    const upsertCall = findCall(
      db._calls,
      (c) => /INSERT INTO installed_packages/i.test(c.sql) || /MERGE INTO installed_packages/i.test(c.sql)
    );
    assert.ok(upsertCall, 'expected an upsert into installed_packages');
    assert.match(upsertCall.sql, /installed_packages/);
    // Params order: name, version, type, manifest_json, enabled, params_json,
    // installed_at, updated_at, source
    assert.equal(upsertCall.params[0], 'test-mem');
    assert.equal(upsertCall.params[1], '1.0.0');
    assert.equal(upsertCall.params[2], 'gauge');
    assert.equal(upsertCall.params[4], 0); // enabled = 0 (tinyint for false)
    assert.equal(upsertCall.params[8], 'local');
  });

  test('rejects invalid manifest', async () => {
    const db = makeMockDb();
    const buffer = buildFixtureZip({ name: 'bad', version: '1.0.0', type: 'invalid' });
    await assert.rejects(
      () => installer.installPackage(db, { source: 'local', packageRef: 'bad', buffer }),
      (err) => {
        assert.equal(err.code, 'PKG_INVALID_MANIFEST');
        assert.equal(err.status, 400);
        return true;
      }
    );
  });

  test('rejects name conflict when package already installed', async () => {
    const db = makeMockDb();
    // GET returns an existing row → name conflict.
    db._addScript(/FROM installed_packages WHERE name = \?/i, {
      rows: [{ name: 'test-mem', version: '1.0.0', enabled: 1 }]
    });
    const buffer = buildFixtureZip({ name: 'test-mem', version: '1.0.0', type: 'gauge' });
    await assert.rejects(
      () => installer.installPackage(db, { source: 'local', packageRef: 'test-mem', buffer }),
      (err) => {
        assert.equal(err.code, 'PKG_NAME_CONFLICT');
        assert.equal(err.status, 409);
        return true;
      }
    );
  });
});

describe('installer.upgradePackage', () => {
  test('upgrades and replaces installed_packages row', async () => {
    const db = makeMockDb();
    // GET returns the existing 1.0.0 row.
    db._addScript(/FROM installed_packages WHERE name = \?/i, {
      rows: [{
        name: 'cpu-monitor',
        version: '1.0.0',
        type: 'gauge',
        manifest_json: JSON.stringify({ name: 'cpu-monitor', version: '1.0.0', type: 'gauge' }),
        enabled: 1,
        params_json: null,
        source: 'local'
      }]
    });
    const r = await installer.upgradePackage(db, { name: 'cpu-monitor', version: '1.1.0' });
    assert.deepEqual(r, { name: 'cpu-monitor', version: '1.1.0' });

    // Verify the upsert was issued with the new version while keeping the
    // existing type (gauge) — i.e., upgrade preserves type.
    const upsertCall = findCall(
      db._calls,
      (c) => /INSERT INTO installed_packages/i.test(c.sql) || /MERGE INTO installed_packages/i.test(c.sql)
    );
    assert.ok(upsertCall, 'expected an upsert into installed_packages');
    assert.equal(upsertCall.params[0], 'cpu-monitor');
    assert.equal(upsertCall.params[1], '1.1.0');
    assert.equal(upsertCall.params[2], 'gauge');
  });

  test('upgrade rejects type change when manifest type differs', async () => {
    const db = makeMockDb();
    // GET returns the existing 1.0.0 gauge row.
    db._addScript(/FROM installed_packages WHERE name = \?/i, {
      rows: [{
        name: 'cpu-monitor',
        version: '1.0.0',
        type: 'gauge',
        manifest_json: JSON.stringify({ name: 'cpu-monitor', version: '1.0.0', type: 'gauge' }),
        enabled: 1,
        params_json: null,
        source: 'local'
      }]
    });
    const candidateManifest = {
      name: 'cpu-monitor',
      version: '1.1.0',
      type: 'counter',  // <-- type change: gauge → counter
      description: 'test',
      agent: {
        minVersion: '1.0.0',
        script: 'collect.ps1',
        intervalSec: 60,
        timeoutMs: 30000
      },
      metrics: [{ key: 'm1', label: 'M1' }],
      params: { schema: { type: 'object' }, required: [] },
      widget: { type: 'builtin', component: 'GaugeTile' }
    };
    await assert.rejects(
      () => installer.upgradePackage(db, { name: 'cpu-monitor', version: '1.1.0', manifest: candidateManifest }),
      (err) => {
        assert.equal(err.code, 'PKG_VALIDATION_FAILED');
        assert.equal(err.status, 400);
        assert.match(err.message, /type change not allowed/);
        return true;
      }
    );
    // No upsert should have been issued.
    const upsertCall = findCall(
      db._calls,
      (c) => /INSERT INTO installed_packages/i.test(c.sql) || /MERGE INTO installed_packages/i.test(c.sql)
    );
    assert.equal(upsertCall, undefined, 'no upsert should be issued when type change is rejected');
  });

  test('upgrade rejects when package not found', async () => {
    const db = makeMockDb();
    db._addScript(/FROM installed_packages WHERE name = \?/i, { rows: [] });
    await assert.rejects(
      () => installer.upgradePackage(db, { name: 'nope', version: '1.1.0' }),
      (err) => {
        assert.equal(err.code, 'PKG_NOT_FOUND');
        assert.equal(err.status, 404);
        return true;
      }
    );
  });
});

describe('installer.uninstallPackage', () => {
  test('removes row and does not purge metrics by default', async () => {
    const db = makeMockDb();
    db._addScript(/FROM installed_packages WHERE name = \?/i, {
      rows: [{ name: 'cpu-monitor', version: '1.0.0' }]
    });
    await installer.uninstallPackage(db, { name: 'cpu-monitor', purgeMetrics: false });

    // Expect a DELETE on installed_packages and a DELETE on package_runs,
    // but NO DELETE on the metric_* tables.
    const deletePackageRow = findCall(
      db._calls,
      (c) => /DELETE FROM installed_packages WHERE name = \?/i.test(c.sql)
    );
    assert.ok(deletePackageRow, 'expected DELETE FROM installed_packages');
    assert.deepEqual(deletePackageRow.params, ['cpu-monitor']);

    const deleteRuns = findCall(
      db._calls,
      (c) => /DELETE FROM package_runs WHERE package_name = \?/i.test(c.sql)
    );
    assert.ok(deleteRuns, 'expected DELETE FROM package_runs');
    assert.deepEqual(deleteRuns.params, ['cpu-monitor']);

    const metricDeletes = db._calls.filter((c) => /FROM metric_/i.test(c.sql));
    assert.equal(metricDeletes.length, 0, 'metric_* should not be deleted when purgeMetrics=false');
  });

  test('rejects uninstall when package not found', async () => {
    const db = makeMockDb();
    db._addScript(/FROM installed_packages WHERE name = \?/i, { rows: [] });
    await assert.rejects(
      () => installer.uninstallPackage(db, { name: 'nope' }),
      (err) => {
        assert.equal(err.code, 'PKG_NOT_FOUND');
        assert.equal(err.status, 404);
        return true;
      }
    );
  });

  test('purges metric_* rows + package_runs + cache dir when purgeMetrics=true', async () => {
    const db = makeMockDb();
    // Pre-populate the cache directory so we can verify it gets removed.
    const cacheDir = path.join(process.cwd(), 'data', 'packages', 'test-mem', '1.0.0');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'manifest.json'), '{}');
    fs.writeFileSync(path.join(cacheDir, 'collect.ps1'), 'Write-Output "x"');
    assert.ok(fs.existsSync(cacheDir), 'cache dir should exist before uninstall');

    db._addScript(/FROM installed_packages WHERE name = \?/i, {
      rows: [{ name: 'test-mem', version: '1.0.0' }]
    });
    await installer.uninstallPackage(db, { name: 'test-mem', purgeMetrics: true });

    // 4 metric_* DELETEs with metric_id LIKE '<name>.%'
    const expectedTables = ['metric_gauge', 'metric_counter', 'metric_timeseries', 'metric_status'];
    for (const table of expectedTables) {
      const call = findCall(
        db._calls,
        (c) => new RegExp(`DELETE FROM ${table} WHERE metric_id LIKE \\?`, 'i').test(c.sql)
      );
      assert.ok(call, `expected DELETE FROM ${table} WHERE metric_id LIKE ?`);
      assert.deepEqual(call.params, ['test-mem.%']);
    }

    // DELETE FROM package_runs WHERE package_name = ?
    const deleteRuns = findCall(
      db._calls,
      (c) => /DELETE FROM package_runs WHERE package_name = \?/i.test(c.sql)
    );
    assert.ok(deleteRuns, 'expected DELETE FROM package_runs');
    assert.deepEqual(deleteRuns.params, ['test-mem']);

    // Cache dir should be gone.
    const cacheParent = path.join(process.cwd(), 'data', 'packages', 'test-mem');
    assert.ok(!fs.existsSync(cacheParent), 'cache directory should be removed after uninstall');
  });
});