import { Router } from 'express';
import { userAuth } from '../auth/user-auth.js';
import { requirePerm } from '../auth/rbac.js';
import { findByUsername, listUsers, createUser, updateUser, deleteUser } from '../services/users.js';
import { getConfig, setConfig } from '../services/config.js';
import { writeAudit } from '../services/audit.js';

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
  ['last_seen', 'lastSeen']
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

export function adminRouter({ config, pool, logger }) {
  const r = Router();
  const auth = [userAuth({ secret: config.jwtSecret }), requirePerm('admin:users')];

  // GET /api/admin/roles
  r.get('/api/admin/roles', auth, async (_req, res) => {
    try {
      const [rows] = await pool.execute(`SELECT id, role_name, permissions FROM sys_roles ORDER BY id`);
      const out = rows.map(row => ({
        id: row.id,
        roleName: row.role_name,
        permissions: row.permissions ? JSON.parse(row.permissions) : []
      }));
      res.json(out);
    } catch (e) {
      logger.error({ err: e }, 'admin roles failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // GET /api/admin/users
  r.get('/api/admin/users', auth, async (_req, res) => {
    try {
      const rs = await listUsers(pool);
      res.json(rs.map(camelRow));
    } catch (e) {
      logger.error({ err: e }, 'admin users list failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // POST /api/admin/users
  r.post('/api/admin/users', auth, async (req, res) => {
    try {
      const { username, password, roleId, status } = req.body || {};
      if (!username || !password || roleId == null) {
        return res.status(400).json({ error: 'missing fields' });
      }
      const existing = await findByUsername(pool, username);
      if (existing) {
        return res.status(409).json({ error: 'username exists' });
      }
      await createUser(pool, { username, password, roleId, status });
      await writeAudit(pool, {
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

  // PUT /api/admin/users/:id
  r.put('/api/admin/users/:id', auth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { password, roleId, status } = req.body || {};
      await updateUser(pool, id, { password, roleId, status });
      await writeAudit(pool, {
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

  // DELETE /api/admin/users/:id
  r.delete('/api/admin/users/:id', auth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      await deleteUser(pool, id);
      await writeAudit(pool, {
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

  // GET /api/admin/config
  r.get('/api/admin/config', auth, async (_req, res) => {
    try {
      const cfg = await getConfig(pool);
      res.json(cfg);
    } catch (e) {
      logger.error({ err: e }, 'admin config get failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // PUT /api/admin/config
  r.put('/api/admin/config', auth, async (req, res) => {
    try {
      const updates = req.body || {};
      for (const [k, v] of Object.entries(updates)) {
        await setConfig(pool, k, v);
      }
      await writeAudit(pool, {
        userId: req.user?.sub ?? null,
        action: 'update_config',
        target: 'system_config',
        payload: updates,
        logger
      });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'admin config update failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // GET /api/admin/audit?limit=200
  r.get('/api/admin/audit', auth, async (req, res) => {
    try {
      let limit = Number(req.query.limit ?? 200);
      if (!Number.isFinite(limit) || limit <= 0) limit = 200;
      if (limit > 1000) limit = 1000;
      const [rows] = await pool.execute(
        `SELECT id, user_id, action, target, payload, created_at
           FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT ?`,
        [limit]
      );
      res.json(rows.map(camelRow));
    } catch (e) {
      logger.error({ err: e }, 'admin audit list failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // GET /api/admin/sites — distinct sites observed in ad_replication_status
  // (both source_site and dest_site columns), with link/error counts and
  // last-seen timestamp. Read-only; sites are derived from agent reports.
  r.get('/api/admin/sites', auth, async (_req, res) => {
    const SQL = `
      SELECT site AS name,
             COUNT(*)                                    AS link_count,
             SUM(CASE WHEN status_code >= 2 THEN 1 ELSE 0 END) AS error_count,
             MAX(collected_at)                           AS last_seen
      FROM (
        SELECT source_site AS site, status_code, collected_at
          FROM ad_replication_status WHERE source_site IS NOT NULL
        UNION ALL
        SELECT dest_site,    status_code, collected_at
          FROM ad_replication_status WHERE dest_site   IS NOT NULL
      ) t
      GROUP BY site
      ORDER BY site
    `;
    try {
      const [rows] = await pool.execute(SQL);
      res.json(rows.map(camelRow));
    } catch (e) {
      logger.error({ err: e }, 'admin sites list failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // GET /api/admin/dcs — distinct DCs (源/目的)  with link/error counts,
  // most-frequently-observed site assignment, and last-seen timestamp.
  r.get('/api/admin/dcs', auth, async (_req, res) => {
    const SQL = `
      SELECT dc AS name,
             site,
             COUNT(*)                                    AS link_count,
             SUM(CASE WHEN status_code >= 2 THEN 1 ELSE 0 END) AS error_count,
             MAX(collected_at)                           AS last_seen
      FROM (
        SELECT source_dc AS dc, source_site AS site, status_code, collected_at
          FROM ad_replication_status WHERE source_dc IS NOT NULL
        UNION ALL
        SELECT dest_dc,   dest_site,    status_code, collected_at
          FROM ad_replication_status WHERE dest_dc   IS NOT NULL
      ) t
      GROUP BY dc, site
      ORDER BY dc, site
    `;
    try {
      const [rows] = await pool.execute(SQL);
      res.json(rows.map(camelRow));
    } catch (e) {
      logger.error({ err: e }, 'admin dcs list failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}
