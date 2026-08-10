<template>
  <section class="email-card">
    <h3>邮件 (SMTP) 配置</h3>
    <div class="row">
      <label>SMTP 主机</label>
      <input :value="local.smtp_host" @input="onInputChange('smtp_host', $event)" placeholder="smtp.example.com" />
      <code class="raw-key">smtp_host</code>
    </div>
    <div class="row">
      <label>SMTP 端口</label>
      <input type="number" :value="local.smtp_port" @input="onNumberChange('smtp_port', $event)" placeholder="25" />
      <code class="raw-key">smtp_port</code>
    </div>
    <div class="row">
      <label>使用 SSL/TLS</label>
      <input type="checkbox" :checked="smtp_secure_bool" @change="onCheckboxChange('smtp_secure', $event)" />
      <code class="raw-key">smtp_secure</code>
    </div>
    <div class="row">
      <label>SMTP 用户名</label>
      <input :value="local.smtp_user" @input="onInputChange('smtp_user', $event)" placeholder="alerts@example.com" />
      <code class="raw-key">smtp_user</code>
    </div>
    <div class="row">
      <label>SMTP 密码</label>
      <!--
        T12 fix1 contract: getConfig() masks smtp_password with `********` when
        a value is set; the UI sends the sentinel back to preserve the existing
        value. Display `********` as the placeholder when the masked value
        arrives so the operator knows a password is configured but can't read
        it. Empty input means "clear the password"; non-masked input means
        "set a new password".
      -->
      <input
        type="password"
        :value="passwordInputValue"
        :placeholder="passwordPlaceholder"
        autocomplete="new-password"
        @input="onPasswordInput"
      />
      <code class="raw-key">smtp_password</code>
    </div>
    <div class="row">
      <label>发件人地址</label>
      <input :value="local.smtp_from" @input="onInputChange('smtp_from', $event)" placeholder="alerts@example.com" />
      <code class="raw-key">smtp_from</code>
    </div>
    <div class="row">
      <label>默认收件人 (To)</label>
      <input :value="local.alert_default_to" @input="onInputChange('alert_default_to', $event)" placeholder="ops@corp.local" />
      <code class="raw-key">alert_default_to</code>
    </div>
    <div class="row">
      <label>默认抄送 (Cc)</label>
      <input :value="local.alert_default_cc" @input="onInputChange('alert_default_cc', $event)" placeholder="sre@corp.local" />
      <code class="raw-key">alert_default_cc</code>
    </div>

    <details class="advanced">
      <summary>高级 (告警评估与重试)</summary>
      <div class="row">
        <label>评估间隔 (秒)</label>
        <input type="number" :value="local.alert_eval_interval_seconds" @input="onNumberChange('alert_eval_interval_seconds', $event)" placeholder="60" />
        <code class="raw-key">alert_eval_interval_seconds</code>
      </div>
      <div class="row">
        <label>最大重试次数</label>
        <input type="number" :value="local.alert_email_max_attempts" @input="onNumberChange('alert_email_max_attempts', $event)" placeholder="5" />
        <code class="raw-key">alert_email_max_attempts</code>
      </div>
      <div class="row">
        <label>初始退避 (秒)</label>
        <input type="number" :value="local.alert_email_initial_backoff_seconds" @input="onNumberChange('alert_email_initial_backoff_seconds', $event)" placeholder="30" />
        <code class="raw-key">alert_email_initial_backoff_seconds</code>
      </div>
    </details>

    <div class="actions">
      <button class="test-mail" :disabled="testing" @click="openTestDialog">
        {{ testing ? '发送中...' : '发送测试邮件' }}
      </button>
    </div>

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
  </section>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { adminApi } from '../../api/admin.js';

// Props:
//   cfg: { smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password,
//          smtp_from, alert_default_to, alert_default_cc,
//          alert_eval_interval_seconds, alert_email_max_attempts,
//          alert_email_initial_backoff_seconds } — straight from getConfig()
//          (smtp_password will be `********` when set, '' or undefined otherwise).
//
// Emits:
//   update: { key, value } — bubble every change to the parent ConfigView
//           so the existing save flow / dirty tracking handles it.
//   The parent owns the dirty/snapshot lifecycle; this card is purely a
//   controlled-input view over the SMTP keys.
const props = defineProps({
  cfg: { type: Object, required: true }
});
const emit = defineEmits(['update']);

// Local mirror of cfg — the parent owns the source of truth, but we keep a
// local copy so the user can edit freely without round-tripping through the
// parent on every keystroke. When cfg changes from outside (e.g. after a
// successful save), we resync.
const local = ref(snapshotCfg(props.cfg));

// smtp_secure arrives as a string ('true'/'false') from the DB. The
// checkbox is bound via :checked (not v-model) so the change handler can
// emit the canonical string form (`'true'`/`'false'`) to the parent.
const smtp_secure_bool = computed(() => String(local.value.smtp_secure) === 'true');

