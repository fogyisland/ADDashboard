<template>
  <AdminLayout>
    <header class="page-head">
      <h2>系统配置</h2>
      <p class="page-summary">采集节奏、告警阈值、Agent 连接与对外端口的全局参数。</p>
    </header>

    <section v-for="sec in SECTIONS" :key="sec.title" class="config-section">
      <header class="section-head">
        <h3>{{ sec.title }}</h3>
        <span v-if="sectionDirtyCounts[sec.title] > 0" class="section-dirty">
          本节 {{ sectionDirtyCounts[sec.title] }} 项未保存
        </span>
      </header>
      <table class="t">
        <tbody>
          <tr v-for="row in sec.rows" :key="row.key">
            <td>
              <div class="key-label">{{ row.label }}</div>
              <code class="raw-key">{{ row.key }}</code>
            </td>
            <td>
              <ConfigFieldRow
                :value="current[row.key]"
                :error="errors[row.key] || ''"
                :type="row.type"
                @update:value="onInput(row.key, $event)"
              />
              <span
                v-if="row.key === 'listenPort' && initial.restartRequired?.listenPort"
                class="restart-badge"
                title="保存后值已生效，需重启 center 后生效。重启后此标记消失。"
              >⚠ 待重启</span>
            </td>
            <td>
              <span class="desc-text">{{ row.description }}</span>
              <template v-if="row.key === 'ad_agent_token'">
                <div class="action-row">
                  <button class="token-action" @click="onGenerateToken">生成</button>
                  <button class="token-action" @click="onCopyToken">复制</button>
                  <span v-if="copyMsg" class="copy-msg">{{ copyMsg }}</span>
                </div>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="save-bar">
      <span v-if="dirty" class="dirty">⚠ 有未保存的修改</span>
      <button class="save" @click="onSaveClick" :disabled="!dirty || saving || hasErrors">{{ saving ? '保存中...' : '保存' }}</button>
      <button class="cancel" @click="onCancel" :disabled="!dirty || saving">取消修改</button>
      <span v-if="topLevelMsg" class="msg">{{ topLevelMsg }}</span>
    </footer>

    <ConfirmDialog
      v-if="showConfirm"
      :title="'以下字段会影响 Agent 连接'"
      :body="confirmBody"
      confirm-label="确认保存"
      :danger="true"
      @confirm="onConfirmSave"
      @cancel="showConfirm = false"
    />

    <section v-if="systemAudit.length" class="audit">
      <h3>历史变更 (最近 20 条)</h3>
      <table>
        <thead><tr><th>键</th><th>旧值</th><th>新值</th><th>操作人</th><th>时间</th><th></th></tr></thead>
        <tbody>
          <tr v-for="row in systemAudit" :key="row.id" class="audit-row">
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
import { useConfigValidation } from '../../composables/useConfigValidation.js';
import { useDirtyState } from '../../composables/useDirtyState.js';

// Email config (smtp_*, alert_*) lives on its own page; this page is the
// non-email core. The full set is filtered out of the audit so the two
// pages don't double-render the same rows.
const EMAIL_KEYS = new Set([
  'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_password', 'smtp_from',
  'alert_default_to', 'alert_default_cc',
  'alert_eval_interval_seconds', 'alert_email_max_attempts', 'alert_email_initial_backoff_seconds'
]);

// Internal bookkeeping keys the backend piggybacks on the GET response —
// they're not operator-facing config values. `restartRequired` is a
// computed object the badge logic reads off `initial.restartRequired`
// (no key in the table); `center_listen_port_started_version` is the
// hash the bootstrap IIFE writes every startup. Both would render as
// raw-key rows with no Chinese label, which is noise. Filter at load
// time so the table iteration only sees the real config keys.
const INTERNAL_KEYS = new Set([
  'center_listen_port_started_version',
  'restartRequired'
]);

// Sections group config keys by the operational concern they belong to.
// This is the single source of truth for label, description, and input
// type — the page header chrome (采集节奏 / 告警阈值 / 中心端口 etc.) is
// derived from this list. Adding a new operator-facing key = add a row
// to the right section. No scattered lookups.
const SECTIONS = [
  {
    title: '采集节奏',
    rows: [
      { key: 'polling_interval_minutes',   label: '采集周期',     description: 'Agent 复制指标采集周期 (分钟)。',                 type: 'number' },
      { key: 'heartbeat_interval_seconds', label: '心跳间隔',     description: 'Agent 心跳间隔 (秒),默认 5,越短越快感知掉线。',   type: 'number' },
      { key: 'site_matrix_refresh_seconds',label: '站点矩阵刷新', description: '站点复制矩阵页面自动刷新间隔 (秒)。',             type: 'number' },
    ]
  },
  {
    title: '告警阈值',
    rows: [
      { key: 'latency_threshold_minutes', label: '延迟阈值',     description: '复制延迟告警阈值 (分钟),超过即在仪表盘标红。',   type: 'number' },
      { key: 'history_enabled',           label: '历史快照',     description: '是否写入历史快照 (0/1),关闭后只保留当前状态。',   type: 'text' },
      { key: 'discovery_interval_hours',  label: '拓扑发现周期', description: '站点/域控拓扑发现周期 (小时)。',                  type: 'number' },
    ]
  },
  {
    title: 'Agent 连接',
    rows: [
      { key: 'ad_agent_token', label: 'Agent 令牌', description: 'Agent 与 center 共享令牌,改完 agent 端 appsettings.json 需同步。', type: 'text' },
    ]
  },
  {
    title: '中心端口',
    rows: [
      { key: 'listenPort',     label: '中心 Web 端口', description: '对外 Web/管理界面端口。改完需重启 center 后生效。',           type: 'number' },
      { key: 'heartbeat_port', label: '心跳端口',      description: 'Agent 心跳接收端口。DB 改后 5 min 内 agent 自动刷新。',       type: 'number' },
      { key: 'report_port',    label: '报告端口',      description: 'Agent replication snapshot 上报端口。',                     type: 'number' },
    ]
  },
];

