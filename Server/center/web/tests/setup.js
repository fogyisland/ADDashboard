// R161.13 (2026-10-27) — vitest 全局 setup (jsdom 环境)。
//
// 职责只有三件, 每一件都是为了**消除"跟被测行为无关的失败"**:
//
//   1. 每条测试前清空 localStorage。
//      jsdom 的 localStorage 在同一个 worker 里跨测试共享 —— 上一条测试
//      写进去的显示时区 / 菜单折叠状态会漏进下一条, 于是测试之间互相
//      污染, 出现"单跑绿、整跑红"这种没法查的现象。
//      (setup 文件的 beforeEach 先注册 ⇒ 先于测试文件自己的 beforeEach
//       执行 ⇒ 测试文件里可以放心地在自己的 beforeEach 里写 localStorage。)
//
//   2. 把 fetch 打桩。
//      组件树里任何一个 store 在挂载时去拉接口, 都会在 jsdom 里变成
//      "fetch is not defined" 或者一个悬着的 promise rejection, 让测试
//      挂在跟被测行为无关的地方。桩返回 200 + { items: [] } ——
//      空列表是本项目 fail-open 语义下的正确答案。
//
//   3. 补齐 jsdom 缺的浏览器 API (matchMedia / ResizeObserver /
//      IntersectionObserver)。jsdom 25 没有后两个; 组件里一用就抛
//      ReferenceError, 而那个 ReferenceError 跟被测逻辑毫无关系。
//
// ★ 不做全局桩的项: localStorage 的**内容**。它是被测对象的一部分
//   (前端时区的离线兜底就靠它), 必须是真的。
import { beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// ★ localStorage 修复 —— Node 25 的坑, 必须先解决, 否则整个套件是哑巴。
//
//   实测 (Node v25.8.2): Node 自己带了一个全局 `localStorage`, 但在没有
//   `--localstorage-file <有效路径>` 时它是个**空壳** —— `typeof` 是 'object',
//   `getItem` / `setItem` / `clear` 全都不存在, 并且 node 会打一条
//   "Warning: `--localstorage-file` was provided without a valid path"。
//   vitest 的 jsdom 环境把 jsdom 的 window 铺到 globalThis 上时, **Node 这个
//   坏壳赢了** ⇒ 测试里任何 `localStorage.getItem(...)` 直接
//   "TypeError: localStorage.getItem is not a function"。
//   现场症状特别误导人: 报错点在**被测组件的源码**里 (useTheme.js /
//   AdminLayout.vue), 看着像"代码写错了", 其实是**测试环境**坏了。
//
//   修法: 自己装一份**真的** Storage 上去 —— 取自一个一次性的 JSDOM 实例
//   (jsdom 自带的 Storage 实现是完整合规的: getItem/setItem/removeItem/
//   clear/key/length 都有), 而不是手写一个近似实现 (那会让"测试通过"证明
//   的是"我的 polyfill 跟我自己一致", 不是"浏览器行为一致")。
//   装在 globalThis 上 —— vitest 的 jsdom 环境里 `window === globalThis`,
//   所以 `window.localStorage` 和裸 `localStorage` 拿到的是**同一个**对象,
//   跟浏览器里"两者是同一个存储"的事实一致。
//
//   sessionStorage 同病同治 (Node 25 也有一个同样坏掉的全局)。
// ---------------------------------------------------------------------------
function installRealStorage(name) {
  if (typeof globalThis[name]?.getItem === 'function') return true;
  let storage = null;
  try {
    const scratch = new JSDOM('<!doctype html>', { url: 'http://localhost:3000/' });
    storage = scratch.window[name];
  } catch (err) {
    console.warn(`[vitest setup] 创建 JSDOM 以取 ${name} 失败:`, err?.message);
  }
  if (!storage || typeof storage.getItem !== 'function') return false;
  Object.defineProperty(globalThis, name, {
    value: storage,
    writable: true,
    configurable: true,
    enumerable: true
  });
  return true;
}

for (const storageName of ['localStorage', 'sessionStorage']) {
  if (!installRealStorage(storageName)) {
    // 装不上就必须**大声**: 静默继续 ⇒ 每条测试都以"localStorage.getItem is
    // not a function" 挂掉, 而根因在环境, 会被误判成产品代码的 bug。
    throw new Error(
      `[vitest setup] 装不上可用的 ${storageName} —— 本套件测的就是 DOM 行为, ` +
      '没有 Storage 等于没法测。请检查 jsdom 是否可用 (npm ls jsdom)。'
    );
  }
}

beforeEach(() => {
  try {
    globalThis.localStorage?.clear();
    globalThis.sessionStorage?.clear();
  } catch (err) {
    // 清不掉不是致命错误 (后面每条测试自己会覆盖需要的状态), 但必须留痕:
    // 静默吞掉会让"测试之间互相污染"变成偶发的、查不出来的灵异事件。
    console.warn('[vitest setup] 清空 localStorage/sessionStorage 失败:', err?.message);
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- fetch 桩 ------------------------------------------------------------
vi.stubGlobal('fetch', vi.fn(async (input) => {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input));
  return {
    ok: true,
    status: 200,
    url,
    json: async () => ({ items: [] }),
    text: async () => ''
  };
}));

// ---- jsdom 缺的浏览器 API ------------------------------------------------
if (typeof globalThis.matchMedia !== 'function') {
  vi.stubGlobal('matchMedia', (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false
  }));
}

if (typeof globalThis.ResizeObserver !== 'function') {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
}

if (typeof globalThis.IntersectionObserver !== 'function') {
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  });
}
