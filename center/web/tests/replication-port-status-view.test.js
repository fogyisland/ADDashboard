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

test('ReplicationPortStatusView renders one row per (sourceDc, destDc) pair with per-port icons', async () => {
  adminApi.getReplicationPortStatus.mockResolvedValue({
    data: {
      ports: [135, 445],
      rows: [
        {
          sourceDc: 'DC1', sourceSite: 'SiteA',
          destDc: 'DC2', destSite: 'SiteB',
          perPort: {
            '135': { reachable: true, latencyMs: 5 },
            '445': { reachable: false, latencyMs: null, error: 'timeout' }
          },
          lastAttemptTime: '2026-08-26T10:00:00.000Z',
          collectedAt: '2026-08-26T10:00:00.000Z'
        },
        {
          sourceDc: 'DC1', sourceSite: 'SiteA',
          destDc: 'DC3', destSite: 'SiteB',
          perPort: {
            '135': { reachable: true, latencyMs: 8 },
            '445': { reachable: true, latencyMs: 6 }
          },
          lastAttemptTime: '2026-08-26T10:00:00.000Z',
          collectedAt: '2026-08-26T10:00:00.000Z'
        }
      ]
    }
  });
  const wrapper = mountView();
  await flushPromises();

  const rows = wrapper.findAll('[data-test="pair-row"]');
  expect(rows).toHaveLength(2);

  // First row: DC1→DC2, mixed (warn).
  expect(rows[0].attributes('data-source')).toBe('DC1');
  expect(rows[0].attributes('data-dest')).toBe('DC2');
  expect(rows[0].text()).toContain('部分通');

  // Second row: DC1→DC3, all reachable (ok).
  expect(rows[1].attributes('data-source')).toBe('DC1');
  expect(rows[1].attributes('data-dest')).toBe('DC3');
  expect(rows[1].text()).toContain('全通');

  // Latency rendered in cell.
  const firstCells = rows[0].findAll('[data-test="port-cell"]');
  // Port 135 reachable → latency "5ms" should appear.
  expect(firstCells[0].text()).toContain('5');
});

test('ReplicationPortStatusView shows a manage-ports link pointing at /admin/ports (round-17: no in-page editor)', async () => {
  adminApi.getReplicationPortStatus.mockResolvedValue({ data: { ports: [135], rows: [] } });
  const wrapper = mountView();
  await flushPromises();
  // Header link
  const headerLink = wrapper.find('[data-test="manage-ports-link"]');
  expect(headerLink.exists()).toBe(true);
  expect(headerLink.attributes('href')).toBe('/admin/ports');
  // Inline hint link
  expect(wrapper.text()).toContain('端口健康检查');
  // No edit-ports-btn (the old editor was removed in round-17).
  expect(wrapper.find('.edit-ports-btn').exists()).toBe(false);
  // No ports-modal element exists.
  expect(wrapper.find('[data-test="ports-modal"]').exists()).toBe(false);
});

test('ReplicationPortStatusView load error renders error banner', async () => {
  adminApi.getReplicationPortStatus.mockRejectedValue(new Error('boom'));
  const wrapper = mountView();
  await flushPromises();
  expect(wrapper.find('.error-banner').exists()).toBe(true);
});