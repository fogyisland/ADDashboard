<!--
  包执行状态监控 — R67-T2 (2026-08-30) + R158.50.7 (2026-10-07)

  Operator directive "监控指标点进去就进入包管理状态, 我们是否可以监控包
  执行状态呢?" — pure-read 监控指标 surface.

  R158.50.7 redesign:
    - Default: cards in 3×2 grid ONLY show summary pill + last-run ts.
      No recent-runs table inline (was too dense).
    - Click any card to open a right-side detail panel showing the full
      recent-runs list (top 30) with proper truncation. Click any row to
      open a second detail view showing full stdout/stderr/error without
      truncation.
    - The error/stdout/stderr text is rendered in monospace with wrap so
      operators see parse-error file paths and runtime exception messages
      end-to-end (was: 60-char preview hidden in a tiny code tag).

  Data sources: same as before — /api/dashboard/packages-runs (no change
  to backend). The endpoint already returns stdoutPreview/stderrPreview/error
  per run; we just don't blow up the card anymore.
-->
<template>
  <AppLayout>
    <header class="page-header">
      <div class="page-titles">
        <h2 class="page-title">包</h2>
        <p class="subtitle">最近 {{ windowLabel }} 执行汇总 · 卡片默认仅显示汇总,点开查看明细 · 每 {{ refreshSeconds }} 秒自动刷新</p>
      </div>
      <!--
        R158.76 (2026-10-11) — 24h / 7d / 全部 时间切片器. 复用 R158.71.1
        segmented button 配色 (white active + accent blue + box-shadow),
        不引新 color token. operator 切换后即时重 fetch, 卡片 summary +
        drawer 副标题同步更新. "全部" 实际 = retention 上限
        (system_config.package_runs_retention_days, 默认 10 天), 跟
        package-runs-retention.js 单源.
      -->
      <div class="page-window-control" data-test="window-control">
        <button
          v-for="opt in WINDOW_OPTIONS"
          :key="opt.value"
          type="button"
          :class="['window-btn', windowMode === opt.value ? 'is-active' : '']"
          :data-test="`window-btn-${opt.value}`"
          @click="setWindow(opt.value)"
        >{{ opt.label }}</button>
      </div>
      <div class="page-meta">
        <span class="time" v-if="lastLoadedAt">{{ fmt(lastLoadedAt) }}</span>
        <span class="dot" :class="polling ? 'on' : 'off'" aria-hidden="true"></span>
      </div>
    </header>

    <div v-if="error" class="error-banner" data-test="error-banner">{{ error }}</div>

    <div v-if="!packages.length && !error" class="empty" data-test="empty">
      暂无包 — 请在后台 /admin/packages 上传脚本
    </div>

    <!--
      包执行时间线 (R158.X+UI) — Flavour A 单实例 ECharts. 复用现有
      /api/dashboard/packages-runs 数据, 0 改后端. 点下方任一包卡片 →
      packagesFilter 锁定该包 → 折线图只显该包 1 条线. 再次点同一卡片
      或点"显示全部" → 取消筛选, 14 条线全显. 跟现有 card click 1:1
      平行, 不动 drawer / pill 行为.
    -->
    <!--
      R158.X+UI.lazy (2026-10-20) — pointerenter/focusin 触发 activateTimeline().
      悬停或键盘 focus 图表区域都视为"操作员要看这张图", 立即补齐完整
      timeline 数据. tabindex="0" 让键盘用户也能命中 (无障碍).
      250ms trailing debounce 在 activateTimeline() 内, 鼠标划过不重复打.
    -->
    <div
      v-if="packages.length"
      class="timeline-chart-card"
      data-test="timeline-chart-card"
      tabindex="0"
      @pointerenter="activateTimeline"
      @focusin="activateTimeline"
    >
      <header class="timeline-chart-header">
        <h3 class="timeline-chart-title">包执行时间线</h3>
        <div class="timeline-chart-legend">
          <span
            v-for="p in (packagesFilter ? filteredTimelinePackages : allTimelinePackages)"
            :key="p.name"
            class="legend-item"
          >
            <span class="legend-dot" :style="{ background: p.color }"></span>
            <span class="legend-name">{{ p.name }}</span>
            <span class="legend-count">{{ p.runCount }}</span>
          </span>
          <button
            v-if="packagesFilter"
            type="button"
            class="legend-clear-btn"
            data-test="timeline-clear-filter"
            @click="clearTimelineFilter"
          >显示全部</button>
        </div>
      </header>
      <div ref="timelineChartEl" class="timeline-chart-canvas" data-test="timeline-chart"></div>
      <p v-if="!timelineHasData" class="timeline-chart-empty">{{ timelineEmptyMessage }}</p>
    </div>

    <div v-if="packages.length" class="card-grid" data-test="card-grid">
      <article
        v-for="p in packages"
        :key="p.name"
        :class="['card', `card-${statusClass(p)}`, selectedPackage?.name === p.name ? 'is-selected' : '', packagesFilter === p.name ? 'is-timeline-filtered' : '']"
        :data-test="`card-${p.name}`"
        @click="selectPackage(p); toggleTimelineFilter(p.name);"
      >
        <header class="card-header">
          <div class="card-title">
            <h3 class="card-name">{{ p.name }}</h3>
            <span class="card-version">v{{ p.version || '—' }}</span>
            <!--
              R158.60.7-ext — operator "他们应该一致. 一致修复" — 把 R158.60.4/60.6/60.7
              的圆形 On-demand badge 也加到 /packages-runs 这视图, 跟 /admin/packages
              视觉一致. 4 个 on-demand 包: ad_ad_groups_write / ad_ad_users_write /
              ad_ad_object_move / ad_ad_ou_create (R158.56c-d ship, type=command).
            -->
            <span
              v-if="isOndemand(p.name)"
              class="ondemand-badge"
              :data-test="`ondemand-badge-${p.name}`"
              title="无自动调度周期, 仅通过手动触发"
            >ondemand</span>
          </div>
          <span
            :class="['status-pill', `pill-${statusClass(p)}`, 'pill-clickable']"
            :data-test="`pill-${p.name}`"
            role="button"
            tabindex="0"
            :title="statusPillHint(statusClass(p))"
            @click.stop="selectPackage(p, statusClass(p))"
            @keydown.enter.stop="selectPackage(p, statusClass(p))"
            @keydown.space.stop.prevent="selectPackage(p, statusClass(p))"
          >
            {{ statusLabel(p) }}
          </span>
        </header>

        <p class="card-desc" :data-test="`desc-${p.name}`">{{ descriptionLabel(p.name, p.description, p.type) }}</p>
        <!--
          R158.72.x.6-ext (2026-10-16) — 卡片下方 cadence 行, 跟
          /admin/packages/schedule (R158.72.x.6) 1:1 平行. 操作员 directive
          "另外加入执行周期说明". dict 1:1 重写 14 包, fallback 走
          fallbackCadence (含 ad_account_change 中心端 cron + Jitter).
        -->
        <p class="card-cadence" :data-test="`cadence-${p.name}`">⏱ {{ cadenceLabel(p.name) }}</p>

        <div class="card-meta">
          <span class="meta-row">
            <span class="meta-label">类型</span>
            <span class="meta-value">{{ typeLabel(p.type) }}</span>
          </span>
          <span class="meta-row">
            <span class="meta-label">服务器类型</span>
            <span class="meta-value">{{ agentTypeLabel(p.agentType) }}</span>
          </span>
        </div>

        <div class="summary" :data-test="`summary-${p.name}`">
          <span class="summary-item">
            <span class="summary-num summary-success">{{ p.summary24h.success }}</span>
            <span class="summary-label">成功</span>
          </span>
          <span class="summary-item">
            <span class="summary-num summary-failure">{{ p.summary24h.failure }}</span>
            <span class="summary-label">失败</span>
          </span>
          <span class="summary-item">
            <span class="summary-num summary-partial">{{ p.summary24h.partial }}</span>
            <span class="summary-label">部分</span>
          </span>
          <span class="summary-item summary-divider"></span>
          <span class="summary-item">
            <span class="summary-num">{{ p.summary24h.total }}</span>
            <span class="summary-label">总计</span>
          </span>
          <span class="summary-item summary-spacer"></span>
          <span class="summary-item">
            <span class="summary-label">最近执行</span>
            <span class="summary-value">{{ p.summary24h.lastRunAt ? fmt(p.summary24h.lastRunAt) : '—' }}</span>
          </span>
        </div>

        <div class="card-footer">
          <span class="card-hint">点击查看最近 {{ p.recent.length }} 次执行明细 →</span>
        </div>
      </article>
    </div>

    <!--
      R158.50.7 — detail side-panel. Two levels:
        1. PackageListPanel: lists recent runs (top 30) of the clicked
           package. Click any row to drill into RunDetailPanel.
        2. RunDetailPanel: full stdout/stderr/error for one run, no
           truncation. Monospace <pre> blocks. Operator closes via Esc /
           close button / overlay click.
      The panel uses a flex-drawer (translateX-100% → translateX-0) so
      the cards behind stay readable for context.
    -->
    <transition name="drawer">
      <aside
        v-if="selectedPackage"
        class="drawer"
        role="complementary"
        :data-test="`drawer-${selectedPackage.name}`"
      >
        <header class="drawer-header">
          <div class="drawer-titles">
            <h3 class="drawer-title">
              {{ selectedPackage.name }}
              <span class="drawer-version">v{{ selectedPackage.version || '—' }}</span>
              <!--
                R158.60.7-ext — drawer view 也显同款圆形 On-demand badge,
                跟主 card-grid 一致
              -->
              <span
                v-if="isOndemand(selectedPackage.name)"
                class="ondemand-badge"
                :data-test="`ondemand-badge-drawer-${selectedPackage.name}`"
                title="无自动调度周期, 仅通过手动触发"
              >ondemand</span>
            </h3>
            <p class="drawer-subtitle">{{ statusLabel(selectedPackage) }} · 最近 {{ windowLabel }} · 描述: {{ descriptionLabel(selectedPackage.name, selectedPackage.description, selectedPackage.type) }}</p>
            <!--
              R158.72.x.6-ext — drawer subtitle 也显 cadence 1 行, 跟主
              卡片 grid + schedule view 1:1 平行. 一致修复.
            -->
            <p class="drawer-cadence">⏱ {{ cadenceLabel(selectedPackage.name) }}</p>
          </div>
          <button class="drawer-close" type="button" @click="closeDrawer" aria-label="关闭">✕</button>
        </header>

        <!-- Level 1: list view (default). -->
        <section v-if="!selectedRun" class="drawer-body" :data-test="`runlist-${selectedPackage.name}`">
          <h4 class="drawer-h4">最近 {{ selectedPackage.recent.length }} 次执行 · 点行查看完整 stdout / stderr</h4>
          <!--
            R158.95-ext (2026-10-16) — drawer 顶部 list limit 切档. 操作员
            directive "右边不再固定 10 行最新, 而是全部的". 默认 10 行
            (R67-T2 + R158.17.6 ship 后行为不变), "全部" = endpoint
            safeLimit 上限 1000. 跟 window 切档 chip + run-filter chip
            同 .page-window-control 配色 1:1 平行 (0 引新 color token).
          -->
          <div class="list-limit" data-test="list-limit">
            <span class="list-limit-label">显示行数</span>
            <button
              v-for="opt in LIST_LIMIT_OPTIONS"
              :key="opt.value"
              type="button"
              :class="['list-limit-btn', listLimit === opt.value ? 'is-active' : '']"
              :data-test="`list-limit-${opt.value}`"
              @click="setListLimit(opt.value)"
            >{{ opt.label }}</button>
          </div>
          <!--
            R158.95-ext (2026-10-16) — 操作员 directive "点击那个文字的时候进行筛选".
            drawer 顶部 1 行 chip 让用户切全部 / 失败 / 部分 / 成功. pill
            触发 selectPackage(p, statusClass(p)) 会把 drawerRunFilter 预置
            到该档. 跟 R158.76 window segmented button 1:1 平行 (segmented
            配色 white active + accent + box-shadow), 0 引新 color token.
            chip filter 行数 0 影响 L1 list (sticky 走 top, 自动占 row).
          -->
          <div class="run-filter" role="tablist" data-test="run-filter">
            <button
              v-for="opt in FILTER_CHIPS"
              :key="opt.value || 'all'"
              type="button"
              role="tab"
              :class="['run-filter-btn', drawerRunFilter === opt.value ? 'is-active' : '']"
              :data-test="`run-filter-${opt.value || 'all'}`"
              @click="drawerRunFilter = opt.value"
            >{{ opt.label }}<span
              v-if="opt.value"
              class="run-filter-count"
              :data-test="`run-filter-count-${opt.value}`"
            >{{ selectedPackage.recent.filter((r) => runClass(r) === opt.value).length }}</span></button>
          </div>
          <table class="recent-table">
            <thead>
              <tr>
                <th class="col-time">开始</th>
                <th class="col-agent">执行服务器</th>
                <th class="col-ver">版本</th>
                <th class="col-status">结果</th>
                <th class="col-dur">耗时</th>
                <th class="col-err">错误/输出</th>
              </tr>
            </thead>
            <tbody>
              <!--
                R158.95-ext — v-for 从 selectedPackage.recent 切到 visibleRecent
                computed. 0 改 row markup, 0 改 :key, 0 改 row class. 切档只是
                L1 list 行的子集, 颜色 / 渲染 / L2 drill-in 全不变.
              -->
              <tr
                v-for="r in visibleRecent"
                :key="r.id"
                :class="['recent-row', `recent-${runClass(r)}`]"
                :data-test="`runrow-${r.id}`"
                @click="selectRun(r)"
              >
                <td class="col-time">{{ shortTime(r.startedAt) }}</td>
                <td class="col-agent">{{ r.agentId }}</td>
                <td class="col-ver">
                  <span :class="['run-version', r.scriptVersion && r.scriptVersion !== selectedPackage.version ? 'is-stale' : '']">
                    v{{ r.scriptVersion || '—' }}
                  </span>
                </td>
                <td class="col-status">
                  <span :class="['run-glyph', `run-${runClass(r)}`]">{{ runGlyph(r) }}</span>
                  <span class="run-label">{{ runLabel(r) }}</span>
                </td>
                <td class="col-dur">{{ r.durationMs != null ? `${r.durationMs}ms` : '—' }}</td>
                <td class="col-err-list">
                  <!--
                    Priority 2026-10-08 R158.50.7g (operator feedback):
                      Colour by `runClass(r)` (server-evaluated status), not
                      by `error` field alone. Pre-fix, every ad_lockout_list
                      row rendered red because R158.50.6 promoted PS1 stderr
                      headers into `error`. The status field now distinguishes:
                        - failed → error / stderrPreview → red code
                        - partial → error / stderrPreview → yellow warn code
                        - success → stdoutPreview → grey raw JSON
                        - running → '—' (no terminal state yet)
                  -->
                  <code v-if="runClass(r) === 'err' && r.error" class="error" :title="r.error" :data-test="`err-error-${r.id}`">{{ truncate(r.error, 200) }}</code>
                  <code v-else-if="runClass(r) === 'err' && r.stderrPreview" class="error" :title="r.stderrPreview" :data-test="`err-stderr-${r.id}`">{{ truncate(r.stderrPreview, 200) }}</code>
                  <code v-else-if="runClass(r) === 'warn' && r.error" class="warn" :title="r.error" :data-test="`err-warn-${r.id}`">{{ truncate(r.error, 200) }}</code>
                  <code v-else-if="metricsWarning(r)" class="warn" :title="metricsWarning(r)" :data-test="`err-warn-${r.id}`">{{ metricsWarning(r) }}</code>
                  <code v-else-if="r.stdoutPreview" class="stdout" :title="r.stdoutPreview" :data-test="`err-stdout-${r.id}`">{{ truncate(r.stdoutPreview, 200) }}</code>
                  <span v-else :data-test="`err-empty-${r.id}`">—</span>
                </td>
              </tr>
            </tbody>
          </table>
          <!--
            R158.95-ext — 过滤后空状态. 让用户切档看到 0 行不困惑, 提示切回"全部".
            0 引 modal / 0 用现有 .empty (那是 grid 级, 不是 drawer body 级),
            7 列 colspan + 黄色 hint 1:1 跟 R158.X 字段空状态同步.
          -->
          <div
            v-if="drawerRunFilter && visibleRecent.length === 0 && selectedPackage.recent.length > 0"
            class="run-filter-empty"
            :data-test="`run-filter-empty-${drawerRunFilter}`"
          >当前筛选无匹配行, <button type="button" class="run-filter-reset" @click="drawerRunFilter = ''">点此切回全部</button></div>
          <div
            v-else-if="visibleRecent.length === 0 && selectedPackage.recent.length === 0"
            class="run-filter-empty"
          >此包暂无任何执行记录</div>
        </section>

        <!-- Level 2: detail view of one run. -->
        <section v-else class="drawer-body" :data-test="`rundetail-${selectedRun.id}`">
          <button class="back-btn" type="button" @click="selectedRun = null">← 返回列表</button>
          <h4 class="drawer-h4">
            <span :class="['run-glyph', `run-${runClass(selectedRun)}`]">{{ runGlyph(selectedRun) }}</span>
            {{ selectedRun.agentId }} · v{{ selectedRun.scriptVersion || '—' }} · exit {{ selectedRun.exitCode }} · {{ shortTime(selectedRun.startedAt) }}
          </h4>

          <section class="detail-block">
            <header class="detail-h">错误摘要</header>
            <pre v-if="selectedRun.error" class="detail-pre detail-error">{{ selectedRun.error }}</pre>
            <pre v-else class="detail-pre detail-empty">无错误摘要 (多见于执行成功的记录)</pre>
          </section>

          <!--
            R158.50.7b — 2026-10-07 — operator "✓成功 + error_code:1 矛盾"
            误读。L2 detail 显式拆 metrics JSON,让 operator 看 exitCode=0
            但 metrics.error_code>0 的 PS1 partial-failure fingerprint。
            永远渲染,即使 ec=0 也明确显示 "metrics 无内部错误" — 比 stdout
            preview 自己看 JSON 友好。
          -->
          <section class="detail-block">
            <header class="detail-h">采集指标</header>
            <div class="detail-metrics" :data-test="`rundetail-metrics-${selectedRun.id}`">
              <div class="metric-row">
                <span class="metric-label">metrics.error_code</span>
                <code :class="['metric-val', metricsErrorCode(selectedRun) > 0 ? 'metric-warn' : 'metric-ok']">
                  {{ metricsErrorCode(selectedRun) }}
                </code>
                <span class="metric-hint">{{ metricsErrorCodeHint(selectedRun) }}</span>
              </div>
              <div class="metric-row">
                <span class="metric-label">metrics.events / event_count</span>
                <code>{{ metricsEventsCount(selectedRun) }}</code>
              </div>
            </div>
          </section>

          <section class="detail-block">
            <header class="detail-h">stderr ({{ (selectedRun.stderrPreview || '').length }} 字符, 最多 2KB 截断)</header>
            <pre v-if="selectedRun.stderrPreview" class="detail-pre">{{ selectedRun.stderrPreview }}</pre>
            <pre v-else class="detail-pre detail-empty">无 stderr</pre>
          </section>

          <section class="detail-block">
            <header class="detail-h">stdout ({{ (selectedRun.stdoutPreview || '').length }} 字符, 最多 2KB 截断)</header>
            <pre v-if="selectedRun.stdoutPreview" class="detail-pre">{{ selectedRun.stdoutPreview }}</pre>
            <pre v-else class="detail-pre detail-empty">无 stdout</pre>
          </section>

          <section class="detail-block detail-meta">
            <header class="detail-h">元数据</header>
            <div class="detail-meta-grid">
              <div><span class="meta-label">run id</span> <code>{{ selectedRun.id }}</code></div>
              <div><span class="meta-label">agent</span> <code>{{ selectedRun.agentId }}</code></div>
              <div><span class="meta-label">package</span> <code>{{ selectedPackage.name }}</code></div>
              <div><span class="meta-label">version</span> <code>v{{ selectedRun.scriptVersion || '—' }}</code></div>
              <div><span class="meta-label">exitCode</span> <code>{{ selectedRun.exitCode }}</code></div>
              <div><span class="meta-label">durationMs</span> <code>{{ selectedRun.durationMs ?? '—' }}</code></div>
              <div><span class="meta-label">startedAt</span> <code>{{ selectedRun.startedAt }}</code></div>
              <div><span class="meta-label">finishedAt</span> <code>{{ selectedRun.finishedAt || '—' }}</code></div>
            </div>
          </section>
        </section>
      </aside>
    </transition>
    <transition name="fade">
      <div v-if="selectedPackage" class="drawer-overlay" @click="closeDrawer"></div>
    </transition>
  </AppLayout>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import * as echarts from 'echarts';
