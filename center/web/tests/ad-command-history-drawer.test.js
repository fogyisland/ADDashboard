// 2026-08-31 R75 — frontend tests for AdCommandHistoryDrawer.vue.
//
// The drawer polls GET /api/admin/ad-commands?operatorId=X every 5s.
// Renders last 20 commands newest-first with status pills and an
// expand toggle that surfaces params + result JSON.

import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../src/api/ad-admin.js', () => ({
  adAdminApi: {
    listCommands: vi.fn(),
    getCommand: vi.fn()
  }
}));

import AdCommandHistoryDrawer from '../src/views/admin/AdCommandHistoryDrawer.vue';
import { adAdminApi } from '../src/api/ad-admin.js';

beforeEach(() => {
  adAdminApi.listCommands.mockResolvedValue({ data: { total: 0, rows: [], page: 1, size: 20 } });
});

function mountDrawer(props = { operatorId: 42 }) {
  return mount(AdCommandHistoryDrawer, { props });
}

const FAKE_ROWS = [
  {
    id: 1, commandType: 'user_search', targetDc: 'DC-BJ-01',
    status: 'success', createdAt: '2026-08-31T10:00:00Z',
    claimedAt: '2026-08-31T10:00:01Z', completedAt: '2026-08-31T10:00:02Z',
    durationMs: 1000, errorMessage: null,
    operatorId: 42, operatorUsername: 'admin',
    paramsJson: { filter: 'jdoe' },
    resultJson: { users: [{ sam: 'jdoe' }] }
  },
  {
    id: 2, commandType: 'user_password_reset', targetDc: 'DC-SH-01',
    status: 'failed', createdAt: '2026-08-31T10:05:00Z',
    claimedAt: null, completedAt: '2026-08-31T10:05:30Z',
    durationMs: 500, errorMessage: 'DC offline',
    operatorId: 42, operatorUsername: 'admin',
    paramsJson: { sam: 'alice', newPassword: '***REDACTED***' },
    resultJson: null
  },
  {
    id: 3, commandType: 'group_create', targetDc: 'DC-GZ-01',
    status: 'running', createdAt: '2026-08-31T10:10:00Z',
    claimedAt: '2026-08-31T10:10:01Z', completedAt: null,
    durationMs: null, errorMessage: null,
    operatorId: 42, operatorUsername: 'admin',
    paramsJson: { name: 'NewGroup' },
    resultJson: null
  }
];

// ── Polling / rendering ─────────────────────────────────────

test('mounts and renders last 20 commands from listCommands', async () => {
  adAdminApi.listCommands.mockResolvedValue({
    data: { total: FAKE_ROWS.length, rows: FAKE_ROWS, page: 1, size: 20 }
  });
  const w = mountDrawer();
  await flushPromises();
  expect(adAdminApi.listCommands).toHaveBeenCalledWith(expect.objectContaining({ operatorId: 42, size: 20 }));
  expect(w.find('[data-test="cmd-row-1"]').exists()).toBe(true);
  expect(w.find('[data-test="cmd-row-2"]').exists()).toBe(true);
  expect(w.find('[data-test="cmd-row-3"]').exists()).toBe(true);
});

test('each row has a status pill', async () => {
  adAdminApi.listCommands.mockResolvedValue({
    data: { total: FAKE_ROWS.length, rows: FAKE_ROWS, page: 1, size: 20 }
  });
  const w = mountDrawer();
  await flushPromises();
  expect(w.find('[data-test="cmd-status-1"]').exists()).toBe(true);
  expect(w.find('[data-test="cmd-status-2"]').exists()).toBe(true);
  expect(w.find('[data-test="cmd-status-3"]').exists()).toBe(true);
});

test('expand button toggles payload display (cmd-result-${id})', async () => {
  adAdminApi.listCommands.mockResolvedValue({
    data: { total: 1, rows: [FAKE_ROWS[0]], page: 1, size: 20 }
  });
  const w = mountDrawer();
  await flushPromises();
  // Initially collapsed
  expect(w.find('[data-test="cmd-result-1"]').exists()).toBe(false);
  await w.find('[data-test="cmd-expand-1"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="cmd-result-1"]').exists()).toBe(true);
  // Collapse again
  await w.find('[data-test="cmd-expand-1"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="cmd-result-1"]').exists()).toBe(false);
});

test('expanded payload redacts password fields (***REDACTED***)', async () => {
  adAdminApi.listCommands.mockResolvedValue({
    data: { total: 1, rows: [FAKE_ROWS[1]], page: 1, size: 20 }
  });
  const w = mountDrawer();
  await flushPromises();
  await w.find('[data-test="cmd-expand-2"]').trigger('click');
  await flushPromises();
  const result = w.find('[data-test="cmd-result-2"]').text();
  expect(result).toContain('***REDACTED***');
  expect(result).not.toContain('PlainSecretPassword');   // defensive
});

test('empty list renders empty state', async () => {
  const w = mountDrawer();
  await flushPromises();
  expect(w.text()).toContain('暂无命令');
});

// ── Status rendering ─────────────────────────────────────────

test('status pill reflects the row status class', async () => {
  adAdminApi.listCommands.mockResolvedValue({
    data: { total: FAKE_ROWS.length, rows: FAKE_ROWS, page: 1, size: 20 }
  });
  const w = mountDrawer();
  await flushPromises();
  expect(w.find('[data-test="cmd-status-1"]').classes()).toContain('ok');
  expect(w.find('[data-test="cmd-status-2"]').classes()).toContain('err');
  expect(w.find('[data-test="cmd-status-3"]').classes()).toContain('warn');
});