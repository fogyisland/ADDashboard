import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMockDb } from '../helpers/db-mock.js';
import {
  getAgentTokenState,
  rotateAgentToken,
  commitAgentToken,
  seedAgentTokenIfMissing
} from '../../src/services/agent-token.js';

const noopLogger = { info(){}, warn(){}, error(){}, debug(){} };

function bundleRows({ current = '', previous = '', rotatedAt = '', ttlDays = '30' } = {}) {
  const rows = [];
  if (current !== null) rows.push({ config_key: 'agent_token_current', config_value: current });
  if (previous !== null) rows.push({ config_key: 'agent_token_previous', config_value: previous });
  if (rotatedAt !== null) rows.push({ config_key: 'agent_token_rotated_at', config_value: rotatedAt });
  if (ttlDays !== null) rows.push({ config_key: 'agent_token_previous_ttl_days', config_value: ttlDays });
  return rows;
}

test('getAgentTokenState: returns both keys', async () => {
  const db = buildMockDb([{
    match: /agent_token/i,
    rows: bundleRows({ current: 'A', previous: 'OLD' })
  }]).standard();
  const s = await getAgentTokenState(db);
  assert.equal(s.current, 'A');
  assert.equal(s.previous, 'OLD');
});

test('getAgentTokenState: empty defaults when no rows', async () => {
  const db = buildMockDb([{ match: /agent_token/i, rows: [] }]).standard();
  const s = await getAgentTokenState(db);
  assert.equal(s.current, '');
  assert.equal(s.previous, '');
  assert.equal(s.ttlDays, 30);
});

test('rotateAgentToken: writes previous + current + rotated_at + audit in one tx', async () => {
  const records = [];
  const db = buildMockDb([
    { match: /agent_token/i, rows: bundleRows({ current: 'OLD' }) }
  ]).withRecording(records);
  const r = await rotateAgentToken(db, { logger: noopLogger, userId: 'u1' });
  assert.match(r.newToken, /^[a-f0-9]{96}$/);
  assert.match(r.rotatedAt, /^\d{4}-\d{2}-\d{2}T/);
  // Should have upserted previous (OLD), current (new), rotated_at
  const upserts = records.filter(x => /INSERT\s+INTO\s+system_config/i.test(x.sql));
  const keys = upserts.map(u => u.params[0]);
  assert.ok(keys.includes('agent_token_previous'));
  assert.ok(keys.includes('agent_token_current'));
  assert.ok(keys.includes('agent_token_rotated_at'));
  // Should have written an audit row
  const audits = records.filter(x => /audit/i.test(x.sql));
  assert.ok(audits.length >= 1);
});

test('commitAgentToken: clears previous and rotated_at, writes audit', async () => {
  const records = [];
  const db = buildMockDb([
    { match: /agent_token/i, rows: bundleRows({ current: 'NEW', previous: 'OLD' }) }
  ]).withRecording(records);
  const r = await commitAgentToken(db, { logger: noopLogger, userId: 'u1' });
  assert.deepEqual(r, { ok: true });
  const upserts = records.filter(x => /INSERT\s+INTO\s+system_config/i.test(x.sql));
  const prev = upserts.find(u => u.params[0] === 'agent_token_previous');
  const rot = upserts.find(u => u.params[0] === 'agent_token_rotated_at');
  assert.equal(prev.params[1], '');
  assert.equal(rot.params[1], '');
  const audits = records.filter(x => /audit/i.test(x.sql));
  assert.ok(audits.length >= 1);
});

test('commitAgentToken: no-op when no previous', async () => {
  const records = [];
  const db = buildMockDb([
    { match: /agent_token/i, rows: bundleRows({ current: 'NEW', previous: '' }) }
  ]).withRecording(records);
  const r = await commitAgentToken(db, { logger: noopLogger, userId: 'u1' });
  assert.deepEqual(r, { ok: true });
  // No audit row written — no-op
  const audits = records.filter(x => /audit/i.test(x.sql));
  assert.equal(audits.length, 0);
});

