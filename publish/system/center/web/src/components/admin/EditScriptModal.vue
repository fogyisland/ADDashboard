<!--
  R66 T10 — EditScriptModal.vue (default mode = replace script body)
  R67-T1    — viewMode prop (read-only view of the currently-installed body)

  Default mode opens with an empty textarea (the list endpoint omits the
  LONGTEXT script_content); the operator pastes the replacement body and
  the backend computes the new sha256. If sha matches the existing one the
  service returns noOp:true and we still close (operator intent was "make
  this change" — even if it's a no-op).

  viewMode=true (R67-T1) auto-fetches the script body via
  GET /api/admin/packages/:name/script on mount, renders it in a readonly
  textarea, and exposes only the Close button — the operator can inspect
  what is currently installed before deciding to replace it. Every
  successful fetch emits a view_script audit row on the backend.

  data-test contract (default mode):
    edit-script-modal      — modal root
    edit-script-name       — read-only name label
    edit-script-input      — textarea
    edit-script-submit     — submit button
    edit-script-cancel     — cancel button
    edit-script-error      — inline error display

  data-test contract (viewMode=true):
    edit-script-modal-view — modal root (variant)
    edit-script-name       — read-only name label
    edit-script-input      — readonly textarea (pre-filled)
    edit-script-cancel     — close button (only footer action)
    edit-script-error      — inline fetch-error display
-->
<template>
  <div class="modal-bg" @click.self="cancel">
    <div
      class="modal"
      :data-test="viewMode ? 'edit-script-modal-view' : 'edit-script-modal'"
    >
      <header><h3>{{ viewMode ? '查看脚本' : '编辑脚本' }}</h3></header>
      <section class="form-body">
        <div class="field">
          <span class="label">脚本名称</span>
          <code class="name-tag" data-test="edit-script-name">{{ item?.name }}</code>
        </div>
        <label class="field">
          <span class="label">
            脚本内容 (collect.ps1) <em v-if="!viewMode">*</em>
            <span v-if="viewMode && scriptSha" class="sha-hint">sha256: {{ scriptSha.slice(0, 12) }}…</span>
          </span>
          <textarea
            v-model="content"
            data-test="edit-script-input"
            rows="18"
            :readonly="viewMode || loading"
            :required="!viewMode"
            maxlength="1048576"
            :placeholder="viewMode ? '加载中…' : '粘贴替换后的 PowerShell 脚本'"
          />
        </label>
        <p class="hint" v-if="!viewMode">后端会重新计算 sha256;若内容未变则审计日志会标记 noOp。</p>
        <p class="hint" v-else>只读视图 — 关闭后如需修改请点 脚本 进入编辑模式。每次查看均会写入审计日志(view_script)。</p>
        <p v-if="error" class="error" data-test="edit-script-error">{{ error }}</p>
      </section>
      <footer>
        <button type="button" data-test="edit-script-cancel" @click="cancel" :disabled="submitting">
          {{ viewMode ? '关闭' : '取消' }}
        </button>
        <button
          v-if="!viewMode"
          type="button"
          data-test="edit-script-submit"
          class="primary"
          @click="submit"
          :disabled="submitting || loading"
        >{{ submitting ? '保存中…' : '保存' }}</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { packagesApi } from '../../api/packages.js';

const props = defineProps({
  item: { type: Object, required: true },
  // R67-T1 — when true, the modal becomes a read-only viewer:
  // auto-fetches the script body, renders in readonly textarea,
  // hides the Save button. Closes via the same `close` emit.
  viewMode: { type: Boolean, default: false }
});
const emit = defineEmits(['close', 'saved']);

// Default mode starts empty (list endpoint omits LONGTEXT script_content);
// viewMode is filled in by the onMounted fetch below.
const content = ref(props.viewMode ? '' : (props.item?.scriptContent || ''));
const scriptSha = ref(props.item?.scriptSha256 || '');
const error = ref('');
const submitting = ref(false);
const loading = ref(false);

function validate() {
  if (!props.item?.name) return '缺少脚本名称';
  if (!content.value || content.value.length === 0) return '脚本内容不能为空';
  if (content.value.length > 1024 * 1024) return '脚本内容超过 1 MB 上限';
  return null;
}

async function submit() {
  error.value = '';
  const v = validate();
  if (v) { error.value = v; return; }
  submitting.value = true;
  try {
    await packagesApi.editScript(props.item.name, { content: content.value });
    emit('saved');
    emit('close');
  } catch (e) {
    error.value = e?.response?.data?.error || e?.response?.data?.details?.[0]?.message || '保存失败';
  } finally {
    submitting.value = false;
  }
}

function cancel() { emit('close'); }

// R67-T1 — viewMode path. Fetch the full script body once on mount so the
// operator can see what is currently installed (the list endpoint's
// `script_content` column is intentionally omitted to keep payloads small).
// Every successful fetch is audit-trailed on the backend as `view_script`.
onMounted(async () => {
  if (!props.viewMode) return;
  loading.value = true;
  error.value = '';
  try {
    const r = await packagesApi.getScript(props.item.name);
    content.value = r.data?.scriptContent || '';
    scriptSha.value = r.data?.scriptSha256 || scriptSha.value;
  } catch (e) {
    error.value = e?.response?.data?.error || '加载脚本内容失败';
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.modal-bg {
  position: fixed; inset: 0; background: rgba(0,0,0,0.55);
  display: flex; align-items: center; justify-content: center; z-index: 1000;
}
.modal {
  background: var(--panel); border: 1px solid #1e293b; border-radius: 6px;
  min-width: 560px; max-width: 760px; max-height: 90vh;
  display: flex; flex-direction: column;
}
.modal header { padding: 14px 18px; border-bottom: 1px solid #1e293b; }
.modal header h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--text); }
.form-body { padding: 14px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.field .label { color: var(--muted); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; display: flex; gap: 8px; align-items: baseline; }
.field .label em { color: var(--red); font-style: normal; margin-left: 2px; }
.sha-hint {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px; letter-spacing: 0; text-transform: none;
  color: var(--muted); font-weight: 400;
}
.name-tag {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px; padding: 6px 10px;
  background: #0b1220; border: 1px solid #334155; border-radius: 3px;
  color: var(--accent);
}
.field textarea {
  background: #0b1220; color: var(--text);
  border: 1px solid #334155; border-radius: 3px;
  padding: 6px 8px; font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  min-height: 280px; resize: vertical;
}
/* view-mode textarea: slightly muted so the readonly distinction reads */
.field textarea[readonly] {
  background: #060d18; color: var(--text); cursor: default;
  border-color: #1e293b;
}
.field textarea:focus { outline: 2px solid var(--accent); border-color: var(--accent); }
.hint { color: var(--muted); font-size: 11px; margin: 0; }
.error {
  background: var(--red-bg); color: var(--red);
  padding: 8px 10px; border-radius: 3px;
  border: 1px solid rgba(239, 68, 68, 0.3);
  font-size: 12px; margin: 0;
}
.modal footer {
  display: flex; gap: 8px; justify-content: flex-end;
  padding: 12px 18px; border-top: 1px solid #1e293b;
}
.modal footer button {
  padding: 6px 14px; border: 1px solid #1e293b;
  background: #0b1220; color: var(--text); border-radius: 3px;
  cursor: pointer; font-size: 13px;
}
.modal footer button.primary { background: var(--accent); color: #0b1220; border-color: var(--accent); }
.modal footer button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
