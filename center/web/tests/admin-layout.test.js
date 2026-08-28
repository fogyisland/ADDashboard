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

// 2026-08-28 round-53: operator directive "按照我的要求 修改当前后台的界面".
// 5 top-level groups per operator's explicit spec + 1 system settings
// group for orphans (config / email-config / migrations — not in spec
// but functional views kept accessible).
//
// Operator's exact list:
//   监控与诊断 (4):  复制状态概览 / 复制伙伴端口监控 / 心跳与状态报告 / 包管理
//   AD 活动目录服务器 (4): 站点清单设置 / 域控清单设置 / 域控检查端口 / 文件推送功能
//   成员服务器管理 (4): 成员服务器组 / 成员服务器 / 成员服务器文件推送 / 成员服务器执行命令
//   权限和账户 (2):  用户管理 / 角色管理
//   运维日志 (2):    系统运维日志 / 心跳与状态执行日志
//
// R53 changes from R52:
//   - "心跳与告警" → "心跳与状态报告"
//   - "复制伙伴端口健康监控" → "复制伙伴端口监控"
//   - "AD 站点清单" → "AD 站点清单设置" (moved to AD 活动目录服务器)
//   - "AD 域控清单" → "AD 域控清单设置" (moved to AD 活动目录服务器)
//   - "端口健康检查" → "AD 域控检查端口" (moved from 监控与诊断 to AD 活动目录服务器)
//   - "非活动目录服务器组" → "成员服务器组"
//   - "非活动目录" → "成员服务器"
//   - "用户" → "用户管理"
//   - "角色" → "角色管理"
//   - "包管理" moved 权限与账号 → 监控与诊断
//   - "审计日志" → "系统运维日志" (moved to 运维日志)
//   - "操作日志" / "事件与日志" → "心跳与状态执行日志" (moved to 运维日志)
//   - DELETED "Schema 与清理" (orphan-schemas)
//
// R53 new routes (placeholder views, mock-first):
//   /admin/ad-file-push         (AD 域控 文件推送)
//   /admin/member-file-push     (成员服务器 文件推送)
//   /admin/member-command-exec  (成员服务器 执行命令)
const EXPECTED_PATHS = [
  // 监控与诊断 (4)
  '/admin/site-replication-matrix/all',
  '/admin/replication-log/monitor',
  '/admin/heartbeat-report',
  '/admin/packages',
  // AD 活动目录服务器 (4)
  '/admin/sites-catalog',
  '/admin/dcs-catalog',
  '/admin/ports',
  '/admin/ad-file-push',
  // 成员服务器管理 (4)
  '/admin/server-groups',
  '/admin/member-servers',
  '/admin/member-file-push',
  '/admin/member-command-exec',
  // 权限和账户 (2)
  '/admin/users',
  '/admin/roles',
  // 运维日志 (2)
  '/admin/audit',
  '/admin/operations-log',
  // 系统设置 (3) — orphans: not in operator's spec but kept for accessibility
  '/admin/migrations',
  '/admin/config',
  '/admin/email-config'
];

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dataset.theme = '';
  setActivePinia(createPinia());
  vi.resetModules();
});

test('R53: renders 6 top-level groups in operator-specified order', () => {
  const w = mountLayout();
  const groupTitles = w.findAll('.nav-group-title .label').map(t => t.text());
  expect(groupTitles).toEqual([
    '监控与诊断',
    'AD 活动目录服务器',
    '成员服务器管理',
    '权限和账户',
    '运维日志',
    '系统设置'
  ]);
  expect(w.findAll('.nav-group').length).toBe(6);
});

test('R53: emoji icons match group titles', () => {
  const w = mountLayout();
  const icons = w.findAll('.nav-group-title .icon').map(t => t.text());
  expect(icons).toEqual(['📊', '🛡️', '💻', '👥', '📋', '🛠️']);
});

test('R53: 监控与诊断 contains 4 items in operator order', () => {
  const w = mountLayout();
  const monitorGroup = w.findAll('.nav-group')[0];
  const links = monitorGroup.findAll('a.nav-link').map(a => a.attributes('href'));
  expect(links).toEqual([
    '/admin/site-replication-matrix/all',
    '/admin/replication-log/monitor',
    '/admin/heartbeat-report',
    '/admin/packages'
  ]);
  // Verify label renames from R52 → R53
  const labels = monitorGroup.findAll('a.nav-link').map(a => a.text());
  expect(labels).toEqual([
    '复制状态概览',
    '复制伙伴端口监控',     // was 复制伙伴端口健康监控
    '心跳与状态报告',        // was 心跳与告警
    '包管理'
  ]);
});

