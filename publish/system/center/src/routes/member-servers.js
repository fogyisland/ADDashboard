// Member-server CRUD + per-host package bind + agent self-register.
//
// Mounts on webApp under /api/admin/member-servers/* (Task 6 of the
// non-AD server management plan, spec §4.3). Lives in a dedicated
// memberRouter per the design's no-cross-pollination rule with the DC
// agent routes.
//
// Routes:
//   GET    /api/admin/member-servers                       (list)
//   GET    /api/admin/member-servers/:hostname             (detail, 404 on miss)
//   POST   /api/admin/member-servers                       (manual entry)
//   PUT    /api/admin/member-servers/:hostname             (partial update)
//   DELETE /api/admin/member-servers/:hostname             (drop; FK cascade clears packages/group_members/alert_rules)
//   GET    /api/admin/member-servers/:hostname/packages    (list per-host packages)
//   PUT    /api/admin/member-servers/:hostname/packages/:package_name  (toggle enabled)
//   DELETE /api/admin/member-servers/:hostname/packages/:package_name
//           - for ad-os-baseline: audit disable_builtin_ad_os_baseline BEFORE the DELETE
//           - other packages: DELETE only
//   POST   /api/admin/member-servers/self-register          (agent_token; upsert discovered_via='self-register')
//   GET    /api/admin/member-servers/:hostname/alerts        (alert_events.listByHostname, capped 200)
//   GET    /api/admin/member-servers/:hostname/baseline      (alert-metrics.getLatest — single row or null)
//   GET    /api/admin/alert-rules                            (list, optional ?hostname=)
//   POST   /api/admin/alert-rules                            (create — name + condition JSON + for_minutes + cooldown_minutes + recipients)
//   DELETE /api/admin/alert-rules/:rule_id                   (drop)
//
// Auth: admin routes use [userAuth, requirePerm('admin:users')] (matches
// all other admin routers). self-register uses [agentToken] — agents
// don't carry user JWTs.
//
// SQL access follows the project's canonical dialect-aware pattern: read
// db.sql.memberServers.<query> / db.sql.serverGroups.<query> — never
// hardcode `sql.mysql.foo` here.

import { Router } from 'express';
import { userAuth } from '../auth/user-auth.js';
import { requirePerm } from '../auth/rbac.js';
import { agentToken } from '../auth/agent-token.js';
import { getDb } from '../db/index.js';
import { writeAudit } from '../services/audit.js';

// Built-in package name. Disabling it on a per-host basis is allowed but
// audited so operators can see who pulled the safety net. Lives here (and
// only here) — Task 7+ refer to it via this constant.
const BUILTIN_AD_OS_BASELINE = 'ad-os-baseline';

// Standard DNS hostname check (RFC 952 / 1123, with Windows NetBIOS leeway).
// Labels are 1-63 chars of [a-zA-Z0-9-], not starting or ending in hyphen,
// separated by dots. Total length <= 253. Rejects reserved names that an
// attacker could try to claim to gain visibility or confuse operators
// ('localhost', 'localhost.localdomain'). C5 fix — see self-register route.
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*$/;
const RESERVED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain']);
function isValidHostname(s) {
  if (typeof s !== 'string') return false;
  if (s.length === 0 || s.length > 253) return false;
  if (RESERVED_HOSTNAMES.has(s.toLowerCase())) return false;
  return HOSTNAME_RE.test(s);
}

