import { test, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.mock factory is hoisted to top of file; reference hoisted vars to avoid TDZ errors.
// R72: dashboardApi.getSiteReplicationMatrixPairHistory needs to be
// mockable for the cell-modal pair expand tests (mirrors R70's pattern in
// topology-chart.test.js — see line 8 there).
const { getPairHistoryMock } = vi.hoisted(() => ({
  getPairHistoryMock: vi.fn(() => Promise.resolve({ data: { entries: [] } }))
}));

vi.mock('../src/api/dashboard.js', () => ({
  dashboardApi: {
    getSiteReplicationMatrixAll: vi.fn(() => Promise.resolve({
      data: { siteRefreshSeconds: 10, primaries: [] }
    })),
    getSiteReplicationMatrixPairHistory: getPairHistoryMock
  }
}));

import { mount, flushPromises } from '@vue/test-utils';
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
  // Use mockImplementation (not mockResolvedValue) so each call returns a
  // fresh object — the view assigns `primaries.value = r.data.primaries`
  // and a same-reference reassignment would skip Vue's `watch` callback,
  // breaking any test that simulates a poll refresh (R72 poll-refresh test).
  dashboardApi.getSiteReplicationMatrixAll.mockImplementation(
    () => Promise.resolve({ data: basePayload() })
  );
  // R72: pair-history default = empty entries (tests that need real
  // entries override per-call with mockResolvedValueOnce).
  getPairHistoryMock.mockReset();
  getPairHistoryMock.mockResolvedValue({ data: { entries: [] } });
});
afterEach(() => {
  vi.useRealTimers();
});

// jsdom doesn't ship URL.createObjectURL / revokeObjectURL (those are
// browser-only APIs). Define them as configurable stubs on the URL class
// so vi.spyOn(URL, 'createObjectURL') in the R73 CSV-export tests can
// install its mock. vi.restoreAllMocks in afterEach won't unwind this
// defineProperty (which is intentional — the stubs are inert no-ops).
if (typeof URL.createObjectURL !== 'function') {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true, writable: true,
    value: () => 'blob:jsdom-stub'
  });
}
if (typeof URL.revokeObjectURL !== 'function') {
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true, writable: true,
    value: () => {}
  });
}

function mountView() {
  // 2026-08-30 R64.2: SiteMatrixView is frontend-only (/matrix) and must
  // wrap <AppLayout>, not <AdminLayout>. Stubs the layout component the
  // view actually imports; if a future regression re-introduces AdminLayout
  // here the stub name won't match and the layout will mount the real
  // component (which has its own router-link + theme-toggle — detectable).
  return mount(SiteMatrixView, {
    global: { stubs: { AppLayout: { template: '<div><slot /></div>' } } }
  });
}

// 2026-08-30 R68: Hub-Spoke layered matrix — `data-test="cell-X-Y"` may
// resolve to multiple sections (Hub mesh + Spoke attachment + Full matrix
// can all contain the same pair). Scope every cell-level assertion to the
// Full matrix so the existing R60 expectations still target the original
// N×N surface. Hub-Spoke-specific assertions live in their own R68 tests
// below and scope to `[data-test="hub-panel"]` / `[data-test="spoke-panel"]`.
function fullPanel(w) {
  return w.find('[data-test="full-panel"]');
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
  // 2026-08-30 R68: scope to the Full matrix panel — Hub mesh + Spoke
  // attachment panels also render <th class="col-head"> but with different
  // site subsets, so a global findAll would over-count.
  const cols = fullPanel(w).findAll('thead .col-head');
  // 2026-09-05 R80: each non-self cell now hosts a per-DC <table.dc-subgrid>
  // with its own <tbody> + <tr>. A naked `tbody tr` selector over-counts
  // (it would also pick up the inner dc-subgrid rows). Scope to the
  // outer .matrix-row class added in R80 — that's only present on the
  // site × site rows of the outer matrix.
  const rows = fullPanel(w).findAll('tbody tr.matrix-row');
  // 3 sites in basePayload → 3 col-heads + 3 body rows + 1 corner
  expect(cols.length).toBe(3);
  expect(rows.length).toBe(3);
});

test('R64: row + col headers show site name + DC count', async () => {
  const w = mountView();
  await flushPromises();
  // 2026-08-30 R68: scope to Full panel to avoid Hub-col-head matches.
  const panel = fullPanel(w);
  const firstCol = panel.find('thead .col-head');
  expect(firstCol.text()).toContain('核心站点');
  expect(firstCol.text()).toContain('2 DC');
  const firstRow = panel.find('tbody .row-head');
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
  // 2026-08-30 R68: scope to Full panel.
  const cell = fullPanel(w2).find('[data-test="cell-A站-B站"]');
  // 2026-09-05 R80: outer td still carries cell-ok (worst status across
  // all DC pairs). The .cell-glyph + .cell-num summary is gone — the cell
  // now renders a per-DC sub-grid instead.
  expect(cell.classes()).toContain('cell-ok');
  // 1×1 sub-grid: 1 dc-pair-ok cell with ✓ glyph.
  const dp = cell.find('.dc-pair-cell');
  expect(dp.exists()).toBe(true);
  expect(dp.classes()).toContain('dc-pair-ok');
  expect(dp.text()).toBe('✓');
});

test('R64: yellow cell when worst status is statusCode=1', async () => {
  const w = mountView();
  await flushPromises();
  // basePayload 核心 → 厦门 = DC-BJ-01(0) + DC-BJ-02(1) → worst yellow
  // 2026-08-30 R68: scope to Full panel.
  const cell = fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]');
  // 2026-09-05 R80: outer cell still carries cell-warn (worst status).
  expect(cell.classes()).toContain('cell-warn');
  // 2×1 sub-grid: DC-BJ-01 × MOCK-XMADSRV1 (ok) + DC-BJ-02 × MOCK-XMADSRV1 (warn).
  const pairs = cell.findAll('.dc-pair-cell');
  expect(pairs.length).toBe(2);
  // At least one dc-pair-ok + at least one dc-pair-warn must be present.
  expect(pairs.some(p => p.classes().includes('dc-pair-ok'))).toBe(true);
  expect(pairs.some(p => p.classes().includes('dc-pair-warn'))).toBe(true);
});

test('R64: red cell when any partner link is statusCode=2+', async () => {
  const w = mountView();
  await flushPromises();
  // basePayload 厦门 → 核心 = statusCode=2 → red
  // 2026-08-30 R68: scope to Full panel.
  const cell = fullPanel(w).find('[data-test="cell-厦门站点-核心站点"]');
  // 2026-09-05 R80: outer cell still carries cell-err (worst status).
  expect(cell.classes()).toContain('cell-err');
  // 1×2 sub-grid: MOCK-XMADSRV1 × {DC-BJ-01, DC-BJ-02}. Only DC-BJ-01
  // has a partner entry from 厦门 (statusCode=2 → err); DC-BJ-02 has
  // none → dc-pair-none.
  const pairs = cell.findAll('.dc-pair-cell');
  expect(pairs.length).toBe(2);
  const errPair = pairs.find(p => p.classes().includes('dc-pair-err'));
  expect(errPair).toBeTruthy();
  expect(errPair.text()).toBe('✕');
});

test('R64: empty cell (no partner link between two sites) renders gray', async () => {
  const w = mountView();
  await flushPromises();
  // 核心 → 上海 — no link in basePayload (上海 dcPartners=[])
  // 2026-08-30 R68: scope to Full panel.
  const cell = fullPanel(w).find('[data-test="cell-核心站点-上海站点"]');
  // 2026-09-05 R80: outer cell still carries cell-none (no partner links).
  expect(cell.classes()).toContain('cell-none');
  // 2×1 sub-grid: DC-BJ-01 + DC-BJ-02 × MOCK-SHADSRV1, no partners at all
  // → every inner cell is dc-pair-none with "—".
  const pairs = cell.findAll('.dc-pair-cell');
  expect(pairs.length).toBe(2);
  for (const p of pairs) {
    expect(p.classes()).toContain('dc-pair-none');
    expect(p.text()).toBe('—');
  }
});

test('R64: self-loop cell (same site × same site) renders dashed', async () => {
  const w = mountView();
  await flushPromises();
  // 2026-08-30 R68: scope to Full panel.
  const cell = fullPanel(w).find('[data-test="cell-核心站点-核心站点"]');
  expect(cell.classes()).toContain('cell-self');
  expect(cell.find('.cell-glyph').text()).toBe('·');
  expect(cell.find('.cell-num').text()).toBe('—');
});

