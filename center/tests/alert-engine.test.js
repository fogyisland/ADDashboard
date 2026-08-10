// Unit tests for Task 10 — pure-functions AlertEngine in
// center/src/services/alert-engine.js.
//
// The alert engine has two public surfaces:
//   - evaluateCondition(condition, metrics)  → recursive evaluator
//   - transitionState(state, hit, now, rule) → state machine
//
// Both are pure; no DB, no logger, no config. Pinning the contract here
// means the AlertEvalLoop (Task 11) can drop them in without rewriting
// behavior.
//
// Global Constraint #11 (verbatim): "Rule-level for_minutes is authoritative;
// per-condition for_minutes fields in the rule tree are documentation only and
// ignored by the state machine." These tests therefore never pass per-condition
// for_minutes and only consult rule.for_minutes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCondition, transitionState } from '../src/services/alert-engine.js';

const NOW = new Date('2026-01-01T00:00:00Z');

test('evaluateCondition: simple GT leaf hit', () => {
  const r = evaluateCondition({ op: 'GT', metric: 'cpu_pct', value: 90 }, { cpu_pct: 95 });
  assert.equal(r.hit, true);
  assert.deepEqual(r.observedValues, { cpu_pct: 95 });
});

test('evaluateCondition: simple GT leaf miss', () => {
  const r = evaluateCondition({ op: 'GT', metric: 'cpu_pct', value: 90 }, { cpu_pct: 50 });
  assert.equal(r.hit, false);
});

test('evaluateCondition: OR with two leaves — one hit → true', () => {
  const c = {
    op: 'OR',
    children: [
      { op: 'GT', metric: 'cpu_pct', value: 90 },
      { op: 'GT', metric: 'memory_pct', value: 85 }
    ]
  };
  assert.equal(evaluateCondition(c, { cpu_pct: 50, memory_pct: 90 }).hit, true);
  assert.equal(evaluateCondition(c, { cpu_pct: 50, memory_pct: 50 }).hit, false);
});

test('evaluateCondition: AND with two leaves — both must hit', () => {
  const c = {
    op: 'AND',
    children: [
      { op: 'GT', metric: 'cpu_pct', value: 90 },
      { op: 'GT', metric: 'memory_pct', value: 85 }
    ]
  };
  assert.equal(evaluateCondition(c, { cpu_pct: 95, memory_pct: 90 }).hit, true);
  assert.equal(evaluateCondition(c, { cpu_pct: 95, memory_pct: 50 }).hit, false);
});

test('evaluateCondition: nested OR(AND, leaf) — branch coverage', () => {
  const c = {
    op: 'OR',
    children: [
      {
        op: 'AND',
        children: [
          { op: 'LT', metric: 'disk_free:D', value: 1000 },
          { op: 'LT', metric: 'disk_free:E', value: 500 }
        ]
      },
      { op: 'GT', metric: 'cpu_pct', value: 95 }
    ]
  };
  // AND branch fires
  assert.equal(
    evaluateCondition(c, { cpu_pct: 50, disk_free: { D: 500, E: 200 } }).hit,
    true
  );
  // leaf branch fires
  assert.equal(
    evaluateCondition(c, { cpu_pct: 99, disk_free: { D: 5000, E: 5000 } }).hit,
    true
  );
  // neither branch fires
  assert.equal(
    evaluateCondition(c, { cpu_pct: 50, disk_free: { D: 5000, E: 5000 } }).hit,
    false
  );
});

test('evaluateCondition: heartbeat_stale synthetic metric', () => {
  const r = evaluateCondition(
    { op: 'GT', metric: 'heartbeat_stale', value: 5 },
    { heartbeat_stale: 10 }
  );
  assert.equal(r.hit, true);
});

test('evaluateCondition: unknown metric → hit=false', () => {
  const r = evaluateCondition({ op: 'GT', metric: 'unknown', value: 1 }, {});
  assert.equal(r.hit, false);
});

test('evaluateCondition: composite NOT op → hit=false (unknown composite)', () => {
  // NOT is intentionally not part of the v1 supported set; result is hit=false.
  const c = {
    op: 'NOT',
    children: [{ op: 'GT', metric: 'cpu_pct', value: 90 }]
  };
  assert.equal(evaluateCondition(c, { cpu_pct: 95 }).hit, false);
});

test('evaluateCondition: EQ leaf op strict equality', () => {
  assert.equal(
    evaluateCondition({ op: 'EQ', metric: 'cpu_pct', value: 50 }, { cpu_pct: 50 }).hit,
    true
  );
  assert.equal(
    evaluateCondition({ op: 'EQ', metric: 'cpu_pct', value: 50 }, { cpu_pct: 51 }).hit,
    false
  );
});

test('evaluateCondition: NEQ leaf op strict inequality', () => {
  assert.equal(
    evaluateCondition({ op: 'NEQ', metric: 'cpu_pct', value: 50 }, { cpu_pct: 51 }).hit,
    true
  );
  assert.equal(
    evaluateCondition({ op: 'NEQ', metric: 'cpu_pct', value: 50 }, { cpu_pct: 50 }).hit,
    false
  );
});

