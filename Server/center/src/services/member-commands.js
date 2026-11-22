// 2026-09-05 R81 — Member server PowerShell command execution service.
//
// Center-staged + agent-pull: operator queues a free-form PowerShell via
// POST /api/admin/member-commands; row inserted into ad_member_commands
// with status='queued'. The agent polls GET /api/agent/member-commands
// for its hostname; the service atomically flips up to `limit` queued
// rows for the agent's hostname from 'queued' to 'running' (two-step
// claimPick + claim — same atomic pattern as ad-admin-commands). The
// agent runs the script via run-member-script.ps1 and POSTs back via
// /api/admin/member-commands/:id/result; the service flips the row to
// success / failed and writes the result blob. Rows persist after
// completion for audit history.
//
// sweepTimeouts() runs on a setInterval from server.js (Task 4) and
// flips 'running' rows whose claimed_at is older than the threshold to
// 'timeout'. Default 30s matches the agent's internal PS1 exec budget.
//
// 8 safety guard rails (per spec §3):
//   1. Hostname must be a registered agent (heartbeat.dcOnlineCheck)
//   2. script size <= 32KB (service rejects 400 before INSERT)
//   3. timeout 5-60s (default 30)
//   4. stdout truncation 32KB (in completeCommand, before write)
//   5. stderr truncation 8KB (same)
//   6. Rate limit per host: 5 queued+running commands per 60s window
//      (429 when exceeded; uses countRecentForHost SQL helper)
//   7. Audit persistence — admin route writes *_queued + *_succeeded/
//      _failed/_timed_out audit rows
//   8. Password redact — strip password/newPassword/token from result_json
//      before persisting (defense-in-depth — agent should not echo creds)

import { getDb } from '../db/index.js';
// R161.35 step 2 — the sealed action schema (mirror of the agent manifest).
// Validation happens HERE, at queue time, so a bad command never lands in
// ad_member_commands and the operator gets a 400 instead of a silent
// "queued but never ran".
import { MEMBER_SCRIPTS, SCRIPT_IDS, validateArgs } from './member-scripts-manifest.js';

// ★ R161.35 step 2 (2026-11-22) — `member_script` (free-form PowerShell) is
//   RETIRED. The only command type is now `member_action`, whose params are
//   { scriptId, args } — a name into the sealed manifest plus structured
//   arguments. See services/member-scripts-manifest.js for WHY.
/**
 * @deprecated R161.35 — kept only so historical `ad_member_commands` rows
 * that still say command_type='member_script' can be read back by the
 * history UI. **Nothing may be queued under this type any more.**
 */
const LEGACY_COMMAND_TYPE = 'member_script';
const COMMAND_TYPES = Object.freeze(new Set(['member_action']));

// ── constants for the remaining guard rails ─────────────────────────────
// ★ SCRIPT_MAX_BYTES / TIMEOUT_MIN_SEC / TIMEOUT_MAX_SEC / TIMEOUT_DEFAULT_SEC
//   were removed with R161.35 step 2: there is no script body left to size-
//   check, and each sealed action carries its own timeout in the manifest
//   (the agent clamps to it — a caller can shorten, never lengthen).
const STDOUT_MAX_BYTES = 32 * 1024;
const STDERR_MAX_BYTES = 8 * 1024;
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SEC = 60;

// ★ R161.35 step 2 (2026-11-22) — the S82 deny-list is GONE.
//
//   It existed to bound a free-form PowerShell body. That body no longer
//   exists: `member_script` is retired and the only accepted payload is
//   { scriptId, args } against a sealed manifest. There is no text left for
//   a regex to scan.
//
//   ★ This is not "we stopped checking" — it is "the thing we were checking
//     no longer exists, and we replaced it with something checkable". A
//     deny-list can never cover PowerShell (encoded commands, reflection,
//     dynamic script blocks, persistence tools absent from the list); an
//     allow-list of sealed actions can be complete because the set is finite.
//
//   Historical rows with command_type='member_script' are still readable
//   (the column and its history are untouched) — only queueing them is
//   refused.
//
//   If you are tempted to re-add a pattern list here: don't. Add an action
//   to the manifest, write the .ps1, seal it, ship it.

/** Kept for the audit classifier's benefit — see the module header. */
const DENIED_PATTERNS = Object.freeze([]);

