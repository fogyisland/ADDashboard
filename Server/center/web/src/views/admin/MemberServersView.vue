<template>
  <AdminLayout>
    <h2>非 AD 服务器</h2>
    <p class="hint">
      已被服务器自动登记或管理员手动登记的成员机 — 列在
      <code>ad_member_servers</code> 表(PK=hostname)。包含 ad-os-baseline
      的内置包绑定 + 告警规则触发。
    </p>

    <div class="actions">
      <button @click="openCreate">+ 新建服务器</button>
      <button class="bulk" @click="openBulk">批量导入</button>
      <button class="refresh" @click="load">刷新</button>
    </div>

    <!-- R158.74 (2026-10-11) — MemberServer 业务端口 tab nav. operator
         "在 MemberServersView 本身加 tab". 2 tab 互斥 (主机列表 /
         端口监听). 不动老 list table 内容, 仅用 v-if 包起来. -->
    <nav class="ms-tabs">
      <button :class="{ active: activeTab === 'hosts' }" @click="activeTab = 'hosts'">主机列表</button>
      <button :class="{ active: activeTab === 'ports' }" @click="activeTab = 'ports'">端口监听</button>
    </nav>

    <div class="filters" v-if="activeTab === 'hosts'">
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

    <table v-if="activeTab === 'hosts'" class="t">
      <thead>
        <tr>
          <th>主机名</th>
          <th>所属站点</th>
          <!-- R158.94 (2026-10-13) — install_root column. Agent self-register
               上报 runtime install path (derived from agent.js __dirname, 不
               写死). 1.0.17 migration 加 install_root NVARCHAR(512) NULL. -->
          <th>安装路径</th>
          <th>IP 地址</th>
          <th>OS 版本</th>
          <th>启用</th>
          <!-- R158.X.115 (2026-10-20) — 生命周期状态列. 退役/暂停的机器**仍
               留在这个表里** (管理列表走 memberServers.list 全量), 否则操作员
               下线后就再也找不到这台机器、无法确认状态。退役 vs 暂停 vs 在线
               三态, 退役是终态。 -->
          <th>状态</th>
          <th>最近心跳</th>
          <th>最近上报</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="m in filteredRows" :key="m.hostname">
          <td><code>{{ m.hostname }}</code></td>
          <td>{{ m.site_name || '-' }}</td>
          <td class="install-root-cell" :title="m.install_root || ''">{{ m.install_root || '-' }}</td>
          <td>{{ m.ip_address || '-' }}</td>
          <td>{{ m.os_version || '-' }}</td>
          <td>
            <span :class="['pill', m.enabled ? 'on' : 'off']">
              {{ m.enabled ? '是' : '否' }}
            </span>
          </td>
          <td>
            <span v-if="m.decommissioned_at" class="pill lifecycle-pill retired"
                  :title="`已于 ${fmt(m.decommissioned_at)} 退役`">已退役</span>
            <span v-else-if="m.monitoring_paused_at" class="pill lifecycle-pill paused"
                  :title="`自 ${fmt(m.monitoring_paused_at)} 起暂停管控`">已暂停</span>
            <span v-else class="pill lifecycle-pill online">在线</span>
          </td>
          <td><small>{{ fmt(m.last_seen_at) }}</small></td>
          <td><small>{{ fmt(m.last_report_at) }}</small></td>
          <td>
            <router-link :to="`/admin/member-servers/${encodeURIComponent(m.hostname)}`" class="link">详情</router-link>
            <button @click="openEdit(m)">编辑</button>
            <!-- R158.X.115 — 生命周期按钮。退役后只保留"详情" (不再显示
                 恢复/暂停, 因为退役是终态); 暂停后显示"恢复管控"。
                 "删除" 保留但语义收窄: 它是物理删除, 不是下线, UI 上明确
                 区分以免操作员误用 (删了 agent 30min 后又会回来)。 -->
            <button v-if="!m.decommissioned_at && !m.monitoring_paused_at"
                    @click="openLifecycle(m, 'pause')">暂停管控</button>
            <button v-if="!m.decommissioned_at && m.monitoring_paused_at"
                    @click="openLifecycle(m, 'resume')">恢复管控</button>
            <button v-if="!m.decommissioned_at"
                    class="danger-link" @click="openLifecycle(m, 'decommission')">下线</button>
            <button v-if="!m.decommissioned_at" @click="onDelete(m)">删除</button>
          </td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td colspan="10" class="empty">暂无成员机 — 点击"新建服务器"或"批量导入"开始</td>
        </tr>
      </tbody>
    </table>

    <!-- R158.X.115 — 生命周期弹窗。action 三态由 openLifecycle 传入。 -->
    <HostLifecycleDialog
      v-if="lifecycleTarget"
      :hostname="lifecycleTarget.hostname"
      :action="lifecycleAction"
      :server="lifecycleTarget"
      @close="lifecycleTarget = null"
      @done="onLifecycleDone"
    />

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

    <!-- R158.74 — 端口监听 tab. admin 手填业务端口. 跟 R158.68
         SystemAlertsView 3 tab 同 pattern (inline v-if 切换). 不引新 view
         文件, 减少前端文件数 + 保持 MemberServersView 单页面焦点.
         port list 按 hostname 分组, 显示每台主机的端口配置. -->
    <section v-if="activeTab === 'ports'" class="ports-tab">
      <header class="ports-header">
        <h3>业务端口监听 (admin 手填)</h3>
        <div class="muted">每台成员服务器配置其业务端口。后续非 AD 部署包上线时, 中心端可增加探测状态字段。</div>
      </header>
      <div class="ports-actions">
        <select v-model="portHostname">
          <option value="">-- 选择主机 --</option>
          <option v-for="m in servers" :key="m.hostname" :value="m.hostname">{{ m.hostname }} ({{ m.ip_address || '无 IP' }})</option>
        </select>
        <select v-model="portServiceType">
          <option value="file-server">文件服务器 (445)</option>
          <option value="web">Web (80, 443)</option>
          <option value="database">数据库</option>
          <option value="app-server">应用服务器</option>
          <option value="custom">自定义</option>
        </select>
        <input v-model.number="portNumber" type="number" min="1" max="65535" placeholder="端口号 1-65535" />
        <input v-model="portNote" type="text" placeholder="备注 (可选)" maxlength="255" />
        <button class="add" :disabled="!canAddPort" @click="addPort">添加</button>
      </div>
      <div class="ports-error" v-if="portError">{{ portError }}</div>
      <div class="ports-list" v-if="Object.keys(portsByHostname).length > 0">
        <div v-for="(ports, hostname) in portsByHostname" :key="hostname" class="port-group">
          <h4>{{ hostname }}</h4>
          <table class="t t-compact">
            <thead>
              <tr><th>端口</th><th>服务类型</th><th>备注</th><th>更新时间</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="p in ports" :key="p.port">
                <td>{{ p.port }}</td>
                <td>{{ serviceTypeLabel(p.service_type) }}</td>
                <td>{{ p.note || '—' }}</td>
                <td>{{ formatTime(p.updated_at) }}</td>
                <td><button class="del" @click="removePort(hostname, p.port)">删除</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="empty-msg" v-else>暂无业务端口配置。点击上方下拉选择主机 + 服务类型 + 端口号, 添加第一个。</div>
    </section>
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import BulkImportDialog from '../../components/BulkImportDialog.vue';
import MemberServerEditDialog from '../../components/MemberServerEditDialog.vue';
// R158.X.115 (2026-10-20) — 主机生命周期弹窗 (退役/暂停/恢复 三合一)。
import HostLifecycleDialog from '../../components/HostLifecycleDialog.vue';
import { adminApi } from '../../api/admin.js';
import { formatDateTime } from '../../lib/timezone.js';

