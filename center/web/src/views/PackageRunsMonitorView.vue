<!--
  包执行状态监控 — R67-T2 (2026-08-30)

  Operator directive "监控指标点进去就进入包管理状态, 我们是否可以监控包
  执行状态呢?" — pure-read 监控指标 (frontend AppLayout) surface that
  summarises the package_runs table per package:

  - One card per package (5 built-in ad_* packages + any admin-uploaded
    ones). Card shows: name, description, type, 24h status pill
    (success / failure / partial counts), last-run timestamp.
  - Per-card drill-down: last 10 runs table with agent_id, started_at,
    exit_code, duration, stderr_preview (failure detail). Lazy-loaded
    from the same payload — no extra round-trip.
  - Polls /api/dashboard/packages-runs every 10s; clears the timer on
  teardown.
  - 24h summary pill colour: green = 100% success (no failure), yellow =
  any partial, red = any failure, gray = no runs in window.

  The data is already collected by R66's package_runs table — this view
  is purely additive (no agent code change, no DB migration).
-->
<template>
  <AppLayout>
    <header class="page-header">
      <div class="page-titles">
        <h2 class="page-title">包执行状态</h2>
        <p class="subtitle">24 小时执行汇总 · 每 {{ refreshSeconds }} 秒自动刷新</p>
      </div>
      <div class="page-meta">
        <span class="time" v-if="lastLoadedAt">{{ fmt(lastLoadedAt) }}</span>
        <span class="dot" :class="polling ? 'on' : 'off'" aria-hidden="true"></span>
      </div>
    </header>

    <div v-if="error" class="error-banner" data-test="error-banner">{{ error }}</div>

    <div v-if="!packages.length && !error" class="empty" data-test="empty">
      暂无包 — 请在后台 /admin/packages 上传脚本
    </div>

    <div v-if="packages.length" class="card-grid" data-test="card-grid">
      <article
        v-for="p in packages"
        :key="p.name"
        :class="['card', `card-${statusClass(p)}`]"
        :data-test="`card-${p.name}`"
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

        <p class="card-desc" :data-test="`desc-${p.name}`">{{ p.description || '—' }}</p>

        <div class="card-meta">
          <span class="meta-row">
            <span class="meta-label">类型</span>
            <span class="meta-value">{{ p.type }}</span>
          </span>
          <span class="meta-row">
            <span class="meta-label">Agent 类型</span>
            <span class="meta-value">{{ p.agentType }}</span>
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

        <div v-if="p.recent.length" class="recent" :data-test="`recent-${p.name}`">
          <table class="recent-table">
            <thead>
              <tr>
                <th class="col-time">开始</th>
                <th class="col-agent">Agent</th>
                <th class="col-status">结果</th>
                <th class="col-dur">耗时</th>
                <th class="col-err">错误/输出</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in p.recent" :key="r.id ?? `${r.agentId}-${r.startedAt}`" :class="['recent-row', `recent-${runClass(r)}`]">
                <td class="col-time">{{ shortTime(r.startedAt) }}</td>
                <td class="col-agent">{{ r.agentId }}</td>
                <td class="col-status">
                  <span :class="['run-glyph', `run-${runClass(r)}`]">{{ runGlyph(r) }}</span>
                  <span class="run-label">{{ runLabel(r) }}</span>
                </td>
                <td class="col-dur">{{ r.durationMs != null ? `${r.durationMs}ms` : '—' }}</td>
                <td class="col-err">
                  <code v-if="r.stderrPreview" :title="r.stderrPreview">{{ truncate(r.stderrPreview, 60) }}</code>
                  <code v-else-if="r.stdoutPreview" :title="r.stdoutPreview" class="stdout">{{ truncate(r.stdoutPreview, 60) }}</code>
                  <span v-else>—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="recent-empty">暂无 24 小时内的执行记录</div>
      </article>
    </div>
  </AppLayout>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import AppLayout from '../components/AppLayout.vue';
import { dashboardApi } from '../api/dashboard.js';

const packages = ref([]);
const refreshSeconds = ref(10);
const lastLoadedAt = ref(null);
const error = ref('');
const polling = ref(false);

