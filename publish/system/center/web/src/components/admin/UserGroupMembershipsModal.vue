<!--
  2026-08-31 R75 — UserGroupMembershipsModal.vue.
  Read-only list of groups the user belongs to. Submits
  `user_list_groups` command, polls, renders results.
  data-test contract: user-groups-modal + row-${name}.
-->
<template>
  <div class="modal-bg" @click.self="cancel">
    <div class="modal" data-test="user-groups-modal">
      <header><h3>组成员 — {{ sam }}</h3></header>
      <section class="form-body">
        <p v-if="loading" class="hint">加载中…</p>
        <p v-if="error" class="error">{{ error }}</p>
        <table v-if="groups.length" class="t">
          <thead>
            <tr><th>组名</th><th>类别</th><th>范围</th><th>DN</th></tr>
          </thead>
          <tbody>
            <tr
              v-for="g in groups"
              :key="g.name"
              :data-test="`user-group-row-${g.name}`"
              class="group-row"
            >
              <td>{{ g.name }}</td>
              <td>{{ g.category || '—' }}</td>
              <td>{{ g.scope || '—' }}</td>
              <td><code>{{ g.dn || '—' }}</code></td>
            </tr>
          </tbody>
        </table>
        <div v-else-if="!loading && !error" class="empty">该用户不属于任何组</div>
      </section>
      <footer>
        <button type="button" data-test="user-groups-close" @click="cancel">关闭</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { adAdminApi } from '../../api/ad-admin.js';

const props = defineProps({
  targetDc: { type: String, required: true },
  sam: { type: String, required: true }
});
const emit = defineEmits(['close']);

const groups = ref([]);
const loading = ref(true);
const error = ref('');

let pollHandle = null;

onMounted(async () => {
  try {
    const resp = await adAdminApi.queueCommand({
      targetDc: props.targetDc,
      commandType: 'user_list_groups',
      params: { sam: props.sam }
    });
    const id = resp.data?.id;
    if (!id) { loading.value = false; error.value = '排队失败'; return; }
    pollHandle = setInterval(async () => {
      try {
        const r = await adAdminApi.getCommand(id);
        const st = r.data?.status;
        if (st === 'success') {
          groups.value = r.data?.resultJson?.groups || [];
          loading.value = false;
          clearInterval(pollHandle); pollHandle = null;
        } else if (st === 'failed' || st === 'timeout') {
          error.value = r.data?.errorMessage || `命令${st}`;
          loading.value = false;
          clearInterval(pollHandle); pollHandle = null;
        }
      } catch { /* keep polling */ }
    }, 1500);
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || '加载失败';
    loading.value = false;
  }
});

function cancel() {
  if (pollHandle) clearInterval(pollHandle);
  emit('close');
}
</script>

<style scoped>
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; min-width: 560px; max-width: 720px; max-height: 90vh; display: flex; flex-direction: column; }
.modal header { padding: 12px 18px; border-bottom: 1px solid var(--border); }
.modal header h3 { margin: 0; font-size: 15px; }
.form-body { padding: 14px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
.t { width: 100%; border-collapse: collapse; font-size: 13px; }
.t th, .t td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--border); }
.t th { background: var(--input-bg); color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
.t code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; color: var(--muted); word-break: break-all; }
.empty { color: var(--muted); padding: 12px 4px; font-size: 13px; }
.hint { color: var(--muted); font-size: 12px; margin: 0; }
.error { background: rgba(239, 68, 68, 0.15); color: #dc2626; padding: 6px 10px; border-radius: 3px; font-size: 12px; margin: 0; }
.modal footer { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 18px; border-top: 1px solid var(--border); }
.modal footer button { padding: 6px 14px; border: 1px solid var(--border); background: var(--input-bg); color: var(--text); border-radius: 3px; cursor: pointer; font-size: 13px; }
</style>