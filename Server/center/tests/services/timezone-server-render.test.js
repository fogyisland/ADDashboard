// center/tests/services/timezone-server-render.test.js
// R161.31 (2026-11-07) — **服务端**时区渲染契约 (R161.11 契约第 3 条)
//
// ★ 为什么要有这个文件 (R161.11 的漏洞):
//   R161.11 立了三条契约:
//     1. 存储契约 = UTC;
//     2. 显示时区是渲染层的事, 服务端是权威值;
//     3. **任何地方都不许再写死 "+8h" / "CST" 这类固定偏移**。
//   第 3 条的落地手段是 tests/timezone-settings.test.js 的 "F. 漂移守卫",
//   但那个守卫**只扫 web/src** ⇒ 服务端 (reports.js / report-scheduler.js)
//   写死了 `+ 8 * 3600 * 1000` 整整 4 天没人发现, 邮件里的时间戳
//   在操作员把显示时区改成 Europe/Berlin 之后**仍然是 CST**。
//   ⇒ 本文件补上服务端这一半:
//     - A. 服务端渲染入口的**数值契约** (偏移/DST/午夜换算);
//     - B. reports.js / report-scheduler.js 的**行为契约** (换时区 ⇒ 跟着换);
//     - C. 漂移守卫**扩到 src/** (从源头防复发)。
//
// 用法: cd Server/center && node --test tests/services/timezone-server-render.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  formatOffsetMinutes,
  parseTimestamp,
  formatDateTime,
  formatDateOnly,
  utcInstantOfLocalMidnight,
  offsetMinutesFor,
  isValidTimeZone
} from '../../src/services/timezone.js';

import { stripJsComments } from '../helpers/strip-comments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = path.resolve(HERE, '..', '..');
const SRC = path.join(CENTER_ROOT, 'src');

// ---------------------------------------------------------------------------
// A. 服务端渲染入口的数值契约
// ---------------------------------------------------------------------------

