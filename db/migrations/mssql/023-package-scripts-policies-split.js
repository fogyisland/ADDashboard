// 2026-08-29 R66 — MSSQL variant of the 023 data migration dispatcher.
//
// The SQL is dialect-portable (uses `?` placeholders that the mssql
// driver wrapper rewrites to @p1, @p2, ... at execute() time), so the
// runtime behavior is identical to the MySQL file. The .js sibling
// exists for two reasons:
//
//   1. The plan calls for a per-dialect JS file under db/migrations/mssql/
//      so the bootstrap path can resolve a version-matched .js next to
//      the .sql it just executed (R20 R-pattern).
//   2. If a future migration needs genuinely different JS logic per
//      dialect (e.g. a custom SQL injection per dialect), having a
//      sibling file already in place means the applier code path doesn't
//      have to learn a new convention.
//
// For V1, the MSSQL file re-exports the same helper as the MySQL file.

export { migrateInstalledPackagesToTwoTable } from '../023-package-scripts-policies-split.js';
