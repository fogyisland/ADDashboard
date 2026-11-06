<!--
  AD 信息同步矩阵行内展开面板 (R158.44 2026-10-04)
  原 SnapshotTreeSection (R158.43) 是 /admin/directory-sync 底部的独立 section.
  现被 DirectorySyncView 的「森林 x 域矩阵」行内吸收, 变成每个域展开后的内嵌组件.

  数据契约:
    props.domain        = forest-summary wire.domain (含 domainName/domainDn/role/syncEnabled/dcHostname/lastRun)
    props.binding       = domain-binding wire (含 dcs[].hostname/isPdc/source/lastRun), null = 未拉
    props.bindingLoading= 是否正在拉 binding
    props.defaultDc     = 当前选中的 DC hostname (父级持有, 子级 update via emit)

  职责:
    - 父级 matrix 已 fetch binding, 此组件不重拉.
    - 子组件自管: fetch /snapshot/:dcName, 计算 OU 树 + 用户/组 filter, 渲染 3 列.
    - DC 选择条 (panel 顶部) 允许操作员在 chip 之间切换 (只显示 binding 提供的).
    - emit select-dc 让父级 map 更新; emit open-setting 跳 forest-registry 改 sync_enabled.

  复用:
    OuTreeNode.vue (递归树节点) + utils/ouTreeBuilder.js (countUsersAndGroups/buildOuTree).
    所有 status-pill / snap-three-col / snap-col / tree-list / flat-list / flat-row
    样式类原样平移 (R158.43 已对齐 R158.2 主题色板), 改 wrapper 为 snapshot-panel.

  边界:
    - currentDc 为空 (binding 没拉到 / dcs=[]) → 显示空态 + 引导至 forest-registry 绑 DC
    - snapshot 拉失败 → 红条 snap-error
    - watch currentDc 切换时 fetchSnapshot (旧 panel unmount 不会触发 watch)
