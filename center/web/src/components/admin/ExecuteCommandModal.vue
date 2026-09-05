<!--
  2026-09-05 R81 — ExecuteCommandModal.vue.

  Mirrors R75 UserCreateModal: hosts the PS script editor + timeout
  picker + submit/cancel. Submits via `member_script` commandType, polls
  to terminal via useCommandPolling.

  Fields per R81 spec §3 + §6:
    hostname (required, pre-populated from caller via prop, read-only here)
    script (required, PowerShell body, max 32KB)
    timeoutSec (optional, default 30, range 5-60)
    forceOnline (checkbox, default false — bypass the heartbeat-online guard
                 with documented use case: offline diagnostics)

  data-test contract:
    exec-modal            — modal root
    exec-hostname          — host preview banner
    exec-script            — script textarea
    exec-timeout           — timeout select
    exec-force             — force-online checkbox
    exec-submit            — submit button
    exec-cancel            — cancel button
    exec-progress          — in-flight "已发送..." banner
    exec-result            — terminal success/failure banner
-->
<template>
  <div class="modal-bg" @click.self="cancel">
    <div class="modal" data-test="exec-modal">
      <header><h3>新建成员服务器 PowerShell 命令</h3></header>
      <section class="form-body">
        <div class="host-banner">
          <span class="label">目标主机</span>
          <code class="hostname" data-test="exec-hostname">{{ props.hostname }}</code>
        </div>

        <label class="field">
          <span class="label">PowerShell 脚本 <em>*</em></span>
          <textarea
            data-test="exec-script"
            v-model="form.script"
            :disabled="submitting"
            placeholder="例如: Get-Service | Where-Object { $_.Status -eq 'Running' } | Select-Object -First 10"
            rows="10"
            spellcheck="false"
            @input="onScriptInput"
          ></textarea>
          <small class="size-hint" :class="{ over: scriptBytes > SCRIPT_MAX_BYTES }">
            脚本大小: {{ formatBytes(scriptBytes) }} / {{ formatBytes(SCRIPT_MAX_BYTES) }}
          </small>
        </label>

        <div class="row">
          <label class="field">
            <span class="label">超时 (秒)</span>
            <select data-test="exec-timeout" v-model.number="form.timeoutSec" :disabled="submitting">
              <option v-for="s in TIMEOUT_OPTIONS" :key="s" :value="s">{{ s }} 秒</option>
            </select>
          </label>
          <label class="field checkbox-field">
            <input
              type="checkbox"
              data-test="exec-force"
              v-model="form.force"
              :disabled="submitting"
            />
            <span>跳过在线检查 (目标主机心跳 ≥ 5 分钟内仍可执行)</span>
          </label>
        </div>

        <p v-if="formError" class="error">{{ formError }}</p>
        <p v-if="submitting" class="hint" data-test="exec-progress">
          命令已发送到 {{ props.hostname }} · 命令 ID #{{ activeCommand?.id }} · 等待结果…
        </p>
        <p v-if="submitting && timedOut" class="error">命令执行超时，正在查询状态…</p>
        <p v-if="resultMessage" :class="['result', resultOk ? 'ok' : 'err']" data-test="exec-result">
          {{ resultMessage }}
        </p>
      </section>
      <footer>
        <button type="button" data-test="exec-cancel" @click="cancel" :disabled="submitting">取消</button>
        <button
          type="button"
          data-test="exec-submit"
          class="primary"
          @click="submit"
          :disabled="submitting || !canSubmit"
        >提交</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, reactive, watch } from 'vue';
import { memberCommandsApi } from '../../api/member-commands.js';
import { useCommandPolling } from '../../composables/useCommandPolling.js';

const props = defineProps({
  hostname: { type: String, required: true }
});
const emit = defineEmits(['close', 'submitted']);

// R81 spec §3 guard rails mirrored client-side for fast UX feedback.
const SCRIPT_MAX_BYTES = 32 * 1024;
const TIMEOUT_OPTIONS = [5, 10, 15, 20, 30, 45, 60];

const form = reactive({
  script: '',
  timeoutSec: 30,
  force: false
});

const formError = ref('');
const submitting = ref(false);
const resultMessage = ref('');
const resultOk = ref(false);
const activeCommand = ref(null);
const timedOut = ref(false);

// Byte size is the on-the-wire size (UTF-8). TextEncoder gives us the
// authoritative byte count — for ASCII it's == .length, but a multibyte
// script (e.g. with Chinese comments) would otherwise pass the char
// check while exceeding the 32KB wire limit.
const scriptBytes = computed(() => {
  try { return new TextEncoder().encode(form.script).length; }
  catch { return form.script.length; }
});

const canSubmit = computed(() =>
  form.script.trim().length > 0
  && scriptBytes.value <= SCRIPT_MAX_BYTES
  && TIMEOUT_OPTIONS.includes(form.timeoutSec)
  && !submitting.value
);

