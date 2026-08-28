import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../src/api/dashboard.js', () => ({
  dashboardApi: {
    getSiteReplicationMatrixAll: vi.fn(() => Promise.resolve({
      data: {
        siteRefreshSeconds: 10,
        primaries: []
      }
    })),
    getSiteReplicationMatrixPairHistory: vi.fn(() => Promise.resolve({
      data: { source: 'X', dest: 'Y', limit: 10, entries: [] }
    }))
  }
}));

import SiteReplicationMatrixAllView from '../src/views/admin/SiteReplicationMatrixAllView.vue';
import { dashboardApi } from '../src/api/dashboard.js';

// 2026-08-28 round-45: R42 复制日志监控 absorbed into this view. The
// per-port columns (R35) are gone — partner row now shows status pill +
// caret expansion. /all envelope no longer carries `ports`, `perPort`,
// `lastProbeAt`, or `portHealth`. Per-pair history comes from a separate
// /pair-history endpoint, lazy-fetched on caret click.
const basePayload = () => ({
  siteRefreshSeconds: 10,
  primaries: [
    {
      dcName: 'DC-BJ-01', siteId: 1, siteName: '核心站点',
      regionCode: 'BJ', isHub: true,
      isBridgehead: true,
      dcs: [
        { dcName: 'DC-BJ-01', isBridgehead: true, isPdc: true, isGc: true,
          isRidMaster: false, isSchemaMaster: false, isDomainNamingMaster: false,
          isInfrastructureMaster: false, osVersion: 'Win2022', discoveredAt: '2026-08-27T08:00:00Z' },
        { dcName: 'DC-BJ-02', isBridgehead: false, isPdc: false, isGc: true,
          isRidMaster: true, isSchemaMaster: true, isDomainNamingMaster: false,
          isInfrastructureMaster: false, osVersion: 'Win2019', discoveredAt: '2026-08-27T08:00:00Z' }
      ],
      dcPartners: [
        { dcName: 'DC-BJ-01', isBridgehead: true, isPdc: true, isGc: true,
          isRidMaster: false, isSchemaMaster: false, isDomainNamingMaster: false,
          isInfrastructureMaster: false, osVersion: 'Win2022', discoveredAt: '2026-08-27T08:00:00Z',
          partners: [
            { peerDc: 'DC-BJ-02', peerSite: '核心站点', peerSiteIsHub: true,
              peerType: 'within', statusCode: 0,
              errorMessage: null,
              lastAttemptTime: '2026-08-28T01:00:30Z',
              lastSuccessTime: '2026-08-28T01:00:00Z' }
          ] },
        { dcName: 'DC-BJ-02', isBridgehead: false, isPdc: false, isGc: true,
          isRidMaster: true, isSchemaMaster: true, isDomainNamingMaster: false,
          isInfrastructureMaster: false, osVersion: 'Win2019', discoveredAt: '2026-08-27T08:00:00Z',
          partners: [] }
      ]
    },
    {
      dcName: 'DC-SH-01', siteId: 2, siteName: '上海站点',
      regionCode: 'SH', isHub: false,
      isBridgehead: false,
      dcs: [
        { dcName: 'DC-SH-01', isBridgehead: false, isPdc: false, isGc: false,
          isRidMaster: false, isSchemaMaster: false, isDomainNamingMaster: false,
          isInfrastructureMaster: false, osVersion: 'Win2019', discoveredAt: '2026-08-27T08:00:00Z' }
      ],
      dcPartners: [
        { dcName: 'DC-SH-01', isBridgehead: false, isPdc: false, isGc: false,
          isRidMaster: false, isSchemaMaster: false, isDomainNamingMaster: false,
          isInfrastructureMaster: false, osVersion: 'Win2019', discoveredAt: '2026-08-27T08:00:00Z',
          partners: [
            { peerDc: 'DC-BJ-01', peerSite: '核心站点', peerSiteIsHub: true,
              peerType: 'bridgehead', statusCode: 2,
              errorMessage: 'RPC server unavailable',
              lastAttemptTime: '2026-08-28T00:55:00Z',
              lastSuccessTime: null }
          ] }
      ]
    }
  ]
});

