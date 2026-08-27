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

// =============================================================================
//  2026-08-27 round-38 — group-by-site effect
//
//  Operator directive "AD 域控清单 当对象归类后 做成组效果，不然成员多看不清".
//  DCs are grouped by siteId, with siteId=null bucketed under "未分配" trailing
//  the assigned groups. Each group renders as its own .dc-group section with
//  a header showing the site name + DC count. Within a group DCs are sorted
//  bridgehead → any-FSMO → lex-by-dc-name so the operator's eye lands on the
//  load-bearing DC first.
// =============================================================================

const multiSiteDcs = () => [
  // Beijing-Site: 3 DCs, one bridgehead, one PDC, one plain GC
  { dcName: 'DC-BJ-03', siteId: 1, siteName: 'Beijing-Site', siteHint: 'Beijing-Site',
    osVersion: 'Win2022',
    isPdc: false, isGc: true, isRidMaster: false, isSchemaMaster: false,
    isDomainNamingMaster: false, isInfrastructureMaster: false,
    isBridgehead: false,
    discoveredAt: '2026-07-12T00:00:00Z' },
  { dcName: 'DC-BJ-01', siteId: 1, siteName: 'Beijing-Site', siteHint: 'Beijing-Site',
    osVersion: 'Win2022',
    isPdc: false, isGc: true, isRidMaster: false, isSchemaMaster: false,
    isDomainNamingMaster: false, isInfrastructureMaster: false,
    isBridgehead: true,
    discoveredAt: '2026-07-12T00:00:00Z' },
  { dcName: 'DC-BJ-02', siteId: 1, siteName: 'Beijing-Site', siteHint: 'Beijing-Site',
    osVersion: 'Win2019',
    isPdc: true, isGc: true, isRidMaster: false, isSchemaMaster: false,
    isDomainNamingMaster: false, isInfrastructureMaster: false,
    isBridgehead: false,
    discoveredAt: '2026-07-12T00:00:00Z' },
  // Shanghai-Site: 1 plain DC
  { dcName: 'DC-SH-01', siteId: 2, siteName: 'Shanghai-Site', siteHint: 'Shanghai-Site',
    osVersion: 'Win2019',
    isPdc: false, isGc: false, isRidMaster: false, isSchemaMaster: false,
    isDomainNamingMaster: false, isInfrastructureMaster: false,
    isBridgehead: false,
    discoveredAt: '2026-07-12T00:00:00Z' },
  // Unassigned (siteId=null)
  { dcName: 'DC-ORPHAN-01', siteId: null, siteName: null, siteHint: 'some-orphan',
    osVersion: 'Win2016',
    isPdc: false, isGc: false, isRidMaster: false, isSchemaMaster: false,
    isDomainNamingMaster: false, isInfrastructureMaster: false,
    isBridgehead: false,
    discoveredAt: null }
];

