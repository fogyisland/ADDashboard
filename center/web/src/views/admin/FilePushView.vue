<!--
  2026-08-30 R65 followup — shared upload / push / monitor surface for
  AD-DC + member-server targets.

  Both AdFilePushView and MemberFilePushView are thin wrappers that
  pass targetType to this component (targetType='dc' | 'server'). The
  component renders:

    - an upload form (file picker → SHA-256 in the browser via
      window.crypto.subtle.digest → multi-select targets → target
      path)
    - a task list (newest first) with per-row expand showing per-
      target ack status
    - a manual-ack flow that lets the operator pre-mark a delivery
      when an agent is offline (this is the only path that produces
      push_file_delivered audit rows from the admin side; the normal
      agent-side path POSTs the same shape to /api/admin/file-push/:id/ack).

  Mock-first per operator directive: no DB schema, file bytes live on
  disk (data/file-push/), index.json holds per-task state. The view
  talks directly to adminApi.* — no Pinia store.

  data-test contract (matched by tests/file-push-view.test.js):
    file-input              — the <input type="file">
    target-listbox          — the multi-select for target hostnames
    target-path             — the text input for the absolute dir
    upload-btn              — the upload submit button
    sha-badge               — shows the computed SHA-256 next to the
                              file picker (so the operator can copy
                              it for clipboard-round-trip checks)
    task-row-${id}          — each task row
    expand-${id}            — per-row caret that expands per-target
                              ack detail
    ack-ok-${taskId}        — input + button that posts ok=true
    ack-fail-${taskId}      — input + button that posts ok=false
