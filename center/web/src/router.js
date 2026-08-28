import { createRouter, createWebHistory } from 'vue-router';
import api from './api/client.js';
import LoginView from './views/LoginView.vue';
import DashboardView from './views/DashboardView.vue';
import TopologyView from './views/TopologyView.vue';
import ErrorsView from './views/ErrorsView.vue';
import AgentsView from './views/AgentsView.vue';
import UsersView from './views/admin/UsersView.vue';
import RolesView from './views/admin/RolesView.vue';
import ConfigView from './views/admin/ConfigView.vue';
import EmailConfigView from './views/admin/EmailConfigView.vue';
import AuditView from './views/admin/AuditView.vue';
import SitesCatalogView from './views/admin/SitesCatalogView.vue';
import DcsCatalogView from './views/admin/DcsCatalogView.vue';
import SiteReplicationMatrixAllView from './views/admin/SiteReplicationMatrixAllView.vue';
// 2026-08-28 round-47: 复制伙伴端口健康监控 — per-site/DC port-health
// surface. Replaces the standalone ReplicationLogMonitorView (which
// listed replication-attempt history). Operator directive "在这边不叫
// 复制日志监控了，改成复制伙伴端口健康监控名称" + port-health is now
// the only surface for this URL (no caret expansion). Path preserved at
// /admin/replication-log/monitor for backward-compat with any saved
// bookmarks; the label and component change.
import PartnerPortHealthView from './views/admin/PartnerPortHealthView.vue';
import OperationsLogView from './views/admin/OperationsLogView.vue';
import PortsView from './views/admin/PortsView.vue';
import PackagesView from './views/admin/PackagesView.vue';
import PackageEditView from './views/admin/PackageEditView.vue';
import RegistryView from './views/admin/RegistryView.vue';
import InitWizardView from './views/init/InitWizardView.vue';
import MetricDashboardView from './views/MetricDashboardView.vue';
import ServersOverviewView from './views/ServersOverviewView.vue';
import LockoutTroubleshootingView from './views/LockoutTroubleshootingView.vue';
import MemberServersView from './views/admin/MemberServersView.vue';
import MemberServerDetailView from './views/admin/MemberServerDetailView.vue';
import ServerGroupsView from './views/admin/ServerGroupsView.vue';
import NotFoundView from './views/NotFoundView.vue';

const routes = [
  { path: '/init', component: InitWizardView, meta: { public: true } },
  { path: '/login', component: LoginView, meta: { public: true } },
  { path: '/', component: DashboardView },
  // 2026-08-29 round-59.1: /matrix redirected to the canonical R36
  // 复制状态概览 view (per-primary-DC replication overview). The
  // previous /matrix route mounted a 1032-byte stub (SiteMatrixView.vue)
  // that called the deleted /api/dashboard/site-matrix endpoint (R36
  // deletion in round-33) — empty UI since the deletion. Redirect
  // preserves any saved bookmarks from the old /matrix page and keeps
  // the AppLayout's "站点矩阵" sidebar entry useful. The stub view +
  // its SiteMatrixChart component + their tests are deleted; the
  // canonical view lives at /admin/site-replication-matrix/all.
  { path: '/matrix', redirect: '/admin/site-replication-matrix/all' },
  { path: '/topology', component: TopologyView },
  { path: '/errors', component: ErrorsView },
  { path: '/agents', component: AgentsView },
  { path: '/admin/users', component: UsersView, meta: { perm: 'admin:users' } },
  { path: '/admin/roles', component: RolesView, meta: { perm: 'admin:users' } },
  { path: '/admin/config', component: ConfigView, meta: { perm: 'admin:users' } },
  { path: '/admin/email-config', component: EmailConfigView, meta: { perm: 'admin:users' } },
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
  { path: '/admin/replication-log/monitor', component: PartnerPortHealthView, meta: { perm: 'admin:users' } },
  { path: '/admin/migrations', component: () => import('./views/admin/SchemaMigrationsView.vue'), meta: { perm: 'admin:users' } },
  { path: '/admin/ports', component: PortsView, meta: { perm: 'admin:users' } },
  { path: '/admin/heartbeat-report', component: () => import('./views/admin/HeartbeatReportMonitorView.vue'), meta: { perm: 'admin:users' } },
  // 2026-08-27 round-39: 运维区统一日志 — 审计事件 + 心跳 + 报告 三块合一.
  { path: '/admin/operations-log', component: OperationsLogView, meta: { perm: 'admin:users' } },
  // 2026-08-28 round-53: /admin/orphan-schemas route + view DELETED per
  // operator directive "删除Schema和清理菜单". Per feedback_full_chain_cleanup
  // the whole chain goes — sidebar entry, route, view, and any tests that
  // referenced it. The DB column `schema_migrations.error_message` and
  // migration failure flow remain intact (R50's fix); this was only the
  // operator-facing diagnostic view.
  { path: '/admin/packages', component: PackagesView, meta: { perm: 'admin:packages' } },
  { path: '/admin/packages/registry', component: RegistryView, meta: { perm: 'admin:packages' } },
  { path: '/admin/packages/:name', component: PackageEditView, meta: { perm: 'admin:packages' } },
  { path: '/dashboard/metrics', component: MetricDashboardView },
  { path: '/servers-overview', component: ServersOverviewView },
  { path: '/lockout-troubleshooting', component: LockoutTroubleshootingView },
  { path: '/admin/member-servers', component: MemberServersView, meta: { perm: 'admin:users' } },
  { path: '/admin/member-servers/:hostname', component: MemberServerDetailView, meta: { perm: 'admin:users' } },
  { path: '/admin/server-groups', component: ServerGroupsView, meta: { perm: 'admin:users' } },
  // 2026-08-28 round-53: 3 new placeholder routes (mock-first per operator directive
  // "先做mock 到时候agent 按照mock方案改造就好了"). UI is in place; backend
  // endpoints + agent-side wire-up pending.
  { path: '/admin/ad-file-push',         component: () => import('./views/admin/AdFilePushView.vue'),         meta: { perm: 'admin:users' } },
  { path: '/admin/member-file-push',     component: () => import('./views/admin/MemberFilePushView.vue'),     meta: { perm: 'admin:users' } },
  { path: '/admin/member-command-exec',  component: () => import('./views/admin/MemberCommandExecView.vue'), meta: { perm: 'admin:users' } },
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
  return true;
});

export function resetInitStatusCache() {
  initStatusCache = null;
}

// Exported for tests so the module-level cache can be reset between cases.
export function _resetInitStatusCacheForTest() { initStatusCache = null; }

export default router;