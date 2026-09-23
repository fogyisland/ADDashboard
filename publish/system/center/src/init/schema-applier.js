// Splits a SQL string into individual statements. Splits on ; followed by
// a newline (or end of string). Ignores ; inside 'string' and "string"
// literals (with simple doubled-quote escape handling), and inside
// MSSQL-style IF...BEGIN...END blocks (tracks BEGIN depth).

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseVerifyMarker, verifyMarkers } from './verify-marker.js';
import { toMysqlDatetime } from '../utils/datetime.js';

export function splitSqlStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let blockDepth = 0; // tracks BEGIN...END nesting (MSSQL blocks)
  let currentDelim = ';'; // MySQL DELIMITER directive support
  while (i < sql.length) {
    const c = sql[i];

    // MySQL DELIMITER directive (start of line: buf is empty OR buf ends with \n).
    // Comments are skipped over by allowing whitespace-only content; but in
    // practice the directive typically appears on its own line.
    if (c === 'D' && (buf === '' || buf.endsWith('\n')) && /^\s*DELIMITER\s+(\S+)/.test(sql.slice(i))) {
      const m = /^\s*DELIMITER\s+(\S+)/.exec(sql.slice(i));
      currentDelim = m[1];
      buf = '';
      // Skip to end of line
      const nl = sql.indexOf('\n', i);
      i = nl >= 0 ? nl + 1 : sql.length;
      continue;
    }

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
    // Line comment (-- to end of line): skip so an apostrophe in a comment
    // (e.g. "wasn't") can't be mistaken for a string-literal open quote.
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl >= 0 ? nl : sql.length;
      continue;
    }
    // Block comment (/* ... */): skip entirely.
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end >= 0 ? end + 2 : sql.length;
      continue;
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
    // Statement terminator: matches the current delimiter (default ';').
    // Single-char delimiter (e.g. ';'): at top level (blockDepth=0, not in
    // string/comment), `;` is ALWAYS a terminator regardless of what
    // character follows. Previously this branch only split when the next
    // char was \n / \r / another terminator / EOF — that over-restrictive
    // check caused `PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE
    // stmt;` (inline multi-statement chains) to be bundled into one
    // mega-statement, which MySQL then rejected with a syntax error
    // (round-50 migration 021 failure). The line comment and string-literal
    // branches above this point already prevent us from mis-splitting
    // inside `--` comments or `'...'` literals, so no extra guard is needed.
    if (currentDelim.length === 1 && c === currentDelim[0] && blockDepth === 0) {
      const stmt = buf.trim();
      if (stmt.length > 0) out.push(stmt);
      buf = '';
      i++;
      continue;
    }
    // Multi-char delimiter (e.g. '$$'): split on exact match. Same logic as
    // the single-char case — at top level, the delimiter is always terminal.
    // (MySQL DELIMITER is only legal at the top level anyway.)
    if (currentDelim.length > 1 && c === currentDelim[0] && blockDepth === 0 &&
        sql.slice(i, i + currentDelim.length) === currentDelim) {
      const stmt = buf.trim();
      if (stmt.length > 0) out.push(stmt);
      buf = '';
      i += currentDelim.length;
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

// Find the repo root at runtime. An explicit caller-pinned path (opts.repoRoot)
// always wins — tests use it to point at a fixture, prod config can pin a
// non-standard layout. The candidate fallback only runs when no path is given:
// the install script copies db/ to <InstallPath>/../db/ so cwd/.. works for the
// default layout, but older installs (pre-db-copy-fix) or operators who keep
// db/ at the publish-root only land at cwd/../.. or cwd itself.
//
//   1. opts.repoRoot (caller-provided — used verbatim, NOT validated against
//      the candidate list; honoring the caller's pin is the whole point)
//   2. ADDASHBOARD_REPO_ROOT env var (set on the NSSM service for non-standard
//      layouts without re-running install)
//   3. cwd/.. (default install layout — <InstallPath>/.. = <parent>)
//   4. cwd/../.. (InPlace layout — <publish-root>/center/../.. = <publish-root>)
//   5. cwd itself (db/ co-located with install dir, rare)
// Each fallback candidate is only accepted if it actually contains a db/
// subdir; otherwise we keep looking. Falling back to cwd/.. at the end
// preserves the legacy default so the ENOENT surfaces where to look.
function resolveRepoRoot(opts) {
  if (opts.repoRoot) return opts.repoRoot;
  const cwd = process.cwd();
  const candidates = [
    process.env.ADDASHBOARD_REPO_ROOT,
    join(cwd, '..'),
    join(cwd, '..', '..'),
    cwd,
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(join(c, 'db'))) return c;
  }
  return join(cwd, '..');
}

