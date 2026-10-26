import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { splitSqlStatements } from '../init/schema-applier.js';
import { verifyMarkers, parseVerifyMarker } from '../init/verify-marker.js';
import { toMysqlDatetime } from '../utils/datetime.js';

// MySQL DATETIME columns reject ISO 8601 strings (`2026-08-20T09:40:18.985Z`);
// the schema_migrations.applied_at column is DATETIME on MySQL, so callers
// MUST pre-format per the convention documented in db/drivers/mysql.js line 9-15.
// MSSQL datetime2 accepts ISO natively, so dialect-aware:
function appliedAtForDialect(dialect) {
  return dialect === 'mysql' ? toMysqlDatetime(new Date()) : new Date().toISOString();
}

export class AlreadyAppliedError extends Error {
  constructor(version) { super(`migration ${version} already applied`); this.status = 409; }
}
export class NotFailedError extends Error {
  constructor(version) { super(`migration ${version} is not in failed state`); this.status = 409; }
}
export class MigrationFileMissingError extends Error {
  constructor(version) { super(`migration ${version} file not found`); this.status = 404; }
}
export class InvalidVersionError extends Error {
  constructor(version) { super(`invalid version: ${version}`); this.status = 400; }
}
// 2026-08-28 round-55: refresh-checksum only meaningful for applied rows.
// Pending/failed rows have a null/placeholder checksum that refresh would
// either invent or refuse — either way the operator's real intent is
// mark-applied or reset, not checksum refresh.
export class NotAppliedError extends Error {
  constructor(version) { super(`migration ${version} is not in applied state — use mark-applied or reset instead`); this.status = 409; }
}

// R158.42 (2026-10-03) — semver-aware version match.
// Accepts both legacy 3-digit zero-padded versions ('053') and semver
// ('1.0.0', '1.0.10', '2.1.0'). The constraint is "major.minor.patch"
// with optional minor/patch segments — handles both old and new in the
// same parseFileMeta + sort + compare path. Forward evolution uses semver
// going forward (1.0.0 baseline); legacy 053-era files were retired
// during rebase (R158.42) and only '009' + '1.0.0' remain.
const VERSION_RE = /^(\d{1,3})(\.\d+){0,2}$/;

function validateVersion(version) {
  if (!VERSION_RE.test(String(version || ''))) throw new InvalidVersionError(version);
}

// R158.42 — semver-aware compare. '1.0.10' > '1.0.2' (lexicographic
// would put it the other way). Also handles legacy '053' vs '1.0.0'
// (treats single-segment as [n, 0, 0]).
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] || 0;
    const bi = pb[i] || 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

function resolveFile(repoRoot, dialect, version) {
  const dir = dialect === 'mssql'
    ? join(repoRoot, 'db/migrations/mssql')
    : join(repoRoot, 'db/migrations/mysql');
  if (!existsSync(dir)) return null;
  const match = readdirSync(dir).find(f => f.startsWith(version + '-') && f.endsWith('.sql'));
  return match ? join(dir, match) : null;
}

// 2026-08-29 R66 — pair resolver. The migration applier now optionally
// invokes a sibling `<version>-*.js` file alongside the SQL when one is
// present (e.g. 023's data migration that needs fs reads + sha256
// computation + DROP-after-migrate, neither of which is expressible in
// raw SQL). Returns the absolute path of the .js file, or null when the
// migration has no JS step (the existing .sql-only path used by
// 001..022). Resolution mirrors `resolveFile` exactly — same dir,
// same `version-` prefix, .js extension.
function resolveJsFile(repoRoot, dialect, version) {
  const dir = dialect === 'mssql'
    ? join(repoRoot, 'db/migrations/mssql')
    : join(repoRoot, 'db/migrations/mysql');
  if (!existsSync(dir)) return null;
  const match = readdirSync(dir).find(f => f.startsWith(version + '-') && f.endsWith('.js'));
  return match ? join(dir, match) : null;
}

function parseFileMeta(filePath) {
  const fileName = filePath.split(/[/\\]/).pop();
  // R158.42 — semver-aware filename match. Accepts both legacy 3-digit
  // prefix ('053-foo.sql') and semver ('1.0.0-foo.sql' / '1.0.0.sql').
  const m = fileName.match(/^(\d{1,3}(?:\.\d+){0,2})(?:-([a-z0-9-]+))?\.sql$/i);
  return m ? { version: m[1], description: m[2] || null } : null;
}

function sha256(s) { return createHash('sha256').update(s).digest('hex'); }