const historyPayload = (entries) => ({
  data: {
    source: 'X', dest: 'Y', limit: 10,
    entries
  }
});

beforeEach(() => {
  dashboardApi.getSiteReplicationMatrixAll.mockReset();
  dashboardApi.getSiteReplicationMatrixPairHistory.mockReset();
  dashboardApi.getSiteReplicationMatrixPairHistory.mockResolvedValue(historyPayload([]));
});
afterEach(() => {
  vi.useRealTimers();
});

test('mounts and renders hub-first site blocks with hub badge', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  const blocks = w.findAll('section.site-block');
  expect(blocks).toHaveLength(2);
  expect(blocks[0].text()).toContain('核心站点');
  expect(blocks[0].find('h3 .hub-badge.yes').exists()).toBe(true);
  expect(blocks[0].text()).toContain('2 DC');
  expect(blocks[1].text()).toContain('上海站点');
  expect(blocks[1].find('h3 .hub-badge.no').exists()).toBe(true);
  expect(blocks[1].text()).toContain('1 DC');
});

test('round-45: per-DC partner tables render without port columns', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();

  const dcBlocks = w.findAll('.dc-block');
  expect(dcBlocks).toHaveLength(3);

  // DC-BJ-01: PDC + GC + 桥头 + Win2022 + 1 partner
  const bj01Block = w.find('[data-test-dc-block="DC-BJ-01"]');
  expect(bj01Block.text()).toContain('DC-BJ-01');
  expect(bj01Block.text()).toContain('PDC');
  expect(bj01Block.text()).toContain('GC');
  expect(bj01Block.text()).toContain('桥头');
  expect(bj01Block.text()).toContain('Win2022');
  expect(bj01Block.text()).toContain('1 伙伴');

  // round-45: no .port-summary, no .port-hdr, no .port-cell
  expect(bj01Block.find('.port-summary').exists()).toBe(false);
  expect(bj01Block.find('.port-hdr').exists()).toBe(false);
  expect(bj01Block.find('.port-cell').exists()).toBe(false);
});

test('round-45: status pill renders 复制成功 for statusCode=0', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();

  const okRow = w.find('[data-test="partner-within-DC-BJ-01-DC-BJ-02"]');
  expect(okRow.exists()).toBe(true);
  const pill = okRow.find('.status-pill');
  expect(pill.exists()).toBe(true);
  expect(pill.text()).toBe('复制成功');
  expect(pill.classes()).toContain('status-pill-ok');
  expect(okRow.find('.err-msg').exists()).toBe(false);
});

test('round-45: status pill renders 失败 + error message for statusCode=2', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();

  const errRow = w.find('[data-test="partner-bridgehead-DC-SH-01-DC-BJ-01"]');
  expect(errRow.exists()).toBe(true);
  const pill = errRow.find('.status-pill');
  expect(pill.exists()).toBe(true);
  expect(pill.text()).toBe('失败');
  expect(pill.classes()).toContain('status-pill-err');
  // Inline error message visible
  expect(errRow.find('.err-msg').text()).toContain('RPC server unavailable');
});

test('round-45: matrix table headers show caret / 类型 / 伙伴 / 状态 / 最近成功', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  const headers = w.findAll('section.site-block .dc-block table thead th');
  const texts = headers.map(h => h.text());
  expect(texts).toContain('类型');
  expect(texts).toContain('伙伴站点');
  expect(texts).toContain('伙伴 DC');
  expect(texts).toContain('当前状态');
  expect(texts).toContain('最近成功');
  // round-45: no port headers
  expect(texts.some(t => /^\d+$/.test(t))).toBe(false);
  expect(texts.some(t => t.includes('端口'))).toBe(false);
});

test('round-45: caret button starts collapsed (▶)', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();

  const caret = w.find('[data-test="caret-DC-BJ-01-DC-BJ-02"]');
  expect(caret.exists()).toBe(true);
  expect(caret.text()).toBe('▶');
  // No attempts row initially
  expect(w.find('[data-test="attempts-DC-BJ-01-DC-BJ-02"]').exists()).toBe(false);
});

