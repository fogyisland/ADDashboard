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
              <code v-if="!row.derived" class="raw-key">{{ row.key }}</code>
            </td>
            <td>
              <div v-if="row.derived" class="endpoint-grid">
                <div class="endpoint-col">
                  <div class="endpoint-col-head">域名</div>
                  <div class="endpoint-col-body">
                    <code v-if="agentDomainAddress" class="derived-value">{{ agentDomainAddress }}</code>
                    <code v-else class="endpoint-empty">— (未配访问域名)</code>
                  </div>
                </div>
                <div class="endpoint-col">
                  <div class="endpoint-col-head">IP 地址</div>
                  <div class="endpoint-col-body">
                    <code class="derived-value">{{ agentIpAddress }}</code>
                  </div>
                </div>
              </div>
              <!-- 2026-08-21 UX redesign (auto-delivery): two buttons — 复制令牌
                   is a one-click reveal+copy (no modal, no rotation); 生成新令牌
                   opens the modal which surfaces the new token once + shows
                   the live delivery progress ("已推送到 X / N 台 Agent").
                   Operators no longer RDP-and-edit because agents pick up
                   the new credential on their next heartbeat via the
                   agent_token_version counter. -->
              <template v-else-if="row.key === 'ad_agent_token'">
                <div class="agent-token-row">
                  <code
                    class="token-mask"
                    title="当前生效令牌的指纹（sha256 前 8 位，不可逆）。生成新令牌后指纹会变；完整令牌请用「复制令牌」。"
                  >…{{ maskToken() }}</code>
                  <span :class="['token-mode', `token-mode-${tokenState.mode}`]">
                    v{{ tokenState.version }}
                  </span>
                  <button class="copy-btn" @click="onCopyTokenClick" :disabled="copying">
                    {{ copyBtnLabel }}
                  </button>
                  <button class="generate-btn" @click="onGenerateClick" :disabled="generating">
                    {{ generating ? '生成中…' : '生成新令牌' }}
                  </button>
                  <span v-if="copyMsg" class="copy-msg">{{ copyMsg }}</span>
                </div>
              </template>
              <ConfigFieldRow
                v-else
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
                <div class="action-hint">
                  新装/离线 agent 复制当前令牌后填入 <code>appsettings.json</code> 即可;已联机的 agent 会在下次心跳(< 10s)自动接收新令牌,无需手动操作。
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

    <AgentTokenRotateModal
      v-if="showGenerateModal"
      mode="generate"
      :visible="showGenerateModal"
      :new-token="generatedNewToken"
      @close="onModalClose"
      @copied="onModalCopied"
    />
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import ConfigFieldRow from './ConfigFieldRow.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import AgentTokenRotateModal from '../../components/AgentTokenRotateModal.vue';
import { adminApi } from '../../api/admin.js';
import { useConfigValidation } from '../../composables/useConfigValidation.js';
import { useDirtyState } from '../../composables/useDirtyState.js';
import { notifyError } from '../../lib/notify.js';

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
  'center_listen_port_pending_version',
  'restartRequired',
  // serverIp is returned alongside the config by GET /api/admin/config
  // (utils/network.js getPrimaryIPv4()) for the derived "Agent 连接地址"
  // row's fallback host. It's backend state, not an operator-editable key.
  'serverIp'
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
      // R158.107 (2026-10-16) — package_runs_retention_days 字段删 (8 service
      //   统一读 ad_mgmt_retention_days). 旧 key ship 时一次性 DELETE migration
      //   移除 system_config row. R158.19 ship 时加的字段同步删, 不留 audit 兼容.
    ]
  },
  {
    title: '告警阈值',
    rows: [
      { key: 'latency_threshold_minutes', label: '延迟阈值',     description: '复制延迟告警阈值 (分钟),超过即在仪表盘标红。',   type: 'number' },
      { key: 'history_enabled',           label: '历史快照',     description: '是否写入历史快照 (0/1),关闭后只保留当前状态。',   type: 'text' },
      { key: 'discovery_interval_hours',  label: '拓扑发现周期', description: '站点/域控拓扑发现周期 (小时)。',                  type: 'number' },
      // R158.16 (2026-10-01) -- 邮件总开关. 关闭时 system-alert-engine 不入
      // system_alert_outbox, email tick 不发 SMTP (双层防御见 system-alert-engine
      // detector 节流 + email.js tick). 默认 '0' = 关闭. 修改后下一次
      // system-alert eval (60s 周期) 即生效, 不需重启 centre. toggle UI
      // 渲染为开关拨片, 比 select 更直观. R158.68 沿用.
      { key: 'email_enabled', label: '邮件总开关', description: '全局邮件功能开关。关闭后告警仍写入 alert_events 审计表,但不发送邮件 (SMTP 全静默)。', type: 'toggle', onLabel: '开', offLabel: '关' },
    ]
  },
  {
    // R158.46.30 (2026-10-06) — operator "管理记录默认保留30天，但是支持在
    // 系统设置中修改，多一个字段AD管理日志保存时间". ad_mgmt_retention_days
    // 走 hourly cron (createAdMgmtAuditRetentionLoop) 删 audit_logs
    // WHERE action IN ad_management AND created_at < cutoff. 0 = 关闭保留
    // (永远不删, 合规场景). 默认 30. 修改后下次 cron tick (最多 1h) 即生效,
    // 不需重启 centre.
    //
    // R158.107 (2026-10-16) — 升级为中心端统一的 retention single source of
    //   truth. 8 个 retention service 全部改读此 key (audit / package_runs /
    //   email_history / report / ad_account_change / eventlog /
    //   member_eventlog / member_os_baseline / failed_logon). file-push 保持
    //   独立 file_push_retention_days. group title 升格 "日志保留" → "数据
    //   保留时间 (统一)", description 改覆盖全部 8 service 范围. 操作员
    //   directive "后续所有数据保留周期都统一".
    title: '数据保留时间 (统一)',
    rows: [
      { key: 'ad_mgmt_retention_days', label: '数据保留天数', description: '中心端 8 个 retention sweep 统一保留天数（audit ad_management 类目 / package_runs / 邮件历史 system_alert_outbox + report_email_outbox + ad_notify_outbox / daily_reports / ad_account_change / eventlog 5 channel / member_eventlog 3 channel / member_os_baseline / failed_logon 4625），0 = 永久保留不删。file-push 任务数据走独立 file_push_retention_days。', type: 'number' },
    ]
  },
  {
    title: 'Agent 连接',
    rows: [
      {
        // Read-only derived row: shows the URL agents use to reach this
        // center. Composed from `access_domain` (if set) else the server's
        // primary IPv4 (returned by GET /api/admin/config as `serverIp`)
        // plus the configured listenPort. The operator pastes it into the
        // agent's appsettings.json centerUrl, substituting <server> for the
        // actual IP/hostname when the agent runs on a different host.
        key: '__agent_address__',
        label: 'Agent 连接地址',
        derived: true,
        description: 'Agent 用此地址连入 center;本机 agent 写 localhost,跨机 agent 改<server>为本机 IP/hostname,写入 agent 端 appsettings.json 的 centerUrl。'
      },
      // access_domain is the friendly hostname operator sets (e.g.
      // dashboard.corp.com). When non-empty, both the "Agent 连接地址"
      // derived row above AND any client-app access URL resolves to
      // `<access_domain>:<listenPort>`. Empty = fall back to server IP
      // (from serverIp in the GET /api/admin/config response).
      { key: 'access_domain', label: '访问域名', description: '客户端与 Agent 访问域名;留空则用服务器 IP。修改后保存即生效,无需重启 center。', type: 'text' },
      // 2026-08-21 UX redesign (auto-delivery): the ad_agent_token row is
      // now an interactive surface with two buttons (复制令牌 + 生成新令牌).
      // PUT writes still go to the legacy `ad_agent_token` key which is
      // no longer the runtime auth source of truth (auth/agent-token.js
      // reads `agent_token_current`), so the backend putConfigInTx still
      // rejects writes to this key with 400 — the row's TypeScript shape
      // is 'agent-token' but the template branch is the only handler.
      { key: 'ad_agent_token', label: 'Agent 令牌', type: 'agent-token', description: 'Agent 与 center 通信的共享密钥,96 hex chars。复制当前令牌填入新装 agent;生成新令牌已联机 agent 自动接收。' },
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
  access_domain: '访问域名',
  email_enabled: '邮件总开关',
  ad_mgmt_retention_days: '数据保留天数',
};

// #167 I1: ad_agent_token was removed from RISKY_FIELDS — the field is
// now a read-only notice-row (backend putConfigInTx rejects writes with
// 400). The risky-confirm dialog is no longer reachable for this key.
const RISKY_FIELDS = [];

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

// Derived read-only display for the Agent 连接地址 row. Combines the
// configured `access_domain` (or the server's primary IPv4 as fallback)
// with the configured listenPort. Empty / missing port renders as '—' so
// we don't show a half-built URL before the operator has configured the
// port. Both the operator-facing client URL AND the agent centerUrl use
// this same resolution: domain if set, IP if empty.
const serverIp = ref('');
const agentAddress = computed(() => {
  const port = current.value.listenPort;
  if (!port) return '—';
  const domain = (current.value.access_domain || '').trim();
  const host = domain || serverIp.value;
  if (!host) return '—';
  return `http://${host}:${port}`;
});
// R158.113.e (2026-10-17) — Agent 连接 段第 1 row __agent_address__ 改 endpoint-grid 2 列 (域名 + IP).
//   跟 R158.113.d McpReadTabView / McpWriteTokenView 1:1 平行 endpoint-grid 范式.
//   agentAddress 既有 computed 0 删 0 改 (backward compat), 跟 2 新 computed 1:1 平行.
//   0 引新 endpoint / 0 改 R158.113.c 既有 2 端点 (跟 R158.113.d 1:1 平行 0 后端改).
const agentDomainAddress = computed(() => {
  const port = current.value.listenPort;
  if (!port) return '—';
  const domain = (current.value.access_domain || '').trim();
  if (!domain) return null;  // null 触发 template 显示 "— (未配访问域名)"
  return `http://${domain}:${port}`;
});
const agentIpAddress = computed(() => {
  const port = current.value.listenPort;
  if (!port || !serverIp.value) return '—';
  return `http://${serverIp.value}:${port}`;
});

// Token rotation state surfaced by the Agent 令牌 row. Loaded in parallel
// with getConfig so the version badge ("v3") is populated on first paint.
// NEVER stores the secret — getAgentTokenState() intentionally omits it;
// the only time a plaintext token appears in this view is inside
// AgentTokenRotateModal after a generate OR transiently in `copiedToken`
// while the 复制令牌 button is showing "已复制 ✓" feedback.
const tokenState = ref({ mode: 'single', version: 0, rotatedAt: null, tokenFingerprint: '' });
const showGenerateModal = ref(false);
const generatedNewToken = ref(null);
// 复制令牌 button transient state. `copiedToken` is the most-recently
// revealed plaintext (kept in memory only, never persisted). `copyMsg`
// is the inline "已复制 ✓ Agent1 v3" hint that fades after 3s.
const copying = ref(false);
const copyMsg = ref('');
const copiedToken = ref(null);
const topLevelMsg = ref('');
const showConfirm = ref(false);
const confirmBody = ref('');
const audit = ref([]);
const rollbackTarget = ref(null);

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

// #167 I1: previous onGenerateToken / onCopyToken helpers were removed
// after the I1 read-only-notice refactor. The 2026-08-21 UX redesign
// re-introduced a copy flow (one-click reveal + clipboard) plus a
// generate flow (rotate + delivery progress modal), both below.

async function load() {
  try {
    const r = await adminApi.getConfig();
    const all = r.data || {};
    // serverIp is the fallback host for the "Agent 连接地址" derived row
    // when `access_domain` is empty. Returned by GET /api/admin/config
    // alongside the config (server-side via utils/network.js
    // getPrimaryIPv4()); kept as a separate ref so it doesn't pollute
    // the dirty-tracking `current` (operators don't edit it).
    serverIp.value = all.serverIp || '';
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
    // Fetch token rotation state in parallel (don't block main load on it).
    // Failure degrades silently to safe default — same pattern as loadAudit.
    await reloadTokenState();
    await loadAudit();
  } catch (e) {
    notifyError(`加载配置失败: ${e?.message || '未知错误'}`);
  }
}

async function loadAudit() {
  try {
    const r = await adminApi.getConfigAudit();
    audit.value = r.data || [];
  } catch (e) {
    audit.value = [];
    notifyError(`加载变更历史失败: ${e?.message || '未知错误'}`);
  }
}

function formatTs(s) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString();
}

