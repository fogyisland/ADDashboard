import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

const RouterLinkStub = {
  props: ['to'],
  template: '<a :href="to"><slot /></a>'
};

vi.mock('../src/api/admin.js', () => ({
  adminApi: {
    getReplicationPortStatus: vi.fn(() => Promise.resolve({ data: { ports: [], rows: [] } }))
  }
}));

import ReplicationPortStatusView from '../src/views/admin/ReplicationPortStatusView.vue';
import { adminApi } from '../src/api/admin.js';

function mountView() {
  return mount(ReplicationPortStatusView, {
    global: {
      stubs: {
        AdminLayout: { template: '<div><slot /></div>' },
        'router-link': RouterLinkStub
      }
    }
  });
}

beforeEach(() => {
  adminApi.getReplicationPortStatus.mockReset();
  // Stub setInterval/clearInterval so onMounted's polling timer doesn't keep
  // the test alive after the body returns — vitest's default 5s test timeout
  // would otherwise be eaten by the pending interval handle.
  vi.stubGlobal('setInterval', () => 0);
  vi.stubGlobal('clearInterval', () => {});
});

const sampleRows = [
  {
    sourceDc: 'DC1', sourceSite: 'SiteA',
    destDc: 'DC2', destSite: 'SiteB',
    perPort: {
      '135':  { reachable: true,  latencyMs: 5 },
      '445':  { reachable: false, latencyMs: null, error: 'timeout' }
    },
    lastAttemptTime: '2026-08-27T10:00:00.000Z',
    collectedAt: '2026-08-27T10:00:00.000Z'
  },
  {
    sourceDc: 'DC1', sourceSite: 'SiteA',
    destDc: 'DC3', destSite: 'SiteA', // cross-site is also SiteA->SiteA here
    perPort: {
      '135': { reachable: true, latencyMs: 8 },
      '445': { reachable: true, latencyMs: 6 }
    },
    lastAttemptTime: '2026-08-27T10:00:00.000Z',
    collectedAt: '2026-08-27T10:00:00.000Z'
  }
];

test('ReplicationPortStatusView shows empty-state when no rows', async () => {
  adminApi.getReplicationPortStatus.mockResolvedValue({
    data: { ports: [135, 445, 50001, 50002, 50003], rows: [] }
  });
  const wrapper = mountView();
  await flushPromises();
  expect(wrapper.text()).toContain('暂无数据');
  // Port chips show the configured port list even with no rows.
  expect(wrapper.text()).toContain('135');
  expect(wrapper.text()).toContain('50003');
});

test('ReplicationPortStatusView renders one row per (sourceDc, destDc) pair with per-port cells (round-23 column order)', async () => {
  adminApi.getReplicationPortStatus.mockResolvedValue({
    data: { ports: [135, 445], rows: sampleRows }
  });
  const wrapper = mountView();
  await flushPromises();

  const rows = wrapper.findAll('[data-test="pair-row"]');
  expect(rows).toHaveLength(2);

  // 2026-08-27 round-23: column order is 站点 / 源服务器 / 目标服务器 / ports / 最近探测.
  // First row text (DC1→DC2): SiteA, DC1, DC2.
  const cells0 = rows[0].findAll('td');
  expect(cells0[0].text()).toBe('SiteA');
  expect(cells0[1].text()).toBe('DC1');
  expect(cells0[2].text()).toBe('DC2');

  // Reachable cell gets the green background class.
  const portCells = rows[0].findAll('[data-test="port-cell"]');
  // Port 135 reachable on row 0
  expect(portCells[0].classes()).toContain('cell-ok');
  // Port 445 unreachable on row 0
  expect(portCells[1].classes()).toContain('cell-err');

  // Latency rendered in cell.
  expect(portCells[0].text()).toContain('5');

  // data-* attributes preserved for any future test selector.
  expect(rows[0].attributes('data-source')).toBe('DC1');
  expect(rows[0].attributes('data-dest')).toBe('DC2');
});

test('ReplicationPortStatusView filters rows by site (round-23 filter bar)', async () => {
  adminApi.getReplicationPortStatus.mockResolvedValue({
    data: { ports: [135, 445], rows: sampleRows }
  });
  const wrapper = mountView();
  await flushPromises();

  // Pick SiteB — only the first row (SiteA→SiteB) should remain.
  const siteSelect = wrapper.find('[data-test="filter-site"]');
  await siteSelect.setValue('SiteB');
  await flushPromises();

  const visible = wrapper.findAll('[data-test="pair-row"]');
  expect(visible).toHaveLength(1);
  expect(visible[0].attributes('data-dest')).toBe('DC2');
});

