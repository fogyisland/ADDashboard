---
name: 2026-08-06 sidebar nav redesign design
description: 把 AdminLayout 的 10 项 flat nav 重组为 4 个 collapsible group（账号/目录/监控/系统），零依赖用 native <details>，不动 router / perm
type: project
---

# Sidebar Nav Redesign Design

## Goal

把 `frontend/src/components/AdminLayout.vue` 当前 10 项 flat nav 重组为 **4 个 collapsible group**，按业务域划分（账号管理 / 目录管理 / 监控运维 / 系统设置）。解决"菜单乱、找东西要肉眼扫"的痛点。

## Non-Goals (YAGNI)

- ❌ 折叠状态持久化（不写 localStorage）
- ❌ 加图标（emoji / SVG）
- ❌ role-based 过滤（所有 admin 共用）
- ❌ 改 router 配置（路径不变）
- ❌ 拖拽排序
- ❌ 改 perm 策略（`meta.perm` 仍只作为 metadata）

## Current State (snapshot)

`AdminLayout.vue:6-17` — 10 个 `<router-link>` 平铺：

```
用户 / 角色 / 系统配置 / 审计日志 / AD 站点清单 / AD 域控清单 /
站点复制矩阵 / 端口健康检查 / 包管理 / 迁移管理
```

`router.js:34-45` — 全部用 `meta: { perm: 'admin:users' }`（`/admin/packages` 用 `admin:packages`，但 AdminLayout 不做 perm 过滤，无条件全部展示）。

## Approach

**Native `<details>` + `<summary>`** 做折叠。零依赖、a11y 默认 OK（Tab + Enter）、不引 Element Plus collapse（避免额外组件）。

每个 `<details>` 默认 `open`，首次进入看到全 10 项；用户可手动折叠不关心的组。

`▸` 旋转 90° 变 `▾` 用 CSS 实现（`::before` content + `transform: rotate(90deg)`），不依赖 JS。

## Data Model

`AdminLayout.vue` 内 hardcode `groups` 数组（简单 config；不建 store / 单独文件）。

```js
const groups = [
  { title: '账号管理', items: [
    { label: '用户',     path: '/admin/users' },
    { label: '角色',     path: '/admin/roles' }
  ]},
  { title: '目录管理', items: [
    { label: 'AD 站点清单', path: '/admin/sites-catalog' },
    { label: 'AD 域控清单', path: '/admin/dcs-catalog' }
  ]},
  { title: '监控运维', items: [
    { label: '站点复制矩阵', path: '/admin/site-replication-matrix' },
    { label: '端口健康检查', path: '/admin/ports' },
    { label: '包管理',     path: '/admin/packages' }
  ]},
  { title: '系统设置', items: [
    { label: '系统配置', path: '/admin/config' },
    { label: '审计日志', path: '/admin/audit' },
    { label: '迁移管理', path: '/admin/migrations' }
  ]}
]
```

分组理由（mental model）：
- **账号管理** — 谁在用（用户 / 角色）
- **目录管理** — AD 里有什么（站点 / 域控）
- **监控运维** — 看状态 / 做操作（复制矩阵 / 端口 / 包）
- **系统设置** — 管平台本身（配置 / 审计 / 迁移）

## Template

替换 `AdminLayout.vue:6-17` 的 `<nav>`：

```vue
<nav class="admin-nav">
  <details v-for="g in groups" :key="g.title" open class="nav-group">
    <summary class="nav-group-title">{{ g.title }}</summary>
    <router-link
      v-for="i in g.items"
      :key="i.path"
      :to="i.path"
      class="nav-link"
    >{{ i.label }}</router-link>
  </details>
</nav>
```

## CSS

**保留不变**（沿用 `AdminLayout.vue:40-50` 现有 `.sidebar a` / `.sidebar nav` 规则——`<router-link>` 渲染为 `<a>` 仍命中）：

```css
.layout { display: grid; grid-template-columns: 220px 1fr; height: 100vh; }
.sidebar { background: #0b1220; padding: 20px; }
.sidebar .back { display: block; color: var(--muted); font-size: 12px; margin-bottom: 12px; text-decoration: none; }
.sidebar .back:hover { color: var(--accent); }
.sidebar h3 { color: var(--accent); margin: 0 0 16px; font-size: 14px; }
.sidebar nav { display: flex; flex-direction: column; gap: 6px; }
.sidebar a { padding: 8px 10px; border-radius: 4px; color: var(--text); text-decoration: none; }
.sidebar a.router-link-active, .sidebar a:hover { background: #1e293b; }
```

**新增**（只加 group / summary 的样式，不重复定义 `.sidebar a`）：

