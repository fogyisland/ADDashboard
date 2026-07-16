import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../src/api/admin.js', () => ({
  adminApi: {
    listUsers: vi.fn(() => Promise.resolve({ data: [] })),
    createUser: vi.fn(() => Promise.resolve({ data: {} })),
    updateUser: vi.fn(() => Promise.resolve({ data: {} })),
    deleteUser: vi.fn(() => Promise.resolve({ data: {} })),
    listRoles: vi.fn(() => Promise.resolve({ data: [] })),
    getConfig: vi.fn(() => Promise.resolve({ data: {} })),
    updateConfig: vi.fn(() => Promise.resolve({ data: {} })),
    getAudit: vi.fn(() => Promise.resolve({ data: [] }))
  }
}));

import UsersView from '../src/views/admin/UsersView.vue';
import { adminApi } from '../src/api/admin.js';

function makeUsers() {
  return [
    { id: 1, username: 'alice', role_name: 'admin', status: 1, last_login_at: '2026-07-10T08:00:00Z' },
    { id: 2, username: 'bob', role_name: 'viewer', status: 0, last_login_at: null }
  ];
}

function makeRoles() {
  return [
    { id: 1, roleName: 'admin', permissions: ['admin:users'] },
    { id: 2, roleName: 'viewer', permissions: ['dashboard:read'] }
  ];
}

beforeEach(() => {
  setActivePinia(createPinia());
  adminApi.listUsers.mockReset();
  adminApi.createUser.mockReset();
  adminApi.updateUser.mockReset();
  adminApi.deleteUser.mockReset();
  adminApi.listRoles.mockReset();
});

async function mountWith(users, roles) {
  adminApi.listUsers.mockResolvedValue({ data: users });
  adminApi.listRoles.mockResolvedValue({ data: roles });
  const wrapper = mount(UsersView, {
    global: {
      stubs: {
        AppLayout: { template: '<div><slot /></div>' }
      }
    }
  });
  await flushPromises();
  return wrapper;
}

test('UsersView edit flow: clicking 编辑 then 保存 calls updateUser with { roleId, status } (camelCase, NOT role_id)', async () => {
  const wrapper = await mountWith(makeUsers(), makeRoles());
  // Click the 编辑 button for user 1 (alice, admin role)
  const editButtons = wrapper.findAll('button');
  // Buttons in row: 编辑, 删除. Row 0: 编辑 (click), 删除
  const firstEdit = editButtons.find(b => b.text() === '编辑');
  expect(firstEdit).toBeTruthy();
  await firstEdit.trigger('click');
  await flushPromises();

  // Modal should now be open. Click 保存.
  const allButtons = wrapper.findAll('button');
  const saveBtn = allButtons.find(b => b.text() === '保存');
  expect(saveBtn).toBeTruthy();
  await saveBtn.trigger('click');
  await flushPromises();

  expect(adminApi.updateUser).toHaveBeenCalledTimes(1);
  const [userId, body] = adminApi.updateUser.mock.calls[0];
  expect(userId).toBe(1);
  // Must be camelCase roleId, NOT snake_case role_id
  expect(body).toHaveProperty('roleId');
  expect(body).toHaveProperty('status');
  expect(body).not.toHaveProperty('role_id');
});

test('UsersView create flow: clicking + 新建, filling, then 保存 calls createUser with object containing roleId (NOT role_id)', async () => {
  const wrapper = await mountWith([], makeRoles());

  const allButtons = wrapper.findAll('button');
  const newBtn = allButtons.find(b => b.text() === '+ 新建');
  expect(newBtn).toBeTruthy();
  await newBtn.trigger('click');
  await flushPromises();

  // Set username and password via setValue
  const inputs = wrapper.findAll('input');
  // First input: username (in modal), Second input: password
  await inputs[0].setValue('newuser');
  await inputs[1].setValue('pw1234');
  await flushPromises();

  // Click 保存
  const buttonsNow = wrapper.findAll('button');
  const saveBtn = buttonsNow.find(b => b.text() === '保存');
  await saveBtn.trigger('click');
  await flushPromises();

  expect(adminApi.createUser).toHaveBeenCalledTimes(1);
  const sent = adminApi.createUser.mock.calls[0][0];
  expect(sent).toHaveProperty('username', 'newuser');
  expect(sent).toHaveProperty('password', 'pw1234');
  // Bug 2: must use camelCase roleId, NOT snake_case role_id
  expect(sent).toHaveProperty('roleId');
  expect(sent).not.toHaveProperty('role_id');
});

test('UsersView delete flow: clicking 删除 and confirming calls deleteUser with user id', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const wrapper = await mountWith(makeUsers(), makeRoles());

  const allButtons = wrapper.findAll('button');
  // Find a 删除 button (row 0 has [编辑, 删除])
  const delBtn = allButtons.find(b => b.text() === '删除');
  expect(delBtn).toBeTruthy();
  await delBtn.trigger('click');
  await flushPromises();

  expect(confirmSpy).toHaveBeenCalled();
  expect(adminApi.deleteUser).toHaveBeenCalledTimes(1);
  expect(adminApi.deleteUser).toHaveBeenCalledWith(1);

  confirmSpy.mockRestore();
});