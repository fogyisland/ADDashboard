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

// 2026-08-28 round-51: drop 服务器管理 umbrella + 3 sub-buckets, replace
// with 6 flat top-level groups. Operator-frequency order. Total nav-links
// stays at 17; URL paths unchanged. Labels at the top level shift: the
// 监控与健康组 / 活动目录服务器组 sub-bucket titles drop (their items move
// to the 监控健康 / AD 管理 top-level groups respectively).
const EXPECTED_PATHS = [
  // 监控健康 (R51: promoted from 服务器管理 > 监控与健康组 sub-bucket)
  '/admin/site-replication-matrix/all',
  // R47: standalone 复制伙伴端口健康监控 replaces the R45-restored
  // 复制日志监控. Path /admin/replication-log/monitor preserved.
  '/admin/replication-log/monitor',
  '/admin/ports',
  '/admin/heartbeat-report',
  // AD 管理 (R51: promoted from 服务器管理 > 活动目录服务器组 sub-bucket)
  '/admin/sites-catalog',
  '/admin/dcs-catalog',
  // R39: 运维区统一日志 — 审计事件 + 心跳 + 报告 三块合一.
  '/admin/operations-log',
  '/admin/packages',
  // 服务器管理 (R51: now contains only non-AD assets — the 高频 AD /
  // monitoring items lifted to top level in this round)
  '/admin/member-servers',
  '/admin/server-groups',
  // 账号管理
  '/admin/users',
  '/admin/roles',
  // 数据库运维
  '/admin/migrations',
  '/admin/orphan-schemas',
  // 系统设置
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

test('R51: renders 6 flat nav groups (operator-frequency order: 监控健康 / AD 管理 / 服务器管理 / 账号管理 / 数据库运维 / 系统设置)', () => {
  const w = mountLayout();
  const groupTitles = w.findAll('.nav-group-title').map(t => t.text());
  expect(groupTitles).toEqual([
    '监控健康',
    'AD 管理',
    '服务器管理',
    '账号管理',
    '数据库运维',
    '系统设置'
  ]);
  expect(w.findAll('.nav-group').length).toBe(6);
});

test('R51: no sub-groups remain (umbrella dropped; all groups flat)', () => {
  const w = mountLayout();
  expect(w.findAll('.nav-subgroup').length).toBe(0);
  expect(w.findAll('.nav-subgroup-title').length).toBe(0);
});

test('R51: renders all 17 nav-links with correct paths in operator-frequency order', () => {
  // R51: nav-link count stays at 17. Path order changes to match operator
  // check frequency — 监控健康 (4 items) first, AD 管理 (4) second,
  // 服务器管理 (2), 账号管理 (2), 数据库运维 (2), 系统设置 (3) last.
  const w = mountLayout();
  const links = w.findAll('a.nav-link');
  expect(links.length).toBe(17);
  const actualPaths = links.map(a => a.attributes('href'));
  expect(actualPaths).toEqual(EXPECTED_PATHS);
  // R47 label still correct after R51 reorder.
  const portHealthLink = links.find(a => a.attributes('href') === '/admin/replication-log/monitor');
  expect(portHealthLink).toBeDefined();
  expect(portHealthLink.text()).toBe('复制伙伴端口健康监控');
});

test('R51: 监控健康 group contains the 4 monitoring/health items in the new top-level position', () => {
  const w = mountLayout();
  const monitorGroup = w.findAll('.nav-group')[0];
  expect(monitorGroup.find('.nav-group-title').text()).toBe('监控健康');
  // Flat group: links are direct children, no subgroup wrapper.
  const monitorLinks = monitorGroup.findAll('a.nav-link').map(a => a.text());
  expect(monitorLinks).toEqual([
    '复制状态概览', '复制伙伴端口健康监控', '端口健康检查', '心跳与报告'
  ]);
});

test('R51: AD 管理 group contains the 4 AD admin items (promoted from sub-bucket)', () => {
  const w = mountLayout();
  const adGroup = w.findAll('.nav-group')[1];
  expect(adGroup.find('.nav-group-title').text()).toBe('AD 管理');
  const adLinks = adGroup.findAll('a.nav-link').map(a => a.text());
  expect(adLinks).toEqual([
    'AD 站点清单', 'AD 域控清单', '操作日志', '包管理'
  ]);
});

test('R51: 服务器管理 group now contains only the 2 non-AD items (umbrella split)', () => {
  const w = mountLayout();
  const serverGroup = w.findAll('.nav-group')[2];
  expect(serverGroup.find('.nav-group-title').text()).toBe('服务器管理');
  const serverLinks = serverGroup.findAll('a.nav-link').map(a => a.text());
  expect(serverLinks).toEqual(['非活动目录', '非活动目录服务器组']);
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