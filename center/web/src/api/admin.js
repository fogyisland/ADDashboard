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
  listSitesCatalog: () => api.get('/api/admin/sites-catalog'),
  createSite: (body) => api.post('/api/admin/sites-catalog', body),
  updateSite: (id, body) => api.put(`/api/admin/sites-catalog/${id}`, body),
  deleteSite: (id) => api.delete(`/api/admin/sites-catalog/${id}`),
  listDcsCatalog: () => api.get('/api/admin/dcs-catalog'),
  assignDcSite: (dcName, siteId) => api.put(`/api/admin/dcs-catalog/${encodeURIComponent(dcName)}/site`, { siteId }),
  // 2026-08-27 round-29: toggle 5 FSMO roles + bridgehead directly from
  // the DcsCatalogView. body = any subset of { isPdc, isGc, isRidMaster,
  // isSchemaMaster, isDomainNamingMaster, isInfrastructureMaster,
  // isBridgehead } with strict booleans. Drives the bridgehead selection
  // used by the all-sites replication matrix view.
  updateDcFlags: (dcName, body) => api.put(`/api/admin/dcs-catalog/${encodeURIComponent(dcName)}/flags`, body),
  bulkImportSites: (rows) => api.post('/api/admin/sites-catalog/bulk', { rows }),
  bulkAssignDcs: (rows) => api.post('/api/admin/dcs-catalog/bulk-assign', { rows }),
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

  // ---- Non-AD server groups (Task 7/13) ----
  listServerGroups: () => api.get('/api/admin/server-groups'),
  createServerGroup: (body) => api.post('/api/admin/server-groups', body),
  updateServerGroup: (groupId, body) => api.put(`/api/admin/server-groups/${groupId}`, body),
  deleteServerGroup: (groupId) => api.delete(`/api/admin/server-groups/${groupId}`),
  listServerGroupMembers: (groupId) => api.get(`/api/admin/server-groups/${groupId}/members`),
  replaceServerGroupMembers: (groupId, hostnames) => api.put(`/api/admin/server-groups/${groupId}/members`, { hostnames }),
  bulkInstallForGroup: (groupId, packageName) => api.post(`/api/admin/server-groups/${groupId}/packages/install`, { packageName }),
  bulkUninstallForGroup: (groupId, packageName) => api.post(`/api/admin/server-groups/${groupId}/packages/${encodeURIComponent(packageName)}/uninstall`),
  bulkEnableForGroup: (groupId, packageName) => api.post(`/api/admin/server-groups/${groupId}/packages/${encodeURIComponent(packageName)}/enable`),
  bulkDisableForGroup: (groupId, packageName) => api.post(`/api/admin/server-groups/${groupId}/packages/${encodeURIComponent(packageName)}/disable`),

  // ---- Non-AD alert rules + events (Task 14) ----
  // listAlertRules takes optional hostname filter so the detail view can
  // render "规则数: N" without listing every rule on the page.
  listAlertRules: (hostname) => {
    const q = hostname ? `?hostname=${encodeURIComponent(hostname)}` : '';
    return api.get(`/api/admin/alert-rules${q}`);
  },
  upsertAlertRule: (body) => api.post('/api/admin/alert-rules', body),
  deleteAlertRule: (ruleId) => api.delete(`/api/admin/alert-rules/${ruleId}`),
  listMemberServerAlerts: (hostname) =>
    api.get(`/api/admin/member-servers/${encodeURIComponent(hostname)}/alerts`),
  getMemberServerBaseline: (hostname) =>
    api.get(`/api/admin/member-servers/${encodeURIComponent(hostname)}/baseline`),

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

};