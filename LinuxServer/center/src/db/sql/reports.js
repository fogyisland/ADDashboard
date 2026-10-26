// SQL helpers for daily_reports / report_subscriptions / report metadata
// (R158.61, 2026-10-10). All queries are dual-dialect — mssql is the
// production dialect, mysql is dead-code (R158.42) but kept for legacy
// parity.
//
// Tables (see db/migrations/mssql/1.0.3-baseline.sql):
//   daily_reports:  id, kind, period_start, period_end, generated_at, to_addrs,
//                   cc_addrs, subject, body_text, body_html, outbox_id, status,
//                   last_error, html_size
//   report_subscriptions: id, kind, to_addrs, cc_addrs, enabled, created_at,
//                   created_by
//   alert_email_outbox: added `kind` column (default 'alert'). report
//                   service passes 'report'.
//
// Parameter shape: '?' only (mssql driver wrapper rewrites to @p1,@p2).
// All timestamps in UTC, mssql uses SYSUTCDATETIME() / mysql uses
// UTC_TIMESTAMP() (consistent with alert-outbox.js / config.js patterns).
//
// IMPORTANT (R158.32/R158.5 lesson): every query helper here is
// `{ mysql, mssql }` shaped — caller MUST do
//   dict.<name>[db.dialect](arg)
// (not dict.<name>(arg) — that fails because dict.<name> is an object).
// Same shape as forest-registry.js / alert-outbox.js.

