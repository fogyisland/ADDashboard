<template>
  <!-- R129 — 2026-09-27 operator directive "将这个界面从后台管理界面
       移动到前台". Wrapper swapped from AdminLayout to AppLayout; the
       path moved to /replication-log/monitor (router.js R129) and the
       meta.perm gate dropped so any logged-in user can reach it. Same
       chrome as /eventlog and /os-baseline (R112/R128, R116/R128) —
       sidebar + topbar with admin entry / theme toggle / logout. The
       inner matrix (站点→DC→伙伴×端口 + staleness badge + legend)
       is unchanged. The .vue file's location is still under
       views/admin/ for now — moving it to views/ is a separate, larger
       rename that also touches the package-runs description and any
       ad-hoc imports; not in scope for this R129 chain. -->
  <AppLayout>
    <header>
      <h2>{{ props.direction === 'outbound' ? '复制伙伴端口健康监控 — 出战' : '复制伙伴端口健康监控 — 入站' }}</h2>
      <div class="controls">
        <span class="refresh-indicator">
          <span :class="['dot', polling ? 'on' : 'off']"></span>
          <span>每 {{ refreshSeconds }}s 刷新</span>
        </span>
        <span class="last-loaded" v-if="lastLoadedAt">最近刷新: {{ fmt(lastLoadedAt) }}</span>
        <!-- 2026-08-28 round-34.2: data staleness header — surface how
             stale the most recent partner-port probe actually is. Driven
             from the max lastAttemptTime across all partners; coloured
             green ≤5min / yellow 5-30min / red >30min so the operator
             can tell at a glance whether the dashboard reflects reality. -->
        <span v-if="stalenessMinutes !== null" :class="['staleness', stalenessClass]" data-test="staleness">
          数据 {{ stalenessMinutes }} 分钟前
        </span>
      </div>
    </header>

    <p class="hint">
      按 站点 → DC → 复制伙伴 列出端口健康状况。每端口显示延迟 (ms):绿色 ≤1000ms /
      黄色 &gt;1000ms / 红色 ✕ (不可达或超时) / 灰色 — (无探测数据)。
    </p>
    <p class="hint direction-hint">
      方向: <strong>{{ props.direction === 'outbound' ? '出战 (outbound)' : '入站 (inbound)' }}</strong>
      — {{ props.direction === 'inbound'
        ? 'operator 入站视角:列出当前 DC 的 agent 主动 probe 的上游源伙伴 (我从这些源拉复制)。当前 DC 的 agent 离线时该 DC 无伙伴行; 伙伴 DC 的 agent 离线不影响本 DC 的显示。'
        : 'operator 出战视角:列出探测当前 DC 的伙伴 agent (源从我拉复制)。若伙伴 DC 的 agent 离线, 该伙伴行不显示; 当前 DC 的 agent 离线不影响显示。' }}
    </p>
    <p class="legend">
      <span class="legend-item"><span class="legend-swatch swatch-ok"></span>≤1000ms 可达</span>
      <span class="legend-item"><span class="legend-swatch swatch-slow"></span>&gt;1000ms 慢</span>
      <span class="legend-item"><span class="legend-swatch swatch-down"></span>✕ 不可达/超时</span>
    </p>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="!sites.length && !error" class="empty">暂无站点 — 请在 AD 站点/DC 清单添加</div>

    <section v-for="site in sites" :key="site.siteId" class="site-block" :data-test-site="site.siteName">
      <h3>
        <span :class="['hub-badge', site.isHub ? 'yes' : 'no']">{{ site.isHub ? '中心' : '分支' }}</span>
        {{ site.siteName }}
        <small class="region">{{ site.regionCode || '—' }}</small>
        <small class="dc-count">{{ site.dcs.length }} DC</small>
      </h3>

      <div v-if="!site.dcs.length" class="empty">该站点暂无 DC</div>

      <div v-for="dc in site.dcs" :key="dc.dcName" class="dc-block" :data-test-dc-block="dc.dcName">
        <h4>
          <span class="dc-name">{{ dc.dcName }}</span>
          <span class="dc-roles-inline">
            <span v-if="dc.isBridgehead" class="role-badge bridgehead">桥头</span>
            <span v-if="dc.isPdc" class="role-badge fsmo">PDC</span>
            <span v-if="dc.isGc" class="role-badge fsmo">GC</span>
            <span v-if="dc.isRidMaster" class="role-badge fsmo">RID</span>
            <span v-if="dc.isSchemaMaster" class="role-badge fsmo">Schema</span>
            <span v-if="dc.isDomainNamingMaster" class="role-badge fsmo">DNaming</span>
            <span v-if="dc.isInfrastructureMaster" class="role-badge fsmo">Infra</span>
            <span v-if="!dc.isBridgehead && !dc.isPdc && !dc.isGc && !dc.isRidMaster && !dc.isSchemaMaster && !dc.isDomainNamingMaster && !dc.isInfrastructureMaster" class="role-badge none">成员</span>
          </span>
          <small class="dc-os-inline">{{ dc.osVersion || '—' }}</small>
          <small class="dc-partner-count">{{ dc.partners.length }} 伙伴</small>
        </h4>

        <table v-if="dc.partners.length && portsForDc(dc)" class="port-matrix">
          <thead>
            <tr>
              <th>伙伴站点</th>
              <th>伙伴 DC</th>
              <!-- R158.17.4 (2026-10-01) — "上报 agent" th. R158.17.4
                   之前只在 <tbody> 加了 agent-col td 但忘了 <thead>
                   加对应 th, 标题行只有 3 列 (站点/DC/时间) + N 端口列,
                   body 行有 4 列, operator 看到 "标题少一列" 错位. 现
                   在补上让两者对齐. -->
              <th class="agent-col">上报 agent</th>
              <!-- R158.17.4.5 (2026-10-02) — "上报时间" th. Operator
                   directive: "在机器名同一行写上上报时间". Source is
                   `portHealth[0].probeAt` — the agent UPSERT time of
                   the __partner_ports__:% row. Renders absolute CST
                   timestamp (yyyy-MM-dd HH:mm:ss) so the operator can
                   trace WHICH clock-tick a stale row came from. Sits
                   next to (not replacing) the "执行时间" relative-time
                   column (R154.6) — relative for at-a-glance scanning,
                   absolute for forensic detail. -->
              <th class="probe-at-iso-tx">上报时间</th>
              <!-- R154.6 — "执行时间" column. Shows how long ago the
                   partner-port probe ran on this peer DC's agent. Source
                   is `portHealth[0].probeAt` (agent UPSERT time of the
                   `__partner_ports__:%` row, NOT AD replication's
                   lastAttemptTime which can lag by hours). Colour bands
                   mirror the page-level staleness badge so the operator
                   reads both consistently: green ≤5min, yellow 5-30min,
                   red >30min, gray when no probe row exists. -->
              <th class="probe-at-col">执行时间</th>
              <th v-for="p in portsForDc(dc)" :key="`h-${dc.dcName}-${p.port}`" class="port-col">
                <span class="port-num">{{ p.port }}</span>
                <small v-if="p.label" class="port-label">{{ p.label }}</small>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="partner in dc.partners" :key="`${dc.dcName}-${partner.peerDc}`"
                :data-test="`partner-${dc.dcName}-${partner.peerDc}`">
              <td class="peer-site-cell">
                <span class="peer-site">{{ partner.peerSite }}</span>
                <span v-if="partner.peerSiteIsHub" class="hub-mini">中心</span>
              </td>
              <td class="peer-dc">{{ partner.peerDc }}</td>
              <!-- R158.17.4 (2026-10-01) — "上报 agent" 列. 写这条端口数据
                   行的 agent 机器名 (例 KDLFLOFADSRV2). 空 partner cell 灰字
                   "—" 让 operator 一眼看出哪台 agent 没跑探针包. -->
              <td class="agent-col" :data-test="`probe-agent-${dc.dcName}-${partner.peerDc}`">
                {{ probeAgentText(partner) }}
              </td>
              <!-- R158.17.4.5 (2026-10-02) — "上报时间" cell. Absolute CST
                   timestamp of `portHealth[0].probeAt` so the operator can
                   see WHICH clock-tick the row came from. Renders "—" in
                   muted gray when the partner has no probe row in the 30-min
                   SQL window (no data to render). Hover shows full locale
                   string; layout uses tabular-nums so timestamps align. -->
              <td class="probe-at-iso-tx" :data-test="`probe-at-iso-${dc.dcName}-${partner.peerDc}`"
                  :title="probeAtIsoTitle(partner)">
                {{ probeAtIsoText(partner) }}
              </td>
              <!-- R154.6 — execution-time cell. Mirrors staleness badge
                   colours: fresh/warn/stale classes derived from
                   probeAtTs() (same thresholds as the page-level badge).
                   null probeAt (no probe row in 30-min window) → gray
                   "—" so the operator can spot peers whose agent isn't
                   running partner-port probe at all. -->
              <td :class="['col-probe-at', probeAtClass(partner)]"
                  :data-test="`probe-at-${dc.dcName}-${partner.peerDc}`"
                  :title="probeAtTitle(partner)">
                {{ probeAtText(partner) }}
              </td>
              <td v-for="p in portsForDc(dc)" :key="`c-${dc.dcName}-${partner.peerDc}-${p.port}`"
                  :class="cellClass(lookupProbe(partner, p.port))"
                  :data-test="`port-${dc.dcName}-${partner.peerDc}-${p.port}`">
                {{ cellText(lookupProbe(partner, p.port)) }}
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else-if="dc.partners.length" class="empty-row">无端口数据 — 请在 端口健康检查 配置</div>
        <div v-else class="empty-row">无伙伴连接</div>
      </div>
    </section>
  </AppLayout>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
