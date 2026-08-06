<template>
  <AppLayout>
    <h2>用户锁定排查</h2>
    <p class="placeholder">功能开发中 — 详见后续 spec</p>
    <p v-if="dc" class="dc-link">排查 DC: <code>{{ dc }}</code></p>
    <p><router-link to="/servers-overview">← 返回服务器总览</router-link></p>
  </AppLayout>
</template>

<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';

const route = useRoute();
const dc = computed(() => route.query.dc || null);
</script>

<style scoped>
.placeholder { color: var(--muted); font-size: 14px; padding: 16px; background: var(--panel); border-left: 4px solid var(--accent); border-radius: 4px; }
.dc-link { font-size: 12px; color: var(--muted); }
.dc-link code { background: #0b1220; padding: 2px 6px; border-radius: 3px; }
</style>
