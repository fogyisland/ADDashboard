// center/tests/routes/async-rejection-guard.test.js
// R161.31 (2026-11-07) — route handler 的 async rejection 防线
//
// ★ 背景 (为什么这条要单独立一个守卫):
//   Express 4 **不捕获** async handler 里的 rejection。这个项目的进程级兜底
//   是 server.js:323 的 process.on('unhandledRejection', ...):
//     非 init 模式下 ⇒ log.fatal(...) + process.exit(1)
//   ⇒ route handler 里任何一个**逃逸**的 await rejection = **中心进程直接死**
//   (NSSM 会拉起来, 但期间整个看板 502 —— 操作员看到的是"服务不稳定")。
//
//   项目的 house style 是每个 handler 内部写 try/catch。这是对的, 但
//   **"try 块之外还有 await"** 这一类漏洞靠人眼是看不出来的 —— 代码里
//   有一处 `await _auditAdCommand(...)` 写在 try/catch **后面**, 看起来完全
//   正常 (前一个 await 明明在 try 里), 但它一旦 reject 就是进程杀手。
//
// ★ 为什么这条守卫是**源码级静态契约**而不是运行时测试:
//   要在运行时证明"rejection 不会逃逸", 得真的挂 Express + 真的让 DB 抛错,
//   成本高且脆。⇒ 这里锁的是**源码形状**: 关键 await 必须被 try 包裹。
//   ⇒ 配合"负向测试"证明这条守卫真的会红 (见本文件末尾)。
//
// 用法: cd Server/center && node --test tests/routes/async-rejection-guard.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { stripJsComments } from '../helpers/strip-comments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = path.resolve(HERE, '..', '..');
const ROUTES_DIR = path.join(CENTER_ROOT, 'src', 'routes');
const SERVER_JS = path.join(CENTER_ROOT, 'server.js');

// ---------------------------------------------------------------------------
// A. 进程级兜底的行为 (守卫的前置事实)
// ---------------------------------------------------------------------------

