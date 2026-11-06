<template>
  <AdminLayout>
    <!--
      R158.113.b (2026-10-17) — MCP 集成 parent view. 操作员 directive
      "mcp 写入集成放进 MCP 集成, 以第二个 tab 实现". parent view 提供
      chrome (page-head + 2 tab 横向条 + router-view), content 由 2 children
      提供 (默认 '' = McpReadTabView 只读, 'write' = McpWriteTokenView 写入).
      1:1 平行 R158.87 SystemSettingsView:268-279 parent + 3 children
      (feature-flags / license / admin-email) + R158.110 ReportCenterView
      parent + 4 children (overview / 3 流水视图).

      R158.X.99.28 (2026-10-19) — 加 3rd tab "IP 白名单". 操作员 directive
      "为MCP 访问添加IP地址限制白名单" (MCP IP whitelist). 1:1 平行 R158.87
      SystemSettingsView 3 tab 范式 (3rd tab 1:1 平行 license / admin-email
      加 tab precedent). McpIpTabView 提供 JSON textarea + 启用 toggle +
      save (1:1 平行 McpReadTabView shape).
    -->
    <header class="page-head">
      <h2>🔌 MCP 集成</h2>
      <p class="page-summary">
        Model Context Protocol (MCP) Streamable HTTP 接入凭证管理。中心端暴露
        <strong>2 类端点</strong>: <code>/mcp</code> (8 只读工具, 供外部 AI Agent
        安全读取 dashboard 状态) + <code>/mcp-write</code> (6 写入工具, 供 admin
        主动授权的 LLM 客户端执行 AD 写动作)。个人用户前端 0 看到写入端入口
        (操作员 directive "个人账户默认不能申请写入")。
      </p>
    </header>

    <!--
      3 tab 横向条. R158.X.99.28 加 3rd tab "IP 白名单". 1:1 平行
      R158.87 SystemSettingsView:282-302 tab 段 (3 tab: 功能开关 / License
      管理 / 管理员邮件) + R158.110 ReportCenterView (4 tab: 总览 / 锁定账户
      / 密码错误 / 账户变更). active 状态 走 router-link-active-exact.
    -->
    <nav class="sub-tab-bar">
      <router-link to="/admin/mcp-token"            class="sub-tab" exact-active-class="active" data-test="mcp-tab-read">只读集成</router-link>
      <!-- R158.X.116.k (2026-10-23) — 写入集成 tab 受 `mcp_write.enabled` gate。
           操作员 directive: 关闭后「写入口关闭, 但保留读入口」。所以只藏这
           一个 tab, 只读集成 + IP 白名单照常显示; 并且 /admin/mcp-token/write
           由 router.js meta.featureFlag 守卫弹回, 后端 /mcp-write 由
           routes/mcp-write.js gate 返 503 —— 三层一起关才算真关。 -->
      <router-link v-if="featureFlags.isEnabled('mcp_write.enabled')" to="/admin/mcp-token/write" class="sub-tab" active-class="active" data-test="mcp-tab-write">写入集成</router-link>
      <router-link to="/admin/mcp-token/ip-whitelist" class="sub-tab" active-class="active"      data-test="mcp-tab-ip">IP 白名单</router-link>
    </nav>

    <div class="tab-content">
      <router-view />
    </div>
  </AdminLayout>
</template>

<script setup>
// R158.113.b (2026-10-17) — parent view 0 含业务逻辑, 仅 chrome + 2 tab
//   + router-view. 业务逻辑 (loadState / onRotate / onCommit / onReveal
//   / 8 tool 列表) 全在 McpReadTabView, 跟 McpWriteTokenView 1:1 平行.
import AdminLayout from '../../components/AdminLayout.vue';
// R158.X.116.k — 写入集成 tab 的 feature-flag gate (见上方 v-if 注释)。
import { useFeatureFlagsStore } from '../../stores/featureFlags.js';
const featureFlags = useFeatureFlagsStore();
</script>

