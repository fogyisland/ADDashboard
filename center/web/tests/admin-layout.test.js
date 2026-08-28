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

// 2026-08-28 round-52: 5 top-level groups (down from R51's 6) with emoji icons
// + 3-level nesting for AD 复制与端口. URL paths unchanged from R51 —
// only labels + structural grouping change.
//
// Group order (ops-frequency):
//   1. 📊 监控与诊断  — 1 nested AD 复制与端口 [3 sub-items] + 1 flat 心跳与告警
//   2. 🛡️ AD 目录服务 — 3 flat items
//   3. 💻 服务器管理  — 3 flat items (操作日志 moved here from R51's AD 管理)
//   4. 👥 权限与账号  — 3 flat items (包管理 moved here from R51's AD 管理)
//   5. ⚙️ 系统运维    — 4 flat items (数据库运维 + 系统设置 consolidated)
//
// Total nav-links: 17 (unchanged from R51). 14 visible at level 2
// (5 group titles + AD 复制与端口 parent = 6 top-level + ...), 3 at level 3.
//
// DOM order: sub-links come BEFORE flat-links because they're rendered
// inside 监控与诊断 at the top of the sidebar.
const EXPECTED_PATHS = [
  // 监控与诊断 > AD 复制与端口 > [3 sub-items] (level 3, rendered first in DOM)
  '/admin/site-replication-matrix/all',
  '/admin/replication-log/monitor',
  '/admin/ports',
  // 监控与诊断 > 心跳与告警 (level 2)
  '/admin/heartbeat-report',
  // AD 目录服务 (level 2)
  '/admin/sites-catalog',
  '/admin/dcs-catalog',
  '/admin/orphan-schemas',
  // 服务器管理 (R52: 操作日志 moved in here)
  '/admin/member-servers',
  '/admin/server-groups',
  '/admin/operations-log',
  // 权限与账号 (R52: 包管理 moved in here)
  '/admin/users',
  '/admin/roles',
  '/admin/packages',
  // 系统运维 (R52: 数据库运维 + 系统设置 consolidated)
  '/admin/migrations',
  '/admin/config',
  '/admin/email-config',
  '/admin/audit'
];

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dataset.theme = '';
  setActivePinia(createPinia());
  vi.resetModules();
});

test('R52: renders 5 top-level groups in operator-frequency order with icons', () => {
  const w = mountLayout();
  const groupTitles = w.findAll('.nav-group-title .label').map(t => t.text());
  expect(groupTitles).toEqual([
    '监控与诊断',
    'AD 目录服务',
    '服务器管理',
    '权限与账号',
    '系统运维'
  ]);
  // Each group title has an emoji icon as a sibling.
  const icons = w.findAll('.nav-group-title .icon').map(t => t.text());
  expect(icons).toEqual(['📊', '🛡️', '💻', '👥', '⚙️']);
  expect(w.findAll('.nav-group').length).toBe(5);
});

test('R52: 监控与诊断 contains AD 复制与端口 (3-level nested) + 心跳与告警', () => {
  const w = mountLayout();
  const monitorGroup = w.findAll('.nav-group')[0];
  expect(monitorGroup.find('.nav-group-title .label').text()).toBe('监控与诊断');

  // AD 复制与端口 is a <details> (subgroup) inside 监控与诊断.
  const subgroup = monitorGroup.find('.nav-subgroup');
  expect(subgroup.exists()).toBe(true);
  expect(subgroup.find('.nav-subgroup-title').text()).toBe('AD 复制与端口');

  // 3 sub-items at level 3.
  const subLinks = subgroup.findAll('a.nav-sublink').map(a => a.attributes('href'));
  expect(subLinks).toEqual([
    '/admin/site-replication-matrix/all',
    '/admin/replication-log/monitor',
    '/admin/ports'
  ]);

  // 心跳与告警 is a flat <router-link> inside 监控与诊断.
  const flatLinks = monitorGroup.findAll(':scope > a.nav-link').map(a => a.attributes('href'));
  expect(flatLinks).toEqual(['/admin/heartbeat-report']);
});

test('R52: 操作日志 lives under 服务器管理 (moved from R51 AD 管理)', () => {
  const w = mountLayout();
  const serverGroup = w.findAll('.nav-group')[2];
  expect(serverGroup.find('.nav-group-title .label').text()).toBe('服务器管理');
  const links = serverGroup.findAll(':scope > a.nav-link').map(a => a.attributes('href'));
  expect(links).toEqual([
    '/admin/member-servers',
    '/admin/server-groups',
    '/admin/operations-log'
  ]);
});

test('R52: 包管理 lives under 权限与账号 (moved from R51 AD 管理)', () => {
  const w = mountLayout();
  const iamGroup = w.findAll('.nav-group')[3];
  expect(iamGroup.find('.nav-group-title .label').text()).toBe('权限与账号');
  const links = iamGroup.findAll(':scope > a.nav-link').map(a => a.attributes('href'));
  expect(links).toEqual(['/admin/users', '/admin/roles', '/admin/packages']);
});

