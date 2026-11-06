<!--
  R158.40 (2026-10-03) — TopContextPicker.vue
  R158.41 (2026-10-03) — DC dropdown 主路径改走 listDcsByDomain (ad_dcs.forest_domain_id)
  替代 R158.40 三段选择 (assignment + domainField + pdc).
  R158.41.2 (2026-10-03) — 默认域选择策略: 跨域并发探测 DC 数, 优先有 DC 的域.
  R158.41 sites (2026-10-03) — 加第 4 级 📍 站点 dropdown (4 级: 🌲 森林 → 🏢 域 → 📍 站点 → 🖥 DC).
  后端 dcs.listByDomain JOIN ad_sites 一次返 siteId+siteName, 前端按 siteId 分组出 sites 列表.
  Operator directive "在日常管理的 DC 前面加上站点".

  R158.43.2 (2026-10-04) — DC 按站点过滤 + onSiteChange 自动 emit PDC.
  operator 反馈: "顶部选了站点 DC 没依据站点筛选". 之前 DC dropdown 列全域 DC
  (dcs prop 是全集), 切站点 UI 看起来无变化 (100+ DC 域). 修:
  1. picker 内部 computed filteredDcsBySite 按 localSiteId 切片, DC dropdown
     + empty hint + 纠正 watch 都从 filtered 走, 父组件 dcs prop 不变.
  2. onSiteChange 时立即按新 siteId 算 PDC, dcHostname 一并 emit 父组件,
     父级 topContext 即时同步, OU 树跟着切 (避免之前 emit 空 + 父级 OU 清空
     + picker UI 显示 PDC 但 OU 空的"半切"中间态).

  ADUC 顶部 4 级 dropdown: 🌲 森林 → 🏢 域 → 📍 站点 → 🖥 服务器 (DC).

  Props:
    modelValue: { forestId, domainId, siteId, dcHostname } | null
    forests:    Array<{ id, forestName, isDefault }>
    domains:    Array<{ id, domainName, role, syncEnabled }>
    sites:      Array<{ id, name, dcCount }>   — R158.41 新增, 由父组件 loadDomainSites 填充
    dcs:        Array<{ hostname, isPdc?, siteId?, siteName?, source }>
                  source === 'adDcsDomainBind' = R158.41 主路径, 其它兜底
    emptyHint:  string — DC 选完后空时给的提示 (默认: '该域未绑定 DC, 请去 AD 域控清单绑定')

  Emits:
    update:modelValue({ forestId, domainId, siteId, dcHostname })

  数据源:
    forests  — forestRegistryApi.listForests()
    domains  — forestRegistryApi.listDomains(forestId)
    sites    — 父组件 loadDomainSites(domainId) 按 dcs-catalog/by-domain 返回的 dcs 分组
    dcs      — adminApi.listDcsByDomain(domainId) (R158.41 主路径)

  默认值策略 (R158.37.4 — 根域 = 森林 + R158.41.2 — 有 DC 的优先):
    forest   — isDefault=true → 否则 first
    domain   — role='root'    → 否则 first (但父组件 DailyOpsView.loadDomains 已经跨域并发探测
                                "第一个有 DC 的域" 作默认 — picker 这里维持 root 优先作为兜底)
    site     — dcCount > 0 的第一个 → 否则 first   — R158.41 sites
    dc       — isPdc=true     → 否则 first (R158.41 默认按 isPdc DESC, dc_name 排)

  DC 选完后空时, 显示 emptyHint + 跳 AD 域控清单的快捷按钮.

  持久 lesson (R158.37.3): 整文件 Write, 纯 UTF-8 无 BOM.
