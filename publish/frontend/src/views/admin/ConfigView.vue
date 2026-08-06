<template>
  <AdminLayout>
    <h2>系统配置</h2>
    <table class="t">
      <thead><tr><th>键</th><th>值</th><th>说明</th></tr></thead>
      <tbody>
        <tr v-for="(v, k) in current" :key="k">
          <td>
            <div class="key-label">{{ labels[k] || k }}</div>
            <code class="raw-key">{{ k }}</code>
          </td>
          <td>
            <ConfigFieldRow
              :value="v"
              :error="errors[k] || ''"
              :description="descriptions[k] || ''"
              :type="numericFields.includes(k) ? 'number' : 'text'"
              @update:value="onInput(k, $event)"
            />
          </td>
          <td>
            <template v-if="k === 'ad_agent_token'">
              <button class="token-action" @click="onGenerateToken">生成</button>
              <button class="token-action" @click="onCopyToken">复制</button>
              <span v-if="copyMsg" class="copy-msg">{{ copyMsg }}</span>
            </template>
          </td>
        </tr>
      </tbody>
    </table>
    <span v-if="dirty" class="dirty">⚠ 有未保存的修改</span>
    <button class="save" @click="onSaveClick" :disabled="!dirty || saving || hasErrors">{{ saving ? '保存中...' : '保存' }}</button>
    <button class="cancel" @click="onCancel" :disabled="!dirty || saving">取消修改</button>
    <span v-if="topLevelMsg" class="msg">{{ topLevelMsg }}</span>
    <ConfirmDialog
      v-if="showConfirm"
      :title="'以下字段会影响 Agent 连接'"
      :body="confirmBody"
      confirm-label="确认保存"
      :danger="true"
      @confirm="onConfirmSave"
      @cancel="showConfirm = false"
    />
    <section v-if="audit.length" class="audit">
      <h3>历史变更 (最近 20 条)</h3>
      <table>
        <thead><tr><th>键</th><th>旧值</th><th>新值</th><th>操作人</th><th>时间</th><th></th></tr></thead>
        <tbody>
          <tr v-for="row in audit" :key="row.id" class="audit-row">
            <td>
              <div class="key-label">{{ labels[row.configKey] || row.configKey }}</div>
              <code class="raw-key">{{ row.configKey }}</code>
            </td>
            <td><code>{{ row.oldValue }}</code></td>
            <td><code>{{ row.newValue }}</code></td>
            <td>{{ row.changedByUsername || row.changedBy || '—' }}</td>
            <td>{{ formatTs(row.changedAt) }}</td>
            <td>
              <button v-if="row.changeType !== 'ROLLBACK'" class="rollback" @click="onRollbackClick(row)">回滚</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
    <ConfirmDialog
      v-if="rollbackTarget"
      title="确认回滚到旧值？"
      :body="`回滚 ${rollbackTarget.configKey} 从 ${rollbackTarget.newValue} 到 ${rollbackTarget.oldValue}`"
      confirm-label="确认回滚"
      :danger="true"
      @confirm="doRollback"
      @cancel="rollbackTarget = null"
    />
  </AdminLayout>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import ConfigFieldRow from './ConfigFieldRow.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import { adminApi } from '../../api/admin.js';
import { useConfigValidation } from '../../composables/useConfigValidation.js';
import { useDirtyState } from '../../composables/useDirtyState.js';

const descriptions = {
  polling_interval_minutes: '采集周期 (分钟)',
  latency_threshold_minutes: '复制延迟告警阈值 (分钟)',
  heartbeat_interval_seconds: 'Agent 心跳间隔 (秒), 默认 5, 越短越快感知掉线',
  history_enabled: '是否写入历史快照 (0/1)',
  ad_agent_token: 'Agent 共享令牌',
  discovery_interval_hours: '站点/域控拓扑发现周期 (小时)',
  site_matrix_refresh_seconds: '站点复制矩阵页面自动刷新间隔 (秒)',
  center_public_host: '中心站对外访问地址 (已废弃, 由 nginx 负责)',
  center_public_port: '中心站对外访问端口 (已废弃, 由 nginx 负责)'
};
// Chinese labels shown as the primary key caption in the config table.
// Raw snake_case stays visible underneath as <code class="raw-key"> for users
// who need to map UI back to DB / API / audit logs.
const labels = {
  polling_interval_minutes: '采集周期',
  latency_threshold_minutes: '延迟阈值',
  heartbeat_interval_seconds: '心跳间隔',
  history_enabled: '历史快照',
  ad_agent_token: 'Agent 令牌',
  discovery_interval_hours: '拓扑发现周期',
  site_matrix_refresh_seconds: '站点矩阵刷新间隔',
  center_public_host: '中心站对外地址',
  center_public_port: '中心站对外端口'
};
const numericFields = [
  'polling_interval_minutes',
  'latency_threshold_minutes',
  'heartbeat_interval_seconds',
  'discovery_interval_hours',
  'site_matrix_refresh_seconds',
  'center_public_port'
];
const RISKY_FIELDS = ['ad_agent_token'];

