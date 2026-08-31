<!--
  2026-09-01 R74 — 复制错误 (ReplicationErrorsView)

  Operator-facing read-only surface that lists every (source_dc, dest_dc,
  naming_context) tuple whose LATEST status row is a failure
  (status_code IN 1, 2). The full fleet's health ribbon is elsewhere
  (复制状态概览 / SiteReplicationMatrixAllView); this view is the focused
  triage screen — operators open it when something is red.

  Visual language matches the R49 ops-console vocabulary:
   - .page-header + .eyebrow + .page-title + .subtitle
   - .fleet-ribbon tiles (here scoped to errors only)
   - .t table + .status-pill (warn = 部分失败, err = 失败)
   - .err-msg red message + 2px left rail on row hover
   - dark/light themes both work via the --panel / --border / --red /
   --yellow / --green / --muted design tokens

  data-test contract (mirrors PackagesView where applicable):
    window-select      — <select> with 24h / 7d options
    refresh-btn        — "↻ 刷新" toolbar button
    err-row            — table row class (per failed pair)
    status-pill-warn   — partial-failure pill
    status-pill-err    — full-failure pill
-->
<template>
  <AdminLayout>
    <header class="page-header">
      <div class="page-titles">
        <div class="eyebrow">OPERATIONS · 复制错误</div>
        <h2 class="page-title">复制错误</h2>
        <p class="subtitle">
          所有 DC 间复制失败 / 部分失败的最近记录。错误信息直接来自 agent 上报的 PowerShell 报错原文。
        </p>
      </div>
      <div class="page-meta">
        <select data-test="window-select" v-model="windowKey" @change="refresh" class="window-select">
          <option value="24h">最近 24 小时</option>
          <option value="7d">最近 7 天</option>
        </select>
        <button class="btn-secondary" data-test="refresh-btn" @click="refresh" :disabled="loading">
          {{ loading ? '加载中…' : '↻ 刷新' }}
        </button>
      </div>
    </header>

    <div v-if="error" class="error-banner">{{ error }}</div>

    <!-- Compact ribbon: error count + severity split + last refresh. Tiles
      tint only when non-zero so a fully-healthy fleet reads as calm. -->
    <div class="fleet-ribbon" data-test="fleet-ribbon">
      <div class="ribbon-tile">
        <div class="ribbon-num">{{ total }}</div>
        <div class="ribbon-label">错误链路</div>
      </div>
      <div class="ribbon-tile" :class="{ 'ribbon-err': summary.fullFailure > 0 }">
        <div class="ribbon-num">{{ summary.fullFailure }}</div>
        <div class="ribbon-label">失败</div>
      </div>
      <div class="ribbon-tile" :class="{ 'ribbon-warn': summary.partialFailure > 0 }">
        <div class="ribbon-num">{{ summary.partialFailure }}</div>
        <div class="ribbon-label">部分失败</div>
      </div>
      <div class="ribbon-tile">
        <div class="ribbon-num">{{ totalAttempts }}</div>
        <div class="ribbon-label">总尝试次数</div>
      </div>
      <div class="ribbon-tile">
        <div class="ribbon-num muted-label">最近刷新</div>
        <div class="ribbon-time">{{ lastLoadedAt ? fmt(lastLoadedAt) : '—' }}</div>
      </div>
    </div>

    <div v-if="!loading && !errors.length && !error" class="empty" data-test="empty-state">
      无复制错误 — 所有 DC 链路在 {{ windowKey === '7d' ? '最近 7 天' : '最近 24 小时' }} 内健康
    </div>

    <table v-else class="t" data-test="errors-table">
      <thead>
        <tr>
          <th>源 DC</th>
          <th>目标 DC</th>
          <th>命名上下文</th>
          <th>状态</th>
          <th class="num">尝试次数</th>
          <th>最近尝试</th>
          <th>最近成功</th>
          <th>停滞时长</th>
          <th>错误信息</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="e in errors"
          :key="`${e.sourceDc}|${e.destDc}|${e.namingContext}`"
          class="err-row"
          :class="['status-' + (e.statusCode === 2 ? 'err' : 'warn')]"
          :data-test="`err-row-${e.sourceDc}-${e.destDc}`"
        >
          <td><code class="dc">{{ e.sourceDc }}</code></td>
          <td><code class="dc">{{ e.destDc }}</code></td>
          <td><code class="nc" :title="e.namingContext">{{ shortNc(e.namingContext) }}</code></td>
          <td>
            <span
              :class="['status-pill', e.statusCode === 2 ? 'err' : 'warn']"
              :data-test="`status-pill-${e.statusCode === 2 ? 'err' : 'warn'}`"
            >
              <span class="dot"></span>{{ e.statusCode === 2 ? '失败' : '部分失败' }}
            </span>
          </td>
          <td class="num">{{ e.attemptCount }}</td>
          <td class="ts">{{ fmt(e.lastAttemptTime) }}</td>
          <td class="ts">{{ e.lastSuccessTime ? fmt(e.lastSuccessTime) : '—' }}</td>
          <td class="ts">{{ fmtDuration(e.durationMs) }}</td>
          <td class="err-msg-cell"><span class="err-msg">{{ e.errorMessage || '—' }}</span></td>
        </tr>
      </tbody>
    </table>
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { dashboardApi } from '../../api/dashboard.js';

