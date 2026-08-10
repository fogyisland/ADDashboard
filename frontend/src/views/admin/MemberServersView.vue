<template>
  <AdminLayout>
    <h2>非 AD 服务器</h2>
    <p class="hint">
      已被 agent self-register 或 admin 手动登记的成员机 — 列在
      <code>ad_member_servers</code> 表(PK=hostname)。包含 ad-os-baseline
      的内置包绑定 + 告警规则触发。
    </p>

    <div class="actions">
      <button @click="openCreate">+ 新建服务器</button>
      <button class="bulk" @click="openBulk">批量导入</button>
      <button class="refresh" @click="load">刷新</button>
    </div>

    <div class="filters">
      <label>
        <input type="checkbox" v-model="filterOffline" />
        仅离线 (last_seen &gt; {{ OFFLINE_MINUTES }} 分钟)
      </label>
      <label>
        <input type="checkbox" v-model="filterUnassigned" />
        仅未分配站点
      </label>
      <label>
        站点筛选
        <select v-model="filterSiteId">
          <option value="">全部</option>
          <option v-for="s in sites" :key="s.id" :value="String(s.id)">{{ s.siteName }}</option>
        </select>
      </label>
    </div>

    <table class="t">
      <thead>
        <tr>
          <th>主机名</th>
          <th>所属站点</th>
          <th>IP 地址</th>
          <th>OS 版本</th>
          <th>启用</th>
          <th>最近心跳</th>
          <th>最近上报</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="m in filteredRows" :key="m.hostname">
          <td><code>{{ m.hostname }}</code></td>
          <td>{{ m.site_name || '-' }}</td>
          <td>{{ m.ip_address || '-' }}</td>
          <td>{{ m.os_version || '-' }}</td>
          <td>
            <span :class="['pill', m.enabled ? 'on' : 'off']">
              {{ m.enabled ? '是' : '否' }}
            </span>
          </td>
          <td><small>{{ fmt(m.last_seen_at) }}</small></td>
          <td><small>{{ fmt(m.last_report_at) }}</small></td>
          <td>
            <router-link :to="`/admin/member-servers/${encodeURIComponent(m.hostname)}`" class="link">详情</router-link>
            <button @click="openEdit(m)">编辑</button>
            <button @click="onDelete(m)">删除</button>
          </td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td colspan="8" class="empty">暂无成员机 — 点击"新建服务器"或"批量导入"开始</td>
        </tr>
      </tbody>
    </table>

    <MemberServerEditDialog
      v-if="editing"
      :server="editing"
      :sites="sites"
      @save="onSave"
      @cancel="editing = null"
    />

    <BulkImportDialog
      v-if="bulkOpen"
      title="批量导入非 AD 服务器"
      :columns="bulkColumns"
      :submit="submitBulk"
      @close="bulkOpen = false"
      @done="onBulkDone"
    />
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import BulkImportDialog from '../../components/BulkImportDialog.vue';
import MemberServerEditDialog from '../../components/MemberServerEditDialog.vue';
import { adminApi } from '../../api/admin.js';

const OFFLINE_MINUTES = 30;

const servers = ref([]);
const sites = ref([]);
const editing = ref(null);
const bulkOpen = ref(false);

const filterOffline = ref(false);
const filterUnassigned = ref(false);
const filterSiteId = ref('');

const bulkColumns = [
  { key: 'hostname', label: '主机名', required: true, aliases: ['Hostname', '主机名', 'host'] },
  { key: 'siteName', label: '站点名 (留空=未分配)', required: false, aliases: ['site_name', 'SiteName', '所属站点', 'site'] },
  { key: 'ipAddress', label: 'IP 地址', required: false, aliases: ['ip_address', 'IpAddress', 'IP'] },
  { key: 'osVersion', label: 'OS 版本', required: false, aliases: ['os_version', 'OsVersion', 'OS'] }
];

async function load() {
  const [ms, ss] = await Promise.all([
    adminApi.listMemberServers(),
    adminApi.listSitesCatalog().catch(() => ({ data: [] }))
  ]);
  servers.value = ms.data?.items || [];
  sites.value = ss.data || [];
}

