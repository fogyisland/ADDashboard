// sql-scanner.js — scan center source for SQL table references.
//
// Walks every .js file under center/src, looks for SQL string literals
// (the same kind of strings routed through db.query / db.execute), and
// extracts table names mentioned in FROM / JOIN / INSERT INTO / UPDATE /
// DELETE FROM / CREATE TABLE / ALTER TABLE / INTO ... SELECT.
//
// The output is a Map<tableName, Set<file:line>> — every distinct table
// the code actually touches, with the call sites that reference it. We
// don't try to validate the SQL or understand it semantically; we only
// find table names. This keeps the scanner simple and dependency-free.
//
// Conventions:
//   * All SQL strings in center code use backticks (`) or regular quotes.
//   * We don't follow template strings with ${} interpolation — the static
//     scan only sees the literal segments. A reference like
//     `FROM ${schemaName}.ad_users` will surface the literal
//     ".ad_users" (we strip the leading dot).
//   * "information_schema.*" / "sys.*" are skipped — those are DB-side
//     introspection tables, not our application tables.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// HERE = center/src/services → walk up three levels to reach center/src.
const DEFAULT_SRC_ROOT = path.resolve(HERE, '..', '..', '..'); // center/src

const KEYWORDS = [
  'FROM',
  'JOIN',
  'INTO',
  'UPDATE',
  'TABLE',
  'TRUNCATE',
  'REPLACE INTO'
];

// Recognised table-name prefixes in this codebase. Identifiers that don't
// start with one of these (and aren't a `pkg_*` package context) are
// almost always noise — comments, JSDoc prose, JS expressions like
// `manifest.database`, or SQL keywords that follow another keyword
// (e.g. `UPDATE SET`, `WHERE IN`). The list is derived from the CREATE
// TABLE registry under db/schema and db/migrations; package-context
// tables are dynamic and go through a different filter.
const TABLE_PREFIXES = [
  'ad_', 'sys_', 'metric_', 'audit_', 'alert_', 'package_',
  'schema_', 'system_', 'config_', 'site_', 'orphan_',
  'probe_', 'installed_', 'role_', 'agent_', 'current_',
  'member_', 'server_', 'replication_', 'heartbeat_',
  'lockout_', 'pkg_'
];

// SQL keywords that the regex picks up but are never table names —
// `UPDATE SET col` captures `SET`, `WHERE IN (...)` captures `IN`,
// `DELETE FROM tbl` captures `FROM`, etc.
const SQL_KEYWORD_NOISE = new Set([
  // Clause-starting keywords (captured when followed by another clause).
  'set', 'from', 'into', 'update', 'table', 'truncate', 'delete',
  'replace',
  // Mid-clause keywords.
  'if', 'exists', 'absent', 'present', 'cascade', 'references',
  'not', 'null', 'default', 'unique', 'primary', 'check', 'constraint',
  'foreign', 'as', 'on', 'by', 'for', 'when', 'then', 'else', 'case',
  'end', 'begin', 'commit', 'rollback', 'transaction', 'temp', 'temporary',
  'view', 'trigger', 'matched', 'using', 'values', 'where', 'having',
  'group', 'order', 'limit', 'offset', 'distinct', 'all', 'any', 'some',
  'between', 'like', 'in', 'is', 'sysutcdatetime'
]);

function looksLikeTable(name, schemaPrefix) {
  if (!name) return false;
  const lower = name.toLowerCase();
  if (SQL_KEYWORD_NOISE.has(lower)) return false;
  // pkg_* schemas host package-defined tables (typically `metrics`).
  // Accept any plausible lowercase snake_case identifier ≥ 3 chars.
  if (schemaPrefix && schemaPrefix.startsWith('pkg_')) {
    return lower.length >= 3 && /^[a-z][a-z0-9_]*$/.test(lower);
  }
  if (lower.length < 4) return false;
  return TABLE_PREFIXES.some((p) => lower.startsWith(p));
}

