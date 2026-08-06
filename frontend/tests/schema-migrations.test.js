import { test, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import * as api from '../src/api/migrations.js';
import SchemaMigrationsView from '../src/views/admin/SchemaMigrationsView.vue';

vi.mock('../src/api/migrations.js');

function makeRouter() {
  const r = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/admin/migrations', component: SchemaMigrationsView, meta: { perm: 'admin:users' } }]
  });
  r.push('/admin/migrations');
  return r;
}

const sampleRows = [
  {
    version: '008', description: 'lockout-events', script: '008-lockout-events.sql',
    dialect: 'mysql', status: 'applied',
    appliedAt: '2026-08-06T12:00:00Z', appliedBy: 'admin', executionMs: 42,
    checksum: 'abc123', checksumMismatch: false, scriptMissing: false, errorMessage: null
  },
  {
    version: '010', description: 'future-migration', script: '010-future-migration.sql',
    dialect: 'mysql', status: 'pending',
    appliedAt: null, appliedBy: null, executionMs: null,
    checksum: null, checksumMismatch: false, scriptMissing: false, errorMessage: null
  }
];

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(api.listMigrations).mockReset();
  vi.mocked(api.applyMigration).mockReset();
  vi.mocked(api.dryRunMigration).mockReset();
  vi.mocked(api.resetMigration).mockReset();
});

test('renders table with applied + pending rows', async () => {
  vi.mocked(api.listMigrations).mockResolvedValue({ data: sampleRows });
  const w = mount(SchemaMigrationsView, {
    global: { plugins: [makeRouter()] }
  });
  await flushPromises();
  expect(w.text()).toContain('008');
  expect(w.text()).toContain('lockout-events');
  expect(w.text()).toContain('010');
  expect(w.text()).toContain('Version');
});

test('pending row shows [Dry-run] and [应用]; applied row shows only [查看]', async () => {
  vi.mocked(api.listMigrations).mockResolvedValue({ data: sampleRows });
  const w = mount(SchemaMigrationsView, {
    global: { plugins: [makeRouter()] }
  });
  await flushPromises();
  const pendingRow = w.findAll('tr').find(r => r.text().includes('010'));
  const appliedRow = w.findAll('tr').find(r => r.text().includes('008'));
  expect(pendingRow.text()).toContain('Dry-run');
  expect(pendingRow.text()).toContain('应用');
  expect(appliedRow.text()).toContain('查看');
  expect(appliedRow.text()).not.toContain('Dry-run');
});

test('click [应用] → calls applyMigration + refreshes list', async () => {
  vi.mocked(api.listMigrations)
    .mockResolvedValueOnce({ data: sampleRows })
    .mockResolvedValueOnce({ data: sampleRows.map(r => r.version === '010' ? { ...r, status: 'applied' } : r) });
  vi.mocked(api.applyMigration).mockResolvedValue({ data: { ok: true, version: '010', status: 'applied', executionMs: 10 } });
  const w = mount(SchemaMigrationsView, {
    global: { plugins: [makeRouter()] }
  });
  await flushPromises();
  const pendingRow = w.findAll('tr').find(r => r.text().includes('010'));
  window.confirm = vi.fn(() => true);
  await pendingRow.findAll('button').find(b => b.text() === '应用').trigger('click');
  await flushPromises();
  expect(api.applyMigration).toHaveBeenCalledWith('010', expect.any(Object));
  expect(api.listMigrations).toHaveBeenCalledTimes(2);
});