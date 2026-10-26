<template>
  <div class="rc-lockout-events">
    <header class="page-header">
      <div class="title-block">
        <h1>报表中心 · 锁定账户</h1>
        <p class="subtitle">
          Security Event 4740 · 数据源 <code>ad_lockout_events</code> · 物理全量 (默认无窗) ·
          100 行/页 · 跟 <a href="/report-center/lockout" data-test="rc-lockout-events-top-link">Top 5 聚合</a> 1:1 平行
        </p>
      </div>
      <div class="header-actions">
        <div class="filter-bar">
          <select v-model="filterDc" data-test="rc-lockout-events-dc-select" aria-label="DC">
            <option value="">全部 DC</option>
            <option v-for="d in dcOptions" :key="d.dcName" :value="d.dcName">{{ d.dcName }}<span v-if="d.isPdc"> (PDC)</span></option>
          </select>
          <input
            type="text"
            v-model.trim="searchUser"
            placeholder="账户前缀搜 (alic → alice)"
            data-test="rc-lockout-events-search"
            aria-label="账户名搜索"
          />
          <button v-if="searchUser" class="clear-btn" @click="searchUser = ''" data-test="rc-lockout-events-search-clear" aria-label="清空搜索">×</button>
        </div>
        <div class="range-toggle" role="tablist" aria-label="时间范围">
          <button :class="{ active: chartRange === 'all' }"  @click="setChartRange('all')"  data-test="rc-lockout-events-range-all">全部</button>
          <button :class="{ active: chartRange === '24h' }" @click="setChartRange('24h')" data-test="rc-lockout-events-range-24h">24小时</button>
          <button :class="{ active: chartRange === '7d' }"  @click="setChartRange('7d')"  data-test="rc-lockout-events-range-7d">7天</button>
        </div>
        <span v-if="lastUpdated" class="last-update">最后更新：{{ formatTime(lastUpdated) }}</span>
        <button class="refresh-btn" :disabled="loading" @click="load" data-test="rc-lockout-events-refresh">刷新</button>
      </div>
    </header>

    <div v-if="loading && rows.length === 0" class="rc-skeleton"></div>
    <div v-else-if="rows.length === 0" class="rc-empty">时间窗内暂无锁定流水 (默认显示全部历史)</div>
    <table v-else class="rc-table" data-test="rc-lockout-events-table">
      <thead>
        <tr>
          <th>时间</th><th>账户</th><th>姓名</th><th>工作站</th><th>DC</th><th class="num">Event ID</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(r, idx) in rows" :key="`${r.occurredAt}-${idx}`" :data-test="`rc-lockout-events-row-${idx}`">
          <td>{{ formatTs(r.occurredAt) }}</td>
          <td :title="r.sam">{{ r.sam }}</td>
          <td>{{ r.displayName || '—' }}</td>
          <td :title="r.workstationName || ''">{{ r.workstationName || '—' }}</td>
          <td>{{ r.dcName || '—' }}</td>
          <td class="num">{{ r.eventId }}</td>
        </tr>
      </tbody>
    </table>

    <footer class="pagination-bar" v-if="rows.length > 0 || hasPrev">
      <div class="page-info">
        第 <span data-test="rc-lockout-events-page-current">{{ page }}</span> 页 · 共 <span data-test="rc-lockout-events-count">{{ count }}</span> 条
        <span class="hint">· 100/页</span>
      </div>
      <div class="page-actions">
        <button :disabled="!hasPrev || loading" @click="prevPage" data-test="rc-lockout-events-prev">上一页</button>
        <button :disabled="!hasNext || loading" @click="nextPage" data-test="rc-lockout-events-next">下一页</button>
      </div>
    </footer>
  </div>
</template>

<script setup>
// R158.111.a (2026-10-16) — 锁定账户 raw event list 流水视图 (admin-only).
//   跟 ReportCenterLockoutView (Top 5 聚合) 1:1 平行二视图. 走新加
//   /api/report-center/lockout-events 端点, 100/page 手动分页, 跟
//   R158.109.b /lockout-accounts 1:1 平行 (R158.109.b 决定锁: 1.0
//   引入 element-plus, 手写 prev/next + page indicator).
//   0 改 ReportCenterLockoutView 既有 4 文件.
import { ref, onMounted, onBeforeUnmount, watch, computed } from 'vue';
import { fetchLockoutEvents, fetchDcOptions } from '../api/report-center.js';
import { formatDateTime, formatTimeOnly } from '../lib/timezone.js';

const PAGE_SIZE = 100;
const chartRange = ref('all');        // 默认全部 (跟用户 directive "从开始以来到现在所有" 1:1)
const rows = ref([]);
const count = ref(0);
const page = ref(1);
const loading = ref(false);
const lastUpdated = ref(null);
const filterDc = ref('');
const searchUser = ref('');
const dcOptions = ref([]);

const hasPrev = computed(() => page.value > 1);
const hasNext = computed(() => page.value * PAGE_SIZE < count.value);

