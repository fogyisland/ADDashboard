<!--
  R158.50 (2026-10-06) — 密码错误监控 (FailedLogonView)
  =================================================
  Operator directive: "在前台增加一个功能,统计密码错误次数,同时在包中新建一个
  统计2小时内的输错密码的账户、displayname、认证DC、IP地址 用来写入数据库后,
  在前台dashboard增加一个显示24小时或者7d错误次数走向的图. 然后下面倒序显示
  最近输错的信息, 每两个小时执行一次".

  Top: ECharts line chart of password-error counts over a toggle-able
       24h / 7d window (hourly bucket). Toggle re-fetches the same
       /api/failed-logon/timeseries endpoint with sinceHours=24 or 168.
  Bottom: Reverse-chronological detail table (newest first). Same
       shape as LockoutAccountsView but with 4625-specific columns
       (target_user_name, display_name, dc, ip_address, workstation,
       logon_type, failure_reason).

  Polling: 30s matches OsBaselineView / LockoutAccountsView / EventlogView.
  Auth tier: userAuth ONLY (no admin perm gate) — same access tier as
  /lockout-accounts / /eventlog / /os-baseline.

  Data source: ad_failed_logon_events public table, populated every
  2h by the agent-side ad_failed_logon_collector (intervalSec=7200)
  collect.ps1 + centre-side runner.js post-hook (MERGE ON
  (dc_name, event_record_id)).
