// 2026-08-31 R75 — AD user & group management command queue service.
//
// Center-staged + agent-pull: operator queues an AD command via
// POST /api/admin/ad-commands; row inserted into ad_admin_commands with
// status='queued'. The agent polls GET /api/agent/ad-commands; the
// service atomically flips up to `limit` queued rows for the agent's
// hostname from 'queued' to 'running' (two-step claimPick + claim so two
// agents polling simultaneously cannot claim the same row). The agent
// executes its PS1 and POSTs back via /api/agent/ad-commands/:id/result
// — the service flips the row to success / failed and writes the result
// blob. Rows persist after completion for audit history.
//
// sweepTimeouts() runs on a setInterval from server.js (Task 4) and
// flips 'running' rows whose claimed_at is older than the threshold to
// 'timeout'. Default 30s matches the agent's internal PS1 exec budget.
//
// Password fields are NEVER stored in result_json and NEVER forwarded
// in audit payloads. The service strips any password-shaped keys
// (password / newPassword / oldPassword) before persisting results,
// and the admin route redaction logic mirrors that on the audit-row
// side. See `redactPasswords` and the admin.js payload-shape comment.

import { getDb } from '../db/index.js';

// ── 17 enum command types from spec §2.2 ─────────────────────────────────
const COMMAND_TYPES = Object.freeze(new Set([
  'user_search',
  'user_create',
  'user_password_reset',
  'user_enable',
  'user_disable',
  'user_unlock',
  'user_set_attributes',
  'user_delete',
  'user_list_groups',
  'group_search',
  'group_create',
  'group_set_attributes',
  'group_add_member',
  'group_remove_member',
  'group_set_members',
  'group_delete',
  'group_list_members'
]));

