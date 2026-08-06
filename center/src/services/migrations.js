import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { splitSqlStatements } from '../init/schema-applier.js';

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
    const appliedAtIso = new Date().toISOString();
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

  return { listMigrations, applyMigration, dryRunMigration, resetFailedMigration };
}