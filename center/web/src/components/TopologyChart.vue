<!--
  复制拓扑 — 单图表视图 (nested tree)

  2026-09-09 S83 (operator feedback: "DC 必须隶属于一个站点, 目前的复制
  架构图 站点和 DC 是分开的"): the previous implementation used
  ECharts `type: 'graph'` + `layout: 'force'` (physics simulation) which
  rendered Sites and DCs as INDEPENDENT nodes. R63 added an SVG overlay
  to draw bounding boxes around the per-site DC clusters — but the boxes
  were pure visual decoration, not a structural relationship. Moving
  the chart never carried the DCs along with their site.

  This round swaps to ECharts `type: 'tree'` with `layout: 'orthogonal'`,
  which gives us TRUE parent-child containment:
    - Each site is rendered as a tree branch (level 0).
    - Its DCs are nested as children (level 1) inside the site node.
    - Moving/zooming the chart keeps the DCs within their site container.
    - Intra-site replication links (DC ↔ DC inside the same site) are
      drawn between siblings within the same subtree.
    - Cross-site replication links are drawn between nodes in different
      subtrees via the tree series `links` parameter (ECharts tree supports
      non-hierarchical links for "spanning" connections).

  Visual treatment per node:
    - Hub site (R68 load-bearing layer):  roundRect 52px, gold (#fbbf24)
      with cream border (#fde68a) and bold (700 weight) label.
    - Spoke site:  roundRect 32px, faded (#94a3b8), thinner border.
    - DC:  circle 16px, neutral grey, lighter label.
    - Orphan bucket "未分组":  used when a DC has no `site` field.
      Visually identical to a Spoke site but with a dashed border so the
      operator notices the data-quality issue at a glance.

  Layered edge vocabulary (preserved from R68):
    - Hub↔Hub cross-site edges: width 2.5 (load-bearing).
    - Hub↔Spoke cross-site edges: width 1.0.
    - Spoke↔Spoke cross-site edges: HIDDEN (Hub-Spoke compliance).
    - Intra-site edges: width 1.5 (always visible).

  History:
    - R43 — direction (was mutual → hub-spoke)
    - R59 — split into 出战 + 入站 two ECharts panels
    - R61 — change panels from horizontal + 3-color edges
    - R62 — collapse back to ONE chart; arrow direction is enough
    - R63 — wrap each site's DCs in a colored site bounding box (SVG)
    - R68 — Hub-Spoke visual emphasis (Hub gold, Spoke faded, edge width)
    - R69 — click node → drill into detail modal
    - R70 — click edge → drill into pair-history modal
    - S83 — replace force-graph with nested tree; sites are parents,
            DCs are children, true containment (R63 SVG overlay retired)
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
        <span class="structure-sub">站点框 → DC 节点 → 复制链路（站点 = 父容器，DC = 子节点；箭头 = 复制方向，点击节点查看详情）</span>
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

  <!-- R70: edge-click drill-down modal. Renders the pair's last 10
       replication attempts (24h window) via the R45 `/pair-history`
       endpoint. data-test contract:
         edge-detail-modal      — modal root
         edge-detail-title      — header title (sourceDc → destDc)
         edge-detail-meta       — site→site · direction meta line
         edge-detail-summary    — 24h summary stats line (when loaded)
         edge-detail-loading    — loading state (visible while fetch in flight)
         edge-detail-error      — fetch error message
         edge-detail-attempts   — attempts table tbody container
         edge-detail-attempt    — single attempt row
         edge-detail-empty      — empty state (no entries)
         edge-detail-close      — close button
  -->
  <div v-if="clickedEdge" class="modal-bg" @click.self="closeEdgeModal" data-test="edge-detail-modal">
    <div class="modal edge-detail-modal">
      <header>
        <h3 data-test="edge-detail-title">{{ edgeDetail.title }}</h3>
        <p v-if="edgeDetail.meta" class="meta" data-test="edge-detail-meta">{{ edgeDetail.meta }}</p>
      </header>
      <section class="form-body">
        <div v-if="edgeLoading" class="loading" data-test="edge-detail-loading">
          正在加载最近 10 条复制尝试…
        </div>
        <div v-else-if="edgeError" class="error-banner" data-test="edge-detail-error">
          加载失败 — {{ edgeError }}
        </div>
        <div v-else-if="edgeDetail.summary" class="detail-section">
          <span class="label">24h 摘要</span>
          <p class="summary-line" data-test="edge-detail-summary">{{ edgeDetail.summary }}</p>
        </div>

        <div v-if="!edgeLoading && !edgeError && edgeDetail.entries.length" class="detail-section">
          <span class="label">最近 {{ edgeDetail.entries.length }} 条尝试</span>
          <table class="attempts-table" data-test="edge-detail-attempts">
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
              <tr
                v-for="(a, i) in edgeDetail.entries"
                :key="i"
                class="attempt-row"
                :class="`attempt-row-${attemptStatusClass(a.statusCode)}`"
                data-test="edge-detail-attempt"
              >
                <td>{{ fmtTs(a.attemptAt) }}</td>
                <td>
                  <span class="glyph">{{ attemptGlyph(a.statusCode) }}</span>
                  {{ attemptLabel(a.statusCode) }}
                </td>
                <td>{{ a.durationMs ?? '—' }}</td>
                <td>{{ a.objectsTransferred ?? '—' }}</td>
                <td>{{ fmtTs(a.lastSuccessTime) }}</td>
                <td class="error-cell">{{ a.errorMessage || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <p v-else-if="!edgeLoading && !edgeError && !edgeDetail.entries.length" class="empty" data-test="edge-detail-empty">
          暂无 24h 内的复制尝试数据
        </p>
      </section>
      <footer>
        <button type="button" data-test="edge-detail-close" @click="closeEdgeModal">关闭</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch, nextTick, computed } from 'vue';
import * as echarts from 'echarts';
// R70: edge-click drill-down modal. Reuses the per-pair pair-history
// endpoint already implemented by R45 (see center/web/src/api/dashboard.js
// `getSiteReplicationMatrixPairHistory` + center/src/routes/dashboard.js
// `GET /api/dashboard/site-replication-matrix/pair-history`). The endpoint
// returns the last N replication attempts FROM `source` DC TO `dest` DC
// within the past 24h.
import { dashboardApi } from '../api/dashboard.js';

const props = defineProps({
  data: { type: Object, default: () => ({ nodes: [], links: [] }) }
});

const chartEl = ref(null);
let chart = null;
// R69: clicked node detail (drives the modal). null = closed.
// Stores the ORIGINAL node from props.data (not the ECharts-wrapped
// object) so role badges + partner counts derive from source-of-truth.
const clickedNode = ref(null);

// ── Site order + DC → site lookup (shared across renders) ──────────────
// S83: siteOrder walks `props.data.nodes` in order to preserve the
// backend's site ordering (e.g. 核心站点 first). The orphan bucket is
// always appended LAST so the well-formed sites come first.
const ORPHAN_BUCKET = '未分组';

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

function hubSet() {
  const set = new Set();
  for (const n of (props.data.nodes || [])) {
    if (n.type === 'site' && n.isHub) set.add(n.name);
  }
  return set;
}

// Compact site-name abbrev for edge labels. The legend already maps
// each site to its own color, so 1-2 chars is enough on the canvas.
function shortSite(name) {
  if (!name) return '?';
  if (name === '核心站点') return 'HUB';
  if (name.endsWith('站点')) return name.slice(0, 2);
  return name.slice(0, 3);
}

// ── S83: tree-data construction ──────────────────────────────────────
// Each site node carries:
//   - symbol/symbolSize/itemStyle/label — visual treatment (Hub vs Spoke)
//   - children — the DCs nested inside the site, each as a leaf with
//     empty children (ECharts requires `children` to be present; an empty
//     array makes the node a leaf so it renders at level 1 only).
//
// Orphan DCs (no `site` field, or site not in siteOrder) are bucketed
// into a synthetic "未分组" site rendered LAST so well-formed sites stay
// prominent.
function buildTreeData() {
  const nodes = props.data.nodes || [];
  const dcsBySite = new Map();
  for (const siteName of siteOrder.value) {
    dcsBySite.set(siteName, []);
  }
  const orphanDcs = [];
  for (const n of nodes) {
    if (n.type !== 'dc') continue;
    const siteName = n.site;
    if (siteName && dcsBySite.has(siteName)) {
      dcsBySite.get(siteName).push(n);
    } else {
      orphanDcs.push(n);
    }
  }

  const branches = siteOrder.value.map(siteName => {
    const siteNode = nodes.find(n => n.name === siteName && n.type === 'site');
    const isHub = !!siteNode?.isHub;
    const dcs = dcsBySite.get(siteName) || [];
    return {
      name: siteName,
      _type: 'site',
      _isHub: isHub,
      _original: siteNode,
      symbol: 'roundRect',
      symbolSize: isHub ? 52 : 32,
      itemStyle: {
        color: isHub ? '#fbbf24' : '#94a3b8',
        borderColor: isHub ? '#fde68a' : '#64748b',
        borderWidth: isHub ? 2 : 1
      },
      label: {
        show: true,
        color: isHub ? '#fef3c7' : '#e2e8f0',
        fontWeight: isHub ? 700 : 500,
        fontSize: isHub ? 14 : 12
      },
      children: dcs.map(dc => ({
        name: dc.name,
        _type: 'dc',
        _site: siteName,
        _original: dc,
        symbol: 'circle',
        symbolSize: 16,
        itemStyle: { color: '#94a3b8', borderColor: 'transparent', borderWidth: 0 },
        label: {
          show: true,
          color: '#cbd5e1',
          fontWeight: 400,
          fontSize: 11
        },
        children: []
      }))
    };
  });

  // Orphan bucket — synthetic site rendered LAST. Dashed border so the
  // operator notices the data-quality issue (DCs without a site field).
  if (orphanDcs.length > 0) {
    branches.push({
      name: ORPHAN_BUCKET,
      _type: 'site',
      _isHub: false,
      _original: { name: ORPHAN_BUCKET, type: 'site', isHub: false },
      symbol: 'roundRect',
      symbolSize: 32,
      itemStyle: {
        color: '#94a3b8',
        borderColor: '#64748b',
        borderWidth: 1,
        borderType: 'dashed'
      },
      label: {
        show: true,
        color: '#e2e8f0',
        fontWeight: 500,
        fontSize: 12
      },
      children: orphanDcs.map(dc => ({
        name: dc.name,
        _type: 'dc',
        _site: ORPHAN_BUCKET,
        _original: dc,
        symbol: 'circle',
        symbolSize: 16,
        itemStyle: { color: '#94a3b8', borderColor: 'transparent', borderWidth: 0 },
        label: {
          show: true,
          color: '#cbd5e1',
          fontWeight: 400,
          fontSize: 11
        },
        children: []
      }))
    });
  }

  return branches;
}

// ── S83: tree links for DC↔DC replication edges ──────────────────────
// ECharts tree series accepts `links` for non-hierarchical connections.
// Source/target are node names (must exist in the tree data). Each link
// carries the same per-link metadata that R68's graph did — status color,
// intra/cross label, Hub↔Hub vs Hub↔Spoke width, etc.
//
// Spoke↔Spoke cross-site links are filtered out (Hub-Spoke compliance).
function buildTreeLinks() {
  const dcSites = dcSiteLookup();
  const hub = hubSet();
  const links = [];
  for (const l of (props.data.links || [])) {
    const sourceSite = dcSites.get(l.source);
    const destSite = dcSites.get(l.target);
    if (!sourceSite || !destSite) continue;
    const isIntra = sourceSite === destSite;
    const sourceIsHub = hub.has(sourceSite);
    const destIsHub = hub.has(destSite);
    // Filter spoke-spoke cross-site (designed absence — Hub-Spoke compliance).
    if (!isIntra && !sourceIsHub && !destIsHub) continue;
    const edgeColor =
      l.statusCode === 0 ? '#22c55e' :
      l.statusCode === 1 ? '#eab308' :
      '#ef4444';
    const edgeTextColor =
      l.statusCode === 0 ? '#86efac' :
      l.statusCode === 1 ? '#fde68a' :
      '#fca5a5';
    let labelText;
    if (isIntra) {
      labelText = '↔ 内';
    } else {
      labelText = `${shortSite(sourceSite)}→${shortSite(destSite)}`;
    }
    const layer = (sourceIsHub && destIsHub) ? 'hub-hub' : 'hub-spoke';
    const edgeWidth = isIntra ? 1.5 : (layer === 'hub-hub' ? 2.5 : 1.0);
    links.push({
      source: l.source,
      target: l.target,
      symbol: ['none', 'arrow'],
      symbolSize: 8,
      lineStyle: {
        color: edgeColor,
        width: edgeWidth,
        curveness: 0.5,
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
    });
  }
  return links;
}

function buildOption() {
  const treeData = buildTreeData();
  const treeLinks = buildTreeLinks();
  const dcSites = dcSiteLookup();
  const legendData = [...siteOrder.value];
  if (treeData.some(b => b.name === ORPHAN_BUCKET)) legendData.push(ORPHAN_BUCKET);

  return {
    tooltip: {
      formatter: (p) => {
        if (p.dataType === 'node') {
          const n = p.data || {};
          if (n._type === 'site') {
            const dcCount = (n.children || []).length;
            const hubTag = n._isHub ? ' · 承载层 Hub' : (n.name === ORPHAN_BUCKET ? ' · 孤立 DC 桶' : ' · 分支 Spoke');
            return `<b>${n.name}</b> (站点)<br/>DC 数量: ${dcCount}${hubTag}`;
          }
          if (n._type === 'dc') {
            return `<b>${n.name}</b> (DC)<br/>站点: ${n._site || '?'}`;
          }
          return n.name || '';
        }
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
        return '';
      }
    },
    legend: [{
      data: legendData,
      textStyle: { color: '#cbd5e1' },
      top: 8
    }],
    series: [{
      type: 'tree',
      id: 'topology-tree',
      layout: 'orthogonal',
      orient: 'LR',
      roam: true,
      draggable: true,
      initialTreeDepth: -1,
      expandAndCollapse: false,
      animationDuration: 0,
      animationDurationUpdate: 0,
      data: treeData,
      links: treeLinks,
      symbolSize: 14,
      label: {
        show: true,
        position: 'left',
        verticalAlign: 'middle',
        align: 'right',
        color: '#e2e8f0'
      },
      leaves: {
        label: {
          position: 'right',
          align: 'left',
          color: '#cbd5e1'
        }
      },
      lineStyle: {
        color: '#475569',
        curveness: 0.5,
        width: 1.5
      },
      emphasis: {
        focus: 'descendant'
      }
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

// ─────────────────────────────────────────────────────────────────────
// 2026-08-30 round-70 (continuation of R69 drillability):
// clicking an EDGE opens a separate modal showing the pair's last 10
// replication attempts (per R45's `/pair-history` endpoint). Independent
// of the node-detail modal — both can be open sequentially but never
// simultaneously (clicking any element while the other is open closes
// the previous one and opens the new one).
//
// S83: tree series accepts `links` (DC↔DC replication edges) but the
// edge click still resolves via the same ECharts click event (params.data
// has `source`/`target` names). The modal logic is unchanged from R70.
// ─────────────────────────────────────────────────────────────────────
const clickedEdge = ref(null);     // { source, target, sourceSite, destSite, direction, statusCode } | null
const edgeHistory = ref([]);       // fetched entries: [{ attemptAt, statusCode, ... }]
const edgeLoading = ref(false);    // fetch in flight
const edgeError = ref('');         // fetch error message

function closeEdgeModal() {
  clickedEdge.value = null;
  edgeHistory.value = [];
  edgeError.value = '';
  edgeLoading.value = false;
}

// R70: derive edge-detail payload for the modal template.
//   - title:     sourceDc → destDc
//   - meta:      sourceSite → destSite · direction (intra / 出战 / 入站)
//   - summary:   24h 内 N 次尝试 · 成功 X · 部分失败 Y · 断开 Z
//   - entries:   attempts[] from API (rendered as table rows)
const edgeDetail = computed(() => {
  if (!clickedEdge.value) {
    return { title: '', meta: '', summary: '', entries: [] };
  }
  const e = clickedEdge.value;
  const dirText = e.direction === 'intra' ? '站内' : (e.direction === 'out' ? '出战' : '入站');
  const ok = edgeHistory.value.filter(a => a.statusCode === 0).length;
  const warn = edgeHistory.value.filter(a => a.statusCode === 1).length;
  const err = edgeHistory.value.filter(a => a.statusCode >= 2).length;
  const summary = edgeHistory.value.length
    ? `24h 内 ${edgeHistory.value.length} 次尝试 · 成功 ${ok} · 部分失败 ${warn} · 断开 ${err}`
    : '';
  return {
    title: `${e.source} → ${e.target}`,
    meta: `${e.sourceSite} → ${e.destSite} · ${dirText}`,
    summary,
    entries: edgeHistory.value
  };
});

function attemptGlyph(code) {
  if (code === 0) return '●';
  if (code === 1) return '▲';
  return '✕';
}
function attemptLabel(code) {
  if (code === 0) return '成功';
  if (code === 1) return '部分失败';
  return '断开/失败';
}
function attemptStatusClass(code) {
  if (code === 0) return 'ok';
  if (code === 1) return 'warn';
  return 'err';
}
function fmtTs(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '—'; }

// R70: handle ECharts edge click. params.dataType === 'edge' gives us
// the wrapped link object ({ source, target, lineStyle, ... }). We
// resolve to the ORIGINAL props.data link so statusCode is the
// source-of-truth (the wrapper's `lineStyle.color` is a hex code, not
// a numeric status, so we don't use it).
function handleEdgeClick(params) {
  if (!params || params.dataType !== 'edge') return;
  const edge = params.data;
  if (!edge || !edge.source || !edge.target) return;
  // Resolve source/target to ORIGINAL props.data links[] entries.
  const original = (props.data?.links || []).find(
    l => l.source === edge.source && l.target === edge.target
  ) || { source: edge.source, target: edge.target, statusCode: 0 };
  // Close the node modal if open — only one drill-down at a time.
  clickedNode.value = null;
  // Determine direction via site lookup.
  const dcSites = dcSiteLookup();
  const sourceSite = dcSites.get(original.source) || '?';
  const destSite = dcSites.get(original.target) || '?';
  const isIntra = sourceSite !== '?' && destSite !== '?' && sourceSite === destSite;
  // For the API contract: query param `source` = the reporting DC,
  // `dest` = the peer. With ECharts edge convention source→target,
  // source = original.source, dest = original.target.
  clickedEdge.value = {
    source: original.source,
    target: original.target,
    sourceSite,
    destSite,
    direction: isIntra ? 'intra' : 'out', // operator's POV: this site reports outbound
    statusCode: original.statusCode
  };
  // Reset state for the new fetch.
  edgeHistory.value = [];
  edgeError.value = '';
  edgeLoading.value = true;
  dashboardApi.getSiteReplicationMatrixPairHistory(original.target, original.source, 10)
    .then(r => {
      edgeHistory.value = Array.isArray(r?.data?.entries) ? r.data.entries : [];
    })
    .catch(e => {
      edgeError.value = e?.response?.data?.error || e?.message || '加载失败';
      edgeHistory.value = [];
    })
    .finally(() => { edgeLoading.value = false; });
}
// R69: handle ECharts click. ECharts passes { dataType, data } where
//   dataType === 'node' → data = node object (with name, type, site, isHub, ...)
//   dataType === 'edge' → ignore for v1 (edge-click is a future feature).
//
// S83: tree series nodes carry `_type` / `_site` / `_isHub` (the internal
// shape produced by buildTreeData), but for backward compatibility with
// direct-test dispatch (which uses the legacy `{ type: 'site' }` shape)
// we accept both. `_type` takes precedence — that's the canonical shape
// ECharts will produce at click time after S83.
function handleNodeClick(params) {
  if (!params || params.dataType !== 'node') return;
  const node = params.data;
  if (!node) return;
  const type = node._type || node.type;
  if (type !== 'site' && type !== 'dc') return;
  // Resolve to the ORIGINAL props.data node (the ECharts-wrapped tree
  // node is freshly constructed each render; we want the source-of-truth
  // for role badges + DC list + partner count).
  const original = (props.data?.nodes || []).find(
    n => n.name === node.name && n.type === type
  );
  if (original) {
    clickedNode.value = original;
  } else {
    // Fallback: synthetic orphan-bucket site or any node without a
    // direct props.data counterpart (e.g. the 未分组 bucket itself, or
    // tests that pass a node without a source counterpart).
    clickedNode.value = {
      name: node.name,
      type,
      isHub: !!(node._isHub ?? node.isHub),
      site: node._site ?? node.site
    };
  }
}

onMounted(async () => {
  await nextTick();
  if (chartEl.value) {
    chart = echarts.init(chartEl.value);
    // R69: node-click drill-down modal.
    chart.on('click', handleNodeClick);
    // R70: edge-click drill-down modal (independent of node-click).
    // Both handlers early-return based on params.dataType, so registering
    // them both is safe — only one fires for any given click target.
    chart.on('click', handleEdgeClick);
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

/* ===== R70: edge-detail modal ===================================== */
.edge-detail-modal {
  background: #0f172a; border: 1px solid #1e293b; border-radius: 6px;
  min-width: 720px; max-width: 880px; max-height: 90vh;
  display: flex; flex-direction: column;
}
.edge-detail-modal header { padding: 14px 18px; border-bottom: 1px solid #1e293b; }
.edge-detail-modal header h3 {
  margin: 0; font-size: 15px; font-weight: 600; color: #e2e8f0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.edge-detail-modal .meta {
  margin: 6px 0 0; color: #94a3b8; font-size: 12px;
}
.edge-detail-modal .form-body {
  padding: 14px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px;
}
.summary-line {
  margin: 0; padding: 6px 10px; background: #0b1220;
  border: 1px solid #1e293b; border-radius: 3px;
  color: #cbd5e1; font-size: 12px;
}
.attempts-table {
  width: 100%; border-collapse: collapse; font-size: 12px;
}
.attempts-table th, .attempts-table td {
  padding: 6px 10px; text-align: left;
  border-bottom: 1px solid #1e293b;
}
.attempts-table th {
  color: #94a3b8; font-weight: 500; font-size: 11px;
  letter-spacing: 0.04em; text-transform: uppercase;
}
.attempts-table td { color: #e2e8f0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.attempts-table td .glyph { margin-right: 6px; font-size: 10px; }
.attempts-table td.error-cell {
  color: #fca5a5; max-width: 280px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; font-family: inherit;
}
.attempt-row-ok    td .glyph { color: #22c55e; }
.attempt-row-warn  td .glyph { color: #eab308; }
.attempt-row-err   td .glyph { color: #ef4444; }
.attempt-row-err   td:first-child { color: #fca5a5; }
.loading { color: #94a3b8; font-size: 12px; text-align: center; padding: 18px 0; }
.error-banner {
  background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.4);
  color: #fca5a5; padding: 8px 12px; border-radius: 3px; font-size: 12px;
}
.edge-detail-modal footer {
  display: flex; gap: 8px; justify-content: flex-end;
  padding: 12px 18px; border-top: 1px solid #1e293b;
}
.edge-detail-modal footer button {
  padding: 6px 14px; border: 1px solid #1e293b;
  background: #0b1220; color: #e2e8f0; border-radius: 3px;
  cursor: pointer; font-size: 13px;
}
.edge-detail-modal footer button:hover { background: #1e293b; }
</style>
