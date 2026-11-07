// R161.31 — `columntype` 探针的真库行为验证。
//
// 目的: 证明 probe.columnType 真的能**分辨**列类型差异 ——
// 这是 R161.17 那个坑的第三种形状 (`column` 探针只查存在性) 的唯一防线。
// 如果这个探针恒返回"存在", 那所有类型变更类迁移都会被登记成 applied
// 而从不执行 ⇒ 缺陷原样留着且零告警。
//
// ★ 只读: 全部是 SELECT / INFORMATION_SCHEMA 查询。
// ★ 不打印任何凭据。
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = resolve(HERE, '..');

const cfg = JSON.parse(readFileSync(resolve(CENTER_ROOT, 'appsettings.json'), 'utf8'));
const dialect = cfg.db.dialect;
const connCfg = { ...cfg.db[dialect] };

const mysql = require('mysql2/promise');
const pool = mysql.createPool({
  host: connCfg.host, port: connCfg.port ?? 3306,
  user: connCfg.user, password: connCfg.password, database: connCfg.database
});

// 与 center/src/db/sql.js 的 mysql 侧 probe.columnType 逐字一致。
const PROBE_COLUMN_TYPE = `SELECT 1 AS ok FROM information_schema.COLUMNS
                            WHERE TABLE_SCHEMA = DATABASE()
                              AND TABLE_NAME = ? AND COLUMN_NAME = ?
                              AND LOWER(DATA_TYPE) = LOWER(?) LIMIT 1`;

// 与 center/src/db/sql.js 的 mysql 侧 probe.column 逐字一致 (对照组)。
const PROBE_COLUMN = `SELECT 1 AS ok FROM information_schema.COLUMNS
                      WHERE TABLE_SCHEMA = DATABASE()
                        AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`;

let pass = 0;
let fail = 0;
function assertTrue(cond, msg) {
  if (cond) { pass += 1; console.log(`  ✔ ${msg}`); }
  else { fail += 1; console.log(`  ✘ ${msg}`); }
}

async function probeType(table, column, type) {
  const [rows] = await pool.query(PROBE_COLUMN_TYPE, [table, column, type]);
  return rows.length > 0;
}

async function probeExists(table, column) {
  const [rows] = await pool.query(PROBE_COLUMN, [table, column]);
  return rows.length > 0;
}

console.log('=== 1. columntype 探针能分辨类型差异 (核心防线) ===');
{
  // ad_replication_active_errors.status_code 当前是 tinyint ⇒ 探 int 应为 false。
  const isInt = await probeType('ad_replication_active_errors', 'status_code', 'int');
  const isTiny = await probeType('ad_replication_active_errors', 'status_code', 'tinyint');
  assertTrue(!isInt,
    '当前是 tinyint ⇒ 探 "int" 返回 false (⇒ 迁移不会被登记成 applied)');
  assertTrue(isTiny,
    '当前是 tinyint ⇒ 探 "tinyint" 返回 true (探针确实在比类型, 不是恒真)');
}

console.log('\n=== 2. 对照: column 探针分辨不了 (这正是必须新增 columntype 的原因) ===');
{
  const exists = await probeExists('ad_replication_active_errors', 'status_code');
  assertTrue(exists,
    'column 探针对同一个列返回 true —— 列确实存在, 但它是 narrow 类型 '
    + '⇒ column 标记会让类型变更类迁移假通过');
}

console.log('\n=== 3. 探针对"列不存在"也返回 false (不能误判成已加宽) ===');
{
  const isInt = await probeType('ad_replication_active_errors', 'no_such_column_xyz', 'int');
  assertTrue(!isInt, '列不存在 ⇒ 探针返回 false');
}

console.log('\n=== 4. 探针大小写不敏感 (MySQL 的 DATA_TYPE 是小写) ===');
{
  const upper = await probeType('ad_replication_active_errors', 'status_code', 'TINYINT');
  const lower = await probeType('ad_replication_active_errors', 'status_code', 'tinyint');
  assertTrue(upper === lower,
    `"TINYINT" 与 "tinyint" 的判定一致 (实际: ${upper} vs ${lower})`);
}

console.log('\n=== 5. 迁移涉及的三张表都能被探针正确判定 ===');
{
  const cases = [
    ['ad_dc_inbound_partners', 'status_code', 'int'],
    ['ad_dc_outbound_partners', 'status_code', 'int'],
    ['ad_replication_probe_history', 'status_code', 'int']
  ];
  for (const [table, column, type] of cases) {
    const isInt = await probeType(table, column, type);
    assertTrue(!isInt,
      `${table}.${column} 当前不是 int ⇒ 探针返回 false (迁移会被执行)`);
  }
}

await pool.end();
console.log(`\n结果: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
