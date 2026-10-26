// R161.13 (2026-10-27) — 前端测试配置 (vitest)
//
// ★ 为什么这个文件以前不存在, 而 `npm run test:web` 是个**死脚本**:
//   center/package.json 里的脚本是 `vitest run --config web/vitest.config.js`,
//   而它指向的配置文件**从来没在树里出现过** ⇒ 跑起来直接
//   "Cannot find config file"。当时只有两条路: 改 center/package.json
//   (带 .install-hash, 不能碰), 或者承认"修不了"。
//   ⇒ 真相是: **缺的是这个配置文件, 不是 package.json**。现在补上。
//
// ★ 两个测试套件的分工 (别互相重复):
//   - node --test 套件 (center/tests/**): 纯逻辑、静态契约、后端路由。
//     用 node:test 跑, **没有 DOM** —— localStorage / 组件挂载都测不了。
//     (时区纯函数的前后端逐格比对就在那儿: tests/timezone-settings.test.js)
//   - vitest 套件 (center/web/tests/**): **只有 DOM 才测得了**的部分 ——
//     Vue 组件的挂载/渲染/交互、localStorage 兜底、浏览器事件语义。
//   ⇒ 纯函数不要再往这边抄一遍, 那边已经锁死了。
//
// ★ root 必须是 web/ (不是仓库根):
//   组件测试要 import .vue 单文件组件, 需要 @vitejs/plugin-vue 编译;
//   而 web/src 内部的相对 import 是相对于 web/ 解析的。
//
// ★ 必须在 center/ 目录下跑 (`npm run test:web` 天然满足这个前提):
//   直接在 web/ 里 `npx vitest` 会走 vite.config.js —— 那里没有 test 段,
//   于是**静默**用 node 环境跑, localStorage 直接是 undefined, 组件测试
//   会以"看起来像真失败"的方式挂掉 (R161.11 的教训: 断言必须证明自己
//   真的跑到了, 否则跟"哑巴测试"没法区分)。
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 需要 inline 的依赖: 这些包以 CJS/ESM 双形态发布, vitest 的 SSR 转换
// 偶尔会拿到"没有默认导出"的那一份 ⇒ 显式 inline 走 Vite 自己的解析。
const INLINE_DEPS = [
  'vue',
  '@vue/runtime-dom',
  '@vue/runtime-core',
  '@vue/reactivity',
  '@vue/shared',
  '@vue/compiler-sfc',
  '@vue/compiler-dom',
  '@vue/compiler-core',
  '@vitejs/plugin-vue'
];

export default defineConfig({
  plugins: [vue()],
  root: __dirname,
  test: {
    // ★ jsdom 而不是 node: 这个套件的全部意义就是 DOM。
    environment: 'jsdom',
    // 不开 globals: 测试文件显式 `import { describe, it, expect } from 'vitest'`
    // —— 隐式全局会让"忘了 import"变成运行时才炸。
    globals: false,
    include: ['tests/**/*.{test,spec}.{js,mjs}'],
    setupFiles: ['./tests/setup.js'],
    server: { deps: { inline: INLINE_DEPS } },
    // 单个测试文件失败不许把整个 worker 拖死 —— 报告里要能看到别的文件
    // 的结果 (CI 里"第一个失败就停"会让人误以为只有一处坏了)。
    reporters: ['default']
  }
});
