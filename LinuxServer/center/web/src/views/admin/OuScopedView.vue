<!--
  R158.40 (2026-10-03) — OuScopedView.vue
  OU 节点选中后的中栏视图. 复用 UserManagementView / GroupManagementView
  embedded 模式 (R158.34 + R158.35 snapshot), 并加一个 sub-OUs tab 显示
  直接子 OU 列表 (从 ouCache 拼装, 纯前端, 无后端调用).

  Props:
    dc           — 选中的 DC hostname
    ouDn         — 当前 OU 节点的 DN
    ouNode       — { dn, name, description, children: [...], userCount, groupCount }
    ouCache      — 全量 OU 列表 (父组件持有, 用于 sub-OU 渲染)
    dataSource   — 'snapshot' | 'live'

  Emits:
    select-user({ dc, sam })  — 中栏用户行 click → 父切 selection.user
    select-group({ dc, name }) — 中栏组行 click → 父切 selection.group
    select-ou(node)           — 子 OU 行 click → 父切 selection.ou
    select-computer({ dc, sam }) — 中栏电脑行 click → 父切 selection.computer

  R158.45.18 (2026-10-05) — operator "不要 4 个 tab, 一个页面列出当前 OU 下所有不同对象,
  和 ADUC 一样": 删 4 tab. 改成 ADUC 风格 unified list — 每行 = 一个对象 (OU / User / Group /
  Computer), column = 类型图标 + 名称 + 类型 + 描述 + 启用. filter 框统一过滤 name.
  OU 子节点来自 ouNode.children (前端, 无后端), user/group/computer 来自
  snapshot endpoint (R158.45.16 分页模式). 一次拉 100 条 (跟 ComputerList 一致),
  不在 OU 切换时重置分页状态 — operator 切 OU 看不同数据.

  持久 lesson (R158.37.3): 整文件 Write, 纯 UTF-8 无 BOM.
