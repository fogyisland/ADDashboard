<template>
  <AppLayout>
    <div class="page-head">
      <h2>错误链路</h2>
      <div class="page-actions">
        <!-- R158.X.116.p (2026-10-23) — 前台定位为「值班视角」: 默认只看
             最近 24h, 即今天有没有坏链路。要翻更久远的历史去后台
             /admin/replication-errors 那边看 (那边能看全部)。 -->
        <select v-model="windowKey" @change="reload" class="window-select" data-test="window-select">
          <option value="24h">最近 24 小时</option>
          <option value="7d">最近 7 天</option>
        </select>
        <button @click="reload" class="btn" :disabled="loading">{{ loading ? '加载中…' : '↻ 刷新' }}</button>
      </div>
    </div>
    <p v-if="!loading && !rows.length" class="empty" data-test="empty-state">
      {{ windowLabel }}内无复制错误 — 所有域控链路健康
    </p>
    <ErrorTable v-else :rows="rows" />
  </AppLayout>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { dashboardApi } from '../api/dashboard.js';
import AppLayout from '../components/AppLayout.vue';
import ErrorTable from '../components/ErrorTable.vue';

const rows = ref([]);
const loading = ref(false);
const windowKey = ref('24h');

const windowLabel = computed(() =>
  windowKey.value === '7d' ? '最近 7 天' : '最近 24 小时');

async function reload() {
  loading.value = true;
  try {
    const r = await dashboardApi.errorsRecent({ window: windowKey.value });
    rows.value = Array.isArray(r.data) ? r.data : [];
  } catch {
    rows.value = [];
  } finally {
    loading.value = false;
  }
}
onMounted(reload);
</script>

<style scoped>
.page-head {
  display: flex; align-items: center; justify-content: space-between;
  gap: 16px; margin-bottom: 16px;
}
h2 { margin: 0; font-size: 18px; font-weight: 600; }
.page-actions { display: flex; gap: 8px; align-items: center; }
.window-select, .btn {
  padding: 6px 14px; font-size: 13px; font-family: inherit; cursor: pointer;
  border: 1px solid var(--border); border-radius: 3px;
  background: var(--input-bg); color: var(--text);
}
.window-select:hover, .btn:hover { border-color: var(--accent); color: var(--accent); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.empty { color: var(--muted); font-size: 13px; padding: 24px 0; }
</style>