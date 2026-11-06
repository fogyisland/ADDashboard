// Replication UPSERT service. Reads SQL from db.sql registry and executes
// via db facade, so the same code works against MySQL or SQL Server.

import { getDb } from '../db/index.js';
import { toMysqlDatetime } from '../utils/datetime.js';
// R161.10.2 (2026-10-26) — 行数上限的唯一整数闸门 (见 utils/limit.js)。
import { clampRowLimit } from '../utils/limit.js';

// Coerce a value to either null or string. The tedious MSSQL driver validates
// parameters at the protocol layer (tedious/lib/data-types/nvarchar.js:121-128):
// null/undefined pass; anything else must be typeof 'string', else throws
// "Invalid string." (production hit this on KDLWXOFADSRV1 reports — see
// debuglog/ADDashboardCenter-stderr.log — every report was rejected because
// p5/p6 received a non-null non-string value).
//
// Why does this happen? The route layer (`routes/agent.js:206`) calls
// upsertStatus with `data.map(row => ({...row, agentId, collectedAt}))`
// straight from the agent's JSON payload. When collect-replication.ps1's
// $Site lookup fails (KDLWXOFADSRV1 hit: AD module loaded but site query
// errored), `$snapshot.Site` defaults to $null and `ConvertTo-Json` emits
// `"SourceSite": null`. That round-trips to JS null correctly. BUT if any
// non-string non-null sneaks through (PowerShell emitting an empty PSCustomObject,
// a JSON number 0, etc.), `?? null` lets it through. Defensive String coercion
// at the boundary catches the leak before the driver rejects it.
function asNullableString(v) {
  if (v == null) return null;
  return typeof v === 'string' ? v : String(v);
}

function rowParams(row) {
  // R110.A — counter columns (users_count, groups_count, gpos_count,
  // locked_count) moved off ad_replication_status. Users / groups / gpos
  // now live in the public ad_dc_overview table (ad_dc_overview v2
  // package, manifest omits database block — see R110.A architectural
  // pivot). LockedCount is sourced from the ad_lockout_summary v2
  // metricstore at the route layer (R110.B). The __dc_summary__ self-loop
  // is gone too — collect-replication.ps1 no longer emits it.
  //
  // 2026-08-28 round-46: restore partnerPortStatus binding (R46 = 复制日志监控
  // inbound + 端口健康). Real agent + mock emit partner-port probe results
  // as JSON string on __partner_ports__:% rows; partnerPortStatusJson is
  // bound at position 12 (NULL for non-partner-port rows). This unblocks
  // /replication-log/all port health surface.
  const isPartnerPort = typeof row.namingContext === 'string'
    && row.namingContext.startsWith('__partner_ports__:');
  const partnerPortStatusJson = isPartnerPort && row.partnerPortStatus != null
    ? (typeof row.partnerPortStatus === 'string'
       ? row.partnerPortStatus
       : JSON.stringify(row.partnerPortStatus))
    : null;
  return [
    toMysqlDatetime(row.collectedAt),
    row.agentId,
    row.sourceDc,
    row.destDc,
    asNullableString(row.sourceSite ?? null),
    asNullableString(row.destSite ?? null),
    row.namingContext,
    toMysqlDatetime(row.lastSuccessTime),
    toMysqlDatetime(row.lastAttemptTime),
    row.statusCode,
    row.errorMessage ?? null,
    partnerPortStatusJson
  ];
}

function historyParams(row) {
  // 2026-08-27 round-42 (复制日志监控): history table now carries
  // last_attempt_time, attempt_duration_ms, objects_transferred. Agents
  // that pre-date round-42 will send null/undefined for these — coerce
  // to null so the INSERT shape stays consistent. Real agents populate
  // them from Get-ADReplicationPartnerMetadata._ResultHistory (see
  // agent/scripts/collect-replication.ps1::BuildReplicationHistoryRows).
  //
  // Mock agents emit history rows with a synthetic `__history__:<hash>`
  // naming_context so the route can fork them off into the history-only
  // ingestion path. Strip the prefix here so the stored naming_context
  // matches the link's NC — that's what the dashboard's
  // historyByPair lookup joins on (see routes/dashboard.js replication-log
  // endpoint). Real agents (round-42 follow-up) emit the link's real NC
  // directly; the prefix-strip is a no-op for them.
  let namingContext = row.namingContext;
  if (typeof namingContext === 'string' && namingContext.startsWith('__history__:')) {
    // The mock encodes a hash after the prefix; the real NC is in the
    // sourceDc/destDc context but isn't recoverable from the hash alone.
    // Mock callers must therefore also pass `_realNamingContext` on the
    // row (see mock-snapshot.mjs buildReplicationHistoryEntries for the
    // exact convention).
    namingContext = row._realNamingContext ?? null;
  }
  return [
    toMysqlDatetime(row.collectedAt),
    row.agentId,
    row.sourceDc,
    row.destDc,
    namingContext,
    toMysqlDatetime(row.lastSuccessTime),
    toMysqlDatetime(row.lastAttemptTime ?? row.lastSuccessTime),
    row.attemptDurationMs ?? null,
    row.objectsTransferred ?? null,
    row.statusCode,
    row.errorMessage ?? null
  ];
}

