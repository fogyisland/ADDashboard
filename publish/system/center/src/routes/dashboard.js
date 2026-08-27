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
      const ports = await getReplicationPortList();

      const [{ rows: siteRows }, { rows: dcRows }, { rows: linkRows }, { rows: portRows }, { rows: cfgRows }] =
        await Promise.all([
          db.query(db.sql.dashboard.allSitesOrdered, []),
          db.query(db.sql.dashboard.allDcsBySite, []),
          db.query(db.sql.dashboard.allReplicationLinks, []),
          db.query(db.sql.replication.latestPartnerPortPerPair),
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

          const portEntry = perPortByPair.get(`${l.source_dc}${sep}${l.dest_dc}`);
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
            durationMinutes: l.duration_minutes,
            perPort: portEntry?.perPort ?? null,
            lastProbeAt: portEntry?.lastProbeAt ?? null
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
      res.json({ siteRefreshSeconds, ports, primaries });
    } catch (e) {
      logger.error({ err: e }, 'site-replication-matrix/all failed');
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
  //                 attempts: [ {attemptAt, statusCode, durationMs,
  //                              objectsTransferred, lastSuccessTime,
  //                              errorMessage}, ... ]  // last 10 by time DESC
  //               }
  //             ]
  //           }
  //         ]
  //       }
  //     ]
  //   }
  //
  // The 24h window on history (replicationLogRecentAttempts) limits the row
  // count to "what an operator can actually see in one screenful"; the
  // attempts[] slice to 10 happens client-side after the route groups rows
  // by (source_dc, dest_dc, naming_context). The slice uses
  // collected_at DESC so "latest 10" reads top-to-bottom in the UI.
  r.get('/api/dashboard/replication-log/all', auth, async (_req, res) => {
    try {
      const db = getDb();

      const [{ rows: siteRows }, { rows: dcRows }, { rows: linkRows }, { rows: histRows }, { rows: cfgRows }] =
        await Promise.all([
          db.query(db.sql.dashboard.allSitesOrdered, []),
          db.query(db.sql.dashboard.allDcsBySite, []),
          db.query(db.sql.dashboard.allReplicationLinks, []),
          db.query(db.sql.dashboard.replicationLogRecentAttempts, []),
          db.query(db.sql.dashboard.refreshSeconds, [])
        ]);

      // dcByName + siteById lookups (mirrors the matrix/all route).
      const dcByName = new Map(dcRows.map(d => [d.dc_name, d]));
      const siteById = new Map(siteRows.map(s => [s.site_id, {
        siteId: s.site_id, siteName: s.site_name,
        regionCode: s.region_code, isHub: !!s.is_hub
      }]));

      // Group DCs by site, sorted bridgehead-first then lex.
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

      // Build cross-site primary lookup: siteId -> primaryDcName.
      const primaryBySiteId = new Map();
      for (const s of siteRows) {
        const list = dcsBySite.get(s.site_id) || [];
        if (list.length) primaryBySiteId.set(s.site_id, list[0].dcName);
      }

      // Pre-group history rows by (source_dc||dest_dc||naming_context) so the
      // per-partner loop is O(P) lookups instead of O(P*H) scans. Rows are
      // already in collected_at DESC order from the SQL helper; we keep
      // that order while grouping.
      const historyByPair = new Map();
      for (const h of histRows) {
        const k = `${h.source_dc}${h.dest_dc}${h.naming_context}`;
        if (!historyByPair.has(k)) historyByPair.set(k, []);
        historyByPair.get(k).push(h);
      }

      const sep = String.fromCharCode(1);

      const sites = [];
      for (const s of siteRows) {
        const dcList = dcsBySite.get(s.site_id) || [];
        if (dcList.length === 0) continue;
        const primaryDc = dcList[0].dcName;

        // Partner allowlist: every within-site DC + every cross-site primary.
        const allowedPeers = new Set();
        for (const d of dcList) allowedPeers.add(d.dcName);
        for (const [siteId, primaryName] of primaryBySiteId) {
          if (siteId !== s.site_id) allowedPeers.add(primaryName);
        }

        const partnerMapByDc = new Map();
        for (const d of dcList) partnerMapByDc.set(d.dcName, new Map());

        for (const l of linkRows) {
          if (l.source_dc === l.dest_dc) continue;

          // 2026-08-28 round-43: a link has TWO sides, both must surface in
          // the partner views so operators see real AD topology (hub-spoke)
          // rather than "every DC replicates to every other DC".
          //   - side IN:  peerDc replicates TO this site DC  →  direction='in'
          //   - side OUT: this site DC replicates TO peerDc  →  direction='out'
          // Both sides can fire when the link is within-site (e.g. NC1↔NC2).
          // For each side, the "peer" is the OTHER end of the link.
          const sides = [];
          if (partnerMapByDc.has(l.dest_dc) && allowedPeers.has(l.source_dc)) {
            sides.push({ dcName: l.dest_dc, peerDc: l.source_dc, direction: 'in' });
          }
          if (partnerMapByDc.has(l.source_dc)) {
            sides.push({ dcName: l.source_dc, peerDc: l.dest_dc, direction: 'out' });
          }
          if (sides.length === 0) continue;

          for (const side of sides) {
            const peerDc = side.peerDc;
            const peer = dcByName.get(peerDc);
            if (!peer) continue;
            const peerSite = siteById.get(peer.site_id);
            if (!peerSite) continue;
            const targetMap = partnerMapByDc.get(side.dcName);
            // 2026-08-27 round-42 (复制日志监控): dedup key includes naming_context
            // (same source/dest pair can have multiple NCs — each gets its own
            // partner row). 2026-08-28 round-43: direction is part of the dedup
            // key so an 'in' and an 'out' for the same (peerDc, NC) stay
            // distinct. The view merges them client-side into a single 双向 row.
            const k = `${peerDc}${sep}${l.naming_context}${sep}${side.direction}`;
            const existing = targetMap.get(k);
            if (existing) {
              const exTime = existing.lastAttemptTime ? new Date(existing.lastAttemptTime).getTime() : 0;
              const newTime = l.last_attempt_time ? new Date(l.last_attempt_time).getTime() : 0;
              if (newTime <= exTime) continue;
            }
            targetMap.set(k, {
              peerType: peer.site_id === s.site_id ? "within" : "bridgehead",
              peerDc,
              namingContext: l.naming_context,
              // Round-43: emit direction so the view can render 进/出/双向.
              direction: side.direction,
              peerSite: peerSite.siteName,
              peerSiteIsHub: peerSite.isHub,
              statusCode: l.status_code,
              lastSuccessTime: toIso(l.last_success_time),
              lastAttemptTime: toIso(l.last_attempt_time),
              durationMinutes: l.duration_minutes,
              // Round-42: slice last 10 attempts.
              attempts: (historyByPair.get(`${l.source_dc}${sep}${l.dest_dc}${sep}${l.naming_context}`) || [])
                .slice(0, 10)
                .map(h => ({
                  attemptAt:        toIso(h.collected_at),
                  statusCode:       h.status_code,
                  durationMs:       h.attempt_duration_ms,
                  objectsTransferred: h.objects_transferred,
                  lastSuccessTime:  toIso(h.last_success_time),
                  errorMessage:     h.error_message
                }))
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
      logger.error({ err: e }, 'replication-log/all failed');
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