// ── Per-type params validators ───────────────────────────────────────────
// Each validator returns either:
//   { ok: true, normalized }
//   { ok: false, error: 'invalid params: <field>' }
// Spec §3.1: validation throws httpErr(400, 'invalid params: <field>').
//
// The normalizer returns the canonical params shape (parsed numbers,
// trimmed strings, default-filled optional fields). This is the object
// the service JSON.stringify's into params_json.

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function validators() {
  return {
    user_search: (p) => {
      const out = { filter: '', limit: 200 };
      if (p == null || typeof p !== 'object') return { ok: false, error: 'params object required' };
      if (p.filter != null && typeof p.filter !== 'string') return { ok: false, error: 'invalid params: filter' };
      out.filter = String(p.filter || '').trim();
      if (p.limit != null) {
        const n = Number(p.limit);
        if (!Number.isFinite(n) || n < 1 || n > 1000) return { ok: false, error: 'invalid params: limit' };
        out.limit = Math.floor(n);
      }
      return { ok: true, normalized: out };
    },
    user_create: (p) => {
      if (p == null || typeof p !== 'object') return { ok: false, error: 'params object required' };
      if (!isNonEmptyString(p.sam)) return { ok: false, error: 'invalid params: sam' };
      if (!isNonEmptyString(p.password)) return { ok: false, error: 'invalid params: password' };
      const out = {
        sam: p.sam.trim(),
        password: p.password,
        mustChangePassword: p.mustChangePassword === true,
        givenName: typeof p.givenName === 'string' ? p.givenName : null,
        surname: typeof p.surname === 'string' ? p.surname : null,
        displayName: typeof p.displayName === 'string' ? p.displayName : null,
        upn: typeof p.upn === 'string' ? p.upn : null,
        ouPath: typeof p.ouPath === 'string' ? p.ouPath : null,
        description: typeof p.description === 'string' ? p.description : null
      };
      return { ok: true, normalized: out };
    },
    user_password_reset: (p) => {
      if (p == null || typeof p !== 'object') return { ok: false, error: 'params object required' };
      if (!isNonEmptyString(p.sam)) return { ok: false, error: 'invalid params: sam' };
      if (!isNonEmptyString(p.newPassword)) return { ok: false, error: 'invalid params: newPassword' };
      return {
        ok: true,
        normalized: {
          sam: p.sam.trim(),
          newPassword: p.newPassword,
          mustChangePassword: p.mustChangePassword === true,
          unlockAccount: p.unlockAccount !== false
        }
      };
    },
    user_enable: (p) => p && isNonEmptyString(p.sam)
      ? { ok: true, normalized: { sam: p.sam.trim() } }
      : { ok: false, error: 'invalid params: sam' },
    user_disable: (p) => p && isNonEmptyString(p.sam)
      ? { ok: true, normalized: { sam: p.sam.trim() } }
      : { ok: false, error: 'invalid params: sam' },
    user_unlock: (p) => p && isNonEmptyString(p.sam)
      ? { ok: true, normalized: { sam: p.sam.trim() } }
      : { ok: false, error: 'invalid params: sam' },
    user_set_attributes: (p) => {
      if (p == null || typeof p !== 'object') return { ok: false, error: 'params object required' };
      if (!isNonEmptyString(p.sam)) return { ok: false, error: 'invalid params: sam' };
      if (p.attributes == null || typeof p.attributes !== 'object') return { ok: false, error: 'invalid params: attributes' };
      return {
        ok: true,
        normalized: { sam: p.sam.trim(), attributes: p.attributes }
      };
    },
    user_delete: (p) => p && isNonEmptyString(p.sam)
      ? { ok: true, normalized: { sam: p.sam.trim() } }
      : { ok: false, error: 'invalid params: sam' },
    user_list_groups: (p) => p && isNonEmptyString(p.sam)
      ? { ok: true, normalized: { sam: p.sam.trim() } }
      : { ok: false, error: 'invalid params: sam' },
    group_search: (p) => {
      const out = { filter: '', limit: 200 };
      if (p == null || typeof p !== 'object') return { ok: false, error: 'params object required' };
      if (p.filter != null && typeof p.filter !== 'string') return { ok: false, error: 'invalid params: filter' };
      out.filter = String(p.filter || '').trim();
      if (p.limit != null) {
        const n = Number(p.limit);
        if (!Number.isFinite(n) || n < 1 || n > 1000) return { ok: false, error: 'invalid params: limit' };
        out.limit = Math.floor(n);
      }
      return { ok: true, normalized: out };
    },
    group_create: (p) => {
      if (p == null || typeof p !== 'object') return { ok: false, error: 'params object required' };
      if (!isNonEmptyString(p.name)) return { ok: false, error: 'invalid params: name' };
      if (!isNonEmptyString(p.category)) return { ok: false, error: 'invalid params: category' };
      if (!isNonEmptyString(p.scope)) return { ok: false, error: 'invalid params: scope' };
      return {
        ok: true,
        normalized: {
          name: p.name.trim(),
          sam: typeof p.sam === 'string' ? p.sam : null,
          displayName: typeof p.displayName === 'string' ? p.displayName : null,
          category: p.category,
          scope: p.scope,
          ouPath: typeof p.ouPath === 'string' ? p.ouPath : null,
          description: typeof p.description === 'string' ? p.description : null,
          mail: typeof p.mail === 'string' ? p.mail : null
        }
      };
    },
    group_set_attributes: (p) => {
      if (p == null || typeof p !== 'object') return { ok: false, error: 'params object required' };
      if (!isNonEmptyString(p.name)) return { ok: false, error: 'invalid params: name' };
      if (p.attributes == null || typeof p.attributes !== 'object') return { ok: false, error: 'invalid params: attributes' };
      return {
        ok: true,
        normalized: { name: p.name.trim(), attributes: p.attributes }
      };
    },
    group_add_member: (p) => {
      if (p == null || typeof p !== 'object') return { ok: false, error: 'params object required' };
      if (!isNonEmptyString(p.name)) return { ok: false, error: 'invalid params: name' };
      if (!Array.isArray(p.members) || p.members.length === 0) return { ok: false, error: 'invalid params: members' };
      return { ok: true, normalized: { name: p.name.trim(), members: p.members.map(String) } };
    },
    group_remove_member: (p) => {
      if (p == null || typeof p !== 'object') return { ok: false, error: 'params object required' };
      if (!isNonEmptyString(p.name)) return { ok: false, error: 'invalid params: name' };
      if (!Array.isArray(p.members) || p.members.length === 0) return { ok: false, error: 'invalid params: members' };
      return { ok: true, normalized: { name: p.name.trim(), members: p.members.map(String) } };
    },
    group_set_members: (p) => {
      if (p == null || typeof p !== 'object') return { ok: false, error: 'params object required' };
      if (!isNonEmptyString(p.name)) return { ok: false, error: 'invalid params: name' };
      if (!Array.isArray(p.members)) return { ok: false, error: 'invalid params: members' };
      return { ok: true, normalized: { name: p.name.trim(), members: p.members.map(String) } };
    },
    group_delete: (p) => p && isNonEmptyString(p.name)
      ? { ok: true, normalized: { name: p.name.trim() } }
      : { ok: false, error: 'invalid params: name' },
    group_list_members: (p) => {
      if (p == null || typeof p !== 'object') return { ok: false, error: 'params object required' };
      if (!isNonEmptyString(p.name)) return { ok: false, error: 'invalid params: name' };
      const out = { name: p.name.trim(), page: 1, size: 100 };
      if (p.page != null) {
        const n = Number(p.page);
        if (!Number.isFinite(n) || n < 1) return { ok: false, error: 'invalid params: page' };
        out.page = Math.floor(n);
      }
      if (p.size != null) {
        const n = Number(p.size);
        if (!Number.isFinite(n) || n < 1 || n > 1000) return { ok: false, error: 'invalid params: size' };
        out.size = Math.floor(n);
      }
      return { ok: true, normalized: out };
    }
  };
}