test('round-45: clicking caret expands row + lazy-fetches pair-history', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const entries = [
    { attemptAt: '2026-08-28T01:00:30Z', statusCode: 0,
      durationMs: 1234, objectsTransferred: 42,
      lastSuccessTime: '2026-08-28T01:00:00Z', errorMessage: null },
    { attemptAt: '2026-08-28T00:55:00Z', statusCode: 2,
      durationMs: null, objectsTransferred: null,
      lastSuccessTime: null, errorMessage: 'RPC server unavailable' }
  ];
  dashboardApi.getSiteReplicationMatrixPairHistory.mockResolvedValue(historyPayload(entries));

  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  expect(dashboardApi.getSiteReplicationMatrixPairHistory).not.toHaveBeenCalled();

  // Click the caret — calls API with dest=peerDc, source=thisDC
  await w.find('[data-test="caret-DC-BJ-01-DC-BJ-02"]').trigger('click');
  await flushPromises();

  expect(dashboardApi.getSiteReplicationMatrixPairHistory).toHaveBeenCalledTimes(1);
  const callArgs = dashboardApi.getSiteReplicationMatrixPairHistory.mock.calls[0];
  // signature: getSiteReplicationMatrixPairHistory(destDc, sourceDc, limit)
  expect(callArgs[0]).toBe('DC-BJ-02');
  expect(callArgs[1]).toBe('DC-BJ-01');
  expect(callArgs[2]).toBe(10);

  const attemptsRow = w.find('[data-test="attempts-DC-BJ-01-DC-BJ-02"]');
  expect(attemptsRow.exists()).toBe(true);
  expect(attemptsRow.findAll('.att-row')).toHaveLength(2);

  // Caret flipped to ▼
  expect(w.find('[data-test="caret-DC-BJ-01-DC-BJ-02"]').text()).toBe('▼');
});

test('round-45: second click on caret collapses without re-fetching', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  dashboardApi.getSiteReplicationMatrixPairHistory.mockResolvedValue(historyPayload([]));

  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();

  const caret = w.find('[data-test="caret-DC-BJ-01-DC-BJ-02"]');
  await caret.trigger('click'); await flushPromises();
  expect(dashboardApi.getSiteReplicationMatrixPairHistory).toHaveBeenCalledTimes(1);
  await caret.trigger('click'); await flushPromises();
  expect(dashboardApi.getSiteReplicationMatrixPairHistory).toHaveBeenCalledTimes(1); // unchanged
  expect(w.find('[data-test="attempts-DC-BJ-01-DC-BJ-02"]').exists()).toBe(false);
});

test('round-45: empty history entries render "暂无历史记录"', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  dashboardApi.getSiteReplicationMatrixPairHistory.mockResolvedValue(historyPayload([]));

  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  await w.find('[data-test="caret-DC-BJ-01-DC-BJ-02"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="attempts-DC-BJ-01-DC-BJ-02"]').text()).toContain('暂无历史记录');
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
  expect(dashboardApi.getSiteReplicationMatrixAll).toHaveBeenCalledTimes(1);
});

test('round-32: each partner row has a 类型 cell with within/bridgehead tag', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();

  const withinRow = w.find('[data-test="partner-within-DC-BJ-01-DC-BJ-02"]');
  expect(withinRow.find('.peer-tag-within').exists()).toBe(true);
  expect(withinRow.find('.peer-tag-within').text()).toBe('本站');

  const bridgeheadRow = w.find('[data-test="partner-bridgehead-DC-SH-01-DC-BJ-01"]');
  expect(bridgeheadRow.find('.peer-tag-bridgehead').exists()).toBe(true);
  expect(bridgeheadRow.find('.peer-tag-bridgehead').text()).toBe('桥头');
});

test('round-36: empty dcPartners array renders "该站点暂无 DC" empty state', async () => {
  const empty = {
    siteRefreshSeconds: 10,
    primaries: [{
      dcName: 'DC-X', siteId: 9, siteName: '空站点',
      regionCode: null, isHub: false, isBridgehead: false,
      dcs: [], dcPartners: []
    }]
  };
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: empty });
  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  const blocks = w.findAll('section.site-block');
  expect(blocks).toHaveLength(1);
  expect(blocks[0].text()).toContain('该站点暂无 DC');
});