const errors = ref([]);
const total = ref(0);
const windowKey = ref('24h');
const loading = ref(false);
const error = ref('');
const lastLoadedAt = ref(null);
const totalAttempts = ref(0);

let timerHandle = null;

const summary = computed(() => {
  let fullFailure = 0;
  let partialFailure = 0;
  for (const e of errors.value) {
    if (e.statusCode === 2) fullFailure++;
    else if (e.statusCode === 1) partialFailure++;
  }
  return { fullFailure, partialFailure };
});

async function refresh() {
  loading.value = true;
  error.value = '';
  try {
    const r = await dashboardApi.replicationErrors({ window: windowKey.value });
    errors.value = Array.isArray(r.data?.errors) ? r.data.errors : [];
    total.value = Number(r.data?.total) || errors.value.length;
    totalAttempts.value = errors.value.reduce((acc, e) => acc + (e.attemptCount || 0), 0);
    lastLoadedAt.value = new Date().toISOString();
  } catch (e) {
    error.value = e?.response?.data?.error || '加载失败';
  } finally {
    loading.value = false;
  }
}

function shortNc(nc) {
  if (!nc) return '—';
  // Truncate at the first comma so long DN paths don't blow out the column;
  // the title="" on the <code> keeps the full path accessible on hover.
  return nc.length > 40 ? `${nc.slice(0, 40)}…` : nc;
}

function fmt(s) {
  if (!s) return '—';
  return new Date(s).toLocaleString('zh-CN', { hour12: false });
}

