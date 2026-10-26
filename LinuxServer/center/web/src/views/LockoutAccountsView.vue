<!--
  R131 + R135 + R139 + R158.31 — 锁定账户信息 (LockoutAccountsView)
  =================================================
  Operator directive 2026-09-27: "在前台增加一个sidebar 菜单，增加一个锁定
  账户信息" — a 前台 auth-required user-facing surface listing recent
  account-lockout events. Operator directive 2026-09-28:
    "锁定的信息不够完整，我们需要了解 锁定账户、Description、上报 DC 服务器、
     锁定机器，锁定客户端" — currently SID-or-SAM-name garbled because
    collect.ps1 extracted EventData fields by index instead of by Name.
  R135 fix: collect.ps1 now extracts EventData fields by Name (where the
    .Name attribute names each Data element per the 4740 event manifest,
    not by index which is implementation-defined across Windows versions).

  R139 (2026-09-28): "另外我们锁定账户在这里多一个description 也显示出来，
  不然只是账户看不出来账户". Originally designed against AD `description`
  property (运维-managed free-text '姓名/部门/工号/联系方式'), but the
  collected PS1 (R139.1) and wire shape landed on the same name even
  though the value semantics were unclear.

  R158.31 (2026-10-02): Operator confirmed — the column should hold the
  AD `displayName` (中文姓名 / 系统展示名), NOT `description`. We renamed
  the wire shape, DB column, and PS1 output field all the way through
  (targetUserDescription → targetUserDisplayName, AD attribute
  Get-ADUser -Properties description → displayName). Nullable so old
  agent versions just render "—" until the next collect cycle on an
  upgraded agent.

  R139.1 (2026-09-29): R139 had landed services / sql / migration /
  view but NOT the agent-side PS1 — ad_lockout_list/1.0.1/collect.ps1
  never called Get-ADUser, so target_user_description stayed NULL on
  every event and the UI column was always "—". R139.1 wired the
  Get-ADUser lookup into the PS1 with a 24h hashtable cache keyed by
  lowercase SAM, added bit 2 to error_code for missing RSAT module, and
  outputs TargetUserDescription on every event (R158.31 renamed to
  TargetUserDisplayName). agent manifest stays 1.0.1; we PUT new PS1
  content via the same editScript /api/admin/packages/:name/script path
  used by r141 partner-port reseed.

  Columns (6, not 5):
    1. 锁定账户       — ad_lockout_events.target_user_name (TargetUserName)
                        + optional target_domain_name if present
    2. 显示名         — ad_lockout_events.target_user_display_name (R158.31,
                        was R139.1 target_user_description: AD user
                        `displayName` (中文姓名 / 系统展示名), agent stamps
                        it after a 24h-cached Get-ADUser -Properties
                        displayName lookup. NULL when the AD module is
                        absent or the account is gone.)
    3. 锁定时间       — ad_lockout_events.occurred_at
    4. 上报 DC 服务器  — ad_lockout_events.dc_name (which DC's Security log
                        captured the 4740 — operator: "上报 DC 服务器")
    5. 主题（谁锁的） — SubjectDomainName \\ SubjectUserName (the
                        service/computer identity that initiated the
                        lock — pre-R135 was SubjectSid (a SID) because
                        index 2 was TargetSid, not SubjectDomainName)
    6. 锁定客户端     — ad_lockout_events.caller_computer_name
                        (CallerComputerName — pre-R135 was SubjectUserName
                        (a SAM name) because index 3 was SubjectUserName,
                        not CallerComputerName)

  "锁定机器" in operator's original 4-column spec maps to "上报 DC 服务
  器" (the DC that wrote the 4740 event). The 4740 event itself doesn't
  carry a "machine that got locked" field — only the user account — so
  the DC that held the lock is the closest signal. Status code in the
  row's hover title is the 4740 Status field (0xc0000234 = "Account
  locked out due to too many failed attempts" if extracted, etc).

  Access tier: auth-required, NO admin perm gate — mirrors /eventlog
  (R112), /os-baseline (R116), /replication-log/monitor (R129).

  Polling: 30s matches EventlogView / OsBaselineView / LockoutTroubleshooting.

  URL state: `?dc=HOST` deep-link from DcCard.vue — ?dc= is kept when the
  operator toggles the 时间窗口 dropdown (router.replace).
