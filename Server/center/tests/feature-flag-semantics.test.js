// R161.6 (2026-10-26) — feature flag **判定语义**的回归网
//
// ★ 本轮修的现场 (操作员原话):
//   「ADUC 开关在界面中开启了后也不会在首页中有显示」
//   「检查出来了, 功能开关中的内容不对 …… 这是我们要的功能开关。现有功能开关不够。」
//
// ★ 根因链 (三层, 缺一不可 —— 只修一层都会留残症状):
//   ① 基线从来没 seed 过 report_center.* 这 4 把开关
//      → 见 tests/feature-flag-seed-coverage.test.js
//   ② 前端判定是 fail-**closed** (缺 key ⇒ 关闭), 后端是 fail-**open**
//      (缺行 ⇒ 放行) —— 两层口径**相反**。
//      前端那 4 个入口被 v-if 过滤掉、4 条路由被守卫弹回首页;
//      后端 API 却照常 200。⇒ 典型「两层判定分裂」。
//   ③ R159 的 init-state 闸门是 one-shot 且无重试 —— 一次
//      /api/init/status 抖动就永久关掉本会话的后台轮询 ⇒ flags store
//      整个会话都是空的。
//
// ★ 本文件锁住的契约:
//   A. 语义只有**一处**定义 —— 后端 src/utils/featureFlag.js 与前端
//      web/src/lib/featureFlag.js 是两份纯函数副本 (两个构建产物, 不能
//      跨目录 import), 本文件逐格比对, 保证它们**永远一致**。
//   B. 语义本身: 缺行/缺 key ⇒ **放行** (未配置 ≠ 关闭); '1' ⇒ 放行;
//      '0' ⇒ 拦截; 读库失败 ⇒ 放行 (fail-open) 且必须 warn (不静默)。
//   C. 调用点不许再内联旧判定 —— 5 个调用点 (store / router / 开关页 /
//      3 个后端 gate) 必须全部走公共实现, 防止"改了一处忘了另一处"。
//
// 用法: cd Server/center && node --test tests/feature-flag-semantics.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isFlagValueEnabled as serverIsFlagValueEnabled,
  readFeatureFlag
} from '../src/utils/featureFlag.js';
import {
  isFlagValueEnabled as webIsFlagValueEnabled,
  isFlagEnabled,
  areFlagsEnabled,
  resolveFeatureFlag
} from '../web/src/lib/featureFlag.js';
import { stripJsComments } from './helpers/strip-comments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = path.resolve(HERE, '..');
const SERVER_ROOT = path.resolve(CENTER_ROOT, '..');

/** 判定矩阵 —— 两端必须逐格一致。 */
const VALUE_MATRIX = [
  undefined, null,          // 缺行 / 缺 key ⇒ 放行 (fail-open)
  '1', 1, true,            // 显式开启 ⇒ 放行
  '0', 0, false,           // 显式关闭 ⇒ 拦截
  '', 'false', 'off',      // 其它 falsy 形态 ⇒ 拦截
  'full', '100', 'junk',   // 脏值 / 非布尔域的值 ⇒ 拦截
  ' ', '01', 'true'        // 脏值 ⇒ 拦截
];

