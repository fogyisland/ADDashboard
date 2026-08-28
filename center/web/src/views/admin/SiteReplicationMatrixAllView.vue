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

    <!-- 2026-08-28 round-45: R42 复制日志监控 absorbed into this view.
         Port monitoring (R35) removed entirely — operator directive
         "去掉端口监控，但是他保留复制过程的详细信息，例如复制成功，
         显示复制成功，但是失败了会显示详细信息。在最右边折叠最近10条的信息".
         Each partner row now shows a status pill + a right-column caret
         that lazy-fetches the last 10 replication attempts for that pair. -->
    <p class="hint">
      每个站点的每台 DC 各自显示自己的入站复制连接 — 即其他 DC 复制到本机的链路。
      状态: 复制成功 (绿色) / 部分失败 (黄色) / 失败 (红色,显示错误信息)。
      点击最右侧箭头展开最近 10 条复制尝试历史。
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

        <table class="matrix">
          <thead>
            <tr>
              <th class="caret-col"></th>
              <th>类型</th>
              <th>伙伴站点</th>
              <th>伙伴 DC</th>
              <th>当前状态</th>
              <th class="last-success-col">最近成功</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="partner in dc.partners" :key="`${dc.dcName}-${partner.peerType}-${partner.peerDc}`">
              <tr :class="rowClass(partner)"
                  :data-test="`partner-${partner.peerType}-${dc.dcName}-${partner.peerDc}`">
                <td class="caret-col">
                  <button class="caret-btn"
                          :data-test="`caret-${dc.dcName}-${partner.peerDc}`"
                          :aria-label="isExpanded(dc.dcName, partner) ? '折叠历史' : '展开历史'"
                          @click="togglePartner(dc.dcName, partner)">
                    {{ isExpanded(dc.dcName, partner) ? '▼' : '▶' }}
                  </button>
                </td>
                <td class="peer-type">
                  <span :class="['peer-tag', `peer-tag-${partner.peerType || 'unknown'}`]">{{ peerTypeLabel(partner) }}</span>
                </td>
                <td>
                  <span class="peer-site">{{ partner.peerSite }}</span>
                  <span v-if="partner.peerSiteIsHub" class="hub-mini">中心</span>
                </td>
                <td class="peer-dc">{{ partner.peerDc }}</td>
                <td class="status">
                  <span :class="['status-pill', `status-pill-${statusClass(partner)}`]">{{ statusLabel(partner) }}</span>
                  <span v-if="partner.statusCode !== 0 && partner.errorMessage" class="err-msg">— {{ partner.errorMessage }}</span>
                  <span v-else-if="partner.statusCode !== 0 && partner.lastAttemptTime" class="err-meta">— 最近尝试 {{ fmt(partner.lastAttemptTime) }}</span>
                </td>
                <td class="last-success-cell">{{ fmt(partner.lastSuccessTime) }}</td>
              </tr>
              <tr v-if="isExpanded(dc.dcName, partner)"
                  class="attempts-row"
                  :data-test="`attempts-${dc.dcName}-${partner.peerDc}`">
                <td colspan="6">
                  <div v-if="loadingPair === expandKey(dc.dcName, partner)" class="loading">加载中…</div>
                  <div v-else-if="(attemptsByKey(expandKey(dc.dcName, partner)) || []).length === 0" class="empty">
                    暂无历史记录 — 该伙伴没有 24h 内的连接尝试数据
                  </div>
                  <table v-else class="attempts-table">
                    <thead>
                      <tr>
                        <th>尝试时间</th>
                        <th>结果</th>
                        <th>耗时 (ms)</th>
                        <th>传输对象</th>
                        <th>最近成功</th>
                        <th>错误/详情</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(a, i) in attemptsByKey(expandKey(dc.dcName, partner))" :key="i"
                          :class="['att-row', `att-row-${attemptStatusClass(a)}`]">
                        <td>{{ fmt(a.attemptAt) }}</td>
                        <td>
                          <span class="glyph">{{ attemptGlyph(a) }}</span>
                          {{ attemptLabel(a) }}
                        </td>
                        <td>{{ a.durationMs ?? '—' }}</td>
                        <td>{{ a.objectsTransferred ?? '—' }}</td>
                        <td>{{ fmt(a.lastSuccessTime) }}</td>
                        <td>{{ a.errorMessage || '—' }}</td>
                      </tr>
                    </tbody>
                  </table>
                </td>
              </tr>
            </template>
            <tr v-if="!dc.partners.length">
              <td colspan="6" class="empty-row">无伙伴连接</td>
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
const refreshSeconds = ref(10);
const lastLoadedAt = ref(null);
const error = ref('');
const polling = ref(false);

