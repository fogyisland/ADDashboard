import { mount, flushPromises } from '@vue/test-utils';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import OrphanSchemasView from '../src/views/admin/OrphanSchemasView.vue';

vi.mock('../src/api/admin.js', () => ({
  adminApi: {
    listOrphanSchemas: vi.fn().mockResolvedValue({ schemas: [
      { name: 'pkg_foo', last_seen_at: '2026-08-09T00:00:00Z', note: 'unit test' }
    ]}),
    dropOrphanSchema: vi.fn().mockResolvedValue({ ok: true })
  }
}));

vi.mock('../src/lib/notify.js', () => ({
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  notifySuccess: vi.fn()
}));

const AdminLayoutStub = { template: '<div><slot /></div>' };

function mountView() {
  return mount(OrphanSchemasView, {
    global: { stubs: { AdminLayout: AdminLayoutStub } }
  });
}

describe('OrphanSchemasView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    // Reset shared mocks so each test sees a clean slate. Module-level
    // vi.mock state persists across tests otherwise.
    vi.clearAllMocks();
  });

  it('lists orphan schemas from API', async () => {
    const wrapper = mountView();
    await flushPromises();
    expect(wrapper.text()).toContain('pkg_foo');
    expect(wrapper.text()).toContain('unit test');
  });

  it('shows confirm dialog on drop click, then calls dropOrphanSchema on confirm', async () => {
    const { adminApi } = await import('../src/api/admin.js');
    const wrapper = mountView();
    await flushPromises();

    // First click: opens the confirmation dialog, does NOT yet call the API.
    await wrapper.find('[data-test="drop"]').trigger('click');
    await flushPromises();
    expect(adminApi.dropOrphanSchema).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('确认手动 DROP pkg_foo?');

    // Second click on the confirm button in the dialog: invokes the API.
    const confirmBtn = wrapper.findAll('button').find(b => b.text() === '确认 DROP');
    expect(confirmBtn).toBeTruthy();
    await confirmBtn.trigger('click');
    await flushPromises();
    expect(adminApi.dropOrphanSchema).toHaveBeenCalledWith('pkg_foo');
  });

  it('notifies error when dropOrphanSchema rejects', async () => {
    const { adminApi } = await import('../src/api/admin.js');
    const { notifyError } = await import('../src/lib/notify.js');
    adminApi.dropOrphanSchema.mockRejectedValueOnce(new Error('FK constraint'));
    const wrapper = mountView();
    await flushPromises();

    await wrapper.find('[data-test="drop"]').trigger('click');
    await flushPromises();
    const confirmBtn = wrapper.findAll('button').find(b => b.text() === '确认 DROP');
    await confirmBtn.trigger('click');
    await flushPromises();

    expect(notifyError).toHaveBeenCalled();
    const msg = notifyError.mock.calls[0][0];
    expect(msg).toMatch(/DROP.*失败/);
    expect(msg).toContain('FK constraint');
  });

  it('notifies error when listOrphanSchemas rejects', async () => {
    const { adminApi } = await import('../src/api/admin.js');
    const { notifyError } = await import('../src/lib/notify.js');
    adminApi.listOrphanSchemas.mockRejectedValueOnce(new Error('network down'));
    const wrapper = mountView();
    await flushPromises();

    expect(notifyError).toHaveBeenCalled();
    const msg = notifyError.mock.calls[0][0];
    expect(msg).toContain('加载残留列表失败');
    expect(msg).toContain('network down');
  });
});
