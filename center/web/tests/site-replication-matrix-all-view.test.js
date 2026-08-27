import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../src/api/dashboard.js', () => ({
  dashboardApi: {
    getSiteReplicationMatrixAll: vi.fn(() => Promise.resolve({
      data: {
        siteRefreshSeconds: 10,
        ports: [135, 445, 50001],
        sites: []
      }
    }))
  }
}));

import SiteReplicationMatrixAllView from '../src/views/admin/SiteReplicationMatrixAllView.vue';
import { dashboardApi } from '../src/api/dashboard.js';

const basePayload = () => ({
  siteRefreshSeconds: 10,
  ports: [135, 445, 50001],
  sites: [
    {
      siteId: 1, siteName: '核心站点', regionCode: 'BJ', isHub: true, description: null,
      dcs: [{ dcName: 'DC-BJ-01' }, { dcName: 'DC-BJ-02' }],
      withinLinks: [{ source: 'DC-BJ-01', target: 'DC-BJ-02', statusCode: 0 }],
      crossOut: [], crossIn: []
    },
    {
      siteId: 2, siteName: '上海站点', regionCode: 'SH', isHub: false, description: null,
      dcs: [{ dcName: 'DC-SH-01' }],
      withinLinks: [],
      crossOut: [{
        source: 'DC-SH-01', sourceSite: '上海站点',
        target: 'DC-BJ-01', targetSite: '核心站点',
        statusCode: 1,
        perPort: { '135': { reachable: true, latencyMs: 3 }, '445': { reachable: false, error: 'timeout' } },
        lastProbeAt: '2026-08-27T10:00:00Z'
      }],
      crossIn: []
    }
  ]
});

beforeEach(() => {
  dashboardApi.getSiteReplicationMatrixAll.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

test('mounts and renders hub-first site blocks with hub badge', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  const blocks = w.findAll('section.site-block');
  expect(blocks).toHaveLength(2);
  expect(blocks[0].text()).toContain('核心站点');
  expect(blocks[0].text()).toContain('中心');
  expect(blocks[1].text()).not.toContain('中心');
});

test('cross-site link renders with colored port badges', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  // 上海站点 has crossOut[0] = DC-SH-01 → DC-BJ-01 with perPort
  const crossOutLi = w.find('[data-test="cross-out-DC-SH-01-DC-BJ-01"]');
  expect(crossOutLi.exists()).toBe(true);
  expect(crossOutLi.text()).toContain('DC-SH-01 → DC-BJ-01');
  // 3 ports rendered (135, 445, 50001)
  const ports = crossOutLi.findAll('.port');
  expect(ports).toHaveLength(3);
  expect(ports[0].classes()).toContain('port-ok');
  expect(ports[1].classes()).toContain('port-err');
  expect(ports[2].classes()).toContain('port-none');
});

test('polling: re-fetches every refreshSeconds * 1000 ms', async () => {
  vi.useFakeTimers();
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  expect(dashboardApi.getSiteReplicationMatrixAll).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(dashboardApi.getSiteReplicationMatrixAll.mock.calls.length).toBeGreaterThanOrEqual(2);
});

test('clears interval on unmount', async () => {
  vi.useFakeTimers();
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  w.unmount();
  await vi.advanceTimersByTimeAsync(30_000);
  // No further calls after unmount
  expect(dashboardApi.getSiteReplicationMatrixAll).toHaveBeenCalledTimes(1);
});
