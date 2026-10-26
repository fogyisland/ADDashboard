<template>
  <div class="rc-acct-change-events">
    <header class="page-header">
      <div class="title-block">
        <h1>报表中心 · 账户变更</h1>
        <p class="subtitle">
          数据源 <code>ad_account_change</code> · 物理全量 (默认无窗) · 100 行/页 ·
          跟 <a href="/report-center/account-change" data-test="rc-acct-change-events-top-link">5 action × N day 折线</a> 1:1 平行
        </p>
      </div>
      <div class="header-actions">
        <div class="filter-bar">
          <select v-model="filterDc" data-test="rc-acct-change-events-dc-select" aria-label="DC">
            <option value="">全部 DC</option>
            <option v-for="d in dcOptions" :key="d.dcName" :value="d.dcName">{{ d.dcName }}<span v-if="d.isPdc"> (PDC)</span></option>
          </select>
          <input
            type="text"
            v-model.trim="searchUser"
            placeholder="账户前缀搜 (alic → alice)"
            data-test="rc-acct-change-events-search"
            aria-label="账户名搜索"
          />
          <button v-if="searchUser" class="clear-btn" @click="searchUser = ''" data-test="rc-acct-change-events-search-clear" aria-label="清空搜索">×</button>
        </div>
        <div class="range-toggle" role="tablist" aria-label="时间范围">
          <button :class="{ active: chartRange === 'all' }"  @click="setChartRange('all')"  data-test="rc-acct-change-events-range-all">全部</button>
          <button :class="{ active: chartRange === '24h' }" @click="setChartRange('24h')" data-test="rc-acct-change-events-range-24h">24小时</button>
          <button :class="{ active: chartRange === '7d' }"  @click="setChartRange('7d')"  data-test="rc-acct-change-events-range-7d">7天</button>
        </div>
        <span v-if="lastUpdated" class="last-update">最后更新：{{ formatTime(lastUpdated) }}</span>
        <button class="refresh-btn" :disabled="loading" @click="load" data-test="rc-acct-change-events-refresh">刷新</button>
      </div>
    </header>

    <div v-if="loading && rows.length === 0" class="rc-skeleton"></div>
    <div v-else-if="rows.length === 0" class="rc-empty">时间窗内暂无账户变更流水 (默认显示全部历史)</div>
    <table v-else class="rc-table" data-test="rc-acct-change-events-table">
      <thead>
        <tr>
          <th>变更时间</th><th>动作</th><th>账户</th><th>姓名</th><th>DC</th><th>操作人</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(r, idx) in rows" :key="`${r.changeDate}-${idx}`" :data-test="`rc-acct-change-events-row-${idx}`">
          <td>{{ formatTs(r.changeDate) }}</td>
          <td><span :class="`action-tag action-${r.action}`">{{ actionLabel(r.action) }}</span></td>
          <td :title="r.sam">{{ r.sam }}</td>
          <td>{{ r.displayName || '—' }}</td>
          <td>{{ r.dcName || '—' }}</td>
          <td>{{ r.operatorUser || '—' }}</td>
        </tr>
      </tbody>
    </table>

    <footer class="pagination-bar" v-if="rows.length > 0 || hasPrev">
      <div class="page-info">
        第 <span data-test="rc-acct-change-events-page-current">{{ page }}</span> 页 · 已加载 <span data-test="rc-acct-change-events-count">{{ count }}</span> 条
        <span class="hint">· 100/页</span>
      </div>
      <div class="page-actions">
        <button :disabled="!hasPrev || loading" @click="prevPage" data-test="rc-acct-change-events-prev">上一页</button>
        <button :disabled="!hasNext || loading" @click="nextPage" data-test="rc-acct-change-events-next">下一页</button>
      </div>
    </footer>
  </div>
</template>