-->
<template>
  <div class="top-ctx-picker" data-test="top-context-picker">
    <label class="ctx-row">
      <span class="ctx-icon">🌲</span>
      <span class="ctx-label">森林:</span>
      <select
        :value="localForestId"
        data-test="top-forest-select"
        @change="onForestChange"
      >
        <option v-if="forests.length === 0" :value="null" disabled>暂无森林</option>
        <option
          v-for="f in forests"
          :key="f.id"
          :value="f.id"
        >{{ f.forestName }}{{ f.isDefault ? ' (默认)' : '' }}</option>
      </select>
    </label>

    <label class="ctx-row">
      <span class="ctx-icon">🏢</span>
      <span class="ctx-label">域:</span>
      <select
        :value="localDomainId"
        data-test="top-domain-select"
        :disabled="!localForestId || domains.length === 0"
        @change="onDomainChange($event)"
      >
        <option v-if="!localForestId" :value="null" disabled>选森林</option>
        <option v-else-if="domains.length === 0" :value="null" disabled>暂无域</option>
        <option
          v-for="d in domains"
          :key="d.id"
          :value="d.id"
        >{{ d.domainName }}{{ d.role === 'root' ? ' (根域)' : '' }}{{ d.syncEnabled === false ? ' · 未启用同步' : '' }}</option>
      </select>
    </label>

    <!-- R158.41 sites (2026-10-03) — 第 4 级 dropdown: 站点. -->
    <label class="ctx-row">
      <span class="ctx-icon">📍</span>
      <span class="ctx-label">站点:</span>
      <select
        :value="localSiteId"
        data-test="top-site-select"
        :disabled="!localDomainId || sites.length === 0"
        @change="onSiteChange"
      >
        <option v-if="!localDomainId" :value="null" disabled>选域</option>
        <option v-else-if="sites.length === 0" :value="null" disabled>暂无站点</option>
        <option
          v-for="s in sites"
          :key="s.id"
          :value="s.id"
        >{{ s.name }} <small v-if="s.dcCount > 0">({{ s.dcCount }} DC)</small></option>
      </select>
    </label>

    <label class="ctx-row">
      <span class="ctx-icon">🖥</span>
      <span class="ctx-label">DC:</span>
      <select
        :value="localDc"
        data-test="top-dc-select"
        :disabled="!localSiteId || filteredDcsBySite.length === 0"
        @change="onDcChange"
      >
        <option v-if="!localSiteId" :value="''" disabled>选站点</option>
        <option v-else-if="filteredDcsBySite.length === 0" :value="''" disabled>该站点暂无 DC</option>
        <option
          v-for="d in filteredDcsBySite"
          :key="d.hostname"
          :value="d.hostname"
        >{{ d.hostname }}{{ d.isPdc ? ' (PDC)' : '' }}{{ d.source === 'adDcsDomainBind' ? '' : ' · ' + sourceLabel(d.source) }}</option>
      </select>
    </label>
    <!-- R158.41 — DC 选完后空时给 operator 提示 + 跳 DcsCatalogView 快捷按钮.
         R158.43.2 (2026-10-04) — 改为按 siteId 过滤后空才提示, 避免 100+ DC 域里
         没有当前 site 的 DC 时仍误判为空. -->
    <span
      v-if="localSiteId && filteredDcsBySite.length === 0"
      class="ctx-empty-hint"
      data-test="dc-empty-hint"
    >
      ⚠ {{ emptyHint }} · <router-link to="/admin/dcs-catalog">去 AD 域控清单</router-link>
    </span>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';

const props = defineProps({
  modelValue: {
    type: Object,
    default: () => null,
    // 期望 { forestId, domainId, siteId, dcHostname } 4 元组
  },
  forests: { type: Array, default: () => [] },
  domains: { type: Array, default: () => [] },
  sites:   { type: Array, default: () => [] },   // R158.41 sites
  dcs:     { type: Array, default: () => [] },
  emptyHint: {
    type: String,
    default: '该域未绑定 DC, 请去 AD 域控清单绑定'
  }
});
const emit = defineEmits(['update:modelValue']);

// 本地 ref: 维护 forest/domain/site/dc 四态选择, 受 modelValue 同步.
const localForestId = ref(props.modelValue?.forestId ?? null);
const localDomainId = ref(props.modelValue?.domainId ?? null);
const localSiteId   = ref(props.modelValue?.siteId ?? null);   // R158.41 sites
const localDc       = ref(props.modelValue?.dcHostname ?? '');

// R158.43.2 (2026-10-04) — DC 按选中 siteId 过滤后显示.
// operator 反馈 "选了站点 DC 没有依据站点筛选". 之前 dcs prop 直接列全域 DC
// (由父组件 loadDomainSites 一次性填入), 100+ DC 域里切站点时无法体现 site 维度.
// 解决: picker 内部 computed 按 localSiteId 切片, DC dropdown + 纠正 watch
// 都从 filteredDcsBySite 走, 不动 dcs prop 形态 (loadDomainSites 不改).
const filteredDcsBySite = computed(() => {
  if (!localSiteId.value) return [];
  return props.dcs.filter(d => (d.siteId ?? 'unassigned') === localSiteId.value);
});

