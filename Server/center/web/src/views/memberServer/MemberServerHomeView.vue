<!-- R158.77 (2026-10-11) — member-server 首页. Mirrors ServersOverviewView
     tile-card pattern but for the non-AD fleet. KPI tiles (total / online /
     offline / 重点关注) at top, cards-grid (hostname × site × online dot)
     below. Pure read-only — admin CRUD stays at /admin/member-servers. -->
<template>
  <div class="ms-home">
    <header class="page-header">
      <div class="title-block">
        <h1>总览</h1>
        <p class="subtitle">
          非 AD 服务器（业务端口 + os-baseline 采集）总览 — 在线判定 = 最近 5 分钟有心跳
        </p>
      </div>
      <div class="header-actions">
        <span class="last-update" v-if="lastUpdated">最后更新：{{ formatTime(lastUpdated) }}</span>
        <button class="refresh-btn" :disabled="loading" @click="load" data-test="refresh">刷新</button>
      </div>
    </header>

    <main>
      <div v-if="loading && items.length === 0" class="kpi-skeleton">
        <div v-for="i in 4" :key="i" class="kpi-card skeleton"></div>
      </div>

      <div v-else-if="error" class="error-banner">
        <span>成员服务器概览加载失败</span>
        <button @click="load">重试</button>
      </div>

      <template v-else>
        <section class="kpi-grid" data-test="ms-kpi">
          <article class="kpi-card" data-test="kpi-total">
            <span class="kpi-label">总成员机</span>
            <span class="kpi-value">{{ totals.total }}</span>
            <span class="kpi-sub">含禁用 / 未分配</span>
          </article>
          <article class="kpi-card" :class="{ 'kpi-good': totals.online > 0 }" data-test="kpi-online">
            <span class="kpi-label">在线</span>
            <span class="kpi-value">{{ totals.online }}</span>
            <span class="kpi-sub">5 分钟内心跳</span>
          </article>
          <article class="kpi-card" :class="{ 'kpi-warn': totals.offline > 0 }" data-test="kpi-offline">
            <span class="kpi-label">离线</span>
            <span class="kpi-value">{{ totals.offline }}</span>
            <span class="kpi-sub">超过 5 分钟无心跳</span>
          </article>
          <article class="kpi-card" :class="{ 'kpi-bad': totals.critical > 0 }" data-test="kpi-attention">
            <span class="kpi-label">重点关注</span>
            <span class="kpi-value">{{ totals.critical }}</span>
            <span class="kpi-sub">已禁用 或 从未上报</span>
          </article>
        </section>

        <section class="cards-grid">
          <article
            v-for="row in sortedItems"
            :key="row.hostname"
            class="card"
            :class="cardClass(row)"
            :data-test="`ms-home-card-${row.hostname}`"
          >
            <header class="card-header">
              <div class="card-title">
                <h2 class="host">{{ row.hostname }}</h2>
                <p class="site">
                  <span v-if="row.siteName">{{ row.siteName }}</span>
                  <span v-else class="muted">未分配</span>
                  <span class="dot-sep">·</span>
                  <span class="ip">{{ row.ipAddress || '—' }}</span>
                </p>
              </div>
              <span class="status-badge" :class="badgeClass(row)">{{ badgeLabel(row) }}</span>
            </header>
            <dl class="kv">
              <span class="kv-label">操作系统</span>
              <span class="kv-value">{{ row.osVersion || '—' }}</span>
              <span class="kv-label">Agent 版本</span>
              <span class="kv-value mono">{{ row.agentVersion || '—' }}</span>
              <span class="kv-label">业务端口</span>
              <span class="kv-value">{{ row.portCount }}</span>
              <span class="kv-label">最近心跳</span>
              <span class="kv-value mono">{{ formatRelative(toMs(row.lastHeartbeatAt)) }}</span>
              <span class="kv-label">状态</span>
              <span class="kv-value">{{ row.enabled === false ? '已禁用' : '已启用' }}</span>
            </dl>
          </article>
        </section>

        <div v-if="items.length === 0" class="empty-state">
          暂无成员服务器 — 等待 ad_member_servers 表首次出现数据（部署完成后会自动填充）
        </div>
      </template>
    </main>
  </div>
</template>

<script setup>
// R158.77 — member-server 首页. Reuses AppLayout chrome at the parent
// (MemberServerView.vue) — this sub-view is mounted inside the parent
// router-view so no AppLayout here. Matches /api/dashboard/member-overview
// envelope shape.

import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { memberServerApi } from '../../api/member-server.js';
import { formatDateTimeIso } from '../../lib/timezone.js';

const POLL_INTERVAL_MS = 30 * 1000;

const items = ref([]);     // [{hostname, siteName, ..., online}]
const totals = ref({ total: 0, online: 0, offline: 0, critical: 0 });
const loading = ref(false);
const error = ref(null);
const lastUpdated = ref(null);
let pollHandle = null;

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const r = await memberServerApi.getOverview();
    const payload = r && r.data ? r.data : r;
    items.value = Array.isArray(payload?.items) ? payload.items : [];
    totals.value = payload?.totals || { total: 0, online: 0, offline: 0, critical: 0 };
    lastUpdated.value = new Date();
  } catch (e) {
    error.value = e;
    if (items.value.length === 0) {
      items.value = [];
      totals.value = { total: 0, online: 0, offline: 0, critical: 0 };
    }
  } finally {
    loading.value = false;
  }
}

