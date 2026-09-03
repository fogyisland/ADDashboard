// 2026-09-03 R77 — frontend tests for the bulk-action UI on
// GroupManagementView.vue (checkbox column + sticky bulk bar +
// BatchAddMembersModal mount, both add + remove modes).
//
// Covers:
//   - Bulk-action bar appears when N >= 1 rows selected
//   - Master checkbox selects all visible rows
//   - Clicking 添加成员 opens BatchAddMembersModal (mode='add')
//   - Submitting the add modal calls queueBatch with group_add_member
//     + N entries (one per selected group), all sharing the same sams
//   - Clicking 移除成员 opens BatchAddMembersModal (mode='remove')
//   - Submitting the remove modal calls queueBatch with
//     group_remove_member + N entries
//   - 取消选择 clears the selection
//   - Bulk buttons disabled when DC picker is empty
//   - BatchAddMembersModal parsing: handles newlines, commas,
//     whitespace, dedupes, trims

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('../../../src/api/ad-admin.js', () => ({
  adAdminApi: {
    listDcs: vi.fn(),
    queueCommand: vi.fn(),
    queueBatch: vi.fn(),
    listCommands: vi.fn(),
    getCommand: vi.fn()
  }
}));

import GroupManagementView from '../../../src/views/admin/GroupManagementView.vue';
import BatchAddMembersModal from '../../../src/components/admin/BatchAddMembersModal.vue';
import { adAdminApi } from '../../../src/api/ad-admin.js';

const FAKE_DCS = ['DC-BJ-01', 'DC-SH-01', 'DC-GZ-01'];

function makeCmdResponse({ id, status, result = null, errorMessage = null }) {
  return { data: { id, status, result, errorMessage, targetDc: 'DC1', commandType: 'group_search', createdAt: '2026-09-03T00:00:00Z' } };
}

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
  adAdminApi.listCommands.mockResolvedValue({
    data: { total: 0, rows: [], page: 1, size: 20 }
  });
  adAdminApi.queueCommand.mockResolvedValue(makeCmdResponse({ id: 100, status: 'queued' }));
  // Default: 3-group search response so we have rows to select.
  adAdminApi.getCommand.mockResolvedValue(makeCmdResponse({
    id: 100, status: 'success',
    result: {
      groups: [
        { name: 'Sales Team',   category: 'Security',     scope: 'Universal', memberCount: 12, description: 'Sales dept' },
        { name: 'Marketing',    category: 'Security',     scope: 'Global',    memberCount: 5,  description: 'Marketing dept' },
        { name: 'Engineering',  category: 'Distribution', scope: 'Universal', memberCount: 30, description: 'Eng dept' }
      ],
      truncated: false, count: 3
    }
  }));
  // Default queueBatch response (all 3 succeeded).
  adAdminApi.queueBatch.mockResolvedValue({
    data: {
      queued: [
        { id: 401, commandType: 'group_add_member', targetDc: 'DC-BJ-01', status: 'queued', createdAt: '2026-09-03T00:00:00Z' },
        { id: 402, commandType: 'group_add_member', targetDc: 'DC-BJ-01', status: 'queued', createdAt: '2026-09-03T00:00:01Z' },
        { id: 403, commandType: 'group_add_member', targetDc: 'DC-BJ-01', status: 'queued', createdAt: '2026-09-03T00:00:02Z' }
      ],
      totalQueued: 3,
      errors: []
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mountView() {
  return mount(GroupManagementView, {
    global: {
      stubs: {
        AdminLayout: { template: '<div class="admin-layout-stub"><slot /></div>' },
        'router-link': { props: ['to'], template: '<a :href="to"><slot /></a>' }
      }
    }
  });
}

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

// ── Bulk bar visibility ─────────────────────────────────────────────────

test('bulk-action bar is hidden initially (no rows selected)', async () => {
  const w = mountView();
  await flushPromises();
  expect(w.find('[data-test="group-bulk-bar"]').exists()).toBe(false);
});

test('selecting 2 checkboxes shows the bulk-action bar with count', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="group-search-button"]').trigger('click');
  await driveSearch(w);
  await w.find('[data-test="group-bulk-Sales Team"]').setValue(true);
  await flushPromises();
  await w.find('[data-test="group-bulk-Marketing"]').setValue(true);
  await flushPromises();
  const bar = w.find('[data-test="group-bulk-bar"]');
  expect(bar.exists()).toBe(true);
  expect(w.find('[data-test="group-bulk-count"]').text()).toContain('2');
});

test('master checkbox selects all visible rows', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="group-search-button"]').trigger('click');
  await driveSearch(w);
  await w.find('[data-test="group-bulk-master"]').setValue(true);
  await flushPromises();
  expect(w.find('[data-test="group-bulk-count"]').text()).toContain('3');
});

