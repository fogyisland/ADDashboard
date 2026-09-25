# Sidebar Nav Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize `AdminLayout.vue`'s 10-item flat sidebar nav into 4 collapsible business-domain groups (账号管理 / 目录管理 / 监控运维 / 系统设置) using native `<details>`/`<summary>`.

**Architecture:** Single-component change. Replace the `<nav>` block with a `v-for` over a hardcoded `groups` config. Add minimal CSS for group titles and disclosure markers (existing `.sidebar a` rules are reused for the actual links). No backend, no router, no perm changes.

**Tech Stack:** Vue 3.5 (script setup), vue-router 4.4 (only as stub for `<router-link>` in tests), Pinia 2.2, vitest 2.1, @vue/test-utils 2.4, jsdom 25.

## Global Constraints

- **Spec source:** `docs/superpowers/specs/2026-08-06-sidebar-nav-redesign-design.md` (commit 3ede23d)
- **Grouping (exact):** 账号管理 = [用户, 角色]; 目录管理 = [AD 站点清单, AD 域控清单]; 监控运维 = [站点复制矩阵, 端口健康检查, 包管理]; 系统设置 = [系统配置, 审计日志, 迁移管理]
- **Paths (exact, from `frontend/src/router.js:34-45`):**
  - 账号管理: `/admin/users`, `/admin/roles`
  - 目录管理: `/admin/sites-catalog`, `/admin/dcs-catalog`
  - 监控运维: `/admin/site-replication-matrix` (NOT `/topology`), `/admin/ports`, `/admin/packages`
  - 系统设置: `/admin/config`, `/admin/audit`, `/admin/migrations`
- **Implementation:** native `<details>` + `<summary>` with default `open`; `▸` rotated 90° via `details[open] .nav-group-title::before { transform: rotate(90deg) }`. Zero new npm deps.
- **CSS:** only ADD `.nav-group` / `.nav-group-title` / `::before` rules; do NOT redefine `.sidebar a` (reuse existing).
- **Mirror required:** `publish/frontend/src/components/AdminLayout.vue` via `cp` (runtime-only 便携包 needs the source). Do NOT regenerate `publish.zip` (runtime 走 build 后的 dist).
- **No router changes.** No perm changes. No backend. No SQL. No migrations.
- **Tests:** 4 new tests in `frontend/tests/admin-layout.test.js` — cover group count, all 10 paths, default `open`, summary-click toggle.
- **Verify:** all 4 new tests pass + existing 192 frontend tests stay green + `npx vite build` succeeds.

---

### Task 1: Write failing tests (RED)

**Files:**
- Create: `frontend/tests/admin-layout.test.js`

**Interfaces:**
- Consumes: `AdminLayout` (default export from `frontend/src/components/AdminLayout.vue`)
- Produces: 4 tests in vitest; mount strategy uses `router-link` stub (avoids full vue-router instance) and `setActivePinia(createPinia())` for the auth store dep

- [ ] **Step 1: Create the test file**

Write `frontend/tests/admin-layout.test.js` with this exact content:

```js
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
```

- [ ] **Step 2: Run the tests — verify all 4 fail**

Run: `cd frontend && npx vitest run tests/admin-layout.test.js`
Expected: All 4 tests FAIL. The first one will fail with something like "expected 4, got 0" (current AdminLayout has no `.nav-group` class — it renders 10 flat `<router-link>`s inside a single `<nav>`). Other tests fail similarly because the structure doesn't exist.

- [ ] **Step 3: Commit tests-only (RED marker)**

```bash
cd D:/ToolDevelop/ADDashboard
git add frontend/tests/admin-layout.test.js
git commit -m "test(frontend): add 4 failing tests for grouped admin sidebar nav"
```

---

### Task 2: Modify AdminLayout.vue (GREEN)

**Files:**
- Modify: `frontend/src/components/AdminLayout.vue` (lines 6-17 template, line 31-37 script setup, line 39-51 style)

**Interfaces:**
- Consumes: existing exports from `AdminLayout.vue` (default Vue SFC component)
- Produces: component renders 4 `<details class="nav-group">` with `<summary class="nav-group-title">` and nested `<router-link class="nav-link">` items; new `groups` const in script setup; new CSS rules

- [ ] **Step 1: Replace the `<nav>` template (lines 6-17)**

In `frontend/src/components/AdminLayout.vue`, replace:

```vue
      <nav>
        <router-link to="/admin/users">用户</router-link>
        <router-link to="/admin/roles">角色</router-link>
        <router-link to="/admin/config">系统配置</router-link>
        <router-link to="/admin/audit">审计日志</router-link>
        <router-link to="/admin/sites-catalog">AD 站点清单</router-link>
        <router-link to="/admin/dcs-catalog">AD 域控清单</router-link>
        <router-link to="/admin/site-replication-matrix">站点复制矩阵</router-link>
        <router-link to="/admin/ports">端口健康检查</router-link>
        <router-link to="/admin/packages">包管理</router-link>
        <router-link to="/admin/migrations">迁移管理</router-link>
      </nav>
```

