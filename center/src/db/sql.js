// Central SQL registry. One frozen dictionary per dialect, selected at boot
// by db.dialect. Service code reads db.sql.<domain>.<query> and gets back a
// plain string for the active dialect — never a sub-object.
//
// Placeholders: use `?` only (mysql2 style). The mssql driver wrapper
// rewrites `?` -> `@p1, @p2, ...` at execute() time; service code never
// sees @p1.

import { memberServers } from './sql/member-servers.js';
import { serverGroups } from './sql/server-groups.js';
import { alertRules } from './sql/alert-rules.js';
import { alertEvents } from './sql/alert-events.js';
import { alertOutbox } from './sql/alert-outbox.js';
import { alertMetrics } from './sql/alert-metrics.js';

const VARIANTS = {
  mysql: {
    health: {
      ping: 'SELECT 1 AS ok',
      lastHeartbeat: 'SELECT last_heartbeat_at AS last FROM ad_agent_heartbeat ORDER BY last_heartbeat_at DESC LIMIT 1'
    },
    replication: {
      upsertStatus: `INSERT INTO ad_replication_status (collected_at, agent_id, source_dc, dest_dc, source_site, dest_site, naming_context, last_success_time, last_attempt_time, status_code, error_message, users_count, groups_count, gpos_count, locked_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE collected_at = VALUES(collected_at), agent_id = VALUES(agent_id), source_site = VALUES(source_site), dest_site = VALUES(dest_site), last_success_time = VALUES(last_success_time), last_attempt_time = VALUES(last_attempt_time), status_code = VALUES(status_code), error_message = VALUES(error_message), users_count = VALUES(users_count), groups_count = VALUES(groups_count), gpos_count = VALUES(gpos_count), locked_count = VALUES(locked_count)`,
      upsertHistory: `INSERT INTO ad_replication_history (collected_at, agent_id, source_dc, dest_dc, naming_context, last_success_time, status_code, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      listRecent: `SELECT source_dc, dest_dc, source_site, dest_site, status_code, collected_at FROM ad_replication_status ORDER BY collected_at DESC LIMIT ?`,
      listBySite: `SELECT source_dc, dest_dc, source_site, dest_site, status_code, collected_at FROM ad_replication_status WHERE source_site = ? OR dest_site = ? ORDER BY collected_at DESC LIMIT ?`,
      latestSummaryPerDc: `SELECT t1.source_dc, t1.users_count, t1.groups_count, t1.gpos_count, t1.locked_count, t1.collected_at FROM ad_replication_status t1 WHERE t1.naming_context = '__dc_summary__' AND t1.collected_at = (SELECT MAX(t2.collected_at) FROM ad_replication_status t2 WHERE t2.source_dc = t1.source_dc AND t2.naming_context = '__dc_summary__') ORDER BY t1.source_dc`,
      partnersCount: `SELECT COUNT(*) AS c FROM ad_replication_status WHERE source_dc = ? AND naming_context <> '__dc_summary__' AND collected_at BETWEEN ? - INTERVAL ? MINUTE AND ? + INTERVAL ? MINUTE`
    },
    discovery: {
      upsertDc: `INSERT INTO ad_dcs (dc_name, site_hint, os_version, when_created, is_pdc, is_gc, is_rid_master, is_schema_master, is_domain_naming_master, is_infrastructure_master, discovered_at, discovered_by_agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE site_hint = VALUES(site_hint), os_version = VALUES(os_version), when_created = VALUES(when_created), is_pdc = VALUES(is_pdc), is_gc = VALUES(is_gc), is_rid_master = VALUES(is_rid_master), is_schema_master = VALUES(is_schema_master), is_domain_naming_master = VALUES(is_domain_naming_master), is_infrastructure_master = VALUES(is_infrastructure_master), discovered_at = NOW(), discovered_by_agent_id = VALUES(discovered_by_agent_id)`
    },
    users: {
      findByUsername: `SELECT u.id, u.username, u.password_hash, u.role_id, u.status, u.token_version, r.role_name, GROUP_CONCAT(rp.permission) AS permissions FROM sys_users u LEFT JOIN sys_roles r ON u.role_id = r.id LEFT JOIN role_permissions rp ON rp.role_id = r.id WHERE u.username = ? GROUP BY u.id, u.username, u.password_hash, u.role_id, u.status, u.token_version, r.role_name LIMIT 1`,
      list: 'SELECT u.id, u.username, u.role_id, u.status, u.last_login_at, u.created_at, r.role_name FROM sys_users u LEFT JOIN sys_roles r ON u.role_id = r.id ORDER BY u.id',
      create: 'INSERT INTO sys_users (username, password_hash, role_id, status) VALUES (?, ?, ?, ?)',
      update: 'UPDATE sys_users SET password_hash = COALESCE(?, password_hash), role_id = COALESCE(?, role_id), status = COALESCE(?, status) WHERE id = ?',
      delete: 'DELETE FROM sys_users WHERE id = ?',
      recordLogin: 'UPDATE sys_users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?',
      bumpTokenVersion: 'UPDATE sys_users SET token_version = token_version + 1 WHERE id = ?',
      getTokenVersion: 'SELECT token_version FROM sys_users WHERE id = ?',
      getAuthStatus: 'SELECT token_version, status FROM sys_users WHERE id = ?',
      countAdmins: `SELECT COUNT(*) AS n FROM sys_users u JOIN sys_roles r ON u.role_id = r.id WHERE r.role_name = 'admin'`,
      createAdmin: 'INSERT INTO sys_users (username, password_hash, role_id) VALUES (?, ?, (SELECT id FROM sys_roles WHERE role_name = \'admin\'))',
      count: 'SELECT COUNT(*) AS n FROM sys_users u JOIN sys_roles r ON u.role_id = r.id WHERE r.role_name = \'admin\''
    },
    roles: {
      list: `SELECT r.id, r.role_name, GROUP_CONCAT(rp.permission) AS permissions FROM sys_roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id GROUP BY r.id, r.role_name ORDER BY r.id`
    },
    config: {
      getAll: 'SELECT config_key, config_value FROM system_config',
      upsert: `INSERT INTO system_config (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_at = CURRENT_TIMESTAMP`,
      setAgentToken: `INSERT INTO system_config (config_key, config_value) VALUES ('agent_token', ?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_at = CURRENT_TIMESTAMP`,
      getAgentTokenBundle: `SELECT config_key, config_value FROM system_config WHERE config_key IN ('agent_token_current', 'agent_token_previous', 'agent_token_rotated_at', 'agent_token_previous_ttl_days')`,
      audit: {
        write: 'INSERT INTO sys_config_audit (config_key, old_value, new_value, changed_by, change_type) VALUES (?, ?, ?, ?, ?)',
        list: `SELECT a.id, a.config_key, a.old_value, a.new_value, a.changed_by, a.change_type, a.changed_at, u.username AS changed_by_username FROM sys_config_audit a LEFT JOIN sys_users u ON a.changed_by = u.id ORDER BY a.changed_at DESC, a.id DESC LIMIT 20`,
        getById: 'SELECT id, config_key, old_value, new_value, change_type FROM sys_config_audit WHERE id = ?'
      }
    },
    audit: {
      write: 'INSERT INTO audit_logs (user_id, action, target, payload) VALUES (?, ?, ?, ?)',
      // SELECT for paginated listing. The dialect owns both pagination syntax
      // and parameter order: callers pass semantic (size, offset) values.
      list: (where) => ({
        sql: `SELECT a.id, a.user_id AS userId, a.action, a.target, a.payload,
                a.created_at AS createdAt, u.username AS username
         FROM audit_logs a
         LEFT JOIN sys_users u ON a.user_id = u.id
         ${where}
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT ? OFFSET ?`,
        listParams: (whereParams, size, offset) => [...whereParams, size, offset]
      }),
      count: `SELECT COUNT(*) AS total FROM audit_logs a`,
      // Placeholder count is built dynamically by the caller so any category
      // (any number of actions) round-trips without losing the bound-param
      // pattern that the mssql driver wrapper expects.
      badge: (actionList) => `SELECT COUNT(*) AS total FROM audit_logs a WHERE a.action IN (${actionList.map(() => '?').join(',')})`,
      // I4: retention purge. Deletes rows older than the bound date. Both
      // dialects accept DATE_SUB/DATEADD with the same parameter shape
      // (single bound datetime), so the SQL stays portable.
      purge: 'DELETE FROM audit_logs WHERE created_at < ?'
    },
    sites: {
      listAll: 'SELECT site, region_code, is_hub FROM ad_sites',
      listCatalog: `SELECT s.site_id AS id, s.site_name AS siteName, s.region_code AS regionCode, s.is_hub AS isHub, s.description, s.created_at AS createdAt, s.updated_at AS updatedAt, (SELECT COUNT(*) FROM ad_dcs d WHERE d.site_id = s.site_id) AS dcCount FROM ad_sites s ORDER BY s.site_name`,
      findByName: 'SELECT site_id FROM ad_sites WHERE site_name = ?',
      create: 'INSERT INTO ad_sites (site_name, region_code, is_hub, description) VALUES (?, ?, ?, ?)',
      upsert: `INSERT INTO ad_sites (site_name, region_code, is_hub, description) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE region_code = VALUES(region_code), is_hub = VALUES(is_hub), description = VALUES(description)`,
      update: 'UPDATE ad_sites SET site_name = ?, region_code = ?, is_hub = ?, description = ? WHERE site_id = ?',
      updatePartial: (fields) => `UPDATE ad_sites SET ${fields.join(', ')} WHERE site_id = ?`,
      delete: 'DELETE FROM ad_sites WHERE site_id = ?',
      unbindDcs: 'UPDATE ad_dcs SET site_id = NULL WHERE site_id = ?'
    },
    dcs: {
      listCatalog: `SELECT d.dc_name AS dcName, d.site_id AS siteId, s.site_name AS siteName, d.site_hint AS siteHint, d.os_version AS osVersion, d.when_created AS whenCreated, d.is_pdc AS isPdc, d.is_gc AS isGc, d.is_rid_master AS isRidMaster, d.is_schema_master AS isSchemaMaster, d.is_domain_naming_master AS isDomainNamingMaster, d.is_infrastructure_master AS isInfrastructureMaster, d.discovered_at AS discoveredAt, d.discovered_by_agent_id AS discoveredByAgentId FROM ad_dcs d LEFT JOIN ad_sites s ON d.site_id = s.site_id ORDER BY d.dc_name`,
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
      upsert: `INSERT INTO ad_agent_heartbeat (agent_id, last_heartbeat_at, agent_version, last_report_at, last_report_status, pending_queue_size) VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE last_heartbeat_at = CURRENT_TIMESTAMP, agent_version = VALUES(agent_version), last_report_at = VALUES(last_report_at), last_report_status = VALUES(last_report_status), pending_queue_size = VALUES(pending_queue_size)`,
      agentsList: `SELECT h.agent_id, h.agent_version, h.last_heartbeat_at, h.last_report_at, h.last_report_status, h.pending_queue_size
             FROM ad_agent_heartbeat h
             ORDER BY h.agent_id`,
      dcsList: `SELECT h.agent_id, h.agent_version, h.last_heartbeat_at, h.last_report_at, h.last_report_status, h.pending_queue_size,
                 d.dc_name, d.ip_address, d.os_version, d.is_pdc,
                 s.site_name, s.region_code
          FROM ad_agent_heartbeat h
          LEFT JOIN ad_dcs d ON d.dc_name = h.agent_id
          LEFT JOIN ad_sites s ON s.site_id = d.site_id
          ORDER BY h.agent_id`,
      reportSummaryFor: (agentId, sinceIso) =>
        `SELECT s.source_dc, s.dest_dc, s.status_code, s.error_message, s.collected_at
         FROM ad_replication_status s
         INNER JOIN (
           SELECT MAX(collected_at) AS max_collected
           FROM ad_replication_status
           WHERE agent_id = ? AND collected_at >= ?
         ) m ON s.collected_at = m.max_collected AND s.agent_id = ?
         ORDER BY s.source_dc, s.dest_dc`,
      latestReportEntries: (agentId, sinceIso, limit) =>
        `SELECT collected_at, source_dc, dest_dc, source_site, dest_site, naming_context,
                status_code, error_message, last_success_time, last_attempt_time
         FROM ad_replication_status
         WHERE agent_id = ?
           AND collected_at = (
             SELECT MAX(collected_at) FROM ad_replication_status
             WHERE agent_id = ? AND collected_at >= ?
           )
         ORDER BY source_dc, dest_dc
         LIMIT ${Number(limit)}`
    },
    ports: {
      list: 'SELECT id, port, label, sort_order AS sortOrder FROM system_ports ORDER BY sort_order, port',
      listForAgent: `SELECT sp.port, sp.label, aps.ok, aps.latency_ms AS latencyMs, aps.last_checked_at AS lastCheckedAt
        FROM system_ports sp
        INNER JOIN ad_agent_port_status aps ON aps.port = sp.port AND aps.agent_id = ?
        ORDER BY sp.sort_order, sp.port`,
      create: 'INSERT INTO system_ports (port, label, sort_order) VALUES (?, ?, ?)',
      findByPort: 'SELECT id FROM system_ports WHERE port = ?',
      updatePartial: (fields) => `UPDATE system_ports SET ${fields.join(', ')} WHERE id = ?`,
      delete: 'DELETE FROM system_ports WHERE id = ?'
    },
    portStatus: {
      // Single-row upsert; called in a loop inside a transaction. MySQL flavor.
      upsertOne: `INSERT INTO ad_agent_port_status
        (agent_id, port, ok, latency_ms, last_checked_at)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          ok = VALUES(ok),
          latency_ms = VALUES(latency_ms),
          last_checked_at = VALUES(last_checked_at)`,
      listForAgents: (placeholders) => `SELECT aps.agent_id AS agentId, aps.port, aps.ok, aps.latency_ms AS latencyMs, aps.last_checked_at AS lastCheckedAt,
               sp.label AS label
        FROM ad_agent_port_status aps
        INNER JOIN system_ports sp ON aps.port = sp.port
        WHERE aps.agent_id IN (${placeholders})
        ORDER BY sp.sort_order, sp.port`
    },
    installedPackages: {
      // Plugin system registry (migration 004). Upsert by `name`.
      upsert: `INSERT INTO installed_packages
        (name, version, type, manifest_json, enabled, params_json, installed_at, updated_at, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          version = VALUES(version),
          type = VALUES(type),
          manifest_json = VALUES(manifest_json),
          enabled = VALUES(enabled),
          params_json = VALUES(params_json),
          updated_at = VALUES(updated_at),
          source = VALUES(source)`,
      list: `SELECT * FROM installed_packages ORDER BY name`,
      listEnabled: `SELECT * FROM installed_packages WHERE enabled = 1 ORDER BY name`,
      get: `SELECT * FROM installed_packages WHERE name = ?`,
      delete: `DELETE FROM installed_packages WHERE name = ?`
    },
    // Drop-failure tracking (migration 013). Records pkg_<name> schemas
    // left behind when DROP SCHEMA fails (FKs, perms, transient DB errors)
    // so admin can manually clean up. T7 writes, T10 reads+deletes,
    // T12 renders.
    orphanSchemas: {
      upsert: `INSERT INTO orphan_schemas (name, last_seen_at, note)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE
          last_seen_at = VALUES(last_seen_at),
          note = VALUES(note)`,
      list: `SELECT * FROM orphan_schemas ORDER BY last_seen_at DESC`,
      delete: `DELETE FROM orphan_schemas WHERE name = ?`
    },
    metricGauge: {
      upsertLatest: `INSERT INTO metric_gauge
        (agent_id, metric_id, ts, value, unit, threshold_warn, threshold_crit)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          ts = VALUES(ts),
          value = VALUES(value),
          unit = VALUES(unit),
          threshold_warn = VALUES(threshold_warn),
          threshold_crit = VALUES(threshold_crit)`,
      listByAgent: (metricIdPlaceholder) =>
        metricIdPlaceholder
          ? `SELECT * FROM metric_gauge WHERE agent_id = ? AND metric_id = ?`
          : `SELECT * FROM metric_gauge WHERE agent_id = ?`
    },
    metricCounter: {
      upsertLatest: `INSERT INTO metric_counter
        (agent_id, metric_id, ts, value, delta, unit)
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          ts = VALUES(ts),
          value = VALUES(value),
          delta = VALUES(delta),
          unit = VALUES(unit)`,
      listByAgent: (metricIdPlaceholder) =>
        metricIdPlaceholder
          ? `SELECT * FROM metric_counter WHERE agent_id = ? AND metric_id = ?`
          : `SELECT * FROM metric_counter WHERE agent_id = ?`
    },
    metricTimeseries: {
      append: `INSERT INTO metric_timeseries
        (agent_id, metric_id, ts, value, tags_json, unit)
        VALUES (?, ?, ?, ?, ?, ?)`,
      // Range query (agent_id + metric_id required; from/to optional).
      // The caller pushes params in order: [agent_id, metric_id, from?, to?].
      list: (includeRange) => {
        const where = ['agent_id = ?', 'metric_id = ?'];
        if (includeRange?.from) where.push('ts >= ?');
        if (includeRange?.to) where.push('ts <= ?');
        return `SELECT * FROM metric_timeseries WHERE ${where.join(' AND ')} ORDER BY ts ASC`;
      }
    },
    metricStatus: {
      upsertLatest: `INSERT INTO metric_status
        (agent_id, metric_id, ts, status, message)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          ts = VALUES(ts),
          status = VALUES(status),
          message = VALUES(message)`,
      listByAgent: (metricIdPlaceholder) =>
        metricIdPlaceholder
          ? `SELECT * FROM metric_status WHERE agent_id = ? AND metric_id = ?`
          : `SELECT * FROM metric_status WHERE agent_id = ?`
    },
    packageRuns: {
      insert: `INSERT INTO package_runs
        (agent_id, package_name, started_at, finished_at, exit_code, stdout_preview, stderr_preview, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      // listRecent is built dynamically per call (LIMIT is integer-only);
      // see center/src/db/sql/package-runs.js → packageRuns.listRecent.
    },
    lockout: {
      upsertEvent: `INSERT INTO ad_lockout_events
        (occurred_at, collected_at, agent_id, dc_name, event_record_id,
         target_user_name, subject_user_name, subject_domain, caller_computer_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE collected_at = VALUES(collected_at)`,
      search: `SELECT occurred_at, dc_name, target_user_name, subject_user_name,
                      subject_domain, caller_computer_name
                 FROM ad_lockout_events
                WHERE occurred_at >= ?
                  AND (? = '' OR target_user_name = ?)
                  AND (? = '' OR dc_name = ?)
                  AND (? = '' OR caller_computer_name = ?)
                ORDER BY occurred_at ASC
                LIMIT 500`
    },
    schemaMigrations: {
      list: 'SELECT version, description, type, script, checksum, applied_at, applied_by, execution_ms, status, error_message FROM schema_migrations',
      findByVersion: 'SELECT version, description, type, script, checksum, applied_at, applied_by, execution_ms, status, error_message FROM schema_migrations WHERE version = ?',
      upsert: `INSERT INTO schema_migrations
        (version, description, type, script, checksum, applied_at, execution_ms, applied_by, status, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          description   = VALUES(description),
          type          = VALUES(type),
          script        = VALUES(script),
          checksum      = VALUES(checksum),
          applied_at    = VALUES(applied_at),
          execution_ms  = VALUES(execution_ms),
          applied_by    = VALUES(applied_by),
          status        = VALUES(status),
          error_message = VALUES(error_message)`,
      deleteFailed: "DELETE FROM schema_migrations WHERE version = ? AND status = 'failed'"
    },
    // Port self-probe state (migration 012). One row per port_role, upserted
    // at 1 Hz by the probe service. getAll backs /api/probe and the admin
    // monitor panel; upsertRow is the single-row writer.
    probeState: {
      getAll: 'SELECT port_role, status, latency_ms, last_probe_at, last_up_at, consecutive_failures FROM probe_state ORDER BY port_role',
      upsertRow: (portRole, status, latencyMs, lastProbeAt, lastUpAt, consecutiveFailures) =>
        `INSERT INTO probe_state (port_role, status, latency_ms, last_probe_at, last_up_at, consecutive_failures)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           status = VALUES(status),
           latency_ms = VALUES(latency_ms),
           last_probe_at = VALUES(last_probe_at),
           last_up_at = VALUES(last_up_at),
           consecutive_failures = VALUES(consecutive_failures)`
    },
    // Existence probes for migration verify markers. Returns one row when the
    // artifact exists, zero rows when it doesn't. Scoped to the connection's
    // own database so a same-named table in another schema can't false-positive.
    probe: {
      table: `SELECT 1 AS ok FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
      column: `SELECT 1 AS ok FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`
    },
    // Non-AD server management (migration 014). Eight tables total split
    // across five domains so services can scope their reads: member-servers
    // (the inventory), server-groups (groups + memberships + per-host package
    // assignments), alert-rules (rules + state), alert-events (firing log),
    // alert-outbox (email delivery queue).
    memberServers: memberServers.mysql,
    serverGroups: serverGroups.mysql,
    alertRules: alertRules.mysql,
    alertEvents: alertEvents.mysql,
    alertOutbox: alertOutbox.mysql,
    alertMetrics: alertMetrics.mysql
  },
  mssql: {
    health: {
      ping: 'SELECT 1 AS ok',
      lastHeartbeat: 'SELECT TOP 1 last_heartbeat_at AS last FROM ad_agent_heartbeat ORDER BY last_heartbeat_at DESC'
    },
    replication: {
      upsertStatus: `MERGE INTO ad_replication_status AS t USING (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)) AS s(collected_at, agent_id, source_dc, dest_dc, source_site, dest_site, naming_context, last_success_time, last_attempt_time, status_code, error_message, users_count, groups_count, gpos_count, locked_count) ON t.source_dc = s.source_dc AND t.dest_dc = s.dest_dc AND t.naming_context = s.naming_context WHEN MATCHED THEN UPDATE SET collected_at = s.collected_at, agent_id = s.agent_id, source_site = s.source_site, dest_site = s.dest_site, last_success_time = s.last_success_time, last_attempt_time = s.last_attempt_time, status_code = s.status_code, error_message = s.error_message, users_count = s.users_count, groups_count = s.groups_count, gpos_count = s.gpos_count, locked_count = s.locked_count WHEN NOT MATCHED THEN INSERT (collected_at, agent_id, source_dc, dest_dc, source_site, dest_site, naming_context, last_success_time, last_attempt_time, status_code, error_message, users_count, groups_count, gpos_count, locked_count) VALUES (s.collected_at, s.agent_id, s.source_dc, s.dest_dc, s.source_site, s.dest_site, s.naming_context, s.last_success_time, s.last_attempt_time, s.status_code, s.error_message, s.users_count, s.groups_count, s.gpos_count, s.locked_count);`,
      upsertHistory: `INSERT INTO ad_replication_history (collected_at, agent_id, source_dc, dest_dc, naming_context, last_success_time, status_code, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      listRecent: `SELECT TOP (?) source_dc, dest_dc, source_site, dest_site, status_code, collected_at FROM ad_replication_status ORDER BY collected_at DESC`,
      listBySite: `SELECT TOP (?) source_dc, dest_dc, source_site, dest_site, status_code, collected_at FROM ad_replication_status WHERE source_site = ? OR dest_site = ? ORDER BY collected_at DESC`,
      latestSummaryPerDc: `SELECT t.source_dc, t.users_count, t.groups_count, t.gpos_count, t.locked_count, t.collected_at FROM ad_replication_status t OUTER APPLY (SELECT TOP 1 collected_at, users_count, groups_count, gpos_count, locked_count FROM ad_replication_status WHERE source_dc = t.source_dc AND naming_context = '__dc_summary__' ORDER BY collected_at DESC) s WHERE t.naming_context = '__dc_summary__' GROUP BY t.source_dc, t.users_count, t.groups_count, t.gpos_count, t.locked_count, t.collected_at ORDER BY t.source_dc`,
      partnersCount: `SELECT COUNT(*) AS c FROM ad_replication_status WHERE source_dc = ? AND naming_context <> '__dc_summary__' AND collected_at BETWEEN DATEADD(MINUTE, -?, ?) AND DATEADD(MINUTE, ?, ?)`
    },
    discovery: {
      upsertDc: `MERGE INTO ad_dcs AS t USING (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)) AS s(dc_name, site_hint, os_version, when_created, is_pdc, is_gc, is_rid_master, is_schema_master, is_domain_naming_master, is_infrastructure_master, discovered_at, discovered_by_agent_id) ON t.dc_name = s.dc_name WHEN MATCHED THEN UPDATE SET site_hint = s.site_hint, os_version = s.os_version, when_created = s.when_created, is_pdc = s.is_pdc, is_gc = s.is_gc, is_rid_master = s.is_rid_master, is_schema_master = s.is_schema_master, is_domain_naming_master = s.is_domain_naming_master, is_infrastructure_master = s.is_infrastructure_master, discovered_at = SYSUTCDATETIME(), discovered_by_agent_id = s.discovered_by_agent_id WHEN NOT MATCHED THEN INSERT (dc_name, site_hint, os_version, when_created, is_pdc, is_gc, is_rid_master, is_schema_master, is_domain_naming_master, is_infrastructure_master, discovered_at, discovered_by_agent_id) VALUES (s.dc_name, s.site_hint, s.os_version, s.when_created, s.is_pdc, s.is_gc, s.is_rid_master, s.is_schema_master, s.is_domain_naming_master, s.is_infrastructure_master, s.discovered_at, s.discovered_by_agent_id);`
    },
    users: {
      findByUsername: `SELECT TOP 1 u.id, u.username, u.password_hash, u.role_id, u.status, u.token_version, r.role_name, STRING_AGG(rp.permission, ',') AS permissions FROM sys_users u LEFT JOIN sys_roles r ON u.role_id = r.id LEFT JOIN role_permissions rp ON rp.role_id = r.id WHERE u.username = ? GROUP BY u.id, u.username, u.password_hash, u.role_id, u.status, u.token_version, r.role_name`,
      list: 'SELECT u.id, u.username, u.role_id, u.status, u.last_login_at, u.created_at, r.role_name FROM sys_users u LEFT JOIN sys_roles r ON u.role_id = r.id ORDER BY u.id',
      create: 'INSERT INTO sys_users (username, password_hash, role_id, status) VALUES (?, ?, ?, ?)',
      update: 'UPDATE sys_users SET password_hash = COALESCE(?, password_hash), role_id = COALESCE(?, role_id), status = COALESCE(?, status) WHERE id = ?',
      delete: 'DELETE FROM sys_users WHERE id = ?',
      recordLogin: 'UPDATE sys_users SET last_login_at = SYSUTCDATETIME() WHERE id = ?',
      bumpTokenVersion: 'UPDATE sys_users SET token_version = token_version + 1 WHERE id = @id',
      getTokenVersion: 'SELECT token_version FROM sys_users WHERE id = @id',
      getAuthStatus: 'SELECT token_version, status FROM sys_users WHERE id = @id',
      countAdmins: `SELECT COUNT(*) AS n FROM sys_users u JOIN sys_roles r ON u.role_id = r.id WHERE r.role_name = 'admin'`,
      createAdmin: 'INSERT INTO sys_users (username, password_hash, role_id) SELECT ?, ?, id FROM sys_roles WHERE role_name = \'admin\'',
      count: 'SELECT COUNT(*) AS n FROM sys_users u JOIN sys_roles r ON u.role_id = r.id WHERE r.role_name = \'admin\''
    },
    roles: {
      list: `SELECT r.id, r.role_name, STRING_AGG(rp.permission, ',') AS permissions FROM sys_roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id GROUP BY r.id, r.role_name ORDER BY r.id`
    },
    config: {
      getAll: 'SELECT config_key, config_value FROM system_config',
      upsert: `MERGE INTO system_config AS t USING (SELECT ? AS config_key, ? AS config_value) AS s ON t.config_key = s.config_key WHEN MATCHED THEN UPDATE SET config_value = s.config_value, updated_at = SYSUTCDATETIME() WHEN NOT MATCHED THEN INSERT (config_key, config_value) VALUES (s.config_key, s.config_value);`,
      setAgentToken: `MERGE INTO system_config AS t USING (SELECT 'agent_token' AS config_key, ? AS config_value) AS s ON t.config_key = s.config_key WHEN MATCHED THEN UPDATE SET config_value = s.config_value, updated_at = SYSUTCDATETIME() WHEN NOT MATCHED THEN INSERT (config_key, config_value) VALUES (s.config_key, s.config_value);`,
      getAgentTokenBundle: `SELECT config_key, config_value FROM system_config WHERE config_key IN ('agent_token_current', 'agent_token_previous', 'agent_token_rotated_at', 'agent_token_previous_ttl_days')`,
      audit: {
        write: 'INSERT INTO sys_config_audit (config_key, old_value, new_value, changed_by, change_type) VALUES (?, ?, ?, ?, CAST(? AS VARCHAR(16)))',
        list: `SELECT TOP 20 a.id, a.config_key, a.old_value, a.new_value, a.changed_by, a.change_type, a.changed_at, u.username AS changed_by_username FROM sys_config_audit a LEFT JOIN sys_users u ON a.changed_by = u.id ORDER BY a.changed_at DESC, a.id DESC`,
        getById: 'SELECT id, config_key, old_value, new_value, change_type FROM sys_config_audit WHERE id = ?'
      }
    },
    audit: {
      write: 'INSERT INTO audit_logs (user_id, action, target, payload) VALUES (?, ?, ?, ?)',
      // SELECT for paginated listing. The dialect owns both pagination syntax
      // and parameter order: callers pass semantic (size, offset) values.
      list: (where) => ({
        sql: `SELECT a.id, a.user_id AS userId, a.action, a.target, a.payload,
                a.created_at AS createdAt, u.username AS username
         FROM audit_logs a
         LEFT JOIN sys_users u ON a.user_id = u.id
         ${where}
         ORDER BY a.created_at DESC, a.id DESC
         OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`,
        listParams: (whereParams, size, offset) => [...whereParams, offset, size]
      }),
      count: `SELECT COUNT(*) AS total FROM audit_logs a`,
      badge: (actionList) => `SELECT COUNT(*) AS total FROM audit_logs a WHERE a.action IN (${actionList.map(() => '?').join(',')})`,
      // I4: retention purge — caller computes the cutoff date in JS
      // (new Date(Date.now() - days * 86400_000)) and binds as a Date param.
      // mssql driver coerces JS Date → DATETIME2 automatically.
      purge: 'DELETE FROM audit_logs WHERE created_at < ?'
    },
    sites: {
      listAll: 'SELECT site, region_code, is_hub FROM ad_sites',
      listCatalog: `SELECT s.site_id AS id, s.site_name AS siteName, s.region_code AS regionCode, s.is_hub AS isHub, s.description, s.created_at AS createdAt, s.updated_at AS updatedAt, (SELECT COUNT(*) FROM ad_dcs d WHERE d.site_id = s.site_id) AS dcCount FROM ad_sites s ORDER BY s.site_name`,
      findByName: 'SELECT site_id FROM ad_sites WHERE site_name = ?',
      create: 'INSERT INTO ad_sites (site_name, region_code, is_hub, description) VALUES (?, ?, ?, ?)',
      upsert: `MERGE INTO ad_sites AS t USING (SELECT ? AS site_name, ? AS region_code, ? AS is_hub, ? AS description) AS s ON t.site_name = s.site_name WHEN MATCHED THEN UPDATE SET region_code = s.region_code, is_hub = s.is_hub, description = s.description WHEN NOT MATCHED THEN INSERT (site_name, region_code, is_hub, description) VALUES (s.site_name, s.region_code, s.is_hub, s.description);`,
      update: 'UPDATE ad_sites SET site_name = ?, region_code = ?, is_hub = ?, description = ? WHERE site_id = ?',
      updatePartial: (fields) => `UPDATE ad_sites SET ${fields.join(', ')} WHERE site_id = ?`,
      delete: 'DELETE FROM ad_sites WHERE site_id = ?',
      unbindDcs: 'UPDATE ad_dcs SET site_id = NULL WHERE site_id = ?'
    },
    dcs: {
      listCatalog: `SELECT d.dc_name AS dcName, d.site_id AS siteId, s.site_name AS siteName, d.site_hint AS siteHint, d.os_version AS osVersion, d.when_created AS whenCreated, d.is_pdc AS isPdc, d.is_gc AS isGc, d.is_rid_master AS isRidMaster, d.is_schema_master AS isSchemaMaster, d.is_domain_naming_master AS isDomainNamingMaster, d.is_infrastructure_master AS isInfrastructureMaster, d.discovered_at AS discoveredAt, d.discovered_by_agent_id AS discoveredByAgentId FROM ad_dcs d LEFT JOIN ad_sites s ON d.site_id = s.site_id ORDER BY d.dc_name`,
      assignSite: 'UPDATE ad_dcs SET site_id = ? WHERE dc_name = ?',
      assignSiteUnbind: 'UPDATE ad_dcs SET site_id = NULL WHERE dc_name = ?'
    },
    dashboard: {
      overviewCounts: `SELECT COUNT(*) AS total, SUM(CASE WHEN status_code = 0 THEN 1 ELSE 0 END) AS healthy, SUM(CASE WHEN status_code = 1 THEN 1 ELSE 0 END) AS warning, SUM(CASE WHEN status_code >= 2 THEN 1 ELSE 0 END) AS errored, MAX(collected_at) AS last_update FROM ad_replication_status`,
      agentCount: `SELECT COUNT(*) AS agent_count FROM ad_agent_heartbeat WHERE last_heartbeat_at IS NOT NULL`,
      siteMatrix: `SELECT source_site, dest_site, SUM(CASE WHEN status_code >= 2 THEN 1 ELSE 0 END) AS error_count, SUM(CASE WHEN status_code = 1 THEN 1 ELSE 0 END) AS warning_count, COUNT(*) AS total FROM ad_replication_status WHERE source_site IS NOT NULL AND dest_site IS NOT NULL GROUP BY source_site, dest_site ORDER BY source_site, dest_site`,
      topology: `SELECT source_site, dest_site, source_dc, dest_dc, status_code, last_success_time FROM ad_replication_status`,
      errors: `SELECT source_dc, dest_dc, source_site, dest_site, naming_context, status_code, last_success_time, last_attempt_time, CASE WHEN last_success_time IS NULL OR last_attempt_time IS NULL THEN NULL ELSE CAST(DATEDIFF_BIG(SECOND, last_success_time, last_attempt_time) AS float) / 60.0 END AS duration_minutes FROM ad_replication_status WHERE status_code <> 0 ORDER BY last_attempt_time DESC`,
      agents: `SELECT agent_id, last_heartbeat_at, agent_version, last_report_at, last_report_status, pending_queue_size, CASE WHEN last_heartbeat_at IS NULL THEN NULL ELSE CAST(DATEDIFF_BIG(SECOND, last_heartbeat_at, SYSUTCDATETIME()) AS float) END AS seconds_since_heartbeat FROM ad_agent_heartbeat ORDER BY agent_id`,
      siteLookup: `SELECT site_id, site_name, region_code, is_hub, description FROM ad_sites WHERE site_name = ?`,
      dcsBySite: `SELECT dc_name, os_version, is_pdc, is_gc, is_rid_master, is_schema_master, is_domain_naming_master, is_infrastructure_master, discovered_at, discovered_by_agent_id FROM ad_dcs WHERE site_id = ? ORDER BY dc_name`,
      dcReplicationLinks: (placeholders) => `SELECT source_dc, dest_dc, naming_context, status_code, last_success_time, last_attempt_time, CASE WHEN last_success_time IS NULL OR last_attempt_time IS NULL THEN NULL ELSE CAST(DATEDIFF_BIG(SECOND, last_success_time, last_attempt_time) AS float) / 60.0 END AS duration_minutes FROM ad_replication_status WHERE source_dc IN (${placeholders}) AND dest_dc IN (${placeholders}) ORDER BY source_dc, dest_dc, naming_context`,
      refreshSeconds: `SELECT config_value FROM system_config WHERE config_key = 'site_matrix_refresh_seconds'`
    },
    heartbeat: {
      upsert: `MERGE INTO ad_agent_heartbeat AS t USING (SELECT ? AS agent_id, ? AS agent_version, ? AS last_report_at, ? AS last_report_status, ? AS pending_queue_size) AS s ON t.agent_id = s.agent_id WHEN MATCHED THEN UPDATE SET last_heartbeat_at = SYSUTCDATETIME(), agent_version = s.agent_version, last_report_at = s.last_report_at, last_report_status = s.last_report_status, pending_queue_size = s.pending_queue_size WHEN NOT MATCHED THEN INSERT (agent_id, last_heartbeat_at, agent_version, last_report_at, last_report_status, pending_queue_size) VALUES (s.agent_id, SYSUTCDATETIME(), s.agent_version, s.last_report_at, s.last_report_status, s.pending_queue_size);`,
      agentsList: `SELECT h.agent_id, h.agent_version, h.last_heartbeat_at, h.last_report_at, h.last_report_status, h.pending_queue_size
             FROM ad_agent_heartbeat h
             ORDER BY h.agent_id`,
      dcsList: `SELECT h.agent_id, h.agent_version, h.last_heartbeat_at, h.last_report_at, h.last_report_status, h.pending_queue_size,
                 d.dc_name, d.ip_address, d.os_version, d.is_pdc,
                 s.site_name, s.region_code
          FROM ad_agent_heartbeat h
          LEFT JOIN ad_dcs d ON d.dc_name = h.agent_id
          LEFT JOIN ad_sites s ON s.site_id = d.site_id
          ORDER BY h.agent_id`,
      reportSummaryFor: (agentId, sinceIso) =>
        `SELECT s.source_dc, s.dest_dc, s.status_code, s.error_message, s.collected_at
         FROM ad_replication_status s
         INNER JOIN (
           SELECT TOP 1 collected_at AS max_collected
           FROM ad_replication_status
           WHERE agent_id = ? AND collected_at >= ?
           ORDER BY collected_at DESC
         ) m ON s.collected_at = m.max_collected AND s.agent_id = ?
         ORDER BY s.source_dc, s.dest_dc`,
      latestReportEntries: (agentId, sinceIso, limit) =>
        `SELECT collected_at, source_dc, dest_dc, source_site, dest_site, naming_context,
                 status_code, error_message, last_success_time, last_attempt_time
         FROM ad_replication_status
         WHERE agent_id = ?
           AND collected_at = (
             SELECT TOP 1 collected_at FROM ad_replication_status
             WHERE agent_id = ? AND collected_at >= ?
             ORDER BY collected_at DESC
           )
         ORDER BY source_dc, dest_dc`
    },
    ports: {
      list: 'SELECT id, port, label, sort_order AS sortOrder FROM system_ports ORDER BY sort_order, port',
      listForAgent: `SELECT sp.port, sp.label, aps.ok, aps.latency_ms AS latencyMs, aps.last_checked_at AS lastCheckedAt
        FROM system_ports sp
        INNER JOIN ad_agent_port_status aps ON aps.port = sp.port AND aps.agent_id = ?
        ORDER BY sp.sort_order, sp.port`,
      create: 'INSERT INTO system_ports (port, label, sort_order) VALUES (?, ?, ?)',
      findByPort: 'SELECT id FROM system_ports WHERE port = ?',
      updatePartial: (fields) => `UPDATE system_ports SET ${fields.join(', ')} WHERE id = ?`,
      delete: 'DELETE FROM system_ports WHERE id = ?'
    },
    portStatus: {
      // MSSQL uses MERGE for atomic upsert (no native ON DUPLICATE KEY).
      // Uses ? placeholders — db.execute remaps ? -> @pN for MSSQL.
      upsertOne: `MERGE INTO ad_agent_port_status AS t
        USING (SELECT CAST(? AS VARCHAR(64)) AS agent_id, ? AS port, ? AS ok, ? AS latency_ms, ? AS last_checked_at) AS s
        ON t.agent_id = s.agent_id AND t.port = s.port
        WHEN MATCHED THEN UPDATE SET t.ok = s.ok, t.latency_ms = s.latency_ms, t.last_checked_at = s.last_checked_at
        WHEN NOT MATCHED THEN INSERT (agent_id, port, ok, latency_ms, last_checked_at) VALUES (s.agent_id, s.port, s.ok, s.latency_ms, s.last_checked_at);`,
      listForAgents: (placeholders) => `SELECT aps.agent_id AS agentId, aps.port, aps.ok, aps.latency_ms AS latencyMs, aps.last_checked_at AS lastCheckedAt,
               sp.label AS label
        FROM ad_agent_port_status aps
        INNER JOIN system_ports sp ON aps.port = sp.port
        WHERE aps.agent_id IN (${placeholders})
        ORDER BY sp.sort_order, sp.port`
    },
    installedPackages: {
      upsert: `MERGE INTO installed_packages AS t
        USING (SELECT
          ? AS name, ? AS version, ? AS type, ? AS manifest_json, ? AS enabled,
          ? AS params_json, ? AS installed_at, ? AS updated_at, ? AS source
        ) AS s
        ON t.name = s.name
        WHEN MATCHED THEN UPDATE SET
          version = s.version,
          type = s.type,
          manifest_json = s.manifest_json,
          enabled = s.enabled,
          params_json = s.params_json,
          updated_at = s.updated_at,
          source = s.source
        WHEN NOT MATCHED THEN INSERT
          (name, version, type, manifest_json, enabled, params_json, installed_at, updated_at, source)
          VALUES
          (s.name, s.version, s.type, s.manifest_json, s.enabled, s.params_json,
           s.installed_at, s.updated_at, s.source);`,
      list: `SELECT * FROM installed_packages ORDER BY name`,
      listEnabled: `SELECT * FROM installed_packages WHERE enabled = 1 ORDER BY name`,
      get: `SELECT * FROM installed_packages WHERE name = ?`,
      delete: `DELETE FROM installed_packages WHERE name = ?`
    },
    // Drop-failure tracking (migration 013). See mysql counterpart.
    orphanSchemas: {
      upsert: `MERGE INTO orphan_schemas AS t
        USING (SELECT ? AS name, ? AS last_seen_at, ? AS note) AS s
        ON t.name = s.name
        WHEN MATCHED THEN UPDATE SET
          last_seen_at = s.last_seen_at,
          note = s.note
        WHEN NOT MATCHED THEN INSERT (name, last_seen_at, note)
          VALUES (s.name, s.last_seen_at, s.note);`,
      list: `SELECT * FROM orphan_schemas ORDER BY last_seen_at DESC`,
      delete: `DELETE FROM orphan_schemas WHERE name = ?`
    },
    metricGauge: {
      upsertLatest: `MERGE INTO metric_gauge AS t
        USING (SELECT
          ? AS agent_id, ? AS metric_id, ? AS ts, ? AS value, ? AS unit,
          ? AS threshold_warn, ? AS threshold_crit
        ) AS s
        ON t.agent_id = s.agent_id AND t.metric_id = s.metric_id
        WHEN MATCHED THEN UPDATE SET
          ts = s.ts,
          value = s.value,
          unit = s.unit,
          threshold_warn = s.threshold_warn,
          threshold_crit = s.threshold_crit
        WHEN NOT MATCHED THEN INSERT
          (agent_id, metric_id, ts, value, unit, threshold_warn, threshold_crit)
          VALUES (s.agent_id, s.metric_id, s.ts, s.value, s.unit, s.threshold_warn, s.threshold_crit);`,
      listByAgent: (metricIdPlaceholder) =>
        metricIdPlaceholder
          ? `SELECT * FROM metric_gauge WHERE agent_id = ? AND metric_id = ?`
          : `SELECT * FROM metric_gauge WHERE agent_id = ?`
    },
    metricCounter: {
      upsertLatest: `MERGE INTO metric_counter AS t
        USING (SELECT
          ? AS agent_id, ? AS metric_id, ? AS ts, ? AS value, ? AS delta, ? AS unit
        ) AS s
        ON t.agent_id = s.agent_id AND t.metric_id = s.metric_id
        WHEN MATCHED THEN UPDATE SET
          ts = s.ts,
          value = s.value,
          delta = s.delta,
          unit = s.unit
        WHEN NOT MATCHED THEN INSERT
          (agent_id, metric_id, ts, value, delta, unit)
          VALUES (s.agent_id, s.metric_id, s.ts, s.value, s.delta, s.unit);`,
      listByAgent: (metricIdPlaceholder) =>
        metricIdPlaceholder
          ? `SELECT * FROM metric_counter WHERE agent_id = ? AND metric_id = ?`
          : `SELECT * FROM metric_counter WHERE agent_id = ?`
    },
    metricTimeseries: {
      append: `INSERT INTO metric_timeseries
        (agent_id, metric_id, ts, value, tags_json, unit)
        VALUES (?, ?, ?, ?, ?, ?)`,
      list: (includeRange) => {
        const where = ['agent_id = ?', 'metric_id = ?'];
        if (includeRange?.from) where.push('ts >= ?');
        if (includeRange?.to) where.push('ts <= ?');
        return `SELECT * FROM metric_timeseries WHERE ${where.join(' AND ')} ORDER BY ts ASC`;
      }
    },
    metricStatus: {
      upsertLatest: `MERGE INTO metric_status AS t
        USING (SELECT
          ? AS agent_id, ? AS metric_id, ? AS ts, ? AS status, ? AS message
        ) AS s
        ON t.agent_id = s.agent_id AND t.metric_id = s.metric_id
        WHEN MATCHED THEN UPDATE SET
          ts = s.ts,
          status = s.status,
          message = s.message
        WHEN NOT MATCHED THEN INSERT
          (agent_id, metric_id, ts, status, message)
          VALUES (s.agent_id, s.metric_id, s.ts, s.status, s.message);`,
      listByAgent: (metricIdPlaceholder) =>
        metricIdPlaceholder
          ? `SELECT * FROM metric_status WHERE agent_id = ? AND metric_id = ?`
          : `SELECT * FROM metric_status WHERE agent_id = ?`
    },
    packageRuns: {
      insert: `INSERT INTO package_runs
        (agent_id, package_name, started_at, finished_at, exit_code, stdout_preview, stderr_preview, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      // listRecent is built dynamically per call; mssql uses TOP <n> not LIMIT.
    },
    lockout: {
      upsertEvent: `MERGE INTO ad_lockout_events AS t
        USING (SELECT
          ? AS occurred_at, ? AS collected_at, CAST(? AS VARCHAR(64)) AS agent_id, CAST(? AS VARCHAR(128)) AS dc_name, ? AS event_record_id,
          CAST(? AS VARCHAR(256)) AS target_user_name, CAST(? AS VARCHAR(256)) AS subject_user_name, CAST(? AS VARCHAR(256)) AS subject_domain, CAST(? AS VARCHAR(256)) AS caller_computer_name
        ) AS s
        ON t.dc_name = s.dc_name AND t.event_record_id = s.event_record_id
        WHEN MATCHED THEN UPDATE SET collected_at = s.collected_at
        WHEN NOT MATCHED THEN INSERT
          (occurred_at, collected_at, agent_id, dc_name, event_record_id,
           target_user_name, subject_user_name, subject_domain, caller_computer_name)
          VALUES
          (s.occurred_at, s.collected_at, s.agent_id, s.dc_name, s.event_record_id,
           s.target_user_name, s.subject_user_name, s.subject_domain, s.caller_computer_name);`,
      search: `SELECT TOP 500 occurred_at, dc_name, target_user_name, subject_user_name,
                      subject_domain, caller_computer_name
                 FROM ad_lockout_events
                WHERE occurred_at >= ?
                  AND (CAST(? AS VARCHAR(256)) = '' OR target_user_name = CAST(? AS VARCHAR(256)))
                  AND (CAST(? AS VARCHAR(128)) = '' OR dc_name = CAST(? AS VARCHAR(128)))
                  AND (CAST(? AS VARCHAR(256)) = '' OR caller_computer_name = CAST(? AS VARCHAR(256)))
                ORDER BY occurred_at ASC`
    },
    schemaMigrations: {
      list: 'SELECT version, description, type, script, checksum, applied_at, applied_by, execution_ms, status, error_message FROM schema_migrations',
      findByVersion: 'SELECT version, description, type, script, checksum, applied_at, applied_by, execution_ms, status, error_message FROM schema_migrations WHERE version = CAST(? AS VARCHAR(32))',
      upsert: `MERGE INTO schema_migrations AS t
        USING (SELECT
          CAST(? AS VARCHAR(32)) AS version, CAST(? AS VARCHAR(255)) AS description, CAST(? AS VARCHAR(16)) AS type, CAST(? AS VARCHAR(255)) AS script, ? AS checksum,
          ? AS applied_at, ? AS execution_ms, CAST(? AS VARCHAR(64)) AS applied_by, CAST(? AS VARCHAR(16)) AS status, ? AS error_message
        ) AS s
        ON t.version = s.version
        WHEN MATCHED THEN UPDATE SET
          description   = s.description,
          type          = s.type,
          script        = s.script,
          checksum      = s.checksum,
          applied_at    = s.applied_at,
          execution_ms  = s.execution_ms,
          applied_by    = s.applied_by,
          status        = s.status,
          error_message = s.error_message
        WHEN NOT MATCHED THEN INSERT
          (version, description, type, script, checksum, applied_at, execution_ms, applied_by, status, error_message)
          VALUES
          (s.version, s.description, s.type, s.script, s.checksum, s.applied_at, s.execution_ms, s.applied_by, s.status, s.error_message);`,
      deleteFailed: "DELETE FROM schema_migrations WHERE version = CAST(? AS VARCHAR(32)) AND status = 'failed'"
    },
    // Port self-probe state (migration 012). MSSQL uses MERGE for atomic
    // upsert (no native ON DUPLICATE KEY). Uses ? placeholders — db.execute
    // remaps ? -> @pN for MSSQL.
    probeState: {
      getAll: 'SELECT port_role, status, latency_ms, last_probe_at, last_up_at, consecutive_failures FROM probe_state ORDER BY port_role',
      upsertRow: (portRole, status, latencyMs, lastProbeAt, lastUpAt, consecutiveFailures) =>
        `MERGE INTO probe_state AS t
         USING (SELECT CAST(? AS VARCHAR(16)) AS port_role, CAST(? AS VARCHAR(16)) AS status, ? AS latency_ms, ? AS last_probe_at, ? AS last_up_at, ? AS consecutive_failures) AS s
         ON t.port_role = s.port_role
         WHEN MATCHED THEN UPDATE SET
           status = s.status,
           latency_ms = s.latency_ms,
           last_probe_at = s.last_probe_at,
           last_up_at = s.last_up_at,
           consecutive_failures = s.consecutive_failures
         WHEN NOT MATCHED THEN INSERT (port_role, status, latency_ms, last_probe_at, last_up_at, consecutive_failures)
           VALUES (s.port_role, s.status, s.latency_ms, s.last_probe_at, s.last_up_at, s.consecutive_failures);`
    },
    // Existence probes for migration verify markers. Returns one row when the
    // artifact exists, zero rows when it doesn't. INFORMATION_SCHEMA views are
    // already scoped to the connection's current database in MSSQL.
    probe: {
      table: `SELECT TOP 1 1 AS ok FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = ?`,
      column: `SELECT TOP 1 1 AS ok FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_NAME = ? AND COLUMN_NAME = ?`
    },
    // Non-AD server management (migration 014). See mysql counterpart.
    memberServers: memberServers.mssql,
    serverGroups: serverGroups.mssql,
    alertRules: alertRules.mssql,
    alertEvents: alertEvents.mssql,
    alertOutbox: alertOutbox.mssql,
    alertMetrics: alertMetrics.mssql
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