-->
<template>
  <AppLayout>
    <div class="failed-logon-page">
      <header class="page-header">
        <div class="title-block">
          <h1>密码错误监控</h1>
          <p class="subtitle">
            安全事件 4625 (账户登录失败) · 数据来源:
            <code>ad_failed_logon_events</code> 表 · 每 1800 秒 (30 分钟) 由
            <code>ad_failed_logon_collector</code> 包写入 · 折线图支持 24 小时 / 7 天 / 全部 切换
          </p>
        </div>
        <div class="header-actions">
          <div class="range-toggle" role="tablist" aria-label="时间范围">
            <button
              :class="{ active: chartWindow === '24h' }"
              role="tab"
              :aria-selected="chartWindow === '24h'"
              @click="setChartWindow('24h')"
              data-test="window-24h"
            >24h</button>
            <button
              :class="{ active: chartWindow === '7d' }"
              role="tab"
              :aria-selected="chartWindow === '7d'"
              @click="setChartWindow('7d')"
              data-test="window-7d"
            >7d</button>
            <!-- R158.109 — 24h/7d/全部 toggle 第 3 按钮, 1:1 平行 R158.108
                 EventlogView.vue:58-64 "全部" 按钮. "全部" 走 ad_mgmt_retention_days
                 (R158.107 retention 边界, 默认 30d). -->
            <button
              :class="{ active: chartWindow === 'all' }"
              role="tab"
              :aria-selected="chartWindow === 'all'"
              @click="setChartWindow('all')"
              data-test="window-all"
            >全部</button>
          </div>
          <!-- R158.55 — groupBy toggle (按账户 / 按锁定服务器). Sits
               adjacent to the 24h/7d range toggle since both are
               view-shape dimensions of the same chart.
               R158.57 — added "按认证 DC" option so the operator can
               spot which DC is producing the most 4625s.
               R158.60 (2026-10-09) — default active state = 'account'
               (was briefly flipped to 'dc' in R158.59, then reverted
               on operator feedback). DC dimension is exposed via the
               always-on mini-bar panel next to the chart (see
               dc-mini-bar section below), so the operator gets DC
               signal without losing the account detail table. The
               '按认证 DC' toggle still exists for the full multi-series
               24h trend chart. -->
          <div class="range-toggle" role="tablist" aria-label="归类维度">
            <button
              :class="{ active: groupBy === 'account' }"
              role="tab"
              :aria-selected="groupBy === 'account'"
              @click="setGroupBy('account')"
              data-test="group-account"
            >按账户</button>
            <button
              :class="{ active: groupBy === 'workstation' }"
              role="tab"
              :aria-selected="groupBy === 'workstation'"
              @click="setGroupBy('workstation')"
              data-test="group-workstation"
            >按锁定服务器</button>
            <button
              :class="{ active: groupBy === 'dc' }"
              role="tab"
              :aria-selected="groupBy === 'dc'"
              @click="setGroupBy('dc')"
              data-test="group-dc"
            >按认证 DC</button>
          </div>
          <span v-if="lastUpdated" class="last-update">最后更新：{{ formatTime(lastUpdated) }}</span>
          <button class="refresh-btn" :disabled="loading" @click="loadAll" data-test="refresh">刷新</button>
        </div>
      </header>

      <!-- 顶部 ECharts 折线图 -->
      <section class="chart-section">
        <!--
          R158.57 (2026-10-09) — bug fix: hasChartedOnce guards the
          skeleton/empty-state branches so the chart <div ref="chartEl">
          is never unmounted after the first successful paint. Pre-fix,
          the v-if/v-else-if chain tore down chartEl every time the
          operator toggled groupBy (or windowHours), causing a brief
          skeleton flash and an orphaned chartInstance bound to a
          detached canvas. First-paint UX is preserved because
          hasChartedOnce is false on mount.
        -->
        <div v-if="loading && !chartHasData && !hasChartedOnce" class="skeleton skeleton-chart"></div>
        <div v-else-if="error" class="error-banner">
          <span>加载图表失败</span>
          <button @click="loadAll">重试</button>
        </div>
        <div v-else-if="!chartHasData && !hasChartedOnce" class="empty-state">
          暂无密码错误事件 — 等待 {{ chartWindow === '24h' ? '24h' : (chartWindow === '7d' ? '7d' : `${retentionDays}d`) }} 内各 DC 收集器首次上报
        </div>
        <div v-else ref="chartEl" class="chart-canvas" data-test="failed-logon-chart"></div>
      </section>

      <!--
        R158.60 (2026-10-09) — 始终可见的 DC mini-bar 排行榜.
        operator 反馈 "应该和锁定账户信息一样" 但又选择保留 default=按账户,
        解法是把 DC 维度 **叠加** 到 default 界面而不是替换 — 顶部折线
        图旁 (下方) 永久显示一个 top-5 DC 横条, 不论 groupBy 切到
        account/workstation/dc 哪个都可见. operator 一眼看到 "哪台 DC
        4625 最多 + 总额" 不需要切 toggle. 数据源 = /api/failed-logon/
        by-dc?topN=5 (R158.57 ship 的 SQL/service/route 链路全在, 这里
        复用).

        复用 .ws-summary-row 样式 (mini 横条 + count + pct) 跟
        workstation/dc 模式视觉一致 — 同一套 chrome, 零新增 CSS 类.
      -->
      <section class="dc-mini-bar-section" data-test="dc-mini-bar">
        <header class="dc-mini-bar-header">
          <span class="dc-mini-bar-title">认证 DC 贡献 Top 5</span>
          <span class="dc-mini-bar-meta">最近 {{ chartWindow === '24h' ? '24 小时' : (chartWindow === '7d' ? '7 天' : `全部 (${retentionDays} 天)`) }} · 共 {{ dcMiniTotal }} 次</span>
        </header>

        <div v-if="loading && dcMini.length === 0" class="dc-mini-bar-skeleton">
          <div v-for="i in 5" :key="i" class="dc-mini-bar-skeleton-row"></div>
        </div>

        <div v-else-if="dcMini.length === 0" class="dc-mini-bar-empty">
          等待各 DC 收集器首次上报
        </div>

        <div v-else class="dc-mini-bar-list">
          <div v-for="d in dcMini" :key="d.dcName" class="dc-mini-bar-row" :data-test="`dc-mini-row-${d.dcName}`">
            <span class="dc-mini-bar-name" :title="d.dcName">{{ d.dcName }}</span>
            <span class="dc-mini-bar-track">
              <span class="dc-mini-bar-fill" :style="{ width: dcMiniTotal ? ((d.eventCount / dcMiniTotal) * 100).toFixed(1) + '%' : '0%' }"></span>
            </span>
            <span class="dc-mini-bar-count">{{ d.eventCount }}</span>
            <span class="dc-mini-bar-pct">{{ dcMiniTotal ? ((d.eventCount / dcMiniTotal) * 100).toFixed(1) : '0.0' }}%</span>
          </div>
        </div>
      </section>

      <!-- 底部: account 模式明细表 / workstation 模式 top-N 聚合卡片 -->
      <section v-if="groupBy === 'account'" class="events-table-section">
        <div v-if="loading && rows.length === 0" class="skeleton">
          <div v-for="i in 5" :key="i" class="skeleton-row"></div>
        </div>

        <div v-else-if="rows.length === 0" class="empty-state">
          暂无密码错误事件 — 等待各 DC 收集器首次上报
        </div>

        <div v-else class="table-wrapper">
          <table class="failed-logon-table" data-test="failed-logon-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>账户</th>
                <th>显示名</th>
                <th>认证 DC</th>
                <th>客户端 IP</th>
                <th>工作站</th>
                <th>登录类型</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(ev, i) in rows" :key="`${ev.eventRecordId || ''}-${ev.occurredAt}-${i}`">
                <td class="time-cell">{{ formatTime(ev.occurredAt) }}</td>
                <td class="target-cell" :title="ev.targetUserName">{{ ev.targetUserName || '—' }}</td>
                <td class="display-name-cell" :title="ev.targetUserDisplayName">
                  {{ ev.targetUserDisplayName || '—' }}
                </td>
                <td class="dc-cell" :title="ev.dcName">{{ ev.dcName || '—' }}</td>
                <td class="ip-cell" :title="ev.ipAddress">{{ ev.ipAddress || '—' }}</td>
                <td class="ws-cell" :title="ev.workstationName">{{ ev.workstationName || '—' }}</td>
                <td class="logon-type-cell">{{ formatLogonType(ev.logonType) }}</td>
                <td class="reason-cell" :title="ev.failureReason">{{ ev.failureReason || ev.status || '—' }}</td>
              </tr>
            </tbody>
          </table>
          <footer class="table-footer">
            共 {{ rows.length }} 条 · 最近 {{ chartWindow === '24h' ? '24 小时' : (chartWindow === '7d' ? '7 天' : `全部 (${retentionDays} 天)`) }}
          </footer>
        </div>
      </section>

      <!-- R158.55 — workstation 模式: 隐藏明细表, 显示 top-N 聚合卡片.
           工作站是 4625 攻击源头维度, 操作者要的是"哪几台机器在爆"
           而不是"哪几个账户被试"; 100 行倒序表在聚合语境下无信号,
           改显 top-5 workstation 命中数 + 占比.
           R158.57 (2026-10-09) — workstation 改成 v-else-if + 新增
           dc 段也是 v-else-if, 跟 account v-if 形成完整三态链. -->
      <section v-else-if="groupBy === 'workstation'" class="ws-summary-section" data-test="ws-summary">
        <div v-if="loading && wsAggregate.length === 0" class="skeleton">
          <div v-for="i in 5" :key="i" class="skeleton-row"></div>
        </div>

        <div v-else-if="wsAggregate.length === 0" class="empty-state">
          暂无按锁定服务器归类的事件 — 等待各工作站首次上报
        </div>

        <div v-else class="ws-summary">
          <header class="ws-summary-header">
            Top {{ wsAggregate.length }} 锁定服务器 · 共 {{ wsTotalCount }} 次失败尝试 · 最近 {{ chartWindow === '24h' ? '24 小时' : (chartWindow === '7d' ? '7 天' : `全部 (${retentionDays} 天)`) }}
          </header>
          <div class="ws-summary-list">
            <div v-for="ws in wsAggregate" :key="ws.workstationName" class="ws-summary-row" :data-test="`ws-row-${ws.workstationName}`">
              <span class="ws-summary-name" :title="ws.workstationName">{{ ws.workstationName }}</span>
              <span class="ws-summary-count">{{ ws.eventCount }}</span>
              <span class="ws-summary-pct">{{ wsTotalCount ? ((ws.eventCount / wsTotalCount) * 100).toFixed(1) : '0.0' }}%</span>
            </div>
          </div>
        </div>
      </section>

      <!--
        R158.57 (2026-10-09) — DC 模式: 复用 .ws-summary 模板, 字段名
        换 dcName. 复用 chrome(panel/border/grid) + 复用样式,纯改名
        不引新 CSS,跟 workstation 模式视觉一致.
      -->
      <section v-else-if="groupBy === 'dc'" class="ws-summary-section" data-test="dc-summary">
        <div v-if="loading && dcAggregate.length === 0" class="skeleton">
          <div v-for="i in 5" :key="i" class="skeleton-row"></div>
        </div>

        <div v-else-if="dcAggregate.length === 0" class="empty-state">
          暂无按认证 DC 归类的事件 — 等待各 DC 收集器首次上报
        </div>

        <div v-else class="ws-summary">
          <header class="ws-summary-header">
            Top {{ dcAggregate.length }} 认证 DC · 共 {{ dcTotalCount }} 次失败尝试 · 最近 {{ chartWindow === '24h' ? '24 小时' : (chartWindow === '7d' ? '7 天' : `全部 (${retentionDays} 天)`) }}
          </header>
          <div class="ws-summary-list">
            <div v-for="d in dcAggregate" :key="d.dcName" class="ws-summary-row" :data-test="`dc-row-${d.dcName}`">
              <span class="ws-summary-name" :title="d.dcName">{{ d.dcName }}</span>
              <span class="ws-summary-count">{{ d.eventCount }}</span>
              <span class="ws-summary-pct">{{ dcTotalCount ? ((d.eventCount / dcTotalCount) * 100).toFixed(1) : '0.0' }}%</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  </AppLayout>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import * as echarts from 'echarts';
