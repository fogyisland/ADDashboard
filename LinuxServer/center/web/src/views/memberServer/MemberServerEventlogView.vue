<!-- R158.101 (2026-10-13) — /memberServer/eventlog 拉齐 AD 端 matrix 形态.
     改前: R158.78 ship 时的 host-tabs 模式 (跟其它 5 sub-tab 同 precedent,
       单 host table, 0 matrix, 0 trend chart, 0 staleness, 0 cell 颜色,
       0 drawer drill-down).
     改后: 1:1 抄 AD 端 EventlogView.vue R112+R158.54+R158.32+R158.31+R142
       模式, 但调:
       · 3 channel (System/Application/Security, R158.78 member spec) 不用
         DC 端 5 (System/Application/ADWeb/DFSR/Security)
       · hostname 不用 dc_name (R158.78 member spec)
       · 走 ad_member_eventlog_* 0 走 ad_eventlog_* (R158.78 专表, R158.99
         0 复用)
       · site 分组走 ad_member_servers.site_id → ad_sites (R158.99
         siteName 字段已有, 0 改 SQL)
       · channel 颜色 3 色简化版 (amber/blue/red), 跟 AD 端 5 色 palette
         1:1 平行 (前 3 色)

     父 MemberServerView.vue (R158.77) 已包 <AppLayout> + 6 sub-tab 横条.
     R158.101 ship 时的原版从 AD 端 EventlogView 1:1 抄 <AppLayout> 包装
     但 member 端是嵌套在父 MemberServerView 下的 sub-tab, 跟 AD 端顶级
     路由 EventlogView 架构不同 → AppLayout 嵌套 2 层 (父侧 chrome + 本
     view 自又 chrome) 显多余. 1 个文件 3 行删 (2 个 tag + 1 个 import),
     0 改其它任何内容 / styles / member-overview 5 个兄弟 sub-tab.

     R158.78 ship cadence 60s → R158.101 改 30s 跟 AD 端 1:1 平行 (跟
     R158.99 verify "1h+24h+72h 必 3 次 probe" 同). R158.78 "60s 是
     member fleet 规模" 不适用 — 跟 AD 端同 visual consistency 优先. -->
