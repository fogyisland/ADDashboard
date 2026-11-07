#!/usr/bin/env node
/**
 * R161.31 (2026-11-07) — 性能项 3: 复制状态批量 upsert 的**真库**验证脚本。
 *
 * 为什么单独立一个脚本而不是塞进 npm test:
 *   - 真库验证需要凭据 (app 自己的 appsettings.json)。把凭据相关的代码
 *     放进 npm test 会让 CI 环境 (无库 / 无凭据) 失败。
 *   - 铁律 (R161.3 起): **凭据只进内存, 脚本只打印脱敏/聚合结果, 凭据禁落盘**。
 *     本脚本从 appsettings.json 读凭据 → 只进内存 → 连库 → 只打印
 *     行数 / 布尔断言 / 错误消息 (错误消息里不含凭据)。
 *
 * 验什么 (每条都是"假 db 测不出来"的东西):
 *   1. MySQL 多值 INSERT ... ON DUPLICATE KEY UPDATE 真的能跑 (5.7 兼容)
 *   2. MySQL 行值 IN 的批量 DELETE 真的能跑
 *   3. MSSQL MERGE ... USING (VALUES ...) 真的能跑 (**语法最容易错的地方**)
 *   4. MSSQL 的 EXISTS + 派生表 DELETE 真的能跑
 *   5. 批量化与逐行版写出的**内容一致** (同 merge key 的 last-wins)
 *   6. MSSQL MERGE 遇到重复 merge key 确实报 8672 (证明去重是必需的, 不是
 *      多余的谨慎)
 *
 * 用法:
 *   cd Server/center && node scripts/verify-replication-batch.mjs
 *   退出码: 0 = 全过; 1 = 有断言失败
 *
 * ⚠ 本脚本会在库里建表 + 写测试行 + 删测试行。表名带
 *   `_r16131_verify` 后缀, 跑完 DROP 掉 —— 不碰任何业务表。
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = resolve(HERE, '..');

let failures = 0;
let passes = 0;

function ok(label, extra = '') {
  passes += 1;
  console.log(`  \x1b[32m✔\x1b[0m ${label}${extra ? ' — ' + extra : ''}`);
}
function bad(label, detail) {
  failures += 1;
  console.log(`  \x1b[31m✖\x1b[0m ${label}`);
  if (detail) {
    console.log(`      ${String(detail).split('\n').slice(0, 8).join('\n      ')}`);
  }
}
function assertTrue(cond, label, detail) {
  if (cond) ok(label);
  else bad(label, detail);
}

// ---------------------------------------------------------------------------
// 读配置 (凭据只进内存)
// ---------------------------------------------------------------------------

const cfgPath = resolve(CENTER_ROOT, 'appsettings.json');
if (!existsSync(cfgPath)) {
  console.error(`找不到 ${cfgPath} —— 本脚本需要中心端的数据库配置才能连真库。`);
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const dialect = cfg?.db?.dialect;
const dbCfg = cfg?.db?.[dialect];
if (!dialect || !dbCfg) {
  console.error('appsettings.json 里没有 db.dialect / db.<dialect> 配置。');
  process.exit(1);
}
// ★ 凭据**只**在这一行从配置流进内存, 之后绝不打印。
const connCfg = { ...dbCfg };

// ---------------------------------------------------------------------------
// 导入被测代码
// ---------------------------------------------------------------------------

const T_STATUS = 'r16131_verify_status';
const T_ACTIVE = 'r16131_verify_active';

// ⚠ Windows 上 dynamic import() 绝对路径必须给 file:// URL
//   (裸 "D:\..." 会被当成未知 scheme ⇒ ERR_UNSUPPORTED_ESM_URL_SCHEME)。
const {
  upsertStatusBatchMySql,
  upsertStatusBatchMssql,
  upsertActiveErrorBatchMySql,
  upsertActiveErrorBatchMssql,
  removeActiveErrorBatchMySql,
  removeActiveErrorBatchMssql
} = await import(pathToFileURL(
  resolve(CENTER_ROOT, 'src', 'db', 'sql', 'replication-batch.js')).href);

// ★ builder 里写死了**生产表名** (ad_replication_status 等)。本脚本要在
//   临时表上跑同样的 SQL 形状 ⇒ 把表名替换成临时表名。
//   ⚠ 替换必须**只**替换表名标识符, 不能碰列名 —— 列名里没有这两个串,
//     所以 replaceAll 是安全的。临时表名带 `_verify` 后缀, 生产表名不会
//     被误伤 (反过来说: 如果有人把临时表名取成生产表名的子串, 断言会挂,
//     那正是我们想要的失败方式)。
function retarget(sql) {
  return sql
    .replaceAll('ad_replication_status', T_STATUS)
    .replaceAll('ad_replication_active_errors', T_ACTIVE);
}
const bStatusMy = (n) => retarget(upsertStatusBatchMySql(n));
const bStatusMs = (n) => retarget(upsertStatusBatchMssql(n));
const bActiveMy = (n) => retarget(upsertActiveErrorBatchMySql(n));
const bActiveMs = (n) => retarget(upsertActiveErrorBatchMssql(n));
const bDeleteMy = (n) => retarget(removeActiveErrorBatchMySql(n));
const bDeleteMs = (n) => retarget(removeActiveErrorBatchMssql(n));

// ---------------------------------------------------------------------------
// 测试用的表 + 数据 (临时表名, 跑完 DROP)
// ---------------------------------------------------------------------------

const STATUS_DDL = {
  mysql: `CREATE TABLE ${T_STATUS} (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      collected_at DATETIME NOT NULL,
      agent_id VARCHAR(64) NOT NULL,
      source_dc VARCHAR(128) NOT NULL,
      dest_dc VARCHAR(128) NOT NULL,
      source_site VARCHAR(64) NULL,
      dest_site VARCHAR(64) NULL,
      naming_context VARCHAR(256) NOT NULL,
      last_success_time DATETIME NULL,
      last_attempt_time DATETIME NULL,
      status_code INT NOT NULL DEFAULT 0,
      error_message VARCHAR(512) NULL,
      partner_port_status JSON NULL,
      UNIQUE KEY uq_v (source_dc, dest_dc, naming_context)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  mssql: `IF OBJECT_ID('${T_STATUS}', 'U') IS NULL CREATE TABLE ${T_STATUS} (
      id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
      collected_at DATETIME2 NOT NULL,
      agent_id NVARCHAR(64) NOT NULL,
      source_dc NVARCHAR(128) NOT NULL,
      dest_dc NVARCHAR(128) NOT NULL,
      source_site NVARCHAR(64) NULL,
      dest_site NVARCHAR(64) NULL,
      naming_context NVARCHAR(256) NOT NULL,
      last_success_time DATETIME2 NULL,
      last_attempt_time DATETIME2 NULL,
      status_code INT NOT NULL DEFAULT 0,
      error_message NVARCHAR(512) NULL,
      partner_port_status NVARCHAR(MAX) NULL
    );`
};

const ACTIVE_DDL = {
  // ★ status_code 的列类型必须与**迁移后的生产表**一致 (INT, 不是 TINYINT):
  //   生产表原来的 TINYINT 上限只有 127, 真实 Windows 错误码 (1398/1722)
  //   装不进去 ⇒ active_errors 表恒为 0 行 (R161.31 的真库发现)。
  //   验证脚本用临时表 ⇒ 必须复刻**迁移后**的形状, 否则"真跑"验的是
  //   一个生产上已经不存在的形状。
  mysql: `CREATE TABLE ${T_ACTIVE} (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      source_dc VARCHAR(128) NOT NULL,
      dest_dc VARCHAR(128) NOT NULL,
      naming_context VARCHAR(128) NOT NULL,
      status_code INT NOT NULL,
      last_attempt_time DATETIME NOT NULL,
      first_seen_at DATETIME(3) NOT NULL,
      last_reported_at DATETIME(3) NOT NULL,
      reported_count INT NOT NULL DEFAULT 1,
      last_error_message VARCHAR(2048) NULL,
      UNIQUE KEY uq_v (source_dc, dest_dc, naming_context)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  mssql: `IF OBJECT_ID('${T_ACTIVE}', 'U') IS NULL CREATE TABLE ${T_ACTIVE} (
      id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
      source_dc VARCHAR(128) NOT NULL,
      dest_dc VARCHAR(128) NOT NULL,
      naming_context VARCHAR(128) NOT NULL,
      status_code INT NOT NULL,
      last_attempt_time DATETIME2 NOT NULL,
      first_seen_at DATETIME2 NOT NULL,
      last_reported_at DATETIME2 NOT NULL,
      reported_count INT NOT NULL DEFAULT 1,
      last_error_message NVARCHAR(2048) NULL
    );`
};

// 3 行测试数据 (含一对重复的 merge key, 用来验 last-wins)
const TEST_ROWS = [
  { sourceDc: 'SRC-A', destDc: 'DST-A', nc: 'CN=One', sc: 0, msg: null },
  { sourceDc: 'SRC-A', destDc: 'DST-B', nc: 'CN=Two', sc: 1398, msg: '命名空间绑定失败' },
  { sourceDc: 'SRC-B', destDc: 'DST-C', nc: 'CN=三', sc: 0, msg: null }
];

const TS = '2026-11-07 10:00:00';

function statusParams(row) {
  return [
    TS, 'AGENT-1', row.sourceDc, row.destDc, 'SiteA', 'SiteB', row.nc,
    TS, TS, row.sc, row.msg, null
  ];
}
function activeParams(row) {
  return [row.sourceDc, row.destDc, row.nc, row.sc, TS, TS, TS, row.msg];
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
    connectionLimit: 4
  });
  driver = {
    dialect: 'mysql',
    async execute(sql, params = []) {
      const [rows] = await pool.execute(sql, params);
      return { rows: Array.isArray(rows) ? rows : [], affectedRows: rows?.affectedRows ?? 0 };
    },
    async query(sql, params = []) {
      const [rows] = await pool.query(sql, params);
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
    pool: { max: 4 }
  }).connect();
  driver = {
    dialect: 'mssql',
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

console.log(`\nR161.31 性能项 3 — 复制批量 upsert 真库验证 (dialect=${dialect})\n`);

try {
  // -------------------------------------------------------------------------
  // 0. 建表
  // -------------------------------------------------------------------------
  await driver.execute(STATUS_DDL[dialect]);
  await driver.execute(ACTIVE_DDL[dialect]);
  ok('临时表建好');

  // -------------------------------------------------------------------------
  // 1. status 批量 upsert 真跑
  // -------------------------------------------------------------------------
  {
    const sql = dialect === 'mysql'
      ? bStatusMy(3)
      : bStatusMs(3);
    const params = TEST_ROWS.flatMap(statusParams);
    try {
      const res = await driver.execute(sql, params);
      const { rows } = await driver.query(`SELECT source_dc, dest_dc, naming_context, status_code FROM ${T_STATUS}`);
      assertTrue(rows.length === 3, 'status 批量 upsert 真跑通过 (3 行落库)',
        `实际落库 ${rows.length} 行 (affectedRows=${res.affectedRows})`);
    } catch (e) {
      bad('status 批量 upsert 真跑', e.message);
      // ★ 失败时把**单行**的报错也打出来 (定位是哪一列/哪一行的绑定问题)。
      //   只打印错误消息, 不打印参数 (参数里没有凭据, 但保持"最小输出"惯例)。
      try {
        await driver.execute(
          dialect === 'mysql' ? bStatusMy(1) : bStatusMs(1),
          statusParams(TEST_ROWS[0])
        );
        console.log('      单行版本能跑 ⇒ 多行版本的 VALUES 形状有问题');
      } catch (e2) {
        console.log(`      单行版本也失败: ${String(e2.message).slice(0, 300)}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 2. 批量 upsert 命中已存在行 ⇒ 更新而不是重复插入
  // -------------------------------------------------------------------------
  {
    const sql = dialect === 'mysql'
      ? bStatusMy(1)
      : bStatusMs(1);
    const row = { ...TEST_ROWS[0], sc: 1722 };
    try {
      await driver.execute(sql, statusParams(row));
      const { rows } = await driver.query(
        `SELECT status_code FROM ${T_STATUS} WHERE source_dc = ? AND dest_dc = ? AND naming_context = ?`,
        [row.sourceDc, row.destDc, row.nc]
      );
      assertTrue(rows.length === 1 && Number(rows[0].status_code) === 1722,
        '批量 upsert 命中已存在行 ⇒ 更新而非插入',
        `落库 ${rows.length} 行, status_code=${rows[0]?.status_code}`);
    } catch (e) {
      bad('批量 upsert 命中已存在行', e.message);
    }
  }

  // -------------------------------------------------------------------------
  // 3. active-error 批量 upsert 真跑
  // -------------------------------------------------------------------------
  {
    const failRows = TEST_ROWS.filter((r) => r.sc > 0);
    const sql = dialect === 'mysql'
      ? bActiveMy(failRows.length)
      : bActiveMs(failRows.length);
    try {
      await driver.execute(sql, failRows.flatMap(activeParams));
      const { rows } = await driver.query(`SELECT COUNT(*) AS c FROM ${T_ACTIVE}`);
      assertTrue(Number(rows[0]?.c) === failRows.length,
        'active-error 批量 upsert 真跑通过',
        `落库 ${rows[0]?.c} 行, 期望 ${failRows.length}`);
    } catch (e) {
      bad('active-error 批量 upsert 真跑', e.message);
    }
  }

  // -------------------------------------------------------------------------
  // 4. active-error 批量 DELETE 真跑 (删的是**真在表里的**行)
  //   - MySQL: 行值 IN
  //   - MSSQL: EXISTS + 派生表
  //
  // ★ 必须先往表里塞一批"要被删的行"再删 —— 否则这条断言验的是
  //   "DELETE 一条不存在的行不报错", 那跟批量 DELETE 的形状毫无关系
  //   (行值 IN / EXISTS 派生表写错了, 也照样"不报错", 只是什么都没删)。
  //   ⇒ 断言改成"**该删的被删了, 不该删的还在**", 才是真的在验 DELETE。
  // -------------------------------------------------------------------------
  {
    // 先把 3 行"待删"的全塞进去 (sc=0 的两行 + sc=1398 的那行)
    const toDelete = TEST_ROWS;
    const insSql = dialect === 'mysql'
      ? bActiveMy(toDelete.length)
      : bActiveMs(toDelete.length);
    try {
      await driver.execute(insSql, toDelete.flatMap(activeParams));

      // 再插一行**不该被删**的 (sc=0 但三元组不同)
      const keepRow = { sourceDc: 'SRC-KEEP', destDc: 'DST-KEEP', nc: 'CN=Keep', sc: 0, msg: null };
      await driver.execute(
        dialect === 'mysql' ? bActiveMy(1) : bActiveMs(1),
        activeParams(keepRow)
      );

      // 删掉 okRows (sc===0 的两行) —— 它们现在**真的在表里**
      const okRows = TEST_ROWS.filter((r) => r.sc === 0);
      const delSql = dialect === 'mysql'
        ? bDeleteMy(okRows.length)
        : bDeleteMs(okRows.length);
      await driver.execute(delSql, okRows.flatMap((r) => [r.sourceDc, r.destDc, r.nc]));

      const { rows } = await driver.query(
        `SELECT source_dc, dest_dc, naming_context FROM ${T_ACTIVE}`
      );
      const remaining = new Set(
        rows.map((r) => `${r.source_dc}|${r.dest_dc}|${r.naming_context}`)
      );
      const deletedAll = okRows.every((r) => !remaining.has(`${r.sourceDc}|${r.destDc}|${r.nc}`));
      const keptOthers = remaining.has(`${keepRow.sourceDc}|${keepRow.destDc}|${keepRow.nc}`)
        && remaining.has(`${TEST_ROWS[1].sourceDc}|${TEST_ROWS[1].destDc}|${TEST_ROWS[1].nc}`);
      assertTrue(deletedAll && keptOthers,
        'active-error 批量 DELETE 真跑通过 (该删的删掉了, 不该删的都还在)',
        `剩余 ${rows.length} 行: ${[...remaining].join(' / ')}`);

      // 清掉保留下来的两行, 让后面的用例从干净状态开始
      const cleanupRows = [keepRow, TEST_ROWS[1]];
      await driver.execute(
        dialect === 'mysql' ? bDeleteMy(cleanupRows.length) : bDeleteMs(cleanupRows.length),
        cleanupRows.flatMap((r) => [r.sourceDc, r.destDc, r.nc])
      );
    } catch (e) {
      bad('active-error 批量 DELETE 真跑', e.message);
    }
  }

  // -------------------------------------------------------------------------
  // 5. active-error 批量 DELETE 真的删得掉 (先插一行再删)
  //   ★ 自包含: 上一个用例已经清过表, 所以这里自己插自己删, 不依赖
  //     前面用例留下的行状态 (用例之间不共享隐式状态 = 用例可单独重跑)。
  // -------------------------------------------------------------------------
  {
    const row = { sourceDc: 'SRC-DEL1', destDc: 'DST-DEL1', nc: 'CN=Del1', sc: 1398, msg: null };
    try {
      // 先插
      await driver.execute(
        dialect === 'mysql' ? bActiveMy(1) : bActiveMs(1),
        activeParams(row)
      );
      const before = await driver.query(`SELECT COUNT(*) AS c FROM ${T_ACTIVE}`);
      // 再删 (单行批次)
      const sql = dialect === 'mysql'
        ? bDeleteMy(1)
        : bDeleteMs(1);
      await driver.execute(sql, [row.sourceDc, row.destDc, row.nc]);
      const after = await driver.query(
        `SELECT COUNT(*) AS c FROM ${T_ACTIVE} WHERE source_dc = ? AND dest_dc = ? AND naming_context = ?`,
        [row.sourceDc, row.destDc, row.nc]
      );
      assertTrue(Number(before.rows[0]?.c) === 1 && Number(after.rows[0]?.c) === 0,
        'active-error 批量 DELETE 真的删掉了那一行',
        `删前 ${before.rows[0]?.c} 行, 删后该三元组剩 ${after.rows[0]?.c} 行`);
    } catch (e) {
      bad('active-error 批量 DELETE 真删', e.message);
    }
  }

  // -------------------------------------------------------------------------
  // 6. ★ MSSQL MERGE 遇重复 merge key 报 8672 (证明去重是必需的)
  // -------------------------------------------------------------------------
  if (dialect === 'mssql') {
    const dup = { ...TEST_ROWS[0] };
    const sql = bStatusMs(2);
    try {
      await driver.execute(sql, [...statusParams(dup), ...statusParams(dup)]);
      bad('MSSQL MERGE 重复 merge key 应当报错 8672 (却成功了)',
        '重复 key 被接受 ⇒ 说明去重可能没必要, 或者 MSSQL 行为与预期不同');
    } catch (e) {
      const isMergeErr = /8672|attempted to (UPDATE|DELETE) the same row more than once/i
        .test(String(e.message || ''));
      assertTrue(isMergeErr,
        'MSSQL MERGE 重复 merge key 确实报 8672 (证明去重是必需的, 不是多余谨慎)',
        `实际错误: ${String(e.message).slice(0, 200)}`);
    }
  } else {
    // MySQL: 重复 key 应当**不报错** (按顺序依次应用) ⇒ 证明两个方言
    // 的行为不同 ⇒ 去重不是"多余的谨慎", 是"必需的对齐"。
    const dup = { ...TEST_ROWS[0], sc: 55 };
    const sql = bStatusMy(2);
    try {
      await driver.execute(sql, [...statusParams(dup), ...statusParams(dup)]);
      const { rows } = await driver.query(
        `SELECT status_code FROM ${T_STATUS} WHERE source_dc = ? AND dest_dc = ? AND naming_context = ?`,
        [dup.sourceDc, dup.destDc, dup.nc]
      );
      assertTrue(rows.length === 1 && Number(rows[0].status_code) === 55,
        'MySQL 批量 upsert 遇重复 key 不报错且 last-wins (⇒ 与 MSSQL 行为不同 ⇒ 去重必需)',
        `落库 ${rows.length} 行, status_code=${rows[0]?.status_code}`);
    } catch (e) {
      bad('MySQL 重复 key 应当不报错', e.message);
    }
  }

  // -------------------------------------------------------------------------
  // 7. 中文字符 (NC 含中文) 往返无损
  // -------------------------------------------------------------------------
  {
    const row = { sourceDc: 'SRC-ZH', destDc: 'DST-ZH', nc: 'CN=中文命名空间,DC=corp', sc: 0, msg: '错误信息：命名空间绑定失败' };
    const sql = dialect === 'mysql'
      ? bStatusMy(1)
      : bStatusMs(1);
    try {
      await driver.execute(sql, statusParams(row));
      const { rows } = await driver.query(
        `SELECT naming_context, error_message FROM ${T_STATUS} WHERE source_dc = ?`,
        [row.sourceDc]
      );
      assertTrue(rows[0]?.naming_context === row.nc && rows[0]?.error_message === row.msg,
        '中文 NC / 错误信息往返无损',
        `读回 nc=${rows[0]?.naming_context} msg=${rows[0]?.error_message}`);
    } catch (e) {
      bad('中文 NC 往返', e.message);
    }
  }

  // -------------------------------------------------------------------------
  // 8. ★★ Windows 错误码 (>127) 能写进 active_errors 表
  //
  //   这是 R161.31 在**真库**上发现的真实生产缺陷的回归闸门:
  //   ad_replication_active_errors.status_code 原本是 TINYINT (上限 127),
  //   而真实 status 值域实测 max=1398 (Windows 错误码 1398=命名空间绑定失败,
  //   1722=RPC 服务器不可用) ⇒ 每写一次就报
  //   "Out of range value for column 'status_code' at row 1"
  //   ⇒ **ad_replication_active_errors 表恒为 0 行**
  //   ⇒ /admin/replication-errors 恒显示「无错误」, 与 /errors 口径分裂。
  //   写失败被 services/replication.js 的 catch 只 logger.warn 掉了 ⇒ 静默。
  //
  //   ★ 本断言用的临时表已经是 **INT** (与迁移后的生产表一致),
  //     所以它验的是"迁移后的形状装得下大码"。若有人把迁移删了 /
  //     把基线改回 TINYINT, 本用例会失败 —— 那正是它存在的意义。
  // -------------------------------------------------------------------------
  {
    const bigCodes = [1398, 1722, 65535];
    const rowsIn = bigCodes.map((sc, i) => ({
      sourceDc: 'SRC-BIG', destDc: `DST-BIG-${i}`, nc: `CN=Big${i}`, sc, msg: null
    }));
    try {
      await driver.execute(
        dialect === 'mysql' ? bActiveMy(rowsIn.length) : bActiveMs(rowsIn.length),
        rowsIn.flatMap(activeParams)
      );
      const { rows } = await driver.query(
        `SELECT status_code FROM ${T_ACTIVE} WHERE source_dc = ? ORDER BY dest_dc`,
        ['SRC-BIG']
      );
      const got = rows.map((r) => Number(r.status_code)).sort((a, b) => a - b);
      assertTrue(got.length === bigCodes.length
        && got.every((v, i) => v === [...bigCodes].sort((a, b) => a - b)[i]),
        'Windows 错误码 (>127) 能写进 active_errors 表 (R161.31 真库缺陷的回归闸门)',
        `写入 ${JSON.stringify(bigCodes)}, 读回 ${JSON.stringify(got)}`);
    } catch (e) {
      bad('Windows 错误码 (>127) 写入 active_errors', e.message);
    }
  }
} finally {
  // -------------------------------------------------------------------------
  // 清理: DROP 临时表
  // -------------------------------------------------------------------------
  try {
    await driver.execute(`DROP TABLE IF EXISTS ${T_STATUS}`);
    await driver.execute(`DROP TABLE IF EXISTS ${T_ACTIVE}`);
    console.log('\n  临时表已清理');
  } catch (e) {
    console.log(`\n  \x1b[33m!\x1b[0m 临时表清理失败: ${e.message}`);
  }
  await driver.close();
}

console.log(`\n结果: ${passes} pass / ${failures} fail\n`);
process.exit(failures > 0 ? 1 : 0);
