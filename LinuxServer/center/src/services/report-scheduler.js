// center/src/services/report-scheduler.js
// R158.61 (2026-10-10) — Daily / weekly email report scheduler.
//
// createReportLoop({ db, getIntervalSeconds, getSystemConfig, logger })
//   → { start, stop, tick, isRunning }
//
// Same factory shape as createEmailDeliveryLoop (services/email.js) and
// createSystemAlertLoop (services/system-alert-engine.js):
//   - start() schedules a setInterval loop; cadence comes from
//     getIntervalSeconds() (default 300s = 5min, clamped to a 10s floor per
//     Global Constraint #9). Re-read on every tick so operator edits to
//     report_loop_interval_seconds in system_config take effect without a
//     center restart.
//   - stop()  clears the interval and awaits the in-flight tick so a slow
//     tick doesn't get cut off during NSSM shutdown.
//   - tick()  reads report_daily_cron / report_weekly_cron / *_enabled from
//     system_config, computes whether the current CST minute matches each
//     expression, and if so calls reports.enqueueReport(kind). Reentry
//     guard prevents overlap if a tick is still running.
//
// Cron parser: a ~50-line pure function supporting the 5-field
// "M H DoM Mon DoW" form. Supports `*` (any), `1,3,5` (list), `1-5`
// (range), `*/5` (step). No seconds field. No @reboot. No L/W modifiers.
// Operator mental model is CST (per R158.61 plan §风险: 中心存 UTC, cron
// 表达式按 CST 解析). Internal `nowCst()` is used by both the parser and
// the loop's "have we already fired this minute?" guard so the two
// never disagree on the wall clock.

import { enqueueReport } from './reports.js';

const REPORT_KINDS = ['daily', 'weekly'];

// Convert a Date to CST wall-clock components. We do the +8h shift in JS
// rather than relying on Intl (CST is technically a half-hourless UTC+8
// offset; Intl with Asia/Shanghai returns the same components in this
// environment but adds ~5µs overhead per call).
function nowCstComponents(d = new Date()) {
  const ms = d.getTime() + 8 * 3600 * 1000;
  const cst = new Date(ms);
  return {
    year: cst.getUTCFullYear(),
    minute: cst.getUTCMinutes(),
    hour: cst.getUTCHours(),
    dayOfMonth: cst.getUTCDate(),
    month: cst.getUTCMonth() + 1,   // 1-12 (JS Date.getUTCMonth is 0-11)
    dayOfWeek: cst.getUTCDay()      // 0=Sun..6=Sat
  };
}

// R158.100.B+3 (2026-10-14) — catch-up dedup window. 跟 nowCstComponents
//   平级, 返 CST "今天/本周" 对应的 UTC [windowStartUtc, windowEndUtc)
//   半开区间. catch-up 用这个区间查 daily_reports, n>0 skip 重启放大.
//
//   daily: windowStartUtc = 今天 CST 00:00 (→ UTC).
//   weekly: windowStartUtc = 本周一 00:00 CST (→ UTC). JS getUTCDay 0=Sun,
//     1=Mon..6=Sat. "本周一" offset = (dayOfWeek + 6) % 7. Mon(1)→0,
//     Tue(2)→1, ..., Sat(6)→5, Sun(0)→6. 减这个数 = 本周一 00:00 CST.
//
//   windowEndUtc 用 now (UTC), 跟 R158.61 reports.js:766 periodEnd=now 1:1
//   平行, "滑动窗口" 语义跟 generated_at 默认 SYSUTCDATETIME() 对齐.
function getReportWindow(kind, now = new Date()) {
  const cst = nowCstComponents(now);
  // 当前 CST ymd 构造 00:00 CST → UTC (CST = UTC+8, 所以 CST 00:00 = UTC -8h)
  const cstMidnightUtcMs = Date.UTC(cst.year, cst.month - 1, cst.dayOfMonth) - 8 * 3600 * 1000;
  let windowStartUtc;
  if (kind === 'daily') {
    windowStartUtc = new Date(cstMidnightUtcMs);
  } else {
    // weekly: 本周一 00:00 CST. (dayOfWeek + 6) % 7 → Mon=0, Tue=1..Sat=5, Sun=6
    const dowOffset = (cst.dayOfWeek + 6) % 7;
    windowStartUtc = new Date(cstMidnightUtcMs - dowOffset * 86400 * 1000);
  }
  return { windowStartUtc, windowEndUtc: now };
}

