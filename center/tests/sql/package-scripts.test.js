import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packageScripts, packageScriptsSql } from '../../src/db/sql/package-scripts.js';

test('upsert preserves sha256 + manifest shape', async () => {
  const calls = [];
  const db = {
    dialect: 'mysql',
    execute: async (sql, params) => {
      calls.push({ sql: sql.trim().split('\n')[0], params });
      return { rows: [] };
    }
  };
  await packageScripts.upsert(db, {
    name: 'pkg-a', version: '1.0.0', scriptContent: 'Write-Host hi',
    scriptSha256: 'a'.repeat(64), manifest: { name: 'pkg-a', type: 'gauge', agent: { type: 'ad', script: 'collect.ps1' } },
    source: 'admin-upload'
  });
  assert.match(calls[0].sql, /INSERT INTO package_scripts/);
  assert.equal(calls[0].params[0], 'pkg-a');
  assert.equal(calls[0].params[3], 'a'.repeat(64));
  assert.equal(calls[0].params[5], 'admin-upload');
});

test('list returns rows hydrated into { manifest: object, ...row }', async () => {
  const db = {
    dialect: 'mysql',
    execute: async () => ({ rows: [{ id: 1, name: 'pkg-a', version: '1.0.0',
      script_sha256: 'a'.repeat(64), manifest_json: '{"name":"pkg-a","type":"gauge"}',
      source: 'admin-upload', created_at: new Date(), updated_at: new Date() }] })
  };
  const rows = await packageScripts.list(db);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].manifest, { name: 'pkg-a', type: 'gauge' });
});

test('registry exposes both mysql + mssql variants', () => {
  assert.ok(packageScriptsSql.upsert.mysql);
  assert.ok(packageScriptsSql.upsert.mssql);
  assert.ok(packageScriptsSql.list.mysql);
  assert.ok(packageScriptsSql.list.mssql);
});