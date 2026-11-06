<template>
  <div :class="['node', node.kind, `depth-${depth}`]">
    <!-- Leaf: metric / op / value -->
    <template v-if="node.kind === 'leaf'">
      <div class="leaf-row">
        <select v-model="node.metric">
          <option v-for="m in METRICS" :key="m.v" :value="m.v">{{ m.label }}</option>
        </select>
        <select v-model="node.op">
          <option v-for="o in OPS" :key="o.v" :value="o.v">{{ o.label }}</option>
        </select>
        <input type="number" v-model.number="node.value" class="val-input" />
        <button class="remove" @click="emit('remove')">×</button>
      </div>
    </template>

    <!-- R158.63 — CONSECUTIVE leaf. metric dropdown + cmp dropdown +
         threshold value + count of consecutive samples. The kernel
         reads last N samples of `metric` and requires all N to
         satisfy `cmp value`. -->
    <template v-else-if="node.kind === 'consecutive'">
      <div class="leaf-row">
        <span class="badge-c">连续</span>
        <input type="number" v-model.number="node.count" class="cnt-input" min="1" max="64" />
        <span class="badge-c">次</span>
        <select v-model="node.cmp">
          <option v-for="o in CONSECUTIVE_OPS" :key="o.v" :value="o.v">{{ o.label }}</option>
        </select>
        <input type="number" v-model.number="node.value" class="val-input" />
        <select v-model="node.metric" class="metric-small">
          <option v-for="m in CONSECUTIVE_METRICS" :key="m.v" :value="m.v">{{ m.label }}</option>
        </select>
        <button class="remove" @click="emit('remove')">×</button>
      </div>
    </template>

    <!-- Group: nested AND/OR + children + add buttons -->
    <template v-else>
      <div class="group-head">
        <div class="seg small">
          <button :class="{ on: node.op === 'AND' }" @click="node.op = 'AND'">所有</button>
          <button :class="{ on: node.op === 'OR' }" @click="node.op = 'OR'">任一</button>
        </div>
        <span class="group-label">子组</span>
        <button class="remove" @click="emit('remove')">×</button>
      </div>
      <div class="group-children">
        <RuleNodeEditor
          v-for="(child, idx) in node.children"
          :key="child._key"
          :node="child"
          :depth="depth + 1"
          :index="idx"
          :siblings="node.children"
          @remove="removeChild(idx)"
        />
        <div class="add-buttons">
          <button @click="addCondition">+ 条件</button>
          <button @click="addGroup">+ 子组</button>
          <button @click="addConsecutive">+ 连续 (CONSECUTIVE)</button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import RuleNodeEditor from './RuleNodeEditor.vue';

const props = defineProps({
  node: { type: Object, required: true },
  depth: { type: Number, default: 0 },
  index: { type: Number, default: 0 },
  siblings: { type: Array, default: () => [] }
});
const emit = defineEmits(['remove']);

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
// R158.63 — CONSECUTIVE metric dropdown. Only metrics with a tail-N
// sample series are listed (port_latency_ms from the new
// ad_member_port_latency package). cpu_pct etc. are point-in-time
// gauges; CONSECUTIVE wouldn't make sense on them.
const CONSECUTIVE_METRICS = [
  { v: 'port_latency_ms', label: '端口延迟 (ms)' }
];
const CONSECUTIVE_OPS = [
  { v: 'GT', label: '大于' },
  { v: 'LT', label: '小于' }
];

function removeChild(idx) {
  props.node.children.splice(idx, 1);
}

let counter = 1000;
function nextKey() { return `n${++counter}`; }

function addCondition() {
  props.node.children.push({
    _key: nextKey(),
    kind: 'leaf',
    metric: 'cpu_pct',
    op: 'GT',
    value: 80
  });
}
function addGroup() {
  props.node.children.push({
    _key: nextKey(),
    kind: 'group',
    op: 'AND',
    children: [{
      _key: nextKey(),
      kind: 'leaf',
      metric: 'cpu_pct',
      op: 'GT',
      value: 80
    }]
  });
}
function addConsecutive() {
  props.node.children.push({
    _key: nextKey(),
    kind: 'consecutive',
    metric: 'port_latency_ms',
    cmp: 'GT',
    value: 100,
    count: 5
  });
}
</script>

<style scoped>
.node { margin: 4px 0; }
.leaf-row { display: flex; align-items: center; gap: 6px; }
.leaf-row select, .leaf-row input { background: var(--sidebar-bg); color: var(--text); border: 1px solid var(--border); padding: 4px 6px; border-radius: 3px; font-size: 12px; }
.leaf-row .val-input { width: 80px; }
.leaf-row .cnt-input { width: 50px; }
.leaf-row .metric-small { min-width: 140px; }
.leaf-row .remove, .group-head .remove { background: transparent; color: var(--red); border: 1px solid var(--border); cursor: pointer; padding: 2px 8px; border-radius: 3px; }
.badge-c { color: var(--muted); font-size: 11px; }
.consecutive { background: var(--sidebar-bg); border: 1px dashed var(--accent); border-radius: 3px; padding: 4px 6px; }
.group { background: var(--sidebar-bg); border: 1px solid var(--border); border-radius: 3px; padding: 6px; }
.group-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.group-label { color: var(--muted); font-size: 12px; }
.seg.small button { background: var(--border); color: var(--text); border: 1px solid var(--border); padding: 2px 8px; cursor: pointer; font-size: 12px; }
.seg.small button:first-child { border-radius: 3px 0 0 3px; }
.seg.small button:last-child { border-radius: 0 3px 3px 0; border-left: 0; }
.seg.small button.on { background: var(--accent); color: var(--sidebar-bg); }
.group-children { margin-left: 12px; padding-left: 8px; border-left: 2px solid var(--border); }
.add-buttons { display: flex; gap: 6px; margin-top: 4px; }
.add-buttons button { background: var(--border); color: var(--text); border: 1px solid var(--border); padding: 2px 8px; font-size: 11px; }
</style>