with:

```vue
      <nav>
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

- [ ] **Step 2: Add `groups` const to `<script setup>`**

After the `const router = useRouter();` line in the script setup block, add:

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
];
```

The final script setup block reads:

```js
<script setup>
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
const auth = useAuthStore();
const router = useRouter();
function logout() { auth.logout(); router.push('/login'); }

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
];
</script>
```

- [ ] **Step 3: Add new CSS rules (do NOT touch existing `.sidebar a` rules)**

Append to the `<style scoped>` block (before the closing `</style>`):

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

Keep all existing `.layout`, `.sidebar`, `.sidebar .back`, `.sidebar h3`, `.sidebar nav`, `.sidebar a`, `.sidebar a.router-link-active`, `.sidebar a:hover`, `main`, `.topbar`, `.content` rules unchanged.

- [ ] **Step 4: Run admin-layout tests — verify all 4 pass**

Run: `cd frontend && npx vitest run tests/admin-layout.test.js`
Expected: All 4 tests PASS. If test 4 (click summary toggles open state) fails because jsdom 25 doesn't fire the native `<details>` toggle on `summary.trigger('click')`, debug:
- Confirm `<details>` is rendered: `console.log(w.html())` should show `<details ... open>`
- Try `dispatchEvent` with a synthetic `MouseEvent` of type `'click'` on the summary element directly
- If jsdom truly doesn't support `<details>` toggle, simplify test 4 to: "summary element exists with correct class" (`expect(summary.classes()).toContain('nav-group-title')`) and document the simplification in the test name. Then re-run.

- [ ] **Step 5: Run full frontend test suite — verify no regressions**

Run: `cd frontend && npx vitest run`
Expected: All tests pass (existing 192 + new 4 = 196 total, 0 failures). If any existing test breaks, the most likely cause is a test that mounts AdminLayout or assumes specific DOM structure — check `frontend/tests/*.test.js` for `AdminLayout` imports and adjust the consumer (not this file).

- [ ] **Step 6: Run vite build — verify no build errors**

Run: `cd frontend && npx vite build`
Expected: Build succeeds. Bundle size delta: ~negligible (only added hardcoded `groups` array + small CSS; no new runtime deps).

- [ ] **Step 7: Commit AdminLayout.vue changes (GREEN marker)**

```bash
cd D:/ToolDevelop/ADDashboard
git add frontend/src/components/AdminLayout.vue
git commit -m "feat(frontend): AdminLayout sidebar nav grouped into 4 collapsible sections"
```

---

### Task 3: Mirror to publish/ + final verify + push

**Files:**
- Mirror: `publish/frontend/src/components/AdminLayout.vue` (must match source byte-for-byte after cp)

**Interfaces:**
- Consumes: `frontend/src/components/AdminLayout.vue` (post-Task-2 committed version)
- Produces: identical `publish/frontend/src/components/AdminLayout.vue`; final commits on main; origin pushed

- [ ] **Step 1: Copy source → publish mirror**

Run:
```bash
cd D:/ToolDevelop/ADDashboard
cp frontend/src/components/AdminLayout.vue publish/frontend/src/components/AdminLayout.vue
```

- [ ] **Step 2: Verify mirror is byte-identical**

Run:
```bash
cd D:/ToolDevelop/ADDashboard
diff frontend/src/components/AdminLayout.vue publish/frontend/src/components/AdminLayout.vue
```
Expected: No diff output (exit 0).

- [ ] **Step 3: Run full frontend test suite + build — confirm green**

Run:
```bash
cd D:/ToolDevelop/ADDashboard/frontend
npx vitest run
npx vite build
```
Expected: All tests pass, build succeeds. Same state as Task 2 Steps 5-6 (just confirming the mirror didn't desync anything).

- [ ] **Step 4: Commit publish mirror**

```bash
cd D:/ToolDevelop/ADDashboard
git add publish/frontend/src/components/AdminLayout.vue
git commit -m "chore(publish): mirror AdminLayout sidebar nav redesign"
```

- [ ] **Step 5: Push to origin**

Run:
```bash
cd D:/ToolDevelop/ADDashboard
git push origin main
```
Expected: Push succeeds. `git log --oneline origin/main -3` shows the 3 new commits (test + feat + mirror).

- [ ] **Step 6: Manual smoke test (optional but recommended)**

Run: `npm start` (or `cd frontend && npx vite build && cd .. && npm start`) and:
- Login as admin → navigate to e.g. `/admin/users`
- Confirm sidebar shows 4 groups (账号管理 / 目录管理 / 监控运维 / 系统设置), each expanded by default with `▾` marker
- Click "目录管理" group title → it collapses (marker becomes `▸`), items hide
- Click again → expands
- Click any link → navigates correctly, current page's link is highlighted (active state)
- No console errors, no layout breakage in topbar / content area

If smoke test reveals issues (e.g., summary click doesn't collapse in real browser), file follow-up tasks (out of scope for this plan).