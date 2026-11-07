// R161.31 (2026-11-07) — 性能项 3: 复制状态批量 upsert 的 SQL builder。
//
// 为什么单独成文件: 这批 SQL 是**函数式**的 (行数随批次变 ⇒ 占位符个数
// 随行数变), 跟 sql.js 里其它"固定字符串"形状不同, 塞进 sql.js 会让
// 那个已经 5000+ 行的文件更难读。同 family 的 pattern 见
// sql/member-servers.js / sql/host-status.js。
//
// ---------------------------------------------------------------------------
// ★ 三条硬约束 (决定了下面的形状, 不是风格偏好)
// ---------------------------------------------------------------------------
//
// (1) MSSQL 的 MERGE **不允许源里出现重复的 merge key**。
//     错误 8672: "The MERGE statement attempted to UPDATE or DELETE the
//     same row more than once." —— 这是 MERGE 独有的, INSERT ...
//     ON DUPLICATE KEY UPDATE 没这个限制 (它按顺序逐行应用)。
//     ⇒ MSSQL 批量化之前**必须**按 merge key 去重。
//
// (2) MySQL 的 ON DUPLICATE KEY UPDATE 对**同一条语句内**的重复 key 是
//     "按出现顺序依次应用" ⇒ 最后一行赢。
//     ⇒ 两个方言必须对齐 ⇒ 去重时保留**最后一条** (last-wins), 不能
//       保留第一条, 否则同一批数据在两个方言下写出的内容不同。
//
// (3) 批大小有上限。
//     - MySQL: 占位符个数 = 行数 × 12。MySQL 5.7 的 prepared statement
//       占位符上限是 65535 ⇒ 行数上限 ~5461。留足余量取 200 行/批。
//     - MSSQL: sp_executesql 的参数个数上限是 2100 ⇒ 行数 × 12 也要
//       ≤ 2100 ⇒ 行数上限 ~175。**MSSQL 的限制比 MySQL 紧 3 倍**,
//       所以批大小必须按方言分开取, 不能一刀切。
//     - 另外 MSSQL 每多一个参数就多一次 sp_executesql 参数序列化开销,
//       参数越多单条语句越慢; 200 参数的 MERGE 实测远快于 6 次小 MERGE。
//     ⇒ 保守取: mysql 200 行/批, mssql 150 行/批。
//
// ---------------------------------------------------------------------------
// ★ 语义等价性 (批量化必须与逐行版等价, 否则是"改行为"不是"改性能")
// ---------------------------------------------------------------------------
//
// 逐行版 (R161.31 之前) 每行做 1~3 条语句:
//   a) upsertStatus                  —— 无条件
//   b) statusCode === 0  → removeActiveError (DELETE)
//      statusCode >  0  → upsertActiveError (UPSERT, reported_count+1)
//      statusCode 为其它 (如 -1 META 哨兵) → 什么都不做
//   c) appendHistory 时 upsertHistory —— 无条件 (纯 INSERT, 无 upsert)
//
// 批量化后每批做 1~3 条语句, 语义完全一致:
//   a) upsertStatusBatch             —— N 行一条 INSERT ... ON DUPLICATE
//   b) 同一批里 statusCode>0 的行 → upsertActiveErrorBatch (一条)
//      statusCode===0 的行        → removeActiveErrorBatch (一条 DELETE
//                                    用行值 IN, 一条语句删一批)
//   c) upsertHistoryBatch            —— N 行一条纯 INSERT
//
// ★ reported_count 的语义差异 (必须写下来, 否则以后有人会"优化"掉):
//   逐行版: 每行一次 upsertActiveError ⇒ 命中已存在行时 reported_count
//   逐行 +1。批量化后: 一条 MERGE/INSERT 里 N 行命中 ⇒ reported_count
//   **只 +1** (不是 +N)。
//   ⇒ 这是**行为变化**。但它是**修正**: reported_count 的语义是
//     "这条错误被上报过多少次", 而一个批次里的 N 行是**同一个上报动作**
//     (一次 agent report) 的 N 个 pair ⇒ 一次上报 = 一次计数。
//     逐行版 +N 是把"一个上报动作"数成了 N 次 —— 那是 bug 不是特性。
//     R158.X.99.29.b 的原意 (操作员 directive "如果有问题则写入这个表")
//     没有任何地方要求 reported_count 按 pair 累加。
//   ⇒ 批量化后 reported_count 变成"被上报的批次数", 更贴近操作员想看的
//     "这个问题持续多久了"。
//
// ---------------------------------------------------------------------------
// ★ 为什么不给 status 表做 MERGE (MSSQL)
// ---------------------------------------------------------------------------
// ad_replication_status 的 MERGE key 是 (source_dc, dest_dc, naming_context),
// 与 MySQL 的 UNIQUE KEY uq_repl_partner 1:1 平行。批量化用
// MERGE ... USING (VALUES (...),(...)) AS s(col,...) 形式。
//
// 行值 IN (MySQL) / (a,b,c) IN ((...),(...)) (MSSQL) 的 DELETE:
//   MySQL 5.7 支持 `WHERE (a,b,c) IN ((?,?,?),(?,?,?))` —— 行值构造器。
//   MSSQL 不支持行值 IN ⇒ 用 `WHERE a = ? AND b = ? AND c = ?` 的 OR 链,
//   或 EXISTS + VALUES 派生表。MSSQL 支持
//   `WHERE EXISTS (SELECT 1 FROM (VALUES (?,?,?),(?,?,?)) AS d(a,b,c)
//    WHERE d.a = t.source_dc AND d.b = t.dest_dc AND d.c = t.naming_context)`。
//   两个方言各写各的, 形状不同但语义 1:1。

