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

test('non-empty data: site category 0 size 36, dc category 1 size 14, link green when statusCode 0', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site' },
      { name: 'DC1', type: 'dc', site: 'A' }
    ],
    links: [
      { source: 'DC1', target: 'DC1', statusCode: 0 }
    ]
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();

  expect(initMock).toHaveBeenCalled();
  expect(setOptionMock).toHaveBeenCalled();

  const opt = setOptionMock.mock.calls[0][0];

  // graph type
  expect(opt.series[0].type).toBe('graph');

  // data: 2 nodes
  expect(opt.series[0].data).toHaveLength(2);

  const siteNode = opt.series[0].data.find(n => n.name === 'A');
  const dcNode = opt.series[0].data.find(n => n.name === 'DC1');
  expect(siteNode.category).toBe(0);
  expect(siteNode.symbolSize).toBe(36);
  expect(dcNode.category).toBe(1);
  expect(dcNode.symbolSize).toBe(14);

  // links: 1 link, green lineStyle when statusCode 0
  expect(opt.series[0].links).toHaveLength(1);
  const link = opt.series[0].links[0];
  expect(link.source).toBe('DC1');
  expect(link.target).toBe('DC1');
  expect(link.lineStyle.color).toBe('#22c55e');
});

test('error link: statusCode !== 0 -> red lineStyle color #ef4444', async () => {
  const data = {
    nodes: [
      { name: 'A', type: 'site' },
      { name: 'DC1', type: 'dc', site: 'A' }
    ],
    links: [
      { source: 'DC1', target: 'DC1', statusCode: 1 }
    ]
  };
  mount(TopologyChart, { props: { data } });
  await flushPromises();

  const opt = setOptionMock.mock.calls[0][0];
  expect(opt.series[0].links).toHaveLength(1);
  expect(opt.series[0].links[0].lineStyle.color).toBe('#ef4444');
});

test('empty data: renders with empty data and links arrays', async () => {
  mount(TopologyChart, { props: { data: { nodes: [], links: [] } } });
  await flushPromises();

  expect(setOptionMock).toHaveBeenCalled();
  const opt = setOptionMock.mock.calls[0][0];
  expect(opt.series[0].data).toEqual([]);
  expect(opt.series[0].links).toEqual([]);
});