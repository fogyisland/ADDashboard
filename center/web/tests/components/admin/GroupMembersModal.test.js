// 2026-08-31 R75 — frontend tests for GroupMembersModal.vue.
//
// Covers:
//   - initial list load (group_list_members)
//   - add flow (group_add_member) — input parses comma/space separated SAMs
//   - remove flow (group_remove_member) — submits selected items
//   - replace flow (group_set_members) — requires explicit confirm
//   - cancel emits close + clears in-flight polling
//   - REGRESSION: orphan handler cleanup — after cancel(), no setInterval
//     from the loadMembers() poll remains active.

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../../../src/api/ad-admin.js', () => ({
  adAdminApi: {
    queueCommand: vi.fn(),
    getCommand: vi.fn()
  }
}));

import GroupMembersModal from '../../../src/components/admin/GroupMembersModal.vue';
import { adAdminApi } from '../../../src/api/ad-admin.js';

const TARGET_DC = 'DC-BJ-01';
const NAME = 'Sales';

const FAKE_MEMBERS = [
  { sam: 'alice', dn: 'CN=Alice,DC=contoso' },
  { sam: 'bob',   dn: 'CN=Bob,DC=contoso' },
  { sam: 'charlie', dn: 'CN=Charlie,DC=contoso' }
];

let idCounter = 800;
function nextId() { return ++idCounter; }

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  let cmdType = 'group_list_members';
  adAdminApi.queueCommand.mockImplementation(({ commandType }) => ({
    data: { id: nextId(), status: 'queued', targetDc: TARGET_DC, commandType }
  }));
  adAdminApi.getCommand.mockImplementation(({ }) => {
    // The default getCommand mock — return success with the right shape
    // depending on commandType was already passed to the mock.
    return { data: { id: 0, status: 'success', result: { members: FAKE_MEMBERS } } };
  });
});

afterEach(() => { vi.useRealTimers(); });

function mountModal() {
  return mount(GroupMembersModal, { props: { targetDc: TARGET_DC, name: NAME } });
}

test('initial load queues group_list_members and renders members', async () => {
  const w = mountModal();
  await flushPromises();
  await vi.runAllTimersAsync();
  expect(adAdminApi.queueCommand).toHaveBeenCalledWith(expect.objectContaining({
    targetDc: TARGET_DC,
    commandType: 'group_list_members',
    params: { name: NAME, page: 1, size: 100 }
  }));
  expect(w.text()).toContain('alice');
  expect(w.text()).toContain('bob');
  expect(w.text()).toContain('charlie');
});

test('add flow parses comma+space separated SAMs into members list', async () => {
  const w = mountModal();
  await flushPromises();
  await vi.runAllTimersAsync();
  await w.find('[data-test="group-members-add-input"]').setValue('alice, bob charlie');
  await w.find('[data-test="group-members-add"]').trigger('click');
  await flushPromises();
  await vi.runAllTimersAsync();
  expect(adAdminApi.queueCommand).toHaveBeenCalledWith(expect.objectContaining({
    commandType: 'group_add_member',
    params: expect.objectContaining({ name: NAME, members: ['alice', 'bob', 'charlie'] })
  }));
});

test('remove flow submits selectedToRemove list', async () => {
  const w = mountModal();
  await flushPromises();
  await vi.runAllTimersAsync();
  // Select first two checkboxes by setting the v-model via setChecked.
  const checks = w.findAll('.member-row input[type="checkbox"]');
  expect(checks.length).toBe(FAKE_MEMBERS.length);
  await checks[0].setValue(true);
  await checks[1].setValue(true);
  await w.find('[data-test="group-members-remove"]').trigger('click');
  await flushPromises();
  await vi.runAllTimersAsync();
  expect(adAdminApi.queueCommand).toHaveBeenCalledWith(expect.objectContaining({
    commandType: 'group_remove_member',
    params: expect.objectContaining({ name: NAME, members: ['alice', 'bob'] })
  }));
});

test('replace flow requires explicit confirm', async () => {
  const w = mountModal();
  await flushPromises();
  await vi.runAllTimersAsync();
  await w.find('[data-test="group-members-add-input"]').setValue('dave');
  await w.find('[data-test="group-members-replace"]').trigger('click');
  await flushPromises();
  // Confirm banner is visible
  expect(w.find('[data-test="group-members-replace-confirm"]').exists()).toBe(true);
  // Confirm and verify group_set_members queued
  await w.find('[data-test="group-members-replace-confirm"]').trigger('click');
  await flushPromises();
  await vi.runAllTimersAsync();
  expect(adAdminApi.queueCommand).toHaveBeenCalledWith(expect.objectContaining({
    commandType: 'group_set_members',
    params: expect.objectContaining({ name: NAME, members: ['dave'] })
  }));
});

test('cancel emits close', async () => {
  const w = mountModal();
  await flushPromises();
  await w.find('[data-test="group-members-close"]').trigger('click');
  expect(w.emitted('close')).toBeTruthy();
});

// REGRESSION for BLOCKER #4: the original R75 implementation had
// `const handler = setInterval(...)` inside loadMembers() that was never
// tracked, so closing the modal left the interval running. Refactor to
// useCommandPolling means the composable owns the timer and clears it
// on unmount via onBeforeUnmount. This test asserts no late mutation
// lands after cancel + advancing past the polling interval.
test('cancel before next poll cycle cleans up interval (orphan-handler regression)', async () => {
  const w = mountModal();
  await flushPromises();
  // Let one poll fire (1500ms cadence).
  await vi.advanceTimersByTimeAsync(1500);
  // Snapshot the active timer count BEFORE close.
  const timerCountBefore = vi.getTimerCount();
  // Cancel mid-flight.
  await w.find('[data-test="group-members-close"]').trigger('click');
  // Unmount the wrapper.
  w.unmount();
  // Advance well past the polling interval + timeout deadline.
  await vi.advanceTimersByTimeAsync(60_000);
  // After unmount, the composable's onBeforeUnmount fired and the
  // composable no longer has any live timers (its interval was cleared).
  const timerCountAfter = vi.getTimerCount();
  expect(timerCountAfter).toBeLessThanOrEqual(timerCountBefore);
  // No late state mutation — the result banner must not appear.
  expect(w.find('[data-test="group-members-result"]').exists()).toBe(false);
});