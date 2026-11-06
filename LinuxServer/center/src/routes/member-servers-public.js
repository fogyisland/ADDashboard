// R158.77 (2026-10-11) — public read-only surface for the non-AD
// member-server fleet. Powers the `/memberServer/*` pages (首页 / OS
// 基线 / Agent 列表 / 应用端口 / 包). Mirrors osBaselineRouter +
// eventlogRouter access model: userAuth ONLY, no admin perm gate, so
// any logged-in operator reaches these pages from the topbar NoAD
// toggle (AppLayout R158.73).
//
// operator directive "用到端点就新建" 严格合规 — six NEW sibling
// endpoints (`/api/dashboard/member-*`), AD counterparts untouched.
// All read-only.
//
// 0 schema changes (R158.51 baseline freeze). Every query reuses
// existing tables: ad_member_servers, ad_agent_heartbeat,
// ad_member_server_ports, pkg_ad_os_baseline.metrics, package_runs,
// package_scripts.
import { Router } from 'express';
import { getDb } from '../db/index.js';

const DEFAULT_SINCE_HOURS = 24;
const MIN_SINCE_HOURS = 1;
const MAX_SINCE_HOURS = 168;

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n)) return dflt;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
function toIso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}
// R158.77 — "online" window. A member-server is online if its
// last_seen_at is within 5 minutes (agent heartbeat cadence).
const ONLINE_WINDOW_MIN = 5;

