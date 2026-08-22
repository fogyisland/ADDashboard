<template>
  <AdminLayout>
    <h2>AD 站点清单</h2>
    <p class="hint">权威站点列表 — 由 admin 手动维护, DC 通过 ad_dcs.site_id 关联。</p>
    <div class="actions">
      <button @click="openCreate">+ 新建站点</button>
      <button class="bulk" @click="openBulk">批量导入</button>
    </div>
    <table class="t">
      <thead>
        <tr><th>站点名</th><th>区域</th><th>枢纽</th><th>说明</th><th>DC 数</th><th>操作</th></tr>
      </thead>
      <tbody>
        <tr v-for="s in sites" :key="s.id">
          <td><code>{{ s.siteName }}</code></td>
          <td>{{ s.regionCode || '-' }}</td>
          <td><span v-if="s.isHub" class="hub">HUB</span></td>
          <td>{{ s.description || '-' }}</td>
          <td>{{ s.dcCount }}</td>
          <td>
            <button @click="openEdit(s)">编辑</button>
            <button @click="onDelete(s)">删除</button>
          </td>
        </tr>
        <tr v-if="!sites.length"><td colspan="6" class="empty">暂无站点 — 点击"新建站点"开始</td></tr>
      </tbody>
    </table>
    <SiteEditModal v-if="editing" :site="editing" @save="onSave" @cancel="editing = null" />
    <BulkImportDialog
      v-if="bulkOpen"
      title="批量导入站点"
      :columns="bulkColumns"
      :submit="submitBulk"
      @close="bulkOpen = false"
      @done="onBulkDone"
    />
  </AdminLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import SiteEditModal from '../../components/SiteEditModal.vue';
import BulkImportDialog from '../../components/BulkImportDialog.vue';
import { adminApi } from '../../api/admin.js';

const sites = ref([]);
const editing = ref(null);
const bulkOpen = ref(false);

const bulkColumns = [
  { key: 'siteName', label: '站点名', required: true, aliases: ['site_name', 'SiteName', '站点名'] },
  { key: 'regionCode', label: '区域', required: false, aliases: ['region_code', 'RegionCode', '区域代码'] },
  { key: 'isHub', label: '枢纽 (0/1)', required: false, aliases: ['is_hub', 'IsHub', '枢纽'] },
  { key: 'description', label: '说明', required: false, aliases: ['Description', '说明', 'desc'] }
];

async function load() {
  const r = await adminApi.listSitesCatalog();
  sites.value = r.data || [];
}

function openCreate() { editing.value = { id: null, siteName: '', regionCode: '', isHub: false, description: '' }; }
function openEdit(s) { editing.value = { ...s }; }
function openBulk() { bulkOpen.value = true; }

async function submitBulk(rows) {
  const r = await adminApi.bulkImportSites(rows);
  return r.data || {};
}

async function onBulkDone(result) {
  if (result.imported > 0 || result.skipped === 0) {
    await load();
    bulkOpen.value = false;
  }
}

async function onSave(payload) {
  if (payload.id) {
    await adminApi.updateSite(payload.id, payload);
  } else {
    await adminApi.createSite(payload);
  }
  editing.value = null;
  await load();
}

async function onDelete(s) {
  if (!confirm(`删除站点 ${s.siteName} ? 关联的 DC 将变为"未分配"。`)) return;
  await adminApi.deleteSite(s.id);
  await load();
}

onMounted(load);
</script>

<style scoped>
.t { width: 100%; border-collapse: collapse; background: var(--panel); margin-top: 12px; }
.actions { display: flex; gap: 8px; margin-top: 12px; }
.bulk { background: #1e293b; color: var(--text); border: 1px solid #334155; }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
.hub { background: var(--accent); color: #0b1220; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; }
.empty { text-align: center; color: var(--muted); padding: 24px; }
.hint { color: var(--muted); font-size: 12px; margin: 0 0 12px; }
</style>
