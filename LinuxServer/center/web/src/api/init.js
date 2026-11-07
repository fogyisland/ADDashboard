import api from './client.js';

// R161.30 (2026-11-07) — S1 修复: init 向导写端点要求 x-installer-token。
// 令牌由中心启动时生成, 落在服务器安装目录的 .installer-token 文件里;
// 操作员把它粘贴进向导第 1 步, 存 sessionStorage (会话结束即消失),
// 之后四个写请求统一经 interceptor 注入请求头。
export const INSTALLER_TOKEN_STORAGE_KEY = 'ad_installer_token';

export function getInstallerToken() {
  try {
    return sessionStorage.getItem(INSTALLER_TOKEN_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setInstallerToken(token) {
  try {
    sessionStorage.setItem(INSTALLER_TOKEN_STORAGE_KEY, String(token || '').trim());
  } catch {
    // sessionStorage 不可用 (隐私模式等) — token 留在内存副本里, 本次会话仍可用。
  }
}

export const getStatus = () => api.get('/api/init/status');
export const testDb = (params) => api.post('/api/init/db/test', params);
export const applyDb = (params) => api.post('/api/init/db/apply', params);
export const createAdmin = (params) => api.post('/api/init/admin/create', params);
export const finalize = (params) => api.post('/api/init/finalize', params);