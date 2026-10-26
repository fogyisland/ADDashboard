import { createRouter, createWebHistory } from 'vue-router';
import api from './api/client.js';
// R161.6 — feature flag 判定的唯一实现 (前端侧) —— 语义与后端
//   src/utils/featureFlag.js 逐字对齐, 由 tests/feature-flag-semantics.test.js
//   锁死两端一致。不在别处内联判定表达式。
import { resolveFeatureFlag } from './lib/featureFlag.js';
import LoginView from './views/LoginView.vue';
import DashboardView from './views/DashboardView.vue';
import TopologyView from './views/TopologyView.vue';
import ErrorsView from './views/ErrorsView.vue';
import AgentsView from './views/AgentsView.vue';
import UsersView from './views/admin/UsersView.vue';
import RolesView from './views/admin/RolesView.vue';
import ConfigView from './views/admin/ConfigView.vue';
import EmailConfigView from './views/admin/EmailConfigView.vue';
// R158.X.99 (2026-10-21) — Agent 客户端设置页. 后端 3 端点 R158.13 起就
// 存在 (push/state/delivery), 但前端 0 入口, 操作员只能逐台登服务器手改
// appsettings.json. 本页把 5 个白名单字段 (heartbeat/polling/discovery/
// healthCheck interval + logLevel) UI 化. perm 跟 email-config 同 umbrella.
import ClientSettingsView from './views/admin/ClientSettingsView.vue';
// R158.102 (2026-10-14) — MCP server token admin page. 1:1 平行
//   EmailConfigView 形状 (standalone AdminLayout page), 跟 backend
//   /api/admin/mcp-token 4 endpoint 配对. perm 走 admin:users
//   (umbrella — admin 角色持有 * grant 自动包含 admin:config perm
//   后端 check, 跟 email-config precedent 1:1).
import McpTokenView from './views/admin/McpTokenView.vue';
// R158.113 (2026-10-17) — MCP 写入集成 ship 1h 后, 操作员 directive "mcp 写入
//   集成放进 MCP 集成, 以第二个 tab 实现". McpTokenView 改 parent layout
//   (chrome + 2 tab + router-view), McpReadTabView 装原 McpTokenView 8 tool
//   content (只读), McpWriteTokenView 改 = 写入集成 child. 1:1 平行
//   /admin/system-settings:336-346 (FeatureFlagsView / LicenseView / AdminEmailView
//   3 children) + /report-center:285-295 (3 流水 views).
import McpReadTabView from './views/admin/McpReadTabView.vue';
import McpWriteTokenView from './views/admin/McpWriteTokenView.vue';
// R158.X.99.28 (2026-10-19) — MCP 集成 3rd tab "IP 白名单" child view.
//   1:1 平行 McpReadTabView / McpWriteTokenView import 范式. parent
//   McpTokenView 提供 chrome + 3 tab 横向条 + router-view, McpIpTabView
//   装本 tab content (JSON textarea + 启用 toggle + save).
import McpIpTabView from './views/admin/McpIpTabView.vue';
import AuditView from './views/admin/AuditView.vue';
import SitesCatalogView from './views/admin/SitesCatalogView.vue';
import DcsCatalogView from './views/admin/DcsCatalogView.vue';
import SiteReplicationMatrixAllView from './views/admin/SiteReplicationMatrixAllView.vue';
import SiteMatrixInboundView from './views/admin/SiteMatrixInboundView.vue';
// R158.10 (2026-10-01) — SiteMatrixOutboundView import + 路由一并删除
//   (operator decision: 不需要出战维度)。/matrix/outbound wrapper
//   下线,只留 /matrix/inbound。
// 2026-08-28 round-47: 复制伙伴端口健康监控 — per-site/DC port-health
// surface. Replaces the standalone ReplicationLogMonitorView (which
// listed replication-attempt history). Operator directive "在这边不叫
// 复制日志监控了，改成复制伙伴端口健康监控名称" + port-health is now
// the only surface for this URL (no caret expansion). Path preserved at
// /admin/replication-log/monitor for backward-compat with any saved
// bookmarks; the label and component change.
import PartnerPortHealthView from './views/admin/PartnerPortHealthView.vue';
// R155.2 — 复制伙伴端口监控拆两页 (inbound / outbound). Two thin
// wrappers over PartnerPortHealthView, each passing a different
// `direction` prop. Mirrors R153 SiteMatrixInboundView /
// SiteMatrixOutboundView pattern (router.js lines 100-102).
// R158.17.3 (2026-10-01) — OutboundView 文件重命名为 InboundView
// (R158.11 backlog 落地). 这个 wrapper 永远是 /monitor-inbound (入站)
// 的入口, 跟数据语义 v_partner_inbound + partnerPortInboundView 双源
// JOIN 对齐.
import PartnerPortHealthInboundView from './views/admin/PartnerPortHealthInboundView.vue';
// R155.4 (R156.5 retired 2026-09-30) — third partner-port view, was
// reading FROM ad_dc_probe_outbound physical table (migration 034).
// Operator directive: "复制伙伴端口主动探测 不需要哦去掉". The view file
// + route + sidebar entry are removed in R156.5; the underlying
// ad_dc_probe_outbound table is also dropped (mig 038 includes
// DROP TABLE) along with its collect.ps1 package (UPDATE
// package_policies id=10 SET enabled=0 in r156-retire).
// R158.5 (2026-09-30) — partner-discover moved from frontend (AppLayout)
// to backend (AdminLayout) with site grouping. Operator directive
// "将前台的复制伙伴发现入站和 复制伙伴出战 放到后台,这里的数据就是写那两个表,
// 然后以站点方式呈现,列出他的入站和出战partner". Two thin wrappers over
// the shared DiscoveryView base (which now accepts view-mode + chrome
// props);migrated away from the old AppLayout DiscoveryInboundView /
// DiscoveryOutboundView wrappers.
import PartnerDiscoverSiteInboundView from './views/admin/PartnerDiscoverSiteInboundView.vue';
// R158.10 (2026-10-01) — PartnerDiscoverSiteOutboundView import + 路由一并删除
//   (operator decision: 不需要 outbound partner)。
import OperationsLogView from './views/admin/OperationsLogView.vue';
// R158.46b (2026-10-06) — operator "AD 管理日志其实需要加入到 Sidebar 中".
//   拆出 OperationsLogView 的 ad-mgmt-block, 独立成 AdManagementLogView,
//   顶级 sidebar 菜单项 (peer-level with 系统运维日志 / 心跳与状态执行日志).
//   数据从 audit_logs ad_management category 拉, 3 子 tab 客户端切分
//   + ad_command lifecycle 横跨显示. perm: admin:users (跟其它运维日志同级).
import AdManagementLogView from './views/admin/AdManagementLogView.vue';
// R158.114 (2026-10-17) — MCP 执行和操作日志. 1:1 平行 R158.46 AD 管理日志
//   (/admin/ad-management-log). 复用 /api/admin/audit?category=mcp 既有端点 +
//   adminApi.getAudit 既有 wrapper, 0 引新 endpoint / 0 引新 wrapper / 0 引新
//   sql helper / 0 引新 perm (走 admin:users 跟 R158.46 1:1 平行). 0 改
//   McpTokenView 既有 2 sub-tab (R158.113.b 锁), 0 改 McpReadTabView /
//   McpWriteTokenView (R158.113.b 锁). 走独立 route 不嵌 McpTokenView 3rd
//   tab (R158.46 "AD 管理日志 0 嵌 McpTokenView 4th tab" 1:1 平行).
import McpOperationLogView from './views/admin/McpOperationLogView.vue';
import PortsView from './views/admin/PortsView.vue';
import PackagesView from './views/admin/PackagesView.vue';
// R158 (2026-09-30) — 包执行计划 page. Operator directive
// "在后台列出一个页面，按AD 执行计划包，这样可以让Agent 能够执行对应的计划效果，
// 最迟延迟一分钟，可以手动出发包的执行". Tables every installed package's
// last-7-days run health and exposes a "立即触发" button that hits
// packagesApi.triggerOnce(). Auth gate is `admin:packages` — same as
// /admin/packages. Lazily imported (lazy() factories) so the bundle
// only ships when the operator navigates here.
import PackageScheduleView from './views/admin/PackageScheduleView.vue';
import PackageEditView from './views/admin/PackageEditView.vue';
import RegistryView from './views/admin/RegistryView.vue';
import InitWizardView from './views/init/InitWizardView.vue';
import ServersOverviewView from './views/ServersOverviewView.vue';
import LockoutTroubleshootingView from './views/LockoutTroubleshootingView.vue';
// R112 — eventlog monitoring page (DC 基本情况). Operator directive
// (2026-09-26) "其实也是需要登录到普通用户界面，普通用户界面可以看到
// DC基本情况，后台可以进行管理而已" — auth required (login → regular
// user), NO admin perm gate. Lives inside AppLayout chrome like
// /servers-overview. Backs onto the ad_eventlog_collector v2 package +
// centre-side post-hook ETL into ad_eventlog_summary + ad_eventlog_events
// public tables.
import EventlogView from './views/EventlogView.vue';
// R158.50 (2026-10-06) — 密码错误监控 dashboard (24h/7d 折线图 + 倒序
//   明细表). Mirrors LockoutAccountsView access tier (auth-required
//   regular user, no admin perm). Reads ad_failed_logon_events public
//   table populated every 2h by the ad_failed_logon_collector package.
import FailedLogonView from './views/FailedLogonView.vue';
// R158.X (2026-10-15) — 账户变更明细 (AccountChangeDetailView). 监控告警
//   group 第 6 项 (挂在 密码错误监控 后). 1:1 平行 /eventlog / /os-baseline
//   / /lockout-accounts / /failed-logon-2h 形态 (auth-required, NO admin
//   perm gate). 复用 ad_account_change 5-action 聚合 + ad_eventlog_events
//   Security log 账户管理 event 列表.
import AccountChangeDetailView from './views/AccountChangeDetailView.vue';
// R158.1W.1 (2026-10-16) — 密码错误分布图 (原名: 账户-工作站关联网络图 → 账户访问分布图 → 密码错误分布图,
//   2026-10-17 操作员 directive 改 "密码错误分布图" 对齐 event 名 4625 + 跟 4740 账户锁定分布图 1:1 平行,
//   AccountWorkstationGraphView 组件名 + router path 0 改 [R158.77.3 跨 fleet 命名 1:1 锁]).
//   信息安全 group 第 4 项 (ECharts graph/force + sankey 双形态 toggle).
//   1:1 平行 /lockout-accounts / /failed-logon-2h access tier
//   (auth-required, NO admin perm gate). 后端 /api/failed-logon/
//   account-workstation-graph 单 endpoint, 返 { nodes, links } envelope
//   供 ECharts graph + sankey 复用, 1:1 平行 TopologyView 数据形状.
//   0 改 schema / 0 改 agent / 0 改 ETL. 复用 ad_failed_logon_events
//   public table 4625 数据 (R158.50 既有 9 endpoint 基础).
import AccountWorkstationGraphView from './views/AccountWorkstationGraphView.vue';
// R158.1W.3 (2026-10-16) — 账户锁定分布图 (LockoutAccountWorkstationGraphView).
//   信息安全 group 第 5 项 (1:1 平行 R158.1W.1 账户访问分布图, 数据源
//   ad_lockout_events 4740 vs ad_failed_logon_events 4625, 字段
//   caller_computer_name vs workstation_name). 1:1 平行 /lockout-accounts
//   / /failed-logon-2h access tier (auth-required, NO admin perm gate).
//   后端 /api/lockout/account-workstation-graph 单 endpoint, 返 { nodes, links }
//   envelope 跟 1W.1 1:1 平行, 0 改 wire. 0 改 1W.1 view / 0 改 1W.1 endpoint
//   / 0 改 1W.1 SQL helper / 0 改 1W.1 service fn / 0 改 1W.1 API wrapper.
//   0 改 schema / 0 改 agent / 0 改 ETL.
import LockoutAccountWorkstationGraphView from './views/LockoutAccountWorkstationGraphView.vue';
// R116 — OS Baseline 前台舰队视图. Operator directive (2026-09-26):
// "我们不需要在admin后台看到，直接在前台就可以看到" + "而且前台的界面中
// 如果磁盘超过了50%为黄色表示，超过80%红色，所以它是Grid格式" +
// "没有登录的EventLog 也没出现" — same auth-required-no-perm surface
// shape as /eventlog. Lives at the top level next to /eventlog. Backs
// onto the ad_os_baseline built-in v2 package + centre-side metricstore
// → pkg_ad_os_baseline.metrics public table. The 5-layer wire is
// collect.ps1 → /api/agent/packages/report → runner.js post-hook →
// ingest → listLatestPerAgent → /api/os-baseline → this view.
import OsBaselineView from './views/OsBaselineView.vue';
// R158.73 (2026-10-11) — NoAD 成员服务器 dashboard placeholder. 跟
//   /os-baseline / /eventlog 同档 (auth-required, NO admin perm gate).
//   当前 placeholder view, 后续 ship 真 MemberServer 详情 (operator
//   "将来需要添加 MemberServer 的界面"). 不动 admin/member-servers
//   已 ship 路由.
import MemberServerView from './views/MemberServerView.vue';
// R158.77 (2026-10-11) — 6 NEW children views for /memberServer/*
import MemberServerHomeView from './views/memberServer/MemberServerHomeView.vue';
import MemberServerOsBaselineView from './views/memberServer/MemberServerOsBaselineView.vue';
import MemberServerAgentsView from './views/memberServer/MemberServerAgentsView.vue';
import MemberServerPortsView from './views/memberServer/MemberServerPortsView.vue';
import MemberServerEventlogView from './views/memberServer/MemberServerEventlogView.vue';
import MemberServerPackagesView from './views/memberServer/MemberServerPackagesView.vue';
// R158.100 (2026-10-13) — 7th children view: admins (member-server local admin
//   group membership). 1:1 平行 R158.77 6 children 平行 ship, 0 改 source main tab.
import MemberServerAdminsView from './views/memberServer/MemberServerAdminsView.vue';
// R158.104.2 (2026-10-14) — /me self-service 4 独立全屏 page.
//   1:1 平行 /memberServer parent + 7 children 形态 (R158.77 +
//   R158.100 precedent), 但只用 4 children (profile / change-password
//   / mcp-token / logout-all). userAuth-only, 0 requirePerm (跟 R112
//   eventlog / R116 os-baseline 1:1 平行). 后端 6 /api/me/* endpoint
//   R158.104 ship 闭合, 0 改.
import MeView from './views/MeView.vue';
import MeProfileView from './views/me/MeProfileView.vue';
import MePasswordView from './views/me/MePasswordView.vue';
import MeMcpTokenView from './views/me/MeMcpTokenView.vue';
import MeLogoutAllView from './views/me/MeLogoutAllView.vue';
// R158.110 (2026-10-16) — 报表中心 admin-only parent + 4 children. 跟
//   /admin/system-settings:268-279 admin perm gate 1:1 平行 (meta.perm =
//   admin:users). 0 改老 route, 0 改 admin:users 权限定义. 后端 3
//   /api/report-center/* 端点 admin-only (跟 createReportsRouter /
//   createSystemAlertsRouter 1:1 平行 perm gate).
// R158.111.b (2026-10-16) — 删 3 top 聚合子路由 (操作员 directive "3 个 top
//   视图在报表中心没有意义, 去掉"). 报表中心现有 4 children 改 1 + 3:
//   '' 走 OverviewView (改 = 3 流水视图导航目录, 不调任何 top 端点),
//   'lockout-events' / 'failed-logon-events' / 'account-change-events'
//   3 流水视图保留 (R158.111.a 已 ship). 0 改 3 流水 view 既有 4 file
//   (LockoutEventsView / FailedLogonEventsView / AccountChangeEventsView
//   / AdminLayout sidebar), 0 改后端任何 SQL helper / service / endpoint
//   (R158.69 "用到端点就新建" directive 1:1 平行 — 删前端 0 改后端).
import ReportCenterView from './views/ReportCenterView.vue';
import ReportCenterOverviewView from './views/ReportCenterOverviewView.vue';
// R158.111.b (2026-10-16) — 3 top 聚合 view import 删除 (操作员 directive
//   "3 个 top 视图在报表中心没有意义, 去掉"). 0 改 3 流水 view 既有 import.
import ReportCenterLockoutEventsView from './views/ReportCenterLockoutEventsView.vue';
import ReportCenterFailedLogonEventsView from './views/ReportCenterFailedLogonEventsView.vue';
import ReportCenterAccountChangeEventsView from './views/ReportCenterAccountChangeEventsView.vue';
// R131 — 锁定账户信息 (LockoutAccountsView). Operator directive
// (2026-09-27) "在前台增加一个sidebar 菜单，增加一个锁定账户信息" —
// auth-required, NO admin perm gate. Same access tier as /eventlog /
// /os-baseline / /replication-log/monitor. Backs onto /api/lockout-
// events/recent (new R131 endpoint; locksRoute accepts requireAuth only,
// mirrors eventlog/osBaseline routers). Deep-link target for the locked-
// count badge on each 服务器总览 card — DcCard.vue passes
// `?dc=<host>` so the table pre-filters to that DC's lockouts.
import LockoutAccountsView from './views/LockoutAccountsView.vue';
// 2026-08-30 R67-T2: 包执行状态监控 (frontend 监控指标). Read-only surface
// that summarises the package_runs table per package (24h totals + last
// 10 runs drill-down). Operator directive "监控指标点进去就进入包管理状态,
// 我们是否可以监控包执行状态呢?" — slots the 监控指标 entry next to
// Agent 列表 and 服务器总览.
import PackageRunsMonitorView from './views/PackageRunsMonitorView.vue';
import MemberServersView from './views/admin/MemberServersView.vue';
import MemberServerDetailView from './views/admin/MemberServerDetailView.vue';
import ServerGroupsView from './views/admin/ServerGroupsView.vue';
import NotFoundView from './views/NotFoundView.vue';
// R158.87 (2026-10-12) — system-settings 域 (功能开关 + License 管理).
//   跟 R158.77 MemberServerView 同 precedent: parent w/ AdminLayout chrome
//   + 2-tab 横向条 + <router-view />. 2 children 走独立 endpoint
//   /api/admin/system-settings-v2/* (7 NEW endpoints, R158.87 backend ship).
//   老 /admin/system-settings/feature-flags / /license 路径是新加,
//   perm gate 走 admin:config 跟现有 system-config / email-config 同 precedent.
import SystemSettingsView from './views/admin/SystemSettingsView.vue';
import FeatureFlagsView from './views/admin/systemSettings/FeatureFlagsView.vue';
import LicenseView from './views/admin/systemSettings/LicenseView.vue';
// R158.AdminEmail (2026-10-15) — SystemSettings 第 3 子 tab "管理员邮件" 配置页.
//   跟 FeatureFlagsView / LicenseView 平级, 复用 system-settings 父路由 (admin:config perm).
import AdminEmailView from './views/admin/systemSettings/AdminEmailView.vue';

