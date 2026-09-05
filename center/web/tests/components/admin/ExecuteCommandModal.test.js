// 2026-09-05 R81 — frontend tests for ExecuteCommandModal.vue.
//
// Covers:
//   - form fields render with correct data-test hooks
//   - submit disabled until script filled + timeout valid
//   - submit posts member_script with script + timeoutSec + force
//   - submit success → result message + emits submitted
//   - cancel closes modal + clears in-flight polling
//   - client-side 32KB cap surfaces as a local form error
//   - regression: deadline (setTimeout) leak cleanup on cancel

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../../../src/api/member-commands.js', () => ({
  memberCommandsApi: {
    queueCommand: vi.fn(),
    getCommand: vi.fn()
  }
}));

import ExecuteCommandModal from '../../../src/components/admin/ExecuteCommandModal.vue';
import { memberCommandsApi } from '../../../src/api/member-commands.js';

const TARGET_HOST = 'web-01';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  memberCommandsApi.queueCommand.mockResolvedValue({
    data: { id: 200, status: 'queued', hostname: TARGET_HOST, commandType: 'member_script' }
  });
  memberCommandsApi.getCommand.mockResolvedValue({
    data: { id: 200, status: 'success', hostname: TARGET_HOST, commandType: 'member_script', exitCode: 0, result: { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 250 } }
  });
});

function mountModal(props = { hostname: TARGET_HOST }) {
  return mount(ExecuteCommandModal, { props });
}

afterEach(() => {
  vi.useRealTimers();
});

// ── Field rendering ─────────────────────────────────────────────────────

test('renders all expected form fields + host preview', () => {
  const w = mountModal();
  for (const t of [
    'exec-modal',
    'exec-hostname',
    'exec-script',
    'exec-timeout',
    'exec-force',
    'exec-submit',
    'exec-cancel'
  ]) {
    expect(w.find(`[data-test="${t}"]`).exists(), `expected field ${t}`).toBe(true);
  }
  expect(w.find('[data-test="exec-hostname"]').text()).toBe(TARGET_HOST);
});

test('default timeout is 30 seconds', () => {
  const w = mountModal();
  const sel = w.find('[data-test="exec-timeout"]');
  expect(sel.element.value).toBe('30');
});

// ── canSubmit gate ──────────────────────────────────────────────────────

test('submit disabled until script filled', async () => {
  const w = mountModal();
  const submit = () => w.find('[data-test="exec-submit"]');
  expect(submit().attributes('disabled')).toBeDefined();
  await w.find('[data-test="exec-script"]').setValue('Get-Date');
  expect(submit().attributes('disabled')).toBeUndefined();
});

test('submit disabled when script exceeds 32KB client-side cap', async () => {
  const w = mountModal();
  // 33KB payload — exceeds the 32KB (32768 byte) cap
  const big = 'X'.repeat(33 * 1024);
  await w.find('[data-test="exec-script"]').setValue(big);
  const submit = w.find('[data-test="exec-submit"]');
  expect(submit.attributes('disabled')).toBeDefined();
  // And the size hint should be flagged "over"
  expect(w.text()).toMatch(/脚本大小.*over|over.*脚本大小/);
});

// ── Submit payload ──────────────────────────────────────────────────────

test('submit posts member_script with script + timeoutSec + force=false', async () => {
  const w = mountModal();
  await w.find('[data-test="exec-script"]').setValue('Get-Service | Select-Object -First 5');
  await w.find('[data-test="exec-timeout"]').setValue('15');
  await w.find('[data-test="exec-submit"]').trigger('click');
  await flushPromises();
  await vi.runAllTimersAsync();
  expect(memberCommandsApi.queueCommand).toHaveBeenCalledWith(expect.objectContaining({
    hostname: TARGET_HOST,
    commandType: 'member_script',
    params: expect.objectContaining({
      script: 'Get-Service | Select-Object -First 5',
      timeoutSec: 15,
      force: false
    })
  }));
});

test('submit with force=true posts force=true', async () => {
  const w = mountModal();
  await w.find('[data-test="exec-script"]').setValue('Get-Date');
  await w.find('[data-test="exec-force"]').setValue(true);
  await w.find('[data-test="exec-submit"]').trigger('click');
  await flushPromises();
  await vi.runAllTimersAsync();
  expect(memberCommandsApi.queueCommand).toHaveBeenCalledWith(expect.objectContaining({
    params: expect.objectContaining({ force: true })
  }));
});

// ── Submit success / failure ────────────────────────────────────────────

test('submit success renders result message and emits submitted', async () => {
  const w = mountModal();
  await w.find('[data-test="exec-script"]').setValue('Get-Date');
  await w.find('[data-test="exec-submit"]').trigger('click');
  await flushPromises();
  await vi.runAllTimersAsync();
  expect(w.find('[data-test="exec-result"]').exists()).toBe(true);
  expect(w.find('[data-test="exec-result"]').text()).toContain('执行成功');
  expect(w.emitted('submitted')).toBeTruthy();
});

test('submit failure renders error message and does NOT emit submitted', async () => {
  memberCommandsApi.getCommand.mockResolvedValue({
    data: { id: 200, status: 'failed', hostname: TARGET_HOST, commandType: 'member_script', errorMessage: 'script rejected' }
  });
  const w = mountModal();
  await w.find('[data-test="exec-script"]').setValue('Remove-Item -Recurse C:\\');
  await w.find('[data-test="exec-submit"]').trigger('click');
  await flushPromises();
  await vi.runAllTimersAsync();
  expect(w.find('[data-test="exec-result"]').text()).toContain('script rejected');
  expect(w.emitted('submitted')).toBeFalsy();
});

// ── Cancel / leak regression ────────────────────────────────────────────

test('cancel emits close', async () => {
  const w = mountModal();
  await w.find('[data-test="exec-cancel"]').trigger('click');
  expect(w.emitted('close')).toBeTruthy();
});

test('cancel before deadline cleans up setTimeout (no timedOut banner)', async () => {
  const w = mountModal();
  await w.find('[data-test="exec-script"]').setValue('Get-Date');
  await w.find('[data-test="exec-submit"]').trigger('click');
  await flushPromises();
  await w.find('[data-test="exec-cancel"]').trigger('click');
  await vi.advanceTimersByTimeAsync(36_000);
  expect(w.text()).not.toContain('命令执行超时');
  expect(w.emitted('close')).toBeTruthy();
});

test('submit server error renders local form error', async () => {
  memberCommandsApi.queueCommand.mockRejectedValue({
    response: { data: { error: 'rate limited' } }
  });
  const w = mountModal();
  await w.find('[data-test="exec-script"]').setValue('Get-Date');
  await w.find('[data-test="exec-submit"]').trigger('click');
  await flushPromises();
  expect(w.text()).toContain('rate limited');
});