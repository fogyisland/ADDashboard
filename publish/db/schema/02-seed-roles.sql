-- Seed default roles (idempotent via INSERT IGNORE)
INSERT IGNORE INTO sys_roles (role_name, permissions) VALUES
  ('admin',    '["*"]'),
  ('operator', '["read:dash","execute:sync"]'),
  ('viewer',   '["read:dash"]');

-- Seed default system config (idempotent via INSERT IGNORE)
INSERT IGNORE INTO system_config (config_key, config_value, description) VALUES
  ('ad_agent_token',           NULL,   'Shared secret for Agent API authentication'),
  ('polling_interval_minutes', '15',   'Agent collection interval in minutes'),
  ('latency_threshold_minutes','180',  'Replication latency warning threshold'),
  ('history_enabled',          '0',    'Append to ad_replication_history (0/1)'),
  ('center_public_host',       NULL,   '对外访问域名/IP, 如 ad-dashboard.contoso.com 或 10.1.2.3'),
  ('center_public_port',       NULL,   '对外访问端口, 如 443(HTTPS) / 80(HTTP)'),
  ('heartbeat_interval_seconds','5',   'Agent 心跳间隔 (秒), 越短越快感知离线, 默认 5');