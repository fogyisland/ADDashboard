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

const AdminLayoutStub = { template: '<div><slot /></div>' };

function mountView() {
  return mount(OrphanSchemasView, {
    global: { stubs: { AdminLayout: AdminLayoutStub } }
  });
}

describe('OrphanSchemasView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    // jsdom's window.confirm throws "Not implemented" by default — stub it
    // so the drop handler does not short-circuit.
    globalThis.confirm = vi.fn(() => true);
  });

  it('lists orphan schemas from API', async () => {
    const wrapper = mountView();
    await flushPromises();
    expect(wrapper.text()).toContain('pkg_foo');
    expect(wrapper.text()).toContain('unit test');
  });

  it('calls dropOrphanSchema on click', async () => {
    const { adminApi } = await import('../src/api/admin.js');
    const wrapper = mountView();
    await flushPromises();
    await wrapper.find('[data-test="drop"]').trigger('click');
    await flushPromises();
    expect(adminApi.dropOrphanSchema).toHaveBeenCalledWith('pkg_foo');
  });
});
