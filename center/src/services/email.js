// center/src/services/email.js
// SMTP delivery facade (Task 9) + delivery loop (Task 11).
//
// Pure-function exports:
//   maskPassword(cfg)          strip password from a config blob for logging
//   nextAttemptDelay(attempts, initialSeconds)  exponential backoff capped at 1h
//   send({smtp, from, to, cc, subject, text, html}, _deps)
//                              hand off to nodemailer; returns {ok, error?}
//
// Factory export (Task 11):
//   createEmailDeliveryLoop({ db, getIntervalSeconds, getSystemConfig, sendImpl, _deps })
//                              matches the createProbeLoop shape (see
//                              center/src/services/probe.js) — {start, stop, tick,
//                              isRunning}. Reads pending rows from
//                              alert_email_outbox (sent_at IS NULL AND
//                              next_attempt_at <= NOW()), calls send() per row,
//                              stamps sent_at on success, schedules retries on
//                              failure, and emits a cooldown_skipped alert_event
//                              once attempt_count reaches alert_email_max_attempts.
//                              `_deps` is forwarded to send() so tests can inject
//                              a stub createTransport without monkey-patching
//                              nodemailer.
//
// Per Global Constraint #9: alert_eval_interval_seconds has a 10-second floor.
// Per Global Constraint #8: matches createProbeLoop shape; inFlight guard;
//   setInterval-based; mounted in server.js normal-mode only.

import nodemailer from 'nodemailer';

export function maskPassword(cfg) {
  const masked = { ...cfg };
  if (masked.smtp_password) masked.smtp_password = '********';
  return masked;
}

export function nextAttemptDelay(attemptCount, initialSeconds) {
  return Math.min(3600, initialSeconds * Math.pow(2, attemptCount - 1));
}