-->
<template>
  <AdminLayout>
    <header class="page-header">
      <div class="page-titles">
        <div class="eyebrow">OPERATIONS · {{ targetType === 'dc' ? '活动目录文件分发' : '成员服务器文件分发' }}</div>
        <h2 class="page-title">{{ targetType === 'dc' ? '文件推送 (AD 域控)' : '文件推送 (成员服务器)' }}</h2>
        <p class="subtitle">
          上传文件 → 推送到 {{ targetType === 'dc' ? '已注册的 AD 域控' : '已注册的成员服务器' }} 的目标目录。
          Agent 在心跳回调时拉取, 自动回报成功 / 失败。
        </p>
      </div>
      <div class="page-meta">
        <button class="btn-secondary" data-test="refresh-btn" @click="refresh" :disabled="loading">
          {{ loading ? '加载中…' : '↻ 刷新' }}
        </button>
      </div>
    </header>

    <div v-if="error" class="error-banner">{{ error }}</div>

    <!-- Upload form ─────────────────────────────────────────── -->
    <section class="upload-card">
      <h3>推送新文件</h3>
      <div class="form-row">
        <label class="file-input-label">
          <input
            type="file"
            data-test="file-input"
            @change="onFileChange"
            :disabled="uploading"
          />
          <span v-if="!pendingFile" class="file-input-hint">选择要推送的文件 (≤8 MB)</span>
          <span v-else class="file-input-hint">
            {{ pendingFile.name }} · {{ fmtBytes(pendingFile.size) }}
          </span>
        </label>
        <code v-if="pendingSha" data-test="sha-badge" class="sha-badge" :title="pendingSha">
          SHA-256: {{ pendingSha.slice(0, 12) }}…
        </code>
      </div>

      <div class="form-row">
        <label class="form-label">
          <span>目标{{ targetType === 'dc' ? '域控' : '成员服务器' }} (多选)</span>
          <select
            multiple
            size="6"
            data-test="target-listbox"
            v-model="selectedTargets"
            :disabled="uploading || !targets.length"
          >
            <option
              v-for="t in targets"
              :key="t.hostname"
              :value="t.hostname"
            >
              {{ t.hostname }}<span v-if="t.label"> — {{ t.label }}</span>
            </option>
          </select>
          <small v-if="!targets.length" class="hint">
            暂无{{ targetType === 'dc' ? '已注册的 AD 域控' : '已注册的成员服务器' }} — 请先在
            <router-link v-if="targetType === 'dc'" to="/admin/dcs-catalog">域控清单</router-link>
            <router-link v-else to="/admin/member-servers">成员服务器</router-link>
            添加
          </small>
        </label>
        <label class="form-label">
          <span>目标路径 (绝对路径)</span>
          <input
            type="text"
            data-test="target-path"
            v-model="targetPath"
            placeholder="C:\ProgramData\ADDashboard\distribute"
            :disabled="uploading"
          />
          <small class="hint">Agent 端把文件落地到该目录; 留空会失败</small>
        </label>
      </div>

      <div class="form-actions">
        <button
          class="btn-primary"
          data-test="upload-btn"
          @click="submit"
          :disabled="!canSubmit || uploading"
        >
          {{ uploading ? '上传中…' : '+ 上传并推送' }}
        </button>
        <button class="btn-secondary" @click="resetForm" :disabled="uploading">清空</button>
      </div>
    </section>

    <!-- Task list ──────────────────────────────────────────── -->
    <section class="task-list">
      <h3>推送任务列表 <span class="count">({{ tasks.length }})</span></h3>
      <div v-if="!tasks.length" class="empty-block">暂无推送任务</div>
      <table v-else class="t">
        <thead>
          <tr>
            <th class="caret-col"></th>
            <th>文件名</th>
            <th class="num">大小</th>
            <th>SHA-256</th>
            <th>目标路径</th>
            <th>状态</th>
            <th>上传时间</th>
            <th class="actions-col">操作</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="t in tasks" :key="t.taskId">
            <tr :data-test="`task-row-${t.taskId}`" class="task-row">
              <td class="caret-col">
                <button
                  class="caret-btn"
                  :data-test="`expand-${t.taskId}`"
                  @click="toggle(t.taskId)"
                >{{ expanded[t.taskId] ? '▼' : '▶' }}</button>
              </td>
              <td><code class="filename">{{ t.filename }}</code></td>
              <td class="num">{{ fmtBytes(t.sizeBytes) }}</td>
              <td><code class="sha" :title="t.sha256">{{ t.sha256.slice(0, 12) }}…</code></td>
              <td><code class="path">{{ t.targetPath }}</code></td>
              <td>
                <span :class="['status-pill', statusClass(t)]">
                  <span class="dot"></span>{{ statusLabel(t) }}
                </span>
                <small class="hint">({{ t.targetStatus.filter(x => x.status === 'delivered').length }}/{{ t.targetStatus.length }})</small>
              </td>
              <td>{{ fmt(t.uploadedAt) }}</td>
              <td class="row-actions">
                <button @click="downloadFile(t)" :data-test="`download-${t.taskId}`">下载</button>
                <button @click="forceAck(t, true)" :data-test="`ack-ok-${t.taskId}`" :disabled="acking === t.taskId">标记已送达</button>
                <button class="danger" @click="forceAck(t, false)" :data-test="`ack-fail-${t.taskId}`" :disabled="acking === t.taskId">标记失败</button>
              </td>
            </tr>
            <tr v-if="expanded[t.taskId]" :data-test="`detail-${t.taskId}`" class="detail-row">
              <td colspan="8">
                <div class="detail-grid">
                  <div class="detail-meta">
                    <div><b>taskId</b><code>{{ t.taskId }}</code></div>
                    <div><b>targetType</b><code>{{ t.targetType }}</code></div>
                    <div><b>sizeBytes</b><code>{{ t.sizeBytes }}</code></div>
                    <div><b>sha256</b><code class="sha">{{ t.sha256 }}</code></div>
                    <div><b>uploadedBy</b><code>{{ t.uploadedBy || '—' }}</code></div>
                  </div>
                  <h4>目标详情</h4>
                  <table class="targets-table">
                    <thead>
                      <tr>
                        <th>目标主机</th>
                        <th>状态</th>
                        <th>认领时间</th>
                        <th>送达时间</th>
                        <th>错误信息</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="ts in t.targetStatus" :key="ts.name" :class="['target-row', `target-${ts.status}`]">
                        <td><code>{{ ts.name }}</code></td>
                        <td>
                          <span :class="['status-pill', targetClass(ts)]">
                            <span class="dot"></span>{{ targetLabel(ts) }}
                          </span>
                        </td>
                        <td>{{ fmt(ts.claimedAt) }}</td>
                        <td>{{ fmt(ts.deliveredAt) }}</td>
                        <td>
                          <code v-if="ts.errorMessage" class="err-msg">{{ ts.errorMessage }}</code>
                          <span v-else>—</span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </section>
  </AdminLayout>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { adminApi } from '../../api/admin.js';

const props = defineProps({
  targetType: { type: String, required: true }  // 'dc' | 'server'
});

const targets = ref([]);
const tasks = ref([]);
const expanded = reactive({});
const loading = ref(false);
const uploading = ref(false);
const acking = ref(null);
const error = ref('');

const pendingFile = ref(null);
const pendingSha = ref('');
const selectedTargets = ref([]);
const targetPath = ref('C:\\ProgramData\\ADDashboard\\distribute');

const canSubmit = computed(() =>
  pendingFile.value && pendingSha.value && selectedTargets.value.length && targetPath.value.trim()
);

