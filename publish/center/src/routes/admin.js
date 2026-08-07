import { Router } from 'express';
import { userAuth } from '../auth/user-auth.js';
import { requirePerm } from '../auth/rbac.js';
import { findByUsername, listUsers, createUser, updateUser, deleteUser } from '../services/users.js';
import { getConfig, setConfig, getConfigMap } from '../services/config.js';
import { writeAudit } from '../services/audit.js';
import { listPorts, createPort, updatePort, deletePort } from '../services/ports.js';
import { getDb } from '../db/index.js';

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
  ['changed_by_username', 'changedByUsername']
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

export function adminRouter({ config, logger }) {
  const r = Router();
  const auth = [userAuth({ secret: config.jwtSecret }), requirePerm('admin:users')];

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

  r.get('/api/admin/config', auth, async (_req, res) => {
    try {
      const cfg = await getConfig();
      res.json(cfg);
    } catch (e) {
      logger.error({ err: e }, 'admin config get failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.put('/api/admin/config', auth, async (req, res) => {
    try {
      const updates = req.body || {};
      const db = getDb();
      const auditRows = [];
      await db.transaction(async (tx) => {
        const before = await getConfigMap();
        for (const [k, v] of Object.entries(updates)) {
          await tx.execute('UPDATE system_config SET config_value = ?, updated_at = CURRENT_TIMESTAMP WHERE config_key = ?', [v == null ? null : String(v), k]);
          const oldVal = before[k] ?? null;
          const newVal = v == null ? null : String(v);
          if (String(oldVal) !== String(newVal)) {
            await tx.execute(db.sql.config.audit.write, [k, oldVal, newVal, req.user?.sub ?? null, 'UPDATE']);
            auditRows.push({ key: k, old: oldVal, new: newVal });
          }
        }
      });
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'update_config',
        target: 'system_config',
        payload: { ...updates, _audit: auditRows },
        logger
      });
      res.json({ ok: true, auditCount: auditRows.length });
    } catch (e) {
      logger.error({ err: e }, 'admin config update failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.get('/api/admin/config/audit', auth, async (_req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.config.audit.list);
      res.json(rows.map(camelRow));
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
        await tx.execute('UPDATE system_config SET config_value = ?, updated_at = CURRENT_TIMESTAMP WHERE config_key = ?', [audit.old_value, audit.config_key]);
        await tx.execute(db.sql.config.audit.write, [audit.config_key, audit.new_value, audit.old_value, req.user?.sub ?? null, 'ROLLBACK']);
        result = { configKey: audit.config_key, newValue: audit.old_value };
      });
      if (!result) return res.status(500).json({ error: 'internal' });
      if (result.notFound) return res.status(404).json({ error: 'audit not found' });
      res.json({ ok: true, ...result });
    } catch (e) {
      logger.error({ err: e }, 'admin config rollback failed');
      res.status(500).json({ error: 'internal' });
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
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] || {};
        const siteName = (r.siteName || '').trim();
        if (!siteName) {
          errors.push({ rowIndex: i, siteName: '', reason: 'siteName is required' });
          skipped++;
          continue;
        }
        const isHubVal = r.isHub === true || r.isHub === 1 || r.isHub === '1' || r.isHub === 'true' || r.isHub === 'yes' ? 1 : 0;
        await db.execute(db.sql.sites.upsert, [
          siteName,
          r.regionCode ?? null,
          isHubVal,
          r.description ?? null
        ]);
        imported++;
      }
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'bulk_import_sites',
        target: 'ad_sites',
        payload: { imported, skipped, total: rows.length },
        logger
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
          await db.execute(db.sql.dcs.assignSiteUnbind, [dcName]);
          unassigned++;
          continue;
        }
        const { rows: siteRows } = await db.query(db.sql.sites.findByName, [siteName]);
        if (siteRows.length === 0) {
          errors.push({ rowIndex: i, dcName, reason: `site "${siteName}" not found` });
          skipped++;
          continue;
        }
        const siteId = siteRows[0].site_id;
        const { affectedRows } = await db.execute(db.sql.dcs.assignSite, [siteId, dcName]);
        if (affectedRows === 0) {
          errors.push({ rowIndex: i, dcName, reason: `dc "${dcName}" not discovered (agent has not reported it yet)` });
          skipped++;
          continue;
        }
        assigned++;
      }
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'bulk_assign_dc_sites',
        target: 'ad_dcs',
        payload: { assigned, unassigned, skipped, total: rows.length },
        logger
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

  return r;
}

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