import AppLayout from '../components/AppLayout.vue';
import {
  fetchFailedLogonTimeseries,
  fetchFailedLogonTrend,                // R158.109 — 24h/7d/全部 toggle 参数化
  fetchFailedLogonRecent,
  fetchFailedLogonByWorkstation,
  fetchFailedLogonTimeseriesByWorkstation,
  fetchFailedLogonByDc,                  // R158.57
  fetchFailedLogonTimeseriesByDc         // R158.57
} from '../api/failed-logon.js';

const POLL_INTERVAL_MS = 30 * 1000;

// R158.50 (2026-10-06) — failed-logon-2h dashboard 24h/7d toggle state.
// R158.109 (2026-10-16) — 升维 24h/7d/全部. 24h 走 hourly (R158.50 行为 1:1
// 保留), 7d/全部 走 daily (R158.108 eventlog 范式). 'all' 走 retentionDays
// (R158.107 ad_mgmt_retention_days, 0=永久 → 365 cap).
const windowHours = ref(24);          // 24 or 168 (7d) — R158.50 行为 0 改, 内部 helpers 引用
const chartWindow = ref('24h');       // R158.109 — '24h' | '7d' | 'all', 1:1 平行 R158.108 EventlogView
const DAILY_MAX_DAYS = 365;           // 跟 sql.js failedLogon.dailyAggregate 1:1 平行
const retentionDays = ref(30);        // R158.109 — "全部" 边界 (R158.107 retention)
async function loadRetentionDays() {
  try {
    const r = await api.get('/api/admin/config');
    const v = Number(r?.data?.ad_mgmt_retention_days ?? 30);
    retentionDays.value = v > 0 ? Math.min(v, DAILY_MAX_DAYS) : DAILY_MAX_DAYS;
  } catch (e) {
    // best-effort, 默认 30
  }
}
const chartEl = ref(null);
let chartInstance = null;
let pollHandle = null;
let retentionHandle = null;  // R158.109 — 1h refresh of ad_mgmt_retention_days

const rows = ref([]);                 // reverse-chrono detail rows (account mode)
const buckets = ref([]);              // hourly buckets for the line chart (account mode)
const loading = ref(false);
const error = ref(false);
const lastUpdated = ref(null);

