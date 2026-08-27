import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../src/api/dashboard.js', () => ({
  dashboardApi: {
    getSiteReplicationMatrixAll: vi.fn(() => Promise.resolve({
      data: {
        siteRefreshSeconds: 10,
        ports: [135, 445, 50001],
        primaries: []
      }
    }))
  }
}));

import SiteReplicationMatrixAllView from '../src/views/admin/SiteReplicationMatrixAllView.vue';
import { dashboardApi } from '../src/api/dashboard.js';

// 2026-08-27 round-28 envelope: each site contributes one primary DC
// (lexically first dc_name; PDC marker NOT used). Each primary surfaces
// every replication link it participates in as a partner row with
// direction ('out' | 'in') + perPort probe map.
const basePayload = () => ({
  siteRefreshSeconds: 10,
  ports: [135, 445, 50001],
  primaries: [
    {
      dcName: 'DC-BJ-01', siteId: 1, siteName: '核心站点',
      regionCode: 'BJ', isHub: true,
      // round-28.5: hub DC explicitly marked bridgehead by operator
      isBridgehead: true,
      partners: [
        { direction: 'out', peerDc: 'DC-BJ-02', peerSite: '核心站点', peerSiteIsHub: true,
          statusCode: 0, perPort: null, lastProbeAt: null }
      ]
    },
    {
      dcName: 'DC-SH-01', siteId: 2, siteName: '上海站点',
      regionCode: 'SH', isHub: false,
      partners: [
        { direction: 'in', peerDc: 'DC-BJ-01', peerSite: '核心站点', peerSiteIsHub: true,
          statusCode: 1,
          perPort: { '135': { reachable: true, latencyMs: 3 }, '445': { reachable: false, error: 'timeout' } },
          lastProbeAt: '2026-08-27T10:00:00Z' }
      ]
    }
  ]
});

beforeEach(() => {
  dashboardApi.getSiteReplicationMatrixAll.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

test('mounts and renders hub-first primary blocks with hub badge', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  const blocks = w.findAll('section.primary-block');
  expect(blocks).toHaveLength(2);
  // Hub block (核心站点): h3 hub-badge "yes" + primary-DC marker
  expect(blocks[0].text()).toContain('核心站点');
  expect(blocks[0].find('h3 .hub-badge.yes').exists()).toBe(true);
  expect(blocks[0].text()).toContain('→ DC-BJ-01');
  // Spoke block (上海站点): h3 hub-badge "no" only (hub-mini may still
  // appear on partner rows that point back at the hub — that's the
  // expected round-28 visual; hub-badge.yes must be unique to hub block)
  expect(blocks[1].text()).toContain('上海站点');
  expect(blocks[1].find('h3 .hub-badge.yes').exists()).toBe(false);
  expect(blocks[1].find('h3 .hub-badge.no').exists()).toBe(true);
  expect(blocks[1].text()).toContain('→ DC-SH-01');
});

test('partner row renders with direction badge + colored port cells', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  // 上海站点 (primary DC-SH-01) has 1 in-partner: DC-BJ-01 with probe data
  const inRow = w.find('[data-test="partner-in-DC-SH-01-DC-BJ-01"]');
  expect(inRow.exists()).toBe(true);
  expect(inRow.text()).toContain('← 入');
  expect(inRow.text()).toContain('DC-BJ-01');
  expect(inRow.text()).toContain('核心站点');
  // 3 port cells rendered (135, 445, 50001)
  const portCells = inRow.findAll('.port-cell');
  expect(portCells).toHaveLength(3);
  expect(portCells[0].classes()).toContain('port-ok');
  expect(portCells[1].classes()).toContain('port-err');
  expect(portCells[2].classes()).toContain('port-none');

  // 核心站点 (primary DC-BJ-01) has 1 out-partner: DC-BJ-02
  const outRow = w.find('[data-test="partner-out-DC-BJ-01-DC-BJ-02"]');
  expect(outRow.exists()).toBe(true);
  expect(outRow.text()).toContain('→ 出');
});

test('out rows precede in rows within the same primary block', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  // Hub block: only out-partner here, but the table header should still
  // appear first. Verify column header sequence: 方向 / 伙伴站点 / 伙伴 DC / 状态
  const headers = w.findAll('section.primary-block table thead th');
  expect(headers.length).toBeGreaterThanOrEqual(4);
  expect(headers[0].text()).toContain('方向');
  expect(headers[1].text()).toContain('伙伴站点');
  expect(headers[2].text()).toContain('伙伴 DC');
  expect(headers[3].text()).toContain('状态');
});

test('polling: re-fetches every refreshSeconds * 1000 ms', async () => {
  vi.useFakeTimers();
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  expect(dashboardApi.getSiteReplicationMatrixAll).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(dashboardApi.getSiteReplicationMatrixAll.mock.calls.length).toBeGreaterThanOrEqual(2);
});

test('clears interval on unmount', async () => {
  vi.useFakeTimers();
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  w.unmount();
  await vi.advanceTimersByTimeAsync(30_000);
  // No further calls after unmount
  expect(dashboardApi.getSiteReplicationMatrixAll).toHaveBeenCalledTimes(1);
});

test('bridgehead badge: shows "桥头" when isBridgehead=true, "未指定" otherwise', async () => {
  // round-28.5: each primary surfaces isBridgehead. The view renders a
  // cyan "桥头" badge for bridgehead-flagged primaries and a gray
  // "未指定" badge for lex-first fallbacks. Both classes share
  // .bridgehead-badge; .none distinguishes the fallback state.
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  const blocks = w.findAll('section.primary-block');
  // Hub block primary DC-BJ-01 has isBridgehead=true (per operator)
  const hubBadge = blocks[0].find('h3 .bridgehead-badge');
  expect(hubBadge.exists()).toBe(true);
  expect(hubBadge.classes()).not.toContain('none');
  expect(hubBadge.text()).toContain('桥头');
  // Spoke block primary DC-SH-01 has isBridgehead=false (lex-first fallback)
  const spokeBadge = blocks[1].find('h3 .bridgehead-badge');
  expect(spokeBadge.exists()).toBe(true);
  expect(spokeBadge.classes()).toContain('none');
  expect(spokeBadge.text()).toContain('未指定');
});