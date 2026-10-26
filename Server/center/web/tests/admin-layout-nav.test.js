// R161.13 (2026-10-27) — 后台管理侧边栏 (AdminLayout) 组件测试。
//
// ★ 这个套件补的是**被 R161 清理删掉的那张网**:
//   2026-10-25 的"清除测试与 debug 文件"把 R53/R54/R75 那批锁 sidebar
//   label/path/顺序 的测试一起搬进了隔离区, 从此后台侧边栏**零覆盖** ——
//   而它恰恰是操作员天天点的那个界面 (改一个 label 少一个入口都没人拦)。
//   ⇒ 这里把那张网重新织起来, 用**渲染后的 DOM** 断言, 而不是读源码字符串
//     (读字符串测的是"源码里写了什么", 测不到"页面长什么样")。
//
// ★ 覆盖两块:
//   A. 形状 —— 8 个分组的标题/顺序, 每个分组里的条目 label → path。
//      (R53/R54/R75 的原意, 一比一恢复)
//   B. 折叠行为 —— 操作员 directive「后台管理菜单，折叠了之后，刷新后不要再
//      展开。以免总是要点开，默认折叠」(R161.11)。
//      折叠状态存在 localStorage 'admin-nav-groups-open', 真源是响应式的
//      groupOpenMap, 模板 `:open` 读它 —— 所以"刷新后仍然折叠"这条必须
//      在**真实挂载 + 真实 remount** 下验证, 光测函数测不出来。
//
// ★ jsdom 的一个坑 (必须绕开, 否则测出来的是假的):
//   jsdom **不派发 `<details>` 的 `toggle` 事件** —— 设 `.open = true` 不触发,
//   点 summary 也不触发 (只翻 open 属性)。真实浏览器里是浏览器自动派发的。
//   ⇒ 测试里必须**手工** dispatch 一个 toggle 事件, 而且 dispatch 的目标
//     必须是 details 元素本身 —— 组件的处理器读的是 `event.target.open`,
//     事件派发到谁, target 就是谁 (跟浏览器一致)。
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import AdminLayout from '../src/components/AdminLayout.vue';

// 期望的侧边栏形状 (R53/R54/R75 的原意, R161.11 加了「时区设置」一条)。
// [分组标题, [[条目 label, 条目 path], ...]]
const EXPECTED_GROUPS = [
  ['监控与诊断', [
    ['复制状态概览', '/admin/site-replication-matrix/all'],
    ['复制错误', '/admin/replication-errors'],
    ['心跳与状态报告', '/admin/heartbeat-report'],
    ['包管理', '/admin/packages'],
    ['包执行计划', '/admin/packages-schedule'],
    ['复制伙伴发现入站', '/admin/partner-discover/inbound']
  ]],
  ['AD 活动目录服务器', [
    ['AD 站点清单设置', '/admin/sites-catalog'],
    ['AD 域控清单设置', '/admin/dcs-catalog'],
    ['AD 域控检查端口', '/admin/ports'],
    ['文件推送功能', '/admin/ad-file-push']
  ]],
  ['成员服务器管理', [
    ['成员服务器组', '/admin/server-groups'],
    ['成员服务器', '/admin/member-servers'],
    ['成员服务器文件推送', '/admin/member-file-push'],
    ['成员服务器执行命令', '/admin/member-command-exec'],
    ['下线管理', '/admin/server-lifecycle']
  ]],
  ['权限和账户', [
    ['用户管理', '/admin/users'],
    ['角色管理', '/admin/roles']
  ]],
  ['运维', [
    ['AD 信息同步', '/admin/directory-sync'],
    ['域和森林注册', '/admin/forest-registry']
  ]],
  ['运维日志', [
    ['系统运维日志', '/admin/audit'],
    ['心跳与状态执行日志', '/admin/operations-log'],
    ['AD 管理日志', '/admin/ad-management-log'],
    ['MCP 执行和操作日志', '/admin/mcp-operation-log']
  ]],
  ['系统设置', [
    ['版本升级', '/admin/migrations'],
    ['系统配置', '/admin/config'],
    ['邮件配置', '/admin/email-config'],
    ['MCP 集成', '/admin/mcp-token'],
    ['功能开关', '/admin/system-settings/feature-flags'],
    ['License 管理', '/admin/system-settings/license'],
    // R161.11 — 操作员 directive「是否能够在系统设置中增加一个时区的菜单」。
    ['时区设置', '/admin/timezone']
  ]],
  ['报表中心', [
    ['总览', '/report-center'],
    ['锁定账户', '/report-center/lockout-events'],
    ['密码错误', '/report-center/failed-logon-events'],
    ['账户变更', '/report-center/account-change-events']
  ]]
];