// ── Add flow (BatchAddMembersModal mode='add') ─────────────────────────

test('clicking 添加成员 mounts BatchAddMembersModal in add mode', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="group-search-button"]').trigger('click');
  await driveSearch(w);
  await w.find('[data-test="group-bulk-Sales Team"]').setValue(true);
  await w.find('[data-test="group-bulk-Marketing"]').setValue(true);
  await flushPromises();
  await w.find('[data-test="group-bulk-add"]').trigger('click');
  await flushPromises();
  const modal = w.findComponent(BatchAddMembersModal);
  expect(modal.exists()).toBe(true);
  expect(modal.props('mode')).toBe('add');
  expect(modal.props('groupsCount')).toBe(2);
  expect(w.find('[data-test="batch-add-members-count"]').text()).toContain('2');
});

test('add submit posts group_add_member for each selected group with shared sams', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="group-search-button"]').trigger('click');
  await driveSearch(w);
  await w.find('[data-test="group-bulk-Sales Team"]').setValue(true);
  await w.find('[data-test="group-bulk-Marketing"]').setValue(true);
  await w.find('[data-test="group-bulk-Engineering"]').setValue(true);
  await flushPromises();
  adAdminApi.queueBatch.mockClear();
  await w.find('[data-test="group-bulk-add"]').trigger('click');
  await flushPromises();
  // Fill the textarea with three sams (newline-separated) and submit.
  await w.find('[data-test="batch-add-members-input"]').setValue('alice\nbob\ncarol');
  await w.find('[data-test="batch-add-members-submit"]').trigger('click');
  await flushPromises();
  expect(adAdminApi.queueBatch).toHaveBeenCalledTimes(1);
  const call = adAdminApi.queueBatch.mock.calls[0][0];
  expect(call.targetDc).toBe(FAKE_DCS[0]);
  expect(call.commandType).toBe('group_add_member');
  // One entry per selected group; all carry the SAME sams list.
  expect(call.paramsList.length).toBe(3);
  const groupNames = call.paramsList.map(p => p.name).sort();
  expect(groupNames).toEqual(['Engineering', 'Marketing', 'Sales Team']);
  for (const p of call.paramsList) {
    expect(p.members).toEqual(['alice', 'bob', 'carol']);
  }
});

test('add success shows 已批量添加成员 banner with count', async () => {
  // Override the default queueBatch mock so the response matches the
  // 2 groups selected by the test (the default returns 3).
  adAdminApi.queueBatch.mockResolvedValueOnce({
    data: {
      queued: [
        { id: 411, commandType: 'group_add_member', targetDc: 'DC-BJ-01', status: 'queued', createdAt: '2026-09-03T00:00:00Z' },
        { id: 412, commandType: 'group_add_member', targetDc: 'DC-BJ-01', status: 'queued', createdAt: '2026-09-03T00:00:01Z' }
      ],
      totalQueued: 2,
      errors: []
    }
  });
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="group-search-button"]').trigger('click');
  await driveSearch(w);
  await w.find('[data-test="group-bulk-Sales Team"]').setValue(true);
  await w.find('[data-test="group-bulk-Marketing"]').setValue(true);
  await flushPromises();
  await w.find('[data-test="group-bulk-add"]').trigger('click');
  await flushPromises();
  await w.find('[data-test="batch-add-members-input"]').setValue('alice, carol');
  await w.find('[data-test="batch-add-members-submit"]').trigger('click');
  await flushPromises();
  await nextTick();
  expect(w.text()).toMatch(/已批量\s*添加成员\s*2/);
});

