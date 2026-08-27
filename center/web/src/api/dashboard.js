import api from './client.js';
export const dashboardApi = {
  // 2026-08-27 round-33: single-site getSiteReplicationMatrix removed.
  // The unified overview (round-27+round-32) is the only replication
  // surface — every primary DC across every site, with per-port probe data.
  getSiteReplicationMatrixAll: () => api.get('/api/dashboard/site-replication-matrix/all'),
  // 2026-08-27 round-42 (复制日志监控): per-DC partner tables augmented
  // with the latest 10 connection attempts from ad_replication_history.
  // Drives ReplicationLogMonitorView's expandable caret rows.
  getReplicationLogAll: () => api.get('/api/dashboard/replication-log/all')
};
