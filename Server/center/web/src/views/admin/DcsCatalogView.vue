<template>
  <AdminLayout>
    <h2>AD 域控清单</h2>
    <p class="hint">
      权威 DC 列表 — 由域控自动上报元数据, 站点分配由管理员手动设置。
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
    <div v-if="!dcs.length && !error" class="empty">暂无 DC — 等待域控上报</div>

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
            <th>DC 名</th><th>所属站点</th><th>所属域</th><th>Agent 提示</th><th>OS</th>
            <th>角色</th><th>桥头</th><th>最近发现</th>
            <!-- R158.X.115 (2026-10-20) — 生命周期状态列, 跟 MemberServersView 1:1 平行。
                 DC catalog 是 admin 管理列表, 全量保留退役/暂停行 (否则操作员
                 下线后就找不到这台机器)。终结 / 暂停态的机器其余列仍可见,
                 仅 角色 / 桥头 / 域下拉 禁用 (防误改)。 -->
            <th>状态</th>
            <th>操作</th>
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
            <!--
              R158.41 (2026-10-03) — 行级「所属域」下拉. 数据源 ad_dcs.forest_domain_id
              (migration 053 加的列). 直接 PUT /dcs-catalog/:dc_name/domain 修改, 立即生效.
              TopContextPicker dropdown 直接查这张表 — 不再走三段选择 (assignment +
              domain.dc_hostname + PDC). operator 「直接在 AD 域控清单定义一个下拉列表
              为域清单」的诉求.

              「未分配」选项 = null (R158.37.4 风格, 保留 DC 行只清绑定).
              选项按 forest 分组 (🏢 forestName → domain), 让跨森林的域一眼看清.
            -->
            <td class="domain-cell">
              <select
                :value="d.forestDomainId == null ? '' : d.forestDomainId"
                :disabled="busyKey === `${d.dcName}:domain`"
                @change="onDomainChange(d, $event.target.value)"
                data-test="dc-domain"
              >
                <option value="">未分配</option>
                <template v-for="f in forests" :key="f.id">
                  <optgroup :label="`🌲 ${f.forestName}${f.isDefault ? ' (默认)' : ''}`">
                    <option
                      v-for="dom in domainsByForest[f.id] || []"
                      :key="dom.id"
                      :value="dom.id"
                    >{{ dom.domainName }}{{ dom.role === 'root' ? ' (根域)' : '' }}</option>
                  </optgroup>
                </template>
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
            <!-- R158.X.115 — 退役 vs 暂停 vs 在线 pill。d.decommissionedAt /
                 d.monitoringPausedAt 来自 sql.js:899/4229 listCatalog 的
                 `decommissioned_at AS decommissionedAt, monitoring_paused_at
                 AS monitoringPausedAt` 两列。camelCase 跟 MemberServersView
                 的 snake_case 不同, 因为 DC 走 routes/admin.js map 一次
                 转 camelCase, member 走 SELECT ms.* 保留原列名。 -->
            <td>
              <span v-if="d.decommissionedAt" class="pill lifecycle-pill retired"
                    :title="`已于 ${fmt(d.decommissionedAt)} 退役`">已退役</span>
              <span v-else-if="d.monitoringPausedAt" class="pill lifecycle-pill paused"
                    :title="`自 ${fmt(d.monitoringPausedAt)} 起暂停管控`">已暂停</span>
              <span v-else class="pill lifecycle-pill online">在线</span>
            </td>
            <td class="actions-cell">
              <!-- 在线: 暂停 + 下线 两个动作 -->
              <template v-if="!d.decommissionedAt && !d.monitoringPausedAt">
                <button class="ghost-link"
                        :disabled="busyKey === `${d.dcName}:lifecycle`"
                        @click="openLifecycle(d, 'pause')">暂停管控</button>
                <button class="danger-link"
                        :disabled="busyKey === `${d.dcName}:lifecycle`"
                        @click="openLifecycle(d, 'decommission')">下线</button>
              </template>
              <!-- 暂停: 仅恢复 (resume)。下线按钮禁, 已暂停 → 退役 走恢复后单独操作 -->
              <template v-else-if="d.monitoringPausedAt && !d.decommissionedAt">
                <button class="primary-link"
                        :disabled="busyKey === `${d.dcName}:lifecycle`"
                        @click="openLifecycle(d, 'resume')">恢复管控</button>
              </template>
              <!-- 退役: 终态, 不给任何按钮 (恢复入口在 /admin/server-lifecycle 也禁, 见总览页注释) -->
            </td>
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
    <!-- R158.X.115 (2026-10-20) — 主机生命周期弹窗。kind='dc' 走 DC 端 4 wrapper
         (previewDcLifecycle / pauseDcMonitoring / resumeDcMonitoring /
         decommissionDc)。MemberServersView 是 kind='member', 默认。 -->
    <HostLifecycleDialog
      v-if="lifecycleTarget"
      :hostname="lifecycleTarget.dcName"
      kind="dc"
      :action="lifecycleAction"
      :server="lifecycleTarget"
      @close="lifecycleTarget = null"
      @done="onLifecycleDone"
    />
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import BulkImportDialog from '../../components/BulkImportDialog.vue';
import HostLifecycleDialog from '../../components/HostLifecycleDialog.vue';
import { adminApi, forestRegistryApi } from '../../api/admin.js';

