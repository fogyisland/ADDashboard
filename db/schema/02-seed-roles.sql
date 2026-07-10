-- Seed default roles (idempotent)
SET QUOTED_IDENTIFIER ON;
GO

IF NOT EXISTS (SELECT 1 FROM sys_roles WHERE role_name = 'admin')
INSERT INTO sys_roles (role_name, permissions) VALUES
  ('admin',    '["*"]');

IF NOT EXISTS (SELECT 1 FROM sys_roles WHERE role_name = 'operator')
INSERT INTO sys_roles (role_name, permissions) VALUES
  ('operator', '["read:dash","execute:sync"]');

IF NOT EXISTS (SELECT 1 FROM sys_roles WHERE role_name = 'viewer')
INSERT INTO sys_roles (role_name, permissions) VALUES
  ('viewer',   '["read:dash"]');
GO

-- Seed default system config (idempotent)
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'ad_agent_token')
INSERT INTO system_config (config_key, config_value, description)
VALUES ('ad_agent_token', NULL, 'Shared secret for Agent API authentication');

IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'polling_interval_minutes')
INSERT INTO system_config (config_key, config_value, description)
VALUES ('polling_interval_minutes', '15', 'Agent collection interval in minutes');

IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'latency_threshold_minutes')
INSERT INTO system_config (config_key, config_value, description)
VALUES ('latency_threshold_minutes', '180', 'Replication latency warning threshold');

IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'history_enabled')
INSERT INTO system_config (config_key, config_value, description)
VALUES ('history_enabled', '0', 'Append to ad_replication_history (0/1)');
GO