-->
<template>
  <div class="ou-scoped-view">
    <header class="osv-head">
      <h3>{{ ouNode?.name || ouDn }}</h3>
      <span class="osv-dn" :title="ouDn">{{ ouDn }}</span>
      <span class="osv-counts">
        <span v-if="ouNode?.children?.length" class="count-chip" title="子 OU 数量">📂 {{ ouNode.children.length }}</span>
        <span v-if="userTotal" class="count-chip" title="用户数">👥 {{ userTotal }}</span>
        <span v-if="groupTotal" class="count-chip" title="组数">🛡 {{ groupTotal }}</span>
        <span v-if="computerTotal" class="count-chip" title="电脑数">💻 {{ computerTotal }}</span>
      </span>
    </header>

    <div v-if="ouNode?.description" class="osv-desc">{{ ouNode.description }}</div>

    <nav class="osv-toolbar">
      <!-- R158.45.27 — 类型切换 chip: 'all' = OU + user + group + computer 全部;
           'user' / 'group' / 'computer' 只显示对应 kind (OU 子节点一直显示便于下钻).
           点击 OU 树 virtual-leaf (👤/🛡/💻) 会让父把 kindFilter 切到对应值. -->
      <div class="osv-kind-filter" data-test="osv-kind-filter">
        <button
          v-for="k in kindChips"
          :key="k.key"
          :class="['osv-kind-chip', { active: kindFilter === k.key }]"
          :data-test="`osv-kind-${k.key}`"
          @click="$emit('kind-change', k.key)"
        >{{ k.label }}</button>
      </div>
      <input
        v-model="filter"
        class="osv-filter"
        data-test="osv-filter"
        placeholder="过滤 (名称 / samAccountName / cn) — 匹配所有对象类型"
      />
      <span v-if="loading" class="osv-loading">⏳ 加载中…</span>
      <span v-if="fetchError" class="osv-fetch-err" :title="fetchError">⚠ {{ fetchError }}</span>
      <span class="osv-info">显示 {{ filteredCount }} 条</span>
      <!-- R158.45.24 (2026-10-05) — operator "中栏似乎没分页":
           3 种对象 (user / group / computer) 各自翻页, offset = page * PAGE_SIZE.
           切 OU / dc / domain → page 重置 0. filter 变化不重置 page.
           < 上一页 / 下一页 > 按钮 + 显示 "第 X 页 / 共 N 页". -->
      <div v-if="maxPage > 0" class="osv-pager" data-test="osv-pager">
        <button
          class="osv-pager-btn"
          :disabled="page === 0"
          @click="page = Math.max(0, page - 1)"
        >‹ 上一页</button>
        <span class="osv-pager-info">第 {{ page + 1 }} / {{ maxPage + 1 }} 页</span>
        <button
          class="osv-pager-btn"
          :disabled="page >= maxPage"
          @click="page = Math.min(maxPage, page + 1)"
        >下一页 ›</button>
      </div>
    </nav>

    <div v-if="!filteredCount && !loading" class="empty-hint">该 OU 下没有对象</div>
    <!-- R158.45.29 (2026-10-05) — operator "中栏 100 个用户没有滚动条":
         包进 .osv-table-scroll 滚动容器. flex 子项必须 min-height:0 才能收缩
         并触发 overflow-y:auto. thead sticky 让表头在滚动中保持可见. -->
    <div v-else class="osv-table-scroll" data-test="osv-table-scroll">
      <table class="osv-table">
        <thead>
          <tr>
            <th class="col-type">类型</th>
            <th class="col-name">名称</th>
            <th class="col-desc">描述</th>
            <th class="col-status">启用</th>
        </tr>
      </thead>
      <tbody>
        <!-- 子 OU 行 (来自 ouNode.children, 前端数据, 不分页) -->
        <tr
          v-for="o in filteredChildren"
          :key="`ou:${o.dn}`"
          :class="['osv-row', 'kind-ou', { active: false }]"
          :data-test="`osv-row-ou-${o.dn}`"
          @click="emit('select-ou', o)"
        >
          <td class="col-type"><span class="kind-pill kind-ou">📂 OU</span></td>
          <td class="col-name">{{ o.name }}</td>
          <td class="col-desc" :title="o.description">{{ o.description || '—' }}</td>
          <td class="col-status">—</td>
        </tr>
        <!-- 用户行 (snapshot, 分页 100/页) -->
        <tr
          v-if="kindFilter === 'all' || kindFilter === 'user'"
          v-for="u in filteredUsers"
          :key="`user:${u.sam}`"
          :class="['osv-row', 'kind-user', { active: props.selectedSam === u.sam }]"
          :data-test="`osv-row-user-${u.sam}`"
          @click="emit('select-user', { dc: props.dc, sam: u.sam })"
        >
          <td class="col-type"><span class="kind-pill kind-user">👤 User</span></td>
          <td class="col-name">
            <span class="primary">{{ u.displayName || u.sam }}</span>
            <small class="secondary">{{ u.sam }}</small>
          </td>
          <td class="col-desc" :title="u.description">{{ u.description || '—' }}</td>
          <td class="col-status">{{ u.enabled === null || u.enabled === undefined ? '—' : u.enabled ? '✅' : '❌' }}</td>
        </tr>
        <!-- 组行 (snapshot, 分页 100/页) -->
        <tr
          v-if="kindFilter === 'all' || kindFilter === 'group'"
          v-for="g in filteredGroups"
          :key="`group:${g.cn || g.name}`"
          :class="['osv-row', 'kind-group', { active: props.selectedName === (g.cn || g.name) }]"
          :data-test="`osv-row-group-${g.cn || g.name}`"
          @click="emit('select-group', { dc: props.dc, name: g.cn || g.name })"
        >
          <td class="col-type"><span class="kind-pill kind-group">🛡 Group</span></td>
          <td class="col-name">
            <span class="primary">{{ g.cn || g.name }}</span>
            <small v-if="g.groupType" class="secondary">{{ g.groupType }}</small>
          </td>
          <td class="col-desc" :title="g.description">{{ g.description || '—' }}</td>
          <td class="col-status">—</td>
        </tr>
        <!-- 电脑行 (snapshot, 分页 100/页) -->
        <tr
          v-if="kindFilter === 'all' || kindFilter === 'computer'"
          v-for="c in filteredComputers"
          :key="`computer:${c.samAccountName}`"
          :class="['osv-row', 'kind-computer', { active: props.computerSelectedSam === c.samAccountName }]"
          :data-test="`osv-row-computer-${c.samAccountName}`"
          @click="emit('select-computer', { dc: props.dc, sam: c.samAccountName })"
        >
          <td class="col-type"><span class="kind-pill kind-computer">💻 Computer</span></td>
          <td class="col-name">
            <span class="primary">{{ c.cn || c.samAccountName }}</span>
            <small class="secondary">{{ c.operatingSystem || c.samAccountName }}</small>
          </td>
          <td class="col-desc" :title="c.description">{{ c.description || '—' }}</td>
          <td class="col-status">{{ c.enabled === null || c.enabled === undefined ? '—' : c.enabled ? '✅' : '❌' }}</td>
        </tr>
      </tbody>
    </table>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { adminApi } from '../../api/admin.js';

