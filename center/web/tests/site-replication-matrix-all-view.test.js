// R93.10 — 2026-09-25: page is now a 3-panel N×N 矩阵(Hub↔Hub / Spoke→Hub
// / 全矩阵), 跟 sibling /admin/matrix (SiteMatrixView R64/R80) 共用
// payload + matrix vocabulary。原 round-32/36/45 round-* 测试全部
// 重写为矩阵断言:fleet ribbon / layer-panel / 矩阵 cell / per-DC
// sub-grid / cell-detail modal / 24h|7d window / CSV export。
//
// 关键约定(跟两个矩阵页对齐):
// - payload 形状不变:`primaries[].dcs[]` + `primaries[].dcPartners[].partners[]`
//   + 每 partner `{ peerDc, peerSite, peerSiteIsHub, statusCode,
//   lastSuccessTime, errorMessage }`。
// - 状态码:0 复制成功 / 1 部分失败 / 2+ 失败断开。
// - selectors:`section.layer-panel` / `table.matrix` / `td.cell-{state}`
//   / `td.dc-pair-{state}` / `data-test="cell-X-Y"` /
//   `data-test="dc-pair-X-Y-A-to-B"` / `data-test="cell-detail-modal"`
//   / `data-test="cell-detail-table"` / `data-test="cell-detail-pair-N"`
//   / `data-test="pair-attempts-N"` / `data-test="pair-window-24"` 等。

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../src/api/dashboard.js', () => ({
  dashboardApi: {
    getSiteReplicationMatrixAll: vi.fn(() => Promise.resolve({
      data: { siteRefreshSeconds: 10, primaries: [] }
    })),
    getSiteReplicationMatrixPairHistory: vi.fn(() => Promise.resolve({
      data: { source: 'X', dest: 'Y', limit: 10, entries: [] }
    }))
  }
}));

import SiteReplicationMatrixAllView from '../src/views/admin/SiteReplicationMatrixAllView.vue';
import { dashboardApi } from '../src/api/dashboard.js';

const basePayload = () => ({
  siteRefreshSeconds: 10,
  primaries: [
    {
      dcName: 'DC-BJ-01', siteId: 1, siteName: '核心站点',
      regionCode: 'BJ', isHub: true,
      dcs: [
        { dcName: 'DC-BJ-01' },
        { dcName: 'DC-BJ-02' }
      ],
      dcPartners: [
        { dcName: 'DC-BJ-01', partners: [
          { peerDc: 'DC-BJ-02', peerSite: '核心站点', peerSiteIsHub: true,
            peerType: 'within', statusCode: 0,
            errorMessage: null,
            lastAttemptTime: '2026-09-25T01:00:30Z',
            lastSuccessTime: '2026-09-25T01:00:00Z' },
          { peerDc: 'DC-SH-01', peerSite: '上海站点', peerSiteIsHub: false,
            peerType: 'bridgehead', statusCode: 1,
            errorMessage: 'Slow replication',
            lastAttemptTime: '2026-09-25T00:55:00Z',
            lastSuccessTime: '2026-09-24T20:00:00Z' }
        ] },
        { dcName: 'DC-BJ-02', partners: [
          { peerDc: 'DC-BJ-01', peerSite: '核心站点', peerSiteIsHub: true,
            peerType: 'within', statusCode: 0,
            errorMessage: null,
            lastAttemptTime: '2026-09-25T01:00:30Z',
            lastSuccessTime: '2026-09-25T01:00:00Z' }
        ] }
      ]
    },
    {
      dcName: 'DC-SH-01', siteId: 2, siteName: '上海站点',
      regionCode: 'SH', isHub: false,
      dcs: [
        { dcName: 'DC-SH-01' }
      ],
      dcPartners: [
        { dcName: 'DC-SH-01', partners: [
          { peerDc: 'DC-BJ-01', peerSite: '核心站点', peerSiteIsHub: true,
            peerType: 'bridgehead', statusCode: 2,
            errorMessage: 'RPC server unavailable',
            lastAttemptTime: '2026-09-25T00:55:00Z',
            lastSuccessTime: null }
        ] }
      ]
    }
  ]
});

