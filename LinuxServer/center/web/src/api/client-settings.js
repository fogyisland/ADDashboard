import api from './client.js';

// R158.13 (2026-10-01) 起后端就有这 3 个端点, 但前端 0 入口 —— 操作员只能
// 登每台 server 手改 appsettings.json. R158.X.99 (2026-10-21) 补上 UI.
//
// 3 端点 (routes/admin.js, 全部挂在 authConfig = baseAuth + admin:config):
//   GET  /state     → { settings, version }         当前服务端状态
//   POST /push      → { ok, version, settings }     bump version + merge patch
//   GET  /delivery  → { serverVersion, total, delivered, agents[] }  推送进度
export const getState = () => api.get('/api/admin/client-settings/state');
export const push = (patch) => api.post('/api/admin/client-settings/push', { patch });
export const getDelivery = () => api.get('/api/admin/client-settings/delivery');