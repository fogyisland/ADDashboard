import api from './client.js';
export const dashboardApi = {
  getSiteReplicationMatrix: (siteName) => api.get(`/api/dashboard/site-replication-matrix?site=${encodeURIComponent(siteName)}`)
};
