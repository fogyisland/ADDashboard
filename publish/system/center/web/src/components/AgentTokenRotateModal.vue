<template>
  <div v-if="visible" class="modal-bg" @click.self="$emit('close')">
    <div class="modal" data-test="agent-token-modal">
      <header><h3>{{ headerText }}</h3></header>
      <section>
        <!-- generate mode (2026-08-21 UX redesign, auto-delivery): new
             token shown once for copy-to-fresh-agent use; operators no
             longer RDP-around-and-edit because agents pick up the new
             credential on their next heartbeat via the version counter. -->
        <p class="warning" v-if="mode === 'generate'">
          新令牌只在此对话框显示一次。新装/离线 agent 复制后填入 <code>appsettings.json</code> 的 <code>agentToken</code> 字段即可;已联机的 agent 会在下次心跳自动切换。
        </p>
        <p class="warning" v-else-if="mode === 'rotate'">
          新令牌只在此对话框显示一次。立即复制并 RDP 到每台 agent 修改 <code>appsettings.json</code> 的 <code>agentToken</code> 字段,然后重启服务。
        </p>
        <p class="warning" v-else>
          这是当前生效的 Agent 令牌。复制后填入新 agent 的 <code>appsettings.json</code> 的 <code>agentToken</code> 字段;查看行为会写入审计日志。
        </p>
        <label class="token-display">
          <code data-test="new-token">{{ newToken }}</code>
          <button data-test="copy" @click="onCopy">{{ copied ? '已复制' : '复制' }}</button>
        </label>

        <!-- generate-mode-only: live delivery counter. Polled every 2s.
             "已推送到 X / N 台 Agent" + a list of agents still on the old
             version (lastSeenAt gives the operator a hint about whether
             the agent is offline or just hasn't heartbeated yet). -->
        <div v-if="mode === 'generate'" class="delivery" data-test="delivery-progress">
          <div class="delivery-summary">
            已推送到 <strong data-test="delivery-delivered">{{ deliveryDelivered }}</strong>
            / <span data-test="delivery-total">{{ deliveryTotal }}</span> 台 Agent
            <span v-if="deliveryTotal > 0" class="delivery-percent">
              ({{ Math.round((deliveryDelivered / deliveryTotal) * 100) }}%)
            </span>
          </div>
          <div v-if="pendingAgents.length > 0" class="delivery-pending" data-test="delivery-pending">
            <div class="delivery-pending-head">待推送 ({{ pendingAgents.length }})</div>
            <ul>
              <li v-for="a in pendingAgents" :key="a.agentId">
                <code>{{ a.agentId }}</code>
                <span class="muted">v{{ a.reportedVersion }} → v{{ deliveryServerVersion }}</span>
                <span v-if="a.lastSeenAt" class="muted">· {{ formatRelative(a.lastSeenAt) }}</span>
              </li>
            </ul>
          </div>
          <div v-else-if="deliveryTotal > 0" class="delivery-done" data-test="delivery-done">
            ✓ 全部 Agent 已接收新令牌
          </div>
        </div>

        <p class="expiry" v-if="mode === 'rotate' && previousExpiresAt">
          旧令牌仍可用,直到 <strong>{{ formatTs(previousExpiresAt) }}</strong>({{ ttlDays }} 天 grace 窗口)。
        </p>
      </section>
      <footer>
        <button v-if="mode === 'rotate'" data-test="close" @click="$emit('close')">稍后处理</button>
        <button v-if="mode === 'rotate'" data-test="commit" class="primary" @click="onCommit" :disabled="committing">
          {{ committing ? '关闭中…' : '我已切换完,关闭旧令牌' }}
        </button>
        <button v-else data-test="close" @click="$emit('close')">{{ closeLabel }}</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onUnmounted } from 'vue';
import { adminApi } from '../api/admin.js';
import { notifyError } from '../lib/notify.js';

const props = defineProps({
  visible: { type: Boolean, default: false },
  // 'generate' (default, 2026-08-21): post-rotate flow that surfaces
  // newToken + polls delivery progress; no commit CTA — auto-delivery
  // replaces the operator's manual RDP-and-edit. 'rotate' (legacy dual-key
  // flow): expiry line + commit CTA. 'view' (legacy): operator-initiated
  // read of the active token — single close button.
  mode: { type: String, default: 'generate' },
  newToken: { type: String, default: null },
  previousExpiresAt: { type: String, default: null },
  ttlDays: { type: Number, default: 30 }
});
const emit = defineEmits(['close', 'committed', 'copied']);

const copied = ref(false);
const committing = ref(false);

// generate-mode polling state.
const deliveryDelivered = ref(0);
const deliveryTotal = ref(0);
const deliveryServerVersion = ref(0);
const pendingAgents = ref([]);
let pollTimer = null;

const headerText = computed(() => {
  if (props.mode === 'view') return 'Agent 令牌(当前)';
  return 'Agent 令牌已生成';
});

const closeLabel = computed(() => {
  if (props.mode === 'generate' && deliveryDelivered.value === deliveryTotal.value && deliveryTotal.value > 0) {
    return '完成';
  }
  return '关闭';
});

function onCopy() {
  // navigator.clipboard.writeText can fail in non-secure-context jsdom —
  // the modal is shown after a successful rotate and the token is in
  // memory anyway, so a failure to copy is non-fatal. Notify + emit so
  // the operator can fall back to manual select-and-copy.
  if (!props.newToken) return;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(props.newToken).then(
      () => { copied.value = true; emit('copied', { token: props.newToken }); },
      () => fallbackCopy()
    );
  } else {
    fallbackCopy();
  }
}

