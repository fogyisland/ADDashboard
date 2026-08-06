import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import ServersOverviewView from '../src/views/ServersOverviewView.vue';
import { getDcSummary } from '../src/api/dcs.js';
import { adminApi } from '../src/api/admin.js';

vi.mock('../src/api/dcs.js', () => ({
  getDcSummary: vi.fn(() => Promise.resolve({ data: [] }))
}));
vi.mock('../src/api/admin.js', () => ({
  adminApi: { listSites: vi.fn(() => Promise.resolve({ data: [] })) }
}));

const SAMPLE = [
  { dcHost: 'DC01', siteName: 'SiteA', partnersCount: 3, usersCount: 100, groupsCount: 30, gposCount: 5, lockedCount: 2, collectedAt: '2026-08-06T10:00:00.000Z' },
  { dcHost: 'DC02', siteName: 'SiteB', partnersCount: 2, usersCount: 110, groupsCount: 31, gposCount: 6, lockedCount: 0, collectedAt: '2026-08-06T10:00:00.000Z' }
];

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/servers-overview', component: ServersOverviewView }]
  });
}

beforeEach(() => {
  getDcSummary.mockReset();
  adminApi.listSites.mockReset();
  adminApi.listSites.mockResolvedValue({ data: [] });
});

test('renders skeleton while loading', async () => {
  setActivePinia(createPinia());
  getDcSummary.mockReturnValue(new Promise(() => {})); // never resolves
  const w = mount(ServersOverviewView, { global: { plugins: [makeRouter()] } });
  await flushPromises();
  expect(w.find('.skeleton-grid').exists()).toBe(true);
});

test('renders cards after data loads', async () => {
  setActivePinia(createPinia());
  getDcSummary.mockResolvedValue({ data: SAMPLE });
  const w = mount(ServersOverviewView, { global: { plugins: [makeRouter()] } });
  await flushPromises();
  expect(w.find('.skeleton-grid').exists()).toBe(false);
  expect(w.findAll('.dc-card').length).toBe(2);
  expect(w.text()).toContain('DC01');
  expect(w.text()).toContain('DC02');
});

test('site filter change re-fetches with new siteId', async () => {
  setActivePinia(createPinia());
  adminApi.listSites.mockResolvedValue({ data: [{ id: 1, site_name: 'SiteA' }, { id: 2, site_name: 'SiteB' }] });
  getDcSummary.mockResolvedValue({ data: SAMPLE });
  const w = mount(ServersOverviewView, { global: { plugins: [makeRouter()] } });
  await flushPromises();
  expect(getDcSummary).toHaveBeenCalledWith(null); // initial call: all sites
  const select = w.find('select.site-filter');
  expect(select.exists()).toBe(true);
  // Set siteId to 1 (SiteA)
  await select.setValue('1');
  await flushPromises();
  expect(getDcSummary).toHaveBeenCalledWith(1);
});
