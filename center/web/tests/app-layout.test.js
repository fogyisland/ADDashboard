import { test, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import AppLayout from '../src/components/AppLayout.vue';

const RouterLinkStub = {
  props: ['to'],
  template: '<a :href="to"><slot /></a>'
};

function mountLayout() {
  return mount(AppLayout, {
    global: { stubs: { 'router-link': RouterLinkStub } }
  });
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dataset.theme = '';
  setActivePinia(createPinia());
  vi.resetModules();
});

test('renders sidebar nav links for the main pages', () => {
  const w = mountLayout();
  const links = w.findAll('.sidebar a');
  const hrefs = links.map(a => a.attributes('href'));
  expect(hrefs).toContain('/');
  expect(hrefs).toContain('/matrix');
  expect(hrefs).toContain('/topology');
  expect(hrefs).toContain('/errors');
  expect(hrefs).toContain('/agents');
  expect(hrefs).toContain('/dashboard/metrics');
  expect(hrefs).toContain('/packages-runs');
  expect(hrefs).toContain('/servers-overview');
});

test('renders 退出 button in topbar', () => {
  const w = mountLayout();
  const buttons = w.findAll('.topbar-actions button');
  expect(buttons[buttons.length - 1].text()).toBe('退出');
});

test('theme toggle button is present in topbar (left of 退出)', () => {
  const w = mountLayout();
  const buttons = w.findAll('.topbar-actions button');
  expect(buttons[buttons.length - 2].classes()).toContain('theme-toggle');
});

test('clicking the theme toggle flips data-theme on <html>', async () => {
  const w = mountLayout();
  const toggle = w.find('.theme-toggle');
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