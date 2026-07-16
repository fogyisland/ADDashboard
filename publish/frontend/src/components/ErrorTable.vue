<template>
  <table class="err-table">
    <thead>
      <tr><th>源 DC</th><th>目标 DC</th><th>NC</th><th>状态码</th><th>说明</th><th>持续(分钟)</th><th>最后尝试</th></tr>
    </thead>
    <tbody>
      <tr v-for="(r, i) in rows" :key="i">
        <td>{{ r.sourceDc }}<br/><small>{{ r.sourceSite }}</small></td>
        <td>{{ r.destDc }}<br/><small>{{ r.destSite }}</small></td>
        <td><code>{{ r.namingContext }}</code></td>
        <td><span class="code">{{ r.statusCode }}</span></td>
        <td>{{ explain(r.statusCode) }}<br/><small>{{ r.error_message }}</small></td>
        <td>{{ r.durationMinutes ?? '-' }}</td>
        <td>{{ fmt(r.lastAttemptTime) }}</td>
      </tr>
    </tbody>
  </table>
</template>

<script setup>
defineProps({ rows: { type: Array, default: () => [] } });
const CODES = {
  1722: 'RPC 服务器不可用 - 检查防火墙 / 135-139,445 端口',
  8452: '复制上下文不存在 - 可能命名上下文被删除',
  8453: '复制访问被拒绝 - 检查复制权限 / 站点链路',
  1311: '未找到源服务器对象 - DNS 解析问题',
  1864: '复制对象信息不可用 - 等待下一次同步',
  5:   '访问被拒绝 - 检查账户权限'
};
function explain(code) { return CODES[code] || '参见 Windows 错误码参考'; }
function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }
</script>

<style scoped>
.err-table { width: 100%; border-collapse: collapse; background: var(--panel); border-radius: 6px; overflow: hidden; }
th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; vertical-align: top; }
th { background: #0b1220; color: var(--muted); font-size: 12px; }
td small { color: var(--muted); font-size: 11px; }
.code { background: #ef4444; color: white; padding: 1px 6px; border-radius: 3px; font-weight: 600; }
</style>
