// R161.14 (2026-10-27) — 视图列 collation 契约的回归网。
//
// ★ 要钉住的事实 (不是注释):
//   A. MySQL 基线里 v_partner_inbound.probe_state 必须带**显式** COLLATE
//      utf8mb4_unicode_ci —— 它是**字面量派生**的列 (CASE ... THEN 'error' END),
//      MySQL 会把**建视图那条连接**的 collation 冻结进视图定义。不写死 ⇒
//      建视图时连接是 general_ci 就永久是 general_ci (真库实测就是 general_ci),
//      而连接一旦改成 unicode_ci (R161.12) ⇒ 任何 `probe_state = 'x'` /
//      `UNION ALL SELECT 'x'` 撞 1267/1271 (真库实测复现过)。
//   A2. **凡是**基线里含字面量派生表达式 (THEN '...' / ELSE '...') 的视图,
//      都必须带显式 COLLATE —— 防止以后新加视图时又忘了。
//   B. 1.0.1 迁移里的视图主体必须与基线**逐字等价** (剥注释 + 归一化空白后
//      完全相同) —— 改了基线忘了改迁移, 这里立刻红。
//   C. 1.0.1 必须用 CREATE OR REPLACE (原子替换 + 幂等) 且必须带
//      lock_wait_timeout 护栏 (抢不到元数据锁时**快速失败**而不是挂死启动)。
//   D. MSSQL 侧**不许**硬编码 COLLATE 名 (库级 collation, 客户库各不相同),
//      且 1.0.1 必须是**空迁移** (切分出 0 条语句) —— 证明"有意为之的空",
//      而不是"忘了写"。MSSQL 侧不需要改: SQL Server 的强制转换规则里列永远
//      赢字面量, 且所有对象同源于库级 collation。
//   E. 库默认 collation 的对齐**不做成迁移** —— MySQL 5.7 不允许把
//      ALTER DATABASE 放进服务端 PREPARE (ER_UNSUPPORTED_PS 1295),
//      迁移拿不到库名; 而且擅自改一个已存在客户库的默认排序规则是越界。
//      本文件钉住"别再走那条路", 并把结论留在迁移文件里。
//   F. 交付包 (LinuxServer/db) 必须与源树**逐字节**一致。
//
// 用法: cd Server/center && npm test

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { splitSqlStatements } from '../src/init/schema-applier.js';
import { stripSqlComments } from '../../scripts/audit/check-dialect-compat.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, '..', '..');            // Server/
const REPO_ROOT = resolve(SERVER_ROOT, '..');              // 仓库根
const MYSQL_DIR = resolve(SERVER_ROOT, 'db', 'migrations', 'mysql');
const MSSQL_DIR = resolve(SERVER_ROOT, 'db', 'migrations', 'mssql');
const LINUX_MYSQL_DIR = resolve(REPO_ROOT, 'LinuxServer', 'db', 'migrations', 'mysql');
const LINUX_MSSQL_DIR = resolve(REPO_ROOT, 'LinuxServer', 'db', 'migrations', 'mssql');

const MYSQL_BASELINE = resolve(MYSQL_DIR, '1.0.0-baseline.sql');
const MSSQL_BASELINE = resolve(MSSQL_DIR, '1.0.0-baseline.sql');
const MYSQL_MIG_101 = resolve(MYSQL_DIR, '1.0.1-view-collation-align.sql');
const MSSQL_MIG_101 = resolve(MSSQL_DIR, '1.0.1-view-collation-align.sql');

const VIEW_NAME = 'v_partner_inbound';

/** 从 SQL 文本里取出目标视图的定义语句 (切分器已剥掉注释)。 */
function extractViewStatement(filePath, { allowOrReplace = false } = {}) {
  const stmts = splitSqlStatements(readFileSync(filePath, 'utf8'));
  const head = allowOrReplace
    ? /^CREATE\s+OR\s+REPLACE\s+VIEW/i
    : /^CREATE\s+VIEW/i;
  const found = stmts.find((s) => head.test(s.trim()) && new RegExp(`\\b${VIEW_NAME}\\b`, 'i').test(s));
  assert.ok(found, `${filePath} 里找不到 ${VIEW_NAME} 的定义语句`);
  return found.trim();
}