// R158.101 (2026-10-26) — cron DoW 字段的字母别名表.
//
//   真因: parseField 的单值分支只做 `Number(p)` + `Number.isInteger` 检查,
//   所以 "MON" → NaN → 返回 null → cronMatches 的 `!dow` 为真 → 恒 false.
//   而 report_weekly_cron 的**默认值就是 "0 9 * * MON"** (config.js:376 /
//   baseline 种子), 也就是说周报的 cron 匹配路径从来没有生效过 —— 历史上
//   所有周报都是靠进程启动时的 catch-up 补发.
//
//   修法: DoW 字段接受 3 字母别名 (不区分大小写). 0=Sun..6=Sat 的映射:
//   SUN=0 MON=1 TUE=2 WED=3 THU=4 FRI=5 SAT=6.
const DOW_ALIASES = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6
};

// Parse a single cron field into a Set of integer values. Returns null on
// parse failure (the caller treats null as "this expression is broken,
// don't fire this tick"). Supports `*`, `N`, `N,M,...`, `N-M`, `*/K`.
// `aliases` (optional) maps lowercase names → integer, used for the DoW
// field so "MON" parses the same as "1".
function parseField(field, min, max, aliases) {
  if (field == null) return null;
  const raw = String(field).trim();
  if (!raw) return null;
  const out = new Set();
  const parts = raw.split(',');
  for (const part of parts) {
    const p = part.trim();
    if (!p) return null;
    // Step: */K or N-M/K
    if (p.includes('/')) {
      const [range, stepStr] = p.split('/');
      const step = Number(stepStr);
      if (!Number.isInteger(step) || step <= 0) return null;
      let lo, hi;
      if (range === '*') {
        lo = min; hi = max;
      } else if (range.includes('-')) {
        const [a, b] = range.split('-').map(Number);
        if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
        lo = a; hi = b;
      } else {
        const single = Number(range);
        if (!Number.isInteger(single)) return null;
        lo = single; hi = max;
      }
      for (let v = lo; v <= hi; v += step) out.add(v);
      continue;
    }
    // Range: N-M
    if (p.includes('-')) {
      const [a, b] = p.split('-').map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
      if (a < min || b > max || a > b) return null;
      for (let v = a; v <= b; v++) out.add(v);
      continue;
    }
    // Wildcard
    if (p === '*') {
      for (let v = min; v <= max; v++) out.add(v);
      continue;
    }
    // Single value
    const n = Number(p);
    if (!Number.isInteger(n) || n < min || n > max) {
      // R158.101 — 字母别名 (只给 DoW 用). "MON" → 1.
      // 必须先试数字再试别名: Number('1') = 1 走上面正常路径.
      if (aliases) {
        const alias = aliases[p.toLowerCase()];
        if (alias !== undefined && alias >= min && alias <= max) {
          out.add(alias);
          continue;
        }
      }
      return null;
    }
    out.add(n);
  }
  return out;
}

// Parse a 5-field cron expression. Returns null on parse failure or wrong
// field count. Both "DoM" and "DoW" are checked (Unix/Vixie cron rule:
// when BOTH are restricted, the cron fires when EITHER matches; when
// either is "*", only the other is checked). We implement the standard
// rule: if both DoM and DoW sets have a single "*" entry, fire when all
// 5 match. If both are restricted, fire when (DoM matches AND DoW
// unrestricted) OR (DoW matches AND DoM unrestricted). The most common
// operator case (DoM=*, DoW=1=Monday) is handled by the "DoW
// restricted, DoM unrestricted" branch.
//
// R158.101 (2026-10-26) — DoW 字段支持字母别名 (MON/TUE/...):
//   parseField(dowF, 0, 6, DOW_ALIASES). 之前 "0 9 * * MON" 恒不匹配.
function cronMatches(expression, cst) {
  if (!expression || typeof expression !== 'string') return false;
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minF, hourF, domF, monF, dowF] = fields;
  const minute = parseField(minF, 0, 59);
  const hour = parseField(hourF, 0, 23);
  const dom = parseField(domF, 1, 31);
  const month = parseField(monF, 1, 12);
  const dow = parseField(dowF, 0, 6, DOW_ALIASES);
  if (!minute || !hour || !dom || !month || !dow) return false;
  if (!minute.has(cst.minute)) return false;
  if (!hour.has(cst.hour)) return false;
  if (!month.has(cst.month)) return false;
  const domStar = domF.trim() === '*';
  const dowStar = dowF.trim() === '*';
  let dayOk;
  if (domStar && dowStar) {
    dayOk = true;
  } else if (domStar) {
    dayOk = dow.has(cst.dayOfWeek);
  } else if (dowStar) {
    dayOk = dom.has(cst.dayOfMonth);
  } else {
    // Both restricted: fire on EITHER match. This matches cronie / vixie
    // behavior. 5-field cron spec ambiguity: most operators expect
    // "0 9 * * 1" to mean "every Monday at 9am", which DoM=* + DoW=1
    // handles via the domStar branch. The "both restricted" case
    // (e.g. "0 9 1 * 1" = "9am on the 1st OR any Monday") is rare but
    // is implemented per spec for correctness.
    dayOk = dom.has(cst.dayOfMonth) || dow.has(cst.dayOfWeek);
  }
  return dayOk;
}

