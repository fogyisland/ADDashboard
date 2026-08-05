import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../src/stores/packages.js', () => ({
  usePackagesStore: vi.fn()
}));

import PackagesView from '../src/views/admin/PackagesView.vue';
import { usePackagesStore } from '../src/stores/packages.js';

function makeInstalled() {
  return [
    { name: 'cpu-monitor', version: '1.0.0', type: 'gauge', enabled: 1, source: 'registry', installed_at: '2026-08-01T00:00:00Z' },
    { name: 'mem-monitor', version: '1.2.0', type: 'gauge', enabled: 0, source: 'local', installed_at: '2026-08-02T00:00:00Z' }
  ];
}

function makeStore(overrides = {}) {
  const fetchInstalled = vi.fn().mockResolvedValue(undefined);
  const install = vi.fn().mockResolvedValue({ ok: true });
  const enable = vi.fn().mockResolvedValue(undefined);
  const disable = vi.fn().mockResolvedValue(undefined);
  const uninstall = vi.fn().mockResolvedValue(undefined);
  const upgrade = vi.fn().mockResolvedValue({ ok: true });
  const refreshRegistry = vi.fn().mockResolvedValue({ ok: true });
  const updateParams = vi.fn().mockResolvedValue(undefined);
  const fetchRegistryIndex = vi.fn().mockResolvedValue({ url: '', packages: [] });
  const store = {
    installed: makeInstalled(),
    loading: false,
    error: null,
    registryCache: { url: null, fetchedAt: null },
    fetchInstalled,
    install,
    enable,
    disable,
    uninstall,
    upgrade,
    refreshRegistry,
    updateParams,
    fetchRegistryIndex,
    ...overrides
  };
  usePackagesStore.mockReturnValue(store);
  return store;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

test('PackagesView renders rows from store.installed', async () => {
  const store = makeStore();
  const wrapper = mount(PackagesView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  expect(store.fetchInstalled).toHaveBeenCalled();
  const text = wrapper.text();
  expect(text).toContain('cpu-monitor');
  expect(text).toContain('1.0.0');
  expect(text).toContain('gauge');
  expect(text).toContain('mem-monitor');
  expect(wrapper.text()).toContain('是'); // enabled tag for cpu-monitor
  expect(wrapper.text()).toContain('否'); // disabled tag for mem-monitor
});

test('PackagesView install flow: clicking toggle calls store.enable on disabled row', async () => {
  const store = makeStore();
  const wrapper = mount(PackagesView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  // mem-monitor is disabled (enabled=0) — toggle button should call store.enable
  const buttons = wrapper.findAll('button');
  const toggleBtn = buttons.find((b) => b.text() === '启用');
  expect(toggleBtn).toBeTruthy();
  await toggleBtn.trigger('click');
  await flushPromises();
  expect(store.enable).toHaveBeenCalledWith('mem-monitor');
  expect(store.disable).not.toHaveBeenCalled();
});

test('PackagesView disable flow: clicking 停用 calls store.disable on enabled row', async () => {
  const store = makeStore();
  const wrapper = mount(PackagesView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  // cpu-monitor is enabled (enabled=1) — toggle button should call store.disable
  const buttons = wrapper.findAll('button');
  const disableBtn = buttons.find((b) => b.text() === '停用');
  expect(disableBtn).toBeTruthy();
  await disableBtn.trigger('click');
  await flushPromises();
  expect(store.disable).toHaveBeenCalledWith('cpu-monitor');
});

test('PackagesView uninstall flow: confirm + click calls store.uninstall', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const store = makeStore();
  const wrapper = mount(PackagesView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  const buttons = wrapper.findAll('button');
  const uninstallBtn = buttons.find((b) => b.text() === '卸载');
  expect(uninstallBtn).toBeTruthy();
  await uninstallBtn.trigger('click');
  await flushPromises();
  expect(confirmSpy).toHaveBeenCalled();
  expect(store.uninstall).toHaveBeenCalledWith('cpu-monitor', false);
  confirmSpy.mockRestore();
});

test('PackagesView uninstall: cancel on confirm does NOT call store.uninstall', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const store = makeStore();
  const wrapper = mount(PackagesView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  const buttons = wrapper.findAll('button');
  const uninstallBtn = buttons.find((b) => b.text() === '卸载');
  await uninstallBtn.trigger('click');
  await flushPromises();
  expect(store.uninstall).not.toHaveBeenCalled();
  confirmSpy.mockRestore();
});

test('PackagesView upgrade flow: clicking 升级 calls store.upgrade', async () => {
  const store = makeStore();
  const wrapper = mount(PackagesView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  const buttons = wrapper.findAll('button');
  const upgradeBtn = buttons.find((b) => b.text() === '升级');
  expect(upgradeBtn).toBeTruthy();
  await upgradeBtn.trigger('click');
  await flushPromises();
  expect(store.upgrade).toHaveBeenCalledWith('cpu-monitor');
});

test('PackagesView refreshRegistry button calls store.refreshRegistry', async () => {
  const store = makeStore();
  const wrapper = mount(PackagesView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  const buttons = wrapper.findAll('button');
  const refreshBtn = buttons.find((b) => b.text() === '刷新 Registry');
  expect(refreshBtn).toBeTruthy();
  await refreshBtn.trigger('click');
  await flushPromises();
  expect(store.refreshRegistry).toHaveBeenCalled();
});

test('PackagesView upload triggers store.install with source=local and base64 buffer', async () => {
  const store = makeStore();
  const wrapper = mount(PackagesView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();

  const fileInput = wrapper.find('input[type=file]');
  expect(fileInput.exists()).toBe(true);

  // Build a fake file and dispatch a change event manually. jsdom refuses
  // to accept a File via setValue on a filename input — we sidestep that
  // by synthesizing the event with a custom target.files list.
  const fileContent = 'FAKE_ZIP_BYTES';
  const file = new File([fileContent], 'cpu-monitor-1.0.0.zip', { type: 'application/zip' });

  // Stub FileReader so handleUpload's readAsDataURL completes synchronously.
  const origFileReader = globalThis.FileReader;
  globalThis.FileReader = class {
    readAsDataURL() {
      Promise.resolve().then(() => {
        this.result = `data:application/zip;base64,${btoa(fileContent)}`;
        this.onload && this.onload();
      });
    }
  };
  try {
    const ev = new Event('change', { bubbles: true });
    Object.defineProperty(ev, 'target', {
      value: { files: [file], value: '' },
      writable: false
    });
    fileInput.element.dispatchEvent(ev);
    await flushPromises();
    await flushPromises();
  } finally {
    globalThis.FileReader = origFileReader;
  }
  expect(store.install).toHaveBeenCalledTimes(1);
  const [call] = store.install.mock.calls[0];
  expect(call.source).toBe('local');
  expect(call.packageRef).toBe('cpu-monitor-1.0.0.zip');
  expect(call.buffer).toBeTruthy();
});