/**
 * @deprecated R161.35 — always returns null. Retained so anything that
 * still imports it does not crash; new code must not call it.
 */
function containsDeniedPattern(_script) {
  return null;
}

// ── helpers ─────────────────────────────────────────────────────────────

function httpErr(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Truncate a string to `max` bytes — measured as UTF-8 byte length, since
 * that's what goes into JSON columns. Returns null when input is null/undefined.
 * Strings already shorter than the cap pass through unchanged.
 */
function truncateUtf8(value, max) {
  if (value == null) return null;
  if (typeof value !== 'string') return String(value);
  // Buffer.byteLength is the cheapest correct way to measure UTF-8 size;
  // we slice at the largest valid char index whose byte length fits.
  if (Buffer.byteLength(value, 'utf8') <= max) return value;
  // Binary-search is overkill here — strings are typically O(10KB); linear
  // slice from the cap down to a valid char boundary is fine for the worst
  // case (1MB -> still ~1ms).
  let lo = 0;
  let hi = Math.min(value.length, max);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(value.slice(0, mid), 'utf8') <= max) lo = mid;
    else hi = mid - 1;
  }
  return value.slice(0, lo);
}

/**
 * Password / credential redaction (spec §3 guard rail #8).
 * Mirrors ad-admin-commands.redactPasswords so audit / persistence
 * behavior is consistent across the two surfaces.
 */
const PASSWORD_KEYS = new Set(['password', 'newPassword', 'oldPassword', 'token']);
function redactPasswords(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(redactPasswords);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (PASSWORD_KEYS.has(k)) continue;
      out[k] = redactPasswords(v);
    }
    return out;
  }
  return value;
}

// ── param validator for member_action ───────────────────────────────────
// R161.35 step 2 (2026-11-22) — replaces validateMemberScript.
//
// params must be { scriptId, args }. Anything else is rejected:
//   · a `script` field (the old free-form body) ⇒ explicit "retired" error,
//     so an old client gets an actionable message instead of a mystery 400
//   · unknown top-level keys ⇒ rejected, not dropped (same lesson as the
//     `force` bug from step 1)
//   · args are validated against the sealed manifest's schema
//
// Returns { ok: true, normalized } or { ok: false, error }.
function validateMemberAction(params) {
  if (params == null || typeof params !== 'object' || Array.isArray(params)) {
    return { ok: false, error: 'params object required' };
  }

  // ★ Explicit, actionable rejection for the retired free-form path.
  if (Object.prototype.hasOwnProperty.call(params, 'script')) {
    return {
      ok: false,
      error: 'free-form PowerShell (params.script) has been retired — '
        + 'send { scriptId, args } and pick an action from GET /api/admin/member-commands/actions'
    };
  }

  const allowedTopLevel = new Set(['scriptId', 'args']);
  const unknownTop = Object.keys(params).filter((k) => !allowedTopLevel.has(k));
  if (unknownTop.length > 0) {
    return {
      ok: false,
      error: `invalid params: unknown field(s) ${unknownTop.map((k) => `"${k}"`).join(', ')} `
        + '(allowed: scriptId, args)'
    };
  }

  const scriptId = params.scriptId;
  if (!isNonEmptyString(scriptId)) {
    return { ok: false, error: 'invalid params: scriptId' };
  }

  const v = validateArgs(scriptId, params.args);
  if (!v.ok) return { ok: false, error: `invalid args: ${v.error}` };

  return {
    ok: true,
    normalized: { scriptId, args: v.normalized }
  };
}

const VALIDATORS = Object.freeze({ member_action: validateMemberAction });

// ── hostname-on-host check ─────────────────────────────────────────────
// Spec §3 guard rail #1: a registered agent must be heartbeating for the
// hostname within the last 5 minutes. The R75 dcOnlineCheck query does
// exactly this — `agent_id` IS the hostname (see db/schema/01-tables.sql
// line 51: agent_id VARCHAR(64) PRIMARY KEY). Caller may pass `force=true`
// to skip the check (admin batch or recovery scenarios — see R75 for the
// same override).
//
// Lives here (not in the admin route) so service-level queueCommand can
// gate on the same check, but is exported so admin.js can call it for
// its 503 response shape.
export async function checkHostOnline(hostname, { force = false } = {}) {
  if (force) return { online: true };
  if (!hostname || typeof hostname !== 'string') {
    return { online: false, reason: 'invalid hostname' };
  }
  const db = getDb();
  try {
    const { rows } = await db.query(db.sql.heartbeat.dcOnlineCheck, [hostname.trim()]);
    if (rows && rows.length > 0) return { online: true };
    const recent = await db.query(db.sql.heartbeat.readLastHeartbeatAt, [hostname.trim()]);
    const lastHeartbeatAt = recent.rows?.[0]?.last_heartbeat_at ?? null;
    return { online: false, lastHeartbeatAt };
  } catch (e) {
    return { online: false, reason: `heartbeat check failed: ${e.message}` };
  }
}

