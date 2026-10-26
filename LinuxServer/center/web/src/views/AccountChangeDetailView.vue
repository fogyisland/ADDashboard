<!--
  R158.X (2026-10-15) — 账户变更明细 (AccountChangeDetailView)
  =================================================
  Operator directive 2026-10-14: "当前创建、修改、删除、启用、禁用账户 是基
  于数据聚合，那么是否能够在左边SideBar显示具体的这些数据，另外修改部分能
  否显示具体的操作是什么" + "将信息作为监控告警下的一个菜单放进来"。

  4 section top-level view, 平行 FailedLogonView / LockoutAccountsView:
    Section A — 5 块大字卡片 (created / modified / deleted / enabled /
      disabled 当日计数 + 跨 DC 数). /api/account-change/summary.
    Section B — 30 天 5 series trend mini-chart. 复用
      /api/dashboard/account-change-trend (R158.72 ship) + DashboardView
      renderAccountChangesChart 同形态 (5 series 平滑折线 + 渐变 area
      + scrollable legend).
    Section C — 5 tab 明细表 (每 action 当日 top-50). 默认 active = enabled
      (operator 最高频看). /api/account-change/detail?action=...&limit=50.
    Section D — 账户管理 Event Log (Security log 4720/4722/4723/4725/
      4726/4738/4740 跨 DC). /api/account-change/events?sinceHours=24.

  Polling: 30s 跟 FailedLogonView / LockoutAccountsView / EventlogView
  / OsBaselineView 同 (R158.50 precedent). Trend chart 5min cadence 跟
  DashboardView 平行.

  Auth tier: userAuth ONLY (no admin perm gate) — 跟 /eventlog /
  /os-baseline / /lockout-accounts / /failed-logon-2h 1:1 平行.
