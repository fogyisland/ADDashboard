#!/usr/bin/env node
/**
 * R161.31 — 把 `1.0.4-active-errors-status-code-int.sql` 迁移应用到**生产表**。
 *
 * 为什么需要这个脚本 (而不是等升级路径自己跑):
 *   本机是**存量部署** (库早就在), 生产表的 status_code 还是 TINYINT。
 *   升级路径的 migrations.js upgrade() 会在**下次启动**时跑这条迁移,
 *   但那条路径需要服务重启 ⇒ 而服务重启是操作员手动做的。
 *   ⇒ 在此之前, active_errors 表仍然是"写不进 1398 ⇒ 恒 0 行"的坏状态,
 *     而批量 upsert 的代码已经上线了 ⇒ 新代码第一次跑就会报错。
 *   ⇒ 这个脚本把迁移**提前**应用到生产表, 让代码与 schema 立刻对齐。
 *
 * ⚠ 幂等: 迁移自带守卫 (列已是 INT 时不动) ⇒ 重复跑安全。
 * ⚠ 不打印任何凭据。
 *
 * 用法: cd Server/center && node scripts/apply-active-errors-migration.mjs
 * 退出码: 0 = 应用成功 (或本来就已经是 INT); 1 = 失败
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = resolve(HERE, '..');
const SERVER_ROOT = resolve(CENTER_ROOT, '..');

const cfgPath = resolve(CENTER_ROOT, 'appsettings.json');
if (!existsSync(cfgPath)) {
  console.error(`找不到 ${cfgPath}`);
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const dialect = cfg?.db?.dialect;
const dbCfg = cfg?.db?.[dialect];
if (!dialect || !dbCfg) {
  console.error('appsettings.json 里没有 db.dialect / db.<dialect> 配置。');
  process.exit(1);
}
const connCfg = { ...dbCfg };   // ★ 凭据只进内存, 绝不打印

const { splitSqlStatements } = await import(pathToFileURL(
  resolve(CENTER_ROOT, 'src', 'init', 'schema-applier.js')).href);

const migPath = resolve(
  SERVER_ROOT, 'db', 'migrations',
  dialect === 'mssql' ? 'mssql' : 'mysql',
  dialect === 'mssql'
    ? '1.0.10-active-errors-status-code-int.sql'
    : '1.0.4-active-errors-status-code-int.sql'
);
if (!existsSync(migPath)) {
  console.error(`找不到迁移文件 ${migPath}`);
  process.exit(1);
}
const migSql = readFileSync(migPath, 'utf8');
const stmts = splitSqlStatements(migSql);

console.log(`\nR161.31 — 应用迁移到生产表 (dialect=${dialect})`);
console.log(`  文件: ${migPath.split(/[/\\]/).slice(-2).join('/')}`);
console.log(`  切成 ${stmts.length} 批语句\n`);

let pool;
try {
  if (dialect === 'mysql') {
    const mysql = require('mysql2/promise');
    pool = mysql.createPool({
      host: connCfg.host,
      port: connCfg.port ?? 3306,
      user: connCfg.user,
      password: connCfg.password,
      database: connCfg.database,
      multipleStatements: false,
      connectionLimit: 1
    });
    // 迁移要在**一条固定连接**上跑: @s 是会话变量, PREPARE/EXECUTE 依赖它。
    const conn = await pool.getConnection();
    try {
      for (const s of stmts) {
        // 无绑定参数 ⇒ COM_QUERY (与生产驱动 src/db/drivers/mysql.js:317 同规则;
        // prepared statement 协议不支持 PREPARE/EXECUTE/DEALLOCATE)。
        await conn.query(s);
      }
      const [cols] = await conn.query(
        `SELECT DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'ad_replication_active_errors'
            AND COLUMN_NAME = 'status_code'`
      );
      console.log(`  \x1b[32m✔\x1b[0m 迁移已应用 — ad_replication_active_errors.status_code 现为 ${cols[0]?.DATA_TYPE}`);
    } finally {
      conn.release();
    }
  } else {
    const mssql = require('mssql');
    const pool2 = await mssql.ConnectionPool({
      server: connCfg.server,
      port: connCfg.port ?? 1433,
      user: connCfg.user,
      password: connCfg.password,
      database: connCfg.database,
      options: { encrypt: false, trustServerCertificate: true },
      pool: { max: 1 }
    }).connect();
    try {
      for (const s of stmts) {
        const request = pool2.request();
        await request.query(s);
      }
      const { recordset } = await pool2.request()
        .query(`SELECT t.name AS type_name FROM sys.columns c
                  JOIN sys.types t ON t.user_type_id = c.user_type_id
                 WHERE c.object_id = OBJECT_ID('[ad_replication_active_errors]')
                   AND c.name = 'status_code'`)
        .then((r) => ({ recordset: r.recordset }));
      console.log(`  \x1b[32m✔\x1b[0m 迁移已应用 — ad_replication_active_errors.status_code 现为 ${recordset[0]?.type_name}`);
    } finally {
      await pool2.close();
    }
  }
  console.log('');
  process.exit(0);
} catch (e) {
  console.error(`  \x1b[31m✖\x1b[0m 迁移失败: ${e.message}`);
  process.exit(1);
} finally {
  if (pool) await pool.end().catch(() => {});
}
