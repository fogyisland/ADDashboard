<template>
  <router-view />
  <ErrorBanner />
</template>

<script setup>
// useTheme's module init reads localStorage and applies data-theme to
// <html> before this component mounts, so by the time the router-view
// renders, the theme is already set. Nothing else to do here.
import { useTheme } from './composables/useTheme.js';
import ErrorBanner from './components/ErrorBanner.vue';
useTheme();
</script>