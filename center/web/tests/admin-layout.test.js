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
  // 账号管理
  '/admin/users', '/admin/roles',
  // 服务器管理 > 活动目录服务器组 (8 items — R48.1 absorbs 目录管理 + 监控运维)
  '/admin/sites-catalog', '/admin/dcs-catalog',
  '/admin/site-replication-matrix/all',
  // 2026-08-28 round-47: standalone 复制伙伴端口健康监控 replaces the
  // R45-restored 复制日志监控 (which listed replication-attempt history).
  // Operator directive "在这边不叫复制日志监控了，改成复制伙伴端口健康
  // 监控名称". Path /admin/replication-log/monitor preserved for
  // backward-compat with any saved bookmarks; the label changed.
  '/admin/replication-log/monitor',
  '/admin/ports',
  '/admin/heartbeat-report', '/admin/operations-log', '/admin/packages',
  // 服务器管理 > 普通服务器组 (2 items — R48.1 absorbs 服务器管理; labels
  // renamed 非 AD 服务器 → 非活动目录, 非 AD 服务器组 → 非活动目录服务器组)
  '/admin/member-servers', '/admin/server-groups',
  // 数据库运维
  '/admin/migrations', '/admin/orphan-schemas',
  // 系统设置
  '/admin/config', '/admin/email-config', '/admin/audit'
];

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dataset.theme = '';
  setActivePinia(createPinia());
  vi.resetModules();
});

test('renders 4 nav groups (round-48.1: 服务器管理 absorbs 目录管理+服务器管理; sub-groups 活动目录服务器组 + 普通服务器组)', () => {
  const w = mountLayout();
  const groupTitles = w.findAll('.nav-group-title').map(t => t.text());
  expect(groupTitles).toEqual(['账号管理', '服务器管理', '数据库运维', '系统设置']);
  expect(w.findAll('.nav-group').length).toBe(4);
});

test('renders all 17 nav-links with correct paths', () => {
  // 2026-08-28 round-47: nav-link count stays at 17. R47 renames the
  // label on the existing /admin/replication-log/monitor slot from
  // 复制日志监控 → 复制伙伴端口健康监控 (no add/remove).
  // 2026-08-28 round-48.1: same 17 nav-links, now nested under 服务器管理
  // umbrella instead of split into 活动目录 + 非活动目录 top-level groups.
  const w = mountLayout();
  const links = w.findAll('a.nav-link');
  expect(links.length).toBe(17);
  const actualPaths = links.map(a => a.attributes('href'));
  expect(actualPaths).toEqual(EXPECTED_PATHS);
  // R47: the /admin/replication-log/monitor slot now carries the new label.
  const portHealthLink = links.find(a => a.attributes('href') === '/admin/replication-log/monitor');
  expect(portHealthLink).toBeDefined();
  expect(portHealthLink.text()).toBe('复制伙伴端口健康监控');
});

test('R48.1: 服务器管理 umbrella has 2 sub-groups (活动目录服务器组 + 普通服务器组)', () => {
  const w = mountLayout();
  const serverMgmtGroup = w.findAll('.nav-group')[1];
  expect(serverMgmtGroup.find('.nav-group-title').text()).toBe('服务器管理');
  const subGroupTitles = serverMgmtGroup.findAll('.nav-subgroup-title').map(t => t.text());
  expect(subGroupTitles).toEqual(['活动目录服务器组', '普通服务器组']);
});

test('R48.1: 活动目录服务器组 sub-group contains the 8 AD-related items', () => {
  const w = mountLayout();
  const serverMgmtGroup = w.findAll('.nav-group')[1];
  const activeDirSubgroup = serverMgmtGroup.findAll('.nav-subgroup')[0];
  expect(activeDirSubgroup.find('.nav-subgroup-title').text()).toBe('活动目录服务器组');
  const activeDirLinks = activeDirSubgroup.findAll('a.nav-link').map(a => a.text());
  expect(activeDirLinks).toEqual([
    'AD 站点清单', 'AD 域控清单',
    '复制状态概览', '复制伙伴端口健康监控', '端口健康检查',
    '心跳与报告', '操作日志', '包管理'
  ]);
});

test('R48.1: 普通服务器组 sub-group contains the 2 non-AD items (renamed 非 AD → 非活动目录)', () => {
  const w = mountLayout();
  const serverMgmtGroup = w.findAll('.nav-group')[1];
  const normalServerSubgroup = serverMgmtGroup.findAll('.nav-subgroup')[1];
  expect(normalServerSubgroup.find('.nav-subgroup-title').text()).toBe('普通服务器组');
  const normalServerLinks = normalServerSubgroup.findAll('a.nav-link').map(a => a.text());
  expect(normalServerLinks).toEqual(['非活动目录', '非活动目录服务器组']);
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