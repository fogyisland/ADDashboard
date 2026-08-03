<template>
  <div class="gauge-tile" :class="colorClass">
    <div class="value">
      {{ currentValue !== null ? currentValue : '—' }}<span class="unit">{{ unit }}</span>
    </div>
    <div class="label">{{ label }}</div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  metric: { type: Object, required: true },
  currentValue: { type: Number, default: null }
});

const unit = computed(() => props.metric.unit || '');
const label = computed(() => props.metric.label);

const colorClass = computed(() => {
  if (props.currentValue === null || props.currentValue === undefined) return 'gray';
  const t = props.metric.thresholds || {};
  if (t.crit !== undefined && t.crit !== null && props.currentValue > t.crit) return 'red';
  if (t.warn !== undefined && t.warn !== null && props.currentValue > t.warn) return 'yellow';
  return 'green';
});
</script>

<style scoped>
.gauge-tile { padding: 16px; border-radius: 8px; }
.gauge-tile.green { background: #f0f9eb; color: #67c23a; }
.gauge-tile.yellow { background: #fdf6ec; color: #e6a23c; }
.gauge-tile.red { background: #fef0f0; color: #f56c6c; }
.gauge-tile.gray { background: #f5f7fa; color: #909399; }
.value { font-size: 28px; font-weight: bold; }
.unit { font-size: 14px; margin-left: 4px; font-weight: normal; }
.label { font-size: 12px; margin-top: 8px; opacity: 0.85; }
</style>
