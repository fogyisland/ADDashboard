import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 2026-09-01 R73 fix: vitest 2.1.9 plugin container ordering bug. Production vite
// build resolves @vitejs/plugin-vue's transform before vite:import-analysis and
// transforms .vue files into JS. In vitest, vite:import-analysis runs FIRST and
// rejects raw .vue content as invalid JS ("Failed to parse source for import
// analysis ... Install @vitejs/plugin-vue to handle .vue files").
//
// Fix: build a wrap plugin that has the SAME hooks as @vitejs/plugin-vue but
// with `enforce: 'pre'`. The wrap closes over the real vue() plugin's hook
// methods and forwards calls. This guarantees the transform runs before
// vite:import-analysis regardless of vitest's internal plugin ordering.
const baseVue = vue();
const wrap = (name, fn) => (...args) => {
  if (typeof fn === 'function') return fn(...args);
  return undefined;
};

const vuePluginPre = {
  name: 'vitest:vue-pre-wrapper',
  enforce: 'pre',
  config: wrap('config', baseVue.config),
  configResolved: wrap('configResolved', baseVue.configResolved),
  configureServer: wrap('configureServer', baseVue.configureServer),
  buildStart: wrap('buildStart', baseVue.buildStart),
  resolveId: wrap('resolveId', baseVue.resolveId),
  load: wrap('load', baseVue.load),
  transform(code, id, opt) {
    if (typeof baseVue.transform === 'function' && /\.vue$/.test(id)) {
      // eslint-disable-next-line no-console
      console.log('[vue-pre] transform called for', id.slice(-40));
    }
    if (typeof baseVue.transform === 'function') {
      return baseVue.transform(code, id, opt);
    }
    return undefined;
  },
  shouldTransformCachedModule: wrap('shouldTransformCachedModule', baseVue.shouldTransformCachedModule),
  handleHotUpdate: wrap('handleHotUpdate', baseVue.handleHotUpdate)
};

export default defineConfig({
  plugins: [vuePluginPre],
  root: __dirname,
  server: {
    deps: {
      inline: ['@vitejs/plugin-vue', 'vue', '@vue/compiler-sfc', '@vue/compiler-dom', '@vue/runtime-dom']
    }
  },
  optimizeDeps: {
    exclude: ['@vitejs/plugin-vue', 'vue']
  },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['tests/**/*.{test,spec}.{js,mjs}'],
    setupFiles: ['./tests/setup.js'],
    server: {
      deps: {
        inline: ['vue', '@vue/runtime-dom', '@vue/runtime-core', '@vue/reactivity', '@vue/shared', '@vue/compiler-sfc', '@vue/compiler-dom', '@vue/compiler-core', '@vitejs/plugin-vue']
      }
    }
  }
});