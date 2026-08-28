<template>
  <AdminLayout>
    <h2>数据库迁移管理</h2>
    <p class="hint">当前数据库方言: <strong>{{ dialect }}</strong></p>

    <div v-if="rows.length > 0" class="version-header">
      <span class="version-label">当前版本: <strong>{{ latestAppliedVersion || '—' }}</strong></span>
      <span class="version-arrow">→</span>
      <span class="version-label">最新版本: <strong>{{ latestFileVersion }}</strong></span>
      <span v-if="pendingCount > 0" class="pending-pill">⚠ 有 {{ pendingCount }} 条待升级</span>
      <span v-else class="up-to-date-pill">✓ 已是最新</span>
    </div>

    <div class="actions-bar">
      <button class="upgrade-btn" :disabled="upToDate || upgrading" @click="doUpgrade">
        {{ upgrading ? '升级中…' : (upToDate ? '已是最新' : '升级到最新') }}
      </button>
      <button v-if="pendingCount > 0" class="apply-all" @click="applyAllPending">全部应用 ({{ pendingCount }})</button>
      <button :disabled="upgrading" @click="openBaselineModal">记录当前版本</button>
      <button :disabled="upgrading" @click="openApplyUpToModal">应用到版本</button>
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
                <button class="mark-btn" :disabled="applying.has(row.version)" @click="doMarkApplied(row)">
                  {{ applying.has(row.version) ? '标记中…' : '标记已应用' }}
                </button>
              </template>
              <template v-if="row.status === 'failed'">
                <button class="reset-btn" :disabled="applying.has(row.version)" @click="resetOne(row)">
                  {{ applying.has(row.version) ? '重置中…' : '重置' }}
                </button>
                <button class="mark-btn" :disabled="applying.has(row.version)" @click="doMarkApplied(row)">
                  {{ applying.has(row.version) ? '标记中…' : '标记已应用' }}
                </button>
              </template>
              <!-- 2026-08-28 round-55: refresh SHA-256 to silence ⚠️ "File edited after apply".
                   Only meaningful when the row is applied AND the file drifted post-apply.
                   Server preserves status / applied_at / applied_by / execution_ms / error_message —
                   only the checksum column is rewritten. See migrations.refreshChecksum. -->
              <template v-if="row.status === 'applied' && row.checksumMismatch">
                <button class="refresh-btn" :disabled="applying.has(row.version)" @click="doRefreshChecksum(row)">
                  {{ applying.has(row.version) ? '刷新中…' : '刷新校验和' }}
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

    <!-- Baseline modal (记录当前系统版本) -->
    <div v-if="modalBaselineOpen" class="modal-bg" @click.self="closeBaselineModal">
      <div class="modal">
        <h3>记录当前系统版本</h3>
        <p class="hint">把指定版本及之前的所有 migration 标记为已应用(不执行 SQL)。适用于手动执行过 migrations 或恢复备份后对齐。需 verify marker 命中。</p>
        <input v-model="baselineInput" placeholder="版本号 (例: 014)" :disabled="upgrading" />
        <div class="modal-actions">
          <button @click="closeBaselineModal" :disabled="upgrading">取消</button>
          <button @click="confirmBaseline" :disabled="!baselineInput || upgrading">确认</button>
        </div>
      </div>
    </div>

    <!-- Apply-up-to modal -->
    <div v-if="modalApplyUpToOpen" class="modal-bg" @click.self="closeApplyUpToModal">
      <div class="modal">
        <h3>应用到版本</h3>
        <p class="hint">依次应用所有 pending migration,直到指定版本(含)。</p>
        <input v-model="applyUpToInput" placeholder="版本号 (例: 014)" :disabled="upgrading" />
        <div class="modal-actions">
          <button @click="closeApplyUpToModal" :disabled="upgrading">取消</button>
          <button @click="confirmApplyUpTo" :disabled="!applyUpToInput || upgrading">确认</button>
        </div>
      </div>
    </div>
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { listMigrations, applyMigration, dryRunMigration, resetMigration, refreshChecksum, markApplied, baseline, applyUpTo, upgrade } from '../../api/migrations.js';
import { notifyError, notifySuccess } from '../../lib/notify.js';