export async function applyAll(dialect, db, opts = {}) {
  const repoRoot = resolveRepoRoot(opts);

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

  // Fresh-install path: skip migrations/. db/migrations/* is for the upgrade
  // path only — the running service applies the gap via
  // migrationService.upgrade() during normal startup (server.js line 257).
  // A brand-new schema from 01-tables.sql already carries every column,
  // index, and table that the cumulative migrations introduced; backfilling
  // schema_migrations without executing the files is the right behavior
  // (backfillMigrations marks them applied_by='system-init', execution_ms=0).
  // Returning `applied.migrations = []` here is intentional — keep the
  // shape so existing callers / response payloads stay stable.

  return applied;
}

function sha256(s) { return createHash('sha256').update(s).digest('hex'); }

// Resolve the JS helper path for a given migration version, mirroring the
// shape of `resolveFile`/`resolveJsFile` in services/migrations.js. Returns
// the absolute path of the version-matched .js sibling, or null when the
// migration has no JS step. Used by the backfill path below to invoke the
// R66-style data migration that needs fs reads + sha256 (not expressible
// in raw SQL).
function resolveMigrationJsFile(dir, version) {
  const entries = readdirSync(dir);
  const match = entries.find(f => f.startsWith(version + '-') && f.endsWith('.js'));
  return match ? join(dir, match) : null;
}

// Record every migration file on disk as already-applied. Used by two paths:
//   1. the init wizard, right after applyAll() ran every file for real;
//   2. bootstrapMigrations(), when an existing deployment first gains the
//      schema_migrations table and its pre-009 history has to be reconstructed.
// Both cases mean "these files are already in the DB", hence applied_by
// 'system-init' and execution_ms 0 — we did not time the original run.
// Idempotent: the upsert keys on `version`, so re-running is a no-op update.
//
// DB H4 (2026-09-22): a .js sibling of a SQL migration (e.g. R66's
// `023-package-scripts-policies-split.js`) is also a "migration" and must
// be recorded. Previously the readdirSync filter at line 208 (now below)
// only matched .sql files, so on a fresh install `023-*.js` was never
// recorded and the admin Schema Migrations page kept listing it as pending
// even though 01-tables.sql already created `package_scripts` +
// `package_policies`. The fix is to include .js files in the same loop;
// the .js branch dynamically imports the module, invokes the exported
// `migrateInstalledPackagesToTwoTable({db, dataDir, writeAudit})` helper
// (safe on a fresh DB — the helper short-circuits when `installed_packages`
// has 0 rows), and upserts the row with `type='js'`.
//
// .js files have no verify markers (verify markers are an SQL-only
// concept), so the marker probe is skipped. The .sql sibling is the
// authority for "is the schema present?" — if its markers fail the probe,
// the .js record is also skipped to keep the row pair consistent.
export async function backfillMigrations(dialect, db, opts = {}) {
  const repoRoot = resolveRepoRoot(opts);
  const dir = resolveMigrationsDir(repoRoot, dialect);
  if (!existsSync(dir)) return { count: 0, skipped: [] };
  // SQL files must be iterated BEFORE their .js siblings so the
  // skipped-versions set is populated in time for the lockstep gate
  // below (see comment before the loop). The natural lex sort would put
  // `…023-foo.js` ahead of `…023-foo.sql` because `j` < `s`, so we
  // partition by extension first.
  const allFiles = readdirSync(dir)
    .filter(f => f.endsWith('.sql') || f.endsWith('.js'));
  const sqlFiles = allFiles.filter(f => f.endsWith('.sql')).sort();
  const jsFiles = allFiles.filter(f => f.endsWith('.js')).sort();
  const files = [...sqlFiles, ...jsFiles];
  // MySQL DATETIME rejects ISO 8601 strings; the schema_migrations.applied_at
  // column is DATETIME on MySQL. Pre-format per the convention in db/drivers/mysql.js.
  const appliedAt = dialect === 'mysql' ? toMysqlDatetime(new Date()) : new Date().toISOString();
  const logger = opts.logger ?? console;
  const getDataDir = opts.getDataDir ?? null;
  const writeAudit = opts.writeAudit ?? null;
  let count = 0;
  const skipped = [];
  // Track which versions had their .sql migration skipped because its
  // verify markers failed. The corresponding .js sibling must share that
  // fate: if the schema was never created by the SQL, the data migration
  // couldn't have run either. Without this gate, the .js row would claim
  // `applied` against a DB that's missing the underlying tables.
  //
  // Pre-scan all .sql files FIRST (filename-sorted) so the skipped-version
  // set is fully populated before any .js file is considered. The natural
  // lex sort puts `…023-foo.js` ahead of `…023-foo.sql` because `j` < `s`,
  // so a single-pass approach that just relies on iteration order would
  // let the .js row slip through. The two-pass split above (SQL before JS)
  // keeps the contract honest.
  const skippedVersions = new Set();
  for (const f of files) {
    const isSql = f.endsWith('.sql');
    const re = isSql
      ? /^(\d{3})-([a-z0-9-]+)\.sql$/
      : /^(\d{3})-([a-z0-9-]+)\.js$/;
    const m = f.match(re);
    if (!m) continue;
    const version = m[1];
    const description = m[2];
    const filePath = join(dir, f);
    const content = readFileSync(filePath, 'utf8');

    // Lockstep gate — if the SQL sibling for this version was already
    // skipped on a prior iteration (sort order is filename-based and JS
    // sorts after its SQL sibling, but earlier files may have other
    // .sql markers that put this version on the skip list), propagate.
    // Prevents a half-applied row pair where the JS says "applied" but
    // the schema (created by the SQL) is absent.
    if (!isSql && skippedVersions.has(version)) {
      skipped.push({
        file: f,
        version,
        missing: [`js: sql sibling ${version} verify markers failed — skipping js to keep row pair consistent`]
      });
      continue;
    }

    if (isSql) {
      // If the SQL file declares verify markers, probe the DB — only backfill
      // the row when every marker is present. A missing marker means the
      // migration was never actually applied to this DB; warn + skip so the
      // admin /api/admin/migrations list surfaces it as pending.
      const markers = parseVerifyMarker(content);
      if (markers.length > 0) {
        const { ok, missing } = await verifyMarkers(db, markers);
        if (!ok) {
          logger.warn?.({ file: f, version, missing }, 'verify markers missing — skipping backfill');
          skipped.push({ file: f, version, missing });
          skippedVersions.add(version);
          continue;
        }
      }
    }

    // For .js siblings, actually run the helper on a fresh install so that:
    //   - on a *fresh* DB the helper is a no-op (installed_packages has 0
    //     rows → early return), but we still record the migration;
    //   - on an *upgrade-path* backfill (older deployments whose
    //     schema_migrations table is being reconstructed), the helper
    //     performs the data migration into the just-created
    //     package_scripts + package_policies tables.
    //
    // Both cases end in a single upsert with `type='js'`; the helper
    // itself is idempotent (early-return on 0 rows, FK probe before drop).
    if (!isSql) {
      try {
        const jsUrl = pathToFileURL(filePath).href;
        const mod = await import(jsUrl);
        const fn = mod.migrateInstalledPackagesToTwoTable ?? mod.default;
        if (typeof fn !== 'function') {
          throw new Error(`migration ${version} JS helper did not export migrateInstalledPackagesToTwoTable`);
        }
        const dataDir = (getDataDir ? getDataDir() : null) || `${process.cwd()}/data/packages`;
        await fn({ db, dataDir, writeAudit });
      } catch (jsErr) {
        logger.warn?.({ err: jsErr.message, version, file: f }, 'migration JS helper failed during backfill — skipping');
        skipped.push({ file: f, version, missing: [`js: ${jsErr.message}`] });
        continue;
      }
    }

    const checksum = sha256(content);
    const type = isSql ? 'sql' : 'js';
    // Param order matches the upsert column list in db/sql.js:
    // (version, description, type, script, checksum, applied_at,
    //  execution_ms, applied_by, status, error_message)
    await db.execute(db.sql.schemaMigrations.upsert, [
      version, description, type, f, checksum,
      appliedAt, 0, 'system-init', 'applied', null
    ]);
    count++;
  }
  return { count, skipped };
}

