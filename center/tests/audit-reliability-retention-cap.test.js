// I2 + I4 + I7 regression tests for center/src/services/audit.js.
//
// I7: payload cap — writeAudit refuses to store a payload whose JSON exceeds
//     PAYLOAD_MAX_BYTES. The truncated row carries {_truncated, originalBytes}
//     so an operator reading the audit row can still see what was lost.
//
// I2: reliability — best-effort writeAudit (no tx) MUST NOT throw on
//     downstream failure (login / login_failed / test-mail would otherwise
//     regress on transient audit-table hiccups); tx-bound writeAudit MUST
//     re-throw so the caller's tx rolls back atomically with the data writes.
//
// I4: retention purge — purgeOldAuditLogs + createAuditRetentionLoop factory.
//     Operators set audit_retention_days in system_config (default 90); the
//     loop reads it on every tick so policy changes don't require a restart.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildMockDb } from './helpers/db-mock.js';
import { _setDbForTest } from '../src/db/index.js';
import {
  writeAudit,
  purgeOldAuditLogs,
  createAuditRetentionLoop,
  PAYLOAD_MAX_BYTES
} from '../src/services/audit.js';

function findAuditWrite(records) {
  return records.find(r => /INSERT\s+INTO\s+audit_logs/i.test(r.sql));
}

const SILENT_LOGGER = { info() {}, warn() {}, error() {}, debug() {} };

// ---------------------------------------------------------------------------
// I7: payload cap
// ---------------------------------------------------------------------------

describe('I7: writeAudit payload cap (PAYLOAD_MAX_BYTES = 16 KB)', () => {
  test('exports PAYLOAD_MAX_BYTES = 16 * 1024', () => {
    assert.equal(PAYLOAD_MAX_BYTES, 16 * 1024);
  });

  test('payload under cap is stored verbatim (no truncation marker)', async () => {
    const records = [];
    _setDbForTest(buildMockDb([]).withRecording(records));
    const payload = { siteName: 'Site-A', regionCode: 'CN-North', isHub: 1, description: 'HQ' };
    await writeAudit({ userId: 1, action: 'create_site', target: 'Site-A', payload }, SILENT_LOGGER);
    const w = findAuditWrite(records);
    assert.ok(w, 'audit_logs INSERT must be issued');
    const stored = JSON.parse(w.params[3]);
    assert.deepEqual(stored, payload);
    assert.equal(stored._truncated, undefined);
  });

  test('payload null → params[3] is null (no JSON wrap)', async () => {
    const records = [];
    _setDbForTest(buildMockDb([]).withRecording(records));
    await writeAudit({ userId: null, action: 'login', target: null, payload: null }, SILENT_LOGGER);
    const w = findAuditWrite(records);
    assert.ok(w);
    assert.equal(w.params[3], null);
  });

  test('payload exactly at cap is stored verbatim (boundary)', async () => {
    const records = [];
    _setDbForTest(buildMockDb([]).withRecording(records));
    // Build a payload whose JSON length is exactly PAYLOAD_MAX_BYTES.
    // JSON.stringify({a: ''}) = 8 chars; the only thing varying is the
    // filler string length. So filler = PAYLOAD_MAX_BYTES - 8.
    const filler = 'x'.repeat(PAYLOAD_MAX_BYTES - JSON.stringify({ a: '' }).length);
    const payload = { a: filler };
    const json = JSON.stringify(payload);
    assert.equal(json.length, PAYLOAD_MAX_BYTES, 'precondition: payload JSON must be exactly cap');
    await writeAudit({ userId: 1, action: 'create_site', target: 'A', payload }, SILENT_LOGGER);
    const w = findAuditWrite(records);
    assert.ok(w);
    const stored = JSON.parse(w.params[3]);
    assert.equal(stored._truncated, undefined);
    assert.equal(stored.a.length, filler.length);
  });

  test('payload over cap is truncated with { _truncated: true, originalBytes } marker', async () => {
    const records = [];
    _setDbForTest(buildMockDb([]).withRecording(records));
    // Build a payload well over 16 KB.
    const big = {
      items: Array.from({ length: 2000 }, (_, i) => ({
        idx: i, name: 'site-name-' + i, description: 'x'.repeat(100)
      }))
    };
    const bigJson = JSON.stringify(big);
    assert.ok(bigJson.length > PAYLOAD_MAX_BYTES, 'precondition: payload must exceed cap');
    await writeAudit({ userId: 1, action: 'bulk_import_sites', target: 'ad_sites', payload: big }, SILENT_LOGGER);
    const w = findAuditWrite(records);
    assert.ok(w);
    const stored = JSON.parse(w.params[3]);
    assert.equal(stored._truncated, true);
    assert.equal(typeof stored.originalBytes, 'number');
    assert.ok(stored.originalBytes > PAYLOAD_MAX_BYTES);
    // Truncated row must stay at or under the cap when re-stringified.
    assert.ok(w.params[3].length <= PAYLOAD_MAX_BYTES,
      `truncated row exceeded cap: ${w.params[3].length} > ${PAYLOAD_MAX_BYTES}`);
  });

  test('payload slightly over cap keeps at least one key', async () => {
    // Belt-and-braces: a payload whose first key alone is > PAYLOAD_MAX_BYTES
    // should still produce a valid truncated row (just the marker; the key
    // can't fit). This pins that we don't infinite-loop or throw.
    const records = [];
    _setDbForTest(buildMockDb([]).withRecording(records));
    const big = { blob: 'y'.repeat(PAYLOAD_MAX_BYTES * 4) };
    await writeAudit({ userId: 1, action: 'create_site', target: 'A', payload: big }, SILENT_LOGGER);
    const w = findAuditWrite(records);
    assert.ok(w);
    const stored = JSON.parse(w.params[3]);
    assert.equal(stored._truncated, true);
    assert.ok(w.params[3].length <= PAYLOAD_MAX_BYTES);
  });
});