const routes = [
  { path: '/init', component: InitWizardView, meta: { public: true } },
  { path: '/login', component: LoginView, meta: { public: true } },
  // R112 — eventlog monitoring page. Operator directive (2026-09-26):
  // "其实也是需要登录到普通用户界面，普通用户界面可以看到DC基本情况，
  // 后台可以进行管理而已" — auth-required (regular user can see DC
  // basic state), NO admin perm. Lives at the top level alongside
  // /matrix, /servers-overview, /packages-runs — the auth-required-but-
  // no-perm surfaces. Backs onto the ad_eventlog_collector v2 package +
  // centre-side post-hook ETL into ad_eventlog_summary + ad_eventlog_events
  // public tables.
  { path: '/eventlog', component: EventlogView },
  // R116 — OS Baseline 前台 fleet grid. auth-required (regular user),
  // NO admin perm gate. Lives next to /eventlog at the top level so the
  // operator's "我们不需要在admin后台看到，直接在前台就可以看到" stays
  // literal — the page is reachable from the front-end sidebar (R116
  // Step 7 adds the link), not from /admin/*.
  { path: '/os-baseline', component: OsBaselineView },
  // R158.73 (2026-10-11) — NoAD 成员服务器 dashboard (placeholder).
  //   跟 /os-baseline / /eventlog / /replication-log/monitor-inbound 同档
  //   (auth-required, NO admin perm gate). 当前 placeholder view, 后续
  //   ship 真 MemberServer 详情 (operator "将来需要添加 MemberServer 的
  //   界面"). 不动 admin/member-servers 已 ship 路由.
  // R158.77 (2026-10-11) — 6 children sub-tabs (首页 / OS 基线 / Agent
  //   列表 / 应用端口 / 事件日志 / 包). Parent w/ AppLayout chrome +
  //   horizontal sub-tab strip + <router-view />. Each child view
  //   imports from src/api/member-server.js (5 NEW sibling endpoints).
  //   老 path /memberServer 仍然 work (children '' 匹配 home).
  {
    path: '/memberServer',
    component: MemberServerView,
    children: [
      { path: '',            component: MemberServerHomeView },
      { path: 'os-baseline', component: MemberServerOsBaselineView },
      { path: 'agents',      component: MemberServerAgentsView },
      { path: 'ports',       component: MemberServerPortsView },
      { path: 'eventlog',    component: MemberServerEventlogView },
      { path: 'packages',    component: MemberServerPackagesView },
      // R158.100 (2026-10-13) — 7th children route, 跟 R158.77 6 children 1:1 平行.
      { path: 'admins',      component: MemberServerAdminsView }
    ]
  },
  // R158.104.2 (2026-10-14) — /me self-service 4 独立全屏 page.
  //   1:1 平行 /memberServer parent + 7 children 形态 (R158.77 +
  //   R158.100 precedent), parent 提供 AppLayout chrome + 4 sub-tab
  //   横向条 + <router-view/>, children 各自独立 route 利于 bookmark /
  //   deep-link / 浏览器后退. 0 meta.perm (userAuth-only, 跟 R112
  //   eventlog / R116 os-baseline / R131 lockout-accounts 1:1 平行
  //   "auth-required, no-perm" surface). '' 默认进 Profile (跟
  //   /memberServer default 进 Home 1:1 平行).
  {
    path: '/me',
    component: MeView,
    children: [
      { path: '',                component: MeProfileView },
      { path: 'change-password', component: MePasswordView },
      // F1 (2026-10-20) — admin-only. mcp_api_token_current 是全局单值, 后端
      //   /api/me/mcp-token/reveal + /rotate 已加 requirePerm('admin:config')
      //   (routes/me-mcp.js). NOTE: 本项目的 meta.perm 目前**没有任何客户端
      //   强制点** — router.beforeEach (line 558) 只做 init/license/token 检查,
      //   不读 to.meta.perm; 各 admin 页面靠 AdminLayout/AppLayout 上的
      //   v-if="auth.isAdmin" gate。所以这里加 meta 只是声明性的一致性标注,
      //   真正拦住非 admin 的是 views/MeView.vue 里 tabs 的 adminOnly 过滤
      //   (该 tab 不再渲染) + 后端 requirePerm (纵深防御)。
      { path: 'mcp-token', component: MeMcpTokenView, meta: { perm: 'admin:config' } },
      { path: 'logout-all',      component: MeLogoutAllView }
    ]
  },
  // R158.110 (2026-10-16) — 报表中心 parent + 4 children (admin-only). 跟
  //   /admin/system-settings:268-279 admin perm gate 1:1 平行. children
  //   '' 默认进 Overview (3 卡片 grid 总览). 0 改老 route, 0 改
  //   admin:users 权限定义.
  // R158.111.b (2026-10-16) — 删 3 top 聚合子路由 (lockout / failed-logon /
  //   account-change). 4 children 改 1 + 3: OverviewView (改 = 3 流水视图
  //   导航目录) + 3 流水视图 children. 0 改 3 流水 children, 0 改老 route
  //   'lockout' / 'failed-logon' / 'account-change' 之外的 route.
  {
    path: '/report-center',
    component: ReportCenterView,
    meta: { perm: 'admin:users', featureFlag: 'report_center.enabled' },
    children: [
      { path: '',                        component: ReportCenterOverviewView,
        meta: { featureFlag: 'report_center.enabled' } },
      // R158.111.b — 3 流水视图 children 跟 R158.111.a 1:1 平行.
      // R158.X.116.n — 3 个 child 的 featureFlag 必须是**数组**, 把总闸重复
      //   写进去。vue-router 的 to.meta 是父子 merge 且**子级同名 key 覆盖父级**
      //   (见本文件 line ~621 注释), 只写子闸会把父级的 report_center.enabled
      //   顶掉 —— 于是「总闸关 + 子闸开」时子页面反而能进, 绕过总闸。
      { path: 'lockout-events',          component: ReportCenterLockoutEventsView,
        meta: { featureFlag: ['report_center.enabled', 'report_center.lockout.enabled'] } },
      { path: 'failed-logon-events',     component: ReportCenterFailedLogonEventsView,
        meta: { featureFlag: ['report_center.enabled', 'report_center.failed_logon.enabled'] } },
      { path: 'account-change-events',   component: ReportCenterAccountChangeEventsView,
        meta: { featureFlag: ['report_center.enabled', 'report_center.account_change.enabled'] } }
    ]
  },
  { path: '/', component: DashboardView },
  // R153 — 2026-09-29 operator directive "将站点矩阵改成站点入站矩阵 和
  // 站点出战矩阵 作为两页放在这个菜单下面". The single /matrix route is
  // replaced by two thin wrappers over SiteMatrixView:
  //   /matrix/inbound   → 站点入站矩阵 (rows = receiving DCs)
  //   /matrix/outbound  → 站点出战矩阵 (rows = sending DCs)
  // Both share /api/dashboard/site-replication-matrix/all?direction=…
  // — different lenses on the same payload. The legacy /matrix route is
  // kept as a perm-redirect to /matrix/inbound so saved bookmarks do not
  // 404 mid-migration.
  { path: '/matrix/inbound', component: SiteMatrixInboundView },
  // R158.10 (2026-10-01) — /matrix/outbound 路由下线 (operator:
  //   删除站点出战举证)。只留 /matrix/inbound。
  // R158.11 (2026-10-01) — /matrix 现在直接是主路径 (不再 redirect
  //   到 /matrix/inbound), 因 sidebar label 已统一叫 "复制矩阵",
  //   不再有 inbound 后缀含义;老 /matrix/inbound 仍保留作 backward
  //   compat 防止书签 404。
  { path: '/matrix', component: SiteMatrixInboundView },
  { path: '/matrix/inbound', component: SiteMatrixInboundView },
  { path: '/matrix/outbound', redirect: '/matrix' },
  { path: '/topology', component: TopologyView },
  { path: '/errors', component: ErrorsView },
  { path: '/agents', component: AgentsView },
  { path: '/admin/users', component: UsersView, meta: { perm: 'admin:users' } },
  { path: '/admin/roles', component: RolesView, meta: { perm: 'admin:users' } },
  { path: '/admin/config', component: ConfigView, meta: { perm: 'admin:users' } },
  { path: '/admin/email-config', component: EmailConfigView, meta: { perm: 'admin:users' } },
  { path: '/admin/client-settings', component: ClientSettingsView, meta: { perm: 'admin:users' } },
  // R158.102 (2026-10-14) — MCP 集成 standalone admin page. 类 email-config
  //   1:1 平行: 跟 /admin/config (agent-token rotate UI) 互不干扰, 独立
  //   /admin/mcp-token URL 便于 bookmark + audit 关联.
  // R158.113 (2026-10-17) — MCP 写入集成 ship 1h 后, 操作员 directive "mcp 写入
  //   集成放进 MCP 集成, 以第二个 tab 实现". 改 /admin/mcp-token 为 parent route
  //   + 2 children (''=只读 / 'write'=写入), 1:1 平行 /admin/system-settings:336-346
  //   (feature-flags / license / admin-email) + /report-center:285-295 (overview /
  //   3 流水视图). perm gate 走父级 (admin:users), children 0 必 repeat.
  // 0 me 端镜像 (R158.113 锁: 操作员 directive "个人账户默认不能申请写入").
  {
    path: '/admin/mcp-token',
    component: McpTokenView,
    // R158.X.116.k (2026-10-23) — featureFlag: 'mcp.enabled'。整个 MCP 集成
    //   关闭时, /admin/mcp-token* 全部进不去 (beforeEach 守卫弹回 /),
    //   且 AdminLayout sidebar 的「MCP 集成」入口消失。前后端同时关:
    //   后端 routes/mcp.js isMcpEnabled gate 让已持有的 mcp_ token 也调不通。
    //   1:1 平行 /daily-ops 的 meta.featureFlag (R158.X.116.i)。
    meta: { perm: 'admin:users', featureFlag: 'mcp.enabled' },
    children: [
      { path: '',             component: McpReadTabView },
      // 写 tab 需要**两个**开关同时满足: 数组而非单值 —— vue-router 的
      //   to.meta 父子 merge 是"子级同名 key 覆盖父级", 写单值会把父级
      //   mcp.enabled 顶掉, 导致总开关关时写 tab 反而能进 (绕过)。
      //   数组 = 全部满足才放行 (guard 见下方 featureFlag 分支)。
      { path: 'write', component: McpWriteTokenView, meta: { featureFlag: ['mcp.enabled', 'mcp_write.enabled'] } },
      // R158.X.99.28 (2026-10-19) — MCP IP 白名单 3rd tab. 1:1 平行
      //   R158.87 system-settings 3 children (feature-flags / license /
      //   admin-email) + R158.110 report-center 4 children 范式. perm
      //   走父级 admin:users, 0 必 repeat. 0 me 端镜像 (R158.113 锁).
      { path: 'ip-whitelist', component: McpIpTabView }
    ]
  },
  // R158.113.b (2026-10-17) — /admin/mcp-write-token 老独立 route redirect
  //   到 /admin/mcp-token/write 写入 tab, 防 bookmark 404 + 老 ship 完 24h
  //   probe verify 时 admin 已点过的 URL 仍 work. 跟 R158.45.20 'ad-users'
  //   redirect '/daily-ops' + R158.10 'matrix/outbound' redirect '/matrix'
  //   1:1 平行. 跟 R158.69 "用到端点就新建" + R158.61~68 删 R62 端点同步删
  //   前端引用 锁 1:1 平行.
  { path: '/admin/mcp-write-token', redirect: '/admin/mcp-token/write' },
  // R158.87 (2026-10-12) — system-settings 父路由 + 2 children.
  //   'admin:config' perm gate (跟 system-config 平行, 跟 R158.87 backend
  //   requirePerm('admin:config') 1:1 对齐). 子路由 '' 重定向到
  //   feature-flags 避免一进 /admin/system-settings 就是空 router-view.
  {
    path: '/admin/system-settings',
    component: SystemSettingsView,
    meta: { perm: 'admin:users' },
    children: [
      { path: '',            redirect: 'feature-flags' },
      { path: 'feature-flags', component: FeatureFlagsView },
      { path: 'license',       component: LicenseView },
      // R158.AdminEmail (2026-10-15) — 第 3 子 tab, 排在 license 之后.
      { path: 'admin-email',   component: AdminEmailView }
    ]
  },
  { path: '/admin/audit', component: AuditView, meta: { perm: 'admin:users' } },
  { path: '/admin/sites-catalog', component: SitesCatalogView, meta: { perm: 'admin:users' } },
  { path: '/admin/dcs-catalog', component: DcsCatalogView, meta: { perm: 'admin:users' } },
  // 2026-08-27 round-33: single-site /admin/site-replication-matrix removed.
  // Replaced by /admin/site-replication-matrix/all (renamed 复制状态概览)
  // which is the unified per-primary-DC replication overview.
  { path: '/admin/site-replication-matrix/all', component: SiteReplicationMatrixAllView, meta: { perm: 'admin:users' } },
  // 2026-08-28 round-47: 复制伙伴端口健康监控. The path stays
  // /admin/replication-log/monitor for backward-compat with any saved
  // bookmarks; the component and label change. Port-health cells are the
  // only surface (no replication-attempts caret).
  // R129 — 2026-09-27 operator directive "将 /admin/replication-log/monitor
  // 这个界面从后台管理界面移动到前台". Moved path
  // /admin/replication-log/monitor → /replication-log/monitor (top-level
  // alongside /eventlog and /os-baseline) and dropped meta.perm so any
  // logged-in user can reach it. Same migration shape as R112/R116:
  // data layer unchanged, view chrome swapped from AdminLayout to
  // AppLayout, sidebar entry moved to AppLayout and removed from
  // AdminLayout. Backend /api/dashboard/partner-port-health/all unchanged.
  // R155.3 — operator 2026-09-30 directive "链接更改为 monitor-inbound,
  // 数据写入 replication_inbound 表或者视图"。路径名 /monitor 改为
  // /monitor-inbound (operator 主用, label "入站" = 我从这些源拉);
  // /monitor-outbound 保留 (label "出战" = 源从我拉)。
  // /monitor 是 R155.3 之前的 alias,R155.3 后已被
  // /monitor-inbound 完全替代,删 path 避免双指向。
  { path: '/replication-log/monitor-inbound', component: PartnerPortHealthInboundView },
  // R158.10 (2026-10-01) — /replication-log/monitor-outbound 路由下线
  //   (operator: 删除复制伙伴端口出战)。
  // R158.5 (2026-09-30) — partner-discover moved from /replication-log/
  // (frontend AppLayout) to /admin/partner-discover/ (backend AdminLayout
  // with site grouping). The frontend paths are gone; any saved bookmark
  // to /replication-log/discover-inbound or /discover-outbound now 404s
  // because operator explicitly asked to delete them ("前台删除").
  // 数据源 / 视图 / endpoint 都跟 R156 一致,只是换 chrome + 加 site 维度。
  { path: '/admin/partner-discover/inbound',  component: PartnerDiscoverSiteInboundView,  meta: { perm: 'admin:users' } },
  // R158.10 (2026-10-01) — /admin/partner-discover/outbound 路由下线
  //   (operator decision: 不需要 outbound partner)。PartnerDiscoverSiteOutboundView
  //   文件删除 (router import + 组件引用一并移除)。

  // R131 — 2026-09-27 operator directive "在前台增加一个sidebar 菜单，
  // R131 — 2026-09-27 operator directive "在前台增加一个sidebar 菜单，
  // 增加一个锁定账户信息" — auth-required regular-user surface, NO
  // admin perm gate. Lists recent lockout events in a 4-column table
  // (锁定账户 / 锁定时间 / 主题 谁锁的 / 锁定客户端). Deep-link entry:
  // /lockout-accounts?dc=<host> from DcCard.vue's locked-count badge —
  // the view pre-filters rows by dcName. The deep-drill admin surface
  // /lockout-troubleshooting stays where it is (admin perm required) —
  // this page is the at-a-glance landing for "what just got locked".
  { path: '/lockout-accounts', component: LockoutAccountsView },
  // R158.50 — 密码错误监控 dashboard. userAuth-only (no admin perm).
  // Mirrors /lockout-accounts access tier. 24h/7d line chart toggle +
  // reverse-chronological detail table at /failed-logon-2h.
  { path: '/failed-logon-2h', component: FailedLogonView },
  // R158.X (2026-10-15) — 账户变更明细. 平行 /eventlog / /os-baseline /
  //   /lockout-accounts / /failed-logon-2h, 顶层 flat path, 无 meta
  //   (token gate 由 router.beforeEach line 411-413 自动拦截). AD 端
  //   专属 (NoAD fleet v-if=!isAd 互斥, AppLayout 入口已 gate). 0 改
  //   dashboardRouter (有 read:dash gate, 不 host 新 endpoint).
  { path: '/account-change-detail', component: AccountChangeDetailView },
  // R158.1W.1 (2026-10-16) — 账户访问分布图 (原名: 账户-工作站关联网络图). 信息安全 group
  //   第 4 项, 1:1 平行 /lockout-accounts / /failed-logon-2h / /account-
  //   change-detail 顶层 flat path, 0 meta (无 admin perm, userAuth 自动
  //   gate 走 router.beforeEach). AD 端专属 (NoAD fleet v-if=!isAd 互斥,
  //   AppLayout 入口已 gate). 0 改 dashboardRouter (read:dash gate, 不
  //   host 新 endpoint). 0 改既有 3 路由.
  { path: '/account-workstation-graph', component: AccountWorkstationGraphView },
  // R158.1W.3 (2026-10-16) — 账户锁定分布图 (1:1 平行 R158.1W.1
  //   账户访问分布图). 信息安全 group 第 5 项, 跟 1W.1 第 4 项 1:1 平行
  //   (auth-required, NO admin perm gate, 跟 /lockout-accounts / /failed-logon-2h
  //   / /account-change-detail 同档). 0 改既有 4 信息安全 route.
  { path: '/lockout-account-workstation-graph', component: LockoutAccountWorkstationGraphView },
  { path: '/admin/migrations', component: () => import('./views/admin/SchemaMigrationsView.vue'), meta: { perm: 'admin:users' } },
  { path: '/admin/ports', component: PortsView, meta: { perm: 'admin:users' } },
  { path: '/admin/heartbeat-report', component: () => import('./views/admin/HeartbeatReportMonitorView.vue'), meta: { perm: 'admin:users' } },
  // R158.34 (2026-10-02) — 日常管理 quick-access page. Operator directive
  // "在后台管理的右上角增加一个日常管理按钮, 我们针对AD的用户进行运维管理...
  // 也是以树状目录呈现".
  // R158.34.4 (2026-10-02) — 路由路径 /admin/daily-ops → /daily-ops
  //   + 拿掉 <AdminLayout> wrapper (DailyOpsView 自带 chrome, 自己的 topbar
  //   + content). Operator directive "日常管理不需要包裹在后台管理中".
  //   脱离 /admin 命名空间, 完全独立顶级路由, 跟 /admin/* 平级但不同根。
  //   路由仍受 `meta.perm: 'admin:users'` gate 保护, 仅 admin 角色可访问。
  //   Lazy import 保留 (跟 HeartbeatReportMonitor 同 precedent)。
  // R158.X.116.i (2026-10-23) — 加 `featureFlag` meta, 让"关掉开关 = 进不去"
  //   成立. 之前只有 AppLayout.vue:161 的**按钮**受 flag gate, 而
  //   meta.perm 在本项目**客户端根本不读** (见 line 295-300 的注释:
  //   beforeEach 只做 init/license/token 检查), 所以直接敲 URL
  //   /daily-ops 照样能进 —— 显示关了、准入没关, 口径分裂。
  //   判定在 beforeEach 里做 (line ~590), 跟 license gate 同层。
  { path: '/daily-ops', component: () => import('./views/admin/DailyOpsView.vue'), meta: { perm: 'admin:users', featureFlag: 'ad_management.enabled' } },
  // 2026-08-27 round-39: 运维区统一日志 — 审计事件 + 心跳 + 报告 三块合一.
  // R158.46b (2026-10-06) — AD 管理日志从本页拆出到 /admin/ad-management-log
  //   (operator: AD 管理日志其实需要加入到 Sidebar 中, 顶级菜单项).
  { path: '/admin/operations-log', component: OperationsLogView, meta: { perm: 'admin:users' } },
  { path: '/admin/ad-management-log', component: AdManagementLogView, meta: { perm: 'admin:users' } },
  // R158.114 (2026-10-17) — MCP 执行和操作日志. 1:1 平行 R158.46 AD 管理日志
  //   (/admin/ad-management-log 上一行). 走 admin:users perm (跟 R158.46
  //   1:1 平行), 0 引新 perm. 0 改既有 50+ 路由.
  { path: '/admin/mcp-operation-log', component: McpOperationLogView, meta: { perm: 'admin:users' } },
  // 2026-08-28 round-53: /admin/orphan-schemas route + view DELETED per
  // operator directive "删除Schema和清理菜单". Per feedback_full_chain_cleanup
  // the whole chain goes — sidebar entry, route, view, and any tests that
  // referenced it. The DB column `schema_migrations.error_message` and
  // migration failure flow remain intact (R50's fix); this was only the
  // operator-facing diagnostic view.
  { path: '/admin/packages', component: PackagesView, meta: { perm: 'admin:packages' } },
  // R158 — 包执行计划 page (manual-trigger surface). Same perm as
  // /admin/packages. Path kept flat (not nested under /admin/packages)
  // so the sidebar entry doesn't accidentally nest under the
  // existing 脚本与策略 group header.
  { path: '/admin/packages-schedule', component: PackageScheduleView, meta: { perm: 'admin:packages' } },
  { path: '/admin/packages/registry', component: RegistryView, meta: { perm: 'admin:packages' } },
  { path: '/admin/packages/:name', component: PackageEditView, meta: { perm: 'admin:packages' } },
  { path: '/packages-runs', component: PackageRunsMonitorView },
  { path: '/servers-overview', component: ServersOverviewView },
  { path: '/lockout-troubleshooting', component: LockoutTroubleshootingView },
  { path: '/admin/member-servers', component: MemberServersView, meta: { perm: 'admin:users' } },
  { path: '/admin/member-servers/:hostname', component: MemberServerDetailView, meta: { perm: 'admin:users' } },
  { path: '/admin/server-groups', component: ServerGroupsView, meta: { perm: 'admin:users' } },
  // R158.X.115 (2026-10-20) — 退役/暂停管控总览 (DC + member 一页看完)。
  // 走 admin:users 与既有 成员服务器管理 同级, 与 DC 退役 (admin:ad-objects)
  // 双门由后端在 server-lifecycle 路由处合并要求。0 改 perm 定义。
  { path: '/admin/server-lifecycle', component: () => import('./views/admin/ServerLifecycleView.vue'), meta: { perm: 'admin:users' } },
  // 2026-08-28 round-53: 3 new placeholder routes (mock-first per operator directive
  // "先做mock 到时候agent 按照mock方案改造就好了"). UI is in place; backend
  // endpoints + agent-side wire-up pending.
  { path: '/admin/ad-file-push',         component: () => import('./views/admin/AdFilePushView.vue'),         meta: { perm: 'admin:users' } },
  { path: '/admin/member-file-push',     component: () => import('./views/admin/MemberFilePushView.vue'),     meta: { perm: 'admin:users' } },
  // 2026-09-05 R81: 成员服务器 PowerShell 命令执行 — surface for free-form
  // PowerShell execution against registered member-server hostnames. Mirrors
  // R75 surface (AdCommandHistoryDrawer right-side + ExecuteCommandModal
  // modal) but for member-script only. Old MemberCommandExecView (R53
  // placeholder) is now orphaned (route repointed to MemberCommandsView).
  { path: '/admin/member-command-exec',  component: () => import('./views/admin/MemberCommandsView.vue'),     meta: { perm: 'admin:users' } },
  // R158.45.20 (2026-10-05) — operator "operation 账户管理/ou管理 那些界面不需要, 可以去掉".
  //   移除 standalone 路由 /admin/ad-users + /admin/ad-groups. View 文件保留
  //   (DailyOpsView DC view dcTab + 旧 kind=user/group 路径仍在 embedded 模式
  //   复用, 不删 view 避免 DailyOpsView 编译失败). 已 redirect 避免书签 404.
  { path: '/admin/ad-users',  redirect: '/daily-ops' },
  { path: '/admin/ad-groups', redirect: '/daily-ops' },
  // R158.35 (2026-10-03) — AD directory LDAP sync config + manual trigger
  // + run history. Same admin:ad-objects perm gate as /admin/ad-users
  // (legacy admin:users umbrella also grants via _hasPerm). Lazy-import
  // for the same bundle-size reasons as DailyOpsView / HeartbeatReport.
  { path: '/admin/directory-sync',       component: () => import('./views/admin/DirectorySyncView.vue'),    meta: { perm: 'admin:ad-objects' } },
  // R158.37 (2026-10-03) — 域和森林注册 (Forest Registry). 后台「运维」
  // group 下, 入口标「域和森林注册」。三 tab 页 (森林 / 域 / 域设置),
  // 后端 4 张物理表 CRUD + DailyOpsView forest 切换器的取数入口。同
  // admin:ad-objects perm gate.
  { path: '/admin/forest-registry',      component: () => import('./views/admin/ForestRegistryView.vue'),   meta: { perm: 'admin:ad-objects' } },
  // 2026-09-01 R74: 复制错误 — focused triage view that lists every
  // (source_dc, dest_dc, naming_context) tuple whose latest status row
  // is a failure (status_code IN 1, 2). Default 24h window, 7d opt-in
  // via the toolbar <select>. Sits inside the admin 监控与诊断 group.
  { path: '/admin/replication-errors',    component: () => import('./views/admin/ReplicationErrorsView.vue'), meta: { perm: 'admin:users' } },
  { path: '/:pathMatch(.*)*', component: NotFoundView }
];