describe('A. 服务端渲染入口 (src/services/timezone.js)', () => {
  test('formatOffsetMinutes — 偏移分钟数 ⇒ 带符号的 HH:MM', () => {
    assert.equal(formatOffsetMinutes(0), '+00:00');
    assert.equal(formatOffsetMinutes(480), '+08:00');
    assert.equal(formatOffsetMinutes(-300), '-05:00');
    assert.equal(formatOffsetMinutes(330), '+05:30');
    assert.equal(formatOffsetMinutes(-210), '-03:30');   // Asia/Kathmandu
    assert.equal(formatOffsetMinutes(345), '+05:45');
    assert.equal(formatOffsetMinutes(-1), '-00:01');
    assert.equal(formatOffsetMinutes(NaN), '—');
    assert.equal(formatOffsetMinutes(undefined), '—');
  });

  test('parseTimestamp — naive 形态按 UTC (存储契约), 带 Z/偏移按其自带时区', () => {
    assert.equal(parseTimestamp('2026-10-26 13:03:03').toISOString(), '2026-10-26T13:03:03.000Z');
    assert.equal(parseTimestamp('2026-10-26T13:03:03').toISOString(), '2026-10-26T13:03:03.000Z');
    assert.equal(parseTimestamp('2026-10-26T13:03:03.035Z').toISOString(), '2026-10-26T13:03:03.035Z');
    assert.equal(parseTimestamp('2026-10-26T21:03:03+08:00').toISOString(), '2026-10-26T13:03:03.000Z');
    for (const bad of [null, undefined, '', '   ', 'not-a-date', {}, []]) {
      assert.equal(parseTimestamp(bad), null, `${JSON.stringify(bad)} 应解析为 null`);
    }
  });

  test('formatDateTime — 窄列形态, 偏移逐个时间戳求值 (含 DST)', () => {
    // Asia/Shanghai 全年 +8, 无 DST。
    assert.equal(formatDateTime('2026-10-26T13:03:03.035Z', 'Asia/Shanghai'), '2026-10-26 21:03:03');
    // 柏林: 冬令时 +1 / 夏令时 +2 —— 同一个函数, 不同时刻不同偏移。
    assert.equal(formatDateTime('2026-01-15T13:03:03Z', 'Europe/Berlin'), '2026-01-15 14:03:03');
    assert.equal(formatDateTime('2026-07-15T13:03:03Z', 'Europe/Berlin'), '2026-07-15 15:03:03');
    // 纽约: 冬 -5 / 夏 -4。
    assert.equal(formatDateTime('2026-01-15T13:03:03Z', 'America/New_York'), '2026-01-15 08:03:03');
    assert.equal(formatDateTime('2026-07-15T13:03:03Z', 'America/New_York'), '2026-07-15 09:03:03');
    // UTC。
    assert.equal(formatDateTime('2026-10-26T13:03:03Z', 'UTC'), '2026-10-26 13:03:03');
    // 非法时区 ⇒ 回落 UTC (不抛错)。
    assert.equal(formatDateTime('2026-10-26T13:03:03Z', 'Not/AZone'), '2026-10-26 13:03:03');
    // 非法值 ⇒ fallback。
    assert.equal(formatDateTime(null, 'Asia/Shanghai'), '—');
    assert.equal(formatDateTime('not-a-date', 'Asia/Shanghai'), '—');
    assert.equal(formatDateTime(null, 'Asia/Shanghai', { fallback: '' }), '');
    // withSeconds:false。
    assert.equal(
      formatDateTime('2026-10-26T13:03:03Z', 'Asia/Shanghai', { withSeconds: false }),
      '2026-10-26 21:03'
    );
  });

  test('formatDateOnly — 只出日历日', () => {
    assert.equal(formatDateOnly('2026-10-26T13:03:03Z', 'Asia/Shanghai'), '2026-10-26');
    // UTC 16:00 ⇒ 上海已是次日 00:00。
    assert.equal(formatDateOnly('2026-10-26T16:00:00Z', 'Asia/Shanghai'), '2026-10-27');
    assert.equal(formatDateOnly('2026-10-26T16:00:00Z', 'UTC'), '2026-10-26');
    assert.equal(formatDateOnly(null, 'Asia/Shanghai'), '—');
  });

  test('utcInstantOfLocalMidnight — 当地午夜 ⇒ UTC 时刻 (DST / 半小时偏移都对)', () => {
    // Asia/Shanghai: 当地 00:00 = UTC 前一天 16:00。
    assert.equal(
      utcInstantOfLocalMidnight(2026, 10, 26, 'Asia/Shanghai').toISOString(),
      '2026-10-25T16:00:00.000Z'
    );
    // UTC: 当地午夜 = UTC 午夜。
    assert.equal(
      utcInstantOfLocalMidnight(2026, 10, 26, 'UTC').toISOString(),
      '2026-10-26T00:00:00.000Z'
    );
    // 柏林冬令时 (+1): 当地 00:00 = UTC 前一天 23:00。
    assert.equal(
      utcInstantOfLocalMidnight(2026, 1, 15, 'Europe/Berlin').toISOString(),
      '2026-01-14T23:00:00.000Z'
    );
    // 柏林夏令时 (+2): 当地 00:00 = UTC 前一天 22:00。
    assert.equal(
      utcInstantOfLocalMidnight(2026, 7, 15, 'Europe/Berlin').toISOString(),
      '2026-07-14T22:00:00.000Z'
    );
    // ★ 半小时偏移时区 (Asia/Kolkata +05:30): 当地午夜 = UTC 前一天 18:30。
    //   写死 -8h 的实现在这里会差 2.5 小时 ⇒ "日报窗口"整体偏移。
    assert.equal(
      utcInstantOfLocalMidnight(2026, 10, 26, 'Asia/Kolkata').toISOString(),
      '2026-10-25T18:30:00.000Z'
    );
    // ★ 45 分钟偏移 (Asia/Kathmandu +05:45): 当地午夜 = UTC 前一天 18:15。
    assert.equal(
      utcInstantOfLocalMidnight(2026, 10, 26, 'Asia/Kathmandu').toISOString(),
      '2026-10-25T18:15:00.000Z'
    );
  });

  test('utcInstantOfLocalMidnight — 换算结果必须**自洽** (反推回当地就是 00:00)', () => {
    const zones = ['Asia/Shanghai', 'UTC', 'Europe/Berlin', 'America/New_York', 'Asia/Kolkata', 'Asia/Kathmandu'];
    for (const tz of zones) {
      for (const [y, m, d] of [[2026, 1, 15], [2026, 7, 15], [2026, 10, 26], [2026, 3, 8]]) {
        const utcInstant = utcInstantOfLocalMidnight(y, m, d, tz);
        // 该时刻在该时区的墙上时间必须是 00:00:00。
        const offsetMinutes = offsetMinutesFor(tz, utcInstant);
        const wall = new Date(utcInstant.getTime() + offsetMinutes * 60000);
        assert.equal(wall.getUTCHours(), 0, `${tz} ${y}-${m}-${d} 的当地午夜换算后小时不是 0`);
        assert.equal(wall.getUTCMinutes(), 0, `${tz} ${y}-${m}-${d} 的当地午夜换算后分钟不是 0`);
        assert.equal(wall.getUTCDate(), d, `${tz} ${y}-${m}-${d} 的当地午夜换算后日期不对`);
        assert.equal(wall.getUTCMonth() + 1, m, `${tz} ${y}-${m}-${d} 的当地午夜换算后月份不对`);
      }
    }
  });

  test('isValidTimeZone — 固定偏移串一律拒绝', () => {
    for (const bad of ['', '   ', 'GMT+8', '+08:00', 'UTC+8', 'Not/AZone', null, undefined, 480]) {
      assert.equal(isValidTimeZone(bad), false, `${JSON.stringify(bad)} 应被拒绝`);
    }
    for (const good of ['UTC', 'Asia/Shanghai', 'Europe/Berlin', 'America/New_York']) {
      assert.equal(isValidTimeZone(good), true, `${good} 应被接受`);
    }
  });
});

