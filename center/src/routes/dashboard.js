import { Router } from 'express';
import { userAuth } from '../auth/user-auth.js';
import { requirePerm } from '../auth/rbac.js';
import { getDb } from '../db/index.js';
import { listPortStatusesForAgents } from '../services/port-status.js';
import { metricstore } from '../packages/metricstore.js';

// Helpers ---------------------------------------------------------------

function toIso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

// Snake -> camel rename for known columns. Order matters for nested keys.
const CAML_MAP = new Map([
  ['source_site', 'sourceSite'],
  ['dest_site', 'destSite'],
  ['source_dc', 'sourceDc'],
  ['dest_dc', 'destDc'],
  ['error_count', 'errorCount'],
  ['warning_count', 'warningCount'],
  ['naming_context', 'namingContext'],
  ['status_code', 'statusCode'],
  ['last_success_time', 'lastSuccessTime'],
  ['last_attempt_time', 'lastAttemptTime'],
  ['duration_minutes', 'durationMinutes'],
  ['agent_id', 'agentId'],
  ['last_heartbeat_at', 'lastHeartbeatAt'],
  ['agent_version', 'agentVersion'],
  ['last_report_at', 'lastReportAt'],
  ['last_report_status', 'lastReportStatus'],
  ['pending_queue_size', 'pendingQueueSize'],
  ['seconds_since_heartbeat', 'secondsSinceHeartbeat'],
  ['last_update', 'lastUpdate']
]);

function camelRow(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const nk = CAML_MAP.get(k) ?? k;
    out[nk] = toIso(v);
  }
  return out;
}

// Router ----------------------------------------------------------------

