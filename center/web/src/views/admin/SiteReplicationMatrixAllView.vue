<!--
  复制状态概览 (复制伙伴状态 全站)
  ────────────────────────────────
  2026-09-25 R93.10: operator directive "在 /admin/site-replication-matrix/all
  没有看到实际的复制矩阵结果,我们需要将之前获取的结果以矩阵方式显示在
  这里". 整页从 round-49 的 per-DC partner tables 重做为 3-panel N×N
  矩阵,跟 sibling /admin/matrix (R64 SiteMatrixView) 同源 — 复用同一份
  /api/dashboard/site-replication-matrix/all payload,同一组 cellMap /
  dcPairState / hubSiteSet 工具。区别仅在包裹层 (AdminLayout 而非
  AppLayout) + 保留 round-49 的 fleet health ribbon 作为"扫一眼"入口。

  - 顶部 fleet health ribbon (R49 保留) — 站点 / 域控 / 入站链路 / 健康
    / 部分失败 / 失败 的总览数字,色阶分层。
  - Hub-Spoke 3-panel 矩阵 (R68 同款) — Panel 1 核心层 Hub↔Hub (≥2
    hubs 才渲染,Hub↔Hub cell 加 .cell-hub-pair 金色强调边框),
    Panel 2 接入层 Spoke→Hub,Panel 3 全矩阵。每格内嵌 per-DC sub-grid
    (R80 同款) — 行=源站 DC,列=目标站 DC,小方块颜色 = 该 DC 对
    链路状态 (绿/黄/红/灰)。
  - 自指 cell (srcSite === dstSite) 保留单 .cell-glyph + .cell-num 的
    "·/—" 占位符 — 站内无伙伴链路。
  - Click 非自指 cell → R71 cell-detail modal 列出该 site-pair 下所有
    (sourceDc → destDc) 链路 + caret 展开 R45 /pair-history (复用
    R72 同样的 cache / 24h|7d window / status filter chip 机制)。
  - 跟 /admin/matrix 完全一致的 data-test 选择器 (`cell-X-Y` /
    `dc-pair-X-Y-A-to-B` / `cell-detail-modal` / `pair-caret-N` /
    `pair-attempts-N` 等) — 两个测试矩阵在不同 .vue 文件但共用契约。
  - 全部沿用 style.css 的设计 token (--panel / --panel-alt / --border
    / --accent / --green / --yellow / --red / --muted)。
