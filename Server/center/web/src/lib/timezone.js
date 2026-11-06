// R161.11 (2026-10-26) — 显示时区的单一真源 (前端侧)
//
// ★ 为什么要有这个文件:
//   R161.10 的现场事故 —— 审计页把一条真实发生在 2026-10-26 21:03 (CST)
//   的操作显示成 "2026/10/27 05:03:03", 整整偏 8 小时, 而界面**没有任何**提示。
//   根因在存储 (MySQL 会话时区没钉 UTC), 已由后端 pinSessionUtc 修掉;
//   但"时间戳怎么解释、怎么渲染"必须在**前端也有一个单一真源**, 否则
//   每个 view 各写各的 toLocaleString / 硬编码 +8h, 同样的错会再来一次。
//
// ★ 三条契约 (跟后端 src/services/timezone.js 逐条对应):
//   1. **存储 = UTC**。后端返回的时间戳一律按 UTC 解释。
//      ★ naive 形态 ('YYYY-MM-DD HH:mm:ss', 没有时区标记) 按**存储契约**当 UTC ——
//        这是 MySQL DATETIME 的天然形态, 不做这层转换就会退化成浏览器本地时区,
//        也就是 R161.10 那个 bug 的另一种形态。
//   2. **显示时区是渲染层参数**, 权威值在服务端 (system_config.app_display_timezone),
//      前端启动时拉一次, 之后以本地缓存兜底 (离线/接口挂了也能用)。
//   3. **不写死固定偏移**。要偏移就用 IANA 时区名在**当前时刻**算 (含 DST)。
//
// ★ 与后端的关系: 后端 src/services/timezone.js 是权威, 本文件是它的前端副本。
//   两边的 isValidTimeZone / offsetMinutesFor 语义必须一致 —— 由
//   tests/timezone-settings.test.js 逐条比对锁死 (跟 feature-flag-semantics
//   同一个套路: 两份纯函数副本 + 一个锁它们的测试)。

// localStorage 缓存 key (后端权威值之外的本地兜底)。
const STORAGE_KEY = 'ad_display_timezone';

// 与后端 DEFAULT_DISPLAY_TIMEZONE 对齐 (src/services/timezone.js)。
export const DEFAULT_DISPLAY_TIMEZONE = 'Asia/Shanghai';

// 与后端 COMMON_TIMEZONES 对齐 (下拉框置顶用)。
export const COMMON_TIMEZONES = [
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Seoul',
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles'
];

// ---------------------------------------------------------------- 状态

// 服务端权威值 (null = 还没拿到)。拿到之后优先于 localStorage。
let serverTimezone = null;

// 订阅者 (view 用它把时区变更反映到界面上)。
const listeners = new Set();

// ---------------------------------------------------------------- 纯函数

// 浏览器本地时区 (IANA 名)。取不到时回落 'UTC'。
export function browserTimeZone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && tz ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

let cachedSupported = null;
// 完整时区清单 (IANA)。老浏览器没有 Intl.supportedValuesOf ⇒ 退化成常见清单。
export function listSupportedTimeZones() {
  if (cachedSupported) return cachedSupported;
  const out = new Set(COMMON_TIMEZONES);
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function') {
      for (const tz of Intl.supportedValuesOf('timeZone')) out.add(tz);
    }
  } catch {
    // ICU 数据缺失 —— 保留常见清单; isValidTimeZone 会把认不出的值拒掉。
  }
  cachedSupported = [...out].sort();
  return cachedSupported;
}

// 时区名合法性 (跟后端 isValidTimeZone 同语义)。
//
// ★ R161.11 — 为什么**不**用 `listSupportedTimeZones().includes(tz)` 判定:
//   那张表来自 Intl.supportedValuesOf('timeZone'), 它只列 **canonical** 名,
//   而不同 ICU 版本的 canonical 名**不一样** —— 本机 Node 25 的清单里
//   'Asia/Kolkata' 叫 'Asia/Calcutta' (不认 Kolkata), 浏览器里可能又反过来。
//   ⇒ 用 canonical 列表判定 = 浏览器能选、后端 400 拒 (前后端漂移)。
//   ⇒ 改用**引擎自己**: Intl 认得的时区名一律接受 (canonical + 别名都收),
//     认不出的抛 RangeError ⇒ 拒。浏览器与 Node 的 ICU 名录基本一致。
//
// ★ 固定偏移串 ('GMT+8' / 'UTC+8' / '+08:00') 一律拒绝 —— 它们没有 DST
//   语义, 且各家写法不统一 ⇒ 反而会算错 (夏令时切换那天直接错 1 小时)。
//   注意 'Etc/GMT+8' 是**真 IANA 名** (UTC-8), 不是固定偏移串, 照收。
const validTimeZoneCache = new Map();

