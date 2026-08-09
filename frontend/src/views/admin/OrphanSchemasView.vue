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
            <td><button data-test="drop" @click="drop(s.name)">手动 DROP</button></td>
          </tr>
        </tbody>
      </table>
      <p v-else>暂无残留。</p>
    </div>
  </AdminLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { adminApi } from '../../api/admin.js';

const schemas = ref([]);

async function load() {
  const r = await adminApi.listOrphanSchemas();
  schemas.value = r.schemas || [];
}

async function drop(name) {
  if (!confirm(`确认手动 DROP ${name}?`)) return;
  await adminApi.dropOrphanSchema(name);
  await load();
}

function formatTime(ts) {
  return new Date(ts).toLocaleString();
}

onMounted(load);
</script>

<style scoped>
.hint { color: #666; margin-bottom: 1em; }
.t { width: 100%; border-collapse: collapse; }
.t th, .t td { padding: 0.5em; border-bottom: 1px solid #eee; text-align: left; }
code { background: #f4f4f4; padding: 0 0.3em; }
</style>
