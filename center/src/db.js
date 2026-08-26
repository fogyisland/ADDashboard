// MySQL connection pool (mysql2/promise). The session-level timezone is set
// to 'Z' (UTC) so DATETIME columns round-trip with the UTC-naive strings
// written by toMysqlDatetime() (which uses getUTC*()). The previous '+08:00'
// caused mysql2 to interpret stored UTC values as CST, returning JS Dates
// that were 8h earlier than the real UTC instant — see round-15 follow-up
// notes for the probe_state "all offline" symptom. The pool lazily creates
// itself on first initPool() and reuses the same pool across the process.

import mysql from 'mysql2/promise';

let pool = null;

export function initPool(config) {
  if (pool) return pool;
  const c = config.mysql;
  pool = mysql.createPool({
    host: c.host,
    port: c.port ?? 3306,
    user: c.user,
    password: c.password,
    database: c.database,
    waitForConnections: true,
    connectionLimit: c.connectionLimit ?? 10,
    namedPlaceholders: false,
    timezone: 'Z',
    dateStrings: false,
    multipleStatements: false,
    charset: 'utf8mb4'
  });
  return pool;
}

export async function getPool() {
  if (!pool) throw new Error('db pool not initialized');
  return pool;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}