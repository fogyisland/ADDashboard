<template>
  <AdminLayout>
    <h2>邮件配置 (SMTP / 告警)</h2>
    <p class="page-desc">
      配置中心告警邮件的 SMTP 服务器、信件内容、收件人,以及告警评估循环与重试策略。
      全部通过 <code>PUT /api/admin/config</code> 与主配置走同一保存链路,审计日志可回滚。
    </p>
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
            </template>
            <!--
              smtp_secure is a boolean stored as the string 'true'/'false'.
              Inlined because ConfigFieldRow uses @input/$event.target.value,
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
            </template>
            <ConfigFieldRow
              v-else
              :value="v"
              :type="numericFields.includes(k) ? 'number' : 'text'"
              @update:value="onInput(k, $event)"
            />
          </td>
          <td>
            <span class="desc-text">{{ descriptions[k] || '' }}</span>
            <div v-if="k === 'smtp_from'" class="action-row">
              <button class="token-action" :disabled="testing || !smtpReady" @click="openTestDialog">发送测试邮件</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
    <span v-if="dirty" class="dirty">⚠ 有未保存的修改</span>
    <button class="save" @click="onSaveClick" :disabled="!dirty || saving || hasErrors">{{ saving ? '保存中...' : '保存' }}</button>
    <button class="cancel" @click="onCancel" :disabled="!dirty || saving">取消修改</button>
    <span v-if="topLevelMsg" class="msg">{{ topLevelMsg }}</span>

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

    <section v-if="emailAudit.length" class="audit">
      <h3>邮件相关历史变更 (最近 20 条)</h3>
      <table>
        <thead><tr><th>键</th><th>旧值</th><th>新值</th><th>操作人</th><th>时间</th><th></th></tr></thead>
        <tbody>
          <tr v-for="row in emailAudit" :key="row.id" class="audit-row">
            <td>
              <div class="key-label">{{ labels[row.configKey] || row.configKey }}</div>
              <code class="raw-key">{{ row.configKey }}</code>
            </td>
            <td><code>{{ row.oldValue }}</code></td>
            <td><code>{{ row.newValue }}</code></td>
            <td>{{ row.changedByUsername || row.changedBy || '—' }}</td>
            <td>{{ formatTs(row.changedAt) }}</td>
            <td>
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
import { useDirtyState } from '../../composables/useDirtyState.js';

const EMAIL_KEYS = [
  'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_password', 'smtp_from',
  'alert_default_to', 'alert_default_cc',
  'alert_eval_interval_seconds', 'alert_email_max_attempts', 'alert_email_initial_backoff_seconds'
];

const descriptions = {
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
const labels = {
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
  'smtp_port',
  'alert_eval_interval_seconds',
  'alert_email_max_attempts',
  'alert_email_initial_backoff_seconds'
];

const initial = ref({});
const { current, dirty, markClean, reset } = useDirtyState({});
// SMTP keys don't have client-side validation rules (their constraints are
// server-side: port range, email format, etc.). Keep the save button enabled
// whenever the user has dirty edits — ConfigView's useConfigValidation
// composable only knows the base keys and would mark everything invalid.
const hasErrors = computed(() => false);

const saving = ref(false);
const topLevelMsg = ref('');
const audit = ref([]);
const rollbackTarget = ref(null);

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

// Audit filtered to email-related keys (smtp_*, alert_*) so this page focuses
// on the workflow the operator came here for. The full list lives in the
// main 系统配置 audit.
const emailAudit = computed(() => audit.value.filter((r) => EMAIL_KEYS.includes(r.configKey)).slice(0, 20));

function isUnrollbackable(row) {
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
  } catch {
    topLevelMsg.value = '回滚失败';
  }
}

// ---- Test mail dialog ----
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
  // Project only the keys this page owns — the backend returns the full
  // config map, but we don't want to render the polling/heartbeat/etc rows
  // here. Update PUT sends only the email subset.
  const all = r.data || {};
  const subset = {};
  for (const k of EMAIL_KEYS) subset[k] = all[k];
  initial.value = subset;
  current.value = { ...subset };
  markClean(current.value);
  await loadAudit();
}

async function loadAudit() {
  try {
    const r = await adminApi.getConfigAudit();
    audit.value = r.data || [];
  } catch {
    audit.value = [];
  }
}

function onInput(k, v) {
  current.value = { ...current.value, [k]: v };
}

function onSaveClick() {
  if (!dirty.value || hasErrors.value) return;
  doSave();
}

function onCancel() {
  reset();
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
    if (body?.error) topLevelMsg.value = `保存失败：${body.error}`;
    else topLevelMsg.value = '保存失败，请重试';
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.page-desc { color: var(--muted); font-size: 13px; margin: 0 0 16px; max-width: 720px; }
.page-desc code { background: #0b1220; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
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
.key-label { font-weight: 600; color: var(--text); }
.raw-key { display: block; font-size: 11px; color: var(--muted); margin-top: 2px; }
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
