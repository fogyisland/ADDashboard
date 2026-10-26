<template>
  <!-- R128 — AppLayout wrapper added. R116 originally wrote the comment
       "Wrapped inside AppLayout chrome at the page level" but never
       actually wrapped the template; the route was registered and the
       sidebar router-link was added, but the view rendered as a bare
       page with no chrome. Wrap the existing <div class="osbaseline-page">
       so the sidebar + topbar (with admin entry / theme toggle / logout)
       appear alongside the matrix, same shape as DashboardView /
       ServersOverviewView / EventlogView. AppLayout is layout-only chrome
       — the inner .osbaseline-page block is unchanged. -->
  <AppLayout>
  <div class="osbaseline-page">
    <header class="page-header">
      <div class="title-block">
        <h1>OS 基线</h1>
        <p class="subtitle">
          每台 member-server 最近 {{ sinceHours }} 小时最新一次基线快照 — CPU、内存、磁盘（已使用 %）、服务、事件
        </p>
      </div>
      <div class="header-actions">
        <label class="since-select">
          时间窗口
          <select v-model.number="sinceHours" data-test="since-hours" @change="load">
            <option :value="1">最近 1 小时</option>
            <option :value="6">最近 6 小时</option>
            <option :value="24">最近 24 小时</option>
            <option :value="72">最近 3 天</option>
            <option :value="168">最近 7 天</option>
          </select>
        </label>
        <span class="last-update" v-if="lastUpdated">最后更新：{{ formatTime(lastUpdated) }}</span>
        <button class="refresh-btn" :disabled="loading" @click="load" data-test="refresh">刷新</button>
      </div>
    </header>

    <main>
      <div v-if="loading && items.length === 0" class="skeleton">
        <div v-for="i in 3" :key="i" class="skeleton-card"></div>
      </div>

      <div v-else-if="error" class="error-banner">
        <span>OS 基线加载失败</span>
        <button @click="load">重试</button>
      </div>

      <div v-else-if="items.length === 0" class="empty-state">
        暂无 OS 基线数据 — 等待内置 ad_os_baseline 包首次上报（通常 15 分钟以内）
      </div>

      <!-- R140 — site-grouped rendering. The /api/os-baseline row already
           carries siteName (the route joins ad_dcs/ad_sites); we just
           bucket cards by that field on the frontend. Cards within a
           section keep their in-card siteName label so the disambiguation
           signal isn't lost when scrolling.
           R145 (rev2) — each .site-section is a column with its server
           cards laid out HORIZONTALLY inside. .grouped-view is a flex
           row with `flex-basis: calc(50% - gap)` so exactly TWO sites
           pack per row (operator: "一行只有两个站点, 现在重点有点分散").
           Each site column shows its cards in a tight horizontal row so
           the eye doesn't bounce around. -->
      <div v-else class="grouped-view" data-test="os-baseline-grid">
        <section
          v-for="group in itemGroups"
          :key="group.siteName"
          class="site-section"
          :class="{ wide: group.cards.length > 2 }"
          :data-test="`os-section-${group.siteName}`"
        >
          <h3 class="site-section-title">
            <span class="site-name">{{ group.siteName }}</span>
            <span class="site-count">{{ group.cards.length }} 台</span>
          </h3>
          <div class="grid">
            <article
              v-for="card in group.cards"
              :key="card.agentId"
              class="card"
              :class="`status-${card.status}`"
              :data-test="`card-${card.agentId}`"
            >
              <header class="card-header">
                <div class="card-title">
                  <h2 class="host">{{ card.agentId }}</h2>
                  <p class="site">
                    <span v-if="card.siteName">{{ card.siteName }}</span>
                    <span v-else class="muted">未分配</span>
                  </p>
                </div>
                <span class="status-badge" :class="`badge-${card.status}`">{{ statusLabel(card.status) }}</span>
              </header>

              <p class="last-seen">
                <span class="label">最后上报</span>
                <time class="value">{{ formatRelative(card.lastSeenMs) }}</time>
                <span class="absolute muted">({{ formatTime(card.ts) }})</span>
              </p>

              <section class="metrics">
                <div class="metric" :class="cpuClass(card.cpuPct)">
                  <span class="metric-label">CPU</span>
                  <span class="metric-value">{{ formatPct(card.cpuPct) }}</span>
                </div>
                <div class="metric" :class="memClass(card.memoryPct)">
                  <span class="metric-label">内存</span>
                  <span class="metric-value">{{ formatPct(card.memoryPct) }}</span>
                </div>
                <!-- R158.30 — C 盘已使用 tile. BUGFIX (R158.30): this tile
                     used to read card.diskUsedPct which is the worstDrive
                     across ALL drives (D: in mixed-drive setups), giving a
                     misleading "C 盘已使用" reading that's actually D:'s.
                     Switched to card.cUsedPct (the dedicated C:-only
                     percentage the agent computes server-side) so the tile
                     label matches its value. Threshold colouring also
                     follows cUsedPct (matches the C: row in the per-drive
                     list below, which already used card.cUsedPct for its
                     metric class). diskDetail / diskWorstDrive are kept in
                     the metric-sub line so the operator still sees the
                     worst-drive info for the alerting dimension. -->
                <div class="metric" :class="diskClass(card.cUsedPct)">
                  <span class="metric-label">C 盘已使用</span>
                  <span class="metric-value">
                    <template v-if="card.cUsedPct === null">N/A</template>
                    <template v-else>{{ card.cUsedPct.toFixed(1) }}%</template>
                  </span>
                  <span v-if="card.diskDetail && card.diskDetail.length > 1" class="metric-sub">
                    最坏盘: {{ card.diskWorstDrive }}
                  </span>
                </div>
                <!-- R147 — 3 new hardware-identity metric tiles, appended in
                     the same visual rhythm as CPU / 内存 / 磁盘已使用 above.
                     All three use metric-info (no threshold colours) —
                     they're descriptive, not alerting; the threshold
                     alarm colours stay on CPU / 内存 / C 盘已使用. -->
                <div class="metric metric-info">
                  <span class="metric-label">CPU 品牌</span>
                  <span class="metric-value">
                    <template v-if="card.cpuBrandLabel">{{ card.cpuBrandLabel }}</template>
                    <template v-else>—</template>
                  </span>
                </div>
                <div class="metric metric-info">
                  <span class="metric-label">内存大小</span>
                  <span class="metric-value">
                    <template v-if="card.memTotalLabel">{{ card.memTotalLabel }}</template>
                    <template v-else>—</template>
                  </span>
                </div>
                <div class="metric metric-info">
                  <span class="metric-label">BIOS</span>
                  <span class="metric-value bios-value">
                    <template v-if="card.biosLabel">{{ card.biosLabel }}</template>
                    <template v-else>—</template>
                  </span>
                </div>
              </section>

              <!-- R158.30 — hardware-detail 2-column key-value grid. Shows 5
                   new fields: 系统品牌 / 序列号 / 机器 IP / 硬盘型号 / 内存型号.
                   Each row v-if guards against 1.0.3 老 agent (NULL). Avoids
                   inflating the .metrics flex grid (which would push cards to
                   700px+ height with 11 tiles). Monospace font on serial number
                   + disk model for easy copy-paste of S/N. -->
              <section
                v-if="card.systemLabel || card.serialNumberLabel || card.networkLabel || card.diskModelLabel || card.memoryLabel"
                class="hardware-detail"
                data-test="hardware-detail"
              >
                <template v-if="card.systemLabel">
                  <span class="detail-label">系统品牌</span>
                  <span class="detail-value">{{ card.systemLabel }}</span>
                </template>
                <template v-if="card.serialNumberLabel">
                  <span class="detail-label">序列号</span>
                  <span class="detail-value mono" :title="card.serialNumberLabel">{{ card.serialNumberLabel }}</span>
                </template>
                <template v-if="card.networkLabel">
                  <span class="detail-label">机器 IP</span>
                  <span class="detail-value mono">{{ card.networkLabel }}</span>
                </template>
                <template v-if="card.diskModelLabel">
                  <span class="detail-label">硬盘型号</span>
                  <span class="detail-value">{{ card.diskModelLabel }}</span>
                </template>
                <template v-if="card.memoryLabel">
                  <span class="detail-label">内存型号</span>
                  <span class="detail-value">{{ card.memoryLabel }}</span>
                </template>
              </section>

              <!-- R147 — per-drive physical-disk list (DriveType=3 only).
                   C: row gets the same diskClass colouring as card.cUsedPct
                   so the operator can spot a critical C: at a glance;
                   other drives render neutrally. -->
              <ul v-if="card.disksArr && card.disksArr.length > 0" class="disk-list" data-test="disk-list">
                <li
                  v-for="d in card.disksArr"
                  :key="d.letter"
                  class="disk-row"
                  :class="[d.letter === 'C:' ? diskClass(card.cUsedPct) : 'metric-normal']"
                >
                  <span class="disk-letter">{{ d.letter }}</span>
                  <span class="disk-usage">
                    {{ diskPct(d.free_bytes, d.total_bytes) != null
                       ? diskPct(d.free_bytes, d.total_bytes).toFixed(1) + '%'
                       : 'N/A' }}
                  </span>
                  <span class="disk-size">{{ formatBytes(d.free_bytes) }} / {{ formatBytes(d.total_bytes) }}</span>
                </li>
              </ul>

              <footer class="card-footer">
                <span class="chip">服务 <strong>{{ card.serviceCount }}</strong></span>
                <span class="chip">事件 <strong>{{ card.eventCount }}</strong></span>
                <span class="chip enabled" :class="{ disabled: card.enabled === false }">
                  {{ card.enabled === false ? '已禁用' : '已启用' }}
                </span>
              </footer>

              <!-- R158.29 — per-card 24h CPU + memory dual-line chart.
                   Container is always present so renderAllCharts() can
                   init/setOption against it; if the agent has no
                   series the container stays empty (no flicker). 220px
                   height matches DashboardView's hub-resources chart
                   cell so the two pages read visually consistent. -->
              <div class="os-chart" :data-chart-agent="card.agentId"></div>
            </article>
          </div>
        </section>
      </div>
    </main>
  </div>
  </AppLayout>
