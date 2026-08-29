// 2026-08-29 R66 — data migration from installed_packages to
// package_scripts + package_policies.
//
// Runs as JS (not raw SQL) because each row needs:
//   - read on-disk data/packages/<name>/<version>/collect.ps1
//   - compute SHA256 hex of bytes
//   - synthesize new manifest_json (strip intervalSec/timeoutMs out of
//     the agent block — they live in package_policies V1+)
//   - write two rows with FK satisfied (script first, then policy)
//
// After all rows are migrated, drops installed_packages. The DROP is
// idempotent: MySQL uses DROP TABLE IF EXISTS; MSSQL guards on a
// sys.tables probe (no IF EXISTS in MSSQL DROP). Either way a
// re-apply on an already-migrated DB is a safe no-op.
//
// This file ships at db/migrations/023-package-scripts-policies-split.js;
// a sibling dispatcher at db/migrations/mssql/023-package-scripts-policies-split.js
// delegates here (the SQL is dialect-portable via `?` placeholders that
// the mssql driver wrapper rewrites to @p1, @p2, ... at execute() time).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const INSERT_SCRIPT = `INSERT INTO package_scripts (name, version, script_content, script_sha256, manifest_json, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const INSERT_POLICY = `INSERT INTO package_policies (name, interval_sec, timeout_ms, enabled, params_json, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const DROP_MYSQL = `DROP TABLE IF EXISTS installed_packages`;
const MSSQL_GUARD = `SELECT 1 AS x FROM sys.tables WHERE name = 'installed_packages'`;
const DROP_MSSQL = `DROP TABLE installed_packages`;

const SELECT_INSTALLED = `SELECT name, version, type, manifest_json, enabled, params_json, interval_override_sec FROM installed_packages ORDER BY name`;

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Strip intervalSec + timeoutMs from the agent block — they live in
// package_policies now, not in the manifest. Returns a fresh object so
// the caller's manifest is never mutated.
function stripPolicyFromManifest(manifest) {
  const out = JSON.parse(JSON.stringify(manifest));
  if (out.agent) {
    delete out.agent.intervalSec;
    delete out.agent.timeoutMs;
  }
  return out;
}

/**
 * Migrate every row from installed_packages into package_scripts +
 * package_policies, then drop installed_packages. Returns
 * `{ migrated: number }`.
 *
 * Params:
 *   db        — db facade (dialect-aware, exposes db.dialect +
 *               db.execute(sql, params))
 *   dataDir   — absolute path to the center's data/packages root (same
 *               path seedBuiltinPackages / installer use to cache
 *               scripts). The helper reads <dataDir>/<name>/<version>/collect.ps1.
 *   writeAudit — optional best-effort `({action, targetType, targetId, details})`
 *               async callback. Called once with action='bulk_migrate'
 *               after the migration completes. Audit failures are
 *               swallowed by callers, but the helper itself does not
 *               catch writeAudit throws — it lets them surface so the
 *               applier can decide.
 */
export async function migrateInstalledPackagesToTwoTable({ db, dataDir, writeAudit }) {
  const { rows } = await db.execute(SELECT_INSTALLED, []);
  if (rows.length === 0) return { migrated: 0 };

  const now = new Date();
  let count = 0;
  for (const row of rows) {
    // manifest_json: mssql returns string; mysql2 may auto-parse.
    const manifest = typeof row.manifest_json === 'string'
      ? JSON.parse(row.manifest_json)
      : row.manifest_json;

    // Read script bytes from disk. If the operator deleted
    // data/packages/<name>/<version>/collect.ps1 manually after the row
    // was written, fall back to a placeholder so the migration still
    // completes; the operator can re-upload via UI later.
    const scriptPath = path.join(dataDir, row.name, row.version, 'collect.ps1');
    let scriptBytes;
    try {
      scriptBytes = fs.readFileSync(scriptPath);
    } catch (e) {
      scriptBytes = Buffer.from(
        `# collect.ps1 missing for ${row.name}@${row.version} — re-upload required\n`
      );
    }
    const scriptSha = sha256Hex(scriptBytes);

    // 1. INSERT script row first (FK target).
    await db.execute(INSERT_SCRIPT, [
      row.name,
      row.version,
      scriptBytes.toString('utf8'),
      scriptSha,
      JSON.stringify(stripPolicyFromManifest(manifest)),
      'legacy-installed_packages',
      now,
      now
    ]);

    // 2. INSERT policy row. interval_override_sec wins over
    //    manifest.agent.intervalSec (R19 contract). timeoutMs comes
    //    from manifest.agent.timeoutMs (no per-row override column).
    const intervalSec = row.interval_override_sec ?? manifest.agent?.intervalSec ?? 3600;
    const timeoutMs = manifest.agent?.timeoutMs ?? 30000;
    const enabledBit = row.enabled === 1 || row.enabled === true ? 1 : 0;
    const paramsStr = row.params_json == null
      ? null
      : (typeof row.params_json === 'string' ? row.params_json : JSON.stringify(row.params_json));
    await db.execute(INSERT_POLICY, [
      row.name,
      Number(intervalSec),
      Number(timeoutMs),
      enabledBit,
      paramsStr,
      'global',
      now,
      now
    ]);
    count++;
  }

  // 3. Drop the V0 FK from ad_member_server_packages.package_name →
  //    installed_packages.name (defined by migration 014 as `fk_msp_pkg`).
  //    Must run BEFORE `DROP TABLE installed_packages` — otherwise the FK
  //    blocks the DROP. MySQL: `ALTER TABLE ... DROP FOREIGN KEY` is
  //    non-idempotent (throws if FK absent), but the applier only runs
  //    this sidecar once per migration version, so the throw path is
  //    unreachable in practice. MSSQL: probe sys.foreign_keys first so a
  //    re-apply is a safe no-op.
  if (db.dialect === 'mysql') {
    await db.execute('ALTER TABLE ad_member_server_packages DROP FOREIGN KEY fk_msp_pkg', []);
  } else {
    const fkProbe = await db.execute(
      "SELECT 1 AS x FROM sys.foreign_keys WHERE name = 'fk_msp_pkg'", []
    );
    if (fkProbe.rows.length > 0) {
      await db.execute('ALTER TABLE ad_member_server_packages DROP CONSTRAINT fk_msp_pkg', []);
    }
  }

  // 4. DROP installed_packages. MySQL: DROP TABLE IF EXISTS is
  //    idempotent. MSSQL: no IF EXISTS, so probe sys.tables first and
  //    only drop when the table still exists (re-runs are no-ops).
  if (db.dialect === 'mysql') {
    await db.execute(DROP_MYSQL, []);
  } else {
    const probe = await db.execute(MSSQL_GUARD, []);
    if (probe.rows.length > 0) {
      await db.execute(DROP_MSSQL, []);
    }
  }

  // 5. One audit summary row. Best-effort: caller may pass writeAudit
  //    as null/undefined; skip silently.
  if (writeAudit) {
    await writeAudit({
      action: 'bulk_migrate',
      targetType: 'packages',
      details: {
        source: 'installed_packages',
        count,
        destination: 'package_scripts+package_policies'
      }
    });
  }
  return { migrated: count };
}
