<template>
  <div ref="chartEl" style="width:100%; height:600px;"></div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue';
import * as echarts from 'echarts';

const props = defineProps({
  data: { type: Object, default: () => ({ nodes: [], links: [] }) }
});

const chartEl = ref(null);
let chart = null;

function build() {
  if (!chart) return;
  const nodes = (props.data.nodes || []).map(n => {
    const isSite = n.type === 'site';
    return {
      name: n.name,
      category: isSite ? 0 : 1,
      symbolSize: isSite ? 36 : 14,
      itemStyle: { color: isSite ? '#38bdf8' : '#94a3b8' }
    };
  });
  const links = (props.data.links || []).map(l => ({
    source: l.source,
    target: l.target,
    lineStyle: {
      color: l.statusCode === 0 ? '#22c55e' : '#ef4444',
      width: 1.5,
      curveness: 0.1
    }
  }));
  const option = {
    tooltip: {
      formatter: (p) => {
        if (p.dataType === 'edge') {
          return `${p.data.source} → ${p.data.target}`;
        }
        return p.name;
      }
    },
    legend: [{
      data: ['站点', '域控']
    }],
    series: [{
      type: 'graph',
      layout: 'force',
      roam: true,
      draggable: true,
      categories: [{ name: '站点' }, { name: '域控' }],
      force: { repulsion: 220, edgeLength: 80 },
      data: nodes,
      links,
      lineStyle: { color: '#475569', curveness: 0.1 }
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