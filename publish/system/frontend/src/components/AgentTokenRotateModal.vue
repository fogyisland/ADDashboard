<template>
  <div v-if="visible" class="modal-bg" @click.self="$emit('close')">
    <div class="modal" data-test="agent-token-modal">
      <header><h3>{{ mode === 'view' ? 'Agent 令牌(当前)' : 'Agent 令牌已轮换' }}</h3></header>
      <section>
        <p class="warning" v-if="mode === 'rotate'">
          新令牌只在此对话框显示一次。立即复制并 RDP 到每台 agent 修改 <code>appsettings.json</code> 的 <code>agentToken</code> 字段,然后重启服务。
        </p>
        <p class="warning" v-else>
          这是当前生效的 Agent 令牌。复制后填入新 agent 的 <code>appsettings.json</code> 的 <code>agentToken</code> 字段;查看行为会写入审计日志。
        </p>
        <label class="token-display">
          <code data-test="new-token">{{ newToken }}</code>
          <button data-test="copy" @click="onCopy">{{ copied ? '已复制' : '复制' }}</button>
        </label>
        <p class="expiry" v-if="mode === 'rotate' && previousExpiresAt">
          旧令牌仍可用,直到 <strong>{{ formatTs(previousExpiresAt) }}</strong>({{ ttlDays }} 天 grace 窗口)。
        </p>
      </section>
      <footer>
        <button v-if="mode === 'rotate'" data-test="close" @click="$emit('close')">稍后处理</button>
        <button v-if="mode === 'rotate'" data-test="commit" class="primary" @click="onCommit" :disabled="committing">
          {{ committing ? '关闭中…' : '我已切换完,关闭旧令牌' }}
        </button>
        <button v-else data-test="close" @click="$emit('close')">关闭</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { adminApi } from '../api/admin.js';
import { notifyError } from '../lib/notify.js';

const props = defineProps({
  visible: { type: Boolean, default: false },
  // 'rotate' (default) = post-rotate flow that surfaces newToken and offers
  // a commit CTA to close the previous token's grace window. 'view' =
  // operator-initiated read of the active token — no commit CTA, no expiry
  // info, single close button.
  mode: { type: String, default: 'rotate' },
  newToken: { type: String, default: null },
  previousExpiresAt: { type: String, default: null },
  ttlDays: { type: Number, default: 30 }
});
const emit = defineEmits(['close', 'committed', 'copied']);

const copied = ref(false);
const committing = ref(false);

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