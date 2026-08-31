// 2026-08-31 R75 — frontend tests for GroupPropertiesModal.vue.

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../../../src/api/ad-admin.js', () => ({
  adAdminApi: {
    queueCommand: vi.fn(),
    getCommand: vi.fn()
  }
}));

import GroupPropertiesModal from '../../../src/components/admin/GroupPropertiesModal.vue';
import { adAdminApi } from '../../../src/api/ad-admin.js';

const TARGET_DC = 'DC-BJ-01';
const NAME = 'Sales';

const UserPickerMiniStub = {
  props: ['targetDc', 'initialSam'],
  emits: ['pick'],
  template: '<div data-test="user-picker-mini-stub" @click="$emit(\'pick\', { sam: \'bob\' })" />'
};

beforeEach(() => {
  vi.useFakeTimers();
  adAdminApi.queueCommand.mockResolvedValue({
    data: { id: 700, status: 'queued', targetDc: TARGET_DC, commandType: 'group_set_attributes' }
  });
  adAdminApi.getCommand.mockResolvedValue({
    data: { id: 700, status: 'success', result: { name: NAME, updatedFields: ['description', 'mail'] } }
  });
});

afterEach(() => { vi.useRealTimers(); });

function mountModal(props = {}) {
  return mount(GroupPropertiesModal, {
    props: { targetDc: TARGET_DC, name: NAME, initial: {}, ...props },
    global: { stubs: { UserPickerMini: UserPickerMiniStub } }
  });
}

test('renders all expected fields', () => {
  const w = mountModal();
  for (const t of [
    'group-properties-displayName',
    'group-properties-mail',
    'group-properties-description',
    'group-properties-info',
    'group-properties-category-Security',
    'group-properties-category-Distribution',
    'group-properties-scope-DomainLocal',
    'group-properties-scope-Global',
    'group-properties-scope-Universal',
    'group-properties-submit',
    'group-properties-cancel'
  ]) {
    expect(w.find(`[data-test="${t}"]`).exists(), `expected ${t}`).toBe(true);
  }
});

test('submit posts group_set_attributes with attributes object', async () => {
  const w = mountModal();
  await w.find('[data-test="group-properties-displayName"]').setValue('Sales Team');
  await w.find('[data-test="group-properties-description"]').setValue('Updated desc');
  await w.find('[data-test="group-properties-mail"]').setValue('sales@contoso.local');
  await w.find('[data-test="group-properties-submit"]').trigger('click');
  await flushPromises();
  await vi.runAllTimersAsync();
  expect(adAdminApi.queueCommand).toHaveBeenCalledWith(expect.objectContaining({
    targetDc: TARGET_DC,
    commandType: 'group_set_attributes',
    params: expect.objectContaining({
      name: NAME,
      attributes: expect.objectContaining({
        displayName: 'Sales Team',
        description: 'Updated desc',
        mail: 'sales@contoso.local',
        category: 'Security',
        scope: 'Global'
      })
    })
  }));
});

test('managedBy picker populates attributes.managedBy', async () => {
  const w = mountModal();
  await w.find('[data-test="user-picker-mini-stub"]').trigger('click');
  await flushPromises();
  await w.find('[data-test="group-properties-submit"]').trigger('click');
  await flushPromises();
  await vi.runAllTimersAsync();
  const call = adAdminApi.queueCommand.mock.calls.find(c => c[0].commandType === 'group_set_attributes');
  expect(call[0].params.attributes.managedBy).toBe('bob');
});

test('submit success renders 已更新 banner and emits submitted', async () => {
  const w = mountModal();
  await w.find('[data-test="group-properties-submit"]').trigger('click');
  await flushPromises();
  await vi.runAllTimersAsync();
  expect(w.find('[data-test="group-properties-result"]').text()).toContain('已更新');
  expect(w.emitted('submitted')).toBeTruthy();
});

test('cancel emits close', async () => {
  const w = mountModal();
  await w.find('[data-test="group-properties-cancel"]').trigger('click');
  expect(w.emitted('close')).toBeTruthy();
});