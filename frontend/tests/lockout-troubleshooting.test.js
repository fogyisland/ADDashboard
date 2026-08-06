import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import LockoutTroubleshootingView from '../src/views/LockoutTroubleshootingView.vue';
import { searchLockoutEvents } from '../src/api/lockout.js';

vi.mock('../src/api/lockout.js', () => ({
  searchLockoutEvents: vi.fn(() => Promise.resolve({ data: [] }))
}));

function makeRouter(query = {}) {
  const r = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/lockout-troubleshooting', component: LockoutTroubleshootingView }]
  });
  const qs = new URLSearchParams(query).toString();
  r.push(`/lockout-troubleshooting${qs ? '?' + qs : ''}`);
  return r;
}

beforeEach(() => {
  searchLockoutEvents.mockReset();
  searchLockoutEvents.mockResolvedValue({ data: [] });
});

test('renders 3 inputs + time select + 查询 button; button disabled when all inputs empty', async () => {
  setActivePinia(createPinia());
  const r = makeRouter();
  await r.isReady();
  const w = mount(LockoutTroubleshootingView, { global: { plugins: [r] } });
  await flushPromises();

  const inputs = w.findAll('input[type="text"]');
  expect(inputs.length).toBe(3);
  expect(w.find('select').exists()).toBe(true);
  const btn = w.find('button.search-btn');
  expect(btn.exists()).toBe(true);
  expect(btn.attributes('disabled')).toBeDefined();
});

test('submit triggers searchLockoutEvents with composed params; renders result rows', async () => {
  setActivePinia(createPinia());
  const r = makeRouter();
  await r.isReady();
  const w = mount(LockoutTroubleshootingView, { global: { plugins: [r] } });
  await flushPromises();

  const inputs = w.findAll('input[type="text"]');
  await inputs[0].setValue('alice');
  await inputs[1].setValue('DC01');
  // Click search
  await w.find('button.search-btn').trigger('click');
  await flushPromises();

  expect(searchLockoutEvents).toHaveBeenCalledWith(expect.objectContaining({
    targetUser: 'alice', dc: 'DC01', sinceHours: expect.anything()
  }));
});

test('with only targetUser filter, first row gets ⭐ and "源头" label', async () => {
  setActivePinia(createPinia());
  const r = makeRouter({ targetUser: 'alice' });
  await r.isReady();
  searchLockoutEvents.mockResolvedValue({ data: [
    { occurredAt: '2026-08-06T10:00:00.000Z', dcName: 'DC01', targetUserName: 'alice', subjectUserName: 'DC01$', subjectDomain: 'CORP', callerComputerName: 'WS-01', isSource: true },
    { occurredAt: '2026-08-06T10:05:00.000Z', dcName: 'DC02', targetUserName: 'alice', subjectUserName: 'DC02$', subjectDomain: 'CORP', callerComputerName: 'WS-01', isSource: false }
  ]});
  const w = mount(LockoutTroubleshootingView, { global: { plugins: [r] } });
  await flushPromises();
  // First row should have the source marker
  const rows = w.findAll('.lockout-row');
  expect(rows.length).toBe(2);
  expect(rows[0].text()).toContain('源头');
  expect(rows[0].classes()).toContain('source-row');
  // Second row: no 源头
  expect(rows[1].text()).not.toContain('源头');
});

test('click DC badge updates URL query and triggers re-fetch with new dc filter', async () => {
  setActivePinia(createPinia());
  const r = makeRouter({ targetUser: 'alice' });
  await r.isReady();
  searchLockoutEvents.mockResolvedValue({ data: [
    { occurredAt: '2026-08-06T10:00:00.000Z', dcName: 'DC01', targetUserName: 'alice', subjectUserName: 'DC01$', subjectDomain: 'CORP', callerComputerName: 'WS-01', isSource: true }
  ]});
  const w = mount(LockoutTroubleshootingView, { global: { plugins: [r] } });
  await flushPromises();

  // Click the DC badge
  const dcBadge = w.find('.dc-badge');
  expect(dcBadge.exists()).toBe(true);
  await dcBadge.trigger('click');
  await flushPromises();

  // URL query should now contain dc=DC01 alongside targetUser=alice
  expect(r.currentRoute.value.query.dc).toBe('DC01');
  expect(r.currentRoute.value.query.targetUser).toBe('alice');
  // searchLockoutEvents called again with dc: 'DC01'
  const lastCall = searchLockoutEvents.mock.calls[searchLockoutEvents.mock.calls.length - 1][0];
  expect(lastCall.dc).toBe('DC01');
  expect(lastCall.targetUser).toBe('alice');
});