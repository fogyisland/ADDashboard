// R161.31 调查脚本 — 只读探针: 检查 ad_replication_active_errors.status_code
// 的实际列类型与实际值域。★ 不打印任何凭据。
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

const [cols] = await pool.query(
  "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS " +
  "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_replication_active_errors' " +
  "ORDER BY ORDINAL_POSITION"
);
console.log('ad_replication_active_errors 列定义:');
for (const c of cols) console.log(`  ${c.COLUMN_NAME}  ${c.COLUMN_TYPE}  null=${c.IS_NULLABLE}`);

const [vals] = await pool.query(
  'SELECT status_code, COUNT(*) AS c FROM ad_replication_active_errors GROUP BY status_code ORDER BY status_code'
);
console.log('\n实际值域:');
if (vals.length === 0) console.log('  (空表)');
for (const v of vals) console.log(`  status_code=${v.status_code}  count=${v.c}`);

const [hist] = await pool.query(
  'SELECT MAX(status_code) AS mx, MIN(status_code) AS mn, COUNT(*) AS c FROM ad_replication_status'
);
console.log(`\nad_replication_status.status_code 值域: min=${hist[0]?.mn} max=${hist[0]?.mx} rows=${hist[0]?.c}`);

const [act] = await pool.query(
  'SELECT COUNT(*) AS c FROM ad_replication_active_errors'
);
console.log(`ad_replication_active_errors 行数: ${act[0]?.c}`);

await pool.end();
