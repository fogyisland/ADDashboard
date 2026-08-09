import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, manifestSchema } from '../../src/packages/manifest.js';

const baseManifest = {
  name: 'ad-test',
  version: '1.0.0',
  type: 'gauge'
};

test('validateManifest: v1 manifest (no database) still passes', () => {
  const { valid, errors } = validateManifest(baseManifest);
  assert.strictEqual(valid, true, JSON.stringify(errors));
});

test('validateManifest: v2 manifest with valid database passes', () => {
  const m = {
    ...baseManifest,
    database: {
      schemaName: 'pkg_ad_test',
      migrations: ['migrations/001.sql'],
      metricTable: 'metrics',
      metricSchema: {
        agent_id: { type: 'varchar(64)', nullable: false },
        ts:       { type: 'datetime',    nullable: false },
        val:      { type: 'double' }
      }
    }
  };
  const { valid, errors } = validateManifest(m);
  assert.strictEqual(valid, true, JSON.stringify(errors));
});

test('validateManifest: rejects database with invalid schemaName pattern', () => {
  const m = {
    ...baseManifest,
    database: {
      schemaName: 'wrong_prefix',
      migrations: ['migrations/001.sql'],
      metricTable: 'metrics',
      metricSchema: { agent_id: { type: 'varchar(64)', nullable: false }, ts: { type: 'datetime', nullable: false } }
    }
  };
  const { valid } = validateManifest(m);
  assert.strictEqual(valid, false);
});

test('validateManifest: rejects database with empty migrations', () => {
  const m = {
    ...baseManifest,
    database: {
      schemaName: 'pkg_ad_test',
      migrations: [],
      metricTable: 'metrics',
      metricSchema: { agent_id: { type: 'varchar(64)', nullable: false }, ts: { type: 'datetime', nullable: false } }
    }
  };
  const { valid } = validateManifest(m);
  assert.strictEqual(valid, false);
});

test('validateManifest: rejects database with invalid metricTable pattern', () => {
  const m = {
    ...baseManifest,
    database: {
      schemaName: 'pkg_ad_test',
      migrations: ['001.sql'],
      metricTable: 'metrics;DROP TABLE x',
      metricSchema: { agent_id: { type: 'varchar(64)', nullable: false }, ts: { type: 'datetime', nullable: false } }
    }
  };
  const { valid } = validateManifest(m);
  assert.strictEqual(valid, false);
});

test('validateManifest: rejects unknown field in database', () => {
  const m = {
    ...baseManifest,
    database: {
      schemaName: 'pkg_ad_test',
      migrations: ['001.sql'],
      metricTable: 'metrics',
      metricSchema: { agent_id: { type: 'varchar(64)', nullable: false }, ts: { type: 'datetime', nullable: false } },
      rogueField: 'evil'
    }
  };
  const { valid } = validateManifest(m);
  assert.strictEqual(valid, false);
});

test('validateManifest: rejects metricSchema without agent_id', () => {
  const m = {
    ...baseManifest,
    database: {
      schemaName: 'pkg_ad_test',
      migrations: ['001.sql'],
      metricTable: 'metrics',
      metricSchema: { ts: { type: 'datetime', nullable: false }, val: { type: 'double' } }
    }
  };
  const { valid } = validateManifest(m);
  assert.strictEqual(valid, false);
});

test('validateManifest: rejects metricSchema without ts', () => {
  const m = {
    ...baseManifest,
    database: {
      schemaName: 'pkg_ad_test',
      migrations: ['001.sql'],
      metricTable: 'metrics',
      metricSchema: { agent_id: { type: 'varchar(64)', nullable: false }, val: { type: 'double' } }
    }
  };
  const { valid } = validateManifest(m);
  assert.strictEqual(valid, false);
});

test('manifestSchema.database.metricSchema column type accepts canonical types', () => {
  for (const t of ['int', 'integer', 'bigint', 'varchar(64)', 'double', 'datetime', 'json', 'boolean', 'nvarchar(255)']) {
    const m = {
      ...baseManifest,
      database: {
        schemaName: 'pkg_ad_test',
        migrations: ['001.sql'],
        metricTable: 'metrics',
        metricSchema: { agent_id: { type: 'varchar(64)', nullable: false }, ts: { type: 'datetime', nullable: false }, val: { type: t } }
      }
    };
    const { valid, errors } = validateManifest(m);
    assert.strictEqual(valid, true, `${t} rejected: ${JSON.stringify(errors)}`);
  }
});
