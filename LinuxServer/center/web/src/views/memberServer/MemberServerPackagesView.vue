<!-- R158.77 (2026-10-11) — member-server 包执行状态 sub-tab. Mirrors
     /packages-runs (R158.50.7 + R158.76 slicer) but reads
     /api/dashboard/member-packages-runs (scripts 预过滤 agentType='non-ad').
     Reuses WINDOW_OPTIONS / segmented-control pattern from R158.76 +
     card-grid + drawer pattern from R158.50.7.

     简化版 — 跟 AD-side 全功能版相比:
       - 0 on-demand badge (4 on-demand 包都是 AD 专用, 不出现在 non-AD fleet)
       - 0 DESCRIPTION_LABEL 中文说明 (member 包非公共说明表, fallback 即可)
       - 0 metrics-warning hint (member 包暂无此 fingerprint, 后续可加)
       - 保留: 切片器 / 卡片 / drawer level 1+2 / error banner
     -->
<template>
  <div class="ms-packages">
    <header class="page-header">
      <div class="page-titles">
        <h2 class="page-title">包运行状态</h2>
        <p class="subtitle">最近 {{ windowLabel }} 执行汇总 · 每 {{ refreshSeconds }} 秒刷新</p>
      </div>
      <div class="page-window-control" data-test="window-control">
        <button
          v-for="opt in WINDOW_OPTIONS"
          :key="opt.value"
          type="button"
          :class="['window-btn', windowMode === opt.value ? 'is-active' : '']"
          :data-test="`window-btn-${opt.value}`"
          @click="setWindow(opt.value)"
        >{{ opt.label }}</button>
      </div>
      <div class="page-meta">
        <span class="time" v-if="lastLoadedAt">{{ fmt(lastLoadedAt) }}</span>
        <span class="dot" :class="polling ? 'on' : 'off'" aria-hidden="true"></span>
      </div>
    </header>

    <div v-if="error" class="error-banner" data-test="error-banner">{{ error }}</div>

    <!-- R158.X+UI.member 折线图 (2026-10-19) — 1:1 平行 AD 端 /packages-runs
         R158.X+UI.chart + R158.X+UI.timeline + R158.X+UI.tooltip +
         R158.X+UI.zoom 4 ship 范式. MEMBER 端 timelineRecent 字段
         (member-servers-public.js:758) + limit=1000 (R158.X+UI.timeline
         ship 完) 已 100% 闭合, 0 必后端改. Flavour A 单实例 ECharts
         1:1 平行 AD 端 (OsBaselineView R158.100.7 范式). -->
    <div
      v-if="packages.length"
      class="timeline-chart-card"
      data-test="timeline-chart-card"
    >
      <header class="timeline-chart-header">
        <h3 class="timeline-chart-title">包执行时间线</h3>
        <div class="timeline-chart-legend">
          <span
            v-for="p in (packagesFilter ? filteredTimelinePackages : allTimelinePackages)"
            :key="p.name"
            class="timeline-legend-item"
          >
            <span class="timeline-legend-dot" :style="{ background: p.color }"></span>
            <span class="timeline-legend-name">{{ p.name }}</span>
            <span class="timeline-legend-count">{{ p.runCount }}</span>
          </span>
          <button
            v-if="packagesFilter"
            type="button"
            class="timeline-clear-filter"
            @click="clearTimelineFilter"
            data-test="timeline-clear-filter"
          >显示全部</button>
        </div>
      </header>
      <div ref="timelineChartEl" class="timeline-chart-canvas" data-test="timeline-chart"></div>
      <p v-if="!timelineHasData" class="timeline-chart-empty" data-test="timeline-chart-empty">
        {{ timelineEmptyMessage }}
      </p>
    </div>

    <div v-if="!packages.length && !error" class="empty" data-test="empty">
      暂无非 AD 包 — 等待非 AD 部署包上线并完成首次上报
    </div>

    <div v-if="packages.length" class="card-grid" data-test="card-grid">
      <article
        v-for="p in packages"
        :key="p.name"
        :class="['card', `card-${statusClass(p)}`, selectedPackage?.name === p.name ? 'is-selected' : '', packagesFilter === p.name ? 'is-timeline-filtered' : '']"
        :data-test="`card-${p.name}`"
        @click="selectPackage(p); toggleTimelineFilter(p.name)"
      >
        <header class="card-header">
          <div class="card-title">
            <h3 class="card-name">{{ p.name }}</h3>
            <span class="card-version">v{{ p.version || '—' }}</span>
          </div>
          <span :class="['status-pill', `pill-${statusClass(p)}`]" :data-test="`pill-${p.name}`">
            {{ statusLabel(p) }}
          </span>
        </header>

        <p class="card-desc" :data-test="`desc-${p.name}`">{{ descriptionLabel(p.description, p.type) }}</p>

        <div class="card-meta">
          <span class="meta-row">
            <span class="meta-label">类型</span>
            <span class="meta-value">{{ typeLabel(p.type) }}</span>
          </span>
          <span class="meta-row">
            <span class="meta-label">Agent</span>
            <span class="meta-value">{{ agentTypeLabel(p.agentType) }}</span>
          </span>
        </div>

        <div class="summary" :data-test="`summary-${p.name}`">
          <span class="summary-item">
            <span class="summary-num summary-success">{{ p.summary24h.success }}</span>
            <span class="summary-label">成功</span>
          </span>
          <span class="summary-item">
            <span class="summary-num summary-failure">{{ p.summary24h.failure }}</span>
            <span class="summary-label">失败</span>
          </span>
          <span class="summary-item">
            <span class="summary-num summary-partial">{{ p.summary24h.partial }}</span>
            <span class="summary-label">部分</span>
          </span>
          <span class="summary-item summary-divider"></span>
          <span class="summary-item">
            <span class="summary-num">{{ p.summary24h.total }}</span>
            <span class="summary-label">总计</span>
          </span>
          <span class="summary-item summary-spacer"></span>
          <span class="summary-item">
            <span class="summary-label">最近执行</span>
            <span class="summary-value">{{ p.summary24h.lastRunAt ? fmt(p.summary24h.lastRunAt) : '—' }}</span>
          </span>
        </div>

        <div class="card-footer">
          <span class="card-hint">点击查看最近 {{ p.recent.length }} 次执行明细 →</span>
        </div>
      </article>
    </div>

    <transition name="drawer">
      <aside
        v-if="selectedPackage"
        class="drawer"
        role="complementary"
        :data-test="`drawer-${selectedPackage.name}`"
      >
        <header class="drawer-header">
          <div class="drawer-titles">
            <h3 class="drawer-title">
              {{ selectedPackage.name }}
              <span class="drawer-version">v{{ selectedPackage.version || '—' }}</span>
            </h3>
            <p class="drawer-subtitle">{{ statusLabel(selectedPackage) }} · {{ descriptionLabel(selectedPackage.description, selectedPackage.type) }}</p>
          </div>
          <button class="drawer-close" type="button" @click="closeDrawer" aria-label="关闭">✕</button>
        </header>

        <section v-if="!selectedRun" class="drawer-body" :data-test="`runlist-${selectedPackage.name}`">
          <h4 class="drawer-h4">最近 {{ selectedPackage.recent.length }} 次执行 · 点行查看完整 stdout / stderr</h4>
          <table class="recent-table">
            <thead>
              <tr>
                <th class="col-time">开始</th>
                <th class="col-agent">Agent</th>
                <th class="col-ver">版本</th>
                <th class="col-status">结果</th>
                <th class="col-dur">耗时</th>
                <th class="col-err">错误/输出</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in selectedPackage.recent"
                :key="r.id"
                :class="['recent-row', `recent-${runClass(r)}`]"
                :data-test="`runrow-${r.id}`"
                @click="selectRun(r)"
              >
                <td class="col-time">{{ shortTime(r.startedAt) }}</td>
                <td class="col-agent">{{ r.agentId }}</td>
                <td class="col-ver">
                  <span :class="['run-version', r.scriptVersion && r.scriptVersion !== selectedPackage.version ? 'is-stale' : '']">
                    v{{ r.scriptVersion || '—' }}
                  </span>
                </td>
                <td class="col-status">
                  <span :class="['run-glyph', `run-${runClass(r)}`]">{{ runGlyph(r) }}</span>
                  <span class="run-label">{{ runLabel(r) }}</span>
                </td>
                <td class="col-dur">{{ r.durationMs != null ? `${r.durationMs}ms` : '—' }}</td>
                <td class="col-err-list">
                  <code v-if="runClass(r) === 'err' && r.error" class="error" :title="r.error">{{ truncate(r.error, 200) }}</code>
                  <code v-else-if="runClass(r) === 'err' && r.stderrPreview" class="error" :title="r.stderrPreview">{{ truncate(r.stderrPreview, 200) }}</code>
                  <code v-else-if="r.stdoutPreview" class="stdout" :title="r.stdoutPreview">{{ truncate(r.stdoutPreview, 200) }}</code>
                  <span v-else>—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section v-else class="drawer-body" :data-test="`rundetail-${selectedRun.id}`">
          <button class="back-btn" type="button" @click="selectedRun = null">← 返回列表</button>
          <h4 class="drawer-h4">
            <span :class="['run-glyph', `run-${runClass(selectedRun)}`]">{{ runGlyph(selectedRun) }}</span>
            {{ selectedRun.agentId }} · v{{ selectedRun.scriptVersion || '—' }} · exit {{ selectedRun.exitCode }} · {{ shortTime(selectedRun.startedAt) }}
          </h4>
          <section class="detail-block">
            <header class="detail-h">错误摘要</header>
            <pre v-if="selectedRun.error" class="detail-pre detail-error">{{ selectedRun.error }}</pre>
            <pre v-else class="detail-pre detail-empty">无错误摘要</pre>
          </section>
          <section class="detail-block">
            <header class="detail-h">stderr</header>
            <pre v-if="selectedRun.stderrPreview" class="detail-pre">{{ selectedRun.stderrPreview }}</pre>
            <pre v-else class="detail-pre detail-empty">无 stderr</pre>
          </section>
          <section class="detail-block">
            <header class="detail-h">stdout</header>
            <pre v-if="selectedRun.stdoutPreview" class="detail-pre">{{ selectedRun.stdoutPreview }}</pre>
            <pre v-else class="detail-pre detail-empty">无 stdout</pre>
          </section>
          <section class="detail-block detail-meta">
            <header class="detail-h">元数据</header>
            <div class="detail-meta-grid">
              <div><span class="meta-label">run id</span> <code>{{ selectedRun.id }}</code></div>
              <div><span class="meta-label">agent</span> <code>{{ selectedRun.agentId }}</code></div>
              <div><span class="meta-label">package</span> <code>{{ selectedPackage.name }}</code></div>
              <div><span class="meta-label">version</span> <code>v{{ selectedRun.scriptVersion || '—' }}</code></div>
              <div><span class="meta-label">exitCode</span> <code>{{ selectedRun.exitCode }}</code></div>
              <div><span class="meta-label">durationMs</span> <code>{{ selectedRun.durationMs ?? '—' }}</code></div>
              <div><span class="meta-label">startedAt</span> <code>{{ selectedRun.startedAt }}</code></div>
              <div><span class="meta-label">finishedAt</span> <code>{{ selectedRun.finishedAt || '—' }}</code></div>
            </div>
          </section>
        </section>
      </aside>
    </transition>
    <transition name="fade">
      <div v-if="selectedPackage" class="drawer-overlay" @click="closeDrawer"></div>
    </transition>
  </div>
