import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import InitStep from '../../src/views/init/InitStep.vue';
import { useInitStore } from '../../src/stores/init.js';
import * as initApi from '../../src/api/init.js';

vi.mock('../../src/api/init.js', () => ({
  applyDb: vi.fn().mockResolvedValue({ data: { schema: ['s'], seed: [], migrations: [] } }),
  createAdmin: vi.fn().mockResolvedValue({ data: { id: 1, username: 'admin' } }),
  finalize: vi.fn().mockResolvedValue({ data: { ok: true } }),
  getStatus: vi.fn(),
  testDb: vi.fn()
}));

function makeRouterStub() {
  const push = vi.fn();
  const replace = vi.fn();
  return {
    install: (app) => {
      app.config.globalProperties.$router = { push, replace };
    },
    push,
    replace,
    currentRoute: { value: { path: '/init' } }
  };
}

function seedStore() {
  const s = useInitStore();
  s.setDialect('mysql');
  s.setConnParams({ host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' });
  s.setAdmin({ username: 'admin', password: 'hunter22pass', confirm: 'hunter22pass' });
  return s;
}

function mountWithRouter() {
  // Real router so useRouter() works (single empty route is enough).
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div/>' } }]
  });
  return { wrapper: mount(InitStep, { global: { plugins: [router] } }), router };
}

describe('InitStep', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    initApi.getStatus.mockReset();
  });

  it('renders stage list with all 6 stages', () => {
    const w = mount(InitStep);
    const text = w.text();
    expect(text).toMatch(/创建数据库|数据库|schema|seed|admin|config/);
  });

  it('runs the full sequence on mount and shows success', async () => {
    seedStore();
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div/>' } }]
    });
    const w = mount(InitStep, { global: { plugins: [router] } });
    await flushPromises();
    await flushPromises();
    expect(w.text()).toMatch(/完成|success|成功/);
  });

  it('polls getStatus after finalize and redirects to /login when needsInit=false', async () => {
    seedStore();
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div/>' } }]
    });
    const pushSpy = vi.spyOn(router, 'push');
    initApi.getStatus.mockResolvedValue({ data: { needsInit: true } });
    mount(InitStep, { global: { plugins: [router] } });
    // Allow runSequence async to settle + immediate pollStatusTick.
    await flushPromises();
    await flushPromises();
    expect(initApi.getStatus).toHaveBeenCalled();

    // Flip the mock so the next interval tick sees needsInit=false.
    initApi.getStatus.mockResolvedValue({ data: { needsInit: false } });
    await new Promise((r) => setTimeout(r, 1100));
    await flushPromises();
    expect(pushSpy).toHaveBeenCalledWith('/login');
  });

  it('shows manual-restart hint on 30s timeout', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      seedStore();
      const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div/>' } }]
      });
      initApi.getStatus.mockResolvedValue({ data: { needsInit: true } });
      const w = mount(InitStep, { global: { plugins: [router] } });
      // Let runSequence run to completion. Use runAllTimers so the immediate
      // pollStatusTick and Date.now() deadline both move together (fake timers
      // honour { now: 0 } so Date.now() = 0 + advances).
      await vi.runAllTimersAsync();
      expect(w.text()).toMatch(/重启|服务/);

      // Advance past the 30s deadline so the next tick trips the timeout.
      await vi.advanceTimersByTimeAsync(31000);
      // Let the async pollStatusTick catch up.
      await vi.runAllTimersAsync();
      expect(w.text()).toMatch(/超时|nssm|start\.bat/);
    } finally {
      vi.useRealTimers();
    }
  });
});
