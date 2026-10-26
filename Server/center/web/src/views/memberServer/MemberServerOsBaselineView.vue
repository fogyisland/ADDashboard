<!-- R158.99.2 (2026-10-13) — member-server OS 基线 sub-tab. 1:1 mirror
     OsBaselineView.vue (R116/R158.29/R158.30) — full feature parity
     (per-site grouping, 11 metric tiles, hardware-detail 5-row
     section, per-drive disk list, 24h CPU+memory chart, footer chips).
     Reads /api/dashboard/member-os-baseline (filtered to non-AD).

     operator 2026-10-13 "复制参考AD的os-baseline，当前太少了" — copy
     AD view 1:1. Per R158.77 "不要改已经成功的前端代码": AD
     OsBaselineView.vue untouched; this file is a NEW view that grows
     from the previous (R158.77) skeletal version. Both views reuse
     helpers from /views/os-baseline-status.js so threshold colors and
     parsing stay identical. -->
<template>
  <div class="ms-osbaseline">
    <header class="page-header">
      <div class="title-block">
        <h1>OS 基线</h1>
        <p class="subtitle">
          每台非 AD member-server 最近 {{ sinceHours }} 小时最新一次基线快照 — CPU、内存、磁盘、服务、事件、硬件身份、网络
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
        <span>成员服务器 OS 基线加载失败</span>
        <button @click="load">重试</button>
      </div>

      <div v-else-if="items.length === 0" class="empty-state">
        暂无 OS 基线数据 — 等待 member-server 首次上报（通常 15 分钟以内）
      </div>

      <!-- R158.99.2 — site-grouped rendering, 1:1 with OsBaselineView's
           R145/R146/R154 grouped layout. .grouped-view packs 2 sites per
           row, .site-section.wide takes 100% for >2-card sites. Cards
           inside each section align vertically (height:100% on .card +
           align-items:stretch on parent) so panel bottoms line up. -->
      <div v-else class="grouped-view" data-test="ms-os-baseline-grid">
        <section
          v-for="group in itemGroups"
          :key="group.siteName"
          class="site-section"
          :class="{ wide: group.cards.length > 2 }"
          :data-test="`ms-section-${group.siteName}`"
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
              :data-test="`ms-os-card-${card.agentId}`"
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
                <!-- R158.99.2 — 3 metric-info tiles (CPU 品牌/内存大小/BIOS),
                     1:1 with AD view. These are descriptive, not alerting;
                     no threshold colors (same .metric-info CSS as AD). -->
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

              <!-- R158.99.2 — hardware-detail 2-column key-value grid,
                   1:1 with AD view (R158.30). 5 rows: 系统品牌/序列号/
                   机器 IP/硬盘型号/内存型号. v-if guard on each row so
                   NULL/old agent (1.0.0 5-字段) doesn't show empty rows. -->
              <section
                v-if="card.systemLabel || card.serialNumberLabel || card.networkLabel || card.diskModelLabel || card.memoryLabel"
                class="hardware-detail"
                data-test="ms-hardware-detail"
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

              <!-- R158.99.2 — per-drive physical-disk list (DriveType=3
                   only), 1:1 with AD view. C: row gets diskClass
                   colouring matching the card-wide c_used_pct tile. -->
              <ul v-if="card.disksArr && card.disksArr.length > 0" class="disk-list" data-test="ms-disk-list">
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

              <!-- R158.99.2 — per-card 24h CPU + memory dual-line chart,
                   1:1 with AD view. Container is always present so
                   renderAllCharts() can init/setOption against it;
                   220px height matches the AD view so the two pages
                   read visually consistent. -->
              <div class="os-chart" :data-chart-agent="(card.agentId || '').toLowerCase()"></div>
            </article>
          </div>
        </section>
      </div>
    </main>
  </div>
</template>

<script setup>
// R158.99.2 (2026-10-13) — 1:1 with OsBaselineView.vue /api/os-baseline
// call shape. Endpoint swap only — fetch from
// /api/dashboard/member-os-baseline (filtered to non-AD by
// ad_member_servers LEFT JOIN on the route). Decorate() pulls the
// same derived fields (biosLabel/cpuBrandLabel/memTotalLabel/
// systemLabel/serialNumberLabel/networkLabel/diskModelLabel/
// memoryLabel) the AD view does, so the hardware-detail section +
// per-drive list + 3 metric-info tiles render identically.
//
// Chart series are loaded async in parallel with cards (same 30s
// cadence as AD view). ECharts instances persist across renders via
// the chartInstances Map. CST formatter matches the AD view so the
// X-axis labels read identical (hh:mm Beijing time).

