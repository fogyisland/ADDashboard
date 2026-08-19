// Dialect-agnostic mock for the db facade. Mocks the subset of `db`
// (center/src/db/index.js) that services and routes use:
//   db.execute(sql, params) -> { rows, affectedRows, insertId }
//   db.query(sql, params)   -> { rows }
//   db.transaction(work)    -> executes work with same-shaped tx
//   db.healthcheck()        -> resolves
//   db.close()              -> resolves
//
// `scripts` is an array of { match: RegExp, rows: any[] | (() => any[]) }.
// First matching script's rows is returned. When no script matches an
// empty array is returned (so callers don't crash on missing mocks).
//
// `records` is an array appended to by every execute/query call — used by
// tests that assert which queries were issued and with which params.

import { buildSql } from '../../src/db/sql.js';

// Auth-success row used by ad-hoc db mocks (Task 5 — I1). The userAuth
// middleware reads `SELECT token_version, status FROM sys_users WHERE id = ?`
// and treats `token_version=0, status=1` as "valid active user". Tests that
// construct ad-hoc mocks (instead of buildMockDb.standard()) can use this as
// a fallback row in their `query()` function.
const AUTH_SUCCESS_ROW = { token_version: 0, status: 1 };

// Recognises the userAuth middleware's per-request SELECT. Used by helpers
// below AND by the default mock scripts.
const isAuthStatusSelect = (sql) =>
  /SELECT\s+token_version,\s*status\s+FROM\s+sys_users/i.test(sql);

// Recognises the userAuth middleware's bundle-loader SELECT (I9 — Task 1).
// Default behavior is to return a valid bundle so existing tests that go
// through userAuth (via adminRouter/dashboardRouter/...) keep working.
// The default secret matches the most common test SECRET value
// (`'test-secret'`); tests that use a different SECRET must seed their
// own jwt_secret_current row via buildMockDb's `scripts` parameter.
const isJwtSecretBundleSelect = (sql) =>
  /jwt_secret/i.test(sql);

// Shared test default — kept in sync with the `SECRET` constant in the
// majority of tests (admin/dashboard/etc.). Tests that use a different
// secret must add their own script entry with /jwt_secret/ regex.
const DEFAULT_TEST_JWT_SECRET = 'test-secret';

// Default `query` implementation: returns auth-success for the getAuthStatus
// SELECT and the default JWT bundle for the bundle-loader SELECT. Tests can
// replace this with their own query() function if they need finer control.
const defaultQuery = async (sql) => {
  if (isAuthStatusSelect(sql)) {
    return { rows: [AUTH_SUCCESS_ROW] };
  }
  if (isJwtSecretBundleSelect(sql)) {
    return { rows: [{ config_key: 'jwt_secret_current', config_value: DEFAULT_TEST_JWT_SECRET }] };
  }
  return { rows: [] };
};