// R158.55 — groupBy state (按账户 / 按锁定服务器). Default 'account'
// preserves the existing flow on first paint. Switching drives a full
// loadAll() so chart + bottom-section switch together.
// R158.57 (2026-10-09) — added 'dc' as a third option so the operator
// can spot which DC is producing the most 4625s.
// R158.60 (2026-10-09) — revert R158.59 default flip. operator chose
// to keep default = 'account' (单线 amber 折线 + 倒序表), 并把 DC
// 维度作为 **始终可见** 的 mini-bar 排行榜加到 chart 旁. '按认证
// DC' toggle 仍保留 (R158.57 的多 series 折线功能不丢), 但不再
// 是 default. 这一次是把 DC 信号 **叠加** 到 default 界面, 不是
// **替换** default 界面.
const groupBy     = ref('account');   // 'account' | 'workstation' | 'dc'
const wsAggregate = ref([]);         // top-N rows for the workstation summary card
const wsBuckets   = ref([]);         // flat trend rows for the workstation chart
const dcAggregate = ref([]);         // R158.57 — top-N rows for the DC summary card
const dcBuckets   = ref([]);         // R158.57 — flat trend rows for the DC chart
// R158.60 (2026-10-09) — always-on DC mini-bar ranking panel, sits
// next to the chart regardless of groupBy. Reuses /by-dc top-5 SQL
// (R158.57) but driven by a separate ref so it never collides with
// the dc-mode full-panel state.
const dcMini      = ref([]);
const chartHours  = ref(24);         // tracks windowHours so pivot knows axis length
// R158.57 bug fix — Stays true once the chart has painted at least
// once in this view's lifetime. Used by the template so dimension
// toggles (account ↔ workstation ↔ dc) don't tear down the chart
// canvas and flash a skeleton. First paint still gets the
// skeleton/empty-state because hasChartedOnce is false until
// renderChart succeeds the first time.
const hasChartedOnce = ref(false);

const chartHasData = computed(() =>
  groupBy.value === 'account'
    ? (Array.isArray(buckets.value)   && buckets.value.length   > 0)
    : groupBy.value === 'workstation'
    ? (Array.isArray(wsBuckets.value) && wsBuckets.value.length > 0)
    : (Array.isArray(dcBuckets.value) && dcBuckets.value.length > 0)
);
const wsTotalCount = computed(() =>
  wsAggregate.value.reduce((acc, w) => acc + (Number(w.eventCount) || 0), 0)
);
// R158.57 — same shape as wsTotalCount, for the DC summary card.
const dcTotalCount = computed(() =>
  dcAggregate.value.reduce((acc, d) => acc + (Number(d.eventCount) || 0), 0)
);
// R158.60 (2026-10-09) — total eventCount for the always-on DC
// mini-bar panel. Recomputes only when dcMini changes, so the
// mini-bar list re-renders the fill bar widths in lockstep with
// the data fetch.
const dcMiniTotal = computed(() =>
  dcMini.value.reduce((acc, d) => acc + (Number(d.eventCount) || 0), 0)
);

// R158.50 — CST time formatter (UTC +8). Mirrors OsBaselineView.vue:308
// (R158.29) + DashboardView (R158.7) so every chart on the dashboard
// uses the same Beijing-time axis. Deterministic regardless of browser
// TZ (R158.7 lesson: toLocaleString breaks under cross-region operator).
const fmtTsCst = (t) => {
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return '';
  const cstH = (d.getUTCHours() + 8) % 24;
  const cstM = d.getUTCMinutes();
  return `${String(cstH).padStart(2, '0')}:${String(cstM).padStart(2, '0')}`;
};

// R158.60.2 (2026-10-09) — full datetime with **ms precision** in CST,
// used by the reverse-chronological detail table's "时间" column. The
// previous formatTime() called toLocaleString() which drops ms — so 3
// same-second 4625 events from a single failed logon (Windows writes
// 2~5 sub-events per attempt with ms-level timestamp deltas: 01:57:29.370
// / .384 / .399) all rendered as "09:57:29" → operator reads as "3
// duplicates of the same row". Reality: 3 distinct event_record_id,
// 3 distinct occurred_at, 1 failed logon attempt.
//
// DB column is datetime2(3) (sql.js ad_failed_logon_events R158.50
// schema), so the centre already preserves ms end-to-end — we just
// weren't rendering it. Mirrors fmtBucketCst's UTC+8 deterministic
// approach (R158.7 lesson: toLocaleString breaks under cross-region
// operator TZ).
const fmtTsCstMs = (t) => {
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return '';
  const cstMs = d.getTime() + 8 * 3600_000;
  const cst = new Date(cstMs);
  const MM = String(cst.getUTCMonth() + 1).padStart(2, '0');
  const DD = String(cst.getUTCDate()).padStart(2, '0');
  const hh = String(cst.getUTCHours()).padStart(2, '0');
  const mm = String(cst.getUTCMinutes()).padStart(2, '0');
  const ss = String(cst.getUTCSeconds()).padStart(2, '0');
  const mmm = String(cst.getUTCMilliseconds()).padStart(3, '0');
  return `${MM}-${DD} ${hh}:${mm}:${ss}.${mmm}`;
};

