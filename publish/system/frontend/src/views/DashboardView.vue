<template>
  <AppLayout>
    <h2>总览</h2>
    <StatusBar />
    <p style="color: var(--muted);">从左侧导航进入各详细页面。</p>
  </AppLayout>
</template>

<script setup>
import AppLayout from '../components/AppLayout.vue';
import StatusBar from '../components/StatusBar.vue';
</script>