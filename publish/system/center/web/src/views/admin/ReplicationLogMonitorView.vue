<template>
  <AdminLayout>
    <header>
      <h2>复制日志监控</h2>
      <div class="controls">
        <span class="refresh-indicator">
          <span :class="['dot', polling ? 'on' : 'off']"></span>
          <span>每 {{ refreshSeconds }}s 刷新</span>
        </span>
        <span class="last-loaded" v-if="lastLoadedAt">最近刷新: {{ fmt(lastLoadedAt) }}</span>
      </div>
    </header>

    <p class="hint">
      按 站点 → DC → 复制伙伴 展示入站连接状态 + 配置端口健康 (R46)。
      右侧 <span class="caret-glyph">▸</span> 展开按钮可查看最近 10 次的连接具体信息 —
      成功时显示耗时与对象传输数,失败时显示错误描述;展开后下方还会列出
      设定端口健康 (每端口可达性 + 延迟)。
    </p>
    <p class="legend">
      <span class="legend-item"><span class="legend-swatch swatch-primary"></span>主控 DC</span>
      <span class="legend-item"><span class="legend-swatch swatch-bridgehead"></span>桥头 DC</span>
      <span class="legend-item"><span class="legend-swatch swatch-member"></span>成员 DC</span>
      <span class="legend-item"><span class="dir-tag dir-tag-in">进</span>伙伴 → 本机 (入站)</span>
      <span class="legend-item"><span class="port-chip port-chip-ok">●</span>端口可达</span>
      <span class="legend-item"><span class="port-chip port-chip-warn">▲</span>部分端口</span>
      <span class="legend-item"><span class="port-chip port-chip-err">✕</span>端口不可达</span>
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

        <table v-if="dc.partners.length" class="matrix">
          <thead>
            <tr>
              <th class="caret-col"></th>
              <th>方向</th>
              <th>类型</th>
              <th>伙伴站点</th>
              <th>伙伴 DC</th>
              <th>当前状态</th>
              <th>端口健康</th>
              <th>最近成功</th>
              <th>耗时 (分)</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="partner in mergedPartners(dc)" :key="`${dc.dcName}-${partner.peerType}-${partner.peerDc}-${partner.namingContext}-${partner._mergeKey}`">
              <tr :class="rowClass(partner)"
                  :data-test="`partner-${dc.dcName}-${partner.peerDc}`"
                  :data-test-direction="partner._direction">
                <td class="caret-col">
                  <button type="button"
                          :class="['caret-btn', isExpanded(dc.dcName, partner.peerDc) ? 'open' : 'closed']"
                          :aria-label="isExpanded(dc.dcName, partner.peerDc) ? '折叠' : '展开'"
                          @click="toggle(dc.dcName, partner.peerDc)">
                    <span class="caret-glyph">{{ isExpanded(dc.dcName, partner.peerDc) ? '▾' : '▸' }}</span>
                  </button>
                </td>
                <td class="direction" :title="directionTooltip(partner)">
                  <span :class="['dir-tag', `dir-tag-${partner._direction}`]">{{ directionLabel(partner) }}</span>
                </td>
                <td class="peer-type">
                  <span :class="['peer-tag', `peer-tag-${partner.peerType || 'unknown'}`]">{{ peerTypeLabel(partner) }}</span>
                </td>
                <td>
                  <span class="peer-site">{{ partner.peerSite }}</span>
                  <span v-if="partner.peerSiteIsHub" class="hub-mini">中心</span>
                </td>
                <td class="peer-dc">{{ partner.peerDc }}</td>
                <td class="status">{{ statusGlyph(partner) }} {{ statusLabel(partner) }}</td>
                <td class="port-health">
                  <span :class="['port-chip', portChipClass(partner)]">{{ portChipGlyph(partner) }}</span>
                  <span class="port-health-text">{{ portChipText(partner) }}</span>
                </td>
                <td class="time">{{ partner.lastSuccessTime ? fmt(partner.lastSuccessTime) : '—' }}</td>
                <td class="duration">{{ partner.durationMinutes == null ? '—' : `${partner.durationMinutes}` }}</td>
              </tr>
              <tr v-if="isExpanded(dc.dcName, partner.peerDc)" class="attempts-row"
                  :data-test="`attempts-${dc.dcName}-${partner.peerDc}`">
                <td colspan="9" class="attempts-cell">
                  <div class="attempts-panel">
                    <div v-if="!partner.attempts || !partner.attempts.length" class="attempts-empty">
                      暂无历史记录 — 该伙伴没有 24h 内的连接尝试数据
                    </div>
                    <table v-else class="attempts-table">
                      <thead>
                        <tr>
                          <th class="att-when">尝试时间</th>
                          <th class="att-status">结果</th>
                          <th class="att-dur">耗时 (ms)</th>
                          <th class="att-obj">传输对象</th>
                          <th class="att-success">最近成功</th>
                          <th class="att-err">错误/详情</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="(a, idx) in partner.attempts" :key="idx" :class="attemptRowClass(a)">
                          <td class="att-when">{{ fmt(a.attemptAt) }}</td>
                          <td class="att-status">
                            <span :class="['att-glyph', `att-glyph-${attemptGlyphClass(a)}`]">{{ attemptGlyph(a) }}</span>
                            {{ attemptLabel(a) }}
                          </td>
                          <td class="att-dur">{{ a.durationMs == null ? '—' : a.durationMs }}</td>
                          <td class="att-obj">{{ a.objectsTransferred == null ? '—' : a.objectsTransferred }}</td>
                          <td class="att-success">{{ a.lastSuccessTime ? fmt(a.lastSuccessTime) : '—' }}</td>
                          <td class="att-err" :title="a.errorMessage || ''">
                            {{ a.errorMessage || '—' }}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <div v-if="partner.configuredPorts && partner.configuredPorts.length" class="ports-strip">
                    <span class="ports-strip-label">设定端口:</span>
                    <span
                      v-for="p in partner.configuredPorts"
                      :key="`cfg-${p}`"
                      class="port-num"
                    >{{ p }}</span>
                  </div>
                  <div v-if="partner.portHealth && partner.portHealth.length" class="ports-strip">
                    <span class="ports-strip-label">端口健康:</span>
                    <span
                      v-for="ph in partner.portHealth"
                      :key="`ph-${ph.peerDc || partner.peerDc}-${ph.lastAttemptTime}`"
                      :class="['port-mini-chip', portMiniClass(ph)]"
                    >
                      {{ portMiniGlyph(ph) }} {{ portMiniText(ph) }}
                    </span>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
        <div v-else class="empty-row">无伙伴连接</div>
      </div>
    </section>
  </AdminLayout>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { dashboardApi } from '../../api/dashboard.js';

