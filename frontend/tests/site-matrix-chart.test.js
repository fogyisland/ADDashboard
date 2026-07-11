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

import SiteMatrixChart from '../src/components/SiteMatrixChart.vue';

beforeEach(() => {
  setOptionMock.mockReset();
  disposeMock.mockReset();
  initMock.mockReset();
  initMock.mockImplementation(() => ({ setOption: setOptionMock, dispose: disposeMock }));
});

test('non-empty data: builds cells with camelCase keys, dedups sites, applies warning state', async () => {
  const rows = [
    { sourceSite: 'A', destSite: 'B', total: 5, errorCount: 0, warningCount: 2 }
  ];
  const wrapper = mount(SiteMatrixChart, { props: { data: rows } });
  await flushPromises();

  expect(initMock).toHaveBeenCalled();
  expect(setOptionMock).toHaveBeenCalled();

  const opt = setOptionMock.mock.calls[0][0];

  // series[0].data[0].value = [xIdx, yIdx, total, rowObj]
  // warningCount > 0, errorCount === 0 -> state 1
  const cell = opt.series[0].data[0];
  expect(cell.value[0]).toBe(0);             // x index for source 'A'
  expect(cell.value[1]).toBe(1);             // y index for dest 'B'
  expect(cell.value[2]).toBe(1);             // state = 1 (warning)
  expect(cell.value[3]).toEqual(rows[0]);    // raw row for tooltip

  // xAxis.data must include both sites
  expect(opt.xAxis.data).toContain('A');
  expect(opt.xAxis.data).toContain('B');
  // yAxis.data must include both sites
  expect(opt.yAxis.data).toContain('A');
  expect(opt.yAxis.data).toContain('B');
});

test('error state: errorCount>0 -> state 2 and color range includes red', async () => {
  const rows = [
    { sourceSite: 'A', destSite: 'B', total: 3, errorCount: 2, warningCount: 0 }
  ];
  const wrapper = mount(SiteMatrixChart, { props: { data: rows } });
  await flushPromises();

  const opt = setOptionMock.mock.calls[0][0];
  const cell = opt.series[0].data[0];
  expect(cell.value[2]).toBe(2); // error state

  // visualMap inRange.color should include the red end (#ef4444)
  const colors = opt.visualMap[0].inRange.color;
  expect(colors).toContain('#ef4444');
  expect(colors).toContain('#22c55e');
  expect(colors).toContain('#eab308');
});

test('empty data: renders with empty cells and empty axes', async () => {
  const wrapper = mount(SiteMatrixChart, { props: { data: [] } });
  await flushPromises();

  expect(setOptionMock).toHaveBeenCalled();
  const opt = setOptionMock.mock.calls[0][0];
  expect(opt.series[0].data).toEqual([]);
  expect(opt.xAxis.data).toEqual([]);
  expect(opt.yAxis.data).toEqual([]);
});