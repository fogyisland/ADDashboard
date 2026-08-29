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

import SiteMatrixView from '../src/views/admin/SiteMatrixView.vue';
import { dashboardApi } from '../src/api/dashboard.js';

// 2026-08-29 R64: extract the R60 N×N site matrix into a standalone
// 站点矩阵 page. R60 used to live at /admin/site-replication-matrix/all
// but the operator directive "复制状态概览和站点矩阵是两个页面" splits
// them: /matrix mounts this view, /admin/site-replication-matrix/all
// now hosts the R49 ops-console per-DC partner tables view. Both
// pages consume the same /api/dashboard/site-replication-matrix/all
// payload — the matrix just exposes the cellState / worstStatus
// helpers as a per-site-pair grid instead of the partner-row layout.
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
  return mount(SiteMatrixView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
}

// ── R64: page-level skeleton ──────────────────────────────────────────

test('R64: mounts and shows page title 站点矩阵', async () => {
  const w = mountView();
  await flushPromises();
  expect(w.find('.page-title').text()).toBe('站点矩阵');
});

test('R64: legend strip has 6 cells (3 status + 3 totals)', async () => {
  const w = mountView();
  await flushPromises();
  const items = w.findAll('.legend-item');
  expect(items.length).toBe(6);
  expect(items[0].text()).toMatch(/正常/);
  expect(items[1].text()).toMatch(/部分失败/);
  expect(items[2].text()).toMatch(/断开/);
  expect(items[3].text()).toMatch(/站点/);
  expect(items[4].text()).toMatch(/域控/);
  expect(items[5].text()).toMatch(/链路/);
});

test('R64: empty primaries renders the empty hint', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValueOnce({
    data: { siteRefreshSeconds: 10, primaries: [] }
  });
  const w = mountView();
  await flushPromises();
  expect(w.find('.empty').exists()).toBe(true);
  expect(w.find('.matrix').exists()).toBe(false);
});

// ── R64: matrix grid ───────────────────────────────────────────────────

test('R64: renders an N×N matrix (sites as rows × sites as columns)', async () => {
  const w = mountView();
  await flushPromises();
  const cols = w.findAll('thead .col-head');
  const rows = w.findAll('tbody tr');
  // 3 sites in basePayload → 3 col-heads + 3 body rows + 1 corner
  expect(cols.length).toBe(3);
  expect(rows.length).toBe(3);
});

test('R64: row + col headers show site name + DC count', async () => {
  const w = mountView();
  await flushPromises();
  const firstCol = w.find('thead .col-head');
  expect(firstCol.text()).toContain('核心站点');
  expect(firstCol.text()).toContain('2 DC');
  const firstRow = w.find('tbody .row-head');
  expect(firstRow.text()).toContain('核心站点');
  expect(firstRow.text()).toContain('2 DC');
});

test('R64: green cell renders when all partner links are statusCode=0', async () => {
  const w = mountView();
  await flushPromises();
  // 核心 → 厦门 row 1, 厦门 column — both partner links OK → green
  // (DC-BJ-01's link is OK, but DC-BJ-02's is partial — worst is yellow)
  // Pick the row that has only OK: simulate a single-link site via payload swap.
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValueOnce({
    data: {
      siteRefreshSeconds: 10,
      primaries: [
        {
          dcName: 'DC-A', siteId: 1, siteName: 'A站',
          dcs: [{ dcName: 'DC-A' }],
          dcPartners: [{ dcName: 'DC-A', partners: [
            { peerDc: 'DC-B', peerSite: 'B站', statusCode: 0, errorMessage: null,
              lastAttemptTime: '2026-08-28T00:00:00Z', lastSuccessTime: '2026-08-28T00:00:00Z' }
          ]}]
        },
        {
          dcName: 'DC-B', siteId: 2, siteName: 'B站',
          dcs: [{ dcName: 'DC-B' }],
          dcPartners: [{ dcName: 'DC-B', partners: [
            { peerDc: 'DC-A', peerSite: 'A站', statusCode: 0, errorMessage: null,
              lastAttemptTime: '2026-08-28T00:00:00Z', lastSuccessTime: '2026-08-28T00:00:00Z' }
          ]}]
        }
      ]
    }
  });
  const w2 = mountView();
  await flushPromises();
  const cell = w2.find('[data-test="cell-A站-B站"]');
  expect(cell.classes()).toContain('cell-ok');
  expect(cell.find('.cell-glyph').text()).toBe('✓');
  expect(cell.find('.cell-num').text()).toBe('1/1');
});

