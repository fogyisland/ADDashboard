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
//   install_root    VARCHAR(512) NULL       (R158.94 — agent self-register 上报 __dirname)
//   created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
//   updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
//
// R158.X.115 (2026-10-20) — 生命周期状态列 (退役/暂停管控):
//   decommissioned_at    DATETIME2 NULL  非空 = 已退役 (终态不可逆)
//   monitoring_paused_at DATETIME2 NULL  非空 = 暂停管控 (临时态, 手动恢复)
// 两列都是**纯 admin 决策列**, agent 完全不知道 —— 不进 UPSERT 的 INSERT 列表
// 也不进 UPDATE SET (跟 enabled / agent_type / discovered_via 同级保护),
// 所以 agent self-register 永远无法复活一台退役的机器。过滤谓词的单一真源
// 在 db/sql/host-status.js。
import { ONLINE_MEMBER_WHERE } from './host-status.js';

// R158.86.5.2 (2026-10-12) — site_id COALESCE preserve. agent self-register
// 30min cadence (noadagent/agent.js:340 + :525-529) + on every boot. Before
// fix: UPSERT always overwrote site_id = s.site_id (= null from agent),
// wiping any site_id admin set via MemberServersView. Same precedent as
// routes/agent.js:351 (report_requested_at undefined → COALESCE preserve
// the column). self-register path is pure zero-state from agent; admin
// owns site_id assignment, agent never sends a real value.
//
// Design invariant (operator directive 2026-10-12): "注册时不进行站点推送,
// 全部交给服务器端安排". site_id is **server-controlled only**:
//   · agent self-register / heartbeat paths — never know site_id, pass null
//   · admin MemberServersView / SitesCatalogView — only place that sets
//     a real value
//   · SQL helper enforces this via COALESCE so even if a future caller
//     accidentally passes a non-admin value, the existing admin-assigned
//     site_id wins (admin is authoritative).
// 加 ENABLED/agent_type/discovered_via 也跟 COALESCE/常量保护 — agent
// 路径不能改 admin 设的 enabled (1=管理员启用 / 0=管理员停用), 不能改
// agent_type (member fleet 永远 non-ad), 不能改 discovered_via (self-register
// 路径专属). 这条 invariant 防止"agent 反向覆盖 admin 决策".
// R158.94 (2026-10-13) — install_root 也加 COALESCE 保护 (跟 R158.86.5.2
//   site_id precedent 1:1): agent self-register 永远 null (它 0 admin UI),
//   admin 改的 (MemberServersView 改) 永远 win. 不在 agent 端反向覆盖.
const UPSERT_MYSQL = `INSERT INTO ad_member_servers
  (hostname, site_id, ip_address, os_version, agent_type, enabled, discovered_via, install_root)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    site_id = COALESCE(VALUES(site_id), site_id),
    ip_address = VALUES(ip_address),
    os_version = VALUES(os_version),
    install_root = COALESCE(VALUES(install_root), install_root),
    updated_at = UTC_TIMESTAMP()`;

const UPSERT_MSSQL = `MERGE INTO ad_member_servers AS t
  USING (SELECT
    CAST(? AS VARCHAR(128)) AS hostname, ? AS site_id, CAST(? AS VARCHAR(64)) AS ip_address,
    CAST(? AS VARCHAR(64)) AS os_version, CAST(? AS VARCHAR(16)) AS agent_type, ? AS enabled, CAST(? AS VARCHAR(32)) AS discovered_via,
    CAST(? AS VARCHAR(512)) AS install_root
  ) AS s
  ON t.hostname = s.hostname
  WHEN MATCHED THEN UPDATE SET
    site_id = COALESCE(s.site_id, t.site_id),
    ip_address = s.ip_address,
    os_version = s.os_version,
    install_root = COALESCE(s.install_root, t.install_root),
    updated_at = SYSUTCDATETIME()
  WHEN NOT MATCHED THEN INSERT
    (hostname, site_id, ip_address, os_version, agent_type, enabled, discovered_via, install_root)
    VALUES
    (s.hostname, s.site_id, s.ip_address, s.os_version, s.agent_type, s.enabled, s.discovered_via, s.install_root);`;