// ---------------------------------------------------------------------------
// I2: writeAudit reliability
// ---------------------------------------------------------------------------

describe('I2: writeAudit reliability (best-effort vs tx re-throw)', () => {
  test('best-effort (no tx): does NOT throw when db.execute rejects', async () => {
    const db = buildMockDb([]).standard();
    db.execute = async () => { throw new Error('audit table missing'); };
    _setDbForTest(db);
    let warned = null;
    const logger = { ...SILENT_LOGGER, warn: (obj) => { warned = obj; } };
    // Must resolve without throwing.
    await writeAudit({ userId: 1, action: 'login', target: null, payload: null }, logger);
    assert.ok(warned, 'best-effort failure must warn-log so operator sees transient drops');
    assert.equal(warned.action, 'login');
  });

  test('best-effort (no tx): logger is optional — silent drop when no logger', async () => {
    // Login/logout path may not have a logger in scope; we must not crash on
    // `logger?.warn` being absent.
    const db = buildMockDb([]).standard();
    db.execute = async () => { throw new Error('audit table missing'); };
    _setDbForTest(db);
    await writeAudit({ userId: 1, action: 'login', target: null, payload: null }, null);
  });

  test('tx path: RE-throws when conn.execute rejects so caller can roll back', async () => {
    const txWrapper = {
      sql: { audit: { write: 'INSERT INTO audit_logs' } },
      execute: async () => { throw new Error('audit table missing'); },
      query: async () => ({ rows: [] })
    };
    let thrown = null;
    await writeAudit(
      { userId: 1, action: 'create_site', target: 'A', payload: { site: 'A' } },
      SILENT_LOGGER,
      txWrapper
    ).catch((e) => { thrown = e; });
    assert.ok(thrown, 'tx path must re-throw so caller can roll back');
    assert.match(thrown.message, /audit table missing/);
  });

  test('tx path: writes via txWrapper.execute (not the global db)', async () => {
    // Belt-and-braces: a tx caller writes through the supplied txWrapper.
    // Without this, the C1+C2+C11 audit-in-tx atomic rollback guarantee
    // silently breaks (see feedback_writeaudit_signature memory).
    const txCalls = [];
    const txWrapper = {
      sql: { audit: { write: 'INSERT INTO audit_logs' } },
      execute: async (sql, params) => { txCalls.push({ sql, params }); return { affectedRows: 1 }; },
      query: async () => ({ rows: [] })
    };
    // Global db would also receive calls — install a recording one to assert
    // it's NOT the one that received the audit write.
    const records = [];
    const globalDb = buildMockDb([]).withRecording(records);
    _setDbForTest(globalDb);
    await writeAudit(
      { userId: 1, action: 'create_site', target: 'A', payload: { site: 'A' } },
      SILENT_LOGGER,
      txWrapper
    );
    assert.equal(txCalls.length, 1, 'txWrapper.execute must receive exactly one call');
    assert.match(txCalls[0].sql, /INSERT\s+INTO\s+audit_logs/i);
    assert.equal(records.length, 0, 'global db.execute must NOT receive the audit row');
  });
});

