import axios from 'axios';
import router from '../router.js';
import { notifyError } from '../lib/notify.js';

const api = axios.create({ baseURL: '/', timeout: 30000 });

api.interceptors.request.use(cfg => {
  const t = localStorage.getItem('ad_token');
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

api.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401 && !location.pathname.startsWith('/login')) {
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
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', e => {
    const msg = e.reason?.response?.data?.error
      || e.reason?.response?.data?.message
      || e.reason?.message
      || '请求失败';
    notifyError(typeof msg === 'string' ? msg : '请求失败');
  });
}

export default api;