// Light/dark theme toggle. The single source of truth is the `data-theme`
// attribute on <html>; all colors flow from CSS variables defined in
// style.css (:root for dark, :root[data-theme="light"] for light). This
// composable just owns the read/write of that attribute plus localStorage
// persistence so the choice survives reload.
//
// Default is dark — preserves the historical look for existing operators.
// First-visit OS preference is intentionally NOT consulted: this is a
// sysadmin tool, the operator chose the terminal, dark is the safer bet.

import { ref } from 'vue';

const STORAGE_KEY = 'ad-dashboard-theme';
const VALID = new Set(['dark', 'light']);

function readStored() {
  if (typeof localStorage === 'undefined') return 'dark';
  const v = localStorage.getItem(STORAGE_KEY);
  return VALID.has(v) ? v : 'dark';
}

function writeStored(theme) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, theme);
}

function applyTheme(theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
}

// Singleton ref shared by every consumer in the same tab. Both topbars
// (AppLayout + AdminLayout) and any future header pick up the same state
// AND the same reactivity — toggling in one flips the icon in the other.
const themeRef = ref(readStored());
applyTheme(themeRef.value);

export function useTheme() {
  function toggleTheme() {
    themeRef.value = themeRef.value === 'dark' ? 'light' : 'dark';
    writeStored(themeRef.value);
    applyTheme(themeRef.value);
  }
  return {
    theme: themeRef,
    toggleTheme
  };
}
