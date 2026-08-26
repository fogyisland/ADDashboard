// mysql2/promise driver wrapper. Exposes the unified Db interface:
//   execute(sql, params) -> { rows, affectedRows, insertId }
//   query(sql, params)   -> { rows }
//   transaction(work)    -> result of work(tx)
//   healthcheck()        -> void (throws on failure)
//   close()
//
// Strings pass through unchanged — the driver does not know whether the
// target column is TEXT (e.g. system_config.config_value, which stores
// ISO timestamps verbatim for I1/I3/I9 dual-key rotations) or DATETIME
// (which would reject ISO format). Callers that need MySQL naive format
// for a DATETIME column MUST pre-format explicitly via toMysqlDatetime()
// (see services/replication.js, routes/agent.js, services/discovery.js,
// routes/lockout.js for the convention). Date instances are still converted
// for backward compatibility with code that passes `new Date()` directly.

import mysql from 'mysql2/promise';
import { toMysqlDatetime } from '../../utils/datetime.js';

function normalizeParam(p) {
  if (p instanceof Date) return toMysqlDatetime(p);
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
    // 2026-08-26 round-15 follow-up: pin mysql2 to UTC for DATETIME round-trip.
    // Writes go through toMysqlDatetime() which uses getUTC*() — storage is
    // UTC-naive strings. The previous '+08:00' caused mysql2 to interpret the
    // stored UTC value as CST, returning JS Dates that were 8h earlier than
    // the real UTC instant. The UI's "Date.now() - parsed" then computed gaps
    // of 8h+ and the operator's probe panel showed all 3 center ports as
    // "offline" (gap > 60s). 'Z' matches the storage convention and the
    // round-15 SQL UTC_TIMESTAMP() comparison.
    timezone: 'Z',
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

  async function transaction(work, sql) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // tx.sql mirrors the parent db's sql registry so helpers like
      // writeAudit can resolve `tx.sql.audit.write` without threading the
      // SQL string from the caller.
      const tx = {
        sql,
        async execute(sqlStr, params = []) {
          // Same text-vs-binary heuristic as pool.execute (line 45-66): when
          // there are no bound params, fall back to COM_QUERY so server-side
          // commands that the prepared-statement protocol rejects — e.g. CREATE
          // PROCEDURE/FUNCTION/TRIGGER bodies that themselves issue
          // PREPARE/EXECUTE/DEALLOCATE PREPARE — go through. Without this,
          // migration 015's `CREATE PROCEDURE ... BEGIN ... END` block
          // aborts with `This command is not supported in the prepared
          // statement protocol yet` even though the top-level execute() would
          // have used query() and succeeded.
          const useQuery = params.length === 0;
          const [rows] = useQuery
            ? await conn.query(sqlStr)
            : await conn.execute(sqlStr, normalizeParams(params));
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
