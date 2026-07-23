import api from './client.js';

export const portsApi = {
  list:   ()       => api.get('/api/admin/ports'),
  create: (body)   => api.post('/api/admin/ports', body),
  update: (id, b)  => api.put(`/api/admin/ports/${id}`, b),
  remove: (id)     => api.delete(`/api/admin/ports/${id}`)
};