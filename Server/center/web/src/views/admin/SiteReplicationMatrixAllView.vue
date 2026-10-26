<!--
  复制状态概览 (复制伙伴状态 全站) — R158.15 (2026-10-01)
  ────────────────────────────────
  operator 拍板: 复制伙伴清单改用 ad_partner_inbound (R156 discover 表,
  30 天窗口) 作为唯一真实数据源, 不再读 ad_replication_status 30 分钟
  探针. 健康度字段由 R158.15 15min cadence probe 包接入 — 视图
  v_partner_inbound LEFT JOIN ad_replication_probe_history 15min 窗口
  (worst-of-NCs 聚合) 输出 probe_state + probe_attempt_at +
  probe_duration_ms + probe_error_message.

  R158.15 改动 (在 R158.14 基础上):
  - 后端: db/migrations/042-replication-probe-history-{mysql,mssql}.sql
    新建 ad_replication_probe_history append-only 表.
  - 后端: db/migrations/043-v-partner-inbound-probe-state-{mysql,mssql}.sql
    视图扩展 4 列 probe_state / probe_attempt_at / probe_duration_ms /
    probe_error_message.
  - 后端: routes/dashboard.js /all endpoint 装入 probe_state 等字段
    (替换 R158.14 'none' 占位).
  - 前端: status-pill 按 probeState 渲染 success/error/partial 三态,
    'none' 保留为灰色 "待接入探针" (15min 内无数据).
  - 前端: tooltip 显示最近 attempt 时间 + 耗时 + 错误详情 (仅 error).

  R45/R47 数据契约 (per-DC partner tables / caret / /pair-history
  lazy expand / data-test 选择器) 保留.