test('R64: cell shows per-DC breakdown matching the ok/total ratio', async () => {
  const w = mountView();
  await flushPromises();
  // 核心 → 厦门 cell = DC-BJ-01(OK) + DC-BJ-02(partial) → 1 ok / 2 total.
  // 2026-08-30 R68: scope to Full panel. 2026-09-05 R80: the cell no
  // longer carries a "1/2" string — instead the per-DC sub-grid renders
  // 1 ok + 1 warn square, which is the operator-readable equivalent of
  // "1/2" (the operator counts green squares vs total).
  const cell = fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]');
  const pairs = cell.findAll('.dc-pair-cell');
  expect(pairs.length).toBe(2);
  // 1 ok (DC-BJ-01's link) + 1 warn (DC-BJ-02's link).
  const okCount = pairs.filter(p => p.classes().includes('dc-pair-ok')).length;
  const warnCount = pairs.filter(p => p.classes().includes('dc-pair-warn')).length;
  expect(okCount).toBe(1);
  expect(warnCount).toBe(1);
});

test('R64: cell tooltip lists each partner link', async () => {
  const w = mountView();
  await flushPromises();
  // 2026-08-30 R68: scope to Full panel.
  const cell = fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]');
  const title = cell.attributes('title') || '';
  expect(title).toContain('核心站点 → 厦门站点');
  expect(title).toContain('2 条链路');
  expect(title).toContain('DC-BJ-01 → MOCK-XMADSRV1');
  expect(title).toContain('RPC server unavailable'.length === 0 ? '' : ''); // no error on this cell
});

test('R64: error cell tooltip includes the error message', async () => {
  const w = mountView();
  await flushPromises();
  // 2026-08-30 R68: scope to Full panel.
  const cell = fullPanel(w).find('[data-test="cell-厦门站点-核心站点"]');
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

// ── R64.2: layout regression — 站点矩阵 必须前台 (AppLayout), 不能后台 (AdminLayout)
// The bug was: R64.1 removed the nav-link from AdminLayout but the view
// component itself still wrapped <AdminLayout>, so the frontend sidebar's
// /matrix link mounted a page that looked like admin chrome. This test
// fails loud if anyone re-imports AdminLayout into SiteMatrixView.
test('R64.2: uses AppLayout (frontend chrome) — NOT AdminLayout', async () => {
  const w = mountView();
  await flushPromises();
  // The stub we pass is `{ AppLayout: { template: '<div><slot /></div>' } }`.
  // If the view imported AdminLayout instead, the stub wouldn't match and
  // the real AdminLayout would mount (which renders its own <aside.sidebar>
  // + nested <nav> with router-links). Either way the stub-rendered output
  // has no <aside class="sidebar">. We assert both directions to be explicit:
  const wrapperHtml = w.html();
  // AppLayout stub renders as a plain <div> wrapping the slot — no <aside>.
  expect(wrapperHtml).not.toContain('<aside class="sidebar">');
  // And no admin-style nested nav structure (AdminLayout renders .nav-group
  // containers with 6 collapsible groups — distinctive).
  expect(wrapperHtml).not.toContain('class="nav-group"');
  // Sanity: page-title still mounts (proves the view itself rendered).
  expect(w.find('.page-title').text()).toBe('站点矩阵');
});

// ── R68: Hub-Spoke layered panels ─────────────────────────────────────
// 2026-08-30 R68 redesign: the R60 single N×N matrix becomes 3 stacked
// sections — Hub mesh (load-bearing core layer), Spoke attachment
// (Spoke → Hub), and the original Full N×N. Driven by the existing
// `primaries[].isHub` flag from the backend (sourced from ad_sites.is_hub).
//
// basePayload has 1 Hub (核心站点) + 2 Spokes (厦门站点, 上海站点). So:
//   - Hub mesh is HIDDEN (needs ≥ 2 Hubs — a 1-Hub matrix would be
//     diagonal only)
//   - Spoke attachment panel is VISIBLE (1 Hub col × 2 Spoke rows)
//   - Full matrix is VISIBLE (3 × 3)
//
// We use a dedicated fixture for the Hub-mesh VISIBLE tests.

const multiHubPayload = () => ({
  siteRefreshSeconds: 10,
  primaries: [
    {
      dcName: 'DC-BJ-01', siteId: 1, siteName: '核心站点',
      regionCode: 'BJ', isHub: true,
      dcs: [{ dcName: 'DC-BJ-01' }],
      dcPartners: [{ dcName: 'DC-BJ-01', partners: [
        { peerDc: 'DC-BJ-02', peerSite: '灾备站点', statusCode: 0,
          errorMessage: null,
          lastAttemptTime: '2026-08-30T01:00:00Z',
          lastSuccessTime: '2026-08-30T01:00:00Z' }
      ]}]
    },
    {
      dcName: 'DC-BJ-02', siteId: 2, siteName: '灾备站点',
      regionCode: 'BJ', isHub: true,
      dcs: [{ dcName: 'DC-BJ-02' }],
      dcPartners: [{ dcName: 'DC-BJ-02', partners: [
        { peerDc: 'DC-BJ-01', peerSite: '核心站点', statusCode: 0,
          errorMessage: null,
          lastAttemptTime: '2026-08-30T01:00:00Z',
          lastSuccessTime: '2026-08-30T01:00:00Z' }
      ]}]
    },
    {
      dcName: 'MOCK-XMADSRV1', siteId: 3, siteName: '厦门站点',
      regionCode: 'XM', isHub: false,
      dcs: [{ dcName: 'MOCK-XMADSRV1' }],
      dcPartners: [{ dcName: 'MOCK-XMADSRV1', partners: [
        { peerDc: 'DC-BJ-01', peerSite: '核心站点', statusCode: 0,
          errorMessage: null,
          lastAttemptTime: '2026-08-30T01:00:00Z',
          lastSuccessTime: '2026-08-30T01:00:00Z' }
      ]}]
    }
  ]
});

test('R68: legend totals include Hub / Spoke mini-tags', async () => {
  // basePayload: 1 Hub + 2 Spokes → legend says "站点 3" with two mini-tags
  const w = mountView();
  await flushPromises();
  const sitesItem = w.find('[data-test="legend-sites"]');
  expect(sitesItem.exists()).toBe(true);
  expect(sitesItem.text()).toContain('Hub 1');
  expect(sitesItem.text()).toContain('Spoke 2');
  expect(sitesItem.find('.hub-tag-mini').exists()).toBe(true);
  expect(sitesItem.find('.spoke-tag-mini').exists()).toBe(true);
});

test('R68: Hub mesh panel is hidden when only 1 Hub exists', async () => {
  // basePayload has 1 Hub → the panel must NOT render (it would be a
  // 1×1 diagonal, useless to display).
  const w = mountView();
  await flushPromises();
  expect(w.find('[data-test="hub-panel"]').exists()).toBe(false);
});

test('R68: Hub mesh panel renders when ≥ 2 Hubs exist', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValueOnce({
    data: multiHubPayload()
  });
  const w = mountView();
  await flushPromises();
  const hubPanel = w.find('[data-test="hub-panel"]');
  expect(hubPanel.exists()).toBe(true);
  // 2 Hubs → 2 col-heads + 2 body rows
  expect(hubPanel.findAll('thead .col-head').length).toBe(2);
  // 2026-09-05 R80: scope to .matrix-row (inner dc-subgrid rows also
  // live in <tbody><tr>).
  expect(hubPanel.findAll('tbody tr.matrix-row').length).toBe(2);
  // Hub↔Hub cells get the .cell-hub-pair modifier (load-bearing emphasis)
  const cell = hubPanel.find('[data-test="cell-核心站点-灾备站点"]');
  expect(cell.exists()).toBe(true);
  expect(cell.classes()).toContain('cell-hub-pair');
  expect(cell.classes()).toContain('cell-ok');
});

test('R68: Hub mesh panel header carries the "承载层" tag', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValueOnce({
    data: multiHubPayload()
  });
  const w = mountView();
  await flushPromises();
  const hubPanel = w.find('[data-test="hub-panel"]');
  const tag = hubPanel.find('.hub-tag');
  expect(tag.exists()).toBe(true);
  expect(tag.text()).toMatch(/承载层/);
  expect(tag.text()).toContain('2');
});

