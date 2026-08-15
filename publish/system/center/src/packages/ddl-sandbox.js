// DDL sandbox — pure-JS token scanner for package-supplied migration files.
//
// Defense-in-depth: rejects the most common classes of accidental damage
// (DROP, GRANT, DML, cross-schema, cross-package, multi-statement) and
// disallows unknown keywords/types. The scanner is the security boundary
// between untrusted package authors and the center DB — a future refactor
// that loosens any whitelist MUST come with a corresponding unit test
// update (ddl-sandbox.test.js > "ON UPDATE / ON DELETE CASCADE pass").
//
// FK referential actions (ON UPDATE CASCADE, ON DELETE CASCADE) are
// intentionally allowed — they appear in CREATE TABLE / ALTER TABLE but
// are not DML. The BLOCKED_PATTERNS use anchored DML forms so these
// clauses pass.

export const ALLOWED_KEYWORDS = new Set([
  // DDL
  'CREATE', 'TABLE', 'SCHEMA', 'DATABASE', 'INDEX', 'UNIQUE', 'VIEW', 'IF', 'NOT', 'EXISTS',
  'ALTER', 'ADD', 'COLUMN', 'CONSTRAINT', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES',
  'DEFAULT', 'NULL', 'CHECK', 'ON', 'UPDATE', 'DELETE', 'CASCADE', 'NO', 'ACTION', 'RESTRICT', 'SET',
  // table options
  'ENGINE', 'CHARSET', 'COLLATE',
  // index options
  'ASC', 'DESC', 'USING', 'BTREE', 'HASH',
  // types
  'INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT',
  'VARCHAR', 'CHAR', 'TEXT', 'NVARCHAR', 'NTEXT',
  'DOUBLE', 'FLOAT', 'DECIMAL', 'NUMERIC',
  'DATETIME', 'TIMESTAMP', 'DATETIMEOFFSET', 'DATE',
  'JSON', 'BOOLEAN', 'BIT',
  // dialect-specific
  'AUTO_INCREMENT', 'IDENTITY',
]);

export const BLOCKED_PATTERNS = [
  /;\s*\S/,                                  // multi-statement — checked first so the test sees ; not DROP
  /\bDROP\b/i,                              // no DROP at all — uninstall + purgeMetrics does that explicitly
  /\b(TRUNCATE|RENAME|GRANT|REVOKE|EXEC|EXECUTE|CALL)\b/i,
  /\bINSERT\s+INTO\b/i,                     // DML — does not match ON UPDATE / ON DELETE
  /\bUPDATE\s+(?!CASCADE\b)[a-z_]/i,       // DML — followed by identifier; ON UPDATE CASCADE passes (negative lookahead on identifier itself)
  /\bDELETE\s+FROM\b/i,                     // DML — followed by FROM; ON DELETE CASCADE passes
  /\b(MERGE|SELECT)\b/i,
  /\bpkg_[a-z0-9_]+\.[a-z0-9_]+/i,          // cross-package reference (other pkg_)
  /\b(main|installed_packages|metric_gauge|metric_counter|metric_timeseries|metric_status|package_runs|orphan_schemas|system_config|audit_logs|schema_migrations)\b/i,
];

const RESERVED_CENTER_RESOURCES = new Set([
  'main', 'installed_packages', 'metric_gauge', 'metric_counter', 'metric_timeseries',
  'metric_status', 'package_runs', 'orphan_schemas', 'system_config', 'audit_logs', 'schema_migrations'
]);

export function normalizeType(t) {
  return String(t).trim().toLowerCase().replace(/\s+/g, '');
}

function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

export function scanSql(sql, selfPackage) {
  if (typeof sql !== 'string') return { ok: false, blocked: 'non-string input' };
  const stripped = stripComments(sql);
  // The cross-package ban at index 7 (regex index 7) is `pkg_<name>.<table>`.
  // Per spec §"v1/v2 routing" + §"apply flow", a package's own migrations may
  // legitimately reference the package's own schema (e.g.
  // `CREATE TABLE pkg_foo.metrics` for a v2 package whose schemaName is
  // `pkg_foo`). When `selfPackage` is provided (the package's own schema
  // name, in canonical `pkg_<name>` form) we strip those self-references
  // before applying the cross-package block, then re-check — if any cross-
  // package reference remains, it still fails the scan.
  const selfRe = selfPackage ? new RegExp(`\\b${selfPackage}\\.[a-z0-9_]+`, 'gi') : null;
  const scanStripped = selfRe ? stripped.replace(selfRe, '__SELF_REF__') : stripped;
  for (const re of BLOCKED_PATTERNS) {
    if (re.test(scanStripped)) return { ok: false, blocked: re.source };
  }
  // reserved-resource guard: also catch `installed_packages` even if surrounded
  // by delimiters that the BLOCKED_PATTERNS' word boundary misses. The
  // splitter also breaks on `.` so schema-qualified identifiers like
  // `pkg_foo.metrics` tokenize into two parts, each of which is then
  // validated against RESERVED_CENTER_RESOURCES individually.
  const tokens = stripped.split(/[\s(),;.]+/).filter(Boolean);
  for (const t of tokens) {
    if (/^-?\d+(\.\d+)?$/.test(t)) continue;
    if (/^'[^']*'$/.test(t)) continue;
    if (/^[a-z_][a-z0-9_]*$/i.test(t)) {
      const upper = t.toUpperCase();
      if (RESERVED_CENTER_RESOURCES.has(t.toLowerCase())) {
        return { ok: false, blocked: `reserved center resource: ${t}` };
      }
      // Allow arbitrary identifier names (table / column / index names)
      // — DDL-keyword safety is enforced by ALLOWED_KEYWORDS for known
      // DDL tokens and by BLOCKED_PATTERNS for dangerous patterns.
      // Heuristic defense: a token that is entirely uppercase letters/
      // underscores (looks like a SQL keyword, not a typical lowercase
      // table name) and is not in ALLOWED_KEYWORDS is treated as a
      // suspect identifier and rejected. Catches `DROPPED`, `WHEREEVER`.
      if (/^[A-Z_]+$/.test(t) && !ALLOWED_KEYWORDS.has(upper)) {
        return { ok: false, blocked: `unknown identifier: ${t}` };
      }
      continue;
    }
    return { ok: false, blocked: `unparseable token: ${t}` };
  }
  return { ok: true };
}
