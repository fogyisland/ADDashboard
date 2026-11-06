// R161.19 — 索引键长度守卫 (check-index-key-length.mjs) 的回归网
//
// 为什么这个文件在 center/tests/ 顶层而不是 center/tests/audit/:
//   center/package.json 的 "test" 脚本的 glob 是 `tests/*.test.js ...`,
//   **不含 tests/audit/** ⇒ 放进去 CI 根本不跑。
//   而给 package.json 加 glob 会改掉它的内容 ⇒ `.install-hash` 失配 ⇒
//   目标机 (常常离线) 删 node_modules 重跑 npm install ⇒ 装机报废。
//   ⇒ 放顶层, 用现成的 glob, 不碰 package.json。
//
// 为什么必须有负向测试:
//   R161 的教训 —— "检测器自己也要负向测试"。一个只会输出 0 违规的守卫
//   和一个哑巴无法区分。本文件对**每一条**规则都构造一个必须触发的样本,
//   并且断言 "规则表里每条规则都有对应样本" —— 将来有人加了规则忘了写样本,
//   这个断言会失败。
//
// ★ 本守卫的字节模型不是拍脑袋写的, 是**在 SQL Server 2025 RTM 上实测**的:
//   聚集索引键上限 900 字节 / 非聚集 1700 字节;
//   **聚集键不追加进非聚集索引的键** (连 UNIQUE 非聚集索引也不追加);
//   **没有变长列的长度前缀字节**; **没有 NULL 位图字节**;
//   DATETIME=8 / DATETIME2(3)=7 / DATETIMEOFFSET(7)=10 / TIME(7)=5 /
//   UNIQUEIDENTIFIER=16 / FLOAT=8 (双精度)。
//   实测手法: NVARCHAR(450) NOT NULL (=900 字节, 正好卡在聚集上限) + 一列目标类型
//   ⇒ 引擎在 DDL 时自报 "索引的最大长度为 N 字节" ⇒ N - 900 = 该类型的键字节数。
//
// 用法: cd Server/center && npm test   (或 node --test tests/index-key-length.test.js)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INDEX_KEY_RULES,
  buildSchemaContext,
  applyColumnAdditions,
  checkBaseline,
  checkMigrationIndexes,
  collectMigrationIndexes,
  columnKeyBytes,
  parseStandaloneIndexes,
  parsePrimaryKeyConstraints,
  parseColumnAdditions,
  parseIndexColumns,
  stripSqlComments,
  blankStringLiterals,
  extractStringLiterals,
  detectComputedKeyType,
} from '../../scripts/audit/check-index-key-length.mjs';
import { sortMigrationFiles, parseFileMeta } from '../src/utils/migration-version.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, '..', '..');            // Server/
const MIGRATIONS_ROOT = resolve(SERVER_ROOT, 'db', 'migrations');

/** 收集某个检查结果里的问题 code 集合。 */
function codesOf(problems) {
  return problems.map((p) => p.code);
}

