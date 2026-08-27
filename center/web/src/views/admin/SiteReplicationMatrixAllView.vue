<template>
  <AdminLayout>
    <header>
      <h2>全站点复制矩阵</h2>
      <div class="controls">
        <span class="refresh-indicator">
          <span :class="['dot', polling ? 'on' : 'off']"></span>
          <span>每 {{ refreshSeconds }}s 刷新</span>
        </span>
        <span class="last-loaded" v-if="lastLoadedAt">最近刷新: {{ fmt(lastLoadedAt) }}</span>
        <router-link to="/admin/site-replication-matrix" class="alt-link">单站点视图 ↗</router-link>
      </div>
    </header>

    <p class="hint">
      站点按 中心 → 分支 顺序排列; 每个站点下方是该站 DC×DC 矩阵 (本域复制),
      再下方是跨站点链路 (出/入) 及每个链路的端口级探测状态。
    </p>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="!sites.length && !error" class="empty">暂无站点 — 请在 AD 站点清单添加</div>

    <section v-for="site in sites" :key="site.siteId" class="site-block">
      <h3>
        <span :class="['hub-badge', site.isHub ? 'yes' : 'no']">{{ site.isHub ? '中心' : '分支' }}</span>
        {{ site.siteName }}
        <small class="region">{{ site.regionCode || '—' }}</small>
        <small class="dc-count">{{ site.dcs.length }} DC</small>
      </h3>

      <!-- WITHIN-SITE MATRIX -->
      <h4>本域复制 ({{ site.dcs.length }}×{{ site.dcs.length }})</h4>
      <div v-if="!site.dcs.length" class="empty">该站点暂无 DC</div>
      <table v-else class="matrix" :data-test-site="site.siteName">
        <thead><tr><th></th><th v-for="dc in site.dcs" :key="dc.dcName">{{ dc.dcName }}</th></tr></thead>
        <tbody>
          <tr v-for="row in site.dcs" :key="row.dcName">
            <th>{{ row.dcName }}</th>
            <td v-for="col in site.dcs" :key="col.dcName"
                :class="cellClass(site, row.dcName, col.dcName)">
              <span v-if="row.dcName === col.dcName">-</span>
              <span v-else-if="withinStatus(site, row.dcName, col.dcName) === 'ok'">●</span>
              <span v-else-if="withinStatus(site, row.dcName, col.dcName) === 'warn'">▲</span>
              <span v-else-if="withinStatus(site, row.dcName, col.dcName) === 'err'">✕</span>
              <span v-else>·</span>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- CROSS-SITE LISTS -->
      <div class="cross">
        <h4>跨站点 · 出 ({{ site.crossOut.length }})</h4>
        <div v-if="!site.crossOut.length" class="empty">无</div>
        <ul v-else class="link-list">
          <li v-for="l in site.crossOut" :key="`out-${l.source}-${l.target}`"
              :class="['link', `link-${linkStatusClass(l)}`]"
              :data-test="`cross-out-${l.source}-${l.target}`">
            <span class="endpoints">{{ l.source }} → {{ l.target }}</span>
            <span class="site-arrow">→ {{ l.targetSite }}</span>
            <span class="port-row" v-if="l.perPort">
              <span v-for="p in ports" :key="`${l.source}-${l.target}-${p}`"
                    :class="['port', `port-${portStatusClass(l.perPort, p)}`]"
                    :title="portTooltip(l.perPort, p)">{{ p }}</span>
            </span>
            <span v-else class="port-row empty">未探测</span>
          </li>
        </ul>

        <h4>跨站点 · 入 ({{ site.crossIn.length }})</h4>
        <div v-if="!site.crossIn.length" class="empty">无</div>
        <ul v-else class="link-list">
          <li v-for="l in site.crossIn" :key="`in-${l.source}-${l.target}`"
              :class="['link', `link-${linkStatusClass(l)}`]"
              :data-test="`cross-in-${l.source}-${l.target}`">
            <span class="endpoints">{{ l.sourceSite }} / {{ l.source }} → {{ l.target }}</span>
            <span class="port-row" v-if="l.perPort">
              <span v-for="p in ports" :key="`in-${l.source}-${l.target}-${p}`"
                    :class="['port', `port-${portStatusClass(l.perPort, p)}`]"
                    :title="portTooltip(l.perPort, p)">{{ p }}</span>
            </span>
            <span v-else class="port-row empty">未探测</span>
          </li>
        </ul>
      </div>
    </section>
  </AdminLayout>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { dashboardApi } from '../../api/dashboard.js';

const sites = ref([]);
const ports = ref([]);
const refreshSeconds = ref(10);
const lastLoadedAt = ref(null);
const error = ref('');
const polling = ref(false);
let timerHandle = null;