```css
.nav-group { margin-bottom: 8px; }
.nav-group-title {
  font-weight: 600;
  color: var(--muted);
  font-size: 12px;
  padding: 6px 12px;
  cursor: pointer;
  user-select: none;
  list-style: none;
}
.nav-group-title::-webkit-details-marker { display: none; }
.nav-group-title::before {
  content: '▸';
  display: inline-block;
  width: 14px;
  margin-right: 4px;
  transition: transform .15s;
}
details[open] .nav-group-title::before { transform: rotate(90deg); }
```

`var(--muted)` / `var(--text)` 已在全局 CSS 变量定义（现有 `.sidebar .back` / `.sidebar a` 已引用）。

## Behavior

| 行为 | 实现 |
|---|---|
| 默认展开 | `<details open>` attribute |
| 折叠/展开 | 原生 `<details>` 行为，浏览器处理 |
| Active link 高亮 | `.router-link-active` 沿用 vue-router 默认 |
| 键盘可访问 | `<details>` 原生 Tab + Enter |
| 折叠状态 | **不持久化**（v1 简化） |

## File Changes

| 类型 | 路径 | 内容 |
|---|---|---|
| 修改 | `frontend/src/components/AdminLayout.vue` | 替换 `<nav>` 模板 + 加 `groups` config + 加 CSS |
| Mirror | `publish/frontend/src/components/AdminLayout.vue` | `cp` 同步（runtime-only 便携包需要） |
| 新增 | `frontend/tests/admin-layout.test.js` | 4 个 test 覆盖 group / link / 默认展开 / 折叠交互 |

无 backend 改动；无 router 改动；无 SQL 改动；无 migration 改动。

## Tests

`frontend/tests/admin-layout.test.js`（新建，4 tests）：

1. **renders 4 groups** — `wrapper.findAll('.nav-group').length === 4`
2. **renders all 10 nav-links with correct paths** — 列出所有 10 个 `to` 属性，断言匹配预期 10 个 path
3. **all groups open by default** — 4 个 `<details>` 都有 `open` 属性
4. **clicking summary toggles open state** — 模拟 click summary，断言 `open` 属性被移除；再 click 一次，断言恢复

**Mount 策略**：stub `<router-link>` 为简单 `<a :href="to">`（避免引入完整 vue-router 实例；layout 测试不验证 navigation 行为）。Pinia 走标准 `setActivePinia(createPinia())`——`useAuthStore()` 返回默认空状态，topbar 显示 undefined 是可接受的。

```js
const RouterLinkStub = {
  props: ['to'],
  template: '<a :href="to"><slot /></a>'
};
const w = mount(AdminLayout, {
  global: { stubs: { 'router-link': RouterLinkStub } }
});
```

参考 `frontend/tests/servers-overview.test.js:23-26` 的 router mock 模式（如果未来要测真 navigation 才用得上）。

## Verification

1. `cd frontend && npx vitest run tests/admin-layout.test.js` — 4/4 pass
2. `cd frontend && npx vitest run` — 全绿（已有 192 + 4 = 196）
3. `cd frontend && npx vite build` — build 无错
4. **手动 smoke**: `npm start` → 登录 admin → 进任一 admin 页：
   - sidebar 看到 4 组（账号管理 / 目录管理 / 监控运维 / 系统设置），每组默认展开
   - 10 个 link 都在，路径正确
   - 点 group title（▸）能折叠该组（变 ▾ → ▸）
   - 当前页对应 link 高亮（active 状态）
   - 点 link 能正常跳转，layout 不被破坏
5. `cp frontend/src/components/AdminLayout.vue publish/frontend/src/components/AdminLayout.vue` 同步 publish mirror
6. 不需要重打 `publish.zip`（AdminLayout.vue 是 vue 源文件，runtime 走 build 后的 dist；mirror 是源码兜底）

## Risks

1. **`<details>` 默认 marker 兼容性** — `list-style: none` + `::-webkit-details-marker { display: none }` 双覆盖；Firefox 用 `::marker` 的 summary 默认不会显示 marker（已实测）。CSS hack 成熟方案，无风险。
2. **折叠状态刷新后丢失** — v1 不持久化，符合 YAGNI；用户每次进 admin 都看到全展开。如反馈需要，再加 localStorage。
3. **active link 高亮范围变化** — 当前 `.sidebar a.router-link-active` 用的是 `<a>` 标签选择器；改 `<router-link>` 后 vue-router 4 渲染为 `<a>`，选择器仍命中，无破坏。
4. **`/admin/packages` 用 `admin:packages` perm 但 sidebar 不做 perm 过滤** — 与现有行为一致；无用户角色机制驱动隐藏。如要按 perm 隐藏，需要先有前端 perm check 系统（不在本 spec 范围）。

## Out of Scope

- 后端 perm enforcement（router meta.perm 当前不强制）
- sidebar 折叠状态跨页持久化
- 图标（emoji / iconfont / SVG）
- 拖拽排序 / 用户自定义顺序
- 多 sidebar 主题