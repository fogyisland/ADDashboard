<template>
  <AdminLayout>
    <header>
      <h2>复制伙伴端口健康监控</h2>
      <div class="controls">
        <span class="refresh-indicator">
          <span :class="['dot', polling ? 'on' : 'off']"></span>
          <span>每 {{ refreshSeconds }}s 刷新</span>
        </span>
        <span class="last-loaded" v-if="lastLoadedAt">最近刷新: {{ fmt(lastLoadedAt) }}</span>
        <!-- 2026-08-28 round-34.2: data staleness header — surface how
             stale the most recent partner-port probe actually is. Driven
             from the max lastAttemptTime across all partners; coloured
             green ≤5min / yellow 5-30min / red >30min so the operator
             can tell at a glance whether the dashboard reflects reality. -->
        <span v-if="stalenessMinutes !== null" :class="['staleness', stalenessClass]" data-test="staleness">
          数据 {{ stalenessMinutes }} 分钟前
        </span>
      </div>
    </header>

    <p class="hint">
      按 站点 → DC → 复制伙伴 列出端口健康状况。每端口显示延迟 (ms):绿色 ≤1000ms /
      黄色 &gt;1000ms / 红色 ✕ (不可达或超时) / 灰色 — (无探测数据)。
    </p>
    <p class="legend">
      <span class="legend-item"><span class="legend-swatch swatch-ok"></span>≤1000ms 可达</span>
      <span class="legend-item"><span class="legend-swatch swatch-slow"></span>&gt;1000ms 慢</span>
      <span class="legend-item"><span class="legend-swatch swatch-down"></span>✕ 不可达/超时</span>
    </p>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="!sites.length && !error" class="empty">暂无站点 — 请在 AD 站点/DC 清单添加</div>

    <section v-for="site in sites" :key="site.siteId" class="site-block" :data-test-site="site.siteName">
      <h3>
        <span :class="['hub-badge', site.isHub ? 'yes' : 'no']">{{ site.isHub ? '中心' : '分支' }}</span>
        {{ site.siteName }}
        <small class="region">{{ site.regionCode || '—' }}</small>
        <small class="dc-count">{{ site.dcs.length }} DC</small>
      </h3>

      <div v-if="!site.dcs.length" class="empty">该站点暂无 DC</div>

      <div v-for="dc in site.dcs" :key="dc.dcName" class="dc-block" :data-test-dc-block="dc.dcName">
        <h4>
          <span class="dc-name">{{ dc.dcName }}</span>
          <span class="dc-roles-inline">
            <span v-if="dc.isBridgehead" class="role-badge bridgehead">桥头</span>
            <span v-if="dc.isPdc" class="role-badge fsmo">PDC</span>
            <span v-if="dc.isGc" class="role-badge fsmo">GC</span>
            <span v-if="dc.isRidMaster" class="role-badge fsmo">RID</span>
            <span v-if="dc.isSchemaMaster" class="role-badge fsmo">Schema</span>
            <span v-if="dc.isDomainNamingMaster" class="role-badge fsmo">DNaming</span>
            <span v-if="dc.isInfrastructureMaster" class="role-badge fsmo">Infra</span>
            <span v-if="!dc.isBridgehead && !dc.isPdc && !dc.isGc && !dc.isRidMaster && !dc.isSchemaMaster && !dc.isDomainNamingMaster && !dc.isInfrastructureMaster" class="role-badge none">成员</span>
          </span>
          <small class="dc-os-inline">{{ dc.osVersion || '—' }}</small>
          <small class="dc-partner-count">{{ dc.partners.length }} 伙伴</small>
        </h4>

        <table v-if="dc.partners.length && portsForDc(dc)" class="port-matrix">
          <thead>
            <tr>
              <th>伙伴站点</th>
              <th>伙伴 DC</th>
              <th v-for="p in portsForDc(dc)" :key="`h-${dc.dcName}-${p.port}`" class="port-col">
                <span class="port-num">{{ p.port }}</span>
                <small v-if="p.label" class="port-label">{{ p.label }}</small>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="partner in dc.partners" :key="`${dc.dcName}-${partner.peerDc}`"
                :data-test="`partner-${dc.dcName}-${partner.peerDc}`">
              <td>
                <span class="peer-site">{{ partner.peerSite }}</span>
                <span v-if="partner.peerSiteIsHub" class="hub-mini">中心</span>
              </td>
              <td class="peer-dc">{{ partner.peerDc }}</td>
              <td v-for="p in portsForDc(dc)" :key="`c-${dc.dcName}-${partner.peerDc}-${p.port}`"
                  :class="cellClass(lookupProbe(partner, p.port))"
                  :data-test="`port-${dc.dcName}-${partner.peerDc}-${p.port}`">
                {{ cellText(lookupProbe(partner, p.port)) }}
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else-if="dc.partners.length" class="empty-row">无端口数据 — 请在 端口健康检查 配置</div>
        <div v-else class="empty-row">无伙伴连接</div>
      </div>
    </section>
  </AdminLayout>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { dashboardApi } from '../../api/dashboard.js';

