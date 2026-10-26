<!--
  SystemAlertsView (R158.68 — 2026-10-10)
  替代 R158.62/63/67 AlertInboxView 全套 (3-tab 自定义告警规则 + 邮件勾选重发).
  现在 5 种内置告警 (心跳离线 / 复制失败 / 端口延迟 / 磁盘 / 失败登录 spike)
  统一由 system-alert-engine detector 评估, 阈值集中配置, 自动 enqueue 邮件.
  内置告警没有 "创建规则" 的概念, 只有 "调整阈值" + "ack" 跟 "重发邮件".

  3 sub-tab:
    1. 当前告警   — state='firing' 的所有内置告警 (按时间倒序), 每条带 ack 按钮
    2. 历史告警   — state in (recovered, acked) 的全部历史 (按 fired_at 倒序)
    3. 阈值配置   — 5 个阈值 + 收件人 + eval 周期, 改完 PUT /api/admin/system-alerts/config
  顶部 KPI bar: 当前 firing 总数 / 24h 触发数 / 已 ack 数 (admin.js 调 /api/admin/system-alerts/kpi).
-->
<template>
  <div class="system-alerts-view">
    <!-- KPI bar -->
    <div class="kpi-bar">
      <div class="kpi">
        <div class="kpi-k">当前 firing</div>
        <div class="kpi-v" :class="{ on: (kpi.firing || 0) > 0 }">
          {{ kpi.firing ?? '-' }}
        </div>
      </div>
      <div class="kpi">
        <div class="kpi-k">24h 触发</div>
        <div class="kpi-v">{{ kpi.last24h ?? '-' }}</div>
      </div>
      <div class="kpi">
        <div class="kpi-k">24h 恢复</div>
        <div class="kpi-v">{{ kpi.recovered24h ?? '-' }}</div>
      </div>
      <div class="kpi">
        <div class="kpi-k">24h 已 ack</div>
        <div class="kpi-v">{{ kpi.acked24h ?? '-' }}</div>
      </div>
    </div>

    <!-- sub-tab 切换 -->
    <div class="sub-tabs">
      <button :class="{ on: subTab === 'firing' }" @click="subTab = 'firing'">
        当前告警 ({{ rows.length }})
      </button>
      <button :class="{ on: subTab === 'recent' }" @click="subTab = 'recent'">
        历史告警
      </button>
      <button :class="{ on: subTab === 'config' }" @click="subTab = 'config'">
        阈值配置
      </button>
      <button @click="reload" :disabled="loading" class="refresh-btn">
        {{ loading ? '刷新中...' : '刷新' }}
      </button>
    </div>

    <!-- 当前告警 -->
    <div v-if="subTab === 'firing'" class="card">
      <table class="t" v-if="rows.length">
        <thead>
          <tr>
            <th>类别</th>
            <th>主机 / 范围</th>
            <th>详情</th>
            <th>阈值</th>
            <th>触发于</th>
            <th>邮件次数</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in rows" :key="a.id">
            <td>
              <span :class="['pill', kindBadge(a.kind)]">{{ kindLabel(a.kind) }}</span>
            </td>
            <td><code>{{ a.scope_ref || (a.scope_type === 'global' ? '全局' : '-') }}</code></td>
            <td><small>{{ renderDetail(a) }}</small></td>
            <td><small>{{ renderThreshold(a) }}</small></td>
            <td><small>{{ fmt(a.fired_at) }}</small></td>
            <td><small>{{ a.notify_count || 0 }}</small></td>
            <td>
              <button @click="onAck(a)" :disabled="acking === a.id">
                {{ acking === a.id ? '确认中...' : 'ACK' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted">无活动告警 — 所有 detector 当前正常 ✓</p>
    </div>

    <!-- 历史告警 -->
    <div v-if="subTab === 'recent'" class="card">
      <div class="filter-bar">
        <label>类别</label>
        <select v-model="recentKind">
          <option value="">全部</option>
          <option value="heartbeat_offline">心跳离线</option>
          <option value="replication_failed">复制失败</option>
          <option value="port_latency_high">端口延迟</option>
          <option value="disk_low">磁盘低</option>
          <option value="failed_logon_spike">失败登录 spike</option>
        </select>
        <button @click="loadRecent">查询</button>
      </div>
      <table class="t" v-if="recentRows.length">
        <thead>
          <tr>
            <th>类别</th>
            <th>主机 / 范围</th>
            <th>状态</th>
            <th>触发于</th>
            <th>恢复于</th>
            <th>ack 于</th>
            <th>详情</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in recentRows" :key="a.id">
            <td><span :class="['pill', kindBadge(a.kind)]">{{ kindLabel(a.kind) }}</span></td>
            <td><code>{{ a.scope_ref || (a.scope_type === 'global' ? '全局' : '-') }}</code></td>
            <td>
              <span :class="['pill', stateBadge(a.state)]">{{ stateLabel(a.state) }}</span>
            </td>
            <td><small>{{ fmt(a.fired_at) }}</small></td>
            <td><small>{{ a.recovered_at ? fmt(a.recovered_at) : '-' }}</small></td>
            <td>
              <small>
                {{ a.acked_at ? fmt(a.acked_at) : '-' }}
                <span v-if="a.acked_by" class="muted"> by {{ a.acked_by }}</span>
              </small>
            </td>
            <td><small>{{ renderDetail(a) }}</small></td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted">无历史告警</p>
    </div>

    <!-- 阈值配置 -->
    <div v-if="subTab === 'config'" class="card">
      <div v-if="!cfg" class="muted">加载配置中...</div>
      <template v-else>
        <div class="form-row">
          <label>心跳离线阈值 (分钟)</label>
          <input type="number" min="1" max="1440" v-model.number="cfg.system_alert_heartbeat_offline_minutes" />
          <span class="muted">默认 15. agent last_seen_at 超过 N 分钟未更新视为离线</span>
        </div>
        <div class="form-row">
          <label>复制失败累计阈值</label>
          <input type="number" min="1" max="1000" v-model.number="cfg.system_alert_replication_failure_count" />
          <span class="muted">默认 30。同一 (源域控, 目标域控) 链路自上次成功以来累计达到该次数的失败, 才触发 1 条告警; 一旦出现成功即归零重新计数</span>
        </div>
        <div class="form-row">
          <label>端口延迟 p95 (ms)</label>
          <input type="number" min="1" max="60000" v-model.number="cfg.system_alert_port_latency_ms" />
          <span class="muted">默认 100。端口延迟过高告警 (检测规则暂未启用, 该项保留供后续使用)</span>
        </div>
        <div class="form-row">
          <label>磁盘剩余空间 (KB)</label>
          <input type="number" min="0" max="1099511627776" v-model.number="cfg.system_alert_disk_free_kb" />
          <span class="muted">默认 1048576 (= 1GB). pkg_ad_os_baseline.metrics.disk_free_kb 最小值</span>
        </div>
        <div class="form-row">
          <label>失败登录 24h (次)</label>
          <input type="number" min="1" max="100000" v-model.number="cfg.system_alert_failed_logon_24h" />
          <span class="muted">默认 500. ad_failed_logon_events 24h 累计 (跨主机)</span>
        </div>
        <div class="form-row">
          <label>评估周期 (秒)</label>
          <input type="number" min="10" max="3600" v-model.number="cfg.system_alert_eval_interval_seconds" />
          <span class="muted">默认 60. centre 跑 5 detector 的频率</span>
        </div>
        <div class="form-row">
          <label>收件人 (逗号分隔)</label>
          <input type="text" v-model="cfg.system_alert_to" placeholder="ops@company.com,sec@company.com" />
          <span class="muted">内置告警邮件默认收件人. 空 = 不发邮件</span>
        </div>
        <div class="actions">
          <button @click="loadConfig">还原</button>
          <button class="primary" :disabled="saving" @click="onSaveConfig">
            {{ saving ? '保存中...' : '保存' }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { adminApi } from '../../api/admin.js';
import { fmtTsCstMs } from '../../lib/time.js';
import { notifySuccess, notifyError } from '../../lib/notify.js';

const subTab = ref('firing');
const loading = ref(false);
const acking = ref(null);
const saving = ref(false);

// KPI
const kpi = ref({ firing: null, last24h: null, recovered24h: null, acked24h: null });

// 当前 firing
const rows = ref([]);

// 历史
const recentKind = ref('');
const recentRows = ref([]);

// 配置
const cfg = ref(null);

const KIND_LABEL = {
  heartbeat_offline: '心跳离线',
  replication_failed: '复制失败',
  port_latency_high: '端口延迟',
  disk_low: '磁盘低',
  failed_logon_spike: '失败登录 spike'
};
const KIND_BADGE_CLASS = {
  heartbeat_offline: 'on',   // 红 (在线/在跑)
  replication_failed: 'on',
  port_latency_high: 'on',
  disk_low: 'on',
  failed_logon_spike: 'on'
};
const STATE_LABEL = {
  firing: 'firing',
  recovered: 'recovered',
  acked: 'acked'
};

function kindLabel(k) { return KIND_LABEL[k] || k || '-'; }
function kindBadge(k) { return KIND_BADGE_CLASS[k] || 'on'; }
function stateLabel(s) { return STATE_LABEL[s] || s || '-'; }
function stateBadge(s) {
  if (s === 'firing') return 'on';
  if (s === 'acked') return 'off';
  return 'warn';
}
function fmt(s) { return s ? fmtTsCstMs(s) : '-'; }

function parseJson(s) {
  if (s == null || s === '') return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
}

function renderDetail(a) {
  const d = parseJson(a.detail);
  if (!d) return '-';
  // 按 kind 选字段
  const kind = a.kind;
  if (kind === 'heartbeat_offline') {
    return `离线 ${d.offline_min ?? '?'} 分钟 (阈值 ${d.threshold ?? '?'})`;
  }
  if (kind === 'replication_failed') {
    // R158.X.99.14 (2026-10-18) — 后端 detail wire 字段是 dest_dc + failure_status + last_error
    // (system-alert-engine.js:126-131), 不再是 partner_dc + failure_count. 前端必同步改消费层
    // (lesson 13 R158.100.8.c 锁). failure_status 是 status_code (例 1722/1398), 1:1 平行
    // ad_replication_status.status_code 列.
    // R158.X.99.17 (2026-10-18) — 新增 accumulated_count / checkpoint_id / since_last_success,
    //   跟 system-alert-engine.js detectReplicationFailed 1:1 平行. 操作员 directive 锁 B
    //   "超过了30次" 的 UI 提示依据. checkpoint_id === null 表示链路从来没成功过.
    const dest = d.dest_dc || d.partner_dc || '?';
    const code = d.failure_status ?? d.status_code ?? '?';
    const err = d.last_error ? ` / ${String(d.last_error).slice(0, 60)}` : '';
    const accum = Number.isFinite(d.accumulated_count) ? d.accumulated_count : '?';
    const cp = d.checkpoint_id != null
      ? `(自 #${d.checkpoint_id} 起累计)`
      : '(全表累计, 无成功 checkpoint)';
    return `目标 DC: ${dest} · status_code=${code} · 累计 ${accum} 次 ${cp}${err}`;
  }
  if (kind === 'port_latency_high') {
    // ⚠ 该告警类型的检测器已在 R158.86 从 system-alert-engine 移除
    //   (agent 不再上报 p95), 此分支永不触发。保留以兼容历史告警行, 但不要
    //   误以为该类型还活着 —— 见 agent 扫描报告第 8 节。
    return `p95 ${d.p95_ms ?? '?'} ms (host=${d.hostname || '?'}, port=${d.port ?? '?'})`;
  }
  if (kind === 'disk_low') {
    // R158.X.116.p.3 — 字段名对齐后端 system-alert-engine.js:504 的 detail
    //   { c_used_pct, threshold_percent, agent_id, ts }。此前这里读的是
    //   drive / disk_free_kb / threshold —— **后端一个都不返回**, 于是这行
    //   永远渲染成字面量 "?: ? KB (阈值 ?)", 0 报错 0 日志。
    //   同项目的 InAppDrawer.vue:123 早已是正确写法, 唯独这里漏改。
    //   ⚠ 后端 R158 某次把 disk_free_kb 换成 c_used_pct 阈值语义时, 只改了
    //   一侧 —— 「改了后端没改前端」的镜像版本。
    return `${d.agent_id || '?'}: 磁盘已用 ${d.c_used_pct ?? '?'}% (阈值 ${d.threshold_percent ?? '?'}%)`;
  }
  if (kind === 'failed_logon_spike') {
    return `24h 累计 ${d.count_24h ?? '?'} 次`;
  }
  return JSON.stringify(d).slice(0, 120);
}

function renderThreshold(a) {
  const t = parseJson(a.threshold);
  if (!t) return '-';
  return JSON.stringify(t);
}

async function loadKpi() {
  try {
    const r = await adminApi.getSystemAlertKpi();
    // R158.X.116.m (2026-10-23) — 显式映射, 0 再用整个响应当 kpi。
    //   旧写法 `kpi.value = r.data || {}` 把后端 snake_case 原样塞进来, 而
    //   模板读的是 firing / last24h / recovered24h / acked24h —— 4 个 label
    //   全对不上, 于是永远显 '-'。端点一直有数据, 是前端在盲取。
    //   显式映射把 shape 差异收在这一处: 后端改字段名 → 这里显式报错/兜底,
    //   0 再静默退化成 '-'(lesson 13: endpoint shape 改必 sync 前端)。
    const d = r.data || {};
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    kpi.value = {
      firing: num(d.firing_count),
      last24h: num(d.last_24h_count),
      recovered24h: num(d.recovered_24h_count),
      acked24h: num(d.acked_count)
    };
    // shape 漂移的显式信号: 后端一旦改字段名, console 一眼可见, 0 再靠肉眼盯 '-'
    if (d.firing_count === undefined) {
      console.warn('[system-alerts] kpi shape drift: expected firing_count, got', Object.keys(d));
    }
  } catch (e) {
    console.error('[system-alerts] kpi failed:', e?.message || e);
  }
}

async function loadCurrent() {
  loading.value = true;
  try {
    const r = await adminApi.listSystemAlerts({ state: 'firing', limit: 200 });
    rows.value = r.data?.items || r.data?.firing || [];
  } catch (e) {
    notifyError(`加载当前告警失败: ${e.response?.data?.error || e.message || e}`);
    rows.value = [];
  } finally {
    loading.value = false;
  }
}

async function loadRecent() {
  loading.value = true;
  try {
    const r = await adminApi.listRecentSystemAlerts({
      kind: recentKind.value || '',
      limit: 200
    });
    recentRows.value = r.data?.items || [];
  } catch (e) {
    notifyError(`加载历史告警失败: ${e.response?.data?.error || e.message || e}`);
    recentRows.value = [];
  } finally {
    loading.value = false;
  }
}

async function loadConfig() {
  try {
    const r = await adminApi.getSystemAlertConfig();
    // 后端返回 { config: { ... } } 或直接对象
    const body = r.data?.config || r.data || {};
    cfg.value = {
      system_alert_heartbeat_offline_minutes: Number(body.system_alert_heartbeat_offline_minutes ?? 15),
      // R158.X.99.17 (2026-10-18) — fallback 3 → 30. 操作员 directive 锁 B 模式 "超过了30次"
      //   与 system_alert_replication_failure_count 默认对齐. 后端 detector fallback 仍 3
      //   (system-alert-engine.js:109), 这是 UI 层兜底, 防止 fresh install 视图显 3 与实际
      //   detector 行为不一致.
      system_alert_replication_failure_count: Number(body.system_alert_replication_failure_count ?? 30),
      system_alert_port_latency_ms: Number(body.system_alert_port_latency_ms ?? 100),
      system_alert_disk_free_kb: Number(body.system_alert_disk_free_kb ?? 1048576),
      system_alert_failed_logon_24h: Number(body.system_alert_failed_logon_24h ?? 500),
      system_alert_eval_interval_seconds: Number(body.system_alert_eval_interval_seconds ?? 60),
      system_alert_to: String(body.system_alert_to || '')
    };
  } catch (e) {
    notifyError(`加载配置失败: ${e.response?.data?.error || e.message || e}`);
    cfg.value = null;
  }
}

async function onSaveConfig() {
  if (!cfg.value) return;
  saving.value = true;
  try {
    await adminApi.updateSystemAlertConfig(cfg.value);
    notifySuccess('阈值配置已保存, 下一轮 detector eval 生效');
  } catch (e) {
    notifyError(`保存失败: ${e.response?.data?.error || e.message || e}`);
  } finally {
    saving.value = false;
  }
}

async function onAck(a) {
  acking.value = a.id;
  try {
    await adminApi.ackSystemAlert(a.id);
    notifySuccess(`已 ack #${a.id}`);
    await Promise.all([loadCurrent(), loadKpi()]);
  } catch (e) {
    notifyError(`ack 失败: ${e.response?.data?.error || e.message || e}`);
  } finally {
    acking.value = null;
  }
}

async function reload() {
  if (subTab.value === 'firing') {
    await Promise.all([loadCurrent(), loadKpi()]);
  } else if (subTab.value === 'recent') {
    await loadRecent();
  } else if (subTab.value === 'config') {
    await loadConfig();
  }
}

// sub-tab 切换自动 reload
function onSubTabChange() {
  reload();
}

// 30s 自动刷新 firing + KPI
let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (subTab.value === 'firing') {
      await Promise.all([loadCurrent(), loadKpi()]);
    } else if (subTab.value === 'recent') {
      await loadRecent();
    }
  }, 30000);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

onMounted(async () => {
  await Promise.all([loadCurrent(), loadKpi(), loadConfig()]);
  startPolling();
});
onUnmounted(stopPolling);

// 监听 subTab 变化 — 切到 config/recent 时主动 reload
watch(subTab, () => reload());
</script>

<style scoped>
.system-alerts-view { width: 100%; }
.kpi-bar { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
.kpi { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 12px 14px; }
.kpi-k { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.kpi-v { font-size: 22px; font-weight: 600; }
.kpi-v.on { color: var(--danger, #e44); }
.sub-tabs { display: flex; gap: 6px; align-items: center; margin-bottom: 12px; }
.sub-tabs button { padding: 6px 12px; border: 1px solid var(--border); background: var(--panel); border-radius: 4px; cursor: pointer; color: var(--text); }
.sub-tabs button.on { background: var(--accent); color: #fff; border-color: var(--accent); }
.sub-tabs .refresh-btn { margin-left: auto; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 16px; }
.card .t { width: 100%; border-collapse: collapse; font-size: 13px; }
.card .t th, .card .t td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
.card .t th { font-weight: 600; color: var(--muted); background: rgba(255,255,255,0.02); }
.pill { display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 11px; font-weight: 600; }
.pill.on { background: rgba(228,68,68,0.15); color: var(--danger, #e44); }
.pill.off { background: rgba(120,120,120,0.18); color: var(--muted); }
.pill.warn { background: rgba(255,170,0,0.18); color: #da6; }
.muted { color: var(--muted); font-size: 13px; }
.filter-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
.filter-bar label { color: var(--muted); font-size: 13px; }
.filter-bar select { padding: 4px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--panel); color: var(--text); }
.filter-bar button { padding: 4px 12px; border: 1px solid var(--border); background: var(--panel); border-radius: 4px; cursor: pointer; color: var(--text); }
.form-row { display: grid; grid-template-columns: 200px 200px 1fr; gap: 8px 12px; align-items: center; margin-bottom: 12px; }
.form-row label { color: var(--muted); font-size: 13px; }
.form-row input { padding: 6px 10px; border: 1px solid var(--border); border-radius: 4px; background: var(--panel); color: var(--text); }
.form-row .muted { font-size: 11px; }
.actions { display: flex; gap: 8px; margin-top: 16px; }
.actions button { padding: 6px 16px; border: 1px solid var(--border); background: var(--panel); border-radius: 4px; cursor: pointer; color: var(--text); }
.actions button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
</style>
