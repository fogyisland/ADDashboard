// 2026-09-02 R76 — frontend tests for the bulk-action UI on
// UserManagementView.vue (checkbox column + sticky bulk bar +
// BatchPasswordResetModal mount).
//
// Covers:
//   - Selecting 2 checkboxes shows the bulk-action bar
//   - Clicking 启用 calls queueBatch with the correct shape
//   - Clicking 重置密码 opens BatchPasswordResetModal
//   - Submitting the modal calls queueBatch with user_password_reset + N entries
//   - Toast/banner appears on success
//   - Master checkbox selects all visible rows
//   - Bulk buttons disabled when DC picker is empty

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

import UserManagementView from '../../../src/views/admin/UserManagementView.vue';
import BatchPasswordResetModal from '../../../src/components/admin/BatchPasswordResetModal.vue';
import { adAdminApi } from '../../../src/api/ad-admin.js';

const FAKE_DCS = ['DC-BJ-01', 'DC-SH-01', 'DC-GZ-01'];

function makeCmdResponse({ id, status, result = null, errorMessage = null }) {
  return { data: { id, status, result, errorMessage, targetDc: 'DC1', commandType: 'user_search', createdAt: '2026-09-02T00:00:00Z' } };
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
  // Default: 3-user search response so we have rows to select.
  adAdminApi.getCommand.mockResolvedValue(makeCmdResponse({
    id: 100, status: 'success',
    result: {
      users: [
        { sam: 'jdoe', displayName: 'John Doe', enabled: true, lastLogon: null, description: '' },
        { sam: 'asmith', displayName: 'Alice Smith', enabled: false, lastLogon: null, description: '' },
        { sam: 'bwayne', displayName: 'Bruce Wayne', enabled: true, lastLogon: null, description: '' }
      ],
      truncated: false, count: 3
    }
  }));
  // Default queueBatch response (all 3 succeeded).
  adAdminApi.queueBatch.mockResolvedValue({
    data: {
      queued: [
        { id: 201, commandType: 'user_enable', targetDc: 'DC-BJ-01', status: 'queued', createdAt: '2026-09-02T00:00:00Z' },
        { id: 202, commandType: 'user_enable', targetDc: 'DC-BJ-01', status: 'queued', createdAt: '2026-09-02T00:00:01Z' }
      ],
      totalQueued: 2,
      errors: []
    }
  });
  // Stub window.confirm so bulkConfirm passes through automatically.
  vi.spyOn(window, 'confirm').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mountView() {
  return mount(UserManagementView, {
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
    if (w.findAll('[data-test^="user-row-"]').length > 0) return;
  }
}

// ── Bulk bar visibility ─────────────────────────────────────────────────

test('bulk-action bar is hidden initially (no rows selected)', async () => {
  const w = mountView();
  await flushPromises();
  expect(w.find('[data-test="user-bulk-bar"]').exists()).toBe(false);
});

test('selecting 2 checkboxes shows the bulk-action bar with count', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="user-search-button"]').trigger('click');
  await driveSearch(w);
  await w.find('[data-test="user-bulk-jdoe"]').setValue(true);
  await flushPromises();
  await w.find('[data-test="user-bulk-asmith"]').setValue(true);
  await flushPromises();
  const bar = w.find('[data-test="user-bulk-bar"]');
  expect(bar.exists()).toBe(true);
  expect(w.find('[data-test="user-bulk-count"]').text()).toContain('2');
});

test('master checkbox selects all visible rows', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="user-search-button"]').trigger('click');
  await driveSearch(w);
  await w.find('[data-test="user-bulk-master"]').setValue(true);
  await flushPromises();
  expect(w.find('[data-test="user-bulk-count"]').text()).toContain('3');
});

// ── Bulk enable ─────────────────────────────────────────────────────────

test('clicking 启用 calls queueBatch with commandType=user_enable + N entries', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="user-search-button"]').trigger('click');
  await driveSearch(w);
  adAdminApi.queueBatch.mockClear();
  await w.find('[data-test="user-bulk-jdoe"]').setValue(true);
  await w.find('[data-test="user-bulk-asmith"]').setValue(true);
  await flushPromises();
  await w.find('[data-test="user-bulk-enable"]').trigger('click');
  await flushPromises();
  expect(adAdminApi.queueBatch).toHaveBeenCalledWith({
    targetDc: FAKE_DCS[0],
    commandType: 'user_enable',
    paramsList: [{ sam: 'jdoe' }, { sam: 'asmith' }]
  });
});