-->
<template>
  <AdminLayout>
    <header class="page-header">
      <div class="page-titles">
        <div class="eyebrow">运维管理 · 复制健康</div>
        <h2 class="page-title">复制状态概览</h2>
        <p class="subtitle">所有站点的入站复制伙伴 (基于发现拓扑) · {{ refreshSeconds }} 秒自动刷新</p>
      </div>
      <div class="page-meta">
        <div class="refresh-pill">
          <span :class="['refresh-dot', polling ? 'on' : 'off']"></span>
          <span class="refresh-label">{{ polling ? '同步中' : '已同步' }}</span>
        </div>
        <div class="last-loaded" v-if="lastLoadedAt">
          <span class="muted-label">最近刷新</span>
          <span class="time">{{ fmt(lastLoadedAt) }}</span>
        </div>
      </div>
    </header>

    <!-- R158.14 — fleet ribbon 简化: 健康度相关 tile (健康/部分失败/失败) 删除.
      当前数据源是 discover 拓扑 (ad_partner_inbound 30 天), 不含 status_code,
      所以这三个数字无意义. 保留 站点 / 域控 / 入站链路 三个 tile.
      后续 15min probe 包落地后再恢复. -->
    <div class="fleet-ribbon" v-if="primaries.length" data-test="fleet-ribbon">
      <div class="ribbon-tile">
        <div class="ribbon-num">{{ totals.sites }}</div>
        <div class="ribbon-label">站点</div>
      </div>
      <div class="ribbon-tile">
        <div class="ribbon-num">{{ totals.dcs }}</div>
        <div class="ribbon-label">域控</div>
      </div>
      <div class="ribbon-tile">
        <div class="ribbon-num">{{ totals.links }}</div>
        <div class="ribbon-label">入站伙伴</div>
      </div>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="!primaries.length && !error" class="empty">暂无站点 — 请在 AD 站点清单添加</div>

    <section v-for="p in primaries" :key="p.siteId ?? p.siteName" class="site-block" :data-test-site="p.siteName">
      <header class="site-header">
        <div class="site-title">
          <h3>
            <span :class="['hub-badge', p.isHub ? 'yes' : 'no']">{{ p.isHub ? '中心站点' : '分支站点' }}</span>
            {{ p.siteName }}
            <span class="site-region">{{ p.regionCode || '—' }}</span>
          </h3>
        </div>
        <div class="site-stats">
          <span class="stat"><span class="stat-num">{{ (p.dcs || []).length }}</span><span class="stat-label"> DC</span></span>
          <span class="stat"><span class="stat-num">{{ siteLinkCount(p) }}</span><span class="stat-label"> 入站伙伴</span></span>
          <!-- R158.14 — 异常 stat 删除: 健康度暂未接入, 没有"异常"概念.
            后续 15min probe 包落地后再恢复. -->
        </div>
      </header>

      <div v-if="!p.dcPartners || !p.dcPartners.length" class="empty">该站点暂无 DC</div>

      <div v-for="dc in p.dcPartners" :key="dc.dcName" class="dc-block" :data-test-dc-block="dc.dcName">
        <header class="dc-header">
          <span class="dc-name">{{ dc.dcName }}</span>
          <span class="dc-roles-inline">
            <span v-if="dc.isBridgehead" class="role-badge bridgehead">桥头</span>
            <span v-if="dc.isPdc" class="role-badge fsmo">PDC</span>
            <span v-if="dc.isGc" class="role-badge fsmo">GC</span>
            <span v-if="dc.isRidMaster" class="role-badge fsmo">RID</span>
            <span v-if="dc.isSchemaMaster" class="role-badge fsmo">Schema</span>
            <span v-if="dc.isDomainNamingMaster" class="role-badge fsmo">DNaming</span>
            <span v-if="dc.isInfrastructureMaster" class="role-badge fsmo">Infra</span>
          </span>
          <span class="dc-os-inline">{{ dc.osVersion || '—' }}</span>
          <span class="dc-partner-count">{{ dc.partners.length }} 伙伴</span>
          <!-- R158.103.1 (2026-10-15) — silent reporter 徽标. 整台 DC
            探针包停止跑 >2h 时显, 不依赖 partner row 存在 (空 DC
            也有信号). 跟 partner row 浅红背景 配套, operator 一眼
            看出"这台 DC 整个 reporter 死了". -->
          <span v-if="isDcSilent(dc.dcName)" class="silent-badge"
                :title="`${dc.dcName} 探针已停止 ${silentSince(dc.dcName)}, 现场查看 agent service`"
                :data-test-silent-dc="dc.dcName">探针未运行</span>
        </header>

        <table class="matrix">
          <thead>
            <tr>
              <th class="caret-col"></th>
              <th>类型</th>
              <th>伙伴站点</th>
              <th>伙伴 DC</th>
              <th>当前状态</th>
              <!-- R158.17.4 (2026-10-01) — "上报 agent" 列. 写这条入站
                伙伴拓扑的 agent 机器名 (例 KDLFLOFADSRV2). 字段在
                v_partner_inbound.reporter_agent_id (R158.14 已暴露),
                centre handler 已经装进 partner entry, agent 端无需重打包.
                operator 二次决策: 两个 endpoint (/all + /monitor-inbound)
                都加 agent 列, 不用分别看 portHealth vs reporterAgentId
                字段名差异, 一律叫"上报 agent". -->
              <th class="reporter-agent-col">上报 agent</th>
              <!-- R158.17.1 -- 外层列名"上次检测时间" 改读 lastProbeAt
                (probe_history 15min 窗口最近一次), 跟展开表格的"上次执行时间"
                (probe_history 全历史) 区分开. probeState=none 时显示"未检测". -->
              <th class="last-success-col">上次检测时间</th>
              <!-- R158.Suppression (2026-10-15) — 操作员行级暂停告警 button 列.
                配 SiteReplicationMatrixAllView 第 N+1 次模板增量; 0 改其他列;
                跟随 R158.77.2 #2 跨 fleet 不适用 (此 view 仅 NoAD 复制概览).
                跨 colspan 同步 +1: 主行 7→8, attempts-row fallback 7→8, 无伙伴 fallback 7→8. -->
              <th class="ops-col">操作</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="partner in dc.partners" :key="`${dc.dcName}-${partner.peerType}-${partner.peerDc}`">
              <tr :class="rowClass(partner)"
                  :data-test="`partner-${partner.peerType}-${dc.dcName}-${partner.peerDc}`">
                <td class="caret-col">
                  <button class="caret-btn"
                          :data-test="`caret-${dc.dcName}-${partner.peerDc}`"
                          :aria-label="isExpanded(dc.dcName, partner) ? '折叠历史' : '展开历史'"
                          @click="togglePartner(dc.dcName, partner)">
                    {{ isExpanded(dc.dcName, partner) ? '▼' : '▶' }}
                  </button>
                </td>
                <td>
                  <span :class="['peer-tag', `peer-tag-${partner.peerType || 'unknown'}`]">{{ peerTypeLabel(partner) }}</span>
                </td>
                <td>
                  <span class="peer-site">{{ partner.peerSite }}</span>
                  <span v-if="partner.peerSiteIsHub" class="hub-mini">中心</span>
                </td>
                <td class="peer-dc">{{ partner.peerDc }}</td>
                <td class="status">
                  <!-- R158.15 — probe 包接入后, status pill 按 probeState
                    渲染 复制成功 (绿) / 部分失败 (黄) / 失败 (红) /
                    待接入探针 (灰, 15min 内无数据). Tooltip 显示
                    最近 attempt 时间 + 耗时 + 错误详情. -->
                  <span :class="['status-pill', `status-pill-${statusClass(partner)}`]"
                        :title="statusTooltip(partner)">{{ statusLabel(partner) }}</span>
                </td>
                <!-- R158.17.4 — "上报 agent" 单元格. reporterAgentId 由
                  handler 从 v_partner_inbound.reporter_agent_id 装入
                  (R158.14 已 ship, DB 端 SELECT 早已包含). 老 agent
                  bundle (R93.7 之前) reporter_agent_id 可能为 NULL → "—".
                  -->
                <td class="reporter-agent-col"
                    :data-test="`reporter-agent-${dc.dcName}-${partner.peerDc}`">
                  {{ partner.reporterAgentId || '—' }}
                </td>
                <!-- R158.17.1 -- 改读 lastProbeAt (probe_history.attempt_at),
                  discoveredAt 仍保留在 payload 但前端不再展示 (语义混淆).
                  probeState=none 或无 15min 内数据 → 显示"未检测"灰字. -->
                <td class="last-success-cell">
                  <template v-if="partner.probeState === 'none' || !partner.lastProbeAt">
                    <span class="no-probe">未检测</span>
                  </template>
                  <template v-else>{{ fmt(partner.lastProbeAt) }}</template>
                </td>
                <!-- R158.Suppression (2026-10-15) — 行级暂停/恢复告警 toggle.
                  scopeRef 跟 system-alert-engine.js:133 `${dc}→${peer}` 完全一致;
                  简化 UX: 单个 toggle 按钮, 文字 / 配色 / class 全部由 isSuppressed 决.
                  未暂停: 灰底 + "暂停告警" + 调 suppress.
                  已暂停: 红底 + "恢复告警" + 实心圆点前缀 + 调 unsuppress.
                  不开 ElMessageBox.confirm (轻量 toggle, false-positive 可立即恢复). -->
                <td class="ops-cell">
                  <button :class="isSuppressed(dc.dcName, partner.peerDc) ? 'resume-btn' : 'pause-btn'"
                          :data-test="`pause-${dc.dcName}-${partner.peerDc}`"
                          @click="isSuppressed(dc.dcName, partner.peerDc)
                                   ? unsuppressReplicationAlert(dc.dcName, partner.peerDc)
                                   : suppressReplicationAlert(dc.dcName, partner.peerDc)">
                    <span v-if="isSuppressed(dc.dcName, partner.peerDc)" class="dot"></span>
                    {{ isSuppressed(dc.dcName, partner.peerDc) ? '恢复告警' : '暂停告警' }}
                  </button>
                  <!-- R158.103.2 — 操作列 "明细" 按钮, 跟 pause/resume 上下排.
                    点 → 右侧滑出 drawer, 显 50 条 attempt 11 字段全明细
                    (含 status_code / duration_ms / error_code / error_message).
                    跟 inline caret 展开 0 冲突 (后者 4 列 10 条). -->
                  <button class="detail-btn" :data-test="`detail-${dc.dcName}-${partner.peerDc}`"
                          @click="openDetail(dc.dcName, partner.peerDc)">
                    明细
                  </button>
                </td>
              </tr>
              <tr v-if="isExpanded(dc.dcName, partner)"
                  class="attempts-row"
                  :data-test="`attempts-${dc.dcName}-${partner.peerDc}`">
                <td colspan="8">
                  <div v-if="loadingPair === expandKey(dc.dcName, partner)" class="loading">加载中…</div>
                  <div v-else-if="(attemptsByKey(expandKey(dc.dcName, partner)) || []).length === 0" class="empty">
                    暂无历史记录 — 15min probe 包尚未采集到该伙伴的数据
                  </div>
                  <div v-else class="attempts-container">
                    <!-- R158.17 — 展开历史改读 probe_history (源+目标+时间+结果
                      四列), limit=10. 不再走 /pair-history 的 ad_replication_history
                      (老流水含 NC/duration/objects/error 等字段). -->
                    <!-- R158.26.2 — wire-shape swizzle. The probe_history table
                      stores source_dc=localDc / dest_dc=partner (probe-agent-centric
                      semantics, runs at the local DC). The inbound UI convention
                      treats source=partner-as-sender / target=localDc-as-receiver
                      — i.e. the *column headers* 源 / 目标 expect a different
                      orientation than the row columns. R158.26 handler params
                      are swizzled so the row payload arrives with the right
                      values; this template renders them with the matching swap
                      (a.destDc under "源" header, a.sourceDc under "目标"). -->
                    <table class="attempts-table">
                      <thead>
                        <tr>
                          <th>源</th>
                          <th>目标</th>
                          <th>上次执行时间</th>
                          <th>结果</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="(a, i) in attemptsByKey(expandKey(dc.dcName, partner))" :key="i"
                            :class="['att-row', `att-row-${probeResultClass(a)}`]">
                          <!-- R158.26.2: a.destDc = peer (operator's "源" = sender),
                            a.sourceDc = localDc (operator's "目标" = target = me). -->
                          <td>{{ a.destDc }}</td>
                          <td>{{ a.sourceDc }}</td>
                          <td>{{ fmt(a.attemptAt) }}</td>
                          <td>
                            <span class="glyph">{{ probeResultGlyph(a) }}</span>
                            {{ probeResultLabel(a) }}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </td>
              </tr>
            </template>
            <tr v-if="!dc.partners.length">
              <td colspan="8" class="empty-row">无伙伴连接</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- R158.103.2 — 复制状态概览 "明细" drawer. 跟 R158.100.A
      email history drawer 1:1 平行: aside.drawer @click.self=close, 50%
      宽 + min 480px (跟 email 同, 7 列 UI 紧凑), z-index 200 (跟 email
      同). 无 mask overlay, operator 看完可继续点其它 partner 行
      (跟 R158.100.A 1:1). 类名 .site-replication-drawer 跟
      .email-history-drawer 隔离 (scoped style 各自维护, 避免 .drawer
      通用 class 跨 view 冲突). -->
    <aside v-if="detailDrawer" class="site-replication-drawer" @click.self="closeDetail">
      <div class="site-replication-drawer-body">
        <header>
          <h3>
            同步明细
            <small>{{ detailDrawer.localDc }} ← {{ detailDrawer.peerDc }}</small>
          </h3>
          <button class="close" @click="closeDetail" aria-label="关闭">×</button>
        </header>
        <p v-if="detailDrawerLoading" class="muted">加载中…</p>
        <p v-else-if="detailDrawerError" class="error">{{ detailDrawerError }}</p>
        <p v-else-if="detailDrawerEntries.length === 0" class="muted">
          暂无记录 — 该伙伴最近 50 次 attempt 0 命中
        </p>
        <table v-else class="site-replication-drawer-table">
          <thead>
            <tr>
              <th>执行时间</th>
              <th>结果</th>
              <th>状态码</th>
              <th>耗时</th>
              <th>对象数</th>
              <th>错误码</th>
              <th>错误信息</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(a, i) in detailDrawerEntries" :key="i"
                :class="['detail-row', `detail-row-${fmtResultBadge(a.result).cls}`,
                         a.errorMessage ? 'detail-row-has-err' : 'detail-row-no-err']">
              <td>{{ fmt(a.attemptAt) }}</td>
              <td>
                <span class="glyph">{{ fmtResultBadge(a.result).glyph }}</span>
                {{ fmtResultBadge(a.result).label }}
              </td>
              <td>{{ fmtStatusCode(a.statusCode) }}</td>
              <td>{{ fmtDuration(a.durationMs) }}</td>
              <td>{{ a.objectsTransferred ?? '—' }}</td>
              <td>{{ a.errorCode ?? '—' }}</td>
              <td class="em-cell">{{ a.errorMessage || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </aside>
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { dashboardApi } from '../../api/dashboard.js';
// R158.Suppression (2026-10-15) — 操作员行级暂停告警 toggle. 跟 dashboardApi 兄弟,
//   现成 adminApi.listAlertSuppressions/suppressAlert/unsuppressAlert 1:1 平行. 0 改其他 fetch.
import { adminApi } from '../../api/admin.js';

const primaries = ref([]);
const refreshSeconds = ref(10);
const lastLoadedAt = ref(null);
const error = ref('');
const polling = ref(false);

// round-45 inline expansion state.
const expanded = ref(new Set());     // set of `${dc}|${peerDc}` keys
const attempts = ref(new Map());     // key → entries[]
const loadingPair = ref(null);       // currently fetching

// R158.Suppression — 抑制 map (key = `${dc}→${peer}` 跟 engine.js:133 同 scopeRef shape;
//   value = true). onMounted 拉一次, suppress/unsuppress 操作后再拉一次保持同步.
const suppressions = ref(new Map());

// R158.103.2 (2026-10-15) — "明细" drawer 状态. 跟 R158.100.A
// email history drawer 范式 1:1 平行. 同一时间只开 1 个 pair. 跟
// attempts (inline caret, 10 条 4 列) 0 冲突: drawer 是 50 条 11 字段.
// 命名 detailDrawer (非 detailRow) 避撞 EmailConfigView 跨 view
// 状态污染风险.
const detailDrawer = ref(null);   // { localDc, peerDc } | null
const detailDrawerEntries = ref([]);
const detailDrawerLoading = ref(false);
const detailDrawerError = ref('');

function openDetail(localDc, peerDc) {
  detailDrawer.value = { localDc, peerDc };
  detailDrawerEntries.value = [];
  detailDrawerError.value = '';
  detailDrawerLoading.value = true;
  dashboardApi.getSiteReplicationMatrixProbeHistoryDetail(localDc, peerDc, 50)
    .then(r => {
      const data = r.data || {};
      detailDrawerEntries.value = data.entries || [];
    })
    .catch(e => { detailDrawerError.value = e?.response?.data?.error || e?.message || '加载失败'; })
    .finally(() => { detailDrawerLoading.value = false; });
}
function closeDetail() { detailDrawer.value = null; }

// R158.103.2 — drawer 表格格式化 helper. 跟 probeResultClass 1:1 平行
// 但独立 (不依赖 probe 派生态, 走 raw enum 直渲染).
function fmtDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
function fmtResultBadge(r) {
  if (r === 'success') return { glyph: '✓', cls: 'ok',   label: '成功' };
  if (r === 'error')   return { glyph: '✕', cls: 'err',  label: '失败' };
  if (r === 'partial') return { glyph: '!', cls: 'warn', label: '部分' };
  return { glyph: '?', cls: 'none', label: r || '—' };
}
function fmtStatusCode(sc) {
  if (sc == null) return '—';
  if (sc === 0) return '0 OK';
  if (sc === 1) return '1 失败';
  if (sc === 2) return '2 错误';
  return String(sc);
}

// R158.103.1 (2026-10-15) — silent reporter detection. 后端 envelope
// livenessByAgent: { agent_id: { total, latest } }. 前端 computed 从中
// 算 silentAgentIds Set (latest < now - 2h → silent). threshold 单点
// 真相在前端, 改 2h grace 不动后端. 触发场景: 沈阳#1 KDLSYOFADSRV1
// 4h 没跑 probe 包, 整行标红.
const SILENT_GRACE_HOURS = 2;
const livenessByAgent = ref({});  // raw object from backend
const silentAgentIds = computed(() => {
  const threshold = Date.now() - SILENT_GRACE_HOURS * 3600 * 1000;
  const s = new Set();
  for (const [k, v] of Object.entries(livenessByAgent.value || {})) {
    if (!v || !v.latest) continue;
    if (new Date(v.latest).getTime() < threshold) s.add(k);
  }
  return s;
});

let timerHandle = null;

// R158.14 — fleet-level totals 简化: 健康度字段删除, ribbon 只数 站点 / 域控 /
// 入站伙伴. 后续 15min probe 包落地后再恢复 ok/warn/err 桶.
const totals = computed(() => {
  let sites = 0, dcs = 0, links = 0;
  for (const p of primaries.value) {
    sites++;
    dcs += (p.dcs || []).length;
    for (const dc of (p.dcPartners || [])) {
      links += dc.partners.length;
    }
  }
  return { sites, dcs, links };
});

function siteLinkCount(p) {
  let n = 0;
  for (const dc of (p.dcPartners || [])) n += dc.partners.length;
  return n;
}
// R158.14 — siteErrCount 删除 (无健康度). 保留 stub 避免 template 引用报错,
// 后续 15min probe 包落地时按 statusCode 重写.
function siteErrCount(p) { return 0; }

async function load() {
  polling.value = true;
  error.value = '';
  try {
    const r = await dashboardApi.getSiteReplicationMatrixAll();
    primaries.value = Array.isArray(r.data?.primaries) ? r.data.primaries : [];
    refreshSeconds.value = Number(r.data?.siteRefreshSeconds) || 10;
    // R158.103.1 (2026-10-15) — 解析 livenessByAgent envelope 字段.
    // 旧 backend 不发时 (rolling deploy) 默认 {}, silentAgentIds 算
    // 出空 Set, 不影响其它逻辑.
    livenessByAgent.value = r.data?.livenessByAgent && typeof r.data.livenessByAgent === 'object'
      ? r.data.livenessByAgent
      : {};
    lastLoadedAt.value = new Date().toISOString();
    pruneExpanded();
  } catch (e) {
    error.value = e?.response?.data?.error || '加载失败';
  } finally {
    polling.value = false;
  }
}

function expandKey(dc, p) { return `${dc}|${p.peerDc}`; }
function isExpanded(dc, p) { return expanded.value.has(expandKey(dc, p)); }
function attemptsByKey(key) { return attempts.value.get(key); }

// R158.Suppression — scope_ref 计算跟 engine.js:133 `${r.source_dc}→${r.dest_dc}` 完全一致
//   (UTF8 '→' U+2192, 不混 ASCII '->'). 跟 pauseAlert/resumeAlert 配合; 单纯是字面拼接,
//   0 改其他 view.
function scopeRefOf(dc, peer) { return `${dc}→${peer}`; }
function isSuppressed(dc, peer) { return suppressions.value.has(scopeRefOf(dc, peer)); }
async function loadSuppressions() {
  try {
    const r = await adminApi.listAlertSuppressions({ kind: 'replication_failed' });
    const m = new Map();
    for (const item of (r?.items || [])) {
      // scope_ref = 'DC-A → DC-B'; 我们把它反过来拆 `${dest}→${src}` 给 src==localDc 视角用.
      // engine.js 写入时是 `${sourceDc}→${destDc}`; 我们这页 view 是 localDc=dc.dcName 是 source,
      // partner 是 dest → 跟 scopeRef shape 一致, 直接当 map key.
      if (item.scope_ref) m.set(item.scope_ref, true);
    }
    suppressions.value = m;
  } catch (_e) { /* swallow — pause button 默认显示 "暂停告警" */ }
}
async function suppressReplicationAlert(dc, peer) {
  try {
    await adminApi.suppressAlert('replication_failed', scopeRefOf(dc, peer), null);
    await loadSuppressions();
  } catch (e) {
    error.value = e?.response?.data?.error || '暂停失败';
  }
}
async function unsuppressReplicationAlert(dc, peer) {
  try {
    await adminApi.unsuppressAlert('replication_failed', scopeRefOf(dc, peer));
    await loadSuppressions();
  } catch (e) {
    error.value = e?.response?.data?.error || '恢复失败';
  }
}

function pruneExpanded() {
  // Drop expansion keys (and cached attempts) for partners that no longer
  // exist in the latest /all payload — keeps the state map bounded across
  // polling cycles.
  const valid = new Set();
  for (const p of primaries.value) {
    for (const dc of (p.dcPartners || [])) {
      for (const partner of dc.partners) {
        valid.add(expandKey(dc.dcName, partner));
      }
    }
  }
  for (const k of [...expanded.value]) {
    if (!valid.has(k)) expanded.value.delete(k);
  }
  for (const k of [...attempts.value.keys()]) {
    if (!valid.has(k)) attempts.value.delete(k);
  }
}

async function togglePartner(dcName, partner) {
  const key = expandKey(dcName, partner);
  if (expanded.value.has(key)) {
    expanded.value.delete(key);
    return;
  }
  expanded.value.add(key);
  // Lazy fetch only on first expansion — repeated toggles reuse the cache.
  if (!attempts.value.has(key)) {
    loadingPair.value = key;
    try {
      // R158.17 — 展开历史改走 probe-history (ad_replication_probe_history).
      // dcName = catalog DC (DB dest_dc = receiver), partner.peerDc = partner
      // DC (DB source_dc = sender). limit=10 (用户要求 "展开是历史10次记录").
      const r = await dashboardApi.getSiteReplicationMatrixProbeHistory(dcName, partner.peerDc, 10);
      attempts.value.set(key, Array.isArray(r.data?.entries) ? r.data.entries : []);
    } catch (e) {
      attempts.value.set(key, []);
      error.value = e?.response?.data?.error || '加载历史失败';
    } finally {
      loadingPair.value = null;
    }
  }
}

// Status helpers — R158.15: probe 包已落地, 按 probeState 渲染.
// 'none' = 15min 内无 probe 数据 (灰色 "待接入探针").
// 'success' = 全部 NC 复制成功 (绿).
// 'error'   = 任一 NC 失败 (红).
// 'partial' = mixed: 有 NC 成功 + 有 NC 失败 (黄).
// R158.103.1 (2026-10-15) — silent reporter detection helper. silent
// 判定是 reporter 端 latest probe attempt < now-2h (前端 computed
// silentAgentIds 单点真相). success 状态不染红 (15min race 窗口
// 太短, tooltip 提示够了), 只在 probe_state ∈ {none, error, partial}
// 时覆盖. silent 优先级 > 其它 status-*, CSS 在 .status-ok/-err 之后
// 声明让 specificity 胜.
function isPartnerSilent(p) {
  if (p.probeState === 'success') return false;  // race 窗口不染红
  return silentAgentIds.value.has(p.reporterAgentId);
}
function isDcSilent(dcName) {
  return silentAgentIds.value.has(dcName);
}
function silentSince(dcName) {
  const v = livenessByAgent.value[dcName];
  if (!v || !v.latest) return '未知时长';
  const agoMin = Math.round((Date.now() - new Date(v.latest).getTime()) / 60000);
  const h = Math.floor(agoMin / 60);
  const m = agoMin % 60;
  return h > 0 ? `${h}小时${m}分钟` : `${m}分钟`;
}

function statusClass(p) {
  // R158.103.1 — silent 优先, 但仅在 probe_state ≠ success.
  if (isPartnerSilent(p)) return 'silent';
  if (p.probeState === 'success') return 'ok';
  if (p.probeState === 'error')   return 'err';
  if (p.probeState === 'partial') return 'warn';
  return 'none';
}
function statusLabel(p) {
  // R158.103.1 — silent 显"探针未运行", 跟 none "待接入探针" 区分.
  if (isPartnerSilent(p)) return '探针未运行';
  if (p.probeState === 'success') return '复制成功';
  if (p.probeState === 'error')   return '失败';
  if (p.probeState === 'partial') return '部分失败';
  return '待接入探针';
}
function statusTooltip(p) {
  // R158.103.1 — silent 显 N 小时 (reporter 端 latest 距今).
  if (isPartnerSilent(p)) {
    const since = silentSince(p.reporterAgentId);
    return `${p.reporterAgentId} 探针已停止 ${since}, 现场查看 agent service`;
  }
  if (p.probeState === 'success') {
    const at = p.probeAttemptAt ? fmt(p.probeAttemptAt) : '—';
    const dur = (p.probeDurationMs != null) ? `${p.probeDurationMs} ms` : '—';
    return `最近成功 ${at} · 耗时 ${dur}`;
  }
  if (p.probeState === 'error' || p.probeState === 'partial') {
    const at = p.probeAttemptAt ? fmt(p.probeAttemptAt) : '—';
    const dur = (p.probeDurationMs != null) ? `${p.probeDurationMs} ms` : '—';
    const msg = p.probeErrorMessage || '(无错误详情)';
    return `失败 ${at} · 耗时 ${dur} · ${msg}`;
  }
  // 'none'
  return `发现拓扑来源: ${p.reporterAgentId || '未知 agent'} · 15min 内无 probe 数据`;
}
function rowClass(p) {
  // R158.15 — 映射 probeState 到行级 CSS class, 整行严重度样式生效
  // (左侧色条 + 浅底色背景). 与 statusClass(p) 互补, statusClass 渲染
  // status pill (细粒度), rowClass 渲染整行 (粗粒度).
  //
  // R158.103.1 — silent 优先级最高 (但仅当 probe_state ≠ success).
  // CSS .status-silent 在 .status-ok/-err/-warn/-none 之后声明让
  // specificity 胜, 这里早返即可.
  const cls = { 'partner-row': true };
  if (isPartnerSilent(p)) {
    cls['status-silent'] = true;
    return cls;
  }
  switch (p.probeState) {
    case 'success': cls['status-ok']   = true; break;
    case 'error':   cls['status-err']  = true; break;
    case 'partial': cls['status-warn'] = true; break;
    default:        cls['status-none'] = true; break;
  }
  return cls;
}
function probeResultClass(a) {
  // R158.17 — probe_history result 仅 success/error 二态 (status_code 0/2).
  if (a.result === 'success') return 'ok';
  return 'err';
}
function probeResultGlyph(a) {
  if (a.result === 'success') return '●';
  return '✕';
}
function probeResultLabel(a) {
  if (a.result === 'success') return '成功';
  return '失败';
}
function peerTypeLabel(p) {
  if (p.peerType === 'within') return '本站';
  if (p.peerType === 'bridgehead') return '桥头';
  return '未知';
}
function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }

onMounted(async () => {
  await load();
  // R158.Suppression — 拉一次抑制清单作为按钮初始态; 后台 polling 不会拉抑制 (抑制不频繁变更).
  await loadSuppressions();
  timerHandle = setInterval(load, refreshSeconds.value * 1000);
});
onUnmounted(() => { if (timerHandle) clearInterval(timerHandle); });
</script>

<style scoped>
/* ===== Page header ===================================================== */
.page-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 24px; margin-bottom: 20px; padding-bottom: 18px;
  border-bottom: 1px solid var(--border);
}
.page-titles { display: flex; flex-direction: column; gap: 4px; }
.eyebrow {
  font-size: 10px; font-weight: 600; letter-spacing: 0.14em;
  color: var(--muted); text-transform: uppercase;
}
.page-title {
  margin: 0; font-size: 20px; font-weight: 600; color: var(--text);
  letter-spacing: -0.01em;
}
.subtitle { margin: 0; font-size: 13px; color: var(--muted); }
.page-meta { display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
.refresh-pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px; border-radius: 999px;
  background: var(--panel-alt); border: 1px solid var(--border);
  font-size: 11px; color: var(--text); font-weight: 500;
}
.refresh-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.refresh-dot.on  { background: var(--green); box-shadow: 0 0 6px color-mix(in srgb, var(--green) 60%, transparent); }
.refresh-dot.off { background: var(--muted); }
.refresh-label { font-size: 11px; letter-spacing: 0.02em; }
.last-loaded { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; }
.muted-label {
  font-size: 9px; color: var(--muted);
  letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600;
}
.time {
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 11px; color: var(--text);
  font-feature-settings: "tnum";
}

/* ===== Fleet health ribbon (signature element) ========================= */
.fleet-ribbon {
  display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 1px; margin-bottom: 24px;
  background: var(--border); border: 1px solid var(--border); border-radius: 4px;
  overflow: hidden;
}
.ribbon-tile {
  background: var(--panel); padding: 14px 18px;
  display: flex; flex-direction: column; gap: 2px; min-width: 0;
}
/* R158.14 — ribbon-warn / -err / -ok 配色块删除: 健康度字段暂未接入,
   无对应 ribbon tile. 后续 15min probe 包落地后再恢复. */
.ribbon-num {
  font-size: 22px; font-weight: 600; line-height: 1;
  font-feature-settings: "tnum"; letter-spacing: -0.01em;
  color: var(--text);
}
/* R158.14 — ribbon-warn / -err 数字配色删除: 同上, 健康度暂未接入. */
.ribbon-label {
  font-size: 11px; color: var(--muted);
  letter-spacing: 0.06em; margin-top: 4px; font-weight: 500;
}

/* ===== Error / empty states ============================================ */
.error-banner {
  background: var(--red-bg); color: var(--red);
  padding: 10px 14px; border-radius: 4px; margin-bottom: 16px;
  border: 1px solid color-mix(in srgb, var(--red) 30%, transparent); font-size: 13px;
}
.empty { text-align: center; color: var(--muted); padding: 28px; font-size: 13px; }
.loading { text-align: center; color: var(--muted); padding: 16px; font-size: 12px; }

/* ===== Site section ==================================================== */
.site-block {
  margin-bottom: 24px;
  background: var(--panel);
  border: 1px solid var(--border); border-radius: 4px;
  overflow: hidden;
}
.site-header {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 12px 16px;
  background: var(--panel-alt);
  border-bottom: 1px solid var(--border);
}
.site-title { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.site-title h3 {
  margin: 0; font-size: 15px; font-weight: 600; color: var(--text);
  letter-spacing: -0.005em;
  display: inline-flex; align-items: baseline; gap: 10px;
}
.hub-badge {
  padding: 2px 8px; border-radius: 3px; font-size: 10px; font-weight: 600;
  letter-spacing: 0.08em; text-transform: uppercase;
}
.hub-badge.yes { background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); }
.hub-badge.no  { background: var(--bg); color: var(--muted); border: 1px solid var(--border); }
.site-region {
  font-size: 11px; color: var(--muted);
  font-family: ui-monospace, monospace;
  letter-spacing: 0.04em;
}
.site-stats { display: flex; gap: 18px; flex-shrink: 0; }
.stat { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; }
.stat-num {
  font-size: 14px; font-weight: 600; color: var(--text);
  font-feature-settings: "tnum"; letter-spacing: -0.01em;
}
/* R158.14 — .stat-error 配色删除: 健康度暂未接入, site-header 不显示异常 stat. */
.stat-label {
  font-size: 10px; color: var(--muted);
  letter-spacing: 0.06em; font-weight: 500;
}

/* ===== DC block ======================================================== */
.dc-block { border-top: 1px solid var(--border); }
.dc-block:first-child { border-top: 0; }
.dc-header {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 16px;
  background: var(--panel);
  font-size: 13px;
}
.dc-name {
  font-family: ui-monospace, "SF Mono", monospace;
  font-weight: 600; font-size: 13px; color: var(--text);
  letter-spacing: 0.02em;
}
.dc-roles-inline { display: inline-flex; flex-wrap: wrap; gap: 3px; }
.role-badge {
  font-size: 10px; padding: 1px 6px; border-radius: 3px;
  font-family: ui-monospace, monospace; letter-spacing: 0.04em; font-weight: 500;
}
.role-badge.fsmo {
  background: color-mix(in srgb, var(--green) 10%, transparent); color: var(--green);
  border: 1px solid color-mix(in srgb, var(--green) 30%, transparent);
}
.role-badge.bridgehead {
  background: rgba(14, 116, 144, 0.18); color: var(--bridgehead-bg);
  border: 1px solid rgba(14, 116, 144, 0.4); font-weight: 600;
}
.dc-os-inline {
  color: var(--muted); font-size: 11px;
  font-family: ui-monospace, monospace;
}
.dc-partner-count {
  margin-left: auto;
  color: var(--muted); font-size: 11px;
  font-feature-settings: "tnum"; letter-spacing: 0.02em;
}

/* ===== Partner matrix ================================================== */
.matrix { border-collapse: collapse; background: var(--panel); width: 100%; }
.matrix th, .matrix td {
  padding: 9px 12px; text-align: left; font-size: 13px;
  color: var(--text); vertical-align: middle;
  border-top: 1px solid rgba(51, 65, 81, 0.4);
}
/* R158.103.1.1 (2026-10-15) — table-layout: fixed + 列 width 显式百分比.
   修"列没对齐": 默认 auto 模式下列宽按内容长度分配, 沈阳#1 DC header
   silent-badge 2s pulse 动画 + 长 dc name (KDLCDWHADSRV1 13 字符) 让该
   section 表格 thead 重新分配列宽, 跟上面正常 section 对不齐. fixed
   模式下列宽跟内容脱钩, 跨 section 一致. 跟 R158.77.2 #2 "跨 fleet 1:1
   平行" 跟 R158.86.6 enumerate 跨 runtime 一致. 8 列 width 加起来 = 100%
   (caret 36px 跟 ops 96px 是 px, 不算入百分比). */
.matrix { table-layout: fixed; }
.matrix th:nth-child(1), .matrix td:nth-child(1) { width: 36px; }       /* caret */
.matrix th:nth-child(2), .matrix td:nth-child(2) { width: 8%; }        /* 类型 */
.matrix th:nth-child(3), .matrix td:nth-child(3) { width: 18%; }       /* 伙伴站点 */
.matrix th:nth-child(4), .matrix td:nth-child(4) { width: 18%; }       /* 伙伴 DC */
.matrix th:nth-child(5), .matrix td:nth-child(5) { width: 14%; }       /* 当前状态 */
.matrix th:nth-child(6), .matrix td:nth-child(6) { width: 16%; }       /* 上报 agent */
.matrix th:nth-child(7), .matrix td:nth-child(7) { width: 18%; }       /* 上次检测时间 */
.matrix th:nth-child(8), .matrix td:nth-child(8) { width: 110px; }   /* R158.103.2 — 96→110, 跟 .ops-col 1:1 平行, 跨 section 一致 */      /* 操作 */
.matrix td.peer-dc, .matrix td.reporter-agent-col, .matrix td.last-success-cell {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.matrix tbody tr:first-child td { border-top: 0; }
.matrix th {
  background: var(--panel-alt); color: var(--muted); font-size: 10px; font-weight: 600;
  letter-spacing: 0.10em; text-transform: uppercase;
  padding: 8px 12px; border-top: 0;
  font-family: ui-monospace, monospace;
}
.partner-row td { transition: background-color 0.1s ease; }
.partner-row:hover td { background: var(--panel-alt); }
/* Subtle 2px left edge tint signals row severity without flooding the
  whole row with color. */
.partner-row td:first-child {
  border-left: 2px solid transparent;
  padding-left: 10px;
}
/* R158.14 — 替换 status-warn / -err 左侧色条: 健康度字段暂未接入, 统一灰色. */
.partner-row.status-none  td:first-child { border-left-color: var(--muted); }
/* R158.15 — probe 包落地后, 行级严重度色条按 probeState 渲染.
   与 status-pill-* 配套, 行级用 2px 边框 + 5% 底色叠加, 不抢 pill 视觉. */
.partner-row.status-ok    td:first-child { border-left-color: var(--green); }
.partner-row.status-warn  td:first-child { border-left-color: var(--yellow); }
.partner-row.status-err   td:first-child { border-left-color: var(--red); }
.partner-row.status-ok    { background: color-mix(in srgb, var(--green)  4%, transparent); }
.partner-row.status-warn  { background: color-mix(in srgb, var(--yellow) 6%, transparent); }
.partner-row.status-err   { background: color-mix(in srgb, var(--red)    6%, transparent); }

.caret-col { width: 36px; padding: 4px 8px; text-align: center; }
.caret-btn {
  background: transparent; border: 1px solid var(--border); border-radius: 3px;
  width: 26px; height: 22px; padding: 0; cursor: pointer; color: var(--muted);
  font-size: 11px; line-height: 1; transition: all 0.1s ease;
}
.caret-btn:hover { background: var(--panel-alt); color: var(--accent); border-color: var(--accent); }
.caret-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.last-success-col { min-width: 150px; }
.last-success-cell {
  color: var(--muted); font-family: ui-monospace, monospace; font-size: 11px;
  white-space: nowrap; font-feature-settings: "tnum";
}
/* R158.17.4 (2026-10-01) — "上报 agent" 列. 跟 .last-success-cell
   同样 ui-monospace 11px 让 OL 表格统一长. 空 cell 由 || '—'
   兜底 (var(--muted)). 跟 PartnerPortHealthView 的 .agent-col
   同一视觉风格, 两个页面表头风格一致. */
.reporter-agent-col {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  white-space: nowrap;
  color: var(--text);
}
.no-probe { color: var(--muted); opacity: 0.6; font-style: italic; }
.peer-dc { font-family: ui-monospace, monospace; font-size: 12px; }
.peer-site { font-weight: 500; }
.hub-mini {
  font-size: 9px; padding: 1px 5px; margin-left: 6px; border-radius: 2px;
  background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent);
  letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600;
}
.peer-tag {
  display: inline-block; font-size: 10px; padding: 1px 7px; border-radius: 2px;
  font-family: ui-monospace, monospace; font-weight: 600; letter-spacing: 0.06em;
  text-transform: uppercase;
}
.peer-tag-within {
  background: var(--panel-alt); color: var(--muted);
  border: 1px solid var(--border);
}
.peer-tag-bridgehead {
  background: rgba(14, 116, 144, 0.18); color: var(--bridgehead-bg);
  border: 1px solid rgba(14, 116, 144, 0.4);
}
.peer-tag-unknown {
  background: var(--panel-alt); color: var(--muted);
}

/* ===== Status pill ===================================================== */
.status-pill {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 10px; padding: 2px 8px; border-radius: 2px;
  font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
  font-family: ui-monospace, monospace;
  cursor: default;
}
.status-pill::before {
  content: ''; display: inline-block;
  width: 5px; height: 5px; border-radius: 50%;
}
/* R158.15 — probe 包已落地, 三态渲染 (success/error/partial), 'none'
   保留为灰色占位. 复用 var(--green/yellow/red/muted) 跟 R137 design
   system 一致. */
.status-pill-none {
  background: color-mix(in srgb, var(--muted) 14%, transparent);
  color: var(--muted);
  border: 1px solid color-mix(in srgb, var(--muted) 32%, transparent);
}
.status-pill-none::before { background: var(--muted); }
.status-pill-ok {
  background: color-mix(in srgb, var(--green) 18%, transparent);
  color: var(--green);
  border: 1px solid color-mix(in srgb, var(--green) 38%, transparent);
}
.status-pill-ok::before { background: var(--green); }
.status-pill-warn {
  background: color-mix(in srgb, var(--yellow) 20%, transparent);
  color: var(--yellow);
  border: 1px solid color-mix(in srgb, var(--yellow) 40%, transparent);
}
.status-pill-warn::before { background: var(--yellow); }
.status-pill-err {
  background: color-mix(in srgb, var(--red) 18%, transparent);
  color: var(--red);
  border: 1px solid color-mix(in srgb, var(--red) 38%, transparent);
}
.status-pill-err::before { background: var(--red); }

/* R158.103.1 (2026-10-15) — silent reporter 标红三件套 (浅红 8% 背景
   + 红 2px 左侧条 + 红 pill "探针未运行" + DC header 闪动 badge). 必须
   声明在 .status-ok/-err/-warn/-none 之后才能赢 specificity (同级单
   class 后声明胜). 跟 err 同配色但场景不同: err=复制失败, silent=
   探针包没跑 (沈阳#1 4h 没跑时显). */
.partner-row.status-silent { background: color-mix(in srgb, var(--red) 8%, transparent); }
.partner-row.status-silent td:first-child { border-left-color: var(--red); }
.status-pill-silent {
  background: color-mix(in srgb, var(--red) 18%, transparent);
  color: var(--red);
  border: 1px solid color-mix(in srgb, var(--red) 38%, transparent);
  font-weight: 600;
}
.status-pill-silent::before { background: var(--red); }
.silent-badge {
  display: inline-block; margin-left: 8px; padding: 2px 8px;
  background: color-mix(in srgb, var(--red) 18%, transparent);
  color: var(--red);
  border: 1px solid color-mix(in srgb, var(--red) 38%, transparent);
  border-radius: 3px; font-size: 11px; font-weight: 600;
  white-space: nowrap;  /* R158.103.1.1 — 防止换行把 header 撑高 */
  animation: silent-pulse 2s ease-in-out infinite;
}
@keyframes silent-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

/* ===== Attempts (history) ============================================== */
.attempts-row td {
  background: var(--bg); padding: 0;
  border-top: 1px solid var(--border);
}
.attempts-container { padding: 14px 18px 16px; }
/* R158.14 — err-banner 删除: 健康度暂未接入, 错误信息概念不适用.
   24h history (attempts-table) 仍展示, 走 /pair-history endpoint. */
.attempts-table { width: 100%; border-collapse: collapse; }
.attempts-table th, .attempts-table td {
  border: 0; border-top: 1px solid rgba(51, 65, 81, 0.3);
  padding: 5px 8px; text-align: left; font-size: 11px;
  font-family: ui-monospace, monospace; font-feature-settings: "tnum";
}
.attempts-table th {
  background: transparent; color: var(--muted); font-weight: 600;
  font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase;
  padding: 4px 8px; border-top: 0;
}
.attempts-table tbody tr:first-child td { border-top: 1px solid var(--border); }
.att-row-ok   { color: var(--text); }
.att-row-warn { color: var(--text); }
.att-row-err  { color: var(--text); }
.att-row .glyph {
  font-family: ui-monospace, monospace; font-weight: 700; margin-right: 4px;
  display: inline-block; width: 8px;
}
.att-row-ok   .glyph { color: var(--green); }
.att-row-warn .glyph { color: var(--yellow); }
.att-row-err  .glyph { color: var(--red); }
.empty-row { color: var(--muted); padding: 18px; text-align: center; font-size: 12px; }

/* ===== R158.103.2 (2026-10-15) — 复制状态概览 "明细" drawer ===== */
/* 跟 R158.100.A .email-history-drawer 1:1 平行: 50% 宽 + min 480px +
   z-index 200 + 左侧 box-shadow, 无 mask overlay. 类名 site-replication
   跟 email-history 隔离, scoped style 各自维护. 7 列表格 + 失败行红底
   高亮 + em-cell 全文 (max 49 字符已截, 不省略, operator 一眼看到
   "LastReplicationSuccess older than 7 days (155515)"). */
.site-replication-drawer {
  position: fixed; inset: 0 0 0 auto; width: 50%; min-width: 480px;
  background: var(--panel); border-left: 1px solid var(--border);
  padding: 20px; overflow: auto; z-index: 200;
  box-shadow: -2px 0 8px var(--modal-backdrop);
}
.site-replication-drawer-body header {
  display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;
}
.site-replication-drawer-body h3 { margin: 0; font-size: 16px; display: flex; align-items: center; gap: 8px; }
.site-replication-drawer-body h3 small { color: var(--muted); font-size: 12px; margin-left: 4px; font-weight: normal; }
.site-replication-drawer-body .close {
  background: transparent; color: var(--text); border: none; font-size: 24px; cursor: pointer; line-height: 1;
}
.site-replication-drawer-body .muted { color: var(--muted); padding: 8px 0; font-size: 13px; }
.site-replication-drawer-body .error { color: var(--red); padding: 8px 0; font-size: 13px; }
.site-replication-drawer-body .site-replication-drawer-table {
  width: 100%; border-collapse: collapse; margin-top: 8px;
}
.site-replication-drawer-body .site-replication-drawer-table th,
.site-replication-drawer-body .site-replication-drawer-table td {
  border-top: 1px solid var(--border); padding: 6px 8px;
  font-size: 12px; text-align: left; font-family: ui-monospace, monospace;
  font-feature-settings: "tnum";
}
.site-replication-drawer-body .site-replication-drawer-table th {
  background: transparent; color: var(--muted); font-weight: 600;
  font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
}
.site-replication-drawer-body .site-replication-drawer-table tbody tr:first-child td { border-top: 1px solid var(--border); }
.site-replication-drawer-body .detail-row .glyph {
  font-weight: 700; margin-right: 4px; display: inline-block; width: 10px;
}
.site-replication-drawer-body .detail-row-ok   .glyph { color: var(--green); }
.site-replication-drawer-body .detail-row-warn .glyph { color: var(--yellow); }
.site-replication-drawer-body .detail-row-err  .glyph { color: var(--red); }
.site-replication-drawer-body .detail-row-has-err td {
  background: color-mix(in srgb, var(--red) 8%, transparent);
}
.site-replication-drawer-body .detail-row-has-err .em-cell {
  color: var(--red); font-weight: 600;
}
.site-replication-drawer-body .em-cell {
  word-break: break-all; white-space: pre-wrap; max-width: 320px;
}

/* ===== R158.Suppression (2026-10-15) — 行级暂停/恢复告警 toggle ===== */
.ops-col { width: 110px; }   /* R158.103.2 — 96→110, 因 .detail-btn + .pause-btn 上下排, table-layout:fixed 跨 section 1:1 平行 (跟 R158.103.1.1 不冲突) */
.ops-cell { text-align: center; padding: 6px 8px; }
/* R158.Suppression UX fix (2026-10-15) — pause-btn 用 muted 灰底灰字 10px uppercase
   在表格里几乎隐形, 操作员扫一眼当成 placeholder 跳过. 修复: 12px + 实心 + 边框 +
   蓝/红强对比, 一眼可见. status-pill 形态保留但放大. */
.pause-btn,
.resume-btn {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 12px; padding: 4px 12px; border-radius: 3px;
  font-weight: 700; letter-spacing: 0.04em;
  font-family: inherit;
  cursor: pointer; transition: all 0.1s ease;
  line-height: 1.4;
  min-width: 80px; justify-content: center;
}
.pause-btn {
  background: #ffffff;
  color: #2563eb;
  border: 1.5px solid #2563eb;
}
.pause-btn:hover {
  background: #2563eb;
  color: #ffffff;
}
.pause-btn:focus-visible { outline: 2px solid #2563eb; outline-offset: 1px; }
.resume-btn {
  background: #dc2626;
  color: #ffffff;
  border: 1.5px solid #dc2626;
}
.resume-btn:hover {
  background: #b91c1c;
  border-color: #b91c1c;
}
.resume-btn .dot {
  display: inline-block; width: 6px; height: 6px;
  background: #ffffff; border-radius: 50%;
  animation: pulse 1.2s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
.resume-btn:hover {
  background: color-mix(in srgb, var(--red) 28%, transparent);
  border-color: color-mix(in srgb, var(--red) 50%, transparent);
}
.resume-btn:focus-visible { outline: 2px solid var(--red); outline-offset: 1px; }
/* 已暂停 dot 前缀, 跟 .status-pill::before 同 idiom */
.resume-btn .dot {
  display: inline-block;
  width: 5px; height: 5px; border-radius: 50%;
  background: var(--red);
  box-shadow: 0 0 4px color-mix(in srgb, var(--red) 60%, transparent);
}

/* R158.103.2 (2026-10-15) — 操作列 "明细" 按钮, 跟 pause-btn / resume-btn
   1:1 平行: 12px + 实心 + 边框 + min-width, 但配色用绿 (跟 R47
   port-health probe 范式 1:1 平行, 跟 toggle 灰/红区分). 上下排
   (跟 pause-btn 同 ops-cell), margin-top: 4px. 跟 R158.103.1 silent
   配色 family 不同, 防止"红色=出错"信号被弱化. */
.detail-btn {
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 12px; padding: 4px 12px; border-radius: 3px;
  font-weight: 600; letter-spacing: 0.04em;
  font-family: inherit;
  cursor: pointer; transition: all 0.1s ease;
  line-height: 1.4;
  min-width: 60px;
  margin-top: 4px;
  background: #ffffff;
  color: #059669;
  border: 1.5px solid #059669;
}
.detail-btn:hover {
  background: #059669;
  color: #ffffff;
}
.detail-btn:focus-visible { outline: 2px solid #059669; outline-offset: 1px; }
</style>