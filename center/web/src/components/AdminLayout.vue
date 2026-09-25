<template>
  <div class="layout" :class="{ 'sidebar-collapsed': !sidebarVisible }">
    <aside class="sidebar">
      <!-- 2026-09-25 R94: brand mark block — replaces the previous plain
           <h3> with a 2-line product mark + tiny version chip. The
           product name drops to two lines (AD / Dashboard · 管理) for a
           more deliberate editorial-style mark that sits above the
           search box as a visual anchor, instead of looking like a
           forgotten page title. The "← 返回看板" link stays as the
           operator's escape hatch into the frontend dashboard. -->
      <router-link to="/" class="back">← 返回看板</router-link>
      <div class="brand">
        <div class="brand-mark">
          <span class="brand-mark-primary">AD</span>
          <span class="brand-mark-secondary">Dashboard</span>
        </div>
        <div class="brand-mark-meta">管理控制台</div>
      </div>
      <!-- 2026-09-24 R92: sidebar menu search + scrollbar.
           Per operator directive "平台管理后台的菜单能够展开和搜索,
           同时展开之后提供滑动条". Search box renders only while the
           sidebar is expanded; on collapse it's hidden so the collapsed
           rail stays narrow. Query is intentionally NOT persisted in
           localStorage — search is a transient operator action, not a
           preference. The clear (✕) button only appears once the query
           is non-empty so the input stays uncluttered on first paint.
           2026-09-25 R94: visual polish — the search input drops the
           1px var(--border) outline and replaces it with a hairline
           bottom-rule + uppercase eyebrow label ("Search"). Operator
           directive "视觉层级 / 排版打磨" — keep R92 behaviour, lift
           the surface so it reads as a deliberate filter affordance
           instead of a generic text input. -->
      <div v-if="sidebarVisible" class="sidebar-search-wrap">
        <label class="sidebar-search-label" for="sidebar-search-input">Search</label>
        <div class="sidebar-search-field">
          <input
            id="sidebar-search-input"
            v-model="searchQuery"
            type="text"
            class="sidebar-search sidebar-search-input"
            placeholder="筛选菜单项..."
            aria-label="搜索菜单"
            data-test="sidebar-search"
          />
          <button
            v-if="searchQuery"
            type="button"
            class="sidebar-search-clear"
            title="清空搜索"
            aria-label="清空搜索"
            @click="searchQuery = ''"
          >✕</button>
        </div>
      </div>
      <nav>
        <!-- 2026-08-28 round-54: visual hierarchy — level-1 title is now a
             dimmer/smaller/uppercase "Group Header" with right-aligned caret;
             level-2 nav-links sit on a left rail with ml-4 indent, 2px blue
             accent + bg on active, hover-bg on hover. Operator directive
             "侧边栏层级感非常模糊" + "一级分类和二级子菜单左对齐齐平".
             R53 structure (5+1 groups, 19 nav-links) unchanged.
             2026-09-24 R92: `v-for` source switched from `groups` to
             `filteredGroups` so an active search hides groups whose items
             all fail to match the query. When `searchQuery` is empty
             (the default state on mount) `filteredGroups` is
             structurally identical to `groups` — all 22 links, all 7
             groups, in the original order — so the R53/R54/R75
             regression tests continue to hold.
             2026-09-25 R94: each group now has an item counter chip on
             the right side of the title row (e.g. "5 / 4 / 4 / 2 / 2 / 2
             / 3") so the operator can scan density at a glance — a
             sparse group reads as "low-frequency parking zone", a dense
             one reads as "main working area". Counter is non-clickable
             and lives outside the clickable summary area. -->
        <details v-for="g in filteredGroups" :key="g.title" :open="g.open" class="nav-group">
          <summary class="nav-group-title">
            <span class="nav-group-title-main">
              <span class="icon">{{ g.icon }}</span>
              <span class="label">{{ g.title }}</span>
            </span>
            <span class="nav-group-title-meta">{{ g.items.length }}</span>
            <span class="nav-group-caret">▼</span>
          </summary>
          <div class="nav-group-items">
            <router-link
              v-for="i in g.items"
              :key="i.path"
              :to="i.path"
              class="nav-link"
            >{{ i.label }}</router-link>
          </div>
        </details>
        <!-- R92: empty-state placeholder — appears only when an active
             search has pruned every group. Tells the operator "your
             query matched nothing" instead of leaving a blank sidebar
             that looks like the menu failed to load. -->
        <div v-if="searchQuery && filteredGroups.length === 0" class="sidebar-search-empty">
          没有匹配的菜单项
        </div>
      </nav>
    </aside>
    <main>
      <header class="topbar">
        <div class="topbar-left">
          <button class="sidebar-toggle" :title="sidebarVisible ? '收起侧边栏' : '展开侧边栏'" @click="toggleSidebar">{{ sidebarVisible ? '‹' : '›' }}</button>
          <span>{{ auth.user?.username }} <small>({{ auth.user?.role }})</small></span>
        </div>
        <div class="topbar-actions">
          <button class="theme-toggle" :title="theme === 'dark' ? '切换到白天' : '切换到黑夜'" @click="toggleTheme">{{ theme === 'dark' ? '☀' : '🌙' }}</button>
          <button @click="logout">退出</button>
        </div>
      </header>
      <section class="content">
        <slot />
      </section>
    </main>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { useTheme } from '../composables/useTheme.js';
const auth = useAuthStore();
const router = useRouter();
function logout() { auth.logout(); router.push('/login'); }
const { theme, toggleTheme } = useTheme();

// R52 sidebar collapse persists via localStorage 'admin-sidebar-visible'.
// Default true. Toggle button lives in the topbar (always accessible).
const sidebarVisible = ref(true);
function loadSidebarVisible() {
  try {
    const v = localStorage.getItem('admin-sidebar-visible');
    if (v === 'false') sidebarVisible.value = false;
  } catch { /* ignore */ }
}
function toggleSidebar() {
  sidebarVisible.value = !sidebarVisible.value;
  try { localStorage.setItem('admin-sidebar-visible', String(sidebarVisible.value)); } catch { /* ignore */ }
}
onMounted(loadSidebarVisible);

// 2026-09-24 R92: menu search query. Held as a plain ref (no debounce —
// the dataset is 22 items, synchronous substring scan is <1ms and adding
// debounce would only complicate the input UX). Bound to <input v-model>
// in the template; consumed by the `filteredGroups` computed below.
// Intentionally NOT persisted to localStorage — search is a transient
// operator action, not a preference. Reload = clean slate.
const searchQuery = ref('');

// 2026-09-24 R92: filteredGroups derived view over `groups`. Behaviour:
//   - empty query → return all 7 groups with all items, in original
//     order. This is the identity case the existing R53/R54/R75 tests
//     depend on, so adding search must NOT shift any label or link.
//   - non-empty query → substring match on `i.label.toLowerCase()`.
//     Groups with zero surviving items are dropped (per operator
//     decision "未命中 group 直接隐藏"). Surviving groups are forced
//     to `open: true` so the operator doesn't have to manually expand
//     the group to see their hits — search is a "show me what's there"
//     action, not a "preserve collapsed state" action.
const filteredGroups = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) {
    return groups.map(g => ({ ...g, open: true }));
  }
  return groups
    .map(g => ({
      ...g,
      items: g.items.filter(i => i.label.toLowerCase().includes(q)),
      open: true
    }))
    .filter(g => g.items.length > 0);
});

