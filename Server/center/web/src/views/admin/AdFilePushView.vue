<!--
  2026-08-30 R65 followup — AD-DC target picker. Real upload / push
  / monitor surface lives in FilePushView.vue; this view is a thin
  wrapper that pins targetType='dc'.
-->
<template>
  <FilePushView target-type="dc" />
</template>

<script setup>
import FilePushView from './FilePushView.vue';
</script>