const fmtBucketCst = (t) => {
  // bucketStart is a UTC timestamp rounded to the hour. Render as
  // MM-DD hh:mm in CST so 24h view (24 buckets) and 7d view (168
  // buckets) both stay legible. Mirrors OsBaselineView's date axis.
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

// 4625 LogonType values (per Microsoft docs). Mirror the field at the
// edge of the UI so the table stays readable for non-AD-experts.
const LOGON_TYPE_LABELS = {
  2:  'Interactive',
  3:  'Network',
  4:  'Batch',
  5:  'Service',
  7:  'Unlock',
  8:  'NetworkCleartext',
  9:  'NewCredentials',
  10: 'RemoteInteractive',
  11: 'CachedInteractive'
};

function formatLogonType(n) {
  if (n == null) return '—';
  const v = Number(n);
  return LOGON_TYPE_LABELS[v] || `#${v}`;
}

function formatTime(s) {
  if (!s) return '—';
  // R158.60.2 — use the ms-precision CST formatter instead of
  // toLocaleString() so 3 same-second 4625 sub-events show as
  // 09:57:29.370 / .384 / .399 instead of all "09:57:29". Pass
  // through the original string if Date parsing fails so the UI
  // never shows "Invalid Date" — operator can still read the raw
  // wire shape in that case.
  return fmtTsCstMs(s);
}

async function loadAll() {
  loading.value = true;
  error.value = false;
  // R158.109 — chartHours 升维 grain-aware. 24h 走 hourly (24 point),
  // 7d/全部 走 daily (7/30 point). 跟 R158.108 EventlogView pivotTrendForChart 1:1 平行.
  const isDaily = chartWindow.value !== '24h';
  const dailyCount = chartWindow.value === '7d' ? 7 : retentionDays.value;
  chartHours.value = isDaily ? dailyCount : 24;
  // R158.60 (2026-10-09) — always fetch /by-dc for the always-on DC
  // mini-bar panel, regardless of groupBy. Run alongside the
  // groupBy-specific fetch but isolate failure (Promise.allSettled) —
  // a transient /by-dc 500 should NOT fail the main chart load and
  // flip the whole page into the error banner.
  const miniPromise = fetchFailedLogonByDc({ sinceHours: windowHours.value, topN: 5 })
    .then((r) => { dcMini.value = Array.isArray(r.data) ? r.data : []; })
    .catch(() => { /* keep last-known dcMini; mini-bar shows stale rather than fail-whole-page */ });
  try {
    if (groupBy.value === 'workstation') {
      // R158.55 — parallel fetch /by-workstation + /timeseries-by-workstation.
      // Both endpoints are independent so Promise.all keeps the round-trip
      // at the slower of the two. topN=5 matches the dashboard's
      // one-screen-visible-series budget.
      const [aggRes, tsRes] = await Promise.all([
        fetchFailedLogonByWorkstation({ sinceHours: windowHours.value, topN: 5 }),
        fetchFailedLogonTimeseriesByWorkstation({ windowHours: windowHours.value, topN: 5 })
      ]);
      wsAggregate.value = Array.isArray(aggRes.data) ? aggRes.data : [];
      wsBuckets.value   = Array.isArray(tsRes.data)   ? tsRes.data   : [];
    } else if (groupBy.value === 'dc') {
      // R158.57 (2026-10-09) — "按认证 DC" mode. Same shape as
      // workstation but keys are dcName instead of workstationName.
      // Helps the operator spot which DC is producing the most 4625s.
      const [aggRes, tsRes] = await Promise.all([
        fetchFailedLogonByDc({ sinceHours: windowHours.value, topN: 5 }),
        fetchFailedLogonTimeseriesByDc({ windowHours: windowHours.value, topN: 5 })
      ]);
      dcAggregate.value = Array.isArray(aggRes.data) ? aggRes.data : [];
      dcBuckets.value   = Array.isArray(tsRes.data)   ? tsRes.data   : [];
    } else {
      // R158.109 — chart wire 改 fetchFailedLogonTrendForWindow (1:1 平行 R158.108
      // EventlogView fetchEventlogTrendForWindow). 24h 走 hourly, 7d/全部 走 daily.
      const [tsRes, recentRes] = await Promise.all([
        fetchFailedLogonTrendForWindow(),
        fetchFailedLogonRecent({ sinceHours: windowHours.value, limit: 100 })
      ]);
      buckets.value = Array.isArray(tsRes.data) ? tsRes.data : [];
      rows.value    = Array.isArray(recentRes.data) ? recentRes.data : [];
    }
    await miniPromise;       // R158.60 — wait for the always-on mini-bar fetch to settle
    lastUpdated.value = new Date();
    await nextTick();
    renderChart();
  } catch (e) {
    error.value = true;
  } finally {
    loading.value = false;
  }
}

// R158.55 — workstation-mode chart option (multi-series line).
// Mirrors LockoutAccountsView.vue:315-371 (R158.53) verbatim with
// `agentId` → `workstationName` rename. SERIES_COLORS is a fixed 8
// palette indexed by sorted-key order so reload stability is
// deterministic (unlike lockout which sorts by current COUNT and
// shifts palette).
// R158.57 (2026-10-09) — added `keyName` arg so the same chart
// builder is reused for DC mode (keyName='dcName') without
// duplicating the ECharts option shape. Default 'workstationName'
// preserves the R158.55 call site.
function workstationChartOption(flat, keyName = 'workstationName') {
  const { xs, series } = pivotTrendForChart(flat, keyName);
  return {
    grid: { left: 60, right: 16, top: 40, bottom: 32 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'line' } },
    legend: {
      type: 'scroll', top: 4,
      textStyle: { color: 'var(--muted)', fontSize: 11 },
      pageIconColor: 'var(--muted)', pageTextStyle: { color: 'var(--muted)' }
    },
    xAxis: {
      type: 'category',
      data: xs.map(fmtBucketCst),
      axisLabel: { color: 'var(--muted)', fontSize: 10 },
      axisLine: { lineStyle: { color: 'var(--border)' } }
    },
    yAxis: {
      type: 'value', name: '次数',
      nameTextStyle: { color: 'var(--muted)', fontSize: 11 },
      axisLabel: { color: 'var(--muted)', fontSize: 11 },
      splitLine: { lineStyle: { color: 'var(--border)', type: 'dashed' } },
      minInterval: 1
    },
    series: series.map((s, idx) => {
      const color = SERIES_COLORS[idx % SERIES_COLORS.length];
      return {
        name: s.name, type: 'line', data: s.ys,
        smooth: true, symbol: 'circle', symbolSize: 4,
        lineStyle: { color, width: 2 }, itemStyle: { color },
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
  };
}

// R158.55 — account-mode chart option (single amber series, unchanged
// from R158.50 ship). Extracted to keep renderChart() short and
// diff-friendly for review.
function accountChartOption() {
  const xs = buckets.value.map((b) => b.bucketStart);
  const ys = buckets.value.map((b) => b.count);
  return {
    grid: { left: 50, right: 16, top: 32, bottom: 32 },
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      data: xs.map(fmtBucketCst),
      axisLabel: { color: 'var(--muted)', fontSize: 10 },
      axisLine: { lineStyle: { color: 'var(--border)' } }
    },
    yAxis: {
      type: 'value',
      name: '次数',
      nameTextStyle: { color: 'var(--muted)', fontSize: 11 },
      axisLabel: { color: 'var(--muted)', fontSize: 11 },
      splitLine: { lineStyle: { color: 'var(--border)', type: 'dashed' } }
    },
    series: [{
      type: 'line',
      data: ys,
      smooth: true,
      symbol: 'circle',
      symbolSize: 4,
      lineStyle: { color: '#f59e0b', width: 2 },
      itemStyle: { color: '#f59e0b' },
      areaStyle: {
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(245, 158, 11, 0.4)' },
            { offset: 1, color: 'rgba(245, 158, 11, 0.02)' }
          ]
        }
      }
    }]
  };
}

