// Service for the agent-token auto-delivery mechanism. Reads/writes five
// rows in `system_config`:
//   agent_token_current   — runtime source of truth (server-side auth)
//   agent_token_previous  — old token during the brief propagation grace
//   agent_token_rotated_at — ISO 8601 when previous was set
//   agent_token_version   — monotonic integer bumped on each rotate (the
//                            value agents echo back to learn about new tokens)
//
// Grace window is internal: hardcoded INTERNAL_GRACE_MS = 5 min. The user
// (operator) no longer sets a TTL — the grace exists only to give every
// connected agent one propagation window via heartbeat response. After the
// grace expires the previous token is auto-cleared by
// seedAgentTokenIfMissing's auto-expire branch (runs on next center boot
// and on every bundle read).
//
// Rotations and commits are atomic via `db.transaction` so the previous →
// current swap is never half-applied. Every mutation writes a `writeAudit`
// row so the operator's "who rotated when" question has a deterministic
// answer. The bundle SELECT comes from `db.sql.config.getAgentTokenBundle` —
// the SQL registry owns dialect-specific strings so this module stays
// dialect-agnostic.
import { randomBytes } from 'node:crypto';
import { writeAudit } from './audit.js';

// Renamed 2026-08-21 (UX redesign — auto-delivery replaces manual
// dual-key rotation): the action is no longer "rotate the token"; it's
// "generate a new token and push it to all verified agents". Existing
// audit rows under the old name stay untouched (audit_logs is append-only).
const ROTATE_AUDIT = 'generate_agent_token';
const COMMIT_AUDIT = 'commit_agent_token';
const SEED_AUDIT = 'seed_agent_token';
// Parallel to jwt-secret.AUTO_EXPIRE_AUDIT — the auto-expire branch
// silently clears the previous-token overlap window when INTERNAL_GRACE_MS
// is reached, so it must produce an audit row matching the rotate/commit/
// seed taxonomy. Without this row, an operator reading the audit log
// after a TTL-driven auto-clear would see no trace of the event.
const AUTO_EXPIRE_AUDIT = 'auto_expire_agent_token';
// Operator-initiated read of the active agent auth secret via the
// 复制令牌 button. Does NOT mutate system_config; writes an audit row so
// the "who read the live token when" question has a deterministic answer.
// High-severity security event (audit-classifier.js) — every reveal is
// a credential exposure even though no state changes.
const REVEAL_AUDIT = 'reveal_agent_token';

// Hardcoded grace. Five minutes covers the default heartbeat interval
// (5s) × every connected agent with at least one retry. Agents that miss
// the window are intentionally locked out — they were already offline
// past the grace, so any new token they would accept is unverifiable
// without operator intervention.
const INTERNAL_GRACE_MS = 5 * 60 * 1000;

function readBundle(db, query) {
  return query(db.sql.config.getAgentTokenBundle).then(({ rows }) => {
    const map = Object.fromEntries((rows || []).map(r => [r.config_key, r.config_value]));
    return {
      current: map.agent_token_current ?? '',
      previous: map.agent_token_previous ?? '',
      rotatedAt: map.agent_token_rotated_at ?? '',
      version: Number(map.agent_token_version || 0)
    };
  });
}

function expiresAt(rotatedAt) {
  if (!rotatedAt) return null;
  const t = Date.parse(rotatedAt);
  if (!Number.isFinite(t)) return null;
  return new Date(t + INTERNAL_GRACE_MS).toISOString();
}

export async function getAgentTokenState(db) {
  const b = await readBundle(db, (sql) => db.query(sql));
  return { ...b, previousExpiresAt: expiresAt(b.rotatedAt) };
}

export async function rotateAgentToken(db, { logger, userId }) {
  let newToken;
  let rotatedAt;
  let version;
  await db.transaction(async (tx) => {
    const before = await readBundle(db, (sql) => tx.query(sql));
    newToken = randomBytes(48).toString('hex');
    rotatedAt = new Date().toISOString();
    version = before.version + 1;
    const upsert = db.sql.config.upsert;
    await tx.execute(upsert, ['agent_token_previous', before.current]);
    await tx.execute(upsert, ['agent_token_current', newToken]);
    await tx.execute(upsert, ['agent_token_rotated_at', rotatedAt]);
    await tx.execute(upsert, ['agent_token_version', String(version)]);
    await writeAudit({
      userId,
      action: ROTATE_AUDIT,
      target: 'system_config',
      payload: {
        previousLength: before.current.length,
        newLength: newToken.length,
        rotatedAt,
        version
      },
      logger
    }, logger, tx);
  });
  logger?.info?.({ userId, newLength: newToken.length, rotatedAt, version }, 'agent token generated');
  return { newToken, rotatedAt, version };
}

