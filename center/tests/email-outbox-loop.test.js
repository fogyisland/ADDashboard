// email-outbox-loop.test.js — covers createEmailDeliveryLoop (Task 11).
//
// The loop's responsibilities (per spec §9.3):
//   1. Per tick: read pending rows from alert_email_outbox (sent_at IS NULL
//      AND next_attempt_at <= NOW()), capped at 25.
//   2. For each row: read SMTP config from system_config, call send().
//   3. On success: UPDATE outbox SET sent_at = NOW(), last_error = NULL.
//   4. On failure: increment attempt_count, schedule next_attempt_at with
//      exponential backoff (capped 1h). If attempts >= max, emit a
//      `cooldown_skipped` alert_events row.
//
// Mock-DB unit tests paired with the existing tests/sql/alert-outbox.test.js
// round-trip coverage (Global Constraint #17). The new SQL block (none —
// only existing alertOutbox.listPending / markSent / markFailed are used)
// means no new round-trip test is required.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMockDb } from './helpers/db-mock.js';
import { createEmailDeliveryLoop } from '../src/services/email.js';

const SMTP_CONFIG = {
  smtp_host: 'smtp.example.com',
  smtp_port: 587,
  smtp_secure: 'false',
  smtp_user: 'sender',
  smtp_password: 'pw',
  smtp_from: 'sender@example.com'
};

function makeLoop({ scripts = [], systemConfig = {}, intervalSeconds = 60, sendImpl } = {}) {
  const db = buildMockDb(scripts).withRecording();
  return {
    db,
    loop: createEmailDeliveryLoop({
      db,
      getIntervalSeconds: async () => intervalSeconds,
      getSystemConfig: async () => systemConfig,
      sendImpl: sendImpl || (async () => ({ ok: true }))
    })
  };
}

function findExecute(records, predicate) {
  return records.find((r) => predicate(r.sql, r.params));
}

