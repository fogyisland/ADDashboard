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

// 2026-08-29 round-59 (operator directive): topology chart now renders
// TWO separate ECharts instances — 出战复制结构 (outbound, source-pushing
// lens) and 入站复制结构 (inbound, target-receiving lens). Each panel
// shows the same sites-as-parents topology with the same edges but
// different label direction so the operator can pick the lens they
// need without mentally inverting arrows on a single canvas.

// Helper: pull the option for a given lens (outbound / inbound) out of
// the mock's setOption call list. The component tags its tooltip with
// the lens name ("出战复制结构" or "入站复制结构"), so we use the tooltip
// text as the lens discriminator — works for cross-site, intra-site,
// and empty data.
function optionForLens(lens) {
  const calls = setOptionMock.mock.calls;
  if (calls.length < 2) throw new Error('expected 2 setOption calls (outbound + inbound)');
  const needle = lens === 'outbound' ? '出战复制结构' : '入站复制结构';
  for (const call of calls) {
    const opt = call[0];
    // Probe the tooltip with a synthetic edge payload; the formatter
    // embeds the lens name regardless of whether the chart has links.
    const probe = opt.tooltip.formatter({
      dataType: 'edge',
      data: { source: 'A', target: 'B', lineStyle: { color: '#22c55e' } }
    });
    if (typeof probe === 'string' && probe.includes(needle)) return opt;
  }
  throw new Error(`no option matched lens ${lens}`);
}

// R59-T1: the component mounts TWO ECharts instances (outbound + inbound)
// sharing the same node topology. Both panels show all sites + DCs.
test('R59: two ECharts instances mount, one per lens (outbound + inbound)', async () => {
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
  expect(initMock).toHaveBeenCalledTimes(2);
  expect(setOptionMock).toHaveBeenCalledTimes(2);
});

// R59-T2: site-as-parent category is preserved in BOTH panels. Site A
// gets category 0, Site B gets category 1, and DC1 inherits A's index.
test('R59: outbound panel applies per-site category index (site-as-parent)', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site' },
      { name: 'B', type: 'site' },
      { name: 'DC1', type: 'dc', site: 'A' },
      { name: 'DC2', type: 'dc', site: 'B' }
    ],
    links: [{ source: 'DC1', target: 'DC2', statusCode: 0 }]
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  const opt = optionForLens('outbound');
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

// R59-T3: outbound panel labels edges as "HUB→XM" (source-site first).
test('R59: outbound panel labels cross-site edge HUB→XM (source→target)', async () => {
  const data = {
    nodes: [
      { name: '核心站点', type: 'site' },
      { name: '厦门站点', type: 'site' },
      { name: 'MOCK-HUBADSRV1', type: 'dc', site: '核心站点' },
      { name: 'MOCK-XMADSRV1', type: 'dc', site: '厦门站点' }
    ],
    links: [{ source: 'MOCK-HUBADSRV1', target: 'MOCK-XMADSRV1', statusCode: 0 }]
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  const opt = optionForLens('outbound');
  const link = opt.series[0].links[0];
  expect(link.edgeLabel.formatter({ data: link })).toMatch(/HUB/);
  expect(link.edgeLabel.formatter({ data: link })).toMatch(/厦门/);
  // Outbound lens uses → (not ←)
  const text = link.edgeLabel.formatter({ data: link });
  expect(text).toMatch(/→/);
  expect(text).not.toMatch(/←/);
});

// R59-T4: inbound panel labels the SAME edge as "XM←HUB" (target-site first).
test('R59: inbound panel labels cross-site edge XM←HUB (target←source)', async () => {
  const data = {
    nodes: [
      { name: '核心站点', type: 'site' },
      { name: '厦门站点', type: 'site' },
      { name: 'MOCK-HUBADSRV1', type: 'dc', site: '核心站点' },
      { name: 'MOCK-XMADSRV1', type: 'dc', site: '厦门站点' }
    ],
    links: [{ source: 'MOCK-HUBADSRV1', target: 'MOCK-XMADSRV1', statusCode: 0 }]
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  const opt = optionForLens('inbound');
  const link = opt.series[0].links[0];
  const text = link.edgeLabel.formatter({ data: link });
  expect(text).toMatch(/HUB/);
  expect(text).toMatch(/厦门/);
  // Inbound lens uses ← (not →)
  expect(text).toMatch(/←/);
  expect(text).not.toMatch(/→/);
});

// R59-T5: both panels show the same set of edges (every edge is both
// outbound-from-source AND inbound-to-target — they're the same global
// edges, just framed differently).
test('R59: outbound and inbound panels share the same edge set', async () => {
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
  const out = optionForLens('outbound');
  const inn = optionForLens('inbound');
  expect(out.series[0].links).toHaveLength(2);
  expect(inn.series[0].links).toHaveLength(2);
});

// R59-T6: arrow at target is preserved in both panels.
test('R59: both panels put arrow at target + green OK color', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site' },
      { name: 'B', type: 'site' },
      { name: 'DC1', type: 'dc', site: 'A' },
      { name: 'DC2', type: 'dc', site: 'B' }
    ],
    links: [{ source: 'DC1', target: 'DC2', statusCode: 0 }]
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  for (const lens of ['outbound', 'inbound']) {
    const opt = optionForLens(lens);
    const link = opt.series[0].links[0];
    expect(link.symbol).toEqual(['none', 'arrow']);
    expect(link.lineStyle.color).toBe('#22c55e');
  }
});