<template>
  <div class="ms-eventlog-page">
    <header class="page-header">
      <div class="title-block">
        <h1>事件日志</h1>
        <p class="subtitle">最近 {{ sinceHours }} 小时内各成员服务器在系统、应用程序、审核三个通道产生的警告与错误数量</p>
      </div>
      <div class="header-actions">
        <label class="since-select">
          时间窗口
          <select v-model.number="sinceHours" data-test="since-hours" @change="load">
            <option :value="1">最近 1 小时</option>
            <option :value="2">最近 2 小时</option>
            <option :value="6">最近 6 小时</option>
            <option :value="24">最近 24 小时</option>
          </select>
        </label>
        <!-- R158.31 — staleness indicator. Mirrors AD 端 EventlogView
             .refresh-indicator / .staleness.fresh/warn/stale. Green ≤30s
             / yellow 30s-2min / red >2min — 30s polling cadence 跟 AD
             端 R158.54 同, 1Hz tick 跟 AD 端同. -->
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
        <button class="refresh-btn" :disabled="loading" @click="load" data-test="refresh">刷新</button>
      </div>
    </header>

    <!-- R158.101 — 24h event log trend chart. 3 channel (System / Application
         / Security) 跟 R158.78 member spec 平行. 跟 AD 端 R158.54 同 shape,
         palette 取前 3 色 (amber/blue/red). -->
    <section class="chart-section">
      <div v-if="loading && !chartHasData" class="skeleton skeleton-chart"></div>
      <div v-else-if="!chartHasData" class="empty-state">
        暂无 24h 事件日志数据 — 等待各成员服务器收集器首次上报
      </div>
      <div v-else ref="chartEl" class="chart-canvas" data-test="ms-eventlog-trend-chart"></div>
    </section>

    <main>
      <div v-if="loading && !summary.length" class="skeleton">
        <div v-for="i in 3" :key="i" class="skeleton-row"></div>
      </div>

      <div v-else-if="error" class="error-banner">
        <span>{{ summary.length ? '事件日志刷新失败 — 正在显示上次成功拉到的数据' : '事件日志加载失败' }}</span>
        <button @click="load">重试</button>
      </div>

      <div v-else-if="!summary.length" class="empty-state">
        暂无事件日志数据 — 等待各成员服务器收集器首次上报（通常 60 分钟以内）
      </div>

      <div v-else class="matrix-wrapper">
        <!-- member-server = row, channel = column. Per-cell count badge
             is clickable for drill-down. Header row channels = System /
             Application / Security (R158.78 member spec, 3 channel). -->
        <table class="matrix" data-test="ms-eventlog-matrix">
          <thead>
            <tr>
              <th class="host-header">Host</th>
              <th v-for="ch in CHANNELS" :key="ch.key" class="channel-header">
                <span class="channel-name">{{ ch.label }}</span>
              </th>
              <!-- R158.17.4.5+1 (2026-10-02) — "上报时间" header. 跟 AD
                   端 EventlogView 同 pattern, member 端用 hostname
                   对应 summary endpoint 返的 collectedAt 字段. -->
              <th class="collected-at-iso">上报时间</th>
            </tr>
          </thead>
          <!-- R158.142 — site-grouped rendering. Each site gets a sticky
               section header row above its member-server rows.
               UNGROUPED_LABEL bucket (host with no ad_member_servers
               match) sinks to the bottom. Mirrors AD 端 R142
               EventlogView 1:1 平行. member 端 summary 字段
               `siteName` 来自 LATEST_SUMMARY_MYSQL/MSSQL LEFT JOIN
               ad_sites (R158.78 ship 已有), 0 改 SQL. -->
          <tbody v-for="group in siteGroups" :key="group.siteKey">
            <tr class="site-section-row">
              <th :colspan="CHANNELS.length + 2" class="site-section-title">
                <span class="site-section-name">{{ group.siteName }}</span>
                <span class="site-section-meta">{{ group.rows.length }} 台成员服务器</span>
              </th>
            </tr>
            <tr v-for="host in group.rows" :key="host.hostname">
              <th class="host-name" :title="host.hostname">{{ host.hostname }}</th>
              <td v-for="ch in CHANNELS" :key="ch.key">
                <button
                  class="count-cell"
                  :class="cellClass(host, ch.key)"
                  :data-test="`ms-cell-${host.hostname}-${ch.key}`"
                  :disabled="!getCell(host, ch.key).total"
                  @click="openDrill(host, ch.key)"
                >
                  <span v-if="getCell(host, ch.key).total" class="count-row">
                    <span class="count-warn">⚠ {{ getCell(host, ch.key).warning }}</span>
                    <span class="count-err">✕ {{ getCell(host, ch.key).error }}</span>
                    <!-- R158.78 (2026-10-12) — auditFailure 总是显示.
                         跟 AD 端 R158.23 1:1 平行, 3 channel 都展示
                         auditFailure (R158.78 auditFailureCount 跟
                         Security channel 4625/4776 兼容). -->
                    <span class="count-audit">审 {{ getCell(host, ch.key).auditFailure }}</span>
                  </span>
                  <span v-else class="count-zero">—</span>
                </button>
              </td>
              <td class="collected-at-iso"
                  :data-test="`ms-collected-at-${host.hostname}`"
                  :title="collectedAtIsoTitle(host)">
                {{ collectedAtIsoText(host) }}
              </td>
            </tr>
          </tbody>
        </table>
        <footer class="matrix-footer">
          共 {{ totalHostCount }} 台成员服务器 · {{ siteGroups.length }} 个站点 · 数据保留最近 10 天
        </footer>
      </div>
    </main>

    <!-- R112 drill-down drawer — shows event rows for one (host, channel).
         Rendered inline rather than as a separate component to keep the
         single-file bundle entry small. 跟 AD 端 EventlogView drawer
         1:1 平行 (R154 / R158.23 audit-only filter). -->
    <div v-if="drillTarget" class="drawer-mask" @click.self="closeDrill">
      <aside class="drawer" data-test="ms-eventlog-drill">
        <header class="drawer-header">
          <div>
            <h3>{{ drillTarget.hostname }} · {{ channelLabel(drillTarget.channel) }}</h3>
            <p class="drawer-sub">最近 {{ sinceHours }} 小时事件 · 最多 200 条</p>
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
</template>