</template>

<script setup>
// R116 — OS Baseline 前台舰队视图 (operator directive 2026-09-26:
// "我们不需要在admin后台看到，直接在前台就可以看到" + 磁盘 50% 黄 /
// 80% 红 + Grid 卡片格式 + "两个界面都没有出现" 一次性补 sidebar 双 entry).
//
// 数据流: agent collect.ps1 → /api/agent/packages/report (X-Agent-*
// 4 头) → metricstore.ingestRunV2 → pkg_ad_os_baseline.metrics →
// /api/os-baseline (R116 route) → listOsBaseline(下面) → 卡片渲染.
//
// 磁盘口径: 收集端 (collect.ps1) 存 disk_free + disk_total (JSON object
// per-drive, **bytes** — collect.ps1:10-14 用 CIM Win32_LogicalDisk 取
// FreeSpace/Size 然后 ConvertTo-Json). 前端反向算 disk_used_pct:
//   usedPct(d) = 100 * (1 - free_bytes(d) / total_bytes(d))
// (operator 明确要求 "磁盘超过了 50% 为黄色表示,超过 80% 红色").
// Worst-case 算子: max(usedPct(d)) over all drives — 任一盘破阈即黄/红.
// 注意:disk_free 和 disk_total 必须同时存在且可解析 (任一缺失 → N/A,
// 不混入合规状态判定 — 数据问题 ≠ 合规问题).
//
// 综合合规状态: ts > 2h 离线灰; CPU≥95 OR Mem≥95 OR DiskUsed≥80 严重红;
// CPU 80-95 OR Mem 80-95 OR DiskUsed 50-80 偏高黄; else 正常绿.

