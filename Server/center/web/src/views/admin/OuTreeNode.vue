<!--
  R158.40 (2026-10-03), R158.44.7.10 (2026-10-05) — OuTreeNode.vue
  ADUC 风格 OU 树递归节点. 单一职责:
    渲染一个 OU 节点 (📂 图标 + name + 3 个计数 meta) + 嵌套子节点
    + 3 个虚拟节点 (👥 用户 / 🛡️ 组 / 💻 电脑) 切 OU-scoped 视图.

  Props:
    node           — { dn, name, parentDn, description, isBuiltin, children,
                      userCount, groupCount, computerCount, depth } (来自 buildOuTree)
    selectedDn     — 当前选中节点 DN (高亮用)
    selectedKind   — 当前选中节点 kind: 'ou' | 'user' | 'group' | 'computer' | 'builtin'
    expandedDnSet  — Set<dn> 当前展开的节点 (持久展开状态)
    filterText     — 当前过滤字符串 (高亮匹配)

  Emits:
    select(node)            — 选中该 OU 节点 → 中栏 OuScopedView
    selectBuiltin(node)     — 选中 Builtin 容器 → 中栏 BuiltinView (只读)
    selectUsers(ouDn)       — 选中该 OU 下的「用户列表」虚拟节点
    selectGroups(ouDn)      — 选中该 OU 下的「组列表」虚拟节点
    selectComputers(ouDn)   — 选中该 OU 下的「电脑列表」虚拟节点 (R158.44.7.10)
    toggleExpand(dn)        — 展开/折叠 (父组件管 expandedDnSet)

  Builtin 容器特殊: 不展开, 灰色样式, 不可创建/删除/重命名 (右栏只读).

  持久 lesson (R158.37.3): 整文件 Write, 纯 UTF-8 无 BOM, 落地后
  `[System.IO.File]::ReadAllBytes + Encoding.UTF8.GetString` 校验.
-->
<template>
  <li
    :class="['ou-tree-node', { 'is-builtin': node.isBuiltin }]"
    :data-test="`ou-node-${node.dn}`"
  >
    <!-- 普通 OU: 可展开节点 -->
    <div
      v-if="!node.isBuiltin"
      :class="['tree-leaf', { active: selectedKind === 'ou' && selectedDn === node.dn }]"
      @click="emit('select', node)"
    >
      <span class="caret" @click.stop="emit('toggleExpand', node.dn)">
        <span v-if="node.children.length > 0">{{ isExpanded ? '▾' : '▸' }}</span>
        <span v-else class="caret-empty">·</span>
      </span>
      <span class="leaf-icon">📂</span>
      <span class="leaf-label" v-html="renderLabel(node.name)"></span>
      <!-- R158.44.7.10 — 3 个计数 (👤 用户 / 👥 组 / 💻 电脑), 跟 user/group 平行 -->
      <span class="leaf-meta"
            :title="`${node.userCount} 个用户 / ${node.groupCount} 个组 / ${node.computerCount} 台电脑`">
        <span class="meta-piece meta-users" aria-label="用户">👤 {{ node.userCount }}</span>
        <span class="meta-sep">/</span>
        <span class="meta-piece meta-groups" aria-label="组">👥 {{ node.groupCount }}</span>
        <span class="meta-sep">/</span>
        <span class="meta-piece meta-computers" aria-label="电脑">💻 {{ node.computerCount }}</span>
      </span>
    </div>

    <!-- Builtin 容器: 不展开, 灰色样式 -->
    <div
      v-else
      :class="['tree-leaf', 'builtin-leaf', { active: selectedKind === 'builtin' && selectedDn === node.dn }]"
      :title="'CN=Builtin 内置容器, 只读'"
      @click="emit('selectBuiltin', node)"
    >
      <span class="caret-empty">·</span>
      <span class="leaf-icon">⚙️</span>
      <span class="leaf-label">{{ node.name }}</span>
      <span class="leaf-meta builtin-meta">内置</span>
    </div>

    <!-- 递归 children (仅普通 OU 显示) -->
    <ul v-if="!node.isBuiltin && isExpanded && node.children.length > 0" class="tree-list">
      <OuTreeNode
        v-for="child in node.children"
        :key="child.dn"
        :node="child"
        :selected-dn="selectedDn"
        :selected-kind="selectedKind"
        :expanded-dn-set="expandedDnSet"
        :filter-text="filterText"
        @select="emit('select', $event)"
        @selectBuiltin="emit('selectBuiltin', $event)"
        @selectUsers="emit('selectUsers', $event)"
        @selectGroups="emit('selectGroups', $event)"
        @selectComputers="emit('selectComputers', $event)"
        @toggleExpand="emit('toggleExpand', $event)"
      />
    </ul>

    <!-- 用户/组/电脑虚拟节点 — 仅普通 OU 在展开时显示 -->
    <ul v-if="!node.isBuiltin && isExpanded" class="tree-list virtual-list">
      <li
        :class="['tree-leaf', 'virtual-leaf', { active: isUsersScope }]"
        :data-test="`ou-users-${node.dn}`"
        @click="emit('selectUsers', node.dn)"
      >
        <span class="caret-empty">·</span>
        <span class="leaf-icon">👤</span>
        <span class="leaf-label">用户 ({{ node.userCount }})</span>
      </li>
      <li
        :class="['tree-leaf', 'virtual-leaf', { active: isGroupsScope }]"
        :data-test="`ou-groups-${node.dn}`"
        @click="emit('selectGroups', node.dn)"
      >
        <span class="caret-empty">·</span>
        <span class="leaf-icon">🛡️</span>
        <span class="leaf-label">组 ({{ node.groupCount }})</span>
      </li>
      <!-- R158.44.7.10 — 电脑虚拟节点 (3rd object class) -->
      <li
        :class="['tree-leaf', 'virtual-leaf', { active: isComputersScope }]"
        :data-test="`ou-computers-${node.dn}`"
        @click="emit('selectComputers', node.dn)"
      >
        <span class="caret-empty">·</span>
        <span class="leaf-icon">💻</span>
        <span class="leaf-label">电脑 ({{ node.computerCount }})</span>
      </li>
    </ul>
  </li>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  node: { type: Object, required: true },
  selectedDn: { type: String, default: '' },
  selectedKind: { type: String, default: '' },
  expandedDnSet: { type: Set, default: () => new Set() },
  filterText: { type: String, default: '' }
});
const emit = defineEmits(['select', 'selectBuiltin', 'selectUsers', 'selectGroups', 'selectComputers', 'toggleExpand']);