export function dashboardRouter({ config, logger, db }) {
  const r = Router();
  // db is required (Task 5: userAuth reads token_version/status per request).
  // Lazy fallback to getDb() keeps test wirings that pre-date the new
  // signature working — every test that calls adminRouter/dashboardRouter/
  // memberRouter already calls _setDbForTest first.
  const _db = db ?? getDb();
  const auth = [userAuth({ db: _db, logger }), requirePerm('read:dash')];

  r.get('/api/dashboard/overview', auth, async (_req, res) => {
    try {
      const db = getDb();
      const { rows: counts } = await db.query(db.sql.dashboard.overviewCounts);
      const { rows: agents } = await db.query(db.sql.dashboard.agentCount);
      const c = counts[0] || {};
      const a = agents[0] || {};
      res.json({
        totalLinks: Number(c.total)     || 0,
        healthy:    Number(c.healthy)   || 0,
        warning:    Number(c.warning)   || 0,
        error:      Number(c.errored)   || 0,
        lastUpdate: toIso(c.last_update),
        agentCount: Number(a.agent_count) || 0
      });
    } catch (e) {
      logger.error({ err: e }, 'dashboard overview failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.get('/api/dashboard/site-matrix', auth, async (_req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.dashboard.siteMatrix);
      res.json(rows.map(camelRow));
    } catch (e) {
      logger.error({ err: e }, 'dashboard site-matrix failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.get('/api/dashboard/topology', auth, async (_req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.dashboard.topology);
      const siteSet = new Set();
      const dcSet = new Map();
      const links = [];
      for (const row of rows) {
        const ss = row.source_site, ds = row.dest_site;
        const sd = row.source_dc,   dd = row.dest_dc;
        if (ss) siteSet.add(ss);
        if (ds) siteSet.add(ds);
        if (sd) dcSet.set(sd, ss ?? null);
        if (dd) dcSet.set(dd, ds ?? null);
        links.push({
          source:           sd,
          target:           dd,
          statusCode:       row.status_code,
          lastSuccessTime:  toIso(row.last_success_time)
        });
      }
      const nodes = [];
      for (const name of siteSet) nodes.push({ name, type: 'site' });
      for (const [name, site] of dcSet) {
        nodes.push(site ? { name, site, type: 'dc' } : { name, type: 'dc' });
      }
      res.json({ nodes, links });
    } catch (e) {
      logger.error({ err: e }, 'dashboard topology failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.get('/api/dashboard/errors', auth, async (_req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.dashboard.errors);
      res.json(rows.map(camelRow));
    } catch (e) {
      logger.error({ err: e }, 'dashboard errors failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.get('/api/dashboard/agents', auth, async (_req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.dashboard.agents);
      const agents = rows.map(camelRow);

      // Attach per-agent portStatuses. The SQL helper does INNER JOIN against
      // system_ports, so stale rows (port removed from the admin catalog) are
      // filtered at the DB layer; label also comes from system_ports via the
      // JOIN — no app-layer `labelByPort` map needed. When system_ports is
      // empty the INNER JOIN returns zero rows, so every agent gets an empty
      // `portStatuses` array (fallback).
      const agentIds = agents.map(a => a.agentId).filter(Boolean);
      const portRows = await listPortStatusesForAgents(agentIds);

      const portStatusByAgent = new Map();
      for (const row of portRows) {
        if (!portStatusByAgent.has(row.agentId)) portStatusByAgent.set(row.agentId, []);
        portStatusByAgent.get(row.agentId).push({
          port: row.port,
          label: row.label ?? null,
          ok: !!row.ok,
          latencyMs: row.latencyMs,
          lastCheckedAt: toIso(row.lastCheckedAt)
        });
      }
      for (const a of agents) {
        a.portStatuses = portStatusByAgent.get(a.agentId) ?? [];
      }
      res.json(agents);
    } catch (e) {
      logger.error({ err: e }, 'dashboard agents failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.get('/api/dashboard/site-replication-matrix', auth, async (req, res) => {
    const siteName = req.query.site;
    if (!siteName) return res.status(400).json({ error: 'missing site query param' });
    try {
      const db = getDb();

      // 1) Site lookup
      const { rows: siteRows } = await db.query(db.sql.dashboard.siteLookup, [siteName]);
      if (siteRows.length === 0) return res.status(404).json({ error: 'site not found' });
      const sr = siteRows[0];
      const site = {
        siteId: sr.site_id,
        siteName: sr.site_name,
        regionCode: sr.region_code,
        isHub: !!sr.is_hub,
        description: sr.description
      };
      const siteId = sr.site_id;

      // 2) DCs in site
      const { rows: dcRows } = await db.query(db.sql.dashboard.dcsBySite, [siteId]);
      const dcs = dcRows.map(d => ({
        dcName: d.dc_name,
        osVersion: d.os_version,
        isPdc: !!d.is_pdc,
        isGc: !!d.is_gc,
        isRidMaster: !!d.is_rid_master,
        isSchemaMaster: !!d.is_schema_master,
        isDomainNamingMaster: !!d.is_domain_naming_master,
        isInfrastructureMaster: !!d.is_infrastructure_master,
        discoveredAt: toIso(d.discovered_at),
        discoveredByAgentId: d.discovered_by_agent_id
      }));

      // 3) Replication links between those DCs
      let links = [];
      if (dcs.length > 0) {
        const placeholders = dcs.map(() => '?').join(',');
        const dcNames = dcs.map(d => d.dcName);
        const { rows: linkRows } = await db.query(
          db.sql.dashboard.dcReplicationLinks(placeholders),
          [...dcNames, ...dcNames]
        );
        links = linkRows.map(l => ({
          source: l.source_dc,
          target: l.dest_dc,
          namingContext: l.naming_context,
          statusCode: l.status_code,
          lastSuccessTime: toIso(l.last_success_time),
          lastAttemptTime: toIso(l.last_attempt_time),
          durationMinutes: l.duration_minutes
        }));
      }

      // 4) Refresh seconds
      const { rows: cfgRows } = await db.query(db.sql.dashboard.refreshSeconds);
      const siteRefreshSeconds = Number(cfgRows[0]?.config_value || 10);

      res.json({ site, dcs, links, siteRefreshSeconds });
    } catch (e) {
      logger.error({ err: e }, 'site-replication-matrix failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ---- Package metric dashboard (Task 9) ----
  // Summary endpoint: returns the latest gauge/counter/status rows for all
  // installed metric_*_latest tables. Filtering is done at the call site
  // (metricstore.summary) by packageName/agentId/metricId.
  r.get('/api/dashboard/metrics/summary', auth, async (req, res) => {
    try {
      const { packageName, agentId, metricId } = req.query;
      const db = getDb();
      // Resolve metricId filter: a single fully-qualified "<pkg>.<key>" or
      // all metrics for a package (or all metrics overall when neither is
      // given). The helper itself doesn't know about packageName prefix
      // matching, so we expand to an exact-list per matching installed
      // package and then call the helper per metric.
      let rows = [];
      if (metricId) {
        rows = await metricstore.summary(db, { metricId, agentId: agentId || undefined });
      } else if (packageName) {
        const { installedPackages } = await import('../db/sql/installed-packages.js');
        const pkg = await installedPackages.get(db, packageName);
        if (pkg && Array.isArray(pkg.manifest?.metrics)) {
          const all = await Promise.all(
            pkg.manifest.metrics.map((m) =>
              metricstore.summary(db, { metricId: `${packageName}.${m.key}`, agentId: agentId || undefined })
            )
          );
          rows = all.flat();
        }
      } else {
        rows = await metricstore.summary(db, { agentId: agentId || undefined });
      }
      res.json({ rows });
    } catch (e) {
      logger.error({ err: e }, 'dashboard metrics summary failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // Timeseries endpoint: requires metricId + agentId + from + to. The
  // metricstore.timeseries() helper enforces non-empty from/to and returns
  // a flat array of rows. We re-wrap as { points } for frontend consumption.
  r.get('/api/dashboard/metrics/timeseries', auth, async (req, res) => {
    const { metricId, agentId, from, to } = req.query;
    if (!metricId) return res.status(400).json({ error: 'missing metricId' });
    if (!agentId) return res.status(400).json({ error: 'missing agentId' });
    try {
      const db = getDb();
      const fromTs = from ? new Date(from) : new Date(Date.now() - 3600 * 1000);
      const toTs = to ? new Date(to) : new Date();
      if (isNaN(fromTs.getTime()) || isNaN(toTs.getTime())) {
        return res.status(400).json({ error: 'invalid from/to timestamp' });
      }
      const rows = await metricstore.timeseries(db, {
        metricId,
        agentId,
        from: fromTs,
        to: toTs
      });
      res.json({
        points: rows.map((r) => ({
          ts: toIso(r.ts),
          value: Number(r.value),
          tags: r.tags_json ?? null,
          unit: r.unit ?? null
        }))
      });
    } catch (e) {
      logger.error({ err: e }, 'dashboard metrics timeseries failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}
