<template>
  <AdminLayout>
    <div class="registry-view">
      <header class="toolbar">
        <h2>Registry 浏览</h2>
        <div class="actions">
          <button @click="refresh">刷新</button>
        </div>
      </header>

      <p class="meta">
        Registry URL: <code>{{ registryUrl || '未配置' }}</code>
        <span v-if="updatedAt" class="updated">· 最近更新 {{ formatDate(updatedAt) }}</span>
      </p>

      <p v-if="error" class="error">{{ error }}</p>

      <table class="t">
        <thead>
          <tr>
            <th>名称</th>
            <th>最新版本</th>
            <th>类型</th>
            <th>描述</th>
            <th>作者</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in packages" :key="row.name">
            <td>{{ row.name }}</td>
            <td>{{ row.latestVersion }}</td>
            <td><span class="tag" :class="`tag-${row.type}`">{{ typeLabel(row.type) }}</span></td>
            <td>{{ row.description || '-' }}</td>
            <td>{{ row.author || '-' }}</td>
            <td>
              <button class="small" @click="install(row)" :disabled="installing">
                {{ installing ? '安装中...' : '安装' }}
              </button>
            </td>
          </tr>
          <tr v-if="!packages.length">
            <td colspan="6" class="empty">
              {{ registryUrl ? 'Registry 是空的 — 暂无可安装的包' : 'Registry 未配置 — 请先在系统配置中设置 package_registry_url' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </AdminLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { usePackagesStore } from '../../stores/packages.js';
import { formatDateTime } from '../../lib/timezone.js';

const store = usePackagesStore();
const packages = ref([]);
const registryUrl = ref(null);
const updatedAt = ref(null);
const error = ref(null);
const installing = ref(false);

// 包类型 — Registry 返回的英文枚举值翻译成中文.
// fallback 走原文 + 圆括号,新枚举值出现不空白。
const TYPE_LABEL = {
  gauge: '指标',
  counter: '计数器',
  status: '状态',
  timeseries: '时序'
};
function typeLabel(t) {
  if (t == null || t === '') return '—';
  return TYPE_LABEL[t] || `${t}`;
}

onMounted(() => load());

async function load() {
  error.value = null;
  try {
    const data = await store.fetchRegistryIndex();
    packages.value = Array.isArray(data?.packages) ? data.packages : [];
    registryUrl.value = data?.url || null;
    updatedAt.value = data?.updatedAt || null;
  } catch (e) {
    error.value = e.response?.data?.error?.message || e.message;
  }
}

// Refresh forces a fresh fetch from the registry (bypasses cache) and then
// reloads the local list view.
async function refresh() {
  error.value = null;
  try {
    await store.refreshRegistry();
    await load();
  } catch (e) {
    error.value = e.response?.data?.error?.message || e.message;
  }
}

async function install(row) {
  if (!registryUrl.value) {
    error.value = 'Registry URL 未配置';
    return;
  }
  installing.value = true;
  error.value = null;
  try {
    await store.install({
      source: `registry:${registryUrl.value}`,
      packageRef: row.name,
    });
  } catch (e) {
    error.value = e.response?.data?.error?.message || e.message;
  } finally {
    installing.value = false;
  }
}

function formatDate(s) {
  if (!s) return '-';
  try { return formatDateTime(s); }
  catch { return s; }
}
</script>

<style scoped>
.registry-view { display: flex; flex-direction: column; gap: 12px; }
.toolbar { display: flex; justify-content: space-between; align-items: center; }
.toolbar h2 { margin: 0; }
.meta { color: var(--muted); font-size: 13px; margin: 0; }
.meta code { background: var(--sidebar-bg); padding: 2px 6px; border-radius: 3px; }
.updated { margin-left: 8px; }
.error { color: var(--red); margin: 0; }

.t { width: 100%; border-collapse: collapse; background: var(--panel); }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); }
.t th { background: var(--sidebar-bg); color: var(--muted); font-size: 12px; }
.empty { text-align: center; color: var(--muted); padding: 24px; }

.tag {
  display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px;
  background: var(--border); color: var(--muted);
}
.tag-gauge { background: var(--success-bg); color: var(--green); }
.tag-counter { background: var(--warning-bg); color: var(--yellow); }
.tag-timeseries { background: var(--info-bg); color: var(--accent); }
.tag-status { background: color-mix(in srgb, var(--muted) 10%, transparent); color: var(--muted); }

button.small { padding: 3px 10px; font-size: 12px; }
</style>
