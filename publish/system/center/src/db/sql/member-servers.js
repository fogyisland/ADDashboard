// SQL helpers for the ad_member_servers table (migration 014).
// Pattern matches center/src/db/sql.js's `sites` / `dcs` domain:
// dual-dialect SQL strings mounted into the registry so service code can
// read db.sql.memberServers.<query> and get back a plain string for the
// active dialect.
//
// Table: ad_member_servers (PK = hostname)
//
// Columns:
//   hostname        VARCHAR(128) NOT NULL  (PK)
//   site_id         INT          NULL
//   ip_address      VARCHAR(64)  NULL
//   os_version      VARCHAR(64)  NULL
//   agent_type      VARCHAR(16)  NOT NULL DEFAULT 'non-ad'
//   enabled         TINYINT(1)   NOT NULL DEFAULT 1
//   last_seen_at    DATETIME     NULL
//   last_report_at  DATETIME     NULL
//   discovered_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
//   discovered_via  VARCHAR(32)  NOT NULL DEFAULT 'self-register'
//   created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
//   updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP

const UPSERT_MYSQL = `INSERT INTO ad_member_servers
  (hostname, site_id, ip_address, os_version, agent_type, enabled, discovered_via)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    site_id = VALUES(site_id),
    ip_address = VALUES(ip_address),
    os_version = VALUES(os_version),
    updated_at = NOW()`;

const UPSERT_MSSQL = `MERGE INTO ad_member_servers AS t
  USING (SELECT
    ? AS hostname, ? AS site_id, ? AS ip_address,
    ? AS os_version, ? AS agent_type, ? AS enabled, ? AS discovered_via
  ) AS s
  ON t.hostname = s.hostname
  WHEN MATCHED THEN UPDATE SET
    site_id = s.site_id,
    ip_address = s.ip_address,
    os_version = s.os_version,
    updated_at = SYSUTCDATETIME()
  WHEN NOT MATCHED THEN INSERT
    (hostname, site_id, ip_address, os_version, agent_type, enabled, discovered_via)
    VALUES
    (s.hostname, s.site_id, s.ip_address, s.os_version, s.agent_type, s.enabled, s.discovered_via);`;

const FIND_BY_HOSTNAME_MYSQL = `SELECT * FROM ad_member_servers WHERE hostname = ?`;
const FIND_BY_HOSTNAME_MSSQL = `SELECT * FROM ad_member_servers WHERE hostname = ?`;

const LIST_MYSQL = `SELECT ms.*, s.site_name
  FROM ad_member_servers ms
  LEFT JOIN ad_sites s ON ms.site_id = s.site_id
  ORDER BY ms.hostname`;

const LIST_MSSQL = `SELECT ms.*, s.site_name
  FROM ad_member_servers ms
  LEFT JOIN ad_sites s ON ms.site_id = s.site_id
  ORDER BY ms.hostname`;

const DELETE_MYSQL = `DELETE FROM ad_member_servers WHERE hostname = ?`;
const DELETE_MSSQL = `DELETE FROM ad_member_servers WHERE hostname = ?`;

const TOUCH_LAST_SEEN_MYSQL = `UPDATE ad_member_servers SET last_seen_at = NOW() WHERE hostname = ?`;
const TOUCH_LAST_SEEN_MSSQL = `UPDATE ad_member_servers SET last_seen_at = SYSUTCDATETIME() WHERE hostname = ?`;

const TOUCH_LAST_REPORT_MYSQL = `UPDATE ad_member_servers SET last_report_at = NOW() WHERE hostname = ?`;
const TOUCH_LAST_REPORT_MSSQL = `UPDATE ad_member_servers SET last_report_at = SYSUTCDATETIME() WHERE hostname = ?`;

export const memberServers = {
  mysql: {
    upsert: UPSERT_MYSQL,
    findByHostname: FIND_BY_HOSTNAME_MYSQL,
    list: LIST_MYSQL,
    delete: DELETE_MYSQL,
    touchLastSeen: TOUCH_LAST_SEEN_MYSQL,
    touchLastReport: TOUCH_LAST_REPORT_MYSQL
  },
  mssql: {
    upsert: UPSERT_MSSQL,
    findByHostname: FIND_BY_HOSTNAME_MSSQL,
    list: LIST_MSSQL,
    delete: DELETE_MSSQL,
    touchLastSeen: TOUCH_LAST_SEEN_MSSQL,
    touchLastReport: TOUCH_LAST_REPORT_MSSQL
  }
};
