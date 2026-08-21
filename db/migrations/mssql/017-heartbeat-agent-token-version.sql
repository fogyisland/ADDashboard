-- verify: column ad_agent_heartbeat.agent_token_version

-- 017-heartbeat-agent-token-version.sql (MSSQL)
-- Mirror of db/migrations/017-heartbeat-agent-token-version.sql for SQL
-- Server. sys.columns guard makes this idempotent on rerun. NOT NULL with
-- DEFAULT 0 means pre-feature heartbeat rows match as version=0 on first
-- read — the server's version is also 0 until the operator generates the
-- first new token.

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'ad_agent_heartbeat') AND name = N'agent_token_version'
)
BEGIN
  ALTER TABLE ad_agent_heartbeat ADD agent_token_version INT NOT NULL
    CONSTRAINT df_heartbeat_agent_token_version DEFAULT 0;
END;