import { test, expect, vi } from 'vitest';
import api from '../src/api/client.js';

vi.mock('../src/api/client.js', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn()
  }
}));

import { listMigrations, applyMigration, dryRunMigration, resetMigration, markApplied, baseline, applyUpTo, upgrade } from '../src/api/migrations.js';

test('listMigrations hits GET /api/admin/migrations', async () => {
  api.get.mockResolvedValue({ data: [] });
  await listMigrations();
  expect(api.get).toHaveBeenCalledWith('/api/admin/migrations');
});

test('applyMigration hits POST /api/admin/migrations/:version/apply', async () => {
  api.post.mockResolvedValue({ data: { ok: true } });
  await applyMigration('008', { appliedBy: 'admin' });
  expect(api.post).toHaveBeenCalledWith('/api/admin/migrations/008/apply', { appliedBy: 'admin' });
});

test('dryRunMigration hits POST /api/admin/migrations/:version/dry-run', async () => {
  api.post.mockResolvedValue({ data: { version: '008', statements: [] } });
  await dryRunMigration('008');
  expect(api.post).toHaveBeenCalledWith('/api/admin/migrations/008/dry-run', {});
});

test('resetMigration hits POST /api/admin/migrations/:version/reset', async () => {
  api.post.mockResolvedValue({ data: { ok: true, deleted: 1 } });
  await resetMigration('008');
  expect(api.post).toHaveBeenCalledWith('/api/admin/migrations/008/reset', {});
});

test('markApplied POSTs to /:version/mark-applied', async () => {
  api.post.mockResolvedValue({ data: { ok: true } });
  await markApplied('014');
  expect(api.post).toHaveBeenCalledWith('/api/admin/migrations/014/mark-applied', {});
});

test('baseline POSTs to /baseline with version body', async () => {
  api.post.mockResolvedValue({ data: { ok: true, versions: [] } });
  await baseline('014');
  expect(api.post).toHaveBeenCalledWith('/api/admin/migrations/baseline', { version: '014' });
});

test('applyUpTo POSTs to /apply-up-to with version body', async () => {
  api.post.mockResolvedValue({ data: { ok: true, applied: [], failed: [] } });
  await applyUpTo('014');
  expect(api.post).toHaveBeenCalledWith('/api/admin/migrations/apply-up-to', { version: '014' });
});

test('upgrade POSTs to /upgrade', async () => {
  api.post.mockResolvedValue({ data: { ok: true } });
  await upgrade();
  expect(api.post).toHaveBeenCalledWith('/api/admin/migrations/upgrade', {});
});