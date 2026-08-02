import { test, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('axios', () => {
  return {
    default: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn()
    }
  };
});

import axios from 'axios';
import { usePackagesStore } from '../src/stores/packages.js';

function makeInstalled() {
  return [
    { name: 'cpu-monitor', version: '1.0.0', type: 'gauge', enabled: 1, source: 'registry', installed_at: '2026-08-01T00:00:00Z' },
    { name: 'mem-monitor', version: '1.2.0', type: 'gauge', enabled: 0, source: 'local', installed_at: '2026-08-02T00:00:00Z' }
  ];
}

beforeEach(() => {
  setActivePinia(createPinia());
  axios.get.mockReset();
  axios.post.mockReset();
  axios.put.mockReset();
  axios.delete.mockReset();
});

test('fetchInstalled populates state.installed', async () => {
  axios.get.mockResolvedValueOnce({ data: { packages: makeInstalled() } });
  const store = usePackagesStore();
  await store.fetchInstalled();
  expect(store.installed).toHaveLength(2);
  expect(store.installed[0].name).toBe('cpu-monitor');
  expect(store.loading).toBe(false);
});

test('fetchInstalled sets loading during request', async () => {
  let resolveFn;
  axios.get.mockReturnValueOnce(new Promise((r) => { resolveFn = () => r({ data: { packages: [] } }); }));
  const store = usePackagesStore();
  const p = store.fetchInstalled();
  expect(store.loading).toBe(true);
  resolveFn();
  await p;
  expect(store.loading).toBe(false);
});

test('install posts to /api/admin/packages/install and refetches', async () => {
  axios.post.mockResolvedValueOnce({ data: { ok: true } });
  axios.get.mockResolvedValueOnce({ data: { packages: makeInstalled() } });
  const store = usePackagesStore();
  await store.install({ source: 'local', packageRef: 'foo.zip', buffer: 'BASE64' });
  expect(axios.post).toHaveBeenCalledWith('/api/admin/packages/install', {
    source: 'local', packageRef: 'foo.zip', buffer: 'BASE64'
  });
  expect(axios.get).toHaveBeenCalledWith('/api/admin/packages');
  expect(store.installed).toHaveLength(2);
});

test('enable posts to /api/admin/packages/:name/enable and refetches', async () => {
  axios.post.mockResolvedValueOnce({ data: { ok: true } });
  axios.get.mockResolvedValueOnce({ data: { packages: [] } });
  const store = usePackagesStore();
  await store.enable('cpu-monitor');
  expect(axios.post).toHaveBeenCalledWith('/api/admin/packages/cpu-monitor/enable');
});

test('disable posts to /api/admin/packages/:name/disable and refetches', async () => {
  axios.post.mockResolvedValueOnce({ data: { ok: true } });
  axios.get.mockResolvedValueOnce({ data: { packages: [] } });
  const store = usePackagesStore();
  await store.disable('cpu-monitor');
  expect(axios.post).toHaveBeenCalledWith('/api/admin/packages/cpu-monitor/disable');
});

test('uninstall deletes /api/admin/packages/:name with purgeMetrics flag', async () => {
  axios.delete.mockResolvedValueOnce({ data: { ok: true } });
  axios.get.mockResolvedValueOnce({ data: { packages: [] } });
  const store = usePackagesStore();
  await store.uninstall('cpu-monitor', true);
  expect(axios.delete).toHaveBeenCalledWith('/api/admin/packages/cpu-monitor', { params: { purgeMetrics: true } });
});

test('uninstall defaults purgeMetrics to false', async () => {
  axios.delete.mockResolvedValueOnce({ data: { ok: true } });
  axios.get.mockResolvedValueOnce({ data: { packages: [] } });
  const store = usePackagesStore();
  await store.uninstall('cpu-monitor');
  expect(axios.delete).toHaveBeenCalledWith('/api/admin/packages/cpu-monitor', { params: { purgeMetrics: false } });
});

test('upgrade posts to /api/admin/packages/:name/upgrade', async () => {
  axios.post.mockResolvedValueOnce({ data: { ok: true, data: {} } });
  axios.get.mockResolvedValueOnce({ data: { packages: [] } });
  const store = usePackagesStore();
  await store.upgrade('cpu-monitor', '1.2.0');
  expect(axios.post).toHaveBeenCalledWith('/api/admin/packages/cpu-monitor/upgrade', { version: '1.2.0' });
});

test('updateParams puts to /api/admin/packages/:name/params and refetches', async () => {
  axios.put.mockResolvedValueOnce({ data: { ok: true } });
  axios.get.mockResolvedValueOnce({ data: { packages: [] } });
  const store = usePackagesStore();
  await store.updateParams('cpu-monitor', { threshold: 80 });
  expect(axios.put).toHaveBeenCalledWith('/api/admin/packages/cpu-monitor/params', { params: { threshold: 80 } });
});

test('fetchRegistryIndex returns data from /api/admin/packages/registry/list', async () => {
  axios.get.mockResolvedValueOnce({
    data: { url: 'http://x', packages: [{ name: 'cpu' }], updatedAt: '2026-08-02T00:00:00Z' }
  });
  const store = usePackagesStore();
  const r = await store.fetchRegistryIndex();
  expect(r.url).toBe('http://x');
  expect(r.packages).toHaveLength(1);
});

test('refreshRegistry hits /api/admin/packages/registry/refresh', async () => {
  axios.get.mockResolvedValueOnce({ data: { ok: true, data: { updatedAt: 'x', packages: 5 } } });
  const store = usePackagesStore();
  await store.refreshRegistry();
  expect(axios.get).toHaveBeenCalledWith('/api/admin/packages/registry/refresh');
  expect(store.registryCache.fetchedAt).toBeTruthy();
});