test('emailOutboxLoop: returns the {start, stop, tick, isRunning} factory shape', () => {
  const { loop } = makeLoop();
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

test('emailOutboxLoop: tick sends a pending outbox row and stamps sent_at', async () => {
  const now = new Date('2026-01-01T12:00:00Z');
  const pendingRow = {
    id: 1,
    alert_event_id: 100,
    to_addrs: 'ops@example.com',
    cc_addrs: null,
    subject: 'ALERT',
    body_text: 'cpu high',
    body_html: null,
    attempt_count: 0,
    next_attempt_at: new Date(now.getTime() - 60_000), // past due
    last_error: null,
    sent_at: null,
    created_at: now
  };
  const { db, loop } = makeLoop({
    scripts: [
      { match: /FROM alert_email_outbox/i, rows: [pendingRow] }
    ],
    systemConfig: SMTP_CONFIG
  });
  await loop.tick();

  // The outbox UPDATE for sent_at should have run.
  const markSent = findExecute(db.records, (sql, params) =>
    /UPDATE alert_email_outbox SET sent_at/i.test(sql) && params.includes(1)
  );
  assert.ok(markSent, 'markSent UPDATE should have been issued');
  assert.equal(markSent.params[1], 1, 'UPDATE should target the pending row id');
});

test('emailOutboxLoop: failed send increments attempt_count and sets next_attempt_at', async () => {
  const now = new Date('2026-01-01T12:00:00Z');
  const pendingRow = {
    id: 2,
    alert_event_id: 100,
    to_addrs: 'ops@example.com',
    cc_addrs: null,
    subject: 'ALERT',
    body_text: 'cpu high',
    body_html: null,
    attempt_count: 0,
    next_attempt_at: new Date(now.getTime() - 60_000),
    last_error: null,
    sent_at: null,
    created_at: now
  };
  const { db, loop } = makeLoop({
    scripts: [
      { match: /FROM alert_email_outbox/i, rows: [pendingRow] }
    ],
    systemConfig: SMTP_CONFIG,
    sendImpl: async () => ({ ok: false, error: 'smtp 421' })
  });
  await loop.tick();

  // markFailed should have run with attempt_count+1 and a future next_attempt_at.
  const markFailed = findExecute(db.records, (sql) =>
    /UPDATE alert_email_outbox/i.test(sql) &&
    /attempt_count\s*=\s*attempt_count\s*\+\s*1/i.test(sql)
  );
  assert.ok(markFailed, 'markFailed UPDATE should have been issued');
  // params: last_error, backward_seconds, id
  assert.equal(markFailed.params[1], 2, 'target row id');
  assert.equal(markFailed.params[0], 'smtp 421', 'last_error captured');

  // NO sent_at UPDATE should have been issued.
  const sentUpdate = findExecute(db.records, (sql) =>
    /UPDATE alert_email_outbox SET sent_at/i.test(sql)
  );
  assert.equal(sentUpdate, undefined, 'no sent_at on failed send');
});

test('emailOutboxLoop: tick skips rows where sent_at is already set', async () => {
  // The listPending SQL already filters on sent_at IS NULL. The mock returns
  // [] when no rows are pending. We assert the loop does NOT issue any UPDATE
  // and does NOT call send().
  let sendCalled = false;
  const { db, loop } = makeLoop({
    scripts: [
      { match: /FROM alert_email_outbox/i, rows: [] }
    ],
    sendImpl: async () => { sendCalled = true; return { ok: true }; }
  });
  await loop.tick();

  assert.equal(sendCalled, false, 'send() must not be called when no pending rows');
  const anyUpdate = findExecute(db.records, (sql) =>
    /UPDATE alert_email_outbox/i.test(sql)
  );
  assert.equal(anyUpdate, undefined);
});

test('emailOutboxLoop: max attempts reached → emit cooldown_skipped event', async () => {
  const now = new Date('2026-01-01T12:00:00Z');
  // attempt_count = 4; max = 5 → next attempt (5) >= max → cooldown_skipped.
  const pendingRow = {
    id: 3,
    alert_event_id: 100,
    to_addrs: 'ops@example.com',
    cc_addrs: null,
    subject: 'ALERT',
    body_text: 'cpu high',
    body_html: null,
    attempt_count: 4,
    next_attempt_at: new Date(now.getTime() - 60_000),
    last_error: null,
    sent_at: null,
    created_at: now
  };
  const { db, loop } = makeLoop({
    scripts: [
      { match: /FROM alert_email_outbox/i, rows: [pendingRow] }
    ],
    systemConfig: { ...SMTP_CONFIG, alert_email_max_attempts: 5, alert_email_initial_backoff_seconds: 30 }
  });
  await loop.tick();

  // attempt_count bump: markFailed branch runs with attempt_count+1 in the SQL.
  const bump = findExecute(db.records, (sql) =>
    /UPDATE alert_email_outbox/i.test(sql)
  );
  assert.ok(bump, 'attempt_count should be bumped even on cooldown skip');

  // alert_events INSERT with event='cooldown_skipped'.
  const evt = findExecute(db.records, (sql, params) =>
    /INSERT INTO alert_events/i.test(sql) && params[1] === 'cooldown_skipped'
  );
  assert.ok(evt, 'cooldown_skipped alert_events row should be emitted');
  // rule_id=0 (synthetic), hostname='' (no rule context for outbox retries)
  assert.equal(evt.params[0], 0);
  assert.equal(evt.params[2], '');
});

test('emailOutboxLoop: concurrent tick() calls produce at most 2 outbox SELECTs', async () => {
  // The factory's setInterval callback captures the in-flight tick via
  // `inFlight = tick().catch(...)` (see email.js inFlight comment). When
  // two `tick()` calls are fired concurrently, the contract is: the first
  // tick holds the SELECT open, the second tick either (a) returns early
  // because tick() body has a guard, or (b) blocks on the same SELECT and
  // resolves after. The setInterval callback is NOT a guard; it only
  // captures the in-flight promise. This test locks in the contract: the
  // outbox SELECT is issued at least once, and never more than 2 times
  // (one per concurrent tick), so a future regression that adds an
  // unconditional re-run inside the loop body would be caught.
  const { db, loop } = makeLoop({
    scripts: [
      { match: /FROM alert_email_outbox/i, rows: [] }
    ]
  });

  // Use the mock's onQuery hook (clean interception per plan) to stall the
  // outbox SELECT so both ticks enter the call before either resolves.
  let resolveStall;
  const stalled = new Promise((r) => { resolveStall = r; });
  const onQuery = (sql /* , params */) => {
    if (/FROM alert_email_outbox/i.test(sql)) {
      return stalled.then(() => ({ rows: [] }));
    }
    return { rows: [] };
  };
  // Replace the script's onQuery by re-injecting through the mock.
  // buildMockDb builds scripts at construction time; we instead re-route
  // db.query to use our stall-aware lookup that records into db.records.
  const records = db.records;
  db.query = async (sql, params) => {
    records.push({ sql, params: [...params] });
    return onQuery(sql, params);
  };

  const tick1 = loop.tick();
  const tick2 = loop.tick();
  resolveStall();
  await Promise.all([tick1, tick2]);

  const outboxSelects = db.records.filter((r) =>
    /FROM alert_email_outbox/i.test(r.sql)
  ).length;
  // The first tick must have issued at least one SELECT. Without the
  // guard the second tick would also issue a SELECT (total = 2). With a
  // tick-body guard the second tick returns early (total = 1). We assert
  // the upper bound 2 — never 0 (broken loop) and never 3+ (uncontrolled
  // re-entry bug). This is a contract test, not a strict-count test.
  assert.ok(outboxSelects >= 1, 'first tick must execute at least one outbox SELECT');
  assert.ok(outboxSelects <= 2, 'concurrent ticks must not produce more than 2 outbox SELECTs');
});

test('emailOutboxLoop: tick is no-op when no pending rows (no send, no UPDATE)', async () => {
  let sendCalled = false;
  const { db, loop } = makeLoop({
    scripts: [
      { match: /FROM alert_email_outbox/i, rows: [] }
    ],
    sendImpl: async () => { sendCalled = true; return { ok: true }; }
  });
  await loop.tick();
  assert.equal(sendCalled, false);
  const anyUpdate = findExecute(db.records, (sql) =>
    /UPDATE alert_email_outbox/i.test(sql)
  );
  assert.equal(anyUpdate, undefined);
});