import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import * as echarts from 'echarts';
import { listOsBaseline, getOsBaselineTimeseries } from '../api/os-baseline.js';
import AppLayout from '../components/AppLayout.vue';
import {
  OFFLINE_THRESHOLD_MS,
  computeStatus,
  parseDiskPair,
  worstDiskDrive,
  parseBytesObject,
  parseJson,
  parseBiosInfo,
  parseDisksArray,
  parseSystemInfo,        // R158.30
  parseNetworkInfo,       // R158.30
  parseMemoryModules,     // R158.30
  formatMemoryModulesSummary, // R158.30
  diskPct,
  formatBytes,
  statusLabel,
  cpuClass,
  memClass,
  diskClass,
  formatPct,
  formatTime,
  formatRelative
} from './os-baseline-status.js';

const POLL_INTERVAL_MS = 30 * 1000;
const DEFAULT_SINCE_HOURS = 24;

const items = ref([]);           // [{...raw, status, diskUsedPct, diskWorstDrive, diskDetail, serviceCount, eventCount, lastSeenMs, siteName, siteId, enabled}]
const sinceHours = ref(DEFAULT_SINCE_HOURS);
const loading = ref(false);
const error = ref(null);
const lastUpdated = ref(null);
let pollHandle = null;

// R158.29 — per-card 24h CPU + memory time-series. Fetched in parallel
// with the cards endpoint (same 30s poll cadence). seriesByAgent maps
// agentId → { cpu: [{ts,value}], memory: [{ts,value}] }.
const chartSeries = ref({});            // { [agentId]: { cpu, memory } }
const chartLoading = ref(false);
// key = agentId. ECharts instances persist across re-renders so the
// canvas is reused (cheaper than dispose + init every 30s tick).
const chartInstances = new Map();