const sites = ref([]);
const dcs = ref([]);
// R158.41 (2026-10-03) — 行级「所属域」下拉数据源 (forest + forest_domain).
// domainsByForest 是按 forestId 索引的域数组, 用于 optgroup 渲染.
const forests = ref([]);
const forestDomains = ref([]);
const domainsByForest = computed(() => {
  const map = {};
  for (const d of forestDomains.value) {
    (map[d.forestId] = map[d.forestId] || []).push(d);
  }
  for (const k of Object.keys(map)) {
    map[k].sort((a, b) => {
      // 根域排在最前, 之后字母序
      if (a.role === 'root' && b.role !== 'root') return -1;
      if (b.role === 'root' && a.role !== 'root') return 1;
      return String(a.domainName).localeCompare(String(b.domainName));
    });
  }
  return map;
});
const bulkOpen = ref(false);
// busyKey = "DCNAME:flagKey" — disables the one pill being saved so the
// operator doesn't double-click and trigger two PUTs. Other pills in the
// same row stay clickable.
const busyKey = ref('');
const error = ref('');
// R158.X.115 (2026-10-20) — 生命周期弹窗目标 + 动作. null = 弹窗不挂载。
// 跟 MemberServersView 的 lifecycleTarget/lifecycleAction 1:1 平行。
const lifecycleTarget = ref(null);
const lifecycleAction = ref('decommission');

function openLifecycle(d, action) {
  // 锁定本行 lifecycle 操作 (复用 busyKey 防止双击多发)。
  busyKey.value = `${d.dcName}:lifecycle`;
  lifecycleAction.value = action;
  lifecycleTarget.value = d;
}

async function onLifecycleDone() {
  // 操作完重拉, 让状态列 / 按钮可见性从服务端数据派生, 不在前端 local 修改。
  const target = lifecycleTarget.value;
  lifecycleTarget.value = null;
  busyKey.value = '';
  if (target?.dcName) await load();
}

// R158.41.1 (2026-10-03) — operator "FSMO 不是目前 GC, 标题实际定义 FSMO
// 数量, 不将 GC 加进去". 拆 ROLES 为两部分:
//   FSMO_ROLES — AD 5 个 FSMO 角色 (PDC/RID/Schema/Naming/Infra), 算 fsmoCount 时只数这些
//   GC_KEY     — Global Catalog 单独 toggle, 不进 FSMO 统计 (森林任意 DC 都能 enable,
//                不是 single-master 概念)
// 列标题 "角色" 涵盖所有 6 个 pill; 但 fsmoCount + has-fsmo + within-group
// sort (PDC/RID/Schema/Naming/Infra 优先) 只看 FSMO_ROLES.
const FSMO_ROLES = [
  { key: 'isPdc',                   label: 'PDC' },
  { key: 'isRidMaster',             label: 'RID' },
  { key: 'isSchemaMaster',          label: 'Schema' },
  { key: 'isDomainNamingMaster',    label: 'Naming' },
  { key: 'isInfrastructureMaster',  label: 'Infra' }
];
const GC_ROLE = { key: 'isGc', label: 'GC' };
// 渲染顺序: FSMO 5 + GC 在末尾
const ROLES = [...FSMO_ROLES, GC_ROLE];
const hasAnyFsmo = (d) => FSMO_ROLES.some(r => d[r.key]);

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
  // Within-group sort: bridgehead first, then any-FSMO (PDC/RID/Schema/
  // Naming/Infra — GC 不算 FSMO) first, then lex by dc_name.
  const sorted = [...list].sort((a, b) => {
    if (!!a.isBridgehead !== !!b.isBridgehead) return b.isBridgehead ? 1 : -1;
    const aFsmo = hasAnyFsmo(a) ? 1 : 0;
    const bFsmo = hasAnyFsmo(b) ? 1 : 0;
    if (aFsmo !== bFsmo) return bFsmo - aFsmo;
    return String(a.dcName).localeCompare(String(b.dcName));
  });
  return {
    key: siteId == null ? '__unassigned__' : `site:${siteId}`,
    siteId,
    siteName,
    dcs: sorted,
    bridgeheadCount: sorted.filter(d => d.isBridgehead).length,
    // R158.41.1 — fsmoCount 仅数 5 个 FSMO 角色 (排除 GC).
    fsmoCount: sorted.filter(d => hasAnyFsmo(d)).length,
    // GC 单独统计 (供群组头 chip 用, 以后想展示 GC 数可直接读).
    gcCount: sorted.filter(d => d.isGc).length
  };
}