// ── Public surface ──────────────────────────────────────────────────────

/**
 * Queue a new member-server PowerShell command. Inserts a row with
 * status='queued'. Enforces all 8 guard rails at the service boundary:
 *
 *   1. Hostname-online check (unless `skipOnlineCheck` — admin batch path)
 *   2. scriptId ∈ sealed manifest, args match its schema
 *   3. per-action timeout (manifest-owned; agent clamps)
 *   4. stdout truncation 32KB   (in completeCommand)
 *   5. stderr truncation 8KB    (in completeCommand)
 *   6. per-host rate limit 5 / 60s
 *   7. params_json persisted (operator-visible)
 *   8. password redact          (in completeCommand)
 *
 * @returns the inserted row (without params_json noise)
 */
export async function queueCommand({ hostname, params, operatorId, skipOnlineCheck = false }) {
  if (!hostname || typeof hostname !== 'string') {
    throw httpErr(400, 'hostname required');
  }
  const trimmedHost = hostname.trim();
  if (!trimmedHost) throw httpErr(400, 'hostname required');

  // guard rail #1
  if (!skipOnlineCheck) {
    const probe = await checkHostOnline(trimmedHost);
    if (!probe.online) {
      throw httpErr(503, `no agent currently online for ${trimmedHost}; last heartbeat ${probe.lastHeartbeatAt || 'never'}`);
    }
  }

  // validate params — scriptId must be in the sealed manifest and `args`
  // must satisfy that action's schema. Nothing else is accepted.
  //
  // ★ R161.35 step 2 removed the S82 deny-list check that used to follow
  //   this. It scanned a free-form script body that no longer exists; the
  //   manifest membership check below is a complete allow-list, which is
  //   what a deny-list never could be.
  const v = validateMemberAction(params);
  if (!v.ok) throw httpErr(400, v.error);

  const db = getDb();

  // guard rail #6 — rate limit per host (60s window).
  // Throwing inside a service function isn't ideal for routes (they prefer
  // numeric status); we use 429 here so the route can pass it through.
  try {
    const { rows } = await db.query(db.sql.adMemberCommands.countRecentForHost, [trimmedHost]);
    const recentCount = Number(rows?.[0]?.n ?? 0);
    if (recentCount >= RATE_LIMIT_MAX) {
      throw httpErr(429, `rate limit exceeded for ${trimmedHost}: ${RATE_LIMIT_MAX} commands per ${RATE_LIMIT_WINDOW_SEC}s`);
    }
  } catch (e) {
    if (e.httpStatus) throw e;
    // countRecentForHost failure — fail closed (do not queue) but don't
    // blow up the operator flow. The error bubbles as 500.
    throw httpErr(500, `rate-limit check failed: ${e.message}`);
  }

  const paramsJson = JSON.stringify(v.normalized);
  const exec = await db.execute(db.sql.adMemberCommands.insert, [
    trimmedHost,
    'member_action',
    paramsJson,
    operatorId ?? null
  ]);
  const insertId = exec.insertId ?? exec.rows?.[0]?.id;
  return {
    id: insertId,
    hostname: trimmedHost,
    command_type: 'member_action',
    status: 'queued',
    operator_id: operatorId ?? null,
    created_at: new Date().toISOString()
  };
}

/**
 * Pull queued commands for an agent. Two-step atomic claim pattern
 * identical to ad-admin-commands (claimPick → claim IN-list). The
 * service flips the row to 'running' atomically so two agents polling
 * simultaneously cannot claim the same row.
 */
