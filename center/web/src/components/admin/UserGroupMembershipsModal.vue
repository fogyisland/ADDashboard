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
import { ref, onMounted, watch } from 'vue';
import { adAdminApi } from '../../api/ad-admin.js';
import { useCommandPolling } from '../../composables/useCommandPolling.js';

const props = defineProps({
  targetDc: { type: String, required: true },
  sam: { type: String, required: true }
});
const emit = defineEmits(['close']);

const groups = ref([]);
const loading = ref(true);
const error = ref('');

const polling = useCommandPolling(null, { intervalMs: 1500, timeoutMs: 30_000 });
watch(polling.isTerminal, (terminal) => {
  if (!terminal) return;
  const r = polling.command.value;
  if (!r) return;
  if (r.status === 'success') {
    groups.value = r.result?.groups || [];
  } else {
    error.value = r.errorMessage || `命令${r.status}`;
  }
  loading.value = false;
});

onMounted(async () => {
  try {
    const resp = await adAdminApi.queueCommand({
      targetDc: props.targetDc,
      commandType: 'user_list_groups',
      params: { sam: props.sam }
    });
    if (!resp.data?.id) { loading.value = false; error.value = '排队失败'; return; }
    polling.start(resp.data);
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || '加载失败';
    loading.value = false;
  }
});

function cancel() {
  polling.stop();
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