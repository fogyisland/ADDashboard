<template>
  <div class="counter-tile">
    <div class="value">
      {{ currentValue !== null ? currentValue.toLocaleString() : '—' }}<span class="unit">{{ unit }}</span>
    </div>
    <div class="delta" :class="deltaClass">
      <span v-if="delta > 0">↑ +{{ delta.toLocaleString() }}</span>
      <span v-else-if="delta < 0">↓ {{ delta.toLocaleString() }}</span>
      <span v-else>— 0</span>
    </div>
    <div class="label">{{ label }}</div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  metric: { type: Object, required: true },
  currentValue: { type: Number, default: null },
  delta: { type: Number, default: 0 }
});

const unit = computed(() => props.metric.unit || '');
const label = computed(() => props.metric.label);
const deltaClass = computed(() => {
  if (props.delta > 0) return 'up';
  if (props.delta < 0) return 'down';
  return 'flat';
});
</script>

<style scoped>
.counter-tile { padding: 16px; border-radius: 8px; background: #1e293b; color: var(--text); }
.value { font-size: 24px; font-weight: bold; }
.unit { font-size: 13px; margin-left: 4px; font-weight: normal; color: var(--muted); }
.delta { font-size: 13px; margin-top: 4px; }
.delta.up { color: #67c23a; }
.delta.down { color: #f56c6c; }
.delta.flat { color: var(--muted); }
.label { font-size: 12px; margin-top: 8px; color: var(--muted); }
</style>
