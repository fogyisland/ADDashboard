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
  getAuditBadge: (category) => api.get(`/api/admin/audit/badge?category=${encodeURIComponent(category)}`),
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
  bulkImportSites: (rows) => api.post('/api/admin/sites-catalog/bulk', { rows }),
  bulkAssignDcs: (rows) => api.post('/api/admin/dcs-catalog/bulk-assign', { rows })
};