const insertMysql = `INSERT INTO daily_reports
  (kind, period_start, period_end, to_addrs, cc_addrs, subject, body_text, body_html)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const insertMssql = `INSERT INTO daily_reports
  (kind, period_start, period_end, to_addrs, cc_addrs, subject, body_text, body_html)
  VALUES (CAST(? AS VARCHAR(16)), ?, ?, CAST(? AS VARCHAR(1024)), CAST(? AS VARCHAR(1024)),
          CAST(? AS VARCHAR(256)), ?, ?)`;

const finishMysql = `UPDATE daily_reports
                     SET outbox_id = ?, status = ?, last_error = ?, html_size = ?
                     WHERE id = ?`;
// mssql outbox_id is BIGINT NULL, status / last_error bounded.
const finishMssql = `UPDATE daily_reports
                     SET outbox_id = CAST(? AS BIGINT), status = CAST(? AS VARCHAR(16)),
                         last_error = ?, html_size = CAST(? AS INT)
                     WHERE id = ?`;

// R158.69 (2026-10-10) — markStatus: services/email.js markSent/markFailed
// 在投递完成 / 失败时回写 daily_reports.status. R158.61 ship 漏了 status
// 回写, 导致 daily_reports 永远 'pending'. html_size 不动 (enqueue 已写),
// outbox_id 不动. 3 参: status, last_error, id.
const markStatusMysql = `UPDATE daily_reports
                         SET status = ?, last_error = ?
                         WHERE id = ?`;
const markStatusMssql = `UPDATE daily_reports
                         SET status = CAST(? AS VARCHAR(16)), last_error = ?
                         WHERE id = ?`;

// listRecent: (limit) => string. mssql uses TOP, mysql uses LIMIT.
const listRecentMysql = (limit) =>
  `SELECT id, kind, period_start, period_end, generated_at, to_addrs, cc_addrs,
          subject, status, last_error, outbox_id, html_size
   FROM daily_reports
   WHERE (? IS NULL OR kind = ?)
   ORDER BY generated_at DESC
   LIMIT ${Number(limit) || 20}`;
const listRecentMssql = (limit) =>
  `SELECT TOP ${Number(limit) || 20} id, kind, period_start, period_end, generated_at, to_addrs, cc_addrs,
          subject, status, last_error, outbox_id, html_size
   FROM daily_reports
   WHERE (? IS NULL OR kind = CAST(? AS VARCHAR(16)))
   ORDER BY generated_at DESC`;

// R158.100.B+3 (2026-10-14) — catch-up dedup helper. 查 daily_reports 在
// [windowStartUtc, windowEndUtc) 窗内同 kind 已有 run 数. n>0 = 已生成
// 至少 1 次, catch-up 应 skip 避免重启放大 1 天 N 次 daily/weekly.
//
// 跟 R158.100-fix outbox 层 dedup 互补 (outbox 抓投递层, 这里抓生成层).
// 跟 R158.87.4 catch-up 路径 1:1 平行 (catch-up 是 5min cadence fire first
// tick immediately, 但 in-memory lastFired map 跨重启失效 → 重启放大).
//
// 3 参: kind, windowStartUtc, windowEndUtc. 半开区间 [start, end) 跟
// report-retention.js deleteOlderThan 一致. generated_at 走 DB default
// SYSUTCDATETIME() / UTC_TIMESTAMP(3) (UTC, 跟 period_start 一致).
const countByKindInWindowMysql = `SELECT COUNT(*) AS n FROM daily_reports WHERE kind = ? AND generated_at >= ? AND generated_at < ?`;
const countByKindInWindowMssql = `SELECT COUNT(*) AS n FROM daily_reports WHERE kind = CAST(? AS VARCHAR(16)) AND generated_at >= ? AND generated_at < ?`;

// deleteOlderThan: chunked DELETE. mssql needs `DELETE TOP (n)`; mysql
// uses LIMIT via a sibling UPDATE-then-DELETE pattern in the service.
// Both flavours cap at 5000 rows per call.
const deleteOlderThanMysql = `DELETE FROM daily_reports
                              WHERE period_end < ?
                              ORDER BY period_end ASC
                              LIMIT 5000`;
const deleteOlderThanMssql = `DELETE TOP (5000) FROM daily_reports
                              WHERE period_end < ?`;

const getByKindMysql = `SELECT TOP 1 id, kind, to_addrs, cc_addrs, enabled, created_at, created_by
                        FROM report_subscriptions
                        WHERE kind = ? AND enabled = 1
                        ORDER BY id ASC`;
const getByKindMssql = `SELECT TOP 1 id, kind, to_addrs, cc_addrs, enabled, created_at, created_by
                        FROM report_subscriptions
                        WHERE kind = CAST(? AS VARCHAR(16)) AND enabled = 1
                        ORDER BY id ASC`;

const listByKindMysql = `SELECT id, kind, to_addrs, cc_addrs, enabled, created_at, created_by
                         FROM report_subscriptions
                         WHERE (? IS NULL OR kind = ?)
                         ORDER BY id ASC`;
const listByKindMssql = `SELECT id, kind, to_addrs, cc_addrs, enabled, created_at, created_by
                         FROM report_subscriptions
                         WHERE (? IS NULL OR kind = CAST(? AS VARCHAR(16)))
                         ORDER BY id ASC`;

const insertSubMysql = `INSERT INTO report_subscriptions (kind, to_addrs, cc_addrs, enabled, created_by)
                        VALUES (?, ?, ?, ?, ?)`;
const insertSubMssql = `INSERT INTO report_subscriptions (kind, to_addrs, cc_addrs, enabled, created_by)
                        VALUES (CAST(? AS VARCHAR(16)), CAST(? AS VARCHAR(1024)),
                                CAST(? AS VARCHAR(1024)), CAST(? AS BIT), CAST(? AS NVARCHAR(64)))`;

const updateSubMysql = `UPDATE report_subscriptions
                         SET to_addrs = ?, cc_addrs = ?, enabled = ?
                         WHERE id = ?`;
const updateSubMssql = `UPDATE report_subscriptions
                         SET to_addrs = CAST(? AS VARCHAR(1024)),
                             cc_addrs = CAST(? AS VARCHAR(1024)),
                             enabled = CAST(? AS BIT)
                         WHERE id = ?`;

const deleteSubMysql = `DELETE FROM report_subscriptions WHERE id = ?`;
const deleteSubMssql = `DELETE FROM report_subscriptions WHERE id = ?`;

export const reportSchedule = {
  getByKind: { mysql: getByKindMysql, mssql: getByKindMssql }
};

export const reportRun = {
  insert: { mysql: insertMysql, mssql: insertMssql },
  finish: { mysql: finishMysql, mssql: finishMssql },
  // R158.69 (2026-10-10) — status-only update (no outbox_id / html_size 触碰)
  markStatus: { mysql: markStatusMysql, mssql: markStatusMssql },
  listRecent: { mysql: listRecentMysql, mssql: listRecentMssql },
  deleteOlderThan: { mysql: deleteOlderThanMysql, mssql: deleteOlderThanMssql },
  // R158.100.B+3 (2026-10-14) — catch-up dedup (3 参: kind, windowStart, windowEnd)
  countByKindInWindow: { mysql: countByKindInWindowMysql, mssql: countByKindInWindowMssql }
};

export const reportSubscription = {
  listByKind: { mysql: listByKindMysql, mssql: listByKindMssql },
  insert: { mysql: insertSubMysql, mssql: insertSubMssql },
  update: { mysql: updateSubMysql, mssql: updateSubMssql },
  delete: { mysql: deleteSubMysql, mssql: deleteSubMssql }
};