const router = createRouter({ history: createWebHistory(), routes });

let initStatusCache = null;
async function getInitStatus() {
  if (initStatusCache !== null) return initStatusCache;
  try {
    const r = await api.get('/api/init/status');
    initStatusCache = r.data;
  } catch {
    initStatusCache = { needsInit: false };
  }
  return initStatusCache;
}

router.beforeEach(async (to) => {
  const status = await getInitStatus();
  if (status.needsInit && to.path !== '/init') return { path: '/init' };
  if (!status.needsInit && to.path === '/init') return { path: '/login' };
  if (to.meta.public) return true;
  const t = localStorage.getItem('ad_token');
  if (!t) return { path: '/login', query: { redirect: to.fullPath } };
  // R158.License-expiry (2026-10-15) — license gate: expired → redirect to license 页.
  //   1:1 平行 init wizard gate 范式 (line 425). 死循环 guard: 已在 license 页 → 放行.
  //   公开端点 fail-closed (R158.103): API 失败 → status='unknown' → 0 redirect.
  //   模块级 cache 30s TTL, 跟 getInitStatus 1:1 平行 (但 initStatusCache 0 TTL,
  //   license 有 30s 避免每次 route change 都查 DB).
  //
  // R158.X.99-trial (2026-10-21) — 2 处改动:
  //   ① trial 过期也拦. 旧条件只认 status==='expired' (正式 license 过期), 未授权的新装
  //      机走的是 status==='none' + trial.active=false, 一个都拦不住. 判定改成看
  //      trial envelope 的 days_remaining<0 (trial 真过期), 0 依赖 status 枚举 —— 这样
  //      0 会跟 LoginView 的 banner 判定分叉 (前端判 days_remaining<0, 不判 active).
  //   ② 删 auth.isAdmin 判断. 操作员 2026-10-21 确认「系统没有普通用户」, 全员一刀切,
  //      少一层鉴权分支. 仍走 requireAuth (line 573-574 已校验 token), 0 放开未登录态.
  //   fail-closed 仍然放行: 端点挂 → status='unknown' + trial 缺失 → 条件不成立 → 照常进.
  //      这是刻意取舍 —— 一次 DB 抖动不该把整个系统锁死在门外 (lesson 71/72 同一脉络).
  const ls = await getLicenseStatus();
  const licenseBlocked = ls.status === 'expired'
    || (ls.trial && Number.isFinite(Number(ls.trial.days_remaining)) && Number(ls.trial.days_remaining) < 0);
  if (licenseBlocked && to.path !== '/admin/system-settings/license') {
    return { path: '/admin/system-settings/license' };
  }
  // R158.X.116.i (2026-10-23) — feature-flag gate. 路由 meta.featureFlag
  //   非空 → 该功能当前关闭则踢回首页. 跟上面的 license gate 同层,
  //   因为它防的是同一个问题: "关掉 = 真的关掉", 而不只是隐藏入口。
  //
  //   为什么必须有这一层: meta.perm 在本项目**客户端不生效**
  //   (见本文件 line 295-300 注释 + beforeEach 只做 init/license/token),
  //   此前 ad_management.enabled 只 gate 了 AppLayout 的按钮 v-if,
  //   直接敲 URL 仍能进 —— 入口消失了, 页面还在, 等于没关。
  //
  //   fail-OPEN (放行) 跟 license gate 刻意一致 (line 585-586 lesson 71/72):
  //   端点挂 / token 刚拿到还没 fetchAll 完 → flags 为空 → 视为未知,
  //   放行。一次网络抖动不该把人锁在门外; 真关闭时 store 有值,
  //   下一次 (或手动刷新) 就会被拦。
  // R158.X.116.k — meta.featureFlag 支持 string | string[]。
  //   **为什么必须是数组**: vue-router 的 to.meta 是父子 merge, 且
  //   **子级同名 key 覆盖父级** (不是追加)。所以 /admin/mcp-token/write
  //   若只写 featureFlag:'mcp_write.enabled', 父级的 mcp.enabled 就被
  //   覆盖掉了 —— 于是「MCP 总开关关 + 写开关开」时, 写 tab 反而能进,
  //   绕过父级 gate。数组语义 = **全部满足才放行**, 父子两层都表达得出来。
  if (to.meta && to.meta.featureFlag) {
    const required = Array.isArray(to.meta.featureFlag)
      ? to.meta.featureFlag
      : [to.meta.featureFlag];
    for (const key of required) {
      const on = await isFeatureEnabled(key);
      if (on === false) return { path: '/' };
    }
  }
  return true;
});

