// MySQL connection pool (mysql2/promise). Session-level timezone is set
// to '+08:00' (Asia/Shanghai) so DATETIME columns are stored in local time
// matching the AD DC host time zone. The pool lazily creates itself on
// first initPool() and reuses the same pool across the process.

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
    timezone: '+08:00',
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