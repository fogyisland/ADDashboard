// ReplicationLogMonitorView tests (round-42 复制日志监控).
//
// Mirrors the structure of site-replication-matrix-view.test.js — mounts
// the view with a stubbed AdminLayout, mocks the dashboardApi.getReplicationLogAll
// to return a deterministic envelope, and pins the rendered DOM.

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../src/api/dashboard.js', () => ({
  dashboardApi: { getReplicationLogAll: vi.fn() }
}));

import ReplicationLogMonitorView from '../src/views/admin/ReplicationLogMonitorView.vue';
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
                peerSiteIsHub: true, statusCode: 0,
                namingContext: 'DC=contoso,DC=com',
                direction: 'in',
                lastSuccessTime: '2026-08-27T10:00:00Z',
                lastAttemptTime:  '2026-08-27T10:00:30Z',
                durationMinutes: 1,
                attempts: [
                  { attemptAt: '2026-08-27T10:00:30Z', statusCode: 0, durationMs: 100, objectsTransferred: 50, lastSuccessTime: '2026-08-27T10:00:30Z', errorMessage: null },
                  { attemptAt: '2026-08-27T09:55:30Z', statusCode: 0, durationMs: 120, objectsTransferred: 40, lastSuccessTime: '2026-08-27T09:55:30Z', errorMessage: null },
                  { attemptAt: '2026-08-27T09:50:30Z', statusCode: 2, durationMs: null, objectsTransferred: null, lastSuccessTime: null, errorMessage: 'Target principal name incorrect' }
                ]
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
                peerSiteIsHub: true, statusCode: 0,
                namingContext: 'DC=contoso,DC=com',
                direction: 'in',
                lastSuccessTime: '2026-08-27T10:00:00Z',
                lastAttemptTime:  '2026-08-27T10:00:30Z',
                durationMinutes: 12,
                attempts: [] // empty — tests that empty state is rendered, not crashed
              }
            ]
          }
        ]
      }
    ]
  };
}