-->
<template>
  <AppLayout>
    <div class="lockout-accounts-page">
      <header class="page-header">
        <div class="title-block">
          <h1>锁定账户信息</h1>
          <p class="subtitle">
            列表固定最近 24 小时所有账户锁定事件 · 折线图支持 24 小时 / 7 天 / 全部 切换 · 数据来源:
            <code>ad_lockout_events</code> 表 (每 15 分钟由
            <code>ad_lockout_list</code> 包写入)
          </p>
        </div>
        <div class="header-actions">
          <!-- R158.109.b — 24小时/7天/全部 3-button toggle. 1:1 平行
               R158.108 EventlogView:39-64 + R158.109.a FailedLogonView.
               跟 /eventlog / /failed-logon-2h 视觉一致. 0 改 list 24h 固定
               (list 跟 chart 解耦, 2 独立 wire). -->
          <div class="range-toggle" role="tablist" aria-label="时间范围">
            <button
              :class="{ active: chartRange === '24h' }"
              role="tab"
              :aria-selected="chartRange === '24h'"
              @click="setChartRange('24h')"
              data-test="range-24h"
            >24小时</button>
            <button
              :class="{ active: chartRange === '7d' }"
              role="tab"
              :aria-selected="chartRange === '7d'"
              @click="setChartRange('7d')"
              data-test="range-7d"
            >7天</button>
            <button
              :class="{ active: chartRange === 'all' }"
              role="tab"
              :aria-selected="chartRange === 'all'"
              @click="setChartRange('all')"
              data-test="range-all"
            >全部</button>
          </div>
          <span v-if="lastUpdated" class="last-update">最后更新：{{ formatTime(lastUpdated) }}</span>
          <button class="refresh-btn" :disabled="loading" @click="load" data-test="refresh">刷新</button>
        </div>
      </header>

      <div v-if="dcFilter" class="active-filter">
        <span class="filter-label">已筛选 DC:</span>
        <span class="filter-value">{{ dcFilter }}</span>
        <button class="clear-filter" @click="clearDc" data-test="clear-dc">清除筛选</button>
        <span class="filter-count"> — 共 {{ filteredRows.length }} / {{ rows.length }} 条</span>
      </div>

      <!-- R158.53 — 顶部 ECharts 折线图, 24h event log 趋势.
           top-5 DC by 24h COUNT(*) DESC; ?dc=HOST deep-link 收成单 DC 线.
           数据源: ad_lockout_events (跟 detail table 同源). -->
      <section class="chart-section">
        <div v-if="loading && !chartHasData" class="skeleton skeleton-chart"></div>
        <div v-else-if="!chartHasData" class="empty-state">
          暂无 24h 锁定事件 — 等待 {{ dcFilter ? dcFilter : '各 DC' }} 收集器首次上报
        </div>
        <div v-else ref="chartEl" class="chart-canvas" data-test="lockout-trend-chart"></div>
      </section>

      <div v-if="loading && rows.length === 0" class="skeleton">
        <div v-for="i in 5" :key="i" class="skeleton-row"></div>
      </div>

      <div v-else-if="error" class="error-banner">
        <span>加载锁定账户信息失败</span>
        <button @click="load">重试</button>
      </div>

      <div v-else-if="filteredRows.length === 0" class="empty-state">
        <span v-if="rows.length === 0">暂无锁定事件 — 等待 {{ dcFilter ? dcFilter : '各 DC' }} 收集器首次上报</span>
        <span v-else>当前 DC 筛选下无事件 — <button class="link-btn" @click="clearDc">查看全部</button></span>
      </div>

      <div v-else class="table-wrapper">
        <table class="lockout-table" data-test="lockout-table">
          <thead>
            <tr>
              <th>锁定账户</th>
              <th>显示名</th>
              <th>锁定时间</th>
              <th>上报 DC 服务器</th>
              <th>主题（谁锁的）</th>
              <th>锁定客户端</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(ev, i) in filteredRows" :key="`${ev.eventRecordId || ''}-${ev.occurredAt}-${i}`">
              <td class="target-cell" :title="ev.targetUserName">{{ ev.targetUserName || '—' }}</td>
              <!-- R158.31 (was R139.1): AD user `displayName` property
                   (agent stamps it via Get-ADUser -Properties displayName
                   with 24h cache). Render "—" when AD module is absent
                   or account is gone. -->
              <td class="display-name-cell" :title="ev.targetUserDisplayName">
                {{ ev.targetUserDisplayName || '—' }}
              </td>
              <td class="time-cell">{{ formatTime(ev.occurredAt) }}</td>
              <td class="dc-cell" :title="ev.dcName">{{ ev.dcName || '—' }}</td>
              <td class="subject-cell" :title="`${ev.subjectDomain || ''}\\${ev.subjectUserName || ''}`">
                {{ formatSubject(ev.subjectDomain, ev.subjectUserName) }}
              </td>
              <td class="caller-cell" :title="ev.callerComputerName">
                <button
                  v-if="ev.callerComputerName"
                  class="caller-badge"
                  @click="filterByCaller(ev.callerComputerName)"
                  data-test="caller-filter"
                >{{ ev.callerComputerName }}</button>
                <span v-else class="muted">—</span>
              </td>
            </tr>
          </tbody>
        </table>
        <!-- R158.109.b — 手写 prev/next + page indicator + pageSize select
             (dashboard 0 装 element-plus, el-pagination 0 引入新依赖).
             1 page = 50 行 (跟操作员 directive "一页 50行" 1:1). 翻页走
             server-paged (offset+pageSize). 翻页 0 重置 chart (list 跟
             chart 2 独立 wire). -->
        <footer class="table-footer pagination-footer" data-test="lockout-list-pagination">
          <span class="pagination-total">共 {{ total }} 条 · 第 {{ currentPage }} / {{ totalPages || 1 }} 页</span>
          <label class="pagination-size">
            <span>每页</span>
            <select v-model.number="pageSize" :disabled="listLoading" @change="onPageSizeChange" data-test="lockout-page-size">
              <option :value="50">50</option>
              <option :value="100">100</option>
              <option :value="200">200</option>
            </select>
          </label>
          <button
            class="pagination-btn"
            :disabled="currentPage <= 1 || listLoading"
            @click="goToPage(1)"
            data-test="lockout-page-first"
          >« 首页</button>
          <button
            class="pagination-btn"
            :disabled="currentPage <= 1 || listLoading"
            @click="goToPage(currentPage - 1)"
            data-test="lockout-page-prev"
          >‹ 上一页</button>
          <span class="pagination-jump">
            跳至
            <input
              v-model.number="jumpPage"
              type="number"
              :min="1"
              :max="totalPages || 1"
              class="pagination-input"
              :disabled="listLoading"
              @keyup.enter="goToPage(jumpPage)"
              data-test="lockout-page-jump"
            />
            页
          </span>
          <button
            class="pagination-btn"
            :disabled="currentPage >= totalPages || listLoading"
            @click="goToPage(currentPage + 1)"
            data-test="lockout-page-next"
          >下一页 ›</button>
          <button
            class="pagination-btn"
            :disabled="currentPage >= totalPages || listLoading"
            @click="goToPage(totalPages)"
            data-test="lockout-page-last"
          >末页 »</button>
        </footer>
      </div>
    </div>
  </AppLayout>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import * as echarts from 'echarts';
