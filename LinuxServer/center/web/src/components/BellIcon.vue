<!--
  R158.X.99.34.d (2026-10-19) — Topbar bell icon with unread count badge.

  操作员 directive "操作员登录 dashboard 后, 在 dashboard 内部推送/显示告警
  消息给管理员". BellIcon 是 in-app notification 的入口, mounted 在 AppLayout
  跟 AdminLayout topbar-actions 段 (跟 theme-toggle / logout button 1:1 平行).

  数据源: useInappNotificationsStore.
  显示: SVG bell + 红底白字数字 badge (count > 0 时). 0 = 显示空 bell (灰), 0 badge.
  click → store.openDrawer() 触发 InAppDrawer (Teleport to body, mounted in App.vue
  跟 ErrorBanner 平行).

  复用 ErrorBanner.vue 思路 (subscribe to store), 但不渲染 toast — toast 由
  store.fetch() 主动调 notify() (lib/notify.js). BellIcon 仅负责 bell + badge.
-->
<template>
  <button
    class="bell-icon"
    :class="{ 'has-unread': hasUnread }"
    :title="hasUnread ? `未读 ${unreadCount}` : '通知'"
    @click="store.openDrawer"
    data-test="inapp-bell"
  >
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11a6 6 0 1 0-12 0v5l-2 2v1h16v-1l-2-2z"
        fill="currentColor"
      />
    </svg>
    <span v-if="hasUnread" class="bell-badge" data-test="inapp-bell-badge">
      {{ unreadCount > 99 ? '99+' : unreadCount }}
    </span>
  </button>
</template>

<script setup>
// R158.X.99.34.d — BellIcon 完全 reactive from store. storeToRefs 拿
//   unreadCount / hasUnread 是 reactive, badge count 跟 store.lastSeenAt
//   polling 自动同步.
import { useInappNotificationsStore } from '../stores/inappNotifications.js';
import { storeToRefs } from 'pinia';

const store = useInappNotificationsStore();
const { unreadCount, hasUnread } = storeToRefs(store);
</script>

<style scoped>
.bell-icon {
  position: relative;
  padding: 6px 10px;
  background: var(--input-bg);
  border: 1px solid var(--border);
  border-radius: 3px;
  cursor: pointer;
  color: var(--text);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.bell-icon:hover { filter: brightness(1.1); }
.bell-icon.has-unread {
  /* 操作员 directive "有消息就推送" — 未读时高亮 accent 蓝 */
  background: rgba(96, 165, 250, 0.14);
  color: #60a5fa;
  border-color: #3b82f6;
}
.bell-badge {
  position: absolute;
  top: -6px;
  right: -6px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--danger, #e44);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
</style>