// ── Remove flow (BatchAddMembersModal mode='remove') ───────────────────

test('clicking 移除成员 mounts BatchAddMembersModal in remove mode', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="group-search-button"]').trigger('click');
  await driveSearch(w);
  await w.find('[data-test="group-bulk-Sales Team"]').setValue(true);
  await w.find('[data-test="group-bulk-Marketing"]').setValue(true);
  await flushPromises();
  await w.find('[data-test="group-bulk-remove"]').trigger('click');
  await flushPromises();
  const modal = w.findComponent(BatchAddMembersModal);
  expect(modal.exists()).toBe(true);
  expect(modal.props('mode')).toBe('remove');
  expect(modal.props('groupsCount')).toBe(2);
});

test('remove submit posts group_remove_member for each selected group', async () => {
  adAdminApi.queueBatch.mockResolvedValueOnce({
    data: {
      queued: [
        { id: 501, commandType: 'group_remove_member', targetDc: 'DC-BJ-01', status: 'queued', createdAt: '2026-09-03T00:00:00Z' },
        { id: 502, commandType: 'group_remove_member', targetDc: 'DC-BJ-01', status: 'queued', createdAt: '2026-09-03T00:00:01Z' }
      ],
      totalQueued: 2,
      errors: []
    }
  });
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="group-search-button"]').trigger('click');
  await driveSearch(w);
  await w.find('[data-test="group-bulk-Sales Team"]').setValue(true);
  await w.find('[data-test="group-bulk-Marketing"]').setValue(true);
  await flushPromises();
  adAdminApi.queueBatch.mockClear();
  await w.find('[data-test="group-bulk-remove"]').trigger('click');
  await flushPromises();
  await w.find('[data-test="batch-add-members-input"]').setValue('alice, bob');
  await w.find('[data-test="batch-add-members-submit"]').trigger('click');
  await flushPromises();
  expect(adAdminApi.queueBatch).toHaveBeenCalledTimes(1);
  const call = adAdminApi.queueBatch.mock.calls[0][0];
  expect(call.commandType).toBe('group_remove_member');
  expect(call.paramsList.length).toBe(2);
  const groupNames = call.paramsList.map(p => p.name).sort();
  expect(groupNames).toEqual(['Marketing', 'Sales Team']);
  for (const p of call.paramsList) {
    expect(p.members).toEqual(['alice', 'bob']);
  }
});

test('remove success shows 已批量移除成员 banner', async () => {
  adAdminApi.queueBatch.mockResolvedValueOnce({
    data: {
      queued: [
        { id: 601, commandType: 'group_remove_member', targetDc: 'DC-BJ-01', status: 'queued', createdAt: '2026-09-03T00:00:00Z' },
        { id: 602, commandType: 'group_remove_member', targetDc: 'DC-BJ-01', status: 'queued', createdAt: '2026-09-03T00:00:01Z' }
      ],
      totalQueued: 2,
      errors: []
    }
  });
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="group-search-button"]').trigger('click');
  await driveSearch(w);
  await w.find('[data-test="group-bulk-Sales Team"]').setValue(true);
  await w.find('[data-test="group-bulk-Marketing"]').setValue(true);
  await flushPromises();
  await w.find('[data-test="group-bulk-remove"]').trigger('click');
  await flushPromises();
  await w.find('[data-test="batch-add-members-input"]').setValue('alice');
  await w.find('[data-test="batch-add-members-submit"]').trigger('click');
  await flushPromises();
  await nextTick();
  expect(w.text()).toMatch(/已批量\s*移除成员\s*2/);
});

// ── Disabled state ──────────────────────────────────────────────────────

test('bulk bar buttons disabled when DC picker is empty', async () => {
  // Mount with an empty DC list so selectedDc stays unset.
  adAdminApi.listDcs.mockResolvedValueOnce({ data: { nodes: [], links: [] } });
  const w = mountView();
  await flushPromises();
  expect(w.find('[data-test="group-bulk-bar"]').exists()).toBe(false);
  const picker = w.find('[data-test="dc-picker"]');
  expect(picker.findAll('option').length).toBe(0);
});