async function load() {
  polling.value = true;
  error.value = '';
  try {
    const r = await dashboardApi.getSiteReplicationMatrixAll();
    sites.value = Array.isArray(r.data?.sites) ? r.data.sites : [];
    ports.value = Array.isArray(r.data?.ports) ? r.data.ports : [];
    refreshSeconds.value = Number(r.data?.siteRefreshSeconds) || 10;
    lastLoadedAt.value = new Date().toISOString();
  } catch (e) {
    error.value = e?.response?.data?.error || '加载失败';
  } finally {
    polling.value = false;
  }
}

function withinStatus(site, src, tgt) {
  if (src === tgt) return 'self';
  const link = site.withinLinks.find(l => l.source === src && l.target === tgt);
  if (!link) return 'none';
  if (link.statusCode === 0) return 'ok';
  if (link.statusCode === 1) return 'warn';
  return 'err';
}
function cellClass(site, src, tgt) {
  return { cell: true, [`cell-${withinStatus(site, src, tgt)}`]: true };
}
function linkStatusClass(link) {
  if (link.statusCode === 0) return 'ok';
  if (link.statusCode === 1) return 'warn';
  return 'err';
}
function portStatusClass(perPort, p) {
  const e = perPort?.[String(p)];
  if (!e) return 'none';
  if (e.reachable === true) return 'ok';
  if (e.reachable === false) return 'err';
  return 'warn';
}
function portTooltip(perPort, p) {
  const e = perPort?.[String(p)];
  if (!e) return `${p}: 未探测`;
  const status = e.reachable === true ? '可达' : e.reachable === false ? '不可达' : '未知';
  const lat = e.latencyMs != null ? ` ${e.latencyMs}ms` : '';
  const err = e.error ? ` — ${e.error}` : '';
  return `${p}: ${status}${lat}${err}`;
}
function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }

onMounted(async () => {
  await load();
  timerHandle = setInterval(load, refreshSeconds.value * 1000);
});
onUnmounted(() => { if (timerHandle) clearInterval(timerHandle); });
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
.cell { cursor: default; font-size: 14px; }
.cell-ok    { color: #22c55e; }
.cell-warn  { color: #f59e0b; }
.cell-err   { color: #ef4444; font-weight: 600; }
.cell-none  { color: #475569; }
.cell-self  { color: #334155; }
.detail-panel { margin-top: 16px; padding: 12px; background: var(--panel); border-radius: 4px; font-size: 13px; }

.site-block { margin-bottom: 24px; padding: 16px; border: 1px solid #1e293b; border-radius: 4px; background: var(--panel); }
.site-block h3 { display: flex; align-items: baseline; gap: 8px; margin: 0 0 12px; }
.site-block h4 { margin: 16px 0 8px; font-size: 13px; color: var(--muted); font-weight: 600; }
.hub-badge { padding: 2px 8px; border-radius: 999px; font-size: 11px; margin-right: 4px; }
.hub-badge.yes { background: #14532d; color: #bbf7d0; }
.hub-badge.no  { background: #1e293b; color: var(--muted); }
.region { color: var(--muted); font-size: 12px; }
.dc-count { color: var(--muted); font-size: 12px; margin-left: auto; }
.link-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
.link { padding: 6px 10px; border-radius: 3px; display: flex; gap: 12px; align-items: center; font-size: 13px; background: var(--panel-alt); flex-wrap: wrap; }
.link-ok   { border-left: 3px solid #22c55e; }
.link-warn { border-left: 3px solid #f59e0b; }
.link-err  { border-left: 3px solid #ef4444; }
.endpoints { font-family: ui-monospace, monospace; min-width: 220px; }
.site-arrow { color: var(--muted); font-size: 12px; }
.port-row  { display: flex; gap: 4px; }
.port-row.empty { color: var(--muted); font-size: 12px; }
.port { display: inline-block; min-width: 44px; padding: 2px 6px; border-radius: 3px; font-family: ui-monospace, monospace; font-size: 12px; text-align: center; }
.port-ok   { background: var(--green-bg); color: var(--green); }
.port-err  { background: var(--red-bg);   color: var(--red); }
.port-warn { background: rgba(234,179,8,0.12); color: var(--yellow); }
.port-none { background: #1e293b; color: #475569; }
.hint { color: var(--muted); font-size: 12px; margin: 0 0 16px; }
.alt-link { color: var(--accent); font-size: 12px; text-decoration: none; margin-left: 12px; }
.error-banner { background: var(--red-bg); color: var(--red); padding: 8px 12px; border-radius: 3px; margin-bottom: 12px; }
</style>
