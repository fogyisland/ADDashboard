import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../src/api/heartbeatReport.js', () => ({
  heartbeatReportApi: {
    listAgents: vi.fn(() => Promise.resolve({ data: { agents: [], heartbeatStaleSeconds: 15 } })),
    listDcs:    vi.fn(() => Promise.resolve({ data: { agents: [], heartbeatStaleSeconds: 15 } })),
    getDetail:  vi.fn(() => Promise.resolve({ data: { agentId: 'dc01', collectedAt: '2026-08-07T15:00:00Z', entries: [] } })),
    getProbeStatus: vi.fn(() => Promise.resolve({ data: { probes: {}, nowCenterProbeStale: false } })),
    requestReport: vi.fn(() => Promise.resolve({ data: { ok: true, agentId: 'agent-online', requestedAt: new Date().toISOString(), alreadyPending: false } })),
    deleteAgent: vi.fn(() => Promise.resolve({ data: { ok: true, agentId: 'agent-online', deleted: { heartbeat: 1, replication: 2, package_runs: 0 } } })),
    deleteDc:    vi.fn(() => Promise.resolve({ data: { ok: true, dcName: 'dc01', deleted: { dcs: 1 } } }))
  }
}));

import HeartbeatReportMonitorView from '../src/views/admin/HeartbeatReportMonitorView.vue';
import { heartbeatReportApi } from '../src/api/heartbeatReport.js';

