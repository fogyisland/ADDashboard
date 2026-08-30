import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

// vi.mock factory is hoisted to top of file; reference hoisted vars to avoid TDZ errors.
// R63: chart.on('finished', ...) + chart.convertToPixel(...) need mockable methods.
// R70: dashboardApi.getSiteReplicationMatrixPairHistory needs to be
// mockable for edge-click drill-down tests.
const { setOptionMock, disposeMock, initMock, onMock, convertToPixelMock, getPairHistoryMock } = vi.hoisted(() => {
  const setOptionMock = vi.fn();
  const disposeMock = vi.fn();
  const onMock = vi.fn();
  const convertToPixelMock = vi.fn();
  const getPairHistoryMock = vi.fn(() => Promise.resolve({ data: { entries: [] } }));
  const initMock = vi.fn(() => ({
    setOption: setOptionMock,
    dispose: disposeMock,
    on: onMock,
    convertToPixel: convertToPixelMock,
    resize: vi.fn()
  }));
  return { setOptionMock, disposeMock, initMock, onMock, convertToPixelMock, getPairHistoryMock };
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

// R63 helpers: capture the 'finished' handler and feed deterministic pixel coords.
function getFinishedHandler() {
  const call = onMock.mock.calls.find(c => c[0] === 'finished');
  return call ? call[1] : null;
}
// R69: capture the 'click' handler for the node drill-down modal.
function getClickHandler() {
  const call = onMock.mock.calls.find(c => c[0] === 'click');
  return call ? call[1] : null;
}
function setupPixelCoords(map) {
  convertToPixelMock.mockImplementation((find, dc) => {
    if (dc && dc.name && map[dc.name]) return map[dc.name];
    return [100, 100];
  });
}

beforeEach(() => {
  setOptionMock.mockReset();
  disposeMock.mockReset();
  initMock.mockReset();
  onMock.mockReset();
  convertToPixelMock.mockReset();
  getPairHistoryMock.mockReset();
  // Default pair-history response: empty entries (tests that need real
  // entries override per-call with mockResolvedValueOnce).
  getPairHistoryMock.mockResolvedValue({ data: { entries: [] } });
  initMock.mockImplementation(() => ({
    setOption: setOptionMock,
    dispose: disposeMock,
    on: onMock,
    convertToPixel: convertToPixelMock,
    resize: vi.fn()
  }));
});

// R70 helper: capture ALL 'click' handlers so tests can dispatch
// edge clicks separately from node clicks (R69 + R70 each register one).
function getAllClickHandlers() {
  return onMock.mock.calls.filter(c => c[0] === 'click').map(c => c[1]);
}

// 2026-08-29 round-62 (operator directive "复制拓扑去掉两个图表 集合成
// 一个图标"): the dual-panel layout (R59 outbound + inbound, R61
// horizontal side-by-side) collapses into ONE ECharts graph. Direction
// is conveyed by the arrow at each edge's target end. Lens-aware
// labels (R59) and the dual-panel structure are both gone.

// R62-T1: mounts a SINGLE ECharts instance (the dual-panel split is gone).
test('R62: mounts ONE ECharts instance, not two', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site', isHub: true },
      { name: 'B', type: 'site', isHub: true },
      { name: 'DC1', type: 'dc', site: 'A' },
      { name: 'DC2', type: 'dc', site: 'B' }
    ],
    links: [
      { source: 'DC1', target: 'DC2', statusCode: 0 },
      { source: 'DC2', target: 'DC1', statusCode: 0 }
    ]
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  expect(initMock).toHaveBeenCalledTimes(1);
  expect(setOptionMock).toHaveBeenCalledTimes(1);
});