-->
<template>
  <div class="snapshot-panel" data-test="snapshot-panel">
    <!-- DC 选择条 (顶部) -->
    <div v-if="binding?.dcs?.length" class="dc-bar" data-test="panel-dc-bar">
      <span class="bar-label">同步 DC:</span>
      <button v-for="dc in binding.dcs" :key="dc.hostname"
              :class="['dc-chip', { active: currentDc === dc.hostname }]"
              @click="emit('select-dc', dc.hostname)">
        <span class="dc-hostname">{{ dc.hostname }}</span>
        <span v-if="dc.isPdc" class="pdc-mark">PDC</span>
        <span :class="['source-tag', `source-${dc.source}`]">
          {{ sourceLabel(dc.source) }}
        </span>
      </button>
      <button class="link setting-link" @click="emit('open-setting', domain)">
        ⚙ 改自动同步 / 设置
      </button>
    </div>
    <div v-else-if="bindingLoading" class="empty-hint">加载 DC 绑定…</div>
    <div v-else class="empty-hint">
      该域暂无可用 DC — 去
      <a href="#" @click.prevent="emit('open-setting', domain)">域和森林注册</a>
      绑定.
    </div>

    <!-- lastRun status pill -->
    <div v-if="currentDc" class="panel-status" data-test="panel-status">
      <span v-if="!lastRun" class="status-pill status-never">— 从未同步</span>
      <span v-else-if="lastRun.status === 'success'"
            class="status-pill status-success" :title="lastRunTooltip">
        ✓ 成功 · {{ formatRelative(lastRun.finishedAt) }}
      </span>
      <span v-else-if="lastRun.status === 'running'"
            class="status-pill status-running" :title="lastRunTooltip">
        ⏳ 运行中 · {{ formatRelative(lastRun.startedAt) }}
      </span>
      <span v-else-if="lastRun.status === 'failed'"
            class="status-pill status-failed" :title="lastRunTooltip">
        ✗ 失败 · {{ formatRelative(lastRun.startedAt) }}
      </span>
    </div>

    <!-- 3 列布局: OU 树 (左) / 用户 (中) / 组 (右) -->
    <div v-if="currentDc" class="snap-three-col">
      <!-- OU 树 -->
      <div class="snap-col">
        <div class="snap-col-head">
          <span class="col-icon">📂</span>
          <span>OU 树</span>
          <span class="col-meta">{{ ouRoots.length }} 个根 OU / {{ ous.length }} 总</span>
        </div>
        <input v-model="ouFilterText" class="snap-filter" placeholder="过滤 OU 名称…" />
        <div v-if="snapshotLoading" class="empty-hint">加载中…</div>
        <div v-else-if="ous.length === 0" class="empty-hint">
          暂无 OU 数据. 检查 AD 信息同步是否对 {{ currentDc }} 跑过.
        </div>
        <ul v-else class="tree-list ou-roots">
          <OuTreeNode
            v-for="root in ouRoots"
            :key="root.dn"
            :node="root"
            :selected-dn="selectedOuDn"
            :selected-kind="selectedOuDn ? 'ou' : ''"
            :expanded-dn-set="expandedDnSet"
            :filter-text="ouFilterText"
            @select="onSelectOu"
            @selectBuiltin="onSelectOu"
            @selectUsers="onSelectOuUsers"
            @selectGroups="onSelectOuGroups"
            @selectComputers="onSelectOuComputers"
            @toggleExpand="onToggleExpand"
          />
        </ul>
      </div>

      <!-- 用户 -->
      <div class="snap-col">
        <div class="snap-col-head">
          <span class="col-icon">👥</span>
          <span>用户</span>
          <span class="col-meta">{{ filteredUsers.length }} / {{ users.length }}</span>
        </div>
        <input v-model="userFilterText" class="snap-filter" placeholder="按 SAM / 显示名过滤…" />
        <div v-if="snapshotLoading" class="empty-hint">加载中…</div>
        <div v-else-if="users.length === 0" class="empty-hint">暂无用户数据.</div>
        <ul v-else class="flat-list">
          <li v-for="u in filteredUsers.slice(0, 500)" :key="u.distinguishedName" class="flat-row">
            <span class="row-name">{{ u.sam }}</span>
            <span class="row-meta">{{ u.displayName || '' }}</span>
            <span v-if="u.lockedOut" class="row-badge badge-locked">🔒</span>
            <span v-else-if="u.enabled === false" class="row-badge badge-disabled">⛔</span>
          </li>
          <li v-if="filteredUsers.length > 500" class="flat-row flat-overflow">
            … 还有 {{ filteredUsers.length - 500 }} 行 (顶部 filter 缩小范围)
          </li>
        </ul>
      </div>

      <!-- 组 -->
      <div class="snap-col">
        <div class="snap-col-head">
          <span class="col-icon">🛡️</span>
          <span>组</span>
          <span class="col-meta">{{ filteredGroups.length }} / {{ groups.length }}</span>
        </div>
        <input v-model="groupFilterText" class="snap-filter" placeholder="按名称 / SAM 过滤…" />
        <div v-if="snapshotLoading" class="empty-hint">加载中…</div>
        <div v-else-if="groups.length === 0" class="empty-hint">暂无组数据.</div>
        <ul v-else class="flat-list">
          <li v-for="g in filteredGroups.slice(0, 500)" :key="g.distinguishedName" class="flat-row">
            <span class="row-name">{{ g.name }}</span>
            <span class="row-meta">{{ g.memberCount != null ? `${g.memberCount} 成员` : '' }}</span>
          </li>
          <li v-if="filteredGroups.length > 500" class="flat-row flat-overflow">
            … 还有 {{ filteredGroups.length - 500 }} 行 (顶部 filter 缩小范围)
          </li>
        </ul>
      </div>
    </div>
    <div v-else class="empty-hint snap-empty">
      上方选 DC 后加载 OU + 用户 + 组 树状预览.
    </div>

    <!-- 错误条 -->
    <div v-if="snapshotError" class="snap-error">{{ snapshotError }}</div>
  </div>
</template>