import AppLayout from '../components/AppLayout.vue';
import { dashboardApi } from '../api/dashboard.js';
import { formatDateTime, formatDateTimeIso } from '../lib/timezone.js';

const packages = ref([]);
const refreshSeconds = ref(10);
const lastLoadedAt = ref(null);
const error = ref('');
const polling = ref(false);
const selectedPackage = ref(null);
const selectedRun = ref(null);

// === 包执行时间线 (R158.X+UI) — Flavour A 单实例 ECharts 范式 ===
// 1:1 平行 OsBaselineView.vue (R158.100.7 tagged). 折线图默认显示全部
// 14 个 AD 包, 点下方包卡片 → packagesFilter 锁定该包 → 折线图只显 1 条
// 线. 再次点同一卡片 / 点"显示全部" → 取消筛选, 14 条全显.
// 0 改后端 / 0 改 endpoint shape (复用现有 /api/dashboard/packages-runs).
const timelineChartEl = ref(null);
let timelineChartInstance = null;
const packagesFilter = ref(null); // string | null
// R158.X+UI.lazy (2026-10-20) — 折线图数据按需加载开关.
//
// 后端 timelineRecent 是 envelope 里最贵的部分 (14 包 × recentByName
// limit=1000 的 fan-out). 首屏渲染的是卡片 grid + 抽屉, 折线图虽然也在
// 首屏 (Flavour A), 但操作员大部分时间在看卡片上的 summary 数字 ——
// 为此每轮询付 14 次全量查询不划算.
//
// 策略: 首屏 includeTimeline=false (后端跳过 fan-out, timelineRecent=[]),
// buildTimelineSeries 自动落到 `pkg.recent` 兜底 (line 459) 先画一版
// 稀疏折线, 图不至于空白. 用户对图表区域产生交互 (pointerenter /
// focusin) 或点任一包卡片 (卡片本来就会 toggleTimelineFilter) 时,
// activateTimeline() 置 true 并立即重取一次带完整 timeline 的数据,
// 之后每轮询都带 —— 即"看过一次就长期保持新鲜".
const timelineActivated = ref(false);
let timelineActivationTimer = null;
const TIMELINE_PALETTE = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#06b6d4', '#84cc16',
  '#a855f7', '#eab308', '#0ea5e9', '#22c55e'
];
// buildTimelineSeries — 复用 helper, filteredTimelinePackages / allTimelinePackages
// 都走它, 唯一不同是 filterName 入参. 注意 recent[].status 后端
// R158.92 起返 'success' / 'partial' / 'failed' / 'running' / null,
// fallback 用 exitCode 推断 (老 ship 兼容).
//
// R158.X+UI.timeline (2026-10-19) — data 源从 `pkg.recent` (listLimit 切片
// 10/100/1000) 切到 `pkg.timelineRecent` (后端 envelope 新字段, 默认
// limit=1000, 24h/7d/全部 100% 闭合). 折线图需要的"24h 全量" = 1000
// 上限 (14 个 AD 包 24h cadence 上限 ≈ 96 次/包, 1000 100% 覆盖).
// 卡片 summary / 抽屉 L1 / L2 钻取仍走 `pkg.recent` (切 listLimit).
// Fallback `pkg.recent` 保留: 后端 envelope 没 timelineRecent 时 (e.g.
// 老 build 还没 ship) 仍能渲折线图, 0 破功能.
function buildTimelineSeries(pkgs, filterName) {
  if (!pkgs || pkgs.length === 0) return [];
  const filtered = filterName ? pkgs.filter(p => p.name === filterName) : pkgs;
  return filtered.map((pkg, idx) => {
    // timelineRecent 优先, recent 兜底 (老 envelope shape 兼容)
    const data = pkg.timelineRecent || pkg.recent || [];
    const points = data
      .filter(r => r.startedAt)
      .map(r => {
        // status fallback chain: r.status (R158.50.7g ship) -> r.exitCode 推断 -> 'unknown'
        const status = r.status
          || (r.exitCode === 0 ? 'success'
              : r.exitCode == null ? 'partial'
              : 'failed');
        // 错误摘要: 仅前 80 字, 失败时显示, 避免 tooltip 撑炸. R158.X+UI.tooltip
        // (2026-10-19) — 操作员 directive "tooltips 给出一些内容" 加这字段.
        const errTrim = r.error ? String(r.error).slice(0, 80) : null;
        return {
          value: [r.startedAt, r.durationMs ?? 0],
          // 元数据全挂上, ECharts formatter 读 params.data.* 渲染 tooltip
          // (R158.50.7g status + R158.17.6 agentId + R158.17.6 error 摘要).
          // AD 端 agentId === dc_name, member 端 agentId === hostname, 都直接
          // 显示即"机器" (1:1 平行 drawer 的 ${selectedRun.agentId} 渲染, line 397).
          agentId: r.agentId || null,
          status,
          exitCode: r.exitCode,
          error: errTrim
        };
      });
    return {
      name: pkg.name,
      color: TIMELINE_PALETTE[idx % TIMELINE_PALETTE.length],
      points,
      runCount: points.length
    };
  });
}
const allTimelinePackages = computed(() => buildTimelineSeries(packages.value, null));
const filteredTimelinePackages = computed(() => buildTimelineSeries(packages.value, packagesFilter.value));
const timelineHasData = computed(() => allTimelinePackages.value.some(p => p.points.length > 0));
const timelineEmptyMessage = computed(() => {
  if (!packages.value || packages.value.length === 0) return '加载中…';
  if (packagesFilter.value) {
    const pkg = packages.value.find(p => p.name === packagesFilter.value);
    return pkg ? `${pkg.name} 在所选窗口内无执行记录` : '加载中…';
  }
  return '所选窗口内无包执行记录';
});
const onTimelineResize = () => { if (timelineChartInstance) timelineChartInstance.resize(); };
function renderTimelineChart() {
  if (!timelineChartEl.value) return;
  if (!timelineHasData.value) {
    if (timelineChartInstance) {
      timelineChartInstance.dispose();
      timelineChartInstance = null;
    }
    return;
  }
  // Re-init guard (R158.100.2 6 layer template)
  if (timelineChartInstance && timelineChartInstance.getDom() !== timelineChartEl.value) {
    timelineChartInstance.dispose();
    timelineChartInstance = null;
  }
  if (!timelineChartInstance) {
    timelineChartInstance = echarts.init(timelineChartEl.value, null, { renderer: 'canvas' });
    window.addEventListener('resize', onTimelineResize);
  }
  const seriesList = packagesFilter.value
    ? filteredTimelinePackages.value
    : allTimelinePackages.value;
  const series = seriesList.map(p => ({
    name: p.name,
    type: 'line',
    data: p.points.map(pt => ({
      value: pt.value,
      // 透传元数据到 ECharts data item, formatter 读 params.data.* 渲染.
      // ECharts 把 data item 的非 value 字段保留在 data.X, 不影响绘图.
      agentId: pt.agentId,
      status: pt.status,
      exitCode: pt.exitCode,
      error: pt.error,
      itemStyle: {
        color: pt.status === 'success' ? '#10b981'
              : pt.status === 'failed'  ? '#ef4444'
              : pt.status === 'partial' ? '#f59e0b'
              : '#3b82f6' // running 或 unknown
      }
    })),
    lineStyle: { color: p.color, width: 2, opacity: 0.6 },
    itemStyle: { color: p.color },
    symbolSize: 7,
    smooth: false,
    showSymbol: true,
    emphasis: { focus: 'series' }
  }));
  const option = {
    tooltip: {
      trigger: 'item',
      formatter: (params) => {
        const v = Array.isArray(params.value) ? params.value : [null, null];
        const ts = v[0];
        const dur = v[1];
        const tsStr = ts ? formatDateTime(ts) : '—';
        // R158.X+UI.tooltip (2026-10-19) — 操作员 directive "tooltips 给出
        // 一些内容" 加 3 行: 机器 (agentId == AD dc_name / member hostname),
        // 状态 (字面 + chip-style 跟卡片 summary pill 配色 1:1 平行), 错误
        // 摘要 (前 80 字, 仅失败时显示). 0 改后端 (envelope 已有 agentId /
        // status / error), 0 改 wire shape, 0 改 member mirror endpoint
        // (member 端 agentId === hostname 直接可用).
        const d = params.data || {};
        const agentLabel = d.agentId || '—';
        const statusKey = d.status || 'unknown';
        const statusText = ({ success: '成功', failed: '失败', partial: '部分', running: '运行中' })[statusKey] || statusKey;
        const statusColor = statusKey === 'success' ? '#10b981'
                          : statusKey === 'failed'  ? '#ef4444'
                          : statusKey === 'partial' ? '#f59e0b'
                          : '#3b82f6';
        const errLine = d.error
          ? `<br/><span style="color:#ef4444">错误: ${escapeHtml(d.error)}${String(d.error).length >= 80 ? '…' : ''}</span>`
          : '';
        return `<b>${params.seriesName}</b>`
             + `<br/>机器: <code>${escapeHtml(agentLabel)}</code>`
             + `<br/>${tsStr}`
             + `<br/>耗时: ${dur != null ? dur + ' ms' : '—'}`
             + `<br/>状态: <span style="color:${statusColor};font-weight:600">${statusText}</span>`
             + errLine;
      }
    },
    xAxis: { type: 'time' },
    yAxis: {
      type: 'value',
      name: '耗时 (ms)',
      nameLocation: 'middle',
      nameGap: 40
    },
    // R158.X+UI.zoom (2026-10-19) — 折线图时段缩放. 操作员 directive
    // "在报表增加一个伸缩栏位, 确定时间段". ECharts dataZoom 双组件:
    //   - inside: 鼠标滚轮 + 框选拖拽 (默认全开, 不占视觉空间)
    //   - slider: 底部滑块条, 拖手柄精准选时段 (跟 windowMode 24h/7d/全部
    //     1:1 平行, 但精度更高: 24h 内能选 5min 粒度)
    // showDetail='true' 渲起止 label (跟 ECharts Flavour A 单实例 1:1 平行
    // OsBaselineView R158.100.7 范式). start=0/end=100 默认全显, 不改变
    // R158.X+UI.timeline 24h 全量闭合行为. zoomLock=false 双轴联动, 跟
    // xAxis type='time' auto min/max 协同. throttle=50 减少 drag 期间
    // 重渲频次. 0 改后端 / 0 改 wire / 0 改 member mirror.
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: 0,
        zoomLock: false,
        throttle: 50
      },
      {
        type: 'slider',
        xAxisIndex: 0,
        bottom: 8,
        height: 24,
        start: 0,
        end: 100,
        showDetail: true,
        handleStyle: { color: '#3b82f6', borderColor: '#1d4ed8' },
        fillerColor: 'rgba(59, 130, 246, 0.15)',
        borderColor: '#94a3b8',
        textStyle: { color: '#475569', fontSize: 11 }
      }
    ],
    series,
    legend: { show: false },
    // dataZoom slider 底部 8 + height 24 = 占 32px, 原本 bottom 60 → 80
    grid: { left: 70, right: 30, top: 20, bottom: 80 }
  };
  timelineChartInstance.setOption(option, true);
}
// toggleTimelineFilter — 点卡片切换 filter. 再次点同一 / 点清除按钮 = null.
// R158.X+UI.lazy — activateTimeline() 把折线图从"兜底稀疏模式"切到
// "完整数据模式". 只在第一次调用时真正触发 load(); 之后 timelineActivated
// 已是 true, 靠 60s 轮询自然续新, 不重复打首屏那 14 次 fan-out.
//
// 竞态护栏: 用户可能连续快速点多个卡片. 这里用一个 trailing timer 合并
// —— 250ms 内的重复激活只发一次 load(), 避免 3 次点击 = 3 个 5MB 请求.
// (跟 R158.X.99.8 claimPendingTriggers caller-side 错配同源教训:
//  谁发起谁消费, 一次意图一次请求.)
function activateTimeline() {
  if (timelineActivated.value) return;
  timelineActivated.value = true;
  if (timelineActivationTimer) clearTimeout(timelineActivationTimer);
  timelineActivationTimer = setTimeout(() => {
    timelineActivationTimer = null;
    load();
  }, 250);
}
function toggleTimelineFilter(pkgName) {
  // 点卡片 = 明确要看这个包的折线 → 先把完整 timeline 数据拉回来.
  activateTimeline();
  packagesFilter.value = packagesFilter.value === pkgName ? null : pkgName;
  nextTick(() => renderTimelineChart());
}
// clearTimelineFilter — 顶部"显示全部"按钮用.
function clearTimelineFilter() {
  packagesFilter.value = null;
  nextTick(() => renderTimelineChart());
}
// escapeHtml — tooltip 注入 HTML (ECharts formatter 默认返 HTML 字符串).
// 防 XSS: agentId / error 字段来自后端 SQL, 正常是 [A-Za-z0-9-_.], 但
// R158.X+UI.tooltip ship 时锁"前端永不信任后端字符串, 必转义".
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
// 包执行时间线 (end) ===
// R158.95-ext (2026-10-16) — drawer level-1 状态筛. 操作员 directive
// "点击那个文字的时候进行筛选" — 点击卡片 pill 进入 drawer 时按 pill 的
// 状态 (err/warn/ok/none) 预 filter; drawer 顶部一行 chip 让用户切回"全部"或
// 换另一档. 前端 derived state, 0 改 endpoint / 0 改 wire (跟 R158.76
// 24h/7d/全部 时间切片器 1:1 平行, R158.95 "复用 > 重写").
const drawerRunFilter = ref('');

