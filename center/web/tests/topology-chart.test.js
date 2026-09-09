import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

// vi.mock factory is hoisted to top of file; reference hoisted vars to avoid TDZ errors.
// S83: chart.on('click') for node + edge handlers. The 'finished' handler
// from R63 (which drew SVG bounding boxes) is GONE — the tree layout
// itself provides site-as-parent containment, so the overlay is retired.
// R70: dashboardApi.getSiteReplicationMatrixPairHistory needs to be
// mockable for edge-click drill-down tests.
const { setOptionMock, disposeMock, initMock, onMock, getPairHistoryMock } = vi.hoisted(() => {
  const setOptionMock = vi.fn();
  const disposeMock = vi.fn();
  const onMock = vi.fn();
  const getPairHistoryMock = vi.fn(() => Promise.resolve({ data: { entries: [] } }));
  const initMock = vi.fn(() => ({
    setOption: setOptionMock,
    dispose: disposeMock,
    on: onMock,
    resize: vi.fn()
  }));
  return { setOptionMock, disposeMock, initMock, onMock, getPairHistoryMock };
});

vi.mock('echarts', () => ({
  default: { init: initMock },
  init: initMock
}));

vi.mock('../src/api/dashboard.js', () => ({
  dashboardApi: {
    getSiteReplicationMatrixPairHistory: getPairHistoryMock
  }
}));

import TopologyChart from '../src/components/TopologyChart.vue';

// R69 helper: capture the 'click' handler for the node drill-down modal.
function getClickHandler() {
  const call = onMock.mock.calls.find(c => c[0] === 'click');
  return call ? call[1] : null;
}
// R70 helper: capture ALL 'click' handlers so tests can dispatch
// edge clicks separately from node clicks (R69 + R70 each register one).
function getAllClickHandlers() {
  return onMock.mock.calls.filter(c => c[0] === 'click').map(c => c[1]);
}

beforeEach(() => {
  setOptionMock.mockReset();
  disposeMock.mockReset();
  initMock.mockReset();
  onMock.mockReset();
  getPairHistoryMock.mockReset();
  // Default pair-history response: empty entries (tests that need real
  // entries override per-call with mockResolvedValueOnce).
  getPairHistoryMock.mockResolvedValue({ data: { entries: [] } });
  initMock.mockImplementation(() => ({
    setOption: setOptionMock,
    dispose: disposeMock,
    on: onMock,
    resize: vi.fn()
  }));
});

// ────────────────────────────────────────────────────────────────────────
// 2026-09-09 S83 (operator feedback: "DC 必须隶属于一个站点, 目前的复制
// 架构图 站点和 DC 是分开的"):
//
// The previous implementation rendered ECharts `type: 'graph'` +
// `layout: 'force'` (R62), which put Sites and DCs as independent nodes
// on the same canvas. R63 added a SVG-overlay hack to draw bounding
// boxes, but the boxes were pure decoration — moving the chart never
// carried the DCs along with their site.
//
// S83 swaps to `type: 'tree'` + `layout: 'orthogonal'`, which gives
// TRUE parent-child containment: each site is a level-0 root, its DCs
// are level-1 leaves nested inside. The R63 SVG overlay is retired
// (tree layout makes it redundant). Edges between DCs (intra-site +
// cross-site) are drawn via the tree series' `links` parameter, which
// ECharts supports for non-hierarchical connections on top of the tree.
// ────────────────────────────────────────────────────────────────────────

// S83-T1: series type is now 'tree', not 'graph'.
test('S83: series type is tree (not graph+force)', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site', isHub: true },
      { name: 'DC1', type: 'dc', site: 'A' }
    ],
    links: []
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  expect(setOptionMock).toHaveBeenCalledTimes(1);
  const opt = setOptionMock.mock.calls[0][0];
  expect(opt.series[0].type).toBe('tree');
  expect(opt.series[0].layout).toBe('orthogonal');
});

