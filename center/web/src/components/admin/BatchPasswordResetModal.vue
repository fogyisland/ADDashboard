<!--
  2026-09-02 R76 — BatchPasswordResetModal.vue.

  Like UserPasswordResetModal.vue but applies to N sams. Operator picks
  one password + confirm + mustChange + unlock; on submit emits
  `submit({ sams, newPassword, mustChangePassword, unlockAccount })`
  and the parent fans out one `user_password_reset` per sam (same
  password for all — explicit UX concession per R76 directive).

  data-test contract (matched by user-management-bulk.test.js):
    batch-password-reset-modal
    batch-password-reset-count       — "将重置 N 个账号"
    batch-password-reset-password
    batch-password-reset-passwordConfirm
    batch-password-reset-mustChange
    batch-password-reset-unlock
    batch-password-reset-submit
    batch-password-reset-cancel
-->
<template>
  <div class="modal-bg" @click.self="cancel">
    <div class="modal" data-test="batch-password-reset-modal">
      <header><h3>批量重置密码</h3></header>
      <section class="form-body">
        <p class="hint" data-test="batch-password-reset-count">
          将重置 <strong>{{ sams.length }}</strong> 个账号：
          <span class="sam-list">{{ samsPreview }}</span>
        </p>
        <label class="field">
          <span class="label">新密码 <em>*</em></span>
          <input type="password" data-test="batch-password-reset-password" v-model="password" :disabled="submitting" />
        </label>
        <label class="field">
          <span class="label">确认密码 <em>*</em></span>
          <input type="password" data-test="batch-password-reset-passwordConfirm" v-model="passwordConfirm" :disabled="submitting" />
        </label>
        <label class="checkbox">
          <input type="checkbox" data-test="batch-password-reset-mustChange" v-model="mustChange" :disabled="submitting" />
          下次登录必须修改密码
        </label>
        <label class="checkbox">
          <input type="checkbox" data-test="batch-password-reset-unlock" v-model="unlock" :disabled="submitting" />
          同时解锁账户
        </label>
        <p class="note">所有选中的账号将使用同一密码 — 这是 R76 明确的设计取舍</p>
        <p v-if="formError" class="error">{{ formError }}</p>
      </section>
      <footer>
        <button type="button" data-test="batch-password-reset-cancel" @click="cancel" :disabled="submitting">取消</button>
        <button type="button" data-test="batch-password-reset-submit" class="primary" @click="submit" :disabled="submitting || !canSubmit">提交</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';

const props = defineProps({
  // Array of sAMAccountName strings. Required, length >= 1.
  sams: { type: Array, required: true }
});
const emit = defineEmits(['close', 'submit']);

const password = ref('');
const passwordConfirm = ref('');
const mustChange = ref(true);
const unlock = ref(true);
const formError = ref('');
const submitting = ref(false);

const samsPreview = computed(() => {
  const arr = Array.isArray(props.sams) ? props.sams : [];
  if (arr.length <= 3) return arr.join(', ');
  return `${arr.slice(0, 3).join(', ')} 等 ${arr.length} 个`;
});

const canSubmit = computed(() =>
  Array.isArray(props.sams) && props.sams.length > 0
  && password.value && password.value === passwordConfirm.value && !submitting.value
);

function submit() {
  formError.value = '';
  if (!Array.isArray(props.sams) || props.sams.length === 0) {
    formError.value = '未选中任何账号';
    return;
  }
  if (!password.value) { formError.value = '密码不能为空'; return; }
  if (password.value !== passwordConfirm.value) { formError.value = '两次输入的密码不一致'; return; }
  submitting.value = true;
  emit('submit', {
    sams: [...props.sams],
    newPassword: password.value,
    mustChangePassword: mustChange.value,
    unlockAccount: unlock.value
  });
  // Parent closes the modal after the emit lands (it owns the queue
  // call + toast). submitting stays true until unmount.
}

function cancel() {
  if (submitting.value) return;
  emit('close');
}
</script>

<style scoped>
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; min-width: 480px; max-width: 560px; max-height: 90vh; display: flex; flex-direction: column; }
.modal header { padding: 12px 18px; border-bottom: 1px solid var(--border); }
.modal header h3 { margin: 0; font-size: 15px; }
.form-body { padding: 14px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
.hint { color: var(--muted); font-size: 12px; margin: 0; }
.sam-list { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--accent); margin-left: 4px; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.field .label { color: var(--muted); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }
.field .label em { color: var(--red); font-style: normal; margin-left: 2px; }
.field input { background: var(--input-bg); color: var(--text); border: 1px solid var(--border); border-radius: 3px; padding: 5px 8px; font-size: 13px; }
.field input:focus { outline: 2px solid var(--accent); border-color: var(--accent); }
.checkbox { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.note { color: var(--muted); font-size: 11px; margin: 0; font-style: italic; }
.error { background: rgba(239, 68, 68, 0.15); color: #dc2626; padding: 6px 10px; border-radius: 3px; border: 1px solid rgba(239, 68, 68, 0.3); font-size: 12px; margin: 0; }
.modal footer { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 18px; border-top: 1px solid var(--border); }
.modal footer button { padding: 6px 14px; border: 1px solid var(--border); background: var(--input-bg); color: var(--text); border-radius: 3px; cursor: pointer; font-size: 13px; }
.modal footer button.primary { background: var(--accent); color: #0b1220; border-color: var(--accent); }
.modal footer button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>