// R158.76 (2026-10-11) — 时间切片器. default '24h' 跟后端 default 同步.
// windowMode 是本地 ref (避免跟浏览器全局 `window` 冲突), windowLabel
// 同步后端 envelope 字段, 让 drawer / header 副标题实时反映当前窗口.
const WINDOW_OPTIONS = [
  { value: '24h', label: '24 小时' },
  { value: '7d',  label: '7 天' },
  { value: 'all', label: '全部' }
];
const windowMode = ref('24h');
const windowLabel = ref('24 小时');

// R158.95-ext (2026-10-16) — drawer L1 list 行数切档 (10/100/全部).
// 跟 R158.76 window= 同前端 segmented chip 范式 1:1 平行, 0 引新 color
// token. 操作员 directive "右边不再固定 10 行最新, 而是全部的" — 三档
// 默认 10 保持 R67-T2 + R158.17.6 老 ship 行为 (R158.95 0 破坏 caller),
// 切 "全部" = endpoint safeLimit 上限 1000. chip 状态跟后端 envelope
// recentLimit 同步 (跟 windowLabel/windowMode 同步同 precedent).
const LIST_LIMIT_OPTIONS = [
  { value: 10,   label: '10 行' },
  { value: 100,  label: '100 行' },
  { value: 1000, label: '全部' }
];
const listLimit = ref(10);
const recentLimit = ref(10); // 后端 envelope 同步, 默认 10