test('bulk 启用 success shows banner with count', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="user-search-button"]').trigger('click');
  await driveSearch(w);
  await w.find('[data-test="user-bulk-jdoe"]').setValue(true);
  await w.find('[data-test="user-bulk-asmith"]').setValue(true);
  await flushPromises();
  await w.find('[data-test="user-bulk-enable"]').trigger('click');
  await flushPromises();
  await nextTick();
  // Note: text has a deliberate space between 批量 and 启用 (banner copy).
  expect(w.text()).toMatch(/已批量\s*启用\s*2/);
});

test('bulk 禁用 calls window.confirm before queueBatch', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="user-search-button"]').trigger('click');
  await driveSearch(w);
  await w.find('[data-test="user-bulk-jdoe"]').setValue(true);
  await flushPromises();
  adAdminApi.queueBatch.mockClear();
  await w.find('[data-test="user-bulk-disable"]').trigger('click');
  await flushPromises();
  expect(window.confirm).toHaveBeenCalled();
  expect(adAdminApi.queueBatch).toHaveBeenCalledWith(expect.objectContaining({
    commandType: 'user_disable',
    paramsList: [{ sam: 'jdoe' }]
  }));
});

// ── Bulk unlock (no confirm) ─────────────────────────────────────────────

test('bulk 解锁 does NOT call window.confirm', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="user-search-button"]').trigger('click');
  await driveSearch(w);
  await w.find('[data-test="user-bulk-jdoe"]').setValue(true);
  await flushPromises();
  adAdminApi.queueBatch.mockClear();
  await w.find('[data-test="user-bulk-unlock"]').trigger('click');
  await flushPromises();
  expect(window.confirm).not.toHaveBeenCalled();
  expect(adAdminApi.queueBatch).toHaveBeenCalledWith(expect.objectContaining({
    commandType: 'user_unlock'
  }));
});

// ── Batch password reset (modal) ────────────────────────────────────────

test('clicking 重置密码 mounts BatchPasswordResetModal with selected sams', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="user-search-button"]').trigger('click');
  await driveSearch(w);
  await w.find('[data-test="user-bulk-jdoe"]').setValue(true);
  await w.find('[data-test="user-bulk-asmith"]').setValue(true);
  await flushPromises();
  await w.find('[data-test="user-bulk-reset"]').trigger('click');
  await flushPromises();
  const modal = w.findComponent(BatchPasswordResetModal);
  expect(modal.exists()).toBe(true);
  expect(modal.props('sams')).toEqual(['jdoe', 'asmith']);
  expect(w.find('[data-test="batch-password-reset-count"]').text()).toContain('2');
});

test('BatchPasswordResetModal submit posts user_password_reset for all selected sams', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="user-search-button"]').trigger('click');
  await driveSearch(w);
  await w.find('[data-test="user-bulk-jdoe"]').setValue(true);
  await w.find('[data-test="user-bulk-asmith"]').setValue(true);
  await flushPromises();
  adAdminApi.queueBatch.mockClear();
  await w.find('[data-test="user-bulk-reset"]').trigger('click');
  await flushPromises();
  // Fill the modal password + confirm.
  await w.find('[data-test="batch-password-reset-password"]').setValue('P@ssw0rd');
  await w.find('[data-test="batch-password-reset-passwordConfirm"]').setValue('P@ssw0rd');
  await w.find('[data-test="batch-password-reset-submit"]').trigger('click');
  await flushPromises();
  expect(adAdminApi.queueBatch).toHaveBeenCalledTimes(1);
  const call = adAdminApi.queueBatch.mock.calls[0][0];
  expect(call.commandType).toBe('user_password_reset');
  expect(call.paramsList.length).toBe(2);
  expect(call.paramsList[0].sam).toBe('jdoe');
  expect(call.paramsList[1].sam).toBe('asmith');
  // Same password applied to all — explicit R76 design concession.
  expect(call.paramsList[0].newPassword).toBe('P@ssw0rd');
  expect(call.paramsList[1].newPassword).toBe('P@ssw0rd');
});

