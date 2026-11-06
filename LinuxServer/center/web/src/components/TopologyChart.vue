<!--
  R158.45 (2026-10-05) — `/topology` 完全重写, 抛弃 ECharts.

  历史 (R43-R138 7 轮迭代的 ECharts 实现):
    - R43 — direction (mutual → hub-spoke)
    - R59 — split into 出战 + 入站 two ECharts panels
    - R61 — change panels from horizontal + 3-color edges
    - R62 — collapse back to ONE chart; arrow direction is enough
    - R63 — wrap each site's DCs in a colored site bounding box (SVG)
    - R68 — Hub-Spoke visual emphasis (Hub gold, Spoke faded, edge width)
    - R69 — click node → drill into detail modal
    - R70 — click edge → drill into pair-history modal
    - S83 — replace force-graph with nested tree; sites are parents,
            DCs are children, true containment (R63 SVG overlay retired)
    - R138 — graphic.elements: site cards + DC groups + bridgehead角标

  R158.45 重写动机:
    operator 提交参考图 (D:\dashboard\adsiteLink.jpg) 显示 AD 域拓扑应像
    AD Sites and Services 一样 — 椭圆站点 + 服务器图标 + 显式 bridgehead
    callout + 命名 site-link (SFO↔NYC / BOW↔NYC / DFW↔SFO). 现行 ECharts
    实现的 card-grid 视觉跟参考图差异大, 跟 operator 期望偏差.

  R158.45 重写后:
    - HTML5 Canvas 2D 替代 ECharts (轻量, 跟参考图视觉 1:1 接近)
    - 椭圆站点 + DC 服务器图标 (不规则矩形 server icon 居中)
    - Bridgehead callout: gold-tinted 矩形 + 左三角指向, 含 DC name
    - Site-link midpoint pill: e.g. "SFO↔NYC" (从 source/dest site 短码拼)
    - 颜色 binary (operator 2026-10-05 决策):
        statusCode === 0 → 绿 (正常)
        statusCode >= 1  → 红 (不健康)        // 抛弃 R138 3-tier 绿/黄/红
    - 出战 = 实线 + 箭头朝 target
    - 入战 = 虚线 + 箭头朝 source
    - 鼠标滚轮缩放 (锚点跟随光标)
    - 拖拽平移 (空白处按下左键)
    - "重置视图" 按钮 + 双击空白重置 (fit-to-content)
    - 复用 R69 node-detail + R70 edge-detail modal (lift 到 useTopologyDetail.js)
    - Hub-Spoke: Hub 金 + 2px + "承载层" badge; Spoke 灰 + 1px;
      Hub↔Hub 2.5px, Hub↔Spoke 1.0px, Spoke↔Spoke 隐藏

  持久 lesson (R158.37.3): 整文件 Write, 纯 UTF-8 无 BOM, 落地后
  `[System.IO.File]::ReadAllBytes + Encoding.UTF8.GetString` 校验.
