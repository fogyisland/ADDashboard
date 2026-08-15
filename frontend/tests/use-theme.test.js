import { test, expect, vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dataset.theme = '';
  vi.resetModules();
});

afterEach(() => {
  localStorage.clear();
});

// Re-import inside each test so the module-level singleton is fresh.
// Resetting modules + re-importing keeps the singleton isolated per test
// — otherwise a prior test's `themeRef` would leak state via localStorage.

test('default theme is dark when localStorage is empty', async () => {
  const { useTheme } = await import('../src/composables/useTheme.js');
  const { theme } = useTheme();
  expect(theme.value).toBe('dark');
  expect(document.documentElement.dataset.theme).toBe('dark');
});

test('toggle flips dark → light and persists to localStorage', async () => {
  const { useTheme } = await import('../src/composables/useTheme.js');
  const { theme, toggleTheme } = useTheme();
  toggleTheme();
  expect(theme.value).toBe('light');
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(localStorage.getItem('ad-dashboard-theme')).toBe('light');
});

test('toggle flips light → dark and persists', async () => {
  localStorage.setItem('ad-dashboard-theme', 'light');
  const { useTheme } = await import('../src/composables/useTheme.js');
  const { theme, toggleTheme } = useTheme();
  expect(theme.value).toBe('light');
  toggleTheme();
  expect(theme.value).toBe('dark');
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(localStorage.getItem('ad-dashboard-theme')).toBe('dark');
});

test('reads existing localStorage value on module init (light)', async () => {
  localStorage.setItem('ad-dashboard-theme', 'light');
  const { useTheme } = await import('../src/composables/useTheme.js');
  const { theme } = useTheme();
  expect(theme.value).toBe('light');
  expect(document.documentElement.dataset.theme).toBe('light');
});

test('ignores garbage localStorage value and falls back to dark', async () => {
  localStorage.setItem('ad-dashboard-theme', 'high-contrast');
  const { useTheme } = await import('../src/composables/useTheme.js');
  const { theme } = useTheme();
  expect(theme.value).toBe('dark');
});

test('two useTheme() calls in the same tab share the same ref', async () => {
  const { useTheme } = await import('../src/composables/useTheme.js');
  const a = useTheme();
  const b = useTheme();
  // Same singleton — toggling via a is visible via b.
  a.toggleTheme();
  expect(b.theme.value).toBe('light');
});
