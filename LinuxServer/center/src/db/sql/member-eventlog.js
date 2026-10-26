// SQL helpers for the ad_member_eventlog_* tables (R158.78, 2026-10-12).
// Member-server 事件日志专表 — 跟 DC 端 ad_eventlog_* (R112) 平行但独立:
//   · 字段用 hostname 不用 dc_name (跟 ad_member_servers.hostname 对齐)
//   · PK (hostname, channel, record_id) 跟 DC 端同 shape, FK→ad_member_servers
//   · 3 通道 (Application / System / Security), 跟 DC 端 5 通道不混
//   · latestSummary LEFT JOIN ad_member_servers + ad_sites (member-server 走
//     site_id → ad_sites, 跟 R158.77 兄弟 endpoint 同 precedent)
// Pattern matches center/src/db/sql/member-server-ports.js (R158.74) and
// center/src/db/sql/member-servers.js (R158.45/R158.63).

const UPSERT_EVENT_MYSQL = `INSERT INTO ad_member_eventlog_events
  (collected_at, agent_id, hostname, channel, severity, event_id, record_id, message, ts, audit_failure)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    collected_at  = VALUES(collected_at),
    audit_failure = VALUES(audit_failure)`;

const UPSERT_EVENT_MSSQL = `MERGE INTO ad_member_eventlog_events AS t
  USING (SELECT
    CAST(? AS DATETIME2)     AS collected_at,
    CAST(? AS VARCHAR(64))   AS agent_id,
    CAST(? AS VARCHAR(128))  AS hostname,
    CAST(? AS VARCHAR(32))   AS channel,
    CAST(? AS VARCHAR(16))   AS severity,
    CAST(? AS INT)           AS event_id,
    CAST(? AS BIGINT)        AS record_id,
    CAST(? AS NVARCHAR(MAX)) AS message,
    CAST(? AS DATETIME2)     AS ts,
    CAST(? AS BIT)           AS audit_failure
  ) AS s
  ON t.hostname = s.hostname AND t.channel = s.channel AND t.record_id = s.record_id
  WHEN MATCHED THEN UPDATE SET
    collected_at  = s.collected_at,
    audit_failure = s.audit_failure
  WHEN NOT MATCHED THEN INSERT
    (collected_at, agent_id, hostname, channel, severity, event_id, record_id, message, ts, audit_failure)
  VALUES
    (s.collected_at, s.agent_id, s.hostname, s.channel, s.severity,
     s.event_id, s.record_id, s.message, s.ts, s.audit_failure);`;

const UPSERT_SUMMARY_MYSQL = `INSERT INTO ad_member_eventlog_summary
  (collected_at, agent_id, hostname, channel, warning_count, error_count, audit_failure_count, dropped_count)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    warning_count       = VALUES(warning_count),
    error_count         = VALUES(error_count),
    audit_failure_count = VALUES(audit_failure_count),
    dropped_count       = VALUES(dropped_count)`;

const UPSERT_SUMMARY_MSSQL = `MERGE INTO ad_member_eventlog_summary AS t
  USING (SELECT
    CAST(? AS DATETIME2)    AS collected_at,
    CAST(? AS VARCHAR(64))  AS agent_id,
    CAST(? AS VARCHAR(128)) AS hostname,
    CAST(? AS VARCHAR(32))  AS channel,
    CAST(? AS INT)          AS warning_count,
    CAST(? AS INT)          AS error_count,
    CAST(? AS INT)          AS audit_failure_count,
    CAST(? AS INT)          AS dropped_count
  ) AS s
  ON t.hostname = s.hostname AND t.channel = s.channel AND t.collected_at = s.collected_at
  WHEN MATCHED THEN UPDATE SET
    warning_count       = s.warning_count,
    error_count         = s.error_count,
    audit_failure_count = s.audit_failure_count,
    dropped_count       = s.dropped_count
  WHEN NOT MATCHED THEN INSERT
    (collected_at, agent_id, hostname, channel, warning_count, error_count, audit_failure_count, dropped_count)
  VALUES
    (s.collected_at, s.agent_id, s.hostname, s.channel, s.warning_count, s.error_count, s.audit_failure_count, s.dropped_count);`;

