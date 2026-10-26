// R158.X (2026-10-15) — 账户变更明细 view (AccountChangeDetailView) 的
//   API wrapper. 平行 web/src/api/eventlog.js / web/src/api/dashboard.js
//   / web/src/api/failed-logon.js. 走统一 axios client (web/src/api/client.js
//   自动加 Bearer token + 401 拦截).
//
//   3 个 wrapper:
//     fetchAccountChangeSummary      → /api/account-change/summary
//     fetchAccountChangeDetail       → /api/account-change/detail?action&limit
//     fetchAccountManagementEvents   → /api/account-change/events?sinceHours&limit
//
//   全部 GET, 跟 eventlog / failed-logon 同 userAuth-only gate (R158.X
//   平行 R112 / R116 / R131 / R158.50 ship pattern). 0 改 ad_account_change
//   schema / 0 改 ad_eventlog_events schema.

import api from './client.js';

// 5 类 action 当日聚合计数 (5 块大字卡片). 后端 shape:
//   { summary: [{ action, count, dcCount }] × 5 }.
export function fetchAccountChangeSummary() {
  return api.get('/api/account-change/summary');
}

// 当日某 action top-N 明细 (5 tab 切换). 后端 shape:
//   { action, rows: [{ sam, displayName, dcName, createdAt, modifiedAt,
//   changeDate, dn }] × N, count }.
//   action ∈ {created, modified, deleted, enabled, disabled}.
export function fetchAccountChangeDetail({ action, limit = 50 } = {}) {
  return api.get('/api/account-change/detail', { params: { action, limit } });
}

// 当日跨 DC 账户管理 event (Security log 4720/4722/4723/4725/4726/4738/
// 4740). 后端 shape: { events: [{ collectedAt, dcName, channel, severity,
// eventId, recordId, message, ts, auditFailure }] × N, count }.
export function fetchAccountManagementEvents({ sinceHours = 24, limit = 200 } = {}) {
  return api.get('/api/account-change/events', { params: { sinceHours, limit } });
}
