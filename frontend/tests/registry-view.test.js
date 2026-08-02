import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

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

vi.mock('../src/stores/packages.js', () => ({
  usePackagesStore: vi.fn()
}));

import axios from 'axios';
import RegistryView from '../src/views/admin/RegistryView.vue';
import { usePackagesStore } from '../src/stores/packages.js';

const REG = {
  url: 'http://127.0.0.1:9999',
  updatedAt: '2026-08-02T00:00:00Z',
  packages: [
    { name: 'cpu-monitor', latestVersion: '1.0.0', type: 'gauge', description: 'CPU gauge', author: 'me' },
    { name: 'mem-monitor', latestVersion: '1.2.0', type: 'gauge', description: 'Mem gauge', author: 'me' }
  ]
};

function makeStore(overrides = {}) {
  const install = vi.fn().mockResolvedValue({ ok: true });
  const refreshRegistry = vi.fn().mockResolvedValue({ ok: true });
  const fetchRegistryIndex = vi.fn().mockResolvedValue(REG);
  const store = {
    installed: [],
    loading: false,
    error: null,
    registryCache: { url: null, fetchedAt: null },
    install,
    refreshRegistry,
    fetchRegistryIndex,
    updateParams: vi.fn(),
    fetchInstalled: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    uninstall: vi.fn(),
    upgrade: vi.fn(),
    ...overrides
  };
  usePackagesStore.mockReturnValue(store);
  return store;
}

beforeEach(() => {
  setActivePinia(createPinia());
  axios.get.mockReset();
  axios.post.mockReset();
  axios.put.mockReset();
  axios.delete.mockReset();
  vi.clearAllMocks();
});

test('RegistryView renders registry packages table on mount', async () => {
  const store = makeStore();
  const wrapper = mount(RegistryView, {
    global: { stubs: { AppLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  expect(store.fetchRegistryIndex).toHaveBeenCalled();
  const text = wrapper.text();
  expect(text).toContain('cpu-monitor');
  expect(text).toContain('1.0.0');
  expect(text).toContain('mem-monitor');
  expect(text).toContain('CPU gauge');
  expect(text).toContain('Mem gauge');
});

test('RegistryView displays registry URL when configured', async () => {
  makeStore();
  const wrapper = mount(RegistryView, {
    global: { stubs: { AppLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  expect(wrapper.text()).toContain('http://127.0.0.1:9999');
});

test('RegistryView install: clicking 安装 calls store.install with source=registry:URL packageRef=name', async () => {
  const store = makeStore();
  const wrapper = mount(RegistryView, {
    global: { stubs: { AppLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();

  const buttons = wrapper.findAll('button');
  // First 安装 button — for cpu-monitor
  const installBtns = buttons.filter((b) => b.text() === '安装');
  expect(installBtns.length).toBeGreaterThanOrEqual(2);
  await installBtns[0].trigger('click');
  await flushPromises();

  expect(store.install).toHaveBeenCalledTimes(1);
  const [call] = store.install.mock.calls[0];
  expect(call.source).toBe('registry:http://127.0.0.1:9999');
  expect(call.packageRef).toBe('cpu-monitor');
  expect(call.buffer).toBeUndefined();
});

test('RegistryView refresh button calls store.refreshRegistry then refetches', async () => {
  const store = makeStore();
  const wrapper = mount(RegistryView, {
    global: { stubs: { AppLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  // Initial fetchRegistryIndex called once on mount
  expect(store.fetchRegistryIndex).toHaveBeenCalledTimes(1);

  const buttons = wrapper.findAll('button');
  const refreshBtn = buttons.find((b) => b.text() === '刷新');
  expect(refreshBtn).toBeTruthy();
  await refreshBtn.trigger('click');
  await flushPromises();
  expect(store.refreshRegistry).toHaveBeenCalledTimes(1);
  expect(store.fetchRegistryIndex).toHaveBeenCalledTimes(2);
});

test('RegistryView shows error message when fetch fails', async () => {
  const store = makeStore();
  store.fetchRegistryIndex.mockRejectedValueOnce(new Error('registry down'));
  const wrapper = mount(RegistryView, {
    global: { stubs: { AppLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  expect(wrapper.text()).toContain('registry down');
});

test('RegistryView empty state when registry has no packages', async () => {
  const store = makeStore();
  store.fetchRegistryIndex.mockResolvedValueOnce({
    url: 'http://x', packages: [], updatedAt: '2026-08-02T00:00:00Z'
  });
  const wrapper = mount(RegistryView, {
    global: { stubs: { AppLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  expect(wrapper.text()).toContain('空');
});