import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import * as echarts from 'echarts';
import { memberServerApi } from '../../api/member-server.js';
import {
  OFFLINE_THRESHOLD_MS,
  computeStatus,
  parseDiskPair,
  worstDiskDrive,
  parseJson,
  parseBiosInfo,
  parseDisksArray,
  parseSystemInfo,
  parseNetworkInfo,
  parseMemoryModules,
  formatMemoryModulesSummary,
  diskPct,
  formatBytes,
  statusLabel,
  cpuClass,
  memClass,
  diskClass,
  formatPct,
  formatTime,
  formatRelative
} from '../os-baseline-status.js';

const POLL_INTERVAL_MS = 30 * 1000;
const DEFAULT_SINCE_HOURS = 24;

const items = ref([]);
const sinceHours = ref(DEFAULT_SINCE_HOURS);
const loading = ref(false);
const error = ref(null);
const lastUpdated = ref(null);
let pollHandle = null;

// R158.99.2 — per-card 24h CPU + memory time-series. Fetched in
// parallel with the cards endpoint. seriesByAgent maps agentId → {cpu, memory}.
const chartSeries = ref({});
const chartLoading = ref(false);
const chartInstances = new Map();

// R158.99.2 — CST time formatter (UTC +8 hh:mm). Same formula as AD view.
const fmtTsCst = (t) => {
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return '';
  const cstH = (d.getUTCHours() + 8) % 24;
  const cstM = d.getUTCMinutes();
  return `${String(cstH).padStart(2, '0')}:${String(cstM).padStart(2, '0')}`;
};

// R158.99.2 — bucket items by siteName (same convention as AD view).
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
    const r = await memberServerApi.getOsBaseline({ sinceHours: sinceHours.value });
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
  const diskDetail = parseDiskPair(row.diskFree, row.diskTotal);
  const worstDrive = diskDetail.length > 0 ? worstDiskDrive(diskDetail) : null;
  const diskUsedPct = worstDrive ? worstDrive.usedPct : null;
  const services = parseJson(row.services) || {};
  const events = parseJson(row.events) || [];
  // R158.99.2 — 7 new JSON fields (biosInfo/cpuBrand/memTotalBytes/
  // disks/systemInfo/networkInfo/memoryModules) are now in the
  // payload; old 1.0.0 agent (5-字段) sends NULL/empty and the
  // derived labels fall back to "—" / empty list.
  const biosInfo = parseBiosInfo(row.biosInfo);
  const disksArr = parseDisksArray(row.disks);
  const memTotalLabel = typeof row.memTotalBytes === 'number' && Number.isFinite(row.memTotalBytes)
    ? formatBytes(row.memTotalBytes) : null;
  const systemInfo = parseSystemInfo(row.systemInfo);
  const networkInfo = parseNetworkInfo(row.networkInfo);
  const memoryModules = parseMemoryModules(row.memoryModules);

  // hardware-detail section labels (each may be null → row v-if hidden)
  const systemLabel = systemInfo.manufacturer && systemInfo.model
    ? `${systemInfo.manufacturer} ${systemInfo.model}`
    : (systemInfo.manufacturer || systemInfo.model || null);
  const serialNumberLabel = biosInfo.serial_number;
  const networkLabel = networkInfo.ipv4.length > 0 ? networkInfo.ipv4.join(', ') : null;
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
    biosInfo,
    biosLabel: biosInfo.manufacturer && biosInfo.version
      ? `${biosInfo.manufacturer} ${biosInfo.version}`
      : (biosInfo.manufacturer || biosInfo.version || biosInfo.name || null),
    cpuBrandLabel: typeof row.cpuBrand === 'string' && row.cpuBrand.length > 0 ? row.cpuBrand : null,
    memTotalLabel,
    disksArr,
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

// R158.99.2 — fetch per-agent 24h CPU/memory time-series in parallel
// with the cards endpoint. Independent failure: if the chart endpoint
// 500s, the cards still load.
async function loadCharts() {
  chartLoading.value = true;
  try {
    const r = await memberServerApi.getOsBaselineTimeseries({ hours: 24 });
    const payload = r && r.data ? r.data : r;
    chartSeries.value = (payload && payload.seriesByAgent) || {};
  } catch (e) {
    if (!Object.keys(chartSeries.value).length) chartSeries.value = {};
  } finally {
    chartLoading.value = false;
  }
}