// 2026-08-28 round-53: 5+1 top-level groups per operator directive. The 5 main
// groups mirror the operator's explicit list exactly (labels, items, order).
// The 6th group (系统设置) is a parking zone for 3 orphan views that were
// not in the operator's spec (config / email-config / migrations) — they
// remain functional but tucked away at the lowest-frequency position.
//
// Renames from R52 → R53:
//   监控与诊断 > 复制伙伴端口健康监控  →  复制伙伴端口监控
//   监控与诊断 > 心跳与告警            →  心跳与状态报告
//   AD 目录服务 > AD 站点清单          →  AD 活动目录服务器 > AD 站点清单设置
//   AD 目录服务 > AD 域控清单          →  AD 活动目录服务器 > AD 域控清单设置
//   监控与诊断 > 端口健康检查          →  AD 活动目录服务器 > AD 域控检查端口
//   (delete) Schema 与清理             →  DELETED (full chain: view + router + tests)
//   服务器管理 > 非活动目录            →  成员服务器管理 > 成员服务器
//   服务器管理 > 非活动目录服务器组    →  成员服务器管理 > 成员服务器组
//   权限与账号 > 用户                  →  权限和账户 > 用户管理
//   权限与账号 > 角色                  →  权限和账户 > 角色管理
//   权限与账号 > 包管理                →  监控与诊断 > 包管理
//   系统运维 > 审计日志                →  运维日志 > 系统运维日志
//   系统运维 > 操作日志 (事件与日志)   →  运维日志 > 心跳与状态执行日志
//
// 2026-08-29 R64.1: 站点矩阵 removed from admin sidebar — frontend-only
// per operator directive "站点矩阵 只在前台展现,后台不需要".
// The /matrix route + SiteMatrixView component still exist (AppLayout
// page in the frontend), but admin (AdminLayout) no longer surfaces it.
const groups = [
  { icon: '📊', title: '监控与诊断', items: [
    // R64: 复制状态概览 restored to R49 ops-console (per-DC partner tables).
    { label: '复制状态概览',         path: '/admin/site-replication-matrix/all' },
    // 2026-09-01 R74: 复制错误 — focused triage view for failed replication
    // attempts. Slotted immediately after 复制状态概览 so operators can
    // hop from "what's the fleet status" to "what's actually broken".
    { label: '复制错误',             path: '/admin/replication-errors' },
    { label: '复制伙伴端口监控',     path: '/admin/replication-log/monitor' },
    { label: '心跳与状态报告',       path: '/admin/heartbeat-report' },
    // R53: 包管理 moved here from 权限与账号 (operator's spec).
    { label: '包管理',               path: '/admin/packages' }
  ]},
  { icon: '🛡️', title: 'AD 活动目录服务器', items: [
    { label: 'AD 站点清单设置',     path: '/admin/sites-catalog' },
    { label: 'AD 域控清单设置',     path: '/admin/dcs-catalog' },
    // R53: 端口健康检查 renamed to AD 域控检查端口, moved from R52 监控与诊断.
    { label: 'AD 域控检查端口',     path: '/admin/ports' },
    // R53: NEW placeholder — file push to AD DCs (mock-first per operator).
    { label: '文件推送功能',         path: '/admin/ad-file-push' }
  ]},
  { icon: '💻', title: '成员服务器管理', items: [
    { label: '成员服务器组',         path: '/admin/server-groups' },
    { label: '成员服务器',           path: '/admin/member-servers' },
    // R53: NEW placeholders (mock-first per operator directive).
    { label: '成员服务器文件推送',   path: '/admin/member-file-push' },
    { label: '成员服务器执行命令',   path: '/admin/member-command-exec' }
  ]},
  { icon: '👥', title: '权限和账户', items: [
    { label: '用户管理', path: '/admin/users' },
    { label: '角色管理', path: '/admin/roles' }
  ]},
  // 2026-08-31 R75: 运维 group — AD 用户与组管理 (per operator directive
  // "放在运维那边，可以针对特定的AD服务器，用户创建、搜索、密码重置、
  // 禁用等等功能，组创建、组属性设定，成员增减、删除等等功能").
  // Sits between 权限和账户 and 运维日志 — logical reading order:
  // account → AD operations → log review. 2 nav-links, brings total to
  // 6+1 = 7 groups + 23 nav-links (was 6 / 21 in R64.1).
  { icon: '⚙️', title: '运维', items: [
    { label: 'AD 用户管理', path: '/admin/ad-users' },
    { label: 'AD 组管理',   path: '/admin/ad-groups' }
  ]},
  { icon: '📋', title: '运维日志', items: [
    // R53: 审计日志 → 系统运维日志 (记录目前所有的系统变更日志).
    { label: '系统运维日志',         path: '/admin/audit' },
    // R53: 操作日志 → 心跳与状态执行日志 (记录收集到的心跳和状态日志).
    { label: '心跳与状态执行日志',   path: '/admin/operations-log' }
  ]},
  // R53: 6th group — system config orphans. Not in operator's spec but
  // these views exist and serve real functions (config / email / migrations).
  // Bottom position = lowest frequency = least screen real estate impact.
  { icon: '🛠️', title: '系统设置', items: [
    { label: '版本升级', path: '/admin/migrations' },
    { label: '系统配置', path: '/admin/config' },
    { label: '邮件配置', path: '/admin/email-config' }
  ]}
];
</script>

