# `db/migrations/` — 升级路径增量

**This directory only feeds upgrade paths.** Fresh installs do NOT
execute any file in here. Read this before adding a new migration.

## Two installation paths

| Path | Trigger | Files applied | Order of execution |
|---|---|---|---|
| **Fresh install** (新装) | Operator runs init wizard against a brand-new DB | `db/schema/01-tables.sql` + `db/schema/02-seed-roles.sql` (MSSQL: `db/schema/mssql/*`) | Once. All tables/indexes seeded in one go. After: `backfillMigrations` records every `NNN-*.sql` in `schema_migrations` with `applied_by='system-init'` (no execution, no SQL ran) |
| **Upgrade** (升级) | Existing deployment starts; center detects `schema_migrations` table has rows but newer files exist on disk | `db/migrations/NNN-*.sql` files **NOT** yet recorded in `schema_migrations` | `migrationService.upgrade()` in `center/src/services/migrations.js` runs only the gap, in `NNN` order, in its own transaction, with idempotent guards on every `CREATE` |

The discriminator is simple: `schema_migrations` table exists and is
populated → upgrade path; missing or empty → fresh-install path.

## Why this split exists

Operator ruling (R84, 2026-09-09): **"迁移只针对升级提供,新装不跑
迁移"** — migrations are a delivery mechanism for the gap between
"what the DB looks like today" and "what the running code expects",
nothing more. A fresh install shouldn't pay for that history.

Concretely:
- A fresh DB seeded from `01-tables.sql` already contains every
  column, index, and table that the cumulative migrations introduced.
  Re-running those migrations is wasted IO and adds noise to the
  `startup auto-migration` log line.
- `schema_migrations` still needs every `NNN-*.sql` recorded so the
  Schema Migrations admin page does not show a fresh install as
  "fully pending". `backfillMigrations` does that — marks the files
  applied with `applied_by='system-init'`, `execution_ms=0`, and
  skips execution entirely.

## Authoring rules

1. **Every new schema change adds to BOTH places:**
   - A new file in `db/migrations/` (e.g. `026-foo.sql`) for
     existing deployments to pick up on next startup.
   - The matching DDL merged into `db/schema/01-tables.sql` (MySQL)
     and `db/schema/mssql/01-tables.sql` (MSSQL) so fresh installs
     still get the column/table/index.
2. **The migration file is the source of truth for the upgrade shape**
   (idempotent guards, `IF NOT EXISTS`, etc.). The schema file is a
   denormalized convenience — keep them in sync manually, or the
   fresh install will drift behind the running code.
3. **Use `ALTER TABLE ... ADD COLUMN` only when the column is missing.**
   MySQL 8 has no `ADD COLUMN IF NOT EXISTS`; the migration file uses
   a procedural guard (`INFORMATION_SCHEMA.COLUMNS` check inside a
   stored procedure for MySQL, or `IF COL_LENGTH(...) IS NULL` for
   MSSQL). When merging into `01-tables.sql`, just put the column in
   the original `CREATE TABLE` — there's nothing to guard.
4. **Naming convention:** `NNN-short-kebab-name.sql`. `NNN` is the
   zero-padded version. Don't skip numbers — leave a gap if a draft
   migration is abandoned.
5. **MSSQL variants:** if a migration needs dialect-specific syntax
   (e.g. `DATETIME` → `DATETIME2`, `AUTO_INCREMENT` → `IDENTITY(1,1)`,
   `BIGINT` primary key for high-volume tables), put the MySQL version
   at `db/migrations/NNN-foo.sql` and the MSSQL version at
   `db/migrations/mssql/NNN-foo.sql`. Both must produce the same
   final schema.

## Verifying a migration lands correctly

After adding a new `NNN-foo.sql`:

1. **Fresh install path** — drop the test DB, run init wizard against
   it, then `SHOW TABLES` and `SHOW COLUMNS FROM <changed-table>` to
   confirm the merged `01-tables.sql` carries the change.
2. **Upgrade path** — start the service against an existing DB that
   has the previous migrations applied; watch
   `logs/center.log` for `startup auto-migration` showing the new
   file in the `applied` list. Check `schema_migrations` for the new
   row.

## History

- **R85 (2026-09-21):** hardened `019-package-interval-override.sql`
  for the R66 `installed_packages` table drop. The original was a
  bare `ALTER TABLE installed_packages ADD COLUMN ...`; after
  migration 023 split V0 into `package_scripts` + `package_policies`
  the V0 table no longer exists on any V1 center, so the bare ALTER
  failed every upgrade and pinned a `status='failed'` row in
  `schema_migrations`. Rewritten with the same two-step
  `INFORMATION_SCHEMA` + dynamic SQL guard used by `016`, wrapped
  in a stored procedure so the file is a true no-op against either
  side of the R66 split. The MSSQL sibling already had a
  `sys.columns IF NOT EXISTS` guard from R12-r12. Backed by
  `center/tests/migrations/019-package-interval-override.test.js`
  (8 file-level tests, no live DB required).
- **R84 (2026-09-09):** split fresh-install and upgrade semantics.
  `applyAll()` no longer iterates `db/migrations/`. `01-tables.sql`
  was rewritten to carry every cumulative DDL from migrations
  001–025. Before this round the wizard ran every migration file
  on every fresh install, which violated the "migrations are for
  upgrades" intent and produced misleading startup logs.