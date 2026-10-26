// R158.50 (2026-10-06) — failed-logon router. 3 endpoints all auth-
// required, NO admin perm (same access tier as /api/eventlog /
// /api/lockout-events/recent / /api/os-baseline — operator dashboard
// pages visible to all logged-in users).
//
//   GET /api/failed-logon/timeseries?sinceHours=24
//     Hourly bucket aggregate driving the 24h / 7d line chart on the
//     /failed-logon-2h dashboard page. sinceHours clamped to [1, 168]
//     to cover both the 24h (1d) and 7d toggle states.
//
//   GET /api/failed-logon/recent?sinceHours=24&limit=100
//     Reverse-chronological detail table for the same dashboard page.
//     Default 100 rows; limit clamped to [1, 500].
//
//   GET /api/failed-logon/search?dc=&user=&ip=&sinceHours=24&limit=200
//     Drill-down filter (operator can find "who tried joe.smith from
//     which IP"). Empty filter strings mean "no filter on this column".
//
// Path-scoped middleware (R126 / R131 precedent): the auth middleware
// is applied per-handler here so each route is independent — no blanket
// `r.use(requireAuth)` that would accidentally blanket-401 a future
// admin-only endpoint added to this router.

import { Router } from 'express';
import { getDb } from '../db/index.js';
import * as failedLogon from '../services/failed-logon.js';

const MIN_SINCE_HOURS = 1;
const MAX_SINCE_HOURS = 168; // 7d ceiling — covers both toggle states

const RECENT_MIN_LIMIT = 1;
const RECENT_MAX_LIMIT = 500;

const SEARCH_MIN_LIMIT = 1;
const SEARCH_MAX_LIMIT = 500;

// R158.109 (2026-10-16) — 24h/7d/全部 toggle (1:1 平行 R158.108 eventlog).
// 0 改 endpoint path, 0 改 response shape. 24h 走 hourly (R158.50 行为 0 改),
// 7d/全部 走 daily. "全部" = ad_mgmt_retention_days (R158.107 retention).
//
// R158.X.99.36 (2026-10-20) — 升 4 grain (1:1 平行 routes/lockout.js:210
// TREND_ALLOWED_GRAIN):
//   'hourly'   → hourlyAggregate (R158.50 行为 0 改, 默认 fallback)
//   'daily'    → dailyAggregate    (R158.109 行为 0 改)
//   'bucket5m' → trendByBucketMinutes(bucketMinutes=5,   24h/288 段)
//   'bucket4h' → trendByBucketMinutes(bucketMinutes=240, 7d/42 段).
// 0 改 endpoint path. 既 windowHours/days 无 grain 0 改 (legacy fallback 保留).
const TREND_DEFAULT_HOURS = 24;
const TREND_MAX_HOURS     = 168;   // 7d hourly 上限
const TREND_MAX_DAYS      = 365;   // 1y daily hard cap (跟 ad_mgmt_retention_days=0=永久 1:1)
// R158.X.99.36 — 升 4 grain (1:1 平行 routes/lockout.js:210).
const TREND_ALLOWED_GRAIN = new Set(['hourly', 'daily', 'bucket5m', 'bucket4h']);
// R158.X.99.36 — bucket4h 最大 window (天). 7 = floor(168/24). 跟 lockout 1:1.
const TREND_BUCKET4H_MAX_DAYS = Math.floor(TREND_MAX_HOURS / 24); // 7

// R158.55 (2026-10-08) — top-N workstation clamps. topN [1,20]
// matches lockout-events precedent (lockout.trend24h rejects outside
// the range). 20 is the dashboard ceiling for any single chart
// before ECharts legend pagination overwhelms the row layout.
const BY_WS_MIN_TOPN = 1;
const BY_WS_MAX_TOPN = 20;

// R158.1W.1 (2026-10-16) — 账户访问分布图 (原名: 账户-工作站关联网络图, graph + sankey 双形态).
//   sinceHours 默认 7d 168h (网络图窗口比 24h/7d toggle 拉长, 1:1 平行 R158.109.a
//   failed-logon-2h 24h/7d 范式, 但默认 7d 起点). minStations [2,50] 默认 3
//   (账户在 N 个不同工作站登录 = "lateral movement" 评估维度). limit [10,500] 默认 200
//   (端点 cap 防 graph 爆, 跟 BY_WS_MAX_TOPN=20 1:1 平行思路但拉到 200 因为节点 × 边密度更高).
const AWS_DEFAULT_SINCE_HOURS = 168;
const AWS_MIN_SINCE_HOURS     = 1;
const AWS_MAX_SINCE_HOURS     = 168;
const AWS_MIN_STATIONS        = 2;
const AWS_MAX_STATIONS        = 50;
const AWS_DEFAULT_STATIONS    = 3;
const AWS_MIN_LIMIT           = 10;
const AWS_MAX_LIMIT           = 500;
const AWS_DEFAULT_LIMIT       = 200;

