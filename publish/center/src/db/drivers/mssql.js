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
    }
  };

  const pool = new sql.ConnectionPool(poolCfg);
  // Connect eagerly on first request (mssql pool connects on .connect()).
  let connected = false;
  async function ensureConnected() {
    if (!connected) {
      await pool.connect();
      connected = true;
    }
  }

  async function execute(sqlStr, params = []) {
    await ensureConnected();
    const isInsert = /^\s*(INSERT|MERGE)\b/i.test(sqlStr) && /\bINTO\b/i.test(sqlStr);
    const sqlWithId = isInsert
      ? `${rewritePlaceholders(sqlStr)};\nSELECT CAST(SCOPE_IDENTITY() AS bigint) AS id`
      : rewritePlaceholders(sqlStr);
    const request = pool.request();
    if (isInsert) request.multiple = true;
    bindInputs(request, params);
    const result = await request.query(sqlWithId);
    const recordsets = isInsert ? result.recordsets : [result.recordset];
    const first = recordsets?.[0] ?? [];
    const rows = normalizeRows(Array.isArray(first) ? first : []);
    let affectedRows = 0;
    let insertId;
    if (isInsert) {
      affectedRows = result.rowsAffected?.[0] ?? 0;
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
      } else {
        throw new Error(`mssql driver: SCOPE_IDENTITY() returned NULL after INSERT (rowsAffected=${affectedRows})`);
      }
    }
    return { rows, affectedRows, insertId };
  }

  async function query(sqlStr, params = []) {
    const { rows } = await execute(sqlStr, params);
    return { rows };
  }

  async function transaction(work) {
    await ensureConnected();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const txWrapper = {
        async execute(sqlStr, params = []) {
          const isInsert = /^\s*(INSERT|MERGE)\b/i.test(sqlStr) && /\bINTO\b/i.test(sqlStr);
          const sqlWithId = isInsert
            ? `${rewritePlaceholders(sqlStr)};\nSELECT CAST(SCOPE_IDENTITY() AS bigint) AS id`
            : rewritePlaceholders(sqlStr);
          const request = new sql.Request(tx);
          if (isInsert) request.multiple = true;
          bindInputs(request, params);
          const result = await request.query(sqlWithId);
          const recordsets = isInsert ? result.recordsets : [result.recordset];
          const first = recordsets?.[0] ?? [];
          const rows = normalizeRows(Array.isArray(first) ? first : []);
          let affectedRows = 0;
          let insertId;
          if (isInsert) {
            affectedRows = result.rowsAffected?.[0] ?? 0;
            const idRow = recordsets[recordsets.length - 1]?.[0];
            if (idRow?.id != null) {
              insertId = Number(idRow.id);
            } else {
              throw new Error(`mssql driver: SCOPE_IDENTITY() returned NULL after INSERT (rowsAffected=${affectedRows})`);
            }
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
