// 2026-08-31 R75 — frontend tests for UserAttributesModal.vue.
//
// Critical regression: spec §2.2 mandates `attributes` payload include
// `description` (alongside displayName/mail/telephoneNumber/title/
// department/manager). Earlier R75 frontend had description hoisted to
// top-level params, which the backend validator rejected — this test
// pins the fix.

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../../../src/api/ad-admin.js', () => ({
  adAdminApi: {
    queueCommand: vi.fn(),
    getCommand: vi.fn()
  }
}));

import UserAttributesModal from '../../../src/components/admin/UserAttributesModal.vue';
import { adAdminApi } from '../../../src/api/ad-admin.js';

const TARGET_DC = 'DC-BJ-01';
const SAM = 'alice';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  adAdminApi.queueCommand.mockResolvedValue({
    data: { id: 300, status: 'queued', targetDc: TARGET_DC, commandType: 'user_set_attributes' }
  });
  adAdminApi.getCommand.mockResolvedValue({
    data: { id: 300, status: 'success', result: { sam: SAM, updatedFields: ['displayName', 'description'] } }
  });
});

afterEach(() => { vi.useRealTimers(); });

function mountModal(props = {}) {
  return mount(UserAttributesModal, {
    props: { targetDc: TARGET_DC, sam: SAM, initial: {}, ...props }
  });
}

// Stub UserPickerMini — manager picker is exercised in its own test file.
const UserPickerMiniStub = {
  props: ['targetDc', 'initialSam'],
  emits: ['pick'],
  template: '<div data-test="user-picker-mini-stub" @click="$emit(\'pick\', { sam: \'bob\' })"></div>'
};

function mountModalWithStub(props = {}, stubs = { UserPickerMini: UserPickerMiniStub }) {
  return mount(UserAttributesModal, {
    props: { targetDc: TARGET_DC, sam: SAM, initial: {}, ...props },
    global: { stubs }
  });
}

test('renders all attribute fields including description', () => {
  const w = mountModal();
  for (const t of [
    'user-attributes-displayName',
    'user-attributes-upn',
    'user-attributes-givenName',
    'user-attributes-surname',
    'user-attributes-email',
    'user-attributes-telephoneNumber',
    'user-attributes-title',
    'user-attributes-department',
    'user-attributes-description',
    'user-attributes-submit',
    'user-attributes-cancel'
  ]) {
    expect(w.find(`[data-test="${t}"]`).exists(), `expected ${t}`).toBe(true);
  }
});

// REGRESSION TEST for BLOCKER #2 — description MUST be inside attributes,
// not at top-level params.
test('submit puts description inside attributes object (not top-level)', async () => {
  const w = mountModalWithStub();
  await w.find('[data-test="user-attributes-displayName"]').setValue('Alice Q');
  await w.find('[data-test="user-attributes-email"]').setValue('alice@contoso.local');
  await w.find('[data-test="user-attributes-telephoneNumber"]').setValue('555-0100');
  await w.find('[data-test="user-attributes-title"]').setValue('Eng');
  await w.find('[data-test="user-attributes-department"]').setValue('R&D');
  await w.find('[data-test="user-attributes-description"]').setValue('Test note');
  await w.find('[data-test="user-attributes-submit"]').trigger('click');
  await flushPromises();
  await vi.runAllTimersAsync();
  const call = adAdminApi.queueCommand.mock.calls.find(c => c[0].commandType === 'user_set_attributes');
  expect(call, 'user_set_attributes should have been queued').toBeTruthy();
  const params = call[0].params;
  // Spec §2.2: description lives under attributes.
  expect(params).not.toHaveProperty('description');
  expect(params.attributes).toBeDefined();
  expect(params.attributes.description).toBe('Test note');
  // Other attributes flow through unchanged.
  expect(params.attributes.displayName).toBe('Alice Q');
  expect(params.attributes.mail).toBe('alice@contoso.local');
  expect(params.attributes.telephoneNumber).toBe('555-0100');
  expect(params.attributes.title).toBe('Eng');
  expect(params.attributes.department).toBe('R&D');
});

test('submit omits description from attributes when blank (no empty string)', async () => {
  const w = mountModalWithStub();
  await w.find('[data-test="user-attributes-displayName"]').setValue('Alice Q');
  await w.find('[data-test="user-attributes-submit"]').trigger('click');
  await flushPromises();
  await vi.runAllTimersAsync();
  const call = adAdminApi.queueCommand.mock.calls.find(c => c[0].commandType === 'user_set_attributes');
  expect(call[0].params.attributes).not.toHaveProperty('description');
});

test('manager picker emit populates form.manager', async () => {
  const w = mountModalWithStub();
  await w.find('[data-test="user-picker-mini-stub"]').trigger('click');
  await flushPromises();
  await w.find('[data-test="user-attributes-submit"]').trigger('click');
  await flushPromises();
  await vi.runAllTimersAsync();
  const call = adAdminApi.queueCommand.mock.calls.find(c => c[0].commandType === 'user_set_attributes');
  expect(call[0].params.attributes.manager).toBe('bob');
});

test('submit success renders updated fields banner and emits submitted', async () => {
  const w = mountModalWithStub();
  await w.find('[data-test="user-attributes-displayName"]').setValue('Alice Q');
  await w.find('[data-test="user-attributes-submit"]').trigger('click');
  await flushPromises();
  await vi.runAllTimersAsync();
  expect(w.find('[data-test="user-attributes-result"]').text()).toContain('已更新');
  expect(w.emitted('submitted')).toBeTruthy();
});