// ---------------------------------------------------------------------------
// 1. 负样本 —— 每条规则必须能抓到自己的样本
// ---------------------------------------------------------------------------
//
// 每个样本只许命中它对应的那一条规则 (否则"只命中自己"断言失败,
// 分不清是规则错还是样本错)。
//
// 样本的形态分两类:
//   · 基线型 (CREATE TABLE + CREATE INDEX 同一份 SQL) ⇒ checkBaseline()
//   · 迁移型 (只建索引, 表在基线上下文里) ⇒ checkMigrationIndexes()
const NEGATIVE_SAMPLES = {
  'IDX-MISSING-PREFIX': {
    dialect: 'mysql',
    sql: [
      'CREATE TABLE t (id BIGINT NOT NULL, body TEXT NULL);',
      'CREATE INDEX ix_t_body ON t (body);'
    ].join('\n'),
    // MySQL: BLOB/TEXT 进索引必须给前缀, 否则 ERROR 1170
    expectSeverity: 'error',
  },
  'IDX-KEY-TOO-LONG': {
    dialect: 'mysql',
    sql: [
      'CREATE TABLE t (id BIGINT NOT NULL, s VARCHAR(1000) NULL);',
      'CREATE INDEX ix_t_s ON t (s);'
    ].join('\n'),
    // utf8mb4 每字符 4 字节 ⇒ VARCHAR(1000) = 4000 > 3072 ⇒ ER 1071
    expectSeverity: 'error',
  },
  'IDX-KEY-TOO-LONG-CLUSTERED': {
    dialect: 'mssql',
    sql: [
      'CREATE TABLE [t] ([id] BIGINT NOT NULL, [s] NVARCHAR(500) NULL);',
      'CREATE CLUSTERED INDEX [cx_t_s] ON [t] ([s]);'
    ].join('\n'),
    // NVARCHAR(500) = 1000 > 900
    expectSeverity: 'warn',
  },
  'IDX-TABLE-UNKNOWN': {
    dialect: 'mssql',
    migrationSql: 'CREATE NONCLUSTERED INDEX [ix_ghost] ON [ghost_table] ([id]);',
    baselineSql: 'CREATE TABLE [known_table] ([id] BIGINT NOT NULL);',
    expectSeverity: 'error',
  },
};

describe('check-index-key-length — 负样本 (每条规则都必须触发)', () => {
  test('规则表里每条规则都有对应负样本 (加规则忘了写样本 ⇒ 这里失败)', () => {
    const ruleCodes = INDEX_KEY_RULES.map((r) => r.code).sort();
    const sampleCodes = Object.keys(NEGATIVE_SAMPLES).sort();
    assert.deepEqual(
      sampleCodes, ruleCodes,
      '负样本表与规则表必须一一对应 —— 有规则没有样本 = 这条规则从没被验证过'
    );
  });

  test('每条规则都抓到自己的样本 (且只抓到自己的)', () => {
    for (const [code, sample] of Object.entries(NEGATIVE_SAMPLES)) {
      const problems = runSample(sample);
      assert.ok(problems.length > 0, `规则 ${code} 没抓到自己的样本 —— 规则失效了`);
      assert.deepEqual(
        codesOf(problems), [code],
        `规则 ${code} 抓到了额外的规则: ${JSON.stringify(codesOf(problems))} —— 样本或规则有串扰`
      );
      assert.equal(problems[0].severity, sample.expectSeverity,
        `规则 ${code} 的严重度不对 (方言不同 ⇒ 后果不同): `
        + `${problems[0].severity} ≠ ${sample.expectSeverity}`);
    }
  });

  test('每条规则都带 why (报错文案要能直接告诉操作员怎么办)', () => {
    for (const rule of INDEX_KEY_RULES) {
      assert.ok(rule.why && rule.why.length > 20, `规则 ${rule.code} 的 why 太短`);
      assert.ok(Array.isArray(rule.dialects) && rule.dialects.length > 0,
        `规则 ${rule.code} 没声明 dialects`);
      assert.ok(rule.severity && rule.severity.mysql && rule.severity.mssql,
        `规则 ${rule.code} 的 severity 必须按方言给全 (MySQL 硬失败 / MSSQL 只警告)`);
    }
  });

  test('守卫报出来的 code 必须在规则表里 (防止出现没人测过的规则)', () => {
    const known = new Set(INDEX_KEY_RULES.map((r) => r.code));
    const emitted = new Set();
    for (const dialect of ['mysql', 'mssql']) {
      const dir = resolve(MIGRATIONS_ROOT, dialect);
      const context = buildSchemaContext(
        readFileSync(resolve(dir, '1.0.0-baseline.sql'), 'utf8'), dialect
      );
      for (const file of sortMigrationFiles(readdirSync(dir).filter((f) => f.endsWith('.sql')))) {
        const sql = readFileSync(resolve(dir, file), 'utf8');
        applyColumnAdditions(context, sql, dialect);
        for (const p of checkMigrationIndexes(sql, dialect, context).problems) {
          emitted.add(p.code);
        }
      }
    }
    for (const code of emitted) {
      assert.ok(known.has(code), `守卫报出了规则表里没有的 code: ${code}`);
    }
  });
});

