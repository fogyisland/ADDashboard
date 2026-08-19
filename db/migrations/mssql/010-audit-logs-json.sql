-- verify: table audit_logs

-- 010-audit-logs-json.sql (MSSQL)
-- See mysql counterpart. NVARCHAR(MAX) is MSSQL's storage type for JSON text;
-- the ISJSON CHECK enforces shape going forward. Existing rows survive the
-- column type change (NVARCHAR(MAX) accepts any size). We nullify any
-- non-JSON existing rows BEFORE adding the CHECK, so the constraint never
-- rejects on migration.
IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('audit_logs') AND name = 'payload'
    AND system_type_id <> 231   -- nvarchar(max)
)
BEGIN
  ALTER TABLE audit_logs ALTER COLUMN payload NVARCHAR(MAX) NULL;
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints WHERE name = 'ck_audit_logs_payload_json'
)
BEGIN
  UPDATE audit_logs SET payload = NULL
    WHERE payload IS NOT NULL
      AND (ISJSON(payload) = 0);
  ALTER TABLE audit_logs
    ADD CONSTRAINT ck_audit_logs_payload_json CHECK (payload IS NULL OR ISJSON(payload) = 1);
END;