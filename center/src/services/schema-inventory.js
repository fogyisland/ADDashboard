// Schema inventory service (T285 admin/SchemaInventoryView).
//
// Goal: scan what tables THIS program (center code) actually references
// in its SQL strings and compare them against the database's actual
// shape. The intent is "code ↔ DB" consistency, not "manifest ↔ DB".
//
// Sources of "expected":
//   * center/src/**/*.js SQL strings — parsed for table references via
//     sql-scanner.scanCenterCodeForTables. This drives the inventory: we
//     only look at tables the code touches.
//   * db/schema/*.sql + db/migrations/*.sql CREATE TABLE — gives the
//     expected column shape for tables in the app's main schema.
//   * center/data/packages/<name>/<version>/manifest.json — gives the
//     expected column shape for pkg_* tables (their contracts are owned
//     by package authors, not by our CREATE TABLE statements).
//
// Source of "actual":
//   information_schema (MySQL) / sys.* (MSSQL) — tables and columns as
//   they currently exist on the database.
//
// Output per table:
//   {
//     schema, name, source: 'code' | 'package',
//     codeRefs: ["path/file.js:42", ...],  // which files reference it
//     expected: [{name, type, nullable}],   // null when only "actual" exists
//     actual:   [{name, type, nullable}],
//     diff: { missingColumns, extraColumns, typeMismatches } | null,
//     status: 'in_sync' | 'drift' | 'missing_in_db' | 'unexpected'
//   }
//
// Output per schema:
//   { name, tables: [ ... ] }
//
//   status legend:
//     in_sync       — code expects it, DB has it, columns match
//     drift         — code expects it, DB has it, columns differ
//     missing_in_db — code expects it, DB does NOT have it
//     unexpected    — DB has it but no code/manifest references it (rare,
//                     filtered out by default; only shown with showAll)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanCenterCodeForTables, schemaForTable, baseTableName } from './sql-scanner.js';
import { parseAllCreateTables } from './migration-parser.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.resolve(HERE, '..', '..', 'data', 'packages');

// JSON ↔ nvarchar / varchar / text equivalence (cross-dialect). Defined
// here (rather than imported from the old manifest-based service) so the
// inventory is self-contained — column-level drift has its own logic.
const TYPE_EQUIV = {
  json: new Set(['json', 'nvarchar', 'varchar', 'text', 'longtext', 'ntext', 'char'])
};

function typesEquivalent(actualType, expectedType) {
  const expected = String(expectedType || '').toLowerCase().trim();
  const actual = String(actualType || '').toLowerCase().trim();
  if (!expected) return true;
  const baseExpected = expected.replace(/\s*\(.*?\)\s*/g, '');
  const baseActual = actual.replace(/\s*\(.*?\)\s*/g, '');
  if (baseExpected === 'json') return TYPE_EQUIV.json.has(baseActual);
  if (baseExpected === 'varchar' && baseActual === 'nvarchar') return true;
  if (baseExpected === 'nvarchar' && baseActual === 'varchar') return true;
  return actual === expected;
}

function normalizeColumn(c) {
  return {
    name: c.column_name ?? c.name,
    type: c.column_type ?? c.data_type ?? '',
    nullable: c.is_nullable === 'YES' || c.is_nullable === true || c.nullable === true,
    defaultValue: c.column_default ?? c.default ?? null
  };
}

function diffColumns(expected, actual) {
  const expectedByName = new Map((expected || []).map((c) => [c.name, c]));
  const actualByName = new Map((actual || []).map((c) => [c.name, c]));
  const missingColumns = [];
  const extraColumns = [];
  const typeMismatches = [];
  for (const [n, e] of expectedByName) {
    const a = actualByName.get(n);
    if (!a) { missingColumns.push({ name: n, expectedType: e.type }); continue; }
    if (!typesEquivalent(a.type, e.type)) {
      typeMismatches.push({ name: n, expectedType: e.type, actualType: a.type });
    }
  }
  for (const [n, a] of actualByName) {
    if (!expectedByName.has(n)) extraColumns.push({ name: n, actualType: a.type });
  }
  const hasDiff = missingColumns.length || extraColumns.length || typeMismatches.length;
  return { missingColumns, extraColumns, typeMismatches, status: hasDiff ? 'drift' : 'in_sync' };
}

