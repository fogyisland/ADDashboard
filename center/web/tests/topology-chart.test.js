import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

// vi.mock factory is hoisted to top of file; reference hoisted vars to avoid TDZ errors.
const { setOptionMock, disposeMock, initMock } = vi.hoisted(() => {
  const setOptionMock = vi.fn();
  const disposeMock = vi.fn();
  const initMock = vi.fn(() => ({ setOption: setOptionMock, dispose: disposeMock }));
  return { setOptionMock, disposeMock, initMock };
});

vi.mock('echarts', () => ({
  default: { init: initMock },
  init: initMock
}));

import TopologyChart from '../src/components/TopologyChart.vue';

beforeEach(() => {
  setOptionMock.mockReset();
  disposeMock.mockReset();
  initMock.mockReset();
  initMock.mockImplementation(() => ({ setOption: setOptionMock, dispose: disposeMock }));
});

// 2026-08-29 round-62 (operator directive "复制拓扑去掉两个图表 集合成
// 一个图标"): the dual-panel layout (R59 outbound + inbound, R61
// horizontal side-by-side) collapses into ONE ECharts graph. Direction
// is conveyed by the arrow at each edge's target end. Lens-aware
// labels (R59) and the dual-panel structure are both gone.

// R62-T1: mounts a SINGLE ECharts instance (the dual-panel split is gone).
test('R62: mounts ONE ECharts instance, not two', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site' },
      { name: 'B', type: 'site' },
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
      { name: 'A', type: 'site' },
      { name: 'B', type: 'site' },
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
      { name: 'A', type: 'site' },
      { name: 'B', type: 'site' },
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
  expect(siteA.symbolSize).toBe(38);
  expect(siteA.mass).toBe(8);
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
      { name: '核心站点', type: 'site' },
      { name: '厦门站点', type: 'site' },
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
      { name: 'A', type: 'site' },
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
      { name: 'A', type: 'site' },
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
      { name: 'A', type: 'site' },
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
      { name: 'A', type: 'site' },
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
      { name: 'A', type: 'site' },
      { name: 'DC1', type: 'dc', site: 'A' }
    ],
    links: []
  };
  const data2 = {
    nodes: [
      { name: 'A', type: 'site' },
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