import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../src/api/heartbeatReport.js', () => ({
  heartbeatReportApi: {
    listAgents: vi.fn(() => Promise.resolve({ data: { agents: [], heartbeatStaleSeconds: 15 } })),
    listDcs:    vi.fn(() => Promise.resolve({ data: { agents: [], heartbeatStaleSeconds: 15 } })),
    getDetail:  vi.fn(() => Promise.resolve({ data: { agentId: 'dc01', collectedAt: '2026-08-07T15:00:00Z', entries: [] } })),
    getProbeStatus: vi.fn(() => Promise.resolve({ data: { probes: {}, nowCenterProbeStale: false } }))
  }
}));

import HeartbeatReportMonitorView from '../src/views/admin/HeartbeatReportMonitorView.vue';
import { heartbeatReportApi } from '../src/api/heartbeatReport.js';

beforeEach(() => {
  vi.useRealTimers();
  heartbeatReportApi.listAgents.mockReset();
  heartbeatReportApi.listDcs.mockReset();
  heartbeatReportApi.getDetail.mockReset();
  heartbeatReportApi.getProbeStatus.mockReset();
  heartbeatReportApi.listAgents.mockResolvedValue({ data: { agents: [], heartbeatStaleSeconds: 15 } });
  heartbeatReportApi.listDcs.mockResolvedValue({ data: { agents: [], heartbeatStaleSeconds: 15 } });
  heartbeatReportApi.getDetail.mockResolvedValue({ data: { agentId: 'dc01', collectedAt: '2026-08-07T15:00:00Z', entries: [] } });
  heartbeatReportApi.getProbeStatus.mockResolvedValue({ data: { probes: {}, nowCenterProbeStale: false } });
});

const AdminLayoutStub = { template: '<div><slot /></div>' };

function mountView() {
  return mount(HeartbeatReportMonitorView, {
    global: { stubs: { AdminLayout: AdminLayoutStub } }
  });
}

const fresh = (role) => ({
  status: 'healthy',
  latencyMs: 3,
  lastProbeAt: new Date().toISOString(),
  lastUpAt: new Date().toISOString(),
  consecutiveFailures: 0
});

test('panel renders 3 rows (web/heartbeat/report) with green dot when all healthy', async () => {
  const now = new Date('2026-08-08T10:30:00Z').getTime();
  vi.setSystemTime(now);
  heartbeatReportApi.getProbeStatus.mockResolvedValue({
    data: {
      probes: {
        web:       { ...fresh('web'),       latencyMs: 3 },
        heartbeat: { ...fresh('heartbeat'), latencyMs: 4 },
        report:    { ...fresh('report'),    latencyMs: 5 }
      },
      nowCenterProbeStale: false
    }
  });
  const wrapper = mountView();
  await flushPromises();
  const panel = wrapper.find('[data-test="probe-panel"]');
  expect(panel.exists()).toBe(true);
  const rows = wrapper.findAll('[data-test="probe-row"]');
  expect(rows.length).toBe(3);
  const roles = rows.map(r => r.attributes('data-role'));
  expect(roles).toEqual(['web', 'heartbeat', 'report']);
  rows.forEach(r => {
    expect(r.attributes('data-status')).toBe('green');
    expect(r.find('.dot').classes()).toContain('green');
  });
  vi.useRealTimers();
});

test('panel renders yellow dot when status=degraded', async () => {
  const now = new Date('2026-08-08T10:30:00Z').getTime();
  vi.setSystemTime(now);
  heartbeatReportApi.getProbeStatus.mockResolvedValue({
    data: {
      probes: {
        web:       { ...fresh('web'),       status: 'degraded', latencyMs: null, consecutiveFailures: 1 },
        heartbeat: { ...fresh('heartbeat'), latencyMs: 4 },
        report:    { ...fresh('report'),    latencyMs: 5 }
      },
      nowCenterProbeStale: false
    }
  });
  const wrapper = mountView();
  await flushPromises();
  const rows = wrapper.findAll('[data-test="probe-row"]');
  expect(rows[0].attributes('data-status')).toBe('yellow');
  expect(rows[0].find('.dot').classes()).toContain('yellow');
  expect(rows[1].attributes('data-status')).toBe('green');
  expect(rows[2].attributes('data-status')).toBe('green');
  vi.useRealTimers();
});

