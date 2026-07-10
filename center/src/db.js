import sql from 'mssql';

let poolPromise = null;

export function initPool(config) {
  if (poolPromise) return poolPromise;
  poolPromise = new sql.ConnectionPool({
    server: config.sql.server,
    database: config.sql.database,
    user: config.sql.user,
    password: config.sql.password,
    options: { encrypt: false, trustServerCertificate: true, ...(config.sql.options || {}) }
  }).connect();
  return poolPromise;
}

export async function getPool() {
  if (!poolPromise) throw new Error('db pool not initialized');
  return poolPromise;
}

export async function closePool() {
  if (poolPromise) {
    const p = await poolPromise;
    await p.close();
    poolPromise = null;
  }
}
