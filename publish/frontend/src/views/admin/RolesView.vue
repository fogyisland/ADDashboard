<template>
  <AppLayout>
    <h2>角色与权限</h2>
    <table class="t">
      <thead><tr><th>ID</th><th>名称</th><th>权限</th></tr></thead>
      <tbody>
        <tr v-for="r in roles" :key="r.id">
          <td>{{ r.id }}</td><td>{{ r.roleName }}</td>
          <td><code>{{ (r.permissions || []).join(', ') }}</code></td>
        </tr>
      </tbody>
    </table>
  </AppLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import AppLayout from '../../components/AppLayout.vue';
import { adminApi } from '../../api/admin.js';
const roles = ref([]);
onMounted(async () => { roles.value = (await adminApi.listRoles()).data; });
</script>

<style scoped>
.t { width: 100%; border-collapse: collapse; background: var(--panel); }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
</style>
