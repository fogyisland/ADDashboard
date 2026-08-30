// 2026-08-30 R67-T2: 包执行状态监控 — frontend AppLayout view tests.
// Verifies the package runs summary + recent-runs drill-down surface
// renders correctly across the status-classification paths (ok / warn /
// err / none) and exercises the polling lifecycle.

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import PackageRunsMonitorView from '../src/views/PackageRunsMonitorView.vue';

const RouterLinkStub = {
  props: ['to'],
  template: '<a :href="to"><slot /></a>'
};

// Stub the API client so tests don't need a real backend.
const getPackagesRuns = vi.fn();

vi.mock('../src/api/dashboard.js', () => ({
  dashboardApi: {
    getPackagesRuns: () => getPackagesRuns()
  }
}));

// Stub AppLayout so the test only sees the view body.
vi.mock('../src/components/AppLayout.vue', () => ({
  default: {
    name: 'AppLayout',
    template: '<div class="app-layout-stub"><slot /></div>'
  }
}));

function makePayload(overrides = {}) {
  const now = Date.now();
  const minutesAgo = (n) => new Date(now - n * 60_000).toISOString();
  return {
    refreshSeconds: 10,
    packages: [
      {
        name: 'ad_os_baseline',
        version: '1.0.0',
        type: 'gauge',
        agentType: 'ad',
        description: 'OS baseline check',
        summary24h: { total: 3, success: 3, failure: 0, partial: 0, lastRunAt: minutesAgo(5) },
        recent: [
          { id: 1, agentId: 'MOCK-HUBADSRV1', startedAt: minutesAgo(5), finishedAt: minutesAgo(4), exitCode: 0, durationMs: 60_000, stdoutPreview: 'ok', stderrPreview: null, error: null },
          { id: 2, agentId: 'MOCK-NCADSRV1', startedAt: minutesAgo(20), finishedAt: minutesAgo(19), exitCode: 0, durationMs: 60_000, stdoutPreview: 'ok', stderrPreview: null, error: null },
          { id: 3, agentId: 'MOCK-NCADSRV1', startedAt: minutesAgo(30), finishedAt: minutesAgo(29), exitCode: 0, durationMs: 60_000, stdoutPreview: 'ok', stderrPreview: null, error: null }
        ]
      },
      {
        name: 'ad_local_port_check',
        version: '1.0.0',
        type: 'gauge',
        agentType: 'ad',
        description: 'Local port probe',
        summary24h: { total: 2, success: 1, failure: 1, partial: 0, lastRunAt: minutesAgo(5) },
        recent: [
          // Listed with failure first so the drill-down surfaces the most
          // actionable row at the top — operators scan for the red row.
          { id: 5, agentId: 'MOCK-NCADSRV1', startedAt: minutesAgo(15), finishedAt: minutesAgo(14), exitCode: 2, durationMs: 60_000, stdoutPreview: null, stderrPreview: 'port 88 unreachable', error: 'port 88 unreachable' },
          { id: 4, agentId: 'MOCK-HUBADSRV1', startedAt: minutesAgo(5), finishedAt: minutesAgo(4), exitCode: 0, durationMs: 60_000, stdoutPreview: 'all reachable', stderrPreview: null, error: null }
        ]
      },
      {
        name: 'ad_lockout_summary',
        version: '1.0.0',
        type: 'timeseries',
        agentType: 'ad',
        description: 'Lockout 15-min summary',
        summary24h: { total: 1, success: 0, failure: 0, partial: 1, lastRunAt: minutesAgo(45) },
        recent: [
          { id: 6, agentId: 'MOCK-HUBADSRV1', startedAt: minutesAgo(45), finishedAt: minutesAgo(44), exitCode: null, durationMs: 60_000, stdoutPreview: 'partial', stderrPreview: 'partial output', error: null }
        ]
      },
      {
        name: 'ad_unused_pkg',
        version: '0.0.0',
        type: 'gauge',
        agentType: 'ad',
        description: 'Never ran',
        summary24h: { total: 0, success: 0, failure: 0, partial: 0, lastRunAt: null },
        recent: []
      }
    ],
    ...overrides
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  getPackagesRuns.mockReset();
  getPackagesRuns.mockResolvedValue({ data: makePayload() });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('renders one card per package with correct status classification', async () => {
  const w = mount(PackageRunsMonitorView, {
    global: { stubs: { 'router-link': RouterLinkStub } }
  });
  await flushPromises();

  // data-test="card-grid" shares the `card-` prefix with the cards.
  // We use `:not([data-test="card-grid"])` to count only per-package cards.
  const cards = w.findAll('[data-test^="card-"]').filter(
    (n) => n.attributes('data-test') !== 'card-grid'
  );
  expect(cards.length).toBe(4);

  // ok (green) — all-success package
  const okCard = w.find('[data-test="card-ad_os_baseline"]');
  expect(okCard.classes()).toContain('card-ok');
  const okPill = w.find('[data-test="pill-ad_os_baseline"]');
  expect(okPill.text()).toContain('全部成功');

  // err (red) — has failure
  const errCard = w.find('[data-test="card-ad_local_port_check"]');
  expect(errCard.classes()).toContain('card-err');
  const errPill = w.find('[data-test="pill-ad_local_port_check"]');
  expect(errPill.text()).toContain('1 失败');

  // warn (yellow) — only partial
  const warnCard = w.find('[data-test="card-ad_lockout_summary"]');
  expect(warnCard.classes()).toContain('card-warn');
  const warnPill = w.find('[data-test="pill-ad_lockout_summary"]');
  expect(warnPill.text()).toContain('1 部分');

  // none (gray) — no runs
  const noneCard = w.find('[data-test="card-ad_unused_pkg"]');
  expect(noneCard.classes()).toContain('card-none');
  const nonePill = w.find('[data-test="pill-ad_unused_pkg"]');
  expect(nonePill.text()).toBe('无数据');
});

test('summary counters reflect backend summary24h values', async () => {
  const w = mount(PackageRunsMonitorView, {
    global: { stubs: { 'router-link': RouterLinkStub } }
  });
  await flushPromises();

  // ad_local_port_check: success=1 failure=1 partial=0 total=2
  const summary = w.find('[data-test="summary-ad_local_port_check"]');
  const nums = summary.findAll('.summary-num').map((n) => n.text());
  expect(nums).toContain('1');
  expect(nums).toContain('2');
});

test('recent runs table renders one row per run with error detail', async () => {
  const w = mount(PackageRunsMonitorView, {
    global: { stubs: { 'router-link': RouterLinkStub } }
  });
  await flushPromises();

  const recent = w.find('[data-test="recent-ad_local_port_check"]');
  const rows = recent.findAll('tbody tr');
  expect(rows.length).toBe(2);

  // First row is the failure (id=5) — surfaces the stderr_preview
  const firstRow = rows[0];
  expect(firstRow.classes()).toContain('recent-err');
  expect(firstRow.text()).toContain('MOCK-NCADSRV1');
  expect(firstRow.text()).toContain('port 88 unreachable');
  // Glyph = ✕, label = 失败
  expect(firstRow.text()).toContain('✕');
  expect(firstRow.text()).toContain('失败');

  // Second row is the success — glyph = ✓, label = 成功
  const secondRow = rows[1];
  expect(secondRow.classes()).toContain('recent-ok');
  expect(secondRow.text()).toContain('✓');
  expect(secondRow.text()).toContain('成功');
});

test('empty packages array renders the empty-state banner', async () => {
  getPackagesRuns.mockResolvedValue({ data: { refreshSeconds: 10, packages: [] } });
  const w = mount(PackageRunsMonitorView, {
    global: { stubs: { 'router-link': RouterLinkStub } }
  });
  await flushPromises();
  expect(w.find('[data-test="empty"]').exists()).toBe(true);
  expect(w.find('[data-test="card-grid"]').exists()).toBe(false);
});

test('recent-empty placeholder renders when summary24h.total > 0 but recent[] is empty (defensive)', async () => {
  getPackagesRuns.mockResolvedValue({
    data: {
      refreshSeconds: 10,
      packages: [{
        name: 'ad_only_old_runs', version: '1.0.0',
        type: 'gauge', agentType: 'ad', description: 'x',
        summary24h: { total: 0, success: 0, failure: 0, partial: 0, lastRunAt: null },
        recent: []
      }]
    }
  });
  const w = mount(PackageRunsMonitorView, {
    global: { stubs: { 'router-link': RouterLinkStub } }
  });
  await flushPromises();
  // The 24h summary is empty AND recent[] is empty — the empty-state inside
  // the card ("暂无 24 小时内的执行记录") should render.
  const card = w.find('[data-test="card-ad_only_old_runs"]');
  expect(card.find('.recent-empty').exists()).toBe(true);
});

test('error banner surfaces when API call rejects', async () => {
  getPackagesRuns.mockRejectedValue({ response: { data: { error: 'internal' } } });
  const w = mount(PackageRunsMonitorView, {
    global: { stubs: { 'router-link': RouterLinkStub } }
  });
  await flushPromises();
  expect(w.find('[data-test="error-banner"]').exists()).toBe(true);
  expect(w.find('[data-test="error-banner"]').text()).toBe('internal');
});

test('polls every refreshSeconds after initial load + clears on unmount', async () => {
  const w = mount(PackageRunsMonitorView, {
    global: { stubs: { 'router-link': RouterLinkStub } }
  });
  await flushPromises();
  // Initial mount triggers 1 fetch
  expect(getPackagesRuns).toHaveBeenCalledTimes(1);

  // Advance time past 10s → 1 poll
  await vi.advanceTimersByTimeAsync(10_000);
  expect(getPackagesRuns).toHaveBeenCalledTimes(2);

  // Advance 30s → 3 more polls (cumulative 5)
  await vi.advanceTimersByTimeAsync(30_000);
  expect(getPackagesRuns).toHaveBeenCalledTimes(5);

  // Unmount clears the timer
  w.unmount();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(getPackagesRuns).toHaveBeenCalledTimes(5);
});

test('description field renders the manifest description verbatim', async () => {
  const w = mount(PackageRunsMonitorView, {
    global: { stubs: { 'router-link': RouterLinkStub } }
  });
  await flushPromises();
  expect(w.find('[data-test="desc-ad_os_baseline"]').text()).toBe('OS baseline check');
});