-- AD Dashboard migration 002 (SQL Server 2014+): replace JSON-encoded
-- sys_roles.permissions NVARCHAR(MAX) column with the role_permissions
-- relational table (third normal form).
--
-- Applies after 01-tables.sql + 02-seed-roles.sql.
-- Idempotent: skips backfill if role_permissions is already populated, and
-- drops the legacy column only if it still exists. Safe to run on a fresh DB
-- (which already has the new schema and no legacy column) and on an upgraded
-- DB (which still has the legacy column with JSON-encoded permission arrays).
--
-- MSSQL note: MSSQL CTEs auto-detect recursion from the UNION ALL referencing
-- the CTE name — no `RECURSIVE` keyword (that's MySQL 8.0+ only).

-- Defensive: create role_permissions if the schema file wasn't applied (e.g.
-- someone is running this migration against an older 01-tables.sql).
IF OBJECT_ID('role_permissions', 'U') IS NULL
BEGIN
  CREATE TABLE role_permissions (
    role_id    INT NOT NULL,
    permission NVARCHAR(64) NOT NULL,
    CONSTRAINT pk_role_permissions PRIMARY KEY (role_id, permission),
    CONSTRAINT fk_role_permissions_role FOREIGN KEY (role_id) REFERENCES sys_roles(id) ON DELETE CASCADE
  );
END;

-- Unwrap the JSON array into role_permissions rows. CTE generates a 0..19
-- sequence (generous cap, no real role has more than a handful of permissions).
-- Skip the entire block when role_permissions is already populated OR the
-- legacy column doesn't exist (fresh installs). MSSQL has no MySQL-style
-- procedure wrapper here — top-level SELECT is fine because we're not in a
-- batch context where partial failure would matter.
IF COL_LENGTH('sys_roles', 'permissions') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM role_permissions)
BEGIN
  WITH nums(n) AS (
    SELECT 0 UNION ALL SELECT n + 1 FROM nums WHERE n < 19
  )
  INSERT INTO role_permissions (role_id, permission)
  SELECT r.id, JSON_VALUE(r.permissions, '$[' + CAST(n.n AS NVARCHAR(3)) + ']')
  FROM sys_roles r, nums n
  WHERE r.permissions IS NOT NULL
    AND ISJSON(r.permissions) = 1
    AND JSON_LENGTH(r.permissions) > n.n
  OPTION (MAXRECURSION 100);
END;

-- Drop the legacy column only if it still exists (fresh installs already
-- have role_permissions and never had sys_roles.permissions).
IF COL_LENGTH('sys_roles', 'permissions') IS NOT NULL
BEGIN
  ALTER TABLE sys_roles DROP COLUMN permissions;
END;
