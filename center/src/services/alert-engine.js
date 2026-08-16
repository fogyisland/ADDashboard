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

// ---------------------------------------------------------------------------
// AlertEvaluationLoop — Task 11 factory
// ---------------------------------------------------------------------------
//
// createAlertEvaluationLoop({ db, getIntervalSeconds, getSystemConfig, logger }) → { start, stop, tick, isRunning }
//
// Matches the createProbeLoop factory shape (see center/src/services/probe.js):
//   - start()   starts a setInterval loop, clamped to a 10-second floor
//                (Global Constraint #9) and the supplied getIntervalSeconds
//                value (default 60; read once at start + re-read on each tick
//                so config edits in the UI take effect without restart).
//   - stop()    clears the interval and waits for the in-flight tick so
//                shutdown can't strand a half-written transaction.
//   - tick()    runs one evaluation pass. In-Flight guard prevents overlap.
//   - isRunning() returns whether the loop is currently scheduled.
//
// Per-tick behavior (spec §9.2):
//   1. Read all enabled hosts from ad_member_servers.
//   2. For each host: read enabled alert_rules LEFT JOIN alert_rule_state.
//   3. Read latest metrics from pkg_ad_os_baseline.metrics (1 row per agent).
//   4. Compute heartbeat_stale from last_seen_at (floor: minutes).
//   5. For each rule: evaluateCondition → transitionState.
//   6. In ONE transaction: upsert alert_rule_state; if normal→firing OR
//      firing→normal → INSERT alert_events + alert_email_outbox.
//
// All work happens via db.execute / db.transaction — the kernel is purely
// functional, the loop is the I/O boundary.

const STATE_UPSERT_MYSQL = `INSERT INTO alert_rule_state (rule_id, state, first_hit_at, last_evaluated_at, last_fired_at, last_recovered_at, suppressed_until)
                            VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?)
                            ON DUPLICATE KEY UPDATE
                              state = VALUES(state),
                              first_hit_at = VALUES(first_hit_at),
                              last_evaluated_at = CURRENT_TIMESTAMP,
                              last_fired_at = VALUES(last_fired_at),
                              last_recovered_at = VALUES(last_recovered_at),
                              suppressed_until = VALUES(suppressed_until)`;
const STATE_UPSERT_MSSQL = `MERGE INTO alert_rule_state AS t
                            USING (SELECT
                              ? AS rule_id, ? AS state, ? AS first_hit_at,
                              ? AS last_fired_at, ? AS last_recovered_at, ? AS suppressed_until
                            ) AS s
                            ON t.rule_id = s.rule_id
                            WHEN MATCHED THEN UPDATE SET
                              state = s.state,
                              first_hit_at = s.first_hit_at,
                              last_evaluated_at = SYSUTCDATETIME(),
                              last_fired_at = s.last_fired_at,
                              last_recovered_at = s.last_recovered_at,
                              suppressed_until = s.suppressed_until
                            WHEN NOT MATCHED THEN INSERT
                              (rule_id, state, first_hit_at, last_evaluated_at, last_fired_at, last_recovered_at, suppressed_until)
                            VALUES
                              (s.rule_id, s.state, s.first_hit_at, SYSUTCDATETIME(), s.last_fired_at, s.last_recovered_at, s.suppressed_until);`;

