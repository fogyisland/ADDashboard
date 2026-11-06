// R158.113 (2026-10-17) — MCP write tools token service. 1:1 平行 services/mcp-token.js
// 唯一区别: prefix `mcpw_` (写) 跟 `mcp_` (读) 区分, 防 read 端 token 误用写端. 4 lifecycle:
//   seedMcpWriteTokenIfMissing / rotateMcpWriteToken / commitMcpWriteToken / revealMcpWriteToken.
// 4 audit action: mcp_write_token_seed / rotate / commit / reveal. 0 me 端入口
// (操作员 directive "个人账户默认不能申请写入, 写入 tokens 旨在 a 管理员 MCP 定义一面泄露").
// 复用 writeAudit / writeAuditRequired 跟 db.sql.config.getMcpWriteTokenBundle
// (sql.js:777 mysql / :3866 mssql, R158.113 加).
import { randomBytes } from 'node:crypto';
import { writeAudit, writeAuditRequired } from './audit.js';

const ROTATE_AUDIT = 'mcp_write_token_rotate';
const COMMIT_AUDIT = 'mcp_write_token_commit';
const REVEAL_AUDIT = 'mcp_write_token_reveal';
const SEED_AUDIT   = 'mcp_write_token_seed';

const MCP_WRITE_TOKEN_PREFIX = 'mcpw_';

function readBundle(db) {
  return db.query(db.sql.config.getMcpWriteTokenBundle).then(({ rows }) => {
    const map = Object.fromEntries((rows || []).map(r => [r.config_key, r.config_value]));
    return {
      current:   map.mcp_write_token_current   ?? '',
      previous:  map.mcp_write_token_previous  ?? '',
      rotatedAt: map.mcp_write_token_rotated_at ?? '',
      version:   Number(map.mcp_write_token_version || 0)
    };
  });
}

// 0 暴露 token 明文. State-only shape for `get` endpoint.
export async function getMcpWriteTokenState(db) {
  const b = await readBundle(db);
  return {
    current_set:   Boolean(b.current),
    previous_set:  Boolean(b.previous),
    rotatedAt:     b.rotatedAt || null,
    version:       b.version
  };
}

export async function rotateMcpWriteToken(db, { logger, userId }) {
  let newToken;
  let rotatedAt;
  let version;
  await db.transaction(async (tx) => {
    const before = await readBundle(db);
    newToken = MCP_WRITE_TOKEN_PREFIX + randomBytes(48).toString('hex');
    rotatedAt = new Date().toISOString();
    version = before.version + 1;
    const upsert = db.sql.config.upsert;
    await tx.execute(upsert, ['mcp_write_token_previous',  before.current]);
    await tx.execute(upsert, ['mcp_write_token_current',   newToken]);
    await tx.execute(upsert, ['mcp_write_token_rotated_at', rotatedAt]);
    await tx.execute(upsert, ['mcp_write_token_version',    String(version)]);
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
  logger?.info?.({ userId, newLength: newToken.length, rotatedAt, version }, 'mcp write token rotated');
  return { newToken, rotatedAt, version };
}

export async function commitMcpWriteToken(db, { logger, userId }) {
  let didCommit = false;
  await db.transaction(async (tx) => {
    const before = await readBundle(db);
    if (!before.previous) {
      logger?.info?.({ userId }, 'mcp_write_token_commit: no-op (no previous token)');
      return;
    }
    const upsert = db.sql.config.upsert;
    await tx.execute(upsert, ['mcp_write_token_previous',   '']);
    await tx.execute(upsert, ['mcp_write_token_rotated_at', '']);
    // version is intentionally NOT reset (mirror mcp-token precedent).
    await writeAuditRequired({
      userId,
      action: COMMIT_AUDIT,
      target: 'system_config',
      payload: { committedAt: new Date().toISOString() },
      logger
    }, logger, tx);
    didCommit = true;
  });
  logger?.info?.({ userId }, 'mcp write token committed');
  return { ok: true, didCommit };
}

// Read-only reveal of the active mcp write token. Audit row only — no
// system_config write. Class mcp-token reveal pattern 1:1 平行.
export async function revealMcpWriteToken(db, { logger, userId }) {
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
  logger?.info?.({ userId, tokenLength: result.token.length, revealedAt: result.revealedAt, version: result.version }, 'mcp write token revealed');
  return result;
}

// Boot-time seed. If no current token, write a random one so the center
// can answer /mcp-write requests out of the box. operator reveal 后才能用.
export async function seedMcpWriteTokenIfMissing(db, logger) {
  let result;
  await db.transaction(async (tx) => {
    const before = await readBundle(db);
    if (before.current) {
      result = { seeded: false, current: before.current };
      return;
    }
    const newToken = MCP_WRITE_TOKEN_PREFIX + randomBytes(48).toString('hex');
    const upsert = db.sql.config.upsert;
    await tx.execute(upsert, ['mcp_write_token_current',    newToken]);
    await tx.execute(upsert, ['mcp_write_token_previous',   '']);
    await tx.execute(upsert, ['mcp_write_token_rotated_at', '']);
    await tx.execute(upsert, ['mcp_write_token_version',    '0']);
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
    logger?.warn?.({ length: result.current.length }, 'seeded mcp write token at boot — operator must run `reveal` and configure the AI Agent before using /mcp-write');
  }
  return result;
}

export const MCP_WRITE_TOKEN_BUNDLE_KEYS = [
  'mcp_write_token_current',
  'mcp_write_token_previous',
  'mcp_write_token_rotated_at',
  'mcp_write_token_version'
];

export { MCP_WRITE_TOKEN_PREFIX };