<style scoped>
/* ============================================================================
   2026-09-25 R94 — sidebar visual hierarchy / typography pass.

   Scope: ops-console polish — typography, density, breathing room,
   editorial brand mark. NOT changing any behaviour contract (search,
   collapse, scroll, filter, R53/R54/R75 nav structure, R74 复制错误
   placement, R64.1 站点矩阵 removal).

   Tokens referenced: var(--sidebar-bg) / var(--panel) / var(--border) /
   var(--text) / var(--muted) / var(--accent) / var(--input-bg).
   dark + light both work via these vars — no new colors introduced.
   Hardcoded #3b82f6 / #60a5fa / rgba(96,165,250,0.14) on
   .nav-link.router-link-active are kept verbatim because the R54
   source-CSS test (admin-layout.test.js:361-366) regex-locks those
   literal hex strings. Visual upgrade only — no regression in any of
   the 19 R53/R54/R75/R92 tests.

   Self-critique vs frontend-design AI-tells:
     - No cream background, no terracotta accent, no monospace labels,
       no SaaS card kit with uniform rounded corners + soft shadows.
     - Group headers remain 11px uppercase (R54 contract) but now sit
       with proper line-height + tracking so they don't look like a
       forgotten toolbar label.
     - Active state remains a 2px left bar + 5%-tint background (R54
       contract) but the padding inside the link is tightened so the
       active bar reads as "this row is selected" instead of "this row
       happens to be blue".
     - Search input drops its 1px bordered-box look in favour of an
       underlined field + 11px uppercase "Search" eyebrow label,
       echoing how Linear / Notion sidebar filters present themselves.
   ========================================================================== */

