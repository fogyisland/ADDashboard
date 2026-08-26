import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
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
  '/admin/member-servers', '/admin/server-groups',
  '/admin/sites-catalog', '/admin/dcs-catalog',
  '/admin/site-replication-matrix', '/admin/ports', '/admin/replication-port-status',
  '/admin/heartbeat-report', '/admin/packages',
  '/admin/migrations', '/admin/orphan-schemas',
  '/admin/config', '/admin/email-config', '/admin/audit'
];

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dataset.theme = '';
  setActivePinia(createPinia());
  vi.resetModules();
});

test('renders 6 nav groups', () => {
  const w = mountLayout();
  expect(w.findAll('.nav-group').length).toBe(6);
});

test('renders all 16 nav-links with correct paths', () => {
  const w = mountLayout();
  const links = w.findAll('a.nav-link');
  expect(links.length).toBe(16);
  const actualPaths = links.map(a => a.attributes('href'));
  expect(actualPaths).toEqual(EXPECTED_PATHS);
});

test('all groups open by default', () => {
  const w = mountLayout();
  const details = w.findAll('details');
  expect(details.length).toBe(6);
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

test('theme toggle button is present in topbar (left of 退出)', async () => {
  const w = mountLayout();
  const buttons = w.findAll('.topbar-actions button');
  // last two must be: theme toggle, then 退出
  const labels = buttons.map(b => b.text());
  expect(labels[labels.length - 1]).toBe('退出');
  expect(buttons[buttons.length - 2].classes()).toContain('theme-toggle');
});

test('clicking the theme toggle flips data-theme on <html>', async () => {
  const w = mountLayout();
  const toggle = w.find('.theme-toggle');
  // Get to a known starting state (dark) by toggling if needed.
  let safety = 3;
  while (document.documentElement.dataset.theme !== 'dark' && safety-- > 0) {
    await toggle.trigger('click');
    await nextTick();
  }
  expect(document.documentElement.dataset.theme).toBe('dark');
  await toggle.trigger('click');
  await nextTick();
  expect(document.documentElement.dataset.theme).toBe('light');
  await toggle.trigger('click');
  await nextTick();
  expect(document.documentElement.dataset.theme).toBe('dark');
});

test('theme toggle icon matches current theme (☀ when dark, 🌙 when light)', async () => {
  const w = mountLayout();
  // Get to a known starting state (dark) by toggling if needed.
  let safety = 3;
  while (document.documentElement.dataset.theme !== 'dark' && safety-- > 0) {
    await w.find('.theme-toggle').trigger('click');
    await nextTick();
  }
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(w.find('.theme-toggle').text()).toBe('☀');
  await w.find('.theme-toggle').trigger('click');
  await nextTick();
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(w.find('.theme-toggle').text()).toBe('🌙');
});