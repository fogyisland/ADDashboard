<template>
  <AdminLayout>
    <div class="packages-view">
      <header class="toolbar">
        <h2>包管理</h2>
        <div class="actions">
          <label class="upload-btn">
            + 上传本地包
            <input type="file" accept=".zip,.json" @change="handleUpload" />
          </label>
          <router-link to="/admin/packages/registry" class="link-btn">
            从 Registry 导入
          </router-link>
          <button @click="refreshRegistry">刷新 Registry</button>
        </div>
      </header>

      <p v-if="store.error" class="error">{{ store.error }}</p>

      <table class="t">
        <thead>
          <tr>
            <th>名称</th>
            <th>版本</th>
            <th>类型</th>
            <th>启用</th>
            <th>执行间隔</th>
            <th>来源</th>
            <th>安装时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in store.installed" :key="row.name">
            <td>
              <router-link :to="`/admin/packages/${row.name}`">{{ row.name }}</router-link>
            </td>
            <td>{{ row.version }}</td>
            <td><span class="tag" :class="`tag-${row.type}`">{{ row.type }}</span></td>
            <td>
              <span class="tag" :class="row.enabled ? 'tag-on' : 'tag-off'">
                {{ row.enabled ? '是' : '否' }}
              </span>
            </td>
            <td class="interval-cell">
              <div class="interval-display">
                <span class="interval-current">{{ formatInterval(row.intervalOverrideSec) }}</span>
                <span class="interval-default">默认 {{ formatInterval(row.manifest?.agent?.intervalSec) }}</span>
              </div>
              <div class="interval-editor">
                <input
                  type="number"
                  min="5"
                  max="86400"
                  step="1"
                  :placeholder="String(row.manifest?.agent?.intervalSec ?? '')"
                  v-model.number="drafts[row.name]"
                  :disabled="saving[row.name]"
                  @keyup.enter="saveInterval(row)"
                  data-testid="interval-input"
                />
                <span class="interval-unit">秒</span>
                <button
                  class="small"
                  :disabled="saving[row.name] || !isDirty(row)"
                  @click="saveInterval(row)"
                  data-testid="interval-save"
                >保存</button>
                <button
                  class="small"
                  :disabled="saving[row.name] || row.intervalOverrideSec == null"
                  @click="clearInterval(row)"
                  data-testid="interval-clear"
                >清除覆盖</button>
              </div>
              <p v-if="intervalErrors[row.name]" class="interval-error">{{ intervalErrors[row.name] }}</p>
            </td>
            <td>{{ row.source }}</td>
            <td>{{ formatDate(row.installed_at) }}</td>
            <td class="row-actions">
              <router-link :to="`/admin/packages/${row.name}`" class="link-btn small">查看</router-link>
              <button class="small" @click="upgrade(row)">升级</button>
              <button class="small" @click="toggle(row)">
                {{ row.enabled ? '停用' : '启用' }}
              </button>
              <button class="small danger" @click="uninstall(row)">卸载</button>
            </td>
          </tr>
          <tr v-if="!store.installed.length">
            <td colspan="8" class="empty">尚未安装任何包 — 点击"上传本地包"或"从 Registry 导入"</td>
          </tr>
        </tbody>
      </table>
    </div>
  </AdminLayout>
</template>

<script setup>
import { onMounted, reactive } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { usePackagesStore } from '../../stores/packages.js';

const store = usePackagesStore();

// 2026-08-26 T4: per-row draft state for the interval override editor.
// We keep a draft string per package so the operator can type freely
// without forcing immediate save; Save is enabled when the draft differs
// from the persisted override (or when there's no override and the draft
// is non-empty). `saving` flags disable the input + buttons during the
// PATCH round-trip; `intervalErrors` holds transient validation messages
// shown below the editor (range check is also enforced server-side).
const drafts = reactive({});
const saving = reactive({});
const intervalErrors = reactive({});

function isDirty(row) {
  const draft = drafts[row.name];
  if (draft == null || draft === '') return false;
  const numeric = Number(draft);
  if (!Number.isFinite(numeric)) return false;
  return numeric !== (row.intervalOverrideSec ?? null);
}

function formatInterval(value) {
  if (value == null) return '—';
  return `${value} 秒`;
}

onMounted(() => store.fetchInstalled());

async function handleUpload(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;
  const buffer = await fileToBase64(file);
  try {
    await store.install({ source: 'local', packageRef: file.name, buffer });
  } catch (e) {
    store.error = e.response?.data?.error?.message || e.message;
  } finally {
    // Reset the input so the same file can be re-uploaded.
    ev.target.value = '';
  }
}

