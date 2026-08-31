<!--
  R66 T10 — 包管理 (PackagesView)

  Operator can:
   - see all installed scripts (rows from GET /api/admin/packages, new
     envelope {items: [...]})
   - upload raw PS1 scripts via UploadScriptModal
   - view the raw script body via EditScriptModal (viewMode, R67-T1)
   - edit a script body via EditScriptModal (PUT .../script)
   - edit a script's policy via EditPolicyModal (PUT .../policy)
   - toggle enabled (PUT .../enable / disable)
   - delete with confirm (DELETE .../:name)

  The view talks directly to packagesApi (no Pinia store). The legacy
  Pinia store at src/stores/packages.js is intentionally kept alive for
  PackageEditView / RegistryView — T13 cleans them up.

  Visual language matches R49 ops-console: dimmer L1 title, status-pill
  3-color, tnum on numbers, 2px left rail on row hover.

  data-test contract (matched by tests/packages-view.test.js):
    upload-btn                 — "+ 上传脚本" toolbar button
    refresh-btn                — "↻ 刷新" toolbar button
    row-${name}                — table row
    script-row                 — table row class
    view-script-${name}        — per-row 查看 button (R67-T1, opens modal in viewMode)
    edit-script-${name}        — per-row 脚本 button (opens EditScriptModal)
    edit-policy-${name}        — per-row 策略 button
    toggle-${name}             — per-row 启用/禁用 button
    delete-${name}             — per-row 删除 button
-->
<template>
  <AdminLayout>
    <header class="page-header">
      <div class="page-titles">
        <div class="eyebrow">OPERATIONS · 脚本与策略</div>
        <h2 class="page-title">包管理</h2>
        <p class="subtitle">上传脚本并配置执行策略;支持启用/禁用、按间隔与超时自动执行。</p>
      </div>
      <div class="page-meta">
        <button class="btn-secondary" data-test="refresh-btn" @click="refresh" :disabled="loading">
          {{ loading ? '加载中…' : '↻ 刷新' }}
        </button>
        <button class="btn-primary" data-test="upload-btn" @click="openUpload">+ 上传脚本</button>
      </div>
    </header>

    <div v-if="error" class="error-banner">{{ error }}</div>

    <table v-if="items.length" class="t">
      <thead>
        <tr>
          <th>名称</th>
          <th>版本</th>
          <th>类型</th>
          <th>启用</th>
          <th class="num">间隔(s)</th>
          <th class="num">超时(ms)</th>
          <th>来源</th>
          <th>最后修改</th>
          <th class="actions-col">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="it in items"
          :key="it.name"
          class="script-row"
          :data-test="`row-${it.name}`"
        >
          <td class="name-cell">
            <span class="name">{{ it.name }}</span>
            <span v-if="it.source === 'builtin-seed'" class="source-tag builtin">内置</span>
          </td>
          <td><code class="version">{{ it.version }}</code></td>
          <td><span class="type-tag" :class="`type-${it.type}`">{{ it.type || '—' }}</span></td>
          <td>
            <span :class="['status-pill', it.enabled ? 'ok' : 'off']">
              <span class="dot"></span>{{ it.enabled ? '已启用' : '已禁用' }}
            </span>
          </td>
          <td class="num">{{ it.intervalSec ?? '—' }}</td>
          <td class="num">{{ it.timeoutMs ?? '—' }}</td>
          <td><code class="source">{{ it.source }}</code></td>
          <td>{{ fmt(it.updatedAt) }}</td>
          <td class="row-actions">
            <!-- R67-T1 — view-mode entry point. Opens EditScriptModal in
                 readonly view, closing the R66-T10 data-loss gap (the
                 edit modal opens empty because the list endpoint omits
                 LONGTEXT script_content; this button gives operators a
                 way to inspect the currently-installed body before
                 deciding whether to replace). -->
            <button :data-test="`view-script-${it.name}`" @click="openViewScript(it)">查看</button>
            <button :data-test="`edit-script-${it.name}`" @click="openEditScript(it)">脚本</button>
            <button :data-test="`edit-policy-${it.name}`" @click="openEditPolicy(it)">策略</button>
            <button :data-test="`toggle-${it.name}`" @click="toggleEnabled(it)">
              {{ it.enabled ? '禁用' : '启用' }}
            </button>
            <button class="danger" :data-test="`delete-${it.name}`" @click="confirmDelete(it)">删除</button>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-else-if="!loading && !error" class="empty">
      暂无脚本。点 + 上传脚本 添加。
    </div>

    <UploadScriptModal
      v-if="showUpload"
      @close="showUpload = false"
      @uploaded="refresh"
    />
    <EditScriptModal
      v-if="editingScript"
      :item="editingScript"
      :view-mode="viewingScript"
      @close="closeScriptModal"
      @saved="refresh"
    />
    <EditPolicyModal
      v-if="editingPolicy"
      :item="editingPolicy"
      @close="editingPolicy = null"
      @saved="refresh"
    />
  </AdminLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import UploadScriptModal from '../../components/admin/UploadScriptModal.vue';
