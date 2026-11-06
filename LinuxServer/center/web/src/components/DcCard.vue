<template>
  <div class="dc-card">
    <header>
      <h3>{{ dc.dcHost }}</h3>
      <span v-if="dc.siteName" class="site-badge">{{ dc.siteName }}</span>
    </header>
    <div class="stat-grid">
      <!-- R151.3 — split "复制伙伴" into two direction-tagged tiles so the
           count is unambiguous against R144 (dashboard inbound view) and
           R151.2 (agent endpoint). The old single OUTBOUND number was
           correct in isolation but disagreed with the rest of the UI; the
           operator flagged "感觉有点不太对" 2026-09-29 because this card
           showed 0 outbound peers for some DCs that the replication log
           view reported as having many inbound partners. -->
      <div class="stat-tile">
        <div class="stat-label">⬇️ 入站伙伴</div>
        <div class="stat-value">{{ dc.inboundPartnersCount }}</div>
        <code class="raw-key">inboundPartnersCount</code>
      </div>
      <div class="stat-tile">
        <div class="stat-label">⬆️ 出战伙伴</div>
        <div class="stat-value">{{ dc.outboundPartnersCount }}</div>
        <code class="raw-key">outboundPartnersCount</code>
      </div>
      <div class="stat-tile">
        <div class="stat-label">用户</div>
        <div class="stat-value">{{ formatCount(dc.usersCount) }}</div>
        <code class="raw-key">usersCount</code>
      </div>
      <div class="stat-tile">
        <div class="stat-label">组</div>
        <div class="stat-value">{{ formatCount(dc.groupsCount) }}</div>
        <code class="raw-key">groupsCount</code>
      </div>
      <!-- R158.44.7.8 (2026-10-05) — operator directive "DC overview 显示
           用户、电脑、服务器数量". Computers + servers are separator
           counters from collect.ps1; the 用户 tile stays put (operator
           "用户保留"). servers is a subset of computers (member servers
           with OperatingSystem like '*Server*'); DC 自身 也 counted. -->
      <div class="stat-tile">
        <div class="stat-label">💻 电脑</div>
        <div class="stat-value">{{ formatCount(dc.computersCount) }}</div>
        <code class="raw-key">computersCount</code>
      </div>
      <div class="stat-tile">
        <div class="stat-label">🖥️ 服务器</div>
        <div class="stat-value">{{ formatCount(dc.serversCount) }}</div>
        <code class="raw-key">serversCount</code>
      </div>
      <div class="stat-tile">
        <div class="stat-label">GPO</div>
        <div class="stat-value">{{ formatCount(dc.gposCount) }}</div>
        <code class="raw-key">gposCount</code>
      </div>
      <div
        class="stat-tile locked-tile"
        :class="lockedClass"
      >
        <template v-if="dc.lockedCount !== null && dc.lockedCount > 0">
          <!-- R131 — jump target changed from /lockout-troubleshooting
               (admin perm gate) to /lockout-accounts?dc=<host> (regular
               user surface). The 前台 /lockout-accounts page lists
               recent lockouts in a 4-column table and pre-filters by
               ?dc= when present. The deep-drill admin troubleshoot
               surface is reachable from the caller-badge clicks inside
               /lockout-accounts (LockoutAccountsView.vue:filterByCaller). -->
          <router-link :to="`/lockout-accounts?dc=${dc.dcHost}`">
            <div class="stat-label">🔒 锁定</div>
            <div class="stat-value">{{ dc.lockedCount }}</div>
            <code class="raw-key">lockedCount</code>
          </router-link>
        </template>
        <template v-else-if="dc.lockedCount === 0">
          <div class="stat-label">🔓 锁定</div>
          <div class="stat-value">0</div>
          <code class="raw-key">lockedCount</code>
        </template>
        <template v-else>
          <div class="stat-label">锁定</div>
          <div class="stat-value">—</div>
          <code class="raw-key">lockedCount</code>
        </template>
      </div>
    </div>
    <footer class="collected">最近采集: {{ formatTs(dc.collectedAt) }}</footer>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { formatDateTime } from '../lib/timezone.js';

const props = defineProps({ dc: { type: Object, required: true } });

const lockedClass = computed(() => {
  if (props.dc.lockedCount === null || props.dc.lockedCount === undefined) return 'locked-unknown';
  if (props.dc.lockedCount > 0) return 'locked-active';
  return 'locked-clean';
});

function formatCount(n) {
  if (n === null || n === undefined) return '—';
  return String(n);
}

function formatTs(s) {
  if (!s) return '—';
  return formatDateTime(s, { fallback: s });
}
</script>

<style scoped>
.dc-card { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 14px 16px; }
.dc-card header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.dc-card h3 { margin: 0; color: var(--accent); font-size: 16px; }
.site-badge { font-size: 11px; padding: 2px 8px; background: var(--border); color: var(--muted); border-radius: 10px; }
/* R158.44.7.9 (2026-10-05) — operator "界面太挤了, 一行最多三列".
   8 tile / 4 列 = 2 行, tile 宽度 ~88px @360px card. 比 repeat(8,1fr) 的
   ~44px 宽一倍, emoji label 不需 ellipsis, 数字不挤压. 比 repeat(3,1fr)
   (3*3=9, 余 1 tile 留空难看) 更整除. */
.stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.stat-tile { background: var(--sidebar-bg); border-radius: 4px; padding: 6px 4px; text-align: center; min-width: 0; overflow: hidden; }
.stat-tile a { color: inherit; text-decoration: none; display: block; }
.stat-label { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stat-value { font-size: 18px; font-weight: 700; color: var(--text); margin: 1px 0; }
/* R151.3.B — narrow-card fix. 8 tiles in one row at 360px card width
   (R158.44.7.8 +2 tiles for 💻 电脑 + 🖥 服务器; was 6 before) means each
   tile is ~44px wide. The raw-key field-name footer was pushing some
   tiles onto a second row (operator "错位" report 2026-09-29) because
   emoji-prefixed labels like "⬇️ 入站伙伴" wrap to 2 lines on narrow widths.
   Hide the raw-key (debug-only) and tighten padding so all 8 tiles fit
   cleanly on one row at 1280-1920px viewport widths. */
.raw-key { display: none; }
.locked-tile.locked-active { background: var(--danger-bg); }
.locked-tile.locked-active .stat-value { color: var(--severity-critical-text); }
.locked-tile.locked-clean { opacity: 0.5; }
.locked-tile.locked-unknown .stat-value { color: var(--muted); }
.collected { margin-top: 10px; font-size: 11px; color: var(--muted); }
</style>
