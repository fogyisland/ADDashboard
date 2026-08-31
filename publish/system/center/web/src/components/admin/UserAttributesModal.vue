<!--
  2026-08-31 R75 — UserAttributesModal.vue.
  Per spec §4.3 — fields: DisplayName, GivenName, Surname, UPN, Email,
  TelephoneNumber, Title, Department, Manager (picker), Description.
  Submits via `user_set_attributes`.
  data-test contract: user-attributes-modal + per-field + submit.
-->
<template>
  <div class="modal-bg" @click.self="cancel">
    <div class="modal" data-test="user-attributes-modal">
      <header><h3>编辑属性 — {{ sam }}</h3></header>
      <section class="form-body">
        <div class="row">
          <label class="field">
            <span class="label">显示名称</span>
            <input data-test="user-attributes-displayName" v-model="form.displayName" :disabled="submitting" />
          </label>
          <label class="field">
            <span class="label">UPN</span>
            <input data-test="user-attributes-upn" v-model="form.upn" :disabled="submitting" />
          </label>
        </div>
        <div class="row">
          <label class="field">
            <span class="label">名</span>
            <input data-test="user-attributes-givenName" v-model="form.givenName" :disabled="submitting" />
          </label>
          <label class="field">
            <span class="label">姓</span>
            <input data-test="user-attributes-surname" v-model="form.surname" :disabled="submitting" />
          </label>
        </div>
        <div class="row">
          <label class="field">
            <span class="label">邮件</span>
            <input data-test="user-attributes-email" v-model="form.email" :disabled="submitting" />
          </label>
          <label class="field">
            <span class="label">电话</span>
            <input data-test="user-attributes-telephoneNumber" v-model="form.telephoneNumber" :disabled="submitting" />
          </label>
        </div>
        <div class="row">
          <label class="field">
            <span class="label">职务</span>
            <input data-test="user-attributes-title" v-model="form.title" :disabled="submitting" />
          </label>
          <label class="field">
            <span class="label">部门</span>
            <input data-test="user-attributes-department" v-model="form.department" :disabled="submitting" />
          </label>
        </div>
        <label class="field">
          <span class="label">Manager (DN 或 sAMAccountName)</span>
          <UserPickerMini
            :target-dc="targetDc"
            :initial-sam="form.manager"
            @pick="onManagerPick"
          />
        </label>
        <label class="field">
          <span class="label">描述</span>
          <input data-test="user-attributes-description" v-model="form.description" :disabled="submitting" />
        </label>
        <p v-if="formError" class="error">{{ formError }}</p>
        <p v-if="submitting && !resultMessage" class="hint">命令已发送到 DC · 命令 ID #{{ activeCommand?.id }}</p>
        <p v-if="submitting && timedOut" class="error">命令执行超时，正在查询状态…</p>
        <p v-if="resultMessage" :class="['result', resultOk ? 'ok' : 'err']" data-test="user-attributes-result">{{ resultMessage }}</p>
      </section>
      <footer>
        <button type="button" data-test="user-attributes-cancel" @click="cancel" :disabled="submitting">取消</button>
        <button type="button" data-test="user-attributes-submit" class="primary" @click="submit" :disabled="submitting">提交</button>
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
  sam: { type: String, required: true },
  initial: { type: Object, default: () => ({}) }
});
const emit = defineEmits(['close', 'submitted']);

const form = reactive({
  displayName: props.initial.displayName || '',
  upn: props.initial.upn || props.initial.userPrincipalName || '',
  givenName: props.initial.givenName || '',
  surname: props.initial.surname || '',
  email: props.initial.mail || props.initial.email || '',
  telephoneNumber: props.initial.telephoneNumber || '',
  title: props.initial.title || '',
  department: props.initial.department || '',
  manager: props.initial.manager || '',
  description: props.initial.description || ''
});

const formError = ref('');
const submitting = ref(false);
const resultMessage = ref('');
const resultOk = ref(false);
const activeCommand = ref(null);
const timedOut = ref(false);

let pollHandle = null;

function onManagerPick(u) {
  // UserPickerMini emits the matched user object; we keep just the SAM
  // for the audit + server payload (server resolves to DN if needed).
  form.manager = u?.sam || '';
}

function buildAttrs() {
  const attrs = {};
  if (form.displayName) attrs.displayName = form.displayName;
  if (form.mail !== undefined || form.email) attrs.mail = form.email || undefined;
  if (form.telephoneNumber) attrs.telephoneNumber = form.telephoneNumber;
  if (form.title) attrs.title = form.title;
  if (form.department) attrs.department = form.department;
  if (form.manager) attrs.manager = form.manager;
  return attrs;
}

async function submit() {
  formError.value = '';
  submitting.value = true;
  resultMessage.value = '';
  timedOut.value = false;
  try {
    const resp = await adAdminApi.queueCommand({
      targetDc: props.targetDc,
      commandType: 'user_set_attributes',
      params: { sam: props.sam, attributes: buildAttrs(), description: form.description || undefined }
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
.hint { color: var(--muted); font-size: 11px; margin: 0; }
.error { background: rgba(239, 68, 68, 0.15); color: #dc2626; padding: 6px 10px; border-radius: 3px; border: 1px solid rgba(239, 68, 68, 0.3); font-size: 12px; margin: 0; }
.result.ok { background: rgba(34, 197, 94, 0.15); color: #16a34a; padding: 6px 10px; border-radius: 3px; font-size: 12px; margin: 0; }
.result.err { background: rgba(239, 68, 68, 0.15); color: #dc2626; padding: 6px 10px; border-radius: 3px; font-size: 12px; margin: 0; }
.modal footer { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 18px; border-top: 1px solid var(--border); }
.modal footer button { padding: 6px 14px; border: 1px solid var(--border); background: var(--input-bg); color: var(--text); border-radius: 3px; cursor: pointer; font-size: 13px; }
.modal footer button.primary { background: var(--accent); color: #0b1220; border-color: var(--accent); }
.modal footer button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>