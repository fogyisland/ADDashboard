// R158.110 (2026-10-16) — 报表中心 admin-only API wrapper.
// R158.111 (2026-10-16) — 加 filter query param 透传:
//   ?dc= / ?q= / ?actions=created,modified. axios params 自动 skip null/undefined/'',
//   不污染 query string.
//
// 4 wrapper (跟 R158.100.8 教训: 0 裸 fetch, 走 axios 拦截器):
//   fetchLockoutTop({ days, topN, dc, q })        → /api/report-center/lockout-top
//   fetchFailedLogonTop({ days, topN, by, dc })   → /api/report-center/failed-logon-top
//   fetchAccountChangeDaily({ days, actions })    → /api/report-center/account-change-daily
//   fetchDcOptions()                              → /api/report-center/dc-options
//
// 跟 R158.108/109.a/109.b 1:1 平行: ?days ∈ [1, 365] 跟 SQL helper 1:1,
// 服务端 clamp 兜底. 0 改 wire shape.

import api from './client.js';

// 锁定账户报表 — top by target user. 后端 shape:
//   { days, topN, dcName, search, rows: [{ sam, displayName, lockoutCount,
//   lastLockoutAt, dcCount, dcNameList }] × N, count }.
export function fetchLockoutTop({ days = 7, topN = 5, dc = null, q = null } = {}) {
  return api.get('/api/report-center/lockout-top', { params: { days, topN, dc, q } });
}

// 失败登录报表 — by=workstation|dc 二 path. 后端 shape:
//   { days, topN, by, dcName, rows: [{ workstationName|dcName, eventCount }] × N, count }.
export function fetchFailedLogonTop({ days = 7, topN = 5, by = 'workstation', dc = null } = {}) {
  return api.get('/api/report-center/failed-logon-top', { params: { days, topN, by, dc } });
}

// 账户变更报表 — 5 action × N day 折线数据. 后端 shape:
//   { days, actions: 'all'|string[], rows: [{ action, bucketDay, eventCount }] × N, count }.
// actions: string[] 自动 join 逗号 → 'created,modified'.
export function fetchAccountChangeDaily({ days = 7, actions = null } = {}) {
  const params = { days };
  if (Array.isArray(actions) && actions.length > 0) {
    params.actions = actions.join(',');
  }
  return api.get('/api/report-center/account-change-daily', { params });
}

// DC 列表下拉选项 — 后端 shape:
//   { rows: [{ dcName, isPdc, isGc, isBridgehead, discoveredAt }] × N, count }.
// 前端下拉用, 0 自带 cache (DC 列表 < 100 行 + 下拉打开时拉, 性能 OK).
export function fetchDcOptions() {
  return api.get('/api/report-center/dc-options');
}

// R158.111.a (2026-10-16) — 锁定账户 raw event list, 流水不过滤.
//   days=null/undefined → 后端物理全量 (sinceHours=NULL), days>0 → 限定
//   sinceHours=days×24. limit 默认 100, offset 默认 0. 0 改老 wrapper.
export function fetchLockoutEvents({ days = null, dc = null, q = null, limit = 100, offset = 0 } = {}) {
  return api.get('/api/report-center/lockout-events', { params: { days, dc, q, limit, offset } });
}

// R158.111.a (2026-10-16) — 密码错误 raw event list, 跟 lockout 1:1 平行.
//   操作员 directive "密码错误 和账户变更 都是按照一样的方式".
export function fetchFailedLogonEvents({ days = null, dc = null, q = null, limit = 100, offset = 0 } = {}) {
  return api.get('/api/report-center/failed-logon-events', { params: { days, dc, q, limit, offset } });
}

// R158.111.a (2026-10-16) — 账户变更 raw event list, 跟 lockout 1:1 平行.
//   操作员 directive "密码错误 和账户变更 都是按照一样的方式".
export function fetchAccountChangeEvents({ days = null, dc = null, q = null, limit = 100, offset = 0 } = {}) {
  return api.get('/api/report-center/account-change-events', { params: { days, dc, q, limit, offset } });
}