// 父组件 modelValue 变化时同步到本地 (例如父组件 reset 选择).
watch(() => props.modelValue, (v) => {
  if (!v) {
    localForestId.value = null;
    localDomainId.value = null;
    localSiteId.value = null;
    localDc.value = '';
    return;
  }
  localForestId.value = v.forestId ?? null;
  localDomainId.value = v.domainId ?? null;
  localSiteId.value   = v.siteId ?? null;
  localDc.value       = v.dcHostname ?? '';
});

// 列表变化时尝试纠正: 当前选中不在新列表 → 选默认 (first/default).
// R158.45.34 (2026-10-06) — operator "默认进入 OU 树空, 必须按顺序选":
//   之前 forest/domain 自动选只改 local ref 不 emit → 父组件 topContext 同步不上
//   → OU 树 v-if=topContext?.dcHostname 不满足 → 默认看不到 OU 树. 修: 自动选
//   forest/domain/site 都 emit update:modelValue, 让父级 topContext 完整同步 4 元组.
watch(() => props.forests, (fs) => {
  if (fs.length === 0) {
    if (localForestId.value !== null) {
      localForestId.value = null;
      emit('update:modelValue', { forestId: null, domainId: null, siteId: null, dcHostname: '' });
    }
    return;
  }
  if (!localForestId.value || !fs.some(f => f.id === localForestId.value)) {
    const def = fs.find(f => f.isDefault) || fs[0];
    localForestId.value = def.id;
    emit('update:modelValue', { forestId: def.id, domainId: null, siteId: null, dcHostname: '' });
  }
});
watch(() => props.domains, (ds) => {
  if (!localForestId.value || ds.length === 0) {
    if (localDomainId.value !== null) {
      localDomainId.value = null;
      emit('update:modelValue', {
        forestId: localForestId.value,
        domainId: null, siteId: null, dcHostname: ''
      });
    }
    return;
  }
  if (!localDomainId.value || !ds.some(d => d.id === localDomainId.value)) {
    // R158.41.2 — 默认域 root 优先; 父组件 loadDomains 已做跨域探测默认选「有 DC 的域」,
    //   picker 这里维持 root 优先作为兜底.
    const root = ds.find(d => d.role === 'root') || ds[0];
    localDomainId.value = root.id;
    emit('update:modelValue', {
      forestId: localForestId.value,
      domainId: root.id,
      siteId: null,
      dcHostname: ''
    });
  }
});
// R158.41 sites (2026-10-03) — sites 列表变化时纠正 site 选择.
// R158.45.34 (2026-10-06) — operator "默认进入 OU 树空, 必须按顺序选":
//   之前这里自动选默认 site 但只改 localSiteId 不 emit → 父组件 topContext.siteId
//   永远空 → filteredDcsBySite 永远空 → 不会触发 dc emit. 修: 自动选 site 后
//   **立即按新 siteId 算 PDC 并 emit**, 让父级 topContext 同步 4 元组, OU 树
//   watch trigger dcHostname 满足, 树显示.
watch(() => props.sites, (ss) => {
  if (!localDomainId.value || ss.length === 0) {
    if (localSiteId.value !== null) {
      localSiteId.value = null;
      localDc.value = '';
      emit('update:modelValue', {
        forestId: localForestId.value,
        domainId: localDomainId.value,
        siteId: null,
        dcHostname: ''
      });
    }
    return;
  }
  if (!localSiteId.value || !ss.some(s => s.id === localSiteId.value)) {
    // 默认 site: 第一个 dcCount > 0 的 (R158.41.2 思想延续 — 选有资源的).
    const firstWithDc = ss.find(s => s.dcCount > 0);
    const newSiteId = firstWithDc?.id ?? ss[0].id;
    localSiteId.value = newSiteId;
    // R158.45.34 — 立即按新 siteId 算 PDC emit (跟 onSiteChange 同形, R158.43.2).
    const filtered = props.dcs.filter(d => (d.siteId ?? 'unassigned') === newSiteId);
    const pdc = filtered.find(c => c.isPdc) || filtered[0];
    const newDc = pdc ? pdc.hostname : '';
    localDc.value = newDc;
    emit('update:modelValue', {
      forestId: localForestId.value,
      domainId: localDomainId.value,
      siteId: newSiteId,
      dcHostname: newDc
    });
  }
});
// R158.43.2 (2026-10-04) — dcs 列表变化时纠正 DC 选择, 改走 filteredDcsBySite
// (按当前 siteId 过滤). dcs 集合变更 (切域 / refreshAll 30s 拉新) 时, 如果
// 当前 DC 不在新 filtered 列表里 → 自动选该 site 下 PDC.
// R158.45.34 (2026-10-06) — operator "默认进入时 OU 树空, 必须按顺序选到 DC 才显示":
//   之前这里只改 localDc 不 emit → 父组件 topContext.dcHostname 永远空 →
//   OU 树 v-if=topContext?.dcHostname 不满足 → 默认看不到 OU 树. 修: 自动选 PDC
//   后**也 emit update:modelValue** 让父组件知道 dcHostname, OU 树 v-if 满足.
//   防御性加 changed check 避免循环 emit 触发 watcher.
watch(filteredDcsBySite, (cs) => {
  if (!localSiteId.value || cs.length === 0) {
    if (localDc.value !== '') {
      localDc.value = '';
      emit('update:modelValue', {
        forestId: localForestId.value,
        domainId: localDomainId.value,
        siteId: localSiteId.value,
        dcHostname: ''
      });
    }
    return;
  }
  if (!localDc.value || !cs.some(c => c.hostname === localDc.value)) {
    const pdc = cs.find(c => c.isPdc) || cs[0];
    localDc.value = pdc.hostname;
    emit('update:modelValue', {
      forestId: localForestId.value,
      domainId: localDomainId.value,
      siteId: localSiteId.value,
      dcHostname: pdc.hostname
    });
  }
});

