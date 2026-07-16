<template>
  <AppLayout>
    <div class="topology-view">
      <h2>复制拓扑</h2>
      <p v-if="loading">Loading...</p>
      <p v-else-if="error" class="err">{{ error }}</p>
      <TopologyChart v-else :data="data" />
    </div>
  </AppLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import TopologyChart from '../components/TopologyChart.vue';
import AppLayout from '../components/AppLayout.vue';
import api from '../api/client.js';

const data = ref({ nodes: [], links: [] });
const loading = ref(true);
const error = ref(null);

onMounted(async () => {
  try {
    const res = await api.get('/api/dashboard/topology');
    // Backend returns camelCase keys: { nodes: [{name,type,site}], links: [{source,target,statusCode,lastSuccessTime}] }
    data.value = res.data && Array.isArray(res.data.nodes) ? res.data : { nodes: [], links: [] };
  } catch (e) {
    error.value = e?.message || 'Failed to load topology';
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.topology-view { padding: 16px; }
.err { color: #ef4444; }
</style>