const sortedItems = computed(() => {
  // online first, then by hostname
  return [...items.value].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return (a.hostname || '').localeCompare(b.hostname || '');
  });
});

function cardClass(row) {
  if (row.enabled === false) return 'card-disabled';
  if (!row.online) return 'card-offline';
  return 'card-online';
}
function badgeClass(row) {
  if (row.enabled === false) return 'badge-disabled';
  if (!row.online) return 'badge-offline';
  return 'badge-online';
}
function badgeLabel(row) {
  if (row.enabled === false) return '禁用';
  if (!row.online) return '离线';
  return '在线';
}

function toMs(v) {
  if (!v) return null;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// R161.11 — 手搓 getFullYear/... 取的是浏览器本地时区 ⇒ 换机器就变;
//   现在统一按显示时区渲染 (默认 Asia/Shanghai ⇒ 与迁移前逐字相同)。
function formatTime(d) {
  return formatDateTimeIso(d, { fallback: '—' });
}

function formatRelative(ms) {
  if (ms == null) return '—';
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

onMounted(() => {
  load();
  pollHandle = setInterval(load, POLL_INTERVAL_MS);
});
onBeforeUnmount(() => {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = null;
});
</script>

<style scoped>
.ms-home { padding: 16px 0; }
.page-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
.title-block h1 { margin: 0 0 4px; font-size: 20px; color: var(--accent); }
.subtitle { margin: 0; font-size: 12px; color: var(--muted); max-width: 720px; }
.header-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.last-update { font-size: 12px; color: var(--muted); font-family: monospace; }
.refresh-btn { padding: 6px 14px; background: var(--accent); color: var(--sidebar-bg); border: none; border-radius: 3px; cursor: pointer; font-weight: 600; font-size: 13px; }
.refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.kpi-skeleton { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
.kpi-skeleton .skeleton { height: 90px; background: linear-gradient(90deg, var(--panel) 0%, color-mix(in srgb, var(--panel) 70%, transparent) 50%, var(--panel) 100%); background-size: 200% 100%; animation: shimmer 1.5s infinite; border-radius: 8px; }
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

.error-banner { padding: 16px; background: color-mix(in srgb, var(--red, var(--danger-bg)) 30%, transparent); border: 1px solid var(--red, var(--danger-bg)); border-radius: 4px; display: flex; align-items: center; gap: 12px; color: var(--text); }
.error-banner button { padding: 4px 12px; background: var(--accent); color: var(--sidebar-bg); border: none; border-radius: 3px; cursor: pointer; font-weight: 600; }

.empty-state { padding: 40px; text-align: center; color: var(--muted); }

.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}
.kpi-card {
  display: flex; flex-direction: column; gap: 4px;
  padding: 14px 16px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  border-left: 4px solid var(--border);
}
.kpi-card.kpi-good { border-left-color: var(--green); }
.kpi-card.kpi-warn { border-left-color: var(--hub-gold); }
.kpi-card.kpi-bad  { border-left-color: var(--severity-critical-text); }
.kpi-label { font-size: 12px; color: var(--muted); }
.kpi-value { font-size: 28px; font-weight: 700; color: var(--text); font-family: monospace; }
.kpi-sub { font-size: 11px; color: var(--muted); }

.cards-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
  display: flex; flex-direction: column; gap: 10px;
  transition: border-color 120ms ease, transform 120ms ease;
}
.card:hover { border-color: var(--accent); transform: translateY(-1px); }
.card.card-online { border-left: 4px solid var(--green); }
.card.card-offline { border-left: 4px solid var(--muted); opacity: 0.85; }
.card.card-disabled { border-left: 4px solid var(--severity-critical-text); opacity: 0.7; }

.card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.card-title .host { margin: 0 0 2px; font-size: 16px; color: var(--text); font-weight: 700; }
.card-title .site { margin: 0; font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 4px; }
.card-title .site .ip { font-family: monospace; }
.card-title .site .dot-sep { color: var(--border); margin: 0 4px; }
.muted { color: var(--muted); }

.status-badge {
  flex-shrink: 0;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.5px;
}
.badge-online  { background: color-mix(in srgb, var(--green) 25%, transparent); color: var(--green); border: 1px solid color-mix(in srgb, var(--green) 50%, transparent); }
.badge-offline { background: color-mix(in srgb, var(--muted) 25%, transparent); color: var(--text); border: 1px solid color-mix(in srgb, var(--muted) 50%, transparent); }
.badge-disabled{ background: color-mix(in srgb, var(--severity-critical-text) 25%, transparent); color: var(--severity-critical-text); border: 1px solid color-mix(in srgb, var(--severity-critical-text) 50%, transparent); }

.kv {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 0;
  font-size: 12px;
}
.kv-label { color: var(--muted); white-space: nowrap; }
.kv-value { color: var(--text); font-weight: 500; min-width: 0; word-break: break-word; }
.kv-value.mono { font-family: ui-monospace, "Cascadia Mono", "Consolas", monospace; font-size: 11px; }
</style>