let timerHandle = null;

const TYPE_LABEL = { gauge: '指标', counter: '计数器', status: '状态', timeseries: '时序' };

// R158.50.7b (2026-10-07) — PS1 metrics 字段被 stdout JSON 包成字符串后
// 不直接暴露在 /packages-runs 端点 (后端只回 stdoutPreview)。前端在 L1
// 列判断"success 但 metrics.error_code>0" 的混合状态 — 这是 PS1 try/catch
// 捕了内部异常但 exit 0 的 fingerprint,operator 看到 ✓成功 + error_code:1
// 会以为 process exit code=1 跟 ✓成功 矛盾。bit 含义是:
//   bit 1 = WinEvent query failed (RSAT 缺 / log 损坏)
//   bit 2 = ActiveDirectory RSAT module unavailable
// 这些是 PS1 内部 partial-failure 信号,跟 ✓成功(进程 exit 0)不矛盾 —
// 但要在 L1 列显眼标黄,避免 operator 误读。
const METRICS_ERROR_CODE_HINTS = {
  1: 'metrics.error_code=1: WinEvent query 部分失败 (RSAT 缺 / log 损坏)',
  2: 'metrics.error_code=2: ActiveDirectory RSAT 模块不可用',
  3: 'metrics.error_code=3: WinEvent 失败 + AD 模块不可用'
};
function parseMetricsWarning(run) {
  if (!run?.stdoutPreview) return null;
  // PS1 /agent 包约定 stdout 末行 = {"metrics":{...}}  — 找最后非空行
  const lines = run.stdoutPreview.split(/\r?\n/).filter(l => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i].trim();
    if (!ln.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(ln);
      const ec = parsed?.metrics?.error_code;
      if (typeof ec === 'number' && ec > 0) {
        return { ec, hint: METRICS_ERROR_CODE_HINTS[ec] || `metrics.error_code=${ec} (未知位组合)` };
      }
      return null;
    } catch {
      // JSON 解析失败 — 不是 raw metrics 行
      return null;
    }
  }
  return null;
}
function metricsWarning(run) {
  if (run.exitCode !== 0) return null;     // exit non-zero 已经在 error / stderr 列显示,不要重复
  const m = parseMetricsWarning(run);
  if (!m) return null;
  return m.hint;
}

