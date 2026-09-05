<!--
  2026-09-05 R81 — member-commands history drawer (right-side).

  Polls GET /api/admin/member-commands?hostname=X every 5s and renders
  the most recent commands newest first. Each row expands to show the
  params (script body + timeoutSec) + result (stdout/stderr/exitCode/
  durationMs, with password/newPassword/token redacted belt-and-suspenders
  even though the server already strips them per R81 §3).

  data-test contract (matched by tests/member-command-history-drawer.test.js):
    mc-row-${id}           — one row per command
    mc-status-${id}        — status pill on the row
    mc-expand-${id}        — caret/expand toggle
    mc-result-${id}        — expanded JSON payload block

  Usage (in MemberCommandsView):
    <MemberCommandHistoryDrawer :hostname="selectedHost" :operator-id="currentUserId" />

  Refresh cadence: 5s while any row is queued/running, 30s idle (per
  R75 pattern). On unmount the timer is cleared.

  Note: unlike R75's AdCommandHistoryDrawer, this drawer is bound to a
  SPECIFIC hostname (the picker drives it), not the whole fleet. The
  operator narrows history by host before opening the drawer.
-->
<template>
  <aside class="cmd-drawer" :class="{ collapsed }">
    <header class="cmd-drawer-head">
      <span class="title">成员命令历史{{ props.hostname ? ' · ' + props.hostname : '' }}</span>
      <button
        type="button"
        class="collapse-btn"
        :data-test="'mc-drawer-collapse'"
        @click="collapsed = !collapsed"
        :title="collapsed ? '展开' : '收起'"
      >{{ collapsed ? '‹' : '›' }}</button>
    </header>

    <div v-if="!collapsed" class="cmd-drawer-body">
      <div v-if="loading && !rows.length" class="empty">加载中…</div>
      <div v-else-if="!rows.length" class="empty">暂无命令</div>
      <ul v-else class="cmd-list">
        <li
          v-for="r in rows"
          :key="r.id"
          :data-test="`mc-row-${r.id}`"
          class="cmd-row"
        >
          <div class="cmd-row-head">
            <span class="cmd-type">{{ r.commandType }}</span>
            <span
              :data-test="`mc-status-${r.id}`"
              :class="['status-pill', statusClass(r.status)]"
            >
              <span class="dot"></span>{{ statusLabel(r.status) }}
            </span>
          </div>
          <div class="cmd-row-meta">
            <code class="hostname">{{ r.hostname }}</code>
            <span class="ts">{{ fmt(r.createdAt) }}</span>
          </div>
          <button
            type="button"
            :data-test="`mc-expand-${r.id}`"
            class="expand-btn"
            @click="toggle(r.id)"
          >{{ expanded[r.id] ? '收起 ▲' : '查看结果 ▼' }}</button>
          <pre
            v-if="expanded[r.id]"
            :data-test="`mc-result-${r.id}`"
            class="cmd-result"
          >{{ formatPayload(r) }}</pre>
        </li>
      </ul>
    </div>
  </aside>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch as vueWatch } from 'vue';
import { memberCommandsApi } from '../../api/member-commands.js';

const props = defineProps({
  hostname: { type: String, default: '' },
  // operatorId is reserved for future cross-host filtering — R81 spec
  // binds the drawer to a hostname, but the field is wired so a
  // follow-up "all my commands" toggle can reuse this component.
  operatorId: { type: [Number, String], default: null }
});

const rows = ref([]);
const expanded = reactive({});
const loading = ref(false);
const collapsed = ref(false);

const hasPending = computed(() =>
  rows.value.some(r => r.status === 'queued' || r.status === 'running')
);

let timer = null;

async function refresh() {
  loading.value = true;
  try {
    const params = { size: 50 };
    if (props.hostname) params.hostname = props.hostname;
    const r = await memberCommandsApi.listCommands(params);
    rows.value = Array.isArray(r.data?.rows) ? r.data.rows : [];
  } catch {
    // Last-resort: keep last rows. The unhandledrejection handler in
    // api/client.js will surface a toast for transient errors.
  } finally {
    loading.value = false;
  }
}

function schedule() {
  if (timer) clearInterval(timer);
  // Active cadence: 5s while pending. Idle: 30s. Same as R75 drawer.
  const cadence = hasPending.value ? 5000 : 30000;
  timer = setInterval(async () => {
    await refresh();
    if (hasPending.value !== (cadence === 5000)) {
      // Pending state flipped — reschedule with the new cadence.
      schedule();
    }
  }, cadence);
}

