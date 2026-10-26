<!-- R158.69.10 (2026-10-11) — admin members drill-down table.
     Dashboard 概览管理员成员 panel 下钻表格. 读 /api/dashboard/admin-members
     直接拿 sam + display_name (中心 enrich 后填入). 列: SAM / 显示名 / DN / DC / 更新时间. -->
<template>
  <table class="admin-members-table">
    <thead>
      <tr>
        <th>SAM</th>
        <th>显示名</th>
        <th>DN</th>
        <th>DC</th>
        <th>更新时间</th>
      </tr>
    </thead>
    <tbody>
      <tr v-if="members.length === 0 && !loading">
        <td colspan="5" class="muted empty-row">无成员</td>
      </tr>
      <tr v-else v-for="m in members" :key="`${m.sam}-${m.dc_name}`">
        <td><code>{{ m.sam }}</code></td>
        <td>{{ m.display_name || '—' }}</td>
        <td class="muted small">{{ m.distinguished_name || '—' }}</td>
        <td>{{ m.dc_name }}</td>
        <td class="muted small">{{ formatTs(m.collected_at) }}</td>
      </tr>
    </tbody>
    <tfoot v-if="members.length">
      <tr>
        <td colspan="5" class="muted small">
          合计 {{ members.length }} · 有显示名 {{ countHasDn }} · 无 {{ countNoDn }}
        </td>
      </tr>
    </tfoot>
  </table>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  groupName: { type: String, required: true },
  members:   { type: Array,  default: () => [] },
  loading:   { type: Boolean, default: false }
});

const countHasDn = computed(() => props.members.filter(m => m.display_name).length);
const countNoDn  = computed(() => props.members.length - countHasDn.value);

function formatTs(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai', hour12: false
    });
  } catch (_) {
    return String(ts);
  }
}
</script>

<style scoped>
.admin-members-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  background: var(--panel, #1a1d23);
  border: 1px solid var(--border, #2c2f36);
  border-radius: 6px;
  overflow: hidden;
}
.admin-members-table th,
.admin-members-table td {
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid var(--border, #2c2f36);
  color: var(--fg, #e5e7eb);
}
.admin-members-table th {
  background: var(--sidebar-bg, #14161b);
  color: var(--muted, #9ca3af);
  font-weight: 500;
  font-size: 12px;
}
.admin-members-table td code {
  background: var(--sidebar-bg, #14161b);
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}
.admin-members-table tfoot td {
  background: var(--sidebar-bg, #14161b);
  border-bottom: 0;
}
.admin-members-table tr:last-child td {
  border-bottom: 0;
}
.muted { color: var(--muted, #9ca3af); }
.small { font-size: 12px; }
.empty-row { text-align: center; padding: 16px 10px; }
</style>