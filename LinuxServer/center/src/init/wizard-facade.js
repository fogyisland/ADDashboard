// Singleton facade held by the init router across wizard step calls.
// Created on first getWizardFacade, reused on subsequent calls with
// matching params, rebuilt when params change. Closed on finalize / shutdown.

import { createMysqlDriver } from '../db/drivers/mysql.js';
import { createMssqlDriver } from '../db/drivers/mssql.js';
import { buildSql } from '../db/sql.js';

let state = null; // { dialect, connParams, db, driver }

function paramsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function getWizardFacade(dialect, connParams, drivers = null) {
  const mysqlDriver = drivers?.createMysqlDriver ?? createMysqlDriver;
  const mssqlDriver = drivers?.createMssqlDriver ?? createMssqlDriver;

  if (state && state.dialect === dialect && paramsEqual(state.connParams, connParams)) {
    return state.db;
  }
  // Close existing facade (if any) before rebuilding
  if (state) {
    try { await state.driver.close(); } catch { /* ignore */ }
  }
  const driver = dialect === 'mysql' ? mysqlDriver(connParams) : mssqlDriver(connParams);
  const sql = buildSql(dialect);
  const db = {
    dialect,
    sql,
    execute: async (s, p) => driver.execute(s, p),
    query:   async (s, p) => driver.query(s, p),
    transaction: async (w) => driver.transaction(w, sql),
    // R161.6 (2026-10-26) — 固定连接 (MySQL 专有): 基线的 @s/PREPARE 幂等
    //   守卫是连接级状态, 必须钉在一条连接上。MSSQL 驱动没有 session()
    //   ⇒ 这里是 null ⇒ schema-applier 的 applyFile 逐条 execute。
    session: typeof driver.session === 'function'
      ? async (w) => driver.session(w, sql)
      : null,
    // R161.6 — 建库 / 库存在性探测 / 服务器连通性探测 (MySQL 专有)。
    //   目标库还不存在时, 绑定该库的连接握手就 1049 ⇒ 必须在不绑定库的
    //   server 级连接上做。MSSQL 侧没有 ⇒ null (用到时会明确报错)。
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
  state = { dialect, connParams, db, driver };
  return db;
}

export async function closeWizardFacade() {
  if (!state) return;
  try { await state.driver.close(); } catch { /* ignore */ }
  state = null;
}

export function _resetWizardFacadeForTest() { state = null; }