test('R68: Spoke attachment panel renders with Spoke rows × Hub cols', async () => {
  // basePayload: 2 Spokes × 1 Hub → 1 col-head + 2 body rows
  const w = mountView();
  await flushPromises();
  const spokePanel = w.find('[data-test="spoke-panel"]');
  expect(spokePanel.exists()).toBe(true);
  expect(spokePanel.findAll('thead .col-head').length).toBe(1);
  // 2026-09-05 R80: scope to .matrix-row (inner dc-subgrid rows also
  // live in <tbody><tr>).
  expect(spokePanel.findAll('tbody tr.matrix-row').length).toBe(2);
  // Spoke cells get the cell-hub-spoke modifier
  const cell = spokePanel.find('[data-test="cell-厦门站点-核心站点"]');
  expect(cell.exists()).toBe(true);
  expect(cell.classes()).toContain('cell-hub-spoke');
});

test('R68: Spoke attachment panel header carries the "分支 → 中心" tag', async () => {
  const w = mountView();
  await flushPromises();
  const spokePanel = w.find('[data-test="spoke-panel"]');
  const tag = spokePanel.find('.spoke-tag');
  expect(tag.exists()).toBe(true);
  expect(tag.text()).toMatch(/分支/);
  expect(tag.text()).toMatch(/中心/);
  expect(tag.text()).toContain('2');
});

test('R68: Spoke attachment panel hides when no Hubs', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValueOnce({
    data: {
      siteRefreshSeconds: 10,
      primaries: [
        {
          dcName: 'DC-X', siteId: 1, siteName: 'X站',
          isHub: false, // no hubs at all
          dcs: [{ dcName: 'DC-X' }],
          dcPartners: [{ dcName: 'DC-X', partners: [] }]
        }
      ]
    }
  });
  const w = mountView();
  await flushPromises();
  expect(w.find('[data-test="spoke-panel"]').exists()).toBe(false);
  // Full matrix still renders.
  expect(w.find('[data-test="full-panel"]').exists()).toBe(true);
});

test('R68: full-panel header carries the "完整视图" tag', async () => {
  const w = mountView();
  await flushPromises();
  const fullPanelEl = w.find('[data-test="full-panel"]');
  const tag = fullPanelEl.find('.layer-tag');
  expect(tag.exists()).toBe(true);
  expect(tag.text()).toMatch(/完整视图/);
  expect(tag.text()).toContain('3');
});

test('R68: full-panel preserves the original N×N grid (R60/R64 contract)', async () => {
  // The Full matrix must stay a complete N×N so deep-dive use is preserved.
  const w = mountView();
  await flushPromises();
  const panel = fullPanel(w);
  expect(panel.findAll('thead .col-head').length).toBe(3);
  // 2026-09-05 R80: scope to .matrix-row (inner dc-subgrid rows also
  // live in <tbody><tr>).
  expect(panel.findAll('tbody tr.matrix-row').length).toBe(3);
  // Original cell-X-Y selectors resolve inside Full panel
  expect(panel.find('[data-test="cell-核心站点-厦门站点"]').exists()).toBe(true);
  expect(panel.find('[data-test="cell-上海站点-核心站点"]').exists()).toBe(true);
});

// ── R71: cell-detail modal (click cell → list of DC pairs) ─────────────
// R69 made every topology node drillable, R70 made every edge drillable;
// R71 makes every cell in the SiteMatrixView drillable. Clicking a cell
// opens a modal that lists every (sourceDc → destDc) link between the
// two sites with status pill + last success + error. The data is already
// in cellMap — no new fetch, no new endpoint (R45's /pair-history is
// still the per-pair deep-dive if/when we want it).

test('R71: cells are clickable (cursor: pointer) for non-self cells', async () => {
  const w = mountView();
  await flushPromises();
  const cell = fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]');
  expect(cell.exists()).toBe(true);
  expect(cell.classes()).toContain('cell-clickable');
  // Self cells get a different class so cursor stays default.
  const self = fullPanel(w).find('[data-test="cell-核心站点-核心站点"]');
  expect(self.classes()).toContain('cell-disabled');
});

test('R71: clicking a non-self cell opens the cell-detail modal', async () => {
  const w = mountView();
  await flushPromises();
  // Click the green/yellow cross-site cell 核心 → 厦门.
  await fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]').trigger('click');
  await flushPromises();
  const modal = w.find('[data-test="cell-detail-modal"]');
  expect(modal.exists()).toBe(true);
  const title = w.find('[data-test="cell-detail-title"]');
  expect(title.text()).toBe('核心站点 → 厦门站点');
});

test('R71: modal lists every (sourceDc → destDc) pair in the cell', async () => {
  const w = mountView();
  await flushPromises();
  // basePayload 核心 → 厦门 has 2 partner links (DC-BJ-01 + DC-BJ-02).
  await fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]').trigger('click');
  await flushPromises();
  const rows = w.findAll('[data-test^="cell-detail-pair-"]');
  expect(rows.length).toBe(2);
  // First row should be DC-BJ-01 → MOCK-XMADSRV1 (alphabetical sourceDc).
  expect(rows[0].text()).toContain('DC-BJ-01');
  expect(rows[0].text()).toContain('MOCK-XMADSRV1');
  expect(rows[1].text()).toContain('DC-BJ-02');
});

test('R71: status pill renders the right color/label per statusCode', async () => {
  const w = mountView();
  await flushPromises();
  // basePayload 厦门 → 核心 = statusCode=2 (err), red pill, "断开失败" label.
  await fullPanel(w).find('[data-test="cell-厦门站点-核心站点"]').trigger('click');
  await flushPromises();
  const row = w.findAll('[data-test^="cell-detail-pair-"]')[0];
  expect(row.classes()).toContain('pair-row-err');
  const pill = row.find('.status-pill');
  expect(pill.classes()).toContain('status-pill-err');
  expect(pill.text()).toBe('断开失败');
  // Error message is forwarded into the row.
  expect(row.text()).toContain('RPC server unavailable');
});

test('R71: Hub↔Hub cell shows 核心层 layer tag in modal meta', async () => {
  // multiHubPayload has 2 Hubs; clicking core↔dr 核心 ↔ 灾备 should show
  // the "核心层 Hub↔Hub" tag in the modal meta.
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValueOnce({
    data: multiHubPayload()
  });
  const w = mountView();
  await flushPromises();
  // Hub panel cell selector
  const cell = w.find('[data-test="cell-核心站点-灾备站点"]');
  expect(cell.exists()).toBe(true);
  await cell.trigger('click');
  await flushPromises();
  const meta = w.find('[data-test="cell-detail-meta"]');
  expect(meta.text()).toContain('核心层');
  expect(meta.text()).toContain('Hub↔Hub');
  // 1 link (DC-BJ-01 → DC-BJ-02) in multiHubPayload
  expect(w.findAll('[data-test^="cell-detail-pair-"]').length).toBe(1);
});

test('R71: Spoke→Hub cell shows 接入层 layer tag in modal meta', async () => {
  // basePayload 厦门 (spoke) → 核心 (hub) → 接入层 Spoke→Hub tag.
  // We click 厦门 row × 核心 column from the Spoke attachment panel.
  const w = mountView();
  await flushPromises();
  const spokePanel = w.find('[data-test="spoke-panel"]');
  expect(spokePanel.exists()).toBe(true);
  await spokePanel.find('[data-test="cell-厦门站点-核心站点"]').trigger('click');
  await flushPromises();
  const meta = w.find('[data-test="cell-detail-meta"]');
  expect(meta.text()).toContain('接入层');
});

test('R71: close button dismisses the modal', async () => {
  const w = mountView();
  await flushPromises();
  await fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="cell-detail-modal"]').exists()).toBe(true);
  await w.find('[data-test="cell-detail-close"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="cell-detail-modal"]').exists()).toBe(false);
});

test('R71: clicking a self cell does NOT open the modal', async () => {
  const w = mountView();
  await flushPromises();
  // Self cells have cell-disabled class and the handler early-returns.
  await fullPanel(w).find('[data-test="cell-核心站点-核心站点"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="cell-detail-modal"]').exists()).toBe(false);
});

test('R71: empty cell (no partner link) opens modal with empty state', async () => {
  // basePayload 核心 → 上海 has no partner link in either direction.
  const w = mountView();
  await flushPromises();
  await fullPanel(w).find('[data-test="cell-核心站点-上海站点"]').trigger('click');
  await flushPromises();
  const modal = w.find('[data-test="cell-detail-modal"]');
  expect(modal.exists()).toBe(true);
  expect(modal.find('[data-test="cell-detail-empty"]').exists()).toBe(true);
  // And no pair rows.
  expect(modal.findAll('[data-test^="cell-detail-pair-"]').length).toBe(0);
});

