import { test, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import * as api from '../src/api/migrations.js';
import * as notify from '../src/lib/notify.js';
import SchemaMigrationsView from '../src/views/admin/SchemaMigrationsView.vue';

vi.mock('../src/api/migrations.js');
vi.mock('../src/lib/notify.js', () => ({
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
  notifyInfo: vi.fn(),
  notify: vi.fn(),
  subscribe: vi.fn(() => () => {})
}));

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
  vi.mocked(api.markApplied).mockReset();
  vi.mocked(api.baseline).mockReset();
  vi.mocked(api.applyUpTo).mockReset();
  vi.mocked(api.upgrade).mockReset();
  vi.mocked(notify.notifyError).mockReset();
  vi.mocked(notify.notifySuccess).mockReset();
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

test('failed apply shows errorMessage inline + notifies error', async () => {
  vi.mocked(api.listMigrations).mockResolvedValue({ data: sampleRows });
  vi.mocked(api.applyMigration).mockResolvedValue({
    data: { ok: false, version: '010', status: 'failed', executionMs: 5, errorMessage: 'Duplicate column name' }
  });
  const w = mount(SchemaMigrationsView, { global: { plugins: [makeRouter()] } });
  await flushPromises();
  window.confirm = vi.fn(() => true);
  const pendingRow = w.findAll('tr').find(r => r.text().includes('010'));
  await pendingRow.findAll('button').find(b => b.text() === '应用').trigger('click');
  await flushPromises();
  expect(w.text()).toContain('Duplicate column name');
  expect(notify.notifyError).toHaveBeenCalledWith(expect.stringContaining('Duplicate column name'));
});

test('apply throwing an exception surfaces the message + notifies error', async () => {
  vi.mocked(api.listMigrations).mockResolvedValue({ data: sampleRows });
  vi.mocked(api.applyMigration).mockRejectedValue(new Error('Network Error'));
  const w = mount(SchemaMigrationsView, { global: { plugins: [makeRouter()] } });
  await flushPromises();
  window.confirm = vi.fn(() => true);
  const pendingRow = w.findAll('tr').find(r => r.text().includes('010'));
  await pendingRow.findAll('button').find(b => b.text() === '应用').trigger('click');
  await flushPromises();
  expect(w.text()).toContain('Network Error');
  expect(notify.notifyError).toHaveBeenCalledWith(expect.stringContaining('Network Error'));
  // failed apply must not silently clear the row — no refresh on exception
  expect(api.listMigrations).toHaveBeenCalledTimes(1);
});

test('apply button is disabled and flips to 应用中… while in flight', async () => {
  vi.mocked(api.listMigrations).mockResolvedValue({ data: sampleRows });
  let release;
  vi.mocked(api.applyMigration).mockReturnValue(new Promise(res => { release = res; }));
  const w = mount(SchemaMigrationsView, { global: { plugins: [makeRouter()] } });
  await flushPromises();
  window.confirm = vi.fn(() => true);
  const btn = w.findAll('tr').find(r => r.text().includes('010'))
    .findAll('button').find(b => b.text() === '应用');
  await btn.trigger('click');
  await flushPromises();
  const busyBtn = w.findAll('tr').find(r => r.text().includes('010'))
    .findAll('button').find(b => b.text() === '应用中…');
  expect(busyBtn).toBeTruthy();
  expect(busyBtn.attributes('disabled')).toBeDefined();
  release({ data: { ok: true, version: '010', status: 'applied', executionMs: 10 } });
  await flushPromises();
  expect(w.findAll('button').some(b => b.text() === '应用中…')).toBe(false);
});

test('errorMessage column renders truncated text with full value in title', async () => {
  const long = 'X'.repeat(80);
  vi.mocked(api.listMigrations).mockResolvedValue({
    data: [{ ...sampleRows[1], status: 'failed', errorMessage: long }]
  });
  const w = mount(SchemaMigrationsView, { global: { plugins: [makeRouter()] } });
  await flushPromises();
  const cell = w.find('.error-cell');
  expect(cell.exists()).toBe(true);
  expect(cell.attributes('title')).toBe(long);
  expect(cell.text()).toBe('X'.repeat(60) + '…');
});

test('applyAllPending collects failures and reports a summary', async () => {
  const twoPending = [
    { ...sampleRows[1], version: '010' },
    { ...sampleRows[1], version: '011' }
  ];
  vi.mocked(api.listMigrations).mockResolvedValue({ data: twoPending });
  vi.mocked(api.applyMigration)
    .mockResolvedValueOnce({ data: { ok: false, version: '010', errorMessage: 'boom-010' } })
    .mockResolvedValueOnce({ data: { ok: true, version: '011' } });
  const w = mount(SchemaMigrationsView, { global: { plugins: [makeRouter()] } });
  await flushPromises();
  window.confirm = vi.fn(() => true);
  await w.find('.apply-all').trigger('click');
  await flushPromises();
  // continues past the first failure
  expect(api.applyMigration).toHaveBeenCalledTimes(2);
  expect(notify.notifyError).toHaveBeenCalledWith(expect.stringContaining('boom-010'));
});

test('pending row shows [标记已应用] button', async () => {
  vi.mocked(api.listMigrations).mockResolvedValue({ data: sampleRows });
  const w = mount(SchemaMigrationsView, { global: { plugins: [makeRouter()] } });
  await flushPromises();
  const pendingRow = w.findAll('tr').find(r => r.text().includes('010'));
  expect(pendingRow.text()).toContain('标记已应用');
});

test('top bar shows [升级到最新] button', async () => {
  vi.mocked(api.listMigrations).mockResolvedValue({ data: sampleRows });
  const w = mount(SchemaMigrationsView, { global: { plugins: [makeRouter()] } });
  await flushPromises();
  expect(w.text()).toContain('升级到最新');
});

test('click [升级到最新] → calls upgrade API', async () => {
  vi.mocked(api.listMigrations)
    .mockResolvedValueOnce({ data: sampleRows })
    .mockResolvedValueOnce({ data: sampleRows });
  vi.mocked(api.upgrade).mockResolvedValue({ data: { ok: true, migrations: { applied: [], failed: [] }, seed: { ran: false, reason: 'unchanged' }, message: 'ok' } });
  const w = mount(SchemaMigrationsView, { global: { plugins: [makeRouter()] } });
  await flushPromises();
  window.confirm = vi.fn(() => true);
  await w.findAll('button').find(b => b.text().includes('升级到最新')).trigger('click');
  await flushPromises();
  expect(api.upgrade).toHaveBeenCalled();
});