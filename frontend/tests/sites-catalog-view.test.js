import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../src/api/admin.js', () => ({
  adminApi: {
    listSitesCatalog: vi.fn(() => Promise.resolve({ data: [] })),
    createSite: vi.fn(() => Promise.resolve({ data: { id: 99 } })),
    updateSite: vi.fn(() => Promise.resolve({ data: { ok: true } })),
    deleteSite: vi.fn(() => Promise.resolve({ data: { ok: true } }))
  }
}));

import SitesCatalogView from '../src/views/admin/SitesCatalogView.vue';
import { adminApi } from '../src/api/admin.js';

beforeEach(() => {
  adminApi.listSitesCatalog.mockReset();
  adminApi.createSite.mockReset();
  adminApi.updateSite.mockReset();
  adminApi.deleteSite.mockReset();
});

test('SitesCatalogView renders rows from listSitesCatalog', async () => {
  adminApi.listSitesCatalog.mockResolvedValue({
    data: [
      { id: 1, siteName: 'Beijing-Site', regionCode: 'BJ', isHub: true, description: 'BJ-DC', dcCount: 3 },
      { id: 2, siteName: 'Shanghai-Site', regionCode: 'SH', isHub: false, description: null, dcCount: 0 }
    ]
  });
  const wrapper = mount(SitesCatalogView, {
    global: { stubs: { AppLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  const text = wrapper.text();
  expect(text).toContain('Beijing-Site');
  expect(text).toContain('Shanghai-Site');
  expect(text).toContain('BJ');
  expect(text).toContain('3');
});