export async function upsertStatus(rows, { appendHistory = false, logger = null } = {}) {
  const db = getDb();
  const errors = [];
  for (const row of rows) {
    // R158.52 — reject rows missing sourceDc/destDc/agentId. MySQL
    // NOT NULL columns throw "Column 'X' cannot be null" on bind and
    // cascade-abort the rest of the envelope. Push to errors so the
    // caller can surface them, mirroring lockout.js / eventlog.js /
    // dc-overview.js reject patterns.
    if (!row.sourceDc || !row.destDc || !row.agentId) {
      errors.push({
        sourceDc: row.sourceDc ?? null,
        destDc: row.destDc ?? null,
        agentId: row.agentId ?? null,
        error: 'missing required field (sourceDc/destDc/agentId)'
      });
      continue;
    }
    try {
      await db.execute(db.sql.replication.upsertStatus, rowParams(row));
      // R158.X.99.29.b (2026-10-19) — 操作员 directive 双锁: status=0
      // 成功时 DELETE ad_replication_active_errors 同三元组 (auto-remove),
      // status>0 失败时 UPSERT 走新表.
      //
      // R158.X.116.p (2026-10-23) — 真因修复. 原判定 `sc === 1 || sc === 2`
      // 与 ad_replication_status.status_code 的实际值域不符: 该列既有包
      // (ad_replication_status_probe collect.ps1:173-178, partner-port-probe.js
      // deriveStatus:100-107) 产出的 0/1/2 枚举, 也有历史写入方留下的
      // Windows 错误码 (实测库内 1398=命名空间绑定失败 / 1722=RPC 服务器
      // 不可用). 枚举判定导致 Windows 错误码整条走不进分支,
      // ad_replication_active_errors 恒 0 行 → /admin/replication-errors
      // 恒显示「无错误」, 与 /errors 口径分裂.
      // 改为 `sc > 0` — 与老端点 sql.dashboard.errors 的
      // `status_code <> 0 AND status_code > 0` 收敛单源 (lesson 158/159).
      // -1 (META 哨兵行) 走 else 分支不处理, 不进新表.
      const sc = Number(row.statusCode);
      if (sc === 0) {
        // 成功 → 整条 pair 真从新表消失 (操作员 "恢复后必 auto-remove" 锁)
        try {
          await db.execute(db.sql.replication.removeActiveError, [
            row.sourceDc, row.destDc, row.namingContext ?? ''
          ]);
        } catch (e) {
          // 静默吞异常是本 bug 潜伏 4 天没被发现的原因 (R158.X.99.29.b
          // 起就是 /* best-effort */), 补 warn 让下次同类问题能查。
          logger?.warn?.({ err: e?.message, sourceDc: row.sourceDc, destDc: row.destDc },
            'replication removeActiveError failed (auto-remove skipped)');
        }
      } else if (sc > 0) {
        // 失败 → UPSERT 进新表. 复用 rowParams 已有字段, first_seen_at
        // 用 lastAttemptTime 兜底 (新行 init = lastAttemptTime, 老行保留
        // 既有 first_seen_at). 走 8 列 bind (reportedCount init=1 走 SQL 内嵌).
        try {
          // R161.5 (2026-10-26) — 三个时间戳落 ad_replication_active_errors 的
          //   last_attempt_time / first_seen_at / last_reported_at (DATETIME)。
          //   MySQL 5.7 拒 ISO ⇒ ER 1292 ⇒ 整条 active-error 行写不进去 ⇒
          //   /admin/replication-errors 恒空 (catch 只 warn, 静默)。
          //   本文件既有惯例 = 无条件 toMysqlDatetime (见 rowParams/historyParams),
          //   mssql 段用 CAST(? AS DATETIME2) 两种格式都吃 ⇒ 保持一致。
          const lastAttempt = toMysqlDatetime(row.lastAttemptTime ?? null);
          await db.execute(db.sql.replication.upsertActiveError, [
            row.sourceDc, row.destDc, row.namingContext ?? '',
            row.statusCode, lastAttempt,
            lastAttempt, lastAttempt,
            row.errorMessage ?? null
          ]);
        } catch (e) {
          logger?.warn?.({ err: e?.message, sourceDc: row.sourceDc, destDc: row.destDc,
            namingContext: row.namingContext, statusCode: row.statusCode },
            'replication upsertActiveError failed (active-error row NOT recorded)');
        }
      }
    } catch (e) {
      errors.push({ sourceDc: row.sourceDc, destDc: row.destDc, error: e?.message || String(e) });
      continue;
    }
    if (appendHistory) {
      try {
        await db.execute(db.sql.replication.upsertHistory, historyParams(row));
      } catch (e) {
        errors.push({ sourceDc: row.sourceDc, destDc: row.destDc, phase: 'history', error: e?.message || String(e) });
      }
    }
  }
  if (errors.length > 0) {
    return { upserted: rows.length - errors.length, errors };
  }
  return rows.length;
}