// R158.101 (2026-10-26) — **核心修复**: cron 时刻的"采样窗口"匹配.
//
//   真因: 老的 cronMatches 要求 tick 的 CST 分钟**精确等于** cron 的分钟.
//   但循环是 setInterval(300_000) —— tick 离散采样, 相位由进程启动秒数
//   决定. tick 分钟序列 = (startMinute + 5k) mod 60, 要命中 cron 分钟 0
//   需要 startMinute 是 5 的倍数 (gcd(5,60)=5). 60 个相位里只有 12 个
//   (20%) 能命中, 其余 48 个 (80%) **永远不相交**.
//   生产实测: 进程 2026-10-23 19:08:18 启动 → cadence 基准分钟 13 →
//   落在"永远错过"集合 → 10-24/10-25 的 09:00 全部不触发.
//   实证: 21 天日志里 `"msg":"firing daily report"` **0 命中**, 每一份
//   日报都是进程启动时的 catch-up 补发.
//
//   修法 (治本, 不改 cron 表达式语义): 把"精确分钟匹配"换成"**区间覆盖
//   匹配**" —— cron 时刻 T 的触发窗口是 [T, T + cadence). 只要 tick 落在
//   这个区间内就算命中. 由于 cadence >= 任何两个相邻 tick 的间隔, 任何
//   相位下 T 必被**恰好一个** tick 覆盖 → 每天必触发一次, 且不会重复.
//
//   返回值: 命中的 cron 时刻 key (YYYYMMDD-HHMM, CST), 未命中返 null.
//   这个 key 用作 dedup 依据 —— 同一 cron 时刻只 fire 一次, 下一个 cron
//   时刻 (第二天) 会得到不同的 key, 不会互相误挡.
//
//   windowMinutes: 窗口长度(分钟). 调用方传 cadence 秒 / 60, 向上取整.
function cronMatchWindow(expression, cst, windowMinutes) {
  if (!expression || typeof expression !== 'string') return null;
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minF, hourF, domF, monF, dowF] = fields;
  const minutes = parseField(minF, 0, 59);
  const hours = parseField(hourF, 0, 23);
  const doms = parseField(domF, 1, 31);
  const months = parseField(monF, 1, 12);
  const dows = parseField(dowF, 0, 6, DOW_ALIASES);
  if (!minutes || !hours || !doms || !months || !dows) return null;

  const win = Math.max(1, Number(windowMinutes) || 1);
  const domStar = domF.trim() === '*';
  const dowStar = dowF.trim() === '*';

  // 判定"某一天"是否符合日/月/周条件
  const dayMatches = (y, m, d, dow) => {
    if (!months.has(m)) return false;
    const domOk = doms.has(d);
    const dowOk = dows.has(dow);
    if (domStar && dowStar) return true;
    if (domStar) return dowOk;
    if (dowStar) return domOk;
    return domOk || dowOk;   // both restricted → EITHER matches (vixie)
  };

  // 候选 cron 时刻: cron 表达式里的分钟 × 小时, 落在当前 CST 日/周.
  // 窗口 [T, T+win) 可能跨到**次日** —— 那时的日期/周条件要用 T 所属的
  // 那天算, 不是"现在"那天. 两种做法:
  //   (a) 只在"今天"里找 —— 若 T + win 跨日, 则窗口尾部落在明天, 但 cron
  //       的日条件仍按"今天"判定. 这是正确的语义 (cron 说的是"今天
  //       09:00 触发", 触发后 5 分钟内都算这次触发).
  //   (b) 额外检查"昨天的 cron 时刻 + win 是否跨到今天" —— 那会让昨天
  //       的日报延迟到今天才发, 不符合"每天 9 点发"的直觉.
  // 采用 (a): 候选 T 属于"当前 CST 日", 日条件按该日判定.
  //
  // 边界: 若 T + win 超过 24:00 (窗口跨日), 则该 cron 时刻的窗口延伸到
  // 次日, 届时"次日的 tick"也可能落进同一个窗口 → 需要防止重复 fire.
  // dedup key 用的是 **T 本身的 YYYYMMDD-HHMM**, 跨日延伸不影响:
  // 次日的 tick 落进延伸窗口时, 它的候选 T 是"次日 09:00", key 不同 →
  // 会 fire 一次. 这是正确的 (次日的日报本来就该发).

  // 找今天的候选 T
  for (const h of hours) {
    for (const mi of minutes) {
      // T 距当前 tick 的偏移 (分钟). tick 时刻 cst.hour:cst.minute.
      // 若 T <= tick 且 tick - T < win → tick 落在 [T, T+win) 内 → 命中.
      const curAbs = cst.hour * 60 + cst.minute;
      const tAbs = h * 60 + mi;
      const delta = curAbs - tAbs;    // >= 0 表示 T 已经过了
      if (delta < 0 || delta >= win) continue;
      // 日/周条件按 T 所属的那天判定 —— T 在今天 (delta < win <= 60,
      // 而 curAbs <= 1439, 所以 T 不会跑到昨天).
      if (!dayMatches(cst.year, cst.month, cst.dayOfMonth, cst.dayOfWeek)) continue;
      const pad = (n) => String(n).padStart(2, '0');
      return `${cst.year}${pad(cst.month)}${pad(cst.dayOfMonth)}-${pad(h)}${pad(mi)}`;
    }
  }
  return null;
}