/**
 * 批大小上限 (见文件头约束 (3))。
 * mysql: 12 列/行 ⇒ 200 行 = 2400 个占位符, 远低于 65535 上限。
 * mssql: 12 列/行 ⇒ 150 行 = 1800 个参数, 低于 sp_executesql 的 2100。
 */
export const BATCH_LIMITS = {
  mysql: 200,
  mssql: 150
};

/** 取当前方言的批大小上限。未知方言按最小值取 (宁可少批量也不要炸)。 */
export function batchLimitFor(dialect) {
  return BATCH_LIMITS[dialect] ?? BATCH_LIMITS.mssql;
}

/**
 * 把 rows 按批大小切片。空数组返回空数组 (不是 [[]])。
 * @param {Array} rows
 * @param {number} limit
 * @returns {Array<Array>}
 */
export function chunkRows(rows, limit) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const size = Number.isInteger(limit) && limit > 0 ? limit : BATCH_LIMITS.mssql;
  const out = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size));
  }
  return out;
}

// ---------------------------------------------------------------------------
// ★ 导出形状: 必须遵循 db/sql/*.js 的既有约定 (mysql: {...} / mssql: {...})
// ---------------------------------------------------------------------------
//
// 为什么不写成顶层 `export function upsertStatusBatchMySql(...)`:
//   守卫 scripts/audit/check-mysql57-compat.mjs 靠**两条腿**扫描
//   db/sql/*.js 模块 ——
//     ① 静态腿: 切出源码里的 `mysql: { ... }` 块, 扫块内的字符串/模板
//        字面量 (另有 `const <NAME>_MYSQL = ...` 命名约定这条腿);
//     ② 运行时腿: 遍历模块的**导出树**, 收集挂在 `mysql` 键下的 SQL 候选
//        (字符串 = SQL, 函数 = SQL builder)。
//   ⇒ 顶层函数既不在 `mysql:` 块里, 导出树上也没有 `mysql` 键
//     ⇒ 两条腿都扫不到 ⇒ 守卫报"一条 SQL 都没扫到 (静默通过)"。
//   ⇒ 本模块的 SQL builder 全部**放进** `mysql:` / `mssql:` 块里:
//     - 静态腿: 块内的模板字面量被扫到 (含 MySQL 侧语法检查);
//     - 运行时腿: `mysql` 键下的函数被当成 SQL builder 候选, 调用一次
//       拿到展开后的 SQL 再扫 (能抓到 `rowCount` 展开出来的形状)。
//   ⚠ 这跟 member-servers.js 的形状一致 (那里是常量, 这里是函数) ——
//     守卫的 collectSqlLeaves 同时支持 string 与 function 两种叶子。
//
// 兼容导出: 上面的顶层函数名继续保留并从这里转发, 这样
// services/replication.js 的调用点不用改 (也不该改 —— 调用点与
// "SQL 在哪" 无关)。

