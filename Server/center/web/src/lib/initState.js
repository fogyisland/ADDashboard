// center/web/src/lib/initState.js
// R159 (2026-10-25) — 初始化状态闸门 (init-state gate).
//
// 故障背景 (操作员 2026-10-25 报): 初始化向导期间, 前端三个后台轮询一直在打
//   · GET /api/admin/system-settings-v2/license-state
//   · GET /api/admin/system-settings-v2/feature-flags
//   · GET /api/admin/system-alerts/since?since=…&limit=50
// 而 init 模式下后端**根本没挂载**这三个 router (server.js 的
// `if (needsInit) { … } else { … }` 分支) → 每个请求必然 404, 纯噪音。
// 操作员原话: "初始化完成之前不应该访问这个网址"。
//
// 根因不在后端 (init 模式不挂 admin 路由本身就是正确答案, 404 是正确信号),
// 而在前端 gate 用错了信号:
//   · license-state 轮询**完全没有 gate** —— 模块顶层就 ls.startPolling();
//   · feature-flags / system-alerts 的 gate 是 auth.isLoggedIn, 即
//     "localStorage 里有残留 token" 就算"已登录" —— 而 init 阶段根本还没有
//     管理员用户, 浏览器里的旧 token 让这两个轮询照常启动。
//
// 正确的信号是服务端自己的权威状态: GET /api/init/status → needsInit。
//
// 设计要点 (每一条都有对应的回归测试, 见 center/tests/web-init-state.test.js):
//   1. **不用 api/client.js** —— client.js → router.js → 本模块 会成 import 环;
//      且 /api/init/status 是公开端点, 不该触发 axios 的 401 拦截器。
//      这里用原生 fetch。
//   2. **全局单例** —— 同一份"初始化状态"只留一个 owner; router.js 与 main.js
//      共用同一个闸门。两边各问一次会重复请求, 且两份缓存可能打架
//      (finalize 之后必须能失效 → resetInitState())。
//   3. **0 TTL 缓存** —— 初始化状态在一次会话内由服务端一句话决定, 缓存到
//      reset 为止; 不做定时过期, 避免"过期点正好落在向导中途"的竞态。
//   4. **single-flight** —— 并发调用共享同一个 in-flight promise, 只发一次请求。
//   5. **失败不缓存** —— 一次网络抖动不该把"未知"固化成"已初始化"的结论;
//      失败时 known=false, 下次调用会重试。
//   6. **判定方向分两处** —— main.js 侧 fail-closed (状态未知 → 一个后台轮询
//      都不起); router.js 侧 fail-open (状态未知 → 视为"不需要初始化" →
//      不把用户锁死在 /init, 与旧行为一致, 避免 /api/init/status 抖动时全站卡死)。
//
// 导出:
//   createInitStateGate({ fetchImpl, endpoint }) — 工厂, 便于注入替身 fetch
//   getInitState()                              — 单例读取 ({ known, needsInit })
//   resetInitState()                            — 单例失效 (向导 finalize 之后调用)
//   isBackgroundPollingAllowed(state)           — 纯判定函数

const DEFAULT_ENDPOINT = '/api/init/status';

// 默认 fetch: 原生 fetch + 相对路径 (同源), 不带 Authorization ——
// /api/init/status 是公开端点, 带上旧 token 反而可能触发 401 拦截。
async function defaultFetchImpl(path) {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('fetch unavailable in this runtime');
  }
  return globalThis.fetch(path, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'same-origin'
  });
}

// Response-like (有 .json()) 与 裸 payload 都要支持 —— 注入的替身 fetch
// 通常直接返回对象, 而真 fetch 返回 Response。
function isResponseLike(value) {
  return !!value && typeof value === 'object' && typeof value.json === 'function';
}

// 形状检查: 只认 { needsInit: boolean }。其它形状 (null / 数组 / 缺字段 /
// 字段类型不对) 一律当"状态未知", 且不缓存。
function parsePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('init status payload is not an object');
  }
  if (typeof payload.needsInit !== 'boolean') {
    throw new Error('init status payload has no boolean needsInit');
  }
  return { known: true, needsInit: payload.needsInit };
}

export function createInitStateGate(options = {}) {
  const fetchImpl = options.fetchImpl || defaultFetchImpl;
  const endpoint = options.endpoint || DEFAULT_ENDPOINT;
  // null = 还没问过; { known, needsInit } = 已知的最终答案。
  let cached = null;
  // single-flight: 并发调用共享同一次请求。
  let inFlight = null;

  async function load() {
    try {
      const res = await fetchImpl(endpoint);
      // 真的 Response 且状态码非 2xx → 当失败处理 (不缓存, 下次重试)。
      if (res && typeof res.ok === 'boolean' && !res.ok) {
        throw new Error(`init status request failed: HTTP ${res.status}`);
      }
      const payload = isResponseLike(res) ? await res.json() : res;
      const state = parsePayload(payload);
      cached = state;
      return state;
    } catch {
      // 失败不缓存 —— 一次抖动不固化结论, 下次调用会重试。
      return { known: false, needsInit: null };
    }
  }

  async function getState() {
    if (cached) return cached;
    if (!inFlight) {
      inFlight = load().finally(() => { inFlight = null; });
    }
    return inFlight;
  }

  function reset() {
    cached = null;
    inFlight = null;
  }

  return { getState, reset };
}

// ---- 全局单例 -------------------------------------------------------------

const singleton = createInitStateGate();

export function getInitState() {
  return singleton.getState();
}

export function resetInitState() {
  singleton.reset();
}

// 纯判定: 只有"明确知道不需要初始化"才允许后台轮询。
// 未知 (known !== true) → false (fail-closed)。
export function isBackgroundPollingAllowed(state) {
  if (!state || state.known !== true) return false;
  return state.needsInit === false;
}
