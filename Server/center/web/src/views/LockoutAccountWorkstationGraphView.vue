<!--
  R158.1W.6 (2026-10-17) — 操作员 directive "账户锁定和密码分布在大小写忽略的":
    Windows SAM 账户名大小写不敏感, 合并到同一账户节点.
    SQL helper lockout.accountWorkstationLinks (sql.js MySQL:1916/1924/1933
    + MSSQL:4970/4979/4990) GROUP BY / subquery 关联 / SELECT sam 4 处
    LOWER(e.target_user_name) fold, 跨 case 自动合成. service layer 0 改.
    1:1 平行 AccountWorkstationGraphView R158.1W.6.
  =========================================================================
  R158.1W.5 (2026-10-17) — 操作员 directive "账户锁定分布图最小工作站数量改成 1":
    select 加 <option :value="1">1</option> 首位 + minStations 默认 5→1
    + SQL helper lockout.accountWorkstationLinks (sql.js MySQL + MSSQL)
      4 处 throw 边界 [2,50]→[1,50] (HAVING COUNT(DISTINCT workstation)
      参数绑定 0 改, 自动放宽 "≥1 个工作站就纳入").
    1:1 平行 AccountWorkstationGraphView R158.1W.5. 0 改 endpoint /
    0 改 service fn / 0 改 API wrapper / 0 改 schema / 0 改 agent /
    0 改 ETL. 必跑 build:web (R158.108 lesson).
  =========================================================================
  R158.1W.3 (2026-10-16) — 账户锁定分布图 (LockoutAccountWorkstationGraphView)
  =========================================================================
  操作员 directive: "完成了之后修改成账户锁定分布图 和账户访问分布图一样" —
  1:1 平行 R158.1W.1 账户访问分布图 (AccountWorkstationGraphView), 数据源
  切到 ad_lockout_events 4740 事件 (账户锁定) vs ad_failed_logon_events
  4625 (登录失败). 双形态 toggle 1:1 平行: 力导向图 (ECharts graph/force)
  + 桑基图 (sankey). 评估维度: 账户在多个不同工作站被锁定 (lateral movement
  锁定模式).

  Data source: ad_lockout_events public table (4740 事件), 由
  ad_lockout_collector 包 + centre-side runner.js post-hook
  MERGE ON (dc_name, event_record_id) 写入. 后端 SQL helper
  lockout.accountWorkstationLinks (sql.js MSSQL/MySQL block 双 dialect,
  1:1 平行 failedLogon.accountWorkstationLinks 范式, 字段映射
  workstation_name → caller_computer_name) 聚合
  target_user_name × caller_computer_name, 过滤 N 个不同工作站阈值.

  0 改 schema / 0 改 agent / 0 改 ETL / 0 改既有 view / 0 改既有 endpoint.
  0 改 1W.1 view file (AccountWorkstationGraphView.vue 0 改) / 0 改 1W.1
  endpoint (failedLogon.accountWorkstationLinks 0 改) / 0 改 1W.1 SQL
  helper (failedLogon.accountWorkstationLinks 0 改) / 0 改 1W.1 service fn /
  0 改 1W.1 API wrapper. envelope shape { nodes, links } 跟 R158.1W.1 1:1
  平行, 0 改 wire.

  Auth tier: userAuth ONLY (no admin perm gate) — same access tier as
  /lockout-accounts / /failed-logon-2h / /account-change-detail /
  /account-workstation-graph (1W.1). Polling: 60s.
