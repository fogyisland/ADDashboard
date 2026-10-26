<!--
  R156 — partner-discover base view. Shared by:
    - /replication-log/discover-inbound (R156 前台入口, R158.5 已
      删除并搬到后台)
    - /admin/partner-discover/inbound (R158.5 后台新入口, view-mode=site)
    R158.10 (2026-10-01) — outbound 分支删除 (operator decision:
      不需要 outbound partner)。apiMethod 现在只有 'discoverInbound'。

  view-mode prop (R158.5):
    - 'flat'  — 单一 flat 表格,每行一对 (source_dc, dest_dc)
    - 'site'  — 按 site_name 分桶,每站点下按 self-DC 折叠入站/出战
                partner 列表 (operator directive "按站点方式呈现")

  chrome prop (R158.5):
    - 'admin' — AdminLayout (后台,默认 site-mode)
    - 'app'   — AppLayout (前台 flat-mode)

  对比 PartnerPortHealthView:
    - 数据源 = ad_partner_inbound / ad_partner_outbound (NEW 物理表)
      而非 ad_replication_status 或 ad_dc_probe_outbound (30 min
      短期 probe 数据)。
    - 窗口 = 30 天 (centre cron cadence),而非 30 min。
    - 字段 = source_dc / dest_dc / agent_id / site_id / site_name /
      discovered_at / collected_at,不含 status_code / latency 等。
    - R158.5 — site_name 由后端 SQL 新 LEFT JOIN ad_dcs/ad_sites
      注入(原 R156 SQL 没 JOIN,所以 R158.5 同步改了 SQL)。
