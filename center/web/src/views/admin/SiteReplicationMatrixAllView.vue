<!--
  复制状态概览 (复制伙伴状态 全站)
  ────────────────────────────────
  2026-08-28 round-49: 整页视觉重做,首屏保留 R45/R47 的数据契约 (per-DC
  partner tables / status pill + caret / /pair-history lazy expand) 但
  把布局从"边框堆叠"换成"色阶分层"。

  - 顶部新增 **fleet health ribbon** — 站点 / 域控 / 入站链路 / 健康 /
    部分失败 / 失败 的总览数字,带轻微色阶(健康绿 / 警告黄 / 失败红)。
    这是 operator 扫一眼就知道全局状态的入口。
  - 站点区块:header 用 --panel-alt 区分背景,无外边框;统计 inline 排
    在右侧 (DC 数 / 链路数 / 异常数)。
  - DC 区块:不再有 dc-block 外边框,只在区块间用 1px 行分隔线;role
    badge 收紧 (fsmo 用绿色系,桥头用青色系),"成员" 这种默认标签直接
    去掉 (无 badge 即默认成员)。
  - 伙伴行:6 列不变 (caret / 类型 / 伙伴站点 / 伙伴 DC / 当前状态 /
    最近成功),保留全部 data-test 选择器;状态 pill 用方角 + 前置圆
    点,行首左侧 2px 色条代替整行染色,视觉更克制。
  - 展开行:失败时顶部增加 err-banner (失败标题 + 错误信息 + 最近尝
    试时间),attempts-table 用更小的字号 + 透明背景,视觉降级为
    "详情面板",而不是抢主行的风头。
  - 全部沿用 style.css 里的设计 token (--panel / --panel-alt /
    --border / --accent / --green / --yellow / --red / --muted),light
    / dark 主题自动适配。
