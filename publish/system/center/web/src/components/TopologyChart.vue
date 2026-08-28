<template>
  <!-- 2026-08-29 round-61: 3-color legend (green/yellow/red) so the
       operator can map edge color → health state at a glance. Lives
       above the side-by-side panels so it's visible regardless of
       which lens the operator is reading. -->
  <div class="color-legend" data-test="color-legend">
    <span class="color-legend-item"><span class="color-swatch swatch-ok"></span>正常 (statusCode 0)</span>
    <span class="color-legend-item"><span class="color-swatch swatch-warn"></span>部分失败 (statusCode 1)</span>
    <span class="color-legend-item"><span class="color-swatch swatch-err"></span>断开/失败 (statusCode 2+)</span>
  </div>
  <div class="topology-split">
    <section class="structure outbound" data-test="outbound-structure">
      <header class="structure-header">
        <span class="structure-tag tag-out">出战</span>
        <h3>出战复制结构</h3>
        <span class="structure-sub">源 DC → 目标 DC — 谁主动推送复制伙伴</span>
      </header>
      <div ref="outboundEl" class="chart" data-test="outbound-chart"></div>
    </section>
    <section class="structure inbound" data-test="inbound-structure">
      <header class="structure-header">
        <span class="structure-tag tag-in">入站</span>
        <h3>入站复制结构</h3>
        <span class="structure-sub">源 DC → 目标 DC — 谁被动接收复制伙伴</span>
      </header>
      <div ref="inboundEl" class="chart" data-test="inbound-chart"></div>
    </section>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch, nextTick, computed } from 'vue';
import * as echarts from 'echarts';

const props = defineProps({
  data: { type: Object, default: () => ({ nodes: [], links: [] }) }
});

const outboundEl = ref(null);
const inboundEl = ref(null);
let outboundChart = null;
let inboundChart = null;

// 2026-08-29 round-59 (operator directive): 复制拓扑展示时,站点作为域控
// 的父级 (sites-as-parents of DCs),入站和出战链路分成两个独立的结构
// 展示 (inbound + outbound links as TWO separate visual structures).
//
// 2026-08-29 round-61 (operator directive "复制拓扑 改成左右结构 左边是
// 出站 右边是入站...也是绿色 黄色 红色 展现连接效果"): change the
// panel layout from vertical stack to horizontal side-by-side (left =
// 出战 outbound, right = 入站 inbound) and add YELLOW for partial-
// failure edges (statusCode === 1), so the topology now matches the
// R60 matrix's 3-color health vocabulary: green (OK), yellow (warn),
// red (err).
//
// Why two structures (not one merged canvas with arrow direction):
//   - Operator reads "出战" naturally as "from this DC's POV, who do I
//     push to?" and "入站" as "into this DC, who pushes to me?". A
//     single canvas with arrows makes the operator mentally invert
//     every edge; two canvases let them pick the lens they need.
//   - Each lens reuses the same site-as-parent layout so the topology
//     geometry is identical across the two — the operator can verify
//     symmetry by glancing between the two panels (e.g. a hub that
//     appears as a source in 出战 should appear as a target in 入站 for
//     the same edge).
//
// Layout choices (shared by both canvases):
//   - Sites get per-site category index → ECharts force layout clusters
//     each site's DCs around its site node. Sites are heavy anchors
//     (mass: 8); DCs are light (mass: 1) and settle around their parent.
//   - Edge `symbol: ['none', 'arrow']` puts an arrow at target — direction
//     is unambiguous regardless of which panel you're reading.
//   - Edge color = green (statusCode 0) / yellow (statusCode 1) / red
//     (statusCode 2+). Matches R60 复制状态概览 vocabulary.
//   - Edge label = "SourceSite→DestSite" in 出战, "DestSite←SourceSite"
//     in 入站 — same edge, different reading lens.
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

