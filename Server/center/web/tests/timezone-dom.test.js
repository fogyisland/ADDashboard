// R161.13 (2026-10-27) — 显示时区 (前端) 的 **DOM 维度**测试。
//
// ★ 为什么这套断言不在 node --test 套件里 (tests/timezone-settings.test.js
//   已经把纯函数逐条锁死了, 那里有 670 行):
//   node 环境**没有 localStorage** —— Node 25 虽然有个同名全局, 但那是坏壳
//   (见 tests/setup.js 的注释), 真要测也得自己造一个。而浏览器里
//   localStorage 是"显示时区离线兜底"的**承重墙**:
//     服务端权威值 (system_config.app_display_timezone) 拉不到时 (接口挂了 /
//     离线 / 初始化向导阶段), 前端全靠 localStorage 里的缓存值渲染时间。
//   ⇒ 这一段逻辑在 node 套件里是**结构性无法覆盖**的, 只能在这里测。
//
// ★ 覆盖的契约 (跟 web/src/lib/timezone.js 的注释逐条对应):
//   1. 优先级: 服务端权威值 > localStorage 缓存 > 默认值 (Asia/Shanghai)。
//   2. 服务端权威值**不写** localStorage —— 它是"别人的选择", 写进去会
//      在服务端配置变了之后留下一个陈旧缓存, 把新配置盖掉。
//   3. 本地选择 (setDisplayTimezone) **要**写 localStorage (跨会话兜底)。
//   4. 非法值一律规整成默认, 绝不把脏值渲染出去。
//   5. 订阅者必须在时区变更时被通知 (页面要跟着变)。
//
// ★ 模块级状态的处理:
//   web/src/lib/timezone.js 用模块级变量存 "服务端权威值", 而 vitest 里
//   同一个 worker 里模块实例是**共享**的 —— 不重置的话, 上一条测试设的
//   服务端时区会漏进下一条, 于是测试之间互相污染。
//   ⇒ 每条测试前 vi.resetModules() + 动态 import, 拿到全新实例。
import { describe, it, expect, beforeEach, vi } from 'vitest';

const STORAGE_KEY = 'ad_display_timezone';

// 每条测试拿一份**全新**的模块实例 (模块级状态互不污染)。
async function freshTimezoneModule() {
  vi.resetModules();
  return import('../src/lib/timezone.js');
}

beforeEach(() => {
  localStorage.clear();
});

