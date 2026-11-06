<template>
  <div class="layout">
    <aside class="sidebar">
      <h3>{{ isAd ? 'AD Dashboard' : 'NoAD 成员服务器' }}</h3>
      <nav class="sidebar-nav">
        <!-- R158.71 (2026-10-11) — Sidebar 分组 (4 折叠组, 默认全展开).
             operator 决策 "整体界面优化, 特别 Sidebar 名称对齐/分组".
             拆 4 组按功能 domain:
               · 监控告警 (operator 日常看的, 高频, 首项 "概览" 改 "首页"
                 更简洁, operator 决策 12:45 CST)
               · 复制状态 (复制相关, 子项 label "复制矩阵" 改 "入站复制",
                 跟 router.js R158.10/R155.3 inbound 语义一致)
               · 资产清单 (服务器 + Agent)
               · 系统运维 (包 + OS 基线)
             分组 label/子项命名统一对齐, 不动 router.js 路由表.

             R158.77.x (2026-10-12) — AD 4 group 加 `v-if="isAd"` 跟
             5th "成员服务器" group (`v-if="!isAd"`) 互斥. 修 R158.77
             ship 时漏的: AD 4 group 没 gate 导致 NoAD 路径下 AD 入口
             跟 member-server 入口同时显示 ("混在一起" feedback).

             R158.X.116.j (2026-10-23) — 删掉 `&& featureFlags.isEnabled(
             'forest_registry.enabled')` (operator directive: 这些功能
             "不需要开关", 入口要常留给后续开发). `v-if="isAd"` 的
             AD/NoAD 互斥判定**原样保留**, 那是另回事 (防两个入口混在
             一起), 不受本次改动影响. -->
        <section class="nav-group" v-if="isAd">
          <h4 class="nav-group-title">监控告警</h4>
          <div class="nav-group-items">
            <router-link to="/">首页</router-link>
            <router-link to="/errors">错误链路</router-link>
            <router-link to="/eventlog">事件日志</router-link>
            <!-- R158.1W.1 (2026-10-16) — 锁定/密码/账户变更 3 view 移到新
                 信息安全 group (操作员 directive, 语义跟"信息安全"更贴).
                 监控告警 group 从 6 减到 3 项. 0 改 router.js (顶层 flat
                 path 跟 /lockout-accounts / /failed-logon-2h / /account-
                 change-detail 1:1 平行, route 已在 R158.50/109.a/X ship). -->
          </div>
        </section>

        <!-- R158.1W.1 (2026-10-16) — 5th AD nav-group "信息安全" (末端追加,
             R158.110 AdminLayout 报表中心 + R158.75 #5 运维 precedent). 3
             view (锁定账户/密码错误/账户变更) 从"监控告警" group 移过来
             (操作员 directive, 语义跟"信息安全"更贴), +1 新 view
             "密码错误分布图" (R158.1W.1, 原名: "账户-工作站关联网络图" → "账户访问分布图" → "密码错误分布图",
             2026-10-17 操作员 directive 改, 对齐 event 名 4625 + 跟 4740 账户锁定分布图 1:1 平行, 组件名 +
             router path 0 改 [R158.77.3 锁]). ad_failed_logon_events 4625 双端点聚合, ECharts
             graph/force + sankey 双形态 toggle. 0 改 router.js (顶层 flat path 1:1 平行, route
             已在 R158.50/109.a/X/1W.1 ship). 0 改 endpoint (复用既有 9 failed-logon endpoint
             + 新加 1 endpoint /api/failed-logon/account-workstation-graph).
             0 改 schema / 0 改 agent / 0 改 ETL. v-if=isAd 跟 NoAD
             互斥, 1:1 平行 4 AD group precedent. -->
        <section class="nav-group" v-if="isAd">
          <h4 class="nav-group-title">信息安全</h4>
          <div class="nav-group-items">
            <router-link to="/lockout-accounts">锁定账户信息</router-link>
            <router-link to="/failed-logon-2h">密码错误监控</router-link>
            <router-link to="/account-change-detail">账户变更明细</router-link>
            <router-link to="/account-workstation-graph">密码错误分布图</router-link>
            <!-- R158.1W.3 (2026-10-16) — 账户锁定分布图 (1:1 平行
                 R158.1W.1 密码错误分布图, 数据源 ad_lockout_events 4740
                 vs ad_failed_logon_events 4625). 信息安全 group 第 5 项,
                 0 改既有 4 项 (锁定/密码/账户变更/密码错误分布) 顺序.
                 跟 1W.1 1:1 平行, NO admin perm gate, operator dashboard
                 可见. 0 改 router.js (顶层 flat path 跟其他 4 信息安全
                 route 1:1 平行). -->
            <router-link to="/lockout-account-workstation-graph">账户锁定分布图</router-link>
          </div>
        </section>

        <section class="nav-group" v-if="isAd">
          <h4 class="nav-group-title">复制状态</h4>
          <div class="nav-group-items">
            <!-- R158.71 — label "复制矩阵" → "入站复制" (operator 决策,
                 跟 router.js R158.10/R155.3 inbound 语义对齐, 去掉
                 "复制" 重复前缀). 路由 /matrix/inbound 不变. -->
            <router-link to="/matrix/inbound">入站复制</router-link>
            <router-link to="/topology">复制拓扑</router-link>
            <!-- R158.11 — label "复制端口探测". R155.3 link → /monitor-inbound,
                 R158.10 删出战, R158.11 label 改 "复制端口探测" -->
            <router-link to="/replication-log/monitor-inbound">复制端口探测</router-link>
          </div>
        </section>

        <section class="nav-group" v-if="isAd">
          <h4 class="nav-group-title">资产清单</h4>
          <div class="nav-group-items">
            <router-link to="/servers-overview">服务器总览</router-link>
            <router-link to="/agents">Agent</router-link>
          </div>
        </section>

        <section class="nav-group" v-if="isAd">
          <h4 class="nav-group-title">系统运维</h4>
          <div class="nav-group-items">
            <router-link to="/packages-runs">包</router-link>
            <router-link to="/os-baseline">OS 基线</router-link>
          </div>
        </section>
        <!-- R158.77 (2026-10-11) — 5th nav-group "成员服务器" (NoAD
             only). v-if=!isAd 跟 AD 互斥, AD 用户永远不显示. 6
             router-link 对应 6 个 children routes (home + 5 sub-tabs).
             不动 toggle / 不动 4 group / 不动 AD nav.

             R158.77.x (2026-10-12) — 上面 4 AD group 加 v-if="isAd"
             后这里变成"绝对互斥": AD 用户只见 4 AD group, NoAD 用户
             只见 1 member-server group. Sidebar title 也切 (AD Dashboard
              → "NoAD 成员服务器") 让用户一眼分清当前 fleet. -->
        <section class="nav-group" v-if="!isAd">
          <h4 class="nav-group-title">成员服务器</h4>
          <div class="nav-group-items">
            <router-link to="/memberServer">总览</router-link>
            <router-link to="/memberServer/os-baseline">OS 基线</router-link>
            <router-link to="/memberServer/agents">Agent</router-link>
            <router-link to="/memberServer/ports">业务端口</router-link>
            <router-link to="/memberServer/eventlog">事件日志</router-link>
            <router-link to="/memberServer/packages">包运行状态</router-link>
            <!-- R158.100 (2026-10-13) — 7th sub-tab, 1:1 平行 R158.77 6 children
                 ship pattern. Router /memberServer/admins + MemberServerAdminsView
                 已在 R158.100 ship, 此次仅补 AppLayout Sidebar 入口. -->
            <router-link to="/memberServer/admins">管理员组成员</router-link>
          </div>
        </section>
      </nav>
      <!-- R158.104 (2026-10-14) — sidebar 底部 fixed user widget. flex
           把 widget 推到 aside 底部 (line 161 aside { display: flex;
           flex-direction: column }), nav flex: 1 1 auto 让 nav 吃掉
           中间所有空间 + 滚 (line 165), widget 永远 visible. 0 改
           topbar 现有 username 显示. 0 改 router.js (UserWidget 是
           layout-level 组件, 4 view 全在 popover 内). -->
      <UserWidget class="sidebar-widget" />
    </aside>
    <main>
      <!-- R158.License-expiry (2026-10-15) — layout-level 顶部 banner. 黄底 expiring_soon
           (复用 .ae-banner-empty 范式 1:1) + 红底 expired (新加 .lic-banner-expired).
           跨 AD/NoAD fleet 1:1 平行. 0 改 LicenseView 内部 (R158.LA-V1-delete 锁定). -->
      <div v-if="licenseState.isExpiringSoon || licenseState.isExpired" class="lic-banner" :class="licenseState.isExpired ? 'lic-banner-expired' : 'lic-banner-warning'" data-test="lic-banner">
        <span class="lic-banner-icon">{{ licenseState.isExpired ? '⛔' : '⚠️' }}</span>
        <span class="lic-banner-text">
          <template v-if="licenseState.isExpired">
            <strong>许可证已到期</strong> (已过 {{ -(licenseState.daysRemaining || 0) }} 天). 系统仅保留授权管理页面可访问, 请立即申请正式授权.
          </template>
          <template v-else>
            <strong>许可证即将到期</strong> (还剩 {{ licenseState.daysRemaining }} 天). 请联系管理员尽快申请续期.
          </template>
        </span>
      </div>
      <header class="topbar">
        <span>{{ auth.user?.username }} <small>({{ auth.user?.role }})</small></span>
        <div class="topbar-actions">
          <!-- R158.34.3 (2026-10-02) — 前台首页 topbar 「日常管理」与
               「后台管理」并列双按钮, 各自独立入口.
               Operator directive "日常管理和后台管理并列, 如果有权限
               都显示入口".
                 · 日常管理 (蓝调高亮) → /admin/daily-ops — 树状整合入口
                   (左 30% 站点→域控 树 + 右 70% 用户/组/快速重置/历史
                   4 tab), operator 主要工作面板
                 · 后台管理 (灰底常规) → /admin/users — 传统 AdminLayout
                   控制台入口 (R53 sidebar 6+1 groups / 22 nav-links),
                   用于站点清单/域控清单/包管理/审计 等运维设置
               两个按钮互相平行, 不互为前置; 都受 `v-if="auth.isAdmin"`
               gate 限制, 非 admin 角色都不显示。
               之前的 R158.34.2 (单按钮「日常管理」) 撤回到 R158.34.1
               (单 sidebar 入口) 是过渡, 现在最终形态是两个并列按钮。
               AdminLayout sidebar 「运维」group 里的「日常管理」首项
               保留作为 deep-link 备份入口, 不会跟 topbar 重复显示。-->
          <button class="admin-entry admin-entry--daily" v-if="auth.isAdmin && featureFlags.isEnabled('ad_management.enabled')" @click="router.push('/daily-ops')">日常管理</button>
          <button class="admin-entry admin-entry--back" v-if="auth.isAdmin" @click="router.push('/admin/users')">后台管理</button>
          <button class="theme-toggle" :title="theme === 'dark' ? '切换到白天' : '切换到黑夜'" @click="toggleTheme">{{ theme === 'dark' ? '☀' : '🌙' }}</button>
          <!-- R158.73 (2026-10-11) — AD/NoAD toggle (segmented control).
               operator "dashboard 展示用的" = 前台 user 任何登录角色都能切.
               当前 AD active (蓝调高亮 #3b82f6/.admin-entry--daily 复用),
               NoAD 跳 /memberServer (灰底常规 .admin-entry--back 复用).
               路由用 URL 状态而非 store state, 跟现有 router-link 一致.
               不动 AdminLayout (其他都在后台设定, 跟 toggle 无关). -->
          <div class="view-toggle">
            <router-link to="/" class="toggle-btn" :class="{ active: isAd }">AD</router-link>
            <router-link to="/memberServer" class="toggle-btn" :class="{ active: !isAd }">成员服务器</router-link>
          </div>
          <!-- R158.X.99.34.d (2026-10-19) — in-app notification bell. 操作员
               directive "操作员登录 dashboard 后,在 dashboard 内部推送/显示告警
               消息给管理员". mounted 在 topbar-actions 跟 logout 按钮 1:1 平行. -->
          <BellIcon />
          <button @click="logout">退出</button>
        </div>
      </header>
      <section class="content">
        <slot />
      </section>
    </main>
  </div>
</template>

<script setup>
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { useTheme } from '../composables/useTheme.js';
import { useFeatureFlagsStore } from '../stores/featureFlags.js';
// R158.104 (2026-10-14) — sidebar 底部 fixed 当前用户 widget
//   (Profile / 改密码 / MCP Token 申请 / 退出全部). 1:1 平行
//   AdminLayout 现有 sidebar 形态, 但仅 AppLayout 加 (操作员决策
//   #4 "仅 AppLayout 不走 admin 后台"). 0 改 topbar 现有 username
//   显示 (line 89) — widget 是冗余备份入口.
import UserWidget from './UserWidget.vue';
import { useLicenseStateStore } from '../stores/licenseState.js';
// R158.X.99.34.d (2026-10-19) — in-app notification bell. 操作员 directive
//   "操作员登录 dashboard 后,在 dashboard 内部推送/显示告警消息给管理员".
//   BellIcon 是 in-app notification 入口, mounted 在 topbar-actions 跟 logout
//   button 1:1 平行 (跟 AdminLayout topbar-actions 完全平行).
import BellIcon from './BellIcon.vue';
const auth = useAuthStore();
const router = useRouter();
function logout() { auth.logout(); router.push('/login'); }
const { theme, toggleTheme } = useTheme();
const featureFlags = useFeatureFlagsStore();
const licenseState = useLicenseStateStore();
// R158.73 (2026-10-11) — AD/NoAD toggle active 状态派生自 URL.
//   当前路由 startsWith('/memberServer') = NoAD active, 否则 AD active.
//   router-link 用 :class="{ active: ... }" 显式控, 不依赖 .router-link-active.
import { computed } from 'vue';
import { useRoute } from 'vue-router';
const route = useRoute();
const isAd = computed(() => !route.path.startsWith('/memberServer'));
</script>

<style scoped>
.layout { display: grid; grid-template-columns: 220px 1fr; height: 100vh; }
/* R158.104 — aside 改 flex-column, 让 UserWidget 固定在底部. 0 改
   padding, 0 改 border. 滚动归 .sidebar-nav (line 165), 0 归 aside. */
.sidebar { background: var(--sidebar-bg); padding: 20px; display: flex; flex-direction: column; }
.sidebar h3 { color: var(--accent); margin: 0 0 16px; }
/* R158.71 — Sidebar nav: 4 分组 vertical stack, 跟当前业务面板的
   4 域 (监控/复制/资产/运维) 对齐. R158.71.1 (12:25 CST) —
   operator 反馈 "看不出分组效果" 真因: 之前 muted uppercase 小字
   视觉权重太低被忽略. 修:
       · 标题改 accent 蓝色 + 13px + 600 + 底部 1px 下划线 + 上下 padding
         跟子项拉开层次
       · 子项 padding-left 加到 14px 让 indent 明显
       · nav-group 间 gap 12px → 18px 让分组感更强

   R158.104 — flex: 1 1 auto + min-height: 0 + overflow-y: auto 让
   nav 吃掉 aside 中间所有空间, 滚动归 nav (aside 自己不滚),
   .sidebar-widget 永远 fixed 在底部. */
.sidebar-nav { display: flex; flex-direction: column; gap: 18px; flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.nav-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nav-group-title {
  margin: 0;
  padding: 6px 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
  border-bottom: 1px solid var(--border);
  letter-spacing: 0.02em;
  /* 大字 + accent 蓝色 + 下划线让分组感明确, 子项 indent + active 高亮 */
}
.nav-group-items { display: flex; flex-direction: column; gap: 2px; }
.sidebar a {
  padding: 8px 10px 8px 14px;
  border-radius: 4px;
  color: var(--text);
  /* indent 让子项跟标题视觉层次清晰 */
}
.sidebar a.router-link-active, .sidebar a:hover { background: var(--border); }
/* R158.104 — UserWidget 永远 fixed 在 aside 底部, flex-shrink: 0
   让它不随 nav 滚动而压缩, border-top 视觉跟 nav 隔开. */
.sidebar-widget { flex-shrink: 0; border-top: 1px solid var(--border); padding-top: 12px; margin-top: 12px; }
main { display: flex; flex-direction: column; }
.topbar { display: flex; justify-content: space-between; align-items: center; padding: 10px 20px; background: var(--panel); border-bottom: 1px solid var(--border); }
.topbar-actions { display: flex; gap: 8px; align-items: center; }
.topbar-actions button { padding: 6px 14px; border: 1px solid var(--border); border-radius: 3px; cursor: pointer; background: var(--input-bg); color: var(--text); }
.topbar-actions .admin-entry { color: var(--text); }
.topbar-actions .admin-entry:hover { filter: brightness(1.1); }
/* R158.34.3 — 日常管理 主入口: 蓝调高亮 (operator 主工作面板).
   跟 AdminLayout .nav-link.router-link-active 一致 (#3b82f6 border +
   rgba(96,165,250,0.14) bg + #60a5fa text), 让操作员一眼看到。*/
.topbar-actions .admin-entry--daily {
  background: rgba(96, 165, 250, 0.14);
  color: #60a5fa;
  border-color: #3b82f6;
  font-weight: 600;
}
/* R158.34.3 — 后台管理 备用控制台入口: 常规灰底 (R52 baseline).
   视觉权重比日常管理低, 表明它是 "all the other admin settings"
   而不是主工作面板。*/
.topbar-actions .admin-entry--back {
  background: var(--input-bg);
  color: var(--text);
}
.topbar-actions .theme-toggle { font-size: 14px; min-width: 32px; padding: 6px 8px; }
/* R158.73 — AD/NoAD segmented control toggle. 跟 .admin-entry 双色
   pattern 一致: active 蓝调高亮 (#3b82f6 border + rgba(96,165,250,
   0.14) bg + #60a5fa text), inactive 灰底常规. router-link 自动用
   .router-link-active 类, 但我们用 :class="{ active: isAd }" 显式
   控 (URL startsWith /memberServer = NoAD active). */
.view-toggle {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 3px;
  overflow: hidden;
  margin-right: 4px;
}
.view-toggle .toggle-btn {
  padding: 6px 14px;
  background: var(--input-bg);
  color: var(--text);
  text-decoration: none;
  font-size: 13px;
  font-weight: 500;
  border-right: 1px solid var(--border);
  transition: filter 0.15s;
}
.view-toggle .toggle-btn:last-child { border-right: none; }
.view-toggle .toggle-btn:hover { filter: brightness(1.1); }
.view-toggle .toggle-btn.active {
  background: rgba(96, 165, 250, 0.14);
  color: #60a5fa;
  border-color: #3b82f6;
  font-weight: 600;
}
.content { padding: 20px; overflow: auto; }
/* R158.License-expiry (2026-10-15) — layout-level 顶部 banner. 黄底 expiring_soon
   (复用 .ae-banner-empty AdminEmailView 范式 1:1 平行, 配色对齐) + 红底 expired
   (新加 .lic-banner-expired). 跨 AD/NoAD fleet 1:1 平行显示. 0 改 LicenseView
   内部 (R158.LA-V1-delete 锁定). 0 改 .topbar 既有 padding/border. */
.lic-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  margin: 0;
}
.lic-banner-warning {
  background: rgba(234, 179, 8, 0.10);
  color: #b45309;
  border-bottom-color: rgba(234, 179, 8, 0.4);
}
.lic-banner-expired {
  background: rgba(239, 68, 68, 0.10);
  color: #dc2626;
  border-bottom-color: rgba(239, 68, 68, 0.4);
}
.lic-banner-icon { font-size: 16px; }
.lic-banner-text { flex: 1 1 auto; }
</style>