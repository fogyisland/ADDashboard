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
    transaction: async (w) => driver.transaction(w),
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