// S83-T2: tree data structure — sites become roots with DCs as children.
test('S83: site nodes appear as tree roots with DCs nested as children', async () => {
  const data = {
    nodes: [
      { name: '核心站点', type: 'site', isHub: true },
      { name: '厦门站点', type: 'site', isHub: false },
      { name: 'MOCK-HUBADSRV1', type: 'dc', site: '核心站点' },
      { name: 'MOCK-HUBADSRV2', type: 'dc', site: '核心站点' },
      { name: 'MOCK-XMADSRV1', type: 'dc', site: '厦门站点' }
    ],
    links: []
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  const opt = setOptionMock.mock.calls[0][0];
  const branches = opt.series[0].data;
  expect(Array.isArray(branches)).toBe(true);
  expect(branches).toHaveLength(2);
  const hub = branches.find(b => b.name === '核心站点');
  const spoke = branches.find(b => b.name === '厦门站点');
  expect(hub).toBeDefined();
  expect(spoke).toBeDefined();
  expect(hub._type).toBe('site');
  expect(hub._isHub).toBe(true);
  expect(hub.children).toHaveLength(2);
  expect(hub.children.map(c => c.name)).toEqual(['MOCK-HUBADSRV1', 'MOCK-HUBADSRV2']);
  expect(hub.children.every(c => c._type === 'dc')).toBe(true);
  expect(spoke._isHub).toBe(false);
  expect(spoke.children).toHaveLength(1);
  expect(spoke.children[0].name).toBe('MOCK-XMADSRV1');
});

// S83-T3: orphan DCs (no `site` field) go to a default "未分组" bucket.
test('S83: orphan DCs (no site) bucket into 未分组', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site', isHub: true },
      { name: 'DC1', type: 'dc', site: 'A' },
      { name: 'ORPHAN1', type: 'dc' },          // no site field
      { name: 'ORPHAN2', type: 'dc', site: 'ZZZ' } // site doesn't exist
    ],
    links: []
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  const opt = setOptionMock.mock.calls[0][0];
  const branches = opt.series[0].data;
  expect(branches).toHaveLength(2);
  const orphan = branches.find(b => b.name === '未分组');
  expect(orphan).toBeDefined();
  expect(orphan._type).toBe('site');
  expect(orphan._isHub).toBe(false);
  expect(orphan.children).toHaveLength(2);
  const orphanNames = orphan.children.map(c => c.name).sort();
  expect(orphanNames).toEqual(['ORPHAN1', 'ORPHAN2']);
});

// S83-T4: Hub site styling preserved (gold + bigger).
test('S83: Hub site renders with gold styling (load-bearing layer)', async () => {
  const data = {
    nodes: [
      { name: 'HUB-A', type: 'site', isHub: true },
      { name: 'SPOKE-B', type: 'site', isHub: false },
      { name: 'DC-H1', type: 'dc', site: 'HUB-A' },
      { name: 'DC-S1', type: 'dc', site: 'SPOKE-B' }
    ],
    links: []
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  const opt = setOptionMock.mock.calls[0][0];
  const hub = opt.series[0].data.find(b => b.name === 'HUB-A');
  const spoke = opt.series[0].data.find(b => b.name === 'SPOKE-B');
  expect(hub.symbol).toBe('roundRect');
  expect(hub.symbolSize).toBe(52);
  expect(hub.itemStyle.color).toBe('#fbbf24');
  expect(hub.itemStyle.borderWidth).toBe(2);
  expect(hub.label.fontWeight).toBe(700);
  // Spoke is smaller and faded
  expect(spoke.symbolSize).toBe(32);
  expect(spoke.itemStyle.color).toBe('#94a3b8');
  expect(spoke.symbolSize).toBeLessThan(hub.symbolSize);
});

// S83-T5: site without isHub flag falls back to Spoke styling.
test('S83: site without isHub flag defaults to Spoke styling', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site' },
      { name: 'DC1', type: 'dc', site: 'A' }
    ],
    links: []
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  const opt = setOptionMock.mock.calls[0][0];
  const site = opt.series[0].data.find(b => b.name === 'A');
  expect(site._isHub).toBe(false);
  expect(site.symbolSize).toBe(32);
  expect(site.itemStyle.color).toBe('#94a3b8');
});

// S83-T6: DC node styling — circle, smaller.
test('S83: DC nodes render as smaller circles with neutral grey', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site', isHub: true },
      { name: 'DC1', type: 'dc', site: 'A' },
      { name: 'DC2', type: 'dc', site: 'A' }
    ],
    links: []
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  const opt = setOptionMock.mock.calls[0][0];
  const branch = opt.series[0].data[0];
  for (const dc of branch.children) {
    expect(dc.symbol).toBe('circle');
    expect(dc.symbolSize).toBe(16);
    expect(dc.itemStyle.color).toBe('#94a3b8');
    expect(dc.children).toEqual([]); // tree leaves need children=[]
  }
});

