<template>
  <table class="agent-table">
    <thead>
      <!-- R114: 第一行=Agent 服务器名称;最后心跳改成最后连接(R114 spec §1);端口状态列出从 Center 服务器到目标 Agent 的端口探测结果 -->
      <tr>
        <th>DC 服务器名称</th>
        <th>状态</th>
        <th>最后连接</th>
        <th>最后心跳</th>
        <th>待处理任务</th>
        <th>Agent 版本</th>
        <th>端口状态</th>
      </tr>
    </thead>
    <tbody>
      <!-- R140 — site-grouped rendering. Backwards-compatible:
           `groups` is the new prop; when it is present, each group
           renders a section-row header followed by that group's agent
           rows. The old `rows` prop is kept for callers that haven't
           migrated (admin/HeartbeatReportMonitorView still uses rows).
           Mode selection is purely presentational — same 7 column
           layout, same badge / formatter helpers below. -->
      <template v-if="groups && groups.length">
        <template v-for="group in groups" :key="group.siteName">
          <tr class="site-section-row" :data-test="`site-section-${group.siteName}`">
            <td colspan="7">
              <span class="site-name">{{ group.siteName }}</span>
              <span class="site-count">({{ group.rows.length }} 台)</span>
            </td>
          </tr>
          <tr v-for="a in group.rows" :key="a.agentId" :data-test="`agent-row-${a.agentId}`">
            <td>{{ a.agentId }}</td>
            <td><span :class="badge(a)">{{ statusText(a) }}</span></td>
            <td>{{ fmt(a.lastConnectAt) }} <small v-if="a.lastConnectAt">(来自中心探测)</small></td>
            <td>{{ fmt(a.lastHeartbeatAt) }} <small>({{ a.secondsSinceHeartbeat ?? '-' }}s)</small></td>
            <td>{{ a.pendingQueueSize }}</td>
            <td>{{ a.agentVersion }}</td>
            <td>
              <template v-if="a.portStatuses && a.portStatuses.length">
                <span
                  v-for="p in a.portStatuses"
                  :key="p.port"
                  :class="['port-badge', portTone(p)]"
                  :title="`${p.label || '未知'} (${p.port}) — ${p.latencyMs ?? '?'}ms, ${p.lastCheckedAt || '-'}`"
                >{{ p.port }}{{ p.latencyMs != null ? ` ${p.latencyMs}ms` : '' }}</span>
              </template>
              <span v-else class="port-empty">—</span>
            </td>
          </tr>
        </template>
      </template>
      <template v-else>
        <tr v-for="a in rows" :key="a.agentId">
          <td>{{ a.agentId }}</td>
          <td><span :class="badge(a)">{{ statusText(a) }}</span></td>
          <td>{{ fmt(a.lastConnectAt) }} <small v-if="a.lastConnectAt">(来自中心探测)</small></td>
          <td>{{ fmt(a.lastHeartbeatAt) }} <small>({{ a.secondsSinceHeartbeat ?? '-' }}s)</small></td>
          <td>{{ a.pendingQueueSize }}</td>
          <td>{{ a.agentVersion }}</td>
          <td>
            <template v-if="a.portStatuses && a.portStatuses.length">
              <span
                v-for="p in a.portStatuses"
                :key="p.port"
                :class="['port-badge', portTone(p)]"
                :title="`${p.label || '未知'} (${p.port}) — ${p.latencyMs ?? '?'}ms, ${p.lastCheckedAt || '-'}`"
              >{{ p.port }}{{ p.latencyMs != null ? ` ${p.latencyMs}ms` : '' }}</span>
            </template>
            <span v-else class="port-empty">—</span>
          </td>
        </tr>
      </template>
    </tbody>
  </table>
</template>

<script setup>
import { formatDateTime } from '../lib/timezone.js';
defineProps({
  // R140 — preferred prop. Each entry: { siteName, rows: AgentRow[] }.
  // Old `rows` is kept for the admin HeartbeatReportMonitorView which
  // still feeds rows directly without grouping.
  groups: { type: Array, default: () => null },
  rows:   { type: Array, default: () => [] }
});
function badge(a) { return a.secondsSinceHeartbeat <= 120 ? 'ok' : 'stale'; }
function statusText(a) { return a.secondsSinceHeartbeat <= 120 ? '在线' : '离线'; }
function fmt(s) { return s ? formatDateTime(s) : '-'; }
function portTone(p) {
  if (!p.ok || p.latencyMs == null) return 'ok-bad';
  if (p.latencyMs < 100) return 'ok-good';
  if (p.latencyMs < 500) return 'ok-warn';
  return 'ok-bad';
}
</script>

<style scoped>
.agent-table { width: 100%; border-collapse: collapse; background: var(--panel); border-radius: 6px; overflow: hidden; }
th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); }
th { background: var(--sidebar-bg); color: var(--muted); font-size: 12px; }
.ok { background: var(--green); color: var(--sidebar-bg); padding: 2px 8px; border-radius: 3px; font-size: 12px; }
.stale { background: var(--red); color: var(--button-fg); padding: 2px 8px; border-radius: 3px; font-size: 12px; }
small { color: var(--muted); }

/* R140 — site section header row, same visual idiom as DcCard's
   site-badge + ServersOverviewView's site-section-title. */
.site-section-row td {
  background: color-mix(in srgb, var(--sidebar-bg) 75%, transparent);
  color: var(--accent);
  font-weight: 700;
  font-size: 13px;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}
.site-section-row .site-name { margin-right: 8px; }
.site-section-row .site-count { color: var(--muted); font-weight: 500; font-size: 12px; font-family: monospace; }

.port-badge {
  display: inline-block;
  padding: 2px 8px;
  margin: 2px;
  border-radius: 4px;
  font-size: 12px;
}
.ok-good { background: var(--green); color: var(--sidebar-bg); }
.ok-warn { background: var(--yellow); color: var(--sidebar-bg); }
.ok-bad { background: var(--red); color: var(--button-fg); }
.port-empty { color: var(--muted); }
</style>