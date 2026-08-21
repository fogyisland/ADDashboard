// SchemaInventoryView tests — drive the code-driven inventory flow.
// The view fetches `{ schemas: [{ name, tables: [{schema, name, source,
// codeRefs, expected, actual, diff, status}] }] }` and renders one row
// per referenced table, with a default-expanded detail row showing the
// expected vs actual column shape.

import { mount, flushPromises } from '@vue/test-utils';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import SchemaInventoryView from '../src/views/admin/SchemaInventoryView.vue';
import SchemaInventoryDetail from '../src/views/admin/SchemaInventoryDetail.vue';
import { adminApi } from '../src/api/admin.js';

vi.mock('../src/api/admin.js', () => ({
  adminApi: {
    getSchemaInventory: vi.fn()
  }
}));

vi.mock('../src/lib/notify.js', () => ({
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  notifySuccess: vi.fn()
}));

const AdminLayoutStub = { template: '<div><slot /></div>' };

function mountView() {
  return mount(SchemaInventoryView, {
    global: {
      stubs: { AdminLayout: AdminLayoutStub },
      components: { SchemaInventoryDetail }
    }
  });
}

describe('SchemaInventoryView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    adminApi.getSchemaInventory.mockReset();
  });

  it('shows loading state then renders schemas on success', async () => {
    adminApi.getSchemaInventory.mockResolvedValue({
      data: { schemas: [
        { name: 'pkg_ad_local_port_check', tables: [
          { schema: 'pkg_ad_local_port_check', name: 'metrics', source: 'package',
            codeRefs: ['a.js:1'],
            expected: [{ name: 'agent_id', type: 'varchar(64)', nullable: false }],
            actual:   [{ name: 'agent_id', type: 'varchar(64)', nullable: false, defaultValue: null }],
            diff: { missingColumns: [], extraColumns: [], typeMismatches: [] },
            status: 'in_sync' }
        ]},
        { name: 'addashboard', tables: [
          { schema: 'addashboard', name: 'ad_users', source: 'code',
            codeRefs: ['users.js:42', 'routes.js:7'],
            expected: [{ name: 'id', type: 'BIGINT', nullable: true }],
            actual:   [{ name: 'id', type: 'bigint', nullable: false, defaultValue: null }],
            diff: { missingColumns: [], extraColumns: [], typeMismatches: [] },
            status: 'in_sync' }
        ]}
      ]}
    });
    const wrapper = mountView();
    await flushPromises();
    expect(wrapper.text()).toContain('pkg_ad_local_port_check');
    expect(wrapper.text()).toContain('addashboard');
    expect(wrapper.text()).toContain('metrics');
    expect(wrapper.text()).toContain('ad_users');
    expect(wrapper.text()).toContain('在同步');
    // Stats line summarises the breakdown across all tables.
    expect(wrapper.text()).toContain('共 2 张');
  });

  it('shows drift badge and missing-column count when table has drift', async () => {
    adminApi.getSchemaInventory.mockResolvedValue({
      data: { schemas: [
        { name: 'pkg_ad_broken', tables: [
          { schema: 'pkg_ad_broken', name: 'metrics', source: 'package',
            codeRefs: ['a.js:1'],
            expected: [
              { name: 'agent_id', type: 'varchar(64)', nullable: false },
              { name: 'ts',       type: 'datetime',    nullable: false }
            ],
            actual:   [
              { name: 'agent_id', type: 'varchar(64)', nullable: false, defaultValue: null }
            ],
            diff: { missingColumns: [{ name: 'ts', expectedType: 'datetime' }],
                    extraColumns: [], typeMismatches: [] },
            status: 'drift' }
        ]}
      ]}
    });
    const wrapper = mountView();
    await flushPromises();
    expect(wrapper.text()).toContain('漂移');
    expect(wrapper.text()).toContain('缺列 1');
  });

  it('toggles collapse / re-expand via expand button (default expanded)', async () => {
    adminApi.getSchemaInventory.mockResolvedValue({
      data: { schemas: [
        { name: 'pkg_ad_test', tables: [
          { schema: 'pkg_ad_test', name: 'metrics', source: 'package',
            codeRefs: ['a.js:1'],
            expected: [{ name: 'agent_id', type: 'varchar(64)', nullable: false }],
            actual:   [{ name: 'agent_id', type: 'varchar(64)', nullable: false, defaultValue: null }],
            diff: { missingColumns: [], extraColumns: [], typeMismatches: [] },
            status: 'in_sync' }
        ]}
      ]}
    });
    const wrapper = mountView();
    await flushPromises();
    // Default: every row already expanded so the operator sees column shape up front.
    expect(wrapper.find('[data-test="cols-table"]').exists()).toBe(true);
    await wrapper.find('[data-test="expand-pkg_ad_test.metrics"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="cols-table"]').exists()).toBe(false);
    // Click again to re-expand.
    await wrapper.find('[data-test="expand-pkg_ad_test.metrics"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="cols-table"]').exists()).toBe(true);
  });

  it('renders system-schema tables when the code references them', async () => {
    adminApi.getSchemaInventory.mockResolvedValue({
      data: { schemas: [
        { name: 'addashboard', tables: [
          { schema: 'addashboard', name: 'ad_users', source: 'code',
            codeRefs: ['users.js:42'],
            expected: null,
            actual: [{ name: 'id', type: 'bigint', nullable: false, defaultValue: null }],
            diff: null,
            status: 'in_sync' }
        ]}
      ]}
    });
    const wrapper = mountView();
    await flushPromises();
    expect(wrapper.text()).toContain('ad_users');
    expect(wrapper.text()).toContain('id');
    expect(wrapper.text()).toContain('bigint');
  });

  it('shows empty state when code references no tables', async () => {
    adminApi.getSchemaInventory.mockResolvedValue({ data: { schemas: [] } });
    const wrapper = mountView();
    await flushPromises();
    expect(wrapper.text()).toContain('代码中没有引用任何 SQL 表');
  });

  it('calls notifyError on API failure', async () => {
    const { notifyError } = await import('../src/lib/notify.js');
    adminApi.getSchemaInventory.mockRejectedValueOnce(new Error('network down'));
    const wrapper = mountView();
    await flushPromises();
    expect(notifyError).toHaveBeenCalled();
    const msg = notifyError.mock.calls[0][0];
    expect(msg).toContain('加载 Schema 库存失败');
    expect(msg).toContain('network down');
  });

  it('refresh button reloads the inventory', async () => {
    adminApi.getSchemaInventory.mockResolvedValue({ data: { schemas: [] } });
    const wrapper = mountView();
    await flushPromises();
    expect(adminApi.getSchemaInventory).toHaveBeenCalledTimes(1);
    await wrapper.find('.refresh').trigger('click');
    await flushPromises();
    expect(adminApi.getSchemaInventory).toHaveBeenCalledTimes(2);
  });
});