// S83-T7: replication edges flow through the tree series `links` parameter.
// S83-T8: edge labels + colors preserved (green/yellow/red).
test('S83: DC↔DC replication edges render via tree.links with status colors', async () => {
  const data = {
    nodes: [
      { name: 'HUB-A', type: 'site', isHub: true },
      { name: 'HUB-B', type: 'site', isHub: true },
      { name: 'DC-A1', type: 'dc', site: 'HUB-A' },
      { name: 'DC-B1', type: 'dc', site: 'HUB-B' }
    ],
    links: [
      { source: 'DC-A1', target: 'DC-B1', statusCode: 0 },
      { source: 'DC-B1', target: 'DC-A1', statusCode: 1 }
    ]
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  const opt = setOptionMock.mock.calls[0][0];
  const links = opt.series[0].links;
  expect(Array.isArray(links)).toBe(true);
  expect(links).toHaveLength(2);
  const okLink = links.find(l => l.target === 'DC-B1');
  const warnLink = links.find(l => l.target === 'DC-A1');
  expect(okLink.lineStyle.color).toBe('#22c55e');
  expect(okLink.symbol).toEqual(['none', 'arrow']);
  expect(warnLink.lineStyle.color).toBe('#eab308');
});

// S83-T9: cross-site edge label uses shortSite(source) → shortSite(dest).
test('S83: cross-site edge label uses source→dest site abbreviation', async () => {
  const data = {
    nodes: [
      { name: '核心站点', type: 'site', isHub: true },
      { name: '厦门站点', type: 'site', isHub: true },
      { name: 'MOCK-HUBADSRV1', type: 'dc', site: '核心站点' },
      { name: 'MOCK-XMADSRV1', type: 'dc', site: '厦门站点' }
    ],
    links: [{ source: 'MOCK-HUBADSRV1', target: 'MOCK-XMADSRV1', statusCode: 0 }]
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  const opt = setOptionMock.mock.calls[0][0];
  const link = opt.series[0].links[0];
  const text = link.edgeLabel.formatter({ data: link });
  expect(text).toMatch(/HUB/);
  expect(text).toMatch(/厦门/);
  expect(text).toMatch(/→/);
});

// S83-T10: intra-site edge uses ↔ 内 marker (preserved).
test('S83: intra-site edge label uses ↔ 内', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site' },
      { name: 'DC1', type: 'dc', site: 'A' },
      { name: 'DC2', type: 'dc', site: 'A' }
    ],
    links: [{ source: 'DC1', target: 'DC2', statusCode: 0 }]
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  const opt = setOptionMock.mock.calls[0][0];
  const link = opt.series[0].links[0];
  expect(link.edgeLabel.formatter({ data: link })).toMatch(/↔/);
});

// S83-T11: Hub↔Hub cross-site edge is bolder (R68 load-bearing layer).
test('S83: Hub↔Hub edge is bolder than Hub↔Spoke edge (R68 vocabulary)', async () => {
  const data = {
    nodes: [
      { name: 'HUB-A', type: 'site', isHub: true },
      { name: 'HUB-B', type: 'site', isHub: true },
      { name: 'SPOKE-C', type: 'site', isHub: false },
      { name: 'DC-HA', type: 'dc', site: 'HUB-A' },
      { name: 'DC-HB', type: 'dc', site: 'HUB-B' },
      { name: 'DC-SC', type: 'dc', site: 'SPOKE-C' }
    ],
    links: [
      { source: 'DC-HA', target: 'DC-HB', statusCode: 0 }, // hub-hub
      { source: 'DC-HA', target: 'DC-SC', statusCode: 0 }  // hub-spoke
    ]
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  const opt = setOptionMock.mock.calls[0][0];
  const hubHub = opt.series[0].links.find(l => l.target === 'DC-HB');
  const hubSpoke = opt.series[0].links.find(l => l.target === 'DC-SC');
  expect(hubHub.lineStyle.width).toBe(2.5);
  expect(hubSpoke.lineStyle.width).toBe(1.0);
  expect(hubHub.lineStyle.width).toBeGreaterThan(hubSpoke.lineStyle.width);
});

// S83-T12: Spoke↔Spoke cross-site edges are HIDDEN (Hub-Spoke compliance).
test('S83: Spoke↔Spoke cross-site edges are filtered out', async () => {
  const data = {
    nodes: [
      { name: 'SPOKE-A', type: 'site', isHub: false },
      { name: 'SPOKE-B', type: 'site', isHub: false },
      { name: 'DC-SA', type: 'dc', site: 'SPOKE-A' },
      { name: 'DC-SB', type: 'dc', site: 'SPOKE-B' }
    ],
    links: [{ source: 'DC-SA', target: 'DC-SB', statusCode: 0 }]
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  const opt = setOptionMock.mock.calls[0][0];
  expect(opt.series[0].links).toHaveLength(0);
});

// S83-T13: intra-site edges preserved regardless of isHub.
test('S83: intra-site edges are preserved regardless of isHub', async () => {
  const data = {
    nodes: [
      { name: 'SPOKE-A', type: 'site', isHub: false },
      { name: 'DC-1', type: 'dc', site: 'SPOKE-A' },
      { name: 'DC-2', type: 'dc', site: 'SPOKE-A' }
    ],
    links: [{ source: 'DC-1', target: 'DC-2', statusCode: 0 }]
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  const opt = setOptionMock.mock.calls[0][0];
  expect(opt.series[0].links).toHaveLength(1);
  expect(opt.series[0].links[0].edgeLabel.formatter({ data: opt.series[0].links[0] }))
    .toMatch(/↔/);
});

// S83-T14: tooltip for site node shows DC count + Hub/Spoke badge.
test('S83: tooltip for site node shows DC count + Hub/Spoke badge', async () => {
  const data = {
    nodes: [
      { name: 'HUB-A', type: 'site', isHub: true },
      { name: 'DC1', type: 'dc', site: 'HUB-A' },
      { name: 'DC2', type: 'dc', site: 'HUB-A' }
    ],
    links: []
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  const opt = setOptionMock.mock.calls[0][0];
  const siteNode = opt.series[0].data[0];
  const tip = opt.tooltip.formatter({ dataType: 'node', data: siteNode });
  expect(tip).toContain('HUB-A');
  expect(tip).toContain('(站点)');
  expect(tip).toContain('DC 数量: 2');
  expect(tip).toContain('承载层 Hub');
});

// S83-T15: tooltip for DC node shows site membership.
test('S83: tooltip for DC node shows site membership', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site', isHub: true },
      { name: 'DC1', type: 'dc', site: 'A' }
    ],
    links: []
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  const opt = setOptionMock.mock.calls[0][0];
  const dcNode = opt.series[0].data[0].children[0];
  const tip = opt.tooltip.formatter({ dataType: 'node', data: dcNode });
  expect(tip).toContain('DC1');
  expect(tip).toContain('(DC)');
  expect(tip).toContain('站点: A');
});

// S83-T16: legend lists sites (and 未分组 if orphan bucket exists).
test('S83: legend lists sites + orphan bucket when applicable', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site', isHub: true },
      { name: 'B', type: 'site', isHub: false },
      { name: 'DC1', type: 'dc', site: 'A' },
      { name: 'ORPHAN', type: 'dc' }
    ],
    links: []
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  const opt = setOptionMock.mock.calls[0][0];
  const legend = opt.legend[0].data;
  expect(legend).toContain('A');
  expect(legend).toContain('B');
  expect(legend).toContain('未分组');
});

