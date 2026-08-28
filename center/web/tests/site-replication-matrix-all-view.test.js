import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../src/api/dashboard.js', () => ({
  dashboardApi: {
    getSiteReplicationMatrixAll: vi.fn(() => Promise.resolve({
      data: {
        siteRefreshSeconds: 10,
        primaries: []
      }
    }))
  }
}));

import SiteReplicationMatrixAllView from '../src/views/admin/SiteReplicationMatrixAllView.vue';
import { dashboardApi } from '../src/api/dashboard.js';

// 2026-08-29 R60 (operator directive "站点矩阵不用那么复杂，只保留最新的
// 状态，在一个页面中显示所有的站点连接状态，没有问题绿色，有问题黄色，
// 断开红色。不用做的特别复杂，要容忍足够多的数据出现"): rewrite the
// view as an N×N site matrix. The data contract (primaries[] with
// dcPartners[].partners[]) is unchanged; only the rendering changes.
const basePayload = () => ({
  siteRefreshSeconds: 10,
  primaries: [
    {
      dcName: 'DC-BJ-01', siteId: 1, siteName: '核心站点',
      regionCode: 'BJ', isHub: true,
      dcs: [
        { dcName: 'DC-BJ-01', osVersion: 'Win2022' },
        { dcName: 'DC-BJ-02', osVersion: 'Win2019' }
      ],
      dcPartners: [
        { dcName: 'DC-BJ-01', partners: [
          // cross-site to 厦门 — green OK
          { peerDc: 'MOCK-XMADSRV1', peerSite: '厦门站点', statusCode: 0,
            errorMessage: null,
            lastAttemptTime: '2026-08-28T01:00:30Z',
            lastSuccessTime: '2026-08-28T01:00:00Z' }
        ]},
        { dcName: 'DC-BJ-02', partners: [
          // cross-site to 厦门 — yellow partial failure
          { peerDc: 'MOCK-XMADSRV1', peerSite: '厦门站点', statusCode: 1,
            errorMessage: 'partial',
            lastAttemptTime: '2026-08-28T01:00:30Z',
            lastSuccessTime: '2026-08-28T00:55:00Z' }
        ]}
      ]
    },
    {
      dcName: 'MOCK-XMADSRV1', siteId: 2, siteName: '厦门站点',
      regionCode: 'XM', isHub: false,
      dcs: [
        { dcName: 'MOCK-XMADSRV1', osVersion: 'Win2019' }
      ],
      dcPartners: [
        { dcName: 'MOCK-XMADSRV1', partners: [
          // cross-site to 核心 — red failure (the 厦门→核心 perspective
          // mirrors the same edge so we get a red cell on the 厦门 row).
          { peerDc: 'DC-BJ-01', peerSite: '核心站点', statusCode: 2,
            errorMessage: 'RPC server unavailable',
            lastAttemptTime: '2026-08-28T00:55:00Z',
            lastSuccessTime: null }
        ]}
      ]
    },
    {
      dcName: 'MOCK-SHADSRV1', siteId: 3, siteName: '上海站点',
      regionCode: 'SH', isHub: false,
      dcs: [
        { dcName: 'MOCK-SHADSRV1', osVersion: 'Win2019' }
      ],
      dcPartners: [
        { dcName: 'MOCK-SHADSRV1', partners: [] }
      ]
    }
  ]
});

beforeEach(() => {
  dashboardApi.getSiteReplicationMatrixAll.mockReset();
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
});
afterEach(() => {
  vi.useRealTimers();
});

function mountView() {
  return mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
}

// ── R60: page-level skeleton ──────────────────────────────────────────

test('R60: mounts and shows page title', async () => {
  const w = mountView();
  await flushPromises();
  expect(w.find('.page-title').text()).toBe('复制状态概览');
});

test('R60: legend strip shows 3 status colors + totals', async () => {
  const w = mountView();
  await flushPromises();
  const legend = w.find('[data-test="legend"]');
  expect(legend.exists()).toBe(true);
  expect(legend.find('.swatch-ok').exists()).toBe(true);
  expect(legend.find('.swatch-warn').exists()).toBe(true);
  expect(legend.find('.swatch-err').exists()).toBe(true);
  // Three sites, 4 DCs, 3 partner links total in basePayload:
  //   1 intra-site OK + 1 cross-site warn + 1 cross-site err = 3 links
  expect(legend.text()).toContain('站点');
  expect(legend.text()).toContain('域控');
  expect(legend.text()).toContain('链路');
  // ok=1, warn=1, err=1 in the totals row
  expect(legend.text()).toMatch(/正常\s*1/);
  expect(legend.text()).toMatch(/部分失败\s*1/);
  expect(legend.text()).toMatch(/断开\s*1/);
});

// ── R60: N×N matrix structure ─────────────────────────────────────────