test('R53: AD 活动目录服务器 contains 4 items in operator order (站点清单设置, 域控清单设置, 域控检查端口, 文件推送功能)', () => {
  const w = mountLayout();
  const adGroup = w.findAll('.nav-group')[1];
  const labels = adGroup.findAll('a.nav-link').map(a => a.text());
  expect(labels).toEqual([
    'AD 站点清单设置',
    'AD 域控清单设置',
    'AD 域控检查端口',
    '文件推送功能'
  ]);
});

test('R53: 成员服务器管理 contains 4 items (组, 服务器, 文件推送, 执行命令)', () => {
  const w = mountLayout();
  const memberGroup = w.findAll('.nav-group')[2];
  const labels = memberGroup.findAll('a.nav-link').map(a => a.text());
  expect(labels).toEqual([
    '成员服务器组',
    '成员服务器',
    '成员服务器文件推送',
    '成员服务器执行命令'
  ]);
});

test('R53: 权限和账户 contains only 用户管理 + 角色管理 (no 包管理 — moved to 监控与诊断)', () => {
  const w = mountLayout();
  const iamGroup = w.findAll('.nav-group')[3];
  const labels = iamGroup.findAll('a.nav-link').map(a => a.text());
  expect(labels).toEqual(['用户管理', '角色管理']);
});

test('R53: 运维日志 contains 系统运维日志 + 心跳与状态执行日志', () => {
  const w = mountLayout();
  const logGroup = w.findAll('.nav-group')[4];
  const labels = logGroup.findAll('a.nav-link').map(a => a.text());
  expect(labels).toEqual(['系统运维日志', '心跳与状态执行日志']);
});

test('R53: 系统设置 contains orphans (版本升级 / 系统配置 / 邮件配置)', () => {
  const w = mountLayout();
  const sysGroup = w.findAll('.nav-group')[5];
  const links = sysGroup.findAll('a.nav-link').map(a => a.attributes('href'));
  expect(links).toEqual([
    '/admin/migrations',
    '/admin/config',
    '/admin/email-config'
  ]);
});

test('R53: Schema 与清理 DELETED (no /admin/orphan-schemas in any nav-link)', () => {
  const w = mountLayout();
  const allLinks = w.findAll('a.nav-link').map(a => a.attributes('href'));
  expect(allLinks).not.toContain('/admin/orphan-schemas');
});

test('R53: total 19 nav-links in operator-specified order', () => {
  const w = mountLayout();
  const allLinks = w.findAll('a.nav-link').map(a => a.attributes('href'));
  expect(allLinks.length).toBe(19);
  expect(allLinks).toEqual(EXPECTED_PATHS);
});

test('all top-level groups open by default', () => {
  const w = mountLayout();
  const details = w.findAll('details.nav-group');
  expect(details.length).toBe(6);
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

test('R53: sidebar collapse toggle is in topbar (always accessible)', () => {
  const w = mountLayout();
  const toggle = w.find('.sidebar-toggle');
  expect(toggle.exists()).toBe(true);
});

test('R53: clicking sidebar toggle flips sidebar-collapsed class on .layout', async () => {
  const w = mountLayout();
  expect(w.find('.layout').classes()).not.toContain('sidebar-collapsed');
  await w.find('.sidebar-toggle').trigger('click');
  await nextTick();
  expect(w.find('.layout').classes()).toContain('sidebar-collapsed');
  await w.find('.sidebar-toggle').trigger('click');
  await nextTick();
  expect(w.find('.layout').classes()).not.toContain('sidebar-collapsed');
});

test('R53: sidebar collapse state persists in localStorage', async () => {
  const w = mountLayout();
  expect(localStorage.getItem('admin-sidebar-visible')).toBeNull();
  await w.find('.sidebar-toggle').trigger('click');
  await nextTick();
  expect(localStorage.getItem('admin-sidebar-visible')).toBe('false');
  await w.find('.sidebar-toggle').trigger('click');
  await nextTick();
  expect(localStorage.getItem('admin-sidebar-visible')).toBe('true');
});

test('R53: sidebar collapsed on mount when localStorage says false', async () => {
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