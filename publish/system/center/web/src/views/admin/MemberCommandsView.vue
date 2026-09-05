<!--
  2026-09-05 R81 — MemberCommandsView.vue (成员服务器 PowerShell 命令执行).

  Per R81 spec §6. Mirrors R75 UserManagementView visual language.

  Layout:
    1. Page header (eyebrow / subtitle / refresh button)
    2. Toolbar — host picker + online/offline hint + 执行命令 + 刷新
    3. Right-side drawer (MemberCommandHistoryDrawer, scoped to selectedHost)
    4. Modal — ExecuteCommandModal (PowerShell editor + submit)

  data-test contract (matched by tests/member-commands-view.test.js):
    host-picker              host select dropdown
    host-online-status       online/offline badge for selected host
    exec-button              open the script-execution modal
    mc-recent-section        recent-commands inline table for current host
-->
<template>
  <AdminLayout>
    <header class="page-header">
      <div class="page-titles">
        <div class="eyebrow">OPERATIONS · 成员服务器 PowerShell 命令</div>
        <h2 class="page-title">成员服务器命令执行</h2>
        <p class="subtitle">
          在任意已注册的成员服务器上执行自由 PowerShell ·
          目标主机<span data-test="host-banner">{{ selectedHost || '—' }}</span>
        </p>
      </div>
      <div class="page-meta">
        <button class="btn-secondary" data-test="mc-refresh-btn" @click="refresh" :disabled="loading">
          {{ loading ? '加载中…' : '↻ 刷新' }}
        </button>
      </div>
    </header>

    <div v-if="loadError" class="error-banner">{{ loadError }}</div>

    <!-- Toolbar -->
    <section class="toolbar">
      <label class="form-label">
        <span>目标成员服务器</span>
        <select data-test="host-picker" v-model="selectedHost" :disabled="loading">
          <option value="">— 请选择 —</option>
          <option v-for="h in hosts" :key="h.hostname" :value="h.hostname">
            {{ h.hostname }}{{ isHostOnline(h) ? '' : ' (离线)' }}
          </option>
        </select>
      </label>
      <div class="toolbar-actions">
        <span
          v-if="selectedHost"
          data-test="host-online-status"
          :class="['status-pill', currentHostOnline ? 'ok' : 'warn']"
        >
          <span class="dot"></span>{{ currentHostOnline ? '心跳在线' : '心跳超时 (5min+)' }}
        </span>
        <button
          class="btn-primary"
          data-test="exec-button"
          @click="openExec"
          :disabled="!selectedHost"
        >+ 执行命令</button>
      </div>
    </section>

    <div v-if="!selectedHost" class="hint-block">请先选择目标成员服务器</div>
    <div v-else>
      <p class="risk-warning">
        提示: 命令将以 <strong>SYSTEM</strong> 权限在目标主机上执行 (R81 mock-first;
        真正的 sandbox 收紧策略 — R81.1 follow-up)。脚本内容会被完整审计持久化。
      </p>

      <section class="recent-section" data-test="mc-recent-section">
        <h3>最近 20 条命令 · {{ selectedHost }}</h3>
        <div v-if="recent.length === 0" class="empty-block">该主机暂无历史命令</div>
        <table v-else class="t">
          <thead>
            <tr>
              <th>#</th>
              <th>类型</th>
              <th>状态</th>
              <th>时长</th>
              <th>提交时间</th>
              <th>错误</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in recent" :key="r.id" :data-test="`mc-recent-row-${r.id}`">
              <td><code>{{ r.id }}</code></td>
              <td><span class="cmd-type">{{ r.commandType }}</span></td>
              <td>
                <span :class="['status-pill', statusClass(r.status)]">
                  <span class="dot"></span>{{ statusLabel(r.status) }}
                </span>
              </td>
              <td>{{ r.durationMs != null ? r.durationMs + 'ms' : '—' }}</td>
              <td>{{ fmt(r.createdAt) }}</td>
              <td class="err-cell" :title="r.errorMessage || ''">
                {{ r.errorMessage ? truncate(r.errorMessage, 60) : '—' }}
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>

    <MemberCommandHistoryDrawer
      :hostname="selectedHost"
      :operator-id="currentUserId"
    />

    <ExecuteCommandModal
      v-if="modalOpen"
      :hostname="selectedHost"
      @close="modalOpen = false"
      @submitted="onSubmitted"
    />
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useAuthStore } from '../../stores/auth.js';
import { memberCommandsApi } from '../../api/member-commands.js';
import AdminLayout from '../../components/AdminLayout.vue';
import MemberCommandHistoryDrawer from './MemberCommandHistoryDrawer.vue';
import ExecuteCommandModal from '../../components/admin/ExecuteCommandModal.vue';

const auth = useAuthStore();
const currentUserId = computed(() => auth.user?.id);

const hosts = ref([]);
const selectedHost = ref('');
const recent = ref([]);
const loading = ref(false);
const loadError = ref('');
const modalOpen = ref(false);

// A host is "online" if its last heartbeat was within the last 5 minutes
// (matches the service-layer guard rail R81 §3 — same threshold).
const ONLINE_WINDOW_MS = 5 * 60 * 1000;