describe('A. 进程级兜底 — unhandledRejection 在非 init 模式下会杀进程', () => {
  test('server.js 必须注册 unhandledRejection 处理器', () => {
    const src = readFileSync(SERVER_JS, 'utf8');
    assert.match(src, /process\.on\(\s*['"]unhandledRejection['"]/,
      'server.js 必须注册 unhandledRejection 处理器 —— 否则逃逸的 rejection 静默挂死');
  });

  test('非 init 模式下必须 process.exit(1) (不许静默继续)', () => {
    const src = readFileSync(SERVER_JS, 'utf8');
    const handler = src.slice(src.indexOf("process.on('unhandledRejection'"));
    assert.ok(handler.length > 0, '找不到 unhandledRejection 处理器');
    assert.match(handler, /process\.exit\(1\)/,
      'unhandledRejection 必须让进程退出 —— 继续跑等于带着未知状态');
  });

  test('init 模式必须豁免 (db not initialized 不能杀进程)', () => {
    const src = readFileSync(SERVER_JS, 'utf8');
    const handler = src.slice(src.indexOf("process.on('unhandledRejection'"));
    assert.match(handler, /db not initialized/,
      'init 模式的 unhandledRejection 必须豁免');
  });
});

// ---------------------------------------------------------------------------
// B. 关键 await 的源码形状契约
//
// ★ 覆盖面是**刻意收窄**的:
//   全仓 672 个 await, "每个 await 都在 try 里" 是无法静态判定的 (try 可能
//   在调用方、可能在链上)。⇒ 这里只锁**已知的、曾经出过问题的具体几处**,
//     并且要求**白名单每条都带理由** —— 不是"扫全仓找违规", 而是"这几处
//     永远不许退回去"。
//   ⇒ 形状变化 (比如把 await 挪到别的位置) 会让守卫变红, 这是**故意的**:
//     改这块的人必须先读白名单里的理由。
// ---------------------------------------------------------------------------

/**
 * 判定某一行是否位于某个 try 块的**内部**。
 *
 * ★ 为什么不能用"往上找最近的 try 行"这种朴素做法:
 *   往上扫会撞上一个**更早的 handler** 里的 catch 行 (或 try 行), 从而
 *   得出完全错误的结论。⇒ 必须做**花括号配平**: 从文件头一路扫到目标行,
 *   维护一个栈, 记录每个未闭合的块是 try 还是 catch。
 *
 * @param {string[]} lines 文件按行切分
 * @param {number} targetLine 目标行号 (0-based)
 * @returns {boolean} 目标行是否在某个 try 块内
 */
function isInsideTryBlock(lines, targetLine) {
  // 栈里存每个未闭合块的类型: 'try' | 'other'
  const stack = [];
  let inTemplate = false;

  for (let i = 0; i <= targetLine; i += 1) {
    let line = lines[i];
    // 粗略剔除字符串/模板里的花括号 —— 只处理"同一条语句里成对出现"的
    // 情况 (SQL 模板里的 '{}' 基本都是成对的, 所以按对消计数即可)。
    for (const ch of line) {
      if (ch === '{') {
        stack.push('other');
      } else if (ch === '}') {
        stack.pop();
      }
    }
    // 识别 try 块的开启: "try {" 里的那个 '{' 刚被压栈。
    if (/^\s*try\s*\{/.test(line)) {
      // 找到刚才压进去的最后一个 '{' 是不是本行的 ⇒ 是则标记为 try。
      // (本行只可能压进一个 '{', 所以直接改栈顶。)
      if (stack.length > 0) stack[stack.length - 1] = 'try';
    }
    // catch 的 '{' 覆盖 try 标记 (catch 块本身不是 try)。
    if (/^\s*\}?\s*catch\s*\(/.test(line)) {
      // catch 行本身通常带 '{' (在行尾) ⇒ 栈顶刚压入的是 catch 的 '{'。
      // 但形如 "} catch (e) {" 的写法里, '}' 会先弹栈, '{' 再压栈。
      if (stack.length > 0 && stack[stack.length - 1] === 'try') {
        // '}' 已经把 try 弹掉了, 现在栈顶是 catch 的 '{' ⇒ 标记 other。
        stack[stack.length - 1] = 'other';
      }
    }
    void inTemplate;
  }

  return stack.some((kind) => kind === 'try');
}

describe('B. 关键 await 的形状契约 (审计写不许逃逸成进程杀手)', () => {
  const ADMIN_JS = path.join(ROUTES_DIR, 'admin.js');

  test('扫描面非空 (守卫本身不许空转)', () => {
    const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js'));
    assert.ok(files.length >= 20, `只扫到 ${files.length} 个 route 文件, 扫描面不对`);
  });

  test('admin.js 的三处 _auditAdCommand 必须被 try 包住', () => {
    const raw = readFileSync(ADMIN_JS, 'utf8');
    const lines = raw.split('\n');
    const sites = [];
    lines.forEach((line, idx) => {
      // 只认真正的调用 (排除注释里提到函数名的那几行)。
      if (/^\s*await\s+_auditAdCommand\s*\(/.test(line)) sites.push(idx);
    });
    assert.equal(sites.length, 3, `期望 3 处 _auditAdCommand 调用, 实际 ${sites.length} 处`);

    for (const idx of sites) {
      assert.ok(isInsideTryBlock(lines, idx),
        `admin.js:${idx + 1} 的 _auditAdCommand 调用不在任何 try 块内 ⇒ `
        + '它一旦 reject 就是 unhandledRejection ⇒ 中心进程死 (R161.31)');
    }
  });

  test('_auditAdCommand 的 writeAudit 调用本身必须在 try 内 (第二层防御)', () => {
    const raw = readFileSync(ADMIN_JS, 'utf8');
    const start = raw.indexOf('async function _auditAdCommand(');
    assert.ok(start > 0, '找不到 _auditAdCommand 定义');
    const body = raw.slice(start, start + 2000);
    // _auditAdCommand 里唯一的 await 是 writeAudit(...), 它必须在 try 内 ——
    // 这样即使 writeAudit 将来改成 fail-close, 这个 helper 自己也不会 reject。
    assert.match(body, /try\s*\{/, '_auditAdCommand 内部必须有 try/catch (第二层防御)');
    assert.match(body, /catch\s*\(/, '_auditAdCommand 内部必须有 catch');
  });

  test('writeAudit 的非 tx 分支必须吞异常 (第三层防御)', () => {
    const auditSrc = readFileSync(path.join(CENTER_ROOT, 'src', 'services', 'audit.js'), 'utf8');
    const start = auditSrc.indexOf('export async function writeAudit(');
    assert.ok(start > 0, '找不到 writeAudit 定义');
    const body = auditSrc.slice(start, start + 1200);
    assert.match(body, /catch\s*\(/, 'writeAudit 必须有 catch');
    assert.match(body, /if\s*\(\s*tx\s*\)\s*throw/, 'writeAudit 只在 tx 模式下 re-throw');
  });

  test('admin.js 里只许有一处 process.exit (显式重启端点), 且它必须在 res 之后', () => {
    // ★ 例外: POST /api/admin/restart —— 它**故意**让进程退出 (NSSM 会拉起来,
    //   为了让改过的 listenPort / appsettings.json 生效)。这是唯一的合法
    //   process.exit 位置。
    //   ⇒ 断言: 只有 1 处 process.exit(0), 且它在 "res.json(...)" **之后**
    //     (否则 NSSM 重启会跟内核 TCP 缓冲 flush 抢跑, 操作员 UI 挂在请求上)。
    const src = stripJsComments(readFileSync(ADMIN_JS, 'utf8'));
    const exits = [...src.matchAll(/process\.exit\s*\(/g)];
    assert.equal(exits.length, 1,
      `admin.js 里只许有 1 处 process.exit (显式重启端点), 实际 ${exits.length} 处 —— `
      + 'route handler 里 exit = 整个看板下线, 而不是单个请求失败');
    assert.match(src, /res\.json\(\{[\s\S]{0,200}?\}\);\s*setImmediate\(\(\)\s*=>\s*process\.exit\(0\)\)/,
      'process.exit 必须在 res.json 之后 (setImmediate 延迟)');
  });
});

// ---------------------------------------------------------------------------
// C. 负向测试 — 证明守卫真的会红 (否则前面全是恒真断言)
// ---------------------------------------------------------------------------

describe('C. 负向测试 (证明守卫不是恒真)', () => {
  test('把 _auditAdCommand 挪出 try ⇒ 守卫必须报错', () => {
    // 这里**不复用** B 组的判定逻辑 (那会变成"自己测自己"的循环论证),
    // 而是直接用 B 组的判定器跑一份**人工构造的坏样本**, 断言它判为"未保护"。
    const lines = [
      "    let row;",
      "    try {",
      "      row = await queueCommand({ targetDc });",
      "    } catch (e) {",
      "      return res.status(500).json({ error: 'x' });",
      "    }",
      "    await _auditAdCommand(req, row, commandType, params, logger);",
      "    res.status(201).json({ id: row.id });"
    ];
    const idx = lines.findIndex((l) => /await\s+_auditAdCommand\s*\(/.test(l));
    assert.ok(idx > 0, '样本构造失败');
    assert.equal(isInsideTryBlock(lines, idx), false,
      '守卫的判定逻辑把"try 块外的 await"判成了受保护 ⇒ 守卫恒真, 没用');
  });

  test('把 _auditAdCommand 放回 try 内 ⇒ 守卫必须判为受保护', () => {
    const lines = [
      "    let row;",
      "    try {",
      "      row = await queueCommand({ targetDc });",
      "      await _auditAdCommand(req, row, commandType, params, logger);",
      "    } catch (e) {",
      "      return res.status(500).json({ error: 'x' });",
      "    }",
      "    res.status(201).json({ id: row.id });"
    ];
    const idx = lines.findIndex((l) => /await\s+_auditAdCommand\s*\(/.test(l));
    assert.equal(isInsideTryBlock(lines, idx), true,
      '守卫把 try 块内的 await 判成了未保护 ⇒ 判定逻辑坏了');
  });

  test('try 块外面再嵌套一个 handler ⇒ 不能被更早的 try 误判成受保护', () => {
    // ★ 这是"朴素往上扫"会出错的场景: 上一个 handler 的 try/catch 还在栈上,
    //   但当前这行在**它外面** ⇒ 必须是"未保护"。
    const lines = [
      "  r.get('/a', async (req, res) => {",
      "    try {",
      "      await doSomething();",
      "    } catch (e) {",
      "      res.status(500).json({});",
      "    }",
      "  });",
      "  r.get('/b', async (req, res) => {",
      "    await _auditAdCommand(req, row, commandType, params, logger);",
      "    res.json({});",
      "  });"
    ];
    const idx = lines.findIndex((l) => /await\s+_auditAdCommand\s*\(/.test(l));
    assert.equal(isInsideTryBlock(lines, idx), false,
      '守卫被上一个 handler 的 try 块误判 ⇒ 判定逻辑有洞');
  });
});
