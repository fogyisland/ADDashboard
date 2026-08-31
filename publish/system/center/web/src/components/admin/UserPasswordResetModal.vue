<!--
  2026-08-31 R75 — UserPasswordResetModal.vue.
  Per spec §4.3 — fields: new password + confirm + mustChange + unlockAccount.
  Submits via `user_password_reset` command.
  data-test contract: user-password-reset-modal / password / confirm /
    mustChange / unlock / submit / result
-->
<template>
  <div class="modal-bg" @click.self="cancel">
    <div class="modal" data-test="user-password-reset-modal">
      <header><h3>重置密码 — {{ sam }}</h3></header>
      <section class="form-body">
        <label class="field">
          <span class="label">新密码 <em>*</em></span>
          <input type="password" data-test="user-password-reset-password" v-model="password" :disabled="submitting" />
        </label>
        <label class="field">
          <span class="label">确认密码 <em>*</em></span>
          <input type="password" data-test="user-password-reset-passwordConfirm" v-model="passwordConfirm" :disabled="submitting" />
        </label>
        <label class="checkbox">
          <input type="checkbox" data-test="user-password-reset-mustChange" v-model="mustChange" :disabled="submitting" />
          下次登录必须修改密码
        </label>
        <label class="checkbox">
          <input type="checkbox" data-test="user-password-reset-unlock" v-model="unlock" :disabled="submitting" />
          同时解锁账户
        </label>
        <p v-if="formError" class="error">{{ formError }}</p>
        <p v-if="submitting && !resultMessage" class="hint">命令已发送到 DC · 命令 ID #{{ activeCommand?.id }}</p>
        <p v-if="submitting && timedOut" class="error">命令执行超时，正在查询状态…</p>
        <p v-if="resultMessage" :class="['result', resultOk ? 'ok' : 'err']" data-test="user-password-reset-result">{{ resultMessage }}</p>
      </section>
      <footer>
        <button type="button" data-test="user-password-reset-cancel" @click="cancel" :disabled="submitting">取消</button>
        <button type="button" data-test="user-password-reset-submit" class="primary" @click="submit" :disabled="submitting || !canSubmit">提交</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { adAdminApi } from '../../api/ad-admin.js';

const props = defineProps({
  targetDc: { type: String, required: true },
  sam: { type: String, required: true }
});
const emit = defineEmits(['close', 'submitted']);

const password = ref('');
const passwordConfirm = ref('');
const mustChange = ref(true);
const unlock = ref(true);
const formError = ref('');
const submitting = ref(false);
const resultMessage = ref('');
const resultOk = ref(false);
const activeCommand = ref(null);
const timedOut = ref(false);

let pollHandle = null;

const canSubmit = computed(() =>
  password.value && password.value === passwordConfirm.value && !submitting.value
);

async function submit() {
  formError.value = '';
  if (!password.value) { formError.value = '密码不能为空'; return; }
  if (password.value !== passwordConfirm.value) { formError.value = '两次输入的密码不一致'; return; }
  submitting.value = true;
  resultMessage.value = '';
  timedOut.value = false;
  try {
    const resp = await adAdminApi.queueCommand({
      targetDc: props.targetDc,
      commandType: 'user_password_reset',
      params: {
        sam: props.sam,
        newPassword: password.value,
        mustChangePassword: mustChange.value,
        unlockAccount: unlock.value
      }
    });
    activeCommand.value = resp.data;
    const deadline = setTimeout(() => { if (!resultMessage.value) timedOut.value = true; }, 30_000);
    pollHandle = setInterval(async () => {
      try {
        const r = await adAdminApi.getCommand(activeCommand.value.id);
        const st = r.data?.status;
        if (st === 'success') {
          const u = r.data?.resultJson?.unlocked;
          resultMessage.value = `密码已重置${u ? ' · 已解锁' : ''}`;
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
.modal { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; min-width: 480px; max-width: 560px; max-height: 90vh; display: flex; flex-direction: column; }
.modal header { padding: 12px 18px; border-bottom: 1px solid var(--border); }
.modal header h3 { margin: 0; font-size: 15px; }
.form-body { padding: 14px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.field .label { color: var(--muted); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }
.field .label em { color: var(--red); font-style: normal; margin-left: 2px; }
.field input { background: var(--input-bg); color: var(--text); border: 1px solid var(--border); border-radius: 3px; padding: 5px 8px; font-size: 13px; }
.field input:focus { outline: 2px solid var(--accent); border-color: var(--accent); }
.checkbox { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.hint { color: var(--muted); font-size: 11px; margin: 0; }
.error { background: rgba(239, 68, 68, 0.15); color: #dc2626; padding: 6px 10px; border-radius: 3px; border: 1px solid rgba(239, 68, 68, 0.3); font-size: 12px; margin: 0; }
.result.ok { background: rgba(34, 197, 94, 0.15); color: #16a34a; padding: 6px 10px; border-radius: 3px; font-size: 12px; margin: 0; }
.result.err { background: rgba(239, 68, 68, 0.15); color: #dc2626; padding: 6px 10px; border-radius: 3px; font-size: 12px; margin: 0; }
.modal footer { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 18px; border-top: 1px solid var(--border); }
.modal footer button { padding: 6px 14px; border: 1px solid var(--border); background: var(--input-bg); color: var(--text); border-radius: 3px; cursor: pointer; font-size: 13px; }
.modal footer button.primary { background: var(--accent); color: #0b1220; border-color: var(--accent); }
.modal footer button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>