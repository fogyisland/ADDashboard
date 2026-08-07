<template>
  <AdminLayout>
    <div class="header">
      <h2>心跳与报告监控</h2>
      <div class="refresh-toggle">
        自动刷新:
        <select v-model.number="refreshIntervalSeconds">
          <option :value="5">5 秒</option>
          <option :value="10">10 秒</option>
          <option :value="30">30 秒</option>
          <option :value="0">关闭</option>
        </select>
      </div>
    </div>
    <div class="tabs">
      <button data-test="tab-agent" :class="{active: tab==='agent'}" @click="tab='agent'">按 Agent</button>
      <button data-test="tab-dc"    :class="{active: tab==='dc'}"    @click="tab='dc'">按 DC</button>
    </div>
    <div v-if="error" class="error-banner" data-test="error-banner">{{ error }}</div>
    <h3>心跳表</h3>
    <table class="t">
      <thead><tr><th>状态</th><th>{{ tab==='agent' ? 'Agent' : 'DC' }} 名称</th><th v-if="tab==='dc'">站点</th><th>最新心跳时间</th><th>延迟</th></tr></thead>
      <tbody>
        <tr v-for="row in rows" :key="row.agentId" :data-test="'heartbeat-row'" :data-status="statusOf(row)" @click="openDrawer(row)">
          <td><span :class="['dot', statusOf(row)]"></span> {{ statusLabel(row) }}</td>
          <td>{{ row.agentId }}</td>
          <td v-if="tab==='dc'">{{ row.siteName || '—' }}</td>
          <td>{{ formatRelative(row.lastHeartbeatAt) }}</td>
          <td>{{ formatLatency(row.lastHeartbeatAt) }}</td>
        </tr>
        <tr v-if="!rows.length"><td :colspan="tab === 'dc' ? 5 : 4" class="empty">暂无 Agent — 等待心跳上报</td></tr>
      </tbody>
    </table>

    <h3>报告表</h3>
    <table class="t">
      <thead><tr><th>状态</th><th>{{ tab==='agent' ? 'Agent' : 'DC' }} 名称</th><th>最近报告</th><th>错误摘要</th><th>成功率</th></tr></thead>
      <tbody>
        <tr v-for="row in rows" :key="row.agentId" :data-test="'report-row'" @click="openDrawer(row)">
          <td>{{ reportStatusLabel(row) }}</td>
          <td>{{ row.agentId }}</td>
          <td>{{ formatRelative(row.lastReportAt) }}</td>
          <td>{{ row.reportSummary?.latestErrorMessage || '—' }}</td>
          <td v-if="row.reportSummary">{{ row.reportSummary.successCount }} / {{ row.reportSummary.totalLinks }}</td>
          <td v-else>—</td>
        </tr>
        <tr v-if="!rows.length"><td colspan="4" class="empty">暂无报告 — 等待心跳上报</td></tr>
      </tbody>
    </table>

    <div v-if="drawerAgentId" data-test="drawer" class="drawer-bg" @click.self="drawerAgentId=null">
      <div class="drawer">
        <h3>{{ drawerAgentId }} 最近报告</h3>
        <pre>{{ JSON.stringify(drawerPayload, null, 2) }}</pre>
        <button @click="drawerAgentId=null">关闭</button>
      </div>
    </div>
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { heartbeatReportApi } from '../../api/heartbeatReport.js';

const tab = ref('agent');
const agentsRows = ref([]);
const dcsRows = ref([]);
const heartbeatStaleSeconds = ref(15);
const refreshIntervalSeconds = ref(5);
const drawerAgentId = ref(null);
const drawerPayload = ref(null);
const error = ref(null);
let timer = null;

const rows = computed(() => tab.value === 'agent' ? agentsRows.value : dcsRows.value);

