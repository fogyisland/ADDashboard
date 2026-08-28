<template>
  <div class="layout" :class="{ 'sidebar-collapsed': !sidebarVisible }">
    <aside class="sidebar">
      <router-link to="/" class="back">← 返回看板</router-link>
      <h3>AD Dashboard · 管理</h3>
      <nav>
        <!-- 2026-08-28 round-52: restructure to 5 top-level groups with emoji icons
             (operator "从当前的侧边栏来看，问题主要在于分类粒度太细、部分功能归类不合逻辑、缺少核心运维模块").
             Layout: 3-level nesting where useful (AD 复制与端口 contains 3 sub-items
             that were R51's flat 3 entries); flat 2-level otherwise.

             R51 → R52 group map:
               监控健康        →  监控与诊断
               AD 管理         →  AD 目录服务
               服务器管理      →  服务器管理 (操作日志 lifted in here)
               账号管理        →  权限与账号
               数据库运维 + 系统设置 →  系统运维 (consolidated)
             -->
        <details v-for="g in groups" :key="g.title" open class="nav-group">
          <summary class="nav-group-title">
            <span class="icon">{{ g.icon }}</span>
            <span class="label">{{ g.title }}</span>
          </summary>
          <template v-for="i in g.items" :key="i.label || i.path">
            <!-- flat 2-level item -->
            <router-link
              v-if="!i.subItems"
              :to="i.path"
              class="nav-link"
            >{{ i.label }}</router-link>
            <!-- 3-level nested subgroup (only AD 复制与端口 currently) -->
            <details v-else open class="nav-subgroup">
              <summary class="nav-subgroup-title">{{ i.label }}</summary>
              <router-link
                v-for="sub in i.subItems"
                :key="sub.path"
                :to="sub.path"
                class="nav-sublink"
              >{{ sub.label }}</router-link>
            </details>
          </template>
        </details>
      </nav>
    </aside>
    <main>
      <header class="topbar">
        <div class="topbar-left">
          <button class="sidebar-toggle" :title="sidebarVisible ? '收起侧边栏' : '展开侧边栏'" @click="toggleSidebar">{{ sidebarVisible ? '‹' : '›' }}</button>
          <span>{{ auth.user?.username }} <small>({{ auth.user?.role }})</small></span>
        </div>
        <div class="topbar-actions">
          <button class="theme-toggle" :title="theme === 'dark' ? '切换到白天' : '切换到黑夜'" @click="toggleTheme">{{ theme === 'dark' ? '☀' : '🌙' }}</button>
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
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { useTheme } from '../composables/useTheme.js';
const auth = useAuthStore();
const router = useRouter();
function logout() { auth.logout(); router.push('/login'); }
const { theme, toggleTheme } = useTheme();

// 2026-08-28 round-52: sidebar collapse state. localStorage key
// 'admin-sidebar-visible' persists operator preference across reloads.
// Default true (sidebar visible).
const sidebarVisible = ref(true);
function loadSidebarVisible() {
  try {
    const v = localStorage.getItem('admin-sidebar-visible');
    if (v === 'false') sidebarVisible.value = false;
  } catch { /* ignore */ }
}
function toggleSidebar() {
  sidebarVisible.value = !sidebarVisible.value;
  try { localStorage.setItem('admin-sidebar-visible', String(sidebarVisible.value)); } catch { /* ignore */ }
}
onMounted(loadSidebarVisible);

// 2026-08-28 round-52: 5 top-level groups, ops-frequency order, with emoji icons.
// 5 groups (down from R51's 6) — fewer top-level boundaries, easier to scan.
//
// Icon choice: emoji (📊 🛡️ 💻 👥 ⚙️) — no Lucide dep needed, renders natively,
// aligns with the "internal ops tool" aesthetic (per feedback_admin_no_marketing_chrome.md
// "砍 ribbon/eyebrow/装饰"). Icons sit left of the title text, 14px.
//
// Level-3 nesting: AD 复制与端口 contains the 3 R51-flat items as sub-items.
// Sub-items keep their own URLs — operator clicks through to whichever view they
// need, the parent label is just a visual grouping. No URL change.
//
// Item moves from R51:
//   - 操作日志 from AD 管理 → 服务器管理 (operator "归入 服务器管理")
//   - 数据库运维 + 系统设置 merged → 系统运维 (operator consolidation)
//   - 包管理 from AD 管理 → 权限与账号 (closer to users/roles)
const groups = [
  { icon: '📊', title: '监控与诊断', items: [
    // R52: 3-level nesting — parent label has no path, just toggles sub-items.
    { label: 'AD 复制与端口', subItems: [
      // R52: 复制状态概览 + 复制伙伴端口健康监控 + 端口健康检查 grouped
      // under one parent (operator "层级收拢" + "通过页面内 Tab 或筛选器切换视图"
      // — for v1 this is sidebar nesting, in-page tab consolidation deferred).
      { label: '复制状态概览',         path: '/admin/site-replication-matrix/all' },
      { label: '复制伙伴端口健康监控', path: '/admin/replication-log/monitor' },
      { label: '端口健康检查',         path: '/admin/ports' }
    ]},
    { label: '心跳与告警', path: '/admin/heartbeat-report' }
  ]},
  { icon: '🛡️', title: 'AD 目录服务', items: [
    { label: 'AD 站点清单', path: '/admin/sites-catalog' },
    { label: 'AD 域控清单', path: '/admin/dcs-catalog' },
    { label: 'Schema 与清理', path: '/admin/orphan-schemas' }
  ]},
  { icon: '💻', title: '服务器管理', items: [
    // R52: 操作日志 moved here from R51's AD 管理 bucket
    // (operator "归入 服务器管理 或单独作为 审计与日志 模块").
    { label: '非活动目录',       path: '/admin/member-servers' },
    { label: '非活动目录服务器组', path: '/admin/server-groups' },
    { label: '事件与日志',       path: '/admin/operations-log' }
  ]},
  { icon: '👥', title: '权限与账号', items: [
    { label: '用户',     path: '/admin/users' },
    { label: '角色',     path: '/admin/roles' },
    // R52: 包管理 moved here from R51's AD 管理 bucket (closer to users/roles).
    { label: '包管理',   path: '/admin/packages' }
  ]},
  { icon: '⚙️', title: '系统运维', items: [
    // R52: 数据库运维 + 系统设置 merged into 系统运维 umbrella (operator
    // consolidation). 版本升级 is the migration admin page.
    { label: '版本升级', path: '/admin/migrations' },
    { label: '系统配置', path: '/admin/config' },
    { label: '邮件配置', path: '/admin/email-config' },
    { label: '审计日志', path: '/admin/audit' }
  ]}
];
</script>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  height: 100vh;
  transition: grid-template-columns 0.2s ease;
}
/* R52: when sidebar collapsed, grid drops the sidebar column. The toggle button
   in the topbar stays accessible so the operator can re-open. */