const OFFLINE_MINUTES = 30;

const servers = ref([]);
const sites = ref([]);
const editing = ref(null);
const bulkOpen = ref(false);

const filterOffline = ref(false);
const filterUnassigned = ref(false);
const filterSiteId = ref('');

// R158.X.115 — 生命周期弹窗 state。lifecycleTarget 存整行 (弹窗要读
// decommissioned_at/monitoring_paused_at 显示当前状态)。
const lifecycleTarget = ref(null);
const lifecycleAction = ref('decommission');

function openLifecycle(m, action) {
  lifecycleTarget.value = m;
  lifecycleAction.value = action;
}

// 动作完成后重拉列表 —— 状态列 / 按钮可见性都从服务端数据派生。
async function onLifecycleDone(_e) {
  await load();
}

const bulkColumns = [
  { key: 'hostname', label: '主机名', required: true, aliases: ['Hostname', '主机名', 'host'] },
  { key: 'siteName', label: '站点名 (留空=未分配)', required: false, aliases: ['site_name', 'SiteName', '所属站点', 'site'] },
  // R158.94 (2026-10-13) — install_root bulk import. Agent self-register
  //   自动上报, admin 也可批量手填覆盖 (跟 ipAddress/osVersion 同 shape).
  { key: 'installRoot', label: '安装路径', required: false, aliases: ['install_root', 'InstallRoot', '安装路径'] },
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

// R158.74 (2026-10-11) — 端口监听 tab state + CRUD. 端口数据来自
//   adminApi.listMemberServerPorts (GET /api/admin/member-servers/ports),
//   中心端 MERGE ON (hostname, port) 自动 dedup. 切到 ports tab 时
//   拉一次, 加新主机也触发 (servers watch).
const activeTab = ref('hosts');
const portsByHostname = ref({});
const portHostname = ref('');
const portServiceType = ref('file-server');
const portNumber = ref(null);
const portNote = ref('');
const portError = ref('');

const SERVICE_TYPE_LABELS = {
  'file-server': '文件服务器',
  'web': 'Web',
  'database': '数据库',
  'app-server': '应用服务器',
  'custom': '自定义'
};

function serviceTypeLabel(t) { return SERVICE_TYPE_LABELS[t] || t; }

function formatTime(iso) {
  if (!iso) return '—';
  return formatDateTime(iso, { fallback: '—' });
}

const canAddPort = computed(() => {
  if (!portHostname.value) return false;
  const n = Number(portNumber.value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return false;
  return true;
});

async function loadPorts() {
  try {
    const r = await adminApi.listMemberServerPorts();
    const items = r.data?.items || [];
    const grouped = {};
    for (const p of items) {
      if (!grouped[p.hostname]) grouped[p.hostname] = [];
      grouped[p.hostname].push(p);
    }
    portsByHostname.value = grouped;
  } catch (e) {
    portError.value = '加载端口列表失败: ' + (e?.message || String(e));
  }
}

async function addPort() {
  portError.value = '';
  if (!canAddPort.value) {
    portError.value = '请填写主机名 + 端口号 (1-65535)';
    return;
  }
  try {
    await adminApi.upsertMemberServerPort({
      hostname: portHostname.value,
      port: Number(portNumber.value),
      service_type: portServiceType.value,
      note: portNote.value || null
    });
    portNumber.value = null;
    portNote.value = '';
    await loadPorts();
  } catch (e) {
    portError.value = '添加失败: ' + (e?.response?.data?.error || e?.message || String(e));
  }
}

async function removePort(hostname, port) {
  if (!confirm(`确认删除 ${hostname}:${port} ?`)) return;
  portError.value = '';
  try {
    await adminApi.deleteMemberServerPort(hostname, port);
    await loadPorts();
  } catch (e) {
    portError.value = '删除失败: ' + (e?.response?.data?.error || e?.message || String(e));
  }
}

watch(activeTab, (v) => { if (v === 'ports') loadPorts(); });
watch(servers, () => { if (activeTab.value === 'ports') loadPorts(); });

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

function fmt(s) { return s ? formatDateTime(s) : '-'; }

onMounted(load);
</script>

<style scoped>
.t { width: 100%; border-collapse: collapse; background: var(--panel); margin-top: 12px; }
.actions { display: flex; gap: 8px; margin-top: 12px; }
.bulk { background: var(--border); color: var(--text); border: 1px solid var(--border); }
.refresh { background: var(--panel); color: var(--text); border: 1px solid var(--border); }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); }
.t th { background: var(--sidebar-bg); color: var(--muted); font-size: 12px; }
.pill { padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; }
.pill.on { background: var(--accent); color: var(--sidebar-bg); }
.pill.off { background: var(--border); color: var(--muted); }
.link { color: var(--accent); text-decoration: none; margin-right: 8px; }
.link:hover { text-decoration: underline; }
.empty { text-align: center; color: var(--muted); padding: 24px; }
.hint { color: var(--muted); font-size: 12px; margin: 0 0 12px; }
.hint code { background: var(--sidebar-bg); padding: 1px 4px; border-radius: 2px; }
.filters { display: flex; gap: 16px; align-items: center; margin: 12px 0; font-size: 13px; color: var(--muted); }
.filters label { display: flex; align-items: center; gap: 6px; }
/* R158.X.115 — 生命周期状态 pill。与包状态 pill 区分开, 避免"已退役"被误读
   成"未启用"。 */
