import pino from 'pino';

// R158.0.1.9 (2026-10-20) — 3 级应用层日志.
// 操作员 directive: 日志太大, 收成 info / error / debug 三档 (业务语义),
// 不是 pino 原生 6 级. 映射规则:
//   info  (默认) → pino 'info'  = 仅 OK outcome (reporter 5 个 ...complete 行 +
//                                  collector / scheduler 等模块的 success breadcrumb)
//   error        → pino 'error' = 仅 error 等级 (warn + error + fatal, 包含可恢复的
//                                  异常信号 — fetchConfig 失败 / token overlap 等)
//   debug        → pino 'debug' = 全部, 含 method/url/timeoutMs/hasBody 请求细节,
//                                  304 / 2xx body 解析, signed stamp 等
// 任何 createLogger 调用方都自动接住映射. settings-delivery.js 用 APP_LEVELS
// 收紧远端 push 白名单. ALLOWED_LOG_LEVELS (应用级) 跟 ALLOWED_PINO_LEVELS
// (兼容老值) 双 Set, 老 trace/debug/warn/fatal 推送过来统一降级到最近合法值.
const APP_TO_PINO = Object.freeze({
  info:  'info',
  error: 'error',
  debug: 'debug'
});

const APP_LEVELS = Object.freeze(new Set(['info', 'error', 'debug']));

// 老值 (trace / debug / info / warn / error / fatal) 在升级过渡期会出现;
// settings-delivery 收到老值时归一化到最近合法应用级, 避免静默拒收让
// centre 不停重推同一 payload. R158.0.1.9 锁 — 老版本 bundle 已经 ship 不收回,
// 远端 push 兼容必须保留到下次大版本.
const PINO_TO_APP = Object.freeze({
  trace: 'debug',
  debug: 'debug',
  info:  'info',
  warn:  'error',
  error: 'error',
  fatal: 'error'
});

export function normalizeAppLevel(value) {
  if (typeof value !== 'string') return null;
  if (APP_LEVELS.has(value)) return value;
  if (PINO_TO_APP[value]) return PINO_TO_APP[value];
  return null;
}

export function createLogger({ component, level = 'info', stream } = {}) {
  // 入口容错: 任何奇怪的传入值都 fallback 到 'info' 而不是 pino 默认
  // 'info' (一致) — 防止有人传 'TRACE' 大写或 'Info' 大写导致 pino
  // 默默按 warn/error 处理 (pino 内部 unstrict) 偏离操作员预期.
  const appLevel = normalizeAppLevel(level) || 'info';
  const pinoLevel = APP_TO_PINO[appLevel];
  const opts = {
    level: pinoLevel,
    base: { component },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  if (stream) return pino(opts, stream);
  // Default: synchronous writes to stderr (fd 2). Sync destinations are
  // load-bearing under process.exit so fatal lines survive the buffer drain
  // when a service crashes fast (<1500ms). NSSM redirects stderr to a file.
  return pino(opts, pino.destination({ dest: 2, sync: true }));
}

export { APP_LEVELS, APP_TO_PINO };