// R129 — swapped AdminLayout → AppLayout (operator directive
// "将这个界面从后台管理界面移动到前台", 2026-09-27). Backend route at
// /api/dashboard/partner-port-health/all is unchanged; only the chrome
// wrapper and the route perm gate (router.js) move.
import AppLayout from '../../components/AppLayout.vue';
import { dashboardApi } from '../../api/dashboard.js';

// 2026-08-28 round-47: 复制伙伴端口健康监控. Operator directive:
// "在这边不叫复制日志监控了，改成复制伙伴端口健康监控名称" + "主要列出每个
// 站点，每台服务器对应的端口健康状况，返回的值为ms 值,超过了1000ms标
// 记为黄色,不通或者超时标记为红色". This view replaces the standalone
// ReplicationLogMonitorView (R45 restoration of R42). The replication-
// attempts caret history (R42/R46) is intentionally dropped — this view
// is port-health only. The reuse of attempt rows is now exclusive to
// 复制状态概览 (SiteReplicationMatrixAllView) via its inline caret.
//
// Color thresholds (verbatim):
//   green  ≤ SLOW_THRESHOLD_MS  — reachable
//   yellow > SLOW_THRESHOLD_MS  — slow
//   red    ✕                    — unreachable or timeout
//   gray   —                    — no probe data
const SLOW_THRESHOLD_MS = 1000;

