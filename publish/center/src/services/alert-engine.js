// center/src/services/alert-engine.js
// Pure-functions alert engine for the non-AD server management workstream.
// Two public surfaces consumed by the AlertEvalLoop (Task 11):
//
//   evaluateCondition(condition, metrics) → { hit, observedValues }
//     Recursive evaluator that walks a rule tree of leaf comparison nodes
//     and composite AND/OR nodes. Special metric prefixes route through
//     typed lookups (heartbeat_stale, disk_free:X, service_state:X,
//     event_log:X). Unknown metric → hit=false.
//
//   transitionState(state, hit, now, rule) → newState
//     Pure state machine over (normal → pending → firing → normal). Rule
//     shape: { for_minutes, cooldown_minutes? }. for_minutes is authoritative
//     (Global Constraint #11); per-condition for_minutes fields in the rule
//     tree are documentation only and ignored here.
//
// No DB, no logger, no config: AlertEvalLoop is responsible for loading
// rules, scheduling evaluation, persisting state, and audit logging. This
// module is the deterministic kernel that gets tested in isolation.

const MS_PER_MIN = 60_000;

function readMetric(metrics, name) {
  if (typeof name !== 'string') return undefined;
  if (name === 'heartbeat_stale') return metrics.heartbeat_stale;
  if (name.startsWith('disk_free:')) {
    const key = name.split(':')[1];
    return metrics.disk_free ? metrics.disk_free[key] : undefined;
  }
  if (name.startsWith('service_state:')) {
    const key = name.split(':')[1];
    return metrics.services ? metrics.services[key] : undefined;
  }
  if (name.startsWith('event_log:')) {
    const logName = name.split(':')[1];
    const events = metrics.events || [];
    return events.filter((e) => e.log === logName);
  }
  return metrics[name];
}

function evalLeaf(leaf, metrics) {
  const raw = readMetric(metrics, leaf.metric);
  if (raw === undefined || raw === null) return { hit: false, observedValue: null };

  // event_log:X returns an array of matching events; treat the count as the
  // observed value so callers can write GT 0 / EQ 0 leaf conditions against it.
  const observedValue = Array.isArray(raw) ? raw.length : raw;

  let hit = false;
  switch (leaf.op) {
    case 'GT':
      hit = observedValue > leaf.value;
      break;
    case 'LT':
      hit = observedValue < leaf.value;
      break;
    case 'EQ':
      hit = observedValue === leaf.value;
      break;
    case 'NEQ':
      hit = observedValue !== leaf.value;
      break;
    default:
      hit = false;
  }
  return { hit, observedValue };
}

export function evaluateCondition(node, metrics) {
  if (!node) return { hit: false, observedValues: {} };

  if (node.op === 'AND' || node.op === 'OR') {
    const childResults = node.children.map((c) => evaluateCondition(c, metrics));
    const hit = node.op === 'AND'
      ? childResults.every((r) => r.hit)
      : childResults.some((r) => r.hit);
    const observedValues = Object.assign({}, ...childResults.map((r) => r.observedValues));
    return { hit, observedValues };
  }

  const r = evalLeaf(node, metrics);
  return { hit: r.hit, observedValues: { [node.metric]: r.observedValue } };
}

function elapsedMinutes(now, then) {
  if (!then) return 0;
  const t = then instanceof Date ? then.getTime() : new Date(then).getTime();
  return Math.floor((now.getTime() - t) / MS_PER_MIN);
}

export function transitionState(s, hit, now, rule) {
  // Defensive: treat null/undefined state as normal so callers don't crash on
  // a fresh row. AlertEvalLoop should always pass a state object, but a
  // forgiving kernel is cheap insurance.
  const cur = s && typeof s === 'object' ? s : { state: 'normal' };
  const forMinutes = rule.for_minutes;

  if (cur.state === 'normal') {
    if (!hit) {
      return { ...cur, state: 'normal', last_evaluated_at: now };
    }
    return { ...cur, state: 'pending', first_hit_at: now, last_evaluated_at: now };
  }

  if (cur.state === 'pending') {
    if (!hit) {
      return {
        ...cur,
        state: 'normal',
        first_hit_at: null,
        last_evaluated_at: now
      };
    }
    if (elapsedMinutes(now, cur.first_hit_at) >= forMinutes) {
      return {
        ...cur,
        state: 'firing',
        last_fired_at: now,
        last_evaluated_at: now
      };
    }
    return { ...cur, last_evaluated_at: now };
  }

  if (cur.state === 'firing') {
    // Cooldown shield: while suppressed_until is in the future, stay firing
    // regardless of hit. This prevents re-fire flapping when the underlying
    // condition oscillates across the pending threshold during recovery.
    if (cur.suppressed_until) {
      const sup = cur.suppressed_until instanceof Date
        ? cur.suppressed_until
        : new Date(cur.suppressed_until);
      if (sup > now) {
        return { ...cur, last_evaluated_at: now };
      }
    }

    if (!hit && elapsedMinutes(now, cur.last_fired_at) >= forMinutes) {
      return {
        ...cur,
        state: 'normal',
        last_recovered_at: now,
        suppressed_until: null,
        first_hit_at: null,
        last_evaluated_at: now
      };
    }
    return { ...cur, last_evaluated_at: now };
  }

  // Unknown state — keep current shape, just stamp evaluation.
  return { ...cur, last_evaluated_at: now };
}