-->
<template>
  <AdminLayout>
    <header class="page-header">
      <div class="page-titles">
        <div class="eyebrow">OPERATIONS · 复制健康</div>
        <h2 class="page-title">复制状态概览</h2>
        <p class="subtitle">所有站点的入站复制链路 · {{ refreshSeconds }} 秒自动刷新</p>
      </div>
      <div class="page-meta">
        <div class="refresh-pill">
          <span :class="['refresh-dot', polling ? 'on' : 'off']"></span>
          <span class="refresh-label">{{ polling ? '同步中' : '已同步' }}</span>
        </div>
        <div class="last-loaded" v-if="lastLoadedAt">
          <span class="muted-label">最近刷新</span>
          <span class="time">{{ fmt(lastLoadedAt) }}</span>
        </div>
      </div>
    </header>

    <!-- Fleet health ribbon — the signature element of this page.
      Counts derived from the loaded /all payload via a computed; tiles
      tint only when non-zero so a fully-healthy fleet reads as calm. -->
    <div class="fleet-ribbon" v-if="primaries.length" data-test="fleet-ribbon">
      <div class="ribbon-tile">
        <div class="ribbon-num">{{ totals.sites }}</div>
        <div class="ribbon-label">站点</div>
      </div>
      <div class="ribbon-tile">
        <div class="ribbon-num">{{ totals.dcs }}</div>
        <div class="ribbon-label">域控</div>
      </div>
      <div class="ribbon-tile">
        <div class="ribbon-num">{{ totals.links }}</div>
        <div class="ribbon-label">入站链路</div>
      </div>
      <div class="ribbon-tile ribbon-ok">
        <div class="ribbon-num">{{ totals.ok }}</div>
        <div class="ribbon-label">健康</div>
      </div>
      <div class="ribbon-tile" :class="{ 'ribbon-warn': totals.warn > 0 }">
        <div class="ribbon-num">{{ totals.warn }}</div>
        <div class="ribbon-label">部分失败</div>
      </div>
      <div class="ribbon-tile" :class="{ 'ribbon-err': totals.err > 0 }">
        <div class="ribbon-num">{{ totals.err }}</div>
        <div class="ribbon-label">失败</div>
      </div>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="!primaries.length && !error" class="empty">暂无站点 — 请在 AD 站点清单添加</div>

    <section v-for="p in primaries" :key="p.siteId ?? p.siteName" class="site-block" :data-test-site="p.siteName">
      <header class="site-header">
        <div class="site-title">
          <h3>
            <span :class="['hub-badge', p.isHub ? 'yes' : 'no']">{{ p.isHub ? '中心站点' : '分支站点' }}</span>
            {{ p.siteName }}
            <span class="site-region">{{ p.regionCode || '—' }}</span>
          </h3>
        </div>
        <div class="site-stats">
          <span class="stat"><span class="stat-num">{{ (p.dcs || []).length }}</span><span class="stat-label"> DC</span></span>
          <span class="stat"><span class="stat-num">{{ siteLinkCount(p) }}</span><span class="stat-label"> 链路</span></span>
          <span v-if="siteErrCount(p) > 0" class="stat stat-error"><span class="stat-num">{{ siteErrCount(p) }}</span><span class="stat-label"> 异常</span></span>
        </div>
      </header>

      <div v-if="!p.dcPartners || !p.dcPartners.length" class="empty">该站点暂无 DC</div>

      <div v-for="dc in p.dcPartners" :key="dc.dcName" class="dc-block" :data-test-dc-block="dc.dcName">
        <header class="dc-header">
          <span class="dc-name">{{ dc.dcName }}</span>
          <span class="dc-roles-inline">
            <span v-if="dc.isBridgehead" class="role-badge bridgehead">桥头</span>
            <span v-if="dc.isPdc" class="role-badge fsmo">PDC</span>
            <span v-if="dc.isGc" class="role-badge fsmo">GC</span>
            <span v-if="dc.isRidMaster" class="role-badge fsmo">RID</span>
            <span v-if="dc.isSchemaMaster" class="role-badge fsmo">Schema</span>
            <span v-if="dc.isDomainNamingMaster" class="role-badge fsmo">DNaming</span>
            <span v-if="dc.isInfrastructureMaster" class="role-badge fsmo">Infra</span>
          </span>
          <span class="dc-os-inline">{{ dc.osVersion || '—' }}</span>
          <span class="dc-partner-count">{{ dc.partners.length }} 伙伴</span>
        </header>

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
                <td>
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
                  <div v-else class="attempts-container">
                    <div v-if="partner.statusCode !== 0" class="err-banner">
                      <div class="err-banner-icon">!</div>
                      <div class="err-banner-body">
                        <div class="err-banner-title">
                          <strong>{{ statusLabel(partner) }}</strong>
                          <span v-if="partner.errorMessage">— {{ partner.errorMessage }}</span>
                        </div>
                        <div v-if="partner.lastAttemptTime" class="err-banner-meta">最近尝试 {{ fmt(partner.lastAttemptTime) }}</div>
                      </div>
                    </div>
                    <table class="attempts-table">
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
                  </div>
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
import { ref, computed, onMounted, onUnmounted } from 'vue';
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

// round-49: fleet-level totals for the ribbon. Walks the loaded payload
// once per render — O(DCs × partners). Cheap enough to keep as a
// computed; the alternative (memoizing on a load-tick) adds complexity
// for a win we don't need.
const totals = computed(() => {
  let sites = 0, dcs = 0, links = 0, ok = 0, warn = 0, err = 0;
  for (const p of primaries.value) {
    sites++;
    dcs += (p.dcs || []).length;
    for (const dc of (p.dcPartners || [])) {
      for (const partner of dc.partners) {
        links++;
        if (partner.statusCode === 0) ok++;
        else if (partner.statusCode === 1) warn++;
        else err++;
      }
    }
  }
  return { sites, dcs, links, ok, warn, err };
});

function siteLinkCount(p) {
  let n = 0;
  for (const dc of (p.dcPartners || [])) n += dc.partners.length;
  return n;
}
function siteErrCount(p) {
  let n = 0;
  for (const dc of (p.dcPartners || [])) {
    for (const partner of dc.partners) {
      if (partner.statusCode !== 0) n++;
    }
  }
  return n;
}