</template>

<script setup>
// R158.77 — 包 sub-tab. Reuses R158.76 WINDOW_OPTIONS + R158.50.7 card-grid +
// drawer pattern. Endpoint: /api/dashboard/member-packages-runs (scripts
// pre-filtered to agentType='non-ad'). 0 on-demand badge / 0 DESCRIPTION_LABEL
// — member 包是 R158.75-noad bundle 内置 ad-os-baseline + member run-script,
// 跟 AD 4 个 on-demand 包 (ad_ad_*) 无关.

import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import * as echarts from 'echarts';
import { memberServerApi } from '../../api/member-server.js';

const packages = ref([]);
const refreshSeconds = ref(10);
const lastLoadedAt = ref(null);
const error = ref('');
const polling = ref(false);
const selectedPackage = ref(null);
const selectedRun = ref(null);

const WINDOW_OPTIONS = [
  { value: '24h', label: '24 小时' },
  { value: '7d',  label: '7 天' },
  { value: 'all', label: '全部' }
];
const windowMode = ref('24h');
const windowLabel = ref('24 小时');

let timerHandle = null;

const TYPE_LABEL = { gauge: '指标', counter: '计数器', status: '状态', timeseries: '时序' };
const AGENT_TYPE_LABEL = { ad: '域控', 'non-ad': '成员服务器' };