-->
<template>
  <AppLayout>
    <div class="aws-page">
      <header class="page-header">
        <div class="title-block">
          <h1>账户锁定分布图</h1>
          <p class="subtitle">
            安全事件 4740 (账户锁定) · 数据来源:
            <code>ad_lockout_events</code> 表 · 评估账户在多个不同工作站被锁定 (横向移动锁定模式) · 与密码错误分布图 (4625) 保持一致 · 支持力导向图与桑基图两种形态
          </p>
        </div>
        <div class="header-actions">
          <!-- 时间范围 toggle (24h/7d/全部) — 1:1 平行 R158.108/109.a/109.b 范式 -->
          <div class="range-toggle" role="tablist" aria-label="时间范围">
            <button
              :class="{ active: chartWindow === '24h' }"
              role="tab"
              :aria-selected="chartWindow === '24h'"
              @click="setChartWindow('24h')"
              data-test="lockout-graph-range-24h"
            >24h</button>
            <button
              :class="{ active: chartWindow === '7d' }"
              role="tab"
              :aria-selected="chartWindow === '7d'"
              @click="setChartWindow('7d')"
              data-test="lockout-graph-range-7d"
            >7d</button>
            <button
              :class="{ active: chartWindow === 'all' }"
              role="tab"
              :aria-selected="chartWindow === 'all'"
              @click="setChartWindow('all')"
              data-test="lockout-graph-range-all"
            >全部</button>
          </div>
          <!-- 最小工作站数 select — 控制图密度 (操作员: 评估"账户在 N 个不同工作站被锁定") -->
          <label class="min-stations-label">
            最小工作站数:
            <select
              v-model.number="minStations"
              @change="loadAll"
              data-test="lockout-graph-min-stations"
            >
              <option :value="1">1</option>
              <option :value="2">2</option>
              <option :value="3">3</option>
              <option :value="5">5</option>
              <option :value="10">10</option>
              <option :value="20">20</option>
            </select>
          </label>
          <!-- 视图模式 toggle (力导向 / 桑基) — 操作员 directive 1 和 2 可切换 -->
          <div class="range-toggle" role="tablist" aria-label="视图模式">
            <button
              :class="{ active: viewMode === 'force' }"
              role="tab"
              :aria-selected="viewMode === 'force'"
              @click="setViewMode('force')"
              data-test="lockout-mode-force"
            >力导向图</button>
            <button
              :class="{ active: viewMode === 'sankey' }"
              role="tab"
              :aria-selected="viewMode === 'sankey'"
              @click="setViewMode('sankey')"
              data-test="lockout-mode-sankey"
            >桑基图</button>
          </div>
        </div>
      </header>

      <!-- 主图表 host div (ECharts canvas) — minify-safe 1:1 平行 AccountWorkstationGraphView 1W.1 -->
      <section class="chart-section" v-show="hasData" data-test="lockout-graph-host">
        <div ref="chartEl" class="chart-canvas"></div>
      </section>

      <!-- 空态 — 1:1 平行 R158.108 EventlogView / R158.LA-UI LicenseView 黄底⚠️ 范式 -->
      <section v-if="!loading && !hasData" class="empty-state" data-test="lockout-graph-empty">
        <div class="empty-banner">
          <strong>⚠️ 无数据</strong>
          <p>
            当前时间窗口 ({{ chartWindowLabel }}) + 最小工作站数 ({{ minStations }}) 条件下,
            0 账户满足"在 N 个不同工作站被锁定"。可能原因:
          </p>
          <ul>
            <li>4740 事件密度低 (本窗口内无多工作站锁定)</li>
            <li>最小工作站数阈值过高 — 尝试调低到 2 或 3</li>
            <li>时间窗口过短 — 切到 7d 或 全部</li>
            <li>域控上的审核策略未开启 (需管理员执行 <code>auditpol /set /subcategory:"Account Lockout" /success:enable</code>)</li>
          </ul>
        </div>
      </section>

      <!-- 加载态 -->
      <section v-if="loading" class="loading-state" data-test="lockout-graph-loading">
        <p>正在加载账户锁定分布数据...</p>
      </section>

      <!-- 副信息 panel — force mode 显示 (sankey mode 隐藏) -->
      <section v-if="viewMode === 'force' && hasData" class="info-panel">
        <h2>Top 用户列表 ({{ userList.length }})</h2>
        <table class="aws-table">
          <thead>
            <tr>
              <th>账户 (SAM)</th>
              <th>工作站数</th>
              <th>总锁定次数</th>
              <th>DC 列表</th>
              <th>最近锁定</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in userList" :key="u.id" :data-test="`lockout-user-row-${u.label}`">
              <td><code>{{ u.label }}</code></td>
              <td>{{ u.stationCount }}</td>
              <td>{{ u.weight }}</td>
              <td><span class="dc-list">{{ u.dcList }}</span></td>
              <td>{{ formatTs(u.lastSeen) }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  </AppLayout>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import * as echarts from 'echarts';
import AppLayout from '../components/AppLayout.vue';
import { fetchLockoutAccountWorkstationGraph } from '../api/lockout.js';
import { useChartTheme } from '../composables/useChartTheme.js';

const POLL_INTERVAL_MS = 120 * 1000;    // 120s polling (网络图比 line chart 重, R158.1W.4 拉到 2min 节流)

const { palette } = useChartTheme();

// ── state ──
const chartWindow = ref('7d');            // 默认 7d, 网络图窗口比 24h/7d toggle 拉长
const viewMode    = ref('force');          // 'force' | 'sankey'
const minStations = ref(1);                // 操作员 directive 2026-10-17 默认 5→1 (放宽阈值 = "任何账户只要在 ≥1 个工作站被锁定就纳入"). 1W.4 节流 directive 由本次覆盖. SQL helper 4 处 throw 同步放宽 [2,50]→[1,50]. 1:1 平行 AccountWorkstationGraphView.vue
const loading     = ref(false);
const nodes       = ref([]);
const links       = ref([]);

let pollHandle  = null;
let chartInstance = null;

// ── computed ──
const hasData = computed(() => nodes.value.length > 0 && links.value.length > 0);

const userList = computed(() => {
  // force mode 副表 — top 用户按 station_count DESC 排序
  return nodes.value
    .filter((n) => n.kind === 'user')
    .sort((a, b) => b.stationCount - a.stationCount)
    .slice(0, 50);
});

const chartWindowLabel = computed(() => {
  if (chartWindow.value === '24h') return '24 小时';
  if (chartWindow.value === '7d')  return '7 天';
  if (chartWindow.value === 'all') return '全部';
  return chartWindow.value;
});

// ── chart option builders ──
function forceOption() {
  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      formatter: (p) => {
        // R158.1W.3 (2026-10-16) — ECharts graph/force 内部把 series.data wrap 成
        //   { id, name, symbolSize, itemStyle, label, value, _raw }, 原 p.data.kind /
        //   .stationCount / .dcList 全部 undefined (挂 _raw 兜底). Edge 同理.
        //   1:1 平行 R158.1W.1 AccountWorkstationGraphView.vue:199 _raw 范式.
        const raw = p.data && p.data._raw ? p.data._raw : p.data;
        if (p.dataType === 'node') {
          const n = raw;
          const kind = n.kind === 'user' ? '账户' : '工作站';
          if (n.kind === 'user') {
            return `<b>${kind}: ${n.label}</b><br/>工作站数: <b>${n.stationCount}</b><br/>总锁定次数: <b>${n.weight}</b><br/>DC: ${n.dcList}`;
          }
          return `<b>${kind}: ${n.label}</b><br/>总锁定次数: <b>${n.weight}</b><br/>DC: ${n.dcList}`;
        }
        if (p.dataType === 'edge') {
          const l = raw;
          return `${l.source} → ${l.target}<br/>锁定次数: <b>${l.weight}</b>`;
        }
        return '';
      }
    },
    legend: [{
      data: ['账户', '工作站'],
      textStyle: { color: palette.value.text }
    }],
    series: [{
      type: 'graph',
      layout: 'force',
      roam: true,                 // 鼠标拖拽 + 缩放
      draggable: true,
      data: nodes.value.map((n) => ({
        id: n.id,
        name: n.label,
        symbolSize: n.kind === 'user' ? Math.min(20 + n.weight / 5, 60) : Math.min(15 + n.weight / 10, 50),
        itemStyle: {
          color:      n.kind === 'user' ? palette.value.accent    : palette.value['hub-gold'],
          borderColor: n.kind === 'user' ? palette.value.accent   : palette.value['gold-border'],
          borderWidth: 2
        },
        symbol: n.kind === 'user' ? 'circle' : 'rect',
        label: {
          show: true,
          position: n.kind === 'user' ? 'right' : 'bottom',
          color: palette.value.text,
          fontSize: 11,
          formatter: '{b}'
        },
        // 把 service 端元数据挂在 data 上, 供 tooltip formatter 读
        value: n.weight,
        _raw: n
      })),
      links: links.value.map((l) => ({
        source: l.source,
        target: l.target,
        lineStyle: {
          width: Math.min(1 + l.weight / 5, 8),
          color: palette.value.muted,
          opacity: 0.6,
          curveness: 0.1
        },
        value: l.weight,
        _raw: l
      })),
      force: {
        repulsion: 200,            // 节点间斥力 (跟 R158.45.5 topology graph 1:1 平行)
        edgeLength: 80,            // 边长
        gravity: 0.1,
        friction: 0.15
      },
      emphasis: {
        focus: 'adjacency',         // R158.45.5 hover/dim/glow precedent
        lineStyle: { width: 4, color: palette.value.hover }
      }
    }]
  };
}

