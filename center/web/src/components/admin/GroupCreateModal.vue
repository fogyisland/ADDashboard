<!--
  2026-08-31 R75 — GroupCreateModal.vue.
  Per spec §4.4 — fields: Name (required), SamAccountName (auto if blank),
  DisplayName, GroupCategory (radio: Security|Distribution), GroupScope
  (radio: DomainLocal|Global|Universal), Description, OU DN, Mail.
  Submits `group_create`.
  data-test: group-create-modal + per-field + submit.
-->
<template>
  <div class="modal-bg" @click.self="cancel">
    <div class="modal" data-test="group-create-modal">
      <header><h3>新建组</h3></header>
      <section class="form-body">
        <div class="row">
          <label class="field">
            <span class="label">名称 (Name) <em>*</em></span>
            <input data-test="group-create-name" v-model="form.name" :disabled="submitting" />
          </label>
          <label class="field">
            <span class="label">SamAccountName</span>
            <input data-test="group-create-sam" v-model="form.sam" :disabled="submitting" placeholder="留空 = Name" />
          </label>
        </div>
        <div class="row">
          <label class="field">
            <span class="label">显示名称</span>
            <input data-test="group-create-displayName" v-model="form.displayName" :disabled="submitting" />
          </label>
          <label class="field">
            <span class="label">邮件</span>
            <input data-test="group-create-mail" v-model="form.mail" :disabled="submitting" />
          </label>
        </div>
        <label class="field">
          <span class="label">OU DN (可选)</span>
          <input data-test="group-create-ouPath" v-model="form.ouPath" :disabled="submitting" placeholder="OU=Groups,DC=contoso,DC=local" />
        </label>
        <label class="field">
          <span class="label">描述</span>
          <input data-test="group-create-description" v-model="form.description" :disabled="submitting" />
        </label>
        <div class="radio-row">
          <div class="radio-group">
            <span class="label">类别 (Category)</span>
            <label class="radio"><input type="radio" data-test="group-create-category-Security" value="Security" v-model="form.category" :disabled="submitting" /> Security</label>
            <label class="radio"><input type="radio" data-test="group-create-category-Distribution" value="Distribution" v-model="form.category" :disabled="submitting" /> Distribution</label>
          </div>
          <div class="radio-group">
            <span class="label">范围 (Scope)</span>
            <label class="radio"><input type="radio" data-test="group-create-scope-DomainLocal" value="DomainLocal" v-model="form.scope" :disabled="submitting" /> DomainLocal</label>
            <label class="radio"><input type="radio" data-test="group-create-scope-Global" value="Global" v-model="form.scope" :disabled="submitting" /> Global</label>
            <label class="radio"><input type="radio" data-test="group-create-scope-Universal" value="Universal" v-model="form.scope" :disabled="submitting" /> Universal</label>
          </div>
        </div>
        <p v-if="formError" class="error">{{ formError }}</p>
        <p v-if="submitting && !resultMessage" class="hint">命令已发送到 DC · 命令 ID #{{ activeCommand?.id }}</p>
        <p v-if="submitting && timedOut" class="error">命令执行超时，正在查询状态…</p>
        <p v-if="resultMessage" :class="['result', resultOk ? 'ok' : 'err']" data-test="group-create-result">{{ resultMessage }}</p>
      </section>
      <footer>
        <button type="button" data-test="group-create-cancel" @click="cancel" :disabled="submitting">取消</button>
        <button type="button" data-test="group-create-submit" class="primary" @click="submit" :disabled="submitting || !canSubmit || !props.targetDc" :title="!props.targetDc ? '请先选择目标 DC' : ''">提交</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, reactive, watch } from 'vue';
import { adAdminApi } from '../../api/ad-admin.js';
import { useCommandPolling } from '../../composables/useCommandPolling.js';

const props = defineProps({
  targetDc: { type: String, required: true }
});
const emit = defineEmits(['close', 'submitted']);

const form = reactive({
  name: '',
  sam: '',
  displayName: '',
  mail: '',
  ouPath: '',
  description: '',
  category: 'Security',
  scope: 'Global'
});

const formError = ref('');
const submitting = ref(false);
const resultMessage = ref('');
const resultOk = ref(false);
const activeCommand = ref(null);
const timedOut = ref(false);

const canSubmit = computed(() => form.name.trim() && form.category && form.scope && !submitting.value);

const polling = useCommandPolling(null, { intervalMs: 1500, timeoutMs: 30_000 });
watch(polling.timedOut, (v) => { if (v) timedOut.value = true; });
watch(polling.isTerminal, (terminal) => {
  if (!terminal) return;
  const r = polling.command.value;
  if (!r) return;
  if (r.status === 'success') {
    resultMessage.value = `已创建 — ${r.result?.dn || form.name}`;
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
  if (!form.name.trim()) { formError.value = '名称不能为空'; return; }
  submitting.value = true;
  resultMessage.value = '';
  timedOut.value = false;
  try {
    const resp = await adAdminApi.queueCommand({
      targetDc: props.targetDc,
      commandType: 'group_create',
      params: {
        name: form.name.trim(),
        sam: form.sam.trim() || undefined,
        displayName: form.displayName.trim() || undefined,
        category: form.category,
        scope: form.scope,
        ouPath: form.ouPath.trim() || undefined,
        description: form.description.trim() || undefined,
        mail: form.mail.trim() || undefined
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
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; min-width: 580px; max-width: 720px; max-height: 90vh; display: flex; flex-direction: column; }
.modal header { padding: 12px 18px; border-bottom: 1px solid var(--border); }
.modal header h3 { margin: 0; font-size: 15px; }
.form-body { padding: 14px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
.row { display: flex; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 4px; flex: 1; font-size: 13px; }
.field .label { color: var(--muted); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }
.field .label em { color: var(--red); font-style: normal; margin-left: 2px; }
.field input { background: var(--input-bg); color: var(--text); border: 1px solid var(--border); border-radius: 3px; padding: 5px 8px; font-size: 13px; }
.field input:focus { outline: 2px solid var(--accent); border-color: var(--accent); }
.radio-row { display: flex; gap: 16px; flex-wrap: wrap; }
.radio-group { display: flex; flex-direction: column; gap: 4px; }
.radio-group .label { color: var(--muted); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }
.radio { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }
.hint { color: var(--muted); font-size: 11px; margin: 0; }
.error { background: rgba(239, 68, 68, 0.15); color: #dc2626; padding: 6px 10px; border-radius: 3px; border: 1px solid rgba(239, 68, 68, 0.3); font-size: 12px; margin: 0; }
.result.ok { background: rgba(34, 197, 94, 0.15); color: #16a34a; padding: 6px 10px; border-radius: 3px; font-size: 12px; margin: 0; }
.result.err { background: rgba(239, 68, 68, 0.15); color: #dc2626; padding: 6px 10px; border-radius: 3px; font-size: 12px; margin: 0; }
.modal footer { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 18px; border-top: 1px solid var(--border); }
.modal footer button { padding: 6px 14px; border: 1px solid var(--border); background: var(--input-bg); color: var(--text); border-radius: 3px; cursor: pointer; font-size: 13px; }
.modal footer button.primary { background: var(--accent); color: #0b1220; border-color: var(--accent); }
.modal footer button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>