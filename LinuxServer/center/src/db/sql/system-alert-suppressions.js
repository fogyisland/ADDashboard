// center/src/db/sql/system-alert-suppressions.js
// R158.Suppression (2026-10-15) — 系统告警抑制表 SQL helper.
//   跟 src/db/sql/system-alerts.js 1:1 平行: 单表, 4 helper × 2 dialect.
//
//   抑制语义 (R158.Suppression 设计):
//     - (kind, scope_ref) 二元组作为主键 (UNIQUE INDEX uq_sas_kind_scope)
//     - expires_at NULL = 操作员手动恢复前永久抑制
//     - expires_at 非空 = 自动到期 (UI 端暂未启用, 留接口)
//     - kind 为 'replication_failed' / 'heartbeat_offline' / 任意 5 detector kind
//
//   跟 R158.100-suppression 跟历史 14 ship 0 触碰: 0 改 system_alerts / 0 改 4 个其他
//   detector / 0 改 email.js / 0 改 outbox 表.
export const systemAlertSuppressions = {
  mysql: {
    // upsert: 同 (kind, scope_ref) 已存在 → 更新 reason + set_by + expires_at; 操作员多次 PUT
    //   覆盖 (最后一次 reason/set_by 生效). 新插入时 set_at = UTC_TIMESTAMP(3) (DEFAULT).
    //   expires_at 永远 NULL (永久) — UI 端这一轮不传 expires_at.
    upsert: `INSERT INTO system_alert_suppressions (kind, scope_ref, reason, set_by, expires_at)
             VALUES (?, ?, ?, ?, NULL)
             ON DUPLICATE KEY UPDATE reason = VALUES(reason),
                                     set_by = VALUES(set_by),
                                     expires_at = NULL,
                                     set_at = UTC_TIMESTAMP(3)`,

    // isSuppressed: detector 在 maybeFire 之前 SELECT 命中 → continue (跳过 INSERT+邮件).
    //   expires_at NULL 永远命中; expires_at > now 命中; 过期即视为未抑制 (自动恢复).
    isSuppressed: `SELECT id, expires_at FROM system_alert_suppressions
                   WHERE kind = ? AND scope_ref = ?
                     AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP(3))
                   LIMIT 1`,

    // remove: 操作员点 "恢复告警" 调用. 0 行也算成功 (幂等).
    remove: `DELETE FROM system_alert_suppressions WHERE kind = ? AND scope_ref = ?`,

    // listActive: GET /suppressions 给 UI 列已暂停清单.
    //   0-arg repr: kind 是必填 query param, 这一轮 UI 端只传 'replication_failed'.
    listActiveByKind: ({ kind, limit = 500 } = {}) => {
      const lim = Math.min(500, Math.max(1, Number(limit) || 500));
      let sql = `SELECT id, kind, scope_ref, reason, set_by, set_at, expires_at
                 FROM system_alert_suppressions
                 WHERE expires_at IS NULL OR expires_at > UTC_TIMESTAMP(3)`;
      if (kind) sql += ` AND kind = ?`;
      sql += ` ORDER BY set_at DESC, id DESC LIMIT ${lim}`;
      return sql;
    }
  },
  mssql: {
    // mssql 用 MERGE 实现 upsert (单原子 statement, 无事务): WHEN MATCHED → 更新; WHEN NOT
    //   MATCHED → INSERT. 同效果, 跟 UNIQUE INDEX uq_sas_kind_scope 1:1 平行.
    //   注意 expires_at 用 NULL (永久); 操作员多次 PUT 走 MERGE 不会触发 set_at DEFAULT,
    //   所以显式把 set_at 更新 = SYSUTCDATETIME().
    upsert: `MERGE INTO system_alert_suppressions AS tgt
             USING (SELECT ? AS kind, ? AS scope_ref, ? AS reason, ? AS set_by) AS src
               ON tgt.kind = src.kind AND tgt.scope_ref = src.scope_ref
             WHEN MATCHED THEN
               UPDATE SET tgt.reason = src.reason,
                          tgt.set_by = src.set_by,
                          tgt.expires_at = NULL,
                          tgt.set_at = SYSUTCDATETIME()
             WHEN NOT MATCHED THEN
               INSERT (kind, scope_ref, reason, set_by, set_at, expires_at)
               VALUES (src.kind, src.scope_ref, src.reason, src.set_by, SYSUTCDATETIME(), NULL);`,

    // 同 mysql 版: 是 SUPPRESSED 时返 1 行; 否则返 0 行 (TOP 1 已限).
    isSuppressed: `SELECT TOP 1 id, expires_at FROM system_alert_suppressions
                   WHERE kind = ? AND scope_ref = ?
                     AND (expires_at IS NULL OR expires_at > SYSUTCDATETIME())`,

    remove: `DELETE FROM system_alert_suppressions WHERE kind = ? AND scope_ref = ?`,

    listActiveByKind: ({ kind, limit = 500 } = {}) => {
      const lim = Math.min(500, Math.max(1, Number(limit) || 500));
      let sql = `SELECT TOP ${lim} id, kind, scope_ref, reason, set_by, set_at, expires_at
                 FROM system_alert_suppressions
                 WHERE expires_at IS NULL OR expires_at > SYSUTCDATETIME()`;
      if (kind) sql += ` AND kind = ?`;
      sql += ` ORDER BY set_at DESC, id DESC`;
      return sql;
    }
  }
};