export function memberServersPublicRouter({ requireAuth }) {
  const r = Router();

  // Auth gate. Path-scoping mirrors osBaselineRouter (R158.29 fix) so
  // unmatched prefixes fall through to other routers instead of 401.
  r.use('/api/dashboard/member-overview', requireAuth);
  r.use('/api/dashboard/member-agents', requireAuth);
  r.use('/api/dashboard/member-os-baseline', requireAuth);
  r.use('/api/dashboard/member-os-baseline/timeseries', requireAuth);
  r.use('/api/dashboard/member-ports', requireAuth);
  r.use('/api/dashboard/member-packages-runs', requireAuth);
  // R158.78 (2026-10-12) — member-eventlog endpoints (summary + events).
  //   7th sibling endpoint, 平行 R158.77 兄弟端点. 跟 AD 端 /api/eventlog
  //   完全独立, 互不影响. Path-scoping 让 unmatched prefix fall through
  //   (R158.29 fix).
  r.use('/api/dashboard/member-eventlog', requireAuth);
  r.use('/api/dashboard/member-eventlog/summary', requireAuth);
  r.use('/api/dashboard/member-eventlog/events', requireAuth);
  // R158.86 (2026-10-12) — member-os-baseline-collector endpoints (latest +
  //   timeseries). 8th sibling endpoint, 平行 R158.78 / R158.79 兄弟.
  //   Note: distinct path prefix `member-os-baseline-collector` 避开
  //   R158.77 兄弟的 `member-os-baseline` (走 ad_os_baseline 派生数据,
  //   跟新表 ad_member_os_baseline_latest 不混). 两个 endpoint 互不覆盖.
  r.use('/api/dashboard/member-os-baseline-collector', requireAuth);
  r.use('/api/dashboard/member-os-baseline-collector/timeseries', requireAuth);
  // R158.100 (2026-10-13) — member_admin_groups endpoints (跟 member-os-baseline 1:1 平行,
  //   跟 member-os-baseline-collector 区分开, 前者 5-tile ad_os_baseline 派生, 后者 member_*).
  //   Sub-tab /memberServer/admins 用: 1 个 listByHostname (3 group 嵌套 member[]) + 1 个
  //   summary (per-hostname per-group count).
  r.use('/api/dashboard/member-admin-groups', requireAuth);
  r.use('/api/dashboard/member-admin-groups/summary', requireAuth);

  // ----------------------------------------------------------------
  // 1. GET /api/dashboard/member-overview — 首页 KPI tiles + cards
  // ----------------------------------------------------------------
  r.get('/api/dashboard/member-overview', async (_req, res) => {
    try {
      const db = getDb();
      // One round-trip join: ad_member_servers LEFT JOIN ad_sites +
      // latest heartbeat per hostname (subquery GROUP BY agent_id).
      // Counts port rows separately so the cards can show "configured
      // port count" without N+1.
      // R158.X.115 (2026-10-20) — 改走 listOnline: 退役/暂停管控的机器
      //   不进 KPI 统计 (台数、在线/离线卡片)。管理列表走 memberServers.list
      //   (全量), 这里是在线视图, 所以过滤。跟告警 detector 用同一个
      //   ONLINE_MEMBER_WHERE 谓词 (单一真源), 杜绝"告警里没有但 KPI 里有"。
      const listSpec = db.sql.memberServers.listOnline;
      const listRes = await db.query(listSpec);
      const memberRows = (Array.isArray(listRes) ? listRes : (listRes.rows ?? [])) || [];

      // Latest heartbeat per hostname. mssql uses `TOP 1 WITH TIES`
      // pattern; mysql uses correlated subquery. Pull both directly
      // — the helper is registered as `heartbeat.listByAgent` is
      // overkill for read-only, simpler to inline.
      // Both dialects use ? placeholder (rewritePlaceholders).
      // R158.87.7 (2026-10-12) — 改走 ad_member_heartbeat 真源.
      //   改前 INNER JOIN ad_agent_heartbeat 拿 member-server 字段,
      //   改后 member-server 0 写 ad_agent_heartbeat (源头修复,
      //   R158.86.6 enumerate lesson), INNER JOIN 0 行 → member-overview
      //   页面 100% 空. 改 ad_member_heartbeat 拿 agent_id/agent_version
      //   /last_heartbeat_at (5 字段 1:1 跟 ad_agent_heartbeat 平行).
      //   member 表 PK 是 hostname 但 ad_member_heartbeat 也存 agent_id
      //   (R158.79 memberUpsert 13 字段含), 0 schema 改, 0 列加.
      //   agent_type 字段恒 'non-ad' 0 滤, SQL 1:1 跟 R158.79 membersList 平行.
      const dialect = db.dialect || 'mysql';
      const latestHbSql = dialect === 'mssql'
        ? `SELECT h.hostname, h.agent_id, h.agent_version, h.last_heartbeat_at
             FROM ad_member_heartbeat h
             INNER JOIN (
               SELECT hostname, MAX(last_heartbeat_at) AS max_ts
               FROM ad_member_heartbeat
               GROUP BY hostname
             ) m ON h.hostname = m.hostname AND h.last_heartbeat_at = m.max_ts`
        : `SELECT h.hostname, h.agent_id, h.agent_version, h.last_heartbeat_at
             FROM ad_member_heartbeat h
             INNER JOIN (
               SELECT hostname, MAX(last_heartbeat_at) AS max_ts
               FROM ad_member_heartbeat
               GROUP BY hostname
             ) m ON h.hostname = m.hostname AND h.last_heartbeat_at = m.max_ts`;
      const hbRes = await db.query(latestHbSql);
      const hbRows = (Array.isArray(hbRes) ? hbRes : (hbRes.rows ?? [])) || [];
      // 2026-10-12 — R158.69.10 case-insensitive precedent. Map keys use
      // lowercase hostname so the lookup below matches regardless of
      // whether the row came from ad_member_servers (lowercase 'rv') or
      // ad_agent_heartbeat (uppercase 'RV'). Without the .toLowerCase()
      // both sides of the join never align — see KDLFLPBISRV log entry
      // 2026-10-12T04:13:12 where the centre received heartbeat
      // agent_id='KDLFLPBISRV' but self-register wrote PK
      // hostname='KDLFLPBISrv'. agent.js hasn't been the source of truth
      // for hostname casing since Node's os.hostname() returns whatever
      // GetComputerNameEx returns (operator-set, often mixed case).
      const hbByAgent = new Map();
      for (const r of hbRows) {
        // R158.87.7 (2026-10-12) — key 改走 ad_member_heartbeat.hostname
        //   PK (R158.78 域 namespace, hostname 是真 PK). 改前用 agent_id
        //   拼是为了 LEFT JOIN ad_agent_heartbeat 匹配 (R158.69.10 case
        //   教训). 改后 ad_member_heartbeat PK 已经是 hostname 直接拼.
        //   仍 .toLowerCase() 防 OS hostname 跟 member-server self-register
        //   PK 大小写不一致 (R158.69.10 lesson 跨表复用).
        const id = r.hostname || r.HOSTNAME;
        hbByAgent.set(String(id).toLowerCase(), {
          agentVersion: r.agent_version || r.AGENT_VERSION || null,
          lastHeartbeatAt: toIso(r.last_heartbeat_at || r.LAST_HEARTBEAT_AT)
        });
      }

      // Port count per hostname. Same case-insensitive key as above —
      // ad_member_server_ports.hostname uses the same casing as
      // ad_member_servers.hostname (lowercase), so the lookup must
      // normalize too. Mirrors R158.69.10 / R158.61+5 precedent.
      const portsSpec = db.sql.memberServerPorts.listAll;
      const portsRes = await db.query(portsSpec);
      const portRows = (Array.isArray(portsRes) ? portsRes : (portsRes.rows ?? [])) || [];
      const portCountByHost = new Map();
      for (const p of portRows) {
        const h = p.hostname || p.HOSTNAME;
        const k = String(h || '').toLowerCase();
        portCountByHost.set(k, (portCountByHost.get(k) || 0) + 1);
      }

      const now = Date.now();
      const onlineCutoff = now - ONLINE_WINDOW_MIN * 60 * 1000;
      const items = [];
      const totals = { total: 0, online: 0, critical: 0, warning: 0, offline: 0 };
      for (const row of memberRows) {
        const hostname = row.hostname || row.HOSTNAME;
        // 2026-10-12 — case-insensitive lookup. See the hbByAgent /
        // portCountByHost builder above for the rationale (R158.69.10
        // case-insensitive precedent). Without .toLowerCase() the
        // KDLFLPBISRV host would never resolve its heartbeat.
        const hbKey = String(hostname || '').toLowerCase();
        const hb = hbByAgent.get(hbKey) || {};
        const enabled = Number(row.enabled ?? row.ENABLED ?? 0) === 1;
        const lastSeenAt = toIso(row.last_seen_at || row.LAST_SEEN_AT);
        const lastReportAt = toIso(row.last_report_at || row.LAST_REPORT_AT);
        const lastHbAt = hb.lastHeartbeatAt;
        const lastHbMs = lastHbAt ? new Date(lastHbAt).getTime() : null;
        const online = enabled && lastHbMs != null && lastHbMs >= onlineCutoff;
        // 2026-10-12 — R158.83.1 follow-up: AgentStatusTable.vue
        //   (R140 contract) renders status via `a.secondsSinceHeartbeat`
        //   (badge: <=120 '在线' / >120 '离线'). Member-servers endpoints
        //   only emitted lastHeartbeatAt; the table therefore read
        //   `undefined` and forced every row to "stale/offline" even
        //   when the strip counters (which use lastHeartbeatAt) said
        //   online=1. Backfill the field here so the table component
        //   sees a real integer; member-agents below does the same.
        const secondsSinceHeartbeat = lastHbMs != null
          ? Math.max(0, Math.floor((now - lastHbMs) / 1000))
          : null;

        items.push({
          hostname,
          // 2026-10-12 — same agentId backfill as member-agents endpoint
          //   below. See that branch for rationale (R158.77 reused
          //   AgentStatusTable.vue which renders a.agentId).
          agentId: hostname,
          siteId: row.site_id ?? row.SITE_ID ?? null,
          siteName: row.site_name || row.SITE_NAME || null,
          ipAddress: row.ip_address || row.IP_ADDRESS || null,
          osVersion: row.os_version || row.OS_VERSION || null,
          agentType: row.agent_type || row.AGENT_TYPE || 'non-ad',
          enabled,
          discoveredAt: toIso(row.discovered_at || row.DISCOVERED_AT),
          discoveredVia: row.discovered_via || row.DISCOVERED_VIA || null,
          lastSeenAt,
          lastReportAt,
          agentVersion: hb.agentVersion || null,
          lastHeartbeatAt: lastHbAt,
          secondsSinceHeartbeat,
          portCount: portCountByHost.get(hbKey) || 0,
          online
        });
        totals.total++;
        if (online) totals.online++; else totals.offline++;
        // 'critical' / 'warning' are placeholders — OS-baseline status
        // comes from a separate endpoint (member-os-baseline). The
        // member-overview tile labels are: total / online / offline /
        // 重点关注 (hostnames never enabled OR last_seen_at NULL).
        const needsAttention = !enabled || lastSeenAt == null;
        if (needsAttention) totals.critical++;
      }

      res.json({
        ts: new Date().toISOString(),
        sinceHours: DEFAULT_SINCE_HOURS,
        items,
        totals
      });
    } catch (e) {
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----------------------------------------------------------------
  // 2. GET /api/dashboard/member-agents — Agent 列表 (heartbeats)
  // ----------------------------------------------------------------
  r.get('/api/dashboard/member-agents', async (_req, res) => {
    try {
      const db = getDb();
      // R158.X.115 — listOnline: 退役/暂停管控的机器退出 agent 列表
      //   (agent 都卸了, 心跳也停了, 留着只会显示一堆永远离线的行)。
      const listSpec = db.sql.memberServers.listOnline;
      const listRes = await db.query(listSpec);
      const memberRows = (Array.isArray(listRes) ? listRes : (listRes.rows ?? [])) || [];

      // Latest heartbeat per hostname.
      // R158.87.7 (2026-10-12) — 改走 ad_member_heartbeat 真源.
      //   跟 member-overview line ~85-101 同 precedent. member-server
      //   0 写 ad_agent_heartbeat (R158.87.7 源头修复) → 必须切真源
      //   ad_member_heartbeat. 5 字段 1:1 平行 (hostname + agent_id +
      //   agent_version + last_heartbeat_at + client_settings_version +
      //   report_requested_at).
      const dialect = db.dialect || 'mysql';
      const latestHbSql = dialect === 'mssql'
        ? `SELECT h.hostname, h.agent_id, h.agent_version, h.last_heartbeat_at,
                  h.client_settings_version, h.report_requested_at
             FROM ad_member_heartbeat h
             INNER JOIN (
               SELECT hostname, MAX(last_heartbeat_at) AS max_ts
               FROM ad_member_heartbeat
               GROUP BY hostname
             ) m ON h.hostname = m.hostname AND h.last_heartbeat_at = m.max_ts`
        : `SELECT h.hostname, h.agent_id, h.agent_version, h.last_heartbeat_at,
                  h.client_settings_version, h.report_requested_at
             FROM ad_member_heartbeat h
             INNER JOIN (
               SELECT hostname, MAX(last_heartbeat_at) AS max_ts
               FROM ad_member_heartbeat
               GROUP BY hostname
             ) m ON h.hostname = m.hostname AND h.last_heartbeat_at = m.max_ts`;
      const hbRes = await db.query(latestHbSql);
      const hbRows = (Array.isArray(hbRes) ? hbRes : (hbRes.rows ?? [])) || [];
      // 2026-10-12 — case-insensitive key (R158.69.10 precedent). See
      // member-overview builder above for rationale.
      const hbByAgent = new Map();
      for (const r of hbRows) {
        // R158.87.7 (2026-10-12) — 跟 member-overview line ~121 同 precedent.
        //   key 改走 ad_member_heartbeat.hostname PK. 0 schema 改.
        const id = r.hostname || r.HOSTNAME;
        hbByAgent.set(String(id).toLowerCase(), {
          agentVersion: r.agent_version || r.AGENT_VERSION || null,
          lastHeartbeatAt: toIso(r.last_heartbeat_at || r.LAST_HEARTBEAT_AT),
          clientSettingsVersion: r.client_settings_version || r.CLIENT_SETTINGS_VERSION || null,
          reportRequestedAt: toIso(r.report_requested_at || r.REPORT_REQUESTED_AT)
        });
      }

      const now = Date.now();
      const onlineCutoff = now - ONLINE_WINDOW_MIN * 60 * 1000;
      const items = memberRows.map((row) => {
        const hostname = row.hostname || row.HOSTNAME;
        // 2026-10-12 — case-insensitive lookup, see member-overview.
        const hb = hbByAgent.get(String(hostname || '').toLowerCase()) || {};
        const enabled = Number(row.enabled ?? row.ENABLED ?? 0) === 1;
        const lastHbMs = hb.lastHeartbeatAt ? new Date(hb.lastHeartbeatAt).getTime() : null;
        const online = enabled && lastHbMs != null && lastHbMs >= onlineCutoff;
        // 2026-10-12 — same backfill as member-overview (see that
        //   branch for full rationale). Without secondsSinceHeartbeat
        //   AgentStatusTable.vue's R140 contract reads `undefined`
        //   and stamps every row "stale/offline", conflicting with
        //   the strip counters (which use lastHeartbeatAt directly).
        const secondsSinceHeartbeat = lastHbMs != null
          ? Math.max(0, Math.floor((now - lastHbMs) / 1000))
          : null;
        return {
          hostname,
          // 2026-10-12 — R158.77 reused AgentStatusTable.vue (originally
          //   written for R140 DC agents whose row shape uses agentId).
          //   Member-server endpoint previously only emitted `hostname`,
          //   so the table's first column rendered blank — visible as
          //   "no hostname shown" against the R158.77.x contract. Mirror
          //   R158.79's heartbeat.membersList service which already uses
          //   `agentId: row.hostname` for the same component. Backfill
          //   here so both endpoints share one table component without
          //   touching AgentStatusTable (it stays R140-stable).
          agentId: hostname,
          siteId: row.site_id ?? row.SITE_ID ?? null,
          siteName: row.site_name || row.SITE_NAME || null,
          ipAddress: row.ip_address || row.IP_ADDRESS || null,
          osVersion: row.os_version || row.OS_VERSION || null,
          agentType: row.agent_type || row.AGENT_TYPE || 'non-ad',
          enabled,
          agentVersion: hb.agentVersion || null,
          clientSettingsVersion: hb.clientSettingsVersion || null,
          lastHeartbeatAt: hb.lastHeartbeatAt,
          secondsSinceHeartbeat,
          reportRequestedAt: hb.reportRequestedAt || null,
          lastSeenAt: toIso(row.last_seen_at || row.LAST_SEEN_AT),
          lastReportAt: toIso(row.last_report_at || row.LAST_REPORT_AT),
          discoveredAt: toIso(row.discovered_at || row.DISCOVERED_AT),
          discoveredVia: row.discovered_via || row.DISCOVERED_VIA || null,
          online
        };
      });

      res.json({
        ts: new Date().toISOString(),
        items,
        onlineWindowMinutes: ONLINE_WINDOW_MIN
      });
    } catch (e) {
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----------------------------------------------------------------
  // 3. GET /api/dashboard/member-os-baseline?sinceHours=24
  //    Same wire shape as /api/os-baseline but filtered to non-AD
  //    agent_ids (LEFT JOIN ad_member_servers).
  // ----------------------------------------------------------------
  r.get('/api/dashboard/member-os-baseline', async (req, res) => {
    try {
      const sinceHours = clampInt(req.query.sinceHours, MIN_SINCE_HOURS, MAX_SINCE_HOURS, DEFAULT_SINCE_HOURS);
      const db = getDb();
      // R158.99 (2026-10-13) — use member table helper (R158.86 ship
      // accidentally reused the DC helper `osBaselineMetrics.listLatestPerAgent`
      // which queries `pkg_ad_os_baseline.metrics` (cross-schema, 0 rows on
      // the member-server install). `memberOsBaseline.listLatestPerAgent` is
      // the new 1:1 mirror that hits `ad_member_os_baseline` + LEFT JOINs
      // `ad_member_servers` + `ad_sites` for site_name.
      const helper = db.sql.memberOsBaseline.listLatestPerAgent;
      const sql = typeof helper === 'function' ? helper({ sinceHours }) : helper;
      const result = await db.query(sql);
      const rows = (Array.isArray(result) ? result : (result.rows ?? [])) || [];

      // Filter: keep only rows whose agent_id appears in
      // ad_member_servers (i.e. non-AD hosts). DCs are excluded
      // because they aren't registered as member-servers. The
      // os-baseline endpoint also enriches with ad_dcs LEFT JOIN, but
      // member-servers won't have an ad_dcs row → siteName/siteId
      // stay null (mirrors OsBaselineView's "未分配" bucket pattern).
      // R158.99 — new helper SELECTs s.hostname (not s.agent_id as the DC
      // helper did), and the row already contains ad_member_servers fields
      // joined in (no separate `enabled`/`last_seen_at` lookup needed because
      // the SELECT only projects baseline metrics; siteName/siteId come from
      // the LEFT JOIN). Use hostname for the memberSet match.
      // R158.X.115 — listOnline: 退役/暂停管控的机器不出现在 os-baseline
      //   图表里 (它们已经不被监控了, 显示出来只会误导)。
      const listSpec = db.sql.memberServers.listOnline;
      const listRes = await db.query(listSpec);
      const memberRows = (Array.isArray(listRes) ? listRes : (listRes.rows ?? [])) || [];
      // R158.99.1 — case-insensitive hostname match. The member baseline
      // table stores `KDLFLPBISRV` (env COMPUTERNAME, uppercase on this
      // host) while ad_member_servers.hostname stores `KDLFLPBISrv`
      // (self-registered via os.hostname() at install time). They're
      // the same host, just different case — agent.js side and the
      // .ps1 package side report different cases for the same Windows
      // machine. Always lowercase before Set membership.
      const memberSet = new Set(
        memberRows.map(r => (r.hostname || r.HOSTNAME || '').toLowerCase()).filter(Boolean)
      );
      // R158.99.2 (2026-10-13) — 1:1 mirror AD /api/os-baseline cards
      // payload (R116/R158.30). 19 字段: agentId/ts/cpuPct/memoryPct/
      // cUsedPct/diskFree/diskTotal/services/events + biosInfo/cpuBrand/
      // memTotalBytes/disks/systemInfo/networkInfo/memoryModules/siteName/
      // siteId/enabled/lastSeenAt. Front-end MemberServerOsBaselineView
      // copies AD view 1:1; route must feed all 19 fields so the
      // hardware-detail section + per-drive list + 24h chart + 3
      // metric-info tiles (CPU 品牌/内存大小/BIOS) render identically.
      // The listLatestPerAgent helper already SELECTs s.bios_info +
      // s.cpu_brand + s.mem_total_bytes + s.disks + s.system_info +
      // s.network_info + s.memory_modules — only the map() needs to
      // surface them. siteId was previously dropped (operator: "siteid
      // 不用写") — re-added to the shape because the AD view also
      // exposes it (it just isn't visually rendered). enabled is
      // always null for member-servers (ad_member_servers.enabled
      // exists but the AD-equivalent of ad_dcs.enabled does not).
      const items = rows
        .filter(r => memberSet.has((r.hostname || r.HOSTNAME || '').toLowerCase()))
        .map(r => ({
          agentId:      r.hostname || r.HOSTNAME,
          ts:           toIso(r.collected_at || r.COLLECTED_AT),
          cpuPct:       r.cpu_pct   != null ? Number(r.cpu_pct)   : (r.CPU_PCT   != null ? Number(r.CPU_PCT)   : null),
          memoryPct:    r.memory_pct != null ? Number(r.memory_pct) : (r.MEMORY_PCT != null ? Number(r.MEMORY_PCT) : null),
          cUsedPct:     r.c_used_pct != null ? Number(r.c_used_pct) : (r.C_USED_PCT != null ? Number(r.C_USED_PCT) : null),
          diskFree:     r.disk_free  || r.DISK_FREE  || null,
          diskTotal:    r.disk_total || r.DISK_TOTAL || null,
          services:     r.services   || r.SERVICES   || null,
          events:       r.events     || r.EVENTS     || null,
          // R158.99.2 — 7 new fields, all nullable (1.0.0 member
          // agent rows have these columns as NULL until the next
          // collect.ps1 run ships the new payload).
          biosInfo:     r.bios_info     || r.BIOS_INFO     || null,
          cpuBrand:     r.cpu_brand     || r.CPU_BRAND     || null,
          memTotalBytes: r.mem_total_bytes != null ? Number(r.mem_total_bytes) : (r.MEM_TOTAL_BYTES != null ? Number(r.MEM_TOTAL_BYTES) : null),
          disks:        r.disks         || r.DISKS         || null,
          systemInfo:   r.system_info   || r.SYSTEM_INFO   || null,
          networkInfo:  r.network_info  || r.NETWORK_INFO  || null,
          memoryModules: r.memory_modules || r.MEMORY_MODULES || null,
          // site fields (joined in listLatestPerAgent).
          siteName:     r.site_name     || r.SITE_NAME     || null,
          siteId:       r.site_id       != null ? Number(r.site_id)   : (r.SITE_ID   != null ? Number(r.SITE_ID)   : null),
          // member-servers don't have an "enabled" flag like DCs do
          // (ad_dcs has no enabled column either; the AD view sets
          // enabled=null on every row). Keep null so the front-end
          // `enabled === false` branch never fires and the chip reads
          // "已启用" by default. lastSeenAt uses the same site-table
          // join key (member_servers has no last_seen_at in this
          // helper's SELECT list; leave null until the helper grows
          // a column).
          enabled:      null,
          lastSeenAt:   null
        }));

      res.json({ ts: new Date().toISOString(), sinceHours, items });
    } catch (e) {
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----------------------------------------------------------------
  // 3b. GET /api/dashboard/member-os-baseline/timeseries?hours=24
  //     Same wire as /api/os-baseline/timeseries (R158.29) but
  //     filtered to non-AD hostnames. Auto-enumerates agentIds from
  //     listLatestPerAgent window (same pattern as AD endpoint) so
  //     the chart set stays in sync with the cards endpoint.
  // ----------------------------------------------------------------
  r.get('/api/dashboard/member-os-baseline/timeseries', async (req, res) => {
    try {
      const hours = clampInt(req.query.hours, MIN_SINCE_HOURS, MAX_SINCE_HOURS, DEFAULT_SINCE_HOURS);
      const sinceMinutes = hours * 60;
      const db = getDb();

      // 1. enumerate member-server agent_ids from the same window as
      //    the cards endpoint.
      // R158.99 — switch to member-table helper (was DC helper, cross-schema 0 rows).
      const latestHelper = db.sql.memberOsBaseline.listLatestPerAgent;
      const latestSql = typeof latestHelper === 'function'
        ? latestHelper({ sinceHours: hours })
        : latestHelper;
      const latestResult = await db.query(latestSql);
      const latestRows = (Array.isArray(latestResult) ? latestResult : (latestResult.rows ?? [])) || [];

      // Filter to non-AD (member-server) hostnames.
      // R158.X.115 — listOnline: 同上, 退役/暂停的机器不进这个视图。
      const memberListSpec = db.sql.memberServers.listOnline;
      const memberListRes = await db.query(memberListSpec);
      const memberRows = (Array.isArray(memberListRes) ? memberListRes : (memberListRes.rows ?? [])) || [];
      // R158.99.1 — case-insensitive (see same comment in cards endpoint above).
      const memberSet = new Set(
        memberRows.map(r => (r.hostname || r.HOSTNAME || '').toLowerCase()).filter(Boolean)
      );

      const agentIds = Array.from(new Set(
        latestRows
          .map((r) => r.hostname || r.HOSTNAME)
          .filter((h) => typeof h === 'string' && h.length > 0
            && memberSet.has(h.toLowerCase()))
      ));

      // R158.100.7 (2026-10-13) — root cause was step 2's `tsDict[db.dialect]`
      // double-deref returning undefined. The flat helper pattern
      // (post-buildSql spread) is `db.sql.<domain>.<query>` directly, not
      // `db.sql.<domain>.<query>[db.dialect]`. See probe-r158-100-7-route-exact.mjs.

      if (agentIds.length === 0) {
        return res.json({
          ts: new Date().toISOString(),
          hours,
          bucketMinutes: 5,
          agentCount: 0,
          sampleCount: 0,
          seriesByAgent: {}
        });
      }

      // 2. fetch raw rows for the window.
      // R158.99 — switch to member-table timeseries helper (was DC helper
      // `osBaselineTimeseries` which queries `pkg_ad_os_baseline.metrics`).
      // Member helper returns {sql, params} (not interpolated string),
      // so the .filter(r => Number.isFinite) below needs r.hostname not
      // r.agent_id (we project s.hostname from ad_member_os_baseline).
      //
      // R158.100.7 (2026-10-13) — drop the `tsDict && tsDict[db.dialect]`
      // indirection. The DC endpoint (`/api/os-baseline/timeseries`,
      // routes/os-baseline.js:246-250) keeps it because `db.sql.osBaselineTimeseries`
      // is still registered as a {mysql, mssql} DICT (R158.29 precedent —
      // the registry spread would clobber it). For `db.sql.memberOsBaseline`,
      // buildSql() spreads the inner `{mysql, mssql}` object into the parent
      // namespace, so `db.sql.memberOsBaseline.listTimeseriesByAgent` is
      // already the dialect-shaped FUNCTION — there is no `.mssql` key under
      // it. The double-deref returned undefined and step 2 silently fell
      // into the `: []` branch, which is why `sampleCount` was 0 despite
      // the helper itself returning 38 rows (verified in
      // scripts/probe-r158-100-7-route-exact.mjs).
      const tsHelper = db.sql.memberOsBaseline.listTimeseriesByAgent;
      const tsSpec = typeof tsHelper === 'function'
        ? tsHelper({ agentIds, sinceMinutes })
        : tsHelper;
      const result = tsSpec && tsSpec.sql
        ? await db.query(tsSpec.sql, tsSpec.params)
        : [];
      const rows = (Array.isArray(result) ? result : (result.rows ?? [])) || [];

      // 3. bucket into 5-min windows (mirrors /api/os-baseline/timeseries).
      // R158.99 — member helper SELECTs s.hostname + s.collected_at (not
      // r.agent_id + r.ts like the DC helper). Use both casings.
      // R158.99.1 — lowercase the bucket key so it matches the memberSet
      // casing in step 1 (otherwise `seriesByAgent[agentId]` keys diverge
      // from the agentIds the frontend already normalised).
      const bucketSizeMs = 5 * 60 * 1000;
      const epochStart = Date.now() - hours * 3600 * 1000;
      const bucketsByAgent = new Map();
      for (const r of rows) {
        const host = r.hostname || r.HOSTNAME;
        const tsRaw = r.collected_at || r.COLLECTED_AT || r.ts || r.TS;
        const tsMs = tsRaw instanceof Date ? tsRaw.getTime() : new Date(tsRaw).getTime();
        if (!Number.isFinite(tsMs) || tsMs < epochStart) continue;
        const b = Math.floor((tsMs - epochStart) / bucketSizeMs) * bucketSizeMs + epochStart;
        let m = bucketsByAgent.get(host);
        if (!m) { m = new Map(); bucketsByAgent.set(host, m); }
        let slot = m.get(b);
        if (!slot) {
          slot = { cpuSum: 0, cpuN: 0, memSum: 0, memN: 0 };
          m.set(b, slot);
        }
        const cpu = Number(r.cpu_pct != null ? r.cpu_pct : r.CPU_PCT);
        if (Number.isFinite(cpu)) { slot.cpuSum += cpu; slot.cpuN++; }
        const mem = Number(r.memory_pct != null ? r.memory_pct : r.MEMORY_PCT);
        if (Number.isFinite(mem)) { slot.memSum += mem; slot.memN++; }
      }

      // 4. materialise seriesByAgent with sparse arrays + forward-fill.
      const seriesByAgent = {};
      for (const [agentId, m] of bucketsByAgent.entries()) {
        const cpu = [];
        const memory = [];
        let lastCpu = null;
        let lastMem = null;
        for (let t = epochStart; t <= Date.now(); t += bucketSizeMs) {
          const slot = m.get(t);
          if (slot) {
            if (slot.cpuN > 0) { lastCpu = slot.cpuSum / slot.cpuN; }
            if (slot.memN > 0) { lastMem = slot.memSum / slot.memN; }
          }
          if (lastCpu != null) cpu.push({ ts: new Date(t).toISOString(), value: Number(lastCpu.toFixed(2)) });
          if (lastMem != null) memory.push({ ts: new Date(t).toISOString(), value: Number(lastMem.toFixed(2)) });
        }
        seriesByAgent[agentId] = { cpu, memory };
      }

      res.json({
        ts: new Date().toISOString(),
        hours,
        bucketMinutes: 5,
        agentCount: agentIds.length,
        sampleCount: rows.length,
        seriesByAgent
      });
    } catch (e) {
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----------------------------------------------------------------
  // 4. GET /api/dashboard/member-ports — 应用端口
  //    Reuses memberServerPortsService.listAll (R158.74).
  // ----------------------------------------------------------------
  r.get('/api/dashboard/member-ports', async (req, res) => {
    try {
      const db = getDb();
      // Inline SQL (same as memberServerPorts.listAll) — the helper
      // is registered, no need to import the service.
      const spec = db.sql.memberServerPorts.listAll;
      const result = await db.query(spec);
      const rows = (Array.isArray(result) ? result : (result.rows ?? [])) || [];
      const baseItems = rows.map(r => ({
        hostname: r.hostname || r.HOSTNAME,
        port: Number(r.port ?? r.PORT ?? 0),
        serviceType: r.service_type || r.SERVICE_TYPE || null,
        note: r.note || r.NOTE || null,
        // R158.89 — updatedAt 优先用 probe_at (15min cadence 周期 probe
        //   写回 DB 的时间戳), 跟 R158.89 startMemberPortProbeScheduler
        //   1:1 闭合. 前端 /memberServer/ports 看到"更新事件" 15min 1 刷.
        //   老 admin upsert 时间 (SQL updated_at) 保留为 fallback —
        //   0 改 admin CRUD, 跟 R158.74 1:1 平行. Pre-R158.89 fleet
        //   probe_at 全 NULL → fallback updated_at (跟 R158.48 1:1 平行).
        updatedAt: toIso(r.probe_at || r.PROBE_AT || r.updated_at || r.UPDATED_AT),
        // R158.89 — 同时返 probe 3 字段, 前端 0 改可选择性显示.
        probeStatus: r.probe_status || r.PROBE_STATUS || null,
        probeLatencyMs: r.probe_latency_ms ?? r.PROBE_LATENCY_MS ?? null,
        probeAt: toIso(r.probe_at || r.PROBE_AT)
      }));
      // R158.84 — live probe each registered (host, port) via
      // centre-initiated net.Socket. Optional ?timeoutMs query
      // overrides the 2 s default; clamped to [100, 10000] so
      // a typo can't make the endpoint hang for 30 s.
      const rawTimeout = Number(req.query.timeoutMs);
      const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
        ? Math.min(10_000, Math.max(100, rawTimeout))
        : 2_000;
      const { probeMemberServerPorts } = await import('../services/member-server-port-probe.js');
      const items = await probeMemberServerPorts(baseItems, { timeoutMs });
      res.json({ ts: new Date().toISOString(), items, probeTimeoutMs: timeoutMs });
    } catch (e) {
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----------------------------------------------------------------
  // 5. GET /api/dashboard/member-packages-runs?window=24h|7d|all
  //    Mirror /api/dashboard/packages-runs (R158.76) but scripts
  //    pre-filtered to agentType='non-ad'. Same envelope shape.
  // ----------------------------------------------------------------
  r.get('/api/dashboard/member-packages-runs', async (req, res) => {
    try {
      const windowMode = String(req.query.window || '24h');
      if (!['24h', '7d', 'all'].includes(windowMode)) {
        return res.status(400).json({ error: 'window must be one of: 24h, 7d, all' });
      }
      let sinceMs;
      if (windowMode === '24h') sinceMs = 24 * 3600 * 1000;
      else if (windowMode === '7d') sinceMs = 7 * 24 * 3600 * 1000;
      else sinceMs = 10 * 24 * 3600 * 1000; // 'all' = 10d retention upper bound
      const cutoff = new Date(Date.now() - sinceMs);
      const windowLabel = windowMode === '24h' ? '24 小时' : windowMode === '7d' ? '7 天' : '全部';

      const db = getDb();
      const { packageScripts } = await import('../db/sql/package-scripts.js');
      const { packageRuns } = await import('../db/sql/package-runs.js');

      const scripts = await packageScripts.list(db);
      scripts.sort((a, b) => a.name.localeCompare(b.name));
      // Filter to non-AD packages only AND drop `ad_`-prefixed names.
      // R158.86 (2026-10-12) — operator directive: "member server
      //   会独立发包, 不用 ad_ 前缀". ad_-prefixed packages
      //   (ad_member_port_latency 1.0.0 RETIRED per R158.86 delete,
      //    ad_os_baseline 1.0.7) keep their package_scripts row +
      //   pkg_ad_* schema (AD fleet still needs ad_os_baseline) —
      //   but they no longer appear on the member-server packages
      //   tab. New member-only lineage uses no `ad_` prefix
      //   (member_eventlog_collector 1.0.0, member_os_baseline_collector
      //   1.0.0, future pkg_ms_* / etc).
      const nonAdScripts = scripts.filter(s => {
        const t = (s.manifest?.agent?.type || 'ad');
        if (t !== 'non-ad') return false;
        if (String(s.name || '').startsWith('ad_')) return false;
        return true;
      });

      // R158.99.3 (2026-10-13) — flip from packageRuns.summary24hByName
      // (AD-side, NOT IN ad_member_heartbeat) to the new
      // memberSummary24hByName sibling (IN ad_member_heartbeat). The
      // member endpoint MUST project only member rows; using the AD
      // helper excluded every member row from the projection, leaving
      // summary24h total=0 for every non-ad package. Operator report
      // 2026-10-13: "包执行状态为什么没有反馈到成员服务器l的包执行状态
      // 中?". Same flip applies to recentByName below.
      const summaryRows = await packageRuns.memberSummary24hByName(db, { since: cutoff });
      const summaryByName = new Map();
      for (const row of summaryRows || []) {
        summaryByName.set(row.package_name || row.PACKAGE_NAME, {
          total: Number(row.total ?? 0),
          success: Number(row.success ?? 0),
          partial: Number(row.partial ?? 0),
          failure: Number(row.failure ?? 0),
          lastRunAt: row.last_run_at || row.LAST_RUN_AT || null
        });
      }

      const recentByName = new Map();
      for (const s of nonAdScripts) {
        try {
          const rows = await packageRuns.memberRecentByName(db, { packageName: s.name, limit: 10, since: cutoff });
          recentByName.set(s.name, rows || []);
        } catch (_e) {
          recentByName.set(s.name, []);
        }
      }

      // R158.X+UI.timeline (2026-10-19) — 折线图 24h 全量 data 源.
      // 跟 recent 1:1 平行, 但 limit 默认 1000 (timelineLimit),
      // 独立于 recentLimit (默认 10). 1:1 平行 AD 端
      // (dashboard.js:2071-2095) 范式. 包 24h cadence 上限 ≈ 96 次
      // (15min cadence), 7d 全部 cadence = 672, 1000 上限 100% 闭合.
      const timelineByName = new Map();
      for (const s of nonAdScripts) {
        try {
          const rows = await packageRuns.memberRecentByName(db, { packageName: s.name, limit: 1000, since: cutoff });
          timelineByName.set(s.name, rows || []);
        } catch (_e) {
          timelineByName.set(s.name, []);
        }
      }

      const packages = nonAdScripts.map((s) => {
        const summary = summaryByName.get(s.name) || { total: 0, success: 0, partial: 0, failure: 0, lastRunAt: null };
        const runs = recentByName.get(s.name) || [];
        const timelineRuns = timelineByName.get(s.name) || [];
        const manifest = s.manifest || {};
        return {
          name: s.name,
          version: s.version,
          type: manifest.type || 'gauge',
          agentType: manifest.agent?.type || 'non-ad',
          description: manifest.description || '',
          summary24h: {
            total: summary.total,
            success: summary.success,
            failure: summary.failure,
            partial: summary.partial,
            lastRunAt: summary.lastRunAt
              ? (summary.lastRunAt instanceof Date
                  ? summary.lastRunAt.toISOString()
                  : new Date(summary.lastRunAt).toISOString())
              : null
          },
          recent: runs.slice(0, 10).map((r) => ({
            id: r.id,
            agentId: r.agent_id,
            startedAt: toIso(r.started_at),
            finishedAt: toIso(r.finished_at),
            exitCode: r.exit_code,
            status: r.status || null,
            durationMs: (r.started_at && r.finished_at)
              ? Math.max(0, new Date(r.finished_at).getTime() - new Date(r.started_at).getTime())
              : null,
            stdoutPreview: r.stdout_preview || null,
            stderrPreview: r.stderr_preview || null,
            error: r.error || null,
            scriptVersion: r.script_version || s.version || null
          })),
          // R158.X+UI.timeline (2026-10-19) — 折线图 24h 全量 data 源.
          // 跟 recent 1:1 平行 shape, 走 timelineByName (默认 limit=1000).
          // 老 caller 不读 (ignored), 新前端 (PackageRunsMonitorView
          // buildTimelineSeries) 读 timelineRecent 渲折线图. 卡片
          // summary + 抽屉 L1 仍走 recent (limit 切片 10).
          timelineRecent: timelineRuns.map((r) => ({
            id: r.id,
            agentId: r.agent_id,
            startedAt: toIso(r.started_at),
            finishedAt: toIso(r.finished_at),
            exitCode: r.exit_code,
            status: r.status || null,
            durationMs: (r.started_at && r.finished_at)
              ? Math.max(0, new Date(r.finished_at).getTime() - new Date(r.started_at).getTime())
              : null,
            stdoutPreview: r.stdout_preview || null,
            stderrPreview: r.stderr_preview || null,
            error: r.error || null,
            scriptVersion: r.script_version || s.version || null
          }))
        };
      });

      res.json({
        refreshSeconds: 10,
        window: windowMode,
        windowLabel,
        // R158.X+UI.timeline — 折线图 limit echo, 1:1 平行 AD 端
        // (dashboard.js:2160+timelineLimit 字段)
        timelineLimit: 1000,
        packages
      });
    } catch (e) {
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----------------------------------------------------------------
  // 6. GET /api/dashboard/member-eventlog/summary?sinceHours=24
  //    R158.78 (2026-10-12) — member-server 事件日志 channel 计数矩阵.
  //    3 通道 (Application / System / Security). 跟 DC 端
  //    /api/eventlog/summary (R112) 平行但独立: 字段 hostname 不用
  //    dc_name, LEFT JOIN 走 ad_member_servers + ad_sites (member-server
  //    走 site_id, 跟 R158.77 兄弟 endpoint 同 precedent).
  // ----------------------------------------------------------------
  r.get('/api/dashboard/member-eventlog/summary', async (req, res) => {
    try {
      const sinceHours = clampInt(req.query.sinceHours, MIN_SINCE_HOURS, MAX_SINCE_HOURS, DEFAULT_SINCE_HOURS);
      const db = getDb();
      const built = db.sql.memberEventlog.latestSummary({ sinceHours });
      const result = await db.query(built.sql, built.params);
      const rows = (Array.isArray(result) ? result : (result.rows ?? [])) || [];
      const items = rows.map((r) => ({
        hostname:            r.hostname            || r.HOSTNAME,
        channel:             r.channel             || r.CHANNEL,
        warningCount:        Number(r.warning_count  ?? r.WARNING_COUNT  ?? 0),
        errorCount:          Number(r.error_count    ?? r.ERROR_COUNT    ?? 0),
        auditFailureCount:   Number(r.audit_failure_count ?? r.AUDIT_FAILURE_COUNT ?? 0),
        droppedCount:        Number(r.dropped_count  ?? r.DROPPED_COUNT  ?? 0),
        collectedAt:         toIso(r.collected_at || r.COLLECTED_AT),
        siteId:              r.site_id ?? r.SITE_ID ?? null,
        siteName:            r.site_name || r.SITE_NAME || null
      }));
      res.json({ ts: new Date().toISOString(), sinceHours, items });
    } catch (e) {
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----------------------------------------------------------------
  // 7. GET /api/dashboard/member-eventlog/trend?sinceHours=24
  //    R158.101 (2026-10-13) — 24h hourly event log trend for the
  //    /memberServer/eventlog line chart. 3 channel × 24 hour bucket ×
  //    COUNT(*). Mirrors /api/eventlog/trend (R158.54 eventlogRouter:175)
  //    shape but 走 ad_member_eventlog_events (member spec) 0 走
  //    ad_eventlog_events. sinceHours clamp [1,168] 跟 summary endpoint
  //    同 shape (R158.77 MAX_SINCE_HOURS=168). sinceHours > 24 自动
  //    clamp 到 24 (跟 AD 端 R158.54 TREND_HOURS=24 同 precedent).
  // ----------------------------------------------------------------
  r.get('/api/dashboard/member-eventlog/trend', async (req, res) => {
    try {
      const sinceHours = clampInt(req.query.sinceHours, MIN_SINCE_HOURS, MAX_SINCE_HOURS, 24);
      const TREND_HOURS = 24;
      const hours = Math.min(sinceHours, TREND_HOURS);
      const db = getDb();
      const memberEventlogService = await import('../services/member-eventlog.js');
      const items = await memberEventlogService.trend24h(db, { hours }, req.log);
      res.json({ ts: new Date().toISOString(), sinceHours: hours, items });
    } catch (e) {
      req.log?.error?.({ event: 'member_eventlog.trend_failed', err: e?.message || String(e) }, 'member-eventlog trend read failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----------------------------------------------------------------
  // 8. GET /api/dashboard/member-eventlog/events?hostname=&channel=&sinceHours=&limit=&severity=
  //    R158.78 — member-server 事件日志明细 drill-down. 跟 DC 端
  //    /api/eventlog/events 平行, 但 query 用 hostname 不是 dc.
  //    severity 跟 auditOnly 跟 R112 端同 shape.
  // ----------------------------------------------------------------
  r.get('/api/dashboard/member-eventlog/events', async (req, res) => {
    try {
      const hostname  = String(req.query.hostname  || '').trim();
      const channel   = String(req.query.channel   || '').trim();
      const severity  = req.query.severity ? String(req.query.severity).trim() : null;
      const auditOnly = String(req.query.auditOnly || '').toLowerCase() === 'true';
      if (!hostname || !channel) {
        return res.status(400).json({ error: 'hostname and channel are required' });
      }
      // Whitelist channel to the 3 R158.78-supported member-server channels.
      // Mirrors eventlogRouter CHANNEL_KEYS pattern (R112 / R154) — guards
      // against `channel=__proto__` style injection.
      const ALLOWED_CHANNELS = new Set(['Application', 'System', 'Security']);
      if (!ALLOWED_CHANNELS.has(channel)) {
        return res.status(400).json({ error: `channel must be one of: ${Array.from(ALLOWED_CHANNELS).join(', ')}` });
      }
      const sinceHours = clampInt(req.query.sinceHours, MIN_SINCE_HOURS, MAX_SINCE_HOURS, DEFAULT_SINCE_HOURS);
      const limit      = clampInt(req.query.limit, 1, 200000, 200);
      const db = getDb();
      const built = db.sql.memberEventlog.queryEvents({ hostname, channel, severity, sinceHours, limit, auditOnly });
      const result = await db.query(built.sql, built.params);
      const rows = (Array.isArray(result) ? result : (result.rows ?? [])) || [];
      const items = rows.map((r) => ({
        collectedAt:  toIso(r.collected_at || r.COLLECTED_AT),
        hostname:     r.hostname   || r.HOSTNAME,
        channel:      r.channel    || r.CHANNEL,
        severity:     r.severity   || r.SEVERITY,
        eventId:      Number(r.event_id  ?? r.EVENT_ID  ?? 0),
        recordId:     Number(r.record_id ?? r.RECORD_ID ?? 0),
        message:      r.message     || r.MESSAGE     || null,
        ts:           toIso(r.ts || r.TS),
        auditFailure: Number(r.audit_failure ?? r.AUDIT_FAILURE ?? 0)
      }));
      res.json({
        ts: new Date().toISOString(),
        hostname,
        channel,
        sinceHours,
        limit,
        items
      });
    } catch (e) {
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----------------------------------------------------------------
  // 9. GET /api/dashboard/member-os-baseline-collector/summary?hostname=
  //    R158.86 (2026-10-12) — first paint of /memberServer "OS 基线" tab
  //    driven by ad_member_os_baseline_latest. Single row per hostname.
  //    Mirrors R158.78 latestSummary shape but with 5 metric fields
  //    (cpu_pct / memory_pct / c_used_pct / disk_free_bytes / services_count).
  // ----------------------------------------------------------------
  // R158.86 — `/summary` 跟 `/timeseries` 子端点, 字典序 timeseries 在前
  //   (R158.74.4 lesson: Express 顺序匹配, 子路径必须早于父路径注册).
  r.get('/api/dashboard/member-os-baseline-collector/timeseries', async (req, res) => {
    try {
      const { hostname, hours, limit } = req.query;
      if (!hostname) {
        return res.status(400).json({ error: 'hostname query param required' });
      }
      const safeHours = Math.max(1, Math.min(168, Number.parseInt(hours, 10) || 24)); // 7d max
      const safeLimit = Math.max(1, Math.min(2000, Number.parseInt(limit, 10) || 500));
      const db = getDb();
      const memberOsBaselineService = await import('../services/member-os-baseline.js');
      const items = await memberOsBaselineService.getTimeseries(db, {
        hostname: String(hostname),
        hours:    safeHours,
        limit:    safeLimit
      });
      res.json({
        hostname,
        hours:  safeHours,
        limit:  safeLimit,
        count:  items.length,
        items
      });
    } catch (e) {
      res.status(500).json({ error: 'internal' });
    }
  });

  r.get('/api/dashboard/member-os-baseline-collector/summary', async (req, res) => {
    try {
      const { hostname } = req.query;
      if (!hostname) {
        return res.status(400).json({ error: 'hostname query param required' });
      }
      const db = getDb();
      const memberOsBaselineService = await import('../services/member-os-baseline.js');
      const item = await memberOsBaselineService.getLatest(db, {
        hostname: String(hostname)
      });
      if (!item) {
        return res.json({ hostname, item: null, hint: 'no data yet — wait for first run' });
      }
      res.json({ hostname, item });
    } catch (e) {
      res.status(500).json({ error: 'internal' });
    }
  });

  // R158.100 (2026-10-13) — member_admin_groups main list endpoint.
  //   ?hostname= 可选 (omit → 返全部 hostname × 3 group × N member; 跟
  //   member-os-baseline listLatestPerAgent 同 1:1 平行 shape).
  //   返 rows 包含 hostname/group_name/member_sid/member_name/member_class/
  //   principal_source/is_enabled/display_name/collected_at. Case-insensitive
  //   hostname filter (R158.99.1 lesson 1:1 闭合) 走 service layer.
  r.get('/api/dashboard/member-admin-groups', async (req, res) => {
    try {
      const { hostname } = req.query;
      const db = getDb();
      const memberAdminGroupsService = await import('../services/member-admin-groups.js');
      if (hostname) {
        // 1 host detail: 返 3 group × N member flattened rows
        const rows = await memberAdminGroupsService.listByHostname(db, hostname);
        return res.json({ hostname: String(hostname).toLowerCase(), rows, hint: rows.length === 0 ? 'no data yet — wait for first run (24h cadence)' : null });
      }
      // 全部 host × 3 group per-hostname summary
      const summary = await memberAdminGroupsService.getSummary(db);
      res.json({ summary, hint: summary.length === 0 ? 'no data yet — wait for first run' : null });
    } catch (e) {
      res.status(500).json({ error: 'internal' });
    }
  });

  // R158.100 — member_admin_groups per-(hostname, group_name) drill-down.
  //   前端 MemberAdminGroupsTable 主表用. R158.99.3 lesson 闭合: 1 endpoint 1 service method.
  r.get('/api/dashboard/member-admin-groups/summary', async (req, res) => {
    try {
      const { hostname, group } = req.query;
      if (!hostname || !group) {
        return res.status(400).json({ error: 'hostname and group query params required' });
      }
      const db = getDb();
      const memberAdminGroupsService = await import('../services/member-admin-groups.js');
      const rows = await memberAdminGroupsService.listByGroup(db, hostname, group);
      res.json({ hostname: String(hostname).toLowerCase(), group, rows, hint: rows.length === 0 ? 'no data yet — wait for first run' : null });
    } catch (e) {
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}