test('ReplicationPortStatusView filters rows by server — match either source or dest', async () => {
  adminApi.getReplicationPortStatus.mockResolvedValue({
    data: { ports: [135, 445], rows: sampleRows }
  });
  const wrapper = mountView();
  await flushPromises();

  // DC3 is only on the destination side of row 2 — filter must still match it.
  const serverSelect = wrapper.find('[data-test="filter-server"]');
  await serverSelect.setValue('DC3');
  await flushPromises();

  const visible = wrapper.findAll('[data-test="pair-row"]');
  expect(visible).toHaveLength(1);
  expect(visible[0].attributes('data-dest')).toBe('DC3');
});

test('ReplicationPortStatusView reset button clears both filters', async () => {
  adminApi.getReplicationPortStatus.mockResolvedValue({
    data: { ports: [135, 445], rows: sampleRows }
  });
  const wrapper = mountView();
  await flushPromises();

  await wrapper.find('[data-test="filter-site"]').setValue('SiteB');
  await flushPromises();
  expect(wrapper.findAll('[data-test="pair-row"]')).toHaveLength(1);

  await wrapper.find('[data-test="filter-reset"]').trigger('click');
  await flushPromises();

  const siteSelect = wrapper.find('[data-test="filter-site"]');
  const serverSelect = wrapper.find('[data-test="filter-server"]');
  expect(siteSelect.element.value).toBe('');
  expect(serverSelect.element.value).toBe('');
  expect(wrapper.findAll('[data-test="pair-row"]')).toHaveLength(2);
});

test('ReplicationPortStatusView shows filter-empty message when filters match no rows', async () => {
  // Sample rows only contain DC1/DC2/DC3 — filter by a non-existent value
  // to exercise the empty-after-filter path. We poke the ref directly so
  // we don't depend on a matching <option> existing in the select (which
  // is required for setValue to actually emit change on a native <select>).
  adminApi.getReplicationPortStatus.mockResolvedValue({
    data: { ports: [135, 445], rows: sampleRows }
  });
  const wrapper = mountView();
  await flushPromises();

  // Set both filters to a value no row matches.
  wrapper.vm.filterSite = 'NoSuchSite';
  await flushPromises();

  expect(wrapper.find('[data-test="filter-empty"]').exists()).toBe(true);
  expect(wrapper.findAll('[data-test="pair-row"]')).toHaveLength(0);
});

test('ReplicationPortStatusView shows a manage-ports link pointing at /admin/ports (round-17: no in-page editor)', async () => {
  adminApi.getReplicationPortStatus.mockResolvedValue({ data: { ports: [135], rows: [] } });
  const wrapper = mountView();
  await flushPromises();
  const headerLink = wrapper.find('[data-test="manage-ports-link"]');
  expect(headerLink.exists()).toBe(true);
  expect(headerLink.attributes('href')).toBe('/admin/ports');
  expect(wrapper.text()).toContain('端口健康检查');
  expect(wrapper.find('.edit-ports-btn').exists()).toBe(false);
  expect(wrapper.find('[data-test="ports-modal"]').exists()).toBe(false);
});

test('ReplicationPortStatusView load error renders error banner', async () => {
  adminApi.getReplicationPortStatus.mockRejectedValue(new Error('boom'));
  const wrapper = mountView();
  await flushPromises();
  expect(wrapper.find('.error-banner').exists()).toBe(true);
});

test('ReplicationPortStatusView available filter options are derived from the loaded rows', async () => {
  adminApi.getReplicationPortStatus.mockResolvedValue({
    data: { ports: [135, 445], rows: sampleRows }
  });
  const wrapper = mountView();
  await flushPromises();

  const siteSelect = wrapper.find('[data-test="filter-site"]');
  const serverSelect = wrapper.find('[data-test="filter-server"]');
  const siteOptions = siteSelect.findAll('option').map((o) => o.text());
  const serverOptions = serverSelect.findAll('option').map((o) => o.text());

  expect(siteOptions).toEqual(['全部', 'SiteA', 'SiteB']);
  expect(serverOptions).toEqual(['全部', 'DC1', 'DC2', 'DC3']);
});