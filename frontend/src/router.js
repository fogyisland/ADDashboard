import { createRouter, createWebHistory } from 'vue-router';
import LoginView from './views/LoginView.vue';
import DashboardView from './views/DashboardView.vue';
import SiteMatrixView from './views/SiteMatrixView.vue';
import TopologyView from './views/TopologyView.vue';
import ErrorsView from './views/ErrorsView.vue';
import AgentsView from './views/AgentsView.vue';
import UsersView from './views/admin/UsersView.vue';
import RolesView from './views/admin/RolesView.vue';
import ConfigView from './views/admin/ConfigView.vue';
import AuditView from './views/admin/AuditView.vue';
import SitesView from './views/admin/ActiveSitesView.vue';
import DcsView from './views/admin/ActiveDcsView.vue';
import SitesCatalogView from './views/admin/SitesCatalogView.vue';
import NotFoundView from './views/NotFoundView.vue';

const routes = [
  { path: '/login', component: LoginView, meta: { public: true } },
  { path: '/', component: DashboardView },
  { path: '/matrix', component: SiteMatrixView },
  { path: '/topology', component: TopologyView },
  { path: '/errors', component: ErrorsView },
  { path: '/agents', component: AgentsView },
  { path: '/admin/users', component: UsersView, meta: { perm: 'admin:users' } },
  { path: '/admin/roles', component: RolesView, meta: { perm: 'admin:users' } },
  { path: '/admin/config', component: ConfigView, meta: { perm: 'admin:users' } },
  { path: '/admin/audit', component: AuditView, meta: { perm: 'admin:users' } },
  { path: '/admin/sites', component: SitesView, meta: { perm: 'admin:users' } },
  { path: '/admin/dcs', component: DcsView, meta: { perm: 'admin:users' } },
  { path: '/admin/sites-catalog', component: SitesCatalogView, meta: { perm: 'admin:users' } },
  { path: '/:pathMatch(.*)*', component: NotFoundView }
];

const router = createRouter({ history: createWebHistory(), routes });

router.beforeEach((to) => {
  if (to.meta.public) return true;
  const t = localStorage.getItem('ad_token');
  if (!t) return { path: '/login', query: { redirect: to.fullPath } };
  return true;
});

export default router;