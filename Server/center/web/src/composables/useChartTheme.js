// useChartTheme — chart palette mirror for ECharts components. ECharts
// series colors live in JS strings, so they can't read CSS vars directly;
// this composable resolves the relevant vars at mount + whenever the
// theme toggles and exposes them as a reactive `palette.value`.
//
// Consumers should `watch(theme, () => chart.setOption(buildOption()),
// { flush: 'post' })` so canvas repaints on toggle.

import { ref, watch } from 'vue';
import { useTheme } from './useTheme.js';

const VAR_KEYS = [
  'hub-gold', 'gold-border', 'gold-label',
  'shimmer-mid', 'border', 'panel', 'panel-alt', 'bg', 'text', 'muted',
  'terminal-bg', 'terminal-fg',
  'green', 'yellow', 'red', 'accent',
  'in-ok', 'in-warn', 'in-err',
  // R158.45.5 — hover/dim/glow tokens (专家级网络图视觉)
  'hover', 'dim', 'glow'
];

const FALLBACK = {
  'hub-gold': '#fbbf24',
  'gold-border': '#fde68a',
  'gold-label': '#fef3c7',
  'shimmer-mid': '#1e293b',
  'border': '#334155',
  'panel': '#1e293b',
  'panel-alt': '#283548',
  'bg': '#0f172a',
  'text': '#e2e8f0',
  'muted': '#94a3b8',
  'terminal-bg': '#060d18',
  'terminal-fg': '#e2e8f0',
  'green': '#22c55e',
  'yellow': '#eab308',
  'red': '#ef4444',
  'accent': '#38bdf8',
  'in-ok':   '#22d3ee',
  'in-warn': '#64748b',
  'in-err':  '#b91c1c',
  // R158.45.5 — 专家级网络图 hover/dim/glow
  'hover': '#ffffff',                        // hover 高亮 (白)
  'dim':   '#3a4258',                        // 非邻接 dim (暗灰蓝)
  'glow':  'rgba(255, 184, 77, 0.4)'         // hub gold glow shadow
};

function readVar(name) {
  if (typeof document === 'undefined') return FALLBACK[name];
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(`--${name}`)
    .trim();
  return v || FALLBACK[name];
}

function snapshotPalette() {
  const out = {};
  for (const k of VAR_KEYS) out[k] = readVar(k);
  return out;
}

export function useChartTheme() {
  const { theme } = useTheme();
  const palette = ref(snapshotPalette());

  watch(theme, () => {
    // Defer until the new data-theme has been applied to <html> so
    // getComputedStyle picks up the new values.
    requestAnimationFrame(() => {
      palette.value = snapshotPalette();
    });
  }, { flush: 'post' });

  return { theme, palette, snapshotPalette };
}