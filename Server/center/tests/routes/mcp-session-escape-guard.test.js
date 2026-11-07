// center/tests/routes/mcp-session-escape-guard.test.js
// R161.32 (2026-11-07) — **MCP session 初始化的进程杀手**防线
//
// ★ 背景 (这是全仓唯一真正的"进程杀手"逃逸路径):
//   Express 4 **不捕获** async handler / async 中间件的 rejection
//   (node_modules/express/lib/router/layer.js:85-97 只接**同步** throw)。
//   本项目的进程级兜底是 server.js:323 的 process.on('unhandledRejection'):
//     非 init 模式下 ⇒ log.fatal(...) + process.exit(1)
//   ⇒ 任何一个逃逸的 rejection = **中心进程直接死** (NSSM 拉起,
//     但期间整个看板 502 —— 操作员看到的是"服务不稳定")。
//
// ★ 原缺陷 (两个文件, 完全同构):
//   src/routes/mcp.js       + src/routes/mcp-write.js
//     getOrCreateSession():
//       const initPromise = (async () => { ... await server.connect(transport); ... })();
//       try { return await initPromise; }
//       finally { ... }        ← ★ 只有 finally, **没有 catch**
//       ⇒ server.connect() 的 rejection 逃出 getOrCreateSession
//     handleMcp():
//       const session = await getOrCreateSession(req);   ← ★ 在 try **之外**
//       try { await withTimeout(...) } catch { ... }
//       ⇒ rejection 一路逃到 Express 4 ⇒ unhandledRejection ⇒ 进程死
//
//   触发条件不是假想: MCP SDK 的 webStandardStreamableHttp 在 transport
//   已经启动过时会抛 'Transport already started' (并发 MCP 请求 ⇒ 常见)。
//
// ★ 修法 (两层):
//   L1 getOrCreateSession 的 `await initPromise` 加 catch ⇒ 转成带上下文的
//      Error 抛出 (不是让 rejection 逃逸);
//   L2 handleMcp 的 `await getOrCreateSession(req)` 包 try ⇒ 返回 500
//      JSON-RPC 错误, 不杀进程。
//
// ★ 本守卫锁的契约:
//   A. 两个文件里 **不许** 再出现"只有 finally 没有 catch"的 try;
//   B. handleMcp 里 `await getOrCreateSession(req)` 必须在 try 内;
//   C. gate 中间件 (async) 必须有错误路径 —— 否则请求**永久挂起**;
//   D. 负向测试 —— 证明判定器不是恒真。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { stripJsComments } from '../helpers/strip-comments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = path.resolve(HERE, '..', '..');
const ROUTES_DIR = path.join(CENTER_ROOT, 'src', 'routes');

// ★ 这两个文件必须 1:1 平行 (mcp.js 与 mcp-write.js 的 session 逻辑同构)。
const MCP_FILES = [
  { rel: 'mcp.js', label: 'mcp' },
  { rel: 'mcp-write.js', label: 'mcp-write' }
];

/**
 * 判定某个 try 块是不是"只有 finally 没有 catch"。
 *
 * ★ 为什么不能用简单的正则找 `try {` ... `}`:
 *   文件里有大量嵌套 try/catch, 必须按**花括号配平**逐块判定。
 *
 * @param {string} code 已剥注释的源码
 * @param {number} tryOffset `try` 关键字在 code 里的偏移
 * @returns {boolean} 该 try 块是否缺 catch
 */
function tryBlockLacksCatch(code, tryOffset) {
  // 从 `try` 后的第一个 '{' 开始配平。
  const openIdx = code.indexOf('{', tryOffset);
  if (openIdx < 0) return true;
  let depth = 0;
  for (let i = openIdx; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        // try 块结束。紧接着的下一个非空白 token 必须是 'catch'。
        const after = code.slice(i + 1);
        const nextToken = after.match(/^\s*(catch|finally)/);
        return nextToken === null || nextToken[1] !== 'catch';
      }
    }
  }
  return true;
}

/**
 * 判定某行是否位于某个 try 块内 (花括号配平版)。
 *
 * @param {string[]} lines 文件按行切分
 * @param {number} targetLine 目标行号 (0-based)
 * @returns {boolean}
 */