export async function commitAgentToken(db, { logger, userId }) {
  await db.transaction(async (tx) => {
    const before = await readBundle(db, (sql) => tx.query(sql));
    if (!before.previous) {
      logger?.info?.({ userId }, 'commit_agent_token: no-op (no previous token)');
      return;
    }
    const upsert = db.sql.config.upsert;
    await tx.execute(upsert, ['agent_token_previous', '']);
    await tx.execute(upsert, ['agent_token_rotated_at', '']);
    // version is intentionally NOT reset — it stays as the monotonic
    // counter of every rotation that's ever happened, so future heartbeats
    // can correctly identify when an agent's last-seen version is older
    // than the server's current version.
    await writeAudit({
      userId,
      action: COMMIT_AUDIT,
      target: 'system_config',
      payload: { committedAt: new Date().toISOString() },
      logger
    }, logger, tx);
  });
  logger?.info?.({ userId }, 'agent token committed');
  return { ok: true };
}

// Read-only reveal of the active agent auth token. No system_config write —
// just returns the bundle.current string + a fresh timestamp + audit row.
//
// Operators need this when onboarding a new agent: paste the value into
// appsettings.json's agentToken without having to rotate (which would
// invalidate every existing agent). The trade-off is that an admin with
// /api/admin/agent-token/reveal can read the live credential — mitigated
// by admin-only auth (auth chain at admin.js) + per-call audit row.
export async function revealAgentToken(db, { logger, userId }) {
  let result;
  await db.transaction(async (tx) => {
    const before = await readBundle(db, (sql) => tx.query(sql));
    const revealedAt = new Date().toISOString();
    await writeAudit({
      userId,
      action: REVEAL_AUDIT,
      target: 'system_config',
      payload: {
        revealedAt,
        tokenLength: before.current.length,
        version: before.version
      },
      logger
    }, logger, tx);
    logger?.info?.({ userId, tokenLength: before.current.length, revealedAt, version: before.version }, 'agent token revealed');
    result = { token: before.current, revealedAt, version: before.version };
  });
  return result;
}

export async function seedAgentTokenIfMissing(db, fromAppsettings, logger) {
  // Wrap the seed + auto-expire mutations in a transaction so the audit row
  // commits atomically with the data writes (per I2 best-effort caveat: when
  // called inside a tx, writeAudit re-throws and the surrounding writes roll
  // back together). Best-effort callers would silently lose the audit row
  // and split the operation across two transactions — bad for a bootstrap.
  let result;
  await db.transaction(async (tx) => {
    const before = await readBundle(db, (sql) => tx.query(sql));
    if (!before.current) {
      // Seed the 4 rows: current/previous/rotated_at/version. version=0
      // marks this as the initial seed; first rotate will bump to 1.
      const upsert = db.sql.config.upsert;
      await tx.execute(upsert, ['agent_token_current', fromAppsettings]);
      await tx.execute(upsert, ['agent_token_previous', '']);
      await tx.execute(upsert, ['agent_token_rotated_at', '']);
      await tx.execute(upsert, ['agent_token_version', '0']);
      await writeAudit({
        userId: null,
        action: SEED_AUDIT,
        target: 'system_config',
        payload: { source: 'appsettings.json', length: fromAppsettings.length },
        logger
      }, logger, tx);
      logger?.info?.({ length: fromAppsettings.length }, 'seeded agent token from appsettings.json');
      result = { seeded: true, current: fromAppsettings };
      return;
    }
    // Auto-expire check — uses INTERNAL_GRACE_MS (5 min hardcoded). No
    // operator-set TTL since the UX redesign; the grace exists purely to
    // cover heartbeat propagation.
    if (before.previous && before.rotatedAt) {
      const ageMs = Date.now() - Date.parse(before.rotatedAt);
      if (Number.isFinite(ageMs) && ageMs > INTERNAL_GRACE_MS) {
        const upsert = db.sql.config.upsert;
        await tx.execute(upsert, ['agent_token_previous', '']);
        await tx.execute(upsert, ['agent_token_rotated_at', '']);
        await writeAudit({
          userId: null,
          action: AUTO_EXPIRE_AUDIT,
          target: 'system_config',
          payload: { rotatedAt: before.rotatedAt, graceMs: INTERNAL_GRACE_MS },
          logger
        }, logger, tx);
        logger?.warn?.({ rotatedAt: before.rotatedAt, graceMs: INTERNAL_GRACE_MS }, 'previous agent token expired by internal grace; auto-cleared');
        result = { seeded: false, current: before.current, autoExpired: true };
        return;
      }
    }
    result = { seeded: false, current: before.current };
  });
  return result;
}

// Re-export the bundle key so other modules can introspect (e.g. audit
// filters). Currently unused but exported for symmetry with the four-row
// schema documented in the spec.
export const AGENT_TOKEN_BUNDLE_KEYS = [
  'agent_token_current',
  'agent_token_previous',
  'agent_token_rotated_at',
  'agent_token_version'
];

export { INTERNAL_GRACE_MS };