// R158.78 — latest summary per (hostname, channel) within retention window.
// 跟 R112 端 latestSummary 同 shape, 但字段 dc_name → hostname, LEFT JOIN
// 走 ad_member_servers + ad_sites (member-server 走 site_id → ad_sites,
// 跟 R158.77 兄弟 endpoint 同 precedent). 跟 R140 dashboard.agents 同 pattern.
const LATEST_SUMMARY_MYSQL = `SELECT s.hostname, s.channel, s.warning_count, s.error_count,
       s.audit_failure_count,
       COALESCE(s.dropped_count, 0) AS dropped_count,
       s.collected_at,
       ms.site_id, ds.site_name
  FROM ad_member_eventlog_summary s
  INNER JOIN (
    SELECT hostname, channel, MAX(collected_at) AS max_collected
    FROM ad_member_eventlog_summary
    WHERE collected_at >= (NOW() - INTERVAL ? HOUR)
    GROUP BY hostname, channel
  ) m
    ON m.hostname = s.hostname
   AND m.channel  = s.channel
   AND m.max_collected = s.collected_at
  LEFT JOIN ad_member_servers ms ON ms.hostname = s.hostname
  LEFT JOIN ad_sites ds ON ds.site_id = ms.site_id
  ORDER BY s.hostname, s.channel`;

const LATEST_SUMMARY_MSSQL = `SELECT s.hostname, s.channel, s.warning_count, s.error_count,
       s.audit_failure_count,
       COALESCE(s.dropped_count, 0) AS dropped_count,
       s.collected_at,
       ms.site_id, ds.site_name
  FROM ad_member_eventlog_summary s
  INNER JOIN (
    SELECT hostname, channel, MAX(collected_at) AS max_collected
    FROM ad_member_eventlog_summary
    WHERE collected_at >= (DATEADD(HOUR, -?, SYSUTCDATETIME()))
    GROUP BY hostname, channel
  ) m
    ON m.hostname = s.hostname
   AND m.channel  = s.channel
   AND m.max_collected = s.collected_at
  LEFT JOIN ad_member_servers ms ON ms.hostname = s.hostname
  LEFT JOIN ad_sites ds ON ds.site_id = ms.site_id
  ORDER BY s.hostname, s.channel`;
// R158.scanfix-H1 (2026-10-20) — MSSQL 分支重写, 对齐上面的 MySQL 分支.
//
// 改写前本分支用的是:
//     WHERE s.collected_at >= DATEADD(...)
//       AND s.collected_at = (SELECT TOP 1 s2.collected_at ... ORDER BY DESC)
//
// 那是"latest-per-(hostname, channel)"的相关子查询形态 —— 对外层**每一行**
// 都要再跑一次子查询. MySQL 分支早已改成 INNER JOIN + MAX(...) GROUP BY
// 派生表(一次顺序扫描), MSSQL 分支却没跟上, 是典型的"加方言时漏改一半".
//
// 为什么现在还不痛: member 端 eventlog 数据量小, 实测端点 10ms. 但这是
// 明确的结构性缺陷 —— 数据量涨起来(或保留期从 1h 放大到 10d)会突然爆炸.
// 同类问题在 dashboard.js:378 (ad_eventlog_summary) 也存在, 那处两个
// 方言都还是相关子查询, 属于另一种情况(原始设计, 非漏改).
//
// 新形态与 MySQL 分支 1:1 平行, 仅时间函数不同 (DATEADD vs NOW/INTERVAL).
// 语义完全等价: 每 (hostname, channel) 取窗口内 MAX(collected_at) 那一行.
// 绑定参数同步从 2 个降为 1 个 (旧版两个 ?, 分别用于外层和子查询; 新版
// 派生表只需 1 个) —— 调用方 queryLatestSummary 已按 1 参数传, 见下.