// R62-T1: the single chart mounts a topology-structure with one chart div.
test('R62: renders single .topology-structure with chart', async () => {
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

// R62: site-as-parent category is preserved in the single canvas.
test('R62: single chart applies per-site category index (site-as-parent)', async () => {
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
  const opt = setOptionMock.mock.calls[0][0];
  const siteA = opt.series[0].data.find(n => n.name === 'A');
  const siteB = opt.series[0].data.find(n => n.name === 'B');
  const dc1 = opt.series[0].data.find(n => n.name === 'DC1');
  expect(siteA.category).toBe(0);
  // R68: Hub sites use bigger symbolSize (52) and heavier mass (12).
  expect(siteA.symbolSize).toBe(52);
  expect(siteA.mass).toBe(12);
  expect(siteB.category).toBe(1);
  expect(dc1.category).toBe(0);
  expect(dc1.symbolSize).toBe(16);
  expect(dc1.mass).toBe(1);
});

// R62: cross-site edge label uses HUB→XM (single unified convention;
// arrow direction conveys source→target, so no need for separate
// 入站 ← outbound → labels).
test('R62: cross-site edge label uses HUB→XM (single unified direction)', async () => {
  const data = {
    nodes: [
      { name: '核心站点', type: 'site', isHub: true },
      { name: '厦门站点', type: 'site', isHub: true },
      { name: 'MOCK-HUBADSRV1', type: 'dc', site: '核心站点' },
      { name: 'MOCK-XMADSRV1', type: 'dc', site: '厦门站点' }
    ],
    links: [{ source: 'MOCK-HUBADSRV1', target: 'MOCK-XMADSRV1', statusCode: 0 }]
  };
  const w = mount(TopologyChart, { props: { data } });
  await flushPromises();
  const opt = setOptionMock.mock.calls[0][0];
  const link = opt.series[0].links[0];
  const text = link.edgeLabel.formatter({ data: link });
  expect(text).toMatch(/HUB/);
  expect(text).toMatch(/厦门/);
  expect(text).toMatch(/→/);
  // Reverse edge — same convention.
  const reverseData = {
    nodes: data.nodes,
    links: [{ source: 'MOCK-XMADSRV1', target: 'MOCK-HUBADSRV1', statusCode: 0 }]
  };
  const w2 = mount(TopologyChart, { props: { data: reverseData } });
  await flushPromises();
  const opt2 = setOptionMock.mock.calls[setOptionMock.mock.calls.length - 1][0];
  const revLink = opt2.series[0].links[0];
  const revText = revLink.edgeLabel.formatter({ data: revLink });
  expect(revText).toMatch(/→/);
});

// R62: intra-site edge still uses ↔ 内 marker.
test('R62: intra-site edge label uses ↔ 内', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site' },
      { name: 'DC1', type: 'dc', site: 'A' },
      { name: 'DC2', type: 'dc', site: 'A' }
    ],
    links: [{ source: 'DC1', target: 'DC2', statusCode: 0 }]
  };
  const w = mount(TopologyChart, { props: { data } });
  await flushPromises();
  const opt = setOptionMock.mock.calls[0][0];
  const link = opt.series[0].links[0];
  expect(link.edgeLabel.formatter({ data: link })).toMatch(/↔/);
});

// R62: edges have arrow at target (direction preserved).
test('R62: edges put arrow at target + green OK color', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site', isHub: true },
      { name: 'B', type: 'site' },
      { name: 'DC1', type: 'dc', site: 'A' },
      { name: 'DC2', type: 'dc', site: 'B' }
    ],
    links: [{ source: 'DC1', target: 'DC2', statusCode: 0 }]
  };
  const w = mount(TopologyChart, { props: { data } });
  await flushPromises();
  const opt = setOptionMock.mock.calls[0][0];
  const link = opt.series[0].links[0];
  expect(link.symbol).toEqual(['none', 'arrow']);
  expect(link.lineStyle.color).toBe('#22c55e');
});

