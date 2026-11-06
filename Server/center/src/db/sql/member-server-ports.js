// SQL helpers for the ad_member_server_ports table (R158.74, 2026-10-11).
// Per-row PK (hostname, port) — one row per business-port per host.
// FK→ad_member_servers.hostname ON DELETE CASCADE.
// Pattern matches center/src/db/sql/member-servers.js (R158.45/R158.63).
//
// R158.89 (2026-10-13) — 加 probe 3 列 (probe_status / probe_latency_ms /
//   probe_at) 跟 R158.89 startMemberPortProbeScheduler 1:1 闭合. R158.74
//   建表只 enumerate admin CRUD, R158.84 "按需 probe" 只 enumerate 接口
//   层, 0 enumerate scheduler 周期 probe + 写表. R158.86.6 enumerate 5 维度
//   lesson #6 重现. SQL helper 加 listAll/listByHostname 3 列 + 新
//   updateProbe (mssql / mysql 平行).

const UPSERT_MYSQL = `INSERT INTO ad_member_server_ports
  (hostname, port, service_type, note)
  VALUES (?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    service_type = VALUES(service_type),
    note = VALUES(note),
    updated_at = UTC_TIMESTAMP()`;

const UPSERT_MSSQL = `MERGE INTO ad_member_server_ports AS t
  USING (SELECT
    CAST(? AS VARCHAR(128)) AS hostname,
    CAST(? AS INT)           AS port,
    CAST(? AS VARCHAR(32))   AS service_type,
    CAST(? AS NVARCHAR(255)) AS note
  ) AS s
  ON t.hostname = s.hostname AND t.port = s.port
  WHEN MATCHED THEN UPDATE SET
    service_type = s.service_type,
    note         = s.note,
    updated_at   = SYSUTCDATETIME()
  WHEN NOT MATCHED THEN INSERT
    (hostname, port, service_type, note)
  VALUES
    (s.hostname, s.port, s.service_type, s.note);`;

// R158.89 — listAll / listByHostname 加 probe 3 列
const LIST_ALL_MYSQL = `SELECT hostname, port, service_type, note, updated_at,
  probe_status, probe_latency_ms, probe_at
  FROM ad_member_server_ports
  ORDER BY hostname, port`;
const LIST_ALL_MSSQL = `SELECT hostname, port, service_type, note, updated_at,
  probe_status, probe_latency_ms, probe_at
  FROM ad_member_server_ports
  ORDER BY hostname, port`;

const LIST_BY_HOSTNAME_MYSQL = `SELECT hostname, port, service_type, note, updated_at,
  probe_status, probe_latency_ms, probe_at
  FROM ad_member_server_ports
  WHERE hostname = ? ORDER BY port`;
const LIST_BY_HOSTNAME_MSSQL = `SELECT hostname, port, service_type, note, updated_at,
  probe_status, probe_latency_ms, probe_at
  FROM ad_member_server_ports
  WHERE hostname = CAST(? AS VARCHAR(128)) ORDER BY port`;

// R158.89 — updateProbe. 5 维 enum lesson: 只写自己探测态, 不动 admin
//   CRUD updated_at (跟 R158.74 admin upsert 同步, 跟 probe scheduler
//   解耦, 前端 /memberServer/ports 跟 GET /api/dashboard/member-ports
//   都能区分 admin update vs probe tick). NULL/COALESCE preserved
//   (跟 R158.48 last_upgrade_event 11th col 1:1 平行).
const UPDATE_PROBE_MYSQL = `UPDATE ad_member_server_ports
  SET probe_status      = ?,
      probe_latency_ms  = ?,
      probe_at          = UTC_TIMESTAMP(3)
  WHERE hostname = ? AND port = ?`;
const UPDATE_PROBE_MSSQL = `UPDATE ad_member_server_ports
  SET probe_status      = ?,
      probe_latency_ms  = ?,
      probe_at          = SYSUTCDATETIME()
  WHERE hostname = CAST(? AS VARCHAR(128)) AND port = CAST(? AS INT)`;

const DELETE_BY_PK_MYSQL = `DELETE FROM ad_member_server_ports
  WHERE hostname = ? AND port = ?`;
const DELETE_BY_PK_MSSQL = `DELETE FROM ad_member_server_ports
  WHERE hostname = CAST(? AS VARCHAR(128)) AND port = CAST(? AS INT)`;

const DELETE_BY_HOSTNAME_MYSQL = `DELETE FROM ad_member_server_ports WHERE hostname = ?`;
const DELETE_BY_HOSTNAME_MSSQL = `DELETE FROM ad_member_server_ports WHERE hostname = CAST(? AS VARCHAR(128))`;

export const memberServerPorts = {
  mysql: {
    upsert: UPSERT_MYSQL,
    listAll: LIST_ALL_MYSQL,
    listByHostname: LIST_BY_HOSTNAME_MYSQL,
    updateProbe: UPDATE_PROBE_MYSQL,
    deleteByPk: DELETE_BY_PK_MYSQL,
    deleteByHostname: DELETE_BY_HOSTNAME_MYSQL
  },
  mssql: {
    upsert: UPSERT_MSSQL,
    listAll: LIST_ALL_MSSQL,
    listByHostname: LIST_BY_HOSTNAME_MSSQL,
    updateProbe: UPDATE_PROBE_MSSQL,
    deleteByPk: DELETE_BY_PK_MSSQL,
    deleteByHostname: DELETE_BY_HOSTNAME_MSSQL
  }
};
