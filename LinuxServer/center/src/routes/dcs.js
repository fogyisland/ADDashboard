import { Router } from 'express';
import { getDb } from '../db/index.js';

// GET /api/dcs/summary?siteId=N
//   - Returns one row per DC. Sources counters from the public ad_dc_overview
//     table (R110.A — dedicated "公共表", no longer the __dc_summary__ self-loop
//     on ad_replication_status). lockedCount comes from the ad_lockout_summary
//     v2 package's pkg_ad_lockout_summary.metrics table (R110.B — already
//     shipped via R107/R107.1, no new code path).
//   - If siteId is missing/empty/non-numeric -> returns all DCs (no filter).
//   - If siteId is a positive integer -> filters by ad_dcs.site_id = siteId.
//   - Sorted by dcHost ASC.
//   - inboundPartnersCount / outboundPartnersCount = inbound (`dest_dc = dc`)
//     and outbound (`source_dc = dc`) replication_status row counts for
//     the DC within ±WINDOW_MINUTES of this overview row's collected_at
//     (cheap same-cycle approximation, same as the previous
//     implementation). Replaces the old single-direction `partnersCount`
//     in R151.3 so DcCard.vue can render both tiles without aligning to
//     a particular direction.
//   - Auth: REQUIRES login (any user), NO admin perm gate (R117 — 前台
//     公共页面 范式: operator sidebar `服务器总览` 是普通用户可见的
//     "我们不需要在admin后台看到" 页面,跟 R112 eventlog + R116
//     os-baseline 一致 — 登录即可访问,不再强制 admin:users. 修前的
//     bug: 普通用户访问 /servers-overview → 403 → 前端 catch → 显示
//     "暂无 DC 数据" 空态文案,让 operator 误以为 agent 没上报,实际
//     是 perm gate 把请求拦掉了).

// R151.3.B window — agents push ad_partner_ports_probe every ~30 min, so a
// 5-min window (the previous value) almost always misses the latest row
// and shows 0/0 for the agent's own DC. Sweep 2026-09-29 across 34 DCs:
// at 5 min, 14 DCs are 0/0 (operator-visible ghost-cards); at 30 min,
// 0 DCs are 0/0 and the inbound/outbound numbers stabilize. 30 min also
// matches the package's own collection cadence so a "fresh" row at the
// ad_replication_status layer always lands inside the window.
const WINDOW_MINUTES = 30;

// ad_lockout_summary v2 package — column whitelist fed to
// db.sql.metricstore.latestPerAgent. Keep in sync with the package manifest's
// metricSchema (data/packages/ad_lockout_summary/1.0.0/manifest.json).
const LOCKOUT_SCHEMA = 'pkg_ad_lockout_summary';
const LOCKOUT_COLUMNS = ['locked_count', 'error_code'];

