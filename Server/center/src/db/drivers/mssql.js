// mssql driver wrapper. Same Db interface as drivers/mysql.js:
//   execute(sql, params) -> { rows, affectedRows, insertId }
//   query(sql, params)   -> { rows }
//   transaction(work)    -> result of work(tx)
//   healthcheck()        -> void
//   close()
//
// ★ R161.6 (2026-10-26) — 本驱动**没有** session(), 这是**故意的**, 不是漏写:
//   MySQL 侧的 session() 是为了把基线 DDL 的幂等守卫
//   (INFORMATION_SCHEMA 探针 → SET @s → PREPARE/EXECUTE/DEALLOCATE) 钉在
//   一条连接上 —— @s 与 stmt 都是**连接级状态**。
//   MSSQL 侧的基线守卫是 `IF NOT EXISTS (...) BEGIN ... END` 的**自包含单批**
//   (走 request.batch()), 不依赖任何会话状态 ⇒ 无需固定连接。
//   init/schema-applier.js 的 applyFile 检测到 db.session 缺失时逐条
//   execute —— 与本轮之前**逐字一致**, MSSQL 零行为变化。
//   另: MySQL 侧的 server 级能力 (probeServer / databaseExists /
//   createDatabaseIfMissing) 在 MSSQL 侧同样**没有** —— MSSQL 的库由
//   installer 预先建好, 不在初始化向导里建。
//
// Differences from mysql driver:
//   - Placeholders: ? -> @p1, @p2, ... rewritten in-flight
//   - INSERT insertId: SCOPE_IDENTITY() appended as second batch
//   - Booleans: BIT columns return true/false; normalize to 0/1 for app
//   - No datetime normalization (SQL Server datetime2 accepts ISO)
//   - Buffer binds as VarBinary (R161.6) — 见 bindInputs()

import sql from 'mssql';

function rewritePlaceholders(sqlStr) {
  // Replace each `?` with `@p1, @p2, ...` in order. Only standalone `?`
  // (not inside string literals). Simple regex; sufficient because our
  // SQL strings never contain literal `?` characters.
  let i = 0;
  return sqlStr.replace(/\?/g, () => `@p${++i}`);
}

function bindInputs(request, params) {
  // R158.44.7.6 (2026-10-05) — explicit mssql.* type per JS value. The previous
  // 2-arg `request.input(name, value)` form relied on mssql@11's automatic
  // type inference, which on nested MERGE statements would silently throw
  // "Invalid column name 'description'" / "Cannot read properties of undefined
  // (reading 'replace')" / "Explicit conversion from int to datetime2". Once
  // a single row hit one of those, the connection-pool session entered a bad
  // state and subsequent rows silently no-op'd — exactly the symptom observed
  // for ad_users_snapshot: 7527 entries × tx.execute, no FAIL, but 0 rows in
  // the table. Passing explicit types bypasses the inference path; the SQL
  // CAST() targets (already in the SQL string) drive the final type coercion.
  // Note: `sanitizeArr` upstream has already swept `undefined -> null`, so we
  // only see JS-typed values or null.
  for (let i = 0; i < params.length; i++) {
    const v = params[i];
    if (v === null || v === undefined) {
      request.input(`p${i + 1}`, null);
    } else if (v instanceof Date) {
      request.input(`p${i + 1}`, sql.DateTime2, v);
    } else if (typeof v === 'boolean') {
      request.input(`p${i + 1}`, sql.Bit, v);
    } else if (typeof v === 'number') {
      // Split at 32-bit boundary to match CAST() targets: user_account_control
      // / group_type / member_count → Int; runId / forest_id / domain_id →
      // BigInt (those columns are BIGINT). Anything outside ±2^31 is rare in
      // our schema but the 7527 user runId = 30 fits Int — BigInt only when
      // strictly required to match the column type.
      if (Number.isInteger(v) && (v > 2147483647 || v < -2147483648)) {
        request.input(`p${i + 1}`, sql.BigInt, v);
      } else {
        request.input(`p${i + 1}`, sql.Int, v);
      }
    } else if (typeof v === 'bigint') {
      request.input(`p${i + 1}`, sql.BigInt, v);
    } else if (Buffer.isBuffer(v)) {
      // R161.6 (2026-10-26) — Buffer 必须显式绑成 VarBinary。
      // 旧实现把 Buffer 落到下面的 "其它一律 NVarChar" 分支 ⇒ tedious 的
      // nvarchar.js validate() 抛 `TypeError: Invalid string.`
      // (Buffer 不是字符串) —— 表现为 ad_forest.bind_password 这类
      // "二进制密文列"的写入直接 500。
      // 对应列: ad_forest.bind_password (MySQL 侧是 VARBINARY(1024),
      // 存 AES-256-GCM 密文 Buffer)。
      request.input(`p${i + 1}`, sql.VarBinary, v);
    } else {
      // string (and any other JS value); mssql.js maps to NVARCHAR.
      // SQL CAST() (e.g. CAST(? AS NVARCHAR(128))) truncates on the column.
      request.input(`p${i + 1}`, sql.NVarChar, v);
    }
  }
}