// round-45 inline expansion state.
const expanded = ref(new Set());     // set of `${dc}|${peerDc}` keys
const attempts = ref(new Map());     // key → entries[]
const loadingPair = ref(null);       // currently fetching

let timerHandle = null;

async function load() {
  polling.value = true;
  error.value = '';
  try {
    const r = await dashboardApi.getSiteReplicationMatrixAll();
    // round-45: ports/perPort/lastProbeAt dropped from envelope.
    primaries.value = Array.isArray(r.data?.primaries) ? r.data.primaries : [];
    refreshSeconds.value = Number(r.data?.siteRefreshSeconds) || 10;
    lastLoadedAt.value = new Date().toISOString();
    pruneExpanded();
  } catch (e) {
    error.value = e?.response?.data?.error || '加载失败';
  } finally {
    polling.value = false;
  }
}

function expandKey(dc, p) { return `${dc}|${p.peerDc}`; }
function isExpanded(dc, p) { return expanded.value.has(expandKey(dc, p)); }
function attemptsByKey(key) { return attempts.value.get(key); }

function pruneExpanded() {
  // Drop expansion keys (and cached attempts) for partners that no longer
  // exist in the latest /all payload — keeps the state map bounded across
  // polling cycles.
  const valid = new Set();
  for (const p of primaries.value) {
    for (const dc of (p.dcPartners || [])) {
      for (const partner of dc.partners) {
        valid.add(expandKey(dc.dcName, partner));
      }
    }
  }
  for (const k of [...expanded.value]) {
    if (!valid.has(k)) expanded.value.delete(k);
  }
  for (const k of [...attempts.value.keys()]) {
    if (!valid.has(k)) attempts.value.delete(k);
  }
}

async function togglePartner(dcName, partner) {
  const key = expandKey(dcName, partner);
  if (expanded.value.has(key)) {
    expanded.value.delete(key);
    return;
  }
  expanded.value.add(key);
  // Lazy fetch only on first expansion — repeated toggles reuse the cache.
  if (!attempts.value.has(key)) {
    loadingPair.value = key;
    try {
      const r = await dashboardApi.getSiteReplicationMatrixPairHistory(partner.peerDc, dcName, 10);
      attempts.value.set(key, Array.isArray(r.data?.entries) ? r.data.entries : []);
    } catch (e) {
      attempts.value.set(key, []);
      error.value = e?.response?.data?.error || '加载历史失败';
    } finally {
      loadingPair.value = null;
    }
  }
}

