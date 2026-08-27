import api from './client.js';
export const dashboardApi = {
  getSiteReplicationMatrix: (siteName) => api.get(`/api/dashboard/site-replication-matrix?site=${encodeURIComponent(siteName)}`),
  // 2026-08-27 round-27: all-sites variant for the global replication matrix
  // view. Returns { siteRefreshSeconds, ports, sites[] } where each site has
  // hub-first ordering, its DCs, withinLinks, crossOut and crossIn lists,
  // and per-link perPort probe data.
  getSiteReplicationMatrixAll: () => api.get('/api/dashboard/site-replication-matrix/all')
};