function extractTableNames(sqlText) {
  const out = new Set();
  // Strip comments (JS `//` and SQL `--`), block comments, SQL 'literals',
  // and template interpolations `${...}` so we don't pick up identifiers
  // embedded in prose or partial SQL fragments. We do NOT strip
  // double-quoted or backticked strings because those often contain the
  // SQL we want to scan.
  const stripped = sqlText
    .replace(/\/\/[^\n]*/g, ' ')              // JS/SQL line comments
    .replace(/--[^\n]*/g, ' ')                // SQL line comments
    .replace(/\/\*[\s\S]*?\*\//g, ' ')        // block comments
    .replace(/'[^']*'/g, "''")                // SQL 'literals'
    .replace(/\$\{[^}]*\}/g, '');             // template interpolation (empty, not space)

  // Match keyword followed by an optional schema prefix and an identifier.
  // Groups 1-4 capture the schema prefix (one of: backticked, double-quoted,
  // bracket-quoted, bare identifier); groups 5-8 capture the table
  // identifier. The `\s+IF\s+(?:NOT\s+)?EXISTS` after the keyword lets
  // us match `CREATE TABLE IF NOT EXISTS name` and `DROP TABLE IF EXISTS
  // name`. SQL identifiers don't include `$` (that's JS template-
  // interpolation), so we use `\w` only — without `$` — to keep the
  // capture anchored at real SQL tokens.
  // The keyword list intentionally excludes `DELETE`, `REPLACE INTO`,
  // and `TRUNCATE` — those syntaxes always pair with FROM/INTO/TABLE
  // immediately after, so matching only the second keyword gives a
  // cleaner capture (and avoids `DELETE FROM tbl` matching `FROM`
  // as the table identifier). `UPDATE` is kept because UPDATE tbl
  // SET col = ... is valid syntax where the first identifier is
  // genuinely a table reference.
  const re = new RegExp(
    '\\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\\b' +
    '(?:\\s+IF\\s+(?:NOT\\s+)?EXISTS)?' +
    '\\s+' +
    '(?:(?:`([^`]+)`|"([^"]+)"|\\[([^\\]]+)\\]|([A-Za-z_]\\w*))\\s*\\.\\s*)?' +
    '(?:`([^`]+)`|"([^"]+)"|\\[([^\\]]+)\\]|([A-Za-z_]\\w*))',
    'gi'
  );
  // DB-side introspection schemas we never want to flag as application tables.
  const INTROSPECTION_SCHEMAS = new Set(['information_schema', 'sys', 'mysql', 'performance_schema']);
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const schemaPrefix = (m[1] || m[2] || m[3] || m[4] || '').toLowerCase();
    const table = (m[5] || m[6] || m[7] || m[8] || '').trim();
    if (!table) continue;
    if (INTROSPECTION_SCHEMAS.has(schemaPrefix)) continue;
    if (!looksLikeTable(table, schemaPrefix)) continue;
    // Skip column assignments: `UPDATE col = ...`, `ON DUPLICATE KEY
    // UPDATE col = ...`, or `UPDATE col, col2 = ...`. The captured
    // identifier is followed by `=` (with optional whitespace) or `,`
    // (which is also a column-list delimiter). Real table references
    // are always followed by SQL-clause words (WHERE, JOIN, FROM,
    // SET-clause-end) or end of statement.
    const afterIdx = m.index + m[0].length;
    const tail = stripped.slice(afterIdx).match(/^\s*(\S)/);
    if (tail && (tail[1] === '=' || tail[1] === ',')) continue;
    const full = schemaPrefix ? `${schemaPrefix}.${table}` : table;
    out.add(full);
  }
  return out;
}

function walkFiles(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      // node_modules / dist / tests are not application source — skip
      // them so we don't pull test-fixture SQL strings into the
      // production inventory view.
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'tests') continue;
      out.push(...walkFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

export function scanCenterCodeForTables(srcRoot) {
  // Default parameter syntax only handles `undefined`; coalesce `null` to the
  // default so the route handler's `cfg.schemaInventorySrcRoot || null`
  // (set by config.js) doesn't NPE on `path.relative`.
  const root = srcRoot || DEFAULT_SRC_ROOT;
  const refs = new Map(); // table -> Set<"path:line">
  if (!fs.existsSync(root)) return refs;

  // We can't parse ES modules perfectly with regex, so we scan the raw
  // file content for SQL-shaped substrings. Any line containing a SQL
  // keyword followed by an identifier is a candidate.
  for (const file of walkFiles(root)) {
    const rel = path.relative(root, file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Quick gate: skip lines that don't look like SQL.
      if (!/\b(FROM|JOIN|INTO|UPDATE|TABLE|TRUNCATE)\b/i.test(line)) continue;
      const names = extractTableNames(line);
      for (const n of names) {
        if (!refs.has(n)) refs.set(n, new Set());
        refs.get(n).add(`${rel}:${i + 1}`);
      }
    }
  }
  return refs;
}

// Map an identified table name to the schema it should live in. Our
// convention: a bare `pkg_<name>` table or `pkg_<name>.<naming_context>`
// (package-internal naming context suffix) lives in schema pkg_<name>;
// everything else lives in the configured database (the app's main
// schema). Strip any `.suffix` first because pkg_* schemas don't have
// per-context subtables — the context names a row, not a table.
export function schemaForTable(tableName, dbDatabase) {
  const base = tableName.split('.')[0];
  if (base.startsWith('pkg_')) return base;
  return dbDatabase;
}

// Strip any .metrics / .runs / .state suffix — those are package-internal
// naming contexts, not table names. The actual table is always named
// "metrics" (or whatever the package manifest declares) under the pkg_
// schema. We return the bare table name (just "metrics" by convention).
export function baseTableName(tableName) {
  return tableName.split('.').pop();
}