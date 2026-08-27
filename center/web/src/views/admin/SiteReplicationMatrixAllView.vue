<template>
  <AdminLayout>
    <header>
      <h2>站点复制矩阵 (按主机)</h2>
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
      每个站点的首台 DC (字母序;非 PDC 标记) 显示它与所有伙伴的复制连接 — 出站与入站双向。
      端口列来自 partner-port 探针;未探测的行显示灰色徽章。
    </p>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="!primaries.length && !error" class="empty">暂无主控 DC — 请在 AD 站点/DC 清单添加</div>

    <section v-for="p in primaries" :key="p.dcName" class="primary-block" :data-test-primary="p.dcName">
      <h3>
        <span :class="['hub-badge', p.isHub ? 'yes' : 'no']">{{ p.isHub ? '中心' : '分支' }}</span>
        {{ p.siteName }}
        <span class="primary-dc">→ {{ p.dcName }}</span>
        <span v-if="p.isBridgehead" class="bridgehead-badge" title="操作员指定的桥头 DC (inter-site replication bridgehead)">桥头</span>
        <span v-else class="bridgehead-badge none" title="该站点尚未指定桥头 DC;按字母序首台兜底">未指定</span>
        <small class="region">{{ p.regionCode || '—' }}</small>
        <small class="partner-count">{{ p.partners.length }} 伙伴</small>
      </h3>

      <table class="matrix">
        <thead>
          <tr>
            <th>方向</th>
            <th>伙伴站点</th>
            <th>伙伴 DC</th>
            <th>状态</th>
            <th v-for="port in ports" :key="`hdr-${p.dcName}-${port}`" class="port-hdr">{{ port }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="partner in p.partners" :key="`${partner.direction}-${partner.peerDc}`"
              :class="rowClass(partner)"
              :data-test="`partner-${partner.direction}-${p.dcName}-${partner.peerDc}`">
            <td class="dir">
              <span v-if="partner.direction === 'out'" class="dir-out">→ 出</span>
              <span v-else class="dir-in">← 入</span>
            </td>
            <td>
              <span class="peer-site">{{ partner.peerSite }}</span>
              <span v-if="partner.peerSiteIsHub" class="hub-mini">中心</span>
            </td>
            <td class="peer-dc">{{ partner.peerDc }}</td>
            <td class="status">{{ statusGlyph(partner) }} {{ statusLabel(partner) }}</td>
            <td v-for="port in ports" :key="`${partner.direction}-${p.dcName}-${partner.peerDc}-${port}`"
                :class="['port-cell', `port-${portStatusClass(partner.perPort, port)}`]"
                :title="portTooltip(partner.perPort, port)">{{ port }}</td>
          </tr>
          <tr v-if="!p.partners.length">
            <td :colspan="5 + ports.length" class="empty-row">无伙伴连接</td>
          </tr>
        </tbody>
      </table>
    </section>
  </AdminLayout>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { dashboardApi } from '../../api/dashboard.js';

const primaries = ref([]);
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
    primaries.value = Array.isArray(r.data?.primaries) ? r.data.primaries : [];
    ports.value = Array.isArray(r.data?.ports) ? r.data.ports : [];
    refreshSeconds.value = Number(r.data?.siteRefreshSeconds) || 10;
    lastLoadedAt.value = new Date().toISOString();
  } catch (e) {
    error.value = e?.response?.data?.error || '加载失败';
  } finally {
    polling.value = false;
  }
}