// ── Clear selection ─────────────────────────────────────────────────────

test('clicking 取消选择 clears the selection set', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="group-search-button"]').trigger('click');
  await driveSearch(w);
  await w.find('[data-test="group-bulk-Sales Team"]').setValue(true);
  await w.find('[data-test="group-bulk-Marketing"]').setValue(true);
  await flushPromises();
  expect(w.find('[data-test="group-bulk-count"]').text()).toContain('2');
  await w.find('[data-test="group-bulk-clear"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="group-bulk-bar"]').exists()).toBe(false);
});

// ── Single-component sanity for BatchAddMembersModal ───────────────────

test('BatchAddMembersModal: submit disabled when input empty', async () => {
  const w = mount(BatchAddMembersModal, {
    props: { mode: 'add', groupsCount: 2 }
  });
  const submit = () => w.find('[data-test="batch-add-members-submit"]');
  expect(submit().attributes('disabled')).toBeDefined();
  await w.find('[data-test="batch-add-members-input"]').setValue('alice');
  expect(submit().attributes('disabled')).toBeUndefined();
});

test('BatchAddMembersModal: parses newline-separated sams', async () => {
  const w = mount(BatchAddMembersModal, {
    props: { mode: 'add', groupsCount: 2 }
  });
  await w.find('[data-test="batch-add-members-input"]').setValue('alice\nbob\ncarol');
  await flushPromises();
  expect(w.find('[data-test="batch-add-members-chips"]').exists()).toBe(true);
  // Chips render in input order; just count they all show up.
  const chips = w.findAll('.chip');
  expect(chips.length).toBe(3);
});

test('BatchAddMembersModal: parses comma-separated sams', async () => {
  const w = mount(BatchAddMembersModal, {
    props: { mode: 'add', groupsCount: 2 }
  });
  await w.find('[data-test="batch-add-members-input"]').setValue('alice,bob,carol');
  await flushPromises();
  const chips = w.findAll('.chip');
  expect(chips.length).toBe(3);
});

test('BatchAddMembersModal: parses mixed separators + dedupes + trims', async () => {
  const w = mount(BatchAddMembersModal, {
    props: { mode: 'add', groupsCount: 2 }
  });
  await w.find('[data-test="batch-add-members-input"]').setValue('alice, bob\ncarol   alice\nbob');
  await flushPromises();
  const chips = w.findAll('.chip');
  expect(chips.length).toBe(3); // deduped to alice/bob/carol
});

test('BatchAddMembersModal: submit emits { sams } in input order', async () => {
  const w = mount(BatchAddMembersModal, {
    props: { mode: 'add', groupsCount: 2 }
  });
  await w.find('[data-test="batch-add-members-input"]').setValue('alice, bob\ncarol');
  await w.find('[data-test="batch-add-members-submit"]').trigger('click');
  expect(w.emitted('submit')).toBeTruthy();
  expect(w.emitted('submit')[0][0]).toEqual({ sams: ['alice', 'bob', 'carol'] });
});

test('BatchAddMembersModal: mode=remove changes title + submit button label', async () => {
  const w = mount(BatchAddMembersModal, {
    props: { mode: 'remove', groupsCount: 3 }
  });
  // Title copy contains the 移除 marker.
  expect(w.text()).toMatch(/批量移除成员/);
  // Submit button label is the remove verb + count.
  expect(w.find('[data-test="batch-add-members-submit"]').text()).toMatch(/移除\s*\(\s*0\s*\)/);
  await w.find('[data-test="batch-add-members-input"]').setValue('alice');
  await flushPromises();
  expect(w.find('[data-test="batch-add-members-submit"]').text()).toMatch(/移除\s*\(\s*1\s*\)/);
});

test('BatchAddMembersModal: cancel emits close', async () => {
  const w = mount(BatchAddMembersModal, {
    props: { mode: 'add', groupsCount: 2 }
  });
  await w.find('[data-test="batch-add-members-cancel"]').trigger('click');
  expect(w.emitted('close')).toBeTruthy();
});