function daysFor(range) {
  if (range === '24h') return 1;
  if (range === '7d')  return 7;
  return null;                          // all → 物理全量
}

function setChartRange(r) { if (chartRange.value !== r) { chartRange.value = r; page.value = 1; load(); } }
function prevPage() { if (hasPrev.value) { page.value -= 1; load(); } }
function nextPage() { if (hasNext.value) { page.value += 1; load(); } }

async function loadDcOptions() {
  try {
    const r = await fetchDcOptions();
    dcOptions.value = Array.isArray(r.data?.rows) ? r.data.rows : [];
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('rc lockout-events dc-options load failed', e);
    dcOptions.value = [];
  }
}

async function load() {
  loading.value = true;
  try {
    const r = await fetchLockoutEvents({
      days: daysFor(chartRange.value),
      dc: filterDc.value || null,
      q: searchUser.value || null,
      limit: PAGE_SIZE,
      offset: (page.value - 1) * PAGE_SIZE
    });
    rows.value = Array.isArray(r.data?.rows) ? r.data.rows : [];
    // 走当前页下限估算: 已加载行数累计 (R158.109.b lockout-accounts
    // 1:1 平行 — 50/page 翻页也用累加, 不真跑 COUNT 端点). 物理全量
    // ≤ 100 时 count=rows.length; > 100 时 count 累加到 rows.length.
    count.value = (page.value - 1) * PAGE_SIZE + rows.value.length;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('rc lockout-events load failed', e);
    rows.value = [];
  } finally {
    loading.value = false;
    lastUpdated.value = new Date();
  }
}

let searchDebounceHandle = null;
watch([filterDc], () => { page.value = 1; load(); });
watch(searchUser, () => {
  if (searchDebounceHandle) clearTimeout(searchDebounceHandle);
  searchDebounceHandle = setTimeout(() => { page.value = 1; load(); }, 300);
});

function formatTime(d) { if (!d) return ''; return formatTimeOnly(d, { fallback: '' }); }
function formatTs(ts) { if (!ts) return '—'; return formatDateTime(ts); }

onMounted(() => { loadDcOptions(); load(); });
onBeforeUnmount(() => { if (searchDebounceHandle) clearTimeout(searchDebounceHandle); });
</script>

<style scoped>
.rc-lockout-events { padding: 16px; }
.page-header { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; gap: 12px; }
.title-block h1 { margin: 0 0 4px; font-size: 22px; }
.title-block .subtitle { margin: 0; color: var(--muted); font-size: 12px; }
.title-block code { background: var(--panel); padding: 1px 6px; border-radius: 3px; }
.title-block a { color: var(--accent); text-decoration: none; }
.title-block a:hover { text-decoration: underline; }
.header-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.last-update { color: var(--muted); font-size: 12px; }
.filter-bar { display: inline-flex; align-items: center; gap: 6px; }
.filter-bar select,
.filter-bar input {
  background: var(--panel); color: var(--text); border: 1px solid var(--border);
  border-radius: 6px; padding: 4px 10px; font-size: 12px;
}
.filter-bar input { width: 200px; }
.filter-bar input::placeholder { color: var(--muted); }
.filter-bar select { cursor: pointer; }
.clear-btn { background: var(--panel); border: 1px solid var(--border); color: var(--muted); border-radius: 6px; padding: 0 8px; height: 26px; cursor: pointer; font-size: 14px; line-height: 1; }
.clear-btn:hover { color: var(--text); }
.range-toggle { display: inline-flex; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.range-toggle button { padding: 4px 12px; background: transparent; border: 0; color: var(--text); font-size: 12px; cursor: pointer; }
.range-toggle button.active { background: var(--accent); color: #fff; }
.refresh-btn { padding: 4px 12px; background: var(--accent); border: 0; color: #fff; border-radius: 4px; cursor: pointer; font-size: 12px; }
.refresh-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.rc-skeleton { background: var(--border); height: 240px; border-radius: 4px; opacity: 0.3; }
.rc-empty { color: var(--muted); font-size: 13px; text-align: center; padding: 40px 0; }
.rc-table { width: 100%; border-collapse: collapse; font-size: 13px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.rc-table th { text-align: left; color: var(--muted); font-weight: 500; padding: 10px 12px; border-bottom: 1px solid var(--border); background: var(--panel-2); }
.rc-table td { padding: 10px 12px; border-bottom: 1px solid var(--border); }
.rc-table tr:last-child td { border-bottom: 0; }
.rc-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.pagination-bar { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; flex-wrap: wrap; gap: 8px; }
.page-info { color: var(--muted); font-size: 12px; }
.page-info .hint { color: var(--muted); }
.page-actions { display: inline-flex; gap: 6px; }
.page-actions button { padding: 4px 12px; background: var(--panel); border: 1px solid var(--border); color: var(--text); border-radius: 4px; cursor: pointer; font-size: 12px; }
.page-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
.page-actions button:hover:not(:disabled) { background: var(--accent); color: #fff; }
</style>
