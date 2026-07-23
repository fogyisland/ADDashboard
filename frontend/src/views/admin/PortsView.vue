<template>
  <AppLayout>
    <h2>端口健康检查</h2>
    <p class="hint">每个 Agent 都会探测下列端口（127.0.0.1 TCP connect，2s 超时）。新增/删除大约 10 分钟内自动生效。</p>
    <button class="new-btn" @click="openCreate">+ 新增端口</button>
    <table class="t">
      <thead>
        <tr><th>ID</th><th>端口</th><th>标签</th><th>排序</th><th>操作</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id">
          <td>{{ row.id }}</td>
          <td>{{ row.port }}</td>
          <td>{{ row.label }}</td>
          <td>{{ row.sortOrder }}</td>
          <td>
            <button class="edit-btn" @click="edit(row)">编辑</button>
            <button class="del-btn"  @click="remove(row)">删除</button>
          </td>
        </tr>
        <tr v-if="!rows.length"><td colspan="5" class="empty">暂无端口 — 点击"新增端口"开始</td></tr>
      </tbody>
    </table>

    <div v-if="editing" class="modal-bg" @click.self="cancel">
      <div class="modal">
        <h3>{{ form.id ? '编辑端口' : '新增端口' }}</h3>
        <label>端口 *<input type="number" v-model.number="form.port" :min="1" :max="65535" /></label>
        <label>标签 *<input v-model="form.label" /></label>
        <label>排序<input type="number" v-model.number="form.sortOrder" /></label>
        <div class="actions">
          <button @click="cancel">取消</button>
          <button class="save-btn" @click="save" :disabled="saving">{{ saving ? '保存中...' : '保存' }}</button>
        </div>
        <span v-if="msg" class="msg">{{ msg }}</span>
      </div>
    </div>
  </AppLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import AppLayout from '../../components/AppLayout.vue';
import { portsApi } from '../../api/ports.js';

const rows = ref([]);
const editing = ref(null);
const form = ref({ id: null, port: null, label: '', sortOrder: 0 });
const saving = ref(false);
const msg = ref('');

async function load() {
  const { data } = await portsApi.list();
  rows.value = data || [];
}

function openCreate() {
  form.value = { id: null, port: null, label: '', sortOrder: 0 };
  editing.value = true;
  msg.value = '';
}
function edit(row) {
  form.value = { id: row.id, port: row.port, label: row.label, sortOrder: row.sortOrder };
  editing.value = true;
  msg.value = '';
}
function cancel() {
  editing.value = null;
  msg.value = '';
}

async function save() {
  saving.value = true;
  msg.value = '';
  try {
    const body = {
      port: form.value.port,
      label: form.value.label,
      sortOrder: form.value.sortOrder
    };
    if (form.value.id) {
      await portsApi.update(form.value.id, body);
    } else {
      await portsApi.create(body);
    }
    editing.value = null;
    await load();
  } catch (e) {
    msg.value = (e?.response?.data?.error) || '保存失败';
  } finally {
    saving.value = false;
  }
}

async function remove(row) {
  if (!confirm(`删除端口 ${row.port} (${row.label})?`)) return;
  try {
    await portsApi.remove(row.id);
    await load();
  } catch (e) {
    msg.value = (e?.response?.data?.error) || '删除失败';
  }
}

onMounted(load);
</script>

<style scoped>
.t { width: 100%; border-collapse: collapse; background: var(--panel); margin-top: 12px; }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
.empty { text-align: center; color: var(--muted); padding: 24px; }
.hint { color: var(--muted); font-size: 13px; margin: 0 0 12px; }
.new-btn { margin-bottom: 12px; }

.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--panel); padding: 20px; border-radius: 6px; min-width: 400px; }
.modal h3 { margin: 0 0 12px; }
.modal label { display: block; margin-bottom: 10px; font-size: 13px; }
.modal input[type=number], .modal input:not([type]) { width: 100%; padding: 6px; background: #0b1220; color: var(--text); border: 1px solid #1e293b; border-radius: 3px; }
.actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.msg { display: block; margin-top: 10px; color: var(--accent); font-size: 13px; }
</style>