function renderChart() {
  if (!chartEl.value || !chartHasData.value) return;
  // R158.57 (2026-10-09) bug fix — defensive re-init: if the cached
  // chartInstance is no longer attached to the current chartEl node
  // (e.g. Vue tore down + re-mounted the div, or ECharts internally
  // disposed on detach), build a fresh one. Without this, setOption
  // would write to a chart bound to a detached canvas, leaving the
  // visible <div> empty. Belt-and-braces — the hasChartedOnce template
  // guard already prevents the most common tear-down, but this
  // covers future template shape changes and ECharts auto-dispose
  // heuristics.
  if (chartInstance && chartInstance.getDom() !== chartEl.value) {
    window.removeEventListener('resize', onResize);
    chartInstance.dispose();
    chartInstance = null;
  }
  if (!chartInstance) {
    chartInstance = echarts.init(chartEl.value, null, { renderer: 'canvas' });
    window.addEventListener('resize', onResize);
  }
  const option = groupBy.value === 'workstation'
    ? workstationChartOption(wsBuckets.value)
    : groupBy.value === 'dc'
    ? workstationChartOption(dcBuckets.value, 'dcName')   // R158.57 — same shape, dcName key
    : accountChartOption();
  chartInstance.setOption(option, true);
  hasChartedOnce.value = true;                             // R158.57 — template guard
}

// R158.55 — pivot flat [{<keyName>,bucketStart,eventCount}]
// rows → ECharts series shape. 0-fills missing hours per key so
// each series has exactly chartHours points (24 or 168). Sorted by
// key name so palette order is stable across reloads.
// Mirrors LockoutAccountsView.vue:261-283 (R158.53). Hoist into a
// shared util later if a third view needs it.
// R158.57 (2026-10-09) — added `keyName` arg so the same pivot is
// reused for DC mode (keyName='dcName'). Default 'workstationName'
// preserves the R158.55 call site signature.
// R158.109 (2026-10-16) — grain-aware pivot (1:1 平行 R158.108 EventlogView
// pivotTrendForChart). 24h 走 hourly (3600_000ms bucket), 7d/全部 走 daily
// (86400_000ms bucket). accountChartOption 0 改 (它直接读 buckets.value
// 已经是 pivot 后形状), workstationChartOption 用 pivot 函数.
function pivotTrendForChart(flat, keyName = 'workstationName') {
  const isDaily = chartWindow.value !== '24h';
  const bucketCount = isDaily
    ? (chartWindow.value === '7d' ? 7 : retentionDays.value)
    : chartHours.value;
  const bucketMs = isDaily ? 86400_000 : 3600_000;
  const now = new Date();
  const endBucket = isDaily
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), 0, 0, 0));
  const xs = [];
  for (let i = bucketCount - 1; i >= 0; i--) {
    xs.push(new Date(endBucket.getTime() - i * bucketMs));
  }
  const byKey = new Map();
  for (const r of flat) {
    const k = r[keyName];
    if (!byKey.has(k)) byKey.set(k, new Map());
    byKey.get(k).set(new Date(r.bucketStart).getTime(), r.eventCount);
  }
  const keys = [...byKey.keys()].sort();
  const series = keys.map((k) => {
    const hourMap = byKey.get(k);
    const ys = xs.map((h) => hourMap.get(h.getTime()) ?? 0);
    return { name: k, ys };
  });
  return { xs, series };
}