// R158.50.7b L2 helpers — always return, default 0, hint via METRICS_ERROR_CODE_HINTS map
function metricsErrorCode(run) {
  const m = parseMetricsWarning(run);
  return m ? m.ec : 0;
}
function metricsErrorCodeHint(run) {
  const m = parseMetricsWarning(run);
  if (!m) return 'PS1 内部无 partial-failure (error_code=0)';
  return m.hint;
}
function metricsEventsCount(run) {
  if (!run?.stdoutPreview) return '—';
  const lines = run.stdoutPreview.split(/\r?\n/).filter(l => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i].trim();
    if (!ln.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(ln);
      const m = parsed?.metrics;
      if (!m) return '—';
      const ec = Array.isArray(m.events) ? m.events.length : (m.event_count ?? '—');
      return `${ec} event row(s)`;
    } catch {
      return '—';
    }
  }
  return '—';
}

function typeLabel(t) {
  if (t == null || t === '') return '—';
  return TYPE_LABEL[t] || `${t}`;
}
const AGENT_TYPE_LABEL = { ad: '域控', 'non-ad': '成员服务器' };
function agentTypeLabel(a) {
  if (a == null || a === '') return '—';
  return AGENT_TYPE_LABEL[a] || `${a}`;
}

// R158.72.x.6-ext (2026-10-16) — /packages-runs 视图描述全重写 14 包,
//   跟 /admin/packages/schedule (R158.72.x.6) 1:1 平行口语化 + cadence 1 行.
//   操作员 directive "完成包的内容中文化, 不要大段看不懂的语言, 用口语化的语言
//   写入内容, 另外加入执行周期说明" + "/packages-runs 这些包都没有修改并且直接了
//   当的显示当前的包功能".
//   老 10 包原 dict 是 R67-T2 时代"术语堆"风格, 现在跟 schedule dict 1:1 重写为
//   2 行口语化 (description + cadence).
//
//   1:1 平行 R158.72.x.6 schedule dict 9 entry + 5 个原 dict 中但 schedule
//   没列的 (ad_dc_overview / ad_eventlog_collector / ad_replication_status_probe /
//   ad_dc_probe_inbound / ad_lockout_summary) 同样按口语化风格 1:1 平行.
//   schedule dict 的 3 个 on-demand (ad_ad_groups_write / ad_ad_users_write /
//   ad_ad_account_quickfix) 在 R158.60.10-rollback 后已不在 BUILTIN_PACKAGES
//   (该 view 也不暴露), 0 列入 dict. 4 个 member-lineage (member_eventlog /
//   member_admin_groups / member_os_baseline_collector) 是 R158.86 / R158.100
//   ship, schedule dict 没覆盖, 这次顺手加.
//
//   0 改后端 / 0 改 manifest / 0 改 agent / 0 改 schema / 0 改 endpoint
//   (R158.69 "端点不要改" 1:1 平行). 纯前端展示增强.
//   ONDEMAND_PACKAGES set 不动 (R158.60.7-ext 已 ship, R158.60.10-rollback 后
//   永不命中是 ship 状态, 不删 = R158.X.99.6 1:1 平行).
const DESCRIPTION_LABEL = {
  ad_account_change: {
    description: '记录 AD 账户每天的创建、修改、删除、启用、禁用、解锁, 采集 5 类安全事件。',
    cadence: '每天凌晨 2 点由中心端统一定时触发, 各域控在 0~30 分钟内错开执行, 避免同时冲击域控。'
  },
  ad_admin_members: {
    description: '列出所有域管理员和企业管理员组成员。变更不频繁, 每 24 小时采集一次。',
    cadence: '每 24 小时自动执行一次 (在凌晨时段随机安排)。'
  },
  ad_dc_overview: {
    description: '每台域控的基础信息 (用户数、组数、组策略、复制伙伴端口), 按域控一行集中存储。',
    cadence: '每 1 小时自动执行一次, 由成员服务器自行调度。'
  },
  ad_eventlog_collector: {
    description: '域控 4 个事件日志通道 (系统、应用程序、AD Web 服务、分布式文件系统复制) 的告警与错误汇总及明细。',
    // R158.72.x.14 + .15 (2026-10-17) — 操作员 directive 锁 "ad_eventlog_collector 改 2 小时执行一次" (之前 5min 1 拍错).
    //   cronExpr='0 */2 * * *' (12 拍/天) + Jitter 0~5min per-DC. 1:1 平行 R158.72.x.13 6 包范式.
    //   0 改后端 / 0 改 manifest / 0 改 agent binary (0.1.7 已吃 */N step form via cron-parser.js).
    cadence: '每 2 小时自动执行一次, 采集数据保留 24 小时后自动清理。'
  },
  ad_lockout_list: {
    description: '本域控最近 15 分钟内的账户锁定事件 (安全事件 4740) 列表。',
    // R158.72.x.13 + .15 (2026-10-17) — 切 daily 2:00 + Jitter 0~30min per-DC (老 '每 15 分钟' 是 R158.72.x.6 ship 时 setInterval 900s 范式描述).
    // R158.72.x.17 (2026-10-17) — 改回 15 分钟 (R155.3 原始 intervalSec=900 范式). 跟 R158.72.x.16 ad_dc_probe_inbound 1:1 平行.
    cadence: '每 15 分钟自动执行一次, 由各域控自行调度。'
  },
  ad_lockout_summary: {
    description: '本域控当前被锁定的 AD 用户数。',
    // R158.72.x.13 + .15 (2026-10-17) — 切 daily 2:00 + Jitter 0~30min per-DC.
    // R158.72.x.17 (2026-10-17) — 改回 15 分钟 (R155.3 原始 intervalSec=900 范式). 跟 R158.72.x.16 ad_dc_probe_inbound 1:1 平行.
    cadence: '每 15 分钟自动执行一次, 由各域控自行调度。'
  },
  ad_failed_logon_collector: {
    description: '从域控安全日志中采集登录失败事件 (安全事件 4625), 写入集中表。',
    // R158.72.x.13 + .15 (2026-10-17) — 切 daily 2:00 + Jitter 0~30min per-DC.
    // R158.72.x.17 (2026-10-17) — 改回 15 分钟 (R155.3 原始 intervalSec=900 范式, 跟 R158.58 window 900s 1:1 平行). 跟 R158.72.x.16 1:1 平行.
    cadence: '每 15 分钟自动执行一次, 由各域控自行调度。采集数据保留 7 天, 之后自动清理。'
  },
  ad_os_baseline: {
    description: '采集域控的 CPU、内存、磁盘、关键服务等基础运行指标。',
    // R158.72.x.13 + .15 (2026-10-17) — 切 daily 2:00 + Jitter 0~30min per-DC.
    // R158.72.x.17 (2026-10-17) — 改回 15 分钟 (操作员 directive 锁跟 3 锁包 1:1 平行). 跟 R158.72.x.16 1:1 平行.
    cadence: '每 15 分钟自动执行一次, 由各域控自行调度。'
  },
  ad_dc_probe_inbound: {
    description: '对每个上游伙伴域的每个复制端口做连通性探测, 形成端口健康矩阵。',
    // R158.72.x.16 (2026-10-17) — 改回 15 分钟 (R155.3 原始 intervalSec=900 范式). 走 R158.60.10
    //   第 1 idiom agent 端 self-setInterval 900s, 中心端 cron 0 fire. 24h 192 拍/包 × 33 DC
    //   = 6336 row/天 (R155.3 1:1 平行, 端口健康探针高频语义保留).
    cadence: '每 15 分钟自动执行一次, 由各域控自行调度。'
  },
  ad_partner_inbound_discover: {
    description: '扫描本域控的入站复制伙伴清单, 新出现的伙伴自动加入, 已消失的伙伴自动移除。',
    // R158.X.99.11 + .15 (2026-10-17) — 切 daily 2:00 + Jitter 0~30min per-DC (老 '每 5 分钟 (中心端 cron 调度)' 是 R157.4 ship 时 setInterval 300s 范式描述).
    cadence: '每天凌晨 2 点由中心端统一定时触发, 各域控在 0~30 分钟内错开执行, 避免同时冲击域控。'
  },
  ad_replication_status_probe: {
    description: '对每个 (伙伴域 × 域控) 复制关系做主动探测, 记录复制健康状态。',
    // R158.72.x.13 ship 漏 1:1 (本包是 R158.10 配 setInterval 600s, R158.72.x.13 6 包没含本包), 保留原描述
    cadence: '每 10 分钟自动执行一次。'
  },
  member_eventlog_collector: {
    description: '采集成员服务器三个事件日志通道 (应用程序、系统、安全) 的记录。',
    // NoAD eventlog 走 R158.100 ship setInterval 24h 范式 (跟 AD aelc 不同步, 1:1 平行 member_admin_groups R158.100 范式)
    cadence: '每 5 分钟自动执行一次, 采集数据保留 24 小时后自动清理。'
  },
  member_admin_groups: {
    description: '成员服务器本地管理员组成员 (管理员、远程管理用户等内置组)。',
    // NoAD member_admin_groups 跟 AD ad_admin_members 1:1 平行但真值不同: NoAD 端 setInterval 86400 范式正常工作
    //   (R158.100 ship), 11:02 后 9.5h 跑 1 次 3 row (跟 AD aam 0 fire 形态不同). 暂不切 cronExpr 范式,
    //   跟 AD 切 cronExpr 不必 1:1 平行 (NoAD fleet = 35 member-server, 跟 35 AD DC 范式可能不一致).
    cadence: '每 24 小时自动执行一次。'
  },
  member_os_baseline_collector: {
    description: '采集成员服务器的 CPU、内存、磁盘、关键服务等基础运行指标 (与域控同款)。',
    // NoAD os_baseline 跟 ad_os_baseline 不 1:1 (R158.72.x.13 ship 漏 1:1, 1:1 平行 member_admin_groups R158.100 setInterval 范式)
    cadence: '每 1 分钟自动执行一次 (高频指标)。'
  }
};

