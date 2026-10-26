<template>
  <AdminLayout>
    <h2>数据库基线</h2>
    <p class="hint">当前数据库方言: <strong>{{ dialect }}</strong> · 最新应用 <code>1.0.6-baseline.sql</code> (已冻结基线为 <code>1.0.0-baseline.sql</code>, 吸收 001-056 增量)</p>

    <div v-if="row" class="version-header">
      <span class="version-label">当前基线: <strong>{{ row.version }}</strong> · {{ row.description }}</span>
      <span :class="'status-' + row.status" class="status-pill">{{ row.status }}</span>
      <span v-if="row.checksumMismatch" class="warn" title="File edited after apply">⚠️</span>
      <span v-if="row.scriptMissing" class="warn" title="Script file missing on disk">📁❌</span>
      <span v-if="upToDate" class="up-to-date-pill">✓ 已是最新</span>
    </div>

    <div class="actions-bar">
      <button :disabled="upgrading" @click="doUpgrade">升级 (重新跑 baseline)</button>
      <button :disabled="upgrading" @click="openDryRun">Dry-run (拆分语句预览)</button>
      <button :disabled="upgrading" @click="openContent">查看 SQL</button>
      <button @click="refresh">刷新</button>
    </div>

    <div v-if="loading" class="loading">加载中...</div>
    <div v-else-if="error" class="error-banner">加载失败: {{ error }} <button @click="refresh">重试</button></div>

    <table v-else-if="row" class="migrations-table">
      <thead>
        <tr>
          <th>Version</th>
          <th>Description</th>
          <th>Status</th>
          <th>Applied At</th>
          <th>Applied By</th>
          <th>Checksum</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><span class="version">{{ row.version }}</span></td>
          <td>{{ row.description }}</td>
          <td><span :class="'status-' + row.status">{{ row.status }}</span></td>
          <td>{{ formatTime(row.appliedAt) }}</td>
          <td>{{ row.appliedBy || '—' }}</td>
          <td><code class="checksum">{{ row.checksum ? row.checksum.slice(0, 8) + '…' : '—' }}</code></td>
        </tr>
      </tbody>
    </table>

    <div v-else class="empty">尚无 baseline 记录(可能初始化未完成)</div>

    <div v-if="globalError" class="global-error">{{ globalError }}</div>

    <!-- Dry-run modal -->
    <div v-if="modalDryRun" class="modal-bg" @click.self="modalDryRun = null">
      <div class="modal">
        <h3>{{ modalDryRun.version }} — Dry-run (拆分后的语句)</h3>
        <p class="hint">不会执行,仅展示语句拆分结果</p>
        <ol>
          <li v-for="s in modalDryRun.statements" :key="s.ordinal">
            <pre class="sql-block">{{ s.sql }}</pre>
          </li>
        </ol>
        <button @click="modalDryRun = null">关闭</button>
      </div>
    </div>

    <!-- Content modal -->
    <div v-if="modalContent" class="modal-bg" @click.self="modalContent = null">
      <div class="modal">
        <h3>{{ modalContent.version }} — SQL 内容</h3>
        <pre class="sql-block">{{ modalContent.sql }}</pre>
        <button @click="modalContent = null">关闭</button>
      </div>
    </div>
  </AdminLayout>
</template>

