import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('../src/api/client.js', () => ({
  default: { get: getMock }
}));

import StatusBar from '../src/components/StatusBar.vue';

beforeEach(() => {
  getMock.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('StatusBar mounts and fetches /api/dashboard/overview once', async () => {
  getMock.mockResolvedValueOnce({ data: { totalLinks: 10, healthy: 10, warning: 0, error: 0, lastUpdate: null, agentCount: 3 } });
  const wrapper = mount(StatusBar);
  await flushPromises();
  expect(getMock).toHaveBeenCalledTimes(1);
  expect(getMock).toHaveBeenCalledWith('/api/dashboard/overview');
});

test('healthRate computes healthy/totalLinks*100 (defaults to 100 when total=0)', async () => {
  getMock.mockResolvedValueOnce({ data: { totalLinks: 0, healthy: 0, warning: 0, error: 0, lastUpdate: null, agentCount: 0 } });
  const wrapper = mount(StatusBar);
  await flushPromises();
  expect(wrapper.text()).toContain('100%');
});

test('healthClass: ok when healthRate===100, err when data.error>0, else warn', async () => {
  // 100% case -> ok
  getMock.mockResolvedValueOnce({ data: { totalLinks: 5, healthy: 5, warning: 0, error: 0, lastUpdate: null, agentCount: 1 } });
  const w1 = mount(StatusBar);
  await flushPromises();
  const kpi1 = w1.find('.kpi');
  expect(kpi1.classes()).toContain('ok');

  // error > 0 -> err
  getMock.mockReset();
  getMock.mockResolvedValueOnce({ data: { totalLinks: 5, healthy: 4, warning: 0, error: 1, lastUpdate: null, agentCount: 1 } });
  const w2 = mount(StatusBar);
  await flushPromises();
  const kpi2 = w2.find('.kpi');
  expect(kpi2.classes()).toContain('err');

  // has links but not all healthy and no error -> warn
  getMock.mockReset();
  getMock.mockResolvedValueOnce({ data: { totalLinks: 5, healthy: 4, warning: 1, error: 0, lastUpdate: null, agentCount: 1 } });
  const w3 = mount(StatusBar);
  await flushPromises();
  const kpi3 = w3.find('.kpi');
  expect(kpi3.classes()).toContain('warn');
});