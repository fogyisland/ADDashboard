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
  // 2026-08-28 round-47: 复制伙伴端口健康监控. The route returns per-site
  // → per-DC → per-partner rows with `portHealth[]` (latest per-pair
  // probe results) and `configuredPorts[]` (system_ports list). The
  // view renders one cell per configured port with the R47 colour
  // thresholds (≤1000ms green / >1000ms yellow / ✕ red / — gray).
  // Replication-attempt history is no longer served here — that surface
  // is exclusive to 复制状态概览 (R45 inline caret in
  // SiteReplicationMatrixAllView).
  getPartnerPortHealthAll: () => api.get('/api/dashboard/partner-port-health/all'),
  // 2026-08-30 R67-T2: 包执行状态监控 — frontend AppLayout surface that
  // summarises the package_runs table per package (24h totals + last 10
  // runs as drill-down). Read-only; same /api/dashboard/* auth gate as
  // the rest of the 监控指标 surfaces.
  getPackagesRuns: () => api.get('/api/dashboard/packages-runs')
};