function statusGlyph(p) {
  if (p.statusCode === 0) return '●';
  if (p.statusCode === 1) return '▲';
  return '✕';
}
function statusLabel(p) {
  if (p.statusCode === 0) return '成功';
  if (p.statusCode === 1) return '部分失败';
  return '失败';
}
function rowClass(p) {
  return {
    'partner-row': true,
    'status-ok':   p.statusCode === 0,
    'status-warn': p.statusCode === 1,
    'status-err':  p.statusCode > 1
  };
}
function portStatusClass(perPort, port) {
  const e = perPort?.[String(port)];
  if (!e) return 'none';
  if (e.reachable === true) return 'ok';
  if (e.reachable === false) return 'err';
  return 'warn';
}
function portTooltip(perPort, port) {
  const e = perPort?.[String(port)];
  if (!e) return `${port}: 未探测`;
  const status = e.reachable === true ? '可达' : e.reachable === false ? '不可达' : '未知';
  const lat = e.latencyMs != null ? ` ${e.latencyMs}ms` : '';
  const err = e.error ? ` — ${e.error}` : '';
  return `${port}: ${status}${lat}${err}`;
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
.refresh-indicator { color: var(--muted); font-size: 12px; display: flex; gap: 6px; align-items: center; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.dot.on  { background: #22c55e; }
.dot.off { background: #475569; }
.hint { color: var(--muted); font-size: 12px; margin: 0 0 16px; }
.alt-link { color: var(--accent); font-size: 12px; text-decoration: none; margin-left: 12px; }
.error-banner { background: var(--red-bg); color: var(--red); padding: 8px 12px; border-radius: 3px; margin-bottom: 12px; }
.empty { text-align: center; color: var(--muted); padding: 24px; }

.primary-block { margin-bottom: 24px; padding: 16px; border: 1px solid #1e293b; border-radius: 4px; background: var(--panel); }
.primary-block h3 { display: flex; align-items: baseline; gap: 8px; margin: 0 0 12px; }
.hub-badge { padding: 2px 8px; border-radius: 999px; font-size: 11px; margin-right: 4px; }
.hub-badge.yes { background: #14532d; color: #bbf7d0; }
.hub-badge.no  { background: #1e293b; color: var(--muted); }
.primary-dc { font-family: ui-monospace, monospace; font-weight: 600; }
.bridgehead-badge { font-size: 10px; padding: 1px 8px; margin-left: 6px; border-radius: 999px;
                    background: #0e7490; color: #cffafe; font-weight: 600; letter-spacing: 0.05em; }
.bridgehead-badge.none { background: #1e293b; color: var(--muted); font-weight: 400; }
.region { color: var(--muted); font-size: 12px; }
.partner-count { color: var(--muted); font-size: 12px; margin-left: auto; }
.hub-mini { font-size: 10px; padding: 1px 6px; margin-left: 6px; border-radius: 999px; background: #14532d; color: #bbf7d0; }

.matrix { border-collapse: collapse; background: var(--panel); width: 100%; }
.matrix th, .matrix td { border: 1px solid #1e293b; padding: 6px 10px; text-align: center; font-size: 13px; }
.matrix th { background: #0b1220; color: var(--muted); font-size: 12px; font-weight: 600; }
.matrix .port-hdr { min-width: 56px; }
.matrix tbody tr:nth-child(even) { background: rgba(255,255,255,0.02); }
.partner-row td.dir { font-family: ui-monospace, monospace; font-weight: 600; }
.dir-out { color: #22c55e; }
.dir-in  { color: #38bdf8; }
.peer-site { font-weight: 500; }
.peer-dc { font-family: ui-monospace, monospace; font-size: 12px; }
.status { font-size: 12px; }
.partner-row.status-ok .status { color: #22c55e; }
.partner-row.status-warn .status { color: #f59e0b; }
.partner-row.status-err .status { color: #ef4444; font-weight: 600; }
.port-cell { font-family: ui-monospace, monospace; font-size: 11px; padding: 2px 6px; border-radius: 3px; min-width: 48px; }
.port-ok   { background: var(--green-bg); color: var(--green); }
.port-err  { background: var(--red-bg);   color: var(--red); }
.port-warn { background: rgba(234,179,8,0.12); color: var(--yellow); }
.port-none { background: #1e293b; color: #475569; }
.empty-row { color: var(--muted); padding: 16px; }
</style>