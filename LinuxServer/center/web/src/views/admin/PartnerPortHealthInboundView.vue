<!--
  R155.3 — 复制伙伴端口健康监控 — 入站 (operator 视角).

  R155.2 之前把这个 wrapper 标 "出战",但 R155.3 label 纠正后:
  - 这个 wrapper 实际渲染 operator 视角 "入站" (label 入站 tab,
    /monitor path,operator 主用)
  - 文件名 PartnerPortHealthOutboundView 是历史 (R155.2 时 endpoint
    'outbound' (anchor source_dc) 被标 "出战" 是错的;实际是 operator
    "入站":我从源拉 = 我是 inbound consumer)
  - 当前 wrapper 传 direction='inbound' 给 base view (label
    标识符) → base view 反向映射到 endpoint direction='outbound'
    → 后端 anchor source_dc = FLO2 probe 出去的 8 source = FLO2 是
    inbound consumer

  对 FLO2:渲染 8 peer 行 (FLO2 从这些 peer 拉复制 = 我从源拉 = 入站)
-->
<template>
  <PartnerPortHealthView direction="inbound" />
</template>

<script setup>
import PartnerPortHealthView from './PartnerPortHealthView.vue';
</script>