-- verify: table sys_config_audit

-- 005-sys-config-audit.sql
CREATE TABLE IF NOT EXISTS sys_config_audit (
  id INT PRIMARY KEY AUTO_INCREMENT,
  config_key VARCHAR(64) NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_by INT NULL,
  changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  change_type ENUM('UPDATE','ROLLBACK') NOT NULL DEFAULT 'UPDATE',
  INDEX idx_changed_at (changed_at DESC),
  INDEX idx_config_key (config_key),
  INDEX idx_changed_by (changed_by)
);