// R62: partial-failure edges are YELLOW (R61 vocabulary preserved).
test('R62: partial-failure link (statusCode 1) is yellow', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site', isHub: true },
      { name: 'B', type: 'site' },
      { name: 'DC1', type: 'dc', site: 'A' },
      { name: 'DC2', type: 'dc', site: 'B' }
    ],
    links: [{ source: 'DC1', target: 'DC2', statusCode: 1 }]
  };
  const w = mount(TopologyChart, { props: { data } });
  await flushPromises();
  const opt = setOptionMock.mock.calls[0][0];
  expect(opt.series[0].links[0].lineStyle.color).toBe('#eab308');
});

// R62: failure edges (statusCode 2+) are RED.
test('R62: failure link (statusCode 2+) is red', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site', isHub: true },
      { name: 'B', type: 'site' },
      { name: 'DC1', type: 'dc', site: 'A' },
      { name: 'DC2', type: 'dc', site: 'B' }
    ],
    links: [{ source: 'DC1', target: 'DC2', statusCode: 2 }]
  };
  const w = mount(TopologyChart, { props: { data } });
  await flushPromises();
  const opt = setOptionMock.mock.calls[0][0];
  expect(opt.series[0].links[0].lineStyle.color).toBe('#ef4444');
});

// R62: tooltip status word matches the 3 edge colors (no longer mentions
// "出战" / "入站" lens — there is only one chart now).
test('R62: tooltip status word matches the 3 edge colors; no lens mention', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site', isHub: true },
      { name: 'B', type: 'site' },
      { name: 'DC1', type: 'dc', site: 'A' },
      { name: 'DC2', type: 'dc', site: 'B' }
    ],
    links: [{ source: 'DC1', target: 'DC2', statusCode: 0 }]
  };
  const w = mount(TopologyChart, { props: { data } });
  await flushPromises();
  const opt = setOptionMock.mock.calls[0][0];
  const tipOK = opt.tooltip.formatter({
    dataType: 'edge', data: { source: 'X', target: 'Y', lineStyle: { color: '#22c55e' } }
  });
  expect(tipOK).toContain('复制成功');
  expect(tipOK).not.toContain('出战');
  expect(tipOK).not.toContain('入站');
  const tipWarn = opt.tooltip.formatter({
    dataType: 'edge', data: { source: 'X', target: 'Y', lineStyle: { color: '#eab308' } }
  });
  expect(tipWarn).toContain('部分失败');
  const tipErr = opt.tooltip.formatter({
    dataType: 'edge', data: { source: 'X', target: 'Y', lineStyle: { color: '#ef4444' } }
  });
  expect(tipErr).toContain('失败');
});

// R62: empty data renders the single chart with empty arrays.
test('R62: empty data renders single chart with empty arrays', async () => {
  mount(TopologyChart, { props: { data: { nodes: [], links: [] } } });
  await flushPromises();
  expect(initMock).toHaveBeenCalledTimes(1);
  const opt = setOptionMock.mock.calls[0][0];
  expect(opt.series[0].data).toEqual([]);
  expect(opt.series[0].links).toEqual([]);
});