-->
<template>
  <AppLayout>
    <div class="account-change-detail-page">
      <header class="page-header">
        <div class="title-block">
          <h1>账户变更明细</h1>
          <p class="subtitle">
            AD 账户 5 类动作（创建 / 修改 / 删除 / 启用 / 禁用）当日前 50 条 ·
            数据来源 <code>ad_account_change</code> 表 + <code>ad_eventlog_events</code>
            安全日志 · 每 86400 秒由 <code>ad_account_change</code> 包写入 ·
            账户管理事件每 5 分钟由 <code>ad_eventlog_collector</code> 包写入
          </p>
        </div>
        <div class="header-actions">
          <span class="refresh-indicator">
            <span :class="['dot', loading ? 'on' : 'off']"></span>
            <span class="refresh-label">每 {{ POLL_INTERVAL_SEC }} 秒刷新</span>
          </span>
          <span v-if="lastUpdated" class="last-update">最后更新：{{ formatTime(lastUpdated) }}</span>
          <button class="refresh-btn" :disabled="loading" @click="loadAll" data-test="refresh">刷新</button>
        </div>
      </header>

      <!--
        Section A — 5 块大字卡片 (按 action 排序)
        跟 R158.69.10 admin members 跟 R158.47 管理员成员 panel 视觉
        形态 1:1 平行 (大字 + 色 + dcCount meta). 大字用 admin-members
        已有 .admin-summary-row CSS 类复用 (AppLayout 全局, 0 新增).
      -->
      <section class="summary-cards" data-test="summary-cards">
        <div v-for="card in summaryCards" :key="card.action" class="summary-card" :data-test="`card-${card.action}`">
          <div class="summary-card-label">{{ card.label }}</div>
          <div class="summary-card-count" :style="{ color: card.color }">{{ card.count }}</div>
          <div class="summary-card-meta">当日 · 跨 {{ card.dcCount }} 台 DC</div>
        </div>
      </section>

      <!--
        Section B — 30-day 5 series trend chart. 复用 R158.72 ship endpoint
        /api/dashboard/account-change-trend?days=30. 5min cadence polling
        跟 DashboardView 平行 (R158.50 跟 R150 的"trends 不需要 30s 粒度" lesson).
      -->
      <section class="account-changes-section">
        <header class="acct-header">
          <h3>账户变更趋势（近 30 天）</h3>
          <div class="muted acct-subtitle">创建 / 修改 / 删除 / 启用 / 禁用 · 按天聚合</div>
        </header>
        <div v-if="loadingAcct && !acctHasChartedOnce" class="skeleton skeleton-chart"></div>
        <div v-else-if="acctError" class="error-banner">
          <span>加载趋势失败</span>
          <button @click="loadAccountChanges">重试</button>
        </div>
        <div v-else-if="!acctHasData && !acctHasChartedOnce" class="muted acct-empty">近 30 天暂无账户变更事件</div>
        <div v-else ref="acctChartEl" class="chart-canvas" data-test="account-changes-chart"></div>
      </section>

      <!--
        Section C — 5 tab 明细表 (每 action 当日 top-50).
        5 tab 一字排, active tab 加 .active 类. skeleton 跟 empty state 跟
        FailedLogonView 1:1 平行 (.skeleton / .skeleton-row / .empty-state
        CSS 类全局复用). 5 tab 计数用 summary 已经 fetch 的 count, 不再
        重新打 detail endpoint 计数 (节省 5 次 DB hit).
      -->
      <section class="detail-tables">
        <nav class="tabs" role="tablist" aria-label="操作类型">
          <button v-for="t in DETAIL_TABS" :key="t.action"
            :class="{ active: activeTab === t.action }"
            role="tab"
            :aria-selected="activeTab === t.action"
            @click="setActiveTab(t.action)"
            :data-test="`tab-${t.action}`">
            {{ t.label }} <span class="tab-count">{{ tabCounts[t.action] ?? '—' }}</span>
          </button>
        </nav>

        <div v-if="detailLoading && detailRows.length === 0" class="skeleton">
          <div v-for="i in 5" :key="i" class="skeleton-row"></div>
        </div>

        <div v-else-if="detailError" class="error-banner">
          <span>明细加载失败</span>
          <button @click="loadDetail">重试</button>
        </div>

        <div v-else-if="detailRows.length === 0" class="empty-state">
          今日暂无 {{ DETAIL_TABS.find(t => t.action === activeTab)?.label }} 事件 — 等待各 DC 收集器首次上报
        </div>

        <div v-else class="table-wrapper">
          <table class="detail-table" data-test="detail-table">
            <thead>
              <tr>
                <th>SAM 账户</th>
                <th>显示名</th>
                <th>DC</th>
                <th>创建时间</th>
                <th>修改时间</th>
                <th>变更日期</th>
                <!-- R158.72.x.4 (2026-10-16) — +1 列 "操作人" (operator_user,
                     事件 Properties[4] SubjectUserName). wire shape 1:1 透传
                     dailyTopByAction SELECT 7 列. 老 entry NULL → "—". -->
                <th>操作人</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in detailRows" :key="`${r.sam || ''}-${r.dcName || ''}-${i}`">
                <td class="sam-cell" :title="r.sam">{{ r.sam || '—' }}</td>
                <td class="display-name-cell" :title="r.displayName">{{ r.displayName || '—' }}</td>
                <td class="dc-cell" :title="r.dcName">{{ r.dcName || '—' }}</td>
                <td class="time-cell">{{ formatTime(r.createdAt) }}</td>
                <td class="time-cell">{{ formatTime(r.modifiedAt) }}</td>
                <td class="time-cell">{{ r.changeDate || '—' }}</td>
                <td class="operator-cell" :title="r.operatorUser">{{ r.operatorUser || '—' }}</td>
              </tr>
            </tbody>
          </table>
          <footer class="table-footer">
            共 {{ detailRows.length }} 条 · 当日 · 全部 DC
          </footer>
        </div>
      </section>

      <!--
        Section D — 账户管理 Event Log. 跨 DC Security log 4720/4722/
        4723/4725/4726/4738/4740, 默认 24h. 跟 EventlogView 5 channel
        事件日志区分: 这里是 AD 用户/组 account management 专项 event 列表.
        列表用 <ul> + <li> 而不是 table, 跟 EventlogView 1:1 平行 (event
        列表就是 message 长 string 主导, ul/pre 视觉更聚焦).
      -->
      <section class="account-events">
        <header class="section-header">
          <h3>账户管理事件日志</h3>
          <span class="section-meta">
            安全日志事件 ID 4720 / 4722 / 4723 / 4725 / 4726 / 4738 / 4740 ·
            最近 24 小时 · 跨所有 DC
          </span>
        </header>

        <div v-if="eventLoading && accountEvents.length === 0" class="skeleton">
          <div v-for="i in 3" :key="i" class="skeleton-row"></div>
        </div>

        <div v-else-if="accountEvents.length === 0" class="empty-state">
          当日暂无账户管理事件（域控审核策略未开启 / 或当日无操作）
        </div>

        <ul v-else class="event-list">
          <li v-for="ev in accountEvents" :key="ev.recordId" class="event-item">
            <span class="event-id">Event ID {{ ev.eventId }}</span>
            <time class="event-time">{{ formatTime(ev.ts) }}</time>
            <span class="event-dc" :title="ev.dcName">{{ ev.dcName }}</span>
            <pre class="event-message">{{ ev.message }}</pre>
          </li>
        </ul>
      </section>
    </div>
  </AppLayout>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import * as echarts from 'echarts';
