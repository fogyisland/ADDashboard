// R161.6 — init 建库 / 基线 apply 的「固定连接 + 库名校验 + 驱动能力面」回归网
//
// ★ 背景 (R161.6 的两条根因, 本文件逐条锁住):
//
//   ① 固定连接 (session pinning)
//      MySQL 基线的幂等守卫是四条独立语句:
//        SET @s = (SELECT IF(<INFORMATION_SCHEMA 探针>, '<DDL>', 'SELECT 1'));
//        PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
//      @s 是**会话变量**, stmt 是**会话级预备语句** —— 只有这几条落在**同一条
//      连接**上时, PREPARE 才拿得到刚刚 SET 的 @s。逐条 db.execute (每次从池里
//      借还连接) 不保证连续 ⇒ PREPARE FROM NULL (ER_PARSE_ERROR 1064) 或拿到
//      上一轮的陈旧 @s (⇒ 重复执行上一轮的 ALTER → ER_DUP_FIELDNAME 1060)。
//      ⇒ MySQL 侧必须走 driver.session(); MSSQL 侧**不能**有 session() —— 它的
//        守卫是自包含的 `IF NOT EXISTS (...) BEGIN ... END` 单批语句, 不依赖会话
//        状态, 加了反而会改变 MSSQL 的既有行为。
//
//   ② server 级连接 (建库 + 向导第 1 步)
//      池是按 `database: <目标库>` 建的, 目标库还不存在时**握手阶段**就
//      ER_BAD_DB_ERROR (1049) ⇒ CREATE DATABASE 那一句根本执行不到, 向导第 1 步
//      的"测试连接"也必然失败 ⇒ 操作员被永久卡在第 1 步, 走不到第 3 步。
//      ⇒ 建库/探测必须走 driver 的 server 级连接 (createDatabase / probeServer /
//        databaseExists), 且库名必须先过白名单校验 (库名会拼进 DDL)。
//
// 用法: cd Server/center && node --test tests/init-session-pinning.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { applyAll, splitSqlStatements } from '../src/init/schema-applier.js';
import { initRouter } from '../src/init/router.js';
import { assertValidDatabaseName } from '../src/utils/dbName.js';
import { createMysqlDriver } from '../src/db/drivers/mysql.js';
import { createMssqlDriver } from '../src/db/drivers/mssql.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Server/ — 其下有 db/migrations/{mysql,mssql}/1.0.0-baseline.sql
const REPO_ROOT = path.resolve(HERE, '..', '..');
const MYSQL_BASELINE = path.join(REPO_ROOT, 'db', 'migrations', 'mysql', '1.0.0-baseline.sql');
const MSSQL_BASELINE = path.join(REPO_ROOT, 'db', 'migrations', 'mssql', '1.0.0-baseline.sql');
const MYSQL_DRIVER = path.join(REPO_ROOT, 'center', 'src', 'db', 'drivers', 'mysql.js');

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    error() {}, warn() {}, info() {}, debug() {},
    calls: { error: 0, warn: 0, info: 0 }
  };
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

/** 从 express Router 里取出某个端点的最后一个 handler (绕过前置中间件)。 */
function findRouteHandler(router, method, routePath) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && Boolean(l.route.methods[method])
  );
  assert.ok(layer, `未找到路由 ${method.toUpperCase()} ${routePath}`);
  const handlers = layer.route.stack.map((s) => s.handle);
  return handlers[handlers.length - 1];
}

/**
 * 假 db —— 记录语句走到哪条通道上。
 *   opts.withSession !== false ⇒ 提供 session() (MySQL 形态)
 *   opts.withSession === false  ⇒ 不提供 (MSSQL 形态)
 *   opts.onExecute(sql)        ⇒ 逐条语句的钩子 (用来抛错)
 */