function rowClass(d) {
  return {
    'dc-row': true,
    'has-bridgehead': !!d.isBridgehead,
    'has-fsmo': hasAnyFsmo(d),
    'has-gc': !!d.isGc
  };
}

async function load() {
  error.value = '';
  try {
    // R158.41 (2026-10-03) — 并行拉 sites / dcs / forests / domains (森林注册表数据),
    // 让行级下拉 optgroup 一次成型.
    const [s, d, f, fd] = await Promise.all([
      adminApi.listSitesCatalog(),
      adminApi.listDcsCatalog(),
      forestRegistryApi.listForests(),
      // 一次性拉所有森林的 domain. 走 `forestDomainListAll` (后端), or 串行? —
      // 为简化本轮只拉默认森林 + 用户切森林时单独拉. 既然 DcsCatalogView 是
      // admin 全局页, 先 listForests, 再串行 listDomains(forestId) 拉全.
      // 但 n≤10 (operator 一般森林数), 用 Promise.all 不阻塞 UI.
      listAllDomainForestations()
    ]);
    sites.value = Array.isArray(s.data) ? s.data : [];
    // R158.44.1 wire shape fix (2026-10-04) — /api/admin/dcs-catalog now returns
    // { dcs: [...] } (backend wrapped the bare array). 前端以前走 d.data ||
    // [] 在 wrapper 之前返裸数组 OK, 加 wrapper 后 d.data = { dcs: [...] }
    // 是 object, `for (const d of dcs.value)` 抛 "r.value is not iterable".
    // R158.44.7.3 (2026-10-04) — 加 Array.isArray 防御, 避免 dcs.value 被赋
    // 成 {dcs:[...]} 后 groupedDcs computed `for (const d of dcs.value)` 抛
    // "r.value is not iterable". wrapper shape 漂移不会再次炸页面.
    dcs.value = Array.isArray(d.data) ? d.data : (d.data?.dcs || []);
    forests.value = Array.isArray(f.data?.forests) ? f.data.forests : [];
    forestDomains.value = Array.isArray(fd) ? fd : [];
  } catch (e) {
    error.value = e?.response?.data?.error || '加载失败';
  }
}

// listAllDomainForestations — 串行 listDomains(forestId), flatten 成单个数组.
// operator 一般森林数很少 (1-10), 串行足够; 后端 listDomains 走 schema_migrations
// 缓存 + index, 单次 < 5ms.
// R158.44.7.3 (2026-10-04) — Array.isArray 防御. 如果 backend 任一 endpoint
// 改 wire shape (wrapper / 裸数组 漂移), 这里直接兜底返 [], 不再让
// `for (const x of out)` 抛 not iterable 阻断 load().
async function listAllDomainForestations() {
  const out = [];
  let fs = forests.value;
  if (!Array.isArray(fs) || fs.length === 0) {
    const r = await forestRegistryApi.listForests();
    fs = Array.isArray(r.data?.forests) ? r.data.forests : [];
  }
  for (const f of fs) {
    try {
      const r = await forestRegistryApi.listDomains(f.id);
      const doms = Array.isArray(r.data?.domains) ? r.data.domains : [];
      for (const d of doms) out.push({ ...d, forestId: f.id });
    } catch { /* 单森林失败不阻塞其他 */ }
  }
  return out;
}