<script setup>
// R158.44 (2026-10-04), R158.44.7.10 (2026-10-05) — SnapshotTreePanel 主体逻辑.
// 父级 DirectorySyncView 矩阵行点击后展开, 传入已 fetch 的 binding; 本组件自管
// snapshot 拉取 + 树构建. R158.44.7.10 — snapshot.ous 加 computers, OU 树
// 加 computerCount (跟 DailyOpsView 同形, 3rd object class).
import { ref, computed, watch, onMounted } from 'vue';
import OuTreeNode from './OuTreeNode.vue';
import { adminApi } from '../../api/admin.js';
import { countUsersGroupsComputers, buildOuTree } from '../../utils/ouTreeBuilder.js';

const props = defineProps({
  domain: { type: Object, required: true },         // forest-summary wire.domain
  binding: { type: Object, default: null },         // domain-binding wire (含 dcs[])
  bindingLoading: { type: Boolean, default: false },
  defaultDc: { type: String, default: '' }          // 父级持有, 子级 emit 更新
});
const emit = defineEmits(['select-dc', 'open-setting']);

// snapshot + UI state
const snapshot = ref(null);
const snapshotLoading = ref(false);
const snapshotError = ref('');
const selectedOuDn = ref('');
const expandedDnSet = ref(new Set());
const ouFilterText = ref('');
const userFilterText = ref('');
const groupFilterText = ref('');

// 当前显示 DC: 父级 defaultDc 优先, 否则 binding PDC 优先, 否则首个
const currentDc = computed(() => {
  if (props.defaultDc) return props.defaultDc;
  const dcs = props.binding?.dcs || [];
  const pdc = dcs.find(x => x.isPdc);
  if (pdc) return pdc.hostname;
  return dcs[0]?.hostname || '';
});

// lastRun: snapshot 自带优先, 否则 binding 该 DC 行
const lastRun = computed(() => {
  if (snapshot.value?.lastRun) return snapshot.value.lastRun;
  const dc = (props.binding?.dcs || []).find(x => x.hostname === currentDc.value);
  return dc?.lastRun || null;
});

const lastRunTooltip = computed(() => {
  const r = lastRun.value;
  if (!r) return '';
  const parts = [];
  if (r.startedAt) parts.push(`开始: ${r.startedAt}`);
  if (r.finishedAt) parts.push(`结束: ${r.finishedAt}`);
  if (r.userCount != null) parts.push(`用户: ${r.userCount}`);
  if (r.groupCount != null) parts.push(`组: ${r.groupCount}`);
  if (r.ouCount != null) parts.push(`OU: ${r.ouCount}`);
  // R158.44.7.10 — 加电脑计数 (跟 lastRun JSON 字段一致)
  if (r.computerCount != null) parts.push(`电脑: ${r.computerCount}`);
  if (r.errorMessage) parts.push(`错误: ${r.errorMessage}`);
  return parts.join('\n');
});

// 数据派生 (平移老 SnapshotTreeSection 第 228-235 行, R158.44.7.10 加 computers)
const ous = computed(() => snapshot.value?.ous || []);
const users = computed(() => snapshot.value?.users || []);
const groups = computed(() => snapshot.value?.groups || []);
const computers = computed(() => snapshot.value?.computers || []);

const ouRoots = computed(() => {
  const { userCountsByOuDn, groupCountsByOuDn, computerCountsByOuDn } =
    countUsersGroupsComputers(users.value, groups.value, computers.value);
  return buildOuTree(ous.value, userCountsByOuDn, groupCountsByOuDn, computerCountsByOuDn);
});

// 用户 / 组 filter (客户端 substring, 大小写不敏感)
const filteredUsers = computed(() => {
  const q = userFilterText.value.trim().toLowerCase();
  if (!q) return users.value;
  return users.value.filter(u =>
    String(u.sam || '').toLowerCase().includes(q) ||
    String(u.displayName || '').toLowerCase().includes(q)
  );
});
const filteredGroups = computed(() => {
  const q = groupFilterText.value.trim().toLowerCase();
  if (!q) return groups.value;
  return groups.value.filter(g =>
    String(g.name || '').toLowerCase().includes(q) ||
    String(g.samAccountName || '').toLowerCase().includes(q)
  );
});