// Password field contract (T12 fix1):
//   - If cfg carries `********`, display it as the placeholder only (the
//     field stays empty so the operator can type a fresh value to overwrite).
//   - If cfg carries '' or undefined, placeholder is empty.
// The input itself is bound through :value + @input so we can route every
// change through the same `update` emit path as the other fields.
const passwordInputValue = computed(() => '');

function snapshotCfg(cfg) {
  return {
    smtp_host: cfg.smtp_host ?? '',
    smtp_port: numOrZero(cfg.smtp_port),
    smtp_secure: cfg.smtp_secure ?? 'false',
    smtp_user: cfg.smtp_user ?? '',
    smtp_password: cfg.smtp_password ?? '',
    smtp_from: cfg.smtp_from ?? '',
    alert_default_to: cfg.alert_default_to ?? '',
    alert_default_cc: cfg.alert_default_cc ?? '',
    alert_eval_interval_seconds: numOrZero(cfg.alert_eval_interval_seconds, 60),
    alert_email_max_attempts: numOrZero(cfg.alert_email_max_attempts, 5),
    alert_email_initial_backoff_seconds: numOrZero(cfg.alert_email_initial_backoff_seconds, 30)
  };
}

function numOrZero(v, dflt) {
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  return dflt ?? 0;
}

// Reset local state when the parent pushes a new cfg (post-save / cancel).
watch(() => props.cfg, (next) => {
  local.value = snapshotCfg(next);
});

// T12 fix1: a present password is returned as `********`. Show that as the
// placeholder so the operator can see "password is set, click to overwrite"
// without revealing the value. Empty/absent → empty placeholder.
const PASSWORD_MASK = '********';
const passwordPlaceholder = computed(() => {
  return local.value.smtp_password === PASSWORD_MASK ? PASSWORD_MASK : '';
});

function onUpdate(key, value) {
  local.value = { ...local.value, [key]: value };
  emit('update', { key, value });
}

function onInputChange(key, evt) {
  onUpdate(key, evt?.target?.value ?? '');
}

function onNumberChange(key, evt) {
  // Number inputs return string in evt.target.value — coerce; preserve '' as
  // 0 so the parent sees a numeric value (the validator on the server
  // requires positive int for these keys).
  const raw = evt?.target?.value;
  if (raw === '' || raw == null) {
    onUpdate(key, 0);
    return;
  }
  const n = Number(raw);
  onUpdate(key, Number.isFinite(n) ? n : 0);
}

function onCheckboxChange(key, evt) {
  onUpdate(key, evt?.target?.checked ? 'true' : 'false');
}

function onPasswordInput(evt) {
  // Always emit the verbatim typed value. The mask sentinel `********` is
  // for the placeholder only — the backend strips it on write, so typing it
  // in by hand would be a no-op (caller didn't intend to change the value).
  onUpdate('smtp_password', evt?.target?.value ?? '');
}

// ---- Test mail dialog ----
const showTestDialog = ref(false);
const testTo = ref('');
const testing = ref(false);
const testError = ref('');
const testOkMsg = ref('');

function openTestDialog() {
  testTo.value = props.cfg.alert_default_to || '';
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
    // r.data shape: { ok: bool, error: string|null }
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
</script>

<style scoped>
.email-card { background: var(--panel); border: 1px solid #1e293b; border-radius: 4px; padding: 14px 16px; margin-bottom: 16px; }
.email-card h3 { margin: 0 0 10px; font-size: 14px; color: var(--text); }
.row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.row label { width: 140px; color: var(--muted); font-size: 13px; }
.row input { flex: 1; background: #0b1220; color: var(--text); border: 1px solid #1e293b; padding: 6px 8px; border-radius: 3px; }
.row input[type=checkbox] { flex: none; width: auto; }
.raw-key { color: var(--muted); font-size: 11px; min-width: 200px; }
.advanced { margin-top: 8px; }
.advanced summary { cursor: pointer; color: var(--muted); font-size: 13px; padding: 4px 0; }
.actions { margin-top: 10px; display: flex; justify-content: flex-end; }
.test-mail { padding: 6px 14px; border: 1px solid #1e293b; background: #0b1220; color: var(--text); border-radius: 3px; cursor: pointer; }
.test-mail:hover:not(:disabled) { background: var(--accent); color: #0b1220; }
.test-mail:disabled { opacity: 0.5; cursor: not-allowed; }
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--panel); padding: 20px; border-radius: 6px; min-width: 420px; max-width: 90vw; }
.modal h3 { margin: 0 0 12px; }
.modal .row label { width: 80px; }
.error { color: #ef4444; font-size: 13px; margin: 8px 0; white-space: pre-wrap; }
.ok-msg { color: var(--accent); font-size: 13px; margin: 8px 0; }
.req { color: #ef4444; }
.primary { background: var(--accent); color: #0b1220; padding: 6px 14px; border: 1px solid #1e293b; border-radius: 3px; cursor: pointer; }
.primary:disabled { opacity: 0.5; cursor: not-allowed; }
.modal button { background: #0b1220; color: var(--text); border: 1px solid #1e293b; padding: 6px 14px; border-radius: 3px; cursor: pointer; }
</style>