async function toggle(row) {
  try {
    if (row.enabled) await store.disable(row.name);
    else await store.enable(row.name);
  } catch (e) {
    store.error = e.response?.data?.error?.message || e.message;
  }
}

async function uninstall(row) {
  if (!confirm(`确认卸载 ${row.name}？`)) return;
  try {
    await store.uninstall(row.name, false);
  } catch (e) {
    store.error = e.response?.data?.error?.message || e.message;
  }
}

async function upgrade(row) {
  try {
    await store.upgrade(row.name);
  } catch (e) {
    store.error = e.response?.data?.error?.message || e.message;
  }
}

async function refreshRegistry() {
  try {
    await store.refreshRegistry();
  } catch (e) {
    store.error = e.response?.data?.error?.message || e.message;
  }
}

async function saveInterval(row) {
  intervalErrors[row.name] = null;
  const draft = drafts[row.name];
  if (draft == null || draft === '') return;
  const n = Number(draft);
  if (!Number.isInteger(n) || n < 5 || n > 86400) {
    intervalErrors[row.name] = 'intervalSec 必须是 5..86400 的整数';
    return;
  }
  saving[row.name] = true;
  try {
    await store.setIntervalOverride(row.name, n);
    drafts[row.name] = n;
  } catch (e) {
    intervalErrors[row.name] = e.response?.data?.error?.message || e.message;
  } finally {
    saving[row.name] = false;
  }
}

async function clearInterval(row) {
  intervalErrors[row.name] = null;
  saving[row.name] = true;
  try {
    await store.setIntervalOverride(row.name, null);
    drafts[row.name] = '';
  } catch (e) {
    intervalErrors[row.name] = e.response?.data?.error?.message || e.message;
  } finally {
    saving[row.name] = false;
  }
}

function formatDate(s) {
  if (!s) return '-';
  try { return new Date(s).toLocaleString('zh-CN', { hour12: false }); }
  catch { return s; }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // reader.result is "data:<mime>;base64,<data>"
      const idx = String(reader.result).indexOf(',');
      resolve(idx >= 0 ? String(reader.result).slice(idx + 1) : '');
    };
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}
</script>

<style scoped>
.packages-view { display: flex; flex-direction: column; gap: 12px; }
.toolbar { display: flex; justify-content: space-between; align-items: center; }
.toolbar h2 { margin: 0; }
.actions { display: flex; gap: 8px; align-items: center; }
.upload-btn {
  display: inline-block; padding: 6px 12px; background: var(--accent); color: white;
  border-radius: 4px; cursor: pointer; font-size: 14px;
}
.upload-btn input[type=file] { display: none; }
.link-btn {
  display: inline-block; padding: 6px 12px; background: #1e293b; color: var(--text);
  border-radius: 4px; text-decoration: none; font-size: 14px; border: 1px solid #334155;
}
.link-btn.small { padding: 3px 8px; font-size: 12px; }
.error { color: var(--red); margin: 0; }

.t { width: 100%; border-collapse: collapse; background: var(--panel); }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; vertical-align: top; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
.empty { text-align: center; color: var(--muted); padding: 24px; }

.interval-cell { min-width: 220px; }
.interval-display { display: flex; gap: 8px; align-items: baseline; margin-bottom: 4px; }
.interval-current { font-weight: 600; }
.interval-default { color: var(--muted); font-size: 12px; }
.interval-editor { display: flex; gap: 4px; align-items: center; }
.interval-editor input[type=number] {
  width: 90px; padding: 3px 6px; background: #0b1220; color: var(--text);
  border: 1px solid #334155; border-radius: 4px; font-size: 12px;
}
.interval-editor input[type=number]:disabled { opacity: 0.5; }
.interval-unit { color: var(--muted); font-size: 12px; }
.interval-error { color: var(--red); font-size: 12px; margin: 4px 0 0; }

.tag {
  display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px;
  background: #1e293b; color: var(--muted);
}
.tag-gauge { background: #0e3a2f; color: #67c23a; }
.tag-counter { background: #3a2f0e; color: #e6a23c; }
.tag-timeseries { background: #0e2a3a; color: #409eff; }
.tag-status { background: #2f1e3a; color: #909399; }
.tag-on { background: #0e3a2f; color: #67c23a; }
.tag-off { background: #1e293b; color: var(--muted); }

.row-actions { display: flex; gap: 4px; flex-wrap: wrap; }
button.small { padding: 3px 8px; font-size: 12px; }
button.danger { background: var(--red); color: white; }
</style>