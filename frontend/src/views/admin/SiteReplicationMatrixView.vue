<template>
  <AppLayout>
    <h2>站点复制矩阵</h2>
    <div class="controls">
      <label>站点:
        <select v-model="selectedSite" @change="load">
          <option value="">— 选择站点 —</option>
          <option v-for="s in sites" :key="s.id" :value="s.siteName">{{ s.siteName }}</option>
        </select>
      </label>
      <span class="refresh-indicator">
        <span :class="['dot', polling ? 'on' : 'off']"></span>
        <span>每 {{ refreshSeconds }}s 刷新</span>
      </span>
    </div>

    <div v-if="!selectedSite" class="empty">请选择站点查看复制矩阵</div>
    <div v-else-if="!data.dcs.length" class="empty">该站点暂无 DC — 请先在 AD 域控清单分配</div>
    <table v-else class="matrix">
      <thead>
        <tr>
          <th></th>
          <th v-for="dc in data.dcs" :key="dc.dcName">{{ dc.dcName }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in data.dcs" :key="row.dcName">
          <th>{{ row.dcName }}</th>
          <td v-for="col in data.dcs" :key="col.dcName"
              :class="cellClass(row.dcName, col.dcName)"
              @click="onCellClick(row.dcName, col.dcName)">
            <span v-if="row.dcName === col.dcName">-</span>
            <span v-else-if="cellStatus(row.dcName, col.dcName) === 'ok'">●</span>
            <span v-else-if="cellStatus(row.dcName, col.dcName) === 'warn'">▲</span>
            <span v-else-if="cellStatus(row.dcName, col.dcName) === 'err'">✕</span>
            <span v-else>·</span>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="selectedLink" class="detail-panel">
      <strong>{{ selectedLink.source }} → {{ selectedLink.target }}</strong>
      ({{ selectedLink.namingContext }})
      — status={{ selectedLink.statusCode }}
      last_success={{ fmt(selectedLink.lastSuccessTime) }}
      duration={{ selectedLink.durationMinutes }}min
    </div>
  </AppLayout>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import AppLayout from '../../components/AppLayout.vue';
import { dashboardApi } from '../../api/dashboard.js';
import { adminApi } from '../../api/admin.js';

const sites = ref([]);
const selectedSite = ref('');
const data = ref({ site: null, dcs: [], links: [] });
const refreshSeconds = ref(10);
const selectedLink = ref(null);
const polling = ref(false);
let timerHandle = null;

async function load() {
  if (!selectedSite.value) return;
  polling.value = true;
  try {
    const r = await dashboardApi.getSiteReplicationMatrix(selectedSite.value);
    data.value = r.data;
    refreshSeconds.value = r.data.siteRefreshSeconds || 10;
  } finally {
    polling.value = false;
  }
}

function cellStatus(source, target) {
  if (source === target) return 'self';
  const link = data.value.links.find(l => l.source === source && l.target === target);
  if (!link) return 'none';
  if (link.statusCode === 0) return 'ok';
  if (link.statusCode === 1) return 'warn';
  return 'err';
}

function cellClass(source, target) {
  const s = cellStatus(source, target);
  return { cell: true, [`cell-${s}`]: true };
}

function onCellClick(source, target) {
  if (source === target) return;
  const link = data.value.links.find(l => l.source === source && l.target === target);
  selectedLink.value = link || null;
}

function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }

async function loadSites() {
  const r = await adminApi.listSitesCatalog();
  sites.value = r.data || [];
  if (!selectedSite.value && sites.value.length) {
    selectedSite.value = sites.value[0].siteName;
  }
}

onMounted(async () => {
  await loadSites();
  await load();
  timerHandle = setInterval(load, refreshSeconds.value * 1000);
});

onUnmounted(() => {
  if (timerHandle) clearInterval(timerHandle);
});
</script>

<style scoped>
.controls { display: flex; gap: 16px; align-items: center; margin-bottom: 16px; }
.controls select { padding: 4px; background: #0b1220; color: var(--text); border: 1px solid #1e293b; border-radius: 3px; }
.refresh-indicator { color: var(--muted); font-size: 12px; display: flex; gap: 6px; align-items: center; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.dot.on  { background: #22c55e; }
.dot.off { background: #475569; }
.empty { text-align: center; color: var(--muted); padding: 24px; }
.matrix { border-collapse: collapse; background: var(--panel); }
.matrix th, .matrix td { border: 1px solid #1e293b; padding: 8px 12px; text-align: center; }
.matrix th { background: #0b1220; color: var(--muted); font-size: 12px; }
.cell { cursor: pointer; font-size: 14px; }
.cell:hover { background: #1e293b; }
.cell-ok    { color: #22c55e; }
.cell-warn  { color: #f59e0b; }
.cell-err   { color: #ef4444; font-weight: 600; }
.cell-none  { color: #475569; }
.cell-self  { color: #334155; }
.detail-panel { margin-top: 16px; padding: 12px; background: var(--panel); border-radius: 4px; font-size: 13px; }
</style>