export function buildMockDb(scripts = [], { dialect = 'mysql' } = {}) {
  function lookup(sql, params) {
    // Special-case the userAuth middleware's per-request SELECT (Task 5 — I1):
    // BEFORE falling through to user scripts, if the query is the
    // getAuthStatus SELECT (token_version, status FROM sys_users), return a
    // row representing a valid active user (token_version=0, status=1). The
    // per-route handlers use a broader `FROM sys_users` regex that would
    // also match this query, so the auth look-up must win priority.
    if (isAuthStatusSelect(sql)) {
      return [AUTH_SUCCESS_ROW];
    }
    // I9 — Task 1: userAuth loads the jwt_secret bundle from system_config
    // before the getAuthStatus SELECT. Default to the test secret so tests
    // that sign JWTs with the standard 'test-secret' keep passing. Tests
    // that use a different SECRET must seed their own jwt_secret_current
    // row via the `scripts` parameter (with a /jwt_secret/ regex script).
    if (isJwtSecretBundleSelect(sql)) {
      return [{ config_key: 'jwt_secret_current', config_value: DEFAULT_TEST_JWT_SECRET }];
    }
    for (const s of scripts) {
      if (s.match.test(sql)) {
        const rows = typeof s.rows === 'function' ? s.rows(params) : s.rows;
        return Array.isArray(rows) ? rows : [];
      }
    }
    return [];
  }
  // Returns the script whose match matches `sql`, or null. Used to inspect
  // script-level props (throwOnExecute/onExecute/capture) that aren't part of
  // the row-matching contract.
  function findScript(sql) {
    for (const s of scripts) {
      if (s.match.test(sql)) return s;
    }
    return null;
  }
  function makeExec(records) {
    return async function execute(sql, params = []) {
      if (records) records.push({ sql, params: [...params] });
      // Script-level side-effects: throwOnExecute takes precedence (lets tests
      // assert the transaction-rollback path); onExecute fires after a normal
      // match so tests can capture params for assertions.
      const script = findScript(sql);
      if (script?.throwOnExecute) throw script.throwOnExecute;
      if (script?.onExecute) script.onExecute(sql, params);
      const rows = lookup(sql, params);
      // For INSERT/MERGE/UPDATE/DELETE we report affectedRows=1 so routes that
      // guard on `affectedRows === 0 -> 404` see "row affected". Tests that
      // need to assert "no rows touched" override at the call site.
      const isMutation = /^\s*(INSERT|MERGE|UPDATE|DELETE)\b/i.test(sql);
      return {
        rows,
        affectedRows: isMutation ? 1 : 0,
        insertId: /^\s*(INSERT|MERGE)\b/i.test(sql) ? 99 : undefined
      };
    };
  }
  function makeQuery(records) {
    return async function query(sql, params = []) {
      // Skip recording the userAuth middleware's per-request SELECT (Task 5
      // — I1): tests that assert "first SQL issued" via records[0] would
      // otherwise always see the auth check. The auth flow is verified by
      // tests/middleware.test.js, not by these recording-based ones.
      if (records && !isAuthStatusSelect(sql)) records.push({ sql, params: [...params] });
      // Mirror the execute-path hook so tests can capture/inspect SELECT
      // params without needing a recording array. onQuery takes precedence
      // over row lookup — handlers can return `{ rows }` directly to assert
      // shape without polluting scripts.rows.
      const script = findScript(sql);
      if (script?.onQuery) return script.onQuery(sql, params);
      return { rows: lookup(sql, params) };
    };
  }
  function build({ records } = {}) {
    const execute = makeExec(records);
    const query = makeQuery(records);
    const sql = buildSql(dialect);
    return {
      dialect,
      sql,
      execute,
      query,
      // Mirror the real driver: tx carries `sql` so helpers like writeAudit
      // can resolve `tx.sql.audit.write` from inside a tx.
      transaction: async (work) => work({ execute, query, sql }),
      healthcheck: async () => {},
      close: async () => {},
      // Expose the recording array so tests using
      // `buildMockDb(scripts).withRecording()` can still inspect what was
      // issued via db.records. Other tests pass an explicit `records` and
      // reference their own copy — both shapes are supported.
      records: records || null
    };
  }
  return {
    withRecording: (records = []) => build({ records }),
    standard: () => build({})
  };
}

// Backward-compat shims for tests still using old helpers.
export function buildMockPool(scripts = []) {
  return buildMockDb(scripts).standard();
}
export function buildRecordingPool(records = []) {
  return buildMockDb([], { dialect: 'mysql' }).withRecording(records);
}
export function buildThrowingPool(message = 'boom') {
  return {
    dialect: 'mysql',
    sql: buildSql('mysql'),
    async execute() { throw new Error(message); },
    async query() { throw new Error(message); },
    async transaction() { throw new Error(message); },
    async healthcheck() { throw new Error(message); },
    async close() {}
  };
}

// Export so ad-hoc db mocks in tests can plug into the same auth-default:
// the userAuth middleware expects `query()` to return an auth-success row
// for `SELECT token_version, status FROM sys_users WHERE id = ?`. Use this
// as the default `query` impl when constructing manual db mocks — or merge
// it into a hand-written query function for finer control.
export { defaultQuery, isAuthStatusSelect, AUTH_SUCCESS_ROW, DEFAULT_TEST_JWT_SECRET };