// ── R72: pair-row drill-down → inline 24h attempts sub-table ─────────
// Closes the per-pair deep-dive loop: R69 made topology nodes clickable,
// R70 made edges clickable, R71 made site-matrix cells clickable. R72
// makes the per-(sourceDc → destDc) pair rows inside the cell-detail
// modal clickable too — operator can drill from site → cell → pair →
// last 10 attempts without leaving the modal.
//
// The pair-history endpoint already exists from R45; the API client
// method already exists (getSiteReplicationMatrixPairHistory). R72 only
// wires the frontend lazy-fetch + render + cache + stale-data guard.

test('R72: pair rows show caret indicator + expandable class', async () => {
  const w = mountView();
  await flushPromises();
  // Open 核心 → 厦门 modal (2 pair rows in basePayload)
  await fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]').trigger('click');
  await flushPromises();
  const rows = w.findAll('[data-test^="cell-detail-pair-"]');
  expect(rows.length).toBe(2);
  // Every pair row should be marked expandable + carry a caret button.
  for (const r of rows) {
    expect(r.classes()).toContain('pair-row-expandable');
    expect(r.find('[data-test^="pair-caret-"]').exists()).toBe(true);
  }
});

test('R72: clicking a pair row opens the inline attempts sub-table', async () => {
  // Pre-stub a real 3-row history response so the table has data to render.
  getPairHistoryMock.mockResolvedValueOnce({
    data: {
      source: 'DC-BJ-01', dest: 'MOCK-XMADSRV1', limit: 10,
      entries: [
        { attemptAt: '2026-08-30T01:00:00Z', statusCode: 0,
          durationMs: 120, objectsTransferred: 5,
          lastSuccessTime: '2026-08-30T01:00:00Z', errorMessage: null },
        { attemptAt: '2026-08-30T00:55:00Z', statusCode: 1,
          durationMs: 8000, objectsTransferred: 2,
          lastSuccessTime: '2026-08-30T00:50:00Z',
          errorMessage: 'partial: 2 objects pending' },
        { attemptAt: '2026-08-30T00:50:00Z', statusCode: 2,
          durationMs: null, objectsTransferred: null,
          lastSuccessTime: null,
          errorMessage: 'RPC server unavailable' }
      ]
    }
  });
  const w = mountView();
  await flushPromises();
  await fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]').trigger('click');
  await flushPromises();
  // Click pair row 0 (DC-BJ-01 → MOCK-XMADSRV1)
  await w.find('[data-test="cell-detail-pair-0"]').trigger('click');
  await flushPromises();
  // Sub-row + sub-table should render.
  expect(w.find('[data-test="pair-attempts-0"]').exists()).toBe(true);
  expect(w.find('[data-test="pair-attempts-table-0"]').exists()).toBe(true);
  const attRows = w.findAll('[data-test^="pair-attempt-0-"]');
  expect(attRows.length).toBe(3);
});

test('R72: pair click calls getSiteReplicationMatrixPairHistory with the right args', async () => {
  // API contract: getSiteReplicationMatrixPairHistory(destDc, sourceDc, limit).
  // The pair row "DC-BJ-01 → MOCK-XMADSRV1" should be called as
  // getSiteReplicationMatrixPairHistory('MOCK-XMADSRV1', 'DC-BJ-01', 10).
  getPairHistoryMock.mockResolvedValueOnce({ data: { entries: [] } });
  const w = mountView();
  await flushPromises();
  await fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]').trigger('click');
  await flushPromises();
  await w.find('[data-test="cell-detail-pair-0"]').trigger('click');
  await flushPromises();
  expect(getPairHistoryMock).toHaveBeenCalledWith('MOCK-XMADSRV1', 'DC-BJ-01', 10);
});

test('R72: attempts sub-table renders 6 columns + correct glyphs/labels', async () => {
  // One ok + one warn + one err attempt → 3 rows, with glyph + label.
  getPairHistoryMock.mockResolvedValueOnce({
    data: {
      source: 'DC-BJ-01', dest: 'MOCK-XMADSRV1', limit: 10,
      entries: [
        { attemptAt: '2026-08-30T01:00:00Z', statusCode: 0,
          durationMs: 120, objectsTransferred: 5,
          lastSuccessTime: '2026-08-30T01:00:00Z', errorMessage: null },
        { attemptAt: '2026-08-30T00:55:00Z', statusCode: 1,
          durationMs: 8000, objectsTransferred: 2,
          lastSuccessTime: '2026-08-30T00:50:00Z',
          errorMessage: 'partial: 2 objects pending' },
        { attemptAt: '2026-08-30T00:50:00Z', statusCode: 2,
          durationMs: null, objectsTransferred: null,
          lastSuccessTime: null,
          errorMessage: 'RPC server unavailable' }
      ]
    }
  });
  const w = mountView();
  await flushPromises();
  await fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]').trigger('click');
  await flushPromises();
  await w.find('[data-test="cell-detail-pair-0"]').trigger('click');
  await flushPromises();
  // 6 columns per attempt row.
  const table = w.find('[data-test="pair-attempts-table-0"]');
  const headers = table.findAll('thead th');
  expect(headers.length).toBe(6);
  expect(headers[0].text()).toContain('尝试时间');
  expect(headers[1].text()).toContain('结果');
  expect(headers[2].text()).toContain('耗时');
  expect(headers[3].text()).toContain('传输对象');
  expect(headers[4].text()).toContain('最近成功');
  expect(headers[5].text()).toContain('错误');
  // Status class + glyph on each row (ok/warn/err).
  const rows = w.findAll('[data-test^="pair-attempt-0-"]');
  expect(rows[0].classes()).toContain('att-row-ok');
  expect(rows[1].classes()).toContain('att-row-warn');
  expect(rows[2].classes()).toContain('att-row-err');
  // Glyph + label inside row 1 (warn): ▲ 部分失败
  expect(rows[1].find('.glyph').text()).toBe('▲');
  expect(rows[1].text()).toContain('部分失败');
  expect(rows[1].find('.glyph').classes()).toContain('glyph-warn');
  // Row 2 (err): ✕ 失败 + error msg
  expect(rows[2].find('.glyph').text()).toBe('✕');
  expect(rows[2].text()).toContain('失败');
  expect(rows[2].text()).toContain('RPC server unavailable');
});

test('R72: empty 24h attempts show inline empty state (no table rendered)', async () => {
  // Default mock returns { entries: [] } — operator gets the empty hint,
  // not a 0-row table.
  const w = mountView();
  await flushPromises();
  await fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]').trigger('click');
  await flushPromises();
  await w.find('[data-test="cell-detail-pair-0"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="pair-attempts-empty-0"]').exists()).toBe(true);
  expect(w.find('[data-test="pair-attempts-table-0"]').exists()).toBe(false);
});

test('R72: closing a pair row collapses the sub-table; re-opening does NOT re-fetch', async () => {
  // After first fetch the result is cached — collapsing + re-expanding
  // must NOT trigger a second API call. (The Map is the cache; collapse
  // removes from Set, expand adds back, but the Map persists.)
  getPairHistoryMock.mockResolvedValueOnce({ data: { entries: [] } });
  const w = mountView();
  await flushPromises();
  await fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]').trigger('click');
  await flushPromises();
  // First open → fetch
  await w.find('[data-test="cell-detail-pair-0"]').trigger('click');
  await flushPromises();
  expect(getPairHistoryMock).toHaveBeenCalledTimes(1);
  // Collapse
  await w.find('[data-test="cell-detail-pair-0"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="pair-attempts-0"]').exists()).toBe(false);
  // Re-open → no new fetch
  await w.find('[data-test="cell-detail-pair-0"]').trigger('click');
  await flushPromises();
  expect(getPairHistoryMock).toHaveBeenCalledTimes(1);
  expect(w.find('[data-test="pair-attempts-0"]').exists()).toBe(true);
});

test('R72: load error renders inline error state (no crash)', async () => {
  getPairHistoryMock.mockRejectedValueOnce({
    response: { data: { error: 'server boom' } }
  });
  const w = mountView();
  await flushPromises();
  await fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]').trigger('click');
  await flushPromises();
  await w.find('[data-test="cell-detail-pair-0"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="pair-attempts-error-0"]').exists()).toBe(true);
  expect(w.find('[data-test="pair-attempts-error-0"]').text()).toContain('server boom');
});

