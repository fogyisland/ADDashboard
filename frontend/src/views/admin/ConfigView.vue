<template>
  <AppLayout>
    <h2>系统配置</h2>
    <table class="t">
      <thead><tr><th>键</th><th>值</th><th>说明</th></tr></thead>
      <tbody>
        <tr v-for="(v, k) in config" :key="k">
          <td><code>{{ k }}</code></td>
          <td><input v-model="config[k]" /></td>
          <td><small>{{ descriptions[k] || '' }}</small></td>
        </tr>
      </tbody>
    </table>
    <button @click="save" :disabled="saving">{{ saving ? '保存中...' : '保存' }}</button>
    <span v-if="msg" class="msg">{{ msg }}</span>
  </AppLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import AppLayout from '../../components/AppLayout.vue';
import { adminApi } from '../../api/admin.js';
const config = ref({});
const descriptions = { polling_interval_minutes: '采集周期 (分钟)', latency_threshold_minutes: '复制延迟告警阈值 (分钟)', history_enabled: '是否写入历史快照 (0/1)', ad_agent_token: 'Agent 共享 Token', center_public_host: '对外域名/IP (给 Agent / 用户访问用, 例如 ad-dashboard.contoso.com 或 10.1.2.3)', center_public_port: '对外端口 (例如 443=HTTPS, 80=HTTP)' };
const saving = ref(false); const msg = ref('');
async function load() { config.value = (await adminApi.getConfig()).data; }
async function save() { saving.value = true; msg.value=''; try { await adminApi.updateConfig(config.value); msg.value='已保存'; } catch(e){ msg.value = '保存失败'; } finally { saving.value = false; } }
onMounted(load);
</script>

<style scoped>
.t { width: 100%; border-collapse: collapse; background: var(--panel); margin-bottom: 12px; }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
.t input { width: 100%; }
.msg { margin-left: 12px; color: var(--accent); }
</style>
