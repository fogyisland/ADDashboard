// R161.12 (2026-10-27) — collation 契约的回归网 (邮件队列 / 邮件历史 500 的真因)。
//
// ★ 现场事故:
//   操作员报「邮件队列和邮件历史两个界面出错」, 页面 500, 服务端报
//   "Illegal mix of collations for operation 'UNION'" (MySQL 1271
//   ER_CANT_AGGREGATE_NCOLLATIONS)。
//   实测复现出来的真因**不在 SQL 里**, 在**连接配置**里:
//     · schema: 75 张表 / 367 个字符串列, 全部 `utf8mb4_unicode_ci`
//     · 连接:   `charset: 'utf8mb4'` ⇒ mysql2 的 Charsets.UTF8MB4 = 45
//               (= utf8mb4_**general_ci**) ⇒ 连接 collation 与 schema 不一致
//     ⇒ UNION 的结果列 collation 由各分支聚合: 分支 1 的 `CAST(NULL AS CHAR)`
//       跟随**连接** collation (general_ci), 分支 2 的列是 unicode_ci,
//       两个隐式 collation 不同 ⇒ 无法聚合 ⇒ 1271。
//   也就是说: `charset: 'utf8mb4'` 这一行**把连接的 collation 从 mysql2 的
//   默认值 (unicode_ci = 224) 主动降级成了 general_ci (= 45)**。
//
// ★ 这个文件要钉住的是"事实", 不是注释:
//   A. mysql2 的 charset 名 → collation 号映射 (直接问驱动自己)
//   B. 驱动配置里的 charset 必须跟 schema 的 collation 一致
//   C. UNION 里的 kind_detail 必须带**显式** COLLATE (纵深防御: 连接被谁
//      改成别的 collation 都不炸这一条)
//   D. collation 类错误必须能被分类, 且**不可降级** (不是 schema 漂移)
//
// 用法: cd Server/center && npm test

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { emailHistory } from '../src/db/sql/email-history.js';
import { emailQueue } from '../src/db/sql/email-queue.js';
import { DB_ERROR_KIND, classifyDbError, isDegradableKind } from '../src/utils/dbError.js';
import { stripJsComments } from './helpers/strip-comments.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, '..', '..');            // Server/
const CENTER_ROOT = resolve(SERVER_ROOT, 'center');
const MYSQL_BASELINE = resolve(SERVER_ROOT, 'db', 'migrations', 'mysql', '1.0.0-baseline.sql');

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// A. mysql2 的 charset 映射 —— 直接问驱动, 不靠注释/记忆。
//
// ★ 为什么必须绝对路径 require:
//   mysql2 的 package.json 有 "exports" 字段, `require('mysql2/lib/...')`
//   会被 ERR_PACKAGE_PATH_NOT_EXPORTED 挡掉 ⇒ 只能先 require.resolve 出
//   主入口, 再按路径拼出 lib/constants/charsets.js。
// ---------------------------------------------------------------------------
const mysql2Entry = require.resolve('mysql2');
const mysql2LibDir = resolve(dirname(mysql2Entry), 'lib');
const mysql2Charsets = require(resolve(mysql2LibDir, 'constants', 'charsets.js'));
const mysql2ConnectionConfig = require(resolve(mysql2LibDir, 'connection_config.js'));
const ConnectionConfig = mysql2ConnectionConfig.ConnectionConfig
  || mysql2ConnectionConfig.default
  || mysql2ConnectionConfig;

/**
 * 抽出源码里所有 `charset: 'xxx'` 的取值。
 *
 * ★ 必须先剥注释: 两个驱动文件里都有一段注释在**解释**这个坑, 注释里
 *   写着 `charset: 'utf8mb4'` (反面教材) ⇒ 不剥注释的话, 正则会把注释
 *   里的反面教材当成真配置, 于是"配置正确"的断言反而被注释判失败
 *   (实测踩过: 一开始就是这里红的)。
 */
function extractCharsetLiterals(source) {
  const out = [];
  const code = stripJsComments(source);
  const re = /charset\s*:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(code)) !== null) out.push(m[1]);
  return out;
}

describe('A. mysql2 的 charset 名 → collation 号 (驱动自己说了算)', () => {
  test("'utf8mb4' 映射的是 general_ci (45), **不是** unicode_ci", () => {
    assert.equal(mysql2Charsets.UTF8MB4, 45);
    assert.equal(ConnectionConfig.getCharsetNumber('utf8mb4'), 45);
  });

  test("'utf8mb4_unicode_ci' 映射的是 224", () => {
    assert.equal(mysql2Charsets.UTF8MB4_UNICODE_CI, 224);
    assert.equal(ConnectionConfig.getCharsetNumber('utf8mb4_unicode_ci'), 224);
  });

  test('mysql2 的默认 charsetNumber 就是 unicode_ci (224) —— 显式写反而是"降级"', () => {
    const cfg = new ConnectionConfig({});
    assert.equal(cfg.charsetNumber, 224);
  });
});

