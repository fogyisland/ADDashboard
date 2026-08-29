<!--
  R66 T10 — UploadScriptModal.vue

  Replaces the legacy "+ 上传本地包" ZIP-upload flow on PackagesView.
  Operator pastes raw PS1 collect.ps1 body + picks a metric type +
  default policy. Backend (POST /api/admin/packages/upload-script) owns
  the schema validation; we mirror the same AJV constraints here so the
  operator gets the error inline without a round-trip.

  data-test contract (matched by tests/packages-view.test.js):
    upload-modal           — modal root
    upload-name-input      — script name input
    upload-type-select     — metric type select
    upload-agent-select    — agent type select
    upload-description-input
    upload-interval-input  — intervalSec number
    upload-timeout-input   — timeoutMs number
    upload-content-input   — script body textarea
    upload-submit          — submit button
    upload-cancel          — cancel button
    upload-error           — inline error display
-->
<template>
  <div class="modal-bg" @click.self="cancel">
    <div class="modal" data-test="upload-modal">
      <header><h3>上传脚本</h3></header>
      <section class="form-body">
        <label class="field">
          <span class="label">名称 <em>*</em></span>
          <input
            v-model="name"
            data-test="upload-name-input"
            required
            pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*"
            placeholder="如 cpu-monitor"
            maxlength="128"
          />
        </label>
        <div class="field-row">
          <label class="field">
            <span class="label">类型</span>
            <select v-model="type" data-test="upload-type-select">
              <option value="gauge">gauge</option>
              <option value="counter">counter</option>
              <option value="status">status</option>
              <option value="timeseries">timeseries</option>
            </select>
          </label>
          <label class="field">
            <span class="label">Agent</span>
            <select v-model="agentType" data-test="upload-agent-select">
              <option value="ad">AD</option>
              <option value="non-ad">非AD</option>
            </select>
          </label>
        </div>
        <label class="field">
          <span class="label">描述</span>
          <input
            v-model="description"
            data-test="upload-description-input"
            maxlength="1024"
            placeholder="选填"
          />
        </label>
        <div class="field-row">
          <label class="field">
            <span class="label">执行间隔 (秒)</span>
            <input
              v-model.number="intervalSec"
              data-test="upload-interval-input"
              type="number"
              min="5"
              max="86400"
              step="1"
              required
            />
          </label>
          <label class="field">
            <span class="label">执行超时 (毫秒)</span>
            <input
              v-model.number="timeoutMs"
              data-test="upload-timeout-input"
              type="number"
              min="1000"
              max="600000"
              step="1"
              required
            />
          </label>
        </div>
        <label class="field">
          <span class="label">脚本内容 (collect.ps1) <em>*</em></span>
          <textarea
            v-model="content"
            data-test="upload-content-input"
            rows="14"
            required
            maxlength="1048576"
            placeholder="粘贴 PowerShell 脚本"
          />
        </label>
        <p v-if="error" class="error" data-test="upload-error">{{ error }}</p>
      </section>
      <footer>
        <button type="button" data-test="upload-cancel" @click="cancel" :disabled="submitting">取消</button>
        <button
          type="button"
          data-test="upload-submit"
          class="primary"
          @click="submit"
          :disabled="submitting"
        >{{ submitting ? '提交中…' : '提交' }}</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { packagesApi } from '../../api/packages.js';

const emit = defineEmits(['close', 'uploaded']);

const name = ref('');
const type = ref('gauge');
const agentType = ref('ad');
const description = ref('');
const intervalSec = ref(3600);
const timeoutMs = ref(30000);
const content = ref('');
const error = ref('');
const submitting = ref(false);

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

// Mirror the T7 backend AJV constraints client-side. We surface the same
// message verbatim so the operator doesn't see two different error
// strings for the same problem.
function validate() {
  if (!name.value || !NAME_RE.test(name.value)) {
    return '名称必须是 ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ 且长度 3..128';
  }
  if (!content.value || content.value.length === 0) {
    return '脚本内容不能为空';
  }
  if (content.value.length > 1024 * 1024) {
    return '脚本内容超过 1 MB 上限';
  }
  if (!Number.isInteger(intervalSec.value) || intervalSec.value < 5 || intervalSec.value > 86400) {
    return 'intervalSec 必须是 5..86400 的整数';
  }
  if (!Number.isInteger(timeoutMs.value) || timeoutMs.value < 1000 || timeoutMs.value > 600000) {
    return 'timeoutMs 必须是 1000..600000 的整数';
  }
  return null;
}

async function submit() {
  error.value = '';
  const v = validate();
  if (v) { error.value = v; return; }
  submitting.value = true;
  try {
    await packagesApi.uploadScript({
      name: name.value,
      type: type.value,
      agentType: agentType.value,
      description: description.value,
      intervalSec: intervalSec.value,
      timeoutMs: timeoutMs.value,
      content: content.value
    });
    emit('uploaded');
    emit('close');
  } catch (e) {
    error.value = e?.response?.data?.error || e?.response?.data?.details?.[0]?.message || '提交失败';
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
  min-width: 520px; max-width: 720px; max-height: 90vh;
  display: flex; flex-direction: column;
}
.modal header { padding: 14px 18px; border-bottom: 1px solid #1e293b; }
.modal header h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--text); }
.form-body { padding: 14px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; flex: 1; }
.field .label { color: var(--muted); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }
.field .label em { color: var(--red); font-style: normal; margin-left: 2px; }
.field-row { display: flex; gap: 12px; }
.field input, .field select, .field textarea {
  background: #0b1220; color: var(--text);
  border: 1px solid #334155; border-radius: 3px;
  padding: 6px 8px; font-size: 13px; font-family: inherit;
}
.field textarea {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px; min-height: 220px; resize: vertical;
}
.field input:focus, .field select:focus, .field textarea:focus {
  outline: 2px solid var(--accent); outline-offset: 0; border-color: var(--accent);
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
