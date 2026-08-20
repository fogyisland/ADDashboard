<template>
  <AdminLayout>
    <div class="orphan-schemas-view">
      <h2>未签名 Schema 残留</h2>
      <p class="hint">Package 卸载时 DROP SCHEMA 失败的残留 — 手动清理或排查后删除。</p>
      <table v-if="schemas.length" class="t">
        <thead>
          <tr><th>Schema</th><th>最后出现</th><th>备注</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="s in schemas" :key="s.name">
            <td><code>{{ s.name }}</code></td>
            <td>{{ formatTime(s.last_seen_at) }}</td>
            <td>{{ s.note }}</td>
            <td>
              <button
                data-test="drop"
                :disabled="dropping === s.name"
                @click="requestDrop(s.name)"
              >{{ dropping === s.name ? '删除中...' : '手动 DROP' }}</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else>暂无残留。</p>
    </div>
    <ConfirmDialog
      v-if="dropTarget"
      :title="`确认手动 DROP ${dropTarget}?`"
      :body="'此操作不可撤销 — 数据库将永久删除该 schema 及其对象。'"
      confirm-label="确认 DROP"
      :danger="true"
      @confirm="confirmDrop"
      @cancel="dropTarget = null"
    />
  </AdminLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import { adminApi } from '../../api/admin.js';
import { notifyError, notifySuccess } from '../../lib/notify.js';

const schemas = ref([]);
const dropTarget = ref(null);
const dropping = ref(null);

async function load() {
  try {
    const r = await adminApi.listOrphanSchemas();
    schemas.value = r.schemas || [];
  } catch (e) {
    notifyError(`加载残留列表失败: ${e?.message || '未知错误'}`);
  }
}

function requestDrop(name) {
  dropTarget.value = name;
}

async function confirmDrop() {
  const name = dropTarget.value;
  dropTarget.value = null;
  if (!name) return;
  dropping.value = name;
  try {
    await adminApi.dropOrphanSchema(name);
    notifySuccess(`已删除 schema ${name}`);
    await load();
  } catch (e) {
    notifyError(`DROP ${name} 失败: ${e?.message || '未知错误'}`);
  } finally {
    dropping.value = null;
  }
}

function formatTime(ts) {
  return ts ? new Date(ts).toLocaleString() : '—';
}

onMounted(load);
</script>

<style scoped>
.hint { color: var(--muted); margin-bottom: 1em; }
.t { width: 100%; border-collapse: collapse; background: var(--panel); }
.t th, .t td { padding: 8px 10px; border-bottom: 1px solid #1e293b; text-align: left; font-size: 13px; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
.t button { padding: 4px 12px; background: #7f1d1d; color: #fee2e2; border: 1px solid #b91c1c; border-radius: 3px; cursor: pointer; }
.t button:hover:not(:disabled) { background: #b91c1c; }
.t button:disabled { opacity: 0.5; cursor: not-allowed; }
code { background: #0b1220; padding: 2px 6px; border-radius: 2px; font-size: 12px; }
</style>