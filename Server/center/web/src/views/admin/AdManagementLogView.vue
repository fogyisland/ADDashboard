<template>
  <AdminLayout>
    <header class="head">
      <h2>AD 管理日志</h2>
      <div class="head-right">
        <!-- R158.60.14 (2026-10-09) — operator "执行完成希望马上看到结果".
             时间范围筛选: 10 分钟 / 1 小时 / 全部, 默认 10 分钟.
             server-side /api/admin/audit?from=ISO 过滤, 不拉无关历史. -->
        <nav class="time-range-tabs" data-test="time-range-tabs">
          <button v-for="r in timeRanges" :key="r.key"
                  :class="['time-range-tab', { active: timeRange === r.key }]"
                  :data-test="`time-range-${r.key}`"
                  @click="onTimeRange(r.key)">
            {{ r.label }}
          </button>
        </nav>
        <div class="refresh">
          <span class="refresh-dot">
            <span :class="['dot', polling ? 'on' : 'off']"></span>
            <span>每 {{ refreshSeconds }}s 刷新</span>
          </span>
          <select v-model.number="refreshSeconds">
            <option :value="5">5 秒</option>
            <option :value="10">10 秒</option>
            <option :value="30">30 秒</option>
            <option :value="0">关闭</option>
          </select>
        </div>
      </div>
    </header>

    <p class="hint">
      AD 日常管理 2 块日志 — 顶部 <strong>命令执行结果</strong> 面板跟踪命令生命周期
      (已领取 / 已完成 / 失败 / 超时), 下面 3 个子 tab (用户管理 / 组管理 / OU 与对象操作)
      只看各自的写动作, 互不混合.
    </p>

    <div v-if="error" class="error-banner">{{ error }}</div>

    <section class="block" data-test="ad-mgmt-lifecycle">
      <h3>AD 命令执行结果 <small>(命令认领 / 成功 / 失败 / 超时, 最近 {{ lifecycleRows.length }} 条)</small></h3>
      <table class="t">
        <thead>
          <tr><th>时间</th><th>用户</th><th>动作</th><th>任务 ID</th><th>目标</th><th>结果</th></tr>
        </thead>
        <tbody>
          <tr v-if="!lifecycleRows.length">
            <td colspan="6" class="empty">暂无 AD 命令执行记录</td>
          </tr>
          <tr v-for="r in lifecycleRows" :key="`admlc-${r.id}`"
              :class="['row', `sev-${r.severity}`]"
              data-test="ad-mgmt-lifecycle-row"
              @click="openDrawer(r)">
            <td>{{ fmt(r.createdAt) }}</td>
            <td>{{ r.username ?? (r.userId ?? '-') }}</td>
            <td>{{ r.actionLabel }}</td>
            <td class="task-id">{{ taskIdOf(r) }}</td>
            <td>{{ targetOf(r) }}</td>
            <td>
              <span :class="['cmd-pill', `cmd-${commandResultClass(r.action)}`]">
                {{ commandResultLabel(r.action) }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="block" data-test="ad-mgmt-block">
      <h3>AD 写操作 <small>(当前 tab 最近 {{ rows.length }} 条)</small></h3>
      <nav class="ad-mgmt-tabs">
        <button v-for="t in tabs" :key="t.key"
                :class="['ad-mgmt-tab', { active: active === t.key }]"
                :data-test="`ad-mgmt-tab-${t.key}`"
                @click="onTab(t.key)">
          {{ t.icon }} {{ t.label }} <span class="badge">{{ counts[t.key] ?? 0 }}</span>
        </button>
      </nav>
      <table class="t">
        <thead>
          <tr><th>时间</th><th>用户</th><th>动作</th><th>目标</th><th>严重性</th></tr>
        </thead>
        <tbody>
          <tr v-if="!rows.length">
            <td colspan="5" class="empty">暂无 {{ activeTabLabel }} 写操作记录</td>
          </tr>
          <tr v-for="r in rows" :key="`adm-${r.id}`"
              :class="['row', `sev-${r.severity}`]"
              data-test="ad-mgmt-row"
              @click="openDrawer(r)">
            <td>{{ fmt(r.createdAt) }}</td>
            <td>{{ r.username ?? (r.userId ?? '-') }}</td>
            <td>{{ r.actionLabel }}</td>
            <td>{{ targetOf(r) }}</td>
            <td><span :class="['sev-chip', `sev-chip-${r.severity}`]">{{ sevIcon(r.severity) }} {{ sevLabel(r.severity) }}</span></td>
          </tr>
        </tbody>
      </table>
    </section>

    <aside v-if="selected" class="drawer" @click.self="selected = null">
      <div class="drawer-body">
        <header>
          <h3>{{ selected.actionLabel }} <small>#{{ selected.id }}</small></h3>
          <button class="close" @click="selected = null">×</button>
        </header>
        <p><b>{{ selected.username ?? selected.userId ?? '-' }}</b> · {{ fmt(selected.createdAt) }}</p>
        <h4>payload</h4>
        <PayloadTree v-if="selected.payload" :value="selected.payload" />
        <p v-else class="muted">无 payload</p>
      </div>
    </aside>
  </AdminLayout>
</template>

<script setup>
// R158.46 (2026-10-06) — operator "AD 管理日志其实需要加入到 Sidebar 中".
//   拆出 OperationsLogView 内的 ad-mgmt-block, 独立成 AdManagementLogView,
//   /admin/ad-management-log 路由. 数据从 audit_logs 表的 ad_management
//   category 拉, 3 子 tab 客户端切分 + ad_command lifecycle 横跨显示.

import { ref, computed, onMounted, onBeforeUnmount, watch, h } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { adminApi } from '../../api/admin.js';
import { notifyError } from '../../lib/notify.js';

const USER_ACTIONS = Object.freeze([
  'ad_user_search', 'ad_user_create', 'ad_user_password_reset',
  'ad_user_enable', 'ad_user_disable', 'ad_user_unlock',
  'ad_user_set_attributes', 'ad_user_set_manager',
  'ad_user_delete', 'ad_user_list_groups',
  'ad_account_quickfix'
]);
const GROUP_ACTIONS = Object.freeze([
  'ad_group_search', 'ad_group_create', 'ad_group_set_attributes',
  'ad_group_add_member', 'ad_group_remove_member',
  'ad_group_set_members', 'ad_group_delete', 'ad_group_list_members'
]);
const OBJECT_ACTIONS = Object.freeze([
  'ad_ou_create', 'ad_object_move', 'ad_object_delete'
]);
const LIFECYCLE_ACTIONS = Object.freeze([
  'ad_command_claimed', 'ad_command_succeeded', 'ad_command_failed', 'ad_command_timeout'
]);
const ALL_ACTIONS = Object.freeze([
  ...USER_ACTIONS, ...GROUP_ACTIONS, ...OBJECT_ACTIONS, ...LIFECYCLE_ACTIONS
]);
// R158.46b 修正 — 3 tab 各自只看写动作 (USER_ACTIONS / GROUP_ACTIONS /
// OBJECT_ACTIONS), lifecycle (ad_command_*) 单独走顶部独立 panel.
// 之前 design "lifecycle 横跨 3 tab" 让 operator 误以为 3 tab 内容重复,
// 实际是 lifecycle 挤占空间让写动作看不见.
const TAB_ACTIONS = Object.freeze({
  users:     [...USER_ACTIONS],
  groups:    [...GROUP_ACTIONS],
  ou_object: [...OBJECT_ACTIONS]
});

const tabs = [
  { key: 'users',     icon: '👤', label: '用户管理' },
  { key: 'groups',    icon: '👥', label: '组管理' },
  { key: 'ou_object', icon: '🏢', label: 'OU 与对象操作' }
];

const active = ref('users');
const rows = ref([]);
const lifecycleRows = ref([]);
const counts = ref({ users: 0, groups: 0, ou_object: 0 });
const totalCount = computed(() =>
  (counts.value.users || 0) + (counts.value.groups || 0) + (counts.value.ou_object || 0)
);
const activeTabLabel = computed(() => tabs.find(t => t.key === active.value)?.label || '');

// R158.60.14 (2026-10-09) — 时间范围筛选. minutes=null 表示不传 from,
// 让 /api/admin/audit 走全量 (size=100 cap 之内).
// 默认 10 分钟 — operator "执行完成希望马上看到结果", 10 分钟内基本覆盖
// 当前 poll 窗口的 5/10/30s 节奏, 屏幕上一眼看完.
const timeRanges = [
  { key: '10m', label: '最近 10 分钟', minutes: 10 },
  { key: '1h',  label: '最近 1 小时',  minutes: 60 },
  { key: 'all', label: '全部',         minutes: null }
];
const timeRange = ref('10m');
function fromIsoForTimeRange() {
  const cfg = timeRanges.find(r => r.key === timeRange.value);
  if (!cfg || cfg.minutes == null) return null;
  return new Date(Date.now() - cfg.minutes * 60 * 1000).toISOString();
}

const refreshSeconds = ref(10);
const polling = ref(false);
const error = ref('');
const selected = ref(null);

const pageSize = 30;
// 服务端 /api/admin/audit size cap 是 100, 我们一次拉满 100 然后 client-side
// 切 3 tab (each tab cap pageSize). 100 够覆盖 operator 近期 3 类操作的密度.
const fetchSize = 100;
let timer = null;

function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '—'; }
function sevIcon(s)  { return s === 'high' ? '🔴' : s === 'medium' ? '🟡' : '🔵'; }
function sevLabel(s) { return s === 'high' ? '高' : s === 'medium' ? '中' : '低'; }