function fallbackCopy() {
  copied.value = true;
  emit('copied', { token: props.newToken });
  notifyError('剪贴板不可用,请手动选中复制');
}

async function onCommit() {
  committing.value = true;
  try {
    await adminApi.commitAgentToken();
    emit('committed');
    emit('close');
  } catch (e) {
    notifyError(`关闭旧令牌失败: ${e?.response?.data?.error || e?.message || '未知错误'}`);
  } finally {
    committing.value = false;
  }
}

function formatTs(s) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString();
}

// "3 分钟前" / "刚刚" relative time for the pending-agents list. The
// server returns lastSeenAt as ISO so a Date parse is safe.
function formatRelative(iso) {
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  if (!isFinite(ms) || ms < 0) return iso;
  const sec = Math.floor(ms / 1000);
  if (sec < 30) return '刚刚';
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  return `${day} 天前`;
}

async function pollDelivery() {
  // Two reasons we might want to stop early: (1) all delivered — nothing
  // left to count, polling is wasted; (2) no agents at all — server is
  // the only "thing" with a token, never changes. The 2s interval keeps
  // the UI live without hammering the server during the typical 5-min
  // grace window; agents heartbeat every 5s by default so a 2s poll
  // catches a delivery within ~2 heartbeat ticks.
  if (props.mode !== 'generate') return;
  try {
    const r = await adminApi.getAgentTokenDelivery();
    const d = r.data || {};
    deliveryDelivered.value = Number(d.delivered) || 0;
    deliveryTotal.value = Number(d.total) || 0;
    deliveryServerVersion.value = Number(d.serverVersion) || 0;
    pendingAgents.value = Array.isArray(d.agents)
      ? d.agents.filter((a) => Number(a.reportedVersion) < deliveryServerVersion.value)
      : [];
  } catch {
    // Polling is best-effort. A failure here means the operator sees a
    // stale counter until the next successful tick — not worth a toast.
  }
}

function startPolling() {
  stopPolling();
  // Kick off an immediate fetch so the modal shows a real count instead
  // of "0 / 0" for the first 2s after opening.
  pollDelivery();
  pollTimer = setInterval(pollDelivery, 2000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// React to visible+mode transitions. We start polling when the modal
// opens in generate mode and stop the moment it closes — regardless of
// whether the operator clicked the close button or the modal is being
// torn down. `immediate: true` is required because the watch source
// (props.visible, props.mode) is set at mount time and won't change
// for a modal that opens directly into generate mode; without it the
// operator would stare at "0 / 0" for the first 2s while the timer
// waits to fire.
watch(
  () => [props.visible, props.mode],
  ([v, m]) => {
    if (v && m === 'generate') startPolling();
    else stopPolling();
  },
  { immediate: true }
);

onUnmounted(stopPolling);
</script>

<style scoped>
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal { background: var(--panel); padding: 1.5em 1.8em; border-radius: 6px; max-width: 560px; min-width: 420px; border: 1px solid #1e293b; }
.modal header h3 { margin: 0 0 12px; font-size: 15px; color: var(--text); }
.warning { color: #f59e0b; font-size: 13px; margin: 0 0 14px; }
.warning code { background: #0b1220; padding: 1px 4px; border-radius: 2px; font-size: 12px; }
.token-display { display: flex; align-items: stretch; gap: 8px; margin: 12px 0; }
.token-display code {
  flex: 1;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  background: #0b1220;
  padding: 8px 10px;
  border-radius: 3px;
  border: 1px solid #334155;
  word-break: break-all;
  color: var(--accent);
}
.token-display button {
  padding: 6px 14px;
  border: 1px solid #1e293b;
  background: var(--accent);
  color: #0b1220;
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
}
.expiry { color: var(--muted); font-size: 12px; margin-top: 12px; }
.expiry strong { color: var(--text); }

/* generate-mode-only delivery progress. The summary line shows the
   "X / N" counter; the pending list (collapsible-by-css since the
   server already filters to <currentVersion agents) helps the
   operator identify which agents are offline vs just-behind. */
.delivery {
  margin-top: 14px;
  padding: 10px 12px;
  background: #0b1220;
  border: 1px solid #1e293b;
  border-radius: 3px;
  font-size: 12px;
}
.delivery-summary { color: var(--text); }
.delivery-summary strong { color: var(--accent); font-size: 14px; }
.delivery-percent { color: var(--muted); margin-left: 4px; }
.delivery-done { color: #22c55e; margin-top: 8px; }
.delivery-pending { margin-top: 10px; }
.delivery-pending-head { color: var(--muted); font-size: 11px; margin-bottom: 6px; }
.delivery-pending ul { list-style: none; padding: 0; margin: 0; max-height: 140px; overflow-y: auto; }
.delivery-pending li {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 3px 0;
  border-bottom: 1px solid #1e293b;
  font-size: 11px;
}
.delivery-pending li:last-child { border-bottom: none; }
.delivery-pending code { background: #1e293b; padding: 1px 6px; border-radius: 2px; color: var(--text); font-size: 11px; }
.delivery-pending .muted { color: var(--muted); font-size: 10px; }

.modal footer { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
.modal footer button {
  padding: 6px 14px;
  border: 1px solid #1e293b;
  background: #0b1220;
  color: var(--text);
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
}
.modal footer button.primary { background: var(--accent); color: #0b1220; }
.modal footer button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>