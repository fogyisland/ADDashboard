// R161.10 (2026-10-26) — 两处缺陷的回归网
//
// ────────────────────────────────────────────────────────────────────────────
// ① `GET /api/admin/system-settings-v2/license/requests` → 500
//
// ★ 现场 (操作员 2026-10-26 报):
//   浏览器: ":8080/api/admin/system-settings-v2/license/requests:1
//            Failed to load resource: the server responded with a status of 500"
//   中心端日志 (Server/center/logs/center.2026-10-26.1.log):
//     {"level":50,"err":"Incorrect arguments to mysqld_stmt_execute",
//      "stack":"DbError: ... at Object.query (src/db/index.js:65:101) ..."}
//
// ★ 根因:
//   mysql 侧 listByInstance 的 SQL 里有**两个** `?`
//   (WHERE instance_id = ? 与 LIMIT ?), 而唯一调用点只绑了**一个**参数
//   [instanceId] ⇒ 预处理语句的参数个数对不上 ⇒ mysqld_stmt_execute 拒执行。
//   (驱动层只在 params.length === 0 时才退回 COM_QUERY; 这里 length=1 ⇒ 走
//    预处理协议 ⇒ 参数个数必须严格对上。)
//
// ★ 为什么潜伏这么久:
//   这个 helper 从写下来到被调用**从没执行过** —— 与同文件 R93.4 修掉的
//   MSSQL `TOP (?)` 一模一样: "helper 从未被调用 ≠ helper 是对的"。
//
// ────────────────────────────────────────────────────────────────────────────
// ② 「这个审计时间是否有问题」
//
// ★ 根因 (方言分歧, MSSQL 侧零症状):
//   MySQL 基线: `created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`
//     ⇒ CURRENT_TIMESTAMP 取的是**会话时区**(默认 = 服务器 SYSTEM 时区,
//       本机是 UTC+8) —— 存进去的是**本地时间**。
//   MSSQL 基线: `created_at DATETIME2 NOT NULL DEFAULT sysutcdatetime()`
//     ⇒ 恒为 **UTC**。
//   两边基线是 1:1 对应关系 (49 处 CURRENT_TIMESTAMP ↔ 48 处 sysutcdatetime()),
//   意图明显是"都存 UTC" —— 但 MySQL 侧只在"服务器时区恰好是 UTC"时成立。
//
// ★ 为什么会显示成"偏一个时区差":
//   池子配了 `timezone: 'Z'` (客户端侧) ⇒ mysql2 把读出来的 naive DATETIME
//   字符串**当 UTC 解析**。于是本地时间 '2026-10-26 21:16:50' 被当成 UTC,
//   前端 toLocaleString 渲染成 2026-10-27 05:16:50 ⇒ 整整偏 8 小时。
//
// ★ 修法: 每条新建连接先 `SET time_zone = '+00:00'` (会话变量, 不提权,
//   不依赖 mysql 时区表) ⇒ CURRENT_TIMESTAMP 从此就是 UTC, 与 MSSQL 侧对齐,
//   与客户端 `timezone: 'Z'` 组成同一个约定的两端。
//
// ────────────────────────────────────────────────────────────────────────────
// 本文件锁住的契约:
//   A. SQL 里的 `?` 个数 == 绑定参数个数 (500 根因那一族)
//   B. clampRowLimit(): 内联进 SQL 的行数上限一定是**正整数**
//   C. 会话时区被钉在 UTC, 且失败时**出声**
//   D. 两边方言 1:1 平行 (占位符个数 / 过滤条件 / 排序)
//
// 用法: cd Server/center && node --test tests/license-request-placeholder-and-audit-tz.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSql } from '../src/db/sql.js';
import { licenseRequest as licenseRequestSql, clampRowLimit } from '../src/db/sql/license-request.js';
import { pinSessionUtc } from '../src/db/drivers/mysql.js';
import { createSystemSettingsV2Router } from '../src/routes/system-settings-v2.js';
import { stripJsComments } from './helpers/strip-comments.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = path.join(here, '..');
const REPO_ROOT = path.join(CENTER_ROOT, '..', '..');

/**
 * 读驱动源码的**代码部分** (剥掉注释)。
 * 为什么要剥: 驱动里那段 round-15 说明文字里**提到**了 '+08:00'
 * (记录"以前配过这个、已修掉"), 不剥注释的话静态断言会把注释当成代码。
 */
