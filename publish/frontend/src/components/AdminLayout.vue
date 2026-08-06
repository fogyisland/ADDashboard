<template>
  <div class="layout">
    <aside class="sidebar">
      <router-link to="/" class="back">← 返回看板</router-link>
      <h3>AD Dashboard · 管理</h3>
      <nav>
        <router-link to="/admin/users">用户</router-link>
        <router-link to="/admin/roles">角色</router-link>
        <router-link to="/admin/sites">正在复制的站点</router-link>
        <router-link to="/admin/dcs">正在复制的域控</router-link>
        <router-link to="/admin/config">系统配置</router-link>
        <router-link to="/admin/audit">审计日志</router-link>
        <router-link to="/admin/sites-catalog">AD 站点清单</router-link>
        <router-link to="/admin/dcs-catalog">AD 域控清单</router-link>
        <router-link to="/admin/site-replication-matrix">站点复制矩阵</router-link>
        <router-link to="/admin/ports">端口健康检查</router-link>
        <router-link to="/admin/packages">包管理</router-link>
        <router-link to="/admin/migrations">迁移管理</router-link>
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
.sidebar .back { display: block; color: var(--muted); font-size: 12px; margin-bottom: 12px; text-decoration: none; }
.sidebar .back:hover { color: var(--accent); }
.sidebar h3 { color: var(--accent); margin: 0 0 16px; font-size: 14px; }
.sidebar nav { display: flex; flex-direction: column; gap: 6px; }
.sidebar a { padding: 8px 10px; border-radius: 4px; color: var(--text); text-decoration: none; }
.sidebar a.router-link-active, .sidebar a:hover { background: #1e293b; }
main { display: flex; flex-direction: column; }
.topbar { display: flex; justify-content: space-between; align-items: center; padding: 10px 20px; background: var(--panel); border-bottom: 1px solid #1e293b; }
.content { padding: 20px; overflow: auto; }
</style>