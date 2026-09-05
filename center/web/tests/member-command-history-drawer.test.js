// 2026-09-05 R81 — frontend tests for MemberCommandHistoryDrawer.vue.
//
// The drawer polls GET /api/admin/member-commands?hostname=X every 5s.
// Renders last 50 commands newest-first with status pills and an
// expand toggle that surfaces params + result JSON. Mirrors
// ad-command-history-drawer.test.js (R75).

import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../src/api/member-commands.js', () => ({
  memberCommandsApi: {
    listCommands: vi.fn(),
    getCommand: vi.fn()
  }
}));

import MemberCommandHistoryDrawer from '../src/views/admin/MemberCommandHistoryDrawer.vue';
import { memberCommandsApi } from '../src/api/member-commands.js';

beforeEach(() => {
  memberCommandsApi.listCommands.mockResolvedValue({ data: { total: 0, rows: [], page: 1, size: 50 } });
});

function mountDrawer(props = { hostname: 'web-01' }) {
  return mount(MemberCommandHistoryDrawer, { props });
}

const FAKE_ROWS = [
  {
    id: 1, commandType: 'member_script', hostname: 'web-01',
    status: 'success', createdAt: '2026-09-05T10:00:00Z',
    claimedAt: null, completedAt: null,
    durationMs: 250, errorMessage: null,
    operatorId: 42, operatorUsername: 'admin',
    paramsJson: { script: 'Get-Date', timeoutSec: 30 },
    resultJson: { stdout: '09/05/2026 10:00:00', stderr: '', exitCode: 0, durationMs: 250 }
  },
  {
    id: 2, commandType: 'member_script', hostname: 'web-01',
    status: 'failed', createdAt: '2026-09-05T10:05:00Z',
    claimedAt: null, completedAt: null,
    durationMs: 500, errorMessage: 'danger pattern detected',
    operatorId: 42, operatorUsername: 'admin',
    paramsJson: { script: 'Format-Volume -DriveLetter C' },
    resultJson: null
  },
  {
    id: 3, commandType: 'member_script', hostname: 'web-01',
    status: 'running', createdAt: '2026-09-05T10:10:00Z',
    claimedAt: null, completedAt: null,
    durationMs: null, errorMessage: null,
    operatorId: 42, operatorUsername: 'admin',
    paramsJson: { script: 'Get-Service' },
    resultJson: null
  }
];

// ── Polling / rendering ─────────────────────────────────────────────────

test('mounts and renders last commands from listCommands scoped to hostname', async () => {
  memberCommandsApi.listCommands.mockResolvedValue({
    data: { total: FAKE_ROWS.length, rows: FAKE_ROWS, page: 1, size: 50 }
  });
  const w = mountDrawer();
  await flushPromises();
  expect(memberCommandsApi.listCommands).toHaveBeenCalledWith(expect.objectContaining({ hostname: 'web-01', size: 50 }));
  expect(w.find('[data-test="mc-row-1"]').exists()).toBe(true);
  expect(w.find('[data-test="mc-row-2"]').exists()).toBe(true);
  expect(w.find('[data-test="mc-row-3"]').exists()).toBe(true);
});

test('empty list renders empty state', async () => {
  const w = mountDrawer();
  await flushPromises();
  expect(w.text()).toContain('暂无命令');
});

test('hostname change refetches the drawer', async () => {
  memberCommandsApi.listCommands.mockClear();
  memberCommandsApi.listCommands.mockResolvedValue({
    data: { total: 1, rows: [FAKE_ROWS[0]], page: 1, size: 50 }
  });
  const w = mountDrawer();
  await flushPromises();
  expect(memberCommandsApi.listCommands).toHaveBeenCalledTimes(1);

  await w.setProps({ hostname: 'web-02' });
  await flushPromises();
  expect(memberCommandsApi.listCommands).toHaveBeenCalledTimes(2);
  expect(memberCommandsApi.listCommands).toHaveBeenLastCalledWith(expect.objectContaining({ hostname: 'web-02' }));
});

// ── Each row has a status pill ─────────────────────────────────────────

test('each row has a status pill', async () => {
  memberCommandsApi.listCommands.mockResolvedValue({
    data: { total: FAKE_ROWS.length, rows: FAKE_ROWS, page: 1, size: 50 }
  });
  const w = mountDrawer();
  await flushPromises();
  expect(w.find('[data-test="mc-status-1"]').exists()).toBe(true);
  expect(w.find('[data-test="mc-status-2"]').exists()).toBe(true);
  expect(w.find('[data-test="mc-status-3"]').exists()).toBe(true);
});

// ── Expand button toggles payload ───────────────────────────────────────

test('expand button toggles payload display (mc-result-${id})', async () => {
  memberCommandsApi.listCommands.mockResolvedValue({
    data: { total: 1, rows: [FAKE_ROWS[0]], page: 1, size: 50 }
  });
  const w = mountDrawer();
  await flushPromises();
  // Initially collapsed
  expect(w.find('[data-test="mc-result-1"]').exists()).toBe(false);
  await w.find('[data-test="mc-expand-1"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="mc-result-1"]').exists()).toBe(true);
  // Collapse again
  await w.find('[data-test="mc-expand-1"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="mc-result-1"]').exists()).toBe(false);
});

// ── Status rendering ────────────────────────────────────────────────────

test('status pill reflects the row status class', async () => {
  memberCommandsApi.listCommands.mockResolvedValue({
    data: { total: FAKE_ROWS.length, rows: FAKE_ROWS, page: 1, size: 50 }
  });
  const w = mountDrawer();
  await flushPromises();
  expect(w.find('[data-test="mc-status-1"]').classes()).toContain('ok');
  expect(w.find('[data-test="mc-status-2"]').classes()).toContain('err');
  expect(w.find('[data-test="mc-status-3"]').classes()).toContain('warn');
});

// ── Belt-and-suspenders redact in expanded payload ──────────────────────

test('expanded payload redacts password / token fields (***REDACTED***)', async () => {
  memberCommandsApi.listCommands.mockResolvedValue({
    data: { total: 1, rows: [{
      id: 5, commandType: 'member_script', hostname: 'web-01',
      status: 'success', createdAt: '2026-09-05T10:00:00Z',
      durationMs: 100, errorMessage: null,
      paramsJson: { script: 'Set-Service -Name X -Password (Read-Host)', password: 'PlainSecretPassword', token: 'tok-abc' },
      resultJson: { stdout: '', stderr: '', exitCode: 0, durationMs: 100, token: 'should-be-redacted-too' }
    }], page: 1, size: 50 }
  });
  const w = mountDrawer();
  await flushPromises();
  await w.find('[data-test="mc-expand-5"]').trigger('click');
  await flushPromises();
  const txt = w.find('[data-test="mc-result-5"]').text();
  expect(txt).toContain('***REDACTED***');
  expect(txt).not.toContain('PlainSecretPassword');
  expect(txt).not.toContain('tok-abc');
  expect(txt).not.toContain('should-be-redacted-too');
});