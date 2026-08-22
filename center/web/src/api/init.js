import api from './client.js';

export const getStatus = () => api.get('/api/init/status');
export const testDb = (params) => api.post('/api/init/db/test', params);
export const applyDb = (params) => api.post('/api/init/db/apply', params);
export const createAdmin = (params) => api.post('/api/init/admin/create', params);
export const finalize = (params) => api.post('/api/init/finalize', params);