test('R52: 系统运维 contains 4 items (R51 数据库运维 + 系统设置 consolidated)', () => {
  const w = mountLayout();
  const opsGroup = w.findAll('.nav-group')[4];
  expect(opsGroup.find('.nav-group-title .label').text()).toBe('系统运维');
  const links = opsGroup.findAll(':scope > a.nav-link').map(a => a.attributes('href'));
  expect(links).toEqual([
    '/admin/migrations',
    '/admin/config',
    '/admin/email-config',
    '/admin/audit'
  ]);
});

test('R52: total 17 nav-links with correct paths (3 nested + 14 flat)', () => {
  const w = mountLayout();
  // DOM order: 3 level-3 nav-sublink (under AD 复制与端口) come first in DOM
  // because they live in 监控与诊断 at the top of the sidebar, then 14 level-2
  // nav-link flat items follow in group order. Use the combined selector
  // so DOM order is preserved.
  const allLinks = w.findAll('a.nav-link, a.nav-sublink').map(a => a.attributes('href'));
  expect(allLinks.length).toBe(17);
  expect(allLinks).toEqual(EXPECTED_PATHS);
});

test('R52: only ONE 3-level nested subgroup exists (AD 复制与端口)', () => {
  const w = mountLayout();
  expect(w.findAll('.nav-subgroup').length).toBe(1);
  expect(w.findAll('.nav-subgroup-title').length).toBe(1);
});

test('all top-level groups open by default', () => {
  const w = mountLayout();
  const details = w.findAll('details.nav-group');
  expect(details.length).toBe(5);
  for (const d of details) {
    expect(d.attributes('open')).toBeDefined();
  }
});

test('clicking group summary toggles open state', async () => {
  const w = mountLayout();
  const firstDetails = w.findAll('details.nav-group')[0];
  const summary = firstDetails.find('summary.nav-group-title');
  expect(summary.exists()).toBe(true);
  expect(firstDetails.attributes('open')).toBeDefined();
  await summary.trigger('click');
  await flushPromises();
  expect(w.findAll('details.nav-group')[0].attributes('open')).toBeUndefined();
  await w.findAll('details.nav-group')[0].find('summary.nav-group-title').trigger('click');
  await flushPromises();
  expect(w.findAll('details.nav-group')[0].attributes('open')).toBeDefined();
});

test('clicking subgroup summary toggles nested open state independently', async () => {
  const w = mountLayout();
  const subgroup = w.find('.nav-subgroup');
  expect(subgroup.exists()).toBe(true);
  expect(subgroup.attributes('open')).toBeDefined();

  const summary = subgroup.find('summary.nav-subgroup-title');
  await summary.trigger('click');
  await flushPromises();
  expect(w.find('.nav-subgroup').attributes('open')).toBeUndefined();

  await w.find('.nav-subgroup').find('summary.nav-subgroup-title').trigger('click');
  await flushPromises();
  expect(w.find('.nav-subgroup').attributes('open')).toBeDefined();
});

test('R52: sidebar collapse toggle is in topbar (always accessible)', () => {
  const w = mountLayout();
  const toggle = w.find('.sidebar-toggle');
  expect(toggle.exists()).toBe(true);
});

test('R52: clicking sidebar toggle flips sidebar-collapsed class on .layout', async () => {
  const w = mountLayout();
  expect(w.find('.layout').classes()).not.toContain('sidebar-collapsed');
  await w.find('.sidebar-toggle').trigger('click');
  await nextTick();
  expect(w.find('.layout').classes()).toContain('sidebar-collapsed');
  await w.find('.sidebar-toggle').trigger('click');
  await nextTick();
  expect(w.find('.layout').classes()).not.toContain('sidebar-collapsed');
});

test('R52: sidebar collapse state persists in localStorage', async () => {
  const w = mountLayout();
  // initial state: not collapsed
  expect(localStorage.getItem('admin-sidebar-visible')).toBeNull();
  await w.find('.sidebar-toggle').trigger('click');
  await nextTick();
  expect(localStorage.getItem('admin-sidebar-visible')).toBe('false');
  await w.find('.sidebar-toggle').trigger('click');
  await nextTick();
  expect(localStorage.getItem('admin-sidebar-visible')).toBe('true');
});

test('R52: sidebar collapsed on mount when localStorage says false', async () => {
  localStorage.setItem('admin-sidebar-visible', 'false');
  const w = mountLayout();
  await nextTick();
  await flushPromises();
  expect(w.find('.layout').classes()).toContain('sidebar-collapsed');
});

test('theme toggle button is present in topbar (left of 退出)', async () => {
  const w = mountLayout();
  const buttons = w.findAll('.topbar-actions button');
  const labels = buttons.map(b => b.text());
  expect(labels[labels.length - 1]).toBe('退出');
  expect(buttons[buttons.length - 2].classes()).toContain('theme-toggle');
});

test('clicking the theme toggle flips data-theme on <html>', async () => {
  const w = mountLayout();
  let safety = 3;
  while (document.documentElement.dataset.theme !== 'dark' && safety-- > 0) {
    await w.find('.theme-toggle').trigger('click');
    await nextTick();
  }
  expect(document.documentElement.dataset.theme).toBe('dark');
  await w.find('.theme-toggle').trigger('click');
  await nextTick();
  expect(document.documentElement.dataset.theme).toBe('light');
  await w.find('.theme-toggle').trigger('click');
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