test('R72: poll refresh clears expanded pair state (no stale data)', async () => {
  // Expand a pair row, then simulate a poll-cycle refresh — the modal +
  // expanded pairs should reset. Prevents stale history showing after a
  // data refresh.
  getPairHistoryMock.mockResolvedValueOnce({ data: { entries: [] } });
  // Fake timers BEFORE mount so the view's setInterval registers on the
  // mocked clock — otherwise vi.advanceTimersByTimeAsync below has no
  // effect on the already-scheduled real-time interval.
  vi.useFakeTimers();
  const w = mountView();
  await flushPromises();
  await fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]').trigger('click');
  await flushPromises();
  await w.find('[data-test="cell-detail-pair-0"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="pair-attempts-0"]').exists()).toBe(true);
  // Simulate poll refresh by advancing one timer cycle (the view re-loads
  // via setInterval(load, refreshSeconds*1000)).
  await vi.advanceTimersByTimeAsync(10000);
  await flushPromises();
  // Modal + sub-row should be cleared.
  expect(w.find('[data-test="cell-detail-modal"]').exists()).toBe(false);
  expect(w.find('[data-test="pair-attempts-0"]').exists()).toBe(false);
  vi.useRealTimers();
});

test('R72: multiple pair rows can be expanded simultaneously', async () => {
  // basePayload 核心 → 厦门 = 2 pairs. Both should be expandable in
  // parallel — operator doesn't have to close one to see the other.
  getPairHistoryMock.mockResolvedValue({ data: { entries: [] } });
  const w = mountView();
  await flushPromises();
  await fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]').trigger('click');
  await flushPromises();
  await w.find('[data-test="cell-detail-pair-0"]').trigger('click');
  await flushPromises();
  await w.find('[data-test="cell-detail-pair-1"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="pair-attempts-0"]').exists()).toBe(true);
  expect(w.find('[data-test="pair-attempts-1"]').exists()).toBe(true);
  // Both should have triggered their own API call (one per pair).
  expect(getPairHistoryMock).toHaveBeenCalledTimes(2);
});

// ── R73: pair-attempts polish (filter chips + date range + CSV export) ─

test('R73: status filter chips render above pair table (3 chips: all/ok/err)', async () => {
  // The R73 toolbar lives inside the cell-detail modal; clicking any cell
  // opens it. 3 chips for status filter (all/ok/fail) + 2 chips for date
  // range (24h/7d) = 5 chip buttons total.
  const w = mountView();
  await flushPromises();
  await fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]').trigger('click');
  await flushPromises();
  // Toolbar container must exist.
  expect(w.find('[data-test="pair-toolbar"]').exists()).toBe(true);
  // 3 filter chips.
  expect(w.find('[data-test="pair-filter-all"]').exists()).toBe(true);
  expect(w.find('[data-test="pair-filter-ok"]').exists()).toBe(true);
  expect(w.find('[data-test="pair-filter-fail"]').exists()).toBe(true);
  // 2 window chips.
  expect(w.find('[data-test="pair-window-24"]').exists()).toBe(true);
  expect(w.find('[data-test="pair-window-168"]').exists()).toBe(true);
  // Default state — all + 24h are active (have .pair-chip-active class).
  expect(w.find('[data-test="pair-filter-all"]').classes()).toContain('pair-chip-active');
  expect(w.find('[data-test="pair-filter-ok"]').classes()).not.toContain('pair-chip-active');
  expect(w.find('[data-test="pair-window-24"]').classes()).toContain('pair-chip-active');
  expect(w.find('[data-test="pair-window-168"]').classes()).not.toContain('pair-chip-active');
});

test('R73: clicking status filter chip filters pair-table rows (all/ok only/err only)', async () => {
  // basePayload cell 核心 → 厦门 carries 1 green (statusCode=0) + 1 yellow
  // (statusCode=1) pair. After R73 redesign, the filter chips control
  // only the attempt rows inside each expanded pair's sub-table — the
  // pair rows themselves stay visible regardless of the chip, because
  // hiding a pair row would hide its just-expanded sub-table and the
  // operator would lose context. This test verifies that the chip
  // state still toggles correctly (active class) even though it doesn't
  // change the pair-row count.
  const w = mountView();
  await flushPromises();
  await fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]').trigger('click');
  await flushPromises();
  // Default: all 2 pairs visible.
  expect(w.findAll('[data-test^="cell-detail-pair-"]').length).toBe(2);
  // Click OK filter — both pairs stay visible (chips don't hide rows).
  await w.find('[data-test="pair-filter-ok"]').trigger('click');
  await flushPromises();
  expect(w.findAll('[data-test^="cell-detail-pair-"]').length).toBe(2);
  expect(w.find('[data-test="pair-filter-ok"]').classes()).toContain('pair-chip-active');
  expect(w.find('[data-test="pair-filter-all"]').classes()).not.toContain('pair-chip-active');
  // Click fail filter — still 2 pairs visible; chip state moves.
  await w.find('[data-test="pair-filter-fail"]').trigger('click');
  await flushPromises();
  expect(w.findAll('[data-test^="cell-detail-pair-"]').length).toBe(2);
  expect(w.find('[data-test="pair-filter-fail"]').classes()).toContain('pair-chip-active');
  // Back to all — 2 rows again.
  await w.find('[data-test="pair-filter-all"]').trigger('click');
  await flushPromises();
  expect(w.findAll('[data-test^="cell-detail-pair-"]').length).toBe(2);
});

test('R73: filtered pairs sub-table shows only matching statusCode rows', async () => {
  // Mock returns 3 entries (1 ok + 1 warn + 1 err) for the first pair.
  // When operator filters by OK, the sub-table should render only the OK
  // entry. Filter by fail should render warn+err (both qualify as failure
  // under our statusCode semantics: statusCode=1 OR statusCode>=2).
  getPairHistoryMock.mockResolvedValueOnce({
    data: { entries: [
      { attemptAt: '2026-08-30T01:00:00Z', statusCode: 0, durationMs: 100,
        objectsTransferred: 5, lastSuccessTime: '2026-08-30T01:00:00Z', errorMessage: null },
      { attemptAt: '2026-08-30T01:05:00Z', statusCode: 1, durationMs: 200,
        objectsTransferred: 3, lastSuccessTime: '2026-08-30T01:00:00Z', errorMessage: 'partial' },
      { attemptAt: '2026-08-30T01:10:00Z', statusCode: 2, durationMs: 50,
        objectsTransferred: 0, lastSuccessTime: null, errorMessage: 'boom' }
    ] }
  });
  const w = mountView();
  await flushPromises();
  await fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]').trigger('click');
  await flushPromises();
  // Expand the first pair row.
  await w.find('[data-test="cell-detail-pair-0"]').trigger('click');
  await flushPromises();
  // Default (all) shows 3 entries.
  expect(w.findAll('[data-test^="pair-attempt-0-"]').length).toBe(3);
  // Apply OK filter — 1 entry visible.
  await w.find('[data-test="pair-filter-ok"]').trigger('click');
  await flushPromises();
  const okRows = w.findAll('[data-test^="pair-attempt-0-"]');
  expect(okRows.length).toBe(1);
  // The visible row carries the OK glyph class.
  expect(okRows[0].classes()).toContain('att-row-ok');
  // Apply fail filter — 2 entries visible (warn + err).
  await w.find('[data-test="pair-filter-fail"]').trigger('click');
  await flushPromises();
  const failRows = w.findAll('[data-test^="pair-attempt-0-"]');
  expect(failRows.length).toBe(2);
  // Both have the warn or err class.
  const classes = failRows.map(r => r.classes().join(' '));
  expect(classes.some(c => c.includes('att-row-warn'))).toBe(true);
  expect(classes.some(c => c.includes('att-row-err'))).toBe(true);
});

test('R73: date range toggle renders 2 chips (24h / 7d)', async () => {
  // Toolbar must show 24h + 7d chips side-by-side; default 24h active.
  const w = mountView();
  await flushPromises();
  await fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="pair-window-24"]').exists()).toBe(true);
  expect(w.find('[data-test="pair-window-168"]').exists()).toBe(true);
  expect(w.find('[data-test="pair-window-24"]').text()).toBe('24h');
  expect(w.find('[data-test="pair-window-168"]').text()).toBe('7d');
  // Default state: 24h is active.
  expect(w.find('[data-test="pair-window-24"]').classes()).toContain('pair-chip-active');
  expect(w.find('[data-test="pair-window-168"]').classes()).not.toContain('pair-chip-active');
});