const sites = ref([]);
const refreshSeconds = ref(10);
const lastLoadedAt = ref(null);
const error = ref('');
const polling = ref(false);
let timerHandle = null;

async function load() {
  polling.value = true;
  error.value = '';
  try {
    // R158.17.3 (2026-10-01) -- /monitor-inbound endpoint 已与
    // /admin/site-replication-matrix/all 数据语义同步: 都读
    // v_partner_inbound (伙伴清单) + ad_replication_status
    // __partner_ports__ 行 (端口健康度). endpoint 内部不再走 R155.3
    // label swap, props.direction='inbound' 直接传, 前端不再做
    // endpointDirection 反向映射.
    const r = await dashboardApi.getPartnerPortHealthInbound();
    sites.value = Array.isArray(r.data?.sites) ? r.data.sites : [];
    refreshSeconds.value = Number(r.data?.refreshSeconds) || 10;
    lastLoadedAt.value = new Date().toISOString();
    recomputeStaleness();
  } catch (e) {
    error.value = e?.response?.data?.error || '加载失败';
  } finally {
    polling.value = false;
  }
}

// R155.3 — label 纠正. props.direction 现在是 "operator 视角标签
// 标识符",不再是后端 direction:
//   'inbound' = UI label "入站" (= 后端 direction 'outbound',anchor
//              source_dc = 我 probe 出去的 source = 我从这些源拉)。
//   'outbound' = UI label "出战" (= 后端 direction 'inbound',anchor
//              dest_dc = peer probe 我 = 源从我拉)。
// 默认 'inbound' 因为 operator 主用 /monitor (入站 tab = FLO2
// probe 出去的 8 source = 我从这些源拉)。
//
// R156.5 — apiMethod prop 删除 (operator directive "复制伙伴端口主动探测
// 不需要哦去掉"). Base view 现在只有 direction 一个 prop, 一律调
// getPartnerPortHealthAll({direction})。
const props = defineProps({
  direction: { type: String, default: 'inbound', validator: (v) => v === 'inbound' || v === 'outbound' }
});