// watch currentDc → fetchSnapshot
watch(currentDc, async (newDc, oldDc) => {
  if (!newDc || newDc === oldDc) return;
  await fetchSnapshot(newDc);
});

// mount 时若已有 DC, 立即 fetch (行刚展开时的初始 load)
onMounted(async () => {
  if (currentDc.value) await fetchSnapshot(currentDc.value);
});

async function fetchSnapshot(dcName) {
  snapshotLoading.value = true;
  snapshotError.value = '';
  try {
    const res = await adminApi.getDirectorySyncSnapshot(dcName);
    snapshot.value = res.data || null;
    // OU 树默认展开根
    const roots = ouRoots.value;
    if (roots.length > 0) {
      const next = new Set();
      for (const r of roots) next.add(r.dn);
      expandedDnSet.value = next;
    }
  } catch (e) {
    snapshotError.value = '加载快照失败: ' + (e?.response?.data?.error || e?.message);
    snapshot.value = null;
  } finally {
    snapshotLoading.value = false;
  }
}

// OuTreeNode event handlers (本轮只读 — select 只更新 selectedOuDn 高亮)
function onSelectOu(node) {
  selectedOuDn.value = node.dn || '';
}
function onSelectOuUsers(ouDn) {
  selectedOuDn.value = String(ouDn);
  const node = ous.value.find(o => o.distinguishedName === ouDn);
  if (node) userFilterText.value = node.name || '';
}
function onSelectOuGroups(ouDn) {
  selectedOuDn.value = String(ouDn);
  const node = ous.value.find(o => o.distinguishedName === ouDn);
  if (node) groupFilterText.value = node.name || '';
}
// R158.44.7.10 — 电脑虚拟节点 (3rd object class) 选中. SnapshotTreePanel
// 只读, 不实现列表 drill-down (跟 DailyOpsView 同决策); 仅保留高亮 +
// selectedOuDn 供后续 sprint 复用.
function onSelectOuComputers(ouDn) {
  selectedOuDn.value = String(ouDn);
}
function onToggleExpand(dn) {
  const next = new Set(expandedDnSet.value);
  if (next.has(dn)) next.delete(dn);
  else next.add(dn);
  expandedDnSet.value = next;
}

// 工具
function formatRelative(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Math.max(0, Date.now() - t);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}
function sourceLabel(src) {
  if (src === 'assignment') return '绑定';
  if (src === 'domain_default') return '默认';
  if (src === 'pdc_fallback') return 'PDC';
  return '';
}
</script>

<style scoped>
/* wrapper (R158.44) — 老 SnapshotTreeSection 的 .snapshot-section 改名 */
.snapshot-panel {
  padding: 0.5rem 0.25rem 0.25rem;
}

