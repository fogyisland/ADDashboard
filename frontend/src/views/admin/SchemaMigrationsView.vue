<template>
  <AdminLayout>
    <h2>数据库迁移管理</h2>
    <p class="hint">当前数据库方言: <strong>{{ dialect }}</strong></p>

    <div class="actions-bar">
      <button v-if="pendingCount > 0" class="apply-all" @click="applyAllPending">全部应用 ({{ pendingCount }})</button>
      <button @click="refresh">刷新</button>
    </div>

    <div v-if="loading" class="loading">加载中...</div>
    <div v-else-if="error" class="error-banner">加载失败: {{ error }} <button @click="refresh">重试</button></div>

    <table v-else class="migrations-table">
      <thead>
        <tr>
          <th>Version</th>
          <th>Description</th>
          <th>Status</th>
          <th>Error</th>
          <th>Applied At</th>
          <th>Applied By</th>
          <th>Exec (ms)</th>
          <th>Checksum</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="row in rows" :key="row.version">
          <tr :class="{ 'row-failed': row.status === 'failed' }">
            <td>
              <span class="version">{{ row.version }}</span>
              <span v-if="row.checksumMismatch" class="warn" title="File edited after apply">⚠️</span>
              <span v-if="row.scriptMissing" class="warn" title="Script file missing on disk">📁❌</span>
            </td>
            <td>{{ row.description }}</td>
            <td><span :class="'status-' + row.status">{{ row.status }}</span></td>
            <td class="error-cell" :title="row.errorMessage || ''">{{ truncate(row.errorMessage) }}</td>
            <td>{{ formatTime(row.appliedAt) }}</td>
            <td>{{ row.appliedBy || '—' }}</td>
            <td>{{ row.executionMs ?? '—' }}</td>
            <td><code class="checksum">{{ row.checksum ? row.checksum.slice(0, 8) + '…' : '—' }}</code></td>
            <td class="actions">
              <button class="view-btn" @click="openContent(row)">查看</button>
              <template v-if="row.status === 'pending'">
                <button class="dryrun-btn" :disabled="applying.has(row.version)" @click="openDryRun(row)">Dry-run</button>
                <button class="apply-btn" :disabled="applying.has(row.version)" @click="applyOne(row)">
                  {{ applying.has(row.version) ? '应用中…' : '应用' }}
                </button>
              </template>
              <template v-if="row.status === 'failed'">
                <button class="reset-btn" :disabled="applying.has(row.version)" @click="resetOne(row)">
                  {{ applying.has(row.version) ? '重置中…' : '重置' }}
                </button>
              </template>
            </td>
          </tr>
          <tr v-if="rowError[row.version]" class="row-error-bar">
            <td :colspan="9">✖ {{ rowError[row.version] }}</td>
          </tr>
        </template>
      </tbody>
    </table>

    <div v-if="globalError" class="global-error">{{ globalError }}</div>

    <div v-if="rows.some(r => r.status === 'failed')" class="failed-banner">
      ⚠️ 有 migration 处于 failed 状态。DDL 部分失败可能已经修改了数据库 — 重置前请手动核对。
    </div>

    <!-- Content modal -->
    <div v-if="modalContent" class="modal-bg" @click.self="modalContent = null">
      <div class="modal">
        <h3>{{ modalContent.version }} — SQL</h3>
        <pre class="sql-block">{{ modalContent.sql }}</pre>
        <button @click="modalContent = null">关闭</button>
      </div>
    </div>

    <!-- Dry-run modal -->
    <div v-if="modalDryRun" class="modal-bg" @click.self="modalDryRun = null">
      <div class="modal">
        <h3>{{ modalDryRun.version }} — 拆分后的语句</h3>
        <p class="hint">不会执行,仅展示 dry-run 结果</p>
        <ol>
          <li v-for="s in modalDryRun.statements" :key="s.ordinal">
            <pre class="sql-block">{{ s.sql }}</pre>
          </li>
        </ol>
        <button @click="modalDryRun = null">关闭</button>
      </div>
    </div>
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { listMigrations, applyMigration, dryRunMigration, resetMigration } from '../../api/migrations.js';
import { notifyError, notifySuccess } from '../../lib/notify.js';

const rows = ref([]);
const loading = ref(false);
const error = ref(null);
const modalContent = ref(null);
const modalDryRun = ref(null);
// Versions with an in-flight apply/reset. A Set (not a per-row boolean)
// so 全部应用 can track several rows without mutating the row objects,
// which get replaced wholesale on every refresh().
const applying = ref(new Set());
// version -> error string, shown as a red bar under the row. Cleared by refresh()
// because a successful refresh means the row's real status came from the server.
const rowError = ref({});
const globalError = ref(null);

const dialect = computed(() => rows.value[0]?.dialect || 'unknown');
const pendingCount = computed(() => rows.value.filter(r => r.status === 'pending').length);

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

// Axios rejections carry the server's message on response.data.error; plain
// Errors (network, mock) only have .message. Reading both means an operator
// sees "Duplicate column name" rather than the useless "Request failed with 500".
function errMsg(e) {
  return e?.response?.data?.error || e?.message || String(e);
}

function truncate(s) {
  if (!s) return '—';
  return s.length > 60 ? s.slice(0, 60) + '…' : s;
}

async function openContent(row) {
  try {
    const r = await dryRunMigration(row.version);
    modalContent.value = { version: row.version, sql: r.data.statements.map(s => s.sql).join(';\n') };
  } catch (e) {
    notifyError(`读取 ${row.version} 内容失败: ${errMsg(e)}`);
  }
}

