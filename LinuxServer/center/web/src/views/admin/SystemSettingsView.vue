<!--
  R158.87 (2026-10-12) — system-settings 父视图.
  跟 R158.77 MemberServerView 同 precedent: AdminLayout chrome +
  2-tab 横向条 + <router-view /> 渲染子路由.

  R158.AdminEmail (2026-10-15) — 加第 3 子 tab "管理员邮件" (admin_email 配置页).

  3 子路由:
    ''            → FeatureFlagsView  (功能开关)
    'license'     → LicenseView       (License 管理)
    'admin-email' → AdminEmailView    (管理员邮件)
-->
<template>
  <AdminLayout>
    <div class="ss-page">
      <header class="ss-header">
        <div class="ss-header-titles">
          <h1 class="ss-title">系统设置</h1>
          <span class="ss-subtitle">功能开关 + License 管理 + 管理员邮件 — 3 sub-tab</span>
        </div>
      </header>

      <nav class="ss-tabs" role="tablist" data-test="ss-tabs">
        <router-link
          v-for="tab in tabs"
          :key="tab.path"
          :to="tab.to"
          class="ss-tab"
          :class="{ 'is-active': isActive(tab.path) }"
          :data-test="`ss-tab-${tab.testId}`"
          role="tab"
          :aria-selected="isActive(tab.path) ? 'true' : 'false'"
        >
          <span class="ss-tab-label">{{ tab.label }}</span>
          <span v-if="tab.hint" class="ss-tab-hint">{{ tab.hint }}</span>
        </router-link>
      </nav>

      <main class="ss-main">
        <router-view />
      </main>
    </div>
  </AdminLayout>
</template>

<script setup>
import { useRoute } from 'vue-router';
import AdminLayout from '../../components/AdminLayout.vue';

const route = useRoute();

const tabs = [
  { path: '',            to: '/admin/system-settings',                testId: 'feature-flags', label: '功能开关',     hint: '7 flag' },
  { path: 'license',     to: '/admin/system-settings/license',         testId: 'license',       label: 'License 管理', hint: '激活/撤销' },
  { path: 'admin-email', to: '/admin/system-settings/admin-email',     testId: 'admin-email',   label: '管理员邮件',   hint: '通知收件人' }
];

function isActive(p) {
  if (p === '') return route.path === '/admin/system-settings' || route.path === '/admin/system-settings/';
  return route.path.startsWith(`/admin/system-settings/${p}`);
}
</script>

<style scoped>
.ss-page { width: 100%; }
.ss-header { margin-bottom: 14px; }
.ss-header-titles { display: flex; align-items: baseline; gap: 10px; }
.ss-title { font-size: 20px; font-weight: 600; margin: 0; }
.ss-subtitle { color: var(--muted); font-size: 12px; }
.ss-tabs { display: flex; gap: 6px; margin-bottom: 16px; border-bottom: 1px solid var(--border); padding-bottom: 0; }
.ss-tab { padding: 8px 14px; border: 1px solid var(--border); border-bottom: none; background: var(--panel); border-radius: 4px 4px 0 0; cursor: pointer; color: var(--text); text-decoration: none; font-size: 13px; }
.ss-tab.is-active { background: var(--accent, #3b82f6); color: #fff; border-color: var(--accent, #3b82f6); }
.ss-tab-label { font-weight: 500; }
.ss-tab-hint { color: var(--muted); font-size: 11px; margin-left: 6px; }
.ss-tab.is-active .ss-tab-hint { color: rgba(255,255,255,0.85); }
.ss-main { background: var(--panel); border: 1px solid var(--border); border-radius: 0 4px 4px 4px; padding: 16px; }
</style>
