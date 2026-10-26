// MySQL connection pool (mysql2/promise). The client-side timezone is 'Z'
// (UTC) so DATETIME columns round-trip with the UTC-naive strings written by
// toMysqlDatetime() (which uses getUTC*()). The previous '+08:00' caused
// mysql2 to interpret stored UTC values as CST, returning JS Dates that were
// 8h earlier than the real UTC instant — see round-15 follow-up notes for
// the probe_state "all offline" symptom. The pool lazily creates itself on
// first initPool() and reuses the same pool across the process.
//
// ⚠ R161.10 (2026-10-26) — 澄清本注释里原先的一句**错误说法**:
//   `timezone: 'Z'` 是 mysql2 的**客户端**选项 (把 naive DATETIME 按 UTC 解析),
//   **不是** MySQL 的**会话时区**。MySQL 的 `DEFAULT CURRENT_TIMESTAMP` 是按
//   **会话时区**求值的 (默认 SYSTEM = 服务器 OS 时区) ⇒ 只配 `timezone: 'Z'`
//   的话, "由 DB 默认值写入"的时间戳 (audit_logs.created_at 等) 整体偏一个
//   时区差 —— 这正是 R161.10 的审计时间根因。正解是每条连接上来先
//   `SET time_zone = '+00:00'`, 见 initPool()。
//
// ★ 现状 (R161.10 全树 grep 结论): 本文件**没有任何人 import** —— 生产路径上
//   真正的连接池在 src/db/drivers/mysql.js (业务池 + serverPool), 那边已经钉了
//   会话时区。本文件保留是为了历史 diff 可读; 但只要有人复活它, 时区钉扎必须
//   一起带过去, 否则 DB 默认值写入的时间戳又会偏。

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
  // ★ R161.10 (2026-10-26) — 每条**新建**连接先钉住会话时区 (UTC)。
  //   mysql2/promise 的 PromisePool 用 inheritEvents 把底层池的 'connection'
  //   事件原样转发上来, 携带的是**原生 callback 连接** ⇒ 这里可以挂 'error'
  //   监听并直接发 query。
  //   顺序保证: 'connection' 在连接交给请求方**之前**触发, 且同一条连接上的
  //   命令按 FIFO 执行 ⇒ 这条 SET 必排在该连接的第一个查询之前。
  //   偏移量写法 '+00:00' 而不是 'UTC': 时区表没导入时 SET 'UTC' 会直接失败。
  pool.on('connection', (conn) => {
    // mysql2 不给自己的连接挂 'error' 监听 ⇒ 没有监听器就是 Node 的未捕获
    // 异常, 直接把进程带走。这里接管并记一条 (不静默, 也不崩)。
    conn.on('error', (err) => {
      console.error(`[db:mysql:legacy] 连接级错误: ${err?.message || err}`);
    });
    conn.query("SET time_zone = '+00:00'", (err) => {
      if (err) {
        console.error(
          `[db:mysql:legacy] SET time_zone='+00:00' 失败: ${err?.message || err} —— ` +
          '会话时区未钉到 UTC: DB 默认值写入的时间戳 (created_at 等) 会按服务器本地时区落点。'
        );
      }
    });
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