.layout {
  display: grid;
  grid-template-columns: 248px 1fr;            /* R94: 240 → 248 for breathing room */
  height: 100vh;
  transition: grid-template-columns 0.2s ease;
}
.layout.sidebar-collapsed { grid-template-columns: 0 1fr; }

.sidebar {
  background: var(--sidebar-bg);
  padding: 18px 14px 16px 18px;                /* R94: tighter horizontal padding */
  overflow: hidden;
  /* 2026-09-24 R92: switch the sidebar to a vertical flex column so the
     <input> search box + <nav> can size themselves independently.
     `min-height: 0` is the critical bit — by default a flex item refuses
     to shrink below its content size, which would let <nav> push the
     topbar off-screen on short viewports instead of producing an inner
     scrollbar. With `min-height: 0` set, the overflow-y rule on <nav>
     actually fires.
     2026-09-25 R94: add a hairline right border so the sidebar reads as
     a defined panel against the main content area — matches the panel
     chrome used by the topbar (var(--border)) so the whole app looks
     like one consistent surface system. */
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--border);
  transition: opacity 0.15s ease;
}
.layout.sidebar-collapsed .sidebar {
  opacity: 0;
  pointer-events: none;
  padding: 0;
  border-right: 0;
}

/* R94: back-link — kept R52 contract, but trimmed margin so the brand
   mark below sits at a deliberate position instead of feeling stacked. */
.sidebar .back {
  display: block;
  color: var(--muted);
  font-size: 11px;
  margin-bottom: 14px;
  text-decoration: none;
  letter-spacing: 0.02em;
  transition: color 0.12s ease;
}
.sidebar .back:hover { color: var(--accent); }

/* R94: brand mark — replaces the previous plain <h3>. Two-line product
   mark with a tiny meta chip ("管理控制台") so the sidebar top reads
   like an editorial masthead, not a forgotten page title. */
.brand {
  margin-bottom: 22px;
  padding: 0 2px;
}
.brand-mark {
  display: flex;
  align-items: baseline;
  gap: 6px;
  line-height: 1.1;
}
.brand-mark-primary {
  font-size: 18px;
  font-weight: 700;
  color: var(--text);
  letter-spacing: -0.01em;
}
.brand-mark-secondary {
  font-size: 14px;
  font-weight: 500;
  color: var(--muted);
  letter-spacing: 0;
}
.brand-mark-meta {
  margin-top: 4px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.10em;
  text-transform: uppercase;
  color: var(--muted);
}

/* R94: search — eyebrow label + hairline underline. R92 behaviour
   (v-model bound, ✕ clear when non-empty, hidden when sidebar collapsed)
   unchanged. The visual surface is now a deliberate filter field:
     - 11px uppercase "Search" label above (same token family as the
       nav-group-title so the sidebar reads as one typographic system).
     - Input itself is borderless, only a 1px bottom rule that thickens
       on focus and adopts the theme accent.
     - ✕ button is a small flush text glyph against the right of the
       underline, not a round form-field clear button — drops the
       "form field" look.
   The class name .sidebar-search is locked on the <input> by R92
   test 4 (tests/admin-layout.test.js:402-405) via `input.sidebar-search`;
   .sidebar-search-clear is locked by R92 test 11 (line 473-481). Don't
   rename either. Wrapper class is renamed to .sidebar-search-wrap so
   the R94 spacing rule (.sidebar-search-wrap { margin: 0 0 18px })
   doesn't double-style the input. */