const sites = ref([]);
const refreshSeconds = ref(10);
const lastLoadedAt = ref(null);
const error = ref('');
const polling = ref(false);
const expanded = ref(new Set()); // keys: `${dcName} ${sep} ${peerDc}`
let timerHandle = null;
const sep = String.fromCharCode(1);

async function load() {
  polling.value = true;
  error.value = '';
  try {
    const r = await dashboardApi.getReplicationLogAll();
    sites.value = Array.isArray(r.data?.sites) ? r.data.sites : [];
    refreshSeconds.value = Number(r.data?.refreshSeconds) || 10;
    lastLoadedAt.value = new Date().toISOString();
    // Drop expansion state for partners that no longer exist (renamed DCs etc.)
    const liveKeys = new Set();
    for (const s of sites.value) {
      for (const d of (s.dcs || [])) {
        for (const p of (d.partners || [])) {
          liveKeys.add(expansionKey(d.dcName, p.peerDc));
        }
      }
    }
    for (const k of [...expanded.value]) {
      if (!liveKeys.has(k)) expanded.value.delete(k);
    }
  } catch (e) {
    error.value = e?.response?.data?.error || '加载失败';
  } finally {
    polling.value = false;
  }
}

function expansionKey(dcName, peerDc) {
  return `${dcName}${sep}${peerDc}`;
}
function isExpanded(dcName, peerDc) {
  return expanded.value.has(expansionKey(dcName, peerDc));
}
function toggle(dcName, peerDc) {
  const k = expansionKey(dcName, peerDc);
  if (expanded.value.has(k)) expanded.value.delete(k);
  else expanded.value.add(k);
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
function peerTypeLabel(p) {
  if (p.peerType === 'within') return '本站';
  if (p.peerType === 'bridgehead') return '桥头';
  return '未知';
}
// 2026-08-28 round-43: dedup partner rows by (peerDc, namingContext). When
// the same partner has both 'in' and 'out' links (e.g. a hub that both
// replicates TO this DC AND receives from it), the route emits two partner
// rows — merge them client-side into a single 双向 row so the operator
// doesn't see duplicates.
function mergedPartners(dc) {
  const groups = new Map();
  for (const p of (dc.partners || [])) {
    const k = `${p.peerDc}${sep}${p.namingContext || ''}`;
    const existing = groups.get(k);
    if (!existing) {
      groups.set(k, { ...p, _directions: [p.direction || 'in'] });
    } else {
      existing._directions.push(p.direction || 'in');
      // Prefer the latest attemptTime across both directions
      const exT = existing.lastAttemptTime ? new Date(existing.lastAttemptTime).getTime() : 0;
      const neT = p.lastAttemptTime ? new Date(p.lastAttemptTime).getTime() : 0;
      if (neT > exT) {
        Object.assign(existing, { ...p, _directions: existing._directions });
      } else {
        existing._directions = Array.from(new Set(existing._directions));
      }
    }
  }
  // Stamp a derived direction field for rendering
  const out = [];
  for (const [k, g] of groups) {
    const dirSet = new Set(g._directions);
    let dir;
    if (dirSet.has('in') && dirSet.has('out')) dir = 'both';
    else if (dirSet.has('out')) dir = 'out';
    else dir = 'in';
    out.push({ ...g, _direction: dir, _mergeKey: k });
  }
  return out;
}
function directionLabel(p) {
  if (p._direction === 'in') return '进';
  if (p._direction === 'out') return '出';
  return '双向';
}
function directionTooltip(p) {
  const list = (p._directions || []).join(' + ');
  if (p._direction === 'both') return `双向复制 (${list})`;
  if (p._direction === 'out') return `本机复制到 ${p.peerDc} (出站)`;
  return `${p.peerDc} 复制到本机 (入站)`;
}
function attemptGlyph(a) {
  if (a.statusCode === 0) return '●';
  if (a.statusCode === 1) return '▲';
  return '✕';
}
function attemptGlyphClass(a) {
  if (a.statusCode === 0) return 'ok';
  if (a.statusCode === 1) return 'warn';
  return 'err';
}
function attemptLabel(a) {
  if (a.statusCode === 0) return '成功';
  if (a.statusCode === 1) return '部分失败';
  return '失败';
}
function attemptRowClass(a) {
  return {
    'att-row-ok':   a.statusCode === 0,
    'att-row-warn': a.statusCode === 1,
    'att-row-err':  a.statusCode > 1
  };
}
function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }

