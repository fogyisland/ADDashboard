import api from './client.js';

// R158.54 (2026-10-08) — 24h hourly event log trend for the /eventlog
// line chart. Data source: ad_eventlog_events (event log, 5 channel
// fixed — System / Application / ADWeb / DFSR / Security). Wire shape:
// [{ channel, bucketStart, eventCount }, ...] ordered (channel ASC,
// bucketStart ASC). Channel is fixed by the catalog so no topN / dc
// override — chart renders all 5 channels in a stable palette.
//
// R158.108 (2026-10-16) — 0 删 fetchEventlogTrend24h (其它 caller
// 仍可调, 兼容), 加 fetchEventlogTrend 参数化, 支持 24h/7d/全部
// toggle. 0 改 wire shape: 仍返 [{ channel, bucketStart, eventCount }, ...]
export function fetchEventlogTrend24h() {
  return api.get('/api/eventlog/trend');
}

// R158.108 — /eventlog 折线图 24h/7d/全部 toggle. 1:1 平行后端
// route 接受 ?windowHours&days&grain. 24h 走 hourly (R158.54 行为 1:1
// 保留), 7d/全部 走 daily. "全部" = ad_mgmt_retention_days (R158.107
// retention 边界, 默认 30d, 0=永久 → 365 cap 跟 SQL 1:1 平行).
export function fetchEventlogTrend({ windowHours = null, days = null, grain = null } = {}) {
  const params = {};
  if (grain) params.grain = grain;
  if (days !== null) params.days = days;
  if (windowHours !== null) params.windowHours = windowHours;
  return api.get('/api/eventlog/trend', { params });
}