<script setup>
// R158.111.a (2026-10-16) — 账户变更 raw event list 流水视图 (admin-only).
//   跟 ReportCenterLockoutEventsView / ReportCenterFailedLogonEventsView
//   1:1 平行 (用户 directive "密码错误 和账户变更 都是按照一样的方式").
//   字段跟 2 个 lockout 视图不同: action / changeDate / displayName /
//   operatorUser 走 R158.72.x.4 ship 1:1 平行.
import { ref, onMounted, onBeforeUnmount, watch, computed } from 'vue';
import { fetchAccountChangeEvents, fetchDcOptions } from '../api/report-center.js';

const PAGE_SIZE = 100;
const chartRange = ref('all');
const rows = ref([]);
const count = ref(0);
const page = ref(1);
const loading = ref(false);
const lastUpdated = ref(null);
const filterDc = ref('');
const searchUser = ref('');
const dcOptions = ref([]);

const hasPrev = computed(() => page.value > 1);
const hasNext = computed(() => rows.value.length === PAGE_SIZE);

function daysFor(range) {
  if (range === '24h') return 1;
  if (range === '7d')  return 7;
  return null;
}

// 5 action 中文标签 — 跟 PackageScheduleView 1:1 平行 (R158.72.x.6).
// 0 改后端 / wire shape.
const ACTION_LABELS = {
  created:  '创建',
  modified: '修改',
  deleted:  '删除',
  enabled:  '启用',
  disabled: '禁用'
};
function actionLabel(a) { return ACTION_LABELS[a] || a; }

function setChartRange(r) { if (chartRange.value !== r) { chartRange.value = r; page.value = 1; load(); } }
function prevPage() { if (hasPrev.value) { page.value -= 1; load(); } }
function nextPage() { if (hasNext.value) { page.value += 1; load(); } }

async function loadDcOptions() {
  try {
    const r = await fetchDcOptions();
    dcOptions.value = Array.isArray(r.data?.rows) ? r.data.rows : [];
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('rc acct-change-events dc-options load failed', e);
    dcOptions.value = [];
  }
}

async function load() {
  loading.value = true;
  try {
    const r = await fetchAccountChangeEvents({
      days: daysFor(chartRange.value),
      dc: filterDc.value || null,
      q: searchUser.value || null,
      limit: PAGE_SIZE,
      offset: (page.value - 1) * PAGE_SIZE
    });
    rows.value = Array.isArray(r.data?.rows) ? r.data.rows : [];
    count.value = (page.value - 1) * PAGE_SIZE + rows.value.length;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('rc acct-change-events load failed', e);
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

function formatTime(d) { if (!d) return ''; return new Date(d).toLocaleTimeString('zh-CN', { hour12: false }); }
function formatTs(ts) { if (!ts) return '—'; return new Date(ts).toLocaleString('zh-CN', { hour12: false }); }

onMounted(() => { loadDcOptions(); load(); });
onBeforeUnmount(() => { if (searchDebounceHandle) clearTimeout(searchDebounceHandle); });
</script>

<style scoped>
.rc-acct-change-events { padding: 16px; }
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
.action-tag { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: 500; }
.action-created  { background: rgba(34, 197, 94, 0.18);  color: #22c55e; }
.action-modified { background: rgba(59, 130, 246, 0.18); color: #3b82f6; }
.action-deleted  { background: rgba(239, 68, 68, 0.18);  color: #ef4444; }
.action-enabled  { background: rgba(34, 197, 94, 0.18);  color: #22c55e; }
.action-disabled { background: rgba(234, 179, 8, 0.18);  color: #eab308; }
.pagination-bar { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; flex-wrap: wrap; gap: 8px; }
.page-info { color: var(--muted); font-size: 12px; }
.page-info .hint { color: var(--muted); }
.page-actions { display: inline-flex; gap: 6px; }
.page-actions button { padding: 4px 12px; background: var(--panel); border: 1px solid var(--border); color: var(--text); border-radius: 4px; cursor: pointer; font-size: 12px; }
.page-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
.page-actions button:hover:not(:disabled) { background: var(--accent); color: #fff; }
</style>
