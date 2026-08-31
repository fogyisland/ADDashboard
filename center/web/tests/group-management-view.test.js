// 2026-08-31 R75 — frontend tests for GroupManagementView.vue.
//
// Mirror of user-management-view.test.js but for the group CRUD surface.
// Covers DC picker, search, results table, modal opens, drawer poll.

import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('../src/api/ad-admin.js', () => ({
  adAdminApi: {
    listDcs: vi.fn(),
    queueCommand: vi.fn(),
    listCommands: vi.fn(),
    getCommand: vi.fn()
  }
}));

import GroupManagementView from '../src/views/admin/GroupManagementView.vue';
import { adAdminApi } from '../src/api/ad-admin.js';

const RouterLinkStub = {
  props: ['to'],
  template: '<a :href="to"><slot /></a>'
};

function makeCommandResponse({ id, status, result = null, errorMessage = null }) {
  return { data: { id, status, result, errorMessage, targetDc: 'DC1', commandType: 'group_search', createdAt: '2026-08-31T00:00:00Z' } };
}

const FAKE_DCS = ['DC-BJ-01', 'DC-SH-01', 'DC-GZ-01'];

const FAKE_GROUPS = [
  { name: 'Domain Admins', sam: 'Domain Admins', category: 'Security',     scope: 'Global',    description: 'Tier-0', memberCount: 4 },
  { name: 'Sales Team',    sam: 'Sales Team',    category: 'Security',     scope: 'Universal', description: 'Sales',  memberCount: 18 },
  { name: 'All Staff DL',  sam: 'All Staff DL',  category: 'Distribution', scope: 'Universal', description: 'Distro', memberCount: 240 }
];

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.setItem('ad_token', 'test-token');
  localStorage.setItem('ad_user', JSON.stringify({ id: 42, username: 'admin', role: 'admin' }));
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
  adAdminApi.listCommands.mockResolvedValue({ data: { total: 0, rows: [], page: 1, size: 20 } });
  adAdminApi.queueCommand.mockResolvedValue(makeCommandResponse({ id: 200, status: 'queued' }));
  adAdminApi.getCommand.mockResolvedValue(
    makeCommandResponse({ id: 200, status: 'success', result: { groups: FAKE_GROUPS, truncated: false, count: FAKE_GROUPS.length } })
  );
});

function mountView() {
  return mount(GroupManagementView, {
    global: {
      stubs: {
        AdminLayout: { template: '<div class="admin-layout-stub"><slot /></div>' },
        'router-link': RouterLinkStub
      }
    }
  });
}

// Drive the inline search poll loop (1.5s setInterval in the view) —
// 100ms ticks until the table populates or the 35s ceiling.
async function driveSearch(w, maxMs = 35_000) {
  const step = 100;
  let elapsed = 0;
  while (elapsed < maxMs) {
    await new Promise(r => setTimeout(r, step));
    await flushPromises();
    elapsed += step;
    if (w.findAll('[data-test^="group-row-"]').length > 0) return;
  }
}

// ── DC picker ────────────────────────────────────────────────

test('DC picker renders 3 DCs from /api/dashboard/topology', async () => {
  const w = mountView();
  await flushPromises();
  const options = w.findAll('[data-test="dc-picker"] option').map(o => o.text());
  expect(options).toEqual(FAKE_DCS);
});

// ── Search ───────────────────────────────────────────────────

test('clicking 查询 POSTs group_search with current filter + selectedDc', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="group-search-filter"]').setValue('Sales');
  await w.find('[data-test="group-search-button"]').trigger('click');
  await flushPromises();
  expect(adAdminApi.queueCommand).toHaveBeenCalledWith({
    targetDc: FAKE_DCS[0],
    commandType: 'group_search',
    params: { filter: 'Sales', limit: 50 }
  });
});

test('results render one row per group from the polled response', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="group-search-button"]').trigger('click');
  await driveSearch(w);
  const rows = w.findAll('[data-test^="group-row-"]');
  expect(rows.length).toBe(FAKE_GROUPS.length);
  expect(w.find('[data-test="group-row-Domain Admins"]').exists()).toBe(true);
  expect(w.find('[data-test="group-row-Sales Team"]').exists()).toBe(true);
  expect(w.find('[data-test="group-row-All Staff DL"]').exists()).toBe(true);
});

// ── Per-row actions ─────────────────────────────────────────

test('per-row action buttons render (设置属性 / 成员管理 / 删除)', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="group-search-button"]').trigger('click');
  await driveSearch(w);
  expect(w.find('[data-test="group-action-properties-Domain Admins"]').exists()).toBe(true);
  expect(w.find('[data-test="group-action-members-Domain Admins"]').exists()).toBe(true);
  expect(w.find('[data-test="group-action-delete-Domain Admins"]').exists()).toBe(true);
});

// ── Modals ──────────────────────────────────────────────────

test('clicking +新建 opens GroupCreateModal', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="group-create-button"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="group-create-modal"]').exists()).toBe(true);
});

test('clicking 设置属性 opens GroupPropertiesModal', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="group-search-button"]').trigger('click');
  await driveSearch(w);
  await w.find('[data-test="group-action-properties-Sales Team"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="group-properties-modal"]').exists()).toBe(true);
});

test('clicking 成员管理 opens GroupMembersModal', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="group-search-button"]').trigger('click');
  await driveSearch(w);
  // Override AFTER search so group_list_members poll returns the members
  // payload (previous mock was returning group_search shape).
  adAdminApi.getCommand.mockResolvedValue(
    makeCommandResponse({
      id: 300, status: 'success',
      result: { name: 'Sales Team', members: [{ sam: 'jdoe', dn: 'CN=jdoe,DC=contoso' }], total: 1, page: 1, size: 100 }
    })
  );
  await w.find('[data-test="group-action-members-Sales Team"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="group-members-modal"]').exists()).toBe(true);
  w.unmount();
}, 8000);

test('clicking 删除 opens GroupDeleteConfirmModal', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="group-search-button"]').trigger('click');
  await driveSearch(w);
  await w.find('[data-test="group-action-delete-Sales Team"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="group-delete-confirm-modal"]').exists()).toBe(true);
});

// ── Drawer ──────────────────────────────────────────────────

test('drawer renders commands via listCommands on mount', async () => {
  adAdminApi.listCommands.mockResolvedValue({
    data: { total: 1, rows: [
      { id: 5, commandType: 'group_create', targetDc: 'DC1', status: 'success', createdAt: '2026-08-31T11:00:00Z', claimedAt: null, completedAt: '2026-08-31T11:00:01Z', durationMs: 800, errorMessage: null, operatorId: 1, operatorUsername: 'admin' }
    ], page: 1, size: 20 }
  });
  const w = mountView();
  await flushPromises();
  expect(w.find('[data-test="cmd-row-5"]').exists()).toBe(true);
});

// ── Visual / structural ─────────────────────────────────────

test('view header shows subtitle with DC banner', async () => {
  const w = mountView();
  await flushPromises();
  expect(w.text()).toContain('AD 组管理');
  expect(w.find('[data-test="dc-banner"]').text()).toBe(FAKE_DCS[0]);
});

test('view renders inside AdminLayout (admin-layout-stub)', async () => {
  const w = mountView();
  await flushPromises();
  expect(w.find('.admin-layout-stub').exists()).toBe(true);
});