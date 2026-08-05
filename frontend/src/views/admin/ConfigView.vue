<template>
  <AdminLayout>
    <h2>系统配置</h2>
    <table class="t">
      <thead><tr><th>键</th><th>值</th><th>说明</th></tr></thead>
      <tbody>
        <tr v-for="(v, k) in current" :key="k">
          <td><code>{{ k }}</code></td>
          <td>
            <ConfigFieldRow
              :field-key="k"
              :value="v"
              :error="errors[k] || ''"
              :description="descriptions[k] || ''"
              :type="numericFields.includes(k) ? 'number' : 'text'"
              @update:value="onInput(k, $event)"
            />
          </td>
          <td></td>
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
            <td><code>{{ row.configKey }}</code></td>
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
  ad_agent_token: 'Agent 共享 Token',
  center_public_host: '对外域名/IP (给 Agent / 用户访问用)',
  center_public_port: '对外端口'
};
const numericFields = ['polling_interval_minutes', 'latency_threshold_minutes', 'heartbeat_interval_seconds', 'center_public_port'];
const RISKY_FIELDS = ['ad_agent_token', 'center_public_host', 'center_public_port'];

const initial = ref({});
const { current, snapshot, dirty, markClean, reset } = useDirtyState({});
const { errors, validate, hasErrors } = useConfigValidation();

const saving = ref(false);
const topLevelMsg = ref('');
const showConfirm = ref(false);
const confirmBody = ref('');
const audit = ref([]);
const rollbackTarget = ref(null);

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
</style>