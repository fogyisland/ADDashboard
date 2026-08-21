// Schema inventory service (T285 admin/SchemaInventoryView). Walks every
// schema in the active DB, lists tables + columns, and for pkg_* schemas
// compares the actual layout against the package manifest's metricSchema
// to surface drift.
//
// Expected source (Option C from the design): the package manifest is the
// contract — metricTable and metricSchema define the metric table, and
// MIGRATION files are treated as the bootstrap that creates it. If the
// manifest and the migrations disagree, the manifest wins (it's the
// declared contract). Migrations are not parsed here because the manifest
// already pins every column the package writes; parsing CREATE TABLE out
// of MSSQL/Migration SQL is fiddly and easy to drift.
//
// System tables (users / audit / config / schema_migrations / orphan_schemas
// / installed_packages / etc.) have no expected — they're framework-owned
// and the operator sees only their actual layout.
//
// Output shape (per schema entry):
//   { name, source, expected, actual, diff, status }
//     source: "package:<name>/<version>" | "system"
//     expected: null | [{ table, columns: [{ name, type, nullable }] }]
//     actual:   [{ table, columns: [{ name, type, nullable }] }]
//     diff:     null | { missingTables, extraTables, missingColumns,
//                         extraColumns, typeMismatches, status }
//     status:   "in_sync" | "drift" | "system"

import fs from 'node:fs';
import path from 'node:path';

// JSON maps to nvarchar (MSSQL) / text (MySQL) /* etc */ by the SQL
// migration layer — the manifest's logical "json" type covers all of
// them. nvarchar ↔ varchar is also treated as equivalent because the
// manifest is dialect-agnostic (the migration is what adds the unicode
// qualifier). Extending here is the right place when a new logical
// type is added to the manifest schema contract.
const TYPE_EQUIV = {
  json: new Set(['json', 'nvarchar', 'varchar', 'text', 'longtext', 'ntext', 'char']),
  'varchar<->nvarchar': true
};

function typesEquivalent(actualType, expectedType) {
  const expected = String(expectedType || '').toLowerCase().trim();
  const actual = String(actualType || '').toLowerCase().trim();
  if (!expected) return true; // empty expected type → no constraint
  // Strip the (precision) suffix when comparing base types so the
  // varchar ↔ nvarchar equivalence handles the column_type form
  // ("varchar(64)" vs "nvarchar(64)") AND the bare data_type form.
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

function manifestToExpected(manifest) {
  const db = manifest.database || {};
  const tables = [];
  const metricSchema = db.metricSchema || {};
  if (db.metricTable) {
    const cols = Object.entries(metricSchema).map(([name, def]) => ({
      name,
      type: def?.type || 'unknown',
      nullable: def?.nullable !== false
    }));
    tables.push({ name: db.metricTable, columns: cols });
  }
  return { version: manifest.version || '?', tables };
}

function computeDiff(actualTables, expected) {
  const actualByTable = new Map(actualTables.map((t) => [t.name, t]));
  const expectedByTable = new Map((expected.tables || []).map((t) => [t.name, t]));

  const missingTables = [];
  const extraTables = [];
  const missingColumns = [];
  const extraColumns = [];
  const typeMismatches = [];

  for (const [name, t] of expectedByTable) {
    if (!actualByTable.has(name)) {
      missingTables.push({ name, columns: (t.columns || []).map((c) => c.name) });
    }
  }
  for (const name of actualByTable.keys()) {
    if (!expectedByTable.has(name)) extraTables.push(name);
  }
  for (const [name, expectedTable] of expectedByTable) {
    const actualTable = actualByTable.get(name);
    if (!actualTable) continue;
    const actualCols = new Map(actualTable.columns.map((c) => [c.name, c]));
    const expectedCols = new Map((expectedTable.columns || []).map((c) => [c.name, c]));
    for (const [colName, expectedCol] of expectedCols) {
      if (!actualCols.has(colName)) {
        missingColumns.push({ table: name, name: colName, expectedType: expectedCol.type });
      }
    }
    for (const [colName, actualCol] of actualCols) {
      if (!expectedCols.has(colName)) {
        extraColumns.push({ table: name, name: colName, actualType: actualCol.type });
      }
    }
    for (const [colName, expectedCol] of expectedCols) {
      const actualCol = actualCols.get(colName);
      if (!actualCol) continue;
      if (!typesEquivalent(actualCol.type, expectedCol.type)) {
        typeMismatches.push({
          table: name,
          name: colName,
          expectedType: expectedCol.type,
          actualType: actualCol.type
        });
      }
    }
  }

  const hasDiff =
    missingTables.length || extraTables.length || missingColumns.length ||
    extraColumns.length || typeMismatches.length;
  return {
    missingTables,
    extraTables,
    missingColumns,
    extraColumns,
    typeMismatches,
    status: hasDiff ? 'drift' : 'in_sync'
  };
}

async function readSchema(db, schemaName, dataDir) {
  const { rows: tables } = await db.execute(db.sql.schemaInventory.listTables, [schemaName]);
  const actualTables = [];
  for (const { table_name } of tables) {
    const { rows: cols } = await db.execute(
      db.sql.schemaInventory.listColumns,
      [schemaName, table_name]
    );
    actualTables.push({ name: table_name, columns: (cols || []).map(normalizeColumn) });
  }

  const pkgMatch = schemaName.match(/^pkg_(.+)$/);
  if (pkgMatch) {
    const pkgName = pkgMatch[1].replaceAll('_', '-');
    const expected = readExpectedFromDir(pkgName, dataDir);
    if (expected) {
      const diff = computeDiff(actualTables, expected);
      return {
        name: schemaName,
        source: `package:${pkgName}/${expected.version}`,
        expected: expected.tables,
        actual: actualTables,
        diff,
        status: diff.status
      };
    }
  }

  return {
    name: schemaName,
    source: 'system',
    expected: null,
    actual: actualTables,
    diff: null,
    status: 'system'
  };
}

function readExpectedFromDir(pkgName, dataDir) {
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
  versions.sort(); // semver-ish string sort works for "1.0.0" / "1.2.3"
  const latest = versions[versions.length - 1];
  const manifestPath = path.join(pkgDir, latest, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return manifestToExpected(manifest);
  } catch {
    return null;
  }
}

export async function getSchemaInventory(db, opts = {}) {
  const dataDir = opts.dataDir || path.join(process.cwd(), 'data', 'packages');
  const { rows: schemaRows } = await db.query(db.sql.schemaInventory.listSchemas);
  const out = [];
  for (const row of schemaRows || []) {
    const schemaName = row.schema_name ?? row.SCHEMA_NAME ?? row.name;
    if (!schemaName) continue;
    out.push(await readSchema(db, schemaName, dataDir));
  }
  return { schemas: out };
}

// Exported for tests — the diff helper is pure and the most logic-dense
// bit of the whole feature.
export const _test = { computeDiff, typesEquivalent, manifestToExpected, normalizeColumn };
