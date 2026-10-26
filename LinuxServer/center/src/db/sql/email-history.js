// SQL helpers for the email-history endpoint (R158.69).
//
// 内置告警 + 日报/周报 两类 outbox 表 UNION ALL, 默认只返 sent_at IS NOT NULL.
// 不建新表 (operator "不建新表" 决策), 客户端查询 = 服务端合并.
//
// 涉及表 (物理独立, R158.68 ship):
//   - system_alert_outbox  (R158.68): 内置告警邮件 outbox. 列 alert_id / to_addrs /
//     cc_addrs / subject / body_text / body_html / attempt_count / max_attempts /
//     last_error / sent_at / next_attempt_at.
//   - report_email_outbox  (R158.68): 报表邮件 outbox. 列 report_id / to_addrs /
//     cc_addrs / subject / body_text / body_html / attempt_count / max_attempts /
//     last_error / sent_at / next_attempt_at / kind ('daily'|'weekly').
//
// UNPIVOT 替代: alert.kind_detail 永远 NULL (UI 显示 "告警"); report.kind_detail
// = report_email_outbox.kind 列 ('daily' / 'weekly'). UNION ALL 内部各 SELECT
// 列必须对齐, alert 侧填 CAST(NULL AS nvarchar(16)).

export const emailHistory = {
  mysql: {
    // UNION ALL 跨 2 表. 3 占位: days / days / limit (最后 LIMIT 走参).
    // - sent_at IS NOT NULL: 排除仍在排队 (邮件没发出去, queue 中).
    // - sent_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY): 时间窗.
    // - ORDER BY sent_at DESC, id DESC: 跨 union 排序, 限制 limit.
    //
    // ★ R161.12 (2026-10-27) — kind_detail 的 COLLATE 是**必需**的, 不是洁癖:
    //   现场这两个端点 500, 报 "Illegal mix of collations for operation 'UNION'"
    //   (MySQL 1271 ER_CANT_AGGREGATE_NCOLLATIONS)。
    //   真因: UNION 的结果列 collation 由各分支聚合 ——
    //     分支 1 的 `CAST(NULL AS CHAR)` 跟随**连接** collation,
    //     分支 2 的 `report_email_outbox.kind` 是**列** collation (utf8mb4_unicode_ci),
    //     两个隐式 collation 不同 ⇒ 无法聚合 ⇒ 1271。
    //   写死 `CONVERT(NULL USING utf8mb4) COLLATE utf8mb4_unicode_ci` 后,
    //   本查询**不再依赖连接 collation** (EXPLICIT collation 优先级高于隐式),
    //   连接被谁改成 general_ci / latin1 都不会再炸这一条。
    //   (根因那一端 —— 连接 charset 与 schema 对齐 —— 在
    //    src/db/drivers/mysql.js 的 charset: 'utf8mb4_unicode_ci'。)
    listSent: (days, limit) => `
      SELECT * FROM (
        SELECT 'alert' AS source, alert_id AS ref_id,
               CONVERT(NULL USING utf8mb4) COLLATE utf8mb4_unicode_ci AS kind_detail,
               to_addrs, cc_addrs, subject, attempt_count, max_attempts,
               last_error, sent_at, next_attempt_at, id
        FROM system_alert_outbox
        WHERE sent_at IS NOT NULL
          AND sent_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY)
        UNION ALL
        SELECT 'report' AS source, report_id AS ref_id, kind AS kind_detail,
               to_addrs, cc_addrs, subject, attempt_count, max_attempts,
               last_error, sent_at, next_attempt_at, id
        FROM report_email_outbox
        WHERE sent_at IS NOT NULL
          AND sent_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY)
      ) u
      ORDER BY sent_at DESC, id DESC
      LIMIT ?`,

    // R158.100.A (2026-10-14) — 单行详情 helper. 2 helper × 2 dialect.
    //   按表拆 (1 helper 1 表), 单行查 1 张表最直接, 不走 UNION.
    //   [id] 单参.
    //   - alert 表**没有** created_at 列 (R158.69 listSent 没返, schema verify 确认).
    //     详情里就跳这字段, 前端 fallback 到 '关联 ID + sent_at' 时间链.
    //   - report 表**有** created_at (datatype2 NO), 详情返.
    //   - body_text / body_html 完整返 (单行查, 性能可接受).
    detailAlertById: `SELECT id, alert_id AS ref_id, CAST(NULL AS CHAR) AS kind_detail,
                             to_addrs, cc_addrs, subject, body_text, body_html,
                             attempt_count, max_attempts, last_error, sent_at, next_attempt_at
                      FROM system_alert_outbox
                      WHERE id = ?`,

    detailReportById: `SELECT id, report_id AS ref_id, kind AS kind_detail,
                              to_addrs, cc_addrs, subject, body_text, body_html,
                              attempt_count, max_attempts, last_error, sent_at, next_attempt_at, created_at
                       FROM report_email_outbox
                       WHERE id = ?`,

    // 单 chunk DELETE for system_alert_outbox. 1 占位: days. limit 5000 hardcoded.
    purgeAlertOlderThan: (days) => `
      DELETE FROM system_alert_outbox
      WHERE sent_at IS NOT NULL
        AND sent_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY)
      LIMIT 5000`,

    // 单 chunk DELETE for report_email_outbox. 1 占位: days.
    purgeReportOlderThan: (days) => `
      DELETE FROM report_email_outbox
      WHERE sent_at IS NOT NULL
        AND sent_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY)
      LIMIT 5000`,
  },

  mssql: {
    // MSSQL 跨 union 排序, 用 CTE + TOP. 3 占位: @p1=days (alert 窗) /
    // @p2=days (report 窗) / @p3=limit. sp_executesql 接受 @p1..@p3 顺.
    //
    // CTE 选择: 把每个 subquery 限制 500 行 (UI cap 500 总, 单边 500 安全),
    // 再在最外层做 TOP N + UNION ALL. 避免大表物理出现 → DISTINCT 排序前成本.
    listSent: (days, limit) => `
      ;WITH a AS (
        SELECT TOP (500)
          'alert' AS source, alert_id AS ref_id, CAST(NULL AS nvarchar(16)) AS kind_detail,
          to_addrs, cc_addrs, subject, attempt_count, max_attempts,
          last_error, sent_at, next_attempt_at, id
        FROM system_alert_outbox
        WHERE sent_at IS NOT NULL
          AND sent_at >= DATEADD(DAY, -?, SYSUTCDATETIME())
        ORDER BY sent_at DESC, id DESC
      ), r AS (
        SELECT TOP (500)
          'report' AS source, report_id AS ref_id, kind AS kind_detail,
          to_addrs, cc_addrs, subject, attempt_count, max_attempts,
          last_error, sent_at, next_attempt_at, id
        FROM report_email_outbox
        WHERE sent_at IS NOT NULL
          AND sent_at >= DATEADD(DAY, -?, SYSUTCDATETIME())
        ORDER BY sent_at DESC, id DESC
      )
      SELECT TOP (?) * FROM (
        SELECT * FROM a
        UNION ALL
        SELECT * FROM r
      ) u
      ORDER BY sent_at DESC, u.id DESC`,

    // R158.100.A (2026-10-14) — 单行详情 helper. 跟 mysql 同 precedent.
    //   alert 表无 created_at, report 表有, 不对称.
    //   [id] 单参. mssql `?` 占位 driver wrapper 改写为 @p1.
    detailAlertById: `SELECT id, alert_id AS ref_id, CAST(NULL AS nvarchar(16)) AS kind_detail,
                             to_addrs, cc_addrs, subject, body_text, body_html,
                             attempt_count, max_attempts, last_error, sent_at, next_attempt_at
                      FROM system_alert_outbox
                      WHERE id = ?`,

    detailReportById: `SELECT id, report_id AS ref_id, kind AS kind_detail,
                              to_addrs, cc_addrs, subject, body_text, body_html,
                              attempt_count, max_attempts, last_error, sent_at, next_attempt_at, created_at
                       FROM report_email_outbox
                       WHERE id = ?`,

    // MSSQL DELETE TOP(N) — 同 createReportRetentionLoop 范式 (sql/reports.js
    // reportRun.deleteOlderThan). 1 占位: days.
    purgeAlertOlderThan: (days) => `
      DELETE TOP (5000) FROM system_alert_outbox
      WHERE sent_at IS NOT NULL
        AND sent_at < DATEADD(DAY, -?, SYSUTCDATETIME())`,

    purgeReportOlderThan: (days) => `
      DELETE TOP (5000) FROM report_email_outbox
      WHERE sent_at IS NOT NULL
        AND sent_at < DATEADD(DAY, -?, SYSUTCDATETIME())`,
  },
};