// S83-T17: registers a chart.on(click) handler for the node drill-down modal.
test('S83: registers chart.on(click) handler for node drill-down', async () => {
  mount(TopologyChart, { props: { data: { nodes: [], links: [] } } });
  await flushPromises();
  const events = onMock.mock.calls.map(c => c[0]);
  expect(events).toContain('click');
});

// S83-T18: site click still opens R69 modal with Hub badge + DC list.
test('S83: clicking a site node opens modal with Hub badge + DC list', async () => {
  const data = {
    nodes: [
      { name: 'HUB-A', type: 'site', isHub: true },
      { name: 'SPOKE-B', type: 'site', isHub: false },
      { name: 'DC-1', type: 'dc', site: 'HUB-A', isBridgehead: true, isPdc: true },
      { name: 'DC-2', type: 'dc', site: 'HUB-A', isGc: true },
      { name: 'DC-S1', type: 'dc', site: 'SPOKE-B' }
    ],
    links: [
      { source: 'DC-1', target: 'DC-2', statusCode: 0 },
      { source: 'DC-1', target: 'DC-S1', statusCode: 1 }
    ]
  };
  const w = mount(TopologyChart, { props: { data } });
  await flushPromises();
  const handler = getClickHandler();
  expect(handler).toBeDefined();
  handler({ dataType: 'node', data: { name: 'HUB-A', type: 'site', isHub: true } });
  await flushPromises();
  const modal = w.find('[data-test="node-detail-modal"]');
  expect(modal.exists()).toBe(true);
  expect(w.find('[data-test="node-detail-title"]').text()).toBe('HUB-A');
  expect(w.find('[data-test="node-detail-meta"]').text()).toMatch(/承载层 Hub/);
  expect(w.find('[data-test="node-detail-meta"]').text()).toMatch(/2 DC/);
  const dcRows = w.findAll('[data-test="node-detail-dc-row"]');
  expect(dcRows).toHaveLength(2);
  expect(dcRows[0].text()).toContain('DC-1');
  expect(dcRows[0].text()).toContain('桥头');
  expect(dcRows[0].text()).toContain('主控');
  expect(dcRows[0].text()).toContain('2 复制伙伴');
});

