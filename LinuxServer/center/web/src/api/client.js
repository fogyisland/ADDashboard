import axios from 'axios';
import router from '../router.js';
import { notifyError } from '../lib/notify.js';
import { getInstallerToken } from './init.js';

const api = axios.create({ baseURL: '/', timeout: 30000 });

api.interceptors.request.use(cfg => {
  const t = localStorage.getItem('ad_token');
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  // R161.30 (2026-11-07) — S1 修复: init 向导写请求携带 installer token。
  // 只在向导流程里存在 (sessionStorage), 不影响正常模式的任何请求。
  const installerToken = getInstallerToken();
  if (installerToken) cfg.headers['x-installer-token'] = installerToken;
  return cfg;
});

// R158.103 (2026-10-14) — 后台 polling 401 白名单.
//
// 哪些 endpoint 是 "未登录也可以失败" 的:
//   · /api/admin/system-settings-v2/feature-flags  — main.js:18 mount 时
//     全局 30s 拉, 未登录访客本来就 401, store 内部 try/catch(_e) swallow
//     已经吞掉, axios 重定向到 /login 是 false-positive: 把 localStorage
//     ad_token 清掉会污染已登录 session.
//   · 后续要追加 polling 类 endpoint, 加入此 set 即可.
//
// 白名单命中 → 仅 return Promise.reject(err),不动 token,不 redirect.
// 白名单不命中 → 走原 401 拦截器逻辑 (清 token + push /login).
//
// R159 (2026-10-25 重放, 2026-11-06) — /api/admin/system-alerts/since 加入:
// in-app notification polling (main.js startInappPolling) 的 401 同样该被
// store swallow, 不该清 token 跳 /login —— 与 feature-flags 完全同类.
const ANONYMOUS_OK_401 = new Set([
  '/api/admin/system-settings-v2/feature-flags',
  '/api/admin/system-alerts/since',
]);

function _isAnonymousOk401(err) {
  if (err?.response?.status !== 401) return false;
  const path = String(err.config?.url || '').split('?')[0];
  return ANONYMOUS_OK_401.has(path);
}

api.interceptors.response.use(
  r => r,
  err => {
    // R161.30 — /init 向导路径上的 401 (installer token 错误) 同理不清 token
    // 不跳 /login: 此时用户本来就没有登录态, 跳转会覆盖掉向导路由。
    if (!_isAnonymousOk401(err)
        && err.response?.status === 401
        && !location.pathname.startsWith('/login')
        && !location.pathname.startsWith('/init')) {
      localStorage.removeItem('ad_token');
      router.push('/login');
    }
    return Promise.reject(err);
  }
);

// Last-resort surface for errors that escape per-caller try/catch
// (forgotten await, fire-and-forget promise chains, lazy watchers).
// Per-view try/catch is still the right place for user-facing messages;
// this listener only fires when nothing else did. Keeping the listener
// in client.js means it lives next to the axios interceptors that
// originate most of these rejections.
//
// R158.103 — 白名单 endpoint 的 401 不弹 toast (后台 polling fail-closed
// 抖动不应惊扰用户). 其它未捕获 reject 仍走 notifyError.
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', e => {
    if (_isAnonymousOk401(e.reason)) return;
    const msg = e.reason?.response?.data?.error
      || e.reason?.response?.data?.message
      || e.reason?.message
      || '请求失败';
    notifyError(typeof msg === 'string' ? msg : '请求失败');
  });
}

export default api;