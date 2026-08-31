// 2026-08-31 R75 — frontend tests for GroupCreateModal.vue.

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../../../src/api/ad-admin.js', () => ({
  adAdminApi: {
    queueCommand: vi.fn(),
    getCommand: vi.fn()
  }
}));

import GroupCreateModal from '../../../src/components/admin/GroupCreateModal.vue';
import { adAdminApi } from '../../../src/api/ad-admin.js';

const TARGET_DC = 'DC-BJ-01';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  adAdminApi.queueCommand.mockResolvedValue({
    data: { id: 600, status: 'queued', targetDc: TARGET_DC, commandType: 'group_create' }
  });
  adAdminApi.getCommand.mockResolvedValue({
    data: { id: 600, status: 'success', result: { name: 'Sales', dn: 'CN=Sales,OU=Groups,DC=contoso', created: true } }
  });
});

afterEach(() => { vi.useRealTimers(); });

function mountModal() {
  return mount(GroupCreateModal, { props: { targetDc: TARGET_DC } });
}

test('renders all expected form fields', () => {
  const w = mountModal();
  for (const t of [
    'group-create-name',
    'group-create-sam',
    'group-create-displayName',
    'group-create-mail',
    'group-create-ouPath',
    'group-create-description',
    'group-create-category-Security',
    'group-create-category-Distribution',
    'group-create-scope-DomainLocal',
    'group-create-scope-Global',
    'group-create-scope-Universal',
    'group-create-submit',
    'group-create-cancel'
  ]) {
    expect(w.find(`[data-test="${t}"]`).exists(), `expected ${t}`).toBe(true);
  }
});

test('submit disabled until name provided', async () => {
  const w = mountModal();
  const submit = () => w.find('[data-test="group-create-submit"]');
  expect(submit().attributes('disabled')).toBeDefined();
  await w.find('[data-test="group-create-name"]').setValue('Sales');
  expect(submit().attributes('disabled')).toBeUndefined();
});

test('submit posts group_create with required fields', async () => {
  const w = mountModal();
  await w.find('[data-test="group-create-name"]').setValue('Sales');
  await w.find('[data-test="group-create-description"]').setValue('Sales group');
  await w.find('[data-test="group-create-category-Security"]').setValue();
  await w.find('[data-test="group-create-submit"]').trigger('click');
  await flushPromises();
  await vi.runAllTimersAsync();
  expect(adAdminApi.queueCommand).toHaveBeenCalledWith(expect.objectContaining({
    targetDc: TARGET_DC,
    commandType: 'group_create',
    params: expect.objectContaining({
      name: 'Sales',
      description: 'Sales group',
      category: 'Security',
      scope: 'Global'
    })
  }));
});

test('submit success renders 已创建 banner and emits submitted', async () => {
  const w = mountModal();
  await w.find('[data-test="group-create-name"]').setValue('Sales');
  await w.find('[data-test="group-create-submit"]').trigger('click');
  await flushPromises();
  await vi.runAllTimersAsync();
  expect(w.find('[data-test="group-create-result"]').text()).toContain('已创建');
  expect(w.emitted('submitted')).toBeTruthy();
});

test('cancel emits close', async () => {
  const w = mountModal();
  await w.find('[data-test="group-create-cancel"]').trigger('click');
  expect(w.emitted('close')).toBeTruthy();
});