import AppLayout from '../components/AppLayout.vue';
import { dashboardApi } from '../api/dashboard.js';
import {
  fetchAccountChangeSummary,
  fetchAccountChangeDetail,
  fetchAccountManagementEvents
} from '../api/account-change.js';

const POLL_INTERVAL_MS = 30 * 1000;
const POLL_INTERVAL_SEC = POLL_INTERVAL_MS / 1000;
const ACCT_POLL_MS = 5 * 60 * 1000;     // 5min cadence 跟 DashboardView 平行
const TREND_DAYS = 30;
const DETAIL_LIMIT = 50;
const EVENTS_SINCE_HOURS = 24;
const EVENTS_LIMIT = 200;

// R158.X — 5 action tab config. 跟 DashboardView 5 series 同色 (R158.72 ship
//   形态), 操作员视觉一致. 顺序按 operator 关注度排: 创建 / 修改 / 删除 /
//   启用 / 禁用 (跟 DashboardView 顶部图表 label 同序, 跟 SQL helper 5
//   action list 同).
const DETAIL_TABS = [
  { action: 'created',  label: '创建', color: '#22c55e' },
  { action: 'modified', label: '修改', color: '#3b82f6' },
  { action: 'deleted',  label: '删除', color: '#f59e0b' },
  { action: 'enabled',  label: '启用', color: '#10b981' },
  { action: 'disabled', label: '禁用', color: '#ef4444' }
];
const ACCT_COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#10b981', '#ef4444'];
const ACCT_LABELS = ['创建', '修改', '删除', '启用', '禁用'];
const ACCT_ACTIONS = ['created', 'modified', 'deleted', 'enabled', 'disabled'];

const summary = ref([]);          // [{ action, count, dcCount }]
const detailRows = ref([]);       // [{ sam, displayName, dcName, createdAt, modifiedAt, changeDate, dn, operatorUser }]
const accountEvents = ref([]);    // [{ collectedAt, dcName, channel, severity, eventId, recordId, message, ts, auditFailure }]
const acctBuckets = ref([]);      // [{ action, change_date, event_count }]
const activeTab = ref('enabled'); // 默认 active = enabled (operator 最高频)
const loading = ref(false);
const detailLoading = ref(false);
const eventLoading = ref(false);
const loadingAcct = ref(false);
const acctError = ref(false);
const detailError = ref(false);
const lastUpdated = ref(null);
let pollHandle = null;
let acctPollHandle = null;
let acctChartInstance = null;

// Section A reactive derived state
const summaryCards = computed(() => {
  return ACCT_ACTIONS.map((action, i) => {
    const row = summary.value.find(s => s.action === action) || { action, count: 0, dcCount: 0 };
    return {
      action,
      label:  ACCT_LABELS[i],
      color:  ACCT_COLORS[i],
      count:  row.count,
      dcCount: row.dcCount
    };
  });
});
const tabCounts = computed(() => {
  const m = {};
  for (const s of summary.value) m[s.action] = s.count;
  return m;
});

// Section B chart state
const acctChartEl = ref(null);
const acctHasData = computed(() => Array.isArray(acctBuckets.value) && acctBuckets.value.length > 0);
const acctHasChartedOnce = ref(false);

function setActiveTab(action) {
  if (activeTab.value === action) return;
  activeTab.value = action;
  loadDetail();
}

// ── load orchestration ────────────────────────────────────────────────────
async function loadAll() {
  await Promise.all([
    loadSummary(),
    loadAccountChanges(),
    loadDetail(),
    loadAccountEvents()
  ]);
  lastUpdated.value = new Date();
}

async function loadSummary() {
  loading.value = true;
  try {
    const r = await fetchAccountChangeSummary();
    summary.value = Array.isArray(r.data?.summary) ? r.data.summary : [];
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('account-change summary load failed', e);
    summary.value = [];
  } finally {
    loading.value = false;
  }
}