-->
<template>
  <AdminLayout>
    <header class="page-header">
      <div class="page-titles">
        <div class="eyebrow">OPERATIONS · 复制健康</div>
        <h2 class="page-title">复制状态概览</h2>
        <p class="subtitle">所有站点的入站复制链路 · {{ refreshSeconds }} 秒自动刷新</p>
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

    <!-- Fleet health ribbon (round-49 保留) — operator 扫一眼知道全局
      状态。Counts 来自 totals computed (单次 O(DCs × partners))。 -->
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
        <div class="ribbon-label">入站链路</div>
      </div>
      <div class="ribbon-tile ribbon-ok">
        <div class="ribbon-num">{{ totals.ok }}</div>
        <div class="ribbon-label">健康</div>
      </div>
      <div class="ribbon-tile" :class="{ 'ribbon-warn': totals.warn > 0 }">
        <div class="ribbon-num">{{ totals.warn }}</div>
        <div class="ribbon-label">部分失败</div>
      </div>
      <div class="ribbon-tile" :class="{ 'ribbon-err': totals.err > 0 }">
        <div class="ribbon-num">{{ totals.err }}</div>
        <div class="ribbon-label">失败</div>
      </div>
    </div>

    <!-- Legend strip — 复用 R64 SiteMatrixView 词汇(成功 / 部分失败 /
      断开 + 站点 + 域控 + 域控对),让两个矩阵页之间切换时 0 学习成本。 -->
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
      <span class="legend-item muted">域控对 <strong>{{ totals.links }}</strong></span>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="!primaries.length && !error" class="empty">暂无站点 — 请在 AD 站点清单添加</div>

    <!-- ── Panel 1: 核心层 Hub ↔ Hub ──────────────────────────────────
      只在 ≥2 Hub 时渲染。Hub↔Hub 是承载层,失败会立即扩散到所有 Spoke。
      .cell-hub-pair 加重金色边框 (跟 R68 SiteMatrixView 一致)。 -->
    <section
      v-if="hubSites.length >= 2"
      class="layer-panel hub-panel"
      data-test="hub-panel"
    >
      <header class="layer-header">
        <h3 class="layer-title">核心层 (Hub ↔ Hub)</h3>
        <span class="layer-tag hub-tag">承载层 · {{ hubSites.length }} 中心</span>
      </header>
      <p class="layer-sub">核心站点相互复制,Hub-Spoke 架构的"承载层"。故障会立即放大到所有分支。</p>
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

    <!-- ── Panel 2: 接入层 Spoke → Hub ─────────────────────────────────
      每个 Spoke 行 × 每个 Hub 列显示该 Spoke 是否正从各 Hub 入站复制。
      反向 (Hub→Spoke) 是"设计性缺席",只在 Panel 3 显现。 -->
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

    <!-- ── Panel 3: 全矩阵 ────────────────────────────────────────────
      完整 N×N 视图,含 Spoke↔Spoke (R68 标记为"设计性缺席",Hub-Spoke
      合规环境此格应空)。跟 /admin/matrix 同款 data-test 选择器。 -->
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

    <!-- ── R71 cell-detail modal ───────────────────────────────────────
      Click 任意非自指 cell → 列出该 site-pair 下所有 (sourceDc →
      destDc) 链路 + caret 展开 24h|7d /pair-history。跟 /admin/matrix
      复用同一份 modal 词汇 (cell-{X-Y} / pair-row-{ok|warn|err} /
      pair-row-highlighted)。 -->
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
              v-for="(p, i) in cellDetail.pairs"
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
                  <div
                    v-if="pairLoading === pairExpandKey(p.sourceDc, p.destDc, pairWindowHours)"
                    class="attempts-loading"
                    :data-test="`pair-attempts-loading-${i}`"
                  >加载中…</div>
                  <div
                    v-else-if="pairErrorFor(p.sourceDc, p.destDc, pairWindowHours)"
                    class="attempts-error"
                    :data-test="`pair-attempts-error-${i}`"
                  >{{ pairErrorFor(p.sourceDc, p.destDc, pairWindowHours) }}</div>
                  <div
                    v-else-if="!pairAttemptsBy(p.sourceDc, p.destDc, pairWindowHours).length"
                    class="attempts-empty"
                    :data-test="`pair-attempts-empty-${i}`"
                  >{{ pairWindowHours === 24 ? '24h' : '7d' }} 内暂无复制尝试记录</div>
                  <div v-else class="attempts-area" :data-test="`pair-attempts-area-${i}`">
                    <div class="attempts-toolbar">
                      <span class="attempts-count">
                        {{ pairFilteredAttempts(p.sourceDc, p.destDc).length }} 条
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
  </AdminLayout>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { dashboardApi } from '../../api/dashboard.js';

const primaries = ref([]);
const refreshSeconds = ref(10);
const lastLoadedAt = ref(null);
const error = ref('');
const polling = ref(false);

// ── Modal state (跟 SiteMatrixView R71/R72/R73 同源) ──────────────────
const clickedCell = ref(null);
const highlightedPair = ref(null);
const expandedPairs = ref(new Set());
const pairAttempts  = ref(new Map());
const pairLoading   = ref(null);
const pairErrors    = ref(new Map());
const pairFilter = ref('all');
const pairWindowHours = ref(24);

let timerHandle = null;

// ── 站点列表 (保留 backend 顺序, R68 Hub-Spoke 分层依赖 isHub) ────────
const sites = computed(() => primaries.value.map(p => ({
  siteName: p.siteName,
  dcCount: (p.dcs || []).length,
  isHub: !!p.isHub
})));
const hubSites   = computed(() => sites.value.filter(s => s.isHub));
const spokeSites = computed(() => sites.value.filter(s => !s.isHub));
const hubSiteSet = computed(() => new Set(hubSites.value.map(s => s.siteName)));

