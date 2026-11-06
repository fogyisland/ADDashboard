<!-- R158.77 (2026-10-11) — member-server 父视图. 替换 R158.73
     placeholder, 提供 AppLayout chrome + <router-view> 渲染子路由.

     R158.77.1 (2026-10-14) — operator 删顶部导航 (大字区 + 6 sub-tab 横条).
     "先删后补" 原则: 现在 user 从 sidebar jump /memberServer 顶入口, 其它 5 tab
     仍可经路由 / URL 直接进, 但 0 UI 切换入口 — 后续 R158.102+ 走 sidebar
     补 sub-tab 时再 add. 0 改 6 children route / 0 改 router / 0 改 6 child view
     / 0 改 sidebar.

     6 子路由 (1:1 保留 R158.77 既有):
       '' (home) → MemberServerHomeView
       'os-baseline' → MemberServerOsBaselineView
       'agents' → MemberServerAgentsView
       'ports' → MemberServerPortsView
       'eventlog' → MemberServerEventlogView
       'packages' → MemberServerPackagesView -->
<template>
  <AppLayout>
    <div class="ms-page">
      <router-view />
    </div>
  </AppLayout>
</template>

<script setup>
import AppLayout from '../components/AppLayout.vue';
</script>

<style scoped>
.ms-page { padding: 16px 0; }
</style>