// R62: color legend strip with 3 swatches is still rendered above the chart.
test('R62: color legend renders 3-color legend strip with ok/warn/err swatches', async () => {
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

// R62: data prop changes re-render the chart (regression for watch handler).
test('R62: prop change re-renders the chart', async () => {
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

// ────────────────────────────────────────────────────────────────────────
// 2026-08-29 round-63 (operator "服务器和站点的关系可以这样绘制"):
// draw site bounding boxes around each site's DCs using ECharts graphic
// component. After 'finished' fires, each site gets a rounded rect with
// site-palette stroke + a bold site-name header text.
// ────────────────────────────────────────────────────────────────────────

// R63: registers chart.on('finished') so the box renderer hooks into
// the post-layout tick.
test('R63: registers chart.on(finished) handler for box rendering', async () => {
  mount(TopologyChart, { props: { data: { nodes: [], links: [] } } });
  await flushPromises();
  const events = onMock.mock.calls.map(c => c[0]);
  expect(events).toContain('finished');
});

// R63: one site with 2 DCs produces ONE bounding box (group of rect + text).
test('R63: one site with 2 DCs produces one bounding box', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site' },
      { name: 'DC1', type: 'dc', site: 'A' },
      { name: 'DC2', type: 'dc', site: 'A' }
    ],
    links: []
  };
  setupPixelCoords({ 'DC1': [200, 200], 'DC2': [300, 250] });
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  const handler = getFinishedHandler();
  expect(handler).toBeDefined();
  handler();
  await flushPromises();

  const withGraphic = setOptionMock.mock.calls
    .map(c => c[0])
    .find(opt => opt.graphic && Array.isArray(opt.graphic) && opt.graphic.length > 0);
  expect(withGraphic).toBeDefined();
  expect(withGraphic.graphic).toHaveLength(1);
  const group = withGraphic.graphic[0];
  expect(group.type).toBe('group');
  expect(group.silent).toBe(true);
  expect(group.z).toBe(-1);
  expect(group.children).toHaveLength(2);
  expect(group.children[0].type).toBe('rect');
  expect(group.children[1].type).toBe('text');
  expect(group.children[1].style.text).toBe('A');
});

// R63: rect shape is rounded (r > 0), dashed border, and encloses both DCs.
test('R63: bounding box is rounded with dashed border enclosing the DCs', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site' },
      { name: 'DC1', type: 'dc', site: 'A' },
      { name: 'DC2', type: 'dc', site: 'A' }
    ],
    links: []
  };
  setupPixelCoords({ 'DC1': [200, 200], 'DC2': [300, 250] });
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  getFinishedHandler()();
  await flushPromises();

  const withGraphic = setOptionMock.mock.calls
    .map(c => c[0])
    .find(opt => opt.graphic && Array.isArray(opt.graphic) && opt.graphic.length > 0);
  const rect = withGraphic.graphic[0].children[0];
  expect(rect.shape.r).toBeGreaterThan(0);
  expect(rect.style.lineDash).toEqual([6, 6]);
  expect(rect.style.lineWidth).toBeGreaterThan(0);
  // Box width/height positive (encloses both DCs)
  expect(rect.shape.width).toBeGreaterThan(0);
  expect(rect.shape.height).toBeGreaterThan(0);
});

// R63: two sites → two bounding boxes (one per site, with distinct headers).
test('R63: two sites produce two bounding boxes', async () => {
  const data = {
    nodes: [
      { name: '核心站点', type: 'site' },
      { name: '厦门站点', type: 'site' },
      { name: 'DC1', type: 'dc', site: '核心站点' },
      { name: 'DC2', type: 'dc', site: '厦门站点' }
    ],
    links: []
  };
  setupPixelCoords({ 'DC1': [200, 200], 'DC2': [500, 250] });
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  getFinishedHandler()();
  await flushPromises();

  const withGraphic = setOptionMock.mock.calls
    .map(c => c[0])
    .find(opt => opt.graphic && Array.isArray(opt.graphic) && opt.graphic.length === 2);
  expect(withGraphic).toBeDefined();
  const siteNames = withGraphic.graphic.map(g => g.children[1].style.text);
  expect(siteNames).toContain('核心站点');
  expect(siteNames).toContain('厦门站点');
});

// R63: empty data → setOption({ graphic: [] }) to clear any prior boxes.
test('R63: empty data clears the graphic (no boxes drawn)', async () => {
  mount(TopologyChart, { props: { data: { nodes: [], links: [] } } });
  await flushPromises();
  getFinishedHandler()();
  await flushPromises();
  const withGraphic = setOptionMock.mock.calls
    .map(c => c[0])
    .find(opt => opt.graphic !== undefined);
  expect(withGraphic).toBeDefined();
  expect(withGraphic.graphic).toEqual([]);
});

