// R158.50 (2026-10-06) — failed-logon API client. Drives the
// /failed-logon-2h front-end dashboard (24h/7d line chart + reverse-
// chronological detail table). 3 endpoints: timeseries, recent, search.

import api from './client.js';

// Hourly bucket aggregate for the line chart. sinceHours clamped to
// [1, 168] server-side (lockout-router precedent). Default 24h for
// the dashboard's default toggle state; pass 168 for 7d.
//
// R158.109 (2026-10-16) — 0 删 fetchFailedLogonTimeseries (其它 caller
// 仍可调, 兼容), 加 fetchFailedLogonTrend 参数化, 支持 24h/7d/全部 toggle.
// 1:1 平行 R158.108 eventlog fetchEventlogTrend 范式. 0 改 wire shape.
export function fetchFailedLogonTimeseries(sinceHours = 24) {
  return api.get('/api/failed-logon/timeseries', {
    params: { sinceHours }
  });
}

// R158.109 — /failed-logon-2h 折线图 24h/7d/全部 toggle. 1:1 平行后端
// route 接受 ?windowHours&days&grain. 24h 走 hourly (R158.50 行为 1:1
// 保留), 7d/全部 走 daily. "全部" = ad_mgmt_retention_days (R158.107
// retention 边界, 默认 30d, 0=永久 → 365 cap 跟 SQL 1:1 平行).
//
// R158.X.99.36 (2026-10-20) — grain 升 4 值 (1:1 平行 R158.X.99.35
// lockout routes/lockout.js:210 + R158.X.99.33+.34 eventlog 范式):
//   'hourly'   → hourlyAggregate (R158.50 行为 0 改, 默认 fallback)
//   'daily'    → dailyAggregate    (R158.109 行为 0 改)
//   'bucket5m' → trendByBucketMinutes(bucketMinutes=5,   24h/288 段)
//   'bucket4h' → trendByBucketMinutes(bucketMinutes=240, 7d/42 段).
// bucket 边界走 occurred_at (事件触发时间, 操作员 directive "时间是事件
// 触发时间" 1:1 平行 lockout R158.X.99.35). workstation/dc 模式 0 改
// (operator AskUserQuestion 2026-10-20 已确认只改 account 默认模式).
export function fetchFailedLogonTrend({ windowHours = null, days = null, grain = null } = {}) {
  const params = {};
  if (grain) params.grain = grain;
  if (days !== null) params.days = days;
  if (windowHours !== null) params.windowHours = windowHours;
  return api.get('/api/failed-logon/timeseries', { params });
}

// Reverse-chronological detail table. limit default 100 (matches the
// dashboard's table-page-size default); server-side clamp [1, 500].
export function fetchFailedLogonRecent({ sinceHours = 24, limit = 100 } = {}) {
  return api.get('/api/failed-logon/recent', {
    params: { sinceHours, limit }
  });
}

// Drill-down search. Empty string filters mean "no filter on this
// column" — same convention as the lockout-accounts search input.
export function fetchFailedLogonSearch({ dc = '', user = '', ip = '', sinceHours = 24, limit = 200 } = {}) {
  const params = { sinceHours, limit };
  if (dc)   params.dc   = dc;
  if (user) params.user = user;
  if (ip)   params.ip   = ip;
  return api.get('/api/failed-logon/search', { params });
}

// R158.55 (2026-10-08) — top-N workstation aggregate for the
// "按锁定服务器" toggle on /failed-logon-2h. Mirrors
// fetchLockoutTrend24h shape (camelCase rows). topN default 5 matches
// the dashboard's one-screen-visible-series budget. sinceHours
// [1,168] covers both 24h and 7d toggle states (server-side clamp).
export function fetchFailedLogonByWorkstation({ sinceHours = 24, topN = 5 } = {}) {
  return api.get('/api/failed-logon/by-workstation', {
    params: { sinceHours, topN }
  });
}

// R158.55 — hourly bucket trend per workstation. ?workstation=HOST
// override narrows to a single series (deep-link for R158.55.1
// follow-up); default is top-N mode. windowHours matches sinceHours
// naming used by lockout.events so future shared pivots line up.
export function fetchFailedLogonTimeseriesByWorkstation({ windowHours = 24, topN = 5, workstation = null } = {}) {
  const params = { windowHours, topN };
  if (workstation) params.workstation = workstation;
  return api.get('/api/failed-logon/timeseries-by-workstation', { params });
}

// R158.57 (2026-10-09) — top-N DC aggregate for the "按认证 DC" toggle
// on /failed-logon-2h. Mirrors fetchFailedLogonByWorkstation shape
// (line 39) with rename workstation → dc. Helps the operator spot
// which DC is producing the most 4625s.
export function fetchFailedLogonByDc({ sinceHours = 24, topN = 5 } = {}) {
  return api.get('/api/failed-logon/by-dc', {
    params: { sinceHours, topN }
  });
}

// R158.57 — hourly bucket trend per DC. ?dc=HOST override narrows
// to a single series; default is top-N mode. Mirrors
// fetchFailedLogonTimeseriesByWorkstation shape with rename
// workstation → dc.
export function fetchFailedLogonTimeseriesByDc({ windowHours = 24, topN = 5, dc = null } = {}) {
  const params = { windowHours, topN };
  if (dc) params.dc = dc;
  return api.get('/api/failed-logon/timeseries-by-dc', { params });
}

// R158.1W.1 (2026-10-16) — 账户访问分布图 (原名: 账户-工作站关联网络图, graph + sankey 双形态).
//   sinceHours [1,168] 默认 7d 168h, minStations [2,50] 默认 3 (账户在 N 个
//   不同工作站登录 = "lateral movement" 评估维度), limit [10,500] 默认 200.
//   0 裸 fetch (R158.100.8 lesson 强制走 axios request.js 拦截器).
export function fetchAccountWorkstationGraph({ sinceHours = 168, minStations = 3, limit = 200 } = {}) {
  return api.get('/api/failed-logon/account-workstation-graph', {
    params: { sinceHours, minStations, limit }
  });
}