// R158.78 — drill-down events for one (hostname, channel[, severity]).
// 跟 R112 端 queryEvents 同 shape, 但字段 dc_name → hostname.
function queryEvents({ hostname, channel, severity = null, sinceHours = 1, limit = 200, auditOnly = false } = {}) {
  const params = [hostname, channel, sinceHours];
  let sevClause = '';
  if (severity) {
    sevClause = 'AND severity = ?';
    params.push(severity);
  }
  if (auditOnly) {
    sevClause += ' AND audit_failure = 1';
  }
  params.push(limit);
  return {
    sql: `SELECT collected_at, hostname, channel, severity,
                 event_id, record_id, message, ts, audit_failure
            FROM ad_member_eventlog_events
           WHERE hostname     = ?
             AND channel     = ?
             AND collected_at >= (NOW() - INTERVAL ? HOUR)
             ${sevClause}
           ORDER BY ts DESC
           LIMIT ?`,
    params
  };
}

function queryEventsMssql({ hostname, channel, severity = null, sinceHours = 1, limit = 200, auditOnly = false } = {}) {
  const params = [hostname, channel, sinceHours];
  let sevClause = '';
  if (severity) {
    sevClause = 'AND severity = CAST(? AS VARCHAR(16))';
    params.push(severity);
  }
  if (auditOnly) {
    sevClause += ' AND audit_failure = CAST(1 AS BIT)';
  }
  // R158.17.5 — MSSQL 不接受参数化 TOP. router 已经用 clampInt 夹紧.
  const safeLimit = Math.max(1, Math.min(200000, Number.parseInt(limit, 10) || 200));
  return {
    sql: `SELECT TOP ${safeLimit} collected_at, hostname, channel, severity,
                 event_id, record_id, message, ts, audit_failure
            FROM ad_member_eventlog_events
           WHERE hostname     = CAST(? AS VARCHAR(128))
             AND channel     = CAST(? AS VARCHAR(32))
             AND collected_at >= (DATEADD(HOUR, -?, SYSUTCDATETIME()))
             ${sevClause}
           ORDER BY ts DESC`,
    params
  };
}

const PURGE_OLDER_THAN_MYSQL_EVENTS  = 'DELETE FROM ad_member_eventlog_events  WHERE collected_at < ?';
const PURGE_OLDER_THAN_MYSQL_SUMMARY = 'DELETE FROM ad_member_eventlog_summary WHERE collected_at < ?';
const PURGE_OLDER_THAN_MSSQL_EVENTS  = 'DELETE FROM ad_member_eventlog_events  WHERE collected_at < CAST(? AS DATETIME2)';
const PURGE_OLDER_THAN_MSSQL_SUMMARY = 'DELETE FROM ad_member_eventlog_summary WHERE collected_at < CAST(? AS DATETIME2)';

function purgeOlderThan({ cutoffIso }) {
  return {
    sqlEvents:  { sql: PURGE_OLDER_THAN_MYSQL_EVENTS,  params: [cutoffIso] },
    sqlSummary: { sql: PURGE_OLDER_THAN_MYSQL_SUMMARY, params: [cutoffIso] }
  };
}

function purgeOlderThanMssql({ cutoffIso }) {
  return {
    sqlEvents:  { sql: PURGE_OLDER_THAN_MSSQL_EVENTS,  params: [cutoffIso] },
    sqlSummary: { sql: PURGE_OLDER_THAN_MSSQL_SUMMARY, params: [cutoffIso] }
  };
}

