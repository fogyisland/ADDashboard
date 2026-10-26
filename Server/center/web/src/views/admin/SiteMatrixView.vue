<!--
  站点矩阵 — N×N 站点复制健康矩阵
  2026-08-29 R60 (operator directive "站点矩阵不用那么复杂,只保留最新的状态,
  在一个页面中显示所有的站点连接状态,没有问题绿色,有问题黄色,断开红色。
  不用做的特别复杂,要容忍足够多的数据出现") extracted into a standalone
  page on R64. This is the 站点矩阵 view, distinct from 复制状态概览 (which
  restored the R49 ops-console per-DC partner tables view).

  - Single page. One N×N matrix: sites as rows × sites as columns.
  - R80 (operator directive "在站点矩阵中 我们需要展现的子站点中的AD服务器,
    核心站点中的具体服务器,有连接且健康显示为绿色,无连接显示为 -"):
    each cell now renders a per-DC sub-grid (src-site DCs × dst-site DCs).
    Each inner cell carries the status of one (srcDc → dstDc) link as a
    tiny colored square — green/✓ for ok, yellow/! for warn, red/✕ for
    err, light-gray/— for none. The outer <td> still carries the
    aggregate cell-{ok/warn/err/none/self} class (worst status across all
    DC pairs) so the existing `data-test="cell-X-Y"` selectors keep
    resolving and the worst-state visual cue is preserved on the cell
    border.
  - Self cells (srcSite === dstSite) keep the original `.cell-glyph` +
    `.cell-num` rendering (single dashed box with "·" / "—") since there
    are no partner links within a site-pair — no DC sub-grid would
    carry useful information.
  - Click on a dc-pair-cell opens the existing R71 cell-detail modal,
    highlighted to the specific DC pair the operator clicked. Click on
    the outer cell (or any non-DC-pair area) opens the same modal
    without highlight.
  - Sticky first column (row headers = site names + DC count) and
    sticky first row (column headers = site names + DC count); the
    grid scrolls horizontally if there are many sites.
  - Hover the outer cell → tooltip lists the individual partner links
    between those two sites (source DC, dest DC, statusCode,
    lastSuccessTime, errorMessage). Hover a dc-pair-cell → tooltip
    describes just that DC pair.
  - The 3-panel layered structure (R68 Hub-Spoke: Hub↔Hub / Spoke→Hub /
    Full) is preserved — each panel renders the same per-DC sub-grid
    pattern with the appropriate visual emphasis (Hub↔Hub cells keep
    the .cell-hub-pair gold border; Spoke→Hub cells stay compact).
  - R133 (operator directive "站点和 DC 需要都展示出来,不要只是显示 2 DC,
    而是显示父子关系" — 行向 + 列向都展开): 行/列现在以 DC 为单位
    (每台 DC 占一行/一列),同站点的 DC 共享一个站点组标题
    (用 rowspan / colspan 在面板里实现). axisEntries 把 sites
    展开成 [{ siteName, dcName, dcCount, isFirst, isLast }] 数组,
    Panel 1/2/3 都用它作为行/列迭代器. 每个 cell 是 1:1 的
    (srcDc → dstDc) 链路,直接承载 dc-pair 状态色(过去 R80 的
    sub-grid 嵌套层取消).
  - Click a pair row inside the modal → inline expand to the last 10
    replication attempts (R72), reuse R45 /pair-history endpoint.
  - The data contract is unchanged — same
    /api/dashboard/site-replication-matrix/all endpoint, same
    primaries[].dcPartners[].partners[] payload.
-->
<template>
  <!--
    2026-08-30 R64.2 fix: 站点矩阵 前台专属 — 用 AppLayout 包 (不再用 AdminLayout).
    R64 split 把 /matrix 拆成独立前台页面,R64.1 从 AdminLayout nav 删了链接,
    但 SiteMatrixView.vue 组件本身还包着 AdminLayout → 前台点进来后渲染后台壳.
    这里换成 AppLayout 才彻底脱离后台。
  -->
  <AppLayout>
    <header class="page-header">
      <div class="page-titles">
        <h2 class="page-title">{{ props.direction === 'outbound' ? '复制矩阵' : '复制矩阵' }}</h2>
        <!-- R158.11 (2026-10-01) — page title "站点入站矩阵" 改 "复制矩阵"
             (operator directive)。outbound 路径已下线 (R158.10),
             props.direction 实际上恒为 'inbound', 但保留 ternary
             以防 wrapper 误传。
        -->
        <p class="subtitle">所有站点的复制链路 · {{ refreshSeconds }} 秒自动刷新</p>
      </div>
      <div class="page-meta">
        <span class="time" v-if="lastLoadedAt">{{ fmt(lastLoadedAt) }}</span>
        <span class="dot" :class="polling ? 'on' : 'off'" aria-hidden="true"></span>
      </div>
    </header>

    <!-- Legend + 1-line totals — operator reads these in 1 second. The
         "站点 N (Hub X · Spoke Y)" item surfaces the Hub-Spoke split (R68)
         so the operator sees the architecture shape at a glance. R80: the
         4 colored squares now mirror the per-DC sub-grid vocabulary so
         the operator reads the legend → the cell colors in 1 step. -->
    <div class="legend" data-test="legend">
      <span class="legend-item">
        <span class="swatch swatch-ok"></span>正常 <strong>{{ totals.ok }}</strong>
      </span>
      <span class="legend-item">
        <span class="swatch swatch-warn"></span>部分失败 <strong>{{ totals.warn }}</strong>
      </span>
      <span class="legend-item">
        <span class="swatch swatch-err"></span>断开 <strong>{{ totals.err }}</strong>
      </span>
      <span class="legend-item">
        <span class="swatch swatch-silent"></span>探针接入未报告 <strong>{{ totals.silent }}</strong>
      </span>
      <span class="legend-divider"></span>
      <span class="legend-item muted" data-test="legend-sites">
        站点 <strong>{{ totals.sites }}</strong>
        <span class="hub-tag-mini">Hub {{ hubSites.length }}</span>
        <span class="spoke-tag-mini">Spoke {{ spokeSites.length }}</span>
      </span>
      <span class="legend-item muted">域控 <strong>{{ totals.dcs }}</strong></span>
      <span class="legend-item muted">链路 <strong>{{ totals.links }}</strong></span>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>

    <div v-if="!primaries.length && !error" class="empty">暂无站点 — 请在 AD 站点清单添加</div>

    <!-- ── Panel 1: 核心层 Hub ↔ Hub (R68 layered matrix). ─────────────
         Only renders when ≥ 2 Hubs (a single Hub would be a self-loop).
         Hub↔Hub is the load-bearing layer: failures here fan out to every
         Spoke. Cells get extra visual emphasis (gold tint + thicker border)
         via the `.cell-hub-pair` modifier. R80: each cell renders the
         per-DC sub-grid (Hub DCs × Hub DCs). -->
    <section
      v-if="hubSites.length >= 2"
      class="layer-panel hub-panel"
      data-test="hub-panel"
    >
      <header class="layer-header">
        <h3 class="layer-title">核心层 (Hub ↔ Hub)</h3>
        <span class="layer-tag hub-tag">承载层 · {{ hubSites.length }} 中心</span>
      </header>
      <p class="layer-sub">核心站点相互复制,这是 Hub-Spoke 架构的"承载层",故障会立即放大到所有分支。</p>
      <div class="matrix-wrap">
        <table class="matrix hub-matrix">
          <thead>
            <tr>
              <th class="col-head col-corner" rowspan="2" aria-hidden="true" style="visibility: hidden;"></th>
              <th class="col-head col-corner" rowspan="2" aria-hidden="true" style="visibility: hidden;"></th>
              <th
                v-for="(c, ci) in hubAxis"
                :key="`hub-colsite-${c.siteName}-${ci}`"
                v-show="c.isFirst"
                scope="col"
                class="col-head col-site-head hub-col-head"
                :colspan="c.dcCount"
                :title="c.siteName"
              >
                <div class="col-name">{{ c.siteName }}</div>
              </th>
            </tr>
            <tr>
              <th
                v-for="(c, ci) in hubAxis"
                :key="`hub-coldc-${c.dcName}-${ci}`"
                scope="col"
                class="col-head hub-col-head col-dc-head"
                :title="`${c.siteName} · ${c.dcName}`"
              >
                <div class="col-dc-name">{{ c.dcName }}</div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, ri) in hubAxis" :key="`hub-row-${r.dcName}-${ri}`" class="matrix-row" :data-test="`matrix-row-hub-${r.siteName}-${r.dcName}`">
              <th
                v-if="r.isFirst"
                scope="rowgroup"
                class="row-head row-site-head hub-row-head"
                :rowspan="r.dcCount"
                :title="r.siteName"
                :data-test="`matrix-rowsite-hub-${r.siteName}`"
              >
                <div class="row-name">{{ r.siteName }}</div>
              </th>
              <th
                scope="row"
                class="row-head row-dc-head hub-row-head"
                :title="`${r.siteName} · ${r.dcName}`"
              >
                <div class="row-dc-name">{{ r.dcName }}</div>
              </th>
              <td
                v-for="(c, ci) in hubAxis"
                :key="`hub-cell-${r.dcName}-${c.dcName}-${ri}-${ci}`"
                :class="['cell', `cell-${dcPairState(r.dcName, c.dcName, r.siteName, c.siteName)}`, 'cell-hub-pair']"
                :data-test="`cell-${r.siteName}-${r.dcName}-to-${c.siteName}-${c.dcName}`"
                :title="dcPairTooltip(r.dcName, c.dcName, r.siteName, c.siteName)"
                @click="handleDcPairClick(r.dcName, c.dcName, r.siteName, c.siteName)"
              >
                <span class="dc-pair-glyph">{{ dcPairGlyph(r.dcName, c.dcName, r.siteName, c.siteName) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── Panel 2: 接入层 Spoke → Hub. ────────────────────────────────
         Each Spoke row × each Hub col shows whether the Spoke is inbound-
         replicating from each Hub. Inbound-only: cellState(src=Spoke, dst=Hub)
         = is Spoke receiving from Hub. The reverse direction (Hub receiving
         from Spoke) is the "designed absence" — only visible in panel 3.
         R80: per-DC sub-grid (Spoke DCs × Hub DCs). -->
    <section
      v-if="spokeSites.length && hubSites.length"
      class="layer-panel spoke-panel"
      data-test="spoke-panel"
    >
      <header class="layer-header">
        <h3 class="layer-title">接入层 ({{ props.direction === 'outbound' ? 'Hub → Spoke' : 'Hub ← Spoke' }})</h3>
        <span class="layer-tag spoke-tag">中心 ↔ 分支 · {{ hubSites.length }} 中心 · {{ spokeSites.length }} 分支</span>
      </header>
      <p class="layer-sub">核心站点与分支站点之间的{{ props.direction === 'outbound' ? '出战' : '入站' }}复制状态 — 行=核心 DC，列=分支 DC。Spoke↔Spoke 违反 Hub-Spoke 不应出现。</p>
      <div class="matrix-wrap">
        <table class="matrix spoke-matrix">
          <thead>
            <tr>
              <th class="col-head col-corner" rowspan="2" aria-hidden="true" style="visibility: hidden;"></th>
              <th class="col-head col-corner" rowspan="2" aria-hidden="true" style="visibility: hidden;"></th>
              <th
                v-for="(c, ci) in spokeAxis"
                :key="`spoke-colsite-${c.siteName}-${ci}`"
                v-show="c.isFirst"
                scope="col"
                class="col-head col-site-head spoke-col-head"
                :colspan="c.dcCount"
                :title="c.siteName"
              >
                <div class="col-name">{{ c.siteName }}</div>
              </th>
            </tr>
            <tr>
              <th
                v-for="(c, ci) in spokeAxis"
                :key="`spoke-coldc-${c.dcName}-${ci}`"
                scope="col"
                class="col-head spoke-col-head col-dc-head"
                :title="`${c.siteName} · ${c.dcName}`"
              >
                <div class="col-dc-name">{{ c.dcName }}</div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, ri) in hubAxis" :key="`spoke-row-${r.dcName}-${ri}`" class="matrix-row" :data-test="`spoke-row-${r.siteName}-${r.dcName}`">
              <th
                v-if="r.isFirst"
                scope="rowgroup"
                class="row-head row-site-head hub-row-head"
                :rowspan="r.dcCount"
                :title="r.siteName"
                :data-test="`spoke-rowsite-${r.siteName}`"
              >
                <div class="row-name">{{ r.siteName }}</div>
              </th>
              <th
                scope="row"
                class="row-head row-dc-head hub-row-head"
                :title="`${r.siteName} · ${r.dcName}`"
              >
                <div class="row-dc-name">{{ r.dcName }}</div>
              </th>
              <td
                v-for="(c, ci) in spokeAxis"
                :key="`spoke-cell-${r.dcName}-${c.dcName}-${ri}-${ci}`"
                :class="['cell', `cell-${dcPairState(r.dcName, c.dcName, r.siteName, c.siteName)}`, 'cell-hub-spoke']"
                :data-test="`cell-${r.siteName}-${r.dcName}-to-${c.siteName}-${c.dcName}`"
                :title="dcPairTooltip(r.dcName, c.dcName, r.siteName, c.siteName)"
                @click="handleDcPairClick(r.dcName, c.dcName, r.siteName, c.siteName)"
              >
                <span class="dc-pair-glyph">{{ dcPairGlyph(r.dcName, c.dcName, r.siteName, c.siteName) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── Panel 3: 全矩阵 (所有站点). ──────────────────────────────────
         The original R60 N×N matrix. Preserved verbatim for deep-dive use:
         every site pair is visible, including Spoke↔Spoke (which R68 marks
         as "designed absence" — these cells SHOULD be empty in Hub-Spoke
         compliance). The view stays fully compatible with the existing
         test selectors (`data-test="cell-X-Y"` resolves here). R80:
         each non-self cell renders the per-DC sub-grid; self cells
         keep the original glyph + "—". -->
    <section
      v-if="sites.length"
      class="layer-panel full-panel"
      data-test="full-panel"
    >
      <header class="layer-header">
        <h3 class="layer-title">全矩阵 (所有站点)</h3>
        <span class="layer-tag">完整视图 · {{ sites.length }} 站点 × {{ sites.length }} 站点</span>
      </header>
      <div class="matrix-wrap">
        <table class="matrix">
          <thead>
            <tr>
              <th class="col-head col-corner" rowspan="2" aria-hidden="true" style="visibility: hidden;"></th>
              <th class="col-head col-corner" rowspan="2" aria-hidden="true" style="visibility: hidden;"></th>
              <th
                v-for="(c, ci) in fullAxis"
                :key="`colsite-${c.siteName}-${ci}`"
                v-show="c.isFirst"
                scope="col"
                class="col-head col-site-head"
                :colspan="c.dcCount"
                :title="c.siteName"
              >
                <div class="col-name">{{ c.siteName }}</div>
              </th>
            </tr>
            <tr>
              <th
                v-for="(c, ci) in fullAxis"
                :key="`coldc-${c.dcName}-${ci}`"
                scope="col"
                class="col-head col-dc-head"
                :title="`${c.siteName} · ${c.dcName}`"
              >
                <div class="col-dc-name">{{ c.dcName }}</div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, ri) in fullAxis" :key="`row-${r.dcName}-${ri}`" class="matrix-row" :data-test="`matrix-row-${r.siteName}-${r.dcName}`">
              <th
                v-if="r.isFirst"
                scope="rowgroup"
                class="row-head row-site-head"
                :rowspan="r.dcCount"
                :title="r.siteName"
                :data-test="`matrix-rowsite-${r.siteName}`"
              >
                <div class="row-name">{{ r.siteName }}</div>
              </th>
              <th
                scope="row"
                class="row-head row-dc-head"
                :title="`${r.siteName} · ${r.dcName}`"
              >
                <div class="row-dc-name">{{ r.dcName }}</div>
              </th>
              <td
                v-for="(c, ci) in fullAxis"
                :key="`cell-${r.dcName}-${c.dcName}-${ri}-${ci}`"
                :class="['cell', `cell-${dcPairState(r.dcName, c.dcName, r.siteName, c.siteName)}`, { 'cell-self': r.dcName === c.dcName && r.siteName === c.siteName }]"
                :data-test="`cell-${r.siteName}-${r.dcName}-to-${c.siteName}-${c.dcName}`"
                :title="dcPairTooltip(r.dcName, c.dcName, r.siteName, c.siteName)"
                @click="handleDcPairClick(r.dcName, c.dcName, r.siteName, c.siteName)"
              >
                <span class="dc-pair-glyph">{{ dcPairGlyph(r.dcName, c.dcName, r.siteName, c.siteName) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── R71: cell-detail modal ───────────────────────────────────────
         Click any non-self cell in any of the 3 panels to drill into the
         underlying DC pairs of that site-pair. Lists every (sourceDc →
         destDc) link with status pill + last success + error message.
         Backdrop click (.self) closes; ESC support in the script.
         R80: clicking a dc-pair-cell in a non-self cell highlights the
         matching pair row in the modal (via .pair-row-highlighted). -->
    <div
      v-if="cellDetail"
      class="modal-bg"
      @click.self="closeCellModal"
      data-test="cell-detail-modal"
    >
      <div class="modal cell-detail-modal" @keydown.esc="closeCellModal">
        <header class="modal-header">
          <h3 class="modal-title" data-test="cell-detail-title">
            {{ cellDetail.srcSite }} → {{ cellDetail.dstSite }}
          </h3>
          <p class="modal-meta" data-test="cell-detail-meta">
            <span class="layer-tag-inline" v-if="cellDetail.layerTag">{{ cellDetail.layerTag }}</span>
            {{ cellDetail.pairs.length }} 条链路
            <span v-if="highlightedPair" class="r80-highlight-tag" data-test="cell-detail-highlight-tag">
              · 高亮 {{ highlightedPair.sourceDc }} → {{ highlightedPair.destDc }}
            </span>
          </p>
        </header>

        <div
          v-if="!cellDetail.pairs.length"
          class="empty"
          data-test="cell-detail-empty"
        >
          两站点之间暂无复制链路
        </div>

        <!-- R73: pair-toolbar with status filter + date range chips -->
        <div class="pair-toolbar" data-test="pair-toolbar">
          <div class="pair-filter-chips" role="group" aria-label="按状态过滤">
            <button
              :class="['pair-chip', pairFilter === 'all' ? 'pair-chip-active' : '']"
              type="button"
              data-test="pair-filter-all"
              @click="pairFilter = 'all'"
            >全部</button>
            <button
              :class="['pair-chip', pairFilter === 'ok' ? 'pair-chip-active' : '']"
              type="button"
              data-test="pair-filter-ok"
              @click="pairFilter = 'ok'"
            >成功</button>
            <button
              :class="['pair-chip', pairFilter === 'fail' ? 'pair-chip-active' : '']"
              type="button"
              data-test="pair-filter-fail"
              @click="pairFilter = 'fail'"
            >失败+部分失败</button>
          </div>
          <div class="pair-window-chips" role="group" aria-label="时间范围">
            <button
              :class="['pair-chip', pairWindowHours === 24 ? 'pair-chip-active' : '']"
              type="button"
              data-test="pair-window-24"
              @click="pairFilterWindow(24)"
            >24h</button>
            <button
              :class="['pair-chip', pairWindowHours === 168 ? 'pair-chip-active' : '']"
              type="button"
              data-test="pair-window-168"
              @click="pairFilterWindow(168)"
            >7d</button>
          </div>
        </div>

        <table v-if="cellDetail.pairs.length" class="pair-table" data-test="cell-detail-table">
          <thead>
            <tr>
              <th class="pair-caret-col"></th>
              <th>DC 链路</th>
              <th>当前状态</th>
              <th>最近成功</th>
              <th>最近尝试</th>
              <th>错误/详情</th>
            </tr>
          </thead>
          <tbody>
            <template
              v-for="(p, i) in filteredCellDetail.pairs"
              :key="`${p.sourceDc}-${p.destDc}`"
            >
              <tr
                :class="['pair-row', `pair-row-${p.statusClass}`, 'pair-row-expandable', isPairExpanded(p.sourceDc, p.destDc) ? 'pair-row-open' : '', isHighlightedPair(p.sourceDc, p.destDc) ? 'pair-row-highlighted' : '']"
                :data-test="`cell-detail-pair-${i}`"
                @click="togglePairExpansion(p.sourceDc, p.destDc)"
              >
                <td class="pair-caret-col">
                  <button
                    class="pair-caret-btn"
                    :data-test="`pair-caret-${i}`"
                    :aria-label="isPairExpanded(p.sourceDc, p.destDc) ? '收起历史' : '展开历史'"
                    type="button"
                  >{{ isPairExpanded(p.sourceDc, p.destDc) ? '▾' : '▸' }}</button>
                </td>
                <td class="pair-dcs">{{ p.sourceDc }} → {{ p.destDc }}</td>
                <td>
                  <span class="status-pill" :class="`status-pill-${p.statusClass}`">
                    {{ p.statusLabel }}
                  </span>
                </td>
                <td>{{ fmt(p.lastSuccessTime) }}</td>
                <td>{{ fmt(p.lastAttemptTime) }}</td>
                <td class="pair-error">{{ p.errorMessage || '—' }}</td>
              </tr>
              <tr
                v-if="isPairExpanded(p.sourceDc, p.destDc)"
                class="pair-row-attempts"
                :data-test="`pair-attempts-${i}`"
              >
                <td colspan="6">
                  <!-- Loading state (only first time we open this pair) -->
                  <div
                    v-if="pairLoading === pairExpandKey(p.sourceDc, p.destDc, pairWindowHours)"
                    class="attempts-loading"
                    :data-test="`pair-attempts-loading-${i}`"
                  >加载中…</div>
                  <!-- Error state (rare — backend 500 or network) -->
                  <div
                    v-else-if="pairErrorFor(p.sourceDc, p.destDc, pairWindowHours)"
                    class="attempts-error"
                    :data-test="`pair-attempts-error-${i}`"
                  >{{ pairErrorFor(p.sourceDc, p.destDc, pairWindowHours) }}</div>
                  <!-- Empty state (no 24h/7d attempts) -->
                  <div
                    v-else-if="!pairAttemptsBy(p.sourceDc, p.destDc, pairWindowHours).length"
                    class="attempts-empty"
                    :data-test="`pair-attempts-empty-${i}`"
                  >{{ pairWindowHours === 24 ? '24h' : '7d' }} 内暂无复制尝试记录</div>
                  <!-- Attempts sub-table (happy path) -->
                  <div v-else class="attempts-area" :data-test="`pair-attempts-area-${i}`">
                    <div class="attempts-toolbar">
                      <span class="attempts-count">
                        {{ pairFilteredAttempts(p.sourceDc, p.destDc).length }} 条
                        <template v-if="pairFilteredAttempts(p.sourceDc, p.destDc).length !== pairAttemptsBy(p.sourceDc, p.destDc, pairWindowHours).length">
                          / 共 {{ pairAttemptsBy(p.sourceDc, p.destDc, pairWindowHours).length }} 条
                        </template>
                      </span>
                      <button
                        class="pair-csv-btn"
                        type="button"
                        :data-test="`pair-csv-${i}`"
                        @click.stop="exportPairCsv(p.sourceDc, p.destDc)"
                      >导出 CSV</button>
                    </div>
                    <table class="attempts-table" :data-test="`pair-attempts-table-${i}`">
                      <thead>
                        <tr>
                          <th>尝试时间</th>
                          <th>结果</th>
                          <th>耗时 (ms)</th>
                          <th>传输对象</th>
                          <th>最近成功</th>
                          <th>错误/详情</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr
                          v-for="(a, j) in pairFilteredAttempts(p.sourceDc, p.destDc)"
                          :key="j"
                          :class="['att-row', `att-row-${pairStatusClass(a)}`]"
                          :data-test="`pair-attempt-${i}-${j}`"
                        >
                        <td class="att-time">{{ fmt(a.attemptAt) }}</td>
                        <td class="att-result">
                          <span class="glyph" :class="`glyph-${pairStatusClass(a)}`">{{ pairGlyph(a) }}</span>
                          {{ pairLabel(a) }}
                        </td>
                        <td class="att-dur">{{ a.durationMs ?? '—' }}</td>
                        <td class="att-objects">{{ a.objectsTransferred ?? '—' }}</td>
                        <td>{{ fmt(a.lastSuccessTime) }}</td>
                        <td class="att-error">{{ a.errorMessage || '—' }}</td>
                      </tr>
                    </tbody>
                  </table>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>

        <footer class="modal-footer">
          <button class="btn-close" @click="closeCellModal" data-test="cell-detail-close">
            关闭
          </button>
        </footer>
      </div>
    </div>
  </AppLayout>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import AppLayout from '../../components/AppLayout.vue';
import { dashboardApi } from '../../api/dashboard.js';

// R153 — `direction` selects the matrix lens. Defaults to 'inbound' to
// match the historical behaviour before the page split (rows = receiving
// DCs, cols = partners replicating INTO them). 'outbound' flips the view
// (rows = sending DCs, cols = partners they replicate OUT to).
const props = defineProps({
  direction: { type: String, default: 'inbound', validator: (v) => v === 'inbound' || v === 'outbound' }
});

const primaries = ref([]);
const refreshSeconds = ref(10);
const lastLoadedAt = ref(null);
const error = ref('');
const polling = ref(false);

// ── R71: cell-detail modal state ────────────────────────────────────────
// `clickedCell` is the (srcSite, dstSite) tuple of the currently open modal,
// or null when closed. We avoid putting the partner list directly into the
// ref because that data lives in cellMap (a computed) and re-deriving it
// every render is cheaper than caching — small payload.
const clickedCell = ref(null);

// R80: when the operator clicks a specific dc-pair-cell (instead of the
// outer cell), we remember that (sourceDc, destDc) so the modal can
// highlight the matching row. Cleared on cell-level click + on close +
// on poll refresh so the highlight never lingers past its context.
const highlightedPair = ref(null);

// ── R72: per-pair history expansion (inside the cell-detail modal). ────
// `expandedPairs` is the set of `${srcDc}|${dstDc}` keys that the operator
// has clicked open. `pairAttempts` is a Map of the same key → entries[]
// already fetched from `/pair-history`. `pairLoading` holds the single
// currently-fetching key (or null) so we can show a spinner inline. The
// Map is reset on primaries refresh so we never display stale history.
const expandedPairs = ref(new Set());
const pairAttempts  = ref(new Map());
const pairLoading   = ref(null);
const pairErrors    = ref(new Map());

// ── R73: pair-toolbar state (status filter + date range). ──────────────
// `pairFilter` is a single-select string ('all' | 'ok' | 'fail'). It applies
// to the pair-table itself (filteredCellDetail pairs) AND to the attempts
// sub-table (pairFilteredAttempts). Default 'all' = show everything.
// `pairWindowHours` is 24 or 168 (= 7d). Drives the R45 endpoint `limit`
// (10 for 24h, 50 for 7d) and is part of the cache key so 24h and 7d don't
// collide. Default 24 = match R72 baseline behavior.
const pairFilter = ref('all');
const pairWindowHours = ref(24);

let timerHandle = null;

// ── Site list (preserves backend order). Includes isHub so the Hub/Spoke
//    partition (R68) can split sites into the two layered panels below. ──
const sites = computed(() => primaries.value.map(p => ({
  siteName: p.siteName,
  dcCount: (p.dcs || []).length,
  isHub: !!p.isHub
})));

// ── Hub / Spoke partition (R68 Hub-Spoke layered matrix). ─────────────
// Backend already tags each primary with isHub (= ad_sites.is_hub, sourced
// from the SQL JOIN at /api/dashboard/site-replication-matrix/all).
// Order is preserved (backend's allSitesOrdered helper) so Hubs lead the
// panel 1 mesh; Spokes trail behind in panel 2.
const hubSites   = computed(() => sites.value.filter(s => s.isHub));
const spokeSites = computed(() => sites.value.filter(s => !s.isHub));

// Set lookup so isHubPair is O(1) per call (cell renderers call it many
// times per matrix). Recomputes only when hubSites changes.
const hubSiteSet = computed(() => new Set(hubSites.value.map(s => s.siteName)));

// Both endpoints are Hub? Used to apply the load-bearing visual emphasis
// (gold-tinted background + thicker border) to Hub↔Hub cells.
function isHubPair(siteA, siteB) {
  const set = hubSiteSet.value;
  return set.has(siteA) && set.has(siteB);
}

// ── Site → DC names index (R80). Single pass; cells call dcsOf(siteName)
// many times per render so we cache as a Map. Recomputes only when
// primaries change (same trigger as cellMap). Returns an array of DC
// names preserving the backend's bridgehead-priority + lex order
// (computed at the SQL layer; see dashboard.js dcsBySite sort). ──
const dcsBySiteMap = computed(() => {
  const map = new Map();
  for (const p of primaries.value) {
    map.set(p.siteName, (p.dcs || []).map(d => d.dcName));
  }
  return map;
});

function dcsOf(siteName) {
  return dcsBySiteMap.value.get(siteName) || [];
}

// R133: 把 sites 展开成 DC-level 行/列,每台 DC 占一行/一列.
// 同站点的 DC 共享站点组标题(用 rowspan/colspan 在面板里实现).
// 每个轴条目:{ siteName, dcName, dcIndex, dcCount }.
// `dcIndex` 是 DC 在站点内的顺序(0-based),用于做 colspan/rowspan
// 标记 (同站点除首行/首列外的 dc 都设 isFirst=false).
const axisEntries = (sitesArr) => {
  const out = [];
  for (const s of sitesArr) {
    const dcs = dcsOf(s.siteName);
    dcs.forEach((dc, i) => {
      out.push({
        siteName: s.siteName,
        dcName: dc,
        dcCount: dcs.length,
        isFirst: i === 0,
        isLast: i === dcs.length - 1
      });
    });
  }
  return out;
};
const hubAxis   = computed(() => axisEntries(hubSites.value));
const spokeAxis = computed(() => axisEntries(spokeSites.value));
const fullAxis  = computed(() => axisEntries(sites.value));

// R80: data-test attribute slug for a DC name. DC names can contain
// characters that aren't legal in HTML data-* attribute values (dots,
// forward slashes, etc.) — we replace them with underscores so the
// resulting selector is CSS-safe and stable across mounts.
function dcSlug(dcName) {
  return String(dcName).replace(/[^a-zA-Z0-9_-]/g, '_');
}

// ── Build (sourceSite|destSite) → partner[] from the loaded payload. ──
// Single pass over the payload; cells look up their partner list from
// this map. Empty partner list = no link between the two sites.
// R80: same map is reused for dc-pair-cell state lookups
// (dcPairState / dcPairGlyph / dcPairTooltip). Each entry already carries
// sourceDc + destDc, so per-DC state is a .find() over the array.
// cellMap aggregates all partner links for each (srcSite, dstSite) pair.
// Each entry captures the per-direction DB identities:
//   sourceDc = the partner's DB source_dc (i.e. dc.dcName, the catalog
//     DC that initiated the replication attempt)
//   destDc   = the partner's DB dest_dc   (i.e. partner.peerDc, the peer
//     that received the attempt)
// Display direction in the matrix is "row-dc → peer-dc" (DC of the row
// sends to its peer). The pair-history API contract is
// getSiteReplicationMatrixPairHistory(destDc, sourceDc, limit), which
// matches the DB identities directly — see R72 test expectations and
// the route's `WHERE source_dc = ? AND dest_dc = ?` at
// sql.js:201 (MySQL) / :1166 (MSSQL).
// R158.20 (2026-10-01) — probeState → statusCode 适配.
//
// 后端 R158.14 把 partner entry 数据源从 ad_replication_status (probe 30min)
// 换成 v_partner_inbound (discover 30天 + 15min probe LEFT JOIN). 新 wire shape
// 不再含 status_code / last_success_time / last_attempt_time / error_message,
// 改用 probeState ('success'|'error'|'partial'|'none') + probeAttemptAt +
// probeErrorMessage (R158.15 接入). 前端 cellMap 仍消费 statusCode 形式
// (下游 dcPairState / worstStatus / cellText / cellTooltip / cellDetail 都
// 按 0=ok / 1=warn / 2+=err 编码), 所以这里一次性翻译, 下游逻辑零改动.
//
// 映射 (R158.15 / SiteReplicationMatrixAllView:statusClass 同源):
//   probeState=success → statusCode=0 (green)
//   probeState=partial → statusCode=1 (yellow, 部分失败)
//   probeState=error   → statusCode=2 (red)
//   probeState=none    → statusCode=3 (R158.X.99-silent 标红 — 探针接入 0 报告,
//                                       跟 "DB 没 link row" 不再合并灰格)
//
// lastAttemptTime 兼容: probe 包产出 15min cadence, 但 v_partner_inbound
// probe_attempt_at 字段就是最近一次 attempt — 语义一致.
//
// R158.X.99-silent (2026-10-21) — 操作员 /matrix/inbound 反馈: "有链路但
// 没有报告状态,需要标记为红色" — 即 probeState='none' (探针接入了但
// 0 probe 数据) 标红. 之前 R158.20 把 statusCode=3 跟 "DB 无 link row"
// 合并成灰色 cell-none, 误压一档. matrix grid 必须把这两态严格分色:
//   - 无 partner row (DB 拓扑从未发现) → cell-none 灰
//   - probeState='none' (拓扑有, 探针 0 报告) → cell-silent 红
//   wire-shape statusCode=3 既不启用 (前端 dcPairState 用 statusCode
//   fallback 走 cell-none), 翻译这一层也不再消除差异. 0/1/2 保持
//   原样不动 (跟 SiteReplicationMatrixAllView.statusClass 仍是平行的
//   派生, 不污染 list 视图).
function probeStateToStatusCode(s) {
  if (s === 'success') return 0;
  if (s === 'partial') return 1;
  if (s === 'error')   return 2;
  if (s === 'none')    return 3; // 拓扑有 + 0 报告 (矩阵标红, list 仍灰)
  return 3; // 未知也兜底 'none' 灰
}

// statusCodeToCellClass — 把 statusCode 翻成矩阵 cell 用的 class 字符串.
//   0=ok / 1=warn / 2=err / 3=silent (R158.X.99 新) / 兜底 none (无 partner row).
//   关键: `dcPairState` 不再是 statusCode 直查表 (老逻辑 statusCode=3 →
//   'none' 灰), 而是先 `find(partner)`, partner 缺失 → 'none' 灰,
//   partner 在 → 走 statusCodeToCellClass(partner.statusCode) → silent 红.
//   这样无 partner vs 无报告两态在 matrix 视觉上彻底分开.
function statusCodeToCellClass(sc) {
  if (sc === 0) return 'ok';
  if (sc === 1) return 'warn';
  if (sc === 2) return 'err';
  if (sc === 3) return 'silent'; // R158.X.99-silent 关键改
  return 'none';                  // 未知 statusCode 也走灰 (跟 R158.20 一致)
}

const cellMap = computed(() => {
  const map = new Map();
  for (const p of primaries.value) {
    for (const dc of (p.dcPartners || [])) {
      for (const partner of dc.partners) {
        const key = `${p.siteName}|${partner.peerSite}`;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({
          sourceDc: dc.dcName,
          destDc: partner.peerDc,
          // R158.20 — 从 probeState 翻译, 缺失 / 'none' → 3 (灰色), 不会落
          // 入 err 红. 老 wire shape statusCode 字段在 R158.14 后端不再返回,
          // 直接读 partner.statusCode 永远是 undefined → 全部 err 红色.
          statusCode: probeStateToStatusCode(partner.probeState),
          // R158.20 — probe 包接入后只有 probeAttemptAt, 没有 lastSuccessTime
          // 单独字段. 用 probeAttemptAt 同时充当 lastAttemptTime (语义对齐:
          // "最近一次探针执行时间"). dcPairTooltip / cellTooltip 显示文案
          // 改成 "最近检测" 更准, 这里先保留 lastSuccessTime 字段名以免下
          // 游引用报错, 实际值是 probeAttemptAt.
          lastSuccessTime: partner.probeAttemptAt,
          lastAttemptTime: partner.probeAttemptAt,
          errorMessage: partner.probeErrorMessage
        });
      }
    }
  }
  return map;
});

function key(srcSite, dstSite) { return `${srcSite}|${dstSite}`; }
function partners(srcSite, dstSite) {
  return cellMap.value.get(key(srcSite, dstSite)) || [];
}

// Worst status across all partner links for a cell. statusCode
// semantics (R158.20 wire-shape + R158.X.99-silent 修订):
//   0 = success (green)
//   1 = partial failure (yellow)
//   2 = failure (red)
//   3 = silent (probeState='none' — 探针接入 0 报告; matrix 标红, 但
//                外层 worstStatus 升 warn 让 outer cell 边框色不至于
//                仍 ok 隐藏告警; 内层 dc-pair cell 已经是 silent 红)
// Empty list = "no link between sites" (gray).
//
// R158.X.99-silent (2026-10-21) — R158.20 把 statusCode=3 (=probeState=
// 'none') `continue` 跳过 (不升级), 那时跟 "DB 无 link row" 合并一档
// 灰色. R158.X.99-silent 把这两态拆开: 无 partner row 走 cell-none 灰
// (本函数最顶层 `if (!parts.length)` 已经 return 'none'); 有 partner
// 但 probeState='none' → silent, 此处升 warn 让 outer cell 视觉信号
// 不丢失 (否则 silent 全被 worstStatus 压成 ok, 误以为整 cell 健康).
function worstStatus(parts) {
  if (!parts.length) return 'none';
  let worst = 'ok';
  for (const p of parts) {
    const sc = p.statusCode;
    if (sc === 0) continue;
    if (sc === 3) {
      // R158.X.99-silent — silent 升 warn, 让 outer cell 边框色至少黄.
      // 内层 dc-pair 已 silent 红, 视觉信号不会丢.
      if (worst === 'ok') worst = 'warn';
      continue;
    }
    if (sc === 1) { if (worst === 'ok') worst = 'warn'; }
    else { worst = 'err'; break; }
  }
  return worst;
}

function cellState(srcSite, dstSite) {
  if (srcSite === dstSite) return 'self';
  return worstStatus(partners(srcSite, dstSite));
}

// ── R80: per-DC state (one (srcDc → dstDc) link). Used by every inner
// dc-pair-cell in the sub-grid. Lookup is O(N) over the partner list
// (small — typically ≤ 4 entries); we accept the cost to avoid a second
// parallel data structure that would have to be kept in sync with
// cellMap. Returns 'ok' / 'warn' / 'err' / 'none' matching the same
// statusCode vocabulary as cellState.
// The dcPair- prefix keeps these helpers out of the way of the existing
// R72 pairGlyph(a) / pairStatusClass(a) helpers below, which render the
// attempt sub-table inside the modal. ──
function dcPairState(rowDc, colDc, srcSite, dstSite) {
  const parts = cellMap.value.get(key(srcSite, dstSite)) || [];
  const partner = parts.find(p => p.sourceDc === rowDc && p.destDc === colDc);
  // R158.X.99-silent (2026-10-21) — partner 缺失才走 'none' 灰 (DB
  // 拓扑根本没发现这条 link). partner 在 → 走 statusCodeToCellClass
  // 翻译, statusCode=3 (probeState='none') 翻 'silent' 红 (探针接入
  // 但 0 报告). 这样无链路 vs 接入无报告两态严格分色, 操作员在矩阵
  // 上一眼分得清.
  if (!partner) return 'none';
  return statusCodeToCellClass(partner.statusCode);
}

function dcPairGlyph(rowDc, colDc, srcSite, dstSite) {
  const s = dcPairState(rowDc, colDc, srcSite, dstSite);
  // R158.X.99-silent (2026-10-21) — silent glyph ⊙ 跟 err ✕, none —
  //   严格分视觉 (同色靠 glyph 跟 tooltip 文本分语义, 详见 dcPairTooltip).
  if (s === 'ok')     return '✓';
  if (s === 'warn')   return '!';
  if (s === 'err')    return '✕';
  if (s === 'silent') return '⊙'; // 探针接入 0 报告
  return '—';                      // 灰 — DB 无 link row
}

// Tooltip for one DC pair: state + last probe + error message.
// R158.20 — wire shape 用 probeAttemptAt (R158.14 后), "最近成功" 改成
// "最近检测" 准确. statusCode=3 (none) 显示 "待接入探针".
function dcPairTooltip(rowDc, colDc, srcSite, dstSite) {
  const parts = cellMap.value.get(key(srcSite, dstSite)) || [];
  const partner = parts.find(p => p.sourceDc === rowDc && p.destDc === colDc);
  if (!partner) {
    return `${rowDc} → ${colDc}\n无复制链路`;
  }
  // R158.X.99-silent (2026-10-21) — probeState='none' 跟 probeState='error'
  // 同色但 tooltip 文案严格区分: silent = "探针接入无报告" (配置问题 /
  // agent 卡住), err = "失败" (复制真挂, status_code=2). 操作员 hover 一
  // 下就分得清, 不致误判方向去重启不该重启的 agent.
  const state = partner.statusCode === 0 ? '✓ 健康'
              : partner.statusCode === 1 ? '! 部分失败'
              : partner.statusCode === 2 ? '✕ 失败'
              : partner.statusCode === 3 ? '⊙ 探针接入无报告 (srcDC 端 0 probe 数据)'
              : '✕ 失败';
  const err = partner.errorMessage ? ` — ${partner.errorMessage}` : '';
  const last = partner.lastAttemptTime
    ? ` · 最近检测 ${fmt(partner.lastAttemptTime)}`
    : ' · 暂无检测记录';
  return `${rowDc} → ${colDc}\n${state}${last}${err}`;
}

// Cell content: glyph + "ok/total" ratio. Diagonal = "-" (self).
// R80: still used for self cells (which don't get a sub-grid).
function cellGlyph(srcSite, dstSite) {
  if (srcSite === dstSite) return '·';
  const s = cellState(srcSite, dstSite);
  if (s === 'ok')   return '✓';
  if (s === 'warn') return '!';
  if (s === 'err')  return '✕';
  return '·';
}
function cellText(srcSite, dstSite) {
  if (srcSite === dstSite) return '—';
  const parts = partners(srcSite, dstSite);
  if (!parts.length) return '—';
  const ok = parts.filter(p => p.statusCode === 0).length;
  return `${ok}/${parts.length}`;
}

// Tooltip on hover: list of partner links with status + last probe.
// R158.20 — wire shape 用 probeAttemptAt, "最近成功" 改成 "最近检测".
// statusCode=3 (none) 在 tooltip 也用 · 灰色标记 (跟 cell 灰格一致).
// R80: still used as the outer cell title (full site-pair summary).
function cellTooltip(srcSite, dstSite) {
  if (srcSite === dstSite) return `${srcSite} (本站内)`;
  const parts = partners(srcSite, dstSite);
  if (!parts.length) return `${srcSite} → ${dstSite}\n无复制链路`;
  const lines = [`${srcSite} → ${dstSite}  · ${parts.length} 条链路`];
  for (const p of parts) {
    const state = p.statusCode === 0 ? '✓'
                : p.statusCode === 1 ? '!'
                : p.statusCode === 3 ? '·'
                : '✕';
    const err = p.errorMessage ? ` — ${p.errorMessage}` : '';
    const last = p.lastAttemptTime
      ? ` · 最近检测 ${fmt(p.lastAttemptTime)}`
      : ' · 暂无检测记录';
    lines.push(`${state} ${p.sourceDc} → ${p.destDc}${last}${err}`);
  }
  return lines.join('\n');
}

// Fleet-level totals for the legend strip + summary line. Cheap
// one-pass over the payload; recomputes whenever primaries change.
// R80: the "links" total is still the total of (srcDc → dstDc) pairs
// — i.e., the same thing the per-DC sub-grid renders one square for.
// Renamed the legend label from 链路 → 域控对 so the legend reflects
// the per-DC vocabulary the operator now sees in every cell.
// R158.20 — probeStatusCode === 3 (none / 待接入探针) 不计入 err, 不显示
// 在 legend 任何桶里. 旧 30min 数据源 statusCode 永远是 0/1/2, 这层
// 灰色之前没区分.
// R158.X.99-silent (2026-10-21) — probeStatusCode === 3 单独计 silent
// 桶, 显示在 legend ("探针接入未报告 N"). 操作员要在矩阵顶上一眼
// 数出"哪些 dc-pair 只接入了探针没跑 probe"。跟 err 不同桶: 一个是
// 配置/agent 卡, 一个是复制真挂, 排查方向不同 (silent 先查 agent
// service; err 先查 KB replication). 跟 list 视图的 silent reporter
// (R158.103.1 livenessByAgent) 不重叠 — 那个是 reporter 端 4h+ 无
// 心跳, 这个是 reporter 端 active 但就是没 report 数据.
const totals = computed(() => {
  let sites = 0, dcs = 0, links = 0, ok = 0, warn = 0, err = 0, silent = 0;
  for (const p of primaries.value) {
    sites++;
    dcs += (p.dcs || []).length;
    for (const dc of (p.dcPartners || [])) {
      for (const partner of dc.partners) {
        links++;
        const sc = probeStateToStatusCode(partner.probeState);
        if (sc === 0) ok++;
        else if (sc === 1) warn++;
        else if (sc === 2) err++;
        else if (sc === 3) silent++;
      }
    }
  }
  return { sites, dcs, links, ok, warn, err, silent };
});

// ── R71: cell-detail modal (click cell → list of DC pairs). ────────────
// Derives a modal payload from clickedCell + cellMap + Hub/Spoke partition.
// `layerTag` enriches the meta line with the architectural layer (Hub↔Hub
// / Spoke→Hub / Full matrix) when both endpoints share the same layer —
// for the Full matrix panel we skip the tag (the cell is just one of N²
// pairs and the layer doesn't carry extra meaning).
const cellDetail = computed(() => {
  if (!clickedCell.value) return null;
  const { srcSite, dstSite } = clickedCell.value;
  const parts = partners(srcSite, dstSite);
  const isHubPairCell = isHubPair(srcSite, dstSite);
  // Layer tag: only meaningful for Hub↔Hub or Spoke→Hub cells. We can't
  // tell from cellMap alone which panel the user clicked — but we infer
  // the layer from Hub/Spoke membership, which is what the panels use.
  let layerTag = '';
  if (isHubPairCell && srcSite !== dstSite) layerTag = '核心层 Hub↔Hub';
  else if (hubSiteSet.value.has(dstSite) && !hubSiteSet.value.has(srcSite)) {
    layerTag = '接入层 Spoke→Hub';
  } else if (hubSiteSet.value.has(srcSite) && !hubSiteSet.value.has(dstSite)) {
    // R68 notes: cellMap is keyed inbound-only by `(primary site → peer site)`,
    // so Spoke→Hub direction is the only Spoke layer we surface. The reverse
    // (Hub→Spoke) is the "designed absence" (Panel 3 only).
    layerTag = '完整视图 Hub→Spoke (出战)';
  }
  return {
    srcSite,
    dstSite,
    layerTag,
    pairs: parts.map(p => ({
      sourceDc: p.sourceDc,
      destDc: p.destDc,
      // R158.X.99-silent (2026-10-21) — probeStatusCode=3 (probeState='none')
      // 走 'silent' 分支, status-pill 红/红底色. 跟 R158.20 把这层
      // 当 gray 'none' 不同; 跟 err 桶也不同 (label 区分 '断开失败' vs
      // '探针接入未报告'). 复用 CSS .status-pill-silent / .pair-row-silent
      // (style block 加在本文件).
      statusCode: p.statusCode,
      statusClass: p.statusCode === 0 ? 'ok'
                 : p.statusCode === 1 ? 'warn'
                 : p.statusCode === 2 ? 'err'
                 : p.statusCode === 3 ? 'silent'
                 : 'err',
      statusLabel: p.statusCode === 0 ? '复制成功'
                 : p.statusCode === 1 ? '部分失败'
                 : p.statusCode === 2 ? '断开失败'
                 : p.statusCode === 3 ? '探针接入未报告'
                 : '断开失败',
      lastSuccessTime: p.lastSuccessTime,
      lastAttemptTime: p.lastAttemptTime,
      errorMessage: p.errorMessage
    }))
  };
});

// Self cells (srcSite === dstSite) are NOT clickable — there's nothing to
// drill into. Returns 'cell-disabled' for the cursor + pointer-events hint;
// the @click handler also early-returns so the click is a no-op regardless.
function cellClickableClass(srcSite, dstSite) {
  if (srcSite === dstSite) return 'cell-disabled';
  return 'cell-clickable';
}

function handleCellClick(srcSite, dstSite) {
  if (srcSite === dstSite) return;
  clickedCell.value = { srcSite, dstSite };
  // R80: cell-level click (not a specific DC pair) → no highlight. This
  // is reset explicitly so a previous dc-pair-click highlight doesn't
  // linger after the operator clicks the outer cell on a different site
  // pair.
  highlightedPair.value = null;
}

// R80: dc-pair-cell click handler. Opens the same modal as the outer
// cell click but with a highlighted target row so the operator can
// see exactly which (sourceDc → destDc) pair they clicked. We early-
// return on 'none' (no link) so clicking an empty dc-pair-cell is a
// true no-op (per the R80 spec).
function handleDcPairClick(rowDc, colDc, srcSite, dstSite) {
  if (dcPairState(rowDc, colDc, srcSite, dstSite) === 'none') return;
  clickedCell.value = { srcSite, dstSite };
  highlightedPair.value = { sourceDc: rowDc, destDc: colDc };
}

// R80: highlight predicate used by the modal pair-table to mark the
// row that matches highlightedPair. Pure equality — no fuzzy match.
function isHighlightedPair(srcDc, dstDc) {
  const hp = highlightedPair.value;
  return !!(hp && hp.sourceDc === srcDc && hp.destDc === dstDc);
}

function closeCellModal() {
  clickedCell.value = null;
  highlightedPair.value = null;
  // R73: also reset pair-toolbar state + clear pair cache so the next
  // open starts at defaults (全部 + 24h) and refetches fresh.
  pairFilter.value = 'all';
  pairWindowHours.value = 24;
  expandedPairs.value = new Set();
  pairAttempts.value = new Map();
  pairLoading.value = null;
  pairErrors.value = new Map();
}

// ── R73: filtered cellDetail — passthrough (all pairs always visible). ──
// Earlier rounds used `filteredCellDetail` to filter pair rows by
// pairFilter, but that conflicts with the per-pair attempt sub-table:
// when the operator expands pair-A then clicks 'fail', pair-A gets hidden
// from the modal and the just-expanded sub-table disappears. We now keep
// every pair row visible and let `pairFilter` only narrow the attempt
// rows inside each expanded pair's sub-table (R73 attempt-filter test).
const filteredCellDetail = computed(() => {
  if (!cellDetail.value) return null;
  return cellDetail.value;
});

// ── R72: pair expand / collapse + lazy history fetch. ──────────────────
// Operator clicks a pair row in the cell-detail modal → togglePairExpansion
// adds the key to expandedPairs and (if not already cached) lazy-fetches
// /pair-history for that (sourceDc, destDc) pair. Second click collapses
// without re-fetching; re-open after collapse reads the cached map.
// R73: cache key now includes `windowHours` so 24h and 7d don't collide.
function pairExpandKey(srcDc, dstDc, windowHours = pairWindowHours.value) {
  return `${srcDc}|${dstDc}|${windowHours}`;
}
function isPairExpanded(srcDc, dstDc, windowHours = pairWindowHours.value) {
  return expandedPairs.value.has(pairExpandKey(srcDc, dstDc, windowHours));
}
function pairAttemptsBy(srcDc, dstDc, windowHours = pairWindowHours.value) {
  return pairAttempts.value.get(pairExpandKey(srcDc, dstDc, windowHours)) || [];
}
function pairErrorFor(srcDc, dstDc, windowHours = pairWindowHours.value) {
  return pairErrors.value.get(pairExpandKey(srcDc, dstDc, windowHours)) || '';
}

// R73: pairFilteredAttempts — apply pairFilter on top of cached entries.
// Pure client-side transform; no refetch.
function pairFilteredAttempts(srcDc, dstDc, windowHours = pairWindowHours.value) {
  const all = pairAttemptsBy(srcDc, dstDc, windowHours);
  if (pairFilter.value === 'all') return all;
  if (pairFilter.value === 'ok') {
    return all.filter(a => a.statusCode === 0);
  }
  if (pairFilter.value === 'fail') {
    return all.filter(a => a.statusCode === 1 || a.statusCode >= 2);
  }
  return all;
}

// Attempt-rendering helpers — same vocabulary as R70's edge-detail modal
// (● 成功 / ▲ 部分失败 / ✕ 失败). Keeping the glyph + class names
// consistent across R70 + R72 means operators recognise the patterns.
function pairStatusClass(a) {
  if (a.statusCode === 0) return 'ok';
  if (a.statusCode === 1) return 'warn';
  return 'err';
}
function pairGlyph(a) {
  if (a.statusCode === 0) return '●';
  if (a.statusCode === 1) return '▲';
  return '✕';
}
function pairLabel(a) {
  if (a.statusCode === 0) return '成功';
  if (a.statusCode === 1) return '部分失败';
  return '失败';
}

// R73: window-switch handler. Updates the global window + clears the
// per-pair cache so re-expanded pairs fetch fresh 7d (or 24h) entries.
// We don't collapse existing expanded rows — operator stays in context.
// (The watch on pairWindowHours below is the actual clearing trigger.)
function pairFilterWindow(hours) {
  if (pairWindowHours.value === hours) return;
  pairWindowHours.value = hours;
}

// R73: CSV export button. Serializes the *currently filtered* attempts (so the
// operator's chip selection carries through) to a UTF-8 BOM-prefixed CSV
// string. Triggers a browser download via Blob + anchor click. Filename
// includes both DCs + ISO timestamp so files don't collide on the disk.
function exportPairCsv(srcDc, dstDc) {
  const entries = pairFilteredAttempts(srcDc, dstDc);
  if (!entries.length) return;
  const headers = ['尝试时间', '结果', '耗时(ms)', '传输对象', '最近成功', '错误/详情'];
  const escape = v => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const rows = entries.map(a => [
    a.attemptAt || '',
    pairLabel(a),
    a.durationMs == null ? '' : a.durationMs,
    a.objectsTransferred == null ? '' : a.objectsTransferred,
    a.lastSuccessTime || '',
    a.errorMessage || ''
  ].map(escape).join(','));
  // BOM prefix: U+FEFF written via explicit escape to avoid editor / Vite
  // encoding round-trips that collapse raw BOM bytes to U+5C01 (尧) or
  // similar. Excel needs this to detect UTF-8 when opening the CSV.
  const csv = '﻿' + [headers.join(','), ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  // Filename timestamp: YYYYMMDD-HHmm (4-digit hour+min). Earlier
  // HHmmss shape added second precision that operators don't need when
  // exports are minute-cadence. Built from raw ISO slice — the colon
  // between HH and MM sits at index 13 so we slice around it explicitly.
  const iso = new Date().toISOString();   // 2026-09-01T08:20:59.904Z
  const stamp = iso.slice(0, 10).replace(/-/g, '') + '-' + iso.slice(11, 13) + iso.slice(14, 16);
  a.href = url;
  a.download = `pair-history-${srcDc}-to-${dstDc}-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function togglePairExpansion(srcDc, dstDc) {
  const windowHours = pairWindowHours.value;
  const key = pairExpandKey(srcDc, dstDc, windowHours);
  if (expandedPairs.value.has(key)) {
    expandedPairs.value.delete(key);
    return;
  }
  expandedPairs.value.add(key);
  // Lazy fetch — only if we haven't already cached attempts for this pair.
  // Avoids re-hitting the DB when the operator collapses + re-opens within
  // the same poll cycle. The Map is reset on primaries refresh so the
  // cache stays fresh across data updates. R73: limit param respects the
  // selected window — 10 for 24h, 50 for 7d.
  if (!pairAttempts.value.has(key)) {
    pairLoading.value = key;
    pairErrors.value.delete(key);
    const limit = windowHours === 168 ? 50 : 10;
    try {
      const r = await dashboardApi.getSiteReplicationMatrixPairHistory(dstDc, srcDc, limit);
      pairAttempts.value.set(key, Array.isArray(r.data?.entries) ? r.data.entries : []);
    } catch (e) {
      pairAttempts.value.set(key, []);
      pairErrors.value.set(key, e?.response?.data?.error || '加载历史失败');
    } finally {
      pairLoading.value = null;
    }
  }
}

// R73: when window changes, collapse every expanded row + clear the cache
// because cached 24h entries are NOT a subset of 7d (different SQL window).
// Force re-fetch by emptying the maps; new fetches happen on next expand.
watch(pairWindowHours, () => {
  expandedPairs.value = new Set();
  pairAttempts.value = new Map();
  pairLoading.value = null;
  pairErrors.value = new Map();
});

// Reset the modal AND any expanded pairs when the underlying payload
// refreshes — keeps the modal consistent with the data the user is
// looking at. Without this the modal would show stale rows after a poll
// cycle, which is a classic dashboard bug. (R69/R70 modals don't have
// this risk because they read live data only on click.)
watch(primaries, () => {
  clickedCell.value = null;
  highlightedPair.value = null;
  expandedPairs.value = new Set();
  pairAttempts.value = new Map();
  pairLoading.value = null;
  pairErrors.value = new Map();
});

async function load() {
  polling.value = true;
  error.value = '';
  try {
    const r = await dashboardApi.getSiteReplicationMatrixAll({ direction: props.direction });
    primaries.value = Array.isArray(r.data?.primaries) ? r.data.primaries : [];
    refreshSeconds.value = Number(r.data?.siteRefreshSeconds) || 10;
    lastLoadedAt.value = new Date().toISOString();
  } catch (e) {
    error.value = e?.response?.data?.error || '加载失败';
  } finally {
    polling.value = false;
  }
}

function fmt(s) {
  if (!s) return '—';
  // zh-CN short form keeps the legend + tooltip compact.
  return new Date(s).toLocaleString('zh-CN', {
    hour12: false, month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
}

onMounted(async () => {
  await load();
  timerHandle = setInterval(load, refreshSeconds.value * 1000);
});
onUnmounted(() => { if (timerHandle) clearInterval(timerHandle); });
</script>

<style scoped>
/* ===== Page header ===================================================== */
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

/* ===== Legend strip ==================================================== */
.legend {
  display: flex; align-items: center; flex-wrap: wrap;
  gap: 18px; padding: 10px 14px;
  margin-bottom: 14px;
  background: var(--panel-alt);
  border: 1px solid var(--border); border-radius: 4px;
  font-size: 12px; color: var(--text);
}
.legend-item { display: inline-flex; align-items: center; gap: 6px; }
.legend-item strong {
  font-feature-settings: "tnum"; font-weight: 600;
  color: var(--text); margin-left: 2px;
}
.legend-item.muted { color: var(--muted); }
.legend-divider {
  width: 1px; height: 14px; background: var(--border);
}
.swatch {
  display: inline-block;
  width: 12px; height: 12px; border-radius: 2px;
}
.swatch-ok     { background: var(--green); }
.swatch-warn   { background: var(--yellow); }
.swatch-err    { background: var(--red); }
.swatch-silent { background: var(--red); }

/* R80 vocabulary: dc-pair-cell states carry the same 4 colors as the
   swatch legend above so the operator reads the legend → the cell
   colors in 1 step. The states are defined below alongside the
   .dc-pair-cell base. */

/* ===== Error / empty =================================================== */
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

/* ===== Matrix ==========================================================
   The table is laid out as N+1 columns and N+1 rows. First row + first
   column are sticky so navigating big matrices is easy. Cell min-width
   keeps the matrix readable when site names are long; horizontal
   scroll engages when total width exceeds viewport. */
.matrix-wrap {
  overflow: auto;
  max-width: 100%;
  background: var(--panel);
  border: 1px solid var(--border); border-radius: 4px;
}
.matrix {
  border-collapse: separate; border-spacing: 4px;
  margin: 0;
  font-size: 12px;
}
.matrix th, .matrix td {
  padding: 0;
  text-align: center; vertical-align: middle;
}
.col-head, .row-head {
  position: sticky; z-index: 2;
  background: var(--panel-alt);
  font-weight: 500; color: var(--text);
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 3px;
  white-space: nowrap;
  font-size: 12px;
}
.col-head {
  top: 0;
  min-width: 90px;
}
.row-head {
  left: 0;
  min-width: 140px;
  text-align: left;
}
.row-head-corner {
  position: sticky; top: 0; left: 0; z-index: 3;
  background: var(--panel);
  min-width: 140px; height: 100%;
}
.col-name, .row-name {
  font-weight: 600;
  color: var(--text);
  font-size: 12px;
  letter-spacing: -0.005em;
  white-space: nowrap;
}

/* R133: 两行表头 + 两列行头 — 父子关系完全分离,各自占独立 cell.
   - 列向: 第一行是站点名(colspan=dcCount),第二行是 DC 名
   - 行向: 第一列是站点名(rowspan=dcCount),第二列是 DC 名
   这样同站点多台 DC 时,父子分组在视觉上独立可读. */
.col-site-head, .row-site-head {
  background: var(--panel);
  font-weight: 600;
  font-size: 12px;
  color: var(--text);
  text-align: center;
  vertical-align: middle;
  border: 1px solid var(--border);
  border-radius: 3px;
  white-space: nowrap;
  letter-spacing: -0.005em;
  padding: 6px 10px;
}
.col-dc-head, .row-dc-head {
  background: var(--panel-alt);
  font-weight: 500;
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 3px;
  white-space: nowrap;
  font-size: 11px;
  padding: 4px 6px;
  font-family: ui-monospace, "SF Mono", monospace;
  font-feature-settings: "tnum";
}
/* 行向站点组:第一列稍宽,因为站点名可能比 DC 名长 */
.row-site-head {
  min-width: 120px;
  text-align: center;
}
.row-dc-head {
  min-width: 60px;
}
/* 列向站点组 DC 名 — 与行向 dc 名同款样式 */
.col-dc-name, .row-dc-name {
  font-size: 10px;
  color: var(--muted);
  font-family: ui-monospace, "SF Mono", monospace;
  font-feature-settings: "tnum";
  white-space: nowrap;
  letter-spacing: -0.005em;
  line-height: 1.2;
}

/* ── Cell base ────────────────────────────────────────────────────────
   R80: outer cell now hosts a per-DC sub-grid instead of a single
   glyph + ratio. The outer cell keeps the cell-{ok/warn/err/none/
   self} modifier class for back-compat (tests assert these) and for
   the worst-status visual cue on the cell border. The inner subgrid
   carries the per-DC colored squares. */
.cell {
  min-width: 36px; height: 30px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 2px;
  cursor: pointer;
  font-family: ui-monospace, "SF Mono", monospace;
  font-feature-settings: "tnum";
  transition: transform 0.08s ease, box-shadow 0.08s ease;
  text-align: center; vertical-align: middle;
  line-height: 30px;
}
.cell:hover { transform: scale(1.10); box-shadow: 0 0 0 1px color-mix(in srgb, var(--text) 40%, transparent); }
.dc-pair-glyph {
  font-weight: 700;
  font-size: 13px;
  color: var(--text);
}
.cell-glyph {
  display: inline-block; min-width: 12px;
  font-weight: 700; margin-right: 4px;
}
.cell-num { font-size: 11px; }

/* ── Cell states — operator directive: green/yellow/red/gray only. ───
   R80: outer cell state classes are now subtle (border tint + light
   background) so the per-DC sub-grid colors dominate the visual. The
   worst-state class still tints the border so the operator can scan
   the matrix quickly. */
.cell-ok {
  background: var(--green);
  color: var(--button-fg);
}
.cell-ok .dc-pair-glyph { color: var(--button-fg); }

.cell-warn {
  background: var(--yellow);
  color: var(--button-fg);
}
.cell-warn .dc-pair-glyph { color: var(--button-fg); }

.cell-err {
  background: var(--red);
  color: var(--button-fg);
}
.cell-err .dc-pair-glyph { color: var(--button-fg); }

/* R158.X.99-silent (2026-10-21) — probeState='none' 矩阵标红. 颜色跟 err
   完全同 --red 但 glyph ⊙ 跟 ✕ 区分, tooltip 文本 ("探针接入无报告")
   跟 "失败" 也区分. hub-pair 边框色加重跟 .cell-hub-pair.cell-err 同款.
   R158.20 时代这层走灰 cell-none, 跟 "DB 无 link row" 合并误压告警,
   操作员看不出 dc-pair 是否真的 "在用但没报告". */
.cell-silent {
  background: var(--red);
  color: var(--button-fg);
}
.cell-silent .dc-pair-glyph { color: var(--button-fg); }

.cell-none {
  background: var(--panel-alt);
  color: var(--muted);
}
.cell-none .dc-pair-glyph { color: var(--muted); }

.cell-self {
  background: var(--panel);
  border: 1px dashed var(--border);
  color: var(--muted);
  cursor: default;
}

/* ===== R133: per-DC cell (one (srcDc × dstDc) per cell) ===============
   R80 era had a sub-grid inside each outer cell. After R133 expansion,
   each cell IS one (srcDc → dstDc) link (rows = src DCs, cols = dst DCs),
   so the sub-grid is gone and the outer cell directly carries the
   dc-pair state colors. */
.dc-subgrid { display: none; }
.dc-pair-cell { display: none; }
.dc-pair-ok   { /* legacy class kept for tests; styles live on .cell-ok */ }
.dc-pair-warn { /* legacy class kept for tests; styles live on .cell-warn */ }
.dc-pair-err  { /* legacy class kept for tests; styles live on .cell-err */ }
.dc-pair-none { /* legacy class kept for tests; styles live on .cell-none */ }

/* ===== R68: Hub-Spoke layered panels + Hub visual emphasis ===========
   The page is now organised as 3 stacked sections (Panel 1 Hub mesh,
   Panel 2 Spoke attachment, Panel 3 Full matrix). Each panel gets its
   own header strip with a coloured tag so the operator can see at a
   glance which layer they're reading. Hub↔Hub cells get a gold-tinted
   background + thicker border so the load-bearing layer stands out. */
.layer-panel {
  margin-bottom: 18px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 14px 16px 16px;
}
.layer-panel:last-child { margin-bottom: 0; }
.layer-header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.layer-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.layer-sub {
  margin: 0 0 10px;
  font-size: 11px;
  color: var(--muted);
}
.layer-tag {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 2px 8px;
  border-radius: 999px;
  color: var(--muted);
  background: var(--panel-alt);
  border: 1px solid var(--border);
  text-transform: uppercase;
}
.hub-tag {
  color: var(--status-pill-fg-warn);
  background: color-mix(in srgb, var(--role-bridge-fg) 16%, transparent);
  border-color: color-mix(in srgb, var(--role-bridge-fg) 50%, transparent);
}
.spoke-tag {
  color: var(--muted);
  background: color-mix(in srgb, var(--role-member-fg) 12%, transparent);
  border-color: color-mix(in srgb, var(--role-member-fg) 40%, transparent);
}
.hub-tag-mini,
.spoke-tag-mini {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 3px;
  margin: 0 2px;
}
.hub-tag-mini {
  color: var(--status-pill-fg-warn);
  background: color-mix(in srgb, var(--role-bridge-fg) 16%, transparent);
}
.spoke-tag-mini {
  color: var(--muted);
  background: color-mix(in srgb, var(--role-member-fg) 16%, transparent);
}

/* ── Hub column / row header tinting ─────────────────────────────────── */
.hub-col-head {
  background: color-mix(in srgb, var(--role-bridge-fg) 10%, transparent);
  border-color: color-mix(in srgb, var(--role-bridge-fg) 50%, transparent);
  color: var(--gold-border);
}
.hub-row-head {
  background: color-mix(in srgb, var(--role-bridge-fg) 10%, transparent);
  border-color: color-mix(in srgb, var(--role-bridge-fg) 50%, transparent);
  color: var(--gold-border);
}
.spoke-row-head {
  color: var(--muted);
}

/* ── Cell layer modifiers ─────────────────────────────────────────────
   .cell-hub-pair applies to Hub↔Hub cells (load-bearing layer):
   thicker border + slightly tinted background so the operator's eye
   lands on them first. State colours (ok/warn/err) win over the base. */
.cell-hub-pair {
  border-width: 2px;
  font-weight: 600;
}
.cell-hub-pair.cell-ok {
  border-color: color-mix(in srgb, var(--role-bridge-fg) 70%, transparent);
}
.cell-hub-pair.cell-warn {
  border-color: color-mix(in srgb, var(--yellow) 70%, transparent);
}
.cell-hub-pair.cell-err {
  border-color: color-mix(in srgb, var(--red) 70%, transparent);
}

/* R158.X.99-silent — Hub↔Hub cell 是 silent 状态时 (探针接入 0 报告),
   边框加重跟 err 同款, 视觉信号一致优先 (load-bearing layer). */
.cell-hub-pair.cell-silent {
  border-color: color-mix(in srgb, var(--red) 70%, transparent);
}

/* Spoke↔Hub cells: normal weight, but slightly smaller to keep the
   panel from dominating when there are many Spokes (40-DC / 20-site
   environments can hit 15 spokes × 5 hubs = 75 cells). */
.cell-hub-spoke {
  min-width: 70px;
}

/* ===== R71: cell-click affordance + cell-detail modal =================
   The cell-detail modal is the third member of the drillability family
   (R69 node-detail, R70 edge-detail, R71 cell-detail). It reuses the
   shared modal vocabulary (.modal-bg / .modal / backdrop-click) and
   introduces a per-pair table that lists every (sourceDc → destDc) link
   in the clicked site-pair, with status pill + last success + error.
   R80: highlighted pair row gets a stronger background tint + left
   border accent so the operator sees which DC pair they clicked. */
.cell-clickable { cursor: pointer; }
.cell-disabled  { cursor: default; }

.modal-bg {
  position: fixed; inset: 0; z-index: 100;
  background: color-mix(in srgb, var(--terminal-bg) 45%, transparent);
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}
.modal {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 12px 32px var(--modal-backdrop);
  max-width: 720px; width: 100%;
  max-height: 80vh;
  display: flex; flex-direction: column;
  overflow: hidden;
}
.modal-header {
  padding: 14px 18px 10px;
  border-bottom: 1px solid var(--border);
}
.modal-title {
  margin: 0; font-size: 15px; font-weight: 600; color: var(--text);
}
.modal-meta {
  margin: 4px 0 0; font-size: 11px; color: var(--muted);
  display: flex; align-items: center; gap: 8px;
}
.layer-tag-inline {
  display: inline-block; font-size: 10px; font-weight: 600;
  letter-spacing: 0.04em; padding: 1px 6px; border-radius: 3px;
  color: var(--status-pill-fg-warn);
  background: color-mix(in srgb, var(--role-bridge-fg) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--role-bridge-fg) 50%, transparent);
}
/* R80: small badge in modal header that surfaces the highlighted pair
   name when the operator clicked a specific dc-pair-cell. The badge is
   only present while highlightedPair is non-null. */
.r80-highlight-tag {
  display: inline-block;
  font-size: 10px; font-weight: 600;
  letter-spacing: 0.02em;
  padding: 1px 8px;
  border-radius: 999px;
  color: var(--button-fg);
  background: var(--accent);
  font-family: ui-monospace, "SF Mono", monospace;
}
.modal-footer {
  padding: 10px 18px;
  border-top: 1px solid var(--border);
  display: flex; justify-content: flex-end;
  background: var(--panel-alt);
}
.btn-close {
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px 14px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.1s ease;
}
.btn-close:hover { background: var(--panel-alt); }

.cell-detail-modal .pair-table {
  width: 100%;
  border-collapse: separate; border-spacing: 0;
  font-size: 12px;
  overflow: auto;
}
.cell-detail-modal .pair-table thead th {
  position: sticky; top: 0; z-index: 1;
  background: var(--panel-alt);
  text-align: left;
  font-weight: 500;
  color: var(--muted);
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.cell-detail-modal .pair-table tbody td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  vertical-align: middle;
}
.cell-detail-modal .pair-table tbody tr:last-child td {
  border-bottom: 0;
}
.cell-detail-modal .pair-dcs {
  font-family: ui-monospace, "SF Mono", monospace;
  font-feature-settings: "tnum";
  font-weight: 500;
}
.cell-detail-modal .pair-error {
  color: var(--muted);
  max-width: 240px;
  word-break: break-word;
}

/* Per-row status tint (very subtle — the status-pill carries the heavy
   color so the table body stays readable). */
.cell-detail-modal .pair-row-ok   { background: color-mix(in srgb, var(--green) 4%, transparent); }
.cell-detail-modal .pair-row-warn { background: color-mix(in srgb, var(--yellow) 6%, transparent); }
.cell-detail-modal .pair-row-err  { background: color-mix(in srgb, var(--red) 6%, transparent); }
/* R158.20 — probeStatusCode=3 (none) 灰色行, 跟 status-pill-none 配套.
   注意: 这里的 "pair-row-none" 对应的 "none" 状态是 dcPairTooltip
   派生的 cell-none (DB 无 link row), 跟 R158.X.99-silent (probeStatusCode
   =3 但 partner 在 → 'silent' 标红) 不冲突: 后者走 pair-row-silent
   红底色, 不会落到 pair-row-none 兜底. */
.cell-detail-modal .pair-row-none { background: color-mix(in srgb, var(--muted) 4%, transparent); }
/* R158.X.99-silent — 模态 row 标红底色, 跟 .status-pill-silent 配套 */
.cell-detail-modal .pair-row-silent { background: color-mix(in srgb, var(--red) 8%, transparent); }

/* R80: pair-row-highlighted — the row that matches the dc-pair-cell the
   operator clicked. The accent left border + stronger background tint
   make the row unmistakable inside a long pair-table. */
.cell-detail-modal .pair-row-highlighted {
  background: rgba(99, 102, 241, 0.12) !important;
  box-shadow: inset 3px 0 0 var(--accent);
}

/* Status pill — same vocabulary as cell states (green/yellow/red). */
.status-pill {
  display: inline-block;
  font-size: 11px; font-weight: 600;
  padding: 2px 8px; border-radius: 999px;
  letter-spacing: 0.02em;
}
.status-pill-ok {
  color: var(--status-pill-fg-ok);
  background: color-mix(in srgb, var(--green) 18%, transparent);
  border: 1px solid color-mix(in srgb, var(--green) 40%, transparent);
}
.status-pill-warn {
  color: var(--status-pill-fg-warn);
  background: color-mix(in srgb, var(--yellow) 22%, transparent);
  border: 1px solid color-mix(in srgb, var(--yellow) 50%, transparent);
}
.status-pill-err {
  color: var(--status-pill-fg-err);
  background: color-mix(in srgb, var(--red) 20%, transparent);
  border: 1px solid color-mix(in srgb, var(--red) 50%, transparent);
}
/* R158.20 — probeStatusCode=3 (none / 待接入探针) 灰色 pill.
   跟 SiteReplicationMatrixAllView:status-pill-none 同语义.
   ⚠️ R158.X.99-silent 注意: cellMap 派生的 statusCode=3 现在分两态 —
     - 无 partner row → 走 cell-none (本 view 内部灰格), 永远不会跟
       .status-pill-* 接触
     - 有 partner + probeState='none' → 走 status-pill-silent (本文件新加)
   所以 .status-pill-none 在当前 matrix 视图已经 0 触发, 保留类名
   是为了不破坏现有 css 兼容性 (vendor / 同事 0 改的前提下).
   list 视图 SiteReplicationMatrixAllView 仍走 .status-pill-none 灰,
   跟 matrix 红不同色, 那是跨视图约定, 注释明示不在本视图复用. */
.status-pill-none {
  color: var(--muted);
  background: color-mix(in srgb, var(--muted) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--muted) 32%, transparent);
}
/* R158.X.99-silent — probeState='none' 红 pill, 跟 err 配色同款但
   label 不同 ("探针接入未报告" vs "断开失败"). 跟 cell-silent 互文,
   一处 cell 红一处 pill 红, 操作员 modal 里也能一眼看出 dc-pair 是
   "接入无报告" 而非 "复制真挂". */
.status-pill-silent {
  color: var(--status-pill-fg-err);
  background: color-mix(in srgb, var(--red) 20%, transparent);
  border: 1px solid color-mix(in srgb, var(--red) 50%, transparent);
}

/* ===== R72: pair-row expandability + inline attempts sub-table ========
   The drillability family continues: each pair row in the cell-detail
   modal is now clickable. Click → inline expand shows the last 10
   replication attempts for that (sourceDc → destDc) pair. Reuses the
   R70 attempts vocabulary (●/▲/✕ glyphs + ok/warn/err class) so
   operators recognise the pattern across all three modals (node/edge/
   cell-pair). */
.cell-detail-modal .pair-row-expandable {
  cursor: pointer;
  transition: background 0.08s ease;
}
.cell-detail-modal .pair-row-expandable:hover {
  background: rgba(99, 102, 241, 0.06);
}
.cell-detail-modal .pair-row-open {
  background: rgba(99, 102, 241, 0.08);
}

.cell-detail-modal .pair-caret-col {
  width: 28px;
  padding: 0 !important;
  text-align: center;
}
.cell-detail-modal .pair-caret-btn {
  background: transparent;
  border: 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1;
  width: 24px; height: 24px;
  border-radius: 3px;
  cursor: pointer;
  padding: 0;
  transition: background 0.08s ease, color 0.08s ease;
}
.cell-detail-modal .pair-caret-btn:hover {
  background: var(--panel-alt);
  color: var(--text);
}
.cell-detail-modal .pair-row-open .pair-caret-btn {
  color: var(--accent);
}

.cell-detail-modal .pair-row-attempts td {
  padding: 0;
  background: var(--panel-alt);
  border-bottom: 1px solid var(--border);
}

.cell-detail-modal .attempts-loading,
.cell-detail-modal .attempts-empty,
.cell-detail-modal .attempts-error {
  padding: 12px 16px;
  font-size: 12px;
  color: var(--muted);
  text-align: center;
}
.cell-detail-modal .attempts-error { color: var(--red); }

.cell-detail-modal .attempts-table {
  width: 100%;
  border-collapse: separate; border-spacing: 0;
  font-size: 11px;
  margin: 0;
}
.cell-detail-modal .attempts-table thead th {
  text-align: left;
  font-weight: 500;
  color: var(--muted);
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 10px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  background: var(--panel-alt);
}
.cell-detail-modal .attempts-table tbody td {
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  vertical-align: middle;
}
.cell-detail-modal .attempts-table tbody tr:last-child td {
  border-bottom: 0;
}
.cell-detail-modal .att-time,
.cell-detail-modal .att-dur,
.cell-detail-modal .att-objects {
  font-family: ui-monospace, "SF Mono", monospace;
  font-feature-settings: "tnum";
}
.cell-detail-modal .att-row-ok   { background: color-mix(in srgb, var(--green) 4%, transparent); }
.cell-detail-modal .att-row-warn { background: color-mix(in srgb, var(--yellow) 6%, transparent); }
.cell-detail-modal .att-row-err  { background: color-mix(in srgb, var(--red) 6%, transparent); }
.cell-detail-modal .att-error {
  color: var(--muted);
  max-width: 220px;
  word-break: break-word;
}
.cell-detail-modal .glyph {
  display: inline-block;
  width: 12px;
  font-weight: 700;
  margin-right: 4px;
}
.cell-detail-modal .glyph-ok   { color: var(--status-pill-fg-ok); }
.cell-detail-modal .glyph-warn { color: var(--status-pill-fg-warn); }
.cell-detail-modal .glyph-err  { color: var(--status-pill-fg-err); }

/* ===== R73: pair-toolbar (status filter + date range) + CSV export ===== */

/* Toolbar sits above the pair-table; chips flex to opposite ends. */
.cell-detail-modal .pair-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 0 12px 0;
  border-bottom: 1px solid var(--border);
  margin-bottom: 8px;
}
.cell-detail-modal .pair-filter-chips,
.cell-detail-modal .pair-window-chips {
  display: inline-flex;
  gap: 4px;
}

/* Chip — pill button with subtle border. Active = filled bg. */
.cell-detail-modal .pair-chip {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--muted);
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  cursor: pointer;
  transition: background 0.08s ease, color 0.08s ease, border-color 0.08s ease;
  line-height: 1.4;
}
.cell-detail-modal .pair-chip:hover {
  background: var(--panel-alt);
  color: var(--text);
}
.cell-detail-modal .pair-chip-active {
  background: var(--accent);
  color: var(--button-fg);
  border-color: var(--accent);
}
.cell-detail-modal .pair-chip-active:hover {
  background: var(--accent);
  color: var(--button-fg);
}

/* Sub-table toolbar — count + CSV button on opposite ends. */
.cell-detail-modal .attempts-area {
  padding: 12px 8px 8px 8px;
}
.cell-detail-modal .attempts-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 0 8px 0;
}
.cell-detail-modal .attempts-count {
  font-size: 12px;
  color: var(--muted);
}
.cell-detail-modal .pair-csv-btn {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text);
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.08s ease, border-color 0.08s ease;
}
.cell-detail-modal .pair-csv-btn:hover {
  background: var(--panel-alt);
  border-color: var(--accent);
  color: var(--accent);
}
</style>