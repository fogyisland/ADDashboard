<!--
  2026-08-31 R75 — GroupMembersModal.vue.
  Per spec §4.4 — split-pane: existing members (paginated, multi-select) +
  search-to-add picker. Buttons: 添加选中, 移除选中, 全部替换 (with extra
  confirm).
  Submits `group_list_members`, `group_add_member`, `group_remove_member`,
  `group_set_members`.
  data-test: group-members-modal / list-table / add / remove / replace.
-->
<template>
  <div class="modal-bg" @click.self="cancel">
    <div class="modal large" data-test="group-members-modal">
      <header><h3>成员管理 — {{ name }}</h3></header>
      <section class="form-body">
        <div v-if="loading" class="hint">加载成员列表中…</div>
        <div v-if="error" class="error">{{ error }}</div>

        <div class="pane">
          <div class="pane-header">
            <h4>当前成员 ({{ members.length }})</h4>
          </div>
          <table v-if="members.length" class="t">
            <thead>
              <tr>
                <th class="checkbox-col"><input type="checkbox" v-model="allSelected" @change="toggleSelectAll" /></th>
                <th>sAMAccountName</th>
                <th>DN</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in members" :key="m.sam" class="member-row">
                <td class="checkbox-col"><input type="checkbox" :value="m.sam" v-model="selectedToRemove" /></td>
                <td><code>{{ m.sam }}</code></td>
                <td><code class="dn">{{ m.dn || '—' }}</code></td>
              </tr>
            </tbody>
          </table>
          <div v-else-if="!loading" class="empty">该组暂无成员</div>
        </div>

        <div class="pane">
          <div class="pane-header">
            <h4>添加成员 (sAMAccountName 列表，用逗号或空格分隔)</h4>
          </div>
          <textarea
            data-test="group-members-add-input"
            v-model="addInput"
            rows="3"
            placeholder="例如: alice, bob, charlie"
            :disabled="submitting"
          ></textarea>
          <small class="hint">可粘贴 DN 列表，agent 端会尝试按 sAMAccountName 解析</small>
        </div>

        <p v-if="submitting && !resultMessage" class="hint">命令已发送到 DC · 命令 ID #{{ activeCommand?.id }}</p>
        <p v-if="submitting && timedOut" class="error">命令执行超时，正在查询状态…</p>
        <p v-if="resultMessage" :class="['result', resultOk ? 'ok' : 'err']" data-test="group-members-result">{{ resultMessage }}</p>

        <div v-if="confirmReplace" class="warn-banner">
          ⚠ 全部替换将先清空成员列表再加入新成员。继续？
          <div class="confirm-actions">
            <button type="button" class="secondary" @click="confirmReplace = false">取消</button>
            <button type="button" class="danger" @click="doReplace" data-test="group-members-replace-confirm">确认替换</button>
          </div>
        </div>
      </section>
      <footer>
        <button type="button" data-test="group-members-close" @click="cancel" :disabled="submitting">关闭</button>
        <button
          type="button"
          data-test="group-members-add"
          @click="addMembers"
          :disabled="submitting || !addInput.trim()"
        >添加选中</button>
        <button
          type="button"
          data-test="group-members-remove"
          @click="removeMembers"
          :disabled="submitting || !selectedToRemove.length"
        >移除选中 ({{ selectedToRemove.length }})</button>
        <button
          type="button"
          data-test="group-members-replace"
          class="danger"
          @click="askReplace"
          :disabled="submitting"
        >全部替换</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, reactive, onMounted } from 'vue';
import { adAdminApi } from '../../api/ad-admin.js';

const props = defineProps({
  targetDc: { type: String, required: true },
  name: { type: String, required: true }
});
const emit = defineEmits(['close', 'changed']);

const members = ref([]);
const loading = ref(true);
const error = ref('');
const selectedToRemove = ref([]);
const allSelected = ref(false);
const addInput = ref('');
const confirmReplace = ref(false);
const submitting = ref(false);
const resultMessage = ref('');
const resultOk = ref(false);
const activeCommand = ref(null);
const timedOut = ref(false);

const replaceTarget = ref('');

let pollHandle = null;

const toggles = reactive({});

function toggleSelectAll() {
  if (allSelected.value) selectedToRemove.value = members.value.map(m => m.sam);
  else selectedToRemove.value = [];
}

async function loadMembers() {
  loading.value = true;
  error.value = '';
  try {
    const resp = await adAdminApi.queueCommand({
      targetDc: props.targetDc,
      commandType: 'group_list_members',
      params: { name: props.name, page: 1, size: 100 }
    });
    const id = resp.data?.id;
    if (!id) { loading.value = false; error.value = '排队失败'; return; }
    const handler = setInterval(async () => {
      try {
        const r = await adAdminApi.getCommand(id);
        const st = r.data?.status;
        if (st === 'success') {
          members.value = r.data?.resultJson?.members || [];
          loading.value = false;
          clearInterval(handler);
        } else if (st === 'failed' || st === 'timeout') {
          error.value = r.data?.errorMessage || `命令${st}`;
          loading.value = false;
          clearInterval(handler);
        }
      } catch { /* keep polling */ }
    }, 1500);
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || '加载失败';
    loading.value = false;
  }
}

function parseMembers(input) {
  return input.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}

