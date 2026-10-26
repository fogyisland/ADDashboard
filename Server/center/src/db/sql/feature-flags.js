// center/src/db/sql/feature-flags.js
// R158.87 (2026-10-12) — ad_feature_flags 公共表 SQL helper.
// 跟 R158.86.5.2 lesson: UPSERT description 字段必须 COALESCE(?, existing),
// 防止 admin 配的 description 被 toggle 抹掉. mysql ON DUPLICATE KEY UPDATE
// + mssql MERGE 同形.
//
// 3 helper × 2 dialect (listAll / upsertValue / getByKey). 用 `?` 占位符,
// mssql driver wrapper 在 execute() 时把 `?` rewrite 成 @p1, @p2 ...

export const featureFlags = {
  mysql: {
    listAll: `SELECT \`key\`, value, description, updated_at, updated_by FROM ad_feature_flags ORDER BY \`key\``,
    upsertValue: `INSERT INTO ad_feature_flags (\`key\`, value, description, updated_by) VALUES (?, ?, ?, ?)
                  ON DUPLICATE KEY UPDATE
                    value = VALUES(value),
                    description = COALESCE(VALUES(description), description),
                    updated_at = CURRENT_TIMESTAMP(3),
                    updated_by = COALESCE(VALUES(updated_by), updated_by)`,
    getByKey: `SELECT \`key\`, value FROM ad_feature_flags WHERE \`key\` = ?`
  },
  mssql: {
    listAll: `SELECT [key], value, description, updated_at, updated_by FROM ad_feature_flags ORDER BY [key]`,
    // R158.86.5.2 lesson: COALESCE(s.description, t.description) preserve.
    // description 是 admin 配的元数据, toggle 不应覆盖.
    upsertValue: `MERGE INTO ad_feature_flags AS t
                  USING (SELECT CAST(? AS VARCHAR(64)) AS [key],
                                ? AS value,
                                CAST(? AS VARCHAR(255)) AS description,
                                CAST(? AS VARCHAR(64)) AS updated_by) AS s
                  ON t.[key] = s.[key]
                  WHEN MATCHED THEN UPDATE SET
                    value = s.value,
                    description = COALESCE(s.description, t.description),
                    updated_at = SYSUTCDATETIME(),
                    updated_by = COALESCE(s.updated_by, t.updated_by)
                  WHEN NOT MATCHED THEN INSERT ([key], value, description, updated_by)
                  VALUES (s.[key], s.value, s.description, s.updated_by);`,
    getByKey: `SELECT [key], value FROM ad_feature_flags WHERE [key] = CAST(? AS VARCHAR(64))`
  }
};