-->
<template>
  <!-- R158.45.6 — operator "归类需要放在详细内容中": 主图无 legend 文字描述.
       视觉编码靠: 颜色 (绿/红) + 线型 (实/虚/点) + 形状 (rect=site, 圆=DC, 金★=Hub, 金=bridgehead).
       详细分类/角色/状态描述全部在 modal 详情里. 仅保留"重置视图"按钮. -->
  <div class="topology-toolbar">
    <button type="button" class="reset-btn" data-test="topology-reset" @click="resetView">重置视图</button>
  </div>

  <div class="topology-single">
    <section class="structure" data-test="topology-structure">
      <canvas
        ref="canvasEl"
        class="canvas-host"
        data-test="topology-chart"
        @wheel.prevent="onWheel"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @dblclick="onDblClick"
      ></canvas>
    </section>
  </div>

  <!-- R158.45.6 — operator 把顶部标题与详细描述移到右侧栏, 不再写 h3 大标题.
       右边栏放说明 (站点/DC/复制方向/点击行为), 主图纯拓扑. -->
  <aside class="topology-aside">
    <ul class="topology-legend-list">
      <li><span class="legend-shape legend-shape-rect-hub"></span><span>矩形 = 站点 (Hub 金边 ★)</span></li>
      <li><span class="legend-shape legend-shape-circle"></span><span>圆点 = DC 服务器</span></li>
      <li><span class="legend-shape legend-shape-rect-bridge"></span><span>金边矩形 = 桥头 DC</span></li>
      <li><span class="legend-line legend-line-solid legend-line-ok"></span><span>实线 = 出战 (源 → 目标)</span></li>
      <li><span class="legend-line legend-line-dashed legend-line-ok"></span><span>虚线 = 入站 (目标 ← 源)</span></li>
      <li><span class="legend-line legend-line-dotted"></span><span>点线 = 站内复制</span></li>
      <li><span class="legend-line legend-line-solid legend-line-err"></span><span>红 = 不健康 / 绿 = 健康</span></li>
      <!-- R158.X.99-silent.topology (2026-10-21) — silent 边视觉说明。
           跟红实线同色, 靠 dash [2,6] 细密点线区分。tooltip 里会写明
           "探针接入无报告", 但主图上没文字, 所以图例这行是唯一文字锚点。 -->
      <li><span class="legend-line legend-line-silent"></span><span>细密点线红 = 探针接入未报告 (先查 agent 服务)</span></li>
      <li><span class="legend-text">悬停节点 → 高亮邻接边</span></li>
      <li><span class="legend-text">点击节点/边 → 详细内容</span></li>
      <li><span class="legend-text">Ctrl+拖拽 = 移动, 双击空白 = 重置</span></li>
    </ul>
  </aside>

  <!-- R69: node-click drill-down modal. data-test contract preserved verbatim
       from R138 (R158.45 extracted logic to useTopologyDetail.js composable
       but the template stays inline so the test selectors don't move). -->
  <div v-if="clickedNode" class="modal-bg" @click.self="closeModal" data-test="node-detail-modal">
    <div class="modal node-detail-modal">
      <header>
        <h3 data-test="node-detail-title">{{ nodeDetail.title }}</h3>
        <p v-if="nodeDetail.meta" class="meta" data-test="node-detail-meta">{{ nodeDetail.meta }}</p>
      </header>
      <section class="form-body">
        <div v-if="nodeDetail.dcList.length" class="detail-section">
          <span class="label">DC 列表 ({{ nodeDetail.dcList.length }})</span>
          <ul class="dc-list" data-test="node-detail-dc-list">
            <li
              v-for="dc in nodeDetail.dcList"
              :key="dc.name"
              class="dc-row"
              data-test="node-detail-dc-row"
            >
              <span class="dc-name">{{ dc.name }}</span>
              <span class="dc-roles">
                <span v-if="dc.isBridgehead" class="role-badge role-bridge">桥头</span>
                <span v-if="dc.isPdc" class="role-badge role-pdc">主控</span>
                <span v-else-if="dc.isGc" class="role-badge role-gc">GC</span>
                <span v-if="dc.isRid" class="role-badge role-rid">RID</span>
                <span v-if="dc.isInfra" class="role-badge role-infra">基础结构</span>
                <span v-if="dc.isNaming" class="role-badge role-naming">命名</span>
                <span v-if="!anyRole(dc)" class="role-badge role-member">成员</span>
              </span>
              <span class="dc-partner-count">{{ dc.partnerCount }} 复制伙伴</span>
            </li>
          </ul>
        </div>

        <div v-if="nodeDetail.partners.length" class="detail-section">
          <span class="label">复制伙伴 ({{ nodeDetail.partners.length }})</span>
          <ul class="partner-list" data-test="node-detail-partners">
            <li
              v-for="p in nodeDetail.partners"
              :key="p.isIntra ? `intra` : `${p.peerSite}|${p.direction}`"
              class="partner-row"
              :class="`partner-row-${p.status}`"
              data-test="node-detail-partner"
            >
              <span class="partner-dir">
                <!-- R158.45.4 — operator "算出 3 不对, 真数 1": partner 维度从 peerDc 改 peerSite,
                     'both' = 跨站的多 peerDc 同时有出战+入站, 聚合后展示 -->
                <span v-if="p.direction === 'intra'" class="dir-tag dir-intra">站内</span>
                <span v-else-if="p.direction === 'both'" class="dir-tag dir-both">出战+入站</span>
                <span v-else-if="p.direction === 'out'" class="dir-tag dir-out">出战</span>
                <span v-else class="dir-tag dir-in">入站</span>
              </span>
              <span class="partner-peer">
                <span v-if="p.isIntra">{{ p.peerSite }}</span>
                <template v-else>
                  <span class="partner-peer-site">{{ p.peerSite }}</span>
                  <span class="partner-peer-dcs">
                    <span v-for="(dc, i) in p.peerDcs" :key="dc.name" class="peer-dc-chip">
                      {{ dc.name }}<span class="peer-dc-dir">{{ dc.direction === 'both' ? '↔' : (dc.direction === 'out' ? '出' : (dc.direction === 'in' ? '入' : '·')) }}</span><span v-if="i < p.peerDcs.length - 1"> · </span>
                    </span>
                  </span>
                </template>
              </span>
              <span class="partner-status" :class="`status-${p.status}`">
                {{ p.statusLabel }}
              </span>
            </li>
          </ul>
        </div>

        <p v-if="!nodeDetail.dcList.length && !nodeDetail.partners.length" class="empty">
          没有可显示的详情。
        </p>
      </section>
      <footer>
        <button type="button" data-test="node-detail-close" @click="closeModal">关闭</button>
      </footer>
    </div>
  </div>

  <!-- R70: edge-click drill-down modal. data-test contract preserved verbatim. -->
  <div v-if="clickedEdge" class="modal-bg" @click.self="closeEdgeModal" data-test="edge-detail-modal">
    <div class="modal edge-detail-modal">
      <header>
        <h3 data-test="edge-detail-title">{{ edgeDetail.title }}</h3>
        <p v-if="edgeDetail.meta" class="meta" data-test="edge-detail-meta">{{ edgeDetail.meta }}</p>
      </header>
      <section class="form-body">
        <!-- R158.X.99-silent.topology — 探针接入无报告提示条.
             attempt 表走的是老 30min probe 历史 (可能显示"24h 前成功过"),
             silent 表示**当前**接入探针 0 报告 —— 两者语义不同, 用独立提示条
             分层, 避免操作员看 attempt 表全是 ✓ 以为没事。 -->
        <div v-if="clickedEdge && clickedEdge.isSilent" class="edge-silent-banner" data-test="edge-silent-banner">
          ⊙ 探针接入未报告 — 该链路的接入探针当前 0 报告数据 (边已按红色细密点线标出)。
          先查源 DC agent 服务状态; 若 agent 正常, 再查 KB replication。
        </div>
        <div v-if="edgeLoading" class="loading" data-test="edge-detail-loading">
          正在加载最近 10 条复制尝试…
        </div>
        <div v-else-if="edgeError" class="error-banner" data-test="edge-detail-error">
          加载失败 — {{ edgeError }}
        </div>
        <div v-else-if="edgeDetail.summary" class="detail-section">
          <span class="label">24h 摘要</span>
          <p class="summary-line" data-test="edge-detail-summary">{{ edgeDetail.summary }}</p>
        </div>

        <div v-if="!edgeLoading && !edgeError && edgeDetail.entries.length" class="detail-section">
          <span class="label">最近 {{ edgeDetail.entries.length }} 条尝试</span>
          <table class="attempts-table" data-test="edge-detail-attempts">
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
                v-for="(a, i) in edgeDetail.entries"
                :key="i"
                class="attempt-row"
                :class="`attempt-row-${attemptStatusClass(a.statusCode)}`"
                data-test="edge-detail-attempt"
              >
                <td>{{ fmtTs(a.attemptAt) }}</td>
                <td>
                  <span class="glyph">{{ attemptGlyph(a.statusCode) }}</span>
                  {{ attemptLabel(a.statusCode) }}
                </td>
                <td>{{ a.durationMs ?? '—' }}</td>
                <td>{{ a.objectsTransferred ?? '—' }}</td>
                <td>{{ fmtTs(a.lastSuccessTime) }}</td>
                <td class="error-cell">{{ a.errorMessage || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <p v-else-if="!edgeLoading && !edgeError && !edgeDetail.entries.length" class="empty" data-test="edge-detail-empty">
          暂无 24h 内的复制尝试数据
        </p>
      </section>
      <footer>
        <button type="button" data-test="edge-detail-close" @click="closeEdgeModal">关闭</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch, nextTick, computed } from 'vue';
import { useChartTheme } from '../composables/useChartTheme.js';
import { useTopologyDetail } from '../composables/useTopologyDetail.js';

const props = defineProps({
  data: { type: Object, default: () => ({ nodes: [], links: [] }) }
});

// ── R137: theme-aware palette ────────────────────────────────────────
const { palette, theme } = useChartTheme();

// ── Modal logic lifted to composable (R158.45) ───────────────────────
const {
  clickedNode, clickedEdge, edgeHistory, edgeLoading, edgeError,
  nodeDetail, edgeDetail,
  linkStatusBucket, linkStatusLabel, anyRole,
  attemptGlyph, attemptLabel, attemptStatusClass, fmtTs,
  dcSiteLookup, hubSet,
  openNode, openEdge, closeModal, closeEdgeModal
} = useTopologyDetail(props);

// ── Canvas + transform stack ─────────────────────────────────────────
// R158.45.5 — hover state (邻接高亮 feature)
const hoveredNode = ref(null);           // { name, type, site?, dcNode?, siteObj? } | null

const canvasEl = ref(null);
let ctx = null;
let cssWidth = 0;
let cssHeight = 0;
const transform = ref({ tx: 0, ty: 0, scale: 1 });
const MIN_SCALE = 0.25;
const MAX_SCALE = 4.0;

// Geometry constants — adapted to reference image adsiteLink.jpg.
// R158.45.2 — operator "画大一些": DC 14×18→22×26, SITE 180×110→220×150,
// DC_GAP_Y 32→40, BRIDGEHEAD 168×36→200×44. SPOKE_RADIUS/HUB_CENTER 同步在后面改.
// R158.45.2 follow-up — SITE_RX 220→200 (北京 -135 跟上海 180 距离 367 < 440 重叠, 缩到 200 OK)
// R158.45.4 — operator "站点和站点太密集, 我们可以放宽一些, 然后站点内的DC 也开一些":
//   SITE_RX 200→260, SITE_RY 140→180 (矩形框更宽松), DC_GAP_Y 40→56 (DC 上下间距加大).
const SITE_RX = 260;
// R158.45.8 — operator "DC 横向排列" 后, bridgehead callout 移到 DC 行下方,
//   站点高度 = (DC 行 cy 偏 +6 + DC_H/2=19) + (callout stack 顶 16 + n*52 + 0) = 35 + n*52.
//   3 bridgehead = 35+104=139, 加 14 padding ≈ 160; 加 ry 顶部站名 30 + 底部 padding 30 ≈ 220.
//   提到 220 容纳多 bridgehead 站点 (3+ callout 不会超框).
const SITE_RY = 220;
// R158.45.7 — operator "bridgehead 为 DC, 但其他为点, 也需要做出来像 DC":
//   普通 DC 用小 rect (REG 18×22, 在 drawDcNodes 内定义), bridgehead 用 DC_W/DC_H.
//   间距 56 → 32 让多 DC 站点能排下 (单站可容 ~10 DC).
// R158.45.8 — operator "DC 为横向排列, 不要纵向" (限定在站点内):
//   DC 从垂直 stack (cx 固定, cy +i*GAP) 改水平 row (cy 固定 ellipse.cy, cx +i*GAP).
//   DC_GAP_X 10 = DC_W 22 的 ~45% 间距. 单行能排 ~20 DC (站点 520 宽 / 32 = 16 +).
const DC_W = 22;
const DC_H = 26;
const DC_GAP_X = 10;        // 横向 DC 间距
const DC_GAP_Y = 32;        // 保留供 layout 计算用 (实际不布局)
const BRIDGEHEAD_W = 200;
const BRIDGEHEAD_H = 44;
const BRIDGEHEAD_GAP_Y = 8;
const ARROW_HEAD = 7;
const HIT_PAD_PX = 6;      // screen-pixel hit-test slack

// Layout state — recomputed by buildLayout() on data/transform change.
const layoutState = ref({ sites: [], dcNodes: [], edges: [], bridgeheadBoxes: [], bbox: null });

// Render loop throttled to one paint per animation frame.
let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; draw(); });
}

// ── Helpers ──────────────────────────────────────────────────────────
function shortSite(name) {
  if (!name) return '?';
  if (name === '核心站点') return 'HUB';
  if (name.endsWith('站点')) return name.slice(0, 2);
  return name.slice(0, 3);
}

function isPairKey(a, b) {
  return a < b ? `${a}\u0001${b}` : `${b}\u0001${a}`;
}