function isCommandLifecycle(action) { return LIFECYCLE_ACTIONS.includes(action); }
function commandResultClass(action) {
  if (action === 'ad_command_succeeded') return 'ok';
  if (action === 'ad_command_claimed')   return 'pending';
  if (action === 'ad_command_failed')    return 'fail';
  if (action === 'ad_command_timeout')   return 'timeout';
  return 'unknown';
}
function commandResultLabel(action) {
  if (action === 'ad_command_succeeded') return '✓ 成功';
  if (action === 'ad_command_claimed')   return '⏳ 执行中';
  if (action === 'ad_command_failed')    return '✗ 失败';
  if (action === 'ad_command_timeout')   return '⏱ 超时';
  return action;
}
// 「目标」列抽 payload 里更精确的上下文, 比默认 auditLogs 多显示一层
function targetOf(r) {
  const p = r.payload || {};
  return p.sam || p.name || p.targetDc || p.targetDn || p.newParentDn || r.target || '-';
}
// 「任务 ID」列 — 优先读 payload.taskId (R158.46b 中心入队时刻生成,
// 格式 "<DC>-<UTC YYYYMMDDHHMMSSmmm>", 例如 "KDLOFADSRV1-20261006142305123").
// fallback (R158.46b 前旧数据, 或 timeout 老行没 audit emit path):
//   显式标记 "任务 #N (历史)", 不再拼 padStart 假 ID. padStart 形式
//   (e.g. KDLOFADSRV1-000003) 会让操作员误以为有第二种 task_id 生成器,
//   实际这些 audit row 是 R158.46b (2026-10-06) 之前入队的 command,
//   queue 时刻没生成 task_id, sweepTimeouts 补 audit 时 payload.taskId=null.
//   R158.46.4 boot-time backfill 已把 ad_admin_commands.task_id NULL 老行
//   补完, 但 audit_logs 老 row 已固化, 显示形式跟历史 log 对齐.
function taskIdOf(r) {
  const p = r.payload || {};
  if (typeof p.taskId === 'string' && p.taskId.length > 0) return p.taskId;
  // R158.46.4 — fallback 不再拼 padStart 假 ID, 显式标 "历史" 让操作员一眼看出
  // 这条是 R158.46b 之前的老数据, 没真实 taskId. R158.46.4 boot-time backfill
  // 已迁的 task_id 仍会是 taskId 字符串 (上面 if 分支返回), 不会走到 fallback.
  const id = Number(p.commandId);
  if (!Number.isInteger(id) || id <= 0) return '-';
  return `任务 #${id} (历史)`;
}