.layout.sidebar-collapsed { grid-template-columns: 0 1fr; }
.sidebar {
  background: var(--sidebar-bg);
  padding: 20px 16px 20px 20px;
  overflow: hidden;
  transition: opacity 0.15s ease;
}
.layout.sidebar-collapsed .sidebar {
  opacity: 0;
  pointer-events: none;
  padding: 0;
}
.sidebar .back { display: block; color: var(--muted); font-size: 12px; margin-bottom: 12px; text-decoration: none; }
.sidebar .back:hover { color: var(--accent); }
.sidebar h3 { color: var(--accent); margin: 0 0 16px; font-size: 14px; }
.sidebar nav { display: flex; flex-direction: column; gap: 6px; }
.sidebar a { padding: 8px 10px; border-radius: 4px; color: var(--text); text-decoration: none; }
.sidebar a.router-link-active, .sidebar a:hover { background: var(--border); }
main { display: flex; flex-direction: column; min-width: 0; }
.topbar { display: flex; justify-content: space-between; align-items: center; padding: 10px 20px; background: var(--panel); border-bottom: 1px solid var(--border); gap: 12px; }
.topbar-left { display: flex; align-items: center; gap: 12px; }
.topbar-actions { display: flex; gap: 8px; align-items: center; }
.topbar-actions button, .sidebar-toggle { padding: 6px 14px; border: 1px solid var(--border); border-radius: 3px; cursor: pointer; background: var(--input-bg); color: var(--text); }
.topbar-actions .theme-toggle { font-size: 14px; min-width: 32px; padding: 6px 8px; }
.sidebar-toggle { font-size: 16px; min-width: 32px; padding: 4px 10px; font-family: monospace; }
.content { padding: 20px; overflow: auto; }

/* 2026-08-28 round-52: 5 top-level groups. Three indentation levels:
   Level 1 (group title):    8px  left-padding, weight 700, 13px
   Level 2 (item):          28px  left-padding, weight 400, 13px
   Level 3 (sub-item):      48px  left-padding, weight 400, 12.5px  (slightly muted)
   Diff between levels: 20px and 20px — uniform gap so eye reads the
   hierarchy without computing each step.

   Icons (emoji) sit at level 1 only. Level 2/3 use the chevron ▶/▼ to
   indicate navigability vs disclosure. */
.nav-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nav-group + .nav-group { margin-top: 16px; }
.nav-group-title {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px 4px;
  margin: 0;
  cursor: pointer;
  user-select: none;
  list-style: none;
  letter-spacing: 0.02em;
  color: var(--text);
  font-weight: 700;
  font-size: 13px;
}
.nav-group-title::-webkit-details-marker { display: none; }
.nav-group-title::before {
  content: '▸';
  display: inline-block;
  width: 14px;
  margin-right: 4px;
  transition: transform .15s;
  color: var(--muted);
  font-weight: 400;
  flex-shrink: 0;
}
.nav-group-title .icon {
  font-size: 14px;
  margin-right: 4px;
  flex-shrink: 0;
  /* emoji are color glyphs, not just text — keep the operator's eye on them */
  font-variant-emoji: text;
}
details[open] > .nav-group-title::before { transform: rotate(90deg); }

.nav-link {
  display: block;
  padding: 6px 12px 6px 28px;
  font-size: 13px;
}

/* 2026-08-28 round-52: 3-level nesting for "AD 复制与端口" subgroup.
   The parent label is a <summary> (toggles open/closed), not a router-link.
   Children are router-links at 48px left-padding. */
.nav-subgroup {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 1px 0;
}
.nav-subgroup-title {
  padding: 5px 12px 5px 28px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
  cursor: pointer;
  user-select: none;
  list-style: none;
  letter-spacing: 0.01em;
}
.nav-subgroup-title::-webkit-details-marker { display: none; }
.nav-subgroup-title::before {
  content: '▸';
  display: inline-block;
  width: 10px;
  margin-right: 4px;
  transition: transform .15s;
  color: var(--muted);
  font-weight: 400;
}
details[open] > .nav-subgroup-title::before { transform: rotate(90deg); }
.nav-sublink {
  display: block;
  padding: 5px 12px 5px 48px;
  font-size: 12.5px;
  color: var(--text);
  text-decoration: none;
  border-radius: 3px;
}
.nav-sublink.router-link-active,
.nav-sublink:hover { background: var(--border); }
</style>