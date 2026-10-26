// R161.5 — MySQL 5.7 兼容守卫 (check-mysql57-compat.mjs) 的回归网
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
// 为什么需要这个守卫 (R161.5 的根因):
//   项目历史把 db.dialect 钉死在 'mssql' ⇒ MySQL 分支从未在生产跑过 ⇒
//   整族 "MySQL 8.0 才有" 的语法 (CTE / 窗口函数 / ADD COLUMN IF NOT
//   EXISTS ...) 在 MSSQL 上完全看不出来, 一次换库就全部炸成 500。
//
// 用法: cd Server/center && npm test   (或 node --test tests/mysql57-compat.test.js)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MYSQL57_RULES,
  checkMysql57Sql,
  checkMysqlSqlFiles,
  checkSqlJsMysqlVariant,
  checkSqlModuleMysqlVariant,
  checkSqlModules,
  collectMysqlSqlCandidates,
  dedupeProblems,
  extractDialectVariant,
  extractMysqlNamedConsts,
  extractMysqlVariantBlocks,
  extractStringLiterals,
  stripSqlComments,
} from '../../scripts/audit/check-mysql57-compat.mjs';
import { BUILTIN_PACKAGES } from '../src/services/builtin-packages.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, '..', '..');            // Server/
const REPO_ROOT = resolve(SERVER_ROOT, '..');              // repo root

const SQL_JS = resolve(SERVER_ROOT, 'center', 'src', 'db', 'sql.js');
const SQL_MODULE_DIR = resolve(SERVER_ROOT, 'center', 'src', 'db', 'sql');
const PACKAGES_ROOT = resolve(SERVER_ROOT, 'center', 'data', 'packages');
const MYSQL_BASELINE_DIR = resolve(SERVER_ROOT, 'db', 'migrations', 'mysql');

/** 收集某个检查结果里的问题 code 集合。 */
function codesOf(problems) {
  return problems.map((p) => p.code);
}

// ---------------------------------------------------------------------------
// 负样本表 —— 每条规则一个必须触发的样本
// ---------------------------------------------------------------------------
//
// 样本必须满足: ① 只命中它对应的那一条规则 (否则"只命中自己"断言会失败,
// 让人分不清是规则错还是样本错); ② 是真实可能写出来的 SQL。
const NEGATIVE_SAMPLES = {
  'MYSQL57-HAS-CTE':
    'WITH top_agents AS (SELECT agent_id FROM ad_lockout_events GROUP BY agent_id) ' +
    'SELECT * FROM top_agents',
  'MYSQL57-HAS-WINDOW-FUNCTION':
    'SELECT ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY id DESC) AS rn FROM ad_lockout_events',
  'MYSQL57-HAS-ADD-COLUMN-IF-NOT-EXISTS':
    'ALTER TABLE pkg_ad_os_baseline.metrics ADD COLUMN IF NOT EXISTS bios_info JSON NULL',
  'MYSQL57-HAS-CREATE-INDEX-IF-NOT-EXISTS':
    'CREATE INDEX IF NOT EXISTS idx_agent ON ad_lockout_events (agent_id)',
  'MYSQL57-HAS-DROP-INDEX-IF-EXISTS':
    'DROP INDEX IF EXISTS idx_agent ON ad_lockout_events',
  'MYSQL57-HAS-RENAME-COLUMN':
    'ALTER TABLE ad_lockout_events RENAME COLUMN target_user_name TO sam_account',
  'MYSQL57-HAS-JSON-TABLE':
    "SELECT * FROM JSON_TABLE(@payload, '$[*]' COLUMNS (id INT PATH '$.id')) AS t",
  'MYSQL57-HAS-REGEXP-FUNCTION':
    "SELECT REGEXP_LIKE(target_user_name, '^admin') FROM ad_lockout_events",
  'MYSQL57-HAS-LATERAL':
    'SELECT * FROM ad_lockout_events e, LATERAL (SELECT COUNT(*) FROM ad_dcs) d',
  'MYSQL57-HAS-SKIP-LOCKED':
    'SELECT id FROM ad_lockout_events WHERE agent_id = ? FOR UPDATE SKIP LOCKED',
  'MYSQL57-HAS-WITH-CUBE':
    'SELECT agent_id, COUNT(*) FROM ad_lockout_events GROUP BY agent_id WITH CUBE',
};

