<template>
  <div class="modal-bg" @click.self="close">
    <div class="modal">
      <h3>{{ server.mode === 'edit' ? '编辑非 AD 服务器' : '新建非 AD 服务器' }}</h3>

      <div class="row">
        <label>主机名 <span class="req">*</span></label>
        <input
          v-model="form.hostname"
          :disabled="server.mode === 'edit'"
          placeholder="WIN-MEMBER-01"
        />
      </div>
      <div class="row">
        <label>所属站点</label>
        <select v-model="form.siteId">
          <option :value="null">未分配</option>
          <option v-for="s in sites" :key="s.id" :value="s.id">{{ s.siteName }}</option>
        </select>
      </div>
      <div class="row">
        <label>IP 地址</label>
        <input v-model="form.ipAddress" placeholder="10.1.2.3" />
      </div>
      <div class="row">
        <label>OS 版本</label>
        <input v-model="form.osVersion" placeholder="Windows Server 2022" />
      </div>
      <div class="row">
        <label>启用</label>
        <input type="checkbox" v-model="form.enabled" />
      </div>

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
import { ref } from 'vue';
import { adminApi } from '../api/admin.js';

const props = defineProps({
  server: { type: Object, required: true },
  sites: { type: Array, default: () => [] }
});
const emit = defineEmits(['save', 'cancel']);

const form = ref({
  hostname: props.server.hostname || '',
  siteId: props.server.siteId ?? null,
  ipAddress: props.server.ipAddress || '',
  osVersion: props.server.osVersion || '',
  enabled: props.server.enabled !== false
});
const busy = ref(false);
const error = ref('');

function close() { emit('cancel'); }

async function onSubmit() {
  error.value = '';
  const hostname = (form.value.hostname || '').trim();
  if (!hostname) {
    error.value = 'hostname 必填';
    return;
  }
  busy.value = true;
  try {
    const payload = { ...props.server, ...form.value, hostname };
    await emit('save', payload);
  } catch (e) {
    error.value = e.response?.data?.error || e.message || String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--panel); padding: 20px; border-radius: 6px; min-width: 480px; max-width: 90vw; }
.modal h3 { margin: 0 0 12px; }
.row { display: flex; align-items: center; margin-bottom: 8px; gap: 8px; }
.row label { width: 100px; color: var(--muted); font-size: 13px; }
.row input, .row select { flex: 1; background: #0b1220; color: var(--text); border: 1px solid #1e293b; padding: 6px 8px; border-radius: 3px; }
.row input[type=checkbox] { flex: none; width: auto; }
.req { color: var(--red); }
.error { color: var(--red); font-size: 13px; margin: 8px 0; }
.actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.primary { background: var(--accent); color: white; }
</style>
