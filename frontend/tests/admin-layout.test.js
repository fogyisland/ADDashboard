import { test, expect, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import AdminLayout from '../src/components/AdminLayout.vue';

const RouterLinkStub = {
  props: ['to'],
  template: '<a :href="to"><slot /></a>'
};

function mountLayout() {
  return mount(AdminLayout, {
    global: { stubs: { 'router-link': RouterLinkStub } }
  });
}

const EXPECTED_PATHS = [
  '/admin/users', '/admin/roles',
  '/admin/sites-catalog', '/admin/dcs-catalog',
  '/admin/site-replication-matrix', '/admin/ports', '/admin/packages',
  '/admin/config', '/admin/audit', '/admin/migrations'
];

beforeEach(() => {
  setActivePinia(createPinia());
});

test('renders 4 nav groups', () => {
  const w = mountLayout();
  expect(w.findAll('.nav-group').length).toBe(4);
});

test('renders all 10 nav-links with correct paths', () => {
  const w = mountLayout();
  const links = w.findAll('a.nav-link');
  expect(links.length).toBe(10);
  const actualPaths = links.map(a => a.attributes('href'));
  expect(actualPaths).toEqual(EXPECTED_PATHS);
});

test('all groups open by default', () => {
  const w = mountLayout();
  const details = w.findAll('details');
  expect(details.length).toBe(4);
  for (const d of details) {
    expect(d.attributes('open')).toBeDefined();
  }
});

test('clicking summary toggles open state', async () => {
  const w = mountLayout();
  const firstDetails = w.findAll('details')[0];
  const summary = firstDetails.find('summary');
  expect(summary.exists()).toBe(true);
  // initial: open
  expect(firstDetails.attributes('open')).toBeDefined();
  // click to close
  await summary.trigger('click');
  await flushPromises();
  expect(w.findAll('details')[0].attributes('open')).toBeUndefined();
  // click again to re-open
  await w.findAll('details')[0].find('summary').trigger('click');
  await flushPromises();
  expect(w.findAll('details')[0].attributes('open')).toBeDefined();
});