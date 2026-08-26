<template>
  <AdminLayout>
    <div class="header">
      <h2>复制目标可达性</h2>
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

    <!-- 2026-08-27 round-23: site + server filter bar driven by the loaded
         rows themselves (no separate sites/DCs catalog fetch). -->
    <div class="filters" data-test="filters-bar">
      <label>站点
        <select v-model="filterSite" data-test="filter-site">
          <option value="">全部</option>
          <option v-for="s in availableSites" :key="s" :value="s">{{ s }}</option>
        </select>
      </label>
      <label>服务器
        <select v-model="filterServer" data-test="filter-server">
          <option value="">全部</option>
          <option v-for="s in availableServers" :key="s" :value="s">{{ s }}</option>
        </select>
      </label>
      <button class="reset-btn" @click="resetFilters" data-test="filter-reset">清除筛选</button>
    </div>

    <h3>当前探测端口 ({{ ports.length }})</h3>
    <div class="port-chips">
      <span v-for="p in ports" :key="p" class="chip" :data-port="p">{{ p }}</span>
      <span v-if="!ports.length" class="empty">未配置 — Agent 将回退到默认端口</span>
    </div>

    <h3>复制链路探测结果</h3>
    <div v-if="!rows.length" class="empty">暂无数据 — Agent 上报后将在此显示</div>
    <div v-else-if="!filteredRows.length" class="empty" data-test="filter-empty">无匹配筛选条件的链路</div>
    <table v-else class="t" data-test="replication-port-table">
      <thead>
        <tr>
          <th>站点</th>
          <th>源服务器</th>
          <th>目标服务器</th>
          <th v-for="p in ports" :key="p" :data-test="'port-col'" :data-port="p">:{{ p }}</th>
          <th>最近探测</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in filteredRows" :key="rowKey(row)" :data-test="'pair-row'" :data-source="row.sourceDc" :data-dest="row.destDc">
          <td>{{ row.sourceSite || row.destSite || '—' }}</td>
          <td>{{ row.sourceDc }}</td>
          <td>{{ row.destDc }}</td>
          <td v-for="p in ports" :key="p" :class="cellClass(row, p)" :data-test="'port-cell'" :data-port="p">
            <span :class="['port-icon', portCellIcon(row, p)]">{{ portCellGlyph(row, p) }}</span>
            <small v-if="portLatency(row, p) != null" class="latency">{{ portLatency(row, p) }}ms</small>
          </td>
          <td>{{ fmt(row.lastAttemptTime || row.collectedAt) }}</td>
        </tr>
      </tbody>
    </table>
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { adminApi } from '../../api/admin.js';

const ports = ref([]);
const rows = ref([]);
const error = ref('');
const lastLoadedAt = ref(null);
const refreshSeconds = ref(30);
const polling = ref(false);

// 2026-08-27 round-23: site + server filters. Bound to selects above the
// table; `filteredRows` is the live projection the table renders.
const filterSite = ref('');
const filterServer = ref('');

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

// Distinct sites seen across either source or dest side of any row. Used
// to populate the 站点 filter dropdown.
const availableSites = computed(() => {
  const set = new Set();
  for (const r of rows.value) {
    if (r.sourceSite) set.add(r.sourceSite);
    if (r.destSite) set.add(r.destSite);
  }
  return Array.from(set).sort();
});

// Distinct DC names across either side. Used for the 服务器 dropdown.
const availableServers = computed(() => {
  const set = new Set();
  for (const r of rows.value) {
    if (r.sourceDc) set.add(r.sourceDc);
    if (r.destDc) set.add(r.destDc);
  }
  return Array.from(set).sort();
});

// Apply filters. Site matches when sourceSite OR destSite equals the chosen
// value (a link crosses both sites; filtering by the row's "primary" site
// would hide cross-site pairs). Server matches when EITHER endpoint equals
// the chosen DC so operators can see all links touching a given DC.
const filteredRows = computed(() => {
  return rows.value.filter((r) => {
    if (filterSite.value && r.sourceSite !== filterSite.value && r.destSite !== filterSite.value) return false;
    if (filterServer.value && r.sourceDc !== filterServer.value && r.destDc !== filterServer.value) return false;
    return true;
  });
});

function resetFilters() {
  filterSite.value = '';
  filterServer.value = '';
}

// 2026-08-27 round-23: per-port glyph + class now drives a green/red cell
// BACKGROUND (not just icon color) so a wide table is readable at a glance.
// 'ok' → green background, 'err' → red background, 'warn'/'none' → muted.
function portCellIcon(row, port) {
  const entry = row.perPort?.[String(port)];
  if (!entry) return 'none';
  if (entry.reachable === true) return 'ok';
  if (entry.reachable === false) return 'err';
  return 'warn';
}

function portCellGlyph(row, port) {
  const s = portCellIcon(row, port);
  if (s === 'ok') return '✓';
  if (s === 'err') return '✕';
  if (s === 'warn') return '▲';
  return '·';
}

function portLatency(row, port) {
  const entry = row.perPort?.[String(port)];
  return entry?.latencyMs ?? null;
}

function cellClass(_row, port) {
  // We have to look up the row's status to bind it here; pass the row so
  // portCellIcon can be re-evaluated cheaply.
  const entry = _row.perPort?.[String(port)];
  let status = 'none';
  if (entry) {
    if (entry.reachable === true) status = 'ok';
    else if (entry.reachable === false) status = 'err';
    else status = 'warn';
  }
  return ['cell', `cell-${port}`, `cell-${status}`];
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

/* 2026-08-27 round-23: filter bar matches SiteReplicationMatrixView /
   MemberServersView conventions — bare selects styled by global theme. */
.filters { display: flex; gap: 16px; align-items: center; margin: 8px 0 16px; font-size: 13px; color: var(--muted); }
.filters select { padding: 4px; background: var(--input-bg); color: var(--text); border: 1px solid var(--border); border-radius: 3px; margin-left: 6px; }
.reset-btn { padding: 4px 10px; font-size: 12px; background: var(--input-bg); color: var(--text); border: 1px solid var(--border); border-radius: 3px; cursor: pointer; }
.reset-btn:hover { border-color: var(--accent); }

h3 { margin-top: 24px; }
.port-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.chip { display: inline-block; padding: 3px 10px; background: #1e293b; border-radius: 999px; font-family: ui-monospace, monospace; font-size: 12px; color: var(--text); }

.t { width: 100%; border-collapse: collapse; background: var(--panel); }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; font-size: 13px; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }

/* 2026-08-27 round-23: green = filled cell background, red = red cell,
   warn = amber, none = muted gray. The icon glyph centers vertically. */
.cell { text-align: center; white-space: nowrap; transition: background-color .15s; }
.cell-ok    { background-color: var(--green-bg); }
.cell-err   { background-color: var(--red-bg); }
.cell-warn  { background-color: rgba(234,179,8,0.12); }
.cell-none  { color: #475569; }
.port-icon { display: inline-block; width: 18px; font-weight: 600; font-size: 14px; }
.port-icon.ok { color: var(--green); }
.port-icon.err { color: var(--red); }
.port-icon.warn { color: var(--yellow); }
.port-icon.none { color: #475569; }
.latency { display: block; font-size: 10px; color: var(--muted); margin-top: 2px; }

.empty { text-align: center; color: var(--muted); padding: 24px; }
</style>