// R158.29 — CST time formatter (UTC +8 hh:mm). Centre is UTC; operator
// wants Beijing time on the X-axis. Matches the same formula used on
// DashboardView (R158.7) so the per-DC hub chart and the per-card OS
// baseline chart read identically. Deterministic regardless of browser
// or centre host TZ.
const fmtTsCst = (t) => {
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return '';
  const cstH = (d.getUTCHours() + 8) % 24;
  const cstM = d.getUTCMinutes();
  return `${String(cstH).padStart(2, '0')}:${String(cstM).padStart(2, '0')}`;
};

// R140 — bucket items by siteName. "未分配" bucket holds cards whose
// siteName is null/empty (LEFT JOIN to ad_sites produced no match, or
// the source DC is not in ad_dcs).
const UNGROUPED_LABEL = '未分配';
const itemGroups = computed(() => {
  const buckets = new Map();
  for (const c of items.value) {
    const key = c.siteName || UNGROUPED_LABEL;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(c);
  }
  const out = [];
  for (const [key, list] of buckets.entries()) {
    out.push({ siteName: key, cards: list });
  }
  return out;
});

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const r = await listOsBaseline({ sinceHours: sinceHours.value });
    const payload = r && r.data ? r.data : r;
    const rawItems = Array.isArray(payload?.items) ? payload.items
      : Array.isArray(payload) ? payload
      : [];
    items.value = rawItems.map(decorate);
    lastUpdated.value = new Date();
  } catch (e) {
    error.value = e;
    if (items.value.length === 0) items.value = [];
  } finally {
    loading.value = false;
  }
}

function decorate(row) {
  const tsMs = row.ts ? Date.parse(row.ts) : NaN;
  const lastSeenMs = Number.isFinite(tsMs) ? tsMs : Date.now();
  // disk_free + disk_total 都从 row.camelCase 字段取 (route 已经把
  // snake_case 反射成 camelCase — 看 db.sql.osBaselineMetrics SELECT 字段名 +
  // rows.map 直接 spread row). 解析需要两个 JSON 同时在, 任一缺失 → null.
  const diskDetail = parseDiskPair(row.diskFree, row.diskTotal);
  const worstDrive = diskDetail.length > 0 ? worstDiskDrive(diskDetail) : null;
  const diskUsedPct = worstDrive ? worstDrive.usedPct : null;
  const services = parseJson(row.services) || {};
  const events = parseJson(row.events) || [];
  // R147 — bios / cpu brand / total mem / per-drive physical disk array.
  // 1.0.2 老 agent 不会发出这些字段 → null/空数组 → UI 渲染 "—" / 空.
  const biosInfo = parseBiosInfo(row.biosInfo);
  const disksArr = parseDisksArray(row.disks);
  const memTotalLabel = typeof row.memTotalBytes === 'number' && Number.isFinite(row.memTotalBytes)
    ? formatBytes(row.memTotalBytes) : null;

  // R158.30 — 3 new JSON columns + extended JSON fields. Rollout window:
  // 1.0.3 老 agent 不会发出 → systemInfo/networkInfo/memoryModules=null,
  // biosInfo.serial_number=null, disksArr[].model/bus_type=null.
  const systemInfo = parseSystemInfo(row.systemInfo);
  const networkInfo = parseNetworkInfo(row.networkInfo);
  const memoryModules = parseMemoryModules(row.memoryModules);

  // hardware-detail section labels (each may be null → row v-if hidden)
  const systemLabel = systemInfo.manufacturer && systemInfo.model
    ? `${systemInfo.manufacturer} ${systemInfo.model}`
    : (systemInfo.manufacturer || systemInfo.model || null);
  const serialNumberLabel = biosInfo.serial_number;
  const networkLabel = networkInfo.ipv4.length > 0 ? networkInfo.ipv4.join(', ') : null;
  // C: drive's physical disk model first; fallback to first disk's model
  const cDisk = disksArr.find((d) => d.letter === 'C:');
  const diskModelLabel = (cDisk && cDisk.model) ? cDisk.model
    : (disksArr[0] && disksArr[0].model ? disksArr[0].model : null);
  const memoryLabel = formatMemoryModulesSummary(memoryModules);

  return {
    ...row,
    status: computeStatus({
      lastSeenMs,
      nowMs: Date.now(),
      cpuPct: row.cpuPct,
      memoryPct: row.memoryPct,
      diskUsedPct
    }),
    diskUsedPct,
    diskDetail,
    diskWorstDrive: worstDrive && Number.isFinite(worstDrive.usedPct)
      ? `${worstDrive.drive}: ${worstDrive.usedPct.toFixed(1)}% 已使用 (${formatBytes(worstDrive.freeBytes)} / ${formatBytes(worstDrive.totalBytes)})`
      : null,
    serviceCount: typeof services === 'object' ? Object.keys(services).length : 0,
    eventCount: Array.isArray(events) ? events.length : 0,
    lastSeenMs,
    // R147 derived
    biosInfo,
    biosLabel: biosInfo.manufacturer && biosInfo.version
      ? `${biosInfo.manufacturer} ${biosInfo.version}`
      : (biosInfo.manufacturer || biosInfo.version || biosInfo.name || null),
    cpuBrandLabel: typeof row.cpuBrand === 'string' && row.cpuBrand.length > 0 ? row.cpuBrand : null,
    memTotalLabel,
    disksArr,
    // R158.30 derived — hardware-detail section
    systemInfo,
    networkInfo,
    memoryModules,
    systemLabel,
    serialNumberLabel,
    networkLabel,
    diskModelLabel,
    memoryLabel
  };
}

