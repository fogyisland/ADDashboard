<!--
  2026-08-31 R75 — GroupDeleteConfirmModal.vue.
  Confirmation requires operator to type the group Name.
  Submits `group_delete`.
  data-test: group-delete-confirm-modal / input / submit.
-->
<template>
  <div class="modal-bg" @click.self="cancel">
    <div class="modal" data-test="group-delete-confirm-modal">
      <header><h3>删除组 — {{ name }}</h3></header>
      <section class="form-body">
        <p class="warn-banner">
          ⚠ 警告：此操作不可撤销。AD 中该组及其全部属性将被永久删除。
        </p>
        <p class="hint">请输入组名 <code>{{ name }}</code> 以确认删除：</p>
        <label class="field">
          <span class="label">组名</span>
          <input
            data-test="group-delete-confirm-input"
            v-model="confirmInput"
            :disabled="submitting"
            autocomplete="off"
          />
        </label>
        <p v-if="error" class="error">{{ error }}</p>
        <p v-if="submitting && !resultMessage" class="hint">命令已发送到 DC · 命令 ID #{{ activeCommand?.id }}</p>
        <p v-if="submitting && timedOut" class="error">命令执行超时，正在查询状态…</p>
        <p v-if="resultMessage" :class="['result', resultOk ? 'ok' : 'err']" data-test="group-delete-confirm-result">{{ resultMessage }}</p>
      </section>
      <footer>
        <button type="button" data-test="group-delete-confirm-cancel" @click="cancel" :disabled="submitting">取消</button>
        <button
          type="button"
          data-test="group-delete-confirm-submit"
          class="danger"
          @click="submit"
          :disabled="submitting || confirmInput !== name || !props.targetDc"
          :title="!props.targetDc ? '请先选择目标 DC' : ''"
        >删除</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue';
import { adAdminApi } from '../../api/ad-admin.js';
import { useCommandPolling } from '../../composables/useCommandPolling.js';

const props = defineProps({
  targetDc: { type: String, required: true },
  name: { type: String, required: true }
});
const emit = defineEmits(['close', 'deleted']);

const confirmInput = ref('');
const error = ref('');
const submitting = ref(false);
const resultMessage = ref('');
const resultOk = ref(false);
const activeCommand = ref(null);
const timedOut = ref(false);

const polling = useCommandPolling(null, { intervalMs: 1500, timeoutMs: 30_000 });
watch(polling.timedOut, (v) => { if (v) timedOut.value = true; });
watch(polling.isTerminal, (terminal) => {
  if (!terminal) return;
  const r = polling.command.value;
  if (!r) return;
  if (r.status === 'success') {
    resultMessage.value = '已删除';
    resultOk.value = true;
    submitting.value = false;
    emit('deleted', r);
  } else {
    resultMessage.value = r.errorMessage || `命令${r.status}`;
    resultOk.value = false;
    submitting.value = false;
  }
});

async function submit() {
  if (confirmInput.value !== props.name) {
    error.value = '组名不匹配';
    return;
  }
  error.value = '';
  submitting.value = true;
  resultMessage.value = '';
  timedOut.value = false;
  try {
    const resp = await adAdminApi.queueCommand({
      targetDc: props.targetDc,
      commandType: 'group_delete',
      params: { name: props.name }
    });
    activeCommand.value = resp.data;
    polling.start(resp.data);
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || '提交失败';
    submitting.value = false;
  }
}

function cancel() {
  polling.stop();
  emit('close');
}
</script>

<style scoped>
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; min-width: 480px; max-width: 560px; max-height: 90vh; display: flex; flex-direction: column; }
.modal header { padding: 12px 18px; border-bottom: 1px solid var(--border); }
.modal header h3 { margin: 0; font-size: 15px; }
.form-body { padding: 14px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
.warn-banner { background: rgba(234, 179, 8, 0.15); color: #ca8a04; padding: 8px 12px; border-radius: 3px; border: 1px solid rgba(234, 179, 8, 0.3); font-size: 12px; margin: 0; }
.hint { color: var(--muted); font-size: 12px; margin: 0; }
.hint code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--input-bg); padding: 1px 4px; border-radius: 2px; font-size: 11px; color: var(--text); }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.field .label { color: var(--muted); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }
.field input { background: var(--input-bg); color: var(--text); border: 1px solid var(--border); border-radius: 3px; padding: 5px 8px; font-size: 13px; }
.field input:focus { outline: 2px solid var(--accent); border-color: var(--accent); }
.error { background: rgba(239, 68, 68, 0.15); color: #dc2626; padding: 6px 10px; border-radius: 3px; font-size: 12px; margin: 0; }
.result.ok { background: rgba(34, 197, 94, 0.15); color: #16a34a; padding: 6px 10px; border-radius: 3px; font-size: 12px; margin: 0; }
.result.err { background: rgba(239, 68, 68, 0.15); color: #dc2626; padding: 6px 10px; border-radius: 3px; font-size: 12px; margin: 0; }
.modal footer { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 18px; border-top: 1px solid var(--border); }
.modal footer button { padding: 6px 14px; border: 1px solid var(--border); background: var(--input-bg); color: var(--text); border-radius: 3px; cursor: pointer; font-size: 13px; }
.modal footer button.danger { background: var(--red); color: #0b1220; border-color: var(--red); }
.modal footer button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>