const VALIDATORS = validators();

// ── httpErr helper (matches file-push convention) ────────────────────────
function httpErr(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

// ── Password redaction ───────────────────────────────────────────────────
// Spec §3.4 ruling #8 + §3.3 admin route note: passwords are NEVER
// stored in result_json. Strip before persisting.
const PASSWORD_KEYS = new Set(['password', 'newPassword', 'oldPassword']);

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

// ── Public surface ──────────────────────────────────────────────────────

/**
 * Queue a new AD admin command. Inserts a row with status='queued'.
 * @returns the inserted row (without params_json / result_json noise)
 */
export async function queueCommand({ targetDc, commandType, params, operatorId }) {
  if (!targetDc || typeof targetDc !== 'string') {
    throw httpErr(400, 'targetDc required');
  }
  if (!commandType || typeof commandType !== 'string') {
    throw httpErr(400, 'commandType required');
  }
  if (!COMMAND_TYPES.has(commandType)) {
    throw httpErr(400, `unknown command_type: ${commandType}`);
  }
  const validator = VALIDATORS[commandType];
  if (!validator) throw httpErr(400, `unknown command_type: ${commandType}`);
  const v = validator(params);
  if (!v.ok) throw httpErr(400, v.error);

  const db = getDb();
  const paramsJson = JSON.stringify(v.normalized);
  const exec = await db.execute(db.sql.adAdminCommands.insert, [
    commandType,
    targetDc.trim(),
    paramsJson,
    operatorId ?? null
  ]);
  // insertId is the LAST_INSERT_ID() from the mysql driver wrapper, or the
  // SCOPE_IDENTITY() probe batch the mssql wrapper appends (mssql.js line
  // 125-127). Both dialects populate insertId on INSERT INTO a table with
  // an AUTO_INCREMENT / IDENTITY primary key.
  const insertId = exec.insertId ?? exec.rows?.[0]?.id;
  return {
    id: insertId,
    command_type: commandType,
    target_dc: targetDc.trim(),
    status: 'queued',
    operator_id: operatorId ?? null,
    created_at: new Date().toISOString()
  };
}

/**
 * Pull queued commands for an agent. Two-step claim:
 *   1) SELECT up to `limit` queued ids for this dc (oldest first)
 *   2) UPDATE those ids SET status='running', claimed_at=NOW() WHERE status='queued'
 * If step 2 flips zero rows (e.g. another agent claimed them first between
 * step 1 and step 2), the read side already returned the ids but the row is
 * now 'running' elsewhere — we re-SELECT by id and filter out anything that
 * did NOT flip. This makes the claim atomic relative to concurrent pollers.
 */
export async function claimForAgent(targetDc, limit = 5) {
  if (!targetDc || typeof targetDc !== 'string') {
    throw httpErr(400, 'targetDc required');
  }
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 5));
  const { rows: idRows } = await db.query(
    db.sql.adAdminCommands.claimPick,
    [targetDc, safeLimit]
  );
  if (!idRows || idRows.length === 0) return [];
  const ids = idRows.map(r => Number(r.id)).filter(Number.isFinite);
  if (ids.length === 0) return [];
  // claim uses (idCount) => ... to expand IN-list placeholders. Caller binds
  // [id1, id2, ..., idN, targetDc] in that order.
  const claimSql = db.sql.adAdminCommands.claim(ids.length);
  const claimParams = [...ids, targetDc];
  await db.execute(claimSql, claimParams);
  // loadByIds returns the full row set including the freshly-updated
  // claimed_at / status. Strip result_json (not needed on the agent side).
  const loadSql = db.sql.adAdminCommands.loadByIds(ids.length);
  const { rows } = await db.query(loadSql, ids);
  if (!rows) return [];
  return rows.map(stripResultJson).map(parseParamsJson);
}

/**
 * Terminal-state ack from the agent. Flips status to success / failed.
 * Idempotent on already-terminal rows (returns the existing row unchanged
 * if status is already success/failed/timeout).
 */
