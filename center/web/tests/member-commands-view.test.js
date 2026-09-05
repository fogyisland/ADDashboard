// 2026-09-05 R81 — frontend tests for MemberCommandsView.vue.
//
// Mount the view with a stubbed `memberCommandsApi` + `auth.user` and assert:
//   - host picker renders from /api/admin/member-commands/hosts
//   - online/offline pill derives from lastHeartbeatAt < 5min
//   - clicking 执行命令 opens ExecuteCommandModal
//   - inline recent-20 table renders rows for the picked host
//   - drawer polls listCommands for the picked host
//   - submit success emits → view refreshes recent table
//   - empty host list renders empty state

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('../src/api/member-commands.js', () => ({
  memberCommandsApi: {
    listHosts: vi.fn(),
    listCommands: vi.fn(),
    queueCommand: vi.fn(),
    getCommand: vi.fn()
  }
}));

import MemberCommandsView from '../src/views/admin/MemberCommandsView.vue';
import { memberCommandsApi } from '../src/api/member-commands.js';

const RouterLinkStub = {
  props: ['to'],
  template: '<a :href="to"><slot /></a>'
};

const ONLINE_TS = new Date(Date.now() - 60 * 1000).toISOString();   // 1 min ago
const OFFLINE_TS = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago

const FAKE_HOSTS = [
  { hostname: 'web-01', lastHeartbeatAt: ONLINE_TS },
  { hostname: 'web-02', lastHeartbeatAt: OFFLINE_TS }
];

const FAKE_ROWS = [
  { id: 1, hostname: 'web-01', commandType: 'member_script', status: 'success', createdAt: '2026-09-05T10:00:00Z', claimedAt: null, completedAt: null, durationMs: 250, errorMessage: null, paramsJson: { script: 'Get-Date' }, resultJson: { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 250 } },
  { id: 2, hostname: 'web-01', commandType: 'member_script', status: 'failed', createdAt: '2026-09-05T10:01:00Z', claimedAt: null, completedAt: null, durationMs: 100, errorMessage: 'script not allowed', paramsJson: { script: 'Remove-Item -Recurse C:\\*' }, resultJson: null }
];

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.setItem('ad_token', 'test-token');
  localStorage.setItem('ad_user', JSON.stringify({ id: 42, username: 'admin', role: 'admin' }));
  memberCommandsApi.listHosts.mockResolvedValue({ data: { hosts: FAKE_HOSTS } });
  memberCommandsApi.listCommands.mockResolvedValue({ data: { total: 0, rows: [], page: 1, size: 20 } });
  memberCommandsApi.queueCommand.mockResolvedValue({ data: { id: 100, status: 'queued', hostname: 'web-01', commandType: 'member_script' } });
  memberCommandsApi.getCommand.mockResolvedValue({ data: { id: 100, status: 'success', hostname: 'web-01', commandType: 'member_script', exitCode: 0, result: { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 250 } } });
});

afterEach(() => {
  vi.useRealTimers();
});

function mountView() {
  return mount(MemberCommandsView, {
    global: {
      stubs: {
        AdminLayout: { template: '<div class="admin-layout-stub"><slot /></div>' },
        'router-link': RouterLinkStub
      }
    }
  });
}

// ── Host picker ─────────────────────────────────────────────────────────

test('host picker renders hosts from listHosts', async () => {
  const w = mountView();
  await flushPromises();
  const options = w.findAll('[data-test="host-picker"] option').map(o => o.text().trim());
  expect(options.some(t => t.includes('web-01'))).toBe(true);
  expect(options.some(t => t.includes('web-02'))).toBe(true);
});

test('empty host list shows the "请先选择" hint when no host picked', async () => {
  memberCommandsApi.listHosts.mockResolvedValue({ data: { hosts: [] } });
  const w = mountView();
  await flushPromises();
  expect(w.text()).toContain('请先选择目标成员服务器');
});

test('selecting a host renders online/offline status pill', async () => {
  const w = mountView();
  await flushPromises();
  // pick the offline host (web-02, lastHeartbeatAt = 10 min ago)
  const picker = w.find('[data-test="host-picker"]');
  await picker.setValue('web-02');
  await flushPromises();
  const pill = w.find('[data-test="host-online-status"]');
  expect(pill.exists()).toBe(true);
  expect(pill.text()).toContain('心跳超时');
  expect(pill.classes()).toContain('warn');

  // now switch to the online host (web-01, lastHeartbeatAt = 1 min ago)
  await picker.setValue('web-01');
  await flushPromises();
  const pill2 = w.find('[data-test="host-online-status"]');
  expect(pill2.text()).toContain('心跳在线');
  expect(pill2.classes()).toContain('ok');
});

// ── Recent table ────────────────────────────────────────────────────────

test('selecting a host renders recent-20 inline table from listCommands', async () => {
  memberCommandsApi.listCommands.mockResolvedValue({ data: { total: FAKE_ROWS.length, rows: FAKE_ROWS, page: 1, size: 20 } });
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="host-picker"]').setValue('web-01');
  await flushPromises();
  // The view's loadRecent call uses size:20, the drawer's polling uses
  // size:50 — both include hostname:'web-01'. Verify the size:20 call
  // was made specifically.
  const calls = memberCommandsApi.listCommands.mock.calls;
  expect(calls.some(c => c[0].hostname === 'web-01' && c[0].size === 20)).toBe(true);
  expect(w.find('[data-test="mc-recent-section"]').exists()).toBe(true);
  expect(w.find('[data-test="mc-recent-row-1"]').exists()).toBe(true);
  expect(w.find('[data-test="mc-recent-row-2"]').exists()).toBe(true);
});

test('empty recent list renders empty state', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="host-picker"]').setValue('web-01');
  await flushPromises();
  expect(w.text()).toContain('该主机暂无历史命令');
});

// ── Modal open ──────────────────────────────────────────────────────────

test('clicking 执行命令 opens ExecuteCommandModal', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="host-picker"]').setValue('web-01');
  await flushPromises();
  await w.find('[data-test="exec-button"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="exec-modal"]').exists()).toBe(true);
});

test('执行命令 disabled when no host picked', async () => {
  const w = mountView();
  await flushPromises();
  const btn = w.find('[data-test="exec-button"]');
  expect(btn.attributes('disabled')).toBeDefined();
});

// ── Drawer ──────────────────────────────────────────────────────────────

test('drawer renders last commands scoped to selected host', async () => {
  memberCommandsApi.listCommands.mockResolvedValue({ data: { total: FAKE_ROWS.length, rows: FAKE_ROWS, page: 1, size: 50 } });
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="host-picker"]').setValue('web-01');
  await flushPromises();
  expect(w.find('[data-test="mc-row-1"]').exists()).toBe(true);
  expect(w.find('[data-test="mc-row-2"]').exists()).toBe(true);
});

// ── Visual / structural ─────────────────────────────────────────────────

test('view header shows subtitle with host banner', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="host-picker"]').setValue('web-01');
  await flushPromises();
  expect(w.text()).toContain('成员服务器命令执行');
  expect(w.find('[data-test="host-banner"]').text()).toBe('web-01');
});

test('view renders inside AdminLayout (admin-layout-stub)', async () => {
  const w = mountView();
  await flushPromises();
  expect(w.find('.admin-layout-stub').exists()).toBe(true);
});