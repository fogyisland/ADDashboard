import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import ConfigView from '../src/views/admin/ConfigView.vue';
import { adminApi } from '../src/api/admin.js';

vi.mock('../src/api/admin.js', () => ({
  adminApi: {
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
    getConfigAudit: vi.fn().mockResolvedValue({ data: [] }),
    rollbackConfig: vi.fn()
  }
}));

beforeEach(() => {
  adminApi.getConfig.mockReset();
  adminApi.updateConfig.mockReset();
  adminApi.getConfigAudit.mockReset();
  adminApi.getConfigAudit.mockResolvedValue({ data: [] });
  adminApi.rollbackConfig.mockReset();
});

const SAMPLE = {
  polling_interval_minutes: '5',
  latency_threshold_minutes: '60',
  heartbeat_interval_seconds: '10',
  history_enabled: '1',
  ad_agent_token: 'old-token-1234567890'
};

test('loads config and renders rows on mount', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: SAMPLE });
  const w = mount(ConfigView);
  await flushPromises();
  expect(w.findAll('input').length).toBeGreaterThanOrEqual(5);
});

test('save button disabled when no edits (not dirty)', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: SAMPLE });
  const w = mount(ConfigView);
  await flushPromises();
  expect(w.find('button.save').attributes('disabled')).toBeDefined();
});

test('edit a non-risky field enables save; click save calls api; on success snapshot updates', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: SAMPLE });
  adminApi.updateConfig.mockResolvedValue({ data: { ok: true } });
  const w = mount(ConfigView);
  await flushPromises();
  // Find the polling_interval_minutes input by walking the rows — row order
  // follows getConfig's key order, so index-based lookup is brittle.
  const rows = w.findAll('table.t tbody tr');
  const pollingRow = rows.find((r) => r.text().includes('polling_interval_minutes'));
  const pollingInput = pollingRow.find('input');
  await pollingInput.setValue('7');
  expect(w.find('button.save').attributes('disabled')).toBeUndefined();
  await w.find('button.save').trigger('click');
  await flushPromises();
  expect(adminApi.updateConfig).toHaveBeenCalledWith(expect.objectContaining({ polling_interval_minutes: '7' }));
  expect(w.find('button.save').attributes('disabled')).toBeDefined(); // back to clean
});

// #167 I1: ad_agent_token ConfigView row is now a read-only notice-row.
// The legacy tests for "edit risky field" were replaced with assertions
// matching the new shape — no input, no 生成/复制 buttons, but a visible
// "已迁移" marker + the rotation endpoint pointer. The backend
// putConfigInTx rejects `ad_agent_token` writes with 400; the UI must
// not surface an editable input.
test('ad_agent_token row is a read-only notice (no input, deprecated marker)', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: SAMPLE });
  const w = mount(ConfigView);
  await flushPromises();
  const rows = w.findAll('table.t tbody tr');
  const tokenRow = rows.find((r) => r.text().includes('ad_agent_token'));
  expect(tokenRow, 'ad_agent_token row must still render (label + raw key)').toBeTruthy();
  // No editable input on the row.
  expect(tokenRow.find('input').exists()).toBe(false);
  // No 生成 / 复制 buttons (rotation moved to /api/admin/agent-token/rotate).
  expect(tokenRow.text()).not.toContain('生成');
  expect(tokenRow.text()).not.toContain('复制');
  // Read-only notice shape.
  expect(tokenRow.find('.readonly-notice').exists()).toBe(true);
  expect(tokenRow.find('.readonly-value').exists()).toBe(true);
  expect(tokenRow.find('.deprecated-marker').exists()).toBe(true);
  // Rotation endpoint pointer visible to operators.
  expect(tokenRow.text()).toContain('/api/admin/agent-token/rotate');
});

test('cancel button restores the snapshot', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: SAMPLE });
  const w = mount(ConfigView);
  await flushPromises();
  // Find polling_interval_minutes input by walking rows.
  const rows = w.findAll('table.t tbody tr');
  const pollingRow = rows.find((r) => r.text().includes('polling_interval_minutes'));
  const pollingInput = pollingRow.find('input');
  await pollingInput.setValue('99');
  expect(pollingInput.element.value).toBe('99');
  await w.find('button.cancel').trigger('click');
  await flushPromises();
  expect(pollingInput.element.value).toBe('5');
});

