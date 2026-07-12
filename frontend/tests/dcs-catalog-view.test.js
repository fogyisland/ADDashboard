import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../src/api/admin.js', () => ({
  adminApi: {
    listSitesCatalog: vi.fn(() => Promise.resolve({ data: [] })),
    listDcsCatalog: vi.fn(() => Promise.resolve({ data: [] })),
    assignDcSite: vi.fn(() => Promise.resolve({ data: { ok: true } }))
  }
}));

import DcsCatalogView from '../src/views/admin/DcsCatalogView.vue';
import { adminApi } from '../src/api/admin.js';

beforeEach(() => {
  adminApi.listSitesCatalog.mockReset();
  adminApi.listDcsCatalog.mockReset();
  adminApi.assignDcSite.mockReset();
});

test('DcsCatalogView renders DC rows with site name and role badges', async () => {
  adminApi.listSitesCatalog.mockResolvedValue({
    data: [{ id: 1, siteName: 'Beijing-Site' }]
  });
  adminApi.listDcsCatalog.mockResolvedValue({
    data: [
      { dcName: 'DC-BJ-01', siteId: 1, siteName: 'Beijing-Site', siteHint: 'Beijing-Site', osVersion: 'Win2022', isPdc: false, isGc: true, isRidMaster: false, isSchemaMaster: false, isDomainNamingMaster: false, isInfrastructureMaster: false, discoveredAt: '2026-07-12T00:00:00Z' },
      { dcName: 'DC-SH-01', siteId: null, siteName: null, siteHint: 'Shanghai-Site', osVersion: 'Win2019', isPdc: false, isGc: true, isRidMaster: false, isSchemaMaster: false, isDomainNamingMaster: false, isInfrastructureMaster: false, discoveredAt: null }
    ]
  });
  const wrapper = mount(DcsCatalogView, {
    global: { stubs: { AppLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  const text = wrapper.text();
  expect(text).toContain('DC-BJ-01');
  expect(text).toContain('Beijing-Site');
  expect(text).toContain('DC-SH-01');
  expect(text).toContain('未分配');
});