function typeLabel(t) {
  if (t == null || t === '') return '—';
  return TYPE_LABEL[t] || `${t}`;
}
function agentTypeLabel(a) {
  if (a == null || a === '') return '—';
  return AGENT_TYPE_LABEL[a] || `${a}`;
}
function descriptionLabel(original, type) {
  if (original) return original;
  const t = TYPE_LABEL[type] || '包';
  return `用户上传${t}`;
}

function statusClass(p) {
  const s = p.summary24h;
  if (s.total === 0) return 'none';
  if (s.failure > 0) return 'err';
  if (s.partial > 0) return 'warn';
  return 'ok';
}
function statusLabel(p) {
  const s = p.summary24h;
  if (s.total === 0) return '无数据';
  if (s.failure > 0) return `${s.failure} 失败`;
  if (s.partial > 0) return `${s.partial} 部分`;
  return '全部成功';
}
function runClass(r) {
  if (r.status === 'failed') return 'err';
  if (r.status === 'partial') return 'warn';
  if (r.status === 'success') return 'ok';
  if (r.status === 'running') return 'warn';
  if (r.exitCode === 0) return 'ok';
  if (r.exitCode == null) return 'warn';
  return 'err';
}
function runGlyph(r) {
  const cls = runClass(r);
  if (cls === 'err') return '✕';
  if (cls === 'warn') return '!';
  return '✓';
}
function runLabel(r) {
  if (r.status === 'failed') return '失败';
  if (r.status === 'partial') return '部分';
  if (r.status === 'running') return '运行中';
  if (r.exitCode === 0) return '成功';
  if (r.exitCode == null) return '部分';
  return '失败';
}
function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
function fmt(s) {
  if (!s) return '—';
  return new Date(s).toLocaleString('zh-CN', { hour12: false });
}
function shortTime(s) {
  if (!s) return '—';
  return new Date(s).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function selectPackage(p) {
  selectedPackage.value = p;
  selectedRun.value = null;
}
function selectRun(r) {
  selectedRun.value = r;
}
function closeDrawer() {
  selectedPackage.value = null;
  selectedRun.value = null;
}

async function load() {
  polling.value = true;
  error.value = '';
  try {
    const r = await memberServerApi.getPackagesRuns({ window: windowMode.value });
    const fresh = Array.isArray(r.data?.packages) ? r.data.packages : [];
    refreshSeconds.value = Number(r.data?.refreshSeconds) || 10;
    const backendLabel = r.data?.windowLabel;
    if (backendLabel) {
      windowLabel.value = backendLabel;
    } else {
      const opt = WINDOW_OPTIONS.find(o => o.value === windowMode.value);
      if (opt) windowLabel.value = opt.label;
    }
    const selName = selectedPackage.value?.name;
    packages.value = fresh;
    if (selName) {
      const next = fresh.find(p => p.name === selName);
      if (next) selectedPackage.value = next;
      else closeDrawer();
    }
    lastLoadedAt.value = new Date().toISOString();
  } catch (e) {
    error.value = e?.response?.data?.error || '加载失败';
  } finally {
    polling.value = false;
  }
}

function setWindow(value) {
  if (windowMode.value === value) return;
  windowMode.value = value;
  load();
}

function onKey(e) {
  if (e.key === 'Escape') closeDrawer();
}

// === R158.X+UI.member 折线图 (2026-10-19) — 1:1 平行 AD 端 ===
// R158.X+UI.chart + R158.X+UI.timeline + R158.X+UI.tooltip + R158.X+UI.zoom
// 4 ship 范式. 0 改后端 (MEMBER 端 timelineRecent 字段 R158.X+UI.timeline
// ship 完, 跟 AD 端 1:1 平行, R158.86/92/99.3 锁). Flavour A 单实例 ECharts.
const timelineChartEl = ref(null);
let timelineChartInstance = null;
const packagesFilter = ref(null); // string | null
const TIMELINE_PALETTE = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#06b6d4', '#84cc16',
  '#a855f7', '#eab308', '#0ea5e9', '#22c55e'
];
// buildTimelineSeries — 1:1 平行 AD 端 PackageRunsMonitorView.
// data 源 = pkg.timelineRecent (MEMBER 端 R158.X+UI.timeline ship 加字段),
// fallback pkg.recent (老 envelope shape 兼容). MEMBER 端 agentId === hostname.
function buildTimelineSeries(pkgs, filterName) {
  if (!pkgs || pkgs.length === 0) return [];
  const filtered = filterName ? pkgs.filter(p => p.name === filterName) : pkgs;
  return filtered.map((pkg, idx) => {
    const data = pkg.timelineRecent || pkg.recent || [];
    const points = data
      .filter(r => r.startedAt)
      .map(r => {
        const status = r.status
          || (r.exitCode === 0 ? 'success'
              : r.exitCode == null ? 'partial'
              : 'failed');
        const errTrim = r.error ? String(r.error).slice(0, 80) : null;
        return {
          value: [r.startedAt, r.durationMs ?? 0],
          agentId: r.agentId || null,
          status,
          exitCode: r.exitCode,
          error: errTrim
        };
      });
    return {
      name: pkg.name,
      color: TIMELINE_PALETTE[idx % TIMELINE_PALETTE.length],
      points,
      runCount: points.length
    };
  });
}
const allTimelinePackages = computed(() => buildTimelineSeries(packages.value, null));
const filteredTimelinePackages = computed(() => buildTimelineSeries(packages.value, packagesFilter.value));
const timelineHasData = computed(() => allTimelinePackages.value.some(p => p.points.length > 0));
const timelineEmptyMessage = computed(() => {
  if (!packages.value || packages.value.length === 0) return '加载中…';
  if (packagesFilter.value) {
    const pkg = packages.value.find(p => p.name === packagesFilter.value);
    return pkg ? `${pkg.name} 在所选窗口内无执行记录` : '加载中…';
  }
  return '所选窗口内无包执行记录';
});
const onTimelineResize = () => { if (timelineChartInstance) timelineChartInstance.resize(); };
function renderTimelineChart() {
  if (!timelineChartEl.value) return;
  if (!timelineHasData.value) {
    if (timelineChartInstance) {
      timelineChartInstance.dispose();
      timelineChartInstance = null;
    }
    return;
  }
  if (timelineChartInstance && timelineChartInstance.getDom() !== timelineChartEl.value) {
    timelineChartInstance.dispose();
    timelineChartInstance = null;
  }
  if (!timelineChartInstance) {
    timelineChartInstance = echarts.init(timelineChartEl.value, null, { renderer: 'canvas' });
    window.addEventListener('resize', onTimelineResize);
  }
  const seriesList = packagesFilter.value
    ? filteredTimelinePackages.value
    : allTimelinePackages.value;
  const series = seriesList.map(p => ({
    name: p.name,
    type: 'line',
    data: p.points.map(pt => ({
      value: pt.value,
      agentId: pt.agentId,
      status: pt.status,
      exitCode: pt.exitCode,
      error: pt.error,
      itemStyle: {
        color: pt.status === 'success' ? '#10b981'
              : pt.status === 'failed'  ? '#ef4444'
              : pt.status === 'partial' ? '#f59e0b'
              : '#3b82f6'
      }
    })),
    lineStyle: { color: p.color, width: 2, opacity: 0.6 },
    itemStyle: { color: p.color },
    symbolSize: 7,
    smooth: false,
    showSymbol: true,
    emphasis: { focus: 'series' }
  }));
  const option = {
    tooltip: {
      trigger: 'item',
      formatter: (params) => {
        const v = Array.isArray(params.value) ? params.value : [null, null];
        const ts = v[0];
        const dur = v[1];
        const tsStr = ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—';
        const d = params.data || {};
        const agentLabel = d.agentId || '—';
        const statusKey = d.status || 'unknown';
        const statusText = ({ success: '成功', failed: '失败', partial: '部分', running: '运行中' })[statusKey] || statusKey;
        const statusColor = statusKey === 'success' ? '#10b981'
                          : statusKey === 'failed'  ? '#ef4444'
                          : statusKey === 'partial' ? '#f59e0b'
                          : '#3b82f6';
        const errLine = d.error
          ? `<br/><span style="color:#ef4444">错误: ${escapeHtml(d.error)}${String(d.error).length >= 80 ? '…' : ''}</span>`
          : '';
        return `<b>${params.seriesName}</b>`
             + `<br/>机器: <code>${escapeHtml(agentLabel)}</code>`
             + `<br/>${tsStr}`
             + `<br/>耗时: ${dur != null ? dur + ' ms' : '—'}`
             + `<br/>状态: <span style="color:${statusColor};font-weight:600">${statusText}</span>`
             + errLine;
      }
    },
    xAxis: { type: 'time' },
    yAxis: {
      type: 'value',
      name: '耗时 (ms)',
      nameLocation: 'middle',
      nameGap: 40
    },
    // R158.X+UI.zoom (2026-10-19) — dataZoom 双组件. 1:1 平行 AD 端
    // (R158.X+UI.zoom ship). inside (滚轮+框选) + slider (底部滑块).
    dataZoom: [
      { type: 'inside', xAxisIndex: 0, zoomLock: false, throttle: 50 },
      {
        type: 'slider', xAxisIndex: 0, bottom: 8, height: 24,
        start: 0, end: 100, showDetail: true,
        handleStyle: { color: '#3b82f6', borderColor: '#1d4ed8' },
        fillerColor: 'rgba(59, 130, 246, 0.15)',
        borderColor: '#94a3b8',
        textStyle: { color: '#475569', fontSize: 11 }
      }
    ],
    series,
    legend: { show: false },
    grid: { left: 70, right: 30, top: 20, bottom: 80 }
  };
  timelineChartInstance.setOption(option, true);
}
function toggleTimelineFilter(pkgName) {
  packagesFilter.value = packagesFilter.value === pkgName ? null : pkgName;
  nextTick(() => renderTimelineChart());
}
function clearTimelineFilter() {
  packagesFilter.value = null;
  nextTick(() => renderTimelineChart());
}
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
// === R158.X+UI.member 折线图 (end) ===