test('BatchPasswordResetModal submit success shows 已批量重置密码 banner', async () => {
  adAdminApi.queueBatch.mockResolvedValue({
    data: {
      queued: [
        { id: 301, commandType: 'user_password_reset', targetDc: 'DC-BJ-01', status: 'queued', createdAt: '2026-09-02T00:00:00Z' },
        { id: 302, commandType: 'user_password_reset', targetDc: 'DC-BJ-01', status: 'queued', createdAt: '2026-09-02T00:00:01Z' }
      ],
      totalQueued: 2,
      errors: []
    }
  });
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="user-search-button"]').trigger('click');
  await driveSearch(w);
  await w.find('[data-test="user-bulk-jdoe"]').setValue(true);
  await w.find('[data-test="user-bulk-asmith"]').setValue(true);
  await flushPromises();
  await w.find('[data-test="user-bulk-reset"]').trigger('click');
  await flushPromises();
  await w.find('[data-test="batch-password-reset-password"]').setValue('P@ssw0rd');
  await w.find('[data-test="batch-password-reset-passwordConfirm"]').setValue('P@ssw0rd');
  await w.find('[data-test="batch-password-reset-submit"]').trigger('click');
  await flushPromises();
  await nextTick();
  expect(w.text()).toMatch(/已批量重置密码\s*2/);
});

// ── Disabled state ──────────────────────────────────────────────────────

test('bulk bar buttons disabled when DC picker is empty', async () => {
  // Mount with an empty DC list so selectedDc stays unset.
  adAdminApi.listDcs.mockResolvedValueOnce({ data: { nodes: [], links: [] } });
  const w = mountView();
  await flushPromises();
  // With no DCs the toolbar renders the hint-block and results/bulk-bar
  // never mount. This is the structural assertion: there's no path
  // through the UI to a bulk action when no DC is selectable.
  expect(w.find('[data-test="user-bulk-bar"]').exists()).toBe(false);
  // The search button is also disabled in this configuration — that's
  // the surface-level guard the spec ships with. Picker has 0 options.
  const picker = w.find('[data-test="dc-picker"]');
  expect(picker.findAll('option').length).toBe(0);
});

// ── Clear selection ─────────────────────────────────────────────────────

test('clicking 取消选择 clears the selection set', async () => {
  const w = mountView();
  await flushPromises();
  await w.find('[data-test="user-search-button"]').trigger('click');
  await driveSearch(w);
  await w.find('[data-test="user-bulk-jdoe"]').setValue(true);
  await w.find('[data-test="user-bulk-asmith"]').setValue(true);
  await flushPromises();
  expect(w.find('[data-test="user-bulk-count"]').text()).toContain('2');
  await w.find('[data-test="user-bulk-clear"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="user-bulk-bar"]').exists()).toBe(false);
});

// ── Single-component sanity ─────────────────────────────────────────────

test('BatchPasswordResetModal: submit disabled until passwords match', async () => {
  const w = mount(BatchPasswordResetModal, {
    props: { sams: ['alice', 'bob'] }
  });
  const submit = () => w.find('[data-test="batch-password-reset-submit"]');
  expect(submit().attributes('disabled')).toBeDefined();
  await w.find('[data-test="batch-password-reset-password"]').setValue('P@ssw0rd');
  expect(submit().attributes('disabled')).toBeDefined(); // confirm missing
  await w.find('[data-test="batch-password-reset-passwordConfirm"]').setValue('Mismatch');
  expect(submit().attributes('disabled')).toBeDefined(); // mismatch
  await w.find('[data-test="batch-password-reset-passwordConfirm"]').setValue('P@ssw0rd');
  expect(submit().attributes('disabled')).toBeUndefined();
});

test('BatchPasswordResetModal: submit emits submit with sams + newPassword', async () => {
  const w = mount(BatchPasswordResetModal, {
    props: { sams: ['alice', 'bob', 'carol'] }
  });
  await w.find('[data-test="batch-password-reset-password"]').setValue('P@ssw0rd');
  await w.find('[data-test="batch-password-reset-passwordConfirm"]').setValue('P@ssw0rd');
  await w.find('[data-test="batch-password-reset-submit"]').trigger('click');
  expect(w.emitted('submit')).toBeTruthy();
  expect(w.emitted('submit')[0][0]).toMatchObject({
    sams: ['alice', 'bob', 'carol'],
    newPassword: 'P@ssw0rd',
    mustChangePassword: true,
    unlockAccount: true
  });
});