// ── Layout pass — geographic placement matching adsiteLink.jpg ────────
// Hard-coded anchor table; unknown sites fall back to declaration-driven
// grid (declaration-driven grid = ROW/COL scan after per-site DC count).
// R158.45.1 (2026-10-05) — operator "如果一个站点是Hub 那么尽量在中间".
// 布局策略: Hub 站点始终居中, Spoke 站围绕 Hub 环形分布. 已知站点
// (核心 / 南昌 / 上海 / 广州 / 北京) 各自有固定角度 → 跟参考图
// adsiteLink.jpg 视觉一致; 未知 Hub 站也居中, 未知 Spoke 站环形排.
// 单 Hub 场景 (1 Hub + N Spoke): Hub 居中, Spoke 沿圆周均匀分布.
// 多 Hub 场景 (2+ Hub): 第一个 Hub 居中, 其他 Hub 在 Hub 圆环上,
// Spoke 站依次填剩余环位.
// R158.45.4 — operator "所有的方块必须不要折叠" + "站点和站点太密集".
//   改 grid 布局 (4×4 cell). Anchor 站按 (col, row) hint 摆, unknown fill 余 cell.
//   Cell 间距 = SITE_RX*2 + GAP (横) / SITE_RY*2 + GAP (竖), 数学上保证 16 站不重叠.
//   Hub 永远放 (1,1) 中心 cell (跟 R158.45.1 "Hub 居中" 不冲突).
const GEO_ANCHORS = {
  '核心站点':   { col: 1, row: 1, isHub: true  },       // 中心
  '南昌站点':   { col: 2, row: 0, isHub: false },      // 右上
  '上海站点':   { col: 0, row: 1, isHub: false },      // 左中
  '广州站点':   { col: 2, row: 2, isHub: false },      // 右下
  '北京站点':   { col: 1, row: 0, isHub: false }       // 顶中
};
const GRID_COLS = 4;
const GRID_ROWS = 4;
const GRID_GAP = 80;             // rect 之间的最小像素间距
const GRID_CELL_W = SITE_RX * 2 + GRID_GAP;   // 600
const GRID_CELL_H = SITE_RY * 2 + GRID_GAP;   // 440
const GRID_ORIGIN = { x: 200, y: 100 };       // 左上 cell 中心起点
function gridCellCenter(col, row) {
  return {
    x: GRID_ORIGIN.x + col * GRID_CELL_W + GRID_CELL_W / 2,
    y: GRID_ORIGIN.y + row * GRID_CELL_H + GRID_CELL_H / 2
  };
}

