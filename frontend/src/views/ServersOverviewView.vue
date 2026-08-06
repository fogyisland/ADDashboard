<template>
  <AppLayout>
    <div class="overview-header">
      <h2>服务器总览</h2>
      <select v-model="siteId" class="site-filter" :disabled="loading">
        <option value="">全部站点</option>
        <option v-for="s in sites" :key="s.id" :value="s.id">{{ s.siteName }}</option>
      </select>
      <button class="retry" @click="load" :disabled="loading">刷新</button>
    </div>

    <div v-if="loading" class="skeleton-grid">
      <div v-for="i in 6" :key="i" class="skeleton-card"></div>
    </div>

    <div v-else-if="error" class="error-banner">
      <span>无法加载服务器总览，请重试</span>
      <button @click="load">重试</button>
    </div>

    <div v-else-if="cards.length === 0" class="empty-state">
      暂无 DC 数据 — 等待 Agent 首次上报
    </div>

    <div v-else class="card-grid">
      <DcCard v-for="card in cards" :key="card.dcHost" :dc="card" />
    </div>
  </AppLayout>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue';
import AppLayout from '../components/AppLayout.vue';
import DcCard from '../components/DcCard.vue';
import { getDcSummary } from '../api/dcs.js';
import { adminApi } from '../api/admin.js';

const siteId = ref('');
const sites = ref([]);
const cards = ref([]);
const loading = ref(false);
const error = ref(false);

async function load() {
  loading.value = true;
  error.value = false;
  try {
    const r = await getDcSummary(siteId.value === '' ? null : siteId.value);
    cards.value = r.data || [];
  } catch (e) {
    error.value = true;
    cards.value = [];
  } finally {
    loading.value = false;
  }
}

async function loadSites() {
  try {
    // Use the catalog endpoint (ad_sites table) — the older derived-from-status
    // endpoint was removed because "sites currently replicating" carries no
    // operational meaning (sites always participate in replication in AD).
    const r = await adminApi.listSitesCatalog();
    sites.value = r.data || [];
  } catch (e) {
    sites.value = [];
  }
}

watch(siteId, () => load());
onMounted(() => { loadSites(); load(); });
</script>

<style scoped>
.overview-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.overview-header h2 { margin: 0; }
.site-filter { padding: 6px 10px; background: #0b1220; color: var(--text); border: 1px solid #1e293b; border-radius: 3px; }
.retry { padding: 6px 14px; background: var(--accent); color: #0b1220; border: 1px solid #1e293b; border-radius: 3px; cursor: pointer; }
.skeleton-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 12px; }
.skeleton-card { height: 140px; background: linear-gradient(90deg, var(--panel) 0%, #1e293b 50%, var(--panel) 100%); background-size: 200% 100%; animation: shimmer 1.5s infinite; border-radius: 6px; }
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
.error-banner { padding: 16px; background: #7f1d1d; border-radius: 4px; display: flex; align-items: center; gap: 12px; }
.error-banner button { padding: 4px 12px; background: var(--accent); color: #0b1220; border: none; border-radius: 3px; cursor: pointer; }
.empty-state { padding: 40px; text-align: center; color: var(--muted); }
.card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 12px; }
</style>
