<template>
  <div class="timeseries-tile">
    <div class="label">{{ metric.label }}</div>
    <div class="chart" ref="chartEl"></div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue';
import * as echarts from 'echarts';

const props = defineProps({
  metric: { type: Object, required: true },
  data: { type: Array, default: () => [] }
});

const chartEl = ref(null);
let chart = null;

function build() {
  if (!chart) return;
  const data = (props.data || []).map((d) => [d.ts, d.value]);
  chart.setOption({
    tooltip: { trigger: 'axis' },
    grid: { left: 48, right: 16, top: 16, bottom: 32 },
    xAxis: { type: 'time' },
    yAxis: { type: 'value', name: props.metric.unit || '' },
    series: [{
      name: props.metric.label,
      type: 'line',
      showSymbol: false,
      data
    }]
  });
}

onMounted(async () => {
  await nextTick();
  if (chartEl.value) {
    chart = echarts.init(chartEl.value);
    build();
  }
});

watch(() => props.data, build, { deep: true });

onUnmounted(() => {
  chart?.dispose();
});
</script>

<style scoped>
.timeseries-tile { padding: 16px; background: #1e293b; border-radius: 8px; }
.chart { width: 100%; height: 200px; }
.label { font-weight: bold; margin-bottom: 8px; color: var(--text); font-size: 13px; }
</style>