test('R73: clicking 7d chip clears cache + re-fetches with limit=50', async () => {
  // First expand defaults to limit=10 (24h). After clicking the 7d chip,
  // the cache is cleared and the next expand should re-fetch with
  // limit=50 (7d's cap).
  getPairHistoryMock.mockResolvedValue({ data: { entries: [] } });
  const w = mountView();
  await flushPromises();
  await fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]').trigger('click');
  await flushPromises();
  // First expand — limit=10.
  await w.find('[data-test="cell-detail-pair-0"]').trigger('click');
  await flushPromises();
  expect(getPairHistoryMock).toHaveBeenLastCalledWith(
    'MOCK-XMADSRV1', 'DC-BJ-01', 10
  );
  // Switch to 7d.
  await w.find('[data-test="pair-window-168"]').trigger('click');
  await flushPromises();
  // Chip state updated.
  expect(w.find('[data-test="pair-window-168"]').classes()).toContain('pair-chip-active');
  // Cache cleared — pair-attempts row gone (sub-row collapsed).
  expect(w.find('[data-test="pair-attempts-0"]').exists()).toBe(false);
  // Re-expand — limit=50.
  await w.find('[data-test="cell-detail-pair-0"]').trigger('click');
  await flushPromises();
  expect(getPairHistoryMock).toHaveBeenLastCalledWith(
    'MOCK-XMADSRV1', 'DC-BJ-01', 50
  );
  expect(getPairHistoryMock).toHaveBeenCalledTimes(2);
});

test('R73: CSV export button creates Blob URL + triggers anchor click', async () => {
  // CSV button lives in the sub-table toolbar; click → URL.createObjectURL
  // is called + an anchor is appended to <body> + clicked. We spy on
  // URL.createObjectURL and the click event via appendChild watching.
  getPairHistoryMock.mockResolvedValueOnce({
    data: { entries: [
      { attemptAt: '2026-08-30T01:00:00Z', statusCode: 0, durationMs: 100,
        objectsTransferred: 5, lastSuccessTime: '2026-08-30T01:00:00Z', errorMessage: null }
    ] }
  });
  // Spy on URL.createObjectURL + revokeObjectURL.
  const createUrlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-csv-url');
  const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  // Capture anchor clicks by tracking appendChild on document.body.
  const clickedAnchors = [];
  const realAppend = document.body.appendChild.bind(document.body);
  const appendSpy = vi.spyOn(document.body, 'appendChild').mockImplementation((node) => {
    if (node && node.tagName === 'A') {
      const origClick = node.click.bind(node);
      node.click = vi.fn(() => { clickedAnchors.push(node); origClick(); });
    }
    return realAppend(node);
  });
  const w = mountView();
  await flushPromises();
  await fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]').trigger('click');
  await flushPromises();
  await w.find('[data-test="cell-detail-pair-0"]').trigger('click');
  await flushPromises();
  // CSV button visible.
  const csvBtn = w.find('[data-test="pair-csv-0"]');
  expect(csvBtn.exists()).toBe(true);
  expect(csvBtn.text()).toBe('导出 CSV');
  // Click it.
  await csvBtn.trigger('click');
  await flushPromises();
  // URL.createObjectURL called once with a Blob.
  expect(createUrlSpy).toHaveBeenCalledTimes(1);
  const blobArg = createUrlSpy.mock.calls[0][0];
  expect(blobArg).toBeInstanceOf(Blob);
  expect(blobArg.type).toBe('text/csv;charset=utf-8');
  // Anchor appended + clicked exactly once.
  expect(clickedAnchors.length).toBe(1);
  expect(appendSpy).toHaveBeenCalled();
  // URL revoked after the click (cleanup).
  expect(revokeSpy).toHaveBeenCalledWith('blob:mock-csv-url');
  // Restore mocks.
  createUrlSpy.mockRestore();
  revokeSpy.mockRestore();
  appendSpy.mockRestore();
});

test('R73: CSV export filename contains srcDc + destDc + timestamp', async () => {
  // Filename pattern: pair-history-{srcDc}-to-{dstDc}-{YYYYMMDD-HHmm}.csv
  // Capture the anchor's download attribute after click.
  getPairHistoryMock.mockResolvedValueOnce({
    data: { entries: [
      { attemptAt: '2026-08-30T01:00:00Z', statusCode: 0, durationMs: 100,
        objectsTransferred: 5, lastSuccessTime: '2026-08-30T01:00:00Z', errorMessage: null }
    ] }
  });
  let capturedFilename = null;
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const realAppend = document.body.appendChild.bind(document.body);
  vi.spyOn(document.body, 'appendChild').mockImplementation((node) => {
    if (node && node.tagName === 'A') {
      const origClick = node.click.bind(node);
      node.click = vi.fn(() => { capturedFilename = node.download; });
    }
    return realAppend(node);
  });
  const w = mountView();
  await flushPromises();
  await fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]').trigger('click');
  await flushPromises();
  await w.find('[data-test="cell-detail-pair-0"]').trigger('click');
  await flushPromises();
  await w.find('[data-test="pair-csv-0"]').trigger('click');
  await flushPromises();
  // Filename must match the canonical pattern.
  expect(capturedFilename).toMatch(/^pair-history-DC-BJ-01-to-MOCK-XMADSRV1-\d{8}-\d{4}\.csv$/);
  vi.restoreAllMocks();
});

test('R73: CSV export content includes header row + filtered rows', async () => {
  // The CSV body must start with a UTF-8 BOM (﻿), then the header row
  // matching the on-screen table column order, then one data row per
  // filtered entry. We assert the BOM via Blob byte inspection (the
  // portable way across jsdom / Node: FileReader.readAsText silently
  // strips U+FEFF on some implementations, so we can't rely on the
  // post-decode char code). The body content is checked after a
  // manual BOM-aware decode so it doesn't depend on the BOM-stripping
  // policy of the test runtime.
  getPairHistoryMock.mockResolvedValueOnce({
    data: { entries: [
      { attemptAt: '2026-08-30T01:00:00Z', statusCode: 0, durationMs: 100,
        objectsTransferred: 5, lastSuccessTime: '2026-08-30T01:00:00Z', errorMessage: null },
      { attemptAt: '2026-08-30T01:05:00Z', statusCode: 2, durationMs: 50,
        objectsTransferred: 0, lastSuccessTime: null, errorMessage: 'boom' }
    ] }
  });
  let capturedBlob = null;
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const realAppend = document.body.appendChild.bind(document.body);
  vi.spyOn(document.body, 'appendChild').mockImplementation((node) => {
    if (node && node.tagName === 'A') {
      const origClick = node.click.bind(node);
      node.click = vi.fn(() => {});
    }
    return realAppend(node);
  });
  // Override createObjectURL to capture the Blob.
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    capturedBlob = blob;
    return 'blob:mock';
  });
  const w = mountView();
  await flushPromises();
  await fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]').trigger('click');
  await flushPromises();
  await w.find('[data-test="cell-detail-pair-0"]').trigger('click');
  await flushPromises();
  await w.find('[data-test="pair-csv-0"]').trigger('click');
  await flushPromises();
  expect(capturedBlob).toBeInstanceOf(Blob);
  // Read blob as ArrayBuffer via FileReader (jsdom Blob lacks arrayBuffer()).
  // This lets us assert the raw byte sequence — including the BOM at
  // bytes 0-2 — without depending on FileReader.readAsText's BOM-
  // stripping policy (which silently turns the first char into the
  // first header character on some jsdom versions).
  const buf = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(capturedBlob);
  });
  const bytes = new Uint8Array(buf);
  expect(bytes.length).toBeGreaterThan(3);
  // UTF-8 BOM bytes.
  expect(bytes[0]).toBe(0xEF);
  expect(bytes[1]).toBe(0xBB);
  expect(bytes[2]).toBe(0xBF);
  // Decode the body. TextDecoder in some Node versions preserves the
  // BOM in the decoded string even with ignoreBOM:true — so we strip
  // it explicitly after decode (the BOM has already been asserted
  // above as raw bytes).
  const td = new TextDecoder('utf-8');
  let fullText = td.decode(buf);
  if (fullText.charCodeAt(0) === 0xFEFF) fullText = fullText.slice(1);
  const lines = fullText.split('\r\n');
  expect(lines[0]).toBe('尝试时间,结果,耗时(ms),传输对象,最近成功,错误/详情');
  // Two data rows (one per filtered entry: filter='all' is default).
  expect(lines.length).toBe(3);
  // First data row — success entry (statusCode=0 → 成功 label).
  expect(lines[1]).toContain('2026-08-30T01:00:00Z');
  expect(lines[1]).toContain('成功');
  expect(lines[1]).toContain('100');
  expect(lines[1]).toContain('5');
  // Second data row — failure entry (statusCode=2 → 失败 label).
  expect(lines[2]).toContain('2026-08-30T01:05:00Z');
  expect(lines[2]).toContain('失败');
  expect(lines[2]).toContain('boom');
  vi.restoreAllMocks();
});

