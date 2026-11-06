<template>
  <AppLayout>
    <div class="topology-view">
      <h2>复制拓扑</h2>
      <!-- R158.45.9a (2026-10-05) — operator "去掉复制链路和复制伙伴":
           只保留 "不健康链路" chip, 删 总链路 + 复制伙伴.
      -->
      <div class="topology-metrics" data-test="topology-metrics">
        <div class="metric metric-err" data-test="metric-err-links">
          <span class="metric-label">不健康链路</span>
          <span class="metric-value" :class="{ 'is-zero': !metrics.badPairs }">{{ metrics.badPairs }}</span>
        </div>
        <!-- R158.X.99-silent.topology (2026-10-21) — 探针接入未报告链路数.
             跟"不健康链路"平行独立: 一条边可以既不健康又探针未报告, 也可以只探针未报告
             (老 30min probe 报成功但新 15min probe 0 数据)。跟 /matrix/inbound 的
             "探针接入未报告 N" legend 桶 1:1 平行。 -->
        <div class="metric metric-silent" data-test="metric-silent-links">
          <span class="metric-label">探针接入未报告</span>
          <span class="metric-value" :class="{ 'is-zero': !metrics.silentPairs }">{{ metrics.silentPairs }}</span>
        </div>
      </div>
      <p v-if="loading">Loading...</p>
      <p v-else-if="error" class="err">{{ error }}</p>
      <TopologyChart v-else :data="data" />
    </div>
  </AppLayout>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue';
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

// R158.45.9a (2026-10-05) — operator "去掉复制链路和复制伙伴": 只算不健康链路数.
//   peerPairKey(A,B): 排序拼接, A↔B unordered pair 去重, statusCode>=1 算 1 个不健康.
const metrics = computed(() => {
  const links = data.value?.links || [];
  const pairMap = new Map();
  for (const l of links) {
    if (!l.source || !l.target || l.source === l.target) continue;
    const a = l.source, b = l.target;
    const key = a < b ? `${a}\u0001${b}` : `${b}\u0001${a}`;
    const sc = l.statusCode ?? 0;
    const prev = pairMap.get(key);
    if (!prev || sc > prev) pairMap.set(key, sc);
  }
  let badPairs = 0;
  for (const sc of pairMap.values()) {
    if (sc >= 1) badPairs++;
  }
  // R158.X.99-silent.topology (2026-10-21) — 探针接入无报告的 unordered pair 数.
  //   跟 badPairs 平行独立 (可能重叠: 一条边既 statusCode=2 又 probeState='none').
  //   probeState=null (v_partner_inbound 无匹配 row) 不计入 — 只认显式 'none',
  //   跟 matrix silent 拆分点 1:1 平行 (partner 缺失 ≠ silent).
  const silentPairs = new Set();
  for (const l of links) {
    if (!l.source || !l.target || l.source === l.target) continue;
    if (l.probeState === 'none') {
      const a = l.source, b = l.target;
      silentPairs.add(a < b ? `${a}\u0001${b}` : `${b}\u0001${a}`);
    }
  }
  return { badPairs, silentPairs: silentPairs.size };
});
</script>

<style scoped>
.topology-view { padding: 16px; }
.err { color: var(--red); }
/* R158.45.9 — 顶部 3 metric chip */
.topology-metrics {
  display: flex;
  gap: 12px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.metric {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 16px;
  border: 1px solid var(--border);
  background: var(--sidebar-bg);
  border-radius: 4px;
  min-width: 120px;
}
.metric-label {
  font-size: 11px;
  color: var(--muted);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.metric-value {
  font-size: 22px;
  font-weight: 700;
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  line-height: 1;
}
.metric-err { border-color: color-mix(in srgb, var(--red) 40%, var(--border)); }
.metric-err .metric-value { color: var(--red); }
.metric-err .metric-value.is-zero { color: var(--green); }
/* R158.X.99-silent.topology — silent chip 复用 --red (lesson 150: 0 引新色板),
   跟 .metric-err 同色是刻意的 —— 两个都是"链路异常", 只是异常类型不同。
   主图已用 dash 密度区分, chip 这里靠 label 文字区分。 */
.metric-silent { border-color: color-mix(in srgb, var(--red) 40%, var(--border)); }
.metric-silent .metric-value { color: var(--red); }
.metric-silent .metric-value.is-zero { color: var(--green); }
</style>