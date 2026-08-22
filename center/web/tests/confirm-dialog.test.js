import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ConfirmDialog from '../src/views/admin/ConfirmDialog.vue';

test('renders title and body when shown', () => {
  const w = mount(ConfirmDialog, { props: { title: 'Are you sure?', body: 'This affects X.' } });
  expect(w.text()).toContain('Are you sure?');
  expect(w.text()).toContain('This affects X.');
});

test('emits confirm on confirm click', async () => {
  const w = mount(ConfirmDialog, { props: { title: 't', body: 'b' } });
  await w.find('button.confirm').trigger('click');
  expect(w.emitted('confirm')).toBeTruthy();
});

test('emits cancel on cancel click', async () => {
  const w = mount(ConfirmDialog, { props: { title: 't', body: 'b' } });
  await w.find('button.cancel').trigger('click');
  expect(w.emitted('cancel')).toBeTruthy();
});

test('emits cancel on backdrop click', async () => {
  const w = mount(ConfirmDialog, { props: { title: 't', body: 'b' } });
  await w.find('.backdrop').trigger('click');
  expect(w.emitted('cancel')).toBeTruthy();
});

test('uses default labels when not provided', () => {
  const w = mount(ConfirmDialog, { props: { title: 't', body: 'b' } });
  expect(w.find('button.confirm').text()).toBe('确认');
  expect(w.find('button.cancel').text()).toBe('取消');
});

test('applies danger class on confirm button when danger=true', () => {
  const w = mount(ConfirmDialog, { props: { title: 't', body: 'b', danger: true } });
  expect(w.find('button.confirm').classes()).toContain('danger');
});