// 2026-08-28 round-47: 复制伙伴端口健康监控. Operator directive:
// "在这边不叫复制日志监控了，改成复制伙伴端口健康监控名称" + "主要列出每个
// 站点，每台服务器对应的端口健康状况，返回的值为ms 值,超过了1000ms标
// 记为黄色,不通或者超时标记为红色". This view replaces the standalone
// ReplicationLogMonitorView (R45 restoration of R42). The replication-
// attempts caret history (R42/R46) is intentionally dropped — this view
// is port-health only. The reuse of attempt rows is now exclusive to
// 复制状态概览 (SiteReplicationMatrixAllView) via its inline caret.
//
// Color thresholds (verbatim):
//   green  ≤ SLOW_THRESHOLD_MS  — reachable
//   yellow > SLOW_THRESHOLD_MS  — slow
//   red    ✕                    — unreachable or timeout
//   gray   —                    — no probe data
const SLOW_THRESHOLD_MS = 1000;

const sites = ref([]);
const refreshSeconds = ref(10);
const lastLoadedAt = ref(null);
const error = ref('');
const polling = ref(false);
let timerHandle = null;

async function load() {
  polling.value = true;
  error.value = '';
  try {
    const r = await dashboardApi.getPartnerPortHealthAll();
    sites.value = Array.isArray(r.data?.sites) ? r.data.sites : [];
    refreshSeconds.value = Number(r.data?.refreshSeconds) || 10;
    lastLoadedAt.value = new Date().toISOString();
    recomputeStaleness();
  } catch (e) {
    error.value = e?.response?.data?.error || '加载失败';
  } finally {
    polling.value = false;
  }
}

// Per-DC column ports: union of every partner's configuredPorts. Sorted
// ascending numerically. We compute once per dc and memoise per-render
// by deriving inside the template's v-for (cheap, no caching needed).
function portsForDc(dc) {
  const set = new Map(); // port -> label
  for (const partner of (dc.partners || [])) {
    const cfg = Array.isArray(partner.configuredPorts) ? partner.configuredPorts : [];
    for (const p of cfg) {
      if (!set.has(p.port)) set.set(p.port, p.label || '');
    }
  }
  return [...set.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([port, label]) => ({ port, label }));
}

// Per-partner probe lookup. portHealth[] is an array of "latest attempt"
// snapshots; we use index 0 (the route emits at most one latest per
// pair). ports[] inside is {port, ok, latency} — match by port number.
function lookupProbe(partner, portNum) {
  const arr = Array.isArray(partner?.portHealth) ? partner.portHealth : [];
  if (arr.length === 0) return null;
  const ports = Array.isArray(arr[0]?.ports) ? arr[0].ports : [];
  return ports.find(p => Number(p.port) === Number(portNum)) ?? null;
}

function cellClass(probe) {
  if (!probe) return 'cell-no-data';
  if (!probe.ok) return 'cell-down';
  if (probe.latency != null && probe.latency > SLOW_THRESHOLD_MS) return 'cell-slow';
  return 'cell-ok';
}

function cellText(probe) {
  if (!probe) return '—';
  if (!probe.ok) return '✕';
  return `${probe.latency ?? '—'}ms`;
}

function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }

// 2026-08-28 round-34.2: data staleness — derive max lastAttemptTime across
// all partners × all sites × all DCs × all portHealth entries. Returns the
// wall-clock minutes between the most recent probe and now. Returns null
// when no probe timestamps exist (operator can't be misled by a 0-minute
// false-positive; the staleness badge simply doesn't render).
function maxLastAttemptTs(siteList) {
  let max = null;
  for (const site of siteList || []) {
    for (const dc of site.dcs || []) {
      for (const partner of dc.partners || []) {
        for (const ph of partner.portHealth || []) {
          if (ph.lastAttemptTime) {
            const t = new Date(ph.lastAttemptTime).getTime();
            if (Number.isFinite(t) && (max === null || t > max)) max = t;
          }
        }
      }
    }
  }
  return max;
}

const stalenessMinutes = ref(null);
const stalenessClass = ref(''); // 'fresh' | 'warn' | 'stale'

function recomputeStaleness() {
  const ts = maxLastAttemptTs(sites.value);
  if (ts === null) {
    stalenessMinutes.value = null;
    stalenessClass.value = '';
    return;
  }
  const minutes = Math.max(0, Math.floor((Date.now() - ts) / 60000));
  stalenessMinutes.value = minutes;
  if (minutes <= 5) stalenessClass.value = 'fresh';
  else if (minutes <= 30) stalenessClass.value = 'warn';
  else stalenessClass.value = 'stale';
}

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
/* 2026-08-28 round-34.2: data staleness badge — same colour vocabulary as
   the cell matrix so the operator reads them together. fresh ≤5min /
   warn 5-30min / stale >30min. */
