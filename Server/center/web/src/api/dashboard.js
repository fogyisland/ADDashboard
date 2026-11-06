import api from './client.js';
export const dashboardApi = {
  // 2026-08-27 round-33: single-site getSiteReplicationMatrix removed.
  // The unified overview is the only replication surface — every primary
  // DC across every site, with partner status (no per-port columns after
  // round-45 drops the R35 port monitoring surface).
  // R153 — `direction` selects the matrix lens:
  //   'inbound'  (default, legacy) — rows are receiving DCs, cols are the
  //              partner DCs that replicate INTO them (dest_dc = local).
  //   'outbound' — rows are sending DCs, cols are the partner DCs they
  //              replicate OUT to (source_dc = local).
  // Both share the same SQL + payload shape; only the per-DC partner-map
  // keying changes on the backend.
  getSiteReplicationMatrixAll: ({ direction = 'inbound' } = {}) =>
    api.get(`/api/dashboard/site-replication-matrix/all?direction=${direction}`),
  // 2026-08-28 round-45: per-pair history lazy-fetch for the inline expansion
  // in 复制状态概览. The standalone ReplicationLogMonitorView was absorbed
  // into SiteReplicationMatrixAllView; the user expands a partner row to
  // see the last 10 attempts for that (source, dest) pair. destDc is the
  // DC whose perspective the operator is viewing (the inbound direction's
  // destination), sourceDc is the partner DC that reports replication FROM
  // its side — see dashboard.js route for the contract.
  getSiteReplicationMatrixPairHistory: (destDc, sourceDc, limit = 10) =>
    api.get(`/api/dashboard/site-replication-matrix/pair-history?dest=${encodeURIComponent(destDc)}&source=${encodeURIComponent(sourceDc)}&limit=${limit}`),
  // R158.17 (2026-10-01) — 复制状态概览展开历史 (probe 包).
  // 走 ad_replication_probe_history (R158.15 15min cadence), 仅取
  // 源 / 目标 / attempt_at / result 四列. 默认 limit=10 (历史10次).
  getSiteReplicationMatrixProbeHistory: (destDc, sourceDc, limit = 10) =>
    api.get(`/api/dashboard/site-replication-matrix/probe-history?dest=${encodeURIComponent(destDc)}&source=${encodeURIComponent(sourceDc)}&limit=${limit}`),
  // R158.103.2 (2026-10-15) — 复制状态概览 "明细" drawer 数据源.
  // 走 ad_replication_probe_history 11 字段全明细, 跟 probe-history
  // (4 列, limit=10) 是 2 独立 wrapper, 0 改旧. 默认 limit=50, cap 50
  // (跟端点 cap 1:1, R158.86.6 防 2 wrapper cap 漂移). wrapper 命名 1:1
  // 跟端点路径 (probe-history-detail). R158.100.8 走 axios 拦截器 0
  // 裸 fetch.
  getSiteReplicationMatrixProbeHistoryDetail: (destDc, sourceDc, limit = 50) =>
    api.get(`/api/dashboard/site-replication-matrix/probe-history-detail?dest=${encodeURIComponent(destDc)}&source=${encodeURIComponent(sourceDc)}&limit=${limit}`),
  // 2026-08-28 round-47: 复制伙伴端口健康监控. The route returns per-site
  // → per-DC → per-partner rows with `portHealth[]` (latest per-pair
  // probe results) and `configuredPorts[]` (system_ports list). The
  // view renders one cell per configured port with the R47 colour
  // thresholds (≤1000ms green / >1000ms yellow / ✕ red / — gray).
  // Replication-attempt history is no longer served here — that surface
  // is exclusive to 复制状态概览 (R45 inline caret in
  // SiteReplicationMatrixAllView).
  // R155.3 — label 纠正. UI label "入站" 实际渲染 = endpoint 内部
  // direction='outbound' (anchor source_dc, 我 probe 出去的 = 我从这些
  // 源拉 = operator 视角 "入站"). UI label "出战" = endpoint 内部
  // direction='inbound' (anchor dest_dc, peer probe 我 = operator 视角
  // "出战"). 拆 2 hardcoded wrapper (避免前端记反 direction 串);旧
  // all?direction= 保留作 backward-compat(R155.2 callers)。
  // Mirrors R153 site-replication-matrix/all pattern.
  // R158.10 (2026-10-01) — 注释修正: getPartnerPortHealthInbound
  //   实际是 /monitor-inbound 入站 wrapper 调用方 (R155.2 命名与 label
  //   反向),label "入站" = 我从这些源拉。出战 wrapper
  //   PartnerPortHealthInboundView 已删除,故 getPartnerPortHealthInbound
  //   这一行也删除 (UI 只剩 /monitor-inbound 用 getPartnerPortHealthAll)。
  // R156.5 retired — ad_dc_probe_outbound table + third partner-port
  // view dropped per operator directive "复制伙伴端口主动探测 不需要哦
  // 去掉". The endpoint /api/dashboard/partner-port-health/probe-
  // outbound is removed from routes/dashboard.js; the table is
  // dropped by migration 038.
  // R158.17.3 (2026-10-01) — operator directive "将all 改成Inbound".
  //   endpoint /api/dashboard/partner-port-health/all 已重命名为
  //   /api/dashboard/partner-port-health/inbound (数据语义锁死 inbound,
  //   不再接受 query param). 旧 wrapper 删.
  getPartnerPortHealthInbound: () =>
    api.get('/api/dashboard/partner-port-health/inbound'),
  // R158.17.3 -- 旧 all wrapper 留作 alias (内部走 /inbound), 一些历史
  //   bookmark / 测试代码可能仍调.
  getPartnerPortHealthAll: () =>
    api.get('/api/dashboard/partner-port-health/inbound'),
  // R156 — partner-discover endpoints. Authoritative DC topology from
  // ad_partner_inbound / ad_partner_outbound physical tables (migrations
  // 036 / 037). Discover != probe: no TCP port probing, no status_code,
  // just a "which DCs have I seen as peer in the last 30 days" snapshot.
  // Cadence is 30-day centre cron, so this view is the long-arc view
  // vs the 30-min probe view above.
  // R158.10 (2026-10-01) — getPartnerOutboundDiscover 删除 (operator:
  //   outbound partner 不再需要)。仅留 inbound 路径。
  getPartnerInboundDiscover: () =>
    api.get('/api/dashboard/discovery/inbound'),
  // 2026-08-30 R67-T2: 包执行状态监控 — frontend AppLayout surface that
  // summarises the package_runs table per package (24h totals + last 10
  // runs as drill-down). Read-only; same /api/dashboard/* auth gate as
  // the rest of the 监控指标 surfaces.
  //
  // R158.76 (2026-10-11) — optional `window` selector (24h | 7d | all).
  // 老 caller 不传 = 24h (后端 default, 行为不变). 跟 R74
  // replicationErrors 同 envelope shape — `{ window = '24h' } = {}`.
  // R158.X+UI.lazy (2026-10-20) — includeTimeline opt-in.
  //
  // 后端 timelineRecent 由 14 次 recentByName(limit=1000) fan-out 组成,
  // 是整个 envelope 里最贵的一块. 首屏 (卡片 summary + 抽屉 recent) 根本
  // 不读它 — 只有折线图读. 所以默认 false, 前端在用户真的展开/点图表时
  // 才带 includeTimeline=1 重取.
  //
  // 老 caller 不传 = 行为与今天不同? 否 — 今天也没有"必须带 timeline"
  // 的 caller, buildTimelineSeries 有 `pkg.recent` 兜底 (line 459),
  // 所以 false 时折线图退化为 listLimit 档位的数据, 功能不破.
  getPackagesRuns: ({ window = '24h', limit = 10, includeTimeline = false } = {}) =>
    api.get('/api/dashboard/packages-runs', {
      params: includeTimeline ? { window, limit, includeTimeline: 1 } : { window, limit }
    }),
  // 2026-09-01 R74: 复制错误 — admin 监控与诊断 surface that lists every
  // (source_dc, dest_dc, naming_context) tuple whose latest status is a
  // failure (status_code > 0). Window defaults to 24h, accepts 7d / all.
  // Drives ReplicationErrorsView (mounted at /admin/replication-errors).
  //
  // R158.X.116.p (2026-10-23) — 加 all 档: 后台要能翻全历史 (排查视角:
  // 这条链路是不是从某天起就断着), 24h/7d 只是值班快捷档。
  replicationErrors: ({ window = '24h' } = {}) =>
    api.get('/api/dashboard/replication-errors', { params: { window } }),
  // R158.X.116.p (2026-10-23) — 前台 /errors 页专用带窗端点 (新建端点,
  //   老 /api/dashboard/errors 0 改 — feedback-new-endpoint-dont-modify-old
  //   锁)。前台只看最近 24h: 值班视角「今天有没有坏链路」, 翻历史去后台页。
  //   接受 24h / 7d / all, 与后台端点同一套 window 取值。
  errorsRecent: ({ window = '24h' } = {}) =>
    api.get('/api/dashboard/errors-recent', { params: { window } }),
  // R158.69.10 (2026-10-11) — admin members drill-down per group.
  //   新建端点, 不动 summary. group 取值 'Domain Admins' / 'Enterprise Admins'.
  getAdminMembersByGroup: ({ group }) =>
    api.get(`/api/dashboard/admin-members?group=${encodeURIComponent(group)}`),
  // R158.72 (2026-10-11) — ad_account_change trend for 首页 折线图. days=30 default.
  getAccountChangeTrend: ({ days = 30 } = {}) =>
    api.get(`/api/dashboard/account-change-trend?days=${days}`)
};
