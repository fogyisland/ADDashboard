// 2026-08-31 R75 — frontend tests for UserGroupMembershipsModal.vue.
//
// Read-only list of groups the user belongs to. The modal queues
// user_list_groups and polls to terminal.

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../../../src/api/ad-admin.js', () => ({
  adAdminApi: {
    queueCommand: vi.fn(),
    getCommand: vi.fn()
  }
}));

import UserGroupMembershipsModal from '../../../src/components/admin/UserGroupMembershipsModal.vue';
import { adAdminApi } from '../../../src/api/ad-admin.js';

const TARGET_DC = 'DC-BJ-01';
const SAM = 'alice';

beforeEach(() => {
  vi.useFakeTimers();
  adAdminApi.queueCommand.mockResolvedValue({
    data: { id: 400, status: 'queued', targetDc: TARGET_DC, commandType: 'user_list_groups' }
  });
  adAdminApi.getCommand.mockResolvedValue({
    data: {
      id: 400,
      status: 'success',
      result: { sam: SAM, groups: [
        { name: 'Sales Team', dn: 'CN=Sales Team,DC=contoso', category: 'Security', scope: 'Universal' },
        { name: 'All Staff DL', dn: 'CN=All Staff DL,DC=contoso', category: 'Distribution', scope: 'Universal' }
      ] }
    }
  });
});

afterEach(() => { vi.useRealTimers(); });

function mountModal() {
  return mount(UserGroupMembershipsModal, { props: { targetDc: TARGET_DC, sam: SAM } });
}

test('queues user_list_groups on mount', async () => {
  mountModal();
  await flushPromises();
  expect(adAdminApi.queueCommand).toHaveBeenCalledWith({
    targetDc: TARGET_DC,
    commandType: 'user_list_groups',
    params: { sam: SAM }
  });
});

test('renders group rows from polled response', async () => {
  const w = mountModal();
  await flushPromises();
  await vi.runAllTimersAsync();
  expect(w.find('[data-test="user-group-row-Sales Team"]').exists()).toBe(true);
  expect(w.find('[data-test="user-group-row-All Staff DL]'.replace(']', '') + '"]').exists() ||
         w.text()).toContain('All Staff DL');
  expect(w.text()).toContain('Sales Team');
  expect(w.text()).toContain('Universal');
});

test('shows empty hint when response has zero groups', async () => {
  adAdminApi.getCommand.mockResolvedValue({
    data: { id: 400, status: 'success', result: { sam: SAM, groups: [] } }
  });
  const w = mountModal();
  await flushPromises();
  await vi.runAllTimersAsync();
  expect(w.text()).toContain('该用户不属于任何组');
});

test('cancel emits close', async () => {
  const w = mountModal();
  await flushPromises();
  await w.find('[data-test="user-groups-close"]').trigger('click');
  expect(w.emitted('close')).toBeTruthy();
});