const rows = ref([]);
const loading = ref(false);
const error = ref(null);
const modalContent = ref(null);
const modalDryRun = ref(null);
const modalBaselineOpen = ref(false);
const modalApplyUpToOpen = ref(false);
const baselineInput = ref('');
const applyUpToInput = ref('');
// Versions with an in-flight apply/reset. A Set (not a per-row boolean)
// so 全部应用 can track several rows without mutating the row objects,
// which get replaced wholesale on every refresh().
const applying = ref(new Set());
// version -> error string, shown as a red bar under the row. Cleared by refresh()
// because a successful refresh means the row's real status came from the server.
const rowError = ref({});
const globalError = ref(null);
// True while the primary CTA (升级到最新) or a modal-confirmed action is in flight.
// Distinct from `applying` (per-row) so the page-level CTA stays responsive to
// pending rows even while no single-row apply is running.
const upgrading = ref(false);

const dialect = computed(() => rows.value[0]?.dialect || 'unknown');
const pendingCount = computed(() => rows.value.filter(r => r.status === 'pending').length);

// Header: highest version known on disk (rows are sorted ascending by server).
const latestFileVersion = computed(() => rows.value[rows.value.length - 1]?.version || '—');
// Header: highest version whose status is 'applied'. '—' when none applied yet.
const latestAppliedVersion = computed(() => {
  const applied = rows.value.filter(r => r.status === 'applied');
  if (applied.length === 0) return null;
  return applied[applied.length - 1].version;
});
// Header: "已是最新" pill shows when no pending rows AND nothing newer on disk.
const upToDate = computed(() => {
  if (pendingCount.value > 0) return false;
  if (rows.value.length === 0) return false;
  return latestFileVersion.value === latestAppliedVersion.value;
});

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

// Per-row 标记已应用 — only meaningful for pending/failed rows that the operator
// has already executed manually (or restored from a backup). Does NOT execute
// any SQL — server requires a verify marker (checksum match) to accept.
async function doMarkApplied(row) {
  if (!confirm(`标记 migration ${row.version} 为已应用?\n\n不执行 SQL — 适用于你已经手动执行了此 migration 的场景。`)) return;
  applying.value = new Set(applying.value).add(row.version);
  delete rowError.value[row.version];
  globalError.value = null;
  try {
    await markApplied(row.version);
    notifySuccess(`Migration ${row.version} 已标记为已应用`);
    await refresh();
  } catch (e) {
    const msg = errMsg(e);
    rowError.value = { ...rowError.value, [row.version]: msg };
    notifyError(`标记失败: ${msg}`);
  } finally {
    const next = new Set(applying.value);
    next.delete(row.version);
    applying.value = next;
  }
}

// 2026-08-28 round-55: refresh stored SHA-256 to silence ⚠️ "File edited after apply".
// Operator confirms they trust the file-vs-DB divergence is cosmetic (the DB schema
// is verified working; the file was edited post-apply for verify markers /
// dialect-compat rewrite with identical output). Server overwrites ONLY the
// checksum column — status, applied_at, applied_by, execution_ms, error_message
// all preserved.
async function doRefreshChecksum(row) {
  if (!confirm(`刷新 migration ${row.version} 的校验和?\n\n文件已修改 (post-apply),将用磁盘当前 SHA-256 覆盖数据库中存储的旧值。不会重跑 SQL、不会改 status / applied_at / applied_by。\n\n请确认你已经核对过 DB schema 与当前文件输出一致。`)) return;
  applying.value = new Set(applying.value).add(row.version);
  delete rowError.value[row.version];
  globalError.value = null;
  try {
    await refreshChecksum(row.version);
    notifySuccess(`Migration ${row.version} 校验和已刷新`);
    await refresh();
  } catch (e) {
    const msg = errMsg(e);
    rowError.value = { ...rowError.value, [row.version]: msg };
    notifyError(`刷新校验和失败: ${msg}`);
  } finally {
    const next = new Set(applying.value);
    next.delete(row.version);
    applying.value = next;
  }
}

