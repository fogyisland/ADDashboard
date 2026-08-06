<template>
  <AppLayout>
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
          <th>Applied At</th>
          <th>Applied By</th>
          <th>Exec (ms)</th>
          <th>Checksum</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.version" :class="{ 'row-failed': row.status === 'failed' }">
          <td>
            <span class="version">{{ row.version }}</span>
            <span v-if="row.checksumMismatch" class="warn" title="File edited after apply">⚠️</span>
            <span v-if="row.scriptMissing" class="warn" title="Script file missing on disk">📁❌</span>
          </td>
          <td>{{ row.description }}</td>
          <td><span :class="'status-' + row.status">{{ row.status }}</span></td>
          <td>{{ formatTime(row.appliedAt) }}</td>
          <td>{{ row.appliedBy || '—' }}</td>
          <td>{{ row.executionMs ?? '—' }}</td>
          <td><code class="checksum">{{ row.checksum ? row.checksum.slice(0, 8) + '…' : '—' }}</code></td>
          <td class="actions">
            <button class="view-btn" @click="openContent(row)">查看</button>
            <template v-if="row.status === 'pending'">
              <button class="dryrun-btn" @click="openDryRun(row)">Dry-run</button>
              <button class="apply-btn" @click="applyOne(row)">应用</button>
            </template>
            <template v-if="row.status === 'failed'">
              <button class="reset-btn" @click="resetOne(row)">重置</button>
            </template>
          </td>
        </tr>
      </tbody>
    </table>

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
  </AppLayout>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import AppLayout from '../../components/AppLayout.vue';
import { listMigrations, applyMigration, dryRunMigration, resetMigration } from '../../api/migrations.js';

const rows = ref([]);
const loading = ref(false);
const error = ref(null);
const modalContent = ref(null);
const modalDryRun = ref(null);

const dialect = computed(() => rows.value[0]?.dialect || 'unknown');
const pendingCount = computed(() => rows.value.filter(r => r.status === 'pending').length);

async function refresh() {
  loading.value = true;
  error.value = null;
  try {
    const r = await listMigrations();
    rows.value = r.data || [];
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    loading.value = false;
  }
}

async function openContent(row) {
  const r = await dryRunMigration(row.version);
  modalContent.value = { version: row.version, sql: r.data.statements.map(s => s.sql).join(';\n') };
}

async function openDryRun(row) {
  const r = await dryRunMigration(row.version);
  modalDryRun.value = { version: row.version, statements: r.data.statements };
}

async function applyOne(row) {
  if (!confirm(`应用 migration ${row.version} (${row.description}) 到当前数据库?\n\n此操作不可逆(仅 admin 手动 reset 可清除 failed 状态)。`)) return;
  await applyMigration(row.version, {});
  await refresh();
}

async function resetOne(row) {
  if (!confirm(`重置 migration ${row.version}?\n\n仅清除 schema_migrations 中的 failed 记录 — 不会回滚 DB schema 变更。`)) return;
  await resetMigration(row.version);
  await refresh();
}

async function applyAllPending() {
  const pendings = rows.value.filter(r => r.status === 'pending');
  if (!confirm(`依次应用 ${pendings.length} 条 pending migration?\n\n失败会中断后续 migration。`)) return;
  for (const row of pendings) {
    await applyMigration(row.version, {});
  }
  await refresh();
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
.failed-banner { margin-top: 12px; padding: 12px; background: #7f1d1d; border-radius: 4px; color: #fecaca; }
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--panel); padding: 20px; max-width: 800px; max-height: 80vh; overflow: auto; border-radius: 4px; }
.sql-block { background: #0b1220; padding: 12px; border-radius: 3px; overflow-x: auto; font-family: monospace; font-size: 12px; white-space: pre-wrap; }
</style>