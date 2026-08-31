<!--
  2026-08-31 R75 — AD 命令历史抽屉 (right-side drawer).

  Polls GET /api/admin/ad-commands?operatorId=current every 5s and
  renders the last 20 commands newest first. Each row expands to show
  the JSON payload (params + result, with passwords redacted).

  data-test contract (matched by tests/ad-command-history-drawer.test.js):
    cmd-row-${id}        — one row per command
    cmd-status-${id}     — status pill on the row
    cmd-expand-${id}     — caret/expand toggle
    cmd-result-${id}     — expanded JSON payload block

  Usage (in UserManagementView / GroupManagementView):
    <AdCommandHistoryDrawer :operator-id="auth.user.id" />

  Refresh cadence: every 5s while at least one row is queued/running,
  otherwise every 30s (idle cadence). On unmount the timer is cleared.
-->
<template>
  <aside class="cmd-drawer" :class="{ collapsed }">
    <header class="cmd-drawer-head">
      <span class="title">命令历史</span>
      <button
        type="button"
        class="collapse-btn"
        :data-test="'drawer-collapse'"
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
          :data-test="`cmd-row-${r.id}`"
          class="cmd-row"
        >
          <div class="cmd-row-head">
            <span class="cmd-type">{{ r.commandType }}</span>
            <span
              :data-test="`cmd-status-${r.id}`"
              :class="['status-pill', statusClass(r.status)]"
            >
              <span class="dot"></span>{{ statusLabel(r.status) }}
            </span>
          </div>
          <div class="cmd-row-meta">
            <code class="target-dc">{{ r.targetDc }}</code>
            <span class="ts">{{ fmt(r.createdAt) }}</span>
          </div>
          <button
            type="button"
            :data-test="`cmd-expand-${r.id}`"
            class="expand-btn"
            @click="toggle(r.id)"
          >{{ expanded[r.id] ? '收起 ▲' : '查看结果 ▼' }}</button>
          <pre
            v-if="expanded[r.id]"
            :data-test="`cmd-result-${r.id}`"
            class="cmd-result"
          >{{ formatPayload(r) }}</pre>
        </li>
      </ul>
    </div>
  </aside>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch as vueWatch } from 'vue';
import { adAdminApi } from '../../api/ad-admin.js';

const props = defineProps({
  operatorId: { type: [Number, String], required: true }
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
    const r = await adAdminApi.listCommands({ operatorId: props.operatorId, size: 50 });
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
  // Active cadence: 5s while pending. Idle: 30s. R75 spec §4.5.
  const cadence = hasPending.value ? 5000 : 30000;
  timer = setInterval(async () => {
    await refresh();
    if (hasPending.value !== (cadence === 5000)) {
      // Pending state flipped — reschedule with the new cadence.
      schedule();
    }
  }, cadence);
}

// React to the pending-state transition (computed changes mid-life):
// we re-arm the interval timer whenever the pending-set changes shape.
vueWatch(hasPending, () => { schedule(); });

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

function redactPasswords(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactPasswords);
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (k === 'password' || k === 'newPassword') {
      out[k] = '***REDACTED***';
    } else if (v && typeof v === 'object') {
      out[k] = redactPasswords(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function formatPayload(r) {
  // We display the params and result JSON side-by-side. Passwords are
  // already stripped server-side before persistence (R75 audit-classifier
  // ruling), but we belt-and-suspender the redaction here too.
  const params = r.paramsJson || r.params || null;
  const result = r.resultJson || r.result || null;
  const lines = [];
  if (params) {
    lines.push('params:');
    lines.push(JSON.stringify(redactPasswords(params), null, 2));
  }
  if (result) {
    if (lines.length) lines.push('');
    lines.push('result:');
    lines.push(JSON.stringify(redactPasswords(result), null, 2));
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
.cmd-row-meta .target-dc { color: var(--text); font-size: 11px; }

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