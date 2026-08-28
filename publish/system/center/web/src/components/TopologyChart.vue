<!--
  复制拓扑 — 单图表视图
  2026-08-29 round-62 (operator directive "复制拓扑去掉两个图表 集合成一个图标"):
  collapse the dual-panel layout (R59 outbound + inbound, R61 horizontal
  side-by-side) into a SINGLE ECharts graph. Direction is preserved by
  the arrow at each edge's target end — no need to split into two
  panels to disambiguate source vs target.

  History:
    - R43 — add direction (was mutual connections → fixed to hub-spoke)
    - R59 — split into 出战 + 入站 two ECharts panels with lens-aware labels
    - R61 — change panels from vertical to horizontal + 3-color edges
    - R62 — collapse back to ONE chart; arrow direction is enough

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
        <span class="structure-sub">源 DC → 目标 DC — 箭头指向复制方向</span>
      </header>
      <div ref="chartEl" class="chart" data-test="topology-chart"></div>
    </section>
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

function buildOption() {
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

onMounted(async () => {
  await nextTick();
  if (chartEl.value) {
    chart = echarts.init(chartEl.value);
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
</style>