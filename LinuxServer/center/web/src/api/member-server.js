// R158.77 (2026-10-11) — 5 NEW axios wrappers for the non-AD
// member-server fleet. Mirrors web/src/api/dashboard.js style
// (functional, default-export object of async fns). Strict 1:1
// with src/routes/member-servers-public.js — surface drift = bug.
import api from './client.js';

export const memberServerApi = {
  // 1. 首页 KPI + cards
  getOverview: () => api.get('/api/dashboard/member-overview'),

  // 2. Agent 列表 (heartbeats LEFT JOIN ad_member_servers)
  getAgents: () => api.get('/api/dashboard/member-agents'),

  // 3. OS 基线 (复用 os-baseline-metrics.listLatestPerAgent, filtered to non-AD)
  getOsBaseline: ({ sinceHours = 24 } = {}) =>
    api.get('/api/dashboard/member-os-baseline', { params: { sinceHours } }),

  // 3b. OS 基线时序 (auto-enumerate agentIds, filtered to non-AD)
  getOsBaselineTimeseries: ({ hours = 24 } = {}) =>
    api.get('/api/dashboard/member-os-baseline/timeseries', {
      params: { hours }
    }),

  // 4. 应用端口 (复用 memberServerPortsService.listAll)
  getPorts: () => api.get('/api/dashboard/member-ports'),

  // 5. 包 (复用 packageRuns.summary24hByName + recentByName, scripts 预过滤 agentType='non-ad')
  getPackagesRuns: ({ window = '24h' } = {}) =>
    api.get('/api/dashboard/member-packages-runs', { params: { window } }),

  // 6. R158.78 (2026-10-12) — member-server 事件日志 channel 计数矩阵.
  //    3 通道 (Application / System / Security), 走 ad_member_eventlog_*
  //    专表 (不复用 DC 端 ad_eventlog_*).
  getEventlogSummary: ({ sinceHours = 24 } = {}) =>
    api.get('/api/dashboard/member-eventlog/summary', { params: { sinceHours } }),

  // 7. R158.78 — member-server 事件日志明细 drill-down. query 用 hostname
  //    不是 dc, 跟 R158.77 兄弟 endpoint 同 precedent.
  getEventlogEvents: ({ hostname, channel, sinceHours = 24, limit = 200, severity = null, auditOnly = false } = {}) =>
    api.get('/api/dashboard/member-eventlog/events', {
      params: { hostname, channel, sinceHours, limit, severity, auditOnly }
    }),

  // 7b. R158.101 (2026-10-13) — member-server 事件日志 24h hourly trend
  //     for the line chart. Mirrors web/src/api/eventlog.js:9 fetchEventlogTrend24h
  //     shape (sinceHours clamped server-side to [1,168] then capped at 24).
  //     走 ad_member_eventlog_events (member spec) 0 走 ad_eventlog_events.
  getEventlogTrend: ({ sinceHours = 24 } = {}) =>
    api.get('/api/dashboard/member-eventlog/trend', {
      params: { sinceHours }
    }),

  // 8. R158.100 (2026-10-13) — member_admin_groups 包端点. 3 本地组
  //     (BUILTIN\Administrators / Remote Desktop Users / Power Users).
  //     list 跟 summary 走 member-servers-public.js:922 + 942.
  //     hostname 可选 omit → 返全部 host × 3 group summary; 不 omit →
  //     返该 host 3 group × N member flattened rows.
  // R158.100.8 (2026-10-14) — 原 MemberServerAdminsView.vue:112 用裸
  //     fetch + credentials:'include' 调这两个端点, 没带 Authorization
  //     header → user-auth.js:54-56 必返 401 'missing token'. 兄弟
  //     view 都走 axios (client.js:7-11 拦截器自动注入 Bearer) 所以
  //     正常. 改走 memberServerApi 让前端跟 R158.100 ship 闭合.
  getAdminGroups: ({ hostname = null } = {}) =>
    api.get('/api/dashboard/member-admin-groups', {
      params: hostname ? { hostname } : {}
    }),
  getAdminGroupDetail: ({ hostname, group }) =>
    api.get('/api/dashboard/member-admin-groups/summary', {
      params: { hostname, group }
    })
};

export default memberServerApi;