<!--
  R158.104 (2026-10-14) — sidebar 底部 fixed current-user widget.
  4 view (Profile / 改密码 / MCP Token / 退出全部) 拆到 4 独立全屏
  /me/* 路由 (R158.104.2 ship 闭合). widget 现在仅作入口: 显示
  当前 username + role, 整 widget 是个 router-link 跳 /me/profile.

  R158.104.2 (2026-10-14) — 简化: 删 4 view section template + 4
  reactive state + 11 onXxx async handler + view ref + selectView
  function + watch(view) + mousedown click-outside (R158.104.1 fix).
  0 view state / 0 popover / 0 click-outside handler — 整个 widget
  是个 router-link, click 单一动作 router.push, 0 事件 channel
  互扰隐患 (闭合 R158.104.1 教训的根源).

  形态 (R158.104.2 ship 闭合):
    ┌──────────────────────┐
    │ 👤 admin             │
    │   [admin]            │
    │ 我的账户 ›           │  ← 整 widget 是个 router-link
    └──────────────────────┘
-->
<template>
  <router-link to="/me" class="user-widget" data-test="user-widget-link">
    <div class="user-widget-row">
      <span class="avatar">👤</span>
      <span class="who">
        <strong>{{ auth.user?.username || 'unknown' }}</strong>
        <small class="role">[{{ auth.user?.role || '?' }}]</small>
      </span>
    </div>
    <span class="me-link">我的账户 ›</span>
  </router-link>
</template>

<script setup>
// R158.104.2 — 简化后只保留 username + role 显示 + 整 widget 跳 /me.
//   0 ref, 0 reactive, 0 click handler (router-link 自带导航), 0
//   onMounted / onBeforeUnmount. 1:1 平行 AppLayout topbar 现有
//   `{{ auth.user?.username }}` 显示 (AppLayout.vue:96), 但加
//   「我的账户 ›」链接指示用户能跳到 self-service 页面.
import { useAuthStore } from '../stores/auth.js';
const auth = useAuthStore();
</script>

<style scoped>
/* R158.104.2 — 简化 widget 样式. 复用 AppLayout line 166 .sidebar CSS
   变量, 0 写死色值. 0 复 .user-widget-header / .user-widget-body /
   .view-* / .modal-* 等已删 CSS (R158.104 闭合不回归, 这些 CSS
   已在 R158.104.2 同步删). */
.user-widget {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 4px;
  background: var(--panel);
  border: 1px solid var(--border);
  color: var(--text);
  text-decoration: none;
  transition: background-color 120ms, border-color 120ms;
  cursor: pointer;
}
.user-widget:hover {
  background: var(--border);
  border-color: var(--accent);
}
.user-widget-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.avatar { font-size: 16px; }
.who { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; }
.who strong { font-weight: 600; color: var(--accent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.who .role { color: var(--muted); font-size: 11px; }
.me-link {
  font-size: 11px;
  color: var(--muted);
  padding-left: 24px;
}
.user-widget:hover .me-link {
  color: var(--accent);
}
</style>