onMounted(async () => {
  await load();
  await nextTick();
  renderTimelineChart();
  timerHandle = setInterval(async () => {
    await load();
    await nextTick();
    renderTimelineChart();
  }, refreshSeconds.value * 1000);
  window.addEventListener('keydown', onKey);
});
onUnmounted(() => {
  if (timerHandle) clearInterval(timerHandle);
  if (timelineChartInstance) {
    timelineChartInstance.dispose();
    timelineChartInstance = null;
  }
  window.removeEventListener('resize', onTimelineResize);
  window.removeEventListener('keydown', onKey);
});
</script>

<style scoped>
/* R158.77 — reuses the same .page-* / .card-* / .drawer-* tokens as
   /packages-runs (R158.50.7 + R158.76). Visual parity so operator can
   mentally treat the two views as the same surface with different
   fleet scope. */

.page-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 16px; margin-bottom: 14px;
}
.page-titles { display: flex; flex-direction: column; gap: 2px; }
.page-title {
  margin: 0; font-size: 18px; font-weight: 600; color: var(--text);
  letter-spacing: -0.005em;
}
.subtitle { margin: 0; font-size: 12px; color: var(--muted); }
.page-meta {
  display: flex; align-items: center; gap: 8px;
  font-size: 11px; color: var(--muted);
  font-family: ui-monospace, "SF Mono", monospace;
}
.dot { width: 6px; height: 6px; border-radius: 50%; }
.dot.on  { background: var(--green); }
.dot.off { background: var(--muted); }