async function loadAccountChanges() {
  loadingAcct.value = true;
  acctError.value = false;
  try {
    const r = await dashboardApi.getAccountChangeTrend({ days: TREND_DAYS });
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

async function loadDetail() {
  detailLoading.value = true;
  detailError.value = false;
  try {
    const r = await fetchAccountChangeDetail({ action: activeTab.value, limit: DETAIL_LIMIT });
    detailRows.value = Array.isArray(r.data?.rows) ? r.data.rows : [];
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('account-change detail load failed', e);
    detailError.value = true;
    detailRows.value = [];
  } finally {
    detailLoading.value = false;
  }
}

async function loadAccountEvents() {
  eventLoading.value = true;
  try {
    const r = await fetchAccountManagementEvents({ sinceHours: EVENTS_SINCE_HOURS, limit: EVENTS_LIMIT });
    accountEvents.value = Array.isArray(r.data?.events) ? r.data.events : [];
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('account-change events load failed', e);
    accountEvents.value = [];
  } finally {
    eventLoading.value = false;
  }
}

// ── Section B chart rendering (跟 DashboardView:300-380 1:1 平行) ─────────
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
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const xs = [];
  for (let i = TREND_DAYS - 1; i >= 0; i--) {
    xs.push(new Date(end.getTime() - i * 86_400_000));
  }
  const byType = new Map();
  for (const r of acctBuckets.value) {
    const a = r.action;
    if (!byType.has(a)) byType.set(a, new Map());
    const bucketKey = new Date(r.bucket_day || r.change_date).getTime();
    byType.get(a).set(bucketKey, Number(r.event_count) || 0);
  }
  const series = ACCT_ACTIONS.map((name, i) => {
    const m = byType.get(name) || new Map();
    const ys = xs.map(d => m.get(d.getTime()) ?? 0);
    const color = ACCT_COLORS[i % ACCT_COLORS.length];
    return {
      name: ACCT_LABELS[i],
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

const acctOnResize = () => { if (acctChartInstance) acctChartInstance.resize(); };

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── lifecycle ─────────────────────────────────────────────────────────────
onMounted(() => {
  loadAll();
  pollHandle = setInterval(loadAll, POLL_INTERVAL_MS);
  // trend 5min cadence (跟 DashboardView 平行, 跟 detail / events 30s 独立).
  acctPollHandle = setInterval(() => { loadAccountChanges(); }, ACCT_POLL_MS);
});
onBeforeUnmount(() => {
  if (pollHandle) clearInterval(pollHandle);
  if (acctPollHandle) clearInterval(acctPollHandle);
  if (acctChartInstance) {
    acctChartInstance.dispose();
    acctChartInstance = null;
  }
  window.removeEventListener('resize', acctOnResize);
});

// 跟 R158.100.7 chart race 防御 (R158.86.6 #5 第 17 次): 当 list
// 改变且 chartEl 存在, nextTick 重 render.
watch(detailRows, async () => { /* placeholder for future cross-section */ });

// ── formatters (跟 LockoutAccountsView 1:1 平行, CST deterministic) ──────
function formatTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return '—';
  const cstMs = d.getTime() + 8 * 3600 * 1000;
  const cst = new Date(cstMs);
  const yyyy = cst.getUTCFullYear();
  const MM = String(cst.getUTCMonth() + 1).padStart(2, '0');
  const DD = String(cst.getUTCDate()).padStart(2, '0');
  const hh = String(cst.getUTCHours()).padStart(2, '0');
  const mm = String(cst.getUTCMinutes()).padStart(2, '0');
  const ss = String(cst.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${MM}-${DD} ${hh}:${mm}:${ss}`;
}

// DN 长 string 缩略: "CN=张三,OU=IT,DC=corp,DC=local" → 留 head + "…" + tail.
// 跟 LDAP/AD DN 阅读习惯一致 (看 OU 跟 DC 后缀, 中间 trunk 简略).
// R158.X (2026-10-15) — `ad_account_change` 表无 `dn` 列 (R158.72 ship
//   形态只有 sam/display_name/created_at/modified_at/change_date/dc_name
//   5 列), DN 在 PS1 wire 阶段丢弃, 中心端不存. 移除 abbreviateDn helper.
</script>

<style scoped>
.account-change-detail-page { display: flex; flex-direction: column; gap: 20px; }
.page-header { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; }
.title-block h1 { margin: 0 0 6px; font-size: 22px; font-weight: 600; }
.subtitle { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.subtitle code { background: var(--panel); padding: 1px 4px; border-radius: 3px; font-size: 11px; }
.header-actions { display: flex; align-items: center; gap: 12px; }
.refresh-indicator { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
.refresh-indicator .dot { width: 8px; height: 8px; border-radius: 50%; background: #6b7280; }
.refresh-indicator .dot.on { background: #10b981; }
.last-update { color: var(--muted); font-size: 12px; }
.refresh-btn { padding: 6px 14px; border: 1px solid var(--border); border-radius: 3px; cursor: pointer; background: var(--input-bg); color: var(--text); }
.refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* Section A — 5 块大字卡片 */
.summary-cards {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 12px;
}
.summary-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.summary-card-label { color: var(--muted); font-size: 12px; font-weight: 500; }
.summary-card-count { font-size: 28px; font-weight: 700; line-height: 1.1; }
.summary-card-meta { color: var(--muted); font-size: 11px; }

/* Section B — 30d trend chart */
.account-changes-section { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 16px; }
.acct-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px; }
.acct-header h3 { margin: 0; font-size: 15px; font-weight: 600; }
.acct-subtitle { font-size: 11px; }
.chart-canvas { width: 100%; height: 280px; }
.skeleton-chart { width: 100%; height: 280px; }
.acct-empty { padding: 20px 0; text-align: center; }

/* Section C — 5 tab 明细表 */
.detail-tables { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 16px; }
.tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.tabs button {
  background: transparent;
  border: 1px solid transparent;
  border-bottom: none;
  padding: 8px 14px;
  cursor: pointer;
  color: var(--muted);
  font-size: 13px;
  border-top-left-radius: 4px;
  border-top-right-radius: 4px;
}
.tabs button:hover { color: var(--text); }
.tabs button.active {
  background: var(--input-bg);
  border-color: var(--border);
  color: var(--text);
  font-weight: 600;
  border-bottom: 1px solid var(--panel);
  margin-bottom: -1px;
}
.tab-count { color: var(--muted); font-size: 11px; margin-left: 4px; }
.tabs button.active .tab-count { color: var(--accent); font-weight: 600; }

.table-wrapper { overflow-x: auto; }
.detail-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.detail-table th, .detail-table td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}
.detail-table th { color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; }
.sam-cell { font-family: monospace; }
.time-cell { white-space: nowrap; color: var(--muted); }
.dc-cell { white-space: nowrap; }
.operator-cell { white-space: nowrap; font-family: monospace; font-size: 11px; color: var(--muted); }
.table-footer { color: var(--muted); font-size: 11px; padding: 8px 0 0; text-align: right; }

/* Section D — 账户管理 Event Log */
.account-events { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 16px; }
.section-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px; }
.section-header h3 { margin: 0; font-size: 15px; font-weight: 600; }
.section-meta { color: var(--muted); font-size: 11px; }
.event-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
.event-item {
  display: grid;
  grid-template-columns: auto auto 1fr;
  grid-template-rows: auto auto;
  gap: 4px 12px;
  padding: 8px 10px;
  background: var(--input-bg);
  border: 1px solid var(--border);
  border-radius: 4px;
}
.event-id { font-family: monospace; font-size: 12px; font-weight: 600; color: var(--accent); }
.event-time { font-size: 11px; color: var(--muted); }
.event-dc { font-size: 11px; color: var(--muted); font-family: monospace; }
.event-message { grid-column: 1 / -1; margin: 0; font-size: 12px; line-height: 1.4; white-space: pre-wrap; word-break: break-all; font-family: inherit; }

/* 共享 skeleton / error / empty (跟 FailedLogonView / LockoutAccountsView 平行) */
.skeleton { display: flex; flex-direction: column; gap: 8px; }
.skeleton-row {
  height: 32px;
  background: linear-gradient(90deg, var(--panel) 0%, var(--input-bg) 50%, var(--panel) 100%);
  background-size: 200% 100%;
  animation: skeletonShimmer 1.5s infinite;
  border-radius: 4px;
}
@keyframes skeletonShimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.error-banner { padding: 12px; background: rgba(239, 68, 68, 0.1); border: 1px solid #ef4444; border-radius: 4px; color: #ef4444; display: flex; justify-content: space-between; align-items: center; }
.error-banner button { padding: 4px 10px; border: 1px solid #ef4444; border-radius: 3px; background: transparent; color: #ef4444; cursor: pointer; }
.empty-state { padding: 20px 0; text-align: center; color: var(--muted); }
</style>