function computeIsValidTimeZone(tz) {
  if (/^(?:utc|gmt)?\s*[+-]\d{1,2}(?::?\d{2})?$/i.test(tz)) return false;
  try {
    // 引擎认不得这个名字就抛 RangeError ⇒ 非法。
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string') return false;
  const tz = timeZone.trim();
  if (!tz) return false;
  if (tz === 'UTC') return true;
  // 正缓存: 渲染路径每个时间戳都会调一次 isValidTimeZone, 不能每次都
  // 新建一个 DateTimeFormat。
  const cached = validTimeZoneCache.get(tz);
  if (cached !== undefined) return cached;
  const ok = computeIsValidTimeZone(tz);
  validTimeZoneCache.set(tz, ok);
  return ok;
}

// 规整成合法时区, 非法/缺失时回落到默认。
export function normalizeDisplayTimeZone(raw) {
  const tz = typeof raw === 'string' ? raw.trim() : '';
  if (isValidTimeZone(tz)) return tz;
  return DEFAULT_DISPLAY_TIMEZONE;
}

// 某时区在给定时刻相对 UTC 的偏移分钟数 (含 DST)。
export function offsetMinutesFor(timeZone, at = new Date()) {
  const tz = isValidTimeZone(timeZone) ? timeZone.trim() : 'UTC';
  const atMs = at instanceof Date ? at.getTime() : Number(at);
  if (!Number.isFinite(atMs)) return 0;
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const parts = {};
  for (const part of dtf.formatToParts(new Date(atMs))) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return 0;
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return Math.round((asUtc - Math.floor(atMs / 1000) * 1000) / 60000);
}

// 偏移分钟 → '+08:00' 形态 (0 → '+00:00')。
export function formatOffsetMinutes(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m)) return '—';
  const sign = m < 0 ? '-' : '+';
  const abs = Math.abs(Math.trunc(m));
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

// ★ 时间戳 → Date。**naive 形态按 UTC 解释** (存储契约)。
//   - Date 实例 ⇒ 原样
//   - 带 Z / 带 ±HH:MM 偏移的 ISO 串 ⇒ 原样
//   - 'YYYY-MM-DD HH:mm:ss' / 'YYYY-MM-DDTHH:mm:ss' (naive) ⇒ **按 UTC**
//   - null / undefined / 空串 / 非法 ⇒ null
export function parseTimestamp(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  // 带时区标记 ⇒ 交给引擎解析。
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // naive 形态 ⇒ 按 UTC 补上 Z (MySQL DATETIME 的天然形态)。
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?/);
  if (m) {
    const [, y, mo, d, h, mi, sec, frac] = m;
    // ★ 小数秒要按**字符串**补零 ('.5' ⇒ 500ms, '.035' ⇒ 35ms),
    //   不能先转数字 —— 转了就没有 padEnd 了 (R161.11 实测: 原来的写法
    //   `+(frac ?? 0).padEnd(3,'0')` 对**任何** naive 串都会抛 TypeError,
    //   因为 `(undefined ?? 0)` 是数字 0, 数字没有 padEnd)。
    const msPart = frac ? String(frac).padStart(3, '0').slice(0, 3) : '000';
    const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(sec ?? 0), +msPart);
    return Number.isFinite(ms) ? new Date(ms) : null;
  }
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ★ 渲染主入口: 把任意时间戳渲染成"显示时区"的墙上时间。
//   opts: { timeZone, withSeconds, withDate, withYear, fallback }
export function formatDateTime(value, opts = {}) {
  const {
    timeZone = null,
    withSeconds = true,
    withDate = true,
    withYear = true,
    fallback = '—'
  } = opts || {};
  const d = parseTimestamp(value);
  if (!d) return fallback;
  const tz = timeZone || getDisplayTimezone();
  const parts = {
    timeZone: isValidTimeZone(tz) ? tz : 'UTC',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
    hourCycle: 'h23'
  };
  if (withSeconds) parts.second = '2-digit';
  if (!withDate) {
    delete parts.year; delete parts.month; delete parts.day;
  }
  if (!withYear) {
    delete parts.year;
  }
  try {
    return new Intl.DateTimeFormat('zh-CN', parts).format(d);
  } catch {
    // 浏览器 ICU 不认这个时区名 ⇒ 回落 UTC, 0 抛给调用方。
    return new Intl.DateTimeFormat('zh-CN', { ...parts, timeZone: 'UTC' }).format(d);
  }
}

