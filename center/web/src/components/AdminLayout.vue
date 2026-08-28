<template>
  <div class="layout">
    <aside class="sidebar">
      <router-link to="/" class="back">← 返回看板</router-link>
      <h3>AD Dashboard · 管理</h3>
      <nav>
        <!-- 2026-08-28 round-51: drop R48.1/R48.2 subgroup rendering. The
             服务器管理 umbrella + 3 sub-buckets made items feel flat (only
             10px left-padding diff between top-level and sub-group items,
             1px font-size diff). Operator directive: "当前就感觉很乱，其实
             应该分成几个大类" + "也没有缩进". Now 6 flat top-level groups,
             one nesting level max. Items always show under their title. -->
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
    </aside>
    <main>
      <header class="topbar">
        <span>{{ auth.user?.username }} <small>({{ auth.user?.role }})</small></span>
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
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { useTheme } from '../composables/useTheme.js';
const auth = useAuthStore();
const router = useRouter();
function logout() { auth.logout(); router.push('/login'); }
const { theme, toggleTheme } = useTheme();

// 2026-08-28 round-51: drop 服务器管理 umbrella + 3 sub-buckets. The
// R48.1/R48.2 nesting made the sidebar feel flat — top-level vs sub-group
// items differed by only 10px left-padding and 1px font size, with no
// other visual cue. Operator directive: "当前就感觉很乱，其实应该分成
// 几个大类" + "也没有缩进".
//
// New shape: 6 flat top-level groups, ordered by operator check frequency.
//   1. 监控健康  — operator's daily high-frequency surface
//   2. AD 管理  — AD catalog + ops log + packages
//   3. 服务器管理 — non-AD assets only (普通服务器组 split out of umbrella)
//   4. 账号管理  — users + roles
//   5. 数据库运维 — migrations + orphan schemas
//   6. 系统设置  — config + email + audit
//
// Total nav-links: 17 (unchanged). No URL paths change — only labels at
// the top-level move (umbrella 标题 dropped, sub-bucket 标题 promoted).
const groups = [
  { title: '监控健康', items: [
    // 2026-08-27 round-33: single-site 站点复制矩阵 removed — replaced by
    // the unified 复制状态概览 view below (per-primary partner table).
    { label: '复制状态概览', path: '/admin/site-replication-matrix/all' },
    // 2026-08-28 round-47: 复制伙伴端口健康监控. Operator directive
    // "在这边不叫复制日志监控了，改成复制伙伴端口健康监控名称". URL path
    // stays /admin/replication-log/monitor for backward-compat with saved
    // bookmarks; label and underlying component change.
    { label: '复制伙伴端口健康监控', path: '/admin/replication-log/monitor' },
    { label: '端口健康检查', path: '/admin/ports' },
    { label: '心跳与报告', path: '/admin/heartbeat-report' }
  ]},
  { title: 'AD 管理', items: [
    { label: 'AD 站点清单', path: '/admin/sites-catalog' },
    { label: 'AD 域控清单', path: '/admin/dcs-catalog' },
    // 2026-08-27 round-39: 运维区统一日志 — 审计事件(changes/ops) + 心跳数据 + 报告数据.
    { label: '操作日志', path: '/admin/operations-log' },
    { label: '包管理',   path: '/admin/packages' }
  ]},
  { title: '服务器管理', items: [
    // 2026-08-28 round-48.1: rename 非 AD 服务器 → 非活动目录, 非 AD 服务器组
    // → 非活动目录服务器组. URL paths preserved. Round-51 lifts these out of
    // the 服务器管理 umbrella into this slim top-level group (only remaining
    // member after the umbrella split).
    { label: '非活动目录',       path: '/admin/member-servers' },
    { label: '非活动目录服务器组', path: '/admin/server-groups' }
  ]},
  { title: '账号管理', items: [
    { label: '用户', path: '/admin/users' },
    { label: '角色', path: '/admin/roles' }
  ]},
  { title: '数据库运维', items: [
    { label: '版本升级',         path: '/admin/migrations' },
    { label: '未签名 Schema 残留', path: '/admin/orphan-schemas' }
  ]},
  { title: '系统设置', items: [
    { label: '系统配置', path: '/admin/config' },
    { label: '邮件配置', path: '/admin/email-config' },
    { label: '审计日志', path: '/admin/audit' }
  ]}
];
</script>

<style scoped>
.layout { display: grid; grid-template-columns: 220px 1fr; height: 100vh; }
.sidebar { background: var(--sidebar-bg); padding: 20px; }
.sidebar .back { display: block; color: var(--muted); font-size: 12px; margin-bottom: 12px; text-decoration: none; }
.sidebar .back:hover { color: var(--accent); }
.sidebar h3 { color: var(--accent); margin: 0 0 16px; font-size: 14px; }
.sidebar nav { display: flex; flex-direction: column; gap: 6px; }
.sidebar a { padding: 8px 10px; border-radius: 4px; color: var(--text); text-decoration: none; }
.sidebar a.router-link-active, .sidebar a:hover { background: var(--border); }
main { display: flex; flex-direction: column; }
.topbar { display: flex; justify-content: space-between; align-items: center; padding: 10px 20px; background: var(--panel); border-bottom: 1px solid var(--border); }
.topbar-actions { display: flex; gap: 8px; align-items: center; }
.topbar-actions button { padding: 6px 14px; border: 1px solid var(--border); border-radius: 3px; cursor: pointer; background: var(--input-bg); color: var(--text); }
.topbar-actions .theme-toggle { font-size: 14px; min-width: 32px; padding: 6px 8px; }
.content { padding: 20px; overflow: auto; }
/* 2026-08-28 round-51: 6 flat top-level groups. Indentation expresses
   "this item belongs to the title above" via a 32px left-padding on items
   vs 8px on titles — a 24px gap that's unmistakable to the eye (R48.1's
   10px gap was the "没有缩进" the operator flagged). 13px title at weight
   700 in --text color marks the top-level boundary without decorative
   chrome (per feedback_admin_no_marketing_chrome.md). */
.nav-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
/* Vertical gap between top-level groups — the eye reads "new category". */
.nav-group + .nav-group { margin-top: 16px; }
.nav-link {
  display: block;
  padding: 6px 12px 6px 32px;
  font-size: 13px;
}
.nav-group-title {
  font-weight: 700;
  color: var(--text);
  font-size: 13px;
  padding: 6px 8px 4px;
  margin: 0;
  cursor: pointer;
  user-select: none;
  list-style: none;
  letter-spacing: 0.02em;
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
}
details[open] .nav-group-title::before { transform: rotate(90deg); }
/* Round-51: dropped .nav-subgroup / .nav-subgroup-title styles — no
   sub-buckets remain after the umbrella split. */
</style>