async function load() {
  polling.value = true;
  error.value = '';
  try {
    const r = await dashboardApi.getSiteReplicationMatrixAll();
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
/* ===== Page header ===================================================== */
.page-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 24px; margin-bottom: 20px; padding-bottom: 18px;
  border-bottom: 1px solid var(--border);
}
.page-titles { display: flex; flex-direction: column; gap: 4px; }
.eyebrow {
  font-size: 10px; font-weight: 600; letter-spacing: 0.14em;
  color: var(--muted); text-transform: uppercase;
}
.page-title {
  margin: 0; font-size: 20px; font-weight: 600; color: var(--text);
  letter-spacing: -0.01em;
}
.subtitle { margin: 0; font-size: 13px; color: var(--muted); }
.page-meta { display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
.refresh-pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px; border-radius: 999px;
  background: var(--panel-alt); border: 1px solid var(--border);
  font-size: 11px; color: var(--text); font-weight: 500;
}
.refresh-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.refresh-dot.on  { background: var(--green); box-shadow: 0 0 6px rgba(34, 197, 94, 0.6); }
.refresh-dot.off { background: var(--muted); }
.refresh-label { font-size: 11px; letter-spacing: 0.02em; }
.last-loaded { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; }
.muted-label {
  font-size: 9px; color: var(--muted);
  letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600;
}
.time {
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 11px; color: var(--text);
  font-feature-settings: "tnum";
}

/* ===== Fleet health ribbon (signature element) ========================= */
.fleet-ribbon {
  display: grid; grid-template-columns: repeat(6, 1fr);
  gap: 1px; margin-bottom: 24px;
  background: var(--border); border: 1px solid var(--border); border-radius: 4px;
  overflow: hidden;
}
.ribbon-tile {
  background: var(--panel); padding: 14px 18px;
  display: flex; flex-direction: column; gap: 2px; min-width: 0;
}
.ribbon-tile.ribbon-ok   { background: linear-gradient(180deg, rgba(34, 197, 94, 0.08), var(--panel)); }
.ribbon-tile.ribbon-warn { background: linear-gradient(180deg, rgba(234, 179, 8, 0.12), var(--panel)); }
.ribbon-tile.ribbon-err  { background: linear-gradient(180deg, rgba(239, 68, 68, 0.14), var(--panel)); }
.ribbon-num {
  font-size: 22px; font-weight: 600; line-height: 1;
  font-feature-settings: "tnum"; letter-spacing: -0.01em;
  color: var(--text);
}
.ribbon-tile.ribbon-warn .ribbon-num { color: var(--yellow); }
.ribbon-tile.ribbon-err  .ribbon-num { color: var(--red); }
.ribbon-label {
  font-size: 11px; color: var(--muted);
  letter-spacing: 0.06em; margin-top: 4px; font-weight: 500;
}

/* ===== Error / empty states ============================================ */
.error-banner {
  background: var(--red-bg); color: var(--red);
  padding: 10px 14px; border-radius: 4px; margin-bottom: 16px;
  border: 1px solid rgba(239, 68, 68, 0.3); font-size: 13px;
}
.empty { text-align: center; color: var(--muted); padding: 28px; font-size: 13px; }
.loading { text-align: center; color: var(--muted); padding: 16px; font-size: 12px; }

/* ===== Site section ==================================================== */
.site-block {
  margin-bottom: 24px;
  background: var(--panel);
  border: 1px solid var(--border); border-radius: 4px;
  overflow: hidden;
}
.site-header {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 12px 16px;
  background: var(--panel-alt);
  border-bottom: 1px solid var(--border);
}
.site-title { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.site-title h3 {
  margin: 0; font-size: 15px; font-weight: 600; color: var(--text);
  letter-spacing: -0.005em;
  display: inline-flex; align-items: baseline; gap: 10px;
}
.hub-badge {
  padding: 2px 8px; border-radius: 3px; font-size: 10px; font-weight: 600;
  letter-spacing: 0.08em; text-transform: uppercase;
}
.hub-badge.yes { background: rgba(56, 189, 248, 0.15); color: var(--accent); border: 1px solid rgba(56, 189, 248, 0.3); }
.hub-badge.no  { background: var(--bg); color: var(--muted); border: 1px solid var(--border); }
.site-region {
  font-size: 11px; color: var(--muted);
  font-family: ui-monospace, monospace;
  letter-spacing: 0.04em;
}
.site-stats { display: flex; gap: 18px; flex-shrink: 0; }
.stat { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; }
.stat-num {
  font-size: 14px; font-weight: 600; color: var(--text);
  font-feature-settings: "tnum"; letter-spacing: -0.01em;
}
.stat-error .stat-num { color: var(--red); }
.stat-label {
  font-size: 10px; color: var(--muted);
  letter-spacing: 0.06em; font-weight: 500;
}

/* ===== DC block ======================================================== */
.dc-block { border-top: 1px solid var(--border); }
.dc-block:first-child { border-top: 0; }
.dc-header {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 16px;
  background: var(--panel);
  font-size: 13px;
}
.dc-name {
  font-family: ui-monospace, "SF Mono", monospace;
  font-weight: 600; font-size: 13px; color: var(--text);
  letter-spacing: 0.02em;
}
.dc-roles-inline { display: inline-flex; flex-wrap: wrap; gap: 3px; }
.role-badge {
  font-size: 10px; padding: 1px 6px; border-radius: 3px;
  font-family: ui-monospace, monospace; letter-spacing: 0.04em; font-weight: 500;
}
.role-badge.fsmo {
  background: rgba(34, 197, 94, 0.10); color: var(--green);
  border: 1px solid rgba(34, 197, 94, 0.3);
}
.role-badge.bridgehead {
  background: rgba(14, 116, 144, 0.18); color: #0e7490;
  border: 1px solid rgba(14, 116, 144, 0.4); font-weight: 600;
}
.dc-os-inline {
  color: var(--muted); font-size: 11px;
  font-family: ui-monospace, monospace;
}
.dc-partner-count {
  margin-left: auto;
  color: var(--muted); font-size: 11px;
  font-feature-settings: "tnum"; letter-spacing: 0.02em;
}

/* ===== Partner matrix ================================================== */
.matrix { border-collapse: collapse; background: var(--panel); width: 100%; }
.matrix th, .matrix td {
  padding: 9px 12px; text-align: left; font-size: 13px;
  color: var(--text); vertical-align: middle;
  border-top: 1px solid rgba(51, 65, 81, 0.4);
}
.matrix tbody tr:first-child td { border-top: 0; }
.matrix th {
  background: var(--panel-alt); color: var(--muted); font-size: 10px; font-weight: 600;
  letter-spacing: 0.10em; text-transform: uppercase;
  padding: 8px 12px; border-top: 0;
  font-family: ui-monospace, monospace;
}
.partner-row td { transition: background-color 0.1s ease; }
.partner-row:hover td { background: var(--panel-alt); }
/* Subtle 2px left edge tint signals row severity without flooding the
  whole row with color. */
.partner-row td:first-child {
  border-left: 2px solid transparent;
  padding-left: 10px;
}
.partner-row.status-warn td:first-child { border-left-color: var(--yellow); }
.partner-row.status-err  td:first-child { border-left-color: var(--red); }

.caret-col { width: 36px; padding: 4px 8px; text-align: center; }
.caret-btn {
  background: transparent; border: 1px solid var(--border); border-radius: 3px;
  width: 26px; height: 22px; padding: 0; cursor: pointer; color: var(--muted);
  font-size: 11px; line-height: 1; transition: all 0.1s ease;
}
.caret-btn:hover { background: var(--panel-alt); color: var(--accent); border-color: var(--accent); }
.caret-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.last-success-col { min-width: 150px; }
.last-success-cell {
  color: var(--muted); font-family: ui-monospace, monospace; font-size: 11px;
  white-space: nowrap; font-feature-settings: "tnum";
}
.peer-dc { font-family: ui-monospace, monospace; font-size: 12px; }
.peer-site { font-weight: 500; }
.hub-mini {
  font-size: 9px; padding: 1px 5px; margin-left: 6px; border-radius: 2px;
  background: rgba(56, 189, 248, 0.15); color: var(--accent);
  letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600;
}
.peer-tag {
  display: inline-block; font-size: 10px; padding: 1px 7px; border-radius: 2px;
  font-family: ui-monospace, monospace; font-weight: 600; letter-spacing: 0.06em;
  text-transform: uppercase;
}
.peer-tag-within {
  background: var(--panel-alt); color: var(--muted);
  border: 1px solid var(--border);
}
.peer-tag-bridgehead {
  background: rgba(14, 116, 144, 0.18); color: #0e7490;
  border: 1px solid rgba(14, 116, 144, 0.4);
}
.peer-tag-unknown {
  background: var(--panel-alt); color: var(--muted);
}

/* ===== Status pill ===================================================== */
.status-pill {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 10px; padding: 2px 8px; border-radius: 2px;
  font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
  font-family: ui-monospace, monospace;
}
.status-pill::before {
  content: ''; display: inline-block;
  width: 5px; height: 5px; border-radius: 50%;
}
.status-pill-ok {
  background: rgba(34, 197, 94, 0.10); color: var(--green);
  border: 1px solid rgba(34, 197, 94, 0.3);
}
.status-pill-ok::before   { background: var(--green); }
.status-pill-warn {
  background: rgba(234, 179, 8, 0.10); color: var(--yellow);
  border: 1px solid rgba(234, 179, 8, 0.3);
}
.status-pill-warn::before { background: var(--yellow); }
.status-pill-err {
  background: rgba(239, 68, 68, 0.10); color: var(--red);
  border: 1px solid rgba(239, 68, 68, 0.3);
}
.status-pill-err::before  { background: var(--red); }
.err-msg {
  display: block; margin-top: 4px;
  color: var(--red); font-size: 11px;
  font-family: ui-monospace, monospace;
  line-height: 1.4;
}

/* ===== Attempts (history) ============================================== */
.attempts-row td {
  background: var(--bg); padding: 0;
  border-top: 1px solid var(--border);
}
.attempts-container { padding: 14px 18px 16px; }
.err-banner {
  display: flex; gap: 12px; align-items: flex-start;
  padding: 10px 12px; margin-bottom: 12px;
  background: var(--red-bg); border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 3px;
}
.err-banner-icon {
  flex: 0 0 22px; height: 22px; border-radius: 50%;
  background: var(--red); color: white;
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 13px; line-height: 1;
}
.err-banner-body { flex: 1; min-width: 0; font-size: 12px; }
.err-banner-title { color: var(--text); line-height: 1.5; }
.err-banner-title strong { color: var(--red); margin-right: 4px; font-weight: 600; }
.err-banner-meta {
  color: var(--muted); font-size: 11px; margin-top: 3px;
  font-family: ui-monospace, monospace; font-feature-settings: "tnum";
}
.attempts-table { width: 100%; border-collapse: collapse; }
.attempts-table th, .attempts-table td {
  border: 0; border-top: 1px solid rgba(51, 65, 81, 0.3);
  padding: 5px 8px; text-align: left; font-size: 11px;
  font-family: ui-monospace, monospace; font-feature-settings: "tnum";
}
.attempts-table th {
  background: transparent; color: var(--muted); font-weight: 600;
  font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase;
  padding: 4px 8px; border-top: 0;
}
.attempts-table tbody tr:first-child td { border-top: 1px solid var(--border); }
.att-row-ok   { color: var(--text); }
.att-row-warn { color: var(--text); }
.att-row-err  { color: var(--text); }
.att-row .glyph {
  font-family: ui-monospace, monospace; font-weight: 700; margin-right: 4px;
  display: inline-block; width: 8px;
}
.att-row-ok   .glyph { color: var(--green); }
.att-row-warn .glyph { color: var(--yellow); }
.att-row-err  .glyph { color: var(--red); }
.empty-row { color: var(--muted); padding: 18px; text-align: center; font-size: 12px; }
</style>