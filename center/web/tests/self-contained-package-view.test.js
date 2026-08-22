import { mount } from '@vue/test-utils';
import { describe, it, expect, vi } from 'vitest';
import PackageDdlPreviewModal from '../src/components/PackageDdlPreviewModal.vue';
import UninstallSchemaConfirmModal from '../src/components/UninstallSchemaConfirmModal.vue';

describe('PackageDdlPreviewModal', () => {
  it('renders schemaName and each file content', () => {
    const wrapper = mount(PackageDdlPreviewModal, {
      props: {
        visible: true,
        schemaName: 'pkg_test',
        files: [
          { path: 'migrations/001.sql', filename: '001.sql', content: 'CREATE TABLE x (id INT)' },
          { path: 'migrations/002.sql', filename: '002.sql', content: 'ALTER TABLE x ADD COLUMN y INT' }
        ]
      }
    });
    expect(wrapper.text()).toContain('pkg_test');
    expect(wrapper.text()).toContain('001.sql');
    expect(wrapper.text()).toContain('CREATE TABLE x');
  });

  it('emits close when X clicked', async () => {
    const wrapper = mount(PackageDdlPreviewModal, { props: { visible: true, schemaName: 'x', files: [] } });
    await wrapper.find('[data-test=close]').trigger('click');
    expect(wrapper.emitted('close')).toBeTruthy();
  });
});

describe('UninstallSchemaConfirmModal', () => {
  it('disables confirm button until checkbox checked', async () => {
    const wrapper = mount(UninstallSchemaConfirmModal, {
      props: { visible: true, packageName: 'ad-foo', schemaName: 'pkg_foo', metricRowCount: 0 }
    });
    expect(wrapper.find('[data-test=confirm]').attributes('disabled')).toBeDefined();
    await wrapper.find('[data-test=confirm-checkbox]').setValue(true);
    expect(wrapper.find('[data-test=confirm]').attributes('disabled')).toBeUndefined();
  });

  it('emits confirm with payload on click', async () => {
    const wrapper = mount(UninstallSchemaConfirmModal, {
      props: { visible: true, packageName: 'ad-foo', schemaName: 'pkg_foo', metricRowCount: 5 }
    });
    await wrapper.find('[data-test=confirm-checkbox]').setValue(true);
    await wrapper.find('[data-test=confirm]').trigger('click');
    expect(wrapper.emitted('confirm')).toBeTruthy();
    expect(wrapper.emitted('confirm')[0][0]).toEqual({ confirmDropSchema: true });
  });
});
