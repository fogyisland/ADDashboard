// Creates a one-shot facade from the given conn params, runs work(db),
// then closes the underlying driver. The drivers are injected so tests
// can stub them.

import { buildSql } from '../db/sql.js';
import { createMysqlDriver } from '../db/drivers/mysql.js';
import { createMssqlDriver } from '../db/drivers/mssql.js';

export async function withOneShotFacade(dialect, connParams, work, drivers = null) {
  const mysqlDriver = drivers?.createMysqlDriver ?? createMysqlDriver;
  const mssqlDriver = drivers?.createMssqlDriver ?? createMssqlDriver;

  const driverCfg = connParams;
  const driver = dialect === 'mysql' ? mysqlDriver(driverCfg) : mssqlDriver(driverCfg);
  const sql = buildSql(dialect);
  const db = {
    dialect,
    sql,
    execute: async (s, p) => driver.execute(s, p),
    query:   async (s, p) => driver.query(s, p),
    transaction: async (w) => driver.transaction(w, sql),
    // R161.6 (2026-10-26) — 与 wizard-facade 保持同款能力面:
    //   session        — 固定连接 (MySQL 专有)
    //   createDatabase / databaseExists / probeServer — server 级连接 (MySQL 专有)
    //   缺哪项就置 null, 调用方按"没有这个能力"处理, 不许静默假装成功。
    session: typeof driver.session === 'function'
      ? async (w) => driver.session(w, sql)
      : null,
    createDatabase: typeof driver.createDatabaseIfMissing === 'function'
      ? async (dbName) => driver.createDatabaseIfMissing(dbName)
      : null,
    databaseExists: typeof driver.databaseExists === 'function'
      ? async (dbName) => driver.databaseExists(dbName)
      : null,
    probeServer: typeof driver.probeServer === 'function'
      ? async () => driver.probeServer()
      : null,
    healthcheck: async () => driver.healthcheck(),
    close: async () => driver.close()
  };

  try {
    return await work(db);
  } finally {
    try {
      await driver.close();
    } catch (closeErr) {
      // 关连接失败不能掩盖 work() 的结果/异常, 但也不许静默 —— 记一条。
      console.error(`[init] 一次性 db 句柄关闭失败: ${closeErr?.message || closeErr}`);
    }
  }
}