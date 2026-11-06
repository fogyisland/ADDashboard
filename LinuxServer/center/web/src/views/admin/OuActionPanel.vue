<!--
  R158.40 (2026-10-03) — OuActionPanel.vue
  OU 选中时的右栏写动作面板. 4 个动作:
    [+ 创建子 OU]    — ou_create        (parentDn=this.dn)
    [+ 创建用户]     — user_create      (ouPath=this.dn)
    [+ 创建组]       — group_create     (ouPath=this.dn)
    [删除 OU]        — object_delete    (targetDn=this.dn, 仅空 OU 才允许)

  Props:
    dc          — 选中的 DC hostname
    ouNode      — { dn, name, parentDn, description, children, userCount, groupCount }
    submitting  — 父组件持的 submitting flag (避免重复提交), 默认 false

  Emits:
    submit-command({ commandType, params })  — 父组件调 adAdminApi.queueCommand

  Builtin 容器走 prop `disabledAll=true` 整体禁用 (R158.40 不允许创建/删除内置容器).

  二次确认对话框 (R158.40 §8.6 + R158.37 lesson):
    删除 OU 时, 必须输入对象名匹配才允许. OU 删除前额外检查 children.length
    === 0 && userCount === 0 && groupCount === 0, 否则禁用按钮 + 提示.

  持久 lesson (R158.37.3): 整文件 Write, 纯 UTF-8 无 BOM.
-->
<template>
  <div class="ou-action-panel" data-test="ou-action-panel">
    <header class="oap-head">
      <h3>{{ disabledAll ? 'Builtin 容器' : 'OU 操作' }}</h3>
      <span v-if="disabledAll" class="builtin-tag">只读</span>
    </header>

    <div v-if="disabledAll" class="builtin-notice">
      ⚙️ CN=Builtin 是 AD 内置容器, 不允许创建 / 删除 / 重命名.
      右栏仅提供只读查看 (内置组列表见中栏).
    </div>

    <div v-if="!disabledAll" class="oap-form-stack">
      <!-- 创建子 OU -->
      <details class="action-block" :open="openBlock === 'create-ou'" @toggle="onToggle('create-ou', $event)">
        <summary class="action-summary">
          <span class="act-icon">📂</span>
          <span class="act-title">创建子 OU</span>
          <span class="act-meta">ou_create</span>
        </summary>
        <form class="action-form" @submit.prevent="submitCreateOu">
          <label class="form-label">
            <span>OU 名</span>
            <input v-model="forms.createOu.name" placeholder="例如 Sales" required maxlength="64" />
          </label>
          <label class="form-label">
            <span>描述 (可选)</span>
            <input v-model="forms.createOu.description" placeholder="例如 销售部 OU" />
          </label>
          <div class="form-actions">
            <button type="submit" class="btn-primary" :disabled="submitting || !forms.createOu.name">
              {{ submitting ? '提交中…' : '创建' }}
            </button>
            <span v-if="forms.createOu.lastResult" :class="['action-result', forms.createOu.lastResult.ok ? 'ok' : 'err']">
              {{ forms.createOu.lastResult.text }}
            </span>
          </div>
        </form>
      </details>

      <!-- 创建用户 -->
      <details class="action-block" :open="openBlock === 'create-user'" @toggle="onToggle('create-user', $event)">
        <summary class="action-summary">
          <span class="act-icon">👥</span>
          <span class="act-title">创建用户</span>
          <span class="act-meta">user_create</span>
        </summary>
        <form class="action-form" @submit.prevent="submitCreateUser">
          <label class="form-label">
            <span>sAMAccountName</span>
            <input v-model="forms.createUser.sam" placeholder="例如 jdoe" required maxlength="64" />
          </label>
          <label class="form-label">
            <span>初始密码</span>
            <input v-model="forms.createUser.password" type="password" required autocomplete="new-password" />
          </label>
          <label class="form-label form-checkbox">
            <input type="checkbox" v-model="forms.createUser.mustChange" />
            <span>下次登录必须修改密码</span>
          </label>
          <label class="form-label">
            <span>显示名称 (可选)</span>
            <input v-model="forms.createUser.displayName" placeholder="例如 张三" />
          </label>
          <label class="form-label">
            <span>描述 (可选)</span>
            <input v-model="forms.createUser.description" placeholder="例如 销售部" />
          </label>
          <div class="form-actions">
            <button type="submit" class="btn-primary" :disabled="submitting || !forms.createUser.sam || !forms.createUser.password">
              {{ submitting ? '提交中…' : '创建' }}
            </button>
            <span v-if="forms.createUser.lastResult" :class="['action-result', forms.createUser.lastResult.ok ? 'ok' : 'err']">
              {{ forms.createUser.lastResult.text }}
            </span>
          </div>
        </form>
      </details>

      <!-- 创建组 -->
      <details class="action-block" :open="openBlock === 'create-group'" @toggle="onToggle('create-group', $event)">
        <summary class="action-summary">
          <span class="act-icon">🛡️</span>
          <span class="act-title">创建组</span>
          <span class="act-meta">group_create</span>
        </summary>
        <form class="action-form" @submit.prevent="submitCreateGroup">
          <label class="form-label">
            <span>组名</span>
            <input v-model="forms.createGroup.name" placeholder="例如 Sales-Admins" required maxlength="64" />
          </label>
          <label class="form-label">
            <span>类型 (category)</span>
            <select v-model="forms.createGroup.category">
              <option value="Security">Security (安全组)</option>
              <option value="Distribution">Distribution (通讯组)</option>
            </select>
          </label>
          <label class="form-label">
            <span>作用域 (scope)</span>
            <select v-model="forms.createGroup.scope">
              <option value="Global">Global (全局)</option>
              <option value="Universal">Universal (通用)</option>
              <option value="DomainLocal">DomainLocal (本域本地)</option>
            </select>
          </label>
          <label class="form-label">
            <span>描述 (可选)</span>
            <input v-model="forms.createGroup.description" />
          </label>
          <div class="form-actions">
            <button type="submit" class="btn-primary" :disabled="submitting || !forms.createGroup.name">
              {{ submitting ? '提交中…' : '创建' }}
            </button>
            <span v-if="forms.createGroup.lastResult" :class="['action-result', forms.createGroup.lastResult.ok ? 'ok' : 'err']">
              {{ forms.createGroup.lastResult.text }}
            </span>
          </div>
        </form>
      </details>

      <!-- 删除 OU (危险动作) — R158.56c (2026-10-08) operator directive
           临时禁用: "将ad_object_delete 删除, 当前我们不需要删除对象,
           避免出错删除对象". 包仍在 data/packages/ad_ad_object_delete/1.0.0/
           (以后一键恢复), 但 BUILTIN_PACKAGES 注释 + ad-admin.js
           PACKAGE_COMMAND_MAP + 中心 POST /api/admin/ad-commands 3 处都拒,
           防止误操作. UI 整块置灰 + 提示原因, 防止前端 bug 绕过后端 whitelist. -->
      <details class="action-block danger-block disabled" :open="openBlock === 'delete-ou'" @toggle="onToggle('delete-ou', $event)">
        <summary class="action-summary">
          <span class="act-icon">🗑️</span>
          <span class="act-title">删除 OU</span>
          <span class="act-meta">object_delete (临时禁用)</span>
        </summary>
        <div class="action-form">
          <div class="warn-block" data-test="delete-ou-disabled">
            ⚠️ 删除对象功能已临时停用, 避免误删。当前不需要该功能, 暂时关闭;
            界面按钮与后台命令接口均已禁用。未来需要时可一键恢复。
          </div>
        </div>
      </details>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue';