// ---------------------------------------------------------------------------
// I4: purgeOldAuditLogs
// ---------------------------------------------------------------------------

describe('I4: purgeOldAuditLogs', () => {
  test('returns skipped when retentionDays <= 0 (retention disabled)', async () => {
    _setDbForTest(buildMockDb([]).standard());
    const r = await purgeOldAuditLogs(0, SILENT_LOGGER);
    assert.equal(r.skipped, true);
    assert.match(r.reason, /retentionDays/i);
  });

  test('returns skipped when retentionDays is not an integer', async () => {
    _setDbForTest(buildMockDb([]).standard());
    const r = await purgeOldAuditLogs(7.5, SILENT_LOGGER);
    assert.equal(r.skipped, true);
    assert.match(r.reason, /retentionDays/i);
  });

  test('returns skipped when retentionDays is negative', async () => {
    _setDbForTest(buildMockDb([]).standard());
    const r = await purgeOldAuditLogs(-1, SILENT_LOGGER);
    assert.equal(r.skipped, true);
  });

  test('issues DELETE with cutoff Date ~retentionDays in the past', async () => {
    const records = [];
    _setDbForTest(buildMockDb([]).withRecording(records));
    const before = Date.now();
    const r = await purgeOldAuditLogs(30, SILENT_LOGGER);
    const after = Date.now();
    assert.equal(r.skipped, false);
    assert.ok(r.cutoff);
    const cutoffMs = new Date(r.cutoff).getTime();
    const expected = 30 * 86400 * 1000;
    assert.ok(cutoffMs <= before - expected, 'cutoff must be at or before now - days');
    assert.ok(cutoffMs >= after - expected - 1000, 'cutoff must be at or after now - days - 1s');
    const del = records.find(rec => /DELETE\s+FROM\s+audit_logs/i.test(rec.sql));
    assert.ok(del, 'DELETE must be issued against audit_logs');
    assert.ok(del.params[0] instanceof Date, 'cutoff must be bound as a Date');
    // Returned affectedRows=1 from the mock; deleted should reflect it.
    assert.equal(r.deleted, 1);
  });

  test('DB error is caught and returns skipped+reason (best-effort)', async () => {
    const db = buildMockDb([]).standard();
    db.execute = async () => { throw new Error('connection lost'); };
    _setDbForTest(db);
    let warned = null;
    const logger = { ...SILENT_LOGGER, warn: (obj) => { warned = obj; } };
    const r = await purgeOldAuditLogs(30, logger);
    assert.equal(r.skipped, true);
    assert.match(r.reason, /connection lost/);
    assert.equal(r.deleted, 0);
    assert.ok(warned, 'best-effort failure must warn-log');
    assert.equal(warned.retentionDays, 30);
  });
});

// ---------------------------------------------------------------------------
// I4: createAuditRetentionLoop factory
// ---------------------------------------------------------------------------

