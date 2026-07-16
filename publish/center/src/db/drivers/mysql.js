// mysql2/promise driver wrapper. Exposes the unified Db interface:
//   execute(sql, params) -> { rows, affectedRows, insertId }
//   query(sql, params)   -> { rows }
//   transaction(work)    -> result of work(tx)
//   healthcheck()        -> void (throws on failure)
//   close()
//
// On mysql path, ISO Date strings are auto-converted to naive DATETIME
// via toMysqlDatetime() because the schema uses naive DATETIME columns.

import mysql from 'mysql2/promise';
import { toMysqlDatetime } from '../../utils/datetime.js';

function normalizeParam(p) {
  if (p instanceof Date) return toMysqlDatetime(p);
  if (typeof p === 'string') {
    // Heuristic: ISO 8601 strings (T...Z) get normalized.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(p)) return toMysqlDatetime(p);
    return p;
  }
  return p;
}

function normalizeParams(params) {
  return params.map(normalizeParam);
}

export function createMysqlDriver(config) {
  const pool = mysql.createPool({
    host: config.host,
    port: config.port ?? 3306,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: config.connectionLimit ?? 10,
    namedPlaceholders: false,
    timezone: '+08:00',
    dateStrings: false,
    multipleStatements: false,
    charset: 'utf8mb4'
  });

  async function execute(sqlStr, params = []) {
    // mysql2 prepared-statement protocol (pool.execute) doesn't support:
    //  - comment-only statements
    //  - statements containing BEGIN/END blocks (CREATE PROCEDURE/FUNCTION/TRIGGER bodies)
    //  - statements containing DELIMITER directives (already stripped by splitter)
    // For statements with no bound params, fall back to pool.query() (COM_QUERY
    // protocol) which handles all of these cases. When params are present,
    // pool.execute() handles placeholder binding correctly.
    const useQuery = params.length === 0;
    const [rows, _fields] = useQuery
      ? await pool.query(sqlStr)
      : await pool.execute(sqlStr, normalizeParams(params));
    // rows may be array (SELECT) or OkPacket-shaped object (INSERT/UPDATE).
    if (Array.isArray(rows)) {
      return { rows, affectedRows: 0, insertId: undefined };
    }
    return {
      rows: [],
      affectedRows: rows.affectedRows ?? 0,
      insertId: rows.insertId ?? undefined
    };
  }

  async function query(sqlStr, params = []) {
    const { rows } = await execute(sqlStr, params);
    return { rows };
  }

  async function transaction(work) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const tx = {
        async execute(sqlStr, params = []) {
          const [rows] = await conn.execute(sqlStr, normalizeParams(params));
          if (Array.isArray(rows)) return { rows, affectedRows: 0, insertId: undefined };
          return { rows: [], affectedRows: rows.affectedRows ?? 0, insertId: rows.insertId ?? undefined };
        },
        async query(sqlStr, params = []) {
          const { rows } = await tx.execute(sqlStr, params);
          return { rows };
        }
      };
      const result = await work(tx);
      await conn.commit();
      return result;
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  async function healthcheck() {
    const [rows] = await pool.execute('SELECT 1 AS ok');
    if (!rows || rows[0]?.ok !== 1) throw new Error('mysql healthcheck failed');
  }

  async function close() {
    await pool.end();
  }

  return { dialect: 'mysql', execute, query, transaction, healthcheck, close };
}