// Audit rows can reference keys that aren't in SECTIONS (e.g. a config
// the operator added later). The audit column falls back to the raw key
// if no label is registered — keep this map non-exhaustive on purpose.
const labels = {
  polling_interval_minutes: '采集周期',
  latency_threshold_minutes: '延迟阈值',
  heartbeat_interval_seconds: '心跳间隔',
  history_enabled: '历史快照',
  ad_agent_token: 'Agent 令牌',
  discovery_interval_hours: '拓扑发现周期',
  site_matrix_refresh_seconds: '站点矩阵刷新',
  listenPort: '中心 Web 端口',
  heartbeat_port: '心跳端口',
  report_port: '报告端口',
};

const RISKY_FIELDS = ['ad_agent_token'];

const initial = ref({});
const { current, snapshot, dirty, markClean, reset } = useDirtyState({});
const { errors, validate, hasErrors } = useConfigValidation();

// Per-section dirty count drives the "[本节 N 项未保存]" badge next to
// each section title. Reactivity: depends on current/snapshot refs so
// the counts re-derive on every keystroke without manual invalidation.
const sectionDirtyCounts = computed(() => {
  const map = {};
  for (const sec of SECTIONS) {
    map[sec.title] = sec.rows.filter(
      (r) => String(current.value[r.key]) !== String(snapshot.value[r.key])
    ).length;
  }
  return map;
});

const saving = ref(false);
const topLevelMsg = ref('');
const showConfirm = ref(false);
const confirmBody = ref('');
const audit = ref([]);
const rollbackTarget = ref(null);
const copyMsg = ref('');

const systemAudit = computed(() => audit.value.filter((r) => !EMAIL_KEYS.has(r.configKey)).slice(0, 20));

function isUnrollbackable(row) {
  if (!row) return false;
  if (row.configKey !== 'smtp_password') return false;
  if (row.changeType === 'ROLLBACK') return false;
  if (row.oldValue === '********') return true;
  if (row.newValue === '********') return true;
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

async function load() {
  const r = await adminApi.getConfig();
  const all = r.data || {};
  // `current` is what the table iterates and what edits/saves operate on.
  // Email keys live on /admin/email-config (T17). Internal bookkeeping
  // (`center_listen_port_started_version` hash + `restartRequired` object)
  // is backend state, not operator config — without this filter they'd
  // render as raw-key rows with no Chinese label.
  const subset = {};
  for (const [k, v] of Object.entries(all)) {
    if (EMAIL_KEYS.has(k)) continue;
    if (INTERNAL_KEYS.has(k)) continue;
    subset[k] = v;
  }
  current.value = { ...subset };
  markClean(current.value);
  validate(current.value);
  // `initial` keeps `restartRequired` for the "⚠ 待重启" badge on the
  // listenPort row (template reads initial.restartRequired?.listenPort).
  // Storing the full backend response is fine — only `current` is shown
  // and PUT; `initial` is the dirty-state snapshot baseline.
  initial.value = { ...all };
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
.page-head { margin-bottom: 18px; }
.page-head h2 { margin: 0 0 4px; }
.page-summary { margin: 0; color: var(--muted); font-size: 13px; }

.config-section { margin-bottom: 22px; }
.section-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 8px;
}
.section-head h3 { margin: 0; font-size: 14px; font-weight: 600; color: var(--text); }
.section-dirty { color: #d97706; font-size: 12px; }

.t { width: 100%; border-collapse: collapse; background: var(--panel); }
.t th, .t td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #1e293b; vertical-align: top; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
.desc-text { color: var(--muted); font-size: 12px; display: block; }
.action-row { margin-top: 6px; display: flex; gap: 4px; align-items: center; }

.save-bar {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 0;
  margin-top: 8px;
  background: var(--bg);
  border-top: 1px solid #1e293b;
}
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
.raw-key { display: block; font-size: 11px; color: var(--muted); margin-top: 2px; font-style: italic; }
.restart-badge { display: inline-block; margin-left: 8px; padding: 2px 8px; background: #7f1d1d; color: #fee2e2; border: 1px solid #b91c1c; border-radius: 3px; font-size: 11px; cursor: help; }
.err { display: block; color: #ef4444; font-size: 12px; margin-top: 4px; }
</style>