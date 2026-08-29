<!--
  R66 T10 — EditScriptModal.vue

  Single-textarea modal for replacing the body of an existing script.
  Backend computes the new sha256; if it matches the existing one the
  service returns noOp:true and we still close (the operator's intent
  was "make this change" — even if the change is a no-op).

  data-test contract:
    edit-script-modal      — modal root
    edit-script-name       — read-only name label
    edit-script-input      — textarea
    edit-script-submit     — submit button
    edit-script-cancel     — cancel button
    edit-script-error      — inline error display
-->
<template>
  <div class="modal-bg" @click.self="cancel">
    <div class="modal" data-test="edit-script-modal">
      <header><h3>编辑脚本</h3></header>
      <section class="form-body">
        <div class="field">
          <span class="label">脚本名称</span>
          <code class="name-tag" data-test="edit-script-name">{{ item?.name }}</code>
        </div>
        <label class="field">
          <span class="label">脚本内容 (collect.ps1) <em>*</em></span>
          <textarea
            v-model="content"
            data-test="edit-script-input"
            rows="18"
            required
            maxlength="1048576"
            placeholder="粘贴替换后的 PowerShell 脚本"
          />
        </label>
        <p class="hint">后端会重新计算 sha256;若内容未变则审计日志会标记 noOp。</p>
        <p v-if="error" class="error" data-test="edit-script-error">{{ error }}</p>
      </section>
      <footer>
        <button type="button" data-test="edit-script-cancel" @click="cancel" :disabled="submitting">取消</button>
        <button
          type="button"
          data-test="edit-script-submit"
          class="primary"
          @click="submit"
          :disabled="submitting"
        >{{ submitting ? '保存中…' : '保存' }}</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { packagesApi } from '../../api/packages.js';

const props = defineProps({
  item: { type: Object, required: true }
});
const emit = defineEmits(['close', 'saved']);

// Initialize from the item's content if provided, otherwise empty. The
// list endpoint (GET /api/admin/packages) does not include script_content
// (it's LONGTEXT and would balloon the payload), so the modal typically
// opens with an empty textarea and the operator pastes the new body.
const content = ref(props.item?.scriptContent || '');
const error = ref('');
const submitting = ref(false);

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
.field .label { color: var(--muted); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }
.field .label em { color: var(--red); font-style: normal; margin-left: 2px; }
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