function onScriptInput() {
  // Clear stale error when the user edits after a submit attempt.
  if (formError.value && formError.value.startsWith('脚本')) formError.value = '';
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function validateLocal() {
  if (!form.script.trim()) return '脚本不能为空';
  if (scriptBytes.value > SCRIPT_MAX_BYTES) return `脚本超过 ${formatBytes(SCRIPT_MAX_BYTES)} 上限`;
  if (!TIMEOUT_OPTIONS.includes(form.timeoutSec)) return '超时必须在 5-60 秒之间';
  return null;
}

const polling = useCommandPolling(null, { intervalMs: 1500, timeoutMs: 35_000 });
watch(polling.timedOut, (v) => { if (v) timedOut.value = true; });
watch(polling.isTerminal, (terminal) => {
  if (!terminal) return;
  const r = polling.command.value;
  if (!r) return;
  if (r.status === 'success') {
    const dur = r.result?.durationMs != null ? `${r.result.durationMs}ms` : '?';
    resultMessage.value = `执行成功 · 退出码 ${r.exitCode ?? 0} · ${dur}`;
    resultOk.value = true;
    submitting.value = false;
    emit('submitted', r);
  } else {
    resultMessage.value = r.errorMessage || `命令${r.status}`;
    resultOk.value = false;
    submitting.value = false;
  }
});

async function submit() {
  formError.value = '';
  const v = validateLocal();
  if (v) { formError.value = v; return; }
  submitting.value = true;
  resultMessage.value = '';
  timedOut.value = false;
  try {
    const resp = await memberCommandsApi.queueCommand({
      hostname: props.hostname,
      commandType: 'member_script',
      params: {
        script: form.script,
        timeoutSec: form.timeoutSec,
        force: form.force
      }
    });
    activeCommand.value = resp.data;
    polling.start(resp.data);
  } catch (e) {
    formError.value = e?.response?.data?.error || e?.message || '提交失败';
    submitting.value = false;
  }
}

function cancel() {
  polling.stop();
  emit('close');
}
</script>

<style scoped>
.modal-bg {
  position: fixed; inset: 0; background: rgba(0,0,0,0.55);
  display: flex; align-items: center; justify-content: center; z-index: 1000;
}
.modal {
  background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
  min-width: 640px; max-width: 800px; max-height: 90vh;
  display: flex; flex-direction: column;
}
.modal header { padding: 12px 18px; border-bottom: 1px solid var(--border); }
.modal header h3 { margin: 0; font-size: 15px; }
.form-body { padding: 14px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }

.host-banner {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; background: var(--input-bg); border: 1px solid var(--border);
  border-radius: 3px;
}
.host-banner .label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
.host-banner .hostname {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--accent); font-size: 13px; font-weight: 600;
}

.row { display: flex; gap: 12px; align-items: flex-end; }
.field { display: flex; flex-direction: column; gap: 4px; flex: 1; font-size: 13px; }
.field .label { color: var(--muted); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }
.field .label em { color: var(--red); font-style: normal; margin-left: 2px; }
.field input, .field select, .field textarea {
  background: var(--input-bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 3px;
  padding: 5px 8px; font-size: 13px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.field textarea {
  resize: vertical;
  min-height: 180px;
  line-height: 1.4;
  white-space: pre;
}
.field input:focus, .field select:focus, .field textarea:focus {
  outline: 2px solid var(--accent); border-color: var(--accent);
}
.field input:disabled, .field select:disabled, .field textarea:disabled { opacity: 0.6; }

.checkbox-field { flex-direction: row; align-items: center; gap: 8px; min-width: 280px; }
.checkbox-field span { font-size: 12px; color: var(--text); }

.size-hint { font-size: 11px; color: var(--muted); margin-top: 2px; }
.size-hint.over { color: var(--red); font-weight: 600; }

.hint { color: var(--muted); font-size: 11px; margin: 0; }
.error {
  background: rgba(239, 68, 68, 0.15); color: #dc2626;
  padding: 6px 10px; border-radius: 3px;
  border: 1px solid rgba(239, 68, 68, 0.3);
  font-size: 12px; margin: 0;
}
.result.ok { background: rgba(34, 197, 94, 0.15); color: #16a34a; padding: 6px 10px; border-radius: 3px; font-size: 12px; margin: 0; }
.result.err { background: rgba(239, 68, 68, 0.15); color: #dc2626; padding: 6px 10px; border-radius: 3px; font-size: 12px; margin: 0; }

.modal footer {
  display: flex; gap: 8px; justify-content: flex-end;
  padding: 12px 18px; border-top: 1px solid var(--border);
}
.modal footer button {
  padding: 6px 14px; border: 1px solid var(--border);
  background: var(--input-bg); color: var(--text); border-radius: 3px;
  cursor: pointer; font-size: 13px;
}
.modal footer button.primary { background: var(--accent); color: #0b1220; border-color: var(--accent); }
.modal footer button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>