// R63: box stroke color matches the SITE_PALETTE entry for that site
// (核心站点 = siteOrder[0] = SITE_PALETTE[0] = '#38bdf8').
test('R63: box color matches site palette entry', async () => {
  const data = {
    nodes: [
      { name: '核心站点', type: 'site' },
      { name: 'DC1', type: 'dc', site: '核心站点' }
    ],
    links: []
  };
  setupPixelCoords({ 'DC1': [200, 200] });
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  getFinishedHandler()();
  await flushPromises();
  const withGraphic = setOptionMock.mock.calls
    .map(c => c[0])
    .find(opt => opt.graphic && Array.isArray(opt.graphic) && opt.graphic.length > 0);
  const rect = withGraphic.graphic[0].children[0];
  const text = withGraphic.graphic[0].children[1];
  expect(rect.style.stroke).toBe('#38bdf8');
  expect(rect.style.fill).toMatch(/rgba\(56,\s*189,\s*248,\s*0\.08\)/);
  expect(text.style.fill).toBe('#38bdf8');
});

// R63: second site uses its own palette color (different from first).
test('R63: distinct sites use distinct palette colors', async () => {
  const data = {
    nodes: [
      { name: '核心站点', type: 'site' },
      { name: '厦门站点', type: 'site' },
      { name: 'DC1', type: 'dc', site: '核心站点' },
      { name: 'DC2', type: 'dc', site: '厦门站点' }
    ],
    links: []
  };
  setupPixelCoords({ 'DC1': [200, 200], 'DC2': [500, 250] });
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  getFinishedHandler()();
  await flushPromises();
  const withGraphic = setOptionMock.mock.calls
    .map(c => c[0])
    .find(opt => opt.graphic && Array.isArray(opt.graphic) && opt.graphic.length === 2);
  const strokes = withGraphic.graphic.map(g => g.children[0].style.stroke);
  expect(strokes).toContain('#38bdf8'); // 核心站点
  expect(strokes).toContain('#a78bfa'); // 厦门站点 = SITE_PALETTE[1]
});

// R63: convertToPixel is called once per DC (not per site, not per all nodes).
test('R63: convertToPixel is called once per DC', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site', isHub: true },
      { name: 'B', type: 'site' },
      { name: 'DC1', type: 'dc', site: 'A' },
      { name: 'DC2', type: 'dc', site: 'A' },
      { name: 'DC3', type: 'dc', site: 'B' }
    ],
    links: []
  };
  setupPixelCoords({ 'DC1': [200, 200], 'DC2': [300, 250], 'DC3': [500, 200] });
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  convertToPixelMock.mockClear();
  getFinishedHandler()();
  await flushPromises();
  expect(convertToPixelMock).toHaveBeenCalledTimes(3);
});

// R63: when data prop changes, the boxes are re-rendered with the new
// site count (not stale from the previous mount).
test('R63: prop change re-renders boxes with the new site count', async () => {
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
  setupPixelCoords({ 'DC1': [200, 200], 'DC2': [500, 250] });
  const w = mount(TopologyChart, { props: { data: data1 } });
  await flushPromises();
  getFinishedHandler()();
  await flushPromises();
  await w.setProps({ data: data2 });
  await flushPromises();
  getFinishedHandler()();
  await flushPromises();

  const callsWithGraphic = setOptionMock.mock.calls
    .map(c => c[0])
    .filter(opt => opt.graphic && Array.isArray(opt.graphic));
  expect(callsWithGraphic.length).toBeGreaterThanOrEqual(2);
  // First box render: 1 site
  expect(callsWithGraphic[0].graphic).toHaveLength(1);
  // Latest box render: 2 sites
  expect(callsWithGraphic[callsWithGraphic.length - 1].graphic).toHaveLength(2);
});