<script setup>
// R158.101 (2026-10-13) — member-server event log sub-tab (matrix 形态,
//   跟 AD 端 EventlogView 1:1 平行).
//
// 数据源 (R158.78 ship 既有 2 endpoint + R158.101 新加 1 endpoint):
//   · /api/dashboard/member-eventlog/summary — 3 channel × hostname 计数矩阵
//   · /api/dashboard/member-eventlog/trend   — 24h hourly aggregate (3 ch)
//   · /api/dashboard/member-eventlog/events  — drill-down (hostname + channel)
//
// 跟 AD 端 EventlogView 1:1 平行 (R112 + R158.54 + R158.32 + R158.31 + R142):
//   · 5 channel → 3 channel (R158.78 member spec: System/Application/Security)
//   · dcName → hostname (R158.78 member spec, 走 ad_member_servers.hostname)
//   · ad_eventlog_* → ad_member_eventlog_* (R158.78 专表, R158.99 0 复用)
//   · site 分组走 ad_member_servers.site_id → ad_sites (R158.78 summary 已
//     含 siteName 字段, 0 改 SQL)
//
// R158.78 ship cadence 60s → R158.101 改 30s 跟 AD 端 1:1 平行. R158.78
// 注释 "60s 是 member fleet 规模" 跟 AD 端 visual consistency 权衡时,
// 选 visual 一致.

import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import * as echarts from 'echarts';
import { memberServerApi } from '../../api/member-server.js';

// Channel order is fixed — R158.78 member spec 3 channel, 跟 AD 端 5 channel
// (System/Application/ADWeb/DFSR/Security) 0 同, 不复用 (R158.100.A design
// contract: "channel 集合 0 同" 是 design 而 0 dormant bug).
const CHANNELS = [
  { key: 'System',      label: '系统'      },
  { key: 'Application', label: '应用程序' },
  { key: 'Security',    label: '审核'      }
];

// R158.101 — 30s polling cadence 跟 AD 端 R158.54 EventlogView 1:1 平行.
const POLL_INTERVAL_MS = 30 * 1000;
// R158.78 ship 写死 24h; R158.101 让用户切 (1/2/6/24), 跟 AD 端 R154
// 5 channel fixed 24h 不同, member 端 R158.78 retention 10d (R158.86
// operator directive) 所以 1/2/6/24 都 OK.
const DRILL_LIMIT = 200;

// R158.101 — 24h event log trend chart state. 3 channel fixed by R158.78
// member spec (System / Application / Security), each channel hardcoded
// to a stable colour so the palette is consistent across reloads. 跟
// AD 端 R158.54 5 channel palette 取前 3 色 1:1 平行 (amber/blue/red).
const CHART_HOURS = 24;
const CHANNEL_COLORS = {
  System:      '#f59e0b',  // amber
  Application: '#3b82f6',  // blue
  Security:    '#ef4444'   // red
};
const CHART_CHANNELS = Object.keys(CHANNEL_COLORS); // fixed order: System/Application/Security
const chartEl = ref(null);
let chartInstance = null;
const trendBuckets = ref([]);
const chartHasData = computed(() =>
  Array.isArray(trendBuckets.value) && trendBuckets.value.length > 0
);

// R158.31 — staleness state. Mirrors AD 端 EventlogView
// .staleness.fresh/warn/stale (round-34.2 colour vocabulary). 30s poll
// cadence 跟 AD 端同, green ≤30s / yellow 30-120s / red >120s.
const STALENESS_FRESH_S = 30;
const STALENESS_WARN_S  = 120;
const stalenessSeconds = ref(null);
const stalenessClass   = ref('');

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

// Drill-down state (跟 AD 端 R158.23 1:1 平行)
const drillTarget    = ref(null); // { hostname, channel }
const drillEvents    = ref([]);
const drillSeverity  = ref('');   // '' / 'warning' / 'error'
const drillAuditOnly = ref(false); // R158.78 — Security only: filter to 4625/4776
const drillLoading   = ref(false);

let pollHandle = null;
let stalenessHandle = null;

const sinceHours = ref(24);     // R158.101 — 用户可切 (1/2/6/24)
const summary     = ref([]);    // array of { hostname, channel, warningCount, errorCount, auditFailureCount, droppedCount, collectedAt, siteName }
const lastUpdated = ref(null);
const loading     = ref(false);
const error       = ref(false);

