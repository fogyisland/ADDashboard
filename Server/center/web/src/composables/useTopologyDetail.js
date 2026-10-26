// useTopologyDetail — composable that extracts R69 (node-detail modal) and
// R70 (edge-detail modal) state + computed payloads from
// web/src/components/TopologyChart.vue. Created in R158.45 (2026-10-05)
// when the component was rewritten from ECharts (1498 LOC) to a Canvas 2D
// implementation (~700 LOC). The modal contract — its `data-test` hooks
// (`node-detail-modal`, `edge-detail-modal`, `node-detail-dc-row`,
// `edge-detail-attempt`, etc.) — is preserved verbatim so downstream E2E
// tests continue to work.
//
// Consumer (the Canvas component) just inlines the same `<template>` it
// had before; the only change is that `clickedNode`, `clickedEdge`,
// `edgeHistory`, `edgeLoading`, `edgeError`, `nodeDetail`, `edgeDetail`,
// `closeModal`, `closeEdgeModal`, `linkStatusBucket`, `linkStatusLabel`,
// `anyRole`, `attemptGlyph`, `attemptLabel`, `attemptStatusClass`,
// `fmtTs` come from `useTopologyDetail(props)` instead of the
// component's own `<script setup>`.
import { ref, computed } from 'vue';
import { dashboardApi } from '../api/dashboard.js';