const PAGE_SIZE = 100; // R158.45.16 — 每页 100 (跟 ComputerList 一致).

const props = defineProps({
  dc: { type: String, default: '' },
  domain: { type: String, default: '' },
  ouDn: { type: String, default: '' },
  ouNode: { type: Object, default: () => null },
  dataSource: { type: String, default: 'snapshot' },
  // R158.45.15 — user 行高亮 (父透传 selection.user.sam).
  selectedSam: { type: String, default: '' },
  // R158.45.31 (2026-10-05) — group 行高亮 (跟 user/computer 对齐).
  selectedName: { type: String, default: '' },
  // R158.45.15 — computer 行高亮 (父透传 computerSelectedSam).
  computerSelectedSam: { type: String, default: '' },
  // R158.45.27 (2026-10-05) — operator "OU 虚拟节点 → 不再进 ad 用户管理 / ad 组管理":
  //   'all' (默认, 显示 OU + user + group + computer) / 'user' / 'group' / 'computer'.
  //   virtual-leaf (👤 用户 / 🛡 组 / 💻 电脑) 点击后父传 'user'/'group'/'computer' 让中栏
  //   只显示对应 kind, 等同于一种「按类型筛」的轻量 tab.
  kindFilter: { type: String, default: 'all' },
  // R158.45.32 (2026-10-05) — operator "点 Root OU → 右栏筛选入口":
  //   父 (DailyOpsView) 持 ouFilter state, 通过 :filter 注入. OuScopedView 内部
  //   filter ref 保留 (顶部 toolbar input 仍 v-model), watch props.filter 同步.
  filter: { type: String, default: '' }
});
const emit = defineEmits(['select-user', 'select-group', 'select-ou', 'select-computer', 'kind-change']);

// R158.45.27 — toolbar kind chip 列表 (虚拟节点 = toolbar 'all 玩法')
const kindChips = [
  { key: 'all',      label: '📚 全部' },
  { key: 'user',     label: '👤 用户' },
  { key: 'group',    label: '🛡 组' },
  { key: 'computer', label: '💻 电脑' }
];

const filter = ref(props.filter);
// R158.45.32 (2026-10-05) — 父注入 filter 同步: 父 (DailyOpsView) ouFilter 变化
//   → 写内部 ref → page=0 触发 page watcher → 自动重新 fetch + client-side filter.
watch(() => props.filter, (v) => {
  if (v !== filter.value) {
    filter.value = v;
    page.value = 0;
  }
});
// R158.45.24 (2026-10-05) — 3 种对象 (user / group / computer) 各自用同一 page,
// offset = page * PAGE_SIZE. fetch 用 offset 取对应页数据.
// R158.45.28 (2026-10-05) — operator "筛选后重新计算页面, 否则很尴尬":
//   filter 是客户端过滤, 但 fetch offset 是 page*PAGE_SIZE. 矛盾是: filter
//   后命中行数 ≠ total. 简化策略:
//     1) maxPage 改基于当前 filter 后可见行数 (filtered.length / PAGE_SIZE)
//     2) filter 变化 → 自动 page=0 (否则当前 page 越界, 表格空)
//     3) filter 不重 fetch (客户端过滤, 当前页数据已加载, 只 client-side filter)
//   这样 maxPage = ceil(filter 后命中行数 / 100), 永远 ≥ 0.
//   operator 在第 5 页 filter 后命中 0 行 → maxPage=0, 自动回 page=0 → 重新 fetch
//   (page watcher) 拿到新 100 条再统计. 整体行为: filter → 自动翻回首页 → 自动 re-fetch.
const page = ref(0);

