import api from './client.js';

export const heartbeatReportApi = {
  listAgents: () => api.get('/api/admin/heartbeat-report/agents'),
  listDcs:    () => api.get('/api/admin/heartbeat-report/dcs'),
  getDetail:  (agentId) => api.get(`/api/admin/heartbeat-report/agents/${encodeURIComponent(agentId)}/report-detail`),
  getProbeStatus: () => api.get('/api/admin/heartbeat-report/probe'),
  // Triggers an immediate data report from the named agent on its next heartbeat.
  // Returns { data: { ok, agentId, requestedAt, alreadyPending } } or rejects with
  // a 404 if the agentId is unknown to the center.
  requestReport: (agentId) => api.post(`/api/admin/agents/${encodeURIComponent(agentId)}/request-report`)
};