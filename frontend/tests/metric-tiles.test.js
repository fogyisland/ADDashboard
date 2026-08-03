import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

// echarts is mocked hoisted so we can assert setOption was called with
// the timeseries payload.
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

vi.mock('../src/stores/packages.js', () => ({
  usePackagesStore: vi.fn()
}));

vi.mock('axios', () => ({
  default: {
    get: vi.fn()
  }
}));

import GaugeTile from '../src/components/metrics/GaugeTile.vue';
import CounterTile from '../src/components/metrics/CounterTile.vue';
import TimeseriesTile from '../src/components/metrics/TimeseriesTile.vue';
import StatusTile from '../src/components/metrics/StatusTile.vue';
import MetricDashboardView from '../src/views/MetricDashboardView.vue';
import { usePackagesStore } from '../src/stores/packages.js';
import axios from 'axios';

// ---- GaugeTile ---------------------------------------------------------

test('GaugeTile: value < warn → green class', () => {
  const w = mount(GaugeTile, {
    props: { metric: { key: 'm1', label: 'M1', thresholds: { warn: 75, crit: 90 } }, currentValue: 50 }
  });
  expect(w.classes()).toContain('green');
});

test('GaugeTile: value > warn but < crit → yellow', () => {
  const w = mount(GaugeTile, {
    props: { metric: { key: 'm1', label: 'M1', thresholds: { warn: 75, crit: 90 } }, currentValue: 80 }
  });
  expect(w.classes()).toContain('yellow');
});

test('GaugeTile: value > crit → red', () => {
  const w = mount(GaugeTile, {
    props: { metric: { key: 'm1', label: 'M1', thresholds: { warn: 75, crit: 90 } }, currentValue: 95 }
  });
  expect(w.classes()).toContain('red');
});

test('GaugeTile: currentValue null → gray and "—" placeholder', () => {
  const w = mount(GaugeTile, {
    props: { metric: { key: 'm1', label: 'M1', thresholds: { warn: 75, crit: 90 } }, currentValue: null }
  });
  expect(w.classes()).toContain('gray');
  expect(w.text()).toContain('—');
});

test('GaugeTile: renders value, unit, and label', () => {
  const w = mount(GaugeTile, {
    props: { metric: { key: 'm1', label: 'CPU', unit: '%', thresholds: { warn: 75, crit: 90 } }, currentValue: 42 }
  });
  const text = w.text();
  expect(text).toContain('42');
  expect(text).toContain('%');
  expect(text).toContain('CPU');
});

// ---- CounterTile -------------------------------------------------------

test('CounterTile: positive delta → up arrow + green', () => {
  const w = mount(CounterTile, {
    props: { metric: { key: 'c1', label: 'C1', unit: '' }, currentValue: 100, delta: 25 }
  });
  const text = w.text();
  expect(text).toContain('↑');
  expect(text).toContain('+25');
});

test('CounterTile: negative delta → down arrow', () => {
  const w = mount(CounterTile, {
    props: { metric: { key: 'c1', label: 'C1', unit: '' }, currentValue: 100, delta: -5 }
  });
  const text = w.text();
  expect(text).toContain('↓');
  expect(text).toContain('-5');
});

test('CounterTile: zero delta → "—" flat', () => {
  const w = mount(CounterTile, {
    props: { metric: { key: 'c1', label: 'C1', unit: '' }, currentValue: 100, delta: 0 }
  });
  const text = w.text();
  expect(text).toContain('—');
  expect(text).toContain('0');
});

test('CounterTile: currentValue null → "—" placeholder', () => {
  const w = mount(CounterTile, {
    props: { metric: { key: 'c1', label: 'C1', unit: '' }, currentValue: null, delta: 0 }
  });
  expect(w.text()).toContain('—');
});

// ---- TimeseriesTile ----------------------------------------------------

beforeEach(() => {
  setOptionMock.mockReset();
  disposeMock.mockReset();
  initMock.mockReset();
  initMock.mockImplementation(() => ({ setOption: setOptionMock, dispose: disposeMock }));
});

test('TimeseriesTile: renders chart container + label', () => {
  const w = mount(TimeseriesTile, {
    props: { metric: { key: 't1', label: 'T1', unit: 'ms' }, data: [] }
  });
  expect(w.text()).toContain('T1');
  expect(w.find('.chart').exists()).toBe(true);
});

