// mysql2/promise driver wrapper. Exposes the unified Db interface:
//   execute(sql, params) -> { rows, affectedRows, insertId }
//   query(sql, params)   -> { rows }
//   transaction(work)    -> result of work(tx)
//   session(work, sql)   -> result of work(session)  [R161.6, MySQL only]
//   healthcheck()        -> void (throws on failure)
//   close()
//
// ★ R161.6 (2026-10-26) — 三个新增能力, 全部服务于"初始化向导建库 + 基线
//   DDL 幂等守卫":
//
//   ① server 级连接 (不绑定任何库): serverPool
//      池是按 `database: config.database` 建的, 目标库还不存在时**握手阶段**
//      就 ER_BAD_DB_ERROR (1049) —— 根本执行不到 CREATE DATABASE 这一句。
//      同理, 向导第 1 步的"测试连接"如果绑定目标库, 全新安装时必然 1049
//      失败 ⇒ 操作员被永久卡在第 1 步, 走不到第 3 步的"创建数据库"阶段。
//      那一步该问的是"服务器连得上吗", 不是"能不能选中那个还没建的库"。
//
//   ② session(work) —— **固定连接**执行器。
//      基线里的幂等守卫是:
//        SET @s = (SELECT IF(<INFORMATION_SCHEMA 探针>, '<DDL>', 'SELECT 1'));
//        PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
//      @s 是**会话变量**, stmt 是**会话级预备语句** —— 只有这几条落在**同一条
//      连接**上时, PREPARE 才拿得到刚刚 SET 的 @s。
//      pool.query() 每次调用都从池里借一条连接再还回去, 借到的**不保证**是
//      上一条 ⇒ @s 可能是 NULL (PREPARE FROM NULL → ER_PARSE_ERROR 1064),
//      或者是上一轮的陈旧值 (⇒ 重复执行上一轮的 ALTER → ER_DUP_FIELDNAME 1060)。
//      今天"能跑"只是因为串行 await + 池的 FIFO 恰好把同一条连接还回来;
//      一旦有并发 (健康检查 / agent 请求) 抢走连接就会炸。
//      ⇒ 基线 apply 必须跑在一条固定连接上。
//      ★ MSSQL 侧**没有** session(): 它的基线守卫是自包含的
//        `IF NOT EXISTS (...) BEGIN ... END` 单批语句, 不依赖会话状态。
//        init/schema-applier.js 的 applyFile 检测到 db.session 缺失时逐条
//        execute —— 与从前**逐字一致**。
//
//   ③ createDatabaseIfMissing(dbName) / databaseExists(dbName) / probeServer()
//      —— server 级连接上的建库与探测。
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
import { assertValidDatabaseName } from '../../utils/dbName.js';

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
    // S9 (2026-09-30) — connection limit raised 10 → 25 + queueLimit.
    // The 8-hour centre log showed 1537 'operation timed out for an
    // unknown reason' errors, 99.5% on inbound/outbound-partners + file-push
    // claim — agent heartbeat is ~12 req/s × 3 round-trips ≈ 36 req/s against
    // a 10-conn pool. Back then the pool was created with an unlimited queue
    // depth, so a single slow audit_logs INSERT held all 10 connections,
    // every new request piled into the queue, and the resulting setInterval
    // closures in services/email.js + routes/agent.js accumulated as
    // forever-pending Promise callbacks. After ~60min the V8 heap hits 4 GB
    // and Mark-Compact fails → FATAL OOM. The fix is *not* a longer timeout
    // (that just delays the failure); it's (a) more connections so the
    // legitimate heartbeat fan-out fits, and (b) a finite queueLimit so we
    // reject fast rather than build up closures waiting on a stuck pool.
    //
    // R161.6 (2026-10-26) 事实修正: 原注释里写的 "(b) a hard acquireTimeout
    // so overflow surfaces as a 503" **两处都不成立** ——
    //   ① mysql2 压根没有 acquireTimeout 这个选项 (见下方注释的详细说明),
    //      它从来没生效过;
    //   ② 队列打满时 mysql2 抛的 'Queue limit reached.' 由 app.js 的
    //      errorMiddleware 统一变成 **500** (`{ error: 'internal' }`),
    //      不是 503。
    // ⇒ 真实生效的快速失败机制只有 queueLimit (下文有源码出处)。
    //    顺带说明: 500 对 agent 侧是可重试的, 不会造成 3xx/4xx 那种"不重试
    //    就丢数据"的后果, 所以 S9 的运维目标 (别堆闭包、别 OOM) 依然达成。
    connectionLimit: config.connectionLimit ?? 25,
    queueLimit: config.queueLimit ?? 100,
    // R161.6 (2026-10-26) — **删除** `acquireTimeout: 5_000`。
    //
    // 旧注释声称 "mysql2 forwards acquireTimeout to tarn.js" —— **这是错的**。
    // mysql2 的有效选项表 (node_modules/mysql2/lib/connection_config.js 的
    // validOptions) 里根本没有 acquireTimeout; 它既不属于 Connection 也不
    // 属于 Pool。传进去的唯一效果是 lib/connection_config.js:93 打一条
    //   "Ignoring invalid configuration option passed to Connection:
    //    acquireTimeout. ... in future versions of MySQL2, an error will be
    //    thrown"
    // ⇒ ① 每次建池都往 stdout 吐一条噪音警告; ② **未来升级 mysql2 时会直接
    // 抛错, 建池失败 ⇒ 整个中心端起不来** (实测 mysql2 3.23.4 已在警告)。
    //
    // S9 真正想要的那个"快速失败"机制其实来自 queueLimit:
    //   node_modules/mysql2/lib/base/pool.js:113-116
    //     if (this.config.queueLimit &&
    //         this._connectionQueue.length >= this.config.queueLimit)
    //       return cb(new Error('Queue limit reached.'));
    // ⇒ 队列满 (100) 时 getConnection **立刻** reject, 不再无限排队。
    // 这正是 S9 注释里 (c) "有限 queueLimit 以便快速拒绝而不是堆积闭包"。
    // (a) 由 connectionLimit=25 满足。
    //
    // mysql2 **没有**池级获取超时这个概念 (tarn.js / mysql-pool 才有)。
    // 唯一的超时是 Connection 级的 connectTimeout (默认 10 s, 管握手),
    // 这里保持默认。若将来确实需要"等池超过 N 秒就放弃", 只能在
    // pool.getConnection() 外面自己包一层 —— 但那会让超时后仍在途的连接
    // 泄漏, 属于独立的一轮改动, 不在本次范围内。
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

  // -------------------------------------------------------------------------
  // R161.6 — server 级连接池 (不绑定任何库)。
  //
  // 懒创建: 只有真的需要"连到 server 而不是某个库"时才建 —— 常规运行路径
  // (业务查询 / 基线 apply) 永远用不到它, 不该白占一条连接池。
  // 它的存在只为三件事:
  //   1. CREATE DATABASE (目标库还不存在时, 绑定该库的连接握手就 1049)
  //   2. INFORMATION_SCHEMA.SCHEMATA 查库是否存在
  //   3. SELECT 1 服务器连通性探测 (向导第 1 步)
  // -------------------------------------------------------------------------
  let serverPool = null;

  async function getServerPool() {
    if (serverPool) return serverPool;
    serverPool = mysql.createPool({
      host: config.host,
      port: config.port ?? 3306,
      user: config.user,
      password: config.password,
      // ★ 故意**不传 database** ⇒ 握手时不发 USE, 连到 server 本身。
      waitForConnections: true,
      // 这个池只服务建库/探测这类一次性操作, 2 条连接足够。
      connectionLimit: 2,
      queueLimit: 10,
      // R161.6 — 同上, 不传 acquireTimeout (mysql2 无此选项)。
      namedPlaceholders: false,
      timezone: 'Z',
      dateStrings: false,
      multipleStatements: false,
      charset: 'utf8mb4'
    });
    return serverPool;
  }

  /** 服务器连通性探测 (不绑定库)。向导第 1 步用。 */
  async function probeServer() {
    const p = await getServerPool();
    const [rows] = await p.query('SELECT 1 AS ok');
    if (!Array.isArray(rows) || rows[0]?.ok !== 1) {
      throw new Error('mysql server probe failed: SELECT 1 did not return ok=1');
    }
    return true;
  }

  /** 目标库是否已存在 (server 级连接, 库不存在也能问)。 */
  async function databaseExists(dbName) {
    const name = assertValidDatabaseName(dbName);
    const p = await getServerPool();
    const [rows] = await p.query(
      'SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?',
      [name]
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  /** 建库 (幂等)。必须在 server 级连接上做。 */
  async function createDatabaseIfMissing(dbName) {
    const name = assertValidDatabaseName(dbName);
    const p = await getServerPool();
    await p.query(
      `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    return name;
  }

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

  // -------------------------------------------------------------------------
  // R161.6 — 固定连接 (session) 执行器。
  //
  // 与 transaction() 的区别: **不开事务**, 只是把整段工作钉在一条连接上。
  // 用途: 基线 DDL 的幂等守卫依赖会话变量 @s + 会话级预备语句 stmt,
  //       这两样都是**连接级状态** —— 换连接就丢。
  //
  // 与 transaction() 一样: 借一条连接 → 干活 → finally 归还。
  // work 抛错时连接照常归还 (finally), 错误原样上抛。
  // -------------------------------------------------------------------------
  async function session(work, sql) {
    const conn = await pool.getConnection();
    try {
      const sess = {
        // sql 镜像父级 db 的 SQL 注册表 —— 与 transaction() 的 tx 同款,
        // 让 helper (如 writeAudit) 能在 session 里直接取 `sess.sql.audit.write`。
        sql,
        async execute(sqlStr, params = []) {
          // 与 pool 级 execute() 同款协议选择: 无参语句走 COM_QUERY
          // (pool.query), 有参语句走预处理协议 (pool.execute)。
          // 基线里的 PREPARE/EXECUTE/DEALLOCATE 属于后者, 但它们自己
          // 不带 `?` 占位符 ⇒ 走 conn.query() 才能发出去。
          const useQuery = params.length === 0;
          const [rows] = useQuery
            ? await conn.query(sqlStr)
            : await conn.execute(sqlStr, normalizeParams(params));
          if (Array.isArray(rows)) return { rows, affectedRows: 0, insertId: undefined };
          return { rows: [], affectedRows: rows.affectedRows ?? 0, insertId: rows.insertId ?? undefined };
        },
        async query(sqlStr, params = []) {
          const { rows } = await sess.execute(sqlStr, params);
          return { rows };
        }
      };
      return await work(sess);
    } finally {
      conn.release();
    }
  }

  async function healthcheck() {
    const [rows] = await pool.execute('SELECT 1 AS ok');
    if (!rows || rows[0]?.ok !== 1) throw new Error('mysql healthcheck failed');
  }

  async function close() {
    // serverPool 是懒建的 —— 没建过就别 end (end 一个没开的池会抛)。
    if (serverPool) {
      const p = serverPool;
      serverPool = null;
      await p.end();
    }
    await pool.end();
  }

  return {
    dialect: 'mysql',
    execute,
    query,
    transaction,
    session,
    probeServer,
    databaseExists,
    createDatabaseIfMissing,
    healthcheck,
    close
  };
}