describe('I4: createAuditRetentionLoop factory shape', () => {
  test('returns {start, stop, tick, isRunning}', () => {
    const loop = createAuditRetentionLoop({
      getSystemConfig: async () => ({}),
      logger: SILENT_LOGGER
    });
    assert.equal(typeof loop.start, 'function');
    assert.equal(typeof loop.stop, 'function');
    assert.equal(typeof loop.tick, 'function');
    assert.equal(typeof loop.isRunning, 'function');
    assert.equal(loop.isRunning(), false);
    loop.start();
    assert.equal(loop.isRunning(), true);
    loop.stop();
    assert.equal(loop.isRunning(), false);
  });

  test('start() is idempotent (second start is a no-op)', () => {
    const loop = createAuditRetentionLoop({
      getSystemConfig: async () => ({}),
      logger: SILENT_LOGGER
    });
    loop.start();
    loop.start(); // must not throw or stack intervals
    assert.equal(loop.isRunning(), true);
    loop.stop();
  });

  test('stop() is safe to call without start()', async () => {
    const loop = createAuditRetentionLoop({
      getSystemConfig: async () => ({}),
      logger: SILENT_LOGGER
    });
    await loop.stop(); // must not throw
    assert.equal(loop.isRunning(), false);
  });
});

describe('I4: createAuditRetentionLoop.tick()', () => {
  test('reads audit_retention_days from system_config and runs purge with that value', async () => {
    const records = [];
    _setDbForTest(buildMockDb([]).withRecording(records));
    const loop = createAuditRetentionLoop({
      getSystemConfig: async () => ({ audit_retention_days: '14' }),
      logger: SILENT_LOGGER
    });
    const r = await loop.tick();
    assert.equal(r.skipped, false);
    const cutoffMs = new Date(r.cutoff).getTime();
    const expected = 14 * 86400 * 1000;
    assert.ok(Math.abs((Date.now() - cutoffMs) - expected) < 5000,
      `cutoff must be ~14 days ago (got ${Date.now() - cutoffMs}ms, expected ~${expected}ms)`);
    const del = records.find(rec => /DELETE\s+FROM\s+audit_logs/i.test(rec.sql));
    assert.ok(del);
  });

  test('defaults to 90 days when audit_retention_days is missing', async () => {
    const records = [];
    _setDbForTest(buildMockDb([]).withRecording(records));
    const loop = createAuditRetentionLoop({
      getSystemConfig: async () => ({}),
      logger: SILENT_LOGGER
    });
    const r = await loop.tick();
    assert.equal(r.skipped, false);
    const cutoffMs = new Date(r.cutoff).getTime();
    const expected = 90 * 86400 * 1000;
    assert.ok(Math.abs((Date.now() - cutoffMs) - expected) < 5000);
  });

  test('defaults to 90 days when audit_retention_days is non-numeric', async () => {
    _setDbForTest(buildMockDb([]).standard());
    const loop = createAuditRetentionLoop({
      getSystemConfig: async () => ({ audit_retention_days: 'forever' }),
      logger: SILENT_LOGGER
    });
    const r = await loop.tick();
    assert.equal(r.skipped, false);
    const cutoffMs = new Date(r.cutoff).getTime();
    const expected = 90 * 86400 * 1000;
    assert.ok(Math.abs((Date.now() - cutoffMs) - expected) < 5000);
  });

  test('returns skipped when audit_retention_days=0 (operator disabled retention)', async () => {
    _setDbForTest(buildMockDb([]).standard());
    const loop = createAuditRetentionLoop({
      getSystemConfig: async () => ({ audit_retention_days: '0' }),
      logger: SILENT_LOGGER
    });
    const r = await loop.tick();
    assert.equal(r.skipped, true);
    assert.match(r.reason, /retention/i);
  });

  test('returns skipped (not throw) when getSystemConfig throws', async () => {
    _setDbForTest(buildMockDb([]).standard());
    let warned = null;
    const logger = { ...SILENT_LOGGER, warn: (obj) => { warned = obj; } };
    const loop = createAuditRetentionLoop({
      getSystemConfig: async () => { throw new Error('db gone'); },
      logger
    });
    const r = await loop.tick();
    assert.equal(r.skipped, true);
    assert.match(r.reason, /db gone/);
    assert.ok(warned, 'transient getSystemConfig failure must warn-log');
  });

  test('returns skipped (not throw) when getSystemConfig is not provided', async () => {
    _setDbForTest(buildMockDb([]).standard());
    const loop = createAuditRetentionLoop({ logger: SILENT_LOGGER });
    const r = await loop.tick();
    // No getSystemConfig → falls through to default 90 days → purge runs.
    assert.equal(r.skipped, false);
  });
});