async function load() {
  if (polling.value) return;
  polling.value = true;
  try {
    // R158.60.14 — server-side from 过滤, 减少不相关行占用 100 cap 配额.
    const from = fromIsoForTimeRange();
    const { data } = await adminApi.getAudit({
      category: 'ad_management',
      action: ALL_ACTIONS.join(','),
      page: 1,
      size: fetchSize,
      from
    });
    const all = data.rows || [];
    const byTab = { users: [], groups: [], ou_object: [] };
    const lifecycle = [];
    for (const r of all) {
      // 写动作只归各自 tab, 不再横跨
      if (USER_ACTIONS.includes(r.action))   byTab.users.push(r);
      else if (GROUP_ACTIONS.includes(r.action))  byTab.groups.push(r);
      else if (OBJECT_ACTIONS.includes(r.action)) byTab.ou_object.push(r);
      // lifecycle 走顶部独立 panel
      if (LIFECYCLE_ACTIONS.includes(r.action)) lifecycle.push(r);
    }
    rows.value = byTab[active.value].slice(0, pageSize);
    lifecycleRows.value = lifecycle.slice(0, pageSize);
    counts.value = {
      users:     byTab.users.length,
      groups:    byTab.groups.length,
      ou_object: byTab.ou_object.length
    };
    error.value = '';
  } catch (e) {
    error.value = e?.message || '加载失败';
    notifyError(`AD 管理日志加载失败: ${e?.message || '未知错误'}`);
  } finally {
    polling.value = false;
  }
}
function onTab(key) {
  active.value = key;
  load();
}
// R158.60.14 — 切时间范围立刻重新拉, 跟 onTab 一致模式
function onTimeRange(key) {
  if (timeRange.value === key) return;
  timeRange.value = key;
  load();
}
function startTimer() {
  stopTimer();
  if (refreshSeconds.value > 0) timer = setInterval(load, refreshSeconds.value * 1000);
}
function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

