<!--
  DashboardView.vue — R148 概览页.

  顶部保留 R119 StatusBar 6-tile (复制健康率 / 复制链路 / 警告 / 错误 / Agent 数 /
  最后更新). 主区域是 4 个 OverviewPanel 卡片, 分别聚合 OS Baseline / 事件日志 /
  锁定账户 / 复制错误 4 个面板的 2-3 个分层数字. 每 30s 自动刷新 (沿用 StatusBar
  的轮询节奏).

  数据源: GET /api/dashboard/summary — 单端点 server-side fan-out (4 个面板快照
  一致性 < 500ms).
-->
<template>
  <AppLayout>
    <h2>总览</h2>
    <StatusBar />

    <div v-if="error" class="error-banner">概览数据加载失败: {{ error }}</div>

    <section v-if="summary" class="overview-grid">
      <OverviewPanel
        title="OS 基线"
        :metrics="osBaseline"
        :metric-keys="['critical', 'warning', 'normal', 'offline']"
        :labels="{ critical: '严重', warning: '偏高', normal: '正常', offline: '离线' }"
        :severity="{ critical: ['critical'], warning: ['warning'], normal: ['normal', 'offline'] }"
        link-to="/os-baseline" />
      <OverviewPanel
        title="事件日志"
        :metrics="eventlog"
        :metric-keys="['errorEvents', 'warningEvents', 'errorDcs']"
        :labels="{ errorEvents: '24h 错误数', warningEvents: '24h 警告数', errorDcs: '有错 DC 数' }"
        :severity="{ critical: ['errorEvents', 'errorDcs'], warning: ['warningEvents'], normal: [] }"
        link-to="/eventlog" />
      <OverviewPanel
        title="锁定账户"
        :metrics="lockout"
        :metric-keys="['total24h', 'dcsWithLocks']"
        :labels="{ total24h: '24h 锁定数', dcsWithLocks: '涉及 DC 数' }"
        :severity="{ critical: ['total24h'], warning: ['dcsWithLocks'], normal: [] }"
        link-to="/lockout-accounts" />
      <OverviewPanel
        title="复制错误"
        :metrics="replication"
        :metric-keys="['errorLinks', 'warningLinks']"
        :labels="{ errorLinks: '24h 错误链路', warningLinks: '24h 警告链路' }"
        :severity="{ critical: ['errorLinks'], warning: ['warningLinks'], normal: [] }"
        link-to="/errors" />
      <!-- R158.47 (2026-10-06) — 管理员成员 panel. 3 numbers: Domain
           Admins / Enterprise Admins / 去重成员 (cross-group distinct
           sam count). Backs onto the ad_admin_members agent package
           (daily cadence, 24h). 跟 ad_dc_overview 同样的 R110.A 公共表
           pattern (no pkg_ prefix, manifest omits database block, runner
           post-hook writes via MERGE dedup). 不设 link-to: 操作员只
           指示"放在概览中"显示 3 个数字, 暂无 detail page. 后续 R158.47+
           加成员详情页时再补 link-to. -->
      <OverviewPanel
        title="管理员成员"
        :metrics="admins"
        :metric-keys="['domainAdmins', 'enterpriseAdmins', 'totalMembers']"
        :labels="{ domainAdmins: 'Domain Admins', enterpriseAdmins: 'Enterprise Admins', totalMembers: '去重成员' }"
        :severity="{ critical: ['domainAdmins', 'enterpriseAdmins'], warning: ['totalMembers'], normal: [] }" />
    </section>

    <!-- R158.7: per-DC 子图 grid (operator directive "HUB 站点有几台机器
         就显示几张图";UTC 时间 → CST +8 偏移). Fleet-level series 仍
         存在 (/api/dashboard/hub-resources.series) 但前端不再渲染 — 见
         renderHubCharts(). -->
    <section class="hub-section">
      <header class="hub-header">
        <h3>核心站点资源占用（最近 {{ hubResources?.hours ?? 6 }} 小时）</h3>
        <div v-if="hubResources" class="hub-meta muted">
          {{ hubResources.dcCount }} 台机器 ·
          {{ hubResources.sampleCount }} 个采样 ·
          站点: {{ hubSitesText }}
        </div>
      </header>
      <div v-if="hubDcList.length > 0" class="hub-charts-grid">
        <div
          v-for="(dcName, idx) in hubDcList"
          :key="dcName"
          :class="['hub-chart-cell', { wide: hubDcList.length === 1 }]"
          :data-dc="dcName"
          :data-test="`hub-chart-${dcName}`"
        >
          <div class="dc-title">{{ dcName }} <span class="muted">· {{ hubDcShortName(dcName) }}</span></div>
          <div class="hub-chart"></div>
        </div>
      </div>
      <div v-else-if="hubResources" class="hub-empty muted">核心站点最近 {{ hubResources.hours }} 小时暂无数据</div>
      <div v-else class="hub-empty muted">加载中…</div>
    </section>

    <section class="problem-section">
      <header class="problem-header">
        <h3>当前 OS 基线偏高机器</h3>
        <div class="muted">核心站点 · 综合合规 critical / warning · 按严重度排序</div>
      </header>
      <table v-if="problemItems.length > 0" class="problem-table">
        <thead>
          <tr>
            <th>机器</th>
            <th>站点</th>
            <th>状态</th>
            <th>CPU</th>
            <th>内存</th>
            <th>最差盘</th>
            <th>C 盘</th>
            <th>触发</th>
            <th>最近上报</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in problemItems" :key="row.agentId" :class="`row-${row.status}`">
            <td class="agent">{{ row.agentId }}</td>
            <td>{{ row.siteName || '—' }}</td>
            <td>
              <span class="badge" :class="`badge-${row.status}`">{{ row.status === 'critical' ? '严重' : '偏高' }}</span>
            </td>
            <td :class="pctClass(row.cpuPct, 80, 95)">{{ formatPct(row.cpuPct) }}</td>
            <td :class="pctClass(row.memPct, 80, 95)">{{ formatPct(row.memPct) }}</td>
            <td :class="pctClass(row.diskUsedPct, 50, 80)">{{ formatPct(row.diskUsedPct) }}</td>
            <td :class="pctClass(row.cUsedPct, 50, 80)">{{ formatPct(row.cUsedPct) }}</td>
            <td class="drivers">
              <span v-for="d in row.drivers" :key="d" class="driver-chip">{{ driverLabel(d) }}</span>
            </td>
            <td class="muted">{{ formatTime(row.ts) }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="muted problem-empty">核心站点当前无偏高机器。</div>
    </section>

    <!-- R158.69.10 (2026-10-11) — 管理员成员 drill-down table.
         复用已 ship OverviewPanel (line 48-61) 显示 3 数字, 不动之.
         新增 drill-down section, 默认收起; 点 "展开" 后才拉数据 (避免
         一上来就 N+1 query). 读 /api/dashboard/admin-members (新端点,
         不动 summary). -->
    <section class="admin-drilldown">
      <header class="drill-header">
        <h3>管理员成员列表</h3>
        <button class="drill-toggle" @click="toggleAdminDrill">
          {{ adminDrillOpen ? '收起' : '展开' }}
        </button>
      </header>
      <div v-show="adminDrillOpen" class="drill-body">
        <div v-for="grp in drillGroups" :key="grp" class="drill-group">
          <h4>{{ grp }}</h4>
          <AdminMembersTable
            :group-name="grp"
            :members="adminMembersByGroup[grp]"
            :loading="adminMembersLoading[grp]" />
        </div>
      </div>
    </section>

    <!-- R158.72 (2026-10-11) — AD 账户变更趋势 (近 30 天) ECharts 折线图.
         不动已 ship sections (line 48-61 admin-members panel + 138-154
         admin-drilldown). 新建 section, 读 /api/dashboard/account-change-trend
         (新端点, 不动 summary). 5 series (created/modified/deleted/enabled/
         disabled) × 30 day bucket, 跟 FailedLogonView 同 pivot pattern. -->
    <section class="account-changes-section">
      <header class="acct-header">
        <h3>账户变更趋势（近 30 天）</h3>
        <div class="muted acct-subtitle">创建 / 修改 / 删除 / 启用 / 禁用 · 按天聚合</div>
      </header>
      <div v-if="loadingAcct && !acctHasChartedOnce" class="skeleton skeleton-chart"></div>
      <div v-else-if="acctError" class="error-banner">
        <span>加载图表失败</span>
        <button @click="loadAccountChanges">重试</button>
      </div>
      <div v-else-if="!acctHasData && !acctHasChartedOnce" class="muted acct-empty">近 30 天暂无账户变更事件</div>
      <div v-else ref="acctChartEl" class="chart-canvas" data-test="account-changes-chart"></div>
    </section>

    <p v-if="lockoutLast" class="lockout-last">
      <strong>最近锁定:</strong>
      {{ formatTime(lockoutLast.occurredAt) }} ·
      {{ lockoutLast.dcName }} ·
      {{ lockoutLast.targetUserName }}
      <span v-if="lockoutLast.targetUserDisplayName" class="muted">
        ({{ lockoutLast.targetUserDisplayName }})
      </span>
    </p>

    <p class="overview-footer muted">
      刷新于 {{ summary ? formatTime(summary.ts) : '—' }} ·
      每 30s 自动刷新 ·
      <span v-if="degradedText">降级面板: {{ degradedText }}</span>
    </p>
  </AppLayout>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import * as echarts from 'echarts';
import AppLayout from '../components/AppLayout.vue';
import StatusBar from '../components/StatusBar.vue';
import OverviewPanel from '../components/OverviewPanel.vue';
import AdminMembersTable from '../components/AdminMembersTable.vue';
import api from '../api/client.js';
import { dashboardApi } from '../api/dashboard.js';

const EMPTY_OS_BASELINE = { total: 0, critical: 0, warning: 0, normal: 0, offline: 0 };
const EMPTY_EVENTLOG    = { errorEvents: 0, warningEvents: 0, errorDcs: 0 };
const EMPTY_LOCKOUT     = { total24h: 0, dcsWithLocks: 0, lastEvent: null };
const EMPTY_REPLICATION = { errorLinks: 0, warningLinks: 0, windowHours: 24 };
// R158.47 (2026-10-06) — 管理员成员 panel empty. 3 numbers: Domain
// Admins / Enterprise Admins / 去重成员. Backs onto ad_admin_members
// agent package (daily, 24h).
const EMPTY_ADMINS      = { domainAdmins: 0, enterpriseAdmins: 0, totalMembers: 0 };

const summary = ref(null);
const hubResources = ref(null);
const problemItems = ref([]);
const error = ref(null);
let timer = null;
// R158.scanfix-B4 (2026-10-20) — 账户变更 5min 轮询句柄.
//
// 旧代码把这个句柄存在 window.__acctTimer 上 (模块内 `let acctTimer`
// 在 onMounted 里声明, 出了 onMounted 作用域就不可达, 只好挂 window).
// 那是全局单例: 路由快速切换 / 组件重复挂载时, 新实例的 onMounted 会覆盖
// window.__acctTimer, 旧实例的 onBeforeUnmount 清掉的是**新**实例的句柄,
// 旧句柄永久泄漏 —— 继续 5min 一次 fire, 写已销毁组件的上下文.
//
// 改成与 timer 并列的模块级闭包变量: 每个组件实例各自持有一份句柄,
// 生命周期内不共享, onBeforeUnmount 清自己那份, 不会串扰.
// window 上也不再有 __acctTimer 残留.
let acctTimer = null;
// R158.7 — per-DC ECharts instances. Key = agent_id (= dc_name).
// Replaces the previous single-instance `hubChart`. New DC on next
// 30s poll → init; vanished DC → dispose + delete.
const hubCharts = new Map();

const osBaseline  = computed(() => summary.value?.osBaseline  || EMPTY_OS_BASELINE);
const eventlog    = computed(() => summary.value?.eventlog    || EMPTY_EVENTLOG);
const lockout     = computed(() => summary.value?.lockout     || EMPTY_LOCKOUT);
const replication = computed(() => summary.value?.replication || EMPTY_REPLICATION);
// R158.47 (2026-10-06) — 管理员成员 panel computed (data from
// ad_admin_members agent package, daily cadence).
const lockoutLast = computed(() => lockout.value.lastEvent || null);
const admins      = computed(() => summary.value?.admins      || EMPTY_ADMINS);
const degradedText = computed(() => (summary.value?.degraded || []).join(', '));

// R158.69.10 (2026-10-11) — admin members drill-down state.
//   默认收起,点 "展开" 才拉数据. 缓存拉过的 group, 再次展开不重拉.
const drillGroups = ['Domain Admins', 'Enterprise Admins'];
const adminDrillOpen = ref(false);
const adminMembersByGroup = ref({ 'Domain Admins': [], 'Enterprise Admins': [] });
const adminMembersLoading = ref({ 'Domain Admins': false, 'Enterprise Admins': false });

async function loadAdminMembers(group, { force = false } = {}) {
  if (!force && adminMembersByGroup.value[group].length > 0) return;
  adminMembersLoading.value = { ...adminMembersLoading.value, [group]: true };
  try {
    const r = await dashboardApi.getAdminMembersByGroup({ group });
    adminMembersByGroup.value = { ...adminMembersByGroup.value, [group]: r.data.rows || [] };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('admin members load failed', group, e);
    adminMembersByGroup.value = { ...adminMembersByGroup.value, [group]: [] };
  } finally {
    adminMembersLoading.value = { ...adminMembersLoading.value, [group]: false };
  }
}

async function loadAllAdminMembers({ force = false } = {}) {
  await Promise.all(drillGroups.map(g => loadAdminMembers(g, { force })));
}

function toggleAdminDrill() {
  adminDrillOpen.value = !adminDrillOpen.value;
  if (adminDrillOpen.value) {
    // 展开时拉 (cached 不再拉)
    loadAllAdminMembers({ force: false }).catch(() => {});
  }
}

watch(adminDrillOpen, (open) => {
  if (open) loadAllAdminMembers({ force: false }).catch(() => {});
});

// R158.72 (2026-10-11) — AD 账户变更趋势 (近 30 天) ECharts state. 独立
//   5min cadence (不跟 summary 30s 一起 — 趋势数据不需要 30s 粒度刷新),
//   跟 R150 hub-resources 同 per-section 独立节奏.
const acctChartEl = ref(null);
let acctChartInstance = null;
const acctBuckets = ref([]);
const acctWindowDays = ref(30);
const loadingAcct = ref(false);
const acctError = ref(false);
const acctHasChartedOnce = ref(false);
const acctHasData = computed(() => Array.isArray(acctBuckets.value) && acctBuckets.value.length > 0);

async function loadAccountChanges() {
  loadingAcct.value = true;
  acctError.value = false;
  try {
    const r = await dashboardApi.getAccountChangeTrend({ days: acctWindowDays.value });
    acctBuckets.value = Array.isArray(r.data?.rows) ? r.data.rows : [];
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('account-change trend load failed', e);
    acctError.value = true;
    acctBuckets.value = [];
  } finally {
    loadingAcct.value = false;
    await nextTick();
    renderAccountChangesChart();
  }
}

function renderAccountChangesChart() {
  if (!acctChartEl.value) return;
  if (!acctHasData.value) return;
  if (acctChartInstance && acctChartInstance.getDom() !== acctChartEl.value) {
    acctChartInstance.dispose();
    acctChartInstance = null;
  }
  if (!acctChartInstance) {
    acctChartInstance = echarts.init(acctChartEl.value, null, { renderer: 'canvas' });
    window.addEventListener('resize', acctOnResize);
  }
  const days = acctWindowDays.value;
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const xs = [];
  for (let i = days - 1; i >= 0; i--) {
    xs.push(new Date(end.getTime() - i * 86_400_000));
  }
  const byType = new Map();
  for (const r of acctBuckets.value) {
    const a = r.action;
    if (!byType.has(a)) byType.set(a, new Map());
    // bucket_day 来自 adAccountChange.trendByDay SELECT change_date AS bucket_day
    const bucketKey = new Date(r.bucket_day || r.change_date).getTime();
    byType.get(a).set(bucketKey, Number(r.event_count) || 0);
  }
  const actionNames = ['created', 'modified', 'deleted', 'enabled', 'disabled'];
  const acctColors = ['#22c55e', '#3b82f6', '#f59e0b', '#10b981', '#ef4444'];
  const acctLabels = ['创建', '修改', '删除', '启用', '禁用'];
  const hexToRgba = (hex, a) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a})`;
  };
  const series = actionNames.map((name, i) => {
    const m = byType.get(name) || new Map();
    const ys = xs.map(d => m.get(d.getTime()) ?? 0);
    const color = acctColors[i % acctColors.length];
    return {
      name: acctLabels[i],
      type: 'line',
      data: ys,
      smooth: true,
      symbol: 'circle',
      symbolSize: 4,
      lineStyle: { color, width: 2 },
      itemStyle: { color },
      areaStyle: {
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: hexToRgba(color, 0.30) },
            { offset: 1, color: hexToRgba(color, 0.02) }
          ]
        }
      }
    };
  });
  acctChartInstance.setOption({
    grid: { left: 50, right: 16, top: 40, bottom: 32 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'line' } },
    legend: {
      type: 'scroll',
      top: 4,
      textStyle: { color: 'var(--muted)', fontSize: 11 },
      pageIconColor: 'var(--muted)',
      pageTextStyle: { color: 'var(--muted)' }
    },
    xAxis: {
      type: 'category',
      data: xs.map(d => `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`),
      axisLabel: { color: 'var(--muted)', fontSize: 10 },
      axisLine: { lineStyle: { color: 'var(--border)' } }
    },
    yAxis: {
      type: 'value',
      name: '变更次数',
      nameTextStyle: { color: 'var(--muted)', fontSize: 11 },
      axisLabel: { color: 'var(--muted)', fontSize: 11 },
      splitLine: { lineStyle: { color: 'var(--border)', type: 'dashed' } },
      minInterval: 1
    },
    series
  }, true);
  acctHasChartedOnce.value = true;
}
const acctOnResize = () => {
  if (acctChartInstance) acctChartInstance.resize();
};
const hubSitesText = computed(() => {
  const sites = hubResources.value?.sites || [];
  if (sites.length === 0) return '—';
  return sites.map(s => `${s.siteName}(${s.dcCount})`).join(', ');
});
// R158.7 — DC list for v-for in the per-DC sub-chart grid. Sorted so
// the layout is stable across polls (FLO1 stays left of FLO2).
const hubDcList = computed(() => {
  const byDc = hubResources.value?.seriesByDc || {};
  return Object.keys(byDc).sort();
});
// R158.7 — strip "KDLFLOFADSrv1" → "FLO1" / "FLO2" etc. for a more
// readable chart title. Falls back to the full hostname if no known
// site-prefix matches. Operator likely reads FLO1/FLO2 instead of the
// AD canonical hostname.
function hubDcShortName(dcName) {
  if (!dcName) return '';
  const m = /^KD([A-Z]+)OFADSRV(\d+)$/.exec(dcName.toUpperCase());
  if (m) {
    const region = m[1]; // FLO / WX / CQ / etc.
    const idx = m[2];
    // Region: FLO → 枫林 (FengLin), WX → 无锡 (WuXi), CQ → 重庆 (ChongQing)
    const regionMap = { FLO: 'FLO', WX: 'WX', CQ: 'CQ' };
    const abbr = regionMap[region] || region;
    return `${abbr}${idx}`;
  }
  return dcName;
}

function formatTime(s) {
  if (!s) return '—';
  try { return new Date(s).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }); }
  catch { return s; }
}
// R158.7 — CST timestamp formatter (operator directive "x时间为UTC时
// 间，要转成北京时间"). Metric `ts` is an ISO UTC string; we add an
// explicit +8 hour offset rather than relying on `toLocaleString`
// timezone so the result is deterministic regardless of the browser's
// TZ (or the centre host's TZ — the centre is UTC). Returns hh:mm in
// 24-hour CST.
const fmtTs = (t) => {
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return '';
  const cstH = (d.getUTCHours() + 8) % 24;
  const cstM = d.getUTCMinutes();
  return `${String(cstH).padStart(2, '0')}:${String(cstM).padStart(2, '0')}`;
};
function formatPct(v) {
  if (v === null || v === undefined) return '—';
  return `${v.toFixed(1)}%`;
}
function pctClass(v, warn, crit) {
  if (v === null || v === undefined) return '';
  if (v >= crit) return 'cell-critical';
  if (v >= warn)  return 'cell-warning';
  return '';
}
function driverLabel(d) {
  return { cpu: 'CPU', mem: '内存', disk: '磁盘', c: 'C 盘' }[d] || d;
}

async function loadSummary() {
  try {
    const r = await api.get('/api/dashboard/summary');
    summary.value = r.data || null;
    error.value = null;
  } catch (e) {
    error.value = e?.message || 'unknown';
  }
}
async function loadHub() {
  try {
    const r = await api.get('/api/dashboard/hub-resources?hours=6');
    hubResources.value = r.data || null;
    await nextTick();
    renderHubCharts();
  } catch (e) {
    hubResources.value = null;
  }
}
async function loadProblems() {
  try {
    const r = await api.get('/api/dashboard/problem-agents');
    problemItems.value = r.data?.items || [];
  } catch (e) {
    problemItems.value = [];
  }
}

function renderHubCharts() {
  const data = hubResources.value;
  const byDc = data?.seriesByDc || {};
  const dcNames = Object.keys(byDc).sort();

  // Remove instances for DCs that disappeared since last poll (and any
  // stale instance from a previous hub-DC layout). dispose() detaches
  // the canvas + unregisters event listeners.
  for (const [name, inst] of hubCharts) {
    if (!byDc[name]) { inst.dispose(); hubCharts.delete(name); }
  }

  for (const dcName of dcNames) {
    const series = byDc[dcName];
    const isEmpty = !series.cpu.length && !series.memory.length && !series.disk.length && !series.cUsed.length;
    if (isEmpty) continue;
    // Locate the chart container for this DC by data-dc attribute. We
    // intentionally don't use Vue refs per-DC because the chart count
    // is dynamic — querySelector lets us bind by data attribute.
    const cellEl = document.querySelector(`[data-dc="${dcName}"] .hub-chart`);
    if (!cellEl) continue;
    let inst = hubCharts.get(dcName);
    if (!inst) {
      inst = echarts.init(cellEl, null, { renderer: 'canvas' });
      hubCharts.set(dcName, inst);
    }
    const xs = (series.cpu.length ? series.cpu : (series.memory.length ? series.memory : series.disk.length ? series.disk : series.cUsed))
      .map(p => p.ts);
    inst.setOption({
      grid: { left: 40, right: 16, top: 32, bottom: 28 },
      tooltip: { trigger: 'axis' },
      legend: { top: 4, textStyle: { color: 'var(--muted)' } },
      xAxis: {
        type: 'category',
        data: xs.map(fmtTs),
        axisLabel: { color: 'var(--muted)', fontSize: 11 },
        axisLine: { lineStyle: { color: 'var(--border)' } }
      },
      yAxis: {
        type: 'value', min: 0, max: 100,
        axisLabel: { color: 'var(--muted)', formatter: '{value}%', fontSize: 11 },
        splitLine: { lineStyle: { color: 'var(--border)' } }
      },
      series: [
        { name: 'CPU',    type: 'line', smooth: true, data: series.cpu.map(p => p.value),    lineStyle: { color: '#38bdf8' }, symbol: 'circle', symbolSize: 4 },
        { name: '内存',   type: 'line', smooth: true, data: series.memory.map(p => p.value), lineStyle: { color: '#22c55e' }, symbol: 'circle', symbolSize: 4 },
        { name: '最差盘', type: 'line', smooth: true, data: series.disk.map(p => p.value),   lineStyle: { color: '#eab308' }, symbol: 'circle', symbolSize: 4 },
        { name: 'C 盘',   type: 'line', smooth: true, data: series.cUsed.map(p => p.value),  lineStyle: { color: '#ef4444' }, symbol: 'circle', symbolSize: 4 }
      ]
    }, true);
  }
}

const onResize = () => { for (const inst of hubCharts.values()) inst.resize(); };

onMounted(() => {
  loadSummary();
  loadHub();
  loadProblems();
  // R158.69.10 (2026-10-11) — admin members drill-down. 读 URL query
  //   ?adminMembers=1 → 默认展开 (e.g. 浏览器书签 / 邮件链接共享).
  if (typeof location !== 'undefined' && location.search) {
    try {
      const params = new URLSearchParams(location.search);
      if (params.get('adminMembers') === '1' && !adminDrillOpen.value) {
        adminDrillOpen.value = true;
      }
    } catch (_) { /* ignore */ }
  }
  // R158.72 (2026-10-11) — 账户变更趋势独立 5min cadence (跟 summary
  //   30s 不同节奏, 趋势数据不需要 30s 粒度刷新, 减轻 DB 负担).
  loadAccountChanges();
  acctTimer = setInterval(() => { loadAccountChanges().catch(() => {}); }, 5 * 60 * 1000);
  timer = setInterval(() => { loadSummary(); loadHub(); loadProblems(); }, 30000);
  window.addEventListener('resize', onResize);
  window.addEventListener('resize', acctOnResize);
});
onBeforeUnmount(() => {
  if (timer) { clearInterval(timer); timer = null; }
  if (acctTimer) { clearInterval(acctTimer); acctTimer = null; }
  window.removeEventListener('resize', onResize);
  window.removeEventListener('resize', acctOnResize);
  for (const inst of hubCharts.values()) inst.dispose();
  hubCharts.clear();
  if (acctChartInstance) { acctChartInstance.dispose(); acctChartInstance = null; }
});
</script>

<style scoped>
.overview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
  margin-top: 16px;
}
.hub-section { margin-top: 20px; padding: 12px 16px; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; }
.hub-header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
.hub-header h3 { margin: 0; font-size: 14px; font-weight: 600; color: var(--fg); }
.hub-meta { font-size: 12px; }
/* R158.7 — per-DC sub-chart grid. Flex wrap so a 2-DC hub renders 2
   side-by-side, a 3-DC hub renders 3 wide (or 2+1 on narrow screens),
   and a single-DC hub stretches to full width via .wide. */
.hub-charts-grid { display: flex; flex-wrap: wrap; gap: 16px; }
.hub-chart-cell {
  flex: 0 0 calc(50% - 8px);
  min-width: 420px;
  background: color-mix(in srgb, var(--panel) 60%, transparent);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px 12px;
}
.hub-chart-cell.wide { flex: 0 0 100%; }
.hub-chart-cell .dc-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
  margin-bottom: 6px;
  font-family: ui-monospace, monospace;
}
.hub-chart { width: 100%; height: 220px; }
.hub-empty { padding: 12px 0; font-size: 13px; }

.problem-section { margin-top: 16px; padding: 12px 16px; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; }
.problem-header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
.problem-header h3 { margin: 0; font-size: 14px; font-weight: 600; color: var(--fg); }
.problem-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.problem-table th, .problem-table td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--border); }
.problem-table th { color: var(--muted); font-weight: 500; font-size: 12px; }
.problem-table .agent { font-family: ui-monospace, monospace; }
.problem-table .row-critical { background: rgba(239, 68, 68, 0.06); }
.badge { padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 500; }
.badge-critical { background: rgba(239, 68, 68, 0.18); color: var(--severity-critical-text, var(--red)); }
.badge-warning  { background: rgba(234, 179, 8, 0.18); color: var(--severity-warning-text, var(--yellow)); }
.cell-critical { color: var(--severity-critical-text, var(--red)); font-weight: 600; }
.cell-warning  { color: var(--severity-warning-text, var(--yellow)); }
.drivers { display: flex; flex-wrap: wrap; gap: 4px; }
.driver-chip { padding: 1px 6px; background: var(--border); border-radius: 4px; font-size: 11px; color: var(--fg); }
.problem-empty { padding: 12px 0; font-size: 13px; }

.lockout-last {
  margin-top: 12px;
  padding: 8px 12px;
  background: var(--panel);
  border-left: 3px solid var(--severity-warning-text, var(--yellow));
  border-radius: 4px;
  font-size: 13px;
}
.overview-footer { margin-top: 12px; font-size: 12px; }
.error-banner {
  margin: 12px 0;
  padding: 8px 12px;
  background: var(--panel);
  border-left: 3px solid var(--severity-critical-text, var(--red));
  border-radius: 4px;
  font-size: 13px;
  color: var(--severity-critical-text, var(--red));
}
.muted { color: var(--muted); opacity: 0.85; }
</style>

<style scoped>
.overview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
  margin-top: 16px;
}
.lockout-last {
  margin-top: 12px;
  padding: 8px 12px;
  background: var(--panel);
  border-left: 3px solid var(--severity-warning-text, var(--yellow));
  border-radius: 4px;
  font-size: 13px;
}
.overview-footer { margin-top: 12px; font-size: 12px; }
.error-banner {
  margin: 12px 0;
  padding: 8px 12px;
  background: var(--panel);
  border-left: 3px solid var(--severity-critical-text, var(--red));
  border-radius: 4px;
  font-size: 13px;
  color: var(--severity-critical-text, var(--red));
}
.muted { color: var(--muted); opacity: 0.85; }
</style>

<style scoped>
/* R158.69.10 (2026-10-11) — admin members drill-down section. 完全不动
   已 ship .overview-grid/.hub-section/.problem-section 等老 CSS. */
.admin-drilldown {
  margin-top: 20px;
  padding: 12px 16px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.drill-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 8px;
}
.drill-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
}
.drill-toggle {
  padding: 4px 12px;
  background: var(--accent, #38bdf8);
  color: white;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}
.drill-toggle:hover { opacity: 0.85; }
.drill-body { display: grid; gap: 16px; margin-top: 8px; }
.drill-group h4 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--muted);
}
</style>

<style scoped>
/* R158.72 (2026-10-11) — 账户变更趋势 section. 跟 admin-drilldown 同
   box 风格 (panel/border 包裹 + 14px 标题). 完全不动已 ship CSS. */
.account-changes-section {
  margin-top: 20px;
  padding: 12px 16px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.acct-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 8px;
}
.acct-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
}
.acct-subtitle { font-size: 12px; }
.chart-canvas {
  width: 100%;
  height: 280px;
  outline: none;
}
.skeleton-chart {
  height: 280px;
  background: linear-gradient(90deg, var(--panel) 0%, var(--border) 50%, var(--panel) 100%);
  background-size: 200% 100%;
  animation: acct-shimmer 1.5s infinite;
  border-radius: 4px;
}
@keyframes acct-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.acct-empty { padding: 24px 0; text-align: center; font-size: 13px; }
</style>