// R158.102 (2026-10-14) — MCP server token service. Mirrors services/agent-token.js
// 1:1 parallel with two simplifications:
//   1. NO auto-delivery / NO version counter / NO delivery polling — MCP clients
//      are external (Claude Desktop / Cursor), not agents that pick up the new
//      token via heartbeat. The operator runs `reveal` once, pastes the token
//      into the AI Agent config, then `commit`s.
//   2. NO internal grace expiry — the previous token stays valid until the
//      operator explicitly commits. Class userAuth dual-key rotation precedent
//      (jwt-secret.js).
//
// 4 rows in system_config:
//   mcp_api_token_current    — runtime source of truth (server-side auth)
//   mcp_api_token_previous   — old token during rotation overlap
//   mcp_api_token_rotated_at — ISO 8601 when previous was set
//   mcp_api_token_version    — monotonic int (read by future operator UI only)
//
// Token format: `mcp_<48 random bytes hex>` = `mcp_` + 96 hex chars.
// Class agent-token 96-hex convention. Prefix `mcp_` so the middleware can
// fast-path: strip prefix, compare remainder, no accidental collision with
// agent_token_xxx or jwt_secret_xxx.
//
// Rotations + commits are atomic via db.transaction. Every mutation writes
// writeAuditRequired so "who rotated when" has a deterministic answer. The
// bundle SELECT comes from db.sql.config.getMcpTokenBundle — SQL registry
// owns dialect-specific strings.
import { randomBytes } from 'node:crypto';
import { writeAudit, writeAuditRequired } from './audit.js';

const ROTATE_AUDIT = 'mcp_token_rotate';
const COMMIT_AUDIT = 'mcp_token_commit';
const REVEAL_AUDIT = 'mcp_token_reveal';
const SEED_AUDIT   = 'mcp_token_seed';

const MCP_TOKEN_PREFIX = 'mcp_';

function readBundle(db) {
  return db.query(db.sql.config.getMcpTokenBundle).then(({ rows }) => {
    const map = Object.fromEntries((rows || []).map(r => [r.config_key, r.config_value]));
    return {
      current:   map.mcp_api_token_current   ?? '',
      previous:  map.mcp_api_token_previous  ?? '',
      rotatedAt: map.mcp_api_token_rotated_at ?? '',
      version:   Number(map.mcp_api_token_version || 0)
    };
  });
}

// 0 暴露 token 明文. State-only shape for `get` endpoint.
export async function getMcpTokenState(db) {
  const b = await readBundle(db);
  return {
    current_set:   Boolean(b.current),
    previous_set:  Boolean(b.previous),
    rotatedAt:     b.rotatedAt || null,
    version:       b.version
  };
}

export async function rotateMcpToken(db, { logger, userId }) {
  let newToken;
  let rotatedAt;
  let version;
  await db.transaction(async (tx) => {
    const before = await readBundle(db);
    newToken = MCP_TOKEN_PREFIX + randomBytes(48).toString('hex');
    rotatedAt = new Date().toISOString();
    version = before.version + 1;
    const upsert = db.sql.config.upsert;
    await tx.execute(upsert, ['mcp_api_token_previous',  before.current]);
    await tx.execute(upsert, ['mcp_api_token_current',   newToken]);
    await tx.execute(upsert, ['mcp_api_token_rotated_at', rotatedAt]);
    await tx.execute(upsert, ['mcp_api_token_version',    String(version)]);
    await writeAuditRequired({
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
  logger?.info?.({ userId, newLength: newToken.length, rotatedAt, version }, 'mcp token rotated');
  return { newToken, rotatedAt, version };
}

export async function commitMcpToken(db, { logger, userId }) {
  let didCommit = false;
  await db.transaction(async (tx) => {
    const before = await readBundle(db);
    if (!before.previous) {
      logger?.info?.({ userId }, 'mcp_token_commit: no-op (no previous token)');
      return;
    }
    const upsert = db.sql.config.upsert;
    await tx.execute(upsert, ['mcp_api_token_previous',   '']);
    await tx.execute(upsert, ['mcp_api_token_rotated_at', '']);
    // version is intentionally NOT reset (mirror agent-token precedent —
    // stays as the monotonic counter of every rotation that's ever happened).
    await writeAuditRequired({
      userId,
      action: COMMIT_AUDIT,
      target: 'system_config',
      payload: { committedAt: new Date().toISOString() },
      logger
    }, logger, tx);
    didCommit = true;
  });
  logger?.info?.({ userId }, 'mcp token committed');
  return { ok: true, didCommit };
}

// Read-only reveal of the active mcp auth token. No system_config write —
// just returns bundle.current + audit row. Class agent-token reveal pattern.
export async function revealMcpToken(db, { logger, userId }) {
  let result;
  await db.transaction(async (tx) => {
    const before = await readBundle(db);
    const revealedAt = new Date().toISOString();
    await writeAuditRequired({
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
    result = { token: before.current, revealedAt, version: before.version };
  });
  logger?.info?.({ userId, tokenLength: result.token.length, revealedAt: result.revealedAt, version: result.version }, 'mcp token revealed');
  return result;
}

// Boot-time seed (类 agent-token seedAgentTokenIfMissing). If the bundle
// has no current token, write a random one so the center can answer
// /mcp requests out of the box; operator can later rotate+reveal.
export async function seedMcpTokenIfMissing(db, logger) {
  let result;
  await db.transaction(async (tx) => {
    const before = await readBundle(db);
    if (before.current) {
      result = { seeded: false, current: before.current };
      return;
    }
    const newToken = MCP_TOKEN_PREFIX + randomBytes(48).toString('hex');
    const upsert = db.sql.config.upsert;
    await tx.execute(upsert, ['mcp_api_token_current',    newToken]);
    await tx.execute(upsert, ['mcp_api_token_previous',   '']);
    await tx.execute(upsert, ['mcp_api_token_rotated_at', '']);
    await tx.execute(upsert, ['mcp_api_token_version',    '0']);
    await writeAudit({
      userId: null,
      action: SEED_AUDIT,
      target: 'system_config',
      payload: { source: 'boot', length: newToken.length },
      logger
    }, logger, tx);
    result = { seeded: true, current: newToken };
  });
  if (result?.seeded) {
    logger?.warn?.({ length: result.current.length }, 'seeded mcp token at boot — operator must run `reveal` and configure the AI Agent before using /mcp');
  }
  return result;
}

// Re-export for tests + the bundle keys so other modules can introspect.
export const MCP_TOKEN_BUNDLE_KEYS = [
  'mcp_api_token_current',
  'mcp_api_token_previous',
  'mcp_api_token_rotated_at',
  'mcp_api_token_version'
];

export { MCP_TOKEN_PREFIX };
