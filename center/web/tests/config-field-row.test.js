import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ConfigFieldRow from '../src/views/admin/ConfigFieldRow.vue';

test('renders label, input, description', () => {
  const w = mount(ConfigFieldRow, { props: { value: '5', description: 'foo' } });
  expect(w.find('input').exists()).toBe(true);
  expect(w.find('input').element.value).toBe('5');
  expect(w.text()).toContain('foo');
});

test('emits update:value on input', async () => {
  const w = mount(ConfigFieldRow, { props: { value: '5' } });
  await w.find('input').setValue('10');
  expect(w.emitted('update:value')[0]).toEqual(['10']);
});

test('shows error message and applies error class when error prop is non-empty', () => {
  const w = mount(ConfigFieldRow, { props: { value: '5', error: 'must be 1-10' } });
  expect(w.text()).toContain('must be 1-10');
  expect(w.find('input').classes()).toContain('has-error');
});

test('no error class when error prop is empty', () => {
  const w = mount(ConfigFieldRow, { props: { value: '5', error: '' } });
  expect(w.find('input').classes()).not.toContain('has-error');
});

test('uses number input when type=number', () => {
  const w = mount(ConfigFieldRow, { props: { value: '5', type: 'number' } });
  expect(w.find('input').attributes('type')).toBe('number');
});