const filteredRows = computed(() => {
  const cutoff = Date.now() - OFFLINE_MINUTES * 60_000;
  return servers.value.filter((m) => {
    if (filterUnassigned.value && m.site_id != null) return false;
    if (filterSiteId.value !== '' && String(m.site_id ?? '') !== filterSiteId.value) return false;
    if (filterOffline.value) {
      if (!m.last_seen_at) return true;
      const t = new Date(m.last_seen_at).getTime();
      if (Number.isFinite(t) && t > cutoff) return false;
    }
    return true;
  });
});

function openCreate() {
  editing.value = {
    hostname: '',
    siteId: null,
    ipAddress: '',
    osVersion: '',
    enabled: true,
    mode: 'create'
  };
}

function openEdit(m) {
  editing.value = {
    hostname: m.hostname,
    siteId: m.site_id ?? null,
    ipAddress: m.ip_address ?? '',
    osVersion: m.os_version ?? '',
    enabled: !!m.enabled,
    mode: 'edit'
  };
}

function openBulk() { bulkOpen.value = true; }

async function submitBulk(rows) {
  // Loop approach per brief: call single-row create in a Promise.all, then
  // build an {imported, skipped, errors} result the BulkImportDialog renders.
  // Backend bulk endpoint is NOT added (T13 is frontend only).
  let imported = 0;
  const errors = [];
  await Promise.all(rows.map(async (r, i) => {
    const hostname = (r.hostname || '').trim();
    if (!hostname) {
      errors.push({ rowIndex: i, hostname, reason: 'hostname 必填' });
      return;
    }
    let siteId = null;
    if (r.siteName) {
      const s = sites.value.find(x => x.siteName === r.siteName);
      if (!s) {
        errors.push({ rowIndex: i, hostname, reason: `找不到站点 "${r.siteName}"` });
        return;
      }
      siteId = s.id;
    }
    try {
      await adminApi.createMemberServer({
        hostname,
        siteId,
        ipAddress: r.ipAddress || null,
        osVersion: r.osVersion || null
      });
      imported += 1;
    } catch (e) {
      errors.push({ rowIndex: i, hostname, reason: e.response?.data?.error || e.message || 'unknown' });
    }
  }));
  return { imported, skipped: errors.length, errors };
}

async function onBulkDone(result) {
  if ((result.imported || 0) > 0) {
    await load();
    bulkOpen.value = false;
  }
}

async function onSave(payload) {
  if (payload.mode === 'edit') {
    await adminApi.updateMemberServer(payload.hostname, {
      siteId: payload.siteId,
      ipAddress: payload.ipAddress || null,
      osVersion: payload.osVersion || null,
      enabled: payload.enabled
    });
  } else {
    await adminApi.createMemberServer({
      hostname: payload.hostname,
      siteId: payload.siteId,
      ipAddress: payload.ipAddress || null,
      osVersion: payload.osVersion || null,
      enabled: payload.enabled
    });
  }
  editing.value = null;
  await load();
}

async function onDelete(m) {
  if (!confirm(`删除服务器 ${m.hostname}? FK 级联将清掉它的 package binds / group memberships / alert rules。`)) return;
  await adminApi.deleteMemberServer(m.hostname);
  await load();
}

function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }

onMounted(load);
</script>

<style scoped>
.t { width: 100%; border-collapse: collapse; background: var(--panel); margin-top: 12px; }
.actions { display: flex; gap: 8px; margin-top: 12px; }
.bulk { background: #1e293b; color: var(--text); border: 1px solid #334155; }
.refresh { background: var(--panel); color: var(--text); border: 1px solid #334155; }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
.pill { padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; }
.pill.on { background: var(--accent); color: #0b1220; }
.pill.off { background: #334155; color: var(--muted); }
.link { color: var(--accent); text-decoration: none; margin-right: 8px; }
.link:hover { text-decoration: underline; }
.empty { text-align: center; color: var(--muted); padding: 24px; }
.hint { color: var(--muted); font-size: 12px; margin: 0 0 12px; }
.hint code { background: #0b1220; padding: 1px 4px; border-radius: 2px; }
.filters { display: flex; gap: 16px; align-items: center; margin: 12px 0; font-size: 13px; color: var(--muted); }
.filters label { display: flex; align-items: center; gap: 6px; }
.filters select { background: #0b1220; color: var(--text); border: 1px solid #1e293b; padding: 4px; border-radius: 3px; }
small { color: var(--muted); }
</style>