// ★ 机器可读形态 'YYYY-MM-DD HH:mm:ss' (显示时区)。给需要"窄列 + 可排序"
//   的表格用 (PartnerPortHealthView 的 probe 写入时刻列就是这个诉求)。
//   注意: 跟旧的 `getFullYear()/getMonth()/...` 手搓版本不同 —— 那些取的是
//   **浏览器本地时区**的墙上时间, 换一台机器/换一个时区就变 ⇒ 同样是"算错"。
export function formatDateTimeIso(value, opts = {}) {
  const { timeZone = null, withSeconds = true, withYear = true, fallback = '—' } = opts || {};
  const d = parseTimestamp(value);
  if (!d) return fallback;
  const tz = timeZone || getDisplayTimezone();
  const parts = {
    timeZone: isValidTimeZone(tz) ? tz : 'UTC',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
    hourCycle: 'h23'
  };
  if (withSeconds) parts.second = '2-digit';
  // ★ withYear=false ⇒ 退化成 'MM-DD HH:mm[:ss]' (图表轴用)。
  //   迁移前的 `MM-DD hh:mm` 手搓版是拿 CST 偏移硬算的, 换时区就错;
  //   现在按显示时区算, 宽度跟原来一致 (19 → 14 字符)。
  if (!withYear) delete parts.year;
  const out = {};
  for (const part of new Intl.DateTimeFormat('en-CA', parts).formatToParts(d)) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  if (!out.month || !out.day) return fallback;
  const hhmm = `${out.hour}:${out.minute}`;
  // ★ withYear=false ⇒ parts 里没有 year, 所以**不能**再拿 out.year 做判空
  //   (R161.11 实测: 原来那句 `if (!withYear && !out.year) return fallback`
  //   恒真 ⇒ 所有图表轴的 'MM-DD HH:mm' 全部渲染成空串)。
  if (!withYear) {
    return withSeconds
      ? `${out.month}-${out.day} ${hhmm}:${out.second}`
      : `${out.month}-${out.day} ${hhmm}`;
  }
  if (!out.year) return fallback;
  return withSeconds
    ? `${out.year}-${out.month}-${out.day} ${hhmm}:${out.second}`
    : `${out.year}-${out.month}-${out.day} ${hhmm}`;
}

// ★ 毫秒精度形态 'MM-DD HH:mm:ss.SSS' (显示时区)。SystemAlertsView /
//   FailedLogonView 需要毫秒来区分"同一秒内的多条事件"。
export function formatDateTimeMs(value, opts = {}) {
  const { timeZone = null, fallback = '' } = opts || {};
  const d = parseTimestamp(value);
  if (!d) return fallback;
  const tz = timeZone || getDisplayTimezone();
  const parts = {
    timeZone: isValidTimeZone(tz) ? tz : 'UTC',
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
    hourCycle: 'h23'
  };
  const out = {};
  for (const part of new Intl.DateTimeFormat('en-CA', parts).formatToParts(d)) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  if (!out.month || !out.day) return fallback;
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0');
  return `${out.month}-${out.day} ${out.hour}:${out.minute}:${out.second}.${ms}`;
}