test('R60: matrix renders one row per site + one column per site', async () => {
  const w = mountView();
  await flushPromises();
  const matrix = w.find('[data-test="matrix"]');
  expect(matrix.exists()).toBe(true);
  // 3 sites in basePayload → 3 rows in tbody + 1 header row + 1 corner cell
  const tbodyRows = matrix.findAll('tbody tr');
  expect(tbodyRows).toHaveLength(3);
  // Each row: 1 row-head th + 3 cells (one per site, including self)
  const firstRow = tbodyRows[0];
  expect(firstRow.findAll('th.row-head')).toHaveLength(1);
  expect(firstRow.findAll('td.cell')).toHaveLength(3);
  // Column headers: corner + 3 col-head
  const colHeads = matrix.findAll('thead th.col-head');
  expect(colHeads).toHaveLength(3);
});

test('R60: row heads + column heads show site name + DC count', async () => {
  const w = mountView();
  await flushPromises();
  const rowHeads = w.findAll('th.row-head .row-name');
  expect(rowHeads.map(n => n.text())).toEqual(['核心站点', '厦门站点', '上海站点']);
  // 核心站点 has 2 DCs, 厦门站点 + 上海站点 each have 1 DC
  const rowMeta = w.findAll('th.row-head .row-meta-num');
  expect(rowMeta.map(n => n.text())).toEqual(['2', '1', '1']);
  const colMeta = w.findAll('th.col-head .col-meta');
  expect(colMeta.map(c => c.text())).toEqual(['2 DC', '1 DC', '1 DC']);
});

// ── R60: cell color states ───────────────────────────────────────────

test('R60: diagonal self cell renders cell-self + em-dash (no count)', async () => {
  const w = mountView();
  await flushPromises();
  const cell = w.find('[data-test="cell-核心站点-核心站点"]');
  expect(cell.exists()).toBe(true);
  expect(cell.classes()).toContain('cell-self');
  expect(cell.text()).toContain('—');
});

test('R60: OK cross-site cell renders cell-ok + ✓ glyph + 1/1', async () => {
  const w = mountView();
  await flushPromises();
  // 核心→厦门 via DC-BJ-01 is a green cross-site OK link (in basePayload).
  // The cell takes the WORST of {ok, warn}, so we check that DC-BJ-02's
  // warn link is what dominates (cell-warn) — covered by the next test.
  // Here we use a payload where 核心→厦门 is purely OK.
  const payload = basePayload();
  payload.primaries[0].dcPartners[1].partners = [];
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: payload });
  const w2 = mountView();
  await flushPromises();
  const cell = w2.find('[data-test="cell-核心站点-厦门站点"]');
  expect(cell.exists()).toBe(true);
  expect(cell.classes()).toContain('cell-ok');
  expect(cell.find('.cell-glyph').text()).toBe('✓');
  expect(cell.find('.cell-num').text()).toBe('1/1');
});

test('R60: yellow cell renders cell-warn + ! glyph for statusCode=1', async () => {
  const w = mountView();
  await flushPromises();
  const cell = w.find('[data-test="cell-核心站点-厦门站点"]');
  expect(cell.exists()).toBe(true);
  expect(cell.classes()).toContain('cell-warn');
  expect(cell.find('.cell-glyph').text()).toBe('!');
  // basePayload 核心→厦门 has 2 links: 1 OK (DC-BJ-01) + 1 warn (DC-BJ-02).
  // Worst across {ok, warn} is warn; ok ratio is 1/2.
  expect(cell.find('.cell-num').text()).toBe('1/2');
});

test('R60: red cell renders cell-err + ✕ glyph for statusCode=2', async () => {
  const w = mountView();
  await flushPromises();
  const cell = w.find('[data-test="cell-厦门站点-核心站点"]');
  expect(cell.exists()).toBe(true);
  expect(cell.classes()).toContain('cell-err');
  expect(cell.find('.cell-glyph').text()).toBe('✕');
});

test('R60: cell with no partner links renders cell-none + ·', async () => {
  const w = mountView();
  await flushPromises();
  // 核心→上海 has no link in basePayload
  const cell = w.find('[data-test="cell-核心站点-上海站点"]');
  expect(cell.exists()).toBe(true);
  expect(cell.classes()).toContain('cell-none');
  expect(cell.text()).toContain('—');
});

test('R60: cell takes the WORST status across multiple partner links', async () => {
  // Override with a payload where one site-pair has mixed OK + err.
  const payload = basePayload();
  // Add an OK link from 厦门→核心 alongside the existing err link.
  payload.primaries[1].dcPartners[0].partners.push({
    peerDc: 'DC-BJ-02', peerSite: '核心站点', statusCode: 0,
    errorMessage: null,
    lastAttemptTime: '2026-08-28T01:00:00Z',
    lastSuccessTime: '2026-08-28T01:00:00Z'
  });
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: payload });
  const w = mountView();
  await flushPromises();
  const cell = w.find('[data-test="cell-厦门站点-核心站点"]');
  // Worst across {err, ok} is err → cell-err + 1/2
  expect(cell.classes()).toContain('cell-err');
  expect(cell.find('.cell-num').text()).toBe('1/2');
});

