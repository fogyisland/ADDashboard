-- 008-lockout-events.sql (MSSQL)
-- MSSQL doesn't support CREATE TABLE IF NOT EXISTS — use the project's
-- established IF OBJECT_ID guard pattern (same as db/schema/mssql/01-tables.sql).
IF OBJECT_ID('ad_lockout_events', 'U') IS NULL
BEGIN
  CREATE TABLE ad_lockout_events (
    id                    BIGINT IDENTITY(1,1) PRIMARY KEY,
    occurred_at           DATETIME2 NOT NULL,
    collected_at          DATETIME2 NOT NULL,
    agent_id              VARCHAR(64)  NOT NULL,
    dc_name               VARCHAR(128) NOT NULL,
    event_record_id       BIGINT       NOT NULL,
    target_user_name      VARCHAR(256) NOT NULL,
    subject_user_name     VARCHAR(256) NULL,
    subject_domain        VARCHAR(256) NULL,
    caller_computer_name  VARCHAR(256) NULL,
    CONSTRAINT uq_lockout_dc_record UNIQUE (dc_name, event_record_id)
  );
  CREATE INDEX ix_lockout_target_time ON ad_lockout_events (target_user_name, occurred_at);
  CREATE INDEX ix_lockout_caller_time  ON ad_lockout_events (caller_computer_name, occurred_at);
  CREATE INDEX ix_lockout_dc_time      ON ad_lockout_events (dc_name, occurred_at);
  CREATE INDEX ix_lockout_occurred     ON ad_lockout_events (occurred_at);
END;