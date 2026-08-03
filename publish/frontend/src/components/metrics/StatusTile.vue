<template>
  <div class="status-tile" :class="statusClass">
    <div class="status">{{ status }}</div>
    <div class="label">{{ metric.label }}</div>
    <div class="message" v-if="message">{{ message }}</div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  metric: { type: Object, required: true },
  status: { type: String, default: 'UNKNOWN' },
  message: { type: String, default: null }
});

const statusClass = computed(() => {
  const s = (props.status || '').toUpperCase();
  if (s === 'OK' || s === 'HEALTHY' || s === 'PASS') return 'green';
  if (s === 'WARN' || s === 'WARNING') return 'yellow';
  if (s === 'CRIT' || s === 'CRITICAL' || s === 'ERROR' || s === 'FAIL') return 'red';
  return 'gray';
});
</script>

<style scoped>
.status-tile { padding: 16px; border-radius: 8px; }
.status-tile.green { background: #f0f9eb; color: #67c23a; }
.status-tile.yellow { background: #fdf6ec; color: #e6a23c; }
.status-tile.red { background: #fef0f0; color: #f56c6c; }
.status-tile.gray { background: #f5f7fa; color: #909399; }
.status { font-size: 22px; font-weight: bold; }
.label { font-size: 12px; margin-top: 8px; opacity: 0.85; }
.message { font-size: 11px; margin-top: 4px; opacity: 0.7; }
</style>
