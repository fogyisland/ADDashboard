<template>
  <div ref="chartEl" style="width:100%; height:600px;"></div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue';
import * as echarts from 'echarts';

const props = defineProps({
  data: { type: Array, default: () => [] }
});

const chartEl = ref(null);
let chart = null;

function classifyState(row) {
  if (row.errorCount > 0) return 2;
  if (row.warningCount > 0) return 1;
  return 0;
}

function build() {
  if (!chart) return;
  const sites = Array.from(new Set([
    ...props.data.map(d => d.sourceSite),
    ...props.data.map(d => d.destSite)
  ]));
  const idx = Object.fromEntries(sites.map((s, i) => [s, i]));
  const cells = props.data.map(d => ({
    value: [
      idx[d.sourceSite],
      idx[d.destSite],
      classifyState(d),
      d
    ]
  }));
  const option = {
    tooltip: {
      position: 'top',
      formatter: (p) => {
        const r = p.value[3];
        return `${r.sourceSite} -> ${r.destSite}<br/>total: ${r.total}<br/>errors: ${r.errorCount}<br/>warnings: ${r.warningCount}`;
      }
    },
    grid: { left: 80, right: 20, top: 40, bottom: 80 },
    xAxis: { type: 'category', data: sites, splitArea: { show: true } },
    yAxis: { type: 'category', data: sites, splitArea: { show: true } },
    visualMap: [{
      min: 0, max: 2, calculable: true, orient: 'horizontal',
      left: 'center', bottom: 10,
      inRange: { color: ['#22c55e', '#eab308', '#ef4444'] },
      categories: ['ok', 'warning', 'error']
    }],
    series: [{
      name: 'site-matrix',
      type: 'heatmap',
      data: cells,
      label: { show: true, formatter: (p) => p.value[3] ? p.value[3].total : '' },
      emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.5)' } }
    }]
  };
  chart.setOption(option);
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