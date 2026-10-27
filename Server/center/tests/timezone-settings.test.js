// center/tests/timezone-settings.test.js
// R161.11 (2026-10-26) — 显示时区的单一真源: 前后端一致 + 迁移无回归 + 漂移守卫
//
// ★ 背景 (R161.10 现场事故, 操作员原话):
//     「复制 Agent 令牌 #41 · admin · 2026/10/27 05:03:03」
//     「payload revealedAt: "2026-10-26T13:03:03.035Z"」
//     「这时间计算的明显的不对啊」
//   同一行审计记录, 界面时间比 payload 里的真 UTC 时刻**晚了 8 小时**,
//   而界面**零提示**。
//   存储层已由 pinSessionUtc 修掉 (R161.10: 每条连接 SET time_zone='+00:00');
//   **渲染层**由本文件锁死:
//     1. 前后端两份纯函数副本必须**逐格一致** (后端是权威, 前端是它的镜像);
//     2. 全站时间戳渲染必须走显示时区, 不许再写死 "+8h";
//     3. 迁移**不许改变**默认时区下的显示结果 (无视觉回归) —— 否则操作员会
//        以为"一次更新把时间显示改坏了", 而真相是"时区现在可配了"。
//
// ★ 为什么要"两份副本 + 一个锁它们的测试" (跟 feature-flag-semantics 同一套路):
//   后端 src/services/timezone.js 与前端 web/src/lib/timezone.js 是**两个文件**
//   (Node 端不能 import 浏览器 bundle 里的模块, 浏览器端也不能 import 后端
//   依赖 fs 的模块)。副本必然有漂移风险 ⇒ 用一份 VALUE_MATRIX 把两份实现
//   逐格比对, 谁改了语义, 这条测试立刻红。
//
// 用法: cd Server/center && node --test tests/timezone-settings.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DISPLAY_TIMEZONE_KEY,
  DEFAULT_DISPLAY_TIMEZONE as SERVER_DEFAULT_TIMEZONE,
  STORAGE_CONTRACT,
  COMMON_TIMEZONES as SERVER_COMMON_TIMEZONES,
  isValidTimeZone as serverIsValidTimeZone,
  normalizeDisplayTimeZone as serverNormalizeTimeZone,
  offsetMinutesFor as serverOffsetMinutesFor,
  listSupportedTimeZones as serverListSupportedTimeZones,
  normalizeSqlTimestamp,
  readServerClock,
  decodeSystemTimeZoneName,
  MYSQL_CLOCK_SQL,
  MSSQL_CLOCK_SQL,
  UNKNOWN_TIME_ZONE
} from '../src/services/timezone.js';

import {
  DEFAULT_DISPLAY_TIMEZONE as WEB_DEFAULT_TIMEZONE,
  COMMON_TIMEZONES as WEB_COMMON_TIMEZONES,
  isValidTimeZone as webIsValidTimeZone,
  normalizeDisplayTimeZone as webNormalizeTimeZone,
  offsetMinutesFor as webOffsetMinutesFor,
  listSupportedTimeZones as webListSupportedTimeZones,
  parseTimestamp,
  formatDateTime,
  formatDateTimeIso,
  formatDateTimeMs,
  formatDateOnly,
  formatTimeOnly,
  setDisplayTimezone,
  applyServerTimezone,
  getDisplayTimezone,
  subscribeDisplayTimezone
} from '../web/src/lib/timezone.js';

import { stripJsComments } from './helpers/strip-comments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = path.resolve(HERE, '..');
const WEB_SRC = path.join(CENTER_ROOT, 'web', 'src');

// ---------------------------------------------------------------------------
// 迁移前的"硬编码 +8"实现 (逐字摘自 git HEAD 的旧代码) —— 用作**参照系**。
//
// ★ 为什么把它们抄进测试而不是去 git 里取:
//   1. 参照系必须**冻结**: 旧代码随时会被删掉 (lib/time.js 本次已经删了),
//      测试不能依赖一个还在变的历史分支;
//   2. 抄进来本身就是"迁移前的显示契约"的书面化 —— 哪一列该长什么样,
//      一目了然, 下一个改渲染的人能直接对照。
//
// ★ 这几段是**故意**保留 +8 硬编码的: 它们是参照物, 不是生产代码。
//   漂移守卫 (F 组) 只扫 web/src, 不扫 tests/。
// ---------------------------------------------------------------------------

/** 旧 lib/time.js 的 fmtTsCstMs — 'MM-DD HH:mm:ss.SSS' (UTC+8)。 */
function oldFmtTsCstMs(t) {
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return '';
  const cstMs = d.getTime() + 8 * 3600_000;
  const cst = new Date(cstMs);
  const MM = String(cst.getUTCMonth() + 1).padStart(2, '0');
  const DD = String(cst.getUTCDate()).padStart(2, '0');
  const hh = String(cst.getUTCHours()).padStart(2, '0');
  const mm = String(cst.getUTCMinutes()).padStart(2, '0');
  const ss = String(cst.getUTCSeconds()).padStart(2, '0');
  const mmm = String(cst.getUTCMilliseconds()).padStart(3, '0');
  return `${MM}-${DD} ${hh}:${mm}:${ss}.${mmm}`;
}

/** 旧 FailedLogonView/OsBaselineView/DashboardView 的 fmtTsCst — 'HH:mm' (UTC+8)。 */
function oldFmtTsCst(t) {
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return '';
  const cstH = (d.getUTCHours() + 8) % 24;
  const cstM = d.getUTCMinutes();
  return `${String(cstH).padStart(2, '0')}:${String(cstM).padStart(2, '0')}`;
}

