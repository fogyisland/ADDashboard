// R161.31 调查脚本 — 只读探针: 检查三个同族表的 status_code 列类型与实际值域。
//   · ad_dc_inbound_partners
//   · ad_dc_outbound_partners
//   · ad_replication_probe_history
//
// ★ 本脚本**只读**: 不做任何 DDL/DML。
// ★ 不打印任何凭据 —— 凭据只从 appsettings.json 读进内存。
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

const TABLES = [
  'ad_dc_inbound_partners',
  'ad_dc_outbound_partners',
  'ad_replication_probe_history'
];

for (const table of TABLES) {
  console.log(`\n=== ${table} ===`);

  const [cols] = await pool.query(
    'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS ' +
    'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, 'status_code']
  );
  if (cols.length === 0) {
    console.log('  status_code 列不存在');
  } else {
    const c = cols[0];
    console.log(`  列定义: ${c.COLUMN_NAME}  ${c.COLUMN_TYPE}  null=${c.IS_NULLABLE}`);
    const maxOf = { tinyint: 127, smallint: 32767, mediumint: 8388607, int: 2147483647 };
    const base = String(c.COLUMN_TYPE).replace(/\(.*\)$/, '').toLowerCase();
    console.log(`  有符号上限: ${maxOf[base] ?? '(未知类型 ' + base + ')'}`);
  }

  const [count] = await pool.query(
    `SELECT COUNT(*) AS c FROM \`${table}\``
  );
  console.log(`  行数: ${count[0]?.c}`);

  const [vals] = await pool.query(
    `SELECT status_code, COUNT(*) AS c FROM \`${table}\` ` +
    'GROUP BY status_code ORDER BY status_code'
  );
  if (vals.length === 0) {
    console.log('  值域: (空表)');
  } else {
    const codes = vals.map((v) => v.status_code);
    console.log(`  值域: min=${Math.min(...codes)} max=${Math.max(...codes)} (${vals.length} 个不同值)`);
    const over127 = codes.filter((v) => v > 127);
    if (over127.length > 0) {
      console.log(`  ★ 有 ${over127.length} 个值 > 127 (TINYINT 装不下) ⇒ 写入会被拒绝`);
    }
  }
}

// 数据来源表 (dc-partners-refresh 的唯一数据源)
console.log('\n=== 数据来源 ad_replication_status ===');
const [src] = await pool.query(
  'SELECT MIN(status_code) AS mn, MAX(status_code) AS mx, COUNT(*) AS c FROM ad_replication_status'
);
console.log(`  值域: min=${src[0]?.mn} max=${src[0]?.mx} rows=${src[0]?.c}`);
const [over] = await pool.query(
  'SELECT status_code, COUNT(*) AS c FROM ad_replication_status WHERE status_code > 127 ' +
  'GROUP BY status_code ORDER BY status_code'
);
if (over.length === 0) {
  console.log('  (当前没有 > 127 的值 —— 但列类型已经装不下, 只是还没遇到)');
} else {
  console.log('  ★ > 127 的值 (会被复制进 dc_partners 表并被 TINYINT 拒绝):');
  for (const v of over) console.log(`    status_code=${v.status_code} count=${v.c}`);
}

await pool.end();
