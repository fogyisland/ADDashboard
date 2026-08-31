<template>
  <div class="layout" :class="{ 'sidebar-collapsed': !sidebarVisible }">
    <aside class="sidebar">
      <router-link to="/" class="back">← 返回看板</router-link>
      <h3>AD Dashboard · 管理</h3>
      <nav>
        <!-- 2026-08-28 round-54: visual hierarchy — level-1 title is now a
             dimmer/smaller/uppercase "Group Header" with right-aligned caret;
             level-2 nav-links sit on a left rail with ml-4 indent, 2px blue
             accent + bg on active, hover-bg on hover. Operator directive
             "侧边栏层级感非常模糊" + "一级分类和二级子菜单左对齐齐平".
             R53 structure (5+1 groups, 19 nav-links) unchanged. -->
        <details v-for="g in groups" :key="g.title" open class="nav-group">
          <summary class="nav-group-title">
            <span class="nav-group-title-main">
              <span class="icon">{{ g.icon }}</span>
              <span class="label">{{ g.title }}</span>
            </span>
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
import { ref, onMounted } from 'vue';
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
.layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  height: 100vh;
  transition: grid-template-columns 0.2s ease;
}
.layout.sidebar-collapsed { grid-template-columns: 0 1fr; }
.sidebar {
  background: var(--sidebar-bg);
  padding: 20px 16px 20px 20px;
  overflow: hidden;
  transition: opacity 0.15s ease;
}
.layout.sidebar-collapsed .sidebar {
  opacity: 0;
  pointer-events: none;
  padding: 0;
}
.sidebar .back { display: block; color: var(--muted); font-size: 12px; margin-bottom: 12px; text-decoration: none; }
.sidebar .back:hover { color: var(--accent); }
.sidebar h3 { color: var(--accent); margin: 0 0 16px; font-size: 14px; }
.sidebar nav { display: flex; flex-direction: column; gap: 6px; }
/* .sidebar a global reset kept minimal — level-2 nav-link styling now lives
   under .nav-link (round-54) and overrides active/hover with blue accent. */
main { display: flex; flex-direction: column; min-width: 0; }
.topbar { display: flex; justify-content: space-between; align-items: center; padding: 10px 20px; background: var(--panel); border-bottom: 1px solid var(--border); gap: 12px; }
.topbar-left { display: flex; align-items: center; gap: 12px; }
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
   R53 structure (5+1 groups, 19 nav-links, emoji icons) preserved.
   CSS variable --accent-blue (#60a5fa) / --accent-blue-bg (rgba blue 0.12)
   / --hover-bg (var(--border)) used so dark + light theme both look right. */
.nav-group {
  display: flex;
  flex-direction: column;
}
.nav-group + .nav-group { margin-top: 16px; }

/* ---- Level 1: Group Header ---- */
.nav-group-title {
  display: flex;
  align-items: center;
  justify-content: space-between;     /* caret pushed to right edge */
  padding: 8px 10px 6px;
  margin: 0;
  cursor: pointer;
  user-select: none;
  list-style: none;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);                /* dimmer than nav-link text */
  font-weight: 700;
  font-size: 11px;                    /* smaller than 13px nav-link */
  border-radius: 4px;
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
}
.nav-group-title .icon {
  font-size: 13px;
  line-height: 1;
  flex-shrink: 0;
  font-variant-emoji: text;
}
.nav-group-title .label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
  padding: 7px 10px;
  font-size: 13px;
  color: var(--text);
  text-decoration: none;
  border-radius: 4px;
  position: relative;
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
.nav-link.router-link-active {
  background: rgba(96, 165, 250, 0.14);          /* bg-blue-400/14 */
  color: #60a5fa;                                /* text-blue-400 */
  font-weight: 600;
  border-left-color: #3b82f6;                   /* border-l-2 border-blue-500 */
}
</style>