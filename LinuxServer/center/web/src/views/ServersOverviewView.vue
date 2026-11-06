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

    <!-- R140 — site-grouped rendering. The site-filter dropdown still
         works (when set, only that site's group renders); with "全部
         站点" the page shows every site's section header followed by
         that site's DcCard grid. "未分组" bucket holds cards whose
         DC isn't in ad_dcs (LEFT JOIN produced siteName = null). -->
    <div v-else class="grouped-view">
      <section
        v-for="group in cardGroups"
        :key="group.key"
        class="site-section"
        :class="{ 'site-section--empty': group.cards.length === 0 }"
      >
        <h3 class="site-section-title">
          <span class="site-name">{{ group.label }}</span>
          <span class="site-count">{{ group.cards.length }} 台</span>
        </h3>
        <div class="card-grid">
          <DcCard v-for="card in group.cards" :key="card.dcHost" :dc="card" />
        </div>
      </section>
    </div>
  </AppLayout>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import AppLayout from '../components/AppLayout.vue';
import DcCard from '../components/DcCard.vue';
import { getDcSummary } from '../api/dcs.js';
import { adminApi } from '../api/admin.js';

// R140 — "未分组" bucket label. Mirrors R138 TopologyChart ORPHAN_BUCKET.
const UNGROUPED_LABEL = '未分组';

const siteId = ref('');
const sites = ref([]);
const cards = ref([]);
const loading = ref(false);
const error = ref(false);

// R140 — bucket cards by siteName. Each section renders a site title
// followed by that site's DcCard grid. siteId filter still works:
// when set, the parent load() asks the back-end for that site only
// (single-bucket response), and we still wrap it in a section header
// for consistency with the all-sites view.
const cardGroups = computed(() => {
  // Stable order: sites.value (canonical catalog order) first, then
  // any bucket the catalog doesn't know about (defensive — should not
  // happen since /api/dcs/summary is joined to ad_sites, but a site
  // can be deleted from the catalog while a DC still references it).
  const buckets = new Map();
  for (const c of cards.value) {
    const key = c.siteName || UNGROUPED_LABEL;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(c);
  }
  const ordered = [];
  const seen = new Set();
  for (const s of sites.value) {
    const key = s.siteName;
    if (buckets.has(key)) {
      ordered.push({ key, label: key, cards: buckets.get(key) });
      seen.add(key);
    }
  }
  // UNGROUPED bucket last so it doesn't break catalog ordering.
  for (const [key, list] of buckets.entries()) {
    if (!seen.has(key)) ordered.push({ key, label: key, cards: list });
  }
  return ordered;
});

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
.site-filter { padding: 6px 10px; background: var(--sidebar-bg); color: var(--text); border: 1px solid var(--border); border-radius: 3px; }
.retry { padding: 6px 14px; background: var(--accent); color: var(--sidebar-bg); border: 1px solid var(--border); border-radius: 3px; cursor: pointer; }
.skeleton-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 12px; }
.skeleton-card { height: 140px; background: linear-gradient(90deg, var(--panel) 0%, var(--border) 50%, var(--panel) 100%); background-size: 200% 100%; animation: shimmer 1.5s infinite; border-radius: 6px; }
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
.error-banner { padding: 16px; background: var(--danger-bg); border-radius: 4px; display: flex; align-items: center; gap: 12px; }
.error-banner button { padding: 4px 12px; background: var(--accent); color: var(--sidebar-bg); border: none; border-radius: 3px; cursor: pointer; }
.empty-state { padding: 40px; text-align: center; color: var(--muted); }

/* R140 — site-grouped layout */
.grouped-view { display: flex; flex-direction: column; gap: 18px; }
.site-section {
  background: color-mix(in srgb, var(--panel) 35%, transparent);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 14px 16px;
}
.site-section--empty { opacity: 0.55; }
.site-section-title {
  display: flex; align-items: baseline; justify-content: space-between;
  margin: 0 0 10px;
  padding: 4px 6px;
  position: sticky; top: 0;
  background: color-mix(in srgb, var(--sidebar-bg) 92%, transparent);
  backdrop-filter: blur(2px);
  z-index: 5;
  border-radius: 4px;
}
.site-name { color: var(--accent); font-size: 14px; font-weight: 700; }
.site-count { color: var(--muted); font-size: 12px; font-family: monospace; }
.card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 12px; }
</style>