describe('R161.6 — feature flag 判定语义 (前后端一致 + fail-open)', () => {
  test('1. 前端 / 后端两份实现逐格一致 (drift 守卫)', () => {
    const diffs = [];
    for (const v of VALUE_MATRIX) {
      const s = serverIsFlagValueEnabled(v);
      const w = webIsFlagValueEnabled(v);
      if (s !== w) diffs.push(`${JSON.stringify(v)}: server=${s} web=${w}`);
    }
    assert.deepEqual(diffs, [],
      '前后端判定语义漂移了 —— 两层口径分裂 = 界面说功能没有 / 接口说功能有。' +
      '两端实现分别在 src/utils/featureFlag.js 与 web/src/lib/featureFlag.js, ' +
      '改一处必须同时改另一处。差异:\n  ' + diffs.join('\n  '));
  });

  test('2. 语义: 缺值 ⇒ 放行; "1" ⇒ 放行; "0" ⇒ 拦截', () => {
    assert.equal(serverIsFlagValueEnabled(undefined), true, '缺行 = 未配置 = 不拦');
    assert.equal(serverIsFlagValueEnabled(null), true, 'NULL = 未配置 = 不拦');
    assert.equal(serverIsFlagValueEnabled('1'), true);
    assert.equal(serverIsFlagValueEnabled(1), true);
    assert.equal(serverIsFlagValueEnabled(true), true);
    assert.equal(serverIsFlagValueEnabled('0'), false, '显式 "0" 必须拦 (operator 的明确意图)');
    assert.equal(serverIsFlagValueEnabled(0), false);
    assert.equal(serverIsFlagValueEnabled(false), false);
    assert.equal(serverIsFlagValueEnabled('junk'), false);
  });

  test('3. readFeatureFlag: 缺行 / "1" / "0" / 读库抛错 四种情形', async () => {
    const sql = { featureFlags: { getByKey: 'SELECT ...' } };

    // 缺行 ⇒ 放行
    const missing = { sql, execute: async () => ({ rows: [] }) };
    assert.equal(await readFeatureFlag(missing, 'x.enabled', null, 'test'), true,
      '缺行 = 未配置 = 不拦');

    // "1" ⇒ 放行
    const on = { sql, execute: async () => ({ rows: [{ value: '1' }] }) };
    assert.equal(await readFeatureFlag(on, 'x.enabled', null, 'test'), true);

    // "0" ⇒ 拦截
    const off = { sql, execute: async () => ({ rows: [{ value: '0' }] }) };
    assert.equal(await readFeatureFlag(off, 'x.enabled', null, 'test'), false,
      '显式 "0" 必须拦 —— 这是"关掉真的关掉"的唯一保证');

    // 读库抛错 ⇒ 放行 (fail-open) 且**必须** warn (不静默失败)
    const warns = [];
    const boom = {
      sql,
      execute: async () => { throw new Error('db down'); }
    };
    const result = await readFeatureFlag(boom, 'x.enabled',
      { warn: (obj, msg) => warns.push({ obj, msg }) }, 'test');
    assert.equal(result, true, 'DB 抖动不该误关功能 (fail-open)');
    assert.equal(warns.length, 1, '读库失败必须 warn 一次 (严禁静默失败)');
    assert.equal(warns[0].obj.flag, 'x.enabled', 'warn 里要带上出问题的 flag key');
    assert.match(warns[0].msg, /fail-open/, 'warn 文案要说明这是 fail-open');
  });

  test('4. resolveFeatureFlag 三态: true=开 / false=关 / null=未知(放行)', () => {
    const map = { 'a.enabled': '1', 'b.enabled': '0' };
    assert.equal(resolveFeatureFlag(map, 'a.enabled'), true);
    assert.equal(resolveFeatureFlag(map, 'b.enabled'), false);
    // ★ 缺 key = 未配置 = 未知 ⇒ null (放行), **不是** false。
    //   旧实现 `map[key] === '1'` ⇒ 缺 key ⇒ false ⇒ 把用户弹回首页,
    //   这是「开关开了首页却不显示」的另一半根因。
    assert.equal(resolveFeatureFlag(map, 'c.enabled'), null,
      '缺 key 必须是 null (未知 → 放行), 不能是 false');
    assert.equal(resolveFeatureFlag({}, 'a.enabled'), null, '空 map = 未知');
    assert.equal(resolveFeatureFlag(null, 'a.enabled'), null, 'map 都没拿到 = 未知');
  });

  test('5. isFlagEnabled / areFlagsEnabled: 数组语义 = 全部满足才放行', () => {
    const map = { 'a.enabled': '1', 'b.enabled': '0' };
    assert.equal(isFlagEnabled(map, 'a.enabled'), true);
    assert.equal(isFlagEnabled(map, 'b.enabled'), false);
    assert.equal(isFlagEnabled(map, 'missing.enabled'), true, '缺 key ⇒ 放行');
    assert.equal(isFlagEnabled(null, 'a.enabled'), true, 'map 都没拿到 ⇒ 放行');
    assert.equal(areFlagsEnabled(map, ['a.enabled']), true);
    assert.equal(areFlagsEnabled(map, ['a.enabled', 'b.enabled']), false,
      '数组语义 = 全部满足 (跟后端 gateFor 的 required 数组同款)');
    assert.equal(areFlagsEnabled(map, ['a.enabled', 'missing.enabled']), true,
      '缺的 key 按"未配置=放行"处理, 不该把整条路由拦住');
    assert.equal(areFlagsEnabled(map, []), true);
  });

  test('6. 调用点不许再内联旧判定 (5 处必须全走公共实现)', () => {
    // 旧判定 (fail-closed 的那个) 在源码里的特征串。
    const LEGACY_PATTERNS = [
      /v\s*===\s*'1'\s*\|\|\s*v\s*===\s*1\s*\|\|\s*v\s*===\s*true/,
      /map\[key\]\s*===\s*'1'/
    ];
    const sites = [
      { rel: 'center/web/src/stores/featureFlags.js', must: /isFlagEnabled\(state\.flags,\s*key\)/ },
      { rel: 'center/web/src/router.js', must: /resolveFeatureFlag\(flagCache\.map,\s*key\)/ },
      { rel: 'center/web/src/views/admin/systemSettings/FeatureFlagsView.vue', must: /isFlagValueEnabled\(ffStore\.flags\[key\]\)/ },
      { rel: 'center/src/routes/report-center.js', must: /readFeatureFlag\(db,\s*key,\s*logger,\s*'report-center'\)/ },
      { rel: 'center/src/routes/mcp.js', must: /readFeatureFlag\(db,\s*'mcp\.enabled',\s*logger,\s*'mcp'\)/ },
      { rel: 'center/src/routes/mcp-write.js', must: /readFeatureFlag\(db,\s*'mcp_write\.enabled',\s*logger,\s*'mcp-write'\)/ }
    ];
    for (const site of sites) {
      const full = path.join(SERVER_ROOT, site.rel);
      assert.ok(fs.existsSync(full), `调用点文件不存在: ${site.rel}`);
      const src = stripJsComments(fs.readFileSync(full, 'utf8'));
      assert.match(src, site.must,
        `${site.rel} 没走公共实现 —— 判定语义必须只有一处定义, ` +
        '否则改了一处忘了另一处, 两层口径又会分裂');
      for (const legacy of LEGACY_PATTERNS) {
        assert.doesNotMatch(src, legacy,
          `${site.rel} 里还内联着旧的判定表达式 —— 请改成调用公共实现 ` +
          '(src/utils/featureFlag.js 或 web/src/lib/featureFlag.js)');
      }
    }
  });
});
