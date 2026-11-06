<!-- R158.104.2 (2026-10-14) — /me/change-password 独立全屏 page.
     1:1 平行 R158.104 UserWidget:73-94 view=password section +
     onChangePassword (line 262) + pwForm (line 204) + resetPasswordForm
     (line 286).
     提交后 token_version bump (后端 changeMyPassword 已做), 强制
     re-login: auth.logout() + router.push('/login'), 跟 UserWidget
     1:1 平行. 客户端校验 1:1 平行 UserWidget:264-271 (长度 ≥ 8 +
     两次新密一致). -->
<template>
  <div class="me-view">
    <h4 class="me-view-title">🔒 修改密码</h4>
    <form @submit.prevent="onChangePassword">
      <label>旧密码
        <input v-model="pwForm.old" type="password" autocomplete="current-password" required />
      </label>
      <label>新密码 (≥ 8 字符)
        <input v-model="pwForm.new" type="password" autocomplete="new-password" required />
      </label>
      <label>确认新密码
        <input v-model="pwForm.confirm" type="password" autocomplete="new-password" required />
      </label>
      <p v-if="pwForm.error" class="err">{{ pwForm.error }}</p>
      <div class="btn-row">
        <button type="submit" class="btn primary" :disabled="pwForm.busy">提交</button>
        <button type="button" class="btn ghost" @click="resetPasswordForm">重置</button>
      </div>
      <p class="hint">提交后所有设备需重新登录。</p>
    </form>
  </div>
</template>

<script setup>
// R158.104.2 — 1:1 平行 UserWidget onChangePassword (line 262-284) +
//   resetPasswordForm (line 286-288) + pwForm reactive (line 204). 复用
//   meApi.changePassword() + useAuthStore.logout() + useRouter push /login.
//   跟 McpTokenView 等 1:1 平行 precedent (submit 后 force re-login).
import { reactive } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../../stores/auth.js';
import { meApi } from '../../api/me.js';
import { notifySuccess } from '../../lib/notify.js';

const auth = useAuthStore();
const router = useRouter();

const pwForm = reactive({ old: '', new: '', confirm: '', busy: false, error: '' });

async function onChangePassword() {
  pwForm.error = '';
  if (pwForm.new !== pwForm.confirm) {
    pwForm.error = '两次输入的新密码不一致';
    return;
  }
  if (pwForm.new.length < 8) {
    pwForm.error = '新密码至少 8 字符';
    return;
  }
  pwForm.busy = true;
  try {
    const r = await meApi.changePassword({ oldPassword: pwForm.old, newPassword: pwForm.new });
    notifySuccess(`已修改密码, 需重新登录 (token_version → v${r.data.newVersion})`);
    // The current JWT is now invalid; the next request will 401 and
    // client.js's 401 interceptor will redirect to /login. Trigger that
    // explicitly so the operator doesn't have to click around.
    auth.logout();
    router.push('/login');
  } catch (e) {
    pwForm.error = e?.response?.data?.error || e?.message || '修改失败';
  } finally {
    pwForm.busy = false;
  }
}

function resetPasswordForm() {
  pwForm.old = '';
  pwForm.new = '';
  pwForm.confirm = '';
  pwForm.error = '';
}
</script>

<style scoped>
/* R158.104.2 — 1:1 平行 UserWidget:425-426 .label / input CSS, 改
   .me-view- 前缀. 表单 input 跟 LoginView precedent 1:1 平行. */
.me-view {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 16px 18px;
  max-width: 480px;
}
.me-view-title {
  margin: 0 0 12px;
  font-size: 14px;
  color: var(--accent);
  font-weight: 600;
}
.err { color: var(--red); font-size: 12px; margin: 6px 0; }
.hint { color: var(--muted); font-size: 11px; margin: 6px 0 0; }
label { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--muted); margin-bottom: 8px; }
label input { padding: 6px 8px; border: 1px solid var(--border); border-radius: 3px; background: var(--input-bg); color: var(--text); font-size: 13px; }
.btn-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.btn { padding: 5px 12px; border-radius: 3px; border: 1px solid var(--border); background: var(--input-bg); color: var(--text); cursor: pointer; font-size: 13px; }
.btn:hover:not(:disabled) { filter: brightness(1.1); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); font-weight: 600; }
.btn.ghost { background: var(--input-bg); }
</style>
