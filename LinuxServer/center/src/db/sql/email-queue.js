// SQL helpers for the email-queue endpoint (R158.100.B).
//
// 跟 email-history.js (R158.69) 1:1 平行, 但只查 sent_at IS NULL (未发出
// 的行) — 操作员 "邮件队列" tab 用. UNION ALL 跨 system_alert_outbox +
// report_email_outbox, 跟 history precedent 一样不建新表.
//
// 行内 3 操作 (前端 list 出来):
//   - 待发送 (att<5): 下次 deliver tick 重试, 操作员可 [重发] 强制
//     next_attempt_at=now 立即触发 (不重置 attempt_count, 保留 att 涨
//     信号 = 操作员看这行历史重试过几次)
//   - 已失败 (att>=5): R158.100-fix listPending 跳过, 永远不会再发,
//     操作员可 [放弃] 硬删 (双层防御 markExhausted 已就位, 删后不复活)

export const emailQueue = {
  mysql: {
    // UNION ALL 跨 2 表 (跟 email-history.listSent 同 precedent, shape 平行).
    // 列对齐: source/ref_id/kind_detail/to/cc/subject/att/max/last_error/
    //         next_attempt_at/id.
    // WHERE: sent_at IS NULL (跟 history listSent 反, history 是已发出).
    // ORDER BY: next_attempt_at ASC, id ASC (跟 listPending 1:1, 老行排前).
    // LIMIT: UI cap 500 (跟 history listSent 一致).
    listQueue: (limit) => `
      SELECT * FROM (
        SELECT 'alert' AS source, alert_id AS ref_id, CAST(NULL AS CHAR) AS kind_detail,
               to_addrs, cc_addrs, subject, attempt_count, max_attempts,
               last_error, next_attempt_at, id
        FROM system_alert_outbox
        WHERE sent_at IS NULL
        UNION ALL
        SELECT 'report' AS source, report_id AS ref_id, kind AS kind_detail,
               to_addrs, cc_addrs, subject, attempt_count, max_attempts,
               last_error, next_attempt_at, id
        FROM report_email_outbox
        WHERE sent_at IS NULL
      ) u
      ORDER BY next_attempt_at ASC, id ASC
      LIMIT ${Number(limit) || 500}`,

    // R158.100.B (2026-10-14) — retry 单行 alert.
    //   [id] 单参.
    //   SET next_attempt_at=now, 不动 attempt_count, 不重置 last_error.
    //   AND sent_at IS NULL 防御: 已发出行 retry 返回 0 影响 (前端视为 404).
    retryAlert: `UPDATE system_alert_outbox SET next_attempt_at = UTC_TIMESTAMP(3)
                 WHERE id = ? AND sent_at IS NULL`,

    // R158.100.B (2026-10-14) — retry 单行 report. 同 retryAlert shape.
    retryReport: `UPDATE report_email_outbox SET next_attempt_at = UTC_TIMESTAMP(3)
                  WHERE id = ? AND sent_at IS NULL`,

    // R158.100.B (2026-10-14) — delete (放弃) 单行 alert.
    //   [id] 单参. 硬删. R158.100-fix markExhausted 双层防御已就位, 删后行 0 复活.
    //   AND sent_at IS NULL 防御: 已发出行不误删 (前端 404).
    deleteAlert: `DELETE FROM system_alert_outbox
                  WHERE id = ? AND sent_at IS NULL`,

    // R158.100.B (2026-10-14) — delete (放弃) 单行 report. 同 deleteAlert shape.
    deleteReport: `DELETE FROM report_email_outbox
                   WHERE id = ? AND sent_at IS NULL`,
  },

  mssql: {
    // mssql UNION ALL + TOP 范式 (跟 email-history.listSent 同 precedent).
    //   CTE 各 TOP(500) subquery, 外层 SELECT TOP(@limit) ORDER BY.
    //   0 占位 (limit 走 ${Number(limit) || 500} 模板插入, 跟 listPending mssql 同).
    listQueue: (limit) => `
      ;WITH a AS (
        SELECT TOP (500)
          'alert' AS source, alert_id AS ref_id, CAST(NULL AS nvarchar(16)) AS kind_detail,
          to_addrs, cc_addrs, subject, attempt_count, max_attempts,
          last_error, next_attempt_at, id
        FROM system_alert_outbox
        WHERE sent_at IS NULL
        ORDER BY next_attempt_at ASC, id ASC
      ), r AS (
        SELECT TOP (500)
          'report' AS source, report_id AS ref_id, kind AS kind_detail,
          to_addrs, cc_addrs, subject, attempt_count, max_attempts,
          last_error, next_attempt_at, id
        FROM report_email_outbox
        WHERE sent_at IS NULL
        ORDER BY next_attempt_at ASC, id ASC
      )
      SELECT TOP (${Number(limit) || 500}) * FROM (
        SELECT * FROM a
        UNION ALL
        SELECT * FROM r
      ) u
      ORDER BY next_attempt_at ASC, u.id ASC`,

    // mssql retry. [id] 单参. 跟 mysql 同语义.
    retryAlert: `UPDATE system_alert_outbox SET next_attempt_at = SYSUTCDATETIME()
                 WHERE id = ? AND sent_at IS NULL`,

    retryReport: `UPDATE report_email_outbox SET next_attempt_at = SYSUTCDATETIME()
                  WHERE id = ? AND sent_at IS NULL`,

    // mssql delete. 硬删. [id] 单参.
    deleteAlert: `DELETE FROM system_alert_outbox
                  WHERE id = ? AND sent_at IS NULL`,

    deleteReport: `DELETE FROM report_email_outbox
                   WHERE id = ? AND sent_at IS NULL`,
  },
};
