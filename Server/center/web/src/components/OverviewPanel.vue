<!--
  OverviewPanel.vue — R148 概览页通用面板卡片.

  一个面板承载 2-3 个分层数字 + 链接到详细页的 "详情 →" 按钮.
  严重度 (severityClass) 派生自 metrics 中最大的分层数字 — 用于左侧边框着色,
  与 StatusBar.vue / OsBaselineView.vue 的 severity token 共用 (R137/R138).
-->
<template>
  <article class="overview-panel" :class="severityClass">
    <header>
      <h3>{{ title }}</h3>
      <router-link v-if="linkTo" :to="linkTo" class="detail-link">详情 →</router-link>
    </header>
    <dl class="metric-list">
      <template v-for="(key, idx) in metricKeys" :key="key">
        <dt>{{ labels[key] || key }}</dt>
        <dd :class="valueClass(key)">{{ valueOf(key) }}</dd>
      </template>
    </dl>
  </article>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  title: { type: String, required: true },
  metrics: { type: Object, required: true },
  metricKeys: { type: Array, required: true },       // 渲染顺序
  labels: { type: Object, default: () => ({}) },      // key → 中文文案
  // 哪些 key 计 critical / warning / normal — 用于左侧边框着色.
  severity: { type: Object, default: () => ({ critical: [], warning: [], normal: [] }) },
  linkTo: { type: [String, Object], default: null }
});

function valueOf(key) {
  const m = props.metrics || {};
  const v = m[key];
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function valueClass(key) {
  const s = props.severity || {};
  for (const k of (s.critical || [])) if (k === key) return 'metric-critical';
  for (const k of (s.warning || [])) if (k === key) return 'metric-warning';
  for (const k of (s.normal || [])) if (k === key) return 'metric-normal';
  return '';
}

const severityClass = computed(() => {
  const m = props.metrics || {};
  const s = props.severity || {};
  // 取 critical/warning/normal 各 key 组的数字, 找出最大所在组
  const score = (keys) => (keys || []).reduce((sum, k) => sum + (Number(m[k]) || 0), 0);
  const c = score(s.critical);
  const w = score(s.warning);
  if (c > 0) return 'severity-critical';
  if (w > 0) return 'severity-warning';
  return 'severity-normal';
});
</script>

<style scoped>
.overview-panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-left: 3px solid var(--muted);
  border-radius: 6px;
  padding: 12px 16px;
  min-height: 120px;
}
.overview-panel.severity-critical { border-left-color: var(--severity-critical-text, var(--red)); }
.overview-panel.severity-warning  { border-left-color: var(--severity-warning-text, var(--yellow)); }
.overview-panel.severity-normal   { border-left-color: var(--severity-ok-text, var(--green)); }
.overview-panel header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.overview-panel h3 { margin: 0; font-size: 14px; font-weight: 600; color: var(--fg); }
.detail-link { font-size: 12px; color: var(--accent); text-decoration: none; }
.detail-link:hover { text-decoration: underline; }
.metric-list { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; margin: 0; }
.metric-list dt { font-size: 12px; color: var(--muted); }
.metric-list dd { margin: 0; font-size: 16px; font-weight: 600; text-align: right; color: var(--fg); }
.metric-critical { color: var(--severity-critical-text, var(--red)); }
.metric-warning  { color: var(--severity-warning-text, var(--yellow)); }
.metric-normal   { color: var(--severity-ok-text, var(--green)); }
</style>