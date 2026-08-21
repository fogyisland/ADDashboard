import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMockDb } from '../helpers/db-mock.js';
import {
  getAgentTokenState,
  rotateAgentToken,
  commitAgentToken,
  seedAgentTokenIfMissing,
  revealAgentToken
} from '../../src/services/agent-token.js';

const noopLogger = { info(){}, warn(){}, error(){}, debug(){} };

function bundleRows({ current = '', previous = '', rotatedAt = '', version = '0' } = {}) {
  const rows = [];
  if (current !== null) rows.push({ config_key: 'agent_token_current', config_value: current });
  if (previous !== null) rows.push({ config_key: 'agent_token_previous', config_value: previous });
  if (rotatedAt !== null) rows.push({ config_key: 'agent_token_rotated_at', config_value: rotatedAt });
  if (version !== null) rows.push({ config_key: 'agent_token_version', config_value: version });
  return rows;
}

test('getAgentTokenState: returns current + previous + version + previousExpiresAt', async () => {
  const db = buildMockDb([{
    match: /agent_token/i,
    rows: bundleRows({ current: 'A', previous: 'OLD', rotatedAt: new Date().toISOString(), version: '3' })
  }]).standard();
  const s = await getAgentTokenState(db);
  assert.equal(s.current, 'A');
  assert.equal(s.previous, 'OLD');
  assert.equal(s.version, 3);
  // previousExpiresAt is rotatedAt + 5min (INTERNAL_GRACE_MS) — assert it's
  // a finite ISO date ~5min after rotatedAt, not the operator-facing
  // ttlDays field that no longer exists.
  assert.match(s.previousExpiresAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('getAgentTokenState: empty defaults when no rows', async () => {
  const db = buildMockDb([{ match: /agent_token/i, rows: [] }]).standard();
  const s = await getAgentTokenState(db);
  assert.equal(s.current, '');
  assert.equal(s.previous, '');
  assert.equal(s.version, 0);
  // No rotatedAt → previousExpiresAt is null (not "now + 5min")
  assert.equal(s.previousExpiresAt, null);
});

test('rotateAgentToken: writes previous + current + rotated_at + version + audit in one tx', async () => {
  const records = [];
  const db = buildMockDb([
    { match: /agent_token/i, rows: bundleRows({ current: 'OLD', version: '5' }) }
  ]).withRecording(records);
  const r = await rotateAgentToken(db, { logger: noopLogger, userId: 'u1' });
  assert.match(r.newToken, /^[a-f0-9]{96}$/);
  assert.match(r.rotatedAt, /^\d{4}-\d{2}-\d{2}T/);
  // Version returned in the result AND incremented in the bundle
  assert.equal(r.version, 6);
  // Should have upserted previous (OLD), current (new), rotated_at, version
  const upserts = records.filter(x => /INSERT\s+INTO\s+system_config/i.test(x.sql));
  const keys = upserts.map(u => u.params[0]);
  assert.ok(keys.includes('agent_token_previous'));
  assert.ok(keys.includes('agent_token_current'));
  assert.ok(keys.includes('agent_token_rotated_at'));
  assert.ok(keys.includes('agent_token_version'));
  // The version upsert value must be the new version, not the old
  const versionUpsert = upserts.find(u => u.params[0] === 'agent_token_version');
  assert.equal(versionUpsert.params[1], '6');
  // Audit row written
  const audits = records.filter(x => /audit/i.test(x.sql));
  assert.ok(audits.length >= 1);
  // The action name changed from rotate_agent_token to generate_agent_token
  const genAudits = audits.filter(a => /generate_agent_token/i.test(a.sql) || a.params[1] === 'generate_agent_token');
  assert.ok(genAudits.length >= 1, 'expected generate_agent_token audit action');
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
  assert.ok(keys.includes('agent_token_version'));
  // version=0 marks this as the initial seed; first rotate will bump to 1.
  const versionUpsert = records.find(x => x.params[0] === 'agent_token_version');
  assert.equal(versionUpsert.params[1], '0');
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

test('seedAgentTokenIfMissing: auto-expires previous past internal grace', async () => {
  const records = [];
  // 2026-08-21 UX redesign: grace is hardcoded INTERNAL_GRACE_MS (5 min),
  // not the old operator-set ttlDays. Set rotatedAt to 6 minutes ago — past
  // the 5-min grace — to trigger auto-clear.
  const oldDate = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  const db = buildMockDb([
    { match: /agent_token/i, rows: bundleRows({ current: 'NEW', previous: 'OLD', rotatedAt: oldDate }) }
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
  // 6 minutes ago — past the 5-min internal grace
  const oldDate = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  const db = buildMockDb([
    { match: /agent_token/i, rows: bundleRows({ current: 'NEW', previous: 'OLD', rotatedAt: oldDate }) }
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
  // Payload carries rotatedAt + graceMs (not ttlDays — the operator-facing
  // TTL field no longer exists).
  const payload = JSON.parse(audit.params[3]);
  assert.equal(payload.rotatedAt, oldDate);
  assert.equal(payload.graceMs, 5 * 60 * 1000);
});

test('seedAgentTokenIfMissing: does NOT expire within internal grace', async () => {
  const records = [];
  // 2026-08-21: grace is 5 min, so 1 minute ago is within it
  const recent = new Date(Date.now() - 60 * 1000).toISOString();
  const db = buildMockDb([
    { match: /agent_token/i, rows: bundleRows({ current: 'NEW', previous: 'OLD', rotatedAt: recent }) }
  ]).withRecording(records);
  await seedAgentTokenIfMissing(db, 'from-appsettings', noopLogger);
  // No clears
  const upserts = records.filter(x => /INSERT\s+INTO\s+system_config/i.test(x.sql));
  assert.equal(upserts.length, 0);
});

// revealAgentToken: returns current + writes audit row + does NOT mutate
// system_config. The audit-classifier side ('reveal_agent_token' as
// security/high) is asserted in tests/audit-classifier.test.js; here we
// focus on the service contract: token returned verbatim, audit row with
// action=reveal_agent_token + target=system_config, no upserts.
test('revealAgentToken: returns current token verbatim + writes reveal_agent_token audit', async () => {
  const records = [];
  const db = buildMockDb([
    { match: /agent_token/i, rows: bundleRows({ current: 'LIVE-TOKEN-VALUE', version: '7' }) }
  ]).withRecording(records);
  const r = await revealAgentToken(db, { logger: noopLogger, userId: 'u1' });
  assert.equal(r.token, 'LIVE-TOKEN-VALUE');
  assert.match(r.revealedAt, /^\d{4}-\d{2}-\d{2}T/);
  // 2026-08-21 UX redesign: reveal includes version so the 复制令牌 button
  // can stamp the operator's clipboard with the version they're seeing.
  assert.equal(r.version, 7);
  // Audit row written
  const audits = records.filter(x => /audit_logs/i.test(x.sql));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].params[1], 'reveal_agent_token');
  assert.equal(audits[0].params[2], 'system_config');
  // Payload carries revealedAt + tokenLength + version, NOT the token
  // itself (audit log readers must never see the live credential; the
  // action's existence is the trail).
  const payload = JSON.parse(audits[0].params[3]);
  assert.match(payload.revealedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(payload.tokenLength, 'LIVE-TOKEN-VALUE'.length);
  assert.equal(payload.token, undefined);
  assert.equal(payload.version, 7);
  // No system_config writes — reveal is read-only
  const upserts = records.filter(x => /INSERT\s+INTO\s+system_config/i.test(x.sql));
  assert.equal(upserts.length, 0);
});

// 2026-08-21 UX redesign (auto-delivery): the new version is what agents
// echo back in heartbeat payloads to learn about new credentials. Verify
// the version increments correctly across multiple rotates (1 → 2 → 3 → ...)
// regardless of whether the previous bundle had version=0 (fresh seed) or
// version=N (post-rotate).
test('rotateAgentToken: version increments monotonically across multiple rotates', async () => {
  const records = [];
  let bundleVersion = '0';
  const dbFactory = () => {
    records.length = 0;
    return buildMockDb([
      { match: /agent_token/i, rows: bundleRows({ current: 'X', version: bundleVersion }) }
    ]).withRecording(records);
  };
  // First rotate: 0 → 1
  let r = await rotateAgentToken(dbFactory(), { logger: noopLogger, userId: 'u1' });
  assert.equal(r.version, 1);
  bundleVersion = '1';
  // Second rotate: 1 → 2
  r = await rotateAgentToken(dbFactory(), { logger: noopLogger, userId: 'u1' });
  assert.equal(r.version, 2);
  bundleVersion = '2';
  // Third rotate: 2 → 3
  r = await rotateAgentToken(dbFactory(), { logger: noopLogger, userId: 'u1' });
  assert.equal(r.version, 3);
});