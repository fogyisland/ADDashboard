<template>
  <AppLayout>
    <h2>错误链路</h2>
    <button @click="reload">刷新</button>
    <ErrorTable :rows="rows" />
  </AppLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import api from '../api/client.js';
import AppLayout from '../components/AppLayout.vue';
import ErrorTable from '../components/ErrorTable.vue';
const rows = ref([]);
async function reload() { rows.value = (await api.get('/api/dashboard/errors')).data; }
onMounted(reload);
</script>
