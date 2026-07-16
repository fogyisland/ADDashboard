<template>
  <AppLayout>
    <h2>Agent 列表</h2>
    <AgentStatusTable :rows="rows" />
  </AppLayout>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import api from '../api/client.js';
import AppLayout from '../components/AppLayout.vue';
import AgentStatusTable from '../components/AgentStatusTable.vue';
const rows = ref([]);
let timer = null;
async function load() { rows.value = (await api.get('/api/dashboard/agents')).data; }
onMounted(() => { load(); timer = setInterval(load, 30000); });
onUnmounted(() => clearInterval(timer));
</script>