function readDriverCode() {
  return stripJsComments(
    fs.readFileSync(path.join(CENTER_ROOT, 'src/db/drivers/mysql.js'), 'utf8')
  );
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * 数 SQL 里的 `?` 占位符个数 (引号感知的 —— 引号里的 `?` 不算占位符)。
 */
function countPlaceholders(sql) {
  let count = 0;
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) {
        // MySQL 里 '' 与 \\' 都是转义 ⇒ 连续两个引号是"转义后的引号", 不算闭合
        if (sql[i + 1] === quote) { i++; continue; }
        if (sql[i - 1] === '\\') continue;
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '?') count++;
  }
  return count;
}

/**
 * 假 db facade —— **严格模式**: 占位符个数与绑定参数个数对不上就抛错,
 * 错误文本与 mysql2 预处理协议的生产报错**逐字一致**:
 *   "Incorrect arguments to mysqld_stmt_execute"
 * 这样本测试文件对 500 根因的还原度 = 生产一致 (不是"假 db 什么都返回空,
 * 所以测不出 500")。
 */
function makeStrictFakeDb(dialect, rows = []) {
  const calls = [];
  const enforce = (sql, params) => {
    const expected = countPlaceholders(sql);
    if (expected !== params.length) {
      throw new Error(
        `Incorrect arguments to mysqld_stmt_execute (simulated): ` +
        `SQL 有 ${expected} 个占位符, 绑了 ${params.length} 个参数`
      );
    }
  };
  const db = {
    dialect,
    sql: buildSql(dialect),
    execute: async (sql, params = []) => {
      enforce(sql, params);
      calls.push({ kind: 'execute', sql, params });
      return { rows: [], recordset: [], insertId: 1 };
    },
    query: async (sql, params = []) => {
      enforce(sql, params);
      calls.push({ kind: 'query', sql, params });
      return { rows };
    }
  };
  return { db, calls };
}

function makeLogger() {
  return { error() {}, warn() {}, info() {}, debug() {} };
}

function makeRes() {
  const out = { statusCode: 200, body: null };
  return {
    _out: out,
    status(code) { out.statusCode = code; return this; },
    json(payload) { out.body = payload; return this; },
    send(payload) { out.body = payload; return this; },
    setHeader() { return this; }
  };
}

/** 从 express Router 里取出某个端点的**最后一个** handler (绕过 auth 中间件)。 */
function findRouteHandler(router, method, routePath) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && Boolean(l.route.methods[method])
  );
  assert.ok(layer, `未找到路由 ${method.toUpperCase()} ${routePath}`);
  const handlers = layer.route.stack.map((s) => s.handle);
  return handlers[handlers.length - 1];
}

const LIST_ROUTE = '/api/admin/system-settings-v2/license/requests';

/** 驱动 listLicenseRequests 端点, 返回 { res, calls }。 */
async function callListRequests(dialect, rows = []) {
  const { db, calls } = makeStrictFakeDb(dialect, rows);
  const router = createSystemSettingsV2Router({
    db,
    requireAuth: (_req, _res, next) => next(),
    requirePerm: () => (_req, _res, next) => next(),
    logger: makeLogger()
  });
  const handler = findRouteHandler(router, 'get', LIST_ROUTE);
  const res = makeRes();
  await handler({ query: {} }, res, () => {});
  return { res, calls, db };
}

// ---------------------------------------------------------------------------
// A. 占位符个数 == 绑定参数个数 (500 根因)
// ---------------------------------------------------------------------------