beforeEach(() => {
  heartbeatReportApi.listAgents.mockReset();
  heartbeatReportApi.listDcs.mockReset();
  heartbeatReportApi.getDetail.mockReset();
  heartbeatReportApi.requestReport.mockReset();
  heartbeatReportApi.deleteAgent.mockReset();
  heartbeatReportApi.deleteDc.mockReset();
  heartbeatReportApi.listAgents.mockResolvedValue({ data: { agents: [], heartbeatStaleSeconds: 15 } });
  heartbeatReportApi.listDcs.mockResolvedValue({ data: { agents: [], heartbeatStaleSeconds: 15 } });
  heartbeatReportApi.getDetail.mockResolvedValue({ data: { agentId: 'dc01', collectedAt: '2026-08-07T15:00:00Z', entries: [] } });
  heartbeatReportApi.requestReport.mockResolvedValue({ data: { ok: true, agentId: 'agent-online', requestedAt: new Date().toISOString(), alreadyPending: false } });
  heartbeatReportApi.deleteAgent.mockResolvedValue({ data: { ok: true, agentId: 'agent-online', deleted: { heartbeat: 1, replication: 2, package_runs: 0 } } });
  heartbeatReportApi.deleteDc.mockResolvedValue({ data: { ok: true, dcName: 'dc01', deleted: { dcs: 1 } } });
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

test('auto-refresh survives a transient backend failure', async () => {
  vi.useFakeTimers();
  // First load rejects (e.g. DB hiccup / mid-flight migration). Second load succeeds.
  heartbeatReportApi.listAgents
    .mockRejectedValueOnce(new Error('boom'))
    .mockResolvedValue({ data: { agents: [], heartbeatStaleSeconds: 15 } });
  const wrapper = mountView();
  await flushPromises();
  // Banner shows the error.
  expect(wrapper.find('[data-test="error-banner"]').exists()).toBe(true);
  expect(wrapper.find('[data-test="error-banner"]').text()).toContain('boom');
  // Poller must still run: advance 5s, second load fires, banner clears.
  vi.advanceTimersByTime(5_000);
  await flushPromises();
  expect(heartbeatReportApi.listAgents.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(wrapper.find('[data-test="error-banner"]').exists()).toBe(false);
  vi.useRealTimers();
});

test('unmount stops the timer (setInterval cleanup)', async () => {
  vi.useFakeTimers();
  heartbeatReportApi.listAgents.mockResolvedValue({ data: { agents: [], heartbeatStaleSeconds: 15 } });
  const wrapper = mountView();
  await flushPromises();
  const callsBefore = heartbeatReportApi.listAgents.mock.calls.length;
  wrapper.unmount();
  vi.advanceTimersByTime(10_000);
  // After unmount the timer must NOT fire any more polls.
  expect(heartbeatReportApi.listAgents.mock.calls.length).toBe(callsBefore);
  vi.useRealTimers();
});

test('report table renders success rate and latest error message', async () => {
  const now = new Date('2026-08-07T15:30:00Z').getTime();
  vi.setSystemTime(now);
  heartbeatReportApi.listAgents.mockResolvedValue({
    data: { heartbeatStaleSeconds: 15, agents: [
      { agentId: 'a1', lastReportAt: new Date(now - 60_000).toISOString(),
        reportSummary: { totalLinks: 10, successCount: 7, failCount: 3, latestErrorMessage: '目标不可达', latestFailedLink: null } },
      { agentId: 'a2', lastReportAt: new Date(now - 60_000).toISOString(),
        reportSummary: { totalLinks: 5, successCount: 5, failCount: 0, latestErrorMessage: null, latestFailedLink: null } }
    ] }
  });
  const wrapper = mountView();
  await flushPromises();
  const rows = wrapper.findAll('[data-test="report-row"]');
  expect(rows.length).toBe(2);
  expect(rows[0].text()).toContain('7 / 10');
  expect(rows[0].text()).toContain('目标不可达');
  expect(rows[1].text()).toContain('5 / 5');
  expect(rows[1].text()).toContain('—');
  vi.useRealTimers();
});

// ---- Task 8: 回报 button + 3-state + tooltip ----

const THREE_AGENTS_FIXTURE = (now) => ({
  data: { heartbeatStaleSeconds: 15, agents: [
    { agentId: 'agent-online',  lastHeartbeatAt: new Date(now).toISOString(),                reportRequestedAt: null,                       lastReportStatus: null },
    { agentId: 'agent-pending', lastHeartbeatAt: new Date(now).toISOString(),                reportRequestedAt: new Date(now - 5_000).toISOString(), lastReportStatus: null },
    { agentId: 'agent-offline', lastHeartbeatAt: new Date(now - 60_000).toISOString(),      reportRequestedAt: null,                       lastReportStatus: null }
  ] }
});

test('renders 回报 button for each agent row', async () => {
  const now = new Date('2026-08-07T15:30:00Z').getTime();
  vi.setSystemTime(now);
  heartbeatReportApi.listAgents.mockResolvedValue(THREE_AGENTS_FIXTURE(now));
  const wrapper = mountView();
  await flushPromises();
  const buttons = wrapper.findAll('button[data-test="request-report"]');
  expect(buttons.length).toBe(3);
  vi.useRealTimers();
});

test('disables button + labels "已请求回报" when reportRequestedAt is set and age < 24h', async () => {
  const now = new Date('2026-08-07T15:30:00Z').getTime();
  vi.setSystemTime(now);
  heartbeatReportApi.listAgents.mockResolvedValue(THREE_AGENTS_FIXTURE(now));
  const wrapper = mountView();
  await flushPromises();
  const pendingBtn = wrapper.findAll('[data-agent="agent-pending"] button[data-test="request-report"]')[0];
  expect(pendingBtn.exists()).toBe(true);
  expect(pendingBtn.attributes('disabled')).toBeDefined();
  expect(pendingBtn.text()).toBe('已请求回报');
  vi.useRealTimers();
});

test('disables button when agent is offline (stale)', async () => {
  const now = new Date('2026-08-07T15:30:00Z').getTime();
  vi.setSystemTime(now);
  heartbeatReportApi.listAgents.mockResolvedValue(THREE_AGENTS_FIXTURE(now));
  const wrapper = mountView();
  await flushPromises();
  const offlineBtn = wrapper.findAll('[data-agent="agent-offline"] button[data-test="request-report"]')[0];
  expect(offlineBtn.exists()).toBe(true);
  expect(offlineBtn.attributes('disabled')).toBeDefined();
  vi.useRealTimers();
});

test('clicking enabled button shows confirm modal; confirm calls requestReport API', async () => {
  const now = new Date('2026-08-07T15:30:00Z').getTime();
  vi.setSystemTime(now);
  heartbeatReportApi.listAgents.mockResolvedValue(THREE_AGENTS_FIXTURE(now));
  const wrapper = mountView();
  await flushPromises();
  const btn = wrapper.findAll('[data-agent="agent-online"] button[data-test="request-report"]')[0];
  expect(btn.exists()).toBe(true);
  await btn.trigger('click');
  await flushPromises();
  // ConfirmDialog should appear; click its confirm button.
  const confirmBtn = wrapper.find('button.confirm');
  expect(confirmBtn.exists()).toBe(true);
  await confirmBtn.trigger('click');
  await flushPromises();
  expect(heartbeatReportApi.requestReport).toHaveBeenCalledWith('agent-online');
  vi.useRealTimers();
});

// ---- 2026-08-26 round-19+ delete buttons on heartbeat + report tables ----

const TWO_AGENTS_FIXTURE = (now) => ({
  data: { heartbeatStaleSeconds: 15, agents: [
    { agentId: 'a-online', lastHeartbeatAt: new Date(now).toISOString(),
      lastReportAt: new Date(now).toISOString(),
      reportSummary: { totalLinks: 2, successCount: 2, failCount: 0, latestErrorMessage: null, latestFailedLink: null } },
    { agentId: 'a-stale',  lastHeartbeatAt: new Date(now - 60_000).toISOString(),
      lastReportAt: new Date(now - 60_000).toISOString(),
      reportSummary: { totalLinks: 1, successCount: 0, failCount: 1, latestErrorMessage: '目标不可达', latestFailedLink: null } }
  ] }
});

test('agent tab renders 删除 button on heartbeat row + report row', async () => {
  const now = new Date('2026-08-07T15:30:00Z').getTime();
  vi.setSystemTime(now);
  heartbeatReportApi.listAgents.mockResolvedValue(TWO_AGENTS_FIXTURE(now));
  const wrapper = mountView();
  await flushPromises();
  // Heartbeat table: one 删除 per row (2 rows = 2 buttons)
  const hbDeletes = wrapper.findAll('button[data-test="delete-heartbeat-agent"]');
  expect(hbDeletes.length).toBe(2);
  expect(hbDeletes[0].attributes('data-id')).toBe('a-online');
  expect(hbDeletes[1].attributes('data-id')).toBe('a-stale');
  expect(hbDeletes[0].text()).toBe('删除');
  // Report table: one 删除 per row
  const repDeletes = wrapper.findAll('button[data-test="delete-report-agent"]');
  expect(repDeletes.length).toBe(2);
  expect(repDeletes[0].attributes('data-id')).toBe('a-online');
  vi.useRealTimers();
});

test('clicking heartbeat-row 删除 shows confirm modal; confirm calls deleteAgent API', async () => {
  const now = new Date('2026-08-07T15:30:00Z').getTime();
  vi.setSystemTime(now);
  heartbeatReportApi.listAgents.mockResolvedValue(TWO_AGENTS_FIXTURE(now));
  const wrapper = mountView();
  await flushPromises();
  const btn = wrapper.findAll('[data-agent="a-online"] button[data-test="delete-heartbeat-agent"]')[0];
  expect(btn.exists()).toBe(true);
  await btn.trigger('click');
  await flushPromises();
  // ConfirmDialog should appear; agent-kind title + body
  expect(wrapper.text()).toContain('删除 agent a-online');
  const confirmBtn = wrapper.find('button.confirm.danger');
  expect(confirmBtn.exists()).toBe(true);
  await confirmBtn.trigger('click');
  await flushPromises();
  expect(heartbeatReportApi.deleteAgent).toHaveBeenCalledWith('a-online');
  // After delete, listAgents is re-called (reload).
  expect(heartbeatReportApi.listAgents.mock.calls.length).toBeGreaterThanOrEqual(2);
  vi.useRealTimers();
});

test('clicking report-row 删除 also routes through deleteAgent (cascade)', async () => {
  const now = new Date('2026-08-07T15:30:00Z').getTime();
  vi.setSystemTime(now);
  heartbeatReportApi.listAgents.mockResolvedValue(TWO_AGENTS_FIXTURE(now));
  const wrapper = mountView();
  await flushPromises();
  const btn = wrapper.findAll('button[data-test="delete-report-agent"]')[0];
  expect(btn.exists()).toBe(true);
  await btn.trigger('click');
  await flushPromises();
  const confirmBtn = wrapper.find('button.confirm.danger');
  expect(confirmBtn.exists()).toBe(true);
  await confirmBtn.trigger('click');
  await flushPromises();
  // Report-row delete cascades through the same deleteAgent endpoint —
  // one click removes heartbeat + replication + report rows together.
  expect(heartbeatReportApi.deleteAgent).toHaveBeenCalledWith('a-online');
  expect(heartbeatReportApi.deleteDc).not.toHaveBeenCalled();
  vi.useRealTimers();
});

test('DC tab heartbeat-row 删除 routes through deleteDc (no cascade)', async () => {
  const now = new Date('2026-08-07T15:30:00Z').getTime();
  vi.setSystemTime(now);
  heartbeatReportApi.listAgents.mockResolvedValue({ data: { agents: [], heartbeatStaleSeconds: 15 } });
  heartbeatReportApi.listDcs.mockResolvedValue({
    data: { heartbeatStaleSeconds: 15, agents: [
      { agentId: 'MOCK-NCADSRV1', dcName: 'MOCK-NCADSRV1', siteName: 'MOCK-NC',
        lastHeartbeatAt: new Date(now).toISOString(), lastReportAt: new Date(now).toISOString(),
        reportSummary: { totalLinks: 2, successCount: 2, failCount: 0, latestErrorMessage: null, latestFailedLink: null } }
    ] }
  });
  const wrapper = mountView();
  await flushPromises();
  await wrapper.find('[data-test="tab-dc"]').trigger('click');
  await flushPromises();
  const btn = wrapper.findAll('button[data-test="delete-heartbeat-dc"]')[0];
  expect(btn.exists()).toBe(true);
  await btn.trigger('click');
  await flushPromises();
  expect(wrapper.text()).toContain('删除 DC MOCK-NCADSRV1');
  const confirmBtn = wrapper.find('button.confirm.danger');
  expect(confirmBtn.exists()).toBe(true);
  await confirmBtn.trigger('click');
  await flushPromises();
  expect(heartbeatReportApi.deleteDc).toHaveBeenCalledWith('MOCK-NCADSRV1');
  expect(heartbeatReportApi.deleteAgent).not.toHaveBeenCalled();
  vi.useRealTimers();
});

test('cancelling the delete confirm modal does NOT call any delete API', async () => {
  const now = new Date('2026-08-07T15:30:00Z').getTime();
  vi.setSystemTime(now);
  heartbeatReportApi.listAgents.mockResolvedValue(TWO_AGENTS_FIXTURE(now));
  const wrapper = mountView();
  await flushPromises();
  const btn = wrapper.findAll('button[data-test="delete-heartbeat-agent"]')[0];
  await btn.trigger('click');
  await flushPromises();
  // Cancel button (first .cancel in the dialog) closes the modal.
  const cancelBtn = wrapper.find('button.cancel');
  expect(cancelBtn.exists()).toBe(true);
  await cancelBtn.trigger('click');
  await flushPromises();
  expect(heartbeatReportApi.deleteAgent).not.toHaveBeenCalled();
  expect(heartbeatReportApi.deleteDc).not.toHaveBeenCalled();
  vi.useRealTimers();
});

test('clicking delete button on row does NOT open the drawer (stop propagation)', async () => {
  const now = new Date('2026-08-07T15:30:00Z').getTime();
  vi.setSystemTime(now);
  heartbeatReportApi.listAgents.mockResolvedValue(TWO_AGENTS_FIXTURE(now));
  const wrapper = mountView();
  await flushPromises();
  const btn = wrapper.findAll('button[data-test="delete-heartbeat-agent"]')[0];
  await btn.trigger('click');
  await flushPromises();
  // Drawer should NOT have opened — confirm modal should be the only overlay.
  expect(wrapper.find('[data-test="drawer"]').exists()).toBe(false);
  expect(wrapper.find('button.confirm.danger').exists()).toBe(true);
  vi.useRealTimers();
});