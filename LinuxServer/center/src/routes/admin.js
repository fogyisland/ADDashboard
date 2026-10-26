import { Router } from 'express';
import { userAuth } from '../auth/user-auth.js';
import { requirePerm } from '../auth/rbac.js';
import { findByUsername, listUsers, createUser, updateUser, deleteUser, bumpTokenVersion } from '../services/users.js';
import { getConfig, setConfig, getConfigMap, restartRequired, putConfig, putConfigWithin } from '../services/config.js';
import { writeAudit } from '../services/audit.js';
// R158.X.115 (2026-10-20) — 主机生命周期 service: DC 侧退役/暂停/恢复。
//   与 routes/member-servers.js 共用同一 service (kind='dc'), 保证 DC 与
//   member server 的下线语义 100% 对称。
import {
  decommissionHost, pauseHost, resumeHost, previewLifecycle, HostStatusError
} from '../services/host-status.js';
import { listPorts, createPort, updatePort, deletePort } from '../services/ports.js';
import { getDb } from '../db/index.js';
import { sha256Hex } from '../config.js';
import * as email from '../services/email.js';
import { rotateAgentToken, commitAgentToken, getAgentTokenState, revealAgentToken } from '../services/agent-token.js';
// 2026-10-01 R158.13 — parallel to agent-token import above. The
// three client-settings routes below mirror agent-token's rotate/commit/
// state triad but for appsettings tunables (heartbeatIntervalSeconds,
// pollingIntervalMinutes, discoveryIntervalHours, healthCheckIntervalMs,
// logLevel). Validated by ALLOWED_FIELDS + range guards — see
// services/client-settings.js validateSettingsPatch.
import {
  bumpAgentSettings,
  getAgentSettingsState,
  validateSettingsPatch
} from '../services/client-settings.js';
import { invalidateAgentTokenCache } from '../auth/agent-token.js';
import { rotateJwtSecret, commitJwtSecret, getJwtSecretState } from '../services/jwt-secret.js';
import { invalidateJwtSecretCache } from '../auth/user-auth.js';
import { getPrimaryIPv4 } from '../utils/network.js';
import { toMysqlDatetime } from '../utils/datetime.js';
// R158.35 (2026-10-03) — AD directory LDAP sync. The route layer triggers
// sync + reads snapshot tables; the heavy lifting (LDAP bind, paged
// search, UPSERT, orphan DELETE) lives in services/ad-directory-sync.js.
// Encryption helper resolveBindPassword handles the system_config
// ad_bind_password round-trip.
import { syncDirectory, resolveBindPassword, resolveBindPasswordFromForest, deriveSecretKey } from '../services/ad-directory-sync.js';
import { maskAdLdapUrlForRead } from '../services/config.js';

// R158.44.7.3 (2026-10-04) — ensureLdapPort. R158.44.2 实现时只让 caller 透传
// effective.ldapUrl, 但没补 forest.adUrl 的端口兜底. 操作员在 ForestRegistry
// Tab 1 填 ldap://host 时常忘 :389/:636, service 端 preflight (regex 必须
// 有端口) reject → sync preflight fail. 之前 R158.44.7 inherit 脚本 (diag
// 端) 单独 ensurePort, 但 trigger 路径没补. 一处兜底, 永不缺端口.
function ensureLdapPort(url) {
  if (!url || typeof url !== 'string') return url;
  if (/:\d+\/?$/.test(url)) return url;
  const isLdaps = /^ldaps:\/\//i.test(url);
  return `${url.replace(/\/+$/, '')}:${isLdaps ? 636 : 389}`;
}

// R158.44.7.7 (2026-10-05) — The 3 snapshot tables' `dc_name` column was
// renamed `domain_name` and now stores the domain FQDN (e.g.
// 'sphkdl.shaphar.net') rather than the DC hostname that ran the LDAP bind.
// Frontend routes still receive `dcName` (URL param semantics unchanged for
// the operator) and look up the corresponding domain. If no
// ad_forest_dc_assignment row links this DC to a domain, the function falls
// back to returning the input string so queries degrade to "no rows" (rather
// than throwing) which is friendlier when the operator is exploring
// unassigned DCs in a sandbox.
async function hostnameToDomainName(db, isMssql, dcName) {
  if (!dcName) return dcName;
  const sql = isMssql
    ? `SELECT TOP 1 fd.domain_name
         FROM ad_dcs d
         LEFT JOIN ad_forest_dc_assignment a ON a.dc_hostname = d.dc_name
         LEFT JOIN ad_forest_domain fd ON fd.id = a.domain_id
        WHERE d.dc_name = ?`
    : `SELECT fd.domain_name
         FROM ad_dcs d
         LEFT JOIN ad_forest_dc_assignment a ON a.dc_hostname = d.dc_name
         LEFT JOIN ad_forest_domain fd ON fd.id = a.domain_id
        WHERE d.dc_name = ?
        LIMIT 1`;
  try {
    const { rows } = await db.execute(sql, [dcName]);
    return rows?.[0]?.domain_name || dcName;
  } catch {
    return dcName;
  }
}
// R158.37 (2026-10-03) - AD Forest Registry service. Backend "Forest
// Registry" CRUD over 4 physical tables (ad_forest / ad_forest_domain /
// ad_forest_dc_assignment / ad_forest_setting). bind_password goes
// through ad-credential-vault.js for AES-256-GCM encryption.
import * as forestRegistry from '../services/ad-forest-registry.js';

// Snake -> camel rename for known columns in admin responses.
const CAML_MAP = new Map([
  ['role_name', 'roleName'],
  ['last_login_at', 'lastLoginAt'],
  ['created_at', 'createdAt'],
  ['user_id', 'userId'],
  ['config_key', 'configKey'],
  ['config_value', 'configValue'],
  ['updated_at', 'updatedAt'],
  ['updated_by', 'updatedBy'],
  ['link_count', 'linkCount'],
  ['error_count', 'errorCount'],
  ['last_seen', 'lastSeen'],
  ['site_name', 'siteName'],
  ['region_code', 'regionCode'],
  ['is_hub', 'isHub'],
  ['sort_order', 'sortOrder'],
  ['old_value', 'oldValue'],
  ['new_value', 'newValue'],
  ['change_type', 'changeType'],
  ['changed_at', 'changedAt'],
  ['changed_by', 'changedBy'],
  ['changed_by_username', 'changedByUsername'],
  ['token_version', 'tokenVersion']
]);

function camelRow(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const nk = CAML_MAP.get(k) ?? k;
    out[nk] = v;
  }
  return out;
}

// R158.35 — DB snake_case → wire camelCase mappers for the four new
// snapshot tables. Each helper is per-table because the columns are
// different (no shared shape). Booleans (BIT/TINYINT 0/1) become
// JavaScript booleans so the Vue template can use v-if without
// string-comparing "1".
// R158.44.7.7 (2026-10-05) — `dc_name` -> `domain_name` (FQDN). We
// surface it as `domainName` on the wire so the Vue code that switched
// off `dcName` keeps working; the original `dcName` (DC hostname) is
// also filled in from the route's request param so legacy views still
// have something to display in their existing slots.
function userRowToWire(r, dcNameFallback) {
  if (!r) return r;
  return {
    sam: r.sam,
    displayName: r.display_name,
    distinguishedName: r.distinguished_name,
    ouDn: r.ou_dn,
    enabled: r.enabled == null ? null : Boolean(Number(r.enabled)),
    lockedOut: r.locked_out == null ? null : Boolean(Number(r.locked_out)),
    lastLogon: r.last_logon,
    whenCreated: r.when_created,
    passwordLastSet: r.password_last_set,
    userAccountControl: r.user_account_control == null ? null : Number(r.user_account_control),
    description: r.description,                            // R158.36
    managerDn: r.manager_dn,                              // R158.36 (2026-10-03)
    managerSam: r.manager_sam,                            // R158.36
    domainName: r.domain_name,
    dcName: r.domain_name || dcNameFallback || null,      // back-compat: frontend still uses dcName slot
    snapshotAt: r.snapshot_at,
    snapshotRunId: r.snapshot_run_id == null ? null : Number(r.snapshot_run_id)
  };
}
function groupRowToWire(r, dcNameFallback) {
  if (!r) return r;
  return {
    name: r.name,
    samAccountName: r.sam_account_name,
    distinguishedName: r.distinguished_name,
    ouDn: r.ou_dn,                                        // R158.44.7.7 — group->OU tree
    groupType: r.group_type == null ? null : Number(r.group_type),
    groupScope: r.group_scope,
    description: r.description,
    memberCount: r.member_count == null ? null : Number(r.member_count),
    domainName: r.domain_name,
    dcName: r.domain_name || dcNameFallback || null,
    snapshotAt: r.snapshot_at,
    snapshotRunId: r.snapshot_run_id == null ? null : Number(r.snapshot_run_id)
  };
}
function ouRowToWire(r, dcNameFallback) {
  if (!r) return r;
  return {
    distinguishedName: r.distinguished_name,
    name: r.name,
    description: r.description,
    whenCreated: r.when_created,
    whenChanged: r.when_changed,
    parentDn: r.parent_dn,
    domainName: r.domain_name,
    dcName: r.domain_name || dcNameFallback || null,
    snapshotAt: r.snapshot_at,
    snapshotRunId: r.snapshot_run_id == null ? null : Number(r.snapshot_run_id)
  };
}
// R158.44.7.10 (2026-10-05) — computer row wire shape.
// mirrors userRowToWire (camel + derived booleans from BIT columns).
function computerRowToWire(r, dcNameFallback) {
  if (!r) return r;
  return {
    samAccountName: r.sam_account_name,
    cn: r.cn,
    name: r.name,
    distinguishedName: r.distinguished_name,
    ouDn: r.ou_dn,
    enabled: r.enabled == null ? null : Boolean(Number(r.enabled)),
    isServer: r.is_server == null ? null : Boolean(Number(r.is_server)),
    operatingSystem: r.operating_system,
    operatingSystemVersion: r.operating_system_version,
    dnsHostName: r.dns_host_name,
    lastLogon: r.last_logon,
    whenCreated: r.when_created,
    whenChanged: r.when_changed,
    description: r.description,
    managedByDn: r.managed_by_dn,
    managedBySam: r.managed_by_sam,
    domainName: r.domain_name,
    dcName: r.domain_name || dcNameFallback || null,        // back-compat
    snapshotAt: r.snapshot_at,
    snapshotRunId: r.snapshot_run_id == null ? null : Number(r.snapshot_run_id)
  };
}
function runRowToWire(r) {
  if (!r) return r;
  return {
    id: Number(r.id),
    dcName: r.dc_name,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status,
    userCount: r.user_count == null ? null : Number(r.user_count),
    groupCount: r.group_count == null ? null : Number(r.group_count),
    ouCount: r.ou_count == null ? null : Number(r.ou_count),
    errorMessage: r.error_message,
    triggeredBy: r.triggered_by,
    // R158.38 — binding-aware runs shape (listRunsWithForest JOIN ad_forest +
    // ad_forest_domain). 老 listRuns SQL 没这两列, undefined OK (UI 容错).
    forestId: r.forest_id == null ? null : Number(r.forest_id),
    domainId: r.domain_id == null ? null : Number(r.domain_id),
    forestName: r.forest_name || null,
    domainName: r.domain_name || null
  };
}