const NAV_GROUPS_OPEN_KEY = 'admin-nav-groups-open';

// 挂载一份后台布局。router 用 catch-all 路由 —— 侧边栏的每个条目都是
// router-link, 真实 router 才能把它们渲染成 <a href>, 而 href 才是操作员
// 点得到的东西 (组件测试要验的是"页面长什么样", 不是"源码写了什么")。
async function mountAdmin() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }]
  });
  const wrapper = mount(AdminLayout, {
    global: { plugins: [pinia, router] }
  });
  // onMounted 里才读 localStorage (loadGroupOpenMap) —— 读完之后是响应式
  // 更新, 必须让出一个 tick 才能看到最终的 DOM。
  await nextTick();
  return wrapper;
}

// 模拟浏览器里"用户点 summary"之后浏览器自动派发的 toggle 事件。
// jsdom 不派发 ⇒ 必须手工来 (见文件头注释)。
async function toggleGroup(wrapper, index, open) {
  const details = wrapper.findAll('details.nav-group')[index];
  expect(details, '目标分组必须存在').toBeTruthy();
  details.element.open = open;
  await details.trigger('toggle');
  await nextTick();
  return details;
}

// 从渲染结果里把 [标题, [[label, path], ...]] 抠出来。
function readRenderedShape(wrapper) {
  const detailsList = wrapper.findAll('details.nav-group');
  return detailsList.map((details) => {
    const title = details.find('.nav-group-title .label').text();
    const links = details.findAll('a.nav-link');
    return [title, links.map((a) => [a.text(), a.attributes('href')])];
  });
}

describe('A. 后台侧边栏形状 (R53/R54/R75 的网, R161 清理时丢过, 这里补回)', () => {
  it('分组的标题与顺序跟约定一致', async () => {
    const wrapper = await mountAdmin();
    const titles = readRenderedShape(wrapper).map(([title]) => title);
    expect(titles).toEqual(EXPECTED_GROUPS.map(([title]) => title));
    wrapper.unmount();
  });

  it('每个分组里的条目 label → path 跟约定一致', async () => {
    const wrapper = await mountAdmin();
    const shape = readRenderedShape(wrapper);
    // 逐组比对 (而不是整体 flatten): 出错时能直接指出是**哪个分组**坏了。
    for (const [title, expectedItems] of EXPECTED_GROUPS) {
      const actual = shape.find(([t]) => t === title);
      expect(actual, `分组「${title}」必须存在`).toBeTruthy();
      expect(actual[1], `分组「${title}」的条目`).toEqual(expectedItems);
    }
    wrapper.unmount();
  });

  it('分组计数徽标跟该组实际渲染出来的条目数一致 (口径不能分裂)', async () => {
    const wrapper = await mountAdmin();
    const detailsList = wrapper.findAll('details.nav-group');
    expect(detailsList.length).toBeGreaterThan(0);
    for (const details of detailsList) {
      const title = details.find('.nav-group-title .label').text();
      const badge = details.find('.nav-group-title-meta').text();
      const itemCount = details.findAll('a.nav-link').length;
      expect(badge, `分组「${title}」的计数徽标`).toBe(String(itemCount));
    }
    wrapper.unmount();
  });

  it('「时区设置」入口在「系统设置」组里, 指向 /admin/timezone', async () => {
    const wrapper = await mountAdmin();
    const link = wrapper.findAll('a.nav-link').find((a) => a.text() === '时区设置');
    expect(link, '「时区设置」入口必须存在').toBeTruthy();
    expect(link.attributes('href')).toBe('/admin/timezone');
    wrapper.unmount();
  });
});