import AppLayout from '../components/AppLayout.vue';
import { listRecentLockoutEvents, fetchLockoutTrend24h, fetchLockoutTrend } from '../api/lockout.js';
import api from '../api/client.js';

const route = useRoute();
const router = useRouter();

const POLL_INTERVAL_MS = 30 * 1000;
const DEFAULT_PAGE_SIZE = 50;   // R158.109.b — 1 page = 50 行 (跟操作员 directive 1:1)

const rows = ref([]);         // raw rows from /api/lockout-events/recent
const dcFilter = ref(null);   // null = all DCs (no filter)
const loading = ref(false);
const error = ref(false);
const lastUpdated = ref(null);
let pollHandle = null;
let retentionHandle = null;   // R158.109.b — 1h refresh of ad_mgmt_retention_days

// R158.53 — 24h event-log trend chart state. Mirrors FailedLogonView.vue
// (R158.50) reactive state shape: chartEl for ECharts init, chartInstance
// for the imperative echarts instance, trendBuckets for the flat rows
// returned by /api/lockout-events/trend. chartHasData guards the empty
// state vs the chart-canvas branch in the template.
const CHART_TOP_N = 5;
const CHART_HOURS = 24;
const chartEl = ref(null);
let chartInstance = null;
const trendBuckets = ref([]);
const chartHasData = computed(() =>
  Array.isArray(trendBuckets.value) && trendBuckets.value.length > 0
);

