import { defineStore } from 'pinia';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem('ad_token'),
    user: JSON.parse(localStorage.getItem('ad_user') || 'null')
  }),
  getters: {
    isLoggedIn: (s) => !!s.token,
    isAdmin: (s) => s.user?.role === 'admin'
  },
  actions: {
    async login({ username, password }, apiCall) {
      const r = await apiCall({ username, password });
      this.token = r.data.token;
      this.user = r.data.user;
      localStorage.setItem('ad_token', this.token);
      localStorage.setItem('ad_user', JSON.stringify(this.user));
    },
    logout() {
      this.token = null;
      this.user = null;
      localStorage.removeItem('ad_token');
      localStorage.removeItem('ad_user');
    }
  }
});