// R158.60.7-ext (2026-10-09) — operator "他们应该一致. 一致修复"
// 把 /admin/packages (R158.60.4/60.6/60.7) 的圆形 On-demand badge 同步到
// /packages-runs 视图. 4 个 on-demand 包没有任何 agent.intervalSec, 走
// R75 drainAdCommands → dispatchAdCommand 路径触发 (R158.56c-d ship,
// R158.60.3 验证). 卡片显示 badge, drawer 也显示同一个 badge — 让任何
// 看见这 4 个包的地方都是同款视觉信号.
const ONDEMAND_PACKAGES = new Set([
  'ad_ad_groups_write',
  'ad_ad_users_write',
  'ad_ad_object_move',
  'ad_ad_ou_create'
]);
const isOndemand = (name) => ONDEMAND_PACKAGES.has(name);

function fallbackLabel(name, type) {
  const typeText = TYPE_LABEL[type] || '包';
  if (!name) return `用户上传${typeText}`;
  return `用户上传${typeText}: ${name}`;
}
function fallbackCadence(name) {
  if (name === 'ad_account_change') {
    // R158.72.x.5 ship 后状态 1:1 平行 — dict 已覆盖但兜底也保留
    return '每天凌晨 2 点 + 0~30min 错峰';
  }
  return '由执行计划的「间隔（秒）」列决定';
}
function descriptionLabel(name, original, type) {
  if (!original) return fallbackLabel(name, type);
  const hit = DESCRIPTION_LABEL[name];
  return (hit && hit.description) || original;
}
function cadenceLabel(name) {
  const hit = DESCRIPTION_LABEL[name];
  if (hit && hit.cadence) return hit.cadence;
  return fallbackCadence(name);
}

function statusClass(p) {
  const s = p.summary24h;
  if (s.total === 0) return 'none';
  if (s.failure > 0) return 'err';
  if (s.partial > 0) return 'warn';
  return 'ok';
}
function statusLabel(p) {
  const s = p.summary24h;
  if (s.total === 0) return '无数据';
  if (s.failure > 0) return `${s.failure} 失败`;
  if (s.partial > 0) return `${s.partial} 部分`;
  return '全部成功';
}
// R158.50.7g (2026-10-08) — colour rows by server-evaluated `status`
// (success/partial/failed/running) instead of inferring from `error` field
// alone. Pre-fix, every ad_lockout_list row with `error='ps1: ... 找不到
// 任何与指定的选择条件匹配的事件。'` rendered red even though exit_code=0
// + status='partial' (a non-fatal "no events in window" state, not a process
// failure). Now: failed=red, partial=yellow, success=green, running=warn.
// Falls back to exit-code-based classification when status is missing
// (rows from before R158.47.3 status column).
function runClass(r) {
  if (r.status === 'failed') return 'err';
  if (r.status === 'partial') return 'warn';
  if (r.status === 'success') return 'ok';
  if (r.status === 'running') return 'warn';
  // legacy rows (status null) — infer from exit_code
  if (r.exitCode === 0) return 'ok';
  if (r.exitCode == null) return 'warn';
  return 'err';
}
function runGlyph(r) {
  const cls = runClass(r);
  if (cls === 'err') return '✕';
  if (cls === 'warn') return '!';
  return '✓';
}
function runLabel(r) {
  if (r.status === 'failed') return '失败';
  if (r.status === 'partial') return '部分';
  if (r.status === 'running') return '运行中';
  if (r.exitCode === 0) return '成功';
  if (r.exitCode == null) return '部分';
  return '失败';
}
function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
function fmt(s) {
  if (!s) return '—';
  return formatDateTime(s);
}
function shortTime(s) {
  if (!s) return '—';
  return formatDateTimeIso(s, { withYear: false });
}

function selectPackage(p, presetFilter = '') {
  selectedPackage.value = p;
  selectedRun.value = null;
  // R158.95-ext — 卡片 pill 触发的 filter hint (runClass 4 档 err/warn/ok/
  // 其它). 'none' (无数据) 不可筛, 强制 '全部'. 手动 trigger 时传 ''
  // 直接保留上一档; 操作员切包保留也是合理 (跟 R158.76 切窗口行为 1:1).
  if (presetFilter && presetFilter !== 'none') {
    drawerRunFilter.value = presetFilter;
  } else if (presetFilter === 'none') {
    drawerRunFilter.value = '';
  }
}
// R158.95-ext — drawer level-1 表行 derived. 空 filter 走全表; 否则按
// runClass(r) 1:1 过滤 (跟 L1 行底色 recent-${runClass} 同步).
const visibleRecent = computed(() => {
  const pkg = selectedPackage.value;
  if (!pkg) return [];
  const all = Array.isArray(pkg.recent) ? pkg.recent : [];
  if (!drawerRunFilter.value) return all;
  return all.filter((r) => runClass(r) === drawerRunFilter.value);
});
// R158.95-ext — chip label 跟 statusLabel 一致, 让用户看 chip 知道对应档.
const FILTER_CHIPS = [
  { value: '',       label: '全部' },
  { value: 'err',    label: '失败' },
  { value: 'warn',   label: '部分' },
  { value: 'ok',     label: '成功' }
];
function statusPillHint(cls) {
  if (cls === 'err') return '点击只看失败执行';
  if (cls === 'warn') return '点击只看部分执行';
  if (cls === 'ok') return '点击只看成功执行';
  if (cls === 'none') return '此包暂无执行, 打开明细';
  return '点击打开执行明细';
}
function selectRun(r) {
  selectedRun.value = r;
}
function closeDrawer() {
  selectedPackage.value = null;
  selectedRun.value = null;
  drawerRunFilter.value = '';
}

async function load() {
  polling.value = true;
  error.value = '';
  try {
    // R158.76 — 传 windowMode 让后端按窗口切 since. 老 caller 路径
    // getPackagesRuns() 默认 '24h' 行为不变.
    // R158.95-ext — 透传 listLimit, 跟 window= 同范式 1:1 平行, 后端
    // envelope 返 recentLimit 同步前端 chip active 状态.
    // R158.X+UI.lazy (2026-10-20) — includeTimeline 只在用户激活折线图后
    // 才为 true; 首屏走 false, 后端跳过 14 次 timeline fan-out.
    const r = await dashboardApi.getPackagesRuns({
      window: windowMode.value,
      limit: listLimit.value,
      includeTimeline: timelineActivated.value
    });
    const fresh = Array.isArray(r.data?.packages) ? r.data.packages : [];
    // refresh seconds may have changed since initial mount
    // R158.X+UI.lazy (2026-10-20) — 后端已从 10 改 60 (5MB→~250KB 后
    // 不需要 10s 轮询), fallback 同步改 60 防老 envelope 走 10s 狂刷.
    refreshSeconds.value = Number(r.data?.refreshSeconds) || 60;
    // R158.76 — envelope windowLabel 同步 (后端给, 避免前端硬编码跟后端 drift)
    const backendLabel = r.data?.windowLabel;
    if (backendLabel) {
      windowLabel.value = backendLabel;
    } else {
      // 老 server fallback (防御性)
      const opt = WINDOW_OPTIONS.find(o => o.value === windowMode.value);
      if (opt) windowLabel.value = opt.label;
    }
    // R158.95-ext — envelope recentLimit 同步, 但只在首次初始化兜底同步.
    // 后续轮询不反向写 listLimit (前端是 single source of truth — 用户操作 chip
    // 才改 listLimit; 后端 stale 若返 stale recentLimit 也不能覆盖 UI 状态).
    // 防御性: 后端未 ship 期间 ?limit= 被忽略, envelope.recentLimit 会是 10,
    // 但前端发的是 1000, 显示 1000 行 active 跟实际 10 行不一致 — 让前端"操
    // 作员的意图" 1:1 走 (后端重启后会自然对齐). recentLimit 仅作观测用 (永
    // 远跟 listLimit 同步赋值, 0 改 UI 状态).
    if (Number.isInteger(r.data?.recentLimit)) {
      recentLimit.value = r.data.recentLimit;
    }
    // preserve selectedPackage reference across polls so drawer survives refresh
    const selName = selectedPackage.value?.name;
    packages.value = fresh;
    if (selName) {
      const next = fresh.find(p => p.name === selName);
      if (next) selectedPackage.value = next;
      else closeDrawer();
    }
    lastLoadedAt.value = new Date().toISOString();
  } catch (e) {
    error.value = e?.response?.data?.error || '加载失败';
  } finally {
    polling.value = false;
    // 包执行时间线: 1-click 拉新数据后必 await nextTick + render.
    // 跟 R158.100.2 6 layer template + R158.100.7 nextTick×2 1:1 平行.
    // 这里 polling tick 是单源, 1 次 nextTick 足够 (Flavour A 简化).
    nextTick(() => renderTimelineChart());
  }
}

// R158.76 — 切换窗口: ref 同步 + 立即重 fetch. 不破 polling timer
// (10s 节奏继续走, 不重 setInterval).
function setWindow(value) {
  if (windowMode.value === value) return;
  windowMode.value = value;
  load();
}

// R158.95-ext — 切抽屉 list 行数切档. 跟 setWindow 1:1 平行 (ref 同步 +
// 立即重 fetch, 不破 polling timer).
function setListLimit(value) {
  if (listLimit.value === value) return;
  listLimit.value = value;
  load();
}

function onKey(e) {
  if (e.key === 'Escape') closeDrawer();
}

