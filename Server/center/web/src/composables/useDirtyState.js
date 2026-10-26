import { ref, computed, getCurrentInstance, onMounted, onBeforeUnmount } from 'vue';

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

// Canonical stringify: sorts object keys recursively so that comparison is
// key-order independent (see "key order independent" test case).
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function isEqual(a, b) {
  return canonical(a) === canonical(b);
}

export function useDirtyState(initial) {
  const current = ref(deepClone(initial));
  const snapshot = ref(deepClone(initial));

  // computed (not a plain ref) so that any mutation of `current` — whether a
  // whole-object assignment or a nested field edit — re-derives `dirty`.
  const dirty = computed(() => !isEqual(current.value, snapshot.value));

  function markClean(value) { snapshot.value = deepClone(value); }
  function reset() { current.value = deepClone(snapshot.value); }

  // beforeunload hook only when called inside a component setup()
  const inst = getCurrentInstance();
  if (inst && typeof window !== 'undefined') {
    const handler = (e) => { if (dirty.value) { e.preventDefault(); e.returnValue = ''; } };
    onMounted(() => window.addEventListener('beforeunload', handler));
    onBeforeUnmount(() => window.removeEventListener('beforeunload', handler));
  }

  // Retained for return-shape compatibility; `dirty` is now self-recomputing.
  function recompute() {}

  return { current, snapshot, dirty, markClean, reset, _recompute: recompute };
}
