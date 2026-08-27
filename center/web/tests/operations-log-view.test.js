import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../src/api/admin.js', () => ({
  adminApi: {
    getAudit: vi.fn(() => Promise.resolve({ data: { rows: [], total: 0 } }))
  }
}));
vi.mock('../src/api/heartbeatReport.js', () => ({
  heartbeatReportApi: {
    listAgents: vi.fn(() => Promise.resolve({ data: { agents: [], heartbeatStaleSeconds: 15 } })),
    listDcs:    vi.fn(() => Promise.resolve({ data: { agents: [], heartbeatStaleSeconds: 15 } }))
  }
}));

import OperationsLogView from '../src/views/admin/OperationsLogView.vue';
import { adminApi } from '../src/api/admin.js';
import { heartbeatReportApi } from '../src/api/heartbeatReport.js';

function mountView() {
  return mount(OperationsLogView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
}

beforeEach(() => {
  adminApi.getAudit.mockReset();
  heartbeatReportApi.listAgents.mockReset();
  heartbeatReportApi.listDcs.mockReset();
  adminApi.getAudit.mockResolvedValue({ data: { rows: [], total: 0 } });
  heartbeatReportApi.listAgents.mockResolvedValue({ data: { agents: [], heartbeatStaleSeconds: 15 } });
  heartbeatReportApi.listDcs.mockResolvedValue({ data: { agents: [], heartbeatStaleSeconds: 15 } });
});

afterEach(() => { vi.useRealTimers(); });

test('renders the three blocks: 审计事件 / 心跳数据 / 回报数据', async () => {
  const w = mountView();
  await flushPromises();
  expect(w.find('[data-test="audit-block"]').exists()).toBe(true);
  expect(w.find('[data-test="heartbeat-block"]').exists()).toBe(true);
  expect(w.find('[data-test="report-block"]').exists()).toBe(true);
});

test('聚合 changes + ops audit categories 一起显示', async () => {
  adminApi.getAudit
    .mockResolvedValueOnce({ data: { rows: [
      { id: 1, createdAt: '2026-08-27T01:00:00Z', actionLabel: '创建站点', severity: 'low', userId: 7, username: 'admin' }
    ], total: 1 } })
    .mockResolvedValueOnce({ data: { rows: [
      { id: 2, createdAt: '2026-08-27T01:30:00Z', actionLabel: '测试 SMTP 邮件', severity: 'low', userId: 7, username: 'admin' }
    ], total: 1 } });
  const w = mountView();
  await flushPromises();
  // Two category calls + both rows rendered (changes first, ops second).
  expect(adminApi.getAudit).toHaveBeenCalledWith(expect.objectContaining({ category: 'changes' }));
  expect(adminApi.getAudit).toHaveBeenCalledWith(expect.objectContaining({ category: 'ops' }));
  const rows = w.findAll('[data-test="audit-row"]');
  expect(rows.length).toBe(2);
});

test('report row 展示 counts + 百分比', async () => {
  heartbeatReportApi.listAgents.mockResolvedValue({ data: {
    agents: [{
      agentId: 'DC-BJ-01', lastHeartbeatAt: '2026-08-27T01:00:00Z',
      lastReportAt: '2026-08-27T01:00:00Z',
      reportSummary: { totalLinks: 7, successCount: 6, failCount: 1, successRate: 86, latestErrorMessage: null, latestFailedLink: null }
    }],
    heartbeatStaleSeconds: 15
  } });
  const w = mountView();
  await flushPromises();
  const cell = w.find('[data-test="report-success-rate"]');
  expect(cell.exists()).toBe(true);
  expect(cell.text()).toContain('6 / 7');
  expect(cell.text()).toContain('86%');
});

test('report 0/0 渲染 — 不显示百分比', async () => {
  heartbeatReportApi.listAgents.mockResolvedValue({ data: {
    agents: [{
      agentId: 'DC-BJ-01', lastHeartbeatAt: '2026-08-27T01:00:00Z',
      lastReportAt: '2026-08-27T01:00:00Z',
      reportSummary: { totalLinks: 0, successCount: 0, failCount: 0, successRate: null, latestErrorMessage: null, latestFailedLink: null }
    }],
    heartbeatStaleSeconds: 15
  } });
  const w = mountView();
  await flushPromises();
  const cell = w.find('[data-test="report-success-rate"]');
  expect(cell.text()).toContain('0 / 0');
  expect(cell.text()).not.toContain('%');
  expect(cell.text()).toContain('—');
});

test('audit row 点击 打开 drawer payload', async () => {
  adminApi.getAudit
    .mockResolvedValueOnce({ data: { rows: [
      { id: 99, createdAt: '2026-08-27T01:00:00Z', actionLabel: '创建用户', severity: 'low',
        userId: 1, username: 'admin', payload: { foo: 'bar' } }
    ], total: 1 } })
    .mockResolvedValueOnce({ data: { rows: [], total: 0 } });
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="audit-row"]').trigger('click');
  await flushPromises();
  expect(w.find('.drawer').exists()).toBe(true);
  expect(w.find('.drawer').text()).toContain('创建用户');
  expect(w.find('.drawer').text()).toContain('foo');
});

test('polling: refreshSeconds 控制 setInterval 周期', async () => {
  vi.useFakeTimers();
  const w = mountView();
  await flushPromises();
  // listAgents 已经被初始调用一次.
  const startCalls = heartbeatReportApi.listAgents.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(heartbeatReportApi.listAgents.mock.calls.length).toBeGreaterThan(startCalls);
});

test('unmount 清理 interval', async () => {
  vi.useFakeTimers();
  const w = mountView();
  await flushPromises();
  const startCalls = heartbeatReportApi.listAgents.mock.calls.length;
  w.unmount();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(heartbeatReportApi.listAgents.mock.calls.length).toBe(startCalls);
});

test('心跳表绿色 dot — 最近心跳时间新鲜', async () => {
  heartbeatReportApi.listAgents.mockResolvedValue({ data: {
    agents: [{
      agentId: 'DC-OK', lastHeartbeatAt: new Date().toISOString(),
      lastReportAt: null, reportSummary: null
    }],
    heartbeatStaleSeconds: 15
  } });
  const w = mountView();
  await flushPromises();
  const row = w.find('[data-test="heartbeat-agent-row"]');
  expect(row.exists()).toBe(true);
  expect(row.attributes('data-status')).toBe('green');
});