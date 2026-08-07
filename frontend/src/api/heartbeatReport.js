import api from './client.js';

export const heartbeatReportApi = {
  listAgents: () => api.get('/api/admin/heartbeat-report/agents'),
  listDcs:    () => api.get('/api/admin/heartbeat-report/dcs'),
  getDetail:  (agentId) => api.get(`/api/admin/heartbeat-report/agents/${encodeURIComponent(agentId)}/report-detail`)
};