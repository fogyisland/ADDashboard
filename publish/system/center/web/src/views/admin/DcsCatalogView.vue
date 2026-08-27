<template>
  <AdminLayout>
    <h2>AD 域控清单</h2>
    <p class="hint">
      权威 DC 列表 — agent 自动上报元数据, 站点分配由 admin 手动设置。
      5 个 FSMO 角色 + 桥头 DC 标记可直接在表格里切换, 操作会立刻写入数据库并产生审计行。
    </p>
    <div class="actions">
      <button class="bulk" @click="openBulk">批量分配站点</button>
    </div>
    <div v-if="error" class="error-banner">{{ error }}</div>

    <!-- 2026-08-27 round-38: operator directive "AD 域控清单 当对象归类后
         做成组效果，不然成员多看不清" — DCs are grouped by site (with an
         explicit "未分配" group for siteId=null). Each group renders as
         its own bordered card with a coloured header showing the site name
         + DC count. Sites are ordered hub-first (matching the
         site_replication_matrix_all view); within each group DCs are
         ordered bridgehead → FSMO → lex. -->
    <div v-if="!dcs.length && !error" class="empty">暂无 DC — 等待 agent 上报 discovery</div>

    <section v-for="g in groupedDcs" :key="g.key" class="dc-group" :data-test-group="g.key">
      <header class="dc-group-header">
        <span :class="['site-tag', g.siteId ? 'site' : 'unassigned']">{{ g.siteName }}</span>
        <span class="dc-group-count">{{ g.dcs.length }} DC</span>
        <span v-if="g.bridgeheadCount" class="dc-group-bridgehead">桥头 {{ g.bridgeheadCount }}</span>
        <span v-if="g.fsmoCount" class="dc-group-fsmo">FSMO {{ g.fsmoCount }}</span>
      </header>
      <table class="t">
        <thead>
          <tr>
            <th>DC 名</th><th>所属站点</th><th>Agent 提示</th><th>OS</th>
            <th>FSMO 角色</th><th>桥头</th><th>最近发现</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in g.dcs" :key="d.dcName" :class="rowClass(d)" :data-test-row="d.dcName">
            <td><code>{{ d.dcName }}</code></td>
            <td>
              <select :value="d.siteId" @change="onAssign(d, $event.target.value)">
                <option :value="null">未分配</option>
                <option v-for="s in sites" :key="s.id" :value="s.id">{{ s.siteName }}</option>
              </select>
            </td>
            <td><small>{{ d.siteHint || '-' }}</small></td>
            <td>{{ d.osVersion || '-' }}</td>
            <td class="role-cell">
              <!--
                5 FSMO 角色: 每台 DC 同一时刻最多持有一个 Schema / RID / Naming /
                Infra 角色; PDC 是单域单台; GC 可以多台同时持此角色 (任意 DC 都可以是 GC)。
                UI 按"按位 toggle"实现: 操作员对每台 DC 独立打钩, 后端只更新指定列。
              -->
              <button
                v-for="r in ROLES" :key="r.key"
                type="button"
                :class="['role-pill', { on: d[r.key], busy: busyKey === `${d.dcName}:${r.key}` }]"
                :disabled="busyKey === `${d.dcName}:${r.key}`"
                :title="d[r.key] ? `已标记为 ${r.label} — 点击清除` : `标记为 ${r.label}`"
                :data-test="`role-${r.key}-${d.dcName}`"
                @click="toggleFlag(d, r.key)">
                {{ r.label }}
              </button>
            </td>
            <td class="bridgehead-cell">
              <!--
                桥头 DC: 操作员指定的 inter-site replication bridgehead。
                每个站点一台 (UI 不强制; 后端允许任意台, 复制矩阵视图按 is_bridgehead DESC
                + dc_name ASC 选首台)。cyan 配色与 FSMO 角色区分。
              -->
              <button
                type="button"
                :class="['bridgehead-toggle', { on: d.isBridgehead, busy: busyKey === `${d.dcName}:isBridgehead` }]"
                :disabled="busyKey === `${d.dcName}:isBridgehead`"
                :title="d.isBridgehead
                  ? '已指定为桥头 DC — 跨站点复制矩阵视图会以此台为主 — 点击清除'
                  : '指定为桥头 DC (inter-site replication primary)'"
                :data-test="`bridgehead-${d.dcName}`"
                @click="toggleFlag(d, 'isBridgehead')">
                {{ d.isBridgehead ? '桥头' : '未指定' }}
              </button>
            </td>
            <td>{{ fmt(d.discoveredAt) }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <BulkImportDialog
      v-if="bulkOpen"
      title="批量分配站点"
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
import { adminApi } from '../../api/admin.js';

const sites = ref([]);
const dcs = ref([]);
const bulkOpen = ref(false);
// busyKey = "DCNAME:flagKey" — disables the one pill being saved so the
// operator doesn't double-click and trigger two PUTs. Other pills in the
// same row stay clickable.
const busyKey = ref('');
const error = ref('');

const ROLES = [
  { key: 'isPdc',                   label: 'PDC' },
  { key: 'isGc',                    label: 'GC' },
  { key: 'isRidMaster',             label: 'RID' },
  { key: 'isSchemaMaster',          label: 'Schema' },
  { key: 'isDomainNamingMaster',    label: 'Naming' },
  { key: 'isInfrastructureMaster',  label: 'Infra' }
];

const bulkColumns = [
  { key: 'dcName', label: 'DC 名', required: true, aliases: ['dc_name', 'DcName', 'DomainController', 'DC 名'] },
  { key: 'siteName', label: '所属站点 (留空=未分配)', required: false, aliases: ['site_name', 'SiteName', '所属站点', 'site'] }
];

// 2026-08-27 round-38: group DCs by site. Sites ordered hub-first (matching
// site_replication_matrix_all view). Unassigned DCs land in a dedicated
// trailing group so they don't get buried at the top. Within each group
// DCs are sorted bridgehead → any-FSMO → lex by dc_name so the operator's
// eye lands on the load-bearing DC first.
//
// Fallback semantics: when a DC has a siteId that doesn't match any catalog
// entry (e.g. because the operator hasn't loaded /api/admin/sites-catalog
// yet, or because the DC was bulk-assigned to a deleted site), the DC still
// gets its own group keyed by siteId, with the DC's denormalized siteName
// as the group header. This keeps the view robust against partial catalog
// data — the alternative (drop the DC) would silently hide misassigned DCs.
const groupedDcs = computed(() => {
  const siteById = new Map(sites.value.map(s => [s.id, s]));
  const buckets = new Map();
  for (const d of dcs.value) {
    let key, siteName;
    if (d.siteId == null) {
      key = '__unassigned__';
      siteName = '未分配';
    } else {
      const site = siteById.get(d.siteId);
      key = `site:${d.siteId}`;
      siteName = site ? site.siteName : (d.siteName || `Site ${d.siteId}`);
    }
    if (!buckets.has(key)) {
      buckets.set(key, { key, siteId: d.siteId == null ? null : d.siteId, siteName, dcs: [] });
    }
    buckets.get(key).dcs.push(d);
  }
  // Order groups: catalog sites first (hub-first per sites.value order),
  // orphan-site groups (siteId present but no catalog entry) right after,
  // unassigned last.
  const siteOrder = new Map(sites.value.map((s, i) => [s.id, i]));
  const groups = [...buckets.values()];
  groups.sort((a, b) => {
    if (a.key === '__unassigned__') return 1;
    if (b.key === '__unassigned__') return -1;
    const ai = siteOrder.has(a.siteId) ? siteOrder.get(a.siteId) : 1e9;
    const bi = siteOrder.has(b.siteId) ? siteOrder.get(b.siteId) : 1e9;
    if (ai !== bi) return ai - bi;
    return String(a.siteName).localeCompare(String(b.siteName));
  });
  return groups.map(g => buildGroup(g.siteId, g.siteName, g.dcs));
});

function buildGroup(siteId, siteName, list) {
  // Within-group sort: bridgehead first, then any-FSMO (PDC/GC/RID/Schema/
  // Naming/Infra) first, then lex by dc_name.
  const sorted = [...list].sort((a, b) => {
    if (!!a.isBridgehead !== !!b.isBridgehead) return b.isBridgehead ? 1 : -1;
    const aFsmo = ROLES.some(r => a[r.key]) ? 1 : 0;
    const bFsmo = ROLES.some(r => b[r.key]) ? 1 : 0;
    if (aFsmo !== bFsmo) return bFsmo - aFsmo;
    return String(a.dcName).localeCompare(String(b.dcName));
  });
  return {
    key: siteId == null ? '__unassigned__' : `site:${siteId}`,
    siteId,
    siteName,
    dcs: sorted,
    bridgeheadCount: sorted.filter(d => d.isBridgehead).length,
    fsmoCount: sorted.filter(d => ROLES.some(r => d[r.key])).length
  };
}

function rowClass(d) {
  return {
    'dc-row': true,
    'has-bridgehead': !!d.isBridgehead,
    'has-fsmo': ROLES.some(r => d[r.key])
  };
}

async function load() {
  error.value = '';
  try {
    const [s, d] = await Promise.all([adminApi.listSitesCatalog(), adminApi.listDcsCatalog()]);
    sites.value = s.data || [];
    dcs.value = d.data || [];
  } catch (e) {
    error.value = e?.response?.data?.error || '加载失败';
  }
}

function openBulk() { bulkOpen.value = true; }

async function submitBulk(rows) {
  const r = await adminApi.bulkAssignDcs(rows);
  return r.data || {};
}

async function onBulkDone(result) {
  if ((result.assigned || 0) + (result.unassigned || 0) > 0) {
    await load();
    bulkOpen.value = false;
  }
}

async function onAssign(dc, siteId) {
  const id = siteId === '' ? null : Number(siteId);
  await adminApi.assignDcSite(dc.dcName, id);
  await load();
}

// 2026-08-27 round-29: toggle a single flag on one DC.
// The view does optimistic UI for snappy feedback, then awaits the server
// reply. On error, we revert the local state and surface a banner — the
// reload() at the end is the authoritative state sync in case another
// operator toggled concurrently.
async function toggleFlag(dc, flagKey) {
  const key = `${dc.dcName}:${flagKey}`;
  if (busyKey.value) return; // another toggle is in flight
  busyKey.value = key;
  const prev = dc[flagKey];
  const next = !prev;
  // optimistic flip — caller sees immediate visual change
  dc[flagKey] = next;
  try {
    await adminApi.updateDcFlags(dc.dcName, { [flagKey]: next });
    await load(); // sync full row (other flags too — bridgehead sort may have changed upstream)
  } catch (e) {
    dc[flagKey] = prev; // revert on failure
    error.value = e?.response?.data?.error || `${dc.dcName} ${flagKey} 更新失败`;
  } finally {
    if (busyKey.value === key) busyKey.value = '';
  }
}

function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }

onMounted(load);
</script>

<style scoped>
.actions { display: flex; gap: 8px; margin-top: 12px; }
.bulk { background: var(--accent); color: white; }
.empty { text-align: center; color: var(--muted); padding: 24px; }
.hint { color: var(--muted); font-size: 12px; margin: 0 0 12px; }
small { color: var(--muted); }
.error-banner { background: var(--red-bg); color: var(--red); padding: 8px 12px; border-radius: 3px; margin: 8px 0; }

/* 2026-08-27 round-38: per-site group cards. Each group renders as a
   bordered panel with a coloured header — bridgehead/FSMO summary chips
   on the right let the operator scan the catalog without expanding rows. */
.dc-group {
  margin-top: 16px;
  border: 1px solid #1e293b;
  border-radius: 4px;
  background: var(--panel);
  overflow: hidden;
}
.dc-group-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background: #0b1220;
  border-bottom: 1px solid #1e293b;
  font-size: 13px;
  font-weight: 600;
}
.site-tag {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  letter-spacing: 0.04em;
  background: #14532d;
  color: #bbf7d0;
  border: 1px solid #166534;
}
.site-tag.unassigned {
  background: #1e293b;
  color: var(--muted);
  border-color: #334155;
}
.dc-group-count { color: var(--muted); font-size: 12px; font-family: ui-monospace, monospace; }
.dc-group-bridgehead {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  background: #0e7490;
  color: #cffafe;
  font-family: ui-monospace, monospace;
  letter-spacing: 0.04em;
}
.dc-group-fsmo {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  background: rgba(34, 197, 94, 0.15);
  color: #22c55e;
  font-family: ui-monospace, monospace;
  letter-spacing: 0.04em;
}

