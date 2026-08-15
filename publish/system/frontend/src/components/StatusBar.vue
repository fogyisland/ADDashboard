<template>
  <div class="status-bar">
    <div class="kpi" :class="healthClass">
      <span class="label">健康率</span>
      <span class="value">{{ healthRate }}%</span>
    </div>
    <div class="kpi">
      <span class="label">复制链路</span>
      <span class="value">{{ data.totalLinks ?? '-' }}</span>
    </div>
    <div class="kpi warn">
      <span class="label">警告</span>
      <span class="value">{{ data.warning ?? 0 }}</span>
    </div>
    <div class="kpi err">
      <span class="label">错误</span>
      <span class="value">{{ data.error ?? 0 }}</span>
    </div>
    <div class="kpi">
      <span class="label">Agent</span>
      <span class="value">{{ data.agentCount ?? 0 }}</span>
    </div>
    <div class="kpi">
      <span class="label">最后更新</span>
      <span class="value small">{{ formatTime(data.lastUpdate) }}</span>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue';
import api from '../api/client.js';
const data = ref({});
let timer = null;
async function load() { try { const r = await api.get('/api/dashboard/overview'); data.value = r.data; } catch {} }
onMounted(() => { load(); timer = setInterval(load, 30000); });
onUnmounted(() => clearInterval(timer));
const healthRate = computed(() => {
  const t = data.value.totalLinks || 0, h = data.value.healthy || 0;
  return t ? Math.round((h / t) * 100) : 100;
});
const healthClass = computed(() => healthRate.value === 100 ? 'ok' : (data.value.error > 0 ? 'err' : 'warn'));
function formatTime(s) { if (!s) return '-'; return new Date(s).toLocaleString('zh-CN', { hour12: false }); }
</script>

<style scoped>
.status-bar { display: flex; gap: 16px; padding: 12px; background: var(--panel); border-radius: 6px; margin-bottom: 16px; }
.kpi { flex: 1; padding: 8px 12px; border-left: 3px solid var(--muted); }
.kpi.ok { border-color: var(--green); }
.kpi.warn { border-color: var(--yellow); }
.kpi.err { border-color: var(--red); }
.label { display: block; font-size: 12px; color: var(--muted); }
.value { display: block; font-size: 20px; font-weight: 600; }
.value.small { font-size: 14px; font-weight: 400; }
</style>