// R158.109.b (2026-10-16) — chart 24h/7d/全部 toggle (1:1 平行 R158.108
// EventlogView). chartRange 控制 24h 走 hourly / 7d+全部 走 daily. 跟
// list 24h 固定解耦 (2 独立 wire, list 0 受 chartRange 影响).
const chartRange = ref('24h');           // '24h' | '7d' | 'all'
const DAILY_MAX_DAYS = 365;              // 跟 sql.js dailyAggregate 1:1 平行
const retentionDays = ref(30);           // "全部" 边界 (R158.107 retention)
async function loadRetentionDays() {
  try {
    const r = await api.get('/api/admin/config');
    const v = Number(r?.data?.ad_mgmt_retention_days ?? 30);
    retentionDays.value = v > 0 ? Math.min(v, DAILY_MAX_DAYS) : DAILY_MAX_DAYS;
  } catch (e) {
    // best-effort, 默认 30
  }
}

// R158.109.b — list 24h 固定 + 50/page server-paged (跟操作员 directive
// "列表为24小时窗口期, 一页 50行" 1:1). sinceHours 服务端 pin=24, list
// 0 受 chartRange 影响. el-pagination 跟 admin/audit/email-history view
// 风格统一.
const currentPage = ref(1);
const pageSize = ref(DEFAULT_PAGE_SIZE);
const total = ref(0);
const listLoading = ref(false);
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));
const jumpPage = ref(1);

// Client-side filter: pull a window of recent rows from the back-end
// (200-row cap), then narrow by dcFilter if set. The ?dc= deep-link
// from DcCard.vue drives dcFilter — pulling 200 rows lets the operator
// toggle the time-window dropdown without a re-fetch.
const filteredRows = computed(() => {
  if (!dcFilter.value) return rows.value;
  const dc = dcFilter.value;
  return rows.value.filter((r) => r.dcName === dc);
});

async function load() {
  loading.value = true;
  error.value = false;
  try {
    // R158.109.b — 拆 loadChart + loadList (2 独立 wire). 30s poll 并行
    // 触发, 翻页 0 重置 chart. chart 跟 list 0 互相阻塞.
    await Promise.allSettled([loadChart(), loadList()]);
    lastUpdated.value = new Date();
  } catch (e) {
    error.value = true;
    rows.value = [];
    trendBuckets.value = [];
  } finally {
    loading.value = false;
    await nextTick();
    renderChart();
  }
}

// R158.109.b — chart trend fetch dispatch (1:1 平行 R158.108
// fetchEventlogTrendForWindow + R158.109.a fetchFailedLogonTrendForWindow).
// 24h/7d 走 hourly trend24h, 全部 走 daily dailyAggregate.
// R158.X.99.35 (2026-10-20) — chart 24h/7d bucket 粒度 (操作员 directive
// "24小时内窗口时间为5分钟, 7天窗口时间为4小时, 其他为天" 1:1). 24h 传
// grain='bucket5m' (288 段 × topN), 7d 传 grain='bucket4h' (42 段 × topN),
// 全部传 grain='daily' (retention 边界). 跟 R158.X.99.33+.34 eventlog
// fetchEventlogTrendForWindow 1:1 平行. pivot 走 3-mode (isBucket5m /
// isBucket4h / isDaily 三 boolean) 跟 EventlogView.vue:567-569 1:1.
async function loadChart() {
  let res;
  if (chartRange.value === '24h') {
    res = await fetchLockoutTrend({
      dc: dcFilter.value || null,
      windowHours: 24,
      grain: 'bucket5m'
    });
  } else if (chartRange.value === '7d') {
    // 7d 走 4h bucket (42 段 × topN). days=7 跟事件路由 (routes/lockout.js
    // bucket4h 分支) 1:1 平行. 走 daysRaw 而非 hoursRaw (R158.X.99.34.fix
    // lesson 112 真因, 操作员接受 7d/4h 1:1)。
    res = await fetchLockoutTrend({
      dc: dcFilter.value || null,
      days: 7,
      grain: 'bucket4h'
    });
  } else {
    // 'all' 走 daily + ad_mgmt_retention_days (R158.107 retention 边界).
    res = await fetchLockoutTrend({
      dc: dcFilter.value || null,
      days: retentionDays.value,
      grain: 'daily'
    });
  }
  trendBuckets.value = Array.isArray(res.data) ? res.data : [];
}