function buildLayout() {
  const data = props.data || { nodes: [], links: [] };
  const sites = [];
  const siteMap = new Map();        // siteName → site obj
  const seenSites = new Set();
  for (const n of data.nodes || []) {
    if (n.type === 'site' && !seenSites.has(n.name)) {
      const isHub = !!n.isHub;
      const anchor = GEO_ANCHORS[n.name] || null;
      const s = {
        _original: n,
        name: n.name,
        isHub,
        isOrphan: false,
        anchor,
        ellipse: { cx: 0, cy: 0, rx: SITE_RX, ry: SITE_RY },
        dcs: []
      };
      sites.push(s);
      siteMap.set(n.name, s);
      seenSites.add(n.name);
    }
  }
  // Orphan bucket (R138 lesson carry-over).
  const orphanDcs = [];
  for (const n of data.nodes || []) {
    if (n.type !== 'dc') continue;
    if (n.site && siteMap.has(n.site)) {
      siteMap.get(n.site).dcs.push({
        _original: n,
        name: n.name,
        site: n.site,
        isBridgehead: !!n.isBridgehead
      });
    } else {
      orphanDcs.push({
        _original: n,
        name: n.name,
        site: n.site || null,
        isBridgehead: !!n.isBridgehead
      });
    }
  }
  if (orphanDcs.length) {
    sites.push({
      _original: { name: '未分组', type: 'site', isHub: false },
      name: '未分组',
      isHub: false,
      isOrphan: true,
      anchor: null,
      ellipse: { cx: 0, cy: 0, rx: SITE_RX, ry: SITE_RY },
      dcs: orphanDcs
    });
  }
  // R158.45.4 — operator "所有的方块必须不要折叠" + "站点和站点太密集".
  //   Grid layout (4×4). Anchor 站按 GEO_ANCHORS (col, row), unknown fill 余 cell.
  //   Cell 间距 600×440 = rect(260×180) + GAP(80), 数学保证 rect 不重叠.
  //   Hub 永远放 (1,1) cell (跟 R158.45.1 "Hub 居中" 等价).
  const usedCells = new Set();
  const hubs = sites.filter(s => s.isHub);
  const spokes = sites.filter(s => !s.isHub && !s.isOrphan);

  // 1) Hub 站: 第 1 个放 (1,1) 中心, 多余 Hub 占 (0,0)/(3,3)/etc (外圈空 cell).
  const hubCellOrder = [{ col: 1, row: 1 }, { col: 0, row: 0 }, { col: 3, row: 3 }, { col: 0, row: 3 }, { col: 3, row: 0 }];
  for (let i = 0; i < hubs.length; i++) {
    const cell = hubCellOrder[i % hubCellOrder.length];
    const c = gridCellCenter(cell.col, cell.row);
    hubs[i].ellipse.cx = c.x;
    hubs[i].ellipse.cy = c.y;
    hubs[i].col = cell.col; hubs[i].row = cell.row;
    usedCells.add(`${cell.col},${cell.row}`);
  }

  // 2) Spoke 站: anchor 按 (col, row) hint; 无 anchor 按 ROW scan fill 余 cell.
  for (const s of spokes) {
    const a = GEO_ANCHORS[s.name];
    if (a && Number.isFinite(a.col) && Number.isFinite(a.row) &&
        !usedCells.has(`${a.col},${a.row}`)) {
      const c = gridCellCenter(a.col, a.row);
      s.ellipse.cx = c.x;
      s.ellipse.cy = c.y;
      s.col = a.col; s.row = a.row;
      usedCells.add(`${a.col},${a.row}`);
    } else {
      // 标记 unknown, 第 3 步统一填
      s._needsPlacement = true;
    }
  }
  // Fill unknown spoke 按 ROW scan
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (usedCells.has(`${c},${r}`)) continue;
      const s = spokes.find(x => x._needsPlacement);
      if (!s) break;
      const cc = gridCellCenter(c, r);
      s.ellipse.cx = cc.x;
      s.ellipse.cy = cc.y;
      s.col = c; s.row = r;
      usedCells.add(`${c},${r}`);
      delete s._needsPlacement;
    }
  }
  // 清理 (防御性)
  for (const s of sites) delete s._needsPlacement;

  // 3) Orphan bucket: 放 grid 外右下角 (远离主 grid).
  const orphan = sites.find(s => s.isOrphan);
  if (orphan) {
    orphan.ellipse.cx = GRID_ORIGIN.x + GRID_COLS * GRID_CELL_W + 360;
    orphan.ellipse.cy = GRID_ORIGIN.y + GRID_ROWS * GRID_CELL_H + 200;
  }

  // Position DCs horizontally inside each site, centered around ellipse cx.
  // R158.45.8 — operator "DC 为横向排列, 不要纵向" (站点内):
  //   DC 改成一行水平排列, cy 固定 ellipse.cy (微调 +6 偏上避免压站名).
  //   cx 从 (总宽/2 偏移) 开始, 每 DC + (DC_W + DC_GAP_X).
  //   总宽 = n*DC_W + (n-1)*DC_GAP_X, 居中 startX = ellipse.cx - 总宽/2.
  //   站点宽 520 (SITE_RX*2) 可排 16+ DC, 多数站 4-12 DC 一行足够.
  const dcNodes = [];
  for (const s of sites) {
    const n = s.dcs.length;
    const rowW = n * DC_W + Math.max(0, n - 1) * DC_GAP_X;
    const startX = s.ellipse.cx - rowW / 2;
    const rowY = s.ellipse.cy + 6;     // 微调偏下, 留空间给站名标签 (在 cy-ry+18)
    s.dcs.forEach((dc, i) => {
      const node = {
        _original: dc._original,
        name: dc.name,
        site: s.name,
        isBridgehead: dc.isBridgehead,
        cx: startX + i * (DC_W + DC_GAP_X) + DC_W / 2,
        cy: rowY,
        siteRef: s
      };
      dcNodes.push(node);
      dc.cx = node.cx;
      dc.cy = node.cy;
    });
  }

  // Edges: each cross-site link → 2 physical (out + in); intra-site → 1.
  // Spoke-Spoke cross-site links HIDDEN (Hub-Spoke compliance).
  const hub = new Set(sites.filter(s => s.isHub).map(s => s.name));
  // R158.45.1 — dcByName 改成指向 dcNodes (live ref, 不是 snapshot),
  // 这样拖拽 DC 后 edge 端点自动跟随.
  const dcByName = new Map();
  for (const n of dcNodes) {
    dcByName.set(n.name, { cx: n.cx, cy: n.cy, site: n.site, ref: n });
  }

  function dcSitePair(srcDc, dstDc) {
    const sSite = dcByName.get(srcDc)?.site;
    const dSite = dcByName.get(dstDc)?.site;
    return { sSite, dSite };
  }
  function isHidden(sSite, dSite) {
    if (!sSite || !dSite) return false;            // orphan stays visible
    if (sSite === dSite) return false;
    return !hub.has(sSite) && !hub.has(dSite);     // spoke↔spoke = hide
  }

  const edges = [];
  for (const l of data.links || []) {
    const src = l.source, dst = l.target;
    if (!src || !dst || src === dst) continue;
    const { sSite, dSite } = dcSitePair(src, dst);
    if (isHidden(sSite, dSite)) continue;
    const srcNode = dcByName.get(src);
    const dstNode = dcByName.get(dst);
    if (!srcNode || !dstNode) continue;
    const intra = sSite && dSite && sSite === dSite;
    const sc = l.statusCode ?? 0;
    // R158.X.99-silent.topology (2026-10-21) \u2014 probe_state 'none' = \u94fe\u8def\u5b58\u5728\u4f46
    //   \u63a5\u5165\u63a2\u9488 0 \u62a5\u544a (\u63a2\u9488\u4ece\u6ca1\u62a5\u8fc7\u8fd9 pair \u7684\u590d\u5236\u7ed3\u679c). \u8ddf status_code=2
    //   (\u590d\u5236\u771f\u6302) \u90fd\u662f\u7ea2, \u4f46**\u6545\u969c\u8bed\u4e49\u4e0d\u540c**: silent \u5148\u67e5 agent service,
    //   err \u5148\u67e5 KB replication. \u8ddf /matrix/inbound \u7684 dc-pair silent \u7ea2
    //   1:1 \u5e73\u884c (\u540c probe_state \u6570\u636e\u6e90, \u540c\u8bed\u4e49).
    //   \u964d\u7ea7: probeState=null (v_partner_inbound \u65e0\u5339\u914d row) \u2192 **\u4e0d\u5f53 silent**,
    //   \u8d70\u8001 status_code \u8bed\u4e49 \u2014\u2014 \u8ddf matrix silent \u62c6\u5206\u70b9 1:1 \u5e73\u884c (partner \u7f3a\u5931
    //   \u4e0d\u5f53 silent, \u53ea\u5728 probeState \u660e\u786e='none' \u624d\u6807).
    const ps = l.probeState ?? null;
    const isSilent = ps === 'none';
    if (intra) {
      edges.push({
        kind: 'intra',
        sourceDc: src, targetDc: dst,
        source: srcNode, target: dstNode,
        sourceSite: sSite, destSite: dSite,
        direction: 'intra',
        statusCode: sc,
        probeState: ps,
        isSilent,
        curveDirection: 0,
        midpointLabel: `${shortSite(sSite)}\u2194${shortSite(dSite)}`
      });
    } else {
      // R158.45.1 (2026-10-05) \u2014 operator "\u51fa\u5206\u6210\u4e24\u6761\u7ebf\u989c\u8272\u533a\u5206" + "\u7528\u5f27\u7ebf\u4f1a\u4e0d\u4f1a\u66f4\u597d".
      // \u51fa\u6218/\u5165\u6218 \u753b\u4e24\u6761\u72ec\u7acb Bezier \u5f27, \u5f27\u9876\u70b9\u65b9\u5411\u4e0d\u540c (\u51fa\u6218\u4e0a\u5f2f, \u5165\u6218\u4e0b\u5f2f),
      // \u5f62\u6210\u53cc\u6865\u7ed3\u6784. \u989c\u8272\u4e8c\u5143\u53e0\u52a0 (\u51fa\u6218\u5065\u5eb7=\u7eff/\u4e0d\u5065\u5eb7=\u7ea2; \u5165\u6218\u5065\u5eb7=muted \u7070/\u4e0d\u5065\u5eb7=\u7ea2).
      edges.push({
        kind: 'cross-out',
        sourceDc: src, targetDc: dst,
        source: srcNode, target: dstNode,
        sourceSite: sSite, destSite: dSite,
        direction: 'out',
        statusCode: sc,
        probeState: ps,
        isSilent,
        curveDirection: +1,                   // \u51fa\u6218\u5f27\u9876\u70b9\u5411\u4e0a\u5f2f
        midpointLabel: `${shortSite(sSite)}\u2194${shortSite(dSite)}`
      });
      edges.push({
        kind: 'cross-in',
        sourceDc: src, targetDc: dst,
        source: dstNode, target: srcNode,
        sourceSite: sSite, destSite: dSite,
        direction: 'in',
        statusCode: sc,
        probeState: ps,
        isSilent,
        curveDirection: -1,                   // \u5165\u6218\u5f27\u9876\u70b9\u5411\u4e0b\u5f2f
        midpointLabel: `${shortSite(sSite)}\u2194${shortSite(dSite)}`
      });
    }
  }

  // Bridgehead callout boxes (R158.45). R158.45.8 — operator "DC 横向排列":
  //   callout 移到 DC 行下方 (cy + DC_H/2 + 16), 仍然右对齐站点 (cx + rx - 10).
  //   多 bridgehead 垂直 stack, 起始 y = DC 行底 + 16.
  const bridgeheadBoxes = [];
  for (const s of sites) {
    const bridgeheads = s.dcs.filter(d => d.isBridgehead);
    if (!bridgeheads.length) continue;
    const dcRowBottomY = s.ellipse.cy + 6 + DC_H / 2;
    const baseY = dcRowBottomY + 16;
    bridgeheads.forEach((bh, idx) => {
      const y = baseY + idx * (BRIDGEHEAD_H + BRIDGEHEAD_GAP_Y);
      const x = s.ellipse.cx + s.ellipse.rx - 10 - BRIDGEHEAD_W;
      bridgeheadBoxes.push({
        x, y, w: BRIDGEHEAD_W, h: BRIDGEHEAD_H,
        dcName: bh.name,
        siteName: s.name,
        dcOriginal: bh._original
      });
    });
  }

  // World bbox — drives the "重置视图" fit-to-content calc.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of sites) {
    minX = Math.min(minX, s.ellipse.cx - s.ellipse.rx);
    minY = Math.min(minY, s.ellipse.cy - s.ellipse.ry);
    maxX = Math.max(maxX, s.ellipse.cx + s.ellipse.rx);
    maxY = Math.max(maxY, s.ellipse.cy + s.ellipse.ry);
  }
  for (const b of bridgeheadBoxes) {
    maxX = Math.max(maxX, b.x + b.w);
    minY = Math.min(minY, b.y);
    maxY = Math.max(maxY, b.y + b.h);
  }
  for (const e of edges) {
    minX = Math.min(minX, e.source.cx, e.target.cx);
    maxX = Math.max(maxX, e.source.cx, e.target.cx);
    minY = Math.min(minY, e.source.cy, e.target.cy);
    maxY = Math.max(maxY, e.source.cy, e.target.cy);
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 800; maxY = 600; }
  const bbox = { minX: minX - 40, minY: minY - 40, maxX: maxX + 40, maxY: maxY + 40 };

  layoutState.value = { sites, dcNodes, edges, bridgeheadBoxes, bbox };
}

// ── Drawing ──────────────────────────────────────────────────────────
function draw() {
  if (!ctx) return;
  // Background.
  const p = palette.value;
  ctx.save();
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  // Apply DPR already (resizeCanvas set it). World transform on top.
  ctx.translate(transform.value.tx, transform.value.ty);
  ctx.scale(transform.value.scale, transform.value.scale);

  drawSiteEllipses();
  drawEdges();
  drawDcNodes();
  drawBridgeheadCallouts();
  drawSiteLabels();
  drawEdgeLabels();   // R158.45.5 — function body 清空 (operator "用颜色区分"), 保留 call site 防止 undefined.
  ctx.restore();
}

