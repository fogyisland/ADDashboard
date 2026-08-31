// 2026-08-31 R75 — frontend tests for UserCreateModal.vue.
//
// Covers:
//   - form fields render with correct data-test hooks
//   - submit is disabled until required fields filled
//   - submit posts user_create with expected payload (description included)
//   - submit success → result message + emits submitted
//   - cancel closes modal + clears in-flight polling
//   - regression: deadline (setTimeout) leak cleanup on cancel

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../../../src/api/ad-admin.js', () => ({
  adAdminApi: {
    queueCommand: vi.fn(),
    getCommand: vi.fn()
  }
}));

import UserCreateModal from '../../../src/components/admin/UserCreateModal.vue';
import { adAdminApi } from '../../../src/api/ad-admin.js';

const TARGET_DC = 'DC-BJ-01';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  // queueCommand returns a queued command; getCommand returns success with dn.
  adAdminApi.queueCommand.mockResolvedValue({
    data: { id: 100, status: 'queued', targetDc: TARGET_DC, commandType: 'user_create' }
  });
  adAdminApi.getCommand.mockResolvedValue({
    data: { id: 100, status: 'success', result: { sam: 'alice', dn: 'CN=Alice,OU=Users,DC=contoso' } }
  });
});

function mountModal() {
  return mount(UserCreateModal, { props: { targetDc: TARGET_DC } });
}

afterEach(() => {
  vi.useRealTimers();
});

// Tiny helper — vi.useFakeTimers requires explicit clear-up
function afterEachWrapper() { /* noop; vi.useRealTimers in beforeEach covers cleanup */ }

test('renders all expected form fields', () => {
  const w = mountModal();
  for (const t of [
    'user-create-sam',
    'user-create-displayName',
    'user-create-givenName',
    'user-create-surname',
    'user-create-upn',
    'user-create-ouPath',
    'user-create-password',
    'user-create-passwordConfirm',
    'user-create-mustChange',
    'user-create-description',
    'user-create-submit',
    'user-create-cancel'
  ]) {
    expect(w.find(`[data-test="${t}"]`).exists(), `expected field ${t}`).toBe(true);
  }
});

test('submit disabled until sam + matching password', async () => {
  const w = mountModal();
  const submit = () => w.find('[data-test="user-create-submit"]');
  // Empty form — disabled
  expect(submit().attributes('disabled')).toBeDefined();
  await w.find('[data-test="user-create-sam"]').setValue('alice');
  expect(submit().attributes('disabled')).toBeDefined(); // still no password
  await w.find('[data-test="user-create-password"]').setValue('P@ssw0rd');
  await w.find('[data-test="user-create-passwordConfirm"]').setValue('P@ssw0rd');
  expect(submit().attributes('disabled')).toBeUndefined();
});

test('submit posts user_create with sam + password + description in payload', async () => {
  const w = mountModal();
  await w.find('[data-test="user-create-sam"]').setValue('alice');
  await w.find('[data-test="user-create-password"]').setValue('P@ssw0rd');
  await w.find('[data-test="user-create-passwordConfirm"]').setValue('P@ssw0rd');
  await w.find('[data-test="user-create-description"]').setValue('Test user');
  await w.find('[data-test="user-create-submit"]').trigger('click');
  await flushPromises();
  await vi.runAllTimersAsync();
  expect(adAdminApi.queueCommand).toHaveBeenCalledWith(expect.objectContaining({
    targetDc: TARGET_DC,
    commandType: 'user_create',
    params: expect.objectContaining({
      sam: 'alice',
      password: 'P@ssw0rd',
      mustChangePassword: true,
      description: 'Test user'
    })
  }));
});

test('submit success renders result message and emits submitted', async () => {
  const w = mountModal();
  await w.find('[data-test="user-create-sam"]').setValue('alice');
  await w.find('[data-test="user-create-password"]').setValue('P@ssw0rd');
  await w.find('[data-test="user-create-passwordConfirm"]').setValue('P@ssw0rd');
  await w.find('[data-test="user-create-submit"]').trigger('click');
  await flushPromises();
  await vi.runAllTimersAsync();
  expect(w.find('[data-test="user-create-result"]').text()).toContain('已创建');
  expect(w.emitted('submitted')).toBeTruthy();
});

test('cancel emits close', async () => {
  const w = mountModal();
  await w.find('[data-test="user-create-cancel"]').trigger('click');
  expect(w.emitted('close')).toBeTruthy();
});

// Regression test for the deadline (setTimeout) leak that earlier R75 modals
// had: a `deadline = setTimeout(...)` that was never cleared on cancel/unmount.
// useCommandPolling owns the timer via onBeforeUnmount; this asserts the
// deadline timer was cleaned up on cancel by verifying no `timedOut` banner
// appears after advancing past the 30s deadline.
test('cancel before deadline cleans up setTimeout (no timedOut banner)', async () => {
  const w = mountModal();
  await w.find('[data-test="user-create-sam"]').setValue('alice');
  await w.find('[data-test="user-create-password"]').setValue('P@ssw0rd');
  await w.find('[data-test="user-create-passwordConfirm"]').setValue('P@ssw0rd');
  await w.find('[data-test="user-create-submit"]').trigger('click');
  await flushPromises();
  // Cancel mid-flight (before the 30s deadline).
  await w.find('[data-test="user-create-cancel"]').trigger('click');
  // Now advance past the 30s deadline — if useCommandPolling hadn't cleared
  // the deadlineTimer, `timedOut` would flip to true and the banner would show.
  await vi.advanceTimersByTimeAsync(31_000);
  expect(w.text()).not.toContain('命令执行超时');
  // Cancel still emits close.
  expect(w.emitted('close')).toBeTruthy();
});