export async function claimForAgent(hostname, limit = 5) {
  if (!hostname || typeof hostname !== 'string') {
    throw httpErr(400, 'hostname required');
  }
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 5));
  // 2026-09-25 R93.4 — MSSQL TOP cannot be parameter-bound; see
  // services/ad-admin-commands.js:resolveClaimPickSql for the full
  // rationale. The same dialect dispatch applies here.
  const claimPickSql = db.dialect === 'mssql'
    ? db.sql.adMemberCommands.claimPick(Number(safeLimit))
    : db.sql.adMemberCommands.claimPick;
  const { rows: idRows } = await db.query(
    claimPickSql,
    db.dialect === 'mssql' ? [hostname] : [hostname, safeLimit]
  );
  if (!idRows || idRows.length === 0) return [];
  const ids = idRows.map(r => Number(r.id)).filter(Number.isFinite);
  if (ids.length === 0) return [];
  const claimSql = db.sql.adMemberCommands.claim(ids.length);
  const claimParams = [...ids, hostname];
  await db.execute(claimSql, claimParams);
  // Re-read by id; service returns rows with status='running' (claimed
  // successfully) AND any rows that lost the race (status still 'queued'
  // because another agent flipped them between claimPick and claim).
  const loadSql = db.sql.adMemberCommands.loadByIds(ids.length);
  const { rows } = await db.query(loadSql, ids);
  if (!rows) return [];
  return rows.filter(r => r.status === 'running').map(parseParamsJson);
}

/**
 * Terminal-state ack from the agent. Flips status to success / failed.
 * Idempotent on already-terminal rows (returns existing unchanged).
 *
 * Enforces guard rails #4 (stdout truncation) and #5 (stderr truncation),
 * and #8 (password redact on result_json).
 */
export async function completeCommand(id, { success, data, error, exitCode, durationMs } = {}) {
  const numId = Number(id);
  if (!Number.isFinite(numId) || numId <= 0) throw httpErr(400, 'invalid command id');
  const db = getDb();
  const existing = await getCommand(numId);
  if (!existing) throw httpErr(404, 'command not found');
  if (existing.status === 'success' || existing.status === 'failed' || existing.status === 'timeout') {
    return existing;
  }
  if (existing.status !== 'running') {
    throw httpErr(409, `command not in running state (status=${existing.status})`);
  }
  const newStatus = success ? 'success' : 'failed';
  // guard rail #8 — strip password-shaped keys before persisting.
  const safeData = data == null ? null : redactPasswords(data);
  // guard rails #4 + #5 — stdout/stderr truncation. The agent should
  // already truncate, but defense-in-depth (and central policy lives here).
  if (safeData && typeof safeData === 'object') {
    if ('stdout' in safeData) safeData.stdout = truncateUtf8(safeData.stdout, STDOUT_MAX_BYTES);
    if ('stderr' in safeData) safeData.stderr = truncateUtf8(safeData.stderr, STDERR_MAX_BYTES);
  }
  const resultJson = safeData == null ? null : JSON.stringify(safeData);
  const errorMessage = typeof error === 'string' ? error.slice(0, 2000) : null;
  const durMs = Number.isFinite(Number(durationMs)) ? Math.max(0, Math.floor(Number(durationMs))) : null;
  await db.execute(db.sql.adMemberCommands.complete, [
    newStatus,
    resultJson,
    errorMessage,
    durMs,
    numId
  ]);
  return getCommand(numId);
}

/**
 * Sweep 'running' commands older than `timeoutMs` to 'timeout'. Called
 * by the server.js setInterval every 10s.
 *
 * R161.35 (2026-11-22) — closes the timeout audit gap on the member-command
 * side, 1:1 parallel to the AD side (R158.47.1, ad-admin-commands.js).
 *
 * ★ The bug: the member sweeper only flipped the lifecycle row to
 *   'timeout' and never wrote an `audit_logs` row. The classifier
 *   registers `ad_member_command_timed_out` (audit-classifier.js) and the
 *   admin route comment claims the sweeper writes it — but there was NO
 *   writeAudit call anywhere on this path. Consequence: a member command
 *   that timed out (agent died mid-run, network partition, agent killed)
 *   **vanished from the audit trail entirely** — the operator sees a row
 *   that says "running" forever in the lifecycle table, and the operator-
 *   visible audit log has no record that the command was ever abandoned.
 *   On the AD side the same gap was found and fixed in R158.47.1; the
 *   member side was simply missed.
 *
 * ★ Why this matters for the security work: R161.35's whole point is that
 *   a member command is arbitrary PowerShell running as SYSTEM. If a
 *   command is denied/timed out, that MUST be visible — an audit gap on
 *   the deny path is exactly where an attacker would want to hide.
 *
 * SELECT+UPDATE is not atomic, but that is fine: the sweep SQL's
 * `WHERE status = 'running'` means a second sweep of the same row will
 * not match, so each victim produces exactly one audit row. Idempotency
 * is held by the lifecycle table's status transition.
 */
