// 2026-08-31 R75 — frontend tests for UserPasswordResetModal.vue.
//
// Covers:
//   - password + confirm fields present
//   - submit disabled until both passwords match
//   - submit posts user_password_reset with sam + newPassword

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../../../src/api/ad-admin.js', () => ({
  adAdminApi: {
    queueCommand: vi.fn(),
    getCommand: vi.fn()
  }
}));

import UserPasswordResetModal from '../../../src/components/admin/UserPasswordResetModal.vue';
import { adAdminApi } from '../../../src/api/ad-admin.js';

const TARGET_DC = 'DC-BJ-01';
const SAM = 'alice';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  adAdminApi.queueCommand.mockResolvedValue({
    data: { id: 200, status: 'queued', targetDc: TARGET_DC, commandType: 'user_password_reset' }
  });
  adAdminApi.getCommand.mockResolvedValue({
    data: { id: 200, status: 'success', result: { sam: SAM, passwordReset: true, unlocked: true } }
  });
});

afterEach(() => { vi.useRealTimers(); });

function mountModal() {
  return mount(UserPasswordResetModal, { props: { targetDc: TARGET_DC, sam: SAM } });
}

test('renders password + confirm + mustChange + unlock fields', () => {
  const w = mountModal();
  for (const t of [
    'user-password-reset-password',
    'user-password-reset-passwordConfirm',
    'user-password-reset-mustChange',
    'user-password-reset-unlock',
    'user-password-reset-submit',
    'user-password-reset-cancel'
  ]) {
    expect(w.find(`[data-test="${t}"]`).exists()).toBe(true);
  }
});

test('submit disabled until both passwords match', async () => {
  const w = mountModal();
  const submit = () => w.find('[data-test="user-password-reset-submit"]');
  expect(submit().attributes('disabled')).toBeDefined();
  await w.find('[data-test="user-password-reset-password"]').setValue('P@ssw0rd');
  expect(submit().attributes('disabled')).toBeDefined(); // confirm not set
  await w.find('[data-test="user-password-reset-passwordConfirm"]').setValue('Mismatch');
  expect(submit().attributes('disabled')).toBeDefined(); // mismatch
  await w.find('[data-test="user-password-reset-passwordConfirm"]').setValue('P@ssw0rd');
  expect(submit().attributes('disabled')).toBeUndefined();
});

test('submit posts user_password_reset with newPassword + unlockAccount=true', async () => {
  const w = mountModal();
  await w.find('[data-test="user-password-reset-password"]').setValue('P@ssw0rd');
  await w.find('[data-test="user-password-reset-passwordConfirm"]').setValue('P@ssw0rd');
  await w.find('[data-test="user-password-reset-submit"]').trigger('click');
  await flushPromises();
  await vi.runAllTimersAsync();
  expect(adAdminApi.queueCommand).toHaveBeenCalledWith({
    targetDc: TARGET_DC,
    commandType: 'user_password_reset',
    params: { sam: SAM, newPassword: 'P@ssw0rd', mustChangePassword: true, unlockAccount: true }
  });
});