const isExpanded = computed(() => props.expandedDnSet.has(props.node.dn));
const isUsersScope = computed(() =>
  props.selectedKind === 'user' && props.selectedDn === props.node.dn
);
const isGroupsScope = computed(() =>
  props.selectedKind === 'group' && props.selectedDn === props.node.dn
);
// R158.44.7.10 — 电脑 scope (3rd virtual-leaf)
const isComputersScope = computed(() =>
  props.selectedKind === 'computer' && props.selectedDn === props.node.dn
);

// renderLabel: 过滤字符串高亮匹配子串 (保持 HTML 转义安全).
function renderLabel(name) {
  const q = (props.filterText || '').trim();
  if (!q) return escapeHtml(name);
  const lower = name.toLowerCase();
  const ql = q.toLowerCase();
  const idx = lower.indexOf(ql);
  if (idx < 0) return escapeHtml(name);
  const before = name.slice(0, idx);
  const match = name.slice(idx, idx + q.length);
  const after = name.slice(idx + q.length);
  return `${escapeHtml(before)}<mark>${escapeHtml(match)}</mark>${escapeHtml(after)}`;
}
// 逐字符 replace 链, 1:1 平行 PackageRunsMonitorView.vue:687-693 /
// MemberServerPackagesView.vue:554-560 (全仓仅有的 2 个正确实现).
//
// ⚠ 本函数此前是「对象映射表」写法, 且 5 个映射里 4 个的值**等于 key 本身**
//   ('&':'&', '<':'<', '>':'>', '"':'"'), 等于没转义 —— 只有 '&#39;' 是对的.
//   配合 renderLabel 的 `v-html` (line 44) = 存储型 XSS: OU 对象的 name
//   属性来自 AD 目录, 有 OU 创建权的账号可写任意内容 (AD 允许把该权限
//   下放给非 Domain Admin 的组), 一条 <img src=x onerror=...> 的 OU 名
//   会打中每个打开 OU 树页面的管理员.
//   不要改回映射表写法 —— 逐字符链的价值在于每个替换独立可读, 改错一个
//   立刻看得出来, 而映射表里 '&':'&' 这种自映射**看起来是对的**.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
</script>

<style scoped>
.ou-tree-node {
  list-style: none;
}
.tree-leaf {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  font-size: 13px;
  color: var(--text);
  cursor: pointer;
  border-radius: 3px;
  border-left: 2px solid transparent;
  margin-left: -1px;
  transition: background 0.12s ease, color 0.12s ease, border-left-color 0.12s ease;
}
.tree-leaf:hover { background: var(--border); color: var(--accent); }
.tree-leaf.active {
  background: rgba(96, 165, 250, 0.14);
  color: #60a5fa;
  border-left-color: #3b82f6;
  font-weight: 600;
}
.caret {
  width: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: var(--muted);
  cursor: pointer;
  user-select: none;
}
.caret:hover { color: var(--accent); }
.caret-empty {
  width: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 11px;
}
.leaf-icon { font-size: 12px; opacity: 0.85; }
.leaf-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.leaf-label :deep(mark) {
  background: rgba(245, 158, 11, 0.30);
  color: #f59e0b;
  padding: 0 1px;
  border-radius: 1px;
}
.leaf-meta {
  font-size: 10px;
  color: var(--muted);
  background: var(--input-bg);
  border: 1px solid var(--border);
  padding: 1px 5px;
  border-radius: 2px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.meta-piece { white-space: nowrap; }
.meta-sep { color: var(--border); margin: 0 1px; }
.meta-users { color: #60a5fa; }
.meta-groups { color: #94a3b8; }
.meta-computers { color: #f59e0b; }
.leaf-meta.builtin-meta {
  background: rgba(148, 163, 184, 0.18);
  color: #94a3b8;
}
.tree-list {
  list-style: none;
  padding: 4px 0 4px 14px;
  margin: 0;
  border-left: 1px solid var(--border);
}
.virtual-list {
  padding-top: 0;
  padding-bottom: 6px;
}
.virtual-leaf {
  font-size: 12px;
  color: var(--muted);
}
.virtual-leaf .leaf-icon { opacity: 0.6; }
.virtual-leaf:hover {
  color: var(--accent);
}
.is-builtin .builtin-leaf {
  background: rgba(148, 163, 184, 0.06);
  cursor: pointer;
}
.is-builtin .builtin-leaf:hover {
  background: rgba(148, 163, 184, 0.18);
  color: #94a3b8;
}
.is-builtin .builtin-leaf.active {
  background: rgba(96, 165, 250, 0.10);
  color: #60a5fa;
  border-left-color: #60a5fa;
}
</style>
