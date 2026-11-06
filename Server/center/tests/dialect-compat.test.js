// R161.3 — 跨方言误用守卫 (check-dialect-compat.mjs) 的回归网
//
// 为什么这个文件在 center/tests/ 顶层而不是 center/tests/audit/:
//   center/package.json 的 "test" 脚本的 glob 是
//     tests/*.test.js tests/auth/*.test.js ... tests/e2e/*.test.js
//   **不含 tests/audit/**。放进去 CI 根本不会跑 —— 一个不会被执行的测试
//   等于没有测试。而给 package.json 加 glob 会改掉它的内容 ⇒ `.install-hash`
//   失配 ⇒ 目标机 (常常离线) 删 node_modules 重跑 npm install ⇒ 装机报废。
//   ⇒ 放顶层, 用现成的 glob, 不碰 package.json。
//
// 为什么必须有负向测试:
//   R161 的教训 —— "检测器自己也要负向测试"。一个只会输出 0 违规的守卫
//   和一个哑巴无法区分。本文件对**每一条**规则都构造一个必须触发的样本,
//   并且断言 "规则表里每条规则都有对应样本" —— 将来有人加了规则忘了写样本,
//   这个断言会失败。
//
// 用法: cd Server/center && npm test   (或 node --test tests/dialect-compat.test.js)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkBaseline,
  dialectOf,
  normalizeForLexing,
  LEXICAL_RULES,
} from '../../scripts/audit/check-dialect-compat.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, '..', '..');            // Server/
const REPO_ROOT = resolve(SERVER_ROOT, '..');              // repo root

const MYSQL_BASELINE = resolve(SERVER_ROOT, 'db', 'migrations', 'mysql', '1.0.0-baseline.sql');
const MSSQL_BASELINE = resolve(SERVER_ROOT, 'db', 'migrations', 'mssql', '1.0.0-baseline.sql');
const LINUX_MYSQL_BASELINE = resolve(REPO_ROOT, 'LinuxServer', 'db', 'migrations', 'mysql', '1.0.0-baseline.sql');
const LINUX_MSSQL_BASELINE = resolve(REPO_ROOT, 'LinuxServer', 'db', 'migrations', 'mssql', '1.0.0-baseline.sql');

/** 用一个"像样的路径"喂给 checkBaseline —— 方言是靠路径判定的。 */
function fakePath(dialect, name = 'probe.sql') {
  return `fake/db/migrations/${dialect}/${name}`;
}

/** 收集某个检查结果里的问题 code 集合。 */
function codesOf(result) {
  return result.problems.map((p) => p.code);
}

// ---------------------------------------------------------------------------
// 1. 正样本 —— 真实基线必须 0 误报
// ---------------------------------------------------------------------------

