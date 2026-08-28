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
      upsertStatus: `INSERT INTO ad_replication_status (collected_at, agent_id, source_dc, dest_dc, source_site, dest_site, naming_context, last_success_time, last_attempt_time, status_code, error_message, users_count, groups_count, gpos_count, locked_count, partner_port_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE collected_at = VALUES(collected_at), agent_id = VALUES(agent_id), source_site = VALUES(source_site), dest_site = VALUES(dest_site), last_success_time = VALUES(last_success_time), last_attempt_time = VALUES(last_attempt_time), status_code = VALUES(status_code), error_message = VALUES(error_message), users_count = VALUES(users_count), groups_count = VALUES(groups_count), gpos_count = VALUES(gpos_count), locked_count = VALUES(locked_count), partner_port_status = VALUES(partner_port_status)`,
      upsertHistory: `INSERT INTO ad_replication_history (collected_at, agent_id, source_dc, dest_dc, naming_context, last_success_time, last_attempt_time, attempt_duration_ms, objects_transferred, status_code, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      listRecent: `SELECT source_dc, dest_dc, source_site, dest_site, status_code, collected_at FROM ad_replication_status ORDER BY collected_at DESC LIMIT ?`,
      listBySite: `SELECT source_dc, dest_dc, source_site, dest_site, status_code, collected_at FROM ad_replication_status WHERE source_site = ? OR dest_site = ? ORDER BY collected_at DESC LIMIT ?`,
      latestSummaryPerDc: `SELECT t1.source_dc, t1.users_count, t1.groups_count, t1.gpos_count, t1.locked_count, t1.collected_at FROM ad_replication_status t1 WHERE t1.naming_context = '__dc_summary__' AND t1.collected_at = (SELECT MAX(t2.collected_at) FROM ad_replication_status t2 WHERE t2.source_dc = t1.source_dc AND t2.naming_context = '__dc_summary__') ORDER BY t1.source_dc`,
      partnersCount: `SELECT COUNT(*) AS c FROM ad_replication_status WHERE source_dc = ? AND naming_context <> '__dc_summary__' AND collected_at BETWEEN ? - INTERVAL ? MINUTE AND ? + INTERVAL ? MINUTE`
    },
    discovery: {
      upsertDc: `INSERT INTO ad_dcs (dc_name, site_hint, os_version, when_created, is_pdc, is_gc, is_rid_master, is_schema_master, is_domain_naming_master, is_infrastructure_master, discovered_at, discovered_by_agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE site_hint = VALUES(site_hint), os_version = VALUES(os_version), when_created = VALUES(when_created), is_pdc = VALUES(is_pdc), is_gc = VALUES(is_gc), is_rid_master = VALUES(is_rid_master), is_schema_master = VALUES(is_schema_master), is_domain_naming_master = VALUES(is_domain_naming_master), is_infrastructure_master = VALUES(is_infrastructure_master), discovered_at = UTC_TIMESTAMP(), discovered_by_agent_id = VALUES(discovered_by_agent_id)`
    },
    users: {
      findByUsername: `SELECT u.id, u.username, u.password_hash, u.role_id, u.status, u.token_version, r.role_name, GROUP_CONCAT(rp.permission) AS permissions FROM sys_users u LEFT JOIN sys_roles r ON u.role_id = r.id LEFT JOIN role_permissions rp ON rp.role_id = r.id WHERE u.username = ? GROUP BY u.id, u.username, u.password_hash, u.role_id, u.status, u.token_version, r.role_name LIMIT 1`,
      list: 'SELECT u.id, u.username, u.role_id, u.status, u.last_login_at, u.created_at, r.role_name FROM sys_users u LEFT JOIN sys_roles r ON u.role_id = r.id ORDER BY u.id',
      create: 'INSERT INTO sys_users (username, password_hash, role_id, status) VALUES (?, ?, ?, ?)',
      update: 'UPDATE sys_users SET password_hash = COALESCE(?, password_hash), role_id = COALESCE(?, role_id), status = COALESCE(?, status) WHERE id = ?',
      delete: 'DELETE FROM sys_users WHERE id = ?',
      recordLogin: 'UPDATE sys_users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?',
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
      upsert: `INSERT INTO system_config (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_at = UTC_TIMESTAMP()`,
      setAgentToken: `INSERT INTO system_config (config_key, config_value) VALUES ('agent_token', ?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_at = UTC_TIMESTAMP()`,
      getAgentTokenBundle: `SELECT config_key, config_value FROM system_config WHERE config_key IN ('agent_token_current', 'agent_token_previous', 'agent_token_rotated_at', 'agent_token_version')`,
      getJwtSecretBundle: `SELECT config_key, config_value FROM system_config WHERE config_key IN ('jwt_secret_current', 'jwt_secret_previous', 'jwt_secret_rotated_at', 'jwt_secret_previous_ttl_days')`,
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
      // 2026-08-27 round-28.5: surface is_bridgehead so the admin 域控清单
      // can show the bridgehead toggle next to the FSMO role toggles. The
      // bridgehead is an operator-chosen designation (NOT a FSMO role) used
      // by the all-sites replication matrix view to pick a primary DC per
      // site; sites without a marked bridgehead fall back to lex-first dc_name.
      // 2026-08-27 round-29: added dcs.updateFlags helper — same partial-update
      // shape as sites.updatePartial / systemPorts.updatePartial so the route
      // can build the SET list from whatever body keys the operator toggled.
      listCatalog: `SELECT d.dc_name AS dcName, d.site_id AS siteId, s.site_name AS siteName, d.site_hint AS siteHint, d.os_version AS osVersion, d.when_created AS whenCreated, d.is_pdc AS isPdc, d.is_gc AS isGc, d.is_rid_master AS isRidMaster, d.is_schema_master AS isSchemaMaster, d.is_domain_naming_master AS isDomainNamingMaster, d.is_infrastructure_master AS isInfrastructureMaster, d.is_bridgehead AS isBridgehead, d.discovered_at AS discoveredAt, d.discovered_by_agent_id AS discoveredByAgentId FROM ad_dcs d LEFT JOIN ad_sites s ON d.site_id = s.site_id ORDER BY d.dc_name`,
      assignSite: 'UPDATE ad_dcs SET site_id = ? WHERE dc_name = ?',
      assignSiteUnbind: 'UPDATE ad_dcs SET site_id = NULL WHERE dc_name = ?',
      updateFlags: (fields) => `UPDATE ad_dcs SET ${fields.join(', ')} WHERE dc_name = ?`
    },
    // Cross-DC consistency scoring (Task 5). Reads the latest row per agent
    // from pkg_ad_domain_consistency.metrics (Task 4 ingest path) and feeds
    // services/consistency.js's deriveConsistency() majority-hash algorithm.
    //
    // MySQL 5.7 portable — NO ROW_NUMBER() / NO window functions. The
    // correlated (agent_id, ts) IN (subquery) form picks the per-agent
    // MAX(ts) row via the (agent_id, ts) primary key, identical row shape
    // to the MSSQL OUTER APPLY branch below. Both branches select the same
    // column order so service code can iterate without per-dialect branching.
    // ts is coerced to JS Date by mysql2 / mssql drivers; service code uses
    // .getTime() uniformly.
    consistency: {
      latestPerAgent: `SELECT m.agent_id, m.ts, m.user_count, m.user_hash, m.group_count, m.group_hash, m.gpo_count, m.gpo_hash, m.error_code FROM \`pkg_ad_domain_consistency\`.\`metrics\` m WHERE (m.agent_id, m.ts) IN (SELECT agent_id, MAX(ts) AS max_ts FROM \`pkg_ad_domain_consistency\`.\`metrics\` GROUP BY agent_id)`
    },
    dashboard: {
      overviewCounts: `SELECT COUNT(*) AS total, SUM(CASE WHEN status_code = 0 THEN 1 ELSE 0 END) AS healthy, SUM(CASE WHEN status_code = 1 THEN 1 ELSE 0 END) AS warning, SUM(CASE WHEN status_code >= 2 THEN 1 ELSE 0 END) AS errored, MAX(collected_at) AS last_update FROM ad_replication_status`,
      agentCount: `SELECT COUNT(*) AS agent_count FROM ad_agent_heartbeat WHERE last_heartbeat_at IS NOT NULL AND agent_id <> '__healthcheck__'`,
      siteMatrix: `SELECT source_site, dest_site, SUM(CASE WHEN status_code >= 2 THEN 1 ELSE 0 END) AS error_count, SUM(CASE WHEN status_code = 1 THEN 1 ELSE 0 END) AS warning_count, COUNT(*) AS total FROM ad_replication_status WHERE source_site IS NOT NULL AND dest_site IS NOT NULL GROUP BY source_site, dest_site ORDER BY source_site, dest_site`,
      // 2026-08-26 round-21: /topology used to return every row in
      // ad_replication_status, including stale round-19 leftovers and
      // test/junk rows (*, __tz_test, DC01→"") — operators saw 42 links
      // instead of the 19 the round-20 topology actually emits. The fix:
      // (a) derive site + dc nodes from ad_sites / ad_dcs (catalog is
      // source of truth — agent-reported source_site is a free-text hint
      // and does not match catalog site_name), (b) for links, take the
      // latest row per (source_dc, dest_dc) pair where both are known
      // DCs and source_dc != dest_dc, and (c) drop rows older than 30
      // minutes (UTC) so pairs the daemon stopped emitting — e.g. the
      // round-19 topology pairs that were renamed in round-20 — fall
      // out of the graph. UTC clock is essential: collected_at is in
      // UTC but MySQL NOW() returns session-tz (round-15 UTC cleanup).
      topologyNodes: `
        SELECT s.site_id   AS site_id,
               s.site_name AS site_name,
               d.dc_name   AS dc_name
        FROM ad_sites s
        LEFT JOIN ad_dcs d ON d.site_id = s.site_id
        ORDER BY s.site_name, d.dc_name
      `,
      topologyLinks: `
        SELECT t1.source_dc, t1.dest_dc, t1.status_code, t1.last_success_time
        FROM ad_replication_status t1
        INNER JOIN ad_dcs sd ON sd.dc_name = t1.source_dc
        INNER JOIN ad_dcs dd ON dd.dc_name = t1.dest_dc
        WHERE t1.source_dc <> t1.dest_dc
          AND t1.naming_context NOT IN ('__dc_summary__', 'META')
          AND t1.collected_at = (
            SELECT MAX(t2.collected_at) FROM ad_replication_status t2
            WHERE t2.source_dc = t1.source_dc
              AND t2.dest_dc   = t1.dest_dc
              AND t2.naming_context NOT IN ('__dc_summary__', 'META')
          )
          AND t1.collected_at >= UTC_TIMESTAMP() - INTERVAL 30 MINUTE
        ORDER BY t1.source_dc, t1.dest_dc
      `,
      errors: `SELECT source_dc, dest_dc, source_site, dest_site, naming_context, status_code, last_success_time, last_attempt_time, TIMESTAMPDIFF(MINUTE, last_success_time, last_attempt_time) AS duration_minutes FROM ad_replication_status WHERE status_code <> 0 ORDER BY last_attempt_time DESC`,
      agents: `SELECT agent_id, last_heartbeat_at, agent_version, last_report_at, last_report_status, pending_queue_size, TIMESTAMPDIFF(SECOND, last_heartbeat_at, UTC_TIMESTAMP()) AS seconds_since_heartbeat FROM ad_agent_heartbeat WHERE agent_id <> '__healthcheck__' ORDER BY agent_id`,
      siteLookup: `SELECT site_id, site_name, region_code, is_hub, description FROM ad_sites WHERE site_name = ?`,
      dcsBySite: `SELECT dc_name, os_version, is_pdc, is_gc, is_rid_master, is_schema_master, is_domain_naming_master, is_infrastructure_master, discovered_at, discovered_by_agent_id FROM ad_dcs WHERE site_id = ? ORDER BY dc_name`,
      dcReplicationLinks: (placeholders) => `SELECT source_dc, dest_dc, naming_context, status_code, last_success_time, last_attempt_time, TIMESTAMPDIFF(MINUTE, last_success_time, last_attempt_time) AS duration_minutes FROM ad_replication_status WHERE source_dc IN (${placeholders}) AND dest_dc IN (${placeholders}) ORDER BY source_dc, dest_dc, naming_context`,
      refreshSeconds: `SELECT config_value FROM system_config WHERE config_key = 'site_matrix_refresh_seconds'`,
      // 2026-08-27 round-27: all-sites variant for the global replication
      // matrix view. Returns every site hub-first, every DC, and every
      // within/cross replication link (excluding summary + meta + partner-port
      // rows). Mirrors the topologyLinks JOIN pattern (catalog is source of
      // truth, INNER JOIN ad_dcs / ad_sites) plus the 30-min UTC freshness
      // floor and latest-per-pair correlated subquery.
      allSitesOrdered: `SELECT site_id, site_name, region_code, is_hub, description FROM ad_sites ORDER BY is_hub DESC, region_code, site_name`,
      allDcsBySite: `SELECT d.dc_name, d.site_id, d.os_version, d.when_created, d.is_pdc, d.is_gc, d.is_rid_master, d.is_schema_master, d.is_domain_naming_master, d.is_infrastructure_master, d.is_bridgehead, d.discovered_at, d.discovered_by_agent_id FROM ad_dcs d INNER JOIN ad_sites s ON s.site_id = d.site_id ORDER BY s.site_name, d.dc_name`,
      allReplicationLinks: `SELECT t1.source_dc, t1.dest_dc, t1.naming_context, t1.status_code, t1.last_success_time, t1.last_attempt_time, TIMESTAMPDIFF(MINUTE, t1.last_success_time, t1.last_attempt_time) AS duration_minutes FROM ad_replication_status t1 WHERE t1.source_dc <> t1.dest_dc AND t1.naming_context NOT IN ('__dc_summary__', 'META') AND t1.collected_at = (SELECT MAX(t2.collected_at) FROM ad_replication_status t2 WHERE t2.source_dc = t1.source_dc AND t2.dest_dc = t1.dest_dc AND t2.naming_context NOT IN ('__dc_summary__', 'META')) AND t1.collected_at >= UTC_TIMESTAMP() - INTERVAL 30 MINUTE ORDER BY t1.source_dc, t1.dest_dc, t1.naming_context`,
      // 2026-08-28 round-46: latest per-partner TCP-port probe. The probe
      // data lands on the `__partner_ports__:<sha>` naming_context rows
      // collected-replication.ps1 emits (R35 surface, brought back in
      // R46 to feed 复制日志监控's port-health view). partner_port_status
      // carries a JSON blob with per-port reachability details (see
      // collect-replication.ps1::Get-PartnerPortSnapshot for the schema).
      // Filter on LIKE '__partner_ports__:%' (NOT IN the explicit values)
      // because the hash suffix makes an equality check impossible.
      latestPartnerPortPerPair: `SELECT t1.source_dc, t1.dest_dc, t1.naming_context, t1.status_code, t1.last_attempt_time, t1.partner_port_status FROM ad_replication_status t1 WHERE t1.naming_context LIKE '__partner_ports__:%' AND t1.source_dc <> t1.dest_dc AND t1.collected_at = (SELECT MAX(t2.collected_at) FROM ad_replication_status t2 WHERE t2.source_dc = t1.source_dc AND t2.dest_dc = t1.dest_dc AND t2.naming_context LIKE '__partner_ports__:%') AND t1.collected_at >= UTC_TIMESTAMP() - INTERVAL 30 MINUTE ORDER BY t1.source_dc, t1.dest_dc`,
      // 2026-08-28 round-47: replicationLogRecentAttempts helper removed —
      // the 复制伙伴端口健康监控 route no longer embeds attempts[] on each
      // partner row (port-health-only view). Per-pair history for the
      // inline caret in 复制状态概览 still uses replicationLogPerPair
      // below.
      // 2026-08-28 round-45: lazy-fetch per (source_dc, dest_dc) pair for the
      // "最近 10 条" expansion inside 复制状态概览. The 24h window mirrors
      // replicationLogRecentAttempts — operators care about recent state.
      // Index ix_hist_pair_time(source_dc, dest_dc, naming_context, collected_at)
      // covers WHERE+ORDER BY. Caller binds [source, dest, limit].
      replicationLogPerPair: `SELECT source_dc, dest_dc, naming_context, status_code, last_success_time, last_attempt_time, attempt_duration_ms, objects_transferred, error_message, collected_at FROM ad_replication_history WHERE source_dc = ? AND dest_dc = ? AND collected_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR ORDER BY collected_at DESC LIMIT ?`
    },
    heartbeat: {
      // 2026-08-24 round-12: report_requested_at added (last col, matching
      // migration `AFTER agent_token_version`). COALESCE on UPDATE means
      // a `null` param preserves the existing column — agents pre-T6 that
      // don't forward the field will not wipe the "report now" request.
      upsert: `INSERT INTO ad_agent_heartbeat (agent_id, last_heartbeat_at, agent_version, last_report_at, last_report_status, pending_queue_size, agent_token_version, report_requested_at) VALUES (?, UTC_TIMESTAMP(), ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE last_heartbeat_at = UTC_TIMESTAMP(), agent_version = VALUES(agent_version), last_report_at = VALUES(last_report_at), last_report_status = VALUES(last_report_status), pending_queue_size = VALUES(pending_queue_size), agent_token_version = VALUES(agent_token_version), report_requested_at = COALESCE(VALUES(report_requested_at), report_requested_at)`,
      // 2026-08-21 UX redesign (auto-delivery): list every agent's last
      // reported agent_token_version so the modal can render the
      // "已推送到 X / N 台 Agent" counter. agent_id is the source-of-truth
      // identifier; for AD it's the configured agentId (e.g. DC name),
      // for non-AD it's the hostname (matches the heartbeat payload).
      tokenDeliveryList: `SELECT agent_id, agent_token_version, last_heartbeat_at FROM ad_agent_heartbeat WHERE agent_id <> '__healthcheck__' ORDER BY agent_id`,
      // 2026-08-26 round-15: source-of-truth switch for the report-status
      // signal. The previous SELECT exposed h.last_report_at /
      // h.last_report_status, which is a self-declared timestamp the agent
      // writes in its heartbeat body. It drifted from reality (a successful
      // replication report could land without the heartbeat column ever
      // being updated, so the operator view showed "未上传" while data was
      // in the DB). We now derive both fields from ad_replication_status:
      //   - rep.last_report_at = MAX(collected_at) over ALL history
      //     (null = agent has NEVER produced a replication row)
      //   - rep.success_count / fail_count / total_count = aggregate over the
      //     1-hour lookback window (matches the operator rule "last
      //     uploaded data must not exceed one hour")
      //   - last_report_status is a CASE derived from the 1-hour threshold
      //     + the failure count: null / success / partial_failure / stale
      // The new fields keep the same column names so the service layer can
      // keep reading row.last_report_at without renaming. report_requested_at
      // stays from the heartbeat row (it's the admin "report now" flag).
      //
      // 2026-08-26 round-15 hot-fix: NOW() → UTC_TIMESTAMP(). The stored
      // values for collected_at are written via toMysqlDatetime() which
      // produces UTC-naive strings (`YYYY-MM-DD HH:MM:SS` derived from
      // the JS Date's UTC components). MySQL's session timezone on the
      // dev box is SYSTEM (CST = UTC+8), so NOW() returns a CST value —
      // comparing that against UTC-stored rows makes every recent row
      // look 8 hours old. UTC_TIMESTAMP() returns the actual UTC clock,
      // matching the storage convention. Same fix on the MSSQL branch
      // (SYSUTCDATETIME is already UTC). The 1-hour rule was meant to
      // be a wall-clock comparison, not a session-timezone comparison.
      //
      // 2026-08-27 round-39: operator directive "在心跳和报告中的报告是
      // 每天 24点 重置成功率". The success-rate counts now reset at
      // midnight UTC (DATE(UTC_TIMESTAMP()) = today 00:00:00). MySQL
      // coerces the DATE to DATETIME 00:00:00 for comparison against
      // collected_at. last_report_status (stale/fresh) keeps its
      // 1-hour threshold because freshness is about "did the agent
      // just report?" — that's a separate signal from "today's tally".
      // latestFailureFor matches the count window so the error message
      // shown is the one that contributed to today's fail_count.
      agentsList: `SELECT h.agent_id, h.agent_version, h.last_heartbeat_at,
                          rep.last_report_at,
                          CASE
                            WHEN rep.last_report_at IS NULL THEN NULL
                            WHEN rep.last_report_at >= UTC_TIMESTAMP() - INTERVAL 1 HOUR THEN
                              CASE WHEN COALESCE(recent.fail_count, 0) > 0 THEN 'partial_failure' ELSE 'success' END
                            ELSE 'stale'
                          END AS last_report_status,
                          COALESCE(recent.success_count, 0) AS success_count,
                          COALESCE(recent.fail_count, 0) AS fail_count,
                          COALESCE(recent.total_count, 0) AS total_count,
                          h.pending_queue_size, h.report_requested_at
             FROM ad_agent_heartbeat h
             LEFT JOIN (
               SELECT agent_id, MAX(collected_at) AS last_report_at
               FROM ad_replication_status
               GROUP BY agent_id
             ) rep ON rep.agent_id = h.agent_id
             LEFT JOIN (
               SELECT agent_id,
                      SUM(CASE WHEN status_code = 0 THEN 1 ELSE 0 END) AS success_count,
                      SUM(CASE WHEN status_code <> 0 THEN 1 ELSE 0 END) AS fail_count,
                      COUNT(*) AS total_count
               FROM ad_replication_status
               WHERE collected_at >= DATE(UTC_TIMESTAMP())
               GROUP BY agent_id
             ) recent ON recent.agent_id = h.agent_id
             WHERE h.agent_id <> '__healthcheck__'
             ORDER BY h.agent_id`,
      dcsList: `SELECT h.agent_id, h.agent_version, h.last_heartbeat_at,
                       rep.last_report_at,
                       CASE
                         WHEN rep.last_report_at IS NULL THEN NULL
                         WHEN rep.last_report_at >= UTC_TIMESTAMP() - INTERVAL 1 HOUR THEN
                           CASE WHEN COALESCE(recent.fail_count, 0) > 0 THEN 'partial_failure' ELSE 'success' END
                         ELSE 'stale'
                       END AS last_report_status,
                       COALESCE(recent.success_count, 0) AS success_count,
                       COALESCE(recent.fail_count, 0) AS fail_count,
                       COALESCE(recent.total_count, 0) AS total_count,
                       h.pending_queue_size, h.report_requested_at,
                       d.dc_name, d.ip_address, d.os_version, d.is_pdc,
                       s.site_name, s.region_code
          FROM ad_agent_heartbeat h
          LEFT JOIN ad_dcs d ON d.dc_name = h.agent_id
          LEFT JOIN ad_sites s ON s.site_id = d.site_id
          LEFT JOIN (
            SELECT agent_id, MAX(collected_at) AS last_report_at
            FROM ad_replication_status
            GROUP BY agent_id
          ) rep ON rep.agent_id = h.agent_id
          LEFT JOIN (
            SELECT agent_id,
                   SUM(CASE WHEN status_code = 0 THEN 1 ELSE 0 END) AS success_count,
                   SUM(CASE WHEN status_code <> 0 THEN 1 ELSE 0 END) AS fail_count,
                   COUNT(*) AS total_count
            FROM ad_replication_status
            WHERE collected_at >= DATE(UTC_TIMESTAMP())
            GROUP BY agent_id
          ) recent ON recent.agent_id = h.agent_id
          WHERE h.agent_id <> '__healthcheck__'
          ORDER BY h.agent_id`,
      // 2026-08-24 round-12: requestReport UPSERT — insert a stub heartbeat
      // row if the agent hasn't checked in yet, or set the column if it
      // has. Caller binds [agentId, requestedAt] (Date or ISO string).
      requestReport: (agentId, requestedAtIso) =>
        `INSERT INTO ad_agent_heartbeat (agent_id, last_heartbeat_at, report_requested_at)
         VALUES (?, UTC_TIMESTAMP(), ?)
         ON DUPLICATE KEY UPDATE report_requested_at = VALUES(report_requested_at)`,
      // 2026-08-24 round-12 T-fix: clearReportRequest — direct UPDATE that
      // actually sets `report_requested_at = NULL`. The heartbeat UPSERT's
      // COALESCE-preserve path correctly handles "absent" / "value" but
      // cannot express "explicit clear" (a `null` bind would preserve).
      // Round-12 agents ack a "report now" request by forwarding the body
      // field as `null`; this UPDATE overrides the column. Caller binds
      // [agentId].
      clearReportRequest: (agentId) =>
        `UPDATE ad_agent_heartbeat
            SET report_requested_at = NULL
          WHERE agent_id = ?`,
      // 2026-08-24 round-12 T6: read back report_requested_at for a single
      // agent so the heartbeat handler can attach reportRequested: boolean
      // to its response. Narrow projection (single column, single row) so
      // the per-heartbeat cost is trivial. Caller binds [agentId].
      readReportRequestedAt:
        `SELECT report_requested_at FROM ad_agent_heartbeat WHERE agent_id = ?`,
      // 2026-08-25: cold-start probe — read existing row's last_heartbeat_at
      // BEFORE this heartbeat's upsert so the route can detect a restart
      // (>5min gap) and wipe any stale report_requested_at that the
      // previous process didn't get to consume. Caller binds [agentId].
      readLastHeartbeatAt:
        `SELECT last_heartbeat_at FROM ad_agent_heartbeat WHERE agent_id = ?`,
      // 2026-08-28 round-58: cold-start auto-trigger helper. After a delete
      // (or first heartbeat ever), the heartbeat row refills via UPSERT but
      // ad_replication_status stays empty until the natural report cycle
      // runs (15min+). The heartbeat handler uses this COUNT to decide
      // whether to auto-trigger a fresh report-now request so the report
      // table refills within 1-2 minutes instead of 15+. Returns 0 when
      // the table has no rows for this agent (post-delete or new agent).
      // Caller binds [agentId].
      hasAnyReplicationRows: (agentId) =>
        `SELECT COUNT(*) AS cnt FROM ad_replication_status WHERE agent_id = ?`,
      reportSummaryFor: (agentId, sinceIso) =>
        `SELECT s.source_dc, s.dest_dc, s.status_code, s.error_message, s.collected_at
         FROM ad_replication_status s
         INNER JOIN (
           SELECT MAX(collected_at) AS max_collected
           FROM ad_replication_status
           WHERE agent_id = ? AND collected_at >= ?
         ) m ON s.collected_at = m.max_collected AND s.agent_id = ?
         ORDER BY s.source_dc, s.dest_dc`,
      // 2026-08-26 round-15: latest-failed-row lookup for the dashboard's
      // "错误摘要" column. Scoped to the same 1-hour lookback the dashboard
      // already uses for status, so the operator sees the most recent
      // failure within the window that drove `fail_count > 0`. Single
      // row, no params for the timestamp (UTC_TIMESTAMP() is fine here —
      // the service calls this only when fail_count > 0 in the 1-hour
      // window, so the row that comes back is guaranteed to be in that
      // window). Uses UTC_TIMESTAMP() to match the storage convention
      // (collected_at rows are written via toMysqlDatetime with UTC
      // components — see agentsList/dcsList hot-fix comment for details).
      latestFailureFor: (agentId) =>
        // 2026-08-27 round-39: lookup window now matches the count window
        // (today, since midnight UTC) so the error message shown is the
        // one that contributed to today's fail_count — not a stale error
        // from yesterday when today's count is 0.
        `SELECT source_dc, dest_dc, error_message, collected_at
         FROM ad_replication_status
         WHERE agent_id = ? AND status_code <> 0
           AND collected_at >= DATE(UTC_TIMESTAMP())
         ORDER BY collected_at DESC, source_dc, dest_dc
         LIMIT 1`,
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
         LIMIT ${Number(limit)}`,
      // 2026-08-26 round-19+: heartbeat-table delete buttons. The operator
      // removes a row when a host is decommissioned; cascades through
      // ad_replication_status (both source_dc and dest_dc matches) so the
      // report table doesn't keep orphans referencing the deleted agent.
      // Each DELETE is a single statement with one bind so affectedRows
      // reflects exactly that table's contribution.
      deleteHeartbeatRow: (agentId) =>
        `DELETE FROM ad_agent_heartbeat WHERE agent_id = ?`,
      deleteReplicationBySource: (agentId) =>
        `DELETE FROM ad_replication_status WHERE source_dc = ?`,
      deleteReplicationByDest: (agentId) =>
        `DELETE FROM ad_replication_status WHERE dest_dc = ?`,
      deletePackageRuns: (agentId) =>
        `DELETE FROM package_runs WHERE agent_id = ?`,
      // DC-tab delete — remove the ad_dcs row only. The DC list is a
      // separate surface from the heartbeat table; deleting a DC leaves
      // the heartbeat row intact (a host can stay in the heartbeat view
      // even if it's no longer classified as a DC).
      deleteDcRow: (dcName) =>
        `DELETE FROM ad_dcs WHERE dc_name = ?`
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
      deleteFailed: "DELETE FROM schema_migrations WHERE version = ? AND status = 'failed'",
      // 2026-08-28 round-55: refresh stale checksum without re-running SQL.
      // Only updates checksum; status, applied_at, applied_by, execution_ms,
      // error_message all preserved. WHERE guards: must already be applied
      // (refuse to "fix" a pending/failed row's checksum — operator should
      // use mark-applied or reset instead).
      updateChecksum: "UPDATE schema_migrations SET checksum = ? WHERE version = ? AND status = 'applied'"
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
    alertMetrics: alertMetrics.mysql,
    // system_config key/value lookup used by the upgrade endpoint to track
    // the seed-file checksum (decides first-run vs re-apply vs skip).
    systemConfig: {
      getByKey: 'SELECT config_key, config_value FROM system_config WHERE config_key = ?',
      upsertByKey: `INSERT INTO system_config (config_key, config_value) VALUES (?, ?)
        ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`
    }
  },
  mssql: {
    health: {
      ping: 'SELECT 1 AS ok',
      lastHeartbeat: 'SELECT TOP 1 last_heartbeat_at AS last FROM ad_agent_heartbeat ORDER BY last_heartbeat_at DESC'
    },
    replication: {
      upsertStatus: `MERGE INTO ad_replication_status AS t
         USING (SELECT
           CAST(? AS DATETIME2)       AS collected_at,
           CAST(? AS NVARCHAR(64))    AS agent_id,
           CAST(? AS NVARCHAR(128))   AS source_dc,
           CAST(? AS NVARCHAR(128))   AS dest_dc,
           CAST(? AS NVARCHAR(64))    AS source_site,
           CAST(? AS NVARCHAR(64))    AS dest_site,
           CAST(? AS NVARCHAR(128))   AS naming_context,
           CAST(? AS DATETIME2)       AS last_success_time,
           CAST(? AS DATETIME2)       AS last_attempt_time,
           ?                          AS status_code,
           CAST(? AS NVARCHAR(2048))  AS error_message,
           ?                          AS users_count,
           ?                          AS groups_count,
           ?                          AS gpos_count,
           ?                          AS locked_count,
           CAST(? AS NVARCHAR(MAX))   AS partner_port_status
         ) AS s
         ON t.source_dc = s.source_dc AND t.dest_dc = s.dest_dc AND t.naming_context = s.naming_context
         WHEN MATCHED THEN UPDATE SET
           collected_at = s.collected_at,
           agent_id = s.agent_id,
           source_site = s.source_site,
           dest_site = s.dest_site,
           last_success_time = s.last_success_time,
           last_attempt_time = s.last_attempt_time,
           status_code = s.status_code,
           error_message = s.error_message,
           users_count = s.users_count,
           groups_count = s.groups_count,
           gpos_count = s.gpos_count,
           locked_count = s.locked_count,
           partner_port_status = s.partner_port_status
         WHEN NOT MATCHED THEN INSERT
           (collected_at, agent_id, source_dc, dest_dc, source_site, dest_site, naming_context, last_success_time, last_attempt_time, status_code, error_message, users_count, groups_count, gpos_count, locked_count, partner_port_status)
           VALUES (s.collected_at, s.agent_id, s.source_dc, s.dest_dc, s.source_site, s.dest_site, s.naming_context, s.last_success_time, s.last_attempt_time, s.status_code, s.error_message, s.users_count, s.groups_count, s.gpos_count, s.locked_count, s.partner_port_status);`,
      upsertHistory: `INSERT INTO ad_replication_history (collected_at, agent_id, source_dc, dest_dc, naming_context, last_success_time, last_attempt_time, attempt_duration_ms, objects_transferred, status_code, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      listRecent: `SELECT TOP (?) source_dc, dest_dc, source_site, dest_site, status_code, collected_at FROM ad_replication_status ORDER BY collected_at DESC`,
      listBySite: `SELECT TOP (?) source_dc, dest_dc, source_site, dest_site, status_code, collected_at FROM ad_replication_status WHERE source_site = ? OR dest_site = ? ORDER BY collected_at DESC`,
      latestSummaryPerDc: `SELECT t.source_dc, t.users_count, t.groups_count, t.gpos_count, t.locked_count, t.collected_at FROM ad_replication_status t OUTER APPLY (SELECT TOP 1 collected_at, users_count, groups_count, gpos_count, locked_count FROM ad_replication_status WHERE source_dc = t.source_dc AND naming_context = '__dc_summary__' ORDER BY collected_at DESC) s WHERE t.naming_context = '__dc_summary__' GROUP BY t.source_dc, t.users_count, t.groups_count, t.gpos_count, t.locked_count, t.collected_at ORDER BY t.source_dc`,
      partnersCount: `SELECT COUNT(*) AS c FROM ad_replication_status WHERE source_dc = ? AND naming_context <> '__dc_summary__' AND collected_at BETWEEN DATEADD(MINUTE, -?, ?) AND DATEADD(MINUTE, ?, ?)`
    },
    discovery: {
      // 2026-08-25 Bug C: tedious driver rejects row-constructor params
      // (`USING (VALUES (?, ?, ...))`) when ANY NVARCHAR column is NULL.
      // site_hint and os_version are nullable NVARCHAR(64); when an agent
      // reports a DC and either field is null, the driver throws
      // "Validation failed for parameter 'pN'. Invalid string" before
      // SQL Server sees the query, and the row silently never lands —
      // which is why freshly-installed agents' DCs never appear in the
      // 域控清单 (admin → AD 域控清单). Rewrite to the same
      // `USING (SELECT CAST(? AS TYPE) AS col, ...)` subquery pattern
      // already proven in upsertStatus (line 405). The tedious driver
      // validates NVARCHAR params correctly when each one is bound via
      // its own named CAST in a subquery.
      //
      // Column types match db/schema/mssql/01-tables.sql:78-97:
      //   dc_name NVARCHAR(128) PK, site_hint NVARCHAR(64) NULL,
      //   os_version NVARCHAR(64) NULL, when_created DATETIME2 NULL,
      //   is_* BIT NOT NULL (8 role flags), discovered_at DATETIME2,
      //   discovered_by_agent_id NVARCHAR(64) NULL.
      upsertDc: `MERGE INTO ad_dcs AS t
         USING (SELECT
           CAST(? AS NVARCHAR(128))   AS dc_name,
           CAST(? AS NVARCHAR(64))    AS site_hint,
           CAST(? AS NVARCHAR(64))    AS os_version,
           CAST(? AS DATETIME2)       AS when_created,
           ?                          AS is_pdc,
           ?                          AS is_gc,
           ?                          AS is_rid_master,
           ?                          AS is_schema_master,
           ?                          AS is_domain_naming_master,
           ?                          AS is_infrastructure_master,
           CAST(? AS DATETIME2)       AS discovered_at,
           CAST(? AS NVARCHAR(64))    AS discovered_by_agent_id
         ) AS s
         ON t.dc_name = s.dc_name
         WHEN MATCHED THEN UPDATE SET
           site_hint = s.site_hint,
           os_version = s.os_version,
           when_created = s.when_created,
           is_pdc = s.is_pdc,
           is_gc = s.is_gc,
           is_rid_master = s.is_rid_master,
           is_schema_master = s.is_schema_master,
           is_domain_naming_master = s.is_domain_naming_master,
           is_infrastructure_master = s.is_infrastructure_master,
           discovered_at = SYSUTCDATETIME(),
           discovered_by_agent_id = s.discovered_by_agent_id
         WHEN NOT MATCHED THEN INSERT
           (dc_name, site_hint, os_version, when_created, is_pdc, is_gc, is_rid_master, is_schema_master, is_domain_naming_master, is_infrastructure_master, discovered_at, discovered_by_agent_id)
           VALUES (s.dc_name, s.site_hint, s.os_version, s.when_created, s.is_pdc, s.is_gc, s.is_rid_master, s.is_schema_master, s.is_domain_naming_master, s.is_infrastructure_master, s.discovered_at, s.discovered_by_agent_id);`
    },
    users: {
      findByUsername: `SELECT TOP 1 u.id, u.username, u.password_hash, u.role_id, u.status, u.token_version, r.role_name, STRING_AGG(rp.permission, ',') AS permissions FROM sys_users u LEFT JOIN sys_roles r ON u.role_id = r.id LEFT JOIN role_permissions rp ON rp.role_id = r.id WHERE u.username = ? GROUP BY u.id, u.username, u.password_hash, u.role_id, u.status, u.token_version, r.role_name`,
      list: 'SELECT u.id, u.username, u.role_id, u.status, u.last_login_at, u.created_at, r.role_name FROM sys_users u LEFT JOIN sys_roles r ON u.role_id = r.id ORDER BY u.id',
      create: 'INSERT INTO sys_users (username, password_hash, role_id, status) VALUES (?, ?, ?, ?)',
      update: 'UPDATE sys_users SET password_hash = COALESCE(?, password_hash), role_id = COALESCE(?, role_id), status = COALESCE(?, status) WHERE id = ?',
      delete: 'DELETE FROM sys_users WHERE id = ?',
      recordLogin: 'UPDATE sys_users SET last_login_at = SYSUTCDATETIME() WHERE id = ?',
      // I1 token_version: must use `?` so the driver wrapper rewrites to @p1
      // and binds via request.input('p1', ...). The MSSQL driver (see
      // drivers/mssql.js:16-28) only rewrites `?` → `@pN` and binds inputs
      // named `pN`; literal `@id` is never declared and raises "Must declare
      // the scalar variable @id" on real MSSQL. Mirrors the MySQL section.
      bumpTokenVersion: 'UPDATE sys_users SET token_version = token_version + 1 WHERE id = ?',
      getTokenVersion: 'SELECT token_version FROM sys_users WHERE id = ?',
      getAuthStatus: 'SELECT token_version, status FROM sys_users WHERE id = ?',
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
      getAgentTokenBundle: `SELECT config_key, config_value FROM system_config WHERE config_key IN ('agent_token_current', 'agent_token_previous', 'agent_token_rotated_at', 'agent_token_version')`,
      getJwtSecretBundle: `SELECT config_key, config_value FROM system_config WHERE config_key IN ('jwt_secret_current', 'jwt_secret_previous', 'jwt_secret_rotated_at', 'jwt_secret_previous_ttl_days')`,
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
      // 2026-08-27 round-28.5: surface is_bridgehead so the admin 域控清单
      // can show the bridgehead toggle next to the FSMO role toggles. The
      // bridgehead is an operator-chosen designation (NOT a FSMO role) used
      // by the all-sites replication matrix view to pick a primary DC per
      // site; sites without a marked bridgehead fall back to lex-first dc_name.
      // 2026-08-27 round-29: added dcs.updateFlags helper — same partial-update
      // shape as sites.updatePartial / systemPorts.updatePartial so the route
      // can build the SET list from whatever body keys the operator toggled.
      listCatalog: `SELECT d.dc_name AS dcName, d.site_id AS siteId, s.site_name AS siteName, d.site_hint AS siteHint, d.os_version AS osVersion, d.when_created AS whenCreated, d.is_pdc AS isPdc, d.is_gc AS isGc, d.is_rid_master AS isRidMaster, d.is_schema_master AS isSchemaMaster, d.is_domain_naming_master AS isDomainNamingMaster, d.is_infrastructure_master AS isInfrastructureMaster, d.is_bridgehead AS isBridgehead, d.discovered_at AS discoveredAt, d.discovered_by_agent_id AS discoveredByAgentId FROM ad_dcs d LEFT JOIN ad_sites s ON d.site_id = s.site_id ORDER BY d.dc_name`,
      assignSite: 'UPDATE ad_dcs SET site_id = ? WHERE dc_name = ?',
      assignSiteUnbind: 'UPDATE ad_dcs SET site_id = NULL WHERE dc_name = ?',
      updateFlags: (fields) => `UPDATE ad_dcs SET ${fields.join(', ')} WHERE dc_name = ?`
    },
    // Cross-DC consistency scoring (Task 5). Reads the latest row per agent
    // from pkg_ad_domain_consistency.metrics (Task 4 ingest path) and feeds
    // services/consistency.js's deriveConsistency() majority-hash algorithm.
    //
    // MSSQL — uses OUTER APPLY TOP 1 to pick the latest (MAX ts) row per
    // agent. Mirrors the MySQL 5.7 portable (agent_id, ts) IN (subquery)
    // shape; both dialects produce identical column order so service code
    // stays dialect-agnostic. Bracketed [pkg_ad_domain_consistency].[metrics]
    // form is the MSSQL-canonical delimited identifier, but backticks also
    // parse fine here — bracketed form kept for clarity in MSSQL scripts.
    consistency: {
      latestPerAgent: `SELECT m.agent_id, m.ts, m.user_count, m.user_hash, m.group_count, m.group_hash, m.gpo_count, m.gpo_hash, m.error_code FROM [pkg_ad_domain_consistency].[metrics] m OUTER APPLY (SELECT TOP 1 ts AS max_ts FROM [pkg_ad_domain_consistency].[metrics] WHERE agent_id = m.agent_id ORDER BY ts DESC) la WHERE m.ts = la.max_ts`
    },
    dashboard: {
      overviewCounts: `SELECT COUNT(*) AS total, SUM(CASE WHEN status_code = 0 THEN 1 ELSE 0 END) AS healthy, SUM(CASE WHEN status_code = 1 THEN 1 ELSE 0 END) AS warning, SUM(CASE WHEN status_code >= 2 THEN 1 ELSE 0 END) AS errored, MAX(collected_at) AS last_update FROM ad_replication_status`,
      agentCount: `SELECT COUNT(*) AS agent_count FROM ad_agent_heartbeat WHERE last_heartbeat_at IS NOT NULL AND agent_id <> '__healthcheck__'`,
      siteMatrix: `SELECT source_site, dest_site, SUM(CASE WHEN status_code >= 2 THEN 1 ELSE 0 END) AS error_count, SUM(CASE WHEN status_code = 1 THEN 1 ELSE 0 END) AS warning_count, COUNT(*) AS total FROM ad_replication_status WHERE source_site IS NOT NULL AND dest_site IS NOT NULL GROUP BY source_site, dest_site ORDER BY source_site, dest_site`,
      // 2026-08-26 round-21: /topology used to return every row in
      // ad_replication_status, including stale round-19 leftovers and
      // test/junk rows (*, __tz_test, DC01→"") — operators saw 42 links
      // instead of the 19 the round-20 topology actually emits. The fix:
      // (a) derive site + dc nodes from ad_sites / ad_dcs (catalog is
      // source of truth — agent-reported source_site is a free-text hint
      // and does not match catalog site_name), (b) for links, take the
      // latest row per (source_dc, dest_dc) pair where both are known
      // DCs and source_dc != dest_dc, and (c) drop rows older than 30
      // minutes (UTC) so pairs the daemon stopped emitting — e.g. the
      // round-19 topology pairs that were renamed in round-20 — fall
      // out of the graph. UTC clock is essential: collected_at is in
      // UTC but MySQL NOW() returns session-tz (round-15 UTC cleanup).
      topologyNodes: `
        SELECT s.site_id   AS site_id,
               s.site_name AS site_name,
               d.dc_name   AS dc_name
        FROM ad_sites s
        LEFT JOIN ad_dcs d ON d.site_id = s.site_id
        ORDER BY s.site_name, d.dc_name
      `,
      topologyLinks: `
        SELECT t1.source_dc, t1.dest_dc, t1.status_code, t1.last_success_time
        FROM ad_replication_status t1
        INNER JOIN ad_dcs sd ON sd.dc_name = t1.source_dc
        INNER JOIN ad_dcs dd ON dd.dc_name = t1.dest_dc
        WHERE t1.source_dc <> t1.dest_dc
          AND t1.naming_context NOT IN ('__dc_summary__', 'META')
          AND t1.collected_at = (
            SELECT MAX(t2.collected_at) FROM ad_replication_status t2
            WHERE t2.source_dc = t1.source_dc
              AND t2.dest_dc   = t1.dest_dc
              AND t2.naming_context NOT IN ('__dc_summary__', 'META')
          )
          AND t1.collected_at >= DATEADD(MINUTE, -30, SYSUTCDATETIME())
        ORDER BY t1.source_dc, t1.dest_dc
      `,
      errors: `SELECT source_dc, dest_dc, source_site, dest_site, naming_context, status_code, last_success_time, last_attempt_time, CASE WHEN last_success_time IS NULL OR last_attempt_time IS NULL THEN NULL ELSE CAST(DATEDIFF_BIG(SECOND, last_success_time, last_attempt_time) AS float) / 60.0 END AS duration_minutes FROM ad_replication_status WHERE status_code <> 0 ORDER BY last_attempt_time DESC`,
      agents: `SELECT agent_id, last_heartbeat_at, agent_version, last_report_at, last_report_status, pending_queue_size, CASE WHEN last_heartbeat_at IS NULL THEN NULL ELSE CAST(DATEDIFF_BIG(SECOND, last_heartbeat_at, SYSUTCDATETIME()) AS float) END AS seconds_since_heartbeat FROM ad_agent_heartbeat WHERE agent_id <> '__healthcheck__' ORDER BY agent_id`,
      siteLookup: `SELECT site_id, site_name, region_code, is_hub, description FROM ad_sites WHERE site_name = ?`,
      dcsBySite: `SELECT dc_name, os_version, is_pdc, is_gc, is_rid_master, is_schema_master, is_domain_naming_master, is_infrastructure_master, discovered_at, discovered_by_agent_id FROM ad_dcs WHERE site_id = ? ORDER BY dc_name`,
      dcReplicationLinks: (placeholders) => `SELECT source_dc, dest_dc, naming_context, status_code, last_success_time, last_attempt_time, CASE WHEN last_success_time IS NULL OR last_attempt_time IS NULL THEN NULL ELSE CAST(DATEDIFF_BIG(SECOND, last_success_time, last_attempt_time) AS float) / 60.0 END AS duration_minutes FROM ad_replication_status WHERE source_dc IN (${placeholders}) AND dest_dc IN (${placeholders}) ORDER BY source_dc, dest_dc, naming_context`,
      refreshSeconds: `SELECT config_value FROM system_config WHERE config_key = 'site_matrix_refresh_seconds'`,
      // 2026-08-27 round-27: all-sites variant for the global replication
      // matrix view. MSSQL mirror of the MySQL helpers above. OUTER APPLY
      // is the SQL Server idiom for the per-pair max-collected_at lookup
      // (matches the latestSummaryPerDc + topologyLinks pattern in this
      // branch). DATETIME2-typed params are JS Dates cast by the driver.
      allSitesOrdered: `SELECT site_id, site_name, region_code, is_hub, description FROM ad_sites ORDER BY is_hub DESC, region_code, site_name`,
      allDcsBySite: `SELECT d.dc_name, d.site_id, d.os_version, d.when_created, d.is_pdc, d.is_gc, d.is_rid_master, d.is_schema_master, d.is_domain_naming_master, d.is_infrastructure_master, d.is_bridgehead, d.discovered_at, d.discovered_by_agent_id FROM ad_dcs d INNER JOIN ad_sites s ON s.site_id = d.site_id ORDER BY s.site_name, d.dc_name`,
      allReplicationLinks: `SELECT t1.source_dc, t1.dest_dc, t1.naming_context, t1.status_code, t1.last_success_time, t1.last_attempt_time, CASE WHEN t1.last_success_time IS NULL OR t1.last_attempt_time IS NULL THEN NULL ELSE CAST(DATEDIFF_BIG(SECOND, t1.last_success_time, t1.last_attempt_time) AS float) / 60.0 END AS duration_minutes FROM ad_replication_status t1 OUTER APPLY (SELECT TOP 1 t2.collected_at AS max_collected_at FROM ad_replication_status t2 WHERE t2.source_dc = t1.source_dc AND t2.dest_dc = t1.dest_dc AND t2.naming_context NOT IN ('__dc_summary__', 'META') ORDER BY t2.collected_at DESC) m WHERE t1.source_dc <> t1.dest_dc AND t1.naming_context NOT IN ('__dc_summary__', 'META') AND t1.collected_at = m.max_collected_at AND t1.collected_at >= DATEADD(MINUTE, -30, SYSUTCDATETIME()) ORDER BY t1.source_dc, t1.dest_dc, t1.naming_context`,
      // 2026-08-28 round-46: MSSQL mirror of latestPartnerPortPerPair.
      // LIKE '__partner_ports__:%' is portable across dialects (round-14
      // confirmed MSSQL handles the wildcard as expected). The TOP 1
      // correlated subquery is the SQL Server idiom that mirrors the
      // MySQL MAX(t2.collected_at) = ... pattern.
      latestPartnerPortPerPair: `SELECT t1.source_dc, t1.dest_dc, t1.naming_context, t1.status_code, t1.last_attempt_time, t1.partner_port_status FROM ad_replication_status t1 OUTER APPLY (SELECT TOP 1 t2.collected_at AS max_collected_at FROM ad_replication_status t2 WHERE t2.source_dc = t1.source_dc AND t2.dest_dc = t1.dest_dc AND t2.naming_context LIKE '__partner_ports__:%' ORDER BY t2.collected_at DESC) m WHERE t1.naming_context LIKE '__partner_ports__:%' AND t1.source_dc <> t1.dest_dc AND t1.collected_at = m.max_collected_at AND t1.collected_at >= DATEADD(MINUTE, -30, SYSUTCDATETIME()) ORDER BY t1.source_dc, t1.dest_dc`,
      // 2026-08-28 round-47: replicationLogRecentAttempts helper removed —
      // the 复制伙伴端口健康监控 route no longer embeds attempts[] on each
      // partner row (port-health-only view). Per-pair history for the
      // inline caret in 复制状态概览 still uses replicationLogPerPair
      // below.
      // 2026-08-28 round-45: MSSQL mirror of replicationLogPerPair. TOP (?)
      // must be the FIRST bound param (tedious driver order: literal value
      // precedes the WHERE-bound ones — see center/src/db/drivers/mssql.js).
      // Caller binds [limit, source, dest].
      replicationLogPerPair: `SELECT TOP (?) source_dc, dest_dc, naming_context, status_code, last_success_time, last_attempt_time, attempt_duration_ms, objects_transferred, error_message, collected_at FROM ad_replication_history WHERE source_dc = ? AND dest_dc = ? AND collected_at >= DATEADD(HOUR, -24, SYSUTCDATETIME()) ORDER BY collected_at DESC`
    },
    heartbeat: {
      // 2026-08-24 round-12: report_requested_at added (last col). ISNULL
      // on WHEN MATCHED UPDATE means a `null` param preserves the existing
      // column — agents pre-T6 that don't forward the field will not wipe
      // the "report now" request.
      //
      // 2026-08-25: date params (`last_report_at`, `report_requested_at`)
      // wrapped with `CAST(? AS DATETIME2)`. Without the cast, tedious
      // binds the JS Date / ISO string with an inferred type (varchar or
      // nvarchar), and MSSQL then throws "Conversion failed when
      // converting date and/or time from character string" (error 241) on
      // the assignment to the datetime2 column. Same fix pattern as
      // ad_replication_status.upsertStatus (Bug B, ad8745a).
      upsert: `MERGE INTO ad_agent_heartbeat AS t USING (SELECT
         ? AS agent_id,
         ? AS agent_version,
         CAST(? AS DATETIME2) AS last_report_at,
         ? AS last_report_status,
         ? AS pending_queue_size,
         ? AS agent_token_version,
         CAST(? AS DATETIME2) AS report_requested_at
       ) AS s ON t.agent_id = s.agent_id WHEN MATCHED THEN UPDATE SET last_heartbeat_at = SYSUTCDATETIME(), agent_version = s.agent_version, last_report_at = s.last_report_at, last_report_status = s.last_report_status, pending_queue_size = s.pending_queue_size, agent_token_version = s.agent_token_version, report_requested_at = ISNULL(s.report_requested_at, t.report_requested_at) WHEN NOT MATCHED THEN INSERT (agent_id, last_heartbeat_at, agent_version, last_report_at, last_report_status, pending_queue_size, agent_token_version, report_requested_at) VALUES (s.agent_id, SYSUTCDATETIME(), s.agent_version, s.last_report_at, s.last_report_status, s.pending_queue_size, s.agent_token_version, s.report_requested_at);`,
      // 2026-08-21 UX redesign (auto-delivery): same shape as the MySQL
      // variant — see the comment above.
      tokenDeliveryList: `SELECT agent_id, agent_token_version, last_heartbeat_at FROM ad_agent_heartbeat WHERE agent_id <> '__healthcheck__' ORDER BY agent_id`,
      // 2026-08-26 round-15: source-of-truth switch for the report-status
      // signal. Mirrors the MySQL branch — derive last_report_at /
// last_report_status from ad_replication_status instead of the
// self-declared heartbeat columns. MSSQL uses DATEADD/SYSUTCDATETIME()
// instead of NOW()/INTERVAL.
      agentsList: `SELECT h.agent_id, h.agent_version, h.last_heartbeat_at,
                          rep.last_report_at,
                          CASE
                            WHEN rep.last_report_at IS NULL THEN NULL
                            WHEN rep.last_report_at >= DATEADD(HOUR, -1, SYSUTCDATETIME()) THEN
                              CASE WHEN COALESCE(recent.fail_count, 0) > 0 THEN CAST('partial_failure' AS VARCHAR(32)) ELSE CAST('success' AS VARCHAR(32)) END
                            ELSE CAST('stale' AS VARCHAR(32))
                          END AS last_report_status,
                          COALESCE(recent.success_count, 0) AS success_count,
                          COALESCE(recent.fail_count, 0) AS fail_count,
                          COALESCE(recent.total_count, 0) AS total_count,
                          h.pending_queue_size, h.report_requested_at
             FROM ad_agent_heartbeat h
             LEFT JOIN (
               SELECT agent_id, MAX(collected_at) AS last_report_at
               FROM ad_replication_status
               GROUP BY agent_id
             ) rep ON rep.agent_id = h.agent_id
             LEFT JOIN (
               SELECT agent_id,
                      SUM(CASE WHEN status_code = 0 THEN 1 ELSE 0 END) AS success_count,
                      SUM(CASE WHEN status_code <> 0 THEN 1 ELSE 0 END) AS fail_count,
                      COUNT(*) AS total_count
               FROM ad_replication_status
               WHERE collected_at >= CAST(SYSUTCDATETIME() AS DATE)
               GROUP BY agent_id
             ) recent ON recent.agent_id = h.agent_id
             WHERE h.agent_id <> '__healthcheck__'
             ORDER BY h.agent_id`,
      dcsList: `SELECT h.agent_id, h.agent_version, h.last_heartbeat_at,
                       rep.last_report_at,
                       CASE
                         WHEN rep.last_report_at IS NULL THEN NULL
                         WHEN rep.last_report_at >= DATEADD(HOUR, -1, SYSUTCDATETIME()) THEN
                           CASE WHEN COALESCE(recent.fail_count, 0) > 0 THEN CAST('partial_failure' AS VARCHAR(32)) ELSE CAST('success' AS VARCHAR(32)) END
                         ELSE CAST('stale' AS VARCHAR(32))
                       END AS last_report_status,
                       COALESCE(recent.success_count, 0) AS success_count,
                       COALESCE(recent.fail_count, 0) AS fail_count,
                       COALESCE(recent.total_count, 0) AS total_count,
                       h.pending_queue_size, h.report_requested_at,
                       d.dc_name, d.ip_address, d.os_version, d.is_pdc,
                       s.site_name, s.region_code
          FROM ad_agent_heartbeat h
          LEFT JOIN ad_dcs d ON d.dc_name = h.agent_id
          LEFT JOIN ad_sites s ON s.site_id = d.site_id
          LEFT JOIN (
            SELECT agent_id, MAX(collected_at) AS last_report_at
            FROM ad_replication_status
            GROUP BY agent_id
          ) rep ON rep.agent_id = h.agent_id
          LEFT JOIN (
            SELECT agent_id,
                   SUM(CASE WHEN status_code = 0 THEN 1 ELSE 0 END) AS success_count,
                   SUM(CASE WHEN status_code <> 0 THEN 1 ELSE 0 END) AS fail_count,
                   COUNT(*) AS total_count
            FROM ad_replication_status
            WHERE collected_at >= CAST(SYSUTCDATETIME() AS DATE)
            GROUP BY agent_id
          ) recent ON recent.agent_id = h.agent_id
          WHERE h.agent_id <> '__healthcheck__'
          ORDER BY h.agent_id`,
      // 2026-08-24 round-12: requestReport MERGE — insert a stub heartbeat
      // row if the agent hasn't checked in yet, or set the column if it
      // has. Caller binds [agentId, requestedAt] (Date).
      //
      // 2026-08-25: `report_requested_at` wrapped with `CAST(? AS DATETIME2)`
      // for the same reason as upsert above — bound JS Date without cast
      // hits error 241.
      requestReport: (agentId, requestedAtIso) =>
        `MERGE INTO ad_agent_heartbeat AS t
         USING (SELECT ? AS agent_id, CAST(? AS DATETIME2) AS report_requested_at) AS s
         ON t.agent_id = s.agent_id
         WHEN NOT MATCHED THEN
           INSERT (agent_id, last_heartbeat_at, report_requested_at)
           VALUES (s.agent_id, SYSUTCDATETIME(), s.report_requested_at)
         WHEN MATCHED THEN
           UPDATE SET report_requested_at = s.report_requested_at;`,
      // 2026-08-24 round-12 T-fix: clearReportRequest — direct UPDATE that
      // actually sets `report_requested_at = NULL`. Same rationale as the
      // MySQL variant: heartbeat MERGE's ISNULL-preserve path cannot
      // express "explicit clear". Caller binds [agentId].
      //
      // 2026-08-25: uses `?` not the unbound `@p_agent_id` literal — the
      // mssql driver remaps `?` to `@p1, @p2, …` but a hand-written
      // `@p_agent_id` is never bound, so MSSQL would throw "Must declare
      // scalar variable". Fix is identical in shape to the MySQL variant.
      clearReportRequest: (agentId) =>
        `UPDATE ad_agent_heartbeat
            SET report_requested_at = NULL
          WHERE agent_id = ?`,
      // 2026-08-24 round-12 T6: read back report_requested_at for a single
      // agent so the heartbeat handler can attach reportRequested: boolean
      // to its response. Same shape as the MySQL variant (single column,
      // single row). Caller binds [agentId].
      readReportRequestedAt:
        `SELECT report_requested_at FROM ad_agent_heartbeat WHERE agent_id = ?`,
      // 2026-08-25: cold-start probe — read existing row's last_heartbeat_at
      // BEFORE this heartbeat's upsert so the route can detect a restart
      // (>5min gap) and wipe any stale report_requested_at that the
      // previous process didn't get to consume. Caller binds [agentId].
      readLastHeartbeatAt:
        `SELECT last_heartbeat_at FROM ad_agent_heartbeat WHERE agent_id = ?`,
      // 2026-08-28 round-58: cold-start auto-trigger helper — MSSQL mirror.
      // Same intent as the MySQL variant: COUNT(*) over ad_replication_status
      // for the agent so the heartbeat handler can decide whether to
      // auto-trigger a fresh report-now request after a delete + resurrect
      // (or first heartbeat ever). Returns 0 when the table has no rows
      // for this agent. The CAST(? AS NVARCHAR(64)) matches the column
      // type — without the cast the driver sends NVARCHAR(MAX) which
      // silently mismatches the agent_id index. Caller binds [agentId].
      hasAnyReplicationRows: (agentId) =>
        `SELECT COUNT(*) AS cnt FROM ad_replication_status WHERE agent_id = CAST(? AS NVARCHAR(64))`,
      reportSummaryFor: (agentId, sinceIso) =>
        `SELECT s.source_dc, s.dest_dc, s.status_code, s.error_message, s.collected_at
         FROM ad_replication_status s
         INNER JOIN (
           SELECT TOP 1 collected_at AS max_collected
           FROM ad_replication_status
           WHERE agent_id = CAST(? AS NVARCHAR(64)) AND collected_at >= CAST(? AS DATETIME2)
           ORDER BY collected_at DESC
         ) m ON s.collected_at = m.max_collected AND s.agent_id = CAST(? AS NVARCHAR(64))
         ORDER BY s.source_dc, s.dest_dc`,
      // 2026-08-26 round-15: latest-failed-row lookup. Mirrors the MySQL
      // variant — scoped to the 1-hour window, single row, ordered by
      // collected_at DESC. MSSQL uses TOP 1 + DATEADD/SYSUTCDATETIME().
      //
      // 2026-08-27 round-39: lookup window is "today" (since midnight UTC)
      // to match the count window so the displayed error is one that
      // contributed to today's fail_count.
      latestFailureFor: (agentId) =>
        `SELECT TOP 1 source_dc, dest_dc, error_message, collected_at
         FROM ad_replication_status
         WHERE agent_id = CAST(? AS NVARCHAR(64)) AND status_code <> 0
           AND collected_at >= CAST(SYSUTCDATETIME() AS DATE)
         ORDER BY collected_at DESC, source_dc, dest_dc`,
      latestReportEntries: (agentId, sinceIso, limit) =>
        `SELECT collected_at, source_dc, dest_dc, source_site, dest_site, naming_context,
                 status_code, error_message, last_success_time, last_attempt_time
         FROM ad_replication_status
         WHERE agent_id = CAST(? AS NVARCHAR(64))
           AND collected_at = (
             SELECT TOP 1 collected_at FROM ad_replication_status
             WHERE agent_id = CAST(? AS NVARCHAR(64)) AND collected_at >= CAST(? AS DATETIME2)
             ORDER BY collected_at DESC
           )
         ORDER BY source_dc, dest_dc`,
      // 2026-08-26 round-19+: heartbeat-table delete buttons — MSSQL
      // variant. Each DELETE binds the agent_id with CAST(? AS NVARCHAR(64))
      // to match the row's column type (agent_id is NVARCHAR(64)) — without
      // the cast the driver sends NVARCHAR(MAX) which silently mismatches
      // the index and the WHERE never matches. Identical shape to MySQL.
      deleteHeartbeatRow: (agentId) =>
        `DELETE FROM ad_agent_heartbeat WHERE agent_id = CAST(? AS NVARCHAR(64))`,
      deleteReplicationBySource: (agentId) =>
        `DELETE FROM ad_replication_status WHERE source_dc = CAST(? AS NVARCHAR(64))`,
      deleteReplicationByDest: (agentId) =>
        `DELETE FROM ad_replication_status WHERE dest_dc = CAST(? AS NVARCHAR(64))`,
      deletePackageRuns: (agentId) =>
        `DELETE FROM package_runs WHERE agent_id = CAST(? AS NVARCHAR(64))`,
      deleteDcRow: (dcName) =>
        `DELETE FROM ad_dcs WHERE dc_name = CAST(? AS NVARCHAR(128))`
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
      deleteFailed: "DELETE FROM schema_migrations WHERE version = CAST(? AS VARCHAR(32)) AND status = 'failed'",
      // 2026-08-28 round-55: refresh stale checksum without re-running SQL.
      // MSSQL needs CAST(?) on the new value because checksum is VARCHAR(64)
      // and the @pN rewriter passes through whatever the driver is given;
      // we still keep the explicit cast for clarity & safety.
      updateChecksum: "UPDATE schema_migrations SET checksum = CAST(? AS VARCHAR(64)) WHERE version = CAST(? AS VARCHAR(32)) AND status = 'applied'"
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
    alertMetrics: alertMetrics.mssql,
    // system_config key/value lookup — MSSQL uses MERGE for upsert (matches
    // other MSSQL patterns here). CAST(? AS VARCHAR(64)) aligns the param
    // type with the PK column.
    systemConfig: {
      getByKey: 'SELECT config_key, config_value FROM system_config WHERE config_key = CAST(? AS VARCHAR(64))',
      upsertByKey: `MERGE INTO system_config AS t USING (SELECT CAST(? AS VARCHAR(64)) AS config_key, ? AS config_value) AS s
        ON t.config_key = s.config_key
        WHEN MATCHED THEN UPDATE SET config_value = s.config_value
        WHEN NOT MATCHED THEN INSERT (config_key, config_value) VALUES (s.config_key, s.config_value);`
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