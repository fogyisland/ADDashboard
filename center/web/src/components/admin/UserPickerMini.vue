<!--
  2026-08-31 R75 — UserPickerMini.vue (shared user picker).

  Autocomplete-style input that fires `user_search` via adAdminApi on
  every keystroke (debounced 250ms) and renders a dropdown of matching
  users. Emits `pick(user)` when the operator clicks an option.

  data-test contract:
    user-picker-mini           — root wrapper
    user-picker-input          — text input
    user-picker-options        — dropdown wrapper
    user-picker-option-${sam}  — each option row

  Used inside:
    UserAttributesModal — Manager picker
    GroupPropertiesModal — ManagedBy picker
-->
<template>
  <div :data-test="'user-picker-mini'" class="picker">
    <input
      :data-test="'user-picker-input'"
      type="text"
      v-model="query"
      :placeholder="placeholder || '输入 sAMAccountName 或显示名称…'"
      class="picker-input"
      @focus="open = true"
    />
    <div
      v-if="open && (options.length || searching)"
      :data-test="'user-picker-options'"
      class="picker-options"
    >
      <div v-if="searching" class="picker-empty">搜索中…</div>
      <div v-else-if="!options.length" class="picker-empty">无匹配用户</div>
      <button
        v-for="o in options"
        :key="o.sam"
        type="button"
        :data-test="`user-picker-option-${o.sam}`"
        class="picker-option"
        @click="choose(o)"
      >
        <code class="sam">{{ o.sam }}</code>
        <span class="dn">{{ o.displayName || '—' }}</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue';
import { adAdminApi } from '../../api/ad-admin.js';

const props = defineProps({
  targetDc: { type: String, required: true },
  placeholder: { type: String, default: '' },
  initialSam: { type: String, default: '' }
});
const emit = defineEmits(['pick']);

const query = ref(props.initialSam || '');
const options = ref([]);
const open = ref(false);
const searching = ref(false);

let debounceTimer = null;
let currentRequestId = 0;

watch(query, (val) => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runSearch(val), 250);
});

async function runSearch(q) {
  const trimmed = String(q || '').trim();
  if (!trimmed || !props.targetDc) {
    options.value = [];
    return;
  }
  const reqId = ++currentRequestId;
  searching.value = true;
  try {
    const resp = await adAdminApi.queueCommand({
      targetDc: props.targetDc,
      commandType: 'user_search',
      params: { filter: trimmed, limit: 20 }
    });
    const id = resp.data?.id;
    if (!id || reqId !== currentRequestId) return;
    // Wait for terminal state via direct GET (not full polling composable
    // — picker needs minimal overhead). Polls every 800ms, max 10s.
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      await new Promise(r => setTimeout(r, 800));
      if (reqId !== currentRequestId) return;
      const r2 = await adAdminApi.getCommand(id);
      const st = r2.data?.status;
      if (st === 'success') {
        const users = r2.data?.resultJson?.users || [];
        options.value = users;
        return;
      }
      if (st === 'failed' || st === 'timeout') {
        options.value = [];
        return;
      }
    }
    options.value = [];
  } catch {
    if (reqId === currentRequestId) options.value = [];
  } finally {
    if (reqId === currentRequestId) searching.value = false;
  }
}

function choose(u) {
  query.value = u.sam;
  options.value = [];
  open.value = false;
  emit('pick', u);
}
</script>

<style scoped>
.picker {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.picker-input {
  background: var(--input-bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 5px 8px;
  font-size: 13px;
}
.picker-input:focus { outline: 2px solid var(--accent); border-color: var(--accent); }

.picker-options {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 3px;
  margin-top: 2px;
  max-height: 240px;
  overflow-y: auto;
  z-index: 10;
  box-shadow: 0 4px 12px rgba(0,0,0,0.25);
}
.picker-empty {
  color: var(--muted);
  padding: 8px 10px;
  font-size: 12px;
}
.picker-option {
  display: flex;
  gap: 8px;
  align-items: center;
  width: 100%;
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--border);
  padding: 6px 10px;
  text-align: left;
  cursor: pointer;
  color: var(--text);
  font-size: 12px;
}
.picker-option:hover { background: var(--row-hover); }
.picker-option:last-child { border-bottom: 0; }
.picker-option .sam {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--accent);
}
.picker-option .dn { color: var(--muted); }
</style>