.error-banner {
  background: color-mix(in srgb, var(--red) 12%, transparent); color: var(--red);
  padding: 8px 12px; border-radius: 4px; margin-bottom: 12px;
  border: 1px solid color-mix(in srgb, var(--red) 30%, transparent); font-size: 12px;
}
.empty {
  text-align: center; color: var(--muted);
  padding: 32px; font-size: 13px;
  background: var(--panel-alt); border: 1px solid var(--border);
  border-radius: 4px;
}

/* R158.X+UI.member (2026-10-19) — 折线图 card. 1:1 平行 AD 端
   PackageRunsMonitorView .timeline-* 范式. */
.timeline-chart-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 12px 14px;
  margin-bottom: 14px;
  display: flex; flex-direction: column; gap: 10px;
}
.timeline-chart-header {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  flex-wrap: wrap;
}
.timeline-chart-title {
  margin: 0; font-size: 13px; font-weight: 600; color: var(--text);
  letter-spacing: -0.005em;
}
.timeline-chart-legend {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  font-size: 11px; color: var(--muted);
}
.timeline-legend-item {
  display: inline-flex; align-items: center; gap: 5px;
  font-family: ui-monospace, "SF Mono", monospace;
}
.timeline-legend-dot {
  display: inline-block; width: 9px; height: 9px; border-radius: 50%;
}
.timeline-legend-name { color: var(--text); }
.timeline-legend-count { color: var(--muted); font-size: 10px; }
.timeline-clear-filter {
  background: transparent; border: 1px solid var(--border); color: var(--text);
  font-size: 11px; padding: 3px 10px; border-radius: 3px; cursor: pointer;
}
.timeline-clear-filter:hover { border-color: var(--accent); color: var(--accent); }
.timeline-chart-canvas {
  width: 100%; height: 320px;
}
.timeline-chart-empty {
  margin: 0; font-size: 12px; color: var(--muted);
  padding: 8px 0; text-align: center;
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  grid-auto-rows: auto;
  gap: 14px;
}

