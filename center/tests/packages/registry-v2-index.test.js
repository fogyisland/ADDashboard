// Registry index schema v2 tests — verifies the optional `database` field
// on each package entry:
//   - v1 entries (no database) still validate
//   - v2 entries with a valid database block validate
//   - v2 entries with a malformed database block reject

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRegistryIndex } from '../../src/packages/registry.js';

const basePkg = {
  name: 'ad-test',
  latestVersion: '1.0.0',
  type: 'gauge',
  versions: [
    {
      version: '1.0.0',
      package: 'x.zip',
      size: 100,
      sha256: 'a'.repeat(64),
    },
  ],
};

test('validateRegistryIndex: v1 entries (no database) still validate', () => {
  const idx = {
    version: 1,
    updatedAt: '2026-08-09T00:00:00Z',
    packages: [{ ...basePkg, name: 'ad-cpu-monitor' }],
  };
  const { valid, errors } = validateRegistryIndex(idx);
  assert.strictEqual(valid, true, JSON.stringify(errors));
});

test('validateRegistryIndex: v2 entries with valid database validate', () => {
  const idx = {
    version: 1,
    updatedAt: '2026-08-09T00:00:00Z',
    packages: [
      {
        ...basePkg,
        name: 'ad-cpu-monitor-v2',
        database: {
          schemaName: 'pkg_ad_cpu_monitor_v2',
          migrations: ['migrations/001.sql'],
          metricTable: 'metrics',
          metricColumns: 3,
        },
      },
    ],
  };
  const { valid, errors } = validateRegistryIndex(idx);
  assert.strictEqual(valid, true, JSON.stringify(errors));
});

test('validateRegistryIndex: rejects database with bad schemaName pattern', () => {
  const idx = {
    version: 1,
    updatedAt: '2026-08-09T00:00:00Z',
    packages: [
      {
        ...basePkg,
        name: 'ad-foo',
        database: {
          schemaName: 'wrong_prefix',
          migrations: ['001.sql'],
          metricTable: 'metrics',
          metricColumns: 3,
        },
      },
    ],
  };
  const { valid } = validateRegistryIndex(idx);
  assert.strictEqual(valid, false);
});