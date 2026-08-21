// migration-parser.js — extract CREATE TABLE definitions from SQL files.
//
// Reads every .sql file under db/migrations/ and db/schema/ (MySQL
// dialect) and pulls out CREATE TABLE [IF NOT EXISTS] <name> (...) blocks.
// We only need column name + type + nullable for drift detection, so
// the parser focuses on those three. Other clauses (PRIMARY KEY, UNIQUE
// KEY, INDEX, ENGINE, CHARSET) are ignored.
//
// Limitations:
//   * Single CREATE TABLE per regex match. Multi-statement files work
//     because the regex is global.
//   * MSSQL bracket identifiers [name] are supported.
//   * Stored procedures / DELIMITER blocks (used by add-column guards)
//     are skipped — we only want initial table shapes, not ALTER TABLE.
//   * Comments (--, /* */) are stripped before parsing.

// Regex matches CREATE TABLE [IF NOT EXISTS] name ( ... ) where the
// parentheses form is non-greedy up to the matching close paren at the
// same nesting level. MySQL's CREATE TABLE syntax doesn't allow nested
// parens inside the column list in practice (CHECK constraints and
// functional indexes can, but they're rare in this codebase), so a
// non-greedy match is good enough for the migrations we ship.
const CREATE_TABLE_RE =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))\s*\(([^;]+?)\)\s*(?:ENGINE|;|\n\s*--)/gi;

const PK_RE = /^\s*(?:PRIMARY\s+KEY|UNIQUE\s+KEY|KEY|INDEX|CONSTRAINT|FOREIGN\s+KEY)\b/i;
// Match a column definition: name <type-with-parens> [NOT NULL | NULL] [trailing
// options] , / EOL. The type may include parens (VARCHAR(64)), so we capture
// lazily until we hit NOT NULL / NULL / DEFAULT / AUTO_INCREMENT / , / EOL.
// The `(?:\s+(?:UNSIGNED|ZEROFILL))?` lets us capture `INT UNSIGNED` and
// `BIGINT ZEROFILL` as part of the type, but NOT AUTO_INCREMENT / PRIMARY
// KEY / UNIQUE KEY — those are table-level attributes, not type modifiers
// (they go through the trailing-options group instead).
const COLUMN_RE = new RegExp(
  String.raw`^\s*(?:\`([^\`]+)\`|"([^"]+)"|\[([^\]]+)\]|(\w+))\s+` +
  String.raw`([A-Za-z_][\w$ ]*?(?:\s*\([^)]*\))?(?:\s+(?:UNSIGNED|ZEROFILL))?)` +
  String.raw`(?:\s+(NOT\s+NULL|NULL))?` +
  String.raw`(?:\s+(?:DEFAULT|AUTO_INCREMENT|IDENTITY|COMMENT|REFERENCES|ON\s+UPDATE|COLLATE|CHARACTER\s+SET|UNIQUE|PRIMARY)[^\n,]*)?` +
  String.raw`\s*(?:,|$)`,
  'i'
);

export function parseCreateTables(sqlText) {
  const tables = new Map(); // tableName -> { columns: [{ name, type, nullable }] }
  // Strip comments.
  const cleaned = sqlText
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  let m;
  while ((m = CREATE_TABLE_RE.exec(cleaned)) !== null) {
    const name = m[1] || m[2] || m[3] || m[4];
    const body = m[5];
    if (!name) continue;
    const columns = parseColumns(body);
    tables.set(name, { columns });
  }
  return tables;
}

function parseColumns(body) {
  const columns = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/--.*$/, '').trim();
    if (!line) continue;
    if (PK_RE.test(line)) continue; // skip PK / index definitions
    if (/^\s*\)/.test(line)) continue;
    const cm = COLUMN_RE.exec(line);
    if (!cm) continue;
    const colName = cm[1] || cm[2] || cm[3] || cm[4];
    let colType = (cm[5] || '').trim();
    // Normalize type for cross-dialect comparison.
    colType = colType.replace(/\s+/g, ' ');
    // Strip trailing comma artifacts.
    colType = colType.replace(/,+\s*$/, '').trim();
    const nullable = !/NOT\s+NULL/i.test(line);
    columns.push({ name: colName, type: colType, nullable });
  }
  return columns;
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(HERE, '..', '..', '..');

function walkSql(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      // Recurse into mssql/ subdirectory (MSSQL has its own variants).
      if (entry.name === 'node_modules') continue;
      out.push(...walkSql(full));
    } else if (entry.isFile() && entry.name.endsWith('.sql')) {
      out.push(full);
    }
  }
  return out;
}

// Parse every SQL file under db/schema/ + db/migrations/ for CREATE TABLE.
// Returns Map<tableName, { columns }>. Later files override earlier ones
// (so e.g. db/migrations/004-package-system.sql can win over the initial
// CREATE TABLE in db/schema/01-tables.sql if they conflict).
export function parseAllCreateTables(repoRoot = DEFAULT_REPO_ROOT) {
  const tables = new Map();
  const sources = [
    path.join(repoRoot, 'db', 'schema'),
    path.join(repoRoot, 'db', 'migrations')
  ];
  // schema/ first (initial shape), then migrations (additive overrides).
  for (const dir of sources) {
    for (const file of walkSql(dir)) {
      const text = fs.readFileSync(file, 'utf8');
      const parsed = parseCreateTables(text);
      for (const [name, def] of parsed) {
        tables.set(name, def);
      }
    }
  }
  return tables;
}