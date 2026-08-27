<template>
  <AdminLayout>
    <header>
      <h2>复制伙伴状态 (全站)</h2>
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
    <p class="legend">
      <span class="legend-item"><span class="legend-swatch swatch-primary"></span>主控 DC</span>
      <span class="legend-item"><span class="legend-swatch swatch-bridgehead"></span>桥头 DC</span>
      <span class="legend-item"><span class="legend-swatch swatch-member"></span>成员 DC</span>
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

      <!-- 2026-08-27 round-31: explicit DC list for this site. Shows every
           DC server grouped by site, with role badges (PDC/GC/RID/Schema/
           DNaming/Infrastructure/Bridgehead) + OS version. The bridgehead
           row is visually emphasised (accent outline). -->
      <div class="site-dc-list" :data-test-site-dcs="p.siteName">
        <h4>本站 DC 清单 ({{ p.dcs.length }})</h4>
        <div v-if="!p.dcs.length" class="empty">该站点暂无 DC</div>
        <ul v-else class="dc-cards">
            <li v-for="d in p.dcs" :key="d.dcName"
                :class="['dc-card', { 'dc-card-primary': d.dcName === p.dcName, 'dc-card-bridgehead': d.isBridgehead && d.dcName !== p.dcName }]"
                :data-test-dc="d.dcName">
              <div class="dc-name">{{ d.dcName }}</div>
              <div class="dc-roles">
                <span v-if="d.isBridgehead" class="role-badge bridgehead" title="操作员指定的桥头 DC">桥头</span>
                <span v-if="d.isPdc" class="role-badge fsmo">PDC</span>
                <span v-if="d.isGc" class="role-badge fsmo">GC</span>
                <span v-if="d.isRidMaster" class="role-badge fsmo">RID</span>
                <span v-if="d.isSchemaMaster" class="role-badge fsmo">Schema</span>
                <span v-if="d.isDomainNamingMaster" class="role-badge fsmo">DNaming</span>
                <span v-if="d.isInfrastructureMaster" class="role-badge fsmo">Infra</span>
                <span v-if="!d.isBridgehead && !d.isPdc && !d.isGc && !d.isRidMaster && !d.isSchemaMaster && !d.isDomainNamingMaster && !d.isInfrastructureMaster" class="role-badge none">成员</span>
              </div>
              <div class="dc-os">{{ d.osVersion || '—' }}</div>
            </li>
          </ul>
      </div>

      <div class="port-summary" :data-test-port-summary="p.dcName">
        <span v-if="p.portHealth.unprobed" class="ps-chip ps-none">无探测</span>
        <template v-else>
          <span class="ps-chip ps-ok">● {{ p.portHealth.ok }} 通</span>
          <span class="ps-chip ps-warn" v-if="p.portHealth.warn">▲ {{ p.portHealth.warn }} 慢</span>
          <span class="ps-chip ps-err"  v-if="p.portHealth.err">✕ {{ p.portHealth.err }} 不通</span>
        </template>
        <span class="ps-probe-time" v-if="p.portHealth.latestProbeAt">
          最近探测: {{ fmt(p.portHealth.latestProbeAt) }}
        </span>
      </div>

      <table class="matrix">
        <thead>
          <tr>
            <th>类型</th>
            <th>方向</th>
            <th>伙伴站点</th>
            <th>伙伴 DC</th>
            <th>状态</th>
            <th v-for="port in ports" :key="`hdr-${p.dcName}-${port}`" class="port-hdr">{{ port }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="partner in p.partners" :key="`${partner.peerType}-${partner.direction}-${partner.peerDc}`"
              :class="rowClass(partner)"
              :data-test="`partner-${partner.peerType}-${partner.direction}-${p.dcName}-${partner.peerDc}`">
            <td class="peer-type">
              <span :class="['peer-tag', `peer-tag-${partner.peerType || 'unknown'}`]">{{ peerTypeLabel(partner) }}</span>
            </td>
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
            <td v-for="port in ports" :key="`${partner.peerType}-${partner.direction}-${p.dcName}-${partner.peerDc}-${port}`"
                :class="['port-cell', `port-${portStatusClass(partner.perPort, port)}`]"
                :title="portTooltip(partner.perPort, port)">
              <div class="port-num">{{ port }}</div>
              <div class="port-detail">{{ portDetailLabel(partner.perPort, port) }}</div>
            </td>
          </tr>
          <tr v-if="!p.partners.length">
            <td :colspan="6 + ports.length" class="empty-row">无伙伴连接</td>
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
    ports.value = Array.isArray(r.data?.ports) ? r.data.ports : [];
    // round-32: pre-compute the per-primary port-health rollup once per
    // load so the chip in the template doesn't re-iterate partners × ports
    // on every reactive tick. portHealth attaches to each primary entry.
    primaries.value = (Array.isArray(r.data?.primaries) ? r.data.primaries : [])
      .map(p => ({ ...p, portHealth: computePortHealth(p, ports.value) }));
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
// 2026-08-27 round-32: backend distinguishes within-site siblings
// (peerType="within") from cross-site bridgehead peers
// (peerType="bridgehead"). UI surfaces a tag so operators can see
// at a glance which cross-site link goes via a bridgehead vs. all
// in-site connections.
function peerTypeLabel(p) {
  if (p.peerType === 'within') return '本站';
  if (p.peerType === 'bridgehead') return '桥头';
  return '未知';
}
function portTooltip(perPort, port) {
  const e = perPort?.[String(port)];
  if (!e) return `${port}: 未探测`;
  const status = e.reachable === true ? '可达' : e.reachable === false ? '不可达' : '未知';
  const lat = e.latencyMs != null ? ` ${e.latencyMs}ms` : '';
  const err = e.error ? ` — ${e.error}` : '';
  return `${port}: ${status}${lat}${err}`;
}
// 2026-08-27 round-32: surface the per-port PowerShell probe result inline
// in each port cell. Reachable + measured latency → "3ms"; reachable but no
// latency → "通"; unreachable → error reason (e.g. "timeout"); never
// probed → "—". Compact 2-line cell keeps the matrix scannable while
// exposing the latency/error data the PS collector emits.
function portDetailLabel(perPort, port) {
  const e = perPort?.[String(port)];
  if (!e) return '—';
  if (e.reachable === true) {
    return e.latencyMs != null ? `${e.latencyMs}ms` : '通';
  }
  if (e.reachable === false) {
    return e.error || '断';
  }
  return '?';
}
// 2026-08-27 round-32: per-primary port-health summary chip. Counts the
// ok/warn/err buckets across every partner row + every port and shows the
// latest probe time so operators see at a glance which primaries have
// fresh, all-green probe data vs. stale or degraded. `unprobed` is true
// when the primary has partners but none of them have any probe data —
// the chip then shows "无探测" instead of "0 通 / 0 不通".
function computePortHealth(primary, portList) {
  let ok = 0, warn = 0, err = 0, total = 0, latestProbeAt = null;
  for (const partner of (primary.partners || [])) {
    for (const port of (portList || [])) {
      total++;
      const cls = portStatusClass(partner.perPort, port);
      if (cls === 'ok') ok++;
      else if (cls === 'warn') warn++;
      else if (cls === 'err') err++;
    }
    if (partner.lastProbeAt) {
      const t = Date.parse(partner.lastProbeAt);
      if (!Number.isNaN(t) && (latestProbeAt === null || t > latestProbeAt)) {
        latestProbeAt = t;
      }
    }
  }
  const unprobed = total > 0 && (ok + warn + err) === 0;
  return { ok, warn, err, total, unprobed, latestProbeAt: latestProbeAt ? new Date(latestProbeAt).toISOString() : null };
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

/* 2026-08-27 round-31: per-site DC list panel. Shows every DC in the
   site with role badges (FSMO + Bridgehead) + OS version. The bridgehead
   is visually emphasised with a cyan outline. */
.site-dc-list { margin-bottom: 16px; padding: 10px 12px; background: rgba(255,255,255,0.02); border-radius: 3px; }
.site-dc-list h4 { margin: 0 0 8px; font-size: 12px; color: var(--muted); font-weight: 600; }
.dc-cards { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.dc-card { display: flex; flex-direction: column; gap: 4px; padding: 8px 12px;
           border: 1px solid #1e293b; border-radius: 4px; background: var(--panel);
           min-width: 180px; font-size: 12px; }
.dc-card-primary { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.dc-card-bridgehead { border-color: #0e7490; }
.dc-name { font-family: ui-monospace, monospace; font-weight: 600; font-size: 13px; color: var(--text); }
.dc-roles { display: flex; flex-wrap: wrap; gap: 3px; }
.role-badge { font-size: 10px; padding: 1px 6px; border-radius: 999px;
              font-family: ui-monospace, monospace; letter-spacing: 0.04em; }
.role-badge.fsmo { background: #14532d; color: #bbf7d0; border: 1px solid #166534; }
.role-badge.bridgehead { background: #0e7490; color: #cffafe; font-weight: 600; }
.role-badge.none { background: #1e293b; color: var(--muted); }
.dc-os { font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted); }
.legend { display: flex; gap: 12px; margin: 0 0 16px; font-size: 12px; color: var(--muted); }
.legend-item { display: inline-flex; gap: 6px; align-items: center; }
.legend-swatch { display: inline-block; width: 12px; height: 12px; border-radius: 3px; border: 1px solid var(--border); }
.swatch-primary { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.swatch-bridgehead { border-color: #0e7490; }
.swatch-member { border-color: #1e293b; background: var(--panel); }

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
.peer-type { white-space: nowrap; }
.peer-tag { display: inline-block; font-size: 11px; padding: 1px 8px; border-radius: 999px;
            font-family: ui-monospace, monospace; font-weight: 600; letter-spacing: 0.04em; }
.peer-tag-within     { background: #1e293b; color: var(--text); border: 1px solid #334155; }
.peer-tag-bridgehead { background: #0e7490; color: #cffafe; }
.peer-tag-unknown    { background: #1e293b; color: var(--muted); }
.status { font-size: 12px; }
.partner-row.status-ok .status { color: #22c55e; }
.partner-row.status-warn .status { color: #f59e0b; }
.partner-row.status-err .status { color: #ef4444; font-weight: 600; }
.port-cell { font-family: ui-monospace, monospace; font-size: 11px; padding: 2px 6px; border-radius: 3px; min-width: 48px; }
.port-ok   { background: var(--green-bg); color: var(--green); }
.port-err  { background: var(--red-bg);   color: var(--red); }
.port-warn { background: rgba(234,179,8,0.12); color: var(--yellow); }
.port-none { background: #1e293b; color: #475569; }
.port-num { font-weight: 600; font-size: 12px; line-height: 1.2; }
.port-detail { font-size: 10px; line-height: 1.2; opacity: 0.92; }
/* 2026-08-27 round-32: per-primary port-health summary chip. Surfaces
   the partner-port PowerShell probe rollup inline above the matrix so
   operators see "X 通 / Y 不通 / 最新探测时间" without scanning cells. */
.port-summary { display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
                margin: 0 0 8px; padding: 6px 10px; border-radius: 3px;
                background: rgba(255,255,255,0.03); border: 1px solid #1e293b; }
.ps-chip { font-family: ui-monospace, monospace; font-size: 11px;
           padding: 2px 8px; border-radius: 999px; letter-spacing: 0.04em; }
.ps-ok   { background: rgba(34,197,94,0.15);  color: #22c55e; }
.ps-warn { background: rgba(234,179,8,0.18);  color: #f59e0b; }
.ps-err  { background: rgba(239,68,68,0.18);  color: #ef4444; }
.ps-none { background: #1e293b; color: var(--muted); }
.ps-probe-time { color: var(--muted); font-size: 11px; margin-left: auto; font-family: ui-monospace, monospace; }
.empty-row { color: var(--muted); padding: 16px; }
</style>