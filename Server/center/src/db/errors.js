// Normalized error type thrown by the db facade. Wraps both mysql2 and
// mssql driver errors with a unified `code` namespace so route handlers
// don't need to know which driver produced the error.

const CODE_MAP = {
  // mysql
  ER_DUP_ENTRY: 'DUP_ENTRY',
  ER_TRUNCATED_WRONG_VALUE: 'TRUNCATED',
  ER_NO_REFERENCED_ROW_2: 'FK_VIOLATION',
  ER_ROW_IS_REFERENCED_2: 'FK_IN_USE',
  ECONNREFUSED: 'CONN_REFUSED',
  ETIMEDOUT: 'TIMEOUT',
  PROTOCOL_CONNECTION_LOST: 'CONN_LOST',
  // mssql
  EREQUEST: 'DRIVER_ERROR',
  ELOCKTIMEOUT: 'TIMEOUT',
  ETIMEOUT: 'TIMEOUT'
};

export class DbError extends Error {
  constructor(originalError, { code, sqlState, sqlMessage } = {}) {
    super(originalError?.message || String(originalError));
    this.name = 'DbError';
    this.originalError = originalError;
    this.code = code || CODE_MAP[originalError?.code] || 'UNKNOWN';
    this.sqlState = sqlState;
    this.sqlMessage = sqlMessage;
  }

  static wrap(e) {
    if (e instanceof DbError) return e;
    const wrapped = new DbError(e, {
      sqlState: e.sqlState || e.number?.toString(),
      sqlMessage: e.sqlMessage
    });
    // Preserve HTTP passthrough markers so route catches (admin.js line 277
    // et al) can still distinguish 4xx business errors from generic 500s
    // when the throw originated inside a tx. Without this propagation, a
    // business throw like putConfigInTx's `throw { httpStatus: 400, ... }`
    // for legacy ad_agent_token writes would be silently downgraded to a
    // generic 500 — the property hides on `wrapped.originalError.httpStatus`
    // and the catch's `e.httpStatus === 400` check never sees it.
    if (e && typeof e.httpStatus === 'number') wrapped.httpStatus = e.httpStatus;
    if (e && e.blockedKey !== undefined) wrapped.blockedKey = e.blockedKey;
    return wrapped;
  }
}