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
  const rows = fullPanel(w).findAll('tbody tr');
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
  expect(cell.classes()).toContain('cell-ok');
  expect(cell.find('.cell-glyph').text()).toBe('✓');
  expect(cell.find('.cell-num').text()).toBe('1/1');
});

test('R64: yellow cell when worst status is statusCode=1', async () => {
  const w = mountView();
  await flushPromises();
  // basePayload 核心 → 厦门 = DC-BJ-01(0) + DC-BJ-02(1) → worst yellow
  // 2026-08-30 R68: scope to Full panel.
  const cell = fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]');
  expect(cell.classes()).toContain('cell-warn');
  expect(cell.find('.cell-glyph').text()).toBe('!');
});

test('R64: red cell when any partner link is statusCode=2+', async () => {
  const w = mountView();
  await flushPromises();
  // basePayload 厦门 → 核心 = statusCode=2 → red
  // 2026-08-30 R68: scope to Full panel.
  const cell = fullPanel(w).find('[data-test="cell-厦门站点-核心站点"]');
  expect(cell.classes()).toContain('cell-err');
  expect(cell.find('.cell-glyph').text()).toBe('✕');
});

test('R64: empty cell (no partner link between two sites) renders gray', async () => {
  const w = mountView();
  await flushPromises();
  // 核心 → 上海 — no link in basePayload (上海 dcPartners=[])
  // 2026-08-30 R68: scope to Full panel.
  const cell = fullPanel(w).find('[data-test="cell-核心站点-上海站点"]');
  expect(cell.classes()).toContain('cell-none');
  expect(cell.find('.cell-glyph').text()).toBe('·');
  expect(cell.find('.cell-num').text()).toBe('—');
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

test('R64: cell text shows ok/total ratio (not raw counts)', async () => {
  const w = mountView();
  await flushPromises();
  // 核心 → 厦门 cell = DC-BJ-01(OK) + DC-BJ-02(partial) → 1/2
  // 2026-08-30 R68: scope to Full panel.
  const cell = fullPanel(w).find('[data-test="cell-核心站点-厦门站点"]');
  expect(cell.find('.cell-num').text()).toBe('1/2');
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
  expect(hubPanel.findAll('tbody tr').length).toBe(2);
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
  expect(spokePanel.findAll('tbody tr').length).toBe(2);
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
  expect(panel.findAll('tbody tr').length).toBe(3);
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