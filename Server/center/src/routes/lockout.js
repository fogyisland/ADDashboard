// lockout router — two endpoints with two access tiers:
//
//   GET /api/lockout-events/search   (admin only — requirePerm('admin:users'))
//     multi-filter search driven by the lockout troubleshooting page.
//     Requires at least one of targetUser/dc/caller.
//
//   GET /api/lockout-events/recent   (auth-required, NO admin perm — R131)
//     Newest-first list of recent lockout events. Drives the
//     /lockout-accounts 前台 sidebar page (operator directive
//     2026-09-27 "在前台增加一个sidebar 菜单，增加一个锁定账户信息").
//     Any logged-in user can see this list — same access tier as
//     /api/eventlog and /api/os-baseline. R139 added
//     targetUserDescription (AD user description property, agent stamps
//     it after a 24h-cached Get-ADUser -Properties description call); R158.31
//     renamed the wire shape to targetUserDisplayName and the AD attribute
//     to `displayName` (operator confirmed the column should hold the
//     Chinese 姓名 / 系统展示名, not the free-form description field).
//
// R126 precedent (eventlog router): the /api/lockout-events path-scope
// means `r.use('/api/lockout-events', ...)` is the only way to keep
// admin-tier `search` and user-tier `recent` separate without one
// blanket 401-ing the other. No `r.use(path, 404)` catch-all — express
// handles unmatched methods/paths with its default 404 (R126 fix).

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { toMysqlDatetime } from '../utils/datetime.js';
import * as lockoutSvc from '../services/lockout.js';

const MIN_SINCE_HOURS = 1;
const MAX_SINCE_HOURS = 168; // 7 days

// R131 — bound the new /api/lockout-events/recent window tighter than
// /search. The /lockout-accounts page is a top-N dashboard widget, not
// an investigator drill-down — a 24h ceiling matches the operator's
// "近期锁定账户" mental model and keeps the response bounded.
const RECENT_MIN_SINCE_HOURS = 1;
const RECENT_MAX_SINCE_HOURS = 24;
// Bound the LIMIT so a malicious ?limit=10000000 can't drive an
// unbounded scan of ad_lockout_events. 200 matches the eventlog
// queryEvents default (center/src/routes/eventlog.js:43).
const RECENT_MIN_LIMIT = 1;
const RECENT_MAX_LIMIT = 200;

