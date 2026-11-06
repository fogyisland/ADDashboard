<template>
  <AdminLayout>
    <div class="rc-page">
      <router-view />
    </div>
  </AdminLayout>
</template>

<script setup>
// R158.110 (2026-10-16) — 报表中心 parent shell. 跟 R158.77 member-server
// parent 1:1 平行 (R158.77.1 教训 0 顶部 sub-tab strip, 走 sidebar 切子
// 路由). AdminLayout (admin-only chrome) 包裹, 跟其它 admin 1:1 平行.
import AdminLayout from '../components/AdminLayout.vue';
</script>

<style scoped>
.rc-page { padding: 16px 0; }
</style>
