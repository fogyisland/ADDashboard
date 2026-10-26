<template>
  <!-- R128 — AppLayout wrapper added. R112 originally wrote the comment
       "Wrapped inside AppLayout chrome at the page level" but never
       actually wrapped the template; the route was registered and the
       sidebar router-link was added, but the view rendered as a bare
       page with no chrome. Wrap the existing <div class="eventlog-page">
       so the sidebar + topbar (with admin entry / theme toggle / logout)
       appear alongside the matrix, same shape as TopologyView, ErrorsView,
       ServersOverviewView, etc. The slot here is the same .eventlog-page
       block — no inner refactor needed, AppLayout is layout-only chrome. -->
  <AppLayout>
  <div class="eventlog-page">
    <header class="page-header">
      <div class="title-block">
        <h1>事件日志</h1>
        <p class="subtitle">最近 2 小时内各 DC 域控制器在系统、应用程序、ADWeb、DFSR、安全日志五个通道产生的警告与错误数量</p>
      </div>
      <div class="header-actions">
        <!-- R158.31 — staleness indicator. Mirrors PartnerPortHealthView.vue
             .refresh-indicator / .staleness.fresh/warn/stale (round-34.2).
             Shows how stale the most-recent summary actually is (driven by
             `lastUpdated` + the staleness 1Hz tick). Green ≤30s / yellow
             30s-2min / red >2min — the eventlog page polls every 30s so
             the operator sees "fresh" most of the time and an obvious
             colour jump when the centre stops responding. -->
        <span class="refresh-indicator" data-test="refresh-indicator">
          <span :class="['dot', loading ? 'on' : 'off']"></span>
          <span class="refresh-label">每 {{ POLL_INTERVAL_MS / 1000 }}s 刷新</span>
        </span>
        <span class="last-update" v-if="lastUpdated" data-test="last-update">最近刷新: {{ formatTime(lastUpdated) }}</span>
        <span
          v-if="stalenessSeconds !== null"
          :class="['staleness', stalenessClass]"
          data-test="staleness"
        >数据 {{ stalenessLabel }}</span>
        <button class="refresh-btn" :disabled="loading" @click="loadSummary" data-test="refresh">刷新</button>
      </div>
    </header>

    <!-- R158.108 — 24h/7d/全部 toggle. 1:1 平行 FailedLogonView.vue:39-54.
         24h 走 hourly (R158.54 行为), 7d/全部 走 daily (R158.108 ship).
         "全部" 默认 = ad_mgmt_retention_days (R158.107, 前端读 /api/admin/config). -->
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
      <button
        :class="{ active: chartWindow === 'all' }"
        role="tab"
        :aria-selected="chartWindow === 'all'"
        @click="setChartWindow('all')"
        data-test="window-all"
      >全部</button>
    </div>

    <!-- R158.54 — 顶部 ECharts 折线图, 24h event log 趋势 (5 channel × 24 hour bucket).
         R158.108 — 0 改 chart 渲染, 0 改 ECharts setOption. bucket 数 (24/7/30) 由
         pivotTrendForChart 根据 chartWindow 状态计算. -->
    <section class="chart-section">
      <div v-if="loading && !chartHasData" class="skeleton skeleton-chart"></div>
      <div v-else-if="!chartHasData" class="empty-state">
        暂无 {{ chartWindow === '24h' ? '24h' : (chartWindow === '7d' ? '7d' : '全部') }} 事件日志数据 — 等待各 DC 收集器首次上报
      </div>
      <div v-else ref="chartEl" class="chart-canvas" data-test="eventlog-trend-chart"></div>
    </section>

    <main>
      <div v-if="loading && !summary.length" class="skeleton">
        <div v-for="i in 3" :key="i" class="skeleton-row"></div>
      </div>

      <div v-else-if="error" class="error-banner">
        <span>{{ summary.length ? '事件日志刷新失败 — 正在显示上次成功拉到的数据' : '事件日志加载失败' }}</span>
        <button @click="loadSummary">重试</button>
      </div>

      <div v-else-if="!summary.length" class="empty-state">
        暂无事件日志数据 — 等待各 DC 收集器首次上报（通常 15 分钟以内）
      </div>

      <div v-else class="matrix-wrapper">
        <!-- DC = row, channel = column. Per-cell count badge is clickable
             for drill-down. Header row channels = System / Application /
             ADWeb / DFSR (operator's exact wording in R112 brief). -->
        <table class="matrix" data-test="eventlog-matrix">
          <thead>
            <tr>
              <th class="dc-header">DC</th>
              <th v-for="ch in CHANNELS" :key="ch.key" class="channel-header">
                <span class="channel-name">{{ ch.label }}</span>
              </th>
              <!-- R158.17.4.5+1 (2026-10-02) — "上报时间" header.
                   跟 PartnerPortHealthView.vue 上报时间列同模式 -->
              <th class="collected-at-iso">上报时间</th>
            </tr>
          </thead>
          <!-- R142 — site-grouped rendering. Each site gets a sticky
               section header row above its DC rows. UNGROUPED_LABEL
               bucket (DC with no ad_dcs match) sinks to the bottom.
               Mirrors R140 AgentsView / ServersOverviewView pattern. -->
          <tbody v-for="group in siteGroups" :key="group.siteKey">
            <tr class="site-section-row">
              <th :colspan="CHANNELS.length + 2" class="site-section-title">
                <span class="site-section-name">{{ group.siteName }}</span>
                <span class="site-section-meta">{{ group.rows.length }} 台 DC</span>
              </th>
            </tr>
            <tr v-for="dc in group.rows" :key="dc.dcName">
              <th class="dc-name" :title="dc.dcName">{{ dc.dcName }}</th>
              <td v-for="ch in CHANNELS" :key="ch.key">
                <button
                  class="count-cell"
                  :class="cellClass(dc, ch.key)"
                  :data-test="`cell-${dc.dcName}-${ch.key}`"
                  :disabled="!getCell(dc, ch.key).total"
                  @click="openDrill(dc, ch.key)"
                >
                  <span v-if="getCell(dc, ch.key).total" class="count-row">
                    <span class="count-warn">⚠ {{ getCell(dc, ch.key).warning }}</span>
                    <span class="count-err">✕ {{ getCell(dc, ch.key).error }}</span>
                    <!-- R158.23 (2026-10-02) — auditFailure 总是显示,
                         不再仅在 Security channel 上 (4 channels 都是
                         audit_failure=0, 但展示出来更可读). -->
                    <span class="count-audit">审 {{ getCell(dc, ch.key).auditFailure }}</span>
                  </span>
                  <span v-else class="count-zero">—</span>
                </button>
              </td>
              <!-- R158.17.4.5+1 (2026-10-02) — "上报时间" cell. Operator
                   directive: 跟 /monitor-inbound 一样在 DC 行末加绝对
                   CST 时刻 (yyyy-MM-dd HH:mm:ss), 排查 stale/eventlog
                   何时写入. Source 是 summary endpoint 返回的
                   `collectedAt` 字段 (collect.ps1 UPSERT 时刻). 这个
                   时刻与 channel 无关 — 是整行 (dc,channel) summary
                   的最后一次写入时间. Sits rightmost in the row. -->
              <td class="collected-at-iso"
                  :data-test="`collected-at-${dc.dcName}`"
                  :title="collectedAtIsoTitle(dc)">
                {{ collectedAtIsoText(dc) }}
              </td>
            </tr>
          </tbody>
        </table>
        <footer class="matrix-footer">
          共 {{ totalDcCount }} 台 DC · {{ siteGroups.length }} 个站点 · 数据保留最近 4 小时
        </footer>
      </div>
    </main>

    <!-- R112 drill-down drawer — shows event rows for one (dc, channel).
         Rendered inline rather than as a separate component to keep the
         single-file bundle entry small. -->
    <div v-if="drillTarget" class="drawer-mask" @click.self="closeDrill">
      <aside class="drawer" data-test="eventlog-drill">
        <header class="drawer-header">
          <div>
            <h3>{{ drillTarget.dcName }} · {{ channelLabel(drillTarget.channel) }}</h3>
            <p class="drawer-sub">最近 2 小时事件 · 最多 200 条</p>
          </div>
          <button class="close-btn" @click="closeDrill" aria-label="关闭">✕</button>
        </header>

        <div class="severity-bar">
          <label>严重级别
            <select v-model="drillSeverity" data-test="drill-severity">
              <option value="">全部</option>
              <option value="warning">警告</option>
              <option value="error">错误</option>
            </select>
          </label>
          <label v-if="drillTarget && drillTarget.channel === 'Security'" class="audit-toggle">
            <input type="checkbox" v-model="drillAuditOnly" data-test="drill-audit-only" />
            仅审核失败 (4625/4776)
          </label>
          <span class="drawer-count" v-if="drillEvents.length">共 {{ drillEvents.length }} 条</span>
        </div>

        <div v-if="drillLoading" class="skeleton">
          <div v-for="i in 3" :key="i" class="skeleton-row"></div>
        </div>

        <div v-else-if="!drillEvents.length" class="empty-state small">
          无匹配事件
        </div>

        <div v-else class="event-list">
          <article v-for="ev in drillEvents" :key="ev.recordId + '-' + ev.eventId" class="event-card" :class="[`sev-${ev.severity}`, { 'is-audit-failure': ev.auditFailure }]">
            <header class="event-header">
              <span class="sev-badge" :class="`sev-${ev.severity}`">{{ sevLabel(ev.severity) }}</span>
              <span class="event-id">Event ID {{ ev.eventId }}</span>
              <span v-if="ev.auditFailure" class="audit-tag">审核失败</span>
              <time class="event-time">{{ formatTime(ev.ts) }}</time>
            </header>
            <pre class="event-message">{{ ev.message }}</pre>
          </article>
        </div>
      </aside>
    </div>
  </div>
  </AppLayout>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import * as echarts from 'echarts';
import api from '../api/client.js';
import { fetchEventlogTrend24h, fetchEventlogTrend } from '../api/eventlog.js';
import AppLayout from '../components/AppLayout.vue';

// Channel order is fixed — matches collect.ps1 1.0.1 wire shape +
// operator's exact wording for the 4 original channels plus the new
// '安全日志' column (R154). Security carries the audit-failure count
// (4625 + 4776) separately from generic warning/error counts.
const CHANNELS = [
  { key: 'System',      label: '系统'      },
  { key: 'Application', label: '应用程序' },
  { key: 'ADWeb',       label: 'ADWeb'    },
  { key: 'DFSR',        label: 'DFSR'     },
  { key: 'Security',    label: '安全日志'  }
];

// R112 polling cadence — 30s matches the lockout dashboard's polling
// interval. Authenticated regular users hit /api/eventlog/* every 30s;
// retention loop is hourly so the panel feels "live" without burning
// unnecessary CPU.
// R154 — SINCE_HOURS narrowed from 24 to 2 to match collect.ps1 1.0.1
// scan window. The centre-side clampInt also enforces MAX_SINCE_HOURS=2.
const POLL_INTERVAL_MS = 30 * 1000;
const SINCE_HOURS = 2;
const DRILL_LIMIT = 200;

const summary     = ref([]);     // array of { dcName, channel, warningCount, errorCount, collectedAt }
const lastUpdated = ref(null);
const loading     = ref(false);
const error       = ref(false);

// R158.54 — 24h event log trend chart state. 5 channel fixed by the
// catalog (System / Application / ADWeb / DFSR / Security), each
// channel hardcoded to a stable colour so the palette is consistent
// across reloads (unlike lockout which sort-by-COUNT and shifts).
const CHART_HOURS = 24;
const CHANNEL_COLORS = {
  System:      '#f59e0b',  // amber
  Application: '#3b82f6',  // blue
  ADWeb:       '#06b6d4',  // cyan
  DFSR:        '#8b5cf6',  // violet
  Security:    '#ef4444'   // red
};
const CHART_CHANNELS = Object.keys(CHANNEL_COLORS); // fixed order: System/Application/ADWeb/DFSR/Security

// R158.108 (2026-10-16) — 24h/7d/全部 toggle state. '24h' 走 hourly (R158.54
// 行为 1:1 保留), '7d'/'all' 走 daily (R158.108 ship). 0 改 CHART_HOURS=24
// (24h hourly pivot 内部仍用, R158.54 pivot logic 1:1 平行).
const chartWindow = ref('24h');
const DAILY_MAX_DAYS = 365;  // 跟 sql.js eventlog.dailyAggregate 1:1 平行
// "全部" 边界 = 中心端 ad_mgmt_retention_days (R158.107 retention single
// source of truth). 0 改 /api/admin/config 端点. retentionDays=0 时 (永久
// 保留), 全部 = 365 cap (跟 SQL 端 1:1 平行).
const retentionDays = ref(30);
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
const trendBuckets = ref([]);
const chartHasData = computed(() =>
  Array.isArray(trendBuckets.value) && trendBuckets.value.length > 0
);

// R158.31 — staleness state. Mirrors PartnerPortHealthView.vue
// .staleness.fresh/warn/stale (round-34.2 colour vocabulary). The
// staleness number is recomputed every second by a 1Hz tick so the badge
// counts down/up smoothly between polls (POLL_INTERVAL_MS = 30s, so
// green when fresh, yellow after 30s, red after 2min if the centre
// stops responding). Driven from `lastUpdated` only — when
// `lastUpdated` is null (no successful poll yet), staleness is hidden
// until the first poll lands.
const stalenessSeconds = ref(null);
const stalenessClass   = ref(''); // 'fresh' | 'warn' | 'stale'

// Staleness thresholds — chosen to match the 30s poll cadence. fresh ≤ 30s
// (one poll cycle), warn 30-120s (2 polls missed), stale > 120s. Two-min
// red is short enough that an operator notices a hung centre within the
// window where retention/audit-failure sweeps are still likely relevant,
// long enough that i do not flicker on every poll.
const STALENESS_FRESH_S = 30;
const STALENESS_WARN_S  = 120;

const stalenessLabel = computed(() => {
  const s = stalenessSeconds.value;
  if (s === null) return '';
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m} 分钟前` : `${m} 分 ${r} 秒前`;
});

function recomputeStaleness() {
  if (!lastUpdated.value) {
    stalenessSeconds.value = null;
    stalenessClass.value = '';
    return;
  }
  const t = new Date(lastUpdated.value).getTime();
  if (!Number.isFinite(t)) {
    stalenessSeconds.value = null;
    stalenessClass.value = '';
    return;
  }
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  stalenessSeconds.value = s;
  if (s <= STALENESS_FRESH_S) stalenessClass.value = 'fresh';
  else if (s <= STALENESS_WARN_S) stalenessClass.value = 'warn';
  else stalenessClass.value = 'stale';
}

// Drill-down state
const drillTarget    = ref(null); // { dcName, channel }
const drillEvents    = ref([]);
const drillSeverity  = ref('');   // '' / 'warning' / 'error'
const drillAuditOnly = ref(false); // R154 — Security only: filter to 4625/4776
const drillLoading   = ref(false);

let pollHandle = null;
let stalenessHandle = null;
let retentionHandle = null;  // R158.108 — 1h refresh of ad_mgmt_retention_days (跟 sweep cadence 1:1 平行)

// Aggregate the latest summary rows into a per-DC shape: { dcName,
// cells: { System: {warning,error,total}, ... } }. The /summary endpoint
// returns one row per (dc_name, channel) pair already — we just re-bucket
// by DC for the table render. Wire shape uses camelCase (camelCase
// re-shape in routes/eventlog.js).
const dcRows = computed(() => {
  const byName = new Map();
  for (const row of summary.value) {
    if (!byName.has(row.dcName)) {
      byName.set(row.dcName, { dcName: row.dcName, cells: {}, collectedAt: null });
    }
    const dc = byName.get(row.dcName);
    const warning = Number(row.warningCount) || 0;
    const error   = Number(row.errorCount)   || 0;
    // R154 — audit-failure count is meaningful only for the Security
    // channel; backend defaults it to 0 for the other 4 channels.
    const auditFailure = Number(row.auditFailureCount) || 0;
    // R158.23 (2026-10-02) — total now includes auditFailure so the cell
    // is clickable on Security channels where warn=0/err=0 but audit>0
    // (4625/4776 row count). Previously these channels rendered the gray
    // "—" zero-state and the actual events in ad_eventlog_events were
    // unreachable from the UI.
    dc.cells[row.channel] = { warning, error, auditFailure, total: warning + error + auditFailure };
    // R158.17.4.5+1 — collect the max collectedAt across all channel rows
    // for this DC. Operators want to know when the LAST summary arrived
    // for any channel — staleness at dc-level, not per-channel.
    const at = row.collectedAt;
    if (at) {
      const t = new Date(at).getTime();
      if (Number.isFinite(t) && (dc.collectedAt === null || t > new Date(dc.collectedAt).getTime())) {
        dc.collectedAt = at;
      }
    }
  }
  // Stable order: alphabetic by dcName (operator-side convention used
  // across the rest of the dashboard's DC listings).
  return [...byName.values()].sort((a, b) => a.dcName.localeCompare(b.dcName));
});

// R142 — site-grouped rendering. Bucket dcRows by row.siteName, falling
// back to UNGROUPED_LABEL when the backend returns null (DC has no
// matching ad_dcs row, so no site catalog entry). UNGROUPED bucket sorts
// last. Mirrors R140 AgentsView (buckets keyed by siteName, "未分组"
// fallback) and R140 ServersOverviewView (ORPHAN_BUCKET sorted last).
// Per-section row order: alphabetic by dcName (same as dcRows).
const UNGROUPED_LABEL = '未分组';

const siteGroups = computed(() => {
  const dcRowsValue = dcRows.value;
  const bySite = new Map();
  // First, index dcRows by dcName so we can preserve cell data when
  // bucketing by siteName. dcRows already groups by dcName; siteName
  // is per-DC, so we look it up from the summary array.
  const dcToSite = new Map();
  for (const row of summary.value) {
    if (!dcToSite.has(row.dcName)) {
      dcToSite.set(row.dcName, row.siteName || UNGROUPED_LABEL);
    }
  }
  for (const dc of dcRowsValue) {
    const siteKey = dcToSite.get(dc.dcName) || UNGROUPED_LABEL;
    if (!bySite.has(siteKey)) {
      bySite.set(siteKey, { siteKey, siteName: siteKey, rows: [] });
    }
    bySite.get(siteKey).rows.push(dc);
  }
  // Sort: real sites alphabetically (zh-Hans-CN for the CJK site names
  // in ad_sites), UNGROUPED bucket last. R140 ServersOverviewView uses
  // the catalog order from allSitesOrdered; here we don't have that
  // endpoint cheap, so encounter-order + zh-Hans-CN sort matches
  // R140 AgentsView behavior.
  const out = [...bySite.values()];
  out.sort((a, b) => {
    if (a.siteKey === UNGROUPED_LABEL) return 1;
    if (b.siteKey === UNGROUPED_LABEL) return -1;
    return a.siteKey.localeCompare(b.siteKey, 'zh-Hans-CN');
  });
  return out;
});

const totalDcCount = computed(() => dcRows.value.length);

function getCell(dc, channelKey) {
  return dc.cells[channelKey] || { warning: 0, error: 0, auditFailure: 0, total: 0 };
}

// R158.32 (2026-10-02) — operator directive: "如果10以下错误为绿色方块,
// 10-100黄色方块，100以上红色方块". Colour the count cell by the TOTAL
// number of events in the 2h window instead of by bucket type (warning
// vs error vs audit). Threshold semantics:
//   total < 10       → green   (cell-total-low)
//   10 <= total < 100 → yellow (cell-total-mid)
//   total >= 100     → red     (cell-total-high)
// `total` already includes auditFailure (R158.23), so a Security cell
// with 4625 storms still surfaces as red when it crosses 100. The
// R158.23 audit-accent colour is dropped here per operator's count-based
// scheme — drill-down drawer still badges audit rows in cyan for forensic
// context (`.is-audit-failure` + `.audit-tag`).
function cellClass(dc, channelKey) {
  const c = getCell(dc, channelKey);
  if (!c.total) return 'cell-empty';
  if (c.total >= 100) return 'cell-total-high';
  if (c.total >= 10)  return 'cell-total-mid';
  return 'cell-total-low';
}

function channelLabel(key) {
  const ch = CHANNELS.find(c => c.key === key);
  return ch ? ch.label : key;
}

function sevLabel(sev) {
  if (sev === 'warning') return '警告';
  if (sev === 'error')   return '错误';
  return sev || '?';
}

function formatTime(s) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString();
}

// R158.17.4.5+1 (2026-10-02) — "上报时间" 绝对时刻 helpers. Source is
// summary[i].collectedAt (collect.ps1 1.2 UPSERT moment for this dc+channel
// row in ad_eventlog_events). Same rationale as PartnerPortHealthView:
// "X 分钟前" 不够, operator 想看到精确 UPSERT 时刻跟其它日志 (package_runs,
// system_config) 对时. 一行一个 DC, channel 列只展示计数, 不展示 channel
// 间区分, 所以 collectedAt 走 dc-level 而不是 cell-level — 跟 R154 的
// "summary 一行一 dc+channel" 模型一致, 但 UI 把同一 dc 多 channel 汇总
// 显示 collectedAt 中最新一次.
function collectedAtIsoText(dc) {
  const at = dc.collectedAt;
  if (!at) return '—';
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function collectedAtIsoTitle(dc) {
  const at = dc.collectedAt;
  return at ? `summary 写入时刻: ${new Date(at).toLocaleString('zh-CN', { hour12: false })}` : '未收到 summary 行';
}

// R158.108 (2026-10-16) — fetchEventlogTrendForWindow. 1:1 平行
// FailedLogonView.vue setWindow(24|168) 范式. 24h 走 hourly, 7d/全部
// 走 daily. "全部" = ad_mgmt_retention_days (R158.107 retention 边界).
function fetchEventlogTrendForWindow() {
  if (chartWindow.value === '24h') {
    // R158.X.99.33 (2026-10-19) — 24h 改 5min bucket-by-ts (288 段).
    // bucket 边界走 `ts` 真实事件时间, 操作员原意.
    return fetchEventlogTrend({ windowHours: 24, grain: 'bucket5m' });
  }
  if (chartWindow.value === '7d') {
    // R158.X.99.34 (2026-10-19) — 7d 改 4h bucket-by-ts (42 段/7d).
    // 跟 24h bucket5m 范式 1:1, 区别只在 bucketMinutes=240 (14_400_000ms).
    return fetchEventlogTrend({ days: 7, grain: 'bucket4h' });
  }
  // 'all' — 仍 daily (R158.108 0 改)
  return fetchEventlogTrend({ days: retentionDays.value, grain: 'daily' });
}

// R158.108 — 24h/7d/全部 toggle setter. 切窗口后立即 reload summary + trend.
// 1:1 平行 FailedLogonView.vue setWindow pattern.
function setChartWindow(w) {
  chartWindow.value = w;
  loadSummary();
}

async function loadSummary() {
  loading.value = true;
  error.value = false;
  try {
    // R158.54 — fetch trend in parallel with summary. The trend endpoint
    // is independent of /summary, so Promise.all keeps the round-trip at
    // the slower of the two (typically /summary). R158.31 staleness
    // indicator rebase still happens on summary success.
    const [summaryRes, trendRes] = await Promise.all([
      api.get('/api/eventlog/summary', { params: { sinceHours: SINCE_HOURS } }),
      fetchEventlogTrendForWindow()
    ]);
    // Backend returns the array directly (res.json(out)) — NOT wrapped
    // in { rows: [...] }. Falls back to empty array on unexpected shape
    // so a future wire-shape change doesn't blank out the panel silently.
    summary.value     = Array.isArray(summaryRes.data) ? summaryRes.data : [];
    trendBuckets.value = Array.isArray(trendRes.data) ? trendRes.data : [];
    lastUpdated.value = new Date().toISOString();
    // R158.31 — rebase staleness counter the moment a poll lands. The 1Hz
    // tick below keeps it counting up smoothly between polls.
    recomputeStaleness();
  } catch (e) {
    // 401 from the global api/client.js handler redirects to /login;
    // 500 + connection errors land here. Set error state so the user
    // sees the retry banner, but DO NOT clear `summary.value` — the
    // operator's last-known matrix is more useful than a blank grid
    // while the centre is recovering. The error banner surfaces both
    // cases ("正在显示上次成功拉到的数据" when summary has rows,
    // "事件日志加载失败" when no prior data exists).
    error.value = true;
  } finally {
    loading.value = false;
    await nextTick();
    renderChart();
  }
}

// R158.54 — pivot flat [{ channel, bucketStart, eventCount }] rows
// to ECharts series shape. 0-fills missing hours per channel so each
// series has exactly CHART_HOURS points. Channels are in fixed
// CHANNEL_COLORS order so the palette is stable across reloads.
//
// R158.108 (2026-10-16) — grain aware. 24h 走 hourly (24 hour bucket,
// R158.54 行为 0 改), 7d/全部 走 daily (7/30 day bucket). 0 改 ECharts
// setOption (跟 renderChart 1:1 平行, bucket 数 24/7/30 都 OK). bucket
// stride 切 hour(3600_000) ↔ day(86400_000). endBucket floor 到 hour
// 或 day boundary 1:1 平行 SQL DATE_FORMAT pattern.
function pivotTrendForChart(flat) {
  // R158.X.99.33 + R158.X.99.34 — 24h bucket5m (288 段, 5min floor),
  // 7d bucket4h (42 段, 4h floor), 全部仍 daily. 各窗口 bucketMs /
  // endBucket floor 1:1 平行.
  const isDaily    = chartWindow.value === 'all';
  const isBucket5m = chartWindow.value === '24h';
  const isBucket4h = chartWindow.value === '7d';
  const bucketCount = isDaily    ? retentionDays.value
                    : isBucket4h ? 42   // 7d × 6 段/天 (4h bucket)
                    : isBucket5m ? 288  // 24h × 12 段/小时 (5min bucket)
                    : CHART_HOURS;
  const bucketMs = isDaily    ? 86_400_000
                 : isBucket4h ? 14_400_000  // 4h
                 : isBucket5m ?   300_000  // 5min
                 :               3_600_000; // hourly fallback
  const now = new Date();
  let endBucket;
  if (isDaily) {
    endBucket = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  } else if (isBucket5m || isBucket4h) {
    // R158.X.99.33 + .34 — bucket-stride floor 到齐 boundary (e.g. 4h floor:
    // 13:42 → 12:00; 5min floor: 13:42:30 → 13:40).
    const tsNow = now.getTime();
    endBucket = new Date(Math.floor(tsNow / bucketMs) * bucketMs);
  } else {
    endBucket = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), 0, 0, 0));
  }
  const xs = [];
  for (let i = bucketCount - 1; i >= 0; i--) {
    xs.push(new Date(endBucket.getTime() - i * bucketMs));
  }
  const byChannel = new Map();
  for (const r of flat) {
    if (!byChannel.has(r.channel)) byChannel.set(r.channel, new Map());
    byChannel.get(r.channel).set(new Date(r.bucketStart).getTime(), r.eventCount);
  }
  const series = CHART_CHANNELS.map((channel) => {
    const bucketMap = byChannel.get(channel) || new Map();
    const ys = xs.map((h) => bucketMap.get(h.getTime()) ?? 0);
    return { channel, ys };
  });
  return { xs, series, mode: 'bucket' };
}

function renderChart() {
  if (!chartEl.value || !chartHasData.value) return;
  if (!chartInstance) {
    chartInstance = echarts.init(chartEl.value, null, { renderer: 'canvas' });
    window.addEventListener('resize', onResize);
  }
  const { xs, series } = pivotTrendForChart(trendBuckets.value);
  chartInstance.setOption({
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
      type: 'value', name: '事件数',
      nameTextStyle: { color: 'var(--muted)', fontSize: 11 },
      axisLabel: { color: 'var(--muted)', fontSize: 11 },
      splitLine: { lineStyle: { color: 'var(--border)', type: 'dashed' } },
      minInterval: 1
    },
    series: series.map((s) => {
      const color = CHANNEL_COLORS[s.channel] || '#999';
      return {
        name: s.channel, type: 'line', data: s.ys,
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
  }, true);
}

const onResize = () => { if (chartInstance) chartInstance.resize(); };

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// R158.54 — CST (UTC+8) formatter. Mirrors LockoutAccountsView.vue:154
// so dashboard axes align across /eventlog, /lockout-accounts,
// /failed-logon-2h, /os-baseline.
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

async function openDrill(dc, channel) {
  drillTarget.value = { dcName: dc.dcName, channel };
  // R158.23 (2026-10-02) — if the user clicks a Security cell whose only
  // non-zero bucket is auditFailure (warning=0/err=0/audit>0), default the
  // drill to "audit-only" filter so they see the 4625/4776 rows instead of
  // hitting the generic "全部" view that may have very few entries. Other
  // channels default to "全部" (severity='').
  const cell = dc.cells[channel] || {};
  if (channel === 'Security' && cell.auditFailure > 0 && cell.warning === 0 && cell.error === 0) {
    drillSeverity.value = '';
    drillAuditOnly.value = true;
  } else {
    drillSeverity.value = '';
    drillAuditOnly.value = false;
  }
  drillEvents.value = [];
  await loadDrill();
}

async function loadDrill() {
  if (!drillTarget.value) return;
  drillLoading.value = true;
  try {
    const params = {
      dc: drillTarget.value.dcName,
      channel: drillTarget.value.channel,
      sinceHours: SINCE_HOURS,
      limit: DRILL_LIMIT
    };
    if (drillSeverity.value) params.severity = drillSeverity.value;
    // R154 — Security drill-down supports an audit-failure filter
    // (4625/4776). auditOnly=true is sent only for the Security channel
    // (the route accepts the flag for any channel but the SQL filter
    // matches no rows on non-Security channels in practice).
    if (drillAuditOnly.value) params.auditOnly = 'true';
    // Same wire-shape contract as /summary: array directly, not wrapped.
    const r = await api.get('/api/eventlog/events', { params });
    drillEvents.value = Array.isArray(r.data) ? r.data : [];
  } catch (e) {
    drillEvents.value = [];
  } finally {
    drillLoading.value = false;
  }
}

function closeDrill() {
  drillTarget.value = null;
  drillEvents.value = [];
  drillSeverity.value = '';
  drillAuditOnly.value = false;
}

// R154 — auto-refetch when auditOnly flips (only meaningful for Security
// but Vue handles the no-op on other channels because the param returns
// the same rows).
watch(drillAuditOnly, () => { if (drillTarget.value) loadDrill(); });

// R158.54 — re-render chart when trend buckets change. The render path
// is `setOption(..., true)` (replace-not-merge), so we only need to
// trigger on shape change — 30s polling produces a new array reference
// every tick and re-render is cheap (5 series × 24 points each).
watch(trendBuckets, async () => {
  await nextTick();
  renderChart();
});

onMounted(() => {
  // R158.108 — load retention days first (best-effort), then loadSummary.
  // "全部" toggle 1:1 依赖 ad_mgmt_retention_days (R158.107 retention).
  // retention 1h cadence, 中心端 GET /api/admin/config hot-read, 0 重启.
  loadRetentionDays();
  loadSummary();
  pollHandle = setInterval(loadSummary, POLL_INTERVAL_MS);
  // R158.31 — 1Hz staleness tick. Recomputes the "X 秒前" badge every
  // second so the operator sees the counter roll forward smoothly
  // between polls (no 30s "is this page alive?" uncertainty). Cheap —
  // just two Date.now() subtractions and a colour-string assignment.
  stalenessHandle = setInterval(recomputeStaleness, 1000);
  // R158.108 — refresh retention every 1h, 1:1 平行 retention sweep cadence.
  retentionHandle = setInterval(loadRetentionDays, 60 * 60 * 1000);
});

onBeforeUnmount(() => {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = null;
  if (stalenessHandle) clearInterval(stalenessHandle);
  stalenessHandle = null;
  // R158.108 — release retention refresh handle (1:1 平行 staleness/polling)
  if (retentionHandle) clearInterval(retentionHandle);
  retentionHandle = null;
  // R158.54 — release the ECharts instance + its resize listener. The
  // instance owns a canvas + RAF handle; without dispose() the canvas
  // leaks on route navigation. Symmetrical to the LockoutAccountsView
  // cleanup pattern.
  if (chartInstance) {
    window.removeEventListener('resize', onResize);
    chartInstance.dispose();
    chartInstance = null;
  }
});
</script>

<style scoped>
/* R112 — auth-required regular-user surface (operator directive 2026-09-26
   "其实也是需要登录到普通用户界面，普通用户界面可以看到DC基本情况").
   Wrapped inside AppLayout chrome at the page level; the .eventlog-page
   block only sizes content (no full-bleed background — AppLayout provides
   the panel). Theme tokens come from :root via the same --panel /
   --accent / --border / --muted / --green / --red / --text names used by
   every other auth-required view. */
.eventlog-page { padding: 16px 0; }
.page-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
.title-block h1 { margin: 0 0 4px; font-size: 20px; color: var(--accent); }
.subtitle { margin: 0; font-size: 12px; color: var(--muted); max-width: 640px; }
.header-actions { display: flex; align-items: center; gap: 12px; }
.last-update { font-size: 12px; color: var(--muted); font-family: monospace; }

/* R158.31 — staleness badge + refresh heartbeat dot. Mirrors
   PartnerPortHealthView.vue .refresh-indicator / .dot.on/off /
   .staleness.fresh/warn/stale so the operator uses the same colour
   vocabulary across pages (green=fresh / yellow=warn / red=stale).
   fresh ≤ 30s matches the 30s poll cadence — within one tick the
   panel reads fresh. warn at 30-120s = "we missed one poll".
   stale > 120s = "centre is not responding, last-known data is
   all you've got". */
.refresh-indicator { color: var(--muted); font-size: 12px; display: flex; gap: 6px; align-items: center; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; transition: background-color 200ms ease; }
.dot.on  { background: var(--green); }
.dot.off { background: var(--muted); }
.refresh-label { font-variant-numeric: tabular-nums; }
.staleness {
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 3px;
  font-variant-numeric: tabular-nums;
  font-family: monospace;
}
.staleness.fresh { background: color-mix(in srgb, var(--green) 14%, transparent);  color: var(--green); }
.staleness.warn  { background: color-mix(in srgb, var(--yellow) 14%, transparent);  color: var(--yellow); }
.staleness.stale { background: color-mix(in srgb, var(--red) 14%, transparent);  color: var(--red); }
.refresh-btn { padding: 6px 14px; background: var(--accent); color: var(--sidebar-bg); border: none; border-radius: 3px; cursor: pointer; font-weight: 600; font-size: 13px; }
.refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.skeleton { display: flex; flex-direction: column; gap: 8px; }
.skeleton-row { height: 40px; background: linear-gradient(90deg, var(--panel) 0%, color-mix(in srgb, var(--panel) 70%, transparent) 50%, var(--panel) 100%); background-size: 200% 100%; animation: shimmer 1.5s infinite; border-radius: 4px; }
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

.error-banner { padding: 16px; background: var(--red, var(--danger-bg)); border-radius: 4px; display: flex; align-items: center; gap: 12px; color: var(--text); }
.error-banner button { padding: 4px 12px; background: var(--accent); color: var(--sidebar-bg); border: none; border-radius: 3px; cursor: pointer; font-weight: 600; }

.empty-state { padding: 40px; text-align: center; color: var(--muted); }
.empty-state.small { padding: 24px; font-size: 13px; }

/* R158.54 — 24h event log trend chart section. Sits between the
   page-header and the matrix grid so operators see the trend
   contour before they drill into the per-DC counts. Same panel +
   border vocabulary as .matrix-wrapper for visual coherence. */
.chart-section { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-bottom: 16px; }
.chart-canvas  { width: 100%; height: 280px; outline: none; }
.skeleton-chart { height: 280px; background: linear-gradient(90deg, var(--panel) 0%, var(--border) 50%, var(--panel) 100%); background-size: 200% 100%; animation: shimmer 1.5s infinite; border-radius: 4px; }

.matrix-wrapper { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.matrix { width: 100%; border-collapse: collapse; }
.matrix thead th { padding: 10px 14px; background: color-mix(in srgb, var(--panel) 70%, transparent); color: var(--muted); font-size: 12px; font-weight: 600; text-align: left; border-bottom: 1px solid var(--border); }
.matrix thead th.channel-header { text-align: center; }
.matrix tbody tr { border-bottom: 1px solid var(--border); }
.matrix tbody tr:last-child { border-bottom: none; }
.dc-name { padding: 12px 14px; font-size: 13px; font-weight: 600; text-align: left; color: var(--text); white-space: nowrap; min-width: 140px; }
.dc-header { padding: 12px 14px; }
.matrix tbody td { padding: 6px 8px; text-align: center; }
/* R158.17.4.5+1 (2026-10-02) — "上报时间" cell on /eventlog. Same
   scheme as PartnerPortHealthView.vue .probe-at-iso-tx: monospace +
   tabular-nums + 158px min-width. muted when empty (no summary row),
   text colour when populated (CSS attribute selector on populated
   title attribute). */
.collected-at-iso {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: var(--muted);
  min-width: 158px;
  text-align: center;
  vertical-align: middle;
}
.collected-at-iso[title^="summary 写入时刻"] {
  color: var(--text);
}
.count-cell { width: 100%; padding: 10px 8px; background: color-mix(in srgb, var(--panel) 50%, transparent); border: 1px solid var(--border); border-radius: 4px; cursor: pointer; color: var(--text); transition: border-color 120ms ease; }
.count-cell:hover { border-color: var(--accent); }
.count-cell:disabled { cursor: default; opacity: 0.7; }
.count-cell:disabled:hover { border-color: var(--border); }
.count-cell.cell-empty { color: var(--muted); }
/* R158.32 (2026-10-02) — count-threshold colour scheme (operator
   directive 2026-10-02: "如果10以下错误为绿色方块，10-100黄色方块，
   100以上红色方块"). Replaces the R158.23 audit/error/warning tri-class.
   `total` includes auditFailure, so 4625 storms cross 100 → red.
   Drill-down drawer still keeps cyan for forensic context. */
.count-cell.cell-total-low  { border-color: var(--green);  background: color-mix(in srgb, var(--green)  10%, transparent); }
.count-cell.cell-total-mid  { border-color: var(--yellow); background: color-mix(in srgb, var(--yellow) 10%, transparent); }
.count-cell.cell-total-high { border-color: var(--red);    background: color-mix(in srgb, var(--red)    12%, transparent); }
.count-row { display: flex; flex-direction: column; gap: 2px; align-items: center; font-family: monospace; font-size: 13px; }
.count-warn { color: var(--hub-gold); }
.count-err  { color: var(--severity-critical-text); font-weight: 600; }
.count-audit { color: var(--accent); font-weight: 600; font-size: 11px; letter-spacing: 0.5px; }
.count-zero { font-size: 14px; }
.matrix-footer { padding: 10px 14px; background: color-mix(in srgb, var(--panel) 70%, transparent); color: var(--muted); font-size: 12px; text-align: right; }

/* R142 — site section header. Sticky so it stays visible while the
   matrix scrolls within its wrapper. backdrop-filter matches the
   R140 AgentStatusTable site-section-title (semi-transparent panel
   with subtle accent tint). */
.site-section-row { position: sticky; top: 0; z-index: 2; background: var(--panel); }
.site-section-title { padding: 10px 14px; text-align: left; background: color-mix(in srgb, var(--accent) 8%, var(--panel)); color: var(--accent); font-size: 13px; font-weight: 600; border-bottom: 1px solid var(--border); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
.site-section-name { display: inline-block; margin-right: 12px; }
.site-section-meta { color: var(--muted); font-weight: 400; font-size: 11px; }

/* Drawer */
.drawer-mask { position: fixed; inset: 0; background: var(--modal-backdrop); z-index: 100; display: flex; justify-content: flex-end; }
.drawer { width: min(720px, 100%); height: 100%; background: var(--panel); border-left: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
.drawer-header { padding: 16px 20px; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--border); }
.drawer-header h3 { margin: 0 0 4px; font-size: 16px; color: var(--accent); }
.drawer-sub { margin: 0; font-size: 12px; color: var(--muted); }
.close-btn { background: transparent; border: 1px solid var(--border); color: var(--text); padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 14px; }
.severity-bar { padding: 10px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 16px; }
.severity-bar label { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
.severity-bar select { padding: 4px 8px; background: color-mix(in srgb, var(--panel) 50%, transparent); color: var(--text); border: 1px solid var(--border); border-radius: 3px; font-size: 12px; }
.drawer-count { margin-left: auto; font-size: 12px; color: var(--muted); }
.event-list { padding: 16px 20px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 10px; }
.event-card { background: color-mix(in srgb, var(--panel) 50%, transparent); border: 1px solid var(--border); border-radius: 4px; padding: 10px 12px; }
.event-card.sev-error { border-left: 4px solid var(--red); }
.event-card.sev-warning { border-left: 4px solid var(--yellow); }
.event-card.is-audit-failure { border-left-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
.audit-tag { padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; background: var(--accent); color: var(--sidebar-bg); }
.audit-toggle { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
.audit-toggle input { cursor: pointer; }
.event-header { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }
.sev-badge { padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
.sev-badge.sev-error { background: var(--red, var(--danger-bg)); color: var(--severity-critical-text); }
.sev-badge.sev-warning { background: var(--warning-bg); color: var(--hub-gold); }
.event-id { font-family: monospace; font-size: 12px; color: var(--muted); }
.event-time { margin-left: auto; font-size: 12px; color: var(--muted); font-family: monospace; }
.event-message { margin: 0; font-size: 12px; line-height: 1.5; color: var(--text); white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow-y: auto; }
</style>