// 纯函数全部从 ./os-baseline-status.js 抽出来 (R116 v2 test plan v2-t1
// / v2-t2 / v2-t3 直接 import 这些 helpers 验证阈值). 这里只保留 Vue
// 特有的 reactive / lifecycle 部分.

// R158.29 — fetch per-agent 24h CPU/memory time-series in parallel with
// the cards endpoint. Same 30s cadence. Independent failure: if the
// chart endpoint 500s, the cards still load (and vice versa) so the
// operator doesn't lose the metric tiles.
async function loadCharts() {
  chartLoading.value = true;
  try {
    const r = await getOsBaselineTimeseries({ hours: 24 });
    const payload = r && r.data ? r.data : r;
    chartSeries.value = (payload && payload.seriesByAgent) || {};
  } catch (e) {
    // Best-effort — don't blow away the previous series on transient
    // errors; the operator can still see what we had.
    if (!Object.keys(chartSeries.value).length) chartSeries.value = {};
  } finally {
    chartLoading.value = false;
  }
}

// R158.29 — render or update the ECharts instance for every agent that
// has a chart container. Reuses instances via chartInstances Map; for
// disappeared agents (card removed from /api/os-baseline) we dispose()
// the canvas and remove from the Map. The 30s poll cadence means we
// don't have to deal with sub-second flicker — setOption(_, true) does
// a full replace which is fine for ≤2k points per chart.
//
// Chart option follows the R158.7 hub-resources template (single Y
// axis 0-100%, smooth line, CPU #38bdf8 blue / 内存 #22c55e green, CSS
// var theme).
function renderAllCharts() {
  const data = chartSeries.value || {};

  // 1. dispose + delete instances for agents that no longer have a
  //    card (rare — agent went offline and dropped out of the
  //    sinceHours window).
  for (const [agentId, inst] of chartInstances) {
    if (!data[agentId]) {
      inst.dispose();
      chartInstances.delete(agentId);
    }
  }

  // 2. init or setOption for every agent that does have a card.
  for (const agentId of Object.keys(data)) {
    const series = data[agentId];
    const isEmpty = !series.cpu.length && !series.memory.length;
    const cellEl = document.querySelector(`[data-chart-agent="${agentId}"]`);
    if (!cellEl || isEmpty) continue;
    let inst = chartInstances.get(agentId);
    if (!inst) {
      inst = echarts.init(cellEl, null, { renderer: 'canvas' });
      chartInstances.set(agentId, inst);
    }
    // xAxis timestamps come from whichever series has data (cpu first,
    // falling back to memory). Empty buckets are absent from the array,
    // so the category axis will line-break on missing 5-min slots —
    // matches hub-resources convention.
    const xs = (series.cpu.length ? series.cpu : series.memory).map((p) => p.ts);
    inst.setOption({
      grid: { left: 40, right: 12, top: 32, bottom: 24 },
      tooltip: { trigger: 'axis' },
      legend: { top: 2, textStyle: { color: 'var(--muted)' } },
      xAxis: {
        type: 'category',
        data: xs.map(fmtTsCst),
        axisLabel: { color: 'var(--muted)', fontSize: 10 },
        axisLine: { lineStyle: { color: 'var(--border)' } }
      },
      yAxis: {
        type: 'value', min: 0, max: 100,
        axisLabel: { color: 'var(--muted)', formatter: '{value}%', fontSize: 10 },
        splitLine: { lineStyle: { color: 'var(--border)' } }
      },
      series: [
        { name: 'CPU',  type: 'line', smooth: true, data: series.cpu.map((p) => p.value),    lineStyle: { color: '#38bdf8' }, symbol: 'circle', symbolSize: 3 },
        { name: '内存', type: 'line', smooth: true, data: series.memory.map((p) => p.value), lineStyle: { color: '#22c55e' }, symbol: 'circle', symbolSize: 3 }
      ]
    }, true);
  }
}