export const memberEventlog = {
  mysql: {
    upsertEvent:     ({ collectedAt, agentId, hostname, channel, severity, eventId, recordId, message, ts, auditFailure = 0 }) => ({
      sql:    UPSERT_EVENT_MYSQL,
      params: [collectedAt, agentId, hostname, channel, severity, eventId, recordId, message, ts, auditFailure]
    }),
    upsertSummary:   ({ collectedAt, agentId, hostname, channel, warningCount, errorCount, auditFailureCount = 0, droppedCount = 0 }) => ({
      sql:    UPSERT_SUMMARY_MYSQL,
      params: [collectedAt, agentId, hostname, channel, warningCount, errorCount, auditFailureCount, droppedCount]
    }),
    latestSummary:   ({ sinceHours = 1 } = {}) => ({
      sql:    LATEST_SUMMARY_MYSQL,
      params: [sinceHours]
    }),
    // R158.101 (2026-10-13) — 24h hourly event log trend for the
    //   /memberServer/eventlog line chart. 3 channel (System/Application/
    //   Security) × 24 hour bucket × COUNT(*). Channel is fixed by R158.78
    //   member spec (no topN / hostname override — chart renders all 3
    //   channels in a stable palette). Mirrors eventlog.trend24h MySQL
    //   pattern (sql.js:1968-1981) but 走 ad_member_eventlog_events
    //   (member spec) 0 走 ad_eventlog_events.
    trend24h: ({ hours = 24 } = {}) => {
      if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
        throw new Error(`memberEventlog.trend24h: hours must be int in [1,168], got ${hours}`);
      }
      return {
        sql: `SELECT channel,
                DATE_FORMAT(collected_at, '%Y-%m-%d %H:00:00') AS bucket_start,
                COUNT(*) AS event_count
             FROM ad_member_eventlog_events
            WHERE collected_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
            GROUP BY channel, bucket_start
            ORDER BY channel ASC, bucket_start ASC`,
        params: [hours]
      };
    },
    queryEvents,
    purgeOlderThan
  },
  mssql: {
    upsertEvent:     ({ collectedAt, agentId, hostname, channel, severity, eventId, recordId, message, ts, auditFailure = 0 }) => ({
      sql:    UPSERT_EVENT_MSSQL,
      params: [collectedAt, agentId, hostname, channel, severity, eventId, recordId, message, ts, auditFailure]
    }),
    upsertSummary:   ({ collectedAt, agentId, hostname, channel, warningCount, errorCount, auditFailureCount = 0, droppedCount = 0 }) => ({
      sql:    UPSERT_SUMMARY_MSSQL,
      params: [collectedAt, agentId, hostname, channel, warningCount, errorCount, auditFailureCount, droppedCount]
    }),
    latestSummary:   ({ sinceHours = 1 } = {}) => ({
      sql:    LATEST_SUMMARY_MSSQL,
      // R158.scanfix-H1 — 绑定参数从 2 个降为 1 个: 旧 SQL 的两个 ?
      // (外层 collected_at >= + 子查询内 collected_at >=) 都在
      // LATEST_SUMMARY_MSSQL 内, 现在窗口过滤收进派生表只需 1 个 ?.
      // 少绑一个不会报错(mssql driver 多余参数通常被忽略), 但保持 1:1
      // 让"参数个数 == 占位符个数"这个不变量成立, 避免以后误读.
      params: [sinceHours]
    }),
    // R158.101 (2026-10-13) — MSSQL mirror of memberEventlog.trend24h.
    //   SYSUTCDATETIME() not GETUTCDATE() (R101 UTC precision precedent).
    //   DATEADD(HOUR, DATEDIFF(HOUR, 0, collected_at), 0) floors to hour
    //   bucket — same idiom as eventlog.trend24h MSSQL (sql.js:4582-4595).
    trend24h: ({ hours = 24 } = {}) => {
      if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
        throw new Error(`memberEventlog.trend24h: hours must be int in [1,168], got ${hours}`);
      }
      return {
        sql: `SELECT channel,
                DATEADD(HOUR, DATEDIFF(HOUR, 0, collected_at), 0) AS bucket_start,
                COUNT(*) AS event_count
             FROM ad_member_eventlog_events
            WHERE collected_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())
            GROUP BY channel, DATEADD(HOUR, DATEDIFF(HOUR, 0, collected_at), 0)
            ORDER BY channel ASC, bucket_start ASC`,
        params: [hours]
      };
    },
    queryEvents:     queryEventsMssql,
    purgeOlderThan:  purgeOlderThanMssql
  }
};
