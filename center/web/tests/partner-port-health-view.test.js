// PartnerPortHealthView tests (round-47 复制伙伴端口健康监控).
//
// Mirrors the structure of replication-log-monitor-view.test.js — mounts
// the view with a stubbed AdminLayout, mocks the dashboardApi
// .getPartnerPortHealthAll to return a deterministic envelope, and pins
// the rendered DOM. Critical surface per operator directive:
//   - green  ≤1000ms
//   - yellow >1000ms
//   - red    ✕
//   - gray   —
// These tests pin every cell-state transition.

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../src/api/dashboard.js', () => ({
  dashboardApi: { getPartnerPortHealthAll: vi.fn() }
}));

import PartnerPortHealthView from '../src/views/admin/PartnerPortHealthView.vue';
import { dashboardApi } from '../src/api/dashboard.js';

function basePayload() {
  return {
    refreshSeconds: 10,
    sites: [
      {
        siteId: 1, siteName: '核心站点', regionCode: 'BJ', isHub: true, primaryDc: 'DC-BJ-01',
        dcs: [
          { dcName: 'DC-BJ-01', isBridgehead: true, isPdc: true, isGc: true,
            isRidMaster: false, isSchemaMaster: false, isDomainNamingMaster: false,
            isInfrastructureMaster: false, osVersion: 'Win2022',
            discoveredAt: '2026-08-27T09:00:00Z',
            partners: [] // bridgehead has no inbound partners in this scenario
          },
          { dcName: 'DC-BJ-02', isBridgehead: false, isPdc: false, isGc: true,
            isRidMaster: false, isSchemaMaster: false, isDomainNamingMaster: false,
            isInfrastructureMaster: false, osVersion: 'Win2019',
            discoveredAt: '2026-08-27T09:00:00Z',
            partners: [
              {
                peerType: 'within', peerDc: 'DC-BJ-01', peerSite: '核心站点',
                peerSiteIsHub: true,
                configuredPorts: [
                  { port: 135, label: 'RPC'   },
                  { port: 445, label: 'SMB'   },
                  { port: 389, label: 'LDAP'  },
                  { port: 636, label: 'LDAPS' },
                  { port: 50001, label: 'P1' },
                  { port: 50002, label: 'P2' }
                ],
                portHealth: [{
                  statusCode: 1,
                  lastAttemptTime: '2026-08-27T10:00:30Z',
                  // Mix all 4 R47 colour cases in one partner row:
                  //  135  : ok-fast   (≤1000ms)        → green
                  //  445  : ok-slow   (>1000ms)        → yellow
                  //  389  : ok=false                    → red
                  //  636  : missing                    → gray
                  //  50001: ok-fast                    → green
                  //  50002: ok=false                   → red
                  ports: [
                    { port: 135,  ok: true,  latency: 5 },
                    { port: 445,  ok: true,  latency: 1500 },
                    { port: 389,  ok: false, latency: null },
                    { port: 50001, ok: true,  latency: 8 },
                    { port: 50002, ok: false, latency: null }
                    // port 636 absent → no-data cell
                  ]
                }]
              }
            ]
          }
        ]
      },
      {
        siteId: 2, siteName: '上海站点', regionCode: 'SH', isHub: false, primaryDc: 'DC-SH-01',
        dcs: [
          { dcName: 'DC-SH-01', isBridgehead: false, isPdc: false, isGc: true,
            isRidMaster: false, isSchemaMaster: false, isDomainNamingMaster: false,
            isInfrastructureMaster: false, osVersion: 'Win2019',
            discoveredAt: '2026-08-27T09:00:00Z',
            partners: [
              {
                peerType: 'bridgehead', peerDc: 'DC-BJ-01', peerSite: '核心站点',
                peerSiteIsHub: true,
                configuredPorts: [
                  { port: 88,    label: 'HTTP'  },
                  { port: 135,   label: 'RPC'   },
                  { port: 389,   label: 'LDAP'  },
                  { port: 445,   label: 'SMB'   },
                  { port: 636,   label: 'LDAPS' },
                  { port: 3268,  label: 'GC'    },
                  { port: 50001, label: 'P1'    },
                  { port: 50002, label: 'P2'    },
                  { port: 50003, label: 'P3'    }
                ],
                portHealth: [] // no probe data — every cell should be no-data
              }
            ]
          }
        ]
      }
    ]
  };
}