const onResize = () => {
  for (const inst of chartInstances.values()) inst.resize();
};

// R158.100.7 (2026-10-13) — watch(items) 用 flush:'post' 强制 cards DOM
//   渲染完后再 renderAllCharts. 同 MemberServerOsBaselineView, 1:1 平行.
watch(items, async () => {
  await nextTick();
  await nextTick();
  renderAllCharts();
}, { flush: 'post', deep: false });

// R158.100.7 (2026-10-13) — DROP watch(chartSeries). R158.100.6
//   并发 fetch 引入 race: loadCharts() 完成时 cards DOM 还没渲染
//   (items.value 还在 load() promise 中), watch → nextTick →
//   querySelector('[data-chart-agent="..."]') 命中 0 个 →
//   renderAllCharts 跳过. cards 渲染后 chartSeries 没变 → watch 不
//   再 fire → chart 0 渲染. 改用 onMounted + setInterval 双 belt-and-
//   braces, 显式 await nextTick() × 2 保证 cards 跟 chartSeries 都
//   反映到 DOM 后再 renderAllCharts. 1:1 平行 MemberServerOsBaselineView.
// (原 R158.29 watch 块已删除 — 不依赖 reactive watch.)

onMounted(async () => {
  // R158.100.6 (2026-10-13) — load() + loadCharts() 并发 fetch.
  await Promise.all([load(), loadCharts()]);
  // R158.100.7 — 双 nextTick. 第 1 次等 Vue flush reactive update
  //   (items + chartSeries 都被赋值), 第 2 次等 DOM 真渲染出 cards
  //   + .os-chart[data-chart-agent] 容器. 然后 renderAllCharts 能
  //   100% 命中 querySelector.
  await nextTick();
  await nextTick();
  renderAllCharts();
  pollHandle = setInterval(async () => {
    await Promise.all([load(), loadCharts()]);
    // R158.100.7 — 每次 poll 也显式 renderAllCharts, 不依赖 watch.
    await nextTick();
    await nextTick();
    renderAllCharts();
  }, POLL_INTERVAL_MS);
  window.addEventListener('resize', onResize);
});

onBeforeUnmount(() => {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = null;
  window.removeEventListener('resize', onResize);
  for (const inst of chartInstances.values()) inst.dispose();
  chartInstances.clear();
});
</script>

<style scoped>
/* R116 — auth-required regular-user surface. Wrapped inside AppLayout
   chrome at the page level; the .osbaseline-page block only sizes
   content. Theme tokens come from :root via --panel / --accent /
   --border / --muted / --green / --red / --text (same names used by
   every other auth-required view). */

