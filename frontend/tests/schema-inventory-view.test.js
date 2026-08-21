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
        { name: 'pkg_ad_local_port_check', source: 'package:ad-local-port-check/1.0.0',
          expected: [{ name: 'metrics', columns: [] }], actual: [{ name: 'metrics', columns: [] }],
          diff: { missingTables: [], extraTables: [], missingColumns: [], extraColumns: [], typeMismatches: [], status: 'in_sync' },
          status: 'in_sync' },
        { name: 'users', source: 'system', expected: null,
          actual: [{ name: 'users', columns: [{ name: 'id', type: 'int', nullable: false }] }],
          diff: null, status: 'system' }
      ]}
    });
    const wrapper = mountView();
    await flushPromises();
    expect(wrapper.text()).toContain('pkg_ad_local_port_check');
    expect(wrapper.text()).toContain('users');
    expect(wrapper.text()).toContain('在同步');
    expect(wrapper.text()).toContain('系统');
    // Stats line at the top summarises the breakdown.
    expect(wrapper.text()).toContain('共 2 个 schema');
    expect(wrapper.text()).toContain('在同步 1');
    expect(wrapper.text()).toContain('漂移 0');
    expect(wrapper.text()).toContain('系统 1');
  });

  it('shows drift badges and diff counts when schema has drift', async () => {
    adminApi.getSchemaInventory.mockResolvedValue({
      data: { schemas: [
        { name: 'pkg_ad_broken', source: 'package:ad-broken/1.0.0',
          expected: [{ name: 'metrics', columns: [{ name: 'agent_id', type: 'varchar(64)' }, { name: 'ts', type: 'datetime' }] }],
          actual: [{ name: 'metrics', columns: [{ name: 'agent_id', type: 'varchar(64)' }] }],
          diff: { missingTables: [], extraTables: [],
                  missingColumns: [{ table: 'metrics', name: 'ts', expectedType: 'datetime' }],
                  extraColumns: [], typeMismatches: [], status: 'drift' },
          status: 'drift' }
      ]}
    });
    const wrapper = mountView();
    await flushPromises();
    expect(wrapper.text()).toContain('漂移');
    expect(wrapper.text()).toContain('缺列 1');
  });

  it('expands detail row when expand button clicked', async () => {
    adminApi.getSchemaInventory.mockResolvedValue({
      data: { schemas: [
        { name: 'pkg_ad_test', source: 'package:ad-test/1.0.0',
          expected: [{ name: 'metrics', columns: [{ name: 'agent_id', type: 'varchar(64)' }] }],
          actual: [{ name: 'metrics', columns: [{ name: 'agent_id', type: 'varchar(64)' }] }],
          diff: { missingTables: [], extraTables: [], missingColumns: [], extraColumns: [], typeMismatches: [], status: 'in_sync' },
          status: 'in_sync' }
      ]}
    });
    const wrapper = mountView();
    await flushPromises();
    // Initially collapsed: detail row's diff-summary not visible.
    expect(wrapper.find('[data-test="diff-summary"]').exists()).toBe(false);
    await wrapper.find('[data-test="expand-pkg_ad_test"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="diff-summary"]').exists()).toBe(true);
    // Click again to collapse.
    await wrapper.find('[data-test="expand-pkg_ad_test"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="diff-summary"]').exists()).toBe(false);
  });

  it('renders system schema actual tables only, no expected', async () => {
    adminApi.getSchemaInventory.mockResolvedValue({
      data: { schemas: [
        { name: 'users', source: 'system', expected: null,
          actual: [{ name: 'users', columns: [{ name: 'id', type: 'int', nullable: false }] }],
          diff: null, status: 'system' }
      ]}
    });
    const wrapper = mountView();
    await flushPromises();
    await wrapper.find('[data-test="expand-users"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('实际表');
    expect(wrapper.text()).toContain('id');
  });

  it('shows empty state when DB has no schemas', async () => {
    adminApi.getSchemaInventory.mockResolvedValue({ data: { schemas: [] } });
    const wrapper = mountView();
    await flushPromises();
    expect(wrapper.text()).toContain('数据库中暂无 schemas');
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