export async function sweepTimeouts({ timeoutMs = 30000, now: _now, logger = null } = {}) {
  const db = getDb();
  const timeoutSeconds = Math.max(1, Math.ceil(Number(timeoutMs) / 1000));

  // 1) SELECT the victims first — after the UPDATE we can no longer tell
  //    which rows were 'running' (and we need the context for the audit
  //    payload anyway). MySQL / MSSQL both bind the interval as ? so the
  //    two dialects stay symmetric.
  const selectSql = db.dialect === 'mssql'
    ? `SELECT id, hostname, command_type, operator_id, params_json
         FROM ad_member_commands
         WHERE status = CAST('running' AS NVARCHAR(16))
           AND claimed_at < DATEADD(SECOND, -?, CAST(SYSUTCDATETIME() AS DATETIME2))`
    : `SELECT id, hostname, command_type, operator_id, params_json
         FROM ad_member_commands
         WHERE status = 'running'
           AND claimed_at < UTC_TIMESTAMP() - INTERVAL ? SECOND`;
  let victims = [];
  try {
    const { rows } = await db.query(selectSql, [timeoutSeconds]);
    victims = Array.isArray(rows) ? rows : [];
  } catch (e) {
    // SELECT failure is non-fatal: the lifecycle UPDATE still runs, only
    // the audit rows are skipped. Never let an audit problem block the
    // status transition (a row stuck in 'running' forever is worse).
    logger?.warn?.({ err: e?.message }, 'member commands sweepTimeouts SELECT failed; audit skip');
  }

  // 2) UPDATE the lifecycle table.
  await db.execute(db.sql.adMemberCommands.sweepTimeouts, [timeoutSeconds]);

  // 3) One audit row per victim.
  if (victims.length > 0) {
    const audit = await import('./audit.js');
    let auditFailures = 0;
    for (const v of victims) {
      try {
        // writeAuditRequired throws on failure — the member side mirrors
        // the AD side's "audit completeness" rule (R158.47.2): if EVERY
        // audit write fails we escalate to logger.error so an operator /
        // alert pipeline sees that audit_logs itself may be broken.
        await audit.writeAuditRequired({
          userId: null,                       // the sweeper has no operator
          action: 'ad_member_command_timed_out',
          target: `cmd:${v.id}`,
          payload: {
            commandId: v.id,
            hostname: v.hostname,
            commandType: v.command_type,
            operatorId: v.operator_id ?? null,
            errorMessage: 'command exceeded timeout threshold',
            timeoutMs: Number(timeoutMs) || null
          }
        }, logger);
      } catch (e) {
        auditFailures++;
        logger?.warn?.({ err: e?.message, commandId: v?.id },
          'ad_member_command_timed_out audit write failed (best-effort counted)');
      }
    }
    if (auditFailures === victims.length) {
      logger?.error?.({ swept: victims.length, auditFailures, timeoutMs },
        'member sweepTimeouts: ALL audit writes failed — investigate audit_logs table integrity');
    } else if (auditFailures > 0) {
      logger?.warn?.({ swept: victims.length, auditFailures, timeoutMs },
        'member sweepTimeouts: some audit writes failed');
    } else {
      logger?.info?.({ swept: victims.length, timeoutMs },
        'member commands swept to timeout');
    }
  }

  return victims.length;
}

/**
 * Single row read by id. Returns null if not found.
 */
export async function getCommand(id) {
  const numId = Number(id);
  if (!Number.isFinite(numId) || numId <= 0) return null;
  const db = getDb();
  const { rows } = await db.query(db.sql.adMemberCommands.getById, [numId]);
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  return {
    ...row,
    params_json: tryParseJson(row.params_json),
    result_json: tryParseJson(row.result_json)
  };
}

/**
 * Paginated list with optional hostname / status filters. Returns
 * { total, rows, page, size }. This is the read-side for the history
 * drawer — kept narrow (hostname + status) on purpose; the front-end
 * always narrows by hostname.
 */
