import api from './client.js';

export const heartbeatReportApi = {
  listAgents: () => api.get('/api/admin/heartbeat-report/agents'),
  listDcs:    () => api.get('/api/admin/heartbeat-report/dcs'),
  getDetail:  (agentId) => api.get(`/api/admin/heartbeat-report/agents/${encodeURIComponent(agentId)}/report-detail`),
  getProbeStatus: () => api.get('/api/admin/heartbeat-report/probe'),
  // Triggers an immediate data report from the named agent on its next heartbeat.
  // Returns { data: { ok, agentId, requestedAt, alreadyPending } } or rejects with
  // a 404 if the agentId is unknown to the center.
  requestReport: (agentId) => api.post(`/api/admin/agents/${encodeURIComponent(agentId)}/request-report`),
  // 2026-08-26 round-19+: operator-initiated "remove this agent from the
  // dashboard". Cascades through ad_agent_heartbeat + ad_replication_status
  // (both directions) + package_runs. The audit log records the per-table
  // rowcounts. Rejects with 404 if the agent has no heartbeat row.
  deleteAgent: (agentId) => api.delete(`/api/admin/heartbeat-report/agents/${encodeURIComponent(agentId)}`),
  // 2026-08-26 round-19+: operator-initiated "remove this DC from the DC tab".
  // Only touches ad_dcs — the heartbeat row (and therefore Agent-tab visibility)
  // stays intact so the operator can still see the host is alive.
  deleteDc:    (dcName)  => api.delete(`/api/admin/heartbeat-report/dcs/${encodeURIComponent(dcName)}`),
  // R158.79 (2026-10-12) — MemberServer heartbeat tab. 跟 AD agent/DC
  //   端 1:1 平行, 但走 ad_member_heartbeat 专表 (跟 R158.78
  //   ad_member_eventlog_* 同 precedent, noad agent 独立 namespace).
  //   listMembers returns agents[] with hostname / siteName /
  //   agentType='non-ad' / lastHeartbeatAt etc., 与 listAgents /
  //   listDcs 同 shape. deleteMember is single-table (no cascade) and
  //   404s when the row is missing.
  listMembers:  () => api.get('/api/admin/heartbeat-report/members'),
  deleteMember: (hostname) => api.delete(`/api/admin/heartbeat-report/members/${encodeURIComponent(hostname)}`)
};