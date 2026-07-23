import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../src/api/ports.js', () => ({
  portsApi: {
    list:   vi.fn(() => Promise.resolve({ data: [] })),
    create: vi.fn(() => Promise.resolve({ data: { id: 99 } })),
    update: vi.fn(() => Promise.resolve({ data: { ok: true } })),
    remove: vi.fn(() => Promise.resolve({ data: { ok: true } }))
  }
}));

import PortsView from '../src/views/admin/PortsView.vue';
import { portsApi } from '../src/api/ports.js';

beforeEach(() => {
  portsApi.list.mockReset();
  portsApi.create.mockReset();
  portsApi.update.mockReset();
  portsApi.remove.mockReset();
});

test('PortsView lists rows from portsApi.list', async () => {
  portsApi.list.mockResolvedValue({
    data: [
      { id: 1, port: 135,   label: 'RPC', sortOrder: 0 },
      { id: 2, port: 50001, label: 'KRB', sortOrder: 1 }
    ]
  });
  const wrapper = mount(PortsView, {
    global: { stubs: { AppLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  const text = wrapper.text();
  expect(text).toContain('135');
  expect(text).toContain('RPC');
  expect(text).toContain('50001');
  expect(text).toContain('KRB');
});

test('PortsView create flow calls portsApi.create and reloads', async () => {
  portsApi.list.mockResolvedValue({ data: [] });
  portsApi.create.mockResolvedValue({ data: { id: 99 } });

  const wrapper = mount(PortsView, {
    global: { stubs: { AppLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();

  // Open the create modal.
  await wrapper.get('button.new-btn').trigger('click');
  await flushPromises();

  // Fill the form (modal mode = create: form.id is null).
  const inputs = wrapper.findAll('input');
  await inputs[0].setValue(389);          // port
  await inputs[1].setValue('LDAP');       // label
  await inputs[2].setValue(2);            // sortOrder
  await wrapper.get('button.save-btn').trigger('click');
  await flushPromises();

  expect(portsApi.create).toHaveBeenCalledWith({ port: 389, label: 'LDAP', sortOrder: 2 });
  expect(portsApi.list).toHaveBeenCalledTimes(2);   // initial + reload after create
});

test('PortsView edit flow calls portsApi.update and reloads', async () => {
  portsApi.list.mockResolvedValue({
    data: [{ id: 7, port: 88, label: 'old', sortOrder: 0 }]
  });
  portsApi.update.mockResolvedValue({ data: { ok: true } });

  const wrapper = mount(PortsView, {
    global: { stubs: { AppLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();

  // Click the edit button on the first row.
  await wrapper.get('button.edit-btn').trigger('click');
  await flushPromises();

  // Modal title should be 编辑 (edit mode).
  expect(wrapper.text()).toContain('编辑');
  // Re-label and save.
  const inputs = wrapper.findAll('input');
  await inputs[1].setValue('new-label');
  await wrapper.get('button.save-btn').trigger('click');
  await flushPromises();

  expect(portsApi.update).toHaveBeenCalledWith(7, { port: 88, label: 'new-label', sortOrder: 0 });
  expect(portsApi.create).not.toHaveBeenCalled();
});

test('PortsView delete flow calls portsApi.remove after confirm', async () => {
  portsApi.list.mockResolvedValue({
    data: [{ id: 11, port: 636, label: 'LDAPS', sortOrder: 0 }]
  });
  portsApi.remove.mockResolvedValue({ data: { ok: true } });
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

  const wrapper = mount(PortsView, {
    global: { stubs: { AppLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();

  await wrapper.get('button.del-btn').trigger('click');
  await flushPromises();

  expect(confirmSpy).toHaveBeenCalled();
  expect(portsApi.remove).toHaveBeenCalledWith(11);
});

test('PortsView save error surfaces server message and does not close modal', async () => {
  portsApi.list.mockResolvedValue({ data: [] });
  portsApi.create.mockRejectedValue({
    response: { data: { error: '端口 999 已被占用' } }
  });

  const wrapper = mount(PortsView, {
    global: { stubs: { AppLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();

  await wrapper.get('button.new-btn').trigger('click');
  await flushPromises();

  const inputs = wrapper.findAll('input');
  await inputs[0].setValue(999);
  await inputs[1].setValue('dup');
  await wrapper.get('button.save-btn').trigger('click');
  await flushPromises();

  expect(wrapper.text()).toContain('端口 999 已被占用');
  // Modal still open (editing truthy).
  expect(wrapper.find('.modal').exists()).toBe(true);
});