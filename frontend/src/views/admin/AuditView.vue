<template>
  <AppLayout>
    <h2>审计日志</h2>
    <table class="t">
      <thead><tr><th>时间</th><th>用户</th><th>动作</th><th>目标</th><th>详情</th></tr></thead>
      <tbody>
        <tr v-for="r in rows" :key="r.id">
          <td>{{ fmt(r.createdAt) }}</td>
          <td>{{ r.userId || '-' }}</td>
          <td>{{ r.action }}</td>
          <td>{{ r.target || '-' }}</td>
          <td><code>{{ r.payload || '' }}</code></td>
        </tr>
      </tbody>
    </table>
  </AppLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import AppLayout from '../../components/AppLayout.vue';
import { adminApi } from '../../api/admin.js';
const rows = ref([]);
async function load() { rows.value = (await adminApi.getAudit(200)).data; }
function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }
onMounted(load);
</script>

<style scoped>
.t { width: 100%; border-collapse: collapse; background: var(--panel); }
.t th, .t td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #1e293b; font-size: 13px; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
code { font-size: 11px; color: var(--muted); word-break: break-all; }
</style>