function maskToken() {
  // R161.9 — 这里以前返回硬编码常量 'a3f9'（注释写 "purely decorative"）。
  // 后果: 无论生成多少次新令牌，界面上的"缩写"永远不变 ⇒ 操作员看到这行
  // 无法判断它显示的是不是当前生效的那一枚令牌（看着像 bug，实际是假的）。
  //
  // 现在显示服务端算的**指纹**（GET /api/admin/agent-token 返回的
  // tokenFingerprint = sha256(生效令牌) 前 8 位）：
  //   · 随生成新令牌而变 —— 这正是操作员要的"会变的缩写"；
  //   · 不可逆，不泄露明文片段，可以待在无审计的读路径上；
  //   · 由服务端算，前端**不复制**哈希规则（避免两端算法漂移）。
  // 完整令牌只在「复制令牌」的 reveal 响应里出现（那条路径写高危审计行）。
  return tokenState.value.tokenFingerprint || '--------';
}

// 复制令牌: one-click reveal + clipboard. The "已复制 ✓ Agent1 v3"
// inline message sticks for 3s before clearing — long enough for the
// operator to glance-confirm, short enough that the row doesn't keep
// showing a stale hint while they scroll. The plaintext lives only in
// `copiedToken` (memory); nothing is persisted.
async function onCopyTokenClick() {
  if (copying.value) return;
  copying.value = true;
  try {
    const r = await adminApi.revealAgentToken();
    const tok = r.data?.token;
    const ver = r.data?.version ?? tokenState.value.version;
    if (!tok) throw new Error('服务端未返回令牌');
    copiedToken.value = tok;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(tok);
        copyMsg.value = `已复制 ✓ (v${ver})`;
      } catch {
        copyMsg.value = `已读取令牌(v${ver})—剪贴板不可用,请手动复制`;
      }
    } else {
      copyMsg.value = `已读取令牌(v${ver})—剪贴板不可用,请手动复制`;
    }
    setTimeout(() => { copyMsg.value = ''; }, 3000);
  } catch (e) {
    notifyError(`读取令牌失败: ${e?.response?.data?.error || e?.message || '未知错误'}`);
  } finally {
    copying.value = false;
  }
}