export function adminRouter({ config, logger, db }) {
  const r = Router();
  // db is required (Task 5: userAuth reads token_version/status per request).
  // We resolve `db` lazily via getDb() when the caller didn't pass one — every
  // tests + production wire has getDb() available.
  const _db = db ?? getDb();
  // R158.5 (2026-10-04) — listRunsWithForest / insertRunWithForest 在 sql.js
  // 是字符串而非 {mysql, mssql} dict, 直接 [...][dialect] 拿到 undefined 抛
  // 'Cannot read properties of undefined (reading replace)'. 用 _pick 同时
  // 支持 dict 与字符串.
  const _pick = (sqlStr, fallback) => {
    if (sqlStr && typeof sqlStr === 'object' && sqlStr[_db.dialect] != null) return sqlStr[_db.dialect];
    return fallback || sqlStr;
  };
  // 2026-09-09 S82 (security) — per-permission auth chains. The legacy
  // `admin:users` was an umbrella permission that gated user CRUD +
  // file-push + member-commands + AD admin + secret rotation. We've
  // split it into per-domain perms; legacy `admin:users` still grants
  // all of them via _hasPerm in auth/rbac.js (no migration needed).
  //
  // Each route below declares which specific permission it requires.
  // Tests asserting the matrix live in tests/routes/admin-rbac.test.js.
  const baseAuth = [userAuth({ db: _db, logger })];
  const authUsers       = [...baseAuth, requirePerm('admin:users')];
  const authAdObjects   = [...baseAuth, requirePerm('admin:ad-objects')];
  const authFilePush    = [...baseAuth, requirePerm('admin:file-push')];
  const authPackages    = [...baseAuth, requirePerm('admin:packages')];
  const authMemberSrv   = [...baseAuth, requirePerm('admin:member-servers')];
  const authConfig      = [...baseAuth, requirePerm('admin:config')];
  // Routes that need ANY of multiple perms use requireAnyPerm below.

  // Backward-compat alias — existing tests / callers that imported `auth`
  // expecting the admin:users chain still resolve to the same chain.
  const auth_adminUsers = authUsers;

  r.get('/api/admin/roles', authUsers, async (_req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.roles.list);
      const out = rows.map(row => ({
        id: row.id,
        roleName: row.role_name,
        permissions: row.permissions
          ? row.permissions.split(',').map(s => s.trim()).filter(Boolean)
          : []
      }));
      res.json(out);
    } catch (e) {
      logger.error({ err: e }, 'admin roles failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  r.get('/api/admin/users', authUsers, async (_req, res) => {
    try {
      const rs = await listUsers();
      res.json(rs.map(camelRow));
    } catch (e) {
      logger.error({ err: e }, 'admin users list failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  r.post('/api/admin/users', authUsers, async (req, res) => {
    try {
      const { username, password, roleId, status } = req.body || {};
      if (!username || !password || roleId == null) {
        return res.status(400).json({ error: 'missing fields' });
      }
      const existing = await findByUsername(username);
      if (existing) {
        return res.status(409).json({ error: 'username exists' });
      }
      await createUser({ username, password, roleId, status });
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'create_user',
        target: username,
        payload: { username, roleId, status: status ?? 1 },
        logger
      });
      res.status(201).json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'admin user create failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  r.put('/api/admin/users/:id', authUsers, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { password, roleId, status } = req.body || {};
      await updateUser(id, { password, roleId, status });
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'update_user',
        target: String(id),
        payload: req.body || {},
        logger
      });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'admin user update failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  r.delete('/api/admin/users/:id', authUsers, async (req, res) => {
    try {
      const id = Number(req.params.id);
      await deleteUser(id);
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'delete_user',
        target: String(id),
        payload: null,
        logger
      });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'admin user delete failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // I1: operator force-revoke every outstanding JWT for a user. Reads the
  // pre-bump token_version so the audit row records both old and new; bumps
  // +1 via bumpTokenVersion; writes a revoke_user_tokens audit row (the ONE
  // trigger that gets its own audit action — the other 3 JWT-invalidating
  // triggers piggyback on update_user). No tx enrollment: bumpTokenVersion
  // commits via the global db, and the audit row is best-effort (caught +
  // warn-logged inside writeAudit). Per `feedback_writeaudit_signature.md`
  // the audit signature is (args, logger, tx); passing no tx is correct
  // here because the data write commits via the global facade.
  r.post('/api/admin/users/:id/revoke-tokens', authUsers, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const db = getDb();
      const { rows: before } = await db.query(db.sql.users.getTokenVersion, [id]);
      const prev = Number(before[0]?.token_version ?? 0);
      const next = await bumpTokenVersion(id);
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'revoke_user_tokens',
        target: String(id),
        payload: { oldTokenVersion: prev, newTokenVersion: next },
        logger
      });
      res.json({ ok: true, tokenVersion: next });
    } catch (e) {
      logger.error({ err: e }, 'admin user revoke-tokens failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  r.get('/api/admin/config', authConfig, async (_req, res) => {
    try {
      const cfg = await getConfig();
      // Surface a `restartRequired` block so the ConfigView can render the
      // "重启生效" badge without a second round-trip. Computed from the two
      // version hashes written by the PUT handler (pending) and the bootstrap
      // IIFE in server.js (started) — see restartRequired() in
      // services/config.js for the exact contract.
      const rr = await restartRequired();
      // serverIp is the fallback host for the "Agent 连接地址" derived row
      // when `access_domain` is empty — ConfigView picks
      // `<access_domain or serverIp>:<listenPort>`. Computed from
      // os.networkInterfaces() (utils/network.js); cheap enough to compute
      // per-request but stable for the process lifetime. Cheap enough that
      // we don't bother memoizing.
      res.json({ ...cfg, restartRequired: rr, serverIp: getPrimaryIPv4() });
    } catch (e) {
      logger.error({ err: e }, 'admin config get failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  r.put('/api/admin/config', authConfig, async (req, res) => {
    try {
      const updates = req.body || {};
      // Strip smtp_password from the audit payload — putConfig already redacts
      // it on the sys_config_audit row, but the broader audit_logs row would
      // otherwise carry the cleartext through writeAudit's JSON.stringify.
      const { smtp_password: _omit, ...safeUpdates } = updates;
      void _omit;
      // C8 fix: validate listenPort before touching the DB. Bad values
      // (out-of-range, non-integer, junk strings) would persist and lock the
      // service out on next restart — NSSM AppExit=Default Restart would loop
      // until the operator manually recovers. Reject up-front with a clear
      // 400 so the UI shows the error instead of silently saving a value
      // that bricks the service.
      //
      // Accept both numbers and digit-only strings (UI form inputs are
      // text); reject floats, NaN, junk like 'abc', and out-of-range.
      if ('listenPort' in updates) {
        const lp = Number(updates.listenPort);
        if (!Number.isInteger(lp) || lp < 1024 || lp > 65535) {
          return res.status(400).json({
            error: `listenPort must be an integer in 1024..65535; got ${JSON.stringify(updates.listenPort)}`
          });
        }
      }
      const db = getDb();
      let auditCount = 0;
      let listenPortBumped = false;
      await db.transaction(async (tx) => {
        // Read the pre-image INSIDE the transaction so the listenPort change
        // detection uses the same snapshot as the audit row's before-value.
        const before = {};
        const { rows } = await tx.query(db.sql.config.getAll);
        for (const row of rows) before[row.config_key] = row.config_value;
        const auditRows = await putConfigWithin(tx, updates, req.user?.sub ?? null);
        auditCount = auditRows.length;
        // listenPort is a boot-time binding — the running process can't pick
        // up a new value without a restart. Bump the pending version hash
        // inside the same transaction so ConfigView's badge flips to
        // "restart required" the moment the save commits (server-side logic,
        // not something the frontend has to remember).
        if ('listenPort' in updates && String(updates.listenPort) !== String(before.listenPort)) {
          const pending = sha256Hex(`${new Date().toISOString()}:${updates.listenPort}`);
          await tx.execute(
            db.sql.config.upsert,
            ['center_listen_port_pending_version', pending]
          );
          listenPortBumped = true;
        }
        // Outer audit_logs row is enrolled in the same tx as the data writes
        // (C1 fix): a commit that flips system_config must also commit the
        // matching audit row — a half-committed config change with no audit
        // trail is what compliance reviewers flag. writeAudit re-throws on
        // failure when given a tx, so a transient audit table hiccup rolls
        // the whole save back rather than silently leaving the system in an
        // untracked state.
        await writeAudit({
          userId: req.user?.sub ?? null,
          action: 'update_config',
          target: 'system_config',
          payload: { ...safeUpdates, auditCount },
          logger
        }, logger, tx);
      });
      void listenPortBumped;
      res.json({ ok: true, auditCount });
    } catch (e) {
      // #167 follow-up fix-now: services/config.js throws { httpStatus: 400 }
      // when the legacy `ad_agent_token` key is written with a value different
      // from the current row (I1 Option B — operators must use
      // /api/admin/agent-token/rotate instead). Mirror the pattern from the
      // 5 other admin catch blocks in this file (lines 550, 562, 603, 893, 907)
      // so the actionable 400 surfaces to curl callers / future legacy UI
      // re-saves instead of being silently downgraded to a generic 500.
      if (e.httpStatus === 400) return res.status(400).json({ error: e.message });
      logger.error({ err: e }, 'admin config update failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // C8 fix: explicit restart endpoint. PUT /api/admin/config may bump the
  // listenPort pending_version hash (or any future boot-time binding).
  // Until now the operator had to manually bounce the NSSM service — easy
  // to forget and the dashboard kept running with stale config. This
  // endpoint lets ConfigView offer a "Restart Now" button that exits the
  // process; NSSM AppExit Default Restart picks the new appsettings.json up
  // on relaunch. We audit the action before exit so a "who restarted the
  // service" question has a deterministic answer.
  r.post('/api/admin/restart', authConfig, async (req, res) => {
    try {
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'restart_service',
        target: 'center',
        payload: { requestedBy: req.user?.username ?? req.user?.sub ?? null },
        logger
      });
      // Send response first, then exit. setImmediate defers process.exit
      // until the res.json body has been flushed to the socket — otherwise
      // NSSM AppExit Default Restart would race the kernel TCP buffer flush
      // and the operator's UI would hang on the request.
      res.json({ ok: true, message: 'restart initiated; NSSM will relaunch' });
      setImmediate(() => process.exit(0));
    } catch (e) {
      logger.error({ err: e }, 'admin restart failed');
      // Don't exit on audit-failure — operator still has a way forward.
      // Fall back to a 500 so the UI shows the error.
      if (!res.headersSent) {
        res.status(500).json({ error: '内部错误' });
      }
    }
  });

  // ----- Agent-token rotation (Task 5 — I3) -----
  // Three endpoints that manage the dual-key agent token rotation lifecycle.
  // The middleware factory (auth/agent-token.js) compares the supplied
  // X-Agent-Token header against both `agent_token_current` and
  // `agent_token_previous` so existing agents can keep using the old token
  // while the operator rolls the new one out. These three endpoints drive
  // the lifecycle: rotate issues a new token + stashes the old one as
  // previous; commit clears previous once every agent has switched over;
  // GET exposes mode/rotatedAt/previousExpiresAt/ttlDays for the UI
  // (NEVER the secret — that's only returned by /rotate and only to the
  // operator who hit the button). All three call invalidateAgentTokenCache
  // after a write so the very next agent request sees the new state.
  //
  // Use `_db` (the adminRouter-level db facade) so tests that pre-set the
  // db via `adminRouter({ db: mock })` don't need a global getDb() init —
  // matches the same pattern userAuth uses at the top of this file.
  r.post('/api/admin/agent-token/rotate', authConfig, async (req, res) => {
    try {
      const out = await rotateAgentToken(_db, {
        logger,
        userId: req.user?.sub ?? null
      });
      invalidateAgentTokenCache();
      // 2026-08-21 UX redesign: include version so the modal's progress
      // counter can match against ad_agent_heartbeat.agent_token_version
      // for the "已推送到 X / N 台 Agent" line.
      res.json({ newToken: out.newToken, rotatedAt: out.rotatedAt, version: out.version });
    } catch (e) {
      logger.error({ err: e }, 'agent token rotate failed');
      res.status(500).json({ error: 'rotate failed' });
    }
  });

  r.post('/api/admin/agent-token/commit', authConfig, async (req, res) => {
    try {
      await commitAgentToken(_db, {
        logger,
        userId: req.user?.sub ?? null
      });
      invalidateAgentTokenCache();
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'agent token commit failed');
      res.status(500).json({ error: 'commit failed' });
    }
  });

  r.get('/api/admin/agent-token', authConfig, async (_req, res) => {
    try {
      const s = await getAgentTokenState(_db);
      // 2026-08-21 UX redesign: drop operator-facing TTL fields. The
      // internal 5-minute grace is fixed (services/agent-token.js
      // INTERNAL_GRACE_MS) and not surfaced; previousExpiresAt would only
      // confuse operators who read it as a "policy" they can change.
      // version is included so the ConfigView can pass it to the modal
      // for the progress-counter match.
      res.json({
        mode: s.previous ? 'dual' : 'single',
        rotatedAt: s.rotatedAt || null,
        version: s.version
      });
    } catch (e) {
      logger.error({ err: e }, 'agent token state get failed');
      res.status(500).json({ error: 'state get failed' });
    }
  });

  // Reveal the active agent auth token. Unlike /rotate this does NOT mutate
  // system_config — operators use this when onboarding a new agent
  // (paste into appsettings.json) without invalidating existing agents.
  // Every call writes a high-severity security audit row (see services/
  // audit-classifier.js reveal_agent_token) so the "who read the live
  // credential when" question has a deterministic answer.
  r.get('/api/admin/agent-token/reveal', authConfig, async (req, res) => {
    try {
      const out = await revealAgentToken(_db, {
        logger,
        userId: req.user?.sub ?? null
      });
      // 2026-08-21: include version so the 复制令牌 button (which uses this
      // same endpoint) can stamp the operator's clipboard payload with the
      // version they're seeing — useful when cross-referencing against the
      // delivery counter.
      res.json({ token: out.token, revealedAt: out.revealedAt, version: out.version });
    } catch (e) {
      logger.error({ err: e }, 'agent token reveal failed');
      res.status(500).json({ error: 'reveal failed' });
    }
  });

  // 2026-08-21 UX redesign (auto-delivery): read-only snapshot of every
  // agent's last-reported agent_token_version, plus the server's current
  // version. Powers the "已推送到 X / N 台 Agent" counter in the generate
  // modal. An agent with reportedVersion == serverVersion has picked up
  // the new token; a lower version means it's still on the old token
  // (either because its next heartbeat hasn't fired, or it's offline).
  // No audit row — read-only query, same shape as the heartbeat-report
  // admin endpoints above.
  r.get('/api/admin/agent-token/delivery', authConfig, async (_req, res) => {
    try {
      const db = getDb();
      const [tokenState, { rows: agents }] = await Promise.all([
        getAgentTokenState(_db),
        db.query(db.sql.heartbeat.tokenDeliveryList)
      ]);
      const total = agents.length;
      const delivered = agents.filter(r => Number(r.agent_token_version) >= tokenState.version).length;
      res.json({
        serverVersion: tokenState.version,
        total,
        delivered,
        agents: agents.map(r => ({
          agentId: r.agent_id,
          reportedVersion: Number(r.agent_token_version) || 0,
          lastSeenAt: r.last_heartbeat_at
        }))
      });
    } catch (e) {
      logger.error({ err: e }, 'agent token delivery list failed');
      res.status(500).json({ error: 'delivery list failed' });
    }
  });

  // ----- R158.13 client-settings push (heartbeat 60s → 30s etc.) -----
  // Three endpoints that manage the appsettings tunables the centre can
  // push to online agents via heartbeat response. Pattern is parallel to
  // agent-token (rotate/commit/state) but the "commit" step is implicit
  // — every agent picks up the patch on its very next heartbeat, there's
  // no dual-key grace window because settings are not security-sensitive
  // (agentToken is the security-sensitive credential; this is just timing).
  //
  // POST /push: bump version + merge patch into system_config.
  // GET  /state: current server-side state (settings + version).
  // GET  /delivery: per-agent reported version for the "已推送到 X / N"
  //   progress counter (mirrors /api/admin/agent-token/delivery).

  r.post('/api/admin/client-settings/push', authConfig, async (req, res) => {
    try {
      // Validate FIRST so a 400 doesn't bump version. Bad input → audit
      // log via the surrounding 500 path is fine; version stays put and
      // a subsequent valid push increments as normal.
      const v = validateSettingsPatch(req.body?.patch);
      if (!v.ok) {
        return res.status(400).json({ error: v.error });
      }
      const out = await bumpAgentSettings(_db, {
        logger,
        userId: req.user?.sub ?? null,
        newPatch: v.patch
      });
      res.json({ ok: true, version: out.version, settings: out.settings });
    } catch (e) {
      logger.error({ err: e }, 'client settings push failed');
      res.status(500).json({ error: 'push failed' });
    }
  });

  r.get('/api/admin/client-settings/state', authConfig, async (_req, res) => {
    try {
      const s = await getAgentSettingsState(_db);
      res.json(s);
    } catch (e) {
      logger.error({ err: e }, 'client settings state read failed');
      res.status(500).json({ error: 'read failed' });
    }
  });

  r.get('/api/admin/client-settings/delivery', authConfig, async (_req, res) => {
    try {
      const db = getDb();
      const [settingsState, { rows: agents }] = await Promise.all([
        getAgentSettingsState(_db),
        db.query(db.sql.heartbeat.clientSettingsList)
      ]);
      const total = agents.length;
      const delivered = agents.filter(
        (r) => Number(r.client_settings_version) >= settingsState.version
      ).length;
      res.json({
        serverVersion: settingsState.version,
        total,
        delivered,
        agents: agents.map((r) => ({
          agentId: r.agent_id,
          reportedVersion: Number(r.client_settings_version) || 0,
          lastSeenAt: r.last_heartbeat_at
        }))
      });
    } catch (e) {
      logger.error({ err: e }, 'client settings delivery list failed');
      res.status(500).json({ error: 'delivery list failed' });
    }
  });

  // ----- JWT secret rotation (I9 — Task 5) -----
  // Three endpoints that manage the dual-key JWT secret rotation lifecycle.
  // The middleware factory (auth/user-auth.js) compares the bearer token
  // against both `jwt_secret_current` and `jwt_secret_previous` so existing
  // user sessions stay valid while the operator rolls the new secret out.
  // These three endpoints drive the lifecycle: rotate generates a new
  // secret + stashes the old one as previous; commit clears previous once
  // every user has refreshed their session (i.e. re-logged-in); GET exposes
  // mode/rotatedAt/previousExpiresAt/ttlDays for the UI (NEVER the secret
  // — that's only returned by /rotate and only to the operator who hit the
  // button). All three call invalidateJwtSecretCache after a write so the
  // very next request sees the new state.
  //
  // Use `_db` (the adminRouter-level db facade) so tests that pre-set the
  // db via `adminRouter({ db: mock })` don't need a global getDb() init —
  // matches the same pattern userAuth uses at the top of this file.
  r.post('/api/admin/jwt-secret/rotate', authConfig, async (req, res) => {
    try {
      const out = await rotateJwtSecret(_db, {
        logger,
        userId: req.user?.sub ?? null
      });
      invalidateJwtSecretCache();
      res.json({ newSecret: out.newSecret, rotatedAt: out.rotatedAt });
    } catch (e) {
      logger.error({ err: e }, 'jwt secret rotate failed');
      res.status(500).json({ error: 'rotate failed' });
    }
  });

  r.post('/api/admin/jwt-secret/commit', authConfig, async (req, res) => {
    try {
      await commitJwtSecret(_db, {
        logger,
        userId: req.user?.sub ?? null
      });
      invalidateJwtSecretCache();
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'jwt secret commit failed');
      res.status(500).json({ error: 'commit failed' });
    }
  });

  r.get('/api/admin/jwt-secret', authConfig, async (_req, res) => {
    try {
      const s = await getJwtSecretState(_db);
      res.json({
        mode: s.previous ? 'dual' : 'single',
        rotatedAt: s.rotatedAt || null,
        previousExpiresAt: s.previousExpiresAt || null,
        ttlDays: s.ttlDays
      });
    } catch (e) {
      logger.error({ err: e }, 'jwt secret state get failed');
      res.status(500).json({ error: 'state get failed' });
    }
  });

  r.get('/api/admin/config/audit', authConfig, async (_req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.config.audit.list);
      // Redact smtp_password on the read path: putConfig now stores the masked
      // sentinel on new audit rows, but rows written before T12 fix1 may still
      // contain cleartext. Mask both old/new values when the row's config_key
      // is the SMTP password so the UI never sees cleartext via this endpoint.
      const MASK = '********';
      const redacted = rows.map(r => {
        if (r.config_key === 'smtp_password') {
          return { ...r, old_value: MASK, new_value: MASK };
        }
        return r;
      });
      res.json(redacted.map(camelRow));
    } catch (e) {
      logger.error({ err: e }, 'admin config audit list failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  r.post('/api/admin/config/rollback', authConfig, async (req, res) => {
    try {
      const auditId = Number(req.body?.auditId);
      if (!Number.isInteger(auditId) || auditId <= 0) return res.status(400).json({ error: 'auditId required' });
      const db = getDb();
      let result = null;
      await db.transaction(async (tx) => {
        const { rows } = await tx.query(db.sql.config.audit.getById, [auditId]);
        if (rows.length === 0) { result = { notFound: true }; return; }
        const audit = rows[0];
        // Refuse to roll back a row whose old_value is the masked sentinel —
        // there's no real password to restore, and writing '********' back
        // would clobber whatever the operator has since saved.
        if (audit.config_key === 'smtp_password' && audit.old_value === '********') {
          result = { error: 'cannot rollback a masked smtp_password audit row' };
          return;
        }
        // R158.56c (2026-10-09) — tx wrapper 没暴露 dialect, 改用闭包外 db.dialect.
        // 修复前直接写 UTC_TIMESTAMP() 在 MSSQL 报 "'UTC_TIMESTAMP' is not a recognized
        // built-in function name". 同样的真因也存在于 admin.js:2851 (interval-minutes).
        await tx.execute(
          db.dialect === 'mssql'
            ? 'UPDATE system_config SET config_value = ?, updated_at = SYSUTCDATETIME() WHERE config_key = ?'
            : 'UPDATE system_config SET config_value = ?, updated_at = UTC_TIMESTAMP() WHERE config_key = ?',
          [audit.old_value, audit.config_key]
        );
        // Redact the password on the audit-trail write too — the rollback
        // row would otherwise carry cleartext if the source row's new_value
        // was the real password (rows written before T12 fix1).
        const auditOld = audit.config_key === 'smtp_password' ? '********' : audit.new_value;
        const auditNew = audit.config_key === 'smtp_password' ? '********' : audit.old_value;
        await tx.execute(db.sql.config.audit.write, [audit.config_key, auditOld, auditNew, req.user?.sub ?? null, 'ROLLBACK']);
        // Redact the response payload too so the UI never sees cleartext.
        const responseValue = audit.config_key === 'smtp_password' ? '********' : audit.old_value;
        result = { configKey: audit.config_key, newValue: responseValue };
      });
      if (!result) return res.status(500).json({ error: '内部错误' });
      if (result.notFound) return res.status(404).json({ error: 'audit not found' });
      if (result.error) return res.status(400).json({ error: result.error });
      res.json({ ok: true, ...result });
    } catch (e) {
      logger.error({ err: e }, 'admin config rollback failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // ----- SMTP test-mail (Task 12) -----
  // Sends a one-off test email using the currently-saved SMTP config. The
  // SMTP password is read from system_config directly (NOT through getConfig,
  // which masks) so the real credential is handed to nodemailer. The real
  // password must never appear in the response or logs — only the boolean
  // outcome and an error string on failure.
  //
  // Tests pass `_deps.createTransport` (a sinon-style fake transport) so they
  // can assert the auth.pass value reached the SMTP layer without opening a
  // real socket. Real callers omit `_deps` and email.send falls back to
  // nodemailer.createTransport.
  //
  // R158.16 (2026-10-01) -- email 总开关拦截 (L1). 即便操作员手动点
  // "测试邮件", 总开关关闭时也拒绝 SMTP 调用 (operator 原话: "邮件开关
  // 没开, 所有的邮件操作都不触发"). email.send() 内还有 L2 兜底, 双保险.
  r.post('/api/admin/config/email/test', authConfig, async (req, res) => {
    try {
      // L1: 总开关检查 — 关闭时直接拒绝. 先读 system_config.email_enabled,
      // 缺行 fallback '0' = 关闭 (防御). email.send() 仍有 L2 兜底防未来
      // 路径绕过.
      const cfgForGate = await getConfig();
      const emailEnabled = String(cfgForGate?.email_enabled ?? '0') === '1';
      if (!emailEnabled) {
        return res.status(403).json({
          error: '邮件功能已关闭,请在系统设置 → 告警阈值 → 邮件总开关 中先启用'
        });
      }
      const to = req.body?.to;
      if (!to) return res.status(400).json({ error: 'to is required' });
      // Read the SMTP bundle directly without the mask — the test-mail
      // route needs the real password to authenticate with the SMTP server.
      // Use the same SQL the masked getConfigAll() would use; bypass the
      // mask by reading rows directly via db.query.
      const db = getDb();
      const { rows } = await db.query(db.sql.config.getAll);
      const cfg = {};
      for (const row of rows) cfg[row.config_key] = row.config_value;
      const smtp = {
        smtp_host: cfg.smtp_host,
        smtp_port: Number(cfg.smtp_port) || 25,
        smtp_secure: String(cfg.smtp_secure) === 'true',
        smtp_user: cfg.smtp_user,
        smtp_password: cfg.smtp_password
      };
      const _deps = req.app.locals.__smtpTestDeps || undefined;
      const r2 = await email.send({
        smtp,
        from: cfg.smtp_from,
        to,
        subject: 'AD Dashboard test',
        text: 'Test email.'
      }, _deps);
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'test_smtp_email',
        target: to,
        payload: { ok: r2.ok, error: r2.error ?? null },
        logger
      });
      res.status(r2.ok ? 200 : 500).json({ ok: r2.ok, error: r2.error ?? null });
    } catch (e) {
      logger.error({ err: e }, 'admin email test failed');
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  r.get('/api/admin/audit', authUsers, async (req, res) => {
    try {
      const { listAudit } = await import('../services/audit.js');
      const { category, action, severity, userId, from, to, page = 1, size = 100 } = req.query;
      const pageNum = Number(page);
      const sizeNum = Number(size);
      if (!Number.isInteger(pageNum) || pageNum < 1) return res.status(400).json({ error: 'invalid page' });
      if (!Number.isInteger(sizeNum) || sizeNum < 1 || sizeNum > 100) return res.status(400).json({ error: 'size must be 1..100' });
      const result = await listAudit({
        category,
        actions: action ? String(action).split(',') : undefined,
        severities: severity ? String(severity).split(',') : undefined,
        userId: userId ? Number(userId) : undefined,
        from, to,
        page: pageNum,
        size: sizeNum
      });
      res.json(result);
    } catch (e) {
      if (e.httpStatus === 400) return res.status(400).json({ error: e.message });
      logger.error({ err: e }, 'admin audit list failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  r.get('/api/admin/audit/badge', authUsers, async (req, res) => {
    try {
      const { getAuditBadge } = await import('../services/audit.js');
      const count = await getAuditBadge(req.query.category);
      res.json({ category: req.query.category, count });
    } catch (e) {
      if (e.httpStatus === 400) return res.status(400).json({ error: e.message });
      logger.error({ err: e }, 'admin audit badge failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  const EXPORT_CAP = 50000;

  r.get('/api/admin/audit/export', authUsers, async (req, res) => {
    try {
      const { listAudit } = await import('../services/audit.js');
      const format = req.query.format;
      if (format !== 'json' && format !== 'csv') {
        return res.status(400).json({ error: 'format must be json or csv' });
      }
      const { category, action, severity, userId, from, to } = req.query;
      const opts = {
        category,
        actions: action ? String(action).split(',') : undefined,
        severities: severity ? String(severity).split(',') : undefined,
        userId: userId ? Number(userId) : undefined,
        from, to
      };
      // Probe total first (page 1, size 1) — reuses listAudit's filter SQL.
      const probe = await listAudit({ ...opts, page: 1, size: 1 });
      if (probe.total > EXPORT_CAP) {
        return res.status(413).json({ error: `导出行数 ${probe.total} 超过上限 ${EXPORT_CAP}，请先用过滤器缩小范围` });
      }
      // The export cap is enforced by the probe above; the fetch intentionally bypasses the list-route size limit.
      const full = await listAudit({ ...opts, page: 1, size: EXPORT_CAP + 1 });
      const ts = formatTsForFilename(new Date());
      const filename = `audit-${category || 'all'}-${ts}.${format}`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      if (format === 'json') {
        res.setHeader('Content-Type', 'application/json');
        res.send(JSON.stringify(full.rows, null, 2));
      } else {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.send(toCsv(full.rows));
      }
    } catch (e) {
      if (e.httpStatus === 400) return res.status(400).json({ error: e.message });
      logger.error({ err: e }, 'admin audit export failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // ----- Sites Catalog -----
  r.get('/api/admin/sites-catalog', authUsers, async (_req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.sites.listCatalog);
      res.json(rows.map(camelRow));
    } catch (e) {
      logger.error({ err: e }, 'sites-catalog list failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  r.post('/api/admin/sites-catalog', authUsers, async (req, res) => {
    const { siteName, regionCode, isHub, description } = req.body || {};
    if (!siteName) return res.status(400).json({ error: 'missing siteName' });
    try {
      const db = getDb();
      const result = await db.execute(db.sql.sites.create, [siteName, regionCode ?? null, isHub ? 1 : 0, description ?? null]);
      // C12 fix: single-row site create now writes an audit row. Previously
      // only the bulk import (POST .../bulk) was audited — single-row
      // creates were a silent gap that left no trail when an operator
      // added a site by hand.
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'create_site',
        target: siteName,
        payload: { siteName, regionCode: regionCode ?? null, isHub: isHub ? 1 : 0, description: description ?? null, id: result.insertId },
        logger
      });
      res.status(201).json({ id: result.insertId });
    } catch (e) {
      if (e.code === 'DUP_ENTRY') return res.status(409).json({ error: 'siteName already exists' });
      logger.error({ err: e }, 'sites-catalog create failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  r.put('/api/admin/sites-catalog/:id', authUsers, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的 id' });
    const { siteName, regionCode, isHub, description } = req.body || {};
    const fields = [];
    const params = [];
    if (siteName !== undefined)    { fields.push('site_name = ?');    params.push(siteName); }
    if (regionCode !== undefined)  { fields.push('region_code = ?');  params.push(regionCode); }
    if (isHub !== undefined)       { fields.push('is_hub = ?');       params.push(isHub ? 1 : 0); }
    if (description !== undefined) { fields.push('description = ?');  params.push(description); }
    if (fields.length === 0) return res.status(400).json({ error: 'no fields to update' });
    params.push(id);
    try {
      const db = getDb();
      const { affectedRows } = await db.execute(db.sql.sites.updatePartial(fields), params);
      if (affectedRows === 0) return res.status(404).json({ error: 'site not found' });
      // C12 fix: site rename / region / hub-flag change is now audited.
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'update_site',
        target: String(id),
        payload: { siteId: id, fieldsUpdated: fields.map(f => f.split(' ')[0]) },
        logger
      });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'sites-catalog update failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  r.delete('/api/admin/sites-catalog/:id', authUsers, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的 id' });
    try {
      const db = getDb();
      await db.execute(db.sql.sites.unbindDcs, [id]);
      const { affectedRows } = await db.execute(db.sql.sites.delete, [id]);
      if (affectedRows === 0) return res.status(404).json({ error: 'site not found' });
      // C12 fix: site drop is now audited. unbindDcs first detaches every DC
      // that pointed at this site — record that side-effect in the payload
      // so an operator looking at this row later can see the cascading impact.
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'delete_site',
        target: String(id),
        payload: { siteId: id, note: 'unbindDcs first detached every DC referencing this site' },
        logger
      });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'sites-catalog delete failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  r.post('/api/admin/sites-catalog/bulk', authUsers, async (req, res) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows) return res.status(400).json({ error: 'rows array required' });
    if (rows.length === 0) return res.status(400).json({ error: 'rows array empty' });
    const errors = [];
    let imported = 0;
    let skipped = 0;
    try {
      const db = getDb();
      // C2 fix: wrap the whole bulk import in a transaction so a mid-loop
      // failure rolls back every row we already wrote. Per-row audit rows
      // also enroll in the same tx — a partial commit (e.g. 50 of 200
      // sites written before a duplicate key blew up) is now impossible,
      // and each successful row produces an audit row that's atomic with
      // its upsert. Summary audit at the end captures batch-level counts.
      await db.transaction(async (tx) => {
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i] || {};
          const siteName = (r.siteName || '').trim();
          if (!siteName) {
            errors.push({ rowIndex: i, siteName: '', reason: 'siteName is required' });
            skipped++;
            continue;
          }
          const isHubVal = r.isHub === true || r.isHub === 1 || r.isHub === '1' || r.isHub === 'true' || r.isHub === 'yes' ? 1 : 0;
          await tx.execute(db.sql.sites.upsert, [
            siteName,
            r.regionCode ?? null,
            isHubVal,
            r.description ?? null
          ]);
          await writeAudit({
            userId: req.user?.sub ?? null,
            action: 'bulk_import_site_row',
            target: siteName,
            payload: { rowIndex: i, siteName, regionCode: r.regionCode ?? null, isHub: isHubVal },
            logger
          }, logger, tx);
          imported++;
        }
        await writeAudit({
          userId: req.user?.sub ?? null,
          action: 'bulk_import_sites',
          target: 'ad_sites',
          payload: { imported, skipped, total: rows.length },
          logger
        }, logger, tx);
      });
      res.json({ ok: true, imported, skipped, errors });
    } catch (e) {
      logger.error({ err: e }, 'sites-catalog bulk import failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // ----- DCs Catalog -----
  r.get('/api/admin/dcs-catalog', authAdObjects, async (_req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.dcs.listCatalog);
      // 2026-08-27 round-28.5 / round-29: surface isBridgehead too so the
      // operator UI's bridgehead toggle reflects current DB state on load.
      // R158.41 (2026-10-03) — surface forest_domain_id + forest_domain_name + forest_id
      // 让 DcsCatalogView 行级「域」下拉直接渲染.
      // R158.44.1 (2026-10-04) — wire shape fix: 前端 DcsCatalogView:280 走 d.data,
      // 一直返 [] (前端期望 {dcs: [...]} wrapper). 之前返裸数组与前端契约不一致,
      // 但页面依旧显示是因为当时 operator 从其它 matrix 页面查看 forest_domain_id.
      // 加 {dcs:[...]} wrapper 修对齐契约.
      res.json({
        dcs: rows.map(r => ({
          ...r,
          isPdc: !!r.isPdc, isGc: !!r.isGc, isRidMaster: !!r.isRidMaster,
          isSchemaMaster: !!r.isSchemaMaster, isDomainNamingMaster: !!r.isDomainNamingMaster,
          isInfrastructureMaster: !!r.isInfrastructureMaster,
          isBridgehead: !!r.isBridgehead,
          forestDomainId: r.forestDomainId == null ? null : Number(r.forestDomainId),
          forestId: r.forestId == null ? null : Number(r.forestId)
        }))
      });
    } catch (e) {
      logger.error({ err: e }, 'dcs-catalog list failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // R158.41 (2026-10-03) — DcsCatalogView 行级「域」下拉 PUT 端点.
  // body = { forestDomainId: number|null, forestId?: number }. null/undefined → unbind.
  // 仅改 forest_domain_id, 跨域绑定不限制 (R158.37.4 多对多 dc_assignment 仍可,
  // 本端点专管单选主路径).
  r.put('/api/admin/dcs-catalog/:dc_name/domain', authAdObjects, async (req, res) => {
    const dcName = req.params.dc_name;
    const raw = req.body?.forestDomainId;
    try {
      const db = getDb();
      if (raw == null || raw === '' || raw === 0) {
        const { affectedRows: uAff } = await db.execute(db.sql.dcs.setDomainUnbind, [dcName]);
        if (!uAff) return res.status(404).json({ error: `DC 找不到: ${dcName}` });
        await writeAudit({
          userId: req.user?.sub,
          action: 'dcs_catalog_unbind_domain',
          target: `ad_dcs:${dcName}`,
          payload: {},
          logger
        });
        return res.json({ ok: true, dcName, forestDomainId: null });
      }
      const domainId = Number(raw);
      if (!Number.isInteger(domainId) || domainId <= 0) {
        return res.status(400).json({ error: 'forestDomainId 必须为正整数或 null' });
      }
      const { affectedRows } = await db.execute(db.sql.dcs.setDomain, [domainId, dcName]);
      if (!affectedRows) return res.status(404).json({ error: `DC 找不到: ${dcName}` });
      await writeAudit({
        userId: req.user?.sub,
        action: 'dcs_catalog_bind_domain',
        target: `ad_dcs:${dcName}`,
        payload: { forestDomainId: domainId },
        logger
      });
      res.json({ ok: true, dcName, forestDomainId: domainId });
    } catch (e) {
      logger.error({ err: e?.message, dcName, raw }, 'dcs-catalog bind domain failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // R158.41 (2026-10-03) — TopContextPicker dropdown 主路径数据源.
  // 直接查 ad_dcs WHERE forest_domain_id = ?, 不走三段选择 (R158.40 fallback).
  // 返回 [{ dcName, isPdc }], 老 listDomainDcs 端点仍保留作兼容 (单 forest PDC 兜底).
  r.get('/api/admin/dcs-catalog/by-domain/:domainId', authAdObjects, async (req, res) => {
    const domainId = Number(req.params.domainId);
    if (!Number.isInteger(domainId) || domainId <= 0) {
      return res.status(400).json({ error: 'invalid domain id' });
    }
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.dcs.listByDomain, [domainId]);
      // R158.41 (2026-10-03) — TopContextPicker 4 级 dropdown 多返 siteId/siteName,
      // 让前端可以按站点分组, 默认选第一个有 DC 的站点 (R158.41.2 思想延伸).
      // R158.60.15 (2026-10-09) — operator "HUB 站点排前面". 透传 is_hub,
      // 让前端 sort 按 site 类型优先 (HUB 是类型不是 name).
      res.json({
        dcs: (rows || []).map(r => ({
          hostname: r.dcName,
          isPdc: !!r.isPdc,
          siteId: r.siteId ?? null,
          siteName: r.siteName ?? null,
          isHub: r.isHub === true || r.isHub === 1 || r.isHub === '1' || r.isHub === 'true' || r.isHub === 'yes',
          source: 'adDcsDomainBind'
        }))
      });
    } catch (e) {
      logger.error({ err: e?.message, domainId }, 'dcs-catalog list by domain failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // R158.44.1 (2026-10-04) — operator 反馈 "KDLFLOFADSRV1 归属 forestDomainId=2 明显的是错的".
  // ad_dcs.forest_domain_id 指向不存在的 ad_forest_domain.id (孤儿 FK). 列出全部孤儿 DC.
  // 不修改任何数据 — 让 UI 看清后再决定一键清.
  r.get('/api/admin/dcs-catalog/orphan', authAdObjects, async (req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.dcs.listOrphanDcs);
      res.json({
        orphans: (rows || []).map(r => ({
          dcName: r.dcName,
          orphanDomainId: r.orphanDomainId == null ? null : Number(r.orphanDomainId)
        })),
        count: (rows || []).length
      });
    } catch (e) {
      logger.error({ err: e?.message }, 'dcs-catalog list orphan failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // R158.44.1 — 一键把全部孤儿 FK 清成 NULL (forest_domain_id = NULL).
  // 安全: 仍 WHERE d.forest_domain_id IS NOT NULL AND fd.id IS NULL, 不会误清正常绑定.
  // MSSQL 与 MySQL UPDATE 语法不同, 走 isMssql 分支.
  r.post('/api/admin/dcs-catalog/orphan/unbind-all', authAdObjects, async (req, res) => {
    try {
      const db = getDb();
      const isMssql = db.dialect === 'mssql';
      const sqlText = isMssql
        ? `UPDATE d SET d.forest_domain_id = NULL
             FROM ad_dcs d
             LEFT JOIN ad_forest_domain fd ON fd.id = d.forest_domain_id
             WHERE d.forest_domain_id IS NOT NULL AND fd.id IS NULL`
        : db.sql.dcs.unbindAllOrphanDcs;
      const { affectedRows } = await db.execute(sqlText, []);
      await writeAudit({
        userId: req.user?.sub,
        action: 'dcs_catalog_unbind_all_orphan',
        target: 'ad_dcs',
        payload: { affectedRows: affectedRows ?? 0 },
        logger
      });
      res.json({ ok: true, affectedRows: affectedRows ?? 0 });
    } catch (e) {
      logger.error({ err: e?.message }, 'dcs-catalog unbind-all-orphan failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  r.put('/api/admin/dcs-catalog/:dc_name/site', authAdObjects, async (req, res) => {
    const dcName = req.params.dc_name;
    const { siteId } = req.body || {};
    try {
      const db = getDb();
      const sqlText = siteId == null ? db.sql.dcs.assignSiteUnbind : db.sql.dcs.assignSite;
      const params = siteId == null ? [dcName] : [siteId, dcName];
      const { affectedRows } = await db.execute(sqlText, params);
      if (affectedRows === 0) return res.status(404).json({ error: 'dc not found' });
      // C12 fix: per-DC site bind / unbind now writes an audit row. The
      // bulk route (POST .../bulk-assign) was already covered by C2, but
      // the single-DC path used here was a silent gap that left no trail
      // when an operator moved one DC at a time.
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'assign_dc_site',
        target: dcName,
        payload: { dcName, siteId: siteId ?? null, operation: siteId == null ? 'unbind' : 'bind' },
        logger
      });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'dcs-catalog site assign failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // 2026-08-27 round-29: PUT /api/admin/dcs-catalog/:dc_name/flags
  //   Body: any subset of { isPdc, isGc, isRidMaster, isSchemaMaster,
  //          isDomainNamingMaster, isInfrastructureMaster, isBridgehead }
  //          (camelCase). Values must be booleans — coerced to 0/1.
  //   Behavior: builds a partial UPDATE so toggling one flag doesn't
  //             reset the other six. Returns 200 + { ok, updated }.
  //   Errors:  400 if no flag keys supplied, or any value isn't boolean
  //            404 if dc_name doesn't exist in ad_dcs.
  //   Audit:   writes update_dc_flags with the full new-state diff so
  //            operators can trace who marked a DC bridgehead / PDC / etc.
  //   Why:     the DcsCatalogView lets operators mark 5 FSMO roles and
  //            the bridgehead directly from the UI — no direct DB write
  //            needed. Bridgehead drives the all-sites replication matrix
  //            primary selection; PDC is a FSMO role, NOT a primary marker.
  r.put('/api/admin/dcs-catalog/:dc_name/flags', authAdObjects, async (req, res) => {
    const dcName = req.params.dc_name;
    const body = req.body || {};
    // Whitelist of toggleable columns — anything else 400s to avoid SQL
    // injection via the dynamic SET clause. camelCase keys map to the
    // snake_case column names we write.
    const FLAGS = [
      { key: 'isPdc',                   col: 'is_pdc' },
      { key: 'isGc',                    col: 'is_gc' },
      { key: 'isRidMaster',             col: 'is_rid_master' },
      { key: 'isSchemaMaster',          col: 'is_schema_master' },
      { key: 'isDomainNamingMaster',    col: 'is_domain_naming_master' },
      { key: 'isInfrastructureMaster',  col: 'is_infrastructure_master' },
      { key: 'isBridgehead',            col: 'is_bridgehead' }
    ];
    const supplied = Object.keys(body);
    if (supplied.length === 0) {
      return res.status(400).json({ error: 'no flags supplied' });
    }
    // Reject unknown keys so a typo doesn't silently get dropped.
    const unknown = supplied.filter(k => !FLAGS.some(f => f.key === k));
    if (unknown.length > 0) {
      return res.status(400).json({ error: `unknown flag(s): ${unknown.join(', ')}` });
    }
    // Strict boolean check — anything truthy/falsy other than true/false
    // (e.g. strings, numbers) is rejected so the audit trail and the DB
    // don't drift. The UI sends strict booleans from toggle click handlers.
    const fields = [];
    const params = [];
    const updates = {}; // { col: 0|1 } for the audit payload
    for (const f of FLAGS) {
      if (!Object.prototype.hasOwnProperty.call(body, f.key)) continue;
      const v = body[f.key];
      if (typeof v !== 'boolean') {
        return res.status(400).json({ error: `${f.key} must be boolean` });
      }
      fields.push(`${f.col} = ?`);
      params.push(v ? 1 : 0);
      updates[f.col] = v ? 1 : 0;
    }
    if (fields.length === 0) {
      return res.status(400).json({ error: 'no flags supplied' });
    }
    params.push(dcName);
    try {
      const db = getDb();
      const { affectedRows } = await db.execute(db.sql.dcs.updateFlags(fields), params);
      if (affectedRows === 0) return res.status(404).json({ error: 'dc not found' });
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'update_dc_flags',
        target: dcName,
        payload: { dcName, updates },
        logger
      });
      res.json({ ok: true, updated: Object.keys(updates) });
    } catch (e) {
      logger.error({ err: e, dcName, updates }, 'dcs-catalog flags update failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // R158.X.115 (2026-10-20) — DC 生命周期: 退役下线 / 暂停管控
  // ══════════════════════════════════════════════════════════════════
  // 与 member-servers.js 的同名 4 端点 1:1 对称 (共用 services/host-status.js,
  // 仅 kind='dc' vs 'member' 不同)。
  //
  // 权限用 authAdObjects (admin:ad-objects) 而不是 authUsers —— DC 是 AD 对象,
  // 管 DC 的权限跟管 member server 的不是一个。
  //
  // 退役前置操作跟 member 不同: DC 必须先在 AD 里降级 (FSMO 角色转移 +
  // dcpromo), 降级后它会从复制伙伴中消失。这个顺序由 lifecycle-preview 的
  // preflightSteps[] 返回给 UI 强制提示。
  function dcLifecycleError(res, e, action) {
    if (e instanceof HostStatusError) {
      // 409/404 是状态机正常拒绝, 用 warn 而非 error (否则污染错误日志)。
      logger.warn({ code: e.code, dc: e.host }, `dc ${action} rejected`);
      return res.status(e.status).json({ error: e.code, message: e.message });
    }
    logger.error({ err: e }, `dcs ${action} failed`);
    return res.status(500).json({ error: '内部错误' });
  }

  // ══════════════════════════════════════════════════════════════════
  // R158.X.115 (2026-10-20) — 下线管理总览 (ServerLifecycleView)
  // ══════════════════════════════════════════════════════════════════
  // DC 与 member server **合并成一个列表**: 操作员的真实问题从来不是
  // "DC 归在哪台机器上", 而是"我现在有哪些机器已经下线了/被暂停了"。
  // 分两个页面等于让操作员自己记忆该去哪看。
  //
  // 权限取两者**并集**: 管理跨 DC 与 member 的视图需要看到两边, 任一权限
  // 不足就只能看到残缺的列表, 比完全不给更危险 (操作员会以为"没有退役机器")。
  // 动作端点 (decommission/pause/resume) 各自仍走 authAdObjects / authUsers,
  // 这里只负责读。
  r.get('/api/admin/server-lifecycle', [userAuth({ db: _db, logger }),
      requirePerm('admin:ad-objects'), requirePerm('admin:users')], async (req, res) => {
    // status: all(退役∪暂停, 默认) | decommissioned | paused | active
    const status = String(req.query.status || 'all');
    const kind = String(req.query.kind || 'all');
    try {
      const db = getDb();
      const spec = { status };
      const out = { status, kind, dcs: [], members: [] };

      if (kind === 'all' || kind === 'dc') {
        const r1 = await db.query(db.sql.hostStatus.listLifecycleDc(spec));
        out.dcs = (r1.rows ?? []).map(row => ({
          host: row.host,
          kind: 'dc',
          siteId: row.site_id ?? null,
          siteName: row.site_name ?? null,
          ipAddress: row.ip_address ?? null,
          osVersion: row.os_version ?? null,
          decommissionedAt: row.decommissioned_at ?? null,
          monitoringPausedAt: row.monitoring_paused_at ?? null,
          discoveredAt: row.discovered_at ?? null,
          discoveredBy: row.discovered_by_agent_id ?? null
        }));
      }
      if (kind === 'all' || kind === 'member') {
        const r2 = await db.query(db.sql.hostStatus.listLifecycleMember(spec));
        out.members = (r2.rows ?? []).map(row => ({
          host: row.host,
          kind: 'member',
          siteId: row.site_id ?? null,
          siteName: row.site_name ?? null,
          ipAddress: row.ip_address ?? null,
          osVersion: row.os_version ?? null,
          decommissionedAt: row.decommissioned_at ?? null,
          monitoringPausedAt: row.monitoring_paused_at ?? null,
          discoveredAt: row.discovered_at ?? null,
          discoveredVia: row.discovered_via ?? null,
          lastSeenAt: row.last_seen_at ?? null,
          enabled: row.enabled ?? null
        }));
      }
      res.json(out);
    } catch (e) {
      logger.error({ err: e }, 'server-lifecycle list failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // 下线前影响预览 (纯读): 前置操作步骤 + 将保留的历史条数。
  r.get('/api/admin/dcs-catalog/:dc_name/lifecycle-preview', authAdObjects, async (req, res) => {
    try {
      const data = await previewLifecycle({ kind: 'dc', host: req.params.dc_name }, logger);
      res.json(data);
    } catch (e) {
      dcLifecycleError(res, e, 'lifecycle-preview');
    }
  });

  // 暂停管控 (临时态, 手动恢复, 无自动到期)。
  r.post('/api/admin/dcs-catalog/:dc_name/pause-monitoring', authAdObjects, async (req, res) => {
    try {
      const data = await pauseHost({
        kind: 'dc',
        host: req.params.dc_name,
        reason: req.body?.reason,
        userId: req.user?.sub ?? null
      }, logger);
      res.json(data);
    } catch (e) {
      dcLifecycleError(res, e, 'pause-monitoring');
    }
  });

  // 恢复管控 (已退役则 409 — 退役是终态不可逆)。
  r.post('/api/admin/dcs-catalog/:dc_name/resume-monitoring', authAdObjects, async (req, res) => {
    try {
      const data = await resumeHost({
        kind: 'dc',
        host: req.params.dc_name,
        reason: req.body?.reason,
        userId: req.user?.sub ?? null
      }, logger);
      res.json(data);
    } catch (e) {
      dcLifecycleError(res, e, 'resume-monitoring');
    }
  });

  // 退役下线 (终态, 不可逆; 0 物理删除, 历史全保留)。
  r.post('/api/admin/dcs-catalog/:dc_name/decommission', authAdObjects, async (req, res) => {
    try {
      const data = await decommissionHost({
        kind: 'dc',
        host: req.params.dc_name,
        reason: req.body?.reason,
        userId: req.user?.sub ?? null
      }, logger);
      res.json(data);
    } catch (e) {
      dcLifecycleError(res, e, 'decommission');
    }
  });

  r.post('/api/admin/dcs-catalog/bulk-assign', authAdObjects, async (req, res) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows) return res.status(400).json({ error: 'rows array required' });
    if (rows.length === 0) return res.status(400).json({ error: 'rows array empty' });
    const errors = [];
    let assigned = 0;
    let unassigned = 0;
    let skipped = 0;
    try {
      const db = getDb();
      // C2 fix: same rationale as sites-catalog/bulk above. Whole loop in
      // one tx so mid-loop failures roll everything back; per-row audit
      // captures which dc went to which site (was previously silent on the
      // per-row level — only a summary count was written).
      await db.transaction(async (tx) => {
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i] || {};
          const dcName = (r.dcName || '').trim();
          if (!dcName) {
            errors.push({ rowIndex: i, dcName: '', reason: 'dcName is required' });
            skipped++;
            continue;
          }
          const siteName = (r.siteName || '').trim();
          if (!siteName) {
            await tx.execute(db.sql.dcs.assignSiteUnbind, [dcName]);
            await writeAudit({
              userId: req.user?.sub ?? null,
              action: 'bulk_assign_dc_unbound',
              target: dcName,
              payload: { rowIndex: i, dcName, reason: 'empty siteName' },
              logger
            }, logger, tx);
            unassigned++;
            continue;
          }
          const { rows: siteRows } = await tx.query(db.sql.sites.findByName, [siteName]);
          if (siteRows.length === 0) {
            errors.push({ rowIndex: i, dcName, reason: `site "${siteName}" not found` });
            skipped++;
            continue;
          }
          const siteId = siteRows[0].site_id;
          const { affectedRows } = await tx.execute(db.sql.dcs.assignSite, [siteId, dcName]);
          if (affectedRows === 0) {
            errors.push({ rowIndex: i, dcName, reason: `dc "${dcName}" not discovered (agent has not reported it yet)` });
            skipped++;
            continue;
          }
          await writeAudit({
            userId: req.user?.sub ?? null,
            action: 'bulk_assign_dc_site_row',
            target: dcName,
            payload: { rowIndex: i, dcName, siteName, siteId },
            logger
          }, logger, tx);
          assigned++;
        }
        await writeAudit({
          userId: req.user?.sub ?? null,
          action: 'bulk_assign_dc_sites',
          target: 'ad_dcs',
          payload: { assigned, unassigned, skipped, total: rows.length },
          logger
        }, logger, tx);
      });
      res.json({ ok: true, assigned, unassigned, skipped, errors });
    } catch (e) {
      logger.error({ err: e }, 'dcs-catalog bulk assign failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // ----- Ports -----
  r.get('/api/admin/ports', authUsers, async (_req, res) => {
    try {
      const rows = await listPorts();
      // Wrap in camelRow so snake_case columns from SQL (e.g. sort_order) are
      // remapped to camelCase (sortOrder) — the rest of the admin responses
      // (users, audit, sites, dcs) already do this.
      res.json(rows.map(camelRow));
    } catch (e) {
      logger.error({ err: e }, 'admin ports list failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  r.post('/api/admin/ports', authUsers, async (req, res) => {
    try {
      const out = await createPort(req.body || {});
      res.status(201).json(out);
    } catch (e) {
      if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.message });
      logger.error({ err: e }, 'admin ports create failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  r.put('/api/admin/ports/:id', authUsers, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的 id' });
    try {
      const ok = await updatePort(id, req.body || {});
      if (!ok) return res.status(404).json({ error: 'port not found' });
      res.json({ ok: true });
    } catch (e) {
      if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.message });
      logger.error({ err: e }, 'admin ports update failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  r.delete('/api/admin/ports/:id', authUsers, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的 id' });
    try {
      const ok = await deletePort(id);
      if (!ok) return res.status(404).json({ error: 'port not found' });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'admin ports delete failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // ----- Server Groups (Task 7) -----
  // 9 routes backing the group inventory + bulk install/uninstall/enable/disable
  // surface. All guarded by [userAuth, requirePerm('admin:users')] per Global
  // Constraint #4 ("No new permissions"). The built-in 'ad-os-baseline' package
  // mirrors the per-host DELETE in member-servers.js (memberRouter, Task 6):
  // every affected host gets an audit row BEFORE the DELETE row lands, so an
  // audit reader can always correlate a disable_builtin_ad_os_baseline with
  // the row that disappeared.

  // GET list with member_count
  r.get('/api/admin/server-groups', authFilePush, async (_req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.serverGroups.list);
      res.json(rows.map(row => ({
        groupId: row.group_id,
        groupName: row.group_name,
        description: row.description,
        memberCount: Number(row.member_count ?? 0)
      })));
    } catch (e) {
      logger.error({ err: e }, 'admin server-groups list failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // POST create; 409 on duplicate group_name
  r.post('/api/admin/server-groups', authFilePush, async (req, res) => {
    const { groupName, description } = req.body || {};
    if (!groupName) return res.status(400).json({ error: 'groupName is required' });
    try {
      const db = getDb();
      const result = await db.execute(db.sql.serverGroups.create, [groupName, description ?? null]);
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'create_server_group',
        target: groupName,
        payload: { groupName, description: description ?? null, id: result.insertId },
        logger
      });
      res.status(201).json({ id: result.insertId });
    } catch (e) {
      if (e.code === 'DUP_ENTRY') return res.status(409).json({ error: 'groupName already exists' });
      logger.error({ err: e }, 'admin server-groups create failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // PUT rename (group_name) / update description; 404 on miss
  r.put('/api/admin/server-groups/:group_id', authFilePush, async (req, res) => {
    const id = Number(req.params.group_id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid group_id' });
    const { groupName, description } = req.body || {};
    const fields = [];
    const params = [];
    if (groupName !== undefined)   { fields.push('group_name = ?');   params.push(groupName); }
    if (description !== undefined) { fields.push('description = ?');  params.push(description); }
    if (fields.length === 0) return res.status(400).json({ error: 'no fields to update' });
    params.push(id);
    try {
      const db = getDb();
      const { affectedRows } = await db.execute(
        `UPDATE ad_server_groups SET ${fields.join(', ')} WHERE group_id = ?`,
        params
      );
      if (affectedRows === 0) return res.status(404).json({ error: 'group not found' });
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'update_server_group',
        target: String(id),
        payload: { groupId: id, groupName, description, fieldsUpdated: fields.map(f => f.split(' ')[0]) },
        logger
      });
      res.json({ ok: true });
    } catch (e) {
      if (e.code === 'DUP_ENTRY') return res.status(409).json({ error: 'groupName already exists' });
      logger.error({ err: e }, 'admin server-groups update failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // DELETE drop; cascades to ad_server_group_members via FK ON DELETE CASCADE;
  // host package bindings on ad_member_server_packages persist (no FK to ad_server_groups)
  r.delete('/api/admin/server-groups/:group_id', authFilePush, async (req, res) => {
    const id = Number(req.params.group_id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid group_id' });
    try {
      const db = getDb();
      const { affectedRows } = await db.execute(db.sql.serverGroups.delete, [id]);
      if (affectedRows === 0) return res.status(404).json({ error: 'group not found' });
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'delete_server_group',
        target: String(id),
        payload: { groupId: id, note: 'member rows cascade via FK ON DELETE CASCADE' },
        logger
      });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'admin server-groups delete failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // GET members — list hostnames + site for the group
  r.get('/api/admin/server-groups/:group_id/members', authFilePush, async (req, res) => {
    const id = Number(req.params.group_id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid group_id' });
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.serverGroups.listMembers, [id]);
      res.json(rows);
    } catch (e) {
      logger.error({ err: e }, 'admin server-groups listMembers failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // PUT members — replace (idempotent diff).
  // Read existing hostnames, compute (added, removed), DELETE removed + INSERT
  // IGNORE / NOT-EXISTS added. Same hostname set → no-op. Wrapped in a tx so
  // concurrent updates from another admin can't tear the membership.
  // GET /api/admin/server-groups/member-candidates — 「可加入的服务器」清单.
  //   R158.X.116.r (2026-10-23). 原来 members 面板只有一个 textarea 手输
  //   hostname, 操作员没法浏览现有已纳入监控的机器; adminApi.listMemberServers
  //   虽然存在 (web/src/api/admin.js:148) 但本视图从未调用过它。
  //   **不复用那个端点**是刻意的: /api/admin/member-servers 要 admin:users
  //   (member-servers.js:100), 而本模块全部端点是 authFilePush (admin:file-push).
  //   直接复用会让只有 file-push 权限的管理员在同一个页面里拿到 403 ——
  //   前后台两层门不一致, 正是 lesson 158/159 说的口径分裂。新端点跟本模块
  //   共用 authFilePush, 权限判定收敛单源, 且不改动任何现有端点的权限。
  r.get('/api/admin/server-groups/member-candidates', authFilePush, async (_req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.serverGroups.listSelectableMembers);
      res.json({
        items: rows.map(row => ({
          hostname: row.hostname,
          siteId: row.site_id,
          siteName: row.site_name || null
        }))
      });
    } catch (e) {
      logger.error({ err: e?.message }, 'server-groups member-candidates failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  r.put('/api/admin/server-groups/:group_id/members', authFilePush, async (req, res) => {
    const id = Number(req.params.group_id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid group_id' });
    const raw = req.body?.hostnames;
    if (!Array.isArray(raw)) return res.status(400).json({ error: 'hostnames array required' });
    // Dedupe + trim; reject empties so the diff doesn't carry empty strings.
    const desired = Array.from(new Set(raw.map(h => String(h).trim()).filter(Boolean)));
    try {
      const db = getDb();
      // R158.X.116.r (2026-10-23) — 存在性校验 (纵深防御). ad_server_group_members
      //   对 ad_member_servers **没有外键** (只有到 ad_server_groups 的 FK),
      //   member 只是一个裸 hostname 字符串, 所以拼错的名字 / 甚至 DC 名都能
      //   被存成"成员", 组列表 memberCount 照样 +1, 但批量包操作对该 hostname
      //   是空操作 —— 静默无效, 不报错。操作员选了 3 台装了 1 台也看不出来。
      //   这里是唯一的拦截点: 前端选择器只是第一道防线, 直接调 API 绕过。
      //   判存在性只查 ad_member_servers 有 hostname, **不查退役/暂停** ——
      //   退役是终态但成员关系该由操作员显式清理, 不该被保存动作偷偷抹掉
      //   (candidate 列表过滤退役只是"不主动推荐", 语义不同)。
      if (desired.length) {
        const found = await db.query(
          db.sql.serverGroups.findExistingMemberHosts(desired), desired);
        const known = new Set((found.rows || []).map(x => x.hostname));
        const rejected = desired.filter(h => !known.has(h));
        if (rejected.length) {
          // 整批拒绝而非静默跳过: 跳过会让操作员以为都存进去了
          // (lesson: UI 无声丢数据 = 用户失去对系统状态的正确认知)。
          return res.status(400).json({
            error: '存在未纳入监控的服务器, 已拒绝本次保存',
            rejected
          });
        }
      }
      const { rows } = await db.query(db.sql.serverGroups.listMembers, [id]);
      // Group-exists guard: listMembers only returns rows when the group has
      // members. If we got 0 rows AND the desired set is non-empty, the group
      // might still exist empty — so verify explicitly before returning 404.
      if (rows.length === 0 && desired.length === 0) {
        const found = await db.query(db.sql.serverGroups.findById, [id]);
        if (found.rows.length === 0) return res.status(404).json({ error: 'group not found' });
      }
      const existing = new Set(rows.map(r => r.hostname));
      const wanted = new Set(desired);
      const toRemove = [...existing].filter(h => !wanted.has(h));
      const toAdd = [...wanted].filter(h => !existing.has(h));
      await db.transaction(async (tx) => {
        for (const hostname of toRemove) {
          await tx.execute(db.sql.serverGroups.removeMember, [id, hostname]);
        }
        for (const hostname of toAdd) {
          await tx.execute(db.sql.serverGroups.addMember, [id, hostname]);
        }
        // C11 fix: enroll the membership diff audit row in the same tx as the
        // data writes — a half-committed diff that loses its audit trail is
        // exactly the gap compliance reviewers flag. writeAudit re-throws on
        // tx path so a transient audit-table hiccup rolls the diff back.
        await writeAudit({
          userId: req.user?.sub ?? null,
          action: 'replace_server_group_members',
          target: String(id),
          payload: { groupId: id, added: toAdd, removed: toRemove, total: desired.length },
          logger
        }, logger, tx);
      });
      res.json({ ok: true, added: toAdd.length, removed: toRemove.length });
    } catch (e) {
      logger.error({ err: e }, 'admin server-groups replaceMembers failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // POST packages/install — bulk INSERT IGNORE / NOT EXISTS for every member
  // of the group. The SQL block resolves the membership join, so the handler
  // stays a single round-trip regardless of group size.
  r.post('/api/admin/server-groups/:group_id/packages/install', authFilePush, async (req, res) => {
    const id = Number(req.params.group_id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid group_id' });
    const { packageName } = req.body || {};
    if (!packageName) return res.status(400).json({ error: 'packageName is required' });
    // confirmDropSchema is accepted for forward compatibility with the
    // agent-side install handler (which checks the flag before DROP SCHEMA).
    // The admin route never drops anything, so the flag is informational.
    try {
      const db = getDb();
      // MSSQL bulkInstallPackage takes 4 params (package_name, enabled,
      // group_id, package_name-again for NOT EXISTS); MySQL takes 3.
      // We detect dialect to pick the right param count.
      const params = db.dialect === 'mssql'
        ? [packageName, 1, id, packageName]
        : [packageName, 1, id];
      const { affectedRows } = await db.execute(db.sql.serverGroups.bulkInstallPackage, params);
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'bulk_install_package_to_group',
        target: String(id),
        payload: { groupId: id, packageName, affected: affectedRows },
        logger
      });
      res.json({ ok: true, affected: affectedRows });
    } catch (e) {
      logger.error({ err: e }, 'admin server-groups bulkInstall failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // POST packages/:name/uninstall — bulk DELETE; for built-in ad-os-baseline,
  // audit one disable_builtin_ad_os_baseline row per affected host BEFORE
  // the DELETE (matches per-host DELETE in memberRouter).
  r.post('/api/admin/server-groups/:group_id/packages/:package_name/uninstall', authFilePush, async (req, res) => {
    const id = Number(req.params.group_id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid group_id' });
    const packageName = req.params.package_name;
    try {
      const db = getDb();
      // Snapshot affected hostnames first so we can write audit rows even
      // if the DELETE itself fails. Read from ad_member_server_packages so
      // we audit exactly the rows that will be removed (not the entire
      // group membership — installing without a bind wouldn't produce an
      // audit row).
      const { rows } = await db.query(db.sql.serverGroups.listHostsForPackage, [packageName]);
      const affected = rows.map(r => r.hostname);
      if (packageName === BUILTIN_AD_OS_BASELINE) {
        for (const hostname of affected) {
          await writeAudit({
            userId: req.user?.sub ?? null,
            action: 'disable_builtin_ad_os_baseline',
            target: hostname,
            payload: { package: BUILTIN_AD_OS_BASELINE, groupId: id, via: 'bulk_uninstall' },
            logger
          });
        }
      }
      const { affectedRows } = await db.execute(db.sql.serverGroups.bulkUninstallPackage, [id, packageName]);
      // C11: log a per-group uninstall summary row in addition to the
      // built-in ad-os-baseline per-host disable rows written before the
      // DELETE — gives operators a single pivot row when searching by
      // group_id without having to fan-out across the per-host disable rows.
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'bulk_disable_package_to_group',
        target: String(id),
        payload: { groupId: id, packageName, removed: affectedRows, auditedHosts: affected.length, note: 'uninstall removes bindings; built-in ad-os-baseline also writes per-host disable_builtin_ad_os_baseline rows' },
        logger
      });
      res.json({ ok: true, removed: affectedRows, audited: affected.length });
    } catch (e) {
      logger.error({ err: e }, 'admin server-groups bulkUninstall failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // POST packages/:name/enable | disable — bulk UPDATE the enabled flag.
  r.post('/api/admin/server-groups/:group_id/packages/:package_name/enable', authFilePush, async (req, res) => {
    const id = Number(req.params.group_id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid group_id' });
    const packageName = req.params.package_name;
    try {
      const db = getDb();
      const { affectedRows } = await db.execute(db.sql.serverGroups.bulkSetEnabled, [1, id, packageName]);
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'bulk_enable_package_to_group',
        target: String(id),
        payload: { groupId: id, packageName, affected: affectedRows },
        logger
      });
      res.json({ ok: true, affected: affectedRows });
    } catch (e) {
      logger.error({ err: e }, 'admin server-groups bulkEnable failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  r.post('/api/admin/server-groups/:group_id/packages/:package_name/disable', authFilePush, async (req, res) => {
    const id = Number(req.params.group_id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid group_id' });
    const packageName = req.params.package_name;
    try {
      const db = getDb();
      const { affectedRows } = await db.execute(db.sql.serverGroups.bulkSetEnabled, [0, id, packageName]);
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'bulk_disable_package_to_group',
        target: String(id),
        payload: { groupId: id, packageName, affected: affectedRows, note: 'disable flips enabled flag; package rows are NOT deleted' },
        logger
      });
      res.json({ ok: true, affected: affectedRows });
    } catch (e) {
      logger.error({ err: e }, 'admin server-groups bulkDisable failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // 2026-08-31 R75 — AD user & group management command queue. Three
  // admin endpoints wired through adAdminCommandsService (which lives in
  // ../services/ad-admin-commands.js). The service handles all DB work,
  // per-type params validation, and password-redaction. The route adds:
  //   - DC-online check at queue time (503 with last-seen timestamp when
  //     the agent hasn't heartbeated in 5min — operator can override
  //     with ?force=true to queue anyway)
  //   - audit row emission per queue (action derived from commandType;
  //     passwords REDACTED in the audit payload per spec §3.4 ruling #8)
  //   - pagination + filter on the list endpoint
  //
  // Routes that load the service via dynamic import to avoid a cycle
  // (the service imports getDb() lazily, but the route file is on the
  // critical path of the bootstrap and we want the require() surface
  // minimal at module load).

  // POST /api/admin/ad-commands — queue a new AD command.
  r.post('/api/admin/ad-commands', authAdObjects, async (req, res) => {
    const { targetDc, commandType, params } = req.body || {};
    if (!targetDc || typeof targetDc !== 'string') {
      return res.status(400).json({ error: 'targetDc required' });
    }
    if (!commandType || typeof commandType !== 'string') {
      return res.status(400).json({ error: 'commandType required' });
    }
    // R158.56c-d (2026-10-09) — object_delete 命令彻底下线 (跟 ad_ad_object_delete
    //   包整体下线同步). operator directive "这个包不在需要, 从中心数据库删除".
    //   DB DELETE 已完成 (package_scripts + package_policies). 4 处防御
    //   同步清, 防止 DailyOpsView "删除" 按钮复活走通. 未来恢复需要:
    //   1. git history 复原 PS1/manifest/content.sha256
    //   2. builtin-packages.js BUILTIN_PACKAGES 取消注释
    //   3. ad-admin.js PACKAGE_COMMAND_MAP 加回 object_delete entry
    //   4. ad-admin-commands.js validators 加回 object_delete 块
    //   5. audit-classifier.js 3 处分类加回
    //   6. 此处 if 块删掉
    if (commandType === 'object_delete') {
      return res.status(400).json({
        error: 'object_delete removed (R158.56c-d operator directive)'
      });
    }
    // DC-online check (spec §2.5 ruling #10). Skip when ?force=true. The
    // last-seen timestamp is included in the 503 body so the operator can
    // decide whether to override. Performed BEFORE the service call so
    // we don't write a row for a command the agent can't pick up.
    const force = String(req.query?.force ?? '') === 'true';
    const onlineErr = await _checkDcOnline(targetDc, force);
    if (onlineErr) return res.status(onlineErr.status).json(onlineErr.body);
    let row;
    try {
      const { queueCommand } = await import('../services/ad-admin-commands.js');
      row = await queueCommand({
        targetDc,
        commandType,
        params,
        operatorId: req.user?.sub ?? null
      });
    } catch (e) {
      if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.message });
      logger.error({ err: e, targetDc, commandType }, 'ad-commands queue failed');
      return res.status(500).json({ error: '内部错误' });
    }
    // Audit row derived from commandType (matches the user-facing action
    // the operator just took; the system-side ad_command_claimed /
    // _succeeded / _failed rows are emitted by the agent routes).
    // Payload shape: redact password fields per spec §3.4 ruling #8.
    // password-bearing params become { hasPassword: true, passwordLength }.
    await _auditAdCommand(req, row, commandType, params, logger);
    res.status(201).json({
      id: row.id,
      taskId: row.task_id,   // R158.56 (2026-10-08) — 让前端在 queue 后立刻拿到 task_id
                             // 跟 lifecycle audit row 同步 (claim/succeeded/failed 都用同一 ID)
      commandType: row.command_type,
      targetDc: row.target_dc,
      status: row.status,
      createdAt: row.created_at
    });
  });

  // 2026-09-02 R76 + 2026-09-03 R77 — POST /api/admin/ad-commands/batch —
  // queue N AD commands in a single request. Whitelisted commandTypes
  // only (the 4 batch-safe user mutators from R76 plus the 2 group
  // member mutators from R77: add / remove). For each entry we run the
  // SAME per-type validator the single endpoint uses (re-exported by
  // the service via `_testInternals.validators`) and queue via the
  // existing queueCommand service path — no raw batch INSERT. Returns
  // 201 when all entries queue, 207 (Multi-Status) when some fail
  // per-entry validation but the request shape itself is sound, and
  // 400/503 for request-level errors.
  const BATCH_COMMAND_TYPES = new Set([
    'user_enable', 'user_disable', 'user_unlock', 'user_password_reset',
    'group_add_member', 'group_remove_member'
  ]);
  const BATCH_MAX_PARAMS = 100;
  r.post('/api/admin/ad-commands/batch', authAdObjects, async (req, res) => {
    const { targetDc, commandType, paramsList } = req.body || {};
    if (!targetDc || typeof targetDc !== 'string') {
      return res.status(400).json({ error: 'targetDc required' });
    }
    if (!commandType || typeof commandType !== 'string') {
      return res.status(400).json({ error: 'commandType required' });
    }
    if (!BATCH_COMMAND_TYPES.has(commandType)) {
      return res.status(400).json({
        error: `batch commandType must be one of ${[...BATCH_COMMAND_TYPES].join(', ')}`
      });
    }
    if (!Array.isArray(paramsList) || paramsList.length === 0) {
      return res.status(400).json({ error: 'paramsList must be a non-empty array' });
    }
    if (paramsList.length > BATCH_MAX_PARAMS) {
      return res.status(400).json({
        error: `paramsList exceeds max ${BATCH_MAX_PARAMS} entries (got ${paramsList.length})`
      });
    }
    const force = String(req.query?.force ?? '') === 'true';
    const onlineErr = await _checkDcOnline(targetDc, force);
    if (onlineErr) return res.status(onlineErr.status).json(onlineErr.body);

    // Resolve the per-type validator from the service (no raw SQL — we
    // want the SAME shape the single endpoint validates against). If
    // the validator lookup fails, every entry will be rejected with a
    // 400-shaped error so the caller knows the batch commandType is
    // unreachable (defense-in-depth — BATCH_COMMAND_TYPES already
    // whitelists only known validators).
    let queueCommand;
    let validator;
    try {
      ({ queueCommand } = await import('../services/ad-admin-commands.js'));
      // The service re-exports its validators() map via _testInternals.
      // The single-queue path validates internally; we want per-entry
      // validation here so a 207 can carry partial-success errors[].
      const { _testInternals } = await import('../services/ad-admin-commands.js');
      validator = _testInternals.validators[commandType];
      if (typeof validator !== 'function') {
        return res.status(400).json({ error: `unknown command_type: ${commandType}` });
      }
    } catch (e) {
      logger.error({ err: e, commandType }, 'ad-commands batch import failed');
      return res.status(500).json({ error: '内部错误' });
    }

    const queued = [];
    const errors = [];
    const operatorId = req.user?.sub ?? null;
    for (let i = 0; i < paramsList.length; i++) {
      const entry = paramsList[i];
      const v = validator(entry);
      if (!v.ok) {
        errors.push({ index: i, error: v.error });
        continue;
      }
      try {
        const row = await queueCommand({
          targetDc,
          commandType,
          params: v.normalized,
          operatorId
        });
        queued.push(row);
        await _auditAdCommand(req, row, commandType, v.normalized, logger);
      } catch (e) {
        if (e.httpStatus) {
          errors.push({ index: i, error: e.message });
        } else {
          logger.error({ err: e, commandType, index: i }, 'ad-commands batch entry failed');
          errors.push({ index: i, error: 'queue failed' });
        }
      }
    }

    const responseBody = {
      queued: queued.map(row => ({
        id: row.id,
        taskId: row.task_id,    // R158.56 — batch 同步回传 task_id
        commandType: row.command_type,
        targetDc: row.target_dc,
        status: row.status,
        createdAt: row.created_at
      })),
      totalQueued: queued.length,
      errors
    };
    // 207 when at least one entry failed; 201 when all queued.
    const status = errors.length === 0 ? 201 : 207;
    res.status(status).json(responseBody);
  });

  // R158.34 (2026-10-02) — POST /api/admin/ad-account/quickfix.
  // Operator directive "针对特殊的服务器设定, 可以用来快速重置账户设定".
  // Thin convenience wrapper around queueCommand(commandType=
  // 'ad_account_quickfix') with the request body normalised into the
  // canonical params shape. Same DC-online check + audit row + 503
  // failure shape as the underlying /api/admin/ad-commands endpoint, so
  // DailyOpsView.vue can treat it as an opaque queue operation and the
  // operator gets a uniform error/audit experience.
  //
  // Wire shape (request):
  //   { targetDc, sam, newPassword?, displayName?, description?, userAccountControl? }
  // Wire shape (response, 201):
  //   { commandId, commandType, targetDc, status, createdAt }
  r.post('/api/admin/ad-account/quickfix', authAdObjects, async (req, res) => {
    const { targetDc, sam, newPassword, displayName, description, userAccountControl } = req.body || {};
    if (!targetDc || typeof targetDc !== 'string') {
      return res.status(400).json({ error: 'targetDc required' });
    }
    const force = String(req.query?.force ?? '') === 'true';
    const onlineErr = await _checkDcOnline(targetDc, force);
    if (onlineErr) return res.status(onlineErr.status).json(onlineErr.body);

    // Build the unified params — only include keys the operator actually
    // sent (so the agent PS1 can distinguish "don't touch this field"
    // from "set to empty string"). description explicitly accepts
    // empty-string to clear the attribute per the DailyOpsView spec.
    const params = {};
    if (typeof sam === 'string') params.sam = sam;
    if (typeof newPassword === 'string' && newPassword.length > 0) params.newPassword = newPassword;
    if (typeof displayName === 'string') params.displayName = displayName;
    if (description === '' || typeof description === 'string') params.description = description;
    if (userAccountControl != null && userAccountControl !== '') params.userAccountControl = userAccountControl;

    let row;
    try {
      const { queueCommand } = await import('../services/ad-admin-commands.js');
      row = await queueCommand({
        targetDc,
        commandType: 'ad_account_quickfix',
        params,
        operatorId: req.user?.sub ?? null
      });
    } catch (e) {
      if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.message });
      logger.error({ err: e, targetDc }, 'ad-account/quickfix queue failed');
      return res.status(500).json({ error: '内部错误' });
    }
    await _auditAdCommand(req, row, 'ad_account_quickfix', params, logger);
    res.status(201).json({
      commandId: row.id,
      taskId: row.task_id,    // R158.56 — quickfix endpoint 同步回传 task_id
      commandType: row.command_type,
      targetDc: row.target_dc,
      status: row.status,
      createdAt: row.created_at
    });
  });

  // R158.34 — GET /api/admin/ad-account/quickfix-history?dc=<hostname>&limit=20.
  // Returns recent ad_admin_commands rows for command_type=
  // 'ad_account_quickfix' on a given DC (24h window default). Powers
  // the "历史" tab in DailyOpsView. Read-only, same perm gate as the
  // rest of the AD admin surface (admin:users).
  //
  // Reads from ad_admin_commands (NOT package_runs — package_runs has
  // no target_user / unlocked / password_reset columns). Each
  // ad_admin_commands row carries the params_json (target user
  // identity) and result_json (per-step result blob from the agent),
  // which is exactly what the operator wants to see in the history
  // tab. We unpack both blobs inline.
  r.get('/api/admin/ad-account/quickfix-history', authAdObjects, async (req, res) => {
    const targetDc = String(req.query.dc || '').trim();
    if (!targetDc) return res.status(400).json({ error: 'dc required' });
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
    try {
      const db = getDb();
      const isMssql = db.dialect === 'mssql';
      const sql = isMssql
        ? `SELECT TOP (?) id, status, created_at, claimed_at, completed_at,
                  params_json, result_json, error_message, operator_id, agent_id
             FROM ad_admin_commands
             WHERE command_type = 'ad_account_quickfix'
               AND target_dc = ?
               AND created_at >= DATEADD(HOUR, -24, SYSUTCDATETIME())
             ORDER BY created_at DESC`
        : `SELECT id, status, created_at, claimed_at, completed_at,
                  params_json, result_json, error_message, operator_id, agent_id
             FROM ad_admin_commands
             WHERE command_type = 'ad_account_quickfix'
               AND target_dc = ?
               AND created_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR
             ORDER BY created_at DESC
             LIMIT ?`;
      const { rows } = await db.query(sql, isMssql ? [limit, targetDc] : [targetDc, limit]);
      // Unpack params_json + result_json into the columns the
      // DailyOpsView "历史" tab renders. Strip password fields so we
      // never echo them back to the UI even if the operator browses
      // the history tab with browser dev-tools open.
      const runs = (rows || []).map(r => {
        let params = {};
        let result = {};
        try { if (r.params_json) params = JSON.parse(r.params_json); } catch { /* leave {} */ }
        try { if (r.result_json) result = JSON.parse(r.result_json); } catch { /* leave {} */ }
        return {
          id: r.id,
          status: r.status,
          agent_id: r.agent_id,
          target_user: params.sam || '—',
          operator: r.operator_id || '—',
          collected_at: r.completed_at || r.claimed_at || r.created_at,
          unlocked:      result.unlocked      === true,
          password_reset: result.passwordReset === true || result.password_reset === true,
          enabled:       result.enabled       === true,
          attributes_set: typeof result.attributesSet === 'number'
                          ? result.attributesSet
                          : (typeof result.attributes_set === 'number' ? result.attributes_set : 0),
          duration_ms:   typeof result.durationMs === 'number'
                          ? result.durationMs
                          : (typeof result.duration_ms === 'number' ? result.duration_ms : 0),
          error: r.error_message || result.error || null
        };
      });
      res.json({ runs });
    } catch (e) {
      logger.error({ err: e, targetDc }, 'ad-account/quickfix-history read failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // GET /api/admin/ad-commands — paginated history (operator's drawer).
  r.get('/api/admin/ad-commands', authAdObjects, async (req, res) => {
    try {
      const { listCommands } = await import('../services/ad-admin-commands.js');
      const operatorIdRaw = req.query?.operatorId;
      const operatorId = operatorIdRaw != null && operatorIdRaw !== ''
        ? Number(operatorIdRaw) : undefined;
      const status = req.query?.status || undefined;
      const page = req.query?.page ?? 1;
      const size = req.query?.size ?? 50;
      const out = await listCommands({ operatorId, status, page, size });
      // Shape rows for the operator drawer. result_json is omitted (the
      // single-row endpoint exposes it; the list keeps payload light).
      const rows = out.rows.map(r => ({
        id: r.id,
        taskId: r.task_id,    // R158.56 — 让 lifecycle panel 直接拿 task_id,
                              // 不用 JOIN audit_logs. claim/succeeded/failed 4 audit
                              // row 也用同一 ID, UI 排序查找一致.
        commandType: r.command_type,
        targetDc: r.target_dc,
        status: r.status,
        operatorId: r.operator_id,
        operatorUsername: r.operator_username ?? null,
        createdAt: r.created_at,
        claimedAt: r.claimed_at,
        completedAt: r.completed_at,
        durationMs: r.duration_ms,
        errorMessage: r.error_message
      }));
      res.json({ total: out.total, rows, page: out.page, size: out.size });
    } catch (e) {
      logger.error({ err: e }, 'ad-commands list failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // GET /api/admin/ad-commands/:id — single row incl. params_json +
  // result_json. Audit-classifier entries (`ad_command_*`) cover the
  // operator-visible events; this endpoint just reads.
  r.get('/api/admin/ad-commands/:id', authAdObjects, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: '无效的 id' });
    try {
      const { getCommand } = await import('../services/ad-admin-commands.js');
      const row = await getCommand(id);
      if (!row) return res.status(404).json({ error: 'command not found' });
      // Redact passwords on the way out so an admin looking at history
      // never sees cleartext (defense-in-depth — the service already
      // strips on write).
      const safeParams = row.params_json ? redactPasswordsForAudit(row.params_json) : null;
      const safeResult = row.result_json ? redactPasswordsForAudit(row.result_json) : null;
      res.json({
        id: row.id,
        taskId: row.task_id,    // R158.56 — single-row endpoint 同步回传 task_id
        commandType: row.command_type,
        targetDc: row.target_dc,
        status: row.status,
        operatorId: row.operator_id,
        operatorUsername: row.operator_username ?? null,
        params: safeParams,
        result: safeResult,
        errorMessage: row.error_message,
        durationMs: row.duration_ms,
        createdAt: row.created_at,
        claimedAt: row.claimed_at,
        completedAt: row.completed_at
      });
    } catch (e) {
      logger.error({ err: e, id }, 'ad-commands get failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // 2026-09-05 R81 — member-server PowerShell command queue. Mirrors the
  // /api/admin/ad-commands surface (POST queue + GET list + GET single)
  // but targets an arbitrary member-server hostname instead of a DC. The
  // single endpoint is /api/admin/member-commands/:id; the agent claim /
  // ack endpoints are on the agent router (/api/agent/member-commands*).
  //
  // 8 safety guard rails (per spec §3) live in the service layer; this
  // route is a thin transport wrapper. The route also writes the
  // `ad_member_command_queued` audit row at queue time (spec §3.4
  // ruling #7); agent-claimed / _succeeded / _failed / _timed_out audit
  // rows are emitted by the agent routes + the sweeper.

  // POST /api/admin/member-commands — queue a new PowerShell command
  // against a member-server hostname.
  r.post('/api/admin/member-commands', authMemberSrv, async (req, res) => {
    const { hostname, params } = req.body || {};
    if (!hostname || typeof hostname !== 'string') {
      return res.status(400).json({ error: '主机名必填' });
    }
    // Hostname-online check (spec §3 guard rail #1). The service also
    // runs the check internally — running it here lets us short-circuit
    // with a clean 503 + lastHeartbeatAt body BEFORE writing the row.
    // Skip when ?force=true (admin override path, same shape as ad-commands).
    const force = String(req.query?.force ?? '') === 'true';
    if (!force) {
      try {
        const { checkHostOnline } = await import('../services/member-commands.js');
        const probe = await checkHostOnline(hostname, { force: false });
        if (!probe.online) {
          return res.status(503).json({
            error: `no agent currently online for ${hostname}; last heartbeat ${probe.lastHeartbeatAt || 'never'}`,
            lastHeartbeatAt: probe.lastHeartbeatAt ?? null
          });
        }
      } catch (e) {
        logger.error({ err: e, hostname }, 'member-commands online-check failed');
        return res.status(503).json({ error: 'host-online check failed; retry or pass ?force=true' });
      }
    }
    let row;
    try {
      const { queueCommand } = await import('../services/member-commands.js');
      row = await queueCommand({
        hostname,
        params,
        operatorId: req.user?.sub ?? null,
        skipOnlineCheck: true // already checked above
      });
    } catch (e) {
      if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.message });
      logger.error({ err: e, hostname }, 'member-commands queue failed');
      return res.status(500).json({ error: '内部错误' });
    }
    // Audit row (spec §3.4 ruling #7). Payload: redact password-shaped
    // keys (defense-in-depth — script body is operator-visible so we
    // include a short script summary + the timeoutSec for context).
    const scriptSummary = (params && typeof params.script === 'string')
      ? params.script.slice(0, 256)
      : null;
    const timeoutSec = (params && Number.isFinite(Number(params.timeoutSec)))
      ? Number(params.timeoutSec)
      : null;
    const auditParams = params ? redactPasswordsForAudit(params) : null;
    await writeAudit({
      userId: req.user?.sub ?? null,
      action: 'ad_member_command_queued',
      target: `host:${hostname}`,
      payload: {
        commandId: row.id,
        hostname,
        commandType: 'member_script',
        timeoutSec,
        scriptSummary,
        params: auditParams
      },
      logger
    });
    res.status(201).json({
      id: row.id,
      hostname: row.hostname,
      commandType: row.command_type,
      status: row.status,
      createdAt: row.created_at
    });
  });

  // GET /api/admin/member-commands — paginated history filtered by
  // hostname (the front-end always narrows by hostname for the history
  // drawer). status filter is also accepted for the admin "all hosts"
  // view.
  // NOTE: /hosts (below) must be registered BEFORE the /:id route —
  // Express routes match in registration order, and `hosts` would
  // otherwise be parsed as `id` and fail Number(req.params.id) validation.
  r.get('/api/admin/member-commands/hosts', authMemberSrv, async (_req, res) => {
    try {
      // R158.61+4 (2026-10-10) — 之前 db.sql.heartbeat.tokenDeliveryList 返所有
      // agent (34 DC + 任何 member-server agent), MemberCommandsView UI 字面是
      // "成员服务器执行命令" 但实际列出 34 DC, 字面/数据冲突. 改查 ad_member_servers
      // (真正的"成员服务器"目录表) 跟 FilePushView 成员服务器模式同源. 0 行是真实
      // 状态 (member server agent 未注册到中心, production 暂无), 提示 operator
      // 先在 /admin/member-servers 添加 host.
      // R158.X.115 (2026-10-20) — 改走 listOnline: 退役/暂停管控的机器
      //   不作为命令下发目标 (退役意味着 agent 都卸了, 暂停意味着操作员明确
      //   不想再管它)。操作员要下发命令就得先恢复管控, 语义清晰。
      const db = getDb();
      const { rows } = await db.query(db.sql.memberServers.listOnline);
      const hosts = (rows || []).map(r => ({
        hostname: r.hostname,
        lastHeartbeatAt: r.last_seen_at ?? null
      }));
      res.json({ hosts });
    } catch (e) {
      logger.error({ err: e }, 'member-commands hosts list failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  r.get('/api/admin/member-commands', authMemberSrv, async (req, res) => {
    try {
      const { listCommands } = await import('../services/member-commands.js');
      const hostname = req.query?.hostname || undefined;
      const status = req.query?.status || undefined;
      const page = req.query?.page ?? 1;
      const size = req.query?.size ?? 50;
      const out = await listCommands({ hostname, status, page, size });
      const rows = out.rows.map(r => ({
        id: r.id,
        hostname: r.hostname,
        commandType: r.command_type,
        status: r.status,
        operatorId: r.operator_id,
        operatorUsername: r.operator_username ?? null,
        createdAt: r.created_at,
        claimedAt: r.claimed_at,
        completedAt: r.completed_at,
        durationMs: r.duration_ms,
        errorMessage: r.error_message
      }));
      res.json({ total: out.total, rows, page: out.page, size: out.size });
    } catch (e) {
      logger.error({ err: e }, 'member-commands list failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // GET /api/admin/member-commands/:id — single row incl. params_json +
  // result_json. Passwords redacted on the way out so a viewer never sees
  // cleartext (defense-in-depth — service already strips on write).
  r.get('/api/admin/member-commands/:id', authMemberSrv, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: '无效的 id' });
    try {
      const { getCommand } = await import('../services/member-commands.js');
      const row = await getCommand(id);
      if (!row) return res.status(404).json({ error: 'command not found' });
      const safeParams = row.params_json ? redactPasswordsForAudit(row.params_json) : null;
      const safeResult = row.result_json ? redactPasswordsForAudit(row.result_json) : null;
      res.json({
        id: row.id,
        hostname: row.hostname,
        commandType: row.command_type,
        status: row.status,
        operatorId: row.operator_id,
        operatorUsername: row.operator_username ?? null,
        params: safeParams,
        result: safeResult,
        errorMessage: row.error_message,
        durationMs: row.duration_ms,
        createdAt: row.created_at,
        claimedAt: row.claimed_at,
        completedAt: row.completed_at
      });
    } catch (e) {
      logger.error({ err: e, id }, 'member-commands get failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // ── R158.35 (2026-10-03) — AD directory LDAP sync ───────────────────
  //
  // Seven endpoints grouped behind authAdObjects (admin:ad-objects perm,
  // legacy admin:users umbrella also grants). All snapshot table reads
  // (ad-users / ad-groups / ad-ous) live here so DailyOpsView + the new
  // /admin/directory-sync view can read a consistent per-DC inventory
  // without going through the agent-mediated user_search command flow.

  // Resolve the bind password from system_config (ciphertext at rest,
  // decrypted in-process only). Shared helper so the trigger endpoint +
  // the status endpoint + future test endpoints don't duplicate logic.
  async function _resolveLdapBindPassword(cfg) {
    const secretKey = deriveSecretKey(process.env, cfg.jwt_secret_current || '');
    try {
      return await resolveBindPassword({ cfg, secretKey, logger });
    } catch (e) {
      logger?.warn?.({ component: 'directory-sync', err: e.message }, 'resolveBindPassword failed');
      return '';
    }
  }

  // Manual trigger. R158.38.2: 中心端读 ad_forest.is_default=1 森林, 遍历其下
  // 所有 domain, 每域一个独立 run 行. body 可选 domainId (单域手动触发) 或留空
  // (遍历全 forest). 无 is_default 森林 → 走 R158.35 system_config 路径 (兼容).
  // 返 { mode: 'forest', runs: [...] } 或 { mode: 'legacy', runId, dcName }.
  r.post('/api/admin/directory-sync', authAdObjects, async (req, res) => {
    try {
      const cfg = await getConfigMap();
      const db = getDb();
      const isMssql = db.dialect === 'mssql';
      // Try default-forest path.
      let forest = null;
      try {
        const forests = await forestRegistry.listForests({ db });
        forest = forests.find(f => f.isDefault) || null;
      } catch (e) {
        logger.warn({ component: 'directory-sync', err: e.message },
          'manual trigger: listForests failed; falling back to system_config');
      }
      if (forest) {
        // R158.5.4 fix (2026-10-04) — getForest 走 rowToForestWire 把 bind_password
        // mask 成 PASSWORD_MASK, 喂 resolveBindPasswordFromForest 永远空. tick
        // 路径必须走 getForestRawRow (raw db row, snake_case, bind_password 真值).
        let forestFull = forest;
        try {
          const raw = await forestRegistry.getForestRawRow(forest.id, { db });
          forestFull = raw || forest;
        } catch (e) {
          logger.warn({ component: 'directory-sync', err: e.message, forestId: forest.id },
            'manual trigger: getForestRawRow failed; bind_password will be empty');
        }
        const domains = await forestRegistry.listDomains(forest.id, { db });
        if (!domains || domains.length === 0) {
          return res.status(400).json({ error: '默认森林下没有域' });
        }
        const sk = deriveSecretKey(process.env, cfg?.jwt_secret_current || '');
        let bindPassword = '';
        try {
          bindPassword = await resolveBindPasswordFromForest({ forestRow: forestFull, secretKey: sk, logger });
        } catch (e) {
          logger.warn({ component: 'directory-sync', err: e.message },
            'manual trigger: forest bind password decrypt failed');
        }
        if (!bindPassword) {
          return res.status(500).json({ error: '森林绑定密码为空或解密失败' });
        }
        // R158.39 (2026-10-03) — Domain filter (3 种模式):
        //   1) domainIds: number[] — 多选, 操作员勾选本次要同步的域 (UI DirectorySyncView)
        //   2) domainId: number    — 单数, 老接口兼容 (UI "立即同步此域")
        //   3) 无 filter            — 默认全量, 但仍受 sync_enabled 限制 (listEnabledDomains)
        // 手动触发多选**不受** sync_enabled 限制 — operator 临时同步 disabled 域很常见.
        let targetDomains;
        const bodyIds = req.body?.domainIds;
        if (Array.isArray(bodyIds) && bodyIds.length > 0) {
          const idSet = new Set(bodyIds.map(x => Number(x)).filter(Number.isInteger));
          targetDomains = domains.filter(d => idSet.has(Number(d.id)));
          if (targetDomains.length === 0) {
            return res.status(400).json({ error: '所选域不属于默认森林' });
          }
        } else {
          const requestedDomainId = Number(req.body?.domainId);
          if (Number.isInteger(requestedDomainId) && requestedDomainId > 0) {
            targetDomains = domains.filter(d => Number(d.id) === requestedDomainId);
            if (targetDomains.length === 0) {
              return res.status(400).json({ error: '指定的域不属于默认森林' });
            }
          } else {
            // 默认走 enabled 域 (与 cron tick 一致). UI 多选会显式传 domainIds, 此分支
            // 主要给 "没选任何域但 operator 想跑全量" 留入口.
            targetDomains = domains.filter(d => d.syncEnabled);
            if (targetDomains.length === 0) {
              return res.status(400).json({ error: '默认森林下没有启用自动同步的域' });
            }
          }
        }
        // Pick DC per domain (三段选择: assignment → domain.dc_hostname → PDC fallback)
        const pickDcForDomain = async (domain) => {
          try {
            const { rows: aRows } = await db.execute(
              isMssql
                ? `SELECT TOP 1 dc_hostname FROM ad_forest_dc_assignment WHERE domain_id = ?`
                : `SELECT dc_hostname FROM ad_forest_dc_assignment WHERE domain_id = ? LIMIT 1`,
              [domain.id]
            );
            if (aRows?.[0]?.dc_hostname) return aRows[0].dc_hostname;
          } catch { /* ignore — fall through */ }
          if (domain.dcHostname) {
            try {
              const { rows: dRows } = await db.execute(
                isMssql
                  ? `SELECT TOP 1 dc_name FROM ad_dcs WHERE dc_name = ?`
                  : `SELECT dc_name FROM ad_dcs WHERE dc_name = ? LIMIT 1`,
                [domain.dcHostname]
              );
              if (dRows?.[0]?.dc_name) return dRows[0].dc_name;
            } catch { /* ignore */ }
          }
          try {
            const { rows: pRows } = await db.query(
              isMssql
                ? `SELECT TOP 1 dc_name FROM ad_dcs ORDER BY is_pdc DESC, dc_name`
                : `SELECT dc_name FROM ad_dcs ORDER BY is_pdc DESC, dc_name LIMIT 1`
            );
            return pRows?.[0]?.dc_name || null;
          } catch {
            return null;
          }
        };
        const launched = [];
        const skipped = [];
        for (const domain of targetDomains) {
          const dcName = await pickDcForDomain(domain);
          if (!dcName) {
            skipped.push({ domainId: domain.id, domainName: domain.domainName, reason: 'no_dc' });
            continue;
          }
          // R158.44.7.7 (2026-10-05) — syncDirectory now writes the
          // domain FQDN into 3 snapshot tables' `domain_name` column.
          // `dcName` here stays as the DC hostname and is only used to
          // (a) record into `ad_directory_sync_runs.dc_name` (audit),
          // (b) surface in operator-facing log lines.
          const domainName = domain.domainName;
          if (!domainName) {
            skipped.push({ domainId: domain.id, reason: 'no_domain_name' });
            continue;
          }
          let runId = 0;
          try {
            const r = await db.execute(
              _pick(db.sql.directorySync.insertRunWithForest),
              [dcName, 'manual', forest.id, domain.id]
            );
            runId = Number(r?.insertId ?? r?.rows?.[0]?.id ?? 0);
          } catch (e) {
            logger.warn({ component: 'directory-sync', domainId: domain.id, err: e.message },
              'manual trigger: insertRunWithForest failed');
            skipped.push({ domainId: domain.id, domainName: domain.domainName, reason: 'insert_failed', error: e.message });
            continue;
          }
          await writeAudit({
            userId: req.user?.sub ?? null,
            action: 'directory_sync_per_domain',
            target: `forest:${forest.id}/domain:${domain.id}`,
            payload: { runId, dcName, domainName, domainId: domain.id, trigger: 'manual' },
            logger
          });
          // R158.5.4 (2026-10-04) — domain-config 三件套 (base_dn / sync_mode /
          // bind_password). 优先级: domainKV.base_dn > domain.domainDn; syncMode
          // = independent 且 hasDomainPassword → 解域密码, 否则用森林密码.
          let effective = { baseDn: domain.domainDn, syncMode: 'inherit', hasDomainPassword: false };
          try {
            effective = await forestRegistry.getEffectiveDomainConfig(domain, { db, logger });
          } catch (e) {
            logger.warn({ component: 'directory-sync', domainId: domain.id, err: e.message },
              'manual trigger: getEffectiveDomainConfig threw; using defaults');
          }
          let effectiveBindPassword = bindPassword;
          let usedDomainPassword = false;
          if (effective.syncMode === 'independent' && effective.hasDomainPassword) {
            try {
              const dp = await forestRegistry.getDomainBindPassword(domain.id, {
                db,
                jwtSecret: cfg?.jwt_secret_current || config?.jwtSecret || '',
                logger
              });
              if (dp) {
                effectiveBindPassword = dp;
                usedDomainPassword = true;
              }
            } catch (e) {
              logger.warn({ component: 'directory-sync', domainId: domain.id, err: e.message },
                'manual trigger: getDomainBindPassword threw; using forest password');
            }
          }
          // R158.5.4 (2026-10-04) — 结构化日志. operator 「增加同步日志信息」:
          // - 入队打 INFO (forestId/domainId/runId/dcName/syncMode/baseDn/usedDomainPassword)
          // - 完成 (成功/失败) 打 INFO 含耗时 + counts / errorMessage. 失败细分:
          //   'preflight' (配置错误) vs 'sync' (LDAP 错误).
          // R158.44.2 (2026-10-04) — 加 ldapUrl 覆盖: priority domain setting > forest.adUrl.
          // R158.44.3 (2026-10-04) — 加 bindDn 覆盖: priority domain setting > forest.bindDn.
          const effectiveLdapUrl = ensureLdapPort(effective.ldapUrl || forest.adUrl);
          const effectiveBindDn = effective.bindDn || forest.bindDn || '';
          const startedAt = Date.now();
          logger.info({
            component: 'directory-sync',
            event: 'manual_sync_queued',
            runId, dcName, domainName,
            forestId: forest.id, forestName: forest.forestName,
            domainId: domain.id,
            syncMode: effective.syncMode, baseDn: effective.baseDn,
            usedDomainPassword, usedDomainLdapUrl: effective.hasDomainLdapUrl,
            usedDomainBindDn: effective.hasDomainBindDn,
            ldapUrl: effectiveLdapUrl, bindDn: effectiveBindDn, triggeredBy: 'manual'
          }, 'manual sync queued');
          syncDirectory({
            db, logger, domainName, runId,
            forestId: forest.id, domainId: domain.id,
            config: {
              ldapUrl: effectiveLdapUrl,
              bindDn: effectiveBindDn,
              bindPassword: effectiveBindPassword,
              baseDn: effective.baseDn,
              pageSize: 500
            }
          }).then(result => {
            const durationMs = Date.now() - startedAt;
            logger.info({
              component: 'directory-sync',
              event: 'manual_sync_succeeded',
              runId, dcName, domainName,
              forestId: forest.id, forestName: forest.forestName,
              domainId: domain.id,
              durationMs,
              userCount: result.userCount,
              groupCount: result.groupCount,
              ouCount: result.ouCount,
              orphanDeleted: result.orphanDeleted
            }, 'manual sync succeeded');
          }).catch(err => {
            const durationMs = Date.now() - startedAt;
            const isPreflight = /^syncDirectory preflight:/.test(err?.message || '');
            logger.warn({
              component: 'directory-sync',
              event: isPreflight ? 'manual_sync_failed_preflight' : 'manual_sync_failed_sync',
              runId, dcName, domainName,
              forestId: forest.id, forestName: forest.forestName,
              domainId: domain.id,
              durationMs,
              errorMessage: err?.message || String(err),
              stack: err?.stack ? String(err.stack).split('\n').slice(0, 3).join('\n') : null
            }, 'manual sync failed (post-202)');
          });
          launched.push({ runId, domainId: domain.id, domainName: domain.domainName, dcName });
        }
        await writeAudit({
          userId: req.user?.sub ?? null,
          action: 'directory_sync_manual_trigger',
          target: `forest:${forest.id}`,
          payload: { mode: 'forest', runIds: launched.map(x => x.runId), skipped: skipped.length },
          logger
        });
        if (launched.length === 0) {
          return res.status(500).json({ error: '没有可同步的域 (无 DC)', skipped });
        }
        return res.status(202).json({ mode: 'forest', forestId: forest.id, forestName: forest.forestName, runs: launched, skipped });
      }
      // ---- Legacy R158.35 path (no is_default forest) ----
      if (!cfg.ad_ldap_url) {
        return res.status(500).json({ error: 'ad_ldap_url not configured' });
      }
      if (!cfg.ad_base_dn) {
        return res.status(500).json({ error: 'ad_base_dn not configured' });
      }
      const bindPassword = await _resolveLdapBindPassword(cfg);
      if (!bindPassword) {
        // R158.44.7-2 (2026-10-04) — promote legacy-fallback 500 to 503 with
        // structured JSON so operators see a clear remediation hint instead
        // of a generic "not configured". The bind password lives in
        // system_config.ad_bind_password (AES-256-GCM) and is written via
        // ConfigView UI → PUT /api/admin/config; appsettings.json is never
        // the source.
        return res.status(503).json({
          error: 'ad_bind_password not configured',
          hint: '通过 ConfigView → LDAP 区块粘贴并提交绑定密码, 系统会写入 system_config.ad_bind_password (AES-256-GCM 加密存储).',
          configKey: 'ad_bind_password'
        });
      }
      // Pick the DC: explicit body.dcName → that DC, else PDC emulator
      // (matches the cron loop's selection rule).
      let dcName = req.body?.dcName;
      let domainName;
      if (!dcName) {
        const { rows: dcs } = await db.query(
          isMssql
            ? `SELECT TOP 1 d.dc_name, fd.domain_name
                 FROM ad_dcs d
                 LEFT JOIN ad_forest_dc_assignment a ON a.dc_hostname = d.dc_name
                 LEFT JOIN ad_forest_domain fd ON fd.id = a.domain_id
                ORDER BY d.is_pdc DESC, d.dc_name`
            : `SELECT d.dc_name, fd.domain_name
                 FROM ad_dcs d
                 LEFT JOIN ad_forest_dc_assignment a ON a.dc_hostname = d.dc_name
                 LEFT JOIN ad_forest_domain fd ON fd.id = a.domain_id
                ORDER BY d.is_pdc DESC, d.dc_name LIMIT 1`
        );
        dcName = dcs[0]?.dc_name;
        domainName = dcs[0]?.domain_name || dcName;
      } else {
        // explicit dcName in body: resolve to domainName.
        domainName = await hostnameToDomainName(db, isMssql, dcName);
      }
      if (!dcName) {
        return res.status(500).json({ error: 'no ad_dcs rows (register at least one DC)' });
      }
      const insertResult = await db.execute(
        db.sql.directorySync.insertRun, [dcName, 'manual']
      );
      const runId = Number(insertResult?.insertId ?? insertResult?.rows?.[0]?.id ?? 0);
      if (!runId) {
        return res.status(500).json({ error: 'insertRun returned no id' });
      }
      // Audit row BEFORE the async work so a thrown sync can't strand the
      // audit log. The audit row records the manual-trigger intent, not
      // the outcome (outcome is recorded via the runs row's status).
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'directory_sync_manual_trigger',
        target: dcName,
        payload: { runId, dcName, mode: 'legacy' },
        logger
      });
      // Fire-and-forget: caller polls /api/admin/directory-sync/runs to
      // observe status. We don't await — the route returns 202 immediately.
      syncDirectory({
        db, logger, domainName, runId,
        config: {
          ldapUrl: cfg.ad_ldap_url,
          bindDn: cfg.ad_bind_dn || '',
          bindPassword,
          baseDn: cfg.ad_base_dn,
          pageSize: 500
        }
      }).catch(err => {
        logger.warn({ component: 'directory-sync', runId, err: err?.message },
          'manual directory sync failed (post-202)');
      });
      res.status(202).json({ mode: 'legacy', runId, status: 'running', dcName });
    } catch (e) {
      logger.error({ err: e?.message }, 'directory sync manual trigger failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // List recent runs (most recent first). Limit clamped 1..100.
  // R158.38: switch to listRunsWithForest (JOIN ad_forest + ad_forest_domain).
  // 老 listRuns SQL 没 forest_name / domain_name, runRowToWire 已容错 (null/undefined).
  r.get('/api/admin/directory-sync/runs', authAdObjects, async (req, res) => {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
    try {
      const db = getDb();
      const { rows } = await db.execute(
        _pick(db.sql.directorySync.listRunsWithForest),
        [limit]
      );
      res.json({ runs: rows.map(runRowToWire) });
    } catch (e) {
      logger.error({ err: e?.message }, 'directory sync runs list failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // R158.5.4 (2026-10-04) — finalize stuck 'running' runs older than minAgeMin.
  // One-shot cleanup for rows stuck before the preflight fix; matrix UI
  // can't recover from these without manual DB access. Audit recorded.
  r.post('/api/admin/directory-sync/finalize-stuck', authAdObjects, async (req, res) => {
    try {
      const minAgeMin = Math.max(1, Number(req.body?.minAgeMin) || 30);
      const cutoffIso = new Date(Date.now() - minAgeMin * 60_000).toISOString();
      const db = getDb();
      const isMssql = db.dialect === 'mssql';
      // R161.5 (2026-10-26) — MySQL 5.7 的 DATETIME 列拒绝 ISO 8601 字符串。
      //   ad_directory_sync_runs.started_at 是 DATETIME NOT NULL ⇒ 绑 ISO 会
      //   ER 1292 ⇒ 整条 UPDATE 回滚 ⇒ 手动清理接口"看起来成功但什么都没做"。
      //   MSSQL 侧 datetime2 接受 ISO ⇒ 只在 MySQL 分支转。
      const cutoffParam = isMssql ? cutoffIso : toMysqlDatetime(cutoffIso);
      const sql = isMssql
        ? `UPDATE ad_directory_sync_runs
           SET status = 'failed', finished_at = SYSUTCDATETIME(),
               error_message = LEFT(ISNULL(error_message, '') +
                 '; [manual-finalize-stuck] preflight-fix predecessor stuck running', 1900)
           WHERE status = 'running' AND started_at < ?`
        : `UPDATE ad_directory_sync_runs
           SET status = 'failed', finished_at = UTC_TIMESTAMP(),
               error_message = LEFT(IFNULL(error_message, '') +
                 '; [manual-finalize-stuck] preflight-fix predecessor stuck running', 1900)
           WHERE status = 'running' AND started_at < ?`;
      const r2 = await db.execute(sql, [cutoffParam]);
      const swept = r2?.affectedRows ?? r2?.rowsAffected?.[0] ?? 0;
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'directory_sync_finalize_stuck',
        target: 'ad_directory_sync_runs',
        payload: { swept, minAgeMin, cutoffIso },
        logger
      });
      logger.info({
        component: 'directory-sync',
        event: 'manual_finalize_stuck',
        swept, minAgeMin, cutoffIso, userId: req.user?.sub ?? null
      }, 'manual finalize-stuck complete');
      res.json({ ok: true, swept, minAgeMin, cutoffIso });
    } catch (e) {
      logger.error({ err: e?.message }, 'directory sync finalize-stuck failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // Aggregate status view: configuration state + last successful run +
  // next-run estimate. Used by both DirectorySyncView (full panel) and
  // DailyOpsView (topbar chip / 24h-stale hint).
  // R158.38: 加 binding 字段 (null 或 {forestId,forestName,domainId,domainName,boundAt}).
  // configured 语义放宽: system_config 4 key 齐全 OR binding 存在 (任一).
  r.get('/api/admin/directory-sync/status', authAdObjects, async (_req, res) => {
    try {
      const cfg = await getConfigMap();
      // R158.46.1 (2026-10-06) — operator 改同步周期单位 小时→分钟. 读
      //   新 key ad_sync_interval_minutes, 范围 1-1440, 默认 60.
      const intervalMinutes = Math.max(1, Number(cfg.ad_sync_interval_minutes) || 60);
      const db = getDb();
      // R158.38.2 — 中心端 sync 由 is_default=1 森林驱动 (无 binding 单行表).
      let defaultForest = null;
      try {
        const forests = await forestRegistry.listForests({ db });
        defaultForest = forests.find(f => f.isDefault) || null;
      } catch { /* forest 表可能未建, 不挡 status */ }
      let lastRun = null;
      try {
        const { rows } = await db.execute(
          _pick(db.sql.directorySync.listRunsWithForest),
          [1]
        );
        lastRun = rows[0] ? runRowToWire(rows[0]) : null;
      } catch { /* runs table may be empty on first run */ }
      // R158.46.1 — nextRunEstimate 换算改 * 60_000 (分钟→毫秒).
      const nextRunEstimate = lastRun?.finishedAt
        ? new Date(new Date(lastRun.finishedAt).getTime() + intervalMinutes * 60_000).toISOString()
        : null;
      const configuredLegacy = Boolean(cfg.ad_ldap_url && cfg.ad_bind_dn && cfg.ad_bind_password && cfg.ad_base_dn);
      // R158.39 (2026-10-03) — 列出默认森林下的所有域 (含 disabled), 给
      // DirectorySyncView 多选卡用. 操作员勾选本次同步哪些域, 默认全选 enabled 域.
      let domains = [];
      if (defaultForest) {
        try {
          domains = await forestRegistry.listDomains(defaultForest.id, { db });
        } catch { /* ignore */ }
      }
      res.json({
        defaultForest: defaultForest ? { id: defaultForest.id, forestName: defaultForest.forestName, rootDn: defaultForest.rootDn } : null,
        configured: configuredLegacy || Boolean(defaultForest),
        ldapUrl: maskAdLdapUrlForRead(cfg.ad_ldap_url || ''),
        bindDn: cfg.ad_bind_dn || '',
        baseDn: cfg.ad_base_dn || '',
        intervalMinutes,
        lastRun,
        nextRunEstimate,
        domains: domains.map(d => ({
          id: d.id,
          domainName: d.domainName,
          domainDn: d.domainDn,
          role: d.role,
          syncEnabled: d.syncEnabled
        }))
      });
    } catch (e) {
      logger.error({ err: e?.message }, 'directory sync status read failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // R158.45.34 (2026-10-06) — operator "在 /admin/directory-sync 定义同步周期":
  //   之前 intervalHours 是 system_config.ad_sync_interval_hours 全局 key, 但
  //   UI 没有入口改. 加 PUT 端点接受 intervalHours, 写 system_config (1-168
  //   小时, 整数), 并 audit. directory-sync-loop.js 已经在每次 tick 读这个 key,
  //   所以改完**下次 cron tick 就生效**. 不需重启 backend.
  // R158.46.1 (2026-10-06) — operator 改同步周期单位 小时→分钟. 路径改名
  //   /interval-minutes, body 字段名 intervalMinutes, 范围 1-1440 分钟整数,
  //   写 system_config.ad_sync_interval_minutes. 老 key
  //   ad_sync_interval_hours 由 config.js 的 boot-time migration 一次性迁移.
  r.put('/api/admin/directory-sync/interval-minutes', authAdObjects, async (req, res) => {
    try {
      const raw = req.body?.intervalMinutes;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 1 || n > 1440 || !Number.isInteger(n)) {
        return res.status(400).json({ error: 'intervalMinutes 必须是 1-1440 之间的整数分钟' });
      }
      // R158.47.2 (2026-10-06) — M1 fix (CWE-778 audit completeness):
      //   config UPDATE + writeAudit 包进 db.transaction, 跟 config.js:121
      //   putConfig 同款 atomic 模式. 业务写入失败 / audit_logs INSERT 失败
      //   都整体 rollback, 不可能 commit 了 config 但 audit 漏. writeAuditRequired
      //   在 tx 内 throw → tx 整体回滚.
      const db = getDb();
      await db.transaction(async (tx) => {
        // R158.56c (2026-10-09) — 修 tx.dialect → db.dialect. tx wrapper 只暴露
        // { sql, execute, query }, 不暴露 dialect 字段, 所以原来的三元永远走
        // UTC_TIMESTAMP() (MySQL), MSSQL 部署下报 "'UTC_TIMESTAMP' is not a
        // recognized built-in function name" → 500. 同样的真因也存在于
        // admin.js:814 (audit-config rollback).
        await tx.execute(
          db.dialect === 'mssql'
            ? `UPDATE system_config SET config_value = ?, updated_at = SYSUTCDATETIME() WHERE config_key = ?`
            : `UPDATE system_config SET config_value = ?, updated_at = UTC_TIMESTAMP() WHERE config_key = ?`,
          [String(n), 'ad_sync_interval_minutes']
        );
        const audit = await import('../services/audit.js');
        await audit.writeAuditRequired({
          userId: req.user?.sub ?? null,
          action: 'config.set',
          target: 'system_config:ad_sync_interval_minutes',
          payload: { intervalMinutes: n }
        }, logger, tx);
      });
      res.json({ ok: true, intervalMinutes: n });
    } catch (e) {
      // tx 内任何失败 (业务写 / audit 写 / commit) 都到这里 → 5xx 整体拒绝
      logger.error({ err: e?.message }, 'interval-minutes update failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // ── R158.43 (2026-10-03) — AD directory-sync 只读预览 ────────────────
  //
  // Three new endpoints under authAdObjects (admin:ad-objects perm):
  //   1) GET /api/admin/directory-sync/forest-summary
  //      → 列出**所有**森林 + 每森林下所有域 (含 disabled) + 每 (forest, domain)
  //        最近一次 sync_run (status / counts / started_at). 让 operator 一眼
  //        看懂全森林同步链路状态, 不只 is_default=1 那一个.
  //   2) GET /api/admin/directory-sync/domain-binding/:domainId
  //      → 返该域下所有 binding DC (三段选择: assignment → domain.dc_hostname
  //        → PDC fallback) + 每个 DC 最近一次 sync_run.
  //   3) GET /api/admin/directory-sync/snapshot/:dcName
  //      → 一次返 ad_ous_snapshot + ad_users_snapshot + ad_groups_snapshot 三
  //        张表全量数据 + lastRun summary. 客户端无需发 3 个串行请求.
  // 这 3 个 endpoint 都是**只读** — 不写 audit, 不触发 sync, 不调 LDAP.

  // 1) forest-summary: 全森林 + 每域最近 run 状态.
  r.get('/api/admin/directory-sync/forest-summary', authAdObjects, async (_req, res) => {
    try {
      const db = getDb();
      const forests = await forestRegistry.listForests({ db });
      // 取所有域最近一次 sync run (LEFT JOIN, 无 run 域也保留). MSSQL TOP (?)
      // 类型推断坑 (R158.17.5) — 此处用固定 TOP 100 (forest×domain 远小于).
      const isMssql = db.dialect === 'mssql';
      const runsSql = isMssql
        ? `SELECT TOP 100 r.dc_name, r.forest_id, r.domain_id, r.status,
                 r.user_count, r.group_count, r.ou_count,
                 r.started_at, r.finished_at, r.error_message
            FROM ad_directory_sync_runs r
            WHERE r.id IN (
              SELECT MAX(id) FROM ad_directory_sync_runs
              WHERE forest_id IS NOT NULL AND domain_id IS NOT NULL
              GROUP BY forest_id, domain_id
            )
            ORDER BY r.started_at DESC`
        : `SELECT r.dc_name, r.forest_id, r.domain_id, r.status,
                 r.user_count, r.group_count, r.ou_count,
                 r.started_at, r.finished_at, r.error_message
            FROM ad_directory_sync_runs r
            INNER JOIN (
              SELECT forest_id, domain_id, MAX(id) AS max_id
              FROM ad_directory_sync_runs
              WHERE forest_id IS NOT NULL AND domain_id IS NOT NULL
              GROUP BY forest_id, domain_id
            ) m ON m.max_id = r.id
            ORDER BY r.started_at DESC${isMssql ? '' : ' LIMIT 100'}`;
      const { rows: runRows } = await db.query(runsSql);
      const runByPair = new Map();
      for (const r of runRows) {
        runByPair.set(`${r.forest_id}:${r.domain_id}`, r);
      }
      // 加载每个 forest 的所有域
      const out = [];
      for (const f of forests) {
        const domains = await forestRegistry.listDomains(f.id, { db });
        out.push({
          id: Number(f.id),
          forestName: f.forestName,
          rootDn: f.rootDn,
          adUrl: f.adUrl,
          isDefault: Boolean(f.isDefault),
          domains: (domains || []).map(d => {
            const lastRun = runByPair.get(`${f.id}:${d.id}`) || null;
            return {
              id: Number(d.id),
              domainName: d.domainName,
              domainDn: d.domainDn,
              role: d.role,
              syncEnabled: d.syncEnabled,
              dcHostname: d.dcHostname || null,
              lastRun: lastRun ? runRowToWire(lastRun) : null
            };
          })
        });
      }
      res.json({ forests: out });
    } catch (e) {
      logger.error({ err: e?.message }, 'directory-sync forest-summary failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // 2) domain-binding: 给定 domainId, 返该域下所有 binding DC + 最近 run.
  //    binding 链路三段: ad_forest_dc_assignment → domain.dc_hostname → PDC.
  r.get('/api/admin/directory-sync/domain-binding/:domainId', authAdObjects, async (req, res) => {
    try {
      const domainId = Number(req.params.domainId);
      if (!Number.isInteger(domainId) || domainId <= 0) {
        return res.status(400).json({ error: '无效的 domainId' });
      }
      const db = getDb();
      const isMssql = db.dialect === 'mssql';
      // Resolve domain row (拿 domain_name / forest_id / dc_hostname).
      // R158.43 — 用 forestRegistry.getDomain (本轮公开化的 helper), 走
      // dict.getDomain SQL (assignDc 内部同源, 复用 0 风险).
      const domainWire = await forestRegistry.getDomain(domainId, { db });
      if (!domainWire) return res.status(404).json({ error: '域不存在' });
      // rowToDomainWire 字段: id / domainName / domainDn / role / dcHostname /
      // syncEnabled / createdAt. 下方三段选择仍需 dc_hostname, 从 wire 拿.
      const domainRow = {
        id: domainWire.id,
        domain_name: domainWire.domainName,
        domain_dn: domainWire.domainDn,
        role: domainWire.role,
        dc_hostname: domainWire.dcHostname || null,
        sync_enabled: domainWire.syncEnabled == null ? 1 : (domainWire.syncEnabled ? 1 : 0)
      };
      // 1) ad_forest_dc_assignment 行 (PK = domain_id + dc_hostname)
      // R158.5 (2026-10-04) — schema drift 修: 表列名是 assigned_at (非
      // created_at); ad_sites PK 是 site_id (非 id). R158.43 endpoint
      // 留了旧名残影, 现网返 500.
      const { rows: assignmentRows } = await db.execute(
        isMssql
          ? `SELECT TOP 50 a.dc_hostname, a.site_id, a.assigned_at, s.site_name, d.is_pdc
             FROM ad_forest_dc_assignment a
             LEFT JOIN ad_sites s ON s.site_id = a.site_id
             LEFT JOIN ad_dcs d ON d.dc_name = a.dc_hostname
             WHERE a.domain_id = ?
             ORDER BY a.assigned_at DESC`
          : `SELECT a.dc_hostname, a.site_id, a.assigned_at, s.site_name, d.is_pdc
             FROM ad_forest_dc_assignment a
             LEFT JOIN ad_sites s ON s.site_id = a.site_id
             LEFT JOIN ad_dcs d ON d.dc_name = a.dc_hostname
             WHERE a.domain_id = ?
             ORDER BY a.assigned_at DESC
             LIMIT 50`,
        [domainId]
      );
      // 2) domain.dc_hostname 兜底
      const fallbackHost = domainRow.dc_hostname || null;
      // 3) PDC emulator 兜底
      const { rows: pdcRows } = await db.query(
        isMssql
          ? `SELECT TOP 1 dc_name FROM ad_dcs ORDER BY is_pdc DESC, dc_name`
          : `SELECT dc_name FROM ad_dcs ORDER BY is_pdc DESC, dc_name LIMIT 1`
      );
      const pdcHostname = pdcRows[0]?.dc_name || null;
      // 合并去重 (按 hostname 唯一)
      const byHostname = new Map();
      const tagSource = (hostname, source) => {
        if (!hostname) return;
        const ex = byHostname.get(hostname);
        if (!ex) byHostname.set(hostname, { hostname, source });
      };
      for (const a of assignmentRows) tagSource(a.dc_hostname, 'assignment');
      if (fallbackHost && !byHostname.has(fallbackHost)) tagSource(fallbackHost, 'domain_default');
      if (pdcHostname && !byHostname.has(pdcHostname)) tagSource(pdcHostname, 'pdc_fallback');
      // 对每个 hostname 查 ad_dcs 拿 is_pdc + site_name (ad_dcs 表里有 site_id, 需要 JOIN)
      const hostnames = Array.from(byHostname.keys());
      const dcInfoMap = new Map();
      if (hostnames.length > 0) {
        // ad_dcs 表结构已知 (R158.41 schema): dc_name PK + site_id + is_pdc + ...
        const placeholders = hostnames.map((_, i) => `?`).join(',');
        const { rows: dcInfoRows } = await db.execute(
          `SELECT d.dc_name, d.is_pdc, d.site_id, s.site_name
           FROM ad_dcs d LEFT JOIN ad_sites s ON s.site_id = d.site_id
           WHERE d.dc_name IN (${placeholders})`,
          hostnames
        );
        for (const row of dcInfoRows) {
          dcInfoMap.set(row.dc_name, {
            isPdc: row.is_pdc == null ? null : Boolean(Number(row.is_pdc)),
            siteName: row.site_name || null
          });
        }
      }
      // 取每个 hostname 最近一次 sync_run
      const lastRunMap = new Map();
      if (hostnames.length > 0) {
        // R158.44.5 fix (2026-10-04) — 单 host 每次查: SQL 用 `WHERE dc_name = ?`
        // (1 占位符), 跟 db.execute(lastRunSql, [hn]) 1 参数对齐. 之前用
        // `WHERE dc_name IN (${placeholders})` 把 placeholders 一次拼成 N 个
        // 占位符, 但 for-loop 每次只传 1 个 [hn] → MSSQL 报
        // "Must declare the scalar variable \"@p2\"" 500.
        const lastRunSql = isMssql
          ? `SELECT TOP 1 dc_name, status, user_count, group_count, ou_count,
                   started_at, finished_at, error_message
              FROM ad_directory_sync_runs
              WHERE dc_name = ?
              ORDER BY id DESC`
          : `SELECT dc_name, status, user_count, group_count, ou_count,
                   started_at, finished_at, error_message
              FROM ad_directory_sync_runs
              WHERE dc_name = ?
              ORDER BY id DESC LIMIT 1`;
        // 给每个 hostname 各跑一次最新 run 查询 (避免 GROUP BY dc_name 在 MSSQL 上坑)
        for (const hn of hostnames) {
          const { rows } = await db.execute(lastRunSql, [hn]);
          if (rows[0]) lastRunMap.set(hn, rows[0]);
        }
      }
      const dcs = hostnames.map(hn => {
        const info = dcInfoMap.get(hn) || { isPdc: null, siteName: null };
        const lr = lastRunMap.get(hn);
        return {
          hostname: hn,
          isPdc: info.isPdc,
          siteName: info.siteName,
          source: byHostname.get(hn).source,
          lastRun: lr ? runRowToWire(lr) : null
        };
      });
      res.json({
        domain: {
          id: Number(domainRow.id),
          domainName: domainRow.domain_name,
          domainDn: domainRow.domain_dn,
          role: domainRow.role,
          syncEnabled: domainRow.sync_enabled == null ? true : Boolean(Number(domainRow.sync_enabled))
        },
        dcs
      });
    } catch (e) {
      logger.error({ err: e?.message, domainId: req.params.domainId },
        'directory-sync domain-binding failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // 3) snapshot: 给定 dcName, 一次返 3 张 snapshot 表全量 + lastRun.
  //    DailyOpsView 已经在调 ad-ous/ad-users/ad-groups 3 endpoint — 此 endpoint
  //    是**聚合版**, DirectorySyncView 用它一次性拉全, 客户端无需发 3 串行请求.
  // R158.44.7.7 (2026-10-05) — URL :dcName is still the DC hostname (frontend
  // doesn't change). The 3 snapshot tables now store `domain_name` (FQDN),
  // so we resolve dcName -> domainName once, then query by domain_name.
  // `runs.dc_name` keeps its DC hostname meaning, so the lastRun query stays
  // as-is (DC is the audit trace).
  r.get('/api/admin/directory-sync/snapshot/:dcName', authAdObjects, async (req, res) => {
    const dcName = String(req.params.dcName || '').trim();
    if (!dcName) return res.status(400).json({ error: 'dcName required' });
    try {
      const db = getDb();
      const isMssql = db.dialect === 'mssql';
      const domainName = await hostnameToDomainName(db, isMssql, dcName);
      // 三张 snapshot 表全量 + MAX(snapshot_at) 并行.
      // groups_snapshot OU 关系靠 ou_dn 列 (R158.44.7.7) + distinguished_name LIKE `%,`.
      const ousSql = `SELECT * FROM ad_ous_snapshot
                      WHERE domain_name = ? ORDER BY distinguished_name`;
      const usersSql = `SELECT * FROM ad_users_snapshot
                        WHERE domain_name = ? ORDER BY sam`;
      const groupsSql = `SELECT * FROM ad_groups_snapshot
                         WHERE domain_name = ? ORDER BY name`;
      // R158.44.7.10 (2026-10-05) — 第 4 张表 computer snapshot.
      const computersSql = `SELECT * FROM ad_computers_snapshot
                             WHERE domain_name = ? ORDER BY sam_account_name`;
      const snapSql = `SELECT MAX(snapshot_at) AS snapshot_at,
                              MAX(snapshot_run_id) AS snapshot_run_id
                       FROM ad_ous_snapshot WHERE domain_name = ?`;
      const lastRunSql = isMssql
        ? `SELECT TOP 1 * FROM ad_directory_sync_runs
           WHERE dc_name = ?
           ORDER BY id DESC`
        : `SELECT * FROM ad_directory_sync_runs
           WHERE dc_name = ?
           ORDER BY id DESC LIMIT 1`;
      const [
        { rows: ous },
        { rows: users },
        { rows: groups },
        { rows: computers },
        { rows: snapRows },
        { rows: lastRunRows }
      ] = await Promise.all([
        db.query(ousSql, [domainName]),
        db.query(usersSql, [domainName]),
        db.query(groupsSql, [domainName]),
        db.query(computersSql, [domainName]),
        db.query(snapSql, [domainName]),
        db.query(lastRunSql, [dcName])
      ]);
      res.json({
        dcName,
        domainName,
        ous: ous.map(r => ouRowToWire(r, dcName)),
        users: users.map(r => userRowToWire(r, dcName)),
        groups: groups.map(r => groupRowToWire(r, dcName)),
        computers: computers.map(r => computerRowToWire(r, dcName)),
        snapshotAt: snapRows[0]?.snapshot_at || null,
        snapshotRunId: snapRows[0]?.snapshot_run_id == null
          ? null : Number(snapRows[0].snapshot_run_id),
        lastRun: lastRunRows[0] ? runRowToWire(lastRunRows[0]) : null
      });
    } catch (e) {
      logger.error({ err: e?.message, dcName }, 'directory-sync snapshot read failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // ---- R158.37 - AD Forest Registry ----
  // Backend "Forest Registry" CRUD endpoints. All gated by authAdObjects.
  // bind_password write path goes through service encryptBindPassword
  // (AES-256-GCM via ad-credential-vault.js); read path always masks to
  // '********'.

  r.get('/api/admin/forest-registry/forests', authAdObjects, async (_req, res) => {
    try {
      const rows = await forestRegistry.listForests({ logger });
      res.json({ forests: rows });
    } catch (e) {
      logger.error({ err: e?.message }, 'forest-registry listForests failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  r.post('/api/admin/forest-registry/forests', authAdObjects, async (req, res) => {
    try {
      const f = await forestRegistry.createForest(req.body || {}, { logger, jwtSecret: config?.jwtSecret });
      await writeAudit({
        userId: req.user?.sub,
        action: 'forest_create',
        target: `ad_forest:${f.id}`,
        payload: { forestName: f.forestName, rootDn: f.rootDn },
        logger
      });
      res.status(201).json({ forest: f });
    } catch (e) {
      const code = e?.http || 500;
      if (code >= 500) logger.error({ err: e?.message }, 'forest-registry createForest failed');
      res.status(code).json({ error: e?.message || '内部错误' });
    }
  });

  r.put('/api/admin/forest-registry/forests/:id', authAdObjects, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的 id' });
      const f = await forestRegistry.updateForest(id, req.body || {}, { logger, jwtSecret: config?.jwtSecret });
      await writeAudit({
        userId: req.user?.sub,
        action: 'forest_update',
        target: `ad_forest:${id}`,
        payload: { forestName: f.forestName },
        logger
      });
      res.json({ forest: f });
    } catch (e) {
      const code = e?.http || 500;
      if (code >= 500) logger.error({ err: e?.message }, 'forest-registry updateForest failed');
      res.status(code).json({ error: e?.message || '内部错误' });
    }
  });

  r.delete('/api/admin/forest-registry/forests/:id', authAdObjects, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的 id' });
      const ok = await forestRegistry.deleteForest(id, { logger });
      if (!ok) return res.status(404).json({ error: '未找到' });
      await writeAudit({
        userId: req.user?.sub,
        action: 'forest_delete',
        target: `ad_forest:${id}`,
        payload: {},
        logger
      });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e?.message }, 'forest-registry deleteForest failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  r.post('/api/admin/forest-registry/forests/:id/default', authAdObjects, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的 id' });
      const ok = await forestRegistry.setDefaultForest(id, { logger });
      if (!ok) return res.status(404).json({ error: '未找到' });
      await writeAudit({
        userId: req.user?.sub,
        action: 'forest_default_set',
        target: `ad_forest:${id}`,
        payload: {},
        logger
      });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e?.message }, 'forest-registry setDefault failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // Domain CRUD — sub-domain / external trust
  r.get('/api/admin/forest-registry/forests/:id/domains', authAdObjects, async (req, res) => {
    try {
      const forestId = Number(req.params.id);
      if (!Number.isInteger(forestId) || forestId <= 0) return res.status(400).json({ error: '无效的 id' });
      const rows = await forestRegistry.listDomains(forestId, {});
      res.json({ domains: rows });
    } catch (e) {
      logger.error({ err: e?.message }, 'forest-registry listDomains failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  r.post('/api/admin/forest-registry/forests/:id/domains', authAdObjects, async (req, res) => {
    try {
      const forestId = Number(req.params.id);
      if (!Number.isInteger(forestId) || forestId <= 0) return res.status(400).json({ error: '无效的 id' });
      const d = await forestRegistry.createDomain(forestId, req.body || {}, {});
      await writeAudit({
        userId: req.user?.sub,
        action: 'forest_domain_create',
        target: `ad_forest_domain:${d.id}`,
        payload: { forestId, domainName: d.domainName, role: d.role },
        logger
      });
      res.status(201).json({ domain: d });
    } catch (e) {
      const code = e?.http || 500;
      if (code >= 500) logger.error({ err: e?.message }, 'forest-registry createDomain failed');
      res.status(code).json({ error: e?.message || '内部错误' });
    }
  });

  r.delete('/api/admin/forest-registry/domains/:id', authAdObjects, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的 id' });
      const ok = await forestRegistry.deleteDomain(id, {});
      if (!ok) return res.status(404).json({ error: '未找到' });
      await writeAudit({
        userId: req.user?.sub,
        action: 'forest_domain_delete',
        target: `ad_forest_domain:${id}`,
        payload: {},
        logger
      });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e?.message }, 'forest-registry deleteDomain failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // DC assignment
  r.post('/api/admin/forest-registry/domains/:id/assign-dc', authAdObjects, async (req, res) => {
    try {
      const domainId = Number(req.params.id);
      if (!Number.isInteger(domainId) || domainId <= 0) return res.status(400).json({ error: '无效的 id' });
      const dcHostname = String(req.body?.dcHostname || '').trim();
      if (!dcHostname) return res.status(400).json({ error: '请填写 DC 主机名' });
      const siteId = req.body?.siteId ?? null;
      const a = await forestRegistry.assignDc(domainId, dcHostname, siteId, {});
      await writeAudit({
        userId: req.user?.sub,
        action: 'forest_dc_assign',
        target: `ad_forest_dc_assignment:${a.id}`,
        payload: { domainId, dcHostname },
        logger
      });
      res.status(201).json({ assignment: a });
    } catch (e) {
      const code = e?.http || 500;
      if (code >= 500) logger.error({ err: e?.message }, 'forest-registry assignDc failed');
      res.status(code).json({ error: e?.message || '内部错误' });
    }
  });

  r.delete('/api/admin/forest-registry/dc-assignments/:hostname', authAdObjects, async (req, res) => {
    try {
      const dcHostname = String(req.params.hostname || '').trim();
      if (!dcHostname) return res.status(400).json({ error: '主机名必填' });
      const ok = await forestRegistry.unassignDc(dcHostname, {});
      if (!ok) return res.status(404).json({ error: '未找到' });
      await writeAudit({
        userId: req.user?.sub,
        action: 'forest_dc_unassign',
        target: `dc_hostname:${dcHostname}`,
        payload: {},
        logger
      });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e?.message }, 'forest-registry unassignDc failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // Settings KV
  r.get('/api/admin/forest-registry/forests/:id/settings', authAdObjects, async (req, res) => {
    try {
      const forestId = Number(req.params.id);
      if (!Number.isInteger(forestId) || forestId <= 0) return res.status(400).json({ error: '无效的 id' });
      const rows = await forestRegistry.listSettings(forestId, {});
      res.json({ settings: rows });
    } catch (e) {
      logger.error({ err: e?.message }, 'forest-registry listSettings failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  r.put('/api/admin/forest-registry/forests/:id/settings/:key', authAdObjects, async (req, res) => {
    try {
      const forestId = Number(req.params.id);
      if (!Number.isInteger(forestId) || forestId <= 0) return res.status(400).json({ error: '无效的 id' });
      const key = String(req.params.key || '').trim();
      if (!key) return res.status(400).json({ error: '请填写设置键名' });
      const value = req.body?.value;
      const s = await forestRegistry.setSetting(forestId, key, value, {});
      await writeAudit({
        userId: req.user?.sub,
        action: 'forest_setting_update',
        target: `ad_forest_setting:${forestId}:${key}`,
        payload: { key, value: value == null ? null : String(value) },
        logger
      });
      res.json({ setting: s });
    } catch (e) {
      logger.error({ err: e?.message }, 'forest-registry setSetting failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  r.delete('/api/admin/forest-registry/forests/:id/settings/:key', authAdObjects, async (req, res) => {
    try {
      const forestId = Number(req.params.id);
      if (!Number.isInteger(forestId) || forestId <= 0) return res.status(400).json({ error: '无效的 id' });
      const key = String(req.params.key || '').trim();
      if (!key) return res.status(400).json({ error: '请填写设置键名' });
      const ok = await forestRegistry.deleteSetting(forestId, key, {});
      if (!ok) return res.status(404).json({ error: '未找到' });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e?.message }, 'forest-registry deleteSetting failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // R158.38.3 (2026-10-03) — 域级设置 (ad_forest_domain_setting). operator
  // 「在域里面也和森林里面也要有和森林一样的同步设置」. 独立表 (决策 B), 与
  // ad_forest_setting 完全对称的 3 endpoint.
  r.get('/api/admin/forest-registry/domains/:id/settings', authAdObjects, async (req, res) => {
    try {
      const domainId = Number(req.params.id);
      if (!Number.isInteger(domainId) || domainId <= 0) return res.status(400).json({ error: '无效的 id' });
      const rows = await forestRegistry.listDomainSettings(domainId, {});
      res.json({ settings: rows });
    } catch (e) {
      logger.error({ err: e?.message }, 'forest-registry listDomainSettings failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  r.put('/api/admin/forest-registry/domains/:id/settings/:key', authAdObjects, async (req, res) => {
    try {
      const domainId = Number(req.params.id);
      const key = String(req.params.key || '').trim();
      if (!Number.isInteger(domainId) || domainId <= 0) return res.status(400).json({ error: '无效的 id' });
      if (!key) return res.status(400).json({ error: '请填写设置键名' });
      const value = req.body?.value;
      const s = await forestRegistry.setDomainSetting(domainId, key, value, {});
      await writeAudit({
        userId: req.user?.sub,
        action: 'domain_setting_update',
        target: `ad_forest_domain:${domainId}/setting:${key}`,
        payload: { domainId, key, value },
        logger
      });
      res.json({ setting: s });
    } catch (e) {
      logger.error({ err: e?.message }, 'forest-registry setDomainSetting failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  r.delete('/api/admin/forest-registry/domains/:id/settings/:key', authAdObjects, async (req, res) => {
    try {
      const domainId = Number(req.params.id);
      const key = String(req.params.key || '').trim();
      if (!Number.isInteger(domainId) || domainId <= 0) return res.status(400).json({ error: '无效的 id' });
      if (!key) return res.status(400).json({ error: '请填写设置键名' });
      const ok = await forestRegistry.deleteDomainSetting(domainId, key, {});
      if (!ok) return res.status(404).json({ error: '未找到' });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e?.message }, 'forest-registry deleteDomainSetting failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // R158.39 (2026-10-03) — 切换某域自动同步开关 (ForestRegistry Tab 2 自动
  // 同步复选框). sync_enabled=0 时 cron tick 跳过该域, 但手动触发 DirectorySyncView
  // 多选仍可临时勾选. PATCH 而非 PUT (只是 toggle, 不是替换).
  r.patch('/api/admin/forest-registry/domains/:id/sync-enabled', authAdObjects, async (req, res) => {
    try {
      const domainId = Number(req.params.id);
      if (!Number.isInteger(domainId) || domainId <= 0) return res.status(400).json({ error: '无效的 id' });
      const enabled = req.body?.enabled;
      if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled 必填 (true|false)' });
      const ok = await forestRegistry.setDomainSyncEnabled(domainId, enabled, {});
      if (!ok) return res.status(404).json({ error: '未找到该域' });
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'domain_sync_enabled_toggle',
        target: `domain:${domainId}`,
        payload: { domainId, enabled },
        logger
      });
      res.json({ ok: true, domainId, syncEnabled: enabled });
    } catch (e) {
      logger.error({ err: e?.message }, 'forest-registry setDomainSyncEnabled failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // R158.5.4 (2026-10-04) — 域级 bind_password 覆盖 (DirectorySyncView 矩阵
  // 行内 [设置密码] 按钮). 加密存 ad_forest_domain_setting KV (AES-256-GCM),
  // 同步时优先级: domain 覆盖 > forest.bind_password. 空字符串 = 删除 KV,
  // 恢复读 forest. PUT 而非 PATCH (整 KV 替换语义).
  r.put('/api/admin/forest-registry/domains/:id/bind-password', authAdObjects, async (req, res) => {
    try {
      const domainId = Number(req.params.id);
      if (!Number.isInteger(domainId) || domainId <= 0) return res.status(400).json({ error: '无效的 id' });
      const plaintext = req.body?.bindPassword;
      if (plaintext == null) return res.status(400).json({ error: '请填写 bindPassword' });
      const hasPassword = plaintext !== '';
      const ok = await forestRegistry.setDomainBindPassword(domainId, plaintext, {
        db: getDb(),
        jwtSecret: config?.jwtSecret
      });
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'domain_bind_password_set',
        target: `domain:${domainId}`,
        payload: { domainId, hasPassword },
        logger
      });
      res.json({ ok: true, domainId, hasPassword });
    } catch (e) {
      logger.error({ err: e?.message }, 'forest-registry setDomainBindPassword failed');
      res.status(e?.http || 500).json({ error: e?.message || '内部错误' });
    }
  });

  // R158.5.4 — 查询某域是否设置了 bind_password 覆盖 (布尔, 不回明文).
  r.get('/api/admin/forest-registry/domains/:id/has-bind-password', authAdObjects, async (req, res) => {
    try {
      const domainId = Number(req.params.id);
      if (!Number.isInteger(domainId) || domainId <= 0) return res.status(400).json({ error: '无效的 id' });
      const hasPassword = await forestRegistry.hasDomainBindPassword(domainId, { db: getDb() });
      res.json({ domainId, hasPassword });
    } catch (e) {
      logger.error({ err: e?.message }, 'forest-registry hasDomainBindPassword failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // R158.37.1 (2026-10-03) - DC-to-domain association dropdown source.
  // Exposes ad_dcs catalog + current assignment state for the Forest
  // Registry "assign DC" modal. Sorted by is_assigned ASC so unassigned
  // DCs surface first; assigned DCs still return but are marked + shown
  // with the (assigned to <domain>) hint in UI. Site name via LEFT JOIN
  // ad_sites.
  r.get('/api/admin/forest-registry/dcs-available', authAdObjects, async (_req, res) => {
    try {
      const db = getDb();
      const isMssql = db.dialect === 'mssql';
      // Both dialects use dc_name in ad_dcs (R148 catalog). site_id is
      // also shared. sites table column names are the same.
      // R158.37.1 fix (2026-10-03) - ad_sites column is site_name NOT name
      // (schema 01-tables.sql L135 mssql L147). 500 was "Invalid column name
      // 'name'". MSSQL/MySQL share the same column name.
      const sqlText = isMssql
        ? `SELECT d.dc_name AS hostname,
                  d.dc_name AS dcName,
                  d.site_id AS siteId,
                  s.site_name AS siteName,
                  a.domain_id AS assignedDomainId,
                  fd.domain_name AS assignedDomainName,
                  fd.forest_id AS assignedForestId,
                  f.forest_name AS assignedForestName,
                  CASE WHEN a.id IS NULL THEN 0 ELSE 1 END AS isAssigned
             FROM ad_dcs d
             LEFT JOIN ad_sites s ON s.site_id = d.site_id
             LEFT JOIN ad_forest_dc_assignment a ON a.dc_hostname = d.dc_name
             LEFT JOIN ad_forest_domain fd ON fd.id = a.domain_id
             LEFT JOIN ad_forest f ON f.id = fd.forest_id
             ORDER BY CASE WHEN a.id IS NULL THEN 0 ELSE 1 END, d.dc_name`
        : `SELECT d.dc_name AS hostname,
                  d.dc_name AS dcName,
                  d.site_id AS siteId,
                  s.site_name AS siteName,
                  a.domain_id AS assignedDomainId,
                  fd.domain_name AS assignedDomainName,
                  fd.forest_id AS assignedForestId,
                  f.forest_name AS assignedForestName,
                  CASE WHEN a.id IS NULL THEN 0 ELSE 1 END AS isAssigned
             FROM ad_dcs d
             LEFT JOIN ad_sites s ON s.site_id = d.site_id
             LEFT JOIN ad_forest_dc_assignment a ON a.dc_hostname = d.dc_name
             LEFT JOIN ad_forest_domain fd ON fd.id = a.domain_id
             LEFT JOIN ad_forest f ON f.id = fd.forest_id
             ORDER BY CASE WHEN a.id IS NULL THEN 0 ELSE 1 END, d.dc_name`;
      const { rows } = await db.query(sqlText);
      res.json({ dcs: rows || [] });
    } catch (e) {
      logger.error({ err: e?.message }, 'forest-registry dcs-available failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // R158.40 (2026-10-03) — domain → 候选 DC. 给 TopContextPicker 三级
  // dropdown 喂数据. 三段选择 (镜像 R158.38 _pickDcForDomain):
  //   1. ad_forest_dc_assignment 显式分配
  //   2. ad_forest_domain.dc_hostname (R158.37.4 加的字段)
  //   3. PDC emulator (R158.35 listPdcEmulators) — forest 范围内
  // 同 DC 可能因多源命中出现多次, service 层去重保留优先级最高.
  r.get('/api/admin/forest-registry/domains/:id/dcs', authAdObjects, async (req, res) => {
    const domainId = Number(req.params.id);
    if (!Number.isInteger(domainId) || domainId <= 0) {
      return res.status(400).json({ error: 'invalid domain id' });
    }
    try {
      const db = getDb();
      const isMssql = db.dialect === 'mssql';
      // ad_forest_dc_assignment 优先 → ad_forest_domain.dc_hostname 次之 →
      // PDC emulator 兜底. 全部 UNION, service 层 dedup by hostname 保留
      // 最早 source ('assignment' > 'domainField' > 'pdc').
      //
      // 2026-10-20 — 补 MSSQL 分支. 原实现只有 MySQL 版, 且用了
      // `CAST(... AS UNSIGNED)`, 这是 MySQL 专有 CAST 目标类型; MSSQL 只认
      // AS INT/BIGINT/DECIMAL/... 遇到 UNSIGNED 直接报语法错 → 本端点在
      // mssql 部署下 100% 500 {"error":"内部错误"}.
      //
      // 为何漏: 本文件 15+ 处兄弟 handler 都有 isMssql 三元分支
      // (admin.js:824 / 1269 / 1841 / 2211 / 2544 / 2894 / 3018 / 3061 /
      //  3129 / 3270 / 3695 / 3860 / 3926 / 4030 / 4091), 唯独本 handler
      // 在加方言支持时没跟上. MSSQL 的等价写法是 AS INT.
      //
      // 其余语法两方言一致: UNION ALL + 派生表 + DISTINCT + CASE ORDER BY
      // 都是标准 SQL, 无需分叉. 故仅 CAST 目标类型按 dialect 分支.
      const castPdc = isMssql
        ? 'CAST(CASE WHEN fd.is_pdc = 1 THEN 1 ELSE 0 END AS INT)'
        : 'CAST(CASE WHEN fd.is_pdc = 1 THEN 1 ELSE 0 END AS UNSIGNED)';
      //
      // 真因 (2026-10-20 实测确认, 不是 CAST):
      //   "ORDER BY items must appear in the select list if SELECT DISTINCT
      //    is specified."
      // 即 MSSQL 严格模式: 用了 SELECT DISTINCT 后, ORDER BY 只能引用
      // SELECT 列表里出现过的**表达式**. 原来的
      //     ORDER BY CASE source WHEN 'assignment' THEN 0 ... END, hostname
      // 里的 CASE 表达式没在 SELECT 列表中 → 直接语法错.
      // MySQL 对此更宽松(默认允许), 所以这个端点在 MySQL 上能跑,
      // 换到 MSSQL 就 500 —— 又一处方言不对称.
      //
      // 修法: 把排序键 src_pri 作为**真实列**选进派生表, 外层按它排序.
      // 这样 DISTINCT / ORDER BY 都在合法的列引用上, 两方言行为一致,
      // 且不需要为 MSSQL 单独分叉 —— 顺带保住了原来的 source 优先级排序
      // (assignment > domainField > pdc), 因为下面 JS 侧 dedup 依赖
      // rows 已按优先级排好序.
      const sqlText = `SELECT hostname, source, is_pdc FROM (
          SELECT a.dc_hostname AS hostname, 'assignment' AS source,
                 ${castPdc} AS is_pdc, 0 AS src_pri
            FROM ad_forest_dc_assignment a
            JOIN ad_forest_domain fd ON fd.id = a.domain_id
           WHERE a.domain_id = ?
          UNION ALL
          SELECT fd.dc_hostname AS hostname, 'domainField' AS source,
                 ${castPdc} AS is_pdc, 1 AS src_pri
            FROM ad_forest_domain fd
           WHERE fd.id = ? AND fd.dc_hostname IS NOT NULL AND fd.dc_hostname <> ''
          UNION ALL
          SELECT d.dc_name AS hostname, 'pdc' AS source, 1 AS is_pdc, 2 AS src_pri
            FROM ad_dcs d
            JOIN ad_forest_domain fd ON fd.id = ?
           WHERE d.is_pdc = 1
      ) t WHERE hostname IS NOT NULL AND hostname <> ''
      ORDER BY src_pri, hostname`;
      const { rows } = await db.query(sqlText, [domainId, domainId, domainId]);
      // Dedup by hostname, 保留优先级最高的 source
      // ('assignment' > 'domainField' > 'pdc').
      //
      // R158.scanfix-B1 (2026-10-20) — 原先外层是 `SELECT DISTINCT`, 现在
      // 去掉了. 两个原因:
      //   1) DISTINCT 会让 MSSQL 拒绝 ORDER BY 里未出现在 SELECT 列表的
      //      表达式 (本次 500 的直接原因).
      //   2) DISTINCT 只能对**整行**去重, 而 UNION ALL 的三支 source 值
      //      不同, 所以同一个 hostname 仍会出现多行 —— DISTINCT 在这里
      //      实际上没起去重作用, 真正去重的是下面这段 JS.
      // 去掉后行为不变: 下面的 priority 比较与 rows 顺序无关, 谁先到
      // 都能正确保留优先级最高的那条.
      const seen = new Map();
      const priority = { assignment: 0, domainField: 1, pdc: 2 };
      for (const r of rows || []) {
        const existing = seen.get(r.hostname);
        if (!existing || priority[r.source] < priority[existing.source]) {
          seen.set(r.hostname, r);
        }
      }
      const dcs = [...seen.values()].map(r => ({
        hostname: r.hostname,
        source: r.source,
        isPdc: Number(r.is_pdc) === 1
      }));
      res.json({ dcs });
    } catch (e) {
      logger.error({ err: e?.message, domainId }, 'forest-registry domain-dcs failed');
      res.status(500).json({ error: '内部错误' });
    }
  });



  // Snapshot: users. Filter on sam OR display_name LIKE. Pagination via
  // limit/offset (MSSQL uses OFFSET/FETCH NEXT; MySQL uses LIMIT/OFFSET).
  // R158.44.7.7 (2026-10-05) — frontend passes the DC hostname in `?dc`.
  // We resolve it to a domain FQDN and filter by `domain_name`.
  // R158.60.20 (2026-10-09) — user-group membership snapshot read. Replaces
  // the R75 ad_user_list_groups agent poll (22.5s timeout). Reads the
  // 5-min sync'd ad_user_group_memberships table directly (~50ms).
  // The user context already provides domain via query param; the SAM is
  // the path component. Empty result with snapshotAt=0 means the user has
  // no group membership rows (either genuinely no groups, or sync hasn't
  // caught up — snapshotAt is returned so the UI can show a staleness hint).
  r.get('/api/admin/ad-users/:sam/groups', authAdObjects, async (req, res) => {
    const sam = String(req.params.sam || '').trim();
    const domain = String(req.query.domain || '').trim();
    if (!sam) return res.status(400).json({ error: 'sam required' });
    if (!domain) return res.status(400).json({ error: 'domain required' });
    try {
      const db = getDb();
      const { rows } = await db.query(
        db.sql.directorySync.listGroupsForUser, [domain, sam]
      );
      const groups = rows.map(r => String(r.group_name || '')).filter(Boolean);
      const { rows: snapRows } = await db.query(
        `SELECT MAX(snapshot_at) AS snapshot_at
           FROM ad_user_group_memberships
          WHERE domain_name = ?`, [domain]
      );
      res.json({
        sam,
        domain,
        groups,
        snapshotAt: snapRows[0]?.snapshot_at || null
      });
    } catch (e) {
      logger.error({ err: e?.message, sam, domain }, 'ad-user-groups snapshot read failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  r.get('/api/admin/ad-users', authAdObjects, async (req, res) => {
    const dc = String(req.query.dc || '').trim();
    // R158.45.10 (2026-10-05) — operator "选了森林和域就显示域树, 跟后面的参数无关":
    //   接受 `domain` 参数 (FQDN), 优先用它直接查; 没传才用 dc 走 hostnameToDomainName.
    const domainDirect = String(req.query.domain || '').trim();
    if (!dc && !domainDirect) return res.status(400).json({ error: 'dc or domain required' });
    const filter = String(req.query.filter || '').trim();
    // R158.40 (2026-10-03) — OU-scoped drill-down. ou_dn 在 snapshot 表里是
    // 用户的 parent OU (来自 AD distinguishedName 第一个 RDN 之外的部分).
    // 不传 ouDn = DC 全量 (R158.35 现状); 传 ouDn = 仅该 OU 下用户.
    const ouDn = String(req.query.ouDn || '').trim();
    // R158.45.11 (2026-10-05) — operator "组和用户计算机信息没出来":
    //   上限从 1000 → 50000, 给 OU 树按域拉全量计数用. 原 1000 在大域
    //   (7527 user / 3865 computer) 直接截断, countUsersGroupsComputers
    //   算 OU 计数时少算, leaf meta 显示 0 / 偏低.
    //   写动作 / 分页 UI 走 1000 (callers 自己传 limit), 不走这里.
    const limit = Math.max(1, Math.min(50000, Number(req.query.limit) || 50000));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const db = getDb();
    const isMssql = db.dialect === 'mssql';
    const filterPct = `%${filter}%`;
    try {
      const domainName = domainDirect || await hostnameToDomainName(db, isMssql, dc);
      const whereOu = ouDn
        ? ` AND (ou_dn = ? OR (',' + ou_dn + ',') LIKE ? ESCAPE '\\')`
        : '';
      // R158.45.30 (2026-10-05) — OU scoped view 列出该 OU 整个子树 (跟 ADUC
      // SUBTREE scope 一致). 之前 `ou_dn = ?` 只挑直接挂载, NB 节点显示 2 行
      // 但 rollUp 197 行. 子树匹配必须支持 baseDN 出现在对象 DN **任意位置
      // + 边界 `,`** (例 `OU=办公室,OU=NB,...` 的 ou_dn 以 `OU=办公室,`
      // 开头, baseDN `OU=NB,...` 在中间). 模式 `,' + baseDN + ',`
      // LIKE `%,<baseDN>,%` 用两侧逗号做边界, 防兄弟 OU (`OU=NBxxx`)
      // 误撞. ESCAPE 转义 baseDN 里可能的 `%` `_` `\` 通配符.
      const ouDnSubstr = ouDn ? `%,${ouDn.replace(/[\\%_]/g, ch => '\\' + ch)},%` : null;
      const listSql = isMssql
        ? `SELECT * FROM ad_users_snapshot
            WHERE domain_name = ?
              AND (sam LIKE ? OR display_name LIKE ?)${whereOu}
            ORDER BY sam
            OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`
        : `SELECT * FROM ad_users_snapshot
            WHERE domain_name = ?
              AND (sam LIKE ? OR display_name LIKE ?)${whereOu}
            ORDER BY sam
            LIMIT ? OFFSET ?`;
      const baseParams = [domainName, filterPct, filterPct];
      const listParams = isMssql
        ? [...baseParams, ...(ouDn ? [ouDn, ouDnSubstr] : []), offset, limit]
        : [...baseParams, ...(ouDn ? [ouDn, ouDnSubstr] : []), limit, offset];
      const totalSql = `SELECT COUNT(*) AS total FROM ad_users_snapshot WHERE domain_name = ?${whereOu}`;
      const [{ rows: list }, { rows: totalRows }, { rows: snapRows }] = await Promise.all([
        db.query(listSql, listParams),
        db.query(totalSql, ouDn ? [domainName, ouDn, ouDnSubstr] : [domainName]),
        db.query(`SELECT MAX(snapshot_at) AS snapshot_at, MAX(snapshot_run_id) AS snapshot_run_id
                    FROM ad_users_snapshot WHERE domain_name = ?`, [domainName])
      ]);
      res.json({
        users: list.map(r => userRowToWire(r, domainName)),
        total: Number(totalRows[0]?.total ?? 0),
        snapshotAt: snapRows[0]?.snapshot_at || null,
        snapshotRunId: snapRows[0]?.snapshot_run_id
          ? Number(snapRows[0].snapshot_run_id) : null
      });
    } catch (e) {
      logger.error({ err: e?.message, dc }, 'ad-users snapshot read failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // Snapshot: groups. Filter on name OR sam_account_name LIKE.
  // R158.44.7.7 (2026-10-05) — OU filter now matches on the new `ou_dn`
  // column directly (no more LIKE-with-leading-comma trick). Filter is on
  // `domain_name` (resolved from DC hostname in `?dc`).
  r.get('/api/admin/ad-groups', authAdObjects, async (req, res) => {
    const dc = String(req.query.dc || '').trim();
    // R158.45.10 (2026-10-05) — 接受 `domain` (FQDN) 参数, 优先用它直接查.
    const domainDirect = String(req.query.domain || '').trim();
    if (!dc && !domainDirect) return res.status(400).json({ error: 'dc or domain required' });
    const filter = String(req.query.filter || '').trim();
    const ouDn = String(req.query.ouDn || '').trim();
    // R158.45.11 (2026-10-05) — operator "组和用户计算机信息没出来":
    //   上限 1000 → 50000. OU 树按域全量拉, 避免大域截断. (R158.45.10)
    const limit = Math.max(1, Math.min(50000, Number(req.query.limit) || 50000));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const db = getDb();
    const isMssql = db.dialect === 'mssql';
    const filterPct = `%${filter}%`;
    try {
      const domainName = domainDirect || await hostnameToDomainName(db, isMssql, dc);
      const whereOu = ouDn
        ? ` AND (ou_dn = ? OR (',' + ou_dn + ',') LIKE ? ESCAPE '\\')`
        : '';
      // R158.45.30 (2026-10-05) — OU scoped view 列出该 OU 整个子树 (跟 ADUC
      // SUBTREE scope 一致). 之前 `ou_dn = ?` 只挑直接挂载, NB 节点显示 2 行
      // 但 rollUp 197 行. 子树匹配必须支持 baseDN 出现在对象 DN **任意位置
      // + 边界 `,`** (例 `OU=办公室,OU=NB,...` 的 ou_dn 以 `OU=办公室,`
      // 开头, baseDN `OU=NB,...` 在中间). 模式 `,' + baseDN + ',`
      // LIKE `%,<baseDN>,%` 用两侧逗号做边界, 防兄弟 OU (`OU=NBxxx`)
      // 误撞. ESCAPE 转义 baseDN 里可能的 `%` `_` `\` 通配符.
      const ouDnSubstr = ouDn ? `%,${ouDn.replace(/[\\%_]/g, ch => '\\' + ch)},%` : null;
      const listSql = isMssql
        ? `SELECT * FROM ad_groups_snapshot
            WHERE domain_name = ?
              AND (name LIKE ? OR sam_account_name LIKE ?)${whereOu}
            ORDER BY name
            OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`
        : `SELECT * FROM ad_groups_snapshot
            WHERE domain_name = ?
              AND (name LIKE ? OR sam_account_name LIKE ?)${whereOu}
            ORDER BY name
            LIMIT ? OFFSET ?`;
      const baseParams = [domainName, filterPct, filterPct];
      const listParams = isMssql
        ? [...baseParams, ...(ouDn ? [ouDn, ouDnSubstr] : []), offset, limit]
        : [...baseParams, ...(ouDn ? [ouDn, ouDnSubstr] : []), limit, offset];
      const totalSql = `SELECT COUNT(*) AS total FROM ad_groups_snapshot WHERE domain_name = ?${whereOu}`;
      const [{ rows: list }, { rows: totalRows }, { rows: snapRows }] = await Promise.all([
        db.query(listSql, listParams),
        db.query(totalSql, ouDn ? [domainName, ouDn, ouDnSubstr] : [domainName]),
        db.query(`SELECT MAX(snapshot_at) AS snapshot_at, MAX(snapshot_run_id) AS snapshot_run_id
                    FROM ad_groups_snapshot WHERE domain_name = ?`, [domainName])
      ]);
      res.json({
        groups: list.map(r => groupRowToWire(r, domainName)),
        total: Number(totalRows[0]?.total ?? 0),
        snapshotAt: snapRows[0]?.snapshot_at || null,
        snapshotRunId: snapRows[0]?.snapshot_run_id
          ? Number(snapRows[0].snapshot_run_id) : null
      });
    } catch (e) {
      logger.error({ err: e?.message, dc }, 'ad-groups snapshot read failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // R158.60.22 (2026-10-09) — group members 直查. 之前 GroupPropertyPanel
  // 「编辑属性 → 托管者 / 添加成员 / 移除成员」3 个 popover 全是文本 input
  // sAM, 没候选下拉, 移除成员甚至**完全没显示组里现有成员**, 只能盲输
  // (operator 反馈 "特别删除成员都不呈现成员, 这是有问题的"). 走跟
  // R158.60.20 一样的 ad_user_group_memberships snapshot 表, 5min sync
  // (实际 30min R158.46.1) 5min 一次写 ugmRows, 直查 DB 返 user_sam 列表
  // 给 UI 显. 大组 (Domain Users 8000+) 暂未覆盖 (R158.60.20.2 范围), 但
  // 业务 group (CDASZ 134 / 销售部-SC 76 等) 全在 ugm 表. 跟 R158.60.20
  // user→groups endpoint 对称, 命名为 /ad-groups/:name/members.
  r.get('/api/admin/ad-groups/:name/members', authAdObjects, async (req, res) => {
    const groupName = String(req.params.name || '').trim();
    const domain = String(req.query.domain || '').trim();
    if (!groupName) return res.status(400).json({ error: 'name required' });
    if (!domain) return res.status(400).json({ error: 'domain required' });
    try {
      const db = getDb();
      // 跟 R158.60.20 (user→groups) endpoint 对称: 用 db.sql.directorySync
      // helper 走 dialect-aware path, 不 inline SQL (跨 MySQL/MSSQL 兼容性).
      const { rows } = await db.query(
        db.sql.directorySync.listMembersForGroup, [domain, groupName]
      );
      const { rows: snapRows } = await db.query(
        `SELECT MAX(snapshot_at) AS snapshot_at
           FROM ad_user_group_memberships
          WHERE domain_name = ?`, [domain]
      );
      res.json({
        group: groupName,
        domain,
        members: rows.map(r => String(r.user_sam || '')).filter(Boolean),
        total: rows.length,
        snapshotAt: snapRows[0]?.snapshot_at || null
      });
    } catch (e) {
      logger.error({ err: e?.message, groupName, domain }, 'ad-group members snapshot read failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // R158.44.7.10 (2026-10-05) — computer snapshot read. Mirror /api/admin/ad-users
  // (same dc + filter + ouDn + limit/offset shape). PK sam_account_name; LIKE on
  // sam_account_name / cn / name.
  r.get('/api/admin/ad-computers', authAdObjects, async (req, res) => {
    const dc = String(req.query.dc || '').trim();
    // R158.45.10 (2026-10-05) — 接受 `domain` (FQDN) 参数, 优先用它直接查.
    const domainDirect = String(req.query.domain || '').trim();
    if (!dc && !domainDirect) return res.status(400).json({ error: 'dc or domain required' });
    const filter = String(req.query.filter || '').trim();
    const ouDn = String(req.query.ouDn || '').trim();
    // R158.45.11 (2026-10-05) — operator "组和用户计算机信息没出来":
    //   上限 1000 → 50000. OU 树按域全量拉, 避免大域截断. (R158.45.10)
    const limit = Math.max(1, Math.min(50000, Number(req.query.limit) || 50000));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const db = getDb();
    const isMssql = db.dialect === 'mssql';
    const filterPct = `%${filter}%`;
    try {
      const domainName = domainDirect || await hostnameToDomainName(db, isMssql, dc);
      const whereOu = ouDn
        ? ` AND (ou_dn = ? OR (',' + ou_dn + ',') LIKE ? ESCAPE '\\')`
        : '';
      // R158.45.30 (2026-10-05) — OU scoped view 列出该 OU 整个子树 (跟 ADUC
      // SUBTREE scope 一致). 之前 `ou_dn = ?` 只挑直接挂载, NB 节点显示 2 行
      // 但 rollUp 197 行. 子树匹配必须支持 baseDN 出现在对象 DN **任意位置
      // + 边界 `,`** (例 `OU=办公室,OU=NB,...` 的 ou_dn 以 `OU=办公室,`
      // 开头, baseDN `OU=NB,...` 在中间). 模式 `,' + baseDN + ',`
      // LIKE `%,<baseDN>,%` 用两侧逗号做边界, 防兄弟 OU (`OU=NBxxx`)
      // 误撞. ESCAPE 转义 baseDN 里可能的 `%` `_` `\` 通配符.
      const ouDnSubstr = ouDn ? `%,${ouDn.replace(/[\\%_]/g, ch => '\\' + ch)},%` : null;
      const listSql = isMssql
        ? `SELECT * FROM ad_computers_snapshot
            WHERE domain_name = ?
              AND (sam_account_name LIKE ? OR cn LIKE ? OR name LIKE ?)${whereOu}
            ORDER BY sam_account_name
            OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`
        : `SELECT * FROM ad_computers_snapshot
            WHERE domain_name = ?
              AND (sam_account_name LIKE ? OR cn LIKE ? OR name LIKE ?)${whereOu}
            ORDER BY sam_account_name
            LIMIT ? OFFSET ?`;
      const baseParams = [domainName, filterPct, filterPct, filterPct];
      const listParams = isMssql
        ? [...baseParams, ...(ouDn ? [ouDn, ouDnSubstr] : []), offset, limit]
        : [...baseParams, ...(ouDn ? [ouDn, ouDnSubstr] : []), limit, offset];
      const totalSql = `SELECT COUNT(*) AS total FROM ad_computers_snapshot WHERE domain_name = ?${whereOu}`;
      const [{ rows: list }, { rows: totalRows }, { rows: snapRows }] = await Promise.all([
        db.query(listSql, listParams),
        db.query(totalSql, ouDn ? [domainName, ouDn, ouDnSubstr] : [domainName]),
        db.query(`SELECT MAX(snapshot_at) AS snapshot_at, MAX(snapshot_run_id) AS snapshot_run_id
                    FROM ad_computers_snapshot WHERE domain_name = ?`, [domainName])
      ]);
      res.json({
        computers: list.map(r => computerRowToWire(r, domainName)),
        total: Number(totalRows[0]?.total ?? 0),
        snapshotAt: snapRows[0]?.snapshot_at || null,
        snapshotRunId: snapRows[0]?.snapshot_run_id
          ? Number(snapRows[0].snapshot_run_id) : null
      });
    } catch (e) {
      logger.error({ err: e?.message, dc }, 'ad-computers snapshot read failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  // Snapshot: OUs. No pagination (typically O(100s)). Frontend rebuilds
  // the tree from parent_dn. Sort by DN for stable iteration.
  // R158.44.7.7 (2026-10-05) — filter on `domain_name` (FQDN), not the DC.
  r.get('/api/admin/ad-ous', authAdObjects, async (req, res) => {
    const dc = String(req.query.dc || '').trim();
    // R158.45.10 (2026-10-05) — operator "选了森林和域就显示域树, 跟后面的参数无关":
    //   接受 `domain` 参数 (FQDN), 优先用它直接查 ad_ous_snapshot; 没传才用 dc
    //   走 hostnameToDomainName. 域树跟站点/DC 选择无关.
    const domainDirect = String(req.query.domain || '').trim();
    if (!dc && !domainDirect) return res.status(400).json({ error: 'dc or domain required' });
    const db = getDb();
    const isMssql = db.dialect === 'mssql';
    try {
      const domainName = domainDirect || await hostnameToDomainName(db, isMssql, dc);
      const [{ rows: list }, { rows: snapRows }] = await Promise.all([
        db.query(`SELECT * FROM ad_ous_snapshot WHERE domain_name = ? ORDER BY distinguished_name`, [domainName]),
        db.query(`SELECT MAX(snapshot_at) AS snapshot_at, MAX(snapshot_run_id) AS snapshot_run_id
                    FROM ad_ous_snapshot WHERE domain_name = ?`, [domainName])
      ]);
      res.json({
        ous: list.map(r => ouRowToWire(r, domainName)),
        snapshotAt: snapRows[0]?.snapshot_at || null,
        snapshotRunId: snapRows[0]?.snapshot_run_id
          ? Number(snapRows[0].snapshot_run_id) : null
      });
    } catch (e) {
      logger.error({ err: e?.message, dc, domain: domainDirect }, 'ad-ous snapshot read failed');
      res.status(500).json({ error: '内部错误' });
    }
  });

  return r;
}

// ── R75 audit-payload helpers (route-local) ──────────────────────────────
// commandType → audit action (matches spec §3.2). The 17 user-facing
// commandTypes each map to one audit action (the same one we'd write for
// an operator doing that operation directly without the queue).

// DC-online check extracted from the single endpoint (R76 — shared by
// the batch endpoint). Returns `null` when the target is reachable (or
// `force=true` was passed), or `{ status, body }` describing the 503
// response the caller should send back unchanged.
async function _checkDcOnline(targetDc, force) {
  if (force) return null;
  try {
    const db = getDb();
    const { rows } = await db.query(db.sql.heartbeat.dcOnlineCheck, [targetDc.trim()]);
    if (rows && rows.length > 0) return null;
    const recent = await db.query(db.sql.heartbeat.readLastHeartbeatAt, [targetDc.trim()]);
    const lastHeartbeatAt = recent.rows?.[0]?.last_heartbeat_at ?? null;
    return {
      status: 503,
      body: {
        error: `no agent currently online for ${targetDc}; last heartbeat ${lastHeartbeatAt || 'never'}`,
        lastHeartbeatAt
      }
    };
  } catch (e) {
    logger.warn({ err: e.message, targetDc }, 'ad-commands DC-online check failed');
    return { status: 503, body: { error: 'DC-online check failed; retry or pass ?force=true' } };
  }
}

// Audit row derived from commandType (R76 extracted helper). Both the
// single endpoint and the batch endpoint emit the same shape per queued
// command — operator-visible actions only, passwords REDACTED in the
// payload per spec §3.4 ruling #8.
async function _auditAdCommand(req, row, commandType, params, logger) {
  const auditAction = commandTypeToAuditAction(commandType);
  const auditPayload = {
    commandId: row.id,
    // R158.46b — task_id 是 queue 时刻生成的 "<DC>-<UTC YYYYMMDDHHMMSSmmm>",
    // operator 在 /admin/ad-management-log 顶部 lifecycle panel 直接看.
    // ad_command_* lifecycle row 都同步写 (agent.js 4 处 audit).
    taskId: row.task_id ?? null,
    targetDc: row.target_dc,
    commandType,
    paramsSummary: redactPasswordsForAudit(params)
  };
  await writeAudit({
    userId: req.user?.sub ?? null,
    action: auditAction,
    target: typeof params?.sam === 'string' ? params.sam
      : typeof params?.name === 'string' ? params.name
      : `dc:${row.target_dc}`,
    payload: auditPayload,
    logger
  });
}

function commandTypeToAuditAction(commandType) {
  const map = {
    user_search: 'ad_user_search',
    user_create: 'ad_user_create',
    user_password_reset: 'ad_user_password_reset',
    user_enable: 'ad_user_enable',
    user_disable: 'ad_user_disable',
    user_unlock: 'ad_user_unlock',
    user_set_attributes: 'ad_user_set_attributes',
    user_set_manager: 'ad_user_set_manager',                // R158.36 (2026-10-03)
    user_delete: 'ad_user_delete',
    user_list_groups: 'ad_user_list_groups',
    group_search: 'ad_group_search',
    group_create: 'ad_group_create',
    group_set_attributes: 'ad_group_set_attributes',
    group_add_member: 'ad_group_add_member',
    group_remove_member: 'ad_group_remove_member',
    group_set_members: 'ad_group_set_members',
    group_delete: 'ad_group_delete',
    group_list_members: 'ad_group_list_members',
    // R158.34 — ad_account_quickfix maps to a single audit action covering
    // the combined 4-step reset (unlock + password reset + enable + attr sync).
    ad_account_quickfix: 'ad_account_quickfix',
    // R158.40 (2026-10-03) — ADUC 写动作补齐. 创建 OU / 移动任意对象.
    // dispatcher `ou_` / `object_` prefix → agent PS1 在 DC 上执行.
    // R158.56c-d (2026-10-09) — object_delete 整体下线 (operator directive
    //   "ad_ad_object_delete 这个包不在需要"). 不再映射 audit action.
    ou_create: 'ad_ou_create',
    object_move: 'ad_object_move'
  };
  return map[commandType] || 'ad_user_search';
}

// Redact password-shaped keys for audit payload + GET response. Mirrors
// the service's redactPasswords() (kept as a route-local copy so the route
// never has to import a test-internal helper).
function redactPasswordsForAudit(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(redactPasswordsForAudit);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'password' || k === 'newPassword' || k === 'oldPassword') {
        out[k] = { hasPassword: true, passwordLength: typeof v === 'string' ? v.length : 0 };
        continue;
      }
      out[k] = redactPasswordsForAudit(v);
    }
    return out;
  }
  return value;
}

// Built-in package name constant. Mirrors member-servers.js — disabling it
// on a per-host or per-group basis is allowed but audited so operators can
// see who pulled the safety net.
const BUILTIN_AD_OS_BASELINE = 'ad-os-baseline';

function formatTsForFilename(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function toCsv(rows) {
  const headers = ['时间 (UTC+8)', '用户名', '动作', '目标', '严重性', '类别', 'payload(json)'];
  const esc = v => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([
      esc(new Date(r.createdAt).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })),
      esc(r.username),
      esc(r.actionLabel),
      esc(r.target),
      esc(r.severity),
      esc(r.category),
      esc(r.payload)
    ].join(','));
  }
  return lines.join('\n');
}