<!--
  复制拓扑 — 单图表视图
  2026-08-29 round-62 (operator directive "复制拓扑去掉两个图表 集合成一个图标"):
  collapse the dual-panel layout (R59 outbound + inbound, R61 horizontal
  side-by-side) into a SINGLE ECharts graph. Direction is preserved by
  the arrow at each edge's target end — no need to split into two
  panels to disambiguate source vs target.

  2026-08-29 round-63 (operator "服务器和站点的关系可以这样绘制"):
  draw site bounding boxes around each site's DCs using ECharts
  `graphic` component. After force layout settles (chart.on('finished')),
  compute pixel bbox per site via convertToPixel() and render a rounded
  rect (dashed border, site palette color, transparent fill) plus a
  bold site-name header. This makes the "site → DC" containment
  hierarchy visually explicit without needing a second chart.

  2026-08-30 round-69 (operator: "你来定" → picked node-click drill-down):
  Click a site or DC node → opens a local modal with the node's detail
  (site: Hub/Spoke badge + DC list + partner counts; DC: role badges
  + intra/cross-site replication partners). No new backend endpoint —
  derives everything from props.data. Click backdrop or close button
  → dismissed. data-test contract:
    node-detail-modal      — modal root (both node types)
    node-detail-title      — header title (site name or DC name)
    node-detail-meta       — Hub/Spoke + DC count line (site nodes only)
    node-detail-dc-list    — DC list container (site nodes only)
    node-detail-dc-row     — single DC row in the site list
    node-detail-partners   — partner list container
    node-detail-partner    — single partner row
    node-detail-close      — close button (modal footer)

  History:
    - R43 — add direction (was mutual connections → fixed to hub-spoke)
    - R59 — split into 出战 + 入站 two ECharts panels with lens-aware labels
    - R61 — change panels from vertical to horizontal + 3-color edges
    - R62 — collapse back to ONE chart; arrow direction is enough
    - R63 — wrap each site's DCs in a colored site bounding box
    - R68 — Hub-Spoke visual emphasis: Hub sites rendered bigger/golder
      with bold border; Spoke sites smaller/fainter; Hub↔Hub edges
      rendered bolder (the load-bearing layer); Spoke→Spoke edges
      hidden by default (designed absence — Hub-Spoke compliance).
    - R69 — click any node (site OR DC) to drill into a detail modal
      (Hub/Spoke badge, DC list with role badges, partner breakdown).

  Layout choices (single canvas):
    - Sites get per-site category index → ECharts force layout clusters
      each site's DCs around its site node. Sites are heavy anchors
      (mass: 8); DCs are light (mass: 1) and settle around their parent.
    - Edge `symbol: ['none', 'arrow']` puts an arrow at target — direction
      is unambiguous.
    - Edge color = green (statusCode 0) / yellow (statusCode 1) / red
      (statusCode 2+). Matches R60 复制状态概览 + R61 vocabulary.
    - Edge label = "SourceSite→DestSite" for cross-site links,
      "↔ 内" for intra-site links.

  Hub-Spoke (R68):
    - Hub site node: symbolSize 52, gold (#fbbf24) roundRect, mass 12,
      bold border on bounding box. The "load-bearing" layer of the topology.
    - Spoke site node: symbolSize 32, faded (#94a3b8) roundRect, mass 6,
      thinner border on bounding box.
    - Hub↔Hub edges: lineStyle.width 2.5 (visually heavier).
    - Spoke→Hub / Hub→Spoke edges: lineStyle.width 1.0 (thinner).
    - Spoke↔Spoke edges: hidden (filtered out before rendering — these
      are designed absences per Hub-Spoke compliance).
    - Visual is driven by `n.isHub` on each site node (sourced from
      ad_sites.is_hub in the backend, exposed via /api/dashboard/topology).
-->
<template>
  <!-- 3-color legend (green/yellow/red) so the operator can map edge
       color → health state at a glance. -->
  <div class="color-legend" data-test="color-legend">
    <span class="color-legend-item"><span class="color-swatch swatch-ok"></span>正常 (statusCode 0)</span>
    <span class="color-legend-item"><span class="color-swatch swatch-warn"></span>部分失败 (statusCode 1)</span>
    <span class="color-legend-item"><span class="color-swatch swatch-err"></span>断开/失败 (statusCode 2+)</span>
  </div>
  <div class="topology-single">
    <section class="structure" data-test="topology-structure">
      <header class="structure-header">
        <span class="structure-tag">复制拓扑</span>
        <h3>所有站点的复制链路</h3>
        <span class="structure-sub">站点框 → DC 节点 → 复制链路（虚线框 = 站点，箭头 = 复制方向，点击节点查看详情）</span>
      </header>
      <div ref="chartEl" class="chart" data-test="topology-chart"></div>
    </section>
  </div>

  <!-- R69: node-click drill-down modal. Rendered via v-if so it stays
       out of the DOM until the operator actually clicks a node. Closes
       on backdrop click (handled via .self modifier) and on the footer
       button. -->
  <div v-if="clickedNode" class="modal-bg" @click.self="closeModal" data-test="node-detail-modal">
    <div class="modal node-detail-modal">
      <header>
        <h3 data-test="node-detail-title">{{ nodeDetail.title }}</h3>
        <p v-if="nodeDetail.meta" class="meta" data-test="node-detail-meta">{{ nodeDetail.meta }}</p>
      </header>
      <section class="form-body">
        <div v-if="nodeDetail.dcList.length" class="detail-section">
          <span class="label">DC 列表 ({{ nodeDetail.dcList.length }})</span>
          <ul class="dc-list" data-test="node-detail-dc-list">
            <li
              v-for="dc in nodeDetail.dcList"
              :key="dc.name"
              class="dc-row"
              data-test="node-detail-dc-row"
            >
              <span class="dc-name">{{ dc.name }}</span>
              <span class="dc-roles">
                <span v-if="dc.isBridgehead" class="role-badge role-bridge">桥头</span>
                <span v-if="dc.isPdc" class="role-badge role-pdc">主控</span>
                <span v-else-if="dc.isGc" class="role-badge role-gc">GC</span>
                <span v-if="dc.isRid" class="role-badge role-rid">RID</span>
                <span v-if="dc.isInfra" class="role-badge role-infra">基础结构</span>
                <span v-if="dc.isNaming" class="role-badge role-naming">命名</span>
                <span v-if="!anyRole(dc)" class="role-badge role-member">成员</span>
              </span>
              <span class="dc-partner-count">{{ dc.partnerCount }} 复制伙伴</span>
            </li>
          </ul>
        </div>

        <div v-if="nodeDetail.partners.length" class="detail-section">
          <span class="label">复制伙伴 ({{ nodeDetail.partners.length }})</span>
          <ul class="partner-list" data-test="node-detail-partners">
            <li
              v-for="p in nodeDetail.partners"
              :key="`${p.peerDc}|${p.direction}`"
              class="partner-row"
              :class="`partner-row-${p.status}`"
              data-test="node-detail-partner"
            >
              <span class="partner-dir">
                <span v-if="p.direction === 'intra'" class="dir-tag dir-intra">站内</span>
                <span v-else-if="p.direction === 'out'" class="dir-tag dir-out">出战</span>
                <span v-else class="dir-tag dir-in">入站</span>
              </span>
              <span class="partner-peer">{{ p.peerDc }}</span>
              <span class="partner-peer-site">{{ p.peerSite }}</span>
              <span class="partner-status" :class="`status-${p.status}`">
                {{ p.statusLabel }}
              </span>
            </li>
          </ul>
        </div>

        <p v-if="!nodeDetail.dcList.length && !nodeDetail.partners.length" class="empty">
          没有可显示的详情。
        </p>
      </section>
      <footer>
        <button type="button" data-test="node-detail-close" @click="closeModal">关闭</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch, nextTick, computed } from 'vue';
import * as echarts from 'echarts';

const props = defineProps({
  data: { type: Object, default: () => ({ nodes: [], links: [] }) }
});

const chartEl = ref(null);
let chart = null;
// R63: keep references to nodes passed to setOption so convertToPixel()
// can resolve each DC back to its pixel position from ECharts'
// internal data store.
let lastBuiltDataNodes = [];
// R63: guard against the 'finished' → setOption(graphic) → 'finished'
// feedback loop. Only re-render boxes when the underlying data changed.
let lastBoxDataKey = '';
// R69: clicked node detail (drives the modal). null = closed.
// Stores the ORIGINAL node from props.data (not the ECharts-wrapped
// object) so role badges + partner counts derive from source-of-truth.
const clickedNode = ref(null);

// ── Site order + DC → site lookup (shared across renders) ──────────────
const siteOrder = computed(() => {
  const seen = new Set();
  const out = [];
  for (const n of (props.data.nodes || [])) {
    if (n.type === 'site' && !seen.has(n.name)) {
      seen.add(n.name);
      out.push(n.name);
    }
  }
  return out;
});

function dcSiteLookup() {
  const map = new Map();
  for (const n of (props.data.nodes || [])) {
    if (n.type === 'dc') map.set(n.name, n.site || null);
  }
  return map;
}

// Compact site-name abbrev for edge labels. The legend already maps
// each site to its own color, so 1-2 chars is enough on the canvas.
function shortSite(name) {
  if (!name) return '?';
  if (name === '核心站点') return 'HUB';
  if (name.endsWith('站点')) return name.slice(0, 2);
  return name.slice(0, 3);
}

// 8 distinct site palette colors so the operator can map
// "same-color circle cluster = same site" at a glance.
const SITE_PALETTE = [
  '#38bdf8', '#a78bfa', '#fb923c', '#34d399',
  '#f472b6', '#facc15', '#60a5fa', '#fb7185'
];

// R63: hex → rgba helper for site-box transparent fills.
function hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return `rgba(0,0,0,${alpha})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
}

function buildOption() {
  const siteIndex = new Map(siteOrder.value.map((s, i) => [s, i]));
  const dcSites = dcSiteLookup();

  // R68: Hub set (sites flagged isHub=true). Drives node sizing, color,
  // and edge-weight emphasis. Built once per render.
  const hubSet = new Set();
  for (const n of (props.data.nodes || [])) {
    if (n.type === 'site' && n.isHub) hubSet.add(n.name);
  }

  const nodes = (props.data.nodes || []).map(n => {
    const isSite = n.type === 'site';
    const isHub = isSite && hubSet.has(n.name);
    return {
      name: n.name,
      // R63: remember site membership so renderSiteBoxes can group DCs
      // into per-site bounding boxes after force layout settles.
      _siteName: isSite ? n.name : (n.site || null),
      _isHub: isHub,
      category: isSite ? (siteIndex.get(n.name) ?? 0) : (siteIndex.get(n.site) ?? 0),
      // R68: Hub sites are bigger/heavier; Spoke sites are smaller.
      symbolSize: isHub ? 52 : isSite ? 32 : 16,
      mass: isHub ? 12 : isSite ? 6 : 1,
      symbol: isSite ? 'roundRect' : 'circle',
      itemStyle: {
        // R68: Hub = gold (load-bearing layer); Spoke = faded.
        color: isHub ? '#fbbf24' : isSite ? '#94a3b8' : '#94a3b8',
        borderColor: isHub ? '#fde68a' : (isSite ? '#64748b' : 'transparent'),
        borderWidth: isHub ? 2 : (isSite ? 1 : 0)
      },
      label: {
        show: true,
        color: isHub ? '#fef3c7' : isSite ? '#e2e8f0' : '#cbd5e1',
        fontWeight: isHub ? 700 : isSite ? 500 : 400,
        fontSize: isHub ? 14 : isSite ? 12 : 11
      }
    };
  });

  // R63: keep references to the node objects passed to setOption so
  // renderSiteBoxes can pass them to convertToPixel() to read pixel
  // positions back from ECharts' internal layout.
  lastBuiltDataNodes = nodes;

  const links = (props.data.links || []).map(l => {
    const sourceSite = dcSites.get(l.source);
    const destSite = dcSites.get(l.target);
    const isIntra = sourceSite && destSite && sourceSite === destSite;
    // R68: classify the edge into one of the three Hub-Spoke layers:
    //   hub-hub        — load-bearing, BOLDEST edge (width 2.5)
    //   hub-spoke      — normal cross-tier (width 1.0)
    //   spoke-spoke    — designed absence — HIDDEN (filtered below)
    const sourceIsHub = sourceSite && hubSet.has(sourceSite);
    const destIsHub = destSite && hubSet.has(destSite);
    let layer;
    if (sourceIsHub && destIsHub) layer = 'hub-hub';
    else if (sourceIsHub || destIsHub) layer = 'hub-spoke';
    else layer = 'spoke-spoke';
    // Filter out spoke-spoke edges (designed absence in Hub-Spoke model).
    // The dashboard `primaries` payload would not normally emit these,
    // but defensive filtering keeps the topology honest if KCC ever
    // produces a transitive spoke-spoke link.
    if (layer === 'spoke-spoke' && !isIntra) {
      return null;
    }
    // Single unified label: cross-site uses source→dest convention
    // (matches the arrow direction). Intra-site keeps the ↔ marker.
    let labelText;
    if (isIntra) {
      labelText = '↔ 内';
    } else {
      const ss = shortSite(sourceSite);
      const ds = shortSite(destSite);
      labelText = `${ss}→${ds}`;
    }
    // 3-color health vocabulary (matches R60 matrix + R61 topology).
    const edgeColor =
      l.statusCode === 0 ? '#22c55e' :
      l.statusCode === 1 ? '#eab308' :
      '#ef4444';
    const edgeTextColor =
      l.statusCode === 0 ? '#86efac' :
      l.statusCode === 1 ? '#fde68a' :
      '#fca5a5';
    // R68: edge width by layer — hub-hub is the load-bearing layer.
    const edgeWidth = isIntra ? 1.5 : (layer === 'hub-hub' ? 2.5 : 1.0);
    return {
      source: l.source,
      target: l.target,
      symbol: ['none', 'arrow'],
      symbolSize: 8,
      lineStyle: {
        color: edgeColor,
        width: edgeWidth,
        curveness: 0.08,
        type: 'solid',
        opacity: 0.85
      },
      edgeLabel: {
        show: true,
        formatter: () => labelText,
        color: edgeTextColor,
        fontSize: 9,
        backgroundColor: 'rgba(15, 23, 42, 0.7)',
        padding: [2, 4]
      }
    };
  }).filter(Boolean);

  const categories = siteOrder.value.map((name, i) => ({
    name: `${name}`,
    itemStyle: { color: SITE_PALETTE[i % SITE_PALETTE.length] }
  }));

  return {
    tooltip: {
      formatter: (p) => {
        if (p.dataType === 'edge') {
          const l = p.data;
          const sourceSite = dcSites.get(l.source);
          const destSite = dcSites.get(l.target);
          const isIntra = sourceSite && destSite && sourceSite === destSite;
          const dir = isIntra
            ? 'intra-site (内)'
            : `${sourceSite || '?'} → ${destSite || '?'}`;
          const c = l.lineStyle && l.lineStyle.color;
          const status =
            c === '#22c55e' ? '✓ 复制成功' :
            c === '#eab308' ? '! 部分失败' :
            '✕ 失败/断开';
          return `<b>${l.source} → ${l.target}</b><br/>方向: ${dir}<br/>状态: ${status}`;
        }
        if (p.dataType === 'node') {
          const site = dcSites.get(p.name);
          return site ? `${p.name}<br/>站点: ${site}` : p.name;
        }
        return '';
      }
    },
    legend: [{
      data: categories.map(c => c.name),
      textStyle: { color: '#cbd5e1' },
      top: 8
    }],
    series: [{
      type: 'graph',
      layout: 'force',
      roam: true,
      draggable: true,
      categories,
      force: {
        repulsion: 320,
        edgeLength: [60, 120],
        gravity: 0.05
      },
      data: nodes,
      links,
      lineStyle: { color: '#475569', curveness: 0.08 }
    }]
  };
}

function render() {
  if (!chart || !chartEl.value) return;
  chart.setOption(buildOption());
}

// R69: node-detail modal payload. Built from props.data + clickedNode.
//   - Site click  → title + Hub/Spoke badge + DC list (with role badges
//                   + per-DC partner count) + flat partner list
//                   (intra-site + cross-site, deduped per (peer, direction)).
//   - DC click    → title + role badges + partner list scoped to this DC.
// Both share the partners list structure so the template can be flat.
const nodeDetail = computed(() => {
  if (!clickedNode.value) {
    return { title: '', meta: '', dcList: [], partners: [] };
  }
  const node = clickedNode.value;
  const nodes = props.data?.nodes || [];
  const links = props.data?.links || [];
  if (node.type === 'site') {
    // DCs in this site (preserve backend order via nodes iteration).
    const dcs = nodes.filter(n => n.type === 'dc' && n.site === node.name);
    // Site-level partner list (deduped per peerDc across all DCs in site).
    const partnerMap = new Map();
    for (const dc of dcs) {
      for (const link of links) {
        const peerDc = link.source === dc.name ? link.target
                     : link.target === dc.name ? link.source
                     : null;
        if (!peerDc) continue;
        const peerNode = nodes.find(n => n.name === peerDc);
        const peerSite = peerNode?.site || '?';
        const isIntra = peerSite === node.name;
        const direction = link.source === dc.name ? 'out' : 'in';
        const key = `${peerDc}|${direction}|${peerSite}`;
        if (!partnerMap.has(key)) {
          partnerMap.set(key, {
            peerDc,
            peerSite,
            direction: isIntra ? 'intra' : direction,
            status: linkStatusBucket(link.statusCode),
            statusLabel: linkStatusLabel(link.statusCode)
          });
        }
      }
    }
    // DC list with per-DC partner count.
    const dcList = dcs.map(dc => {
      const count = links.filter(l => l.source === dc.name || l.target === dc.name).length;
      return {
        name: dc.name,
        isBridgehead: !!dc.isBridgehead,
        isPdc: !!dc.isPdc,
        isGc: !!dc.isGc,
        isRid: !!dc.isRid,
        isInfra: !!dc.isInfra,
        isNaming: !!dc.isNaming,
        partnerCount: count
      };
    });
    // Partners list sorted: intra first, then out, then in, alphabetical within.
    const partners = [...partnerMap.values()].sort((a, b) => {
      const order = { intra: 0, out: 1, in: 2 };
      if (order[a.direction] !== order[b.direction]) {
        return order[a.direction] - order[b.direction];
      }
      return a.peerDc.localeCompare(b.peerDc);
    });
    return {
      title: node.name,
      meta: `${node.isHub ? '承载层 Hub' : '分支 Spoke'} · ${dcs.length} DC`,
      dcList,
      partners
    };
  }
  if (node.type === 'dc') {
    const partners = [];
    for (const link of links) {
      let peerDc = null;
      let direction = null;
      if (link.source === node.name) { peerDc = link.target; direction = 'out'; }
      else if (link.target === node.name) { peerDc = link.source; direction = 'in'; }
      if (!peerDc) continue;
      const peerNode = nodes.find(n => n.name === peerDc);
      const peerSite = peerNode?.site || '?';
      const isIntra = peerSite === node.site;
      partners.push({
        peerDc,
        peerSite,
        direction: isIntra ? 'intra' : direction,
        status: linkStatusBucket(link.statusCode),
        statusLabel: linkStatusLabel(link.statusCode)
      });
    }
    partners.sort((a, b) => {
      const order = { intra: 0, out: 1, in: 2 };
      if (order[a.direction] !== order[b.direction]) {
        return order[a.direction] - order[b.direction];
      }
      return a.peerDc.localeCompare(b.peerDc);
    });
    const roleBadges = [];
    if (node.isBridgehead) roleBadges.push('桥头');
    if (node.isPdc) roleBadges.push('主控');
    else if (node.isGc) roleBadges.push('GC');
    if (node.isRid) roleBadges.push('RID');
    if (node.isInfra) roleBadges.push('基础结构');
    if (node.isNaming) roleBadges.push('命名');
    if (roleBadges.length === 0) roleBadges.push('成员');
    return {
      title: node.name,
      meta: `${node.site || '?'} · ${roleBadges.join(' / ')}`,
      dcList: [],
      partners
    };
  }
  return { title: node.name || '', meta: '', dcList: [], partners: [] };
});

function linkStatusBucket(code) {
  if (code === 0) return 'ok';
  if (code === 1) return 'warn';
  return 'err';
}
function linkStatusLabel(code) {
  if (code === 0) return '复制成功';
  if (code === 1) return '部分失败';
  return '断开/失败';
}
function anyRole(dc) {
  return dc.isBridgehead || dc.isPdc || dc.isGc || dc.isRid || dc.isInfra || dc.isNaming;
}
function closeModal() { clickedNode.value = null; }
// R69: handle ECharts click. ECharts passes { dataType, data } where
//   dataType === 'node' → data = node object (with name, type, site, isHub, ...)
//   dataType === 'edge' → ignore for v1 (edge-click is a future feature).
function handleNodeClick(params) {
  if (!params || params.dataType !== 'node') return;
  const node = params.data;
  if (!node || (node.type !== 'site' && node.type !== 'dc')) return;
  // Resolve to the ORIGINAL props.data node (the ECharts-wrapped object
  // is mutated by buildOption; we want the source-of-truth for role badges).
  const original = (props.data?.nodes || []).find(n => n.name === node.name && n.type === node.type);
  clickedNode.value = original || node;
}

// R63: site bounding boxes. After the force layout settles (signaled by
// ECharts' 'finished' event), compute each site's DC bbox in pixel
// coordinates via convertToPixel(), then draw a rounded rect with the
// site's palette color (dashed border + transparent fill) plus a bold
// site-name header. The result is a visual container that makes the
// site → DC membership hierarchy obvious without needing a second chart.
//
// Implementation notes:
//   - Group DCs by `_siteName` (set in buildOption).
//   - Use convertToPixel({ seriesIndex: 0 }, dcItem) — ECharts finds
//     the data item by reference in its internal data store.
//   - `silent: true` so boxes don't intercept hover/click on DC nodes.
//   - `lastBoxDataKey` guard prevents feedback: setOption({graphic})
//     itself triggers 'finished', which would re-enter renderSiteBoxes.
//     We short-circuit if the data hasn't changed since last render.
function renderSiteBoxes() {
  if (!chart) return;
  const key = JSON.stringify(props.data.nodes || []);
  if (key === lastBoxDataKey) return;
  lastBoxDataKey = key;

  const dcNodes = lastBuiltDataNodes.filter(n => n.symbol === 'circle');
  if (dcNodes.length === 0) {
    chart.setOption({ graphic: [] });
    return;
  }

  const bySite = new Map();
  for (const dc of dcNodes) {
    if (!dc._siteName) continue;
    if (!bySite.has(dc._siteName)) bySite.set(dc._siteName, []);
    bySite.get(dc._siteName).push(dc);
  }
  if (bySite.size === 0) {
    chart.setOption({ graphic: [] });
    return;
  }

  const siteIdxMap = new Map(siteOrder.value.map((s, i) => [s, i]));
  const padding = 28;
  const headerHeight = 22;
  const elements = [];

  bySite.forEach((dcs, siteName) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let validCoords = false;
    for (const dc of dcs) {
      let px;
      try { px = chart.convertToPixel({ seriesIndex: 0 }, dc); }
      catch { continue; }
      if (!px || !Array.isArray(px) || px.length < 2) continue;
      if (!isFinite(px[0]) || !isFinite(px[1])) continue;
      minX = Math.min(minX, px[0]);
      maxX = Math.max(maxX, px[0]);
      minY = Math.min(minY, px[1]);
      maxY = Math.max(maxY, px[1]);
      validCoords = true;
    }
    if (!validCoords) return;

    const color = SITE_PALETTE[siteIdxMap.get(siteName) ?? 0] ?? '#38bdf8';
    const boxX = minX - padding;
    const boxY = minY - padding - headerHeight;
    const boxW = (maxX - minX) + padding * 2;
    const boxH = (maxY - minY) + padding * 2 + headerHeight;

    elements.push({
      type: 'group',
      z: -1,
      silent: true,
      children: [
        {
          type: 'rect',
          shape: { x: boxX, y: boxY, width: boxW, height: boxH, r: 8 },
          style: {
            fill: hexToRgba(color, 0.08),
            stroke: color,
            lineWidth: 1.5,
            lineDash: [6, 6]
          }
        },
        {
          type: 'text',
          style: {
            text: siteName,
            fill: color,
            font: 'bold 12px sans-serif',
            x: boxX + 8,
            y: boxY + 4
          }
        }
      ]
    });
  });

  chart.setOption({ graphic: elements });
}

onMounted(async () => {
  await nextTick();
  if (chartEl.value) {
    chart = echarts.init(chartEl.value);
    // R63: site bounding boxes re-render after force layout settles.
    chart.on('finished', renderSiteBoxes);
    // R69: node-click drill-down modal.
    chart.on('click', handleNodeClick);
    render();
  }
});

watch(() => props.data, () => { render(); }, { deep: true });

onUnmounted(() => { chart?.dispose(); });
</script>

<style scoped>
.topology-single { display: block; }
.structure {
  background: #0f172a;
  border: 1px solid #1e293b;
  border-radius: 8px;
  padding: 12px 16px 16px;
}
.structure-header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.structure-header h3 {
  margin: 0;
  color: #e2e8f0;
  font-size: 14px;
  font-weight: 600;
}
.structure-tag {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 2px 8px;
  border-radius: 999px;
  color: #e2e8f0;
  background: rgba(56, 189, 248, 0.16);
  border: 1px solid rgba(56, 189, 248, 0.4);
}
.structure-sub {
  color: #94a3b8;
  font-size: 12px;
}
.chart {
  width: 100%;
  height: 560px;
  border-radius: 6px;
}
.color-legend {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  font-size: 12px;
  color: #cbd5e1;
}
.color-legend-item { display: inline-flex; align-items: center; gap: 5px; }
.color-swatch {
  display: inline-block;
  width: 14px; height: 4px; border-radius: 2px;
}
.swatch-ok   { background: #22c55e; }
.swatch-warn { background: #eab308; }
.swatch-err  { background: #ef4444; }

/* ===== R69: node-detail modal ===================================== */
.modal-bg {
  position: fixed; inset: 0; background: rgba(0,0,0,0.55);
  display: flex; align-items: center; justify-content: center; z-index: 1000;
}
.node-detail-modal {
  background: #0f172a; border: 1px solid #1e293b; border-radius: 6px;
  min-width: 560px; max-width: 760px; max-height: 90vh;
  display: flex; flex-direction: column;
}
.node-detail-modal header { padding: 14px 18px; border-bottom: 1px solid #1e293b; }
.node-detail-modal header h3 {
  margin: 0; font-size: 15px; font-weight: 600; color: #e2e8f0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.node-detail-modal .meta {
  margin: 6px 0 0; color: #94a3b8; font-size: 12px;
}
.node-detail-modal .form-body {
  padding: 14px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px;
}
.detail-section { display: flex; flex-direction: column; gap: 6px; }
.detail-section .label {
  color: #94a3b8; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase;
}
.dc-list, .partner-list {
  list-style: none; margin: 0; padding: 0;
  display: flex; flex-direction: column; gap: 4px;
}
.dc-row, .partner-row {
  display: grid; grid-template-columns: minmax(120px, auto) 1fr auto;
  align-items: center; gap: 10px;
  padding: 6px 10px; background: #0b1220;
  border: 1px solid #1e293b; border-radius: 3px;
  font-size: 12px;
}
.dc-name, .partner-peer {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #e2e8f0; font-weight: 500;
}
.dc-roles { display: inline-flex; gap: 4px; flex-wrap: wrap; }
.role-badge {
  font-size: 10px; padding: 1px 6px; border-radius: 999px;
  border: 1px solid transparent; letter-spacing: 0.04em;
}
.role-bridge { color: #fbbf24; border-color: rgba(251, 191, 36, 0.5); background: rgba(251, 191, 36, 0.10); }
.role-pdc    { color: #f472b6; border-color: rgba(244, 114, 182, 0.5); background: rgba(244, 114, 182, 0.10); }
.role-gc     { color: #60a5fa; border-color: rgba(96, 165, 250, 0.5); background: rgba(96, 165, 250, 0.10); }
.role-rid    { color: #a78bfa; border-color: rgba(167, 139, 250, 0.5); background: rgba(167, 139, 250, 0.10); }
.role-infra  { color: #cbd5e1; border-color: rgba(203, 213, 225, 0.5); background: rgba(203, 213, 225, 0.08); }
.role-naming { color: #fb923c; border-color: rgba(251, 146, 60, 0.5); background: rgba(251, 146, 60, 0.10); }
.role-member { color: #94a3b8; border-color: rgba(148, 163, 184, 0.4); background: rgba(148, 163, 184, 0.06); }
.dc-partner-count { color: #94a3b8; font-size: 11px; }

.partner-row { grid-template-columns: 50px minmax(120px, auto) 1fr auto; }
.dir-tag {
  font-size: 10px; padding: 1px 6px; border-radius: 999px;
  border: 1px solid transparent; text-align: center; letter-spacing: 0.04em;
}
.dir-intra { color: #34d399; border-color: rgba(52, 211, 153, 0.5); background: rgba(52, 211, 153, 0.10); }
.dir-out   { color: #fb923c; border-color: rgba(251, 146, 60, 0.5); background: rgba(251, 146, 60, 0.10); }
.dir-in    { color: #60a5fa; border-color: rgba(96, 165, 250, 0.5); background: rgba(96, 165, 250, 0.10); }
.partner-peer-site { color: #94a3b8; font-size: 11px; }
.partner-status { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid transparent; }
.status-ok   { color: #22c55e; border-color: rgba(34, 197, 94, 0.5);  background: rgba(34, 197, 94, 0.10); }
.status-warn { color: #eab308; border-color: rgba(234, 179, 8, 0.5);  background: rgba(234, 179, 8, 0.10); }
.status-err  { color: #ef4444; border-color: rgba(239, 68, 68, 0.5);  background: rgba(239, 68, 68, 0.10); }

.node-detail-modal footer {
  display: flex; gap: 8px; justify-content: flex-end;
  padding: 12px 18px; border-top: 1px solid #1e293b;
}
.node-detail-modal footer button {
  padding: 6px 14px; border: 1px solid #1e293b;
  background: #0b1220; color: #e2e8f0; border-radius: 3px;
  cursor: pointer; font-size: 13px;
}
.node-detail-modal footer button:hover { background: #1e293b; }
.empty { color: #94a3b8; font-size: 12px; text-align: center; padding: 12px 0; }
</style>