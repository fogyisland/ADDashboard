// R161.11 (2026-10-26) — 时区的**单一真源** (后端侧)
//
// ★ 背景 (操作员现场, 原话):
//     「复制 Agent 令牌 #41 · admin · 2026/10/27 05:03:03」
//     「payload revealedAt: "2026-10-26T13:03:03.035Z"」
//     「这时间计算的明显的不对啊」
//
//   同一行审计记录里, 界面时间比 payload 里的真 UTC 时刻**晚了 8 小时**。
//   根因不是前端格式化, 而是**存储**: MySQL 的 `DEFAULT CURRENT_TIMESTAMP`
//   按**会话时区**求值 (默认 SYSTEM = 服务器 OS 时区 = 本机 CST +8),
//   而 MSSQL 的 `DEFAULT sysutcdatetime()` **恒定 UTC** —— 两边基线 1:1 对应,
//   语义却不同。修复 = 每条新连接同步钉 `SET time_zone = '+00:00'`
//   (见 src/db/drivers/mysql.js 的 pinSessionUtc)。
//
// ★ 本文件锁死的三条契约:
//   1. **存储契约 = UTC**。所有 DATETIME/TIMESTAMP 列存的是 UTC 墙钟。
//      读出来也必须是 UTC —— 客户端按 UTC 解析 (mysql2 `timezone: 'Z'`),
//      浏览器再按显示时区渲染。
//   2. **显示时区是渲染层的事**, 跟存储无关。操作员在「系统设置 → 时区」
//      里选 (存 system_config.app_display_timezone), 服务端是权威值。
//   3. **任何地方都不许再写死 "+8h" / "CST" 这类固定偏移**。偏移必须
//      由 IANA 时区名在**当前时刻**算出来 (含 DST), 否则换时区/换季节就错。
//
// ★ 为什么需要一个"服务端时钟探针":
//   应用自己的连接已经被钉成 UTC (`@@session.time_zone = '+00:00'`),
//   而运维/维护用的裸连接 (例如本文件之外的临时脚本) 默认仍是 SYSTEM 时区。
//   ⇒ "服务器 OS 时区" 与 "应用会话时区" 必须**分开报**, 否则操作员看到
//   CST 就会以为应用还在按本地时区写。探针走**应用自己的 db facade**
//   (db.query) ⇒ 拿到的就是应用池里那条连接的会话时区。

// system_config 里存显示时区的 KV key。
export const DISPLAY_TIMEZONE_KEY = 'app_display_timezone';

// 显示时区的默认。本部署的操作员在 CST (UTC+8); 服务端存不住"浏览器在哪",
// 所以默认给一个明确的 IANA 名, 操作员可在页面上改。
export const DEFAULT_DISPLAY_TIMEZONE = 'Asia/Shanghai';

// 存储契约标识 —— 前端拿它做"这批时间戳按 UTC 解释"的显式声明。
export const STORAGE_CONTRACT = 'UTC';

// 常用时区 (页面下拉框置顶用)。完整清单走 Intl.supportedValuesOf('timeZone')。
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

// Intl.supportedValuesOf 是 ES2022 的 API; 老 Node (或精简 ICU 构建) 上可能
// 不存在 ⇒ 退化成"只认常见清单 + UTC"。判定函数必须 fail-closed:
// 认不出的时区一律拒绝写入 (而不是让前端渲染出一个假时区)。
let cachedSupported = null;
export function listSupportedTimeZones() {
  if (cachedSupported) return cachedSupported;
  const out = new Set(COMMON_TIMEZONES);
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function') {
      for (const tz of Intl.supportedValuesOf('timeZone')) out.add(tz);
    }
  } catch {
    // ICU 数据缺失 —— 保留 COMMON_TIMEZONES 即可, 不静默吞: 下面的
    // isValidTimeZone 会把认不出的值拒掉, 不会写坏配置。
  }
  cachedSupported = [...out].sort();
  return cachedSupported;
}

// 时区名合法性判定。接受:
//   - 'UTC'
//   - **引擎认得**的 IANA 名 (canonical 名 + 别名, 如 'Asia/Kolkata')
// 拒绝: 空串、unknown、'GMT+8' 这类**固定偏移串** (没有 DST 语义, 且
// 各家写法不统一 ⇒ 反而会算错)。
//
// ★ R161.11 — 为什么**不**用 `listSupportedTimeZones().includes(tz)`:
//   那张表来自 Intl.supportedValuesOf('timeZone'), 只列 **canonical** 名,
//   而不同 ICU 版本的 canonical 名**不一样** —— 本机 Node 25 的清单里
//   'Asia/Kolkata' 叫 'Asia/Calcutta' (认不出 Kolkata), 浏览器里可能反过来。
//   ⇒ 用 canonical 列表判定 = 浏览器能选、后端 400 拒 (前后端漂移)。
//   ⇒ 改用**引擎自己**: Intl 认得就收, 认不出的抛 RangeError ⇒ 拒。
//
// ★ 固定偏移串 ('GMT+8' / 'UTC+8' / '+08:00') 一律拒绝。注意
//   'Etc/GMT+8' 是**真 IANA 名** (UTC-8), 不是固定偏移串, 照收。
const validTimeZoneCache = new Map();