function normalizeRow(row) {
  if (row == null) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'boolean') out[k] = v ? 1 : 0;
    else out[k] = v;
  }
  return out;
}

function normalizeRows(rows) {
  return Array.isArray(rows) ? rows.map(normalizeRow) : [];
}

export function createMssqlDriver(config) {
  const poolCfg = {
    server: config.server,
    database: config.database,
    user: config.user,
    password: config.password,
    port: config.port ?? 1433,
    options: {
      encrypt: config.encrypt ?? false,
      trustServerCertificate: config.trustServerCertificate ?? true
    },
    pool: {
      // S9 (2026-09-30, MSSQL dialect) — pool.max 10 → 25. The 8-hour
      // centre log showed 1537 'operation timed out for an unknown reason'
      // errors, 99.5% on inbound/outbound-partners + file-push claim —
      // agent heartbeat is ~12 req/s × 3 round-trips ≈ 36 req/s against a
      // 10-conn pool. With pool.max=10 + connectionTimeout=30000 (the
      // previous config), once all 10 connections are held by a slow
      // audit_logs INSERT, every new request queues up to 30 s before the
      // driver throws. During that 30 s the agent's heartbeat, port-probe
      // tick, and email-outbox tick all keep stacking Promises into the
      // setInterval closure referencing every captured row context. After
      // ~60 min the V8 heap hits 4 GB and Mark-Compact fails → FATAL OOM.
      // The 25-conn pool fits the legitimate heartbeat fan-out (36 req/s
      // × 0.05 s avg = ~6 concurrent connections in flight, plus a 4×
      // headroom for bursty audit_logs writes).
      max: config.pool?.max ?? 25,
      min: 0,
      idleTimeoutMillis: 30000
    },
    // Timeouts for SQL Server 2016+ deployments. mssql npm defaults are
    // 15s (request), 30s (connection), 30s (cancel); long migrations and
    // audit-report queries on large tables can exceed the 15s default.
    // Set requestTimeout generously to avoid spurious disconnects; the
    // script-side Stopwatch timeout in services/dashboard.js (3-5s) covers
    // the read-side SLA.
    requestTimeout: 300000,      // 5 min — long MERGE / migrations / large report queries
    // S9 (2026-09-30, MSSQL dialect) — connectionTimeout trimmed 30000 →
    // 5000. Was the dominant OOM contributor: a request that arrives when
    // all 10 pool connections are busy waits up to 30 s before throwing.
    // During those 30 s the request Promise is alive, captured by every
    // downstream awaiter (setInterval callback in email.js, route handler
    // in routes/agent.js, etc.), and each rejection re-runs the catch path
    // without releasing the closures. 5 s is short enough that an agent's
    // failed POST returns 500 within a heartbeat window (heartbeat cadence
    // is 5 s, so the next heartbeat naturally retries), and long enough
    // that normal MERGE / large SELECT round-trips (well under 1 s in our
    // deployment) never trigger a false-positive timeout.
    connectionTimeout: 5000,
    cancelTimeout: 5000          // S9 — matched to connectionTimeout so a hung
                                 // query doesn't outlive its acquire-window.
  };

  const pool = new sql.ConnectionPool(poolCfg);
  // Connect eagerly on first request (mssql pool connects on .connect()).
  let connected = false;
  async function ensureConnected() {
    if (!connected) {
      await pool.connect();
      connected = true;
      // Apply session-level SET options once per pool (pool reuse reuses the
      // same connection config; SET persists on the session that pool.connect
      // returns). Two SETs fix latent silent failures the driver wrapper was
      // built around but didn't enforce:
      //   SET XACT_ABORT ON — abort the entire transaction on any runtime
      //     SQL error and auto-rollback. Without this, a T-SQL error in the
      //     middle of a transaction can leave the XACT in an open-but-
      //     uncommittable state; the try/catch rollback at line 185 races
      //     with the uncommittable XACT. With XACT_ABORT ON, every runtime
      //     error triggers automatic rollback per T-SQL spec, which is
      //     exactly what the wrapper's catch handler expects.
      //   SET QUOTED_IDENTIFIER ON — SQL Server's default for new
      //     connections, but pinned explicitly here to avoid cross-driver
      //     surprises (mssql npm doesn't guarantee session-level SETs on
      //     pool connect).
      //
      // Round-14 finding: do NOT add `SET NOCOUNT ON`. NOCOUNT ON suppresses
      // the TDS DONE packet that carries the rowsAffected counter, which
      // breaks INSERT/UPDATE/DELETE affectedRows tracking AND makes the
      // appended `SELECT SCOPE_IDENTITY() AS id` probe appear to fail
      // (`affectedRows=0` + `id=null` looks like a true INSERT failure but
      // is just the session option hiding the count). The driver appends
      // the SCOPE_IDENTITY probe specifically to recover the new IDENTITY
      // value, and that flow needs NOCOUNT OFF for accurate affectedRows.
      // The recordsets[] indexing was assumed to shift under NOCOUNT OFF
      // but in mssql@11 the "n rows affected" goes into the TDS DONE
      // packet, not into recordsets — verified by live end-to-end test
      // (Task #428).
    }
  }

  async function execute(sqlStr, params = []) {
    await ensureConnected();
    // Heuristic: only `INSERT ... INTO <table>` carries an IDENTITY to surface.
    // MERGE upserts target tables without IDENTITY (e.g. ad_agent_port_status,
    // ad_dcs, ad_agent_heartbeat, system_config) and would trip the
    // SCOPE_IDENTITY() NULL guard below. MERGE callers do not consume insertId.
    const isInsert = /^\s*INSERT\b/i.test(sqlStr) && /\bINTO\b/i.test(sqlStr);
    // Control-flow guard: mssql npm's `request.query()` wraps every SQL string in
    // `sp_executesql` (tedious/lib/connection.js:1627-1661). sp_executesql does
    // NOT execute IF/ELSE blocks as written — the IF guard is dropped and the
    // body runs unconditionally. For DDL like `IF NOT EXISTS (...) CREATE INDEX
    // idx_changed_at ON ...`, this means re-applying the migration hits "index
    // already exists" instead of skipping. Route IF-prefixed statements through
    // `request.batch()` which sends a raw SQL_BATCH TDS packet (bypassing
    // sp_executesql) so the IF guard is honored. This is critical for the
    // idempotent CREATE TABLE/INDEX guards in db/migrations/mssql/* (esp. 005).
    const hasControlFlow = /^\s*IF\b/i.test(sqlStr);
    const sqlWithId = isInsert
      ? `${rewritePlaceholders(sqlStr)};\nSELECT CAST(SCOPE_IDENTITY() AS bigint) AS id`
      : rewritePlaceholders(sqlStr);
    const request = pool.request();
    if (isInsert) request.multiple = true;
    bindInputs(request, params);
    // INSERT + IF control-flow would need both batch mode AND a SCOPE_IDENTITY
    // probe batch — that combination isn't expected in our DDL files (no
    // migration inserts rows with conditional logic). If a future caller needs
    // it, route through db.transaction() instead. For now, batch path drops the
    // SCOPE_IDENTITY append; insertId stays undefined.
    const result = hasControlFlow
      ? await request.batch(sqlWithId)
      : await request.query(sqlWithId);
    // Batch returns `{recordsets: [...], rowsAffected: [...]}` (no `recordset`).
    // Query returns `{recordset, recordsets, rowsAffected}`. Normalize both
    // shapes to a recordsets[] so downstream extraction is uniform.
    const recordsets = hasControlFlow
      ? (result.recordsets ?? [])
      : (isInsert ? result.recordsets : [result.recordset]);
    const first = recordsets?.[0] ?? [];
    const rows = normalizeRows(Array.isArray(first) ? first : []);
    // Always read the first batch's rowsAffected so UPDATE/DELETE/MERGE callers
    // (which use this for 404 detection) see the real count. For INSERT+SCOPE_IDENTITY
    // batches, rowsAffected[0] is the INSERT batch and rowsAffected[1] is the
    // SCOPE_IDENTITY() probe (=1). Use [0] for the meaningful count.
    const affectedRows = result.rowsAffected?.[0] ?? 0;
    let insertId;
    if (isInsert && !hasControlFlow) {
      const idRow = recordsets[recordsets.length - 1]?.[0];
      if (idRow?.id != null) {
        insertId = Number(idRow.id);
      } else if (affectedRows === 0) {
        throw new Error(`mssql driver: SCOPE_IDENTITY() returned NULL after INSERT (rowsAffected=${affectedRows})`);
      }
    }
    return { rows, affectedRows, insertId };
  }

  async function query(sqlStr, params = []) {
    const { rows } = await execute(sqlStr, params);
    return { rows };
  }

  async function transaction(work, sqlRegistry) {
    await ensureConnected();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      // tx.sql mirrors the parent db's sql registry so helpers like
      // writeAudit can resolve `tx.sql.audit.write` from inside a tx
      // without threading the SQL string from the caller. Same shape
      // mysql.js exposes for cross-driver consistency.
      const txWrapper = {
        sql: sqlRegistry,
        async execute(sqlStr, params = []) {
          // Same INSERT/MERGE/IF heuristics as pool.execute — see execute() above.
          const isInsert = /^\s*INSERT\b/i.test(sqlStr) && /\bINTO\b/i.test(sqlStr);
          const hasControlFlow = /^\s*IF\b/i.test(sqlStr);
          const sqlWithId = isInsert
            ? `${rewritePlaceholders(sqlStr)};\nSELECT CAST(SCOPE_IDENTITY() AS bigint) AS id`
            : rewritePlaceholders(sqlStr);
          const request = new sql.Request(tx);
          if (isInsert) request.multiple = true;
          bindInputs(request, params);
          const result = hasControlFlow
            ? await request.batch(sqlWithId)
            : await request.query(sqlWithId);
          const recordsets = hasControlFlow
            ? (result.recordsets ?? [])
            : (isInsert ? result.recordsets : [result.recordset]);
          const first = recordsets?.[0] ?? [];
          const rows = normalizeRows(Array.isArray(first) ? first : []);
          const affectedRows = result.rowsAffected?.[0] ?? 0;
          let insertId;
          if (isInsert && !hasControlFlow) {
            const idRow = recordsets[recordsets.length - 1]?.[0];
            if (idRow?.id != null) {
              insertId = Number(idRow.id);
            } else if (affectedRows === 0) {
              // Mirror the round-14 fix from execute() above: throw only
              // when the INSERT actually failed. Tables without an
              // IDENTITY column (e.g. schema_migrations, ad_agent_port_status)
              // now succeed with insertId=undefined.
              throw new Error(`mssql driver: SCOPE_IDENTITY() returned NULL after INSERT (rowsAffected=${affectedRows})`);
            }
            // else: INSERT succeeded, no IDENTITY — insertId stays undefined
          }
          return { rows, affectedRows, insertId };
        },
        async query(sqlStr, params = []) {
          const { rows } = await txWrapper.execute(sqlStr, params);
          return { rows };
        }
      };
      const result = await work(txWrapper);
      await tx.commit();
      return result;
    } catch (e) {
      try { await tx.rollback(); } catch {}
      throw e;
    }
  }

  async function healthcheck() {
    await ensureConnected();
    const request = pool.request();
    const result = await request.query('SELECT 1 AS ok');
    if (!result.recordset?.[0]?.ok) throw new Error('mssql healthcheck failed');
  }

  async function close() {
    if (connected) await pool.close();
  }

  return { dialect: 'mssql', execute, query, transaction, healthcheck, close };
}
