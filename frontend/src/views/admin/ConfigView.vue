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
            <!--
              smtp_password has its own row (no ConfigFieldRow): the value
              T12-fix1 contract requires the input itself to stay empty while
              the placeholder shows `********` so the operator can type a new
              password to overwrite the existing one.
            -->
            <template v-if="k === 'smtp_password'">
              <input
                type="password"
                :value="''"
                :placeholder="passwordPlaceholder"
                autocomplete="new-password"
                class="has-password-mask"
                @input="onInput(k, $event.target.value)"
              />
              <small v-if="errors[k]" class="err">{{ errors[k] }}</small>
            </template>
            <!--
              smtp_secure is a boolean stored as the string 'true'/'false'.
              Inlined here because ConfigFieldRow uses @input/$event.target.value,
              which doesn't work for a checkbox.
            -->
            <template v-else-if="k === 'smtp_secure'">
              <label class="secure-toggle">
                <input
                  type="checkbox"
                  :checked="String(current[k]) === 'true'"
                  @change="onInput(k, $event.target.checked ? 'true' : 'false')"
                />
                <span>{{ String(current[k]) === 'true' ? '启用' : '关闭' }}</span>
              </label>
              <small v-if="errors[k]" class="err">{{ errors[k] }}</small>
            </template>
            <ConfigFieldRow
              v-else
              :value="v"
              :error="errors[k] || ''"
              :type="numericFields.includes(k) ? 'number' : 'text'"
              @update:value="onInput(k, $event)"
            />
            <span v-if="k === 'listenPort' && initial.restartRequired?.listenPort" class="restart-badge" title="保存后值已生效，需重启 center 后生效。重启后此标记消失。">⚠ 待重启</span>
          </td>
          <td>
            <span class="desc-text">{{ descriptions[k] || '' }}</span>
            <template v-if="k === 'ad_agent_token'">
              <div class="action-row">
                <button class="token-action" @click="onGenerateToken">生成</button>
                <button class="token-action" @click="onCopyToken">复制</button>
                <span v-if="copyMsg" class="copy-msg">{{ copyMsg }}</span>
              </div>
            </template>
            <template v-else-if="k === 'smtp_from'">
              <div class="action-row">
                <button class="token-action" :disabled="testing || !smtpReady" @click="openTestDialog">发送测试邮件</button>
              </div>
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

    <!--
      Test-mail modal (moved from EmailConfigCard T16). Triggered from the
      smtp_from row's "发送测试邮件" button. Disabled state of the button is
      driven by `smtpReady` which only goes true after a Save with smtp_host
      populated — sending against an unconfigured smtp is a guaranteed
      failure path so we skip the round trip.
    -->
    <div v-if="showTestDialog" class="modal-bg" @click.self="closeTestDialog">
      <div class="modal">
        <h3>发送测试邮件</h3>
        <div class="row">
          <label>收件人 <span class="req">*</span></label>
          <input v-model="testTo" placeholder="ops@corp.local" />
        </div>
        <div v-if="testError" class="error">{{ testError }}</div>
        <div v-if="testOkMsg" class="ok-msg">{{ testOkMsg }}</div>
        <div class="actions">
          <button @click="closeTestDialog">关闭</button>
          <button class="primary" :disabled="testing || !testTo" @click="sendTest">
            {{ testing ? '发送中...' : '发送' }}
          </button>
        </div>
      </div>
    </div>

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
              <!--
                T12 cross-task concern: every post-fix1 smtp_password audit row
                is permanently un-rollbackable. The PUT route strips the value
                from writeAudit, so the audit row only carries `********` for
                old/new — the backend's rollback endpoint already refuses
                masked rows (config.js + admin.js), but the UI should mirror
                that contract so the operator doesn't see a clickable button
                that 400s.
              -->
              <button
                v-if="row.changeType !== 'ROLLBACK'"
                class="rollback"
                :disabled="isUnrollbackable(row)"
                :title="rollbackTitle(row)"
                @click="onRollbackClick(row)"
              >{{ isUnrollbackable(row) ? '不可回滚' : '回滚' }}</button>
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
import { ref, computed, onMounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import ConfigFieldRow from './ConfigFieldRow.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import { adminApi } from '../../api/admin.js';
import { useConfigValidation } from '../../composables/useConfigValidation.js';
import { useDirtyState } from '../../composables/useDirtyState.js';

const descriptions = {
  // Collection / discovery cadence
  polling_interval_minutes: 'Agent 复制指标采集周期 (分钟)。',
  latency_threshold_minutes: '复制延迟告警阈值 (分钟),超过即在仪表盘标红。',
  heartbeat_interval_seconds: 'Agent 心跳间隔 (秒),默认 5,越短越快感知掉线。',
  history_enabled: '是否写入历史快照 (0/1),关闭后只保留当前状态。',
  discovery_interval_hours: '站点/域控拓扑发现周期 (小时)。',
  site_matrix_refresh_seconds: '站点复制矩阵页面自动刷新间隔 (秒)。',
  // Auth
  ad_agent_token: 'Agent 与 center 共享令牌,改完 agent 端 appsettings.json 需同步。',
  // Ports (T9 fix-now)
  listenPort: '对外 Web/管理界面端口。改完需重启 center 后生效。',
  heartbeat_port: 'Agent 心跳接收端口。DB 改后 5 min 内 agent 自动刷新。',
  report_port: 'Agent replication snapshot 上报端口。',
  // SMTP / alerts (T16 unified-table integration)
  smtp_host: 'SMTP 服务器主机名或 IP,空表示未配置邮件告警。',
  smtp_port: 'SMTP 端口,常用 25 / 465 / 587。',
  smtp_secure: '是否使用 SSL/TLS (SMTPS),取决于服务器要求。',
  smtp_user: 'SMTP 鉴权用户名,部分服务器可留空。',
  smtp_password: 'SMTP 鉴权密码,保存后再次读取显示 `********`。',
  smtp_from: '告警邮件发件人地址,需被 SMTP 服务器允许。',
  alert_default_to: '告警默认收件人 (逗号分隔多个)。',
  alert_default_cc: '告警默认抄送 (逗号分隔多个)。',
  alert_eval_interval_seconds: '告警评估循环间隔 (秒)。',
  alert_email_max_attempts: '告警邮件发送失败最大重试次数。',
  alert_email_initial_backoff_seconds: '告警邮件重试初始退避 (秒),后续按指数翻倍。',
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
  listenPort: '中心 Web 端口',
  heartbeat_port: '心跳端口',
  report_port: '报告端口',
  smtp_host: 'SMTP 主机',
  smtp_port: 'SMTP 端口',
  smtp_secure: 'SSL/TLS',
  smtp_user: 'SMTP 用户名',
  smtp_password: 'SMTP 密码',
  smtp_from: '发件人地址',
  alert_default_to: '默认收件人',
  alert_default_cc: '默认抄送',
  alert_eval_interval_seconds: '评估间隔',
  alert_email_max_attempts: '最大重试次数',
  alert_email_initial_backoff_seconds: '初始退避',
};
const numericFields = [
  'polling_interval_minutes',
  'latency_threshold_minutes',
  'heartbeat_interval_seconds',
  'discovery_interval_hours',
  'site_matrix_refresh_seconds',
  'listenPort',
  'heartbeat_port',
  'report_port',
  'smtp_port',
  'alert_eval_interval_seconds',
  'alert_email_max_attempts',
  'alert_email_initial_backoff_seconds',
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

// T12 fix1: a present smtp_password is returned by getConfig() as the mask
// sentinel `********`. Show that as the placeholder so the operator sees
// "password is set, click to overwrite" without revealing the value. Empty
// or absent → empty placeholder.
const SMTP_PASSWORD_MASK = '********';
const passwordPlaceholder = computed(() => {
  const v = current.value.smtp_password;
  return v === SMTP_PASSWORD_MASK ? SMTP_PASSWORD_MASK : '';
});

// True iff smtp_host is non-empty (the only hard requirement for sending).
// Test-mail button is disabled otherwise — saving with an empty host would
// have the backend return 'smtp_host not configured' on every send attempt.
const smtpReady = computed(() => !!String(current.value.smtp_host || '').trim());

function isUnrollbackable(row) {
  // smtp_password rows carry `********` on both sides post-T12 fix1; the
  // backend refuses to roll them back, so the UI mirrors that contract.
  // Rows where the new value is the mask (cleartext never persisted) are
  // also un-rollbackable — there's no real value to restore.
  if (!row) return false;
  if (row.configKey !== 'smtp_password') return false;
  if (row.changeType === 'ROLLBACK') return false;
  if (row.oldValue === SMTP_PASSWORD_MASK) return true;
  if (row.newValue === SMTP_PASSWORD_MASK) return true;
  return false;
}

function rollbackTitle(row) {
  return isUnrollbackable(row) ? '密码变更不可回滚' : '';
}

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

// ---- Test mail dialog (T16 — was inline in EmailConfigCard.vue) ----
const showTestDialog = ref(false);
const testTo = ref('');
const testing = ref(false);
const testError = ref('');
const testOkMsg = ref('');

function openTestDialog() {
  testTo.value = current.value.alert_default_to || '';
  testError.value = '';
  testOkMsg.value = '';
  showTestDialog.value = true;
}

function closeTestDialog() {
  showTestDialog.value = false;
  testing.value = false;
}

async function sendTest() {
  testError.value = '';
  testOkMsg.value = '';
  testing.value = true;
  try {
    const r = await adminApi.sendTestEmail({ to: testTo.value });
    const ok = r?.data?.ok ?? r?.ok ?? false;
    const err = r?.data?.error ?? r?.error ?? null;
    if (ok) {
      testOkMsg.value = `已发送 (${testTo.value})`;
    } else {
      testError.value = err || '发送失败';
    }
  } catch (e) {
    const body = e?.response?.data;
    testError.value = body?.error || e?.message || String(e);
  } finally {
    testing.value = false;
  }
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
.desc-text { color: var(--muted); font-size: 12px; display: block; }
.action-row { margin-top: 6px; display: flex; gap: 4px; align-items: center; }
.secure-toggle { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.secure-toggle input[type=checkbox] { width: auto; }
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
.audit button.rollback:disabled { background: #1e293b; color: var(--muted); cursor: not-allowed; }
.token-action { padding: 3px 10px; border: 1px solid #1e293b; background: #0b1220; color: var(--text); border-radius: 3px; cursor: pointer; font-size: 12px; margin-right: 4px; }
.token-action:hover:not(:disabled) { background: var(--accent); color: #0b1220; }
.token-action:disabled { opacity: 0.5; cursor: not-allowed; }
.copy-msg { color: var(--accent); font-size: 12px; margin-left: 6px; }
.key-label { font-weight: 600; color: var(--text); }
.raw-key { display: block; font-size: 11px; color: var(--muted); margin-top: 2px; }
.restart-badge { display: inline-block; margin-left: 8px; padding: 2px 8px; background: #7f1d1d; color: #fee2e2; border: 1px solid #b91c1c; border-radius: 3px; font-size: 11px; cursor: help; }
.err { display: block; color: #ef4444; font-size: 12px; margin-top: 4px; }
.has-password-mask { font-family: monospace; }
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--panel); padding: 20px; border-radius: 6px; min-width: 420px; max-width: 90vw; }
.modal h3 { margin: 0 0 12px; }
.modal .row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.modal .row label { width: 80px; color: var(--muted); font-size: 13px; }
.modal .row input { flex: 1; background: #0b1220; color: var(--text); border: 1px solid #1e293b; padding: 6px 8px; border-radius: 3px; }
.modal .actions { margin-top: 10px; display: flex; justify-content: flex-end; gap: 8px; }
.modal .primary { background: var(--accent); color: #0b1220; padding: 6px 14px; border: 1px solid #1e293b; border-radius: 3px; cursor: pointer; }
.modal .primary:disabled { opacity: 0.5; cursor: not-allowed; }
.modal button { background: #0b1220; color: var(--text); border: 1px solid #1e293b; padding: 6px 14px; border-radius: 3px; cursor: pointer; }
.error { color: #ef4444; font-size: 13px; margin: 8px 0; white-space: pre-wrap; }
.ok-msg { color: var(--accent); font-size: 13px; margin: 8px 0; }
.req { color: #ef4444; }
</style>