// R63: 'finished' firing twice without data change does NOT re-render boxes
// (feedback loop guard via lastBoxDataKey).
test('R63: re-firing finished without data change does not redraw boxes', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site' },
      { name: 'DC1', type: 'dc', site: 'A' }
    ],
    links: []
  };
  setupPixelCoords({ 'DC1': [200, 200] });
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  const handler = getFinishedHandler();
  handler();
  await flushPromises();
  const countAfter1 = setOptionMock.mock.calls
    .filter(c => c[0].graphic !== undefined).length;
  // Fire again — same data, should be a no-op
  handler();
  await flushPromises();
  const countAfter2 = setOptionMock.mock.calls
    .filter(c => c[0].graphic !== undefined).length;
  expect(countAfter2).toBe(countAfter1);
});

// ────────────────────────────────────────────────────────────────────────
// 2026-08-30 round-68 (Hub-Spoke architecture redesign for 40 DC / 20
// site scale): site nodes carry an `isHub` flag from the backend. Hub
// sites render bigger/golder with bolder edges; Spoke sites are smaller
// and faded; Spoke-Spoke cross-site edges are hidden by default
// (designed absence — Hub-Spoke compliance).
// ────────────────────────────────────────────────────────────────────────

// R68: Hub site renders bigger and gold (load-bearing layer).
test('R68: Hub site node is bigger + gold + bold border', async () => {
  const data = {
    nodes: [
      { name: 'HUB-A', type: 'site', isHub: true },
      { name: 'SPOKE-B', type: 'site', isHub: false },
      { name: 'DC-H1', type: 'dc', site: 'HUB-A' },
      { name: 'DC-S1', type: 'dc', site: 'SPOKE-B' }
    ],
    links: [{ source: 'DC-H1', target: 'DC-S1', statusCode: 0 }]
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  const opt = setOptionMock.mock.calls[0][0];
  const hubNode = opt.series[0].data.find(n => n.name === 'HUB-A');
  const spokeNode = opt.series[0].data.find(n => n.name === 'SPOKE-B');
  // Hub: bigger, gold, bold border
  expect(hubNode.symbolSize).toBeGreaterThan(spokeNode.symbolSize);
  expect(hubNode.itemStyle.color).toBe('#fbbf24');
  expect(hubNode.itemStyle.borderWidth).toBeGreaterThanOrEqual(2);
  expect(hubNode.label.fontWeight).toBeGreaterThanOrEqual(700);
  // Spoke: smaller, faded
  expect(spokeNode.itemStyle.color).toBe('#94a3b8');
});

// R68: Hub site mass is heavier than Spoke site (anchors the layout).
test('R68: Hub site has higher mass than Spoke site', async () => {
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
  const hub = opt.series[0].data.find(n => n.name === 'HUB-A');
  const spoke = opt.series[0].data.find(n => n.name === 'SPOKE-B');
  expect(hub.mass).toBeGreaterThan(spoke.mass);
});

// R68: backward-compat — site nodes WITHOUT isHub fall back to Spoke styling.
test('R68: site without isHub flag defaults to Spoke (smaller, faded)', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site' }, // no isHub
      { name: 'DC1', type: 'dc', site: 'A' }
    ],
    links: []
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  const opt = setOptionMock.mock.calls[0][0];
  const node = opt.series[0].data.find(n => n.name === 'A');
  expect(node._isHub).toBe(false);
  expect(node.symbolSize).toBe(32);
  expect(node.itemStyle.color).toBe('#94a3b8');
});