-->
<template>
  <component :is="layoutComponent">
    <header>
      <h2>{{ props.direction === 'outbound' ? '复制伙伴发现 — 出战' : '复制伙伴发现 — 入站' }}</h2>
      <div class="controls">
        <span class="refresh-indicator">
          <span :class="['dot', polling ? 'on' : 'off']"></span>
          <!--
            2026-10-20 — 改为 "页面轮询" 措辞.
            原 `每 {{ refreshSeconds }}s 刷新` 读起来像是后端下发的节奏, 其实
            refreshSeconds 是本地 ref(60), 后端 /api/dashboard/discovery/inbound
            的 envelope 只有 { rows, refreshedAt } —— 根本没有 refreshSeconds
            字段. 那个 "60" 跟后端没有任何契约关系, 是误导性显示.
            现在只陈述事实: 这是前端自己的轮询间隔.
          -->
          <span>页面每 {{ refreshSeconds }}s 自动轮询</span>
        </span>
        <span class="last-loaded" v-if="lastLoadedAt">最近刷新: {{ fmt(lastLoadedAt) }}</span>
        <span v-if="maxAgeDays !== null" :class="['staleness', ageClass]" data-test="staleness">
          数据 {{ maxAgeDays }} 天前
        </span>
      </div>
    </header>

    <p class="hint">
      按 {{ props.viewMode === 'site' ? '站点 → DC → 复制伙伴' : '源/目的 DC 对' }}
      列出最近 30 天发现的 DC 拓扑关系。每个 (源 DC, 目的 DC)
      对一行;系统在定时任务触发时收集在线伙伴,经过 DC 成员校验后写入
      <code>{{ tableName }}</code>。
    </p>
    <p class="hint direction-hint">
      方向: <strong>{{ props.direction === 'outbound' ? '出战 (outbound)' : '入站 (inbound)' }}</strong>
      — {{ props.direction === 'inbound'
        ? 'agent 上报"我从哪些源 DC 拉复制",写入 ad_partner_inbound; source_dc = 上游 peer, dest_dc = self。'
        : 'agent 上报"哪些 DC 从我拉复制",写入 ad_partner_outbound; source_dc = self, dest_dc = 下游 peer。' }}
    </p>
    <p class="legend">
      <span class="legend-item"><span class="legend-swatch swatch-fresh"></span>≤ 7 天</span>
      <span class="legend-item"><span class="legend-swatch swatch-warn"></span>8-21 天</span>
      <span class="legend-item"><span class="legend-swatch swatch-stale"></span>> 21 天</span>
    </p>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="!rows.length && !error" class="empty">暂无 30 天内发现数据 — 等下一个 cron 触发 (默认月初 1 号 02:00)</div>

    <!-- R158.5 — site grouping mode (后台版本). -->
    <div v-if="props.viewMode === 'site' && siteGroups.length" class="site-groups" data-test="site-groups">
      <section
        v-for="group in siteGroups"
        :key="group.key"
        class="site-group"
        :data-test="`site-${group.key}`"
      >
        <header class="site-group-header">
          <div class="site-group-title">
            <span class="site-group-icon">📍</span>
            <span class="site-group-name">{{ group.label }}</span>
            <span class="site-group-count">{{ group.dcCount }} 个 DC · {{ group.partnerCount }} 个伙伴</span>
          </div>
        </header>
        <div class="dc-grid">
          <article
            v-for="dc in group.dcs"
            :key="dc.dcName"
            class="dc-card"
            :data-test="`dc-${dc.dcName}`"
          >
            <header class="dc-card-header">
              <h3 class="dc-card-name">{{ dc.dcName }}</h3>
              <span class="dc-card-meta">
                {{ props.direction === 'inbound' ? '入站伙伴' : '出战伙伴' }} {{ dc.partners.length }}
              </span>
            </header>
            <table v-if="dc.partners.length" class="dc-partners-table">
              <thead>
                <tr>
                  <th>{{ props.direction === 'inbound' ? '上游 peer' : '下游 peer' }}</th>
                  <th>上报 agent</th>
                  <th>最近更新</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="p in dc.partners"
                  :key="`${p.source_dc}|${p.dest_dc}|${p.collected_at}`"
                  :class="['partner-row', ageClassFor(p)]"
                  :data-test="`partner-${dc.dcName}-${p.peerDc}`"
                >
                  <td class="peer-cell">{{ p.peerDc }}</td>
                  <td class="agent-cell">{{ p.agent_id }}</td>
                  <td :class="['updated-cell', ageClassFor(p)]">
                    {{ fmtRelative(p.collected_at) }}
                    <small class="ts-ago">({{ fmtTs(p.collected_at) }})</small>
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-else class="dc-empty">该 DC 暂无伙伴记录</div>
          </article>
        </div>
      </section>
    </div>

    <!-- 原 flat 表格 — R156 shape. 后台 view-mode='site' 不显示此块。 -->
    <table v-if="props.viewMode === 'flat' && rows.length" class="discovery-table">
      <thead>
        <tr>
          <th>{{ props.direction === 'outbound' ? '源 DC (self)' : '源 DC (peer)' }}</th>
          <th>{{ props.direction === 'outbound' ? '目的 DC (peer)' : '目的 DC (self)' }}</th>
          <th>站点</th>
          <th>上报 agent</th>
          <th>发现时间</th>
          <th>最近更新</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="`${row.source_dc}|${row.dest_dc}|${row.collected_at}`"
            :class="rowClass(row)"
            :data-test="`discover-${row.source_dc}-${row.dest_dc}`">
          <td class="dc-cell">{{ row.source_dc }}</td>
          <td class="dc-cell">{{ row.dest_dc }}</td>
          <td class="site-cell">{{ row.site_name || '—' }}</td>
          <td class="agent-cell">{{ row.agent_id }}</td>
          <td class="ts-cell">{{ fmtTs(row.discovered_at) }}</td>
          <td :class="['updated-cell', ageClassFor(row)]">
            {{ fmtRelative(row.collected_at) }}
            <small class="ts-ago">({{ fmtTs(row.collected_at) }})</small>
          </td>
        </tr>
      </tbody>
    </table>
  </component>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
// R158.5 — layout 切换: R156 用 AppLayout (前台),R158.5 site-mode 用
// AdminLayout (后台)。layoutComponent 根据 chrome prop 决定。
import AppLayout from '../../components/AppLayout.vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { dashboardApi } from '../../api/dashboard.js';
import { formatDateTime } from '../../lib/timezone.js';

const props = defineProps({
  // 'inbound' = UI label 入站 (anchor self = dest_dc, source_dc = 上游)
  // 'outbound' = UI label 出战 (anchor self = source_dc, dest_dc = 下游)
  direction: { type: String, default: 'inbound', validator: (v) => v === 'inbound' || v === 'outbound' },
  // 选哪个 api method:
  // R158.10 — outbound API 已下线, 仅留 inbound。
  apiMethod: { type: String, default: 'discoverInbound', validator: (v) => v === 'discoverInbound' },
  // R158.5 — 'flat' (R156 单表) | 'site' (按 site_name 分组,后台默认)
  viewMode: { type: String, default: 'flat', validator: (v) => v === 'flat' || v === 'site' },
  // R158.5 — 'admin' (后台 AdminLayout,默认 site-mode) | 'app' (前台 AppLayout)
  chrome: { type: String, default: 'app', validator: (v) => v === 'admin' || v === 'app' }
});

const layoutComponent = computed(() => (props.chrome === 'admin' ? AdminLayout : AppLayout));

