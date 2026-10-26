// 2026-10-01 R158.13 — client-settings auto-delivery. Mirrors
// agent-token.js shape (one-row version counter in system_config +
// transactional bump + writeAuditRequired).
//
// Storage: two rows in system_config.
//   agent_settings          — JSON blob, the entire patch object
//   agent_settings_version  — monotonic int, bumped per push
//
// Whitelist: ALLOWED_FIELDS controls which keys an operator can push.
// Bump flow: readBundle (SELECT) → merge with newPatch → upsert both rows
// in one transaction → writeAuditRequired for traceability.
//
// Defensive parse: if agent_settings is corrupt on disk, getAgentSettingsState
// returns settings={} rather than throwing — heartbeat delivery skips the
// agent with `version > 0 && Object.keys(settings).length > 0` guard.
//
// validateSettingsPatch is exported separately so the admin route can
// return 400 BEFORE the bump transaction (audit + version untouched on
// bad input). The same whitelist runs again on the agent side
// (defence-in-depth) — see D:\agentinstall\agent\src\settings-delivery.js.

import { writeAuditRequired } from './audit.js';

const VERSION_KEY = 'agent_settings_version';
const PAYLOAD_KEY = 'agent_settings';

// Audit action name (parallel to agent-token.js ROTATE_AUDIT).
const BUMP_AUDIT = 'bump_client_settings';

// Whitelist — what an operator can push via /api/admin/client-settings/push.
// Keeping this in a module-level constant (not in system_config) means
// adding a new field requires BOTH centre code review AND agent bundle
// update — defence-in-depth. If a future operator wants to push a new
// field, they need to:
//   1. Add it here (centre)
//   2. Add it to ALLOWED_FIELDS in agent/src/settings-delivery.js (agent)
//   3. Add range validation below (centre)
//   4. Bump agent bundle to pick up the new agent-side whitelist
// Anything not in this list is rejected with HTTP 400.
export const ALLOWED_FIELDS = [
  'heartbeatIntervalSeconds',
  'pollingIntervalMinutes',
  'discoveryIntervalHours',
  'healthCheckIntervalMs',
  'logLevel'
];

// R158.0.1.9 (2026-10-20) — 收紧到 3 个应用级, 跟 agent/src/logger.js 的
// APP_LEVELS 逐项对齐. 之前中心端还是 pino 原生 6 级 (trace/debug/info/
// warn/error/fatal): 操作员推 'warn' 中心端 200 放行, agent 端 normalizeAppLevel
// 静默归一化成 'error' 并落盘 —— 操作员以为设了 warn, 实际是 error, 排障时
// 最难查的一类「改了没生效」. 前端 ClientSettingsView 只给 3 档下拉, 这里是
// 服务端兜底, 两层同源.
// 兼容: 老 6 级值已在 agent 端有归一化路径, 且 appsettings.json 里存量旧值
// 不走本白名单 (只影响 push), 无需数据迁移.
const ALLOWED_LOG_LEVELS = new Set(['info', 'error', 'debug']);

// validateSettingsPatch — exported for the admin route. Returns
//   { ok: true, patch } on success
//   { ok: false, error: '<reason>' } on any failure
// Side-effect free; never throws; agent-side validatePatch is a separate
// function (in agent/src/settings-delivery.js) so the two layers don't
// have to share code.
export function validateSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'patch-not-object' };
  }
  const cleaned = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!ALLOWED_FIELDS.includes(k)) {
      return { ok: false, error: `unknown-field:${k}` };
    }
    if (k === 'logLevel') {
      if (typeof v !== 'string' || !ALLOWED_LOG_LEVELS.has(v)) {
        return { ok: false, error: `invalid-logLevel:${v}` };
      }
      cleaned[k] = v;
      continue;
    }
    // Numeric fields — must be positive integers, finite, in range.
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || !Number.isInteger(v)) {
      return { ok: false, error: `invalid-${k}:${v}` };
    }
    if (k === 'heartbeatIntervalSeconds' && (v < 1 || v > 3600)) {
      return { ok: false, error: 'heartbeatIntervalSeconds-out-of-range:1-3600' };
    }
    if (k === 'pollingIntervalMinutes' && (v < 1 || v > 1440)) {
      return { ok: false, error: 'pollingIntervalMinutes-out-of-range:1-1440' };
    }
    if (k === 'discoveryIntervalHours' && (v < 1 || v > 168)) {
      return { ok: false, error: 'discoveryIntervalHours-out-of-range:1-168' };
    }
    if (k === 'healthCheckIntervalMs' && (v < 1000 || v > 86400000)) {
      return { ok: false, error: 'healthCheckIntervalMs-out-of-range:1000-86400000' };
    }
    cleaned[k] = v;
  }
  return { ok: true, patch: cleaned };
}

// readBundle — internal. Reads the two-row bundle. Accepts any object
// with .query(sql) (works with both `db` and `tx` because they share
// the same shape — see how agent-token.js:81 passes tx-bound readBundle).
async function readBundle(db) {
  const { rows } = await db.query(db.sql.config.getAgentSettingsBundle);
  const map = Object.fromEntries((rows || []).map((r) => [r.config_key, r.config_value]));
  let settings = {};
  if (map[PAYLOAD_KEY]) {
    try {
      const parsed = JSON.parse(map[PAYLOAD_KEY]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        settings = parsed;
      }
    } catch {
      // corrupt blob on disk — treat as empty so the heartbeat response
      // skips delivery rather than crashing. Operator can re-push to
      // overwrite the corrupt row.
    }
  }
  return { settings, version: Number(map[VERSION_KEY] || 0) };
}

// getAgentSettingsState — used by routes/agent.js to populate
// agentSettingsDelivery. Returns { settings, version }.
export async function getAgentSettingsState(db) {
  return readBundle(db);
}

// bumpAgentSettings — operator-initiated push. Reads current state,
// merges newPatch, upserts both rows in one transaction, writes an
// audit row. Returns the new version + merged settings so the admin
// UI can show "vN applied: {...}".
//
// newPatch can be null/undefined for a no-op bump (operator wants to
// re-broadcast the current settings to all agents that may have
// missed it — e.g. after a network partition). merged is then
// identical to before.settings and version bumps by 1.
export async function bumpAgentSettings(db, { logger, userId, newPatch }) {
  let result;
  await db.transaction(async (tx) => {
    // The readBundle helper expects `.query(sql)`; the tx wrapper from
    // db/index.js exposes the same shape so we can reuse the helper
    // without duplicating the SELECT.
    const txBound = {
      query: (sql) => tx.query(sql),
      execute: (sql, params) => tx.execute(sql, params),
      sql: db.sql
    };
    const before = await readBundle(txBound);
    const nextVersion = before.version + 1;
    const merged = { ...before.settings, ...(newPatch || {}) };
    const upsert = db.sql.config.upsert;
    await tx.execute(upsert, [PAYLOAD_KEY, JSON.stringify(merged)]);
    await tx.execute(upsert, [VERSION_KEY, String(nextVersion)]);
    await writeAuditRequired({
      userId,
      action: BUMP_AUDIT,
      target: 'system_config',
      payload: {
        version: nextVersion,
        mergedFields: Object.keys(newPatch || {})
      },
      logger
    }, logger, tx);
    result = { version: nextVersion, settings: merged };
  });
  logger?.info?.(
    { userId, version: result.version, fields: Object.keys(newPatch || {}) },
    'client settings bumped'
  );
  return result;
}