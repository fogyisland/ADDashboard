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
    transaction: async (w) => driver.transaction(w),
    healthcheck: async () => driver.healthcheck(),
    close: async () => driver.close()
  };

  try {
    return await work(db);
  } finally {
    try { await driver.close(); } catch { /* swallow close errors */ }
  }
}