function sankeyOption() {
  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      triggerOn: 'mousemove',
      // R158.1W.3 (2026-10-16) — sankey 内部 wrap { name, value, itemStyle },
      //   service 端 kind/stationCount/dcList 挂 _raw 兜底, edge source/target
      //   已 strip prefix 直接读. 1:1 平行 force formatter `_raw` 范式
      //   (跟 R158.1W.1 AccountWorkstationGraphView.vue:280 1:1 平行).
      formatter: (p) => {
        if (p.dataType === 'node') {
          const raw = p.data && p.data._raw ? p.data._raw : null;
          if (raw) {
            const kind = raw.kind === 'user' ? '账户' : '工作站';
            if (raw.kind === 'user') {
              return `<b>${kind}: ${raw.label}</b><br/>工作站数: <b>${raw.stationCount}</b><br/>总锁定次数: <b>${raw.weight}</b><br/>DC: ${raw.dcList}`;
            }
            return `<b>${kind}: ${raw.label}</b><br/>总锁定次数: <b>${raw.weight}</b><br/>DC: ${raw.dcList}`;
          }
          return `<b>${p.name}</b><br/>值: <b>${p.value}</b>`;
        }
        if (p.dataType === 'edge') {
          return `${p.data.source} → ${p.data.target}<br/>锁定次数: <b>${p.data.value}</b>`;
        }
        return '';
      }
    },
    series: [{
      type: 'sankey',
      data: nodes.value.map((n) => ({ name: n.label, _raw: n })),
      links: links.value.map((l) => ({
        source: l.source.replace(/^u:/, ''),   // sankey node name 不带 'u:'/'w:' prefix
        target: l.target.replace(/^w:/, ''),
        value:  l.weight
      })),
      nodeAlign: 'left',
      nodeGap: 12,
      nodeWidth: 16,
      layoutIterations: 32,
      label: { color: palette.value.text, fontSize: 11 },
      itemStyle: { color: palette.value.accent, borderColor: palette.value.border },
      lineStyle: { color: 'gradient', curveness: 0.5, opacity: 0.5 },
      emphasis: { focus: 'adjacency' }
    }]
  };
}