const initial = ref({});
const { current, snapshot, dirty, markClean, reset } = useDirtyState({});
const { errors, validate, hasErrors } = useConfigValidation();

const saving = ref(false);
const topLevelMsg = ref('');
const showConfirm = ref(false);
const confirmBody = ref('');
const audit = ref([]);
const rollbackTarget = ref(null);
const copyMsg = ref('');

function generateAgentToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function onGenerateToken() {
  onInput('ad_agent_token', generateAgentToken());
}

async function onCopyToken() {
  const token = current.value.ad_agent_token || '';
  if (!token) return;
  try {
    await navigator.clipboard.writeText(token);
    copyMsg.value = '已复制';
  } catch {
    copyMsg.value = '复制失败';
  }
  setTimeout(() => { copyMsg.value = ''; }, 2000);
}

async function load() {
  const r = await adminApi.getConfig();
  initial.value = r.data || {};
  current.value = { ...initial.value };
  markClean(current.value);
  validate(current.value);
  await loadAudit();
}

async function loadAudit() {
  try {
    const r = await adminApi.getConfigAudit();
    audit.value = r.data || [];
  } catch (e) {
    audit.value = [];
  }
}

function formatTs(s) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString();
}

function onRollbackClick(row) {
  rollbackTarget.value = row;
}

async function doRollback() {
  const row = rollbackTarget.value;
  rollbackTarget.value = null;
  if (!row) return;
  try {
    await adminApi.rollbackConfig(row.id);
    await Promise.all([load(), loadAudit()]);
  } catch (e) {
    topLevelMsg.value = '回滚失败';
  }
}

function onInput(k, v) {
  current.value = { ...current.value, [k]: v };
  validate(current.value);
}

function changedKeys() {
  return Object.keys(current.value).filter((k) => String(current.value[k]) !== String(snapshot.value[k]));
}

function onSaveClick() {
  if (!dirty.value || hasErrors.value) return;
  const changed = changedKeys();
  const risky = changed.filter((k) => RISKY_FIELDS.includes(k));
  if (risky.length > 0) {
    confirmBody.value = risky.map((k) => `• ${k}: ${snapshot.value[k]} → ${current.value[k]}`).join('\n');
    showConfirm.value = true;
    return;
  }
  doSave();
}

function onConfirmSave() {
  showConfirm.value = false;
  doSave();
}

function onCancel() {
  reset();
  validate(current.value);
  topLevelMsg.value = '';
}

async function doSave() {
  saving.value = true;
  topLevelMsg.value = '';
  try {
    await adminApi.updateConfig(current.value);
    markClean(current.value);
    topLevelMsg.value = '已保存';
  } catch (e) {
    const body = e?.response?.data;
    if (body?.fieldErrors) {
      errors.value = { ...body.fieldErrors };
      topLevelMsg.value = '保存失败：部分字段不合法';
    } else if (body?.error) {
      topLevelMsg.value = `保存失败：${body.error}`;
    } else {
      topLevelMsg.value = '保存失败，请重试';
    }
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.t { width: 100%; border-collapse: collapse; background: var(--panel); margin-bottom: 12px; }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; vertical-align: top; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
.dirty { color: #f59e0b; margin-right: 12px; }
button.save, button.cancel { padding: 6px 14px; border: 1px solid #1e293b; background: var(--accent); color: #0b1220; border-radius: 3px; cursor: pointer; margin-right: 8px; }
button.save:disabled, button.cancel:disabled { opacity: 0.5; cursor: not-allowed; }
button.cancel { background: #0b1220; color: var(--text); }
.msg { margin-left: 12px; color: var(--accent); }
.audit { margin-top: 24px; }
.audit h3 { margin: 0 0 8px; font-size: 14px; color: var(--muted); }
.audit table { width: 100%; border-collapse: collapse; background: var(--panel); }
.audit th, .audit td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #1e293b; vertical-align: top; }
.audit th { background: #0b1220; color: var(--muted); font-size: 12px; }
.audit code { font-size: 12px; color: var(--text); }
.audit button.rollback { padding: 4px 10px; border: 1px solid #1e293b; background: var(--accent); color: #0b1220; border-radius: 3px; cursor: pointer; font-size: 12px; }
.token-action { padding: 3px 10px; border: 1px solid #1e293b; background: #0b1220; color: var(--text); border-radius: 3px; cursor: pointer; font-size: 12px; margin-right: 4px; }
.token-action:hover { background: var(--accent); color: #0b1220; }
.copy-msg { color: var(--accent); font-size: 12px; margin-left: 6px; }
.key-label { font-weight: 600; color: var(--text); }
.raw-key { display: block; font-size: 11px; color: var(--muted); margin-top: 2px; }
</style>