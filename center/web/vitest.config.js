import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 2026-09-05 R80 fix: dropped the broken  wrap from R73.
// The wrap forwarded method calls but lost  binding, which
//  errors out under vitest 2.1.9.
// Direct usage below matches what vite.config.js uses for production
// build, so test + build behaviour align.
export default defineConfig({
  plugins: [vue()],
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