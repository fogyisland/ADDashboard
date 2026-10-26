<template>
  <div class="member-admin-groups-table">
    <table class="data-table">
      <thead>
        <tr>
          <th>主机</th>
          <th>组</th>
          <th>成员</th>
          <th>类</th>
          <th>来源</th>
          <th>启用</th>
          <th>显示名</th>
          <th>更新时间</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, i) in rows" :key="`${row.hostname}-${row.group_name}-${row.member_sid}-${i}`">
          <td><code>{{ row.hostname }}</code></td>
          <td>{{ row.group_name }}</td>
          <td><code>{{ row.member_name || row.member_sid }}</code></td>
          <td>{{ row.member_class || '—' }}</td>
          <td>{{ row.principal_source || '—' }}</td>
          <td>
            <span :class="['pill', row.is_enabled === 1 ? 'pill-ok' : row.is_enabled === 0 ? 'pill-off' : 'pill-na']">
              {{ row.is_enabled === 1 ? '启用' : row.is_enabled === 0 ? '禁用' : '—' }}
            </span>
          </td>
          <td>{{ row.display_name || '—' }}</td>
          <td>{{ formatTime(row.collected_at) }}</td>
        </tr>
        <tr v-if="!rows || rows.length === 0">
          <td colspan="8" class="empty">暂无数据 — 等待首次采集 (每 24 小时一次) 或点击刷新</td>
        </tr>
      </tbody>
    </table>
    <div v-if="rows && rows.length > 0" class="footer">
      合计 {{ rows.length }} · 启用 {{ enabledCount }} · 禁用 {{ disabledCount }} · 无显示名 {{ noDisplayNameCount }}
    </div>
  </div>
</template>

<script>
export default {
  name: 'MemberAdminGroupsTable',
  props: {
    rows: { type: Array, default: () => [] }
  },
  computed: {
    enabledCount() {
      return (this.rows || []).filter(r => r.is_enabled === 1).length;
    },
    disabledCount() {
      return (this.rows || []).filter(r => r.is_enabled === 0).length;
    },
    noDisplayNameCount() {
      return (this.rows || []).filter(r => !r.display_name).length;
    }
  },
  methods: {
    formatTime(t) {
      if (!t) return '—';
      try {
        return new Date(t).toLocaleString('zh-CN', { hour12: false });
      } catch {
        return String(t);
      }
    }
  }
};
</script>

<style scoped>
.member-admin-groups-table { overflow-x: auto; }
.data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.data-table th, .data-table td { padding: 6px 10px; border-bottom: 1px solid #2a3346; text-align: left; }
.data-table th { background: #1a2235; color: #aab4c5; font-weight: 500; }
.data-table tbody tr:hover { background: #1a2235; }
.data-table code { color: #4ea1ff; font-size: 12px; }
.empty { text-align: center; color: #6b7280; padding: 24px; }
.footer { margin-top: 8px; font-size: 12px; color: #6b7280; }
.pill { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; }
.pill-ok { background: #14532d; color: #86efac; }
.pill-off { background: #7f1d1d; color: #fca5a5; }
.pill-na { background: #374151; color: #9ca3af; }
</style>
