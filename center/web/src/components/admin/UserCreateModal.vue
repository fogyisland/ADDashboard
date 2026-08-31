<!--
  2026-08-31 R75 — UserCreateModal.vue.
  Fields per spec §4.3:
    sAMAccountName (required), GivenName, Surname, DisplayName (auto-derived
    if blank), UPN, OU DN (text), Password + Confirm + MustChange (checkbox,
    default true), Description.

  Submits via `user_create` command. Polls to terminal via
  useCommandPolling, surfaces inline success/failure banner.

  data-test contract:
    user-create-modal           — modal root
    user-create-sam / givenName / surname / displayName / upn /
                              ouPath / password / passwordConfirm /
                              mustChange / description  — input fields
    user-create-submit          — submit button
-->
<template>
  <div class="modal-bg" @click.self="cancel">
    <div class="modal" data-test="user-create-modal">
      <header><h3>新建用户</h3></header>
      <section class="form-body">
        <div class="row">
          <label class="field">
            <span class="label">sAMAccountName <em>*</em></span>
            <input data-test="user-create-sam" v-model="form.sam" :disabled="submitting" />
          </label>
          <label class="field">
            <span class="label">显示名称</span>
            <input data-test="user-create-displayName" v-model="form.displayName" :disabled="submitting" placeholder="留空自动 = 名 + 姓" />
          </label>
        </div>
        <div class="row">
          <label class="field">
            <span class="label">名 (GivenName)</span>
            <input data-test="user-create-givenName" v-model="form.givenName" :disabled="submitting" />
          </label>
          <label class="field">
            <span class="label">姓 (Surname)</span>
            <input data-test="user-create-surname" v-model="form.surname" :disabled="submitting" />
          </label>
        </div>
        <div class="row">
          <label class="field">
            <span class="label">UPN (UserPrincipalName)</span>
            <input data-test="user-create-upn" v-model="form.upn" :disabled="submitting" placeholder="例如 user@contoso.local" />
          </label>
          <label class="field">
            <span class="label">OU DN (可选)</span>
            <input data-test="user-create-ouPath" v-model="form.ouPath" :disabled="submitting" placeholder="OU=Users,DC=contoso,DC=local" />
          </label>
        </div>
        <div class="row">
          <label class="field">
            <span class="label">密码 <em>*</em></span>
            <input type="password" data-test="user-create-password" v-model="form.password" :disabled="submitting" />
          </label>
          <label class="field">
            <span class="label">确认密码 <em>*</em></span>
            <input type="password" data-test="user-create-passwordConfirm" v-model="form.passwordConfirm" :disabled="submitting" />
          </label>
        </div>
        <label class="checkbox">
          <input type="checkbox" data-test="user-create-mustChange" v-model="form.mustChange" :disabled="submitting" />
          下次登录必须修改密码
        </label>
        <label class="field">
          <span class="label">描述</span>
          <input data-test="user-create-description" v-model="form.description" :disabled="submitting" />
        </label>

        <p v-if="formError" class="error">{{ formError }}</p>
        <p v-if="submitting" class="hint" data-test="user-create-progress">命令已发送到 DC · 命令 ID #{{ activeCommand?.id }} · 等待结果…</p>
        <p v-if="submitting && timedOut" class="error">命令执行超时，正在查询状态…</p>
        <p v-if="resultMessage" :class="['result', resultOk ? 'ok' : 'err']" data-test="user-create-result">{{ resultMessage }}</p>
      </section>
      <footer>
        <button type="button" data-test="user-create-cancel" @click="cancel" :disabled="submitting">取消</button>
        <button type="button" data-test="user-create-submit" class="primary" @click="submit" :disabled="submitting || !canSubmit || !props.targetDc" :title="!props.targetDc ? '请先选择目标 DC' : ''">提交</button>
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
  sam: '',
  displayName: '',
  givenName: '',
  surname: '',
  upn: '',
  ouPath: '',
  password: '',
  passwordConfirm: '',
  mustChange: true,
  description: ''
});

const formError = ref('');
const submitting = ref(false);
const resultMessage = ref('');
const resultOk = ref(false);
const activeCommand = ref(null);
const timedOut = ref(false);

// Polling composable owns setInterval + setTimeout cleanup via
// onBeforeUnmount. The local `watch` below is also auto-disposed when
// this modal unmounts, so there is no orphan-handler / deadline leak.
const polling = useCommandPolling(null, { intervalMs: 1500, timeoutMs: 30_000 });
watch(polling.timedOut, (v) => { if (v) timedOut.value = true; });
watch(polling.isTerminal, (terminal) => {
  if (!terminal) return;
  const r = polling.command.value;
  if (!r) return;
  if (r.status === 'success') {
    resultMessage.value = `已创建 — ${r.result?.dn || form.sam}`;
    resultOk.value = true;
    submitting.value = false;
    emit('submitted', r);
  } else {
    resultMessage.value = r.errorMessage || `命令${r.status}`;
    resultOk.value = false;
    submitting.value = false;
  }
});

const canSubmit = computed(() =>
  form.sam.trim() && form.password && form.password === form.passwordConfirm && !submitting.value
);

function buildParams() {
  return {
    sam: form.sam.trim(),
    givenName: form.givenName.trim() || undefined,
    surname: form.surname.trim() || undefined,
    displayName: form.displayName.trim() || (form.givenName || form.surname ? `${form.givenName} ${form.surname}`.trim() : undefined),
    upn: form.upn.trim() || undefined,
    ouPath: form.ouPath.trim() || undefined,
    password: form.password,
    mustChangePassword: !!form.mustChange,
    description: form.description.trim() || undefined
  };
}

function validateLocal() {
  if (!form.sam.trim()) return 'sAMAccountName 不能为空';
  if (!form.password) return '密码不能为空';
  if (form.password !== form.passwordConfirm) return '两次输入的密码不一致';
  return null;
}

async function submit() {
  formError.value = '';
  const v = validateLocal();
  if (v) { formError.value = v; return; }
  submitting.value = true;
  resultMessage.value = '';
  timedOut.value = false;
  try {
    const resp = await adAdminApi.queueCommand({
      targetDc: props.targetDc,
      commandType: 'user_create',
      params: buildParams()
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
  min-width: 560px; max-width: 720px; max-height: 90vh;
  display: flex; flex-direction: column;
}
.modal header { padding: 12px 18px; border-bottom: 1px solid var(--border); }
.modal header h3 { margin: 0; font-size: 15px; }
.form-body { padding: 14px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
.row { display: flex; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 4px; flex: 1; font-size: 13px; }
.field .label { color: var(--muted); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }
.field .label em { color: var(--red); font-style: normal; margin-left: 2px; }
.field input {
  background: var(--input-bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 3px;
  padding: 5px 8px; font-size: 13px;
}
.field input:focus { outline: 2px solid var(--accent); border-color: var(--accent); }
.field input:disabled { opacity: 0.6; }

.checkbox {
  display: flex; align-items: center; gap: 6px;
  font-size: 13px; color: var(--text);
}

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