.t { width: 100%; border-collapse: collapse; background: var(--panel); }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; font-weight: 600; }
.dc-row.has-bridgehead { background: rgba(14, 116, 144, 0.06); }
.dc-row.has-fsmo:not(.has-bridgehead) { background: rgba(34, 197, 94, 0.04); }
.t select { background: #0b1220; color: var(--text); border: 1px solid #1e293b; padding: 4px; border-radius: 3px; }

/* Role pills (FSMO 角色) — same accent color as the old static badge so
   the visual vocabulary doesn't shift; an outline "off" state replaces
   the previous "no badge at all" so the operator can see all 6 slots and
   click to enable. .on = filled (was badge-style); .off = outlined. */
.role-cell { white-space: nowrap; }
.role-pill {
  display: inline-block;
  margin-right: 4px;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  font-family: ui-monospace, monospace;
  background: transparent;
  color: var(--muted);
  border: 1px solid #1e293b;
  cursor: pointer;
  transition: background 80ms linear, color 80ms linear, border-color 80ms linear;
}
.role-pill:hover { border-color: var(--accent); color: var(--text); }
.role-pill.on { background: var(--accent); color: #0b1220; border-color: var(--accent); }
.role-pill.busy, .role-pill:disabled { opacity: 0.6; cursor: wait; }

/* Bridgehead toggle — separate cyan treatment (matches the badge in
   SiteReplicationMatrixAllView.vue so the two views agree on what
   "bridgehead" looks like). */
.bridgehead-cell { white-space: nowrap; }
.bridgehead-toggle {
  padding: 2px 12px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  background: #1e293b;
  color: var(--muted);
  border: 1px solid #334155;
  cursor: pointer;
  transition: background 80ms linear, color 80ms linear, border-color 80ms linear;
}
.bridgehead-toggle:hover { border-color: #0e7490; color: #cffafe; }
.bridgehead-toggle.on {
  background: #0e7490;
  color: #cffafe;
  border-color: #0e7490;
}
.bridgehead-toggle.busy, .bridgehead-toggle:disabled { opacity: 0.6; cursor: wait; }
</style>