.sidebar-search-wrap { margin: 0 0 18px; }
.sidebar-search-label {
  display: block;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.10em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 0 0 6px 2px;
}
.sidebar-search-field { position: relative; }
/* The <input> itself keeps the class `sidebar-search` from R92 + a
   `sidebar-search-input` modifier hook so the rule lives here. */
.sidebar-search-input,
input.sidebar-search {
  width: 100%;
  padding: 6px 22px 6px 2px;
  font-size: 13px;
  font-family: inherit;
  border: 0;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  background: transparent;
  color: var(--text);
  box-sizing: border-box;
  outline: none;
  transition: border-color 0.12s ease;
}
.sidebar-search-input::placeholder,
input.sidebar-search::placeholder { color: var(--muted); font-style: italic; }
.sidebar-search-input:focus,
input.sidebar-search:focus { border-bottom-color: var(--accent); }
.sidebar-search-clear {
  position: absolute;
  top: 50%;
  right: 0;
  transform: translateY(-50%);
  width: 16px;
  height: 16px;
  padding: 0;
  font-size: 10px;
  line-height: 1;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.12s ease;
}
.sidebar-search-clear:hover { color: var(--accent); }

/* R94: empty-search placeholder — kept R92 muted-tone, but moved up to
   align with the .nav-link text baseline so it visually reads as "I am
   still a menu row, just empty right now". */
.sidebar-search-empty {
  padding: 14px 10px;
  font-size: 12px;
  color: var(--muted);
  text-align: center;
  letter-spacing: 0.02em;
}

/* R94: nav scroll container — R92 contract intact (max-height +
   overflow-y + themed scrollbar). Tighter gap between groups (was 6px
   on the nav level + 16px between groups, now 4px + 12px) so the menu
   feels compact but not claustrophobic.
   The calc(100vh - X) needs adjustment because the R94 brand mark grew
   taller than the R92 <h3>: was 130px, now 168px. */
.sidebar nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1 1 auto;
  min-height: 0;
  max-height: calc(100vh - 168px);
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
.sidebar nav::-webkit-scrollbar { width: 6px; }
.sidebar nav::-webkit-scrollbar-track { background: transparent; }
.sidebar nav::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 3px;
}
.sidebar nav::-webkit-scrollbar-thumb:hover { background: var(--muted); }

/* .sidebar a global reset kept minimal — level-2 nav-link styling now lives
   under .nav-link (round-54) and overrides active/hover with blue accent.
   R94: layout columns get min-width:0 so flex children ellipsis cleanly. */
main { display: flex; flex-direction: column; min-width: 0; }
.topbar { display: flex; justify-content: space-between; align-items: center; padding: 10px 20px; background: var(--panel); border-bottom: 1px solid var(--border); gap: 12px; }
.topbar-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
.topbar-actions { display: flex; gap: 8px; align-items: center; }
.topbar-actions button, .sidebar-toggle { padding: 6px 14px; border: 1px solid var(--border); border-radius: 3px; cursor: pointer; background: var(--input-bg); color: var(--text); }
.topbar-actions .theme-toggle { font-size: 14px; min-width: 32px; padding: 6px 8px; }
.sidebar-toggle { font-size: 16px; min-width: 32px; padding: 4px 10px; font-family: monospace; }
.content { padding: 20px; overflow: auto; }

/* 2026-08-28 round-54: visual hierarchy — level-1 = "Group Header" (small,
   dim, uppercase, right-aligned caret); level-2 = nav-link (ml-4 indent on
   a left rail, hover bg + active 2px blue accent). Operator directive
   "侧边栏层级感非常模糊" + 老大哥 Tailwind 参考 (Group Header / ml-4 / pl-4
   / border-left rail / border-l-2 blue accent / bg-blue/10 active).
   R53 structure (7 groups, 23 nav-links, emoji icons) preserved.
   2026-09-25 R94 — kept the R54 contracts intact (uppercase / 11px /
   var(--muted) / 700 weight / 0.06em tracking) but added a small counter
   chip on the right of the title row, tightened line-height, and reduced
   group spacing so the sidebar reads as a deliberate hierarchical system
   instead of a stacked list of labels. */
