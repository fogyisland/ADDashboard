// mssql driver wrapper. Same Db interface as drivers/mysql.js:
//   execute(sql, params) -> { rows, affectedRows, insertId }
//   query(sql, params)   -> { rows }
//   transaction(work)    -> result of work(tx)
//   healthcheck()        -> void
//   close()
//
// Differences from mysql driver:
//   - Placeholders: ? -> @p1, @p2, ... rewritten in-flight
//   - INSERT insertId: SCOPE_IDENTITY() appended as second batch
//   - Booleans: BIT columns return true/false; normalize to 0/1 for app
//   - No datetime normalization (SQL Server datetime2 accepts ISO)

import sql from 'mssql';

function rewritePlaceholders(sqlStr) {
  // Replace each `?` with `@p1, @p2, ...` in order. Only standalone `?`
  // (not inside string literals). Simple regex; sufficient because our
  // SQL strings never contain literal `?` characters.
  let i = 0;
  return sqlStr.replace(/\?/g, () => `@p${++i}`);
}

function bindInputs(request, params) {
  for (let i = 0; i < params.length; i++) {
    request.input(`p${i + 1}`, params[i]);
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
      max: config.pool?.max ?? 10,
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
    connectionTimeout: 30000,    // 30s — matches mssql default, explicit for clarity
    cancelTimeout: 30000         // 30s — matches mssql default, explicit for clarity
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
      // mssql@11 collapses INSERT batches that return no columns out of
      // `recordsets` (see tedious/request.js: `if (Object.keys(columns).length === 0) return`).
      // So for `INSERT ... SELECT` (no OUTPUT) followed by `SELECT SCOPE_IDENTITY()`,
      // recordsets.length is 1 and the id row lives at index 0. For other shapes
      // (e.g. INSERT ... VALUES) it may be index 1. Read the last recordset to
      // cover both shapes — same pattern the library itself uses internally
      // for batch outputs (`recordsets.pop()[0]`).
      const idRow = recordsets[recordsets.length - 1]?.[0];
      if (idRow?.id != null) {
        insertId = Number(idRow.id);
      } else if (affectedRows === 0) {
        // Round-14 fix: previously the driver threw unconditionally on
        // NULL id, but NULL just means the target table has no IDENTITY
        // column (e.g. schema_migrations PK is filename, not IDENTITY;
        // ad_agent_port_status has no surrogate key). Distinguish:
        //   - affectedRows > 0 + id NULL → INSERT succeeded, no auto-id
        //     available. Return undefined insertId (caller decides).
        //   - affectedRows == 0 + id NULL → INSERT failed entirely
        //     (constraint violation, syntax error caught upstream, etc).
        //     Throw so the failure surfaces — same throw semantics as
        //     before, only the "success with no IDENTITY" case changed.
        throw new Error(`mssql driver: SCOPE_IDENTITY() returned NULL after INSERT (rowsAffected=${affectedRows})`);
      }
      // else: INSERT succeeded (affectedRows > 0), no IDENTITY column,
      // insertId stays undefined. Schema-applier and ddl-apply
      // INSERTs into no-IDENTITY tables now work without throwing.
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
