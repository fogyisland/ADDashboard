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
      // 2026-08-30 R68: Hub-Spoke 拓扑分组 — 把 is_hub 标志从 SQL 一路
      // 透传到 site 节点。TopologyChart.vue 据此:
      //   - 把 Hub 站点画成大节点 (金色,加粗)
      //   - 把 Spoke 站点画成小节点 (灰色,细体)
      //   - 把 Hub-Hub 链路画成粗线 (核心层)
      //   - 把 Spoke-Spoke 链路隐藏 (designed absence)
      // ad_sites.is_hub 是 Operator 在 ad_sites 清单维护的权威标志
      // (R53 已有 UI)。不需要额外字段。
      for (const row of nodesRes.rows) {
        if (row.site_name && !seenSites.has(row.site_name)) {
          nodes.push({
            name: row.site_name,
            type: 'site',
            isHub: !!row.is_hub
          });
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

  // 2026-09-01 R74: 复制错误 — dedicated read-only surface that lists
  // every (source_dc, dest_dc, naming_context) tuple whose LATEST status
  // is a failure (status_code IN 1, 2). Mirrors the latest-per-pair
  // correlated subquery used by /all + /pair-history but anchored on
  // `last_attempt_time` (a stale-but-failed link should still surface,
  // which is the whole point of this view). Window is configurable via
  // ?window=24h (default) or 7d; everything else is a 400. Hard 200-row
  // cap to keep the page scannable.
  //
  // Response envelope:
  //   {
  //     window: '24h',
  //     errors: [
  //       { sourceDc, destDc, namingContext, statusCode,
  //         lastAttemptTime, lastSuccessTime, attemptCount,
  //         errorMessage, durationMs }
  //     ],
  //     total: N
  //   }
  r.get('/api/dashboard/replication-errors', auth, async (req, res) => {
    try {
      const windowKey = String(req.query.window || '24h').trim().toLowerCase();
      let hours;
      if (windowKey === '24h') hours = 24;
      else if (windowKey === '7d') hours = 7 * 24;
      else return res.status(400).json({ error: 'invalid window (use 24h or 7d)' });

      const db = getDb();
      // Both branches bind the window twice — once for the LEFT JOIN'd
      // attempt_count subquery, once for the outermost WHERE filter.
      // Dialect param order is identical ([hours, hours]) so no
      // dialect-aware switching is needed (matches /pair-history's
      // pattern of branching on dialect only when param order differs).
      const params = [hours, hours];
      const { rows } = await db.query(db.sql.dashboard.replicationErrors, params);
      const errors = rows.map(r => ({
        sourceDc:        r.source_dc,
        destDc:          r.dest_dc,
        namingContext:   r.naming_context,
        statusCode:      r.status_code,
        lastAttemptTime: toIso(r.last_attempt_time),
        lastSuccessTime: toIso(r.last_success_time),
        attemptCount:    Number(r.attempt_count) || 0,
        errorMessage:    r.error_message,
        durationMs:      r.duration_ms == null ? null : Number(r.duration_ms)
      }));
      res.json({ window: windowKey, errors, total: errors.length });
    } catch (e) {
      logger.error({ err: e }, 'dashboard replication-errors failed');
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

  // 2026-08-27 round-33: single-site /api/dashboard/site-replication-matrix
  // endpoint removed — replaced by the unified /all view below. The
  // single-site view showed one site's DC×DC matrix at a time, but
  // operators now navigate via the hub-first overview.

  // 2026-08-27 round-35: matrix view is inbound-only. Operator ruling
  // "我们只需要检查入站的就好了，出战的没有意义，出战对于其他机器就是
  // 入站" — outbound for one machine is inbound for another, so a TCP
  // probe shows twice when rendered from both ends. The route now keeps
  // ONLY links where the primary is the destination (other DCs send
  // replication TO this primary). Each (source, dest) probe surfaces
  // exactly once, from the destination's perspective.
  //
  // History: round-28 added per-primary partner tables (out + in);
  // round-28.5 added bridgehead selection; round-31 added per-site DC
  // listing; round-32 added per-port probe data + peer-type tag;
  // round-33 collapsed to a single 复制状态概览 entry (deleted the
  // single-site matrix). round-35 narrows to inbound.
  //
  // Bridgehead selection (round-28.5): sort each site's DCs by
  // is_bridgehead DESC, dc_name ASC. The bridgehead marker is operator-set;
  // PDC (FSMO role) is intentionally NOT used — see ruling: "PDC 不是
  // 标记 是角色". If no DC in a site is marked bridgehead, the lex-first
  // dc_name wins silently. The chosen primary's isBridgehead flag is
  // surfaced in the response so the view can show a "桥头" badge.
  r.get('/api/dashboard/site-replication-matrix/all', auth, async (_req, res) => {
    try {
      const db = getDb();
      // 2026-08-28 round-45: port fields removed (R35 port monitoring
      // surface deleted). `ports`, `portRows`, `latestPartnerPortPerPair`
      // and the per-partner `perPort` / `lastProbeAt` fields are all gone
      // — the partner entry now carries only status + timing. Per-pair
      // history is fetched on demand via /pair-history for the inline
      // "最近 10 条" expansion.

      const [{ rows: siteRows }, { rows: dcRows }, { rows: linkRows }, { rows: cfgRows }] =
        await Promise.all([
          db.query(db.sql.dashboard.allSitesOrdered, []),
          db.query(db.sql.dashboard.allDcsBySite, []),
          db.query(db.sql.dashboard.allReplicationLinks, []),
          db.query(db.sql.dashboard.refreshSeconds, [])
        ]);

      // dcByName: source for classifying each link
      const dcByName = new Map(dcRows.map(d => [d.dc_name, d]));
      // siteById: source of truth for site membership / hub flag
      const siteById = new Map(siteRows.map(s => [s.site_id, {
        siteId: s.site_id, siteName: s.site_name,
        regionCode: s.region_code, isHub: !!s.is_hub
      }]));

      // Group DCs by site, sorted by bridgehead-flag DESC then dc_name ASC.
      // Primary = first row. (round-28.5 operator ruling: 桥头DC marker
      // chosen by operator; PDC is an FSMO role, not a marker, so we do NOT
      // use is_pdc to choose primary. If no DC in a site is marked
      // bridgehead, the lexically-first dc_name wins — fallback is silent.)
      //
      // round-31: each entry in dcsBySite carries the full DC shape (role
      // flags + osVersion) so the response can surface every DC in the
      // site, not just the bridgehead. The view renders this as a "本站 DC"
      // panel above the partner matrix.
      const dcsBySite = new Map();
      for (const d of dcRows) {
        if (!dcsBySite.has(d.site_id)) dcsBySite.set(d.site_id, []);
        dcsBySite.get(d.site_id).push({
          dcName: d.dc_name,
          isBridgehead: !!d.is_bridgehead,
          isPdc: !!d.is_pdc,
          isGc: !!d.is_gc,
          isRidMaster: !!d.is_rid_master,
          isSchemaMaster: !!d.is_schema_master,
          isDomainNamingMaster: !!d.is_domain_naming_master,
          isInfrastructureMaster: !!d.is_infrastructure_master,
          osVersion: d.os_version,
          discoveredAt: toIso(d.discovered_at)
        });
      }
      for (const arr of dcsBySite.values()) {
        arr.sort((a, b) => {
          if (a.isBridgehead !== b.isBridgehead) return a.isBridgehead ? -1 : 1;
          return a.dcName.localeCompare(b.dcName);
        });
      }

      // Partner-port probe index, normalised to JS object (both dialects:
      // mysql2 returns parsed object, tedious returns string)
      // Walk sites in SQL order (hub-first). For each site, build a
      // partner table PER DC in the site (round-36: operator directive
      // "本地站点只显示了一台,另外一台没有显示出来,我们需要显示所有的"
      // — every DC in the local site must surface its own inbound
      // partner list, not only the bridgehead primary). The partner
      // set per DC is FILTERED to keep only operator-relevant
      // connections (round-32 directive):
      //   (a) within-site siblings — every other DC in the same site
      //   (b) cross-site bridgeheads — the primary DC of every other site
      //       (i.e. the chosen bridgehead, or the lex-first fallback if no
      //        bridgehead is marked)
      // Non-bridgehead cross-site DCs are intentionally excluded — the
      // 复制伙伴状态 view is a focused per-bridgehead signal, not a
      // dump of every replication link.
      const sep = String.fromCharCode(1);
      // Build the cross-site primary lookup: siteId → primaryDcName.
      const primaryBySiteId = new Map();
      for (const s of siteRows) {
        const dcList = dcsBySite.get(s.site_id) || [];
        if (dcList.length === 0) continue;
        primaryBySiteId.set(s.site_id, dcList[0].dcName);
      }
      const primaries = [];
      for (const s of siteRows) {
        const dcList = dcsBySite.get(s.site_id) || [];
        if (dcList.length === 0) continue; // no DCs in this site — skip
        const primaryEntry = dcList[0];
        const primaryDc = primaryEntry.dcName;

        // Partner allowlist: all within-site DCs + cross-site primary DCs.
        // round-36: the primary DC itself is a valid peer for sibling DCs
        // (BJ-02's inbound partner list must include BJ-01, even though
        // BJ-01 is the site's primary). The `d.dcName !== primaryDc`
        // filter from round-32 dropped that case — only correct for the
        // per-primary partner list, NOT the per-DC partner maps we now
        // build. Self-loops are still blocked by the `source_dc ===
        // dest_dc` guard at the top of the link loop.
        const allowedPeers = new Set();
        for (const d of dcList) allowedPeers.add(d.dcName);
        for (const [siteId, primaryName] of primaryBySiteId) {
          if (siteId !== s.site_id) allowedPeers.add(primaryName);
        }

        // round-36: build one partner map per DC in the site. Walk every
        // link, find the receiving DC inside this site, attach the partner
        // entry to that DC's map. Inbound-only: source-dc is the partner,
        // dest-dc is the receiver (dropped when dest_dc === source_dc).
        const partnerMapByDc = new Map();
        for (const d of dcList) partnerMapByDc.set(d.dcName, new Map());

        for (const l of linkRows) {
          // self-loop guard
          if (l.source_dc === l.dest_dc) continue;
          // inbound-only: dest_dc is the receiver
          if (!partnerMapByDc.has(l.dest_dc)) continue; // dest not in this site
          const peerDc = l.source_dc;
          if (!allowedPeers.has(peerDc)) continue; // round-32 filter
          const peer = dcByName.get(peerDc);
          if (!peer) continue; // orphan DC
          const peerSite = siteById.get(peer.site_id);
          if (!peerSite) continue;

          const portEntry = null; // round-45: port fields removed
          const entry = {
            // round-32: peerType distinguishes within-site siblings from
            // cross-site bridgehead primaries. "within" = same-site sibling,
            // "bridgehead" = cross-site primary (operator-selected
            // bridgehead, or lex-first fallback).
            peerType: peer.site_id === s.site_id ? "within" : "bridgehead",
            peerDc,
            peerSite: peerSite.siteName,
            peerSiteIsHub: peerSite.isHub,
            statusCode: l.status_code,
            lastSuccessTime: toIso(l.last_success_time),
            lastAttemptTime: toIso(l.last_attempt_time),
            durationMinutes: l.duration_minutes
          };
          // round-35: dedup key no longer needs the direction prefix —
          // every entry is inbound. peerDc alone is sufficient because
          // the same source DC can only have one latest link per
          // (source_dc, dest_dc) pair after the latest-per-pair subquery.
          const targetMap = partnerMapByDc.get(l.dest_dc);
          const k = peerDc;
          const existing = targetMap.get(k);
          if (!existing) {
            targetMap.set(k, entry);
          } else {
            const exTime = existing.lastAttemptTime ? new Date(existing.lastAttemptTime).getTime() : 0;
            const newTime = entry.lastAttemptTime ? new Date(entry.lastAttemptTime).getTime() : 0;
            if (newTime > exTime) targetMap.set(k, entry);
          }
        }

        // round-36: per-DC partner tables. Each entry carries the full DC
        // shape (role flags + osVersion) plus its own sorted partners[].
        // Order matches the bridgehead-priority sort on dcList (bridgehead
        // first, then lex). The view renders one section per entry.
        const dcPartners = dcList.map((d) => {
          const partners = [...partnerMapByDc.get(d.dcName).values()].sort((a, b) => {
            if (a.peerType !== b.peerType) return a.peerType === "within" ? -1 : 1;
            if (a.peerSite !== b.peerSite) return a.peerSite.localeCompare(b.peerSite, "zh");
            return a.peerDc.localeCompare(b.peerDc);
          });
          return {
            dcName: d.dcName,
            isBridgehead: d.isBridgehead,
            isPdc: d.isPdc,
            isGc: d.isGc,
            isRidMaster: d.isRidMaster,
            isSchemaMaster: d.isSchemaMaster,
            isDomainNamingMaster: d.isDomainNamingMaster,
            isInfrastructureMaster: d.isInfrastructureMaster,
            osVersion: d.osVersion,
            discoveredAt: d.discoveredAt,
            partners
          };
        });

        // Backwards compat: top-level partners/pcSummary mirror the bridgehead
        // primary's entry. Operators who deep-link to dcName still get a
        // usable payload without iterating dcPartners[].
        const primaryDcPartners = dcPartners.find((d) => d.dcName === primaryDc);
        const partners = primaryDcPartners ? primaryDcPartners.partners : [];

        primaries.push({
          dcName: primaryDc,
          isBridgehead: primaryEntry.isBridgehead,
          siteId: s.site_id,
          siteName: s.site_name,
          regionCode: s.region_code,
          isHub: !!s.is_hub,
          // round-31: full DC list (kept for the "本站 DC 清单" panel).
          // round-36: partner info moves into dcPartners[]; the dcs list
          // remains the source of truth for site membership + role flags.
          dcs: dcList.map(d => ({
            dcName: d.dcName,
            isBridgehead: d.isBridgehead,
            isPdc: d.isPdc,
            isGc: d.isGc,
            isRidMaster: d.isRidMaster,
            isSchemaMaster: d.isSchemaMaster,
            isDomainNamingMaster: d.isDomainNamingMaster,
            isInfrastructureMaster: d.isInfrastructureMaster,
            osVersion: d.osVersion,
            discoveredAt: d.discoveredAt
          })),
          // round-36: per-DC partner tables (one entry per DC in the site).
          // Each entry has full role flags + osVersion + its own partners[].
          dcPartners,
          // Backwards compat: bridgehead primary's partners mirrored to
          // top-level `partners`. Tests + existing consumers can keep using
          // p.partners without iterating dcPartners[].
          partners
        });
      }

      const siteRefreshSeconds = Number(cfgRows[0]?.config_value || 10);
      // round-45: `ports` field removed from envelope (R35 port monitoring
      // surface deleted; operator-side /admin/ports sidebar entry preserved
      // because it has its own UI backed by services/ports.js).
      res.json({ siteRefreshSeconds, primaries });
    } catch (e) {
      logger.error({ err: e }, 'site-replication-matrix/all failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // 2026-08-28 round-45: per-pair history lazy-fetch for the inline
  // expansion in 复制状态概览 (SiteReplicationMatrixAllView). Returns the
  // last N history rows from ad_replication_history filtered by
  // (source_dc, dest_dc) and a 24-hour window. The route deliberately
  // does NOT join ad_replication_status — history is its own source of
  // truth (one row per attempt, regardless of current status). Naming
  // contexts are NOT filtered here because the row comes from the
  // replication-history ingest path which stamps real naming_contexts
  // (CN=Configuration,DC=…); the only synthetic NCs (__history__:*,
  // __dc_summary__) never land in ad_replication_history.
  //
  // Response envelope:
  //   { source, dest, limit, entries: [
  //       { attemptAt, statusCode, durationMs, objectsTransferred,
  //         lastSuccessTime, errorMessage }
  //     ]
  //   }
  r.get('/api/dashboard/site-replication-matrix/pair-history', auth, async (req, res) => {
    try {
      const source = String(req.query.source || '').trim();
      const dest = String(req.query.dest || '').trim();
      const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 10));
      if (!source || !dest) {
        return res.status(400).json({ error: 'source and dest required' });
      }
      const db = getDb();
      // MySQL binds [source, dest, limit]; MSSQL binds [limit, source, dest]
      // because the SQL helper rewrites `LIMIT ?` to `TOP (?)` for MSSQL
      // and the driver wrapper expects the LIMIT token to be the first
      // bound param for MSSQL. Pass dialect-aware params via buildSql().
      const isMssql = String(process.env.DB_DIALECT || '').toLowerCase() === 'mssql'
        || (db?.pool?.constructor?.name || '').toLowerCase().includes('mssql');
      const params = isMssql ? [limit, source, dest] : [source, dest, limit];
      const { rows } = await db.query(db.sql.dashboard.replicationLogPerPair, params);
      const entries = rows.map(r => ({
        attemptAt: toIso(r.collected_at),
        statusCode: r.status_code,
        durationMs: r.attempt_duration_ms,
        objectsTransferred: r.objects_transferred,
        lastSuccessTime: toIso(r.last_success_time),
        errorMessage: r.error_message
      }));
      res.json({ source, dest, limit, entries });
    } catch (e) {
      logger.error({ err: e, source: req.query.source, dest: req.query.dest }, 'site-replication-matrix/pair-history failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // 2026-08-27 round-42 (复制日志监控): operator directive "增加一个运维
  // 监控, 复制日志监控 — 一个站点下面如果有多台服务器, 多台服务器有多个
  // 复制伙伴, 列出最新的连接状态, 然后在右边多一个展开箭头, 列出最近
  // 10 次的连接具体信息". The view mirrors the per-DC partner tables of
  // /api/dashboard/site-replication-matrix/all (round-36) but augments
  // every partner with attempts[] — the latest 10 history rows for that
  // (source_dc, dest_dc, naming_context) tuple from ad_replication_history.
  // 2026-08-28 round-45: route restored as a STANDALONE view (the inline
  // caret expansion inside 复制状态概览 uses the slimmer /pair-history
  // endpoint above; 复制日志监控 is the drill-down UI per operator
  // directive "那个和当前的复制状况概览是两个不同界面").
  // 2026-08-28 round-46: filter partners to inbound-only (`direction='in'`
  // per R43 direction emission; out-bound entries drop). Each inbound
  // partner gets `portHealth[]` — the latest per-(source_dc, dest_dc)
  // partner-port probe result for the configured ports, plus
  // `configuredPorts[]` (the global list from system_ports). The operator
  // directive: "复制日志监控 不对,我们之前需要的是监控入站信息,同时监控
  // 设定端口健康" — this view is now both inbound monitoring AND the
  // configured-port health check.
  // 2026-08-28 round-47: renamed 复制日志监控 → 复制伙伴端口健康监控.
  // Operator directive "在这边不叫复制日志监控了，改成复制伙伴端口健康
  // 监控名称,否则会引起误解". The route drops the replication-attempt
  // history surface — `attempts[]` is no longer emitted (R42 caret
  // history is now exclusive to 复制状态概览's inline expansion via
  // /pair-history). This view is port-health only: per-(site, DC,
  // partner) cell matrix where each cell carries the latest TCP-probe
  // latency (ms) for one of the configured ports, rendered with the
  // R47 colour thresholds (≤1000ms green / >1000ms yellow / ✕ red /
  // — gray).
  //
  // Response envelope:
  //   {
  //     refreshSeconds: 10,
  //     sites: [
  //       {
  //         siteId, siteName, regionCode, isHub,
  //         dcs: [
  //           {
  //             dcName, isBridgehead, role flags, osVersion, discoveredAt,
  //             partners: [
  //               {
  //                 peerType, peerDc, peerSite, peerSiteIsHub,
  //                 statusCode, lastSuccessTime, lastAttemptTime,
  //                 durationMinutes,
  //                 configuredPorts: [{ port, label }, ...],
  //                 portHealth: [{ statusCode, lastAttemptTime, ports: [{port, ok, latency}, ...] }]
  //               }
  //             ]
  //           }
  //         ]
  //       }
  //     ]
  //   }
  r.get('/api/dashboard/partner-port-health/all', auth, async (_req, res) => {
    try {
      const db = getDb();

      const [{ rows: siteRows }, { rows: dcRows }, { rows: linkRows }, { rows: cfgRows }, { rows: portRows }, { rows: cfgPortRows }] =
        await Promise.all([
          db.query(db.sql.dashboard.allSitesOrdered, []),
          db.query(db.sql.dashboard.allDcsBySite, []),
          db.query(db.sql.dashboard.allReplicationLinks, []),
          db.query(db.sql.dashboard.refreshSeconds, []),
          db.query(db.sql.dashboard.latestPartnerPortPerPair, []),
          db.query(db.sql.ports.list, [])
        ]);

      // Index the configured port list (from system_ports) once. Each
      // partner gets the same list appended as `configuredPorts[]` so the
      // view can show reachability per port without an extra round-trip.
      const configuredPorts = cfgPortRows.map(p => ({
        port: p.port,
        label: p.label
      }));

      const dcByName = new Map(dcRows.map(d => [d.dc_name, d]));
      const siteById = new Map(siteRows.map(s => [s.site_id, {
        siteId: s.site_id, siteName: s.site_name,
        regionCode: s.region_code, isHub: !!s.is_hub
      }]));

      const dcsBySite = new Map();
      for (const d of dcRows) {
        if (!dcsBySite.has(d.site_id)) dcsBySite.set(d.site_id, []);
        dcsBySite.get(d.site_id).push({
          dcName: d.dc_name,
          isBridgehead: !!d.is_bridgehead,
          isPdc: !!d.is_pdc,
          isGc: !!d.is_gc,
          isRidMaster: !!d.is_rid_master,
          isSchemaMaster: !!d.is_schema_master,
          isDomainNamingMaster: !!d.is_domain_naming_master,
          isInfrastructureMaster: !!d.is_infrastructure_master,
          osVersion: d.os_version,
          discoveredAt: toIso(d.discovered_at)
        });
      }
      for (const arr of dcsBySite.values()) {
        arr.sort((a, b) => {
          if (a.isBridgehead !== b.isBridgehead) return a.isBridgehead ? -1 : 1;
          return a.dcName.localeCompare(b.dcName);
        });
      }

      const primaryBySiteId = new Map();
      for (const s of siteRows) {
        const list = dcsBySite.get(s.site_id) || [];
        if (list.length) primaryBySiteId.set(s.site_id, list[0].dcName);
      }

      const sep = String.fromCharCode(1);

      // 2026-08-28 round-46: index partner-port probe results by
      // (source_dc, dest_dc). Each entry's partner_port_status JSON is
      // parsed and surfaced as portHealth[] on the partner row.
      const portHealthByPair = new Map();
      for (const r of portRows) {
        let parsed = null;
        if (typeof r.partner_port_status === 'string' && r.partner_port_status.length) {
          try { parsed = JSON.parse(r.partner_port_status); }
          catch { parsed = null; }
        }
        portHealthByPair.set(`${r.source_dc}${sep}${r.dest_dc}`, {
          statusCode: r.status_code,
          lastAttemptTime: toIso(r.last_attempt_time),
          portStatus: parsed
        });
      }

      const sites = [];
      for (const s of siteRows) {
        const dcList = dcsBySite.get(s.site_id) || [];
        if (dcList.length === 0) continue;
        const primaryDc = dcList[0].dcName;

        const allowedPeers = new Set();
        for (const d of dcList) allowedPeers.add(d.dcName);
        for (const [siteId, primaryName] of primaryBySiteId) {
          if (siteId !== s.site_id) allowedPeers.add(primaryName);
        }

        const partnerMapByDc = new Map();
        for (const d of dcList) partnerMapByDc.set(d.dcName, new Map());

        for (const l of linkRows) {
          if (l.source_dc === l.dest_dc) continue;

          // 2026-08-28 round-46: filter to inbound only — operator directive
          // "出战没有意义,出战对其他机器就是入站" (re-stated for R46). The
          // out-bound side still surfaces in 复制状态概览 (R36) where the
          // partner grid enumerates both, but 复制伙伴端口健康监控 is
          // INBOUND-first.
          const sides = [];
          if (partnerMapByDc.has(l.dest_dc) && allowedPeers.has(l.source_dc)) {
            sides.push({ dcName: l.dest_dc, peerDc: l.source_dc, direction: 'in' });
          }
          if (sides.length === 0) continue;

          for (const side of sides) {
            const peerDc = side.peerDc;
            const peer = dcByName.get(peerDc);
            if (!peer) continue;
            const peerSite = siteById.get(peer.site_id);
            if (!peerSite) continue;
            const targetMap = partnerMapByDc.get(side.dcName);
            // 2026-08-28 round-56: dedup key was previously keyed on
            // (peerDc, naming_context, direction) — but `allReplicationLinks`
            // returns one row per (source_dc, dest_dc, naming_context)
            // tuple, and AD reports multiple naming_contexts per partner
            // pair (CN=Configuration, CN=Schema, DC=domain) PLUS the
            // synthetic `__partner_ports__:<hash>` rows. The operator's
            // mental model is "one partner per (DC, peer, direction)"; the
            // view renders a single row for each. Drop naming_context from
            // the key; keep the most recent attempt across all naming
            // contexts (the partner_port_status JSON blob is sourced from
            // `portHealthByPair` independently, so it always joins back in).
            const k = `${peerDc}${sep}${side.direction}`;
            const existing = targetMap.get(k);
            if (existing) {
              const exTime = existing.lastAttemptTime ? new Date(existing.lastAttemptTime).getTime() : 0;
              const newTime = l.last_attempt_time ? new Date(l.last_attempt_time).getTime() : 0;
              if (newTime <= exTime) continue;
            }
            // 2026-08-28 round-46: attach portHealth + configuredPorts. The
            // probe is keyed on (source_dc, dest_dc) — same as the inbound
            // peer DC pair — so this is a single Map lookup per partner.
            const portKey = `${l.source_dc}${sep}${l.dest_dc}`;
            const portHealthEntry = portHealthByPair.get(portKey);
            const portHealth = portHealthEntry
              ? [{
                  statusCode: portHealthEntry.statusCode,
                  lastAttemptTime: portHealthEntry.lastAttemptTime,
                  ports: Array.isArray(portHealthEntry.portStatus?.ports)
                    ? portHealthEntry.portStatus.ports
                    : []
                }]
              : [];
            targetMap.set(k, {
              peerType: peer.site_id === s.site_id ? "within" : "bridgehead",
              peerDc,
              namingContext: l.naming_context,
              direction: side.direction,
              peerSite: peerSite.siteName,
              peerSiteIsHub: peerSite.isHub,
              statusCode: l.status_code,
              lastSuccessTime: toIso(l.last_success_time),
              lastAttemptTime: toIso(l.last_attempt_time),
              durationMinutes: l.duration_minutes,
              configuredPorts,
              portHealth
              // 2026-08-28 round-47: attempts[] field removed — this view
              // is port-health only. Replication-attempt history is
              // exclusive to 复制状态概览's inline caret via /pair-history.
            });
          }
        }

        const dcs = dcList.map(d => {
          const partners = [...partnerMapByDc.get(d.dcName).values()].sort((a, b) => {
            if (a.peerType !== b.peerType) return a.peerType === "within" ? -1 : 1;
            if (a.peerSite !== b.peerSite) return a.peerSite.localeCompare(b.peerSite, "zh");
            return a.peerDc.localeCompare(b.peerDc);
          });
          return {
            dcName: d.dcName,
            isBridgehead: d.isBridgehead,
            isPdc: d.isPdc,
            isGc: d.isGc,
            isRidMaster: d.isRidMaster,
            isSchemaMaster: d.isSchemaMaster,
            isDomainNamingMaster: d.isDomainNamingMaster,
            isInfrastructureMaster: d.isInfrastructureMaster,
            osVersion: d.osVersion,
            discoveredAt: d.discoveredAt,
            partners
          };
        });

        sites.push({
          siteId: s.site_id,
          siteName: s.site_name,
          regionCode: s.region_code,
          isHub: !!s.is_hub,
          primaryDc,
          dcs
        });
      }

      const refreshSeconds = Number(cfgRows[0]?.config_value || 10);
      res.json({ refreshSeconds, sites });
    } catch (e) {
      logger.error({ err: e }, 'partner-port-health/all failed');
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
        // R66 T13 — read the V1 package_scripts row (the script row
        // carries the manifest with the metrics array; the legacy
        // installedPackages.get helper was retired with the V0 wrapper).
        // R66 T14 — the V0 SQL string registry `db.sql.installedPackages`
        // was retired alongside the table itself (migration 023 drops
        // installed_packages).
        const { packageScripts } = await import('../db/sql/package-scripts.js');
        const script = await packageScripts.get(db, packageName);
        if (script && Array.isArray(script.manifest?.metrics)) {
          const all = await Promise.all(
            script.manifest.metrics.map((m) =>
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

  // 2026-08-30 R67-T2: 包执行状态监控 (监控指标 AppLayout). Pure-read
  // surface that surfaces what R66's package_runs table already captures.
  // Each package gets a 24h summary (total / success / failure / partial)
  // + the last 10 runs as a drill-down. The metric manifest comes from
  // package_scripts (description, type, agentType) so the operator can
  // tell what each row means without consulting the script body. The view
  // is mounted at /packages-runs in the frontend AppLayout sidebar; this
  // endpoint is mounted under the dashboardRouter auth gate so any logged
  // user can see it (matches the rest of the frontend 监控指标 surfaces).
  //
  // Response envelope:
  //   {
  //     refreshSeconds: 10,
  //     packages: [
  //       {
  //         name, version, type, agentType, description,
  //         summary24h: { total, success, failure, partial, lastRunAt },
  //         recent: [
  //           { id, agentId, startedAt, finishedAt, exitCode,
  //             durationMs, stdoutPreview, stderrPreview, error }
  //         ]
  //       }
  //     ]
  //   }
  r.get('/api/dashboard/packages-runs', auth, async (_req, res) => {
    try {
      const db = getDb();
      const { packageScripts } = await import('../db/sql/package-scripts.js');
      const { packageRuns } = await import('../db/sql/package-runs.js');

      // 1. Resolve the package manifest list once (sorted by name so the
      // view's column order is stable across polls).
      const scripts = await packageScripts.list(db);
      scripts.sort((a, b) => a.name.localeCompare(b.name));

      // 2. Pull recent runs (cap 200) once and group by package_name at the
      // app layer — cheaper than N round-trips and the package_runs table
      // is bounded by an agent's heartbeat/interval cadence so 200 rows is
      // well below the worst-case.
      const recentAll = await packageRuns.listRecent(db, { limit: 200 });
      const runsByName = new Map();
      for (const r of recentAll) {
        if (!runsByName.has(r.package_name)) runsByName.set(r.package_name, []);
        runsByName.get(r.package_name).push(r);
      }

      const cutoff24h = Date.now() - 24 * 3600 * 1000;
      const packages = scripts.map((s) => {
        const runs = runsByName.get(s.name) || [];
        let total24h = 0, success24h = 0, failure24h = 0, partial24h = 0;
        let lastRunAt = null;
        for (const r of runs) {
          const startedAt = r.started_at instanceof Date
            ? r.started_at.getTime()
            : new Date(r.started_at).getTime();
          if (startedAt >= cutoff24h) {
            total24h++;
            if (r.exit_code === 0) success24h++;
            else if (r.exit_code === null || r.exit_code === undefined) partial24h++;
            else failure24h++;
          }
          if (!lastRunAt || startedAt > lastRunAt) lastRunAt = startedAt;
        }
        const manifest = s.manifest || {};
        return {
          name: s.name,
          version: s.version,
          type: manifest.type || 'gauge',
          agentType: manifest.agent?.type || 'ad',
          description: manifest.description || '',
          summary24h: {
            total: total24h,
            success: success24h,
            failure: failure24h,
            partial: partial24h,
            lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null
          },
          recent: runs.slice(0, 10).map((r) => ({
            id: r.id,
            agentId: r.agent_id,
            startedAt: toIso(r.started_at),
            finishedAt: toIso(r.finished_at),
            exitCode: r.exit_code,
            durationMs: (r.started_at && r.finished_at)
              ? Math.max(0, new Date(r.finished_at).getTime() - new Date(r.started_at).getTime())
              : null,
            stdoutPreview: r.stdout_preview || null,
            stderrPreview: r.stderr_preview || null,
            error: r.error || null
          }))
        };
      });

      res.json({ refreshSeconds: 10, packages });
    } catch (e) {
      logger.error({ err: e }, 'packages-runs failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}
