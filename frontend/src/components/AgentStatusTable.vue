<template>
  <table class="agent-table">
    <thead>
      <tr><th>Agent</th><th>状态</th><th>最后心跳</th><th>最后上报</th><th>队列</th><th>版本</th></tr>
    </thead>
    <tbody>
      <tr v-for="a in rows" :key="a.agentId">
        <td>{{ a.agentId }}</td>
        <td><span :class="badge(a)">{{ statusText(a) }}</span></td>
        <td>{{ fmt(a.lastHeartbeatAt) }} <small>({{ a.secondsSinceHeartbeat ?? '-' }}s)</small></td>
        <td>{{ fmt(a.lastReportAt) }} <small>{{ a.lastReportStatus }}</small></td>
        <td>{{ a.pendingQueueSize }}</td>
        <td>{{ a.agentVersion }}</td>
      </tr>
    </tbody>
  </table>
</template>

<script setup>
defineProps({ rows: { type: Array, default: () => [] } });
function badge(a) { return a.secondsSinceHeartbeat <= 120 ? 'ok' : 'stale'; }
function statusText(a) { return a.secondsSinceHeartbeat <= 120 ? '在线' : '离线'; }
function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }
</script>

<style scoped>
.agent-table { width: 100%; border-collapse: collapse; background: var(--panel); border-radius: 6px; overflow: hidden; }
th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; }
th { background: #0b1220; color: var(--muted); font-size: 12px; }
.ok { background: var(--green); color: #0b1220; padding: 2px 8px; border-radius: 3px; font-size: 12px; }
.stale { background: var(--red); color: white; padding: 2px 8px; border-radius: 3px; font-size: 12px; }
small { color: var(--muted); }
</style>