function buildOption() {
  return viewMode.value === 'force' ? forceOption() : sankeyOption();
}

function renderChart() {
  if (!chartEl.value || !hasData.value) return;
  // R158.57 (FailedLogonView:612) defensive re-init 范式 1:1 平行
  if (chartInstance && chartInstance.getDom() !== chartEl.value) {
    window.removeEventListener('resize', onResize);
    chartInstance.dispose();
    chartInstance = null;
  }
  if (!chartInstance) {
    chartInstance = echarts.init(chartEl.value, null, { renderer: 'canvas' });
    window.addEventListener('resize', onResize);
  }
  chartInstance.setOption(buildOption(), true);
}

function onResize() {
  if (chartInstance) chartInstance.resize();
}

// ── data loading ──
async function loadAll() {
  loading.value = true;
  try {
    // sinceHours 走 chartWindow (跟 R158.108/109.a 1:1 平行)
    let sinceHours;
    if (chartWindow.value === '24h') sinceHours = 24;
    else if (chartWindow.value === '7d') sinceHours = 168;
    else /* all */ sinceHours = 168;  // retention 30d cap, 7d 是网络图实际可见窗口上限
    const resp = await fetchLockoutAccountWorkstationGraph({ sinceHours, minStations: minStations.value, limit: 100 });
    const data = resp && resp.data ? resp.data : resp;
    nodes.value = (data && data.nodes) || [];
    links.value = (data && data.links) || [];
    await nextTick();
    renderChart();
  } catch (e) {
    // axios 拦截器已 catch errorCount (R158.100.8 lesson), 这里只 console 兜底
    console.error('[lockout-aws] loadAll failed', e);
    nodes.value = [];
    links.value = [];
  } finally {
    loading.value = false;
  }
}