const SERIES_COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6',
                       '#06b6d4', '#ec4899', '#84cc16'];

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const onResize = () => { if (chartInstance) chartInstance.resize(); };

function setWindow(h) {
  if (windowHours.value === h) return;
  windowHours.value = h;
  loadAll();
}

// R158.55 — groupBy toggle (按账户 / 按锁定服务器). Mirrors setWindow
// shape: short-circuit on no-op, otherwise mutate groupBy + re-fetch.
// groupBy change does NOT reset windowHours (operator can flip 24h/7d
// in either mode and the active dimension stays).
function setGroupBy(g) {
  if (groupBy.value === g) return;
  groupBy.value = g;
  loadAll();
}

// R158.109 (2026-10-16) — 24h/7d/全部 toggle (1:1 平行 R158.108 EventlogView
// setChartWindow). chartWindow 控制 24h 走 hourly / 7d+全部 走 daily.
// 0 改 windowHours (其它 caller 仍 24/168, e.g. fetchFailedLogonRecent sinceHours).
function setChartWindow(w) {
  if (chartWindow.value === w) return;
  chartWindow.value = w;
  loadAll();
}

// R158.109 — chart 趋势 fetch dispatch helper (1:1 平行 EventlogView
// R158.X.99.36 (2026-10-20) — 24h/7d/全部 升维 bucket 粒度 (操作员 directive
// "密码错误监控也按照这种方式进行操作" + "时间是事件触发时间" 1:1 平行
// routes/lockout.js bucket 派发 + EventlogView.fetchEventlogTrendForWindow +
// R158.X.99.35 LockoutAccountsView 范式). 24h → bucket5m (288 段), 7d →
// bucket4h (42 段), 全部 → daily (retentionDays 段, R158.107 boundary).
// accountChartOption 0 改 (route 返 { bucketStart, count } 已经是 axis-ready
// 形状, 直接读 buckets.value). workstation/dc 模式 0 改 (operator AskUserQuestion
// 2026-10-20 已确认只改 account 默认模式). pivotTrendForChart / chartHours /
// loadAll 0 触. bucket 边界走 occurred_at (事件触发时间, 操作员 directive 1:1
// 平行 lockout R158.X.99.35). lesson 125/126/127 (account mode = single series
// global count; route reshape 提前 pivot; bucket 维度走 occurred_at 事件触发时间).
async function fetchFailedLogonTrendForWindow() {
  if (chartWindow.value === '24h') {
    return fetchFailedLogonTrend({ windowHours: 24, grain: 'bucket5m' });
  } else if (chartWindow.value === '7d') {
    return fetchFailedLogonTrend({ days: 7, grain: 'bucket4h' });
  } else { // 'all'
    return fetchFailedLogonTrend({ days: retentionDays.value, grain: 'daily' });
  }
}

// Re-render the chart on data changes — account buckets, workstation
// buckets, and DC buckets refs all drive renderChart through the
// chartHasData branching. Watch all three so any toggle (account ↔
// workstation ↔ dc) doesn't need to wait for the next 30s poll before
// the chart updates.
watch([buckets, wsBuckets, dcBuckets], async () => {
  await nextTick();
  renderChart();
});