let timerHandle = null;

// 24h summary → card status class (worst-first):
//   - failure > 0   → red    (err)
//   - partial > 0   → yellow (warn)
//   - success > 0   → green  (ok)
//   - total === 0   → gray   (none)
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

// Per-run row class. exit_code is the canonical source; error string and
// stderr_preview are surfaced as detail text but don't override the code.
function runClass(r) {
  if (r.exitCode === 0) return 'ok';
  if (r.exitCode == null) return 'warn';
  return 'err';
}
function runGlyph(r) {
  if (r.exitCode === 0) return '✓';
  if (r.exitCode == null) return '!';
  return '✕';
}
function runLabel(r) {
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

async function load() {
  polling.value = true;
  error.value = '';
  try {
    const r = await dashboardApi.getPackagesRuns();
    packages.value = Array.isArray(r.data?.packages) ? r.data.packages : [];
    refreshSeconds.value = Number(r.data?.refreshSeconds) || 10;
    lastLoadedAt.value = new Date().toISOString();
  } catch (e) {
    error.value = e?.response?.data?.error || '加载失败';
  } finally {
    polling.value = false;
  }
}

onMounted(async () => {
  await load();
  timerHandle = setInterval(load, refreshSeconds.value * 1000);
});
onUnmounted(() => { if (timerHandle) clearInterval(timerHandle); });
</script>

<style scoped>
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
  background: rgba(239, 68, 68, 0.12); color: var(--red);
  padding: 8px 12px; border-radius: 4px; margin-bottom: 12px;
  border: 1px solid rgba(239, 68, 68, 0.3); font-size: 12px;
}
.empty {
  text-align: center; color: var(--muted);
  padding: 32px; font-size: 13px;
  background: var(--panel-alt); border: 1px solid var(--border);
  border-radius: 4px;
}

.card-grid {
  /* 2026-08-30 R67-T2: 强制 3 列 × 2 行 固定 6 格布局
   * (operator: "forge 行采用 3X2" — 两端对齐, 5 个包时第 6 格留空) */
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: repeat(2, auto);
  gap: 14px;
  justify-content: stretch;
}

.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 14px 16px;
  display: flex; flex-direction: column; gap: 10px;
}
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
.pill-ok   { background: rgba(34, 197, 94, 0.18); color: #15803d; }
.pill-warn { background: rgba(234, 179, 8, 0.22); color: #a16207; }
.pill-err  { background: rgba(239, 68, 68, 0.22); color: #b91c1c; }
.pill-none { background: var(--panel-alt); color: var(--muted); }

.card-desc {
  margin: 0; font-size: 12px; color: var(--muted);
  line-height: 1.5; min-height: 18px;
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
.summary-success { color: #15803d; }
.summary-failure { color: #b91c1c; }
.summary-partial { color: #a16207; }
.summary-label { color: var(--muted); }
.summary-value {
  color: var(--text); font-weight: 500;
  font-family: ui-monospace, "SF Mono", monospace;
}
.summary-divider {
  width: 1px; height: 14px; background: var(--border);
}
.summary-spacer { flex: 1; }

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
  padding: 5px 6px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
.recent-row-err  { background: rgba(239, 68, 68, 0.06); }
.recent-row-warn { background: rgba(234, 179, 8, 0.06); }
.recent-row-ok   { background: transparent; }

.col-time { white-space: nowrap; color: var(--text); }
.col-agent { color: var(--text); }
.col-status { white-space: nowrap; }
.col-dur { white-space: nowrap; color: var(--muted); }
.col-err { max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
.col-err code {
  display: inline-block; max-width: 220px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 10px; color: var(--text);
  background: var(--panel-alt); padding: 2px 5px; border-radius: 2px;
}
.col-err code.stdout { color: var(--muted); }

.run-glyph { font-weight: 700; margin-right: 4px; }
.run-ok   { color: #15803d; }
.run-warn { color: #a16207; }
.run-err  { color: #b91c1c; }
.run-label { color: var(--text); }

.recent-empty {
  font-size: 11px; color: var(--muted);
  text-align: center; padding: 12px;
  border: 1px dashed var(--border); border-radius: 4px;
}
</style>