/** 归一化: 压掉所有空白, 让"只是排版不同"不算差异。 */
function normalize(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

describe('A. MySQL 基线: probe_state 必须带显式 COLLATE', () => {
  test('基线文件存在', () => {
    assert.ok(existsSync(MYSQL_BASELINE), `MySQL 基线必须存在: ${MYSQL_BASELINE}`);
  });

  test('v_partner_inbound.probe_state 带 COLLATE utf8mb4_unicode_ci', () => {
    const view = extractViewStatement(MYSQL_BASELINE);
    assert.ok(/probe_state/i.test(view), '视图里必须有 probe_state 列');
    assert.ok(
      /COLLATE\s+utf8mb4_unicode_ci\s+AS\s+probe_state/i.test(view),
      '基线里 probe_state 必须写成 `... COLLATE utf8mb4_unicode_ci AS probe_state` —— '
      + '它是字面量派生列, 不写死就继承建视图连接的 collation (真库实测 = general_ci)'
    );
  });

  test('基线里所有 COLLATE 名只有一个 (schema 的 collation 必须唯一)', () => {
    const sql = readFileSync(MYSQL_BASELINE, 'utf8');
    const names = new Set(
      [...sql.matchAll(/COLLATE\s+(?!=)([a-z0-9_]+)/gi)].map((m) => m[1].toLowerCase())
    );
    assert.ok(names.size > 0, '基线里必须真的声明了 collation (否则这条断言是哑巴)');
    assert.deepEqual([...names], ['utf8mb4_unicode_ci'], `schema 的 collation 必须唯一, 实际: ${[...names].join(', ')}`);
  });
});

describe('A2. 凡是含字面量派生表达式的 MySQL 视图, 都必须带显式 COLLATE', () => {
  test('扫描基线里的全部 CREATE VIEW', () => {
    const stmts = splitSqlStatements(readFileSync(MYSQL_BASELINE, 'utf8'));
    const views = stmts.filter((s) => /^\s*CREATE\s+(OR\s+REPLACE\s+)?VIEW/i.test(s));
    assert.ok(views.length > 0, '基线里必须真的建了视图 (否则这条断言是哑巴)');

    for (const view of views) {
      const name = view.match(/VIEW\s+([a-z0-9_]+)/i)?.[1] ?? '(未知)';
      // 字面量派生 = CASE/COALESCE 里出现 THEN '...' / ELSE '...'
      const literalDerived = /\b(THEN|ELSE)\s*'/i.test(view);
      if (!literalDerived) continue;
      assert.ok(
        /COLLATE\s+utf8mb4_unicode_ci/i.test(view),
        `视图 ${name} 里有字面量派生表达式, 必须带显式 COLLATE utf8mb4_unicode_ci —— `
        + '否则这一列继承**建视图那条连接**的 collation, 连接一改就撞 1267/1271'
      );
    }
  });
});

describe('B. 1.0.1 迁移的视图主体必须与基线逐字等价 (防漂移)', () => {
  test('迁移文件存在', () => {
    assert.ok(existsSync(MYSQL_MIG_101), `1.0.1 迁移必须存在: ${MYSQL_MIG_101}`);
  });

  test('基线视图主体 == 迁移视图主体 (归一化空白后完全相同)', () => {
    const fromBaseline = normalize(extractViewStatement(MYSQL_BASELINE));
    const fromMigration = normalize(
      extractViewStatement(MYSQL_MIG_101, { allowOrReplace: true })
        .replace(/^CREATE\s+OR\s+REPLACE\s+VIEW/i, 'CREATE VIEW')
    );
    assert.equal(
      fromMigration, fromBaseline,
      '1.0.1 迁移里的视图主体与基线不一致 —— 改了基线就必须同步改迁移 (反之亦然), '
      + '否则"新装"和"升级"会装出两个不一样的视图'
    );
  });
});

describe('C. 1.0.1 的执行形态', () => {
  test('用 CREATE OR REPLACE VIEW (原子替换 + 幂等, 不用 DROP+CREATE)', () => {
    const stmts = splitSqlStatements(readFileSync(MYSQL_MIG_101, 'utf8'));
    assert.ok(
      stmts.some((s) => /^\s*CREATE\s+OR\s+REPLACE\s+VIEW/i.test(s)),
      '必须用 CREATE OR REPLACE VIEW —— DROP+CREATE 有"视图不存在"的中间窗口, 而拓扑接口正在读它'
    );
    assert.ok(
      !stmts.some((s) => /^\s*DROP\s+VIEW/i.test(s)),
      '不许 DROP VIEW —— 那会留下一个视图不存在的窗口'
    );
  });

  test('带 lock_wait_timeout 护栏 (抢不到元数据锁要快速失败, 不能挂死启动)', () => {
    const stmts = splitSqlStatements(readFileSync(MYSQL_MIG_101, 'utf8'));
    const guard = stmts.find((s) => /lock_wait_timeout/i.test(s));
    assert.ok(guard, '必须先 SET SESSION lock_wait_timeout —— 默认值是一年, 会把启动流程挂死');
    assert.ok(
      /lock_wait_timeout\s*=\s*\d{1,3}\b/.test(guard) && !/=\s*31536000/.test(guard),
      'lock_wait_timeout 必须设成一个**小的**秒数'
    );
    const guardIdx = stmts.findIndex((s) => /lock_wait_timeout/i.test(s));
    const ddlIdx = stmts.findIndex((s) => /^\s*CREATE\s+OR\s+REPLACE\s+VIEW/i.test(s));
    assert.ok(guardIdx >= 0 && ddlIdx > guardIdx, 'lock_wait_timeout 必须排在 CREATE OR REPLACE VIEW 之前');
  });

  test('迁移里不许出现裸的 CAST(NULL AS CHAR) (那是 R161.12 的反面教材)', () => {
    const sql = readFileSync(MYSQL_MIG_101, 'utf8');
    assert.ok(!/CAST\s*\(\s*NULL\s+AS\s+CHAR\s*\)/i.test(sql), '迁移里不该有裸 CAST(NULL AS CHAR)');
  });
});

describe('D. MSSQL 侧: 有意为之的空迁移, 且不许硬编码 COLLATE 名', () => {
  test('MSSQL 基线里不许出现任何 COLLATE 名 (列必须跟着库级 collation 走)', () => {
    // 只看**可执行内容**: 注释里可以解释 MySQL 侧的做法 (那不是 MSSQL 的 DDL)。
    const sql = stripSqlComments(readFileSync(MSSQL_BASELINE, 'utf8'));
    const names = [...sql.matchAll(/COLLATE\s+([a-z0-9_]+)/gi)].map((m) => m[1].toLowerCase());
    assert.deepEqual(
      names, [],
      `MSSQL 基线里出现了硬编码 collation 名 (${names.join(', ')}) —— 客户库的排序规则各不相同, `
      + '硬编码会直接打断他们的库。MSSQL 的列必须继承库默认'
    );
  });

  test('MSSQL 的 1.0.1 不许出现 COLLATE 名', () => {
    assert.ok(existsSync(MSSQL_MIG_101), `MSSQL 迁移必须存在 (两个方言目录 1:1 平行): ${MSSQL_MIG_101}`);
    const sql = stripSqlComments(readFileSync(MSSQL_MIG_101, 'utf8'));
    const names = [...sql.matchAll(/COLLATE\s+([a-z0-9_]+)/gi)].map((m) => m[1].toLowerCase());
    assert.deepEqual(names, [], `${MSSQL_MIG_101} 里出现了 COLLATE 名 (${names.join(', ')}) —— MSSQL 侧不允许`);
  });

  test('MSSQL 的 1.0.1 是空迁移 (切分出 0 条可执行语句)', () => {
    const stmts = splitSqlStatements(readFileSync(MSSQL_MIG_101, 'utf8'));
    assert.equal(stmts.length, 0, `MSSQL 的 1.0.1 应当是有意为之的空迁移 (0 条语句), 实得 ${stmts.length} 条`);
  });

  test('MSSQL 的空迁移**必须写明理由** (注释里要有"为什么不改")', () => {
    const sql = readFileSync(MSSQL_MIG_101, 'utf8');
    assert.ok(
      /有意为之|不需要|无需/.test(sql),
      'MSSQL 的 1.0.1 必须写清楚"为什么 MSSQL 侧不改" —— 否则后人无法区分"空迁移"与"忘了写"'
    );
  });
});

describe('E. 库默认 collation 的对齐不做成迁移 (MySQL 5.7 的硬限制)', () => {
  test('MySQL 迁移里不许出现"PREPARE 包的 ALTER DATABASE"', () => {
    // 实测 (2026-10-27, MySQL 5.7.44): PREPARE FROM 'SELECT 1' / 'CREATE TABLE ...'
    // / 'DROP TABLE ...' 都 OK, 只有 'ALTER DATABASE ...' 报 ER_UNSUPPORTED_PS 1295
    // ⇒ .sql 迁移拿不到库名就改不了库默认 (动态库名只能靠服务端 PREPARE)。
    const files = [MYSQL_MIG_101, MYSQL_BASELINE];
    for (const file of files) {
      const sql = readFileSync(file, 'utf8');
      const prep = sql.match(/PREPARE\s+\w+\s+FROM\s+@?\w+/gi) ?? [];
      for (const p of prep) {
        const after = sql.slice(sql.indexOf(p) + p.length, sql.indexOf(p) + p.length + 400);
        assert.ok(
          !/ALTER\s+DATABASE/i.test(after),
          `${file} 里有"PREPARE ... ALTER DATABASE" —— MySQL 5.7 不允许 (ER_UNSUPPORTED_PS 1295)`
        );
      }
    }
  });

  test('"库默认不自动改"这个结论必须留在迁移文件里 (别让它无声消失)', () => {
    const sql = readFileSync(MYSQL_MIG_101, 'utf8');
    assert.ok(
      /ALTER DATABASE/.test(sql) && /ER_UNSUPPORTED_PS/.test(sql),
      '1.0.1 的注释里必须写清"库默认 collation 这件事查过了、为什么不自动改" (含 ER_UNSUPPORTED_PS 依据)'
    );
  });
});

describe('F. 交付包 (LinuxServer/db) 必须与源树逐字节一致', () => {
  const pairs = [
    ['mysql/1.0.1-view-collation-align.sql', MYSQL_MIG_101, resolve(LINUX_MYSQL_DIR, '1.0.1-view-collation-align.sql')],
    ['mssql/1.0.1-view-collation-align.sql', MSSQL_MIG_101, resolve(LINUX_MSSQL_DIR, '1.0.1-view-collation-align.sql')],
    ['mysql/1.0.0-baseline.sql', MYSQL_BASELINE, resolve(LINUX_MYSQL_DIR, '1.0.0-baseline.sql')],
    ['mssql/1.0.0-baseline.sql', MSSQL_BASELINE, resolve(LINUX_MSSQL_DIR, '1.0.0-baseline.sql')]
  ];

  for (const [label, src, dst] of pairs) {
    test(`${label} 源树与交付树逐字节一致`, () => {
      assert.ok(existsSync(dst), `交付包缺文件: ${dst}`);
      assert.ok(
        readFileSync(src).equals(readFileSync(dst)),
        `${label} 源树与交付树不一致 —— 交付包会跑旧 SQL (C1 门也会报漂移)`
      );
    });
  }
});