const userRows = ref([]);
const groupRows = ref([]);
const computerRows = ref([]);
const userTotal = ref(0);
const groupTotal = ref(0);
const computerTotal = ref(0);
const loading = ref(false);
// R158.45.26 (2026-10-05) — fetch 错误显式存 ref 让 UI 提示 (之前 try/catch swallow,
// operator 看不到后端是否抛). 改成弹红字 + console.error.
const fetchError = ref('');

// R158.45.18 — 子 OU 来自 ouNode.children (纯前端, 不分页).
const childrenRows = computed(() => props.ouNode?.children || []);

// R158.45.28 — maxPage 改基于 filter 后可见行数 (3 类 union) 而非 total.
//   因为 filter 是 client-side, 当前页 offset 决定的 100 条数据 vs total 没直接关系.
//   filter 命中行数变化 → maxPage 变 → "下一页"按钮可用性变.
const maxTotal = computed(() => Math.max(userTotal.value, groupTotal.value, computerTotal.value));
const maxPage = computed(() => {
  // 用 filter 后的可见行数算 maxPage. filteredCount 是 3 类 + 子 OU 总数,
  // 这里只算 user/group/computer (排除子 OU 行, 子 OU 不分页).
  const totalRows = filteredUsers.value.length + filteredGroups.value.length + filteredComputers.value.length;
  return Math.max(0, Math.ceil(totalRows / PAGE_SIZE) - 1);
});

// R158.45.25 (2026-10-05) — operator "中间过滤不生效": 之前 template 用
// childrenRows / userRows / groupRows / computerRows 直接 v-for, filter 完全没接
// 到渲染 — 只有顶部计数受影响. 拆成 4 个 filtered* computed, template 用 filtered*
// 渲染, filter 即时生效.
function makeMatcher(q) {
  return (s) => !q || (s && String(s).toLowerCase().includes(q));
}
// 子 OU: 匹配 name ∪ dn ∪ description (跟 DailyOpsView filterText 行为对齐).
const filteredChildren = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return childrenRows.value;
  const m = makeMatcher(q);
  return childrenRows.value.filter(o => m(o.name) || m(o.dn) || m(o.description));
});
// R158.45.18 fix — wire shape: user 是 {sam, displayName, ...}, group 是 {name, ...},
// computer 是 {samAccountName, cn, name, operatingSystem, ...}.
const filteredUsers = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return userRows.value;
  const m = makeMatcher(q);
  return userRows.value.filter(u => m(u.displayName) || m(u.sam) || m(u.description));
});
const filteredGroups = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return groupRows.value;
  const m = makeMatcher(q);
  return groupRows.value.filter(g => m(g.cn) || m(g.name) || m(g.description));
});
const filteredComputers = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return computerRows.value;
  const m = makeMatcher(q);
  return computerRows.value.filter(c => m(c.cn) || m(c.samAccountName) || m(c.operatingSystem) || m(c.description));
});
const filteredCount = computed(() =>
  filteredChildren.value.length + filteredUsers.value.length
    + filteredGroups.value.length + filteredComputers.value.length
);