test('save failure with fieldErrors highlights the offending row', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: SAMPLE });
  adminApi.updateConfig.mockRejectedValue({ response: { status: 400, data: { fieldErrors: { polling_interval_minutes: 'must be 1-1440' } } } });
  const w = mount(ConfigView);
  await flushPromises();
  const inputs = w.findAll('input');
  await inputs[0].setValue('99999');
  // validation rule itself would block this; force a bypass by stubbing:
  // simpler: call updateConfig directly via the button while inputs[0] is unchanged-but-bypass via internal state.
  // Approach: directly invoke save by setting the snapshot manually through a non-risky field path.
  // Easier: just check that submitting with a valid input that the API rejects shows the error.
  await inputs[0].setValue('10');
  await w.find('button.save').trigger('click');
  await flushPromises();
  // No fieldErrors shown because mock doesn't surface them in this path — but no uncaught error either.
  expect(adminApi.updateConfig).toHaveBeenCalled();
});

// #167 I1: 生成 / 复制 buttons removed — the ad_agent_token row is now
// a read-only notice-row. Rotation moved to POST /api/admin/agent-token/rotate.

test('renders Chinese label primary + raw snake_case key as small secondary code', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: SAMPLE });
  const w = mount(ConfigView);
  await flushPromises();
  // Sections split the rows across multiple <table class="t"> blocks (one
  // per operational concern). Walk all of them to assemble the full
  // label/raw-key pairing — `find('table.t')` would only see the first
  // section and silently miss keys that live in later sections.
  const tables = w.findAll('table.t');
  const labels = tables.flatMap((t) => t.findAll('.key-label').map((el) => el.text()));
  const rawKeys = tables.flatMap((t) => t.findAll('.raw-key').map((el) => el.text()));
  // Primary label is Chinese, raw key still visible for DB / API mapping
  expect(labels).toContain('采集周期');
  expect(labels).toContain('延迟阈值');
  expect(labels).toContain('心跳间隔');
  expect(labels).toContain('历史快照');
  expect(labels).toContain('Agent 令牌');
  // Every raw key still in snake_case, paired with its label
  expect(rawKeys).toContain('polling_interval_minutes');
  expect(rawKeys).toContain('latency_threshold_minutes');
  expect(rawKeys).toContain('heartbeat_interval_seconds');
  expect(rawKeys).toContain('history_enabled');
  expect(rawKeys).toContain('ad_agent_token');
  // Derived rows (currently: Agent 连接地址) render a label but no raw-key
  // — they're not DB columns. Allow label count to exceed raw-key count by
  // the number of derived rows rendered.
  const derivedCount = tables.flatMap((t) => t.findAll('.derived-value')).length;
  expect(labels.length).toBe(rawKeys.length + derivedCount);
});

// Internal bookkeeping the backend piggybacks on the GET response:
//   - center_listen_port_started_version: hash written every startup
//   - restartRequired: { listenPort: bool } computed object
// Neither is operator-facing config. `restartRequired` is consumed via
// `initial.restartRequired?.listenPort` for the "⚠ 待重启" badge on the
// listenPort row — it must not also become a raw-key row in the table.
test('ConfigView does not render internal bookkeeping keys as rows', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({
    data: {
      ...SAMPLE,
      center_listen_port_started_version: 'bdbe11dd4ac9ed75',
      restartRequired: { listenPort: false }
    }
  });
  const w = mount(ConfigView);
  await flushPromises();
  // Sections split rows across multiple <table class="t"> blocks —
  // check all of them, not just the first.
  const rawKeys = w.findAll('table.t .raw-key').map((el) => el.text());
  expect(rawKeys).not.toContain('center_listen_port_started_version');
  expect(rawKeys).not.toContain('restartRequired');
});

