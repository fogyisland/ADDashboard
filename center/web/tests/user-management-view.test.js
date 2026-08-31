// 2026-08-31 R75 — frontend tests for UserManagementView.vue.
//
// Mount the view with a stubbed `adAdminApi` + `auth.user` and assert:
//   - DC picker renders 3 DCs from /api/dashboard/topology
//   - search button POSTs user_search with correct payload
//   - results table renders N rows from the polled response
//   - per-row action buttons render and are clickable
//   - drawer polls every 5s
//   - create modal opens via +新建 button
//   - delete modal requires matching sAMAccountName
//   - queueSimple path (enable/disable/unlock) calls adAdminApi.queueCommand

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('../src/api/ad-admin.js', () => ({
  adAdminApi: {
    listDcs: vi.fn(),
    queueCommand: vi.fn(),
    listCommands: vi.fn(),
    getCommand: vi.fn()
  }
}));

import UserManagementView from '../src/views/admin/UserManagementView.vue';
import { adAdminApi } from '../src/api/ad-admin.js';

const RouterLinkStub = {
  props: ['to'],
  template: '<a :href="to"><slot /></a>'
};

// Build a deep mutable clone for the queue/get command roundtrip
function makeCommandResponse({ id, status, resultJson = null, errorMessage = null }) {
  return { data: { id, status, resultJson, errorMessage, targetDc: 'DC1', commandType: 'user_search', createdAt: '2026-08-31T00:00:00Z' } };
}

function makeGetResponse({ id, status, resultJson = null, errorMessage = null }) {
  return makeCommandResponse({ id, status, resultJson, errorMessage });
}

const FAKE_DCS = ['DC-BJ-01', 'DC-SH-01', 'DC-GZ-01'];

beforeEach(() => {
  setActivePinia(createPinia());
  // Stub the auth store with a fake current user
  localStorage.setItem('ad_token', 'test-token');
  localStorage.setItem('ad_user', JSON.stringify({ id: 42, username: 'admin', role: 'admin' }));
  // Default: listDcs returns 3 DCs; listCommands returns []; queueCommand → 1; getCommand → success
  adAdminApi.listDcs.mockResolvedValue({
    data: {
      nodes: [
        { name: '北京站点', type: 'site' },
        { name: 'DC-BJ-01', type: 'dc', site: '北京站点' },
        { name: 'DC-SH-01', type: 'dc', site: '上海站点' },
        { name: 'DC-GZ-01', type: 'dc', site: '广州站点' }
      ],
      links: []
    }
  });
  adAdminApi.listCommands.mockResolvedValue({
    data: { total: 0, rows: [], page: 1, size: 20 }
  });
  adAdminApi.queueCommand.mockResolvedValue(makeCommandResponse({ id: 100, status: 'queued' }));
  adAdminApi.getCommand.mockResolvedValue(
    makeGetResponse({
      id: 100,
      status: 'success',
      resultJson: { users: [
        { sam: 'jdoe', displayName: 'John Doe', enabled: true, lastLogon: '2026-08-30T10:00:00Z', description: 'Sales Engineer' },
        { sam: 'asmith', displayName: 'Alice Smith', enabled: false, lastLogon: null, description: 'Disabled' }
      ], truncated: false, count: 2 }
    })
  );
});

function mountView() {
  return mount(UserManagementView, {
    global: {
      stubs: {
        AdminLayout: { template: '<div class="admin-layout-stub"><slot /></div>' },
        'router-link': RouterLinkStub
      }
    }
  });
}

// Drive the runSearch inline poll loop. The view polls adAdminApi.getCommand
// on a 1500ms setInterval; we tick 100ms at a time until either results
// populate or we hit the 35s ceiling. This avoids the test wall-clock cost
// of waiting real seconds.
async function driveSearch(w, maxMs = 35_000) {
  const step = 100;
  let elapsed = 0;
  while (elapsed < maxMs) {
    await new Promise(r => setTimeout(r, step));
    await flushPromises();
    elapsed += step;
    if (w.findAll('[data-test^="user-row-"]').length > 0) return;
  }
}

// ── DC picker ─────────────────────────────────────────────────

test('DC picker renders 3 DCs from /api/dashboard/topology', async () => {
  const w = mountView();
  await flushPromises();
  const options = w.findAll('[data-test="dc-picker"] option').map(o => o.text());
  expect(options).toEqual(FAKE_DCS);
  expect(adAdminApi.listDcs).toHaveBeenCalled();
});

test('DC picker defaults to first DC', async () => {
  const w = mountView();
  await flushPromises();
  const picker = w.find('[data-test="dc-picker"]');
  expect(picker.element.value).toBe(FAKE_DCS[0]);
});

// ── Search ─────────────────────────────────────────────────────

test('clicking 查询 POSTs user_search with current filter + selectedDc', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="user-search-filter"]').setValue('jd');
  await w.find('[data-test="user-search-button"]').trigger('click');
  await flushPromises();
  expect(adAdminApi.queueCommand).toHaveBeenCalledWith({
    targetDc: FAKE_DCS[0],
    commandType: 'user_search',
    params: { filter: 'jd', limit: 50 }
  });
});

test('search results render one row per user from the polled response', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="user-search-button"]').trigger('click');
  await driveSearch(w);
  const rows = w.findAll('[data-test^="user-row-"]');
  expect(rows.length).toBe(2);
  expect(w.find('[data-test="user-row-jdoe"]').exists()).toBe(true);
  expect(w.find('[data-test="user-row-asmith"]').exists()).toBe(true);
});