function openDrawer(r) { selected.value = r; }

// Inline PayloadTree (跟 OperationsLogView / AuditView 同样 UX)
const PayloadTree = {
  props: ['value'],
  setup(props) {
    return () => renderNode(props.value, 0);
  }
};
function renderNode(value, depth) {
  if (value == null) return h('span', { class: 'json-null' }, 'null');
  if (typeof value === 'object') {
    const entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
    return h('ul', { class: 'json-tree', style: `padding-left:${depth * 12}px` },
      entries.map(([k, v]) => h('li', {}, [
        h('span', { class: 'json-key' }, String(k) + ': '),
        renderNode(v, depth + 1)
      ])));
  }
  return h('span', { class: `json-${typeof value}` }, JSON.stringify(value));
}

onMounted(async () => {
  try { await load(); } catch {}
  finally { startTimer(); }
});
onBeforeUnmount(stopTimer);
watch(refreshSeconds, startTimer);
</script>

<style scoped>
.head { display: flex; justify-content: space-between; align-items: center; }
.head-right { display: flex; gap: 16px; align-items: center; }
/* R158.60.14 (2026-10-09) — 时间范围 tab (10m / 1h / all), 跟
   ad-mgmt-tabs 同样 segmented control 风格, active = accent. */
.time-range-tabs { display: flex; gap: 0; border: 1px solid var(--border); border-radius: 3px; overflow: hidden; background: var(--panel); }
.time-range-tab {
  padding: 4px 10px;
  background: var(--panel);
  color: var(--text);
  border: none;
  border-right: 1px solid var(--border);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease;
}
.time-range-tab:last-child { border-right: none; }
.time-range-tab:hover { background: var(--border); }
.time-range-tab.active { background: var(--accent, #3b82f6); color: #fff; }
.time-range-tab.active:hover { background: var(--accent, #3b82f6); filter: brightness(1.12); }

.refresh { display: flex; gap: 12px; align-items: center; color: var(--muted); font-size: 13px; }
.refresh select { background: var(--sidebar-bg); color: var(--text); border: 1px solid var(--border); padding: 4px 8px; border-radius: 3px; }
.refresh-dot { display: flex; gap: 6px; align-items: center; }
.hint { color: var(--muted); font-size: 12px; margin: 4px 0 16px; }
.hint code { background: var(--sidebar-bg); padding: 1px 4px; border-radius: 3px; font-size: 11px; }
.error-banner { background: var(--danger-bg); color: var(--severity-critical-text); padding: 10px 14px; margin-bottom: 12px; border-radius: 4px; border: 1px solid var(--status-pill-fg-err); font-size: 13px; }

.block { padding: 16px; border: 1px solid var(--border); border-radius: 4px; background: var(--panel); }
.block h3 { margin: 0 0 12px; font-size: 15px; color: var(--text); }
.block h3 small { color: var(--muted); font-size: 12px; margin-left: 6px; font-weight: 400; }

.ad-mgmt-tabs { display: flex; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid var(--border); }
.ad-mgmt-tab {
  background: transparent; color: var(--muted); border: none;
  padding: 8px 14px; font-size: 13px; cursor: pointer;
  border-bottom: 2px solid transparent;
}
.ad-mgmt-tab:hover { color: var(--text); }
.ad-mgmt-tab.active { color: var(--text); border-bottom-color: var(--accent); }
.ad-mgmt-tab .badge {
  margin-left: 6px; padding: 1px 6px; background: var(--sidebar-bg);
  border-radius: 8px; font-size: 11px; color: var(--muted);
}

.t { width: 100%; border-collapse: collapse; background: var(--panel); }
.t th, .t td { padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13px; }
.t th { background: var(--sidebar-bg); color: var(--muted); font-size: 12px; font-weight: 600; }
.row { border-left: 3px solid transparent; }
.row:hover { background: var(--border); }
.row.sev-high   { border-left-color: var(--danger-bg); }
.row.sev-medium { border-left-color: var(--status-pill-fg-warn); }
.row.sev-low    { border-left-color: var(--info-bg); }

.sev-chip { padding: 2px 6px; border-radius: 3px; font-size: 11px; }
.sev-chip-high   { background: var(--danger-bg); color: var(--severity-critical-text); }
.sev-chip-medium { background: var(--warning-bg); color: var(--gold-border); }
.sev-chip-low    { background: var(--info-bg); color: var(--severity-info-text); }

.cmd-pill { padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 500; }
.cmd-pill.ok      { background: var(--status-pill-bg-ok);  color: var(--severity-ok-text); }
.cmd-pill.pending { background: var(--info-bg);           color: var(--severity-info-text); }
.cmd-pill.fail    { background: var(--danger-bg);         color: var(--severity-critical-text); }
.cmd-pill.timeout { background: var(--warning-bg);        color: var(--gold-border); }
.cmd-pill.unknown { background: var(--sidebar-bg);        color: var(--muted); }

/* R158.46b — 任务 ID 列 (lifecycle panel 专用), 等宽字体 + 高对比,
   让 operator 一眼扫到 "哪台 DC 第几个任务". */
.task-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  letter-spacing: 0.3px;
  color: var(--accent);
  white-space: nowrap;
}

.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
.dot.on  { background: var(--green); }
.dot.off { background: var(--muted); }
.empty { text-align: center; color: var(--muted); padding: 18px; }

.drawer { position: fixed; inset: 0 0 0 auto; width: 40%; min-width: 320px; background: var(--panel); border-left: 1px solid var(--border); padding: 20px; overflow: auto; z-index: 10; }
.drawer-body header { display: flex; justify-content: space-between; align-items: center; }
.drawer-body h3 small { color: var(--muted); font-size: 12px; margin-left: 6px; }
.drawer-body .close { background: transparent; color: var(--text); border: none; font-size: 24px; cursor: pointer; }
.json-tree { list-style: none; padding-left: 12px; }
.json-key { color: var(--accent); }
.json-string { color: var(--severity-ok-text); }
.json-number { color: var(--hub-gold); }
.json-boolean { color: var(--chip-purple-fg); }
.json-null { color: var(--muted); font-style: italic; }
.muted { color: var(--muted); }
</style>