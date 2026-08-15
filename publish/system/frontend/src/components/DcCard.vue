<template>
  <div class="dc-card">
    <header>
      <h3>{{ dc.dcHost }}</h3>
      <span v-if="dc.siteName" class="site-badge">{{ dc.siteName }}</span>
    </header>
    <div class="stat-grid">
      <div class="stat-tile">
        <div class="stat-label">复制伙伴</div>
        <div class="stat-value">{{ dc.partnersCount }}</div>
        <code class="raw-key">partnersCount</code>
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
          <router-link :to="`/lockout-troubleshooting?dc=${dc.dcHost}`">
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
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString();
}
</script>

<style scoped>
.dc-card { background: var(--panel); border: 1px solid #1e293b; border-radius: 6px; padding: 14px 16px; }
.dc-card header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.dc-card h3 { margin: 0; color: var(--accent); font-size: 16px; }
.site-badge { font-size: 11px; padding: 2px 8px; background: #1e293b; color: var(--muted); border-radius: 10px; }
.stat-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
.stat-tile { background: #0b1220; border-radius: 4px; padding: 8px 10px; text-align: center; }
.stat-tile a { color: inherit; text-decoration: none; display: block; }
.stat-label { font-size: 12px; color: var(--muted); }
.stat-value { font-size: 22px; font-weight: 700; color: var(--text); margin: 2px 0; }
.raw-key { font-size: 10px; color: var(--muted); }
.locked-tile.locked-active { background: #7f1d1d; }
.locked-tile.locked-active .stat-value { color: #fecaca; }
.locked-tile.locked-clean { opacity: 0.5; }
.locked-tile.locked-unknown .stat-value { color: var(--muted); }
.collected { margin-top: 10px; font-size: 11px; color: var(--muted); }
</style>
