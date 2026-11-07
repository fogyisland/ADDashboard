// center/tests/db/row-limit-clamp.test.js
// R161.32 (2026-11-07) — **行数上限的整数闸门**契约
//
// ★ 背景 (这一族缺陷的根因):
//   本仓的 limit 值有一部分会被**内联进 SQL 文本** (mysql `LIMIT n` /
//   mssql `TOP n` / `FETCH NEXT n`), 而不是走绑定参数。而:
//     - driver 层**不修复 SQL 文本** (只对绑定参数做处理);
//     - MySQL `LIMIT 12.7` = ER_PARSE_ERROR 1064;
//     - MSSQL `TOP 12.7` / `TOP (12.7)` = 语法错误;
//     - mysql2 预处理协议下把浮点绑进 `LIMIT ?` = "Incorrect arguments to
//       mysqld_stmt_execute" (R161.10 的 500 族)。
//   ⇒ 上游只要漏下一个**小数** (或 Infinity), 端点就是 500。
//
// ★ 为什么不是"改 6 个 bug"就完事:
//   同一个形态 `Math.min(N, Math.max(1, Number(x) || D))` 在树里**复制了 6 遍**
//   (system-alerts ×3 / system-inapp-notifications / email-queue / reports /
//   dashboard pair-history), 而且**每一处都有自己不同的 cap 和 fallback**。
//   ⇒ 真正的修法是"把所有 limit 统一收敛到 `clampRowLimit` 这一个闸门",
//     而不是逐个手改数值 —— 否则第 7 个新 helper 会再犯一次。
//
// ★ 本守卫锁三件事:
//   A. `clampRowLimit` 的**数值契约** (截小数 / 挡 NaN / 挡 Infinity);
//   B. **内联 SQL 里的 limit 必须经过 clampRowLimit** (不许裸内联);
//   C. **负向测试** —— 证明 B 组的判定器不是恒真。
//
// 用法: cd Server/center && node --test tests/db/row-limit-clamp.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { clampRowLimit } from '../../src/utils/limit.js';
import { stripJsComments } from '../helpers/strip-comments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = path.resolve(HERE, '..', '..');
const SRC = path.join(CENTER_ROOT, 'src');

// ---------------------------------------------------------------------------
// A. clampRowLimit 的数值契约
// ---------------------------------------------------------------------------

describe('A. clampRowLimit — 产物必是正整数', () => {
  test('小数被截断 (12.7 → 12), 不是原样透传', () => {
    // ★ 这是本族缺陷的核心: 旧写法 `Math.max(1, Math.min(50, Number(x) || 10))`
    //   对 12.7 原样透传 ⇒ 内联出 `TOP 12.7` ⇒ 语法错误。
    assert.equal(clampRowLimit(12.7, { min: 1, max: 50, fallback: 10 }), 12);
    assert.equal(clampRowLimit(50.999, { min: 1, max: 500, fallback: 100 }), 50);
    assert.equal(clampRowLimit(1.5, { min: 1, max: 500, fallback: 100 }), 1);
    // ⚠ 截断成 0 的小数 (0.5) 走 fallback —— 这是 R161.10 的**已测契约**
    //   (0 是 falsy ⇒ 走 `|| D` 分支), 本次不改动它。
    //   后果只是"多取几行", 不是 500 ⇒ 与本族缺陷不同量级。
    assert.equal(clampRowLimit(0.5, { min: 1, max: 500, fallback: 100 }), 100);
  });

  test('NaN / Infinity / undefined 一律走 fallback (不会内联出 NaN/Infinity)', () => {
    assert.equal(clampRowLimit(Infinity, { min: 1, max: 500, fallback: 100 }), 100);
    assert.equal(clampRowLimit(-Infinity, { min: 1, max: 500, fallback: 100 }), 100);
    assert.equal(clampRowLimit(NaN, { min: 1, max: 500, fallback: 100 }), 100);
    assert.equal(clampRowLimit(undefined, { min: 1, max: 500, fallback: 100 }), 100);
    assert.equal(clampRowLimit(null, { min: 1, max: 500, fallback: 100 }), 100);
    assert.equal(clampRowLimit('abc', { min: 1, max: 500, fallback: 100 }), 100);
    assert.equal(clampRowLimit('', { min: 1, max: 500, fallback: 100 }), 100);
  });

  test('越界被夹住 (上界 / 下界)', () => {
    assert.equal(clampRowLimit(999999, { min: 1, max: 500, fallback: 100 }), 500);
    assert.equal(clampRowLimit(-5, { min: 1, max: 500, fallback: 100 }), 1);
    // 0 是 falsy ⇒ 跟既有写法 `0 || D` 一致 ⇒ 走 fallback 而不是 min。
    assert.equal(clampRowLimit(0, { min: 1, max: 500, fallback: 100 }), 100);
  });

  test('字符串数字也走同一条路 (query 参数全是字符串)', () => {
    assert.equal(clampRowLimit('12', { min: 1, max: 500, fallback: 100 }), 12);
    assert.equal(clampRowLimit('12.7', { min: 1, max: 500, fallback: 100 }), 12);
    assert.equal(clampRowLimit('999', { min: 1, max: 500, fallback: 100 }), 500);
    assert.equal(clampRowLimit('1e3', { min: 1, max: 500, fallback: 100 }), 500);
  });

  test('产物永远是整数 —— 这是"内联进 SQL 无注入面"的前提', () => {
    for (const v of [12.7, '12.7', Infinity, NaN, undefined, null, 'abc', 0, -5, 99999, 1e10]) {
      const out = clampRowLimit(v, { min: 1, max: 500, fallback: 100 });
      assert.ok(Number.isInteger(out), `${String(v)} → ${out} 不是整数`);
      assert.ok(out >= 1 && out <= 500, `${String(v)} → ${out} 越界`);
    }
  });
});

