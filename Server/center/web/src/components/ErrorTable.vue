<template>
  <table class="err-table">
    <thead>
      <!-- R158.X.116.p (2026-10-23) — 列头由「源 DC / 目标 DC」改为
           「本机 DC / 对端 DC」。原因: __partner_naming__ 类行永远是
           **单向 inbound** (agent_id == dest_dc), 用「源→目标」展示会被
           读成「A 把数据推给 B」, 而实际含义是「A 的上游是 B」。
           数据本身没错 (source_dc=发起方 / dest_dc=接收方, AD 标准语义,
           见 dc-partners-refresh.js:118-134), 误导人的是列头, 所以只改
           列头不交换数据 —— 交换会破坏 dc-partners-refresh.js 读侧和
           (source_dc, dest_dc, naming_context) 唯一键。
           __partner_ports__ 类行是 outbound (source_dc = 本机), 但混在
           同一张表里, 用「本机/对端」对两类都成立, 0 需分支判断。 -->
      <tr><th>本机 DC</th><th>对端 DC</th><th>NC</th><th>状态码</th><th>说明</th><th>持续(分钟)</th><th>最后尝试</th></tr>
    </thead>
    <tbody>
      <tr v-for="(r, i) in rows" :key="i">
        <td>{{ r.sourceDc }}<br/><small>{{ r.sourceSite }}</small></td>
        <td>{{ r.destDc }}<br/><small>{{ r.destSite }}</small></td>
        <td><code>{{ r.namingContext }}</code></td>
        <td><span class="code">{{ r.statusCode }}</span></td>
        <!-- R158.X.116.p 同批修: 原为 r.error_message (下划线), 但后端
             camelRow 已转成 errorMessage (驼峰), 导致报错原文这列恒空。
             字段名两边不一致, 0 报错 0 日志, 纯静默空列。 -->
        <td>{{ explain(r.statusCode) }}<br/><small>{{ r.errorMessage }}</small></td>
        <td>{{ r.durationMinutes ?? '-' }}</td>
        <td>{{ fmt(r.lastAttemptTime) }}</td>
      </tr>
    </tbody>
  </table>
</template>

<script setup>
import { formatDateTime } from '../lib/timezone.js';
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
function fmt(s) { return s ? formatDateTime(s) : '-'; }
</script>

<style scoped>
.err-table { width: 100%; border-collapse: collapse; background: var(--panel); border-radius: 6px; overflow: hidden; }
th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; }
th { background: var(--sidebar-bg); color: var(--muted); font-size: 12px; }
td small { color: var(--muted); font-size: 11px; }
.code { background: var(--red); color: var(--button-fg); padding: 1px 6px; border-radius: 3px; font-weight: 600; }
</style>