function makeRecordingDb(opts = {}) {
  const calls = { direct: [], session: [] };
  const run = async (sql, params, bucket) => {
    bucket.push({ sql, params });
    if (opts.onExecute) await opts.onExecute(sql, params);
    return { rows: [], affectedRows: 0, insertId: undefined };
  };
  const db = {
    dialect: 'mysql',
    async execute(sql, params = []) { return run(sql, params, calls.direct); },
    async query(sql, params = []) { return run(sql, params, calls.direct); }
  };
  if (opts.withSession !== false) {
    db.session = async (work) => {
      const sess = {
        async execute(sql, params = []) { return run(sql, params, calls.session); },
        async query(sql, params = []) { return run(sql, params, calls.session); }
      };
      return work(sess);
    };
  }
  return { db, calls };
}

/** 造一个带 code / number / originalError 的错误 (对齐 DbError 的形状)。 */
function makeError({ code, number, message, originalError }) {
  const e = new Error(message || 'boom');
  if (code) e.code = code;
  if (typeof number === 'number') e.number = number;
  if (originalError) e.originalError = originalError;
  return e;
}

/**
 * 剥掉 SQL 注释 —— 复用**生产**的 splitSqlStatements (它按行扫, 行注释分支先于
 * 块注释分支命中)。
 *
 * ★ 为什么不能自己写正则版:
 *   朴素的两段 replace (先剥块注释、再剥行注释) 会把 MSSQL 基线从 156896 字节
 *   砍到 15466 字节 —— 因为该文件有一行注释里写着一个带星号的 glob 路径
 *     `--  · agent 侧 packages/ad_dc_overview/<星号>/collect.ps1 明确`
 *   路径里的"斜杠+星号"被当成块注释开头, 一直吃到 143 KB 之后的一个
 *   "星号+斜杠" ⇒ 任何"先剥块注释再剥行注释"的工具都会在这份基线上静默
 *   吃掉 90% 的内容。
 *   生产切分器是从左往右逐字符扫的, 遇到 `-` 先判定为行注释并吃掉整行 ⇒ 安全。
 */
function stripSqlComments(file) {
  return splitSqlStatements(readFileSync(file, 'utf8')).join('\n');
}

/** 去掉 JS 注释 (只看代码, 不看注释里的字样) —— 用来断言"选项真的没了"。 */
function stripJsComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl >= 0 ? nl : src.length;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end >= 0 ? end + 2 : src.length;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 从一份基线里取出全部外键约束名 (MySQL 内联 / MSSQL ALTER ADD 两种写法)。 */
function extractForeignKeyNames(file) {
  const src = stripSqlComments(file);
  const names = new Set();
  for (const m of src.matchAll(/CONSTRAINT\s+\[?(fk_[A-Za-z0-9_]+)\]?/g)) {
    names.add(m[1].toLowerCase());
  }
  return names;
}

// ---------------------------------------------------------------------------
// A. 固定连接 (session pinning)
// ---------------------------------------------------------------------------

describe('A. 基线 apply 必须跑在固定连接上', () => {
  test('db 提供 session() 时, 全部语句走 session 通道, db.execute 一次都没被调用', async () => {
    const { db, calls } = makeRecordingDb({ withSession: true });
    const applied = await applyAll('mysql', db, { repoRoot: REPO_ROOT });

    assert.ok(applied.schema.length > 0, '基线应切出语句');
    assert.equal(calls.session.length, applied.schema.length,
      `session 通道应收到全部 ${applied.schema.length} 条语句, 实际 ${calls.session.length}`);
    assert.equal(calls.direct.length, 0,
      `db.execute 不应被调用 (那会逐条借还连接 ⇒ @s/stmt 断链), 实际 ${calls.direct.length} 次`);
  });

  test('db 不提供 session() 时 (MSSQL 形态), 逐条 db.execute —— 与从前逐字一致', async () => {
    const { db, calls } = makeRecordingDb({ withSession: false });
    const applied = await applyAll('mysql', db, { repoRoot: REPO_ROOT });

    assert.ok(applied.schema.length > 0, '基线应切出语句');
    assert.equal(calls.direct.length, applied.schema.length,
      `db.execute 应收到全部 ${applied.schema.length} 条语句, 实际 ${calls.direct.length}`);
    assert.equal(calls.session.length, 0, '没有 session() 时不该有 session 通道');
  });
});

