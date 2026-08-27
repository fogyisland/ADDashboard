import { createRouter, createWebHistory } from 'vue-router';
import api from './api/client.js';
import LoginView from './views/LoginView.vue';
import DashboardView from './views/DashboardView.vue';
import SiteMatrixView from './views/SiteMatrixView.vue';
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
import ReplicationLogMonitorView from './views/admin/ReplicationLogMonitorView.vue';
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
  { path: '/matrix', component: SiteMatrixView },
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
  // 2026-08-27 round-42 (复制日志监控): per-DC partner tables augmented
  // with the latest 10 connection attempts. Expandable caret on each
  // partner row reveals attempt timestamp / status / duration / objects /
  // success time / error message.
  { path: '/admin/replication-log/monitor', component: ReplicationLogMonitorView, meta: { perm: 'admin:users' } },
  { path: '/admin/migrations', component: () => import('./views/admin/SchemaMigrationsView.vue'), meta: { perm: 'admin:users' } },
  { path: '/admin/ports', component: PortsView, meta: { perm: 'admin:users' } },
  { path: '/admin/heartbeat-report', component: () => import('./views/admin/HeartbeatReportMonitorView.vue'), meta: { perm: 'admin:users' } },
  // 2026-08-27 round-39: 运维区统一日志 — 审计事件 + 心跳 + 报告 三块合一.
  { path: '/admin/operations-log', component: OperationsLogView, meta: { perm: 'admin:users' } },
  { path: '/admin/orphan-schemas', component: () => import('./views/admin/OrphanSchemasView.vue'), meta: { perm: 'admin:users' } },
  { path: '/admin/packages', component: PackagesView, meta: { perm: 'admin:packages' } },
  { path: '/admin/packages/registry', component: RegistryView, meta: { perm: 'admin:packages' } },
  { path: '/admin/packages/:name', component: PackageEditView, meta: { perm: 'admin:packages' } },
  { path: '/dashboard/metrics', component: MetricDashboardView },
  { path: '/servers-overview', component: ServersOverviewView },
  { path: '/lockout-troubleshooting', component: LockoutTroubleshootingView },
  { path: '/admin/member-servers', component: MemberServersView, meta: { perm: 'admin:users' } },
  { path: '/admin/member-servers/:hostname', component: MemberServerDetailView, meta: { perm: 'admin:users' } },
  { path: '/admin/server-groups', component: ServerGroupsView, meta: { perm: 'admin:users' } },
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