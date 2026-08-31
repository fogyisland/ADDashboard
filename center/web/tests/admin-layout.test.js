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
//   监控与诊断 (5):  复制状态概览 / 站点矩阵 / 复制伙伴端口监控 / 心跳与状态报告 / 包管理
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
//
// 2026-08-29 R64: 复制状态概览 restored to R49 ops-console per-DC tables
// at /admin/site-replication-matrix/all. /matrix mounts SiteMatrixView
// (R60 N×N matrix) — both pages share the same payload, different lens.
//
// 2026-08-29 R64.1: operator directive "站点矩阵 只在前台展现,后台不需要".
// /matrix removed from AdminLayout sidebar. The page still exists in
// AppLayout (frontend) for operators — admin sidebar goes back to
// 4 items in 监控与诊断 (was 5 with 站点矩阵).
//
// 2026-08-28 round-54 visual hierarchy (operator: 一级分类和二级子菜单左对齐齐平):
//   - .nav-group-title = Group Header: 11px / uppercase / letter-spacing 0.06em
//     / color var(--muted) / justify-content: space-between + right-aligned caret
//   - .nav-group-items = container with ml-4 + pl-4 + 1px left border rail
//   - .nav-link = level-2: 13px / padding 7px 10px / margin-left: -1px to sit
//     flush on the rail / 2px transparent border-left (active swaps to blue)
//   - .nav-link.router-link-active = bg-blue-400/14 + text-blue-400 + 2px blue
//     border-left accent + font-weight 600
//   - .nav-link:hover = bg var(--border) + color var(--accent)
const EXPECTED_PATHS = [
  // 监控与诊断 (5 — R74 adds 复制错误 between 复制状态概览 and 复制伙伴端口监控)
  '/admin/site-replication-matrix/all',
  '/admin/replication-errors',
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
  // R75: 运维 (2) — AD 用户管理 + AD 组管理
  '/admin/ad-users',
  '/admin/ad-groups',
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

test('R53: renders 7 top-level groups in operator-specified order (R75 adds 运维)', () => {
  const w = mountLayout();
  const groupTitles = w.findAll('.nav-group-title .label').map(t => t.text());
  expect(groupTitles).toEqual([
    '监控与诊断',
    'AD 活动目录服务器',
    '成员服务器管理',
    '权限和账户',
    '运维',
    '运维日志',
    '系统设置'
  ]);
  expect(w.findAll('.nav-group').length).toBe(7);
});

test('R53: emoji icons match group titles (R75 adds ⚙️ for 运维)', () => {
  const w = mountLayout();
  const icons = w.findAll('.nav-group-title .icon').map(t => t.text());
  expect(icons).toEqual(['📊', '🛡️', '💻', '👥', '⚙️', '📋', '🛠️']);
});

test('R53: 监控与诊断 contains 5 items in operator order (R74 adds 复制错误, R64.1 drops 站点矩阵)', () => {
  const w = mountLayout();
  const monitorGroup = w.findAll('.nav-group')[0];
  const links = monitorGroup.findAll('a.nav-link').map(a => a.attributes('href'));
  expect(links).toEqual([
    '/admin/site-replication-matrix/all',
    '/admin/replication-errors',
    '/admin/replication-log/monitor',
    '/admin/heartbeat-report',
    '/admin/packages'
  ]);
  // Verify label renames from R52 → R53 + R64 + R64.1 + R74
  const labels = monitorGroup.findAll('a.nav-link').map(a => a.text());
  expect(labels).toEqual([
    '复制状态概览',
    '复制错误',              // R74 — focused triage view for failed replication
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

test('R75: 运维 contains AD 用户管理 + AD 组管理 (between 权限和账户 and 运维日志)', () => {
  const w = mountLayout();
  const opsGroup = w.findAll('.nav-group')[4];
  const labels = opsGroup.findAll('a.nav-link').map(a => a.text());
  expect(labels).toEqual(['AD 用户管理', 'AD 组管理']);
});

test('R53: 运维日志 contains 系统运维日志 + 心跳与状态执行日志', () => {
  const w = mountLayout();
  const logGroup = w.findAll('.nav-group')[5];
  const labels = logGroup.findAll('a.nav-link').map(a => a.text());
  expect(labels).toEqual(['系统运维日志', '心跳与状态执行日志']);
});

test('R53: 系统设置 contains orphans (版本升级 / 系统配置 / 邮件配置)', () => {
  const w = mountLayout();
  const sysGroup = w.findAll('.nav-group')[6];
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

test('R75: total 22 nav-links in operator-specified order (R75 adds 2 AD ops links; R74 adds 复制错误)', () => {
  const w = mountLayout();
  const allLinks = w.findAll('a.nav-link').map(a => a.attributes('href'));
  expect(allLinks.length).toBe(22);
  expect(allLinks).toEqual(EXPECTED_PATHS);
});

test('all top-level groups open by default (7 groups after R75)', () => {
  const w = mountLayout();
  const details = w.findAll('details.nav-group');
  expect(details.length).toBe(7);
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

// ===== 2026-08-28 round-54: visual hierarchy tests =====
// Operator directive: 一级分类和二级子菜单左对齐齐平,字体大小颜色几乎没有区分
// 老大哥 Tailwind 参考: Group Header (small/dim/uppercase/right-caret) +
// ml-4/pl-4 indent + border-left rail + active 2px blue accent + bg-blue/10
//
// jsdom + vitest + @vitejs/plugin-vue does not inject <style scoped> into
// the document, so getComputedStyle() / style.cssText assertions are
// unreliable. We verify CSS by reading the source SFC file directly and
// asserting the rules we wrote are present. Visual rendering is verified
// by build + browser smoke after the operator restarts NSSM.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const adminLayoutPath = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '../src/components/AdminLayout.vue');
const adminLayoutSrc = readFileSync(adminLayoutPath, 'utf8');

test('R54: each group title contains caret + title-main wrapper (right-aligned caret, 7 groups)', () => {
  const w = mountLayout();
  const titles = w.findAll('.nav-group-title');
  expect(titles.length).toBe(7);
  for (const t of titles) {
    expect(t.find('.nav-group-title-main').exists()).toBe(true);
    expect(t.find('.nav-group-title-main .icon').exists()).toBe(true);
    expect(t.find('.nav-group-title-main .label').exists()).toBe(true);
    expect(t.find('.nav-group-caret').exists()).toBe(true);
    expect(t.find('.nav-group-caret').text()).toBe('▼');
  }
});

test('R54: nav-links sit inside a .nav-group-items wrapper (provides left rail, 7 wrappers, 22 links)', () => {
  const w = mountLayout();
  const itemsContainers = w.findAll('.nav-group-items');
  expect(itemsContainers.length).toBe(7);
  // All 22 nav-links live inside these containers — none loose at nav level
  // (R75 adds 2 AD ops links + R74 adds 复制错误 — 22 total, was 19 in R64.1)
  const linksInsideItems = itemsContainers.reduce((acc, c) => acc + c.findAll('a.nav-link').length, 0);
  expect(linksInsideItems).toBe(22);
});

test('R54: source CSS defines caret rotation rule (.nav-group:not([open]) > .nav-group-title .nav-group-caret)', () => {
  expect(adminLayoutSrc).toMatch(/\.nav-group:not\(\[open\]\)\s*>\s*\.nav-group-title\s+\.nav-group-caret/);
  expect(adminLayoutSrc).toMatch(/rotate\(-90deg\)/);
});

test('R54: source CSS defines active state — 2px blue border-left + bg-blue-400/14 + text-blue-400', () => {
  expect(adminLayoutSrc).toMatch(/\.nav-link\.router-link-active/);
  expect(adminLayoutSrc).toMatch(/border-left-color:\s*#3b82f6/);
  expect(adminLayoutSrc).toMatch(/rgba\(96,\s*165,\s*250/);  // bg-blue-400/14
  expect(adminLayoutSrc).toMatch(/color:\s*#60a5fa/);        // text-blue-400
});

test('R54: source CSS defines .nav-group-items with 1px left rail + ml-4 indent', () => {
  expect(adminLayoutSrc).toMatch(/\.nav-group-items\s*\{/);
  expect(adminLayoutSrc).toMatch(/border-left:\s*1px\s+solid/);
  expect(adminLayoutSrc).toMatch(/margin-left:\s*14px/);  // ≈ ml-4
});

test('R54: source CSS defines group title as Group Header (uppercase + 11px + muted color)', () => {
  // Match within a single .nav-group-title { ... } block — allow newlines
  const titleBlock = adminLayoutSrc.match(/\.nav-group-title\s*\{([^}]*)\}/);
  expect(titleBlock).not.toBeNull();
  const body = titleBlock[1];
  expect(body).toMatch(/text-transform:\s*uppercase/);
  expect(body).toMatch(/font-size:\s*11px/);
  expect(body).toMatch(/color:\s*var\(--muted\)/);
});