<template>
  <AppLayout>
    <h2>用户锁定排查</h2>

    <div class="filter-bar">
      <label>
        <span>锁定用户</span>
        <input type="text" v-model="targetUser" placeholder="如 alice" data-test="target-user" />
      </label>
      <label>
        <span>DC</span>
        <input type="text" v-model="dc" placeholder="如 DC01" data-test="dc" />
      </label>
      <label>
        <span>调用方</span>
        <input type="text" v-model="caller" placeholder="如 WS-DEV-42" data-test="caller" />
      </label>
      <label>
        <span>时间窗口</span>
        <select v-model.number="sinceHours" data-test="since-hours">
          <option :value="1">1 小时</option>
          <option :value="6">6 小时</option>
          <option :value="24">24 小时</option>
          <option :value="168">7 天</option>
        </select>
      </label>
      <button class="search-btn" :disabled="!canSearch || loading" @click="search">查询</button>
    </div>

    <div v-if="loading" class="skeleton">
      <div v-for="i in 3" :key="i" class="skeleton-row"></div>
    </div>

    <div v-else-if="error" class="error-banner">
      <span>查询失败，请重试</span>
      <button @click="search">重试</button>
    </div>

    <div v-else-if="events.length === 0" class="empty-state">
      无匹配事件 — 尝试调整过滤或扩大时间窗口
    </div>

    <div v-else class="result-list">
      <div
        v-for="(ev, i) in events"
        :key="i"
        class="lockout-row"
        :class="{ 'source-row': ev.isSource }"
      >
        <span v-if="ev.isSource" class="source-marker" title="锁定源头">⭐ 源头</span>
        <span class="time">{{ formatTime(ev.occurredAt) }}</span>
        <button class="dc-badge" @click="drillDown('dc', ev.dcName)">{{ ev.dcName }}</button>
        <span class="target">目标: {{ ev.targetUserName }}</span>
        <span class="subject">{{ ev.subjectDomain }}\{{ ev.subjectUserName }}</span>
        <button class="caller-badge" @click="drillDown('caller', ev.callerComputerName)">
          {{ ev.callerComputerName || '—' }}
        </button>
      </div>
      <footer class="result-footer">共 {{ events.length }} 条事件</footer>
    </div>
  </AppLayout>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import { searchLockoutEvents } from '../api/lockout.js';

const route = useRoute();
const router = useRouter();

const targetUser = ref('');
const dc         = ref('');
const caller     = ref('');
const sinceHours = ref(24);

const events  = ref([]);
const loading = ref(false);
const error   = ref(false);

const canSearch = computed(() => !!(targetUser.value || dc.value || caller.value));

async function search() {
  if (!canSearch.value) return;
  loading.value = true;
  error.value = false;
  try {
    const r = await searchLockoutEvents({
      targetUser: targetUser.value,
      dc:         dc.value,
      caller:     caller.value,
      sinceHours: sinceHours.value
    });
    events.value = r.data || [];
  } catch (e) {
    error.value = true;
    events.value = [];
  } finally {
    loading.value = false;
  }
}

async function drillDown(field, value) {
  if (!value) return;
  // Update the URL query — preserves other filters. router.replace so we
  // don't pollute the history stack with each badge click.
  const nextQuery = { ...route.query, [field]: value };
  await router.replace({ path: '/lockout-troubleshooting', query: nextQuery });
}

function formatTime(s) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString();
}

onMounted(async () => {
  // Pre-fill from URL and trigger an immediate search. Enables drill-down
  // entry from /servers-overview?dc=DC01 or /servers-overview?caller=WS-01.
  const q = route.query;
  if (typeof q.targetUser === 'string') targetUser.value = q.targetUser;
  if (typeof q.dc === 'string')         dc.value = q.dc;
  if (typeof q.caller === 'string')     caller.value = q.caller;
  if (canSearch.value) await search();
});

// React to drill-down clicks that change the URL
watch(() => route.query, async (newQ) => {
  if (typeof newQ.dc === 'string' && newQ.dc !== dc.value) {
    dc.value = newQ.dc;
  }
  if (typeof newQ.caller === 'string' && newQ.caller !== caller.value) {
    caller.value = newQ.caller;
  }
  if (canSearch.value) await search();
});
</script>

<style scoped>
.filter-bar { display: flex; gap: 12px; align-items: flex-end; margin-bottom: 16px; flex-wrap: wrap; }
.filter-bar label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
.filter-bar input, .filter-bar select { padding: 6px 10px; background: #0b1220; color: var(--text); border: 1px solid #1e293b; border-radius: 3px; font-size: 13px; }
.search-btn { padding: 6px 18px; background: var(--accent); color: #0b1220; border: 1px solid #1e293b; border-radius: 3px; cursor: pointer; font-weight: 600; }
.search-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.skeleton { display: flex; flex-direction: column; gap: 8px; }
.skeleton-row { height: 40px; background: linear-gradient(90deg, var(--panel) 0%, #1e293b 50%, var(--panel) 100%); background-size: 200% 100%; animation: shimmer 1.5s infinite; border-radius: 4px; }
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
.error-banner { padding: 16px; background: #7f1d1d; border-radius: 4px; display: flex; align-items: center; gap: 12px; }
.error-banner button { padding: 4px 12px; background: var(--accent); color: #0b1220; border: none; border-radius: 3px; cursor: pointer; }
.empty-state { padding: 40px; text-align: center; color: var(--muted); }
.result-list { display: flex; flex-direction: column; gap: 6px; }
.lockout-row { display: grid; grid-template-columns: auto 140px 100px 1fr 1fr 140px; gap: 12px; padding: 8px 12px; background: var(--panel); border: 1px solid #1e293b; border-radius: 4px; align-items: center; font-size: 13px; }
.lockout-row.source-row { border-left: 4px solid #fbbf24; background: #422006; }
.source-marker { color: #fbbf24; font-weight: 600; }
.time { color: var(--muted); font-family: monospace; }
.dc-badge, .caller-badge { padding: 2px 10px; background: #0b1220; border: 1px solid #1e293b; border-radius: 10px; font-size: 11px; cursor: pointer; color: var(--text); }
.dc-badge:hover, .caller-badge:hover { border-color: var(--accent); }
.target { color: var(--text); font-weight: 600; }
.subject { color: var(--muted); font-family: monospace; font-size: 12px; }
.result-footer { padding: 12px; text-align: right; color: var(--muted); font-size: 12px; }
</style>