const rows = ref([]);
// 2026-10-20 — 这是**前端自有**的轮询间隔, 不是后端契约.
// /api/dashboard/discovery/inbound 的 envelope 是 { rows, refreshedAt },
// 不含 refreshSeconds 字段 (已核对 routes/dashboard.js:1602). 故本值仅供
// setInterval 使用, 模板上已改成 "页面每 Ns 自动轮询" 以免误读为后端下发.
const refreshSeconds = ref(60); // 30-day cadence — polling is cheap but slow.
const lastLoadedAt = ref(null);
const error = ref('');
const polling = ref(false);
let timerHandle = null;

const tableName = computed(() =>
  props.direction === 'inbound' ? 'ad_partner_inbound' : 'ad_partner_outbound'
);

// R158.5 — site grouping. Operator directive "以站点方式呈现,列出他的入站
// 和出战partner". Anchor by self-DC = direction-aware:
//   inbound:  self = dest_dc, peer = source_dc → group by dest_dc.site_name
//   outbound: self = source_dc, peer = dest_dc → group by source_dc.site_name
// Rows without a site_name (DC not yet in ad_dcs) get the synthetic key
// '__ungrouped__' with label '未分组'. Within a site, partners are
// further bucketed by self-DC name so the operator can read "this site's
// DC X has these N peers" at a glance.
const siteGroups = computed(() => {
  if (props.viewMode !== 'site' || !rows.value.length) return [];
  const groups = new Map();
  for (const row of rows.value) {
    const selfDc = props.direction === 'inbound' ? row.dest_dc : row.source_dc;
    const peerDc = props.direction === 'inbound' ? row.source_dc : row.dest_dc;
    const siteKey = row.site_id != null ? String(row.site_id) : '__ungrouped__';
    const siteLabel = row.site_name || (row.site_id == null ? '未分组 (DC 未登记到 ad_dcs)' : `站点 #${row.site_id}`);
    if (!groups.has(siteKey)) {
      groups.set(siteKey, { key: siteKey, label: siteLabel, dcs: new Map() });
    }
    const g = groups.get(siteKey);
    if (!g.dcs.has(selfDc)) g.dcs.set(selfDc, { dcName: selfDc, partners: [] });
    g.dcs.get(selfDc).partners.push({
      peerDc,
      source_dc: row.source_dc,
      dest_dc: row.dest_dc,
      agent_id: row.agent_id,
      collected_at: row.collected_at,
      discovered_at: row.discovered_at
    });
  }
  // Stable order: sort by site label (with ungrouped last), within site by DC name.
  const arr = Array.from(groups.values()).sort((a, b) => {
    if (a.key === '__ungrouped__') return 1;
    if (b.key === '__ungrouped__') return -1;
    return a.label.localeCompare(b.label, 'zh-Hans-CN');
  });
  return arr.map((g) => {
    const dcs = Array.from(g.dcs.values()).sort((a, b) => a.dcName.localeCompare(b.dcName));
    return {
      key: g.key,
      label: g.label,
      dcCount: dcs.length,
      partnerCount: dcs.reduce((acc, d) => acc + d.partners.length, 0),
      dcs
    };
  });
});

async function load() {
  polling.value = true;
  error.value = '';
  try {
    let r;
    // R158.10 — apiMethod 现在恒为 'discoverInbound', 单路 fetch。
    r = await dashboardApi.getPartnerInboundDiscover();
    rows.value = Array.isArray(r.data?.rows) ? r.data.rows : [];
    lastLoadedAt.value = new Date().toISOString();
  } catch (e) {
    error.value = e?.response?.data?.error || '加载失败';
  } finally {
    polling.value = false;
  }
}

function fmtTs(s) {
  if (!s) return '—';
  return formatDateTime(s);
}

function fmt(s) {
  return s ? formatDateTime(s) : '-';
}

function fmtRelative(s) {
  if (!s) return '—';
  const t = new Date(s).getTime();
  if (!Number.isFinite(t)) return '—';
  const ageMin = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (ageMin < 60) return `${ageMin} 分钟前`;
  const ageHr = Math.floor(ageMin / 60);
  if (ageHr < 24) return `${ageHr} 小时前`;
  const ageDay = Math.floor(ageHr / 24);
  return `${ageDay} 天前`;
}

