<template>
  <AppLayout>
    <h2>正在复制的站点</h2>
    <p class="hint">从最近 <code>ad_replication_status</code> 中派生的站点列表, 反映 Agent 实际观察到拓扑。</p>
    <table class="t">
      <thead>
        <tr>
          <th>站点名</th>
          <th>链路数</th>
          <th>错误数</th>
          <th>最近上报</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="s in sites" :key="s.name">
          <td><code>{{ s.name }}</code></td>
          <td>{{ s.linkCount }}</td>
          <td :class="{ err: s.errorCount > 0 }">{{ s.errorCount }}</td>
          <td>{{ fmt(s.lastSeen) }}</td>
        </tr>
        <tr v-if="!sites.length"><td colspan="4" class="empty">暂无数据 — Agent 首次上报后会显示</td></tr>
      </tbody>
    </table>
  </AppLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import AppLayout from '../../components/AppLayout.vue';
import { adminApi } from '../../api/admin.js';
const sites = ref([]);
function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }
async function load() { sites.value = (await adminApi.listSites()).data; }
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
