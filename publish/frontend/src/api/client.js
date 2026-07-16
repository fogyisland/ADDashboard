import axios from 'axios';
import router from '../router.js';

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

export default api;