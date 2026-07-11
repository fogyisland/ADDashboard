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
  ('history_enabled',          '0',    'Append to ad_replication_history (0/1)');