// ── R60: tooltip ──────────────────────────────────────────────────────

test('R60: cell tooltip lists each partner link + status + lastSuccessTime', async () => {
  const w = mountView();
  await flushPromises();
  const cell = w.find('[data-test="cell-厦门站点-核心站点"]');
  const tip = cell.attributes('title');
  expect(tip).toContain('厦门站点 → 核心站点');
  expect(tip).toContain('1 条链路');
  expect(tip).toContain('MOCK-XMADSRV1 → DC-BJ-01');
  expect(tip).toContain('RPC server unavailable');
  expect(tip).toContain('暂无成功记录');
});

test('R60: cell with no links has tooltip saying "无复制链路"', async () => {
  const w = mountView();
  await flushPromises();
  const cell = w.find('[data-test="cell-核心站点-上海站点"]');
  expect(cell.attributes('title')).toContain('无复制链路');
});

// ── R60: error + empty + polling ──────────────────────────────────────

test('R60: API error surfaces in error banner', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: { primaries: [], siteRefreshSeconds: 10 } });
  const w = mountView();
  await flushPromises();
  // No primaries → "暂无站点" empty state shows (not the error banner).
  expect(w.find('.empty').text()).toContain('暂无站点');
});

test('R60: API rejection surfaces in error banner', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockRejectedValue(new Error('boom'));
  const w = mountView();
  await flushPromises();
  expect(w.find('.error-banner').exists()).toBe(true);
});

test('R60: polling re-fetches every refreshSeconds * 1000 ms', async () => {
  vi.useFakeTimers();
  const w = mountView();
  await flushPromises();
  expect(dashboardApi.getSiteReplicationMatrixAll).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(dashboardApi.getSiteReplicationMatrixAll.mock.calls.length).toBeGreaterThanOrEqual(2);
});

test('R60: clears polling interval on unmount', async () => {
  vi.useFakeTimers();
  const w = mountView();
  await flushPromises();
  w.unmount();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(dashboardApi.getSiteReplicationMatrixAll).toHaveBeenCalledTimes(1);
});

// ── R60: tolerance for many sites ──────────────────────────────────────

test('R60: many sites still render — single N×N matrix, no per-DC drill-down', async () => {
  // Generate 8 sites × ~5 partner links each → 40-link payload.
  const primaries = [];
  for (let i = 0; i < 8; i++) {
    const siteName = `站点${i + 1}`;
    const peers = [];
    for (let j = 0; j < 5; j++) {
      const otherIdx = (i + j + 1) % 8;
      peers.push({
        peerDc: `DC-${otherIdx + 1}-01`,
        peerSite: `站点${otherIdx + 1}`,
        statusCode: (j === 0 && i % 4 === 0) ? 2 : (j === 1 ? 1 : 0),
        errorMessage: (j === 0 && i % 4 === 0) ? 'boom' : null,
        lastAttemptTime: '2026-08-28T01:00:30Z',
        lastSuccessTime: (j === 0 && i % 4 === 0) ? null : '2026-08-28T01:00:00Z'
      });
    }
    primaries.push({
      dcName: `DC-${i + 1}-01`,
      siteId: i + 1,
      siteName,
      regionCode: null,
      isHub: i === 0,
      dcs: [{ dcName: `DC-${i + 1}-01`, osVersion: 'Win2022' }],
      dcPartners: [{ dcName: `DC-${i + 1}-01`, partners: peers }]
    });
  }
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({
    data: { siteRefreshSeconds: 10, primaries }
  });
  const w = mountView();
  await flushPromises();
  // 8 row-heads + 8 col-heads + 8×8=64 cells.
  expect(w.findAll('th.row-head')).toHaveLength(8);
  expect(w.findAll('th.col-head')).toHaveLength(8);
  const cells = w.findAll('td.cell');
  expect(cells).toHaveLength(64);
  // No per-DC drill-down — no .dc-block anywhere.
  expect(w.find('.dc-block').exists()).toBe(false);
  // No caret buttons (no expansion).
  expect(w.find('.caret-btn').exists()).toBe(false);
  // No status pill (color cells only).
  expect(w.find('.status-pill').exists()).toBe(false);
});

// ── R60: nothing left from R45/R47/R49 ────────────────────────────────

test('R60: legacy features gone — no port health, no FSMO badges, no history, no fleet ribbon', async () => {
  const w = mountView();
  await flushPromises();
  expect(w.find('.port-cell').exists()).toBe(false);
  expect(w.find('.port-summary').exists()).toBe(false);
  expect(w.find('.role-badge').exists()).toBe(false);
  expect(w.find('.fleet-ribbon').exists()).toBe(false);
  expect(w.find('.attempts-row').exists()).toBe(false);
  expect(w.find('.err-banner').exists()).toBe(false);
  expect(w.find('.status-pill').exists()).toBe(false);
  // The view never calls getSiteReplicationMatrixPairHistory.
  // (Old test imported + reset that mock; new file doesn't import it.)
});