<template>
  <AdminLayout>
    <div class="head">
      <h2>Agent 客户端设置</h2>
      <span class="ver" v-if="version !== null">当前版本 v{{ version }}</span>
    </div>

    <p class="hint">
      这里改的是所有 Agent 的运行时参数。保存后版本号 +1，每台 Agent 在<strong>下一次心跳</strong>
      （最多 {{ form.heartbeatIntervalSeconds || 60 }} 秒）拉到新值并立即生效 —— 不需要重启服务，
      也不需要操作员登每台服务器手改 appsettings.json。
    </p>

    <div class="warn" v-if="logLevel === 'debug' && form.logLevel === 'info'">
      日志级别：当前 Agent 实际运行在 <strong>debug</strong>（逐请求全量输出），正在切回 <strong>info</strong>。
    </div>

    <section class="card">
      <h3>参数</h3>
      <p v-if="!hasAny" class="empty-hint">
        尚未推送过任何设置 —— 各 Agent 用的是 appsettings.json 里的默认值。填好任意字段并保存即可下发。
      </p>

      <div class="grid">
        <label v-for="f in FIELDS" :key="f.key" class="field">
          <span class="lbl">
            {{ f.label }}
            <em class="range">{{ f.range }}</em>
          </span>
          <select v-if="f.key === 'logLevel'" v-model="form.logLevel">
            <option v-for="lv in LEVELS" :key="lv" :value="lv">{{ lv }}</option>
          </select>
          <input v-else type="number" v-model.number="form[f.key]" :min="f.min" :max="f.max" :step="f.step" />
          <span class="desc">{{ f.desc }}</span>
          <span class="cur" v-if="effective[f.key] !== undefined && form[f.key] !== effective[f.key]">
            当前生效：{{ effective[f.key] }}
          </span>
        </label>
      </div>

      <div class="actions">
        <button class="save-btn" :disabled="saving || !canSave" @click="save">
          {{ saving ? '推送中...' : '保存并推送到所有 Agent' }}
        </button>
        <button :disabled="saving" @click="reset">重置表单</button>
      </div>
      <span v-if="msg" class="msg" :class="{ err: isErr }">{{ msg }}</span>
    </section>

    <section class="card">
      <h3>下发进度</h3>
      <p class="hint inline">
        已生效 <strong>{{ delivered }} / {{ total }}</strong> 台
        <span v-if="total > 0 && delivered < total" class="pending">
          · {{ total - delivered }} 台等待下一次心跳
        </span>
      </p>
      <button class="reload" @click="loadAll" :disabled="loading">刷新</button>

      <table class="t" v-if="agents.length">
        <thead>
          <tr><th>Agent</th><th>已上报版本</th><th>状态</th><th>最后心跳</th></tr>
        </thead>
        <tbody>
          <tr v-for="a in agents" :key="a.agentId">
            <td>{{ a.agentId }}</td>
            <td>v{{ a.reportedVersion }}</td>
            <td>
              <span class="pill" :class="a.reportedVersion >= version ? 'ok' : 'wait'">
                {{ a.reportedVersion >= version ? '已生效' : '待心跳' }}
              </span>
            </td>
            <td class="muted">{{ a.lastSeenAt || '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-hint">暂无 Agent 心跳记录</p>
    </section>
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { getState, push, getDelivery } from '../../api/client-settings.js';

// Field table mirrors center/src/services/client-settings.js
// validateSettingsPatch — min/max/unit here are UX affordances only; the
// server re-validates every field and returns 400 on any miss. Keeping the
// two in sync avoids the user hitting a save that the server rejects.
const FIELDS = [
  { key: 'heartbeatIntervalSeconds', label: '心跳间隔', unit: '秒', min: 1, max: 3600, step: 1,
    range: '1 ~ 3600 秒', desc: 'Agent 多久向中心端上报一次在线状态。调小 = 状态更实时，但请求更多。' },
  { key: 'pollingIntervalMinutes', label: '轮询间隔', unit: '分钟', min: 1, max: 1440, step: 1,
    range: '1 ~ 1440 分钟', desc: 'Agent 多久向中心端拉取一次采集任务配置。' },
  { key: 'discoveryIntervalHours', label: '发现间隔', unit: '小时', min: 1, max: 168, step: 1,
    range: '1 ~ 168 小时', desc: 'Agent 多久重新发现一次域内可用服务器。' },
  { key: 'healthCheckIntervalMs', label: '健康检查间隔', unit: '毫秒', min: 1000, max: 86400000, step: 1000,
    range: '1000 ~ 86400000 毫秒', desc: '健康检查探针的最小间隔，防止探针把目标打爆。' },
  { key: 'logLevel', label: '日志级别', desc: 'info = 只记结果（默认）；error = 加记失败；debug = 逐请求全量（排障用，量大）。' }
];

const LEVELS = ['info', 'error', 'debug'];

const settings = ref({});
const version = ref(null);
const delivery = ref({ serverVersion: 0, total: 0, delivered: 0, agents: [] });
const form = ref(blank());
const saving = ref(false);
const loading = ref(false);
const msg = ref('');
const isErr = ref(false);

function blank() {
  const f = {};
  for (const x of FIELDS) f[x.key] = x.key === 'logLevel' ? 'info' : null;
  return f;
}

// Effective (server-side) values, shown only when the form diverges —
// tells the operator "you're changing 60 → 30" instead of silently
// overwriting. The hint above the card already explains the heartbeat lag.
const effective = computed(() => settings.value || {});
const logLevel = computed(() => settings.value?.logLevel || 'info');

const hasAny = computed(() => FIELDS.some((f) => effective.value[f.key] !== undefined));

// Only send fields the operator actually filled in. Sending every field with
// nulls would trip the server's "must be a positive integer" guard on
// untouched numeric inputs, so a partial edit is a partial patch.
const canSave = computed(() => FIELDS.some((f) => {
  const v = form.value[f.key];
  if (v === null || v === '') return false;
  if (f.key === 'logLevel') return LEVELS.includes(v);
  return Number.isInteger(v) && v >= f.min && v <= f.max;
}));

function buildPatch() {
  const p = {};
  for (const f of FIELDS) {
    const v = form.value[f.key];
    if (v === null || v === '') continue;
    p[f.key] = f.key === 'logLevel' ? v : Number(v);
  }
  return p;
}

async function loadAll() {
  loading.value = true;
  try {
    const [s, d] = await Promise.all([getState(), getDelivery()]);
    settings.value = s?.data?.settings || {};
    version.value = s?.data?.version ?? null;
    delivery.value = d?.data || { serverVersion: 0, total: 0, delivered: 0, agents: [] };
    reset();
  } catch (e) {
    isErr.value = true;
    msg.value = (e?.response?.data?.error) || '加载失败';
  } finally {
    loading.value = false;
  }
}

function reset() {
  const f = blank();
  for (const x of FIELDS) {
    if (effective.value[x.key] !== undefined) f[x.key] = effective.value[x.key];
  }
  form.value = f;
}

async function save() {
  saving.value = true;
  msg.value = '';
  isErr.value = false;
  try {
    const { data } = await push(buildPatch());
    version.value = data?.version ?? version.value;
    msg.value = `已推送 v${data?.version}，Agent 将在下一次心跳（最多 ${data?.settings?.heartbeatIntervalSeconds ?? '—'} 秒）内生效`;
    await loadAll();
  } catch (e) {
    isErr.value = true;
    msg.value = (e?.response?.data?.error) || '推送失败';
  } finally {
    saving.value = false;
  }
}

onMounted(loadAll);
</script>

<style scoped>
.head { display: flex; align-items: baseline; gap: 12px; }
.head h2 { margin: 0; }
.ver { color: var(--muted); font-size: 13px; }
.hint { color: var(--muted); font-size: 13px; margin: 8px 0 16px; }
.hint.inline { margin: 0 0 12px; }
.hint strong { color: var(--text); }
.pending { color: var(--accent); }
.warn {
  background: var(--panel); border-left: 3px solid var(--accent);
  padding: 10px 12px; font-size: 13px; margin: 0 0 16px;
}
.card {
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 6px; padding: 16px; margin-bottom: 16px;
}
.card h3 { margin: 0 0 12px; font-size: 14px; }
.empty-hint { color: var(--muted); font-size: 13px; margin: 0 0 12px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.lbl { font-weight: 600; display: flex; align-items: baseline; gap: 8px; }
.range { color: var(--muted); font-style: normal; font-size: 11px; font-weight: 400; }
.desc { color: var(--muted); font-size: 12px; line-height: 1.5; }
.cur { color: var(--accent); font-size: 12px; }
input[type=number], select {
  padding: 6px; background: var(--sidebar-bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 3px;
}
.actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
.reload { margin-bottom: 12px; }
.msg { display: block; margin-top: 10px; color: var(--accent); font-size: 13px; }
.msg.err { color: #e5534b; }

.t { width: 100%; border-collapse: collapse; }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); }
.t th { background: var(--sidebar-bg); color: var(--muted); font-size: 12px; }
.muted { color: var(--muted); }
.pill { font-size: 12px; padding: 2px 8px; border-radius: 10px; }
.pill.ok { background: rgba(63, 185, 80, 0.15); color: #3fb950; }
.pill.wait { background: rgba(210, 153, 34, 0.15); color: #d29922; }
</style>