function ageDaysFor(row) {
  if (!row?.collected_at) return null;
  const t = new Date(row.collected_at).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

function ageClassFor(row) {
  const d = ageDaysFor(row);
  if (d === null) return 'age-none';
  if (d <= 7) return 'age-fresh';
  if (d <= 21) return 'age-warn';
  return 'age-stale';
}

function rowClass(row) {
  return ['discovery-row', ageClassFor(row)];
}

const maxAgeDays = computed(() => {
  let max = null;
  for (const r of rows.value) {
    const d = ageDaysFor(r);
    if (d === null) continue;
    if (max === null || d > max) max = d;
  }
  return max;
});

const ageClass = computed(() => {
  const d = maxAgeDays.value;
  if (d === null) return '';
  if (d <= 7) return 'fresh';
  if (d <= 21) return 'warn';
  return 'stale';
});

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
.staleness {
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 3px;
  font-variant-numeric: tabular-nums;
}
.staleness.fresh { background: color-mix(in srgb, var(--green) 14%, transparent);  color: var(--green); }
.staleness.warn  { background: color-mix(in srgb, var(--yellow) 14%, transparent);  color: var(--yellow); }
.staleness.stale { background: color-mix(in srgb, var(--red) 14%, transparent);    color: var(--red); }
.hint { color: var(--muted); font-size: 12px; margin: 0 0 16px; }
.hint code { background: var(--border); padding: 1px 6px; border-radius: 3px; font-size: 11px; }
.error-banner { background: var(--red-bg); color: var(--red); padding: 8px 12px; border-radius: 3px; margin-bottom: 12px; }
.empty { text-align: center; color: var(--muted); padding: 24px; }
.legend { display: flex; gap: 12px; margin: 0 0 16px; font-size: 12px; color: var(--muted); }
.legend-item { display: inline-flex; gap: 6px; align-items: center; }
.legend-swatch { display: inline-block; width: 12px; height: 12px; border-radius: 3px; border: 1px solid var(--border); }
.swatch-fresh { background: var(--success-bg); border-color: var(--fsmo-border); }
.swatch-warn  { background: var(--warning-bg); border-color: var(--status-pill-fg-warn); }
.swatch-stale { background: var(--danger-bg); border-color: var(--status-pill-fg-err); }

.discovery-table { border-collapse: collapse; background: var(--panel); width: 100%; }
.discovery-table th, .discovery-table td {
  border: 1px solid var(--border); padding: 6px 10px; text-align: left; font-size: 13px;
}
.discovery-table th { background: var(--sidebar-bg); color: var(--muted); font-size: 12px; font-weight: 600; }
.discovery-table tbody tr:nth-child(even) { background: color-mix(in srgb, var(--text) 2%, transparent); }
.dc-cell    { font-family: ui-monospace, monospace; font-weight: 600; }
.site-cell  { color: var(--muted); font-size: 12px; }
.agent-cell { font-family: ui-monospace, monospace; font-size: 12px; color: var(--muted); }
.ts-cell    { font-family: ui-monospace, monospace; font-size: 12px; color: var(--text); }
.updated-cell { font-family: ui-monospace, monospace; font-size: 12px; }
.ts-ago { color: var(--muted); font-size: 10px; display: block; margin-top: 2px; }

.age-fresh { color: var(--green);  font-weight: 600; }
.age-warn  { color: var(--yellow); font-weight: 600; }
.age-stale { color: var(--red);    font-weight: 600; }
.age-none  { color: var(--muted); }

/* ===== R158.5 — site grouping mode ===== */
.site-groups { display: flex; flex-direction: column; gap: 18px; }
.site-group {
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--panel);
}
.site-group-header {
  background: var(--sidebar-bg);
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  border-radius: 4px 4px 0 0;
}
.site-group-title { display: flex; gap: 10px; align-items: baseline; }
.site-group-icon { font-size: 14px; }
.site-group-name { font-size: 14px; font-weight: 700; color: var(--text); }
.site-group-count { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }

.dc-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 12px;
  padding: 12px;
}
.dc-card {
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--input-bg);
  display: flex;
  flex-direction: column;
}
.dc-card-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--sidebar-bg);
  border-radius: 4px 4px 0 0;
}
.dc-card-name { font-size: 13px; font-weight: 600; color: var(--text); margin: 0; font-family: ui-monospace, monospace; }
.dc-card-meta { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.dc-partners-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dc-partners-table th,
.dc-partners-table td {
  padding: 5px 10px;
  text-align: left;
  border-bottom: 1px solid var(--border);
}
.dc-partners-table th { background: transparent; color: var(--muted); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
.dc-partners-table tbody tr:last-child td { border-bottom: 0; }
.dc-partners-table .peer-cell { font-family: ui-monospace, monospace; font-weight: 600; color: var(--text); }
.dc-partners-table .agent-cell { font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted); }
.dc-partners-table .updated-cell { font-family: ui-monospace, monospace; font-size: 11px; }
.dc-partners-table .ts-ago { color: var(--muted); font-size: 10px; display: block; margin-top: 2px; }
.dc-empty { padding: 16px; color: var(--muted); font-size: 12px; text-align: center; }
</style>
