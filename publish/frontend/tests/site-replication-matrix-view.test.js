import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../src/api/dashboard.js', () => ({
  dashboardApi: {
    getSiteReplicationMatrix: vi.fn(() => Promise.resolve({
      data: { site: { siteId: 1, siteName: 'Beijing-Site' }, dcs: [], links: [], siteRefreshSeconds: 10 }
    }))
  }
}));

vi.mock('../src/api/admin.js', () => ({
  adminApi: {
    listSitesCatalog: vi.fn(() => Promise.resolve({
      data: [{ id: 1, siteName: 'Beijing-Site' }, { id: 2, siteName: 'Shanghai-Site' }]
    }))
  }
}));

import SiteReplicationMatrixView from '../src/views/admin/SiteReplicationMatrixView.vue';
import { dashboardApi } from '../src/api/dashboard.js';

beforeEach(() => {
  vi.useFakeTimers();
  dashboardApi.getSiteReplicationMatrix.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

test('SiteReplicationMatrixView renders site dropdown and refetches on interval', async () => {
  dashboardApi.getSiteReplicationMatrix.mockResolvedValue({
    data: {
      site: { siteId: 1, siteName: 'Beijing-Site' },
      dcs: [{ dcName: 'DC-BJ-01', osVersion: 'Win2022' }],
      links: [{ source: 'DC-BJ-01', target: 'DC-BJ-02', statusCode: 0, namingContext: 'DC=contoso,DC=com' }],
      siteRefreshSeconds: 10
    }
  });

  const wrapper = mount(SiteReplicationMatrixView, {
    global: { stubs: { AppLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  expect(wrapper.text()).toContain('Beijing-Site');
  expect(wrapper.text()).toContain('DC-BJ-01');

  // Advance time by 10s -> should refetch
  const callsBefore = dashboardApi.getSiteReplicationMatrix.mock.calls.length;
  vi.advanceTimersByTime(10_000);
  await flushPromises();
  expect(dashboardApi.getSiteReplicationMatrix.mock.calls.length).toBeGreaterThan(callsBefore);

  wrapper.unmount();
});

test('SiteReplicationMatrixView clears interval on unmount', async () => {
  dashboardApi.getSiteReplicationMatrix.mockResolvedValue({
    data: { site: { siteId: 1, siteName: 'X' }, dcs: [], links: [], siteRefreshSeconds: 10 }
  });

  const clearSpy = vi.spyOn(global, 'clearInterval');
  const wrapper = mount(SiteReplicationMatrixView, {
    global: { stubs: { AppLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  wrapper.unmount();
  expect(clearSpy).toHaveBeenCalled();
});