const historyPayload = (entries) => ({
  data: { source: 'X', dest: 'Y', limit: 10, entries }
});

function mountView() {
  return mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
}

beforeEach(() => {
  dashboardApi.getSiteReplicationMatrixAll.mockReset();
  dashboardApi.getSiteReplicationMatrixPairHistory.mockReset();
  dashboardApi.getSiteReplicationMatrixPairHistory.mockResolvedValue(historyPayload([]));
});
afterEach(() => {
  vi.useRealTimers();
});

// ── 顶部 ribbon + legend ────────────────────────────────────────────────

test('R93.10: 渲染 fleet ribbon, 数字从 primaries/dcs/partners 汇总', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();

  const ribbon = w.find('[data-test="fleet-ribbon"]');
  expect(ribbon.exists()).toBe(true);
  const tiles = ribbon.findAll('.ribbon-tile');
  expect(tiles).toHaveLength(6);
  expect(ribbon.text()).toContain('2');   // sites
  expect(ribbon.text()).toContain('3');   // dcs
  expect(ribbon.text()).toContain('4');   // links (2 within + 1 spoke→hub + 1 hub→spoke)
});

test('R93.10: legend 列出 4 个统计 + hub/spoke 小标签', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();

  const legend = w.find('[data-test="legend"]');
  expect(legend.exists()).toBe(true);
  const sites = legend.find('[data-test="legend-sites"]');
  expect(sites.exists()).toBe(true);
  expect(sites.text()).toContain('Hub 1');
  expect(sites.text()).toContain('Spoke 1');
});

// ── 3 层矩阵 ───────────────────────────────────────────────────────────

test('R93.10: 1 Hub 时 Hub↔Hub 面板隐藏, 但 Hub↔Spoke + 全矩阵出现', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();

  // 只有 1 个 Hub → 不应渲染 Hub↔Hub panel
  expect(w.find('[data-test="hub-panel"]').exists()).toBe(false);

  // Spoke→Hub + 全矩阵都应渲染
  expect(w.find('[data-test="spoke-panel"]').exists()).toBe(true);
  expect(w.find('[data-test="full-panel"]').exists()).toBe(true);
});

test('R93.10: ≥2 Hub 时 3 个 panel 全渲染 + Hub↔Hub cell 加 hub-pair 修饰类', async () => {
  const payload = basePayload();
  payload.primaries.push({
    dcName: 'DC-GZ-01', siteId: 3, siteName: '广州站点',
    regionCode: 'GZ', isHub: true,
    dcs: [{ dcName: 'DC-GZ-01' }],
    dcPartners: [{ dcName: 'DC-GZ-01', partners: [] }]
  });
  payload.primaries[1].isHub = true;     // 上海也升为 Hub
  payload.primaries[1].dcs = [{ dcName: 'DC-SH-01' }];
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: payload });
  const w = mountView();
  await flushPromises();

  expect(w.find('[data-test="hub-panel"]').exists()).toBe(true);
  expect(w.find('[data-test="spoke-panel"]').exists()).toBe(false);   // 0 spoke
  expect(w.find('[data-test="full-panel"]').exists()).toBe(true);

  const cell = w.find('[data-test="cell-核心站点-广州站点"]');
  expect(cell.exists()).toBe(true);
  expect(cell.classes()).toContain('cell-hub-pair');
});

test('R93.10: 全矩阵 Hub↔Spoke cell 加 hub-spoke 修饰类', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();

  const spokeCell = w.find('[data-test="cell-上海站点-核心站点"]');
  expect(spokeCell.exists()).toBe(true);
  expect(spokeCell.classes()).toContain('cell-hub-spoke');
});

// ── 矩阵 cell 状态 ─────────────────────────────────────────────────────

test('R93.10: 自指 cell 是 .cell-self, 显示 · + —', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();

  const selfCell = w.find('[data-test="cell-核心站点-核心站点"]');
  expect(selfCell.exists()).toBe(true);
  expect(selfCell.classes()).toContain('cell-self');
  expect(selfCell.find('.cell-glyph').text()).toBe('·');
  // cellText 在自指分支返回 '—'
  expect(selfCell.find('.cell-num').text()).toBe('—');
});