test('seedAgentTokenIfMissing: seeds all 4 rows when absent', async () => {
  const records = [];
  const db = buildMockDb([
    { match: /agent_token/i, rows: [] }
  ]).withRecording(records);
  const r = await seedAgentTokenIfMissing(db, 'from-appsettings', noopLogger);
  assert.equal(r.seeded, true);
  assert.equal(r.current, 'from-appsettings');
  const keys = records.map(x => x.params[0]).filter(k => typeof k === 'string' && k.startsWith('agent_token'));
  assert.ok(keys.includes('agent_token_current'));
  assert.ok(keys.includes('agent_token_previous'));
  assert.ok(keys.includes('agent_token_rotated_at'));
  assert.ok(keys.includes('agent_token_previous_ttl_days'));
});

test('seedAgentTokenIfMissing: idempotent when current row exists', async () => {
  const records = [];
  const db = buildMockDb([
    { match: /agent_token_current/i, rows: bundleRows({ current: 'EXISTING' }) }
  ]).withRecording(records);
  const r = await seedAgentTokenIfMissing(db, 'from-appsettings', noopLogger);
  assert.equal(r.seeded, false);
  assert.equal(r.current, 'EXISTING');
  const upserts = records.filter(x => /INSERT\s+INTO\s+system_config/i.test(x.sql));
  assert.equal(upserts.length, 0);
});

test('seedAgentTokenIfMissing: auto-expires previous past TTL', async () => {
  const records = [];
  const oldDate = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
  const db = buildMockDb([
    { match: /agent_token/i, rows: bundleRows({ current: 'NEW', previous: 'OLD', rotatedAt: oldDate, ttlDays: '30' }) }
  ]).withRecording(records);
  const r = await seedAgentTokenIfMissing(db, 'from-appsettings', noopLogger);
  assert.equal(r.seeded, false);
  // Should have cleared previous + rotated_at
  const prev = records.find(x => x.params[0] === 'agent_token_previous');
  const rot = records.find(x => x.params[0] === 'agent_token_rotated_at');
  assert.equal(prev.params[1], '');
  assert.equal(rot.params[1], '');
});

// #167 C2: auto-expire branch must write an audit row matching the
// rotate/commit/seed taxonomy (parallels jwt-secret auto-expire). Without
// this assertion the silent TTL-driven clear would leave no trace in the
// audit log.
test('seedAgentTokenIfMissing auto-expire writes auto_expire_agent_token audit row', async () => {
  const records = [];
  const oldDate = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
  const db = buildMockDb([
    { match: /agent_token/i, rows: bundleRows({ current: 'NEW', previous: 'OLD', rotatedAt: oldDate, ttlDays: '30' }) }
  ]).withRecording(records);
  const r = await seedAgentTokenIfMissing(db, 'from-appsettings', noopLogger);
  assert.equal(r.autoExpired, true);
  // Auto-expire branch must produce exactly one audit row, with the
  // dedicated AUTO_EXPIRE action (not the rotate/commit/seed actions).
  const audits = records.filter(x => /audit_logs/i.test(x.sql));
  assert.equal(audits.length, 1, 'auto-expire must write exactly one audit row');
  const audit = audits[0];
  assert.equal(audit.params[1], 'auto_expire_agent_token');
  assert.equal(audit.params[2], 'system_config');
  // Payload carries the rotatedAt + ttlDays that drove the clear — same
  // shape as the I9 jwt_secret auto-expire audit row.
  const payload = JSON.parse(audit.params[3]);
  assert.equal(payload.rotatedAt, oldDate);
  assert.equal(payload.ttlDays, 30);
});

test('seedAgentTokenIfMissing: does NOT expire within TTL', async () => {
  const records = [];
  const recent = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
  const db = buildMockDb([
    { match: /agent_token/i, rows: bundleRows({ current: 'NEW', previous: 'OLD', rotatedAt: recent, ttlDays: '30' }) }
  ]).withRecording(records);
  await seedAgentTokenIfMissing(db, 'from-appsettings', noopLogger);
  // No clears
  const upserts = records.filter(x => /INSERT\s+INTO\s+system_config/i.test(x.sql));
  assert.equal(upserts.length, 0);
});