// R158.109.b — list fetch (24h 服务端 pin + 50/page server-paged).
// sinceHours client 0 传, 服务端 hard-code=24. page 1-based → offset.
async function loadList() {
  listLoading.value = true;
  try {
    const offset = (currentPage.value - 1) * pageSize.value;
    const res = await listRecentLockoutEvents({ offset, pageSize: pageSize.value });
    rows.value = Array.isArray(res.data?.rows) ? res.data.rows : [];
    total.value = Number(res.data?.total || 0);
  } finally {
    listLoading.value = false;
  }
}

// R158.109.b — 翻页 / 改 pageSize handlers. 跟 admin/audit view
// el-pagination 行为 1:1 平行. 改 pageSize 必重置 currentPage=1 (否则
// 翻页 offset 计算会越界). goToPage clamp [1, totalPages] 兜底.
function goToPage(p) {
  const target = Math.max(1, Math.min(Math.floor(Number(p) || 1), totalPages.value));
  if (target === currentPage.value) return;
  currentPage.value = target;
  jumpPage.value = target;
  loadList();
}
function onPageSizeChange() {
  // select @change 触发, pageSize 已更新. 必重置 currentPage=1 防
  // offset 越界 (例 pageSize 200 + currentPage=3 → offset=400 翻空页).
  currentPage.value = 1;
  jumpPage.value = 1;
  loadList();
}

// R158.109.b — chartRange setter (1:1 平行 R158.108 setChartWindow).
// 切 chartRange 0 触发 list reload (list 24h 固定, 解耦).
function setChartRange(r) {
  if (chartRange.value === r) return;
  chartRange.value = r;
  loadChart();
}

// R158.53 — pivot the flat [{ agentId, bucketStart, eventCount }] rows
// into the ECharts multi-series shape: a shared 24-hour x-axis ending
// at the current UTC hour, with one series per agent. Missing hours
// are 0-filled so each line has exactly CHART_HOURS points (otherwise
// ECharts would render gaps as line breaks).
// R158.109.b (2026-10-16) — grain-aware pivot (1:1 平行 R158.108
// EventlogView pivotTrendForChart + R158.109.a FailedLogonView).
// 24h/7d 走 hourly (3600_000ms bucket), 全部 走 daily (86400_000ms
// bucket). bucketCount 跟 chartRange 解耦 (24h=24, 7d=168, 全部=N day)。
// R158.X.99.35 (2026-10-20) — chart 24h/7d bucket 粒度 (3-mode 不对称
// toggle, 跟 R158.X.99.33 eventlog 5min + R158.X.99.34 eventlog 4h +
// 全部 day 1:1 平行). 24h→5min bucket (288 段), 7d→4h bucket (42 段),
// 全部→day bucket (retentionDays 段). 1:1 平行 EventlogView.vue
// pivotTrendForChart 三 boolean (isBucket5m / isBucket4h / isDaily)
// 路线, 仅 GROUP BY 维度 (agentId vs channel) 不同.
function pivotTrendForChart(flat) {
  // R158.X.99.35 — 3-state boolean (跟 EventlogView.vue:567-569 1:1 平行)
  const isBucket5m = chartRange.value === '24h';
  const isBucket4h = chartRange.value === '7d';
  const isDaily    = chartRange.value === 'all';
  let bucketCount;
  let bucketMs;
  let endBucket;
  const now = new Date();
  if (isBucket5m) {
    // 24h × 12 (5min/h) = 288 段. bucketMs 300_000. endBucket floor
    // 到 5min UTC (跟 EventlogView 1:1)。
    bucketCount = CHART_HOURS * 12; // 288
    bucketMs = 300_000;             // 5min
    endBucket = new Date(Math.floor(now.getTime() / bucketMs) * bucketMs);
  } else if (isBucket4h) {
    // 7d × 6 (4h/天) = 42 段. bucketMs 14_400_000. endBucket floor 到 4h
    // UTC 边界 (00:00/04:00/08:00/12:00/16:00/20:00).
    bucketCount = 7 * 6;            // 42
    bucketMs = 14_400_000;          // 4h
    endBucket = new Date(Math.floor(now.getTime() / bucketMs) * bucketMs);
  } else {
    // daily (全部走)
    bucketCount = retentionDays.value;
    bucketMs = 86_400_000;
    endBucket = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  }
  const xs = [];
  for (let i = bucketCount - 1; i >= 0; i--) {
    xs.push(new Date(endBucket.getTime() - i * bucketMs));
  }
  const byAgent = new Map();
  for (const r of flat) {
    if (!byAgent.has(r.agentId)) byAgent.set(r.agentId, new Map());
    byAgent.get(r.agentId).set(new Date(r.bucketStart).getTime(), r.eventCount);
  }
  const agents = [...byAgent.keys()].sort();
  const series = agents.map((agentId) => {
    const hourMap = byAgent.get(agentId);
    const ys = xs.map((h) => hourMap.get(h.getTime()) ?? 0);
    return { agentId, ys };
  });
  return { xs, series, isDaily };
}