beforeEach(() => { dashboardApi.getReplicationLogAll.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

function mountView() {
  return mount(ReplicationLogMonitorView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
}

test('mounts, fetches once, renders hub-first site blocks', async () => {
  dashboardApi.getReplicationLogAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();
  expect(dashboardApi.getReplicationLogAll).toHaveBeenCalledTimes(1);
  const blocks = w.findAll('section.site-block');
  expect(blocks).toHaveLength(2);
  expect(blocks[0].text()).toContain('核心站点');
  expect(blocks[0].text()).toContain('中心');
  expect(blocks[1].text()).toContain('上海站点');
  // bridgehead role badge on DC-BJ-01
  expect(blocks[0].text()).toContain('桥头');
});

test('partner row initially collapsed; expanding reveals attempts[]', async () => {
  dashboardApi.getReplicationLogAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();
  // Initially: no attempts-row rendered
  expect(w.find('[data-test="attempts-DC-BJ-02-DC-BJ-01"]').exists()).toBe(false);
  // Find the partner row's caret button
  const caret = w.find('[data-test="partner-DC-BJ-02-DC-BJ-01"] button.caret-btn');
  expect(caret.exists()).toBe(true);
  await caret.trigger('click');
  await flushPromises();
  // After click, attempts-row renders
  const expanded = w.find('[data-test="attempts-DC-BJ-02-DC-BJ-01"]');
  expect(expanded.exists()).toBe(true);
  // attempts table has 3 rows. Scope to the inner .attempts-table so the
  // outer matrix tbody (which holds the partner row + this attempts row)
  // doesn't add its own <tr> to the count. CSS 'tbody tr' would otherwise
  // walk up the DOM tree if Vue test-utils treats the matched element as
  // a wrapper rather than the inner DOM node (this is what tripped the
  // assertion up to 4 rows during the round-42 lock-down).
  const attemptRows = expanded.findAll('.attempts-table tbody tr');
  expect(attemptRows.length).toBe(3);
  // The failure entry is shown with its error message
  expect(expanded.text()).toContain('Target principal name incorrect');
  // Click again to collapse
  await caret.trigger('click');
  await flushPromises();
  expect(w.find('[data-test="attempts-DC-BJ-02-DC-BJ-01"]').exists()).toBe(false);
});

test('partner row with empty attempts[] renders the empty-state hint', async () => {
  dashboardApi.getReplicationLogAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();
  // DC-SH-01 has 1 partner (DC-BJ-01) with attempts: []
  const caret = w.find('[data-test="partner-DC-SH-01-DC-BJ-01"] button.caret-btn');
  await caret.trigger('click');
  await flushPromises();
  const expanded = w.find('[data-test="attempts-DC-SH-01-DC-BJ-01"]');
  expect(expanded.exists()).toBe(true);
  expect(expanded.text()).toContain('暂无历史记录');
});

test('polling: re-fetches every refreshSeconds * 1000 ms', async () => {
  vi.useFakeTimers();
  dashboardApi.getReplicationLogAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();
  expect(dashboardApi.getReplicationLogAll).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(dashboardApi.getReplicationLogAll.mock.calls.length).toBeGreaterThanOrEqual(2);
});

test('clears interval on unmount', async () => {
  vi.useFakeTimers();
  dashboardApi.getReplicationLogAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();
  w.unmount();
  await vi.advanceTimersByTimeAsync(30_000);
  // No further calls after unmount
  expect(dashboardApi.getReplicationLogAll).toHaveBeenCalledTimes(1);
});

test('error banner shown when fetch fails', async () => {
  dashboardApi.getReplicationLogAll.mockRejectedValue(new Error('boom'));
  const w = mountView();
  await flushPromises();
  expect(w.find('.error-banner').exists()).toBe(true);
  // No site blocks rendered
  expect(w.findAll('section.site-block').length).toBe(0);
});

test('empty sites list renders the empty-state hint', async () => {
  dashboardApi.getReplicationLogAll.mockResolvedValue({ data: { refreshSeconds: 10, sites: [] } });
  const w = mountView();
  await flushPromises();
  expect(w.findAll('section.site-block').length).toBe(0);
  expect(w.text()).toContain('暂无站点');
});

// 2026-08-28 round-43: 方向 column (进 / 出 / 双向). The route emits a
// separate partner row per direction; the view merges same-(peerDc, NC)
// entries into a single 双向 row when both directions exist.
test('renders 方向 column with 进 badge for inbound partner', async () => {
  dashboardApi.getReplicationLogAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();
  // Header should include 方向 column
  const headers = w.findAll('th').map(th => th.text());
  expect(headers).toContain('方向');
  // DC-SH-01 → DC-BJ-01 has direction: 'in'
  const partnerRow = w.find('[data-test="partner-DC-SH-01-DC-BJ-01"]');
  expect(partnerRow.exists()).toBe(true);
  expect(partnerRow.attributes('data-test-direction')).toBe('in');
  // 进 tag rendered
  const dirTag = partnerRow.find('.dir-tag');
  expect(dirTag.text()).toBe('进');
  expect(dirTag.classes()).toContain('dir-tag-in');
});

test('R46 inbound-only: payload contains only inbound partners', async () => {
  // Round-46: 复制日志监控 only surfaces inbound partner rows. Outbound
  // (本机 → partner) is meaningless — to the partner it IS their inbound.
  // The route strips outbound before serializing; the view only ever sees
  // direction='in' partners in payload.partners[]. This test pins the
  // basePayload() invariant: all partner rows must be 'in'.
  const payload = basePayload();
  for (const site of payload.sites) {
    for (const dc of site.dcs) {
      for (const p of dc.partners) {
        expect(p.direction).toBe('in');
      }
    }
  }
  // And only inbound partner rows render
  dashboardApi.getReplicationLogAll.mockResolvedValue({ data: payload });
  const w = mountView();
  await flushPromises();
  // All visible rows carry direction='in'
  const inRows = w.findAll('[data-test-direction="in"]');
  expect(inRows.length).toBeGreaterThan(0);
  const outRows = w.findAll('[data-test-direction="out"]');
  expect(outRows.length).toBe(0);
});

test('legend shows the inbound swatch (R46 inbound-only)', async () => {
  // Round-46: legend now only documents the single direction shown
  // (inbound). Outbound/双向 removed since the route filters them out.
  dashboardApi.getReplicationLogAll.mockResolvedValue({ data: basePayload() });
  const w = mountView();
  await flushPromises();
  const legend = w.find('.legend');
  expect(legend.exists()).toBe(true);
  expect(legend.text()).toContain('进');
  expect(legend.text()).toContain('入站');
  // Port-health swatches still present (R46 restored port monitoring
  // for this view).
  expect(legend.text()).toContain('端口可达');
  expect(legend.text()).toContain('端口不可达');
});