export function memberRouter({ config, logger, db }) {
  const r = Router();
  // db is required (Task 5: userAuth reads token_version/status per request).
  // Lazy fallback to getDb() keeps test wirings that pre-date the new
  // signature working — every test that calls memberRouter already calls
  // _setDbForTest first.
  const _db = db ?? getDb();
  const auth = [userAuth({ secret: config.jwtSecret, db: _db }), requirePerm('admin:users')];
  // I3: agentToken now resolves the bundle at request time via the db
  // facade (so a rotate+commit takes effect on the very next request).
  // Passing the old `config.agentToken` string would silently 503 every
  // request — Task 1 introduced this signature and Task 5 propagates it
  // to every caller. Use the same _db the userAuth middleware uses so a
  // test that pre-sets the db via memberRouter({ db }) keeps working.
  // `logger` is threaded in so a previous-token match emits the spec §5 warn.
  const agentMw = agentToken({ db: _db, logger });

  // ----- LIST -----
  r.get('/api/admin/member-servers', ...auth, async (_req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.memberServers.list);
      res.json({ items: rows });
    } catch (e) {
      logger.error({ err: e }, 'member-servers list failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----- DETAIL -----
  r.get('/api/admin/member-servers/:hostname', ...auth, async (req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.memberServers.findByHostname, [req.params.hostname]);
      if (rows.length === 0) return res.status(404).json({ error: 'not found' });
      res.json(rows[0]);
    } catch (e) {
      logger.error({ err: e }, 'member-servers detail failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----- MANUAL CREATE -----
  r.post('/api/admin/member-servers', ...auth, async (req, res) => {
    const { hostname, siteId = null, ipAddress = null, osVersion = null, enabled = 1 } = req.body || {};
    if (!hostname) return res.status(400).json({ error: 'hostname required' });
    if (!isValidHostname(hostname)) {
      return res.status(400).json({ error: 'hostname must match RFC 952/1123 (letters, digits, hyphens, dots; 1-253 chars; no reserved names)' });
    }
    try {
      const db = getDb();
      // discovered_via='admin' marks manual entries so the self-register
      // path won't overwrite site/os bindings on the next heartbeat.
      await db.execute(db.sql.memberServers.upsert, [
        hostname, siteId, ipAddress, osVersion, 'non-ad', enabled ? 1 : 0, 'admin'
      ]);
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'create_member_server',
        target: hostname,
        payload: { hostname, siteId, ipAddress, osVersion, enabled: enabled ? 1 : 0, discoveredVia: 'admin' },
        logger
      });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'member-servers create failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----- PARTIAL UPDATE (site_id / ip_address / os_version / enabled) -----
  // Idiom follows admin.js sites-catalog updatePartial: build a dynamic SET
  // clause from whichever body fields were supplied; reject empty updates;
  // 404 if affectedRows === 0.
  r.put('/api/admin/member-servers/:hostname', ...auth, async (req, res) => {
    const { siteId, ipAddress, osVersion, enabled } = req.body || {};
    const fields = [];
    const params = [];
    if (siteId !== undefined)     { fields.push('site_id = ?');     params.push(siteId); }
    if (ipAddress !== undefined)  { fields.push('ip_address = ?');  params.push(ipAddress); }
    if (osVersion !== undefined)  { fields.push('os_version = ?');  params.push(osVersion); }
    if (enabled !== undefined)    { fields.push('enabled = ?');     params.push(enabled ? 1 : 0); }
    if (fields.length === 0) return res.status(400).json({ error: 'no fields to update' });
    params.push(req.params.hostname);
    try {
      const db = getDb();
      // MSSQL updatePartial uses @pN placeholders (the db.execute wrapper
      // remaps ? -> @pN when the active dialect is mssql). Both dialects
      // share the same field-list contract.
      const { affectedRows } = await db.execute(
        `UPDATE ad_member_servers SET ${fields.join(', ')} WHERE hostname = ?`,
        params
      );
      if (affectedRows === 0) return res.status(404).json({ error: 'member server not found' });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'member-servers update failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----- DELETE (FK cascade clears packages / group_members / alert_rules) -----
  r.delete('/api/admin/member-servers/:hostname', ...auth, async (req, res) => {
    try {
      const db = getDb();
      const { affectedRows } = await db.execute(db.sql.memberServers.delete, [req.params.hostname]);
      if (affectedRows === 0) return res.status(404).json({ error: 'member server not found' });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'member-servers delete failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----- PER-HOST PACKAGE LIST -----
  r.get('/api/admin/member-servers/:hostname/packages', ...auth, async (req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.serverGroups.listPackagesForHost, [req.params.hostname]);
      res.json({ items: rows });
    } catch (e) {
      logger.error({ err: e }, 'member-server packages list failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----- PER-HOST PACKAGE TOGGLE -----
  r.put('/api/admin/member-servers/:hostname/packages/:package_name', ...auth, async (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
    try {
      const db = getDb();
      // Upsert (insert if missing, otherwise update enabled) — same shape
      // as db.sql.serverGroups.upsertPackage so the call site stays clean.
      await db.execute(db.sql.serverGroups.upsertPackage, [
        req.params.hostname, req.params.package_name, enabled ? 1 : 0
      ]);
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'member-server package toggle failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----- PER-HOST PACKAGE DELETE -----
  // Audit BEFORE the DELETE so an audit reader can always correlate a
  // disable_builtin_ad_os_baseline with the row that disappeared. If the
  // DELETE itself fails, the audit row still surfaces the operator's
  // intent (which is the more important fact for forensics).
  r.delete('/api/admin/member-servers/:hostname/packages/:package_name', ...auth, async (req, res) => {
    try {
      const db = getDb();
      if (req.params.package_name === BUILTIN_AD_OS_BASELINE) {
        await writeAudit({
          userId: req.user?.sub ?? null,
          action: 'disable_builtin_ad_os_baseline',
          target: req.params.hostname,
          payload: { package: BUILTIN_AD_OS_BASELINE },
          logger
        });
      }
      await db.execute(db.sql.serverGroups.removePackage, [
        req.params.hostname, req.params.package_name
      ]);
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'member-server package delete failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----- PER-HOST ALERT EVENTS (cap 200 for the UI history panel) -----
  // Reuses db.sql.alertEvents.listByHostname which already orders by
  // created_at DESC. The frontend detail view paginates client-side by
  // slicing the items array, so LIMIT 200 is fine for v1.
  r.get('/api/admin/member-servers/:hostname/alerts', ...auth, async (req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.alertEvents.listByHostname, [req.params.hostname]);
      res.json({ items: rows.slice(0, 200) });
    } catch (e) {
      logger.error({ err: e }, 'member-server alerts list failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----- PER-HOST BASELINE METRICS (single latest row or null) -----
  // Reuses db.sql.alertMetrics.getLatest. The frontend renders this as a
  // tile grid (CPU / memory / disk free) for the baseline tab.
  r.get('/api/admin/member-servers/:hostname/baseline', ...auth, async (req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.alertMetrics.getLatest, [req.params.hostname]);
      res.json({ latest: rows[0] || null });
    } catch (e) {
      logger.error({ err: e }, 'member-server baseline lookup failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----- ALERT RULES (list / create / delete) -----
  // Optional ?hostname= filter; the RuleEditorDialog only ever passes a
  // hostname, but the endpoint accepts no-filter too for future "all rules"
  // admin pages. Reuses db.sql.alertRules.list / listForHost from the
  // registry — no inline SQL.
  r.get('/api/admin/alert-rules', ...auth, async (req, res) => {
    try {
      const db = getDb();
      const sql = req.query.hostname
        ? db.sql.alertRules.listForHost
        : db.sql.alertRules.list;
      const params = req.query.hostname ? [req.query.hostname] : [];
      const { rows } = await db.query(sql, params);
      res.json({ items: rows });
    } catch (e) {
      logger.error({ err: e }, 'alert-rules list failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // Create a rule. RuleEditorDialog sends { hostname, name, condition,
  // for_minutes, cooldown_minutes, recipients }. `condition` is a JSON
  // {op, children} tree stringified at the boundary. The backend stores
  // it verbatim into the `condition` TEXT/NVARCHAR(MAX) column. for_minutes
  // and cooldown_minutes default to 5/30 if missing.
  r.post('/api/admin/alert-rules', ...auth, async (req, res) => {
    const { hostname, name, condition, for_minutes = 5, cooldown_minutes = 30, recipients = null, enabled = 1 } = req.body || {};
    if (!hostname || !name) return res.status(400).json({ error: 'hostname + name required' });
    if (condition == null) return res.status(400).json({ error: 'condition required' });
    try {
      const db = getDb();
      const conditionStr = typeof condition === 'string' ? condition : JSON.stringify(condition);
      await db.execute(db.sql.alertRules.create, [
        hostname, name, conditionStr, for_minutes, cooldown_minutes, recipients, enabled ? 1 : 0
      ]);
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'create_alert_rule',
        target: hostname,
        payload: { hostname, name, for_minutes, cooldown_minutes, enabled: enabled ? 1 : 0 },
        logger
      });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'alert-rule create failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.delete('/api/admin/alert-rules/:rule_id', ...auth, async (req, res) => {
    const ruleId = Number(req.params.rule_id);
    if (!Number.isFinite(ruleId)) return res.status(400).json({ error: 'rule_id must be numeric' });
    try {
      const db = getDb();
      const { affectedRows } = await db.execute(db.sql.alertRules.delete, [ruleId]);
      if (affectedRows === 0) return res.status(404).json({ error: 'rule not found' });
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'delete_alert_rule',
        target: String(ruleId),
        logger
      });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'alert-rule delete failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----- AGENT SELF-REGISTER -----
  // Gated by agentToken (NOT userAuth). Idempotent: upsert with
  // discovered_via='self-register'. enabled defaults to 1 so the new host
  // is immediately eligible for package binds.
  //
  // C5 fix: agent_token is a shared secret — anyone with the token can
  // currently claim ANY hostname in the body, then receive packages meant
  // for that host. Defense in depth: validate hostname against the standard
  // DNS naming rules (RFC 952 / 1123) before persisting. Hostname-shape
  // validation alone doesn't fully solve the shared-secret problem (a
  // rotated-token-still-shared scenario still allows impersonation of any
  // well-formed hostname), but it stops the cheap attacks — header injection,
  // claim of reserved names like 'admin'/'localhost'/'127.0.0.1', oversized
  // values, control characters — that an opportunistic attacker would try
  // first. Proper per-host tokens / mTLS / IP allowlist are a separate
  // design track; this is the floor.
  r.post('/api/admin/member-servers/self-register', agentMw, async (req, res) => {
    const { hostname, agentVersion, osVersion, ipAddress } = req.body || {};
    if (!hostname) return res.status(400).json({ error: 'hostname required' });
    if (!isValidHostname(hostname)) {
      return res.status(400).json({
        error: 'hostname must match RFC 952/1123 (letters, digits, hyphens, dots; 1-253 chars; no reserved names)'
      });
    }
    try {
      const db = getDb();
      // Param order: hostname, site_id(null), ip_address, os_version, agent_type('non-ad'),
      //              enabled(1), discovered_via('self-register').
      // agentVersion is accepted for future use (e.g. cap min-version
      // alert rules) but not persisted at registration time — the
      // heartbeat path is the source of truth for agentVersion.
      await db.execute(db.sql.memberServers.upsert, [
        hostname, null, ipAddress ?? null, osVersion ?? null, 'non-ad', 1, 'self-register'
      ]);
      await writeAudit({
        userId: null,
        action: 'agent_self_register',
        target: hostname,
        payload: { hostname, ipAddress: ipAddress ?? null, osVersion: osVersion ?? null },
        logger
      });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e, hostname }, 'member-servers self-register failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}