// R158.53 — Tailwind-ish palette, deterministic by sort index so the
// same agent always gets the same colour across reloads.
const SERIES_COLORS = [
  '#f59e0b', // amber
  '#3b82f6', // blue
  '#10b981', // emerald
  '#ef4444', // red
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#f97316', // orange
  '#84cc16'  // lime
];

// R158.53 — CST (UTC+8) formatter for the bucket axis. Mirrors
// FailedLogonView.vue:157 so the dashboard's chart axes stay aligned
// across /lockout-accounts, /failed-logon-2h, and /os-baseline.
// Deterministic regardless of browser TZ (R158.7 lesson: toLocaleString
// breaks under cross-region operator).
const fmtBucketCst = (t) => {
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return '';
  const cstMs = d.getTime() + 8 * 3600 * 1000;
  const cst = new Date(cstMs);
  const MM = String(cst.getUTCMonth() + 1).padStart(2, '0');
  const DD = String(cst.getUTCDate()).padStart(2, '0');
  const hh = String(cst.getUTCHours()).padStart(2, '0');
  const mm = String(cst.getUTCMinutes()).padStart(2, '0');
  return `${MM}-${DD} ${hh}:${mm}`;
};

// R158.109.b — daily axis formatter (1:1 平行 fmtBucketCst, 但只取
// MM-DD). pivotTrendForChart 返 isDaily=true 时, renderChart 用此
// 替 fmtBucketCst. 24h/7d hourly 仍走 fmtBucketCst (R158.53 行为 0 改).
const fmtDateCst = (t) => {
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return '';
  const cstMs = d.getTime() + 8 * 3600 * 1000;
  const cst = new Date(cstMs);
  const MM = String(cst.getUTCMonth() + 1).padStart(2, '0');
  const DD = String(cst.getUTCDate()).padStart(2, '0');
  return `${MM}-${DD}`;
};

function renderChart() {
  if (!chartEl.value || !chartHasData.value) return;
  if (!chartInstance) {
    chartInstance = echarts.init(chartEl.value, null, { renderer: 'canvas' });
    window.addEventListener('resize', onResize);
  }
  // R158.109.b — pivot 返 isDaily, 切 daily / hourly axis formatter.
  const { xs, series, isDaily } = pivotTrendForChart(trendBuckets.value);
  const fmt = isDaily ? fmtDateCst : fmtBucketCst;
  chartInstance.setOption({
    grid: { left: 50, right: 16, top: 40, bottom: 32 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'line' } },
    legend: {
      type: 'scroll',
      top: 4,
      textStyle: { color: 'var(--muted)', fontSize: 11 },
      pageIconColor: 'var(--muted)', pageTextStyle: { color: 'var(--muted)' }
    },
    xAxis: {
      type: 'category',
      data: xs.map(fmt),
      axisLabel: { color: 'var(--muted)', fontSize: 10 },
      axisLine: { lineStyle: { color: 'var(--border)' } }
    },
    yAxis: {
      type: 'value',
      name: '锁定事件数',
      nameTextStyle: { color: 'var(--muted)', fontSize: 11 },
      axisLabel: { color: 'var(--muted)', fontSize: 11 },
      splitLine: { lineStyle: { color: 'var(--border)', type: 'dashed' } },
      // event_count is an integer; clamp to non-negative ints so a
      // quiet hour renders as 0 (not 0.5 due to default float ticks).
      minInterval: 1
    },
    series: series.map((s, i) => {
      const color = SERIES_COLORS[i % SERIES_COLORS.length];
      return {
        name: s.agentId,
        type: 'line',
        data: s.ys,
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
    })
  }, true);
}

const onResize = () => { if (chartInstance) chartInstance.resize(); };

function hexToRgba(hex, alpha) {
  // Helper for the areaStyle gradient stops. Accepts '#rrggbb' only.
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function formatTime(s) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString();
}

function formatSubject(domain, user) {
  // Operator: "主题（谁锁的）" — display as DOMAIN\USER when both
  // present, fall back to whichever is non-empty. Empty → '—'.
  if (domain && user) return `${domain}\\${user}`;
  if (user) return user;
  if (domain) return domain;
  return '—';
}

