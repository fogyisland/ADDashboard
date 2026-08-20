import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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

const VERSION_RE = /^\d{3}$/;

function validateVersion(version) {
  if (!VERSION_RE.test(String(version || ''))) throw new InvalidVersionError(version);
}

function resolveFile(repoRoot, dialect, version) {
  const dir = dialect === 'mssql'
    ? join(repoRoot, 'db/migrations/mssql')
    : join(repoRoot, 'db/migrations');
  if (!existsSync(dir)) return null;
  const match = readdirSync(dir).find(f => f.startsWith(version + '-') && f.endsWith('.sql'));
  return match ? join(dir, match) : null;
}

function parseFileMeta(filePath) {
  const fileName = filePath.split(/[/\\]/).pop();
  const m = fileName.match(/^(\d{3})-([a-z0-9-]+)\.sql$/);
  return m ? { version: m[1], description: m[2] } : null;
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

export function createMigrationsService({ db, logger, getRepoRoot }) {
  async function listMigrations(dialect) {
    const repoRoot = getRepoRoot();
    const dir = dialect === 'mssql'
      ? join(repoRoot, 'db/migrations/mssql')
      : join(repoRoot, 'db/migrations');
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
    out.sort((a, b) => a.version.localeCompare(b.version));
    return out;
  }

  async function applyMigration(version, { appliedBy }) {
    validateVersion(version);
    const repoRoot = getRepoRoot();
    const filePath = resolveFile(repoRoot, db.dialect, version);
    if (!filePath) throw new MigrationFileMissingError(version);
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
    try {
      await db.transaction(async (tx) => {
        for (const s of stmts) {
          await tx.execute(s, []);
        }
      });
      status = 'applied';
      errorMessage = null;
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
      'sql',
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
      : join(repoRoot, 'db/migrations');
    if (!existsSync(dir)) throw new MigrationFileMissingError(version);
    const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    const versions = [];
    const skipped = [];
    const appliedAtIso = appliedAtForDialect(db.dialect);
    for (const f of files) {
      const m = f.match(/^(\d{3})-([a-z0-9-]+)\.sql$/);
      if (!m) continue;
      if (m[1] > version) continue;
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
      : join(repoRoot, 'db/migrations');
    if (!existsSync(dir)) throw new MigrationFileMissingError(version);
    const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    const applied = [];
    const failed = [];
    for (const f of files) {
      const m = f.match(/^(\d{3})-([a-z0-9-]+)\.sql$/);
      if (!m) continue;
      if (m[1] > version) break;
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

  async function upgrade({ appliedBy }) {
    const repoRoot = getRepoRoot();
    const seedPath = db.dialect === 'mssql'
      ? join(repoRoot, 'db/schema/mssql/02-seed-roles.sql')
      : join(repoRoot, 'db/schema/02-seed-roles.sql');
    let seedChecksum = null;
    let seedContent = null;
    if (existsSync(seedPath)) {
      seedContent = readFileSync(seedPath, 'utf8');
      seedChecksum = sha256(seedContent);
    }

    // Apply all pending migrations sequentially
    const migrationsDir = db.dialect === 'mssql'
      ? join(repoRoot, 'db/migrations/mssql')
      : join(repoRoot, 'db/migrations');
    const allFiles = existsSync(migrationsDir)
      ? readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()
      : [];
    const applied = [];
    const failed = [];
    for (const f of allFiles) {
      const m = f.match(/^(\d{3})-([a-z0-9-]+)\.sql$/);
      if (!m) continue;
      try {
        const r = await applyMigration(m[1], { appliedBy });
        if (r.status === 'failed') {
          failed.push({ version: r.version, errorMessage: r.errorMessage });
        } else if (r.status === 'applied') {
          applied.push({ version: r.version, executionMs: r.executionMs });
        }
      } catch (e) {
        failed.push({ version: m[1], errorMessage: e.message });
      }
    }

    // Check seed — first-run applies, changed re-applies, unchanged skips.
    // Failure does NOT roll back migrations; caller decides retry.
    const seedResult = { ran: false, reason: 'no-seed-file' };
    if (seedChecksum) {
      const { rows: cfgRows } = await db.query(db.sql.systemConfig.getByKey, ['db.schema_seed.checksum']);
      const stored = cfgRows[0]?.config_value;
      if (!stored) {
        // First run
        try {
          const stmts = splitSqlStatements(seedContent);
          for (const s of stmts) await db.execute(s, []);
          await db.execute(db.sql.systemConfig.upsertByKey, ['db.schema_seed.checksum', seedChecksum]);
          seedResult.ran = true;
          seedResult.reason = 'first-run';
        } catch (e) {
          seedResult.reason = 'failed';
          seedResult.errorMessage = e.message;
        }
      } else if (stored !== seedChecksum) {
        // Changed — re-apply
        try {
          const stmts = splitSqlStatements(seedContent);
          for (const s of stmts) await db.execute(s, []);
          await db.execute(db.sql.systemConfig.upsertByKey, ['db.schema_seed.checksum', seedChecksum]);
          seedResult.ran = true;
          seedResult.reason = 'changed';
        } catch (e) {
          seedResult.reason = 'failed';
          seedResult.errorMessage = e.message;
        }
      } else {
        seedResult.reason = 'unchanged';
      }
    }

    const ok = failed.length === 0 && seedResult.reason !== 'failed';
    const message = ok
      ? `升级完成: ${applied.length} migration 应用, seed ${seedResult.reason}`
      : `升级部分失败: ${failed.length} migration 失败${seedResult.reason === 'failed' ? ', seed 失败' : ''}`;
    return { ok, migrations: { applied, failed }, seed: seedResult, message };
  }

  return { listMigrations, applyMigration, dryRunMigration, resetFailedMigration, markApplied, baseline, applyUpTo, upgrade };
}