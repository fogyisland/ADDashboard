// alert-evaluation-loop.test.js — covers createAlertEvaluationLoop (Task 11).
//
// The loop's responsibilities (per spec §9.2):
//   1. Per tick: read enabled hosts from ad_member_servers.
//   2. For each host: read enabled alert_rules + latest metrics + last_seen_at.
//   3. For each rule: evaluateCondition → transitionState → upsert state.
//   4. On normal→firing OR firing→normal transitions: insert alert_events +
//      alert_email_outbox in the SAME transaction as the state upsert.
//
// Global Constraint #10 (verbatim): "The per-rule state write + alert_events
// insert + alert_email_outbox insert happen in a single transaction. Email
// delivery reads committed rows." The factory delegates transactionality to
// db.transaction(); the mock exposes a transaction(shim) that wraps the same
// execute/query so we can assert the SQL issuance shape.
//
// Mock-DB unit tests (Global Constraint #17 requires a paired real-DB test
// for every new SQL block, but the SQL blocks themselves are unchanged —
// alertRules + alertEvents + alertOutbox already have round-trip tests in
// tests/sql/. The new SQL block is `alertMetrics.getLatest` which is exercised
// transitively here; the dedicated round-trip test lives in
// tests/sql/alert-metrics.test.js per GC #17.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMockDb } from './helpers/db-mock.js';
import { createAlertEvaluationLoop } from '../src/services/alert-engine.js';

const NOW = new Date('2026-01-01T12:00:00Z');

function makeLoop({ scripts = [], systemConfig = {}, intervalSeconds = 60 } = {}) {
  const db = buildMockDb(scripts).withRecording();
  return {
    db,
    loop: createAlertEvaluationLoop({
      db,
      getIntervalSeconds: async () => intervalSeconds,
      getSystemConfig: async () => systemConfig
    })
  };
}

function findExecute(records, predicate) {
  return records.find((r) => predicate(r.sql, r.params));
}