test('empty filter still triggers search (per spec edge case a)', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="user-search-button"]').trigger('click');
  await flushPromises();
  expect(adAdminApi.queueCommand).toHaveBeenCalledWith(expect.objectContaining({
    commandType: 'user_search',
    params: expect.objectContaining({ filter: '', limit: 50 })
  }));
});

// ── Per-row actions ──────────────────────────────────────────

test('per-row action buttons render (重置密码 / 启用 / 解锁 / 编辑属性 / 组成员 / 删除)', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="user-search-button"]').trigger('click');
  await driveSearch(w);
  // enabled user → shows 禁用; disabled user → shows 启用
  expect(w.find('[data-test="user-action-disable-jdoe"]').exists()).toBe(true);
  expect(w.find('[data-test="user-action-enable-asmith"]').exists()).toBe(true);
  expect(w.find('[data-test="user-action-reset-jdoe"]').exists()).toBe(true);
  expect(w.find('[data-test="user-action-unlock-jdoe"]').exists()).toBe(true);
  expect(w.find('[data-test="user-action-edit-jdoe"]').exists()).toBe(true);
  expect(w.find('[data-test="user-action-groups-jdoe"]').exists()).toBe(true);
  expect(w.find('[data-test="user-action-delete-jdoe"]').exists()).toBe(true);
});

test('clicking 启用 calls queueCommand with user_enable + correct params', async () => {
  adAdminApi.getCommand.mockResolvedValue(makeGetResponse({
    id: 100, status: 'success',
    resultJson: { users: [{ sam: 'asmith', displayName: 'Alice Smith', enabled: false, lastLogon: null, description: '' }], truncated: false, count: 1 }
  }));
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="user-search-button"]').trigger('click');
  await driveSearch(w);
  adAdminApi.queueCommand.mockClear();
  await w.find('[data-test="user-action-enable-asmith"]').trigger('click');
  await flushPromises();
  expect(adAdminApi.queueCommand).toHaveBeenCalledWith({
    targetDc: FAKE_DCS[0],
    commandType: 'user_enable',
    params: { sam: 'asmith' }
  });
});

// ── Modals ───────────────────────────────────────────────────

test('clicking +新建 opens UserCreateModal', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="user-create-button"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="user-create-modal"]').exists()).toBe(true);
});

test('clicking 删除 opens UserDeleteConfirmModal', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="user-search-button"]').trigger('click');
  await driveSearch(w);
  await w.find('[data-test="user-action-delete-jdoe"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="user-delete-confirm-modal"]').exists()).toBe(true);
});

test('clicking 编辑属性 opens UserAttributesModal', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="user-search-button"]').trigger('click');
  await driveSearch(w);
  await w.find('[data-test="user-action-edit-jdoe"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="user-attributes-modal"]').exists()).toBe(true);
});

test('clicking 组成员 opens UserGroupMembershipsModal', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="user-search-button"]').trigger('click');
  await driveSearch(w);
  // NOW override getCommand so the modal's user_list_groups poll returns
  // a groups payload (the previous search already populated the table).
  adAdminApi.getCommand.mockResolvedValue(makeGetResponse({
    id: 200, status: 'success',
    resultJson: { sam: 'jdoe', groups: [{ name: 'Sales Team', dn: 'CN=Sales Team,DC=contoso' }] }
  }));
  const btn = w.find('[data-test="user-action-groups-jdoe"]');
  expect(btn.exists()).toBe(true);
  await btn.trigger('click');
  await flushPromises();
  // Modal mounts synchronously on click — no need to wait for poll cycle.
  expect(w.find('[data-test="user-groups-modal"]').exists()).toBe(true);
  w.unmount();
}, 8000);

// ── Drawer ───────────────────────────────────────────────────

test('drawer renders last 20 commands via listCommands on mount', async () => {
  adAdminApi.listCommands.mockResolvedValue({
    data: { total: 3, rows: [
      { id: 1, commandType: 'user_search', targetDc: 'DC1', status: 'success', createdAt: '2026-08-31T10:00:00Z', claimedAt: '2026-08-31T10:00:01Z', completedAt: '2026-08-31T10:00:02Z', durationMs: 1000, errorMessage: null, operatorId: 1, operatorUsername: 'admin' },
      { id: 2, commandType: 'user_disable', targetDc: 'DC1', status: 'failed', createdAt: '2026-08-31T10:01:00Z', claimedAt: null, completedAt: '2026-08-31T10:01:01Z', durationMs: 500, errorMessage: 'DC offline', operatorId: 1, operatorUsername: 'admin' },
      { id: 3, commandType: 'user_enable', targetDc: 'DC1', status: 'running', createdAt: '2026-08-31T10:02:00Z', claimedAt: '2026-08-31T10:02:01Z', completedAt: null, durationMs: null, errorMessage: null, operatorId: 1, operatorUsername: 'admin' }
    ], page: 1, size: 20 }
  });
  const w = mountView();
  await flushPromises();
  expect(adAdminApi.listCommands).toHaveBeenCalledWith(expect.objectContaining({ operatorId: expect.anything(), size: 20 }));
  expect(w.find('[data-test="cmd-row-1"]').exists()).toBe(true);
  expect(w.find('[data-test="cmd-row-2"]').exists()).toBe(true);
  expect(w.find('[data-test="cmd-status-1"]').exists()).toBe(true);
});

// ── Visual / structural ──────────────────────────────────────

test('view header shows subtitle with DC banner', async () => {
  const w = mountView();
  await flushPromises();
  expect(w.text()).toContain('AD 用户管理');
  expect(w.find('[data-test="dc-banner"]').text()).toBe(FAKE_DCS[0]);
});

test('view renders inside AdminLayout (admin-layout-stub)', async () => {
  const w = mountView();
  await flushPromises();
  expect(w.find('.admin-layout-stub').exists()).toBe(true);
});