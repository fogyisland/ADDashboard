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
      </div>
    </header>

    <!-- 2026-08-27 round-36 per-DC partner tables: operator directive
         "本地站点只显示了一台，另外一台没有显示出来" — every DC in the
         site renders its own partner matrix. round-35 inbound-only still
         applies: each row is another DC sending replication TO this DC.
         round-35: "出战的没有意义" — drop outbound columns. -->
    <p class="hint">
      每个站点的每台 DC 各自显示自己的入站复制连接 — 即其他 DC 复制到本机的链路。
      端口列来自 partner-port 探针;未探测的行显示灰色徽章。
    </p>
    <p class="legend">
      <span class="legend-item"><span class="legend-swatch swatch-primary"></span>主控 DC</span>
      <span class="legend-item"><span class="legend-swatch swatch-bridgehead"></span>桥头 DC</span>
      <span class="legend-item"><span class="legend-swatch swatch-member"></span>成员 DC</span>
    </p>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="!primaries.length && !error" class="empty">暂无站点 — 请在 AD 站点/DC 清单添加</div>

    <section v-for="p in primaries" :key="p.siteId ?? p.siteName" class="site-block" :data-test-site="p.siteName">
      <h3>
        <span :class="['hub-badge', p.isHub ? 'yes' : 'no']">{{ p.isHub ? '中心' : '分支' }}</span>
        {{ p.siteName }}
        <small class="region">{{ p.regionCode || '—' }}</small>
        <small class="dc-count">{{ (p.dcPartners || []).length }} DC / {{ p.dcs.length }} 成员</small>
      </h3>

      <!-- 2026-08-27 round-36: per-DC partner tables. The operator directive
           "本地站点只显示了一台" — only the bridgehead was visible because
           round-28 rendered one partner matrix per site (the primary's).
           Now every DC in the site renders its own matrix, with role
           badges in the header. Self-loops excluded; outbound dropped per
           round-35 inbound-only filter. -->
      <div v-if="!p.dcPartners || !p.dcPartners.length" class="empty">该站点暂无 DC</div>

      <div v-for="dc in p.dcPartners" :key="dc.dcName" class="dc-block" :data-test-dc-block="dc.dcName">
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

        <div class="port-summary" :data-test-port-summary="dc.dcName">
          <span v-if="dc.portHealth.unprobed" class="ps-chip ps-none">无探测</span>
          <template v-else>
            <span class="ps-chip ps-ok">● {{ dc.portHealth.ok }} 通</span>
            <span class="ps-chip ps-warn" v-if="dc.portHealth.warn">▲ {{ dc.portHealth.warn }} 慢</span>
            <span class="ps-chip ps-err"  v-if="dc.portHealth.err">✕ {{ dc.portHealth.err }} 不通</span>
          </template>
          <span class="ps-probe-time" v-if="dc.portHealth.latestProbeAt">
            最近探测: {{ fmt(dc.portHealth.latestProbeAt) }}
          </span>
        </div>

        <table class="matrix">
          <thead>
            <tr>
              <th>类型</th>
              <th>伙伴站点</th>
              <th>伙伴 DC</th>
              <th>状态</th>
              <th v-for="port in ports" :key="`hdr-${dc.dcName}-${port}`" class="port-hdr">{{ port }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="partner in dc.partners" :key="`${dc.dcName}-${partner.peerType}-${partner.peerDc}`"
                :class="rowClass(partner)"
                :data-test="`partner-${partner.peerType}-${dc.dcName}-${partner.peerDc}`">
              <td class="peer-type">
                <span :class="['peer-tag', `peer-tag-${partner.peerType || 'unknown'}`]">{{ peerTypeLabel(partner) }}</span>
              </td>
              <td>
                <span class="peer-site">{{ partner.peerSite }}</span>
                <span v-if="partner.peerSiteIsHub" class="hub-mini">中心</span>
              </td>
              <td class="peer-dc">{{ partner.peerDc }}</td>
              <td class="status">{{ statusGlyph(partner) }} {{ statusLabel(partner) }}</td>
              <td v-for="port in ports" :key="`cell-${dc.dcName}-${partner.peerDc}-${port}`"
                  class="port-cell" :title="portTooltip(partner.perPort, port)">
                <!-- 2026-08-27 round-37.2: operator directive "我们只需要标题表明端口,
                     其他的网格里面不需要写入端口" — port number lives only in the
                     column header. Cells show ONLY the value (3ms / 通 / 断 / —),
                     no port number repeat. -->
                <div :class="['port-detail', `port-val-${portStatusClass(partner.perPort, port)}`]">
                  {{ portDetailLabel(partner.perPort, port) }}
                </div>
              </td>
            </tr>
            <tr v-if="!dc.partners.length">
              <td :colspan="5 + ports.length" class="empty-row">无伙伴连接</td>
            </tr>
          </tbody>
        </table>
      </div>
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
    // 2026-08-27 round-36: port-health is now per-DC, not per-site.
    // The route emits `dcPartners[]` — one entry per DC in the site, each
    // with its own partners[]. We attach portHealth to each dcPartner so
    // the chip in the template doesn't re-iterate partners × ports on
    // every reactive tick.
    primaries.value = (Array.isArray(r.data?.primaries) ? r.data.primaries : []).map((p) => ({
      ...p,
      dcPartners: (Array.isArray(p.dcPartners) ? p.dcPartners : []).map((dc) => ({
        ...dc,
        portHealth: computePortHealth(dc, ports.value)
      }))
    }));
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
function portEntry(perPort, port) {
  // 2026-08-27 round-36.1: partner_port_status JSON shape is
  // `{ checked_at, ports: { '<port>': { reachable, latencyMs, error } } }`.
  // The earlier round-32 code read `perPort[port]` which always returned
  // undefined — every badge fell through to 'none' / "未探测" and operators
  // only saw TTL-style latency strings via the tooltip fallback. Read the
  // inner `ports` map so per-port reachability + latency actually surface.
  return perPort?.ports?.[String(port)] ?? null;
}
function portStatusClass(perPort, port) {
  const e = portEntry(perPort, port);
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
  const e = portEntry(perPort, port);
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
  const e = portEntry(perPort, port);
  if (!e) return '—';
  if (e.reachable === true) {
    return e.latencyMs != null ? `${e.latencyMs}ms` : '通';
  }
  if (e.reachable === false) {
    return e.error || '断';
  }
  return '?';
}
// 2026-08-27 round-36: per-DC port-health summary chip. Counts the
// ok/warn/err buckets across every partner row + every port for THIS DC
// and shows the latest probe time. Replaces the per-primary version from
// round-32 — operator now sees per-DC freshness, not per-site.
// `unprobed` is true when the DC has partners but none of them have any
// probe data — the chip then shows "无探测" instead of "0 通 / 0 不通".
function computePortHealth(dc, portList) {
  let ok = 0, warn = 0, err = 0, total = 0, latestProbeAt = null;
  for (const partner of (dc.partners || [])) {
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

.site-block { margin-bottom: 24px; padding: 16px; border: 1px solid #1e293b; border-radius: 4px; background: var(--panel); }
.site-block h3 { display: flex; align-items: baseline; gap: 8px; margin: 0 0 12px; }
.hub-badge { padding: 2px 8px; border-radius: 999px; font-size: 11px; margin-right: 4px; }
.hub-badge.yes { background: #14532d; color: #bbf7d0; }
.hub-badge.no  { background: #1e293b; color: var(--muted); }
.region { color: var(--muted); font-size: 12px; }
.dc-count { color: var(--muted); font-size: 12px; margin-left: auto; }
.hub-mini { font-size: 10px; padding: 1px 6px; margin-left: 6px; border-radius: 999px; background: #14532d; color: #bbf7d0; }

/* 2026-08-27 round-36: per-DC partner block. Each DC in the site gets
   its own matrix inside the site block. The role badges + osVersion
   header replaces the round-31 redundant "本站 DC 清单" panel. */
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
.port-cell { font-family: ui-monospace, monospace; font-size: 11px; padding: 2px 6px; min-width: 48px; vertical-align: middle; text-align: center; }
/* 2026-08-27 round-37: status color applies to the VALUE text only —
   port number stays neutral, no colored background on the cell. */
/* 2026-08-27 round-37.1: operator feedback "毫秒还是很小" — the latency
   text was 10px and visually subordinate to the 12px port number, which
   is the actionable info. Swap hierarchy: port number gets smaller +
   muted, value text (3ms / 通 / 断) becomes the dominant element with
   bold weight + larger font so it's actually scannable. */
/* 2026-08-27 round-37.2: drop the .port-num repeat from cells entirely —
   the column header already labels which port this cell is for. The
   value (3ms / 通 / 断 / —) now stands alone in each cell, centered. */
.port-val-ok   { color: var(--green); font-weight: 700; font-size: 13px; }
.port-val-err  { color: var(--red);   font-weight: 700; font-size: 13px; }
.port-val-warn { color: var(--yellow); font-weight: 700; font-size: 13px; }
.port-val-none { color: var(--muted); font-size: 12px; }
.port-detail { font-size: 13px; line-height: 1.2; letter-spacing: -0.01em; }
/* 2026-08-27 round-36: per-DC port-health summary chip (was per-primary
   in round-32). Sits inside each .dc-block just above the matrix so
   operators see "X 通 / Y 不通 / 最新探测时间" for THIS DC. */
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