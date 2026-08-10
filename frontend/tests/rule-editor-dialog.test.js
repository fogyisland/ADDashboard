import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../src/api/admin.js', () => ({
  adminApi: {
    upsertAlertRule: vi.fn(() => Promise.resolve({ data: { ok: true } })),
    listAlertRules: vi.fn(() => Promise.resolve({ data: { items: [] } }))
  }
}));

import RuleEditorDialog from '../src/views/admin/RuleEditorDialog.vue';
import { adminApi } from '../src/api/admin.js';

beforeEach(() => {
  adminApi.upsertAlertRule.mockReset();
  adminApi.upsertAlertRule.mockResolvedValue({ data: { ok: true } });
});

const baseRule = {
  hostname: 'host-01',
  name: '',
  condition: null,
  for_minutes: 5,
  cooldown_minutes: 30,
  recipients: '',
  enabled: true
};

test('RuleEditorDialog renders rootOp and saves payload', async () => {
  const wrapper = mount(RuleEditorDialog, {
    props: { rule: { ...baseRule, hostname: 'host-01' } },
    global: { stubs: { RuleNodeEditor: true } }
  });
  await flushPromises();

  // Root seg AND/OR buttons both present
  const segs = wrapper.findAll('.seg button');
  const andBtn = segs.find((b) => b.text().includes('所有'));
  const orBtn = segs.find((b) => b.text().includes('任一'));
  expect(andBtn).toBeTruthy();
  expect(orBtn).toBeTruthy();

  // Fill in name and click save
  await wrapper.find('input[placeholder="CPU 持续高负载"]').setValue('CPU high');
  const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存') && !b.text().includes('保存中'));
  expect(saveBtn).toBeTruthy();
  await saveBtn.trigger('click');
  await flushPromises();

  // upsertAlertRule was called once with expected shape
  expect(adminApi.upsertAlertRule).toHaveBeenCalledTimes(1);
  const arg = adminApi.upsertAlertRule.mock.calls[0][0];
  expect(arg.hostname).toBe('host-01');
  expect(arg.name).toBe('CPU high');
  expect(arg.for_minutes).toBe(5);
  expect(arg.cooldown_minutes).toBe(30);
  expect(typeof arg.condition).toBe('string');
  const cond = JSON.parse(arg.condition);
  expect(['AND', 'OR']).toContain(cond.op);
  expect(Array.isArray(cond.children)).toBe(true);
  expect(cond.children.length).toBeGreaterThan(0);
});

test('adds + removes nested groups', async () => {
  const wrapper = mount(RuleEditorDialog, {
    props: { rule: { ...baseRule, hostname: 'host-01' } },
    global: { stubs: { RuleNodeEditor: false } }
  });
  await flushPromises();

  // Add a child group at the root level
  const addGroupBtn = wrapper.findAll('button').find((b) => b.text() === '+ 子组');
  expect(addGroupBtn).toBeTruthy();
  await addGroupBtn.trigger('click');
  await flushPromises();

  // Now we should have 2 children at root: 1 default leaf + 1 new group
  const rootAddButtons = wrapper.findAll('.children-block > .add-buttons');
  expect(rootAddButtons.length).toBe(1);

  // Save and verify the payload contains a nested group
  await wrapper.find('input[placeholder="CPU 持续高负载"]').setValue('Nested test');
  const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存') && !b.text().includes('保存中'));
  await saveBtn.trigger('click');
  await flushPromises();

  expect(adminApi.upsertAlertRule).toHaveBeenCalledTimes(1);
  const arg = adminApi.upsertAlertRule.mock.calls[0][0];
  const cond = JSON.parse(arg.condition);
  expect(cond.children.length).toBe(2);

  // The second child should be a group (has op AND/OR + nested children)
  const second = cond.children[1];
  expect(['AND', 'OR']).toContain(second.op);
  expect(Array.isArray(second.children)).toBe(true);
  expect(second.children.length).toBeGreaterThan(0);

  // Now remove the group via its × button. Group nodes have a `.group-head .remove` button.
  const groupRemoveBtns = wrapper.findAll('.group-head .remove');
  expect(groupRemoveBtns.length).toBe(1);
  await groupRemoveBtns[0].trigger('click');
  await flushPromises();

  // Re-save and verify the group is gone (back to 1 child)
  adminApi.upsertAlertRule.mockClear();
  const saveBtn2 = wrapper.findAll('button').find((b) => b.text().includes('保存') && !b.text().includes('保存中'));
  await saveBtn2.trigger('click');
  await flushPromises();
  const arg2 = adminApi.upsertAlertRule.mock.calls[0][0];
  const cond2 = JSON.parse(arg2.condition);
  expect(cond2.children.length).toBe(1);
  // The remaining child is the default leaf (no .op AND/OR)
  expect(cond2.children[0].metric).toBe('cpu_pct');
});