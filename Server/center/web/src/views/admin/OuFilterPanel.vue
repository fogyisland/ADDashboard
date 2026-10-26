<!--
  R158.45.32 (2026-10-05) — OuFilterPanel.vue
  顶级 OU (depth=0) 选中时的右栏筛选面板. 输入关键字 → emit filter-change
  → DailyOpsView 写 ouFilter → OuScopedView :filter prop 同步 → 中栏立刻过滤.

  Props:
    ouNode        — { dn, name, depth, userCount, groupCount, computerCount }
    appliedFilter — 当前已生效的 filter 字符串 (父 ouFilter), 用于 "应用到中栏"
                     按钮 disabled 判定 + 顶部 toolbar input 显示同步.

  Emits:
    filter-change(string) — 新 filter 字符串 (含空串 = 清除)

  注: filter 是 client-side filter, 匹配字段 = 跟 OuScopedView filtered* 一样
  (name ∪ dn ∪ description + user displayName/sam/desc + group cn/name/desc +
   computer cn/samAccountName/operatingSystem/description). 不走 LDAP filter
  (operator 之前明确说「不需要 ldap filter」).
-->
<template>
  <div class="ou-filter-panel" data-test="ou-filter-panel">
    <header class="ofp-head">
      <h3>OU 子树筛选</h3>
      <span class="ofp-hint">
        中栏显示 OU=<strong>{{ ouNode?.name }}</strong> 子树匹配关键字的对象
      </span>
    </header>

    <label class="ofp-label">
      <span>关键字</span>
      <input
        ref="inputEl"
        v-model="localFilter"
        placeholder="例 销售 / jdoe / Windows"
        data-test="ou-filter-input"
        @keyup.enter="apply"
      />
    </label>

    <div class="ofp-actions">
      <button
        type="button"
        class="btn-primary"
        data-test="ofp-apply"
        :disabled="localFilter === props.appliedFilter"
        @click="apply"
      >应用到中栏</button>
      <button
        type="button"
        class="btn-secondary"
        data-test="ofp-clear"
        :disabled="!props.appliedFilter"
        @click="clear"
      >清除</button>
    </div>

    <p class="ofp-tip">
      匹配字段: 用户 <code>displayName / sAMAccountName / description</code>,
      组 <code>cn / description</code>, 电脑 <code>cn / samAccountName / operatingSystem</code>,
      子 OU <code>name / dn / description</code>.
    </p>

    <p v-if="props.appliedFilter" class="ofp-current">
      当前已应用: <strong>{{ props.appliedFilter }}</strong>
      <span class="ofp-current-meta">— 中栏已过滤显示</span>
    </p>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue';

const props = defineProps({
  ouNode: { type: Object, default: null },
  appliedFilter: { type: String, default: '' }
});
const emit = defineEmits(['filter-change']);

const inputEl = ref(null);
const localFilter = ref(props.appliedFilter);

// 父 appliedFilter 变化 (例如别的 OU 切换清空) → 同步本地 input.
watch(() => props.appliedFilter, (v) => {
  localFilter.value = v;
});

function apply() {
  emit('filter-change', localFilter.value);
}
function clear() {
  localFilter.value = '';
  emit('filter-change', '');
}
</script>

<style scoped>
.ou-filter-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ofp-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 8px;
}
.ofp-head h3 { margin: 0; font-size: 14px; }
.ofp-hint { font-size: 11px; color: var(--muted); }
.ofp-hint strong { color: var(--text); font-weight: 600; }

.ofp-label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 12px;
  color: var(--muted);
}
.ofp-label input {
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
}
.ofp-label input:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.3);
}

.ofp-actions {
  display: flex;
  gap: 6px;
}
.btn-primary {
  padding: 5px 12px;
  border: none;
  border-radius: 3px;
  background: #3b82f6;
  color: white;
  font-size: 12px;
  cursor: pointer;
}
.btn-primary:hover:not(:disabled) { background: #2563eb; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-secondary {
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--input-bg);
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
}
.btn-secondary:hover:not(:disabled) { background: rgba(96, 165, 250, 0.08); }
.btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }

.ofp-tip {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.5;
  margin: 0;
  padding: 6px 8px;
  background: var(--input-bg);
  border-radius: 3px;
}
.ofp-tip code {
  font-family: monospace;
  background: var(--bg);
  padding: 1px 4px;
  border-radius: 2px;
}

.ofp-current {
  font-size: 12px;
  margin: 0;
  padding: 6px 10px;
  background: rgba(59, 130, 246, 0.10);
  border: 1px solid rgba(59, 130, 246, 0.3);
  border-radius: 3px;
  color: #60a5fa;
}
.ofp-current strong {
  color: #93c5fd;
  font-weight: 600;
}
.ofp-current-meta {
  color: var(--muted);
  font-size: 11px;
  margin-left: 4px;
}
</style>