describe('B. 连接的 charset 必须与 schema 的 collation 一致', () => {
  test('MySQL 基线里的所有表都用同一个 collation', () => {
    assert.ok(existsSync(MYSQL_BASELINE), `基线文件必须存在: ${MYSQL_BASELINE}`);
    const sql = readFileSync(MYSQL_BASELINE, 'utf8');
    const collations = new Set(
      [...sql.matchAll(/COLLATE\s*=\s*([a-z0-9_]+)/gi)].map((m) => m[1].toLowerCase())
    );
    assert.ok(collations.size > 0, '基线里必须真的声明了 collation (否则这条断言是哑巴)');
    assert.equal(collations.size, 1, `schema 的 collation 必须唯一, 实际有: ${[...collations].join(', ')}`);
  });

  test('业务连接池 (src/db/drivers/mysql.js) 的 charset 与 schema 一致', () => {
    const file = resolve(CENTER_ROOT, 'src', 'db', 'drivers', 'mysql.js');
    const charsets = extractCharsetLiterals(readFileSync(file, 'utf8'));
    assert.ok(charsets.length > 0, '必须真的配了 charset (否则这条断言是哑巴)');
    // 业务池 + server 池都要在 (具体几处会变, 断言"每一处都对"即可)。
    for (const charset of charsets) {
      assert.equal(
        charset, 'utf8mb4_unicode_ci',
        `${file} 的 charset 必须是 utf8mb4_unicode_ci —— 写 'utf8mb4' 会把连接 collation 降级成 general_ci, 与 schema 不一致`
      );
    }
  });

  test('遗留连接池 (src/db.js) 的 charset 与 schema 一致', () => {
    const file = resolve(CENTER_ROOT, 'src', 'db.js');
    const charsets = extractCharsetLiterals(readFileSync(file, 'utf8'));
    assert.ok(charsets.length > 0, '必须真的配了 charset (否则这条断言是哑巴)');
    for (const charset of charsets) {
      assert.equal(charset, 'utf8mb4_unicode_ci', `${file} 的 charset 必须是 utf8mb4_unicode_ci`);
    }
  });
});

describe('C. UNION 里的 kind_detail 必须带显式 COLLATE (纵深防御)', () => {
  const cases = [
    ['emailHistory.listSent', emailHistory.mysql.listSent(30, 200)],
    ['emailQueue.listQueue', emailQueue.mysql.listQueue(500)]
  ];

  for (const [label, sql] of cases) {
    test(`${label} — 带显式 COLLATE utf8mb4_unicode_ci`, () => {
      assert.ok(
        /COLLATE\s+utf8mb4_unicode_ci/i.test(sql),
        `${label} 的 kind_detail 必须写死 COLLATE utf8mb4_unicode_ci —— 否则它跟随**连接** collation, 连接一改就 1271`
      );
    });

    test(`${label} — 不许再用裸的 CAST(NULL AS CHAR)`, () => {
      assert.ok(
        !/CAST\s*\(\s*NULL\s+AS\s+CHAR\s*\)/i.test(sql),
        `${label} 里还有 CAST(NULL AS CHAR) —— 它继承连接 collation, 与列 collation 不同时 UNION 直接 1271`
      );
    });
  }

  test('MSSQL 分支不受影响 (双方言都要能用)', () => {
    // MSSQL 的列是 nvarchar, 没有 collation 聚合问题 —— 但也不能被
    // "顺手改成 MySQL 写法" 弄坏。
    assert.ok(/CAST\s*\(\s*NULL\s+AS\s+nvarchar\s*\(\s*16\s*\)\s*\)/i.test(emailHistory.mssql.listSent(30, 200)));
    assert.ok(/CAST\s*\(\s*NULL\s+AS\s+nvarchar\s*\(\s*16\s*\)\s*\)/i.test(emailQueue.mssql.listQueue(500)));
  });
});

describe('D. collation 类错误的分类与可降级性', () => {
  test('DB_ERROR_KIND 有 COLLATION 这一类', () => {
    assert.equal(DB_ERROR_KIND.COLLATION, 'collation');
  });

  test('MySQL 1267 / 1271 都被判成 collation', () => {
    assert.equal(classifyDbError({ code: 'ER_CANT_AGGREGATE_2COLLATIONS' }).kind, DB_ERROR_KIND.COLLATION);
    assert.equal(classifyDbError({ code: 'ER_CANT_AGGREGATE_NCOLLATIONS' }).kind, DB_ERROR_KIND.COLLATION);
    assert.equal(classifyDbError({ errno: 1267 }).kind, DB_ERROR_KIND.COLLATION);
    assert.equal(classifyDbError({ errno: 1271 }).kind, DB_ERROR_KIND.COLLATION);
  });

  test('驱动把 code 剥掉时, message 兜底也能认出来 (MySQL 5.7 的 1271 消息没有 collation 明细)', () => {
    const classified = classifyDbError({
      message: "Illegal mix of collations for operation 'UNION'"
    });
    assert.equal(classified.kind, DB_ERROR_KIND.COLLATION);
  });

  test('包在 originalError 里的错误也能剥出来 (db facade 会包一层)', () => {
    const classified = classifyDbError({
      code: 'UNKNOWN',
      originalError: { code: 'ER_CANT_AGGREGATE_NCOLLATIONS', errno: 1271 }
    });
    assert.equal(classified.kind, DB_ERROR_KIND.COLLATION);
  });

  test('MSSQL 2402 (Invalid collation) 同样归到 collation 类', () => {
    assert.equal(classifyDbError({ number: 2402 }).kind, DB_ERROR_KIND.COLLATION);
  });

  test('collation 类错误**不可降级** (它不是 schema 漂移, 是真故障)', () => {
    assert.equal(isDegradableKind(DB_ERROR_KIND.COLLATION), false);
    // 降级的只有"表/列缺失"两种 —— 顺带钉住, 免得有人顺手放宽。
    assert.equal(isDegradableKind(DB_ERROR_KIND.TABLE_MISSING), true);
    assert.equal(isDegradableKind(DB_ERROR_KIND.COLUMN_MISSING), true);
  });

  test('降级提示文案里不该出现 collation 类 (它没有降级文案)', () => {
    // 表/列缺失有中文提示; collation 没有 —— 路由层遇到它必须直接 500。
    assert.equal(classifyDbError({ errno: 1271 }).isSchemaDrift, false);
  });
});
