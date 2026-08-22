<template>
  <div v-if="visible" class="modal-bg" @click.self="$emit('close')">
    <div class="modal">
      <header><h3>卸载确认: {{ packageName }}</h3></header>
      <section>
        <p>将删除 schema <code>{{ schemaName }}</code> 及其全部数据({{ metricRowCount }} 行 metric 记录)。此操作不可撤销。</p>
        <label>
          <input type="checkbox" data-test="confirm-checkbox" v-model="confirmed" />
          我已审查 DDL,确认删除
        </label>
      </section>
      <footer>
        <button @click="$emit('close')">取消</button>
        <button data-test="confirm" :disabled="!confirmed" @click="$emit('confirm', { confirmDropSchema: true })">确认卸载</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
defineProps({ visible: Boolean, packageName: String, schemaName: String, metricRowCount: { type: Number, default: 0 } });
defineEmits(['close', 'confirm']);
const confirmed = ref(false);
</script>

<style scoped>
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; }
.modal { background: var(--panel); padding: 1.5em; border-radius: 6px; max-width: 600px; }
header h3 { margin: 0 0 12px; }
footer { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
label { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
code { background: #0b1220; padding: 1px 4px; border-radius: 2px; }
</style>