export function useTopologyDetail(props) {
  // ── R69 node-click modal ─────────────────────────────────────────────
  // Drives the DC list / partners list panel. Holds the ORIGINAL node
  // from props.data (not a Canvas-wrapped object) so role badges +
  // partner counts derive from source-of-truth.
  const clickedNode = ref(null);

  // ── R70 edge-click modal ─────────────────────────────────────────────
  // Independent of node-click. The Canvas hit-test passes a flat
  // edge object {source, target, sourceSite, destSite, direction,
  // statusCode}; `direction` is 'out' | 'in' | 'intra'.
  const clickedEdge = ref(null);
  const edgeHistory = ref([]);
  const edgeLoading = ref(false);
  const edgeError = ref('');

  // ── Helpers ──────────────────────────────────────────────────────────
  function dcSiteLookup() {
    const map = new Map();
    for (const n of (props.value?.data?.nodes || props.data?.nodes || [])) {
      if (n.type === 'dc') map.set(n.name, n.site || null);
    }
    return map;
  }
  function hubSet() {
    const set = new Set();
    for (const n of (props.value?.data?.nodes || props.data?.nodes || [])) {
      if (n.type === 'site' && n.isHub) set.add(n.name);
    }
    return set;
  }
  function linkStatusBucket(code) {
    if (code === 0) return 'ok';
    return 'err';                  // R158.45 binary — statusCode>=1 == 不健康 (red)
  }
  function linkStatusLabel(code) {
    if (code === 0) return '复制成功';
    return '不健康';               // R158.45 binary — warn+err collapsed
  }
  function anyRole(dc) {
    return dc.isBridgehead || dc.isPdc || dc.isGc || dc.isRid || dc.isInfra || dc.isNaming;
  }
  function attemptGlyph(code) {
    if (code === 0) return '●';
    return '✕';                    // R158.45 binary glyph
  }
  function attemptLabel(code) {
    if (code === 0) return '成功';
    return '不健康';               // R158.45 binary label
  }
  function attemptStatusClass(code) {
    if (code === 0) return 'ok';
    return 'err';                  // R158.45 binary class (template has ok/err rows)
  }
  function fmtTs(s) {
    return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '—';
  }
  function closeModal() { clickedNode.value = null; }
  function closeEdgeModal() {
    clickedEdge.value = null;
    edgeHistory.value = [];
    edgeError.value = '';
    edgeLoading.value = false;
  }

  // ── nodeDetail computed ──────────────────────────────────────────────
  // Mirrors the R138 logic from TopologyChart.vue L871-976:
  //   - Site click  → title + Hub/Spoke badge + DC list (role badges +
  //                   per-DC partner count) + flat partner list
  //                   (intra + cross-site, deduped per (peer, direction)).
  //   - DC click    → title + role badges + partner list scoped to this DC.
  const nodeDetail = computed(() => {
    if (!clickedNode.value) {
      return { title: '', meta: '', dcList: [], partners: [] };
    }
    const node = clickedNode.value;
    const dataRef = props.value?.data || props.data || { nodes: [], links: [] };
    const nodes = dataRef.nodes || [];
    const links = dataRef.links || [];
    if (node.type === 'site') {
      const dcs = nodes.filter(n => n.type === 'dc' && n.site === node.name);
      // R158.45.4 (2026-10-05) — operator "算出 3 不对, 真数 1":
      // partner 维度从 peerDc 改成 peerSite. 车墩站 ↔ 枫林站 算 1 个 partner (尽管通过 2 个 peer DC).
      // partnerMap 按 peerSite 聚合, 内部 peerDcs[] 列表保留跨站 DC 详情.
      const partnerMap = new Map();
      for (const dc of dcs) {
        for (const link of links) {
          const peerDc = link.source === dc.name ? link.target
                       : link.target === dc.name ? link.source
                       : null;
          if (!peerDc) continue;
          const peerNode = nodes.find(n => n.name === peerDc);
          const peerSite = peerNode?.site || '?';
          const isIntra = peerSite === node.name;
          const direction = link.source === dc.name ? 'out' : 'in';
          const sc = link.statusCode ?? 0;
          const key = isIntra ? `intra` : peerSite;        // intra 单独 entry, 跨站按 peerSite 聚合
          let entry = partnerMap.get(key);
          if (!entry) {
            entry = {
              peerSite,
              isIntra,
              direction: isIntra ? 'intra' : direction,
              statusCode: sc,
              status: linkStatusBucket(sc),
              statusLabel: linkStatusLabel(sc),
              peerDcs: []                                    // 跨站该 site 的 DC 列表
            };
            partnerMap.set(key, entry);
          }
          // 合并方向 (跨站)
          if (!isIntra && entry.direction !== 'both') {
            const exDir = entry.direction;
            if ((exDir === 'out' && direction === 'in') || (exDir === 'in' && direction === 'out')) {
              entry.direction = 'both';
            }
          }
          entry.statusCode = Math.max(entry.statusCode, sc);
          // peerDc 列表去重保留
          if (!entry.peerDcs.find(d => d.name === peerDc)) {
            const peerInDc = (link.source === dc.name && !isIntra) ? 'out' : (isIntra ? 'intra' : 'in');
            entry.peerDcs.push({ name: peerDc, direction: peerInDc, statusCode: sc });
          } else {
            // 同 peerDc 跨多本 DC / 跨多 link, 合并方向
            const d = entry.peerDcs.find(x => x.name === peerDc);
            if (!isIntra && d.direction !== 'both') {
              const exDir = d.direction;
              const linkDir = (link.source === dc.name && !isIntra) ? 'out' : 'in';
              if ((exDir === 'out' && linkDir === 'in') || (exDir === 'in' && linkDir === 'out')) {
                d.direction = 'both';
              }
            }
            d.statusCode = Math.max(d.statusCode, sc);
          }
        }
      }
      // 重算 status / statusLabel
      for (const p of partnerMap.values()) {
        p.status = linkStatusBucket(p.statusCode);
        p.statusLabel = linkStatusLabel(p.statusCode);
        for (const pd of p.peerDcs) {
          pd.status = linkStatusBucket(pd.statusCode);
          pd.statusLabel = linkStatusLabel(pd.statusCode);
        }
      }
      const dcList = dcs.map(dc => {
        // partnerCount 仍按 peerDc (DC 视角 partner 数)
        const peerSet = new Set();
        for (const l of links) {
          if (l.source === dc.name) peerSet.add(l.target);
          else if (l.target === dc.name) peerSet.add(l.source);
        }
        return {
          name: dc.name,
          isBridgehead: !!dc.isBridgehead,
          isPdc: !!dc.isPdc,
          isGc: !!dc.isGc,
          isRid: !!dc.isRid,
          isInfra: !!dc.isInfra,
          isNaming: !!dc.isNaming,
          partnerCount: peerSet.size
        };
      });
      const partners = [...partnerMap.values()].sort((a, b) => {
        // R158.45.3 — 排序 order 加 'both'
        const order = { intra: 0, out: 1, both: 1.5, in: 2 };
        const oa = order[a.direction] ?? 99;
        const ob = order[b.direction] ?? 99;
        if (oa !== ob) return oa - ob;
        return a.peerDc.localeCompare(b.peerDc);
      });
      return {
        title: node.name,
        meta: `${node.isHub ? '承载层 Hub' : '分支 Spoke'} · ${dcs.length} DC`,
        dcList,
        partners
      };
    }
    if (node.type === 'dc') {
      // R158.45.3 (2026-10-05) — operator "一进一出同一个复制伙伴被算出两个合作伙伴":
      // 按 peerDc 去重 + 合并方向 + 状态取最坏. 不再用 raw partners.push.
      const partnerMap = new Map();
      for (const link of links) {
        let peerDc = null;
        let direction = null;
        if (link.source === node.name) { peerDc = link.target; direction = 'out'; }
        else if (link.target === node.name) { peerDc = link.source; direction = 'in'; }
        if (!peerDc) continue;
        const peerNode = nodes.find(n => n.name === peerDc);
        const peerSite = peerNode?.site || '?';
        const isIntra = peerSite === node.site;
        const finalDir = isIntra ? 'intra' : direction;
        const sc = link.statusCode ?? 0;
        const existing = partnerMap.get(peerDc);
        if (existing) {
          if (existing.direction !== 'intra') {
            if ((existing.direction === 'out' && direction === 'in') ||
                (existing.direction === 'in'  && direction === 'out')) {
              existing.direction = 'both';
            }
            existing.statusCode = Math.max(existing.statusCode, sc);
          }
        } else {
          partnerMap.set(peerDc, {
            peerDc,
            peerSite,
            direction: finalDir,
            statusCode: sc,
            status: linkStatusBucket(sc),
            statusLabel: linkStatusLabel(sc)
          });
        }
      }
      for (const p of partnerMap.values()) {
        p.status = linkStatusBucket(p.statusCode);
        p.statusLabel = linkStatusLabel(p.statusCode);
      }
      const partners = [...partnerMap.values()].sort((a, b) => {
        const order = { intra: 0, out: 1, both: 1.5, in: 2 };
        const oa = order[a.direction] ?? 99;
        const ob = order[b.direction] ?? 99;
        if (oa !== ob) return oa - ob;
        return a.peerDc.localeCompare(b.peerDc);
      });
      const roleBadges = [];
      if (node.isBridgehead) roleBadges.push('桥头');
      if (node.isPdc) roleBadges.push('主控');
      else if (node.isGc) roleBadges.push('GC');
      if (node.isRid) roleBadges.push('RID');
      if (node.isInfra) roleBadges.push('基础结构');
      if (node.isNaming) roleBadges.push('命名');
      if (roleBadges.length === 0) roleBadges.push('成员');
      return {
        title: node.name,
        meta: `${node.site || '?'} · ${roleBadges.join(' / ')}`,
        dcList: [],
        partners
      };
    }
    return { title: node.name || '', meta: '', dcList: [], partners: [] };
  });

  // ── edgeDetail computed ──────────────────────────────────────────────
  // 24h summary: ok / 不健康 — R158.45 binary (warn collapsed into err).
  const edgeDetail = computed(() => {
    if (!clickedEdge.value) {
      return { title: '', meta: '', summary: '', entries: [] };
    }
    const e = clickedEdge.value;
    const dirTag = e.direction === 'intra' ? '(站内)'
                 : e.direction === 'out'   ? '(出栈)'
                 : '(入栈)';
    const dirText = e.direction === 'intra' ? '站内'
                  : e.direction === 'out'   ? '出战 (出栈)'
                  : '入站 (入栈)';
    const ok = edgeHistory.value.filter(a => a.statusCode === 0).length;
    const bad = edgeHistory.value.filter(a => a.statusCode >= 1).length;
    const summary = edgeHistory.value.length
      ? `24h 内 ${edgeHistory.value.length} 次尝试 · 成功 ${ok} · 不健康 ${bad}`
      : '';
    return {
      title: `${dirTag} ${e.source} → ${e.target}`,
      meta: `${e.sourceSite} → ${e.destSite} · ${dirText}`,
      summary,
      entries: edgeHistory.value
    };
  });

  // ── Public handlers ──────────────────────────────────────────────────
  function openNode(node) {
    clickedEdge.value = null;
    clickedNode.value = node;
  }
  function openEdge(edge) {
    clickedNode.value = null;
    clickedEdge.value = edge;
    edgeHistory.value = [];
    edgeError.value = '';
    edgeLoading.value = true;
    const logicalSource = edge.direction === 'in' ? edge.target : edge.source;
    const logicalTarget = edge.direction === 'in' ? edge.source : edge.target;
    dashboardApi.getSiteReplicationMatrixPairHistory(logicalTarget, logicalSource, 10)
      .then(r => {
        edgeHistory.value = Array.isArray(r?.data?.entries) ? r.data.entries : [];
      })
      .catch(e => {
        edgeError.value = e?.response?.data?.error || e?.message || '加载失败';
        edgeHistory.value = [];
      })
      .finally(() => { edgeLoading.value = false; });
  }

  return {
    // refs
    clickedNode, clickedEdge, edgeHistory, edgeLoading, edgeError,
    // computed payloads
    nodeDetail, edgeDetail,
    // helpers (template binds to these)
    linkStatusBucket, linkStatusLabel, anyRole,
    attemptGlyph, attemptLabel, attemptStatusClass, fmtTs,
    dcSiteLookup, hubSet,
    // actions
    openNode, openEdge, closeModal, closeEdgeModal
  };
}