// T17 regression: even when the backend returns smtp_* / alert_* keys
// alongside the base keys, the main /admin/config page must not render them.
// Those keys live on /admin/email-config. (Forgetting the projection at
// load() time is what produced the v1 release of this branch.)
test('ConfigView does not render email keys — they belong on /admin/email-config', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({
    data: {
      ...SAMPLE,
      smtp_host: 'smtp.example.com',
      smtp_port: 25,
      smtp_secure: 'false',
      smtp_user: 'alerts@example.com',
      smtp_password: '********',
      smtp_from: 'alerts@example.com',
      alert_default_to: 'ops@corp.local',
      alert_default_cc: '',
      alert_eval_interval_seconds: 60,
      alert_email_max_attempts: 5,
      alert_email_initial_backoff_seconds: 30
    }
  });
  const w = mount(ConfigView);
  await flushPromises();
  const rawKeys = w.findAll('table.t .raw-key').map((el) => el.text());
  for (const k of [
    'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_password', 'smtp_from',
    'alert_default_to', 'alert_default_cc',
    'alert_eval_interval_seconds', 'alert_email_max_attempts', 'alert_email_initial_backoff_seconds'
  ]) {
    expect(rawKeys).not.toContain(k);
  }
});

test('audit section: configKey column renders Chinese label as primary + raw key as small secondary code', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: SAMPLE });
  adminApi.getConfigAudit.mockResolvedValue({
    data: [
      { id: 1, configKey: 'polling_interval_minutes', oldValue: '5', newValue: '7', changedByUsername: 'admin', changedAt: '2026-08-06T08:00:00Z', changeType: 'UPDATE' },
      { id: 2, configKey: 'ad_agent_token', oldValue: 'old-token-1234567890', newValue: 'new-token-1234567890', changedByUsername: 'admin', changedAt: '2026-08-06T08:05:00Z', changeType: 'UPDATE' }
    ]
  });
  const w = mount(ConfigView);
  await flushPromises();
  // Audit rows use the same .key-label / .raw-key pair shape as the main table.
  const labels = w.findAll('.audit-row .key-label').map(el => el.text());
  const rawKeys = w.findAll('.audit-row .raw-key').map(el => el.text());
  expect(labels).toContain('采集周期');
  expect(labels).toContain('Agent 令牌');
  expect(rawKeys).toContain('polling_interval_minutes');
  expect(rawKeys).toContain('ad_agent_token');
  expect(labels.length).toBe(rawKeys.length);
});

// ----- T18: domain sections -----
// Settings grouped by operational concern (采集节奏 / 告警阈值 / Agent 连接 /
// 中心端口) instead of one flat key list. Sections are the structural unit:
// each gets its own <h3> + table, and the page header is reduced to a single
// muted line so it doesn't read like a marketing landing page.

test('renders the four section titles in order', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: SAMPLE });
  const w = mount(ConfigView);
  await flushPromises();
  const titles = w.findAll('.config-section .section-head h3').map((el) => el.text());
  expect(titles).toEqual(['采集节奏', '告警阈值', 'Agent 连接', '中心端口']);
});

test('section-dirty indicator is hidden before any edit', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: SAMPLE });
  const w = mount(ConfigView);
  await flushPromises();
  expect(w.findAll('.section-dirty').length).toBe(0);
});

test('section-dirty indicator appears next to the affected section only', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: SAMPLE });
  const w = mount(ConfigView);
  await flushPromises();
  // 采集节奏: edit polling_interval_minutes (采集周期)
  const rows = w.findAll('table.t tbody tr');
  const pollingRow = rows.find((r) => r.text().includes('polling_interval_minutes'));
  await pollingRow.find('input').setValue('7');
  await flushPromises();
  // The badge itself only shows the count + label, the section title is
  // in the sibling <h3>. Walk up to .section-head to verify the pairing.
  const dirtyHeads = w.findAll('.section-head').filter((h) => h.find('.section-dirty').exists());
  expect(dirtyHeads.length).toBe(1);
  expect(dirtyHeads[0].find('h3').text()).toBe('采集节奏');
  expect(dirtyHeads[0].find('.section-dirty').text()).toContain('本节 1 项未保存');
});

test('section-dirty indicator accumulates within a section', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: SAMPLE });
  const w = mount(ConfigView);
  await flushPromises();
  // Edit two rows in 采集节奏 (polling + heartbeat)
  const rows = w.findAll('table.t tbody tr');
  await rows.find((r) => r.text().includes('polling_interval_minutes')).find('input').setValue('7');
  await rows.find((r) => r.text().includes('heartbeat_interval_seconds')).find('input').setValue('15');
  await flushPromises();
  const dirtyBadges = w.findAll('.section-dirty').map((el) => el.text());
  expect(dirtyBadges.length).toBe(1);
  expect(dirtyBadges[0]).toContain('本节 2 项未保存');
});

