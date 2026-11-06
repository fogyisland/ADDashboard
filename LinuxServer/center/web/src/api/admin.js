import api from './client.js';
export const adminApi = {
  listUsers: () => api.get('/api/admin/users'),
  createUser: (body) => api.post('/api/admin/users', body),
  updateUser: (id, body) => api.put(`/api/admin/users/${id}`, body),
  deleteUser: (id) => api.delete(`/api/admin/users/${id}`),
  listRoles: () => api.get('/api/admin/roles'),
  getConfig: () => api.get('/api/admin/config'),
  updateConfig: (body) => api.put('/api/admin/config', body),
  getConfigAudit: () => api.get('/api/admin/config/audit'),
  rollbackConfig: (auditId) => api.post('/api/admin/config/rollback', { auditId }),
  // One-off SMTP test send from the config page. Response shape:
  //   { ok: bool, error: string|null } — error is verbatim SMTP message on
  //   failure so the operator can debug without round-tripping the logs.
  sendTestEmail: ({ to }) => api.post('/api/admin/config/email/test', { to }),
  getAudit: ({ category, page = 1, size = 100, userId, actions, severities, from, to } = {}) => {
    const q = new URLSearchParams();
    if (category) q.set('category', category);
    q.set('page', String(page));
    q.set('size', String(size));
    if (userId) q.set('userId', String(userId));
    if (actions?.length) q.set('action', actions.join(','));
    if (severities?.length) q.set('severity', severities.join(','));
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    return api.get(`/api/admin/audit?${q.toString()}`);
  },
  getAuditBadge: async (category) => (await api.get(`/api/admin/audit/badge?category=${encodeURIComponent(category)}`)).data,
  exportAudit: async (format, filters = {}) => {
    const q = new URLSearchParams();
    q.set('format', format);
    if (filters.category) q.set('category', filters.category);
    if (filters.userId) q.set('userId', String(filters.userId));
    if (filters.actions?.length) q.set('action', filters.actions.join(','));
    if (filters.severities?.length) q.set('severity', filters.severities.join(','));
    if (filters.from) q.set('from', filters.from);
    if (filters.to) q.set('to', filters.to);
    const { data } = await api.get(`/api/admin/audit/export?${q.toString()}`, { responseType: 'blob' });
    return data;
  },
  // R158.87 (2026-10-12) — system-settings 域 功能开关. 3 method.
  //   getFeatureFlags         GET   /api/admin/system-settings-v2/feature-flags
  //   updateFeatureFlags      PUT   /api/admin/system-settings-v2/feature-flags
  //   getFeatureFlagState     GET   /api/admin/system-settings-v2/feature-flag-state/:key (公开)
  // R158.LA-V1-delete (2026-10-15) — 删 4 ADSPK V1 wrapper (getLicense / activateLicense
  //   / deactivateLicense / getLicenseStatusPublic). V2 base32 走下方 verifyBase32License /
  //   activateBase32License, LicenseView status 卡片改读 localStorage cache.
  getFeatureFlags: () => api.get('/api/admin/system-settings-v2/feature-flags').then(r => r.data),
  updateFeatureFlags: (flags) => api.put('/api/admin/system-settings-v2/feature-flags', { flags }).then(r => r.data),
  getFeatureFlagState: (key) => api.get(`/api/admin/system-settings-v2/feature-flag-state/${encodeURIComponent(key)}`).then(r => r.data),
  // R158.License-expiry (2026-10-15) — license 状态公开端点 wrapper.
  //   getLicenseState         GET   /api/admin/system-settings-v2/license-state (公开 NO middleware)
  //   公开端点跟 R158.103 /mcp/healthz 1:1 平行: 登录前 LoginView onMounted 调,
  //   main.js licenseState store 30s polling 也调, 0 走 userAuth.
  getLicenseState: () => api.get('/api/admin/system-settings-v2/license-state').then(r => r.data),
  // R158.License-config (2026-10-15) — "生产 license 申请单" 3 端点 wrapper.
  //   getLicenseSignature     GET   /api/admin/system-settings-v2/license/signature
  //   getServerMac            GET   /api/admin/system-settings-v2/license/server-mac
  //   exportLicenseRequest    GET   /api/admin/system-settings-v2/license/export-request?company=&mac=&months=&maxNodes=
  //   (R158.LA 2026-10-15) exportLicenseRequest 后端追加返 { request_id, json_path } 字段,
  //   前端 0 改 wrapper — 自动透传, 跟既有 7 字段 1:1 平行.
  getLicenseSignature: () => api.get('/api/admin/system-settings-v2/license/signature').then(r => r.data),
  getServerMac: () => api.get('/api/admin/system-settings-v2/license/server-mac').then(r => r.data),
  // R158.X.99.30.b (2026-10-19) — 加 appliedAt query param (可选). 0 必前端发时
  //   后端兜底 new Date().toISOString() 申请当下时戳. 老调法 0 必传仍兼容.
  exportLicenseRequest: ({ company, mac, months, maxNodes, appliedAt } = {}) => {
    const q = new URLSearchParams({ company: company || '', mac: mac || '', months: String(months ?? 0), maxNodes: String(maxNodes ?? 0) });
    if (appliedAt) q.set('appliedAt', String(appliedAt));
    return api.get(`/api/admin/system-settings-v2/license/export-request?${q.toString()}`).then(r => r.data);
  },
  // R158.LA (2026-10-15) — 5 段 base32 License 闭环 2 端点 wrapper.
  //   verifyBase32License     POST  /api/admin/system-settings-v2/license/base32/verify
  //     body: { license_code, request_id } → { ok, valid, company, months, max_nodes, expires_at, instance_id, license_code_masked }
  //   activateBase32License   POST  /api/admin/system-settings-v2/license/base32/activate
  //     body: { license_code, request_id, notes? } → { ok, license_status, license_kind, activated_at, expires_at, instance_id, license_id, license_key_masked, request_id }
  verifyBase32License: ({ licenseCode, requestId }) =>
    api.post('/api/admin/system-settings-v2/license/base32/verify', { license_code: licenseCode, request_id: requestId }).then(r => r.data),
  activateBase32License: ({ licenseCode, requestId, notes }) =>
    api.post('/api/admin/system-settings-v2/license/base32/activate', { license_code: licenseCode, request_id: requestId, notes: notes || null }).then(r => r.data),
  // R158.LA-hide-activated (2026-10-23) — 申请单列表改读后端, **已激活的不返回**
  //   (activated_at IS NULL 的单才在列表里)。
  //   取代旧的 sessionStorage 缓存: 那个是「刷新列表 = 再生成一份新申请单」,
  //   根本不读 DB, 且清缓存/换浏览器就全丢。本机收窄由后端按 instance_id 做。
  listLicenseRequests: (limit) =>
    api.get(`/api/admin/system-settings-v2/license/requests${limit ? `?limit=${encodeURIComponent(limit)}` : ''}`).then(r => r.data),
  // R158.AdminEmail (2026-10-15) — 管理员邮件通知收件人 (system_config.admin_email).
  //   getAdminEmail           GET   /api/admin/system-settings-v2/admin-email
  //   updateAdminEmail        PUT   /api/admin/system-settings-v2/admin-email  body: { email }
  //   后端 regex 校验 / 空字符串放行 (操作员主动清空). 走 sys_config_audit 留痕.
  getAdminEmail: () => api.get('/api/admin/system-settings-v2/admin-email').then(r => r.data),
  updateAdminEmail: (email) => api.put('/api/admin/system-settings-v2/admin-email', { email }).then(r => r.data),
  // R158.113.c (2026-10-17) — 访问域名 access_domain (system_config.access_domain).
  //   getAccessDomain           GET   /api/admin/system-settings-v2/access-domain
  //   updateAccessDomain        PUT   /api/admin/system-settings-v2/access-domain  body: { domain }
  //   后端 regex 校验 / 空字符串放行 (操作员主动清空回 fallback). 走 sys_config_audit 留痕.
  //   1:1 平行 R158.AdminEmail (line 78-82) 范式. 用于 McpReadTabView + McpWriteTokenView
  //   替换 <center>:<port> 占位符. value = 操作员配的域名, fallback = appsettings listen host:port
  //   拼的 "Agent 连接地址".
  getAccessDomain: () => api.get('/api/admin/system-settings-v2/access-domain').then(r => r.data),
  updateAccessDomain: (domain) => api.put('/api/admin/system-settings-v2/access-domain', { domain }).then(r => r.data),
  // R161.11 (2026-10-26) — 显示时区 (system_config.app_display_timezone).
  //   getSystemTimezone  GET /api/admin/system-settings-v2/timezone
  //     → { displayTimezone, displayTimezoneOffsetMinutes, storageContract,
  //         server: { dialect, sessionTimeZone, systemTimeZone,
  //                   sessionOffsetMinutes, serverTimeUtc, serverTimeSession,
  //                   pinnedToUtc },
  //         supportedCount }
  //   updateSystemTimezone  PUT 同一 URL, body: { timezone: 'Asia/Shanghai' }
  //     → { ok: true, displayTimezone, displayTimezoneOffsetMinutes }
  //   ★ 读是 userAuth (渲染层参数, 前台也要用), 写是 admin:config。
  //   ★ timezone 必须是 IANA 名 (Asia/Shanghai), 不接受 'GMT+8' 这类固定偏移串
  //     —— 后端 isValidTimeZone 拒掉, 前端也照同样的规则拦一道。
  getSystemTimezone: () => api.get('/api/admin/system-settings-v2/timezone').then(r => r.data),
  updateSystemTimezone: (timezone) => api.put('/api/admin/system-settings-v2/timezone', { timezone }).then(r => r.data),
  // R158.X.99.28 (2026-10-19) — MCP IP 白名单 (system_config.mcp_ip_whitelist
  //   + mcp_ip_whitelist_enabled, 2 个 KV 合并 1 个 endpoint). 1:1 平行
  //   R158.113.c access_domain + R158.AdminEmail admin_email 范式 (复用
  //   system-settings-v2 路由 + setConfig + sys_config_audit 留痕). 后端
  //   走 cidr.js parseIpList 验每行 IP / CIDR (0 必前端 verify). UI 3rd tab
  //   McpIpTabView 用 getMcpIpWhitelist 拉 + updateMcpIpWhitelist 写 + 启用
  //   toggle 走 save 时一并 PUT.
  getMcpIpWhitelist: () => api.get('/api/admin/system-settings-v2/mcp-ip-whitelist').then(r => r.data),
  updateMcpIpWhitelist: ({ list, enabled }) => api.put('/api/admin/system-settings-v2/mcp-ip-whitelist', { list, enabled }).then(r => r.data),
  listSitesCatalog: () => api.get('/api/admin/sites-catalog'),
  createSite: (body) => api.post('/api/admin/sites-catalog', body),
  updateSite: (id, body) => api.put(`/api/admin/sites-catalog/${id}`, body),
  deleteSite: (id) => api.delete(`/api/admin/sites-catalog/${id}`),
  listDcsCatalog: () => api.get('/api/admin/dcs-catalog'),
  assignDcSite: (dcName, siteId) => api.put(`/api/admin/dcs-catalog/${encodeURIComponent(dcName)}/site`, { siteId }),
  // R158.41 (2026-10-03) — DcsCatalogView 行级「域」下拉直接修改 ad_dcs.forest_domain_id.
  // domainId=null/undefined → unbind. 后端 audit 写 dcs_catalog_bind_domain/unbind_domain.
  setDcDomain: (dcName, forestDomainId) => api.put(`/api/admin/dcs-catalog/${encodeURIComponent(dcName)}/domain`, { forestDomainId }),
  // R158.41 — TopContextPicker dropdown DC 数据源 (主路径, 走 ad_dcs.forest_domain_id).
  listDcsByDomain: (domainId) => api.get(`/api/admin/dcs-catalog/by-domain/${domainId}`),
  // R158.44.1 — orphan DC 列表 (ad_dcs.forest_domain_id 指向不存在的 ad_forest_domain.id).
  // operator 反馈 2026-10-04: 「KDLFLOFADSRV1 归属 forestDomainId=2 明显的是错的」.
  listOrphanDcs: () => api.get('/api/admin/dcs-catalog/orphan'),
  // R158.44.1 — 一键清掉全部孤儿 FK (forest_domain_id → NULL).
  unbindAllOrphanDcs: () => api.post('/api/admin/dcs-catalog/orphan/unbind-all', {}),
  // 2026-08-27 round-29: toggle 5 FSMO roles + bridgehead directly from
  // the DcsCatalogView. body = any subset of { isPdc, isGc, isRidMaster,
  // isSchemaMaster, isDomainNamingMaster, isInfrastructureMaster,
  // isBridgehead } with strict booleans. Drives the bridgehead selection
  // used by the all-sites replication matrix view.
  updateDcFlags: (dcName, body) => api.put(`/api/admin/dcs-catalog/${encodeURIComponent(dcName)}/flags`, body),
  bulkImportSites: (rows) => api.post('/api/admin/sites-catalog/bulk', { rows }),
  bulkAssignDcs: (rows) => api.post('/api/admin/dcs-catalog/bulk-assign', { rows }),

  // ---- R158.X.115 (2026-10-20) — DC 生命周期 (与 member-servers 1:1 对称) ----
  //   权限 admin:ad-objects (管 DC), 不跟 member 的 admin:users 混。
  //   退役前置: 先在 AD 里降级 (FSMO 转移 + dcpromo), 降级后它从复制伙伴消失。
  previewDcLifecycle: (dcName) =>
    api.get(`/api/admin/dcs-catalog/${encodeURIComponent(dcName)}/lifecycle-preview`),
  pauseDcMonitoring: (dcName, body = {}) =>
    api.post(`/api/admin/dcs-catalog/${encodeURIComponent(dcName)}/pause-monitoring`, body),
  resumeDcMonitoring: (dcName, body = {}) =>
    api.post(`/api/admin/dcs-catalog/${encodeURIComponent(dcName)}/resume-monitoring`, body),
  decommissionDc: (dcName, body = {}) =>
    api.post(`/api/admin/dcs-catalog/${encodeURIComponent(dcName)}/decommission`, body),
  getDdlPreview: (name) => api.get(`/api/admin/packages/${name}/ddl-preview`),
  // 2026-08-28 round-53: listOrphanSchemas + dropOrphanSchema removed per
  // operator directive "删除Schema和清理菜单". Per feedback_full_chain_cleanup
  // the whole chain is gone — view, route, sidebar entry, API client.
  uninstallPackage: (name, { purgeMetrics = false, confirmDropSchema = false } = {}) =>
    api.delete(`/api/admin/packages/${name}`, { params: { purgeMetrics, confirmDropSchema } }),

  // ---- Non-AD member servers (Task 6/13) ----
  listMemberServers: () => api.get('/api/admin/member-servers'),
  getMemberServer: (hostname) => api.get(`/api/admin/member-servers/${encodeURIComponent(hostname)}`),
  createMemberServer: (body) => api.post('/api/admin/member-servers', body),
  updateMemberServer: (hostname, body) => api.put(`/api/admin/member-servers/${encodeURIComponent(hostname)}`, body),
  deleteMemberServer: (hostname) => api.delete(`/api/admin/member-servers/${encodeURIComponent(hostname)}`),
  listMemberServerPackages: (hostname) => api.get(`/api/admin/member-servers/${encodeURIComponent(hostname)}/packages`),
  setMemberServerPackageEnabled: (hostname, packageName, enabled) =>
    api.put(`/api/admin/member-servers/${encodeURIComponent(hostname)}/packages/${encodeURIComponent(packageName)}`, { enabled }),
  removeMemberServerPackage: (hostname, packageName) =>
    api.delete(`/api/admin/member-servers/${encodeURIComponent(hostname)}/packages/${encodeURIComponent(packageName)}`),
  // ---- R158.74 (2026-10-11) — MemberServer 业务端口 (admin 手填) ----
  //   业务类型: file-server / web / database / app-server / custom. port 1-65535.
  //   FK→ad_member_servers.hostname, 删主机自动清端口 (ON DELETE CASCADE).
  listMemberServerPorts: () => api.get('/api/admin/member-servers/ports'),
  listMemberServerPortsByHostname: (hostname) => api.get(`/api/admin/member-servers/ports/${encodeURIComponent(hostname)}`),
  upsertMemberServerPort: (data) => api.post('/api/admin/member-servers/ports', data),
  updateMemberServerPort: (hostname, port, data) => api.put(`/api/admin/member-servers/ports/${encodeURIComponent(hostname)}/${port}`, data),
  deleteMemberServerPort: (hostname, port) => api.delete(`/api/admin/member-servers/ports/${encodeURIComponent(hostname)}/${port}`),
  deleteMemberServerPortsByHostname: (hostname) => api.delete(`/api/admin/member-servers/ports/by-host/${encodeURIComponent(hostname)}`),

  // ---- R158.X.115 (2026-10-20) — 主机生命周期: 退役下线 / 暂停管控 ----
  //   与上面 deleteMemberServer 的区别 (UI 上「下线」按钮走这里):
  //   delete = 物理删除 + FK cascade 清历史 → agent 30min 后 self-register
  //            又建回来, 且审计线索没了。
  //   退役   = 打 decommissioned_at 标记 → 行留着、历史全保留, 仅退出告警
  //            与在线视图。终态不可逆 (已退役再调 → 409)。
  //   暂停   = 打 monitoring_paused_at 标记 → 临时态, 手动恢复, 无自动到期。
  //   lifecycle-preview 是纯读: 下线前告诉 UI 保留哪些历史 + 前置操作步骤。
  previewMemberServerLifecycle: (hostname) =>
    api.get(`/api/admin/member-servers/${encodeURIComponent(hostname)}/lifecycle-preview`),
  pauseMemberServerMonitoring: (hostname, body = {}) =>
    api.post(`/api/admin/member-servers/${encodeURIComponent(hostname)}/pause-monitoring`, body),
  resumeMemberServerMonitoring: (hostname, body = {}) =>
    api.post(`/api/admin/member-servers/${encodeURIComponent(hostname)}/resume-monitoring`, body),
  decommissionMemberServer: (hostname, body = {}) =>
    api.post(`/api/admin/member-servers/${encodeURIComponent(hostname)}/decommission`, body),
  // ---- R158.X.115 (2026-10-20) — 下线管理总览 (退役 + 暂停管控 一页看完) ----
  //   入参 status: all(退役∪暂停) | decommissioned | paused | active
  //        kind:   all(DC+member) | dc | member
  //   出参: {status, kind, dcs:[{kind:'dc', host, siteName, ipAddress, decommissionedAt, monitoringPausedAt, ...}], members:[{kind:'member', ...}]}
  //   权限双门 (admin:ad-objects & admin:users), 详情见 routes/admin.js:1427。
  listServerLifecycle: ({ status = 'all', kind = 'all' } = {}) =>
    api.get('/api/admin/server-lifecycle', { params: { status, kind } }),

  // ---- Non-AD server groups (Task 7/13) ----
  listServerGroups: () => api.get('/api/admin/server-groups'),
  createServerGroup: (body) => api.post('/api/admin/server-groups', body),
  updateServerGroup: (groupId, body) => api.put(`/api/admin/server-groups/${groupId}`, body),
  deleteServerGroup: (groupId) => api.delete(`/api/admin/server-groups/${groupId}`),
  listServerGroupMembers: (groupId) => api.get(`/api/admin/server-groups/${groupId}/members`),
  replaceServerGroupMembers: (groupId, hostnames) => api.put(`/api/admin/server-groups/${groupId}/members`, { hostnames }),
  // R158.X.116.r (2026-10-23) — 可加入的服务器清单 (仅在监控中的 MemberServer).
  //   刻意不复用 listMemberServers(): 那个端点要 admin:users, 而 server-groups
  //   全模块是 admin:file-push, 复用会让同页 403 (权限口径分裂)。
  listServerGroupMemberCandidates: () => api.get('/api/admin/server-groups/member-candidates'),
  // R158.X.116.r (2026-10-23) — 操作员要求移除 members 面板上的「批量包操作」
  //   (安装/卸载/启用/禁用) UI, 这 4 个方法当前**无前端调用方**。
  //   方法与后端端点都保留 (feedback-new-endpoint-dont-modify-old: 不删既有
  //   能力), 将来若要恢复 UI 或从别处复用可直接用。
  bulkInstallForGroup: (groupId, packageName) => api.post(`/api/admin/server-groups/${groupId}/packages/install`, { packageName }),
  bulkUninstallForGroup: (groupId, packageName) => api.post(`/api/admin/server-groups/${groupId}/packages/${encodeURIComponent(packageName)}/uninstall`),
  bulkEnableForGroup: (groupId, packageName) => api.post(`/api/admin/server-groups/${groupId}/packages/${encodeURIComponent(packageName)}/enable`),
  bulkDisableForGroup: (groupId, packageName) => api.post(`/api/admin/server-groups/${groupId}/packages/${encodeURIComponent(packageName)}/disable`),

  // ---- R158.68 系统内置告警 (替代 R158.62/63/67 AlertInboxView 全套) ----
  // 5 detector 内置 (heartbeat_offline / replication_failed / port_latency_high /
  // disk_low / failed_logon_spike), 阈值走 PUT /config, 不再有 per-rule CRUD.
  // 端点:
  //   GET    /api/admin/system-alerts?state=firing&kind=...&scope_ref=...&limit=100
  //   GET    /api/admin/system-alerts/recent?kind=...&limit=100
  //   GET    /api/admin/system-alerts/kpi
  //   GET    /api/admin/system-alerts/config
  //   PUT    /api/admin/system-alerts/config
  //   POST   /api/admin/system-alerts/:id/ack
  // ---- OS baseline (R158.68 — 取代原 member-servers/hostname/baseline) ----
  // Returns the latest per-agent snapshot fleet-wide; consumer filters
  // by hostname client-side.
  listOsBaseline: ({ sinceHours = 24 } = {}) => api.get(`/api/os-baseline?sinceHours=${sinceHours}`),
  listSystemAlerts: ({ state = 'firing', kind = '', scope_ref = '', limit = 100 } = {}) => {
    const q = new URLSearchParams();
    q.set('state', state);
    if (kind) q.set('kind', kind);
    if (scope_ref) q.set('scope_ref', scope_ref);
    q.set('limit', String(limit));
    return api.get(`/api/admin/system-alerts?${q.toString()}`);
  },
  listRecentSystemAlerts: ({ kind = '', limit = 100 } = {}) => {
    const q = new URLSearchParams();
    if (kind) q.set('kind', kind);
    q.set('limit', String(limit));
    return api.get(`/api/admin/system-alerts/recent?${q.toString()}`);
  },
  // R158.X.99.34.d (2026-10-19) — in-app notification polling wrapper.
  //   GET /api/admin/system-alerts/since?since=&limit= 走客户端 watermark
  //   (lastSeenAt 持久化 localStorage). 1:1 平行 listRecentSystemAlerts URLSearchParams
  //   范式. 返 { items, count, since }, 每 item 字段同 listSystemAlerts.
  listSystemAlertsSince: ({ since, limit = 50 } = {}) => {
    const q = new URLSearchParams();
    if (since) q.set('since', since);
    q.set('limit', String(limit));
    return api.get(`/api/admin/system-alerts/since?${q.toString()}`).then(r => r.data);
  },
  getSystemAlertKpi: () => api.get('/api/admin/system-alerts/kpi'),
  getSystemAlertConfig: () => api.get('/api/admin/system-alerts/config'),
  updateSystemAlertConfig: (updates) => api.put('/api/admin/system-alerts/config', updates),
  ackSystemAlert: (id, by) => api.post(`/api/admin/system-alerts/${id}/ack`, by ? { by } : {}),

  // ─── R158.Suppression (2026-10-15) — 操作员行级暂停告警 ───
  //   3 wrapper 1:1 平行 listSystemAlerts/ackSystemAlert. 走 query (kind/scope_ref),
  //   body 只 PUT 端带 reason (≤500 char 服务端截断). URLSearchParams 范式同 listSystemAlerts.
  listAlertSuppressions: ({ kind = 'replication_failed', limit = 500 } = {}) => {
    const q = new URLSearchParams();
    if (kind) q.set('kind', kind);
    q.set('limit', String(limit));
    return api.get(`/api/admin/system-alerts/suppressions?${q.toString()}`).then(r => r.data);
  },
  suppressAlert: (kind, scopeRef, reason = null) => {
    const q = new URLSearchParams();
    q.set('kind', kind);
    q.set('scope_ref', scopeRef);
    return api.put(`/api/admin/system-alerts/suppressions?${q.toString()}`, { reason }).then(r => r.data);
  },
  unsuppressAlert: (kind, scopeRef) => {
    const q = new URLSearchParams();
    q.set('kind', kind);
    q.set('scope_ref', scopeRef);
    return api.delete(`/api/admin/system-alerts/suppressions?${q.toString()}`).then(r => r.data);
  },

  // ---- Agent token rotation (auto-delivery, 2026-08-21 UX redesign) ----
  // The ConfigView "Agent 令牌" row drives these via AgentTokenRotateModal.
  // GET NEVER returns the secret (server-side by design — see center/src/routes/admin.js:363
  // and audit-classifier protection). Rotate returns newToken ONCE in the
  // response body so the operator can copy it for agent appsettings.json updates.
  // No operator-set TTL — the server's 5-minute internal grace is invisible;
  // agents pick up the new credential on their next heartbeat via the
  // agent_token_version monotonic counter (delivery endpoint surfaces this).
  getAgentTokenState: () => api.get('/api/admin/agent-token'),
  rotateAgentToken: () => api.post('/api/admin/agent-token/rotate'),
  commitAgentToken: () => api.post('/api/admin/agent-token/commit'),
  // Operator-initiated read of the active agent auth token. Drives the
  // "复制令牌" button on ConfigView — one click reveals + copies to
  // clipboard without rotating (so existing agents stay valid). Server
  // writes a high-severity reveal_agent_token audit row per call so
  // credential exposure leaves a trail.
  revealAgentToken: () => api.get('/api/admin/agent-token/reveal'),
  // Read-only snapshot of every agent's last-reported agent_token_version
  // vs the server's current version. The "生成新令牌" modal polls this
  // every 2s to render "已推送到 X / N 台 Agent" progress. An agent with
  // reportedVersion == serverVersion has picked up the new token; lower
  // means still on the old token (heartbeat hasn't fired, or offline).
  getAgentTokenDelivery: () => api.get('/api/admin/agent-token/delivery'),

  // ---- MCP (R158.102 2026-10-14) — Model Context Protocol Streamable
  //      HTTP server token. 1:1 平行 agent-token 上面 4 wrapper:
  //        getMcpTokenState     → { current_set, previous_set, rotatedAt, version }
  //        rotateMcpToken       → { newToken, rotatedAt, version }   (newToken 给 operator 1 次复制)
  //        commitMcpToken       → { ok: true, didCommit }
  //        revealMcpToken       → { token, revealedAt, version }      (high-severity audit row)
  //      McpTokenView.vue 用这 4 调管理 /mcp 接入凭证.
  getMcpTokenState: () => api.get('/api/admin/mcp-token'),
  rotateMcpToken: () => api.post('/api/admin/mcp-token/rotate'),
  commitMcpToken: () => api.post('/api/admin/mcp-token/commit'),
  revealMcpToken: () => api.get('/api/admin/mcp-token/reveal'),
  // R158.113 (2026-10-17) — MCP write tools token. 1:1 平行上面 4 wrapper.
  //   prefix mcpw_ 跟 mcp_ 区分 (跟 R158.113 server 端 middleware 1:1 平行).
  //   0 me 端 (操作员 directive "个人账户默认不能申请写入").
  getMcpWriteTokenState: () => api.get('/api/admin/mcp-write-token'),
  rotateMcpWriteToken: () => api.post('/api/admin/mcp-write-token/rotate'),
  commitMcpWriteToken: () => api.post('/api/admin/mcp-write-token/commit'),
  revealMcpWriteToken: () => api.get('/api/admin/mcp-write-token/reveal'),

  // ---- File push (2026-08-30 R65 followup — operator-driven file
  //      distribution to DCs / member servers). Center stages the
  //      bytes; agents pull on their next heartbeat and ack per-target.
  //      Mock-first: server keeps the file on local disk
  //      (data/file-push/) + JSON index, no DB table yet.
  uploadFile: ({ filename, contentB64, sha256, targetType, targets, targetPath }) =>
    api.post('/api/admin/file-push', { filename, contentB64, sha256, targetType, targets, targetPath }),
  // R158.69.12 (2026-10-11) — optional targetType filter so ad-file-push
  // 和 member-file-push view 各自只显示本类型 task. 不传 → 后端返全部 (兼容).
  listFilePushTasks: (targetType) => {
    const params = targetType ? { targetType } : {};
    return api.get('/api/admin/file-push', { params });
  },
  getFilePushTask: (id) => api.get(`/api/admin/file-push/${id}`),
  // getFilePushFileBlob returns the raw bytes (octet-stream). The
  // router sets X-File-Sha256 so the operator UI can sanity-check
  // downloads. We return the blob and let the caller drive UI.
  getFilePushFileBlob: async (id) => {
    const { data, headers } = await api.get(`/api/admin/file-push/${id}/file`, { responseType: 'blob' });
    return { blob: data, sha256: headers['x-file-sha256'] };
  },

  // ---- R158.35 (2026-10-03) — AD directory LDAP sync ----------------
  //
  // Backend-driven LDAP inventory sync (read-only — write actions like
  // 重置密码 still go through ad_admin_commands / agent-mediated). The
  // /api/admin/directory-sync/* endpoints back the new
  // DirectorySyncView; /api/admin/ad-{users,groups,ous} back
  // DailyOpsView's snapshot-mode reads.
  //
  // The config fields (ldapUrl / bindDn / bindPassword / baseDn /
  // intervalMinutes) are stored under the same /api/admin/config KV
  // (system_config table) — the directory-sync View PUTs the whole
  // config back, same as ConfigView. encryptBindPassword hook in
  // services/config.js handles at-rest encryption.
  // R158.46.1 (2026-10-06) — 同步周期单位 小时→分钟 (intervalHours → intervalMinutes).
  getDirectorySyncStatus: () => api.get('/api/admin/directory-sync/status'),
  // R158.45.34 (2026-10-06) — operator "在 /admin/directory-sync 定义同步周期":
  //   PUT intervalHours (1-168 整数小时) → 后端写 system_config.ad_sync_interval_hours.
  // R158.46.1 (2026-10-06) — operator 改单位 小时→分钟. 改 PUT 路径
  //   /interval-minutes, body 字段 intervalMinutes, 范围 1-1440 分钟整数,
  //   后端写 system_config.ad_sync_interval_minutes. 老 setDirectorySyncIntervalHours
  //   函数保留为 throw stub, 给任何残留调用方明确错误 (不会再被新代码调用).
  setDirectorySyncIntervalMinutes: (intervalMinutes) => api.put('/api/admin/directory-sync/interval-minutes', { intervalMinutes }),
  setDirectorySyncIntervalHours: (_intervalHours) => {
    throw new Error('R158.46.1 removed: setDirectorySyncIntervalHours → use setDirectorySyncIntervalMinutes');
  },
  triggerDirectorySync: (body) => api.post('/api/admin/directory-sync', body || {}),
  listDirectorySyncRuns: (limit = 20) => api.get(`/api/admin/directory-sync/runs?limit=${limit}`),
  listAdUsers: ({ dc, filter = '', limit = 200, offset = 0, ouDn = '' } = {}) => {
    const q = new URLSearchParams({ dc });
    if (filter) q.set('filter', filter);
    if (ouDn) q.set('ouDn', ouDn);
    q.set('limit', String(limit));
    q.set('offset', String(offset));
    return api.get(`/api/admin/ad-users?${q}`);
  },
  listAdGroups: ({ dc, filter = '', limit = 200, offset = 0, ouDn = '' } = {}) => {
    const q = new URLSearchParams({ dc });
    if (filter) q.set('filter', filter);
    if (ouDn) q.set('ouDn', ouDn);
    q.set('limit', String(limit));
    q.set('offset', String(offset));
    return api.get(`/api/admin/ad-groups?${q}`);
  },
  // R158.44.7.10 (2026-10-05) — computer snapshot read (mirror listAdUsers).
  listAdComputers: ({ dc, filter = '', limit = 200, offset = 0, ouDn = '' } = {}) => {
    const q = new URLSearchParams({ dc });
    if (filter) q.set('filter', filter);
    if (ouDn) q.set('ouDn', ouDn);
    q.set('limit', String(limit));
    q.set('offset', String(offset));
    return api.get(`/api/admin/ad-computers?${q}`);
  },
  listAdOus: (dc) => api.get(`/api/admin/ad-ous?dc=${encodeURIComponent(dc)}`),
  // R158.45.10 (2026-10-05) — operator "选了森林和域就显示域树, 跟后面的参数无关":
  //   OU 树按域加载, 接受 `domain` (FQDN) 参数, 跳过 hostnameToDomainName 转换.
  listAdOusByDomain: (domain) => api.get(`/api/admin/ad-ous?domain=${encodeURIComponent(domain)}`),
  listAdUsersByDomain: ({ domain, filter = '', offset = 0, ouDn = '', limit = 5000 } = {}) => {
    const q = new URLSearchParams({ domain });
    if (filter) q.set('filter', filter);
    if (ouDn) q.set('ouDn', ouDn);
    q.set('limit', String(limit));
    q.set('offset', String(offset));
    return api.get(`/api/admin/ad-users?${q}`);
  },
  listAdGroupsByDomain: ({ domain, filter = '', offset = 0, ouDn = '', limit = 5000 } = {}) => {
    const q = new URLSearchParams({ domain });
    if (filter) q.set('filter', filter);
    if (ouDn) q.set('ouDn', ouDn);
    q.set('limit', String(limit));
    q.set('offset', String(offset));
    return api.get(`/api/admin/ad-groups?${q}`);
  },
  listAdComputersByDomain: ({ domain, filter = '', offset = 0, ouDn = '', limit = 5000 } = {}) => {
    const q = new URLSearchParams({ domain });
    if (filter) q.set('filter', filter);
    if (ouDn) q.set('ouDn', ouDn);
    q.set('limit', String(limit));
    q.set('offset', String(offset));
    return api.get(`/api/admin/ad-computers?${q}`);
  },
  // R158.60.20 (2026-10-09) — read the user-group membership snapshot
  // directly (replaces the R75 ad_user_list_groups agent poll, 22.5s
  // timeout). Backend is /api/admin/ad-users/:sam/groups, served by the
  // 5-min sync against ad_user_group_memberships.
  listAdUserGroupsByDomain: ({ domain, sam }) =>
    api.get(`/api/admin/ad-users/${encodeURIComponent(sam)}/groups?domain=${encodeURIComponent(domain)}`),
  // R158.60.22 (2026-10-09) — group→members 直查. 跟 listAdUserGroupsByDomain
  // 对称, 走 30min sync (R158.46.1) 写入的 ad_user_group_memberships 表.
  // 给 GroupPropertyPanel 3 个 popover (managedBy/add/remove) 候选下拉用.
  // 大组 (Domain Users 8000+) 不在 ugm (R158.60.20.2 范围), 业务组全有.
  listAdGroupMembersByDomain: ({ domain, name }) =>
    api.get(`/api/admin/ad-groups/${encodeURIComponent(name)}/members?domain=${encodeURIComponent(domain)}`),
  // ---- R158.43 (2026-10-03) — AD 同步结果只读预览 ---------------------
  // 三个 endpoint 都只读 (admin:ad-objects perm), 不写 audit, 不触发 sync.
  // SnapshotTreeSection 用它们在 /admin/directory-sync 页面底部展示已同步的
  // OU / 用户 / 组 树状 (operator 选 forest→domain→DC 后自动拉).
  getDirectorySyncForestSummary: () =>
    api.get('/api/admin/directory-sync/forest-summary'),
  getDirectorySyncDomainBinding: (domainId) =>
    api.get(`/api/admin/directory-sync/domain-binding/${domainId}`),
  getDirectorySyncSnapshot: (dcName) =>
    api.get(`/api/admin/directory-sync/snapshot/${encodeURIComponent(dcName)}`),
  ackFilePushTask: (id, { hostname, agentId, ok, errorMessage }) =>
    api.post(`/api/admin/file-push/${id}/ack`, { hostname, agentId, ok, errorMessage }),

  // ---- R158.61 (2026-10-10) — daily / weekly email report ------
  // runReportNow triggers an immediate enqueue (does NOT send — the
  // existing email delivery loop picks up the outbox row). Body:
  //   { kind: 'daily' | 'weekly' }
  // Response 201: { ok, kind, runId, outboxId, to, cc, subject, htmlSize,
  //                summary, periodStart, periodEnd }
  // Response 400: { error, kind } — config issue (no recipients)
  runReportNow: ({ kind }) => api.post('/api/admin/reports/run', { kind }),
  // listReportHistory returns the most recent N runs (default 20) for
  // either kind or both. Response: { rows, count, kind, limit }.
  // Each row carries id, kind, period_start/end, generated_at, to/cc,
  // subject, status, last_error, outbox_id, html_size.
  listReportHistory: ({ kind = null, limit = 20 } = {}) => {
    const q = new URLSearchParams();
    if (kind) q.set('kind', kind);
    q.set('limit', String(limit));
    return api.get(`/api/admin/reports/history?${q.toString()}`);
  },
  // previewReport returns the rendered HTML as text/html (open in a new
  // tab to inspect before saving cron / recipient config). The endpoint
  // does not enqueue; pure render.
  previewReport: ({ kind }) => api.get(`/api/admin/reports/preview?kind=${kind}`, { responseType: 'text' }),

  // ---- R158.69 (2026-10-10) — 邮件历史 (EmailConfigView "邮件历史" tab) ----
  // UNION ALL 查 system_alert_outbox + report_email_outbox (operator 决策不建新表).
  // 默认 30 天 / all kind / 200 rows cap. 后端会再次强制 days=1..180, limit=1..500.
  // Response: { rows, count, days, kind, limit }. 每 row 字段: source='alert'|'report',
  //   ref_id, kind_detail ('daily'|'weekly'|null), to_addrs, cc_addrs, subject,
  //   attempt_count, max_attempts, last_error, sent_at, next_attempt_at, id.
  listEmailHistory: ({ days = 30, kind = 'all', limit = 200 } = {}) => {
    const q = new URLSearchParams();
    q.set('days', String(days));
    q.set('kind', kind);
    q.set('limit', String(limit));
    return api.get(`/api/admin/email-history?${q.toString()}`);
  },

  // ---- R158.100.A (2026-10-14) — 单行邮件历史详情 (drawer 用) ----
  //   返回 { row: { ...所有 outbox 字段, source } }. 含 body_text / body_html
  //   (列表接口不返, 性能保护). 后端 source whitelisted (防 SQL injection),
  //   id 必正整数. 鉴权同 listEmailHistory (admin:config).
  getEmailHistoryDetail: ({ source, id }) => {
    if (source !== 'alert' && source !== 'report') {
      return Promise.reject(new Error('source must be alert|report'));
    }
    if (!Number.isInteger(Number(id)) || Number(id) <= 0) {
      return Promise.reject(new Error('id must be positive integer'));
    }
    return api.get(`/api/admin/email-history/${encodeURIComponent(source)}/${encodeURIComponent(id)}`);
  },

  // ---- R158.100.B (2026-10-14) — 邮件队列 (EmailConfigView 7th tab) ----
  //   跨 system_alert_outbox + report_email_outbox UNION ALL (跟 history 1:1).
  //   只查 sent_at IS NULL (未发出), status 字段前端 derive (att<5=pending /
  //   att>=5=exhausted, 后端只返真相 attempt_count + max_attempts).
  //   鉴权同 listEmailHistory (admin:config). 0 改 email-history 既有 wrapper.
  // Response: { rows, count, limit }. 字段: source, ref_id, kind_detail,
  //   to_addrs, cc_addrs, subject, attempt_count, max_attempts, last_error,
  //   next_attempt_at, id.
  listEmailQueue: ({ limit = 500 } = {}) => {
    const q = new URLSearchParams();
    q.set('limit', String(limit));
    return api.get(`/api/admin/email-queue?${q.toString()}`);
  },
  // [重发] — POST 后端, 不重置 att, next_attempt_at=now, 下次 tick 立即挑.
  // Response: { ok: true, affected, source, id } (200) / 404 / 500.
  retryEmailQueue: ({ source, id }) => {
    if (source !== 'alert' && source !== 'report') return Promise.reject(new Error('source must be alert|report'));
    if (!Number.isInteger(Number(id)) || Number(id) <= 0) return Promise.reject(new Error('id must be positive integer'));
    return api.post(`/api/admin/email-queue/${encodeURIComponent(source)}/${encodeURIComponent(id)}/retry`);
  },
  // [放弃] — DELETE 后端, 硬删. R158.100-fix markExhausted 双层防御已
  // 就位, 删后行 0 复活. Response: { ok: true, affected, source, id } (200) / 404 / 500.
  deleteEmailQueue: ({ source, id }) => {
    if (source !== 'alert' && source !== 'report') return Promise.reject(new Error('source must be alert|report'));
    if (!Number.isInteger(Number(id)) || Number(id) <= 0) return Promise.reject(new Error('id must be positive integer'));
    return api.delete(`/api/admin/email-queue/${encodeURIComponent(source)}/${encodeURIComponent(id)}`);
  },

  // ---- R158.100.C (2026-10-14) — AD 操作通知 preview ----
  //   POST /api/admin/ad-notify/preview. 拿当前 cfg + 13 占位符 mock 值
  //   → 渲染 → 返 { subject, body_text, body_html }. EmailConfigView
  //   "预览通知" 按钮调, 0 真发邮件.
  previewAdNotify: () => api.post('/api/admin/ad-notify/preview', {}),

  // ---- R158.37 (2026-10-03) — 域和森林注册 (Forest Registry) -------
  // 后台「运维」下「域和森林注册」入口的 CRUD API. 4 张物理表 (ad_forest /
  // ad_forest_domain / ad_forest_dc_assignment / ad_forest_setting) 的
  // 全部入口。bind_password 写路径接明文 — service 走 ad-credential-vault.js
  // AES-256-GCM 加密; 读路径永远 mask 为 '********'。
};

