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
-- These defaults are read at runtime before any user interaction, so a
-- fresh install has working defaults even before runtime seed functions
-- (seedSmtpDefaultsIfMissing, seedAgentTokenIfMissing, seedJwtSecretIfMissing,
--  seedListenPortIfMissing) fire. Runtime seeds still run idempotently on
-- startup; the SQL seed here just makes the row present from t=0 and is
-- the documented source of truth for baseline defaults.
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'ad_agent_token')
  INSERT INTO system_config (config_key, config_value, description) VALUES ('ad_agent_token', NULL, 'Shared secret for Agent API authentication');

IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'polling_interval_minutes')
  INSERT INTO system_config (config_key, config_value, description) VALUES ('polling_interval_minutes', '15', 'Agent collection interval in minutes');

IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'latency_threshold_minutes')
  INSERT INTO system_config (config_key, config_value, description) VALUES ('latency_threshold_minutes', '180', 'Replication latency warning threshold');

IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'history_enabled')
  INSERT INTO system_config (config_key, config_value, description) VALUES ('history_enabled', '0', 'Append to ad_replication_history (0/1)');

IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'heartbeat_interval_seconds')
  INSERT INTO system_config (config_key, config_value, description) VALUES ('heartbeat_interval_seconds', '5', 'Agent 心跳间隔 (秒), 越短越快感知离线, 默认 5');

-- Agent-side runtime defaults read by getAgentConfig() (services/config.js).
-- Each has a code-side || fallback but seeding them in the DB makes the
-- values visible/auditable via ConfigView and ensures the agent gets a
-- stable config even if getAgentConfig's fallback chain regresses.
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'discovery_interval_hours')
  INSERT INTO system_config (config_key, config_value, description) VALUES ('discovery_interval_hours', '4', 'Agent 站点/域控拓扑发现周期 (小时)');

IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'heartbeat_port')
  INSERT INTO system_config (config_key, config_value, description) VALUES ('heartbeat_port', '8081', 'Agent 心跳接收端口 (DB 改后 5 min 内 agent 自动刷新)');

IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'report_port')
  INSERT INTO system_config (config_key, config_value, description) VALUES ('report_port', '8082', 'Agent replication snapshot 上报端口');

IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'heartbeat_stale_seconds')
  INSERT INTO system_config (config_key, config_value, description) VALUES ('heartbeat_stale_seconds', '15', '心跳 stale 阈值 (秒),超过即判定 agent 离线');

-- UI-side: SiteReplicationMatrixView polls the dashboard at this cadence.
-- Frontend falls back to 10s if the row is absent.
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'site_matrix_refresh_seconds')
  INSERT INTO system_config (config_key, config_value, description) VALUES ('site_matrix_refresh_seconds', '10', '站点复制矩阵自动刷新间隔 (秒)');

-- I4 retention loop reads audit_retention_days on every tick (services/audit.js).
-- Default 90 days; set to 0 to disable retention entirely.
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'audit_retention_days')
  INSERT INTO system_config (config_key, config_value, description) VALUES ('audit_retention_days', '90', '审计日志保留天数 (默认 90, 设 0 禁用清理)');

-- Client + agent access domain. Empty = fall back to server IP. ConfigView
-- uses this for both the operator-facing "Agent 连接地址" display and
-- client-app access URLs. See services/network.js getPrimaryIPv4() for
-- the IP fallback path; admin.js GET /api/admin/config returns serverIp
-- alongside the config so the frontend can render the resolved URL.
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'access_domain')
  INSERT INTO system_config (config_key, config_value, description) VALUES ('access_domain', '', '客户端与 Agent 访问域名;留空则用服务器 IP');
