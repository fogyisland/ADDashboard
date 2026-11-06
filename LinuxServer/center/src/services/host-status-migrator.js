// R158.X.115 (2026-10-20) — 主机生命周期状态列的启动时幂等 ALTER。
//
// 背景: 「服务器下线」(退役) 功能需要在 ad_dcs / ad_member_servers 两张目录表
// 上加 decommissioned_at / monitoring_paused_at 两列。
//
// 为什么是 runtime ALTER 而不是改 baseline:
//   R158.51 立了 baseline freeze —— db/migrations/*/1.0.0-baseline.sql 已发布,
//   改它会导致已部署的库与 baseline 描述漂移。所以列变更走运行时幂等 ALTER。
//
// 为什么不是每次启动都跑:
//   必须幂等。这段在每次 normal-mode 启动时执行, 列已存在就跳过。
//   先例: package policy migration 的 ADD COLUMN IF NOT EXISTS —— 同样先查
//   系统目录再 ALTER (sys.columns 守卫), 而不是无脑执行 DDL。
//
// 双方言守卫策略 (刻意不用同一条语句):
//   MSSQL — sys.columns WHERE object_id = OBJECT_ID(?) AND name = ?
//           (先查 sys.columns 再 ALTER, 不依赖 IF NOT EXISTS 语法)
//   MySQL — information_schema.columns WHERE table_schema = DATABASE()
//           AND table_name = ? AND column_name = ?
//           不依赖 ADD COLUMN IF NOT EXISTS: MariaDB 支持而 MySQL 5.7 不支持,
//           用 information_schema 守卫两边都能跑。
//
// 失败语义: 只 warn 不抛 (跟 server.js:564-566 的 startup auto-migration
// 同款 "continuing with current schema")。ALTER 失败不该阻断整个服务启动 ——
// 最坏情况是退役/暂停功能不可用, 但既有监控照常工作。

import { applyDcUpsertGuard } from '../db/sql/host-status.js';

// 需要在两张目录表上加的状态列
const TABLES = ['ad_dcs', 'ad_member_servers'];
const COLUMNS = ['decommissioned_at', 'monitoring_paused_at'];

// MSSQL 用 DATETIME2 (跟 db/migrations/mssql/1.0.0-baseline.sql 里 ad_dcs 的
// discovered_at / when_created 同类型); MySQL 用 DATETIME 配合 UTC_TIMESTAMP(3)
// (跟 ad_member_servers.last_seen_at 同款)。
function columnDdl(dialect, table, col) {
  if (dialect === 'mssql') return `ALTER TABLE ${table} ADD ${col} DATETIME2 NULL`;
  return `ALTER TABLE ${table} ADD COLUMN ${col} DATETIME NULL`;
}

async function columnExists(db, table, col) {
  const sql = db.dialect === 'mssql'
    ? `SELECT 1 AS hit FROM sys.columns WHERE object_id = OBJECT_ID(?) AND name = ?`
    : `SELECT 1 AS hit FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`;
  const { rows } = await db.query(sql, [table, col]);
  return Array.isArray(rows) && rows.length > 0;
}

// 单表探测: 表本身在不在 (两张目录表都是 baseline 表, 正常都在, 但 ALTER
// 前先确认能给出更明确的错误信息而不是让 ALTER 报 "table doesn't exist")。
async function tableExists(db, table) {
  const sql = db.dialect === 'mssql'
    ? `SELECT 1 AS hit FROM sys.tables WHERE name = ?`
    : `SELECT 1 AS hit FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`;
  const { rows } = await db.query(sql, [table]);
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * 幂等 ALTER: 给 ad_dcs / ad_member_servers 加生命周期状态列。
 *
 * @param {object} db     — 已就绪的连接 (db.query / db.execute / db.dialect)
 * @param {object} logger — pino logger
 * @returns {{ applied: number, skipped: number, details: Array }}
 */
export async function applyHostStatusColumns(db, logger) {
  const result = { applied: 0, skipped: 0, details: [] };

  for (const table of TABLES) {
    const hasTable = await tableExists(db, table);
    if (!hasTable) {
      const detail = { table, outcome: 'table_missing' };
      result.skipped += COLUMNS.length;
      result.details.push(detail);
      logger?.warn?.({ table }, 'host-status ALTER skipped: table not found');
      continue;
    }

    for (const col of COLUMNS) {
      try {
        if (await columnExists(db, table, col)) {
          result.skipped += 1;
          result.details.push({ table, col, outcome: 'exists' });
          continue;
        }
        await db.execute(columnDdl(db.dialect, table, col), []);
        result.applied += 1;
        result.details.push({ table, col, outcome: 'added' });
        logger?.info?.({ table, col }, 'host-status ALTER: column added');
      } catch (e) {
        // 单列失败不阻断其它列 —— 部分应用的库也能用 (少一列只是那个字段
        // 读不到 NULL, 语义上等价于"未退役")。
        result.details.push({ table, col, outcome: 'failed', error: e.message });
        logger?.warn?.({ table, col, err: e.message }, 'host-status ALTER failed for column; continuing');
      }
    }
  }

  return result;
}

/**
 * 给 ad_dcs 的 discovery UPSERT 打退役标记保护 (幂等)。
 *
 * 这是 R158.X.115 的**核心安全点**: discovery.upsertDc
 * (src/db/sql.js:780 mysql / :4040-4070 mssql MERGE) 是零保护全量覆盖 ——
 * MATCHED 分支无条件刷 discovered_at。只要 DC 的 agent 还在跑
 * collect-discovery.ps1 POST /api/agent/discover, 退役标记就会被清掉,
 * 退役 DC 完全复活。
 *
 * 这里不手改那两行长 SQL 字面量, 而是用幂等函数追加 self-assign 尾部
 * (理由见 src/db/sql/host-status.js 的 applyDcUpsertGuard 注释)。
 *
 * 调用时机: SQL 注册进 db.sql 之后、任何 discover 请求之前。
 *
 * @returns {{ mysql: boolean, mssql: boolean }} 两侧是否成功打上保护
 */
export function applyDcUpsertGuardToRegistry(sqlRegistry, logger) {
  const out = { mysql: false, mssql: false };
  try {
    const dc = sqlRegistry?.discovery;
    if (!dc || typeof dc.upsertDc !== 'string') {
      logger?.warn?.({}, 'host-status: discovery.upsertDc not found in registry; DC guard NOT applied');
      return out;
    }
    dc.upsertDc = applyDcUpsertGuard(dc.upsertDc, 'mysql');
    out.mysql = dc.upsertDc.includes('decommissioned_at = decommissioned_at');
    logger?.info?.({ guarded: out.mysql }, 'host-status: ad_dcs UPSERT guard applied');
    return out;
  } catch (e) {
    logger?.warn?.({ err: e.message }, 'host-status: failed to apply ad_dcs UPSERT guard');
    return out;
  }
}