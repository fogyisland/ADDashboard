<template>
  <AdminLayout>
    <div class="header">
      <h2>复制目标端口可达性</h2>
      <div class="controls">
        <span class="refresh-indicator">
          <span :class="['dot', polling ? 'on' : 'off']"></span>
          <span>{{ refreshSeconds }}s 自动刷新</span>
        </span>
        <router-link to="/admin/ports" class="manage-link" data-test="manage-ports-link">
          管理探测端口 ↗
        </router-link>
      </div>
    </div>

    <p class="hint">
      每个 Agent 通过中心返回的 TCP 端口列表探测其复制伙伴。
      端口配置在
      <router-link to="/admin/ports" class="inline-link">端口健康检查</router-link>
      页面维护,变更后所有 Agent 在下一次采集周期自动生效,无需重新安装。
      <span class="last-loaded" v-if="lastLoadedAt">最近刷新: {{ fmt(lastLoadedAt) }}</span>
    </p>

    <div v-if="error" class="error-banner">{{ error }}</div>

    <h3>当前探测端口 ({{ ports.length }})</h3>
    <div class="port-chips">
      <span v-for="p in ports" :key="p" class="chip" :data-port="p">{{ p }}</span>
      <span v-if="!ports.length" class="empty">未配置 — Agent 将回退到默认端口</span>
    </div>

    <h3>复制链路探测结果</h3>
    <div v-if="!rows.length" class="empty">暂无数据 — Agent 上报后将在此显示</div>
    <table v-else class="t" data-test="replication-port-table">
      <thead>
        <tr>
          <th>状态</th>
          <th>源 DC</th>
          <th>源站点</th>
          <th>目标 DC</th>
          <th>目标站点</th>
          <th v-for="p in ports" :key="p" :data-test="'port-col'" :data-port="p">:{{ p }}</th>
          <th>最近探测</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="rowKey(row)" :data-test="'pair-row'" :data-source="row.sourceDc" :data-dest="row.destDc">
          <td>
            <span :class="['dot', pairStatus(row)]"></span>
            {{ pairLabel(row) }}
          </td>
          <td>{{ row.sourceDc }}</td>
          <td>{{ row.sourceSite || '—' }}</td>
          <td>{{ row.destDc }}</td>
          <td>{{ row.destSite || '—' }}</td>
          <td v-for="p in ports" :key="p" :class="cellClass(row, p)" :data-test="'port-cell'" :data-port="p">
            <span v-if="portCellIcon(row, p) === 'ok'">●</span>
            <span v-else-if="portCellIcon(row, p) === 'err'">✕</span>
            <span v-else-if="portCellIcon(row, p) === 'warn'">▲</span>
            <span v-else>·</span>
            <small v-if="portLatency(row, p) != null" class="latency">{{ portLatency(row, p) }}ms</small>
          </td>
          <td>{{ fmt(row.lastAttemptTime || row.collectedAt) }}</td>
        </tr>
      </tbody>
    </table>
  </AdminLayout>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { adminApi } from '../../api/admin.js';

const ports = ref([]);
const rows = ref([]);
const error = ref('');
const lastLoadedAt = ref(null);
const refreshSeconds = ref(30);
const polling = ref(false);

let timerHandle = null;

function rowKey(row) {
  return `${row.sourceDc || '?'}->${row.destDc || '?'}`;
}

async function load() {
  polling.value = true;
  error.value = '';
  try {
    const { data } = await adminApi.getReplicationPortStatus();
    ports.value = Array.isArray(data?.ports) ? data.ports : [];
    rows.value = Array.isArray(data?.rows) ? data.rows : [];
    lastLoadedAt.value = new Date().toISOString();
  } catch (e) {
    error.value = e?.response?.data?.error || '加载失败';
  } finally {
    polling.value = false;
  }
}

function portCellIcon(row, port) {
  const entry = row.perPort?.[String(port)];
  if (!entry) return 'none';
  if (entry.reachable === true) return 'ok';
  if (entry.reachable === false) return 'err';
  return 'warn';
}

function portLatency(row, port) {
  const entry = row.perPort?.[String(port)];
  return entry?.latencyMs ?? null;
}

function cellClass(_row, port) {
  return ['cell', `cell-${port}`];
}

function pairStatus(row) {
  // Pair-level status = worst across configured ports. All unreached = 'err'.
  // Reachable set non-empty but at least one unreachable = 'warn'.
  if (!ports.value.length) return 'none';
  const entries = ports.value.map((p) => row.perPort?.[String(p)]).filter(Boolean);
  if (!entries.length) return 'none';
  if (entries.every((e) => e.reachable === true)) return 'ok';
  if (entries.every((e) => e.reachable === false)) return 'err';
  return 'warn';
}

function pairLabel(row) {
  const s = pairStatus(row);
  if (s === 'ok') return '全通';
  if (s === 'warn') return '部分通';
  if (s === 'err') return '不通';
  return '—';
}

function fmt(s) {
  if (!s) return '-';
  return new Date(s).toLocaleString('zh-CN', { hour12: false });
}

onMounted(async () => {
  await load();
  timerHandle = setInterval(load, refreshSeconds.value * 1000);
});

onUnmounted(() => {
  if (timerHandle) clearInterval(timerHandle);
});
</script>

<style scoped>
.header { display: flex; justify-content: space-between; align-items: center; }
.controls { display: flex; gap: 12px; align-items: center; }
.refresh-indicator { color: var(--muted); font-size: 12px; display: flex; gap: 6px; align-items: center; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.dot.on  { background: #22c55e; }
.dot.off { background: #475569; }
.manage-link {
  padding: 6px 12px;
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--accent);
  border-radius: 3px;
  cursor: pointer;
  font-weight: 600;
  text-decoration: none;
  font-size: 13px;
}
.manage-link:hover { background: var(--accent); color: #0b1220; }
.inline-link { color: var(--accent); text-decoration: none; }
.inline-link:hover { text-decoration: underline; }

.hint { color: var(--muted); font-size: 13px; margin: 0 0 12px; }
.last-loaded { margin-left: 12px; color: var(--muted); font-size: 12px; }
.error-banner { background: #7f1d1d; color: #fef2f2; padding: 10px 12px; border-radius: 4px; margin-bottom: 12px; font-size: 13px; }

h3 { margin-top: 24px; }
.port-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.chip { display: inline-block; padding: 3px 10px; background: #1e293b; border-radius: 999px; font-family: ui-monospace, monospace; font-size: 12px; color: var(--text); }

.t { width: 100%; border-collapse: collapse; background: var(--panel); }
.t th, .t td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #1e293b; font-size: 13px; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
.cell { text-align: center; white-space: nowrap; }
.latency { display: block; font-size: 10px; color: var(--muted); }
.cell :is(.ok, .warn, .err, .none) { font-size: 14px; }
.cell-ok    { color: #22c55e; }
.cell-warn  { color: #f59e0b; }
.cell-err   { color: #ef4444; font-weight: 600; }
.cell-none  { color: #475569; }
.empty { text-align: center; color: var(--muted); padding: 24px; }
</style>