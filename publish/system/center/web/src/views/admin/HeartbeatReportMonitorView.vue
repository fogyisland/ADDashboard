<template>
  <AdminLayout>
    <div class="header">
      <h2>心跳与报告监控</h2>
      <div class="refresh-toggle">
        自动刷新:
        <select v-model.number="refreshIntervalSeconds">
          <option :value="5">5 秒</option>
          <option :value="10">10 秒</option>
          <option :value="30">30 秒</option>
          <option :value="0">关闭</option>
        </select>
      </div>
    </div>
    <section class="probe-panel" data-test="probe-panel">
      <h3>中心端口</h3>
      <table class="probe-t">
        <thead><tr><th>状态</th><th>端口</th><th>详情</th><th>最近探针</th></tr></thead>
        <tbody>
          <tr v-for="role in PROBE_ROLES" :key="role" :data-test="'probe-row'" :data-role="role" :data-status="probeStatusOf(role)">
            <td><span :class="['dot', probeStatusOf(role)]"></span> {{ probeLabel(role, probeRows[role]) }}</td>
            <td>{{ portLabel(role) }}</td>
            <td>{{ probeRows[role]?.status || '—' }} · {{ probeRows[role]?.latencyMs ?? '—' }}ms</td>
            <td>{{ formatRelative(probeRows[role]?.lastProbeAt) }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="nowCenterProbeStale" class="probe-stale-banner" data-test="probe-stale-banner">⚠ 中心自我探针已 30s 未更新 — 监控可能失联</div>
    </section>
    <div class="tabs">
      <button data-test="tab-agent" :class="{active: tab==='agent'}" @click="tab='agent'">按 Agent</button>
      <button data-test="tab-dc"    :class="{active: tab==='dc'}"    @click="tab='dc'">按 DC</button>
    </div>
    <div v-if="error" class="error-banner" data-test="error-banner">{{ error }}</div>
    <h3>心跳表</h3>
    <table class="t">
      <thead><tr><th>状态</th><th>{{ tab==='agent' ? 'Agent' : 'DC' }} 名称</th><th v-if="tab==='dc'">站点</th><th>最新心跳时间</th><th>延迟</th><th>操作</th></tr></thead>
      <tbody>
        <tr v-for="row in rows" :key="row.agentId" :data-test="'heartbeat-row'" :data-agent="row.agentId" :data-status="statusOf(row)" @click="openDrawer(row)">
          <td><span :class="['dot', statusOf(row)]"></span> {{ statusLabel(row) }}</td>
          <td>{{ row.agentId }}</td>
          <td v-if="tab==='dc'">{{ row.siteName || '—' }}</td>
          <td>{{ formatRelative(row.lastHeartbeatAt) }}</td>
          <td>{{ formatLatency(row.lastHeartbeatAt) }}</td>
          <td class="row-actions" @click.stop>
            <button
              v-if="tab==='agent'"
              :data-test="'request-report'"
              :data-agent="row.agentId"
              :disabled="isReportButtonDisabled(row) || requestingAgentId === row.agentId"
              :title="getReportButtonTooltip(row)"
              @click="onRequestReport(row)"
            >{{ requestingAgentId === row.agentId ? '请求中…' : getReportButtonLabel(row) }}</button>
            <button
              :data-test="tab==='agent' ? 'delete-heartbeat-agent' : 'delete-heartbeat-dc'"
              :data-id="tab==='agent' ? row.agentId : row.dcName || row.agentId"
              :disabled="deletingId === (tab==='agent' ? row.agentId : row.dcName || row.agentId)"
              :title="tab==='agent' ? '清除该 agent 的心跳、复制状态和包执行历史' : '仅删除 ad_dcs 记录;心跳行保留'"
              @click="onDeleteHeartbeatRow(row)"
            >{{ deletingId === (tab==='agent' ? row.agentId : row.dcName || row.agentId) ? '删除中…' : '删除' }}</button>
          </td>
        </tr>
        <tr v-if="!rows.length"><td :colspan="tab === 'dc' ? 6 : 5" class="empty">暂无 Agent — 等待心跳上报</td></tr>
      </tbody>
    </table>

    <h3>报告表</h3>
    <table class="t">
      <thead><tr><th>状态</th><th>{{ tab==='agent' ? 'Agent' : 'DC' }} 名称</th><th>最近报告</th><th>错误摘要</th><th>成功率</th><th>操作</th></tr></thead>
      <tbody>
        <tr v-for="row in rows" :key="row.agentId" :data-test="'report-row'" @click="openDrawer(row)">
          <td>{{ reportStatusLabel(row) }}</td>
          <td>{{ row.agentId }}</td>
          <td>{{ formatRelative(row.lastReportAt) }}</td>
          <td>{{ row.reportSummary?.latestErrorMessage || '—' }}</td>
          <!-- 2026-08-27 round-39: 成功率 = counts + 百分比. counts reset at midnight UTC
               (today's window); percentage is success/total*100, rounded. -->
          <td v-if="row.reportSummary" data-test="success-rate">
            {{ row.reportSummary.successCount }} / {{ row.reportSummary.totalLinks }}
            <span class="rate-pct">({{ row.reportSummary.successRate ?? '—' }}<span v-if="row.reportSummary.successRate != null">%</span>)</span>
          </td>
          <td v-else>—</td>
          <td class="row-actions" @click.stop>
            <button
              :data-test="tab==='agent' ? 'delete-report-agent' : 'delete-report-dc'"
              :data-id="tab==='agent' ? row.agentId : row.dcName || row.agentId"
              :disabled="deletingId === (tab==='agent' ? row.agentId : row.dcName || row.agentId)"
              :title="tab==='agent' ? '清除该 agent 的心跳、复制状态和包执行历史' : '仅删除 ad_dcs 记录;心跳行保留'"
              @click="onDeleteReportRow(row)"
            >{{ deletingId === (tab==='agent' ? row.agentId : row.dcName || row.agentId) ? '删除中…' : '删除' }}</button>
          </td>
        </tr>
        <tr v-if="!rows.length"><td colspan="6" class="empty">暂无报告 — 等待心跳上报</td></tr>
      </tbody>
    </table>

    <div v-if="drawerAgentId" data-test="drawer" class="drawer-bg" @click.self="drawerAgentId=null">
      <div class="drawer">
        <h3>{{ drawerAgentId }} 最近报告</h3>
        <pre>{{ JSON.stringify(drawerPayload, null, 2) }}</pre>
        <button @click="drawerAgentId=null">关闭</button>
      </div>
    </div>

    <ConfirmDialog
      v-if="reportConfirmAgentId"
      :title="`向 ${reportConfirmAgentId} 触发数据回报?`"
      :body="`立即向 ${reportConfirmAgentId} 发起请求;agent 在下一次心跳会上传最新报告。`"
      confirm-label="确认回报"
      @confirm="confirmRequestReport"
      @cancel="reportConfirmAgentId = null"
    />

    <ConfirmDialog
      v-if="deleteConfirm"
      :title="deleteConfirm.kind === 'agent'
        ? `删除 agent ${deleteConfirm.id} 的所有记录?`
        : `删除 DC ${deleteConfirm.id}?`"
      :body="deleteConfirm.kind === 'agent'
        ? `此操作将清除 ${deleteConfirm.id} 的心跳、复制状态(源 + 目标)和所有包执行历史;agent 下次心跳会重新注册。`
        : `此操作仅删除 ad_dcs 中 ${deleteConfirm.id} 的记录;agent 心跳行保留在 Agent 标签页。`"
      confirm-label="确认删除"
      danger
      @confirm="confirmDelete"
      @cancel="deleteConfirm = null"
    />
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import { heartbeatReportApi } from '../../api/heartbeatReport.js';
import { notifyError, notifySuccess } from '../../lib/notify.js';

const tab = ref('agent');
const agentsRows = ref([]);
const dcsRows = ref([]);
const heartbeatStaleSeconds = ref(15);
const refreshIntervalSeconds = ref(5);
const drawerAgentId = ref(null);
const drawerPayload = ref(null);
const error = ref(null);
let timer = null;

// Task 8: 回报 button state
const reportConfirmAgentId = ref(null);
const requestingAgentId = ref(null);
// 24h threshold for the "回报(待清理)" pending-but-stale state
const REPORT_PENDING_MS = 24 * 3600 * 1000;

// 2026-08-26 round-19+: delete buttons on heartbeat + report tables.
// `deleteConfirm` holds the pending confirmation: { kind: 'agent'|'dc', id: string }.
// `deletingId` tracks in-flight DELETE so the button shows 删除中… and
// blocks double-clicks.
const deleteConfirm = ref(null);
const deletingId = ref(null);

// Center port self-probe panel (Task 7)
const PROBE_ROLES = ['web', 'heartbeat', 'report'];
const PROBE_PORT_LABEL = { web: 'Web :8080', heartbeat: '心跳 :8081', report: '报告 :8082' };
const probeRows = ref({ web: null, heartbeat: null, report: null });
const nowCenterProbeStale = ref(false);

function probeStatusOf(role) {
  const row = probeRows.value[role];
  if (!row) return 'yellow';
  if (nowCenterProbeStale.value) return 'red';
  if (row.status === 'unknown') return 'yellow';
  if (row.status === 'degraded') {
    if ((row.consecutiveFailures ?? 0) >= 3) return 'red';
    return 'yellow';
  }
  if (row.status === 'healthy') {
    if (!row.lastProbeAt) return 'yellow';
    const gap = (Date.now() - new Date(row.lastProbeAt).getTime()) / 1000;
    if (gap > 60) return 'red';
    if (gap > 30) return 'yellow';
    return 'green';
  }
  return 'yellow';
}
function probeLabel(role, row) {
  if (!row) return '未知';
  if (nowCenterProbeStale.value) return '监控自身失联';
  if (row.status === 'unknown') return '启动中';
  if (row.status === 'degraded') {
    const n = row.consecutiveFailures ?? 0;
    return n >= 3 ? `down · 连续失败 ${n} 次` : `异常 · 连续失败 ${n} 次`;
  }
  if (row.status === 'healthy') {
    if (!row.lastProbeAt) return '正常 · 探针未更新';
    return `正常 · ${row.latencyMs ?? '?'}ms`;
  }
  return '未知';
}
function portLabel(role) {
  return PROBE_PORT_LABEL[role] || role;
}

const rows = computed(() => tab.value === 'agent' ? agentsRows.value : dcsRows.value);

function statusOf(row) {
  if (!row.lastHeartbeatAt) return 'never';
  const gap = (Date.now() - new Date(row.lastHeartbeatAt).getTime()) / 1000;
  if (gap <= heartbeatStaleSeconds.value) return 'green';
  // Yellow band: up to 4× the stale threshold. Keeps the band visible even when heartbeat_stale_seconds > 60.
  if (gap <= heartbeatStaleSeconds.value * 4) return 'yellow';
  return 'red';
}
function statusLabel(row) {
  return { green: '在线', yellow: '延迟', red: '掉线', never: '未上报' }[statusOf(row)];
}
function reportStatusLabel(row) {
  if (!row.lastReportAt) return '⏸ 未上传';
  if (!row.reportSummary) return '?';
  if (row.reportSummary.failCount === 0) return '✅ OK';
  return '⚠️ 部分失败';
}
function formatRelative(s) {
  if (!s) return '—';
  const gap = Math.round((Date.now() - new Date(s).getTime()) / 1000);
  if (gap < 60) return `${gap} 秒前`;
  if (gap < 3600) return `${Math.round(gap / 60)} 分钟前`;
  return `${Math.round(gap / 3600)} 小时前`;
}
function formatLatency(s) {
  if (!s) return '—';
  return `${Math.round((Date.now() - new Date(s).getTime()) / 1000)}s`;
}

async function load() {
  try {
    if (tab.value === 'agent') {
      const r = await heartbeatReportApi.listAgents();
      agentsRows.value = r.data?.agents || [];
      heartbeatStaleSeconds.value = r.data?.heartbeatStaleSeconds || 15;
    } else {
      const r = await heartbeatReportApi.listDcs();
      dcsRows.value = r.data?.agents || [];
      heartbeatStaleSeconds.value = r.data?.heartbeatStaleSeconds || 15;
    }
    // Probe status is best-effort: surface staleness separately, don't let it
    // blow up the main tables.
    try {
      const pr = await heartbeatReportApi.getProbeStatus();
      probeRows.value = pr.data?.probes || {};
      nowCenterProbeStale.value = !!pr.data?.nowCenterProbeStale;
    } catch (e) {
      console.warn('probe fetch failed:', e?.message);
    }
    error.value = null;
  } catch (e) {
    // Keep last good rows so the table still shows data; surface the error to the operator.
    error.value = e?.message || '加载失败';
  }
}
function startTimer() {
  stopTimer();
  if (refreshIntervalSeconds.value > 0) {
    timer = setInterval(load, refreshIntervalSeconds.value * 1000);
  }
}
function stopTimer() {
  if (timer) { clearInterval(timer); timer = null; }
}
async function openDrawer(row) {
  drawerAgentId.value = row.agentId;
  drawerPayload.value = null;
  try {
    const r = await heartbeatReportApi.getDetail(row.agentId);
    drawerPayload.value = r.data;
  } catch (e) {
    drawerPayload.value = null;
    error.value = e?.message || '加载详情失败';
  }
}

// Task 8: report-request button helpers.
// isStale returns true when the agent is not "green" (i.e. delayed or worse).
// Disabling on any non-green state is the right call for an immediate-report
// trigger — if the agent hasn't been heard from recently the request will
// pile up at center waiting for the next heartbeat, with no signal back.
function isStale(row) {
  return statusOf(row) !== 'green';
}
function reportRequestAgeMs(row) {
  if (!row.reportRequestedAt) return null;
  return Date.now() - new Date(row.reportRequestedAt).getTime();
}
function isReportPending(row) {
  const age = reportRequestAgeMs(row);
  return age != null && age >= 0 && age < REPORT_PENDING_MS;
}
function isReportStale(row) {
  const age = reportRequestAgeMs(row);
  return age != null && age >= REPORT_PENDING_MS;
}
function getReportButtonLabel(row) {
  if (isReportPending(row)) return '已请求回报';
  if (isReportStale(row)) return '回报(待清理)';
  return '回报';
}
function getReportButtonTooltip(row) {
  if (isStale(row)) return 'agent 离线;无法回报';
  if (isReportPending(row)) {
    const sinceAgo = formatRelative(row.reportRequestedAt);
    return `已请求回报 ${sinceAgo};等待 agent 下一次心跳`;
  }
  if (isReportStale(row)) {
    const sinceAgo = formatRelative(row.reportRequestedAt);
    return `上次请求回报 ${sinceAgo} 仍未完成;可再次触发`;
  }
  return '立即触发数据回报';
}
function isReportButtonDisabled(row) {
  // Disabled while agent is offline, or while a fresh request is already pending.
  // Stale (>=24h) requests are re-clickable so the operator can recover.
  return isStale(row) || isReportPending(row);
}
function onRequestReport(row) {
  if (isReportButtonDisabled(row) || requestingAgentId.value) return;
  reportConfirmAgentId.value = row.agentId;
}
async function confirmRequestReport() {
  const agentId = reportConfirmAgentId.value;
  reportConfirmAgentId.value = null;
  if (!agentId || requestingAgentId.value) return;
  requestingAgentId.value = agentId;
  try {
    await heartbeatReportApi.requestReport(agentId);
    notifySuccess(`已请求 ${agentId} 回报`);
    // Refresh list so reportRequestedAt reflects the new state immediately.
    try { await load(); } catch {}
  } catch (e) {
    if (e?.response?.status === 404) {
      notifyError(`${agentId} 不存在,请先安装 agent`);
    } else {
      notifyError(`请求 ${agentId} 回报失败: ${e?.message || '未知错误'}`);
    }
  } finally {
    requestingAgentId.value = null;
  }
}

// 2026-08-26 round-19+: delete handlers for heartbeat + report tables.
// `dcName` is exposed on the DC-tab rows by listDcs; falls back to agentId
// on agent-tab rows where there's no separate DC identity.
function rowDeleteId(row) {
  if (tab.value === 'dc') return row.dcName || row.agentId;
  return row.agentId;
}
function onDeleteHeartbeatRow(row) {
  if (deletingId.value) return;
  deleteConfirm.value = { kind: tab.value === 'dc' ? 'dc' : 'agent', id: rowDeleteId(row) };
}
function onDeleteReportRow(row) {
  if (deletingId.value) return;
  deleteConfirm.value = { kind: tab.value === 'dc' ? 'dc' : 'agent', id: rowDeleteId(row) };
}
async function confirmDelete() {
  const target = deleteConfirm.value;
  deleteConfirm.value = null;
  if (!target || deletingId.value) return;
  deletingId.value = target.id;
  try {
    if (target.kind === 'agent') {
      const r = await heartbeatReportApi.deleteAgent(target.id);
      const deleted = r.data?.deleted || {};
      notifySuccess(`已删除 agent ${target.id}(心跳 ${deleted.heartbeat ?? 0} / 复制 ${deleted.replication ?? 0} / 包 ${deleted.package_runs ?? 0})`);
    } else {
      const r = await heartbeatReportApi.deleteDc(target.id);
      const deleted = r.data?.deleted || {};
      notifySuccess(`已删除 DC ${target.id}(ad_dcs ${deleted.dcs ?? 0})`);
    }
    // Refresh list so the row disappears immediately.
    try { await load(); } catch {}
  } catch (e) {
    if (e?.response?.status === 404) {
      notifyError(`${target.id} 不存在,可能已被其他操作删除`);
    } else {
      notifyError(`删除 ${target.id} 失败: ${e?.message || '未知错误'}`);
    }
  } finally {
    deletingId.value = null;
  }
}

onMounted(async () => {
  try { await load(); } catch {} finally { startTimer(); }
});
onBeforeUnmount(stopTimer);
watch(tab, () => load());
watch(refreshIntervalSeconds, startTimer);
</script>

<style scoped>
.t { width: 100%; border-collapse: collapse; background: var(--panel); margin-bottom: 24px; }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
.tabs { display: flex; gap: 8px; margin: 12px 0; }
.tabs button { padding: 6px 14px; border: 1px solid #1e293b; background: var(--panel); color: var(--text); border-radius: 3px; cursor: pointer; }
.tabs button.active { background: var(--accent); color: #0b1220; }
.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
.dot.green  { background: #10b981; }
.dot.yellow { background: #f59e0b; }
.dot.red    { background: #ef4444; }
.dot.never  { background: #6b7280; }
.empty { text-align: center; color: var(--muted); padding: 24px; }
.error-banner { background: #7f1d1d; color: #fee2e2; border: 1px solid #b91c1c; padding: 10px 14px; margin: 12px 0; border-radius: 4px; font-size: 13px; }
.header { display: flex; justify-content: space-between; align-items: center; }
.refresh-toggle { color: var(--muted); font-size: 13px; }
.refresh-toggle select { background: #0b1220; color: var(--text); border: 1px solid #1e293b; padding: 4px 8px; }
.drawer-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; justify-content: flex-end; z-index: 100; }
.drawer { background: var(--panel); padding: 20px; width: 600px; max-width: 100%; height: 100vh; overflow: auto; }
.drawer pre { background: #0b1220; padding: 12px; border-radius: 3px; font-size: 11px; max-height: 70vh; overflow: auto; }
.probe-panel { margin-bottom: 16px; padding: 12px; background: var(--panel); border: 1px solid #1e293b; border-radius: 4px; }
.probe-panel h3 { margin: 0 0 8px; font-size: 14px; color: var(--muted); }
.probe-t { width: 100%; border-collapse: collapse; }
.probe-t th, .probe-t td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #1e293b; font-size: 13px; }
.probe-t th { background: #0b1220; color: var(--muted); font-size: 12px; }
.probe-stale-banner { margin-top: 8px; padding: 8px 12px; background: #7f1d1d; color: #fee2e2; border: 1px solid #b91c1c; border-radius: 3px; font-size: 12px; }

/* 2026-08-27 round-39: 成功率百分比括号 — 跟 counts 并排显示, 颜色 muted,
   font-family mono 跟 counts 一致. */
.rate-pct { color: var(--muted); font-family: ui-monospace, monospace; font-size: 12px; margin-left: 2px; }

/* Task 8: 回报 button in heartbeat table */
.t button[data-test="request-report"] {
  padding: 4px 12px;
  background: var(--accent);
  color: #0b1220;
  border: 1px solid var(--accent);
  border-radius: 3px;
  cursor: pointer;
  font-size: 13px;
}
.t button[data-test="request-report"]:hover:not(:disabled) {
  filter: brightness(1.1);
}
.t button[data-test="request-report"]:disabled {
  background: #1e293b;
  color: var(--muted);
  border-color: #1e293b;
  cursor: not-allowed;
}

/* 2026-08-26 round-19+: delete buttons (heartbeat + report tables).
 * Always red so operators can't confuse this with the neutral 回报 action. */
.row-actions { display: flex; gap: 6px; white-space: nowrap; }
.t button[data-test="delete-heartbeat-agent"],
.t button[data-test="delete-heartbeat-dc"],
.t button[data-test="delete-report-agent"],
.t button[data-test="delete-report-dc"] {
  padding: 4px 12px;
  background: #ef4444;
  color: white;
  border: 1px solid #ef4444;
  border-radius: 3px;
  cursor: pointer;
  font-size: 13px;
}
.t button[data-test="delete-heartbeat-agent"]:hover:not(:disabled),
.t button[data-test="delete-heartbeat-dc"]:hover:not(:disabled),
.t button[data-test="delete-report-agent"]:hover:not(:disabled),
.t button[data-test="delete-report-dc"]:hover:not(:disabled) {
  filter: brightness(1.1);
}
.t button[data-test="delete-heartbeat-agent"]:disabled,
.t button[data-test="delete-heartbeat-dc"]:disabled,
.t button[data-test="delete-report-agent"]:disabled,
.t button[data-test="delete-report-dc"]:disabled {
  background: #1e293b;
  color: var(--muted);
  border-color: #1e293b;
  cursor: not-allowed;
}
</style>