// R158.79 (2026-10-12) — ad_member_heartbeat 专表 SQL helper.
//   跟 R158.78 ad_member_eventlog_* + R158.74 ad_member_server_ports
//   + R158.72 ad_account_change 同 precedent. 跟 db/sql.js
//   heartbeat namespace agentsList / dcsList 1:1 平行, 但 mount 在
//   heartbeat.membersList / .deleteMemberRow / .memberUpsert (3 helper,
//   namespace 内聚). 走 ad_member_servers.hostname FK CASCADE.
//
// 调用方:
//   - routes/agent.js:608-614 + 649-655 (noad agent heartbeat 上报时,
//     跟 touchLastSeen 同 precedent, best-effort try/catch)
//   - routes/heartbeat-report.js GET/DELETE /api/admin/heartbeat-report/members[/:hostname]
//   - services/heartbeat-report.js#listMembers() / deleteMember()

// 13 列 (跟 db/sql.js heartbeat.upsert 平行, 字段名一致):
//   1. hostname
//   2. agent_id
//   3. agent_version
//   4. last_heartbeat_at
//   5. last_report_at
//   6. last_report_status
//   7. pending_queue_size
//   8. heartbeat_interval_seconds
//   9. report_requested_at
//  10. client_settings_version
//  11. agent_token_version
//  12. last_upgrade_event
//  13. agent_type ('non-ad' literal)

// ============================================================
// upsert — 中心端 noad agent heartbeat 上报时同步写
// ============================================================
const UPSERT_MYSQL = `INSERT INTO ad_member_heartbeat
  (hostname, agent_id, agent_version, last_heartbeat_at,
   last_report_at, last_report_status, pending_queue_size,
   heartbeat_interval_seconds, report_requested_at,
   client_settings_version, agent_token_version, last_upgrade_event,
   agent_type)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
  agent_id = VALUES(agent_id),
  agent_version = VALUES(agent_version),
  last_heartbeat_at = VALUES(last_heartbeat_at),
  last_report_at = VALUES(last_report_at),
  last_report_status = VALUES(last_report_status),
  pending_queue_size = VALUES(pending_queue_size),
  heartbeat_interval_seconds = VALUES(heartbeat_interval_seconds),
  report_requested_at = VALUES(report_requested_at),
  client_settings_version = VALUES(client_settings_version),
  agent_token_version = VALUES(agent_token_version),
  last_upgrade_event = VALUES(last_upgrade_event),
  agent_type = VALUES(agent_type),
  updated_at = UTC_TIMESTAMP()`;

const UPSERT_MSSQL = `MERGE INTO ad_member_heartbeat AS t
USING (SELECT
  CAST(? AS VARCHAR(128)) AS hostname,
  CAST(? AS VARCHAR(64))  AS agent_id,
  CAST(? AS VARCHAR(32))  AS agent_version,
  CAST(? AS DATETIME2)    AS last_heartbeat_at,
  CAST(? AS DATETIME2)    AS last_report_at,
  CAST(? AS VARCHAR(32))  AS last_report_status,
  CAST(? AS INT)          AS pending_queue_size,
  CAST(? AS INT)          AS heartbeat_interval_seconds,
  CAST(? AS DATETIME2)    AS report_requested_at,
  CAST(? AS INT)          AS client_settings_version,
  CAST(? AS INT)          AS agent_token_version,
  CAST(? AS VARCHAR(64))  AS last_upgrade_event,
  CAST(? AS VARCHAR(16))  AS agent_type
) AS s
ON t.hostname = s.hostname
WHEN MATCHED THEN UPDATE SET
  agent_id = s.agent_id,
  agent_version = s.agent_version,
  last_heartbeat_at = s.last_heartbeat_at,
  last_report_at = s.last_report_at,
  last_report_status = s.last_report_status,
  pending_queue_size = s.pending_queue_size,
  heartbeat_interval_seconds = s.heartbeat_interval_seconds,
  report_requested_at = s.report_requested_at,
  client_settings_version = s.client_settings_version,
  agent_token_version = s.agent_token_version,
  last_upgrade_event = s.last_upgrade_event,
  agent_type = s.agent_type,
  updated_at = SYSUTCDATETIME()
WHEN NOT MATCHED THEN INSERT
  (hostname, agent_id, agent_version, last_heartbeat_at,
   last_report_at, last_report_status, pending_queue_size,
   heartbeat_interval_seconds, report_requested_at,
   client_settings_version, agent_token_version, last_upgrade_event,
   agent_type)
VALUES
  (s.hostname, s.agent_id, s.agent_version, s.last_heartbeat_at,
   s.last_report_at, s.last_report_status, s.pending_queue_size,
   s.heartbeat_interval_seconds, s.report_requested_at,
   s.client_settings_version, s.agent_token_version, s.last_upgrade_event,
   s.agent_type);`;