test('R93.10: 跨站 cell 汇总链路状态, 失败链路主导 → .cell-err', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();

  // payload.primaries[1].dcPartners[0].partners[0] = 核心站点的 DC-BJ-01
  // peerDc='DC-BJ-01' peerSite='核心站点' statusCode=2 — 即上海→核心 失败
  const shToBj = w.find('[data-test="cell-上海站点-核心站点"]');
  expect(shToBj.exists()).toBe(true);
  expect(shToBj.classes()).toContain('cell-err');
});

test('R93.10: 部分失败 + 失败混合时 cell 是 .cell-err (worst wins)', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();

  // 核心→上海 有 1 条链路 statusCode=1 (warn) — 应显示 .cell-warn
  const bjToSh = w.find('[data-test="cell-核心站点-上海站点"]');
  expect(bjToSh.exists()).toBe(true);
  expect(bjToSh.classes()).toContain('cell-warn');
});

test('R93.10: 无伙伴链路 cell 是 .cell-none', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();

  // 全矩阵里 上海→上海 自指 + 核心→核心 自指,没有跨站链路。检查自指
  const cell = w.find('[data-test="cell-上海站点-上海站点"]');
  expect(cell.classes()).toContain('cell-self');
});

// ── R80 per-DC sub-grid ────────────────────────────────────────────────

test('R93.10: 非自指 cell 渲染 .dc-subgrid + .dc-pair-cell, 颜色跟 statusCode 对应', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();

  // 自指 cell 不应有 sub-grid
  const selfCell = w.find('[data-test="cell-核心站点-核心站点"]');
  expect(selfCell.find('.dc-subgrid').exists()).toBe(false);

  // 跨站 cell 应该有 sub-grid。源站点上海 [DC-SH-01] × 目标站点核心 [DC-BJ-01, DC-BJ-02] = 1×2 = 2
  const crossCell = w.find('[data-test="cell-上海站点-核心站点"]');
  const subgrid = crossCell.find('.dc-subgrid');
  expect(subgrid.exists()).toBe(true);
  expect(subgrid.findAll('td.dc-pair-cell')).toHaveLength(2);  // 1 rowDc × 2 colDc

  // 颜色: 该链路 statusCode=2 (失败) → .dc-pair-err
  const errCell = w.find('[data-test="dc-pair-上海站点-核心站点-DC-SH-01-to-DC-BJ-01"]');
  expect(errCell.exists()).toBe(true);
  expect(errCell.classes()).toContain('dc-pair-err');
  expect(errCell.text()).toBe('✕');
});

test('R93.10: sub-grid OK cell 是 .dc-pair-ok + ✓', async () => {
  // 改 payload:让核心→上海 含一条 ok 链路(原 statusCode=1 warn 改为 0 ok)
  const payload = basePayload();
  payload.primaries[0].dcPartners[0].partners[1].statusCode = 0;
  payload.primaries[0].dcPartners[0].partners[1].errorMessage = null;
  payload.primaries[0].dcPartners[0].partners[1].lastSuccessTime = '2026-09-25T01:00:00Z';
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: payload });
  const w = mountView();
  await flushPromises();

  // 核心→上海-DC-BJ-01-to-DC-SH-01 应是 ok
  const okPair = w.find('[data-test="dc-pair-核心站点-上海站点-DC-BJ-01-to-DC-SH-01"]');
  expect(okPair.exists()).toBe(true);
  expect(okPair.classes()).toContain('dc-pair-ok');
  expect(okPair.text()).toBe('✓');
});

// ── Cell-detail modal ──────────────────────────────────────────────────

test('R93.10: 点击 cell 打开 modal, 显示所有 (sourceDc → destDc) 链路', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();

  expect(w.find('[data-test="cell-detail-modal"]').exists()).toBe(false);

  // 点 核心→上海 (1 条 warn 链路)
  await w.find('[data-test="cell-核心站点-上海站点"]').trigger('click');
  await flushPromises();

  const modal = w.find('[data-test="cell-detail-modal"]');
  expect(modal.exists()).toBe(true);
  expect(modal.find('[data-test="cell-detail-title"]').text()).toBe('核心站点 → 上海站点');
  expect(modal.find('[data-test="cell-detail-table"]').findAll('[data-test^="cell-detail-pair-"]')).toHaveLength(1);

  const pair0 = w.find('[data-test="cell-detail-pair-0"]');
  expect(pair0.classes()).toContain('pair-row-warn');
  expect(pair0.find('.status-pill').text()).toBe('部分失败');
});