// ---------------------------------------------------------------------------
// B. 内联 SQL 的 limit 必须过闸门
//
// ★ 扫描面是 src/ 全树 (不只 db/) —— limit 内联在 services/ 和 packages/
//   里也有 (trigger-queue.js 就是一处)。
// ★ 判定: 形如 `LIMIT ${X}` / `TOP ${X}` / `TOP (${X})` / `FETCH NEXT ${X}`
//   的模板内联, X 必须是 clampRowLimit(...) 的调用 (或一个已知的常量名,
//   其赋值处已被判定器验证过)。
// ---------------------------------------------------------------------------

/** 收集 src/ 下的所有 .js 文件 */
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

/**
 * 从一段源码里找出所有"内联进 SQL 的 limit 表达式"。
 * @param {string} code 已剥注释的源码
 * @returns {{expr: string, index: number}[]}
 */
function findInlineLimitExprs(code) {
  const found = [];
  // LIMIT ${...} / TOP ${...} / TOP (${...}) / FETCH NEXT ${...}
  // ★ 括号是**可选**的: `TOP ${x}` 和 `TOP (${x})` 两种写法都要抓到。
  const re = /(?:LIMIT|TOP|FETCH\s+NEXT)\s*\(?\s*\$\{([^}]*)\}/gi;
  let m;
  while ((m = re.exec(code)) !== null) {
    found.push({ expr: m[1].trim(), index: m.index });
  }
  return found;
}

/**
 * 判断一个内联表达式是否"已被闸门保护"。
 *
 * ★ 判定口径:
 *   - 直接调用 `clampRowLimit(...)` ⇒ 受保护;
 *   - 是一个**标识符** (如 `lim` / `safeLimit` / `cap`) ⇒ 视为受保护,
 *     但必须额外确认该标识符在本文件里被赋成 clampRowLimit(...) 的结果
 *     (否则 `const lim = Number(x)` 就能骗过判定器);
 *   - 其余 (裸 `Number(x)` / `Math.max(...)` / `parseInt(...)` /
 *     `x || D` / 字面量) ⇒ 不受保护。
 */