// ★ 纯日期形态 'YYYY-MM-DD' (显示时区)。
//   迁移前的写法是 `d.getFullYear()/getMonth()+1/getDate()` 手搓 —— 取的是
//   **浏览器本地时区**的墙上时间, 换台机器/换个时区同一个时间戳就显示成
//   不同日期 ⇒ 同样是"算错"。现在统一按显示时区算。
export function formatDateOnly(value, opts = {}) {
  const { timeZone = null, withYear = true, fallback = '—' } = opts || {};
  const d = parseTimestamp(value);
  if (!d) return fallback;
  const tz = timeZone || getDisplayTimezone();
  const parts = {
    timeZone: isValidTimeZone(tz) ? tz : 'UTC',
    year: 'numeric', month: '2-digit', day: '2-digit'
  };
  const out = {};
  for (const part of new Intl.DateTimeFormat('en-CA', parts).formatToParts(d)) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  if (!out.month || !out.day) return fallback;
  if (!withYear) return `${out.month}-${out.day}`;
  if (!out.year) return fallback;
  return `${out.year}-${out.month}-${out.day}`;
}

// ★ 纯时间形态 'HH:mm:ss' (显示时区)。给"只关心几点几分"的列用
//   (DailyOpsView 的时钟列等)。
export function formatTimeOnly(value, opts = {}) {
  const { timeZone = null, withSeconds = true, fallback = '—' } = opts || {};
  const d = parseTimestamp(value);
  if (!d) return fallback;
  const tz = timeZone || getDisplayTimezone();
  const parts = {
    timeZone: isValidTimeZone(tz) ? tz : 'UTC',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
    hourCycle: 'h23'
  };
  if (withSeconds) parts.second = '2-digit';
  const out = {};
  for (const part of new Intl.DateTimeFormat('en-CA', parts).formatToParts(d)) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  if (!out.hour || !out.minute) return fallback;
  return withSeconds
    ? `${out.hour}:${out.minute}:${out.second}`
    : `${out.hour}:${out.minute}`;
}

// 渲染成 UTC 墙上时间 (审计/运维场景要跟服务端日志对齐时用)。
export function formatDateTimeUtc(value, opts = {}) {
  return formatDateTime(value, { ...opts, timeZone: 'UTC' });
}

// ---------------------------------------------------------------- 状态读写

// 当前生效的显示时区。
//   优先级: 服务端权威值 > localStorage 缓存 > 默认值 (Asia/Shanghai)。
//
// ★ R161.11 — 为什么**不**回落浏览器本地时区:
//   显示时区是**服务端**的权威配置 (system_config.app_display_timezone),
//   服务端的默认值也是 Asia/Shanghai。若前端回落浏览器时区, 就会出现
//   "页面刚打开时按浏览器时区渲染, 拉到服务端配置后整页跳一次" 的抖动,
//   而且两个操作员在两台机器上会看到**不同**的时间 —— 正是 R161.10 那类
//   "同样的数据显示成不同时间" 的病根。
//   ⇒ 唯一真源 = 服务端。拉不到 (离线/接口挂了) 就用同款默认值,
//     至多与操作员自己设的时区不同, 但**所有操作员看到的是同一个值**。
export function getDisplayTimezone() {
  if (serverTimezone) return serverTimezone;
  try {
    const cached = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (cached && isValidTimeZone(cached)) return cached;
  } catch {
    // localStorage 不可用 (隐私模式 / 配额满) ⇒ 用下面的兜底, 不静默失败:
    // 这里不是错误路径, 只是拿不到缓存。
  }
  return DEFAULT_DISPLAY_TIMEZONE;
}

// 设置显示时区。persist=true 时同时写 localStorage (跨会话兜底)。
// 返回实际生效的时区 (非法值会被规整成默认值)。
export function setDisplayTimezone(timeZone, { persist = true } = {}) {
  const tz = normalizeDisplayTimeZone(timeZone);
  serverTimezone = tz;
  if (persist) {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, tz);
    } catch {
      // 写不进去 (隐私模式) 不是致命错误 —— 内存值仍然生效, 下次从服务端再拉。
    }
  }
  for (const fn of listeners) {
    try {
      fn(tz);
    } catch {
      // 单个订阅者出错不能影响其它订阅者。
    }
  }
  return tz;
}

// 只更新"服务端权威值" (启动时从接口拉到的), 不写 localStorage。
export function applyServerTimezone(timeZone) {
  const tz = normalizeDisplayTimeZone(timeZone);
  serverTimezone = tz;
  for (const fn of listeners) {
    try {
      fn(tz);
    } catch {
      // 同上。
    }
  }
  return tz;
}

// 订阅时区变化, 返回退订函数。
export function subscribeDisplayTimezone(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}