/** 旧 fmtBucketCst — 'MM-DD HH:mm' (UTC+8)。 */
function oldFmtBucketCst(t) {
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return '';
  const cstMs = d.getTime() + 8 * 3600 * 1000;
  const cst = new Date(cstMs);
  const MM = String(cst.getUTCMonth() + 1).padStart(2, '0');
  const DD = String(cst.getUTCDate()).padStart(2, '0');
  const hh = String(cst.getUTCHours()).padStart(2, '0');
  const mm = String(cst.getUTCMinutes()).padStart(2, '0');
  return `${MM}-${DD} ${hh}:${mm}`;
}

/** 旧 fmtDateCst — 'MM-DD' (UTC+8)。 */
function oldFmtDateCst(t) {
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return '';
  const cstMs = d.getTime() + 8 * 3600 * 1000;
  const cst = new Date(cstMs);
  const MM = String(cst.getUTCMonth() + 1).padStart(2, '0');
  const DD = String(cst.getUTCDate()).padStart(2, '0');
  return `${MM}-${DD}`;
}

/**
 * 旧 collectedAtIsoText — 'YYYY-MM-DD HH:mm:ss'。
 *
 * ★ 旧实现用的是**浏览器本地**时间 (getFullYear/getMonth/...), 所以它
 *   严格说不是"固定 +8" —— 但本部署的操作员机器就是 CST, 旧界面上显示的
 *   就是 UTC+8 墙上时间。⇒ 这里按 UTC+8 复刻, 作为"迁移前的显示契约"。
 */
