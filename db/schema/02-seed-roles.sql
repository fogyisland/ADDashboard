-- Seed default roles (idempotent via INSERT IGNORE)
INSERT IGNORE INTO sys_roles (role_name) VALUES
  ('admin'),
  ('operator'),
  ('viewer');

-- Seed default role permissions (one row per granted permission).
-- Subqueries resolve role_id from the just-inserted role_name rows above.
INSERT IGNORE INTO role_permissions (role_id, permission) VALUES
  ((SELECT id FROM sys_roles WHERE role_name = 'admin'),    '*'),
  ((SELECT id FROM sys_roles WHERE role_name = 'operator'), 'read:dash'),
  ((SELECT id FROM sys_roles WHERE role_name = 'operator'), 'execute:sync'),
  ((SELECT id FROM sys_roles WHERE role_name = 'viewer'),   'read:dash');

-- Seed default system config (idempotent via INSERT IGNORE)
-- These defaults are read at runtime before any user interaction, so a
-- fresh install has working defaults even before runtime seed functions
-- (seedSmtpDefaultsIfMissing, seedAgentTokenIfMissing, seedJwtSecretIfMissing,
--  seedListenPortIfMissing) fire. Runtime seeds still run idempotently on
-- startup; the SQL seed here just makes the row present from t=0 and is
-- the documented source of truth for baseline defaults.
INSERT IGNORE INTO system_config (config_key, config_value, description) VALUES
  ('ad_agent_token',           NULL,   'Shared secret for Agent API authentication'),
  ('polling_interval_minutes', '15',   'Agent collection interval in minutes'),
  ('latency_threshold_minutes','180',  'Replication latency warning threshold'),
  ('history_enabled',          '0',    'Append to ad_replication_history (0/1)'),
  ('heartbeat_interval_seconds','5',   'Agent 心跳间隔 (秒), 越短越快感知离线, 默认 5'),
  -- Agent-side runtime defaults read by getAgentConfig() (services/config.js).
  -- Each has a code-side || fallback but seeding them in the DB makes the
  -- values visible/auditable via ConfigView and ensures the agent gets a
  -- stable config even if getAgentConfig's fallback chain regresses.
  ('discovery_interval_hours', '4',    'Agent 站点/域控拓扑发现周期 (小时)'),
  ('heartbeat_port',           '8081', 'Agent 心跳接收端口 (DB 改后 5 min 内 agent 自动刷新)'),
  ('report_port',              '8082', 'Agent replication snapshot 上报端口'),
  ('heartbeat_stale_seconds',  '15',   '心跳 stale 阈值 (秒),超过即判定 agent 离线'),
  -- UI-side: SiteReplicationMatrixView polls the dashboard at this cadence.
  -- Frontend falls back to 10s if the row is absent.
  ('site_matrix_refresh_seconds','10', '站点复制矩阵自动刷新间隔 (秒)'),
  -- I4 retention loop reads audit_retention_days on every tick (services/audit.js).
  -- Default 90 days; set to 0 to disable retention entirely.
  ('audit_retention_days',     '90',   '审计日志保留天数 (默认 90, 设 0 禁用清理)');