.osbaseline-page { padding: 16px 0; }
.page-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
.title-block h1 { margin: 0 0 4px; font-size: 20px; color: var(--accent); }
.subtitle { margin: 0; font-size: 12px; color: var(--muted); max-width: 720px; }
.header-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.since-select { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
.since-select select { padding: 4px 8px; background: color-mix(in srgb, var(--panel) 50%, transparent); color: var(--text); border: 1px solid var(--border); border-radius: 3px; font-size: 12px; }
.last-update { font-size: 12px; color: var(--muted); font-family: monospace; }
.refresh-btn { padding: 6px 14px; background: var(--accent); color: var(--sidebar-bg); border: none; border-radius: 3px; cursor: pointer; font-weight: 600; font-size: 13px; }
.refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.skeleton { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.skeleton-card { height: 220px; background: linear-gradient(90deg, var(--panel) 0%, color-mix(in srgb, var(--panel) 70%, transparent) 50%, var(--panel) 100%); background-size: 200% 100%; animation: shimmer 1.5s infinite; border-radius: 8px; }
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

.error-banner { padding: 16px; background: var(--red, var(--danger-bg)); border-radius: 4px; display: flex; align-items: center; gap: 12px; color: var(--text); }
.error-banner button { padding: 4px 12px; background: var(--accent); color: var(--sidebar-bg); border: none; border-radius: 3px; cursor: pointer; font-weight: 600; }

.empty-state { padding: 40px; text-align: center; color: var(--muted); }

/* R145 (rev4) — exactly TWO site sections per row, each .site-section
   keeps its OWN panel container (background + border), and inside the
   panel cards are spread/distributed left-to-right (justify-content:
   space-between / space-around) so the eye doesn't see N cards cramped
   at the left edge (operator 2026-09-29: "加上站点边框，站点内的机器分
   散对齐"). Cards stay individually bordered inside the site panel. */
.grouped-view {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  /* R154 — align-items: stretch makes same-row sections equal-height so
     panel bottoms line up across the row (operator 2026-09-29
     "section 的底部要对齐, 否则很难看"). Default `flex-start` left
     sections with different card counts vertically misaligned (the
     section with 1 card stops at the card's bottom; the section with
     2-3 cards stops lower). stretch + height:100% on .card equalizes
     both section AND card heights within each section. */
  align-items: stretch;
}
.site-section {
  flex: 0 0 calc(50% - 9px);
  min-width: 480px;
  background: color-mix(in srgb, var(--panel) 35%, transparent);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px 14px;
  /* flex parent column so children (.grid) fills the section's full
     height — combined with .card height:100% the cards stretch to
     equalize within the section. */
  display: flex;
  flex-direction: column;
}
/* R146 — sites with >2 servers take a FULL row (operator 2026-09-29:
   "拥有 >2 台机器的站点独自占一行"). Small sites (≤2) keep the
   default 50% width so they pair up two-per-row. Box-sizing border-box
   guards against the wide panel overflowing the parent due to
   border + padding; min-width removed since 100% is always wider than
   480px at viewport scale. */
.site-section.wide {
  flex: 0 0 100%;
  min-width: 0;
  box-sizing: border-box;
}
/* R145 (rev4) — within a site, server cards are SPREAD across the
   panel width (justify-content: space-between) instead of stacking at
   the left edge. min-width 200px on each card so a single-server site
   doesn't shrink to 0; the panel distributes the remaining horizontal
   space evenly between cards.

   R154 — flex: 1 1 200px lets cards share remaining horizontal space
   while still wrapping on overflow; height: 100% (combined with the
   section's display:flex column + align-items:stretch on the parent)
   forces cards to equalize vertically so the lowest card's bottom edge
   lines up across all sections in the same row. */
.site-section .grid {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 12px;
  flex: 1 1 auto;
  align-items: stretch;
}
.site-section-title {
  display: flex; align-items: baseline; justify-content: space-between;
  margin: 0 0 10px;
  padding: 4px 6px;
  position: sticky; top: 0;
  background: color-mix(in srgb, var(--sidebar-bg) 92%, transparent);
  backdrop-filter: blur(2px);
  z-index: 5;
  border-radius: 4px;
}
.site-section-title .site-name { color: var(--accent); font-size: 14px; font-weight: 700; }
.site-section-title .site-count { color: var(--muted); font-size: 12px; font-family: monospace; }
.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
  /* R154 — height:100% lets the flex parent's stretch behavior pull
     every card to the section's tallest card. Combined with .site-section
     display:flex column + .grid align-items:stretch, this aligns the
     card bottoms across all sections in the same row. */
  height: 100%;
  display: flex;
  flex-direction: column;
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: border-color 120ms ease, transform 120ms ease;
  /* R145 (rev4) — flex 1 1 240px (grow, shrink, basis 240px) so cards
     share the panel width evenly when justify-content: space-between
     distributes the row. min-width 240px keeps cards readable; 3+
     cards wrap to a 2nd row inside the section. */
  flex: 1 1 240px;
  min-width: 240px;
  max-width: 100%;
}
.card:hover { border-color: var(--accent); transform: translateY(-1px); }
.card.status-critical { border-left: 4px solid var(--red); }
.card.status-warning  { border-left: 4px solid var(--yellow); }
.card.status-offline  { border-left: 4px solid var(--muted); opacity: 0.85; }
.card.status-normal   { border-left: 4px solid var(--green); }

.card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.card-title .host { margin: 0 0 2px; font-size: 16px; color: var(--text); font-weight: 700; }
.card-title .site { margin: 0; font-size: 12px; color: var(--muted); }
.muted { color: var(--muted); }

.status-badge {
  flex-shrink: 0;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.5px;
}
.badge-normal   { background: color-mix(in srgb, var(--green) 25%, transparent); color: var(--green); border: 1px solid color-mix(in srgb, var(--green) 50%, transparent); }
.badge-warning  { background: color-mix(in srgb, var(--yellow) 25%, transparent); color: var(--hub-gold); border: 1px solid color-mix(in srgb, var(--yellow) 50%, transparent); }
.badge-critical { background: color-mix(in srgb, var(--red) 25%, transparent); color: var(--severity-critical-text); border: 1px solid color-mix(in srgb, var(--red) 50%, transparent); }
.badge-offline  { background: color-mix(in srgb, var(--muted) 25%, transparent); color: var(--text); border: 1px solid color-mix(in srgb, var(--muted) 50%, transparent); }

.last-seen { margin: 0; font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.last-seen .label { color: var(--muted); }
.last-seen .value { color: var(--text); font-family: monospace; }
.last-seen .absolute { font-size: 11px; }

.metrics { display: flex; flex-direction: column; gap: 6px; }
.metric {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--panel) 50%, transparent);
  border: 1px solid var(--border);
  flex-wrap: wrap;
}
.metric-label { font-size: 11px; color: var(--muted); min-width: 70px; }
.metric-value { font-family: monospace; font-size: 14px; font-weight: 700; color: var(--text); }
.metric-sub { font-size: 11px; color: var(--muted); margin-left: auto; }
.metric-normal   .metric-value { color: var(--green); }
.metric-warning  .metric-value { color: var(--hub-gold); }
.metric-critical .metric-value { color: var(--severity-critical-text); }
.metric-na       .metric-value { color: var(--muted); font-weight: 500; }