<style scoped>
.page-head h2 { margin: 0 0 4px; }
.page-summary { color: #6b7280; margin: 0 0 16px; }
.page-summary code { background: #f3f4f6; padding: 1px 6px; border-radius: 3px; font-size: 0.9em; }
.page-summary strong { color: #374151; }

/* 2 tab 横向条. 1:1 平行 R158.87 SystemSettingsView 横向条 (3 tab) +
   R158.110 ReportCenterView 横向条 (4 tab). active 状态 2px blue accent
   跟 R158.54 sidebar nav-link 锁 1:1 平行 (literal hex #3b82f6 不能改). */
.sub-tab-bar {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 16px;
  padding: 0 4px;
}
.sub-tab {
  padding: 8px 18px;
  color: var(--muted);
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: color 0.12s ease, border-bottom-color 0.12s ease;
}
.sub-tab:hover { color: var(--text); }
.sub-tab.active {
  color: #3b82f6;
  border-bottom-color: #3b82f6;
  font-weight: 600;
}

.tab-content { min-height: 200px; }
</style>

<style>
/* 全局样式 (非 scoped) — 跟 children views (McpReadTabView / McpWriteTokenView)
   共享, 因为 children 0 scoped border / padding (跟 R158.87 FeatureFlagsView
   1:1 平行, 跟 R158.110 ReportCenterOverviewView 1:1 平行). 共享 scope 让
   children <section class="status-card"> 等自动有 border + padding. */
.tab-content .status-card,
.tab-content .actions,
.tab-content .tools-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 16px 20px;
  margin-bottom: 16px;
}
.tab-content .status-card h3,
.tab-content .actions h3,
.tab-content .tools-card h3 {
  margin: 0 0 12px;
  font-size: 1.05em;
}

.tab-content .t { width: 100%; border-collapse: collapse; }
.tab-content .t th,
.tab-content .t td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
.tab-content .t th { background: rgba(0,0,0,0.02); font-weight: 600; }
.tab-content .key-label { color: #374151; font-weight: 500; width: 280px; }

.tab-content .badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 0.85em;
  font-weight: 500;
}
.tab-content .badge.ok   { background: #d1fae5; color: #065f46; }
.tab-content .badge.warn { background: #fef3c7; color: #92400e; }
.tab-content .badge.err  { background: #fee2e2; color: #991b1b; }
.tab-content .badge.mute { background: #f3f4f6; color: #6b7280; }

.tab-content .hint   { color: var(--muted); font-size: 0.85em; margin-left: 6px; }
.tab-content .muted  { color: var(--muted); font-size: 0.85em; }

.tab-content .btn-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.tab-content .btn {
  padding: 6px 14px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--input-bg);
  cursor: pointer;
  font-size: 0.9em;
  color: var(--text);
}
.tab-content .btn:hover:not(:disabled) { background: rgba(0,0,0,0.04); }
.tab-content .btn:disabled { opacity: 0.5; cursor: not-allowed; }
.tab-content .btn.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
.tab-content .btn.primary:hover:not(:disabled) { background: #1d4ed8; }
.tab-content .btn.warn    { background: #d97706; color: #fff; border-color: #d97706; }
.tab-content .btn.warn:hover:not(:disabled)    { background: #b45309; }
.tab-content .btn.ghost   { background: var(--input-bg); color: var(--text); }

.tab-content .copy-msg     { color: #059669; font-size: 0.9em; margin: 4px 0 0; }
.tab-content .error-banner {
  background: #fee2e2;
  color: #991b1b;
  padding: 8px 12px;
  border-radius: 4px;
  font-size: 0.9em;
  margin: 4px 0 0;
}

.tab-content .modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.tab-content .modal {
  background: var(--panel);
  border-radius: 8px;
  padding: 24px;
  max-width: 600px;
  width: 90%;
}
.tab-content .modal h3 { margin: 0 0 8px; }
.tab-content .modal-hint { color: var(--muted); font-size: 0.9em; margin: 0 0 12px; }
.tab-content .token-box {
  width: 100%;
  font-family: ui-monospace, monospace;
  font-size: 0.85em;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  resize: vertical;
  word-break: break-all;
  background: var(--input-bg);
  color: var(--text);
}
/* R158.113.d (2026-10-17) — 并列 2 列端点展示 (域名 + IP). 跟 children
   共享 (跟 .btn / .status-card / .actions / .tools-card 1:1 平行非 scoped 范式).
   1:1 平行 R158.103 site-replication-matrix detail-drawer 双指标并排. */
.tab-content .endpoint-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 6px;
}
.tab-content .endpoint-col {
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 6px;
  padding: 8px 10px;
  background: var(--input-bg, #f9fafb);
}
.tab-content .endpoint-col-head {
  font-size: 12px;
  color: var(--muted, #6b7280);
  margin-bottom: 4px;
  font-weight: 500;
}
.tab-content .endpoint-col-body {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.tab-content .endpoint-col-body code {
  flex: 1;
  min-width: 0;
  word-break: break-all;
  font-size: 12px;
}
.tab-content .endpoint-empty {
  color: var(--muted, #6b7280);
  font-style: italic;
}
.tab-content .btn-icon {
  background: transparent;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 4px;
  padding: 2px 6px;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  flex-shrink: 0;
}
.tab-content .btn-icon:hover {
  background: rgba(0, 0, 0, 0.04);
}
</style>