// 2026-08-28 round-46: partner port-health helpers. The route emits
// partner.portHealth[] (latestPartnerPortPerPair rows for the (source, dest)
// pair) and partner.configuredPorts[] (system_ports list). portChip* render
// the main cell summary; portMini* render each row's per-attempt snapshot
// inside the expanded attempts panel.
function portChipClass(p) {
  const arr = Array.isArray(p?.portHealth) ? p.portHealth : [];
  if (arr.length === 0) return 'port-chip-none';
  // Pick the latest attempt by lastAttemptTime
  const latest = arr.slice().sort((a, b) => {
    const ta = a.lastAttemptTime ? new Date(a.lastAttemptTime).getTime() : 0;
    const tb = b.lastAttemptTime ? new Date(b.lastAttemptTime).getTime() : 0;
    return tb - ta;
  })[0];
  const sc = Number(latest.statusCode);
  if (sc === 0) return 'port-chip-ok';
  if (sc === 1) return 'port-chip-warn';
  return 'port-chip-err';
}
function portChipGlyph(p) {
  const cls = portChipClass(p);
  if (cls === 'port-chip-ok') return '●';
  if (cls === 'port-chip-warn') return '▲';
  if (cls === 'port-chip-err') return '✕';
  return '—';
}
function portChipText(p) {
  const arr = Array.isArray(p?.portHealth) ? p.portHealth : [];
  if (arr.length === 0) return '未探测';
  const cls = portChipClass(p);
  if (cls === 'port-chip-ok') return '端口可达';
  if (cls === 'port-chip-warn') return '部分端口';
  if (cls === 'port-chip-err') return '端口不可达';
  return '—';
}
function portMiniClass(ph) {
  const sc = Number(ph?.statusCode);
  if (sc === 0) return 'port-mini-ok';
  if (sc === 1) return 'port-mini-warn';
  return 'port-mini-err';
}
function portMiniGlyph(ph) {
  const cls = portMiniClass(ph);
  if (cls === 'port-mini-ok') return '●';
  if (cls === 'port-mini-warn') return '▲';
  return '✕';
}
function portMiniText(ph) {
  const sc = Number(ph?.statusCode);
  if (sc === 0) return '全可达';
  if (sc === 1) return '部分';
  return '不可达';
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
.hint { color: var(--muted); font-size: 12px; margin: 0 0 16px; }
.caret-glyph { font-size: 11px; color: var(--accent); }
.error-banner { background: var(--red-bg); color: var(--red); padding: 8px 12px; border-radius: 3px; margin-bottom: 12px; }
.empty { text-align: center; color: var(--muted); padding: 24px; }
.legend { display: flex; gap: 12px; margin: 0 0 16px; font-size: 12px; color: var(--muted); }
.legend-item { display: inline-flex; gap: 6px; align-items: center; }
.legend-swatch { display: inline-block; width: 12px; height: 12px; border-radius: 3px; border: 1px solid var(--border); }
.swatch-primary { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.swatch-bridgehead { border-color: #0e7490; }
.swatch-member { border-color: #1e293b; background: var(--panel); }

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

.matrix { border-collapse: collapse; background: var(--panel); width: 100%; }
.matrix th, .matrix td { border: 1px solid #1e293b; padding: 6px 10px; text-align: center; font-size: 13px; }
.matrix th { background: #0b1220; color: var(--muted); font-size: 12px; font-weight: 600; }
.matrix tbody tr:nth-child(even) { background: rgba(255,255,255,0.02); }
.caret-col { width: 36px; padding: 4px; }
.caret-btn { background: transparent; border: 1px solid #1e293b; border-radius: 3px;
             padding: 2px 6px; cursor: pointer; color: var(--text); font-family: ui-monospace, monospace; }
.caret-btn:hover { background: rgba(56,189,248,0.08); border-color: var(--accent); }
.caret-btn.open { color: var(--accent); border-color: var(--accent); }

.peer-site { font-weight: 500; }
.peer-dc { font-family: ui-monospace, monospace; font-size: 12px; }
.peer-type { white-space: nowrap; }
.peer-tag { display: inline-block; font-size: 11px; padding: 1px 8px; border-radius: 999px;
            font-family: ui-monospace, monospace; font-weight: 600; letter-spacing: 0.04em; }
.peer-tag-within     { background: #1e293b; color: var(--text); border: 1px solid #334155; }
.peer-tag-bridgehead { background: #0e7490; color: #cffafe; }
.peer-tag-unknown    { background: #1e293b; color: var(--muted); }
.direction { white-space: nowrap; }
.dir-tag { display: inline-block; font-size: 11px; padding: 1px 8px; border-radius: 999px;
           font-family: ui-monospace, monospace; font-weight: 600; letter-spacing: 0.04em;
           min-width: 36px; text-align: center; }
.dir-tag-in   { background: #1e3a8a; color: #bfdbfe; border: 1px solid #1d4ed8; }
.dir-tag-out  { background: #14532d; color: #bbf7d0; border: 1px solid #166534; }
.dir-tag-both { background: #0e7490; color: #cffafe; border: 1px solid #06b6d4; }
.status { font-size: 12px; }
.partner-row.status-ok .status { color: #22c55e; }
.partner-row.status-warn .status { color: #f59e0b; }
.partner-row.status-err .status { color: #ef4444; font-weight: 600; }
.time { font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted); }
.duration { font-family: ui-monospace, monospace; font-size: 12px; }
.empty-row { color: var(--muted); padding: 16px; }

/* Expanded attempts panel: spans the full row under the partner */
.attempts-row > .attempts-cell { padding: 0; background: #0b1220; }
.attempts-panel { padding: 10px 16px; border-top: 1px solid #1e293b; }
.attempts-empty { color: var(--muted); font-size: 12px; padding: 8px 4px; }
.attempts-table { border-collapse: collapse; background: var(--panel); width: 100%; }
.attempts-table th, .attempts-table td {
  border: 1px solid #1e293b; padding: 5px 8px; font-size: 12px; text-align: left;
}
.attempts-table th { background: #0b1220; color: var(--muted); font-size: 11px; font-weight: 600; }
.att-when { font-family: ui-monospace, monospace; white-space: nowrap; min-width: 150px; }
.att-status { white-space: nowrap; min-width: 90px; }
.att-dur, .att-obj { font-family: ui-monospace, monospace; text-align: right; min-width: 80px; }
.att-success { font-family: ui-monospace, monospace; white-space: nowrap; min-width: 150px; color: var(--muted); }
.att-err { font-size: 11px; max-width: 320px; word-break: break-all; }
.att-row-ok .att-status { color: #22c55e; }
.att-row-warn .att-status { color: #f59e0b; }
.att-row-err .att-status { color: #ef4444; font-weight: 600; }
.att-row-err .att-err { color: #fca5a5; }
.att-glyph { display: inline-block; margin-right: 4px; font-family: ui-monospace, monospace; }
.att-glyph-ok   { color: #22c55e; }
.att-glyph-warn { color: #f59e0b; }
.att-glyph-err  { color: #ef4444; }

/* 2026-08-28 round-46: port-health chip + strip styles for the inline
   port-health surface added on top of replication history. */
.port-health { white-space: nowrap; min-width: 110px; }
.port-chip { display: inline-block; width: 14px; height: 14px; line-height: 14px;
             text-align: center; border-radius: 3px; margin-right: 4px;
             font-family: ui-monospace, monospace; font-weight: 600; font-size: 11px; }
.port-chip-ok   { background: #14532d; color: #bbf7d0; border: 1px solid #166534; }
.port-chip-warn { background: #78350f; color: #fde68a; border: 1px solid #b45309; }
.port-chip-err  { background: #7f1d1d; color: #fecaca; border: 1px solid #b91c1c; }
.port-chip-none { background: #1e293b; color: var(--muted); border: 1px solid #334155; }
.port-health-text { font-size: 12px; color: var(--muted); }

.ports-strip { display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
               padding: 8px 4px 4px; font-size: 11px; color: var(--muted); }
.ports-strip-label { font-weight: 600; color: var(--muted); margin-right: 4px; }
.port-num { font-family: ui-monospace, monospace; background: #0b1220;
            color: var(--text); padding: 2px 6px; border-radius: 3px;
            border: 1px solid #1e293b; }
.port-mini-chip { display: inline-flex; gap: 3px; align-items: center;
                  padding: 2px 8px; border-radius: 999px;
                  font-family: ui-monospace, monospace; font-size: 11px;
                  font-weight: 600; letter-spacing: 0.04em; }
.port-mini-ok   { background: #14532d; color: #bbf7d0; border: 1px solid #166534; }
.port-mini-warn { background: #78350f; color: #fde68a; border: 1px solid #b45309; }
.port-mini-err  { background: #7f1d1d; color: #fecaca; border: 1px solid #b91c1c; }
</style>