// Per-DC column ports: union of every partner's configuredPorts. Sorted
// ascending numerically. We compute once per dc and memoise per-render
// by deriving inside the template's v-for (cheap, no caching needed).
function portsForDc(dc) {
  const set = new Map(); // port -> label
  for (const partner of (dc.partners || [])) {
    const cfg = Array.isArray(partner.configuredPorts) ? partner.configuredPorts : [];
    for (const p of cfg) {
      if (!set.has(p.port)) set.set(p.port, p.label || '');
    }
  }
  return [...set.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([port, label]) => ({ port, label }));
}

// Per-partner probe lookup. portHealth[] is an array of "latest attempt"
// snapshots; we use index 0 (the route emits at most one latest per
// pair). ports[] inside is {port, ok, latency} — match by port number.
function lookupProbe(partner, portNum) {
  const arr = Array.isArray(partner?.portHealth) ? partner.portHealth : [];
  if (arr.length === 0) return null;
  const ports = Array.isArray(arr[0]?.ports) ? arr[0].ports : [];
  return ports.find(p => Number(p.port) === Number(portNum)) ?? null;
}

function cellClass(probe) {
  if (!probe) return 'cell-no-data';
  if (!probe.ok) return 'cell-down';
  if (probe.latency != null && probe.latency > SLOW_THRESHOLD_MS) return 'cell-slow';
  return 'cell-ok';
}

function cellText(probe) {
  if (!probe) return '—';
  if (!probe.ok) return '✕';
  return `${probe.latency ?? '—'}ms`;
}

// R154.6 — per-row "执行时间" helpers. probeAt comes from
// portHealth[0].probeAt (the agent UPSERT time of the partner-port
// probe row, 5-min heartbeat cadence). Returns null when the partner
// has no probe row in the 30-min SQL window — distinguish that from a
// fresh probe so the operator can spot peers whose agent isn't
// emitting probe data at all.
function probeAtTs(partner) {
  const at = partner?.portHealth?.[0]?.probeAt;
  if (!at) return null;
  const t = new Date(at).getTime();
  return Number.isFinite(t) ? t : null;
}

function probeAtAgeMin(partner) {
  const t = probeAtTs(partner);
  if (t === null) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 60000));
}

function probeAtText(partner) {
  const age = probeAtAgeMin(partner);
  if (age === null) return '—';
  if (age < 1) return '刚刚';
  if (age < 60) return `${age} 分钟前`;
  return `${Math.floor(age / 60)} 小时前`;
}