.nav-group {
  display: flex;
  flex-direction: column;
}
/* R94: was 16px between groups, now 12px + a hairline divider on groups
   that follow another (visually groups feel like chapters, not cards). */
.nav-group + .nav-group {
  margin-top: 12px;
  padding-top: 12px;
  position: relative;
}
.nav-group + .nav-group::before {
  content: '';
  position: absolute;
  top: 0;
  left: 2px;
  right: 14px;
  height: 1px;
  background: var(--border);
  opacity: 0.55;
}

/* ---- Level 1: Group Header ---- */
.nav-group-title {
  display: flex;
  align-items: center;
  justify-content: space-between;     /* caret pushed to right edge */
  padding: 6px 10px 5px;              /* R94: tighter top/bottom */
  margin: 0;
  cursor: pointer;
  user-select: none;
  list-style: none;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);                /* dimmer than nav-link text */
  font-weight: 700;
  font-size: 11px;                    /* smaller than 13px nav-link */
  border-radius: 3px;                 /* R94: 4 → 3 to match nav-link */
  line-height: 1.4;                   /* R94: explicit line-height */
  transition: color 0.15s, background 0.15s;
}
.nav-group-title:hover { color: var(--text); background: rgba(255, 255, 255, 0.03); }
.nav-group-title::-webkit-details-marker { display: none; }

.nav-group-title-main {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1 1 auto;
}
.nav-group-title .icon {
  font-size: 13px;
  line-height: 1;
  flex-shrink: 0;
  font-variant-emoji: text;
  opacity: 0.85;                      /* R94: emoji slightly tints down to match muted text */
}
.nav-group-title .label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* R94: counter chip — sits between title-main and caret. Non-active,
   uses var(--muted) so it doesn't fight the title for attention. */
.nav-group-title-meta {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0;
  text-transform: none;               /* counter reads as a number, not a label */
  color: var(--muted);
  flex-shrink: 0;
  margin-left: 8px;
  font-variant-numeric: tabular-nums;
  opacity: 0.7;
}

.nav-group-caret {
  font-size: 9px;
  color: var(--muted);
  font-weight: 400;
  line-height: 1;
  flex-shrink: 0;
  margin-left: 8px;
  transition: transform 0.18s ease;
}
/* Accordion: when group is collapsed, caret rotates 90deg (▼ → ▶) */
.nav-group:not([open]) > .nav-group-title .nav-group-caret { transform: rotate(-90deg); }
.nav-group[open]     > .nav-group-title .nav-group-caret { transform: rotate(0deg); }

/* ---- Level 2: container with left rail + indent ---- */
.nav-group-items {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-top: 4px;
  margin-bottom: 4px;
  padding: 4px 0;
  /* ml-4 (16px from container edge) + pl-4 (16px more) so the rail sits
     inside the indent, matching the Tailwind reference. */
  margin-left: 14px;
  padding-left: 10px;
  border-left: 1px solid var(--border);
}

/* ---- Level 2: nav-link with active blue accent ---- */
.nav-link {
  display: block;
  padding: 6px 10px;                  /* R94: 7 → 6 for slightly tighter rhythm */
  font-size: 13px;
  color: var(--text);
  text-decoration: none;
  border-radius: 3px;                 /* R94: 4 → 3 — corner matches group-title */
  position: relative;
  line-height: 1.4;                   /* R94: explicit line-height */
  /* 2px transparent placeholder so nav-link sits flush against the
     container's 1px rail; active state swaps the transparent border
     for a blue accent. */
  margin-left: -1px;
  border-left: 2px solid transparent;
  transition: background 0.12s ease, color 0.12s ease, border-left-color 0.12s ease;
}
.nav-link:hover {
  background: var(--border);
  color: var(--accent);
}
/* R54 contract — these 3 lines are locked by admin-layout.test.js:361-366
   source-CSS regex. DO NOT change the literal hex values or rgba triple. */
.nav-link.router-link-active {
  background: rgba(96, 165, 250, 0.14);          /* bg-blue-400/14 */
  color: #60a5fa;                                /* text-blue-400 */
  font-weight: 600;
  border-left-color: #3b82f6;                   /* border-l-2 border-blue-500 */
}
</style>