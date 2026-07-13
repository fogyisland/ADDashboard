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

export function buildMockDb(scripts = [], { dialect = 'mysql' } = {}) {
  function lookup(sql) {
    for (const s of scripts) {
      if (s.match.test(sql)) {
        const rows = typeof s.rows === 'function' ? s.rows() : s.rows;
        return Array.isArray(rows) ? rows : [];
      }
    }
    return [];
  }
  function makeExec(records) {
    return async function execute(sql, params = []) {
      if (records) records.push({ sql, params: [...params] });
      const rows = lookup(sql);
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
      if (records) records.push({ sql, params: [...params] });
      return { rows: lookup(sql) };
    };
  }
  function build({ records } = {}) {
    const execute = makeExec(records);
    const query = makeQuery(records);
    return {
      dialect,
      sql: buildSql(dialect),
      execute,
      query,
      transaction: async (work) => work({ execute, query }),
      healthcheck: async () => {},
      close: async () => {}
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