import api from './client.js';
export const dashboardApi = {
  // 2026-08-27 round-33: single-site getSiteReplicationMatrix removed.
  // The unified overview (round-27+round-32) is the only replication
  // surface — every primary DC across every site, with per-port probe data.
  getSiteReplicationMatrixAll: () => api.get('/api/dashboard/site-replication-matrix/all')
};