describe('check-dialect-compat — 真实基线', () => {
  test('Server MySQL 基线 0 违规', () => {
    assert.ok(existsSync(MYSQL_BASELINE), `基线不存在: ${MYSQL_BASELINE}`);
    const result = checkBaseline('Server/db/migrations/mysql/1.0.0-baseline.sql', readFileSync(MYSQL_BASELINE, 'utf8'));
    assert.deepEqual(result.problems, [], `MySQL 基线被误判:\n${JSON.stringify(result.problems, null, 2)}`);
    assert.equal(result.dialect, 'mysql');
    assert.ok(result.statementCount > 100, `语句数异常少: ${result.statementCount}`);
  });

  test('Server MSSQL 基线 0 违规', () => {
    assert.ok(existsSync(MSSQL_BASELINE), `基线不存在: ${MSSQL_BASELINE}`);
    const result = checkBaseline('Server/db/migrations/mssql/1.0.0-baseline.sql', readFileSync(MSSQL_BASELINE, 'utf8'));
    assert.deepEqual(result.problems, [], `MSSQL 基线被误判:\n${JSON.stringify(result.problems, null, 2)}`);
    assert.equal(result.dialect, 'mssql');
    assert.ok(result.statementCount > 100, `语句数异常少: ${result.statementCount}`);
  });

  test('交付包 (LinuxServer) 基线 0 违规 —— 交付树必须与源树同样干净', () => {
    for (const file of [LINUX_MYSQL_BASELINE, LINUX_MSSQL_BASELINE]) {
      assert.ok(existsSync(file), `交付基线不存在: ${file}`);
      const rel = file.slice(REPO_ROOT.length + 1).split('\\').join('/');
      const result = checkBaseline(rel, readFileSync(file, 'utf8'));
      assert.deepEqual(result.problems, [], `交付基线被误判 (${rel}):\n${JSON.stringify(result.problems, null, 2)}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. 负样本 —— 每条词法规则都必须能触发
// ---------------------------------------------------------------------------

/**
 * 每个 fixture: { code, dialect, sql }
 * sql 会被拼上 "\n" 让生产切分器正常收尾 (它按 ';' 收语句)。
 */
const LEXICAL_FIXTURES = [
  // ---- MySQL 语法出现在 MSSQL 基线 ----
  { code: 'MSSQL-HAS-MYSQL-ENGINE', dialect: 'mssql', sql: 'CREATE TABLE dbo.t (a INT) ENGINE=InnoDB;' },
  { code: 'MSSQL-HAS-MYSQL-AUTOINCREMENT', dialect: 'mssql', sql: 'CREATE TABLE dbo.t (a INT AUTO_INCREMENT);' },
  { code: 'MSSQL-HAS-MYSQL-BACKTICK', dialect: 'mssql', sql: 'CREATE TABLE `dbo`.`t` (a INT);' },
  { code: 'MSSQL-HAS-MYSQL-GENERATED-COLUMN', dialect: 'mssql', sql: 'CREATE TABLE dbo.t (a INT, b INT GENERATED ALWAYS AS (a + 1) STORED);' },
  { code: 'MSSQL-HAS-MYSQL-ON-UPDATE', dialect: 'mssql', sql: 'CREATE TABLE dbo.t (a DATETIME ON UPDATE CURRENT_TIMESTAMP);' },
  { code: 'MSSQL-HAS-MYSQL-ON-DUPLICATE', dialect: 'mssql', sql: 'INSERT INTO dbo.t (a) VALUES (1) ON DUPLICATE KEY UPDATE a = 2;' },
  { code: 'MSSQL-HAS-MYSQL-CT-IF-NOT-EXISTS', dialect: 'mssql', sql: 'CREATE TABLE IF NOT EXISTS dbo.t (a INT);' },
  { code: 'MSSQL-HAS-MYSQL-ADD-COLUMN', dialect: 'mssql', sql: 'ALTER TABLE dbo.t ADD COLUMN a INT;' },
  { code: 'MSSQL-HAS-MYSQL-CHANGE', dialect: 'mssql', sql: 'ALTER TABLE dbo.t CHANGE COLUMN a INT;' },
  { code: 'MSSQL-HAS-MYSQL-LIMIT', dialect: 'mssql', sql: 'SELECT * FROM dbo.t LIMIT 10;' },
  { code: 'MSSQL-HAS-MYSQL-CURRENT-TIMESTAMP-FRAC', dialect: 'mssql', sql: 'SELECT CURRENT_TIMESTAMP(3);' },
  { code: 'MSSQL-HAS-MYSQL-GROUP-CONCAT', dialect: 'mssql', sql: 'SELECT GROUP_CONCAT(a) FROM dbo.t;' },
  { code: 'MSSQL-HAS-MYSQL-IFNULL', dialect: 'mssql', sql: 'SELECT IFNULL(a, 0) FROM dbo.t;' },
  { code: 'MSSQL-HAS-MYSQL-RENAME-COLUMN', dialect: 'mssql', sql: 'ALTER TABLE dbo.t RENAME COLUMN a TO b;' },
  { code: 'MSSQL-HAS-MYSQL-DELIMITER', dialect: 'mssql', sql: 'DELIMITER $$\nCREATE TABLE dbo.t (a INT);' },
  { code: 'MSSQL-HAS-MYSQL-UNIQUE-KEY', dialect: 'mssql', sql: 'CREATE TABLE dbo.t (a INT, UNIQUE KEY uk_a (a));' },
  { code: 'MSSQL-HAS-MYSQL-LATERAL', dialect: 'mssql', sql: 'SELECT * FROM dbo.t, LATERAL (SELECT 1 AS x) q;' },
  { code: 'MSSQL-HAS-MYSQL-SHOW', dialect: 'mssql', sql: 'SHOW TABLES;' },

  // ---- MSSQL 语法出现在 MySQL 基线 ----
  { code: 'MYSQL-HAS-MSSQL-NVARCHAR', dialect: 'mysql', sql: 'CREATE TABLE IF NOT EXISTS t (a NVARCHAR(64)) ENGINE=InnoDB;' },
  { code: 'MYSQL-HAS-MSSQL-DATETIME2', dialect: 'mysql', sql: 'CREATE TABLE IF NOT EXISTS t (a DATETIME2(3)) ENGINE=InnoDB;' },
  { code: 'MYSQL-HAS-MSSQL-IDENTITY', dialect: 'mysql', sql: 'CREATE TABLE IF NOT EXISTS t (a INT IDENTITY(1,1)) ENGINE=InnoDB;' },
  { code: 'MYSQL-HAS-MSSQL-IDENTITY-INSERT', dialect: 'mysql', sql: 'SET IDENTITY_INSERT t ON;' },
  { code: 'MYSQL-HAS-MSSQL-PERSISTED', dialect: 'mysql', sql: 'CREATE TABLE IF NOT EXISTS t (a INT, b INT AS (a + 1) PERSISTED) ENGINE=InnoDB;' },
  { code: 'MYSQL-HAS-MSSQL-DATE-FUNC', dialect: 'mysql', sql: 'SELECT SYSUTCDATETIME();' },
  { code: 'MYSQL-HAS-MSSQL-IF-OBJECT-ID', dialect: 'mysql', sql: "IF OBJECT_ID('t', 'U') IS NULL BEGIN SELECT 1; END" },
  { code: 'MYSQL-HAS-MSSQL-APPLY', dialect: 'mysql', sql: 'SELECT * FROM t CROSS APPLY (SELECT 1 AS x) q;' },
  { code: 'MYSQL-HAS-MSSQL-FROM-STATISTICS', dialect: 'mysql', sql: 'SELECT * FROM STATISTICS s;' },
  { code: 'MYSQL-HAS-MSSQL-TOP', dialect: 'mysql', sql: 'SELECT TOP 10 * FROM t;' },
  { code: 'MYSQL-HAS-MSSQL-OFFSET-FETCH', dialect: 'mysql', sql: 'SELECT * FROM t ORDER BY a OFFSET 10 ROWS;' },
  { code: 'MYSQL-HAS-MSSQL-STRING-AGG', dialect: 'mysql', sql: "SELECT STRING_AGG(a, ',') FROM t;" },
  { code: 'MYSQL-HAS-MSSQL-IIF', dialect: 'mysql', sql: 'SELECT IIF(a = 1, 1, 0) FROM t;' },
  { code: 'MYSQL-HAS-MSSQL-MERGE', dialect: 'mysql', sql: 'MERGE INTO t AS tgt USING s AS src ON tgt.a = src.a WHEN MATCHED THEN UPDATE SET tgt.a = 1;' },
  { code: 'MYSQL-HAS-MSSQL-THROW', dialect: 'mysql', sql: "THROW 50000, 'boom', 1;" },
  { code: 'MYSQL-HAS-MSSQL-BEGIN-TRY', dialect: 'mysql', sql: 'BEGIN TRY SELECT 1; END TRY;' },
  { code: 'MYSQL-HAS-MSSQL-SUSER', dialect: 'mysql', sql: 'SELECT SUSER_SNAME();' },

  // ---- 双方言都不该有的 ----
  { code: 'BOTH-HAS-SP-RENAME', dialect: 'mysql', sql: "EXEC sp_rename 't.a', 'b';" },
  { code: 'BOTH-HAS-SP-RENAME', dialect: 'mssql', sql: "EXEC sp_rename 't.a', 'b';" },
];

describe('check-dialect-compat — 词法规则负样本', () => {
  for (const fixture of LEXICAL_FIXTURES) {
    test(`${fixture.code} 能在 ${fixture.dialect} 基线里被抓到`, () => {
      const result = checkBaseline(fakePath(fixture.dialect), `${fixture.sql}\n`);
      const codes = codesOf(result);
      assert.ok(
        codes.includes(fixture.code),
        `规则 ${fixture.code} 没有触发, 实际报出: ${JSON.stringify(codes)}\n样本: ${fixture.sql}`,
      );
    });
  }

  test('规则表里的每一条规则都有对应的负样本', () => {
    const covered = new Set(LEXICAL_FIXTURES.map((f) => f.code));
    const uncovered = LEXICAL_RULES.map((r) => r.code).filter((c) => !covered.has(c));
    assert.deepEqual(
      uncovered,
      [],
      `这些规则没有负样本 —— 加了规则忘了写样本, 等于这条规则没人验证过:\n${uncovered.join('\n')}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. 结构规则负样本
// ---------------------------------------------------------------------------

describe('check-dialect-compat — MSSQL 结构规则', () => {
  test('CREATE VIEW 不是语句开头 ⇒ MSSQL-CREATE-VIEW-NOT-FIRST', () => {
    const sql = 'IF 1 = 1 CREATE VIEW dbo.v AS SELECT 1 AS c;\n';
    const result = checkBaseline(fakePath('mssql'), sql);
    assert.ok(codesOf(result).includes('MSSQL-CREATE-VIEW-NOT-FIRST'), JSON.stringify(result.problems));
  });

  test('CREATE VIEW 是语句开头 ⇒ 不报错', () => {
    const sql = 'CREATE VIEW dbo.v AS SELECT 1 AS c;\n';
    const result = checkBaseline(fakePath('mssql'), sql);
    assert.deepEqual(result.problems, [], JSON.stringify(result.problems));
  });

  test('IDENTITY_INSERT 只开不关 ⇒ MSSQL-IDENTITY-INSERT-UNPAIRED', () => {
    const sql = 'SET IDENTITY_INSERT dbo.t ON;\n';
    const result = checkBaseline(fakePath('mssql'), sql);
    assert.ok(codesOf(result).includes('MSSQL-IDENTITY-INSERT-UNPAIRED'), JSON.stringify(result.problems));
  });

  test('IDENTITY_INSERT 成对但同语句里没有 INSERT ⇒ MSSQL-IDENTITY-INSERT-WITHOUT-INSERT', () => {
    // BEGIN…END 让生产切分器把两条合成一条语句 —— 会话级开关就跑到别的连接上去了
    const sql = 'BEGIN SET IDENTITY_INSERT dbo.t ON; SET IDENTITY_INSERT dbo.t OFF; END;\n';
    const result = checkBaseline(fakePath('mssql'), sql);
    assert.ok(codesOf(result).includes('MSSQL-IDENTITY-INSERT-WITHOUT-INSERT'), JSON.stringify(result.problems));
  });

  test('IDENTITY_INSERT + INSERT 同语句 ⇒ 不报错 (这正是基线的形状)', () => {
    const sql = "BEGIN SET IDENTITY_INSERT dbo.t ON; INSERT INTO dbo.t (id, n) VALUES (1, 'x'); SET IDENTITY_INSERT dbo.t OFF; END;\n";
    const result = checkBaseline(fakePath('mssql'), sql);
    assert.deepEqual(result.problems, [], JSON.stringify(result.problems));
  });
});

describe('check-dialect-compat — MySQL 结构规则', () => {
  test('CREATE TABLE 没有 IF NOT EXISTS ⇒ MYSQL-CREATE-TABLE-NOT-IDEMPOTENT', () => {
    const sql = 'CREATE TABLE t (a INT) ENGINE=InnoDB;\n';
    const result = checkBaseline(fakePath('mysql'), sql);
    assert.ok(codesOf(result).includes('MYSQL-CREATE-TABLE-NOT-IDEMPOTENT'), JSON.stringify(result.problems));
  });

  test('CREATE TABLE 没有 ENGINE=InnoDB ⇒ MYSQL-TABLE-NOT-INNODB', () => {
    const sql = 'CREATE TABLE IF NOT EXISTS t (a INT);\n';
    const result = checkBaseline(fakePath('mysql'), sql);
    assert.ok(codesOf(result).includes('MYSQL-TABLE-NOT-INNODB'), JSON.stringify(result.problems));
  });

  test('合规模式 ⇒ 不报错', () => {
    const sql = 'CREATE TABLE IF NOT EXISTS t (a INT) ENGINE=InnoDB;\n';
    const result = checkBaseline(fakePath('mysql'), sql);
    assert.deepEqual(result.problems, [], JSON.stringify(result.problems));
  });
});

// ---------------------------------------------------------------------------
// 4. 词法工具 —— 注释与字符串字面量不得造成误报
// ---------------------------------------------------------------------------

describe('check-dialect-compat — 注释与字符串字面量', () => {
  test('注释里的对方方言关键字不触发', () => {
    const sql = [
      '-- MSSQL 用 NVARCHAR(1024), MySQL 用 VARCHAR(64)',
      '/* ENGINE=InnoDB / AUTO_INCREMENT / PERSISTED 都不该在这里触发 */',
      'CREATE TABLE IF NOT EXISTS t (a VARCHAR(64)) ENGINE=InnoDB;',
      '',
    ].join('\n');
    const result = checkBaseline(fakePath('mysql'), sql);
    assert.deepEqual(result.problems, [], JSON.stringify(result.problems));
  });

  test('字符串字面量里的对方方言关键字不触发', () => {
    const sql = "CREATE TABLE IF NOT EXISTS t (a VARCHAR(64) COMMENT 'ENGINE=InnoDB AUTO_INCREMENT') ENGINE=InnoDB;\n";
    const result = checkBaseline(fakePath('mysql'), sql);
    assert.deepEqual(result.problems, [], JSON.stringify(result.problems));
  });

  test('normalizeForLexing 会把注释与字面量清掉, 但保留结构', () => {
    const out = normalizeForLexing("SELECT 'x' -- NVARCHAR(10)\n/* PERSISTED */ FROM t;");
    assert.ok(!out.includes('NVARCHAR'), out);
    assert.ok(!out.includes('PERSISTED'), out);
    assert.ok(out.includes('SELECT'), out);
    assert.ok(out.includes('FROM t'), out);
  });

  test('带引号转义的字符串字面量不会把后面的语句吃进字面量', () => {
    const out = normalizeForLexing("SELECT 'it''s ENGINE=InnoDB' FROM t;");
    assert.ok(!out.includes('ENGINE=InnoDB'), out);
    assert.ok(out.includes('FROM t'), out);
  });
});

// ---------------------------------------------------------------------------
// 5. 方言判定
// ---------------------------------------------------------------------------

describe('check-dialect-compat — 方言判定', () => {
  test('路径里带 /mysql/ 或 /mssql/ 才能判定', () => {
    assert.equal(dialectOf('Server/db/migrations/mysql/1.0.0-baseline.sql'), 'mysql');
    assert.equal(dialectOf('Server\\db\\migrations\\mssql\\1.0.0-baseline.sql'), 'mssql');
    assert.equal(dialectOf('Server/db/migrations/1.0.0-baseline.sql'), null);
  });

  test('判不出方言 ⇒ 报 DIALECT-UNKNOWN (不是静默通过)', () => {
    const result = checkBaseline('somewhere/else.sql', 'SELECT 1;\n');
    assert.ok(codesOf(result).includes('DIALECT-UNKNOWN'), JSON.stringify(result.problems));
  });
});
