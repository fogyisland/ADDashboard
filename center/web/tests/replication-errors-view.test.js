// 2026-09-01 R74 — ReplicationErrorsView test suite.
//
// Validates the focused "what's broken right now" triage view:
//   - renders the table when the API returns failures
//   - empty state when there are no failures
//   - status pill colour maps correctly (statusCode 2 = err/red, 1 = warn/yellow)
//   - window select drives a refetch (24h/7d)
//   - loading + error banners appear at the right times
//   - 30s polling is wired (interval re-fires the API)

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../src/api/dashboard.js', () => ({
  dashboardApi: {
    replicationErrors: vi.fn()
  }
}));

import ReplicationErrorsView from '../src/views/admin/ReplicationErrorsView.vue';
import { dashboardApi } from '../src/api/dashboard.js';

const globalStubs = {
  stubs: {
    AdminLayout: { template: '<div class="admin-layout-stub"><slot /></div>' }
  }
};

function makeErr(overrides = {}) {
  return {
    sourceDc: 'DC-A',
    destDc: 'DC-B',
    namingContext: 'DC=corp,DC=example,DC=com',
    statusCode: 2,
    lastAttemptTime: '2026-09-01T08:00:00Z',
    lastSuccessTime: '2026-09-01T06:00:00Z',
    attemptCount: 47,
    errorMessage: 'RPC server unavailable',
    durationMs: 3600000,
    ...overrides
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.resetAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// 1. empty state
test('shows empty state when API returns zero errors', async () => {
  dashboardApi.replicationErrors.mockResolvedValue({ data: { window: '24h', errors: [], total: 0 } });
  const w = mount(ReplicationErrorsView, { global: globalStubs });
  await flushPromises();
  expect(dashboardApi.replicationErrors).toHaveBeenCalledTimes(1);
  expect(dashboardApi.replicationErrors).toHaveBeenCalledWith({ window: '24h' });
  expect(w.find('[data-test="empty-state"]').exists()).toBe(true);
  expect(w.find('[data-test="empty-state"]').text()).toMatch(/无复制错误/);
});

// 2. happy path — table renders one row per error
test('renders one tr.err-row per failed replication pair', async () => {
  dashboardApi.replicationErrors.mockResolvedValue({
    data: {
      window: '24h',
      total: 3,
      errors: [
        makeErr({ sourceDc: 'DC-1', destDc: 'DC-2' }),
        makeErr({ sourceDc: 'DC-2', destDc: 'DC-3', statusCode: 1 }),
        makeErr({ sourceDc: 'DC-3', destDc: 'DC-1', statusCode: 2, errorMessage: null, lastSuccessTime: null, durationMs: null })
      ]
    }
  });
  const w = mount(ReplicationErrorsView, { global: globalStubs });
  await flushPromises();
  expect(w.findAll('tr.err-row')).toHaveLength(3);
  // Ribbon shows totalAttempts = 47 + (default 47) + 47 = 141
  const tiles = w.findAll('.ribbon-tile .ribbon-num');
  expect(tiles[0].text()).toBe('3');  // 错误链路
  expect(tiles[3].text()).toBe('141'); // 总尝试次数
});

// 3. status pill — 失败 (red) for statusCode 2
test('statusCode 2 → status-pill-err with 失败 label', async () => {
  dashboardApi.replicationErrors.mockResolvedValue({
    data: { window: '24h', total: 1, errors: [makeErr({ statusCode: 2 })] }
  });
  const w = mount(ReplicationErrorsView, { global: globalStubs });
  await flushPromises();
  const pill = w.find('[data-test="status-pill-err"]');
  expect(pill.exists()).toBe(true);
  expect(pill.text()).toContain('失败');
  expect(w.find('tr.err-row').classes()).toContain('status-err');
});

// 4. status pill — 部分失败 (yellow) for statusCode 1
test('statusCode 1 → status-pill-warn with 部分失败 label', async () => {
  dashboardApi.replicationErrors.mockResolvedValue({
    data: { window: '24h', total: 1, errors: [makeErr({ statusCode: 1 })] }
  });
  const w = mount(ReplicationErrorsView, { global: globalStubs });
  await flushPromises();
  const pill = w.find('[data-test="status-pill-warn"]');
  expect(pill.exists()).toBe(true);
  expect(pill.text()).toContain('部分失败');
  expect(w.find('tr.err-row').classes()).toContain('status-warn');
});

// 5. window select — switching to 7d triggers a refetch
test('changing window select refetches with the new key', async () => {
  dashboardApi.replicationErrors.mockResolvedValue({ data: { window: '24h', errors: [], total: 0 } });
  const w = mount(ReplicationErrorsView, { global: globalStubs });
  await flushPromises();
  expect(dashboardApi.replicationErrors).toHaveBeenCalledTimes(1);

  await w.find('[data-test="window-select"]').setValue('7d');
  await flushPromises();
  expect(dashboardApi.replicationErrors).toHaveBeenCalledTimes(2);
  expect(dashboardApi.replicationErrors.mock.calls[1][0]).toEqual({ window: '7d' });
});

// 6. polling — interval fires every 30s and re-issues the API
test('polling re-fires the API every 30 seconds', async () => {
  dashboardApi.replicationErrors.mockResolvedValue({ data: { window: '24h', errors: [], total: 0 } });
  mount(ReplicationErrorsView, { global: globalStubs });
  await flushPromises();
  expect(dashboardApi.replicationErrors).toHaveBeenCalledTimes(1);

  // Advance 30s — first tick fires
  await vi.advanceTimersByTimeAsync(30_000);
  await flushPromises();
  expect(dashboardApi.replicationErrors).toHaveBeenCalledTimes(2);

  // Advance another 30s — second tick fires
  await vi.advanceTimersByTimeAsync(30_000);
  await flushPromises();
  expect(dashboardApi.replicationErrors).toHaveBeenCalledTimes(3);
});

// 7. error banner — surfaces the API's error response
test('shows error-banner when the API rejects', async () => {
  dashboardApi.replicationErrors.mockRejectedValue({ response: { data: { error: 'invalid window' } } });
  const w = mount(ReplicationErrorsView, { global: globalStubs });
  await flushPromises();
  const banner = w.find('.error-banner');
  expect(banner.exists()).toBe(true);
  expect(banner.text()).toBe('invalid window');
});

// 8. refresh button — manual click re-fetches
test('clicking refresh button re-issues the API call', async () => {
  dashboardApi.replicationErrors.mockResolvedValue({ data: { window: '24h', errors: [], total: 0 } });
  const w = mount(ReplicationErrorsView, { global: globalStubs });
  await flushPromises();
  expect(dashboardApi.replicationErrors).toHaveBeenCalledTimes(1);
  await w.find('[data-test="refresh-btn"]').trigger('click');
  await flushPromises();
  expect(dashboardApi.replicationErrors).toHaveBeenCalledTimes(2);
});

// 9. error row key — composite key keeps duplicate (source,dest) pairs but
//    different naming_contexts as separate rows. (Spec example key shape.)
test('row key uses sourceDc|destDc|namingContext composite', async () => {
  dashboardApi.replicationErrors.mockResolvedValue({
    data: {
      window: '24h',
      total: 2,
      errors: [
        makeErr({ namingContext: 'CN=Configuration,DC=corp,DC=example,DC=com' }),
        makeErr({ namingContext: 'CN=Schema,DC=corp,DC=example,DC=com' })
      ]
    }
  });
  const w = mount(ReplicationErrorsView, { global: globalStubs });
  await flushPromises();
  expect(w.findAll('tr.err-row')).toHaveLength(2);
});

// 10. naming_context — long DN gets truncated with ellipsis
test('long namingContext is truncated with ellipsis in the cell', async () => {
  const longNc = 'CN=Users,DC=corp,DC=example,DC=com,DC=verylongtld,DC=anotherone,DC=morenamespace';
  dashboardApi.replicationErrors.mockResolvedValue({
    data: { window: '24h', total: 1, errors: [makeErr({ namingContext: longNc })] }
  });
  const w = mount(ReplicationErrorsView, { global: globalStubs });
  await flushPromises();
  const ncCell = w.find('code.nc');
  expect(ncCell.text()).toMatch(/…$/);
  // The full NC stays in the title attribute for hover tooltip.
  expect(ncCell.attributes('title')).toBe(longNc);
});

// 11. duration formatting — null durationMs renders as "—"
test('null durationMs renders as "—"; numeric ms renders as 秒/分/小时/天', async () => {
  dashboardApi.replicationErrors.mockResolvedValue({
    data: {
      window: '24h',
      total: 4,
      errors: [
        makeErr({ sourceDc: 'DC-1', destDc: 'DC-2', durationMs: null }),
        makeErr({ sourceDc: 'DC-2', destDc: 'DC-3', durationMs: 45_000 }),     // 45 秒
        makeErr({ sourceDc: 'DC-3', destDc: 'DC-4', durationMs: 600_000 }),    // 10 分
        makeErr({ sourceDc: 'DC-4', destDc: 'DC-5', durationMs: 7_200_000 })   // 2 小时
      ]
    }
  });
  const w = mount(ReplicationErrorsView, { global: globalStubs });
  await flushPromises();
  const durations = w.findAll('.err-row td:nth-child(8)');
  expect(durations[0].text()).toBe('—');
  expect(durations[1].text()).toMatch(/秒/);
  expect(durations[2].text()).toMatch(/分/);
  expect(durations[3].text()).toMatch(/小时/);
});

// 12. lastSuccessTime null renders as "—"
test('null lastSuccessTime renders as "—" in the cell', async () => {
  dashboardApi.replicationErrors.mockResolvedValue({
    data: {
      window: '24h',
      total: 1,
      errors: [makeErr({ lastSuccessTime: null })]
    }
  });
  const w = mount(ReplicationErrorsView, { global: globalStubs });
  await flushPromises();
  const cells = w.findAll('tr.err-row td');
  // 7th column = 最近成功
  expect(cells[6].text()).toBe('—');
});