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

vi.mock('vue-router', () => ({
  useRoute: vi.fn(() => ({ params: { name: 'cpu-monitor' } })),
  useRouter: vi.fn(() => ({ push: vi.fn() })),
  createRouter: vi.fn(),
  createWebHistory: vi.fn()
}));

vi.mock('../src/stores/packages.js', () => ({
  usePackagesStore: vi.fn()
}));

import axios from 'axios';
import PackageEditView from '../src/views/admin/PackageEditView.vue';
import { usePackagesStore } from '../src/stores/packages.js';

const PKG = {
  name: 'cpu-monitor',
  version: '1.0.0',
  type: 'gauge',
  enabled: 1,
  source: 'registry',
  installed_at: '2026-08-01T00:00:00Z',
  manifest: {
    name: 'cpu-monitor',
    version: '1.0.0',
    type: 'gauge',
    description: 'CPU usage gauge',
    author: 'me',
    license: 'MIT',
    params: { schema: { type: 'object', properties: { threshold: { type: 'number' } } } }
  },
  params: { threshold: 80 }
};

const RUNS = [
  { id: 1, started_at: '2026-08-01T12:00:00Z', exit_code: 0, error: null },
  { id: 2, started_at: '2026-08-01T12:05:00Z', exit_code: 0, error: null }
];

function makeStore(overrides = {}) {
  const updateParams = vi.fn().mockResolvedValue(undefined);
  const store = {
    installed: [PKG],
    updateParams,
    fetchInstalled: vi.fn(),
    install: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    uninstall: vi.fn(),
    upgrade: vi.fn(),
    refreshRegistry: vi.fn(),
    fetchRegistryIndex: vi.fn(),
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

test('PackageEditView fetches /api/admin/packages/:name and renders metadata + manifest + runs', async () => {
  axios.get.mockResolvedValueOnce({ data: { package: PKG, recentRuns: RUNS } });
  makeStore();
  const wrapper = mount(PackageEditView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  expect(axios.get).toHaveBeenCalledWith('/api/admin/packages/cpu-monitor');
  const text = wrapper.text();
  expect(text).toContain('cpu-monitor');
  expect(text).toContain('1.0.0');
  expect(text).toContain('gauge');
  expect(text).toContain('CPU usage gauge');
  expect(text).toContain('me');
  expect(text).toContain('MIT');
  // Manifest JSON viewer should contain the schema description
  expect(text).toContain('"description": "CPU usage gauge"');
  // Recent runs table — dates are formatted by formatDate (zh-CN locale,
  // TZ-dependent). Check that the year/month/day is rendered.
  expect(text).toMatch(/2026[\-\/]8[\-\/]1/);
});

test('PackageEditView shows error state when fetch fails', async () => {
  axios.get.mockRejectedValueOnce(new Error('boom'));
  makeStore();
  const wrapper = mount(PackageEditView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  expect(wrapper.text()).toContain('boom');
});

test('PackageEditView 保存 params triggers store.updateParams with parsed JSON', async () => {
  axios.get.mockResolvedValueOnce({ data: { package: PKG, recentRuns: RUNS } });
  const store = makeStore();
  const wrapper = mount(PackageEditView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();

  // Edit the params JSON in the textarea — set a new threshold value.
  const ta = wrapper.find('textarea');
  expect(ta.exists()).toBe(true);
  await ta.setValue('{"threshold": 90}');
  await flushPromises();

  // Find and click the save button.
  const buttons = wrapper.findAll('button');
  const saveBtn = buttons.find((b) => b.text() === '保存参数' || b.text() === '保存');
  expect(saveBtn).toBeTruthy();
  await saveBtn.trigger('click');
  await flushPromises();

  expect(store.updateParams).toHaveBeenCalledTimes(1);
  expect(store.updateParams).toHaveBeenCalledWith('cpu-monitor', { threshold: 90 });
});

test('PackageEditView 保存 with invalid JSON does not call store.updateParams', async () => {
  axios.get.mockResolvedValueOnce({ data: { package: PKG, recentRuns: RUNS } });
  const store = makeStore();
  const wrapper = mount(PackageEditView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();

  const ta = wrapper.find('textarea');
  await ta.setValue('{not valid json');
  await flushPromises();

  const buttons = wrapper.findAll('button');
  const saveBtn = buttons.find((b) => b.text() === '保存参数' || b.text() === '保存');
  await saveBtn.trigger('click');
  await flushPromises();

  expect(store.updateParams).not.toHaveBeenCalled();
});