onMounted(async () => {
  await load();
  timerHandle = setInterval(load, refreshSeconds.value * 1000);
  window.addEventListener('keydown', onKey);
});
onUnmounted(() => {
  if (timerHandle) clearInterval(timerHandle);
  // R158.X+UI.lazy — trailing debounce timer 必清, 否则组件卸载后
  // 仍会 fire 一次 load() 写已卸载的 ref (内存泄漏 + 无主请求).
  if (timelineActivationTimer) {
    clearTimeout(timelineActivationTimer);
    timelineActivationTimer = null;
  }
  window.removeEventListener('keydown', onKey);
  // 包执行时间线: 必 dispose + null + removeEventListener, 1:1 平行 R158.100.2 6 layer template.
  if (timelineChartInstance) {
    timelineChartInstance.dispose();
    timelineChartInstance = null;
  }
  window.removeEventListener('resize', onTimelineResize);
});
</script>

<style scoped>
.page-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 16px; margin-bottom: 14px;
}
.page-titles { display: flex; flex-direction: column; gap: 2px; }
.page-title {
  margin: 0; font-size: 18px; font-weight: 600; color: var(--text);
  letter-spacing: -0.005em;
}
.subtitle { margin: 0; font-size: 12px; color: var(--muted); }
.page-meta {
  display: flex; align-items: center; gap: 8px;
  font-size: 11px; color: var(--muted);
  font-family: ui-monospace, "SF Mono", monospace;
}
.dot { width: 6px; height: 6px; border-radius: 50%; }
.dot.on  { background: var(--green); }
.dot.off { background: var(--muted); }

.error-banner {
  background: color-mix(in srgb, var(--red) 12%, transparent); color: var(--red);
  padding: 8px 12px; border-radius: 4px; margin-bottom: 12px;
  border: 1px solid color-mix(in srgb, var(--red) 30%, transparent); font-size: 12px;
}
.empty {
  text-align: center; color: var(--muted);
  padding: 32px; font-size: 13px;
  background: var(--panel-alt); border: 1px solid var(--border);
  border-radius: 4px;
}

/* R158.60.8 (2026-10-09) — operator "按常规必须是平均分配, 平均一行
   有三个, 当前第一个最宽". 原 repeat(3,1fr) fixed 3 列 + 1fr 不防
   min-content 撑爆 (long token description 让第一列撑宽). 改 auto-fill
   + minmax(280px, 1fr) responsive: 任何 viewport 列数自适应, 每列等宽
   1fr, 不会让 single card 把整 row 拉宽. 撤 grid-template-rows: repeat(2, auto)
   (误导: 不真限制行数, CSS Grid 自动 implicit row 补); 撤 justify-content
   (redundant default). 跟 DashboardView / FilePushView 同款 responsive
   pattern. */
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  grid-auto-rows: auto;
  gap: 14px;
}

.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 14px 16px;
  display: flex; flex-direction: column; gap: 10px;
  cursor: pointer;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.card:hover { border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); }
.card.is-selected { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent); }
.card-err { border-left: 3px solid var(--red); }
.card-warn { border-left: 3px solid var(--yellow); }
.card-ok { border-left: 3px solid var(--green); }
.card-none { border-left: 3px solid var(--muted); }

.card-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 12px;
}
.card-title { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.card-name {
  margin: 0; font-size: 14px; font-weight: 600;
  color: var(--text); font-family: ui-monospace, "SF Mono", monospace;
}
.card-version {
  font-size: 11px; color: var(--muted);
  font-family: ui-monospace, "SF Mono", monospace;
}
/* R158.60.7-ext — 圆形 On-demand badge, 跟 /admin/packages PackagesView
   完全同款 (border-radius 9999px 完全圆胶囊, 同黄色色板). 让两个视图
   任意 on-demand 包都是视觉一致锚点. */
.ondemand-badge {
  font-size: 9px; padding: 1px 9px; border-radius: 9999px;
  background: color-mix(in srgb, var(--yellow) 18%, transparent);
  color: var(--yellow);
  letter-spacing: 0.06em; text-transform: uppercase; font-weight: 800;
  border: 1px solid color-mix(in srgb, var(--yellow) 38%, transparent);
  font-family: ui-monospace, monospace;
  align-self: center;
}

.status-pill {
  font-size: 11px; font-weight: 600;
  padding: 3px 10px; border-radius: 999px;
  white-space: nowrap;
}
.pill-ok   { background: color-mix(in srgb, var(--green) 18%, transparent); color: var(--status-pill-fg-ok); }
.pill-warn { background: color-mix(in srgb, var(--yellow) 22%, transparent); color: var(--status-pill-fg-warn); }
.pill-err  { background: color-mix(in srgb, var(--red) 22%, transparent); color: var(--status-pill-fg-err); }
.pill-none { background: var(--panel-alt); color: var(--muted); }

/* R158.95-ext (2026-10-16) — pill 变身 clickable. 操作员 directive
   "点击那个文字的时候进行筛选". status-pill 0 改色 + 0 改字号, 只
   cursor / hover / focus 增, hover 提亮 6% 跟 .card:hover 1:1 视觉一致. */
.pill-clickable {
  cursor: pointer;
  border: none;
  font-family: inherit;
  user-select: none;
}
.pill-clickable:hover {
  filter: brightness(0.96);
  box-shadow: 0 0 0 1px color-mix(in srgb, currentColor 30%, transparent);
}
.pill-clickable:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

/* R158.60.8 — 让任意不间断 token (`<...>`, `__ports__:` 等 ASCII 行内
   长 token) 也能断词, 不撑爆 grid column min-content. anywhere 比
   break-word 更激进 — 任意字符位置都能断 (中文断字不雅观但 14 包
   description 全是中文+ASCII, 视觉效果 OK). operator 选 anywhere
   (推荐), 不是 break-word (保守). */
.card-desc {
  margin: 0; font-size: 12px; color: var(--muted);
  line-height: 1.5; min-height: 18px;
  overflow-wrap: anywhere;
}

/* R158.72.x.6-ext — 卡片 cadence 行, 跟 /admin/packages/schedule
   PackageScheduleView pkg-cadence 1:1 平行 (font-size + accent 色 +
   行高 1.4). 13 包统一前缀 ⏱, 跟 ONDEMAND badge 同视觉权重. */
.card-cadence {
  margin: 0;
  font-size: 11px;
  color: var(--accent);
  line-height: 1.4;
}

.card-meta {
  display: flex; gap: 16px; flex-wrap: wrap;
  font-size: 11px; color: var(--muted);
}
.meta-row { display: inline-flex; gap: 4px; align-items: baseline; }
.meta-label { color: var(--muted); }
.meta-value {
  color: var(--text); font-weight: 500;
  font-family: ui-monospace, "SF Mono", monospace;
}

.summary {
  display: flex; align-items: center; flex-wrap: wrap;
  gap: 14px;
  padding: 8px 10px;
  background: var(--panel-alt);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 11px;
}
.summary-item { display: inline-flex; align-items: baseline; gap: 4px; }
.summary-num {
  font-family: ui-monospace, "SF Mono", monospace;
  font-feature-settings: "tnum";
  font-weight: 600; color: var(--text);
}
.summary-success { color: var(--status-pill-fg-ok); }
.summary-failure { color: var(--status-pill-fg-err); }
.summary-partial { color: var(--status-pill-fg-warn); }
.summary-label { color: var(--muted); }
.summary-value {
  color: var(--text); font-weight: 500;
  font-family: ui-monospace, "SF Mono", monospace;
}
.summary-divider { width: 1px; height: 14px; background: var(--border); }
.summary-spacer { flex: 1; }

.card-footer {
  margin-top: auto; padding-top: 4px;
  border-top: 1px dashed var(--border);
  text-align: right;
  font-size: 11px; color: var(--muted);
}
.card-hint { font-style: italic; }

/* ------------------------------------------------------------------ */
/* Drawer                                                             */
/* ------------------------------------------------------------------ */
.drawer-overlay {
  position: fixed; inset: 0;
  background: color-mix(in srgb, black 30%, transparent);
  z-index: 40;
}
.drawer {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  width: min(720px, 90vw);
  background: var(--panel);
  border-left: 1px solid var(--border);
  box-shadow: -8px 0 24px color-mix(in srgb, black 18%, transparent);
  z-index: 41;
  display: flex; flex-direction: column;
  overflow: hidden;
}
.drawer-enter-active, .drawer-leave-active { transition: transform 220ms ease; }
.drawer-enter-from, .drawer-leave-to { transform: translateX(100%); }
.fade-enter-active, .fade-leave-active { transition: opacity 180ms ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

.drawer-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-alt);
}
.drawer-titles { flex: 1; min-width: 0; }
.drawer-title {
  margin: 0; font-size: 15px; font-weight: 600;
  color: var(--text);
  font-family: ui-monospace, "SF Mono", monospace;
}
.drawer-version {
  font-size: 11px; color: var(--muted);
  font-family: ui-monospace, "SF Mono", monospace);
  margin-left: 4px;
}
.drawer-subtitle {
  margin: 4px 0 0; font-size: 11px; color: var(--muted);
}
/* R158.72.x.6-ext — drawer cadence 行, 跟 card-cadence 1:1 平行 */
.drawer-cadence {
  margin: 4px 0 0; font-size: 11px;
  color: var(--accent);
  line-height: 1.4;
}

