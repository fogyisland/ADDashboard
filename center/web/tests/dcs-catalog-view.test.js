import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../src/api/admin.js', () => ({
  adminApi: {
    listSitesCatalog: vi.fn(() => Promise.resolve({ data: [] })),
    listDcsCatalog: vi.fn(() => Promise.resolve({ data: [] })),
    assignDcSite: vi.fn(() => Promise.resolve({ data: { ok: true } })),
    bulkAssignDcs: vi.fn(() => Promise.resolve({ data: { assigned: 0, unassigned: 0, skipped: 0, errors: [] } })),
    // 2026-08-27 round-29: the DcsCatalogView now also exposes an
    // updateDcFlags method for toggling FSMO roles + bridgehead. Tests
    // reset it explicitly so click-driven tests have a clean call log.
    updateDcFlags: vi.fn(() => Promise.resolve({ data: { ok: true, updated: [] } }))
  }
}));

import DcsCatalogView from '../src/views/admin/DcsCatalogView.vue';
import { adminApi } from '../src/api/admin.js';

beforeEach(() => {
  adminApi.listSitesCatalog.mockReset();
  adminApi.listDcsCatalog.mockReset();
  adminApi.assignDcSite.mockReset();
  adminApi.bulkAssignDcs.mockReset();
  adminApi.updateDcFlags.mockReset();
  // default: resolve listDcsCatalog with empty array; individual tests
  // override via mockResolvedValueOnce / mockResolvedValue.
  adminApi.listSitesCatalog.mockResolvedValue({ data: [] });
  adminApi.listDcsCatalog.mockResolvedValue({ data: [] });
  adminApi.updateDcFlags.mockResolvedValue({ data: { ok: true, updated: [] } });
});

const sampleDcs = () => [
  { dcName: 'DC-BJ-01', siteId: 1, siteName: 'Beijing-Site', siteHint: 'Beijing-Site',
    osVersion: 'Win2022',
    isPdc: false, isGc: true, isRidMaster: false, isSchemaMaster: false,
    isDomainNamingMaster: false, isInfrastructureMaster: false,
    isBridgehead: true,
    discoveredAt: '2026-07-12T00:00:00Z' },
  { dcName: 'DC-SH-01', siteId: null, siteName: null, siteHint: 'Shanghai-Site',
    osVersion: 'Win2019',
    isPdc: false, isGc: true, isRidMaster: false, isSchemaMaster: false,
    isDomainNamingMaster: false, isInfrastructureMaster: false,
    isBridgehead: false,
    discoveredAt: null }
];

test('DcsCatalogView renders DC rows with site name and role toggle pills', async () => {
  adminApi.listSitesCatalog.mockResolvedValue({ data: [{ id: 1, siteName: 'Beijing-Site' }] });
  adminApi.listDcsCatalog.mockResolvedValue({ data: sampleDcs() });
  const wrapper = mount(DcsCatalogView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  const text = wrapper.text();
  expect(text).toContain('DC-BJ-01');
  expect(text).toContain('Beijing-Site');
  expect(text).toContain('DC-SH-01');
  expect(text).toContain('未分配');
  // round-29: 5 FSMO role toggles per row + a bridgehead toggle in its own column.
  const pdcButtons = wrapper.findAll('[data-test="role-isPdc-DC-BJ-01"]');
  expect(pdcButtons).toHaveLength(1);
  expect(pdcButtons[0].text()).toBe('PDC');
  // DC-BJ-01 has isBridgehead=true → bridgehead toggle should render the on label
  const bridgeheadBtn = wrapper.find('[data-test="bridgehead-DC-BJ-01"]');
  expect(bridgeheadBtn.exists()).toBe(true);
  expect(bridgeheadBtn.classes()).toContain('on');
  expect(bridgeheadBtn.text()).toBe('桥头');
  // GC is true on DC-BJ-01 → that pill should be on
  const gcBtn = wrapper.find('[data-test="role-isGc-DC-BJ-01"]');
  expect(gcBtn.classes()).toContain('on');
});

test('DcsCatalogView: clicking 批量分配站点 opens BulkImportDialog', async () => {
  const wrapper = mount(DcsCatalogView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  expect(wrapper.findAllComponents({ name: 'BulkImportDialog' }).length).toBe(0);
  const buttons = wrapper.findAll('button');
  const bulkBtn = buttons.find(b => b.text() === '批量分配站点');
  expect(bulkBtn).toBeTruthy();
  await bulkBtn.trigger('click');
  await flushPromises();
  expect(wrapper.findAllComponents({ name: 'BulkImportDialog' }).length).toBe(1);
});

// 2026-08-27 round-29: clicking a role toggle calls updateDcFlags with the
// camelCase flag key and the opposite boolean. After the await chain the
// view reloads so the bridgehead sort order can refresh (e.g. when an
// operator unmarks the current bridgehead).
test('DcsCatalogView: clicking a role toggle calls updateDcFlags with the right key', async () => {
  adminApi.listDcsCatalog
    .mockResolvedValueOnce({ data: sampleDcs() })      // initial load
    .mockResolvedValueOnce({ data: sampleDcs() });     // reload after toggle
  const wrapper = mount(DcsCatalogView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  // DC-BJ-01 has isPdc=false → clicking PDC should send isPdc: true
  const pdcBtn = wrapper.find('[data-test="role-isPdc-DC-BJ-01"]');
  expect(pdcBtn.exists()).toBe(true);
  await pdcBtn.trigger('click');
  await flushPromises();
  expect(adminApi.updateDcFlags).toHaveBeenCalledWith('DC-BJ-01', { isPdc: true });
});

test('DcsCatalogView: clicking bridgehead toggle flips isBridgehead and reloads', async () => {
  adminApi.listDcsCatalog
    .mockResolvedValueOnce({ data: sampleDcs() })      // initial load
    .mockResolvedValueOnce({ data: sampleDcs() });     // reload after toggle
  const wrapper = mount(DcsCatalogView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  // DC-SH-01 has isBridgehead=false → clicking should set it to true
  const bridgeheadBtn = wrapper.find('[data-test="bridgehead-DC-SH-01"]');
  expect(bridgeheadBtn.exists()).toBe(true);
  expect(bridgeheadBtn.classes()).not.toContain('on');
  await bridgeheadBtn.trigger('click');
  await flushPromises();
  expect(adminApi.updateDcFlags).toHaveBeenCalledWith('DC-SH-01', { isBridgehead: true });
  // reload was triggered after the toggle (listDcsCatalog called twice total)
  expect(adminApi.listDcsCatalog).toHaveBeenCalledTimes(2);
});

test('DcsCatalogView: failed updateDcFlags reverts optimistic state and shows error banner', async () => {
  adminApi.listDcsCatalog.mockResolvedValue({ data: sampleDcs() });
  adminApi.updateDcFlags.mockRejectedValueOnce({ response: { data: { error: 'dc not found' } } });
  const wrapper = mount(DcsCatalogView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  const bridgeheadBtn = wrapper.find('[data-test="bridgehead-DC-SH-01"]');
  await bridgeheadBtn.trigger('click');
  await flushPromises();
  // Error banner surfaces the server's verbatim message
  const banner = wrapper.find('.error-banner');
  expect(banner.exists()).toBe(true);
  expect(banner.text()).toContain('dc not found');
});