// S83-T19: Spoke site click → modal meta shows 分支 Spoke + DC count.
test('S83: clicking a Spoke site shows 分支 Spoke badge', async () => {
  const data = {
    nodes: [
      { name: 'HUB-A', type: 'site', isHub: true },
      { name: 'SPOKE-B', type: 'site', isHub: false },
      { name: 'DC-1', type: 'dc', site: 'HUB-A' },
      { name: 'DC-S1', type: 'dc', site: 'SPOKE-B' }
    ],
    links: [{ source: 'DC-1', target: 'DC-S1', statusCode: 0 }]
  };
  const w = mount(TopologyChart, { props: { data } });
  await flushPromises();
  getClickHandler()({ dataType: 'node', data: { name: 'SPOKE-B', type: 'site', isHub: false } });
  await flushPromises();
  expect(w.find('[data-test="node-detail-meta"]').text()).toMatch(/分支 Spoke/);
  expect(w.find('[data-test="node-detail-meta"]').text()).toMatch(/1 DC/);
});

// S83-T20: DC node click still opens R69 modal.
test('S83: clicking a DC node opens modal with partner list', async () => {
  const data = {
    nodes: [
      { name: 'HUB-A', type: 'site', isHub: true },
      { name: 'HUB-B', type: 'site', isHub: true },
      { name: 'DC-A1', type: 'dc', site: 'HUB-A', isBridgehead: true },
      { name: 'DC-A2', type: 'dc', site: 'HUB-A' },
      { name: 'DC-B1', type: 'dc', site: 'HUB-B' }
    ],
    links: [
      { source: 'DC-A1', target: 'DC-A2', statusCode: 0 },
      { source: 'DC-A1', target: 'DC-B1', statusCode: 1 }
    ]
  };
  const w = mount(TopologyChart, { props: { data } });
  await flushPromises();
  getClickHandler()({ dataType: 'node', data: { name: 'DC-A1', type: 'dc', site: 'HUB-A', isBridgehead: true } });
  await flushPromises();
  expect(w.find('[data-test="node-detail-modal"]').exists()).toBe(true);
  expect(w.find('[data-test="node-detail-title"]').text()).toBe('DC-A1');
  expect(w.find('[data-test="node-detail-meta"]').text()).toMatch(/HUB-A/);
  expect(w.find('[data-test="node-detail-meta"]').text()).toMatch(/桥头/);
  const partners = w.findAll('[data-test="node-detail-partner"]');
  expect(partners).toHaveLength(2);
  expect(partners[0].text()).toContain('站内');
  expect(partners[0].text()).toContain('DC-A2');
  expect(partners[1].text()).toContain('出战');
  expect(partners[1].text()).toContain('DC-B1');
});

// S83-T21: close button dismisses the modal.
test('S83: close button dismisses the node modal', async () => {
  const data = {
    nodes: [
      { name: 'HUB-A', type: 'site', isHub: true },
      { name: 'DC-1', type: 'dc', site: 'HUB-A' }
    ],
    links: []
  };
  const w = mount(TopologyChart, { props: { data } });
  await flushPromises();
  getClickHandler()({ dataType: 'node', data: { name: 'HUB-A', type: 'site', isHub: true } });
  await flushPromises();
  expect(w.find('[data-test="node-detail-modal"]').exists()).toBe(true);
  await w.find('[data-test="node-detail-close"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="node-detail-modal"]').exists()).toBe(false);
});

// S83-T22: edge click is ignored by node handler.
test('S83: edge click does NOT open the node modal', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site', isHub: true },
      { name: 'DC1', type: 'dc', site: 'A' }
    ],
    links: [{ source: 'DC1', target: 'DC1', statusCode: 0 }]
  };
  const w = mount(TopologyChart, { props: { data } });
  await flushPromises();
  getClickHandler()({ dataType: 'edge', data: { source: 'DC1', target: 'DC1' } });
  await flushPromises();
  expect(w.find('[data-test="node-detail-modal"]').exists()).toBe(false);
});

// S83-T23: tree shape accepts tree-node { _type, _isHub, _site, children }
// passed directly from the ECharts click event (real click path).
test('S83: real ECharts click payload with _type / _site / _isHub opens modal', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site', isHub: true },
      { name: 'DC1', type: 'dc', site: 'A' }
    ],
    links: []
  };
  const w = mount(TopologyChart, { props: { data } });
  await flushPromises();
  getClickHandler()({
    dataType: 'node',
    data: { name: 'DC1', _type: 'dc', _site: 'A', children: [] }
  });
  await flushPromises();
  expect(w.find('[data-test="node-detail-modal"]').exists()).toBe(true);
  expect(w.find('[data-test="node-detail-title"]').text()).toBe('DC1');
  expect(w.find('[data-test="node-detail-meta"]').text()).toMatch(/A/);
});