// 2026-08-27 round-42 (复制日志监控): history-only ingestion path. Mock
// + real agents that emit per-attempt history rows with a synthetic
// `__history__:%` naming_context can land them straight in
// `ad_replication_history` without polluting `ad_replication_status` (a
// back-dated history row in ad_replication_status would overwrite the
// link's latest-per-pair row and silently break the matrix view).
//
// history_entries must carry: sourceDc, destDc, namingContext (the
// synthetic __history__ key), lastAttemptTime, statusCode, errorMessage,
// and optionally attemptDurationMs/objectsTransferred/lastSuccessTime.
// See historyParams() for the exact bind shape.
export async function insertHistoryEntries(historyEntries) {
  if (!Array.isArray(historyEntries) || historyEntries.length === 0) return 0;
  const db = getDb();
  for (const row of historyEntries) {
    await db.execute(db.sql.replication.upsertHistory, historyParams(row));
  }
  return historyEntries.length;
}

// 2026-09-25 R93.4 — MSSQL TOP does not accept parameter binding; the
// service layer dispatches the function-form builder on MSSQL (the
// integer limit is interpolated by the SQL builder) and the plain
// string on MySQL (where mysql2 accepts the `LIMIT ?` binding).
//
// ★ R161.10.2 (2026-10-26) — 两条分支现在共用**同一个**整数闸门。
//   改之前: mssql 分支 `Number(limit)` (不截断 ⇒ 12.7 会内联出 `TOP 12.7`
//   = 语法错误), mysql 分支直接绑**原值** (字符串 / 浮点 ⇒ mysql2 预处理协议
//   拒执行 ⇒ "Incorrect arguments to mysqld_stmt_execute" ⇒ 端点 500)。
//   改之后: clampRowLimit() 一次性把值变成 1..1000 的正整数, 两边行为一致。
//   ★ 这两个函数当前**没有调用点** (全树 grep 过) —— 但它们是"复活即炸"的
//     同族地雷 (helper 从未被调用 ≠ helper 是对的), 所以就地修好。
export async function listRecent(limit = 100) {
  const db = getDb();
  const safeLimit = clampRowLimit(limit);
  const sql = db.dialect === 'mssql'
    ? db.sql.replication.listRecent(safeLimit)
    : db.sql.replication.listRecent;
  const params = db.dialect === 'mssql' ? [] : [safeLimit];
  const { rows } = await db.query(sql, params);
  return rows;
}

export async function listBySite(site, limit = 100) {
  const db = getDb();
  const safeLimit = clampRowLimit(limit);
  const sql = db.dialect === 'mssql'
    ? db.sql.replication.listBySite(safeLimit)
    : db.sql.replication.listBySite;
  const params = db.dialect === 'mssql' ? [site, site] : [site, site, safeLimit];
  const { rows } = await db.query(sql, params);
  return rows;
}