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
  deleteDc:    (dcName)  => api.delete(`/api/admin/heartbeat-report/dcs/${encodeURIComponent(dcName)}`)
};