// R158.41 — 行级「所属域」下拉 PUT handler. 复用 toggleFlag 的 busyKey 模式,
// 只锁定本 DC 的 domain 操作, 其他行不受影响. domainId='' → unbind (null).
async function onDomainChange(dc, rawValue) {
  const key = `${dc.dcName}:domain`;
  if (busyKey.value) return;
  busyKey.value = key;
  const next = rawValue === '' ? null : Number(rawValue);
  const prev = dc.forestDomainId == null ? null : Number(dc.forestDomainId);
  // optimistic flip
  dc.forestDomainId = next;
  try {
    await adminApi.setDcDomain(dc.dcName, next);
  } catch (e) {
    dc.forestDomainId = prev; // revert
    error.value = e?.response?.data?.error || `${dc.dcName} 域绑定失败`;
  } finally {
    if (busyKey.value === key) busyKey.value = '';
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
.bulk { background: var(--sidebar-bg); color: var(--text); border: 1px solid var(--border); }
.bulk:hover:not(:disabled) { background: var(--panel-alt); }
.empty { text-align: center; color: var(--muted); padding: 24px; }
.hint { color: var(--muted); font-size: 12px; margin: 0 0 12px; }
small { color: var(--muted); }
.error-banner { background: var(--red-bg); color: var(--red); padding: 8px 12px; border-radius: 3px; margin: 8px 0; }

/* 2026-08-27 round-38: per-site group cards. Each group renders as a
   bordered panel with a coloured header — bridgehead/FSMO summary chips
   on the right let the operator scan the catalog without expanding rows. */
.dc-group {
  margin-top: 16px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--panel);
  overflow: hidden;
}
.dc-group-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background: var(--sidebar-bg);
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  font-weight: 600;
}
.site-tag {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  letter-spacing: 0.04em;
  background: var(--success-bg);
  color: var(--fsmo-text);
  border: 1px solid var(--fsmo-border);
}
.site-tag.unassigned {
  background: var(--border);
  color: var(--muted);
  border-color: var(--border);
}
.dc-group-count { color: var(--muted); font-size: 12px; font-family: ui-monospace, monospace; }
.dc-group-bridgehead {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--bridgehead-bg);
  color: var(--severity-info-text);
  font-family: ui-monospace, monospace;
  letter-spacing: 0.04em;
}
.dc-group-fsmo {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--green) 15%, transparent);
  color: var(--green);
  font-family: ui-monospace, monospace;
  letter-spacing: 0.04em;
}

.t { width: 100%; border-collapse: collapse; background: var(--panel); }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); }
.t th { background: var(--sidebar-bg); color: var(--muted); font-size: 12px; font-weight: 600; }
.dc-row.has-bridgehead { background: rgba(14, 116, 144, 0.06); }
.dc-row.has-fsmo:not(.has-bridgehead) { background: color-mix(in srgb, var(--green) 4%, transparent); }
.t select { background: var(--sidebar-bg); color: var(--text); border: 1px solid var(--border); padding: 4px; border-radius: 3px; }

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
  background: var(--sidebar-bg);
  color: var(--text);
  border: 1px solid var(--border);
  cursor: pointer;
  transition: background 80ms linear, color 80ms linear, border-color 80ms linear;
}
.role-pill:hover { border-color: var(--accent); color: var(--accent); }
.role-pill.on { background: var(--green); color: var(--button-fg); border-color: var(--green); }
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
  background: var(--sidebar-bg);
  color: var(--text);
  border: 1px solid var(--border);
  cursor: pointer;
  transition: background 80ms linear, color 80ms linear, border-color 80ms linear;
}
.bridgehead-toggle:hover { border-color: var(--accent); color: var(--accent); }
.bridgehead-toggle.on {
  background: var(--accent);
  color: var(--button-fg);
  border-color: var(--accent);
}
.bridgehead-toggle.busy, .bridgehead-toggle:disabled { opacity: 0.6; cursor: wait; }

/* R158.X.115 (2026-10-20) — 退役/暂停行整行灰化, 操作列放行内。
   跟 MemberServersView 的 .lifecycle-pill .pill 类同名同色, 视觉一致。 */
.pill.lifecycle-pill { font-size: 11px; padding: 2px 8px; border-radius: 10px; border: 1px solid; white-space: nowrap; }
.pill.lifecycle-pill.retired { color: #6b7280; border-color: #6b7280; background: #f3f4f6; }
.pill.lifecycle-pill.paused { color: #b45309; border-color: #b45309; background: #fffbeb; }
.pill.lifecycle-pill.online { color: #15803d; border-color: #15803d; }
.actions-cell { white-space: nowrap; }
.actions-cell button { font-size: 12px; padding: 3px 8px; border: none; background: none; cursor: pointer; }
.actions-cell button:disabled { opacity: 0.5; cursor: wait; }
.actions-cell .danger-link { color: #b91c1c; }
.actions-cell .danger-link:hover:not(:disabled) { text-decoration: underline; }
.actions-cell .ghost-link { color: var(--muted); }
.actions-cell .ghost-link:hover:not(:disabled) { color: var(--accent); }
.actions-cell .primary-link { color: var(--accent); }
.actions-cell .primary-link:hover:not(:disabled) { text-decoration: underline; }
</style>