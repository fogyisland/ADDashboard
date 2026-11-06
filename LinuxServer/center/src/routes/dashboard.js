import { Router } from 'express';
import { userAuth } from '../auth/user-auth.js';
import { requirePerm } from '../auth/rbac.js';
import { getDb } from '../db/index.js';
import { listPortStatusesForAgents } from '../services/port-status.js';
import { listRemoteProbeForDcs, probeAtByDcs } from '../services/port-status-remote.js';
import { metricstore } from '../packages/metricstore.js';
import * as adminMembersService from '../services/admin-members.js';
// R158.72 (2026-10-11) — ad_account_change dashboard endpoints. 公共表
// pattern, 不动 admin-members / 不动 summary.
import * as accountChangeService from '../services/account-change.js';
// R158.76 (2026-10-11) — read package_runs_retention_days for 'all' window.
// Same pattern as package-runs-retention.js (server-side injected) but
// kept local here to avoid expanding the dashboardRouter() factory
// signature.
import { getConfig as getSystemConfig } from '../services/config.js';

// Helpers ---------------------------------------------------------------

function toIso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

// R93.12: NTDS Settings DN → bare DC name. Collector writes full DN
// (CN=NTDS Settings,CN=<bare>,CN=Servers,...) into ad_replication_status,
// but ad_dcs catalogue stores the bare name. Normalise here so the route
// handler can join link rows against the catalogue. Already-bare values
// pass through unchanged.
function extractBareDcName(dnOrName) {
  if (!dnOrName) return dnOrName;
  const m = /^CN=NTDS Settings,CN=([^,]+),/i.exec(dnOrName);
  return m ? m[1] : dnOrName;
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
  ['last_update', 'lastUpdate'],
  // R140 — site grouping fields surfaced by /api/dashboard/agents
  // (LEFT JOIN ad_dcs / ad_sites added to dashboard.agents SQL).
  ['site_id', 'siteId'],
  ['site_name', 'siteName'],
  ['region_code', 'regionCode'],
  ['site_hint', 'siteHint'],
  // R158.X.116.p.3 — 补 SELECT error_message 时漏了这里, 结果 SQL 补了列、
  //   前端 ErrorTable.vue:25 也改成了 r.errorMessage, 但 camelRow 是**白名单**
  //   转换 (CAML_MAP.get(k) ?? k), 未枚举的 key 原样透传 → 字段名仍是
  //   error_message, 前端取到 undefined, "报错原文"那格恒空。
  //   ⭐ 教训: 加 snake_case 列时, **SQL + CAML_MAP + 前端读取点** 三处必须
  //   同一提交内一起改, 只改 SQL 等于没改。
  ['error_message', 'errorMessage']
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
          const dcNode = row.site_name
            ? { name: row.dc_name, site: row.site_name, type: 'dc' }
            : { name: row.dc_name, type: 'dc' };
          // R158.45 (2026-10-05) — bridgehead flag from ad_dcs surfaced
          // onto the wire so TopologyChart can render the explicit
          // "DC↔Site Link Bridgehead" callout boxes (operator request,
          // modeled after adsiteLink.jpg reference).
          dcNode.isBridgehead = !!row.is_bridgehead;
          nodes.push(dcNode);
        }
      }
      const links = linksRes.rows.map(r => ({
        source:          r.source_dc,
        target:          r.dest_dc,
        statusCode:      r.status_code,
        lastSuccessTime: toIso(r.last_success_time),
        // R158.X.99-silent.topology (2026-10-21) — 扩 wire-shape 带 probe_state.
        //   拓扑边有 status_code (老 30min ad_replication_status probe, 0/1/2 三档),
        //   跟 probe_state (新 15min probe, 4 档 success/partial/error/none) 是
        //   **两个独立数据源**. 前端需要 probe_state='none' 才能把"链路存在但
        //   接入探针 0 报告" 跟 "复制真挂 (status_code=2)" 分色 —— 两者都红,
        //   但 glyph 不同 (⊙ vs ✕) + tooltip 文本不同 (先查 agent service vs
        //   先查 KB replication). 跟 /matrix/inbound 的 dc-pair silent 红
        //   1:1 平行, 同数据源同语义.
        //   降级路径: v_partner_inbound 无匹配 row (探针表从未写过这 pair) →
        //   probe_state = NULL → 前端 fallback 用 status_code 老语义 (2 红 / 其它
        //   非红), 不空指针. 跟 matrix silent 拆分点 1:1 平行 (partner 缺失
        //   走老 statusCode fallback, 不当 silent).
        probeState:      r.probe_state ?? null,
        probeAttemptAt:  toIso(r.probe_attempt_at)
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
      // R158.X.116.p (2026-10-23) — 加 all 档, 后台能翻全历史。
      // 操作员定位: 前台 /errors 只看 24h, 后台要能查任意久远的失败。
      // hours=null → SQL 层整个时间下界子句缺席 (不是拿极大值糊弄),
      // 两 dialect 严格 1:1 平行。
      else if (windowKey === 'all') hours = null;
      else return res.status(400).json({ error: 'invalid window (use 24h, 7d or all)' });

      const db = getDb();
      // R158.X.99.29.b (2026-10-19) — 改走新表 ad_replication_active_errors.
      // 1:1 平行老端点 shape 0 变, 0 改前端 (操作员 directive 锁
      // feedback-do-not-touch-working-frontend). 列表 active errors 走新
      // 表 listActiveErrors SQL helper, 1:1 平行老 replicationErrors 3 窗口限
      // 范式 (lesson 49 锁). last_success_time 字段新表 0 有, 复用
      // last_reported_at 兜底 (新表 last_reported_at = 最近一次 agent 报
      // 这次 row 的时间, 跟老 last_success_time 语义对等).
      //
      // R158.X.116.p — listActiveErrors 两 dialect 统一为函数式 (原先
      // MySQL 是 string / MSSQL 是 function, 需在调用点分派; 现在两版
      // 都收 hours 参数, 分派语句删除, 新增 all 档时不必两处各判一次)。
      const { rows } = await db.query(
        db.sql.replication.listActiveErrors(hours),
        hours == null ? [] : [hours]);
      const errors = rows.map(r => ({
        sourceDc:        r.source_dc,
        destDc:          r.dest_dc,
        namingContext:   r.naming_context,
        statusCode:      r.status_code,
        lastAttemptTime: toIso(r.last_attempt_time),
        lastSuccessTime: toIso(r.last_reported_at),
        attemptCount:    Number(r.reported_count) || 0,
        errorMessage:    r.last_error_message,
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

  // R158.X.116.p (2026-10-23) — /errors 页专用带窗端点 (新建, 老
  // /api/dashboard/errors 0 改 — feedback-new-endpoint-dont-modify-old 锁)。
  //
  // 操作员定位: 前台 /errors 只看最近 24h (值班视角: 今天有没有坏链路),
  // 后台 /admin/replication-errors 要能翻全历史 (排查视角: 这条链路是不是
  // 从某天起就断着)。修复前两边角色是反的 —— 前台无窗口返全部, 后台被
  // 默认 24h 卡住。
  //
  // 老端点保留给 0 个已知内部消费点 (grep 确认 src/ 内无第二处引用),
  // 但它是公开 API 契约的一部分, 外部脚本可能在用, 不动。
  r.get('/api/dashboard/errors-recent', auth, async (req, res) => {
    try {
      const windowKey = String(req.query.window || '24h').trim().toLowerCase();
      let hours;
      if (windowKey === '24h') hours = 24;
      else if (windowKey === '7d') hours = 7 * 24;
      else if (windowKey === 'all') hours = null;
      else return res.status(400).json({ error: 'invalid window (use 24h, 7d or all)' });

      const db = getDb();
      const { rows } = await db.query(
        db.sql.dashboard.errorsRecent(hours),
        hours == null ? [] : [hours]);
      res.json(rows.map(camelRow));
    } catch (e) {
      logger.error({ err: e }, 'dashboard errors-recent failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // R148 — aggregate 4 panel stats for the / (overview) page. Server-side
  // fan-out keeps a single round-trip + a consistent <500ms response even when
  // the centre has 100+ agents. Each sub-query is independent — we run them
  // in parallel via Promise.all, swallowing per-panel errors so a single
  // broken table doesn't blank the whole card grid (each panel falls back
  // to zeros + a degraded flag, surfaced via the `degraded` array on the
  // response).
  //
  // Response shape (see plan §1):
  //   {
  //     ts, refreshSeconds,
  //     osBaseline:  { total, critical, warning, normal, offline },
  //     eventlog:    { errorDcs, errorEvents, warningEvents },
  //     lockout:     { total24h, dcsWithLocks, lastEvent: {...} },
  //     replication: { errorLinks, warningLinks, windowHours },
  //     degraded: ['lockout', ...]   // panels that errored
  //   }
  //
  // Threshold derivation for OS Baseline: matches web/src/views/os-baseline-status.js
  // R116 thresholds (CPU/MEM ≥95 critical / ≥80 warning; DISK ≥80 critical /
  // ≥50 warning). Offline = no row in last 2h. The view's computeStatus()
  // algorithm is re-implemented here in SQL because the centre doesn't have
  // the row-level thresholds in JS; matching the same numbers on both sides
  // keeps the / and /os-baseline numbers consistent.
  r.get('/api/dashboard/summary', auth, async (_req, res) => {
    const db = getDb();
    const degraded = [];
    const safe = async (label, fn) => {
      try { return await fn(); } catch (e) {
        logger.warn({ err: e.message, panel: label }, 'R148 summary sub-query failed');
        degraded.push(label);
        return null;
      }
    };

    // ---- OS Baseline: 4-way bucketing (critical / warning / normal / offline) ----
    // Latest metric row per agent, then bucket by computed status.
    //
    // 2026-10-20 perf (R158 verification) — the MSSQL branch used the R116
    // TOP 1 + CROSS APPLY idiom, which on pkg_ad_os_baseline.metrics (HEAP,
    // no secondary index, ~870k rows) ran a correlated subquery per table
    // row. This feeds the /api/dashboard/summary osBaseline tile.
    //
    // Rewritten to aggregate-then-join, matching the MySQL sibling's shape:
    // one sequential pass produces one row per agent, then the payload
    // columns are joined back for just those rows. Same rows out; the
    // bucket counts below are unchanged.
    const pOsBaseline = safe('osBaseline', async () => {
      const isMssql = db.dialect === 'mssql';
      // 2026-10-20 perf — bracket the derived-table aggregate with
      //   `WHERE ts >= now - 2h`, the same 2h offline threshold the route
      //   uses when bucketing. Pre-fix this derived MAX(ts) scanned the
      //   full ~870k rows of pkg_ad_os_baseline.metrics on every
      //   /api/dashboard/summary call (~271ms). With the 2h floor
      //   (5min cadence × 34 agents ≈ 816 rows) the same MAX(ts) runs in
      //   single-digit ms. Same rows out for healthy agents; offline
      //   agents whose newest row is outside 2h fall into the offline
      //   bucket below, exactly as before — no semantic change.
      const latestSql = isMssql
        ? `SELECT m.agent_id, m.ts, m.cpu_pct, m.memory_pct, m.disk_free, m.disk_total
             FROM pkg_ad_os_baseline.metrics m
             INNER JOIN (SELECT agent_id, MAX(ts) AS ts
                           FROM pkg_ad_os_baseline.metrics
                          WHERE ts >= DATEADD(HOUR, -2, SYSUTCDATETIME())
                          GROUP BY agent_id) latest
                    ON m.agent_id = latest.agent_id AND m.ts = latest.ts`
        : `SELECT m.agent_id, m.ts, m.cpu_pct, m.memory_pct, m.disk_free, m.disk_total
             FROM pkg_ad_os_baseline.metrics m
             INNER JOIN (SELECT agent_id, MAX(ts) AS ts
                           FROM pkg_ad_os_baseline.metrics
                          WHERE ts >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 2 HOUR)
                          GROUP BY agent_id) latest
                    ON m.agent_id = latest.agent_id AND m.ts = latest.ts`;
      const { rows: latest } = await db.query(latestSql);
      const buckets = { critical: 0, warning: 0, normal: 0, offline: 0 };
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      for (const r of latest) {
        const lastSeenMs = r.ts instanceof Date ? r.ts.getTime() : new Date(r.ts).getTime();
        if (!Number.isFinite(lastSeenMs) || lastSeenMs < twoHoursAgo) {
          buckets.offline++;
          continue;
        }
        const cpu = Number(r.cpu_pct);
        const mem = Number(r.memory_pct);
        // worstDrive.usedPct — derive from disk_free + disk_total JSON objects
        let diskUsedPct = null;
        try {
          const freeMap = typeof r.disk_free === 'string' ? JSON.parse(r.disk_free) : r.disk_free;
          const totalMap = typeof r.disk_total === 'string' ? JSON.parse(r.disk_total) : r.disk_total;
          if (freeMap && totalMap) {
            let worst = 0;
            for (const drive of Object.keys(totalMap)) {
              const tot = Number(totalMap[drive]);
              const fre = Number(freeMap[drive]);
              if (Number.isFinite(tot) && tot > 0 && Number.isFinite(fre) && fre >= 0) {
                const used = 100 * (1 - fre / tot);
                if (used > worst) worst = used;
              }
            }
            diskUsedPct = worst;
          }
        } catch {}
        const cpuHigh = Number.isFinite(cpu) && cpu >= 95;
        const memHigh = Number.isFinite(mem) && mem >= 95;
        const diskHigh = diskUsedPct !== null && diskUsedPct >= 80;
        const cpuMid = Number.isFinite(cpu) && cpu >= 80;
        const memMid = Number.isFinite(mem) && mem >= 80;
        const diskMid = diskUsedPct !== null && diskUsedPct >= 50;
        if (cpuHigh || memHigh || diskHigh) buckets.critical++;
        else if (cpuMid || memMid || diskMid) buckets.warning++;
        else buckets.normal++;
      }
      return { total: latest.length, ...buckets };
    });

    // R158 summary parallelise — pre-fix ran all 5 panels sequentially
    //   (osBaseline → eventlog → lockout → replication → admins) summing
    //   to ~378ms even though each individual query is <80ms. Now they
    //   fire in parallel via Promise.all; total wall time drops to
    //   max(single), typically the slowest panel + 5-10ms synchronisation.
    // Per-panel error semantics identical: any panel failure still goes
    // through `safe(...)` which marks `degraded[]` and returns the prior
    // default. Order in the response object is preserved.
    //
    // ---- Eventlog: per-DC error / warning counts (last 24h) ----
    // ad_eventlog_summary is the canonical pivot table populated by the
    // eventlog-collector agent package. SUM(errorCount) / SUM(warningCount)
    // give the totals; COUNT(DISTINCT dcName) WHERE errorCount > 0 gives
    // the "DC with errors" subset.
    //
    // R158.31 (2026-10-02) — overview metric must reflect the FRESH
    // 2h scan window, not 24h of accumulated 15-min summaries. The
    // pre-fix SQL summed ALL summary rows in the 24h window, which
    // inflated the panel ~96× (24h / 15min). The fix restricts SUM
    // to the latest row per (dc_name, channel) within the 24h window
    // via a WHERE collected_at = (SELECT MAX(...) GROUP BY ...) so the
    // overview always reflects the freshest counter rollup, regardless
    // of how often the agent publishes.
    const pEventlog = safe('eventlog', async () => {
      // 2026-10-20 perf — rewrite correlated subquery as INNER JOIN+MAX.
      //   Pre-fix shape: WHERE collected_at = (SELECT TOP 1 / LIMIT 1 ...) runs
      //   the correlated MAX once per outer row (~25-50k rows in 24h). New
      //   shape: 1 derived table MAX(collected_at) per (dc, channel) JOINed
      //   back, then SUM aggregates per-keep rows. ~89ms → expected single
      //   digit ms. Same rows out for healthy input. Mirrors the
      //   member-eventlog H1 fix from yesterday.
      const fixedSql = db.dialect === 'mssql'
        ? `SELECT
            SUM(error_count)   AS error_events,
            SUM(warning_count) AS warning_events,
            SUM(CASE WHEN error_count > 0 THEN 1 ELSE 0 END) AS error_dcs
          FROM ad_eventlog_summary s
          INNER JOIN (
            SELECT dc_name, channel, MAX(collected_at) AS max_collected
              FROM ad_eventlog_summary
             WHERE collected_at >= DATEADD(HOUR, -24, SYSUTCDATETIME())
             GROUP BY dc_name, channel
          ) latest
            ON latest.dc_name   = s.dc_name
           AND latest.channel   = s.channel
           AND latest.max_collected = s.collected_at`
        : `SELECT
            SUM(error_count)   AS error_events,
            SUM(warning_count) AS warning_events,
            SUM(CASE WHEN error_count > 0 THEN 1 ELSE 0 END) AS error_dcs
          FROM ad_eventlog_summary s
          INNER JOIN (
            SELECT dc_name, channel, MAX(collected_at) AS max_collected
              FROM ad_eventlog_summary
             WHERE collected_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)
             GROUP BY dc_name, channel
          ) latest
            ON latest.dc_name   = s.dc_name
           AND latest.channel   = s.channel
           AND latest.max_collected = s.collected_at`;
      const { rows } = await db.query(fixedSql);
      const row = rows[0] || {};
      return {
        errorEvents:   Number(row.error_events)   || 0,
        warningEvents: Number(row.warning_events) || 0,
        errorDcs:      Number(row.error_dcs)      || 0
      };
    });

    // ---- Lockout: count + last event in last 24h ----
    // ad_lockout_events is the canonical event log. COUNT(*) for total,
    // TOP 1 / LIMIT 1 for the most recent row. dcsWithLocks = COUNT(DISTINCT
    // dc_name).
    const pLockout = safe('lockout', async () => {
      const sinceHours = 24;
      const summarySql = db.dialect === 'mssql'
        ? `SELECT
             COUNT(*) AS total_24h,
             COUNT(DISTINCT dc_name) AS dcs_with_locks
           FROM ad_lockout_events
           WHERE occurred_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())`
        : `SELECT
             COUNT(*) AS total_24h,
             COUNT(DISTINCT dc_name) AS dcs_with_locks
           FROM ad_lockout_events
           WHERE occurred_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR)`;
      // R158.31 — wire shape rename: target_user_description → target_user_display_name
      // (AD attribute we now stamp is displayName, not description).
      const lastSql = db.dialect === 'mssql'
        ? `SELECT TOP 1 occurred_at, dc_name, target_user_name, target_user_display_name
           FROM ad_lockout_events ORDER BY occurred_at DESC`
        : `SELECT occurred_at, dc_name, target_user_name, target_user_display_name
           FROM ad_lockout_events ORDER BY occurred_at DESC LIMIT 1`;
      const [summaryRes, lastRes] = await Promise.all([
        db.query(summarySql, [sinceHours]),
        db.query(lastSql)
      ]);
      const s = summaryRes.rows[0] || {};
      const last = lastRes.rows[0] || null;
      return {
        total24h:     Number(s.total_24h)      || 0,
        dcsWithLocks: Number(s.dcs_with_locks) || 0,
        lastEvent: last ? {
          occurredAt:            toIso(last.occurred_at),
          dcName:                last.dc_name,
          targetUserName:        last.target_user_name,
          targetUserDisplayName: last.target_user_display_name  // R158.31 (was R139 description)
        } : null
      };
    });

    // ---- Replication: count of error/warning links in ad_replication_status ----
    // status_code semantics: 0=healthy, 1=warning, ≥2=error. Bucket by
    // MAX(ts) per (source_dc, dest_dc) to mirror what /errors and
    // /replication-errors already surface (link-level not row-level).
    const pReplication = safe('replication', async () => {
      const windowHours = 24;
      // 2026-10-20 — MSSQL bugfix + unify dialect shape.
      //   Pre-fix MSSQL used `(source_dc, ts) IN (SELECT ...)` which is
      //   MySQL-only syntax; the MSSQL parser rejected it with
      //   "non-boolean type specified" and `safe()` swallowed the error
      //   into `degraded[]`, so this panel never surfaced values via the
      //   MSSQL centre. Both dialects now use a single INNER JOIN +
      //   MAX(collected_at) GROUP BY 派生表, parallel with the eventlog fix
      //   just above. Same rows out for healthy input.
      //
      // 2026-10-20 follow-up (真因) — the rewrite above only replaced the
      //   `(source_dc, ts) IN (SELECT ...)` *syntax*; it left the column
      //   name `ts` in place. ad_replication_status has never had a `ts`
      //   column — both baselines (db/migrations/mssql/1.0.0-baseline.sql
      //   :1261 and db/migrations/mysql/1.0.0-baseline.sql:30) define
      //   `collected_at`. So the panel failed with
      //   "Invalid column name 'ts'." on BOTH dialects, `safe()` swallowed
      //   it into `degraded[]`, and the panel silently returned all-zeros.
      //   Now uses `collected_at`, matching every other query in the
      //   codebase (db/sql.js replication helpers, lines 116-1080).
      const linkSql = db.dialect === 'mssql'
        ? `SELECT r.source_dc, r.dest_dc, r.status_code
             FROM ad_replication_status r
             INNER JOIN (
               SELECT source_dc, dest_dc, MAX(collected_at) AS max_ts
                 FROM ad_replication_status
                WHERE collected_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())
                GROUP BY source_dc, dest_dc
             ) latest
               ON r.source_dc = latest.source_dc
              AND r.dest_dc   = latest.dest_dc
              AND r.collected_at = latest.max_ts
            WHERE r.collected_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())`
        : `SELECT r.source_dc, r.dest_dc, r.status_code
             FROM ad_replication_status r
             INNER JOIN (
               SELECT source_dc, dest_dc, MAX(collected_at) AS max_ts
                 FROM ad_replication_status
                WHERE collected_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR)
                GROUP BY source_dc, dest_dc
             ) latest
               ON r.source_dc = latest.source_dc
              AND r.dest_dc   = latest.dest_dc
              AND r.collected_at = latest.max_ts
            WHERE r.collected_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR)`;
      const { rows } = await db.query(linkSql, [windowHours, windowHours]);
      let errors = 0, warnings = 0;
      for (const r of rows) {
        // R158.X.116.p.3 — 与后端 `status_code > 0` 及前端
        // ReplicationErrorsView 的 summary 同口径。旧写法 `sc >= 2` 漏掉
        // 1398/1722 等 Windows 错误码, 会把它们算进 neither 分桶。
        const sc = Number(r.status_code);
        if (sc === 1) warnings++;
        else if (sc > 0) errors++;
      }
      return { errorLinks: errors, warningLinks: warnings, windowHours };
    });

    // ---- R158.47 Admin members: Domain Admins + Enterprise Admins counts ----
    // ad_admin_members is the canonical table populated by the
    // ad_admin_members agent package (daily cadence, 24h, intervalSec=86400).
    // summary() returns per-group counts (only Domain Admins / Enterprise
    // Admins rows counted via the SAME group_name match below). totalMembers
    // is a separate COUNT(DISTINCT member_sam) across both groups since a
    // member can appear in both (e.g. an EA is also a DA in their local
    // domain) — that's the "去重成员" number the operator wants on the
    // overview panel. LATEST collected_at window per (domain_dn, group_name)
    // so the panel always reflects the freshest scan, regardless of how many
    // DCs reported at slightly different timestamps.
    const pAdmins = safe('admins', async () => {
      const built = db.sql.adminMembers.summary();
      const { rows } = await db.query(built.sql, built.params);
      let domainAdmins = 0;
      let enterpriseAdmins = 0;
      for (const r of rows) {
        const g = String(r.group_name || '');
        const c = Number(r.member_count) || 0;
        if (g === 'Domain Admins') domainAdmins += c;
        else if (g === 'Enterprise Admins') enterpriseAdmins += c;
      }
      // R158.47.2 (2026-10-06) — L4 fix: 跨 group 去重 member_sam 数 (totalMembers
      // 卡片). 用 db.sql.adminMembers.distinctSummary() 替代内联 raw SQL, R110.A
      // 公共表 pattern 一致性 hygiene.
      const distinctQ = db.sql.adminMembers.distinctSummary({
        groupNames: ['Domain Admins', 'Enterprise Admins']
      });
      const { rows: dRows } = await db.query(distinctQ.sql, distinctQ.params);
      const distinctMembers = Number(dRows[0]?.distinct_count) || 0;
      return { domainAdmins, enterpriseAdmins, totalMembers: distinctMembers };
    });

    // 2026-10-20 perf — 5 panels in parallel. Pre-fix they ran serially,
    //   summing wall time to ~378ms even though each is <80ms. Now the
    //   total is bounded by max(panel), typically the slowest one +
    //   ~5ms ordering. Each panel still flows through the per-panel
    //   `safe(...)` wrapper so any failure path is unchanged.
    const [osBaseline, eventlog, lockout, replication, admins] = await Promise.all([
      pOsBaseline, pEventlog, pLockout, pReplication, pAdmins
    ]);

    res.json({
      ts: new Date().toISOString(),
      refreshSeconds: 30,
      osBaseline:  osBaseline  || { total: 0, critical: 0, warning: 0, normal: 0, offline: 0 },
      eventlog:    eventlog    || { errorEvents: 0, warningEvents: 0, errorDcs: 0 },
      lockout:     lockout     || { total24h: 0, dcsWithLocks: 0, lastEvent: null },
      replication: replication || { errorLinks: 0, warningLinks: 0, windowHours: 24 },
      admins:      admins      || { domainAdmins: 0, enterpriseAdmins: 0, totalMembers: 0 },
      degraded
    });
  });

  // R158.69.10 (2026-10-11) — admin members drill-down per group.
  //   新建端点, 不动 /api/dashboard/summary. 沿用 auth (read:dash).
  //   白名单 group 防注入 (仅 Domain Admins / Enterprise Admins).
  r.get('/api/dashboard/admin-members', auth, async (req, res) => {
    const db = getDb();
    const group = String(req.query.group || '');
    const allowed = new Set(['Domain Admins', 'Enterprise Admins']);
    if (!allowed.has(group)) {
      return res.status(400).json({ error: 'invalid_group', allowed: [...allowed] });
    }
    try {
      const rows = await adminMembersService.listByGroup(db, group, logger);
      res.json({ group, rows, total: rows.length });
    } catch (e) {
      logger?.error?.({ event: 'admin-members.list_failed', group, err: e?.message || String(e) }, 'admin-members list failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // R158.72 (2026-10-11) — ad_account_change trend for 首页 折线图。
  //   新建端点, 不动 /api/dashboard/summary, 不动 /api/dashboard/admin-members.
  //   ?days=30 default (range [1, 180]). 返回 { days, rows: [{ action,
  //   change_date, event_count }] }, 客户端 pivot 成 5 series.
  r.get('/api/dashboard/account-change-trend', auth, async (req, res) => {
    const db = getDb();
    const days = Math.max(1, Math.min(180, Number(req.query.days) || 30));
    try {
      const rows = await accountChangeService.getTrend(db, days, logger);
      res.json({ days, rows });
    } catch (e) {
      logger?.error?.({ event: 'account_change.trend_failed', days, err: e?.message || String(e) }, 'account-change trend failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // R150 — core-site (is_hub=1) resource chart data. Backs the ECharts
  // multi-line chart on the / overview page. Aggregates CPU% / memory% /
  // worst-disk% / C-drive-used% across every DC whose site is marked as a
  // core site in ad_sites. Default window = last 6 hours, 5-minute bucket
  // (12 points / metric). Hub-only — non-hub DCs are filtered out.
  //
  // Response shape:
  //   {
  //     ts, hours, bucketMinutes,
  //     series: { cpu, memory, disk, cUsed },   // [{ ts, value }] fleet AVG
  //     seriesByDc: {                              // R158.7 — per-DC series
  //       'KDLFLOFADSRV1': { cpu, memory, disk, cUsed },  // each its own bucket
  //       'KDLFLOFADSRV2': { ... }
  //     },
  //     sites: [{ siteId, siteName, dcCount }], // participating sites
  //     dcCount, sampleCount
  //   }
  //
  // Why bucket averages: per-agent points would produce 30+ lines and blow
  // out a 5-minute window; an AVG over the bucket collapses to one fleet-
  // level line per metric (operator's "核心站点资源占用" framing).
  // R158.7 — operator directive 2026-09-30 "分成两台机器" (clarified:
  // HUB 站点有几台机器就显示几张图). seriesByDc returns the same
  // 4-metric shape per DC so the dashboard can render N small sub-charts
  // (one per hub DC) instead of one averaged chart. Fleet `series` is
  // preserved for backward-compat with existing dashboard consumers and
  // any future fleet-level overview tile.
  r.get('/api/dashboard/hub-resources', auth, async (req, res) => {
    const db = getDb();
    const hoursRaw = Number(req.query.hours);
    const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 && hoursRaw <= 48
      ? Math.min(hoursRaw, 24)
      : 6;
    const bucketMinutes = 5;
    try {
      // 1. enumerate hub site IDs
      const hubListSql = db.dialect === 'mssql'
        ? `SELECT site_id, site_name FROM ad_sites WHERE is_hub = 1 ORDER BY site_name`
        : `SELECT site_id, site_name FROM ad_sites WHERE is_hub = 1 ORDER BY site_name`;
      const hubList = await db.query(hubListSql);
      const hubRows = Array.isArray(hubList) ? hubList : (hubList.rows || []);
      const hubIds = hubRows.map(r => r.site_id).filter(v => v != null);
      if (hubIds.length === 0) {
        return res.json({
          ts: new Date().toISOString(), hours, bucketMinutes,
          series: { cpu: [], memory: [], disk: [], cUsed: [] },
          sites: [], dcCount: 0, sampleCount: 0
        });
      }

      // 2. enumerate DC names in those sites
      const placeholders = hubIds.map(() => '?').join(',');
      const dcSql = `SELECT dc_name, site_id FROM ad_dcs WHERE site_id IN (${placeholders})`;
      const dcResult = await db.query(dcSql, hubIds);
      const dcRows = Array.isArray(dcResult) ? dcResult : (dcResult.rows || []);
      const dcNames = Array.from(new Set(dcRows.map(r => r.dc_name).filter(Boolean)));
      if (dcNames.length === 0) {
        return res.json({
          ts: new Date().toISOString(), hours, bucketMinutes,
          series: { cpu: [], memory: [], disk: [], cUsed: [] },
          sites: hubRows.map(r => ({ siteId: r.site_id, siteName: r.site_name, dcCount: 0 })),
          dcCount: 0, sampleCount: 0
        });
      }

      // 3. fetch raw metric rows from the window. Use a single SELECT so the
      //    centre doesn't fan out 4 queries — bucket aggregation is cheap in
      //    JS (≤2k rows over 6h × ~30 agents).
      const drainThreshold = db.dialect === 'mssql' ? '? >= DATEADD(MINUTE, -' : '? >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ';
      // Build the metric SQL inline. cpu_pct, memory_pct come straight from
      // the column. disk_used_pct and c_used_pct are computed from disk_free
      // + disk_total JSON columns — per row, the highest used% across drives
      // is the fleet "worst disk", and C: is found by parsing the JSON map.
      // We project the raw numbers (cpu_pct, memory_pct, disk_free, disk_total,
      // c_used_pct when 1.0.3+) and do the JSON walk in JS so the SQL stays
      // dialect-portable.
      const sinceMinutes = hours * 60;
      const timeWhere = db.dialect === 'mssql'
        ? `m.ts >= DATEADD(MINUTE, -${sinceMinutes}, SYSUTCDATETIME())`
        : `m.ts >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${sinceMinutes} MINUTE)`;
      const dcPlaceholders = dcNames.map(() => '?').join(',');
      const metricSql = `SELECT m.agent_id, m.ts, m.cpu_pct, m.memory_pct,
                                m.disk_free, m.disk_total, m.c_used_pct
                         FROM pkg_ad_os_baseline.metrics m
                         WHERE m.agent_id IN (${dcPlaceholders})
                           AND ${timeWhere}
                         ORDER BY m.ts ASC`;
      const params = [...dcNames];
      const metricResult = await db.query(metricSql, params);
      const rows = Array.isArray(metricResult) ? metricResult : (metricResult.rows || []);

      // 4. bucket into 5-minute bins. Two parallel structures:
      //    - buckets:           Map<bucketStartMs, slot>            fleet-level AVG (existing)
      //    - bucketsByDc:       Map<agentId, Map<bucketStartMs, slot>>  per-DC series (R158.7)
      //    Both are populated in the same loop so the per-DC rows and
      //    fleet-level roll-up share one pass over `rows`.
      const bucketSizeMs = bucketMinutes * 60 * 1000;
      const buckets = new Map();
      const bucketsByDc = new Map();
      const epochStart = Date.now() - hours * 3600 * 1000;
      const bucketStartFor = (tsMs) => {
        const b = Math.floor((tsMs - epochStart) / bucketSizeMs) * bucketSizeMs + epochStart;
        return b;
      };
      const newSlot = () => ({ cpuSum: 0, cpuN: 0, memSum: 0, memN: 0, diskSum: 0, diskN: 0, cSum: 0, cN: 0 });
      for (const r of rows) {
        const tsMs = r.ts instanceof Date ? r.ts.getTime() : new Date(r.ts).getTime();
        if (!Number.isFinite(tsMs) || tsMs < epochStart) continue;
        const b = bucketStartFor(tsMs);

        // fleet-level bucket
        let slot = buckets.get(b);
        if (!slot) { slot = newSlot(); buckets.set(b, slot); }

        // per-DC bucket (R158.7 — operator directive "分成两台机器" =
        // HUB 站点有几台机器就显示几张图)
        let dcMap = bucketsByDc.get(r.agent_id);
        if (!dcMap) { dcMap = new Map(); bucketsByDc.set(r.agent_id, dcMap); }
        let dcSlot = dcMap.get(b);
        if (!dcSlot) { dcSlot = newSlot(); dcMap.set(b, dcSlot); }

        const accumulate = (target) => {
          const cpu = Number(r.cpu_pct);
          if (Number.isFinite(cpu)) { target.cpuSum += cpu; target.cpuN++; }
          const mem = Number(r.memory_pct);
          if (Number.isFinite(mem)) { target.memSum += mem; target.memN++; }
          const c = Number(r.c_used_pct);
          if (Number.isFinite(c)) { target.cSum += c; target.cN++; }
          try {
            const freeMap  = typeof r.disk_free  === 'string' ? JSON.parse(r.disk_free)  : (r.disk_free  || {});
            const totalMap = typeof r.disk_total === 'string' ? JSON.parse(r.disk_total) : (r.disk_total || {});
            let worst = 0;
            for (const drive of Object.keys(totalMap || {})) {
              const tot = Number(totalMap[drive]);
              const fre = Number(freeMap?.[drive]);
              if (Number.isFinite(tot) && tot > 0 && Number.isFinite(fre) && fre >= 0) {
                const used = 100 * (1 - fre / tot);
                if (used > worst) worst = used;
              }
            }
            if (worst > 0) { target.diskSum += worst; target.diskN++; }
          } catch { /* bad JSON — skip */ }
        };
        accumulate(slot);
        accumulate(dcSlot);
      }
      // 5a. emit fleet-level series (backward-compat — used by problem-section
      //     chain via /api/dashboard/problem-agents + any legacy dashboard
      //     surface that consumes /hub-resources without per-DC support).
      const sortedKeys = Array.from(buckets.keys()).sort((a, b) => a - b);
      const cpu = [], memory = [], disk = [], cUsed = [];
      for (const k of sortedKeys) {
        const s = buckets.get(k);
        const ts = new Date(k).toISOString();
        if (s.cpuN)  cpu.push({ ts, value: Math.round((s.cpuSum  / s.cpuN)  * 10) / 10 });
        if (s.memN)  memory.push({ ts, value: Math.round((s.memSum  / s.memN)  * 10) / 10 });
        if (s.diskN) disk.push({ ts, value: Math.round((s.diskSum / s.diskN) * 10) / 10 });
        if (s.cN)    cUsed.push({ ts, value: Math.round((s.cSum    / s.cN)    * 10) / 10 });
      }
      // 5b. emit per-DC series (R158.7). Keys = agent_id (= dc_name).
      //     Each DC's series is independent — same 5-minute bucket, but
      //     the slot is private to that DC. Empty buckets simply don't
      //     contribute a point (same shape as fleet series).
      const seriesByDc = {};
      const dcNamesSorted = Array.from(bucketsByDc.keys()).sort();
      for (const dcName of dcNamesSorted) {
        const dcMap = bucketsByDc.get(dcName);
        const dCpu = [], dMemory = [], dDisk = [], dCUsed = [];
        const dcKeys = Array.from(dcMap.keys()).sort((a, b) => a - b);
        for (const k of dcKeys) {
          const s = dcMap.get(k);
          const ts = new Date(k).toISOString();
          if (s.cpuN)  dCpu.push({ ts, value: Math.round((s.cpuSum  / s.cpuN)  * 10) / 10 });
          if (s.memN)  dMemory.push({ ts, value: Math.round((s.memSum  / s.memN)  * 10) / 10 });
          if (s.diskN) dDisk.push({ ts, value: Math.round((s.diskSum / s.diskN) * 10) / 10 });
          if (s.cN)    dCUsed.push({ ts, value: Math.round((s.cSum    / s.cN)    * 10) / 10 });
        }
        seriesByDc[dcName] = { cpu: dCpu, memory: dMemory, disk: dDisk, cUsed: dCUsed };
      }
      // site participation summary — DC count per hub site
      const siteDcMap = new Map();
      for (const r of dcRows) {
        if (!r.site_id) continue;
        siteDcMap.set(r.site_id, (siteDcMap.get(r.site_id) || 0) + 1);
      }
      const sites = hubRows.map(r => ({
        siteId: r.site_id, siteName: r.site_name, dcCount: siteDcMap.get(r.site_id) || 0
      }));
      res.json({
        ts: new Date().toISOString(),
        hours, bucketMinutes,
        series: { cpu, memory, disk, cUsed },
        seriesByDc,                                       // R158.7 — per-DC
        sites,
        dcCount: dcNames.length,
        sampleCount: rows.length
      });
    } catch (e) {
      logger.error({ err: e.message, stack: e.stack }, 'dashboard hub-resources failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // R150 — list current problem agents (OS baseline critical/warning) for
  // the overview page. Filters the same ad_dcs / ad_sites hub-set used by
  // /api/dashboard/hub-resources and surfaces one row per agent whose
  // latest metric trip the R116 thresholds (cpu/mem ≥80 or disk ≥50).
  //
  // Response shape:
  //   {
  //     ts,
  //     items: [{
  //       agentId, siteId, siteName,
  //       status: 'critical'|'warning',
  //       cpuPct, memPct, cUsedPct, diskUsedPct,
  //       // which dimension tripped the worst — for the UI to badge it
  //       drivers: ['cpu', 'mem', 'disk', 'c']   // subset of those that hit
  //       ts                                    // last metric ts
  //     }]
  //   }
  //
  // Why separate from hub-resources: chart endpoint averages, this endpoint
  // lists per-row. Same DC set (hub-only) keeps the framing consistent.
  r.get('/api/dashboard/problem-agents', auth, async (_req, res) => {
    const db = getDb();
    try {
      // Hub DC set — same query as hub-resources step 1+2 but cheaper
      // (no metric rows fetched here; we only need latest per agent).
      const hubList = await db.query(`SELECT site_id, site_name FROM ad_sites WHERE is_hub = 1`);
      const hubRows = Array.isArray(hubList) ? hubList : (hubList.rows || []);
      const hubIds = hubRows.map(r => r.site_id).filter(v => v != null);
      if (hubIds.length === 0) return res.json({ ts: new Date().toISOString(), items: [] });
      const placeholders = hubIds.map(() => '?').join(',');
      const dcResult = await db.query(`SELECT dc_name, site_id FROM ad_dcs WHERE site_id IN (${placeholders})`, hubIds);
      const dcRows = Array.isArray(dcResult) ? dcResult : (dcResult.rows || []);
      const dcSiteMap = new Map(dcRows.map(r => [r.dc_name, r.site_id]));
      const dcNames = Array.from(dcSiteMap.keys());
      if (dcNames.length === 0) return res.json({ ts: new Date().toISOString(), items: [] });

      // Latest metric per agent.
      //
      // 2026-10-20 perf (R158 verification) — the MSSQL branch used the
      // CROSS APPLY (SELECT TOP 1 ...) idiom from R148. On
      // pkg_ad_os_baseline.metrics — a HEAP with no secondary index, ~870k
      // rows — that correlated subquery ran per table row, and the
      // `agent_id IN (...)` filter sat AFTER the APPLY so it could not be
      // pushed down either. Measured on production: 15011ms avg for
      // GET /api/dashboard/problem-agents.
      //
      // Rewrite (matches the MySQL sibling's aggregate-then-filter shape):
      // aggregate to one row per agent in a single sequential pass, then
      // join back for the payload columns. Measured: 277ms avg — 54x faster,
      // no new index required.
      //
      // The IN-list now lives INSIDE the aggregate so it prunes during the
      // pass instead of after it. Same rows out: verified 34 rows / 34
      // agents, zero value-level differences.
      const dcPlaceholders = dcNames.map(() => '?').join(',');
      const latestSql = db.dialect === 'mssql'
        ? `SELECT m.agent_id, m.ts, m.cpu_pct, m.memory_pct, m.disk_free, m.disk_total, m.c_used_pct
           FROM pkg_ad_os_baseline.metrics m
           INNER JOIN (SELECT agent_id, MAX(ts) AS ts
                         FROM pkg_ad_os_baseline.metrics
                        WHERE agent_id IN (${dcPlaceholders})
                        GROUP BY agent_id) latest
                  ON m.agent_id = latest.agent_id AND m.ts = latest.ts`
        : `SELECT m.agent_id, m.ts, m.cpu_pct, m.memory_pct, m.disk_free, m.disk_total, m.c_used_pct
           FROM pkg_ad_os_baseline.metrics m
           WHERE (m.agent_id, m.ts) IN (SELECT agent_id, MAX(ts) FROM pkg_ad_os_baseline.metrics GROUP BY agent_id)
             AND m.agent_id IN (${dcPlaceholders})`;
      const latest = await db.query(latestSql, dcNames);
      const latestRows = Array.isArray(latest) ? latest : (latest.rows || []);

      // R116 thresholds: cpu/mem 95=critical / 80=warning; disk 80=critical
      // / 50=warning. Matches web/src/views/os-baseline-status.js.
      const TWO_HOURS = 2 * 60 * 60 * 1000;
      const now = Date.now();
      const items = [];
      for (const r of latestRows) {
        const tsMs = r.ts instanceof Date ? r.ts.getTime() : new Date(r.ts).getTime();
        if (!Number.isFinite(tsMs) || (now - tsMs) > TWO_HOURS) continue; // offline → skip
        const cpu = Number(r.cpu_pct);
        const mem = Number(r.memory_pct);
        const c = Number(r.c_used_pct);
        let worstDisk = null;
        try {
          const freeMap  = typeof r.disk_free  === 'string' ? JSON.parse(r.disk_free)  : (r.disk_free  || {});
          const totalMap = typeof r.disk_total === 'string' ? JSON.parse(r.disk_total) : (r.disk_total || {});
          let worst = 0;
          for (const drive of Object.keys(totalMap || {})) {
            const tot = Number(totalMap[drive]);
            const fre = Number(freeMap?.[drive]);
            if (Number.isFinite(tot) && tot > 0 && Number.isFinite(fre) && fre >= 0) {
              const used = 100 * (1 - fre / tot);
              if (used > worst) worst = used;
            }
          }
          worstDisk = worst;
        } catch {}
        const cpuHigh = Number.isFinite(cpu) && cpu >= 95;
        const memHigh = Number.isFinite(mem) && mem >= 95;
        const diskHigh = worstDisk !== null && worstDisk >= 80;
        const cpuMid = Number.isFinite(cpu) && cpu >= 80 && cpu < 95;
        const memMid = Number.isFinite(mem) && mem >= 80 && mem < 95;
        const diskMid = worstDisk !== null && worstDisk >= 50 && worstDisk < 80;
        const isCritical = cpuHigh || memHigh || diskHigh;
        const isWarning  = cpuMid  || memMid  || diskMid;
        if (!isCritical && !isWarning) continue;
        const drivers = [];
        if (cpuHigh || cpuMid)  drivers.push('cpu');
        if (memHigh || memMid)  drivers.push('mem');
        if (diskHigh || diskMid) drivers.push('disk');
        if (Number.isFinite(c) && c >= 50) drivers.push('c');
        const siteId = dcSiteMap.get(r.agent_id) || null;
        const siteName = hubRows.find(h => h.site_id === siteId)?.site_name || null;
        items.push({
          agentId: r.agent_id,
          siteId, siteName,
          status: isCritical ? 'critical' : 'warning',
          cpuPct: Number.isFinite(cpu) ? Math.round(cpu * 10) / 10 : null,
          memPct: Number.isFinite(mem) ? Math.round(mem * 10) / 10 : null,
          cUsedPct: Number.isFinite(c) ? Math.round(c * 10) / 10 : null,
          diskUsedPct: worstDisk !== null ? Math.round(worstDisk * 10) / 10 : null,
          drivers,
          ts: new Date(tsMs).toISOString()
        });
      }
      // Sort: critical first, then by max(driver values) desc.
      const severityRank = (item) => {
        const m = Math.max(
          item.cpuPct || 0,
          item.memPct || 0,
          item.diskUsedPct || 0,
          item.cUsedPct || 0
        );
        return item.status === 'critical' ? 10_000 + m : m;
      };
      items.sort((a, b) => severityRank(b) - severityRank(a));
      res.json({ ts: new Date().toISOString(), items });
    } catch (e) {
      logger.error({ err: e.message, stack: e.stack }, 'dashboard problem-agents failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.get('/api/dashboard/agents', auth, async (_req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.dashboard.agents);
      const agents = rows.map(camelRow);

      // R114: port-status now sourced from centre-side active probe
      // (ad_remote_port_probe × system_ports), not from agent-side
      // payload.ports loopback. The join key is agentId (= dc_name in
      // ad_remote_port_probe). Agents whose rows haven't been probed
      // yet get an empty portStatuses (same fallback as before, just
      // sourced from a different table).
      const agentIds = agents.map(a => a.agentId).filter(Boolean);
      const [portRows, lastConnectRows] = await Promise.all([
        listRemoteProbeForDcs(db, agentIds),
        probeAtByDcs(db, agentIds)
      ]);

      const portStatusByAgent = new Map();
      for (const row of portRows) {
        if (!portStatusByAgent.has(row.dcName)) portStatusByAgent.set(row.dcName, []);
        portStatusByAgent.get(row.dcName).push({
          port: row.port,
          label: row.label ?? null,
          ok: !!row.ok,
          latencyMs: row.latencyMs,
          lastCheckedAt: toIso(row.probeAt)
        });
      }
      const lastConnectByAgent = new Map();
      for (const row of lastConnectRows) {
        lastConnectByAgent.set(row.dcName, toIso(row.lastConnectAt));
      }
      for (const a of agents) {
        a.portStatuses = portStatusByAgent.get(a.agentId) ?? [];
        // "最后心跳" → "最后连接" — semantic shift per operator R114 directive.
        // Surface the centre-side probe's most-recent cycle timestamp as
        // lastConnectAt; falls back to null when the scheduler hasn't
        // written any rows for this DC yet.
        a.lastConnectAt = lastConnectByAgent.get(a.agentId) ?? null;
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
  r.get('/api/dashboard/site-replication-matrix/all', auth, async (req, res) => {
    try {
      // R158.17.1 (2026-10-01) -- 整个 dashboard 数据语义基于入站复制健康度:
      //   - ad_replication_status_probe 1.0.3 只探入站 (peer → local)
      //   - 复制伙伴 / 探针状态 / 视图 v_partner_inbound / matrix /all 都
      //     围绕"哪台 DC 在接收哪些上游的复制"展开
      // outbound 视角历史上为 R153 inbound/outbound 拆分存在, 但探针层
      // 不覆盖 + 复制状态概览页用户明确反馈"所有数据都是 inbound 视角"
      // → 端点直接锁死 inbound, 忽略 req.query.direction, 避免 outbound
      //   行(probe_state=none)在 UI 上造成"未检测"噪声.
      //
      // R158.103.1 (2026-10-15) — silent reporter 检测. envelope 顶层
      // 发 livenessByAgent object { agent_id: { total, latest } }, 前端
      // 自行用 latest < now-2h 判定 silentAgentIds (单点真相在前端,
      // threshold 改前端不动后端). 触发场景: 沈阳 #1 (KDLSYOFADSRV1)
      // 4h 没跑 probe 包, 整行标红 (跟 probe_state='none' 灰色 区分).
      const direction = 'inbound';
      const db = getDb();
      // 2026-08-28 round-45: port fields removed (R35 port monitoring
      // surface deleted). `ports`, `portRows`, `latestPartnerPortPerPair`
      // and the per-partner `perPort` / `lastProbeAt` fields are all gone
      // — the partner entry now carries only status + timing. Per-pair
      // history is fetched on demand via /pair-history for the inline
      // "最近 10 条" expansion.
      //
      // 2026-10-01 R158.14: 复制伙伴清单改读 v_partner_inbound 视图
      // (基于 ad_partner_inbound discover 表, 30 天窗口, 每对
      // (source_dc, dest_dc) UNIQUE ≤1 行). 健康度字段
      // (statusCode / lastSuccessTime / durationMinutes / errorMessage)
      // 暂不接 — operator 后续阶段会用 15min probe 包改 PS1 + 写
      // ad_replication_history; 本 endpoint partner entry 形状统一
      // probeState: 'none', 前端灰色 pill 渲染.

      const [{ rows: siteRows }, { rows: dcRows }, { rows: linkRows }, { rows: cfgRows }, { rows: livenessRows }] =
        await Promise.all([
          db.query(db.sql.dashboard.allSitesOrdered, []),
          db.query(db.sql.dashboard.allDcsBySite, []),
          // R158.14 — 替换 allReplicationLinks (ad_replication_status 30min
          // probe) 为 vPartnerInbound (ad_partner_inbound 30 天 discover).
          // 字段集缩小: 不再含 status_code / last_success_time /
          // last_attempt_time / error_message / naming_context / duration_minutes.
          db.query(db.sql.dashboard.vPartnerInbound, []),
          db.query(db.sql.dashboard.refreshSeconds, []),
          // R158.103.1 (2026-10-15) — silent reporter 检测. 24h GROUP BY
          // agent_id, 给前端 envelope 发 livenessByAgent object (前端
          // 自行用 latest < now-2h 判定 silent). 不用 silentAgentIds
          // 数组是因为前端 threshold 改不动后端.
          db.query(db.sql.dashboard.probeReporterLiveness, [])
        ]);

      // dcByName: source for classifying each link
      const dcByName = new Map(dcRows.map(d => [d.dc_name, d]));
      // siteById: source of truth for site membership / hub flag
      const siteById = new Map(siteRows.map(s => [s.site_id, {
        siteId: s.site_id, siteName: s.site_name,
        regionCode: s.region_code, isHub: !!s.is_hub
      }]));

      // R158.103.1 (2026-10-15) — silent reporter liveness map. envelope
      // 顶层发 livenessByAgent object { agent_id: { total, latest } }.
      // 前端用 latest < now-2h 算 silentAgentIds (单点真相在前端).
      // agent_id null 防御: 跳过, 避免 undefined set 写入. raw Date
      // 直接发, 前端 new Date() 解析, 跟 site-level discovery 字段一致.
      const livenessByAgent = {};
      for (const r of livenessRows) {
        if (!r.agent_id) continue;
        livenessByAgent[r.agent_id] = {
          total: r.total_24h,
          latest: r.latest_attempt
        };
      }

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

        // R95: matrix is an N×N site catalogue mirror, not a "currently
        // active" view. Even sites with zero DCs in ad_dcs — either
        // pre-registered but not yet discovered, or whose DCs all got
        // dropped by INNER JOIN due to a site_id drift — must surface
        // in primaries with `dcs: []` / `dcPartners: []`. The frontend
        // renders those as a "暂未注册 DC" placeholder column/row.
        // Operator-side this surfaces catalogue drift immediately (the
        // matrix shape matches ad_sites row count, not "ad_sites with
        // at least one ad_dcs row" count) — see
        // tests/admin-site-replication-matrix-all.test.js R95 cases.
        const primaryEntry = dcList[0];
        const primaryDc = primaryEntry ? primaryEntry.dcName : null;

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
        // R93.13: matrix `/all` is an N×N network-wide view — allow every
        // catalogue-known DC as a peer, including remote-site secondaries.
        // The original `for (const [siteId, primaryName] of primaryBySiteId)`
        // loop only loaded the *primary* DC of every remote site, so any
        // link sourced from a secondary DC (e.g. KDLJTWHADSRV1 reporting
        // inbound to KDLFLOFADSRV2 with a full NTDS Settings DN whose bare
        // host is a ShangHaiJiuTing secondary) was dropped by the
        // `!allowedPeers.has(peerDc)` filter and never landed in any
        // partner map — empty matrix cells. Real-machine data on
        // KDLFLOFADSRV2 has 8 such rows, all from secondaries.
        // The dest-side gate (`partnerMapByDc.has(destDc)`) already keeps
        // the inbound scope to the current site, so widening the peer
        // side to all catalogue DCs is safe — out-of-site destinations
        // are still filtered, but every catalogue DC that ever sources
        // a link into this site now surfaces.
        for (const d of dcRows) allowedPeers.add(d.dc_name);

        // round-36: build one partner map per DC in the site. Walk every
        // link, find the receiving DC inside this site, attach the partner
        // entry to that DC's map. Inbound-only: source-dc is the partner,
        // dest-dc is the receiver (dropped when dest_dc === source_dc).
        const partnerMapByDc = new Map();
        for (const d of dcList) partnerMapByDc.set(d.dcName, new Map());

        for (const l of linkRows) {
          // R158.14 — 视图已规整 (UNIQUE(source_dc, dest_dc) 每对 ≤1 行 +
          // INNER JOIN ad_dcs 兜底), 不再做 latest-per-pair reduction /
          // NC 聚合 / extractBareDcName DN 归一化.
          //
          // R158.17.1 (2026-10-01) -- direction 端点锁死 'inbound' (R153
          // outbound 视角整体下线, 见 857 行), 视图 v_partner_inbound
          // target_dc = 本机 (dest_dc), peer_dc = 上游源 (source_dc).
          // 不再走 direction swap 分支 (outbound 分支已死代码).
          const targetDc = l.target_dc;
          const peerDc   = l.peer_dc;
          const localDc  = targetDc;
          const peerDcEffective = peerDc;
          // gate: local DC must be in this site; peer must be a known DC
          if (!partnerMapByDc.has(localDc)) continue; // local not in this site
          if (!allowedPeers.has(peerDcEffective)) continue; // round-32 filter
          const peer = dcByName.get(peerDcEffective);
          if (!peer) continue; // orphan DC
          const peerSite = siteById.get(peer.site_id);
          // peer 暂未 catalog (site_id NULL) — UI 显示 '未分组' 占位, 跟 R95 precedent 一致.
          const peerSiteName = peerSite ? peerSite.siteName : '未分组';
          const peerSiteIsHub = peerSite ? !!peerSite.isHub : false;

          const entry = {
            // round-32: peerType distinguishes within-site siblings from
            // cross-site bridgehead primaries. "within" = same-site sibling,
            // "bridgehead" = cross-site primary (operator-selected
            // bridgehead, or lex-first fallback).
            peerType: peer.site_id === s.site_id ? "within" : "bridgehead",
            peerDc: peerDcEffective,
            peerSite: peerSiteName,
            peerSiteIsHub,
            // R158.15 — probe 状态接入 (worst-of-NCs 聚合 15min 窗口).
            // 视图 v_partner_inbound 已 LEFT JOIN ad_replication_probe_history
            // 计算 probe_state (success/error/partial/none) + 关联字段.
            // R158.14 占位 'none' 替换为视图实际值.
            probeState:        l.probe_state ?? 'none',
            probeAttemptAt:    toIso(l.probe_attempt_at),
            probeDurationMs:   l.probe_duration_ms,
            probeErrorMessage: l.probe_error_message,
            // R158.17.1 -- `lastProbeAt` 语义别名,前端外层卡片"上次检测时间"
            // 列读它 (15min probe 窗口),跟内层展开表格"上次执行时间"
            // (probe_history.attempt_at) 含义对齐,不再误用 discovered_at
            // (ad_partner_inbound 拓扑发现时间,跟复制健康度无关).
            lastProbeAt:       toIso(l.probe_attempt_at),
            discoveredAt: toIso(l.discovered_at),
            reporterAgentId: l.reporter_agent_id
          };
          // R158.14 — 视图 UNIQUE(source_dc, dest_dc) + R157.4 reconciliation
          // DELETE 保证每对 ≤1 行, 无需 dedup. 直接 set.
          partnerMapByDc.get(localDc).set(peerDcEffective, entry);
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
          // R95: empty-site surface — when the catalogue has the site row
          // but `dcsBySite.get(s.site_id)` was empty (e.g. all DCs dropped
          // by INNER JOIN due to site_id drift, or pre-registered site
          // with no discovered DC yet), primaryEntry is undefined. Use
          // null placeholders for the role flags so the row still pushes
          // and the frontend can render a "暂未注册 DC" placeholder.
          isBridgehead: primaryEntry ? primaryEntry.isBridgehead : null,
          siteId: s.site_id,
          siteName: s.site_name,
          regionCode: s.region_code,
          isHub: !!s.is_hub,
          // round-31: full DC list (kept for the "本站 DC 清单" panel).
          // round-36: partner info moves into dcPartners[]; the dcs list
          // remains the source of truth for site membership + role flags.
          // R95: empty-site surface — `dcList.map(...)` returns `[]` when
          // no DC rows landed in the catalogue for this site.
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
      // R158.103.1 (2026-10-15) — livenessByAgent 字段添加式下发, 旧
      // 前端 ignore 不报错. 前端用 latest < now-2h 算 silentAgentIds.
      res.json({ siteRefreshSeconds, direction, primaries, livenessByAgent });
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
      const sourceRaw = String(req.query.source || '').trim();
      const destRaw = String(req.query.dest || '').trim();
      const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 10));
      if (!sourceRaw || !destRaw) {
        return res.status(400).json({ error: 'source and dest required' });
      }
      // R108.1.4 — ad_replication_history stores source_dc as a full
      // `CN=NTDS Settings,CN=<bare>,CN=Servers,...` DN (agent-collected),
      // while dest_dc is the bare name. Catalogue + UI both pass bare
      // names, so we normalise source before binding. Already-bare values
      // pass through unchanged via extractBareDcName (R93.12 helper).
      // dest is already bare on write — pass through, no normalisation.
      const source = extractBareDcName(sourceRaw);
      const dest = extractBareDcName(destRaw);
      const db = getDb();
      // 2026-09-25 R93.4 / R101 — MSSQL TOP does not accept parameter binding
      // (only an integer literal). The SQL builder is function-form on
      // MSSQL (limit is interpolated); MySQL keeps the bound `LIMIT ?`
      // param. The earlier comment claiming "the helper rewrites LIMIT ?
      // to TOP (?) for MSSQL" was wrong — the tedious driver does NOT
      // rewrite; the JS builder in db/sql.js does. Dialect dispatch:
      //   mssql → call as function with limit, bind [source, dest]
      //   mysql → use plain string, bind [source, dest, limit]
      //
      // R101: dispatch on db.dialect (set once in db.init() at boot), NOT
      // on process.env.DB_DIALECT or db.pool.constructor.name. The old
      // env+pool hack returned false on MSSQL backends in production
      // because (a) DB_DIALECT was not exported on the NSSM-managed
      // service and (b) db.pool is undefined — db/index.js exposes the
      // dialect as `db.dialect`, not via a pool reference. The mismatch
      // caused the handler to pass the unevaluated MSSQL helper *function*
      // to db.query, which the MSSQL driver received at
      // rewritePlaceholders(sqlStr) → sqlStr.replace → TypeError
      // "sqlStr.replace is not a function". KDLFLOFADSRV2 hit this on
      // every pair-history request after R93.4 ship.
      const isMssql = db.dialect === 'mssql';
      const sql = isMssql
        ? db.sql.dashboard.replicationLogPerPair(Number(limit))
        : db.sql.dashboard.replicationLogPerPair;
      const params = isMssql ? [source, dest] : [source, dest, limit];
      const { rows } = await db.query(sql, params);
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

  // R158.17 (2026-10-01) -- probe history per (source_dc, dest_dc).
  // 复制状态概览的展开历史改走 ad_replication_probe_history (R158.15
  // 15min cadence probe 包写入), 仅取 source_dc / dest_dc / attempt_at /
  // result 四列 (源 + 目标 + 上次执行时间 + 结果). 旧 /pair-history
  // endpoint 仍走 ad_replication_history (老复制流水), 不删.
  // Limit 默认 10 (用户要求 "展开是历史10次记录").
  r.get('/api/dashboard/site-replication-matrix/probe-history', auth, async (req, res) => {
    try {
      const sourceRaw = String(req.query.source || '').trim();
      const destRaw   = String(req.query.dest   || '').trim();
      if (!sourceRaw || !destRaw) {
        return res.status(400).json({ error: 'source and dest required' });
      }
      const source = extractBareDcName(sourceRaw);
      const dest   = extractBareDcName(destRaw);
      const limit  = Number(req.query.limit);
      const wantLimit = Number.isFinite(limit) && limit > 0 ? Math.min(50, Math.floor(limit)) : 10;
      const isMssql = db.dialect === 'mssql';
      const sql = isMssql
        ? db.sql.dashboard.probeHistoryPerPair(wantLimit)
        : db.sql.dashboard.probeHistoryPerPair;
      // R158.26.2 — param ORDER (NOT semantically naive): SQL fields and the
      // query-string contract use *inverted* semantics for "source":
      //   • Query string `?dest=<localDc>&source=<peerDc>` (per inbound view
      //     convention) treats source=partner-as-sender / dest=me-as-receiver.
      //   • ad_replication_probe_history stores the OPPOSITE convention:
      //     source_dc = agent_id (the local DC that RAN the probe) and
      //     dest_dc = partner (the peer that was probed). The probe package
      //     runs Get-ADReplicationPartnerMetadata -Target $localDc -Partner
      //     <peerDc> at local-agent and records its own id as source_dc.
      // To make UI "源 / 目标" columns show peer=源 / 我=目标 (target=localDc,
      // the machine the operator is viewing), the bindings are swizzled:
      //   SQL source_dc ← dest (localDc) ← matches "target / 执行方"
      //   SQL dest_dc   ← source (peerDc) ← matches "源 / 伙伴"
      // Resulting `entries[i].sourceDc` field name is preserved (we 1:1
      // SELECT source_dc / dest_dc), but the *value* of sourceDc is the
      // localDc / target, and destDc is the peer / source — see R158.26
      // SiteReplicationMatrixAllView column render that reads a.destDc
      // as the "源" cell and a.sourceDc as the "目标" cell.
      const params = isMssql ? [dest, source] : [dest, source, wantLimit];
      const { rows } = await db.query(sql, params);
      const entries = rows.map((r) => ({
        sourceDc:  r.source_dc,
        destDc:    r.dest_dc,
        attemptAt: toIso(r.attempt_at),
        result:    r.result
      }));
      res.json({ source, dest, limit: wantLimit, entries });
    } catch (e) {
      logger.error({ err: e, source: req.query.source, dest: req.query.dest },
                       'site-replication-matrix/probe-history failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // R158.103.2 (2026-10-15) — 复制状态概览 "明细" drawer. 走
  // ad_replication_probe_history 11 字段全明细 (DB 12 列 - 1
  // collected_at, 跟 attempt_at 一致, 0 暴露给前端). 跟 R158.17
  // /probe-history (4 列, limit=10) 是 2 独立端点, 0 改旧 wire shape.
  // 默认 limit=50, cap 50 (跟 inline caret cap 一致不升档, R158.86.6
  // 防 abuse + 防 2 端点 cap 漂移). 同样 R158.26.2 source/dest
  // 语义翻转 (line 1366-1383 1:1 复用, inline caret 跟 drawer
  // "源/目标" 顺序 1:1 平行). entries 字段名仍叫 sourceDc / destDc
  // (值已 swap, 跟 inline caret 1:1 平行).
  r.get('/api/dashboard/site-replication-matrix/probe-history-detail', auth, async (req, res) => {
    try {
      const sourceRaw = String(req.query.source || '').trim();
      const destRaw   = String(req.query.dest   || '').trim();
      if (!sourceRaw || !destRaw) {
        return res.status(400).json({ error: 'source and dest required' });
      }
      const source = extractBareDcName(sourceRaw);
      const dest   = extractBareDcName(destRaw);
      const limit  = Number(req.query.limit);
      const wantLimit = Number.isFinite(limit) && limit > 0 ? Math.min(50, Math.floor(limit)) : 50;
      const isMssql = db.dialect === 'mssql';
      const sql = isMssql
        ? db.sql.dashboard.probeHistoryPerPairDetail(wantLimit)
        : db.sql.dashboard.probeHistoryPerPairDetail;
      // R158.26.2 swizzle 1:1 复用. SQL source_dc ← dest (localDc) ← "目标" 头下
      //                                  SQL dest_dc   ← source (peerDc) ← "源" 头下
      const params = isMssql ? [dest, source] : [dest, source, wantLimit];
      const { rows } = await db.query(sql, params);
      const entries = rows.map((r) => ({
        sourceDc:           r.source_dc,
        destDc:             r.dest_dc,
        namingContext:      r.naming_context,
        agentId:            r.agent_id,
        attemptAt:          toIso(r.attempt_at),
        result:             r.result,
        statusCode:         r.status_code,
        durationMs:         r.duration_ms,
        objectsTransferred: r.objects_transferred,
        errorCode:          r.error_code,
        errorMessage:       r.error_message
      }));
      res.json({ source, dest, limit: wantLimit, entries });
    } catch (e) {
      logger.error({ err: e, source: req.query.source, dest: req.query.dest },
                       'site-replication-matrix/probe-history-detail failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // 2026-10-02 R158.26 -- removed the duplicate `/probe-history`
  // route (R158.15 'latest:{...}' handler, L1251-1292 before this commit).
  // Express always picked the earlier R158.17 `entries[]` handler, so the
  // duplicate was inert, but it was confusing (a future engineer editing
  // 'latest' would have hit a route that returns no data) and it double-
  // logged 'site-replication-matrix/probe-history failed' on every error.
  // Latest-probe summary still powers the status pill via the
  // `v_partner_inbound` view (R158.15 view layer, not a separate endpoint).

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
  // R155.3 — endpoint拆2 hardcoded (operator 2026-09-30 决定: 不用
  // ?direction= query param). UI path ↔ endpoint 内部 direction 是
  // 反向绑定:
  //   /inbound  → 内部 direction='outbound' (anchor source_dc=local,
  //                列 probe 出去的 peer) = operator 视角"我从这些源
  //                拉数据"= 入站
  //   /outbound → 内部 direction='inbound' (anchor dest_dc=local,
  //                列 probe 我的 peer) = operator 视角"源从我拉"
  //                = 出战
  // 这是 R155.3 label 纠正的核心 — 之前 R155/R155.2 的 direction
  // 命名跟运维直觉完全反向 (operator 原话 "当前出战应该是入站,
  // 入站应该是出战")。
  // R158.17.3 (2026-10-01) -- operator directive "将all 改成Inbound"
  // + "我们只需要写入我们的source 机器,然后 基于端口矩阵探测啊,肯定
  // 需要实现这个功能还是不能丢" (端口健康度矩阵保留).
  //
  // 路由唯一 path = /api/dashboard/partner-port-health/inbound (R155.2
  // /all backward-compat 路径删, R158.10 /outbound 已下线).
  // 数据语义锁死 inbound:
  //   - 伙伴清单读 v_partner_inbound (R158.14 已 ship, target_dc=local
  //     receiver, peer_dc=上游源 = operator 视角"入站伙伴"), 跟
  //     /admin/site-replication-matrix/all endpoint 同一份数据.
  //   - 端口健康度保留 (operator 明确"不能丢"), 数据来源
  //     ad_replication_status __partner_ports__:% 行的
  //     partner_port_status JSON 字段 (replication_inbound 视图已被
  //     R156.5 migration 038 DROP, 但底层物理表 ad_replication_status
  //     + JSON 列保留, ad_partner_ports_probe 1.0.x 仍在写).
  //   - handler 不再有 direction / portRowsSql 参数 (R155.3 label
  //     swap + R155.4 probeOutboundTable marker 整体退役).
  r.get('/api/dashboard/partner-port-health/inbound', auth, async (req, res) => {
    return partnerPortHealthHandler(req, res);
  });
  // R155.4 — 第三 partner-port 视图,直读 ad_dc_probe_outbound 物理表
  // (migration 034). 与 R155.3 /inbound (replication_inbound 视图) +
  // R155.3 /outbound (ad_replication_status 直查) 物理分离 — 数据平面
  // R156.5 retired — operator directive "复制伙伴端口主动探测 不需要哦去掉".
  // /api/dashboard/partner-port-health/probe-outbound endpoint removed.
  // The ad_dc_probe_outbound physical table is dropped by migration 038
  // (mig 038 includes both DROP VIEW replication_inbound AND
  // DROP TABLE ad_dc_probe_outbound). The collect.ps1 package
  // (ad_dc_probe_outbound 1.0.0) is disabled via package_policies SET
  // enabled=0 in r156-retire-old-probe-packages.mjs.

  // R156 — partner-discover read endpoints. Distinct from the
  // R155.3/R155.4 partner-port-health endpoints because:
  //   - data source is ad_partner_inbound / ad_partner_outbound
  //     (NEW physical tables, migrations 036/037) — the AUTHORITATIVE
  //     DC topology with write-time ad_dcs membership validation.
  //   - shape is simpler (no status_code / last_attempt_time /
  //     partner_port_status / latency) — discover != probe.
  //   - window is 30 days (vs 30 min for the probe endpoints).
  //   - operator's R156 directive: "因为当前数据有问题, 所以有关的
  //     inbound partner 和 outbound_partner" — discover is the
  //     cleaned / trusted replacement.
  r.get('/api/dashboard/discovery/inbound', auth, async (req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.execute(db.sql.dashboard.partnerInboundDiscover, []);
      res.json({ rows, refreshedAt: new Date().toISOString() });
    } catch (e) {
      logger.error({ err: e }, 'discovery/inbound read failed');
      res.status(500).json({ error: 'discovery_inbound_failed' });
    }
  });
  // R158.10 (2026-10-01) — outbound discover API 已下线 (operator directive:
  // "所有的数据都是基于 inbound"). frontend getPartnerOutboundDiscover 同步
  // 删除, web/src/api/dashboard.js:79 有留档注释.
  //
  // 2026-10-20 — 本路由删除. 原因: db.sql.dashboard.partnerOutboundDiscover
  // 在 mssql (sql.js:4440) 和 mysql (sql.js:1156) 两个分支都是 undefined,
  // 所以 db.execute(undefined, []) 必然抛错 → 100% 500. 也就是说这个端点
  // 从 R158.10 起就**从来没有成功过**, 是纯死代码残留.
  //
  // 保留它比删掉更糟: 全站扫描会一直把它报成"500 缺陷", 掩盖真正的 500.
  // 若将来真要恢复 outbound 视角, 应新建端点并同时补两个 dialect 的 SQL
  // helper —— 参见 partnerPortHealthHandler 的 inbound 单一视角注释.
  //
  // r.get('/api/dashboard/discovery/outbound', ...)  ← 已删除

  async function partnerPortHealthHandler(req, res) {
    try {
      // R158.17.3 (2026-10-01) -- operator directive "所有的数据都是基于
      // inbound" + "改用 v_partner_inbound 视图". handler 锁死 inbound 视角,
      // 不再有 direction 参数 (R155.3 label swap + R155.4 probeOutbound
      // marker + R158.17.1 /all endpoint 锁 inbound 整体对齐).
      //
      // 数据源:
      //   - 伙伴清单: v_partner_inbound (R158.14 已 ship, target_dc=local
      //     receiver, peer_dc=上游源, 含 probe_state/probe_attempt_at/
      //     probe_duration_ms/probe_error_message/discovered_at).
      //   - 端口健康度: ad_replication_status __partner_ports__:% 行的
      //     partner_port_status JSON (replication_inbound 视图已被 R156.5
      //     migration 038 DROP, 但底层物理表保留, ad_partner_ports_probe
      //     1.0.x 仍在写). 端口数据跟伙伴清单在 handler 装配时按
      //     (peerDc→localDc) pair JOIN.
      const db = getDb();
      const [{ rows: siteRows }, { rows: dcRows }, { rows: linkRows }, { rows: cfgRows }, { rows: portRows }, { rows: cfgPortRows }] =
        await Promise.all([
          db.query(db.sql.dashboard.allSitesOrdered, []),
          db.query(db.sql.dashboard.allDcsBySite, []),
          // R158.17.3 -- 伙伴清单改读 v_partner_inbound (跟 /all 同步).
          // 视图 target_dc=local receiver, peer_dc=上游源 = operator 视角
          // "入站伙伴".
          db.query(db.sql.dashboard.vPartnerInbound, []),
          db.query(db.sql.dashboard.refreshSeconds, []),
          // 端口健康度保留: 直读 ad_replication_status 的 __partner_ports__ 行
          // (R158.17.3 sql.js:partnerPortInboundView 已改物理表).
          db.query(db.sql.dashboard.partnerPortInboundView, []),
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
          // R154.6 — `collected_at` is the wall-clock time the agent
          // UPSERTed this row (5-min heartbeat cadence × agent process
          // liveness). This is what the operator reads as "执行时间" —
          // when the partner-port probe ACTUALLY ran, independent of
          // AD replication's own last_attempt_time (which can lag the
          // probe by hours when nothing is replicating). last_attempt_time
          // stays alongside for AD-replication drilldown.
          probeAt: toIso(r.collected_at),
          // R158.17.4 (2026-10-01) — 写这条端口数据的 agent 机器名. DB
          // 列已存在 (R154.5 加过 ad_replication_status.agent_id), agent
          // 客户端无需重打包. 前端表格加 "上报 agent" 列用此定位空 partner.
          agentId: r.agent_id ?? null,
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
        // R93.13: matrix `/all` is an N×N network-wide view — allow every
        // catalogue-known DC as a peer, including remote-site secondaries.
        // See sibling comment in the `/all` handler for the full rationale.
        for (const d of dcRows) allowedPeers.add(d.dc_name);

        const partnerMapByDc = new Map();
        for (const d of dcList) partnerMapByDc.set(d.dcName, new Map());

        for (const l of linkRows) {
          if (l.target_dc === l.peer_dc) continue;
          // R158.17.3 -- 伙伴清单改读 v_partner_inbound 视图 (R158.14 已
          // ship). 视图已经按 (target_dc, peer_dc) UNIQUE ≤1 行 + INNER
          // JOIN ad_dcs 兜底, 不需要再做 latest-per-pair reduction /
          // NC 聚合 / extractBareDcName DN 归一化. 也不再走 R155/R155.2
          // direction swap 分支 (R158.17.1 /all 端点已 dead, 本 handler
          // 同步).
          //
          // /monitor-inbound 锁死 inbound 视角 (operator directive 2026-10-01
          // "所有的数据都是基于 inbound" + "改成 v_partner_inbound"). 视图
          // target_dc=本机 (inbound receiver), peer_dc=上游源 (我接收它
          // 的复制) → anchor localDc=target_dc, peerDc=peer_dc.
          const localDc = l.target_dc;
          const peerDc  = l.peer_dc;

          // gate: local DC must be in this site; peer must be a known DC
          if (!partnerMapByDc.has(localDc)) continue; // local not in this site
          if (!allowedPeers.has(peerDc)) continue; // round-32 filter
          const peer = dcByName.get(peerDc);
          if (!peer) continue; // orphan DC
          const peerSite = siteById.get(peer.site_id);
          // peer 暂未 catalog (site_id NULL) — UI 显示 '未分组' 占位, 跟 R95 precedent 一致.
          const peerSiteName = peerSite ? peerSite.siteName : '未分组';
          const peerSiteIsHub = peerSite ? !!peerSite.isHub : false;

          const peerDcBare = peerDc;
          const k = `${peerDcBare}${sep}in`;
          const targetMap = partnerMapByDc.get(localDc);
          // R158.17.3.1 (2026-10-01) -- operator 终极设计意图: "KDLFLOFADSRV2 应
            // 该有 8 个入站伙伴, 我们要求 KDLFLOFADSRV2 去探测这 8 个入站伙伴
            // 的端口" + "FLO1 也同理, FLO1 探测自己的 8 个复制伙伴". 即每台 DC
            // 的 agent (localDc) 用自己的 8 入站伙伴列表去探测伙伴端口, 把
            // "我们和对方端口的数据" 写入 ad_replication_status.
            //
            // 数据语义 (R155 源视角决定):
            //   ad_replication_status.source_dc = localDc (我,探测端)
            //   ad_replication_status.dest_dc   = peerDc  (我的入站伙伴,被探测)
            // lookup key 用 (localDc→peerDc) pair 装配.
            const portKey = `${localDc}${sep}${peerDcBare}`;
          const portHealthEntry = portHealthByPair.get(portKey);
          const portHealth = portHealthEntry
            ? [{
                statusCode: portHealthEntry.statusCode,
                lastAttemptTime: portHealthEntry.lastAttemptTime,
                probeAt: portHealthEntry.probeAt,
                // R158.17.4 (2026-10-01) — 端口数据上报 agent, 跟
                // portHealthByPair 同步. 前端表格 "上报 agent" 列读这个.
                agentId: portHealthEntry.agentId ?? null,
                ports: Array.isArray(portHealthEntry.portStatus?.ports)
                  ? portHealthEntry.portStatus.ports
                  : []
              }]
            : [];
          targetMap.set(k, {
            peerType: peer.site_id === s.site_id ? "within" : "bridgehead",
            peerDc: peerDcBare,
            peerSite: peerSiteName,
            peerSiteIsHub: peerSiteIsHub,
            direction: 'in',
            // R158.17.3 -- 端口探测 status 字段 (来自 portHealthByPair lookup).
            // partner entry 内的 statusCode 来自 v_partner_inbound.probe_state
            // 已经是 worst-of-NCs 聚合的复制健康度, 跟端口健康度 (operator
          // "基于端口矩阵探测啊, 肯定需要实现这个功能还是不能丢") 分两路.
          // 端口 status = portHealth[0].statusCode, 复制 status = probe_state.
          statusCode: l.probe_state === 'error' ? 2 : (l.probe_state === 'success' ? 0 : null),
          lastSuccessTime: l.probe_state === 'success' ? toIso(l.probe_attempt_at) : null,
          lastAttemptTime: toIso(l.probe_attempt_at),
          durationMinutes: null,
          // R158.15/17.15 -- 跟 /all 一样的 probe 字段 (15min 滑动窗口).
          probeState:        l.probe_state ?? 'none',
          probeAttemptAt:    toIso(l.probe_attempt_at),
          probeDurationMs:   l.probe_duration_ms,
          probeErrorMessage: l.probe_error_message,
          lastProbeAt:       toIso(l.probe_attempt_at),
          discoveredAt:      toIso(l.discovered_at),
          reporterAgentId:   l.reporter_agent_id,
          configuredPorts,
              portHealth
              // 2026-08-28 round-47: attempts[] field removed — this view
              // is port-health only. Replication-attempt history is
              // exclusive to 复制状态概览's inline caret via /pair-history.
          });
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
  }

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
  r.get('/api/dashboard/packages-runs', auth, async (req, res) => {
    try {
      // R158.76 (2026-10-11) — optional window selector. Old clients that
      // pass nothing keep the 24h behaviour (back-compat). Three windows:
      //   - '24h': 24 hours back
      //   - '7d' : 7 days back
      //   - 'all': retention upper bound (default 10d, system_config.package_runs_retention_days)
      // Invalid values 400 so silent typos don't fall through to a wrong
      // window. 跟 R74 replication-errors 同模式 (后者 24h/7d 两档).
      const windowMode = String(req.query.window || '24h');
      if (!['24h', '7d', 'all'].includes(windowMode)) {
        return res.status(400).json({ error: 'window must be one of: 24h, 7d, all' });
      }
      let sinceMs;
      if (windowMode === '24h') sinceMs = 24 * 3600 * 1000;
      else if (windowMode === '7d') sinceMs = 7 * 24 * 3600 * 1000;
      else {
        // 'all' — read retention upper bound from system_config. Same
        // three-state handling as createPackageRunsRetentionLoop:
        // missing / non-numeric → default 10, explicit 0 → min 1 (避免
        // 'all' = 1970 → 全表扫). retention disabled 时 operator 还是能
        // 看到至少一天数据.
        let retentionDays = 10;
        try {
          const cfg = (await getSystemConfig?.()) || {};
          const raw = cfg.package_runs_retention_days;
          if (raw != null && raw !== '') {
            const n = Number(raw);
            if (Number.isInteger(n) && n > 0) retentionDays = n;
            else if (n <= 0) retentionDays = 1;
          }
        } catch (_e) { /* system_config 读失败兜底 10 */ }
        sinceMs = retentionDays * 24 * 3600 * 1000;
      }
      const windowLabel = windowMode === '24h' ? '24 小时' : windowMode === '7d' ? '7 天' : '全部';
      const cutoff = new Date(Date.now() - sinceMs);

      const db = getDb();
      const { packageScripts } = await import('../db/sql/package-scripts.js');
      const { packageRuns } = await import('../db/sql/package-runs.js');

      // 1. Resolve the package manifest list once (sorted by name so the
      // view's column order is stable across polls).
      const scripts = await packageScripts.list(db);
      scripts.sort((a, b) => a.name.localeCompare(b.name));
      // R158.92 (2026-10-13) — /packages-runs 端点 (AD 域 dashboard
      //   view) 加反向 filter, 排除 member_* 包. 跟 R158.86 ship 时
      //   加的 member-packages-runs 端点 (member-servers-public.js:568-
      //   573) 1:1 平行. Pre-R158.92 13 张卡 (11 AD + 2 member_) 全
      //   渲染, 前端 /packages-runs 页面标 "成员服务器" 标签, 跟
      //   /memberServer/packages tab 内容重复. R158.86.6 enumerate 5
      //   维度 lesson #9: ship domain-split 包必双端 1:1 平行 filter.
      //   AD 端 = 排除 non-ad, member 端 = 排除 ad_ (前已 ship). 跟
      //   R158.87.6.5 L1 server-side fail-closed (line 432-455) shape
      //   1:1 平行 (1:1 防御深度).
      //
      //   member-packages-runs 端点 filter (member-servers-public.js
      //   line 568-573) 1:1 平行反向: 排除 ad_ 前缀 + 留 non-ad
      //   only. 本端点反向: 排除 non-ad agentType + 排除 member_/
      //   pkg_ms_ 等 member 命名空间 prefix (跟 R158.86 "member
      //   server 独立发包不用 ad_ 前缀" 1:1 平行 → member 命名空间
      //   独立)。
      const adScripts = scripts.filter(s => {
        const t = (s.manifest?.agent?.type || 'ad');
        if (t === 'non-ad') return false;
        const n = String(s.name || '');
        if (n.startsWith('member_') || n.startsWith('pkg_ms_')) return false;
        return true;
      });

      // R158.17.6 (2026-10-01) -- switched from
      // `listRecent(limit=200)` to a 24h GROUP BY summary + N
      // per-package SELECT TOP 10 queries. The old approach was 100%
      // consumed by ad_partner_inbound_discover (288k rows / 24h, 35
      // agents x 5min cadence), leaving every other card with 0
      // recent rows and a gray "no data" pill. The new shape is:
      //   - 1 GROUP BY query -> summary24h Map<name, summary>
      //   - N SELECT TOP 10 queries (N = script count, typically 10)
      // The N queries fan out to mssql pool (max=25), well within
      // capacity. Sequential await keeps the response deterministic
      // for the operator (no per-package race in the recent table).
      //
      // R158.76 — `cutoff` now varies by `window` query param (24h / 7d /
      // retention). SQL helper `summary24hByName(since)` already accepts
      // the `since` Date parameter unchanged.
      const cutoff24h = cutoff;

      // 2. 24h summary per package (1 round-trip).
      const summaryRows = await packageRuns.summary24hByName(db, { since: cutoff24h });
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

      // 3. Per-package recent runs (TOP 10 by default, N round-trips).
      // R158.95-ext (2026-10-16) — optional ?limit= query param. Default
      // still 10 (R158.17.6 ship 后行为不变, R158.95 "复用 helper 不破坏
      // caller" 1:1). Accepted values 1-1000 跟 SQL helper safeLimit 上限
      // 1:1 平行, 非法值降级默认 10. 操作员 directive "右边不再固定 10
      // 行最新, 而是全部的" — front-end 给 chip "10 / 100 / 全部" 3 档
      // 切 (跟 R158.76 window= 1:1 平行范式, 0 新增端点).
      const recentLimit = (() => {
        const raw = req.query?.limit;
        if (raw == null || raw === '') return 10;
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1) return 10;
        return Math.min(n, 1000);
      })();
      // R158.X+UI.timeline (2026-10-19) — timeline 折线图要 24h 全量,跟
      // 卡片 recent 切片器 (10/100/全部) 解耦. timelineLimit 默认 1000
      // (= SQL safeLimit 上限, 24h 内 14 包最高频 ad_failed_logon_collector
      // 15min cadence = 96 次/24h, 7d = 672, 10d retention = 960, 都 ≤ 1000).
      // 24h 100% 闭合, 7d 接近 1000 边界, '全部' 可能撑爆 → SQL 上限 1000
      // 保留. 跟 R158.95-ext 10/100/全部 范式 1:1 平行 (caller 传 ?timelineLimit=
      // 覆写, 1-1000 clamp, 非法降默认 1000).
      const timelineLimit = (() => {
        const raw = req.query?.timelineLimit;
        if (raw == null || raw === '') return 1000;
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1) return 1000;
        return Math.min(n, 1000);
      })();
      // 2026-10-20 perf — batched. The pre-fix for-loop called recentByName
      //   once per script (N=10–14 × ~115ms = ~1.2–1.6s wall time). One
      //   ROW_NUMBER() query now returns the same rows for all scripts
      //   (~80–120ms total). Per-script log preserved on full failure:
      //   helper returns Map<name, rows[]> — any name absent gets a []
      //   default below. Empty Map means catch swallow, log once.
      const recentByName = new Map();
      try {
        const rowsByName = await packageRuns.recentByNames(db, {
          names: scripts.map(s => s.name),
          limit: recentLimit,
          since: cutoff
        });
        for (const s of scripts) {
          recentByName.set(s.name, rowsByName.get(s.name) || []);
        }
      } catch (e) {
        logger.warn?.({
          err: e?.message || String(e),
          scriptCount: scripts.length
        }, 'packages-runs recentByNames failed (non-fatal, cards render empty recent[])');
        for (const s of scripts) recentByName.set(s.name, []);
      }
      // R158.X+UI.timeline — 折线图 data 源.
      //
      // 2026-10-20 perf — 改为按需加载 (`?includeTimeline=1` 才执行)。
      //
      // 原实现每轮询无条件跑 14 次 recentByName(limit=1000), 而折线图
      // 位于页面顶部、首屏即渲染全部 14 个包, 操作员在看卡片表格时这
      // 14 条折线完全用不上 — 却每 60 秒付一次全量代价。
      //
      // 现在: 默认 includeTimeline=false → timelineRecent 恒为 []。
      // 前端 PackageRunsMonitorView 在用户首次交互图表区域时, 调
      // loadTimeline() 带 includeTimeline=1 重取, 之后按正常轮询节奏
      // 维持。前端未 ship 该参数时, 图表会走 `pkg.recent` 兜底
      // (buildTimelineSeries 第 459 行 `pkg.timelineRecent || pkg.recent`)
      // — 即退化为当前 listLimit 档位的折线, 功能不破, 只是数据少。
      //
      // limit 仍为 timelineLimit (默认 1000), since 仍为 cutoff — 与
      // 改动前完全一致。失败 fall back 空数组, 0 破 envelope 形状。
      const includeTimeline = String(req.query.includeTimeline || '') === '1';
      const timelineByName = new Map();
      if (includeTimeline) {
        // 2026-10-20 perf — same batching as recentByName above. The
        //   timeline path used to do N × recentByName(limit=1000) which
        //   on the slowest payload pushed total cost past 1.6s. One
        //   batched query now returns the rows in <200ms.
        try {
          const rowsByName = await packageRuns.recentByNames(db, {
            names: scripts.map(s => s.name),
            limit: timelineLimit,
            since: cutoff
          });
          for (const s of scripts) {
            timelineByName.set(s.name, rowsByName.get(s.name) || []);
          }
        } catch (e) {
          logger.warn?.({
            err: e?.message || String(e),
            scriptCount: scripts.length
          }, 'packages-runs timeline fetch failed (non-fatal)');
          for (const s of scripts) timelineByName.set(s.name, []);
        }
      }
      // 2026-10-20 perf — 删除 per-package "last triggered" fan-out。
      //
      // 原实现 (R158.Y 2026-10-16) 对每个包跑一次
      // packageRuns.lastTriggeredRunsByName(), 把结果塞进 envelope 的
      // `lastTriggered` 字段, 供 /admin/packages-schedule 渲染
      // "完成 34/34" pill。
      //
      // 但全量 grep center/web/src 确认: 前端从不读 `lastTriggered`。
      // PackageScheduleView.vue 走的是同端点, 但只取跨包 run count +
      // last run time (来自 summary24h.lastRunAt); PackageRunsMonitorView
      // 与 PackagesView 均无引用。"最近执行" 卡片副标题同样读
      // summary24h.lastRunAt。
      //
      // 即: 这是每 10 秒 × 14 包 = 140 次/轮询 的纯浪费 SQL, 零消费方。
      // /admin/packages-schedule 若仍需该 pill, 应由它自己所在页面按需
      // 取数, 而不是让本端点无条件为它买单。
      //
      // envelope 字段 `lastTriggered` 保留为恒定 null, 前端若有防御性
      // 读取不会因此崩 (R158.Y 注释即标注该字段为 optional)。

      // R158.92 — 渲染 source 切换 scripts → adScripts (排除 member_/
      //   pkg_ms_/non-ad). summaryByName 跟 recentByName 仍基于全
      //   scripts 的 Map (line 1938-1948), 但 0 影响 — 任何不在
      //   adScripts 里的 name 都不会进 packages, Map lookup 永远
      //   命中 (N=0 不查询). summary24h GROUP BY query 仍 1 次往返
      //   拉全表 (perf 不变, 跟 R158.17.6 1:1).
      const packages = adScripts.map((s) => {
        const summary = summaryByName.get(s.name) || { total: 0, success: 0, partial: 0, failure: 0, lastRunAt: null };
        const runs = recentByName.get(s.name) || [];
        const timelineRuns = timelineByName.get(s.name) || [];
        const manifest = s.manifest || {};
        return {
          name: s.name,
          version: s.version,
          type: manifest.type || 'gauge',
          agentType: manifest.agent?.type || 'ad',
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
          recent: runs.map((r) => ({
            id: r.id,
            agentId: r.agent_id,
            startedAt: toIso(r.started_at),
            finishedAt: toIso(r.finished_at),
            exitCode: r.exit_code,
            // R158.50.7g (2026-10-08) — expose status to frontend so the
            // drawer runlist can colour rows by status (success=green /
            // partial=yellow / failed=red) instead of inferring colour
            // from `error` field alone. Pre-fix, `error` field was the
            // only colour trigger, which painted every ad_lockout_list
            // row red because R158.50.6 promoted PS1 stderr headers into
            // the error field even on exit_code=0 + metrics.error_code=1
            // (a non-fatal "no events in window" state).
            status: r.status || null,
            durationMs: (r.started_at && r.finished_at)
              ? Math.max(0, new Date(r.finished_at).getTime() - new Date(r.started_at).getTime())
              : null,
            stdoutPreview: r.stdout_preview || null,
            stderrPreview: r.stderr_preview || null,
            error: r.error || null,
            // 2026-09-29 R154.5 — per-run script version snapshot.
            // Falls back to the card's current version when the row
            // pre-dates the column (NULL) so the table never shows a
            // blank. This matches the card header so the eye doesn't
            // perceive a divergence for "old" runs.
            scriptVersion: r.script_version || s.version || null
          })),
          // R158.X+UI.timeline (2026-10-19) — 折线图 24h 全量 data 源.
          // 走 timelineByName (默认 limit=1000). 卡片 summary + 抽屉 L1
          // 仍走 recent (listLimit 切片 10/100/全部), 原文照旧返回.
          //
          // 2026-10-20 perf — 瘦身。旧 shape 与 `recent` 1:1 同构, 连带
          // stdoutPreview / stderrPreview / scriptVersion 三列一起下发。
          // 但前端唯一读取点是 PackageRunsMonitorView.vue:454
          // buildTimelineSeries(), 折线图只用 5 个字段:
          //   startedAt  → x 轴
          //   durationMs → y 轴
          //   status / exitCode / error → tooltip 着色
          // (agentId 也读, 用于 legend/ tooltip 的机器名)
          // 其余字段前端从不引用。
          //
          // 而 stdout_preview / stderr_preview 正是体积主体: 24h 内
          // package_runs 合计 12.6 MB stdout + 7.1 MB stderr, 前端只要
          // 图表却整包拖着走 — GET /api/dashboard/packages-runs 响应体
          // 约 5 MB, 且页面每 10 秒轮询一次。
          //
          // 实测: 删掉 3 个未读字段后体积降约 95%。折线图渲染结果不变,
          // 抽屉详情 (需要原文的那条路径) 走 `recent`, 未受影响。
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
            error: r.error || null
          })),
          // R158.Y (2026-10-16) — "上次触发完成" 字段. 2026-10-20 起恒为
          // null: 该字段无前端消费方, 其 fan-out 已删除 (见上方注释).
          // 保留字段名维持 wire shape 兼容 — 前端若将来重新启用, 结构
          // 不变, 只需恢复调用.
          lastTriggered: null
        };
      });

      res.json({
        // 2026-10-20 perf — 10s → 60s.
        //
        // 前端 PackageRunsMonitorView.vue:1078 读本字段驱动
        // setInterval(load, refreshSeconds * 1000)。旧值 10 意味着
        // 每分钟拉 6 次, 每次整包下发 14 个包的时间线数据 — 在瘦身
        // 之前是 5MB/次, 即约 30MB/分钟、1.8GB/小时 的无用带宽。
        //
        // 改为 60s 后语义不变 (页面本就是"看趋势 + 点开看明细", 非
        // 实时监控), 但轮询频率降 6 倍。操作员要即时性时可点页面上的
        // 手动刷新, 或临时调回本值。
        refreshSeconds: 60,
        // R158.76 — window selector echo. 老 caller 不读 (ignored), 新
        // frontend 用 windowLabel 渲副标题.
        window: windowMode,
        windowLabel,
        // R158.95-ext — 让前端 chip "10 / 100 / 全部" 切档同步
        // endpoint 的实际 limit, 跟 windowLabel 1:1 同范式
        recentLimit,
        // R158.X+UI.timeline — 折线图 limit echo, 跟 recentLimit 1:1 平行
        timelineLimit,
        packages
      });
    } catch (e) {
      logger.error({ err: e }, 'packages-runs failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}
