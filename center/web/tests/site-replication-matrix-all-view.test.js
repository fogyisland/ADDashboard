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

// 2026-08-27 round-36 envelope: each site carries `dcPartners[]` — one
// entry per DC in the site, each with its own partners[] + role flags +
// osVersion. The route ALSO emits top-level `partners` (mirrors bridgehead
// primary's dcPartners entry) for backwards compat with consumers that
// still deep-link to p.partners, but the view iterates dcPartners[].
//
// round-35 inbound-only filter is still active — every partner row is
// inbound by definition (source_dc → THIS dest_dc); outbound is dropped.
const basePayload = () => ({
  siteRefreshSeconds: 10,
  ports: [135, 445, 50001],
  primaries: [
    {
      dcName: 'DC-BJ-01', siteId: 1, siteName: '核心站点',
      regionCode: 'BJ', isHub: true,
      // round-28.5: hub DC explicitly marked bridgehead by operator
      isBridgehead: true,
      dcs: [
        { dcName: 'DC-BJ-01', isBridgehead: true, isPdc: true, isGc: true,
          isRidMaster: false, isSchemaMaster: false, isDomainNamingMaster: false,
          isInfrastructureMaster: false, osVersion: 'Win2022', discoveredAt: '2026-08-27T08:00:00Z' },
        { dcName: 'DC-BJ-02', isBridgehead: false, isPdc: false, isGc: true,
          isRidMaster: true, isSchemaMaster: true, isDomainNamingMaster: false,
          isInfrastructureMaster: false, osVersion: 'Win2019', discoveredAt: '2026-08-27T08:00:00Z' }
      ],
      // round-36: per-DC partner tables. 核心站点 has 2 DCs.
      //   - DC-BJ-01: inbound from DC-BJ-02 (within-site) perPort=null
      //   - DC-BJ-02: no inbound in this scenario (BJ-02 has no inbound
      //     because all within-site links in the matrix go from BJ-01 →
      //     BJ-02 outbound, dropped; cross-site BJ-02 → SH-01 dropped
      //     because SH-01 isn't a peer DC here)
      dcPartners: [
        { dcName: 'DC-BJ-01', isBridgehead: true, isPdc: true, isGc: true,
          isRidMaster: false, isSchemaMaster: false, isDomainNamingMaster: false,
          isInfrastructureMaster: false, osVersion: 'Win2022', discoveredAt: '2026-08-27T08:00:00Z',
          partners: [
            { peerDc: 'DC-BJ-02', peerSite: '核心站点', peerSiteIsHub: true,
              peerType: 'within',
              statusCode: 0, perPort: null, lastProbeAt: null }
          ] },
        { dcName: 'DC-BJ-02', isBridgehead: false, isPdc: false, isGc: true,
          isRidMaster: true, isSchemaMaster: true, isDomainNamingMaster: false,
          isInfrastructureMaster: false, osVersion: 'Win2019', discoveredAt: '2026-08-27T08:00:00Z',
          partners: [] }
      ],
      // round-36: top-level partners mirrors bridgehead primary's
      // dcPartners entry (DC-BJ-01) — kept for backwards compat with
      // deep-links.
      partners: [
        { peerDc: 'DC-BJ-02', peerSite: '核心站点', peerSiteIsHub: true,
          peerType: 'within',
          statusCode: 0, perPort: null, lastProbeAt: null }
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
      // round-36: 1 DC → 1 dcPartners entry, with 1 inbound bridgehead.
      dcPartners: [
        { dcName: 'DC-SH-01', isBridgehead: false, isPdc: false, isGc: false,
          isRidMaster: false, isSchemaMaster: false, isDomainNamingMaster: false,
          isInfrastructureMaster: false, osVersion: 'Win2019', discoveredAt: '2026-08-27T08:00:00Z',
          partners: [
            { peerDc: 'DC-BJ-01', peerSite: '核心站点', peerSiteIsHub: true,
              peerType: 'bridgehead',
              statusCode: 1,
              // round-36.1: perPort shape mirrors what
              // collect-replication.ps1::Get-PartnerPortSnapshot writes to
              // ad_replication_status.partner_port_status JSON column:
              // `{ checked_at, ports: { '<port>': {reachable, latencyMs, error} } }`.
              // The view reads `perPort.ports[port]` (not `perPort[port]`)
              // — round-32 code read the wrong path and every badge
              // silently fell through to "无探测".
              perPort: { checked_at: '2026-08-27T10:00:00Z',
                         ports: { '135':   { reachable: true,  latencyMs: 3 },
                                  '445':   { reachable: false, latencyMs: null, error: 'timeout' } } },
              lastProbeAt: '2026-08-27T10:00:00Z' }
          ] }
      ],
      partners: [
        { peerDc: 'DC-BJ-01', peerSite: '核心站点', peerSiteIsHub: true,
          peerType: 'bridgehead',
          statusCode: 1,
          perPort: { checked_at: '2026-08-27T10:00:00Z',
                     ports: { '135': { reachable: true,  latencyMs: 3 },
                              '445': { reachable: false, latencyMs: null, error: 'timeout' } } },
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

test('mounts and renders hub-first site blocks with hub badge', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  const blocks = w.findAll('section.site-block');
  expect(blocks).toHaveLength(2);
  // Hub block (核心站点): h3 hub-badge "yes"
  expect(blocks[0].text()).toContain('核心站点');
  expect(blocks[0].find('h3 .hub-badge.yes').exists()).toBe(true);
  // round-36: no "→ DC-BJ-01" anymore — the per-DC blocks replace the
  // single primary-DC pointer. Instead the dc-count chip shows N DC.
  expect(blocks[0].text()).toContain('2 DC');
  expect(blocks[0].find('h3 .primary-dc').exists()).toBe(false);
  // Spoke block (上海站点): h3 hub-badge "no" only
  expect(blocks[1].text()).toContain('上海站点');
  expect(blocks[1].find('h3 .hub-badge.yes').exists()).toBe(false);
  expect(blocks[1].find('h3 .hub-badge.no').exists()).toBe(true);
  expect(blocks[1].text()).toContain('1 DC');
});

test('round-36: every DC in the site renders its own partner matrix block', async () => {
  // 核心站点 has 2 DCs → 2 .dc-block sections (one per DC).
  // 上海站点 has 1 DC → 1 .dc-block section.
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();

  // 3 dc-block total: BJ-01, BJ-02, SH-01
  const dcBlocks = w.findAll('.dc-block');
  expect(dcBlocks).toHaveLength(3);

  // DC-BJ-01 block: header shows PDC+GC+桥头 role badges + Win2022 + 1 partner
  const bj01Block = w.find('[data-test-dc-block="DC-BJ-01"]');
  expect(bj01Block.exists()).toBe(true);
  expect(bj01Block.text()).toContain('DC-BJ-01');
  expect(bj01Block.text()).toContain('PDC');
  expect(bj01Block.text()).toContain('GC');
  expect(bj01Block.text()).toContain('桥头');
  expect(bj01Block.text()).toContain('Win2022');
  expect(bj01Block.text()).toContain('1 伙伴');

  // DC-BJ-02 block: header shows RID + Schema + Win2019 + 0 partners (空矩阵)
  const bj02Block = w.find('[data-test-dc-block="DC-BJ-02"]');
  expect(bj02Block.exists()).toBe(true);
  expect(bj02Block.text()).toContain('DC-BJ-02');
  expect(bj02Block.text()).toContain('RID');
  expect(bj02Block.text()).toContain('Schema');
  expect(bj02Block.text()).toContain('Win2019');
  expect(bj02Block.text()).toContain('0 伙伴');

  // DC-SH-01 block: 1 partner
  const sh01Block = w.find('[data-test-dc-block="DC-SH-01"]');
  expect(sh01Block.exists()).toBe(true);
  expect(sh01Block.text()).toContain('DC-SH-01');
  expect(sh01Block.text()).toContain('1 伙伴');
});

test('partner row renders inbound peer + colored port cells (no direction column)', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  // round-35: 方向 column removed. Every partner row is inbound by
  // definition; the direction badge (← 入) is gone.
  // round-36: data-test attr scoped per DC: data-test="partner-<peerType>-<destDc>-<peerDc>"
  // 上海站点 DC-SH-01's inbound from DC-BJ-01 with probe data
  const inRow = w.find('[data-test="partner-bridgehead-DC-SH-01-DC-BJ-01"]');
  expect(inRow.exists()).toBe(true);
  expect(inRow.text()).not.toContain('→ 出');
  expect(inRow.text()).not.toContain('← 入');
  expect(inRow.text()).toContain('DC-BJ-01');
  expect(inRow.text()).toContain('核心站点');
  // 3 port cells rendered (135, 445, 50001)
  const portCells = inRow.findAll('.port-cell');
  expect(portCells).toHaveLength(3);
  expect(portCells[0].classes()).toContain('port-ok');
  expect(portCells[1].classes()).toContain('port-err');
  expect(portCells[2].classes()).toContain('port-none');

  // 核心站点 DC-BJ-01's within-site inbound from DC-BJ-02
  const withinRow = w.find('[data-test="partner-within-DC-BJ-01-DC-BJ-02"]');
  expect(withinRow.exists()).toBe(true);
  expect(withinRow.text()).toContain('DC-BJ-02');
});

test('round-35: matrix table headers omit 方向 (inbound-only view)', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  // round-32 column order was: 类型 / 方向 / 伙伴站点 / 伙伴 DC / 状态
  // round-35 drops 方向: 类型 / 伙伴站点 / 伙伴 DC / 状态
  const headers = w.findAll('section.site-block .dc-block table thead th');
  expect(headers.length).toBeGreaterThanOrEqual(4);
  expect(headers[0].text()).toContain('类型');
  expect(headers[1].text()).toContain('伙伴站点');
  expect(headers[2].text()).toContain('伙伴 DC');
  expect(headers[3].text()).toContain('状态');
  // round-35: no 方向 header
  const headerTexts = headers.map(h => h.text());
  expect(headerTexts.some(t => t.includes('方向'))).toBe(false);
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

// 2026-08-27 round-32: each partner row surfaces a "类型" cell with a
// tag — "本站" for within-site siblings, "桥头" for cross-site bridgehead
// peers. The CSS class `.peer-tag-within` / `.peer-tag-bridgehead` drives
// the colour. Operators can see at a glance whether a link goes via a
// bridgehead vs. an in-site connection.
test('round-32: each partner row has a 类型 cell with within/bridgehead tag', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();

  // round-35: data-test attribute dropped the direction segment —
  // every row is inbound. round-36: scoped per-DC.
  // Within partner: DC-BJ-01 ← DC-BJ-02 (BJ-02 replicates TO BJ-01) shows
  // "本站" + within class.
  const withinRow = w.find('[data-test="partner-within-DC-BJ-01-DC-BJ-02"]');
  expect(withinRow.exists()).toBe(true);
  const withinTag = withinRow.find('.peer-tag-within');
  expect(withinTag.exists()).toBe(true);
  expect(withinTag.text()).toBe('本站');

  // Bridgehead partner: DC-SH-01 ← DC-BJ-01 shows "桥头" + bridgehead class
  const bridgeheadRow = w.find('[data-test="partner-bridgehead-DC-SH-01-DC-BJ-01"]');
  expect(bridgeheadRow.exists()).toBe(true);
  const bridgeheadTag = bridgeheadRow.find('.peer-tag-bridgehead');
  expect(bridgeheadTag.exists()).toBe(true);
  expect(bridgeheadTag.text()).toBe('桥头');
});

// 2026-08-27 round-32: each port cell embeds the PowerShell probe result
// inline — port number on top, latency / error reason / "—" below.
// Operators see e.g. "135 / 3ms" without hovering. The probe error
// reason is rendered inline (not hidden in a tooltip) so it's visible
// during incident triage.
test('round-32: each port cell shows port number + latency/error inline', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();

  // round-35: data-test dropped the direction segment. bridgehead
  // partner row (DC-SH-01 ← DC-BJ-01) has perPort data:
  //   135 → reachable latencyMs=3, 445 → reachable=false error=timeout, 50001 → missing
  const inRow = w.find('[data-test="partner-bridgehead-DC-SH-01-DC-BJ-01"]');
  expect(inRow.exists()).toBe(true);
  const portCells = inRow.findAll('.port-cell');
  expect(portCells).toHaveLength(3);

  // Cell 1: port 135, ok, latency 3ms inline
  expect(portCells[0].text()).toContain('135');
  expect(portCells[0].text()).toContain('3ms');
  expect(portCells[0].find('.port-detail').text()).toBe('3ms');

  // Cell 2: port 445, err, error "timeout" inline (NOT hidden in tooltip)
  expect(portCells[1].text()).toContain('445');
  expect(portCells[1].text()).toContain('timeout');
  expect(portCells[1].find('.port-detail').text()).toBe('timeout');

  // Cell 3: port 50001, no probe data → "—"
  expect(portCells[2].text()).toContain('50001');
  expect(portCells[2].find('.port-detail').text()).toBe('—');
});

// 2026-08-27 round-36: per-DC port-health summary chip (was per-primary
// in round-32). Sits inside each .dc-block just above the matrix so
// operators see "X 通 / Y 不通 / 最新探测时间" for THIS DC.
test('round-36: per-DC port-health summary chip shows ok/err counts + latest probe time', async () => {
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: basePayload() });
  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();

  // DC-BJ-01: 1 within partner with perPort=null → 3 cells all port-none
  // → "无探测" chip
  const bj01Summary = w.find('[data-test-port-summary="DC-BJ-01"]');
  expect(bj01Summary.exists()).toBe(true);
  expect(bj01Summary.text()).toContain('无探测');

  // DC-BJ-02: 0 partners → portHealth object still computed but no
  // partners × ports = 0 total. unprobed stays false because total=0.
  // Chip renders empty space (no chip rendered because v-if="dc.portHealth.unprobed"
  // is false and the v-else block has nothing to show without totals).
  const bj02Summary = w.find('[data-test-port-summary="DC-BJ-02"]');
  expect(bj02Summary.exists()).toBe(true);

  // DC-SH-01: 1 bridgehead partner with mixed probe data: 135 ok, 445
  // err, 50001 missing. So 1 通, 1 不通, total=2.
  const sh01Summary = w.find('[data-test-port-summary="DC-SH-01"]');
  expect(sh01Summary.exists()).toBe(true);
  expect(sh01Summary.text()).toMatch(/●\s*1\s*通/);
  expect(sh01Summary.text()).toMatch(/✕\s*1\s*不通/);
  expect(sh01Summary.text()).not.toContain('无探测');
  // Latest probe timestamp surfaced
  expect(sh01Summary.text()).toContain('最近探测');
});

// 2026-08-27 round-36: empty site renders "该站点暂无 DC" empty state
// (replaces the round-31 "本站 DC 清单" panel).
test('round-36: empty dcPartners array renders "该站点暂无 DC" empty state', async () => {
  const empty = {
    siteRefreshSeconds: 10,
    ports: [135, 445],
    primaries: [{
      dcName: 'DC-X', siteId: 9, siteName: '空站点',
      regionCode: null, isHub: false, isBridgehead: false,
      dcs: [], dcPartners: [], partners: []
    }]
  };
  dashboardApi.getSiteReplicationMatrixAll.mockResolvedValue({ data: empty });
  const w = mount(SiteReplicationMatrixAllView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  // round-36: empty state text moved to the new section
  const blocks = w.findAll('section.site-block');
  expect(blocks).toHaveLength(1);
  expect(blocks[0].text()).toContain('该站点暂无 DC');
});