function clearDc() {
  dcFilter.value = null;
  // Reflect in URL — router.replace so we don't pollute history.
  router.replace({ path: '/lockout-accounts', query: { ...route.query, dc: undefined } });
}

// Caller badge click → deep-link into the admin troubleshoot view with
// caller filter. The admin surface is the right tool for "show me
// every lock this one machine caused"; the 前台 page is just the
// at-a-glance list.
function filterByCaller(caller) {
  router.push({ path: '/lockout-troubleshooting', query: { caller } });
}

// Read URL state on mount (DcCard.vue → /lockout-accounts?dc=HOST).
onMounted(() => {
  const q = route.query;
  if (typeof q.dc === 'string' && q.dc.length > 0) {
    dcFilter.value = q.dc;
  }
  load();
  pollHandle = setInterval(load, POLL_INTERVAL_MS);
  // R158.109.b — 1h refresh of ad_mgmt_retention_days (跟 R158.107
  // retention sweep cadence 1:1 平行, 也跟 R158.108 EventlogView 1:1
  // 平行). 0 改 /api/admin/config 端点.
  loadRetentionDays();
  retentionHandle = setInterval(loadRetentionDays, 60 * 60 * 1000);
});

// React to URL changes from outside (deep-link in same tab, browser
// back/forward). R158.53: when dc changes, re-fetch everything —
// the chart switches between top-5 mode and single-DC mode based
// on the deep-link, so load() must re-run to refetch the trend.
watch(() => route.query.dc, async (newDc) => {
  dcFilter.value = typeof newDc === 'string' && newDc.length > 0 ? newDc : null;
  await load();
});

// R158.53 — re-render chart when buckets change. Covers the case
// where load() resolves after the watch has already fired (e.g.
// initial mount). Mirrors FailedLogonView.vue:273.
watch(trendBuckets, async () => {
  await nextTick();
  renderChart();
});

// R158.109.b — 1h retention refresh 拿新边界, 若 chartRange='all'
// 必重新 fetch chart (R158.108 EventlogView 1:1 平行). 24h/7d
// chartRange 0 影响, 0 重 fetch (跟 loadChart dispatch 1:1 平行).
watch(retentionDays, (newDays, oldDays) => {
  if (newDays === oldDays) return;
  if (chartRange.value === 'all') {
    loadChart();
  }
});

onBeforeUnmount(() => {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = null;
  if (retentionHandle) clearInterval(retentionHandle);
  retentionHandle = null;
  if (chartInstance) {
    window.removeEventListener('resize', onResize);
    chartInstance.dispose();
    chartInstance = null;
  }
});
</script>

<style scoped>
.lockout-accounts-page { padding: 16px 0; }

.page-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
.title-block h1 { margin: 0 0 4px; font-size: 20px; color: var(--accent); }
.subtitle { margin: 0; font-size: 12px; color: var(--muted); max-width: 720px; }
.subtitle code { background: color-mix(in srgb, var(--panel) 50%, transparent); padding: 1px 6px; border-radius: 3px; font-size: 11px; }
.header-actions { display: flex; align-items: center; gap: 12px; }
.since-select { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--muted); }
.since-select select { padding: 4px 8px; background: color-mix(in srgb, var(--panel) 50%, transparent); color: var(--text); border: 1px solid var(--border); border-radius: 3px; font-size: 13px; }
.last-update { font-size: 12px; color: var(--muted); font-family: monospace; }
.refresh-btn { padding: 6px 14px; background: var(--accent); color: var(--sidebar-bg); border: none; border-radius: 3px; cursor: pointer; font-weight: 600; font-size: 13px; }
.refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* R158.53 — chart section (mirrors FailedLogonView.vue .chart-section) */
.chart-section { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-bottom: 16px; }
.chart-canvas { width: 100%; height: 280px; outline: none; }
.skeleton-chart { height: 280px; background: linear-gradient(90deg, var(--panel) 0%, var(--border) 50%, var(--panel) 100%); background-size: 200% 100%; animation: shimmer 1.5s infinite; border-radius: 4px; }

.active-filter {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; margin-bottom: 12px;
  background: color-mix(in srgb, var(--panel) 70%, transparent);
  border: 1px solid var(--border); border-radius: 6px;
  font-size: 13px;
}
.filter-label { color: var(--muted); }
.filter-value { color: var(--accent); font-family: monospace; font-weight: 600; }
.clear-filter { padding: 4px 10px; background: transparent; color: var(--text); border: 1px solid var(--border); border-radius: 3px; cursor: pointer; font-size: 12px; }
.clear-filter:hover { border-color: var(--accent); }
.filter-count { color: var(--muted); font-size: 12px; }