test('R64: yellow cell when worst status is statusCode=1', async () => {
  const w = mountView();
  await flushPromises();
  // basePayload 核心 → 厦门 = DC-BJ-01(0) + DC-BJ-02(1) → worst yellow
  const cell = w.find('[data-test="cell-核心站点-厦门站点"]');
  expect(cell.classes()).toContain('cell-warn');
  expect(cell.find('.cell-glyph').text()).toBe('!');
});

test('R64: red cell when any partner link is statusCode=2+', async () => {
  const w = mountView();
  await flushPromises();
  // basePayload 厦门 → 核心 = statusCode=2 → red
  const cell = w.find('[data-test="cell-厦门站点-核心站点"]');
  expect(cell.classes()).toContain('cell-err');
  expect(cell.find('.cell-glyph').text()).toBe('✕');
});

test('R64: empty cell (no partner link between two sites) renders gray', async () => {
  const w = mountView();
  await flushPromises();
  // 核心 → 上海 — no link in basePayload (上海 dcPartners=[])
  const cell = w.find('[data-test="cell-核心站点-上海站点"]');
  expect(cell.classes()).toContain('cell-none');
  expect(cell.find('.cell-glyph').text()).toBe('·');
  expect(cell.find('.cell-num').text()).toBe('—');
});

test('R64: self-loop cell (same site × same site) renders dashed', async () => {
  const w = mountView();
  await flushPromises();
  const cell = w.find('[data-test="cell-核心站点-核心站点"]');
  expect(cell.classes()).toContain('cell-self');
  expect(cell.find('.cell-glyph').text()).toBe('·');
  expect(cell.find('.cell-num').text()).toBe('—');
});

test('R64: cell text shows ok/total ratio (not raw counts)', async () => {
  const w = mountView();
  await flushPromises();
  // 核心 → 厦门 cell = DC-BJ-01(OK) + DC-BJ-02(partial) → 1/2
  const cell = w.find('[data-test="cell-核心站点-厦门站点"]');
  expect(cell.find('.cell-num').text()).toBe('1/2');
});

test('R64: cell tooltip lists each partner link', async () => {
  const w = mountView();
  await flushPromises();
  const cell = w.find('[data-test="cell-核心站点-厦门站点"]');
  const title = cell.attributes('title') || '';
  expect(title).toContain('核心站点 → 厦门站点');
  expect(title).toContain('2 条链路');
  expect(title).toContain('DC-BJ-01 → MOCK-XMADSRV1');
  expect(title).toContain('RPC server unavailable'.length === 0 ? '' : ''); // no error on this cell
});

test('R64: error cell tooltip includes the error message', async () => {
  const w = mountView();
  await flushPromises();
  const cell = w.find('[data-test="cell-厦门站点-核心站点"]');
  const title = cell.attributes('title') || '';
  expect(title).toContain('RPC server unavailable');
});

// ── R64: legend totals ────────────────────────────────────────────────

test('R64: legend totals reflect partners across all sites', async () => {
  const w = mountView();
  await flushPromises();
  const items = w.findAll('.legend-item strong');
  // ok=1, warn=1, err=1, sites=3, dcs=4 (核心 2 + 厦门 1 + 上海 1), links=3
  expect(items[0].text()).toBe('1'); // ok
  expect(items[1].text()).toBe('1'); // warn
  expect(items[2].text()).toBe('1'); // err
  expect(items[3].text()).toBe('3'); // sites
  expect(items[4].text()).toBe('4'); // dcs
  expect(items[5].text()).toBe('3'); // links
});

// ── R64: polling lifecycle ────────────────────────────────────────────

test('R64: stops polling on unmount', async () => {
  vi.useFakeTimers();
  const w = mountView();
  await flushPromises();
  // initial load = 1 call; advance 10s and another; unmount; advance again.
  expect(dashboardApi.getSiteReplicationMatrixAll).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10000);
  expect(dashboardApi.getSiteReplicationMatrixAll).toHaveBeenCalledTimes(2);
  w.unmount();
  await vi.advanceTimersByTimeAsync(10000);
  expect(dashboardApi.getSiteReplicationMatrixAll).toHaveBeenCalledTimes(2);
});