// ---------------------------------------------------------------------------
// 1. 负样本 —— 每条规则必须能抓到自己的样本
// ---------------------------------------------------------------------------

describe('check-mysql57-compat — 负样本 (每条规则都必须触发)', () => {
  test('规则表里每条规则都有对应负样本 (加规则忘了写样本 ⇒ 这里失败)', () => {
    const ruleCodes = MYSQL57_RULES.map((r) => r.code).sort();
    const sampleCodes = Object.keys(NEGATIVE_SAMPLES).sort();
    assert.deepEqual(
      sampleCodes, ruleCodes,
      '负样本表与规则表必须一一对应 —— 有规则没有样本 = 这条规则从没被验证过'
    );
  });

  test('每条规则都抓到自己的样本 (且只抓到自己的)', () => {
    for (const [code, sql] of Object.entries(NEGATIVE_SAMPLES)) {
      const problems = checkMysql57Sql(sql, `sample:${code}`);
      assert.ok(problems.length > 0, `规则 ${code} 没抓到自己的样本 —— 规则失效了`);
      assert.deepEqual(
        codesOf(problems), [code],
        `规则 ${code} 抓到了额外的规则: ${JSON.stringify(codesOf(problems))} —— 样本或规则有串扰`
      );
    }
  });

  test('每条规则都带 since (写明该语法从哪个 MySQL 版本起才有)', () => {
    for (const rule of MYSQL57_RULES) {
      assert.ok(rule.since && /^\d/.test(rule.since),
        `规则 ${rule.code} 缺 since 标注`);
      assert.ok(rule.why && rule.why.length > 20,
        `规则 ${rule.code} 的 why 太短 —— 报错文案要能直接告诉操作员怎么办`);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. 不误报 —— 5.7 兼容的写法必须放行
// ---------------------------------------------------------------------------

describe('check-mysql57-compat — 不误报 (5.7 兼容写法必须放行)', () => {
  const CLEAN_SQL = [
    'SELECT a, COUNT(*) FROM ad_lockout_events GROUP BY a',
    // 派生表 (5.7 兼容的 CTE 替代写法)
    'SELECT * FROM (SELECT agent_id FROM ad_lockout_events GROUP BY agent_id) ta',
    // REGEXP 运算符 (不是 REGEXP_LIKE 函数)
    "SELECT * FROM ad_lockout_events WHERE target_user_name REGEXP '^admin'",
    // ROLLUP (不是 CUBE)
    'SELECT agent_id, COUNT(*) FROM ad_lockout_events GROUP BY agent_id WITH ROLLUP',
    // 字符串里出现 "OVER" 但不是窗口函数
    "SELECT 'OVER (PARTITION BY)' AS note FROM ad_lockout_events",
    // INFORMATION_SCHEMA 守卫范式 (基线里用的就是它)
    "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='pkg_x' AND COLUMN_NAME='a'",
    // 5.7 的 ALTER 改列名写法
    'ALTER TABLE ad_lockout_events CHANGE target_user_name sam_account VARCHAR(256) NULL',
  ];

  for (const sql of CLEAN_SQL) {
    test(`放行: ${sql.slice(0, 60)}`, () => {
      assert.deepEqual(checkMysql57Sql(sql, 'clean'), [],
        `5.7 兼容的 SQL 被误报: ${sql}`);
    });
  }

  test('SQL 注释里的 8.0 关键字不误报 (注释会解释"为什么不能这么写")', () => {
    const sql = [
      '-- 1) MySQL 5.7 没有 ADD COLUMN IF NOT EXISTS (8.0.29+ 才有)',
      '/* 旧写法是 WITH x AS (...) + ROW_NUMBER() OVER (...) */',
      'CREATE TABLE t (a INT NULL)'
    ].join('\n');
    assert.deepEqual(checkMysql57Sql(stripSqlComments(sql), 'commented'), [],
      '注释里的关键字被误报了');
  });

  test('JS 注释里的 8.0 关键字不误报 (sql.js 里大量对照说明)', () => {
    const js = [
      '// 原写法是 WITH top_agents AS (...); CTE 是 MySQL 8.0+ 语法',
      '/* ROW_NUMBER() OVER (PARTITION BY ...) */',
      'const sql = `SELECT 1 FROM t`;'
    ].join('\n');
    const literals = extractStringLiterals(js);
    assert.equal(literals.length, 1, `JS 注释里的字符串不该被抽出来: ${JSON.stringify(literals)}`);
    assert.equal(literals[0].content, 'SELECT 1 FROM t');
  });
});

// ---------------------------------------------------------------------------
// 3. 扫描范围 —— 只扫 mysql 段, mssql 段里的 CTE 是合法的
// ---------------------------------------------------------------------------

describe('check-mysql57-compat — 扫描范围切分', () => {
  const source = readFileSync(SQL_JS, 'utf8');

  test('extractDialectVariant 能切出 mysql 段 (且不含 mssql 段)', () => {
    const variant = extractDialectVariant(source, 'mysql');
    assert.ok(variant !== null, '切不出 mysql 段');
    assert.ok(variant.length > 1000, `mysql 段长度异常: ${variant.length}`);
    // mssql 段的标志物不应出现在 mysql 段里。
    assert.ok(!/SELECT\s+TOP\s*\(\s*\?\s*\)/i.test(variant),
      'mysql 段里出现了 MSSQL 的 SELECT TOP (?) —— 说明切段越界了');
  });

  test('mssql 段里的 CTE 不被守卫报 (MSSQL 2005+ 本来就支持 CTE)', () => {
    const mssqlVariant = extractDialectVariant(source, 'mssql');
    assert.ok(mssqlVariant !== null, '切不出 mssql 段');
    assert.ok(/WITH\s+[A-Za-z_][A-Za-z0-9_]*\s+AS\s*\(/i.test(mssqlVariant),
      'mssql 段里应当确实存在 CTE (前提条件: 否则这条断言没意义)');

    const result = checkSqlJsMysqlVariant(source, {});
    const cteHits = result.problems.filter((p) => p.code === 'MYSQL57-HAS-CTE');
    assert.deepEqual(cteHits, [],
      `mssql 段的 CTE 不该被 MySQL 5.7 守卫抓到: ${JSON.stringify(cteHits, null, 2)}`);
  });

  test('variant 标记缺失 ⇒ 必须报错, 不能静默通过', () => {
    const result = checkSqlJsMysqlVariant('const VARIANTS = { mssql: { a: 1 } };', {});
    assert.ok(result.problems.length > 0, '找不到 mysql 段时必须报错 —— 静默通过的守卫等于没有守卫');
    assert.equal(result.problems[0].code, 'MYSQL57-VARIANT-NOT-FOUND');
  });

  test('括号不配平 ⇒ 必须报错 (源文件被改坏时不能当成"没问题")', () => {
    const broken = 'const VARIANTS = {\n  mysql: {\n    a: `SELECT 1`,\n';
    const result = checkSqlJsMysqlVariant(broken, {});
    assert.ok(result.problems.some((p) => p.code === 'MYSQL57-VARIANT-NOT-FOUND'),
      `括号不配平必须报错, 实际: ${JSON.stringify(result.problems)}`);
  });
});

// ---------------------------------------------------------------------------
// 4. 真实仓库 —— 当前必须是干净的
// ---------------------------------------------------------------------------

describe('check-mysql57-compat — 真实仓库', () => {
  test('sql.js 的 mysql 段 0 违规 (R161.5 已把 7 处 CTE 全部改写)', () => {
    const source = readFileSync(SQL_JS, 'utf8');
    const result = checkSqlJsMysqlVariant(source, {});
    const errors = result.problems.filter((p) => p.severity === 'error');
    assert.deepEqual(
      errors, [],
      `sql.js mysql 段有 5.7 不兼容语法:\n${JSON.stringify(errors, null, 2)}`
    );
  });

  test('MySQL 基线 0 违规 (基线用的是 INFORMATION_SCHEMA + PREPARE 守卫范式)', () => {
    assert.ok(existsSync(MYSQL_BASELINE_DIR), `基线目录不存在: ${MYSQL_BASELINE_DIR}`);
    const problems = checkMysqlSqlFiles({
      repoRoot: REPO_ROOT,
      builtins: BUILTIN_PACKAGES,
      packagesRoot: PACKAGES_ROOT
    });
    const errors = problems.filter((p) => p.severity === 'error');
    assert.deepEqual(
      errors, [],
      `MySQL 基线/声明版本迁移有 5.7 不兼容语法:\n${JSON.stringify(errors, null, 2)}`
    );
  });

  test('内置包声明版本的迁移 0 违规', () => {
    const problems = checkMysqlSqlFiles({
      repoRoot: REPO_ROOT,
      builtins: BUILTIN_PACKAGES,
      packagesRoot: PACKAGES_ROOT
    });
    const declared = problems.filter((p) => p.severity === 'error');
    assert.deepEqual(declared, [], JSON.stringify(declared, null, 2));
  });

  test('历史版本目录的地雷降级为 warning (惰性目录, 不阻塞, 但不许消失)', () => {
    const problems = checkMysqlSqlFiles({
      repoRoot: REPO_ROOT,
      builtins: BUILTIN_PACKAGES,
      packagesRoot: PACKAGES_ROOT
    });
    const warnings = problems.filter((p) => p.severity === 'warning');
    // 前置条件: 历史上确实留了 MySQL 8 语法的历史迁移 (ad_os_baseline
    // 1.0.3~1.0.8)。若将来有人把这些历史目录清理掉了, 这条断言会失败 ——
    // 那时应当把本条断言改成"warning 数 == 0", 不是把守卫的扫描删掉。
    assert.ok(warnings.length > 0,
      '预期存在历史版本目录的 warning —— 若历史目录已被清理, 请改写本断言');
    for (const w of warnings) {
      assert.match(w.detail, /历史版本目录/,
        'warning 文案应说明它是惰性的历史目录');
      assert.match(w.detail, /不会被 seeder 复制/,
        'warning 文案应说明为什么现在不炸');
    }
  });

  test('声明版本目录里的问题必须是 error (不能降级成 warning 蒙混过关)', () => {
    // 造一个"声明版本里有 8.0 语法"的假包来验证分级逻辑。
    const problems = checkMysqlSqlFiles({
      repoRoot: REPO_ROOT,
      builtins: [{ name: 'ad_os_baseline', version: '1.0.3' }],   // 故意指到历史版本
      packagesRoot: PACKAGES_ROOT
    });
    const errors = problems.filter((p) => p.severity === 'error');
    assert.ok(errors.length > 0,
      '当 BUILTIN_PACKAGES 指向含 8.0 语法的目录时, 必须报 error');
    assert.ok(errors.some((p) => p.code === 'MYSQL57-HAS-ADD-COLUMN-IF-NOT-EXISTS'));
  });
});

// ---------------------------------------------------------------------------
// 5. 端到端 —— CLI 跑一遍
// ---------------------------------------------------------------------------

describe('check-mysql57-compat — 端到端', () => {
  test('CLI 以 0 退出 (当前仓库是干净的)', async () => {
    const { execFileSync } = await import('node:child_process');
    const script = resolve(SERVER_ROOT, 'scripts', 'audit', 'check-mysql57-compat.mjs');
    let stdout = '';
    let exitCode = 0;
    try {
      stdout = execFileSync(process.execPath, [script], { encoding: 'utf8' });
    } catch (err) {
      stdout = err.stdout || '';
      exitCode = err.status;
    }
    assert.equal(exitCode, 0, `守卫应当通过, 退出码 ${exitCode}:\n${stdout}`);
    assert.match(stdout, /0 error\(s\)/);
  });
});

// ---------------------------------------------------------------------------
// 6. db/sql/*.js 独立模块 (R161.5 的守卫漏项)
// ---------------------------------------------------------------------------
//
// 背景: sql.js 的 VARIANTS.mysql 只注册了一部分双 dialect 模块, 而且
// 注册的是 `X.mysql` 而不是 `X` ⇒ checkRuntimeSqlTree 只走两层, 遇到
// `{ mysql, mssql }` 这种"query 是对象"的情形直接 continue ⇒
// forestRegistry 的 26 段 SQL 完全在盲区。而这些 SQL 的文本又不在
// sql.js 里 ⇒ sql.js 的静态腿也扫不到。
//
// 这一节测三件事:
//   ① 守卫**能抓到** MySQL 侧的真缺陷 (正样本);
//   ② 守卫**不误报** MSSQL 侧 (MSSQL 的 CTE/窗口函数本来就合法);
//   ③ 真实仓库里 30 个模块确实被扫到了 (覆盖度断言, 防盲区重现)。

describe('check-mysql57-compat — db/sql/*.js 独立模块', () => {
  const CTE_IN_MYSQL = 'WITH latest AS (SELECT agent_id FROM ad_lockout_events) SELECT * FROM latest';

  test('mysql 变体块里的 CTE 必须被抓到', () => {
    const source = [
      'export const demo = {',
      '  mysql: {',
      `    list: \`${CTE_IN_MYSQL}\`,`,
      '  },',
      '  mssql: {',
      '    list: `SELECT TOP 10 * FROM ad_lockout_events`,',
      '  },',
      '};'
    ].join('\n');
    const result = checkSqlModuleMysqlVariant({ source, label: 'demo' });
    const hits = result.problems.filter((p) => p.code === 'MYSQL57-HAS-CTE');
    assert.equal(hits.length, 1,
      `必须抓到 1 处 CTE, 实际:\n${JSON.stringify(result.problems, null, 2)}`);
  });

  test('mssql 变体块里的 CTE 不得被抓到 (MSSQL 2005+ 本来就支持 CTE)', () => {
    const source = [
      'export const demo = {',
      '  mssql: {',
      `    list: \`${CTE_IN_MYSQL}\`,`,
      '  },',
      '};'
    ].join('\n');
    const result = checkSqlModuleMysqlVariant({ source, label: 'demo' });
    assert.deepEqual(result.problems, [],
      `mssql 侧的 CTE 被误报了:\n${JSON.stringify(result.problems, null, 2)}`);
  });

  test('const <NAME>_MYSQL 里的 CTE 必须被抓到 (命名约定那一腿)', () => {
    const source = [
      'const LIST_SUMMARY_MYSQL = `',
      `  ${CTE_IN_MYSQL}`,
      '`;',
      'const LIST_SUMMARY_MSSQL = LIST_SUMMARY_MYSQL;'
    ].join('\n');
    const result = checkSqlModuleMysqlVariant({ source, label: 'demo' });
    const hits = result.problems.filter((p) => p.code === 'MYSQL57-HAS-CTE');
    assert.equal(hits.length, 1,
      `必须抓到 1 处 CTE, 实际:\n${JSON.stringify(result.problems, null, 2)}`);
  });

  test('const <NAME>_MSSQL 里的 CTE 不得被抓到', () => {
    const source = [
      'const LIST_SUMMARY_MSSQL = `',
      `  ${CTE_IN_MYSQL}`,
      '`;'
    ].join('\n');
    const result = checkSqlModuleMysqlVariant({ source, label: 'demo' });
    assert.deepEqual(result.problems, [],
      `MSSQL 常量被误报了:\n${JSON.stringify(result.problems, null, 2)}`);
  });

  test('函数型 mysql 变体 (mysql: ({...}) => `...`) 里的 CTE 必须被抓到 (运行时腿)', () => {
    // 这个形态静态腿切不到 (mysql: 后面不是 '{'), 只有运行时腿能抓 ——
    // os-baseline-timeseries.js 就是这个形态。
    const source = [
      'export const synth = {',
      '  mysql: ({ agentIds, sinceMinutes }) => `',
      `    ${CTE_IN_MYSQL}`,
      '  `,',
      '  mssql: ({ agentIds, sinceMinutes }) => `',
      `    ${CTE_IN_MYSQL}`,
      '  `',
      '};'
    ].join('\n');
    const moduleExports = {
      synth: {
        mysql: ({ agentIds, sinceMinutes }) => `    ${CTE_IN_MYSQL}`,
        mssql: ({ agentIds, sinceMinutes }) => `    ${CTE_IN_MYSQL}`
      }
    };
    const result = checkSqlModuleMysqlVariant({ source, moduleExports, label: 'demo' });
    const hits = result.problems.filter((p) => p.code === 'MYSQL57-HAS-CTE');
    assert.equal(hits.length, 1,
      `函数型 mysql 变体必须被抓到 1 处, 实际:\n${JSON.stringify(result.problems, null, 2)}`);
  });

  test('导出树里 mssql 键下的 SQL 不得进候选集 (运行时腿的方言切分)', () => {
    const candidates = collectMysqlSqlCandidates({
      a: { mysql: 'SELECT 1 FROM t', mssql: 'SELECT TOP 1 FROM t' },
      b: { mysql: 'SELECT 2 FROM t' }
    }, 'demo');
    const paths = candidates.map((c) => c.path).sort();
    assert.deepEqual(paths, ['demo.a.mysql', 'demo.b.mysql'],
      `候选集里混进了 mssql 侧: ${JSON.stringify(paths)}`);
  });

  test('4 种模块形态都要收进候选集', () => {
    const candidates = collectMysqlSqlCandidates({
      // ① { mysql: { a, b }, mssql: {...} }
      x: { mysql: { a: 'SELECT 1 FROM t', b: 'SELECT 2 FROM t' }, mssql: { a: 'x', b: 'y' } },
      // ② { a: { mysql, mssql } }
      y: { a: { mysql: 'SELECT 3 FROM t', mssql: 'SELECT TOP 3 FROM t' } },
      // ③ { mysql: fn }
      z: { mysql: () => 'SELECT 4 FROM t', mssql: () => 'SELECT TOP 4 FROM t' },
      // ④ { a: { mysql: fn } }
      w: { a: { mysql: () => 'SELECT 5 FROM t' } }
    }, 'demo');
    const paths = candidates.map((c) => c.path).sort();
    assert.deepEqual(paths, [
      'demo.w.a.mysql',
      'demo.x.mysql.a',
      'demo.x.mysql.b',
      'demo.y.a.mysql',
      'demo.z.mysql'
    ], `候选集形态覆盖不全: ${JSON.stringify(paths)}`);
  });

  test('extractMysqlVariantBlocks 切出全部 mysql 段 (缩进不限, 个数不限)', () => {
    const source = [
      'export const a = {',
      '  mysql: { x: 1 },',
      '  mssql: { x: 2 }',
      '};',
      'export const b = {',
      '    mysql: {',
      '        y: 1',
      '    },',
      '    mssql: { y: 2 }',
      '};'
    ].join('\n');
    const blocks = extractMysqlVariantBlocks(source);
    assert.ok(Array.isArray(blocks), '必须切出数组');
    assert.equal(blocks.length, 2, `必须切出 2 段, 实际 ${blocks.length}`);
    assert.match(blocks[0], /x: 1/);
    assert.match(blocks[1], /y: 1/);
    assert.ok(!/x: 2/.test(blocks[0]), 'mssql 段混进了 mysql 段');
  });

  test('extractMysqlNamedConsts 只认 _MYSQL 后缀', () => {
    const source = [
      'const A_MYSQL = `SELECT 1`;',
      'const A_MSSQL = `SELECT TOP 1`;',
      'const B = `SELECT 2`;'
    ].join('\n');
    const named = extractMysqlNamedConsts(source);
    assert.deepEqual(named.map((n) => n.name), ['A_MYSQL'],
      `命名约定提取错了: ${JSON.stringify(named.map((n) => n.name))}`);
  });

  test('mysql 块括号不配平 ⇒ 必须报错 (源文件被改坏时不能当成"没问题")', () => {
    const broken = 'export const a = {\n  mysql: {\n    x: `SELECT 1`,\n';
    const result = checkSqlModuleMysqlVariant({ source: broken, label: 'broken' });
    assert.ok(result.problems.some((p) => p.code === 'MYSQL57-MODULE-VARIANT-NOT-FOUND'),
      `括号不配平必须报错, 实际: ${JSON.stringify(result.problems)}`);
  });

  test('真实仓库: 30 个双 dialect 模块 0 违规', async () => {
    const result = await checkSqlModules({
      sqlModuleDir: SQL_MODULE_DIR,
      repoRoot: REPO_ROOT
    });
    const errors = result.problems.filter((p) => p.severity === 'error');
    assert.deepEqual(errors, [],
      `db/sql/*.js 的 MySQL 侧有 5.7 不兼容语法:\n${JSON.stringify(errors, null, 2)}`);
  });

  test('覆盖度断言: 30 个模块都被扫到了 (防"扫了 0 条"式静默通过)', async () => {
    const result = await checkSqlModules({
      sqlModuleDir: SQL_MODULE_DIR,
      repoRoot: REPO_ROOT
    });
    const moduleCount = readdirSync(SQL_MODULE_DIR).filter((n) => n.endsWith('.js')).length;
    assert.ok(moduleCount >= 30, `模块数异常: ${moduleCount}`);
    assert.equal(result.scanned.length, moduleCount,
      `只扫了 ${result.scanned.length} 个模块, 目录里有 ${moduleCount} 个 —— 有模块没被扫到`);
    // 每个模块至少要有一条 SQL 被两条腿中的某一条覆盖 (静态腿 0 且运行时腿 0
    // ⇒ 这个模块被静默跳过了)。
    const silent = result.scanned.filter((m) => m.staticLiterals === 0 && m.runtimeCandidates === 0);
    assert.deepEqual(silent, [],
      `这些模块一条 SQL 都没扫到 (静默通过): ${JSON.stringify(silent, null, 2)}`);
    // 两条腿的并集必须覆盖到全部模块 (静态腿切不到的形态由运行时腿兜住,
    // 反之亦然) —— 少一个就是覆盖面回退了。
    const coveredByEither = result.scanned.filter(
      (m) => m.staticLiterals > 0 || m.runtimeCandidates > 0
    );
    assert.equal(coveredByEither.length, moduleCount,
      '有模块两条腿都没覆盖到');
  });

  test('盲区回归: forestRegistry 当年是扫不到的, 现在必须扫到', async () => {
    // sql.js 注册的是 `forestRegistry` 整个对象 (不是 forestRegistry.mysql)
    // ⇒ checkRuntimeSqlTree 走两层时看不到它 ⇒ 这 26 段 SQL 曾经完全没被扫过。
    const file = resolve(SQL_MODULE_DIR, 'forest-registry.js');
    const source = readFileSync(file, 'utf8');
    const moduleExports = await import(`file:///${file.replace(/\\/g, '/')}`);
    const candidates = collectMysqlSqlCandidates(moduleExports, 'forest-registry');
    assert.ok(candidates.length >= 20,
      `forestRegistry 只收到 ${candidates.length} 个候选 —— 盲区重现了`);
    const result = checkSqlModuleMysqlVariant({ source, moduleExports, label: 'forest-registry' });
    assert.deepEqual(result.problems.filter((p) => p.severity === 'error'), [],
      'forestRegistry 的 MySQL 侧有 5.7 不兼容语法');
  });

  test('模块目录不存在 ⇒ 必须报错 (不能当成"没问题")', async () => {
    const result = await checkSqlModules({
      sqlModuleDir: resolve(SQL_MODULE_DIR, 'no-such-dir'),
      repoRoot: REPO_ROOT
    });
    assert.ok(result.problems.some((p) => p.code === 'MYSQL57-MODULE-DIR-MISSING'),
      `目录不存在必须报错, 实际: ${JSON.stringify(result.problems)}`);
  });

  test('端到端: 放一个含 8.0 语法的模块进临时目录 ⇒ 真实扫描入口必须报 error', async () => {
    // 这一条走的是 checkSqlModules (main() 用的同一个入口), 而不是
    // checkSqlModuleMysqlVariant (被测的纯函数) ⇒ 证明"接线"也是通的。
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const tempDir = mkdtempSync(join(tmpdir(), 'r1615-mysql57-'));
    try {
      writeFileSync(join(tempDir, 'bad-module.js'), [
        'export const bad = {',
        '  mysql: {',
        '    list: `WITH latest AS (SELECT agent_id FROM ad_lockout_events) SELECT * FROM latest`,',
        '  },',
        '  mssql: {',
        '    list: `SELECT TOP 10 * FROM ad_lockout_events`,',
        '  }',
        '};',
        ''
      ].join('\n'), 'utf8');
      const result = await checkSqlModules({ sqlModuleDir: tempDir, repoRoot: REPO_ROOT });
      const errors = result.problems.filter((p) => p.severity === 'error');
      assert.ok(errors.length > 0, '含 8.0 语法的模块必须被报成 error');
      assert.ok(errors.some((p) => p.code === 'MYSQL57-HAS-CTE'),
        `报出来的 code 不对: ${JSON.stringify(errors.map((e) => e.code))}`);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('dedupeProblems 合并同一处缺陷的重复报告 (模块腿 + sql.js 树腿)', () => {
    const problem = (detail) => ({
      code: 'MYSQL57-HAS-CTE',
      severity: 'error',
      detail,
      excerpt: 'WITH latest AS (SELECT agent_id FROM ad_lockout_events) SELECT * FROM late'
    });
    const deduped = dedupeProblems([
      problem('模块腿'),
      problem('sql.js 树腿'),
      problem('第三条')
    ]);
    assert.equal(deduped.length, 1, `应当合并成 1 条, 实际 ${deduped.length}`);
    assert.equal(deduped[0].detail, '模块腿', '应当保留第一条 (定位更精确的那条)');
    assert.equal(deduped[0].duplicateCount, 2, '应当记录被合并的条数');
  });
});