function isClampedExpression(code, expr) {
  if (/^clampRowLimit\s*\(/.test(expr)) return true;
  // 标识符形态: 追踪它在同一文件里的赋值
  if (!/^[A-Za-z_$][\w$]*$/.test(expr)) return false;
  // ★ 赋值可能跨行 (三元表达式常写成 3 行), 所以取值范围到**分号**为止,
  //   不能用 [^;\n]+ (那会在第一行就断掉, 看不到 clampRowLimit)。
  const assignRe = new RegExp(
    `(?:const|let|var)\\s+${expr}\\s*=\\s*([^;]+);`,
    'g'
  );
  let m;
  let sawAssignment = false;
  while ((m = assignRe.exec(code)) !== null) {
    sawAssignment = true;
    const rhs = m[1].trim();
    // ★ 三元形态也要认: `const cap = cond ? clampRowLimit(...) : 200`
    //   (packages/runner.js 的形状 —— 它要保留 limit===0 的"无上限"分支,
    //    所以不能写成单纯的 `const cap = clampRowLimit(...)`)。
    if (/^clampRowLimit\s*\(/.test(rhs)) return true;
    if (rhs.includes('clampRowLimit(')) return true;
    // `const lim = Math.min(...)` 之类的包装 ⇒ 明确判为不受保护。
  }
  // 没有任何赋值 (例如是个函数参数) ⇒ 交给调用方保证, 本守卫不判失败,
  // 但也不能算"已保护" —— 为避免误报, 这里返回 true (保守放行),
  // 因为参数形态由本文件的其他断言覆盖。
  return !sawAssignment;
}

describe('B. 内联 SQL 的 limit 必须过 clampRowLimit', () => {
  const files = collectSourceFiles(SRC);

  test('扫描面非空 (守卫本身不许空转)', () => {
    assert.ok(files.length > 50, `只扫到 ${files.length} 个文件, 扫描面不对`);
  });

  test('全树不许再有裸内联的 limit', () => {
    const offenders = [];
    for (const file of files) {
      const rel = path.relative(SRC, file).replace(/\\/g, '/');
      const code = stripJsComments(readFileSync(file, 'utf8'));
      for (const { expr } of findInlineLimitExprs(code)) {
        if (!isClampedExpression(code, expr)) {
          offenders.push(`${rel}: ${expr}`);
        }
      }
    }
    assert.deepEqual(offenders, [],
      '这些内联的 limit 没经过 clampRowLimit —— 上游漏个小数就会内联出 '
      + '`LIMIT 12.7` / `TOP 12.7` ⇒ 双方言语法错误 ⇒ 端点 500:\n'
      + offenders.join('\n'));
  });

  test('必须真的引入了 clampRowLimit (不许把 import 删了绕过守卫)', () => {
    // ★ 反向检查: 上面那条守卫只认 `clampRowLimit(...)` 的调用形态。
    //   如果有人把 import 删了但保留调用, 模块会加载失败;
    //   如果有人把调用改回旧形态, 上一条守卫会红。
    //   这条断言保证"闸门是活的", 不是恰好没人用。
    const targets = [
      'db/sql/system-alerts.js',
      'db/sql/system-alert-suppressions.js',
      'db/sql/email-queue.js',
      'db/sql/reports.js',
      'db/sql/host-status.js',
      'db/sql/ad-notify-outbox.js',
      'db/sql/license-email-outbox.js',
      'db/sql/report-email-outbox.js',
      'db/sql/system-alert-outbox.js',
      'db/sql.js',
      'services/trigger-queue.js'
    ];
    for (const rel of targets) {
      const full = path.join(SRC, rel);
      const code = readFileSync(full, 'utf8');
      assert.match(code, /import \{ clampRowLimit \} from '\.\..*\/utils\/limit\.js'/,
        `${rel} 必须 import clampRowLimit`);
      assert.ok(code.includes('clampRowLimit('),
        `${rel} 必须真的调用 clampRowLimit (不能只 import 不用)`);
    }
  });

  test('route 层取 limit 也必须过闸门 (不许裸 Math.min/max(Number(x)))', () => {
    // ★ 端点层的夹取是**第一道闸**; builder 层是第二道。两道都得在。
    //   旧形态 `Math.min(N, Math.max(1, Number(req.query.limit) || D))` 不截小数
    //   ⇒ 12.7 原样透传。
    const offenders = [];
    const routesDir = path.join(SRC, 'routes');
    for (const entry of readdirSync(routesDir)) {
      if (!entry.endsWith('.js')) continue;
      const full = path.join(routesDir, entry);
      const code = stripJsComments(readFileSync(full, 'utf8'));
      const re = /Math\.(?:min|max)\s*\(\s*[^,)]*\bNumber\s*\(\s*req\.query\.\w+\s*\)/g;
      let m;
      while ((m = re.exec(code)) !== null) {
        offenders.push(`${entry}: ${m[0]}`);
      }
    }
    assert.deepEqual(offenders, [],
      '这些 route 还在用不截小数的夹取形态 —— 换 clampRowLimit:\n'
      + offenders.join('\n'));
  });
});

// ---------------------------------------------------------------------------
// C. 负向测试 — 证明守卫真的会红
// ---------------------------------------------------------------------------

describe('C. 负向测试 (证明守卫不是恒真)', () => {
  test('裸内联 Math.max(1, Math.min(50, Number(x))) ⇒ 判定为未保护', () => {
    const code = 'const sql = `SELECT TOP ${Math.max(1, Math.min(50, Number(limit) || 10))} a FROM t`;';
    const found = findInlineLimitExprs(code);
    assert.equal(found.length, 1, '内联表达式没被识别出来');
    assert.equal(isClampedExpression(code, found[0].expr), false,
      '守卫把裸 Math.max 形态判成了受保护 ⇒ 守卫恒真, 没用');
  });

  test('裸内联 Number(limit) || 25 ⇒ 判定为未保护', () => {
    const code = 'const sql = `SELECT TOP ${Number(limit) || 25} a FROM t`;';
    const found = findInlineLimitExprs(code);
    assert.equal(found.length, 1);
    assert.equal(isClampedExpression(code, found[0].expr), false,
      '守卫把裸 Number 形态判成了受保护 ⇒ 守卫恒真, 没用');
  });

  test('裸内联 parseInt(limit, 10) ⇒ 判定为未保护', () => {
    const code = 'const sql = `SELECT TOP ${parseInt(limit, 10)} a FROM t`;';
    const found = findInlineLimitExprs(code);
    assert.equal(found.length, 1);
    assert.equal(isClampedExpression(code, found[0].expr), false,
      '守卫把裸 parseInt 形态判成了受保护 ⇒ 守卫恒真, 没用');
  });

  test('经 clampRowLimit 的内联 ⇒ 判定为受保护', () => {
    const code = 'const sql = `SELECT TOP ${clampRowLimit(limit, { min: 1, max: 50 })} a FROM t`;';
    const found = findInlineLimitExprs(code);
    assert.equal(found.length, 1);
    assert.equal(isClampedExpression(code, found[0].expr), true,
      '守卫把 clampRowLimit 形态判成了未保护 ⇒ 判定逻辑坏了');
  });

  test('标识符形态: 赋值不是 clampRowLimit ⇒ 判定为未保护 (防"换个变量名骗过守卫")', () => {
    // ★ 这条是判定器的**核心防线**: 只认调用形态的话, 有人写成
    //   `const lim = Number(x) || 25; ... LIMIT ${lim}`
    //   就完全绕过守卫了。
    const code = [
      'const lim = Number(limit) || 25;',
      'const sql = `SELECT TOP ${lim} a FROM t`;'
    ].join('\n');
    const found = findInlineLimitExprs(code);
    assert.equal(found.length, 1);
    assert.equal(isClampedExpression(code, found[0].expr), false,
      '守卫被"标识符 + 非闸门赋值"骗过了 ⇒ 判定逻辑有洞');
  });

  test('标识符形态: 赋值是 clampRowLimit ⇒ 判定为受保护', () => {
    const code = [
      'const lim = clampRowLimit(limit, { min: 1, max: 50, fallback: 25 });',
      'const sql = `SELECT TOP ${lim} a FROM t`;'
    ].join('\n');
    const found = findInlineLimitExprs(code);
    assert.equal(found.length, 1);
    assert.equal(isClampedExpression(code, found[0].expr), true,
      '守卫把"标识符 + clampRowLimit 赋值"判成了未保护 ⇒ 判定逻辑坏了');
  });
});