const copyBtnLabel = computed(() => {
  if (copying.value) return '读取中…';
  if (copyMsg.value) return '复制令牌';
  return '复制令牌';
});

// 生成新令牌: rotate → open modal in generate mode (which owns the
// delivery polling + progress UI). After rotate, reload token state so
// the row badge updates to the new version immediately.
const generating = ref(false);
async function onGenerateClick() {
  if (generating.value) return;
  generating.value = true;
  try {
    const r = await adminApi.rotateAgentToken();
    generatedNewToken.value = r.data.newToken;
    tokenState.value = {
      mode: 'dual',
      version: r.data.version ?? tokenState.value.version,
      rotatedAt: r.data.rotatedAt || new Date().toISOString()
    };
    // R161.9 — 重新拉一次服务端状态，让这一行的指纹跟新令牌对上。
    // 指纹由服务端算（前端不复制哈希规则），所以只能靠服务端回传。
    await reloadTokenState();
    showGenerateModal.value = true;
  } catch (e) {
    notifyError(`生成新令牌失败: ${e?.response?.data?.error || e?.message || '未知错误'}`);
  } finally {
    generating.value = false;
  }
}

function onModalClose() {
  // Clears the generate-mode payload so a stale secret doesn't linger
  // after close. The modal's own watch on `visible` stops its poll
  // timer; we just drop the parent-side ref.
  showGenerateModal.value = false;
  generatedNewToken.value = null;
}