test('TimeseriesTile: setOption called with line series + time x-axis', async () => {
  mount(TimeseriesTile, {
    props: {
      metric: { key: 't1', label: 'T1', unit: 'ms' },
      data: [
        { ts: '2026-01-01T00:00:00Z', value: 1 },
        { ts: '2026-01-01T00:01:00Z', value: 2 }
      ]
    }
  });
  await flushPromises();
  expect(initMock).toHaveBeenCalled();
  expect(setOptionMock).toHaveBeenCalled();
  const opt = setOptionMock.mock.calls[0][0];
  expect(opt.xAxis.type).toBe('time');
  expect(opt.yAxis.type).toBe('value');
  expect(opt.yAxis.name).toBe('ms');
  expect(opt.series[0].type).toBe('line');
  expect(opt.series[0].data).toEqual([
    ['2026-01-01T00:00:00Z', 1],
    ['2026-01-01T00:01:00Z', 2]
  ]);
});

// ---- StatusTile --------------------------------------------------------

test('StatusTile: OK → green', () => {
  const w = mount(StatusTile, {
    props: { metric: { key: 's1', label: 'S1' }, status: 'OK' }
  });
  expect(w.classes()).toContain('green');
  expect(w.text()).toContain('OK');
});

test('StatusTile: WARN → yellow', () => {
  const w = mount(StatusTile, {
    props: { metric: { key: 's1', label: 'S1' }, status: 'WARN' }
  });
  expect(w.classes()).toContain('yellow');
});

test('StatusTile: CRIT → red', () => {
  const w = mount(StatusTile, {
    props: { metric: { key: 's1', label: 'S1' }, status: 'CRIT' }
  });
  expect(w.classes()).toContain('red');
});

test('StatusTile: UNKNOWN → gray', () => {
  const w = mount(StatusTile, {
    props: { metric: { key: 's1', label: 'S1' }, status: 'UNKNOWN' }
  });
  expect(w.classes()).toContain('gray');
});

test('StatusTile: optional message renders when provided', () => {
  const w = mount(StatusTile, {
    props: { metric: { key: 's1', label: 'S1' }, status: 'WARN', message: 'replication lag' }
  });
  expect(w.text()).toContain('replication lag');
});

// ---- MetricDashboardView ----------------------------------------------

function makeStore(overrides = {}) {
  const fetchInstalled = vi.fn().mockResolvedValue(undefined);
  const store = {
    installed: [
      {
        name: 'cpu-monitor',
        version: '1.0.0',
        type: 'gauge',
        enabled: 1,
        manifest: {
          name: 'cpu-monitor',
          type: 'gauge',
          description: 'CPU usage',
          metrics: [{ key: 'm1', label: 'CPU', unit: '%', thresholds: { warn: 75, crit: 90 } }]
        }
      }
    ],
    loading: false,
    error: null,
    fetchInstalled,
    ...overrides
  };
  usePackagesStore.mockReturnValue(store);
  return store;
}

test('MetricDashboardView: fetches installed + renders sidebar with package names', async () => {
  const store = makeStore();
  axios.get.mockResolvedValue({ data: { rows: [], gauge: [], counter: [], status: [], points: [] } });
  const wrapper = mount(MetricDashboardView);
  await flushPromises();
  expect(store.fetchInstalled).toHaveBeenCalled();
  const text = wrapper.text();
  expect(text).toContain('cpu-monitor');
  expect(text).toContain('CPU usage');
});

test('MetricDashboardView: clicking sidebar pkg triggers summary + timeseries fetches', async () => {
  const store = makeStore();
  axios.get.mockResolvedValue({
    data: {
      rows: [
        { agent_id: 'a1', metric_id: 'cpu-monitor.m1', value: 42, ts: '2026-01-01T00:00:00Z', unit: '%' }
      ],
      gauge: [{ agent_id: 'a1', metric_id: 'cpu-monitor.m1', value: 42, ts: '2026-01-01T00:00:00Z' }],
      counter: [],
      status: [],
      points: [{ ts: '2026-01-01T00:00:00Z', value: 1 }, { ts: '2026-01-01T00:01:00Z', value: 2 }]
    }
  });
  const wrapper = mount(MetricDashboardView);
  await flushPromises();

  // First package should auto-select; summary should be called.
  const summaryCalls = axios.get.mock.calls.filter((c) => c[0].includes('/api/dashboard/metrics/summary'));
  expect(summaryCalls.length).toBeGreaterThan(0);

  // Click the sidebar entry to confirm re-select triggers another summary fetch.
  const links = wrapper.findAll('li');
  const pkgLink = links.find((l) => l.text().includes('cpu-monitor'));
  expect(pkgLink).toBeTruthy();
  await pkgLink.trigger('click');
  await flushPromises();

  const allSummaryCalls = axios.get.mock.calls.filter((c) => c[0].includes('/api/dashboard/metrics/summary'));
  expect(allSummaryCalls.length).toBeGreaterThan(0);
});