function isInsideTryBlock(lines, targetLine) {
  const stack = [];
  for (let i = 0; i <= targetLine; i += 1) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '{') stack.push('other');
      else if (ch === '}') stack.pop();
    }
    if (/^\s*try\s*\{/.test(line)) {
      if (stack.length > 0) stack[stack.length - 1] = 'try';
    }
    if (/^\s*\}?\s*catch\s*\(/.test(line)) {
      if (stack.length > 0 && stack[stack.length - 1] === 'try') {
        stack[stack.length - 1] = 'other';
      }
    }
  }
  return stack.some((kind) => kind === 'try');
}

// ---------------------------------------------------------------------------
// A. getOrCreateSession 的 await initPromise 必须有 catch
// ---------------------------------------------------------------------------

describe('A. MCP session 初始化不许"只有 finally 没有 catch"', () => {
  for (const { rel, label } of MCP_FILES) {
    test(`${rel} — await initPromise 的 try 必须有 catch`, () => {
      const raw = readFileSync(path.join(ROUTES_DIR, rel), 'utf8');
      const code = stripJsComments(raw);
      // 定位 `return await initPromise;` 所在的 try。
      const idx = code.indexOf('return await initPromise;');
      assert.ok(idx > 0, `${rel} 找不到 "return await initPromise;"`);

      // 往前找最近的 `try {` (同一缩进层)。
      const tryIdx = code.lastIndexOf('try {', idx);
      assert.ok(tryIdx > 0, `${rel} 找不到 "return await initPromise" 所属的 try`);
      // ★ 确认这个 try 确实是包着 initPromise 的那个, 而不是更外层/更内层的:
      //   try 的 '{' 到 "return await initPromise" 之间**只允许空白**,
      //   否则说明定位到了别的 try (initPromise 的 IIFE 内部也有 try)。
      const between = code.slice(
        code.indexOf('{', tryIdx) + 1,
        idx
      );
      assert.equal(between.trim(), '',
        `${rel} 定位到的 try 不是 "return await initPromise" 所属的那个 `
        + `(中间的代码是: ${JSON.stringify(between.trim().slice(0, 60))})`);

      assert.equal(tryBlockLacksCatch(code, tryIdx), false,
        `${rel}: "await initPromise" 的 try 块没有 catch ⇒ server.connect() 的 `
        + 'rejection 会逃出 getOrCreateSession ⇒ (若调用点也不在 try 内) '
        + '⇒ unhandledRejection ⇒ 中心进程死 (R161.32)');
    });
  }

  test('两个文件的 session 逻辑保持 1:1 平行 (都有 catch)', () => {
    for (const { rel } of MCP_FILES) {
      const code = stripJsComments(readFileSync(path.join(ROUTES_DIR, rel), 'utf8'));
      const idx = code.indexOf('return await initPromise;');
      assert.ok(idx > 0, `${rel} 找不到 "return await initPromise;"`);
      const tryIdx = code.lastIndexOf('try {', idx);
      assert.equal(tryBlockLacksCatch(code, tryIdx), false,
        `${rel} 缺 catch`);
    }
  });
});

// ---------------------------------------------------------------------------
// B. handleMcp 里的 await getOrCreateSession 必须在 try 内
// ---------------------------------------------------------------------------

