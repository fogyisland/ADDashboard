<template>
  <div class="site-matrix-view">
    <h2>Replication Site Matrix</h2>
    <p v-if="loading">Loading...</p>
    <p v-else-if="error" class="err">{{ error }}</p>
    <SiteMatrixChart v-else :data="data" />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import SiteMatrixChart from '../components/SiteMatrixChart.vue';
import api from '../api/client.js';

const data = ref([]);
const loading = ref(true);
const error = ref(null);

onMounted(async () => {
  try {
    const res = await api.get('/api/dashboard/site-matrix');
    // Backend returns camelCase rows: { sourceSite, destSite, total, errorCount, warningCount }
    data.value = Array.isArray(res.data) ? res.data : [];
  } catch (e) {
    error.value = e?.message || 'Failed to load site matrix';
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.site-matrix-view { padding: 16px; }
.err { color: #ef4444; }
</style>