export async function send(
  { smtp, from, to, cc, subject, text, html },
  _deps = {}
) {
  try {
    const createTransport = _deps.createTransport ?? nodemailer.createTransport;
    const transport = createTransport({
      host: smtp.smtp_host,
      port: smtp.smtp_port,
      secure: Boolean(smtp.smtp_secure),
      auth: smtp.smtp_user ? { user: smtp.smtp_user, pass: smtp.smtp_password } : undefined
    });
    await transport.sendMail({ from, to, cc, subject, text, html });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// ---------------------------------------------------------------------------
// createEmailDeliveryLoop — Task 11 factory
// ---------------------------------------------------------------------------
//
// createEmailDeliveryLoop({ db, getIntervalSeconds, getSystemConfig, sendImpl })
//   → { start, stop, tick, isRunning }
//
// sendImpl is an optional dependency override used by tests (real callers get
// the default `send` exported above). Both loops share the same start/stop/tick/
// isRunning shape so server.js can manage them with the same shutdown idiom.
//
// Per tick:
//   1. Read up to 25 pending rows (alert_email_outbox.listPending, cap=25).
//   2. For each row: read SMTP config from system_config, call send().
//   3. On success: alertOutbox.markSent (sets sent_at + clears last_error).
//   4. On failure: scheduleRetry — alertOutbox.markFailed with exponential
//      backoff (nextAttemptDelay capped at 1h). Once attempt_count reaches
//      alert_email_max_attempts, write a cooldown_skipped alert_event row
//      instead of scheduling another retry (and still bump attempt_count so
//      the row is visible as "exhausted" in the outbox table).
//
// Per Global Constraint #9: 10-second floor on the cadence (clamped both at
// start() and at the top of tick() so a misconfigured caller can't push the
// rate below the floor for a single evaluation).

const PENDING_LIMIT = 25;
const DEFAULT_INITIAL_BACKOFF_SECONDS = 30;
const DEFAULT_MAX_ATTEMPTS = 5;

// inFlight guard pattern (matches createProbeLoop at probe.js:111):
//   - setInterval callback captures the in-flight tick via `inFlight = tick().catch(...)`.
//   - stop() awaits the in-flight promise to drain so a slow tick doesn't get cut off.
//   - tick() itself has NO `if (inFlight) return;` re-entry guard; the setInterval callback
//     does not add one either. Two overlapping guards would silently swallow a slow tick
//     without surfacing it in logs. The natural setInterval cadence (>= 10s) plus the
//     drain-on-stop pattern are the contract. If a future requirement demands "skip the
//     next tick if the previous is still running", the guard belongs in tick() body —
//     not at the setInterval callback boundary.
export function createEmailDeliveryLoop({ db, getIntervalSeconds, getSystemConfig, sendImpl, _deps = {} }) {
  const sendFn = sendImpl || send;
  let interval = null;
  let inFlight = null;
  let running = false;

  async function listPending() {
    // alertOutbox.listPending is dialect-aware: MySQL uses `LIMIT ?` so the
    // caller passes the cap as a bound param; MSSQL uses `TOP n` which the
    // SQL helper interpolates as a safe integer. Detect shape so both work.
    const pendingSQL = db.sql.alertOutbox.listPending;
    const isFunction = typeof pendingSQL === 'function';
    const sql = isFunction ? pendingSQL(PENDING_LIMIT) : pendingSQL;
    const params = isFunction ? [] : [PENDING_LIMIT];
    const { rows } = await db.query(sql, params);
    return rows;
  }

  async function getSmtpCfg() {
    // Default to empty object so tests that don't supply SMTP config still
    // get a (failing) send attempt — the failure path is what's tested here.
    const cfg = await getSystemConfig();
    return cfg || {};
  }

  async function markSent(rowId) {
    // markSent SQL has [last_error_placeholder, id] so we pass [null, rowId].
    await db.execute(db.sql.alertOutbox.markSent, [null, rowId]);
  }

  async function markFailed(rowId, errorMessage, backoffSeconds) {
    // markFailed SQL has [last_error, id] — attempt_count is bumped inline.
    // If a non-zero backoff was provided, scheduleRetry sets next_attempt_at
    // separately so the loop can vary the backoff per attempt.
    await db.execute(db.sql.alertOutbox.markFailed, [errorMessage ?? 'unknown', rowId]);
    if (backoffSeconds && backoffSeconds > 0) {
      await db.execute(db.sql.alertOutbox.scheduleRetry, [backoffSeconds, rowId]);
    }
  }

  async function emitCooldownSkipped(row, errorMessage) {
    // rule_id=0 (synthetic) and hostname='' (no rule context — this is an
    // outbox retry exhaustion, not a per-rule firing). alert_events.insert
    // takes (rule_id, event, hostname, detail) after the Task 11 column-
    // order swap.
    await db.execute(db.sql.alertEvents.insert, [
      0,
      'cooldown_skipped',
      '',
      JSON.stringify({ outbox_id: row.id, error: errorMessage })
    ]);
  }

  async function scheduleRetry(row, errorMessage) {
    const cfg = await getSystemConfig();
    const maxAttempts = Number(cfg?.alert_email_max_attempts) || DEFAULT_MAX_ATTEMPTS;
    const initialSeconds = Number(cfg?.alert_email_initial_backoff_seconds) || DEFAULT_INITIAL_BACKOFF_SECONDS;
    const nextAttempt = Number(row.attempt_count || 0) + 1;

    if (nextAttempt >= maxAttempts) {
      // Cooldown exhausted: bump attempt_count to the cap so the row is
      // marked "exhausted", capture the error, and emit an audit-style
      // alert_event. We deliberately do NOT extend next_attempt_at — the
      // row stays in the outbox as a tombstone for operators to inspect.
      await markFailed(row.id, errorMessage ?? 'unknown', 0);
      await emitCooldownSkipped(row, errorMessage);
      return;
    }

    const backoffSeconds = nextAttemptDelay(nextAttempt, initialSeconds);
    await markFailed(row.id, errorMessage ?? 'unknown', backoffSeconds);
  }

  async function deliver(row) {
    // Pre-flight: if the NEXT attempt (current + 1) would reach
    // alert_email_max_attempts, treat the row as exhausted. Burn no more
    // retries on it — emit a cooldown_skipped audit event so the operator
    // sees why delivery stopped. Read system_config once per row.
    let cfg = {};
    try { cfg = await getSystemConfig(); } catch { /* keep empty */ }
    const maxAttempts = Number(cfg?.alert_email_max_attempts) || DEFAULT_MAX_ATTEMPTS;
    if (Number(row.attempt_count || 0) + 1 >= maxAttempts) {
      await emitCooldownSkipped(row, row.last_error || 'max attempts reached');
      // Also bump attempt_count so the row stays visible as exhausted.
      await markFailed(row.id, row.last_error || 'max attempts reached', 0);
      return;
    }

    let smtp;
    try {
      smtp = await getSmtpCfg();
    } catch (err) {
      await scheduleRetry(row, `config read failed: ${err.message}`);
      return;
    }
    if (!smtp.smtp_host) {
      // No SMTP configured — treat as a config error so the row gets
      // attempt_count + last_error captured for the operator (rather than
      // burning retries on a permanently-broken delivery).
      await scheduleRetry(row, 'smtp_host not configured');
      return;
    }
    let result;
    try {
      result = await sendFn({
        smtp,
        from: smtp.smtp_from,
        to: row.to_addrs,
        cc: row.cc_addrs,
        subject: row.subject,
        text: row.body_text,
        html: row.body_html
      }, _deps);
    } catch (err) {
      // send() already catches its own errors, but defensive try/catch
      // here means a thrown dependency (e.g. nodemailer import failure)
      // still flows through the retry path.
      await scheduleRetry(row, err.message);
      return;
    }
    if (result?.ok) {
      await markSent(row.id);
    } else {
      await scheduleRetry(row, result?.error || 'send failed');
    }
  }

  async function tick() {
    let rows;
    try {
      rows = await listPending();
    } catch (err) {
      console.error('[email-outbox] listPending failed:', err.message);
      return;
    }
    for (const row of rows) {
      try {
        await deliver(row);
      } catch (err) {
        // Per-row failure must not abort the rest of the batch — one bad
        // outbox row's data corruption can't starve the others.
        console.error('[email-outbox] deliver failed for outbox id', row.id, ':', err.message);
      }
    }
  }

  function start() {
    if (running) return;
    // Mark running SYNCHRONOUSLY so isRunning() is correct immediately
    // after start() returns (matches the AlertEvaluationLoop fix in T11).
    running = true;
    Promise.resolve(getIntervalSeconds()).then((raw) => {
      if (!running) return; // stop() fired before getIntervalSeconds resolved
      const intervalSec = Math.max(10, Number(raw) || 60);
      interval = setInterval(() => {
        inFlight = tick().catch((e) => console.error('[email-outbox] tick failed:', e.message));
      }, intervalSec * 1000);
    }).catch((e) => console.error('[email-outbox] start failed:', e.message));
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