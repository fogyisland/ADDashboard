// Central SQL registry. One frozen dictionary per dialect, selected at boot
// by db.dialect. Service code reads db.sql.<domain>.<query> and gets back a
// plain string for the active dialect — never a sub-object.
//
// Placeholders: use `?` only (mysql2 style). The mssql driver wrapper
// rewrites `?` -> `@p1, @p2, ...` at execute() time; service code never
// sees @p1.

const VARIANTS = {
  mysql: {
    health: {
      ping: 'SELECT 1 AS ok',
      lastHeartbeat: 'SELECT last_heartbeat_at AS last FROM ad_agent_heartbeat ORDER BY last_heartbeat_at DESC LIMIT 1'
    },
    replication: {
      upsertStatus: `INSERT INTO ad_replication_status (collected_at, agent_id, source_dc, dest_dc, source_site, dest_site, naming_context, last_success_time, last_attempt_time, status_code, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE collected_at = VALUES(collected_at), agent_id = VALUES(agent_id), source_site = VALUES(source_site), dest_site = VALUES(dest_site), last_success_time = VALUES(last_success_time), last_attempt_time = VALUES(last_attempt_time), status_code = VALUES(status_code), error_message = VALUES(error_message)`,
      upsertHistory: `INSERT INTO ad_replication_history (collected_at, agent_id, source_dc, dest_dc, naming_context, last_success_time, status_code, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      listRecent: `SELECT source_dc, dest_dc, source_site, dest_site, status_code, collected_at FROM ad_replication_status ORDER BY collected_at DESC LIMIT ?`,
      listBySite: `SELECT source_dc, dest_dc, source_site, dest_site, status_code, collected_at FROM ad_replication_status WHERE source_site = ? OR dest_site = ? ORDER BY collected_at DESC LIMIT ?`
    },
    discovery: {
      upsertDc: `INSERT INTO ad_dcs (dc_name, site_hint, os_version, when_created, is_pdc, is_gc, is_rid_master, is_schema_master, is_domain_naming_master, is_infrastructure_master, discovered_at, discovered_by_agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE site_hint = VALUES(site_hint), os_version = VALUES(os_version), when_created = VALUES(when_created), is_pdc = VALUES(is_pdc), is_gc = VALUES(is_gc), is_rid_master = VALUES(is_rid_master), is_schema_master = VALUES(is_schema_master), is_domain_naming_master = VALUES(is_domain_naming_master), is_infrastructure_master = VALUES(is_infrastructure_master), discovered_at = NOW(), discovered_by_agent_id = VALUES(discovered_by_agent_id)`
    },
    users: {
      findByUsername: 'SELECT id, username, password_hash, role_id, status FROM sys_users WHERE username = ? LIMIT 1',
      list: 'SELECT id, username, role_id, status, last_login_at, created_at FROM sys_users ORDER BY id',
      create: 'INSERT INTO sys_users (username, password_hash, role_id, status) VALUES (?, ?, ?, ?)',
      update: 'UPDATE sys_users SET password_hash = COALESCE(?, password_hash), role_id = COALESCE(?, role_id), status = COALESCE(?, status) WHERE id = ?',
      delete: 'DELETE FROM sys_users WHERE id = ?',
      recordLogin: 'UPDATE sys_users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?',
      countAdmins: `SELECT COUNT(*) AS n FROM sys_users u JOIN sys_roles r ON u.role_id = r.id WHERE r.role_name = 'admin'`
    },
    roles: {
      list: 'SELECT id, role_name, permissions FROM sys_roles ORDER BY id'
    },
    config: {
      getAll: 'SELECT config_key, config_value FROM system_config',
      upsert: `INSERT INTO system_config (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_at = CURRENT_TIMESTAMP`,
      setAgentToken: `INSERT INTO system_config (config_key, config_value) VALUES ('agent_token', ?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_at = CURRENT_TIMESTAMP`
    },
    audit: {
      write: 'INSERT INTO audit_logs (user_id, action, target, payload) VALUES (?, ?, ?, ?)',
      list: 'SELECT id, user_id, action, target, payload, created_at FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT ?'
    },
    sites: {
      listAll: 'SELECT site, region_code, is_hub FROM ad_sites',
      listCatalog: `SELECT s.site_id AS id, s.site_name AS siteName, s.region_code AS regionCode, s.is_hub AS isHub, s.description, s.created_at AS createdAt, s.updated_at AS updatedAt, (SELECT COUNT(*) FROM ad_dcs d WHERE d.site_id = s.site_id) AS dcCount FROM ad_sites s ORDER BY s.site_name`,
      listDistinct: `SELECT site AS name, COUNT(*) AS link_count, SUM(CASE WHEN status_code >= 2 THEN 1 ELSE 0 END) AS error_count, MAX(collected_at) AS last_seen FROM (SELECT source_site AS site, status_code, collected_at FROM ad_replication_status WHERE source_site IS NOT NULL UNION ALL SELECT dest_site, status_code, collected_at FROM ad_replication_status WHERE dest_site IS NOT NULL) t GROUP BY site ORDER BY site`,
      findByName: 'SELECT site_id FROM ad_sites WHERE site_name = ?',
      create: 'INSERT INTO ad_sites (site_name, region_code, is_hub, description) VALUES (?, ?, ?, ?)',
      update: 'UPDATE ad_sites SET site_name = ?, region_code = ?, is_hub = ?, description = ? WHERE site_id = ?',
      updatePartial: (fields) => `UPDATE ad_sites SET ${fields.join(', ')} WHERE site_id = ?`,
      delete: 'DELETE FROM ad_sites WHERE site_id = ?',
      unbindDcs: 'UPDATE ad_dcs SET site_id = NULL WHERE site_id = ?'
    },
    dcs: {
      listCatalog: `SELECT d.dc_name AS dcName, d.site_id AS siteId, s.site_name AS siteName, d.site_hint AS siteHint, d.os_version AS osVersion, d.when_created AS whenCreated, d.is_pdc AS isPdc, d.is_gc AS isGc, d.is_rid_master AS isRidMaster, d.is_schema_master AS isSchemaMaster, d.is_domain_naming_master AS isDomainNamingMaster, d.is_infrastructure_master AS isInfrastructureMaster, d.discovered_at AS discoveredAt, d.discovered_by_agent_id AS discoveredByAgentId FROM ad_dcs d LEFT JOIN ad_sites s ON d.site_id = s.site_id ORDER BY d.dc_name`,
      listDistinct: `SELECT dc AS name, site, COUNT(*) AS link_count, SUM(CASE WHEN status_code >= 2 THEN 1 ELSE 0 END) AS error_count, MAX(collected_at) AS last_seen FROM (SELECT source_dc AS dc, source_site AS site, status_code, collected_at FROM ad_replication_status WHERE source_dc IS NOT NULL UNION ALL SELECT dest_dc, dest_site, status_code, collected_at FROM ad_replication_status WHERE dest_dc IS NOT NULL) t GROUP BY dc, site ORDER BY dc, site`,
      assignSite: 'UPDATE ad_dcs SET site_id = ? WHERE dc_name = ?',
      assignSiteUnbind: 'UPDATE ad_dcs SET site_id = NULL WHERE dc_name = ?'
    },
    dashboard: {
      overviewCounts: `SELECT COUNT(*) AS total, SUM(CASE WHEN status_code = 0 THEN 1 ELSE 0 END) AS healthy, SUM(CASE WHEN status_code = 1 THEN 1 ELSE 0 END) AS warning, SUM(CASE WHEN status_code >= 2 THEN 1 ELSE 0 END) AS errored, MAX(collected_at) AS last_update FROM ad_replication_status`,
      agentCount: `SELECT COUNT(*) AS agent_count FROM ad_agent_heartbeat WHERE last_heartbeat_at IS NOT NULL`,
      siteMatrix: `SELECT source_site, dest_site, SUM(CASE WHEN status_code >= 2 THEN 1 ELSE 0 END) AS error_count, SUM(CASE WHEN status_code = 1 THEN 1 ELSE 0 END) AS warning_count, COUNT(*) AS total FROM ad_replication_status WHERE source_site IS NOT NULL AND dest_site IS NOT NULL GROUP BY source_site, dest_site ORDER BY source_site, dest_site`,
      topology: `SELECT source_site, dest_site, source_dc, dest_dc, status_code, last_success_time FROM ad_replication_status`,
      errors: `SELECT source_dc, dest_dc, source_site, dest_site, naming_context, status_code, last_success_time, last_attempt_time, TIMESTAMPDIFF(MINUTE, last_success_time, last_attempt_time) AS duration_minutes FROM ad_replication_status WHERE status_code <> 0 ORDER BY last_attempt_time DESC`,
      agents: `SELECT agent_id, last_heartbeat_at, agent_version, last_report_at, last_report_status, pending_queue_size, TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW()) AS seconds_since_heartbeat FROM ad_agent_heartbeat ORDER BY agent_id`,
      siteLookup: `SELECT site_id, site_name, region_code, is_hub, description FROM ad_sites WHERE site_name = ?`,
      dcsBySite: `SELECT dc_name, os_version, is_pdc, is_gc, is_rid_master, is_schema_master, is_domain_naming_master, is_infrastructure_master, discovered_at, discovered_by_agent_id FROM ad_dcs WHERE site_id = ? ORDER BY dc_name`,
      dcReplicationLinks: (placeholders) => `SELECT source_dc, dest_dc, naming_context, status_code, last_success_time, last_attempt_time, TIMESTAMPDIFF(MINUTE, last_success_time, last_attempt_time) AS duration_minutes FROM ad_replication_status WHERE source_dc IN (${placeholders}) AND dest_dc IN (${placeholders}) ORDER BY source_dc, dest_dc, naming_context`,
      refreshSeconds: `SELECT config_value FROM system_config WHERE config_key = 'site_matrix_refresh_seconds'`
    },
    heartbeat: {
      upsert: `INSERT INTO ad_agent_heartbeat (agent_id, last_heartbeat_at, agent_version, last_report_at, last_report_status, pending_queue_size) VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE last_heartbeat_at = CURRENT_TIMESTAMP, agent_version = VALUES(agent_version), last_report_at = VALUES(last_report_at), last_report_status = VALUES(last_report_status), pending_queue_size = VALUES(pending_queue_size)`
    }
  },
  mssql: {
    health: {
      ping: 'SELECT 1 AS ok',
      lastHeartbeat: 'SELECT TOP 1 last_heartbeat_at AS last FROM ad_agent_heartbeat ORDER BY last_heartbeat_at DESC'
    },
    replication: {
      upsertStatus: `MERGE INTO ad_replication_status AS t USING (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)) AS s(collected_at, agent_id, source_dc, dest_dc, source_site, dest_site, naming_context, last_success_time, last_attempt_time, status_code, error_message) ON t.source_dc = s.source_dc AND t.dest_dc = s.dest_dc AND t.naming_context = s.naming_context WHEN MATCHED THEN UPDATE SET collected_at = s.collected_at, agent_id = s.agent_id, source_site = s.source_site, dest_site = s.dest_site, last_success_time = s.last_success_time, last_attempt_time = s.last_attempt_time, status_code = s.status_code, error_message = s.error_message WHEN NOT MATCHED THEN INSERT (collected_at, agent_id, source_dc, dest_dc, source_site, dest_site, naming_context, last_success_time, last_attempt_time, status_code, error_message) VALUES (s.collected_at, s.agent_id, s.source_dc, s.dest_dc, s.source_site, s.dest_site, s.naming_context, s.last_success_time, s.last_attempt_time, s.status_code, s.error_message)`,
      upsertHistory: `INSERT INTO ad_replication_history (collected_at, agent_id, source_dc, dest_dc, naming_context, last_success_time, status_code, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      listRecent: `SELECT TOP (?) source_dc, dest_dc, source_site, dest_site, status_code, collected_at FROM ad_replication_status ORDER BY collected_at DESC`,
      listBySite: `SELECT TOP (?) source_dc, dest_dc, source_site, dest_site, status_code, collected_at FROM ad_replication_status WHERE source_site = ? OR dest_site = ? ORDER BY collected_at DESC`
    },
    discovery: {
      upsertDc: `MERGE INTO ad_dcs AS t USING (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)) AS s(dc_name, site_hint, os_version, when_created, is_pdc, is_gc, is_rid_master, is_schema_master, is_domain_naming_master, is_infrastructure_master, discovered_at, discovered_by_agent_id) ON t.dc_name = s.dc_name WHEN MATCHED THEN UPDATE SET site_hint = s.site_hint, os_version = s.os_version, when_created = s.when_created, is_pdc = s.is_pdc, is_gc = s.is_gc, is_rid_master = s.is_rid_master, is_schema_master = s.is_schema_master, is_domain_naming_master = s.is_domain_naming_master, is_infrastructure_master = s.is_infrastructure_master, discovered_at = SYSUTCDATETIME(), discovered_by_agent_id = s.discovered_by_agent_id WHEN NOT MATCHED THEN INSERT (dc_name, site_hint, os_version, when_created, is_pdc, is_gc, is_rid_master, is_schema_master, is_domain_naming_master, is_infrastructure_master, discovered_at, discovered_by_agent_id) VALUES (s.dc_name, s.site_hint, s.os_version, s.when_created, s.is_pdc, s.is_gc, s.is_rid_master, s.is_schema_master, s.is_domain_naming_master, s.is_infrastructure_master, s.discovered_at, s.discovered_by_agent_id)`
    },
    users: {
      findByUsername: 'SELECT TOP 1 id, username, password_hash, role_id, status FROM sys_users WHERE username = ?',
      list: 'SELECT id, username, role_id, status, last_login_at, created_at FROM sys_users ORDER BY id',
      create: 'INSERT INTO sys_users (username, password_hash, role_id, status) VALUES (?, ?, ?, ?)',
      update: 'UPDATE sys_users SET password_hash = COALESCE(?, password_hash), role_id = COALESCE(?, role_id), status = COALESCE(?, status) WHERE id = ?',
      delete: 'DELETE FROM sys_users WHERE id = ?',
      recordLogin: 'UPDATE sys_users SET last_login_at = SYSUTCDATETIME() WHERE id = ?',
      countAdmins: `SELECT COUNT(*) AS n FROM sys_users u JOIN sys_roles r ON u.role_id = r.id WHERE r.role_name = 'admin'`
    },
    roles: {
      list: 'SELECT id, role_name, permissions FROM sys_roles ORDER BY id'
    },
    config: {
      getAll: 'SELECT config_key, config_value FROM system_config',
      upsert: `MERGE INTO system_config AS t USING (SELECT ? AS config_key, ? AS config_value) AS s ON t.config_key = s.config_key WHEN MATCHED THEN UPDATE SET config_value = s.config_value, updated_at = SYSUTCDATETIME() WHEN NOT MATCHED THEN INSERT (config_key, config_value) VALUES (s.config_key, s.config_value)`,
      setAgentToken: `MERGE INTO system_config AS t USING (SELECT 'agent_token' AS config_key, ? AS config_value) AS s ON t.config_key = s.config_key WHEN MATCHED THEN UPDATE SET config_value = s.config_value, updated_at = SYSUTCDATETIME() WHEN NOT MATCHED THEN INSERT (config_key, config_value) VALUES (s.config_key, s.config_value)`
    },
    audit: {
      write: 'INSERT INTO audit_logs (user_id, action, target, payload) VALUES (?, ?, ?, ?)',
      list: 'SELECT TOP (?) id, user_id, action, target, payload, created_at FROM audit_logs ORDER BY created_at DESC, id DESC'
    },
    sites: {
      listAll: 'SELECT site, region_code, is_hub FROM ad_sites',
      listCatalog: `SELECT s.site_id AS id, s.site_name AS siteName, s.region_code AS regionCode, s.is_hub AS isHub, s.description, s.created_at AS createdAt, s.updated_at AS updatedAt, (SELECT COUNT(*) FROM ad_dcs d WHERE d.site_id = s.site_id) AS dcCount FROM ad_sites s ORDER BY s.site_name`,
      listDistinct: `SELECT site AS name, COUNT(*) AS link_count, SUM(CASE WHEN status_code >= 2 THEN 1 ELSE 0 END) AS error_count, MAX(collected_at) AS last_seen FROM (SELECT source_site AS site, status_code, collected_at FROM ad_replication_status WHERE source_site IS NOT NULL UNION ALL SELECT dest_site, status_code, collected_at FROM ad_replication_status WHERE dest_site IS NOT NULL) t GROUP BY site ORDER BY site`,
      findByName: 'SELECT site_id FROM ad_sites WHERE site_name = ?',
      create: 'INSERT INTO ad_sites (site_name, region_code, is_hub, description) VALUES (?, ?, ?, ?)',
      update: 'UPDATE ad_sites SET site_name = ?, region_code = ?, is_hub = ?, description = ? WHERE site_id = ?',
      updatePartial: (fields) => `UPDATE ad_sites SET ${fields.map((_, i) => fields[i].replace(/\?/g, `@p${i + 1}`)).join(', ')} WHERE site_id = @p${fields.length + 1}`,
      delete: 'DELETE FROM ad_sites WHERE site_id = ?',
      unbindDcs: 'UPDATE ad_dcs SET site_id = NULL WHERE site_id = ?'
    },
    dcs: {
      listCatalog: `SELECT d.dc_name AS dcName, d.site_id AS siteId, s.site_name AS siteName, d.site_hint AS siteHint, d.os_version AS osVersion, d.when_created AS whenCreated, d.is_pdc AS isPdc, d.is_gc AS isGc, d.is_rid_master AS isRidMaster, d.is_schema_master AS isSchemaMaster, d.is_domain_naming_master AS isDomainNamingMaster, d.is_infrastructure_master AS isInfrastructureMaster, d.discovered_at AS discoveredAt, d.discovered_by_agent_id AS discoveredByAgentId FROM ad_dcs d LEFT JOIN ad_sites s ON d.site_id = s.site_id ORDER BY d.dc_name`,
      listDistinct: `SELECT dc AS name, site, COUNT(*) AS link_count, SUM(CASE WHEN status_code >= 2 THEN 1 ELSE 0 END) AS error_count, MAX(collected_at) AS last_seen FROM (SELECT source_dc AS dc, source_site AS site, status_code, collected_at FROM ad_replication_status WHERE source_dc IS NOT NULL UNION ALL SELECT dest_dc, dest_site, status_code, collected_at FROM ad_replication_status WHERE dest_dc IS NOT NULL) t GROUP BY dc, site ORDER BY dc, site`,
      assignSite: 'UPDATE ad_dcs SET site_id = ? WHERE dc_name = ?',
      assignSiteUnbind: 'UPDATE ad_dcs SET site_id = NULL WHERE dc_name = ?'
    },
    dashboard: {
      overviewCounts: `SELECT COUNT(*) AS total, SUM(CASE WHEN status_code = 0 THEN 1 ELSE 0 END) AS healthy, SUM(CASE WHEN status_code = 1 THEN 1 ELSE 0 END) AS warning, SUM(CASE WHEN status_code >= 2 THEN 1 ELSE 0 END) AS errored, MAX(collected_at) AS last_update FROM ad_replication_status`,
      agentCount: `SELECT COUNT(*) AS agent_count FROM ad_agent_heartbeat WHERE last_heartbeat_at IS NOT NULL`,
      siteMatrix: `SELECT source_site, dest_site, SUM(CASE WHEN status_code >= 2 THEN 1 ELSE 0 END) AS error_count, SUM(CASE WHEN status_code = 1 THEN 1 ELSE 0 END) AS warning_count, COUNT(*) AS total FROM ad_replication_status WHERE source_site IS NOT NULL AND dest_site IS NOT NULL GROUP BY source_site, dest_site ORDER BY source_site, dest_site`,
      topology: `SELECT source_site, dest_site, source_dc, dest_dc, status_code, last_success_time FROM ad_replication_status`,
      errors: `SELECT source_dc, dest_dc, source_site, dest_site, naming_context, status_code, last_success_time, last_attempt_time, DATEDIFF(MINUTE, last_success_time, last_attempt_time) AS duration_minutes FROM ad_replication_status WHERE status_code <> 0 ORDER BY last_attempt_time DESC`,
      agents: `SELECT agent_id, last_heartbeat_at, agent_version, last_report_at, last_report_status, pending_queue_size, DATEDIFF(SECOND, last_heartbeat_at, SYSUTCDATETIME()) AS seconds_since_heartbeat FROM ad_agent_heartbeat ORDER BY agent_id`,
      siteLookup: `SELECT site_id, site_name, region_code, is_hub, description FROM ad_sites WHERE site_name = ?`,
      dcsBySite: `SELECT dc_name, os_version, is_pdc, is_gc, is_rid_master, is_schema_master, is_domain_naming_master, is_infrastructure_master, discovered_at, discovered_by_agent_id FROM ad_dcs WHERE site_id = ? ORDER BY dc_name`,
      dcReplicationLinks: (placeholders) => `SELECT source_dc, dest_dc, naming_context, status_code, last_success_time, last_attempt_time, DATEDIFF(MINUTE, last_success_time, last_attempt_time) AS duration_minutes FROM ad_replication_status WHERE source_dc IN (${placeholders}) AND dest_dc IN (${placeholders}) ORDER BY source_dc, dest_dc, naming_context`,
      refreshSeconds: `SELECT config_value FROM system_config WHERE config_key = 'site_matrix_refresh_seconds'`
    },
    heartbeat: {
      upsert: `MERGE INTO ad_agent_heartbeat AS t USING (SELECT ? AS agent_id, ? AS agent_version, ? AS last_report_at, ? AS last_report_status, ? AS pending_queue_size) AS s ON t.agent_id = s.agent_id WHEN MATCHED THEN UPDATE SET last_heartbeat_at = SYSUTCDATETIME(), agent_version = s.agent_version, last_report_at = s.last_report_at, last_report_status = s.last_report_status, pending_queue_size = s.pending_queue_size WHEN NOT MATCHED THEN INSERT (agent_id, last_heartbeat_at, agent_version, last_report_at, last_report_status, pending_queue_size) VALUES (s.agent_id, SYSUTCDATETIME(), s.agent_version, s.last_report_at, s.last_report_status, s.pending_queue_size)`
    }
  }
};

export function buildSql(dialect) {
  const variants = VARIANTS[dialect];
  if (!variants) throw new Error(`unknown dialect: ${dialect}`);
  // Return a deeply-frozen shallow-copied tree so consumers can't mutate it.
  const out = {};
  for (const [domain, queries] of Object.entries(variants)) {
    out[domain] = Object.freeze({ ...queries });
  }
  return Object.freeze(out);
}

export const SUPPORTED_DIALECTS = Object.keys(VARIANTS);