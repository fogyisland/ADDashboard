<template>
  <div class="layout" :class="{ 'sidebar-collapsed': !sidebarVisible }">
    <aside class="sidebar">
      <router-link to="/" class="back">← 返回看板</router-link>
      <h3>AD Dashboard · 管理</h3>
      <nav>
        <!-- 2026-08-28 round-53: operator directive "按照我的要求 修改当前后台的界面"
             — explicit 5 top-level groups with specified contents. Renames per
             spec. Schema 与清理 deleted. 3 new placeholder routes added
             (ad-file-push, member-file-push, member-command-exec). 系统设置
             tucked in as 6th group at the bottom for orphan items (config /
             email-config / migrations) — these were not in operator's spec
             but the views exist and removing them entirely would orphan
             operator's bookmarks. -->
        <details v-for="g in groups" :key="g.title" open class="nav-group">
          <summary class="nav-group-title">
            <span class="icon">{{ g.icon }}</span>
            <span class="label">{{ g.title }}</span>
          </summary>
          <router-link
            v-for="i in g.items"
            :key="i.path"
            :to="i.path"
            class="nav-link"
          >{{ i.label }}</router-link>
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
const groups = [
  { icon: '📊', title: '监控与诊断', items: [
    { label: '复制状态概览',         path: '/admin/site-replication-matrix/all' },
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
.sidebar a { padding: 8px 10px; border-radius: 4px; color: var(--text); text-decoration: none; }
.sidebar a.router-link-active, .sidebar a:hover { background: var(--border); }
main { display: flex; flex-direction: column; min-width: 0; }
.topbar { display: flex; justify-content: space-between; align-items: center; padding: 10px 20px; background: var(--panel); border-bottom: 1px solid var(--border); gap: 12px; }
.topbar-left { display: flex; align-items: center; gap: 12px; }
.topbar-actions { display: flex; gap: 8px; align-items: center; }
.topbar-actions button, .sidebar-toggle { padding: 6px 14px; border: 1px solid var(--border); border-radius: 3px; cursor: pointer; background: var(--input-bg); color: var(--text); }
.topbar-actions .theme-toggle { font-size: 14px; min-width: 32px; padding: 6px 8px; }
.sidebar-toggle { font-size: 16px; min-width: 32px; padding: 4px 10px; font-family: monospace; }
.content { padding: 20px; overflow: auto; }

/* 2026-08-28 round-52: 6 top-level groups (R53 added 1 6th for system settings).
   Indentation: title at 8px, items at 28px — 20px gap signals hierarchy.
   Icons (emoji) at level 1, chevron ▸/▼ at level 1 to indicate disclosure. */
.nav-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nav-group + .nav-group { margin-top: 16px; }
.nav-group-title {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px 4px;
  margin: 0;
  cursor: pointer;
  user-select: none;
  list-style: none;
  letter-spacing: 0.02em;
  color: var(--text);
  font-weight: 700;
  font-size: 13px;
}
.nav-group-title::-webkit-details-marker { display: none; }
.nav-group-title::before {
  content: '▸';
  display: inline-block;
  width: 14px;
  margin-right: 4px;
  transition: transform .15s;
  color: var(--muted);
  font-weight: 400;
  flex-shrink: 0;
}
.nav-group-title .icon {
  font-size: 14px;
  margin-right: 4px;
  flex-shrink: 0;
  font-variant-emoji: text;
}
details[open] > .nav-group-title::before { transform: rotate(90deg); }

.nav-link {
  display: block;
  padding: 6px 12px 6px 28px;
  font-size: 13px;
}
</style>