<!--
  R155.5 — 站点入站矩阵 wrapper. REVERSE BINDING (mirror R155.3
  partner-port-health swap pattern).

  Operator 2026-09-30 bug report: "/matrix/inbound 和 /matrix/outbound
  现在数据完全一模一样". The R153 wrappers passed `direction='inbound'`
  / `direction='outbound'` directly through to the base view + backend,
  but the backend's direction swap (dashboard.js:953-954) maps both
  directions to the SAME set of (localDc, peerDc) rows because every
  ad_replication_status row has BOTH a (source_dc, dest_dc) side AND
  the swap of (dest_dc, source_dc) is a SEPARATE row — the matrix
  rendering didn't change direction-of-viewing, it stayed static.

  Fix (R155.5 / 2026-09-30): mirror the R155.3 partner-port-health
  swap pattern by REVERSE-BINDING the wrapper file names relative to
  UI label:
    SiteMatrixInboundView (UI "入站" = 我从这些源拉 = dest-anchor) →
      passes `direction='outbound'` to base view (so backend computes
      localDc=peerDcRaw, peerDc=destDcRaw — i.e. operator sees "what
      I send out from my DC", rendered against the 入站 matrix page).
    SiteMatrixOutboundView (UI "出战" = 源从我拉 = source-anchor) →
      passes `direction='inbound'`.

  This makes /matrix/inbound and /matrix/outbound display genuinely
  different data: each page now anchors on a different side of the
  replication edge, exactly mirroring the R155.3 partner-port-health
  swap that fixed the same symptom there.
-->
<template>
  <SiteMatrixView direction="outbound" />
</template>

<script setup>
import SiteMatrixView from './SiteMatrixView.vue';
</script>