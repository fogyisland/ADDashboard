<template>
  <AppLayout>
    <h2>正在复制的域控</h2>
    <p class="hint">从 Agent 报告 <code>ad_replication_status</code> 中派生的 DC 列表。</p>
    <table class="t">
      <thead>
        <tr>
          <th>DC 名</th>
          <th>所属站点</th>
          <th>链路数</th>
          <th>错误数</th>
          <th>最近上报</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="d in dcs" :key="d.name + (d.site || '')">
          <td><code>{{ d.name }}</code></td>
          <td>{{ d.site || '-' }}</td>
          <td>{{ d.linkCount }}</td>
          <td :class="{ err: d.errorCount > 0 }">{{ d.errorCount }}</td>
          <td>{{ fmt(d.lastSeen) }}</td>
        </tr>
        <tr v-if="!dcs.length"><td colspan="5" class="empty">暂无数据 — Agent 首次上报后会显示</td></tr>
      </tbody>
    </table>
  </AppLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import AppLayout from '../../components/AppLayout.vue';
import { adminApi } from '../../api/admin.js';
const dcs = ref([]);
function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }
async function load() { dcs.value = (await adminApi.listDcs()).data; }
onMounted(load);
</script>

<style scoped>
.t { width: 100%; border-collapse: collapse; background: var(--panel); }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
.empty { text-align: center; color: var(--muted); padding: 24px; }
.err { color: var(--red); font-weight: 600; }
.hint { color: var(--muted); font-size: 12px; margin: 0 0 12px; }
</style>
