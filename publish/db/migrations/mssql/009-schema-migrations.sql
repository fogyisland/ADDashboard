-- verify: table schema_migrations

-- 009-schema-migrations.sql (MSSQL)
-- See mysql counterpart for semantics. Uses DATETIME2 (not DATETIME) per
-- project convention; IF OBJECT_ID guard follows db/schema/mssql/01-tables.sql pattern.
IF OBJECT_ID('schema_migrations', 'U') IS NULL
BEGIN
  CREATE TABLE schema_migrations (
    version        VARCHAR(32)  NOT NULL PRIMARY KEY,
    description    VARCHAR(255) NOT NULL,
    type           VARCHAR(16)  NOT NULL CONSTRAINT df_schema_migrations_type DEFAULT ('sql'),
    script         VARCHAR(255) NOT NULL,
    checksum       CHAR(64)     NOT NULL,
    applied_at     DATETIME2    NOT NULL,
    applied_by     VARCHAR(64)  NULL,
    execution_ms   INT          NULL,
    status         VARCHAR(16)  NOT NULL CONSTRAINT df_schema_migrations_status DEFAULT ('applied'),
    error_message  NVARCHAR(MAX) NULL
  );
  CREATE INDEX ix_schema_migrations_status ON schema_migrations (status);
END;
