<!--
  站点矩阵 — N×N 站点复制健康矩阵
  2026-08-29 R60 (operator directive "站点矩阵不用那么复杂,只保留最新的状态,
  在一个页面中显示所有的站点连接状态,没有问题绿色,有问题黄色,断开红色。
  不用做的特别复杂,要容忍足够多的数据出现") extracted into a standalone
  page on R64. This is the 站点矩阵 view, distinct from 复制状态概览 (which
  restored the R49 ops-console per-DC partner tables view).

  - Single page. One N×N matrix: sites as rows × sites as columns.
  - Cells show replication health color (green / yellow / red / gray)
    plus a compact status glyph (✓ / ! / ✕ / ·) and the partner-link
    count ("3/3").
  - Sticky first column (row headers = site names + DC count) and
    sticky first row (column headers = site names + DC count); the
    grid scrolls horizontally if there are many sites.
  - Hover a cell → tooltip lists the individual partner links between
    those two sites (source DC, dest DC, statusCode, lastSuccessTime,
    errorMessage). No drill-down / lazy fetch — only the latest state.
  - Click a cell → cell-detail modal listing every (sourceDc → destDc)
    pair in the site-pair with status pill + last success + error
    message (R71 — drillability round 3; complements R69 node-modal +
    R70 edge-modal). Self cells (srcSite === dstSite) are NOT clickable.
  - Legend strip (3 colored squares + labels) at the top + a one-line
    summary of total link counts.
  - The data contract is unchanged from R60 — same
    /api/dashboard/site-replication-matrix/all endpoint, same
    primaries[].dcPartners[].partners[] payload.
-->
<template>
  <!--
    2026-08-30 R64.2 fix: 站点矩阵 前台专属 — 用 AppLayout 包 (不再用 AdminLayout).
    R64 split 把 /matrix 拆成独立前台页面,R64.1 从 AdminLayout nav 删了链接,
    但 SiteMatrixView.vue 组件本身还包着 AdminLayout → 前台点进来后渲染后台壳.
    这里换成 AppLayout 才彻底脱离后台。
  -->
  <AppLayout>
    <header class="page-header">
      <div class="page-titles">
        <h2 class="page-title">站点矩阵</h2>
        <p class="subtitle">所有站点的入站复制链路 · {{ refreshSeconds }} 秒自动刷新</p>
      </div>
      <div class="page-meta">
        <span class="time" v-if="lastLoadedAt">{{ fmt(lastLoadedAt) }}</span>
        <span class="dot" :class="polling ? 'on' : 'off'" aria-hidden="true"></span>
      </div>
    </header>

    <!-- Legend + 1-line totals — operator reads these in 1 second. The
         "站点 N (Hub X · Spoke Y)" item surfaces the Hub-Spoke split (R68)
         so the operator sees the architecture shape at a glance. -->
    <div class="legend" data-test="legend">
      <span class="legend-item">
        <span class="swatch swatch-ok"></span>正常 <strong>{{ totals.ok }}</strong>
      </span>
      <span class="legend-item">
        <span class="swatch swatch-warn"></span>部分失败 <strong>{{ totals.warn }}</strong>
      </span>
      <span class="legend-item">
        <span class="swatch swatch-err"></span>断开 <strong>{{ totals.err }}</strong>
      </span>
      <span class="legend-divider"></span>
      <span class="legend-item muted" data-test="legend-sites">
        站点 <strong>{{ totals.sites }}</strong>
        <span class="hub-tag-mini">Hub {{ hubSites.length }}</span>
        <span class="spoke-tag-mini">Spoke {{ spokeSites.length }}</span>
      </span>
      <span class="legend-item muted">域控 <strong>{{ totals.dcs }}</strong></span>
      <span class="legend-item muted">链路 <strong>{{ totals.links }}</strong></span>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>

    <div v-if="!primaries.length && !error" class="empty">暂无站点 — 请在 AD 站点清单添加</div>

    <!-- ── Panel 1: 核心层 Hub ↔ Hub (R68 layered matrix). ─────────────
         Only renders when ≥ 2 Hubs (a single Hub would be a self-loop).
         Hub↔Hub is the load-bearing layer: failures here fan out to every
         Spoke. Cells get extra visual emphasis (gold tint + thicker border)
         via the `.cell-hub-pair` modifier. -->
    <section
      v-if="hubSites.length >= 2"
      class="layer-panel hub-panel"
      data-test="hub-panel"
    >
      <header class="layer-header">
        <h3 class="layer-title">核心层 (Hub ↔ Hub)</h3>
        <span class="layer-tag hub-tag">承载层 · {{ hubSites.length }} 中心</span>
      </header>
      <p class="layer-sub">核心站点相互复制,这是 Hub-Spoke 架构的"承载层",故障会立即放大到所有分支。</p>
      <div class="matrix-wrap">
        <table class="matrix hub-matrix">
          <thead>
            <tr>
              <th class="row-head-corner" scope="col"></th>
              <th
                v-for="s in hubSites"
                :key="`hub-col-${s.siteName}`"
                scope="col"
                class="col-head hub-col-head"
                :title="`${s.siteName} · ${s.dcCount} DC`"
              >
                <div class="col-name">{{ s.siteName }}</div>
                <div class="col-meta">{{ s.dcCount }} DC</div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="rs in hubSites" :key="`hub-row-${rs.siteName}`">
              <th scope="row" class="row-head hub-row-head" :title="`${rs.siteName} · ${rs.dcCount} DC`">
                <div class="row-name">{{ rs.siteName }}</div>
                <div class="row-meta">
                  <span class="row-meta-num">{{ rs.dcCount }}</span><span class="row-meta-label"> DC</span>
                </div>
              </th>
              <td
                v-for="cs in hubSites"
                :key="`hub-cell-${rs.siteName}-${cs.siteName}`"
                :class="['cell', `cell-${cellState(rs.siteName, cs.siteName)}`, 'cell-hub-pair', cellClickableClass(rs.siteName, cs.siteName)]"
                :data-test="`cell-${rs.siteName}-${cs.siteName}`"
                :title="cellTooltip(rs.siteName, cs.siteName)"
                @click="handleCellClick(rs.siteName, cs.siteName)"
              >
                <span class="cell-glyph">{{ cellGlyph(rs.siteName, cs.siteName) }}</span>
                <span class="cell-num">{{ cellText(rs.siteName, cs.siteName) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── Panel 2: 接入层 Spoke → Hub. ────────────────────────────────
         Each Spoke row × each Hub col shows whether the Spoke is inbound-
         replicating from each Hub. Inbound-only: cellState(src=Spoke, dst=Hub)
         = is Spoke receiving from Hub. The reverse direction (Hub receiving
         from Spoke) is the "designed absence" — only visible in panel 3. -->
    <section
      v-if="spokeSites.length && hubSites.length"
      class="layer-panel spoke-panel"
      data-test="spoke-panel"
    >
      <header class="layer-header">
        <h3 class="layer-title">接入层 (Spoke → Hub)</h3>
        <span class="layer-tag spoke-tag">分支 → 中心 · {{ spokeSites.length }} 分支</span>
      </header>
      <p class="layer-sub">每个分支站点到各 Hub 中心的复制状态。Spoke 应只向就近 Hub 复制,Spoke↔Spoke 不应有链路(违反 Hub-Spoke)。</p>
      <div class="matrix-wrap">
        <table class="matrix spoke-matrix">
          <thead>
            <tr>
              <th class="row-head-corner" scope="col"></th>
              <th
                v-for="h in hubSites"
                :key="`spoke-col-${h.siteName}`"
                scope="col"
                class="col-head hub-col-head"
                :title="`${h.siteName} · ${h.dcCount} DC`"
              >
                <div class="col-name">{{ h.siteName }}</div>
                <div class="col-meta">中心</div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="sp in spokeSites" :key="`spoke-row-${sp.siteName}`">
              <th scope="row" class="row-head spoke-row-head" :title="`${sp.siteName} · ${sp.dcCount} DC`">
                <div class="row-name">{{ sp.siteName }}</div>
                <div class="row-meta">
                  <span class="row-meta-num">{{ sp.dcCount }}</span><span class="row-meta-label"> DC</span>
                </div>
              </th>
              <td
                v-for="hub in hubSites"
                :key="`spoke-cell-${sp.siteName}-${hub.siteName}`"
                :class="['cell', `cell-${cellState(sp.siteName, hub.siteName)}`, 'cell-hub-spoke', cellClickableClass(sp.siteName, hub.siteName)]"
                :data-test="`cell-${sp.siteName}-${hub.siteName}`"
                :title="cellTooltip(sp.siteName, hub.siteName)"
                @click="handleCellClick(sp.siteName, hub.siteName)"
              >
                <span class="cell-glyph">{{ cellGlyph(sp.siteName, hub.siteName) }}</span>
                <span class="cell-num">{{ cellText(sp.siteName, hub.siteName) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── Panel 3: 全矩阵 (所有站点). ──────────────────────────────────
         The original R60 N×N matrix. Preserved verbatim for deep-dive use:
         every site pair is visible, including Spoke↔Spoke (which R68 marks
         as "designed absence" — these cells SHOULD be empty in Hub-Spoke
         compliance). The view stays fully compatible with the existing
         test selectors (`data-test="cell-X-Y"` resolves here). -->
    <section
      v-if="sites.length"
      class="layer-panel full-panel"
      data-test="full-panel"
    >
      <header class="layer-header">
        <h3 class="layer-title">全矩阵 (所有站点)</h3>
        <span class="layer-tag">完整视图 · {{ sites.length }} 站点 × {{ sites.length }} 站点</span>
      </header>
      <div class="matrix-wrap">
        <table class="matrix">
          <thead>
            <tr>
              <th class="row-head-corner" scope="col"></th>
              <th
                v-for="s in sites"
                :key="`col-${s.siteName}`"
                scope="col"
                class="col-head"
                :title="`${s.siteName} · ${s.dcCount} DC`"
              >
                <div class="col-name">{{ s.siteName }}</div>
                <div class="col-meta">{{ s.dcCount }} DC</div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="rs in sites" :key="`row-${rs.siteName}`">
              <th scope="row" class="row-head" :title="`${rs.siteName} · ${rs.dcCount} DC`">
                <div class="row-name">{{ rs.siteName }}</div>
                <div class="row-meta">
                  <span class="row-meta-num">{{ rs.dcCount }}</span><span class="row-meta-label"> DC</span>
                </div>
              </th>
              <td
                v-for="cs in sites"
                :key="`cell-${rs.siteName}-${cs.siteName}`"
                :class="['cell', `cell-${cellState(rs.siteName, cs.siteName)}`, cellClickableClass(rs.siteName, cs.siteName)]"
                :data-test="`cell-${rs.siteName}-${cs.siteName}`"
                :title="cellTooltip(rs.siteName, cs.siteName)"
                @click="handleCellClick(rs.siteName, cs.siteName)"
              >
                <span class="cell-glyph">{{ cellGlyph(rs.siteName, cs.siteName) }}</span>
                <span class="cell-num">{{ cellText(rs.siteName, cs.siteName) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── R71: cell-detail modal ───────────────────────────────────────
         Click any non-self cell in any of the 3 panels to drill into the
         underlying DC pairs of that site-pair. Lists every (sourceDc →
         destDc) link with status pill + last success + error message.
         Backdrop click (.self) closes; ESC support in the script. -->
    <div
      v-if="cellDetail"
      class="modal-bg"
      @click.self="closeCellModal"
      data-test="cell-detail-modal"
    >
      <div class="modal cell-detail-modal" @keydown.esc="closeCellModal">
        <header class="modal-header">
          <h3 class="modal-title" data-test="cell-detail-title">
            {{ cellDetail.srcSite }} → {{ cellDetail.dstSite }}
          </h3>
          <p class="modal-meta" data-test="cell-detail-meta">
            <span class="layer-tag-inline" v-if="cellDetail.layerTag">{{ cellDetail.layerTag }}</span>
            {{ cellDetail.pairs.length }} 条链路
          </p>
        </header>

        <div
          v-if="!cellDetail.pairs.length"
          class="empty"
          data-test="cell-detail-empty"
        >
          两站点之间暂无复制链路
        </div>

        <table v-else class="pair-table" data-test="cell-detail-table">
          <thead>
            <tr>
              <th>DC 链路</th>
              <th>当前状态</th>
              <th>最近成功</th>
              <th>最近尝试</th>
              <th>错误/详情</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(p, i) in cellDetail.pairs"
              :key="`${p.sourceDc}-${p.destDc}`"
              :class="['pair-row', `pair-row-${p.statusClass}`]"
              :data-test="`cell-detail-pair-${i}`"
            >
              <td class="pair-dcs">{{ p.sourceDc }} → {{ p.destDc }}</td>
              <td>
                <span class="status-pill" :class="`status-pill-${p.statusClass}`">
                  {{ p.statusLabel }}
                </span>
              </td>
              <td>{{ fmt(p.lastSuccessTime) }}</td>
              <td>{{ fmt(p.lastAttemptTime) }}</td>
              <td class="pair-error">{{ p.errorMessage || '—' }}</td>
            </tr>
          </tbody>
        </table>

        <footer class="modal-footer">
          <button class="btn-close" @click="closeCellModal" data-test="cell-detail-close">
            关闭
          </button>
        </footer>
      </div>
    </div>
  </AppLayout>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import AppLayout from '../../components/AppLayout.vue';
import { dashboardApi } from '../../api/dashboard.js';

const primaries = ref([]);
const refreshSeconds = ref(10);
const lastLoadedAt = ref(null);
const error = ref('');
const polling = ref(false);

// ── R71: cell-detail modal state ────────────────────────────────────────
// `clickedCell` is the (srcSite, dstSite) tuple of the currently open modal,
// or null when closed. We avoid putting the partner list directly into the
// ref because that data lives in cellMap (a computed) and re-deriving it
// every render is cheaper than caching — small payload.
const clickedCell = ref(null);

let timerHandle = null;

// ── Site list (preserves backend order). Includes isHub so the Hub/Spoke
//    partition (R68) can split sites into the two layered panels below. ──
const sites = computed(() => primaries.value.map(p => ({
  siteName: p.siteName,
  dcCount: (p.dcs || []).length,
  isHub: !!p.isHub
})));

// ── Hub / Spoke partition (R68 Hub-Spoke layered matrix). ─────────────
// Backend already tags each primary with isHub (= ad_sites.is_hub, sourced
// from the SQL JOIN at /api/dashboard/site-replication-matrix/all).
// Order is preserved (backend's allSitesOrdered helper) so Hubs lead the
// panel 1 mesh; Spokes trail behind in panel 2.
const hubSites   = computed(() => sites.value.filter(s => s.isHub));
const spokeSites = computed(() => sites.value.filter(s => !s.isHub));

// Set lookup so isHubPair is O(1) per call (cell renderers call it many
// times per matrix). Recomputes only when hubSites changes.
const hubSiteSet = computed(() => new Set(hubSites.value.map(s => s.siteName)));

// Both endpoints are Hub? Used to apply the load-bearing visual emphasis
// (gold-tinted background + thicker border) to Hub↔Hub cells.
function isHubPair(siteA, siteB) {
  const set = hubSiteSet.value;
  return set.has(siteA) && set.has(siteB);
}

// ── Build (sourceSite|destSite) → partner[] from the loaded payload. ──
// Single pass over the payload; cells look up their partner list from
// this map. Empty partner list = no link between the two sites.
const cellMap = computed(() => {
  const map = new Map();
  for (const p of primaries.value) {
    for (const dc of (p.dcPartners || [])) {
      for (const partner of dc.partners) {
        const key = `${p.siteName}|${partner.peerSite}`;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({
          sourceDc: dc.dcName,
          destDc: partner.peerDc,
          statusCode: partner.statusCode,
          lastSuccessTime: partner.lastSuccessTime,
          lastAttemptTime: partner.lastAttemptTime,
          errorMessage: partner.errorMessage
        });
      }
    }
  }
  return map;
});

function key(srcSite, dstSite) { return `${srcSite}|${dstSite}`; }
function partners(srcSite, dstSite) {
  return cellMap.value.get(key(srcSite, dstSite)) || [];
}

// Worst status across all partner links for a cell. statusCode
// semantics: 0 = success (green), 1 = partial failure (yellow),
// 2+ = failure (red). Empty list = "no link between sites" (gray).
function worstStatus(parts) {
  if (!parts.length) return 'none';
  let worst = 'ok';
  for (const p of parts) {
    if (p.statusCode === 0) continue;
    if (p.statusCode === 1) { if (worst === 'ok') worst = 'warn'; }
    else { worst = 'err'; break; }
  }
  return worst;
}

function cellState(srcSite, dstSite) {
  if (srcSite === dstSite) return 'self';
  return worstStatus(partners(srcSite, dstSite));
}

// Cell content: glyph + "ok/total" ratio. Diagonal = "-" (self).
function cellGlyph(srcSite, dstSite) {
  if (srcSite === dstSite) return '·';
  const s = cellState(srcSite, dstSite);
  if (s === 'ok')   return '✓';
  if (s === 'warn') return '!';
  if (s === 'err')  return '✕';
  return '·';
}
function cellText(srcSite, dstSite) {
  if (srcSite === dstSite) return '—';
  const parts = partners(srcSite, dstSite);
  if (!parts.length) return '—';
  const ok = parts.filter(p => p.statusCode === 0).length;
  return `${ok}/${parts.length}`;
}

// Tooltip on hover: list of partner links with status + last success.
// Bounded to a reasonable length to keep the tooltip readable.
function cellTooltip(srcSite, dstSite) {
  if (srcSite === dstSite) return `${srcSite} (本站内)`;
  const parts = partners(srcSite, dstSite);
  if (!parts.length) return `${srcSite} → ${dstSite}\n无复制链路`;
  const lines = [`${srcSite} → ${dstSite}  · ${parts.length} 条链路`];
  for (const p of parts) {
    const state = p.statusCode === 0 ? '✓'
                : p.statusCode === 1 ? '!'
                : '✕';
    const err = p.errorMessage ? ` — ${p.errorMessage}` : '';
    const last = p.lastSuccessTime
      ? ` · 最近成功 ${fmt(p.lastSuccessTime)}`
      : ' · 暂无成功记录';
    lines.push(`${state} ${p.sourceDc} → ${p.destDc}${last}${err}`);
  }
  return lines.join('\n');
}

// Fleet-level totals for the legend strip + summary line. Cheap
// one-pass over the payload; recomputes whenever primaries change.
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

// ── R71: cell-detail modal (click cell → list of DC pairs). ────────────
// Derives a modal payload from clickedCell + cellMap + Hub/Spoke partition.
// `layerTag` enriches the meta line with the architectural layer (Hub↔Hub
// / Spoke→Hub / Full matrix) when both endpoints share the same layer —
// for the Full matrix panel we skip the tag (the cell is just one of N²
// pairs and the layer doesn't carry extra meaning).
const cellDetail = computed(() => {
  if (!clickedCell.value) return null;
  const { srcSite, dstSite } = clickedCell.value;
  const parts = partners(srcSite, dstSite);
  const isHubPairCell = isHubPair(srcSite, dstSite);
  // Layer tag: only meaningful for Hub↔Hub or Spoke→Hub cells. We can't
  // tell from cellMap alone which panel the user clicked — but we infer
  // the layer from Hub/Spoke membership, which is what the panels use.
  let layerTag = '';
  if (isHubPairCell && srcSite !== dstSite) layerTag = '核心层 Hub↔Hub';
  else if (hubSiteSet.value.has(dstSite) && !hubSiteSet.value.has(srcSite)) {
    layerTag = '接入层 Spoke→Hub';
  } else if (hubSiteSet.value.has(srcSite) && !hubSiteSet.value.has(dstSite)) {
    // R68 notes: cellMap is keyed inbound-only by `(primary site → peer site)`,
    // so Spoke→Hub direction is the only Spoke layer we surface. The reverse
    // (Hub→Spoke) is the "designed absence" (Panel 3 only).
    layerTag = '完整视图 Hub→Spoke (出战)';
  }
  return {
    srcSite,
    dstSite,
    layerTag,
    pairs: parts.map(p => ({
      sourceDc: p.sourceDc,
      destDc: p.destDc,
      statusCode: p.statusCode,
      statusClass: p.statusCode === 0 ? 'ok' : (p.statusCode === 1 ? 'warn' : 'err'),
      statusLabel: p.statusCode === 0 ? '复制成功'
                 : (p.statusCode === 1 ? '部分失败' : '断开失败'),
      lastSuccessTime: p.lastSuccessTime,
      lastAttemptTime: p.lastAttemptTime,
      errorMessage: p.errorMessage
    }))
  };
});

// Self cells (srcSite === dstSite) are NOT clickable — there's nothing to
// drill into. Returns 'cell-disabled' for the cursor + pointer-events hint;
// the @click handler also early-returns so the click is a no-op regardless.
function cellClickableClass(srcSite, dstSite) {
  if (srcSite === dstSite) return 'cell-disabled';
  return 'cell-clickable';
}

function handleCellClick(srcSite, dstSite) {
  if (srcSite === dstSite) return;
  clickedCell.value = { srcSite, dstSite };
}

function closeCellModal() {
  clickedCell.value = null;
}

// Reset the modal when the underlying payload refreshes — keeps the modal
// consistent with the data the user is looking at. Without this the modal
// would show stale rows after a poll cycle, which is a classic dashboard
// bug. (R69/R70 modals don't have this risk because they read live data
// only on click.)
watch(primaries, () => { clickedCell.value = null; });

async function load() {
  polling.value = true;
  error.value = '';
  try {
    const r = await dashboardApi.getSiteReplicationMatrixAll();
    primaries.value = Array.isArray(r.data?.primaries) ? r.data.primaries : [];
    refreshSeconds.value = Number(r.data?.siteRefreshSeconds) || 10;
    lastLoadedAt.value = new Date().toISOString();
  } catch (e) {
    error.value = e?.response?.data?.error || '加载失败';
  } finally {
    polling.value = false;
  }
}

function fmt(s) {
  if (!s) return '—';
  // zh-CN short form keeps the legend + tooltip compact.
  return new Date(s).toLocaleString('zh-CN', {
    hour12: false, month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
}

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
  gap: 16px; margin-bottom: 14px;
}
.page-titles { display: flex; flex-direction: column; gap: 2px; }
.page-title {
  margin: 0; font-size: 18px; font-weight: 600; color: var(--text);
  letter-spacing: -0.005em;
}
.subtitle { margin: 0; font-size: 12px; color: var(--muted); }
.page-meta {
  display: flex; align-items: center; gap: 8px;
  font-size: 11px; color: var(--muted);
  font-family: ui-monospace, "SF Mono", monospace;
}
.dot { width: 6px; height: 6px; border-radius: 50%; }
.dot.on  { background: var(--green); }
.dot.off { background: var(--muted); }

/* ===== Legend strip ==================================================== */
.legend {
  display: flex; align-items: center; flex-wrap: wrap;
  gap: 18px; padding: 10px 14px;
  margin-bottom: 14px;
  background: var(--panel-alt);
  border: 1px solid var(--border); border-radius: 4px;
  font-size: 12px; color: var(--text);
}
.legend-item { display: inline-flex; align-items: center; gap: 6px; }
.legend-item strong {
  font-feature-settings: "tnum"; font-weight: 600;
  color: var(--text); margin-left: 2px;
}
.legend-item.muted { color: var(--muted); }
.legend-divider {
  width: 1px; height: 14px; background: var(--border);
}
.swatch {
  display: inline-block;
  width: 12px; height: 12px; border-radius: 2px;
}
.swatch-ok   { background: var(--green); }
.swatch-warn { background: var(--yellow); }
.swatch-err  { background: var(--red); }

/* ===== Error / empty =================================================== */
.error-banner {
  background: rgba(239, 68, 68, 0.12); color: var(--red);
  padding: 8px 12px; border-radius: 4px; margin-bottom: 12px;
  border: 1px solid rgba(239, 68, 68, 0.3); font-size: 12px;
}
.empty {
  text-align: center; color: var(--muted);
  padding: 32px; font-size: 13px;
  background: var(--panel-alt); border: 1px solid var(--border);
  border-radius: 4px;
}

/* ===== Matrix ==========================================================
   The table is laid out as N+1 columns and N+1 rows. First row + first
   column are sticky so navigating big matrices is easy. Cell min-width
   keeps the matrix readable when site names are long; horizontal
   scroll engages when total width exceeds viewport. */
.matrix-wrap {
  overflow: auto;
  max-width: 100%;
  background: var(--panel);
  border: 1px solid var(--border); border-radius: 4px;
}
.matrix {
  border-collapse: separate; border-spacing: 4px;
  margin: 0;
  font-size: 12px;
}
.matrix th, .matrix td {
  padding: 0;
  text-align: center; vertical-align: middle;
}
.col-head, .row-head {
  position: sticky; z-index: 2;
  background: var(--panel-alt);
  font-weight: 500; color: var(--text);
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 3px;
  white-space: nowrap;
  font-size: 12px;
}
.col-head {
  top: 0;
  min-width: 90px;
}
.row-head {
  left: 0;
  min-width: 140px;
  text-align: left;
}
.row-head-corner {
  position: sticky; top: 0; left: 0; z-index: 3;
  background: var(--panel);
  min-width: 140px; height: 100%;
}
.col-name, .row-name {
  font-weight: 600;
  color: var(--text);
  font-size: 12px;
  letter-spacing: -0.005em;
  white-space: nowrap;
}
.col-meta, .row-meta {
  font-size: 10px;
  color: var(--muted);
  margin-top: 1px;
  font-family: ui-monospace, monospace;
  font-feature-settings: "tnum";
}
.row-meta-num { color: var(--text); font-weight: 600; }

/* ── Cell base ──────────────────────────────────────────────────────── */
.cell {
  min-width: 80px; height: 44px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 3px;
  cursor: default;
  font-family: ui-monospace, "SF Mono", monospace;
  font-feature-settings: "tnum";
  transition: transform 0.08s ease;
}
.cell:hover { transform: scale(1.04); }
.cell-glyph {
  display: inline-block; min-width: 12px;
  font-weight: 700; margin-right: 4px;
}
.cell-num { font-size: 11px; }

/* ── Cell states — operator directive: green/yellow/red/gray only. ─── */
.cell-ok {
  background: rgba(34, 197, 94, 0.22);
  border-color: rgba(34, 197, 94, 0.5);
  color: #15803d;
}
.cell-ok .cell-glyph { color: #15803d; }

.cell-warn {
  background: rgba(234, 179, 8, 0.28);
  border-color: rgba(234, 179, 8, 0.6);
  color: #a16207;
}
.cell-warn .cell-glyph { color: #a16207; }

.cell-err {
  background: rgba(239, 68, 68, 0.28);
  border-color: rgba(239, 68, 68, 0.6);
  color: #b91c1c;
}
.cell-err .cell-glyph { color: #b91c1c; }

.cell-none {
  background: var(--panel-alt);
  border-color: var(--border);
  color: var(--muted);
}
.cell-none .cell-glyph { color: var(--muted); }

.cell-self {
  background: var(--panel-alt);
  border: 1px dashed var(--border);
  color: var(--muted);
}

/* ===== R68: Hub-Spoke layered panels + Hub visual emphasis ===========
   The page is now organised as 3 stacked sections (Panel 1 Hub mesh,
   Panel 2 Spoke attachment, Panel 3 Full matrix). Each panel gets its
   own header strip with a coloured tag so the operator can see at a
   glance which layer they're reading. Hub↔Hub cells get a gold-tinted
   background + thicker border so the load-bearing layer stands out. */
.layer-panel {
  margin-bottom: 18px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 14px 16px 16px;
}
.layer-panel:last-child { margin-bottom: 0; }
.layer-header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.layer-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.layer-sub {
  margin: 0 0 10px;
  font-size: 11px;
  color: var(--muted);
}
.layer-tag {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 2px 8px;
  border-radius: 999px;
  color: var(--muted);
  background: var(--panel-alt);
  border: 1px solid var(--border);
  text-transform: uppercase;
}
.hub-tag {
  color: #b45309;
  background: rgba(251, 191, 36, 0.16);
  border-color: rgba(251, 191, 36, 0.5);
}
.spoke-tag {
  color: var(--muted);
  background: rgba(148, 163, 184, 0.12);
  border-color: rgba(148, 163, 184, 0.4);
}
.hub-tag-mini,
.spoke-tag-mini {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 3px;
  margin: 0 2px;
}
.hub-tag-mini {
  color: #b45309;
  background: rgba(251, 191, 36, 0.16);
}
.spoke-tag-mini {
  color: #94a3b8;
  background: rgba(148, 163, 184, 0.16);
}

/* ── Hub column / row header tinting ─────────────────────────────────── */
.hub-col-head {
  background: rgba(251, 191, 36, 0.10);
  border-color: rgba(251, 191, 36, 0.5);
  color: #fde68a;
}
.hub-row-head {
  background: rgba(251, 191, 36, 0.10);
  border-color: rgba(251, 191, 36, 0.5);
  color: #fde68a;
}
.spoke-row-head {
  color: var(--muted);
}

/* ── Cell layer modifiers ─────────────────────────────────────────────
   .cell-hub-pair applies to Hub↔Hub cells (load-bearing layer):
   thicker border + slightly tinted background so the operator's eye
   lands on them first. State colours (ok/warn/err) win over the base. */
.cell-hub-pair {
  border-width: 2px;
  font-weight: 600;
}
.cell-hub-pair.cell-ok {
  background: rgba(251, 191, 36, 0.20);
  border-color: rgba(251, 191, 36, 0.7);
  color: #92400e;
}
.cell-hub-pair.cell-ok .cell-glyph { color: #92400e; }
.cell-hub-pair.cell-warn {
  background: rgba(251, 191, 36, 0.18);
  border-color: rgba(234, 179, 8, 0.7);
}
.cell-hub-pair.cell-err {
  background: rgba(251, 146, 60, 0.20);
  border-color: rgba(239, 68, 68, 0.7);
}

/* Spoke↔Hub cells: normal weight, but slightly smaller to keep the
   panel from dominating when there are many Spokes (40-DC / 20-site
   environments can hit 15 spokes × 5 hubs = 75 cells). */
.cell-hub-spoke {
  min-width: 70px;
}

/* ===== R71: cell-click affordance + cell-detail modal =================
   The cell-detail modal is the third member of the drillability family
   (R69 node-detail, R70 edge-detail, R71 cell-detail). It reuses the
   shared modal vocabulary (.modal-bg / .modal / backdrop-click) and
   introduces a per-pair table that lists every (sourceDc → destDc) link
   in the clicked site-pair, with status pill + last success + error. */
.cell-clickable { cursor: pointer; }
.cell-disabled  { cursor: default; }

.modal-bg {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(15, 23, 42, 0.45);
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}
.modal {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.30);
  max-width: 720px; width: 100%;
  max-height: 80vh;
  display: flex; flex-direction: column;
  overflow: hidden;
}
.modal-header {
  padding: 14px 18px 10px;
  border-bottom: 1px solid var(--border);
}
.modal-title {
  margin: 0; font-size: 15px; font-weight: 600; color: var(--text);
}
.modal-meta {
  margin: 4px 0 0; font-size: 11px; color: var(--muted);
  display: flex; align-items: center; gap: 8px;
}
.layer-tag-inline {
  display: inline-block; font-size: 10px; font-weight: 600;
  letter-spacing: 0.04em; padding: 1px 6px; border-radius: 3px;
  color: #b45309;
  background: rgba(251, 191, 36, 0.16);
  border: 1px solid rgba(251, 191, 36, 0.5);
}
.modal-footer {
  padding: 10px 18px;
  border-top: 1px solid var(--border);
  display: flex; justify-content: flex-end;
  background: var(--panel-alt);
}
.btn-close {
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px 14px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.1s ease;
}
.btn-close:hover { background: var(--panel-alt); }

.cell-detail-modal .pair-table {
  width: 100%;
  border-collapse: separate; border-spacing: 0;
  font-size: 12px;
  overflow: auto;
}
.cell-detail-modal .pair-table thead th {
  position: sticky; top: 0; z-index: 1;
  background: var(--panel-alt);
  text-align: left;
  font-weight: 500;
  color: var(--muted);
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.cell-detail-modal .pair-table tbody td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  vertical-align: middle;
}
.cell-detail-modal .pair-table tbody tr:last-child td {
  border-bottom: 0;
}
.cell-detail-modal .pair-dcs {
  font-family: ui-monospace, "SF Mono", monospace;
  font-feature-settings: "tnum";
  font-weight: 500;
}
.cell-detail-modal .pair-error {
  color: var(--muted);
  max-width: 240px;
  word-break: break-word;
}

/* Per-row status tint (very subtle — the status-pill carries the heavy
   color so the table body stays readable). */
.cell-detail-modal .pair-row-ok   { background: rgba(34, 197, 94, 0.04); }
.cell-detail-modal .pair-row-warn { background: rgba(234, 179, 8, 0.06); }
.cell-detail-modal .pair-row-err  { background: rgba(239, 68, 68, 0.06); }

/* Status pill — same vocabulary as cell states (green/yellow/red). */
.status-pill {
  display: inline-block;
  font-size: 11px; font-weight: 600;
  padding: 2px 8px; border-radius: 999px;
  letter-spacing: 0.02em;
}
.status-pill-ok {
  color: #15803d;
  background: rgba(34, 197, 94, 0.18);
  border: 1px solid rgba(34, 197, 94, 0.4);
}
.status-pill-warn {
  color: #a16207;
  background: rgba(234, 179, 8, 0.22);
  border: 1px solid rgba(234, 179, 8, 0.5);
}
.status-pill-err {
  color: #b91c1c;
  background: rgba(239, 68, 68, 0.20);
  border: 1px solid rgba(239, 68, 68, 0.5);
}
</style>