describe('B. handleMcp 的 await getOrCreateSession 必须在 try 内', () => {
  for (const { rel } of MCP_FILES) {
    test(`${rel} — getOrCreateSession 调用点被 try 包住`, () => {
      const raw = readFileSync(path.join(ROUTES_DIR, rel), 'utf8');
      const lines = raw.split('\n');
      const sites = [];
      lines.forEach((line, idx) => {
        if (/^\s*session\s*=\s*await\s+getOrCreateSession\s*\(/.test(line)) sites.push(idx);
      });
      assert.equal(sites.length, 1,
        `${rel} 期望 1 处 "session = await getOrCreateSession(...)", 实际 ${sites.length} 处`);
      assert.ok(isInsideTryBlock(lines, sites[0]),
        `${rel}:${sites[0] + 1} 的 getOrCreateSession 调用不在任何 try 块内 ⇒ `
        + '它一旦 reject 就是 unhandledRejection ⇒ 中心进程死 (R161.32)');
    });
  }
});

// ---------------------------------------------------------------------------
// C. async 中间件 (gate / healthz) 必须有错误路径
// ---------------------------------------------------------------------------

describe('C. async 中间件必须有错误路径 (否则请求永久挂起)', () => {
  for (const { rel } of MCP_FILES) {
    test(`${rel} — gate 中间件包住 await isXxxEnabled()`, () => {
      const raw = readFileSync(path.join(ROUTES_DIR, rel), 'utf8');
      const lines = raw.split('\n');
      const sites = [];
      lines.forEach((line, idx) => {
        if (/await\s+is(Mcp|Write)Enabled\s*\(\s*\)/.test(line)
          && /enabled\s*=\s*await/.test(line)) sites.push(idx);
      });
      assert.ok(sites.length >= 2,
        `${rel} 期望 gate 和 healthz 各 1 处 feature flag 读取, 实际 ${sites.length} 处`);
      for (const idx of sites) {
        assert.ok(isInsideTryBlock(lines, idx),
          `${rel}:${idx + 1} 的 feature flag 读取不在 try 内 ⇒ 它一旦 reject ⇒ `
          + 'unhandledRejection + 请求永久挂起 ⇒ 中心进程死 (R161.32)');
      }
    });
  }

  test('report-center.js 的两个 gate 中间件都有错误路径', () => {
    const raw = readFileSync(path.join(ROUTES_DIR, 'report-center.js'), 'utf8');
    const lines = raw.split('\n');
    const sites = [];
    lines.forEach((line, idx) => {
      if (/await\s+readFlag\s*\(/.test(line)) sites.push(idx);
    });
    assert.ok(sites.length >= 2,
      `report-center.js 期望至少 2 处 readFlag, 实际 ${sites.length} 处`);
    for (const idx of sites) {
      assert.ok(isInsideTryBlock(lines, idx),
        `report-center.js:${idx + 1} 的 readFlag 不在 try 内 ⇒ rejection 逃逸 ⇒ `
        + '请求永久挂起 + 进程死 (R161.32)');
    }
  });
});

// ---------------------------------------------------------------------------
// D. 负向测试 — 证明判定器不是恒真
// ---------------------------------------------------------------------------

describe('D. 负向测试 (证明守卫不是恒真)', () => {
  test('只有 finally 的 try 块 ⇒ 判定为缺 catch', () => {
    const code = 'try {\n  return await initPromise;\n} finally {\n  cleanup();\n}';
    const tryIdx = code.indexOf('try {');
    assert.equal(tryBlockLacksCatch(code, tryIdx), true,
      '判定器把"只有 finally"的 try 判成了有 catch ⇒ 判定逻辑坏了');
  });

  test('有 catch 的 try 块 ⇒ 判定为不缺 catch', () => {
    const code = 'try {\n  return await initPromise;\n} catch (e) {\n  throw e;\n} finally {\n  cleanup();\n}';
    const tryIdx = code.indexOf('try {');
    assert.equal(tryBlockLacksCatch(code, tryIdx), false,
      '判定器把"有 catch"的 try 判成了缺 catch ⇒ 判定逻辑坏了');
  });

  test('try 块外的 await ⇒ 判定为未保护', () => {
    const lines = [
      'async function handleMcp(req, res) {',
      '  const session = await getOrCreateSession(req);',
      '  try {',
      '    await work();',
      '  } catch (e) {',
      '    res.status(500).end();',
      '  }',
      '}'
    ];
    const idx = 1;
    assert.equal(isInsideTryBlock(lines, idx), false,
      '判定器把 try 块外的 await 判成了受保护 ⇒ 守卫恒真, 没用');
  });

  test('try 块内的 await ⇒ 判定为受保护', () => {
    const lines = [
      'async function handleMcp(req, res) {',
      '  try {',
      '    const session = await getOrCreateSession(req);',
      '  } catch (e) {',
      '    res.status(500).end();',
      '  }',
      '}'
    ];
    const idx = 2;
    assert.equal(isInsideTryBlock(lines, idx), true,
      '判定器把 try 块内的 await 判成了未保护 ⇒ 判定逻辑坏了');
  });

  test('上一个 handler 的 try 不该让下一行的 await 被误判成受保护', () => {
    // ★ "往上扫最近的 try" 这种朴素做法会在这个场景判错。
    const lines = [
      "  r.get('/a', async (req, res) => {",
      '    try {',
      '      await doSomething();',
      '    } catch (e) {',
      '      res.status(500).json({});',
      '    }',
      '  });',
      "  r.get('/b', async (req, res) => {",
      '    const session = await getOrCreateSession(req);',
      '  });'
    ];
    const idx = 8;
    assert.equal(isInsideTryBlock(lines, idx), false,
      '判定器被上一个 handler 的 try 误判 ⇒ 判定逻辑有洞');
  });
});
