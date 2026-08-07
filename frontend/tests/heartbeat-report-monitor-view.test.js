import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../src/api/heartbeatReport.js', () => ({
  heartbeatReportApi: {
    listAgents: vi.fn(() => Promise.resolve({ data: { agents: [], heartbeatStaleSeconds: 15 } })),
    listDcs:    vi.fn(() => Promise.resolve({ data: { agents: [], heartbeatStaleSeconds: 15 } })),
    getDetail:  vi.fn(() => Promise.resolve({ data: { agentId: 'dc01', collectedAt: '2026-08-07T15:00:00Z', entries: [] } }))
  }
}));

import HeartbeatReportMonitorView from '../src/views/admin/HeartbeatReportMonitorView.vue';
import { heartbeatReportApi } from '../src/api/heartbeatReport.js';

beforeEach(() => {
  heartbeatReportApi.listAgents.mockReset();
  heartbeatReportApi.listDcs.mockReset();
  heartbeatReportApi.getDetail.mockReset();
  heartbeatReportApi.listAgents.mockResolvedValue({ data: { agents: [], heartbeatStaleSeconds: 15 } });
  heartbeatReportApi.listDcs.mockResolvedValue({ data: { agents: [], heartbeatStaleSeconds: 15 } });
  heartbeatReportApi.getDetail.mockResolvedValue({ data: { agentId: 'dc01', collectedAt: '2026-08-07T15:00:00Z', entries: [] } });
});

const AdminLayoutStub = { template: '<div><slot /></div>' };

function mountView() {
  return mount(HeartbeatReportMonitorView, {
    global: { stubs: { AdminLayout: AdminLayoutStub } }
  });
}

test('default tab is "agent" and shows heartbeat table headers', async () => {
  const wrapper = mountView();
  await flushPromises();
  expect(wrapper.text()).toContain('心跳表');
  expect(wrapper.find('[data-test="tab-agent"]').classes()).toContain('active');
});

test('heartbeat status: 4 cases (green/yellow/red/never)', async () => {
  const now = new Date('2026-08-07T15:30:00Z').getTime();
  vi.setSystemTime(now);
  heartbeatReportApi.listAgents.mockResolvedValue({
    data: { heartbeatStaleSeconds: 15, agents: [
      { agentId: 'green',  lastHeartbeatAt: new Date(now - 5_000).toISOString() },
      { agentId: 'yellow', lastHeartbeatAt: new Date(now - 30_000).toISOString() },
      { agentId: 'red',    lastHeartbeatAt: new Date(now - 120_000).toISOString() },
      { agentId: 'never',  lastHeartbeatAt: null }
    ] }
  });
  const wrapper = mountView();
  await flushPromises();
  const rows = wrapper.findAll('[data-test="heartbeat-row"]');
  expect(rows[0].attributes('data-status')).toBe('green');
  expect(rows[1].attributes('data-status')).toBe('yellow');
  expect(rows[2].attributes('data-status')).toBe('red');
  expect(rows[3].attributes('data-status')).toBe('never');
  vi.useRealTimers();
});

test('clicking a heartbeat row opens drawer with payload', async () => {
  heartbeatReportApi.listAgents.mockResolvedValue({
    data: { heartbeatStaleSeconds: 15, agents: [
      { agentId: 'dc01', lastHeartbeatAt: new Date().toISOString(), reportSummary: { totalLinks: 12, successCount: 12, failCount: 0, latestErrorMessage: null, latestFailedLink: null } }
    ] }
  });
  heartbeatReportApi.getDetail.mockResolvedValue({
    data: { agentId: 'dc01', collectedAt: '2026-08-07T15:00:00Z', entries: [] }
  });
  const wrapper = mountView();
  await flushPromises();
  await wrapper.find('[data-test="heartbeat-row"]').trigger('click');
  await flushPromises();
  expect(wrapper.find('[data-test="drawer"]').exists()).toBe(true);
});

test('auto-refresh: setInterval fires every 5s and calls listAgents again', async () => {
  vi.useFakeTimers();
  heartbeatReportApi.listAgents.mockResolvedValue({ data: { agents: [], heartbeatStaleSeconds: 15 } });
  const wrapper = mountView();
  await flushPromises();
  const callsBefore = heartbeatReportApi.listAgents.mock.calls.length;
  vi.advanceTimersByTime(5_000);
  await flushPromises();
  const callsAfter = heartbeatReportApi.listAgents.mock.calls.length;
  expect(callsAfter).toBeGreaterThan(callsBefore);
  vi.useRealTimers();
});

test('DC tab switches fetch to listDcs', async () => {
  heartbeatReportApi.listAgents.mockResolvedValue({ data: { agents: [], heartbeatStaleSeconds: 15 } });
  heartbeatReportApi.listDcs.mockResolvedValue({ data: { agents: [], heartbeatStaleSeconds: 15 } });
  const wrapper = mountView();
  await flushPromises();
  await wrapper.find('[data-test="tab-dc"]').trigger('click');
  await flushPromises();
  expect(heartbeatReportApi.listDcs).toHaveBeenCalled();
});