// Build the shared node list + the per-panel edge set. The two panels
// show the same edges (every edge is both an outbound-from-source and an
// inbound-to-target) but with different label direction so the operator
// can pick the lens they need.
function buildOption({ lens }) {
  const siteIndex = new Map(siteOrder.value.map((s, i) => [s, i]));
  const dcSites = dcSiteLookup();

  const nodes = (props.data.nodes || []).map(n => {
    const isSite = n.type === 'site';
    return {
      name: n.name,
      category: isSite ? (siteIndex.get(n.name) ?? 0) : (siteIndex.get(n.site) ?? 0),
      symbolSize: isSite ? 38 : 16,
      mass: isSite ? 8 : 1,
      symbol: isSite ? 'roundRect' : 'circle',
      itemStyle: { color: isSite ? '#38bdf8' : '#94a3b8' },
      label: {
        show: true,
        color: isSite ? '#e2e8f0' : '#cbd5e1',
        fontWeight: isSite ? 600 : 400,
        fontSize: isSite ? 13 : 11
      }
    };
  });

  const links = (props.data.links || []).map(l => {
    const sourceSite = dcSites.get(l.source);
    const destSite = dcSites.get(l.target);
    const isIntra = sourceSite && destSite && sourceSite === destSite;
    let labelText = '';
    if (isIntra) {
      // Intra-site link: same site, just show the ↔ marker.
      labelText = '↔ 内';
    } else if (lens === 'outbound') {
      // 出战 lens: emphasize the source DC pushing out.
      const ss = shortSite(sourceSite);
      const ds = shortSite(destSite);
      labelText = `${ss}→${ds}`;
    } else {
      // 入站 lens: emphasize the target DC receiving.
      const ss = shortSite(sourceSite);
      const ds = shortSite(destSite);
      labelText = `${ds}←${ss}`;
    }
    // 2026-08-29 round-61: 3-color health vocabulary to match R60
    // 复制状态概览 — green (statusCode 0), yellow (1 = partial),
    // red (2+ = failure). Used by both lineStyle + edgeLabel text.
    const edgeColor =
      l.statusCode === 0 ? '#22c55e' :
      l.statusCode === 1 ? '#eab308' :
      '#ef4444';
    const edgeTextColor =
      l.statusCode === 0 ? '#86efac' :
      l.statusCode === 1 ? '#fde68a' :
      '#fca5a5';
    return {
      source: l.source,
      target: l.target,
      symbol: ['none', 'arrow'],
      symbolSize: 8,
      lineStyle: {
        color: edgeColor,
        width: 1.5,
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
  });

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
          const dirWord = lens === 'outbound' ? '出战→' : '→入站';
          const dir = isIntra
            ? 'intra-site (内)'
            : `${sourceSite || '?'} ${dirWord} ${destSite || '?'}`;
          // 2026-08-29 round-61: 3-state status word matches the 3 colors.
          const c = l.lineStyle && l.lineStyle.color;
          const status =
            c === '#22c55e' ? '✓ 复制成功' :
            c === '#eab308' ? '! 部分失败' :
            '✕ 失败/断开';
          return `<b>${l.source} → ${l.target}</b><br/>视角: ${lens === 'outbound' ? '出战复制结构' : '入站复制结构'}<br/>方向: ${dir}<br/>状态: ${status}`;
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

function renderOutbound() {
  if (!outboundChart || !outboundEl.value) return;
  outboundChart.setOption(buildOption({ lens: 'outbound' }));
}

function renderInbound() {
  if (!inboundChart || !inboundEl.value) return;
  inboundChart.setOption(buildOption({ lens: 'inbound' }));
}

onMounted(async () => {
  await nextTick();
  if (outboundEl.value) {
    outboundChart = echarts.init(outboundEl.value);
    renderOutbound();
  }
  if (inboundEl.value) {
    inboundChart = echarts.init(inboundEl.value);
    renderInbound();
  }
});

watch(() => props.data, () => {
  renderOutbound();
  renderInbound();
}, { deep: true });

onUnmounted(() => {
  outboundChart?.dispose();
  inboundChart?.dispose();
});
</script>

<style scoped>
/* 2026-08-29 round-61: operator directive "复制拓扑 改成左右结构 左边是
   出站 右边是入站". The two panels sit side-by-side, not stacked.
   On narrow viewports (<900px) they collapse back to vertical stack
   so the canvas stays usable. */
.topology-split {
  display: flex;
  flex-direction: row;
  gap: 14px;
  align-items: stretch;
}
.structure {
  flex: 1 1 50%;
  min-width: 0;
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
}
.tag-out {
  color: #fde68a;
  background: rgba(251, 191, 36, 0.16);
  border: 1px solid rgba(251, 191, 36, 0.4);
}
.tag-in {
  color: #a5f3fc;
  background: rgba(34, 211, 238, 0.14);
  border: 1px solid rgba(34, 211, 238, 0.4);
}
.structure-sub {
  color: #94a3b8;
  font-size: 12px;
}
.chart {
  width: 100%;
  height: 460px;
  border-radius: 6px;
}
/* Compact legend (3 colors) shown at the top of the page header so
   the operator can map edge color → health state at a glance. */
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

@media (max-width: 900px) {
  .topology-split { flex-direction: column; }
  .structure { flex: 1 1 100%; }
}
</style>
