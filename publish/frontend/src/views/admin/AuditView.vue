<template>
  <AdminLayout>
    <h2>审计日志</h2>
    <table class="t">
      <thead><tr><th>时间</th><th>用户</th><th>动作</th><th>目标</th><th>详情</th></tr></thead>
      <tbody>
        <tr v-for="r in rows" :key="r.id">
          <td>{{ fmt(r.createdAt) }}</td>
          <td>{{ r.userId ?? '-' }}</td>
          <td>
            <div class="action-label">{{ actionLabels[r.action] || r.action }}</div>
            <code class="raw-action">{{ r.action }}</code>
          </td>
          <td>
            <template v-if="targetLabels[r.target]">
              <div class="target-label">{{ targetLabels[r.target] }}</div>
              <code class="raw-target">{{ r.target }}</code>
            </template>
            <template v-else>{{ r.target || '-' }}</template>
          </td>
          <td><pre v-if="r.payload" class="payload">{{ formatPayload(r.payload) }}</pre></td>
        </tr>
      </tbody>
    </table>
  </AdminLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { adminApi } from '../../api/admin.js';
const rows = ref([]);

// Chinese labels for well-known action verbs. The raw snake_case key stays
// visible underneath so audit / SIEM tooling that grep'd the column still works.
const actionLabels = {
  login: '登录',
  login_failed: '登录失败',
  create_user: '创建用户',
  update_user: '修改用户',
  delete_user: '删除用户',
  reset_password: '重置密码',
  update_config: '修改系统配置',
  rollback_config: '回滚配置',
  bulk_import_sites: '批量导入站点',
  bulk_assign_dc_sites: '批量分配 DC 站点',
  apply_migration: '应用迁移',
  reset_failed_migration: '重置失败迁移'
};

const targetLabels = {
  system_config: '系统配置',
  ad_sites: '站点目录',
  ad_dcs: '域控目录',
  schema_migrations: '迁移管理'
};

function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }

function formatPayload(p) {
  if (p == null) return '';
  if (typeof p === 'string') return p;
  return JSON.stringify(p, null, 2);
}

async function load() { rows.value = (await adminApi.getAudit(200)).data; }
onMounted(load);
</script>

<style scoped>
.t { width: 100%; border-collapse: collapse; background: var(--panel); }
.t th, .t td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #1e293b; font-size: 13px; vertical-align: top; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
.action-label, .target-label { font-weight: 600; color: var(--text); }
.raw-action, .raw-target { display: block; font-size: 11px; color: var(--muted); margin-top: 2px; word-break: break-all; }
pre.payload { margin: 0; padding: 6px 8px; background: #0b1220; border: 1px solid #1e293b; border-radius: 3px; font-size: 11px; color: var(--muted); white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow: auto; }
</style>
