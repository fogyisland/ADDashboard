import api from './client.js';
export const dashboardApi = {
  // 2026-08-27 round-33: single-site getSiteReplicationMatrix removed.
  // The unified overview is the only replication surface — every primary
  // DC across every site, with partner status (no per-port columns after
  // round-45 drops the R35 port monitoring surface).
  getSiteReplicationMatrixAll: () => api.get('/api/dashboard/site-replication-matrix/all'),
  // 2026-08-28 round-45: per-pair history lazy-fetch for the inline expansion
  // in 复制状态概览. The standalone ReplicationLogMonitorView was absorbed
  // into SiteReplicationMatrixAllView; the user expands a partner row to
  // see the last 10 attempts for that (source, dest) pair. destDc is the
  // DC whose perspective the operator is viewing (the inbound direction's
  // destination), sourceDc is the partner DC that reports replication FROM
  // its side — see dashboard.js route for the contract.
  getSiteReplicationMatrixPairHistory: (destDc, sourceDc, limit = 10) =>
    api.get(`/api/dashboard/site-replication-matrix/pair-history?dest=${encodeURIComponent(destDc)}&source=${encodeURIComponent(sourceDc)}&limit=${limit}`),
  // 2026-08-28 round-45 restoration: 复制日志监控 is its own drill-down UI
  // (separate from 复制状态概览). The route returns per-site → per-DC → per-partner
  // tables with the last 10 attempts already embedded (no client-side group-by).
  getReplicationLogAll: () => api.get('/api/dashboard/replication-log/all')
};