/* DC 选择条 (R158.44 新增, 替换老 .snap-link / .link-stage) */
.dc-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: center;
  padding: 0.5rem 0.6rem;
  background: var(--bg-secondary, #1f2937);
  border: 1px solid var(--border-primary, #374151);
  border-radius: 6px;
  margin-bottom: 0.5rem;
}
.bar-label { font-size: 0.75rem; color: var(--text-secondary, #9ca3af); margin-right: 0.25rem; }
.dc-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.3rem 0.6rem;
  background: var(--bg-tertiary, #111827);
  color: var(--text-primary, #e5e7eb);
  border: 1px solid var(--border-primary, #374151);
  border-radius: 4px;
  font-size: 0.8rem;
  cursor: pointer;
  transition: border-color 0.15s;
}
.dc-chip:hover { border-color: var(--accent, #60a5fa); }
.dc-chip.active {
  background: rgba(96, 165, 250, 0.18);
  border-color: var(--accent, #60a5fa);
  color: var(--accent, #60a5fa);
  font-weight: 500;
}
.dc-hostname { font-family: 'JetBrains Mono', Consolas, monospace; }
.pdc-mark {
  font-size: 0.65rem;
  background: rgba(34, 197, 94, 0.18);
  color: #4ade80;
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: 600;
}
.source-tag {
  font-size: 0.65rem;
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: 500;
}
.source-tag.source-assignment { background: rgba(34,197,94,0.14); color: #22c55e; }
.source-tag.source-domain_default { background: rgba(234,179,8,0.14); color: #eab308; }
.source-tag.source-pdc_fallback { background: rgba(96,165,250,0.14); color: #60a5fa; }
.setting-link {
  margin-left: auto;
  background: transparent;
  border: none;
  color: var(--accent, #60a5fa);
  cursor: pointer;
  font-size: 0.75rem;
  padding: 0 4px;
}
.setting-link:hover { text-decoration: underline; }

/* lastRun status pill (平移老 SnapshotTreeSection 第 421-433 行) */
.panel-status { margin-bottom: 0.5rem; }
.status-pill {
  display: inline-block;
  padding: 0.25rem 0.6rem;
  border-radius: 12px;
  font-size: 0.8rem;
  font-weight: 500;
  white-space: nowrap;
}
.status-success { background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid #4ade80; }
.status-running { background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid #60a5fa; }
.status-failed  { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid #f87171; }
.status-never   { background: rgba(107, 114, 128, 0.15); color: #9ca3af; border: 1px solid #6b7280; }

/* 3 列布局 (平移老 SnapshotTreeSection 第 435-451 行) */
.snap-three-col {
  display: grid;
  grid-template-columns: 1.4fr 1fr 1fr;
  gap: 0.5rem;
}
@media (max-width: 1100px) {
  .snap-three-col { grid-template-columns: 1fr; }
}
.snap-col {
  background: var(--bg-secondary, #1f2937);
  border: 1px solid var(--border-primary, #374151);
  border-radius: 6px;
  padding: 0.4rem;
  min-height: 200px;
  max-height: 600px;
  overflow-y: auto;
}
.snap-col-head {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.3rem 0.4rem;
  font-weight: 600;
  font-size: 0.9rem;
  color: var(--text-primary, #e5e7eb);
  border-bottom: 1px solid var(--border-primary, #374151);
  margin-bottom: 0.4rem;
}
.col-icon { font-size: 1rem; }
.col-meta { margin-left: auto; color: var(--text-secondary, #9ca3af); font-size: 0.75rem; font-weight: 400; }
.snap-filter {
  width: 100%;
  padding: 0.3rem 0.5rem;
  background: var(--bg-tertiary, #111827);
  color: var(--text-primary, #e5e7eb);
  border: 1px solid var(--border-primary, #374151);
  border-radius: 4px;
  font-size: 0.8rem;
  margin-bottom: 0.4rem;
  box-sizing: border-box;
}
.empty-hint {
  color: var(--text-secondary, #9ca3af);
  font-size: 0.85rem;
  padding: 0.75rem;
  text-align: center;
}
.snap-empty { margin-top: 0.5rem; }
.tree-list { list-style: none; padding: 0; margin: 0; }
.flat-list { list-style: none; padding: 0; margin: 0; }
.flat-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.25rem 0.4rem;
  border-bottom: 1px solid var(--border-primary, #374151);
  font-size: 0.82rem;
}
.flat-row:hover { background: var(--bg-tertiary, #111827); }
.row-name { color: var(--text-primary, #e5e7eb); font-weight: 500; }
.row-meta { color: var(--text-secondary, #9ca3af); font-size: 0.75rem; }
.row-badge { font-size: 0.85rem; }
.badge-locked { color: #f87171; }
.badge-disabled { color: #9ca3af; }
.flat-overflow { color: var(--text-secondary, #9ca3af); font-style: italic; }
.snap-error {
  margin-top: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid #f87171;
  border-radius: 4px;
  color: #f87171;
  font-size: 0.85rem;
}
</style>