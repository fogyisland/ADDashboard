<!--
  2026-08-31 R75 — GroupPropertiesModal.vue.
  Per spec §4.4 — fields: DisplayName, Description, ManagedBy (picker),
  Mail, Notes (info), GroupCategory, GroupScope.
  Submits `group_set_attributes`.
  data-test: group-properties-modal + per-field + submit.
-->
<template>
  <div class="modal-bg" @click.self="cancel">
    <div class="modal" data-test="group-properties-modal">
      <header><h3>设置组属性 — {{ name }}</h3></header>
      <section class="form-body">
        <div class="row">
          <label class="field">
            <span class="label">显示名称</span>
            <input data-test="group-properties-displayName" v-model="form.displayName" :disabled="submitting" />
          </label>
          <label class="field">
            <span class="label">邮件</span>
            <input data-test="group-properties-mail" v-model="form.mail" :disabled="submitting" />
          </label>
        </div>
        <label class="field">
          <span class="label">描述</span>
          <input data-test="group-properties-description" v-model="form.description" :disabled="submitting" />
        </label>
        <label class="field">
          <span class="label">备注 (Info / Notes)</span>
          <input data-test="group-properties-info" v-model="form.info" :disabled="submitting" />
        </label>
        <label class="field">
          <span class="label">ManagedBy (DN 或 sAMAccountName)</span>
          <UserPickerMini
            :target-dc="targetDc"
            :initial-sam="form.managedBy"
            @pick="onManagedByPick"
          />
        </label>
        <div class="radio-row">
          <div class="radio-group">
            <span class="label">类别 (Category)</span>
            <label class="radio"><input type="radio" data-test="group-properties-category-Security" value="Security" v-model="form.category" :disabled="submitting" /> Security</label>
            <label class="radio"><input type="radio" data-test="group-properties-category-Distribution" value="Distribution" v-model="form.category" :disabled="submitting" /> Distribution</label>
          </div>
          <div class="radio-group">
            <span class="label">范围 (Scope)</span>
            <label class="radio"><input type="radio" data-test="group-properties-scope-DomainLocal" value="DomainLocal" v-model="form.scope" :disabled="submitting" /> DomainLocal</label>
            <label class="radio"><input type="radio" data-test="group-properties-scope-Global" value="Global" v-model="form.scope" :disabled="submitting" /> Global</label>
            <label class="radio"><input type="radio" data-test="group-properties-scope-Universal" value="Universal" v-model="form.scope" :disabled="submitting" /> Universal</label>
          </div>
        </div>
        <p v-if="formError" class="error">{{ formError }}</p>
        <p v-if="submitting && !resultMessage" class="hint">命令已发送到 DC · 命令 ID #{{ activeCommand?.id }}</p>
        <p v-if="submitting && timedOut" class="error">命令执行超时，正在查询状态…</p>
        <p v-if="resultMessage" :class="['result', resultOk ? 'ok' : 'err']" data-test="group-properties-result">{{ resultMessage }}</p>
      </section>
      <footer>
        <button type="button" data-test="group-properties-cancel" @click="cancel" :disabled="submitting">取消</button>
        <button type="button" data-test="group-properties-submit" class="primary" @click="submit" :disabled="submitting">提交</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue';
import { adAdminApi } from '../../api/ad-admin.js';
import UserPickerMini from './UserPickerMini.vue';

const props = defineProps({
  targetDc: { type: String, required: true },
  name: { type: String, required: true },
  initial: { type: Object, default: () => ({}) }
});
const emit = defineEmits(['close', 'submitted']);

const form = reactive({
  displayName: props.initial.displayName || '',
  description: props.initial.description || '',
  mail: props.initial.mail || '',
  info: props.initial.info || '',
  managedBy: props.initial.managedBy || '',
  category: props.initial.category || 'Security',
  scope: props.initial.scope || 'Global'
});

const formError = ref('');
const submitting = ref(false);
const resultMessage = ref('');
const resultOk = ref(false);
const activeCommand = ref(null);
const timedOut = ref(false);

let pollHandle = null;

function onManagedByPick(u) {
  form.managedBy = u?.sam || '';
}

async function submit() {
  formError.value = '';
  submitting.value = true;
  resultMessage.value = '';
  timedOut.value = false;
  try {
    const resp = await adAdminApi.queueCommand({
      targetDc: props.targetDc,
      commandType: 'group_set_attributes',
      params: {
        name: props.name,
        attributes: {
          displayName: form.displayName || undefined,
          description: form.description || undefined,
          managedBy: form.managedBy || undefined,
          mail: form.mail || undefined,
          info: form.info || undefined,
          category: form.category,
          scope: form.scope
        }
      }
    });
    activeCommand.value = resp.data;
    const deadline = setTimeout(() => { if (!resultMessage.value) timedOut.value = true; }, 30_000);
    pollHandle = setInterval(async () => {
      try {
        const r = await adAdminApi.getCommand(activeCommand.value.id);
        const st = r.data?.status;
        if (st === 'success') {
          const fields = r.data?.resultJson?.updatedFields || [];
          resultMessage.value = `已更新 — ${fields.join(', ') || '无变化'}`;
          resultOk.value = true;
          clearInterval(pollHandle); pollHandle = null;
          clearTimeout(deadline);
          submitting.value = false;
          emit('submitted', r.data);
          return;
        }
        if (st === 'failed' || st === 'timeout') {
          resultMessage.value = r.data?.errorMessage || `命令${st}`;
          resultOk.value = false;
          clearInterval(pollHandle); pollHandle = null;
          clearTimeout(deadline);
          submitting.value = false;
        }
      } catch { /* keep polling */ }
    }, 1500);
  } catch (e) {
    formError.value = e?.response?.data?.error || e?.message || '提交失败';
    submitting.value = false;
  }
}

function cancel() {
  if (pollHandle) clearInterval(pollHandle);
  emit('close');
}
</script>

<style scoped>
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; min-width: 620px; max-width: 760px; max-height: 90vh; display: flex; flex-direction: column; }
.modal header { padding: 12px 18px; border-bottom: 1px solid var(--border); }
.modal header h3 { margin: 0; font-size: 15px; }
.form-body { padding: 14px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
.row { display: flex; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 4px; flex: 1; font-size: 13px; }
.field .label { color: var(--muted); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }
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