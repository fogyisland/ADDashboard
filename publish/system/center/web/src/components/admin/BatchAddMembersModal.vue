<!--
  2026-09-03 R77 — BatchAddMembersModal.vue.

  Modal that lets the operator pick a list of sAMAccountNames to add to
  every selected group. Like BatchPasswordResetModal but the parsed
  sams list applies to N groups (one group_add_member row per group,
  each carrying the SAME sams list — explicit R77 UX concession).

  Body:
    - Subhead "将下列成员添加到 N 个选中的组"
    - <textarea> for sAMAccountNames (one per line OR comma-separated)
    - Parsed preview chip row showing recognized sams (trim, dedupe,
      drop empty lines)

  Emits `submit({ sams: string[] })` with the parsed array; the parent
  fans out one `group_add_member` per selected group (when mode='add')
  or one `group_remove_member` per selected group (when mode='remove').

  data-test contract (matched by group-management-bulk.test.js):
    batch-add-members-modal
    batch-add-members-count       — "将添加到 N 个组" (add mode) / "将从 N 个组移除" (remove mode)
    batch-add-members-input
    batch-add-members-chips       — preview chip row (visible when sams parsed)
    batch-add-members-empty       — placeholder when input is empty
    batch-add-members-submit
    batch-add-members-cancel
-->
<template>
  <div class="modal-bg" @click.self="cancel">
    <div class="modal" data-test="batch-add-members-modal">
      <header><h3>{{ mode === 'remove' ? '批量移除成员' : '批量添加成员' }}</h3></header>
      <section class="form-body">
        <p class="hint" data-test="batch-add-members-count">
          将{{ mode === 'remove' ? '从' : '向' }} <strong>{{ groupsCount }}</strong> 个选中的组{{ mode === 'remove' ? '移除下列' : '添加下列' }}
          <strong>{{ samsPreview.length }}</strong> 个成员
        </p>
        <label class="field">
          <span class="label">sAMAccountName 列表 <em>*</em></span>
          <textarea
            data-test="batch-add-members-input"
            v-model="raw"
            rows="6"
            placeholder="alice&#10;bob, carol&#10;dave"
            :disabled="submitting"
          ></textarea>
          <small class="hint">每行一个，或用逗号 / 空格分隔；空白 / 重复自动去除</small>
        </label>

        <div class="chips" v-if="samsPreview.length > 0" data-test="batch-add-members-chips">
          <span v-for="s in samsPreview" :key="s" class="chip">{{ s }}</span>
        </div>
        <div v-else class="empty" data-test="batch-add-members-empty">请输入至少一个 sAMAccountName</div>

        <p v-if="formError" class="error">{{ formError }}</p>
      </section>
      <footer>
        <button type="button" data-test="batch-add-members-cancel" @click="cancel" :disabled="submitting">取消</button>
        <button
          type="button"
          data-test="batch-add-members-submit"
          :class="['primary', mode === 'remove' ? 'danger' : '']"
          @click="submit"
          :disabled="submitting || samsPreview.length === 0"
        >{{ mode === 'remove' ? '移除' : '添加' }} ({{ samsPreview.length }})</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';

const props = defineProps({
  // 'add' (default) — emits submit; parent fans out group_add_member.
  // 'remove'        — emits submit; parent fans out group_remove_member.
  // Single component serves both flows because the input + parsing is
  // identical (R77 UX concession — only the resulting commandType
  // differs on the parent side).
  mode: { type: String, default: 'add', validator: (v) => v === 'add' || v === 'remove' },
  // Number of selected groups (used in the subhead copy + button label).
  groupsCount: { type: Number, default: 0 }
});
const emit = defineEmits(['close', 'submit']);

const raw = ref('');
const formError = ref('');
const submitting = ref(false);

// Parse the textarea into a deduped, non-empty string list. Accepts
// either newline OR comma OR whitespace separators (matches the R75
// GroupMembersModal.parseMembers convention — same UX surface, same
// parsing rule).
function parseSams(input) {
  if (typeof input !== 'string') return [];
  const seen = new Set();
  const out = [];
  for (const part of input.split(/[\s,]+/)) {
    const s = part.trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

const samsPreview = computed(() => parseSams(raw.value));

function submit() {
  formError.value = '';
  const sams = samsPreview.value;
  if (sams.length === 0) { formError.value = '请输入至少一个 sAMAccountName'; return; }
  submitting.value = true;
  emit('submit', { sams: [...sams] });
  // Parent closes the modal after the emit lands (it owns the queue
  // call + toast). submitting stays true until unmount.
}

function cancel() {
  if (submitting.value) return;
  emit('close');
}
</script>

<style scoped>
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; min-width: 480px; max-width: 640px; max-height: 90vh; display: flex; flex-direction: column; }
.modal header { padding: 12px 18px; border-bottom: 1px solid var(--border); }
.modal header h3 { margin: 0; font-size: 15px; }
.form-body { padding: 14px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
.hint { color: var(--muted); font-size: 12px; margin: 0; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.field .label { color: var(--muted); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }
.field .label em { color: var(--red); font-style: normal; margin-left: 2px; }
textarea {
  background: var(--input-bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 3px;
  padding: 6px 8px; font-size: 13px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  resize: vertical;
}
textarea:focus { outline: 2px solid var(--accent); border-color: var(--accent); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 0; }
.chip {
  display: inline-block;
  padding: 2px 8px;
  background: rgba(96, 165, 250, 0.15);
  color: #60a5fa;
  border-radius: 10px;
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-weight: 600;
}
.empty { color: var(--muted); font-size: 12px; padding: 4px 0; }
.error { background: rgba(239, 68, 68, 0.15); color: #dc2626; padding: 6px 10px; border-radius: 3px; border: 1px solid rgba(239, 68, 68, 0.3); font-size: 12px; margin: 0; }
.modal footer { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 18px; border-top: 1px solid var(--border); }
.modal footer button { padding: 6px 14px; border: 1px solid var(--border); background: var(--input-bg); color: var(--text); border-radius: 3px; cursor: pointer; font-size: 13px; }
.modal footer button.primary { background: var(--accent); color: #0b1220; border-color: var(--accent); }
.modal footer button.primary.danger { background: var(--red); color: #0b1220; border-color: var(--red); }
.modal footer button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>