async function refresh() {
  loading.value = true;
  error.value = '';
  try {
    const [t, list] = await Promise.all([
      fetchTargets(),
      adminApi.listFilePushTasks()
    ]);
    targets.value = t;
    tasks.value = Array.isArray(list.data) ? list.data : [];
    for (const t of tasks.value) if (!(t.taskId in expanded)) expanded[t.taskId] = false;
  } catch (e) {
    error.value = e?.response?.data?.error || e.message || '加载失败';
  } finally {
    loading.value = false;
  }
}

async function fetchTargets() {
  if (props.targetType === 'dc') {
    const { data } = await adminApi.listDcsCatalog();
    return (Array.isArray(data) ? data : []).map(d => ({ hostname: d.dcName, label: d.isBridgehead ? '桥头' : (d.isPdc ? 'PDC' : '成员') }));
  }
  const { data } = await adminApi.listMemberServers();
  return (Array.isArray(data) ? data : []).map(m => ({ hostname: m.hostname, label: m.role || '成员服务器' }));
}

async function onFileChange(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;
  pendingFile.value = file;
  pendingSha.value = '';
  try {
    const buf = await file.arrayBuffer();
    const hashBuf = await window.crypto.subtle.digest('SHA-256', buf);
    pendingSha.value = Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  } catch (e) {
    error.value = '浏览器 SHA-256 计算失败 — 请尝试 Chrome / Edge';
    pendingFile.value = null;
  }
}

function resetForm() {
  pendingFile.value = null;
  pendingSha.value = '';
  selectedTargets.value = [];
  targetPath.value = 'C:\\ProgramData\\ADDashboard\\distribute';
}

async function submit() {
  if (!canSubmit.value) return;
  uploading.value = true;
  error.value = '';
  try {
    const buf = await pendingFile.value.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const contentB64 = btoa(bin);
    await adminApi.uploadFile({
      filename: pendingFile.value.name,
      contentB64,
      sha256: pendingSha.value,
      targetType: props.targetType,
      targets: selectedTargets.value,
      targetPath: targetPath.value.trim()
    });
    resetForm();
    await refresh();
  } catch (e) {
    error.value = e?.response?.data?.error || e.message || '上传失败';
  } finally {
    uploading.value = false;
  }
}

async function forceAck(t, ok) {
  const target = t.targetStatus.find(x => x.status !== 'delivered' && x.status !== 'failed') || t.targetStatus[0];
  if (!target) return;
  const hostname = target.name;
  const agentId = prompt(
    ok
      ? `标记 ${hostname} 已送达 — 输入 agentId:`
      : `标记 ${hostname} 失败 — 输入 agentId (失败原因将记录):`
  );
  if (!agentId) return;
  let errorMessage = null;
  if (!ok) {
    errorMessage = prompt('失败原因 (可选):') || 'operator-marked failed';
  }
  acking.value = t.taskId;
  error.value = '';
  try {
    await adminApi.ackFilePushTask(t.taskId, { hostname, agentId, ok, errorMessage });
    await refresh();
  } catch (e) {
    error.value = e?.response?.data?.error || e.message || '标记失败';
  } finally {
    acking.value = null;
  }
}

async function downloadFile(t) {
  try {
    const { blob, sha256 } = await adminApi.getFilePushFileBlob(t.taskId);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = t.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    if (sha256 && sha256 !== t.sha256) {
      error.value = `下载 SHA-256 与登记值不一致 — ${sha256}`;
    }
  } catch (e) {
    error.value = e?.response?.data?.error || e.message || '下载失败';
  }
}

function toggle(taskId) { expanded[taskId] = !expanded[taskId]; }

function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '—'; }

function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function statusClass(t) {
  const delivered = t.targetStatus.filter(x => x.status === 'delivered').length;
  if (delivered === t.targetStatus.length) return 'ok';
  if (t.targetStatus.some(x => x.status === 'failed')) return 'err';
  if (t.targetStatus.some(x => x.status === 'claimed')) return 'warn';
  return 'queued';
}

function statusLabel(t) {
  const delivered = t.targetStatus.filter(x => x.status === 'delivered').length;
  const failed = t.targetStatus.filter(x => x.status === 'failed').length;
  if (delivered === t.targetStatus.length) return '全部送达';
  if (failed === t.targetStatus.length) return '全部失败';
  if (delivered + failed === t.targetStatus.length) return '部分失败';
  if (t.status === 'claimed') return '推送中';
  return '队列中';
}

function targetClass(ts) {
  if (ts.status === 'delivered') return 'ok';
  if (ts.status === 'failed') return 'err';
  if (ts.status === 'claimed') return 'warn';
  return 'queued';
}