describe('显示时区的取值优先级 (服务端 > 本地缓存 > 默认)', () => {
  it('没有服务端值、也没有缓存 ⇒ 用默认值 Asia/Shanghai', async () => {
    const tz = await freshTimezoneModule();
    expect(tz.getDisplayTimezone()).toBe('Asia/Shanghai');
  });

  it('没有服务端值、但 localStorage 里有缓存 ⇒ 用缓存值 (离线兜底)', async () => {
    localStorage.setItem(STORAGE_KEY, 'Europe/Berlin');
    const tz = await freshTimezoneModule();
    expect(tz.getDisplayTimezone()).toBe('Europe/Berlin');
  });

  it('localStorage 里是**非法**时区名 ⇒ 回落默认值 (不把脏值渲染出去)', async () => {
    localStorage.setItem(STORAGE_KEY, 'Not/A_Real_Zone');
    const tz = await freshTimezoneModule();
    expect(tz.getDisplayTimezone()).toBe('Asia/Shanghai');
  });

  it('服务端权威值 **压过** localStorage 缓存 (服务端是唯一真源)', async () => {
    localStorage.setItem(STORAGE_KEY, 'Europe/Berlin');
    const tz = await freshTimezoneModule();
    tz.applyServerTimezone('America/New_York');
    expect(tz.getDisplayTimezone()).toBe('America/New_York');
  });

  it('服务端权威值**不写** localStorage (别把服务端的配置变成"本地选择")', async () => {
    const tz = await freshTimezoneModule();
    tz.applyServerTimezone('Europe/Berlin');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe('本地选择 (setDisplayTimezone) 的落盘与通知', () => {
  it('合法值: 生效 + 写进 localStorage (跨会话兜底)', async () => {
    const tz = await freshTimezoneModule();
    const effective = tz.setDisplayTimezone('America/New_York');
    expect(effective).toBe('America/New_York');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('America/New_York');
    expect(tz.getDisplayTimezone()).toBe('America/New_York');
  });

  it('非法值: 规整成默认值并**照样落盘** (不把脏值留在缓存里)', async () => {
    const tz = await freshTimezoneModule();
    const effective = tz.setDisplayTimezone('Not/A_Real_Zone');
    expect(effective).toBe('Asia/Shanghai');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('Asia/Shanghai');
  });

  it('persist=false ⇒ 内存生效但不落盘', async () => {
    const tz = await freshTimezoneModule();
    tz.setDisplayTimezone('Europe/Berlin', { persist: false });
    expect(tz.getDisplayTimezone()).toBe('Europe/Berlin');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('订阅者在时区变更时被通知, 退订后不再通知', async () => {
    const tz = await freshTimezoneModule();
    const seen = [];
    const unsubscribe = tz.subscribeDisplayTimezone((value) => seen.push(value));

    tz.setDisplayTimezone('Europe/Berlin');
    tz.applyServerTimezone('America/New_York');
    expect(seen).toEqual(['Europe/Berlin', 'America/New_York']);

    unsubscribe();
    tz.setDisplayTimezone('UTC');
    expect(seen).toEqual(['Europe/Berlin', 'America/New_York']);
  });
});

describe('渲染跟着显示时区走 (不是浏览器本地时区, 也不是写死 +8)', () => {
  it('同一个时间戳, 显示时区不同 ⇒ 渲染结果不同 (且都等于各自的墙上时间)', async () => {
    const tz = await freshTimezoneModule();
    // 2026-06-26T21:03:03Z = 柏林 23:03:03 = 纽约 17:03:03 = 上海次日 05:03:03
    // (选 6 月是因为三个时区都在各自的"夏季偏移"上, 断言不会踩到换季边界)
    const stamp = '2026-06-26 21:03:03';

    tz.applyServerTimezone('Europe/Berlin');
    const berlin = tz.formatDateTime(stamp);
    tz.applyServerTimezone('America/New_York');
    const newYork = tz.formatDateTime(stamp);
    tz.applyServerTimezone('Asia/Shanghai');
    const shanghai = tz.formatDateTime(stamp);

    expect(berlin).toContain('23:03:03');
    expect(newYork).toContain('17:03:03');
    expect(shanghai).toContain('05:03:03');
    // 上海比纽约早 12 小时 ⇒ 跨日, 日期必须跟着变。
    expect(shanghai).not.toBe(berlin);
    expect(newYork).not.toBe(berlin);
  });

  it('偏移不是写死的: 同一个显示时区, 跨换季边界后墙上时间会差 1 小时', async () => {
    const tz = await freshTimezoneModule();
    tz.applyServerTimezone('Europe/Berlin');

    // 欧洲 2026 年 10 月 25 日 (最后一个周日) 结束夏令时:
    //   10-24 ⇒ CEST (UTC+2) ⇒ 21:03:03Z = 23:03:03
    //   10-26 ⇒ CET  (UTC+1) ⇒ 21:03:03Z = 22:03:03
    // ⇒ 同样显示时区、同样的 UTC 时刻, 墙上时间差 1 小时。
    //    如果代码写死了 +2 (或者写死 +8), 这条断言必然挂 —— 这正是
    //    "不写死固定偏移, 要偏移就用 IANA 时区名在**当前时刻**算" 的可测形式。
    const beforeDstEnd = tz.formatDateTime('2026-10-24 21:03:03');
    const afterDstEnd = tz.formatDateTime('2026-10-26 21:03:03');

    expect(beforeDstEnd).toContain('23:03:03');
    expect(afterDstEnd).toContain('22:03:03');
  });

  it('naive 形态按 UTC 解释 (存储契约), 不按浏览器本地时区', async () => {
    const tz = await freshTimezoneModule();
    const parsed = tz.parseTimestamp('2026-10-26 21:03:03');
    expect(parsed.toISOString()).toBe('2026-10-26T21:03:03.000Z');
  });

  it('非法时间戳 ⇒ 返回 fallback, 不抛错', async () => {
    const tz = await freshTimezoneModule();
    expect(tz.formatDateTime('not-a-timestamp')).toBe('—');
    expect(tz.formatDateTime(null)).toBe('—');
  });
});