.staleness {
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 3px;
  font-variant-numeric: tabular-nums;
}
.staleness.fresh { background: rgba(34, 197, 94, 0.14);  color: #22c55e; }
.staleness.warn  { background: rgba(234, 179, 8, 0.14);  color: #eab308; }
.staleness.stale { background: rgba(239, 68, 68, 0.14);  color: #ef4444; }
.hint { color: var(--muted); font-size: 12px; margin: 0 0 16px; }
.error-banner { background: var(--red-bg); color: var(--red); padding: 8px 12px; border-radius: 3px; margin-bottom: 12px; }
.empty { text-align: center; color: var(--muted); padding: 24px; }
.legend { display: flex; gap: 12px; margin: 0 0 16px; font-size: 12px; color: var(--muted); }
.legend-item { display: inline-flex; gap: 6px; align-items: center; }
.legend-swatch { display: inline-block; width: 12px; height: 12px; border-radius: 3px; border: 1px solid var(--border); }
.swatch-ok   { background: #14532d; border-color: #166534; }
.swatch-slow { background: #78350f; border-color: #b45309; }
.swatch-down { background: #7f1d1d; border-color: #b91c1c; }

.site-block { margin-bottom: 24px; padding: 16px; border: 1px solid #1e293b; border-radius: 4px; background: var(--panel); }
.site-block h3 { display: flex; align-items: baseline; gap: 8px; margin: 0 0 12px; }
.hub-badge { padding: 2px 8px; border-radius: 999px; font-size: 11px; margin-right: 4px; }
.hub-badge.yes { background: #14532d; color: #bbf7d0; }
.hub-badge.no  { background: #1e293b; color: var(--muted); }
.region { color: var(--muted); font-size: 12px; }
.dc-count { color: var(--muted); font-size: 12px; margin-left: auto; }
.hub-mini { font-size: 10px; padding: 1px 6px; margin-left: 6px; border-radius: 999px; background: #14532d; color: #bbf7d0; }

.dc-block { margin-bottom: 18px; padding: 10px 12px;
            border: 1px solid #1e293b; border-radius: 4px; background: var(--panel); }
.dc-block:last-child { margin-bottom: 0; }
.dc-block h4 { display: flex; align-items: baseline; gap: 6px; margin: 0 0 8px;
              font-size: 13px; color: var(--text); font-weight: 600; }
.dc-name { font-family: ui-monospace, monospace; font-weight: 600; font-size: 14px; color: var(--text); }
.dc-roles-inline { display: inline-flex; flex-wrap: wrap; gap: 3px; }
.role-badge { font-size: 10px; padding: 1px 6px; border-radius: 999px;
              font-family: ui-monospace, monospace; letter-spacing: 0.04em; }
.role-badge.fsmo { background: #14532d; color: #bbf7d0; border: 1px solid #166534; }
.role-badge.bridgehead { background: #0e7490; color: #cffafe; font-weight: 600; }
.role-badge.none { background: #1e293b; color: var(--muted); }
.dc-os-inline { color: var(--muted); font-size: 11px; font-family: ui-monospace, monospace; }
.dc-partner-count { color: var(--muted); font-size: 11px; margin-left: auto; }

/* 2026-08-28 round-47: port-matrix table — one column per configured port.
   Cells are colour-coded by latency thresholds (≤1000ms green, >1000ms
   yellow, ✕ red, — gray). */
.port-matrix { border-collapse: collapse; background: var(--panel); width: 100%; }
.port-matrix th, .port-matrix td {
  border: 1px solid #1e293b; padding: 6px 10px; text-align: center; font-size: 13px;
}
.port-matrix th { background: #0b1220; color: var(--muted); font-size: 12px; font-weight: 600; }
.port-matrix tbody tr:nth-child(even) { background: rgba(255,255,255,0.02); }
.port-col { min-width: 64px; }
.port-num { font-family: ui-monospace, monospace; font-weight: 600; font-size: 12px; color: var(--text); }
.port-label { display: block; color: var(--muted); font-size: 10px; margin-top: 2px; }

.peer-site { font-weight: 500; }
.peer-dc { font-family: ui-monospace, monospace; font-size: 12px; }
.empty-row { color: var(--muted); padding: 16px; }

/* R47 colour rules — verbatim operator thresholds. */
.cell-ok        { background: #14532d; color: #bbf7d0; font-weight: 600; }
.cell-slow      { background: #78350f; color: #fde68a; font-weight: 600; }
.cell-down      { background: #7f1d1d; color: #fecaca; font-weight: 600; }
.cell-no-data   { background: #1e293b; color: var(--muted); }
</style>