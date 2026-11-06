<!-- R158.104.2 (2026-10-14) — /me/profile 独立全屏 page.
     1:1 平行 R158.104 UserWidget:44-71 view=profile section +
     loadProfile (line 242) + profileState (line 203).
     Read-only, 显示 username / role / status / lastLoginAt / createdAt
     5 行. 跟 /admin/member-servers detail 1:1 平行 (kv table 形态).
     0 commit button (me 端只读, R158.104 lesson #1 必 preserve). -->
<template>
  <div class="me-view">
    <h4 class="me-view-title">👤 个人资料</h4>
    <div v-if="profileState.loading" class="muted">加载中…</div>
    <table v-else-if="profileState.data" class="kv">
      <tbody>
        <tr><td>用户名</td><td>{{ profileState.data.username }}</td></tr>
        <tr><td>角色</td><td>{{ profileState.data.role }}</td></tr>
        <tr><td>状态</td>
          <td>
            <span :class="['badge', profileState.data.status === 1 ? 'ok' : 'err']">
              {{ profileState.data.status === 1 ? '已启用' : '已禁用' }}
            </span>
          </td>
        </tr>
        <tr><td>上次登录</td>
          <td>{{ profileState.data.lastLoginAt
            ? formatDateTime(profileState.data.lastLoginAt)
            : '—' }}</td>
        </tr>
        <tr><td>创建于</td>
          <td>{{ profileState.data.createdAt
            ? formatDateTime(profileState.data.createdAt)
            : '—' }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else class="err">{{ profileState.error }}</p>
  </div>
</template>

<script setup>
// R158.104.2 — 1:1 平行 UserWidget loadProfile (line 242-250) +
//   profileState (line 203). 复用 meApi.getProfile() (api/me.js, R158.104
//   ship 闭合, 0 改). onMounted 自动 load, 跟 MemberServerHomeView 等
//   children view onMounted load 1:1 平行.
import { onMounted, reactive } from 'vue';
import { meApi } from '../../api/me.js';
import { formatDateTime } from '../../lib/timezone.js';

const profileState = reactive({ loading: false, data: null, error: '' });

async function loadProfile() {
  profileState.loading = true;
  profileState.error = '';
  profileState.data = null;
  try {
    const r = await meApi.getProfile();
    profileState.data = r.data;
  } catch (e) {
    profileState.error = e?.response?.data?.error || e?.message || '加载失败';
  } finally {
    profileState.loading = false;
  }
}

onMounted(loadProfile);
</script>

<style scoped>
/* R158.104.2 — 1:1 平行 UserWidget:404-417 .view h4 / .kv / .badge
   CSS 模式, 改 .me-view- 前缀避免跟 4 sub-tab view 相互覆盖. */
.me-view {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 16px 18px;
  max-width: 720px;
}
.me-view-title {
  margin: 0 0 12px;
  font-size: 14px;
  color: var(--accent);
  font-weight: 600;
}
.muted { color: var(--muted); font-size: 12px; }
.err { color: var(--red); font-size: 12px; margin: 6px 0; }
.kv { width: 100%; border-collapse: collapse; font-size: 13px; }
.kv td { padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.kv td:first-child { color: var(--muted); width: 100px; }
.badge { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 11px; font-weight: 500; }
.badge.ok { background: rgba(16,185,129,0.15); color: #10b981; }
.badge.err { background: rgba(239,68,68,0.15); color: #ef4444; }
</style>