import EditScriptModal from '../../components/admin/EditScriptModal.vue';
import EditPolicyModal from '../../components/admin/EditPolicyModal.vue';
import { packagesApi } from '../../api/packages.js';

const items = ref([]);
const error = ref('');
const loading = ref(false);

const showUpload = ref(false);
const editingScript = ref(null);
// R67-T1 — distinguishes view-mode (true) from edit-mode (false) for the
// shared EditScriptModal instance. Both flows set `editingScript`; this
// flag tells the modal which mode to render in.
const viewingScript = ref(false);
const editingPolicy = ref(null);

async function refresh() {
  loading.value = true;
  error.value = '';
  try {
    const r = await packagesApi.list();
    items.value = Array.isArray(r.data?.items) ? r.data.items : [];
  } catch (e) {
    // T7's router returns `{ error: "..." }` directly on validation
    // failures and `{ error: "internal" }` on 500 — both shapes are a
    // single string, not the legacy `{ error: { message } }` wrapper.
    error.value = e?.response?.data?.error || '加载失败';
  } finally {
    loading.value = false;
  }
}

function openUpload() { showUpload.value = true; }
function openEditScript(it) { editingScript.value = it; viewingScript.value = false; }
// R67-T1 — view-only entry point. Same modal, but viewMode=true triggers
// the GET /api/admin/packages/:name/script auto-fetch + readonly render.
function openViewScript(it) { editingScript.value = it; viewingScript.value = true; }
function closeScriptModal() { editingScript.value = null; viewingScript.value = false; }
function openEditPolicy(it) { editingPolicy.value = it; }

async function toggleEnabled(it) {
  error.value = '';
  try {
    if (it.enabled) await packagesApi.disable(it.name);
    else await packagesApi.enable(it.name);
    await refresh();
  } catch (e) {
    error.value = e?.response?.data?.error || '操作失败';
  }
}

async function confirmDelete(it) {
  if (!window.confirm(`确认删除脚本 ${it.name}?该操作不可恢复。`)) return;
  error.value = '';
  try {
    await packagesApi.deleteScript(it.name);
    await refresh();
  } catch (e) {
    error.value = e?.response?.data?.error || '删除失败';
  }
}

function fmt(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(s);
  return d.toLocaleString('zh-CN', { hour12: false });
}

onMounted(refresh);
</script>

<style scoped>
/* ===== Page header ===================================================== */
.page-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 24px; margin-bottom: 18px; padding-bottom: 14px;
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
.subtitle { margin: 0; font-size: 13px; color: var(--muted); }
.page-meta { display: flex; gap: 8px; align-items: center; }
.btn-primary, .btn-secondary {
  padding: 6px 14px; border-radius: 3px; cursor: pointer;
  font-size: 13px; border: 1px solid #1e293b;
}
.btn-primary {
  background: var(--accent); color: #0b1220; border-color: var(--accent); font-weight: 600;
}
.btn-secondary { background: #0b1220; color: var(--text); }
.btn-primary:disabled, .btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }

/* ===== Error / empty states ============================================ */
.error-banner {
  background: var(--red-bg); color: var(--red);
  padding: 10px 14px; border-radius: 4px; margin-bottom: 16px;
  border: 1px solid rgba(239, 68, 68, 0.3); font-size: 13px;
}
.empty {
  text-align: center; color: var(--muted);
  padding: 48px 16px; font-size: 13px;
  background: var(--panel); border: 1px dashed var(--border); border-radius: 4px;
}

/* ===== Table =========================================================== */
.t { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
.t th, .t td {
  padding: 9px 12px; text-align: left; font-size: 13px;
  color: var(--text); vertical-align: middle;
  border-top: 1px solid rgba(51, 65, 85, 0.4);
}
.t tbody tr:first-child td { border-top: 0; }
.t th {
  background: var(--panel-alt); color: var(--muted);
  font-size: 10px; font-weight: 600; letter-spacing: 0.10em;
  text-transform: uppercase; padding: 8px 12px; border-top: 0;
  font-family: ui-monospace, monospace;
}
.t th.num, .t td.num { text-align: right; font-feature-settings: "tnum"; }
.t th.actions-col, .t td.row-actions { width: 220px; }

/* Row hover: 2px left rail tint (R49 vocabulary). The default tint is
   accent so enabled rows still feel "active" on hover, with no other
   state-driven color to avoid clashing with status pills. */
.script-row td:first-child {
  border-left: 2px solid transparent;
  padding-left: 10px;
}
.script-row:hover td:first-child { border-left-color: var(--accent); }

/* Name + built-in badge in the first column */
.name-cell { display: flex; align-items: center; gap: 8px; }
.name { font-weight: 500; }
.source-tag.builtin {
  font-size: 9px; padding: 1px 5px; border-radius: 2px;
  background: rgba(56, 189, 248, 0.15); color: var(--accent);
  letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600;
  border: 1px solid rgba(56, 189, 248, 0.3);
}

/* Metric type tag */
.type-tag {
  font-size: 10px; padding: 2px 7px; border-radius: 2px;
  font-family: ui-monospace, monospace; font-weight: 600;
  letter-spacing: 0.04em; text-transform: uppercase;
}
.type-gauge     { background: rgba(34, 197, 94, 0.10); color: var(--green); border: 1px solid rgba(34, 197, 94, 0.3); }
.type-counter   { background: rgba(234, 179, 8, 0.10); color: var(--yellow); border: 1px solid rgba(234, 179, 8, 0.3); }
.type-status    { background: rgba(168, 85, 247, 0.10); color: #a855f7; border: 1px solid rgba(168, 85, 247, 0.3); }
.type-timeseries{ background: rgba(56, 189, 248, 0.10); color: var(--accent); border: 1px solid rgba(56, 189, 248, 0.3); }

/* Status pill — R49 3-color (green on, gray off) */
.status-pill {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 10px; padding: 2px 8px; border-radius: 2px;
  font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
  font-family: ui-monospace, monospace;
}
.status-pill .dot { width: 5px; height: 5px; border-radius: 50%; }
.status-pill.ok   { background: rgba(34, 197, 94, 0.10); color: var(--green); border: 1px solid rgba(34, 197, 94, 0.3); }
.status-pill.ok .dot   { background: var(--green); }
.status-pill.off  { background: var(--panel-alt); color: var(--muted); border: 1px solid var(--border); }
.status-pill.off .dot  { background: var(--muted); }

/* Code-style cells */
.version, .source {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px; background: var(--panel-alt);
  padding: 1px 6px; border-radius: 2px; border: 1px solid var(--border);
  color: var(--text);
}
.source { color: var(--muted); }

/* Row action buttons */
.row-actions { display: flex; gap: 4px; flex-wrap: wrap; }
.row-actions button {
  padding: 3px 9px; font-size: 12px;
  background: var(--panel-alt); color: var(--text);
  border: 1px solid var(--border); border-radius: 3px;
  cursor: pointer; font-family: inherit;
}
.row-actions button:hover { background: var(--bg); border-color: var(--accent); color: var(--accent); }
.row-actions button.danger:hover { background: rgba(239, 68, 68, 0.10); border-color: var(--red); color: var(--red); }
</style>