test('DcsCatalogView groups DCs by site — one card per assigned site plus a trailing 未分配 card', async () => {
  adminApi.listSitesCatalog.mockResolvedValue({ data: [
    { id: 1, siteName: 'Beijing-Site', regionCode: 'BJ', isHub: true },
    { id: 2, siteName: 'Shanghai-Site', regionCode: 'SH', isHub: false }
  ] });
  adminApi.listDcsCatalog.mockResolvedValue({ data: multiSiteDcs() });
  const wrapper = mount(DcsCatalogView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();

  // 3 groups expected: Beijing-Site, Shanghai-Site, 未分配
  const groups = wrapper.findAll('section.dc-group');
  expect(groups).toHaveLength(3);
  // Order: assigned sites first (in sites.value order — hub-first), unassigned last
  expect(groups[0].attributes('data-test-group')).toBe('site:1');
  expect(groups[1].attributes('data-test-group')).toBe('site:2');
  expect(groups[2].attributes('data-test-group')).toBe('__unassigned__');

  // Each group header carries the site name + DC count
  expect(groups[0].text()).toContain('Beijing-Site');
  expect(groups[0].text()).toContain('3 DC');
  expect(groups[1].text()).toContain('Shanghai-Site');
  expect(groups[1].text()).toContain('1 DC');
  expect(groups[2].text()).toContain('未分配');
  expect(groups[2].text()).toContain('1 DC');

  // Bridgehead / FSMO summary chips live on .dc-group-bridgehead /
  // .dc-group-fsmo (not just plain text — the column header "<th>桥头</th>"
  // would otherwise contaminate text() matches).
  expect(groups[0].find('.dc-group-bridgehead').exists()).toBe(true);
  expect(groups[0].find('.dc-group-bridgehead').text()).toBe('桥头 1');
  expect(groups[0].find('.dc-group-fsmo').exists()).toBe(true);
  // Beijing has 3 DCs, all 3 with at least one FSMO flag (BJ-01=GC+bridgehead, BJ-02=PDC+GC, BJ-03=GC)
  expect(groups[0].find('.dc-group-fsmo').text()).toBe('FSMO 3');
  // Shanghai has 0 bridgeheads / 0 FSMO → no chips
  expect(groups[1].find('.dc-group-bridgehead').exists()).toBe(false);
  expect(groups[1].find('.dc-group-fsmo').exists()).toBe(false);
  // Orphan is unassigned, no flags → no chips
  expect(groups[2].find('.dc-group-bridgehead').exists()).toBe(false);
  expect(groups[2].find('.dc-group-fsmo').exists()).toBe(false);
});

test('DcsCatalogView within-group sort: bridgehead → FSMO → lex', async () => {
  adminApi.listSitesCatalog.mockResolvedValue({ data: [
    { id: 1, siteName: 'Beijing-Site' }
  ] });
  adminApi.listDcsCatalog.mockResolvedValue({ data: multiSiteDcs() });
  const wrapper = mount(DcsCatalogView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();

  // Beijing group has 3 DCs. Read data-test-row order within that group only.
  const beijingGroup = wrapper.find('section.dc-group[data-test-group="site:1"]');
  const rows = beijingGroup.findAll('tr[data-test-row]');
  expect(rows).toHaveLength(3);
  // Expected sort: DC-BJ-01 (bridgehead) > DC-BJ-02 (any-FSMO, PDC) > DC-BJ-03 (GC only — also FSMO but lower in lex)
  // Wait — both DC-BJ-02 and DC-BJ-03 have FSMO flags. Within FSMO rank we lex-sort, so:
  // DC-BJ-01 (bridgehead, first by isBridgehead rule) > DC-BJ-02 (FSMO+lex) > DC-BJ-03 (FSMO+lex)
  expect(rows[0].attributes('data-test-row')).toBe('DC-BJ-01');
  expect(rows[1].attributes('data-test-row')).toBe('DC-BJ-02');
  expect(rows[2].attributes('data-test-row')).toBe('DC-BJ-03');
});

test('DcsCatalogView unassigned group still renders role pills + bridgehead toggle', async () => {
  adminApi.listSitesCatalog.mockResolvedValue({ data: [
    { id: 1, siteName: 'Beijing-Site' }
  ] });
  adminApi.listDcsCatalog.mockResolvedValue({ data: multiSiteDcs() });
  const wrapper = mount(DcsCatalogView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();

  const orphanGroup = wrapper.find('section.dc-group[data-test-group="__unassigned__"]');
  expect(orphanGroup.exists()).toBe(true);
  // DC-ORPHAN-01 row is rendered inside the unassigned group
  const orphanRow = orphanGroup.find('[data-test-row="DC-ORPHAN-01"]');
  expect(orphanRow.exists()).toBe(true);
  // Its 6 role pills + 1 bridgehead toggle still work
  expect(orphanGroup.find('[data-test="role-isPdc-DC-ORPHAN-01"]').exists()).toBe(true);
  expect(orphanGroup.find('[data-test="bridgehead-DC-ORPHAN-01"]').exists()).toBe(true);
});

test('DcsCatalogView empty catalog shows placeholder, no group sections', async () => {
  // listDcsCatalog returns [] → no .dc-group sections, the placeholder is shown instead
  adminApi.listSitesCatalog.mockResolvedValue({ data: [] });
  adminApi.listDcsCatalog.mockResolvedValue({ data: [] });
  const wrapper = mount(DcsCatalogView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  expect(wrapper.find('.empty').exists()).toBe(true);
  expect(wrapper.findAll('section.dc-group')).toHaveLength(0);
});