test('panel renders yellow dot during boot when status=unknown', async () => {
  const now = new Date('2026-08-08T10:30:00Z').getTime();
  vi.setSystemTime(now);
  heartbeatReportApi.getProbeStatus.mockResolvedValue({
    data: {
      probes: {
        web:       { status: 'unknown', latencyMs: null, lastProbeAt: null, lastUpAt: null, consecutiveFailures: 0 },
        heartbeat: { status: 'unknown', latencyMs: null, lastProbeAt: null, lastUpAt: null, consecutiveFailures: 0 },
        report:    { status: 'unknown', latencyMs: null, lastProbeAt: null, lastUpAt: null, consecutiveFailures: 0 }
      },
      nowCenterProbeStale: false
    }
  });
  const wrapper = mountView();
  await flushPromises();
  const rows = wrapper.findAll('[data-test="probe-row"]');
  expect(rows.length).toBe(3);
  rows.forEach(r => {
    expect(r.attributes('data-status')).toBe('yellow');
    expect(r.find('.dot').classes()).toContain('yellow');
    // Must NOT be green during boot
    expect(r.find('.dot').classes()).not.toContain('green');
  });
  vi.useRealTimers();
});

test('panel renders red dot on all rows when nowCenterProbeStale=true', async () => {
  const now = new Date('2026-08-08T10:30:00Z').getTime();
  vi.setSystemTime(now);
  heartbeatReportApi.getProbeStatus.mockResolvedValue({
    data: {
      probes: {
        web:       { ...fresh('web'),       latencyMs: 3 },
        heartbeat: { ...fresh('heartbeat'), latencyMs: 4 },
        report:    { ...fresh('report'),    latencyMs: 5 }
      },
      nowCenterProbeStale: true
    }
  });
  const wrapper = mountView();
  await flushPromises();
  const rows = wrapper.findAll('[data-test="probe-row"]');
  rows.forEach(r => {
    expect(r.attributes('data-status')).toBe('red');
    expect(r.find('.dot').classes()).toContain('red');
  });
  // Stale banner appears
  const banner = wrapper.find('[data-test="probe-stale-banner"]');
  expect(banner.exists()).toBe(true);
  expect(banner.text()).toContain('失联');
  vi.useRealTimers();
});

test('down label includes consecutiveFailures count', async () => {
  const now = new Date('2026-08-08T10:30:00Z').getTime();
  vi.setSystemTime(now);
  // Red path: 5 consecutive failures on web, recent probe timestamp
  heartbeatReportApi.getProbeStatus.mockResolvedValue({
    data: {
      probes: {
        web:       { ...fresh('web'),       status: 'degraded', latencyMs: null, consecutiveFailures: 5 },
        heartbeat: { ...fresh('heartbeat'), latencyMs: 4 },
        report:    { ...fresh('report'),    latencyMs: 5 }
      },
      nowCenterProbeStale: false
    }
  });
  const wrapper = mountView();
  await flushPromises();
  const rows = wrapper.findAll('[data-test="probe-row"]');
  // web row should be red because consecutiveFailures >= 3
  expect(rows[0].attributes('data-status')).toBe('red');
  // Label text must include "5" (consecutiveFailures count)
  expect(rows[0].text()).toContain('5');
  vi.useRealTimers();
});

test('auto-refresh fires getProbeStatus again on next tick', async () => {
  vi.useFakeTimers();
  heartbeatReportApi.getProbeStatus.mockResolvedValue({
    data: {
      probes: {
        web:       { ...fresh('web'),       latencyMs: 3 },
        heartbeat: { ...fresh('heartbeat'), latencyMs: 4 },
        report:    { ...fresh('report'),    latencyMs: 5 }
      },
      nowCenterProbeStale: false
    }
  });
  const wrapper = mountView();
  await flushPromises();
  const callsBefore = heartbeatReportApi.getProbeStatus.mock.calls.length;
  vi.advanceTimersByTime(5_000);
  await flushPromises();
  const callsAfter = heartbeatReportApi.getProbeStatus.mock.calls.length;
  expect(callsAfter).toBeGreaterThan(callsBefore);
  vi.useRealTimers();
});