// ────────────────────────────────────────────────────────────────────────
// R70 (preserved) — edge-click drill-down modal logic is independent of
// chart series type (the modal renders from fetched pair-history data).
// The handlers still register + fire from ECharts click events; tests
// dispatch directly so they pass even if the chart renders the edge.
// ────────────────────────────────────────────────────────────────────────

// R70: registers TWO click handlers (node + edge).
test('R70: registers TWO click handlers (node + edge)', async () => {
  mount(TopologyChart, { props: { data: { nodes: [], links: [] } } });
  await flushPromises();
  const clickEvents = onMock.mock.calls.filter(c => c[0] === 'click');
  expect(clickEvents.length).toBeGreaterThanOrEqual(2);
});

// R70: clicking an edge opens the edge-detail modal with source→dest title.
test('R70: clicking an edge opens modal with source → dest title', async () => {
  const data = {
    nodes: [
      { name: 'HUB-A', type: 'site', isHub: true },
      { name: 'HUB-B', type: 'site', isHub: true },
      { name: 'DC-A1', type: 'dc', site: 'HUB-A' },
      { name: 'DC-B1', type: 'dc', site: 'HUB-B' }
    ],
    links: [{ source: 'DC-A1', target: 'DC-B1', statusCode: 0 }]
  };
  const w = mount(TopologyChart, { props: { data } });
  await flushPromises();
  const handlers = getAllClickHandlers();
  handlers.forEach(h => h({ dataType: 'edge', data: { source: 'DC-A1', target: 'DC-B1' } }));
  await flushPromises();
  const modal = w.find('[data-test="edge-detail-modal"]');
  expect(modal.exists()).toBe(true);
  expect(w.find('[data-test="edge-detail-title"]').text()).toBe('DC-A1 → DC-B1');
  expect(w.find('[data-test="edge-detail-meta"]').text()).toContain('HUB-A');
  expect(w.find('[data-test="edge-detail-meta"]').text()).toContain('HUB-B');
});

// R70: intra-site edge → meta shows 站内 direction.
test('R70: clicking an intra-site edge shows 站内 direction', async () => {
  const data = {
    nodes: [
      { name: 'HUB-A', type: 'site', isHub: true },
      { name: 'DC-A1', type: 'dc', site: 'HUB-A' },
      { name: 'DC-A2', type: 'dc', site: 'HUB-A' }
    ],
    links: [{ source: 'DC-A1', target: 'DC-A2', statusCode: 0 }]
  };
  const w = mount(TopologyChart, { props: { data } });
  await flushPromises();
  getAllClickHandlers().forEach(h => h({ dataType: 'edge', data: { source: 'DC-A1', target: 'DC-A2' } }));
  await flushPromises();
  expect(w.find('[data-test="edge-detail-modal"]').exists()).toBe(true);
  expect(w.find('[data-test="edge-detail-meta"]').text()).toMatch(/站内/);
});

// R70: cross-site edge → meta shows 出战 direction.
test('R70: clicking a cross-site edge shows 出战 direction', async () => {
  const data = {
    nodes: [
      { name: 'HUB-A', type: 'site', isHub: true },
      { name: 'SPOKE-B', type: 'site', isHub: false },
      { name: 'DC-A1', type: 'dc', site: 'HUB-A' },
      { name: 'DC-B1', type: 'dc', site: 'SPOKE-B' }
    ],
    links: [{ source: 'DC-A1', target: 'DC-B1', statusCode: 0 }]
  };
  const w = mount(TopologyChart, { props: { data } });
  await flushPromises();
  getAllClickHandlers().forEach(h => h({ dataType: 'edge', data: { source: 'DC-A1', target: 'DC-B1' } }));
  await flushPromises();
  expect(w.find('[data-test="edge-detail-meta"]').text()).toMatch(/出战/);
});

