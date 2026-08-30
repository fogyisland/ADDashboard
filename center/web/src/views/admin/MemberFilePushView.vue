<!--
  2026-08-30 R65 followup — member-server target picker. Real upload /
  push / monitor surface lives in FilePushView.vue; this view is a
  thin wrapper that pins targetType='server'.
-->
<template>
  <FilePushView target-type="server" />
</template>

<script setup>
import FilePushView from './FilePushView.vue';
</script>