// ============================================================
// membersList — 跟 heartbeat.dcsList 平行, LEFT JOIN 改 ad_member_servers + ad_sites
//   返 hostname (代 agent_id) + siteName (跟 ad_sites 关联) + agentType='non-ad'
//   跟 ad_agent_heartbeat.agentsList / dcsList 1:1 平行 + member-server 特有列
// ============================================================
const LIST_MYSQL = `SELECT h.hostname, h.agent_id, h.agent_type, h.agent_version,
                            h.last_heartbeat_at, h.last_report_at, h.last_report_status,
                            h.pending_queue_size, h.heartbeat_interval_seconds,
                            h.report_requested_at,
                            m.site_id, s.site_name, s.region_code,
                            m.ip_address, m.os_version
                     FROM ad_member_heartbeat h
                     LEFT JOIN ad_member_servers m ON m.hostname = h.hostname
                     LEFT JOIN ad_sites s ON s.site_id = m.site_id
                     -- R158.X.115 (2026-10-20) — 排除退役/暂停管控的主机。
                     --   与上面 LEFT JOIN 不冲突: 主键是 h.hostname (心跳行),
                     --   退役机器的心跳行本就不该出现在"当前 agent"列表。
                     WHERE NOT EXISTS (SELECT 1 FROM ad_member_servers hm WHERE hm.hostname = h.hostname AND (hm.decommissioned_at IS NOT NULL OR hm.monitoring_paused_at IS NOT NULL))
                     ORDER BY h.hostname`;

const LIST_MSSQL = `SELECT h.hostname, h.agent_id, h.agent_type, h.agent_version,
                            h.last_heartbeat_at, h.last_report_at, h.last_report_status,
                            h.pending_queue_size, h.heartbeat_interval_seconds,
                            h.report_requested_at,
                            m.site_id, s.site_name, s.region_code,
                            m.ip_address, m.os_version
                     FROM ad_member_heartbeat h
                     LEFT JOIN ad_member_servers m ON m.hostname = h.hostname
                     LEFT JOIN ad_sites s ON s.site_id = m.site_id
                     -- R158.X.115 (2026-10-20) — 排除退役/暂停管控的主机。
                     --   与上面 LEFT JOIN 不冲突: 主键是 h.hostname (心跳行),
                     --   退役机器的心跳行本就不该出现在"当前 agent"列表。
                     WHERE NOT EXISTS (SELECT 1 FROM ad_member_servers hm WHERE hm.hostname = h.hostname AND (hm.decommissioned_at IS NOT NULL OR hm.monitoring_paused_at IS NOT NULL))
                     ORDER BY h.hostname`;

// ============================================================
// deleteMemberRow — 单 DELETE (member-server 没 cascade)
//   跟 heartbeat.deleteHeartbeatRow 平行 (单行, 没 cross-table cascade).
//   R158.79: 必须 arrow function (跟 deleteDcRow / deleteHeartbeatRow 同
//   precedent), service code 调 deleteMemberRow(hostname) 拿 string, 不是
//   raw string (否则 service 报 "sql is not a function" — 写 ship 时踩了
//   这个坑, 修了).
// ============================================================
const DELETE_MYSQL_FN = () => `DELETE FROM ad_member_heartbeat WHERE hostname = ?`;
const DELETE_MSSQL_FN = () => `DELETE FROM ad_member_heartbeat WHERE hostname = CAST(? AS VARCHAR(128))`;

export const memberHeartbeat = {
  mysql: {
    upsert: UPSERT_MYSQL,
    membersList: LIST_MYSQL,
    deleteMemberRow: DELETE_MYSQL_FN
  },
  mssql: {
    upsert: UPSERT_MSSQL,
    membersList: LIST_MSSQL,
    deleteMemberRow: DELETE_MSSQL_FN
  }
};
