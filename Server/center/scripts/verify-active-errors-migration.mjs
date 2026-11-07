#!/usr/bin/env node
/**
 * R161.31 — 迁移 `1.0.4-active-errors-status-code-int.sql` 的**真库**验证。
 *
 * 验什么:
 *   1. 迁移文件能被生产的 splitSqlStatements() 正确切分 (切错了 ⇒ 跑不了)。
 *   2. 守卫逻辑正确: 列是 TINYINT 时**会**改; 已经是 INT 时**不会**再改
 *      (幂等 —— 重复跑不报错, 也不重复改表)。
 *   3. 列改完之后, 1398 / 1722 / 65535 这些 Windows 错误码**真的写得进去**
 *      (这正是迁移的目的)。
 *
 * ⚠ 不碰生产表 —— 在**临时表**上跑同一份 SQL (表名替换)。
 *   生产表的真实迁移由升级路径的 migrations.js upgrade() 执行。
 *
 * 用法: cd Server/center && node scripts/verify-active-errors-migration.mjs
 * 退出码: 0 = 全过; 1 = 有断言失败
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = resolve(HERE, '..');
const SERVER_ROOT = resolve(CENTER_ROOT, '..');

let failures = 0;
let passes = 0;
function ok(label, extra = '') {
  passes += 1;
  console.log(`  \x1b[32m✔\x1b[0m ${label}${extra ? ' — ' + extra : ''}`);
}
function bad(label, detail) {
  failures += 1;
  console.log(`  \x1b[31m✖\x1b[0m ${label}`);
  if (detail) console.log(`      ${String(detail).split('\n').slice(0, 8).join('\n      ')}`);
}
function assertTrue(cond, label, detail) {
  if (cond) ok(label); else bad(label, detail);
}

// ---------------------------------------------------------------------------
// 配置 (凭据只进内存)
// ---------------------------------------------------------------------------

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
const connCfg = { ...dbCfg };

// 生产代码的切分器 —— 必须用它, 不能自己切 (切错了跑的是另一批语句)。
const { splitSqlStatements } = await import(pathToFileURL(
  resolve(CENTER_ROOT, 'src', 'init', 'schema-applier.js')).href);

// ---------------------------------------------------------------------------
// 迁移文件
// ---------------------------------------------------------------------------

const MIG_REL = dialect === 'mssql'
  ? ['db', 'migrations', 'mssql', '1.0.10-active-errors-status-code-int.sql']
  : ['db', 'migrations', 'mysql', '1.0.4-active-errors-status-code-int.sql'];
const migPath = resolve(SERVER_ROOT, ...MIG_REL);
if (!existsSync(migPath)) {
  console.error(`找不到迁移文件 ${migPath}`);
  process.exit(1);
}
const migSql = readFileSync(migPath, 'utf8');

const T_TMP = 'r16131_verify_mig_active';

// 把生产表名换成临时表名 (临时表名不是生产表名的子串, 不会误伤)。
function retarget(sql) {
  return sql.replaceAll('ad_replication_active_errors', T_TMP);
}

// ---------------------------------------------------------------------------
// 连接
// ---------------------------------------------------------------------------

let driver;
if (dialect === 'mysql') {
  const mysql = require('mysql2/promise');
  const pool = mysql.createPool({
    host: connCfg.host,
    port: connCfg.port ?? 3306,
    user: connCfg.user,
    password: connCfg.password,
    database: connCfg.database,
    multipleStatements: false,
    connectionLimit: 2
  });
  driver = {
    async execute(sql, params = []) {
      // ★ 必须跟生产驱动 (src/db/drivers/mysql.js:317) **同一个分派规则**:
      //   无绑定参数 ⇒ 走 pool.query() (COM_QUERY 协议);
      //   有绑定参数 ⇒ 走 pool.execute() (prepared statement 协议)。
      //   原因: MySQL 的 prepared statement 协议**不支持** PREPARE/EXECUTE/
      //   DEALLOCATE 这几条命令 ("This command is not supported in the
      //   prepared statement protocol yet") —— 而本迁移文件的核心正是
      //   `SET @s = ...; PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;`
      //   (MySQL 5.7 没有 ALTER TABLE ... IF EXISTS 之类的幂等语法)。
      //   ⇒ 用裸 pool.execute() 跑会假失败; 生产驱动不会。
      if (params.length === 0) {
        const [rows] = await pool.query(sql);
        return { rows: Array.isArray(rows) ? rows : [], affectedRows: rows?.affectedRows ?? 0 };
      }
      const [rows] = await pool.execute(sql, params);
      return { rows: Array.isArray(rows) ? rows : [], affectedRows: rows?.affectedRows ?? 0 };
    },
    async query(sql, params = []) {
      const [rows] = params.length === 0
        ? await pool.query(sql)
        : await pool.query(sql, params);
      return { rows: Array.isArray(rows) ? rows : [] };
    },
    async close() { await pool.end(); }
  };
} else {
  const mssql = require('mssql');
  const pool = await mssql.ConnectionPool({
    server: connCfg.server,
    port: connCfg.port ?? 1433,
    user: connCfg.user,
    password: connCfg.password,
    database: connCfg.database,
    options: { encrypt: false, trustServerCertificate: true },
    pool: { max: 2 }
  }).connect();
  driver = {
    async execute(sql, params = []) {
      const request = pool.request();
      for (let i = 0; i < params.length; i++) {
        const v = params[i];
        if (v === null || v === undefined) request.input(`p${i + 1}`, null);
        else if (typeof v === 'number') request.input(`p${i + 1}`, mssql.sql.Int, v);
        else request.input(`p${i + 1}`, mssql.sql.NVarChar, String(v));
      }
      const result = await request.query(sql.replace(/\?/g, () => `@p${request.parameters.length + 1}`));
      return { rows: result.recordset ?? [], affectedRows: result.rowsAffected?.[0] ?? 0 };
    },
    async query(sql, params = []) {
      return { rows: (await driver.execute(sql, params)).rows };
    },
    async close() { await pool.close(); }
  };
}

// 临时表 DDL —— 刻意用**旧**的 TINYINT 形状 (MySQL 真 TINYINT / MSSQL 的
// TINYINT 别名 = SMALLINT), 模拟一个"还没跑迁移的存量库"。
const TMP_DDL = {
  mysql: `CREATE TABLE ${T_TMP} (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      source_dc VARCHAR(128) NOT NULL,
      dest_dc VARCHAR(128) NOT NULL,
      naming_context VARCHAR(128) NOT NULL,
      status_code TINYINT NOT NULL,
      last_attempt_time DATETIME NOT NULL,
      first_seen_at DATETIME(3) NOT NULL,
      last_reported_at DATETIME(3) NOT NULL,
      reported_count INT NOT NULL DEFAULT 1,
      last_error_message VARCHAR(2048) NULL,
      UNIQUE KEY uq_v (source_dc, dest_dc, naming_context)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  mssql: `IF OBJECT_ID('${T_TMP}', 'U') IS NULL CREATE TABLE ${T_TMP} (
      id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
      source_dc VARCHAR(128) NOT NULL,
      dest_dc VARCHAR(128) NOT NULL,
      naming_context VARCHAR(128) NOT NULL,
      status_code TINYINT NOT NULL,
      last_attempt_time DATETIME2 NOT NULL,
      first_seen_at DATETIME2 NOT NULL,
      last_reported_at DATETIME2 NOT NULL,
      reported_count INT NOT NULL DEFAULT 1,
      last_error_message NVARCHAR(2048) NULL
    );`
};

console.log(`\nR161.31 — 迁移 1.0.4/1.0.10 (active_errors.status_code → INT) 真库验证 (dialect=${dialect})\n`);

const stmts = splitSqlStatements(retarget(migSql));
console.log(`  迁移文件切成 ${stmts.length} 批语句\n`);

try {
  // -------------------------------------------------------------------------
  // 0. 建"迁移前"的临时表
  // -------------------------------------------------------------------------
  await driver.execute(`DROP TABLE IF EXISTS ${T_TMP}`);
  await driver.execute(TMP_DDL[dialect]);

  const typeOf = async () => {
    if (dialect === 'mysql') {
      const { rows } = await driver.query(
        `SELECT DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'status_code'`,
        [T_TMP]
      );
      return rows[0]?.DATA_TYPE ?? null;
    }
    const { rows } = await driver.query(
      `SELECT t.name AS type_name FROM sys.columns c
         JOIN sys.types t ON t.user_type_id = c.user_type_id
        WHERE c.object_id = OBJECT_ID(?) AND c.name = 'status_code'`,
      [T_TMP]
    );
    return rows[0]?.type_name ?? null;
  };

  const before = await typeOf();
  assertTrue(before !== null && before !== 'int',
    '迁移前: status_code 是窄类型 (模拟存量库)',
    `迁移前列类型 = ${before}`);

  // -------------------------------------------------------------------------
  // 1. 跑迁移
  // -------------------------------------------------------------------------
  try {
    for (const s of stmts) await driver.execute(s, []);
    ok('迁移文件全部语句执行成功');
  } catch (e) {
    bad('迁移文件执行', e.message);
  }

  // -------------------------------------------------------------------------
  // 2. 列类型已加宽
  // -------------------------------------------------------------------------
  const after = await typeOf();
  assertTrue(after === 'int', '迁移后: status_code 已是 INT',
    `迁移后列类型 = ${after}`);

  // -------------------------------------------------------------------------
  // 3. 幂等: 再跑一遍, 不报错, 类型不变
  // -------------------------------------------------------------------------
  try {
    for (const s of stmts) await driver.execute(s, []);
    const after2 = await typeOf();
    assertTrue(after2 === 'int', '迁移可重复执行 (幂等) — 第二次跑不报错且类型不变',
      `第二次跑完列类型 = ${after2}`);
  } catch (e) {
    bad('迁移幂等 (第二次执行)', e.message);
  }

  // -------------------------------------------------------------------------
  // 4. 大码真写得进去 (迁移的目的)
  // -------------------------------------------------------------------------
  try {
    for (const sc of [1398, 1722, 65535]) {
      await driver.execute(
        `INSERT INTO ${T_TMP}
           (source_dc, dest_dc, naming_context, status_code, last_attempt_time,
            first_seen_at, last_reported_at, reported_count, last_error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL)`,
        ['SRC-BIG', `DST-${sc}`, `CN=${sc}`, sc, '2026-11-07 10:00:00',
          '2026-11-07 10:00:00', '2026-11-07 10:00:00']
      );
    }
    const { rows } = await driver.query(
      `SELECT status_code FROM ${T_TMP} WHERE source_dc = ? ORDER BY status_code`, ['SRC-BIG']
    );
    const got = rows.map((r) => Number(r.status_code));
    assertTrue(got.length === 3 && got[0] === 1398 && got[1] === 1722 && got[2] === 65535,
      '迁移后 Windows 错误码 (1398/1722/65535) 真写得进去',
      `读回 ${JSON.stringify(got)}`);
  } catch (e) {
    bad('大码写入', e.message);
  }

  // -------------------------------------------------------------------------
  // 5. 反证: 迁移**前**的形状确实装不下 (证明这条迁移不是多余的)
  // -------------------------------------------------------------------------
  if (dialect === 'mysql') {
    await driver.execute(`DROP TABLE IF EXISTS ${T_TMP}`);
    await driver.execute(TMP_DDL[dialect]);
    try {
      await driver.execute(
        `INSERT INTO ${T_TMP}
           (source_dc, dest_dc, naming_context, status_code, last_attempt_time,
            first_seen_at, last_reported_at, reported_count, last_error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL)`,
        ['SRC-BIG', 'DST-1398', 'CN=1398', 1398, '2026-11-07 10:00:00',
          '2026-11-07 10:00:00', '2026-11-07 10:00:00']
      );
      bad('反证失败: TINYINT 竟然装下了 1398 ⇒ 这条迁移是多余的',
        'TINYINT 应该报 Out of range');
    } catch (e) {
      assertTrue(/out of range/i.test(String(e.message || '')),
        '反证: 迁移前的 TINYINT 形状**装不下** 1398 (⇒ 这条迁移是必需的)',
        `实际错误: ${String(e.message).slice(0, 160)}`);
    }
  }
} finally {
  try {
    await driver.execute(`DROP TABLE IF EXISTS ${T_TMP}`);
    console.log('\n  临时表已清理');
  } catch (e) {
    console.log(`\n  \x1b[33m!\x1b[0m 临时表清理失败: ${e.message}`);
  }
  await driver.close();
}

console.log(`\n结果: ${passes} pass / ${failures} fail\n`);
process.exit(failures > 0 ? 1 : 0);