function probeAtClass(partner) {
  const age = probeAtAgeMin(partner);
  if (age === null) return 'probe-at-none';
  if (age <= 5) return 'probe-at-fresh';
  if (age <= 30) return 'probe-at-warn';
  return 'probe-at-stale';
}

function probeAtTitle(partner) {
  const at = partner?.portHealth?.[0]?.probeAt;
  return at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '无最近 30 分钟内探测数据';
}

// R158.17.4 (2026-10-01) — "上报 agent" 单元格文本.
// portHealth[0].agentId 是写这条端口数据的 agent 机器名 (例
// KDLFLOFADSRV2),由后端 handler 把 ad_replication_status.agent_id
// 列 (R154.5 已加, agent 客户端无需重打包) 装进 portHealth[].
// 没端口数据时整 cell 显示 "—" 灰字让 operator 一眼看出哪台 agent
// 没跑探针包.
function probeAgentText(partner) {
  const ph = Array.isArray(partner?.portHealth) ? partner.portHealth[0] : null;
  return ph?.agentId ? ph.agentId : '—';
}

// R158.17.4.5 (2026-10-02) — "上报时间" 单元格 (绝对时刻).
// Operator directive: "在机器名同一行写上上报时间". Uses the same
// `portHealth[0].probeAt` source as the relative-time "执行时间" column
// (R154.6) but renders it as an absolute CST timestamp so the operator
// can pinpoint WHICH clock-tick a probe ran at — not just "X 分钟前".
// Tabular-nums in CSS keeps columns aligned across rows.
//
// Render:
//   - probeAt present  → yyyy-MM-dd HH:mm:ss in browser TZ
//   - probeAt missing   → "—" (same as the relative column's empty state)
function probeAtIsoText(partner) {
  const at = partner?.portHealth?.[0]?.probeAt;
  if (!at) return '—';
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return '—';
  // toLocaleString gives "2026/10/02 09:30:15" — operator asked for a
  // machine-row timestamp; "/" separator makes the column narrower than
  // dash separator so we use ISO-style yyyy-MM-dd HH:mm:ss for column
  // alignment. Custom formatter keeps the field 19 chars wide across
  // every row.
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function probeAtIsoTitle(partner) {
  const at = partner?.portHealth?.[0]?.probeAt;
  return at ? `probe 写入时刻: ${new Date(at).toLocaleString('zh-CN', { hour12: false })}` : '无最近 30 分钟内探测数据';
}

function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }

// 2026-08-28 round-34.2: data staleness — derive max lastAttemptTime across
// all partners × all sites × all DCs × all portHealth entries. Returns the
// wall-clock minutes between the most recent probe and now. Returns null
// when no probe timestamps exist (operator can't be misled by a 0-minute
// false-positive; the staleness badge simply doesn't render).
function maxLastAttemptTs(siteList) {
  let max = null;
  for (const site of siteList || []) {
    for (const dc of site.dcs || []) {
      for (const partner of dc.partners || []) {
        for (const ph of partner.portHealth || []) {
          if (ph.lastAttemptTime) {
            const t = new Date(ph.lastAttemptTime).getTime();
            if (Number.isFinite(t) && (max === null || t > max)) max = t;
          }
        }
      }
    }
  }
  return max;
}

const stalenessMinutes = ref(null);
const stalenessClass = ref(''); // 'fresh' | 'warn' | 'stale'

function recomputeStaleness() {
  const ts = maxLastAttemptTs(sites.value);
  if (ts === null) {
    stalenessMinutes.value = null;
    stalenessClass.value = '';
    return;
  }
  const minutes = Math.max(0, Math.floor((Date.now() - ts) / 60000));
  stalenessMinutes.value = minutes;
  if (minutes <= 5) stalenessClass.value = 'fresh';
  else if (minutes <= 30) stalenessClass.value = 'warn';
  else stalenessClass.value = 'stale';
}