async function runCommand(commandType, params) {
  submitting.value = true;
  resultMessage.value = '';
  timedOut.value = false;
  try {
    const resp = await adAdminApi.queueCommand({
      targetDc: props.targetDc,
      commandType,
      params
    });
    activeCommand.value = resp.data;
    const deadline = setTimeout(() => { if (!resultMessage.value) timedOut.value = true; }, 30_000);
    pollHandle = setInterval(async () => {
      try {
        const r = await adAdminApi.getCommand(activeCommand.value.id);
        const st = r.data?.status;
        if (st === 'success') {
          resultMessage.value = formatResult(r.data?.resultJson, commandType);
          resultOk.value = true;
          clearInterval(pollHandle); pollHandle = null;
          clearTimeout(deadline);
          submitting.value = false;
          emit('changed', r.data);
          await loadMembers();
          return;
        }
        if (st === 'failed' || st === 'timeout') {
          resultMessage.value = r.data?.errorMessage || `命令${st}`;
          resultOk.value = false;
          clearInterval(pollHandle); pollHandle = null;
          clearTimeout(deadline);
          submitting.value = false;
        }
      } catch { /* keep polling */ }
    }, 1500);
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || '提交失败';
    submitting.value = false;
  }
}

function formatResult(res, commandType) {
  if (!res) return '完成';
  if (commandType === 'group_add_member') {
    return `已添加 ${res.added?.length || 0} · 已是成员 ${res.alreadyMembers?.length || 0}`;
  }
  if (commandType === 'group_remove_member') {
    return `已移除 ${res.removed?.length || 0} · 非成员 ${res.notMembers?.length || 0}`;
  }
  if (commandType === 'group_set_members') {
    return `替换完成 — 新增 ${res.added?.length || 0} · 移除 ${res.removed?.length || 0}`;
  }
  return '完成';
}

async function addMembers() {
  const list = parseMembers(addInput.value);
  if (!list.length) return;
  await runCommand('group_add_member', { name: props.name, members: list });
  addInput.value = '';
  selectedToRemove.value = [];
  allSelected.value = false;
}

async function removeMembers() {
  const list = [...selectedToRemove.value];
  if (!list.length) return;
  await runCommand('group_remove_member', { name: props.name, members: list });
  selectedToRemove.value = [];
  allSelected.value = false;
}

function askReplace() {
  replaceTarget.value = addInput.value;
  confirmReplace.value = true;
}

async function doReplace() {
  confirmReplace.value = false;
  const list = parseMembers(addInput.value);
  if (!list.length) {
    error.value = '请输入新成员列表';
    return;
  }
  await runCommand('group_set_members', { name: props.name, members: list });
  addInput.value = '';
  selectedToRemove.value = [];
  allSelected.value = false;
}

function cancel() {
  if (pollHandle) clearInterval(pollHandle);
  emit('close');
}

onMounted(loadMembers);
</script>

<style scoped>
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; min-width: 580px; max-width: 760px; max-height: 90vh; display: flex; flex-direction: column; }
.modal.large { min-width: 760px; max-width: 920px; }
.modal header { padding: 12px 18px; border-bottom: 1px solid var(--border); }
.modal header h3 { margin: 0; font-size: 15px; }
.form-body { padding: 14px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; }
.pane { background: var(--input-bg); border: 1px solid var(--border); border-radius: 4px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.pane-header h4 { margin: 0; font-size: 13px; }
.pane-header { color: var(--muted); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }
.t { width: 100%; border-collapse: collapse; font-size: 13px; }
.t th, .t td { padding: 5px 8px; text-align: left; border-bottom: 1px solid var(--border); }
.t th { background: var(--panel-alt); color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
.t code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
.t .dn { color: var(--muted); }
.checkbox-col { width: 28px; }
textarea {
  background: var(--input-bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 3px;
  padding: 6px 8px; font-size: 13px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  resize: vertical;
}
textarea:focus { outline: 2px solid var(--accent); border-color: var(--accent); }
.hint { color: var(--muted); font-size: 11px; margin: 0; }
.empty { color: var(--muted); padding: 8px 0; font-size: 12px; }
.error { background: rgba(239, 68, 68, 0.15); color: #dc2626; padding: 6px 10px; border-radius: 3px; font-size: 12px; margin: 0; }
.warn-banner {
  background: rgba(234, 179, 8, 0.15); color: #ca8a04;
  padding: 8px 12px; border-radius: 3px;
  border: 1px solid rgba(234, 179, 8, 0.3);
  font-size: 12px; margin: 0;
}
.confirm-actions { display: flex; gap: 8px; margin-top: 6px; }
.result.ok { background: rgba(34, 197, 94, 0.15); color: #16a34a; padding: 6px 10px; border-radius: 3px; font-size: 12px; margin: 0; }
.result.err { background: rgba(239, 68, 68, 0.15); color: #dc2626; padding: 6px 10px; border-radius: 3px; font-size: 12px; margin: 0; }
.modal footer { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 18px; border-top: 1px solid var(--border); flex-wrap: wrap; }
.modal footer button { padding: 6px 14px; border: 1px solid var(--border); background: var(--input-bg); color: var(--text); border-radius: 3px; cursor: pointer; font-size: 13px; }
.modal footer button.danger { background: var(--red); color: #0b1220; border-color: var(--red); }
.modal footer button.secondary { background: var(--input-bg); }
.modal footer button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>