// Status helpers — main row uses plain text, history rows keep the
// compact ●▲✕ glyph vocabulary operators are used to from R42.
function statusClass(p) {
  if (p.statusCode === 0) return 'ok';
  if (p.statusCode === 1) return 'warn';
  return 'err';
}
function statusLabel(p) {
  if (p.statusCode === 0) return '复制成功';
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
function attemptStatusClass(a) {
  if (a.statusCode === 0) return 'ok';
  if (a.statusCode === 1) return 'warn';
  return 'err';
}
function attemptGlyph(a) {
  if (a.statusCode === 0) return '●';
  if (a.statusCode === 1) return '▲';
  return '✕';
}
function attemptLabel(a) {
  if (a.statusCode === 0) return '成功';
  if (a.statusCode === 1) return '部分失败';
  return '失败';
}
function peerTypeLabel(p) {
  if (p.peerType === 'within') return '本站';
  if (p.peerType === 'bridgehead') return '桥头';
  return '未知';
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
.error-banner { background: var(--red-bg); color: var(--red); padding: 8px 12px; border-radius: 3px; margin-bottom: 12px; }
.empty { text-align: center; color: var(--muted); padding: 24px; }
.loading { text-align: center; color: var(--muted); padding: 12px; }

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
.legend { display: flex; gap: 12px; margin: 0 0 16px; font-size: 12px; color: var(--muted); }
.legend-item { display: inline-flex; gap: 6px; align-items: center; }
.legend-swatch { display: inline-block; width: 12px; height: 12px; border-radius: 3px; border: 1px solid var(--border); }
.swatch-primary { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.swatch-bridgehead { border-color: #0e7490; }
.swatch-member { border-color: #1e293b; background: var(--panel); }

.matrix { border-collapse: collapse; background: var(--panel); width: 100%; }
.matrix th, .matrix td { border: 1px solid #1e293b; padding: 6px 10px; text-align: center; font-size: 13px; }
.matrix th { background: #0b1220; color: var(--muted); font-size: 12px; font-weight: 600; }
.matrix tbody tr:nth-child(even) { background: rgba(255,255,255,0.02); }
.caret-col { width: 36px; padding: 4px; }
.caret-btn { background: transparent; border: 1px solid var(--border); border-radius: 3px;
             width: 28px; height: 24px; padding: 0; cursor: pointer; color: var(--text);
             font-family: ui-monospace, monospace; font-size: 11px; line-height: 1; }
.caret-btn:hover { background: var(--border); color: var(--accent); }
.last-success-col { min-width: 140px; }
.last-success-cell { color: var(--muted); font-family: ui-monospace, monospace; font-size: 12px; }

.partner-row.status-ok .status { color: var(--text); }
.partner-row.status-warn .status { color: var(--text); }
.partner-row.status-err .status { color: var(--text); }
.peer-site { font-weight: 500; }
.peer-dc { font-family: ui-monospace, monospace; font-size: 12px; }
.peer-type { white-space: nowrap; }
.peer-tag { display: inline-block; font-size: 11px; padding: 1px 8px; border-radius: 999px;
            font-family: ui-monospace, monospace; font-weight: 600; letter-spacing: 0.04em; }
.peer-tag-within     { background: #1e293b; color: var(--text); border: 1px solid #334155; }
.peer-tag-bridgehead { background: #0e7490; color: #cffafe; }
.peer-tag-unknown    { background: #1e293b; color: var(--muted); }

.status-pill { display: inline-block; font-size: 11px; padding: 2px 10px;
               border-radius: 999px; font-weight: 600; letter-spacing: 0.02em; }
.status-pill-ok   { background: rgba(34,197,94,0.15);  color: #22c55e; border: 1px solid #166534; }
.status-pill-warn { background: rgba(234,179,8,0.18);  color: #f59e0b; border: 1px solid #92400e; }
.status-pill-err  { background: rgba(239,68,68,0.18);  color: #ef4444; border: 1px solid #991b1b; }
.err-msg { color: var(--red); font-size: 11px; margin-left: 6px; }
.err-meta { color: var(--muted); font-size: 11px; margin-left: 6px; }

.attempts-row td { background: rgba(255,255,255,0.02); padding: 8px 12px; }
.attempts-table { width: 100%; border-collapse: collapse; }
.attempts-table th, .attempts-table td { border: 1px solid #1e293b; padding: 4px 8px;
                                         text-align: center; font-size: 12px; }
.attempts-table th { background: #0b1220; color: var(--muted); font-weight: 600; }
.att-row-ok   { color: var(--text); }
.att-row-warn { color: var(--yellow); }
.att-row-err  { color: var(--red); }
.att-row .glyph { font-family: ui-monospace, monospace; font-weight: 700; margin-right: 4px; }
.att-row-ok   .glyph { color: var(--green); }
.att-row-warn .glyph { color: var(--yellow); }
.att-row-err  .glyph { color: var(--red); }
.empty-row { color: var(--muted); padding: 16px; }
</style>
