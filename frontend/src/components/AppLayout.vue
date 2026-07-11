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
        <template v-if="auth.isAdmin">
          <div class="divider">管理</div>
          <router-link to="/admin/users">用户</router-link>
          <router-link to="/admin/roles">角色</router-link>
          <router-link to="/admin/sites">当前可用站点</router-link>
          <router-link to="/admin/dcs">当前可用服务器</router-link>
          <router-link to="/admin/config">系统配置</router-link>
          <router-link to="/admin/audit">审计日志</router-link>
        </template>
      </nav>
    </aside>
    <main>
      <header class="topbar">
        <span>{{ auth.user?.username }} <small>({{ auth.user?.role }})</small></span>
        <button @click="logout">退出</button>
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
.divider { font-size: 12px; color: var(--muted); margin: 12px 0 4px; }
main { display: flex; flex-direction: column; }
.topbar { display: flex; justify-content: space-between; align-items: center; padding: 10px 20px; background: var(--panel); border-bottom: 1px solid #1e293b; }
.content { padding: 20px; overflow: auto; }
</style>