describe('A. listByInstance — SQL 占位符个数必须等于绑定参数个数', () => {
  test('A1. 两边方言的 listByInstance 都是**函数形式** (行数上限内联)', () => {
    for (const dialect of ['mysql', 'mssql']) {
      assert.equal(typeof licenseRequestSql[dialect].listByInstance, 'function',
        `${dialect}.listByInstance 必须是函数形式`);
    }
  });

  test('A2. ★ 产出的 SQL 里恰好 1 个 `?` (只有 instance_id)', () => {
    for (const dialect of ['mysql', 'mssql']) {
      const sql = licenseRequestSql[dialect].listByInstance(100);
      assert.equal(countPlaceholders(sql), 1,
        `${dialect}: SQL 里的 \`?\` 个数必须恰好是 1 (instance_id), 实际 ${countPlaceholders(sql)} —— ` +
        '多一个占位符就会与绑定参数个数对不上 ⇒ mysqld_stmt_execute 报 ' +
        '"Incorrect arguments to mysqld_stmt_execute" ⇒ 端点 500');
    }
  });

  test('A3. mysql 侧不得再有 `LIMIT ?` (行数上限必须内联成整数)', () => {
    const sql = licenseRequestSql.mysql.listByInstance(100);
    assert.equal(/LIMIT\s*\?/i.test(sql), false,
      'mysql 侧仍用 `LIMIT ?` 占位符 —— 与只绑 1 个参数的调用点对不上');
    assert.match(sql, /LIMIT\s+100\s*$/, '行数上限应被内联进 SQL');
  });

  test('A4. mssql 侧不得再有 `TOP (?)` (R93.4 已经踩过这个坑)', () => {
    const sql = licenseRequestSql.mssql.listByInstance(100);
    assert.equal(/TOP\s*\(\s*\?\s*\)/i.test(sql), false,
    'mssql 侧仍用 `TOP (?)` —— sp_executesql 会抛 error 1060');
    assert.match(sql, /SELECT\s+TOP\s+100\b/i, '行数上限应被内联进 SQL');
  });

  test('A5. ★★ 端到端: 走真路由 + 严格假 db ⇒ 200 而不是 500', async () => {
    const rows = [
      { request_id: 'REQ-1', company: '示例公司', months: 2, max_nodes: 10, kind: 'base32', created_at: '2026-10-01 00:00:00' }
    ];
    for (const dialect of ['mysql', 'mssql']) {
      const { res, calls } = await callListRequests(dialect, rows);
      assert.equal(res._out.statusCode, 200,
        `${dialect}: 端点应 200, 实际 ${res._out.statusCode} body=${JSON.stringify(res._out.body)}`);
      assert.equal(res._out.body.ok, true, `${dialect}: 响应体应有 ok=true`);
      assert.equal(res._out.body.count, 1, `${dialect}: 应返回 1 条`);
      assert.equal(res._out.body.requests[0].request_id, 'REQ-1', `${dialect}: 行映射不正确`);

      // 绑定参数个数必须正好等于 SQL 占位符个数
      const call = calls.find((c) => String(c.sql).includes('ad_license_request'));
      assert.ok(call, `${dialect}: 没有看到查 ad_license_request 的调用`);
      assert.equal(call.params.length, countPlaceholders(call.sql),
        `${dialect}: 绑定参数个数 ${call.params.length} != 占位符个数 ${countPlaceholders(call.sql)}`);
      assert.equal(call.params.length, 1, `${dialect}: 应只绑 instance_id 一个参数`);
    }
  });

  test('A6. ★ 反向验证: 占位符比参数多时, 假 db 会炸 (证明 A5 真的在守这条线)', async () => {
    // 直接用严格假 db 跑一条"两个占位符只绑一个参数"的 SQL ——
    // 必须抛 "Incorrect arguments to mysqld_stmt_execute"。
    // 这条断言的意义: 防止有人把严格假 db 改成宽松模式, 让 A5 变成空断言。
    const { db } = makeStrictFakeDb('mysql', []);
    await assert.rejects(
      () => db.query('SELECT a FROM t WHERE b = ? AND c = ?', ['only-one']),
      /Incorrect arguments to mysqld_stmt_execute/
    );
  });

  test('A7. 过滤与排序口径两边一致 (只差 TOP/LIMIT 语法)', () => {
    const mysql = licenseRequestSql.mysql.listByInstance(50);
    const mssql = licenseRequestSql.mssql.listByInstance(50);
    for (const fragment of [
      'FROM ad_license_request',
      'WHERE instance_id = ? AND activated_at IS NULL',
      'ORDER BY created_at DESC'
    ]) {
      assert.ok(mysql.includes(fragment), `mysql 侧缺片段: ${fragment}`);
      assert.ok(mssql.includes(fragment), `mssql 侧缺片段: ${fragment}`);
    }
  });
});

// ---------------------------------------------------------------------------
// B. clampRowLimit — 内联进 SQL 的行数上限必须是正整数
// ---------------------------------------------------------------------------