// R158.45.24 — fetch 带 offset = page.value * PAGE_SIZE. 切 OU / dc / domain
// → page 重置 0. filter 变化 / page 变化 → 重新拉.
async function fetchSnapshotRows() {
  fetchError.value = '';
  if (props.dataSource !== 'snapshot') {
    userRows.value = []; groupRows.value = []; computerRows.value = [];
    userTotal.value = 0; groupTotal.value = 0; computerTotal.value = 0;
    return;
  }
  if (!props.dc && !props.domain) {
    userRows.value = []; groupRows.value = []; computerRows.value = [];
    userTotal.value = 0; groupTotal.value = 0; computerTotal.value = 0;
    return;
  }
  loading.value = true;
  const offset = page.value * PAGE_SIZE;
  try {
    const ouDn = props.ouDn || '';
    const tasks = [];
    if (props.domain) {
      tasks.push(adminApi.listAdUsersByDomain({ domain: props.domain, filter: '', ouDn, limit: PAGE_SIZE, offset }).then(r => ({ kind: 'u', r })));
      tasks.push(adminApi.listAdGroupsByDomain({ domain: props.domain, filter: '', ouDn, limit: PAGE_SIZE, offset }).then(r => ({ kind: 'g', r })));
      tasks.push(adminApi.listAdComputersByDomain({ domain: props.domain, filter: '', ouDn, limit: PAGE_SIZE, offset }).then(r => ({ kind: 'c', r })));
    } else {
      tasks.push(adminApi.listAdUsers({ dc: props.dc, filter: '', ouDn, limit: PAGE_SIZE, offset }).then(r => ({ kind: 'u', r })));
      tasks.push(adminApi.listAdGroups({ dc: props.dc, filter: '', ouDn, limit: PAGE_SIZE, offset }).then(r => ({ kind: 'g', r })));
      tasks.push(adminApi.listAdComputers({ dc: props.dc, filter: '', ouDn, limit: PAGE_SIZE, offset }).then(r => ({ kind: 'c', r })));
    }
    const results = await Promise.all(tasks);
    for (const { kind, r } of results) {
      const data = r.data || {};
      if (kind === 'u') {
        userRows.value = data.users || [];
        userTotal.value = Number(data.total || 0);
      } else if (kind === 'g') {
        // R158.44.7.4 — group RDN 是 cn, 但 snapshot backend 可能返 name 字段.
        // 兼容: 取 cn || name 作为 row 唯一 key.
        groupRows.value = (data.groups || []).map(g => ({ ...g, cn: g.cn || g.name }));
        groupTotal.value = Number(data.total || 0);
      } else if (kind === 'c') {
        computerRows.value = data.computers || [];
        computerTotal.value = Number(data.total || 0);
      }
    }
  } catch (e) {
    console.error('[OuScopedView] snapshot fetch failed', e, { propsOuDn: props.ouDn, propsDomain: props.domain, propsDc: props.dc, offset });
    fetchError.value = e?.response?.data?.error || e?.message || '拉取失败';
    userRows.value = []; groupRows.value = []; computerRows.value = [];
    userTotal.value = 0; groupTotal.value = 0; computerTotal.value = 0;
  } finally {
    loading.value = false;
  }
}

// R158.45.24 — OU / dc / domain 切换 → 重置 page=0 + 拉数据.
watch(
  () => [props.ouDn, props.dc, props.domain, props.dataSource],
  () => { page.value = 0; fetchSnapshotRows(); },
  { immediate: true }
);
// R158.45.24 — page 变化触发 fetch (但 OU 切换的 watcher 已经先重置 page=0 再 fetch,
// 所以 page watcher 只接管 "用户点翻页按钮" 这条路径).
watch(page, () => { fetchSnapshotRows(); });
// R158.45.28 (2026-10-05) — operator "筛选后重新计算页面, 否则很尴尬":
//   filter 变化 → page=0 → page watcher 自动触发 fetch, 拿新 offset=0 的 100 条
//   重新 client-filter. 之前 filter 后 maxPage 用的是 total (跟客户端 filter 行数无关),
//   page 还停在原值, 表格可能空 / "下一页"还能点但点了是空页.
watch(filter, () => { page.value = 0; });
</script>