test('evaluateCondition: heartbeat_stale with no value → hit=false', () => {
  const r = evaluateCondition(
    { op: 'GT', metric: 'heartbeat_stale', value: 5 },
    {}
  );
  assert.equal(r.hit, false);
});

test('evaluateCondition: disk_free:X reads nested map', () => {
  assert.equal(
    evaluateCondition(
      { op: 'LT', metric: 'disk_free:D', value: 1000 },
      { disk_free: { D: 500 } }
    ).hit,
    true
  );
});

test('evaluateCondition: service_state:X reads nested map', () => {
  assert.equal(
    evaluateCondition(
      { op: 'EQ', metric: 'service_state:spooler', value: 'running' },
      { services: { spooler: 'running' } }
    ).hit,
    true
  );
});

test('evaluateCondition: event_log:X filters events by log name', () => {
  // Composite that requires at least one matching event → use observed count
  // semantics via the metric value itself (count of matching events returned
  // by readMetric is the array length). Use GT 0 to model "is non-empty".
  const c = {
    op: 'GT',
    metric: 'event_log:Application',
    value: 0
  };
  const r1 = evaluateCondition(c, { events: [{ log: 'Application', id: 1 }] });
  assert.equal(r1.hit, true);
  const r2 = evaluateCondition(c, { events: [] });
  assert.equal(r2.hit, false);
});

test('transitionState: normal + hit → pending + first_hit_at set', () => {
  const s = transitionState({ state: 'normal' }, true, NOW, { for_minutes: 5 });
  assert.equal(s.state, 'pending');
  assert.equal(s.first_hit_at, NOW);
});

test('transitionState: normal + no-hit → no-op (state stays normal, last_evaluated_at set)', () => {
  const s = transitionState({ state: 'normal' }, false, NOW, { for_minutes: 5 });
  assert.equal(s.state, 'normal');
  assert.equal(s.last_evaluated_at, NOW);
});

test('transitionState: pending + hit elapsed >= for_minutes → firing', () => {
  const s = transitionState(
    { state: 'pending', first_hit_at: new Date(NOW.getTime() - 6 * 60_000) },
    true,
    NOW,
    { for_minutes: 5 }
  );
  assert.equal(s.state, 'firing');
  assert.equal(s.last_fired_at, NOW);
});

test('transitionState: pending + hit NOT elapsed → stays pending', () => {
  const firstHit = new Date(NOW.getTime() - 1 * 60_000);
  const s = transitionState(
    { state: 'pending', first_hit_at: firstHit },
    true,
    NOW,
    { for_minutes: 5 }
  );
  assert.equal(s.state, 'pending');
  assert.equal(s.last_evaluated_at, NOW);
});

test('transitionState: pending + no-hit before elapsed → normal + first_hit_at cleared', () => {
  const s = transitionState(
    { state: 'pending', first_hit_at: new Date(NOW.getTime() - 1 * 60_000) },
    false,
    NOW,
    { for_minutes: 5 }
  );
  assert.equal(s.state, 'normal');
  assert.equal(s.first_hit_at, null);
});

test('transitionState: firing + no-hit elapsed >= for_minutes → normal + last_recovered_at', () => {
  const s = transitionState(
    {
      state: 'firing',
      last_fired_at: new Date(NOW.getTime() - 6 * 60_000),
      first_hit_at: new Date(NOW.getTime() - 10 * 60_000)
    },
    false,
    NOW,
    { for_minutes: 5 }
  );
  assert.equal(s.state, 'normal');
  assert.equal(s.last_recovered_at, NOW);
  assert.equal(s.first_hit_at, null);
  assert.equal(s.suppressed_until, null);
});

test('transitionState: firing + cooldown active → no-op (state stays firing)', () => {
  const s = transitionState(
    {
      state: 'firing',
      suppressed_until: new Date(NOW.getTime() + 60_000),
      last_fired_at: new Date(NOW.getTime() - 1 * 60_000)
    },
    true,
    NOW,
    { for_minutes: 5, cooldown_minutes: 30 }
  );
  assert.equal(s.state, 'firing');
  assert.equal(s.last_evaluated_at, NOW);
});

test('transitionState: firing + hit during cooldown → stays firing (cooldown shields re-fire)', () => {
  const s = transitionState(
    {
      state: 'firing',
      suppressed_until: new Date(NOW.getTime() + 60_000),
      last_fired_at: new Date(NOW.getTime() - 1 * 60_000)
    },
    true,
    NOW,
    { for_minutes: 5, cooldown_minutes: 30 }
  );
  assert.equal(s.state, 'firing');
});

test('transitionState: firing + no-hit NOT elapsed → stays firing', () => {
  const s = transitionState(
    {
      state: 'firing',
      last_fired_at: new Date(NOW.getTime() - 1 * 60_000),
      first_hit_at: new Date(NOW.getTime() - 2 * 60_000)
    },
    false,
    NOW,
    { for_minutes: 5 }
  );
  assert.equal(s.state, 'firing');
  assert.equal(s.last_evaluated_at, NOW);
});

test('transitionState: null/undefined state input is treated as normal (defensive)', () => {
  // Defensive: transitionState should not crash on null state; it should
  // behave as if starting from normal.
  const s = transitionState(null, true, NOW, { for_minutes: 5 });
  assert.equal(s.state, 'pending');
});
