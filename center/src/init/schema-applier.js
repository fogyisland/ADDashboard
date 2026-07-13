// Splits a SQL string into individual statements. Splits on ; followed by
// a newline (or end of string). Ignores ; inside 'string' and "string"
// literals (with simple doubled-quote escape handling), and inside
// MSSQL-style IF...BEGIN...END blocks (tracks BEGIN depth).

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function splitSqlStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let blockDepth = 0; // tracks BEGIN...END nesting (MSSQL blocks)
  while (i < sql.length) {
    const c = sql[i];
    if (inSingle) {
      buf += c;
      if (c === "'" && sql[i + 1] === "'") { buf += sql[i + 1]; i += 2; continue; }
      if (c === "'") inSingle = false;
      i++; continue;
    }
    if (inDouble) {
      buf += c;
      if (c === '"' && sql[i + 1] === '"') { buf += sql[i + 1]; i += 2; continue; }
      if (c === '"') inDouble = false;
      i++; continue;
    }
    if (c === "'") { inSingle = true; buf += c; i++; continue; }
    if (c === '"') { inDouble = true; buf += c; i++; continue; }
    // Track BEGIN/END blocks (word-boundary matched)
    if (c === 'B' && /BEGIN\b/.test(sql.slice(i, i + 5))) {
      blockDepth++; buf += sql.slice(i, i + 5); i += 5; continue;
    }
    if (c === 'E' && /END\b/.test(sql.slice(i, i + 3))) {
      if (blockDepth > 0) blockDepth--; buf += sql.slice(i, i + 3); i += 3; continue;
    }
    // Only treat ; as a statement terminator when we're not inside a BEGIN/END
    // block and the next char is \n, \r, another ;, or end-of-string.
    if (c === ';' && blockDepth === 0 &&
        (i + 1 >= sql.length || sql[i + 1] === '\n' || sql[i + 1] === '\r' || sql[i + 1] === ';')) {
      const stmt = buf.trim();
      if (stmt.length > 0) out.push(stmt);
      buf = '';
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  const tail = buf.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

async function applyFile(db, filePath) {
  const sql = readFileSync(filePath, 'utf8');
  const stmts = splitSqlStatements(sql);
  for (const s of stmts) {
    await db.execute(s, []);
  }
  return stmts;
}

// Resolve a SQL file path: prefer db/{kind}/{dialect}/<name>, fall back to
// db/{kind}/<name>. The repo layout puts MySQL files at the top level and
// MSSQL files under a dialect subdirectory, so this lets both work.
function resolveSqlPath(repoRoot, kind, dialect, name) {
  const dialectPath = join(repoRoot, 'db', kind, dialect, name);
  if (existsSync(dialectPath)) return dialectPath;
  return join(repoRoot, 'db', kind, name);
}

function resolveMigrationsDir(repoRoot, dialect) {
  const dialectDir = join(repoRoot, 'db', 'migrations', dialect);
  if (existsSync(dialectDir)) return dialectDir;
  return join(repoRoot, 'db', 'migrations');
}

export async function applyAll(dialect, db, opts = {}) {
  const repoRoot = opts.repoRoot ?? join(process.cwd(), '..');

  const applied = { schema: [], seed: [], migrations: [] };

  if (opts.createDatabase && dialect === 'mysql') {
    // Caller should have provided db name in opts.databaseName
    const dbName = opts.databaseName;
    if (dbName) {
      await db.execute(
        `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        []
      );
    }
  }

  applied.schema = await applyFile(db, resolveSqlPath(repoRoot, 'schema', dialect, '01-tables.sql'));
  applied.seed = await applyFile(db, resolveSqlPath(repoRoot, 'schema', dialect, '02-seed-roles.sql'));

  // Apply migrations if directory exists
  try {
    const migrationsDir = resolveMigrationsDir(repoRoot, dialect);
    const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
    for (const f of files) {
      await applyFile(db, join(migrationsDir, f));
      applied.migrations.push(f);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  return applied;
}
