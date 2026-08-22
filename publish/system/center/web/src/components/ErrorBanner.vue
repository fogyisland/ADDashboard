<template>
  <TransitionGroup tag="div" name="error-banner" class="error-banner-stack">
    <div
      v-for="t in toasts"
      :key="t.id"
      :class="['error-banner-item', `kind-${t.kind}`]"
      :data-test="t.kind === 'error' ? 'error-banner' : `error-banner-${t.kind}`"
      role="alert"
    >
      <span class="error-banner-msg">{{ t.message }}</span>
      <button class="error-banner-close" aria-label="关闭" @click="dismiss(t.id)">×</button>
    </div>
  </TransitionGroup>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { subscribe } from '../lib/notify.js';

const toasts = ref([]);
const timers = new Map();
let unsubscribe = null;

function dismiss(id) {
  toasts.value = toasts.value.filter(t => t.id !== id);
  const handle = timers.get(id);
  if (handle) { clearTimeout(handle); timers.delete(id); }
}

onMounted(() => {
  unsubscribe = subscribe((message, kind = 'error', ttlMs = 5000) => {
    const id = Math.random().toString(36).slice(2);
    toasts.value = [...toasts.value, { id, message, kind }];
    if (ttlMs > 0) {
      timers.set(id, setTimeout(() => dismiss(id), ttlMs));
    }
  });
});

onBeforeUnmount(() => {
  if (unsubscribe) unsubscribe();
  for (const handle of timers.values()) clearTimeout(handle);
  timers.clear();
});
</script>

<style scoped>
.error-banner-stack {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
  max-width: 420px;
}
.error-banner-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: #7f1d1d;
  color: #fee2e2;
  border: 1px solid #b91c1c;
  border-radius: 4px;
  font-size: 13px;
  pointer-events: auto;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}
.error-banner-item.kind-info {
  background: #1e3a8a;
  color: #bfdbfe;
  border-color: #1e40af;
}
.error-banner-item.kind-success {
  background: #14532d;
  color: #bbf7d0;
  border-color: #166534;
}
.error-banner-msg { flex: 1; line-height: 1.4; word-break: break-word; }
.error-banner-close {
  background: transparent;
  border: none;
  color: inherit;
  font-size: 18px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}
.error-banner-enter-active,
.error-banner-leave-active { transition: opacity 0.2s, transform 0.2s; }
.error-banner-enter-from,
.error-banner-leave-to { opacity: 0; transform: translateY(-8px); }
</style>