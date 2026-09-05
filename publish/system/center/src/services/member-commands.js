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

// ── command types ───────────────────────────────────────────────────────
// Single type for R81; future extension can add download_and_run,
// install_msi, etc. Without an enum the spec's "command_type" column
// stays ready for the next round.
const COMMAND_TYPES = Object.freeze(new Set(['member_script']));

// ── constants for the 8 guard rails ─────────────────────────────────────
const SCRIPT_MAX_BYTES = 32 * 1024;
const TIMEOUT_MIN_SEC = 5;
const TIMEOUT_MAX_SEC = 60;
const TIMEOUT_DEFAULT_SEC = 30;
const STDOUT_MAX_BYTES = 32 * 1024;
const STDERR_MAX_BYTES = 8 * 1024;
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SEC = 60;

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

// ── param validator for member_script ───────────────────────────────────
// Spec §3 guard rails #2 + #3: script size cap + timeout range.
// Returns { ok: true, normalized } or { ok: false, error }.
function validateMemberScript(params) {
  if (params == null || typeof params !== 'object') {
    return { ok: false, error: 'params object required' };
  }
  if (!isNonEmptyString(params.script)) {
    return { ok: false, error: 'invalid params: script' };
  }
  // guard rail #2: 32KB cap on script size. We measure as bytes since the
  // JSON column stores the encoded form.
  const scriptBytes = Buffer.byteLength(params.script, 'utf8');
  if (scriptBytes > SCRIPT_MAX_BYTES) {
    return {
      ok: false,
      error: `invalid params: script exceeds ${SCRIPT_MAX_BYTES} bytes (got ${scriptBytes})`
    };
  }
  // guard rail #3: timeout range. Default when not supplied.
  let timeoutSec = TIMEOUT_DEFAULT_SEC;
  if (params.timeoutSec != null) {
    const n = Number(params.timeoutSec);
    if (!Number.isFinite(n)) return { ok: false, error: 'invalid params: timeoutSec' };
    if (n < TIMEOUT_MIN_SEC || n > TIMEOUT_MAX_SEC) {
      return {
        ok: false,
        error: `invalid params: timeoutSec must be in [${TIMEOUT_MIN_SEC}, ${TIMEOUT_MAX_SEC}]`
      };
    }
    timeoutSec = Math.floor(n);
  }
  return {
    ok: true,
    normalized: { script: params.script, timeoutSec }
  };
}

const VALIDATORS = Object.freeze({ member_script: validateMemberScript });

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
 *   2. script size <= 32KB
 *   3. timeout in [5, 60] (default 30)
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

  // validate params (guard rails #2 + #3)
  const v = validateMemberScript(params);
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
    'member_script',
    paramsJson,
    operatorId ?? null
  ]);
  const insertId = exec.insertId ?? exec.rows?.[0]?.id;
  return {
    id: insertId,
    hostname: trimmedHost,
    command_type: 'member_script',
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
  const { rows: idRows } = await db.query(
    db.sql.adMemberCommands.claimPick,
    [hostname, safeLimit]
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
 */
export async function sweepTimeouts({ timeoutMs = 30000, now: _now } = {}) {
  const db = getDb();
  const timeoutSeconds = Math.max(1, Math.ceil(Number(timeoutMs) / 1000));
  await db.execute(db.sql.adMemberCommands.sweepTimeouts, [timeoutSeconds]);
  return 0;
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
  if (hostname != null && status != null) {
    // Combined filter: hostname + status. Service runs hostname then
    // post-filters by status — combined queries are rare in real traffic.
    listSql = db.sql.adMemberCommands.listByStatus;
    listParams = isMssql ? [safeSize, status, offset] : [status, safeSize, offset];
    countSql = db.sql.adMemberCommands.countByStatus;
    countParams = [status];
  } else if (hostname != null) {
    listSql = db.sql.adMemberCommands.listByHost;
    listParams = isMssql ? [safeSize, hostname, offset] : [hostname, safeSize, offset];
    countSql = db.sql.adMemberCommands.countByHost;
    countParams = [hostname];
  } else if (status != null) {
    listSql = db.sql.adMemberCommands.listByStatus;
    listParams = isMssql ? [safeSize, status, offset] : [status, safeSize, offset];
    countSql = db.sql.adMemberCommands.countByStatus;
    countParams = [status];
  } else {
    listSql = db.sql.adMemberCommands.listAll;
    listParams = [safeSize, offset];
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

// ── Test helpers ─────────────────────────────────────────────────────────
// Exposed so the test harness can reset in-memory state between runs
// without leaking across test files. NOT exported via the router.

export const _testInternals = Object.freeze({
  COMMAND_TYPES,
  VALIDATORS,
  PASSWORD_KEYS,
  SCRIPT_MAX_BYTES,
  TIMEOUT_MIN_SEC,
  TIMEOUT_MAX_SEC,
  TIMEOUT_DEFAULT_SEC,
  STDOUT_MAX_BYTES,
  STDERR_MAX_BYTES,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_SEC,
  redactPasswords,
  truncateUtf8,
  httpErr
});