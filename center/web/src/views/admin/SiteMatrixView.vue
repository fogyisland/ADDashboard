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
        <h2 class="page-title">站点矩阵</h2>
        <p class="subtitle">所有站点的入站复制链路 · {{ refreshSeconds }} 秒自动刷新</p>
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
              <th class="row-head-corner" scope="col"></th>
              <th
                v-for="s in hubSites"
                :key="`hub-col-${s.siteName}`"
                scope="col"
                class="col-head hub-col-head"
                :title="`${s.siteName} · ${s.dcCount} DC`"
              >
                <div class="col-name">{{ s.siteName }}</div>
                <div class="col-meta">{{ s.dcCount }} DC</div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="rs in hubSites" :key="`hub-row-${rs.siteName}`" class="matrix-row" :data-test="`matrix-row-hub-${rs.siteName}`">
              <th scope="row" class="row-head hub-row-head" :title="`${rs.siteName} · ${rs.dcCount} DC`">
                <div class="row-name">{{ rs.siteName }}</div>
                <div class="row-meta">
                  <span class="row-meta-num">{{ rs.dcCount }}</span><span class="row-meta-label"> DC</span>
                </div>
              </th>
              <td
                v-for="cs in hubSites"
                :key="`hub-cell-${rs.siteName}-${cs.siteName}`"
                :class="['cell', `cell-${cellState(rs.siteName, cs.siteName)}`, 'cell-hub-pair', cellClickableClass(rs.siteName, cs.siteName)]"
                :data-test="`cell-${rs.siteName}-${cs.siteName}`"
                :title="cellTooltip(rs.siteName, cs.siteName)"
                @click="handleCellClick(rs.siteName, cs.siteName)"
              >
                <!-- Self cells: keep the original single-glyph rendering.
                     Within-site DC×DC links don't exist by design, so a
                     sub-grid would just be a matrix of "—" — no useful
                     information. R64 self-cell tests still assert
                     .cell-glyph + .cell-num content, so we keep that
                     markup verbatim. -->
                <template v-if="rs.siteName === cs.siteName">
                  <span class="cell-glyph">{{ cellGlyph(rs.siteName, cs.siteName) }}</span>
                  <span class="cell-num">{{ cellText(rs.siteName, cs.siteName) }}</span>
                </template>
                <!-- R80: per-DC sub-grid. Rows = rs site's DCs,
                     cols = cs site's DCs. Each inner cell carries the
                     link state for one (rowDc → colDc) pair. Click on a
                     dc-pair-cell opens the R71 modal highlighted to
                     that DC pair (click.stop so the parent cell's
                     handleCellClick doesn't double-fire). -->
                <table v-else class="dc-subgrid" :data-test="`dc-subgrid-${rs.siteName}-${cs.siteName}`">
                  <tbody>
                    <tr v-for="rowDc in dcsOf(rs.siteName)" :key="`r-${rs.siteName}-${rowDc}`">
                      <td
                        v-for="colDc in dcsOf(cs.siteName)"
                        :key="`c-${rs.siteName}-${rowDc}-${cs.siteName}-${colDc}`"
                        :class="['dc-pair-cell', `dc-pair-${dcPairState(rowDc, colDc, rs.siteName, cs.siteName)}`]"
                        :data-test="`dc-pair-${rs.siteName}-${cs.siteName}-${dcSlug(rowDc)}-to-${dcSlug(colDc)}`"
                        :title="dcPairTooltip(rowDc, colDc, rs.siteName, cs.siteName)"
                        @click.stop="handleDcPairClick(rowDc, colDc, rs.siteName, cs.siteName)"
                      >{{ dcPairGlyph(rowDc, colDc, rs.siteName, cs.siteName) }}</td>
                    </tr>
                  </tbody>
                </table>
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
        <h3 class="layer-title">接入层 (Spoke → Hub)</h3>
        <span class="layer-tag spoke-tag">分支 → 中心 · {{ spokeSites.length }} 分支</span>
      </header>
      <p class="layer-sub">每个分支站点到各 Hub 中心的复制状态。Spoke 应只向就近 Hub 复制,Spoke↔Spoke 不应有链路(违反 Hub-Spoke)。</p>
      <div class="matrix-wrap">
        <table class="matrix spoke-matrix">
          <thead>
            <tr>
              <th class="row-head-corner" scope="col"></th>
              <th
                v-for="h in hubSites"
                :key="`spoke-col-${h.siteName}`"
                scope="col"
                class="col-head hub-col-head"
                :title="`${h.siteName} · ${h.dcCount} DC`"
              >
                <div class="col-name">{{ h.siteName }}</div>
                <div class="col-meta">中心</div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="sp in spokeSites" :key="`spoke-row-${sp.siteName}`" class="matrix-row" :data-test="`matrix-row-spoke-${sp.siteName}`">
              <th scope="row" class="row-head spoke-row-head" :title="`${sp.siteName} · ${sp.dcCount} DC`">
                <div class="row-name">{{ sp.siteName }}</div>
                <div class="row-meta">
                  <span class="row-meta-num">{{ sp.dcCount }}</span><span class="row-meta-label"> DC</span>
                </div>
              </th>
              <td
                v-for="hub in hubSites"
                :key="`spoke-cell-${sp.siteName}-${hub.siteName}`"
                :class="['cell', `cell-${cellState(sp.siteName, hub.siteName)}`, 'cell-hub-spoke', cellClickableClass(sp.siteName, hub.siteName)]"
                :data-test="`cell-${sp.siteName}-${hub.siteName}`"
                :title="cellTooltip(sp.siteName, hub.siteName)"
                @click="handleCellClick(sp.siteName, hub.siteName)"
              >
                <!-- Spoke→Hub cells are never self-pairs (Spokes ≠ Hubs by
                     definition), so we always render the sub-grid here. -->
                <table class="dc-subgrid" :data-test="`dc-subgrid-${sp.siteName}-${hub.siteName}`">
                  <tbody>
                    <tr v-for="rowDc in dcsOf(sp.siteName)" :key="`r-${sp.siteName}-${rowDc}`">
                      <td
                        v-for="colDc in dcsOf(hub.siteName)"
                        :key="`c-${sp.siteName}-${rowDc}-${hub.siteName}-${colDc}`"
                        :class="['dc-pair-cell', `dc-pair-${dcPairState(rowDc, colDc, sp.siteName, hub.siteName)}`]"
                        :data-test="`dc-pair-${sp.siteName}-${hub.siteName}-${dcSlug(rowDc)}-to-${dcSlug(colDc)}`"
                        :title="dcPairTooltip(rowDc, colDc, sp.siteName, hub.siteName)"
                        @click.stop="handleDcPairClick(rowDc, colDc, sp.siteName, hub.siteName)"
                      >{{ dcPairGlyph(rowDc, colDc, sp.siteName, hub.siteName) }}</td>
                    </tr>
                  </tbody>
                </table>
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
              <th class="row-head-corner" scope="col"></th>
              <th
                v-for="s in sites"
                :key="`col-${s.siteName}`"
                scope="col"
                class="col-head"
                :title="`${s.siteName} · ${s.dcCount} DC`"
              >
                <div class="col-name">{{ s.siteName }}</div>
                <div class="col-meta">{{ s.dcCount }} DC</div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="rs in sites" :key="`row-${rs.siteName}`" class="matrix-row" :data-test="`matrix-row-${rs.siteName}`">
              <th scope="row" class="row-head" :title="`${rs.siteName} · ${rs.dcCount} DC`">
                <div class="row-name">{{ rs.siteName }}</div>
                <div class="row-meta">
                  <span class="row-meta-num">{{ rs.dcCount }}</span><span class="row-meta-label"> DC</span>
                </div>
              </th>
              <td
                v-for="cs in sites"
                :key="`cell-${rs.siteName}-${cs.siteName}`"
                :class="['cell', `cell-${cellState(rs.siteName, cs.siteName)}`, cellClickableClass(rs.siteName, cs.siteName)]"
                :data-test="`cell-${rs.siteName}-${cs.siteName}`"
                :title="cellTooltip(rs.siteName, cs.siteName)"
                @click="handleCellClick(rs.siteName, cs.siteName)"
              >
                <template v-if="rs.siteName === cs.siteName">
                  <span class="cell-glyph">{{ cellGlyph(rs.siteName, cs.siteName) }}</span>
                  <span class="cell-num">{{ cellText(rs.siteName, cs.siteName) }}</span>
                </template>
                <table v-else class="dc-subgrid" :data-test="`dc-subgrid-${rs.siteName}-${cs.siteName}`">
                  <tbody>
                    <tr v-for="rowDc in dcsOf(rs.siteName)" :key="`r-${rs.siteName}-${rowDc}`">
                      <td
                        v-for="colDc in dcsOf(cs.siteName)"
                        :key="`c-${rs.siteName}-${rowDc}-${cs.siteName}-${colDc}`"
                        :class="['dc-pair-cell', `dc-pair-${dcPairState(rowDc, colDc, rs.siteName, cs.siteName)}`]"
                        :data-test="`dc-pair-${rs.siteName}-${cs.siteName}-${dcSlug(rowDc)}-to-${dcSlug(colDc)}`"
                        :title="dcPairTooltip(rowDc, colDc, rs.siteName, cs.siteName)"
                        @click.stop="handleDcPairClick(rowDc, colDc, rs.siteName, cs.siteName)"
                      >{{ dcPairGlyph(rowDc, colDc, rs.siteName, cs.siteName) }}</td>
                    </tr>
                  </tbody>
                </table>
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
          statusCode: partner.statusCode,
          lastSuccessTime: partner.lastSuccessTime,
          lastAttemptTime: partner.lastAttemptTime,
          errorMessage: partner.errorMessage
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
// semantics: 0 = success (green), 1 = partial failure (yellow),
// 2+ = failure (red). Empty list = "no link between sites" (gray).
function worstStatus(parts) {
  if (!parts.length) return 'none';
  let worst = 'ok';
  for (const p of parts) {
    if (p.statusCode === 0) continue;
    if (p.statusCode === 1) { if (worst === 'ok') worst = 'warn'; }
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
  if (!partner) return 'none';
  if (partner.statusCode === 0) return 'ok';
  if (partner.statusCode === 1) return 'warn';
  return 'err';
}

function dcPairGlyph(rowDc, colDc, srcSite, dstSite) {
  const s = dcPairState(rowDc, colDc, srcSite, dstSite);
  if (s === 'ok')   return '✓';
  if (s === 'warn') return '!';
  if (s === 'err')  return '✕';
  return '—';
}

// Tooltip for one DC pair: state + last success + error message.
// Matches the operator-readable vocabulary of cellTooltip but scoped
// to a single DC pair.
function dcPairTooltip(rowDc, colDc, srcSite, dstSite) {
  const parts = cellMap.value.get(key(srcSite, dstSite)) || [];
  const partner = parts.find(p => p.sourceDc === rowDc && p.destDc === colDc);
  if (!partner) {
    return `${rowDc} → ${colDc}\n无复制链路`;
  }
  const state = partner.statusCode === 0 ? '✓ 健康'
              : partner.statusCode === 1 ? '! 部分失败'
              : '✕ 失败';
  const err = partner.errorMessage ? ` — ${partner.errorMessage}` : '';
  const last = partner.lastSuccessTime
    ? ` · 最近成功 ${fmt(partner.lastSuccessTime)}`
    : ' · 暂无成功记录';
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

// Tooltip on hover: list of partner links with status + last success.
// Bounded to a reasonable length to keep the tooltip readable.
// R80: still used as the outer cell title (full site-pair summary).
function cellTooltip(srcSite, dstSite) {
  if (srcSite === dstSite) return `${srcSite} (本站内)`;
  const parts = partners(srcSite, dstSite);
  if (!parts.length) return `${srcSite} → ${dstSite}\n无复制链路`;
  const lines = [`${srcSite} → ${dstSite}  · ${parts.length} 条链路`];
  for (const p of parts) {
    const state = p.statusCode === 0 ? '✓'
                : p.statusCode === 1 ? '!'
                : '✕';
    const err = p.errorMessage ? ` — ${p.errorMessage}` : '';
    const last = p.lastSuccessTime
      ? ` · 最近成功 ${fmt(p.lastSuccessTime)}`
      : ' · 暂无成功记录';
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
const totals = computed(() => {
  let sites = 0, dcs = 0, links = 0, ok = 0, warn = 0, err = 0;
  for (const p of primaries.value) {
    sites++;
    dcs += (p.dcs || []).length;
    for (const dc of (p.dcPartners || [])) {
      for (const partner of dc.partners) {
        links++;
        if (partner.statusCode === 0) ok++;
        else if (partner.statusCode === 1) warn++;
        else err++;
      }
    }
  }
  return { sites, dcs, links, ok, warn, err };
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
      statusCode: p.statusCode,
      statusClass: p.statusCode === 0 ? 'ok' : (p.statusCode === 1 ? 'warn' : 'err'),
      statusLabel: p.statusCode === 0 ? '复制成功'
                 : (p.statusCode === 1 ? '部分失败' : '断开失败'),
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
    const r = await dashboardApi.getSiteReplicationMatrixAll();
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
.swatch-ok   { background: var(--green); }
.swatch-warn { background: var(--yellow); }
.swatch-err  { background: var(--red); }

/* R80 vocabulary: dc-pair-cell states carry the same 4 colors as the
   swatch legend above so the operator reads the legend → the cell
   colors in 1 step. The states are defined below alongside the
   .dc-pair-cell base. */

/* ===== Error / empty =================================================== */
.error-banner {
  background: rgba(239, 68, 68, 0.12); color: var(--red);
  padding: 8px 12px; border-radius: 4px; margin-bottom: 12px;
  border: 1px solid rgba(239, 68, 68, 0.3); font-size: 12px;
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
.col-meta, .row-meta {
  font-size: 10px;
  color: var(--muted);
  margin-top: 1px;
  font-family: ui-monospace, monospace;
  font-feature-settings: "tnum";
}
.row-meta-num { color: var(--text); font-weight: 600; }

/* ── Cell base ────────────────────────────────────────────────────────
   R80: outer cell now hosts a per-DC sub-grid instead of a single
   glyph + ratio. The outer cell keeps the cell-{ok/warn/err/none/
   self} modifier class for back-compat (tests assert these) and for
   the worst-status visual cue on the cell border. The inner subgrid
   carries the per-DC colored squares. */
.cell {
  min-width: 80px; height: 44px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 3px;
  cursor: default;
  font-family: ui-monospace, "SF Mono", monospace;
  font-feature-settings: "tnum";
  transition: transform 0.08s ease;
}
.cell:hover { transform: scale(1.04); }
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
  background: rgba(34, 197, 94, 0.08);
  border-color: rgba(34, 197, 94, 0.45);
  color: #15803d;
}
.cell-ok .cell-glyph { color: #15803d; }

.cell-warn {
  background: rgba(234, 179, 8, 0.10);
  border-color: rgba(234, 179, 8, 0.55);
  color: #a16207;
}
.cell-warn .cell-glyph { color: #a16207; }

.cell-err {
  background: rgba(239, 68, 68, 0.10);
  border-color: rgba(239, 68, 68, 0.55);
  color: #b91c1c;
}
.cell-err .cell-glyph { color: #b91c1c; }

.cell-none {
  background: var(--panel-alt);
  border-color: var(--border);
  color: var(--muted);
}
.cell-none .cell-glyph { color: var(--muted); }

.cell-self {
  background: var(--panel-alt);
  border: 1px dashed var(--border);
  color: var(--muted);
}

/* ===== R80: per-DC sub-grid (one (srcDc × dstDc) per inner cell) ===
   The sub-grid is a tiny borderless table inside each outer <td>.
   Each inner cell is a fixed-size colored square that carries the
   state of one (srcDc → dstDc) link. The sub-grid is auto-sized by
   DC count — bigger sites produce wider sub-grids, the matrix
   .matrix-wrap scrolls horizontally to accommodate. */
.dc-subgrid {
  border-collapse: separate; border-spacing: 1px;
  margin: 0 auto;
  display: inline-table;
}
.dc-subgrid tbody {
  /* no-op selector — kept for future styling hooks */
}
.dc-subgrid td {
  padding: 0;
}
.dc-pair-cell {
  width: 18px;
  height: 18px;
  min-width: 18px;
  text-align: center;
  vertical-align: middle;
  border-radius: 2px;
  font-size: 11px;
  font-weight: 700;
  font-family: ui-monospace, "SF Mono", monospace;
  line-height: 18px;
  cursor: pointer;
  transition: transform 0.06s ease, box-shadow 0.06s ease;
}
.dc-pair-cell:hover {
  transform: scale(1.15);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.6);
}
/* R80: the 4 DC-pair states — same color vocabulary as the outer cell
   states but with full saturation (the sub-grid owns the color, the
   outer cell only tints the border). Glyph color stays dark for none
   (light-gray bg) and white for the 3 saturated states. */
.dc-pair-ok {
  background: var(--green);
  color: #ffffff;
}
.dc-pair-warn {
  background: var(--yellow);
  color: #ffffff;
}
.dc-pair-err {
  background: var(--red);
  color: #ffffff;
}
.dc-pair-none {
  background: var(--panel);
  color: var(--muted);
  cursor: default;
  border: 1px solid var(--border);
}
.dc-pair-none:hover {
  transform: none;
  box-shadow: none;
}

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
  color: #b45309;
  background: rgba(251, 191, 36, 0.16);
  border-color: rgba(251, 191, 36, 0.5);
}
.spoke-tag {
  color: var(--muted);
  background: rgba(148, 163, 184, 0.12);
  border-color: rgba(148, 163, 184, 0.4);
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
  color: #b45309;
  background: rgba(251, 191, 36, 0.16);
}
.spoke-tag-mini {
  color: #94a3b8;
  background: rgba(148, 163, 184, 0.16);
}

/* ── Hub column / row header tinting ─────────────────────────────────── */
.hub-col-head {
  background: rgba(251, 191, 36, 0.10);
  border-color: rgba(251, 191, 36, 0.5);
  color: #fde68a;
}
.hub-row-head {
  background: rgba(251, 191, 36, 0.10);
  border-color: rgba(251, 191, 36, 0.5);
  color: #fde68a;
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
  border-color: rgba(251, 191, 36, 0.7);
}
.cell-hub-pair.cell-warn {
  border-color: rgba(234, 179, 8, 0.7);
}
.cell-hub-pair.cell-err {
  border-color: rgba(239, 68, 68, 0.7);
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
  background: rgba(15, 23, 42, 0.45);
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}
.modal {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.30);
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
  color: #b45309;
  background: rgba(251, 191, 36, 0.16);
  border: 1px solid rgba(251, 191, 36, 0.5);
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
  color: #ffffff;
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
.cell-detail-modal .pair-row-ok   { background: rgba(34, 197, 94, 0.04); }
.cell-detail-modal .pair-row-warn { background: rgba(234, 179, 8, 0.06); }
.cell-detail-modal .pair-row-err  { background: rgba(239, 68, 68, 0.06); }

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
  color: #15803d;
  background: rgba(34, 197, 94, 0.18);
  border: 1px solid rgba(34, 197, 94, 0.4);
}
.status-pill-warn {
  color: #a16207;
  background: rgba(234, 179, 8, 0.22);
  border: 1px solid rgba(234, 179, 8, 0.5);
}
.status-pill-err {
  color: #b91c1c;
  background: rgba(239, 68, 68, 0.20);
  border: 1px solid rgba(239, 68, 68, 0.5);
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
  color: #6366f1;
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
.cell-detail-modal .att-row-ok   { background: rgba(34, 197, 94, 0.04); }
.cell-detail-modal .att-row-warn { background: rgba(234, 179, 8, 0.06); }
.cell-detail-modal .att-row-err  { background: rgba(239, 68, 68, 0.06); }
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
.cell-detail-modal .glyph-ok   { color: #15803d; }
.cell-detail-modal .glyph-warn { color: #a16207; }
.cell-detail-modal .glyph-err  { color: #b91c1c; }

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
  color: #ffffff;
  border-color: var(--accent);
}
.cell-detail-modal .pair-chip-active:hover {
  background: var(--accent);
  color: #ffffff;
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