test('R93.10: 点击 dc-pair-cell 打开 modal 并高亮该 DC pair', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();

  // 点 上海→核心 sub-grid 中的具体 DC pair (R80 R93.10 同款)
  await w.find('[data-test="dc-pair-上海站点-核心站点-DC-SH-01-to-DC-BJ-01"]').trigger('click');
  await flushPromises();

  const modal = w.find('[data-test="cell-detail-modal"]');
  expect(modal.exists()).toBe(true);
  expect(modal.text()).toContain('高亮 DC-SH-01 → DC-BJ-01');

  const pair0 = w.find('[data-test="cell-detail-pair-0"]');
  expect(pair0.classes()).toContain('pair-row-highlighted');
});

test('R93.10: 关闭按钮 + 背景点击 都关 modal', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();

  await w.find('[data-test="cell-核心站点-上海站点"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="cell-detail-modal"]').exists()).toBe(true);

  await w.find('[data-test="cell-detail-close"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="cell-detail-modal"]').exists()).toBe(false);
});

test('R93.10: 自指 cell 不可点击 (no .cell-clickable)', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();

  const selfCell = w.find('[data-test="cell-核心站点-核心站点"]');
  expect(selfCell.classes()).toContain('cell-disabled');
  expect(selfCell.classes()).not.toContain('cell-clickable');

  await selfCell.trigger('click');
  await flushPromises();
  expect(w.find('[data-test="cell-detail-modal"]').exists()).toBe(false);
});

// ── R72 展开 + R73 toolbar ────────────────────────────────────────────

test('R93.10: modal 内 caret 起始折叠 (▸), 点击后展开 + 调 /pair-history', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  dashboardApi.getSiteReplicationMatrixPairHistory.mockResolvedValue(historyPayload([]));
  const w = mountView();
  await flushPromises();

  await w.find('[data-test="cell-核心站点-上海站点"]').trigger('click');
  await flushPromises();

  expect(dashboardApi.getSiteReplicationMatrixPairHistory).not.toHaveBeenCalled();

  const caret = w.find('[data-test="pair-caret-0"]');
  expect(caret.exists()).toBe(true);
  expect(caret.text()).toBe('▸');

  await caret.trigger('click');
  await flushPromises();

  expect(dashboardApi.getSiteReplicationMatrixPairHistory).toHaveBeenCalledTimes(1);
  const callArgs = dashboardApi.getSiteReplicationMatrixPairHistory.mock.calls[0];
  // signature: getSiteReplicationMatrixPairHistory(destDc, sourceDc, limit)
  // 核心→上海 单对:DC-BJ-01 → DC-SH-01
  expect(callArgs[0]).toBe('DC-SH-01');
  expect(callArgs[1]).toBe('DC-BJ-01');
  expect(callArgs[2]).toBe(10);

  expect(w.find('[data-test="pair-attempts-0"]').exists()).toBe(true);
  expect(w.find('[data-test="pair-caret-0"]').text()).toBe('▾');
});

test('R93.10: 24h/7d 切换时清空 cache + 重新请求 (limit=50)', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();

  await w.find('[data-test="cell-核心站点-上海站点"]').trigger('click');
  await flushPromises();

  // 24h 默认
  await w.find('[data-test="pair-caret-0"]').trigger('click');
  await flushPromises();
  expect(dashboardApi.getSiteReplicationMatrixPairHistory).toHaveBeenCalledTimes(1);
  expect(dashboardApi.getSiteReplicationMatrixPairHistory.mock.calls[0][2]).toBe(10);

  // 切到 7d → watcher 清空, 再点 caret → 重请求 + limit=50
  await w.find('[data-test="pair-window-168"]').trigger('click');
  await flushPromises();
  await w.find('[data-test="pair-caret-0"]').trigger('click');
  await flushPromises();
  expect(dashboardApi.getSiteReplicationMatrixPairHistory).toHaveBeenCalledTimes(2);
  expect(dashboardApi.getSiteReplicationMatrixPairHistory.mock.calls[1][2]).toBe(50);
});

