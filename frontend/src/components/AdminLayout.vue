<template>
  <div class="layout">
    <aside class="sidebar">
      <router-link to="/" class="back">← 返回看板</router-link>
      <h3>AD Dashboard · 管理</h3>
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

const groups = [
  { title: '账号管理', items: [
    { label: '用户',     path: '/admin/users' },
    { label: '角色',     path: '/admin/roles' }
  ]},
  { title: '服务器管理', items: [
    { label: '非 AD 服务器', path: '/admin/member-servers' },
    { label: '非 AD 服务器组', path: '/admin/server-groups' }
  ]},
  { title: '目录管理', items: [
    { label: 'AD 站点清单', path: '/admin/sites-catalog' },
    { label: 'AD 域控清单', path: '/admin/dcs-catalog' }
  ]},
  { title: '监控运维', items: [
    { label: '站点复制矩阵', path: '/admin/site-replication-matrix' },
    { label: '端口健康检查', path: '/admin/ports' },
    { label: '心跳与报告', path: '/admin/heartbeat-report' },
    { label: '包管理',     path: '/admin/packages' }
  ]},
  { title: '系统设置', items: [
    { label: '系统配置', path: '/admin/config' },
    { label: '邮件配置', path: '/admin/email-config' },
    { label: '审计日志', path: '/admin/audit' },
    { label: '迁移管理', path: '/admin/migrations' },
    { label: '未签名 Schema 残留', path: '/admin/orphan-schemas' }
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
</style>