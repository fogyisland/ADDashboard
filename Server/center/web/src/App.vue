<template>
  <router-view />
  <ErrorBanner />
  <!-- R158.X.99.34.d (2026-10-19) — in-app drawer mounted globally
       (跟 ErrorBanner 平行 Teleport to body). 0 改 router-view 流程. -->
  <InAppDrawer />
</template>

<script setup>
// useTheme's module init reads localStorage and applies data-theme to
// <html> before this component mounts, so by the time the router-view
// renders, the theme is already set. Nothing else to do here.
import { useTheme } from './composables/useTheme.js';
import ErrorBanner from './components/ErrorBanner.vue';
// R158.X.99.34.d (2026-10-19) — in-app notification drawer.
//   操作员 directive "操作员登录 dashboard 后, 在 dashboard 内部推送/显示告警
//   消息给管理员". 跟 ErrorBanner 平行 Teleport-to-body, 跨所有 view 可见.
import InAppDrawer from './components/InAppDrawer.vue';
useTheme();
</script>