function fmtDuration(ms) {
  if (ms == null) return '—';
  if (ms < 0) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)} 小时`;
  return `${Math.round(ms / 86_400_000)} 天`;
}

onMounted(() => {
  refresh();
  // 30s polling — same cadence as the rest of the 监控指标 surfaces.
  timerHandle = setInterval(refresh, 30_000);
});
onUnmounted(() => { if (timerHandle) clearInterval(timerHandle); });
</script>

<style scoped>
/* ===== Page header ===================================================== */
.page-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 24px; margin-bottom: 20px; padding-bottom: 18px;
  border-bottom: 1px solid var(--border);
}
.page-titles { display: flex; flex-direction: column; gap: 4px; }
.eyebrow {
  font-size: 10px; font-weight: 600; letter-spacing: 0.14em;
  color: var(--muted); text-transform: uppercase;
}
.page-title {
  margin: 0; font-size: 20px; font-weight: 600; color: var(--text);
  letter-spacing: -0.01em;
}
.subtitle { margin: 0; font-size: 13px; color: var(--muted); max-width: 720px; }
.page-meta { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }

.window-select,
.btn-secondary {
  padding: 6px 14px;
  border: 1px solid var(--border); border-radius: 3px;
  background: var(--input-bg); color: var(--text);
  font-size: 13px; cursor: pointer;
  font-family: inherit;
}
.window-select:hover,
.btn-secondary:hover { border-color: var(--accent); color: var(--accent); }
.window-select:focus-visible,
.btn-secondary:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }

/* ===== Fleet ribbon (errors-only subset) ============================== */
.fleet-ribbon {
  display: grid; grid-template-columns: repeat(5, 1fr);
  gap: 1px; margin-bottom: 20px;
  background: var(--border); border: 1px solid var(--border); border-radius: 4px;
  overflow: hidden;
}
.ribbon-tile {
  background: var(--panel); padding: 14px 18px;
  display: flex; flex-direction: column; gap: 2px; min-width: 0;
}
.ribbon-tile.ribbon-err  { background: linear-gradient(180deg, rgba(239, 68, 68, 0.14), var(--panel)); }
.ribbon-tile.ribbon-warn { background: linear-gradient(180deg, rgba(234, 179, 8, 0.12), var(--panel)); }
.ribbon-num {
  font-size: 22px; font-weight: 600; line-height: 1;
  font-feature-settings: "tnum"; letter-spacing: -0.01em;
  color: var(--text);
}
.ribbon-tile.ribbon-warn .ribbon-num { color: var(--yellow); }
.ribbon-tile.ribbon-err  .ribbon-num { color: var(--red); }
.ribbon-label {
  font-size: 11px; color: var(--muted);
  letter-spacing: 0.06em; margin-top: 4px; font-weight: 500;
}
.ribbon-time {
  font-size: 13px; font-weight: 500; color: var(--text);
  font-family: ui-monospace, monospace;
  font-feature-settings: "tnum";
  margin-top: 4px;
}
.muted-label {
  font-size: 10px; color: var(--muted);
  letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600;
}

/* ===== States =========================================================== */
.error-banner {
  background: var(--red-bg); color: var(--red);
  padding: 10px 14px; border-radius: 4px; margin-bottom: 16px;
  border: 1px solid rgba(239, 68, 68, 0.3); font-size: 13px;
}
.empty {
  text-align: center; color: var(--muted);
  padding: 36px 24px; font-size: 14px;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 4px;
}

/* ===== Table ============================================================ */
.t {
  border-collapse: collapse; background: var(--panel); width: 100%;
  border: 1px solid var(--border); border-radius: 4px; overflow: hidden;
}
.t th, .t td {
  padding: 9px 12px; text-align: left; font-size: 13px;
  color: var(--text); vertical-align: middle;
  border-top: 1px solid var(--border);
}
.t tbody tr:first-child td { border-top: 0; }
.t th {
  background: var(--panel-alt); color: var(--muted);
  font-size: 10px; font-weight: 600;
  letter-spacing: 0.10em; text-transform: uppercase;
  padding: 8px 12px; border-top: 0;
  font-family: ui-monospace, monospace;
}
.t .num { text-align: right; font-feature-settings: "tnum"; }
.err-row td {
  border-top: 1px solid rgba(51, 65, 81, 0.4);
}
.err-row:hover td { background: var(--panel-alt); }
.err-row td:first-child {
  border-left: 2px solid transparent;
  padding-left: 10px;
}
.err-row.status-warn td:first-child { border-left-color: var(--yellow); }
.err-row.status-err  td:first-child { border-left-color: var(--red); }

code.dc, code.nc, code.source {
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 12px; color: var(--text);
}
code.nc {
  color: var(--muted);
  max-width: 280px;
  display: inline-block;
  overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; vertical-align: middle;
}
.ts {
  font-family: ui-monospace, monospace; font-size: 11px;
  color: var(--muted); white-space: nowrap;
  font-feature-settings: "tnum";
}
.err-msg-cell { max-width: 420px; }
.err-msg {
  display: block;
  color: var(--red); font-size: 11px;
  font-family: ui-monospace, monospace;
  line-height: 1.4;
  word-break: break-word;
}

/* ===== Status pill ===================================================== */
.status-pill {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 10px; padding: 2px 8px; border-radius: 2px;
  font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
  font-family: ui-monospace, monospace;
}
.status-pill .dot {
  width: 5px; height: 5px; border-radius: 50%;
  display: inline-block;
}
.status-pill-warn {
  background: rgba(234, 179, 8, 0.10); color: var(--yellow);
  border: 1px solid rgba(234, 179, 8, 0.3);
}
.status-pill-warn .dot { background: var(--yellow); }
.status-pill-err {
  background: rgba(239, 68, 68, 0.10); color: var(--red);
  border: 1px solid rgba(239, 68, 68, 0.3);
}
.status-pill-err .dot { background: var(--red); }
</style>