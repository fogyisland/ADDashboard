import { Router } from 'express';
import { userAuth } from '../auth/user-auth.js';
import { requirePerm } from '../auth/rbac.js';
import { findByUsername, listUsers, createUser, updateUser, deleteUser, bumpTokenVersion } from '../services/users.js';
import { getConfig, setConfig, getConfigMap, restartRequired, putConfig, putConfigWithin } from '../services/config.js';
import { writeAudit } from '../services/audit.js';
import { listPorts, createPort, updatePort, deletePort } from '../services/ports.js';
import { getDb } from '../db/index.js';
import { sha256Hex } from '../config.js';
import * as email from '../services/email.js';
import { rotateAgentToken, commitAgentToken, getAgentTokenState } from '../services/agent-token.js';
import { invalidateAgentTokenCache } from '../auth/agent-token.js';
import { rotateJwtSecret, commitJwtSecret, getJwtSecretState } from '../services/jwt-secret.js';
import { invalidateJwtSecretCache } from '../auth/user-auth.js';

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

export function adminRouter({ config, logger, db }) {
  const r = Router();
  // db is required (Task 5: userAuth reads token_version/status per request).
  // We resolve `db` lazily via getDb() when the caller didn't pass one — every
  // tests + production wire has getDb() available.
  const _db = db ?? getDb();
  const auth = [userAuth({ db: _db, logger }), requirePerm('admin:users')];

  r.get('/api/admin/roles', auth, async (_req, res) => {
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
      res.status(500).json({ error: 'internal' });
    }
  });

  r.get('/api/admin/users', auth, async (_req, res) => {
    try {
      const rs = await listUsers();
      res.json(rs.map(camelRow));
    } catch (e) {
      logger.error({ err: e }, 'admin users list failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.post('/api/admin/users', auth, async (req, res) => {
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
      res.status(500).json({ error: 'internal' });
    }
  });

  r.put('/api/admin/users/:id', auth, async (req, res) => {
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
      res.status(500).json({ error: 'internal' });
    }
  });

  r.delete('/api/admin/users/:id', auth, async (req, res) => {
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
      res.status(500).json({ error: 'internal' });
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
  r.post('/api/admin/users/:id/revoke-tokens', auth, async (req, res) => {
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
      res.status(500).json({ error: 'internal' });
    }
  });

  r.get('/api/admin/config', auth, async (_req, res) => {
    try {
      const cfg = await getConfig();
      // Surface a `restartRequired` block so the ConfigView can render the
      // "重启生效" badge without a second round-trip. Computed from the two
      // version hashes written by the PUT handler (pending) and the bootstrap
      // IIFE in server.js (started) — see restartRequired() in
      // services/config.js for the exact contract.
      const rr = await restartRequired();
      res.json({ ...cfg, restartRequired: rr });
    } catch (e) {
      logger.error({ err: e }, 'admin config get failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.put('/api/admin/config', auth, async (req, res) => {
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
      logger.error({ err: e }, 'admin config update failed');
      res.status(500).json({ error: 'internal' });
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
  r.post('/api/admin/restart', auth, async (req, res) => {
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
        res.status(500).json({ error: 'internal' });
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
  r.post('/api/admin/agent-token/rotate', auth, async (req, res) => {
    try {
      const out = await rotateAgentToken(_db, {
        logger,
        userId: req.user?.sub ?? null
      });
      invalidateAgentTokenCache();
      res.json({ newToken: out.newToken, rotatedAt: out.rotatedAt });
    } catch (e) {
      logger.error({ err: e }, 'agent token rotate failed');
      res.status(500).json({ error: 'rotate failed' });
    }
  });

  r.post('/api/admin/agent-token/commit', auth, async (req, res) => {
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

  r.get('/api/admin/agent-token', auth, async (_req, res) => {
    try {
      const s = await getAgentTokenState(_db);
      res.json({
        mode: s.previous ? 'dual' : 'single',
        rotatedAt: s.rotatedAt || null,
        previousExpiresAt: s.previousExpiresAt || null,
        ttlDays: s.ttlDays
      });
    } catch (e) {
      logger.error({ err: e }, 'agent token state get failed');
      res.status(500).json({ error: 'state get failed' });
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
  r.post('/api/admin/jwt-secret/rotate', auth, async (req, res) => {
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

  r.post('/api/admin/jwt-secret/commit', auth, async (req, res) => {
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

  r.get('/api/admin/jwt-secret', auth, async (_req, res) => {
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

  r.get('/api/admin/config/audit', auth, async (_req, res) => {
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
      res.status(500).json({ error: 'internal' });
    }
  });

  r.post('/api/admin/config/rollback', auth, async (req, res) => {
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
        await tx.execute('UPDATE system_config SET config_value = ?, updated_at = CURRENT_TIMESTAMP WHERE config_key = ?', [audit.old_value, audit.config_key]);
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
      if (!result) return res.status(500).json({ error: 'internal' });
      if (result.notFound) return res.status(404).json({ error: 'audit not found' });
      if (result.error) return res.status(400).json({ error: result.error });
      res.json({ ok: true, ...result });
    } catch (e) {
      logger.error({ err: e }, 'admin config rollback failed');
      res.status(500).json({ error: 'internal' });
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
  r.post('/api/admin/config/email/test', auth, async (req, res) => {
    try {
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

  r.get('/api/admin/audit', auth, async (req, res) => {
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
      res.status(500).json({ error: 'internal' });
    }
  });

  r.get('/api/admin/audit/badge', auth, async (req, res) => {
    try {
      const { getAuditBadge } = await import('../services/audit.js');
      const count = await getAuditBadge(req.query.category);
      res.json({ category: req.query.category, count });
    } catch (e) {
      if (e.httpStatus === 400) return res.status(400).json({ error: e.message });
      logger.error({ err: e }, 'admin audit badge failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  const EXPORT_CAP = 50000;

  r.get('/api/admin/audit/export', auth, async (req, res) => {
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
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----- Sites Catalog -----
  r.get('/api/admin/sites-catalog', auth, async (_req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.sites.listCatalog);
      res.json(rows.map(camelRow));
    } catch (e) {
      logger.error({ err: e }, 'sites-catalog list failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.post('/api/admin/sites-catalog', auth, async (req, res) => {
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
      res.status(500).json({ error: 'internal' });
    }
  });

  r.put('/api/admin/sites-catalog/:id', auth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
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
      res.status(500).json({ error: 'internal' });
    }
  });

  r.delete('/api/admin/sites-catalog/:id', auth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
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
      res.status(500).json({ error: 'internal' });
    }
  });

  r.post('/api/admin/sites-catalog/bulk', auth, async (req, res) => {
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
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----- DCs Catalog -----
  r.get('/api/admin/dcs-catalog', auth, async (_req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.dcs.listCatalog);
      res.json(rows.map(r => ({
        ...r,
        isPdc: !!r.isPdc, isGc: !!r.isGc, isRidMaster: !!r.isRidMaster,
        isSchemaMaster: !!r.isSchemaMaster, isDomainNamingMaster: !!r.isDomainNamingMaster,
        isInfrastructureMaster: !!r.isInfrastructureMaster
      })));
    } catch (e) {
      logger.error({ err: e }, 'dcs-catalog list failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.put('/api/admin/dcs-catalog/:dc_name/site', auth, async (req, res) => {
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
      res.status(500).json({ error: 'internal' });
    }
  });

  r.post('/api/admin/dcs-catalog/bulk-assign', auth, async (req, res) => {
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
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----- Ports -----
  r.get('/api/admin/ports', auth, async (_req, res) => {
    try {
      const rows = await listPorts();
      // Wrap in camelRow so snake_case columns from SQL (e.g. sort_order) are
      // remapped to camelCase (sortOrder) — the rest of the admin responses
      // (users, audit, sites, dcs) already do this.
      res.json(rows.map(camelRow));
    } catch (e) {
      logger.error({ err: e }, 'admin ports list failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.post('/api/admin/ports', auth, async (req, res) => {
    try {
      const out = await createPort(req.body || {});
      res.status(201).json(out);
    } catch (e) {
      if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.message });
      logger.error({ err: e }, 'admin ports create failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.put('/api/admin/ports/:id', auth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    try {
      const ok = await updatePort(id, req.body || {});
      if (!ok) return res.status(404).json({ error: 'port not found' });
      res.json({ ok: true });
    } catch (e) {
      if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.message });
      logger.error({ err: e }, 'admin ports update failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.delete('/api/admin/ports/:id', auth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    try {
      const ok = await deletePort(id);
      if (!ok) return res.status(404).json({ error: 'port not found' });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'admin ports delete failed');
      res.status(500).json({ error: 'internal' });
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
  r.get('/api/admin/server-groups', auth, async (_req, res) => {
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
      res.status(500).json({ error: 'internal' });
    }
  });

  // POST create; 409 on duplicate group_name
  r.post('/api/admin/server-groups', auth, async (req, res) => {
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
      res.status(500).json({ error: 'internal' });
    }
  });

  // PUT rename (group_name) / update description; 404 on miss
  r.put('/api/admin/server-groups/:group_id', auth, async (req, res) => {
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
      res.status(500).json({ error: 'internal' });
    }
  });

  // DELETE drop; cascades to ad_server_group_members via FK ON DELETE CASCADE;
  // host package bindings on ad_member_server_packages persist (no FK to ad_server_groups)
  r.delete('/api/admin/server-groups/:group_id', auth, async (req, res) => {
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
      res.status(500).json({ error: 'internal' });
    }
  });

  // GET members — list hostnames + site for the group
  r.get('/api/admin/server-groups/:group_id/members', auth, async (req, res) => {
    const id = Number(req.params.group_id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid group_id' });
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.serverGroups.listMembers, [id]);
      res.json(rows);
    } catch (e) {
      logger.error({ err: e }, 'admin server-groups listMembers failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // PUT members — replace (idempotent diff).
  // Read existing hostnames, compute (added, removed), DELETE removed + INSERT
  // IGNORE / NOT-EXISTS added. Same hostname set → no-op. Wrapped in a tx so
  // concurrent updates from another admin can't tear the membership.
  r.put('/api/admin/server-groups/:group_id/members', auth, async (req, res) => {
    const id = Number(req.params.group_id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid group_id' });
    const raw = req.body?.hostnames;
    if (!Array.isArray(raw)) return res.status(400).json({ error: 'hostnames array required' });
    // Dedupe + trim; reject empties so the diff doesn't carry empty strings.
    const desired = Array.from(new Set(raw.map(h => String(h).trim()).filter(Boolean)));
    try {
      const db = getDb();
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
      res.status(500).json({ error: 'internal' });
    }
  });

  // POST packages/install — bulk INSERT IGNORE / NOT EXISTS for every member
  // of the group. The SQL block resolves the membership join, so the handler
  // stays a single round-trip regardless of group size.
  r.post('/api/admin/server-groups/:group_id/packages/install', auth, async (req, res) => {
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
      res.status(500).json({ error: 'internal' });
    }
  });

  // POST packages/:name/uninstall — bulk DELETE; for built-in ad-os-baseline,
  // audit one disable_builtin_ad_os_baseline row per affected host BEFORE
  // the DELETE (matches per-host DELETE in memberRouter).
  r.post('/api/admin/server-groups/:group_id/packages/:package_name/uninstall', auth, async (req, res) => {
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
      res.status(500).json({ error: 'internal' });
    }
  });

  // POST packages/:name/enable | disable — bulk UPDATE the enabled flag.
  r.post('/api/admin/server-groups/:group_id/packages/:package_name/enable', auth, async (req, res) => {
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
      res.status(500).json({ error: 'internal' });
    }
  });

  r.post('/api/admin/server-groups/:group_id/packages/:package_name/disable', auth, async (req, res) => {
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
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
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