/* R147 — .metric-info: descriptive hardware-identity tile (CPU brand /
   mem total / BIOS). NO threshold colour — these aren't alerting metrics,
   they're descriptive. Use muted foreground + normal font weight so they
   don't visually compete with the CPU / 内存 / 磁盘已使用 alarm tiles
   above them. The .bios-value rule wraps long manufacturer strings so
   they don't blow out the card width. */
.metric-info .metric-value { color: var(--text); font-weight: 600; }
.metric-info .bios-value { font-size: 13px; word-break: break-word; }

/* R147 — per-drive physical-disk list (.disk-list). Renders below the
   metrics block. Each row shows letter / used% / size; the C: row gets
   the same diskClass colouring as the card-wide c_used_pct so a critical
   C: shows red without having to scan the card for it. Other drives
   stay muted. */
.disk-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.disk-row {
  display: grid;
  grid-template-columns: 36px 56px 1fr;
  gap: 8px;
  align-items: center;
  padding: 4px 8px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--panel) 35%, transparent);
  border: 1px solid var(--border);
  font-family: monospace;
  font-size: 12px;
}
.disk-row .disk-letter { color: var(--accent); font-weight: 700; }
.disk-row .disk-usage { color: var(--text); font-weight: 600; text-align: right; }
.disk-row .disk-size { color: var(--muted); }
/* Colour C: row by the same threshold class used on the 磁盘已使用 tile */
.disk-row.metric-warning  .disk-usage { color: var(--hub-gold); }
.disk-row.metric-critical .disk-usage { color: var(--severity-critical-text); }
.disk-row.metric-na       .disk-usage { color: var(--muted); font-weight: 500; }

/* R158.30 — hardware-detail 2-column key-value grid. Uses `display: contents`
   on the row wrappers so the grid sees each (label, value) pair as 2 grid
   cells, not as a nested container. This avoids the "stuck on row 1" layout
   bug that would happen if .detail-row was a real flex/grid container. */
.hardware-detail {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: color-mix(in srgb, var(--panel) 35%, transparent);
  font-size: 11px;
}
.detail-label {
  color: var(--muted);
  white-space: nowrap;
  align-self: baseline;
}
.detail-value {
  color: var(--text);
  font-weight: 500;
  word-break: break-word;
  min-width: 0;
}
.detail-value.mono {
  font-family: ui-monospace, "Cascadia Mono", "Consolas", monospace;
  font-size: 11px;
}

.card-footer { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 4px; border-top: 1px dashed var(--border); margin-top: auto; }
.chip { padding: 3px 10px; background: color-mix(in srgb, var(--panel) 50%, transparent); border: 1px solid var(--border); border-radius: 999px; font-size: 11px; color: var(--muted); }
.chip strong { color: var(--text); margin-left: 4px; }
.chip.enabled { color: var(--green); }
.chip.disabled { color: var(--severity-critical-text); }

/* R158.29 — per-card 24h CPU + memory dual-line chart container. The
   element is always present in the template so renderAllCharts() can
   querySelector against it; ECharts fills it via init/setOption. 220px
   height matches DashboardView's hub-resources cell so the two pages
   read visually consistent. */
.os-chart {
  width: 100%;
  height: 220px;
  margin-top: 4px;
  /* Strip the focus outline ECharts leaves on the canvas — operators
     scroll past hundreds of charts per minute and don't want each one
     blinking on hover. */
  outline: none;
}
</style>