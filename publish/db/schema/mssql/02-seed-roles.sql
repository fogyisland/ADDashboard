-- Seed default roles (idempotent via IF NOT EXISTS guards)
-- SQL Server equivalent of MySQL's INSERT IGNORE: per-row existence check.

IF NOT EXISTS (SELECT 1 FROM sys_roles WHERE role_name = 'admin')
  INSERT INTO sys_roles (role_name, permissions) VALUES ('admin', '["*"]');

IF NOT EXISTS (SELECT 1 FROM sys_roles WHERE role_name = 'operator')
  INSERT INTO sys_roles (role_name, permissions) VALUES ('operator', '["read:dash","execute:sync"]');

IF NOT EXISTS (SELECT 1 FROM sys_roles WHERE role_name = 'viewer')
  INSERT INTO sys_roles (role_name, permissions) VALUES ('viewer', '["read:dash"]');

-- Seed default system config (idempotent via IF NOT EXISTS guards)
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'ad_agent_token')
  INSERT INTO system_config (config_key, config_value, description) VALUES ('ad_agent_token', NULL, 'Shared secret for Agent API authentication');

IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'polling_interval_minutes')
  INSERT INTO system_config (config_key, config_value, description) VALUES ('polling_interval_minutes', '15', 'Agent collection interval in minutes');

IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'latency_threshold_minutes')
  INSERT INTO system_config (config_key, config_value, description) VALUES ('latency_threshold_minutes', '180', 'Replication latency warning threshold');

IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'history_enabled')
  INSERT INTO system_config (config_key, config_value, description) VALUES ('history_enabled', '0', 'Append to ad_replication_history (0/1)');

IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'center_public_host')
  INSERT INTO system_config (config_key, config_value, description) VALUES ('center_public_host', NULL, '对外访问域名/IP, 如 ad-dashboard.contoso.com 或 10.1.2.3');

IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'center_public_port')
  INSERT INTO system_config (config_key, config_value, description) VALUES ('center_public_port', NULL, '对外访问端口, 如 443(HTTPS) / 80(HTTP)');

IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'heartbeat_interval_seconds')
  INSERT INTO system_config (config_key, config_value, description) VALUES ('heartbeat_interval_seconds', '5', 'Agent 心跳间隔 (秒), 越短越快感知离线, 默认 5');
