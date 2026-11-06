<template>
  <div class="row">
    <!--
      R158.16 (2026-10-01) -- toggle type. Renders as a switch UI rather than
      a dropdown. Emits '1' (on) / '0' (off) to match the system_config 0/1
      convention read by system-alert-engine / email.js. `onLabel` / `offLabel`
      customize the inline text (default "开" / "关"); kept short so the
      track doesn't stretch the row width. R158.68 alert-engine 改名沿用.
    -->
    <label
      v-if="type === 'toggle'"
      class="toggle"
      :class="{ 'toggle-on': String(value) === '1', 'has-error': !!error }"
      :aria-disabled="disabled"
    >
      <input
        type="checkbox"
        class="toggle-input"
        :checked="String(value) === '1'"
        :disabled="disabled"
        @change="$emit('update:value', $event.target.checked ? '1' : '0')"
      />
      <span class="toggle-track">
        <span class="toggle-thumb" />
      </span>
      <span class="toggle-label">{{ String(value) === '1' ? onLabel : offLabel }}</span>
    </label>
    <select
      v-else-if="type === 'select'"
      :value="value"
      :class="{ 'has-error': !!error }"
      :disabled="disabled"
      @change="$emit('update:value', $event.target.value)"
    >
      <option v-for="opt in options" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
    </select>
    <input
      v-else-if="type === 'text' || type === 'number' || type === 'password' || type === 'email'"
      :type="type"
      :value="value"
      :class="{ 'has-error': !!error }"
      :disabled="disabled"
      @input="$emit('update:value', $event.target.value)"
    />
    <!--
      R158.100.C (2026-10-14) — textarea 分支, 给 AD 操作通知模板
        (ad_notify_subject_template / ad_notify_body_template) 用. rows=5
        适配 1-3 行 subject 跟 5-10 行 body. 跟 input 1:1 平行 (同样的
        :value / @input emit). 不影响既有 text / number / select / toggle
        分支.
    -->
    <textarea
      v-else-if="type === 'textarea'"
      rows="5"
      :value="value"
      :class="['cfg-textarea', { 'has-error': !!error }]"
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
  // R158.16 (2026-10-01) -- select type options. Each entry { value, label }.
  // Only used when type='select'.
  options: { type: Array, default: () => [] },
  // R158.16 (2026-10-01) -- toggle type labels. Only used when type='toggle'.
  onLabel: { type: String, default: '开' },
  offLabel: { type: String, default: '关' },
  disabled: { type: Boolean, default: false }
});
defineEmits(['update:value']);
</script>

<style scoped>
.row { display: grid; grid-template-columns: 220px 1fr auto; gap: 8px; align-items: center; padding: 4px 0; }
code { color: var(--muted); font-size: 12px; }
input, select { padding: 6px 8px; border: 1px solid var(--border); background: var(--panel); color: var(--text); border-radius: 3px; }
input.has-error, select.has-error { border-color: var(--red); }
/* R158.100.C — textarea 分支样式, 跟 input 1:1 视觉对齐, rows=5 撑高. */
.cfg-textarea {
  padding: 6px 8px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  border-radius: 3px;
  font-family: ui-monospace, 'Cascadia Mono', 'Consolas', monospace;
  font-size: 12px;
  line-height: 1.4;
  resize: vertical;
  min-height: 64px;
  width: 100%;
  max-width: 640px;
}
.cfg-textarea.has-error { border-color: var(--red); }
.err { color: var(--red); font-size: 12px; }
.desc { color: var(--muted); font-size: 12px; }

/* R158.16 (2026-10-01) -- toggle (switch) styling. Native checkbox is
   visually hidden but keeps focus/disabled semantics; the track + thumb
   are pure CSS so we don't pull in any UI lib. Color tokens reuse the
   theme palette (var(--green) on, var(--border) off) for dark/light
   parity. */
.toggle { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
.toggle[aria-disabled='true'] { cursor: not-allowed; opacity: 0.6; }
.toggle-input { position: absolute; opacity: 0; pointer-events: none; width: 0; height: 0; }
.toggle-track {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 18px;
  background: var(--border);
  border-radius: 999px;
  transition: background 0.15s ease;
}
.toggle-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  background: var(--panel);
  border-radius: 50%;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  transition: left 0.15s ease;
}
.toggle-on .toggle-track { background: var(--green); }
.toggle-on .toggle-thumb  { left: 20px; }
.toggle-label { font-size: 12px; color: var(--text); min-width: 1.5em; }
</style>