function rowToCamel(r) {
  if (!r) return null;
  return {
    version: r.version,
    description: r.description,
    type: r.type,
    script: r.script,
    dialect: r.dialect ?? null,
    status: r.status,
    appliedAt: r.applied_at,
    appliedBy: r.applied_by,
    executionMs: r.execution_ms,
    checksum: r.checksum,
    checksumMismatch: false,
    scriptMissing: false,
    errorMessage: r.error_message
  };
}

export function createMigrationsService({ db, logger, getRepoRoot, writeAudit, getDataDir }) {
  async function listMigrations(dialect) {
    const repoRoot = getRepoRoot();
    const dir = dialect === 'mssql'
      ? join(repoRoot, 'db/migrations/mssql')
      : join(repoRoot, 'db/migrations/mysql');
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

    const { rows: dbRows } = await db.query(db.sql.schemaMigrations.list, []);
    const byVersion = new Map(dbRows.map(r => [r.version, r]));

    const out = [];
    for (const file of files) {
      const meta = parseFileMeta(file);
      if (!meta) continue;
      const fullPath = join(dir, file);
      const content = readFileSync(fullPath, 'utf8');
      const fileChecksum = sha256(content);
      const row = byVersion.get(meta.version);
      const entry = {
        version: meta.version,
        description: meta.description,
        type: 'sql',
        script: file,
        dialect,
        status: row ? row.status : 'pending',
        appliedAt: row?.applied_at ?? null,
        appliedBy: row?.applied_by ?? null,
        executionMs: row?.execution_ms ?? null,
        checksum: row?.checksum ?? null,
        checksumMismatch: row ? row.checksum !== fileChecksum : false,
        scriptMissing: false,
        errorMessage: row?.error_message ?? null
      };
      out.push(entry);
    }

    // Rows in DB but no file on disk → orphan rows
    const fileVersions = new Set(out.map(o => o.version));
    for (const r of dbRows) {
      if (!fileVersions.has(r.version)) {
        out.push({ ...rowToCamel(r), dialect, scriptMissing: true });
      }
    }
    // R158.42 — semver-aware sort (was localeCompare — wrong for '1.0.10' < '1.0.2').
    out.sort((a, b) => compareVersions(a.version, b.version));
    return out;
  }

  async function applyMigration(version, { appliedBy }) {
    validateVersion(version);
    const repoRoot = getRepoRoot();
    const filePath = resolveFile(repoRoot, db.dialect, version);
    if (!filePath) throw new MigrationFileMissingError(version);
    const jsFilePath = resolveJsFile(repoRoot, db.dialect, version);
    const content = readFileSync(filePath, 'utf8');
    const meta = parseFileMeta(filePath);
    const fileName = filePath.split(/[/\\]/).pop();
    const checksum = sha256(content);

    // Pre-check: is it already applied?
    const { rows: existingRows } = await db.query(db.sql.schemaMigrations.findByVersion, [version]);
    const existing = existingRows[0];
    if (existing && existing.status === 'applied') throw new AlreadyAppliedError(version);

    const stmts = splitSqlStatements(content);
    const t0 = Date.now();
    let status, errorMessage;
    let jsRan = false;
    try {
      await db.transaction(async (tx) => {
        for (const s of stmts) {
          await tx.execute(s, []);
        }
      });
      // 2026-08-29 R66 — JS data-migration step. Only runs when a sibling
      // `<version>-*.js` exists alongside the SQL (e.g. migration 023
      // splits installed_packages into package_scripts +
      // package_policies). The .sql tx already committed; if the JS step
      // fails we still record the migration as 'failed' so the operator
      // can retry (the SQL files start with DROP TABLE IF EXISTS, so a
      // retry cleanly re-creates the new tables and re-runs the data
      // migration). `jsRan` flips the schema_migrations.type column from
      // 'sql' to 'sql+js' so the admin UI surfaces the migration as
      // having both steps.
      if (jsFilePath) {
        try {
          const jsUrl = pathToFileURL(jsFilePath).href;
          const mod = await import(jsUrl);
          const fn = mod.migrateInstalledPackagesToTwoTable ?? mod.default;
          if (typeof fn !== 'function') {
            throw new Error(`migration ${version} JS helper did not export migrateInstalledPackagesToTwoTable`);
          }
          const dataDir = (getDataDir ? getDataDir() : null) || `${process.cwd()}/data/packages`;
          await fn({ db, dataDir, writeAudit });
          jsRan = true;
        } catch (jsErr) {
          logger.warn({ err: jsErr.message, version }, 'migration JS step failed');
          status = 'failed';
          errorMessage = `js: ${jsErr.message}`;
          // Don't fall through to status='applied' — surface as failed so
          // the operator can retry. SQL changes are NOT rolled back (the
          // tx already committed); retry re-runs DROP+CREATE + the data
          // migration.
        }
      }
      if (!status) status = 'applied';
      if (errorMessage == null) errorMessage = null;
    } catch (e) {
      logger.warn({ err: e.message, version }, 'migration apply failed');
      status = 'failed';
      errorMessage = (e && e.message) || String(e);
    }
    const executionMs = Date.now() - t0;

    // Upsert OUTSIDE transaction
    const appliedAtIso = appliedAtForDialect(db.dialect);
    await db.execute(db.sql.schemaMigrations.upsert, [
      version,
      meta.description,
      jsRan ? 'sql+js' : 'sql',
      fileName,                              // script = filename, NOT description
      checksum,
      appliedAtIso,
      executionMs,
      appliedBy || 'system',
      status,
      errorMessage
    ]);
    return { ok: status === 'applied', version, status, executionMs, errorMessage };
  }

  async function dryRunMigration(version) {
    validateVersion(version);
    const repoRoot = getRepoRoot();
    const filePath = resolveFile(repoRoot, db.dialect, version);
    if (!filePath) throw new MigrationFileMissingError(version);
    const content = readFileSync(filePath, 'utf8');
    const stmts = splitSqlStatements(content);
    return { version, statements: stmts.map((s, i) => ({ ordinal: i + 1, sql: s })) };
  }

  async function resetFailedMigration(version) {
    validateVersion(version);
    const { affectedRows } = await db.execute(db.sql.schemaMigrations.deleteFailed, [version]);
    if (!affectedRows) throw new NotFailedError(version);
    return { ok: true, deleted: affectedRows };
  }

  // 2026-08-28 round-55: refresh stored SHA-256 to match the current file
  // on disk. Used when a migration was applied but the file was later
  // edited cosmetically (verify-marker comments, dialect-compat rewrite
  // with identical schema output, etc.) — SchemaMigrationsView flags such
  // rows with ⚠️ "File edited after apply". This endpoint silences the
  // warning WITHOUT re-running SQL: status, applied_at, applied_by,
  // execution_ms, error_message are all preserved. Only `checksum` is
  // updated to the live file SHA-256.
  //
  // Guards:
  //   - file missing on disk → MigrationFileMissingError (404)
  //   - row not in applied state → NotAppliedError (409) — operator's
  //     real intent for pending/failed rows is mark-applied or reset,
  //     not silent checksum refresh.
  async function refreshChecksum(version) {
    validateVersion(version);
    const repoRoot = getRepoRoot();
    const filePath = resolveFile(repoRoot, db.dialect, version);
    if (!filePath) throw new MigrationFileMissingError(version);
    const content = readFileSync(filePath, 'utf8');
    const fileChecksum = sha256(content);

    // Pre-check: refuse if not applied. The UPDATE's own WHERE clause
    // would silently skip non-applied rows; surfacing the error here
    // gives the operator a clear 409 with an actionable hint.
    const { rows: existingRows } = await db.query(db.sql.schemaMigrations.findByVersion, [version]);
    const existing = existingRows[0];
    if (!existing || existing.status !== 'applied') throw new NotAppliedError(version);

    await db.execute(db.sql.schemaMigrations.updateChecksum, [fileChecksum, version]);
    return { ok: true, version, checksum: fileChecksum };
  }

  async function markApplied(version, { appliedBy }) {
    validateVersion(version);
    const repoRoot = getRepoRoot();
    const filePath = resolveFile(repoRoot, db.dialect, version);
    if (!filePath) throw new MigrationFileMissingError(version);
    const content = readFileSync(filePath, 'utf8');
    const meta = parseFileMeta(filePath);
    const fileName = filePath.split(/[/\\]/).pop();
    const checksum = sha256(content);
    const appliedAtIso = appliedAtForDialect(db.dialect);
    await db.execute(db.sql.schemaMigrations.upsert, [
      version, meta.description, 'sql', fileName, checksum,
      appliedAtIso, 0, appliedBy || 'system', 'applied', null
    ]);
    return { ok: true, version, status: 'applied', executionMs: 0 };
  }

  async function baseline(version, { appliedBy }) {
    validateVersion(version);
    const repoRoot = getRepoRoot();
    const dir = db.dialect === 'mssql'
      ? join(repoRoot, 'db/migrations/mssql')
      : join(repoRoot, 'db/migrations/mysql');
    if (!existsSync(dir)) throw new MigrationFileMissingError(version);
    const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    const versions = [];
    const skipped = [];
    const appliedAtIso = appliedAtForDialect(db.dialect);
    for (const f of files) {
      const m = f.match(/^(\d{1,3}(?:\.\d+){0,2})(?:-([a-z0-9-]+))?\.sql$/i);
      if (!m) continue;
      if (compareVersions(m[1], version) > 0) continue;
      const filePath = join(dir, f);
      const content = readFileSync(filePath, 'utf8');
      const markers = parseVerifyMarker(content);
      if (markers.length > 0) {
        const { ok, missing } = await verifyMarkers(db, markers);
        if (!ok) {
          skipped.push({ version: m[1], missing });
          continue;
        }
      }
      const checksum = sha256(content);
      await db.execute(db.sql.schemaMigrations.upsert, [
        m[1], m[2], 'sql', f, checksum,
        appliedAtIso, 0, appliedBy || 'system', 'applied', null
      ]);
      versions.push(m[1]);
    }
    return { ok: true, versions, skipped };
  }

  async function applyUpTo(version, { appliedBy }) {
    validateVersion(version);
    const repoRoot = getRepoRoot();
    const dir = db.dialect === 'mssql'
      ? join(repoRoot, 'db/migrations/mssql')
      : join(repoRoot, 'db/migrations/mysql');
    if (!existsSync(dir)) throw new MigrationFileMissingError(version);
    const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    const applied = [];
    const failed = [];
    for (const f of files) {
      const m = f.match(/^(\d{1,3}(?:\.\d+){0,2})(?:-([a-z0-9-]+))?\.sql$/i);
      if (!m) continue;
      if (compareVersions(m[1], version) > 0) break;
      try {
        const r = await applyMigration(m[1], { appliedBy });
        applied.push({ version: r.version, status: r.status, executionMs: r.executionMs });
        if (r.status === 'failed') failed.push({ version: r.version, errorMessage: r.errorMessage });
      } catch (e) {
        failed.push({ version: m[1], errorMessage: e.message });
      }
    }
    return { ok: failed.length === 0, applied, failed };
  }

  // R158.51 (2026-10-08) — baseline freeze.
  //
  // Schema is now a single 1.0.0-baseline.sql (plus optional 1.0.0-baseline.js
  // sidecar) per dialect. No more incremental migrations. Seed data is
  // folded INTO the baseline via INSERT IGNORE / IF NOT EXISTS guards, so
  // the seed-tracking branch + db.schema_seed.checksum are removed.
  //
  // The function still walks the migrations dir to pick up future
  // 1.0.x-baseline.sql versions (semver-aware compare against existing
  // schema_migrations row); only 1.0.0 exists today, but the iteration
  // shape is preserved so future operator adds don't need code changes.
  async function upgrade({ appliedBy }) {
    const repoRoot = getRepoRoot();
    const migrationsDir = db.dialect === 'mssql'
      ? join(repoRoot, 'db/migrations/mssql')
      : join(repoRoot, 'db/migrations/mysql');
    const allFiles = existsSync(migrationsDir)
      ? readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()
      : [];
    const applied = [];
    const failed = [];
    // R158.X.116-fix (2026-10-23) — "已应用过" 是正常语义, 不是失败。
    //   applyMigration 对已 applied 的版本抛 AlreadyAppliedError (那是 REST
    //   端点上要映射成 409 的正确语义), 但这里的 catch-all 把它当失败吞进
    //   failed[] —— 于是每次启动都报 "升级部分失败: 1 baseline 失败",
    //   ok=false。baseline 其实早就应用好了, 这是纯粹的误报, 而且它在
    //   server.js 的启动日志里长期被上一行的 TypeError 挡着看不见。
    const skipped = [];
    for (const f of allFiles) {
      const m = f.match(/^(\d{1,3}(?:\.\d+){0,2})(?:-([a-z0-9-]+))?\.sql$/i);
      if (!m) continue;
      try {
        const r = await applyMigration(m[1], { appliedBy });
        if (r.status === 'failed') {
          failed.push({ version: r.version, errorMessage: r.errorMessage });
        } else if (r.status === 'applied') {
          applied.push({ version: r.version, executionMs: r.executionMs });
        }
      } catch (e) {
        if (e instanceof AlreadyAppliedError) {
          skipped.push({ version: m[1], reason: 'already applied' });
        } else {
          failed.push({ version: m[1], errorMessage: e.message });
        }
      }
    }
    const ok = failed.length === 0;
    const message = ok
      ? (applied.length === 0
          ? '升级完成: 已是最新基线'
          : `升级完成: ${applied.length} baseline 应用`)
      : `升级部分失败: ${failed.length} baseline 失败`;
    return { ok, migrations: { applied, failed, skipped }, message };
  }

  return { listMigrations, applyMigration, dryRunMigration, resetFailedMigration, refreshChecksum, markApplied, baseline, applyUpTo, upgrade };
}