function drawSiteEllipses() {
  const p = palette.value;
  for (const s of layoutState.value.sites) {
    ctx.save();
    const isHover = hoveredNode && hoveredNode.name === s.name;
    if (s.isOrphan) {
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = p.muted;
      ctx.fillStyle = p.panel;
    } else if (s.isHub) {
      ctx.setLineDash([]);
      ctx.lineWidth = isHover ? 3 : 2.5;
      ctx.strokeStyle = p['hub-gold'];
      // R158.45.5 — Hub 金色 fill + glow (深色背景下突出)
      ctx.fillStyle = `color-mix(in srgb, ${p['hub-gold']} 18%, ${p.panel} 82%)`;
      if (isHover) {
        ctx.shadowColor = p.glow;
        ctx.shadowBlur = 24;
      }
    } else {
      ctx.setLineDash([]);
      ctx.lineWidth = isHover ? 2 : 1.2;
      ctx.strokeStyle = isHover ? p.hover : p.border;
      ctx.fillStyle = isHover
        ? `color-mix(in srgb, ${p['hub-gold']} 10%, ${p.panel} 90%)`
        : p.panel;
      if (isHover) {
        ctx.shadowColor = p.glow;
        ctx.shadowBlur = 12;
      }
    }
    ctx.beginPath();
    ctx.roundRect(s.ellipse.cx - s.ellipse.rx, s.ellipse.cy - s.ellipse.ry, s.ellipse.rx * 2, s.ellipse.ry * 2, 12);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

function drawSiteLabels() {
  const p = palette.value;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const s of layoutState.value.sites) {
    ctx.save();
    const isHover = hoveredNode && (hoveredNode.name === s.name);
    // R158.45.6 — operator "归类放详细内容中": 主图只显示站名缩写 + Hub 角标.
    //   站名用 shortSiteLabel 缩写; Hub 顶部 1 个 "★" 字符标记承载层.
    //   详细分类/角色描述放 modal 里.
    if (s.isHub) {
      ctx.fillStyle = isHover ? p.hover : p['hub-gold'];
      ctx.font = `${isHover ? '800' : '700'} 14px sans-serif`;
    } else if (s.isOrphan) {
      ctx.fillStyle = p.muted;
      ctx.font = '500 11px sans-serif';
    } else {
      ctx.fillStyle = isHover ? p.hover : p.text;
      ctx.font = `${isHover ? '700' : '600'} 12px sans-serif`;
    }
    const labelY = s.ellipse.cy - s.ellipse.ry + 18;
    const displayName = shortSiteLabel(s.name);     // R158.45.6: Hub 也用缩写 ("核心")
    ctx.fillText(displayName, s.ellipse.cx, labelY);
    if (s.isHub) {
      // Hub 角色标识 (★ 字符, 主图轻量标记)
      ctx.fillStyle = p['gold-label'];
      ctx.font = '700 11px sans-serif';
      ctx.fillText('★', s.ellipse.cx, labelY + 14);
    }
    ctx.restore();
  }
}

// R158.45.5 — 站名缩写: 取末 2 字, "核心" "南昌" "上海" "车墩" 等.
function shortSiteLabel(name) {
  if (!name) return '?';
  // 已知映射 (R158.45.4 GEO_ANCHORS 5 + 11 unknown 各 2-3 字短码)
  const MAP = {
    '核心站点': '核心',
    '南昌站点': '南昌',
    '上海站点': '上海',
    '广州站点': '广州',
    '北京站点': '北京',
    '康德乐枫林': '枫林',
    '康德乐上海车墩': '车墩',
    '康德乐深圳': '深圳',
    '康德乐成都': '成都',
    '康德乐武汉': '武汉',
    '康德乐南京': '南京',
    '康德乐杭州': '杭州',
    '康德乐青岛': '青岛',
    '康德乐沈阳': '沈阳',
    '康德乐西安': '西安',
    '康德乐重庆': '重庆'
  };
  if (MAP[name]) return MAP[name];
  // fallback: 末 2 字
  return name.length <= 4 ? name : name.slice(-2);
}

function drawDcNodes() {
  const p = palette.value;
  // R158.45.7 — operator "bridgehead 为 DC, 但其他为点, 也需要做出来像 DC":
  //   所有 DC 都画成 DC 服务器图标 (rect + LED dot), 不用抽象圆点.
  //   bridgehead DC: 金边 + 金色 LED (金色突出角色).
  //   普通 DC: 灰边 + 灰色 LED (跟 bridgehead 同形态, 区分靠颜色).
  //   DC 尺寸: 18×22 普通, 22×26 bridgehead (略大突出).
  const REG_W = 18, REG_H = 22;       // 普通 DC rect 尺寸
  const BH_W = DC_W, BH_H = DC_H;     // bridgehead DC rect 尺寸 (22×26)
  for (const d of layoutState.value.dcNodes) {
    ctx.save();
    if (d.isBridgehead) {
      // bridgehead: 金边 + 金色 fill
      ctx.fillStyle = `color-mix(in srgb, ${p['hub-gold']} 35%, ${p['panel-alt']} 65%)`;
      ctx.strokeStyle = p['hub-gold'];
      ctx.lineWidth = 1.8;
      const x = d.cx - BH_W / 2;
      const y = d.cy - BH_H / 2;
      ctx.beginPath();
      ctx.roundRect(x, y, BH_W, BH_H, 3);
      ctx.fill();
      ctx.stroke();
      // 顶部 LED (金色, 区分角色)
      ctx.fillStyle = p['hub-gold'];
      ctx.beginPath();
      ctx.arc(d.cx, d.cy - BH_H / 2 + 3, 1.5, 0, Math.PI * 2);
      ctx.fill();
      // 底部机柜线 (3 横线表示服务器高度)
      ctx.strokeStyle = p['hub-gold'];
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(x + 4, d.cy);
      ctx.lineTo(x + BH_W - 4, d.cy);
      ctx.moveTo(x + 4, d.cy + 4);
      ctx.lineTo(x + BH_W - 4, d.cy + 4);
      ctx.stroke();
    } else {
      // 普通 DC: 跟 bridgehead 同形态 (rect + LED + 机柜线), 灰色
      ctx.fillStyle = p['panel-alt'];
      ctx.strokeStyle = p.border;
      ctx.lineWidth = 1.2;
      const x = d.cx - REG_W / 2;
      const y = d.cy - REG_H / 2;
      ctx.beginPath();
      ctx.roundRect(x, y, REG_W, REG_H, 2);
      ctx.fill();
      ctx.stroke();
      // 顶部 LED (灰色)
      ctx.fillStyle = p.muted;
      ctx.beginPath();
      ctx.arc(d.cx, d.cy - REG_H / 2 + 2.5, 1.2, 0, Math.PI * 2);
      ctx.fill();
      // 机柜线 (2 横线)
      ctx.strokeStyle = p.border;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(x + 3, d.cy);
      ctx.lineTo(x + REG_W - 3, d.cy);
      ctx.moveTo(x + 3, d.cy + 3);
      ctx.lineTo(x + REG_W - 3, d.cy + 3);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawEdges() {
  const p = palette.value;
  const hubSetLocal = hubSet();
  for (const e of layoutState.value.edges) {
    // R158.45.5 — 边 alpha 弱化让节点跳出. 仅邻接边 (hover 时) 高亮.
    const isAdjacent = hoveredNode && (
      (e.sourceDc === hoveredNode.name || e.targetDc === hoveredNode.name) ||
      (hoveredNode.type === 'site' && (e.sourceSite === hoveredNode.name || e.destSite === hoveredNode.name))
    );
    const isDim = hoveredNode && !isAdjacent;
    const baseAlpha = isAdjacent ? 1.0 : (isDim ? 0.15 : 0.45);
    // R158.X.99-silent.topology — 边色两档:
    //   健康: 出战绿 / 入站灰 / 站内边框灰 (R158.45.5 原语义, 0 改)
    //   异常: 红。silent (探针接入 0 报告) 跟 err (复制真挂) 同红,
    //         区分靠下方 dash pattern [2,6] 细密点线 vs 真挂实线/长虚线。
    //         canvas 边上放 glyph 不现实 (会跟箭头/曲线打架), dash 是最干净的
    //         第二信号, 且跟图例 legend-line-silent 1:1 对应。
    // silent 优先级最高: 探针 0 报告时 statusCode 仍可能是 0 (老 30min probe
    //   报的是上一次成功), 但新 15min probe 0 数据 = 现状不可知 → 必须标红,
    //   不能让陈旧的 statusCode=0 把它画绿。这是 silent 跟 err 的**唯一**真
    //   正分歧点 (老 probe 有数据/新 probe 无数据), 跟 matrix dcPairState
    //   "partner 在 → statusCodeToCellClass(partner.statusCode)" 平行 ——
    //   matrix 那边 statusCode=3 是显式转译, 拓扑这边 statusCode 是老 3 档,
    //   所以必须在 isSilent 时**强制 override**。
    const color = e.isSilent
      ? p.red
      : (e.statusCode === 0
        ? (e.direction === 'out' ? p.green : (e.direction === 'in' ? p.muted : p.border))
        : p.red);
    const isHubSrc = hubSetLocal.has(e.sourceSite);
    const isHubDst = hubSetLocal.has(e.destSite);
    const isHubHub = isHubSrc && isHubDst;
    const width = (() => {
      // R158.45.6 — operator "当前线太细了": 边宽全面加粗.
      //   普通 0.9→1.6, intra 1.2→2.0, hub-hub 2.0→3.0. 16 站密集场景要看清.
      if (e.direction === 'intra') return 2.0;
      if (isHubHub) return 3.0;
      return 1.6;
    })();
    const a = e.source;
    const b = e.target;
    const dx = b.cx - a.cx;
    const dy = b.cy - a.cy;
    const len = Math.hypot(dx, dy) || 1;
    const midX = (a.cx + b.cx) / 2;
    const midY = (a.cy + b.cy) / 2;
    const curve = (e.curveDirection || 0) * len * 0.20;     // R158.45.5: 0.18→0.20 更明显弧度
    const ctrlX = midX - (dy / len) * curve;
    const ctrlY = midY + (dx / len) * curve;
    ctx.save();
    ctx.globalAlpha = baseAlpha;
    // R158.45.5 — Hub↔Hub 边金色突出
    const strokeColor = isHubHub ? p['hub-gold'] : color;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = isAdjacent ? width * 1.5 : width;
    // R158.45.5 — operator "将文字的 出入 去掉, 转而用颜色区分":
    //   出战 (out) = 实线, 入战 (in) = 虚线, 站内 (intra) = 点线.
    //   不再画 `出/入/↔` 文字标签 (drawEdgeLabels 已删).
    // R158.X.99-silent.topology — silent (probeState='none') 用 [2,6] 细密点线
    //   **覆盖** direction dash (silent 是更严重的信号, 不该跟普通入站虚线混),
    //   宽度也加粗一档 (width*1.25) 让它在密集图里跳出来。
    if (e.isSilent) {
      ctx.setLineDash([2, 6]);
      ctx.lineWidth = (isAdjacent ? width * 1.5 : width) * 1.25;
    } else if (e.direction === 'in') ctx.setLineDash([8, 5]);
    else if (e.direction === 'intra') ctx.setLineDash([3, 4]);
    else ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(a.cx, a.cy);
    ctx.quadraticCurveTo(ctrlX, ctrlY, b.cx, b.cy);
    ctx.stroke();
    const tipX = b.cx, tipY = b.cy;
    const tanAngle = Math.atan2(tipY - ctrlY, tipX - ctrlX);
    drawArrowHead(tipX, tipY, tanAngle, strokeColor);
    ctx.restore();
  }
}

function drawArrowHead(x, y, angle, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.translate(x, y);
  ctx.rotate(angle);
  // R158.45.5 — 箭头加大 (7→10) + 实心尖锐三角. 专业网络图箭头明显才能看方向.
  const len = 10, w = 5;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-len, -w);
  ctx.lineTo(-len * 0.7, 0);
  ctx.lineTo(-len, w);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// R158.45.5 — operator "将文字的 出入 去掉, 转而用颜色区分": 函数体已删除.
//   方向区分改在 drawEdges 内的 lineDash + 颜色:
//     出战 (out)  = 实线 + 亮绿/亮红
//     入战 (in)   = 虚线 [8,5] + 暗绿/暗红
//     站内 (intra)= 点线 [3,4] + muted
//   保留 drawEdgeLabels 空壳 (call site 在 draw() 内, 防 undefined).
function drawEdgeLabels() { /* R158.45.5 noop */ }


function drawBridgeheadCallouts() {
  const p = palette.value;
  for (const b of layoutState.value.bridgeheadBoxes) {
    ctx.save();
    // Body.
    ctx.fillStyle = `color-mix(in srgb, ${p['hub-gold']} 12%, ${p.panel} 88%)`;
    ctx.strokeStyle = p['gold-border'];
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(b.x, b.y, b.w, b.h, 4);
    ctx.fill();
    ctx.stroke();
    // Pointer triangle (left side, points toward the site).
    ctx.beginPath();
    ctx.moveTo(b.x, b.y + b.h / 2 - 6);
    ctx.lineTo(b.x - 8, b.y + b.h / 2);
    ctx.lineTo(b.x, b.y + b.h / 2 + 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Text — header + DC name.
    ctx.fillStyle = p['gold-label'];
    ctx.font = '600 10px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('DC↔Site Link Bridgehead', b.x + 8, b.y + 12);
    ctx.fillStyle = p.text;
    ctx.font = '500 11px ui-monospace, monospace';
    ctx.fillText(b.dcName, b.x + 8, b.y + 27);
    ctx.restore();
  }
}

// ── Hit-test (world coords) ──────────────────────────────────────────
function hitTestAt(wx, wy) {
  const s = layoutState.value;
  // 1. Bridgehead callout (priority — bigger than DC).
  for (const b of s.bridgeheadBoxes) {
    if (wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h) {
      // R158.45.1 — 返回 dcNode + site (拖拽要 mutate ellipse/dcs)
      const dcNode = s.dcNodes.find(n => n._original === b.dcOriginal);
      return {
        kind: 'node',
        node: b.dcOriginal,
        type: 'bridgehead',
        dcNode,
        site: dcNode ? dcNode.siteRef : null
      };
    }
  }
  // 2. DC server icon (rect).
  for (const d of s.dcNodes) {
    if (wx >= d.cx - DC_W / 2 && wx <= d.cx + DC_W / 2 &&
        wy >= d.cy - DC_H / 2 && wy <= d.cy + DC_H / 2) {
      return {
        kind: 'node',
        node: d._original,
        type: 'dc',
        dcNode: d,
        site: d.siteRef
      };
    }
  }
  // 3. Site rect (R158.45.4 — operator "将圆形框改成方形框": AABB 命中).
  for (const site of s.sites) {
    const hw = site.ellipse.rx;          // half-width (rx retained as field)
    const hh = site.ellipse.ry;          // half-height
    if (wx >= site.ellipse.cx - hw && wx <= site.ellipse.cx + hw &&
        wy >= site.ellipse.cy - hh && wy <= site.ellipse.cy + hh) {
      return { kind: 'node', node: site._original, type: 'site', siteObj: site };
    }
  }
  // 4. Edge — closest segment within world tol = HIT_PAD_PX / scale.
  const tol = HIT_PAD_PX / transform.value.scale;
  let best = null, bestDist = tol;
  for (const e of s.edges) {
    const d = distToSegment(wx, wy, e.source.cx, e.source.cy, e.target.cx, e.target.cy);
    if (d < bestDist) { bestDist = d; best = e; }
  }
  if (best) return { kind: 'edge', edge: best };
  return null;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx, y = ay + t * dy;
  return Math.hypot(px - x, py - y);
}

// ── Mouse interactions ───────────────────────────────────────────────
function screenToWorld(sx, sy) {
  const t = transform.value;
  return { x: (sx - t.tx) / t.scale, y: (sy - t.ty) / t.scale };
}

function onWheel(ev) {
  const rect = canvasEl.value.getBoundingClientRect();
  const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
  const w = screenToWorld(sx, sy);
  const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
  const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, transform.value.scale * factor));
  transform.value = {
    tx: sx - w.x * next,
    ty: sy - w.y * next,
    scale: next
  };
  requestRender();
}

let panning = false, panStart = null, panPointerId = null;
// R158.45.1 — drag state (按住 Ctrl/Meta 才拖拽, 默认点击开 modal)
let dragging = false, dragKind = null, dragTarget = null, dragStart = null, dragPointerId = null;
// dragKind: 'dc' | 'site' | 'bridgehead'
// dragTarget: dc node / site obj (含 dcs + ellipse)
// dragStart: { sx, sy, dc.cx, dc.cy, site.ellipse.cx, site.ellipse.cy, bridgeheadBox.x/y? }
function onPointerDown(ev) {
  if (ev.button !== 0) return;
  const rect = canvasEl.value.getBoundingClientRect();
  const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
  const w = screenToWorld(sx, sy);
  const hit = hitTestAt(w.x, w.y);
  // R158.45.1 — 按住 Ctrl/Meta 才进入拖拽, 默认点击 = 开 modal
  if (hit && (ev.ctrlKey || ev.metaKey)) {
    if (hit.kind === 'node') {
      if (hit.type === 'site') {
        // 站点拖拽: 站点 + 该站所有 DC + 该站 bridgehead callout 一起动
        const site = hit.siteObj;
        dragging = true;
        dragKind = 'site';
        dragTarget = site;
        dragStart = {
          sx, sy,
          ellipseCx: site.ellipse.cx,
          ellipseCy: site.ellipse.cy
        };
      } else if (hit.type === 'dc' || hit.type === 'bridgehead') {
        // bridgehead callout 也走 dc 拖拽路径 (DC 在哪 callout 跟着)
        dragging = true;
        dragKind = 'dc';
        dragTarget = { dc: hit.dcNode, site: hit.site };
        dragStart = {
          sx, sy,
          dcCx: hit.dcNode.cx,
          dcCy: hit.dcNode.cy,
          ellipseCx: hit.site.ellipse.cx,
          ellipseCy: hit.site.ellipse.cy
        };
      }
      dragPointerId = ev.pointerId;
      canvasEl.value.setPointerCapture(ev.pointerId);
      ev.preventDefault();
      return;
    }
  }
  if (hit) {
    if (hit.kind === 'node') openNode(hit.node);
    else if (hit.kind === 'edge') openEdge(hit.edge);
    return;
  }
  panning = true;
  panStart = { sx, sy, tx: transform.value.tx, ty: transform.value.ty };
  panPointerId = ev.pointerId;
  canvasEl.value.setPointerCapture(ev.pointerId);
}
function onPointerMove(ev) {
  // R158.45.5 — hover 检测 (邻接高亮)
  if (!panning && !dragging) {
    const rect = canvasEl.value?.getBoundingClientRect();
    if (rect) {
      const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
      const w = screenToWorld(sx, sy);
      const hit = hitTestAt(w.x, w.y);
      const newHover = hit && hit.kind === 'node' ? {
        name: hit.node.name,
        type: hit.type,
        site: hit.siteObj || null,
        dcNode: hit.dcNode || null
      } : null;
      // 比较是否变化 (避免每帧 requestRender)
      const old = hoveredNode.value;
      const changed = (old?.name !== newHover?.name) || (old?.type !== newHover?.type);
      if (changed) {
        hoveredNode.value = newHover;
        canvasEl.value.style.cursor = newHover ? 'pointer' : 'default';
        requestRender();
      }
    }
  }
  if (panning) {
    const rect = canvasEl.value.getBoundingClientRect();
    const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
    transform.value = {
      ...transform.value,
      tx: panStart.tx + (sx - panStart.sx),
      ty: panStart.ty + (sy - panStart.sy)
    };
    requestRender();
    return;
  }
  if (!dragging) return;
  const rect = canvasEl.value.getBoundingClientRect();
  const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
  // screen Δ → world Δ (除 scale)
  const dxScreen = sx - dragStart.sx;
  const dyScreen = sy - dragStart.sy;
  const dx = dxScreen / transform.value.scale;
  const dy = dyScreen / transform.value.scale;

  if (dragKind === 'site') {
    const site = dragTarget;
    // 站点自身 + DCs 一起平移
    site.ellipse.cx += dx;
    site.ellipse.cy += dy;
    for (const dc of site.dcs) {
      dc.cx += dx;
      dc.cy += dy;
    }
    // 同步 layoutState.dcNodes[] 里所有属于本站的 DC
    for (const n of layoutState.value.dcNodes) {
      if (n.siteRef === site) {
        n.cx += dx;
        n.cy += dy;
      }
    }
    // bridgehead callout 跟着站点走 — 在 layoutState.bridgeheadBoxes 里找到属于本站的 box, 同步 Δ
    for (const b of layoutState.value.bridgeheadBoxes) {
      if (b.siteName === site.name) {
        b.x += dx;
        b.y += dy;
      }
    }
  } else if (dragKind === 'dc') {
    const { dc, site } = dragTarget;
    // DC 移动范围: clamp 在 site ellipse 内 (椭圆方程 dx²/rx² + dy²/ry² ≤ 1)
    const newCx = dragStart.dcCx + dx;
    const newCy = dragStart.dcCy + dy;
    // R158.45.4 — operator "将圆形框改成方形框": rect AABB clamp (shrink 让 DC icon 不超边).
    const rxIn = site.ellipse.rx - 14;
    const ryIn = site.ellipse.ry - 14;
    let clampedCx = Math.max(site.ellipse.cx - rxIn, Math.min(site.ellipse.cx + rxIn, newCx));
    let clampedCy = Math.max(site.ellipse.cy - ryIn, Math.min(site.ellipse.cy + ryIn, newCy));
    const realDx = clampedCx - dc.cx;
    const realDy = clampedCy - dc.cy;
    dc.cx = clampedCx;
    dc.cy = clampedCy;
    // sync layoutState dcNodes
    const nodeRef = layoutState.value.dcNodes.find(n => n._original === dc._original);
    if (nodeRef) {
      nodeRef.cx = clampedCx;
      nodeRef.cy = clampedCy;
    }
    // 如果该 DC 是 bridgehead, callout box 跟着走
    for (const b of layoutState.value.bridgeheadBoxes) {
      if (b.dcOriginal === dc._original) {
        b.x += realDx;
        b.y += realDy;
      }
    }
  }
  requestRender();
}
function onPointerUp(ev) {
  if (panning) {
    panning = false;
    if (panPointerId != null && canvasEl.value) {
      try { canvasEl.value.releasePointerCapture(panPointerId); } catch (_) { /* ignore */ }
    }
    panPointerId = null;
    panStart = null;
  }
  if (dragging) {
    dragging = false;
    dragKind = null;
    dragTarget = null;
    dragStart = null;
    if (dragPointerId != null && canvasEl.value) {
      try { canvasEl.value.releasePointerCapture(dragPointerId); } catch (_) { /* ignore */ }
    }
    dragPointerId = null;
  }
}
function onDblClick() { resetView(); }

function resetView() {
  let { bbox } = layoutState.value;
  hoveredNode.value = null;
  // R158.45.4 — 首屏 cssWidth/cssHeight 可能还没拿到 (race), 用 window.innerWidth 兜底.
  const cw = cssWidth || window.innerWidth || 1200;
  const ch = cssHeight || window.innerHeight || 800;
  if (!bbox) {
    // 没布局数据 → 摆 (0,0) 居中
    transform.value = { scale: 1, tx: cw / 2, ty: ch / 2 };
    requestRender();
    return;
  }
  const contentW = Math.max(1, bbox.maxX - bbox.minX);
  const contentH = Math.max(1, bbox.maxY - bbox.minY);
  const sx = (cw - 60) / contentW;
  const sy = (ch - 60) / contentH;
  const fitScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min(sx, sy)));
  // R158.45.4 — operator "中心点定位于canvas的中心点": tx/ty 直接让 bbox 中心对齐 canvas 中心.
  const bboxCx = (bbox.minX + bbox.maxX) / 2;
  const bboxCy = (bbox.minY + bbox.maxY) / 2;
  transform.value = {
    scale: fitScale,
    tx: cw / 2 - bboxCx * fitScale,
    ty: ch / 2 - bboxCy * fitScale
  };
  requestRender();
}

// ── DPR + resize ─────────────────────────────────────────────────────
function resizeCanvas() {
  if (!canvasEl.value) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvasEl.value.getBoundingClientRect();
  cssWidth = rect.width;
  cssHeight = rect.height;
  canvasEl.value.width = Math.floor(cssWidth * dpr);
  canvasEl.value.height = Math.floor(cssHeight * dpr);
  ctx = canvasEl.value.getContext('2d');
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  requestRender();
}
let resizeObserver = null;
function installResize() {
  resizeObserver = new ResizeObserver(() => resizeCanvas());
  if (canvasEl.value) resizeObserver.observe(canvasEl.value);
  window.addEventListener('resize', resizeCanvas);
}

// ── Lifecycle ────────────────────────────────────────────────────────
onMounted(async () => {
  await nextTick();
  buildLayout();
  // R158.45.4 — operator "刷新后我们需要将图的中心点定位于canvas的中心点, 不然总跑到左上角":
  // 先 resizeCanvas 拿 cssWidth/cssHeight, 再 resetView 用真 viewport 居中.
  installResize();
  resizeCanvas();
  // Default view: fit-to-content on first paint.
  resetView();
  requestRender();
});

onUnmounted(() => {
  if (resizeObserver) resizeObserver.disconnect();
  window.removeEventListener('resize', resizeCanvas);
});

// Re-layout when data changes; re-render on palette / theme / transform.
watch(() => props.data, () => {
  buildLayout();
  requestRender();
}, { deep: true });
watch(palette, () => requestRender());
watch(() => transform.value, () => requestRender(), { deep: true });
watch(theme, () => requestRender());
</script>

<style scoped>
.topology-single {
  padding: 16px;
}
/* R158.45.6 — 右侧说明栏 (legend 移到右侧, 主图纯拓扑) */
.topology-aside {
  position: absolute;
  top: 60px; right: 16px;
  width: 240px;
  padding: 12px 14px;
  background: var(--sidebar-bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  z-index: 10;
}
.topology-legend-list {
  list-style: none; padding: 0; margin: 0;
  display: flex; flex-direction: column; gap: 6px;
  font-size: 11px; color: var(--text);
}
.topology-legend-list li {
  display: flex; align-items: center; gap: 8px;
}
.legend-shape {
  display: inline-block;
  flex-shrink: 0;
}
.legend-shape-rect-hub {
  width: 18px; height: 12px;
  background: color-mix(in srgb, var(--hub-gold) 18%, var(--panel) 82%);
  border: 1.5px solid var(--hub-gold);
  border-radius: 2px;
}
.legend-shape-rect-bridge {
  width: 14px; height: 10px;
  background: color-mix(in srgb, var(--hub-gold) 35%, var(--panel-alt) 65%);
  border: 1px solid var(--hub-gold);
  border-radius: 1px;
}
.legend-shape-circle {
  width: 10px; height: 10px;
  background: var(--panel-alt);
  border: 1.5px solid var(--border);
  border-radius: 50%;
}
.legend-line {
  display: inline-block;
  flex-shrink: 0;
  width: 28px; height: 0;
}
.legend-line-solid {
  border-top: 1.6px solid var(--green);
}
.legend-line-solid.legend-line-err { border-top-color: var(--red); }
.legend-line-dashed {
  border-top: 1.6px dashed var(--green);
}
.legend-line-dotted {
  border-top: 1.6px dotted var(--muted);
}
/* R158.X.99-silent.topology — 图例 silent 线 (跟 canvas [2,6] dash 视觉对应,
   CSS dotted 是 round dot 而 canvas 是方 dash, 这里用 dashed + 加粗逼近 —
   语义区分靠 dash 密度, 不追求像素级一致)。 */
.legend-line-silent {
  border-top: 2.4px dashed var(--red);
}
/* R158.X.99-silent.topology — edge modal 顶部 silent 提示条。复用 --red
   (跟 matrix silent / canvas silent 边同色), 0 引新色板 (lesson 150)。 */
.edge-silent-banner {
  margin: 0 0 12px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text);
  background: color-mix(in srgb, var(--red) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--red) 45%, transparent);
  border-left-width: 3px;
  border-radius: 3px;
}
.legend-text { color: var(--muted); font-size: 10px; padding-left: 0; }
.color-legend {
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  padding: 8px 16px;
  font-size: 12px; color: var(--text);
  background: var(--sidebar-bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  margin: 0 16px 12px;
}
.color-legend-item { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); }
.color-swatch {
  width: 16px; height: 8px; border-radius: 2px;
  display: inline-block; vertical-align: middle;
}
.color-swatch.swatch-out-ok   { background: var(--green); }
.color-swatch.swatch-out-err  { background: var(--red); }
.color-swatch.swatch-in-ok    {
  background: transparent;
  border-top: 2px dashed var(--in-ok);
}
.color-swatch.swatch-in-err   {
  background: transparent;
  border-top: 2px dashed var(--in-err);
}
.color-swatch.swatch-bridge   {
  background: color-mix(in srgb, var(--hub-gold) 25%, var(--panel) 75%);
  border: 1px solid var(--gold-border);
}
.color-legend-divider { width: 1px; height: 14px; background: var(--border); }
.color-legend-spacer { flex: 1 1 auto; }
.topology-zoom-hint { color: var(--muted); font-size: 11px; }
.reset-btn {
  padding: 4px 12px;
  background: var(--sidebar-bg);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
}
.reset-btn:hover { background: var(--shimmer-mid); }

