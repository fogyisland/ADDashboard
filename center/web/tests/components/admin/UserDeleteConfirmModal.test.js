// 2026-08-31 R75 — frontend tests for UserDeleteConfirmModal.vue.
//
// Confirmation requires typing the sAMAccountName. Submit button is
// disabled until the input matches the sam prop.

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../../../src/api/ad-admin.js', () => ({
  adAdminApi: {
    queueCommand: vi.fn(),
    getCommand: vi.fn()
  }
}));

import UserDeleteConfirmModal from '../../../src/components/admin/UserDeleteConfirmModal.vue';
import { adAdminApi } from '../../../src/api/ad-admin.js';

const TARGET_DC = 'DC-BJ-01';
const SAM = 'alice';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  adAdminApi.queueCommand.mockResolvedValue({
    data: { id: 500, status: 'queued', targetDc: TARGET_DC, commandType: 'user_delete' }
  });
  adAdminApi.getCommand.mockResolvedValue({
    data: { id: 500, status: 'success', result: { sam: SAM, deleted: true } }
  });
});

afterEach(() => { vi.useRealTimers(); });

function mountModal() {
  return mount(UserDeleteConfirmModal, { props: { targetDc: TARGET_DC, sam: SAM } });
}

test('confirm button disabled until sam is typed correctly', async () => {
  const w = mountModal();
  const submit = () => w.find('[data-test="user-delete-confirm-submit"]');
  expect(submit().attributes('disabled')).toBeDefined();
  await w.find('[data-test="user-delete-confirm-input"]').setValue('wrong');
  expect(submit().attributes('disabled')).toBeDefined();
  await w.find('[data-test="user-delete-confirm-input"]').setValue(SAM);
  expect(submit().attributes('disabled')).toBeUndefined();
});

test('submit posts user_delete with sam', async () => {
  const w = mountModal();
  await w.find('[data-test="user-delete-confirm-input"]').setValue(SAM);
  await w.find('[data-test="user-delete-confirm-submit"]').trigger('click');
  await flushPromises();
  await vi.runAllTimersAsync();
  expect(adAdminApi.queueCommand).toHaveBeenCalledWith({
    targetDc: TARGET_DC,
    commandType: 'user_delete',
    params: { sam: SAM }
  });
});

test('submit success renders 已删除 banner and emits deleted', async () => {
  const w = mountModal();
  await w.find('[data-test="user-delete-confirm-input"]').setValue(SAM);
  await w.find('[data-test="user-delete-confirm-submit"]').trigger('click');
  await flushPromises();
  await vi.runAllTimersAsync();
  expect(w.find('[data-test="user-delete-confirm-result"]').text()).toContain('已删除');
  expect(w.emitted('deleted')).toBeTruthy();
});

test('cancel emits close', async () => {
  const w = mountModal();
  await w.find('[data-test="user-delete-confirm-cancel"]').trigger('click');
  expect(w.emitted('close')).toBeTruthy();
});