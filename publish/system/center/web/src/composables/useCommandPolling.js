// 2026-08-31 R75 — useCommandPolling composable.
//
// Polls GET /api/admin/ad-commands/:id every `intervalMs` until status is
// terminal (success|failed|timeout) OR `timeoutMs` elapses. Used by:
//   - UserManagementView / GroupManagementView — after each modal submit
//   - AdCommandHistoryDrawer — drives the per-row "查看结果" expand
//   - UserPickerMini — short-timeout poll for autocomplete suggestions
//
// Returns reactive { command, loading, error, isTerminal, timedOut } and
// a `start(commandId)` trigger. Callers MUST call start() once to kick
// off polling; the composable does not auto-start on construction so
// the views can keep their submit handler as the single entry point.
//
// Status semantics (matches R75 spec §2.1 + center/src/services/ad-admin-commands.js):
//   queued   — initial; not yet picked up by any agent
//   running  — agent claimed; awaiting ack
//   success  — terminal; result_json populated
//   failed   — terminal; error_message populated
//   timeout  — terminal; set by center sweep when 30s elapses
//
// `timedOut: true` is set when the composable's own timeout fires BEFORE
// the command reaches a terminal state — the operator UI then renders
// "命令执行超时，正在查询状态…" and the polling continues until the server
// flips to a terminal state (the row is still in the DB).

import { ref, onBeforeUnmount } from 'vue';
import { adAdminApi } from '../api/ad-admin.js';

const TERMINAL = new Set(['success', 'failed', 'timeout']);

export function useCommandPolling(commandId, {
  intervalMs = 3000,
  timeoutMs = 30000
} = {}) {
  const command = ref(null);
  const loading = ref(false);
  const error = ref('');
  const isTerminal = ref(false);
  const timedOut = ref(false);

  let pollTimer = null;
  let deadlineTimer = null;
  let stopped = false;

  function clearTimers() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
  }

  function stop() {
    stopped = true;
    clearTimers();
  }

  async function tick() {
    if (!command.value?.id) return;
    try {
      const r = await adAdminApi.getCommand(command.value.id);
      const next = r.data || null;
      command.value = next;
      const status = next?.status;
      if (status && TERMINAL.has(status)) {
        isTerminal.value = true;
        stop();
        return;
      }
    } catch (e) {
      error.value = e?.response?.data?.error || e?.message || '查询命令状态失败';
      // Don't stop on transient errors — let the next tick try again.
    }
  }

  function start(initialRow) {
    // initialRow lets the caller (view) seed `command` with the queued
    // response from queueCommand without an extra GET round-trip.
    if (initialRow) command.value = initialRow;
    else if (commandId) command.value = { id: commandId };
    stopped = false;
    loading.value = true;
    error.value = '';

    // Immediate first tick so the operator sees the status flip fast
    // (most AD commands resolve in <2s in the mock environment).
    tick().finally(() => { loading.value = false; });

    pollTimer = setInterval(tick, intervalMs);

    // Hard deadline — if the command hasn't reached a terminal state
    // by `timeoutMs`, flip timedOut but keep polling until the server
    // eventually reports success/failed/timeout. The view's UI shows a
    // "命令执行超时，正在查询状态…" banner once timedOut is true.
    deadlineTimer = setTimeout(() => {
      if (!isTerminal.value && !stopped) {
        timedOut.value = true;
        // Don't stop polling — the agent may still ack after the deadline.
        // Keep going until the server-side sweep or the agent ack lands.
      }
    }, timeoutMs);
  }

  onBeforeUnmount(stop);

  return { command, loading, error, isTerminal, timedOut, start, stop };
}