/* ------------------------------------------------------------------ */
/* R158.76 — 24h / 7d / 全部 时间切片器 (segmented button)           */
/* ------------------------------------------------------------------ */
.page-window-control {
  display: inline-flex;
  background: var(--panel-alt);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 2px;
  gap: 2px;
  align-self: flex-start;
  margin-top: 2px;
}
.window-btn {
  background: transparent;
  border: none;
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  transition: background-color 120ms, color 120ms;
  font-family: inherit;
}
.window-btn:hover {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--text);
}
.window-btn.is-active {
  background: var(--panel);
  color: var(--accent);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
.drawer-close {
  background: transparent; border: 1px solid var(--border);
  color: var(--text); font-size: 13px;
  width: 28px; height: 28px; border-radius: 4px;
  cursor: pointer;
}
.drawer-close:hover { background: var(--panel-alt); }

.drawer-body {
  flex: 1; min-height: 0; overflow: auto;
  padding: 14px 18px;
}
.drawer-h4 {
  margin: 0 0 10px;
  font-size: 12px; font-weight: 500;
  color: var(--muted);
  text-transform: uppercase; letter-spacing: 0.05em;
}

/* R158.95-ext — drawer level-1 行筛选 segmented button. 跟 R158.76
   page-window-control 同款配色 (panel alt 底 + 圆角 + active=panel 白),
   0 引新 color token. 4 档: 全部 / 失败 / 部分 / 成功, 都带 count. */
.run-filter {
  display: inline-flex;
  background: var(--panel-alt);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 2px;
  gap: 2px;
  margin-bottom: 10px;
}

/* R158.95-ext — drawer list limit 切档 segmented chip. 跟 .run-filter
   同款配色 (panel alt 底 + 圆角 + active=panel 白), 0 引新 color token.
   label "显示行数" 前缀跟 page-window-control 同 .window-btn 同范式,
   跟 run-filter 1:1 平行但多 1 个 label 锚点. */
.list-limit {
  display: inline-flex;
  align-items: center;
  background: var(--panel-alt);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 2px;
  gap: 2px;
  margin-bottom: 8px;
  margin-right: 8px;
}
.list-limit-label {
  font-size: 11px;
  color: var(--muted);
  padding: 0 8px 0 6px;
  font-weight: 500;
}
.list-limit-btn {
  background: transparent;
  border: none;
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  transition: background-color 120ms, color 120ms;
  font-family: inherit;
}
.list-limit-btn:hover {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--text);
}
.list-limit-btn.is-active {
  background: var(--panel);
  color: var(--accent);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
.run-filter-btn {
  background: transparent;
  border: none;
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  transition: background-color 120ms, color 120ms;
  font-family: inherit;
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
}
.run-filter-btn:hover {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--text);
}
.run-filter-btn.is-active {
  background: var(--panel);
  color: var(--accent);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
.run-filter-count {
  font-size: 10px;
  font-family: ui-monospace, "SF Mono", monospace;
  color: var(--muted);
  font-feature-settings: "tnum";
}
.run-filter-btn.is-active .run-filter-count {
  color: var(--accent);
}
/* 过滤后 0 行空状态 (黄色 hint + 内联 reset 链接) */
.run-filter-empty {
  padding: 14px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--muted);
  background: color-mix(in srgb, var(--yellow) 8%, var(--panel));
  border: 1px dashed color-mix(in srgb, var(--yellow) 38%, var(--border));
  border-radius: 4px;
  margin-top: 10px;
}
.run-filter-reset {
  background: transparent;
  border: none;
  padding: 0;
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  text-decoration: underline;
  font-family: inherit;
}
.run-filter-reset:hover {
  color: var(--text);
}

.back-btn {
  background: transparent; border: 1px solid var(--border);
  color: var(--text); font-size: 12px;
  padding: 4px 10px; border-radius: 4px;
  cursor: pointer; margin-bottom: 12px;
}
.back-btn:hover { background: var(--panel-alt); }

/* ------------------------------------------------------------------ */
/* Run list (drawer level 1)                                          */
/* ------------------------------------------------------------------ */
.recent-table {
  width: 100%; border-collapse: collapse;
  font-size: 11px;
  font-family: ui-monospace, "SF Mono", monospace;
  font-feature-settings: "tnum";
}
.recent-table thead th {
  text-align: left; padding: 5px 6px;
  font-size: 10px; color: var(--muted);
  font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em;
  border-bottom: 1px solid var(--border);
  background: var(--panel-alt);
}
.recent-table td {
  padding: 6px 6px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
.recent-row { cursor: pointer; }
.recent-row:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
.recent-row-err  { background: color-mix(in srgb, var(--red) 6%, transparent); }
.recent-row-warn { background: color-mix(in srgb, var(--yellow) 6%, transparent); }
.recent-row-ok   { background: transparent; }

.col-time { white-space: nowrap; color: var(--text); }
.col-agent { color: var(--text); }
.col-ver { white-space: nowrap; color: var(--muted); }
.run-version {
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 2px;
  background: var(--panel-alt);
  color: var(--text);
}
.run-version.is-stale {
  background: color-mix(in srgb, var(--yellow) 18%, transparent);
  color: var(--status-pill-fg-warn);
}
.col-status { white-space: nowrap; }
.col-dur { white-space: nowrap; color: var(--muted); }
.col-err-list { max-width: 360px; }
.col-err-list code {
  display: inline-block; max-width: 360px;
  font-size: 10px; color: var(--text);
  background: var(--panel-alt);
  padding: 2px 5px; border-radius: 2px;
  white-space: normal; word-break: break-word; line-height: 1.4;
}
.col-err-list code.error {
  background: color-mix(in srgb, var(--red) 12%, transparent);
  color: var(--red); font-weight: 500;
}
.col-err-list code.stdout { color: var(--muted); }
/* R158.50.7b — 黄色 metrics.warning (exit_code==0 但 metrics.error_code>0).
   PS1 internal partial-failure fingerprint,跟 ✓成功不矛盾但要显眼。 */
.col-err-list code.warn {
  background: color-mix(in srgb, var(--yellow) 18%, transparent);
  color: var(--status-pill-fg-warn);
  font-weight: 500;
}

.run-glyph { font-weight: 700; margin-right: 4px; }
.run-ok   { color: var(--status-pill-fg-ok); }
.run-warn { color: var(--status-pill-fg-warn); }
.run-err  { color: var(--status-pill-fg-err); }
.run-label { color: var(--text); }

/* ------------------------------------------------------------------ */
/* Run detail (drawer level 2)                                        */
/* ------------------------------------------------------------------ */
.detail-block {
  margin-bottom: 18px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--panel-alt);
  overflow: hidden;
}
.detail-h {
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
  padding: 6px 10px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  text-transform: uppercase; letter-spacing: 0.05em;
}
.detail-pre {
  margin: 0;
  padding: 10px 12px;
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text);
  background: var(--panel);
  white-space: pre-wrap;       /* R158.50.7 — wrap long PS parse error lines */
  word-break: break-word;
  overflow-x: auto;
  max-height: 360px; overflow-y: auto;
}
.detail-pre.detail-error {
  color: var(--red);
  background: color-mix(in srgb, var(--red) 8%, var(--panel));
}
.detail-pre.detail-empty {
  color: var(--muted); font-style: italic;
}
.detail-meta-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 14px;
  padding: 8px 12px;
}
.detail-meta-grid > div {
  font-size: 11px;
  display: flex; gap: 6px; align-items: baseline;
}
.detail-meta-grid code {
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 11px;
  color: var(--text);
  word-break: break-all;
}
.detail-meta-grid .meta-label {
  color: var(--muted); min-width: 80px;
}

/* R158.50.7b — PS1 metrics L2 block */
.detail-metrics {
  padding: 10px 12px;
  display: flex; flex-direction: column;
  gap: 6px;
  font-size: 11px;
}
.metric-row {
  display: flex; align-items: baseline;
  gap: 10px; flex-wrap: wrap;
}
.metric-label {
  color: var(--muted); min-width: 200px;
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 10px;
  text-transform: uppercase; letter-spacing: 0.05em;
}
.metric-val {
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 12px; font-weight: 700;
  padding: 1px 6px; border-radius: 2px;
}
.metric-val.metric-ok   { color: var(--status-pill-fg-ok);   background: color-mix(in srgb, var(--green) 14%, transparent); }
.metric-val.metric-warn { color: var(--status-pill-fg-warn); background: color-mix(in srgb, var(--yellow) 18%, transparent); }
.metric-hint {
  color: var(--muted); font-style: italic;
}

/* === 包执行时间线 (R158.X+UI) === */
.timeline-chart-card {
  background: var(--card, #fff);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 6px;
  padding: 14px 16px 10px;
  margin-bottom: 16px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.04);
}
.timeline-chart-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.timeline-chart-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--fg, #111827);
  white-space: nowrap;
}
.timeline-chart-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  align-items: center;
  font-size: 12px;
  flex: 1;
  justify-content: flex-end;
}
.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--fg, #111827);
  font-family: ui-monospace, "SF Mono", monospace;
}
.legend-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
.legend-name { font-weight: 600; }
.legend-count {
  color: var(--muted, #6b7280);
  font-weight: 400;
  margin-left: 2px;
}
.legend-clear-btn {
  border: 1px solid var(--accent, #2563eb);
  background: #fff;
  color: var(--accent, #2563eb);
  padding: 2px 10px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  margin-left: 8px;
}
.legend-clear-btn:hover { background: var(--accent, #2563eb); color: #fff; }
.timeline-chart-canvas {
  width: 100%;
  height: 320px;
}
.timeline-chart-empty {
  margin: 12px 0 0;
  padding: 30px 0;
  text-align: center;
  color: var(--muted, #6b7280);
  font-style: italic;
  font-size: 13px;
}
/* 卡片被折线图 filter 选中时, 描边 + 顶部高亮条 1:1 平行 .is-selected 范式 */
.card.is-timeline-filtered {
  outline: 2px solid var(--accent, #2563eb);
  outline-offset: -2px;
  box-shadow: 0 0 0 1px var(--accent, #2563eb);
}
</style>