describe('B. 菜单分组默认折叠 + 折叠状态跨刷新保持 (R161.11 操作员 directive)', () => {
  it('首次进入后台时所有分组都是折叠的 (默认折叠)', async () => {
    const wrapper = await mountAdmin();
    const detailsList = wrapper.findAll('details.nav-group');
    expect(detailsList.length).toBe(EXPECTED_GROUPS.length);
    for (const details of detailsList) {
      const title = details.find('.nav-group-title .label').text();
      expect(details.attributes('open'), `分组「${title}」默认必须是折叠的`).toBeUndefined();
    }
    wrapper.unmount();
  });

  it('展开一个分组会写进 localStorage (真源是响应式 map, 不是 DOM 的 open 属性)', async () => {
    const wrapper = await mountAdmin();
    await toggleGroup(wrapper, 0, true);

    const raw = localStorage.getItem(NAV_GROUPS_OPEN_KEY);
    expect(raw, '折叠状态必须落盘, 否则刷新即丢').toBeTruthy();
    const saved = JSON.parse(raw);
    expect(saved['监控与诊断']).toBe(true);
    wrapper.unmount();
  });

  it('刷新后 (重新挂载) 保持操作员折叠过的状态, 没动过的仍然折叠', async () => {
    const first = await mountAdmin();
    await toggleGroup(first, 0, true);          // 操作员展开了第 1 组
    await toggleGroup(first, 3, true);          // 又展开了第 4 组
    first.unmount();

    // 模拟刷新: 新组件实例, 同一个 localStorage。
    const second = await mountAdmin();
    const detailsList = second.findAll('details.nav-group');
    const opened = detailsList
      .map((d) => [d.find('.nav-group-title .label').text(), d.attributes('open') !== undefined])
      .filter(([, isOpen]) => isOpen)
      .map(([title]) => title);

    expect(opened).toEqual(['监控与诊断', '权限和账户']);
    // 没被操作过的分组必须是折叠的 (默认折叠, 不因为"别的组开过"而展开)。
    const untouched = detailsList.filter((d) => {
      const title = d.find('.nav-group-title .label').text();
      return title !== '监控与诊断' && title !== '权限和账户';
    });
    for (const details of untouched) {
      const title = details.find('.nav-group-title .label').text();
      expect(details.attributes('open'), `分组「${title}」不该被顺带展开`).toBeUndefined();
    }
    second.unmount();
  });

  it('把展开过的分组再折叠, 状态同样落盘 (关掉也刷不掉)', async () => {
    const wrapper = await mountAdmin();
    await toggleGroup(wrapper, 0, true);
    await toggleGroup(wrapper, 0, false);

    const saved = JSON.parse(localStorage.getItem(NAV_GROUPS_OPEN_KEY) || '{}');
    expect(saved['监控与诊断']).toBe(false);
    expect(wrapper.findAll('details.nav-group')[0].attributes('open')).toBeUndefined();
    wrapper.unmount();
  });

  it('localStorage 里是脏数据时不影响渲染 (回落默认折叠, 不抛错)', async () => {
    localStorage.setItem(NAV_GROUPS_OPEN_KEY, '{ this is not json');
    const wrapper = await mountAdmin();
    const detailsList = wrapper.findAll('details.nav-group');
    expect(detailsList.length).toBe(EXPECTED_GROUPS.length);
    for (const details of detailsList) {
      expect(details.attributes('open')).toBeUndefined();
    }
    wrapper.unmount();
  });
});