describe('B. clampRowLimit — 内联进 SQL 的一定是正整数', () => {
  test('B1. 常规输入原样通过 (字符串数字也要认)', () => {
    assert.equal(clampRowLimit(50), 50);
    assert.equal(clampRowLimit('50'), 50);
    assert.equal(clampRowLimit(1), 1);
    assert.equal(clampRowLimit(1000), 1000);
  });

  test('B2. ★ 小数必须被截断 (否则内联出 `LIMIT 12.7` = 语法错误)', () => {
    assert.equal(clampRowLimit(12.7), 12);
    assert.equal(clampRowLimit('12.7'), 12);
    // 截断成 0 的按老语义兜底成 100 (0 是 falsy ⇒ 走 || 100 分支)
    assert.equal(clampRowLimit(0.9), 100, '0.9 截断成 0, 再被 || 兜底成 100');
  });

  test('B3. 越界/非数输入按老语义兜底 (0→100, 负数→1, 非数→100)', () => {
    assert.equal(clampRowLimit(0), 100);
    assert.equal(clampRowLimit(null), 100);
    assert.equal(clampRowLimit(undefined), 100);
    assert.equal(clampRowLimit('abc'), 100);
    assert.equal(clampRowLimit(NaN), 100);
    assert.equal(clampRowLimit(-5), 1);
    assert.equal(clampRowLimit(5000), 1000);
  });

  test('B4. ★ 产物一定是正整数 (内联进 SQL 没有任何注入面)', () => {
    const inputs = [0, 1, -1, -999, 12.7, 1000, 5000, '50', 'abc', null, undefined, NaN, Infinity, -Infinity, {}];
    for (const input of inputs) {
      const v = clampRowLimit(input);
      assert.ok(Number.isInteger(v), `clampRowLimit(${String(input)}) = ${v} 不是整数`);
      assert.ok(v >= 1 && v <= 1000, `clampRowLimit(${String(input)}) = ${v} 越界`);
    }
  });

  test('B5. 内联结果里不出现小数点 (SQL 语法安全)', () => {
    for (const input of [12.7, 0.5, '99.99']) {
      const sql = licenseRequestSql.mysql.listByInstance(input);
      const m = /LIMIT\s+([^\s]+)/i.exec(sql);
      assert.ok(m, `mysql 侧没解析出 LIMIT 子句: ${sql}`);
      assert.match(m[1], /^\d+$/, `LIMIT 后面必须是正整数, 实际 ${m[1]}`);
    }
  });
});

// ---------------------------------------------------------------------------
// C. 审计时间 — 会话时区钉在 UTC
// ---------------------------------------------------------------------------

