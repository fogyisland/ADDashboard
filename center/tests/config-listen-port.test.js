// Unit tests for Task 2 — `getListenPort()` + `seedListenPortIfMissing()` +
// `sha256Hex()` helpers in center/src/config.js.
//
// Pins the regression behavior:
//   - getListenPort reads `system_config.listenPort` when present and returns
//     it as a number.
//   - getListenPort falls back to `defaultConfig().listenPort` (8080) when the
//     DB row is absent — does NOT seed; seeding is a separate bootstrap step.
//   - seedListenPortIfMissing writes the appsettings.json value into system_config
//     via db.sql.config.upsert and returns the seeded number.
//   - seedListenPortIfMissing is idempotent: when the DB already has the row
//     it returns the existing value WITHOUT issuing a second upsert.
//   - sha256Hex returns the first 16 hex chars (8 bytes) of sha256(input).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _setDbForTest } from '../src/db/index.js';
import { getListenPort, seedListenPortIfMissing, sha256Hex } from '../src/config.js';
import { buildMockDb } from './helpers/db-mock.js';

// ----- getListenPort -----

test('getListenPort: returns system_config.listenPort when present (parsed to number)', async () => {
  const db = buildMockDb([
    {
      match: /FROM\s+system_config\s+WHERE\s+config_key\s*=\s*'listenPort'/i,
      rows: [{ config_value: '9090' }]
    }
  ]).standard();
  _setDbForTest(db);
  const port = await getListenPort();
  assert.strictEqual(port, 9090);
});

test('getListenPort: falls back to appsettings.json default (8080) when DB row absent', async () => {
  const db = buildMockDb([
    { match: /FROM\s+system_config\s+WHERE\s+config_key\s*=\s*'listenPort'/i, rows: [] }
  ]).standard();
  _setDbForTest(db);
  const port = await getListenPort();
  assert.strictEqual(port, 8080);
});

test('getListenPort: invalid stored value (non-numeric) falls back to default', async () => {
  const db = buildMockDb([
    {
      match: /FROM\s+system_config\s+WHERE\s+config_key\s*=\s*'listenPort'/i,
      rows: [{ config_value: 'not-a-port' }]
    }
  ]).standard();
  _setDbForTest(db);
  const port = await getListenPort();
  assert.strictEqual(port, 8080);
});

test('getListenPort: does NOT seed (returns default even if DB row absent — no write side-effect)', async () => {
  // Recording pool — no execute calls should be issued by getListenPort.
  const records = [];
  const db = buildMockDb([
    { match: /FROM\s+system_config\s+WHERE\s+config_key\s*=\s*'listenPort'/i, rows: [] }
  ]).withRecording(records);
  _setDbForTest(db);
  const port = await getListenPort();
  assert.strictEqual(port, 8080);
  // No writes.
  const writes = records.filter(r => /INSERT|MERGE|UPDATE/i.test(r.sql));
  assert.strictEqual(writes.length, 0, 'getListenPort must not write to the DB');
});

// ----- seedListenPortIfMissing -----

test('seedListenPortIfMissing: writes appsettings.json default into system_config when absent', async () => {
  const records = [];
  const db = buildMockDb([
    { match: /FROM\s+system_config\s+WHERE\s+config_key\s*=\s*'listenPort'/i, rows: [] }
  ]).withRecording(records);
  _setDbForTest(db);
  const port = await seedListenPortIfMissing({ info() {} });
  assert.strictEqual(port, 8080);
  // The upsert must have been issued with key='listenPort', value='8080'.
  const upsert = records.find(r =>
    /INSERT\s+INTO\s+system_config|MERGE\s+INTO\s+system_config/i.test(r.sql)
  );
  assert.ok(upsert, 'expected system_config upsert to have been issued');
  assert.deepEqual(upsert.params, ['listenPort', '8080']);
});

test('seedListenPortIfMissing: idempotent — returns existing value without re-seeding', async () => {
  const records = [];
  const db = buildMockDb([
    {
      match: /FROM\s+system_config\s+WHERE\s+config_key\s*=\s*'listenPort'/i,
      rows: [{ config_value: '9090' }]
    }
  ]).withRecording(records);
  _setDbForTest(db);
  const port = await seedListenPortIfMissing({ info() {} });
  assert.strictEqual(port, 9090);
  // No upsert must have been issued because the row already exists.
  const upserts = records.filter(r =>
    /INSERT\s+INTO\s+system_config|MERGE\s+INTO\s+system_config/i.test(r.sql)
  );
  assert.strictEqual(upserts.length, 0, 'seed must be idempotent — no upsert when row exists');
});

// ----- sha256Hex -----

test('sha256Hex: returns 16 hex chars (first 8 bytes of sha256 digest)', () => {
  const h = sha256Hex('2026-08-08T00:00:00.000Z:8080');
  assert.match(h, /^[0-9a-f]{16}$/);
});

test('sha256Hex: deterministic across calls', () => {
  const a = sha256Hex('2026-08-08T00:00:00.000Z:9090');
  const b = sha256Hex('2026-08-08T00:00:00.000Z:9090');
  assert.strictEqual(a, b);
});

test('sha256Hex: different inputs produce different hashes', () => {
  const a = sha256Hex('2026-08-08T00:00:00.000Z:8080');
  const b = sha256Hex('2026-08-08T00:00:00.000Z:9090');
  assert.notStrictEqual(a, b);
});