// R68: Hub↔Hub cross-site edge renders BOLDER (load-bearing layer).
test('R68: Hub↔Hub edge is bolder than Hub↔Spoke edge', async () => {
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

// R68: Spoke↔Spoke cross-site edges are HIDDEN (Hub-Spoke compliance —
// KCC should never produce these; the view filters them defensively).
test('R68: Spoke↔Spoke cross-site edges are filtered out (designed absence)', async () => {
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

// R68: intra-site edges (within same site) are NOT filtered regardless
// of isHub — they stay visible as the "站点内" replication layer.
test('R68: intra-site edges are preserved regardless of isHub', async () => {
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

// ────────────────────────────────────────────────────────────────────────
// 2026-08-30 round-69 (operator: "你来定" → TopologyChart 节点钻取):
// clicking a site or DC node opens a local modal with the node's detail.
// Modal derives from props.data (no new backend endpoint).
// ────────────────────────────────────────────────────────────────────────

// R69: chart.on('click') is registered alongside 'finished'.
test('R69: registers chart.on(click) handler for node drill-down', async () => {
  mount(TopologyChart, { props: { data: { nodes: [], links: [] } } });
  await flushPromises();
  const events = onMock.mock.calls.map(c => c[0]);
  expect(events).toContain('click');
});

// R69: click a site node → modal renders with Hub badge + DC list + partner counts.
test('R69: clicking a site node opens modal with Hub badge + DC list', async () => {
  const data = {
    nodes: [
      { name: 'HUB-A', type: 'site', isHub: true },
      { name: 'SPOKE-B', type: 'site', isHub: false },
      { name: 'DC-1', type: 'dc', site: 'HUB-A', isBridgehead: true, isPdc: true },
      { name: 'DC-2', type: 'dc', site: 'HUB-A', isGc: true },
      { name: 'DC-S1', type: 'dc', site: 'SPOKE-B' }
    ],
    links: [
      { source: 'DC-1', target: 'DC-2', statusCode: 0 }, // intra
      { source: 'DC-1', target: 'DC-S1', statusCode: 1 } // cross
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
  // First DC row should show DC-1 + 桥头 badge
  expect(dcRows[0].text()).toContain('DC-1');
  expect(dcRows[0].text()).toContain('桥头');
  expect(dcRows[0].text()).toContain('主控');
  expect(dcRows[0].text()).toContain('2 复制伙伴'); // DC-1 has 2 links
});

// R69: click a Spoke site → meta shows 分支 + 1 DC.
test('R69: clicking a Spoke site shows 分支 Spoke badge', async () => {
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

// R69: click a DC node → modal shows the DC's partners (intra/out/in).
test('R69: clicking a DC node opens modal with partner list', async () => {
  const data = {
    nodes: [
      { name: 'HUB-A', type: 'site', isHub: true },
      { name: 'HUB-B', type: 'site', isHub: true },
      { name: 'DC-A1', type: 'dc', site: 'HUB-A', isBridgehead: true },
      { name: 'DC-A2', type: 'dc', site: 'HUB-A' },
      { name: 'DC-B1', type: 'dc', site: 'HUB-B' }
    ],
    links: [
      { source: 'DC-A1', target: 'DC-A2', statusCode: 0 }, // intra (both HUB-A)
      { source: 'DC-A1', target: 'DC-B1', statusCode: 1 }  // cross
    ]
  };
  const w = mount(TopologyChart, { props: { data } });
  await flushPromises();
  getClickHandler()({ dataType: 'node', data: { name: 'DC-A1', type: 'dc', site: 'HUB-A', isBridgehead: true } });
  await flushPromises();
  const modal = w.find('[data-test="node-detail-modal"]');
  expect(modal.exists()).toBe(true);
  expect(w.find('[data-test="node-detail-title"]').text()).toBe('DC-A1');
  expect(w.find('[data-test="node-detail-meta"]').text()).toMatch(/HUB-A/);
  expect(w.find('[data-test="node-detail-meta"]').text()).toMatch(/桥头/);
  // No DC list for DC node (only sites show their DCs)
  expect(w.findAll('[data-test="node-detail-dc-row"]')).toHaveLength(0);
  // 2 partners: DC-A2 (intra) + DC-B1 (out)
  const partners = w.findAll('[data-test="node-detail-partner"]');
  expect(partners).toHaveLength(2);
  // intra partner should be sorted first
  expect(partners[0].text()).toContain('站内');
  expect(partners[0].text()).toContain('DC-A2');
  expect(partners[1].text()).toContain('出战');
  expect(partners[1].text()).toContain('DC-B1');
});

// R69: close button resets clickedNode (modal disappears).
test('R69: close button dismisses the modal', async () => {
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

// R69: edge click is ignored (v1 only handles node drill-down).
test('R69: edge click does NOT open the modal', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site', isHub: true },
      { name: 'DC1', type: 'dc', site: 'A' }
    ],
    links: [{ source: 'DC1', target: 'DC1', statusCode: 0 }] // self-link edge
  };
  const w = mount(TopologyChart, { props: { data } });
  await flushPromises();
  getClickHandler()({ dataType: 'edge', data: { source: 'DC1', target: 'DC1' } });
  await flushPromises();
  expect(w.find('[data-test="node-detail-modal"]').exists()).toBe(false);
});

// ────────────────────────────────────────────────────────────────────────
// 2026-08-30 round-70 (continuation of R69 drillability):
// clicking an EDGE opens a separate modal showing the pair's last 10
// replication attempts (per R45's `/pair-history` endpoint). Independent
// of the node-detail modal — only one drill-down surface open at a time.
// ────────────────────────────────────────────────────────────────────────

// R70: registers BOTH a node click handler (R69) and an edge click
// handler. Both handlers early-return on the wrong dataType, so the
// double registration is safe.
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
  // Dispatch to ALL click handlers (mirrors ECharts behavior).
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
    links: [{ source: 'DC-A1', target: 'DC-A2', statusCode: 0 }] // intra-site
  };
  const w = mount(TopologyChart, { props: { data } });
  await flushPromises();
  getAllClickHandlers().forEach(h => h({ dataType: 'edge', data: { source: 'DC-A1', target: 'DC-A2' } }));
  await flushPromises();
  expect(w.find('[data-test="edge-detail-modal"]').exists()).toBe(true);
  expect(w.find('[data-test="edge-detail-meta"]').text()).toMatch(/站内/);
});

// R70: cross-site edge → meta shows 出战 direction (source DC reports outbound).
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
  // API client was called with (destDc='DC-B1', sourceDc='DC-A1', limit=10)
  expect(getPairHistoryMock).toHaveBeenCalledWith('DC-B1', 'DC-A1', 10);
  // Summary line: 24h 内 3 · 成功 1 · 部分失败 1 · 断开 1
  const summary = w.find('[data-test="edge-detail-summary"]');
  expect(summary.exists()).toBe(true);
  expect(summary.text()).toMatch(/24h 内 3/);
  expect(summary.text()).toMatch(/成功 1/);
  expect(summary.text()).toMatch(/部分失败 1/);
  expect(summary.text()).toMatch(/断开 1/);
  // 3 attempt rows
  const rows = w.findAll('[data-test="edge-detail-attempt"]');
  expect(rows).toHaveLength(3);
  expect(rows[0].text()).toContain('成功');
  expect(rows[0].classes()).toContain('attempt-row-ok');
  expect(rows[1].text()).toContain('部分失败');
  expect(rows[1].classes()).toContain('attempt-row-warn');
  expect(rows[2].text()).toContain('断开/失败');
  expect(rows[2].classes()).toContain('attempt-row-err');
});

// R70: close button resets clickedEdge (modal disappears).
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

// R70: clicking a node opens ONLY the node modal — edge modal stays closed.
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
  // Dispatch a NODE click to all click handlers (mirrors ECharts).
  getAllClickHandlers().forEach(h => h({
    dataType: 'node',
    data: { name: 'HUB-A', type: 'site', isHub: true }
  }));
  await flushPromises();
  expect(w.find('[data-test="node-detail-modal"]').exists()).toBe(true);
  expect(w.find('[data-test="edge-detail-modal"]').exists()).toBe(false);
});