<script setup>
// R158.51 (2026-10-08) — baseline freeze.
// Schema Migrations UI no longer manages a chain of incremental files.
// It shows one baseline (1.0.0-baseline.sql) with its description, applied
// state, and a Dry-run / view / upgrade affordance. The /apply, /reset,
// /refresh-checksum, /mark-applied, /baseline, /apply-up-to endpoints are
// still served by the backend for script/back-compat use, but no longer
// reachable from this page — a single baseline doesn't need "apply a
// specific version" or "skip verify markers".
import { ref, computed, onMounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { listMigrations, dryRunMigration, upgrade as doUpgradeApi } from '../../api/migrations.js';
import { notifyError, notifySuccess } from '../../lib/notify.js';
import { formatDateTime } from '../../lib/timezone.js';

const rows = ref([]);
const loading = ref(false);
const error = ref(null);
const modalContent = ref(null);
const modalDryRun = ref(null);
const globalError = ref(null);
const upgrading = ref(false);

// R158.68.3 (2026-10-10) — 显示最新应用版本 (sorted 末位), 不是 frozen baseline.
//   listMigrations 已按 semver 升序排, 取末位 = 最新. 1.0.0 仍存在 (R158.42 backfill)
//   但被吸收为 frozen baseline, 1.0.1~1.0.6 是 R158.61+ R158.68 后续 ad-hoc 增量.
const row = computed(() => rows.value.length ? rows.value[rows.value.length - 1] : null);
const dialect = computed(() => row.value?.dialect || 'unknown');
// "已是最新" only when the baseline row is 'applied'. Pending/failed means
// the bootstrap step hasn't completed yet — operator should run upgrade.
const upToDate = computed(() => row.value?.status === 'applied');

async function refresh() {
  loading.value = true;
  error.value = null;
  try {
    const r = await listMigrations();
    rows.value = r.data || [];
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    loading.value = false;
  }
}

function errMsg(e) {
  return e?.response?.data?.error || e?.message || String(e);
}

function formatTime(s) {
  if (!s) return '—';
  return formatDateTime(s, { fallback: s });
}

async function openContent() {
  if (!row.value) return;
  try {
    const r = await dryRunMigration(row.value.version);
    modalContent.value = {
      version: row.value.version,
      sql: r.data.statements.map(s => s.sql).join(';\n')
    };
  } catch (e) {
    notifyError(`读取 ${row.value.version} 内容失败: ${errMsg(e)}`);
  }
}

async function openDryRun() {
  if (!row.value) return;
  try {
    const r = await dryRunMigration(row.value.version);
    modalDryRun.value = { version: row.value.version, statements: r.data.statements };
  } catch (e) {
    notifyError(`Dry-run ${row.value.version} 失败: ${errMsg(e)}`);
  }
}

async function doUpgrade() {
  if (upToDate.value) return;
  if (!confirm('重新跑 baseline?\n\n所有 DDL 都是 IF NOT EXISTS 守卫,幂等;但生产环境改动前请先备份数据库。')) return;
  upgrading.value = true;
  globalError.value = null;
  try {
    const r = await doUpgradeApi();
    notifySuccess(r?.data?.message || '升级完成');
    await refresh();
  } catch (e) {
    const msg = errMsg(e);
    globalError.value = `升级失败: ${msg}`;
    notifyError(`升级失败: ${msg}`);
  } finally {
    upgrading.value = false;
  }
}

onMounted(refresh);
</script>

<style scoped>
.hint { color: var(--muted); font-size: 13px; }
.hint code { background: var(--sidebar-bg); padding: 1px 4px; border-radius: 2px; font-size: 12px; }
.version-header { display: flex; align-items: center; gap: 14px; padding: 12px 16px; margin: 12px 0; background: var(--panel); border: 1px solid var(--border); border-radius: 4px; }
.version-label { font-size: 14px; color: var(--text); }
.version-label strong { font-size: 16px; color: var(--accent); margin: 0 4px; }
.status-pill { padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; }
.status-pill.status-applied { background: var(--success-bg); color: var(--green); }
.status-pill.status-pending { background: var(--warning-bg); color: var(--hub-gold); }
.status-pill.status-failed { background: var(--danger-bg); color: var(--severity-critical-text); }
.up-to-date-pill { background: var(--success-bg); color: var(--green); padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; }
.warn { color: var(--hub-gold); margin-left: 4px; }
.actions-bar { display: flex; gap: 8px; margin: 12px 0; }
.actions-bar button { background: var(--sidebar-bg); color: var(--text); border: 1px solid var(--border); padding: 6px 14px; border-radius: 3px; cursor: pointer; }
.actions-bar button:hover:not(:disabled) { border-color: var(--accent); }
.actions-bar button:disabled { opacity: 0.5; cursor: not-allowed; }
.migrations-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.migrations-table th, .migrations-table td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); }
.status-applied { color: var(--green); font-weight: 600; }
.status-pending { color: var(--hub-gold); font-weight: 600; }
.status-failed { color: var(--red); font-weight: 600; }
.checksum { font-family: monospace; font-size: 11px; color: var(--muted); }
.empty { padding: 24px; color: var(--muted); text-align: center; }
.error-banner { padding: 12px; background: var(--danger-bg); color: var(--severity-critical-text); border-radius: 3px; margin: 12px 0; }
.error-banner button { margin-left: 8px; }
.modal-bg { position: fixed; inset: 0; background: var(--modal-backdrop); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--panel); padding: 20px; max-width: 800px; max-height: 80vh; overflow: auto; border-radius: 4px; }
.sql-block { background: var(--sidebar-bg); padding: 12px; border-radius: 3px; overflow-x: auto; font-family: monospace; font-size: 12px; white-space: pre-wrap; }
.global-error { margin-top: 12px; padding: 10px 12px; background: var(--danger-bg); border-radius: 4px; color: var(--severity-critical-text); white-space: pre-wrap; font-size: 12px; }
</style>