// 下拉变更时向上 emit, 父组件依据 4 元组拉对应数据.
function onForestChange(e) {
  const v = Number(e.target.value);
  localForestId.value = v;
  // 选森林变了 → 清空 domain/site/dc (parent 会拉新列表并 reset).
  localDomainId.value = null;
  localSiteId.value   = null;
  localDc.value       = '';
  emit('update:modelValue', { forestId: v, domainId: null, siteId: null, dcHostname: '' });
}
function onDomainChange(e) {
  const v = Number(e.target.value);
  localDomainId.value = v;
  localSiteId.value = null;
  localDc.value     = '';
  emit('update:modelValue', { forestId: localForestId.value, domainId: v, siteId: null, dcHostname: '' });
}
// R158.41 sites (2026-10-03) — 站点 change handler.
// R158.43.2 (2026-10-04) — operator 反馈 "选了站点 DC 没依据站点筛选":
// 旧版 emit dcHostname='' → 父组件 topContext.dcHostname 清空 → 父 watch
// loadOuTree 早返清空 OU 树. 但 picker 内部没 emit 默认 PDC, 导致 picker UI
// 显示新 PDC 但 OU 树空. 修: onSiteChange 时, 立即按新 siteId 算 PDC, 把
// dcHostname 一并 emit 给父组件, 父级 topContext 即时同步, OU 树跟着切.
function onSiteChange(e) {
  const v = Number(e.target.value);
  localSiteId.value = v;
  // 算新 site 下默认 PDC (用 props.dcs 直接过滤避免 watch 时序依赖)
  const filtered = props.dcs.filter(d => (d.siteId ?? 'unassigned') === v);
  const pdc = filtered.find(c => c.isPdc) || filtered[0];
  const newDc = pdc ? pdc.hostname : '';
  localDc.value = newDc;
  emit('update:modelValue', {
    forestId: localForestId.value,
    domainId: localDomainId.value,
    siteId: v,
    dcHostname: newDc
  });
}
function onDcChange(e) {
  const v = String(e.target.value || '');
  localDc.value = v;
  emit('update:modelValue', { forestId: localForestId.value, domainId: localDomainId.value, siteId: localSiteId.value, dcHostname: v });
}

function sourceLabel(s) {
  if (s === 'assignment') return '指派';
  if (s === 'domainField') return '域字段';
  if (s === 'pdc') return 'PDC';
  return s || '?';
}
</script>

<style scoped>
.top-ctx-picker {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: var(--muted);
}
.ctx-row {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.ctx-icon { font-size: 13px; opacity: 0.85; }
.ctx-label {
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  font-size: 10px;
}
.top-ctx-picker select {
  background: var(--input-bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 3px 6px;
  font-size: 12px;
  max-width: 220px;
}
.top-ctx-picker select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ctx-empty-hint {
  font-size: 11px;
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.10);
  border: 1px solid rgba(245, 158, 11, 0.4);
  padding: 3px 8px;
  border-radius: 3px;
  white-space: nowrap;
}
.ctx-empty-hint a {
  color: #60a5fa;
  text-decoration: underline;
  margin-left: 4px;
}
</style>