function renderAllCharts() {
  const data = chartSeries.value || {};
  // R158.100.5 (2026-10-13) — case-insensitive lookup. Cards endpoint
  // (route line 402) returns agentId as DB raw casing
  // (e.g. "KDLFLPBISRV") while chart endpoint (route line 538)
  // writes seriesByAgent[agentId] from a different SELECT path —
  // Windows self-registered hostname vs COMPUTERNAME can diverge
  // in case. Always lowercase before Map lookup so a card whose
  // agentId is "KDLFLPBISrv" still finds its series. R158.99.1
  // lesson 1:1 closure: same case-insensitive Set pattern as the
  // backend cards endpoint (route line 380-382).
  const lowerData = {};
  for (const k of Object.keys(data)) lowerData[k.toLowerCase()] = data[k];
  // 1. dispose + delete instances for agents that no longer have a card.
  for (const [agentId, inst] of chartInstances) {
    if (!lowerData[agentId.toLowerCase()]) {
      inst.dispose();
      chartInstances.delete(agentId);
    }
  }
  // 2. init or setOption for every agent that does have a card.
  for (const lowerAgentId of Object.keys(lowerData)) {
    const series = lowerData[lowerAgentId];
    const isEmpty = !series.cpu.length && !series.memory.length;
    const cellEl = document.querySelector(`[data-chart-agent="${lowerAgentId}"]`);
    if (!cellEl || isEmpty) continue;
    let inst = chartInstances.get(lowerAgentId);
    if (!inst) {
      inst = echarts.init(cellEl, null, { renderer: 'canvas' });
      chartInstances.set(lowerAgentId, inst);
    }
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
//   渲染完后再 renderAllCharts. 并发 fetch 场景下 load() 跟 loadCharts()
//   各自 resolve, 哪个先不定. 如果 loadCards 先 → chartSeries 装好 →
//   renderAllCharts 跑 → 但 cards DOM 还没渲染 (items.value 还 []) →
//   querySelector 命中 0 → chart 0 渲染. R158.100.7 双 nextTick + 手动
//   renderAllCharts 仍可能 race (microtask 顺序不保证 100%). watch items
//   用 flush:'post' 等 Vue 真把 cards DOM 写完才 fire, 必晚于 cardSeries.
//   同时保留双 nextTick belt-and-braces. 1:1 平行 OsBaselineView.
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
//   反映到 DOM 后再 renderAllCharts.

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
    //   30s 后 cards 跟 chart 都 fresh, 双 nextTick 兜底 race.
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
/* R158.99.2 — 1:1 with OsBaselineView.vue style. The only difference
   is the wrapper class (.ms-osbaseline) and the data-test attribute
   prefix (ms-...); every other visual rule is identical so the two
   views read consistently side-by-side. */

.ms-osbaseline { padding: 16px 0; }
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

.error-banner { padding: 16px; background: color-mix(in srgb, var(--red, var(--danger-bg)) 30%, transparent); border: 1px solid var(--red, var(--danger-bg)); border-radius: 4px; display: flex; align-items: center; gap: 12px; color: var(--text); }
.error-banner button { padding: 4px 12px; background: var(--accent); color: var(--sidebar-bg); border: none; border-radius: 3px; cursor: pointer; font-weight: 600; }

.empty-state { padding: 40px; text-align: center; color: var(--muted); }

.grouped-view {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  align-items: stretch;
}
.site-section {
  flex: 0 0 calc(50% - 9px);
  min-width: 480px;
  background: color-mix(in srgb, var(--panel) 35%, transparent);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px 14px;
  display: flex;
  flex-direction: column;
}
.site-section.wide {
  flex: 0 0 100%;
  min-width: 0;
  box-sizing: border-box;
}
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
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: border-color 120ms ease, transform 120ms ease;
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

.metric-info .metric-value { color: var(--text); font-weight: 600; }
.metric-info .bios-value { font-size: 13px; word-break: break-word; }

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
.disk-row.metric-warning  .disk-usage { color: var(--hub-gold); }
.disk-row.metric-critical .disk-usage { color: var(--severity-critical-text); }
.disk-row.metric-na       .disk-usage { color: var(--muted); font-weight: 500; }

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

.os-chart {
  width: 100%;
  height: 220px;
  margin-top: 4px;
  outline: none;
}
</style>