// R158.101 — pivot flat summary rows into per-host shape: { hostname,
// cells: { System: {warning,error,auditFailure,total}, ... } }. 跟 AD
// 端 R158.99.2 同 precedent (member 端用 hostname 不用 dcName). summary
// endpoint 返回的 wire shape (member-servers-public.js:766-776) 是
// camelCase, 1:1 跟 AD 端 R158.23 shape 平行 (只少了 dcName, 加了
// siteName / droppedCount).
const hostRows = computed(() => {
  const byName = new Map();
  for (const row of summary.value) {
    if (!byName.has(row.hostname)) {
      byName.set(row.hostname, { hostname: row.hostname, cells: {}, collectedAt: null });
    }
    const host = byName.get(row.hostname);
    const warning = Number(row.warningCount) || 0;
    const error   = Number(row.errorCount)   || 0;
    // R158.78 — audit-failure count 跟 AD 端 R158.23 平行, member 端
    // 3 channel 都展示 auditFailure (R158.78 auditFailureCount 跟
    // Security channel 4625/4776 兼容).
    const auditFailure = Number(row.auditFailureCount) || 0;
    // R158.78 — total 跟 AD 端 R158.23 1:1 平行, 含 auditFailure
    // (4625/4776 风暴 cross 100 → red).
    host.cells[row.channel] = { warning, error, auditFailure, total: warning + error + auditFailure };
    // R158.17.4.5+1 — collect the max collectedAt across all channel rows
    // for this host. Operators want to know when the LAST summary arrived
    // for any channel — staleness at host-level, not per-channel.
    const at = row.collectedAt;
    if (at) {
      const t = new Date(at).getTime();
      if (Number.isFinite(t) && (host.collectedAt === null || t > new Date(host.collectedAt).getTime())) {
        host.collectedAt = at;
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.hostname.localeCompare(b.hostname));
});

// R158.142 — site-grouped rendering. Bucket hostRows by siteName,
// falling back to UNGROUPED_LABEL when the backend returns null
// (host with no matching ad_member_servers row, so no site catalog
// entry). UNGROUPED bucket sorts last. Mirrors AD 端 R140
// AgentsView / R142 EventlogView pattern. member 端 summary endpoint
// 已经返 siteName (R158.78 LATEST_SUMMARY LEFT JOIN ad_sites, sql
// helper 已有, 0 改 SQL).
const UNGROUPED_LABEL = '未分组';

const siteGroups = computed(() => {
  const hostRowsValue = hostRows.value;
  const bySite = new Map();
  const hostToSite = new Map();
  for (const row of summary.value) {
    if (!hostToSite.has(row.hostname)) {
      hostToSite.set(row.hostname, row.siteName || UNGROUPED_LABEL);
    }
  }
  for (const host of hostRowsValue) {
    const siteKey = hostToSite.get(host.hostname) || UNGROUPED_LABEL;
    if (!bySite.has(siteKey)) {
      bySite.set(siteKey, { siteKey, siteName: siteKey, rows: [] });
    }
    bySite.get(siteKey).rows.push(host);
  }
  const out = [...bySite.values()];
  out.sort((a, b) => {
    if (a.siteKey === UNGROUPED_LABEL) return 1;
    if (b.siteKey === UNGROUPED_LABEL) return -1;
    return a.siteKey.localeCompare(b.siteKey, 'zh-Hans-CN');
  });
  return out;
});

const totalHostCount = computed(() => hostRows.value.length);

function getCell(host, channelKey) {
  return host.cells[channelKey] || { warning: 0, error: 0, auditFailure: 0, total: 0 };
}

// R158.32 — count-threshold colour scheme. 跟 AD 端 EventlogView
// 1:1 平行: total < 10 → green, 10-99 → yellow, ≥100 → red.
// `total` 已含 auditFailure (R158.78 / R158.23), 4625 风暴 cross 100 → red.
function cellClass(host, channelKey) {
  const c = getCell(host, channelKey);
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

// R158.17.4.5+1 — "上报时间" 绝对时刻 helpers. 跟 AD 端 EventlogView
// 同 pattern. Source: summary[i].collectedAt (collect.ps1 1.0.0 UPSERT
// moment for this host+channel row in ad_member_eventlog_events).
function collectedAtIsoText(host) {
  const at = host.collectedAt;
  if (!at) return '—';
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function collectedAtIsoTitle(host) {
  const at = host.collectedAt;
  return at ? `summary 写入时刻: ${new Date(at).toLocaleString('zh-CN', { hour12: false })}` : '未收到 summary 行';
}

async function load() {
  loading.value = true;
  error.value = false;
  try {
    // R158.101 — fetch trend in parallel with summary. The trend endpoint
    // is independent of /summary, so Promise.all keeps the round-trip at
    // the slower of the two (typically /summary). 跟 AD 端 R158.54
    // EventlogView loadSummary 1:1 平行 (避免 R158.100.6/7 chart race).
    const [summaryRes, trendRes] = await Promise.all([
      memberServerApi.getEventlogSummary({ sinceHours: sinceHours.value }),
      memberServerApi.getEventlogTrend({ sinceHours: sinceHours.value })
    ]);
    // Backend returns the payload wrapped in { items: [...] } (跟 AD
    // 端 R112 直接返 array 不同, R158.78 ship 时 member 端点用 wrapper,
    // 跟 R158.77 member-overview / member-agents 同 precedent).
    const summaryPayload = summaryRes.data || {};
    const trendPayload = trendRes.data || {};
    summary.value     = Array.isArray(summaryPayload.items) ? summaryPayload.items : [];
    trendBuckets.value = Array.isArray(trendPayload.items) ? trendPayload.items : [];
    lastUpdated.value = new Date().toISOString();
    recomputeStaleness();
  } catch (e) {
    // 401 from the global api/client.js handler redirects to /login;
    // 500 + connection errors land here. Set error state so the user
    // sees the retry banner, but DO NOT clear `summary.value` — 跟
    // AD 端 R158.54 EventlogView 1:1 平行.
    error.value = true;
  } finally {
    loading.value = false;
    await nextTick();
    renderChart();
  }
}

// R158.101 — pivot flat [{ channel, bucketStart, eventCount }] rows
// to ECharts series shape. 0-fills missing hours per channel so each
// series has exactly CHART_HOURS points. Channels are in fixed
// CHANNEL_COLORS order so the palette is stable across reloads.
// 跟 AD 端 R158.54 EventlogView pivotTrendForChart 1:1 平行.
function pivotTrendForChart(flat) {
  const now = new Date();
  const endHour = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    now.getUTCHours(), 0, 0, 0
  ));
  const xs = [];
  for (let i = CHART_HOURS - 1; i >= 0; i--) {
    xs.push(new Date(endHour.getTime() - i * 3600_000));
  }
  const byChannel = new Map();
  for (const r of flat) {
    if (!byChannel.has(r.channel)) byChannel.set(r.channel, new Map());
    byChannel.get(r.channel).set(new Date(r.bucketStart).getTime(), r.eventCount);
  }
  const series = CHART_CHANNELS.map((channel) => {
    const hourMap = byChannel.get(channel) || new Map();
    const ys = xs.map((h) => hourMap.get(h.getTime()) ?? 0);
    return { channel, ys };
  });
  return { xs, series };
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

// R158.101 — CST (UTC+8) formatter. 跟 AD 端 R158.54 EventlogView
// 1:1 平行 (LockoutAccountsView 等 dashboard axes 跟 member 端 axis
// 对齐).
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

async function openDrill(host, channel) {
  drillTarget.value = { hostname: host.hostname, channel };
  // R158.78 / R158.23 — if user clicks Security cell whose only
  // non-zero bucket is auditFailure (warning=0/err=0/audit>0), default
  // the drill to "audit-only" filter so they see the 4625/4776 rows.
  // 跟 AD 端 EventlogView openDrill 1:1 平行.
  const cell = host.cells[channel] || {};
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
      hostname: drillTarget.value.hostname,
      channel: drillTarget.value.channel,
      sinceHours: sinceHours.value,
      limit: DRILL_LIMIT
    };
    if (drillSeverity.value) params.severity = drillSeverity.value;
    // R158.78 — Security drill-down supports audit-failure filter
    // (4625/4776). auditOnly=true 跟 AD 端 R154 1:1 平行.
    if (drillAuditOnly.value) params.auditOnly = 'true';
    const r = await memberServerApi.getEventlogEvents(params);
    const payload = r.data || {};
    drillEvents.value = Array.isArray(payload.items) ? payload.items : [];
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

// R154 — auto-refetch when auditOnly flips (跟 AD 端 EventlogView 1:1 平行)
watch(drillAuditOnly, () => { if (drillTarget.value) loadDrill(); });

// R158.54 — re-render chart when trend buckets change. 跟 AD 端
// EventlogView 1:1 平行, setOption(..., true) (replace-not-merge).
watch(trendBuckets, async () => {
  await nextTick();
  renderChart();
});

onMounted(() => {
  load();
  pollHandle = setInterval(load, POLL_INTERVAL_MS);
  // R158.31 — 1Hz staleness tick. 跟 AD 端 EventlogView 1:1 平行.
  stalenessHandle = setInterval(recomputeStaleness, 1000);
});

onBeforeUnmount(() => {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = null;
  if (stalenessHandle) clearInterval(stalenessHandle);
  stalenessHandle = null;
  // R158.54 — release the ECharts instance + its resize listener. 跟
  // AD 端 EventlogView 1:1 平行.
  if (chartInstance) {
    window.removeEventListener('resize', onResize);
    chartInstance.dispose();
    chartInstance = null;
  }
});
</script>

<style scoped>
/* R158.101 (2026-10-13) — /memberServer/eventlog 拉齐 AD 端 matrix 形态.
   所有 className 跟 AD 端 EventlogView 1:1 平行 (matrix / cell-total-low
   / cell-total-mid / cell-total-high / site-section-row / drawer / etc.),
   0 用 member 旧 host-tabs class (host-tab / event-table / panel-header
   / summary-pill / level-tag / tag-warn / tag-danger), 跟 AD 端视觉
   完全对齐. */
.ms-eventlog-page { padding: 16px 0; }
.page-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
.title-block h1 { margin: 0 0 4px; font-size: 20px; color: var(--accent); }
.subtitle { margin: 0; font-size: 12px; color: var(--muted); max-width: 720px; }
.header-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.since-select { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
.since-select select { padding: 4px 8px; background: color-mix(in srgb, var(--panel) 50%, transparent); color: var(--text); border: 1px solid var(--border); border-radius: 3px; font-size: 12px; }
.last-update { font-size: 12px; color: var(--muted); font-family: monospace; }

/* R158.31 — staleness badge + refresh heartbeat dot. 跟 AD 端
   EventlogView 1:1 平行 (round-34.2 colour vocabulary). */
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

/* R158.101 — 24h event log trend chart section. 跟 AD 端 EventlogView
   R158.54 1:1 平行 (same panel + border vocabulary as .matrix-wrapper). */
.chart-section { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-bottom: 16px; }
.chart-canvas  { width: 100%; height: 280px; outline: none; }
.skeleton-chart { height: 280px; background: linear-gradient(90deg, var(--panel) 0%, var(--border) 50%, var(--panel) 100%); background-size: 200% 100%; animation: shimmer 1.5s infinite; border-radius: 4px; }

.matrix-wrapper { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.matrix { width: 100%; border-collapse: collapse; }
.matrix thead th { padding: 10px 14px; background: color-mix(in srgb, var(--panel) 70%, transparent); color: var(--muted); font-size: 12px; font-weight: 600; text-align: left; border-bottom: 1px solid var(--border); }
.matrix thead th.channel-header { text-align: center; }
.matrix tbody tr { border-bottom: 1px solid var(--border); }
.matrix tbody tr:last-child { border-bottom: none; }
.host-name { padding: 12px 14px; font-size: 13px; font-weight: 600; text-align: left; color: var(--text); white-space: nowrap; min-width: 160px; }
.host-header { padding: 12px 14px; }
.matrix tbody td { padding: 6px 8px; text-align: center; }
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
/* R158.32 — count-threshold colour scheme. 跟 AD 端 EventlogView 1:1 平行. */
.count-cell.cell-total-low  { border-color: var(--green);  background: color-mix(in srgb, var(--green)  10%, transparent); }
.count-cell.cell-total-mid  { border-color: var(--yellow); background: color-mix(in srgb, var(--yellow) 10%, transparent); }
.count-cell.cell-total-high { border-color: var(--red);    background: color-mix(in srgb, var(--red)    12%, transparent); }
.count-row { display: flex; flex-direction: column; gap: 2px; align-items: center; font-family: monospace; font-size: 13px; }
.count-warn { color: var(--hub-gold); }
.count-err  { color: var(--severity-critical-text); font-weight: 600; }
.count-audit { color: var(--accent); font-weight: 600; font-size: 11px; letter-spacing: 0.5px; }
.count-zero { font-size: 14px; }
.matrix-footer { padding: 10px 14px; background: color-mix(in srgb, var(--panel) 70%, transparent); color: var(--muted); font-size: 12px; text-align: right; }

/* R142 — site section header. 跟 AD 端 EventlogView 1:1 平行. */
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
