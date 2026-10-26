<!-- R158.104.2 (2026-10-14) — /me self-service parent chrome.
     1:1 平行 MemberServerView.vue (R158.77 + R158.100 precedent):
       · AppLayout 包 .me-page
       · .me-header 标题 + Self-Service badge
       · .me-tabs 4 横向 sub-tab 入口 (跟 /memberServer/.ms-tabs 同款视觉,
         改名 .me-* 避免 class 冲突)
       · <router-view/> 渲染 4 children (Profile / 修改密码 / MCP Token /
         退出全部)
     0 requirePerm (userAuth-only, 跟 R112 eventlog / R116 os-baseline
     1:1 平行). 4 children 1:1 平行 MemberServerHomeView 等. -->
<template>
  <AppLayout>
    <div class="me-page">
      <header class="me-header">
        <div class="me-header-titles">
          <h1 class="me-title">我的账户</h1>
          <span class="me-badge">Self-Service</span>
          <span class="me-subtitle">
            个人资料 / 密码 / MCP Token / 设备管理
          </span>
        </div>
      </header>

      <nav class="me-tabs" role="tablist" data-test="me-tabs">
        <router-link
          v-for="tab in tabs"
          :key="tab.path"
          :to="tab.to"
          class="me-tab"
          :class="{ 'is-active': isActive(tab.path) }"
          :data-test="`me-tab-${tab.testId}`"
          role="tab"
          :aria-selected="isActive(tab.path) ? 'true' : 'false'"
        >
          <span class="me-tab-label">{{ tab.label }}</span>
          <span v-if="tab.hint" class="me-tab-hint">{{ tab.hint }}</span>
        </router-link>
      </nav>

      <main class="me-main">
        <router-view />
      </main>
    </div>
  </AppLayout>
</template>

<script setup>
import { useRoute } from 'vue-router';
import { computed } from 'vue';
import { useAuthStore } from '../stores/auth.js';
import AppLayout from '../components/AppLayout.vue';

const route = useRoute();

// R158.104.2 — 4 sub-tab, 1:1 平行 /memberServer 7 sub-tab (R158.77 +
// R158.100). '' 默认进 Profile. path 跟 router.js children 1:1 对齐.
//
// F1 (2026-10-20) — 「🗝 MCP Token」tab 现在 admin-only。mcp_api_token_current
//   是全局单值不是 per-user, 后端 reveal + rotate 已加 requirePerm('admin:config')
//   (routes/me-mcp.js authConfig)。非 admin 用户不再看到入口, 避免点进去撞 403。
//   /me/mcp-token 的 state 端点仍是 requireAuth-only (只返 boolean + version),
//   但没有入口价值 —— 统一跟 reveal/rotate 一起 gate。
const allTabs = [
  { path: '',                to: '/me',                  testId: 'profile',        label: '👤 个人资料', hint: '只读' },
  { path: 'change-password', to: '/me/change-password',  testId: 'change-password', label: '🔒 修改密码', hint: '≥ 8 字符' },
  { path: 'mcp-token',       to: '/me/mcp-token',        testId: 'mcp-token',       label: '🗝 MCP Token', hint: '轮换 / 读取', adminOnly: true },
  { path: 'logout-all',      to: '/me/logout-all',       testId: 'logout-all',      label: '⏻ 退出全部',  hint: '吊销所有 JWT' }
];

const auth = useAuthStore();
const tabs = computed(() => allTabs.filter(t => !t.adminOnly || auth.isAdmin));

// R158.104.2 — isActive 1:1 平行 MemberServerView isActive (line 64-71):
//   · '' matches /me exact
//   · 'change-password' matches /me/change-password exact
function isActive(tabPath) {
  if (tabPath === '') {
    return route.path === '/me' || route.path === '/me/';
  }
  return route.path === `/me/${tabPath}`;
}
</script>

<style scoped>
/* R158.104.2 — chrome 1:1 平行 MemberServerView.vue .ms-* 模式
   (line 74-152), 改名 .me-* 避免跟 memberServer view 冲突.
   0 改 .me-page / .me-header 视觉, 跟 .ms-page 100% 平行. */
.me-page { padding: 16px 0; }

.me-header {
  display: flex; align-items: flex-end; justify-content: space-between;
  gap: 16px; margin-bottom: 12px; flex-wrap: wrap;
}
.me-header-titles { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.me-title {
  margin: 0; font-size: 20px; color: var(--accent); font-weight: 700;
}
.me-badge {
  font-size: 11px; font-weight: 700; padding: 2px 10px;
  border-radius: 12px; text-transform: uppercase; letter-spacing: 0.05em;
  background: rgba(96, 165, 250, 0.14);
  color: #60a5fa;
  border: 1px solid #3b82f6;
}
.me-subtitle {
  font-size: 12px; color: var(--muted);
  width: 100%;
}

.me-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px;
  margin-bottom: 16px;
  background: color-mix(in srgb, var(--panel-alt) 50%, transparent);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.me-tab {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--muted);
  text-decoration: none;
  transition: background-color 120ms, color 120ms;
  font-family: inherit;
  background: transparent;
}
.me-tab:hover {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--text);
}
.me-tab.is-active {
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  color: var(--accent);
  font-weight: 700;
}
.me-tab-label {
  letter-spacing: 0.02em;
}
.me-tab-hint {
  font-size: 11px;
  color: var(--muted);
  font-weight: 400;
}
.me-tab.is-active .me-tab-hint {
  color: var(--accent);
  opacity: 0.8;
}

.me-main {
  margin-top: 8px;
}
</style>
