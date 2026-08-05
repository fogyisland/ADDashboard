import { test, expect, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

import BulkImportDialog from '../src/components/BulkImportDialog.vue';

const columns = [
  { key: 'siteName', label: '站点名', required: true, aliases: ['site_name', '站点名'] },
  { key: 'regionCode', label: '区域', required: false, aliases: ['region_code'] }
];

test('BulkImportDialog renders file input and column hints', () => {
  const wrapper = mount(BulkImportDialog, {
    props: { title: '批量导入站点', columns, submit: vi.fn() }
  });
  const text = wrapper.text();
  expect(text).toContain('批量导入站点');
  expect(text).toContain('siteName');
  expect(text).toContain('regionCode');
  expect(text).toContain('site_name');
  expect(wrapper.find('input[type=file]').exists()).toBe(true);
});

test('BulkImportDialog confirm button disabled when no file parsed', () => {
  const wrapper = mount(BulkImportDialog, {
    props: { title: '批量导入站点', columns, submit: vi.fn() }
  });
  const btns = wrapper.findAll('button');
  const confirm = btns.find(b => b.text().includes('确认导入'));
  expect(confirm).toBeTruthy();
  expect(confirm.attributes('disabled')).toBeDefined();
});

test('BulkImportDialog emits close when cancel button clicked', async () => {
  const wrapper = mount(BulkImportDialog, {
    props: { title: 't', columns, submit: vi.fn() }
  });
  await wrapper.findAll('button').find(b => b.text() === '取消').trigger('click');
  expect(wrapper.emitted('close')).toBeTruthy();
});

test('BulkImportDialog emits close on backdrop click', async () => {
  const wrapper = mount(BulkImportDialog, {
    props: { title: 't', columns, submit: vi.fn() }
  });
  await wrapper.find('.modal-bg').trigger('click');
  expect(wrapper.emitted('close')).toBeTruthy();
});

test('BulkImportDialog rejects unsupported file extension', async () => {
  const wrapper = mount(BulkImportDialog, {
    props: { title: 't', columns, submit: vi.fn() }
  });
  const file = new File(['irrelevant'], 'bad.txt', { type: 'text/plain' });
  const input = wrapper.find('input[type=file]');
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
  await input.trigger('change');
  await flushPromises();
  const text = wrapper.text();
  expect(text).toContain('仅支持 .csv / .xlsx');
});