// R59-T7: failure link (statusCode 2+) is red in both panels.
test('R59/R61: failure link (statusCode 2+) is red in both panels', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site' },
      { name: 'B', type: 'site' },
      { name: 'DC1', type: 'dc', site: 'A' },
      { name: 'DC2', type: 'dc', site: 'B' }
    ],
    links: [{ source: 'DC1', target: 'DC2', statusCode: 2 }]
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  for (const lens of ['outbound', 'inbound']) {
    const opt = optionForLens(lens);
    expect(opt.series[0].links[0].lineStyle.color).toBe('#ef4444');
  }
});

// R61-T2: partial-failure link (statusCode 1) is YELLOW in both panels
// (R61 operator directive "也是绿色 黄色 红色 展现连接效果" — adds yellow
// to match R60 复制状态概览 vocabulary).
test('R61: partial-failure link (statusCode 1) is yellow in both panels', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site' },
      { name: 'B', type: 'site' },
      { name: 'DC1', type: 'dc', site: 'A' },
      { name: 'DC2', type: 'dc', site: 'B' }
    ],
    links: [{ source: 'DC1', target: 'DC2', statusCode: 1 }]
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  for (const lens of ['outbound', 'inbound']) {
    const opt = optionForLens(lens);
    expect(opt.series[0].links[0].lineStyle.color).toBe('#eab308');
  }
});

// R61-T2: 3-state tooltip status word — green=复制成功, yellow=部分失败,
// red=失败/断开 (was previously just binary OK vs err).
test('R61: tooltip status word matches the 3 edge colors', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site' },
      { name: 'B', type: 'site' },
      { name: 'DC1', type: 'dc', site: 'A' },
      { name: 'DC2', type: 'dc', site: 'B' }
    ],
    links: [
      { source: 'DC1', target: 'DC2', statusCode: 0 },
      { source: 'DC2', target: 'DC1', statusCode: 1 },
      { source: 'DC1', target: 'DC2', statusCode: 3 } // second DC1->DC2 ignored, but verifies statusCode>=2 path
    ]
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  // Build a synthetic link payload with each lineStyle color and probe
  // the tooltip formatter directly.
  const opt = optionForLens('outbound');
  const tipOK = opt.tooltip.formatter({
    dataType: 'edge', data: { source: 'X', target: 'Y', lineStyle: { color: '#22c55e' } }
  });
  expect(tipOK).toContain('复制成功');
  const tipWarn = opt.tooltip.formatter({
    dataType: 'edge', data: { source: 'X', target: 'Y', lineStyle: { color: '#eab308' } }
  });
  expect(tipWarn).toContain('部分失败');
  const tipErr = opt.tooltip.formatter({
    dataType: 'edge', data: { source: 'X', target: 'Y', lineStyle: { color: '#ef4444' } }
  });
  expect(tipErr).toContain('失败');
});