function isHubPair(siteA, siteB) {
  const set = hubSiteSet.value;
  return set.has(siteA) && set.has(siteB);
}

// ── Site → DCs 索引 (R80 sub-grid 共享) ─────────────────────────────────
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
function dcSlug(dcName) {
  return String(dcName).replace(/[^a-zA-Z0-9_-]/g, '_');
}

// ── cellMap: (srcSite|peerSite) → partner[] (跟 SiteMatrixView 同源) ────
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

// statusCode: 0 = 成功 (绿), 1 = 部分失败 (黄), 2+ = 失败 (红)。
// 空 list = "无链路" (灰)。R64 SiteMatrixView 同款逻辑。
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

// ── Fleet totals (供 ribbon + legend 复用,跟 R49 同款逻辑) ──────────────
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

// ── R71 cell-detail modal (跟 SiteMatrixView 同款) ─────────────────────
const cellDetail = computed(() => {
  if (!clickedCell.value) return null;
  const { srcSite, dstSite } = clickedCell.value;
  const parts = partners(srcSite, dstSite);
  const isHubPairCell = isHubPair(srcSite, dstSite);
  let layerTag = '';
  if (isHubPairCell && srcSite !== dstSite) layerTag = '核心层 Hub↔Hub';
  else if (hubSiteSet.value.has(dstSite) && !hubSiteSet.value.has(srcSite)) {
    layerTag = '接入层 Spoke→Hub';
  } else if (hubSiteSet.value.has(srcSite) && !hubSiteSet.value.has(dstSite)) {
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

function cellClickableClass(srcSite, dstSite) {
  if (srcSite === dstSite) return 'cell-disabled';
  return 'cell-clickable';
}
function handleCellClick(srcSite, dstSite) {
  if (srcSite === dstSite) return;
  clickedCell.value = { srcSite, dstSite };
  highlightedPair.value = null;
}
function handleDcPairClick(rowDc, colDc, srcSite, dstSite) {
  if (dcPairState(rowDc, colDc, srcSite, dstSite) === 'none') return;
  clickedCell.value = { srcSite, dstSite };
  highlightedPair.value = { sourceDc: rowDc, destDc: colDc };
}
function isHighlightedPair(srcDc, dstDc) {
  const hp = highlightedPair.value;
  return !!(hp && hp.sourceDc === srcDc && hp.destDc === dstDc);
}
function closeCellModal() {
  clickedCell.value = null;
  highlightedPair.value = null;
  pairFilter.value = 'all';
  pairWindowHours.value = 24;
  expandedPairs.value = new Set();
  pairAttempts.value = new Map();
  pairLoading.value = null;
  pairErrors.value = new Map();
}

// ── R72 pair expansion + R73 pair-toolbar (跟 SiteMatrixView 同款) ─────
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
function pairFilterWindow(hours) {
  if (pairWindowHours.value === hours) return;
  pairWindowHours.value = hours;
}

// CSV export (跟 SiteMatrixView R73 同款) — UTF-8 BOM + 分钟精度时间戳。
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
  // BOM prefix: 显式 U+FEFF 避免编辑器 round-trip 把 raw BOM 字节塌成 U+5C01。
  const csv = '﻿' + [headers.join(','), ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const iso = new Date().toISOString();
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

watch(pairWindowHours, () => {
  expandedPairs.value = new Set();
  pairAttempts.value = new Map();
  pairLoading.value = null;
  pairErrors.value = new Map();
});
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
.refresh-dot.on  { background: var(--green); box-shadow: 0 0 6px rgba(34, 197, 94, 0.6); }
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

/* ===== Fleet health ribbon (round-49 signature) ======================== */
.fleet-ribbon {
  display: grid; grid-template-columns: repeat(6, 1fr);
  gap: 1px; margin-bottom: 18px;
  background: var(--border); border: 1px solid var(--border); border-radius: 4px;
  overflow: hidden;
}
.ribbon-tile {
  background: var(--panel); padding: 14px 18px;
  display: flex; flex-direction: column; gap: 2px; min-width: 0;
}
.ribbon-tile.ribbon-ok   { background: linear-gradient(180deg, rgba(34, 197, 94, 0.08), var(--panel)); }
.ribbon-tile.ribbon-warn { background: linear-gradient(180deg, rgba(234, 179, 8, 0.12), var(--panel)); }
.ribbon-tile.ribbon-err  { background: linear-gradient(180deg, rgba(239, 68, 68, 0.14), var(--panel)); }
.ribbon-num {
  font-size: 22px; font-weight: 600; line-height: 1;
  font-feature-settings: "tnum"; letter-spacing: -0.01em;
  color: var(--text);
}
.ribbon-tile.ribbon-warn .ribbon-num { color: var(--yellow); }
.ribbon-tile.ribbon-err  .ribbon-num { color: var(--red); }
.ribbon-label {
  font-size: 11px; color: var(--muted);
  letter-spacing: 0.06em; margin-top: 4px; font-weight: 500;
}

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

/* ===== Error / empty =================================================== */
.error-banner {
  background: var(--red-bg); color: var(--red);
  padding: 10px 14px; border-radius: 4px; margin-bottom: 16px;
  border: 1px solid rgba(239, 68, 68, 0.3); font-size: 13px;
}
.empty {
  text-align: center; color: var(--muted);
  padding: 28px; font-size: 13px;
}
.loading { text-align: center; color: var(--muted); padding: 16px; font-size: 12px; }

/* ===== Matrix ==========================================================
   N+1 列 / N+1 行。首行 + 首列 sticky。N 大时 .matrix-wrap 横向 scroll。
   cell min-width 80px 让 site 名字长也不挤;Hub↔Hub cell 加 .cell-hub-pair
   加重边框;Hub↔Spoke cell .cell-hub-spoke 略缩以容纳多 spoke。 */
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

/* ===== Cell base + states ============================================== */
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

/* ===== R80 per-DC sub-grid ============================================= */
.dc-subgrid {
  border-collapse: separate; border-spacing: 1px;
  margin: 0 auto;
  display: inline-table;
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

/* ===== R68 Hub-Spoke layered panels ==================================== */
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

/* ── Cell layer modifiers ───────────────────────────────────────────── */
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
.cell-hub-spoke {
  min-width: 70px;
}

/* ===== R71 cell-click affordance + cell-detail modal ================== */
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

.cell-detail-modal .pair-row-ok   { background: rgba(34, 197, 94, 0.04); }
.cell-detail-modal .pair-row-warn { background: rgba(234, 179, 8, 0.06); }
.cell-detail-modal .pair-row-err  { background: rgba(239, 68, 68, 0.06); }

.cell-detail-modal .pair-row-highlighted {
  background: rgba(99, 102, 241, 0.12) !important;
  box-shadow: inset 3px 0 0 var(--accent);
}

/* Status pill (跟 R49 复制状态概览同款词表) */
.status-pill {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 10px; padding: 2px 8px; border-radius: 2px;
  font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
  font-family: ui-monospace, monospace;
}
.status-pill::before {
  content: ''; display: inline-block;
  width: 5px; height: 5px; border-radius: 50%;
}
.status-pill-ok {
  background: rgba(34, 197, 94, 0.10); color: var(--green);
  border: 1px solid rgba(34, 197, 94, 0.3);
}
.status-pill-ok::before   { background: var(--green); }
.status-pill-warn {
  background: rgba(234, 179, 8, 0.10); color: var(--yellow);
  border: 1px solid rgba(234, 179, 8, 0.3);
}
.status-pill-warn::before { background: var(--yellow); }
.status-pill-err {
  background: rgba(239, 68, 68, 0.10); color: var(--red);
  border: 1px solid rgba(239, 68, 68, 0.3);
}
.status-pill-err::before  { background: var(--red); }

/* ===== R72 pair-row expandability + inline attempts sub-table ======== */
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