// Modal emits 'copied' when the operator clicks the in-modal 复制
// button. We surface this as a brief row-level toast too so the
// feedback is visible even if the modal is partially obscured.
function onModalCopied() {
  copyMsg.value = `已复制 ✓ (v${tokenState.value.version})`;
  setTimeout(() => { copyMsg.value = ''; }, 3000);
}

async function reloadTokenState() {
  try {
    const r = await adminApi.getAgentTokenState();
    const s = r.data || {};
    tokenState.value = {
      mode: s.mode || 'single',
      version: typeof s.version === 'number' ? s.version : 0,
      rotatedAt: s.rotatedAt || null,
      tokenFingerprint: s.tokenFingerprint || ''
    };
  } catch {
    // R161.9 — 失败时**保留**已持有的状态，不要重置成 v0/single。
    // 原因: onGenerateClick 在生成新令牌后会调本函数拉指纹；如果这一次拉取
    // 失败而这里重置，界面会显示 "v0 / single / 无指纹"，比旧状态更误导
    // （操作员刚生成完新令牌，看到的却是"没有令牌"）。首次加载时保留的初始
    // 值本来就等于旧的默认值，行为不变。
    tokenState.value = {
      ...tokenState.value,
      tokenFingerprint: tokenState.value.tokenFingerprint || ''
    };
  }
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
    notifyError(`回滚失败: ${e?.message || '未知错误'}`);
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
.section-dirty { color: var(--status-pill-fg-warn); font-size: 12px; }

.t { width: 100%; border-collapse: collapse; background: var(--panel); }
.t th, .t td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; }
.t th { background: var(--sidebar-bg); color: var(--muted); font-size: 12px; }
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
  border-top: 1px solid var(--border);
}
.dirty { color: var(--yellow); margin-right: 12px; }
button.save, button.cancel { padding: 6px 14px; border: 1px solid var(--border); background: var(--accent); color: var(--sidebar-bg); border-radius: 3px; cursor: pointer; margin-right: 8px; }
button.save:disabled, button.cancel:disabled { opacity: 0.5; cursor: not-allowed; }
button.cancel { background: var(--sidebar-bg); color: var(--text); }
.msg { margin-left: 12px; color: var(--accent); }

