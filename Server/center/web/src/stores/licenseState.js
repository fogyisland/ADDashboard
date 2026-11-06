// R158.License-expiry (2026-10-15) — License 状态 Pinia store + 30s polling.
//
// 1:1 平行 stores/featureFlags.js. 公开端点 (NO middleware, R158.103 precedent),
// 登录前 LoginView onMounted 也调. 跟 featureFlags 不同: 不需 isLoggedIn gate,
// main.js 启动时直接 startPolling. fail-closed (R158.103 lesson): API 失败 →
// 保持空 state, shouldRedirect 永远 false, 不锁死 admin.

import { defineStore } from 'pinia';
import { adminApi } from '../api/admin.js';

const EMPTY_STATE = {
  has_license: false,
  status: 'unknown',
  should_redirect: false,
  days_remaining: null,
  days_until_warning: 30
};

export const useLicenseStateStore = defineStore('licenseState', {
  state: () => ({
    store: { ...EMPTY_STATE },
    lastFetchedAt: 0,
    _timer: null
  }),
  getters: {
    status: (s) => s.store.status,
    hasLicense: (s) => s.store.has_license === true,
    daysRemaining: (s) => s.store.days_remaining,
    daysUntilWarning: (s) => s.store.days_until_warning,
    isExpiringSoon: (s) => s.store.status === 'expiring_soon',
    isExpired: (s) => s.store.status === 'expired',
    shouldRedirect: (s) => s.store.should_redirect === true
  },
  actions: {
    async fetch({ force = false } = {}) {
      // 5s in-memory cache: 防止同 tick 内 AppLayout + router + LoginView 3 处并发.
      const now = Date.now();
      if (!force && now - this.lastFetchedAt < 5000) return;
      try {
        const data = await adminApi.getLicenseState();
        this.store = { ...EMPTY_STATE, ...data };
        this.lastFetchedAt = now;
      } catch (_e) {
        // fail-closed: 保持空 state, shouldRedirect 永远 false.
        // 跟 featureFlags.js fetchAll 1:1 平行 swallow 模式.
      }
    },
    startPolling(intervalMs = 30000) {
      if (this._timer) return;
      this.fetch().then(() => {
        this._timer = setInterval(() => this.fetch(), intervalMs);
      });
    },
    stopPolling() {
      if (this._timer) {
        clearInterval(this._timer);
        this._timer = null;
      }
    }
  }
});