// Pull the expected column list for a single table from the parsed
// CREATE TABLE registry.
function expectedFromMigrations(tableName, registry) {
  return registry.get(tableName)?.columns || null;
}

// Pull the expected column list for a pkg_* schema's tables from a
// package manifest.
function expectedFromManifest(pkgSchema, dataDir) {
  // pkgSchema = "pkg_ad_local_port_check"; pkgName = "ad-local-port-check"
  const m = pkgSchema.match(/^pkg_(.+)$/);
  if (!m) return null;
  const pkgName = m[1].replaceAll('_', '-');
  if (!dataDir) return null;
  const pkgDir = path.join(dataDir, pkgName);
  if (!fs.existsSync(pkgDir)) return null;
  let versions = [];
  try {
    versions = fs.readdirSync(pkgDir).filter((v) => {
      try { return fs.statSync(path.join(pkgDir, v)).isDirectory(); }
      catch { return false; }
    });
  } catch { return null; }
  if (versions.length === 0) return null;
  versions.sort();
  const latest = versions[versions.length - 1];
  const manifestPath = path.join(pkgDir, latest, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const db = manifest.database || {};
    const metricSchema = db.metricSchema || {};
    if (!db.metricTable) return null;
    return new Map([
      [db.metricTable, Object.entries(metricSchema).map(([name, def]) => ({
        name, type: def?.type || 'unknown', nullable: def?.nullable !== false
      }))]
    ]);
  } catch {
    return null;
  }
}

// Query DB for the actual column list of a single table. Returns
// null when the table doesn't exist (no rows in information_schema.COLUMNS).
async function readActual(db, schemaName, tableName) {
  const { rows } = await db.execute(db.sql.schemaInventory.listColumns, [schemaName, tableName]);
  if (!rows || rows.length === 0) return null;
  return rows.map(normalizeColumn);
}

// Build the per-table entry given all the inputs we already collected.
function buildTableEntry({ schema, table, codeRefs, expected, actual, source }) {
  if (actual === null) {
    return {
      schema, name: table, source, codeRefs,
      expected: expected || null,
      actual: [],
      diff: null,
      status: 'missing_in_db'
    };
  }
  const diff = expected ? diffColumns(expected, actual) : { status: 'in_sync' };
  return {
    schema, name: table, source, codeRefs,
    expected: expected || null,
    actual,
    diff,
    status: diff.status
  };
}

export async function getCodeSchemaInventory(db, opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR;
  const srcRoot = opts.srcRoot;
  const repoRoot = opts.repoRoot;
  // The db facade doesn't carry the database name — the caller (route
  // handler) reads it from config.db.{dialect}.database and passes it
  // through. pkg_* references go to their own schema; everything else
  // buckets into this name.
  const dbName = opts.dbName || db.database || '';

  // 1. Scan center code for table references.
  const codeRefs = scanCenterCodeForTables(srcRoot);

  // 2. Parse CREATE TABLE statements from migrations + main schema.
  const migrations = parseAllCreateTables(repoRoot);

  // 3. Walk each code-referenced table, figure out its schema, look up
  //    expected columns, query actual columns, diff.
  const schemaMap = new Map(); // schemaName -> { tables: [...] }
  for (const [rawName, refs] of codeRefs) {
    const table = baseTableName(rawName);
    const schema = schemaForTable(rawName, dbName);

    // For pkg_* schemas, expected columns come from the package manifest.
    // For everything else, they come from CREATE TABLE in migrations.
    let expected = null;
    let source = 'code';
    if (schema.startsWith('pkg_')) {
      const manifestMap = expectedFromManifest(schema, dataDir);
      if (manifestMap) expected = manifestMap.get(table) || null;
      source = 'package';
    } else {
      expected = expectedFromMigrations(table, migrations);
    }

    const actualColumns = await readActual(db, schema, table);

    if (!schemaMap.has(schema)) schemaMap.set(schema, []);
    schemaMap.get(schema).push(buildTableEntry({
      schema, table, codeRefs: [...refs], expected,
      actual: actualColumns, source
    }));
  }

  // 4. Build the final list of schemas, sorted by name, with tables
  //    sorted by name.
  const schemas = [...schemaMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, tables]) => ({
      name,
      tables: tables.sort((a, b) => a.name.localeCompare(b.name))
    }));

  return { schemas };
}

// Exported for tests — the diff helper is pure.
export const _test = { diffColumns, typesEquivalent, schemaForTable, baseTableName };