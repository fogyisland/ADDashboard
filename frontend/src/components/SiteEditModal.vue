<template>
  <div class="modal-bg" @click.self="$emit('cancel')">
    <div class="modal">
      <h3>{{ site.id ? '编辑站点' : '新建站点' }}</h3>
      <label>站点名 *<input v-model="form.siteName" /></label>
      <label>区域代码<input v-model="form.regionCode" /></label>
      <label><input type="checkbox" v-model="form.isHub" /> 枢纽站点</label>
      <label>说明<textarea v-model="form.description"></textarea></label>
      <div class="actions">
        <button @click="$emit('cancel')">取消</button>
        <button @click="save" :disabled="!form.siteName">保存</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive } from 'vue';
const props = defineProps({ site: { type: Object, required: true } });
const emit = defineEmits(['save', 'cancel']);
const form = reactive({
  id: props.site.id,
  siteName: props.site.siteName || '',
  regionCode: props.site.regionCode || '',
  isHub: !!props.site.isHub,
  description: props.site.description || ''
});
function save() { emit('save', { ...form }); }
</script>

<style scoped>
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--panel); padding: 20px; border-radius: 6px; min-width: 400px; }
.modal h3 { margin: 0 0 12px; }
.modal label { display: block; margin-bottom: 10px; font-size: 13px; }
.modal input[type=text], .modal input:not([type]), .modal textarea { width: 100%; padding: 6px; background: #0b1220; color: var(--text); border: 1px solid #1e293b; border-radius: 3px; }
.actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
</style>
