// Service for the dual-key JWT secret rotation mechanism. Reads/writes
// four rows in `system_config`:
//   jwt_secret_current           — runtime source of truth (loaded by userAuth)
//   jwt_secret_previous          — old secret during overlap window
//   jwt_secret_rotated_at        — ISO 8601 when previous was set
//   jwt_secret_previous_ttl_days — auto-expiry threshold (default 30)
//
// Rotations and commits are atomic via `db.transaction` so the previous →
// current swap is never half-applied. Every mutation writes a `writeAudit`
// row so the operator's "who rotated when" question has a deterministic
// answer. The bundle SELECT comes from `db.sql.config.getJwtSecretBundle`
// (Task 3) — the SQL registry owns dialect-specific strings.
//
// SECURITY: the new secret is returned ONCE (in `rotateJwtSecret`'s return
// value) for the operator to copy. It is never logged — audit payload
// records lengths only.
//
// I9 Task 2 note: readBundle uses an inline SQL string with the
// `jwt_secret` substring so the test mock's `/jwt_secret/i` regex can
// match. Task 3 will introduce `db.sql.config.getJwtSecretBundle` as a
// proper SQL registry entry; once that lands, swap the literal for
// `db.sql.config.getJwtSecretBundle`.
import { randomBytes } from 'node:crypto';
import { writeAudit } from './audit.js';

const ROTATE_AUDIT = 'rotate_jwt_secret';
const COMMIT_AUDIT = 'commit_jwt_secret';
const SEED_AUDIT = 'seed_jwt_secret';
const AUTO_EXPIRE_AUDIT = 'auto_expire_jwt_secret';

const BUNDLE_SQL = "SELECT config_key, config_value FROM system_config WHERE config_key IN ('jwt_secret_current', 'jwt_secret_previous', 'jwt_secret_rotated_at', 'jwt_secret_previous_ttl_days')";

function readBundle(db, query) {
  return query(BUNDLE_SQL).then(({ rows }) => {
    const map = Object.fromEntries((rows || []).map(r => [r.config_key, r.config_value]));
    return {
      current: map.jwt_secret_current ?? '',
      previous: map.jwt_secret_previous ?? '',
      rotatedAt: map.jwt_secret_rotated_at ?? '',
      ttlDays: Number(map.jwt_secret_previous_ttl_days || 30)
    };
  });
}

function expiresAt(rotatedAt, ttlDays) {
  if (!rotatedAt) return null;
  const t = Date.parse(rotatedAt);
  if (!Number.isFinite(t)) return null;
  return new Date(t + ttlDays * 24 * 3600 * 1000).toISOString();
}

export async function getJwtSecretState(db) {
  const b = await readBundle(db, (sql) => db.query(sql));
  return { ...b, previousExpiresAt: expiresAt(b.rotatedAt, b.ttlDays) };
}

export async function rotateJwtSecret(db, { logger, userId }) {
  let newSecret;
  let rotatedAt;
  await db.transaction(async (tx) => {
    const before = await readBundle(db, (sql) => tx.query(sql));
    newSecret = randomBytes(32).toString('hex');
    rotatedAt = new Date().toISOString();
    const upsert = db.sql.config.upsert;
    await tx.execute(upsert, ['jwt_secret_previous', before.current]);
    await tx.execute(upsert, ['jwt_secret_current', newSecret]);
    await tx.execute(upsert, ['jwt_secret_rotated_at', rotatedAt]);
    await writeAudit({
      userId,
      action: ROTATE_AUDIT,
      target: 'system_config',
      payload: {
        previousLength: before.current.length,
        newLength: newSecret.length,
        rotatedAt
      },
      logger
    }, logger, tx);
  });
  logger?.info?.({ userId, newLength: newSecret.length, rotatedAt }, 'jwt secret rotated');
  return { newSecret, rotatedAt };
}

export async function commitJwtSecret(db, { logger, userId }) {
  await db.transaction(async (tx) => {
    const before = await readBundle(db, (sql) => tx.query(sql));
    if (!before.previous) {
      logger?.info?.({ userId }, 'commit_jwt_secret: no-op (no previous secret)');
      return;
    }
    const upsert = db.sql.config.upsert;
    await tx.execute(upsert, ['jwt_secret_previous', '']);
    await tx.execute(upsert, ['jwt_secret_rotated_at', '']);
    await writeAudit({
      userId,
      action: COMMIT_AUDIT,
      target: 'system_config',
      payload: { committedAt: new Date().toISOString() },
      logger
    }, logger, tx);
  });
  logger?.info?.({ userId }, 'jwt secret committed');
  return { ok: true };
}

export async function seedJwtSecretIfMissing(db, fromAppsettings, logger) {
  // Wrap seed + auto-expire mutations in a transaction so the audit row
  // commits atomically with the data writes (per I2 audit-in-tx contract).
  let result;
  await db.transaction(async (tx) => {
    const before = await readBundle(db, (sql) => tx.query(sql));
    if (!before.current) {
      // First boot: seed all 4 rows from appsettings.json.
      const upsert = db.sql.config.upsert;
      await tx.execute(upsert, ['jwt_secret_current', fromAppsettings]);
      await tx.execute(upsert, ['jwt_secret_previous', '']);
      await tx.execute(upsert, ['jwt_secret_rotated_at', '']);
      await tx.execute(upsert, ['jwt_secret_previous_ttl_days', '30']);
      await writeAudit({
        userId: null,
        action: SEED_AUDIT,
        target: 'system_config',
        payload: { source: 'appsettings.json', length: fromAppsettings.length },
        logger
      }, logger, tx);
      logger?.info?.({ length: fromAppsettings.length }, 'seeded jwt secret from appsettings.json');
      result = { seeded: true, current: fromAppsettings };
      return;
    }
    // Auto-expire check: if previous is older than TTL, clear it so the
    // operator cannot accidentally keep the overlap open forever.
    if (before.previous && before.rotatedAt && before.ttlDays > 0) {
      const ageMs = Date.now() - Date.parse(before.rotatedAt);
      if (Number.isFinite(ageMs) && ageMs > before.ttlDays * 24 * 3600 * 1000) {
        const upsert = db.sql.config.upsert;
        await tx.execute(upsert, ['jwt_secret_previous', '']);
        await tx.execute(upsert, ['jwt_secret_rotated_at', '']);
        await writeAudit({
          userId: null,
          action: AUTO_EXPIRE_AUDIT,
          target: 'system_config',
          payload: { rotatedAt: before.rotatedAt, ttlDays: before.ttlDays },
          logger
        }, logger, tx);
        logger?.warn?.({ rotatedAt: before.rotatedAt, ttlDays: before.ttlDays }, 'previous jwt secret expired by TTL; auto-cleared');
        result = { seeded: false, current: before.current, autoExpired: true };
        return;
      }
    }
    result = { seeded: false, current: before.current };
  });
  return result;
}

// Re-export the bundle keys so other modules can introspect (e.g. audit
// filters). Exported for symmetry with the four-row schema documented in
// the spec.
export const JWT_SECRET_BUNDLE_KEYS = [
  'jwt_secret_current',
  'jwt_secret_previous',
  'jwt_secret_rotated_at',
  'jwt_secret_previous_ttl_days'
];
