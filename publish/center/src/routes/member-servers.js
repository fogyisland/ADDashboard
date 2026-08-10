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

export function memberRouter({ config, logger }) {
  const r = Router();
  const auth = [userAuth({ secret: config.jwtSecret }), requirePerm('admin:users')];
  const agentMw = agentToken(config.agentToken);

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

  // ----- AGENT SELF-REGISTER -----
  // Gated by agentToken (NOT userAuth). Idempotent: upsert with
  // discovered_via='self-register'. enabled defaults to 1 so the new host
  // is immediately eligible for package binds.
  r.post('/api/admin/member-servers/self-register', agentMw, async (req, res) => {
    const { hostname, agentVersion, osVersion, ipAddress } = req.body || {};
    if (!hostname) return res.status(400).json({ error: 'hostname required' });
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
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e, hostname }, 'member-servers self-register failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}
