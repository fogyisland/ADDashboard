<template>
  <AppLayout>
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
            <td><span class="tag" :class="`tag-${row.type}`">{{ row.type }}</span></td>
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
  </AppLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import AppLayout from '../../components/AppLayout.vue';
import { usePackagesStore } from '../../stores/packages.js';

const store = usePackagesStore();
const packages = ref([]);
const registryUrl = ref(null);
const updatedAt = ref(null);
const error = ref(null);
const installing = ref(false);

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
  try { return new Date(s).toLocaleString('zh-CN', { hour12: false }); }
  catch { return s; }
}
</script>

<style scoped>
.registry-view { display: flex; flex-direction: column; gap: 12px; }
.toolbar { display: flex; justify-content: space-between; align-items: center; }
.toolbar h2 { margin: 0; }
.meta { color: var(--muted); font-size: 13px; margin: 0; }
.meta code { background: #0b1220; padding: 2px 6px; border-radius: 3px; }
.updated { margin-left: 8px; }
.error { color: var(--red); margin: 0; }

.t { width: 100%; border-collapse: collapse; background: var(--panel); }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
.empty { text-align: center; color: var(--muted); padding: 24px; }

.tag {
  display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px;
  background: #1e293b; color: var(--muted);
}
.tag-gauge { background: #0e3a2f; color: #67c23a; }
.tag-counter { background: #3a2f0e; color: #e6a23c; }
.tag-timeseries { background: #0e2a3a; color: #409eff; }
.tag-status { background: #2f1e3a; color: #909399; }

button.small { padding: 3px 10px; font-size: 12px; }
</style>
