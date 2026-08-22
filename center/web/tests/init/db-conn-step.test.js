import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import DbConnStep from '../../src/views/init/DbConnStep.vue';
import { useInitStore } from '../../src/stores/init.js';

describe('DbConnStep', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it('renders dialect picker', () => {
    const w = mount(DbConnStep);
    expect(w.text()).toMatch(/MySQL|SQL Server|数据库/);
  });

  it('shows mysql fields after picking mysql', async () => {
    const w = mount(DbConnStep);
    await w.findAll('input[type="radio"]')[0].setValue();
    await w.findAll('input[type="radio"]')[0].trigger('change');
    // After click on mysql card, mysql-specific fields should appear
    await w.vm.$nextTick();
    expect(w.text()).toMatch(/host|主机/);
  });

  it('test connection button disabled when no dialect picked', () => {
    const w = mount(DbConnStep);
    const btn = w.findAll('button').find(b => /测试|test/i.test(b.text()));
    expect(btn?.attributes('disabled')).toBeDefined();
  });

  it('test connection button enabled after dialect + db name filled', async () => {
    const s = useInitStore();
    s.setDialect('mysql');
    s.setConnParams({ database: 'ad_test' });
    const w = mount(DbConnStep);
    const btn = w.findAll('button').find(b => /测试|test/i.test(b.text()));
    expect(btn?.attributes('disabled')).toBeUndefined();
  });
});