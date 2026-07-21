-- Seed default roles (idempotent via IF NOT EXISTS guards)
-- SQL Server equivalent of MySQL's INSERT IGNORE: per-row existence check.

IF NOT EXISTS (SELECT 1 FROM sys_roles WHERE role_name = 'admin')
  INSERT INTO sys_roles (role_name) VALUES ('admin');

IF NOT EXISTS (SELECT 1 FROM sys_roles WHERE role_name = 'operator')
  INSERT INTO sys_roles (role_name) VALUES ('operator');

IF NOT EXISTS (SELECT 1 FROM sys_roles WHERE role_name = 'viewer')
  INSERT INTO sys_roles (role_name) VALUES ('viewer');

-- Seed default role permissions (one row per granted permission).
-- Subqueries resolve role_id from the just-inserted role_name rows above.
IF NOT EXISTS (SELECT 1 FROM role_permissions rp JOIN sys_roles r ON rp.role_id = r.id WHERE r.role_name = 'admin' AND rp.permission = '*')
  INSERT INTO role_permissions (role_id, permission)
    SELECT id, '*' FROM sys_roles WHERE role_name = 'admin';

IF NOT EXISTS (SELECT 1 FROM role_permissions rp JOIN sys_roles r ON rp.role_id = r.id WHERE r.role_name = 'operator' AND rp.permission = 'read:dash')
  INSERT INTO role_permissions (role_id, permission)
    SELECT id, 'read:dash' FROM sys_roles WHERE role_name = 'operator';

IF NOT EXISTS (SELECT 1 FROM role_permissions rp JOIN sys_roles r ON rp.role_id = r.id WHERE r.role_name = 'operator' AND rp.permission = 'execute:sync')
  INSERT INTO role_permissions (role_id, permission)
    SELECT id, 'execute:sync' FROM sys_roles WHERE role_name = 'operator';

IF NOT EXISTS (SELECT 1 FROM role_permissions rp JOIN sys_roles r ON rp.role_id = r.id WHERE r.role_name = 'viewer' AND rp.permission = 'read:dash')
  INSERT INTO role_permissions (role_id, permission)
    SELECT id, 'read:dash' FROM sys_roles WHERE role_name = 'viewer';

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