// R158.X.116.i — 模块级 feature-flag 读取, 30s TTL, 跟 getLicenseStatus
//   (line 600) **1:1 平行** shape (同样的 30s cache + 同样的 fail-open fallback),
//   只是判定的 key 不同。理由: beforeEach 在 Pinia store 初始化顺序之外跑,
//   直接用 store 有 TDZ 风险; 走 api client 则自动带上 Authorization header。
//   tri-state 返回 (true / false / null=未知), null 交调用方放行 —— 不要把
//   "查不到" 折成 false, 那会在端点抖动时把功能误关 (fail-closed 反向)。
let flagCache = null;
async function isFeatureEnabled(key) {
  // ⚠ TTL 分支**也要**走下面的 empty-map → null 判定. 不能在命中 cache 时
  //   直接 return 布尔: 端点抖动一次会把 {} 缓存住 30s, 那 30s 内每条
  //   featureFlag 路由都会被判 false → 全被踢回首页, 恰好是把
  //   fail-open 写成了 fail-closed (跟本函数注释的意图相反)。
  if (flagCache === null || Date.now() - flagCache._fetchedAt >= 30000) {
    try {
      const r = await api.get('/api/admin/system-settings-v2/feature-flags');
      const map = {};
      for (const item of (r.data?.items || [])) map[item.key] = item.value;
      flagCache = { map, _fetchedAt: Date.now() };
    } catch {
      flagCache = { map: {}, _fetchedAt: Date.now() };
    }
  }
  // map 为空 (端点挂了 / 首次还没拉到 / 登录态缺失) → null = 未知 → 调用方放行
  if (!flagCache.map || Object.keys(flagCache.map).length === 0) return null;
  // R161.6 — 三态判定走公共实现 (web/src/lib/featureFlag.js):
  //   true=明确开启 → 放行 / false=明确关闭 → 踢回首页 / null=未配置 → 放行。
  //   旧实现 (map[key] === '1') 把"缺 key"折成 false ⇒ 与后端 readFeatureFlag
  //   的"缺行 ⇒ 放行"相反 ⇒ 两层口径分裂。
  return resolveFeatureFlag(flagCache.map, key);
}

// R158.License-expiry (2026-10-15) — 公开端点 license-state 模块级 cache. 跟
//   getInitStatus 1:1 平行 shape, 但 30s TTL (避免每次 route change 都查 DB).
//   fail-closed (R158.103 lesson): API 失败 fallback status='unknown', should_redirect=false.
let licenseStatusCache = null;
async function getLicenseStatus() {
  if (licenseStatusCache !== null && Date.now() - licenseStatusCache._fetchedAt < 30000) {
    return licenseStatusCache;
  }
  try {
    const r = await api.get('/api/admin/system-settings-v2/license-state');
    licenseStatusCache = { ...r.data, _fetchedAt: Date.now() };
  } catch {
    licenseStatusCache = { status: 'unknown', should_redirect: false, _fetchedAt: Date.now() };
  }
  return licenseStatusCache;
}

export function resetInitStatusCache() {
  initStatusCache = null;
}

// Exported for tests so the module-level cache can be reset between cases.
export function _resetInitStatusCacheForTest() { initStatusCache = null; }

export default router;