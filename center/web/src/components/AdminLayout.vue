<template>
  <div class="layout">
    <aside class="sidebar">
      <router-link to="/" class="back">← 返回看板</router-link>
      <h3>AD Dashboard · 管理</h3>
      <nav>
        <details v-for="g in groups" :key="g.title" open class="nav-group">
          <summary class="nav-group-title">{{ g.title }}</summary>
          <!-- 2026-08-28 round-48.1: subgroup rendering for groups like
               服务器管理 that have nested 活动目录服务器组 + 普通服务器组
               sub-buckets. Most groups stay flat (use `items`); only
               umbrella groups declare `subgroups`. -->
          <template v-if="!g.subgroups">
            <router-link
              v-for="i in g.items"
              :key="i.path"
              :to="i.path"
              class="nav-link"
            >{{ i.label }}</router-link>
          </template>
          <template v-else>
            <div v-for="sg in g.subgroups" :key="sg.title" class="nav-subgroup">
              <h4 class="nav-subgroup-title">{{ sg.title }}</h4>
              <router-link
                v-for="i in sg.items"
                :key="i.path"
                :to="i.path"
                class="nav-link"
              >{{ i.label }}</router-link>
            </div>
          </template>
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

// 2026-08-28 round-48.2: split monitoring/health items out of 活动目录服务器组
// into a dedicated 监控与健康组 sub-bucket per operator directive "增加一个
// 监控与健康" + "组" (sub-group under 服务器管理 umbrella, matching the
// 活动目录服务器组 / 普通服务器组 naming pattern).
//
//   服务器管理 (umbrella)
//     监控与健康组    (4 monitoring/health items: 复制状态概览 / 复制伙伴端口
//                     健康监控 / 端口健康检查 / 心跳与报告)
//     活动目录服务器组 (4 AD admin items: AD 站点清单 / AD 域控清单 /
//                     操作日志 / 包管理)
//     普通服务器组    (2 non-AD items: 非活动目录 / 非活动目录服务器组)
//
// Total top-level groups: 4 (unchanged). Total nav-links: 17 (unchanged).
// Path order changes — monitoring items move from middle of 活动目录
// 服务器组 to top of the new 监控与健康组 sub-bucket. URL paths preserved.
const groups = [
  { title: '账号管理', items: [
    { label: '用户',     path: '/admin/users' },
    { label: '角色',     path: '/admin/roles' }
  ]},
  { title: '服务器管理', subgroups: [
    // 2026-08-28 round-48.2: monitoring/health items lifted out of 活动目录
    // 服务器组 into this new sub-bucket. Surfaces the 4 pages operators
    // check most often (replication health, port health, agent heartbeat)
    // without the catalog clutter.
    { title: '监控与健康组', items: [
      // 2026-08-27 round-33: single-site 站点复制矩阵 removed — replaced by
      // the unified 复制状态概览 view below (per-primary partner table).
      { label: '复制状态概览', path: '/admin/site-replication-matrix/all' },
      // 2026-08-28 round-47: 复制伙伴端口健康监控. Operator directive
      // "在这边不叫复制日志监控了，改成复制伙伴端口健康监控名称". The URL
      // path stays /admin/replication-log/monitor for backward-compat
      // with saved bookmarks; the label and underlying component change.
      { label: '复制伙伴端口健康监控', path: '/admin/replication-log/monitor' },
      { label: '端口健康检查', path: '/admin/ports' },
      { label: '心跳与报告', path: '/admin/heartbeat-report' }
    ]},
    { title: '活动目录服务器组', items: [
      { label: 'AD 站点清单', path: '/admin/sites-catalog' },
      { label: 'AD 域控清单', path: '/admin/dcs-catalog' },
      // 2026-08-27 round-39: 运维区统一日志 — 审计事件(changes/ops)+ 心跳数据 + 报告数据.
      { label: '操作日志',   path: '/admin/operations-log' },
      { label: '包管理',     path: '/admin/packages' }
    ]},
    // 2026-08-28 round-48.1: rename 非 AD 服务器 → 非活动目录, 非 AD 服务器组
    // → 非活动目录服务器组. URL paths preserved (/admin/member-servers +
    // /admin/server-groups). Operator wants explicit "非活动目录" wording
    // for clarity.
    { title: '普通服务器组', items: [
      { label: '非活动目录',       path: '/admin/member-servers' },
      { label: '非活动目录服务器组', path: '/admin/server-groups' }
    ]}
  ]},
  { title: '数据库运维', items: [
    { label: '版本升级',     path: '/admin/migrations' },
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
.nav-group { margin-bottom: 8px; }
.nav-group { display: flex; flex-direction: column; gap: 6px; }
.nav-link { display: block; }
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
/* 2026-08-28 round-48.1: nested sub-bucket headers within umbrella groups
   (e.g. 服务器管理 > 活动目录服务器组 / 普通服务器组). Visually subordinate
   to the top-level .nav-group-title; serves as a static label, not a
   collapsible disclosure. */
.nav-subgroup { margin-top: 4px; }
.nav-subgroup-title {
  font-weight: 500;
  color: var(--muted);
  font-size: 11px;
  padding: 4px 12px 2px;
  margin: 0;
  border-left: 2px solid var(--border);
  letter-spacing: 0.02em;
}
.nav-subgroup .nav-link { padding-left: 22px; }
</style>