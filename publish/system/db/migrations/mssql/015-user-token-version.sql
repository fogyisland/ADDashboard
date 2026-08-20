-- verify: column sys_users.token_version

-- 015-user-token-version.sql (MSSQL)
-- Mirror of db/migrations/015-user-token-version.sql for SQL Server.
-- sys.columns guard makes this idempotent on rerun.

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'sys_users') AND name = N'token_version'
)
BEGIN
  ALTER TABLE sys_users ADD token_version INT NOT NULL
    CONSTRAINT df_users_token_version DEFAULT 0;
END;