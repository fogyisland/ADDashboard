<template>
  <AdminLayout>
    <h2>用户管理</h2>
    <div class="bar">
      <button @click="openCreate">+ 新建</button>
    </div>
    <table class="t">
      <thead><tr><th>ID</th><th>用户名</th><th>角色</th><th>状态</th><th>最后登录</th><th>操作</th></tr></thead>
      <tbody>
        <tr v-for="u in users" :key="u.id">
          <td>{{ u.id }}</td>
          <td>{{ u.username }}</td>
          <td>{{ u.roleName }}</td>
          <td>{{ u.status ? '启用' : '禁用' }}</td>
          <td>{{ fmt(u.lastLoginAt) }}</td>
          <td>
            <button @click="openEdit(u)">编辑</button>
            <button @click="openReset(u)">重置密码</button>
            <button class="danger" @click="del(u)">删除</button>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="editing" class="modal-bg" @click.self="editing=null">
      <div class="modal">
        <h3>{{ editing.id ? '编辑用户' : '新建用户' }}</h3>
        <label>用户名 <input v-model="editing.username" :disabled="!!editing.id" /></label>
        <label v-if="!editing.id">密码 <input v-model="editing.password" type="password" /></label>
        <label>角色
          <select v-model.number="editing.role_id">
            <option v-for="r in roles" :key="r.id" :value="r.id">{{ r.roleName }}</option>
          </select>
        </label>
        <label>状态 <select v-model.number="editing.status"><option :value="1">启用</option><option :value="0">禁用</option></select></label>
        <div class="actions">
          <button @click="save">保存</button>
          <button @click="editing=null">取消</button>
        </div>
      </div>
    </div>
    <div v-if="resetting" class="modal-bg" @click.self="closeReset">
      <div class="modal reset-modal">
        <h3>重置密码 — {{ resetting.username }}</h3>
        <label>新密码 <input v-model="newPassword" type="password" autocomplete="new-password" /></label>
        <label>确认新密码 <input v-model="confirmPassword" type="password" autocomplete="new-password" /></label>
        <p v-if="resetError" class="err">{{ resetError }}</p>
        <p class="hint">重置后该用户需用新密码重新登录。</p>
        <div class="actions">
          <button @click="doReset">确认重置</button>
          <button @click="closeReset">取消</button>
        </div>
      </div>
    </div>
  </AdminLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { adminApi } from '../../api/admin.js';
const users = ref([]); const roles = ref([]); const editing = ref(null);
const resetting = ref(null);
const newPassword = ref('');
const confirmPassword = ref('');
const resetError = ref('');
function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }
async function load() { users.value = (await adminApi.listUsers()).data; roles.value = (await adminApi.listRoles()).data; }
function openCreate() { editing.value = { username: '', password: '', role_id: roles.value[0]?.id, status: 1 }; }
function openEdit(u) { editing.value = { id: u.id, username: u.username, role_id: roles.value.find(r => r.roleName === u.roleName)?.id, status: u.status ? 1 : 0 }; }
async function save() {
  if (editing.value.id) await adminApi.updateUser(editing.value.id, { roleId: editing.value.role_id, status: editing.value.status });
  else await adminApi.createUser({ username: editing.value.username, password: editing.value.password, roleId: editing.value.role_id, status: editing.value.status });
  editing.value = null; await load();
}
async function del(u) { if (confirm(`确认删除 ${u.username}？`)) { await adminApi.deleteUser(u.id); await load(); } }

function openReset(u) {
  resetting.value = { id: u.id, username: u.username };
  newPassword.value = '';
  confirmPassword.value = '';
  resetError.value = '';
}
function closeReset() { resetting.value = null; }
async function doReset() {
  // Same floor the init wizard enforces when creating the first admin.
  if (newPassword.value.length < 8) { resetError.value = '密码至少 8 位'; return; }
  if (newPassword.value !== confirmPassword.value) { resetError.value = '两次输入不一致'; return; }
  try {
    // Only send password — roleId/status omitted so the backend COALESCE keeps them.
    await adminApi.updateUser(resetting.value.id, { password: newPassword.value });
    closeReset();
  } catch (e) {
    resetError.value = '重置失败，请重试';
  }
}
onMounted(load);
</script>

<style scoped>
.t { width: 100%; border-collapse: collapse; background: var(--panel); }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
.bar { margin-bottom: 12px; }
.danger { background: var(--red); color: white; margin-left: 6px; }
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; }
.modal { background: var(--panel); padding: 24px; border-radius: 8px; min-width: 360px; display: flex; flex-direction: column; gap: 10px; }
.modal label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--muted); }
.actions { display: flex; gap: 8px; margin-top: 8px; }
.reset-modal .err { color: var(--red); font-size: 12px; margin: 0; }
.reset-modal .hint { color: var(--muted); font-size: 12px; margin: 0; }
</style>
