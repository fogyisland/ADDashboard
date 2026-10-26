<!-- R158.77 (2026-10-11) — member-server Agent 列表 sub-tab. Mirrors
     AgentsView.vue (R140/R157) but reads /api/dashboard/member-agents
     (filtered to non-AD). Reuses AgentStatusTable.vue component.

     No AppLayout wrapper here — parent MemberServerView already provides
     the chrome. -->
<template>
  <div class="ms-agents">
    <header class="page-header">
      <div class="title-block">
        <h2>Agent</h2>
        <p class="subtitle">非 AD 成员服务器的 agent 心跳 — 在线判定 = 最近 5 分钟内 lastHeartbeatAt</p>
      </div>
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
    </header>

    <AgentStatusTable :groups="groups" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { memberServerApi } from '../../api/member-server.js';
import AgentStatusTable from '../../components/AgentStatusTable.vue';

const rows = ref([]);
let loadTimer = null;
let nowTimer = null;

const UNGROUPED_LABEL = '未分组';

// R157.7 — online iff lastHeartbeatAt is within the last 5 minutes.
// Same 5-min window as member-overview endpoint (ONLINE_WINDOW_MIN=5).
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
  const out = [];
  for (const [key, list] of buckets.entries()) {
    out.push({ siteName: key, rows: list });
  }
  return out;
});

async function load() {
  try {
    const r = await memberServerApi.getAgents();
    const payload = r && r.data ? r.data : r;
    rows.value = Array.isArray(payload?.items) ? payload.items : [];
    now.value = Date.now();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[R158.77] MemberServerAgentsView load failed:', e?.message || e);
    now.value = Date.now();
  }
}

onMounted(() => {
  load();
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
.ms-agents { padding: 16px 0; }
.page-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
.title-block h2 { margin: 0 0 4px; font-size: 20px; color: var(--accent); }
.subtitle { margin: 0; font-size: 12px; color: var(--muted); max-width: 720px; }

.agent-status-strip {
  display: flex;
  gap: 12px;
  margin: 0;
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
.status-pill .status-label { font-weight: 500; opacity: 0.85; }
.status-pill .status-count { font-size: 16px; font-variant-numeric: tabular-nums; }
.status-online {
  background: color-mix(in srgb, var(--green) 25%, transparent);
  color: var(--green);
  border-color: color-mix(in srgb, var(--green) 50%, transparent);
}
.status-offline {
  background: color-mix(in srgb, var(--severity-critical-text) 15%, transparent);
  color: var(--severity-critical-text);
  border-color: color-mix(in srgb, var(--severity-critical-text) 40%, transparent);
}
</style>