const props = defineProps({
  dc: { type: String, default: '' },
  ouNode: { type: Object, default: () => null },
  submitting: { type: Boolean, default: false },
  disabledAll: { type: Boolean, default: false }
});
const emit = defineEmits(['submit-command']);

// 互斥展开: 同一时刻仅一个 details 打开.
const openBlock = ref('create-ou');
function onToggle(key, e) {
  if (e.target.open) openBlock.value = key;
}

const forms = reactive({
  createOu: { name: '', description: '', lastResult: null },
  createUser: { sam: '', password: '', mustChange: true, displayName: '', description: '', lastResult: null },
  createGroup: { name: '', category: 'Security', scope: 'Global', description: '', lastResult: null },
  deleteOu: { confirmText: '', lastResult: null }
});

// isEmptyOu: children=0 + userCount=0 + groupCount=0. PS1 用 -Recursive
// 兜底 (R158.40 collect.ps1 object_delete §line 105), 但前端禁用按钮先防御.
const isEmptyOu = computed(() => {
  if (!props.ouNode) return false;
  const c = props.ouNode.children?.length ?? 0;
  const u = props.ouNode.userCount ?? 0;
  const g = props.ouNode.groupCount ?? 0;
  return c === 0 && u === 0 && g === 0;
});

// ouNode 切换时清空表单 (避免上一个 OU 的残留).
watch(() => props.ouNode?.dn, () => {
  forms.createOu.name = '';
  forms.createOu.description = '';
  forms.createOu.lastResult = null;
  forms.createUser.sam = '';
  forms.createUser.password = '';
  forms.createUser.displayName = '';
  forms.createUser.description = '';
  forms.createUser.lastResult = null;
  forms.createGroup.name = '';
  forms.createGroup.description = '';
  forms.createGroup.lastResult = null;
  forms.deleteOu.confirmText = '';
  forms.deleteOu.lastResult = null;
});

