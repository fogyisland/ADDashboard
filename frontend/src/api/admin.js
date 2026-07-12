import api from './client.js';
export const adminApi = {
  listUsers: () => api.get('/api/admin/users'),
  createUser: (body) => api.post('/api/admin/users', body),
  updateUser: (id, body) => api.put(`/api/admin/users/${id}`, body),
  deleteUser: (id) => api.delete(`/api/admin/users/${id}`),
  listRoles: () => api.get('/api/admin/roles'),
  getConfig: () => api.get('/api/admin/config'),
  updateConfig: (body) => api.put('/api/admin/config', body),
  getAudit: (limit = 200) => api.get(`/api/admin/audit?limit=${limit}`),
  listSites: () => api.get('/api/admin/sites'),
  listDcs: () => api.get('/api/admin/dcs'),
  listSitesCatalog: () => api.get('/api/admin/sites-catalog'),
  createSite: (body) => api.post('/api/admin/sites-catalog', body),
  updateSite: (id, body) => api.put(`/api/admin/sites-catalog/${id}`, body),
  deleteSite: (id) => api.delete(`/api/admin/sites-catalog/${id}`)
};