export function dcsRouter({ requireAuth, requirePerm }) {
  const r = Router();
  // R117 — /api/dcs/summary is now a 公共端点 (any logged-in user,
  // no admin perm). The router still accepts requirePerm for symmetry
  // with other dcs-style callers, but the summary endpoint does NOT
  // apply it (only requireAuth).
  const authSummary = [requireAuth];

  r.get('/api/dcs/summary', ...authSummary, async (req, res) => {
    try {
      const db = getDb();

      const siteIdRaw = req.query.siteId;
      // Treat empty / missing / non-numeric as "all sites". Reject only if a
      // value is present but isn't a positive integer.
      const siteId =
        siteIdRaw === undefined || siteIdRaw === '' || siteIdRaw === null
          ? null
          : Number(siteIdRaw);
      if (siteId !== null && (!Number.isInteger(siteId) || siteId <= 0)) {
        return res.status(400).json({ error: 'siteId must be a positive integer' });
      }

      // R110.A — overview counters (users / groups / gpos + partner_port_status)
      // now sourced from the dedicated public ad_dc_overview table. The helper
      // is function-form so the 24h window is bound as a single parameter
      // (R93.4 / R101 dialect-portable convention).
      const overviewBuilt = db.sql.dcOverview.latestPerDc({ sinceHours: 24 });
      const { rows } = await db.query(overviewBuilt.sql, overviewBuilt.params);

      // R110.B — lockedCount sourced from the ad_lockout_summary v2 package's
      // pkg_ad_lockout_summary.metrics table. Same 15-minute cadence as the
      // overview so the joined row is same-cycle. Errors here must NOT fail
      // the whole summary (best-effort: log + fall back to null lockedCount).
      // R107/R107.1 already shipped the ETL — this is just the read path.
      let lockedByAgent = new Map();
      try {
        const lockoutBuilt = db.sql.metricstore.latestPerAgent({
          schemaName: LOCKOUT_SCHEMA,
          columns: LOCKOUT_COLUMNS
        });
        const { rows: lockoutRows } = await db.query(lockoutBuilt.sql, lockoutBuilt.params);
        lockedByAgent = new Map(
          lockoutRows.map(r => [r.agent_id, r.locked_count ?? null])
        );
      } catch (e) {
        req.log?.error?.({
          event: 'dcs.summary.lockout_read_failed',
          err: e?.message || String(e),
          schemaName: LOCKOUT_SCHEMA
        }, 'failed to source lockedCount from ad_lockout_summary — falling back to null');
      }

      // 2nd pass: look up siteName + siteId for each DC by hostname.
      // We do it in a single IN-keyed query rather than N+1.
      const dcHosts = rows.map((r) => r.dc_name);
      let dcRows = [];
      if (dcHosts.length > 0) {
        const placeholders = dcHosts.map(() => '?').join(',');
        const dcsRes = await db.query(
          `SELECT d.dc_name AS dcHost, s.site_name AS siteName, d.site_id AS siteId
             FROM ad_dcs d LEFT JOIN ad_sites s ON d.site_id = s.site_id
            WHERE d.dc_name IN (${placeholders})`,
          dcHosts
        );
        dcRows = dcsRes.rows;
      }

      const siteMap = new Map(dcRows.map((d) => [d.dcHost, d]));
      const out = [];
      for (const row of rows) {
        const meta = siteMap.get(row.dc_name);
        // R151.3.B — filter out "ghost" DCs from ad_dc_overview that are
        // NOT registered in ad_dcs (the catalogue). Operator feedback
        // 2026-09-29: ghost DCs rendered as cards with 0 partners, which
        // looks like a bug but actually means "this DC has never been a
        // real AD domain controller" — its overview row is a stale entry
        // left behind by a removed/retired host. Real AD DCs are always
        // in ad_dcs (the catalogue is populated by ad_dc_overview's own
        // upsertDc path or by manual admin assign), so absence from
        // ad_dcs = ghost, and we don't surface ghosts in the UI.
        if (!meta) continue;
        if (siteId !== null && meta.siteId !== siteId) continue;
        // agent_id in ad_dc_overview equals dc_name (collect.ps1 stamps both
        // from $env:COMPUTERNAME), so the lookup key is row.dc_name itself.
        // Falls back to null if the lockout read failed or no row exists
        // for this DC yet (e.g. ad_lockout_summary hasn't run for this host).
        out.push({
          dcHost: row.dc_name,
          siteName: meta?.siteName ?? null,
          // R151.3 — DcCard now shows BOTH directions separately to align
          // with R144 dashboard (inbound) and R151.2 agent endpoint.
          // partnersCount (the old single-direction OUTBOUND counter) is
          // gone; operators read these two columns on the card.
          inboundPartnersCount: 0,   // populated below — dest_dc = me
          outboundPartnersCount: 0,  // populated below — source_dc = me
          usersCount: row.users_count,
          // R158.44.7.8 (2026-10-05) — operator directive "DC overview 显示
          // 用户、电脑、服务器数量". computers_count + servers_count from
          // collect.ps1 Get-ADComputer (filtered by OperatingSystem=*Server*
          // for servers). NULL tolerated while 34 agents roll out the new
          // collect.ps1 (DcsCatalogView already formats null as "—").
          computersCount: row.computers_count ?? null,
          serversCount:   row.servers_count   ?? null,
          groupsCount: row.groups_count,
          gposCount: row.gpos_count,
          lockedCount: lockedByAgent.get(row.dc_name) ?? null,
          collectedAt: row.collected_at
        });
      }

      // Count replication partners per DC from the same cycle (within
      // WINDOW_MINUTES of this overview row's collected_at). Cheap and good
      // enough — we don't need exact same-tick matching. SQL is
      // dialect-aware via the db.sql.replication registry (MySQL uses
      // INTERVAL, MSSQL uses DATEADD).
      //
      // R151.3 — single-query both-direction count. 8-parameter bind:
      //   [dest_dc_self,  source_dc_self,  dest_dc_or_source,  source_dc_or_dest,
      //    windowMin, collectedAt, windowMin, collectedAt]
      // — the first two parameters drive the SUM(CASE WHEN …) columns;
      // the third + fourth feed the OR-clause; the last four bound the
      // collected_at time window (same shape as the legacy partnersCount
      // so behaviour stays consistent with the previous implementation).
      //
      // R158.scanfix-H6 (2026-10-20) — 这段从"逐 DC 串行 N+1"改成"一次查全站".
      //
      // 旧实现的问题: 上面的 for 循环对每张卡片发一次 partnersCountBoth,
      // 34 台 DC = 34 次串行 round-trip, 实测端点 611ms. 每次都要重新
      // 扫 ad_replication_status 并重算 latest-per-pair.
      //
      // 新实现 partnersCountBothAll: 一条 GROUP BY 查询拿全站计数, 再在
      // JS 侧 Map 查表. 34 次串行 → 1 次, 期望 611ms → 数十 ms.
      //
      // ⚠ 语义变化(必须知情, 详见 sql.js partnersCountBothAll 注释):
      // 旧 helper 用每台 DC **自己的** card.collectedAt 绑定时间窗, 各台
      // 基准不同; 新 helper 用**全站最新** collected_at 作统一基准.
      // 正常部署(各 DC 采集节奏一致, collected_at 相差 < 一个周期)结果
      // 完全一致; 某台 DC 长期掉线时行为会不同 —— 旧实现拿它的陈旧快照
      // 当现状, 新实现按全站最新基准(这更符合"伙伴关系"语义).
      const partnersRes = await db.query(
        db.sql.replication.partnersCountBothAll,
        [WINDOW_MINUTES, WINDOW_MINUTES]
      );
      const partnerCounts = new Map(
        (partnersRes.rows || []).map(r => [
          r.dc,
          {
            inbound:  Number(r.inbound_count  ?? 0),
            outbound: Number(r.outbound_count ?? 0)
          }
        ])
      );
      for (const card of out) {
        const c = partnerCounts.get(card.dcHost);
        // DC 不在结果集里 = 该 DC 在窗口内没有任何复制关系 (不是错误, 计数为 0)
        card.inboundPartnersCount  = c ? c.inbound  : 0;
        card.outboundPartnersCount = c ? c.outbound : 0;
      }

      out.sort((a, b) => a.dcHost.localeCompare(b.dcHost));
      res.json(out);
    } catch (e) {
      req.log?.error?.({ err: e }, 'dcs summary fetch failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}