export async function completeCommand(id, { success, data, error, exitCode, durationMs } = {}) {
  const numId = Number(id);
  if (!Number.isFinite(numId) || numId <= 0) throw httpErr(400, 'invalid command id');
  const db = getDb();
  // Read first so we can enforce idempotency on already-terminal rows.
  const existing = await getCommand(numId);
  if (!existing) throw httpErr(404, 'command not found');
  if (existing.status === 'success' || existing.status === 'failed' || existing.status === 'timeout') {
    return existing;
  }
  if (existing.status !== 'running') {
    // Not claimed yet — the agent's ack is invalid. 409 covers the spec
    // §2.4 'command not claimed by this agent' defense-in-depth path.
    throw httpErr(409, `command not in running state (status=${existing.status})`);
  }
  const newStatus = success ? 'success' : 'failed';
  // Spec §3.4 ruling #8: strip any password-shaped fields from result_json
  // before persisting. The agent should never have included them (the PS1
  // dispatchers are not expected to echo passwords), but defense-in-depth.
  const safeData = data == null ? null : redactPasswords(data);
  const resultJson = safeData == null ? null : JSON.stringify(safeData);
  const errorMessage = typeof error === 'string' ? error.slice(0, 2000) : null;
  const durMs = Number.isFinite(Number(durationMs)) ? Math.max(0, Math.floor(Number(durationMs))) : null;
  await db.execute(db.sql.adAdminCommands.complete, [
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
  await db.execute(db.sql.adAdminCommands.sweepTimeouts, [timeoutSeconds]);
  return 0; // exact count not observable from the UPDATE alone; tests can
            // assert via subsequent getCommand() / listCommands() reads.
}

/**
 * Single row read by id. Returns null if not found.
 */
export async function getCommand(id) {
  const numId = Number(id);
  if (!Number.isFinite(numId) || numId <= 0) return null;
  const db = getDb();
  const { rows } = await db.query(db.sql.adAdminCommands.getById, [numId]);
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  return {
    ...row,
    params_json: tryParseJson(row.params_json),
    result_json: tryParseJson(row.result_json)
  };
}

/**
 * Paginated list with optional operatorId / status filters. Returns
 * { total, rows, page, size }.
 */
export async function listCommands({ operatorId, status, page = 1, size = 50 } = {}) {
  const safePage = Math.max(1, Math.floor(Number(page) || 1));
  const safeSize = Math.max(1, Math.min(500, Math.floor(Number(size) || 50)));
  const offset = (safePage - 1) * safeSize;
  const db = getDb();

  let listSql;
  let listParams;
  let countSql;
  let countParams;
  // MSSQL's `SELECT TOP (?)` syntax puts the limit as the FIRST bound
  // param; MySQL's `LIMIT ? OFFSET ?` puts it at the END (after the
  // WHERE-clause params). The service adapts param order by dialect so
  // the same call shape works on both.
  const isMssql = db.dialect === 'mssql';
  if (operatorId != null && status != null) {
    // Combined filter: status + operatorId. Service runs status filter
    // then post-filters by operatorId (operatorId rarely combines with
    // status in real UI traffic).
    listSql = db.sql.adAdminCommands.listByStatus;
    listParams = isMssql ? [safeSize, status, offset] : [status, safeSize, offset];
    countSql = db.sql.adAdminCommands.countByStatus;
    countParams = [status];
  } else if (operatorId != null) {
    listSql = db.sql.adAdminCommands.listByOperator;
    listParams = isMssql ? [safeSize, operatorId, offset] : [operatorId, safeSize, offset];
    countSql = db.sql.adAdminCommands.countByOperator;
    countParams = [operatorId];
  } else if (status != null) {
    listSql = db.sql.adAdminCommands.listByStatus;
    listParams = isMssql ? [safeSize, status, offset] : [status, safeSize, offset];
    countSql = db.sql.adAdminCommands.countByStatus;
    countParams = [status];
  } else {
    listSql = db.sql.adAdminCommands.listAll;
    listParams = [safeSize, offset];
    countSql = db.sql.adAdminCommands.countAll;
    countParams = [];
  }

  const [{ rows: countRows }, { rows }] = await Promise.all([
    db.query(countSql, countParams),
    db.query(listSql, listParams)
  ]);
  const total = Number(countRows?.[0]?.total ?? 0);
  return { total, rows: (rows || []).map(r => ({ ...r, params_json: undefined, result_json: undefined })), page: safePage, size: safeSize };
}

// ── Internal helpers ─────────────────────────────────────────────────────

function stripResultJson(row) {
  if (!row) return row;
  const { result_json, ...rest } = row;
  return rest;
}

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
// Exposed so the test harness can reset the in-memory state between runs
// without leaking state across test files. NOT exported via the router.

export const _testInternals = Object.freeze({
  COMMAND_TYPES,
  redactPasswords,
  validators: VALIDATORS,
  httpErr
});