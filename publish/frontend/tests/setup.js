// vitest setup: ensure localStorage / sessionStorage are real working
// implementations.
//
// In Node 22+, the runtime ships an experimental WebStorage stub on
// globalThis (localStorage + sessionStorage keys exist, but setItem /
// getItem / clear etc. are not functions). This stub shadows jsdom's
// working localStorage, breaking every test that touches auth tokens
// or init-status caching.
//
// Replacing the stub with a Map-backed shim makes the tests work on
// every Node version, and removes the need for --no-experimental-webstorage
// in NODE_OPTIONS (which Node 24+ refuses to accept anyway).

function createStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; }
  };
}

function needsReplacement(value) {
  return typeof value === 'undefined' || typeof value?.setItem !== 'function';
}

if (needsReplacement(globalThis.localStorage)) {
  globalThis.localStorage = createStorage();
}
if (needsReplacement(globalThis.sessionStorage)) {
  globalThis.sessionStorage = createStorage();
}
