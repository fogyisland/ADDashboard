<template>
  <AppLayout>
    <h2>AD 域控清单</h2>
    <p class="hint">权威 DC 列表 — agent 自动上报元数据, 站点分配由 admin 手动设置。</p>
    <table class="t">
      <thead>
        <tr>
          <th>DC 名</th><th>所属站点</th><th>Agent 提示</th><th>OS</th>
          <th>角色</th><th>最近发现</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="d in dcs" :key="d.dcName">
          <td><code>{{ d.dcName }}</code></td>
          <td>
            <select :value="d.siteId" @change="onAssign(d, $event.target.value)">
              <option :value="null">未分配</option>
              <option v-for="s in sites" :key="s.id" :value="s.id">{{ s.siteName }}</option>
            </select>
          </td>
          <td><small>{{ d.siteHint || '-' }}</small></td>
          <td>{{ d.osVersion || '-' }}</td>
          <td>
            <span v-if="d.isPdc" class="badge">PDC</span>
            <span v-if="d.isGc" class="badge">GC</span>
            <span v-if="d.isRidMaster" class="badge">RID</span>
            <span v-if="d.isSchemaMaster" class="badge">Schema</span>
            <span v-if="d.isDomainNamingMaster" class="badge">Naming</span>
            <span v-if="d.isInfrastructureMaster" class="badge">Infra</span>
          </td>
          <td>{{ fmt(d.discoveredAt) }}</td>
        </tr>
        <tr v-if="!dcs.length"><td colspan="6" class="empty">暂无 DC — 等待 agent 上报 discovery</td></tr>
      </tbody>
    </table>
  </AppLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import AppLayout from '../../components/AppLayout.vue';
import { adminApi } from '../../api/admin.js';

const sites = ref([]);
const dcs = ref([]);

async function load() {
  const [s, d] = await Promise.all([adminApi.listSitesCatalog(), adminApi.listDcsCatalog()]);
  sites.value = s.data || [];
  dcs.value = d.data || [];
}

async function onAssign(dc, siteId) {
  const id = siteId === '' ? null : Number(siteId);
  await adminApi.assignDcSite(dc.dcName, id);
  await load();
}

function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }

onMounted(load);
</script>

<style scoped>
.t { width: 100%; border-collapse: collapse; background: var(--panel); }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
.t select { background: #0b1220; color: var(--text); border: 1px solid #1e293b; padding: 4px; border-radius: 3px; }
.badge { background: var(--accent); color: #0b1220; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; margin-right: 4px; }
.empty { text-align: center; color: var(--muted); padding: 24px; }
.hint { color: var(--muted); font-size: 12px; margin: 0 0 12px; }
small { color: var(--muted); }
</style>