function targetLabel(ts) {
  if (ts.status === 'delivered') return '已送达';
  if (ts.status === 'failed') return '失败';
  if (ts.status === 'claimed') return '已认领';
  return '待认领';
}

onMounted(refresh);
</script>

<style scoped>
.page-header { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 16px; }
.page-titles { display: flex; flex-direction: column; gap: 4px; }
.eyebrow { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.page-title { margin: 0; font-size: 22px; font-weight: 600; }
.subtitle { margin: 0; color: var(--muted); }
.page-meta { display: flex; gap: 8px; }
.btn-primary, .btn-secondary {
  padding: 6px 14px; border-radius: 3px; cursor: pointer; font-size: 13px;
  border: 1px solid var(--border); background: var(--input-bg); color: var(--text);
}
.btn-primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
.btn-primary:disabled, .btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }
.error-banner { background: var(--err-bg); color: var(--err); padding: 8px 12px; border-radius: 4px; margin-bottom: 12px; border: 1px solid var(--err-border); }
.upload-card { background: var(--panel); padding: 16px; border-radius: 4px; border: 1px solid var(--border); margin-bottom: 16px; }
.upload-card h3 { margin: 0 0 12px; }
.form-row { display: flex; gap: 12px; margin-bottom: 12px; align-items: flex-start; flex-wrap: wrap; }
.form-label { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 220px; }
.form-label > span { font-size: 12px; color: var(--muted); }
.form-label input, .form-label select { padding: 6px 10px; border: 1px solid var(--border); border-radius: 3px; background: var(--input-bg); color: var(--text); font-size: 13px; }
.form-label .hint { color: var(--muted); font-size: 11px; }
.file-input-label { display: flex; align-items: center; gap: 12px; padding: 8px; border: 1px dashed var(--border); border-radius: 3px; flex: 1; min-width: 220px; cursor: pointer; }
.file-input-label input { display: none; }
.file-input-hint { color: var(--muted); font-size: 13px; }
.sha-badge { font-size: 11px; padding: 4px 8px; background: var(--input-bg); border: 1px solid var(--border); border-radius: 3px; color: var(--muted); }
.form-actions { display: flex; gap: 8px; }
.task-list h3 { margin: 0 0 12px; }
.task-list .count { color: var(--muted); font-weight: 400; font-size: 13px; }
.empty-block { background: var(--panel); padding: 16px; border-radius: 4px; border: 1px solid var(--border); color: var(--muted); }
.t { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
.t th, .t td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13px; }
.t th { background: var(--th); color: var(--muted); font-weight: 600; font-size: 12px; }
.t .num { text-align: right; font-variant-numeric: tabular-nums; }
.caret-col { width: 28px; padding: 4px; }
.actions-col { width: 220px; }
.caret-btn { padding: 2px 6px; background: transparent; border: 1px solid var(--border); border-radius: 3px; cursor: pointer; color: var(--text); }
.task-row:hover { background: var(--row-hover); }
.task-row .filename { color: var(--text); font-weight: 500; }
.task-row .sha, .task-row code { font-size: 11px; color: var(--muted); }
.row-actions { display: flex; gap: 4px; flex-wrap: wrap; }
.row-actions button { padding: 3px 8px; font-size: 12px; background: var(--input-bg); border: 1px solid var(--border); border-radius: 3px; cursor: pointer; color: var(--text); }
.row-actions button.danger { color: var(--err); }
.row-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
.status-pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
.status-pill .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.status-pill.ok { background: rgba(34, 197, 94, 0.15); color: #16a34a; }
.status-pill.warn { background: rgba(234, 179, 8, 0.15); color: #ca8a04; }
.status-pill.err { background: rgba(239, 68, 68, 0.15); color: #dc2626; }
.status-pill.queued { background: rgba(107, 114, 128, 0.15); color: #6b7280; }
.detail-row { background: var(--detail-bg); }
.detail-grid { padding: 12px 8px; }
.detail-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; margin-bottom: 12px; }
.detail-meta > div { font-size: 12px; display: flex; flex-direction: column; gap: 2px; }
.detail-meta b { color: var(--muted); font-weight: 600; }
.detail-meta code { font-size: 11px; word-break: break-all; }
.targets-table { width: 100%; border-collapse: collapse; }
.targets-table th, .targets-table td { padding: 6px 8px; font-size: 12px; border-bottom: 1px solid var(--border); }
.target-row.target-ok { background: rgba(34, 197, 94, 0.06); }
.target-row.target-err { background: rgba(239, 68, 68, 0.06); }
.target-row.target-warn { background: rgba(234, 179, 8, 0.06); }
.err-msg { color: var(--err); font-size: 11px; }
</style>