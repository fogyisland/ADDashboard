// Service for the dual-key agent-token rotation mechanism. Reads/writes
// four rows in `system_config`:
//   agent_token_current           — runtime source of truth
//   agent_token_previous          — old token during overlap window
//   agent_token_rotated_at        — ISO 8601 when previous was set
//   agent_token_previous_ttl_days — auto-expiry threshold (default 30)
//
// Rotations and commits are atomic via `db.transaction` so the previous →
// current swap is never half-applied. Every mutation writes a `writeAudit`
// row so the operator's "who rotated when" question has a deterministic
// answer.
//
// The bundle SELECT comes from `db.sql.config.getAgentTokenBundle` (Task 3,
// I3) — the SQL registry owns dialect-specific strings so this module stays
// dialect-agnostic. The registry SQL contains the `agent_token` substring
// so test mocks using `/agent_token/i` regex matching still work.
import { randomBytes } from 'node:crypto';
import { writeAudit } from './audit.js';

const ROTATE_AUDIT = 'rotate_agent_token';
const COMMIT_AUDIT = 'commit_agent_token';
const SEED_AUDIT = 'seed_agent_token';
// #167 C2: parallel to jwt-secret.AUTO_EXPIRE_AUDIT — the auto-expire
// branch silently clears the previous-token overlap window when TTL is
// reached, so it must produce an audit row matching the rotate/commit/
// seed taxonomy. Without this row, an operator reading the audit log
// after a TTL-driven auto-clear would see no trace of the event.
const AUTO_EXPIRE_AUDIT = 'auto_expire_agent_token';
// reveal_agent_token — operator-initiated read of the active agent auth
// secret. Does NOT mutate system_config; writes an audit row so the
// "who read the active token when" question has a deterministic answer.
// High-severity security event (audit-classifier.js) — every reveal is
// a credential exposure even though no state changes.
const REVEAL_AUDIT = 'reveal_agent_token';

function readBundle(db, query) {
  return query(db.sql.config.getAgentTokenBundle).then(({ rows }) => {
    const map = Object.fromEntries((rows || []).map(r => [r.config_key, r.config_value]));
    return {
      current: map.agent_token_current ?? '',
      previous: map.agent_token_previous ?? '',
      rotatedAt: map.agent_token_rotated_at ?? '',
      ttlDays: Number(map.agent_token_previous_ttl_days || 30)
    };
  });
}

function expiresAt(rotatedAt, ttlDays) {
  if (!rotatedAt) return null;
  const t = Date.parse(rotatedAt);
  if (!Number.isFinite(t)) return null;
  return new Date(t + ttlDays * 24 * 3600 * 1000).toISOString();
}

export async function getAgentTokenState(db) {
  const b = await readBundle(db, (sql) => db.query(sql));
  return { ...b, previousExpiresAt: expiresAt(b.rotatedAt, b.ttlDays) };
}

export async function rotateAgentToken(db, { logger, userId }) {
  let newToken;
  let rotatedAt;
  await db.transaction(async (tx) => {
    const before = await readBundle(db, (sql) => tx.query(sql));
    newToken = randomBytes(48).toString('hex');
    rotatedAt = new Date().toISOString();
    const upsert = db.sql.config.upsert;
    await tx.execute(upsert, ['agent_token_previous', before.current]);
    await tx.execute(upsert, ['agent_token_current', newToken]);
    await tx.execute(upsert, ['agent_token_rotated_at', rotatedAt]);
    await writeAudit({
      userId,
      action: ROTATE_AUDIT,
      target: 'system_config',
      payload: {
        previousLength: before.current.length,
        newLength: newToken.length,
        rotatedAt
      },
      logger
    }, logger, tx);
  });
  logger?.info?.({ userId, newLength: newToken.length, rotatedAt }, 'agent token rotated');
  return { newToken, rotatedAt };
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
    // Audit row written inside the tx so a write failure rolls back (no
    // data state changes so this is defensive — matches the rotate/
    // commit convention so future reads see the audit row atomically
    // alongside any added bookkeeping writes).
    await writeAudit({
      userId,
      action: REVEAL_AUDIT,
      target: 'system_config',
      payload: {
        revealedAt,
        tokenLength: before.current.length
      },
      logger
    }, logger, tx);
    logger?.info?.({ userId, tokenLength: before.current.length, revealedAt }, 'agent token revealed');
    result = { token: before.current, revealedAt };
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
      // Seed all 4 rows
      const upsert = db.sql.config.upsert;
      await tx.execute(upsert, ['agent_token_current', fromAppsettings]);
      await tx.execute(upsert, ['agent_token_previous', '']);
      await tx.execute(upsert, ['agent_token_rotated_at', '']);
      await tx.execute(upsert, ['agent_token_previous_ttl_days', '30']);
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
    // Auto-expire check
    if (before.previous && before.rotatedAt && before.ttlDays > 0) {
      const ageMs = Date.now() - Date.parse(before.rotatedAt);
      if (Number.isFinite(ageMs) && ageMs > before.ttlDays * 24 * 3600 * 1000) {
        const upsert = db.sql.config.upsert;
        await tx.execute(upsert, ['agent_token_previous', '']);
        await tx.execute(upsert, ['agent_token_rotated_at', '']);
        // #167 C2: writeAudit inside the tx so the audit row commits
        // atomically with the data writes (mirrors jwt-secret auto-expire
        // shape). Best-effort callers would silently lose the audit row —
        // unacceptable for a TTL-driven silent security event.
        await writeAudit({
          userId: null,
          action: AUTO_EXPIRE_AUDIT,
          target: 'system_config',
          payload: { rotatedAt: before.rotatedAt, ttlDays: before.ttlDays },
          logger
        }, logger, tx);
        logger?.warn?.({ rotatedAt: before.rotatedAt, ttlDays: before.ttlDays }, 'previous agent token expired by TTL; auto-cleared');
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
  'agent_token_previous_ttl_days'
];