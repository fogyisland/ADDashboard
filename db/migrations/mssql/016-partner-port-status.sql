-- verify: column ad_replication_status.partner_port_status

-- 016-partner-port-status.sql (MSSQL)
-- Mirror of db/migrations/016-partner-port-status.sql for SQL Server.
-- NVARCHAR(MAX) is MSSQL's storage type for JSON text; the ISJSON CHECK
-- enforces shape going forward. The column is added with NULL allowed so
-- pre-feature rows stay valid; the constraint is conditional (IS NULL OR
-- ISJSON = 1) so we never reject existing NULL rows.

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'ad_replication_status') AND name = N'partner_port_status'
)
BEGIN
  ALTER TABLE ad_replication_status ADD partner_port_status NVARCHAR(MAX) NULL;
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints WHERE name = N'ck_replication_status_partner_port_json'
)
BEGIN
  ALTER TABLE ad_replication_status
    ADD CONSTRAINT ck_replication_status_partner_port_json
    CHECK (partner_port_status IS NULL OR ISJSON(partner_port_status) = 1);
END;