vueWatch(hasPending, () => { schedule(); });

// Re-fetch whenever the bound hostname changes (e.g. operator switches
// the picker). Mirrors the operator UX in MemberCommandsView: pick
// host → drawer auto-narrows.
vueWatch(() => props.hostname, () => { refresh(); });

function toggle(id) { expanded[id] = !expanded[id]; }

function statusClass(s) {
  if (s === 'success') return 'ok';
  if (s === 'failed') return 'err';
  if (s === 'timeout') return 'warn';
  if (s === 'running') return 'warn';
  return 'queued';
}

function statusLabel(s) {
  if (s === 'success') return '成功';
  if (s === 'failed') return '失败';
  if (s === 'timeout') return '超时';
  if (s === 'running') return '运行中';
  if (s === 'queued') return '排队中';
  return s || '—';
}

function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '—'; }

function redactSensitive(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactSensitive);
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (k === 'password' || k === 'newPassword' || k === 'oldPassword' || k === 'token') {
      out[k] = '***REDACTED***';
    } else if (v && typeof v === 'object') {
      out[k] = redactSensitive(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function formatPayload(r) {
  // Display params + result + error side-by-side. Passwords are already
  // stripped server-side before persistence (R81 service redactPasswords),
  // but we belt-and-suspender here too.
  const params = r.paramsJson || r.params || null;
  const result = r.resultJson || r.result || null;
  const lines = [];
  if (params) {
    lines.push('params:');
    lines.push(JSON.stringify(redactSensitive(params), null, 2));
  }
  if (result) {
    if (lines.length) lines.push('');
    lines.push('result:');
    lines.push(JSON.stringify(redactSensitive(result), null, 2));
  }
  if (r.errorMessage) {
    if (lines.length) lines.push('');
    lines.push(`error: ${r.errorMessage}`);
  }
  return lines.join('\n') || '(no payload)';
}

onMounted(async () => {
  await refresh();
  schedule();
});

onBeforeUnmount(() => {
  if (timer) { clearInterval(timer); timer = null; }
});
</script>

<style scoped>
.cmd-drawer {
  position: fixed;
  top: 60px;
  right: 0;
  bottom: 0;
  width: 380px;
  background: var(--panel);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  z-index: 50;
  transition: width 0.2s ease;
}
.cmd-drawer.collapsed { width: 32px; }

.cmd-drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-alt);
}
.cmd-drawer-head .title {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  font-weight: 700;
}
.cmd-drawer.collapsed .title { display: none; }

.collapse-btn {
  border: 1px solid var(--border);
  background: var(--input-bg);
  color: var(--text);
  padding: 2px 8px;
  border-radius: 3px;
  cursor: pointer;
  font-family: monospace;
}

.cmd-drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
}
.empty { color: var(--muted); padding: 12px 4px; font-size: 12px; }
.cmd-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }

.cmd-row {
  background: var(--input-bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}
.cmd-row-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.cmd-type {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 3px;
  background: rgba(96, 165, 250, 0.12);
  color: #60a5fa;
}
.cmd-row-meta { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 11px; }
.cmd-row-meta .hostname {
  color: var(--text); font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.status-pill {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 8px; border-radius: 10px;
  font-size: 10px; font-weight: 600;
}
.status-pill .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.status-pill.ok { background: rgba(34, 197, 94, 0.15); color: #16a34a; }
.status-pill.warn { background: rgba(234, 179, 8, 0.15); color: #ca8a04; }
.status-pill.err { background: rgba(239, 68, 68, 0.15); color: #dc2626; }
.status-pill.queued { background: rgba(107, 114, 128, 0.15); color: #6b7280; }

.expand-btn {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text);
  padding: 3px 8px;
  border-radius: 3px;
  font-size: 11px;
  cursor: pointer;
  align-self: flex-start;
}
.expand-btn:hover { background: var(--border); }

.cmd-result {
  background: #060d18;
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 6px 8px;
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 240px;
  overflow-y: auto;
}

@media (max-width: 1280px) {
  .cmd-drawer { width: 320px; }
}
@media (max-width: 1024px) {
  .cmd-drawer { width: 280px; }
}
</style>