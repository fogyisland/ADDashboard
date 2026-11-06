// R158.56.1 (2026-10-08) — backfill audit_logs lifecycle row payload.taskId.
// History: sql.js adAdminCommands.getById 没 SELECT c.task_id →
// completeCommand 返回 row.task_id=undefined → agent.js /api/agent/ad-commands/
// :id/result writeAudit 的 payload.taskId 走 `row.task_id ?? null` 永远 null.
// ad_command_claimed 那行 taskId 有值 (claim 用 loadByIds, 含 task_id).
// R158.56 SQL fix 让新写入正常. 但历史 audit row 已 immutable, payload.taskId
// 仍 null. operator 在 /admin/ad-management-log 顶部 lifecycle panel 看到
// ad_command_failed 行 taskId 空白 (claim 那行 taskId 有), "任务 #4 (历史)"
// commandId 还能查到, 但 task_id 字段悬空.
//
// Backfill 思路:
//   - ad_command_failed / ad_command_succeeded / ad_command_timeout
//     lifecycle row 用 `target = 'cmd:${id}'` 模式. id 部分可以从 target
//     解析. payload.commandId 也存了, 更直接.
//   - JOIN ad_admin_commands c WHERE c.id = JSON_VALUE(a.payload,'$.commandId')
//     + c.task_id IS NOT NULL → UPDATE a.payload JSON.
//
// 跨 dialect 一致 (JSON_VALUE / JSON_EXTRACT 通用语法, MSSQL JSON_VALUE
// 可用, MySQL JSON_EXTRACT). service 层用 db.execute 走 tx 防 TOCTOU
// (跟 R158.46.4 同 pattern).

import { getDb } from '../db/index.js';

export async function backfillAuditTaskId({ logger = null } = {}) {
  const db = getDb();
  if (!db) {
    logger?.warn?.({ component: 'ad-admin-audit-taskid-backfill' }, 'no db handle; skip');
    return { updated: 0 };
  }
  const isMssql = db.dialect === 'mssql';

  const updateSql = isMssql
    ? `UPDATE a
         SET a.payload = JSON_MODIFY(a.payload, '$.taskId', c.task_id)
        FROM audit_logs a
        INNER JOIN ad_admin_commands c
          ON JSON_VALUE(a.payload, '$.commandId') = c.id
       WHERE a.action IN ('ad_command_succeeded','ad_command_failed','ad_command_timeout')
         AND JSON_VALUE(a.payload, '$.taskId') IS NULL
         AND c.task_id IS NOT NULL`
    : `UPDATE audit_logs a
        INNER JOIN ad_admin_commands c
          ON JSON_EXTRACT(a.payload, '$.commandId') = c.id
          SET a.payload = JSON_SET(a.payload, '$.taskId', c.task_id)
       WHERE a.action IN ('ad_command_succeeded','ad_command_failed','ad_command_timeout')
         AND JSON_EXTRACT(a.payload, '$.taskId') IS NULL
         AND c.task_id IS NOT NULL`;

  try {
    const r = await db.execute(updateSql, []);
    const updated = Number(r.affectedRows ?? r.rowsAffected ?? 0);
    logger?.info?.({ component: 'ad-admin-audit-taskid-backfill', updated }, 'R158.56.1 audit taskId backfill done');
    return { updated };
  } catch (e) {
    logger?.warn?.({ component: 'ad-admin-audit-taskid-backfill', err: e?.message }, 'audit taskId backfill failed; non-fatal');
    return { updated: 0, error: e?.message };
  }
}
