// center/src/db/sql/rollout.js
// R158.88.B (2026-10-13) — ad_agent_upgrade_rollout SQL helper.
//   跟 R158.87 feature-flags.js / system-registration.js precedent 1:1 平行.
//   6 helper × 2 dialect (insert / getById / listActive / listAll /
//   updateStrategy / markCompleted). mssql 用 OUTPUT inserted.id 拿新行
//   (跟 system-registration.js activate 同 precedent).
//   R158.69.3 lesson 3 永远适用: 0 fleet 改. 0 改 R158.48 fleet 端
//   upgrade-delivery.js. R158.86.6 enumerate 5 维度 lesson 1:1 闭合.

export const rollout = {
  mysql: {
    // INSERT — params: [target_version, from_version|null, strategy, canary_ratio|null, status, created_by, notes|null]
    //
    // R161.19 — 原来这里尾部还挂着 `; SELECT LAST_INSERT_ID() AS id;`。
    //   ★ 这是**活代码的 500**: mysql 驱动连的是 multipleStatements:false
    //   (drivers/mysql.js:165) ⇒ 一条 SQL 字符串里出现两条语句 ⇒
    //   ER_PARSE_ERROR (1064) ⇒ POST /api/admin/rollout 与
    //   POST /api/admin/rollout/:id/rollback **必然 500**。
    //   ⇒ 删掉尾部那条 SELECT, 改用驱动**原生** insertId:
    //   mysql.js 的 execute() 在有绑定参数时走 pool.execute() (预处理协议),
    //   OkPacket 自带 insertId = 新行 id ⇒ routes/rollout.js:116 与 :280
    //   都是 `insertedRes?.insertId ?? …` 优先取 insertId ⇒ 契约不变。
    insert: `INSERT INTO ad_agent_upgrade_rollout
              (target_version, from_version, strategy, canary_ratio, status, created_by, notes)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
    // getById — params: [id]
    getById: `SELECT id, target_version, from_version, strategy, canary_ratio, status,
                     created_by, created_at, activated_at, completed_at, aborted_at, notes
              FROM ad_agent_upgrade_rollout WHERE id = ?`,
    // listActive — params: []
    listActive: `SELECT id, target_version, from_version, strategy, canary_ratio, status,
                        created_by, created_at, activated_at, completed_at, aborted_at, notes
                 FROM ad_agent_upgrade_rollout
                 WHERE status IN ('active','paused') AND strategy NOT IN ('completed','aborted')
                 ORDER BY activated_at DESC`,
    // listAll — params: [limit]
    listAll: `SELECT id, target_version, from_version, strategy, canary_ratio, status,
                     created_by, created_at, activated_at, completed_at, aborted_at, notes
              FROM ad_agent_upgrade_rollout
              ORDER BY created_at DESC LIMIT ?`,
    // updateStrategy — params: [id, strategy, status, canary_ratio|null]
    updateStrategy: `UPDATE ad_agent_upgrade_rollout
                     SET strategy = ?, status = ?,
                         canary_ratio = COALESCE(?, canary_ratio)
                     WHERE id = ?`,
    // markCompleted — params: [id]
    markCompleted: `UPDATE ad_agent_upgrade_rollout
                    SET strategy = 'completed', status = 'completed',
                        completed_at = CURRENT_TIMESTAMP(3)
                    WHERE id = ? AND status IN ('active','paused')`,
    // markAborted — params: [id]
    markAborted: `UPDATE ad_agent_upgrade_rollout
                  SET strategy = 'aborted', status = 'aborted',
                      aborted_at = CURRENT_TIMESTAMP(3)
                  WHERE id = ? AND status IN ('active','paused','draft')`
  },
  mssql: {
    // INSERT — params: [target_version, from_version|null, strategy, canary_ratio|null, status, created_by, notes|null]
    // R158.87 system-registration.js activate 拿新行 id 用 OUTPUT inserted.id — 同 precedent.
    insert: `DECLARE @inserted TABLE (id BIGINT);
             INSERT INTO ad_agent_upgrade_rollout
               (target_version, from_version, strategy, canary_ratio, status, created_by, notes)
             OUTPUT inserted.id INTO @inserted
             VALUES (CAST(? AS NVARCHAR(32)), CAST(? AS NVARCHAR(32)), CAST(? AS NVARCHAR(16)),
                     CAST(? AS INT), CAST(? AS NVARCHAR(16)), CAST(? AS NVARCHAR(64)), CAST(? AS NVARCHAR(500)));
             SELECT id FROM @inserted;`,
    // getById — params: [id]
    getById: `SELECT id, target_version, from_version, strategy, canary_ratio, status,
                     created_by, created_at, activated_at, completed_at, aborted_at, notes
              FROM ad_agent_upgrade_rollout WHERE id = ?`,
    // listActive — params: []
    listActive: `SELECT id, target_version, from_version, strategy, canary_ratio, status,
                        created_by, created_at, activated_at, completed_at, aborted_at, notes
                 FROM ad_agent_upgrade_rollout
                 WHERE status IN ('active','paused') AND strategy NOT IN ('completed','aborted')
                 ORDER BY activated_at DESC`,
    // listAll — params: [limit]
    listAll: `SELECT TOP (?) id, target_version, from_version, strategy, canary_ratio, status,
                     created_by, created_at, activated_at, completed_at, aborted_at, notes
              FROM ad_agent_upgrade_rollout
              ORDER BY created_at DESC`,
    // updateStrategy — params: [id, strategy, status, canary_ratio|null]
    updateStrategy: `UPDATE ad_agent_upgrade_rollout
                     SET strategy = CAST(? AS NVARCHAR(16)),
                         status = CAST(? AS NVARCHAR(16)),
                         canary_ratio = COALESCE(CAST(? AS INT), canary_ratio)
                     WHERE id = ?`,
    // markCompleted — params: [id]
    markCompleted: `UPDATE ad_agent_upgrade_rollout
                    SET strategy = CAST('completed' AS NVARCHAR(16)),
                        status = CAST('completed' AS NVARCHAR(16)),
                        completed_at = SYSUTCDATETIME()
                    WHERE id = ? AND status IN ('active','paused')`,
    // markAborted — params: [id]
    markAborted: `UPDATE ad_agent_upgrade_rollout
                  SET strategy = CAST('aborted' AS NVARCHAR(16)),
                      status = CAST('aborted' AS NVARCHAR(16)),
                      aborted_at = SYSUTCDATETIME()
                  WHERE id = ? AND status IN ('active','paused','draft')`
  }
};
