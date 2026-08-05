import { test, expect, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import ConfigView from '../src/views/admin/ConfigView.vue';
import { adminApi } from '../src/api/admin.js';

vi.mock('../src/api/admin.js', () => ({
  adminApi: {
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
    getConfigAudit: vi.fn(),
    rollbackConfig: vi.fn()
  }
}));

const SAMPLE = {
  polling_interval_minutes: '5', latency_threshold_minutes: '60', heartbeat_interval_seconds: '10',
  history_enabled: '1', ad_agent_token: 'old-token-1234567890',
  center_public_host: 'ad.example.com', center_public_port: '443'
};
const AUDIT = [
  { id: 1, configKey: 'polling_interval_minutes', oldValue: '5', newValue: '7', changeType: 'UPDATE', changedByUsername: 'admin', changedAt: '2026-08-05T10:00:00Z' },
  { id: 2, configKey: 'ad_agent_token', oldValue: 'old', newValue: 'new', changeType: 'ROLLBACK', changedByUsername: 'admin', changedAt: '2026-08-05T10:01:00Z' }
];

test('audit footer renders rows; rollback rows hide the rollback button', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: SAMPLE });
  adminApi.getConfigAudit.mockResolvedValue({ data: AUDIT });
  const w = mount(ConfigView);
  await flushPromises();
  const rows = w.findAll('.audit-row');
  expect(rows.length).toBe(2);
  // Row 1 is UPDATE → has rollback button
  expect(rows[0].find('button.rollback').exists()).toBe(true);
  // Row 2 is ROLLBACK → no rollback button
  expect(rows[1].find('button.rollback').exists()).toBe(false);
});

test('click rollback → confirm → calls rollbackConfig and refreshes both lists', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: SAMPLE });
  adminApi.getConfigAudit.mockResolvedValue({ data: AUDIT });
  adminApi.rollbackConfig.mockResolvedValue({ data: { ok: true, configKey: 'polling_interval_minutes', newValue: '5' } });
  const w = mount(ConfigView);
  await flushPromises();
  await w.find('button.rollback').trigger('click');
  await flushPromises();
  await w.find('button.confirm').trigger('click');
  await flushPromises();
  expect(adminApi.rollbackConfig).toHaveBeenCalledWith(1);
  // Both should be re-fetched
  expect(adminApi.getConfig.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(adminApi.getConfigAudit.mock.calls.length).toBeGreaterThanOrEqual(2);
});