/** 跑一个负样本, 返回它产生的问题列表。 */
function runSample(sample) {
  if (sample.migrationSql) {
    const context = buildSchemaContext(sample.baselineSql, sample.dialect);
    return checkMigrationIndexes(sample.migrationSql, sample.dialect, context).problems;
  }
  return checkBaseline(sample.sql, sample.dialect).problems;
}

// ---------------------------------------------------------------------------
// 2. 字节模型 —— 与引擎实测对齐 (这是最容易悄悄退化的地方)
// ---------------------------------------------------------------------------

describe('check-index-key-length — 字节模型 (SQL Server 2025 实测值)', () => {
  // [类型, 期望字节数, 方言]
  const MSSQL_MEASURED = [
    ['NVARCHAR(128)', 256], ['NVARCHAR(1024)', 2048], ['VARCHAR(100)', 100],
    ['CHAR(10)', 10], ['BINARY(32)', 32], ['VARBINARY(64)', 64],
    ['DATETIME', 8], ['DATETIME2(0)', 6], ['DATETIME2(3)', 7], ['DATETIME2(7)', 8],
    ['DATETIMEOFFSET', 10], ['DATETIMEOFFSET(0)', 8], ['DATETIMEOFFSET(3)', 9],
    ['DATE', 3], ['SMALLDATETIME', 4], ['TIME(7)', 5], ['TIME(3)', 4], ['TIME(0)', 3],
    ['UNIQUEIDENTIFIER', 16], ['FLOAT', 8], ['REAL', 4],
    ['INT', 4], ['BIGINT', 8], ['SMALLINT', 2], ['TINYINT', 1], ['BIT', 1],
    ['MONEY', 8], ['SMALLMONEY', 4],
  ];

  for (const [type, expected] of MSSQL_MEASURED) {
    test(`MSSQL ${type} = ${expected} 字节`, () => {
      assert.equal(columnKeyBytes(type, null, 'mssql'), expected,
        `MSSQL 的 ${type} 键字节数不是 ${expected} —— 与引擎实测不符`);
    });
  }

  const MYSQL_BYTES = [
    ['DATETIME', 5], ['DATETIME(3)', 6], ['TIMESTAMP', 4], ['DATE', 3], ['TIME', 3],
    ['INT', 4], ['BIGINT', 8], ['TINYINT', 1], ['SMALLINT', 2], ['MEDIUMINT', 3],
    ['BIT', 1], ['FLOAT', 4], ['DOUBLE', 8], ['YEAR', 1],
    ['VARCHAR(100)', 400], ['CHAR(10)', 40],          // utf8mb4 = 4 字节/字符
    ['BINARY(32)', 32],
  ];

  for (const [type, expected] of MYSQL_BYTES) {
    test(`MySQL ${type} = ${expected} 字节`, () => {
      assert.equal(columnKeyBytes(type, null, 'mysql'), expected,
        `MySQL 的 ${type} 键字节数不是 ${expected}`);
    });
  }

  test('★ 不加变长列的长度前缀字节 (实测: NVARCHAR(128)+NVARCHAR(1024) = 2304)', () => {
    // 引擎自报 2304 = 256 + 2048 ⇒ 没有 +2 的长度前缀。
    assert.equal(columnKeyBytes('NVARCHAR(128)', null, 'mssql')
      + columnKeyBytes('NVARCHAR(1024)', null, 'mssql'), 2304);
  });

  test('★ 可空性不参与键长计算 (实测: 1600 与 2400 都不带 NULL 位图字节)', () => {
    // NVARCHAR(400) NOT NULL + NVARCHAR(400) NULL = 1600 (与全 NOT NULL 同值)
    const notNull = columnKeyBytes('NVARCHAR(400)', null, 'mssql');
    assert.equal(notNull, 800);
    assert.equal(notNull + notNull, 1600);
    assert.equal(notNull * 3, 2400);
  });

  test('★ 聚集键不追加进非聚集索引的键 (实测: 自键 1200 + 聚集键 800 照样建、照样插)', () => {
    const sql = [
      'CREATE TABLE [t3_uk] ([ck] NVARCHAR(400) NOT NULL, [tag] NVARCHAR(600) NOT NULL);',
      'CREATE CLUSTERED INDEX [cx_t3] ON [t3_uk] ([ck]);',
      'CREATE UNIQUE NONCLUSTERED INDEX [ux_t3] ON [t3_uk] ([tag]);'
    ].join('\n');
    const context = buildSchemaContext(sql, 'mssql');
    const collected = collectMigrationIndexes(sql, 'mssql', context);
    const nci = collected.find((i) => i.name === 'ux_t3');
    assert.ok(nci, '没抓到非聚集索引');
    assert.equal(nci.bytes, 1200, '非聚集索引的键 = 自己的键列, 不含聚集键');
    // 旧模型会算成 2000 > 1700 ⇒ 假阳性。这里必须 0 违规。
    assert.deepEqual(checkBaseline(sql, 'mssql').problems, [],
      '聚集键被错误地追加进了非聚集索引的键长');
  });

  test('DECIMAL(p,s) 的存储分组 (整数部分与小数部分各按 9 位一组、每组 4 字节)', () => {
    assert.equal(columnKeyBytes('DECIMAL(10,2)', null, 'mssql'), 8);
    assert.equal(columnKeyBytes('DECIMAL(18,2)', null, 'mssql'), 12);
    assert.equal(columnKeyBytes('DECIMAL(18,0)', null, 'mssql'), 8);
  });

  test('前缀长度按字符数算 (MySQL 的 TEXT 前缀)', () => {
    assert.equal(columnKeyBytes('TEXT', 100, 'mysql'), 100);
    assert.equal(columnKeyBytes('LONGTEXT', 255, 'mysql'), 255);
  });
});