const FIND_BY_HOSTNAME_MYSQL = `SELECT ms.*, s.site_name
  FROM ad_member_servers ms
  LEFT JOIN ad_sites s ON ms.site_id = s.site_id
  WHERE ms.hostname = ?`;
const FIND_BY_HOSTNAME_MSSQL = `SELECT ms.*, s.site_name
  FROM ad_member_servers ms
  LEFT JOIN ad_sites s ON ms.site_id = s.site_id
  WHERE ms.hostname = CAST(? AS VARCHAR(128))`;

// R158.X.115 (2026-10-20) — list 拆成两个 spec, 按"要不要看到退役/暂停"分流。
//
// 为什么不能直接给 LIST 加 WHERE: 消费者需求相反。
//   · 在线视图 (member-overview KPI / member-os-baseline 的 memberSet /
//     告警判定) 必须排除退役+暂停 —— 退役的机器不该再占 KPI、不该再出现在
//     os-baseline 图表里。
//   · 管理列表 (MemberServersView 的表格) 必须**保留**退役/暂停行 —— 操作员
//     退役后就靠这个页面确认"这台确实下线了、什么时候下的、谁下的"。把它
//     过滤掉就等于操作员失明了。
//
// 所以保留 list (全量, 管理用), 新增 listOnline (仅在线, 在线视图用)。
// listOnline 走 ONLINE_MEMBER_WHERE 单一真源 (db/sql/host-status.js),
// 跟告警 detector 的过滤口径 100% 一致 —— 这是防"告警里没有但 KPI 里有"
// 这类漏网的唯一办法。
const buildList = ({ onlineOnly = false } = {}) => {
  const filter = onlineOnly ? `WHERE ${ONLINE_MEMBER_WHERE}` : '';
  return `SELECT ms.*, s.site_name
  FROM ad_member_servers ms
  LEFT JOIN ad_sites s ON ms.site_id = s.site_id
  ${filter}
  ORDER BY ms.hostname`;
};

// 全量 (管理列表用) —— 保持跟 R158.X.115 之前逐字一致的 SQL, 0 行为变更。
const LIST_MYSQL = buildList();
const LIST_MSSQL = buildList();
// 仅在线 (KPI / 图表 / 告警判定用)
const LIST_ONLINE_MYSQL = buildList({ onlineOnly: true });
const LIST_ONLINE_MSSQL = buildList({ onlineOnly: true });

const DELETE_MYSQL = `DELETE FROM ad_member_servers WHERE hostname = ?`;
const DELETE_MSSQL = `DELETE FROM ad_member_servers WHERE hostname = CAST(? AS VARCHAR(128))`;

const TOUCH_LAST_SEEN_MYSQL = `UPDATE ad_member_servers SET last_seen_at = UTC_TIMESTAMP() WHERE hostname = ?`;
const TOUCH_LAST_SEEN_MSSQL = `UPDATE ad_member_servers SET last_seen_at = SYSUTCDATETIME() WHERE hostname = CAST(? AS VARCHAR(128))`;

const TOUCH_LAST_REPORT_MYSQL = `UPDATE ad_member_servers SET last_report_at = UTC_TIMESTAMP() WHERE hostname = ?`;
const TOUCH_LAST_REPORT_MSSQL = `UPDATE ad_member_servers SET last_report_at = SYSUTCDATETIME() WHERE hostname = CAST(? AS VARCHAR(128))`;

export const memberServers = {
  mysql: {
    upsert: UPSERT_MYSQL,
    findByHostname: FIND_BY_HOSTNAME_MYSQL,
    list: LIST_MYSQL,
    // R158.X.115 — 仅在线 (排除退役+暂停)。在线视图专用, 见上方 buildList 注释。
    listOnline: LIST_ONLINE_MYSQL,
    delete: DELETE_MYSQL,
    touchLastSeen: TOUCH_LAST_SEEN_MYSQL,
    touchLastReport: TOUCH_LAST_REPORT_MYSQL
  },
  mssql: {
    upsert: UPSERT_MSSQL,
    findByHostname: FIND_BY_HOSTNAME_MSSQL,
    list: LIST_MSSQL,
    listOnline: LIST_ONLINE_MSSQL,
    delete: DELETE_MSSQL,
    touchLastSeen: TOUCH_LAST_SEEN_MSSQL,
    touchLastReport: TOUCH_LAST_REPORT_MSSQL
  }
};