.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 14px 16px;
  display: flex; flex-direction: column; gap: 10px;
  cursor: pointer;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.card:hover { border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); }
.card.is-selected { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent); }
/* R158.X+UI.member (2026-10-19) — card click 联动 timeline filter
   高亮. 1:1 平行 AD 端 PackageRunsMonitorView .card.is-timeline-filtered 范式. */
.card.is-timeline-filtered { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.card-err { border-left: 3px solid var(--red); }
.card-warn { border-left: 3px solid var(--yellow); }
.card-ok { border-left: 3px solid var(--green); }
.card-none { border-left: 3px solid var(--muted); }

.card-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 12px;
}
.card-title { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.card-name {
  margin: 0; font-size: 14px; font-weight: 600;
  color: var(--text); font-family: ui-monospace, "SF Mono", monospace;
}
.card-version {
  font-size: 11px; color: var(--muted);
  font-family: ui-monospace, "SF Mono", monospace;
}

.status-pill {
  font-size: 11px; font-weight: 600;
  padding: 3px 10px; border-radius: 999px;
  white-space: nowrap;
}
.pill-ok   { background: color-mix(in srgb, var(--green) 18%, transparent); color: var(--status-pill-fg-ok); }
.pill-warn { background: color-mix(in srgb, var(--yellow) 22%, transparent); color: var(--status-pill-fg-warn); }
.pill-err  { background: color-mix(in srgb, var(--red) 22%, transparent); color: var(--status-pill-fg-err); }
.pill-none { background: var(--panel-alt); color: var(--muted); }

.card-desc {
  margin: 0; font-size: 12px; color: var(--muted);
  line-height: 1.5; min-height: 18px;
  overflow-wrap: anywhere;
}

.card-meta {
  display: flex; gap: 16px; flex-wrap: wrap;
  font-size: 11px; color: var(--muted);
}
.meta-row { display: inline-flex; gap: 4px; align-items: baseline; }
.meta-label { color: var(--muted); }
.meta-value {
  color: var(--text); font-weight: 500;
  font-family: ui-monospace, "SF Mono", monospace;
}

.summary {
  display: flex; align-items: center; flex-wrap: wrap;
  gap: 14px;
  padding: 8px 10px;
  background: var(--panel-alt);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 11px;
}
.summary-item { display: inline-flex; align-items: baseline; gap: 4px; }
.summary-num {
  font-family: ui-monospace, "SF Mono", monospace;
  font-feature-settings: "tnum";
  font-weight: 600; color: var(--text);
}
.summary-success { color: var(--status-pill-fg-ok); }
.summary-failure { color: var(--status-pill-fg-err); }
.summary-partial { color: var(--status-pill-fg-warn); }
.summary-label { color: var(--muted); }
.summary-value {
  color: var(--text); font-weight: 500;
  font-family: ui-monospace, "SF Mono", monospace;
}
.summary-divider { width: 1px; height: 14px; background: var(--border); }
.summary-spacer { flex: 1; }

.card-footer {
  margin-top: auto; padding-top: 4px;
  border-top: 1px dashed var(--border);
  text-align: right;
  font-size: 11px; color: var(--muted);
}
.card-hint { font-style: italic; }

/* Drawer */
.drawer-overlay {
  position: fixed; inset: 0;
  background: color-mix(in srgb, black 30%, transparent);
  z-index: 40;
}
.drawer {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  width: min(720px, 90vw);
  background: var(--panel);
  border-left: 1px solid var(--border);
  box-shadow: -8px 0 24px color-mix(in srgb, black 18%, transparent);
  z-index: 41;
  display: flex; flex-direction: column;
  overflow: hidden;
}
.drawer-enter-active, .drawer-leave-active { transition: transform 220ms ease; }
.drawer-enter-from, .drawer-leave-to { transform: translateX(100%); }
.fade-enter-active, .fade-leave-active { transition: opacity 180ms ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

.drawer-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-alt);
}
.drawer-titles { flex: 1; min-width: 0; }
.drawer-title {
  margin: 0; font-size: 15px; font-weight: 600;
  color: var(--text);
  font-family: ui-monospace, "SF Mono", monospace;
}
.drawer-version {
  font-size: 11px; color: var(--muted);
  font-family: ui-monospace, "SF Mono", monospace;
  margin-left: 4px;
}
.drawer-subtitle {
  margin: 4px 0 0; font-size: 11px; color: var(--muted);
}

