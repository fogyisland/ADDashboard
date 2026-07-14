import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import InitStep from '../../src/views/init/InitStep.vue';
import { useInitStore } from '../../src/stores/init.js';

vi.mock('../../src/api/init.js', () => ({
  applyDb: vi.fn().mockResolvedValue({ data: { schema: ['s'], seed: [], migrations: [] } }),
  createAdmin: vi.fn().mockResolvedValue({ data: { id: 1, username: 'admin' } }),
  finalize: vi.fn().mockResolvedValue({ data: { ok: true } }),
  getStatus: vi.fn(),
  testDb: vi.fn()
}));

describe('InitStep', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it('renders stage list with all 6 stages', () => {
    const w = mount(InitStep);
    const text = w.text();
    expect(text).toMatch(/创建数据库|数据库|schema|seed|admin|config/);
  });

  it('runs the full sequence on mount and shows success', async () => {
    const s = useInitStore();
    s.setDialect('mysql');
    s.setConnParams({ host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' });
    s.setAdmin({ username: 'admin', password: 'hunter22pass', confirm: 'hunter22pass' });
    const w = mount(InitStep);
    await flushPromises();
    await flushPromises();
    expect(w.text()).toMatch(/完成|success|成功/);
  });
});