.pill.lifecycle-pill { font-size: 11px; padding: 2px 8px; border-radius: 10px; border: 1px solid; white-space: nowrap; }
.pill.lifecycle-pill.online { color: #15803d; border-color: #15803d; }
.pill.lifecycle-pill.paused { color: #b45309; border-color: #b45309; background: #fffbeb; }
.pill.lifecycle-pill.retired { color: #6b7280; border-color: #6b7280; background: #f3f4f6; }
button.danger-link { color: #b91c1c; }
.filters select { background: var(--sidebar-bg); color: var(--text); border: 1px solid var(--border); padding: 4px; border-radius: 3px; }
small { color: var(--muted); }

/* R158.74 (2026-10-11) — 端口 tab + ports-tab section. 不动老 CSS
   block, append-only. tab nav 复用 .admin-entry 配色 (跟 toggle 一致). */
.ms-tabs {
  display: flex;
  gap: 4px;
  margin: 12px 0 16px;
  border-bottom: 1px solid var(--border);
}
.ms-tabs button {
  padding: 8px 18px;
  background: transparent;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 3px 3px 0 0;
  color: var(--muted);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
.ms-tabs button:hover { color: var(--fg); }
.ms-tabs button.active {
  background: var(--sidebar-bg);
  border-color: var(--border);
  color: var(--fg);
  font-weight: 600;
  border-bottom: 1px solid var(--sidebar-bg);
  margin-bottom: -1px;
}
.ports-tab { padding-top: 12px; }
.ports-header { margin-bottom: 12px; }
.ports-header h3 { margin: 0 0 4px; color: var(--fg); font-size: 14px; font-weight: 600; }
.ports-header .muted { color: var(--muted); font-size: 12px; }
.ports-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.ports-actions select,
.ports-actions input {
  padding: 6px 10px;
  background: var(--sidebar-bg);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text);
  font-size: 13px;
}
.ports-actions input[type="number"] { width: 160px; }
.ports-actions input[type="text"] { width: 200px; }
.ports-actions button.add {
  background: rgba(96, 165, 250, 0.14);
  border: 1px solid #3b82f6;
  color: #60a5fa;
  padding: 6px 16px;
  border-radius: 3px;
  cursor: pointer;
  font-weight: 600;
}
.ports-actions button.add:disabled { opacity: 0.5; cursor: not-allowed; }
.ports-error {
  background: rgba(239, 68, 68, 0.10);
  color: #ef4444;
  border: 1px solid #ef4444;
  border-radius: 3px;
  padding: 8px 12px;
  margin-bottom: 12px;
  font-size: 12px;
}
.port-group { margin-bottom: 20px; }
.port-group h4 {
  margin: 0 0 8px;
  color: var(--accent, #60a5fa);
  font-size: 13px;
  font-weight: 600;
}
.t-compact { font-size: 12px; }
.t-compact th, .t-compact td { padding: 6px 10px; }
.t-compact .del {
  background: transparent;
  border: 1px solid #ef4444;
  color: #ef4444;
  padding: 2px 8px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 11px;
}
.t-compact .del:hover { background: rgba(239, 68, 68, 0.10); }
.empty-msg { color: var(--muted); padding: 24px; text-align: center; font-size: 13px; }
</style>