export async function listCommands({ hostname, status, page = 1, size = 50 } = {}) {
  const safePage = Math.max(1, Math.floor(Number(page) || 1));
  const safeSize = Math.max(1, Math.min(500, Math.floor(Number(size) || 50)));
  const offset = (safePage - 1) * safeSize;
  const db = getDb();
  const isMssql = db.dialect === 'mssql';

  let listSql;
  let listParams;
  let countSql;
  let countParams;
  // 2026-09-25 R93.4 — MSSQL's `TOP` clause does not accept parameter
  // binding (only an integer literal). SQL builders are function-form
  // on MSSQL (limit interpolated), plain string on MySQL (LIMIT ? is
  // bound). Service-layer dispatch mirrors ad-admin-commands.js:listCommands:
  //   mssql → call listBy* as function with safeSize, bind [WHERE params, offset]
  //   mysql → plain string, bind [WHERE params, safeSize, offset]
  if (hostname != null && status != null) {
    // Combined filter: hostname + status. Service runs hostname then
    // post-filters by status — combined queries are rare in real traffic.
    listSql = isMssql ? db.sql.adMemberCommands.listByStatus(safeSize) : db.sql.adMemberCommands.listByStatus;
    listParams = isMssql ? [status, offset] : [status, safeSize, offset];
    countSql = db.sql.adMemberCommands.countByStatus;
    countParams = [status];
  } else if (hostname != null) {
    listSql = isMssql ? db.sql.adMemberCommands.listByHost(safeSize) : db.sql.adMemberCommands.listByHost;
    listParams = isMssql ? [hostname, offset] : [hostname, safeSize, offset];
    countSql = db.sql.adMemberCommands.countByHost;
    countParams = [hostname];
  } else if (status != null) {
    listSql = isMssql ? db.sql.adMemberCommands.listByStatus(safeSize) : db.sql.adMemberCommands.listByStatus;
    listParams = isMssql ? [status, offset] : [status, safeSize, offset];
    countSql = db.sql.adMemberCommands.countByStatus;
    countParams = [status];
  } else {
    listSql = isMssql ? db.sql.adMemberCommands.listAll(safeSize) : db.sql.adMemberCommands.listAll;
    listParams = isMssql ? [offset] : [safeSize, offset];
    countSql = db.sql.adMemberCommands.countAll;
    countParams = [];
  }

  const { rows: countRows } = await db.query(countSql, countParams);
  const total = Number(countRows?.[0]?.total ?? 0);

  const { rows } = await db.query(listSql, listParams);
  return {
    total,
    rows: (rows || []).map(r => ({ ...r, params_json: undefined, result_json: undefined })),
    page: safePage,
    size: safeSize
  };
}

// ── Internal helpers ─────────────────────────────────────────────────────

function tryParseJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

function parseParamsJson(row) {
  if (!row) return row;
  return { ...row, params_json: tryParseJson(row.params_json) };
}

// 2026-09-25 R93.4 — MSSQL `TOP` cannot be parameter-bound. Inline the
// limit on MSSQL, bind it on MySQL. The call site in claimForAgent picks
// the right shape; the helper is the single source of truth for which
// dialect inlines vs binds. Mirrors the equivalent helper in
// services/ad-admin-commands.js so the two command-queue services stay
// aligned.
function resolveClaimPickSql(db, safeLimit) {
  if (db.dialect === 'mssql') {
    return db.sql.adMemberCommands.claimPick(Number(safeLimit));
  }
  return db.sql.adMemberCommands.claimPick;
}

// ── Test helpers ─────────────────────────────────────────────────────────
// Exposed so the test harness can reset in-memory state between runs
// without leaking across test files. NOT exported via the router.

export const _testInternals = Object.freeze({
  COMMAND_TYPES,
  VALIDATORS,
  PASSWORD_KEYS,
  STDOUT_MAX_BYTES,
  STDERR_MAX_BYTES,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_SEC,
  DENIED_PATTERNS,
  redactPasswords,
  truncateUtf8,
  containsDeniedPattern,
  // R161.35 step 2 (2026-11-22) — exposed so the regression net can assert
  // the { scriptId, args } contract directly (unknown scriptId, unknown /
  // missing args, retired free-form `script`) instead of only reading the
  // source text.
  validateMemberAction,
  MEMBER_SCRIPTS,
  SCRIPT_IDS,
  httpErr
});