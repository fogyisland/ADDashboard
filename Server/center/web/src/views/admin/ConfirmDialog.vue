<template>
  <div class="backdrop" @click.self="$emit('cancel')">
    <div class="dialog" role="dialog" aria-modal="true">
      <h3>{{ title }}</h3>
      <p>{{ body }}</p>
      <div class="actions">
        <button class="cancel" @click="$emit('cancel')">{{ cancelLabel }}</button>
        <button :class="['confirm', { danger }]" @click="$emit('confirm')">{{ confirmLabel }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  title: { type: String, required: true },
  body: { type: String, required: true },
  confirmLabel: { type: String, default: '确认' },
  cancelLabel: { type: String, default: '取消' },
  danger: { type: Boolean, default: false }
});
defineEmits(['confirm', 'cancel']);
</script>

<style scoped>
.backdrop { position: fixed; inset: 0; background: var(--modal-backdrop); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.dialog { background: var(--panel); padding: 24px; border-radius: 6px; min-width: 360px; max-width: 540px; box-shadow: 0 8px 24px var(--modal-backdrop); }
.dialog h3 { margin: 0 0 12px; }
.dialog p { margin: 0 0 20px; color: var(--text); }
.actions { display: flex; gap: 8px; justify-content: flex-end; }
button { padding: 8px 16px; border: 1px solid var(--border); background: var(--sidebar-bg); color: var(--text); border-radius: 3px; cursor: pointer; }
button.confirm { background: var(--accent); color: var(--sidebar-bg); border-color: var(--accent); }
button.confirm.danger { background: var(--red); border-color: var(--red); color: var(--button-fg); }
</style>