// ---------------------------------------------------------------------------
// B. reports.js / report-scheduler.js 的行为契约
//
// ★ 为什么用**源码静态契约**而不是跑 renderReport():
//   renderReport() 需要真库 (8 段 SQL), 单测里跑不了。
//   ⇒ 这里锁的是**接线**: 必须读 DISPLAY_TIMEZONE_KEY、必须把时区传进
//     渲染函数、必须不许再出现写死的 +8h / "CST" 字面量。
//   ⇒ 数值正确性由 A 组 (timezone.js 纯函数) + 下面的 C 组 (漂移守卫) 兜底。
// ---------------------------------------------------------------------------

describe('B. reports.js / report-scheduler.js 的时区接线', () => {
  const REPORTS = path.join(SRC, 'services', 'reports.js');
  const SCHEDULER = path.join(SRC, 'services', 'report-scheduler.js');

  test('reports.js — 必须从 timezone.js 导入显示时区真源', () => {
    const src = readFileSync(REPORTS, 'utf8');
    assert.match(src, /from '\.\/timezone\.js'/,
      'reports.js 必须从 services/timezone.js 导入时区 helper');
    for (const fn of ['DISPLAY_TIMEZONE_KEY', 'normalizeDisplayTimeZone', 'offsetMinutesFor', 'formatOffsetMinutes']) {
      assert.ok(src.includes(fn), `reports.js 缺少 ${fn} 的导入/使用`);
    }
  });

  test('reports.js — 必须读 app_display_timezone 配置并传进渲染层', () => {
    const src = readFileSync(REPORTS, 'utf8');
    assert.match(src, /getSystemConfig\(\)/,
      'reports.js 必须读系统配置拿显示时区');
    assert.match(src, /normalizeDisplayTimeZone\(\s*cfg\?\.\[DISPLAY_TIMEZONE_KEY\]\s*\)/,
      'reports.js 必须用 DISPLAY_TIMEZONE_KEY 取显示时区');
    // 渲染层三个函数都必须收到 timeZone。
    assert.match(src, /renderHtml\(\s*kind\s*,\s*ps\s*,\s*pe\s*,\s*sections\s*,\s*displayTimeZone\s*\)/,
      'renderHtml 必须收到 displayTimeZone');
    assert.match(src, /renderText\(\s*kind\s*,\s*ps\s*,\s*pe\s*,\s*sections\s*,\s*displayTimeZone\s*\)/,
      'renderText 必须收到 displayTimeZone');
    assert.match(src, /buildSubject\(\s*kind\s*,\s*ps\s*,\s*pe\s*,\s*displayTimeZone\s*\)/,
      'buildSubject 必须收到 displayTimeZone');
  });

  test('reports.js — 表头里的时区标签必须由时区派生, 不许再写死 "CST"', () => {
    const src = stripJsComments(readFileSync(REPORTS, 'utf8'));
    assert.doesNotMatch(src, /['"`]CST['"`]/,
      'reports.js 里还有 "CST" 字面量 —— 换时区后表头就在骗人');
    // 表头标签必须来自 formatOffsetMinutes(offsetMinutesFor(...))。
    assert.match(src, /formatOffsetMinutes\(\s*offsetMinutesFor\(/,
      '表头标签必须由偏移算出来');
  });

  test('report-scheduler.js — 必须读显示时区并用于 cron 匹配与窗口计算', () => {
    const src = readFileSync(SCHEDULER, 'utf8');
    assert.match(src, /from '\.\/timezone\.js'/,
      'report-scheduler.js 必须从 services/timezone.js 导入时区 helper');
    assert.match(src, /normalizeDisplayTimeZone\(\s*cfg\?\.\[DISPLAY_TIMEZONE_KEY\]\s*\)/,
      'report-scheduler.js 必须用 DISPLAY_TIMEZONE_KEY 取显示时区');
    assert.match(src, /lastCronFireMinuteKey\(\s*kind\s*,\s*new Date\(\)\s*,\s*expr\s*,\s*displayTimeZone\s*\)/,
      'cron 触发的去重键必须按显示时区算');
    assert.match(src, /getReportWindow\(\s*kind\s*,\s*new Date\(\)\s*,\s*displayTimeZone\s*\)/,
      '报告窗口必须按显示时区算');
  });

  test('report-scheduler.js — 当地午夜必须走 utcInstantOfLocalMidnight (不许写死 -8h)', () => {
    const src = readFileSync(SCHEDULER, 'utf8');
    assert.match(src, /utcInstantOfLocalMidnight\(/,
      '午夜换算必须走 timezone.js 的 utcInstantOfLocalMidnight');
  });
});

// ---------------------------------------------------------------------------
// C. 服务端漂移守卫 (把 R161.11 的 F 组守卫扩到 src/)
//
// ★ 这是**防复发**的最高杠杆单点改动:
//   R161.11 的守卫只扫 web/src ⇒ 服务端写死 +8h 活了 4 天。
//   ⇒ 同一组三条正则, 同样扫 src/ (但要剥注释 + 白名单)。
//
// ★ 白名单是**逐条**的, 不是整文件豁免 —— 免得后人把整个文件加进白名单
//   就能再塞一堆违规进去。
// ---------------------------------------------------------------------------

function collectSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

// ★ 服务端**有意**保留的例外, 逐条写明理由 (跟 web 侧的
//   LOCAL_CALENDAR_ALLOWLIST 同一套路)。
//
// 1. routes/auth.js — `signJwt(..., 8 * 3600)` 是 **JWT 有效期 8 小时**
//    (单位=秒), 跟时区**毫无关系**。8*3600 命中的是"固定 8 小时"这个
//    数字形态, 但语义完全不同 ⇒ 必须豁免, 否则守卫会逼着人把它改错。
//
// 2. services/license-state.js + routes/system-settings-v2.js +
//    services/license-validator.js — 许可证的**日历日 (业务日期)**。
//    跟 web/src/views/admin/systemSettings/LicenseView.vue 的 formatYmd
//    是同一处例外 (R161.11 已写明理由): 它是 DATE 列 `installed_at` 的
//    取值, 也是"今天"和试用期天数的计算基准 —— 属于业务日期, 不是
//    "某一瞬间"。两端必须同一个框架, 否则申请日期跟试用天数差一天。
//
// 3. services/cron-scheduler.js — cron 表达式按**服务器本地日历**解析。
//    这是**中心自己的调度时钟** (包触发), 跟显示时区无关: 操作员配的
//    '0 2 * * *' 是"每天本地 2 点触发包"。改成显示时区会改变包的触发
//    时刻 (业务行为变更), 不属于本次时区修复的范围。
//    ⚠ 但它的 minuteBucket / shouldFire 已经在别处核过是自洽的。
//
// 4. db/sql/package-runs.js + services/trigger-queue.js —
//    `new Date(y, mo, d, h, mi, 0, 0)` 的**分钟取整**。
//    ★ 重要: 这一条经核实**不是**缺陷 —— `new Date(y,mo,d,h,mi,0,0)` 用本地
//    字段构造, 再由驱动按 UTC 写出 ⇒ 得到的**瞬间**跟 UTC 空间截断
//    `Math.floor(t/60000)*60000` **完全相同** (实测见
//    tests/services/timezone-server-render.test.js 的对照)。
//    ⇒ 豁免的理由是"语义正确", 不是"来不及修"。
const SERVER_TZ_ALLOWLIST = new Map([
  ['routes/auth.js', 'JWT 有效期 8 小时 (秒), 跟时区无关'],
  ['services/license-state.js', '许可证日历日 (业务日期), R161.11 已写明理由'],
  ['routes/system-settings-v2.js', '许可证日历日 (业务日期), R161.11 已写明理由'],
  ['services/license-validator.js', '许可证日历日 (业务日期), R161.11 已写明理由'],
  ['services/cron-scheduler.js', '中心包调度用服务器本地日历, 改显示时区=改业务行为'],
  ['db/sql/package-runs.js', '分钟取整: 本地构造与 UTC 截断的瞬间完全相同 (实测)'],
  ['services/trigger-queue.js', '分钟取整: 本地构造与 UTC 截断的瞬间完全相同 (实测)']
]);

describe('C. 服务端漂移守卫 (src/ 里不许再写死固定偏移 / 本地时区渲染时间戳)', () => {
  const files = collectSourceFiles(SRC);

  test('扫描面非空 (守卫本身不许空转)', () => {
    assert.ok(files.length > 50, `只扫到 ${files.length} 个文件, 扫描面不对`);
  });

  test('不许再出现硬编码的 +8 小时偏移 (JWT 有效期除外)', () => {
    const offenders = [];
    for (const file of files) {
      const rel = path.relative(SRC, file).replace(/\\/g, '/');
      if (SERVER_TZ_ALLOWLIST.has(rel)) continue;
      const code = stripJsComments(readFileSync(file, 'utf8'));
      if (/\b8\s*\*\s*3600/.test(code) || /getUTCHours\(\)\s*\+\s*8/.test(code)) {
        offenders.push(rel);
      }
    }
    assert.deepEqual(offenders, [],
      `这些文件里还有硬编码 +8 偏移 —— 显示时区改成别的就会错: ${offenders.join(', ')}`);
  });

  test('不许再用 toLocaleString / toLocaleTimeString / toLocaleDateString 渲染时间戳', () => {
    const offenders = [];
    for (const file of files) {
      const rel = path.relative(SRC, file).replace(/\\/g, '/');
      if (SERVER_TZ_ALLOWLIST.has(rel)) continue;
      const code = stripJsComments(readFileSync(file, 'utf8'));
      // ★ 只禁**渲染日期**的形态。`Number(x).toLocaleString()` 是**千分位**
      //   格式化 (报表里的 "1,234 次"), 跟时区无关 —— 放行。
      //   ⇒ 正则要求 toLocale* 的第一个参数是**字符串 locale** 或干脆没参数
      //     时的日期渲染形态, 这里用"带日期选项"来判定。
      if (/toLocale(String|TimeString|DateString)\s*\(\s*['"`]/.test(code)) {
        offenders.push(rel);
      }
      if (/toLocaleDateString\s*\(\s*\)/.test(code) || /toLocaleTimeString\s*\(\s*\)/.test(code)) {
        offenders.push(rel);
      }
    }
    assert.deepEqual(offenders, [],
      `这些文件还在用 toLocale* 渲染时间戳 (跟着服务器时区走 ⇒ 换机器就错): ${offenders.join(', ')}`);
  });

  test('不许再手搓 getFullYear/getMonth/getDate 取墙上时间 (白名单除外)', () => {
    const offenders = [];
    for (const file of files) {
      const rel = path.relative(SRC, file).replace(/\\/g, '/');
      if (SERVER_TZ_ALLOWLIST.has(rel)) continue;
      const code = stripJsComments(readFileSync(file, 'utf8'));
      if (/getFullYear\s*\(/.test(code) || /getMonth\s*\(/.test(code) || /getDate\s*\(/.test(code)) {
        offenders.push(rel);
      }
    }
    assert.deepEqual(offenders, [],
      `这些文件还在手搓本地日历时间: ${offenders.join(', ')}`);
  });

  test('白名单里的每一条都必须带理由 (免得后人当漏改的 bug 又改一遍)', () => {
    for (const [rel, reason] of SERVER_TZ_ALLOWLIST) {
      assert.ok(reason && reason.length > 10, `白名单条目 ${rel} 缺理由`);
      const full = path.join(SRC, rel);
      assert.ok(readdirSync(SRC).length > 0, '扫描面异常');
      // 文件必须真的存在 —— 白名单里留一条不存在的路径 = 守卫悄悄失效。
      let exists = true;
      try {
        readFileSync(full, 'utf8');
      } catch {
        exists = false;
      }
      assert.ok(exists, `白名单里的 ${rel} 不存在 (路径写错了? 守卫会悄悄失效)`);
    }
  });
});
