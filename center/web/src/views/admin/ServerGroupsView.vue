<template>
  <AdminLayout>
    <h2>非 AD 服务器组</h2>
    <p class="hint">
      <code>ad_server_groups</code> 是分组成员主表 — 可对整组应用包安装 / 卸载 / 启用 / 禁用
      (后端走单条 SQL 解析,见 server-groups.js)。
    </p>

    <div class="actions">
      <button @click="openCreate">+ 新建组</button>
      <button class="refresh" @click="load">刷新</button>
    </div>

    <table class="t">
      <thead>
        <tr>
          <th>组名</th>
          <th>说明</th>
          <th>成员数</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="g in groups" :key="g.groupId">
          <td><code>{{ g.groupName }}</code></td>
          <td>{{ g.description || '-' }}</td>
          <td><span class="pill">{{ g.memberCount }}</span></td>
          <td>
            <button @click="selectGroup(g)">Members</button>
            <button @click="openEdit(g)">编辑</button>
            <button @click="onDelete(g)">删除</button>
          </td>
        </tr>
        <tr v-if="!groups.length">
          <td colspan="4" class="empty">暂无组 — 点击"新建组"开始</td>
        </tr>
      </tbody>
    </table>

    <!-- CRUD dialog -->
    <div v-if="editing" class="modal-bg" @click.self="editing = null">
      <div class="modal">
        <h3>{{ editing.id ? '编辑组' : '新建组' }}</h3>
        <div class="row">
          <label>组名 <span class="req">*</span></label>
          <input v-model="editing.groupName" :disabled="!!editing.id" placeholder="edge-east" />
        </div>
        <div class="row">
          <label>说明</label>
          <input v-model="editing.description" placeholder="东向边缘节点" />
        </div>
        <div v-if="editing.error" class="error">{{ editing.error }}</div>
        <div class="actions">
          <button @click="editing = null">取消</button>
          <button class="primary" :disabled="editing.busy" @click="onSave">
            {{ editing.busy ? '保存中...' : '保存' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Members tab: slide-out panel for the selected group -->
    <div v-if="selected" class="modal-bg" @click.self="closeMembers">
      <div class="modal wide">
        <div class="members-head">
          <h3>成员 — {{ selected.groupName }}</h3>
          <button @click="closeMembers">关闭</button>
        </div>
        <p class="hint">组内成员及其所属站点。在下方编辑 hostnames(逗号或换行分隔),保存即覆盖整组。</p>
        <div class="row vert">
          <label>hostnames</label>
          <textarea v-model="membersText" rows="6" placeholder="host-a&#10;host-b&#10;host-c"></textarea>
        </div>
        <div v-if="membersError" class="error">{{ membersError }}</div>
        <div v-if="membersOk" class="ok">{{ membersOk }}</div>

        <div class="row vert">
          <label>批量包操作</label>
          <div class="bulk-row">
            <input v-model="bulkPkg" placeholder="包名 (例: ad-os-baseline)" />
            <button class="primary" :disabled="bulkBusy" @click="bulkInstall">安装</button>
            <button :disabled="bulkBusy" @click="bulkUninstall">卸载</button>
            <button :disabled="bulkBusy" @click="bulkEnable">启用</button>
            <button :disabled="bulkBusy" @click="bulkDisable">禁用</button>
          </div>
        </div>

        <div class="actions">
          <button class="primary" :disabled="membersBusy" @click="saveMembers">
            {{ membersBusy ? '保存中...' : '保存成员' }}
          </button>
        </div>
      </div>
    </div>
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { adminApi } from '../../api/admin.js';

const groups = ref([]);
const editing = ref(null);  // { id, groupName, description, busy, error }
const selected = ref(null); // group object
const membersText = ref('');
const membersBusy = ref(false);
const membersError = ref('');
const membersOk = ref('');
const bulkPkg = ref('');
const bulkBusy = ref(false);

async function load() {
  const r = await adminApi.listServerGroups();
  groups.value = r.data || [];
}

function openCreate() {
  editing.value = { id: null, groupName: '', description: '', busy: false, error: '' };
}

function openEdit(g) {
  editing.value = { id: g.groupId, groupName: g.groupName, description: g.description || '', busy: false, error: '' };
}

async function onSave() {
  const e = editing.value;
  e.error = '';
  if (!e.groupName?.trim()) { e.error = '组名必填'; return; }
  e.busy = true;
  try {
    if (e.id) {
      await adminApi.updateServerGroup(e.id, { groupName: e.groupName, description: e.description || null });
    } else {
      await adminApi.createServerGroup({ groupName: e.groupName, description: e.description || null });
    }
    editing.value = null;
    await load();
  } catch (err) {
    e.error = err.response?.data?.error || err.message || String(err);
  } finally {
    e.busy = false;
  }
}

async function onDelete(g) {
  if (!confirm(`删除组 ${g.groupName}? FK 级联清掉 group_members; 组上的 package binds 仍保留。`)) return;
  await adminApi.deleteServerGroup(g.groupId);
  await load();
}

async function selectGroup(g) {
  selected.value = g;
  membersError.value = '';
  membersOk.value = '';
  bulkPkg.value = '';
  try {
    const r = await adminApi.listServerGroupMembers(g.groupId);
    membersText.value = (r.data || []).map(m => m.hostname).join('\n');
  } catch (e) {
    membersError.value = e.response?.data?.error || e.message || String(e);
  }
}

function closeMembers() {
  selected.value = null;
  membersText.value = '';
  membersError.value = '';
  membersOk.value = '';
  bulkPkg.value = '';
}

function parseMembers() {
  return Array.from(new Set(
    membersText.value
      .split(/[\n,]+/g)
      .map(s => s.trim())
      .filter(Boolean)
  ));
}

async function saveMembers() {
  membersError.value = '';
  membersOk.value = '';
  membersBusy.value = true;
  try {
    const hostnames = parseMembers();
    const r = await adminApi.replaceServerGroupMembers(selected.value.groupId, hostnames);
    membersOk.value = `已保存: 新增 ${r.data?.added || 0}, 移除 ${r.data?.removed || 0}`;
    await load();
  } catch (e) {
    membersError.value = e.response?.data?.error || e.message || String(e);
  } finally {
    membersBusy.value = false;
  }
}

async function bulkInstall() {
  if (!selected.value || !bulkPkg.value.trim()) { membersError.value = '包名必填'; return; }
  await runBulk(() => adminApi.bulkInstallForGroup(selected.value.groupId, bulkPkg.value.trim()), '安装完成');
}
async function bulkUninstall() {
  if (!selected.value || !bulkPkg.value.trim()) { membersError.value = '包名必填'; return; }
  await runBulk(() => adminApi.bulkUninstallForGroup(selected.value.groupId, bulkPkg.value.trim()), '卸载完成');
}
async function bulkEnable() {
  if (!selected.value || !bulkPkg.value.trim()) { membersError.value = '包名必填'; return; }
  await runBulk(() => adminApi.bulkEnableForGroup(selected.value.groupId, bulkPkg.value.trim()), '启用完成');
}
async function bulkDisable() {
  if (!selected.value || !bulkPkg.value.trim()) { membersError.value = '包名必填'; return; }
  await runBulk(() => adminApi.bulkDisableForGroup(selected.value.groupId, bulkPkg.value.trim()), '禁用完成');
}

async function runBulk(fn, okText) {
  membersError.value = '';
  membersOk.value = '';
  bulkBusy.value = true;
  try {
    const r = await fn();
    membersOk.value = `${okText}: affected ${r.data?.affected ?? r.data?.removed ?? 0}`;
    await load();
  } catch (e) {
    membersError.value = e.response?.data?.error || e.message || String(e);
  } finally {
    bulkBusy.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.t { width: 100%; border-collapse: collapse; background: var(--panel); margin-top: 12px; }
.actions { display: flex; gap: 8px; margin-top: 12px; }
.refresh { background: var(--panel); color: var(--text); border: 1px solid #334155; }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
.pill { background: var(--accent); color: #0b1220; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; }
.empty { text-align: center; color: var(--muted); padding: 24px; }
.hint { color: var(--muted); font-size: 12px; margin: 0 0 12px; }
.hint code { background: #0b1220; padding: 1px 4px; border-radius: 2px; }
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--panel); padding: 20px; border-radius: 6px; min-width: 480px; max-width: 90vw; }
.modal.wide { min-width: 640px; }
.row { display: flex; align-items: center; margin-bottom: 8px; gap: 8px; }
.row.vert { flex-direction: column; align-items: stretch; }
.row label { width: 100px; color: var(--muted); font-size: 13px; }
.row.vert label { width: auto; }
.row input, .row textarea { flex: 1; background: #0b1220; color: var(--text); border: 1px solid #1e293b; padding: 6px 8px; border-radius: 3px; font-family: inherit; }
.req { color: var(--red); }
.error { color: var(--red); font-size: 13px; margin: 8px 0; }
.ok { color: var(--accent); font-size: 13px; margin: 8px 0; }
.members-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.members-head h3 { margin: 0; }
.bulk-row { display: flex; gap: 6px; flex-wrap: wrap; }
.bulk-row input { flex: 1; min-width: 200px; }
.actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.primary { background: var(--accent); color: white; }
code { background: #0b1220; padding: 1px 4px; border-radius: 2px; }
</style>