<style scoped>
.ou-scoped-view {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  flex: 1 1 auto;
}
.osv-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 6px;
  flex-wrap: wrap;
}
.osv-head h3 { margin: 0; font-size: 16px; }
.osv-dn {
  font-family: monospace;
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 auto;
  min-width: 200px;
}
.osv-counts {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.count-chip {
  font-size: 10px;
  padding: 2px 7px;
  background: var(--input-bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text);
}
.osv-desc {
  font-size: 12px;
  color: var(--muted);
  padding: 6px 10px;
  background: var(--input-bg);
  border: 1px solid var(--border);
  border-radius: 3px;
}
.osv-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 4px;
}
.osv-filter {
  flex: 1 1 auto;
  padding: 4px 8px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--input-bg);
  color: var(--text);
}
.osv-filter:focus { outline: none; border-color: #3b82f6; }
.osv-loading { font-size: 11px; color: var(--muted); }
.osv-fetch-err {
  font-size: 11px;
  color: #ef4444;
  background: rgba(239, 68, 68, 0.12);
  padding: 2px 6px;
  border-radius: 2px;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* R158.45.27 — kind 切换 chip (📚 全部 / 👤 用户 / 🛡 组 / 💻 电脑). */
.osv-kind-filter {
  display: inline-flex;
  gap: 3px;
  padding: 2px;
  background: var(--input-bg);
  border: 1px solid var(--border);
  border-radius: 3px;
}
.osv-kind-chip {
  font-size: 11px;
  padding: 3px 10px;
  border: none;
  border-radius: 2px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  white-space: nowrap;
}
.osv-kind-chip:hover:not(.active) { background: var(--border); }
.osv-kind-chip.active {
  background: rgba(96, 165, 250, 0.18);
  color: #60a5fa;
  font-weight: 600;
}
.osv-info { font-size: 11px; color: var(--muted); white-space: nowrap; }
/* R158.45.24 (2026-10-05) — 中栏分页按钮 (跟 ComputerList 风格一致). */
.osv-pager {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 8px;
}
.osv-pager-btn {
  font-size: 11px;
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--input-bg);
  color: var(--text);
  cursor: pointer;
}
.osv-pager-btn:hover:not(:disabled) {
  background: rgba(96, 165, 250, 0.14);
  border-color: rgba(96, 165, 250, 0.4);
  color: #60a5fa;
}
.osv-pager-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.osv-pager-info {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}
.empty-hint { padding: 14px; color: var(--muted); font-size: 12px; }
/* R158.45.29 (2026-10-05) — 中栏表格滚动容器.
   flex 列内子项要 min-height:0 才能收缩 + 触发 overflow-y. */
.osv-table-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--panel);
}
.osv-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.osv-table th {
  text-align: left;
  padding: 6px 10px;
  background: var(--input-bg);
  color: var(--muted);
  font-weight: 600;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.osv-table thead th { position: sticky; top: 0; z-index: 1; }
.osv-row {
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  transition: background 0.12s ease;
}
.osv-row:hover { background: rgba(96, 165, 250, 0.08); }
.osv-row.active {
  background: rgba(96, 165, 250, 0.14);
  color: #60a5fa;
  font-weight: 600;
}
.osv-table td {
  padding: 5px 10px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.col-type { width: 110px; }
.col-name { min-width: 0; }
.col-name .primary { display: block; color: var(--text); }
.osv-row.active .col-name .primary { color: #60a5fa; }
.osv-row.kind-ou .col-name .primary { color: #60a5fa; font-weight: 500; }
.col-name .secondary {
  display: block;
  font-size: 10px;
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.col-desc {
  color: var(--muted);
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.col-status { width: 60px; text-align: center; }
.kind-pill {
  display: inline-block;
  font-size: 10px;
  padding: 2px 7px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--input-bg);
  color: var(--muted);
  white-space: nowrap;
}
.kind-pill.kind-ou      { background: rgba(96, 165, 250, 0.14); color: #60a5fa; border-color: rgba(96, 165, 250, 0.3); }
.kind-pill.kind-user    { background: rgba(34, 197, 94, 0.14); color: #22c55e; border-color: rgba(34, 197, 94, 0.3); }
.kind-pill.kind-group   { background: rgba(168, 85, 247, 0.14); color: #a855f7; border-color: rgba(168, 85, 247, 0.3); }
.kind-pill.kind-computer{ background: rgba(245, 158, 11, 0.14); color: #f59e0b; border-color: rgba(245, 158, 11, 0.3); }
</style>