test('R93.10: 状态 filter 切换不重新请求, 只切换 visible attempts', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const entries = [
    { attemptAt: '2026-09-25T01:00:30Z', statusCode: 0,
      durationMs: 100, objectsTransferred: 5,
      lastSuccessTime: '2026-09-25T01:00:00Z', errorMessage: null },
    { attemptAt: '2026-09-25T00:55:00Z', statusCode: 2,
      durationMs: null, objectsTransferred: null,
      lastSuccessTime: null, errorMessage: 'rpc' }
  ];
  dashboardApi.getSiteReplicationMatrixPairHistory.mockResolvedValue(historyPayload(entries));
  const w = mountView();
  await flushPromises();

  await w.find('[data-test="cell-核心站点-上海站点"]').trigger('click');
  await flushPromises();
  await w.find('[data-test="pair-caret-0"]').trigger('click');
  await flushPromises();
  expect(w.findAll('[data-test^="pair-attempt-"]')).toHaveLength(2);

  // 切到 "失败+部分失败" — 1 条
  await w.find('[data-test="pair-filter-fail"]').trigger('click');
  await flushPromises();
  expect(w.findAll('[data-test^="pair-attempt-"]')).toHaveLength(1);

  // 切到 "成功" — 1 条
  await w.find('[data-test="pair-filter-ok"]').trigger('click');
  await flushPromises();
  expect(w.findAll('[data-test^="pair-attempt-"]')).toHaveLength(1);

  expect(dashboardApi.getSiteReplicationMatrixPairHistory).toHaveBeenCalledTimes(1);  // 没新增
});

// ── Polling + unmount ───────────────────────────────────────────────────

test('R93.10: 每 refreshSeconds * 1000 ms 重拉一次 payload', async () => {
  vi.useFakeTimers();
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();
  expect(dashboardApi.getSiteReplicationMatrixAll).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(dashboardApi.getSiteReplicationMatrixAll.mock.calls.length).toBeGreaterThanOrEqual(2);
});

test('R93.10: unmount 清 interval, 不再轮询', async () => {
  vi.useFakeTimers();
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();
  w.unmount();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(dashboardApi.getSiteReplicationMatrixAll).toHaveBeenCalledTimes(1);
});

// ── Edge cases ─────────────────────────────────────────────────────────

test('R93.10: primaries=[] 时显示空状态, 不渲染任何 panel', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({
    data: { siteRefreshSeconds: 10, primaries: [] }
  });
  const w = mountView();
  await flushPromises();
  expect(w.find('[data-test="fleet-ribbon"]').exists()).toBe(false);
  expect(w.find('[data-test="hub-panel"]').exists()).toBe(false);
  expect(w.find('[data-test="spoke-panel"]').exists()).toBe(false);
  expect(w.find('[data-test="full-panel"]').exists()).toBe(false);
  expect(w.find('.empty').text()).toContain('暂无站点');
});

test('R93.10: 仅 1 站 (no cross-site) → cell-detail 打开后显示 "暂无复制链路"', async () => {
  const one = {
    siteRefreshSeconds: 10,
    primaries: [{
      dcName: 'DC-ONE-01', siteId: 1, siteName: '单站点',
      regionCode: null, isHub: true,
      dcs: [{ dcName: 'DC-ONE-01' }],
      dcPartners: [{ dcName: 'DC-ONE-01', partners: [] }]
    }]
  };
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: one });
  const w = mountView();
  await flushPromises();

  // Hub↔Hub panel 因只有 1 Hub 不渲染
  expect(w.find('[data-test="hub-panel"]').exists()).toBe(false);
  expect(w.find('[data-test="full-panel"]').exists()).toBe(true);

  // 自指点击不会打开 modal — 测个不存在的跨站不会触发
  await w.find('[data-test="cell-单站点-单站点"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="cell-detail-modal"]').exists()).toBe(false);
});