describe('C. 会话时区 — MySQL 连接建立时必须钉到 UTC', () => {
  /** 假连接: 记录 on() 注册的事件与 query() 发出的 SQL。 */
  function makeFakeConn(queryError = null) {
    const state = { listeners: {}, queries: [] };
    const conn = {
      state,
      on(event, handler) {
        (state.listeners[event] ||= []).push(handler);
        return conn;
      },
      query(sql, cb) {
        state.queries.push(sql);
        if (typeof cb === 'function') cb(queryError);
        return conn;
      }
    };
    return conn;
  }

  test('C1. ★ 发出的必须是 `SET time_zone = \'+00:00\'` (偏移量, 不依赖时区表)', () => {
    const conn = makeFakeConn();
    pinSessionUtc(conn, () => {});
    assert.deepEqual(conn.state.queries, ["SET time_zone = '+00:00'"],
      '会话时区没有被钉到 UTC —— CURRENT_TIMESTAMP 落点会按服务器本地时区写入');
  });

  test('C2. ★ SET 必须在连接建立的**那一刻**发出 (早于任何业务查询)', () => {
    const conn = makeFakeConn();
    pinSessionUtc(conn, () => {});
    // 关键: query() 是**同步**被调用的 —— mysql2 的池在 connect 回调里先
    // emit('connection') 再把连接交给请求方, 同一条连接的命令严格 FIFO ⇒
    // 这条 SET 一定排在请求方的第一条查询之前。
    assert.equal(conn.state.queries.length, 1,
      'SET 必须在 pinSessionUtc 里同步发出, 不能被推迟到将来某个 tick');
  });

  test('C3. ★ 连接级 error 监听必须挂上 (否则未捕获异常直接崩进程)', () => {
    const conn = makeFakeConn();
    pinSessionUtc(conn, () => {});
    assert.ok(Array.isArray(conn.state.listeners.error) && conn.state.listeners.error.length === 1,
      '连接没有挂 error 监听 —— mysql2 发出的连接级致命错误会变成未捕获异常');
  });

  test('C4. ★ SET 失败必须出声 (不静默) —— 审计时间会偏, 操作员要看得见', () => {
    const conn = makeFakeConn(new Error('ER_UNKNOWN_ERROR'));
    const logs = [];
    pinSessionUtc(conn, (msg) => logs.push(msg));
    assert.equal(logs.length, 1, 'SET 失败却没有任何日志 —— 静默失败');
    assert.match(logs[0], /SET time_zone/, '日志里应说明失败的是哪条语句');
    assert.match(logs[0], /审计时间|时区/, '日志里应说明后果 (审计时间会偏)');
  });

  test('C5. 连接级错误也要出声', () => {
    const conn = makeFakeConn();
    const logs = [];
    pinSessionUtc(conn, (msg) => logs.push(msg));
    conn.state.listeners.error[0](new Error('ECONNRESET'));
    assert.equal(logs.length, 1, '连接级错误没有日志');
    assert.match(logs[0], /ECONNRESET/);
  });

  test('C6. 静态: 业务池与 server 池都注册了 connection 钩子', () => {
    const src = readDriverCode();
    // 两行接线都必须**真的指向 pinSessionUtc** (不是别的什么)
    const wiring = src.split('\n').filter((l) => /\.on\('connection'/.test(l));
    assert.equal(wiring.length, 2,
      `mysql 驱动里应有 2 处 connection 接线 (业务池 + server 池), 实际 ${wiring.length}: ${JSON.stringify(wiring)}`);
    for (const line of wiring) {
      assert.match(line, /pinSessionUtc/,
        `connection 接线没有指向 pinSessionUtc: ${line.trim()}`);
    }
    assert.ok(wiring.some((l) => /\bpool\.on\('connection'/.test(l)),
      '业务池没有注册 connection 钩子 —— 新建的连接不会被钉时区');
    assert.ok(wiring.some((l) => /serverPool\.on\('connection'/.test(l)),
      'server 池没有注册 connection 钩子 —— 建库/探测用的连接不会钉时区');
  });

  test('C7. 静态: 客户端时区是 \'Z\' 且**代码**里没有 \'+08:00\'', () => {
    const src = readDriverCode();
    assert.match(src, /timezone:\s*'Z'/, '客户端时区必须是 \'Z\' (读出来的 naive 串按 UTC 解释)');
    assert.equal(src.includes('+08:00'), false,
      '代码里出现了 \'+08:00\' —— 那正是 round-15 修掉的旧坑 (会整体偏 8 小时)');
  });

  test('C8. 静态: MySQL 基线里确实存在一整族 CURRENT_TIMESTAMP 落点 (证明不是孤例)', () => {
    const mysqlDdl = fs.readFileSync(
      path.join(REPO_ROOT, 'Server/db/migrations/mysql/1.0.0-baseline.sql'), 'utf8');
    const mssqlDdl = fs.readFileSync(
      path.join(REPO_ROOT, 'Server/db/migrations/mssql/1.0.0-baseline.sql'), 'utf8');
    const mysqlCount = (mysqlDdl.match(/DEFAULT CURRENT_TIMESTAMP/g) || []).length;
    const mssqlCount = (mssqlDdl.match(/sysutcdatetime\(\)/g) || []).length;
    assert.ok(mysqlCount > 0, 'MySQL 基线里没有 CURRENT_TIMESTAMP —— 前提变了, 本测试要重写');
    assert.ok(mssqlCount > 0, 'MSSQL 基线里没有 sysutcdatetime() —— 前提变了, 本测试要重写');
    // 两边是 1:1 对应关系 (数量级相当) ⇒ 意图就是"都存 UTC"
    assert.ok(Math.abs(mysqlCount - mssqlCount) <= 2,
      `MySQL CURRENT_TIMESTAMP (${mysqlCount}) 与 MSSQL sysutcdatetime (${mssqlCount}) ` +
      '应当是 1:1 对应关系 —— 差异过大说明基线漂移了, 需要重新评估');
  });
});

// ---------------------------------------------------------------------------
// D. 端点语义 (顺带锁住: 已激活的不返回 / instance_id 收窄)
// ---------------------------------------------------------------------------

describe('D. 端点语义 — 过滤条件在 SQL 里, 不在 JS 侧', () => {
  test('D1. 只列本机 (instance_id) 且只列未激活 (activated_at IS NULL) 的单', async () => {
    const { calls } = await callListRequests('mysql', []);
    const call = calls.find((c) => String(c.sql).includes('ad_license_request'));
    assert.ok(call, '没有看到查 ad_license_request 的调用');
    assert.match(call.sql, /WHERE instance_id = \? AND activated_at IS NULL/);
    assert.equal(call.params[0].length > 0, true, 'instance_id 必须被绑定');
  });

  test('D2. 响应只回 6 个字段 (不回整行)', async () => {
    const { res } = await callListRequests('mysql', [{
      request_id: 'R', company: 'C', months: 1, max_nodes: 5, kind: 'base32',
      created_at: '2026-10-01 00:00:00', instance_id: 'I', id: 7, signature: 'SECRET-SIGNATURE'
    }]);
    const row = res._out.body.requests[0];
    assert.deepEqual(Object.keys(row).sort(),
      ['company', 'created_at', 'kind', 'max_nodes', 'months', 'request_id'],
      '响应字段集变了 —— 注意不要把 signature / instance_id 之类的字段带出去');
    assert.equal('signature' in row, false, '响应里绝不能带签名');
  });
});
