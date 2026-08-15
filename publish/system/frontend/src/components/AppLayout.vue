<template>
  <div class="layout">
    <aside class="sidebar">
      <h3>AD Dashboard</h3>
      <nav>
        <router-link to="/">概览</router-link>
        <router-link to="/matrix">站点矩阵</router-link>
        <router-link to="/topology">复制拓扑</router-link>
        <router-link to="/errors">错误链路</router-link>
        <router-link to="/agents">Agent 列表</router-link>
        <router-link to="/dashboard/metrics">指标看板</router-link>
        <router-link to="/servers-overview">服务器总览</router-link>
      </nav>
    </aside>
    <main>
      <header class="topbar">
        <span>{{ auth.user?.username }} <small>({{ auth.user?.role }})</small></span>
        <div class="topbar-actions">
          <button v-if="auth.isAdmin" class="admin-entry" @click="router.push('/admin/users')">管理</button>
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
const auth = useAuthStore();
const router = useRouter();
function logout() { auth.logout(); router.push('/login'); }
</script>

<style scoped>
.layout { display: grid; grid-template-columns: 220px 1fr; height: 100vh; }
.sidebar { background: #0b1220; padding: 20px; }
.sidebar h3 { color: var(--accent); margin: 0 0 16px; }
.sidebar nav { display: flex; flex-direction: column; gap: 6px; }
.sidebar a { padding: 8px 10px; border-radius: 4px; color: var(--text); }
.sidebar a.router-link-active, .sidebar a:hover { background: #1e293b; }
main { display: flex; flex-direction: column; }
.topbar { display: flex; justify-content: space-between; align-items: center; padding: 10px 20px; background: var(--panel); border-bottom: 1px solid #1e293b; }
.topbar-actions { display: flex; gap: 8px; align-items: center; }
.topbar-actions button { padding: 6px 14px; border: 1px solid #1e293b; border-radius: 3px; cursor: pointer; }
.topbar-actions .admin-entry { background: var(--accent); color: #0b1220; }
.topbar-actions .admin-entry:hover { filter: brightness(1.1); }
.topbar-actions button:not(.admin-entry) { background: #0b1220; color: var(--text); }
.content { padding: 20px; overflow: auto; }
</style>