// ── 提交 (调父组件统一处理: adAdminApi.queueCommand) ──────────────────
function setResult(formKey, ok, text) {
  forms[formKey].lastResult = { ok, text };
}
function submitCreateOu() {
  if (!forms.createOu.name || !props.ouNode) return;
  emit('submit-command', {
    commandType: 'ou_create',
    params: {
      parentDn: props.ouNode.dn,
      name: forms.createOu.name.trim(),
      description: forms.createOu.description?.trim() || null
    },
    onResult: (r) => setResult('createOu', r.ok, r.text)
  });
}
function submitCreateUser() {
  if (!forms.createUser.sam || !forms.createUser.password || !props.ouNode) return;
  emit('submit-command', {
    commandType: 'user_create',
    params: {
      sam: forms.createUser.sam.trim(),
      password: forms.createUser.password,
      mustChangePassword: forms.createUser.mustChange,
      displayName: forms.createUser.displayName?.trim() || null,
      description: forms.createUser.description?.trim() || null,
      ouPath: props.ouNode.dn
    },
    onResult: (r) => setResult('createUser', r.ok, r.text)
  });
}
function submitCreateGroup() {
  if (!forms.createGroup.name || !props.ouNode) return;
  emit('submit-command', {
    commandType: 'group_create',
    params: {
      name: forms.createGroup.name.trim(),
      category: forms.createGroup.category,
      scope: forms.createGroup.scope,
      description: forms.createGroup.description?.trim() || null,
      ouPath: props.ouNode.dn
    },
    onResult: (r) => setResult('createGroup', r.ok, r.text)
  });
}
function submitDeleteOu() {
  // R158.56c (2026-10-08) — operator directive "将ad_object_delete 删除".
  // UI 整块已置灰 (.action-block.disabled) + pointer-events:none,
  // 此函数永远不会被调用, 但加 early-return 防御性兜底, 防止未来前端
  // 重构去掉 disabled class 时误发送 commandType: object_delete.
  // 中心端 POST /api/admin/ad-commands 也加了 whitelist reject 兜底
  // (admin.js:1820-1826), 三层防御.
  console.warn('[R158.56c] submitDeleteOu called but object_delete is disabled — ignoring');
  return;
}
</script>

<style scoped>
.ou-action-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.oap-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
  padding-bottom: 6px;
}
.oap-head h3 { margin: 0; font-size: 14px; }
.builtin-tag {
  font-size: 10px;
  background: rgba(148, 163, 184, 0.18);
  color: #94a3b8;
  padding: 2px 6px;
  border-radius: 2px;
}
.builtin-notice {
  font-size: 12px;
  color: var(--muted);
  padding: 12px;
  background: var(--input-bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  line-height: 1.6;
}
.oap-form-stack {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.action-block {
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--input-bg);
}
.action-block.danger-block { border-color: rgba(248, 113, 113, 0.4); }
/* R158.56c — 整块置灰, 防止 operator 误点. cursor not-allowed 视觉提示. */
.action-block.disabled {
  opacity: 0.55;
  pointer-events: none;
  filter: grayscale(0.5);
}
.action-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  font-size: 13px;
  cursor: pointer;
  list-style: none;
  user-select: none;
  border-radius: 4px;
  transition: background 0.12s ease;
}
.action-summary:hover { background: rgba(96, 165, 250, 0.08); }
.action-summary::-webkit-details-marker { display: none; }
.act-icon { font-size: 13px; }
.act-title { font-weight: 600; flex: 1 1 auto; }
.act-meta {
  font-family: monospace;
  font-size: 10px;
  color: var(--muted);
  background: var(--bg);
  border: 1px solid var(--border);
  padding: 1px 5px;
  border-radius: 2px;
}
.action-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 12px 12px;
  border-top: 1px solid var(--border);
}
.form-label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 12px;
  color: var(--muted);
}
.form-label input,
.form-label select {
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
}
.form-checkbox {
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
.form-checkbox input { margin: 0; }
.form-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 2px;
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
.btn-danger {
  padding: 5px 12px;
  border: none;
  border-radius: 3px;
  background: #dc2626;
  color: white;
  font-size: 12px;
  cursor: pointer;
}
.btn-danger:hover:not(:disabled) { background: #b91c1c; }
.btn-danger:disabled { opacity: 0.4; cursor: not-allowed; }
.action-result {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 2px;
}
.action-result.ok  { background: rgba(34, 197, 94, 0.15);  color: var(--green); }
.action-result.err { background: rgba(248, 113, 113, 0.15); color: #f87171; }
.warn-block {
  font-size: 12px;
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.10);
  border: 1px solid rgba(245, 158, 11, 0.4);
  padding: 8px 10px;
  border-radius: 3px;
  line-height: 1.5;
}
.confirm-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.confirm-hint {
  font-size: 12px;
  margin: 0;
  color: var(--muted);
  line-height: 1.5;
}
.confirm-hint code {
  background: var(--bg);
  padding: 1px 4px;
  border-radius: 2px;
  font-family: monospace;
}
.confirm-hint strong { color: var(--text); }
</style>
