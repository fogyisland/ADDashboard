import { Router } from 'express';
import { userAuth } from '../auth/user-auth.js';
import { requirePerm } from '../auth/rbac.js';
import { getDb } from '../db/index.js';
import { listPortStatusesForAgents } from '../services/port-status.js';
import { getReplicationPortList } from '../services/replication-port-config.js';
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
      // 2026-08-26 round-21: derive nodes from the catalog (ad_sites +
      // ad_dcs) — the catalog is the operator-facing truth, and the
      // earlier approach of pulling site labels from
      // ad_replication_status.source_site leaked the agent's free-text
      // site hint (MOCK-NC) into the graph instead of the canonical
      // 南昌站点 / 核心站点 / etc. Links now come from a filtered /
      // deduped query so the graph shows the current topology rather
      // than every row ever written to ad_replication_status.
      const [nodesRes, linksRes] = await Promise.all([
        db.query(db.sql.dashboard.topologyNodes),
        db.query(db.sql.dashboard.topologyLinks)
      ]);
      // First row per site carries the site node; subsequent rows for
      // the same site contribute DC children only.
      const nodes = [];
      const seenSites = new Set();
      for (const row of nodesRes.rows) {
        if (row.site_name && !seenSites.has(row.site_name)) {
          nodes.push({ name: row.site_name, type: 'site' });
          seenSites.add(row.site_name);
        }
        if (row.dc_name) {
          nodes.push(row.site_name
            ? { name: row.dc_name, site: row.site_name, type: 'dc' }
            : { name: row.dc_name, type: 'dc' });
        }
      }
      const links = linksRes.rows.map(r => ({
        source:          r.source_dc,
        target:          r.dest_dc,
        statusCode:      r.status_code,
        lastSuccessTime: toIso(r.last_success_time)
      }));
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

  // 2026-08-27 round-27: global all-sites replication matrix view. Returns
  // every site hub-first, each as a self-contained block with its DCs,
  // within-site links (both source and dest in same site), and cross-site
  // in/out lists partitioned by direction. Per-link partner-port probe
  // data (from `partner_port_status` JSON) is merged in so the operator
  // sees per-port reachable/latency on every cross-site link. Returns 5
  // queries' worth of data in one round-trip.
  r.get('/api/dashboard/site-replication-matrix/all', auth, async (_req, res) => {
    try {
      const db = getDb();
      const ports = await getReplicationPortList();

      const [{ rows: siteRows }, { rows: dcRows }, { rows: linkRows }, { rows: portRows }, { rows: cfgRows }] =
        await Promise.all([
          db.query(db.sql.dashboard.allSitesOrdered, []),
          db.query(db.sql.dashboard.allDcsBySite, []),
          db.query(db.sql.dashboard.allReplicationLinks, []),
          db.query(db.sql.replication.latestPartnerPortPerPair),
          db.query(db.sql.dashboard.refreshSeconds, [])
        ]);

      // dcByName: source for classifying each link (source_dc -> {site_id, ...})
      const dcByName = new Map(dcRows.map(d => [d.dc_name, d]));

      // Build siteIndex keyed by site_id -> output block. SQL ORDER BY
      // already returns rows hub-first (is_hub DESC, region_code, site_name),
      // so Map preserves insertion order in modern JS.
      const siteIndex = new Map();
      for (const sr of siteRows) {
        siteIndex.set(sr.site_id, {
          siteId: sr.site_id, siteName: sr.site_name,
          regionCode: sr.region_code, isHub: !!sr.is_hub,
          description: sr.description,
          dcs: [], withinLinks: [], crossOut: [], crossIn: []
        });
      }

      // Attach DCs to their site block
      for (const d of dcRows) {
        const site = siteIndex.get(d.site_id);
        if (!site) continue;
        site.dcs.push({
          dcName: d.dc_name, osVersion: d.os_version,
          isPdc: !!d.is_pdc, isGc: !!d.is_gc,
          isRidMaster: !!d.is_rid_master, isSchemaMaster: !!d.is_schema_master,
          isDomainNamingMaster: !!d.is_domain_naming_master,
          isInfrastructureMaster: !!d.is_infrastructure_master,
          discoveredAt: toIso(d.discovered_at),
          discoveredByAgentId: d.discovered_by_agent_id
        });
      }

      // Partner-port probe index, normalised to JS object (both dialects:
      // mysql2 returns parsed object, tedious returns string)
      const perPortByPair = new Map();
      for (const r of portRows) {
        let perPort = {};
        const raw = r.partner_port_status;
        if (raw != null) {
          if (typeof raw === 'object') perPort = raw;
          else { try { perPort = JSON.parse(String(raw)); } catch { perPort = {}; } }
        }
        perPortByPair.set(`${r.source_dc}${r.dest_dc}`, {
          perPort,
          lastProbeAt: toIso(r.last_attempt_time ?? r.collected_at)
        });
      }

      // Walk links, classify within vs cross, attach to source/dest sites
      for (const l of linkRows) {
        const srcDc = dcByName.get(l.source_dc);
        const dstDc = dcByName.get(l.dest_dc);
        if (!srcDc || !dstDc) continue; // orphan DC — drop
        const srcSite = siteIndex.get(srcDc.site_id);
        const dstSite = siteIndex.get(dstDc.site_id);
        if (!srcSite || !dstSite) continue;

        const portEntry = perPortByPair.get(`${l.source_dc}${l.dest_dc}`);
        const baseLink = {
          source: l.source_dc, target: l.dest_dc,
          namingContext: l.naming_context,
          statusCode: l.status_code,
          lastSuccessTime: toIso(l.last_success_time),
          lastAttemptTime: toIso(l.last_attempt_time),
          durationMinutes: l.duration_minutes,
          perPort: portEntry?.perPort ?? null,
          lastProbeAt: portEntry?.lastProbeAt ?? null
        };

        if (srcDc.site_id === dstDc.site_id) {
          srcSite.withinLinks.push({ ...baseLink });
        } else {
          srcSite.crossOut.push({ ...baseLink, sourceSite: srcSite.siteName, targetSite: dstSite.siteName });
          dstSite.crossIn.push({ ...baseLink, sourceSite: srcSite.siteName, targetSite: dstSite.siteName });
        }
      }

      const sites = [...siteIndex.values()]; // already hub-first from SQL ORDER BY
      const siteRefreshSeconds = Number(cfgRows[0]?.config_value || 10);
      res.json({ siteRefreshSeconds, ports, sites });
    } catch (e) {
      logger.error({ err: e }, 'site-replication-matrix/all failed');
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