beforeEach(() => { dashboardApi.getPartnerPortHealthAll.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

function mountView() {
  return mount(PartnerPortHealthView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
}

test('mounts, fetches once, renders hub-first site blocks', async () => {
  dashboardApi.getPartnerPortHealthAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();
  expect(dashboardApi.getPartnerPortHealthAll).toHaveBeenCalledTimes(1);
  const blocks = w.findAll('section.site-block');
  expect(blocks).toHaveLength(2);
  expect(blocks[0].text()).toContain('核心站点');
  expect(blocks[0].text()).toContain('中心');
  expect(blocks[1].text()).toContain('上海站点');
  // bridgehead role badge on DC-BJ-01
  expect(blocks[0].text()).toContain('桥头');
});

test('renders the H2 as "复制伙伴端口健康监控"', async () => {
  dashboardApi.getPartnerPortHealthAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();
  const h2 = w.find('header h2');
  expect(h2.exists()).toBe(true);
  expect(h2.text()).toBe('复制伙伴端口健康监控');
});

test('renders per-DC table with one column per configured port from partner.configuredPorts', async () => {
  dashboardApi.getPartnerPortHealthAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();
  // DC-BJ-02 has 1 partner (DC-BJ-01) with configuredPorts of 6 entries;
  // thead for that DC table must have 6 port columns (plus 2 leading
  // 伙伴站点 / 伙伴 DC columns). Port numbers are sorted numerically
  // ascending — 135 < 389 < 445 < 636 < 50001 < 50002.
  const bj02Table = w.find('[data-test-dc-block="DC-BJ-02"] .port-matrix');
  expect(bj02Table.exists()).toBe(true);
  const bj02Headers = bj02Table.findAll('thead th');
  // 2 leading cols + 6 port cols
  expect(bj02Headers.length).toBe(8);
  expect(bj02Headers[0].text()).toBe('伙伴站点');
  expect(bj02Headers[1].text()).toBe('伙伴 DC');
  const portColLabels = bj02Headers.slice(2).map(th => th.find('.port-num').text());
  expect(portColLabels).toEqual(['135', '389', '445', '636', '50001', '50002']);
});

test('cell colour rules: green ≤1000ms, yellow >1000ms, red ✕, gray —', async () => {
  // R47 critical: pin every cell-state transition. The basePayload's
  // DC-BJ-02 partner covers all 4 cases in one row. Cells are sorted by
  // port number ascending — 135 < 389 < 445 < 636 < 50001 < 50002 —
  // so cell index is NOT the same as fixture insertion order.
  dashboardApi.getPartnerPortHealthAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();
  const partnerRow = w.find('[data-test="partner-DC-BJ-02-DC-BJ-01"]');
  expect(partnerRow.exists()).toBe(true);
  const cells = partnerRow.findAll('td[data-test^="port-DC-BJ-02-DC-BJ-01-"]');
  expect(cells.length).toBe(6);

  // 135 → green   (ok + latency 5)
  expect(cells[0].classes()).toContain('cell-ok');
  expect(cells[0].text()).toBe('5ms');

  // 389 → red     (ok=false)  — index 1 due to numeric sort
  expect(cells[1].classes()).toContain('cell-down');
  expect(cells[1].text()).toBe('✕');

  // 445 → yellow  (ok + latency 1500 > 1000)  — index 2 due to numeric sort
  expect(cells[2].classes()).toContain('cell-slow');
  expect(cells[2].text()).toBe('1500ms');

  // 636 → gray    (missing from portHealth[0].ports[])
  expect(cells[3].classes()).toContain('cell-no-data');
  expect(cells[3].text()).toBe('—');

  // 50001 → green (ok + latency 8)
  expect(cells[4].classes()).toContain('cell-ok');
  expect(cells[4].text()).toBe('8ms');

  // 50002 → red   (ok=false)
  expect(cells[5].classes()).toContain('cell-down');
  expect(cells[5].text()).toBe('✕');
});

test('SLOW_THRESHOLD_MS boundary: latency === 1000 is still green', async () => {
  // Operator directive: "超过了1000ms标记为黄色" — >1000ms yellow,
  // ≤1000ms green. Pin the boundary at exactly 1000 (still green).
  const payload = basePayload();
  payload.sites[0].dcs[1].partners[0].portHealth[0].ports = [
    { port: 135, ok: true, latency: 1000 }
  ];
  dashboardApi.getPartnerPortHealthAll.mockResolvedValue({ data: payload });
  const w = mountView();
  await flushPromises();
  const cell = w.find('[data-test="port-DC-BJ-02-DC-BJ-01-135"]');
  expect(cell.exists()).toBe(true);
  expect(cell.classes()).toContain('cell-ok');
  expect(cell.text()).toBe('1000ms');
});

test('SLOW_THRESHOLD_MS boundary: latency === 1001 turns yellow', async () => {
  // Boundary from the other side: just over the threshold → yellow.
  const payload = basePayload();
  payload.sites[0].dcs[1].partners[0].portHealth[0].ports = [
    { port: 135, ok: true, latency: 1001 }
  ];
  dashboardApi.getPartnerPortHealthAll.mockResolvedValue({ data: payload });
  const w = mountView();
  await flushPromises();
  const cell = w.find('[data-test="port-DC-BJ-02-DC-BJ-01-135"]');
  expect(cell.classes()).toContain('cell-slow');
  expect(cell.text()).toBe('1001ms');
});

test('partner with empty portHealth[] renders all cells as no-data', async () => {
  // DC-SH-01's partner has portHealth: [] — every column should be '—'.
  dashboardApi.getPartnerPortHealthAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();
  const row = w.find('[data-test="partner-DC-SH-01-DC-BJ-01"]');
  expect(row.exists()).toBe(true);
  const cells = row.findAll('td[data-test^="port-DC-SH-01-DC-BJ-01-"]');
  // SH-01's partner configuredPorts has 9 entries → 9 port cells
  expect(cells.length).toBe(9);
  for (const c of cells) {
    expect(c.classes()).toContain('cell-no-data');
    expect(c.text()).toBe('—');
  }
});

test('polling: re-fetches every refreshSeconds * 1000 ms', async () => {
  vi.useFakeTimers();
  dashboardApi.getPartnerPortHealthAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();
  expect(dashboardApi.getPartnerPortHealthAll).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(dashboardApi.getPartnerPortHealthAll.mock.calls.length).toBeGreaterThanOrEqual(2);
});

test('clears interval on unmount', async () => {
  vi.useFakeTimers();
  dashboardApi.getPartnerPortHealthAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();
  w.unmount();
  await vi.advanceTimersByTimeAsync(30_000);
  // No further calls after unmount
  expect(dashboardApi.getPartnerPortHealthAll).toHaveBeenCalledTimes(1);
});

test('error banner shown when fetch fails', async () => {
  dashboardApi.getPartnerPortHealthAll.mockRejectedValue(new Error('boom'));
  const w = mountView();
  await flushPromises();
  expect(w.find('.error-banner').exists()).toBe(true);
  // No site blocks rendered
  expect(w.findAll('section.site-block').length).toBe(0);
});

test('empty sites list renders the empty-state hint', async () => {
  dashboardApi.getPartnerPortHealthAll.mockResolvedValue({ data: { refreshSeconds: 10, sites: [] } });
  const w = mountView();
  await flushPromises();
  expect(w.findAll('section.site-block').length).toBe(0);
  expect(w.text()).toContain('暂无站点');
});

test('hint paragraph mentions port health + ms values', async () => {
  dashboardApi.getPartnerPortHealthAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();
  const hint = w.find('p.hint');
  expect(hint.exists()).toBe(true);
  expect(hint.text()).toContain('端口');
  expect(hint.text()).toContain('ms');
});

test('legend shows all three R47 colour swatches', async () => {
  dashboardApi.getPartnerPortHealthAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();
  const legend = w.find('.legend');
  expect(legend.exists()).toBe(true);
  expect(legend.text()).toContain('≤1000ms');
  expect(legend.text()).toContain('>1000ms');
  expect(legend.text()).toContain('不可达');
  // Three swatch classes present
  expect(legend.findAll('.legend-swatch.swatch-ok').length).toBe(1);
  expect(legend.findAll('.legend-swatch.swatch-slow').length).toBe(1);
  expect(legend.findAll('.legend-swatch.swatch-down').length).toBe(1);
});

test('no caret / attempts surface — this view is port-health only', async () => {
  // R47 directive: drop the replication-attempts caret expansion entirely.
  // No data-test starting with "attempts-" must ever render.
  dashboardApi.getPartnerPortHealthAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();
  expect(w.findAll('[data-test^="attempts-"]').length).toBe(0);
  expect(w.findAll('.caret-btn').length).toBe(0);
  expect(w.findAll('.attempts-table').length).toBe(0);
});