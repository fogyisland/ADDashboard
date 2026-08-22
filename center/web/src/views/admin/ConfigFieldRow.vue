<template>
  <div class="row">
    <input
      :type="type"
      :value="value"
      :class="{ 'has-error': !!error }"
      :disabled="disabled"
      @input="$emit('update:value', $event.target.value)"
    />
    <small v-if="error" class="err">{{ error }}</small>
    <small v-else-if="description" class="desc">{{ description }}</small>
  </div>
</template>

<script setup>
defineProps({
  value: { type: [String, Number], default: '' },
  error: { type: String, default: '' },
  description: { type: String, default: '' },
  type: { type: String, default: 'text' },
  disabled: { type: Boolean, default: false }
});
defineEmits(['update:value']);
</script>

<style scoped>
.row { display: grid; grid-template-columns: 220px 1fr auto; gap: 8px; align-items: center; padding: 4px 0; }
code { color: var(--muted); font-size: 12px; }
input { padding: 6px 8px; border: 1px solid #1e293b; background: var(--panel); color: var(--text); border-radius: 3px; }
input.has-error { border-color: #ef4444; }
.err { color: #ef4444; font-size: 12px; }
.desc { color: var(--muted); font-size: 12px; }
</style>