.audit { margin-top: 24px; }
.audit h3 { margin: 0 0 8px; font-size: 14px; color: var(--muted); }
.audit table { width: 100%; border-collapse: collapse; background: var(--panel); }
.audit th, .audit td { padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; }
.audit th { background: var(--sidebar-bg); color: var(--muted); font-size: 12px; }
.audit code { font-size: 12px; color: var(--text); }
.audit button.rollback { padding: 4px 10px; border: 1px solid var(--border); background: var(--accent); color: var(--sidebar-bg); border-radius: 3px; cursor: pointer; font-size: 12px; }
.audit button.rollback:disabled { background: var(--border); color: var(--muted); cursor: not-allowed; }
.token-action { padding: 3px 10px; border: 1px solid var(--border); background: var(--sidebar-bg); color: var(--text); border-radius: 3px; cursor: pointer; font-size: 12px; margin-right: 4px; }
.token-action:hover:not(:disabled) { background: var(--accent); color: var(--sidebar-bg); }
.token-action:disabled { opacity: 0.5; cursor: not-allowed; }
.copy-msg { color: var(--accent); font-size: 12px; margin-left: 6px; }

/* 2026-08-21 UX redesign (auto-delivery): the ad_agent_token row now
   renders two buttons (复制令牌 + 生成新令牌) instead of three. The
   复制令牌 button is a one-click reveal + clipboard; the 生成新令牌
   button opens the modal in generate mode. The `.token-mode` badge
   shows the monotonic version counter (v3 / v7 / ...) — single vs dual
   is implicit (mode flips to dual after a rotate until the 5-min
   internal grace elapses, which the operator never sees). */
.agent-token-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.token-mask {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  color: var(--muted);
  background: var(--sidebar-bg);
  padding: 6px 10px;
  border-radius: 3px;
  border: 1px solid var(--border);
}
.token-mode {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 3px;
  border: 1px solid var(--border);
}
.token-mode-single { background: var(--sidebar-bg); color: var(--muted); }
.token-mode-dual { background: var(--danger-bg); color: var(--severity-critical-text); border-color: var(--status-pill-fg-err); }
.copy-btn, .generate-btn {
  padding: 4px 12px;
  border: 1px solid var(--border);
  background: var(--sidebar-bg);
  color: var(--text);
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
}
.copy-btn:hover:not(:disabled),
.generate-btn:hover:not(:disabled) { background: var(--panel-alt); }
.copy-btn:disabled, .generate-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.action-hint { display: block; margin-top: 6px; font-size: 11px; color: var(--muted); }
.action-hint code { background: var(--sidebar-bg); padding: 1px 4px; border-radius: 2px; }
.key-label { font-weight: 600; color: var(--text); }
.raw-key { display: block; font-size: 11px; color: var(--muted); margin-top: 2px; font-style: italic; }
.derived-value {
  display: inline-block;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  color: var(--accent);
  background: var(--sidebar-bg);
  padding: 6px 10px;
  border-radius: 3px;
  border: 1px solid var(--border);
}
/* R158.113.e (2026-10-17) — Agent 连接 段第 1 row __agent_address__ 改 endpoint-grid 2 列 (域名 + IP).
   跟 R158.113.d McpTokenView 1:1 平行 endpoint-grid 范式. 0 scoped (ConfigView 0 <style scoped>).
   跟 R158.103 site-replication-matrix detail-drawer 双指标并排 1:1 平行. */
.endpoint-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 6px; }
.endpoint-col { border: 1px solid var(--border, #e5e7eb); border-radius: 6px; padding: 8px 10px; background: var(--sidebar-bg, #f9fafb); }
.endpoint-col-head { font-size: 12px; color: var(--muted, #6b7280); margin-bottom: 4px; font-weight: 500; }
.endpoint-col-body { display: flex; align-items: center; gap: 6px; min-width: 0; }
.endpoint-col-body code { flex: 1; min-width: 0; word-break: break-all; font-size: 13px; }
.endpoint-empty { color: var(--muted, #6b7280); font-style: italic; font-size: 13px; }
.restart-badge { display: inline-block; margin-left: 8px; padding: 2px 8px; background: var(--danger-bg); color: var(--severity-critical-text); border: 1px solid var(--status-pill-fg-err); border-radius: 3px; font-size: 11px; cursor: help; }
.err { display: block; color: var(--red); font-size: 12px; margin-top: 4px; }
</style>