function statusOf(row) {
  if (!row.lastHeartbeatAt) return 'never';
  const gap = (Date.now() - new Date(row.lastHeartbeatAt).getTime()) / 1000;
  if (gap <= heartbeatStaleSeconds.value) return 'green';
  // Yellow band: up to 4× the stale threshold. Keeps the band visible even when heartbeat_stale_seconds > 60.
  if (gap <= heartbeatStaleSeconds.value * 4) return 'yellow';
  return 'red';
}
function statusLabel(row) {
  return { green: '在线', yellow: '延迟', red: '掉线', never: '未上报' }[statusOf(row)];
}
function reportStatusLabel(row) {
  if (!row.lastReportAt) return '⏸ 未上传';
  if (!row.reportSummary) return '?';
  if (row.reportSummary.failCount === 0) return '✅ OK';
  return '⚠️ 部分失败';
}
function formatRelative(s) {
  if (!s) return '—';
  const gap = Math.round((Date.now() - new Date(s).getTime()) / 1000);
  if (gap < 60) return `${gap} 秒前`;
  if (gap < 3600) return `${Math.round(gap / 60)} 分钟前`;
  return `${Math.round(gap / 3600)} 小时前`;
}
function formatLatency(s) {
  if (!s) return '—';
  return `${Math.round((Date.now() - new Date(s).getTime()) / 1000)}s`;
}

async function load() {
  try {
    if (tab.value === 'agent') {
      const r = await heartbeatReportApi.listAgents();
      agentsRows.value = r.data?.agents || [];
      heartbeatStaleSeconds.value = r.data?.heartbeatStaleSeconds || 15;
    } else {
      const r = await heartbeatReportApi.listDcs();
      dcsRows.value = r.data?.agents || [];
      heartbeatStaleSeconds.value = r.data?.heartbeatStaleSeconds || 15;
    }
    error.value = null;
  } catch (e) {
    // Keep last good rows so the table still shows data; surface the error to the operator.
    error.value = e?.message || '加载失败';
  }
}
function startTimer() {
  stopTimer();
  if (refreshIntervalSeconds.value > 0) {
    timer = setInterval(load, refreshIntervalSeconds.value * 1000);
  }
}
function stopTimer() {
  if (timer) { clearInterval(timer); timer = null; }
}
async function openDrawer(row) {
  drawerAgentId.value = row.agentId;
  drawerPayload.value = null;
  try {
    const r = await heartbeatReportApi.getDetail(row.agentId);
    drawerPayload.value = r.data;
  } catch (e) {
    drawerPayload.value = null;
    error.value = e?.message || '加载详情失败';
  }
}

onMounted(async () => {
  try { await load(); } catch {} finally { startTimer(); }
});
onBeforeUnmount(stopTimer);
watch(tab, () => load());
watch(refreshIntervalSeconds, startTimer);
</script>

<style scoped>
.t { width: 100%; border-collapse: collapse; background: var(--panel); margin-bottom: 24px; }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
.tabs { display: flex; gap: 8px; margin: 12px 0; }
.tabs button { padding: 6px 14px; border: 1px solid #1e293b; background: var(--panel); color: var(--text); border-radius: 3px; cursor: pointer; }
.tabs button.active { background: var(--accent); color: #0b1220; }
.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
.dot.green  { background: #10b981; }
.dot.yellow { background: #f59e0b; }
.dot.red    { background: #ef4444; }
.dot.never  { background: #6b7280; }
.empty { text-align: center; color: var(--muted); padding: 24px; }
.error-banner { background: #7f1d1d; color: #fee2e2; border: 1px solid #b91c1c; padding: 10px 14px; margin: 12px 0; border-radius: 4px; font-size: 13px; }
.header { display: flex; justify-content: space-between; align-items: center; }
.refresh-toggle { color: var(--muted); font-size: 13px; }
.refresh-toggle select { background: #0b1220; color: var(--text); border: 1px solid #1e293b; padding: 4px 8px; }
.drawer-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; justify-content: flex-end; z-index: 100; }
.drawer { background: var(--panel); padding: 20px; width: 600px; max-width: 100%; height: 100vh; overflow: auto; }
.drawer pre { background: #0b1220; padding: 12px; border-radius: 3px; font-size: 11px; max-height: 70vh; overflow: auto; }
</style>