function setChartWindow(w) {
  if (chartWindow.value === w) return;
  chartWindow.value = w;
  loadAll();
}

function setViewMode(m) {
  if (viewMode.value === m) return;
  viewMode.value = m;
  // 切 mode 不重 fetch, 只重 render (避免重新跑 SQL)
  nextTick(() => renderChart());
}

function formatTs(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch (e) {
    return iso;
  }
}

// ── chart host ref ──
const chartEl = ref(null);

// ── theme repaint (R158.100.6/7 范式 1:1 平行) ──
watch(palette, () => {
  if (chartInstance && hasData.value) {
    chartInstance.setOption(buildOption(), true);
  }
}, { flush: 'post' });

// ── lifecycle ──
onMounted(() => {
  loadAll();
  pollHandle = setInterval(loadAll, POLL_INTERVAL_MS);
});

onBeforeUnmount(() => {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = null;
  if (chartInstance) {
    window.removeEventListener('resize', onResize);
    chartInstance.dispose();
    chartInstance = null;
  }
});
</script>

<style scoped>
.aws-page {
  padding: 24px;
  max-width: 1600px;
  margin: 0 auto;
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 24px;
  flex-wrap: wrap;
  gap: 16px;
}
.title-block h1 {
  font-size: 24px;
  margin: 0 0 4px 0;
  color: var(--text, #e2e8f0);
}
.title-block .subtitle {
  font-size: 13px;
  color: var(--muted, #94a3b8);
  margin: 0;
}
.title-block .subtitle code {
  background: var(--panel, #1e293b);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 12px;
}
.header-actions {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}
.range-toggle {
  display: inline-flex;
  border: 1px solid var(--border, #334155);
  border-radius: 6px;
  overflow: hidden;
}
.range-toggle button {
  padding: 6px 14px;
  background: var(--panel, #1e293b);
  color: var(--muted, #94a3b8);
  border: none;
  cursor: pointer;
  font-size: 13px;
  transition: background 0.15s, color 0.15s;
}
.range-toggle button:hover {
  background: var(--panel-alt, #283548);
  color: var(--text, #e2e8f0);
}
.range-toggle button.active {
  background: var(--accent, #38bdf8);
  color: #0f172a;
  font-weight: 600;
}
.min-stations-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text, #e2e8f0);
}
.min-stations-label select {
  background: var(--panel, #1e293b);
  color: var(--text, #e2e8f0);
  border: 1px solid var(--border, #334155);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 13px;
  cursor: pointer;
}
.chart-section {
  background: var(--panel, #1e293b);
  border: 1px solid var(--border, #334155);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 24px;
}
.chart-canvas {
  width: 100%;
  height: 600px;
}
.empty-state, .loading-state {
  background: var(--panel, #1e293b);
  border: 1px solid var(--yellow, #eab308);
  border-radius: 8px;
  padding: 24px;
  text-align: left;
}
.empty-banner strong {
  color: var(--yellow, #eab308);
  font-size: 16px;
  display: block;
  margin-bottom: 12px;
}
.empty-banner p, .empty-banner ul {
  color: var(--text, #e2e8f0);
  font-size: 14px;
  margin: 0 0 12px 0;
}
.empty-banner ul {
  margin-left: 20px;
}
.empty-banner li {
  margin-bottom: 4px;
}
.loading-state {
  text-align: center;
  color: var(--muted, #94a3b8);
  font-size: 14px;
  border-color: var(--border, #334155);
}
.info-panel {
  background: var(--panel, #1e293b);
  border: 1px solid var(--border, #334155);
  border-radius: 8px;
  padding: 16px;
}
.info-panel h2 {
  font-size: 16px;
  margin: 0 0 12px 0;
  color: var(--text, #e2e8f0);
}
.aws-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.aws-table th, .aws-table td {
  text-align: left;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border, #334155);
}
.aws-table th {
  color: var(--muted, #94a3b8);
  font-weight: 600;
  background: var(--panel-alt, #283548);
}
.aws-table td code {
  background: var(--bg, #0f172a);
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 12px;
  color: var(--accent, #38bdf8);
}
.aws-table .dc-list {
  color: var(--muted, #94a3b8);
  font-size: 12px;
}
</style>
