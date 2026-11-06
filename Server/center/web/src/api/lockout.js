import api from './client.js';

export function searchLockoutEvents({ targetUser, dc, caller, sinceHours }) {
  const parts = [];
  if (targetUser) parts.push(`targetUser=${encodeURIComponent(targetUser)}`);
  if (dc)         parts.push(`dc=${encodeURIComponent(dc)}`);
  if (caller)     parts.push(`caller=${encodeURIComponent(caller)}`);
  if (sinceHours != null) parts.push(`sinceHours=${encodeURIComponent(sinceHours)}`);
  const qs = parts.length ? `?${parts.join('&')}` : '';
  return api.get(`/api/lockout-events/search${qs}`);
}

// R131 + R158.31 — recent-lockout list endpoint. Backs the new
// /lockout-accounts front-end sidebar page (operator directive
// 2026-09-27 "在前台增加一个sidebar 菜单，增加一个锁定账户信息").
// Same wire shape as search minus `isSource` — array of { occurredAt,
// dcName, targetUserName, targetUserDisplayName, subjectUserName,
// subjectDomain, callerComputerName } newest first. R139 originally
// added targetUserDescription (AD user `description` property); R158.31
// renamed to targetUserDisplayName (AD user `displayName`, 中文姓名 /
// 系统展示名) — the UI uses this to disambiguate same-SAM-name accounts
// and renders "—" when the agent hasn't been upgraded yet.
//
// R158.109.b (2026-10-16) — server-paged 24h list. sinceHours 服务端
// pin=24 (0 接受 client 改), 加 offset/pageSize (1 page = 50 行, 跟
// 操作员 directive "一页 50行" 1:1). response envelope 改
// { rows, total, page, pageSize, hasMore } (跟 R158.X account-change
// detail 范式 1:1 平行). 老 sinceHours/limit 仍兼容 (default 24h 仍
// 返, 但 pageSize 改 50).
//
// `dc` filter is applied client-side: the back-end endpoint doesn't take
// a dc filter yet (would require a second SQL helper mirroring `lockout.search`
// but without targetUser/caller; deferred to a future round). Pulling
// one page of 50 rows and filtering in JS is well under the network
// round-trip cost of a re-query and keeps the back-end surface
// unchanged.
export function listRecentLockoutEvents({ offset = 0, pageSize = 50, limit = null } = {}) {
  const params = { offset, pageSize };
  if (limit !== null) params.limit = limit; // 老 caller 兼容 (R131 旧 default 200)
  // sinceHours 0 传, 服务端 hard-code = 24 (跟操作员 directive 1:1).
  return api.get('/api/lockout-events/recent', { params });
}

// R158.53 (2026-10-08) — 24h hourly event-log trend for the
// /lockout-accounts line chart. Data source: ad_lockout_events
// (event log, R158.50.7n lesson). Top-5 by 24h COUNT(*) DESC;
// ?dc=HOST override returns that single DC's series. Wire shape:
// [{ agentId, bucketStart, eventCount }, ...] ordered (agentId ASC,
// bucketStart ASC). Pass dc=null (the default) for top-5 mode.
export function fetchLockoutTrend24h({ dc = null } = {}) {
  const params = {};
  if (dc) params.dc = dc;
  return api.get('/api/lockout-events/trend', { params });
}

// R158.109.b — chart 24h/7d/全部 toggle (1:1 平行 R158.108 eventlog
// fetchEventlogTrend). 24h 走 hourly (windowHours=24), 7d 走 hourly
// (windowHours=168), 全部 走 daily (days=ad_mgmt_retention_days, R158.107
// 边界). 0 改 fetchLockoutTrend24h (老 caller 仍可调, 24h 行为 1:1).
//
// R158.X.99.35 (2026-10-20) — 加 grain 参 (跟 fetchEventlogTrend
// api/eventlog.js:21 1:1 平行). grain ∈ {'hourly','daily','bucket5m',
// 'bucket4h'}. 24h 传 'bucket5m' (288 段), 7d 传 'bucket4h' (42 段).
// 全部 传 'daily' (retention 边界) 跟既有一致. 老 caller (不传 grain)
// 1:1 保留 R158.109.b 行为 (走 windowHours/days 双参 dispatch).
export function fetchLockoutTrend({ dc = null, topN = 5, windowHours = null, days = null, grain = null } = {}) {
  const params = { topN };
  if (dc) params.dc = dc;
  if (windowHours !== null) params.windowHours = windowHours;
  if (days !== null) params.days = days;
  if (grain !== null) params.grain = grain;
  return api.get('/api/lockout-events/trend', { params });
}

// R158.1W.3 (2026-10-16) — 账户锁定分布图 wrapper (跟 R158.1W.1
//   fetchAccountWorkstationGraph 1:1 平行, 数据源 ad_lockout_events 4740
//   vs ad_failed_logon_events 4625, 字段 caller_computer_name vs
//   workstation_name). envelope shape { nodes, links } 跟 R158.1W.1 1:1
//   平行, 0 改 wire. 0 裸 fetch (R158.100.8 lesson 强制走 axios request.js
//   拦截器).
export function fetchLockoutAccountWorkstationGraph({ sinceHours = 168, minStations = 3, limit = 200 } = {}) {
  return api.get('/api/lockout/account-workstation-graph', {
    params: { sinceHours, minStations, limit }
  });
}