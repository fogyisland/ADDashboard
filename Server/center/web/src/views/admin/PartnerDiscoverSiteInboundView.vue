<!--
  R158.5 (2026-09-30) — 复制伙伴发现入站 wrapper (后台 site-mode).
  Mirror R155.3 InboundView pattern: thin wrapper that passes
  direction + viewMode + chrome props to the shared base view.
  Operator directive "将前台的复制伙伴发现入站和 复制伙伴出战 放到后台,
  这里的数据就是写那两个表,然后以站点方式呈现,列出他的入站和出战partner".
-->
<template>
  <DiscoveryView
    direction="inbound"
    api-method="discoverInbound"
    view-mode="site"
    chrome="admin"
  />
</template>

<script setup>
import DiscoveryView from './DiscoveryView.vue';
</script>