onMounted(async () => {
  await load();
  timerHandle = setInterval(load, refreshSeconds.value * 1000);
});
onUnmounted(() => { if (timerHandle) clearInterval(timerHandle); });
</script>

<style scoped>
.controls { display: flex; gap: 16px; align-items: center; margin-bottom: 16px; }
.refresh-indicator { color: var(--muted); font-size: 12px; display: flex; gap: 6px; align-items: center; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.dot.on  { background: var(--green); }
.dot.off { background: var(--muted); }
/* 2026-08-28 round-34.2: data staleness badge — same colour vocabulary as
   the cell matrix so the operator reads them together. fresh ≤5min /
   warn 5-30min / stale >30min. */
.staleness {
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 3px;
  font-variant-numeric: tabular-nums;
}
.staleness.fresh { background: color-mix(in srgb, var(--green) 14%, transparent);  color: var(--green); }
.staleness.warn  { background: color-mix(in srgb, var(--yellow) 14%, transparent);  color: var(--yellow); }
.staleness.stale { background: color-mix(in srgb, var(--red) 14%, transparent);  color: var(--red); }
.hint { color: var(--muted); font-size: 12px; margin: 0 0 16px; }
.error-banner { background: var(--red-bg); color: var(--red); padding: 8px 12px; border-radius: 3px; margin-bottom: 12px; }
.empty { text-align: center; color: var(--muted); padding: 24px; }
.legend { display: flex; gap: 12px; margin: 0 0 16px; font-size: 12px; color: var(--muted); }
.legend-item { display: inline-flex; gap: 6px; align-items: center; }
.legend-swatch { display: inline-block; width: 12px; height: 12px; border-radius: 3px; border: 1px solid var(--border); }
.swatch-ok   { background: var(--success-bg); border-color: var(--fsmo-border); }
.swatch-slow { background: var(--warning-bg); border-color: var(--status-pill-fg-warn); }
.swatch-down { background: var(--danger-bg); border-color: var(--status-pill-fg-err); }

.site-block { margin-bottom: 24px; padding: 16px; border: 1px solid var(--border); border-radius: 4px; background: var(--panel); }
.site-block h3 { display: flex; align-items: baseline; gap: 8px; margin: 0 0 12px; }
.hub-badge { padding: 2px 8px; border-radius: 999px; font-size: 11px; margin-right: 4px; }
.hub-badge.yes { background: var(--success-bg); color: var(--fsmo-text); }
.hub-badge.no  { background: var(--border); color: var(--muted); }
.region { color: var(--muted); font-size: 12px; }
.dc-count { color: var(--muted); font-size: 12px; margin-left: auto; }
.hub-mini { font-size: 10px; padding: 1px 6px; margin-left: 6px; border-radius: 999px; background: var(--success-bg); color: var(--fsmo-text); }

.dc-block { margin-bottom: 18px; padding: 10px 12px;
            border: 1px solid var(--border); border-radius: 4px; background: var(--panel); }
.dc-block:last-child { margin-bottom: 0; }
.dc-block h4 { display: flex; align-items: baseline; gap: 6px; margin: 0 0 8px;
              font-size: 13px; color: var(--text); font-weight: 600; }
.dc-name { font-family: ui-monospace, monospace; font-weight: 600; font-size: 14px; color: var(--text); }
.dc-roles-inline { display: inline-flex; flex-wrap: wrap; gap: 3px; }
.role-badge { font-size: 10px; padding: 1px 6px; border-radius: 999px;
              font-family: ui-monospace, monospace; letter-spacing: 0.04em; }
.role-badge.fsmo { background: var(--success-bg); color: var(--fsmo-text); border: 1px solid var(--fsmo-border); }
.role-badge.bridgehead { background: var(--bridgehead-bg); color: var(--severity-info-text); font-weight: 600; }
.role-badge.none { background: var(--border); color: var(--muted); }
.dc-os-inline { color: var(--muted); font-size: 11px; font-family: ui-monospace, monospace; }
.dc-partner-count { color: var(--muted); font-size: 11px; margin-left: auto; }

/* 2026-08-28 round-47: port-matrix table — one column per configured port.
   Cells are colour-coded by latency thresholds (≤1000ms green, >1000ms
   yellow, ✕ red, — gray). */
.port-matrix { border-collapse: collapse; background: var(--panel); width: 100%; table-layout: fixed; }
.port-matrix th, .port-matrix td {
  border: 1px solid var(--border); padding: 6px 10px; text-align: center; font-size: 13px;
}
.port-matrix th { background: var(--sidebar-bg); color: var(--muted); font-size: 12px; font-weight: 600; }
.port-matrix tbody tr:nth-child(even) { background: color-mix(in srgb, var(--text) 2%, transparent); }
/* R158.17.4.2 (2026-10-01) — 端口列宽从 56→80px. 端口延迟数字
   (例 "1823ms" / "45ms") 56px 容易折断或贴边, 80px 给数字足够的
   空间. 同时端口是矩阵的核心数据, 应该比对象名称列更宽. */
.port-col { min-width: 80px; width: 80px; }
.port-num { font-family: ui-monospace, monospace; font-weight: 600; font-size: 12px; color: var(--text); }
.port-label { display: block; color: var(--muted); font-size: 10px; margin-top: 2px; }
.direction-hint { color: var(--muted); font-size: 12px; margin: -8px 0 16px; }
.direction-hint strong { color: var(--text); }

/* R158.17.4.2 — 前 4 个对象名称列 (伙伴站点/伙伴 DC/上报 agent/执行时间)
   左对齐, 因为这些是文本/机器名不是数字. 默认 td 是 center (矩阵
   单元格), 这里 override 让对象名易读. */
.peer-site-cell,
.peer-dc,
.agent-col,
.col-probe-at {
  text-align: left;
}
.peer-site { font-weight: 500; }
.peer-dc { font-family: ui-monospace, monospace; font-size: 12px; }
/* R158.17.4 (2026-10-01) — "上报 agent" 列. 跟 peer-dc 同字体
   (ui-monospace, 12px) 让表格统一长. 空 cell 由 probeAgentText
   helper 输出 "—" 灰字 (var(--muted)). */
.agent-col {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  white-space: nowrap;
}
.empty-row { color: var(--muted); padding: 16px; }

/* R154.6 — "执行时间" column. Mirrors the page-level staleness badge
   colour vocabulary so the operator reads the two together. fresh ≤5min,
   warn 5-30min, stale >30min. none (gray) when there's no probe row at
   all in the 30-min SQL window — usually means the peer agent is
   either dead or running pre-R155 script without partner-port emit. */
.probe-at-col { min-width: 88px; white-space: nowrap; }
.col-probe-at {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
/* R158.17.4.5 (2026-10-02) — "上报时间" column. Absolute CST timestamp
   yyyy-MM-dd HH:mm:ss (19 chars fixed width). Tabular-nums keeps digits
   aligned across rows; muted gray when empty (probeAt missing). */
.probe-at-iso-tx {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: var(--muted);
  min-width: 158px;
}
.probe-at-iso-tx:not(:empty):not([title=""]) {
  color: var(--text);
}
td.probe-at-iso-tx:has([title^="probe 写入时刻"]) {
  color: var(--text);
}
.probe-at-fresh { color: var(--green);  font-weight: 600; }
.probe-at-warn  { color: var(--yellow); font-weight: 600; }
.probe-at-stale { color: var(--red);    font-weight: 600; }
.probe-at-none  { color: var(--muted); }

/* R47 colour rules — verbatim operator thresholds. */
.cell-ok        { background: var(--success-bg); color: var(--fsmo-text); font-weight: 600; }
.cell-slow      { background: var(--warning-bg); color: var(--gold-border); font-weight: 600; }
.cell-down      { background: var(--danger-bg); color: var(--severity-critical-text); font-weight: 600; }
.cell-no-data   { background: var(--border); color: var(--muted); }
</style>