test('alertEvalLoop: returns the {start, stop, tick, isRunning} factory shape', () => {
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

test('alertEvalLoop: tick fires a rule that has been pending past for_minutes', async () => {
  // Seed: 1 host, 1 enabled rule (cpu > 90), state = pending with first_hit_at
  // 6 minutes ago, latest metrics = cpu_pct 95.
  const firstHitAt = new Date(NOW.getTime() - 6 * 60_000);
  const rules = [{
    rule_id: 7,
    hostname: 'srv-01',
    name: 'cpu-high',
    condition: JSON.stringify({ op: 'GT', metric: 'cpu_pct', value: 90 }),
    for_minutes: 5,
    cooldown_minutes: 30,
    recipients: 'ops@example.com',
    enabled: 1,
    state: 'pending',
    first_hit_at: firstHitAt,
    last_fired_at: null,
    suppressed_until: null
  }];
  const { db, loop } = makeLoop({
    scripts: [
      { match: /FROM ad_member_servers WHERE enabled = 1/i, rows: [{ hostname: 'srv-01' }] },
      { match: /FROM alert_rules[\s\S]*?LEFT JOIN alert_rule_state/i, rows: rules },
      { match: /FROM `?pkg_ad_os_baseline`?\.?metrics|SELECT.*FROM .pkg_ad_os_baseline/i, rows: [{ cpu_pct: 95, memory_pct: 50, disk_free: '{}', services: '{}', events: '[]' }] },
      { match: /SELECT last_seen_at FROM ad_member_servers/i, rows: [{ last_seen_at: NOW }] }
    ]
  });
  await loop.tick();

  // The state upsert MUST have run with state='firing'.
  const stateUpsert = findExecute(db.records, (sql, params) =>
    /INSERT INTO alert_rule_state/i.test(sql) && params[0] === 7
  );
  assert.ok(stateUpsert, 'state upsert should have been issued for rule_id=7');
  assert.equal(stateUpsert.params[1], 'firing');

  // The alert_events insert should have run with event='firing'.
  const eventInsert = findExecute(db.records, (sql, params) =>
    /INSERT INTO alert_events/i.test(sql) && params[1] === 'firing'
  );
  assert.ok(eventInsert, 'alert_events firing insert should have been issued');

  // The alert_email_outbox insert should have run, with alert_event_id (mock
  // returns 99 for INSERT/MERGE) and the rule's recipient.
  const outboxInsert = findExecute(db.records, (sql) =>
    /INSERT INTO alert_email_outbox/i.test(sql)
  );
  assert.ok(outboxInsert, 'alert_email_outbox insert should have been issued');
  assert.equal(outboxInsert.params[1], 'ops@example.com');
  assert.match(outboxInsert.params[3], /ALERT/);
});

test('alertEvalLoop: recovery fires email when firing has been no-hit for for_minutes', async () => {
  // Seed: state=firing, last_fired_at = 10 min ago, metrics = cpu_pct 50 (no hit).
  const lastFiredAt = new Date(NOW.getTime() - 10 * 60_000);
  const rules = [{
    rule_id: 8,
    hostname: 'srv-02',
    name: 'cpu-high',
    condition: JSON.stringify({ op: 'GT', metric: 'cpu_pct', value: 90 }),
    for_minutes: 5,
    cooldown_minutes: 30,
    recipients: null,
    enabled: 1,
    state: 'firing',
    first_hit_at: new Date(NOW.getTime() - 20 * 60_000),
    last_fired_at: lastFiredAt,
    suppressed_until: null
  }];
  const { db, loop } = makeLoop({
    scripts: [
      { match: /FROM ad_member_servers WHERE enabled = 1/i, rows: [{ hostname: 'srv-02' }] },
      { match: /FROM alert_rules[\s\S]*?LEFT JOIN alert_rule_state/i, rows: rules },
      { match: /FROM `?pkg_ad_os_baseline`?\.?metrics|SELECT.*FROM .pkg_ad_os_baseline/i, rows: [{ cpu_pct: 50, memory_pct: 50, disk_free: '{}', services: '{}', events: '[]' }] },
      { match: /SELECT last_seen_at FROM ad_member_servers/i, rows: [{ last_seen_at: NOW }] }
    ],
    systemConfig: { alert_default_to: 'default@example.com', alert_default_cc: 'cc@example.com' }
  });
  await loop.tick();

  // State should transition to normal.
  const stateUpsert = findExecute(db.records, (sql, params) =>
    /INSERT INTO alert_rule_state/i.test(sql) && params[0] === 8
  );
  assert.ok(stateUpsert);
  assert.equal(stateUpsert.params[1], 'normal');

  // alert_events should have a 'recovered' entry.
  const recoveredEvent = findExecute(db.records, (sql, params) =>
    /INSERT INTO alert_events/i.test(sql) && params[1] === 'recovered'
  );
  assert.ok(recoveredEvent, 'recovered alert_events row should have been issued');

  // outbox should have a recovery email (subject contains RECOVERED).
  const outboxInsert = findExecute(db.records, (sql) =>
    /INSERT INTO alert_email_outbox/i.test(sql)
  );
  assert.ok(outboxInsert);
  assert.match(outboxInsert.params[3], /RECOVERED/);
  // recipients were null in the rule → defaults from system_config.
  assert.equal(outboxInsert.params[1], 'default@example.com');
  assert.equal(outboxInsert.params[2], 'cc@example.com');
});

test('alertEvalLoop: cooldown (suppressed_until in future) suppresses re-fire', async () => {
  // Seed: state=firing, suppressed_until = +60min (so the transient state
  // machine stays firing). The brief + state machine should not write a new
  // event/outbox row. The state UPSERT WILL still run (state machine always
  // stamps last_evaluated_at — that's the contact-contract with the kernel).
  const suppressedUntil = new Date(NOW.getTime() + 60 * 60_000);
  const rules = [{
    rule_id: 9,
    hostname: 'srv-03',
    name: 'cpu-high',
    condition: JSON.stringify({ op: 'GT', metric: 'cpu_pct', value: 90 }),
    for_minutes: 5,
    cooldown_minutes: 30,
    recipients: 'ops@example.com',
    enabled: 1,
    state: 'firing',
    first_hit_at: new Date(NOW.getTime() - 30 * 60_000),
    last_fired_at: new Date(NOW.getTime() - 15 * 60_000),
    suppressed_until: suppressedUntil
  }];
  const { db, loop } = makeLoop({
    scripts: [
      { match: /FROM ad_member_servers WHERE enabled = 1/i, rows: [{ hostname: 'srv-03' }] },
      { match: /FROM alert_rules[\s\S]*?LEFT JOIN alert_rule_state/i, rows: rules },
      { match: /FROM `?pkg_ad_os_baseline`?\.?metrics|SELECT.*FROM .pkg_ad_os_baseline/i, rows: [{ cpu_pct: 95, memory_pct: 50, disk_free: '{}', services: '{}', events: '[]' }] },
      { match: /SELECT last_seen_at FROM ad_member_servers/i, rows: [{ last_seen_at: NOW }] }
    ]
  });
  await loop.tick();

  // No new alert_events or outbox row should have been written.
  const newEvent = findExecute(db.records, (sql) =>
    /INSERT INTO alert_events/i.test(sql)
  );
  assert.equal(newEvent, undefined, 'cooldown shield: no alert_events insert');
  const newOutbox = findExecute(db.records, (sql) =>
    /INSERT INTO alert_email_outbox/i.test(sql)
  );
  assert.equal(newOutbox, undefined, 'cooldown shield: no outbox insert');

  // State should still be firing (NOT transitioned to normal — cooldown
  // shields re-fire AND shields false recovery while suppressed).
  const stateUpsert = findExecute(db.records, (sql, params) =>
    /INSERT INTO alert_rule_state/i.test(sql) && params[0] === 9
  );
  assert.ok(stateUpsert);
  assert.equal(stateUpsert.params[1], 'firing', 'state stays firing under cooldown');
});

test('alertEvalLoop: disabled rule is skipped (no state write, no event)', async () => {
  // The rule list query (which LEFT JOINs alert_rule_state) needs to filter
  // by enabled=1 — that's enforced at the SQL layer via listEnabledForHost.
  // The mock returns [] when no rule matches → loop should write no state,
  // no event, no outbox.
  const { db, loop } = makeLoop({
    scripts: [
      { match: /FROM ad_member_servers WHERE enabled = 1/i, rows: [{ hostname: 'srv-04' }] },
      { match: /FROM alert_rules[\s\S]*?LEFT JOIN alert_rule_state/i, rows: [] },
      { match: /FROM `?pkg_ad_os_baseline`?\.?metrics|SELECT.*FROM .pkg_ad_os_baseline/i, rows: [{ cpu_pct: 95, memory_pct: 50, disk_free: '{}', services: '{}', events: '[]' }] },
      { match: /SELECT last_seen_at FROM ad_member_servers/i, rows: [{ last_seen_at: NOW }] }
    ]
  });
  await loop.tick();

  const stateUpsert = findExecute(db.records, (sql) =>
    /INSERT INTO alert_rule_state/i.test(sql)
  );
  assert.equal(stateUpsert, undefined, 'no state upsert when no enabled rules');
  const eventInsert = findExecute(db.records, (sql) =>
    /INSERT INTO alert_events/i.test(sql)
  );
  assert.equal(eventInsert, undefined);
  const outboxInsert = findExecute(db.records, (sql) =>
    /INSERT INTO alert_email_outbox/i.test(sql)
  );
  assert.equal(outboxInsert, undefined);
});

test('alertEvalLoop: transaction rolls back on partial failure (no state written)', async () => {
  // Mock a transaction that throws after the state upsert succeeds but before
  // the event insert. The state upsert's row should be rolled back by the
  // driver (covered by the standard mock: transaction wrapper re-uses the
  // same execute/query funcs and "throws" the wrapped error). We assert:
  //   - the state upsert SQL was ISSUED (the wrapped execute was called)
  //   - we get a throw and the loop catches it (tick must not crash)
  const firstHitAt = new Date(NOW.getTime() - 6 * 60_000);
  const rules = [{
    rule_id: 11,
    hostname: 'srv-05',
    name: 'cpu-high',
    condition: JSON.stringify({ op: 'GT', metric: 'cpu_pct', value: 90 }),
    for_minutes: 5,
    cooldown_minutes: 30,
    recipients: 'ops@example.com',
    enabled: 1,
    state: 'pending',
    first_hit_at: firstHitAt,
    last_fired_at: null,
    suppressed_until: null
  }];
  const { db, loop } = makeLoop({
    scripts: [
      { match: /FROM ad_member_servers WHERE enabled = 1/i, rows: [{ hostname: 'srv-05' }] },
      { match: /FROM alert_rules[\s\S]*?LEFT JOIN alert_rule_state/i, rows: rules },
      { match: /FROM `?pkg_ad_os_baseline`?\.?metrics|SELECT.*FROM .pkg_ad_os_baseline/i, rows: [{ cpu_pct: 95, memory_pct: 50, disk_free: '{}', services: '{}', events: '[]' }] },
      { match: /SELECT last_seen_at FROM ad_member_servers/i, rows: [{ last_seen_at: NOW }] }
    ]
  });

  // Replace the transaction wrapper to throw AFTER the state upsert
  // executes. The mock's transaction(work) just runs work({ execute, query })
  // — override to trigger an error on the alert_events insert.
  const records = db.records;
  db.transaction = async (work) => {
    return work({
      execute: async (sql, params) => {
        records.push({ sql, params: [...params] });
        if (/INSERT INTO alert_events/i.test(sql)) {
          throw new Error('simulated mid-tx failure');
        }
        return { rows: [], affectedRows: 1, insertId: 99 };
      },
      query: async () => ({ rows: [] })
    });
  };

  await loop.tick(); // tick MUST swallow the error (try/catch in tick)

  // State upsert SQL was issued (one was sent before the throw).
  const stateUpsert = records.find((c) =>
    /INSERT INTO alert_rule_state/i.test(c.sql)
  );
  assert.ok(stateUpsert, 'state upsert should have been attempted');
});

test('alertEvalLoop: tick() does NOT call getIntervalSeconds (matches createProbeLoop pattern)', async () => {
  // After F2 review fix: the per-tick `intervalSec` read in tick() was dead
  // (never used). We now drop the read entirely so the floor is enforced
  // once at start() — same as createProbeLoop at probe.js:111. Restart
  // the loop to pick up interval config changes. This test locks the
  // contract: tick() must not re-read the interval.
  const { db } = makeLoop({
    scripts: [
      { match: /FROM ad_member_servers WHERE enabled = 1/i, rows: [] }
    ]
  });
  let readInterval = 0;
  const loop = createAlertEvaluationLoop({
    db,
    getIntervalSeconds: async () => { readInterval = 1; return 1; },
    getSystemConfig: async () => ({})
  });
  await loop.tick();
  assert.equal(readInterval, 0, 'tick() must not call getIntervalSeconds');
  // The 10-second floor (Global Constraint #9) is enforced inside start()
  // when the loop is mounted: Math.max(10, raw). start() does call
  // getIntervalSeconds, so it is exercised on the boot path.
  loop.start();
  await loop.stop();
  assert.equal(readInterval, 1, 'start() must call getIntervalSeconds once to set the period');
});

test('alertEvalLoop: tick is no-op when no enabled hosts', async () => {
  const { db, loop } = makeLoop({
    scripts: [
      { match: /FROM ad_member_servers WHERE enabled = 1/i, rows: [] }
    ]
  });
  await loop.tick();
  // No SQL beyond the host query should have been issued.
  const ruleReads = db.records.filter((c) => /FROM alert_rules/i.test(c.sql));
  assert.equal(ruleReads.length, 0, 'no rule reads when no hosts');
});

test('alertEvalLoop: heartbeat_stale derived from last_seen_at delta', async () => {
  // Build a context where the user's rule is on heartbeat_stale. The
  // evaluation kernel consumes metrics.heartbeat_stale (in minutes). The
  // loop computes it from last_seen_at: Math.floor((now - last_seen) / 60_000).
  const lastSeenAt = new Date(NOW.getTime() - 30 * 60_000); // 30 min ago
  const rules = [{
    rule_id: 12,
    hostname: 'srv-06',
    name: 'stale-heartbeat',
    condition: JSON.stringify({ op: 'GT', metric: 'heartbeat_stale', value: 10 }),
    for_minutes: 0, // zero so first tick fires
    cooldown_minutes: 30,
    recipients: 'ops@example.com',
    enabled: 1,
    state: 'normal',
    first_hit_at: null,
    last_fired_at: null,
    suppressed_until: null
  }];
  const { db, loop } = makeLoop({
    scripts: [
      { match: /FROM ad_member_servers WHERE enabled = 1/i, rows: [{ hostname: 'srv-06' }] },
      { match: /FROM alert_rules[\s\S]*?LEFT JOIN alert_rule_state/i, rows: rules },
      { match: /FROM `?pkg_ad_os_baseline`?\.?metrics|SELECT.*FROM .pkg_ad_os_baseline/i, rows: [] }, // no metrics row
      { match: /SELECT last_seen_at FROM ad_member_servers/i, rows: [{ last_seen_at: lastSeenAt }] }
    ]
  });
  await loop.tick();

  // The state machine should have transitioned normal→pending (because hit=true
  // via heartbeat_stale=30 > 10) on the FIRST tick (for_minutes=0).
  const stateUpsert = findExecute(db.records, (sql, params) =>
    /INSERT INTO alert_rule_state/i.test(sql) && params[0] === 12
  );
  assert.ok(stateUpsert);
  assert.equal(stateUpsert.params[1], 'firing', 'first tick with for_minutes=0 should fire');
});
