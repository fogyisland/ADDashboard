import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMockDb } from '../helpers/db-mock.js';
import {
  getJwtSecretState,
  rotateJwtSecret,
  commitJwtSecret,
  seedJwtSecretIfMissing
} from '../../src/services/jwt-secret.js';

const noopLogger = { info(){}, warn(){}, error(){}, debug(){} };

function bundleRows({ current = '', previous = '', rotatedAt = '', ttlDays = '30' } = {}) {
  const rows = [];
  if (current !== null) rows.push({ config_key: 'jwt_secret_current', config_value: current });
  if (previous !== null) rows.push({ config_key: 'jwt_secret_previous', config_value: previous });
  if (rotatedAt !== null) rows.push({ config_key: 'jwt_secret_rotated_at', config_value: rotatedAt });
  if (ttlDays !== null) rows.push({ config_key: 'jwt_secret_previous_ttl_days', config_value: ttlDays });
  return rows;
}

test('getJwtSecretState: returns all four keys', async () => {
  const db = buildMockDb([{
    match: /jwt_secret/i,
    rows: bundleRows({ current: 'A', previous: 'OLD', rotatedAt: '2026-08-01T00:00:00Z', ttlDays: '30' })
  }]).standard();
  const s = await getJwtSecretState(db);
  assert.equal(s.current, 'A');
  assert.equal(s.previous, 'OLD');
  assert.equal(s.rotatedAt, '2026-08-01T00:00:00Z');
  assert.equal(s.ttlDays, 30);
  assert.match(s.previousExpiresAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('getJwtSecretState: empty defaults when no rows', async () => {
  const db = buildMockDb([{ match: /jwt_secret/i, rows: [] }]).standard();
  const s = await getJwtSecretState(db);
  assert.equal(s.current, '');
  assert.equal(s.previous, '');
  assert.equal(s.rotatedAt, '');
  assert.equal(s.ttlDays, 30);
  assert.equal(s.previousExpiresAt, null);
});

test('rotateJwtSecret: writes previous + current + rotated_at + audit in one tx', async () => {
  const records = [];
  const db = buildMockDb([
    { match: /jwt_secret/i, rows: bundleRows({ current: 'OLD' }) }
  ]).withRecording(records);
  const r = await rotateJwtSecret(db, { logger: noopLogger, userId: 'u1' });
  assert.match(r.newSecret, /^[a-f0-9]{64}$/); // 32-byte hex = 64 chars
  assert.match(r.rotatedAt, /^\d{4}-\d{2}-\d{2}T/);
  const upserts = records.filter(x => /system_config/i.test(x.sql));
  const keys = upserts.map(u => u.params[0]);
  assert.ok(keys.includes('jwt_secret_previous'));
  assert.ok(keys.includes('jwt_secret_current'));
  assert.ok(keys.includes('jwt_secret_rotated_at'));
  // previous must be set to the OLD current value
  const prevUpsert = upserts.find(u => u.params[0] === 'jwt_secret_previous');
  assert.equal(prevUpsert.params[1], 'OLD');
  // current must be set to the new secret (not the old)
  const curUpsert = upserts.find(u => u.params[0] === 'jwt_secret_current');
  assert.equal(curUpsert.params[1], r.newSecret);
  // Audit row written via writeAudit (3-arg signature)
  const audits = records.filter(x => /audit_logs/i.test(x.sql));
  assert.ok(audits.length >= 1);
  const audit = audits.find(a => a.params && a.params[1] === 'rotate_jwt_secret');
  assert.ok(audit);
});

test('commitJwtSecret: clears previous and rotated_at, writes audit', async () => {
  const records = [];
  const db = buildMockDb([
    { match: /jwt_secret/i, rows: bundleRows({ current: 'NEW', previous: 'OLD' }) }
  ]).withRecording(records);
  const r = await commitJwtSecret(db, { logger: noopLogger, userId: 'u1' });
  assert.deepEqual(r, { ok: true });
  const upserts = records.filter(x => /system_config/i.test(x.sql));
  const prev = upserts.find(u => u.params[0] === 'jwt_secret_previous');
  const rot = upserts.find(u => u.params[0] === 'jwt_secret_rotated_at');
  assert.equal(prev.params[1], '');
  assert.equal(rot.params[1], '');
  const audits = records.filter(x => /audit_logs/i.test(x.sql));
  const audit = audits.find(a => a.params && a.params[1] === 'commit_jwt_secret');
  assert.ok(audit);
});

test('commitJwtSecret: no-op when no previous', async () => {
  const records = [];
  const db = buildMockDb([
    { match: /jwt_secret/i, rows: bundleRows({ current: 'NEW', previous: '' }) }
  ]).withRecording(records);
  const r = await commitJwtSecret(db, { logger: noopLogger, userId: 'u1' });
  assert.deepEqual(r, { ok: true });
  const audits = records.filter(x => /audit_logs/i.test(x.sql));
  assert.equal(audits.length, 0);
});

test('seedJwtSecretIfMissing: seeds all 4 rows when absent', async () => {
  const records = [];
  const db = buildMockDb([
    { match: /jwt_secret/i, rows: [] }
  ]).withRecording(records);
  const r = await seedJwtSecretIfMissing(db, 'from-appsettings', noopLogger);
  assert.equal(r.seeded, true);
  assert.equal(r.current, 'from-appsettings');
  const keys = records.map(x => x.params[0]).filter(k => typeof k === 'string' && k.startsWith('jwt_secret'));
  assert.ok(keys.includes('jwt_secret_current'));
  assert.ok(keys.includes('jwt_secret_previous'));
  assert.ok(keys.includes('jwt_secret_rotated_at'));
  assert.ok(keys.includes('jwt_secret_previous_ttl_days'));
});

test('seedJwtSecretIfMissing: idempotent when current row exists', async () => {
  const records = [];
  const db = buildMockDb([
    { match: /jwt_secret/i, rows: bundleRows({ current: 'EXISTING' }) }
  ]).withRecording(records);
  const r = await seedJwtSecretIfMissing(db, 'from-appsettings', noopLogger);
  assert.equal(r.seeded, false);
  assert.equal(r.current, 'EXISTING');
  // No upserts on existing rows (auto-expire path may add some — see next test)
  const upserts = records.filter(x => /INSERT\s+INTO\s+system_config/i.test(x.sql));
  // We seeded no row here because there was no previous and rotatedAt — only auto-expire would write.
  assert.equal(upserts.length, 0);
});

test('seedJwtSecretIfMissing: auto-expires previous when older than TTL', async () => {
  const oldRotatedAt = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
  const records = [];
  const db = buildMockDb([
    { match: /jwt_secret/i, rows: bundleRows({ current: 'CUR', previous: 'OLD', rotatedAt: oldRotatedAt, ttlDays: '30' }) }
  ]).withRecording(records);
  const r = await seedJwtSecretIfMissing(db, 'from-appsettings', noopLogger);
  assert.equal(r.autoExpired, true);
  assert.equal(r.current, 'CUR');
  const upserts = records.filter(x => /system_config/i.test(x.sql));
  const prev = upserts.find(u => u.params[0] === 'jwt_secret_previous');
  const rot = upserts.find(u => u.params[0] === 'jwt_secret_rotated_at');
  assert.equal(prev.params[1], '');
  assert.equal(rot.params[1], '');
});

test('seedJwtSecretIfMissing: keeps previous when within TTL', async () => {
  const recentRotatedAt = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
  const records = [];
  const db = buildMockDb([
    { match: /jwt_secret/i, rows: bundleRows({ current: 'CUR', previous: 'OLD', rotatedAt: recentRotatedAt, ttlDays: '30' }) }
  ]).withRecording(records);
  const r = await seedJwtSecretIfMissing(db, 'from-appsettings', noopLogger);
  assert.equal(r.autoExpired, undefined);
  const upserts = records.filter(x => /INSERT\s+INTO\s+system_config/i.test(x.sql));
  assert.equal(upserts.length, 0);
});

test('rotateJwtSecret: new secret is never written to log payload', async () => {
  const records = [];
  const capturedLogs = [];
  const captureLogger = {
    info: (...args) => capturedLogs.push(args),
    warn: () => {},
    error: () => {},
    debug: () => {}
  };
  const db = buildMockDb([
    { match: /jwt_secret/i, rows: bundleRows({ current: 'OLD' }) }
  ]).withRecording(records);
  const r = await rotateJwtSecret(db, { logger: captureLogger, userId: 'u1' });
  // Ensure no log line contains the new secret verbatim.
  const json = JSON.stringify(capturedLogs);
  assert.ok(!json.includes(r.newSecret), 'new secret must not appear in logs');
  // The audit payload must record lengths, not the secret itself.
  const audit = records.find(x => /audit_logs/i.test(x.sql) && x.params[1] === 'rotate_jwt_secret');
  assert.ok(audit);
  // writeAudit JSON.stringifies the payload before binding as params[3];
  // parse it back to verify the length-only audit metadata.
  const payload = JSON.parse(audit.params[3]);
  assert.equal(payload.newLength, r.newSecret.length);
  assert.equal(payload.previousLength, 'OLD'.length);
});
