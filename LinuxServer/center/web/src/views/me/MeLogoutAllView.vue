<!-- R158.104.2 (2026-10-14) — /me/logout-all 独立全屏 page.
     1:1 平行 R158.104 UserWidget:150-163 view=logout-all section +
     onLogoutAll (line 333) + logoutAllState (line 210).
     bump token_version, 当前 JWT 下一次请求即失效. 跟 admin
     user CRUD audit 1:1 平行 (action = 'self_token_revoke').
     0 eager logout, 让用户能看到 success msg + 之后下一次 API
     触发 401 → /login redirect. -->
<template>
  <div class="me-view">
    <h4 class="me-view-title">⏻ 退出所有设备</h4>
    <p class="muted">
      将立即吊销本账号在 <strong>所有设备 / 浏览器 / 标签页</strong> 上的登录凭证。
      当前会话的本次响应会返回成功，下一次请求将被拒绝，您将需要重新登录。
    </p>
    <p v-if="logoutAllState.error" class="err">{{ logoutAllState.error }}</p>
    <p v-if="logoutAllState.success" class="ok">✓ 已退出所有设备 (token_version → v{{ logoutAllState.newVersion }})</p>
    <div class="btn-row">
      <button class="btn warn" :disabled="logoutAllState.busy" @click="onLogoutAll">⏻ 确认退出全部</button>
    </div>
  </div>
</template>

<script setup>
// R158.104.2 — 1:1 平行 UserWidget onLogoutAll (line 333-347) +
//   logoutAllState (line 210). 复用 meApi.logoutAll() (api/me.js,
//   R158.104 ship 闭合, 0 改).
import { reactive } from 'vue';
import { meApi } from '../../api/me.js';
import { notifySuccess } from '../../lib/notify.js';

const logoutAllState = reactive({ busy: false, success: false, error: '', newVersion: 0 });

async function onLogoutAll() {
  logoutAllState.busy = true;
  logoutAllState.error = '';
  logoutAllState.success = false;
  try {
    const r = await meApi.logoutAll();
    logoutAllState.success = true;
    logoutAllState.newVersion = r.data?.newVersion || 0;
    notifySuccess(`已退出所有设备 (token_version → v${logoutAllState.newVersion})`);
    // The current JWT is now invalid; the next request will 401. We don't
    // eagerly logout() — the operator may want to copy a number or
    // screenshot the success message. The next API call will trigger the
    // 401 → /login redirect.
  } catch (e) {
    logoutAllState.error = e?.response?.data?.error || e?.message || '退出全部失败';
  } finally {
    logoutAllState.busy = false;
  }
}
</script>

<style scoped>
/* R158.104.2 — 1:1 平行 UserWidget:404-423 .muted / .err / .ok /
   .btn-row / .btn / .btn.warn CSS, 改 .me-view- 前缀. warn 按钮用
   amber 颜色跟 R158.104 widget 1:1 平行 (确认危险动作). */
.me-view {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 16px 18px;
  max-width: 560px;
}
.me-view-title {
  margin: 0 0 12px;
  font-size: 14px;
  color: var(--accent);
  font-weight: 600;
}
.muted { color: var(--muted); font-size: 13px; line-height: 1.5; }
.err { color: var(--red); font-size: 12px; margin: 6px 0; }
.ok { color: #16a34a; font-size: 13px; margin: 6px 0; font-weight: 600; }
.btn-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 12px; }
.btn { padding: 5px 12px; border-radius: 3px; border: 1px solid var(--border); background: var(--input-bg); color: var(--text); cursor: pointer; font-size: 13px; }
.btn:hover:not(:disabled) { filter: brightness(1.1); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.warn { background: #d97706; color: #fff; border-color: #d97706; }
</style>