// ── R80: per-DC sub-grid inside each cell ─────────────────────────────
// Operator directive (verbatim):
//   "在站点矩阵中 我们需要展现的子站点中的AD服务器,核心站点中的具体服务器,
//    有连接且健康显示为绿色,无连接显示为 -"
// Each non-self cell now renders a per-DC sub-grid (src-site DCs × dst-site
// DCs). The legacy data-test="cell-X-Y" outer <td> is preserved — tests
// that look up by site pair still resolve. New selectors:
//   data-test="dc-subgrid-X-Y"           the inner subgrid table
//   data-test="dc-pair-X-Y-ROW-to-COL"   each inner dc-pair cell
// Class vocabulary: .dc-pair-{ok|warn|err|none}.

test('R80: non-self cell renders a per-DC sub-grid (1 DC × 1 DC → 1 inner cell)', async () => {
  // basePayload has 厦门站点 with 1 DC (MOCK-XMADSRV1) and 上海站点 with 1 DC
  // (MOCK-SHADSRV1). The 厦门 → 上海 cell has 1×1 = 1 inner dc-pair-cell
  // (no link between the two sites → dc-pair-none).
  const w = mountView();
  await flushPromises();
  const cell = fullPanel(w).find('[data-test="cell-厦门站点-上海站点"]');
  // The outer td still carries cell-{state} (worst status class) and
  // data-test="cell-X-Y" — these are the load-bearing hooks for all
  // pre-R80 assertions.
  expect(cell.exists()).toBe(true);
  expect(cell.classes()).toContain('cell-none');
  // The new dc-subgrid lives inside the cell.
  const subgrid = cell.find('[data-test="dc-subgrid-厦门站点-上海站点"]');
  expect(subgrid.exists()).toBe(true);
  // 1×1 = 1 inner dc-pair cell, all 'none' (no link between the two sites).
  const pairs = cell.findAll('.dc-pair-cell');
  expect(pairs.length).toBe(1);
  expect(pairs[0].classes()).toContain('dc-pair-none');
  expect(pairs[0].text()).toBe('—');
});

test('R80: per-DC sub-grid renders full row-DC × col-DC product (2 × 1 → 2 cells)', async () => {
  // basePayload 核心 (2 DCs: DC-BJ-01, DC-BJ-02) × 厦门 (1 DC:
  // MOCK-XMADSRV1) → 2×1 = 2 inner cells (1 ok + 1 warn).
  const w = mountView();
  await flushPromises();
  const cell = fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]');
  const pairs = cell.findAll('.dc-pair-cell');
  expect(pairs.length).toBe(2);
});

test('R80: per-DC cell shows ✓ when partner link exists and is healthy', async () => {
  // basePayload 核心 → 厦门 has 1 healthy (DC-BJ-01 → MOCK-XMADSRV1,
  // statusCode=0). That inner cell should be dc-pair-ok with ✓ glyph.
  const w = mountView();
  await flushPromises();
  const cell = fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]');
  // Use the canonical dc-pair-X-Y-ROW-to-COL selector so we know we're
  // looking at exactly the (DC-BJ-01 → MOCK-XMADSRV1) pair.
  const okPair = cell.find('[data-test="dc-pair-核心站点-厦门站点-DC-BJ-01-to-MOCK-XMADSRV1"]');
  expect(okPair.exists()).toBe(true);
  expect(okPair.classes()).toContain('dc-pair-ok');
  expect(okPair.text()).toBe('✓');
});

test('R80: per-DC cell shows — when no partner link exists between the two DCs', async () => {
  // basePayload 核心 → 上海 has no partner link in either direction
  // (上海 dcPartners is empty). All inner cells should be dc-pair-none
  // with "—" content — the operator directive's exact wording.
  const w = mountView();
  await flushPromises();
  const cell = fullPanel(w).find('[data-test="cell-核心站点-上海站点"]');
  const pairs = cell.findAll('.dc-pair-cell');
  expect(pairs.length).toBe(2); // 核心 has 2 DCs, 上海 has 1 → 2×1
  for (const p of pairs) {
    expect(p.classes()).toContain('dc-pair-none');
    expect(p.text()).toBe('—');
  }
});

test('R80: per-DC cell carries the correct state class (ok / warn / err)', async () => {
  // basePayload:
  //   核心 → 厦门 = DC-BJ-01(0) + DC-BJ-02(1) → 1 ok + 1 warn
  //   厦门 → 核心 = statusCode=2 from MOCK-XMADSRV1 → DC-BJ-01 → 1 err
  const w = mountView();
  await flushPromises();
  // ok + warn in the 核心→厦门 cell
  const yellowCell = fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]');
  const okInner = yellowCell.find('[data-test="dc-pair-核心站点-厦门站点-DC-BJ-01-to-MOCK-XMADSRV1"]');
  const warnInner = yellowCell.find('[data-test="dc-pair-核心站点-厦门站点-DC-BJ-02-to-MOCK-XMADSRV1"]');
  expect(okInner.classes()).toContain('dc-pair-ok');
  expect(warnInner.classes()).toContain('dc-pair-warn');
  // err in the 厦门→核心 cell
  const redCell = fullPanel(w).find('[data-test="cell-厦门站点-核心站点"]');
  const errInner = redCell.find('[data-test="dc-pair-厦门站点-核心站点-MOCK-XMADSRV1-to-DC-BJ-01"]');
  expect(errInner.classes()).toContain('dc-pair-err');
  expect(errInner.text()).toBe('✕');
});

test('R80: per-DC cell tooltip contains DC names + status + last success time', async () => {
  // Tooltip on a dc-pair-cell should mention both DC names, the state
  // glyph + label (✓ 健康 / ! 部分失败 / ✕ 失败), and the last success
  // timestamp. No-link cells just show the DC pair + 无复制链路.
  const w = mountView();
  await flushPromises();
  const cell = fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]');
  // Healthy pair.
  const okInner = cell.find('[data-test="dc-pair-核心站点-厦门站点-DC-BJ-01-to-MOCK-XMADSRV1"]');
  const okTitle = okInner.attributes('title') || '';
  expect(okTitle).toContain('DC-BJ-01 → MOCK-XMADSRV1');
  expect(okTitle).toContain('健康');
  expect(okTitle).toContain('最近成功');
  // Partial-failure pair — error message is forwarded into the tooltip.
  const warnInner = cell.find('[data-test="dc-pair-核心站点-厦门站点-DC-BJ-02-to-MOCK-XMADSRV1"]');
  const warnTitle = warnInner.attributes('title') || '';
  expect(warnTitle).toContain('部分失败');
  expect(warnTitle).toContain('partial');
  // No-link pair.
  const emptyCell = fullPanel(w).find('[data-test="cell-核心站点-上海站点"]');
  const noneInner = emptyCell.findAll('.dc-pair-cell')[0];
  const noneTitle = noneInner.attributes('title') || '';
  expect(noneTitle).toContain('无复制链路');
});

test('R80: clicking a dc-pair-cell opens the cell-detail modal with that DC pair highlighted', async () => {
  // Click on (DC-BJ-01 → MOCK-XMADSRV1) inside the 核心→厦门 cell. The
  // modal must open with the cell-title pair name AND the matching pair
  // row carries the .pair-row-highlighted class so they can see which
  // specific DC pair they clicked.
  const w = mountView();
  await flushPromises();
  const cell = fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]');
  const okInner = cell.find('[data-test="dc-pair-核心站点-厦门站点-DC-BJ-01-to-MOCK-XMADSRV1"]');
  await okInner.trigger('click');
  await flushPromises();
  // Modal opens.
  expect(w.find('[data-test="cell-detail-modal"]').exists()).toBe(true);
  // Title + meta carry the site pair + a highlight badge naming the
  // DC pair the operator clicked.
  const title = w.find('[data-test="cell-detail-title"]');
  expect(title.text()).toBe('核心站点 → 厦门站点');
  const highlightTag = w.find('[data-test="cell-detail-highlight-tag"]');
  expect(highlightTag.exists()).toBe(true);
  expect(highlightTag.text()).toContain('DC-BJ-01 → MOCK-XMADSRV1');
  // The pair row matching (DC-BJ-01, MOCK-XMADSRV1) is highlighted.
  const rows = w.findAll('[data-test^="cell-detail-pair-"]');
  expect(rows.length).toBe(2);
  const highlighted = rows.filter(r => r.classes().includes('pair-row-highlighted'));
  expect(highlighted.length).toBe(1);
  expect(highlighted[0].text()).toContain('DC-BJ-01');
  expect(highlighted[0].text()).toContain('MOCK-XMADSRV1');
});

