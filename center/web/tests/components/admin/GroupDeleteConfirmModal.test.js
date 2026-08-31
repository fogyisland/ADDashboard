// 2026-08-31 R75 — frontend tests for GroupDeleteConfirmModal.vue.
//
// Confirmation requires typing the group Name. Submit button is
// disabled until the input matches the name prop.

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../../../src/api/ad-admin.js', () => ({
  adAdminApi: {
    queueCommand: vi.fn(),
    getCommand: vi.fn()
  }
}));

import GroupDeleteConfirmModal from '../../../src/components/admin/GroupDeleteConfirmModal.vue';
import { adAdminApi } from '../../../src/api/ad-admin.js';

const TARGET_DC = 'DC-BJ-01';
const NAME = 'Sales';

beforeEach(() => {
  vi.useFakeTimers();
  adAdminApi.queueCommand.mockResolvedValue({
    data: { id: 900, status: 'queued', targetDc: TARGET_DC, commandType: 'group_delete' }
  });
  adAdminApi.getCommand.mockResolvedValue({
    data: { id: 900, status: 'success', result: { name: NAME, deleted: true } }
  });
});

afterEach(() => { vi.useRealTimers(); });

function mountModal() {
  return mount(GroupDeleteConfirmModal, { props: { targetDc: TARGET_DC, name: NAME } });
}

test('confirm button disabled until name is typed correctly', async () => {
  const w = mountModal();
  const submit = () => w.find('[data-test="group-delete-confirm-submit"]');
  expect(submit().attributes('disabled')).toBeDefined();
  await w.find('[data-test="group-delete-confirm-input"]').setValue('wrong');
  expect(submit().attributes('disabled')).toBeDefined();
  await w.find('[data-test="group-delete-confirm-input"]').setValue(NAME);
  expect(submit().attributes('disabled')).toBeUndefined();
});

test('submit posts group_delete with name', async () => {
  const w = mountModal();
  await w.find('[data-test="group-delete-confirm-input"]').setValue(NAME);
  await w.find('[data-test="group-delete-confirm-submit"]').trigger('click');
  await flushPromises();
  await vi.runAllTimersAsync();
  expect(adAdminApi.queueCommand).toHaveBeenCalledWith({
    targetDc: TARGET_DC,
    commandType: 'group_delete',
    params: { name: NAME }
  });
});

test('submit success renders 已删除 banner and emits deleted', async () => {
  const w = mountModal();
  await w.find('[data-test="group-delete-confirm-input"]').setValue(NAME);
  await w.find('[data-test="group-delete-confirm-submit"]').trigger('click');
  await flushPromises();
  await vi.runAllTimersAsync();
  expect(w.find('[data-test="group-delete-confirm-result"]').text()).toContain('已删除');
  expect(w.emitted('deleted')).toBeTruthy();
});