// Page-level primary CTA. Calls the bulk /upgrade endpoint, which applies
// every pending migration in order AND re-runs the seed file if its
// checksum changed. The server returns a `message` for both success and
// partial failure — surface it directly.
async function doUpgrade() {
  if (upToDate.value) return; // disabled, but guard for keyboard activation
  if (!confirm('执行架构升级 + 重跑 seed?\n\n将依次应用所有 pending migration,如有 seed 更新也会一并应用。')) return;
  upgrading.value = true;
  globalError.value = null;
  try {
    const r = await upgrade();
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

// Modal: 记录当前系统版本 (server: /baseline). Marks every migration up to
// and including the input version as applied — without executing any SQL.
// Use case: operator restored a DB backup that already has the schema.
// Skipped versions (no verify marker) are surfaced as a separate notify.
function openBaselineModal() {
  baselineInput.value = '';
  modalBaselineOpen.value = true;
}
function closeBaselineModal() {
  modalBaselineOpen.value = false;
  baselineInput.value = '';
}
async function confirmBaseline() {
  if (!baselineInput.value) return;
  upgrading.value = true;
  try {
    const r = await baseline(baselineInput.value);
    notifySuccess(`基线 ${baselineInput.value} 已标记: ${r.data.versions.length} 个版本`);
    if (r.data.skipped && r.data.skipped.length > 0) {
      notifyError(`${r.data.skipped.length} 个版本因 verify marker 缺失跳过`);
    }
    closeBaselineModal();
    await refresh();
  } catch (e) {
    notifyError(`基线标记失败: ${errMsg(e)}`);
  } finally {
    upgrading.value = false;
  }
}

// Modal: 应用到版本 (server: /apply-up-to). Applies every pending migration
// up to and including the input version. Failures are reported but do not
// stop the loop (server-side behaviour).
function openApplyUpToModal() {
  applyUpToInput.value = '';
  modalApplyUpToOpen.value = true;
}
function closeApplyUpToModal() {
  modalApplyUpToOpen.value = false;
  applyUpToInput.value = '';
}
async function confirmApplyUpTo() {
  if (!applyUpToInput.value) return;
  upgrading.value = true;
  try {
    const r = await applyUpTo(applyUpToInput.value);
    const failed = r.data.failed?.length || 0;
    const applied = r.data.applied?.length || 0;
    if (failed > 0) {
      notifyError(`应用完成: ${applied} 成功, ${failed} 失败`);
    } else {
      notifySuccess(`应用完成: ${applied} 条`);
    }
    closeApplyUpToModal();
    await refresh();
  } catch (e) {
    notifyError(`应用失败: ${errMsg(e)}`);
  } finally {
    upgrading.value = false;
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
.version-header { display: flex; align-items: center; gap: 14px; padding: 12px 16px; margin: 12px 0; background: var(--panel); border: 1px solid #1e293b; border-radius: 4px; }
.version-label { font-size: 14px; color: var(--text); }
.version-label strong { font-size: 16px; color: var(--accent); margin: 0 4px; }
.version-arrow { color: var(--muted); font-size: 16px; }
.pending-pill { background: #422006; color: #fbbf24; padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; }
.up-to-date-pill { background: #022c22; color: #10b981; padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; }
.actions-bar { display: flex; gap: 8px; margin: 12px 0; }
.apply-all { background: var(--accent); color: #0b1220; padding: 6px 14px; border: none; border-radius: 3px; cursor: pointer; font-weight: 600; }
.upgrade-btn { background: #10b981; color: #fff; padding: 6px 14px; border: none; border-radius: 3px; cursor: pointer; font-weight: 600; }
.upgrade-btn:disabled { background: #1e293b; color: var(--muted); cursor: not-allowed; }
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
.mark-btn { background: #f59e0b; color: #0b1220; font-weight: 600; }
.mark-btn:hover:not(:disabled) { border-color: #f59e0b; }
/* 2026-08-28 round-55: refresh-checksum button — neutral slate styling so
   it doesn't compete visually with mark-applied (orange/amber) or
   reset (destructive). The ⚠ icon on the row already conveys the
   reason; the button is just the operator's "yes, I've verified" click. */
.refresh-btn { color: #93c5fd; }
.refresh-btn:hover:not(:disabled) { border-color: #60a5fa; color: #bfdbfe; }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.modal-actions button { padding: 6px 14px; }
.modal input[type="text"], .modal input:not([type]) { width: 100%; padding: 8px; background: #0b1220; color: var(--text); border: 1px solid #1e293b; border-radius: 3px; margin-top: 8px; font-family: monospace; }
.error-cell { color: #fca5a5; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-error-bar td { background: #450a0a; color: #fecaca; font-size: 12px; padding: 6px 10px; }
.global-error { margin-top: 12px; padding: 10px 12px; background: #7f1d1d; border-radius: 4px; color: #fecaca; white-space: pre-wrap; font-size: 12px; }
.failed-banner { margin-top: 12px; padding: 12px; background: #7f1d1d; border-radius: 4px; color: #fecaca; }
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--panel); padding: 20px; max-width: 800px; max-height: 80vh; overflow: auto; border-radius: 4px; }
.sql-block { background: #0b1220; padding: 12px; border-radius: 3px; overflow-x: auto; font-family: monospace; font-size: 12px; white-space: pre-wrap; }
</style>