// inFlight guard pattern (matches createProbeLoop at probe.js:111):
//   - setInterval callback captures the in-flight tick via `inFlight = tick().catch(...)`.
//   - stop() awaits the in-flight promise to drain so a slow tick doesn't get cut off.
//   - tick() itself has NO `if (inFlight) return;` re-entry guard; the setInterval callback
//     does not add one either. Two overlapping guards would silently swallow a slow tick
//     without surfacing it in logs. The natural setInterval cadence (>= 10s) plus the
//     drain-on-stop pattern are the contract. If a future requirement demands "skip the
//     next tick if the previous is still running", the guard belongs in tick() body —
//     not at the setInterval callback boundary.
export function createAlertEvaluationLoop({ db, getIntervalSeconds, getSystemConfig, logger }) {
  const log = logger?.child ? logger.child({ component: 'alert-eval' }) : null;
  const logError = (err) => {
    if (log) log.error({ err: err.message }, 'alert-eval tick failed');
    else console.error('[alert-eval] tick failed:', err.message);
  };

  let interval = null;
  let inFlight = null;
  let running = false;

  async function readEnabledHosts() {
    const { rows } = await db.query(`SELECT hostname FROM ad_member_servers WHERE enabled = 1`);
    return rows;
  }

  async function readRulesForHost(hostname) {
    const { rows } = await db.execute(db.sql.alertRules.listEnabledForHostWithState, [hostname]);
    return rows;
  }

  async function readLatestMetrics(hostname) {
    const { rows } = await db.query(db.sql.alertMetrics.getLatest, [hostname]);
    return rows[0] || null;
  }

  async function readLastSeen(hostname) {
    const { rows } = await db.query(`SELECT last_seen_at FROM ad_member_servers WHERE hostname = ?`, [hostname]);
    return rows[0]?.last_seen_at || null;
  }

  function parseJSONSafe(s, fallback) {
    if (s == null) return fallback;
    if (typeof s !== 'string') return s;
    try { return JSON.parse(s); } catch { return fallback; }
  }

  function buildContext(metricsRow, lastSeen) {
    const ctx = { ...(metricsRow || {}) };
    // heartbeat_stale is a SYNTHETIC metric expressed in minutes — derived
    // from the last_seen_at delta. Unknown when last_seen is missing.
    if (lastSeen) {
      const t = lastSeen instanceof Date ? lastSeen.getTime() : new Date(lastSeen).getTime();
      if (Number.isFinite(t)) {
        ctx.heartbeat_stale = Math.floor((Date.now() - t) / 60_000);
      }
    } else {
      ctx.heartbeat_stale = null;
    }
    return ctx;
  }

  function stateUpsertSQL() {
    return db.dialect === 'mssql' ? STATE_UPSERT_MSSQL : STATE_UPSERT_MYSQL;
  }

  // Insert event + outbox row, both via the same SQL registry used by
  // alertRoutes. alert_events.insert for MySQL is plain; for MSSQL it
  // appends SELECT SCOPE_IDENTITY() so the returned insertId is the
  // freshly-allocated event row's id.
  async function recordTransition(tx, { ruleId, hostname, event, detail, recipients, subject, body }) {
    const insertEvent = db.sql.alertEvents.insert;
    const insertResult = await tx.execute(insertEvent, [ruleId, event, hostname, JSON.stringify(detail)]);
    // MySQL returns insertId; MSSQL returns recordset[0].id from OUTPUT INSERTED.id.
    const eventId = insertResult.insertId ?? insertResult.recordset?.[0]?.id;
    if (eventId == null) {
      throw new Error(`alert_events insert returned no id for rule=${ruleId} event=${event}`);
    }
    await tx.execute(db.sql.alertOutbox.enqueue, [
      eventId,
      recipients.to || '',
      recipients.cc || null,
      subject,
      body,
      null,
      new Date()
    ]);
  }

  async function evaluateOneHost(hostname) {
    const rules = await readRulesForHost(hostname);
    if (rules.length === 0) return;
    const [metricsRow, lastSeen] = await Promise.all([
      readLatestMetrics(hostname),
      readLastSeen(hostname)
    ]);
    const ctx = buildContext(metricsRow, lastSeen);
    const sysCfg = await getSystemConfig();
    const upsertSQL = stateUpsertSQL();

    for (const rule of rules) {
      const cond = parseJSONSafe(rule.condition, { op: 'NEQ', metric: '__missing__', value: null });
      const { hit } = evaluateCondition(cond, ctx);
      const prevState = {
        state: rule.state || 'normal',
        first_hit_at: rule.first_hit_at,
        last_fired_at: rule.last_fired_at,
        suppressed_until: rule.suppressed_until
      };
      // Apply transitionState iteratively until state stabilizes. With
      // for_minutes=0, a freshly normal rule should reach `firing` on the
      // first hit (normal→pending sets first_hit_at, then pending→firing
      // matches because elapsedMinutes(now, first_hit_at) = 0 ≥ 0). The
      // kernel is intentionally a single-step machine — the loop layer
      // closes the gap by re-applying with the freshly-computed state.
      const now = new Date();
      const ruleCfg = {
        for_minutes: Number(rule.for_minutes) || 0,
        cooldown_minutes: Number(rule.cooldown_minutes) || 0
      };
      let next = transitionState(prevState, hit, now, ruleCfg);
      if (next.state !== prevState.state) {
        next = transitionState(next, hit, now, ruleCfg);
      }

      // Always upsert state (the kernel stamps last_evaluated_at). Then
      // within the SAME transaction, on a transition that produces email,
      // insert the event + outbox row. db.transaction commits or rolls back
      // as a unit (Global Constraint #10).
      const recipients = (() => {
        const fromRule = parseJSONSafe(rule.recipients, null);
        if (fromRule && (fromRule.to || fromRule.cc)) return fromRule;
        // recipients may also be a CSV string (legacy shape used by the
        // admin UI's per-rule textbox). Support both.
        if (typeof rule.recipients === 'string' && rule.recipients.trim()) {
          return { to: rule.recipients.trim(), cc: null };
        }
        return { to: sysCfg.alert_default_to || '', cc: sysCfg.alert_default_cc || null };
      })();

      const isFiringTransition = prevState.state !== 'firing' && next.state === 'firing';
      const isRecoveryTransition = prevState.state === 'firing' && next.state === 'normal';
      const willInsert = isFiringTransition || isRecoveryTransition;

      await db.transaction(async (tx) => {
        await tx.execute(upsertSQL, [
          rule.rule_id,
          next.state,
          next.first_hit_at ?? null,
          next.last_fired_at ?? null,
          next.last_recovered_at ?? null,
          next.suppressed_until ?? null
        ]);
        if (willInsert) {
          if (isFiringTransition) {
            await recordTransition(tx, {
              ruleId: rule.rule_id,
              hostname,
              event: 'firing',
              detail: { condition: cond, metrics: ctx },
              recipients,
              subject: `[ALERT] ${hostname} — ${rule.name || rule.rule_id}`,
              body: `Condition fired for ${hostname}.\n\n` + JSON.stringify({ condition: cond, metrics: ctx }, null, 2)
            });
          } else {
            await recordTransition(tx, {
              ruleId: rule.rule_id,
              hostname,
              event: 'recovered',
              detail: { condition: cond, recovered_at: next.last_recovered_at },
              recipients,
              subject: `[RECOVERED] ${hostname} — ${rule.name || rule.rule_id}`,
              body: `Condition cleared for ${hostname}.`
            });
          }
        }
      });
    }
  }

  async function tick() {
    try {
      const hosts = await readEnabledHosts();
      for (const h of hosts) {
        try {
          await evaluateOneHost(h.hostname);
        } catch (err) {
          // Per-host failure must NOT abort the rest of the loop; one bad
          // host's data corruption can't starve the others.
          logError(err);
        }
      }
    } catch (err) {
      logError(err);
    }
  }

  function start() {
    if (running) return;
    // Mark running SYNCHRONOUSLY so isRunning() is correct immediately after
    // start() returns. createProbeLoop returns isRunning: () => interval !== null,
    // but that lies during the brief window between start() and the first
    // setInterval tick — tests assert the synchronous contract.
    running = true;
    // The 10-second floor (Global Constraint #9) is enforced for the
    // SCHEDULED cadence; tick() also re-reads it per call so a config
    // change takes effect without restart. getIntervalSeconds is async
    // but the first call resolves immediately at server.js boot (the DB is
    // up by the time we mount the loop). .then() schedules the interval on
    // the next event-loop tick after the value settles.
    Promise.resolve(getIntervalSeconds()).then((raw) => {
      if (!running) return; // start() was followed by stop() before resolve
      const intervalSec = Math.max(10, Number(raw) || 60);
      interval = setInterval(() => {
        inFlight = tick().catch((e) => logError(e));
      }, intervalSec * 1000);
    }).catch((e) => logError(e));
  }

  async function stop() {
    running = false;
    if (interval) clearInterval(interval);
    interval = null;
    if (inFlight) await inFlight.catch(() => {});
    inFlight = null;
  }

  return {
    start,
    stop,
    tick,
    isRunning: () => running
  };
}
