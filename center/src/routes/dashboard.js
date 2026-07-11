import { Router } from 'express';
import { userAuth } from '../auth/user-auth.js';
import { requirePerm } from '../auth/rbac.js';

// Queries ---------------------------------------------------------------

const OVERVIEW_COUNTS = `
SELECT
  COUNT(*)                                          AS total,
  SUM(CASE WHEN status_code = 0 THEN 1 ELSE 0 END)  AS healthy,
  SUM(CASE WHEN status_code = 1 THEN 1 ELSE 0 END)  AS warning,
  SUM(CASE WHEN status_code >= 2 THEN 1 ELSE 0 END)  AS errored,
  MAX(collected_at)                                  AS last_update
FROM ad_replication_status;
`.trim();

const AGENT_COUNT = `
SELECT COUNT(*) AS agent_count
FROM ad_agent_heartbeat
WHERE last_heartbeat_at IS NOT NULL;
`.trim();

const SITE_MATRIX = `
SELECT
  source_site,
  dest_site,
  SUM(CASE WHEN status_code >= 2 THEN 1 ELSE 0 END) AS error_count,
  SUM(CASE WHEN status_code = 1 THEN 1 ELSE 0 END)  AS warning_count,
  COUNT(*)                                           AS total
FROM ad_replication_status
WHERE source_site IS NOT NULL AND dest_site IS NOT NULL
GROUP BY source_site, dest_site
ORDER BY source_site, dest_site;
`.trim();

const TOPOLOGY = `
SELECT
  source_site, dest_site,
  source_dc,   dest_dc,
  status_code, last_success_time
FROM ad_replication_status;
`.trim();

const ERRORS = `
SELECT
  source_dc, dest_dc,
  source_site, dest_site,
  naming_context,
  status_code,
  last_success_time,
  last_attempt_time,
  TIMESTAMPDIFF(MINUTE, last_success_time, last_attempt_time) AS duration_minutes
FROM ad_replication_status
WHERE status_code <> 0
ORDER BY last_attempt_time DESC;
`.trim();

const AGENTS = `
SELECT
  agent_id,
  last_heartbeat_at,
  agent_version,
  last_report_at,
  last_report_status,
  pending_queue_size,
  TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW()) AS seconds_since_heartbeat
FROM ad_agent_heartbeat
ORDER BY agent_id;
`.trim();

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

export function dashboardRouter({ config, pool, logger }) {
  const r = Router();
  r.use(userAuth({ secret: config.jwtSecret }), requirePerm('read:dash'));

  r.get('/api/dashboard/overview', async (_req, res) => {
    try {
      const [counts] = await pool.execute(OVERVIEW_COUNTS);
      const [agents] = await pool.execute(AGENT_COUNT);
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

  r.get('/api/dashboard/site-matrix', async (_req, res) => {
    try {
      const [rows] = await pool.execute(SITE_MATRIX);
      res.json(rows.map(camelRow));
    } catch (e) {
      logger.error({ err: e }, 'dashboard site-matrix failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.get('/api/dashboard/topology', async (_req, res) => {
    try {
      const [rows] = await pool.execute(TOPOLOGY);
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

  r.get('/api/dashboard/errors', async (_req, res) => {
    try {
      const [rows] = await pool.execute(ERRORS);
      res.json(rows.map(camelRow));
    } catch (e) {
      logger.error({ err: e }, 'dashboard errors failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.get('/api/dashboard/agents', async (_req, res) => {
    try {
      const [rows] = await pool.execute(AGENTS);
      res.json(rows.map(camelRow));
    } catch (e) {
      logger.error({ err: e }, 'dashboard agents failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}