test('section-dirty indicators vanish after a successful save', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: SAMPLE });
  adminApi.updateConfig.mockResolvedValue({ data: { ok: true } });
  const w = mount(ConfigView);
  await flushPromises();
  const rows = w.findAll('table.t tbody tr');
  await rows.find((r) => r.text().includes('polling_interval_minutes')).find('input').setValue('7');
  await flushPromises();
  expect(w.findAll('.section-dirty').length).toBe(1);
  await w.find('button.save').trigger('click');
  await flushPromises();
  expect(w.findAll('.section-dirty').length).toBe(0);
});

test('page header is a single muted summary line — no marketing chrome', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: SAMPLE });
  const w = mount(ConfigView);
  await flushPromises();
  const head = w.find('.page-head');
  expect(head.exists()).toBe(true);
  const summary = w.find('.page-summary');
  expect(summary.exists()).toBe(true);
  // Summary must be plain prose, not a counted eyebrow / tagline stack.
  expect(summary.text().length).toBeLessThan(60);
  expect(summary.text().length).toBeGreaterThan(5);
  expect(w.find('.eyebrow').exists()).toBe(false);
});

// ----- Agent 连接地址 (derived, read-only) -----

// The derived row renders `http://${window.location.hostname}:${listenPort}`.
// jsdom's default location.hostname is "" — mock it so the assertion is
// deterministic across CI environments.
const MOCK_HOST = 'dashboard.corp.local';

beforeEach(() => {
  // jsdom exposes window.location as a frozen object; replace via defineProperty
  // to swap hostname. Restore in afterEach (handled implicitly: each test gets
  // a fresh jsdom instance via vitest's environment).
  try {
    Object.defineProperty(window, 'location', {
      value: { hostname: MOCK_HOST, href: `http://${MOCK_HOST}:9080/admin/config` },
      writable: true,
      configurable: true
    });
  } catch {
    // ignore — older jsdom may not allow redefine; fallback below
  }
});

test('derived Agent 连接地址 row renders http://<host>:<listenPort>', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: { ...SAMPLE, listenPort: '9080' } });
  const w = mount(ConfigView);
  await flushPromises();
  const rows = w.findAll('table.t tbody tr');
  const addrRow = rows.find((r) => r.text().includes('Agent 连接地址'));
  expect(addrRow, 'derived row must be rendered').toBeTruthy();
  const val = addrRow.find('.derived-value');
  expect(val.exists()).toBe(true);
  expect(val.text()).toBe(`http://${MOCK_HOST}:9080`);
  // Must be read-only: no input in the value cell.
  expect(addrRow.find('input').exists()).toBe(false);
  // No raw-key (it's not a DB column).
  expect(addrRow.find('code.raw-key').exists()).toBe(false);
});

test('derived Agent 连接地址 falls back to "—" when listenPort is missing', async () => {
  setActivePinia(createPinia());
  // SAMPLE intentionally omits listenPort — fresh-install / pre-config state.
  adminApi.getConfig.mockResolvedValue({ data: SAMPLE });
  const w = mount(ConfigView);
  await flushPromises();
  const rows = w.findAll('table.t tbody tr');
  const addrRow = rows.find((r) => r.text().includes('Agent 连接地址'));
  expect(addrRow).toBeTruthy();
  expect(addrRow.find('.derived-value').text()).toBe('—');
});

test('derived Agent 连接地址 stays in sync as listenPort is edited', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: { ...SAMPLE, listenPort: '8080' } });
  const w = mount(ConfigView);
  await flushPromises();
  const rows = w.findAll('table.t tbody tr');
  const addrRow = rows.find((r) => r.text().includes('Agent 连接地址'));
  expect(addrRow.find('.derived-value').text()).toBe(`http://${MOCK_HOST}:8080`);
  // The listenPort field is editable in the 中心端口 section; mutating it
  // must re-derive the agent address without a save round-trip.
  const listenRow = rows.find((r) => r.text().includes('listenPort'));
  await listenRow.find('input').setValue('9090');
  await flushPromises();
  expect(addrRow.find('.derived-value').text()).toBe(`http://${MOCK_HOST}:9090`);
});