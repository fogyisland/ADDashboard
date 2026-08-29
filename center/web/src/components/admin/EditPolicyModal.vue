<!--
  R66 T10 — EditPolicyModal.vue

  Edits the execution policy for a script (intervalSec / timeoutMs /
  enabled / scope). The backend's PUT /api/admin/packages/:name/policy
  accepts a partial body — only the keys present are written — so this
  modal always sends the full current state, even when the operator
  only flipped one knob.

  Pre-populates every input from the `item` prop so the operator can
  tweak without retyping.

  data-test contract:
    edit-policy-modal        — modal root
    policy-name              — read-only name label
    policy-interval          — intervalSec number input
    policy-timeout           — timeoutMs number input
    policy-enabled           — enabled checkbox
    policy-scope             — scope select
    policy-submit            — submit button
    policy-cancel            — cancel button
    policy-error             — inline error display
-->
<template>
  <div class="modal-bg" @click.self="cancel">
    <div class="modal" data-test="edit-policy-modal">
      <header><h3>编辑策略</h3></header>
      <section class="form-body">
        <div class="field">
          <span class="label">脚本名称</span>
          <code class="name-tag" data-test="policy-name">{{ item?.name }}</code>
        </div>
        <div class="field-row">
          <label class="field">
            <span class="label">执行间隔 (秒)</span>
            <input
              v-model.number="intervalSec"
              data-test="policy-interval"
              type="number"
              min="5"
              max="86400"
              step="1"
            />
          </label>
          <label class="field">
            <span class="label">执行超时 (毫秒)</span>
            <input
              v-model.number="timeoutMs"
              data-test="policy-timeout"
              type="number"
              min="1000"
              max="600000"
              step="1"
            />
          </label>
        </div>
        <label class="checkbox-field">
          <input
            type="checkbox"
            v-model="enabled"
            data-test="policy-enabled"
          />
          <span>启用</span>
        </label>
        <label class="field">
          <span class="label">作用范围</span>
          <select v-model="scope" data-test="policy-scope">
            <option value="global">global</option>
            <option value="agent_type:ad">agent_type:ad</option>
            <option value="agent_type:non-ad">agent_type:non-ad</option>
          </select>
        </label>
        <p v-if="error" class="error" data-test="policy-error">{{ error }}</p>
      </section>
      <footer>
        <button type="button" data-test="policy-cancel" @click="cancel" :disabled="submitting">取消</button>
        <button
          type="button"
          data-test="policy-submit"
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

// Pre-populate from the item prop. Fall back to the safe defaults the
// backend uses when a policy row is missing — these match the values
// the operator sees in the table when enabled=false / intervalSec=null.
const intervalSec = ref(
  props.item?.intervalSec != null ? Number(props.item.intervalSec) : 3600
);
const timeoutMs = ref(
  props.item?.timeoutMs != null ? Number(props.item.timeoutMs) : 30000
);
const enabled = ref(!!props.item?.enabled);
const scope = ref(props.item?.scope || 'global');
const error = ref('');
const submitting = ref(false);

function validate() {
  if (!props.item?.name) return '缺少脚本名称';
  if (!Number.isInteger(intervalSec.value) || intervalSec.value < 5 || intervalSec.value > 86400) {
    return 'intervalSec 必须是 5..86400 的整数';
  }
  if (!Number.isInteger(timeoutMs.value) || timeoutMs.value < 1000 || timeoutMs.value > 600000) {
    return 'timeoutMs 必须是 1000..600000 的整数';
  }
  if (!['global', 'agent_type:ad', 'agent_type:non-ad'].includes(scope.value)) {
    return 'scope 必须是 global / agent_type:ad / agent_type:non-ad';
  }
  return null;
}

async function submit() {
  error.value = '';
  const v = validate();
  if (v) { error.value = v; return; }
  submitting.value = true;
  try {
    await packagesApi.setPolicy(props.item.name, {
      intervalSec: intervalSec.value,
      timeoutMs: timeoutMs.value,
      enabled: enabled.value,
      scope: scope.value
    });
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
  min-width: 460px; max-width: 580px;
  display: flex; flex-direction: column;
}
.modal header { padding: 14px 18px; border-bottom: 1px solid #1e293b; }
.modal header h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--text); }
.form-body { padding: 14px 18px; display: flex; flex-direction: column; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; flex: 1; }
.field .label { color: var(--muted); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }
.field-row { display: flex; gap: 12px; }
.field input, .field select {
  background: #0b1220; color: var(--text);
  border: 1px solid #334155; border-radius: 3px;
  padding: 6px 8px; font-size: 13px;
}
.field input:focus, .field select:focus { outline: 2px solid var(--accent); border-color: var(--accent); }
.checkbox-field { display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--text); }
.name-tag {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px; padding: 6px 10px;
  background: #0b1220; border: 1px solid #334155; border-radius: 3px;
  color: var(--accent);
}
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