// Named export so DailyOpsView (顶部 forest picker) + ForestRegistryView
// (三 tab 页) 直接 import { forestRegistryApi } 解构 — 避免 namespace 嵌套
// 污染 adminApi 主对象。
export const forestRegistryApi = {
  listForests: () => api.get('/api/admin/forest-registry/forests'),
  createForest: (body) => api.post('/api/admin/forest-registry/forests', body),
  updateForest: (id, body) => api.put(`/api/admin/forest-registry/forests/${id}`, body),
  deleteForest: (id) => api.delete(`/api/admin/forest-registry/forests/${id}`),
  setDefaultForest: (id) => api.post(`/api/admin/forest-registry/forests/${id}/default`, {}),
  listDomains: (forestId) => api.get(`/api/admin/forest-registry/forests/${forestId}/domains`),
  createDomain: (forestId, body) => api.post(`/api/admin/forest-registry/forests/${forestId}/domains`, body),
  deleteDomain: (domainId) => api.delete(`/api/admin/forest-registry/domains/${domainId}`),
  assignDc: (domainId, body) => api.post(`/api/admin/forest-registry/domains/${domainId}/assign-dc`, body),
  unassignDc: (hostname) => api.delete(`/api/admin/forest-registry/dc-assignments/${encodeURIComponent(hostname)}`),
  listSettings: (forestId) => api.get(`/api/admin/forest-registry/forests/${forestId}/settings`),
  setSetting: (forestId, key, value) => api.put(`/api/admin/forest-registry/forests/${forestId}/settings/${encodeURIComponent(key)}`, { value }),
  deleteSetting: (forestId, key) => api.delete(`/api/admin/forest-registry/forests/${forestId}/settings/${encodeURIComponent(key)}`),
  // R158.38.3 (2026-10-03) — 域级设置 (ad_forest_domain_setting). 独立表,
  // 与森林级设置 endpoint 完全对称 (独立决策 B).
  listDomainSettings: (domainId) => api.get(`/api/admin/forest-registry/domains/${domainId}/settings`),
  setDomainSetting: (domainId, key, value) => api.put(`/api/admin/forest-registry/domains/${domainId}/settings/${encodeURIComponent(key)}`, { value }),
  deleteDomainSetting: (domainId, key) => api.delete(`/api/admin/forest-registry/domains/${domainId}/settings/${encodeURIComponent(key)}`),
  // R158.39 (2026-10-03) — 切换某域自动同步开关 (ForestRegistry Tab 2 自动
  // 同步复选框). enabled=false 时 cron tick 跳过该域; 手动触发 DirectorySyncView
  // 多选仍可临时勾选同步 disabled 域.
  setDomainSyncEnabled: (domainId, enabled) => api.patch(`/api/admin/forest-registry/domains/${domainId}/sync-enabled`, { enabled }),
  // R158.5.4 (2026-10-04) — 域级 bind_password 覆盖 (DirectorySyncView 矩阵
  // 行内 [设置密码] 按钮). 同步优先级: domain 覆盖 > forest.bind_password.
  // 空字符串 = 删除 KV 恢复读森林.
  setDomainBindPassword: (domainId, bindPassword) => api.put(`/api/admin/forest-registry/domains/${domainId}/bind-password`, { bindPassword }),
  hasDomainBindPassword: (domainId) => api.get(`/api/admin/forest-registry/domains/${domainId}/has-bind-password`),
  // R158.37.1 (2026-10-03) — AD 服务器与域关联 dropdown 数据源
  listAvailableDcs: () => api.get('/api/admin/forest-registry/dcs-available'),
  // R158.40 (2026-10-03) — ADUC 顶部 DC dropdown 数据源. 三段优先级:
  // assignment → domain.dc_hostname → PDC emulator (复用 services/ad-forest-registry.js
  // pickDcsForDomain). 返回 [{ hostname, isPdc, source: 'assignment'|'domainField'|'pdc' }].
  listDomainDcs: (domainId) => api.get(`/api/admin/forest-registry/domains/${domainId}/dcs`),
  // R158.38.2 (2026-10-03) — 中心端 binding 概念删除. 中心 LDAP sync 由
  // ad_forest.is_default=1 森林驱动, 无独立 binding 端点. R158.39 将把
  // DC↔domain 绑定移到 AD 域控清单.
};