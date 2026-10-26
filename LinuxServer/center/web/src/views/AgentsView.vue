<template>
  <AppLayout>
    <h2>Agent</h2>
    <!-- R157.7 — top status strip: online (green) vs offline (red) counts.
         Mirrors src/db/sql.js `dcOnlineCheck` semantics: an agent counts as
         online iff its lastHeartbeatAt is within the last 5 minutes. We
         compute on the frontend from the same payload /api/dashboard/agents
         already returns, so no extra round-trip. -->
    <div class="agent-status-strip">
      <div class="status-pill status-online">
        <span class="status-label">在线</span>
        <span class="status-count">{{ onlineCount }}</span>
      </div>
      <div class="status-pill status-offline">
        <span class="status-label">离线</span>
        <span class="status-count">{{ offlineCount }}</span>
      </div>
    </div>
    <!-- R140 — site-grouped rendering. Same flat-row AgentStatusTable
         component, but rows are now bucketed by siteName. The site
         section header is rendered inline via `groups` prop so we don't
         have to fork AgentStatusTable's row shape. -->
    <AgentStatusTable :groups="groups" />
  </AppLayout>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import api from '../api/client.js';
import AppLayout from '../components/AppLayout.vue';
import AgentStatusTable from '../components/AgentStatusTable.vue';

const rows = ref([]);
let loadTimer = null;
let nowTimer = null;

// R140 — bucket agents by siteName (mirrors ServersOverviewView
// cardGroups logic, same UNGROUPED_LABEL fallback).
const UNGROUPED_LABEL = '未分组';

// R157.7 — online iff lastHeartbeatAt is within the last 5 minutes
// (matches src/db/sql.js `dcOnlineCheck` INTERVAL 5 MINUTE). Agents
// that have never reported (lastHeartbeatAt == null) count as offline.
const ONLINE_WINDOW_MS = 5 * 60 * 1000;
const now = ref(Date.now());
function isOnline(row) {
  if (!row.lastHeartbeatAt) return false;
  const t = Date.parse(row.lastHeartbeatAt);
  if (!Number.isFinite(t)) return false;
  return now.value - t <= ONLINE_WINDOW_MS;
}

const onlineCount = computed(() => rows.value.filter(isOnline).length);
const offlineCount = computed(() => rows.value.length - onlineCount.value);

const groups = computed(() => {
  const buckets = new Map();
  for (const r of rows.value) {
    const key = r.siteName || UNGROUPED_LABEL;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  // Map preserves insertion order — we don't have a sites catalog
  // here, so just emit in encounter order (first siteName seen wins).
  const out = [];
  for (const [key, list] of buckets.entries()) {
    out.push({ siteName: key, rows: list });
  }
  return out;
});

async function load() {
  // R140 — backend now returns siteName / siteId / regionCode / siteHint
  // (LEFT JOIN ad_dcs / ad_sites added to db.sql.dashboard.agents).
  // R157.8 — wrap in try/catch so an API failure surfaces as a stale-data
  // badge instead of an unhandled rejection that leaves the UI frozen on
  // the last successful response (code review M1 finding).
  try {
    rows.value = (await api.get('/api/dashboard/agents')).data;
    now.value = Date.now();
  } catch (e) {
    // keep last-known rows; bump now so online/offline boundary still moves
    now.value = Date.now();
    // eslint-disable-next-line no-console
    console.warn('[R157.8] AgentsView load failed:', e?.message || e);
  }
}

onMounted(() => {
  load();
  // R157.8 — two INDEPENDENT timers (was nested setInterval leak — code
  // review C1). The previous code did `setInterval(load, 30s)` whose
  // callback itself called `setInterval(() => { now.value = ... }, 5s)`,
  // leaking one 5s handle every 30s with no clearInterval — 120 leaked
  // handles after 1h, 2880 after 24h.
  loadTimer = setInterval(load, 30000);
  nowTimer = setInterval(() => { now.value = Date.now(); }, 5000);
});
onUnmounted(() => {
  clearInterval(loadTimer);
  clearInterval(nowTimer);
  loadTimer = null;
  nowTimer = null;
});
</script>

<style scoped>
.agent-status-strip {
  display: flex;
  gap: 12px;
  margin: 8px 0 16px;
}
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-radius: 999px;
  font-weight: 600;
  font-size: 14px;
  border: 1px solid transparent;
}
.status-pill .status-label {
  font-weight: 500;
  opacity: 0.85;
}
.status-pill .status-count {
  font-size: 16px;
  font-variant-numeric: tabular-nums;
}
.status-online {
  background: var(--ok-bg, #e6f7ec);
  color: var(--ok-fg, #1a7f37);
  border-color: var(--ok-border, #b7e1c5);
}
.status-offline {
  background: var(--err-bg, #fde8e8);
  color: var(--err-fg, #b42318);
  border-color: var(--err-border, #f3b3b3);
}
</style>