.page-window-control {
  display: inline-flex;
  background: var(--panel-alt);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 2px;
  gap: 2px;
  align-self: flex-start;
  margin-top: 2px;
}
.window-btn {
  background: transparent;
  border: none;
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  transition: background-color 120ms, color 120ms;
  font-family: inherit;
}
.window-btn:hover {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--text);
}
.window-btn.is-active {
  background: var(--panel);
  color: var(--accent);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
.drawer-close {
  background: transparent; border: 1px solid var(--border);
  color: var(--text); font-size: 13px;
  width: 28px; height: 28px; border-radius: 4px;
  cursor: pointer;
}
.drawer-close:hover { background: var(--panel-alt); }

.drawer-body {
  flex: 1; min-height: 0; overflow: auto;
  padding: 14px 18px;
}
.drawer-h4 {
  margin: 0 0 10px;
  font-size: 12px; font-weight: 500;
  color: var(--muted);
  text-transform: uppercase; letter-spacing: 0.05em;
}

.back-btn {
  background: transparent; border: 1px solid var(--border);
  color: var(--text); font-size: 12px;
  padding: 4px 10px; border-radius: 4px;
  cursor: pointer; margin-bottom: 12px;
}
.back-btn:hover { background: var(--panel-alt); }

/* Run list */
.recent-table {
  width: 100%; border-collapse: collapse;
  font-size: 11px;
  font-family: ui-monospace, "SF Mono", monospace;
  font-feature-settings: "tnum";
}
.recent-table thead th {
  text-align: left; padding: 5px 6px;
  font-size: 10px; color: var(--muted);
  font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em;
  border-bottom: 1px solid var(--border);
  background: var(--panel-alt);
}
.recent-table td {
  padding: 6px 6px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
.recent-row { cursor: pointer; }
.recent-row:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
.recent-row-err  { background: color-mix(in srgb, var(--red) 6%, transparent); }
.recent-row-warn { background: color-mix(in srgb, var(--yellow) 6%, transparent); }
.recent-row-ok   { background: transparent; }

.col-time { white-space: nowrap; color: var(--text); }
.col-agent { color: var(--text); }
.col-ver { white-space: nowrap; color: var(--muted); }
.run-version {
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 2px;
  background: var(--panel-alt);
  color: var(--text);
}
.run-version.is-stale {
  background: color-mix(in srgb, var(--yellow) 18%, transparent);
  color: var(--status-pill-fg-warn);
}
.col-status { white-space: nowrap; }
.col-dur { white-space: nowrap; color: var(--muted); }
.col-err-list { max-width: 360px; }
.col-err-list code {
  display: inline-block; max-width: 360px;
  font-size: 10px; color: var(--text);
  background: var(--panel-alt);
  padding: 2px 5px; border-radius: 2px;
  white-space: normal; word-break: break-word; line-height: 1.4;
}
.col-err-list code.error {
  background: color-mix(in srgb, var(--red) 12%, transparent);
  color: var(--red); font-weight: 500;
}
.col-err-list code.stdout { color: var(--muted); }

.run-glyph { font-weight: 700; margin-right: 4px; }
.run-ok   { color: var(--status-pill-fg-ok); }
.run-warn { color: var(--status-pill-fg-warn); }
.run-err  { color: var(--status-pill-fg-err); }
.run-label { color: var(--text); }

/* Run detail */
.detail-block {
  margin-bottom: 18px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--panel-alt);
  overflow: hidden;
}
.detail-h {
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
  padding: 6px 10px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  text-transform: uppercase; letter-spacing: 0.05em;
}
.detail-pre {
  margin: 0;
  padding: 10px 12px;
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text);
  background: var(--panel);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
  max-height: 360px; overflow-y: auto;
}
.detail-pre.detail-error {
  color: var(--red);
  background: color-mix(in srgb, var(--red) 8%, var(--panel));
}
.detail-pre.detail-empty {
  color: var(--muted); font-style: italic;
}
.detail-meta-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 14px;
  padding: 8px 12px;
}
.detail-meta-grid > div {
  font-size: 11px;
  display: flex; gap: 6px; align-items: baseline;
}
.detail-meta-grid code {
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 11px;
  color: var(--text);
  word-break: break-all;
}
.detail-meta-grid .meta-label {
  color: var(--muted); min-width: 80px;
}
</style>