// ---------------------------------------------------------------------------
// 3. 解析层 —— R161.19 关掉的三个盲区, 每个都要有回归
// ---------------------------------------------------------------------------

describe('check-index-key-length — 解析层 (R161.19 的三个盲区)', () => {
  test('★ 盲区①: 编号迁移里的索引必须被扫到', () => {
    const sql = 'CREATE NONCLUSTERED INDEX [ix_ad_dcs_forest_domain] ON [ad_dcs] ([forest_domain_id]);';
    const indexes = parseStandaloneIndexes(sql, 'mssql');
    assert.equal(indexes.length, 1);
    assert.equal(indexes[0].table, 'ad_dcs');
    assert.equal(indexes[0].name, 'ix_ad_dcs_forest_domain');
    assert.equal(indexes[0].kind, 'NONCLUSTERED INDEX');
  });

  test('★ 盲区②: MySQL 藏在 SET @s = (...) 字符串载荷里的索引必须被扫到', () => {
    const sql = [
      'SET @s = (SELECT IF(',
      "  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS",
      "    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_dcs' AND INDEX_NAME = 'idx_ad_dcs_forest_domain') = 0,",
      "  'CREATE INDEX idx_ad_dcs_forest_domain ON ad_dcs (forest_domain_id)',",
      "  'SELECT 1'));",
      'PREPARE stmt FROM @s;',
      'EXECUTE stmt;',
      'DEALLOCATE PREPARE stmt;'
    ].join('\n');
    const indexes = parseStandaloneIndexes(sql, 'mysql');
    assert.equal(indexes.length, 1, '字符串载荷里的索引没被抓到');
    assert.equal(indexes[0].table, 'ad_dcs');
    assert.equal(indexes[0].name, 'idx_ad_dcs_forest_domain');
  });

  test('★ 盲区②的配套: 字符串载荷里的超长索引必须真的报出来', () => {
    const baseline = [
      'CREATE TABLE t (id BIGINT NOT NULL, s VARCHAR(1000) NULL);'
    ].join('\n');
    const context = buildSchemaContext(baseline, 'mysql');
    const migration = [
      'SET @s = (SELECT IF(1 = 0,',
      "  'CREATE INDEX ix_t_s ON t (s)',",
      "  'SELECT 1'));",
      'PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;'
    ].join('\n');
    const problems = checkMigrationIndexes(migration, 'mysql', context).problems;
    assert.deepEqual(codesOf(problems), ['IDX-KEY-TOO-LONG'],
      `字符串载荷里的超长索引没报出来: ${JSON.stringify(problems, null, 2)}`);
  });

  test('★ 盲区③: 带 WHERE 过滤谓词的索引必须被扫到 (旧正则一条都匹配不上)', () => {
    const sql = [
      'CREATE TABLE [t] ([id] BIGINT NOT NULL, [s] NVARCHAR(900) NULL);',
      'CREATE NONCLUSTERED INDEX [ix_t_s] ON [t] ([s]) WHERE ([s] IS NOT NULL);'
    ].join('\n');
    const indexes = parseStandaloneIndexes(sql, 'mssql');
    assert.equal(indexes.length, 1, '带 WHERE 的索引没被抓到');
    assert.equal(indexes[0].spec.trim(), '[s]',
      `键列清单被过滤谓词污染了: ${indexes[0].spec}`);
    // NVARCHAR(900) = 1800 字节 > 非聚集上限 1700 ⇒ 必须报出来
    assert.deepEqual(codesOf(checkBaseline(sql, 'mssql').problems), ['IDX-KEY-TOO-LONG']);
  });

  test('INCLUDE (...) 的列不计入键长 (SQL Server 的 INCLUDE 列不进索引键)', () => {
    const sql = [
      'CREATE TABLE [t] ([id] BIGINT NOT NULL, [s] NVARCHAR(100) NOT NULL, [extra] NVARCHAR(4000) NOT NULL);',
      'CREATE NONCLUSTERED INDEX [ix_t_s] ON [t] ([s]) INCLUDE ([extra]);'
    ].join('\n');
    const context = buildSchemaContext(sql, 'mssql');
    const collected = collectMigrationIndexes(sql, 'mssql', context);
    assert.equal(collected.length, 1);
    assert.equal(collected[0].bytes, 200, 'INCLUDE 列被算进键长了');
    assert.deepEqual(checkBaseline(sql, 'mssql').problems, []);
  });

  test('RAISERROR 的消息文本不得被当成 DDL 扫进来 (MSSQL 侧先掏空字面量)', () => {
    const sql = [
      'IF EXISTS (SELECT 1 FROM t WHERE x = 1)',
      'BEGIN',
      "  RAISERROR(N'CREATE INDEX ix_bad ON t (s)', 16, 1);",
      '  RETURN;',
      'END;'
    ].join('\n');
    assert.deepEqual(parseStandaloneIndexes(sql, 'mssql'), [],
      'RAISERROR 消息里的 DDL 被当真的索引扫进来了');
  });

  test('ALTER TABLE ADD CONSTRAINT ... PRIMARY KEY 里的主键必须被扫到', () => {
    const sql = 'ALTER TABLE [t] ADD CONSTRAINT [pk_t] PRIMARY KEY ([id]);';
    const pks = parsePrimaryKeyConstraints(sql, 'mssql');
    assert.equal(pks.length, 1);
    assert.equal(pks[0].table, 't');
    assert.equal(pks[0].name, 'pk_t');
  });

  test('ALTER TABLE ADD <列> 必须被解析 (编号迁移靠它加列)', () => {
    const sql = 'ALTER TABLE [t] ADD [hash] AS CONVERT(BINARY(32), HASHBYTES(\'SHA2_256\', [src])) PERSISTED;';
    const additions = parseColumnAdditions(sql, 'mssql');
    assert.equal(additions.length, 1);
    assert.equal(additions[0].table, 't');
    assert.equal(additions[0].columns.length, 1);
    assert.equal(additions[0].columns[0].name, 'hash');
    assert.equal(additions[0].columns[0].computed, true);
    assert.equal(additions[0].columns[0].keyType, 'BINARY(32)',
      '计算列的键长要按结果类型算, 不能按源列算');
  });

  test('★ 计算列的键长按**结果类型**算 (R161.3 的教训)', () => {
    // 不识别计算列 ⇒ 类型被读成关键字 'AS' ⇒ 未知类型按 8 字节估算 ⇒ 低估 ⇒ 漏报
    assert.equal(detectComputedKeyType(
      "AS CONVERT(BINARY(32), HASHBYTES('SHA2_256', [domain_dn])) PERSISTED"), 'BINARY(32)');
    assert.equal(columnKeyBytes('BINARY(32)', null, 'mssql'), 32);
  });

  test('主键按聚集索引判定 (MSSQL: PRIMARY KEY 默认聚集 ⇒ 900 字节门槛)', () => {
    const sql = [
      'CREATE TABLE [t] ([id] NVARCHAR(500) NOT NULL);',
      'ALTER TABLE [t] ADD CONSTRAINT [pk_t] PRIMARY KEY ([id]);'
    ].join('\n');
    const problems = checkBaseline(sql, 'mssql').problems;
    assert.deepEqual(codesOf(problems), ['IDX-KEY-TOO-LONG-CLUSTERED'],
      `主键没按 900 字节门槛判定: ${JSON.stringify(problems, null, 2)}`);
  });

  test('MySQL 没有聚集/非聚集之分 ⇒ 主键超限报的是同一条规则', () => {
    const sql = [
      'CREATE TABLE t (id VARCHAR(1000) NOT NULL, PRIMARY KEY (id));'
    ].join('\n');
    const problems = checkBaseline(sql, 'mysql').problems;
    assert.deepEqual(codesOf(problems), ['IDX-KEY-TOO-LONG'],
      `MySQL 主键超限的 code 不对: ${JSON.stringify(problems, null, 2)}`);
    assert.equal(problems[0].limit, 3072, 'MySQL 的门槛必须是 InnoDB 的 3072');
  });

  test('parseIndexColumns 认得前缀长度与 DESC 排序', () => {
    const cols = parseIndexColumns('[hostname], [channel], [ts] DESC');
    assert.equal(cols.length, 3);
    assert.equal(cols[0].name, 'hostname');
    assert.equal(cols[2].name, 'ts');
  });

  test('stripSqlComments 不动字符串字面量里的 -- (注释与字面量必须分开)', () => {
    const sql = "SELECT '-- not a comment' FROM t; -- real comment\n";
    const stripped = stripSqlComments(sql);
    assert.match(stripped, /-- not a comment/);
    assert.doesNotMatch(stripped, /real comment/);
  });

  test('extractStringLiterals 取出字面量内容, blankStringLiterals 只掏空内容', () => {
    const sql = "SET @s = 'CREATE INDEX x ON t (c)';";
    assert.deepEqual(extractStringLiterals(sql), ['CREATE INDEX x ON t (c)']);
    const blanked = blankStringLiterals(sql);
    assert.match(blanked, /''/);
    assert.doesNotMatch(blanked, /CREATE INDEX/);
  });
});