// R70: edge click fetches history via getSiteReplicationMatrixPairHistory
// and renders the attempts table + summary.
test('R70: edge click lazy-fetches history and renders attempts + summary', async () => {
  getPairHistoryMock.mockResolvedValueOnce({
    data: {
      source: 'DC-A1', dest: 'DC-B1', limit: 10,
      entries: [
        { attemptAt: '2026-08-30T10:00:00Z', statusCode: 0,
          durationMs: 120, objectsTransferred: 5,
          lastSuccessTime: '2026-08-30T10:00:00Z', errorMessage: null },
        { attemptAt: '2026-08-30T09:55:00Z', statusCode: 1,
          durationMs: 80, objectsTransferred: 3,
          lastSuccessTime: '2026-08-30T09:00:00Z', errorMessage: 'partial replication' },
        { attemptAt: '2026-08-30T09:50:00Z', statusCode: 2,
          durationMs: null, objectsTransferred: null,
          lastSuccessTime: null, errorMessage: 'RPC server unavailable' }
      ]
    }
  });
  const data = {
    nodes: [
      { name: 'HUB-A', type: 'site', isHub: true },
      { name: 'HUB-B', type: 'site', isHub: true },
      { name: 'DC-A1', type: 'dc', site: 'HUB-A' },
      { name: 'DC-B1', type: 'dc', site: 'HUB-B' }
    ],
    links: [{ source: 'DC-A1', target: 'DC-B1', statusCode: 0 }]
  };
  const w = mount(TopologyChart, { props: { data } });
  await flushPromises();
  getAllClickHandlers().forEach(h => h({ dataType: 'edge', data: { source: 'DC-A1', target: 'DC-B1' } }));
  await flushPromises();
  expect(getPairHistoryMock).toHaveBeenCalledWith('DC-B1', 'DC-A1', 10);
  const summary = w.find('[data-test="edge-detail-summary"]');
  expect(summary.exists()).toBe(true);
  expect(summary.text()).toMatch(/24h 内 3/);
  expect(summary.text()).toMatch(/成功 1/);
  expect(summary.text()).toMatch(/部分失败 1/);
  expect(summary.text()).toMatch(/断开 1/);
  const rows = w.findAll('[data-test="edge-detail-attempt"]');
  expect(rows).toHaveLength(3);
  expect(rows[0].text()).toContain('成功');
  expect(rows[0].classes()).toContain('attempt-row-ok');
  expect(rows[1].text()).toContain('部分失败');
  expect(rows[1].classes()).toContain('attempt-row-warn');
  expect(rows[2].text()).toContain('断开/失败');
  expect(rows[2].classes()).toContain('attempt-row-err');
});

// R70: close button dismisses the edge modal.
test('R70: close button dismisses the edge modal', async () => {
  const data = {
    nodes: [
      { name: 'HUB-A', type: 'site', isHub: true },
      { name: 'DC-A1', type: 'dc', site: 'HUB-A' },
      { name: 'DC-A2', type: 'dc', site: 'HUB-A' }
    ],
    links: [{ source: 'DC-A1', target: 'DC-A2', statusCode: 0 }]
  };
  const w = mount(TopologyChart, { props: { data } });
  await flushPromises();
  getAllClickHandlers().forEach(h => h({ dataType: 'edge', data: { source: 'DC-A1', target: 'DC-A2' } }));
  await flushPromises();
  expect(w.find('[data-test="edge-detail-modal"]').exists()).toBe(true);
  await w.find('[data-test="edge-detail-close"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="edge-detail-modal"]').exists()).toBe(false);
});

// R70: node click opens ONLY the node modal — edge modal stays closed.
test('R70: node click does NOT open the edge modal (independence)', async () => {
  const data = {
    nodes: [
      { name: 'HUB-A', type: 'site', isHub: true },
      { name: 'DC-A1', type: 'dc', site: 'HUB-A' }
    ],
    links: [{ source: 'DC-A1', target: 'DC-A1', statusCode: 0 }]
  };
  const w = mount(TopologyChart, { props: { data } });
  await flushPromises();
  getAllClickHandlers().forEach(h => h({
    dataType: 'node',
    data: { name: 'HUB-A', type: 'site', isHub: true }
  }));
  await flushPromises();
  expect(w.find('[data-test="node-detail-modal"]').exists()).toBe(true);
  expect(w.find('[data-test="edge-detail-modal"]').exists()).toBe(false);
});

// ────────────────────────────────────────────────────────────────────────
// S83 foundational tests (regression for the previous graph+force chart)
// ────────────────────────────────────────────────────────────────────────

// S83: mounts ONE ECharts instance (single-chart layout preserved from R62).
test('S83: mounts ONE ECharts instance', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site', isHub: true },
      { name: 'B', type: 'site', isHub: true },
      { name: 'DC1', type: 'dc', site: 'A' },
      { name: 'DC2', type: 'dc', site: 'B' }
    ],
    links: [{ source: 'DC1', target: 'DC2', statusCode: 0 }]
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  expect(initMock).toHaveBeenCalledTimes(1);
  expect(setOptionMock).toHaveBeenCalledTimes(1);
});