async function openDryRun(row) {
  try {
    const r = await dryRunMigration(row.version);
    modalDryRun.value = { version: row.version, statements: r.data.statements };
  } catch (e) {
    notifyError(`Dry-run ${row.version} 失败: ${errMsg(e)}`);
  }
}

async function applyOne(row) {
  if (!confirm(`应用 migration ${row.version} (${row.description}) 到当前数据库?\n\n此操作不可逆(仅 admin 手动 reset 可清除 failed 状态)。`)) return;
  applying.value = new Set(applying.value).add(row.version);
  delete rowError.value[row.version];
  globalError.value = null;
  try {
    const r = await applyMigration(row.version, {});
    if (r?.data?.ok === false) {
      // HTTP 200 with ok:false — the server ran the migration and it failed.
      // Without this branch the UI silently showed nothing (the original bug).
      const msg = r.data.errorMessage || '应用失败';
      rowError.value = { ...rowError.value, [row.version]: msg };
      notifyError(`Migration ${row.version} 失败: ${msg}`);
    } else {
      notifySuccess(`Migration ${row.version} 应用成功`);
    }
    await refresh();
  } catch (e) {
    const msg = errMsg(e);
    rowError.value = { ...rowError.value, [row.version]: msg };
    notifyError(`Migration ${row.version} 失败: ${msg}`);
  } finally {
    const next = new Set(applying.value);
    next.delete(row.version);
    applying.value = next;
  }
}

async function resetOne(row) {
  if (!confirm(`重置 migration ${row.version}?\n\n仅清除 schema_migrations 中的 failed 记录 — 不会回滚 DB schema 变更。`)) return;
  applying.value = new Set(applying.value).add(row.version);
  delete rowError.value[row.version];
  try {
    await resetMigration(row.version);
    notifySuccess(`Migration ${row.version} 已重置`);
    await refresh();
  } catch (e) {
    const msg = errMsg(e);
    rowError.value = { ...rowError.value, [row.version]: msg };
    notifyError(`重置 ${row.version} 失败: ${msg}`);
  } finally {
    const next = new Set(applying.value);
    next.delete(row.version);
    applying.value = next;
  }
}

async function applyAllPending() {
  const pendings = rows.value.filter(r => r.status === 'pending');
  if (!confirm(`依次应用 ${pendings.length} 条 pending migration?\n\n失败的会被记录,后续 migration 仍会尝试。`)) return;
  globalError.value = null;
  const failures = [];
  const errs = { ...rowError.value };
  for (const row of pendings) {
    applying.value = new Set(applying.value).add(row.version);
    try {
      const r = await applyMigration(row.version, {});
      if (r?.data?.ok === false) {
        const msg = r.data.errorMessage || '应用失败';
        errs[row.version] = msg;
        failures.push(`${row.version}: ${msg}`);
      } else {
        delete errs[row.version];
      }
    } catch (e) {
      const msg = errMsg(e);
      errs[row.version] = msg;
      failures.push(`${row.version}: ${msg}`);
    } finally {
      const next = new Set(applying.value);
      next.delete(row.version);
      applying.value = next;
    }
  }
  await refresh();
  rowError.value = errs;
  if (failures.length > 0) {
    globalError.value = `${failures.length} 条 migration 应用失败:\n${failures.join('\n')}`;
    notifyError(`${failures.length} 条失败: ${failures.join('; ')}`);
  } else {
    notifySuccess(`全部 ${pendings.length} 条 migration 应用成功`);
  }
}

function formatTime(s) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString();
}

onMounted(refresh);
</script>

<style scoped>
.hint { color: var(--muted); font-size: 13px; }
.actions-bar { display: flex; gap: 8px; margin: 12px 0; }
.apply-all { background: var(--accent); color: #0b1220; padding: 6px 14px; border: none; border-radius: 3px; cursor: pointer; font-weight: 600; }
.migrations-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.migrations-table th, .migrations-table td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; }
.migrations-table tr.row-failed { background: #422006; }
.status-applied { color: #10b981; font-weight: 600; }
.status-pending { color: #fbbf24; font-weight: 600; }
.status-failed { color: #ef4444; font-weight: 600; }
.checksum { font-family: monospace; font-size: 11px; color: var(--muted); }
.warn { color: #fbbf24; margin-left: 4px; }
.actions { display: flex; gap: 4px; }
.actions button { padding: 4px 10px; background: #0b1220; color: var(--text); border: 1px solid #1e293b; border-radius: 3px; cursor: pointer; font-size: 11px; }
.actions button:hover { border-color: var(--accent); }
.actions button:disabled { opacity: 0.5; cursor: not-allowed; }
.error-cell { color: #fca5a5; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-error-bar td { background: #450a0a; color: #fecaca; font-size: 12px; padding: 6px 10px; }
.global-error { margin-top: 12px; padding: 10px 12px; background: #7f1d1d; border-radius: 4px; color: #fecaca; white-space: pre-wrap; font-size: 12px; }
.failed-banner { margin-top: 12px; padding: 12px; background: #7f1d1d; border-radius: 4px; color: #fecaca; }
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--panel); padding: 20px; max-width: 800px; max-height: 80vh; overflow: auto; border-radius: 4px; }
.sql-block { background: #0b1220; padding: 12px; border-radius: 3px; overflow-x: auto; font-family: monospace; font-size: 12px; white-space: pre-wrap; }
</style>