.skeleton { display: flex; flex-direction: column; gap: 8px; }
.skeleton-row { height: 36px; background: linear-gradient(90deg, var(--panel) 0%, var(--border) 50%, var(--panel) 100%); background-size: 200% 100%; animation: shimmer 1.5s infinite; border-radius: 4px; }
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

.error-banner { padding: 16px; background: var(--danger-bg); border-radius: 4px; display: flex; align-items: center; gap: 12px; }
.error-banner button { padding: 4px 12px; background: var(--accent); color: var(--sidebar-bg); border: none; border-radius: 3px; cursor: pointer; font-weight: 600; }

.empty-state { padding: 40px; text-align: center; color: var(--muted); }
.empty-state .link-btn { background: transparent; border: none; color: var(--accent); cursor: pointer; text-decoration: underline; font: inherit; padding: 0; }

.table-wrapper { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.lockout-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.lockout-table thead th {
  padding: 12px 14px; text-align: left;
  background: color-mix(in srgb, var(--panel) 70%, transparent);
  color: var(--muted); font-size: 12px; font-weight: 600;
  border-bottom: 1px solid var(--border); white-space: nowrap;
}
.lockout-table tbody tr { border-bottom: 1px solid var(--border); transition: background-color 80ms ease; }
.lockout-table tbody tr:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
.lockout-table tbody tr:last-child { border-bottom: none; }
.lockout-table tbody td { padding: 10px 14px; vertical-align: middle; }
.target-cell { font-weight: 600; color: var(--text); }
.time-cell { color: var(--muted); font-family: monospace; font-size: 12px; white-space: nowrap; }
.dc-cell { color: var(--text); font-family: monospace; font-size: 12px; white-space: nowrap; }
.subject-cell { color: var(--text); font-family: monospace; font-size: 12px; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* R158.31 (was R139): AD user displayName (target_user_display_name). AD
   often long free-form "姓名 / 部门 / 工号 / 联系方式 / 备注", so cap at
   220px and ellipsize with full text in the cell :title= attribute. */
.display-name-cell { color: var(--muted); font-size: 12px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.caller-cell { max-width: 240px; }
.caller-badge { padding: 2px 10px; background: transparent; border: 1px solid var(--border); border-radius: 10px; font-size: 11px; cursor: pointer; color: var(--text); max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.caller-badge:hover { border-color: var(--accent); }
.muted { color: var(--muted); }

.table-footer { padding: 10px 14px; background: color-mix(in srgb, var(--panel) 70%, transparent); color: var(--muted); font-size: 12px; text-align: right; }

/* R158.109.b — 手写 prev/next + page indicator + pageSize select.
   跟 admin/audit/email-history view 风格统一, 0 引入 element-plus.
   .pagination-btn 跟 .refresh-btn 颜色对比, .pagination-input 数字
   框窄 60px 防越界. */
.pagination-footer {
  display: flex; align-items: center; justify-content: flex-end;
  gap: 10px; flex-wrap: wrap;
}
.pagination-total { font-size: 12px; color: var(--muted); }
.pagination-size {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 12px; color: var(--muted);
}
.pagination-size select {
  padding: 3px 6px;
  background: color-mix(in srgb, var(--panel) 50%, transparent);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 3px;
  font-size: 12px;
  cursor: pointer;
}
.pagination-size select:disabled { opacity: 0.5; cursor: not-allowed; }
.pagination-btn {
  padding: 4px 10px;
  background: transparent;
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 3px;
  font-size: 12px;
  cursor: pointer;
  transition: border-color 80ms ease, background-color 80ms ease;
}
.pagination-btn:hover:not(:disabled) { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
.pagination-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.pagination-jump { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted); }
.pagination-input {
  width: 60px;
  padding: 3px 6px;
  background: color-mix(in srgb, var(--panel) 50%, transparent);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 3px;
  font-size: 12px;
  text-align: center;
  /* hide native spinner for cleaner look (跟 admin/audit view 1:1 平行) */
  -moz-appearance: textfield;
}
.pagination-input::-webkit-outer-spin-button,
.pagination-input::-webkit-inner-spin-button {
  -webkit-appearance: none; margin: 0;
}
.pagination-input:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