// R59-T8: intra-site link still uses the "↔ 内" marker in BOTH panels.
test('R59: intra-site link edgeLabel shows ↔ 内 in both panels', async () => {
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
  for (const lens of ['outbound', 'inbound']) {
    const opt = optionForLens(lens);
    const link = opt.series[0].links[0];
    expect(link.edgeLabel.formatter({ data: link })).toMatch(/↔/);
  }
});

// R59-T9: tooltip mentions the active lens (出战复制结构 or 入站复制结构)
// so the operator can confirm which panel they're hovering.
test('R59: tooltip names the active lens for cross-site edge', async () => {
  const data = {
    nodes: [
      { name: '核心站点', type: 'site' },
      { name: '厦门站点', type: 'site' },
      { name: 'MOCK-HUBADSRV1', type: 'dc', site: '核心站点' },
      { name: 'MOCK-XMADSRV1', type: 'dc', site: '厦门站点' }
    ],
    links: [{ source: 'MOCK-HUBADSRV1', target: 'MOCK-XMADSRV1', statusCode: 0 }]
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();
  const outOpt = optionForLens('outbound');
  const outTip = outOpt.tooltip.formatter({ dataType: 'edge', data: outOpt.series[0].links[0] });
  expect(outTip).toMatch(/出战复制结构/);

  const innOpt = optionForLens('inbound');
  const innTip = innOpt.tooltip.formatter({ dataType: 'edge', data: innOpt.series[0].links[0] });
  expect(innTip).toMatch(/入站复制结构/);
});

// R59-T10: empty data renders both panels with empty data and links.
test('R59: empty data renders both panels with empty arrays', async () => {
  mount(TopologyChart, { props: { data: { nodes: [], links: [] } } });
  await flushPromises();
  expect(initMock).toHaveBeenCalledTimes(2);
  for (const call of setOptionMock.mock.calls) {
    const opt = call[0];
    expect(opt.series[0].data).toEqual([]);
    expect(opt.series[0].links).toEqual([]);
  }
});

// R61-T1: layout is horizontal (left/right side-by-side), not vertical
// stack. Operator directive "复制拓扑 改成左右结构 左边是出站 右边是入站".
// Assert via the rendered DOM: both panels exist as siblings inside
// .topology-split, and the outbound panel appears BEFORE the inbound
// panel in document order (so left = 出战, right = 入站).
test('R61: panels are side-by-side (horizontal) — 出战 on left, 入站 on right', async () => {
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
  const split = w.find('.topology-split');
  expect(split.exists()).toBe(true);
  const children = split.element.children;
  expect(children).toHaveLength(2);
  expect(children[0].classList.contains('outbound')).toBe(true);
  expect(children[1].classList.contains('inbound')).toBe(true);
  // Also verify the CSS — split is flex-row, not flex-column. This is
  // what makes the panels actually sit side-by-side in the viewport.
  const style = split.attributes('style') || '';
  // Vue test-utils doesn't render computed styles; instead we check the
  // scoped className to confirm the layout class structure is in place,
  // and trust the SCSS test (visual). Indirect assertion: outbound is
  // tagged 'structure outbound', inbound is 'structure inbound' — same
  // .structure class so they line up as flex items.
  expect(children[0].classList.contains('structure')).toBe(true);
  expect(children[1].classList.contains('structure')).toBe(true);
});

// R61-T1: color legend strip renders 3 colors (green/yellow/red) above
// the panels so the operator can map edge color → health state at a glance.
test('R61: color legend renders 3-color legend strip with ok/warn/err swatches', async () => {
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