// Probe SQL for "does schema_migrations exist?". MSSQL has no LIMIT clause,
// so the two dialects need different shapes.
function existsProbeSql(dialect) {
  return dialect === 'mssql'
    ? 'SELECT TOP 1 1 AS ok FROM schema_migrations'
    : 'SELECT 1 AS ok FROM schema_migrations LIMIT 1';
}

// Ensure schema_migrations exists and reflects the migrations already on disk.
// Called from db.init() on every server start, so it must be cheap and
// idempotent:
//   - table present (the common case, incl. fresh init-wizard installs where
//     applyAll already ran 009) -> one SELECT, then return;
//   - table absent (a deployment upgrading from pre-009 code) -> apply the 009
//     file, then backfill 001-008 as applied.
export async function bootstrapMigrations(dialect, db, opts = {}) {
  try {
    await db.query(existsProbeSql(dialect), []);
    return; // table exists; nothing to bootstrap
  } catch {
    // Table doesn't exist — fall through to create + backfill.
  }
  const repoRoot = resolveRepoRoot(opts);
  const migrationFile = resolveSqlPath(repoRoot, 'migrations', dialect, '009-schema-migrations.sql');
  // A deployment can legitimately ship without db/migrations (runtime-only
  // bundles). Nothing to bootstrap from, so leave the DB untouched.
  if (!existsSync(migrationFile)) return;
  await applyFile(db, migrationFile); // idempotent: CREATE TABLE IF NOT EXISTS / IF OBJECT_ID guard
  // DB H4 (2026-09-22): forward getDataDir + writeAudit so the backfill
  // loop can invoke .js migration helpers (e.g. R66's 023 data
  // migration). On a pre-009 upgrade the helper performs the real data
  // move from installed_packages into package_scripts + package_policies.
  await backfillMigrations(dialect, db, {
    repoRoot,
    getDataDir: opts.getDataDir ?? null,
    writeAudit: opts.writeAudit ?? null
  });
}
