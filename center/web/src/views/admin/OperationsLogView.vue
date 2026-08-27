<template>
  <AdminLayout>
    <header class="head">
      <h2>操作日志</h2>
      <div class="refresh">
        <span class="refresh-dot">
          <span :class="['dot', polling ? 'on' : 'off']"></span>
          <span>每 {{ refreshSeconds }}s 刷新</span>
        </span>
        <select v-model.number="refreshSeconds">
          <option :value="5">5 秒</option>
          <option :value="10">10 秒</option>
          <option :value="30">30 秒</option>
          <option :value="0">关闭</option>
        </select>
      </div>
    </header>

    <p class="hint">
      运维区统一日志 — 审计事件(变更 / 运维)、Agent 心跳状态、回报数据 三块合在一起,
      操作员可以一眼看到"谁动了什么 + 系统现在怎样"。
    </p>

    <div v-if="error" class="error-banner">{{ error }}</div>

    <!-- 1. 审计事件 (changes + ops categories) -->
    <section class="block" data-test="audit-block">
      <h3>审计事件 <small>(变更 / 运维, 最近 {{ auditRows.length }} 条)</small></h3>
      <table class="t">
        <thead>
          <tr><th>时间</th><th>用户</th><th>动作</th><th>严重性</th></tr>
        </thead>
        <tbody>
          <tr v-if="!auditRows.length">
            <td colspan="4" class="empty">暂无审计事件</td>
          </tr>
          <tr v-for="r in auditRows" :key="`audit-${r.id}`"
              :class="['row', `sev-${r.severity}`]"
              data-test="audit-row"
              @click="openAuditDrawer(r)">
            <td>{{ fmt(r.createdAt) }}</td>
            <td>{{ r.username ?? (r.userId ?? '-') }}</td>
            <td>{{ r.actionLabel }}</td>
            <td><span :class="['sev-chip', `sev-chip-${r.severity}`]">{{ sevIcon(r.severity) }} {{ sevLabel(r.severity) }}</span></td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 2. 心跳数据 (per-agent + per-DC rollup) -->
    <section class="block" data-test="heartbeat-block">
      <h3>心跳数据 <small>(Agent: {{ heartbeatAgents.length }} / DC: {{ heartbeatDcs.length }})</small></h3>
      <div class="grid">
        <div class="subblock">
          <h4>按 Agent</h4>
          <table class="t">
            <thead>
              <tr><th>状态</th><th>Agent</th><th>最近心跳</th><th>延迟</th></tr>
            </thead>
            <tbody>
              <tr v-if="!heartbeatAgents.length">
                <td colspan="4" class="empty">暂无 Agent</td>
              </tr>
              <tr v-for="row in heartbeatAgents" :key="`hb-a-${row.agentId}`"
                  :class="['row', `hb-${heartbeatStatus(row)}`]"
                  data-test="heartbeat-agent-row"
                  :data-agent="row.agentId"
                  :data-status="heartbeatStatus(row)">
                <td><span :class="['dot', heartbeatStatus(row)]"></span> {{ heartbeatStatusLabel(row) }}</td>
                <td>{{ row.agentId }}</td>
                <td>{{ fmtRelative(row.lastHeartbeatAt) }}</td>
                <td>{{ fmtLatency(row.lastHeartbeatAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="subblock">
          <h4>按 DC</h4>
          <table class="t">
            <thead>
              <tr><th>状态</th><th>DC</th><th>站点</th><th>最近心跳</th></tr>
            </thead>
            <tbody>
              <tr v-if="!heartbeatDcs.length">
                <td colspan="4" class="empty">暂无 DC</td>
              </tr>
              <tr v-for="row in heartbeatDcs" :key="`hb-d-${row.agentId}`"
                  :class="['row', `hb-${heartbeatStatus(row)}`]"
                  data-test="heartbeat-dc-row"
                  :data-dc="row.dcName || row.agentId"
                  :data-status="heartbeatStatus(row)">
                <td><span :class="['dot', heartbeatStatus(row)]"></span> {{ heartbeatStatusLabel(row) }}</td>
                <td>{{ row.dcName || row.agentId }}</td>
                <td>{{ row.siteName || '—' }}</td>
                <td>{{ fmtRelative(row.lastHeartbeatAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- 3. 报告数据 (per-agent + per-DC rollup) -->
    <section class="block" data-test="report-block">
      <h3>回报数据 <small>(最近报告 + 成功率)</small></h3>
      <div class="grid">
        <div class="subblock">
          <h4>按 Agent</h4>
          <table class="t">
            <thead>
              <tr><th>状态</th><th>Agent</th><th>最近报告</th><th>错误摘要</th><th>成功率</th></tr>
            </thead>
            <tbody>
              <tr v-if="!reportAgents.length">
                <td colspan="5" class="empty">暂无 Agent</td>
              </tr>
              <tr v-for="row in reportAgents" :key="`rp-a-${row.agentId}`"
                  :class="['row', reportRowClass(row)]"
                  data-test="report-agent-row">
                <td>{{ reportStatusLabel(row) }}</td>
                <td>{{ row.agentId }}</td>
                <td>{{ fmtRelative(row.lastReportAt) }}</td>
                <td>{{ row.reportSummary?.latestErrorMessage || '—' }}</td>
                <!-- 2026-08-27 round-39: counts + percentage. counts reset at midnight UTC. -->
                <td v-if="row.reportSummary" data-test="report-success-rate">
                  {{ row.reportSummary.successCount }} / {{ row.reportSummary.totalLinks }}
                  <span class="rate-pct">({{ row.reportSummary.successRate ?? '—' }}<span v-if="row.reportSummary.successRate != null">%</span>)</span>
                </td>
                <td v-else>—</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="subblock">
          <h4>按 DC</h4>
          <table class="t">
            <thead>
              <tr><th>状态</th><th>DC</th><th>最近报告</th><th>错误摘要</th><th>成功率</th></tr>
            </thead>
            <tbody>
              <tr v-if="!reportDcs.length">
                <td colspan="5" class="empty">暂无 DC</td>
              </tr>
              <tr v-for="row in reportDcs" :key="`rp-d-${row.agentId}`"
                  :class="['row', reportRowClass(row)]"
                  data-test="report-dc-row">
                <td>{{ reportStatusLabel(row) }}</td>
                <td>{{ row.dcName || row.agentId }}</td>
                <td>{{ fmtRelative(row.lastReportAt) }}</td>
                <td>{{ row.reportSummary?.latestErrorMessage || '—' }}</td>
                <td v-if="row.reportSummary" data-test="report-success-rate">
                  {{ row.reportSummary.successCount }} / {{ row.reportSummary.totalLinks }}
                  <span class="rate-pct">({{ row.reportSummary.successRate ?? '—' }}<span v-if="row.reportSummary.successRate != null">%</span>)</span>
                </td>
                <td v-else>—</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- Drawer for audit row payload -->
    <aside v-if="selectedAudit" class="drawer" @click.self="selectedAudit = null">
      <div class="drawer-body">
        <header>
          <h3>{{ selectedAudit.actionLabel }} <small>#{{ selectedAudit.id }}</small></h3>
          <button class="close" @click="selectedAudit = null">×</button>
        </header>
        <p><b>{{ selectedAudit.username ?? selectedAudit.userId ?? '-' }}</b> · {{ fmt(selectedAudit.createdAt) }}</p>
        <h4>payload</h4>
        <PayloadTree v-if="selectedAudit.payload" :value="selectedAudit.payload" />
        <p v-else class="muted">无 payload</p>
      </div>
    </aside>
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, h } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { adminApi } from '../../api/admin.js';
import { heartbeatReportApi } from '../../api/heartbeatReport.js';

// 2026-08-27 round-39: 运维区统一日志 — 审计事件 + 心跳数据 + 报告数据.
import { notifyError } from '../../lib/notify.js';

const refreshSeconds = ref(10);
const polling = ref(false);
const error = ref('');

// ---- Audit ----
const auditRows = ref([]);
const selectedAudit = ref(null);
const auditPage = ref(1);
const auditSize = 30;

async function loadAudit() {
  try {
    // Changes + Ops — 运维区关注变更和运维类, 安全类留给 系统设置 → 审计日志.
    const [changesR, opsR] = await Promise.all([
      adminApi.getAudit({ category: 'changes', page: auditPage.value, size: auditSize }),
      adminApi.getAudit({ category: 'ops', page: auditPage.value, size: auditSize })
    ]);
    const combined = [
      ...(changesR.data?.rows || []),
      ...(opsR.data?.rows || [])
    ];
    combined.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    auditRows.value = combined.slice(0, auditSize);
  } catch (e) {
    console.warn('audit load failed:', e?.message);
  }
}

function openAuditDrawer(r) { selectedAudit.value = r; }

// ---- Heartbeat ----
const heartbeatAgents = ref([]);
const heartbeatDcs = ref([]);
const heartbeatStaleSeconds = ref(15);

async function loadHeartbeat() {
  try {
    const [aR, dR] = await Promise.all([
      heartbeatReportApi.listAgents(),
      heartbeatReportApi.listDcs()
    ]);
    heartbeatAgents.value = aR.data?.agents || [];
    heartbeatDcs.value    = dR.data?.agents || [];
    heartbeatStaleSeconds.value = aR.data?.heartbeatStaleSeconds || 15;
  } catch (e) {
    console.warn('heartbeat load failed:', e?.message);
  }
}

// Reuse HeartbeatReportMonitorView's status logic — keep the dots consistent.
function heartbeatStatus(row) {
  if (!row.lastHeartbeatAt) return 'never';
  const gap = (Date.now() - new Date(row.lastHeartbeatAt).getTime()) / 1000;
  if (gap <= heartbeatStaleSeconds.value) return 'green';
  if (gap <= heartbeatStaleSeconds.value * 4) return 'yellow';
  return 'red';
}
function heartbeatStatusLabel(row) {
  return { green: '在线', yellow: '延迟', red: '掉线', never: '未上报' }[heartbeatStatus(row)];
}

// ---- Report ----
// 报告数据: 复用 heartbeatReportApi.listAgents/listDcs 的 payload — 它们
// 已经把 lastReportAt / reportSummary 一起返回了. 同一个 fetch 就拿到
// 心跳 + 报告两份数据, 无需再调第二个 endpoint.
const reportAgents = computed(() => heartbeatAgents.value);
const reportDcs    = computed(() => heartbeatDcs.value);

function reportStatusLabel(row) {
  if (!row.lastReportAt) return '⏸ 未上传';
  if (!row.reportSummary) return '?';
  if (row.reportSummary.failCount === 0) return '✅ OK';
  return '⚠️ 部分失败';
}
function reportRowClass(row) {
  if (!row.lastReportAt) return 'rp-pending';
  if (!row.reportSummary) return 'rp-unknown';
  if (row.reportSummary.failCount === 0) return 'rp-ok';
  return 'rp-partial';
}

// ---- Common ----
function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }
function fmtRelative(s) {
  if (!s) return '—';
  const gap = Math.round((Date.now() - new Date(s).getTime()) / 1000);
  if (gap < 60) return `${gap} 秒前`;
  if (gap < 3600) return `${Math.round(gap / 60)} 分钟前`;
  return `${Math.round(gap / 3600)} 小时前`;
}
function fmtLatency(s) {
  if (!s) return '—';
  return `${Math.round((Date.now() - new Date(s).getTime()) / 1000)}s`;
}
function sevIcon(s)  { return s === 'high' ? '🔴' : s === 'medium' ? '🟡' : '🔵'; }
function sevLabel(s) { return s === 'high' ? '高' : s === 'medium' ? '中' : '低'; }

// ---- Polling ----
let timer = null;

async function loadAll() {
  if (polling.value) return;
  polling.value = true;
  try {
    await Promise.all([loadAudit(), loadHeartbeat()]);
    error.value = '';
  } catch (e) {
    error.value = e?.message || '加载失败';
    notifyError(`操作日志加载失败: ${e?.message || '未知错误'}`);
  } finally {
    polling.value = false;
  }
}
function startTimer() {
  stopTimer();
  if (refreshSeconds.value > 0) {
    timer = setInterval(loadAll, refreshSeconds.value * 1000);
  }
}
function stopTimer() {
  if (timer) { clearInterval(timer); timer = null; }
}

// Inline PayloadTree — keeps the audit drawer identical to AuditView's.
const PayloadTree = {
  props: ['value'],
  setup(props) {
    return () => renderNode(props.value, 0);
  }
};
function renderNode(value, depth) {
  if (value == null) return h('span', { class: 'json-null' }, 'null');
  if (typeof value === 'object') {
    const entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
    return h('ul', { class: 'json-tree', style: `padding-left:${depth * 12}px` },
      entries.map(([k, v]) => h('li', {}, [
        h('span', { class: 'json-key' }, String(k) + ': '),
        renderNode(v, depth + 1)
      ])));
  }
  return h('span', { class: `json-${typeof value}` }, JSON.stringify(value));
}

onMounted(async () => {
  try { await loadAll(); } catch {}
  finally { startTimer(); }
});
onBeforeUnmount(stopTimer);
watch(refreshSeconds, startTimer);
</script>

<style scoped>
.head { display: flex; justify-content: space-between; align-items: center; }
.refresh { display: flex; gap: 12px; align-items: center; color: var(--muted); font-size: 13px; }
.refresh select { background: #0b1220; color: var(--text); border: 1px solid #1e293b; padding: 4px 8px; border-radius: 3px; }
.refresh-dot { display: flex; gap: 6px; align-items: center; }
.hint { color: var(--muted); font-size: 12px; margin: 4px 0 16px; }
.error-banner { background: #7f1d1d; color: #fee2e2; padding: 10px 14px; margin-bottom: 12px; border-radius: 4px; border: 1px solid #b91c1c; font-size: 13px; }

/* 2026-08-27 round-39: each section is a self-contained block so the
 * operator can scan them top-to-bottom: events → heartbeat → report. */
.block { margin-bottom: 24px; padding: 16px; border: 1px solid #1e293b; border-radius: 4px; background: var(--panel); }
.block h3 { margin: 0 0 12px; font-size: 15px; color: var(--text); }
.block h3 small { color: var(--muted); font-size: 12px; margin-left: 6px; font-weight: 400; }

.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.subblock h4 { margin: 0 0 8px; font-size: 13px; color: var(--muted); }

.t { width: 100%; border-collapse: collapse; background: var(--panel); }
.t th, .t td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #1e293b; font-size: 13px; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; font-weight: 600; }
.row { border-left: 3px solid transparent; }
.row:hover { background: #1e293b; }

/* Audit rows — same vocabulary as AuditView so operators recognize the colors. */
.row.sev-high   { border-left-color: #7f1d1d; }
.row.sev-medium { border-left-color: #ca8a04; }
.row.sev-low    { border-left-color: #1e3a8a; }
.sev-chip { padding: 2px 6px; border-radius: 3px; font-size: 11px; }
.sev-chip-high   { background: #7f1d1d; color: #fecaca; }
.sev-chip-medium { background: #78350f; color: #fde68a; }
.sev-chip-low    { background: #1e3a8a; color: #bfdbfe; }

/* Heartbeat rows — colored by online/stale/down. */
.row.hb-green { border-left-color: #10b981; }
.row.hb-yellow { border-left-color: #f59e0b; }
.row.hb-red { border-left-color: #ef4444; }
.row.hb-never { border-left-color: #6b7280; }

/* Report rows — colored by OK / partial / pending. */
.row.rp-ok { border-left-color: #10b981; }
.row.rp-partial { border-left-color: #f59e0b; }
.row.rp-pending { border-left-color: #6b7280; }
.row.rp-unknown { border-left-color: #1e3a8a; }

.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
.dot.green  { background: #10b981; }
.dot.yellow { background: #f59e0b; }
.dot.red    { background: #ef4444; }
.dot.never  { background: #6b7280; }
.dot.on     { background: #10b981; }
.dot.off    { background: #6b7280; }

.empty { text-align: center; color: var(--muted); padding: 18px; }

/* 2026-08-27 round-39: 成功率百分比括号 — 跟 counts 并排显示, 颜色 muted. */
.rate-pct { color: var(--muted); font-family: ui-monospace, monospace; font-size: 12px; margin-left: 2px; }

/* Audit drawer */
.drawer { position: fixed; inset: 0 0 0 auto; width: 40%; min-width: 320px; background: var(--panel); border-left: 1px solid #1e293b; padding: 20px; overflow: auto; z-index: 10; }
.drawer-body header { display: flex; justify-content: space-between; align-items: center; }
.drawer-body h3 small { color: var(--muted); font-size: 12px; margin-left: 6px; }
.drawer-body .close { background: transparent; color: var(--text); border: none; font-size: 24px; cursor: pointer; }
.json-tree { list-style: none; padding-left: 12px; }
.json-key { color: var(--accent); }
.json-string { color: #86efac; }
.json-number { color: #fbbf24; }
.json-boolean { color: #c084fc; }
.json-null { color: var(--muted); font-style: italic; }
.muted { color: var(--muted); }
</style>