// ---------------------------------------------------------------------------
// B. 幂等冲突判定必须穿过 DbError 包装
// ---------------------------------------------------------------------------

describe('B. 幂等冲突判定穿过 DbError 包装', () => {
  // 运行时那条路径 (src/db/index.js) 会把驱动错误包成 DbError:
  //   顶层 code = 归一化后的名字 (ER_DUP_FIELDNAME 不在映射表里 ⇒ 'UNKNOWN')
  //   原始错误挂在 originalError 上
  // ⇒ 只看表层 err.code 会**漏判** ⇒ "目标对象已存在"照样把 bootstrap 打挂。
  test('顶层 code=UNKNOWN 但 originalError.code=ER_DUP_FIELDNAME ⇒ 判为幂等冲突, 跳过并留痕', async () => {
    const inner = makeError({ code: 'ER_DUP_FIELDNAME', message: "Duplicate column name 'computers_count'" });
    const wrapped = makeError({ code: 'UNKNOWN', message: `未知错误: ${inner.message}`, originalError: inner });
    const { db } = makeRecordingDb({
      onExecute: (sql) => {
        if (sql.includes('ADD COLUMN computers_count')) throw wrapped;
      }
    });

    const applied = await applyAll('mysql', db, { repoRoot: REPO_ROOT, databaseName: 'b_dup_fieldname' });

    assert.equal(applied.conflicts.length, 1,
      `应记录 1 条幂等冲突, 实际 ${applied.conflicts.length}: ${JSON.stringify(applied.conflicts)}`);
    // 记录里必须留**原始**错误码 (DbError 归一化后是 'UNKNOWN', 没有诊断价值)
    assert.equal(applied.conflicts[0].code, 'ER_DUP_FIELDNAME',
      `冲突记录应留原始 code, 实际 ${applied.conflicts[0].code}`);
    assert.match(applied.conflicts[0].message, /Duplicate column name/);
  });

  test('MSSQL 形态 (只有 number, 没有 code) ⇒ number=2705 也判为幂等冲突', async () => {
    const inner = makeError({ number: 2705, message: 'Column names in each table must be unique' });
    const { db } = makeRecordingDb({
      onExecute: (sql) => {
        if (sql.includes('ADD COLUMN computers_count')) throw inner;
      }
    });

    const applied = await applyAll('mysql', db, { repoRoot: REPO_ROOT, databaseName: 'b_mssql_number' });

    assert.equal(applied.conflicts.length, 1,
      `应记录 1 条幂等冲突, 实际 ${applied.conflicts.length}`);
    assert.equal(applied.conflicts[0].number, 2705);
  });

  test('真错误 (ER_PARSE_ERROR) 照常抛出, 绝不被当成幂等冲突吞掉', async () => {
    const inner = makeError({ code: 'ER_PARSE_ERROR', message: 'You have an error in your SQL syntax' });
    const wrapped = makeError({ code: 'UNKNOWN', message: `未知错误: ${inner.message}`, originalError: inner });
    const { db } = makeRecordingDb({
      onExecute: (sql) => {
        if (sql.includes('ADD COLUMN computers_count')) throw wrapped;
      }
    });

    await assert.rejects(
      () => applyAll('mysql', db, { repoRoot: REPO_ROOT, databaseName: 'b_parse_error' }),
      (err) => {
        assert.match(err.message, /syntax/i, `应原样抛真错误, 实际 ${err.message}`);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// C. 库名校验 (库名会拼进 DDL)
// ---------------------------------------------------------------------------

describe('C. assertValidDatabaseName — 库名白名单', () => {
  test('正常库名通过', () => {
    assert.equal(assertValidDatabaseName('addashboard'), 'addashboard');
    assert.equal(assertValidDatabaseName('  addashboard  '), 'addashboard', '两端空白应被裁掉');
    assert.equal(assertValidDatabaseName('ad_dashboard$1'), 'ad_dashboard$1');
  });

  test('注入形状的库名一律拒绝', () => {
    const bad = [
      '',                                   // 空
      'a b',                                // 空格
      'a`b',                                // 反引号 → 可闭合标识符
      'a;DROP DATABASE x',                  // 语句分隔
      "a'b",                                // 单引号
      'a\\b',                               // 反斜杠
      'a-b',                                // 连字符 (不在白名单里)
      'x'.repeat(65),                       // 超长 (> 64)
      null,
      undefined
    ];
    for (const name of bad) {
      assert.throws(
        () => assertValidDatabaseName(name),
        (err) => err instanceof Error && err.message.length > 0,
        `库名 ${JSON.stringify(name)} 应被拒绝`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// D. 驱动能力面
// ---------------------------------------------------------------------------

describe('D. 驱动能力面 (MySQL 有 session/server 级能力, MSSQL 没有)', () => {
  test('MySQL 驱动暴露 session / probeServer / databaseExists / createDatabaseIfMissing', async () => {
    const driver = createMysqlDriver({ host: '127.0.0.1', port: 3306, user: 'u', password: 'p', database: 'd' });
    try {
      assert.equal(typeof driver.session, 'function', 'MySQL 驱动必须有 session()');
      assert.equal(typeof driver.probeServer, 'function', 'MySQL 驱动必须有 probeServer()');
      assert.equal(typeof driver.databaseExists, 'function', 'MySQL 驱动必须有 databaseExists()');
      assert.equal(typeof driver.createDatabaseIfMissing, 'function', 'MySQL 驱动必须有 createDatabaseIfMissing()');
    } finally {
      await driver.close().catch(() => {});
    }
  });

  test('MSSQL 驱动**不**暴露 session (基线守卫是自包含批语句, 加了会改行为)', async () => {
    const driver = createMssqlDriver({ server: '127.0.0.1', port: 1433, user: 'u', password: 'p', database: 'd' });
    try {
      assert.equal(driver.session, undefined,
        'MSSQL 不该有 session() —— applyFile 检测到就会改走 session 通道, 偏离原行为');
    } finally {
      await driver.close().catch(() => {});
    }
  });

  test('mysql2 不支持 acquireTimeout ⇒ 驱动源码里不得再出现该选项', () => {
    // mysql2 的有效选项表 (node_modules/mysql2/lib/connection_config.js 的
    // validOptions) 里没有 acquireTimeout; 传进去只会打一条
    // "Ignoring invalid configuration option" 警告, 而**未来版本会直接抛错**
    // ⇒ 建池失败 ⇒ 中心端起不来。
    //
    // 只看**代码**, 不看注释 —— 注释里刻意保留了这个词 (记录历史与来龙去脉),
    // 断言必须针对真正传给 mysql.createPool 的选项。
    const code = stripJsComments(readFileSync(MYSQL_DRIVER, 'utf8'));
    assert.ok(!code.includes('acquireTimeout'),
      '驱动代码里不该再有 acquireTimeout —— mysql2 不支持它, 且未来版本会因它抛错');
  });
});

// ---------------------------------------------------------------------------
// E. 建库走 server 级连接
// ---------------------------------------------------------------------------

describe('E. applyAll 的建库路径', () => {
  test('db 提供 createDatabase 时用它, 不再把 CREATE DATABASE 发到绑定库上', async () => {
    const { db, calls } = makeRecordingDb();
    const created = [];
    db.createDatabase = async (name) => { created.push(name); return name; };

    await applyAll('mysql', db, {
      repoRoot: REPO_ROOT, createDatabase: true, databaseName: 'e_server_level'
    });

    assert.deepEqual(created, ['e_server_level'], '建库应走 server 级能力');
    const viaExecute = calls.direct.concat(calls.session)
      .filter((c) => /CREATE\s+DATABASE/i.test(String(c.sql)));
    assert.equal(viaExecute.length, 0,
      '建库不该再走 db.execute —— 绑定目标库的连接在库还不存在时握手就 1049');
  });

  test('db 没有 createDatabase 时回退到 db.execute, 且库名先过白名单', async () => {
    const { db, calls } = makeRecordingDb({ withSession: false });
    await applyAll('mysql', db, {
      repoRoot: REPO_ROOT, createDatabase: true, databaseName: 'e_fallback'
    });
    const viaExecute = calls.direct.filter((c) => /CREATE\s+DATABASE/i.test(String(c.sql)));
    assert.equal(viaExecute.length, 1, '回退路径应发出 1 条 CREATE DATABASE');
    assert.match(viaExecute[0].sql, /CREATE DATABASE IF NOT EXISTS `e_fallback`/);
  });

  test('回退路径下注入形状的库名必须被白名单挡下 (库名会拼进 DDL)', async () => {
    const { db, calls } = makeRecordingDb({ withSession: false });
    await assert.rejects(
      () => applyAll('mysql', db, {
        repoRoot: REPO_ROOT, createDatabase: true, databaseName: 'evil`; DROP DATABASE x; --'
      }),
      (err) => /数据库名/.test(err.message),
      '注入形状的库名必须被拒绝'
    );
    const viaExecute = calls.direct.filter((c) => /CREATE\s+DATABASE/i.test(String(c.sql)));
    assert.equal(viaExecute.length, 0, '库名非法时不得发出任何 CREATE DATABASE');
  });
});

// ---------------------------------------------------------------------------
// F. 向导第 1 步「测试连接」不再被"库还没建"卡住
// ---------------------------------------------------------------------------

describe('F. /api/init/db/test 报告库是否存在', () => {
  function makeRouter(fakeDb) {
    return initRouter({
      logger: makeLogger(),
      configPath: 'unused',
      installPath: 'unused',
      getNeedsInit: () => true,
      _deps: {
        withOneShotFacade: async (_dialect, _params, work) => work(fakeDb),
        applyAll, createAdmin: async () => ({}), writeConfig: () => {},
        getWizardFacade: async () => fakeDb, closeWizardFacade: async () => {},
        writeMarker: () => {}, backfillMigrations: async () => ({ count: 0, skipped: [] })
      }
    });
  }

  test('MySQL: 服务器连得上但目标库不存在 ⇒ ok:true + databaseExists:false (不是失败)', async () => {
    const fakeDb = {
      dialect: 'mysql',
      async probeServer() { return true; },
      async databaseExists() { return false; },
      async execute() { return { rows: [], affectedRows: 0 }; }
    };
    const router = makeRouter(fakeDb);
    const handler = findRouteHandler(router, 'post', '/db/test');
    const res = makeRes();

    await handler({ body: { dialect: 'mysql', host: 'h', database: 'brand_new' } }, res);

    assert.equal(res._out.statusCode, 200);
    assert.equal(res._out.body.ok, true, `应视为连接成功, 实际 ${JSON.stringify(res._out.body)}`);
    assert.equal(res._out.body.server, true);
    assert.equal(res._out.body.databaseExists, false,
      '必须告诉前端"库还没建", 否则操作员被卡在第 1 步');
  });

  test('MySQL: 目标库已存在 ⇒ databaseExists:true', async () => {
    const fakeDb = {
      dialect: 'mysql',
      async probeServer() { return true; },
      async databaseExists() { return true; },
      async execute() { return { rows: [], affectedRows: 0 }; }
    };
    const router = makeRouter(fakeDb);
    const handler = findRouteHandler(router, 'post', '/db/test');
    const res = makeRes();

    await handler({ body: { dialect: 'mysql', host: 'h', database: 'existing' } }, res);

    assert.equal(res._out.body.ok, true);
    assert.equal(res._out.body.databaseExists, true);
  });

  test('MSSQL: 走原路径 (库由 installer 预建), databaseExists 报 true', async () => {
    const fakeDb = {
      dialect: 'mssql',
      async execute() { return { rows: [{ ok: 1 }], affectedRows: 0 }; }
    };
    const router = makeRouter(fakeDb);
    const handler = findRouteHandler(router, 'post', '/db/test');
    const res = makeRes();

    await handler({ body: { dialect: 'mssql', server: 's', database: 'd' } }, res);

    assert.equal(res._out.body.ok, true);
    assert.equal(res._out.body.databaseExists, true);
  });
});

// ---------------------------------------------------------------------------
// G. 基线文件自身的静态断言
// ---------------------------------------------------------------------------

describe('G. 基线文件静态断言', () => {
  test('MySQL 基线文件头没有 UTF-8 BOM', () => {
    const buf = readFileSync(MYSQL_BASELINE);
    const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    assert.ok(!hasBom,
      'MySQL 基线文件头不该有 BOM —— 它会被当成 SQL 内容的一部分 (旧文件上有 3 个)');
  });

  test('两方言的外键名集合完全一致 (方言对等)', () => {
    const mysql = extractForeignKeyNames(MYSQL_BASELINE);
    const mssql = extractForeignKeyNames(MSSQL_BASELINE);
    assert.ok(mysql.size > 0, 'MySQL 基线应至少有一条外键');
    const onlyMysql = [...mysql].filter((n) => !mssql.has(n));
    const onlyMssql = [...mssql].filter((n) => !mysql.has(n));
    assert.deepEqual(onlyMysql, [],
      `MySQL 有而 MSSQL 没有的外键: ${JSON.stringify(onlyMysql)} —— 两种方言的库结构必须可比`);
    assert.deepEqual(onlyMssql, [],
      `MSSQL 有而 MySQL 没有的外键: ${JSON.stringify(onlyMssql)} —— 两种方言的库结构必须可比`);
  });

  test('MySQL 基线的幂等守卫是会话级的 (@s + PREPARE) ⇒ 必须跑在固定连接上', () => {
    const src = stripSqlComments(MYSQL_BASELINE);
    const setCount = (src.match(/SET\s+@s\s*=\s*\(SELECT\s+IF\(/gi) || []).length;
    const prepCount = (src.match(/PREPARE\s+stmt\s+FROM\s+@s/gi) || []).length;
    assert.ok(setCount > 0, 'MySQL 基线应仍在用 SET @s = (SELECT IF(...)) 做幂等守卫');
    assert.ok(prepCount > 0, 'MySQL 基线应仍在用 PREPARE stmt FROM @s');
    assert.equal(setCount, prepCount,
      `SET @s (${setCount} 处) 与 PREPARE stmt FROM @s (${prepCount} 处) 数量不等 —— 守卫链不完整`);
    // 这条断言的作用: 上面两条一旦不成立 (守卫被改写成不依赖会话状态的形式),
    // 就说明 "必须走固定连接" 的前提变了, A 组测试要跟着重新评估。
  });

  test('MySQL 基线里的 package_policies 种子带外键守卫语义 (INSERT IGNORE + FK 指向 package_scripts)', () => {
    const code = stripSqlComments(MYSQL_BASELINE);
    assert.match(code,
      /CONSTRAINT\s+fk_package_policies_name\s+FOREIGN KEY\s*\(name\)\s*REFERENCES\s+package_scripts\(name\)/i,
      'package_policies.name 应有指向 package_scripts(name) 的外键');
    // 种子必须用 INSERT IGNORE —— 撞外键时降级成 warning 并跳过 (新装库 0 行,
    // 与 MSSQL 侧 AND EXISTS 守卫净状态一致)。注释里必须写明这一点。
    const ignoreCount = (code.match(/INSERT IGNORE INTO package_policies/gi) || []).length;
    assert.equal(ignoreCount, 14, `14 条内置包策略各一条 INSERT IGNORE, 实际 ${ignoreCount}`);
    // 这一条查的是**注释** (raw 文本), 断言基线把"新装库这 14 条落不下去"
    // 这个事实写在了明处, 别让下一个人误以为它会种进去。
    const raw = readFileSync(MYSQL_BASELINE, 'utf8');
    assert.match(raw, /必然 0 行/,
      '基线注释必须写明"新装库上这 14 条落不下去"这个事实, 别让下一个人误以为它会种进去');
  });
});