// Build a one-line dedup key: kind + ISO ymd-hh-mm in CST. Used by the
// loop to avoid firing the same cron twice within the same minute
// (e.g. when the cadence is 1min and the cron is "* * * * *").
//
// R158.101 (2026-10-26) — **加日期**. 原实现只有 `kind:HH:MM`, 不含日期,
//   后果: 同一个进程生命周期内跨天时, 昨天 09:00 发的 key 和今天 09:00
//   的 key 完全相同 → 今天的 cron 触发会被 `lastFired.get(kind) === key`
//   误挡. 现在带日期, 跨天不会再互相误挡.
function minuteKey(kind, cst) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${kind}:${cst.year}${pad(cst.month)}${pad(cst.dayOfMonth)}-${pad(cst.hour)}:${pad(cst.minute)}`;
}

// R158.100.B+3 (2026-10-14) — catch-up 占 lastFired 用 cron 上次 fire 时刻
//   minuteKey, 不是 '__caught_up__' 字符串. 跟 5min cadence 路径
//   `lastFired.get(kind) === minuteKey` dedup 1:1 兼容.
//
//   真因: 原 `__caught_up__` 字符串, 5min cadence 5min 后 cron 9:00
//   cronMatches=true 时 `lastFired.get(kind) === 'daily:09:00'`
//   false (key 是 'daily:09:00' 不是 '__caught_up__') → 重复 fire 1 次.
//   R158.100.B+1 lesson #4 "catch-up 路径不走 minuteKey dedup" 就是这.
//   改法: catch-up fire/skip 都用 lastCronFireMinuteKey(kind, now) 占位.
//
//   weekly: 上次 cron fire = 本周一 9:00 CST (今天 >= Mon 9:00) 或
//     上周一 9:00 CST (今天 < Mon 9:00). 算 cst 0=Sun..6=Sat, Mon=1.
//   daily: 上次 cron fire = 今天 9:00 CST (now >= 9:00) 或 昨天 9:00 CST.
//
//   5min cadence 9:00 整点检测时, 已占 minuteKey=kind:09:00, skip, 不重 fire.
//
// R158.101 (2026-10-26) — **重写**. 原实现硬编码返回 `${kind}:09:00`:
//   (a) 不跟随操作员实际配的 cron 表达式 (改成 14:00 依然返回 09:00)
//   (b) 格式与 minuteKey 不一致 (老 minuteKey 是 `kind:HH:MM`, 现在是
//       `kind:YYYYMMDD-HH:MM`) → catch-up 占位 key 与真实 key 永不相等,
//       catch-up 之后 5min 内的那次 cron 触发会**重复 fire**
//   (c) 203 行的 mon9CstMs 算了却没用 (死代码)
//
//   新语义: 从 cron 表达式算出"**上一次**已经过去的 cron 触发时刻"
//   (CST, 含日期), 返回与 minuteKey 同格式的 key.
//   daily: 今天 09:00 (若已过) 否则昨天 09:00
//   weekly: 本周一 09:00 (若已过) 否则上周一 09:00
//
//   找不到候选时返回 null (表达式无法解析) —— 调用方不占 lastFired.
function lastCronFireMinuteKey(kind, now, expression) {
  const cst = nowCstComponents(now);
  const pad = (n) => String(n).padStart(2, '0');

  // 解析 cron 表达式, 取出 候选分钟 × 候选小时
  const expr = String(expression || '').trim();
  if (!expr) return null;
  const fields = expr.split(/\s+/);
  if (fields.length !== 5) return null;
  const [minF, hourF, domF, monF, dowF] = fields;
  const minutes = parseField(minF, 0, 59);
  const hours = parseField(hourF, 0, 23);
  const doms = parseField(domF, 1, 31);
  const months = parseField(monF, 1, 12);
  const dows = parseField(dowF, 0, 6, DOW_ALIASES);
  if (!minutes || !hours || !doms || !months || !dows) return null;

  const domStar = domF.trim() === '*';
  const dowStar = dowF.trim() === '*';
  // 某一天的日/月/周条件判定
  const dayMatches = (m, d, dow) => {
    if (!months.has(m)) return false;
    const domOk = doms.has(d);
    const dowOk = dows.has(dow);
    if (domStar && dowStar) return true;
    if (domStar) return dowOk;
    if (dowStar) return domOk;
    return domOk || dowOk;
  };

  // 从"今天"往回找最多 8 天 (weekly 最多回 7 天, 留 1 天余量)
  for (let back = 0; back <= 8; back++) {
    // back=0 → 今天, back=1 → 昨天 ...
    const d = new Date(Date.UTC(cst.year, cst.month - 1, cst.dayOfMonth) - back * 86400000);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const dow = d.getUTCDay();
    if (!dayMatches(m, day, dow)) continue;

    // 找这一天里"已经过去"的最晚 cron 时刻
    let best = null;
    for (const h of hours) {
      for (const mi of minutes) {
        const tAbs = h * 60 + mi;
        if (back === 0) {
          // 今天: 只有 <= 当前的时刻才算"已过去"
          if (tAbs > cst.hour * 60 + cst.minute) continue;
        }
        if (best === null || tAbs > best) best = tAbs;
      }
    }
    if (best === null) continue;
    const hh = Math.floor(best / 60);
    const mm = best % 60;
    return `${kind}:${y}${pad(m)}${pad(day)}-${pad(hh)}:${pad(mm)}`;
  }
  return null;
}

export function createReportLoop({ db, getIntervalSeconds, getSystemConfig, logger }) {
  const log = logger?.child ? logger.child({ component: 'report-loop' }) : null;
  const logInfo = (msg, meta) => {
    if (log) log.info(meta || {}, msg);
    else console.log(`[report-loop] ${msg}`);
  };
  const logError = (err, msg) => {
    if (log) log.error({ err: err?.message }, msg);
    else console.error(`[report-loop] ${msg}: ${err?.message || err}`);
  };

  let interval = null;
  let inFlight = null;
  let tickInFlight = false;
  let running = false;
  // Map<kind, lastFiredMinuteKey>. Persisted across ticks within the
  // loop's lifetime. R158.X.99.15 (2026-10-18) — 跨重启通过 hydrate lastFired
  // from report_fired_history 表实现持久化. R158.100.B+3 之前 in-memory 跨重启
  // 失效 → 每次 restart first-tick-immediately catch-up 误判 "还没发过" → 重复 fire.
  // fix: tick() 启动首拍前调 hydrateLastFiredFromDb() 从 DB 拉上次 fire 时刻占
  // lastFired, 后续 5min cadence cronMatches 路径走原 dedup 1:1 兼容.
  //
  // R158.87.4 (2026-10-12) — catch-up semantics: 进程启动后 first-tick-immediately,
  //   对每个 enabled kind 必 fire 1 次, 不依赖 cronMatches 当前 minute (R158.69.9 注释
  //   100% 错的承诺现在真正实现). 后续 5min cadence 走 cronMatches 路径, dedup 1 次/分钟.
  //
  // 历史: R158.69.9 (2026-10-11) 注释说"After a center restart at 09:00:30 the next
  //   tick at 09:01 catches the 09:00 cron; the minuteKey is '09:00' which is in the
  //   past, so it WILL fire" — 这注释 100% 错: cronMatches 用 current CST 9:01, 不匹配
  //   `0 9 * * *`, 永远 return false. R158.87.2 验证 12 行 daily_reports 0 任何 9:00 整点.
  const lastFired = new Map();

  // R158.X.99.15 (2026-10-18) — lastFired 跨重启持久化到 report_fired_history 表.
  //   schema: kind VARCHAR(16) PK + last_fired_minute_key VARCHAR(32) + last_fired_at DATETIME.
  //   hydrateLastFiredFromDb() 在 start() 第一次 tick 前调, 拉每 kind 最近 1 行
  //   占 lastFired. persistLastFiredToDb() 在 catch-up + cronMatches 路径 fire 成功后调,
  //   写 (kind, last_fired_minute_key, last_fired_at = SYSUTCDATETIME()).
  //   跨重启 catch-up dedup 闭合, 失败降级 (in-memory 仍正确, 仅跨重启 catch-up 误判).
  async function hydrateLastFiredFromDb() {
    const sql = db.dialect === 'mssql'
      ? `SELECT kind, last_fired_minute_key FROM (
           SELECT kind, last_fired_minute_key,
                  ROW_NUMBER() OVER (PARTITION BY kind ORDER BY last_fired_at DESC) AS rn
           FROM report_fired_history
         ) ranked WHERE rn = 1`
      : `SELECT t.kind, t.last_fired_minute_key FROM (
           SELECT kind, last_fired_minute_key FROM report_fired_history t1
           WHERE last_fired_at = (SELECT MAX(last_fired_at) FROM report_fired_history t2 WHERE t2.kind = t1.kind)
         ) t`;
    const { rows } = await db.query(sql);
    for (const r of rows) {
      if (r?.kind && r?.last_fired_minute_key) {
        lastFired.set(String(r.kind), String(r.last_fired_minute_key));
      }
    }
    logInfo(`hydrated lastFired from report_fired_history: ${rows.length} kind(s) (R158.X.99.15)`);
    // R158.101 (2026-10-26) — 旧格式 key 告警.
    //   老 key 格式是 `daily:09:00` (无日期), 新格式是
    //   `daily:20261024-09:00` (含日期). hydrate 出来的旧 key 跟新路径
    //   生成的 key 永不相等 —— 这**不会**造成误挡 (dedup 是等值比较,
    //   不等值就放行), 只会让"上次 fire 时刻"这个信息失效.
    //   R158.101 改了 catch-up 的门 (删掉 `!lastFired.has(kind)`), 所以
    //   hydrate 现在**不再**参与"要不要发"的判定 —— 它只提供 cron 路径的
    //   跨重启 dedup 状态 (同一天内重启不会重复触发同一个 cron 时刻).
    //   旧格式 key 因为不含日期, 挡不住今天的触发 ⇒ 第一次 fire 时会被
    //   新格式 key 覆盖 (persistLastFiredToDb 走 MERGE/UPSERT).
    const legacy = rows.filter((r) => r?.last_fired_minute_key && !/^\w+:\d{8}-/.test(String(r.last_fired_minute_key)));
    if (legacy.length) {
      logInfo(`${legacy.length} legacy-format lastFired key(s) in report_fired_history (no date) — will be replaced on next fire (R158.101)`);
    }
  }

  async function persistLastFiredToDb(kind, minuteKey) {
    const now = new Date();
    if (db.dialect === 'mssql') {
      // MERGE 1-shot: 同 kind 存在就 UPDATE, 不存在就 INSERT. 避免先 SELECT 再 INSERT 竞态.
      const sql = `MERGE report_fired_history AS tgt
        USING (SELECT ? AS kind, ? AS minute_key, ? AS fired_at) AS src
        ON tgt.kind = src.kind
        WHEN MATCHED THEN
          UPDATE SET last_fired_minute_key = src.minute_key, last_fired_at = src.fired_at
        WHEN NOT MATCHED THEN
          INSERT (kind, last_fired_minute_key, last_fired_at) VALUES (src.kind, src.minute_key, src.fired_at);`;
      await db.query(sql, [kind, minuteKey, now]);
    } else {
      const sql = `INSERT INTO report_fired_history (kind, last_fired_minute_key, last_fired_at)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE last_fired_minute_key = VALUES(last_fired_minute_key),
                                last_fired_at = VALUES(last_fired_at)`;
      await db.query(sql, [kind, minuteKey, now]);
    }
  }

  async function evaluateKind(kind) {
    const cfg = await getSystemConfig();
    const enabledKey = `report_${kind}_enabled`;
    const cronKey = `report_${kind}_cron`;
    if (String(cfg?.[enabledKey] ?? '0') !== '1') return;          // off
    const expr = String(cfg?.[cronKey] || '').trim();
    if (!expr) return;                                              // no cron set

    // R158.101 (2026-10-26) — cadence 窗口长度. cronMatchWindow 用它算
    //   触发窗口 [T, T+windowMinutes). 必须 >= 实际 tick 间隔, 否则
    //   相位不相交的老问题会重现.
    //   cadence 来源同 start(): report_loop_interval_seconds, 10s 下限.
    let windowMinutes = 5;
    try {
      const raw = await getIntervalSeconds();
      const sec = Math.max(10, Number(raw) || 300);
      windowMinutes = Math.max(1, Math.ceil(sec / 60));
    } catch (e) {
      logError(e, `${kind} failed to read cadence; falling back to 5min window`);
    }

    // R158.87.4 catch-up (2026-10-12) — 进程启动后第一次 tick (first-tick-immediately)
    //   如果 lastFired 没有这个 kind 的记录, 必 fire 1 次, 不依赖 cronMatches 当前 minute.
    //   R158.69.9 注释 (line 169-175) 说"should fire"但代码 100% 没实现 — 现在实现.
    //   后续 5min cadence 走原 cronMatches 路径.
    //
    // R158.101 (2026-10-26) — **删掉 `!lastFired.has(kind)` 这道前置门**.
    //   真因: 这道门是 R158.87.4 时代 (还没有 DB dedup) 加的防重复门. 后来
    //   R158.100.B+3 加了**更准确**的 DB dedup (查报告窗口内有没有发过), 但
    //   这道前置门**留在外面**, 变成纯粹的阻塞:
    //     hydrateLastFiredFromDb() 会把历史 lastFired 灌进来 (哪怕是几个月前
    //     的旧 key) → lastFired.has(kind) 永远为 true → catch-up 永远走不到
    //     DB dedup → **catch-up 永久死锁**.
    //   后果: 10-24/10-25/10-26 连续 3 天漏发日报 —— 因为 10-23 09:21 那次
    //   已经 hydrate 过 daily, 之后**任何**重启都不会再补发, 哪怕今天一封
    //   都没发过.
    //   修法: catch-up **总是尝试**, 由 DB dedup 决定发不发. DB dedup 查的是
    //   **今天的报告窗口** (daily = 今天 00:00~24:00 CST), 所以"今天已发过
    //   就跳过"这个判据是准确的, 且天然防重复 —— 不需要前置门.
    //   注意: 下面的 DB dedup 查询失败时 (catch 分支) 走 fire 路径, 那是
    //   best-effort 降级, 跟修复前行为一致.
    {
      // R158.100.B+3 (2026-10-14) — catch-up DB-level dedup. 查 daily_reports
      //   窗内是否已有同 kind run, 有就 skip (避免重启放大 1 天 N 次
      //   daily/weekly). 跟 5min cadence 路径独立 (下面走 cronMatchWindow
      //   + fireKey). 失败降级到原 fire 路径 (best-effort dedup).
      //
      //   R158.101 — catch-up 占的 lastFired key 现在跟 minuteKey **同格式**
      //   (含日期), 且从**实际 cron 表达式**推导, 不再硬编码 09:00.
      //   这修掉了 R158.100.B+1 #4 的根因: 老 key 是 `daily:09:00`,
      //   而 5min cadence 路径的 key 是 `daily:20261024-09:03` 之类 → 永不
      //   相等 → catch-up 之后的那次 cron 触发会**重复 fire**.
      const lastFireKey = lastCronFireMinuteKey(kind, new Date(), expr);
      try {
        const { windowStartUtc, windowEndUtc } = getReportWindow(kind);
        const sqlHelper = db.sql.reportRun.countByKindInWindow[db.dialect];
        const { rows } = await db.query(sqlHelper, [kind, windowStartUtc, windowEndUtc]);
        const n = Number(rows?.[0]?.n ?? 0);
        if (n > 0) {
          if (lastFireKey) lastFired.set(kind, lastFireKey);
          logInfo(`catch-up skip ${kind}: ${n} existing run(s) in window (R158.100.B+3, cron='${expr}')`);
          return;
        }
      } catch (e) {
        logError(e, `${kind} catch-up dedup query failed; falling through to fire (R158.100.B+3)`);
        // 失败不阻塞: 走原 fire 路径 (best-effort dedup)
      }
      // R158.100.B+3 — catch-up fire 后占 cron 上次 fire 时刻 minuteKey,
      //   5min cadence 5min 后 cron 9:00 cronMatches=true 时 key 已占, skip.
      if (lastFireKey) lastFired.set(kind, lastFireKey);
      logInfo(`catch-up firing ${kind} report on first tick (R158.87.4, cron='${expr}')`);
      try {
        const r = await enqueueReport(kind);
        if (r.ok) {
          // R158.X.99.15 — catch-up fire 成功后持久化 lastFired 时刻到 DB
          //   (走 cron 上次 fire minuteKey = 'daily:09:00' / 'weekly:09:00'),
          //   下次 center restart hydrateLastFiredFromDb() 拉回 lastFired,
          //   避免重启后 first-tick-immediately catch-up 重复 fire.
          if (lastFireKey) {
            persistLastFiredToDb(kind, lastFireKey).catch((e) =>
              logError(e, `${kind} catch-up persist lastFired failed (R158.X.99.15)`));
          }
          logInfo(`${kind} catch-up enqueued`, { runId: r.runId, outboxId: r.outboxId, htmlSize: r.htmlSize });
        }
        else logError(new Error(r.error || 'unknown'), `${kind} catch-up enqueue failed`);
      } catch (e) {
        logError(e, `${kind} catch-up threw`);
      }
      return;  // first tick 跑完 catch-up, 不再走 cronMatches (避免同分钟双发)
    }

    // R158.101 (2026-10-26) — **核心修复路径**: 窗口匹配代替精确分钟匹配.
    //   老代码: cronMatches(expr, cst) 要求 tick 的分钟**精确等于** cron
    //   分钟, 而 tick 是 5min 离散采样 → 80% 的相位永远不相交 → cron 路径
    //   从来没生效过 (21 天日志 0 命中 "firing daily report").
    //   新代码: cronMatchWindow 返回"本次 tick 覆盖的是哪个 cron 时刻",
    //   窗口 = [T, T+windowMinutes). 任何相位下 T 必被恰好一个 tick 覆盖.
    const cst = nowCstComponents();
    const fireKey = cronMatchWindow(expr, cst, windowMinutes);
    if (!fireKey) return;                                           // 不在任何窗口内
    // dedup key 用 **cron 时刻** (fireKey), 不是 tick 时刻 —— 同一 cron
    // 时刻的多个 tick (窗口内可能有多个) 只 fire 一次.
    const key = `${kind}:${fireKey}`;
    if (lastFired.get(kind) === key) return;                        // dedup this fire time
    lastFired.set(kind, key);
    logInfo(`firing ${kind} report (cron='${expr}', cst=${cst.hour}:${String(cst.minute).padStart(2,'0')}, fire=${fireKey})`);
    try {
      const r = await enqueueReport(kind);
      if (!r.ok) {
        logError(new Error(r.error || 'unknown'), `${kind} enqueue failed`);
        // Mark the run as failed in daily_reports so the operator can see
        // it in the history table. We don't have a runId on failure, so
        // just log — the history is best-effort.
      } else {
        // R158.X.99.15 — cronMatches 路径 fire 成功后持久化 lastFired 时刻
        //   (用 cron current minute key, 跟 in-memory lastFired.set 一致).
        //   下次 center restart hydrateLastFiredFromDb() 拉回 lastFired, 跨重启
        //   catch-up dedup 闭合. 失败降级 (in-memory 已 set, 5min cadence 单重启
        //   周期内仍 dedup 正确).
        persistLastFiredToDb(kind, key).catch((e) =>
          logError(e, `${kind} persist lastFired failed (R158.X.99.15)`));
        logInfo(`${kind} enqueued`, { runId: r.runId, outboxId: r.outboxId, htmlSize: r.htmlSize });
      }
    } catch (e) {
      logError(e, `${kind} enqueue threw`);
    }
  }

  async function tick() {
    if (tickInFlight) {
      logError(new Error('previous tick still in flight'), 'tick skipped');
      return;
    }
    tickInFlight = true;
    try {
      for (const kind of REPORT_KINDS) {
        try {
          await evaluateKind(kind);
        } catch (e) {
          // One kind's failure (e.g. transient DB error reading cron) must
          // not abort the other kind.
          logError(e, `evaluateKind(${kind}) failed`);
        }
      }
    } finally {
      tickInFlight = false;
    }
  }

  function start() {
    if (running) return;
    running = true;
    Promise.resolve(getIntervalSeconds()).then((raw) => {
      if (!running) return;
      const intervalSec = Math.max(10, Number(raw) || 300);
      logInfo(`report loop started, ${intervalSec}s cadence, firing first tick immediately (R158.87.4)`);
      // R158.X.99.15 (2026-10-18) — first tick 前 hydrate lastFired from
      //   report_fired_history 表. 跨重启保留 catch-up dedup state. 失败降级
      //   到 in-memory 空, 走原 catch-up fire 路径 (best-effort, 跟 R158.100.B+3
      //   `countByKindInWindow` dedup 1:1 兜底).
      hydrateLastFiredFromDb().catch((e) => logError(e, 'hydrate lastFired from db failed; falling back to in-memory (R158.X.99.15)'));
      interval = setInterval(() => {
        inFlight = tick().catch((e) => logError(e, 'tick failed'));
      }, intervalSec * 1000);
      // R158.87.4 (2026-10-12) — first tick immediately, mirror R158.60.23 directory-sync precedent.
      //   否则 5min cadence 永远抓不到 cron 整点触发 (8:54 boot 之后 first tick 必等 5min = 8:59).
      //   配合 evaluateKind 内 catch-up 逻辑, 进程启动后必 catch-up fire 1 次任何 enabled kind.
      inFlight = tick().catch((e) => logError(e, 'first tick failed'));
    }).catch((e) => logError(e, 'start failed'));
  }

  async function stop() {
    running = false;
    if (interval) clearInterval(interval);
    interval = null;
    if (inFlight) await inFlight.catch(() => {});
    inFlight = null;
  }

  return { start, stop, tick, isRunning: () => running };
}

// Exported for unit tests. Not used by the loop directly.
// R158.100.B+3 (2026-10-14) — module-level export 给 diag 用. 跟 enqueueReport
//   平级, 单独 export 是因为这是 pure helper, 0 副作用, 0 依赖 enqueueReport.
export { getReportWindow };

export const __test = {
  parseField, cronMatches, cronMatchWindow, nowCstComponents, minuteKey,
  getReportWindow, lastCronFireMinuteKey, DOW_ALIASES
};