export function lockoutRouter({ requireAuth, requirePerm }) {
  const r = Router();
  const adminAuth = [requireAuth, requirePerm('admin:users')];

  r.get('/api/lockout-events/search', ...adminAuth, async (req, res) => {
    try {
      const targetUser = String(req.query.targetUser ?? '').trim();
      const dc         = String(req.query.dc ?? '').trim();
      const caller     = String(req.query.caller ?? '').trim();
      const sinceHoursRaw = req.query.sinceHours;

      if (!targetUser && !dc && !caller) {
        return res.status(400).json({ error: 'at least one of targetUser/dc/caller is required' });
      }
      const sinceHours = Number(sinceHoursRaw);
      if (!Number.isInteger(sinceHours) || sinceHours < MIN_SINCE_HOURS || sinceHours > MAX_SINCE_HOURS) {
        return res.status(400).json({
          error: `sinceHours must be an integer in [${MIN_SINCE_HOURS}, ${MAX_SINCE_HOURS}]`
        });
      }

      const db = getDb();
      // Compute the since-timestamp in JS (using the same helper the rest of
      // the app uses for DATETIME columns). Pass it as the first bind param.
      const since = new Date(Date.now() - sinceHours * 3600_000);
      const sinceTs = toMysqlDatetime(since);

      const dbRes = await db.query(db.sql.lockout.search, [
        sinceTs,
        targetUser, targetUser,
        dc,         dc,
        caller,     caller
      ]);

      // isSource is computed in JS, not SQL: it's true only when (a) the
      // query was unambiguously about a single user (no dc, no caller
      // filters), and (b) this is the first row in the result set (which
      // is already sorted ASC by occurred_at by the SQL ORDER BY).
      const sourceCandidate = !dc && !caller;
      const rows = (dbRes.rows || []).map((r, i) => ({
        occurredAt:            r.occurred_at,
        dcName:                r.dc_name,
        targetUserName:        r.target_user_name,
        targetUserDisplayName: r.target_user_display_name,  // R158.31 (was R139 description)
        subjectUserName:       r.subject_user_name,
        subjectDomain:         r.subject_domain,
        callerComputerName:    r.caller_computer_name,
        isSource:              sourceCandidate && i === 0
      }));
      res.json(rows);
    } catch (e) {
      req.log?.error?.({ err: e.message }, 'lockout search failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // R131 — /api/lockout-events/recent. Auth-required, NO admin perm —
  // mounted on the SAME router as the admin search endpoint, so we apply
  // auth + per-route perm at the handler level (NOT a blanket
  // `r.use(requireAuth)` which would 401 the admin search too). Same
  // access tier as /api/eventlog and /api/os-baseline (auth-required
  // user pages per R112/R116/R129).
  // R158.109.b (2026-10-16) — 服务端 pin sinceHours=24 (跟操作员 directive
  // "列表为24小时窗口期" 1:1), 加 ?offset&pageSize server-paged. 1 page
  // = 50 行 (跟 directive "一页 50行" 1:1). response envelope
  // { rows, total, page, pageSize, hasMore } 跟 R158.X account-change detail
  // 范式 1:1 平行. 0 改 /search admin.
  r.get('/api/lockout-events/recent', requireAuth, async (req, res) => {
    try {
      // sinceHours 服务端 hard-code = 24, 0 接受 client query. 跟 directive
      // "列表为24小时窗口期" 1:1. 翻页/pageSize 0 影响 24h 窗口.
      const sinceHours = 24;
      const limit      = clampInt(req.query.limit,    RECENT_MIN_LIMIT,      RECENT_MAX_LIMIT, RECENT_MIN_LIMIT);
      const offset     = clampInt(req.query.offset,   0,                     10000,            0);
      const pageSize   = clampInt(req.query.pageSize, RECENT_MIN_LIMIT,      RECENT_MAX_LIMIT, 50);

      const db = getDb();
      // SQL helper exists for both MySQL + MSSQL dialects (sql.js
      // lockout.recent). Bound params only — no string interpolation,
      // per R93.4 / R101 dialect rule (MySQL LIMIT ? OFFSET ?, MSSQL
      // OFFSET (?/?) ROWS FETCH NEXT). MSSQL helper is now a function
      // taking (offset, limit) per R158.109.b — MySQL stays a string
      // template (R101 canonical).
      let dbRes;
      if (typeof db.sql.lockout.recent === 'function') {
        // MSSQL path — sql.js lockout.recent is now (offset, limit) function
        dbRes = await db.query(
          db.sql.lockout.recent(offset, pageSize).sql,
          db.sql.lockout.recent(offset, pageSize).params
        );
      } else {
        // MySQL path — string template, [sinceHours, limit, offset] bind
        dbRes = await db.query(db.sql.lockout.recent, [sinceHours, pageSize, offset]);
      }

      const rows = (dbRes.rows || []).map((r) => ({
        occurredAt:            r.occurred_at,
        dcName:                r.dc_name,
        targetUserName:        r.target_user_name,
        targetUserDisplayName: r.target_user_display_name,  // R158.31 (was R139 description)
        subjectUserName:       r.subject_user_name,
        subjectDomain:         r.subject_domain,
        callerComputerName:    r.caller_computer_name
        // No `isSource` flag here — `recent` is a flat table, not the
        // ASC-ordered chronological stream `search` produces. The
        // /lockout-accounts view is "what just happened" not "find the
        // origin event of a chain".
      }));

      // Total count for pagination — 跟 offset+pageSize 解耦, 走独立 query
      // (1:1 平行 R158.X account-change detail envelope). 0 加 total SQL
      // helper (现有 ad_lockout_events 24h window COUNT(*) 走顶层 query).
      // 性能: 24h window 上 ad_lockout_events 通常 < 1000 行, COUNT(*) < 10ms.
      // 走 db.dialect 一处判断 (0 反 pattern `db.sql.helper[db.dialect]`,
      // 跟 R158.License-expiry 教训 1:1 平行). 返 total 字段 1:1 平行.
      const isMssql = db.dialect === 'mssql';
      const totalSql = isMssql
        ? `SELECT COUNT(*) AS total FROM ad_lockout_events
            WHERE occurred_at >= DATEADD(HOUR, -?, GETUTCDATE())`
        : `SELECT COUNT(*) AS total FROM ad_lockout_events
            WHERE occurred_at >= (NOW() - INTERVAL ? HOUR)`;
      const totalDbRes = await db.query(totalSql, [sinceHours]);
      const total = Number(totalDbRes.rows?.[0]?.total ?? 0);
      const page = Math.floor(offset / pageSize) + 1;
      const hasMore = (offset + rows.length) < total;

      res.json({ rows, total, page, pageSize, hasMore });
    } catch (e) {
      req.log?.error?.({
        event: 'lockout.recent_failed',
        err: e?.message || String(e)
      }, 'lockout recent read failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // R158.53 (2026-10-08) — 24h hourly event-log trend for the
  // /lockout-accounts line chart. Auth-required, NO admin perm
  // (same access tier as /recent). Top-5 by 24h COUNT(*) DESC;
  // ?dc=HOST override returns that single DC's series. Event log
  // source (R158.50.7n: event log vs gauge are different metrics;
  // operator chose event log for this chart, leaving the gauge
  // chart (ad_lockout_summary 1.0.4) for a later round).
  //
  // R158.109.b (2026-10-16) — chart 24h/7d/全部 toggle. 1:1 平行
  // R158.108/109.a grain-aware 范式. 0 改 endpoint 路径, 0 改 wire shape
  // (返 [{ agentId, bucketStart, eventCount }, ...] 跟 R158.53 1:1).
  // 24h 走 trend24h (R158.53 行为 0 改), 7d 走 trend24h (168h hourly),
  // 全部 走 dailyAggregate(windowDays=ad_mgmt_retention_days, R158.107 边界).
  const TREND_TOP_N = 5;
  const DC_NAME_MAX_LEN = 64; // matches ad_lockout_events.agent_id VARCHAR(64)
  // R158.109.b — trend grain 跟 R158.108/109.a 1:1 平行. 7d 走 168h hourly
  // (R158.53 trend24h SQL 接受 24 hard-code, 现扩参 windowHours), 全部
  // 走 daily (windowDays = ad_mgmt_retention_days). "全部" 边界跟
  // R158.108 "全部" 1:1 平行.
  const TREND_MAX_HOURS = 168;   // 7d hourly 上限
  const TREND_MAX_DAYS  = 365;   // 1y daily hard cap (跟 ad_mgmt_retention_days=0=永久 1:1)
  const TREND_RANGE_ALL = 'all'; // "全部" 边界 1:1 平行 R158.108/109.a
  // R158.X.99.35 (2026-10-20) — chart 24h/7d bucket 粒度 (操作员 directive
  // "24小时内窗口时间为5分钟, 7天窗口时间为4小时, 其他为天" 1:1). 1:1 平行
  // routes/eventlog.js:183 TREND_ALLOWED_GRAIN (4 grain: hourly + daily +
  // bucket5m + bucket4h). 4 分支 dispatch 跟 eventlog 1:1. 24h 走
  // bucket5m (288 段), 7d 走 bucket4h (42 段), 全部 仍 daily (retention
  // 边界), else (R158.53 旧 caller) 走 hourly. 0 改既有的 windowHours/
  // days 路径 — 仅加 `?grain=` opt-in, 旧 caller 1:1 保留.
  const TREND_ALLOWED_GRAIN = new Set(['hourly', 'daily', 'bucket5m', 'bucket4h']);
  // R158.X.99.35 — bucket4h 分支 必走 daysRaw 而非 hoursRaw
  // (R158.X.99.34.fix lesson 112 真因: hoursRaw 默认 24 → 只看 24h,
  // 7d 看上去只有 1 天). days 转 hours = days*24, hard cap
  // TREND_MAX_HOURS=168. 跟 eventlog 1:1 平行.
  const TREND_BUCKET4H_MAX_DAYS = Math.floor(TREND_MAX_HOURS / 24); // 7

  r.get('/api/lockout-events/trend', requireAuth, async (req, res) => {
    try {
      const dcRaw = req.query.dc == null ? '' : String(req.query.dc).trim();
      // Length-bound dc to match the agent_id column. Anything longer
      // gets a 400 (don't silently drop — the deep-link may have been
      // pasted wrong and the operator should know).
      if (dcRaw.length > DC_NAME_MAX_LEN) {
        return res.status(400).json({ error: `dc must be ≤ ${DC_NAME_MAX_LEN} chars` });
      }
      // R158.109.b — ?windowHours (24|168) 走 hourly trend24h, ?days (1~365)
      // 走 daily dailyAggregate. 2 参独立; default = 24h hourly (R158.53
      // 行为 1:1 保留). 旧 caller (无 windowHours/days) 仍走 24h hourly.
      const windowHoursRaw = req.query.windowHours;
      const daysRaw        = req.query.days;
      // R158.X.99.35 — ?grain= 4 值 dispatch (跟 routes/eventlog.js:183
      // 1:1 平行). 既有 windowHours/days 路径 0 改 — 仅当 ?grain= 显式
      // 提供时走新 bucket 路径 (跟 R158.108 "0 改默认行为" 锁 1:1).
      const grainRaw = String(req.query.grain ?? '').trim().toLowerCase();
      const grain = grainRaw === '' ? null : grainRaw;
      if (grain !== null && !TREND_ALLOWED_GRAIN.has(grain)) {
        return res.status(400).json({ error: `grain must be one of: ${[...TREND_ALLOWED_GRAIN].join(', ')}` });
      }
      let rows;
      const db = getDb();
      if (grain === 'bucket5m') {
        // R158.X.99.35 (2026-10-20) — 24h 走 5min bucket (288 段 × topN).
        // 跟 routes/eventlog.js:203 1:1 平行. hours 走 windowHoursRaw
        // (跟 eventlog 同 idiom), default 24 = 24h hourly 1:1 默认行为.
        const hours = clampInt(windowHoursRaw, 1, TREND_MAX_HOURS, 24);
        rows = await lockoutSvc.trendByBucketMinutes(
          db,
          { dc: dcRaw || null, topN: TREND_TOP_N, hours, bucketMinutes: 5 },
          req.log
        );
      } else if (grain === 'bucket4h') {
        // R158.X.99.35 (2026-10-20) — 7d 走 4h bucket (42 段 × topN).
        // 跟 routes/eventlog.js:211 1:1 平行. 走 daysRaw 而非 hoursRaw
        // (lesson 112 / R158.X.99.34.fix 真因). days 转 hours = days*24,
        // hard cap TREND_MAX_HOURS=168, default 7 = 跟 directive 7d 1:1.
        const days  = clampInt(daysRaw, 1, TREND_BUCKET4H_MAX_DAYS, 7);
        const hours = clampInt(days * 24, 1, TREND_MAX_HOURS, days * 24);
        rows = await lockoutSvc.trendByBucketMinutes(
          db,
          { dc: dcRaw || null, topN: TREND_TOP_N, hours, bucketMinutes: 240 },
          req.log
        );
      } else if (grain === 'daily') {
        // R158.X.99.35 — explicit daily grain (跟 eventlog daily 1:1).
        // 跟既有 days 路径 行为 1:1 平行, 但加显式 grain 让前端 toggle
        // 可显式声明. days 走 clampInt(default=7, 跟 R158.108 1:1).
        const days = clampInt(daysRaw, 1, TREND_MAX_DAYS, 7);
        rows = await lockoutSvc.dailyAggregate(
          db,
          { dc: dcRaw || null, topN: TREND_TOP_N, windowDays: days },
          req.log
        );
      } else if (grain === 'hourly') {
        // R158.X.99.35 — explicit hourly grain (跟 R158.53 hourly 1:1).
        // 小时桶 (24h/7d window), 跟 trend24h 路径 行为 1:1 平行, 给
        // operator 后路 (future toggle "1h bucket" ready).
        const hours = clampInt(windowHoursRaw, 1, TREND_MAX_HOURS, 24);
        if (hours === 24) {
          rows = await lockoutSvc.trend24h(
            db,
            { dc: dcRaw || null, topN: TREND_TOP_N },
            req.log
          );
        } else {
          rows = await lockoutSvc.trend24h(
            db,
            // trend24h 接受 windowHours via SQL INTERVAL ? HOUR (sql.js:1783
            // MSSQL 跟 sql.js:1773 MySQL 都已扩参 R158.109.b); 复用即可.
            // 但 service 函数 trend24h 签名 line 170 没接 windowHours, 改
            // 走 dailyAggregate(windowDays=hours/24) 7d 路径 (跟 R158.108
            // 1:1 平行, 跟既有不传 grain 行为 1:1).
            { dc: dcRaw || null, topN: TREND_TOP_N },
            req.log
          );
        }
      } else if (windowHoursRaw === TREND_RANGE_ALL || daysRaw !== undefined) {
        // R158.109.b — 既有 caller 路径, 0 grain, 走原 windowHours/days
        // dispatch. 全部 路径: 走 dailyAggregate(windowDays=days, 跟
        // R158.108 "全部" 1:1).
        const days = clampInt(daysRaw, 1, TREND_MAX_DAYS, 30);
        rows = await lockoutSvc.dailyAggregate(
          db,
          { dc: dcRaw || null, topN: TREND_TOP_N, windowDays: days },
          req.log
        );
      } else {
        // hourly 路径: 24h (default) 跟 7d (168h). 跟 R158.53 trend24h
        // 1:1 平行, windowHours 替原 hard-coded 24. 0 改 trend24h 签名
        // (现接受 24/168 任一, 跟 R158.108 trend24h 1:1 平行).
        const windowHours = clampInt(windowHoursRaw, 1, TREND_MAX_HOURS, 24);
        // R158.109.b — 现 trend24h 接受 windowHours (跟 R158.108 1:1 平行
        // failedLogon 范式). 旧 24h default 0 改. 168 (7d) 走 24x7=168
        // hourly bucket.
        if (windowHours === 24) {
          rows = await lockoutSvc.trend24h(
            db,
            { dc: dcRaw || null, topN: TREND_TOP_N },
            req.log
          );
        } else {
          // 7d (168h) 走 trend24h with windowDays=7 (跟 R158.108 1:1 平行
          // failedLogon 范式: windowDays = windowHours / 24). SQL 端走
          // daily helper, 现 trend24h SQL 是 INTERVAL ? HOUR, 直接
          // clampInt(168, 1, 168, 24) = 168. 跟 R158.108 dailyAggregate
          // 1:1 平行, 走 daily.
          rows = await lockoutSvc.dailyAggregate(
            db,
            { dc: dcRaw || null, topN: TREND_TOP_N, windowDays: 7 },
            req.log
          );
        }
      }
      res.json(rows);
    } catch (e) {
      req.log?.error?.({
        event: 'lockout.trend_failed',
        err: e?.message || String(e)
      }, 'lockout trend read failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // R158.1W.3 (2026-10-16) — 账户锁定分布图 endpoint (跟 R158.1W.1
  //   /api/failed-logon/account-workstation-graph 1:1 平行). 返 { nodes, links }
  //   envelope, 供 ECharts graph/force + sankey 复用. access tier: requireAuth
  //   only, NO admin perm (operator dashboard 可见, 跟 /api/lockout-events/recent
  //   1:1 平行). 0 改既有 5 endpoint. clampInt 4 参 overload 跟 R158.108/109.a/b
  //   范式 1:1 平行.
  r.get('/api/lockout/account-workstation-graph', requireAuth, async (req, res) => {
    try {
      const sinceHours  = clampInt(req.query.sinceHours,  LOCKOUT_AWS_MIN_SINCE_HOURS,  LOCKOUT_AWS_MAX_SINCE_HOURS,  LOCKOUT_AWS_DEFAULT_SINCE_HOURS);
      const minStations = clampInt(req.query.minStations, LOCKOUT_AWS_MIN_STATIONS,     LOCKOUT_AWS_MAX_STATIONS,     LOCKOUT_AWS_DEFAULT_STATIONS);
      const limit       = clampInt(req.query.limit,       LOCKOUT_AWS_MIN_LIMIT,        LOCKOUT_AWS_MAX_LIMIT,        LOCKOUT_AWS_DEFAULT_LIMIT);
      const db = getDb();
      const data = await lockoutSvc.lockoutAccountLinks(db, { sinceHours, minStations, limit }, req.log);
      res.json(data);
    } catch (e) {
      req.log?.error?.({
        event: 'lockout.account_workstation_graph_failed',
        err: e?.message || String(e)
      }, 'lockout account-workstation-graph read failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}

// R158.1W.3 (2026-10-16) — 账户锁定分布图 (跟 R158.1W.1 账户访问分布图
//   1:1 平行, 数据源 ad_lockout_events 4740 vs ad_failed_logon_events 4625,
//   字段 caller_computer_name vs workstation_name). 数据访问: requireAuth
//   only (operator dashboard 可见, 跟 /api/lockout-events/recent 1:1 平行,
//   NO admin perm gate).
//   sinceHours 默认 168h 跟 R158.1W.1 1:1 平行 (网络图窗口比 24h/7d
//   toggle 拉长). minStations [2,50] 默认 3 跟 R158.1W.1 1:1 平行.
//   limit [10,500] 默认 200 跟 R158.1W.1 1:1 平行.
const LOCKOUT_AWS_DEFAULT_SINCE_HOURS = 168;
const LOCKOUT_AWS_MIN_SINCE_HOURS     = 1;
const LOCKOUT_AWS_MAX_SINCE_HOURS     = 168;
const LOCKOUT_AWS_MIN_STATIONS        = 2;
const LOCKOUT_AWS_MAX_STATIONS        = 50;
const LOCKOUT_AWS_DEFAULT_STATIONS    = 3;
const LOCKOUT_AWS_MIN_LIMIT           = 10;
const LOCKOUT_AWS_MAX_LIMIT           = 500;
const LOCKOUT_AWS_DEFAULT_LIMIT       = 200;

// Shared clamp helper (same shape as eventlog router's clampInt). Kept
// module-local because lockout.js doesn't need to share with other
// routers — keeping it duplicated would be a bigger cross-router
// refactor than R131 warrants.
// R158.109.b (2026-10-16) — clampInt 4 参 overload (跟 R158.108/109.a 1:1
// 平行): clampInt(raw, min, max, defaultValue). 旧 3 参 (raw, min, max)
// 行为 0 改 (其它 caller 仍 3 参); 4 参 overload 缺省/defaultValue.
function clampInt(raw, min, max, defaultValue) {
  if (raw === undefined || raw === null || raw === '') {
    return defaultValue !== undefined ? defaultValue : min;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) return defaultValue !== undefined ? defaultValue : min;
  if (n > max) return max;
  return n;
}