function oldCollectedAtIsoText(t) {
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return '';
  const cst = new Date(d.getTime() + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${cst.getUTCFullYear()}-${pad(cst.getUTCMonth() + 1)}-${pad(cst.getUTCDate())} ${pad(cst.getUTCHours())}:${pad(cst.getUTCMinutes())}:${pad(cst.getUTCSeconds())}`;
}

// 测试用时间戳 (全部是 ISO-Z —— 后端 R161.10 之后的返回形态)。
const TS_MATRIX = [
  '2026-10-26T13:03:03.035Z',   // 现场那条 (CST 21:03:03)
  '2026-01-15T00:00:00.000Z',   // 冬 (CST 08:00)
  '2026-07-15T00:00:00.000Z',   // 夏 (CST 08:00)
  '2026-10-26T15:59:59.999Z',   // 跨日边界前一秒 (CST 23:59:59)
  '2026-10-26T16:00:00.000Z',   // 跨日边界 (CST 次日 00:00:00)
  '2026-12-31T23:00:00.000Z',   // 年末
  '2026-03-08T10:00:00.000Z',   // 柏林夏令时切换日
  '2020-02-29T12:00:00.000Z'    // 闰日
];

// ---------------------------------------------------------------------------
// A. 前后端纯函数逐格一致 (漂移守卫)
// ---------------------------------------------------------------------------

const VALIDITY_MATRIX = [
  'Asia/Shanghai',
  '  Asia/Shanghai  ',        // 两端空白 ⇒ 合法 (trim)
  'UTC',
  'Europe/Berlin',
  'America/New_York',
  'Asia/Kolkata',
  'Etc/GMT+8',
  '',                          // 空串 ⇒ 非法
  '   ',                       // 全空白 ⇒ 非法
  'GMT+8',                     // 固定偏移串 ⇒ 非法 (无 DST 语义)
  '+08:00',                    // 同上
  'Asia/Shanghai ',            // 尾部空白 ⇒ 合法
  'Not/AZone',                 // 乱写 ⇒ 非法
  'Asia/Nowhere',              // 合法形状但不存在 ⇒ 非法
  null,
  undefined,
  123,
  480,
  {},
  []
];

const OFFSET_MATRIX = [
  ['Asia/Shanghai', '2026-01-15T00:00:00.000Z'],
  ['Asia/Shanghai', '2026-07-15T00:00:00.000Z'],
  ['Europe/Berlin', '2026-01-15T00:00:00.000Z'],
  ['Europe/Berlin', '2026-07-15T00:00:00.000Z'],
  ['Europe/London', '2026-01-15T00:00:00.000Z'],
  ['Europe/London', '2026-07-15T00:00:00.000Z'],
  ['America/New_York', '2026-01-15T00:00:00.000Z'],
  ['America/New_York', '2026-07-15T00:00:00.000Z'],
  ['UTC', '2026-10-26T13:03:03.035Z'],
  ['Asia/Kolkata', '2026-10-26T13:03:03.035Z'],
  ['Not/AZone', '2026-10-26T13:03:03.035Z']   // 非法 ⇒ 回落 UTC
];

describe('A. 前后端时区纯函数逐格一致', () => {
  test('isValidTimeZone — 两份实现对同一批输入给出同一答案', () => {
    for (const value of VALIDITY_MATRIX) {
      assert.equal(
        webIsValidTimeZone(value),
        serverIsValidTimeZone(value),
        `isValidTimeZone(${JSON.stringify(value)}) 前后端不一致`
      );
    }
  });

  test('normalizeDisplayTimeZone — 两份实现对同一批输入给出同一答案', () => {
    for (const value of VALIDITY_MATRIX) {
      assert.equal(
        webNormalizeTimeZone(value),
        serverNormalizeTimeZone(value),
        `normalizeDisplayTimeZone(${JSON.stringify(value)}) 前后端不一致`
      );
    }
  });

  test('offsetMinutesFor — 两份实现对同一批 (时区, 时刻) 给出同一答案', () => {
    for (const [tz, iso] of OFFSET_MATRIX) {
      const at = new Date(iso);
      assert.equal(
        webOffsetMinutesFor(tz, at),
        serverOffsetMinutesFor(tz, at),
        `offsetMinutesFor(${tz}, ${iso}) 前后端不一致`
      );
    }
  });

  test('默认时区 / 常用时区清单 / 存储契约 — 前后端必须一致', () => {
    assert.equal(WEB_DEFAULT_TIMEZONE, SERVER_DEFAULT_TIMEZONE);
    assert.equal(WEB_DEFAULT_TIMEZONE, 'Asia/Shanghai');
    assert.deepEqual(WEB_COMMON_TIMEZONES, SERVER_COMMON_TIMEZONES);
    assert.equal(STORAGE_CONTRACT, 'UTC');
    assert.equal(DISPLAY_TIMEZONE_KEY, 'app_display_timezone');
  });

  test('时区清单 — 前后端都能列出完整 IANA 清单 (本仓 Node 带 full ICU)', () => {
    const serverList = serverListSupportedTimeZones();
    const webList = webListSupportedTimeZones();
    assert.ok(serverList.length > 400, `服务端时区清单过短: ${serverList.length}`);
    assert.deepEqual(webList, serverList, '前后端时区清单不一致');
    assert.ok(webList.includes('Asia/Shanghai'));
    assert.ok(webList.includes('UTC'));
  });

  test('合法性判定 — 固定偏移串一律拒绝, IANA 名一律接受', () => {
    for (const bad of ['', '   ', 'GMT+8', '+08:00', 'UTC+8', 'Asia/Shanghai+8', 'Not/AZone']) {
      assert.equal(serverIsValidTimeZone(bad), false, `${bad} 应被拒绝`);
      assert.equal(webIsValidTimeZone(bad), false, `${bad} 应被拒绝`);
    }
    for (const good of ['UTC', 'Asia/Shanghai', 'Europe/Berlin', 'America/New_York']) {
      assert.equal(serverIsValidTimeZone(good), true, `${good} 应被接受`);
      assert.equal(webIsValidTimeZone(good), true, `${good} 应被接受`);
    }
    // 非字符串一律拒绝 (配置里存了数字/对象不能让整页挂掉)。
    for (const bad of [null, undefined, 123, 480, {}, [], true]) {
      assert.equal(serverIsValidTimeZone(bad), false);
      assert.equal(webIsValidTimeZone(bad), false);
    }
  });

  test('规整 — 非法值回落默认时区, 合法值原样 (含 trim)', () => {
    assert.equal(serverNormalizeTimeZone('  Europe/Berlin '), 'Europe/Berlin');
    assert.equal(webNormalizeTimeZone('  Europe/Berlin '), 'Europe/Berlin');
    assert.equal(serverNormalizeTimeZone('GMT+8'), 'Asia/Shanghai');
    assert.equal(webNormalizeTimeZone('GMT+8'), 'Asia/Shanghai');
    assert.equal(serverNormalizeTimeZone(null), 'Asia/Shanghai');
    assert.equal(webNormalizeTimeZone(null), 'Asia/Shanghai');
  });
});

// ---------------------------------------------------------------------------
// B. 偏移量 (含 DST) 必须算对
// ---------------------------------------------------------------------------

describe('B. 偏移量计算 (含夏令时)', () => {
  const CASES = [
    ['Asia/Shanghai', '2026-01-15T00:00:00.000Z', 480],   // 中国无 DST, 全年 +8
    ['Asia/Shanghai', '2026-07-15T00:00:00.000Z', 480],
    ['Europe/Berlin', '2026-01-15T00:00:00.000Z', 60],    // 冬令时 +1
    ['Europe/Berlin', '2026-07-15T00:00:00.000Z', 120],   // 夏令时 +2
    ['Europe/London', '2026-01-15T00:00:00.000Z', 0],     // 冬令时 +0
    ['Europe/London', '2026-07-15T00:00:00.000Z', 60],    // 夏令时 +1
    ['America/New_York', '2026-01-15T00:00:00.000Z', -300],
    ['America/New_York', '2026-07-15T00:00:00.000Z', -240],
    ['UTC', '2026-10-26T13:03:03.035Z', 0],
    ['Asia/Kolkata', '2026-10-26T13:03:03.035Z', 330]
  ];

  for (const [tz, iso, expected] of CASES) {
    test(`${tz} @ ${iso} ⇒ ${expected} 分钟`, () => {
      const at = new Date(iso);
      assert.equal(serverOffsetMinutesFor(tz, at), expected, '后端算错');
      assert.equal(webOffsetMinutesFor(tz, at), expected, '前端算错');
    });
  }

  test('非法时名 ⇒ 回落 UTC (偏移 0), 不抛错', () => {
    const at = new Date('2026-10-26T13:03:03.035Z');
    assert.equal(serverOffsetMinutesFor('Not/AZone', at), 0);
    assert.equal(webOffsetMinutesFor('Not/AZone', at), 0);
  });
});

// ---------------------------------------------------------------------------
// C. 存储契约: naive 时间戳按 UTC 解释
// ---------------------------------------------------------------------------

describe('C. 存储契约 = UTC (naive 形态按 UTC 解释, 不按浏览器本地)', () => {
  test('parseTimestamp — naive 形态按 UTC', () => {
    const d = parseTimestamp('2026-10-26 13:03:03');
    assert.ok(d instanceof Date);
    assert.equal(d.toISOString(), '2026-10-26T13:03:03.000Z');
    const d2 = parseTimestamp('2026-10-26T13:03:03');
    assert.equal(d2.toISOString(), '2026-10-26T13:03:03.000Z');
  });

  test('parseTimestamp — 带 Z / 偏移的形态按其自带时区', () => {
    assert.equal(parseTimestamp('2026-10-26T13:03:03.035Z').toISOString(), '2026-10-26T13:03:03.035Z');
    assert.equal(parseTimestamp('2026-10-26T21:03:03+08:00').toISOString(), '2026-10-26T13:03:03.000Z');
  });

  test('parseTimestamp — 非法输入返回 null (不抛错)', () => {
    for (const bad of [null, undefined, '', '   ', 'not-a-date', {}, []]) {
      assert.equal(parseTimestamp(bad), null, `${JSON.stringify(bad)} 应解析为 null`);
    }
  });

  test('normalizeSqlTimestamp (后端) — naive 形态同样按 UTC', () => {
    assert.equal(normalizeSqlTimestamp('2026-10-26 13:03:03'), '2026-10-26T13:03:03.000Z');
    assert.equal(normalizeSqlTimestamp('2026-10-26T13:03:03'), '2026-10-26T13:03:03.000Z');
    assert.equal(normalizeSqlTimestamp(new Date('2026-10-26T13:03:03.035Z')), '2026-10-26T13:03:03.035Z');
    assert.equal(normalizeSqlTimestamp(null), null);
    assert.equal(normalizeSqlTimestamp(''), null);
  });
});

// ---------------------------------------------------------------------------
// D. 无视觉回归: 默认时区下, 新 formatter 必须与旧硬编码 +8 逐字相同
// ---------------------------------------------------------------------------

describe('D. 无视觉回归 (默认时区 Asia/Shanghai 下, 新旧输出必须逐字相同)', () => {
  test('formatTimeOnly {withSeconds:false} ≡ 旧 fmtTsCst', () => {
    for (const ts of TS_MATRIX) {
      assert.equal(
        formatTimeOnly(ts, { withSeconds: false, timeZone: 'Asia/Shanghai', fallback: '' }),
        oldFmtTsCst(ts),
        `formatTimeOnly(${ts}) 与旧 fmtTsCst 不一致`
      );
    }
  });

  test('formatDateTimeMs ≡ 旧 fmtTsCstMs', () => {
    for (const ts of TS_MATRIX) {
      assert.equal(
        formatDateTimeMs(ts, { timeZone: 'Asia/Shanghai', fallback: '' }),
        oldFmtTsCstMs(ts),
        `formatDateTimeMs(${ts}) 与旧 fmtTsCstMs 不一致`
      );
    }
  });

  test('formatDateTimeIso {withYear:false,withSeconds:false} ≡ 旧 fmtBucketCst', () => {
    for (const ts of TS_MATRIX) {
      assert.equal(
        formatDateTimeIso(ts, { withYear: false, withSeconds: false, timeZone: 'Asia/Shanghai', fallback: '' }),
        oldFmtBucketCst(ts),
        `formatDateTimeIso(${ts}) 与旧 fmtBucketCst 不一致`
      );
    }
  });

  test('formatDateOnly {withYear:false} ≡ 旧 fmtDateCst', () => {
    for (const ts of TS_MATRIX) {
      assert.equal(
        formatDateOnly(ts, { withYear: false, timeZone: 'Asia/Shanghai', fallback: '' }),
        oldFmtDateCst(ts),
        `formatDateOnly(${ts}) 与旧 fmtDateCst 不一致`
      );
    }
  });

  test('formatDateTimeIso (完整形态) ≡ 旧 collectedAtIsoText', () => {
    for (const ts of TS_MATRIX) {
      assert.equal(
        formatDateTimeIso(ts, { timeZone: 'Asia/Shanghai', fallback: '' }),
        oldCollectedAtIsoText(ts),
        `formatDateTimeIso(${ts}) 与旧 collectedAtIsoText 不一致`
      );
    }
  });

  test('现场那条审计记录的显示结果 (R161.10 的原始诉求)', () => {
    const ts = '2026-10-26T13:03:03.035Z';
    assert.equal(formatDateTimeIso(ts, { timeZone: 'Asia/Shanghai' }), '2026-10-26 21:03:03');
    assert.equal(formatDateTimeIso(ts, { withYear: false, withSeconds: false, timeZone: 'Asia/Shanghai' }), '10-26 21:03');
    assert.equal(formatTimeOnly(ts, { withSeconds: false, timeZone: 'Asia/Shanghai' }), '21:03');
    assert.equal(formatDateTimeMs(ts, { timeZone: 'Asia/Shanghai' }), '10-26 21:03:03.035');
    assert.equal(formatDateOnly(ts, { withYear: false, timeZone: 'Asia/Shanghai' }), '10-26');
    assert.equal(formatDateTime(ts, { timeZone: 'Asia/Shanghai' }), '2026/10/26 21:03:03');
  });
});

// ---------------------------------------------------------------------------
// E. 换显示时区后, 渲染必须跟着走 (证明没有写死 +8)
// ---------------------------------------------------------------------------

describe('E. 显示时区可配 (换时区 ⇒ 渲染跟着换, 不是写死 +8)', () => {
  test('默认显示时区是 Asia/Shanghai (与后端默认值一致)', () => {
    assert.equal(getDisplayTimezone(), 'Asia/Shanghai');
  });

  test('切到 Europe/Berlin 后, 同一时间戳渲染成柏林墙上时间', () => {
    try {
      applyServerTimezone('Europe/Berlin');
      assert.equal(getDisplayTimezone(), 'Europe/Berlin');
      // ★ 欧盟夏令时 2026-10-25 结束 ⇒ 10-26 已经是 CET (+1) ⇒ 14:03
      assert.equal(formatDateTimeIso('2026-10-26T13:03:03.035Z'), '2026-10-26 14:03:03');
      assert.equal(formatTimeOnly('2026-10-26T13:03:03.035Z', { withSeconds: false }), '14:03');
      // 夏令时期间 (7 月) = CEST (+2) ⇒ 15:03
      assert.equal(formatDateTimeIso('2026-07-15T13:03:03.035Z'), '2026-07-15 15:03:03');
      // 冬令时 (1 月) = CET (+1) ⇒ 14:03
      assert.equal(formatDateTimeIso('2026-01-15T13:03:03.035Z'), '2026-01-15 14:03:03');
    } finally {
      applyServerTimezone('Asia/Shanghai');
    }
  });

  test('切到 America/New_York 后, 同一时间戳渲染成纽约墙上时间', () => {
    try {
      applyServerTimezone('America/New_York');
      const ts = '2026-10-26T13:03:03.035Z';
      // 2026-10-26 纽约 = EDT (-4) ⇒ 09:03
      assert.equal(formatDateTimeIso(ts), '2026-10-26 09:03:03');
    } finally {
      applyServerTimezone('Asia/Shanghai');
    }
  });

  test('setDisplayTimezone 对非法值回落默认, 对合法值原样生效', () => {
    try {
      assert.equal(setDisplayTimezone('Not/AZone', { persist: false }), 'Asia/Shanghai');
      assert.equal(setDisplayTimezone('Europe/Berlin', { persist: false }), 'Europe/Berlin');
      assert.equal(getDisplayTimezone(), 'Europe/Berlin');
    } finally {
      setDisplayTimezone('Asia/Shanghai', { persist: false });
    }
  });

  test('setDisplayTimezone 会通知订阅者 (页面能跟着变)', () => {
    const seen = [];
    const unsubscribe = subscribeDisplayTimezone((tz) => seen.push(tz));
    try {
      setDisplayTimezone('Europe/Berlin', { persist: false });
    } finally {
      unsubscribe();
      setDisplayTimezone('Asia/Shanghai', { persist: false });
    }
    assert.deepEqual(seen, ['Europe/Berlin']);
  });
});

// ---------------------------------------------------------------------------
// F. 漂移守卫: web/src 里不许再出现固定偏移 / 本地时区渲染
// ---------------------------------------------------------------------------

function collectSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full));
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.vue'))) {
      out.push(full);
    }
  }
  return out;
}

// ★ 有意保留本地日历日的**唯一**例外: 许可证页的 formatYmd。
//   理由写在该文件里 (业务日期 vs 时刻), 见 R161.11 注释。
const LOCAL_CALENDAR_ALLOWLIST = new Set([
  path.join('views', 'admin', 'systemSettings', 'LicenseView.vue')
]);

describe('F. 漂移守卫 (web/src 里不许再写死 +8 / 用本地时区渲染时间戳)', () => {
  const files = collectSourceFiles(WEB_SRC);

  test('扫描面非空 (守卫本身不许空转)', () => {
    assert.ok(files.length > 40, `只扫到 ${files.length} 个文件, 扫描面不对`);
  });

  test('不许再出现硬编码的 +8 小时偏移', () => {
    const offenders = [];
    for (const file of files) {
      const code = stripJsComments(readFileSync(file, 'utf8'));
      if (/\b8\s*\*\s*3600/.test(code) || /getUTCHours\(\)\s*\+\s*8/.test(code)) {
        offenders.push(path.relative(WEB_SRC, file));
      }
    }
    assert.deepEqual(offenders, [],
      `这些文件里还有硬编码 +8 偏移 —— 显示时区改成别的就会错: ${offenders.join(', ')}`);
  });

  test('不许再用 toLocaleString / toLocaleTimeString / toLocaleDateString 渲染时间戳', () => {
    const offenders = [];
    for (const file of files) {
      const code = stripJsComments(readFileSync(file, 'utf8'));
      if (/toLocale(String|TimeString|DateString)\s*\(/.test(code)) {
        offenders.push(path.relative(WEB_SRC, file));
      }
    }
    assert.deepEqual(offenders, [],
      `这些文件还在用 toLocale* 渲染时间戳 (跟着浏览器时区走 ⇒ 换机器就错): ${offenders.join(', ')}`);
  });

  test('不许再手搓 getFullYear/getMonth/getDate 取墙上时间 (许可证页除外)', () => {
    const offenders = [];
    for (const file of files) {
      const rel = path.relative(WEB_SRC, file);
      if (LOCAL_CALENDAR_ALLOWLIST.has(rel)) continue;
      const code = stripJsComments(readFileSync(file, 'utf8'));
      if (/getFullYear\s*\(/.test(code) || /getMonth\s*\(/.test(code) || /getDate\s*\(/.test(code)) {
        offenders.push(rel);
      }
    }
    assert.deepEqual(offenders, [],
      `这些文件还在手搓本地日历时间: ${offenders.join(', ')}`);
  });

  test('许可证页的例外必须带 R161.11 说明 (免得后人当漏改的 bug 又改一遍)', () => {
    const rel = path.join('views', 'admin', 'systemSettings', 'LicenseView.vue');
    const file = path.join(WEB_SRC, rel);
    assert.ok(existsSync(file), `许可证页不存在: ${rel}`);
    const raw = readFileSync(file, 'utf8');
    assert.match(raw, /R161\.11/, '许可证页必须写明 R161.11 的例外理由');
    assert.match(raw, /有意不走 lib\/timezone\.js|故意/, '必须写明这是有意为之, 不是漏改');
  });

  test('已删除的 lib/time.js 不得复活 (它就是那个写死 +8 的模块)', () => {
    assert.equal(existsSync(path.join(WEB_SRC, 'lib', 'time.js')), false,
      'lib/time.js 已被 lib/timezone.js 取代, 不许复活');
  });

  test('lib/timezone.js 存在且导出全站渲染入口', () => {
    const file = path.join(WEB_SRC, 'lib', 'timezone.js');
    assert.ok(existsSync(file), '缺少 lib/timezone.js');
    const raw = readFileSync(file, 'utf8');
    for (const fn of [
      'formatDateTime', 'formatDateTimeIso', 'formatDateTimeMs',
      'formatDateOnly', 'formatTimeOnly', 'parseTimestamp',
      'getDisplayTimezone', 'setDisplayTimezone', 'applyServerTimezone'
    ]) {
      assert.match(raw, new RegExp(`export function ${fn}\\b`), `lib/timezone.js 缺少导出 ${fn}`);
    }
  });
});

// ---------------------------------------------------------------------------
// G. 静态契约: 配置 key / 端点 / 前端接线
// ---------------------------------------------------------------------------

describe('G. 静态契约 (配置 key、端点、前端接线)', () => {
  const ROUTE_FILE = path.join(CENTER_ROOT, 'src', 'routes', 'system-settings-v2.js');

  test('后端端点存在: GET/PUT /api/admin/system-settings-v2/timezone + 诊断端点', () => {
    const src = readFileSync(ROUTE_FILE, 'utf8');
    assert.match(src, /router\.get\('\/api\/admin\/system-settings-v2\/timezone'/);
    assert.match(src, /router\.put\('\/api\/admin\/system-settings-v2\/timezone'/);
    assert.match(src, /router\.get\('\/api\/admin\/system-settings-v2\/email-outbox-diagnostics'/);
  });

  test('写时区必须走 db.sql.config.upsert (services/config.js 的 setConfig 是 UPDATE-only, 静默 0 行)', () => {
    const src = readFileSync(ROUTE_FILE, 'utf8');
    const putBlock = src.slice(src.indexOf("router.put('/api/admin/system-settings-v2/timezone'"));
    assert.match(putBlock, /db\.sql\.config\.upsert/,
      '写时区必须用 upsert —— 新 key 在 UPDATE-only 的 setConfig 下永远写不进去');
    assert.doesNotMatch(putBlock, /\bsetConfig\s*\(/,
      '不能用 setConfig 写新 key');
  });

  test('写时区留审计 (action=update_display_timezone)', () => {
    const src = readFileSync(ROUTE_FILE, 'utf8');
    assert.match(src, /action:\s*'update_display_timezone'/);
  });

  test('前端接线: api / router / main / 页面都在', () => {
    const api = readFileSync(path.join(WEB_SRC, 'api', 'admin.js'), 'utf8');
    assert.match(api, /getSystemTimezone/);
    assert.match(api, /updateSystemTimezone/);

    const router = readFileSync(path.join(WEB_SRC, 'router.js'), 'utf8');
    assert.match(router, /path:\s*'\/admin\/timezone'/);
    assert.match(router, /import TimezoneView from '\.\/views\/admin\/TimezoneView\.vue'/);

    const main = readFileSync(path.join(WEB_SRC, 'main.js'), 'utf8');
    assert.match(main, /loadServerTimezone/);
    assert.match(main, /applyServerTimezone/);

    assert.ok(existsSync(path.join(WEB_SRC, 'views', 'admin', 'TimezoneView.vue')),
      '缺少 时区 页面');
  });
});

// ---------------------------------------------------------------------------
// H. 服务端时钟探针 (readServerClock)
// ---------------------------------------------------------------------------

describe('H. 服务端时钟探针 (MySQL + MSSQL 双方言)', () => {
  function makeDb(dialect, row) {
    return {
      dialect,
      async query() { return { rows: [row] }; }
    };
  }

  test('MySQL: 会话偏移 0 (已钉 UTC) ⇒ pinnedToUtc=true', async () => {
    const db = makeDb('mysql', {
      session_tz: '+00:00',
      system_tz_hex: '435354',          // HEX('CST')
      now_utc: new Date('2026-10-26T13:03:03.000Z'),
      now_session: new Date('2026-10-26T13:03:03.000Z'),
      offset_min: 0
    });
    const clock = await readServerClock(db);
    assert.equal(clock.dialect, 'mysql');
    assert.equal(clock.sessionTimeZone, '+00:00');
    assert.equal(clock.systemTimeZone, 'CST');
    assert.equal(clock.sessionOffsetMinutes, 0);
    assert.equal(clock.pinnedToUtc, true, '会话偏移 0 ⇒ DEFAULT CURRENT_TIMESTAMP 写的是 UTC');
    assert.equal(clock.serverTimeUtc, '2026-10-26T13:03:03.000Z');
  });

  test('MySQL: 会话偏移 480 (没钉 UTC) ⇒ pinnedToUtc=false (页面必须能报警)', async () => {
    const db = makeDb('mysql', {
      session_tz: 'SYSTEM',
      system_tz_hex: '435354',          // HEX('CST')
      now_utc: new Date('2026-10-26T13:03:03.000Z'),
      now_session: new Date('2026-10-26T21:03:03.000Z'),
      offset_min: 480
    });
    const clock = await readServerClock(db);
    assert.equal(clock.sessionOffsetMinutes, 480);
    assert.equal(clock.pinnedToUtc, false, '会话不是 UTC ⇒ 时间会错, 必须报出来');
  });

  test('MSSQL: 恒 pinnedToUtc=true (DEFAULT sysutcdatetime() 恒定 UTC)', async () => {
    const db = makeDb('mssql', {
      now_utc: new Date('2026-10-26T13:03:03.000Z'),
      now_session: new Date('2026-10-26T21:03:03.000Z'),
      offset_min: 480,
      system_tz: 'China Standard Time'
    });
    const clock = await readServerClock(db);
    assert.equal(clock.dialect, 'mssql');
    assert.equal(clock.pinnedToUtc, true);
    assert.equal(clock.sessionOffsetMinutes, 480);
    assert.equal(clock.systemTimeZone, 'China Standard Time');
  });

  test('探针查不到行时不炸 (空行 ⇒ 全 UNKNOWN/0)', async () => {
    const db = { dialect: 'mysql', async query() { return { rows: [] }; } };
    const clock = await readServerClock(db);
    assert.equal(clock.pinnedToUtc, true, '查不到行不该谎报"没钉 UTC"');
    assert.equal(clock.sessionOffsetMinutes, 0);
  });

  test('MySQL: 系统时区走 HEX ⇒ 中文 Windows 上不是乱码', async () => {
    // ★ 真库实测 (2026-10-27): @@system_time_zone 的原始字节是
    //   D6D0B9FAB1EAD7BCCAB1BCE4 = "中国标准时间" 的 **GBK** 编码。
    //   MySQL 5.7 声明它是 utf8, 客户端按 UTF-8 解必然乱码。
    //   ⇒ 必须用 HEX() 取回原始字节, 在 JS 里解。
    const db = makeDb('mysql', {
      session_tz: '+00:00',
      system_tz_hex: 'D6D0B9FAB1EAD7BCCAB1BCE4',
      now_utc: new Date('2026-10-26T13:03:03.000Z'),
      now_session: new Date('2026-10-26T13:03:03.000Z'),
      offset_min: 0
    });
    const clock = await readServerClock(db);
    assert.equal(clock.systemTimeZone, '中国标准时间', 'GBK 字节必须解回真名, 不能是乱码');
  });

  test('MySQL: 探针 SQL 走 HEX 取原始字节 (不走 CONVERT, 那一路是有损的)', () => {
    assert.match(MYSQL_CLOCK_SQL, /HEX\s*\(\s*@@system_time_zone\s*\)/,
      '必须用 HEX(@@system_time_zone) 取回原始字节');
    assert.doesNotMatch(MYSQL_CLOCK_SQL, /CONVERT\s*\(/i,
      'CONVERT(... USING gbk) 在服务端就丢字节 (实测 8 个 "?"), 不可用');
    assert.doesNotMatch(MYSQL_CLOCK_SQL, /@@system\./,
      '"@@system." 不是合法作用域 (MySQL 只有 GLOBAL/SESSION/LOCAL)');
  });
});

// ---------------------------------------------------------------------------
// I. 探针 SQL 的作用域契约 (R161.15) —— 全仓扫描, 钉死 1272 这一族
// ---------------------------------------------------------------------------

describe('I. 探针 SQL 作用域契约 (R161.15: ER_VARIABLE_IS_NOT_STRUCT / errno 1272)', () => {
  // MySQL 的系统变量**作用域**只有这三个。写第四个 ⇒ 服务端直接报
  //   ER_VARIABLE_IS_NOT_STRUCT (errno 1272):
  //   "Variable 'time_zone' is not a variable component
  //    (can't be used as XXXX.variable_name)"
  // ⇒ 端点 500。R161.15 的真凶就是 `@@system.time_zone`。
  const VALID_SCOPES = new Set(['global', 'session', 'local']);

  // 带作用域的写法: @@<scope>.<var>
  const SCOPED_RE = /@@\s*([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g;

  test('扫描面非空 (守卫本身不许空转)', () => {
    const files = collectSourceFiles(path.join(CENTER_ROOT, 'src'));
    assert.ok(files.length > 50, `扫描面过小: ${files.length}`);
  });

  test('src/ 全仓: 带作用域的 @@ 必须用 GLOBAL/SESSION/LOCAL', () => {
    const files = collectSourceFiles(path.join(CENTER_ROOT, 'src'));
    const violations = [];
    let scopedCount = 0;
    for (const file of files) {
      // ★ 必须剥注释: 注释里写着 `@@system.time_zone` (反面教材/故障说明),
      //   那不是可执行 SQL, 不该让守卫变红。
      const src = stripJsComments(readFileSync(file, 'utf8'));
      SCOPED_RE.lastIndex = 0;
      let m;
      while ((m = SCOPED_RE.exec(src)) !== null) {
        scopedCount += 1;
        const scope = m[1].toLowerCase();
        if (!VALID_SCOPES.has(scope)) {
          violations.push(`${path.relative(CENTER_ROOT, file)}: @@${m[1]}.${m[2]}`);
        }
      }
    }
    assert.deepEqual(violations, [],
      `非法作用域的 @@ 变量 (MySQL 会报 errno 1272):\n${violations.join('\n')}`);
    assert.ok(scopedCount > 0, '扫描面里一个带作用域的 @@ 都没有 ⇒ 守卫空转');
  });

  test('src/ 全仓: 不带作用域的 @@ 变量名不许含点 (含点就说明写成了作用域形式)', () => {
    const files = collectSourceFiles(path.join(CENTER_ROOT, 'src'));
    const violations = [];
    for (const file of files) {
      const src = stripJsComments(readFileSync(file, 'utf8'));
      // 逐个 @@ 出现位置, 看它后面跟的名字里有没有点。
      const re = /@@\s*([A-Za-z_][A-Za-z0-9_]*)/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const after = src.slice(m.index + m[0].length);
        // @@name 后面紧跟 (空白)* '.' ⇒ 说明是 @@scope.var 形式, 上面那条已查。
        if (/^\s*\./.test(after)) continue;
        // @@name 后面跟别的标识符字符 ⇒ 变量名被拆开了, 写法有问题。
        if (/^[A-Za-z0-9_]/.test(after)) {
          violations.push(`${path.relative(CENTER_ROOT, file)}: @@${m[1]} 后面又跟了字符`);
        }
      }
    }
    assert.deepEqual(violations, [], violations.join('\n'));
  });

  test('探针 SQL 的别名与读取端一致 (别名对不上 ⇒ 永远读到 undefined)', () => {
    // MYSQL_CLOCK_SQL 里的别名集合必须覆盖 readServerClock 读到的所有 row.* 键
    // (MySQL 分支); MSSQL_CLOCK_SQL 同理 (MSSQL 分支)。
    const mysqlAliases = new Set(
      [...MYSQL_CLOCK_SQL.matchAll(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map((m) => m[1].toLowerCase())
    );
    const mssqlAliases = new Set(
      [...MSSQL_CLOCK_SQL.matchAll(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map((m) => m[1].toLowerCase())
    );

    for (const alias of ['session_tz', 'system_tz_hex', 'now_utc', 'now_session', 'offset_min']) {
      assert.ok(mysqlAliases.has(alias), `MySQL 探针 SQL 缺少别名 ${alias}`);
    }
    for (const alias of ['now_utc', 'now_session', 'offset_min', 'system_tz']) {
      assert.ok(mssqlAliases.has(alias), `MSSQL 探针 SQL 缺少别名 ${alias}`);
    }
    // MSSQL 侧用裸字符串 (SERVERPROPERTY 返回 Unicode), 不需要 HEX。
    assert.ok(!mssqlAliases.has('system_tz_hex'), 'MSSQL 侧不该有 system_tz_hex');
  });

  test('两个方言的探针 SQL 不许混用对方的函数', () => {
    assert.doesNotMatch(MYSQL_CLOCK_SQL, /SYSUTCDATETIME|SYSDATETIMEOFFSET|SERVERPROPERTY|DATEDIFF/i,
      'MySQL 探针 SQL 里出现了 MSSQL 专有函数');
    assert.doesNotMatch(MSSQL_CLOCK_SQL, /UTC_TIMESTAMP|TIMESTAMPDIFF|\bHEX\s*\(|\bNOW\s*\(/i,
      'MSSQL 探针 SQL 里出现了 MySQL 专有函数');
  });
});

// ---------------------------------------------------------------------------
// J. @@system_time_zone 的字节解码 (R161.15 的第二处故障)
// ---------------------------------------------------------------------------

describe('J. @@system_time_zone 原始字节的解码', () => {
  // GBK 编码的 "中国标准时间" (真库 2026-10-27 实测的原始字节)
  const GBK_HEX = 'D6D0B9FAB1EAD7BCCAB1BCE4';
  // UTF-8 编码的 "中国标准时间"
  const UTF8_HEX = 'E4B8ADE59BBDE6A087E58786E697B6E997B4';

  test('GBK 字节解回中文时区名 (中文版 Windows 的真实现场)', () => {
    assert.equal(decodeSystemTimeZoneName(GBK_HEX), '中国标准时间');
  });

  test('UTF-8 字节也解得对 (Linux / 英文 Windows 的常态)', () => {
    assert.equal(decodeSystemTimeZoneName(UTF8_HEX), '中国标准时间');
  });

  test('ASCII 名字 (CST / UTC) 两边编码一样 ⇒ 原样', () => {
    assert.equal(decodeSystemTimeZoneName('435354'), 'CST');   // HEX('CST')
    assert.equal(decodeSystemTimeZoneName('555443'), 'UTC');   // HEX('UTC')
  });

  test('非法 HEX 一律报 UNKNOWN (绝不半截字符串)', () => {
    // ★ '4353' 是**偶数**长度、合法 hex ⇒ 解出 'CS' 是**正确**行为, 不在此列。
    //   真正该拒的是: 奇数长度 ('435' → Buffer.from 会吞掉半个字节)、
    //   混进非 hex 字符 ('435354ZZ' → Buffer.from 静默截成 'CST')、
    //   带前缀/带空格、空、非字符串。
    for (const bad of ['', '   ', 'ZZ', '435', '435354ZZ', '0x435354', '43 53 54', null, undefined, 123]) {
      assert.equal(decodeSystemTimeZoneName(bad), UNKNOWN_TIME_ZONE,
        `非法输入 ${JSON.stringify(bad)} 必须报 UNKNOWN`);
    }
    // 偶数长度的合法 hex 照常解 (这是 MySQL HEX() 的正常输出形态)。
    assert.equal(decodeSystemTimeZoneName('4353'), 'CS');
  });

  test('★ Buffer.from(x,"hex") 的宽容性不会漏到线上 (它会把 "435354ZZ" 截成 "CST")', () => {
    // 这条是本组最关键的一条: 若哪天有人图省事去掉严格校验,
    // "435354ZZ" 会静默变成 "CST" —— 脏数据被当成合法时区名报出去。
    assert.equal(Buffer.from('435354ZZ', 'hex').toString('latin1'), 'CST',
      '前提断言: Node 的 Buffer.from 确实是宽容的 (所以我们自己必须严格)');
    assert.equal(decodeSystemTimeZoneName('435354ZZ'), UNKNOWN_TIME_ZONE,
      '我们自己的解码必须比 Buffer.from 严格');
  });

  test('解不出时如实报 UNKNOWN (不猜一个时区名出来)', () => {
    // 合法 HEX 但不是任何已知编码 ⇒ 两条路都失败。
    assert.equal(decodeSystemTimeZoneName('FFFEFFFF'), UNKNOWN_TIME_ZONE);
  });
});