// S83: renders single .topology-structure with chart div.
test('S83: renders single .topology-structure with chart', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site', isHub: true },
      { name: 'B', type: 'site', isHub: true },
      { name: 'DC1', type: 'dc', site: 'A' },
      { name: 'DC2', type: 'dc', site: 'B' }
    ],
    links: [{ source: 'DC1', target: 'DC2', statusCode: 0 }]
  };
  const w = mount(TopologyChart, { props: { data } });
  await flushPromises();
  const structures = w.findAll('[data-test="topology-structure"]');
  expect(structures).toHaveLength(1);
  expect(w.find('[data-test="topology-chart"]').exists()).toBe(true);
  // Old dual-panel selectors are gone.
  expect(w.find('[data-test="outbound-structure"]').exists()).toBe(false);
  expect(w.find('[data-test="inbound-structure"]').exists()).toBe(false);
});

// S83: empty data renders single chart with empty tree.
test('S83: empty data renders single chart with empty tree', async () => {
  mount(TopologyChart, { props: { data: { nodes: [], links: [] } } });
  await flushPromises();
  expect(initMock).toHaveBeenCalledTimes(1);
  const opt = setOptionMock.mock.calls[0][0];
  expect(opt.series[0].data).toEqual([]);
  expect(opt.series[0].links).toEqual([]);
});

// S83: color legend strip with 3 swatches is still rendered above the chart.
test('S83: color legend renders 3-color legend strip with ok/warn/err swatches', async () => {
  const w = mount(TopologyChart, { props: { data: { nodes: [], links: [] } } });
  await flushPromises();
  const legend = w.find('[data-test="color-legend"]');
  expect(legend.exists()).toBe(true);
  expect(legend.find('.swatch-ok').exists()).toBe(true);
  expect(legend.find('.swatch-warn').exists()).toBe(true);
  expect(legend.find('.swatch-err').exists()).toBe(true);
  expect(legend.text()).toMatch(/正常/);
  expect(legend.text()).toMatch(/部分失败/);
  expect(legend.text()).toMatch(/断开/);
});

// S83: data prop changes re-render the chart (regression for watch handler).
test('S83: prop change re-renders the chart', async () => {
  const data1 = {
    nodes: [
      { name: 'A', type: 'site', isHub: true },
      { name: 'DC1', type: 'dc', site: 'A' }
    ],
    links: []
  };
  const data2 = {
    nodes: [
      { name: 'A', type: 'site', isHub: true },
      { name: 'B', type: 'site' },
      { name: 'DC1', type: 'dc', site: 'A' },
      { name: 'DC2', type: 'dc', site: 'B' }
    ],
    links: [{ source: 'DC1', target: 'DC2', statusCode: 0 }]
  };
  const w = mount(TopologyChart, { props: { data: data1 } });
  await flushPromises();
  expect(setOptionMock).toHaveBeenCalledTimes(1);
  await w.setProps({ data: data2 });
  await flushPromises();
  expect(setOptionMock.mock.calls.length).toBeGreaterThanOrEqual(2);
});

// S83: prop change adds the new site to the tree.
test('S83: prop change updates the tree with the new site count', async () => {
  const data1 = {
    nodes: [
      { name: 'A', type: 'site', isHub: true },
      { name: 'DC1', type: 'dc', site: 'A' }
    ],
    links: []
  };
  const data2 = {
    nodes: [
      { name: 'A', type: 'site', isHub: true },
      { name: 'B', type: 'site' },
      { name: 'DC1', type: 'dc', site: 'A' },
      { name: 'DC2', type: 'dc', site: 'B' }
    ],
    links: []
  };
  const w = mount(TopologyChart, { props: { data: data1 } });
  await flushPromises();
  await w.setProps({ data: data2 });
  await flushPromises();
  const lastCall = setOptionMock.mock.calls[setOptionMock.mock.calls.length - 1][0];
  expect(lastCall.series[0].data).toHaveLength(2);
});

// S83: orphan bucket renders with dashed border to flag data-quality issue.
test('S83: orphan bucket renders with dashed border', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site', isHub: true },
      { name: 'ORPHAN', type: 'dc' }
    ],
    links: []
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  const opt = setOptionMock.mock.calls[0][0];
  const orphan = opt.series[0].data.find(b => b.name === '未分组');
  expect(orphan).toBeDefined();
  expect(orphan.itemStyle.borderType).toBe('dashed');
});

// S83: tooltip for orphan-bucket site mentions "孤立 DC 桶".
test('S83: tooltip for orphan bucket mentions 孤立 DC 桶', async () => {
  const data = {
    nodes: [
      { name: 'ORPHAN', type: 'dc' }
    ],
    links: []
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  const opt = setOptionMock.mock.calls[0][0];
  const orphanBranch = opt.series[0].data[0];
  const tip = opt.tooltip.formatter({ dataType: 'node', data: orphanBranch });
  expect(tip).toContain('未分组');
  expect(tip).toContain('孤立 DC 桶');
});
