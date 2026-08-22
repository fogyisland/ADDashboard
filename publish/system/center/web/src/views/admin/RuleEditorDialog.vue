<template>
  <div class="modal-bg" @click.self="close">
    <div class="modal">
      <h3>{{ rule && rule.rule_id ? '编辑告警规则' : '新建告警规则' }}</h3>

      <div class="row">
        <label>规则名 <span class="req">*</span></label>
        <input v-model="form.name" placeholder="CPU 持续高负载" />
      </div>

      <div class="row">
        <label>组合方式</label>
        <div class="seg">
          <button :class="{ on: rootOp === 'AND' }" @click="rootOp = 'AND'">所有 (AND)</button>
          <button :class="{ on: rootOp === 'OR' }" @click="rootOp = 'OR'">任一 (OR)</button>
        </div>
      </div>

      <div class="children-block">
        <RuleNodeEditor
          v-for="(child, idx) in rootChildren"
          :key="child._key"
          :node="child"
          :depth="0"
          :index="idx"
          :siblings="rootChildren"
          @remove="removeChild(idx)"
        />
        <div class="add-buttons">
          <button @click="addCondition">+ 条件</button>
          <button @click="addGroup">+ 子组</button>
        </div>
      </div>

      <div class="footer-grid">
        <div class="row">
          <label>持续 (分钟)</label>
          <input type="number" min="0" v-model.number="form.for_minutes" />
        </div>
        <div class="row">
          <label>冷却 (分钟)</label>
          <input type="number" min="0" v-model.number="form.cooldown_minutes" />
        </div>
        <div class="row">
          <label>启用</label>
          <input type="checkbox" v-model="form.enabled" />
        </div>
      </div>

      <details class="recipients-block">
        <summary>收件人覆盖 (可选)</summary>
        <div class="row">
          <label>收件人</label>
          <input
            v-model="form.recipients"
            placeholder="ops@corp.local, sre@corp.local"
          />
        </div>
        <p class="hint">留空 = 使用 SMTP 默认 alert_default_to。多个地址逗号分隔。</p>
      </details>

      <div v-if="error" class="error">{{ error }}</div>

      <div class="actions">
        <button @click="close">取消</button>
        <button class="primary" :disabled="busy" @click="onSubmit">
          {{ busy ? '保存中...' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue';
import RuleNodeEditor from './RuleNodeEditor.vue';
import { adminApi } from '../../api/admin.js';

// Props:
//   rule: { rule_id?, hostname, name, condition, for_minutes,
//           cooldown_minutes, recipients, enabled } | null
// On save, emits `save` with the built payload; parent decides to call
// adminApi.upsertAlertRule itself (or we do it here — see below).
const props = defineProps({
  rule: { type: Object, default: null }
});
const emit = defineEmits(['save', 'cancel']);

const METRICS = [
  { v: 'cpu_pct',       label: 'CPU 使用率 (%)' },
  { v: 'memory_pct',    label: '内存使用率 (%)' },
  { v: 'disk_free',     label: '磁盘剩余 (MB)' },
  { v: 'heartbeat_stale', label: '心跳失联 (秒数)' },
  { v: 'service_state', label: '服务状态 (0/1)' },
  { v: 'event_log',     label: '事件日志计数' }
];
const OPS = [
  { v: 'GT',  label: '大于 (>)' },
  { v: 'LT',  label: '小于 (<)' },
  { v: 'EQ',  label: '等于 (=)' },
  { v: 'NEQ', label: '不等于 (≠)' }
];

// Form state
const form = ref({
  name: '',
  for_minutes: 5,
  cooldown_minutes: 30,
  recipients: '',
  enabled: true
});
const rootOp = ref('AND');
const rootChildren = ref([]);
const busy = ref(false);
const error = ref('');

// Counter for stable keys in v-for. Increment on every new node.
let keyCounter = 0;
function nextKey() { return `n${++keyCounter}`; }

function initFromRule() {
  if (!props.rule) {
    form.value = { name: '', for_minutes: 5, cooldown_minutes: 30, recipients: '', enabled: true };
    rootOp.value = 'AND';
    rootChildren.value = [makeCondition()];
    return;
  }
  const r = props.rule;
  form.value = {
    name: r.name || '',
    for_minutes: r.for_minutes ?? 5,
    cooldown_minutes: r.cooldown_minutes ?? 30,
    recipients: r.recipients || '',
    enabled: r.enabled !== 0 && r.enabled !== false
  };
  // Condition can be an object (from API) or stringified JSON.
  let cond = r.condition;
  if (typeof cond === 'string') {
    try { cond = JSON.parse(cond); } catch { cond = null; }
  }
  if (cond && (cond.op === 'AND' || cond.op === 'OR') && Array.isArray(cond.children)) {
    rootOp.value = cond.op;
    rootChildren.value = cond.children.map(rehydrate);
  } else {
    rootOp.value = 'AND';
    rootChildren.value = [makeCondition()];
  }
}

function makeCondition() {
  return { _key: nextKey(), kind: 'leaf', metric: 'cpu_pct', op: 'GT', value: 80 };
}
function makeGroup() {
  return {
    _key: nextKey(),
    kind: 'group',
    op: 'AND',
    children: [makeCondition()]
  };
}

function rehydrate(node) {
  if (!node) return makeCondition();
  if ((node.op === 'AND' || node.op === 'OR') && Array.isArray(node.children)) {
    return {
      _key: nextKey(),
      kind: 'group',
      op: node.op,
      children: node.children.map(rehydrate)
    };
  }
  return {
    _key: nextKey(),
    kind: 'leaf',
    metric: node.metric || 'cpu_pct',
    op: node.op || 'GT',
    value: node.value ?? 0
  };
}

function addCondition() { rootChildren.value.push(makeCondition()); }
function addGroup() { rootChildren.value.push(makeGroup()); }
function removeChild(idx) { rootChildren.value.splice(idx, 1); }

function buildPayload() {
  const tree = {
    op: rootOp.value,
    children: rootChildren.value.map(stripKey)
  };
  return {
    hostname: props.rule?.hostname || '',
    name: form.value.name.trim(),
    condition: JSON.stringify(tree),
    for_minutes: form.value.for_minutes,
    cooldown_minutes: form.value.cooldown_minutes,
    recipients: form.value.recipients.trim() || null,
    enabled: form.value.enabled
  };
}
function stripKey(n) {
  if (n.kind === 'group') return { op: n.op, children: n.children.map(stripKey) };
  return { metric: n.metric, op: n.op, value: n.value };
}

async function onSubmit() {
  error.value = '';
  const name = (form.value.name || '').trim();
  if (!name) {
    error.value = '规则名必填';
    return;
  }
  if (!props.rule?.hostname) {
    error.value = 'hostname 缺失 (父组件未传入)';
    return;
  }
  busy.value = true;
  try {
    const payload = buildPayload();
    await adminApi.upsertAlertRule(payload);
    emit('save', { ...props.rule, ...payload, condition: JSON.parse(payload.condition) });
  } catch (e) {
    error.value = e.response?.data?.error || e.message || String(e);
  } finally {
    busy.value = false;
  }
}

function close() { emit('cancel'); }

watch(() => props.rule, initFromRule, { immediate: true });
</script>

<style scoped>
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--panel); padding: 20px; border-radius: 6px; min-width: 560px; max-width: 90vw; max-height: 90vh; overflow-y: auto; }
.modal h3 { margin: 0 0 12px; }
.row { display: flex; align-items: center; margin-bottom: 8px; gap: 8px; }
.row label { width: 110px; color: var(--muted); font-size: 13px; }
.row input, .row select { flex: 1; background: #0b1220; color: var(--text); border: 1px solid #1e293b; padding: 6px 8px; border-radius: 3px; }
.row input[type=checkbox] { flex: none; width: auto; }
.seg { display: flex; gap: 0; }
.seg button { background: #0b1220; color: var(--text); border: 1px solid #1e293b; padding: 6px 12px; cursor: pointer; }
.seg button:first-child { border-radius: 3px 0 0 3px; }
.seg button:last-child { border-radius: 0 3px 3px 0; border-left: 0; }
.seg button.on { background: var(--accent); color: #0b1220; }
.children-block { background: #0b1220; border: 1px solid #1e293b; border-radius: 3px; padding: 8px; margin: 8px 0; }
.add-buttons { display: flex; gap: 8px; margin-top: 6px; }
.add-buttons button { background: #1e293b; color: var(--text); border: 1px solid #334155; padding: 4px 10px; font-size: 12px; }
.footer-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-top: 8px; }
.footer-grid .row { margin-bottom: 0; }
.footer-grid label { width: 80px; }
.recipients-block { margin-top: 8px; }
.recipients-block summary { cursor: pointer; color: var(--muted); font-size: 13px; }
.recipients-block .hint { color: var(--muted); font-size: 12px; margin: 4px 0 0 118px; }
.req { color: var(--red); }
.error { color: var(--red); font-size: 13px; margin: 8px 0; }
.actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.primary { background: var(--accent); color: white; }
</style>