.structure {
  background: var(--sidebar-bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
}
.structure-header {
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 4px;
}
.structure-tag {
  display: inline-block; width: fit-content;
  padding: 2px 8px; font-size: 11px;
  background: color-mix(in srgb, var(--hub-gold) 18%, transparent);
  color: var(--hub-gold); border-radius: 2px;
}
.structure-header h3 { margin: 0; font-size: 16px; color: var(--text); }
.structure-sub { color: var(--muted); font-size: 12px; }
.canvas-host {
  width: 100%;
  height: 78vh;
  min-height: 540px;
  background: var(--bg);
  cursor: grab;
  touch-action: none;
  display: block;
}
.canvas-host:active { cursor: grabbing; }

.modal-bg {
  position: fixed; inset: 0;
  background: color-mix(in srgb, #000 50%, transparent);
  z-index: 100;
  display: flex; align-items: center; justify-content: center;
}
.modal {
  background: var(--sidebar-bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  min-width: 540px;
  max-width: 760px;
  max-height: 80vh;
  display: flex; flex-direction: column;
  color: var(--text);
}
.modal header {
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}
.modal header h3 { margin: 0; font-size: 16px; color: var(--text); }
.modal header .meta { margin: 6px 0 0; color: var(--muted); font-size: 12px; }
.modal .form-body {
  padding: 14px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px;
}
.modal footer {
  display: flex; gap: 8px; justify-content: flex-end;
  padding: 12px 18px; border-top: 1px solid var(--border);
}
.modal footer button {
  padding: 6px 14px; border: 1px solid var(--border);
  background: var(--sidebar-bg); color: var(--text); border-radius: 3px;
  cursor: pointer; font-size: 13px;
}
.modal footer button:hover { background: var(--shimmer-mid); }
.detail-section { display: flex; flex-direction: column; gap: 6px; }
.detail-section .label { color: var(--muted); font-size: 12px; }
.empty { color: var(--muted); font-size: 12px; }

.dc-list, .partner-list {
  list-style: none; padding: 0; margin: 0;
  display: flex; flex-direction: column; gap: 4px;
}
.dc-row, .partner-row {
  display: grid; align-items: center;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg);
  font-size: 12px;
}
.dc-row {
  grid-template-columns: 1fr auto auto;
  gap: 12px;
}
.partner-row {
  grid-template-columns: 64px 1fr 90px;
  gap: 10px;
}
.dc-name, .partner-peer { color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dc-partner-count, .partner-peer-site { color: var(--muted); }
/* R158.45.4 — peerDc chip 列表 (跨站 partner 内的 DC 列表) */
.partner-peer-dcs { display: inline-flex; flex-wrap: wrap; gap: 2px 6px; margin-left: 8px; color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
.peer-dc-chip { padding: 1px 4px; background: color-mix(in srgb, var(--border) 30%, transparent); border-radius: 2px; }
.peer-dc-dir { color: var(--muted); margin-left: 2px; }
.dc-roles { display: inline-flex; gap: 4px; flex-wrap: wrap; }
.role-badge {
  font-size: 10px; padding: 1px 6px; border-radius: 2px;
  border: 1px solid var(--border); color: var(--muted);
}
.role-bridge { background: color-mix(in srgb, var(--hub-gold) 25%, transparent); color: var(--hub-gold); border-color: var(--gold-border); }
.role-pdc    { background: color-mix(in srgb, var(--accent) 25%, transparent); color: var(--accent); }
.role-gc     { background: color-mix(in srgb, var(--green) 25%, transparent); color: var(--green); }
.role-rid, .role-infra, .role-naming { background: color-mix(in srgb, var(--muted) 18%, transparent); }
.role-member { background: color-mix(in srgb, var(--border) 25%, transparent); }

.dir-tag {
  font-size: 10px; padding: 1px 6px; border-radius: 2px;
  border: 1px solid var(--border);
}
.dir-intra { background: color-mix(in srgb, var(--muted) 18%, transparent); color: var(--muted); }
.dir-out   { background: color-mix(in srgb, var(--green) 18%, transparent); color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, var(--border)); }
.dir-in    { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
/* R158.45.3 — 出战+入站 同 peerDc 合并后的视觉 (蓝紫混色, 中性) */
.dir-both  { background: color-mix(in srgb, var(--green) 12%, var(--accent) 12%, transparent); color: var(--text); border-color: color-mix(in srgb, var(--green) 30%, var(--accent) 30%, var(--border)); }

.partner-status { font-size: 11px; padding: 1px 6px; border-radius: 2px; text-align: center; }
.partner-status.status-ok  { background: color-mix(in srgb, var(--green) 18%, transparent); color: var(--green); }
.partner-status.status-err { background: color-mix(in srgb, var(--red) 18%, transparent); color: var(--red); }

.summary-line {
  margin: 0; padding: 6px 10px; background: var(--sidebar-bg);
  border: 1px solid var(--border); border-radius: 3px;
  color: var(--text); font-size: 12px;
}
.attempts-table {
  width: 100%; border-collapse: collapse; font-size: 12px;
}
.attempts-table th, .attempts-table td {
  padding: 6px 10px; text-align: left;
  border-bottom: 1px solid var(--border);
}
.attempts-table th {
  color: var(--muted); font-weight: 500; font-size: 11px;
  letter-spacing: 0.04em; text-transform: uppercase;
}
.attempts-table td { color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.attempts-table td .glyph { margin-right: 6px; font-size: 10px; }
.attempts-table td.error-cell {
  color: var(--severity-critical-text); max-width: 280px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; font-family: inherit;
}
.attempt-row-ok    td .glyph { color: var(--green); }
.attempt-row-err   td .glyph { color: var(--red); }
.attempt-row-err   td:first-child { color: var(--severity-critical-text); }
.loading { color: var(--muted); font-size: 12px; text-align: center; padding: 18px 0; }
.error-banner {
  background: color-mix(in srgb, var(--red) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--red) 40%, transparent);
  color: var(--severity-critical-text); padding: 8px 12px; border-radius: 3px; font-size: 12px;
}
</style>