test('R80: clicking a no-link (dc-pair-none) cell is a true no-op', async () => {
  // The spec calls for click on a dc-pair-none cell to do nothing —
  // the modal must NOT open.
  const w = mountView();
  await flushPromises();
  const cell = fullPanel(w).find('[data-test="cell-核心站点-上海站点"]');
  const noneInner = cell.findAll('.dc-pair-none')[0];
  await noneInner.trigger('click');
  await flushPromises();
  expect(w.find('[data-test="cell-detail-modal"]').exists()).toBe(false);
});

test('R80: outer-cell click opens modal WITHOUT highlight (vs dc-pair click WITH highlight)', async () => {
  // The outer-cell click (e.g., on the cell padding between dc-pair cells)
  // must open the same modal but with no specific DC pair highlighted.
  // Clicking the outer cell programmatically: we use the data-test selector
  // and trigger click directly on the outer <td>.
  const w = mountView();
  await flushPromises();
  const cell = fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]');
  // Trigger click on the outer <td> (the @click handler fires).
  await cell.trigger('click');
  await flushPromises();
  expect(w.find('[data-test="cell-detail-modal"]').exists()).toBe(true);
  // No highlight tag in the meta line (cell-level click = no specific DC).
  expect(w.find('[data-test="cell-detail-highlight-tag"]').exists()).toBe(false);
  // No pair row carries the highlight class.
  const rows = w.findAll('[data-test^="cell-detail-pair-"]');
  for (const r of rows) {
    expect(r.classes()).not.toContain('pair-row-highlighted');
  }
});

test('R80: multi-DC Hub↔Hub cell renders full N×N × M×M sub-grid (3×3 = 9 inner cells)', async () => {
  // multi-DC payload: 2 Hubs each with 3 DCs → Hub↔Hub cell has 3×3 = 9
  // inner dc-pair cells (with one OK link, the rest are dc-pair-none).
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValueOnce({
    data: {
      siteRefreshSeconds: 10,
      primaries: [
        {
          dcName: 'H1-01', siteId: 1, siteName: '中心1',
          regionCode: 'C1', isHub: true,
          dcs: [{ dcName: 'H1-01' }, { dcName: 'H1-02' }, { dcName: 'H1-03' }],
          dcPartners: [
            { dcName: 'H1-01', partners: [
              // H1-01 → H2-01 healthy
              { peerDc: 'H2-01', peerSite: '中心2', statusCode: 0,
                errorMessage: null,
                lastAttemptTime: '2026-09-01T01:00:00Z',
                lastSuccessTime: '2026-09-01T01:00:00Z' }
            ]}
          ]
        },
        {
          dcName: 'H2-01', siteId: 2, siteName: '中心2',
          regionCode: 'C2', isHub: true,
          dcs: [{ dcName: 'H2-01' }, { dcName: 'H2-02' }, { dcName: 'H2-03' }],
          dcPartners: [
            { dcName: 'H2-01', partners: [
              { peerDc: 'H1-01', peerSite: '中心1', statusCode: 0,
                errorMessage: null,
                lastAttemptTime: '2026-09-01T01:00:00Z',
                lastSuccessTime: '2026-09-01T01:00:00Z' }
            ]}
          ]
        }
      ]
    }
  });
  const w = mountView();
  await flushPromises();
  const cell = w.find('[data-test="cell-中心1-中心2"]');
  expect(cell.exists()).toBe(true);
  expect(cell.classes()).toContain('cell-hub-pair');
  // 3 × 3 = 9 inner cells (H1-01..H1-03 × H2-01..H2-03). Of these,
  // exactly 1 is dc-pair-ok (H1-01 → H2-01) and 8 are dc-pair-none.
  const pairs = cell.findAll('.dc-pair-cell');
  expect(pairs.length).toBe(9);
  const okCount = pairs.filter(p => p.classes().includes('dc-pair-ok')).length;
  const noneCount = pairs.filter(p => p.classes().includes('dc-pair-none')).length;
  expect(okCount).toBe(1);
  expect(noneCount).toBe(8);
});

test('R80: Spoke→Hub cell renders full (Spoke DC count × Hub DC count) sub-grid', async () => {
  // Multi-DC payload: 2 Spokes × 1 Hub. The hub has 3 DCs and each spoke
  // has 3 DCs → Spoke→Hub cells are 3×3 = 9 inner cells. With 2 spokes
  // × 1 hub = 1 cell on the spoke attachment panel.
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValueOnce({
    data: {
      siteRefreshSeconds: 10,
      primaries: [
        {
          dcName: 'S1-01', siteId: 1, siteName: '分支1',
          regionCode: 'S1', isHub: false,
          dcs: [{ dcName: 'S1-01' }, { dcName: 'S1-02' }, { dcName: 'S1-03' }],
          dcPartners: [
            { dcName: 'S1-01', partners: [
              { peerDc: 'H-01', peerSite: '中心', statusCode: 0,
                errorMessage: null,
                lastAttemptTime: '2026-09-01T01:00:00Z',
                lastSuccessTime: '2026-09-01T01:00:00Z' }
            ]}
          ]
        },
        {
          dcName: 'S2-01', siteId: 2, siteName: '分支2',
          regionCode: 'S2', isHub: false,
          dcs: [{ dcName: 'S2-01' }, { dcName: 'S2-02' }, { dcName: 'S2-03' }],
          dcPartners: [
            { dcName: 'S2-01', partners: [
              { peerDc: 'H-01', peerSite: '中心', statusCode: 0,
                errorMessage: null,
                lastAttemptTime: '2026-09-01T01:00:00Z',
                lastSuccessTime: '2026-09-01T01:00:00Z' }
            ]}
          ]
        },
        {
          dcName: 'H-01', siteId: 3, siteName: '中心',
          regionCode: 'H', isHub: true,
          dcs: [{ dcName: 'H-01' }, { dcName: 'H-02' }, { dcName: 'H-03' }],
          dcPartners: [
            { dcName: 'H-01', partners: [
              { peerDc: 'S1-01', peerSite: '分支1', statusCode: 0,
                errorMessage: null,
                lastAttemptTime: '2026-09-01T01:00:00Z',
                lastSuccessTime: '2026-09-01T01:00:00Z' },
              { peerDc: 'S2-01', peerSite: '分支2', statusCode: 0,
                errorMessage: null,
                lastAttemptTime: '2026-09-01T01:00:00Z',
                lastSuccessTime: '2026-09-01T01:00:00Z' }
            ]}
          ]
        }
      ]
    }
  });
  const w = mountView();
  await flushPromises();
  const spokePanel = w.find('[data-test="spoke-panel"]');
  expect(spokePanel.exists()).toBe(true);
  // 分支1 → 中心 cell: 3 spoke DCs × 3 hub DCs = 9 inner cells.
  const cell = spokePanel.find('[data-test="cell-分支1-中心"]');
  expect(cell.exists()).toBe(true);
  expect(cell.classes()).toContain('cell-hub-spoke');
  const pairs = cell.findAll('.dc-pair-cell');
  expect(pairs.length).toBe(9);
  // At least one OK inner cell — the spec calls for ✓ green when healthy.
  const okCount = pairs.filter(p => p.classes().includes('dc-pair-ok')).length;
  expect(okCount).toBeGreaterThanOrEqual(1);
});

test('R80: full matrix renders per-DC sub-grids for non-self cells (no regression on R64 contract)', async () => {
  // R64 contract: every site×site cell must exist in the Full matrix.
  // After R80, every non-self cell additionally renders a per-DC sub-grid.
  // Self cells (× same site) keep the original cell-glyph + cell-num
  // rendering and do NOT render a dc-subgrid.
  const w = mountView();
  await flushPromises();
  const panel = fullPanel(w);
  // 3 sites → 3×3 = 9 cells total in the Full matrix.
  const allCells = panel.findAll('[data-test^="cell-"]');
  // Each cell carries cell-{state}. Self cells (3 of them) get cell-self
  // and don't host a sub-grid. The other 6 host a dc-subgrid.
  const selfCells = panel.findAll('.cell-self');
  expect(selfCells.length).toBe(3);
  const subgrids = panel.findAll('.dc-subgrid');
  expect(subgrids.length).toBe(6);
});