export function failedLogonRouter({ requireAuth }) {
  const r = Router();

  // ── /timeseries ──────────────────────────────────────────────
  r.get('/api/failed-logon/timeseries', requireAuth, async (req, res) => {
    try {
      // R158.X.99.36 (2026-10-20) — 升维 4 grain bucket (操作员 directive
      // "密码错误监控也按照这种方式进行操作" + "时间是事件触发时间" 1:1 平行
      // routes/lockout.js 4-branch dispatch + R158.X.99.33+.34 eventlog 范式).
      // 0 改 endpoint path, 0 改 response shape (route reshape → [{ bucketStart, count }]).
      // 既 windowHours/days 无 grain fallback 0 改 (R158.50 + R158.109 caller 1:1 保留).
      const hoursRaw = req.query.windowHours;
      const daysRaw  = req.query.days;
      const grainRaw = String(req.query.grain ?? '').trim().toLowerCase();
      const grain    = grainRaw === '' ? null : grainRaw;
      if (grain !== null && !TREND_ALLOWED_GRAIN.has(grain)) {
        return res.status(400).json({ error: `grain must be one of: ${[...TREND_ALLOWED_GRAIN].join(', ')}` });
      }
      const db = getDb();
      let rows;
      if (grain === 'bucket5m') {
        // R158.X.99.36 — 24h 走 5min bucket (288 段, 跟 routes/lockout.js:241 1:1 平行).
        const hours = clampInt(hoursRaw, 1, TREND_MAX_HOURS, TREND_DEFAULT_HOURS);
        rows = await failedLogon.trendByBucketMinutes(db, { hours, bucketMinutes: 5 }, req.log);
      } else if (grain === 'bucket4h') {
        // R158.X.99.36 — 7d 走 4h bucket (42 段, 跟 routes/lockout.js:251 1:1 平行).
        // 走 daysRaw 而非 hoursRaw (R158.X.99.34.fix lesson 112 真因: hoursRaw
        // 默认 24 → 只看 24h, 7d 看上去只有 1 天). days 转 hours = days*24,
        // hard cap TREND_MAX_HOURS=168 (=TREND_BUCKET4H_MAX_DAYS*24=7*24).
        const days  = clampInt(daysRaw, 1, TREND_BUCKET4H_MAX_DAYS, 7);
        const hours = clampInt(days * 24, 1, TREND_MAX_HOURS, days * 24);
        rows = await failedLogon.trendByBucketMinutes(db, { hours, bucketMinutes: 240 }, req.log);
      } else if (grain === 'daily') {
        // 7d/全部走 daily (R158.109 行为 0 改). days 默认 7 跟 "7d" 按钮 1:1.
        // "全部" 前端传 ad_mgmt_retention_days (R158.107 retention 边界, 默认 30).
        const days = clampInt(daysRaw, 1, TREND_MAX_DAYS, 7);
        rows = await failedLogon.dailyAggregate(db, { days }, req.log);
      } else if (grain === 'hourly') {
        // 24h 走 hourly (R158.50 行为 0 改, 1:1 平行).
        const hours = clampInt(hoursRaw, 1, TREND_MAX_HOURS, TREND_DEFAULT_HOURS);
        rows = await failedLogon.hourlyAggregate(db, { sinceHours: hours }, req.log);
      } else if (daysRaw !== undefined) {
        // legacy fallback: 无 grain + days 传 → dailyAggregate (R158.109 行为 1:1 保留).
        const days = clampInt(daysRaw, 1, TREND_MAX_DAYS, 7);
        rows = await failedLogon.dailyAggregate(db, { days }, req.log);
      } else {
        // legacy fallback: 无 grain + 仅 windowHours → hourlyAggregate (R158.50 行为 1:1 保留).
        const hours = clampInt(hoursRaw, 1, TREND_MAX_HOURS, TREND_DEFAULT_HOURS);
        rows = await failedLogon.hourlyAggregate(db, { sinceHours: hours }, req.log);
      }
      const out = (rows || []).map((r) => ({
        bucketStart: r.bucket_start,
        count:       Number(r.event_count ?? 0)
      }));
      res.json(out);
    } catch (e) {
      req.log?.error?.({
        event: 'failed_logon.timeseries_failed',
        err: e?.message || String(e)
      }, 'failed-logon timeseries read failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ── /recent ──────────────────────────────────────────────────
  r.get('/api/failed-logon/recent', requireAuth, async (req, res) => {
    try {
      const sinceHours = clampInt(req.query.sinceHours, MIN_SINCE_HOURS, MAX_SINCE_HOURS);
      const limit      = clampInt(req.query.limit,    RECENT_MIN_LIMIT, RECENT_MAX_LIMIT);
      const db = getDb();
      const rows = await failedLogon.recent(db, { sinceHours, limit }, req.log);
      const out = (rows || []).map(shapeRow);
      res.json(out);
    } catch (e) {
      req.log?.error?.({
        event: 'failed_logon.recent_failed',
        err: e?.message || String(e)
      }, 'failed-logon recent read failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ── /search ──────────────────────────────────────────────────
  r.get('/api/failed-logon/search', requireAuth, async (req, res) => {
    try {
      const sinceHours = clampInt(req.query.sinceHours, MIN_SINCE_HOURS, MAX_SINCE_HOURS);
      const limit      = clampInt(req.query.limit,    SEARCH_MIN_LIMIT, SEARCH_MAX_LIMIT);
      const dc         = String(req.query.dc   ?? '').trim();
      const userName   = String(req.query.user ?? '').trim();
      const ipAddress  = String(req.query.ip   ?? '').trim();
      const db = getDb();
      const rows = await failedLogon.search(
        db, { sinceHours, dcName: dc, userName, ipAddress, limit }, req.log
      );
      const out = (rows || []).map(shapeRow);
      res.json(out);
    } catch (e) {
      req.log?.error?.({
        event: 'failed_logon.search_failed',
        err: e?.message || String(e)
      }, 'failed-logon search read failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // R158.55 (2026-10-08) — top-N workstation aggregate for the
  // "按锁定服务器" toggle on /failed-logon-2h. requireAuth, NO admin
  // perm (same access tier as /recent / /search). topN [1,20] +
  // sinceHours [1,168] clamps mirror the lockout-events trend24h
  // contract so the pivot helper on the front-end stays generic.
  r.get('/api/failed-logon/by-workstation', requireAuth, async (req, res) => {
    try {
      const sinceHours = clampInt(req.query.sinceHours, MIN_SINCE_HOURS, MAX_SINCE_HOURS);
      const topN       = clampInt(req.query.topN,       BY_WS_MIN_TOPN,  BY_WS_MAX_TOPN);
      const db = getDb();
      const rows = await failedLogon.aggregateByWorkstation(db, { sinceHours, topN }, req.log);
      res.json(rows);
    } catch (e) {
      req.log?.error?.({
        event: 'failed_logon.by_workstation_failed',
        err: e?.message || String(e)
      }, 'failed-logon by-workstation read failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // R158.55 — hourly bucket trend per workstation. ?workstation=HOST
  // override narrows to a single workstation series; default is
  // top-N mode. R158.55.1 follow-up may add deep-link support on the
  // front-end (R158.55 minimum scope ships URL-less).
  r.get('/api/failed-logon/timeseries-by-workstation', requireAuth, async (req, res) => {
    try {
      const windowHours = clampInt(req.query.windowHours, MIN_SINCE_HOURS, MAX_SINCE_HOURS);
      const topN        = clampInt(req.query.topN,        BY_WS_MIN_TOPN,  BY_WS_MAX_TOPN);
      const workstation = req.query.workstation ? String(req.query.workstation).trim() : null;
      const db = getDb();
      const rows = await failedLogon.trendByWorkstation(db, { windowHours, topN, workstation }, req.log);
      res.json(rows);
    } catch (e) {
      req.log?.error?.({
        event: 'failed_logon.timeseries_by_workstation_failed',
        err: e?.message || String(e)
      }, 'failed-logon timeseries-by-workstation read failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // R158.57 (2026-10-09) — top-N DC aggregate for the "按认证 DC"
  // toggle on /failed-logon-2h. requireAuth, NO admin perm (same
  // access tier as /by-workstation). sinceHours [1,168] + topN [1,20]
  // clamps mirror by-workstation so the pivot helper on the front-end
  // stays generic.
  r.get('/api/failed-logon/by-dc', requireAuth, async (req, res) => {
    try {
      const sinceHours = clampInt(req.query.sinceHours, MIN_SINCE_HOURS, MAX_SINCE_HOURS);
      const topN       = clampInt(req.query.topN,       BY_WS_MIN_TOPN,  BY_WS_MAX_TOPN);
      const db = getDb();
      const rows = await failedLogon.aggregateByDc(db, { sinceHours, topN }, req.log);
      res.json(rows);
    } catch (e) {
      req.log?.error?.({
        event: 'failed_logon.by_dc_failed',
        err: e?.message || String(e)
      }, 'failed-logon by-dc read failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // R158.57 — hourly bucket trend per DC. ?dc=HOST override narrows
  // to a single series; default is top-N mode. Same shape as
  // /timeseries-by-workstation with workstation → dc rename.
  r.get('/api/failed-logon/timeseries-by-dc', requireAuth, async (req, res) => {
    try {
      const windowHours = clampInt(req.query.windowHours, MIN_SINCE_HOURS, MAX_SINCE_HOURS);
      const topN        = clampInt(req.query.topN,        BY_WS_MIN_TOPN,  BY_WS_MAX_TOPN);
      const dc          = req.query.dc ? String(req.query.dc).trim() : null;
      const db = getDb();
      const rows = await failedLogon.trendByDc(db, { windowHours, topN, dc }, req.log);
      res.json(rows);
    } catch (e) {
      req.log?.error?.({
        event: 'failed_logon.timeseries_by_dc_failed',
        err: e?.message || String(e)
      }, 'failed-logon timeseries-by-dc read failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // R158.1W.1 (2026-10-16) — 账户访问分布图 (原名: 账户-工作站关联网络图).
  //   返 { nodes, links } envelope, 供 ECharts graph/force + sankey 复用
  //   (1:1 平行 TopologyView.vue:27,35 数据形状). 跟 /by-workstation 1:1 平行
  //   access tier: requireAuth only, NO admin perm (operator dashboard 可见).
  //   sinceHours [1,168] 默认 7d 168h, minStations [2,50] 默认 3, limit [10,500] 默认 200.
  r.get('/api/failed-logon/account-workstation-graph', requireAuth, async (req, res) => {
    try {
      const sinceHours = clampInt(req.query.sinceHours, AWS_MIN_SINCE_HOURS, AWS_MAX_SINCE_HOURS, AWS_DEFAULT_SINCE_HOURS);
      const minStations = clampInt(req.query.minStations, AWS_MIN_STATIONS, AWS_MAX_STATIONS, AWS_DEFAULT_STATIONS);
      const limit      = clampInt(req.query.limit, AWS_MIN_LIMIT, AWS_MAX_LIMIT, AWS_DEFAULT_LIMIT);
      const db = getDb();
      const data = await failedLogon.accountWorkstationLinks(db, { sinceHours, minStations, limit }, req.log);
      res.json(data);
    } catch (e) {
      req.log?.error?.({
        event: 'failed_logon.account_workstation_graph_failed',
        err: e?.message || String(e)
      }, 'failed-logon account-workstation-graph read failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}

// camelCase reshape — single source of truth so timeseries / recent /
// search all return the same wire shape.
function shapeRow(r) {
  return {
    occurredAt:            r.occurred_at,
    dcName:                r.dc_name,
    targetUserName:        r.target_user_name,
    targetUserDisplayName: r.target_user_display_name,
    targetDomainName:      r.target_domain_name,
    subjectUserName:       r.subject_user_name,
    subjectDomainName:     r.subject_domain_name,
    callerComputerName:    r.caller_computer_name,
    ipAddress:             r.ip_address,
    ipPort:                r.ip_port,
    logonType:             r.logon_type,
    logonProcessName:      r.logon_process_name,
    authPackageName:       r.auth_package_name,
    failureReason:         r.failure_reason,
    status:                r.status,
    workstationName:       r.workstation_name
  };
}

// R158.109 (2026-10-16) — clampInt 4 参 overload: clampInt(raw, min, max, defaultValue)
// 旧 3 参 (raw, min, max) 行为 0 改 (R158.50 既有 caller 仍 3 参). 4 参 overload:
// 不传 / 非数 / < min 返 defaultValue, > max 返 max. 跟 R158.108 eventlog.js 1:1 平行.
function clampInt(raw, min, max, defaultValue) {
  if (raw === undefined || raw === null || raw === '') {
    return defaultValue !== undefined ? defaultValue : min;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) return defaultValue !== undefined ? defaultValue : min;
  if (n > max) return max;
  return n;
}