onMounted(() => {
  loadAll();
  pollHandle = setInterval(loadAll, POLL_INTERVAL_MS);
  // R158.109 (2026-10-16) — 1h refresh of ad_mgmt_retention_days (跟 R158.107
  // retention sweep cadence 1:1 平行, 也跟 R158.108 EventlogView onMounted
  // 1:1 平行). 0 改 /api/admin/config 端点.
  loadRetentionDays();
  retentionHandle = setInterval(loadRetentionDays, 60 * 60 * 1000);
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
.failed-logon-page { padding: 16px 0; }

.page-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
.title-block h1 { margin: 0 0 4px; font-size: 20px; color: var(--accent); }
.subtitle { margin: 0; font-size: 12px; color: var(--muted); max-width: 720px; }
.subtitle code { background: color-mix(in srgb, var(--panel) 50%, transparent); padding: 1px 6px; border-radius: 3px; font-size: 11px; }
.header-actions { display: flex; align-items: center; gap: 12px; }
.last-update { font-size: 12px; color: var(--muted); font-family: monospace; }
.refresh-btn { padding: 6px 14px; background: var(--accent); color: var(--sidebar-bg); border: none; border-radius: 3px; cursor: pointer; font-weight: 600; font-size: 13px; }
.refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.range-toggle {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
}
.range-toggle button {
  padding: 6px 14px;
  background: transparent;
  color: var(--text);
  border: none;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  font-family: monospace;
}
.range-toggle button + button { border-left: 1px solid var(--border); }
.range-toggle button.active { background: var(--accent); color: var(--sidebar-bg); }
.range-toggle button:hover:not(.active) { background: color-mix(in srgb, var(--accent) 12%, transparent); }

/* Chart section */
.chart-section { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-bottom: 16px; }
.chart-canvas { width: 100%; height: 280px; outline: none; }
.skeleton-chart { height: 280px; background: linear-gradient(90deg, var(--panel) 0%, var(--border) 50%, var(--panel) 100%); background-size: 200% 100%; animation: shimmer 1.5s infinite; border-radius: 4px; }
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

.error-banner { padding: 16px; background: var(--danger-bg); border-radius: 4px; display: flex; align-items: center; gap: 12px; }
.error-banner button { padding: 4px 12px; background: var(--accent); color: var(--sidebar-bg); border: none; border-radius: 3px; cursor: pointer; font-weight: 600; }

.empty-state { padding: 40px; text-align: center; color: var(--muted); }

/* Events table */
.events-table-section { margin-top: 8px; }
.skeleton { display: flex; flex-direction: column; gap: 8px; }
.skeleton-row { height: 36px; background: linear-gradient(90deg, var(--panel) 0%, var(--border) 50%, var(--panel) 100%); background-size: 200% 100%; animation: shimmer 1.5s infinite; border-radius: 4px; }

.table-wrapper { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.failed-logon-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.failed-logon-table thead th {
  padding: 12px 14px; text-align: left;
  background: color-mix(in srgb, var(--panel) 70%, transparent);
  color: var(--muted); font-size: 12px; font-weight: 600;
  border-bottom: 1px solid var(--border); white-space: nowrap;
}
.failed-logon-table tbody tr { border-bottom: 1px solid var(--border); transition: background-color 80ms ease; }
.failed-logon-table tbody tr:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
.failed-logon-table tbody tr:last-child { border-bottom: none; }
.failed-logon-table tbody td { padding: 10px 14px; vertical-align: middle; }

.time-cell { color: var(--muted); font-family: monospace; font-size: 12px; white-space: nowrap; }
.target-cell { font-weight: 600; color: var(--text); }
.display-name-cell { color: var(--muted); font-size: 12px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dc-cell { color: var(--text); font-family: monospace; font-size: 12px; white-space: nowrap; }
.ip-cell { color: var(--text); font-family: monospace; font-size: 12px; white-space: nowrap; }
.ws-cell { color: var(--muted); font-size: 12px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.logon-type-cell { color: var(--muted); font-size: 12px; }
.reason-cell { color: var(--muted); font-family: monospace; font-size: 11px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.table-footer { padding: 10px 14px; background: color-mix(in srgb, var(--panel) 70%, transparent); color: var(--muted); font-size: 12px; text-align: right; }

/* R158.55 — "按锁定服务器" mode top-N aggregate card. Mirrors
   .events-table-section panel chrome so the two bottom-sections
   visually align when the operator toggles between modes. */
.ws-summary-section { margin-top: 8px; }
.ws-summary { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px; }
.ws-summary-header { font-size: 12px; color: var(--muted); margin-bottom: 10px; font-weight: 600; letter-spacing: 0.3px; }
.ws-summary-list { display: flex; flex-direction: column; gap: 6px; }
.ws-summary-row { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 16px; padding: 10px 14px; background: color-mix(in srgb, var(--panel) 70%, transparent); border-radius: 4px; transition: background-color 80ms ease; }
.ws-summary-row:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
.ws-summary-name  { font-family: monospace; font-size: 13px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws-summary-count { font-family: monospace; font-size: 20px; font-weight: 700; color: var(--red); font-variant-numeric: tabular-nums; min-width: 60px; text-align: right; }
.ws-summary-pct   { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; min-width: 56px; text-align: right; }

/* R158.60 (2026-10-09) — always-on DC mini-bar panel that sits below
   the chart regardless of groupBy. Visually mirrors .ws-summary so
   the operator's eye finds the same pattern across toggles, but
   adds a real horizontal fill bar (.dc-mini-bar-fill) so a glance
   shows the relative contribution of each DC, not just numbers.
   Track is a thin gradient that the fill overlays with the
   dashboard's --accent tint; pct is right-aligned in muted gray. */
.dc-mini-bar-section {
  margin-top: 8px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px;
}
.dc-mini-bar-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.dc-mini-bar-title {
  font-size: 12px;
  color: var(--accent);
  font-weight: 700;
  letter-spacing: 0.3px;
}
.dc-mini-bar-meta {
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.dc-mini-bar-skeleton { display: flex; flex-direction: column; gap: 6px; }
.dc-mini-bar-skeleton-row {
  height: 28px;
  background: linear-gradient(90deg, var(--panel) 0%, var(--border) 50%, var(--panel) 100%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  border-radius: 4px;
}
.dc-mini-bar-empty {
  font-size: 12px;
  color: var(--muted);
  text-align: center;
  padding: 14px 0;
}
.dc-mini-bar-list { display: flex; flex-direction: column; gap: 6px; }
.dc-mini-bar-row {
  display: grid;
  grid-template-columns: minmax(160px, 1.4fr) 2fr auto auto;
  align-items: center;
  gap: 14px;
  padding: 8px 14px;
  background: color-mix(in srgb, var(--panel) 70%, transparent);
  border-radius: 4px;
  transition: background-color 80ms ease;
}
.dc-mini-bar-row:hover {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
.dc-mini-bar-name {
  font-family: monospace;
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dc-mini-bar-track {
  position: relative;
  height: 6px;
  background: color-mix(in srgb, var(--border) 60%, transparent);
  border-radius: 3px;
  overflow: hidden;
}
.dc-mini-bar-fill {
  position: absolute;
  inset: 0 auto 0 0;
  background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 70%, transparent));
  border-radius: 3px;
  transition: width 240ms ease;
}
.dc-mini-bar-count {
  font-family: monospace;
  font-size: 14px;
  font-weight: 700;
  color: var(--red);
  font-variant-numeric: tabular-nums;
  min-width: 48px;
  text-align: right;
}
.dc-mini-bar-pct {
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  min-width: 48px;
  text-align: right;
}
</style>