function computeIsValidTimeZone(tz) {
  if (/^(?:utc|gmt)?\s*[+-]\d{1,2}(?::?\d{2})?$/i.test(tz)) return false;
  try {
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
  // 正缓存: 渲染路径每个时间戳都会调一次, 不能每次都新建 DateTimeFormat。
  const cached = validTimeZoneCache.get(tz);
  if (cached !== undefined) return cached;
  const ok = computeIsValidTimeZone(tz);
  validTimeZoneCache.set(tz, ok);
  return ok;
}

// 把任意输入规整成"合法的显示时区", 非法/缺失时回落到默认。
// 服务端读配置时必须走它 —— 配置里存了脏值不能让整页挂掉。
export function normalizeDisplayTimeZone(raw) {
  const tz = typeof raw === 'string' ? raw.trim() : '';
  if (isValidTimeZone(tz)) return tz;
  return DEFAULT_DISPLAY_TIMEZONE;
}

// 某个时区在**给定时刻**相对 UTC 的偏移分钟数 (含 DST)。
// 用 Intl 把该时刻格式化成"墙上时间", 再跟 UTC 同一时刻比对。
//   Asia/Shanghai 2026-01-15 ⇒ +480
//   Europe/Berlin 2026-07-15 ⇒ +120   (夏令时)
//   Europe/Berlin 2026-01-15 ⇒ +60
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
  // hour12:false 在部分 ICU 版本会把午夜格式化成 "24" ⇒ 取模 24。
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return 0;
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  // 秒以下的毫秒部分在两边都被截掉了, 会引入最多 1s 的误差 ⇒ 先把
  // atMs 向下取整到整秒再比。
  return Math.round((asUtc - Math.floor(atMs / 1000) * 1000) / 60000);
}

// 应用会话的时钟探针。**必须走应用自己的 db facade** (db.query) ⇒
// 拿到的 session tz 就是应用池里那条连接的会话时区。
//
// 返回 shape:
//   {
//     sessionTimeZone: '+00:00' | 'SYSTEM' | ...,
//     systemTimeZone:  'CST' | 'China Standard Time' | ...,
//     serverTimeUtc:   '2026-10-26T13:03:03.000Z',
//     serverTimeSession:'2026-10-26 13:03:03',
//     sessionOffsetMinutes: 0,
//     pinnedToUtc: true
//   }
//
// ★ pinnedToUtc 的语义: "应用写出来的 DEFAULT CURRENT_TIMESTAMP 是不是 UTC"。
//   MySQL: 取决于 @@session.time_zone (钉成 '+00:00' ⇒ 是 UTC)。
//   MSSQL: `DEFAULT sysutcdatetime()` 恒定 UTC ⇒ 恒 true。
export async function readServerClock(db) {
  const dialect = db?.dialect === 'mssql' ? 'mssql' : 'mysql';
  const sql = dialect === 'mssql'
    ? `SELECT CONVERT(VARCHAR(33), SYSUTCDATETIME()) AS now_utc,
              CONVERT(VARCHAR(33), SYSDATETIMEOFFSET()) AS now_session,
              DATEDIFF(MINUTE, SYSUTCDATETIME(), SYSDATETIMEOFFSET()) AS offset_min,
              CONVERT(VARCHAR(64), SERVERPROPERTY('TimeZone')) AS system_tz`
    : `SELECT @@session.time_zone AS session_tz,
              @@system.time_zone AS system_tz,
              UTC_TIMESTAMP() AS now_utc,
              NOW() AS now_session,
              TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), NOW()) AS offset_min`;

  const { rows } = await db.query(sql, []);
  const row = rows?.[0] || {};

  const sessionTimeZone = dialect === 'mssql'
    ? 'UTC (sysutcdatetime)'
    : String(row.session_tz ?? 'UNKNOWN');
  const systemTimeZone = String(row.system_tz ?? 'UNKNOWN');
  const sessionOffsetMinutes = Number(row.offset_min ?? 0) || 0;

  // ★ MSSQL 没有会话时区概念, 但它的 DEFAULT 恒定 UTC ⇒ 恒 true。
  //   MySQL 侧: 会话被钉成 '+00:00' ⇒ NOW() 与 UTC_TIMESTAMP() 相同 ⇒ 偏移 0。
  const pinnedToUtc = dialect === 'mssql' ? true : sessionOffsetMinutes === 0;

  return {
    dialect,
    sessionTimeZone,
    systemTimeZone,
    sessionOffsetMinutes,
    serverTimeUtc: normalizeSqlTimestamp(row.now_utc),
    serverTimeSession: normalizeSqlTimestamp(row.now_session),
    pinnedToUtc
  };
}

// SQL 驱动返回的 DATETIME 可能是 JS Date (mysql2 timezone:'Z' ⇒ 按 UTC 解析)
// 也可能是字符串 (mssql tedious)。统一成 ISO 字符串给前端。
export function normalizeSqlTimestamp(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const s = String(value).trim();
  if (!s) return null;
  // naive 形态 'YYYY-MM-DD HH:mm:ss' —— 按**存储契约**当 UTC 解释。
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const [, y, mo, d, h, mi, sec] = m;
    const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(sec ?? 0));
    return Number.isFinite(ms) ? new Date(ms).toISOString() : s;
  }
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