// ---------------------------------------------------------------------------
// 4. 真实仓库 —— 双方言基线 + 全部编号迁移必须 0 违规
// ---------------------------------------------------------------------------

describe('check-index-key-length — 真实仓库 (双方言)', () => {
  for (const dialect of ['mysql', 'mssql']) {
    const dir = resolve(MIGRATIONS_ROOT, dialect);

    test(`${dialect} 基线 0 违规`, () => {
      const sql = readFileSync(resolve(dir, '1.0.0-baseline.sql'), 'utf8');
      const { problems, stats } = checkBaseline(sql, dialect);
      assert.ok(stats.indexes > 100,
        `基线只扫到 ${stats.indexes} 条索引 —— 扫描范围退化了`);
      assert.deepEqual(problems, [],
        `${dialect} 基线有键长违规:\n${JSON.stringify(problems, null, 2)}`);
    });

    test(`${dialect} 全部编号迁移 0 违规`, () => {
      const context = buildSchemaContext(
        readFileSync(resolve(dir, '1.0.0-baseline.sql'), 'utf8'), dialect
      );
      const files = sortMigrationFiles(
        readdirSync(dir).filter((f) => f.endsWith('.sql') && f !== '1.0.0-baseline.sql')
      );
      assert.ok(files.length > 0, '编号迁移目录是空的');
      let totalIndexes = 0;
      const problems = [];
      for (const file of files) {
        const sql = readFileSync(resolve(dir, file), 'utf8');
        applyColumnAdditions(context, sql, dialect);
        const checked = checkMigrationIndexes(sql, dialect, context);
        totalIndexes += checked.stats.indexes;
        problems.push(...checked.problems);
      }
      assert.ok(totalIndexes >= 1,
        '编号迁移里一条索引都没扫到 —— 扫描范围退化了');
      assert.deepEqual(problems, [],
        `${dialect} 编号迁移有键长违规:\n${JSON.stringify(problems, null, 2)}`);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. ★ 交叉验证 —— 迁移文件里作者自声明的"键 N 字节"就是独立测试集
// ---------------------------------------------------------------------------
//
// MSSQL 侧 1.0.5~1.0.8 共 127 条索引, 每条都带一句作者手算的键字节数。
// 那 127 个数字是**独立于守卫**算出来的 ⇒ 守卫算的字节数必须与之一致。
// 这条断言把守卫的字节模型钉死在"引擎实测"上 —— 谁改了模型, 这里就红。

/**
 * 解析一行自声明注释:
 *   -- <table>.<index>  [[col], [col] DESC]  键 N 字节
 * ★ 列清单里含 ']' ⇒ 不能用 [^\]]* 去切; 要用贪婪的 \[\[(.*)\]。
 * ★ 归一化时**先剥 ASC/DESC 再剥方括号** (反了会残留 ']')。
 */
function parseDeclaration(line) {
  const m = /^--\s*([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s+\[\[(.*)\]\s+键\s+(\d+)\s+字节/.exec(line);
  if (!m) return null;
  const cols = m[3]
    .split(',')
    .map((part) => part.trim().replace(/\s+(ASC|DESC)$/i, '').replace(/^\[|\]$/g, '').trim())
    .filter(Boolean);
  return { table: m[1], index: m[2], cols, bytes: parseInt(m[4], 10) };
}

describe('check-index-key-length — ★ 交叉验证 (作者自声明的 127 条键字节数)', () => {
  const dir = resolve(MIGRATIONS_ROOT, 'mssql');
  const context = buildSchemaContext(
    readFileSync(resolve(dir, '1.0.0-baseline.sql'), 'utf8'), 'mssql'
  );
  const files = sortMigrationFiles(
    readdirSync(dir).filter((f) => f.endsWith('.sql') && f !== '1.0.0-baseline.sql')
  );

  const declarations = [];
  for (const file of files) {
    const sql = readFileSync(resolve(dir, file), 'utf8');
    applyColumnAdditions(context, sql, 'mssql');
    const collected = collectMigrationIndexes(sql, 'mssql', context);
    const byName = new Map(collected.map((i) => [`${i.table}.${i.name}`, i]));
    for (const line of sql.split(/\r?\n/)) {
      const decl = parseDeclaration(line);
      if (!decl) continue;
      const key = `${decl.table.toLowerCase()}.${decl.index.toLowerCase()}`;
      declarations.push({ file, key, decl, found: byName.get(key) });
    }
  }

  test('自声明条数不少于 120 条 (扫描范围退化的信号)', () => {
    assert.ok(declarations.length >= 120,
      `只解析到 ${declarations.length} 条声明 —— 声明格式或扫描范围变了`);
  });

  test('每条自声明的索引都必须被守卫扫到 (漏扫 = 没检查过)', () => {
    const missing = declarations.filter((d) => !d.found).map((d) => `${d.file}: ${d.key}`);
    assert.deepEqual(missing, [], `这些索引守卫没扫到:\n${missing.join('\n')}`);
  });

  test('★ 守卫算出的字节数必须与作者自声明的完全一致', () => {
    const mismatches = declarations
      .filter((d) => d.found && d.found.bytes !== d.decl.bytes)
      .map((d) => `${d.file}: ${d.key} 声明 ${d.decl.bytes}B / 守卫算 ${d.found.bytes}B`);
    assert.deepEqual(mismatches, [],
      `键字节数与自声明不一致:\n${mismatches.join('\n')}`);
  });

  test('★ 自声明的列清单顺序必须与守卫解析出的一致', () => {
    const diffs = declarations
      .filter((d) => d.found)
      .filter((d) => d.found.parts.map((p) => p.name.toLowerCase()).join(',')
        !== d.decl.cols.map((c) => c.toLowerCase()).join(','))
      .map((d) => `${d.file}: ${d.key} 声明 [${d.decl.cols}] / 守卫 [${d.found.parts.map((p) => p.name)}]`);
    assert.deepEqual(diffs, [], `列清单不一致:\n${diffs.join('\n')}`);
  });
});

// ---------------------------------------------------------------------------
// 6. 端到端 —— CLI
// ---------------------------------------------------------------------------

describe('check-index-key-length — 端到端 (CLI)', () => {
  test('CLI 以 0 退出 (当前仓库是干净的)', async () => {
    const { execFileSync } = await import('node:child_process');
    const script = resolve(SERVER_ROOT, 'scripts', 'audit', 'check-index-key-length.mjs');
    let stdout = '';
    let exitCode = 0;
    try {
      stdout = execFileSync(process.execPath, [script], { encoding: 'utf8' });
    } catch (err) {
      stdout = err.stdout || '';
      exitCode = err.status;
    }
    assert.equal(exitCode, 0, `守卫应当通过, 退出码 ${exitCode}:\n${stdout}`);
    assert.match(stdout, /OK: 索引键长度全部在引擎上限内/);
  });

  test('CLI 的 --json 输出可解析, 且 problems 为空', async () => {
    const { execFileSync } = await import('node:child_process');
    const script = resolve(SERVER_ROOT, 'scripts', 'audit', 'check-index-key-length.mjs');
    const stdout = execFileSync(process.execPath, [script, '--json'], { encoding: 'utf8' });
    const parsed = JSON.parse(stdout);
    assert.deepEqual(parsed.problems, [], 'CLI --json 报出了问题');
    assert.ok(parsed.files.length > 10,
      `CLI 只扫了 ${parsed.files.length} 个文件 —— 扫描范围退化了`);
    // 基线 + 编号迁移都必须被扫到
    assert.ok(parsed.files.some((f) => f.role === 'baseline'));
    assert.ok(parsed.files.some((f) => f.role === 'migration'));
  });

  test('迁移引擎用的版本排序与守卫用的是同一份 (排序错 ⇒ 迁移执行顺序也错)', () => {
    const dir = resolve(MIGRATIONS_ROOT, 'mssql');
    const files = sortMigrationFiles(readdirSync(dir).filter((f) => f.endsWith('.sql')));
    const versions = files.map((f) => parseFileMeta(f).version);
    const sorted = [...versions].sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i += 1) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d;
      }
      return 0;
    });
    assert.deepEqual(versions, sorted,
      `迁移版本排序不对: ${versions.join(', ')} —— '1.0.10' 必须排在 '1.0.2' 后面`);
  });
});
