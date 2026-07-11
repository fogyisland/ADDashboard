// Mock pool implementing the subset of mysql2/promise our routes use:
//   pool.execute(sql, params) -> [rows, fields]
//
// `scripts` is an array of { match: RegExp, rows: any[] | (() => any[]) }.
// The first matching script's rows is returned. When no script matches
// an empty array is returned (so callers don't crash on missing mocks).
//
// `records` is an array appended to by every execute() call — used by
// tests that assert which queries were issued and with which params.

export function buildMockPool(scripts = []) {
  return {
    async execute(sql, params = []) {
      for (const s of scripts) {
        if (s.match.test(sql)) {
          const rows = typeof s.rows === 'function' ? s.rows() : s.rows;
          return [Array.isArray(rows) ? rows : [], []];
        }
      }
      return [[], []];
    }
  };
}

export function buildRecordingPool(records = []) {
  return {
    async execute(sql, params = []) {
      records.push({ sql, params: [...params] });
      return [[], []];
    }
  };
}

export function buildThrowingPool(message = 'boom') {
  return {
    async execute() {
      throw new Error(message);
    }
  };
}