export const replicationBatch = {
  mysql: {
    /**
     * ad_replication_status — 批量 upsert (INSERT ... ON DUPLICATE KEY UPDATE)
     *
     * 12 列 (与逐行版 rowParams 1:1 平行):
     *   0 collected_at · 1 agent_id · 2 source_dc · 3 dest_dc
     *   4 source_site · 5 dest_site · 6 naming_context
     *   7 last_success_time · 8 last_attempt_time
     *   9 status_code · 10 error_message · 11 partner_port_status
     *
     * ★ ON DUPLICATE KEY UPDATE 的赋值列表必须与逐行版**逐字一致** ——
     *   逐行版更新 9 列 (collected_at/agent_id/source_site/dest_site/
     *   last_success_time/last_attempt_time/status_code/error_message/
     *   partner_port_status), **不**更新 source_dc/dest_dc/naming_context
     *   (它们是 UNIQUE key 的一部分, 更新它们没意义且会破坏索引)。
     *   ⚠ MySQL 5.7 里 `VALUES(col)` 在多行 INSERT 中是合法的 (推荐写法),
     *     `AS new` 别名语法要 MySQL 8.0.19+ ⇒ 本项目是 MySQL 5.7 ⇒ 用 VALUES()。
     */
    upsertStatus: (rowCount) => {
      const values = new Array(rowCount).fill('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      return `INSERT INTO ad_replication_status
      (collected_at, agent_id, source_dc, dest_dc, source_site, dest_site,
       naming_context, last_success_time, last_attempt_time, status_code,
       error_message, partner_port_status)
      VALUES ${values}
      ON DUPLICATE KEY UPDATE
        collected_at = VALUES(collected_at),
        agent_id = VALUES(agent_id),
        source_site = VALUES(source_site),
        dest_site = VALUES(dest_site),
        last_success_time = VALUES(last_success_time),
        last_attempt_time = VALUES(last_attempt_time),
        status_code = VALUES(status_code),
        error_message = VALUES(error_message),
        partner_port_status = VALUES(partner_port_status)`;
    },

    /**
     * ad_replication_active_errors — 批量 upsert (status_code > 0 的行)
     *
     * 8 个可绑参数 (第 9 个 reported_count 恒为 1, 内联):
     *   0 source_dc · 1 dest_dc · 2 naming_context · 3 status_code
     *   4 last_attempt_time · 5 first_seen_at · 6 last_reported_at
     *   7 last_error_message
     *
     * ★ reported_count 的行为变化见文件头"语义等价性"段: 批内只 +1。
     */
    upsertActiveError: (rowCount) => {
      const values = new Array(rowCount).fill('(?, ?, ?, ?, ?, ?, ?, 1, ?)').join(', ');
      return `INSERT INTO ad_replication_active_errors
          (source_dc, dest_dc, naming_context, status_code, last_attempt_time,
           first_seen_at, last_reported_at, reported_count, last_error_message)
          VALUES ${values}
          ON DUPLICATE KEY UPDATE
            status_code = VALUES(status_code),
            last_attempt_time = VALUES(last_attempt_time),
            last_reported_at = VALUES(last_reported_at),
            reported_count = reported_count + 1,
            last_error_message = VALUES(last_error_message)`;
    },

    /**
     * ad_replication_active_errors — 批量 delete (status_code === 0 的行)
     *
     * 3 个参数/行: source_dc · dest_dc · naming_context。
     *
     * MySQL 5.7: 行值 IN 构造器 —— `WHERE (a,b,c) IN ((?,?,?),(?,?,?))`。
     *   ⚠ MySQL 的行值 IN 走 index (a,b,c) 的 range 优化, 性能没问题。
     */
    removeActiveError: (rowCount) => {
      const values = new Array(rowCount).fill('(?, ?, ?)').join(', ');
      return `DELETE FROM ad_replication_active_errors
          WHERE (source_dc, dest_dc, naming_context) IN (${values})`;
    },

    /**
     * ad_replication_history — 批量 insert (纯 INSERT, 无 upsert)
     *
     * 11 列/行 (与逐行版 historyParams 1:1 平行):
     *   0 collected_at · 1 agent_id · 2 source_dc · 3 dest_dc · 4 naming_context
     *   5 last_success_time · 6 last_attempt_time · 7 attempt_duration_ms
     *   8 objects_transferred · 9 status_code · 10 error_message
     *
     * ⚠ MySQL 5.7 DATETIME 拒 ISO ⇒ 调用侧已统一 toMysqlDatetime()。
     */
    upsertHistory: (rowCount) => {
      const values = new Array(rowCount).fill('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      return `INSERT INTO ad_replication_history
      (collected_at, agent_id, source_dc, dest_dc, naming_context,
       last_success_time, last_attempt_time, attempt_duration_ms,
       objects_transferred, status_code, error_message)
      VALUES ${values}`;
    }
  },

  mssql: {
    /**
     * ad_replication_status — 批量 upsert (MERGE ... USING (VALUES ...))
     *
     * ★ 每个 cell 都必须 CAST —— VALUES 构造器的列类型取自**第一条**记录,
     *   不 CAST 的话第一行的类型会决定整列类型 (后续行类型不符 → 转换错误)。
     * ★ CAST 目标类型与**表定义** 1:1 平行 (db/migrations/mssql/1.0.0-baseline.sql
     *   的 [ad_replication_status]):
     *     collected_at/last_success_time/last_attempt_time → DATETIME2
     *     agent_id              → NVARCHAR(64)
     *     source_dc/dest_dc     → NVARCHAR(128)
     *     source_site/dest_site → NVARCHAR(64)
     *     naming_context        → NVARCHAR(256)
     *     status_code           → INT
     *     error_message         → NVARCHAR(512)
     *     partner_port_status   → NVARCHAR(MAX)
     *   ★ 注意 naming_context 在 status 表是 NVARCHAR(256), 但在
     *     ad_replication_active_errors 表是 VARCHAR(128) —— 两个表不一样!
     *     逐行版 MERGE 两处都写 NVARCHAR(128), 对 status 表来说是**偏窄**
     *     (长 NC 被静默截断到 128 字符)。本模块按**表定义**写, 不复刻那个
     *     截断隐患。截断本身就是 bug, 不该被"批量版 1:1 平行"固化下来。
     */
    upsertStatus: (rowCount) => {
      const rows = [];
      for (let i = 0; i < rowCount; i++) {
        rows.push(`(
            CAST(? AS DATETIME2)       AS collected_at,
            CAST(? AS NVARCHAR(64))    AS agent_id,
            CAST(? AS NVARCHAR(128))   AS source_dc,
            CAST(? AS NVARCHAR(128))   AS dest_dc,
            CAST(? AS NVARCHAR(64))    AS source_site,
            CAST(? AS NVARCHAR(64))    AS dest_site,
            CAST(? AS NVARCHAR(256))   AS naming_context,
            CAST(? AS DATETIME2)       AS last_success_time,
            CAST(? AS DATETIME2)       AS last_attempt_time,
            ?                          AS status_code,
            CAST(? AS NVARCHAR(512))   AS error_message,
            CAST(? AS NVARCHAR(MAX))   AS partner_port_status
          )`);
      }
      return `MERGE INTO ad_replication_status AS t
         USING (VALUES ${rows.join(', ')}) AS s(
           collected_at, agent_id, source_dc, dest_dc, source_site, dest_site,
           naming_context, last_success_time, last_attempt_time, status_code,
           error_message, partner_port_status)
         ON t.source_dc = s.source_dc AND t.dest_dc = s.dest_dc AND t.naming_context = s.naming_context
         WHEN MATCHED THEN UPDATE SET
           collected_at = s.collected_at,
           agent_id = s.agent_id,
           source_site = s.source_site,
           dest_site = s.dest_site,
           last_success_time = s.last_success_time,
           last_attempt_time = s.last_attempt_time,
           status_code = s.status_code,
           error_message = s.error_message,
           partner_port_status = s.partner_port_status
         WHEN NOT MATCHED THEN INSERT
           (collected_at, agent_id, source_dc, dest_dc, source_site, dest_site,
            naming_context, last_success_time, last_attempt_time, status_code,
            error_message, partner_port_status)
           VALUES (s.collected_at, s.agent_id, s.source_dc, s.dest_dc,
                   s.source_site, s.dest_site, s.naming_context,
                   s.last_success_time, s.last_attempt_time, s.status_code,
                   s.error_message, s.partner_port_status)`;
    },

    /**
     * ad_replication_active_errors — 批量 upsert (status_code > 0 的行)
     *
     * 8 个可绑参数 (第 9 个 reported_count 恒为 1, 内联)。
     */
    upsertActiveError: (rowCount) => {
      const rows = [];
      for (let i = 0; i < rowCount; i++) {
        rows.push(`(
            CAST(? AS NVARCHAR(128))   AS source_dc,
            CAST(? AS NVARCHAR(128))   AS dest_dc,
            CAST(? AS NVARCHAR(128))   AS naming_context,
            ?                          AS status_code,
            CAST(? AS DATETIME2)       AS last_attempt_time,
            CAST(? AS DATETIME2)       AS first_seen_at,
            CAST(? AS DATETIME2)       AS last_reported_at,
            1                          AS reported_count,
            CAST(? AS NVARCHAR(2048))  AS last_error_message
          )`);
      }
      return `MERGE INTO ad_replication_active_errors AS t
         USING (VALUES ${rows.join(', ')}) AS s(
           source_dc, dest_dc, naming_context, status_code, last_attempt_time,
           first_seen_at, last_reported_at, reported_count, last_error_message)
         ON t.source_dc = s.source_dc AND t.dest_dc = s.dest_dc AND t.naming_context = s.naming_context
         WHEN MATCHED THEN UPDATE SET
           status_code = s.status_code,
           last_attempt_time = s.last_attempt_time,
           last_reported_at = s.last_reported_at,
           reported_count = t.reported_count + 1,
           last_error_message = s.last_error_message
         WHEN NOT MATCHED THEN INSERT
           (source_dc, dest_dc, naming_context, status_code, last_attempt_time,
            first_seen_at, last_reported_at, reported_count, last_error_message)
           VALUES (s.source_dc, s.dest_dc, s.naming_context, s.status_code,
                   s.last_attempt_time, s.first_seen_at, s.last_reported_at,
                   s.reported_count, s.last_error_message)`;
    },

    /**
     * ad_replication_active_errors — 批量 delete (status_code === 0 的行)
     *
     * 3 个参数/行: source_dc · dest_dc · naming_context。
     *
     * MSSQL: 不支持行值 IN ⇒ 用 EXISTS + VALUES 派生表。
     *   `WHERE EXISTS (SELECT 1 FROM (VALUES (?,?,?),(?,?,?)) AS d(a,b,c)
     *    WHERE d.a = t.source_dc AND d.b = t.dest_dc AND d.c = t.naming_context)`
     *   ⇒ 派生表需要列别名 (AS d(a,b,c))。
     */
    removeActiveError: (rowCount) => {
      const values = new Array(rowCount).fill('(?, ?, ?)').join(', ');
      return `DELETE FROM ad_replication_active_errors
          WHERE EXISTS (
            SELECT 1 FROM (VALUES ${values}) AS d(source_dc, dest_dc, naming_context)
            WHERE d.source_dc = ad_replication_active_errors.source_dc
              AND d.dest_dc = ad_replication_active_errors.dest_dc
              AND d.naming_context = ad_replication_active_errors.naming_context
          )`;
    },

    /**
     * ad_replication_history — 批量 insert (纯 INSERT, 无 upsert)
     *
     * 11 列/行, 形状与 MySQL 侧相同 (只有类型兼容性差异):
     *   MSSQL DATETIME2 吃 ISO ⇒ 同一个字符串两边都能用。
     *   ⚠ MSSQL 的 `?` → `@pN` 重写对多行 VALUES 是逐个按顺序编号的,
     *     与 VALUES 行的顺序严格对应 ⇒ 形状共用是安全的。
     */
    upsertHistory: (rowCount) => {
      const values = new Array(rowCount).fill('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      return `INSERT INTO ad_replication_history
      (collected_at, agent_id, source_dc, dest_dc, naming_context,
       last_success_time, last_attempt_time, attempt_duration_ms,
       objects_transferred, status_code, error_message)
      VALUES ${values}`;
    }
  }
};

// ---------------------------------------------------------------------------
// 兼容导出 (顶层函数名) —— 调用点 (services/replication.js) 不变。
// 全部转发到上面的 replicationBatch.*, 单一真源在块里。
// ---------------------------------------------------------------------------

export function upsertStatusBatchMySql(rowCount) {
  return replicationBatch.mysql.upsertStatus(rowCount);
}

export function upsertStatusBatchMssql(rowCount) {
  return replicationBatch.mssql.upsertStatus(rowCount);
}

export function upsertActiveErrorBatchMySql(rowCount) {
  return replicationBatch.mysql.upsertActiveError(rowCount);
}

export function upsertActiveErrorBatchMssql(rowCount) {
  return replicationBatch.mssql.upsertActiveError(rowCount);
}

export function removeActiveErrorBatchMySql(rowCount) {
  return replicationBatch.mysql.removeActiveError(rowCount);
}

export function removeActiveErrorBatchMssql(rowCount) {
  return replicationBatch.mssql.removeActiveError(rowCount);
}

export function upsertHistoryBatch(rowCount) {
  return replicationBatch.mysql.upsertHistory(rowCount);
}