function isHostOnline(h) {
  if (!h.lastHeartbeatAt) return false;
  const ts = new Date(h.lastHeartbeatAt).getTime();
  return Number.isFinite(ts) && (Date.now() - ts) < ONLINE_WINDOW_MS;
}

const currentHostOnline = computed(() => {
  const h = hosts.value.find(x => x.hostname === selectedHost.value);
  return h ? isHostOnline(h) : false;
});

async function loadHosts() {
  loading.value = true;
  loadError.value = '';
  try {
    const r = await memberCommandsApi.listHosts();
    hosts.value = Array.isArray(r.data?.hosts) ? r.data.hosts : [];
  } catch (e) {
    loadError.value = e?.response?.data?.error || e?.message || '加载主机列表失败';
  } finally {
    loading.value = false;
  }
}

async function loadRecent() {
  if (!selectedHost.value) {
    recent.value = [];
    return;
  }
  try {
    const r = await memberCommandsApi.listCommands({ hostname: selectedHost.value, size: 20 });
    recent.value = Array.isArray(r.data?.rows) ? r.data.rows : [];
  } catch {
    recent.value = [];
  }
}

function refresh() {
  loadHosts();
  loadRecent();
}

function openExec() {
  if (!selectedHost.value) return;
  modalOpen.value = true;
}

function onSubmitted(cmd) {
  // The drawer auto-polls; the inline recent table is refreshed with a
  // small delay so the new row lands in the response.
  modalOpen.value = false;
  setTimeout(loadRecent, 1200);
}

function statusClass(s) {
  if (s === 'success') return 'ok';
  if (s === 'failed') return 'err';
  if (s === 'timeout') return 'warn';
  if (s === 'running') return 'warn';
  return 'queued';
}

function statusLabel(s) {
  if (s === 'success') return '成功';
  if (s === 'failed') return '失败';
  if (s === 'timeout') return '超时';
  if (s === 'running') return '运行中';
  if (s === 'queued') return '排队中';
  return s || '—';
}

function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '—'; }
function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + '…' : s; }

onMounted(async () => {
  await loadHosts();
});

// Re-fetch the recent-20 inline table whenever the operator picks a
// different host. Mirrors the drawer's hostname watch — both surfaces
// narrow to the same host. Mirrors the R75 search-button pattern (no
// auto-search on mount; only on user action or pick change).
watch(selectedHost, () => {
  loadRecent();
});
</script>

<style scoped>
.page-header { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 16px; padding-right: 400px; }
.page-titles { display: flex; flex-direction: column; gap: 4px; }
.eyebrow { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.page-title { margin: 0; font-size: 22px; font-weight: 600; }
.subtitle { margin: 0; color: var(--muted); font-size: 13px; }
.page-meta { display: flex; gap: 8px; }
.btn-primary, .btn-secondary {
  padding: 6px 14px; border-radius: 3px; cursor: pointer; font-size: 13px;
  border: 1px solid var(--border); background: var(--input-bg); color: var(--text);
}
.btn-primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
.btn-primary:disabled, .btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }

.error-banner { background: rgba(239, 68, 68, 0.15); color: #dc2626; padding: 8px 12px; border-radius: 4px; margin-bottom: 12px; border: 1px solid rgba(239, 68, 68, 0.3); }
.empty-block, .hint-block { background: var(--panel); padding: 16px; border-radius: 4px; border: 1px solid var(--border); color: var(--muted); }

.toolbar {
  display: flex; gap: 12px; align-items: flex-end;
  background: var(--panel); padding: 12px 16px; border-radius: 4px;
  border: 1px solid var(--border); margin-bottom: 12px; flex-wrap: wrap;
}
.toolbar .form-label { display: flex; flex-direction: column; gap: 4px; min-width: 280px; flex: 1; }
.toolbar .form-label > span { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
.toolbar .form-label select {
  padding: 5px 8px; border: 1px solid var(--border); border-radius: 3px;
  background: var(--input-bg); color: var(--text); font-size: 13px;
}
.toolbar-actions { display: flex; gap: 12px; align-items: center; }

.status-pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
.status-pill .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.status-pill.ok { background: rgba(34, 197, 94, 0.15); color: #16a34a; }
.status-pill.warn { background: rgba(234, 179, 8, 0.15); color: #ca8a04; }
.status-pill.err { background: rgba(239, 68, 68, 0.15); color: #dc2626; }
.status-pill.queued { background: rgba(107, 114, 128, 0.15); color: #6b7280; }

.risk-warning {
  background: rgba(234, 179, 8, 0.12); color: #ca8a04;
  padding: 8px 12px; border-radius: 3px;
  border: 1px solid rgba(234, 179, 8, 0.3);
  font-size: 12px; margin: 12px 0;
}

.recent-section h3 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
.t { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
.t th, .t td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13px; }
.t th { background: var(--input-bg); color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
.t code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--accent); font-size: 12px; }
.cmd-type {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px; padding: 2px 6px; border-radius: 3px;
  background: rgba(96, 165, 250, 0.12); color: #60a5fa;
}
.err-cell { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }

@media (max-width: 1280px) {
  .page-header { padding-right: 340px; }
}
</style>