import { defineStore } from 'pinia';
import api from '../api/client.js';

// Pinia store for the admin Package Management views.
//
// State:
//   installed: array of installed-package rows from /api/admin/packages
//   registryCache: lightweight metadata about the most recent registry fetch
//   loading: true while a fetch/install/etc. is in flight
//   error: last error message (string) or null
//
// Actions all hit the Task-6 admin endpoints and refetch installed() after
// mutating state, so the table UI always reflects what's persisted.
export const usePackagesStore = defineStore('packages', {
  state: () => ({
    installed: [],
    registryCache: { url: null, fetchedAt: null },
    loading: false,
    error: null,
  }),

  getters: {
    enabledPackages: (state) => state.installed.filter((p) => p.enabled),
  },

  actions: {
    async fetchInstalled() {
      this.loading = true;
      this.error = null;
      try {
        const r = await api.get('/api/admin/packages');
        this.installed = Array.isArray(r.data?.packages) ? r.data.packages : [];
      } catch (e) {
        this.error = e.response?.data?.error?.message || e.message;
        throw e;
      } finally {
        this.loading = false;
      }
    },

    async install({ source, packageRef, buffer }) {
      const r = await api.post('/api/admin/packages/install', { source, packageRef, buffer });
      await this.fetchInstalled();
      return r.data;
    },

    async enable(name) {
      await api.post(`/api/admin/packages/${encodeURIComponent(name)}/enable`);
      await this.fetchInstalled();
    },

    async disable(name) {
      await api.post(`/api/admin/packages/${encodeURIComponent(name)}/disable`);
      await this.fetchInstalled();
    },

    async uninstall(name, purgeMetrics = false) {
      await api.delete(`/api/admin/packages/${encodeURIComponent(name)}`, {
        params: { purgeMetrics: !!purgeMetrics },
      });
      await this.fetchInstalled();
    },

    async upgrade(name, version) {
      const r = await api.post(`/api/admin/packages/${encodeURIComponent(name)}/upgrade`, {
        version: version || undefined,
      });
      await this.fetchInstalled();
      return r.data;
    },

    async updateParams(name, params) {
      await api.put(`/api/admin/packages/${encodeURIComponent(name)}/params`, { params });
      await this.fetchInstalled();
    },

    // Operator interval override (round-19 follow-up, T4). Body shape:
    //   intervalSec: <integer 5..86400> | null   (null = clear, fall back to manifest)
    // The backend route (PUT /api/admin/packages/:name/interval) owns the
    // 5..86400 validation; we just forward the value as-is and refetch so
    // the table re-renders with the persisted override.
    async setIntervalOverride(name, intervalSec) {
      await api.put(`/api/admin/packages/${encodeURIComponent(name)}/interval`, {
        intervalSec: intervalSec == null ? null : Number(intervalSec)
      });
      await this.fetchInstalled();
    },

    async refreshRegistry() {
      const r = await api.get('/api/admin/packages/registry/refresh');
      this.registryCache.fetchedAt = new Date().toISOString();
      this.registryCache.packagesCount = r.data?.data?.packages;
      return r.data;
    },

    async fetchRegistryIndex() {
      // RegistryView uses this directly; we don't cache in state because
      // the user expects to see a fresh list whenever they navigate in.
      const r = await api.get('/api/admin/packages/registry/list');
      this.registryCache.url = r.data?.url;
      this.registryCache.fetchedAt = new Date().toISOString();
      return r.data;
    },
  },
});
